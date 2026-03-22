#!/usr/bin/env node
/**
 * Brain Dashboard - Express server with web UI
 * 
 * Serves at http://100.66.248.120:4098 (Tailscale only)
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const { execSync, exec } = require('child_process')

const PORT = process.env.DASHBOARD_PORT || 4103

const SESSIONS_DIR = '/root/.openclaw/agents/main/sessions'
const SESSIONS_MARKER = '/root/.openclaw/agents/main/.synced_sessions'
const SUPABASE_URL = 'https://jmdccivoxtiumrpsujwg.supabase.co'
const SUPABASE_KEY = 'sb_publishable_HM54ruiE3qcxGwBkUx2xyw_MBLYOW6r'
const BRAIN_AGENT_DIR = '/opt/brain-server/brain-agent'
const OPENCLAW_WORKSPACE = '/opt/openclaw-workspace'
const REPO_DIR = '/opt/repo'

function log(msg) {
  console.log(`[dashboard] ${new Date().toISOString()} ${msg}`)
}

function httpRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
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

function httpsRequest(options, body = null) {
  const mod = require(options._mod || 'https')
  return new Promise((resolve, reject) => {
    const req = mod.request(options, res => {
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

async function getServices() {
  const services = []

  try {
    const brainHealth = await httpRequest({ hostname: '127.0.0.1', port: 4099, path: '/health', method: 'GET' }, null).catch(() => null)
    services.push({
      name: 'Brain Agent',
      port: 4099,
      status: brainHealth ? 'healthy' : 'down',
      info: brainHealth ? JSON.parse(brainHealth.data).service : null
    })
  } catch { services.push({ name: 'Brain Agent', port: 4099, status: 'down' }) }

  try {
    const contextHealth = await httpRequest({ hostname: '127.0.0.1', port: 4097, path: '/health', method: 'GET' }, null).catch(() => null)
    services.push({
      name: 'Context+',
      port: 4097,
      status: contextHealth ? 'healthy' : 'down',
      info: contextHealth ? 'SSE endpoint' : null
    })
  } catch { services.push({ name: 'Context+', port: 4097, status: 'down' }) }

  try {
    const openclawHealth = await httpRequest({ hostname: '127.0.0.1', port: 18789, path: '/', method: 'GET' }, null).catch(() => null)
    services.push({
      name: 'OpenClaw',
      port: 18789,
      status: openclawHealth ? 'healthy' : 'down',
      info: 'Gateway'
    })
  } catch { services.push({ name: 'OpenClaw', port: 18789, status: 'down' }) }

  try {
    const dockerPS = execSync('docker ps --format "{{.Names}}|{{.Status}}" 2>/dev/null', { encoding: 'utf8' })
    const containers = dockerPS.trim().split('\n').filter(Boolean).map(line => {
      const [name, ...statusParts] = line.split('|')
      return { name, status: statusParts.join('|') }
    })
    services.push({ name: 'Docker Containers', port: null, status: 'info', info: containers.length + ' running', containers })
  } catch { services.push({ name: 'Docker', port: null, status: 'down' }) }

  return services
}

async function getBrainAgentConfig() {
  const config = {}
  try {
    const envPath = path.join(BRAIN_AGENT_DIR, '.env')
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8')
      content.split('\n').forEach(line => {
        const match = line.match(/^([^=]+)=(.*)$/)
        if (match) {
          const key = match[1].trim()
          const value = match[2].trim()
          if (key.includes('KEY') || key.includes('SECRET') || key.includes('PASSWORD')) {
            config[key] = '***'
          } else {
            config[key] = value
          }
        }
      })
    }
  } catch (e) { log('Error reading brain-agent config: ' + e.message) }
  return config
}

async function getRepo() {
  try {
    const remote = execSync('cd ' + REPO_DIR + ' && git remote get-url origin 2>/dev/null', { encoding: 'utf8' }).trim()
    const branch = execSync('cd ' + REPO_DIR + ' && git rev-parse --abbrev-ref HEAD 2>/dev/null', { encoding: 'utf8' }).trim()
    const commit = execSync('cd ' + REPO_DIR + ' && git log --oneline -1 2>/dev/null', { encoding: 'utf8' }).trim()
    return { remote, branch, commit, path: REPO_DIR }
  } catch (e) { return { error: e.message } }
}

async function getSessions() {
  const sessions = []
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return sessions
    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl'))
    for (const file of files) {
      const sessionId = file.replace('.jsonl', '')
      const filePath = path.join(SESSIONS_DIR, file)
      const stats = fs.statSync(filePath)
      const content = fs.readFileSync(filePath, 'utf8')
      const lines = content.split('\n').filter(l => l.trim())
      let msgCount = 0
      let lastMsg = null
      for (const line of lines) {
        try {
          const entry = JSON.parse(line)
          if (entry.type === 'message' && entry.message) {
            msgCount++
            lastMsg = entry.message.content?.[0]?.text?.substring(0, 50) || lastMsg
          }
        } catch {}
      }
      sessions.push({
        id: sessionId,
        file,
        messageCount: msgCount,
        lastMessage: lastMsg,
        updated: stats.mtime.toISOString(),
        size: stats.size
      })
    }
  } catch (e) { log('Error reading sessions: ' + e.message) }
  return sessions
}

async function getSyncedSessions() {
  try {
    if (fs.existsSync(SESSIONS_MARKER)) {
      return fs.readFileSync(SESSIONS_MARKER, 'utf8').trim().split('\n').filter(Boolean)
    }
  } catch {}
  return []
}

async function getThoughts(limit = 50, offset = 0, search = null) {
  try {
    const url = new URL(SUPABASE_URL)
    let path = `/rest/v1/thoughts?select=id,content,metadata,created_at&order=created_at.desc&limit=${limit}&offset=${offset}`
    
    const res = await httpsRequest({
      hostname: url.hostname,
      port: 443,
      path,
      method: 'GET',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Accept: 'application/json'
      },
      _mod: 'https'
    })
    
    let thoughts = JSON.parse(res.data)
    
    if (search) {
      const searchLower = search.toLowerCase()
      thoughts = thoughts.filter(t => 
        t.content?.toLowerCase().includes(searchLower) ||
        t.metadata?.session_id?.toLowerCase().includes(searchLower)
      )
    }
    
    return thoughts
  } catch (e) { log('Error fetching thoughts: ' + e.message); return [] }
}

async function searchThoughts(query) {
  try {
    const url = new URL(SUPABASE_URL)
    
    const embedRes = await httpsRequest({
      hostname: 'openrouter.ai',
      port: 443,
      path: '/api/v1/embeddings',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY
      },
      _mod: 'https'
    })
    
    const embedding = JSON.parse(embedRes.data).data?.[0]?.embedding
    if (!embedding) return []
    
    const body = JSON.stringify({
      query_embedding: embedding,
      match_threshold: 0.5,
      match_count: 10,
      filter: {}
    })
    
    const res = await httpsRequest({
      hostname: url.hostname,
      port: 443,
      path: '/rest/v1/rpc/match_thoughts',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      },
      _mod: 'https'
    })
    
    return JSON.parse(res.data)
  } catch (e) { log('Error searching thoughts: ' + e.message); return [] }
}

async function getCronJobs() {
  try {
    const crontab = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' })
    return crontab.split('\n').filter(l => l.trim() && !l.startsWith('#'))
  } catch { return [] }
}

async function getLogs() {
  const logs = []
  
  try {
    const syncLog = fs.readFileSync('/var/log/openclaw-sync.log', 'utf8').split('\n').slice(-50)
    logs.push({ name: 'OpenClaw Sync', lines: syncLog })
  } catch {}
  
  try {
    const brainLogs = execSync('docker logs brain-server-brain-1 --tail 30 2>&1', { encoding: 'utf8', maxBuffer: 1024 * 1024 })
    logs.push({ name: 'Brain Agent (Docker)', lines: brainLogs.split('\n').slice(-30) })
  } catch {}
  
  try {
    const openclawLogs = execSync('tail -30 /tmp/openclaw/openclaw-2026-03-22.log 2>/dev/null || tail -30 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>/dev/null', { encoding: 'utf8' })
    logs.push({ name: 'OpenClaw', lines: openclawLogs.split('\n').slice(-30) })
  } catch {}
  
  return logs
}

async function updateBrainAgentConfig(key, value) {
  try {
    const envPath = path.join(BRAIN_AGENT_DIR, '.env')
    let content = ''
    if (fs.existsSync(envPath)) {
      content = fs.readFileSync(envPath, 'utf8')
    }
    
    const lines = content.split('\n')
    let found = false
    const newLines = lines.map(line => {
      if (line.startsWith(key + '=')) {
        found = true
        return key + '=' + value
      }
      return line
    })
    if (!found) {
      newLines.push(key + '=' + value)
    }
    
    fs.writeFileSync(envPath, newLines.join('\n'))
    return { success: true }
  } catch (e) { return { success: false, error: e.message } }
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Brain Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f23; color: #fff; min-height: 100vh; }
    .header { background: #1a1a2e; padding: 1rem 2rem; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; }
    .header h1 { font-size: 1.5rem; color: #00d4ff; }
    .header .status { display: flex; gap: 1rem; align-items: center; }
    .status-dot { width: 10px; height: 10px; border-radius: 50%; background: #666; }
    .status-dot.healthy { background: #00ff88; }
    .status-dot.down { background: #ff4444; }
    .status-dot.info { background: #ffaa00; }
    .container { max-width: 1400px; margin: 0 auto; padding: 1rem 2rem; }
    .card { background: #1a1a2e; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; border: 1px solid #333; }
    .card h2 { font-size: 1.1rem; margin-bottom: 1rem; color: #00d4ff; display: flex; align-items: center; gap: 0.5rem; }
    .card h3 { font-size: 0.9rem; color: #888; margin: 1rem 0 0.5rem; }
    .tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
    .tab { padding: 0.5rem 1rem; background: #252540; border: none; border-radius: 6px; color: #888; cursor: pointer; font-size: 0.9rem; }
    .tab.active { background: #00d4ff; color: #000; }
    .tab:hover:not(.active) { background: #333; }
    .btn { padding: 0.5rem 1rem; background: #00d4ff; border: none; border-radius: 6px; color: #000; cursor: pointer; font-size: 0.85rem; font-weight: 500; }
    .btn:hover { background: #00b8d4; }
    .btn.small { padding: 0.25rem 0.5rem; font-size: 0.75rem; }
    .btn.danger { background: #ff4444; color: #fff; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; }
    .service-card { background: #252540; padding: 1rem; border-radius: 8px; }
    .service-card .name { font-weight: 600; margin-bottom: 0.5rem; }
    .service-card .details { font-size: 0.85rem; color: #888; }
    .config-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 0.75rem; }
    .config-item { display: flex; background: #252540; padding: 0.75rem; border-radius: 6px; gap: 0.5rem; align-items: center; }
    .config-item .key { color: #00d4ff; font-family: monospace; font-size: 0.85rem; min-width: 150px; }
    .config-item .value { color: #888; font-family: monospace; font-size: 0.85rem; flex: 1; word-break: break-all; }
    .config-item input { background: #333; border: 1px solid #444; color: #fff; padding: 0.25rem 0.5rem; border-radius: 4px; font-family: monospace; font-size: 0.85rem; width: 200px; }
    .search-box { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
    .search-box input { flex: 1; background: #252540; border: 1px solid #333; color: #fff; padding: 0.75rem; border-radius: 8px; font-size: 1rem; }
    .search-box input::placeholder { color: #666; }
    .thought-list { max-height: 400px; overflow-y: auto; }
    .thought-item { background: #252540; padding: 1rem; border-radius: 8px; margin-bottom: 0.5rem; }
    .thought-item .meta { display: flex; justify-content: space-between; font-size: 0.75rem; color: #666; margin-bottom: 0.5rem; }
    .thought-item .content { font-size: 0.9rem; color: #ccc; line-height: 1.4; }
    .thought-item .source { color: #00d4ff; }
    .session-item { display: flex; justify-content: space-between; align-items: center; background: #252540; padding: 1rem; border-radius: 8px; margin-bottom: 0.5rem; }
    .session-item .id { font-family: monospace; font-size: 0.85rem; color: #00d4ff; }
    .session-item .details { font-size: 0.85rem; color: #888; }
    .session-item .synced { color: #00ff88; font-size: 0.75rem; }
    .session-item .not-synced { color: #ffaa00; font-size: 0.75rem; }
    .log-viewer { background: #000; padding: 1rem; border-radius: 8px; font-family: monospace; font-size: 0.75rem; max-height: 300px; overflow-y: auto; white-space: pre-wrap; color: #0f0; }
    .repo-card { display: flex; justify-content: space-between; align-items: center; background: #252540; padding: 1rem; border-radius: 8px; }
    .repo-card .info { flex: 1; }
    .repo-card .name { font-weight: 600; margin-bottom: 0.25rem; }
    .repo-card .remote { font-size: 0.8rem; color: #666; font-family: monospace; }
    .repo-card .commit { font-size: 0.8rem; color: #888; margin-top: 0.25rem; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .refresh-info { font-size: 0.75rem; color: #666; margin-left: 0.5rem; }
    .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 1000; }
    .modal.active { display: flex; align-items: center; justify-content: center; }
    .modal-content { background: #1a1a2e; padding: 2rem; border-radius: 12px; max-width: 500px; width: 90%; }
    .modal-content h3 { margin-bottom: 1rem; }
    .modal-content input { width: 100%; background: #252540; border: 1px solid #333; color: #fff; padding: 0.75rem; border-radius: 8px; margin-bottom: 1rem; }
    .modal-content .buttons { display: flex; gap: 0.5rem; justify-content: flex-end; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🧠 Brain Dashboard</h1>
    <div class="status">
      <span>Services:</span>
      <span id="services-summary">Loading...</span>
    </div>
  </div>
  
  <div class="container">
    <div class="tabs">
      <button class="tab active" data-tab="services">Services</button>
      <button class="tab" data-tab="config">Brain Agent Config</button>
      <button class="tab" data-tab="repo">Repository</button>
      <button class="tab" data-tab="thoughts">OB1 Brain</button>
      <button class="tab" data-tab="sessions">OpenClaw Sessions</button>
      <button class="tab" data-tab="logs">Logs</button>
    </div>
    
    <div id="tab-services" class="tab-content active">
      <div class="card">
        <h2>Services <button class="btn small" onclick="refreshServices()">Refresh</button></h2>
        <div id="services-grid" class="grid"></div>
      </div>
    </div>
    
    <div id="tab-config" class="tab-content">
      <div class="card">
        <h2>Brain Agent Configuration <button class="btn small" onclick="refreshConfig()">Refresh</button></h2>
        <p style="color:#666;font-size:0.85rem;margin-bottom:1rem;">Sensitive values are masked. Edit by clicking a value.</p>
        <div id="config-grid" class="config-grid"></div>
      </div>
    </div>
    
    <div id="tab-repo" class="tab-content">
      <div class="card">
        <h2>Current Repository <button class="btn small" onclick="refreshRepo()">Refresh</button></h2>
        <div id="repo-info" class="repo-card"></div>
      </div>
    </div>
    
    <div id="tab-thoughts" class="tab-content">
      <div class="card">
        <h2>OB1 Brain (Supabase) <button class="btn small" onclick="refreshThoughts()">Refresh</button></h2>
        <div class="search-box">
          <input type="text" id="thought-search" placeholder="Search thoughts..." onkeyup="if(event.key==='Enter')searchThoughts()">
          <button class="btn" onclick="searchThoughts()">Search</button>
          <button class="btn" onclick="clearSearch()" style="background:#333;color:#fff;">Clear</button>
        </div>
        <div id="thoughts-stats" style="color:#888;font-size:0.85rem;margin-bottom:1rem;"></div>
        <div id="thoughts-list" class="thought-list"></div>
      </div>
    </div>
    
    <div id="tab-sessions" class="tab-content">
      <div class="card">
        <h2>OpenClaw Sessions <button class="btn small" onclick="refreshSessions()">Refresh</button></h2>
        <div id="sessions-list"></div>
      </div>
    </div>
    
    <div id="tab-logs" class="tab-content">
      <div class="card">
        <h2>Cron Jobs <button class="btn small" onclick="refreshCron()">Refresh</button></h2>
        <div id="cron-list" style="background:#252540;padding:1rem;border-radius:8px;margin-bottom:1rem;"></div>
      </div>
      <div class="card">
        <h2>Service Logs <button class="btn small" onclick="refreshLogs()">Refresh</button></h2>
        <div id="logs-list"></div>
      </div>
    </div>
  </div>
  
  <script>
    let currentTab = 'services'
    
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'))
        tab.classList.add('active')
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active')
        currentTab = tab.dataset.tab
        loadTab(currentTab)
      })
    })
    
    function loadTab(tab) {
      if (tab === 'services') refreshServices()
      else if (tab === 'config') refreshConfig()
      else if (tab === 'repo') refreshRepo()
      else if (tab === 'thoughts') refreshThoughts()
      else if (tab === 'sessions') refreshSessions()
      else if (tab === 'logs') { refreshCron(); refreshLogs() }
    }
    
    async function api(endpoint) {
      try {
        const res = await fetch('/api/' + endpoint)
        return await res.json()
      } catch (e) { return { error: e.message } }
    }
    
    async function refreshServices() {
      const data = await api('services')
      const grid = document.getElementById('services-grid')
      const summary = document.getElementById('services-summary')
      
      if (data.error) {
        grid.innerHTML = '<p style="color:#ff4444">Error: ' + data.error + '</p>'
        return
      }
      
      const healthy = data.filter(s => s.status === 'healthy').length
      summary.innerHTML = healthy + '/' + data.length + ' healthy'
      
      grid.innerHTML = data.map(s => \`
        <div class="service-card">
          <div class="name"><span class="status-dot \${s.status}"></span> \${s.name}</div>
          <div class="details">
            \${s.port ? 'Port: ' + s.port : ''} \${s.info || ''}
            \${s.containers ? '<br>Containers: ' + s.containers.map(c => c.name).join(', ') : ''}
          </div>
        </div>
      \`).join('')
    }
    
    async function refreshConfig() {
      const data = await api('config')
      const grid = document.getElementById('config-grid')
      
      if (data.error) {
        grid.innerHTML = '<p style="color:#ff4444">Error: ' + data.error + '</p>'
        return
      }
      
      grid.innerHTML = Object.entries(data).map(([key, value]) => \`
        <div class="config-item">
          <span class="key">\${key}</span>
          <span class="value">\${value}</span>
          <input type="text" id="cfg-\${key}" placeholder="New value..." style="display:none">
          <button class="btn small" onclick="toggleEdit('\${key}')">Edit</button>
          <button class="btn small" onclick="saveConfig('\${key}')" style="display:none" id="save-\${key}">Save</button>
        </div>
      \`).join('')
    }
    
    function toggleEdit(key) {
      const input = document.getElementById('cfg-' + key)
      const saveBtn = document.getElementById('save-' + key)
      input.style.display = input.style.display === 'none' ? 'block' : 'none'
      saveBtn.style.display = saveBtn.style.display === 'none' ? 'inline-block' : 'none'
    }
    
    async function saveConfig(key) {
      const input = document.getElementById('cfg-' + key)
      const value = input.value.trim()
      if (!value) return
      
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value })
      })
      const result = await res.json()
      if (result.success) {
        toggleEdit(key)
        refreshConfig()
      } else {
        alert('Error: ' + result.error)
      }
    }
    
    async function refreshRepo() {
      const data = await api('repo')
      const info = document.getElementById('repo-info')
      
      if (data.error) {
        info.innerHTML = '<p style="color:#ff4444">Error: ' + data.error + '</p>'
        return
      }
      
      const match = data.remote.match(/\\/([^/]+\\/[^/]+)\\.git/)
      const repoName = match ? match[1] : data.remote
      
      info.innerHTML = \`
        <div class="info">
          <div class="name">\${repoName}</div>
          <div class="remote">\${data.remote}</div>
          <div class="commit">\${data.commit}</div>
        </div>
        <div>
          <span class="refresh-info">Branch: \${data.branch}</span>
        </div>
      \`
    }
    
    async function refreshThoughts() {
      const data = await api('thoughts')
      const list = document.getElementById('thoughts-list')
      const stats = document.getElementById('thoughts-stats')
      
      if (data.error) {
        list.innerHTML = '<p style="color:#ff4444">Error: ' + data.error + '</p>'
        return
      }
      
      const openclawCount = data.filter(t => t.metadata?.source === 'openclaw').length
      stats.textContent = \`Total: \${data.length} thoughts | OpenClaw: \${openclawCount} | Other: \${data.length - openclawCount}\`
      
      list.innerHTML = data.slice(0, 20).map(t => \`
        <div class="thought-item">
          <div class="meta">
            <span class="source">\${t.metadata?.source || 'unknown'}</span>
            <span>\${t.metadata?.session_id || ''} | \${new Date(t.created_at).toLocaleString()}</span>
          </div>
          <div class="content">\${(t.content || '').substring(0, 200)}...</div>
        </div>
      \`).join('')
    }
    
    async function searchThoughts() {
      const query = document.getElementById('thought-search').value.trim()
      if (!query) return refreshThoughts()
      
      const data = await api('thoughts/search?q=' + encodeURIComponent(query))
      const list = document.getElementById('thoughts-list')
      const stats = document.getElementById('thoughts-stats')
      
      stats.textContent = \`Semantic search results for "\${query}": \${data.length} found\`
      
      list.innerHTML = data.slice(0, 20).map(t => \`
        <div class="thought-item">
          <div class="meta">
            <span class="source">\${t.metadata?.source || 'unknown'}</span>
            <span>\${new Date(t.created_at).toLocaleString()}</span>
          </div>
          <div class="content">\${(t.content || '').substring(0, 200)}...</div>
        </div>
      \`).join('')
    }
    
    function clearSearch() {
      document.getElementById('thought-search').value = ''
      refreshThoughts()
    }
    
    async function refreshSessions() {
      const data = await api('sessions')
      const list = document.getElementById('sessions-list')
      
      if (data.error) {
        list.innerHTML = '<p style="color:#ff4444">Error: ' + data.error + '</p>'
        return
      }
      
      const synced = data.synced || []
      
      list.innerHTML = data.sessions.map(s => \`
        <div class="session-item">
          <div>
            <div class="id">\${s.id.substring(0, 8)}...</div>
            <div class="details">\${s.messageCount} messages | \${(s.size / 1024).toFixed(1)} KB</div>
          </div>
          <div>
            <span class="\${synced.includes(s.id) ? 'synced' : 'not-synced'}">
              \${synced.includes(s.id) ? '✓ Synced' : '○ Not synced'}
            </span>
          </div>
        </div>
      \`).join('')
    }
    
    async function refreshCron() {
      const data = await api('cron')
      const list = document.getElementById('cron-list')
      
      if (data.error || !data.length) {
        list.innerHTML = '<span style="color:#666">No cron jobs configured</span>'
        return
      }
      
      list.innerHTML = data.map(c => \`<div style="margin-bottom:0.5rem;font-family:monospace;font-size:0.85rem;">\${c}</div>\`).join('')
    }
    
    async function refreshLogs() {
      const data = await api('logs')
      const container = document.getElementById('logs-list')
      
      if (data.error) {
        container.innerHTML = '<p style="color:#ff4444">Error: ' + data.error + '</p>'
        return
      }
      
      container.innerHTML = data.map(log => \`
        <div class="card">
          <h3>\${log.name}</h3>
          <div class="log-viewer">\${log.lines.join('\\n')}</div>
        </div>
      \`).join('')
    }
    
    refreshServices()
  </script>
</body>
</html>`

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT)
  
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }
  
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(HTML)
    return
  }
  
  if (url.pathname.startsWith('/api/')) {
    const endpoint = url.pathname.slice(5)
    let result = null
    
    try {
      if (endpoint === 'services') {
        result = await getServices()
      } else if (endpoint === 'config') {
        result = await getBrainAgentConfig()
      } else if (endpoint === 'repo') {
        result = await getRepo()
      } else if (endpoint === 'sessions') {
        const sessions = await getSessions()
        const synced = await getSyncedSessions()
        result = { sessions, synced }
      } else if (endpoint === 'thoughts') {
        const limit = parseInt(url.searchParams.get('limit') || '50')
        const offset = parseInt(url.searchParams.get('offset') || '0')
        result = await getThoughts(limit, offset)
      } else if (endpoint === 'thoughts/search') {
        const q = url.searchParams.get('q') || ''
        result = await searchThoughts(q)
      } else if (endpoint === 'cron') {
        result = await getCronJobs()
      } else if (endpoint === 'logs') {
        result = await getLogs()
      } else if (endpoint === 'config' && req.method === 'POST') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        await new Promise(resolve => req.on('end', resolve))
        const { key, value } = JSON.parse(body)
        result = await updateBrainAgentConfig(key, value)
      } else {
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'Not found' }))
        return
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (e) {
      log('API error for ' + endpoint + ': ' + e.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e.message }))
    }
    return
  }
  
  res.writeHead(404)
  res.end('Not found')
})

server.listen(PORT, '0.0.0.0', () => {
  log('Brain Dashboard running on http://0.0.0.0:' + PORT)
  log('Access via Tailscale at http://100.66.248.120:' + PORT)
})