#!/usr/bin/env node
/**
 * CronSentinel mock backend — Node.js with built-in SQLite (node:sqlite, v22+).
 * All jobs, scripts and run history are persisted to ./cronsentinel.db.
 * Run:  node mock-backend.js
 */

// Suppress the experimental SQLite warning
process.removeAllListeners('warning')

const http      = require('http')
const os        = require('os')
const path      = require('path')
const { execSync, spawn } = require('child_process')
const { randomUUID }      = require('crypto')
const readline  = require('readline')
const { DatabaseSync }    = require('node:sqlite')

const PORT   = 8080
const DB_PATH = path.join(__dirname, 'cronsentinel.db')

// ── Database setup ───────────────────────────────────────────────────────────

const db = new DatabaseSync(DB_PATH)

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS scripts (
    name        TEXT PRIMARY KEY,
    content     TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    schedule            TEXT NOT NULL,
    timezone            TEXT NOT NULL DEFAULT 'Local',
    command             TEXT NOT NULL,
    working_directory   TEXT NOT NULL DEFAULT '',
    venv_path           TEXT NOT NULL DEFAULT '',
    comment             TEXT NOT NULL DEFAULT '',
    logging_enabled     INTEGER NOT NULL DEFAULT 1,
    timeout_seconds     INTEGER NOT NULL DEFAULT 300,
    created_at          TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runs (
    id              TEXT PRIMARY KEY,
    job_id          TEXT,
    job_name        TEXT NOT NULL,
    command         TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'running',
    exit_code       INTEGER,
    stdout          TEXT NOT NULL DEFAULT '',
    stderr          TEXT NOT NULL DEFAULT '',
    started_at      TEXT NOT NULL,
    ended_at        TEXT,
    failure_reason  TEXT NOT NULL DEFAULT '',
    failure_fix     TEXT NOT NULL DEFAULT ''
  );
`)

try { db.exec(`ALTER TABLE jobs ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Local';`) } catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      smtp_host TEXT NOT NULL DEFAULT '',
      smtp_port INTEGER NOT NULL DEFAULT 587,
      smtp_username TEXT NOT NULL DEFAULT '',
      smtp_password TEXT NOT NULL DEFAULT '',
      smtp_tls INTEGER NOT NULL DEFAULT 1,
      from_address TEXT NOT NULL DEFAULT '',
      to_addresses TEXT NOT NULL DEFAULT '',
      notify_scheduled_success INTEGER NOT NULL DEFAULT 0,
      notify_scheduled_failure INTEGER NOT NULL DEFAULT 0,
      notify_manual_success INTEGER NOT NULL DEFAULT 0,
      notify_manual_failure INTEGER NOT NULL DEFAULT 0
    );
  `)
  db.prepare('INSERT OR IGNORE INTO notification_settings (id) VALUES (1)').run()
} catch (_) {}

try { db.exec(`ALTER TABLE notification_settings ADD COLUMN notify_heartbeat_missed INTEGER NOT NULL DEFAULT 0`) } catch (_) {}

try { db.exec(`ALTER TABLE jobs ADD COLUMN heartbeat_token TEXT`) } catch (_) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN heartbeat_grace_seconds INTEGER NOT NULL DEFAULT 300`) } catch (_) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN last_heartbeat_at TEXT`) } catch (_) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN last_heartbeat_alert_at TEXT`) } catch (_) {}
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS heartbeat_pings (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      received_at TEXT NOT NULL,
      client_ip TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS heartbeat_pings_job_received_idx ON heartbeat_pings (job_id, received_at DESC);
  `)
} catch (_) {}
try {
  db.exec(`UPDATE jobs SET heartbeat_token = lower(hex(randomblob(16))) || lower(hex(randomblob(16)))
            WHERE heartbeat_token IS NULL OR heartbeat_token = ''`)
} catch (_) {}

const notifGet = db.prepare('SELECT * FROM notification_settings WHERE id = 1')
const notifUpdate = db.prepare(`UPDATE notification_settings SET
  enabled=?, smtp_host=?, smtp_port=?, smtp_username=?, smtp_password=?, smtp_tls=?,
  from_address=?, to_addresses=?, notify_scheduled_success=?, notify_scheduled_failure=?,
  notify_manual_success=?, notify_manual_failure=?, notify_heartbeat_missed=? WHERE id=1`)

// Seed default data on first run (empty DB)
const jobCount = db.prepare('SELECT COUNT(*) AS n FROM jobs').get()
if (jobCount.n === 0) {
  const id1 = randomUUID()
  const id2 = randomUUID()
  const now  = new Date().toISOString()

  const hb1 = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
  const hb2 = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
  db.prepare(`INSERT INTO jobs (id,name,schedule,timezone,command,comment,logging_enabled,timeout_seconds,created_at,heartbeat_token,heartbeat_grace_seconds)
              VALUES (?,?,?,?,?,?,1,30,?,?,300)`).run(id1, 'Health Check',  '*/5 * * * *', 'Local', 'echo "health ok"',    'Runs every 5 minutes', now, hb1)
  db.prepare(`INSERT INTO jobs (id,name,schedule,timezone,command,comment,logging_enabled,timeout_seconds,created_at,heartbeat_token,heartbeat_grace_seconds)
              VALUES (?,?,?,?,?,?,1,300,?,?,300)`).run(id2, 'Daily Backup', '0 2 * * *',   'Local', 'echo "backup complete"', 'Runs at 2 AM daily',   now, hb2)

  const r1 = randomUUID(), r2 = randomUUID(), r3 = randomUUID()
  const t  = Date.now()
  db.prepare(`INSERT INTO runs (id,job_id,job_name,command,status,exit_code,stdout,stderr,started_at,ended_at,failure_reason,failure_fix)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    r1, id1, 'Health Check', 'echo "health ok"', 'success', 0,
    'health ok\n', '', new Date(t - 60000).toISOString(), new Date(t - 59000).toISOString(), '', '')
  db.prepare(`INSERT INTO runs (id,job_id,job_name,command,status,exit_code,stdout,stderr,started_at,ended_at,failure_reason,failure_fix)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    r2, id2, 'Daily Backup', 'echo "backup complete"', 'success', 0,
    'backup complete\n', '', new Date(t - 3600000).toISOString(), new Date(t - 3599000).toISOString(), '', '')
  db.prepare(`INSERT INTO runs (id,job_id,job_name,command,status,exit_code,stdout,stderr,started_at,ended_at,failure_reason,failure_fix)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    r3, id1, 'Health Check', 'echo "health ok"', 'failure', 1,
    '', 'command not found: eccho\n', new Date(t - 120000).toISOString(), new Date(t - 119000).toISOString(),
    'Command not found', 'Install the missing command or add it to PATH')

  db.prepare(`INSERT INTO scripts (name,content,created_at) VALUES (?,?,?)`).run(
    'health-check', '#!/usr/bin/env bash\ncurl -sf http://localhost:8080/healthz', now)
  db.prepare(`INSERT INTO scripts (name,content,created_at) VALUES (?,?,?)`).run(
    'cleanup-logs', '#!/usr/bin/env bash\nfind /tmp -name "*.log" -mtime +7 -delete', now)
}

// ── Prepared statements ──────────────────────────────────────────────────────

const stmts = {
  allJobs:        db.prepare('SELECT * FROM jobs ORDER BY created_at DESC'),
  jobById:        db.prepare('SELECT * FROM jobs WHERE id = ?'),
  jobByHeartbeat: db.prepare('SELECT * FROM jobs WHERE heartbeat_token = ?'),
  insertJob:      db.prepare(`INSERT INTO jobs (id,name,schedule,timezone,command,working_directory,venv_path,comment,logging_enabled,timeout_seconds,created_at,heartbeat_token,heartbeat_grace_seconds)
                              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  updateJob:      db.prepare(`UPDATE jobs SET name=?,schedule=?,timezone=?,command=?,working_directory=?,venv_path=?,comment=?,logging_enabled=?,timeout_seconds=?,heartbeat_grace_seconds=? WHERE id=?`),
  insertPing:     db.prepare(`INSERT INTO heartbeat_pings (id,job_id,client_ip,payload,received_at) VALUES (?,?,?,?,?)`),
  touchHeartbeat: db.prepare(`UPDATE jobs SET last_heartbeat_at=?, last_heartbeat_alert_at=NULL WHERE id=?`),
  deleteJob:     db.prepare('DELETE FROM jobs WHERE id = ?'),

  allScripts:    db.prepare('SELECT * FROM scripts ORDER BY created_at DESC'),
  upsertScript:  db.prepare(`INSERT INTO scripts (name,content,created_at) VALUES (?,?,?)
                              ON CONFLICT(name) DO UPDATE SET content=excluded.content`),
  deleteScript:  db.prepare('DELETE FROM scripts WHERE name = ?'),

  allRuns:       db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 100'),
  runsByFilters: db.prepare(`SELECT * FROM runs
                              WHERE (?1 = '' OR LOWER(status) = LOWER(?1))
                                AND (?2 = '' OR LOWER(job_name) LIKE LOWER(?2) OR LOWER(command) LIKE LOWER(?2))
                                AND (?3 = '' OR job_id = ?3)
                              ORDER BY started_at DESC
                              LIMIT ?4 OFFSET ?5`),
  runsCountByFilters: db.prepare(`SELECT COUNT(*) AS total FROM runs
                                   WHERE (?1 = '' OR LOWER(status) = LOWER(?1))
                                     AND (?2 = '' OR LOWER(job_name) LIKE LOWER(?2) OR LOWER(command) LIKE LOWER(?2))
                                     AND (?3 = '' OR job_id = ?3)`),
  runById:       db.prepare('SELECT * FROM runs WHERE id = ?'),
  insertRun:     db.prepare(`INSERT INTO runs (id,job_id,job_name,command,status,exit_code,stdout,stderr,started_at,ended_at,failure_reason,failure_fix)
                              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
  updateRunStatus: db.prepare(`UPDATE runs SET status=?,exit_code=?,stdout=?,stderr=?,ended_at=?,failure_reason=?,failure_fix=? WHERE id=?`),
  appendStdout:  db.prepare(`UPDATE runs SET stdout = stdout || ? WHERE id = ?`),
  appendStderr:  db.prepare(`UPDATE runs SET stderr = stderr || ? WHERE id = ?`),
}

/** Last successful heartbeat accept per token (ms) — mock rate limit 10s */
const hbLastPing = new Map()

// ── SSE subscribers (in-memory — transient connections) ──────────────────────

const subscribers = {}   // runId -> [res, ...]

// ── Helpers ──────────────────────────────────────────────────────────────────

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
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

function readRawBodyLimited(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let len = 0
    req.on('data', chunk => {
      len += chunk.length
      if (len > maxBytes) {
        reject(new Error('payload too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function publish(runId, msg) {
  const subs = subscribers[runId] || []
  for (const res of subs) {
    try { res.write(`data: ${JSON.stringify(msg)}\n\n`) } catch (_) {}
  }
}

function rowToJob(r) {
  const grace = Number(r.heartbeat_grace_seconds) > 0 ? Number(r.heartbeat_grace_seconds) : 300
  const last = r.last_heartbeat_at || null
  const d = new Date()
  let status = 'never'
  if (last) status = 'healthy'
  return {
    ...r,
    timezone: r.timezone || 'Local',
    logging_enabled: r.logging_enabled === 1,
    heartbeat_token: r.heartbeat_token || '',
    heartbeat_grace_seconds: grace,
    last_heartbeat_at: last,
    heartbeat_status: status,
    heartbeat_deadline_at: new Date(d.getTime() + 60_000).toISOString(),
    heartbeat_prev_fire_at: d.toISOString(),
    heartbeat_interval_seconds: 60,
    heartbeat_first_ping_due_by: new Date(d.getTime() + 120_000).toISOString(),
  }
}

function getDiskStats() {
  try {
    const output = execSync('df -P -k /', { encoding: 'utf8' })
    const lines  = output.trim().split('\n')
    if (lines.length < 2) return []
    const parts      = lines[1].trim().split(/\s+/)
    const mountpoint = parts[parts.length - 1] || '/'
    const usedPercent = Number.parseFloat(String(parts[4] || '0').replace('%', ''))
    return [{ path: mountpoint, used_percent: Number.isFinite(usedPercent) ? usedPercent : 0 }]
  } catch { return [] }
}

function diagnoseFailure(stderr, timedOut) {
  if (timedOut) return { failure_reason: 'Execution timed out', failure_fix: 'Increase timeout_seconds or optimise the script runtime' }
  const lower = String(stderr || '').toLowerCase()
  if (lower.includes('permission denied')) return { failure_reason: 'Permission denied', failure_fix: 'Ensure the script/executable has correct permissions and user access' }
  if (lower.includes('command not found'))  return { failure_reason: 'Command not found',  failure_fix: 'Install the missing command or add it to PATH' }
  if (lower.includes('no such file'))       return { failure_reason: 'File not found',      failure_fix: 'Check command path and working_directory' }
  return { failure_reason: 'Non-zero exit code', failure_fix: 'Inspect stderr logs and add validation or guard clauses' }
}

// ── Job runner ───────────────────────────────────────────────────────────────

function executeRun(runId, job) {
  const run = stmts.runById.get(runId)
  if (!run) return

  const cwd = job.working_directory && String(job.working_directory).trim()
    ? String(job.working_directory).trim()
    : process.cwd()

  const venvPath      = job.venv_path && String(job.venv_path).trim()
  const activateSnippet = venvPath ? `source "${venvPath}/bin/activate" && ` : ''
  const fullCommand   = `${activateSnippet}${job.command}`

  const displayLine   = venvPath ? `(venv: ${venvPath}) $ ${job.command}` : `$ ${job.command}`
  stmts.appendStdout.run(`${displayLine}\n`, runId)
  publish(runId, { status: 'running', stream: 'stdout', line: displayLine })

  const child = spawn('bash', ['-lc', fullCommand], {
    cwd,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
  })

  const timeoutMs = Math.max(1, Number(job.timeout_seconds || 300)) * 1000
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    try { child.kill('SIGTERM') } catch (_) {}
    setTimeout(() => { try { child.kill('SIGKILL') } catch (_) {} }, 3000)
  }, timeoutMs)

  const outReader = readline.createInterface({ input: child.stdout })
  const errReader = readline.createInterface({ input: child.stderr })

  outReader.on('line', (line) => {
    stmts.appendStdout.run(`${line}\n`, runId)
    publish(runId, { status: 'running', stream: 'stdout', line })
  })

  errReader.on('line', (line) => {
    stmts.appendStderr.run(`${line}\n`, runId)
    publish(runId, { status: 'running', stream: 'stderr', line })
  })

  child.on('error', (err) => {
    clearTimeout(timeout)
    stmts.appendStderr.run(`${err.message}\n`, runId)
    const d = diagnoseFailure(err.message, false)
    const finalRun = stmts.runById.get(runId)
    stmts.updateRunStatus.run('failure', 1, finalRun.stdout, finalRun.stderr, new Date().toISOString(), d.failure_reason, d.failure_fix, runId)
    const saved = stmts.runById.get(runId)
    publish(runId, { status: 'failure', stdout: saved.stdout, stderr: saved.stderr, exit_code: 1 })
    delete subscribers[runId]
  })

  child.on('close', (code) => {
    clearTimeout(timeout)
    const exitCode = Number.isInteger(code) ? code : 1
    const status   = exitCode === 0 && !timedOut ? 'success' : 'failure'
    const finalRun = stmts.runById.get(runId)
    let fr = '', ff = ''
    if (status === 'failure') {
      const d = diagnoseFailure(finalRun.stderr, timedOut)
      fr = d.failure_reason; ff = d.failure_fix
    }
    stmts.updateRunStatus.run(status, exitCode, finalRun.stdout, finalRun.stderr, new Date().toISOString(), fr, ff, runId)
    const saved = stmts.runById.get(runId)
    publish(runId, { status, stdout: saved.stdout, stderr: saved.stderr, exit_code: exitCode })
    delete subscribers[runId]
  })
}

// ── HTTP router ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url    = new URL(req.url, `http://localhost:${PORT}`)
  const path_  = url.pathname
  const method = req.method

  if (method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return }

  console.log(`${method} ${path_}`)

  // ── Health ────────────────────────────────────────────────────────────────
  if (method === 'GET' && path_ === '/healthz') {
    return json(res, 200, { ok: true })
  }

  // ── System info ───────────────────────────────────────────────────────────
  if (method === 'GET' && path_ === '/api/system') {
    const totalMem = os.totalmem(), freeMem = os.freemem(), usedMem = totalMem - freeMem
    const load = os.loadavg()
    return json(res, 200, {
      uptime_seconds: Math.floor(os.uptime()),
      cpu_count:      os.cpus().length,
      memory: { total: totalMem, used: usedMem, usedPercent: totalMem > 0 ? (usedMem / totalMem) * 100 : 0 },
      load:   { load1: load[0] ?? 0, load5: load[1] ?? 0, load15: load[2] ?? 0 },
      disks:  getDiskStats(),
    })
  }

  const hbMatch = path_.match(/^\/api\/heartbeat\/([^/]+)$/)
  if (method === 'POST' && hbMatch) {
    const tok = decodeURIComponent(hbMatch[1]).trim()
    if (!tok) return json(res, 404, { error: 'unknown heartbeat token' })
    let payload = ''
    try {
      payload = await readRawBodyLimited(req, 65536)
    } catch {
      return json(res, 413, { error: 'payload too large' })
    }
    const job = stmts.jobByHeartbeat.get(tok)
    if (!job) return json(res, 404, { error: 'unknown heartbeat token' })
    const nowMs = Date.now()
    const prev = hbLastPing.get(tok) || 0
    if (nowMs - prev < 10_000) return json(res, 429, { error: 'rate limited; wait before sending another heartbeat' })
    hbLastPing.set(tok, nowMs)
    const ip = String(req.socket.remoteAddress || '')
    const ts = new Date().toISOString()
    stmts.insertPing.run(randomUUID(), job.id, ip, payload, ts)
    stmts.touchHeartbeat.run(ts, job.id)
    return json(res, 200, { ok: true })
  }

  // ── Scripts ───────────────────────────────────────────────────────────────
  if (method === 'GET' && path_ === '/api/scripts') {
    return json(res, 200, stmts.allScripts.all())
  }

  if (method === 'POST' && path_ === '/api/scripts') {
    let body
    try { body = await readBody(req) } catch { return json(res, 400, { error: 'invalid JSON' }) }
    const name    = (body.name    || '').trim()
    const content = (body.content || '').trim()
    if (!name)    return json(res, 400, { error: 'script name is required' })
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) return json(res, 400, { error: 'script name must only contain letters, digits, dots, hyphens, or underscores' })
    if (!content) return json(res, 400, { error: 'script content is required' })
    stmts.upsertScript.run(name, content, new Date().toISOString())
    return json(res, 201, { ok: true })
  }

  const scriptDeleteMatch = path_.match(/^\/api\/scripts\/(.+)$/)
  if (method === 'DELETE' && scriptDeleteMatch) {
    const name = decodeURIComponent(scriptDeleteMatch[1])
    stmts.deleteScript.run(name)
    return json(res, 200, { ok: true })
  }

  // ── Jobs ──────────────────────────────────────────────────────────────────
  if (method === 'GET' && path_ === '/api/jobs') {
    return json(res, 200, stmts.allJobs.all().map(rowToJob))
  }

  if (method === 'GET' && path_ === '/api/jobs/presets') {
    return json(res, 200, [
      { label: 'Every minute',          schedule: '* * * * *'    },
      { label: 'Every 5 minutes',       schedule: '*/5 * * * *'  },
      { label: 'Hourly',                schedule: '0 * * * *'    },
      { label: 'Daily at midnight',     schedule: '0 0 * * *'    },
      { label: 'Weekly (Sun midnight)', schedule: '0 0 * * 0'    },
    ])
  }

  if (method === 'POST' && path_ === '/api/jobs') {
    let body
    try { body = await readBody(req) } catch { return json(res, 400, { error: 'invalid JSON' }) }
    const name     = (body.name     || '').trim()
    const command  = (body.command  || '').trim()
    const schedule = (body.schedule || '').trim()
    if (!name)    return json(res, 400, { error: 'job name is required' })
    if (!command) return json(res, 400, { error: 'command is required' })
    if ((schedule.match(/\S+/g) || []).length !== 5) return json(res, 400, { error: 'invalid cron schedule — must be exactly 5 space-separated fields' })
    let grace = Number(body.heartbeat_grace_seconds)
    if (!Number.isFinite(grace) || grace <= 0) grace = 300
    if (grace > 604800) grace = 604800
    const hbTok = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
    stmts.insertJob.run(
      randomUUID(), name, schedule,
      body.timezone || 'Local',
      command,
      body.working_directory || '',
      body.venv_path || '',
      body.comment   || '',
      body.logging_enabled !== false ? 1 : 0,
      body.timeout_seconds > 0 ? body.timeout_seconds : 300,
      new Date().toISOString(),
      hbTok,
      grace,
    )
    return json(res, 201, { ok: true })
  }

  const jobMatch = path_.match(/^\/api\/jobs\/([^/]+)$/)
  if (method === 'PUT' && jobMatch) {
    const id  = decodeURIComponent(jobMatch[1])
    const job = stmts.jobById.get(id)
    if (!job) return json(res, 404, { error: 'job not found' })
    let body
    try { body = await readBody(req) } catch { return json(res, 400, { error: 'invalid JSON' }) }
    const name     = (body.name     || '').trim()
    const command  = (body.command  || '').trim()
    const schedule = (body.schedule || '').trim()
    if (!name)    return json(res, 400, { error: 'job name is required' })
    if (!command) return json(res, 400, { error: 'command is required' })
    if ((schedule.match(/\S+/g) || []).length !== 5) return json(res, 400, { error: 'invalid cron schedule — must be exactly 5 space-separated fields' })
    let grace = Number(body.heartbeat_grace_seconds)
    if (!Number.isFinite(grace) || grace <= 0) grace = 300
    if (grace > 604800) grace = 604800
    stmts.updateJob.run(
      name, schedule, body.timezone || 'Local', command,
      body.working_directory || '',
      body.venv_path  || '',
      body.comment    || '',
      body.logging_enabled !== false ? 1 : 0,
      body.timeout_seconds > 0 ? body.timeout_seconds : 300,
      grace,
      id,
    )
    return json(res, 200, { ok: true })
  }

  if (method === 'DELETE' && jobMatch) {
    const id  = decodeURIComponent(jobMatch[1])
    const job = stmts.jobById.get(id)
    if (!job) return json(res, 404, { error: 'job not found' })
    stmts.deleteJob.run(id)
    return json(res, 200, { ok: true })
  }

  // ── Run a job now ─────────────────────────────────────────────────────────
  const runJobMatch = path_.match(/^\/api\/jobs\/([^/]+)\/run$/)
  if (method === 'POST' && runJobMatch) {
    const id  = decodeURIComponent(runJobMatch[1])
    const job = stmts.jobById.get(id)
    if (!job) return json(res, 404, { error: 'job not found' })
    const runId = randomUUID()
    stmts.insertRun.run(
      runId, job.id, job.name, job.command,
      'running', null, '', '',
      new Date().toISOString(), null, '', '',
    )
    setTimeout(() => executeRun(runId, rowToJob(job)), 10)
    return json(res, 202, { status: 'started_in_background', run_id: runId })
  }

  // ── Runs ──────────────────────────────────────────────────────────────────
  if (method === 'GET' && path_ === '/api/runs') {
    let status = String(url.searchParams.get('status') || '').trim().toLowerCase()
    if (status === 'failed') status = 'failure'
    const searchRaw = String(url.searchParams.get('search') || '').trim()
    const jobId = String(url.searchParams.get('job_id') || '').trim()
    const search = searchRaw ? `%${searchRaw}%` : ''
    const limit = Math.max(1, Math.min(500, Number.parseInt(String(url.searchParams.get('limit') || '50'), 10) || 50))
    const offset = Math.max(0, Number.parseInt(String(url.searchParams.get('offset') || '0'), 10) || 0)
    const statusArg = status === '' || status === 'all' ? '' : status
    const totalRow = stmts.runsCountByFilters.get(statusArg, search, jobId)
    const items = stmts.runsByFilters.all(statusArg, search, jobId, limit, offset)
    return json(res, 200, {
      items,
      total: totalRow.total || 0,
      limit,
      offset,
      has_more: offset + items.length < (totalRow.total || 0),
    })
  }

  const logsMatch = path_.match(/^\/api\/runs\/([^/]+)\/logs$/)
  if (method === 'GET' && logsMatch) {
    const run = stmts.runById.get(logsMatch[1])
    if (!run) return json(res, 404, { error: 'run not found' })
    return json(res, 200, { stdout: run.stdout, stderr: run.stderr })
  }

  if (method === 'POST' && path_ === '/api/runs/email') {
    let body
    try { body = await readBody(req) } catch { return json(res, 400, { error: 'invalid JSON' }) }
    const n = notifGet.get()
    if (!n || !n.enabled) return json(res, 400, { error: 'notifications disabled or SMTP/recipients incomplete' })
    if (!String(n.smtp_host || '').trim() || !String(n.from_address || '').trim() || !String(n.to_addresses || '').trim()) {
      return json(res, 400, { error: 'notifications disabled or SMTP/recipients incomplete' })
    }
    let st = String(body.status || 'all').trim().toLowerCase()
    if (st === 'failed') st = 'failure'
    const statusArg = st === '' || st === 'all' ? '' : st
    const searchRaw = String(body.search || '').trim()
    const search = searchRaw ? `%${searchRaw}%` : ''
    const jobId = String(body.job_id || '').trim()
    let limit = Number.parseInt(String(body.limit || '100'), 10) || 100
    if (limit < 1) limit = 100
    if (limit > 500) limit = 500
    const items = stmts.runsByFilters.all(statusArg, search, jobId, limit, 0)
    return json(res, 202, { status: 'queued', run_count: items.length })
  }

  if (method === 'GET' && path_ === '/api/settings/notifications') {
    const n = notifGet.get()
    if (!n) return json(res, 500, { error: 'settings missing' })
    const pwEnv = !!process.env.NOTIFICATION_SMTP_PASSWORD
    return json(res, 200, {
      enabled: !!n.enabled,
      smtp_host: n.smtp_host || '',
      smtp_port: n.smtp_port || 587,
      smtp_username: n.smtp_username || '',
      smtp_password_set: !!(n.smtp_password && String(n.smtp_password).trim()) || pwEnv,
      smtp_password_from_env: pwEnv,
      smtp_tls: n.smtp_tls !== 0,
      from_address: n.from_address || '',
      to_addresses: n.to_addresses || '',
      notify_scheduled_success: !!n.notify_scheduled_success,
      notify_scheduled_failure: !!n.notify_scheduled_failure,
      notify_manual_success: !!n.notify_manual_success,
      notify_manual_failure: !!n.notify_manual_failure,
      notify_heartbeat_missed: !!n.notify_heartbeat_missed,
    })
  }

  if (method === 'PUT' && path_ === '/api/settings/notifications') {
    let body
    try { body = await readBody(req) } catch { return json(res, 400, { error: 'invalid JSON' }) }
    const cur = notifGet.get()
    if (!cur) return json(res, 500, { error: 'settings missing' })
    let pass = cur.smtp_password || ''
    const newPw = String(body.smtp_password || '').trim()
    if (newPw) pass = newPw
    const port = Number(body.smtp_port) > 0 && Number(body.smtp_port) <= 65535 ? Number(body.smtp_port) : 587
    notifUpdate.run(
      body.enabled ? 1 : 0,
      String(body.smtp_host || '').trim(),
      port,
      String(body.smtp_username || '').trim(),
      pass,
      body.smtp_tls === false ? 0 : 1,
      String(body.from_address || '').trim(),
      String(body.to_addresses || '').trim(),
      body.notify_scheduled_success ? 1 : 0,
      body.notify_scheduled_failure ? 1 : 0,
      body.notify_manual_success ? 1 : 0,
      body.notify_manual_failure ? 1 : 0,
      body.notify_heartbeat_missed ? 1 : 0,
    )
    return json(res, 200, { ok: true })
  }

  if (method === 'POST' && path_ === '/api/settings/notifications/test') {
    const n = notifGet.get()
    if (!n || !n.enabled) return json(res, 400, { error: 'notifications disabled or SMTP/recipients incomplete' })
    if (!String(n.smtp_host || '').trim() || !String(n.from_address || '').trim() || !String(n.to_addresses || '').trim()) {
      return json(res, 400, { error: 'notifications disabled or SMTP/recipients incomplete' })
    }
    const user = String(n.smtp_username || '').trim()
    const pass = String(n.smtp_password || '').trim() || (process.env.NOTIFICATION_SMTP_PASSWORD || '').trim()
    if (user && !pass) {
      return json(res, 400, { error: 'SMTP username and password are required for this server. Save a password or set NOTIFICATION_SMTP_PASSWORD.' })
    }
    return json(res, 200, { ok: true, status: 'sent' })
  }

  const streamMatch = path_.match(/^\/api\/runs\/([^/]+)\/stream$/)
  if (method === 'GET' && streamMatch) {
    const runId = streamMatch[1]
    const run   = stmts.runById.get(runId)
    cors(res)
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    })
    res.write(': connected\n\n')

    // If run already finished, replay final state immediately and close
    if (run && run.status !== 'running') {
      res.write(`data: ${JSON.stringify({ status: run.status, stdout: run.stdout, stderr: run.stderr, exit_code: run.exit_code })}\n\n`)
      res.end()
      return
    }

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
  console.log(`\n  CronSentinel backend running  (SQLite: ${DB_PATH})`)
  console.log(`  http://localhost:${PORT}/healthz\n`)
})
