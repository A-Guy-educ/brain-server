#!/usr/bin/env node
/**
 * Brain Dashboard - Modern, intuitive web UI
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const PORT = process.env.DASHBOARD_PORT || 4103
const SUPABASE_URL = 'https://jmdccivoxtiumrpsujwg.supabase.co'
const SUPABASE_KEY = 'sb_publishable_HM54ruiE3qcxGwBkUx2xyw_MBLYOW6r'
const BRAIN_AGENT_DIR = '/opt/brain-server'
const SESSIONS_DIR = '/root/.openclaw/agents/main/sessions'
const SESSIONS_MARKER = '/root/.openclaw/agents/main/.synced_sessions'

function log(msg) {
  console.log(`[dashboard] ${new Date().toISOString()} ${msg}`)
}

function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = require('https').request(options, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode, data }))
    })
    req.on('error', reject)
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')) })
    if (body) req.write(body)
    req.end()
  })
}

async function getServices() {
  const services = []
  
  const checkPort = (port, name) => new Promise(resolve => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/', method: 'GET' }, res => {
      services.push({ name, port, status: 'up' })
      resolve()
    })
    req.on('error', () => { services.push({ name, port, status: 'down' }); resolve() })
    req.setTimeout(2000, () => { services.push({ name, port, status: 'down' }); resolve() })
    req.end()
  })
  
  await Promise.all([
    checkPort(4099, 'Brain Agent'),
    checkPort(4097, 'Context+'),
    checkPort(18789, 'OpenClaw'),
  ])
  
  try {
    const docker = execSync('docker ps --format "{{.Names}}" 2>/dev/null', { encoding: 'utf8' })
    const containers = docker.trim().split('\n').filter(Boolean)
    services.push({ name: 'Docker', port: null, status: 'up', info: containers.length + ' containers' })
  } catch { services.push({ name: 'Docker', port: null, status: 'down' }) }
  
  return services
}

async function getConfig() {
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
          const isSecret = key.includes('KEY') || key.includes('SECRET') || key.includes('PASSWORD') || key.includes('TOKEN')
          config[key] = { value: isSecret ? '••••••••' : value, secret: isSecret }
        }
      })
    }
  } catch (e) {}
  return config
}

async function updateConfig(key, value) {
  try {
    const envPath = path.join(BRAIN_AGENT_DIR, '.env')
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
    const lines = content.split('\n')
    let found = false
    const newLines = lines.map(line => {
      if (line.startsWith(key + '=')) { found = true; return key + '=' + value }
      return line
    })
    if (!found) newLines.push(key + '=' + value)
    fs.writeFileSync(envPath, newLines.join('\n'))
    return { success: true }
  } catch (e) { return { success: false, error: e.message } }
}

async function getThoughts(limit = 20) {
  try {
    const res = await httpsRequest({
      hostname: new URL(SUPABASE_URL).hostname,
      port: 443,
      path: `/rest/v1/thoughts?select=id,content,metadata,created_at&order=created_at.desc&limit=${limit}`,
      method: 'GET',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    })
    return JSON.parse(res.data)
  } catch (e) { log('Thoughts error: ' + e.message); return [] }
}

async function deleteThought(id) {
  try {
    const res = await httpsRequest({
      hostname: new URL(SUPABASE_URL).hostname,
      port: 443,
      path: `/rest/v1/thoughts?id=eq.${id}`,
      method: 'DELETE',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'return=minimal' }
    })
    return { success: res.status === 204 }
  } catch (e) { return { success: false, error: e.message } }
}

async function searchThoughts(query) {
  try {
    const embedRes = await httpsRequest({
      hostname: 'openrouter.ai', port: 443, path: '/api/v1/embeddings', method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      body: JSON.stringify({ model: 'text-embedding-ada-002', input: query.substring(0, 8000) })
    })
    const embedding = JSON.parse(embedRes.data).data?.[0]?.embedding
    if (!embedding) return []
    
    const res = await httpsRequest({
      hostname: new URL(SUPABASE_URL).hostname, port: 443,
      path: '/rest/v1/rpc/match_thoughts', method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ query_embedding: embedding, match_threshold: 0.5, match_count: 10 })
    })
    return JSON.parse(res.data)
  } catch (e) { log('Search error: ' + e.message); return [] }
}

async function getSessions() {
  try {
    const synced = fs.existsSync(SESSIONS_MARKER) 
      ? fs.readFileSync(SESSIONS_MARKER, 'utf8').trim().split('\n') 
      : []
    if (!fs.existsSync(SESSIONS_DIR)) return []
    return fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const id = f.replace('.jsonl', '')
        const stats = fs.statSync(path.join(SESSIONS_DIR, f))
        return { id, file: f, synced: synced.includes(id), size: stats.size, updated: stats.mtime }
      })
  } catch (e) { return [] }
}

async function getCron() {
  try {
    return execSync('crontab -l 2>/dev/null', { encoding: 'utf8' }).split('\n').filter(l => l.trim() && !l.startsWith('#'))
  } catch { return [] }
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Brain Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0a0a0f;
      --surface: #141419;
      --surface2: #1e1e24;
      --border: #2a2a35;
      --text: #e4e4e7;
      --text-dim: #71717a;
      --accent: #6366f1;
      --accent-hover: #818cf8;
      --success: #22c55e;
      --danger: #ef4444;
      --warning: #f59e0b;
    }
    body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
    .sidebar { position: fixed; width: 240px; height: 100vh; background: var(--surface); border-right: 1px solid var(--border); padding: 1.5rem; }
    .logo { font-size: 1.25rem; font-weight: 700; color: var(--accent); margin-bottom: 2rem; display: flex; align-items: center; gap: 0.5rem; }
    .nav-item { display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem 1rem; border-radius: 8px; color: var(--text-dim); cursor: pointer; transition: all 0.2s; margin-bottom: 0.25rem; }
    .nav-item:hover { background: var(--surface2); color: var(--text); }
    .nav-item.active { background: var(--accent); color: white; }
    .nav-item svg { width: 20px; height: 20px; }
    .main { margin-left: 240px; padding: 2rem; min-height: 100vh; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
    .header h1 { font-size: 1.5rem; font-weight: 600; }
    .badge { background: var(--surface2); padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.75rem; }
    .badge.success { background: rgba(34,197,94,0.2); color: var(--success); }
    .badge.danger { background: rgba(239,68,68,0.2); color: var(--danger); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; }
    .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
    .card-title { font-weight: 600; font-size: 0.9rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; }
    .btn { padding: 0.5rem 1rem; background: var(--accent); border: none; border-radius: 6px; color: white; cursor: pointer; font-size: 0.875rem; font-weight: 500; transition: background 0.2s; }
    .btn:hover { background: var(--accent-hover); }
    .btn.ghost { background: transparent; color: var(--text-dim); }
    .btn.ghost:hover { background: var(--surface2); color: var(--text); }
    .btn.danger { background: var(--danger); }
    .btn.danger:hover { background: #dc2626; }
    .service-row { display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 0; border-bottom: 1px solid var(--border); }
    .service-row:last-child { border-bottom: none; }
    .service-name { font-weight: 500; }
    .service-port { color: var(--text-dim); font-size: 0.85rem; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--danger); }
    .status-dot.up { background: var(--success); }
    .config-list { display: flex; flex-direction: column; gap: 0.5rem; }
    .config-item { display: flex; justify-content: space-between; align-items: center; padding: 0.75rem; background: var(--surface2); border-radius: 8px; }
    .config-key { font-family: monospace; font-size: 0.85rem; color: var(--accent); }
    .config-value { font-family: monospace; font-size: 0.85rem; color: var(--text-dim); max-width: 300px; overflow: hidden; text-overflow: ellipsis; }
    .thought-item { padding: 1rem; background: var(--surface2); border-radius: 8px; margin-bottom: 0.5rem; }
    .thought-meta { display: flex; justify-content: space-between; font-size: 0.75rem; color: var(--text-dim); margin-bottom: 0.5rem; }
    .thought-content { font-size: 0.9rem; line-height: 1.5; color: var(--text); }
    .thought-actions { display: flex; gap: 0.5rem; margin-top: 0.75rem; }
    .search-box { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
    .search-input { flex: 1; padding: 0.75rem 1rem; background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-size: 0.9rem; }
    .search-input:focus { outline: none; border-color: var(--accent); }
    .section { display: none; }
    .section.active { display: block; }
    .empty { text-align: center; padding: 3rem; color: var(--text-dim); }
    .empty svg { width: 48px; height: 48px; margin-bottom: 1rem; opacity: 0.5; }
    .modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.8); z-index: 100; align-items: center; justify-content: center; }
    .modal.active { display: flex; }
    .modal-content { background: var(--surface); border-radius: 12px; padding: 2rem; width: 100%; max-width: 500px; }
    .modal-title { font-size: 1.25rem; font-weight: 600; margin-bottom: 1.5rem; }
    .form-group { margin-bottom: 1rem; }
    .form-label { display: block; font-size: 0.85rem; color: var(--text-dim); margin-bottom: 0.5rem; }
    .form-input { width: 100%; padding: 0.75rem; background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-size: 0.9rem; }
    .form-input:focus { outline: none; border-color: var(--accent); }
    .modal-actions { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1.5rem; }
    .toast { position: fixed; bottom: 2rem; right: 2rem; background: var(--surface); border: 1px solid var(--accent); padding: 1rem 1.5rem; border-radius: 8px; font-size: 0.9rem; opacity: 0; transform: translateY(1rem); transition: all 0.3s; }
    .toast.show { opacity: 1; transform: translateY(0); }
    .toast.error { border-color: var(--danger); }
  </style>
</head>
<body>
  <nav class="sidebar">
    <div class="logo">🧠 Brain</div>
    <div class="nav-item active" data-section="overview">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x=3 y=3 width=7 height=7 rx=1/><rect x=14 y=3 width=7 height=7 rx=1/><rect x=3 y=14 width=7 height=7 rx=1/><rect x=14 y=14 width=7 height=7 rx=1/></svg>
      Overview
    </div>
    <div class="nav-item" data-section="thoughts">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 10 10H12V2z"/><path d="M12 2v10h10"/></svg>
      OB1 Brain
    </div>
    <div class="nav-item" data-section="config">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx=12 cy=12 r=3/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
      Settings
    </div>
  </nav>

  <main class="main">
    <section id="overview" class="section active">
      <div class="header">
        <h1>Overview</h1>
        <button class="btn" onclick="refresh()">Refresh</button>
      </div>
      <div class="grid" id="services-grid"></div>
    </section>

    <section id="thoughts" class="section">
      <div class="header">
        <h1>OB1 Brain</h1>
        <button class="btn" onclick="loadThoughts()">Refresh</button>
      </div>
      <div class="search-box">
        <input type="text" class="search-input" id="search-input" placeholder="Search memories..." onkeydown="if(event.key==='Enter')doSearch()">
        <button class="btn" onclick="doSearch()">Search</button>
      </div>
      <div id="thoughts-list"></div>
    </section>

    <section id="config" class="section">
      <div class="header">
        <h1>Settings</h1>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">Environment Variables</span>
          <button class="btn" onclick="showAddModal()">Add New</button>
        </div>
        <div id="config-list" class="config-list"></div>
      </div>
    </section>
  </main>

  <div id="edit-modal" class="modal">
    <div class="modal-content">
      <div class="modal-title">Edit Variable</div>
      <div class="form-group">
        <label class="form-label">Key</label>
        <input type="text" class="form-input" id="edit-key" readonly>
      </div>
      <div class="form-group">
        <label class="form-label">Value</label>
        <input type="text" class="form-input" id="edit-value">
      </div>
      <div class="modal-actions">
        <button class="btn ghost" onclick="closeModal()">Cancel</button>
        <button class="btn" onclick="saveEdit()">Save</button>
      </div>
    </div>
  </div>

  <div id="add-modal" class="modal">
    <div class="modal-content">
      <div class="modal-title">Add Variable</div>
      <div class="form-group">
        <label class="form-label">Key</label>
        <input type="text" class="form-input" id="add-key" placeholder="MY_VARIABLE">
      </div>
      <div class="form-group">
        <label class="form-label">Value</label>
        <input type="text" class="form-input" id="add-value" placeholder="my_value">
      </div>
      <div class="modal-actions">
        <button class="btn ghost" onclick="closeModal()">Cancel</button>
        <button class="btn" onclick="saveAdd()">Add</button>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    let config = {}
    
    function toast(msg, isError = false) {
      const t = document.getElementById('toast')
      t.textContent = msg
      t.className = 'toast' + (isError ? ' error' : '')
      t.classList.add('show')
      setTimeout(() => t.classList.remove('show'), 3000)
    }

    function showSection(id) {
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'))
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'))
      document.getElementById(id).classList.add('active')
      document.querySelector('[data-section=' + id + ']').classList.add('active')
      if (id === 'overview') loadOverview()
      if (id === 'thoughts') loadThoughts()
      if (id === 'config') loadConfig()
    }

    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => showSection(item.dataset.section))
    })

    async function api(path, method = 'GET', body = null) {
      try {
        const res = await fetch('/api/' + path, method !== 'GET' ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
        return await res.json()
      } catch (e) { return { error: e.message } }
    }

    async function loadOverview() {
      const services = await api('services')
      const grid = document.getElementById('services-grid')
      if (!services.length) { grid.innerHTML = '<div class="empty">No services found</div>'; return }
      grid.innerHTML = services.map(s => \`
        <div class="card">
          <div class="card-header">
            <span class="card-title">\${s.name}</span>
            <span class="badge \${s.status === 'up' ? 'success' : 'danger'}">\${s.status}</span>
          </div>
          <div style="color: var(--text-dim); font-size: 0.85rem;">
            \${s.port ? 'Port ' + s.port : ''} \${s.info || ''}
          </div>
        </div>
      \`).join('')
    }

    async function loadThoughts() {
      const thoughts = await api('thoughts')
      const list = document.getElementById('thoughts-list')
      if (!thoughts.length) { list.innerHTML = '<div class="empty"><div>No memories yet</div></div>'; return }
      list.innerHTML = thoughts.map(t => \`
        <div class="thought-item">
          <div class="thought-meta">
            <span>\${t.metadata?.source || 'unknown'} • \${new Date(t.created_at).toLocaleDateString()}</span>
            <span>\${(t.content || '').length} chars</span>
          </div>
          <div class="thought-content">\${(t.content || '').substring(0, 300)}\${(t.content || '').length > 300 ? '...' : ''}</div>
          <div class="thought-actions">
            <button class="btn ghost danger" onclick="deleteThought('\${t.id}')">Delete</button>
          </div>
        </div>
      \`).join('')
    }

    async function deleteThought(id) {
      if (!confirm('Delete this memory?')) return
      const res = await api('thoughts/' + id, 'DELETE')
      if (res.success) { toast('Deleted'); loadThoughts() }
      else toast(res.error || 'Failed', true)
    }

    async function doSearch() {
      const q = document.getElementById('search-input').value.trim()
      if (!q) return loadThoughts()
      const results = await api('thoughts/search?q=' + encodeURIComponent(q))
      const list = document.getElementById('thoughts-list')
      if (!results.length) { list.innerHTML = '<div class="empty"><div>No results</div></div>'; return }
      list.innerHTML = results.map(t => \`
        <div class="thought-item">
          <div class="thought-meta">
            <span>\${t.metadata?.source || 'unknown'}</span>
          </div>
          <div class="thought-content">\${(t.content || '').substring(0, 300)}...</div>
        </div>
      \`).join('')
    }

    async function loadConfig() {
      config = await api('config')
      const list = document.getElementById('config-list')
      const entries = Object.entries(config)
      if (!entries.length) { list.innerHTML = '<div class="empty">No configuration</div>'; return }
      list.innerHTML = entries.map(([key, data]) => \`
        <div class="config-item">
          <span class="config-key">\${key}</span>
          <span class="config-value">\${typeof data === 'object' ? data.value : data}</span>
          <button class="btn ghost" onclick="editConfig('\${key}')">Edit</button>
        </div>
      \`).join('')
    }

    function editConfig(key) {
      document.getElementById('edit-key').value = key
      document.getElementById('edit-value').value = typeof config[key] === 'object' ? config[key].value : config[key]
      document.getElementById('edit-modal').classList.add('active')
    }

    function showAddModal() {
      document.getElementById('add-key').value = ''
      document.getElementById('add-value').value = ''
      document.getElementById('add-modal').classList.add('active')
    }

    function closeModal() {
      document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'))
    }

    async function saveEdit() {
      const key = document.getElementById('edit-key').value
      const value = document.getElementById('edit-value').value
      const res = await api('config', 'POST', { key, value })
      if (res.success) { toast('Saved'); closeModal(); loadConfig() }
      else toast(res.error || 'Failed', true)
    }

    async function saveAdd() {
      const key = document.getElementById('add-key').value.trim()
      const value = document.getElementById('add-value').value
      if (!key) return toast('Key required', true)
      const res = await api('config', 'POST', { key, value })
      if (res.success) { toast('Added'); closeModal(); loadConfig() }
      else toast(res.error || 'Failed', true)
    }

    async function refresh() {
      if (document.getElementById('overview').classList.contains('active')) loadOverview()
      if (document.getElementById('thoughts').classList.contains('active')) loadThoughts()
    }

    loadOverview()
  </script>
</body>
</html>`

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT)
  
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return }
  
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(HTML)
    return
  }
  
  if (url.pathname.startsWith('/api/')) {
    const endpoint = url.pathname.slice(5)
    let result = null
    
    try {
      if (endpoint === 'services') result = await getServices()
      else if (endpoint === 'config') result = await getConfig()
      else if (endpoint === 'thoughts') result = await getThoughts()
      else if (endpoint === 'thoughts/search') {
        const q = url.searchParams.get('q') || ''
        result = await searchThoughts(q)
      }
      else if (endpoint.match(/^thoughts\/[\w-]+$/) && req.method === 'DELETE') {
        const id = endpoint.split('/')[1]
        result = await deleteThought(id)
      }
      else if (endpoint === 'config' && req.method === 'POST') {
        let body = ''
        req.on('data', c => body += c)
        await new Promise(r => req.on('end', r))
        const { key, value } = JSON.parse(body)
        result = await updateConfig(key, value)
      }
      else { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return }
      
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (e) {
      log('API error: ' + e.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e.message }))
    }
    return
  }
  
  res.writeHead(404)
  res.end('Not found')
})

server.listen(PORT, '0.0.0.0', () => {
  log('Dashboard running on port ' + PORT)
})