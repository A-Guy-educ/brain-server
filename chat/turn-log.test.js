/**
 * Unit tests for the turn broker (turn-log.js).
 *
 * Run: node --test turn-log.test.js
 *
 * Each test uses a unique chatId + temp data dir so the module-level live
 * registry and the on-disk events.jsonl don't bleed across cases.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

import {
  beginTurn,
  endTurnIfUnterminated,
  subscribe,
  getLastSeq,
  readSince,
} from "./turn-log.js"

function tmpDir() {
  const d = path.join(os.tmpdir(), `turnlog-${randomUUID()}`)
  fs.mkdirSync(path.join(d, "chats"), { recursive: true })
  return d
}

/** Collect a subscription synchronously-ish; resolves on onClose. */
function collect(dataDir, chatId, since) {
  return new Promise((resolve) => {
    const records = []
    subscribe(
      dataDir,
      chatId,
      since,
      (rec) => records.push(rec),
      () => resolve(records),
    )
  })
}

test("emits monotonic seq and persists every event to jsonl", () => {
  const dataDir = tmpDir()
  const chatId = "c1"
  const emit = beginTurn(dataDir, chatId)

  emit({ type: "text", text: "a" })
  emit({ type: "text", text: "b" })
  emit({ type: "done", text: "ab" })

  const p = path.join(dataDir, "chats", chatId, "events.jsonl")
  const recs = fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))

  assert.deepEqual(
    recs.map((r) => r.seq),
    [1, 2, 3],
  )
  assert.equal(recs[2].event.type, "done")
  assert.equal(getLastSeq(dataDir, chatId), 3)
})

test("seq stays monotonic across turns in the same chat", () => {
  const dataDir = tmpDir()
  const chatId = "c2"

  const emit1 = beginTurn(dataDir, chatId)
  emit1({ type: "text", text: "t1" })
  emit1({ type: "done", text: "t1" })

  const emit2 = beginTurn(dataDir, chatId)
  emit2({ type: "text", text: "t2" })
  emit2({ type: "done", text: "t2" })

  const recs = readSince(dataDir, chatId, 0)
  assert.deepEqual(
    recs.map((r) => r.seq),
    [1, 2, 3, 4],
  )
  assert.deepEqual(
    recs.map((r) => r.turn),
    [1, 1, 2, 2],
  )
})

test("subscribe replays only events after the cursor", async () => {
  const dataDir = tmpDir()
  const chatId = "c3"
  const emit = beginTurn(dataDir, chatId)
  emit({ type: "text", text: "1" })
  emit({ type: "text", text: "2" })
  emit({ type: "done", text: "done" })

  const records = await collect(dataDir, chatId, 1)
  assert.deepEqual(
    records.map((r) => r.seq),
    [2, 3],
  )
})

test("live tail: subscriber gets events emitted after it attaches, then closes on terminal", async () => {
  const dataDir = tmpDir()
  const chatId = "c4"
  const emit = beginTurn(dataDir, chatId)
  emit({ type: "text", text: "before" })

  const records = []
  const done = new Promise((resolve) => {
    subscribe(
      dataDir,
      chatId,
      0,
      (rec) => records.push(rec),
      () => resolve(),
    )
  })

  // Emitted after subscribe — must arrive live.
  emit({ type: "text", text: "after" })
  emit({ type: "done", text: "all" })
  await done

  assert.deepEqual(
    records.map((r) => r.event.type),
    ["text", "text", "done"],
  )
  assert.equal(records[records.length - 1].event.type, "done")
})

test("reconnect mid-turn replays the gap then continues live to terminal", async () => {
  const dataDir = tmpDir()
  const chatId = "c5"
  const emit = beginTurn(dataDir, chatId)
  emit({ type: "text", text: "seq1" })
  emit({ type: "text", text: "seq2" }) // client saw up to here, then dropped

  const records = []
  const done = new Promise((resolve) => {
    subscribe(
      dataDir,
      chatId,
      2, // reconnect with last-seen seq = 2
      (rec) => records.push(rec),
      () => resolve(),
    )
  })
  emit({ type: "text", text: "seq3" })
  emit({ type: "done", text: "final" })
  await done

  assert.deepEqual(
    records.map((r) => r.seq),
    [3, 4],
  )
})

test("subscribing to an already-ended turn replays and closes without hanging", async () => {
  const dataDir = tmpDir()
  const chatId = "c6"
  const emit = beginTurn(dataDir, chatId)
  emit({ type: "text", text: "x" })
  emit({ type: "done", text: "x" })

  const records = await collect(dataDir, chatId, 0)
  assert.equal(records[records.length - 1].event.type, "done")
})

test("endTurnIfUnterminated synthesizes a terminal error for a runner that threw", async () => {
  const dataDir = tmpDir()
  const chatId = "c7"
  const emit = beginTurn(dataDir, chatId)
  emit({ type: "text", text: "partial" })
  endTurnIfUnterminated(dataDir, chatId, "boom")

  const records = await collect(dataDir, chatId, 0)
  const last = records[records.length - 1]
  assert.equal(last.event.type, "error")
  assert.match(last.event.error, /boom/)
})

test("endTurnIfUnterminated is a no-op once the turn already ended", () => {
  const dataDir = tmpDir()
  const chatId = "c8"
  const emit = beginTurn(dataDir, chatId)
  emit({ type: "done", text: "ok" })
  endTurnIfUnterminated(dataDir, chatId, "should not append")

  const recs = readSince(dataDir, chatId, 0)
  assert.equal(recs.length, 1)
  assert.equal(recs[0].event.type, "done")
})

test("interrupted: persisted log with no terminal and no live turn yields an error then closes", async () => {
  const dataDir = tmpDir()
  const chatId = "c9"
  // Simulate a process restart: write a non-terminal log line directly, with
  // nothing in the in-memory registry.
  const p = path.join(dataDir, "chats", chatId, "events.jsonl")
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.appendFileSync(
    p,
    JSON.stringify({ seq: 1, turn: 1, ts: Date.now(), event: { type: "text", text: "half" } }) + "\n",
  )

  const records = await collect(dataDir, chatId, 0)
  const last = records[records.length - 1]
  assert.equal(last.event.type, "error")
  assert.match(last.event.error, /interrupted/)
})

test("getLastSeq falls back to the persisted tail when nothing is live", () => {
  const dataDir = tmpDir()
  const chatId = "c10"
  const p = path.join(dataDir, "chats", chatId, "events.jsonl")
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.appendFileSync(
    p,
    JSON.stringify({ seq: 7, turn: 1, ts: Date.now(), event: { type: "done" } }) + "\n",
  )
  assert.equal(getLastSeq(dataDir, chatId), 7)
})
