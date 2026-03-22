#!/usr/bin/env node
/**
 * OpenClaw Session → OB1 Supabase Sync
 *
 * Reads OpenClaw session JSONL files, extracts messages,
 * and syncs them as thoughts in OB1's Supabase.
 */

const fs = require('fs')
const path = require('path')
const https = require('https')

const SESSIONS_DIR = '/root/.openclaw/agents/main/sessions'
const LAST_SYNC_FILE = '/root/.openclaw/agents/main/.last_synced_session'
const MARKER_FILE = '/root/.openclaw/agents/main/.synced_sessions'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jmdccivoxtiumrpsujwg.supabase.co'
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || ''
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || ''

const EMBEDDING_MODEL = 'text-embedding-ada-002'

function log(msg) {
  console.log(`[sync] ${new Date().toISOString()} ${msg}`)
}

function error(msg) {
  console.error(`[sync:error] ${new Date().toISOString()} ${msg}`)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getOpenRouterEmbedding(text) {
  if (!OPENROUTER_API_KEY) {
    log('OpenRouter API key not configured, skipping embedding')
    return Promise.resolve(null)
  }

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text.substring(0, 8000),
    })

    const req = https.request(
      {
        hostname: 'openrouter.ai',
        port: 443,
        path: '/api/v1/embeddings',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 30000,
      },
      res => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          if (res.statusCode >= 400) {
            error(`OpenRouter error ${res.statusCode}: ${data.substring(0, 200)}`)
            resolve(null)
            return
          }
          try {
            const parsed = JSON.parse(data)
            resolve(parsed.data?.[0]?.embedding || null)
          } catch (e) {
            error(`OpenRouter parse error: ${e.message}`)
            resolve(null)
          }
        })
      },
    )

    req.on('timeout', () => { req.destroy(); error('OpenRouter timeout'); resolve(null) })
    req.on('error', err => { error(`OpenRouter request error: ${err.message}`); resolve(null) })
    req.write(body)
    req.end()
  })
}

function insertThought(content, metadata) {
  if (!SUPABASE_SERVICE_KEY) {
    error('Supabase service key not configured')
    return Promise.resolve({ success: false, error: 'No service key' })
  }

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      content: content.substring(0, 10000),
      metadata: metadata,
    })

    const url = new URL(SUPABASE_URL)
    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: '/rest/v1/thoughts',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
          'Content-Length': Buffer.byteLength(body),
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
        timeout: 15000,
      },
      res => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          if (res.statusCode >= 400) {
            error(`Supabase insert error ${res.statusCode}: ${data.substring(0, 200)}`)
            resolve({ success: false, error: `HTTP ${res.statusCode}` })
            return
          }
          try {
            const parsed = data ? JSON.parse(data) : {}
            resolve({ success: true, id: parsed.id })
          } catch (e) {
            resolve({ success: res.statusCode === 201, error: e.message })
          }
        })
      },
    )

    req.on('timeout', () => { req.destroy(); error('Supabase timeout'); resolve({ success: false, error: 'timeout' }) })
    req.on('error', err => { error(`Supabase request error: ${err.message}`); resolve({ success: false, error: err.message }) })
    req.write(body)
    req.end()
  })
}

function readJSONL(filePath) {
  const content = fs.readFileSync(filePath, 'utf8')
  const lines = content.split('\n').filter(l => l.trim())
  const entries = []

  for (const line of lines) {
    try {
      entries.push(JSON.parse(line))
    } catch (e) {
      // Skip malformed lines
    }
  }

  return entries
}

function extractMessages(entries) {
  const messages = []

  for (const entry of entries) {
    if (entry.type === 'message' && entry.message) {
      const msg = entry.message
      if (msg.role === 'user' || msg.role === 'assistant') {
        const text = Array.isArray(msg.content)
          ? msg.content.map(c => c.type === 'text' ? c.text : '').join('')
          : typeof msg.content === 'string' ? msg.content : ''

        if (text.trim()) {
          messages.push({
            role: msg.role,
            text: text.trim(),
            timestamp: entry.timestamp,
          })
        }
      }
    }
  }

  return messages
}

function sessionToThought(sessionId, entries) {
  const messages = extractMessages(entries)

  if (messages.length === 0) {
    return null
  }

  const combinedText = messages
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
    .join('\n\n')

  const metadata = {
    source: 'openclaw',
    session_id: sessionId,
    message_count: messages.length,
    first_message: messages[0]?.text?.substring(0, 200) || '',
    last_message: messages[messages.length - 1]?.text?.substring(0, 200) || '',
    timestamps: messages.map(m => m.timestamp),
  }

  return {
    content: `OpenClaw Session:\n\n${combinedText}`,
    metadata: metadata,
  }
}

function getLastSyncedSessionId() {
  try {
    if (fs.existsSync(LAST_SYNC_FILE)) {
      return fs.readFileSync(LAST_SYNC_FILE, 'utf8').trim()
    }
  } catch (e) {}
  return null
}

function setLastSyncedSessionId(sessionId) {
  try {
    fs.writeFileSync(LAST_SYNC_FILE, sessionId, 'utf8')
  } catch (e) {
    error(`Failed to write last synced file: ${e.message}`)
  }
}

function getSyncedSessions() {
  try {
    if (fs.existsSync(MARKER_FILE)) {
      return new Set(fs.readFileSync(MARKER_FILE, 'utf8').trim().split('\n').filter(Boolean))
    }
  } catch (e) {}
  return new Set()
}

function addSyncedSession(sessionId) {
  const synced = getSyncedSessions()
  synced.add(sessionId)
  try {
    fs.writeFileSync(MARKER_FILE, Array.from(synced).join('\n'), 'utf8')
  } catch (e) {
    error(`Failed to update synced sessions file: ${e.message}`)
  }
}

async function syncSession(sessionFile) {
  const sessionId = path.basename(sessionFile, '.jsonl')
  const entries = readJSONL(sessionFile)

  if (entries.length === 0) {
    log(`Skipping empty session: ${sessionId}`)
    return { sessionId, synced: false, reason: 'empty' }
  }

  const thought = sessionToThought(sessionId, entries)
  if (!thought) {
    log(`Skipping session with no extractable messages: ${sessionId}`)
    return { sessionId, synced: false, reason: 'no_messages' }
  }

  log(`Syncing session ${sessionId} (${entries.length} entries, ${thought.metadata.message_count} messages)`)

  const embedding = await getOpenRouterEmbedding(thought.content)

  const insertData = {
    content: thought.content,
    metadata: thought.metadata,
  }

  if (embedding) {
    insertData.embedding = embedding
  }

  const result = await insertThought(insertData.content, insertData.metadata)

  if (result.success) {
    log(`Successfully synced session ${sessionId}${result.id ? ` (id: ${result.id})` : ''}`)
    addSyncedSession(sessionId)
    return { sessionId, synced: true, id: result.id }
  } else {
    error(`Failed to insert session ${sessionId}: ${result.error}`)
    return { sessionId, synced: false, reason: result.error }
  }
}

async function main() {
  log('Starting OpenClaw session sync')

  if (!SUPABASE_SERVICE_KEY) {
    error('SUPABASE_SERVICE_ROLE_KEY not set')
    process.exit(1)
  }

  if (!fs.existsSync(SESSIONS_DIR)) {
    error(`Sessions directory not found: ${SESSIONS_DIR}`)
    process.exit(1)
  }

  const files = fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => path.join(SESSIONS_DIR, f))
    .sort()

  if (files.length === 0) {
    log('No session files found')
    return
  }

  log(`Found ${files.length} session files`)

  const syncedSessions = getSyncedSessions()
  let synced = 0
  let skipped = 0

  for (const file of files) {
    const sessionId = path.basename(file, '.jsonl')

    if (syncedSessions.has(sessionId)) {
      log(`Skipping already synced session: ${sessionId}`)
      skipped++
      continue
    }

    const result = await syncSession(file)

    if (result.synced) {
      synced++
      setLastSyncedSessionId(sessionId)
    }

    await sleep(500)
  }

  log(`Sync complete: ${synced} synced, ${skipped} skipped, ${files.length - synced - skipped} failed`)
}

main().catch(e => {
  error(`Fatal error: ${e.message}`)
  process.exit(1)
})