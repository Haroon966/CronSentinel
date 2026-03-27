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

// Seed default data on first run (empty DB)
const jobCount = db.prepare('SELECT COUNT(*) AS n FROM jobs').get()
if (jobCount.n === 0) {
  const id1 = randomUUID()
  const id2 = randomUUID()
  const now  = new Date().toISOString()

  db.prepare(`INSERT INTO jobs (id,name,schedule,timezone,command,comment,logging_enabled,timeout_seconds,created_at)
              VALUES (?,?,?,?,?,?,1,30,?)`).run(id1, 'Health Check',  '*/5 * * * *', 'Local', 'echo "health ok"',    'Runs every 5 minutes', now)
  db.prepare(`INSERT INTO jobs (id,name,schedule,timezone,command,comment,logging_enabled,timeout_seconds,created_at)
              VALUES (?,?,?,?,?,?,1,300,?)`).run(id2, 'Daily Backup', '0 2 * * *',   'Local', 'echo "backup complete"', 'Runs at 2 AM daily',   now)

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
  allJobs:       db.prepare('SELECT * FROM jobs ORDER BY created_at DESC'),
  jobById:       db.prepare('SELECT * FROM jobs WHERE id = ?'),
  insertJob:     db.prepare(`INSERT INTO jobs (id,name,schedule,timezone,command,working_directory,venv_path,comment,logging_enabled,timeout_seconds,created_at)
                              VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
  updateJob:     db.prepare(`UPDATE jobs SET name=?,schedule=?,timezone=?,command=?,working_directory=?,venv_path=?,comment=?,logging_enabled=?,timeout_seconds=? WHERE id=?`),
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

function publish(runId, msg) {
  const subs = subscribers[runId] || []
  for (const res of subs) {
    try { res.write(`data: ${JSON.stringify(msg)}\n\n`) } catch (_) {}
  }
}

function rowToJob(r) {
  return { ...r, timezone: r.timezone || 'Local', logging_enabled: r.logging_enabled === 1 }
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
    stmts.updateJob.run(
      name, schedule, body.timezone || 'Local', command,
      body.working_directory || '',
      body.venv_path  || '',
      body.comment    || '',
      body.logging_enabled !== false ? 1 : 0,
      body.timeout_seconds > 0 ? body.timeout_seconds : 300,
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
    const status = String(url.searchParams.get('status') || '').trim()
    const searchRaw = String(url.searchParams.get('search') || '').trim()
    const jobId = String(url.searchParams.get('job_id') || '').trim()
    const search = searchRaw ? `%${searchRaw}%` : ''
    const limit = Math.max(1, Math.min(500, Number.parseInt(String(url.searchParams.get('limit') || '50'), 10) || 50))
    const offset = Math.max(0, Number.parseInt(String(url.searchParams.get('offset') || '0'), 10) || 0)
    const totalRow = stmts.runsCountByFilters.get(status === 'all' ? '' : status, search, jobId)
    const items = stmts.runsByFilters.all(status === 'all' ? '' : status, search, jobId, limit, offset)
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
