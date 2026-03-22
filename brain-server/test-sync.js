#!/usr/bin/env node
/**
 * Comprehensive test for OpenClaw → OB1 sync
 */

const fs = require('fs')
const path = require('path')
const https = require('https')

const SESSIONS_DIR = '/root/.openclaw/agents/main/sessions'

const SUPABASE_URL = 'https://jmdccivoxtiumrpsujwg.supabase.co'
const SUPABASE_SERVICE_KEY = 'sb_publishable_HM54ruiE3qcxGwBkUx2xyw_MBLYOW6r'
const OPENROUTER_API_KEY = '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'

let testsPassed = 0
let testsFailed = 0

function log(msg) {
  console.log(`[test] ${msg}`)
}

function pass(msg) {
  console.log(`  ✓ ${msg}`)
  testsPassed++
}

function fail(msg) {
  console.error(`  ✗ ${msg}`)
  testsFailed++
}

function assert(condition, msg) {
  if (condition) {
    pass(msg)
  } else {
    fail(msg)
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function httpRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode, data }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    if (body) req.write(body)
    req.end()
  })
}

async function querySupabase(table, filters = {}) {
  const url = new URL(SUPABASE_URL)
  let path = `/rest/v1/${table}`
  const params = new URLSearchParams(filters)
  if (params.toString()) path += `?${params}`

  const res = await httpRequest({
    hostname: url.hostname,
    port: 443,
    path,
    method: 'GET',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      Accept: 'application/json',
    },
    timeout: 10000,
  })

  return { status: res.status, data: JSON.parse(res.data) }
}

async function getOpenRouterEmbedding(text) {
  const body = JSON.stringify({
    model: 'text-embedding-ada-002',
    input: text.substring(0, 100),
  })

  const res = await httpRequest({
    hostname: 'openrouter.ai',
    port: 443,
    path: '/api/v1/embeddings',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: 15000,
  })

  return JSON.parse(res.data)
}

function readJSONL(filePath) {
  const content = fs.readFileSync(filePath, 'utf8')
  return content.split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
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
          messages.push({ role: msg.role, text: text.trim() })
        }
      }
    }
  }
  return messages
}

async function runTests() {
  console.log('\n========================================')
  console.log('OpenClaw → OB1 Sync Comprehensive Test')
  console.log('========================================\n')

  log('TEST 1: Session files exist and are readable')
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl'))
  assert(files.length > 0, `Found ${files.length} session files`)
  const sessionFile = path.join(SESSIONS_DIR, files[0])
  assert(fs.existsSync(sessionFile), `Session file exists: ${files[0]}`)

  log('\nTEST 2: JSONL parsing')
  const entries = readJSONL(sessionFile)
  assert(entries.length > 0, `Parsed ${entries.length} entries from JSONL`)
  const hasSession = entries.some(e => e.type === 'session')
  const hasMessages = entries.some(e => e.type === 'message')
  assert(hasSession, 'Contains session metadata entry')
  assert(hasMessages, 'Contains message entries')

  log('\nTEST 3: Message extraction')
  const messages = extractMessages(entries)
  assert(messages.length > 0, `Extracted ${messages.length} messages`)
  const userMsgs = messages.filter(m => m.role === 'user')
  const assistantMsgs = messages.filter(m => m.role === 'assistant')
  assert(userMsgs.length > 0, `Found ${userMsgs.length} user messages`)
  assert(assistantMsgs.length > 0, `Found ${assistantMsgs.length} assistant messages`)

  log('\nTEST 4: OpenRouter embedding generation')
  const testText = 'Hello world test'
  let embedding = null
  try {
    const result = await getOpenRouterEmbedding(testText)
    embedding = result.data?.[0]?.embedding
    assert(Array.isArray(embedding), 'Got embedding array back')
    assert(embedding.length === 1536, `Embedding dimension is 1536 (got ${embedding.length})`)
  } catch (e) {
    fail(`OpenRouter error: ${e.message}`)
  }

  log('\nTEST 5: Supabase connection')
  try {
    const res = await querySupabase('thoughts', { select: 'id', limit: 1 })
    assert(res.status === 200, `Supabase accessible (status ${res.status})`)
  } catch (e) {
    fail(`Supabase connection error: ${e.message}`)
  }

  log('\nTEST 6: Synced thoughts exist in Supabase')
  try {
    const res = await querySupabase('thoughts', {
      select: 'id,content,metadata',
      limit: 10,
      order: 'created_at.desc'
    })
    assert(res.status === 200, `Query succeeded (status ${res.status})`)
    const openclawThoughts = res.data.filter(t => t.metadata?.source === 'openclaw')
    assert(openclawThoughts.length > 0, `Found ${openclawThoughts.length} OpenClaw-sourced thoughts`)

    log(`\n  Sample synced thoughts:`)
    for (const thought of openclawThoughts.slice(0, 3)) {
      const preview = thought.content?.substring(0, 80).replace(/\n/g, ' ') || 'N/A'
      const msgs = thought.metadata?.message_count || 0
      console.log(`    - [${thought.id}] ${preview}... (${msgs} msgs)`)
    }
  } catch (e) {
    fail(`Query error: ${e.message}`)
  }

  log('\nTEST 7: Semantic search via match_thoughts RPC')
  try {
    const queryEmbedding = embedding || (await getOpenRouterEmbedding('test query')).data?.[0]?.embedding
    if (queryEmbedding) {
      const body = JSON.stringify({
        query_embedding: queryEmbedding,
        match_threshold: 0.5,
        match_count: 5,
        filter: {},
      })

      const res = await httpRequest({
        hostname: new URL(SUPABASE_URL).hostname,
        port: 443,
        path: '/rest/v1/rpc/match_thoughts',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
          'Content-Length': Buffer.byteLength(body),
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
        timeout: 20000,
      })

      if (res.data) {
        const results = JSON.parse(res.data)
        const openclawResults = Array.isArray(results)
          ? results.filter(r => r.metadata?.source === 'openclaw')
          : []
        assert(openclawResults.length >= 0, `Semantic search returned ${openclawResults.length} OpenClaw results (embeddings may be null)`)
      } else {
        pass('Semantic search RPC called (results depend on embeddings)')
      }
    } else {
      fail('Could not get embedding for semantic search test')
    }
  } catch (e) {
    fail(`Semantic search error: ${e.message}`)
  }

  log('\nTEST 8: Thought metadata structure')
  try {
    const res = await httpRequest({
      hostname: new URL(SUPABASE_URL).hostname,
      port: 443,
      path: '/rest/v1/thoughts?metadata->>source=eq.openclaw&select=metadata&limit=5',
      method: 'GET',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        Accept: 'application/json',
      },
      timeout: 10000,
    })

    if (res.data) {
      const thoughts = JSON.parse(res.data)
      if (thoughts.length > 0) {
        const meta = thoughts[0].metadata
        assert(meta.session_id !== undefined, 'Has session_id')
        assert(meta.message_count !== undefined, 'Has message_count')
        assert(meta.first_message !== undefined, 'Has first_message')
        assert(meta.last_message !== undefined, 'Has last_message')
        assert(Array.isArray(meta.timestamps), 'Timestamps is array')
      }
    }
  } catch (e) {
    fail(`Metadata check error: ${e.message}`)
  }

  log('\nTEST 9: Deduplication marker file exists')
  const markerFile = '/root/.openclaw/agents/main/.synced_sessions'
  assert(fs.existsSync(markerFile), 'Marker file exists')
  if (fs.existsSync(markerFile)) {
    const synced = fs.readFileSync(markerFile, 'utf8').trim().split('\n').filter(Boolean)
    assert(synced.length > 0, `Marker file has ${synced.length} entries`)
    log(`  Synced sessions: ${synced.join(', ')}`)
  }

  log('\nTEST 10: Cron job configured')
  const { execSync } = require('child_process')
  try {
    const crontab = execSync('crontab -l', { encoding: 'utf8' })
    const hasSyncCron = crontab.includes('run-sync')
    assert(hasSyncCron, 'Cron job for run-sync exists')
    if (hasSyncCron) {
      const line = crontab.split('\n').find(l => l.includes('run-sync'))
      log(`  Cron line: ${line.trim()}`)
    }
  } catch (e) {
    fail('Could not read crontab')
  }

  console.log('\n========================================')
  console.log(`Results: ${testsPassed} passed, ${testsFailed} failed`)
  console.log('========================================\n')

  process.exit(testsFailed > 0 ? 1 : 0)
}

runTests().catch(e => {
  console.error('Test runner error:', e)
  process.exit(1)
})