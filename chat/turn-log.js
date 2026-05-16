/**
 * Turn broker — decouples a chat turn's lifetime from the HTTP request that
 * started it.
 *
 * Why: the dashboard reaches this server through a Vercel function that is
 * hard-killed at ~300s. Before this module, the turn ran inside that request,
 * so a turn longer than the Vercel ceiling was lost. Now a turn runs to
 * completion server-side regardless of client connection; every event is
 * tagged with a per-chat monotonic `seq` and appended to
 * `$DATA_DIR/chats/<chatId>/events.jsonl`. A disconnected client reconnects
 * with `?since=<seq>` and we replay the gap from the log, then live-tail the
 * still-running turn until its terminal event.
 *
 * Persistence is the source of truth for replay; the in-memory registry only
 * accelerates live fan-out. If the process restarts mid-turn the in-memory
 * turn is gone but the log survives — a resume then replays what was persisted
 * and, finding no terminal event and no live turn, reports an honest
 * "interrupted" error instead of hanging forever.
 */

import fs from "node:fs"
import path from "node:path"

/** chatId -> { seq, turn, status, terminal, subscribers:Set<fn> } */
const live = new Map()

function eventsPath(dataDir, chatId) {
  return path.join(dataDir, "chats", chatId, "events.jsonl")
}

/** Read the last persisted seq for a chat (0 if none). */
function lastPersistedSeq(dataDir, chatId) {
  const p = eventsPath(dataDir, chatId)
  if (!fs.existsSync(p)) return 0
  const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean)
  if (lines.length === 0) return 0
  try {
    return JSON.parse(lines[lines.length - 1]).seq || 0
  } catch {
    return 0
  }
}

/** Persisted records with seq > since, oldest first. */
function readSince(dataDir, chatId, since) {
  const p = eventsPath(dataDir, chatId)
  if (!fs.existsSync(p)) return []
  const out = []
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (rec.seq > since) out.push(rec)
  }
  return out
}

function isTerminal(event) {
  return event.type === "done" || event.type === "error"
}

/**
 * Begin a new turn for a chat. Returns an `emit(event)` sink the runner feeds;
 * every emitted event is sequenced, persisted, and fanned out to subscribers.
 */
function beginTurn(dataDir, chatId) {
  const seqFloor = (() => {
    const existing = live.get(chatId)
    if (existing) return existing.seq
    return lastPersistedSeq(dataDir, chatId)
  })()

  const turn = (live.get(chatId)?.turn || 0) + 1
  const state = {
    seq: seqFloor,
    turn,
    status: "running",
    terminal: null,
    subscribers: new Set(),
  }
  live.set(chatId, state)

  const p = eventsPath(dataDir, chatId)
  fs.mkdirSync(path.dirname(p), { recursive: true })

  const emit = (event) => {
    state.seq += 1
    const rec = { seq: state.seq, turn, ts: Date.now(), event }
    try {
      fs.appendFileSync(p, JSON.stringify(rec) + "\n")
    } catch (err) {
      console.error(`[turn-log] append failed for ${chatId}: ${err.message}`)
    }
    for (const fn of state.subscribers) {
      try {
        fn(rec)
      } catch {
        /* a dead subscriber must not break the turn or other subscribers */
      }
    }
    if (isTerminal(event)) {
      state.status = "ended"
      state.terminal = rec
      const subs = [...state.subscribers]
      state.subscribers.clear()
      for (const fn of subs) {
        try {
          fn(null)
        } catch {
          /* ignore */
        }
      }
    }
  }

  return emit
}

/** Mark a turn ended if the runner threw before emitting a terminal event. */
function endTurnIfUnterminated(dataDir, chatId, errMessage) {
  const state = live.get(chatId)
  if (!state || state.status === "ended") return
  // Synthesize a terminal error so reconnecting clients don't hang.
  const emit = (() => {
    const p = eventsPath(dataDir, chatId)
    return (event) => {
      state.seq += 1
      const rec = { seq: state.seq, turn: state.turn, ts: Date.now(), event }
      try {
        fs.appendFileSync(p, JSON.stringify(rec) + "\n")
      } catch {
        /* best effort */
      }
      state.status = "ended"
      state.terminal = rec
      const subs = [...state.subscribers]
      state.subscribers.clear()
      for (const fn of subs) {
        try {
          fn(rec)
          fn(null)
        } catch {
          /* ignore */
        }
      }
    }
  })()
  emit({ type: "error", error: errMessage || "turn ended unexpectedly" })
}

/**
 * Attach a client. Replays persisted events with seq > since, then:
 *  - if the turn is live: live-tails until the terminal event, then closes;
 *  - if the turn ended: closes after replay;
 *  - if no live turn and the log has no terminal: emits an interrupted error.
 *
 * `onRecord(rec)` is called per event record; `onClose()` once at the end.
 */
function subscribe(dataDir, chatId, since, onRecord, onClose) {
  const backlog = readSince(dataDir, chatId, since)
  for (const rec of backlog) onRecord(rec)

  const lastReplayed = backlog.length ? backlog[backlog.length - 1] : null
  if (lastReplayed && isTerminal(lastReplayed.event)) {
    onClose()
    return () => {}
  }

  const state = live.get(chatId)
  if (state && state.status === "running") {
    const fn = (rec) => {
      if (rec === null) {
        state.subscribers.delete(fn)
        onClose()
        return
      }
      if (rec.seq > since) onRecord(rec)
    }
    state.subscribers.add(fn)
    return () => {
      state.subscribers.delete(fn)
    }
  }

  if (state && state.status === "ended" && state.terminal) {
    if (state.terminal.seq > since && !lastReplayed) onRecord(state.terminal)
    onClose()
    return () => {}
  }

  // No live turn and nothing terminal persisted: the process restarted
  // mid-turn (or the chat never had a turn). Fail honestly.
  if (lastReplayed) {
    onRecord({
      seq: lastReplayed.seq + 1,
      turn: lastReplayed.turn,
      ts: Date.now(),
      event: {
        type: "error",
        error:
          "stream interrupted (server restarted mid-reply) — resend your message",
      },
    })
  }
  onClose()
  return () => {}
}

function getLastSeq(dataDir, chatId) {
  const state = live.get(chatId)
  if (state) return state.seq
  return lastPersistedSeq(dataDir, chatId)
}

export {
  beginTurn,
  endTurnIfUnterminated,
  subscribe,
  getLastSeq,
  lastPersistedSeq,
  readSince,
}
