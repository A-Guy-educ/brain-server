#!/usr/bin/env node
/**
 * Brain chat CLI — terminal client for brain-chat server.
 *
 * Usage:
 *   BRAIN_API_KEY=... node cli.js [chatId]
 *
 * If chatId is omitted, a new UUID is used (server mints one via "new" path).
 */

import readline from "node:readline"
import { randomUUID } from "node:crypto"

const SERVER = process.env.BRAIN_CHAT_URL || "http://localhost:4096"
const API_KEY = process.env.BRAIN_API_KEY
if (!API_KEY) {
  console.error("BRAIN_API_KEY required")
  process.exit(1)
}

const chatId = process.argv[2] || randomUUID()
console.log(`chatId: ${chatId}`)
console.log(`server: ${SERVER}`)
console.log(`(Ctrl-C to quit, /reset to wipe chat, /new for a fresh chatId)`)

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
let currentChatId = chatId

function prompt() {
  rl.question("\nyou> ", async (line) => {
    const msg = line.trim()
    if (!msg) return prompt()

    if (msg === "/new") {
      currentChatId = randomUUID()
      console.log(`new chatId: ${currentChatId}`)
      return prompt()
    }

    if (msg === "/reset") {
      const r = await fetch(`${SERVER}/chats/${currentChatId}/reset`, {
        method: "POST",
        headers: { "X-Api-Key": API_KEY },
      })
      console.log(`reset: ${r.status}`)
      return prompt()
    }

    await sendMessage(msg)
    prompt()
  })
}

async function sendMessage(message) {
  const res = await fetch(`${SERVER}/chats/${currentChatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": API_KEY },
    body: JSON.stringify({ message }),
  })
  if (!res.ok) {
    console.error(`error: ${res.status} ${await res.text()}`)
    return
  }

  process.stdout.write("bot> ")
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    const events = buf.split("\n\n")
    buf = events.pop()

    for (const raw of events) {
      const line = raw.split("\n").find((l) => l.startsWith("data: "))
      if (!line) continue
      const data = JSON.parse(line.slice(6))

      switch (data.type) {
        case "chat":
          break
        case "text":
          process.stdout.write(data.text)
          break
        case "tool_use":
          process.stdout.write(`\n  [tool: ${data.name}]\n`)
          break
        case "done":
          process.stdout.write("\n")
          break
        case "error":
          process.stdout.write(`\n[error: ${data.error}]\n`)
          break
      }
    }
  }
}

prompt()
