#!/usr/bin/env node
/**
 * CronSentinel mock backend — Node.js, zero dependencies.
 * Implements every API endpoint the frontend calls so the UI is fully functional.
 * Run:  node mock-backend.js
 */

const http = require('http')
const os = require('os')
const { execSync } = require('child_process')
const { randomUUID } = require('crypto')
const PORT = 8080

// ── In-memory stores ────────────────────────────────────────────────────────

let scripts = [
  { name: 'health-check', content: '#!/usr/bin/env bash\ncurl -sf http://localhost:8080/healthz', created_at: new Date().toISOString() },
  { name: 'cleanup-logs', content: '#!/usr/bin/env bash\nfind /tmp -name "*.log" -mtime +7 -delete', created_at: new Date().toISOString() },
]

let jobs = [
  {
    id: randomUUID(), name: 'Health Check', schedule: '*/5 * * * *',
    working_directory: '', command: 'echo "health ok"',
    comment: 'Runs every 5 minutes', logging_enabled: true, timeout_seconds: 30,
    created_at: new Date().toISOString(),
  },
  {
    id: randomUUID(), name: 'Daily Backup', schedule: '0 2 * * *',
    working_directory: '', command: 'echo "backup complete"',
    comment: 'Runs at 2 AM daily', logging_enabled: true, timeout_seconds: 300,
    created_at: new Date().toISOString(),
  },
]

let runs = [
  {
    id: randomUUID(), job_id: jobs[0].id, job_name: 'Health Check',
    command: 'echo "health ok"', status: 'success', exit_code: 0,
    stdout: 'health ok\n', stderr: '',
    started_at: new Date(Date.now() - 60000).toISOString(),
    ended_at: new Date(Date.now() - 59000).toISOString(),
    failure_reason: '', failure_fix: '',
  },
  {
    id: randomUUID(), job_id: jobs[1].id, job_name: 'Daily Backup',
    command: 'echo "backup complete"', status: 'success', exit_code: 0,
    stdout: 'backup complete\n', stderr: '',
    started_at: new Date(Date.now() - 3600000).toISOString(),
    ended_at: new Date(Date.now() - 3599000).toISOString(),
    failure_reason: '', failure_fix: '',
  },
  {
    id: randomUUID(), job_id: jobs[0].id, job_name: 'Health Check',
    command: 'echo "health ok"', status: 'failure', exit_code: 1,
    stdout: '', stderr: 'command not found: eccho\n',
    started_at: new Date(Date.now() - 120000).toISOString(),
    ended_at: new Date(Date.now() - 119000).toISOString(),
    failure_reason: 'Command not found',
    failure_fix: 'Install the missing command or add it to PATH in the script',
  },
]

// SSE subscribers: runId -> [res, ...]
const subscribers = {}

// ── Helpers ─────────────────────────────────────────────────────────────────

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function json(res, code, body) {
  cors(res)
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => (data += chunk))
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) }
      catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function publish(runId, msg) {
  const subs = subscribers[runId] || []
  for (const res of subs) {
    try { res.write(`data: ${JSON.stringify(msg)}\n\n`) } catch (_) {}
  }
}

function getDiskStats() {
  try {
    // POSIX output: Filesystem 1024-blocks Used Available Capacity Mounted on
    const output = execSync('df -P -k /', { encoding: 'utf8' })
    const lines = output.trim().split('\n')
    if (lines.length < 2) return []
    const parts = lines[1].trim().split(/\s+/)
    // Expected columns; tolerate slight platform differences.
    const mountpoint = parts[parts.length - 1] || '/'
    const usedPctRaw = parts[4] || '0%'
    const usedPercent = Number.parseFloat(String(usedPctRaw).replace('%', ''))
    return [{ path: mountpoint, used_percent: Number.isFinite(usedPercent) ? usedPercent : 0 }]
  } catch {
    return []
  }
}

function simulateRun(runId, command) {
  const lines = [
    `$ ${command}`,
    'Starting execution…',
    'Processing…',
    Math.random() > 0.2 ? 'Done.' : 'Error: simulated failure',
  ]
  let i = 0
  const iv = setInterval(() => {
    if (i < lines.length) {
      publish(runId, { status: 'running', stream: 'stdout', line: lines[i++] })
    } else {
      clearInterval(iv)
      const success = Math.random() > 0.15
      const run = runs.find(r => r.id === runId)
      if (run) {
        run.status = success ? 'success' : 'failure'
        run.exit_code = success ? 0 : 1
        run.stdout = lines.join('\n') + '\n'
        run.ended_at = new Date().toISOString()
        if (!success) {
          run.failure_reason = 'Non-zero exit code'
          run.failure_fix = 'Inspect stderr logs and add validation or guard clauses'
        }
      }
      publish(runId, { status: run?.status ?? 'success', stdout: run?.stdout ?? '', stderr: '' })
      delete subscribers[runId]
    }
  }, 400)
}

// ── Router ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname
  const method = req.method

  // Preflight
  if (method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return }

  console.log(`${method} ${path}`)

  // ── Health ──────────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/healthz') {
    return json(res, 200, { ok: true })
  }

  // ── System info ─────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/system') {
    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    const usedMem = totalMem - freeMem
    const load = os.loadavg()
    return json(res, 200, {
      uptime_seconds: Math.floor(os.uptime()),
      cpu_count: os.cpus().length,
      memory: {
        total: totalMem,
        used: usedMem,
        usedPercent: totalMem > 0 ? (usedMem / totalMem) * 100 : 0,
      },
      load: { load1: load[0] ?? 0, load5: load[1] ?? 0, load15: load[2] ?? 0 },
      disks: getDiskStats(),
      gpu: 'unavailable in node mock backend',
    })
  }

  // ── Scripts ─────────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/scripts') {
    return json(res, 200, scripts)
  }

  if (method === 'POST' && path === '/api/scripts') {
    let body
    try { body = await readBody(req) } catch { return json(res, 400, { error: 'invalid JSON' }) }
    const name = (body.name || '').trim()
    const content = (body.content || '').trim()
    if (!name) return json(res, 400, { error: 'script name is required' })
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) return json(res, 400, { error: 'script name must only contain letters, digits, dots, hyphens, or underscores' })
    if (!content) return json(res, 400, { error: 'script content is required' })
    const idx = scripts.findIndex(s => s.name === name)
    if (idx >= 0) scripts[idx] = { name, content, created_at: scripts[idx].created_at }
    else scripts.unshift({ name, content, created_at: new Date().toISOString() })
    return json(res, 201, { ok: true })
  }

  const scriptDeleteMatch = path.match(/^\/api\/scripts\/(.+)$/)
  if (method === 'DELETE' && scriptDeleteMatch) {
    const name = decodeURIComponent(scriptDeleteMatch[1])
    scripts = scripts.filter(s => s.name !== name)
    return json(res, 200, { ok: true })
  }

  // ── Jobs ────────────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/jobs') {
    return json(res, 200, jobs)
  }

  if (method === 'GET' && path === '/api/jobs/presets') {
    return json(res, 200, [
      { label: 'Every minute',        schedule: '* * * * *'   },
      { label: 'Every 5 minutes',     schedule: '*/5 * * * *' },
      { label: 'Hourly',              schedule: '0 * * * *'   },
      { label: 'Daily at midnight',   schedule: '0 0 * * *'   },
      { label: 'Weekly (Sun midnight)', schedule: '0 0 * * 0' },
    ])
  }

  if (method === 'POST' && path === '/api/jobs') {
    let body
    try { body = await readBody(req) } catch { return json(res, 400, { error: 'invalid JSON' }) }
    const name = (body.name || '').trim()
    const command = (body.command || '').trim()
    const schedule = (body.schedule || '').trim()
    if (!name) return json(res, 400, { error: 'job name is required' })
    if (!command) return json(res, 400, { error: 'command is required' })
    if ((schedule.match(/\S+/g) || []).length !== 5) return json(res, 400, { error: 'invalid cron schedule — must be exactly 5 space-separated fields' })
    jobs.unshift({
      id: randomUUID(), name, schedule,
      working_directory: body.working_directory || '',
      command, comment: body.comment || '',
      logging_enabled: body.logging_enabled !== false,
      timeout_seconds: body.timeout_seconds > 0 ? body.timeout_seconds : 300,
      created_at: new Date().toISOString(),
    })
    return json(res, 201, { ok: true })
  }

  const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/)
  if (method === 'DELETE' && jobMatch) {
    const id = decodeURIComponent(jobMatch[1])
    const before = jobs.length
    jobs = jobs.filter(j => j.id !== id)
    if (jobs.length === before) return json(res, 404, { error: 'job not found' })
    return json(res, 200, { ok: true })
  }

  const runJobMatch = path.match(/^\/api\/jobs\/([^/]+)\/run$/)
  if (method === 'POST' && runJobMatch) {
    const id = decodeURIComponent(runJobMatch[1])
    const job = jobs.find(j => j.id === id)
    if (!job) return json(res, 404, { error: 'job not found' })
    const runId = randomUUID()
    const run = {
      id: runId, job_id: job.id, job_name: job.name,
      command: job.command, status: 'running', exit_code: null,
      stdout: '', stderr: '',
      started_at: new Date().toISOString(), ended_at: null,
      failure_reason: '', failure_fix: '',
    }
    runs.unshift(run)
    setTimeout(() => simulateRun(runId, job.command), 50)
    return json(res, 202, { status: 'started_in_background', run_id: runId })
  }

  // ── Runs ────────────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/runs') {
    return json(res, 200, runs.slice(0, 100))
  }

  const logsMatch = path.match(/^\/api\/runs\/([^/]+)\/logs$/)
  if (method === 'GET' && logsMatch) {
    const run = runs.find(r => r.id === logsMatch[1])
    if (!run) return json(res, 404, { error: 'run not found' })
    return json(res, 200, { stdout: run.stdout, stderr: run.stderr })
  }

  const streamMatch = path.match(/^\/api\/runs\/([^/]+)\/stream$/)
  if (method === 'GET' && streamMatch) {
    const runId = streamMatch[1]
    cors(res)
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })
    res.write(': connected\n\n')
    if (!subscribers[runId]) subscribers[runId] = []
    subscribers[runId].push(res)
    req.on('close', () => {
      if (subscribers[runId]) subscribers[runId] = subscribers[runId].filter(r => r !== res)
    })
    return
  }

  json(res, 404, { error: 'not found' })
})

server.listen(PORT, () => {
  console.log(`\n  CronSentinel mock backend running`)
  console.log(`  http://localhost:${PORT}/healthz\n`)
})
