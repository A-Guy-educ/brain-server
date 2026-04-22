#!/usr/bin/env node
/**
 * Brain chat server — multi-turn agent chat.
 *
 * - POST /chats/:id/messages  → SSE stream of agent events
 * - POST /chats/:id/reset     → wipe chat state and workspace
 * - GET  /health              → ok
 *
 * Auth: shared secret in `X-Api-Key` header.
 *
 * Per-chat state lives at $DATA_DIR/chats/<chatId>/state.json.
 * Workspaces use a shared bare repo + per-chat worktree:
 *   $DATA_DIR/repos/<owner>__<name>.git
 *   $DATA_DIR/workspaces/<chatId>/repo
 */

import http from "node:http"
import { URL } from "node:url"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { query } from "@anthropic-ai/claude-agent-sdk"

const PORT = parseInt(process.env.PORT || "4096", 10)
const API_KEY = process.env.BRAIN_API_KEY
const DATA_DIR = process.env.BRAIN_DATA_DIR || path.join(process.env.HOME || ".", "tmp/brain-test")
const MODEL = process.env.BRAIN_MODEL || "claude-sonnet-4-5"

if (!API_KEY) {
  console.error("BRAIN_API_KEY required")
  process.exit(1)
}

fs.mkdirSync(path.join(DATA_DIR, "chats"), { recursive: true })
fs.mkdirSync(path.join(DATA_DIR, "repos"), { recursive: true })
fs.mkdirSync(path.join(DATA_DIR, "workspaces"), { recursive: true })
fs.mkdirSync(path.join(DATA_DIR, "scratch"), { recursive: true })

const chatQueues = new Map()

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts })
  if (r.status !== 0) {
    const err = new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr || r.stdout}`)
    err.stdout = r.stdout
    err.stderr = r.stderr
    throw err
  }
  return r.stdout
}

function repoSlug(repo) {
  return repo.replace("/", "__")
}

function ensureBareRepo(repo) {
  const barePath = path.join(DATA_DIR, "repos", `${repoSlug(repo)}.git`)
  if (!fs.existsSync(barePath)) {
    console.log(`[repo] cloning bare: ${repo}`)
    run("gh", ["repo", "clone", repo, barePath, "--", "--bare"])
  } else {
    try {
      run("git", ["--git-dir", barePath, "fetch", "--all", "--prune"])
    } catch (e) {
      console.warn(`[repo] fetch failed for ${repo}: ${e.message}`)
    }
  }
  return barePath
}

function ensureWorktree(chatId, repo, branch) {
  const barePath = ensureBareRepo(repo)
  const wtPath = path.join(DATA_DIR, "workspaces", chatId, "repo")
  if (fs.existsSync(wtPath)) return wtPath

  fs.mkdirSync(path.dirname(wtPath), { recursive: true })
  const wtBranch = branch ? branch : run("git", ["--git-dir", barePath, "symbolic-ref", "--short", "HEAD"]).trim()
  const localBranch = `chat/${chatId.replace(/[^a-zA-Z0-9_.-]/g, "_")}`
  try {
    run("git", ["--git-dir", barePath, "branch", "-D", localBranch])
  } catch {
    /* branch didn't exist; fine */
  }
  run("git", ["--git-dir", barePath, "worktree", "add", "-b", localBranch, wtPath, `refs/heads/${wtBranch}`])
  return wtPath
}

function chatStatePath(chatId) {
  return path.join(DATA_DIR, "chats", chatId, "state.json")
}

function loadChatState(chatId) {
  const p = chatStatePath(chatId)
  if (!fs.existsSync(p)) return null
  return JSON.parse(fs.readFileSync(p, "utf8"))
}

function saveChatState(chatId, state) {
  const p = chatStatePath(chatId)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(state, null, 2))
}

/**
 * Convert client attachments (with optional data URL base64 payloads) to the
 * content blocks Claude expects:
 *   - image/*  → { type: "image", source: { type: "base64", media_type, data } }
 *   - everything else → { type: "text", text: "[File: name]\n<decoded body>" }
 *
 * Large non-image files are truncated to keep the request under API limits.
 */
function buildContentBlocks(message, attachments) {
  const blocks = [{ type: "text", text: message }]
  if (!Array.isArray(attachments)) return blocks

  for (const att of attachments) {
    if (!att || typeof att.data !== "string") continue
    const mimeType = att.mimeType || "application/octet-stream"
    const name = att.name || "attachment"

    // Strip data URL prefix if present.
    let base64 = att.data
    const match = /^data:([^;]+);base64,(.+)$/.exec(att.data)
    if (match) base64 = match[2]

    if (mimeType.startsWith("image/")) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: mimeType, data: base64 },
      })
      continue
    }

    // Non-image: inline as text. Decode if base64, otherwise use raw data.
    let text
    try {
      text = match
        ? Buffer.from(base64, "base64").toString("utf8")
        : att.data
    } catch {
      text = "[binary — could not decode]"
    }
    const MAX = 20_000
    if (text.length > MAX) text = `${text.slice(0, MAX)}\n…[truncated]`
    blocks.push({ type: "text", text: `[File: ${name} (${mimeType})]\n${text}` })
  }

  return blocks
}

async function runTurn({ chatId, message, attachments, repo: requestedRepo, onEvent }) {
  let state = loadChatState(chatId)
  if (!state) {
    const repo = requestedRepo || null
    const cwd = repo ? ensureWorktree(chatId, repo) : path.join(DATA_DIR, "scratch")
    state = { chatId, repo, cwd, sessionId: null, createdAt: new Date().toISOString() }
    saveChatState(chatId, state)
  }

  // If any attachments were sent, use the multimodal iterable prompt form so
  // Claude sees images as images (not inlined base64 text).
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0
  let promptInput
  if (hasAttachments) {
    const content = buildContentBlocks(message, attachments)
    promptInput = (async function* () {
      yield {
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        session_id: state.sessionId || "",
      }
    })()
  } else {
    promptInput = message
  }

  const q = query({
    prompt: promptInput,
    options: {
      model: MODEL,
      cwd: state.cwd,
      allowedTools: state.repo ? ["Read", "Grep", "Glob", "Bash"] : [],
      permissionMode: "default",
      settingSources: [],
      ...(state.sessionId ? { resume: state.sessionId } : {}),
    },
  })

  let finalText = ""
  let newSessionId = state.sessionId

  try {
  for await (const msg of q) {
    if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
      newSessionId = msg.session_id
    }
    if (msg.type === "assistant" && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === "text") {
          onEvent({ type: "text", text: block.text })
        } else if (block.type === "tool_use") {
          onEvent({ type: "tool_use", name: block.name, input: block.input })
        }
      }
    }
    if (msg.type === "result") {
      if (msg.subtype === "success") {
        finalText = typeof msg.result === "string" ? msg.result : ""
        onEvent({ type: "done", text: finalText })
      } else {
        onEvent({ type: "error", error: `agent failed: ${msg.subtype}` })
      }
    }
  }
  } catch (err) {
    // SDK can throw on upstream API errors (400 for invalid images, etc.).
    // Report to the caller and keep the server alive — an unhandled rejection
    // here would otherwise tank the whole process.
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[runTurn] query iteration failed for chat ${chatId}: ${msg}`)
    onEvent({ type: "error", error: msg })
  }

  if (newSessionId && newSessionId !== state.sessionId) {
    state.sessionId = newSessionId
    state.updatedAt = new Date().toISOString()
    saveChatState(chatId, state)
  }

  return { sessionId: newSessionId, finalText }
}

function enqueue(chatId, fn) {
  const prev = chatQueues.get(chatId) || Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  chatQueues.set(chatId, next.finally(() => {
    if (chatQueues.get(chatId) === next) chatQueues.delete(chatId)
  }))
  return next
}

function sendSseEvent(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString("utf8")
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ status: "ok", model: MODEL, dataDir: DATA_DIR }))
    return
  }

  if (req.headers["x-api-key"] !== API_KEY) {
    res.writeHead(401, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "unauthorized" }))
    return
  }

  const msgMatch = url.pathname.match(/^\/chats\/([^/]+)\/messages$/)
  if (msgMatch && req.method === "POST") {
    const chatId = msgMatch[1] === "new" ? randomUUID() : msgMatch[1]
    const body = await readBody(req)
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "invalid json" }))
      return
    }
    const message = parsed?.message
    const attachments = Array.isArray(parsed?.attachments) ? parsed.attachments : undefined
    const repo = typeof parsed?.repo === "string" && parsed.repo.trim() ? parsed.repo.trim() : undefined
    if (!message || typeof message !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "message required" }))
      return
    }
    if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "repo must be owner/name" }))
      return
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })
    sendSseEvent(res, { type: "chat", chatId })

    try {
      await enqueue(chatId, () => runTurn({
        chatId,
        message,
        attachments,
        repo,
        onEvent: (ev) => sendSseEvent(res, ev),
      }))
    } catch (e) {
      sendSseEvent(res, { type: "error", error: e.message })
    } finally {
      res.end()
    }
    return
  }

  const resetMatch = url.pathname.match(/^\/chats\/([^/]+)\/reset$/)
  if (resetMatch && req.method === "POST") {
    const chatId = resetMatch[1]
    const chatDir = path.join(DATA_DIR, "chats", chatId)
    const wsDir = path.join(DATA_DIR, "workspaces", chatId)
    fs.rmSync(chatDir, { recursive: true, force: true })
    fs.rmSync(wsDir, { recursive: true, force: true })
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  res.writeHead(404)
  res.end("not found")
})

server.listen(PORT, () => {
  console.log(`brain-chat listening on ${PORT}`)
  console.log(`data dir: ${DATA_DIR}`)
  console.log(`model: ${MODEL}`)
})
