# CronSentinel — Product Requirements Document (PRD)

**Version:** 1.0  
**Last Updated:** 2026-03-28  
**Status:** Active Development  

---

## Overview

CronSentinel is a production-grade cron job monitoring and management platform. It helps developers and teams set, monitor, and get alerted on cron jobs — eliminating silent failures, missed runs, and operational blind spots.

---

## Tech Stack (assumed defaults — adjust to your project)

- **Frontend:** Next.js 14+ (App Router), TypeScript, Tailwind CSS
- **Backend:** Node.js / Express or Next.js API routes
- **Database:** PostgreSQL (with Prisma ORM)
- **Queue/Jobs:** BullMQ or pg-boss
- **Auth:** NextAuth.js or Clerk
- **Notifications:** Resend (email), Twilio (SMS), Slack API
- **Deployment:** Vercel / Railway / Docker

---

## How This PRD Works With Cursor

Each feature below is a self-contained unit. The Cursor agent will:
1. Read this file
2. Pick the **first uncompleted feature** from the backlog (marked `[ ]`)
3. Plan → implement → test → handle errors → mark it `[x]` and move it to the Completed section
4. Never work on more than one feature at a time

**Do not manually edit the checkboxes** — Cursor manages them.

---

## Feature Backlog

> Features are ordered by priority: MVP first, then V2, then V3.  
> Format: `[ ] FEAT-XX | Feature Name | Category | Priority`

---

### 🔴 MVP — Ship First

- [x] FEAT-01 | Heartbeat Monitoring | Monitoring | MVP
- [x] FEAT-02 | Absence-Based Alerting | Monitoring | MVP
- [x] FEAT-03 | Execution Log Capture | Monitoring | MVP
- [x] FEAT-04 | Live Status Dashboard | Monitoring | MVP
- [x] FEAT-05 | Execution History Log | Monitoring | MVP
- [x] FEAT-06 | Daemon & Server Heartbeat | Reliability | MVP
- [x] FEAT-07 | Crontab Change Detection | Reliability | MVP
- [x] FEAT-08 | Job Timeout & Kill Switch | Reliability | MVP
- [x] FEAT-09 | Visual Cron Builder | UX | MVP
- [x] FEAT-10 | Next-Run Previewer | UX | MVP
- [x] FEAT-11 | 60-Second Onboarding | UX | MVP
- [x] FEAT-12 | No-Redeploy Schedule Editor | UX | MVP
- [x] FEAT-13 | Secure Env Variable Manager | Security | MVP
- [x] FEAT-14 | Multi-Channel Alert Integrations | Integrations | MVP
- [x] FEAT-15 | REST API | Integrations | MVP
- [x] FEAT-16 | Predictable Flat Pricing | DevX | MVP

---

### 🟡 V2 — Differentiators

- [x] FEAT-17 | Runtime Duration Trends | Monitoring | V2
- [ ] FEAT-18 | SLA Window Tracking | Monitoring | V2
- [ ] FEAT-19 | Smart Alert Deduplication | Monitoring | V2
- [ ] FEAT-20 | Runtime Anomaly Detection | Monitoring | V2
- [ ] FEAT-21 | Concurrency Guard | Reliability | V2
- [ ] FEAT-22 | DST-Safe Scheduler | Reliability | V2
- [ ] FEAT-23 | Clock Drift Detection | Reliability | V2
- [ ] FEAT-24 | Auto-Retry with Backoff | Reliability | V2
- [ ] FEAT-25 | Late-Start Detection | Reliability | V2
- [ ] FEAT-26 | Missed-Run Counter & Alert | Reliability | V2
- [ ] FEAT-27 | Job Pileup Guard | Reliability | V2
- [ ] FEAT-28 | Host Resource Monitor | Reliability | V2
- [ ] FEAT-29 | Job Config Version History | Reliability | V2
- [ ] FEAT-30 | Global Search | UX | V2
- [ ] FEAT-31 | Mobile Alerts & Responsive UI | UX | V2
- [ ] FEAT-32 | Job Pause / Suspend Mode | UX | V2
- [ ] FEAT-33 | Wrong User Context Validator | Security | V2
- [ ] FEAT-34 | Secret Masking in Logs & UI | Security | V2
- [ ] FEAT-35 | Role-Based Access Control | Security | V2
- [ ] FEAT-36 | Immutable Audit Log | Security | V2
- [ ] FEAT-37 | On-Call Schedule Routing | Integrations | V2
- [ ] FEAT-38 | Inbound Webhook Trigger | Integrations | V2
- [ ] FEAT-39 | Configurable Log Retention | DevX | V2
- [ ] FEAT-40 | Multi-Environment Workspaces | DevX | V2

---

### 🟢 V3 — Enterprise Tier

- [ ] FEAT-41 | Job Health Heatmap | Monitoring | V3
- [ ] FEAT-42 | External Concurrency Lock | Reliability | V3
- [ ] FEAT-43 | Cloud-Native External Trigger | Reliability | V3
- [ ] FEAT-44 | Job Template Library | UX | V3
- [ ] FEAT-45 | Public Status Page & Badge | UX | V3
- [ ] FEAT-46 | Crontab Tampering Detection | Security | V3
- [ ] FEAT-47 | Kubernetes CronJob Integration | Integrations | V3
- [ ] FEAT-48 | OpenTelemetry Export | Integrations | V3
- [ ] FEAT-49 | Compliance Audit Reports | DevX | V3
- [ ] FEAT-50 | Job Dependency Chains | DevX | V3

---

## Feature Specifications

Each feature below contains full context for implementation.

---

### FEAT-01 — Heartbeat Monitoring
**Problem:** Jobs crash with zero alert. Backups stop for weeks unnoticed.  
**Solution:** Jobs ping CronSentinel on success via a unique URL. No ping within the expected window triggers an instant alert.  
**Acceptance Criteria:**
- Each monitored job gets a unique heartbeat URL (e.g. `POST /api/heartbeat/:token`)
- Heartbeat token is generated on job creation and shown in the dashboard
- If no ping is received within `schedule_interval + grace_period`, trigger alert
- Store each heartbeat ping: timestamp, IP, response payload
- Dashboard shows: last ping time, next expected ping, status (healthy/late/dead)
- API endpoint returns 200 on success, 404 on unknown token
- Rate-limit heartbeat endpoint (max 1 ping per 10 seconds per token)
- Full error handling: invalid token, malformed request, DB failure
- Unit tests for heartbeat logic and alert triggering

---

### FEAT-02 — Absence-Based Alerting
**Problem:** Alerts only fire on crash, never on absence. Missed runs are invisible.  
**Solution:** A background worker checks every N minutes if scheduled jobs ran. If not, fire alert.  
**Acceptance Criteria:**
- Background poller runs every minute using a reliable queue (BullMQ or pg-boss)
- For each active job, check: did a heartbeat arrive within `expected_window`?
- `expected_window` = last known schedule + grace_period (configurable per job, default 5 min)
- On absence detected: create an alert record, send notification via configured channels
- Dedup: don't fire the same absence alert more than once per missed window
- Poller is resilient: if it crashes and restarts, it catches up without double-alerting
- Alert includes: job name, scheduled time, how many minutes late
- Full error handling: DB timeout, notification failure (retry 3x), queue failure

---

### FEAT-03 — Execution Log Capture
**Problem:** Cron drops all script output. Exit codes are never checked.  
**Solution:** Agent captures stdout, stderr, exit code and sends them to CronSentinel API.  
**Acceptance Criteria:**
- API endpoint: `POST /api/jobs/:id/runs` accepts: exit_code, stdout, stderr, duration_ms, started_at
- Payload is validated (max 1MB stdout/stderr, required fields)
- Stored per job run in `job_runs` table
- Dashboard shows log viewer per run: stdout/stderr with syntax highlighting
- Filter runs by: status (success/fail), date range, duration
- Exit code 0 = success, non-zero = failure (configurable)
- Logs truncated at 1MB with warning shown in UI
- Full error handling: oversized payload (413), invalid job ID (404), DB write failure

---

### FEAT-04 — Live Status Dashboard
**Problem:** Job status scattered across servers with no unified view.  
**Solution:** Real-time dashboard showing all jobs with current status.  
**Acceptance Criteria:**
- Dashboard page at `/dashboard` showing all jobs in a table/card grid
- Each job shows: name, schedule (human-readable), last run time, last run status, next expected run
- Status badges: Healthy (green), Late (yellow), Failed (red), Never Run (gray), Paused (blue)
- Auto-refreshes every 30 seconds (polling) or via SSE/WebSocket
- Summary row at top: total jobs, healthy count, failing count, late count
- Click any job to open job detail page
- Responsive layout (mobile + desktop)
- Skeleton loading states while data fetches
- Error state if API fails (show retry button)

---

### FEAT-05 — Execution History Log
**Problem:** Can't see how a job performed over time.  
**Solution:** Searchable, filterable history of every job run.  
**Acceptance Criteria:**
- History page per job at `/jobs/:id/history`
- Table with columns: run time, duration, exit code, status, log preview
- Filter by: status, date range (last 7d / 30d / 90d / custom)
- Click row to expand full stdout/stderr log
- Pagination: 25 runs per page
- Export history as CSV
- Empty state when no runs yet
- Full error handling on fetch failures with retry

---

### FEAT-06 — Daemon & Server Heartbeat
**Problem:** The cron daemon gets OOM-killed or k8s restarts it. Everything stops silently.  
**Solution:** Servers send a heartbeat to CronSentinel every minute. Silence = server-down alert.  
**Acceptance Criteria:**
- Server agent (bash one-liner or lightweight binary) sends `POST /api/server-heartbeat/:token` every 60s
- If no server heartbeat in 3 minutes, fire "server unreachable" alert
- Dashboard shows server health per registered server
- Server heartbeat token separate from job tokens
- Distinguish between "job missed" and "server down" in alerts
- Alert includes: server name, last seen time, minutes since last ping
- Full error handling: network failure on agent side (retry with exponential backoff)

---

### FEAT-07 — Crontab Change Detection
**Problem:** Deploys overwrite crontab silently. No job crash, no log, just absence.  
**Solution:** Agent snapshots crontab periodically and diffs against stored version.  
**Acceptance Criteria:**
- Agent reads current crontab and sends hash + full content to `POST /api/crontab-snapshot`
- Backend stores snapshot and compares to previous version
- If diff detected: fire alert with before/after diff
- Diff shown in dashboard with highlighted additions/removals
- Snapshot stored with timestamp, server, user context
- Configurable polling interval (default: every 5 minutes)
- Full error handling: crontab unreadable (permissions), empty crontab, API failure

---

### FEAT-08 — Job Timeout & Kill Switch
**Problem:** Jobs hang indefinitely, consuming resources without ever failing.  
**Solution:** Per-job timeout setting; alert (and optionally kill) if exceeded.  
**Acceptance Criteria:**
- Per-job `timeout_seconds` field (optional, 0 = disabled)
- Background worker monitors active (started but not finished) job runs
- If run exceeds timeout: mark as `timed_out`, fire alert
- Optional: send SIGTERM to job process via agent (configurable)
- Dashboard shows timed-out runs with duration at timeout
- Alert includes: job name, configured timeout, actual run duration
- Full error handling: agent kill fails gracefully, timeout worker crash recovery

---

### FEAT-09 — Visual Cron Builder
**Problem:** Developers waste time Googling cron syntax. Typos cause wrong schedules.  
**Solution:** Point-and-click schedule builder that outputs a valid cron expression.  
**Acceptance Criteria:**
- UI component with controls for: minute, hour, day of month, month, day of week
- Preset buttons: Every minute, Every hour, Daily, Weekly, Monthly, Custom
- Live preview: human-readable string (e.g. "Every Monday at 9:00 AM")
- Shows next 5 scheduled run times below the builder
- Validates expression and shows error for invalid combos
- Outputs standard 5-field cron expression string
- Works in job creation and job edit forms
- Fully accessible (keyboard navigable, ARIA labels)

---

### FEAT-10 — Next-Run Previewer
**Problem:** Users save a job and hope it runs at the right time. No verification before save.  
**Solution:** Show the next N scheduled run times before the user saves any schedule change.  
**Acceptance Criteria:**
- On any cron expression input change, compute and show next 10 run times
- Display in user's local timezone AND UTC
- Debounce computation (250ms after last keystroke)
- Show warning if next run is more than 24 hours away
- Show warning if expression results in more than 60 runs/hour (too frequent)
- Invalid expression shows inline error, not a crash
- Works as a standalone component usable in both create and edit flows

---

### FEAT-11 — 60-Second Onboarding
**Problem:** Monitoring tools take hours to configure. First value takes too long.  
**Solution:** Guided wizard that gets a user's first job monitored in under 60 seconds.  
**Note:** Step 3 email uses existing SMTP notification settings; optional Slack is deferred to FEAT-14 (copy-only in the wizard).  
**Acceptance Criteria:**
- Onboarding wizard shown to new users on first login (skippable)
- Step 1: Name your job + enter cron schedule
- Step 2: Copy the generated heartbeat URL + one-line curl command
- Step 3: Configure alert channel (email pre-filled from account, optional Slack)
- Step 4: "Test it" button sends a test heartbeat and shows it received
- Progress indicator (steps 1-4)
- Can resume onboarding if user closes mid-way
- Skip button available at any step
- Full error handling: test heartbeat fails (show troubleshooting tips)

---

### FEAT-12 — No-Redeploy Schedule Editor
**Problem:** Every cron schedule change requires a code change and redeploy.  
**Solution:** Edit schedule, name, grace period, and timeout directly from the dashboard.  
**Acceptance Criteria:**
- Edit button on each job opens an edit form/modal
- Editable fields: name, description, cron expression, grace_period_minutes, timeout_seconds, enabled
- Changes saved immediately via API with optimistic UI update
- Change logged to job audit trail (who changed what, when)
- Confirmation dialog for changes to active jobs
- Validation: invalid cron expressions rejected with inline error
- Full error handling: save failure shows error toast with retry option

**Implementation note:** `job_config_audit.actor` is stored as empty string until authenticated users exist; diffs are still recorded with timestamps.

---

### FEAT-13 — Secure Env Variable Manager
**Problem:** API keys and paths missing in cron context. Secrets hardcoded in crontab.  
**Solution:** Per-job encrypted env variable store, injected at runtime by the agent.  
**Acceptance Criteria:**
- UI to add key-value env vars per job
- Values encrypted at rest (AES-256 or KMS)
- Values masked in UI after saving (show only last 4 chars)
- Agent fetches env vars at job start time via authenticated API call
- Never log env var values in execution logs
- Warn if a value looks like a plaintext secret (heuristic check)
- Delete individual vars with confirmation
- Full error handling: decryption failure, agent fetch failure (job should not run without required vars)

---

### FEAT-14 — Multi-Channel Alert Integrations
**Problem:** Single email alert. No escalation. No Slack or PagerDuty.  
**Solution:** Alert delivery to email, Slack, webhook, SMS — configurable per job.  
**Acceptance Criteria:**
- Alert channels configurable at account level and overridable per job
- Supported channels: Email (Resend), Slack (webhook), Generic Webhook, SMS (Twilio)
- Test button per channel (sends a test alert)
- Alert payload includes: job name, status, error message, timestamp, link to job
- Retry failed deliveries up to 3 times with exponential backoff
- Alert delivery log (sent/failed per alert per channel)
- Full error handling: invalid webhook URL, Slack token expired, SMS failure

---

### FEAT-15 — REST API
**Problem:** Teams need to manage monitors from CI/CD scripts, not just the UI.  
**Solution:** Full REST API with API key authentication.  
**Acceptance Criteria:**
- Endpoints: CRUD for jobs, list runs, get run detail, trigger manual run, get heartbeat token
- API key auth: `Authorization: Bearer <key>` header
- API keys manageable in dashboard (create, revoke, name)
- Rate limiting: 1000 req/hour per key
- Consistent JSON response format: `{ data, error, meta }`
- Pagination on list endpoints (cursor-based)
- OpenAPI/Swagger spec auto-generated at `/api/docs`
- Full error handling: 400 validation, 401 auth, 403 forbidden, 404 not found, 429 rate limit, 500 server

---

### FEAT-16 — Predictable Flat Pricing
**Problem:** Per-host or per-GB pricing spikes unpredictably. Datadog-style bill shock.  
**Solution:** Flat per-monitor pricing with hard limits shown before overages.  
**Acceptance Criteria:**
- Pricing tiers defined in config (not hardcoded in business logic)
- Usage dashboard: monitors used / limit, alerts sent this month
- Warning banner when usage reaches 80% of plan limit
- Hard block (with clear error) when limit reached — no silent overages
- Plan displayed on account settings page
- Admin can upgrade plan from settings (link to billing)
- Usage tracked in DB with monthly reset

---

### FEAT-17 — Runtime Duration Trends
**Problem:** Jobs slowly get slower; no one notices until they time out.  
**Solution:** Chart run duration over time per job to spot degradation.  
**Acceptance Criteria:**
- Line chart on job detail page showing duration (ms) per run over last 30 days
- Toggle between 7d / 30d / 90d views
- Show p50, p95, p99 percentile lines
- Highlight outliers (runs > 2× p95) in red
- Hover tooltip showing run time, duration, status
- Empty state if fewer than 3 runs
- Chart is responsive and accessible

---

### FEAT-18 — SLA Window Tracking
**Problem:** Tools alert at run start, not when the job must be done by.  
**Solution:** Define an expected completion window; alert if not done in time.  
**Acceptance Criteria:**
- Per-job field: `sla_minutes` (job must complete within N minutes of scheduled time)
- Background worker checks: if job started but not finished within SLA window, fire alert
- If job hasn't started by SLA window, also fire alert
- Dashboard shows SLA status column: Met / Breached / At Risk
- Alert includes: job name, SLA window, actual completion time or current delay
- SLA breach logged in audit trail

---

### FEAT-19 — Smart Alert Deduplication
**Problem:** Tools spam engineers with the same alert on every retry of the same failure.  
**Solution:** Group repeated alerts; send one alert, then one recovery when fixed.  
**Acceptance Criteria:**
- Alert dedup window configurable per job (default: 30 minutes)
- Within dedup window: update existing alert record, don't send new notification
- When job recovers (succeeds after failing): send "recovered" notification
- Alert state machine: open → acknowledged → resolved
- Dashboard shows open alerts with duration (how long it's been failing)
- Full error handling: dedup state corruption recovery

---

### FEAT-20 — Runtime Anomaly Detection
**Problem:** Job suddenly takes 8× longer than normal. Nothing flags it.  
**Solution:** Baseline avg duration per job; alert when a run significantly deviates.  
**Acceptance Criteria:**
- Compute rolling baseline: p95 of last 30 successful runs per job
- If a run exceeds 2× the baseline: fire anomaly alert (configurable multiplier)
- Minimum 5 runs required before anomaly detection activates
- Alert includes: job name, baseline duration, actual duration, deviation %
- Anomaly alerts shown distinctly from failure alerts in dashboard
- Configurable sensitivity per job (1.5× / 2× / 3× baseline)

---

### FEAT-21 — Concurrency Guard
**Problem:** Slow job spills into next trigger. Two instances run simultaneously.  
**Solution:** Detect overlapping runs and enforce configurable lock policy.  
**Acceptance Criteria:**
- Per-job setting: `concurrency_policy` — Allow / Warn / Block
- Agent checks in at job start: `POST /api/jobs/:id/lock`
- If a lock exists and policy is Block: return 409, job should not start
- If Warn: allow but fire alert
- Lock automatically released on job completion or timeout
- Dashboard shows "currently running" count per job
- Lock TTL to prevent stale locks from blocking forever (= job timeout + 20%)
- Full error handling: lock check failure, stale lock cleanup, agent crash leaves lock

---

### FEAT-22 — DST-Safe Scheduler
**Problem:** Daylight saving triggers jobs twice or skips them on clock-change days.  
**Solution:** DST-aware schedule computation engine.  
**Acceptance Criteria:**
- All schedule computations use the job's configured timezone (not server UTC)
- On DST transitions: compute using wall-clock time, not elapsed time
- Jobs scheduled for a skipped hour (e.g. 2:30 AM when clocks jump to 3:00) are run at 3:00
- Jobs scheduled for a repeated hour (e.g. 1:30 AM that occurs twice) run only once
- Next-run previewer shows DST transitions with a warning label
- Use a battle-tested timezone library (e.g. `date-fns-tz` or `Temporal`)

---

### FEAT-23 — Clock Drift Detection
**Problem:** Server clock drifts; jobs silently miss their scheduled window.  
**Solution:** Monitor NTP sync status on servers; alert when drift exceeds threshold.  
**Acceptance Criteria:**
- Agent reports server time with each heartbeat ping
- Backend compares reported time to its own UTC clock
- If drift > 30 seconds: fire "clock drift" alert
- Dashboard shows clock drift status per server
- Alert includes: server name, reported time, expected time, drift amount
- Configurable drift threshold (default: 30s)

---

### FEAT-24 — Auto-Retry with Backoff
**Problem:** Network blip kills job. Cron has no retry logic.  
**Solution:** Configurable auto-retry with exponential backoff per job.  
**Acceptance Criteria:**
- Per-job settings: `max_retries` (0-5), `retry_backoff` (fixed / exponential)
- On failure: schedule retry after backoff period (1m, 2m, 4m, 8m, 16m for exponential)
- Retry attempts shown in run history (attempt 1 of 3, etc.)
- Alert only sent after all retries exhausted
- Per-run metadata: attempt number, retry reason, time of next retry
- Full error handling: retry queue failure, job deleted mid-retry

---

### FEAT-25 — Late-Start Detection
**Problem:** Job was scheduled but didn't start on time. Nothing alerted.  
**Solution:** Alert when a job starts significantly later than its scheduled time.  
**Acceptance Criteria:**
- Per-job `late_start_threshold_minutes` (default: 5 minutes)
- Background worker compares scheduled start time to actual start time
- If difference > threshold: fire "late start" alert
- Alert includes: job name, scheduled start, actual start, delay in minutes
- Late starts tracked in run history with "late" badge
- Distinguish "late start" from "missed run" (missed = never started)

---

### FEAT-26 — Missed-Run Counter & Alert
**Problem:** In Kubernetes, after 100 missed schedules the CronJob permanently stops.  
**Solution:** Track cumulative missed runs and alert before hitting critical thresholds.  
**Acceptance Criteria:**
- Track missed run count per job (reset on successful run)
- Alert thresholds: warn at 10 missed, critical at 50 missed
- Dashboard shows missed run counter with red badge when elevated
- For K8s jobs: add specific warning about 100-miss permanent failure
- Missed run counter shown on job detail page with history
- Counter resets automatically on successful run

---

### FEAT-27 — Job Pileup Guard
**Problem:** Cron spawns many copies of a slow job, exhausting system resources.  
**Solution:** Detect and alert when multiple instances of the same job accumulate.  
**Acceptance Criteria:**
- Track count of concurrent running instances per job
- Alert when concurrent count exceeds `max_concurrent` threshold (default: 3)
- Dashboard shows "X instances running" badge on affected jobs
- Option to auto-kill oldest instances when pileup detected (configurable)
- Pileup events logged with instance count, start times
- Alert includes: job name, instance count, oldest instance start time

---

### FEAT-28 — Host Resource Monitor
**Problem:** Full disk or OOM silently breaks every job on the server.  
**Solution:** Agent reports host resource metrics; alert before jobs are impacted.  
**Acceptance Criteria:**
- Agent reports: disk usage %, memory usage %, load average with each server heartbeat
- Alert thresholds (configurable): disk > 85%, memory > 90%, load > CPU count × 2
- Dashboard shows host resource gauges per server
- Resource history chart (last 24 hours)
- Alert includes: server name, resource type, current value, threshold
- Resource data stored with 24h retention (not long-term)

---

### FEAT-29 — Job Config Version History
**Problem:** Someone changed the cron expression. Nobody knows who or when.  
**Solution:** Full version history of every job configuration change.  
**Acceptance Criteria:**
- Every save to a job config creates a version snapshot
- Version stored: timestamp, user, full config before/after
- Version history page at `/jobs/:id/versions`
- Side-by-side diff view between any two versions
- "Restore" button to roll back to a previous version (with confirmation)
- Version history retained for 90 days minimum

---

### FEAT-30 — Global Search
**Problem:** Hundreds of jobs with no way to find anything without grep.  
**Solution:** Full-text search across job names, tags, logs, and output.  
**Acceptance Criteria:**
- Search bar in top navigation (keyboard shortcut: Cmd+K / Ctrl+K)
- Searches across: job names, descriptions, tags, log output
- Results grouped by type (jobs, runs, alerts)
- Debounced search (300ms)
- Keyboard navigable results
- Click result navigates to relevant page
- Empty state with suggestions when no results
- Search limited to user's accessible jobs (respects RBAC)

---

### FEAT-31 — Mobile Alerts & Responsive UI
**Problem:** On-call engineer away from laptop. Alert goes unseen.  
**Solution:** Mobile-responsive UI with push notifications and SMS.  
**Acceptance Criteria:**
- All dashboard pages responsive at 375px, 768px, 1280px breakpoints
- SMS alert support via Twilio (per FEAT-14)
- Mobile navigation collapses to hamburger menu
- Job cards stack vertically on mobile
- Charts readable on mobile (simplified version on small screens)
- Touch targets minimum 44×44px
- Test on iOS Safari and Android Chrome

---

### FEAT-32 — Job Pause / Suspend Mode
**Problem:** Need to pause a job during maintenance but deletion risks losing configuration.  
**Solution:** Suspend/resume toggle that stops monitoring without deleting job.  
**Acceptance Criteria:**
- Pause button on each job (with confirmation dialog)
- Paused jobs show blue "Paused" badge in dashboard
- No absence or heartbeat alerts fired for paused jobs
- Paused state persists across server restarts
- Resume button re-enables monitoring immediately
- Pause event logged in audit trail with user and timestamp
- Bulk pause option (select multiple jobs + pause all)

---

### FEAT-33 — Wrong User Context Validator
**Problem:** Job added to wrong user's crontab. Fails silently due to permission errors.  
**Solution:** Show which user owns each job; warn on common user-mismatch patterns.  
**Acceptance Criteria:**
- Agent reports the OS user running each job with heartbeat
- Dashboard shows "Running as: www-data" per job
- Warn if job is running as root but command path suggests it should run as another user
- Warn if job user changed between runs
- Mismatch alert includes: expected user, actual user, job name

---

### FEAT-34 — Secret Masking in Logs & UI
**Problem:** API keys visible in plain-text crontab and logs.  
**Solution:** Heuristic secret detection; mask values before storing logs.  
**Acceptance Criteria:**
- Scan stdout/stderr for patterns matching common secrets (API keys, tokens, passwords)
- Regex patterns: `sk-...`, `Bearer ...`, `password=...`, `token=...`, AWS key patterns
- Detected secrets replaced with `[REDACTED]` in stored logs
- Original log never stored (redaction happens before DB write)
- Warning shown in UI: "X potential secrets were redacted from this log"
- Configurable: user can add custom redaction patterns per job

---

### FEAT-35 — Role-Based Access Control
**Problem:** Anyone can edit or delete any job. No team-level permissions.  
**Solution:** Roles: Admin, Editor, Viewer — enforced on all API endpoints.  
**Acceptance Criteria:**
- Three roles: Admin (full access), Editor (create/edit jobs, view logs), Viewer (read-only)
- Roles assigned per user per team/workspace
- All API endpoints enforce role checks (401/403 on violations)
- UI hides controls the user doesn't have access to
- Role changes logged in audit trail
- Team owner always has Admin role (cannot be removed)
- Invitation system: invite by email with specified role

---

### FEAT-36 — Immutable Audit Log
**Problem:** Job config changed; no record of who did it or when.  
**Solution:** Append-only audit trail for every create/edit/delete action.  
**Acceptance Criteria:**
- Every mutating action logged: user, action type, target entity, before/after values, timestamp, IP
- Audit log is append-only (no deletes, no edits)
- Audit log page filterable by: user, action type, date range, entity type
- Export audit log as CSV
- Retained for minimum 12 months
- Accessible only to Admin role

---

### FEAT-37 — On-Call Schedule Routing
**Problem:** 3 AM alert goes to the whole team instead of the on-call engineer.  
**Solution:** On-call schedule integration; route alerts to current on-call person.  
**Acceptance Criteria:**
- On-call schedule defined per team: user + time window (start/end)
- Rotating schedules supported (weekly rotation)
- Alerts routed to on-call user via their configured channels
- Fallback: if on-call user has no alert channel, route to team Admin
- On-call calendar view showing upcoming rotations
- Override: manually set on-call user for a specific time window

---

### FEAT-38 — Inbound Webhook Trigger
**Problem:** Can't trigger a job from CI/CD or an external event.  
**Solution:** Unique inbound webhook URL per job that triggers a manual run.  
**Acceptance Criteria:**
- Each job gets a unique `POST /api/webhooks/trigger/:token` URL
- Webhook token shown in job settings; can be rotated
- Trigger logs: who called it, when, request payload (headers, body)
- Optional secret validation (HMAC signature)
- Trigger limited to 60 calls/hour per token
- Manual run triggered via webhook appears in run history as "Manual (Webhook)"
- Full error handling: invalid token (404), rate limit (429), job paused (409)

---

### FEAT-39 — Configurable Log Retention
**Problem:** Most tools cap logs at 30 days. Compliance needs 12+ months.  
**Solution:** Per-plan and per-job configurable retention policy.  
**Acceptance Criteria:**
- Retention options: 30d, 90d, 180d, 365d, Unlimited (per plan)
- Per-job override: set shorter retention to save storage
- Background job purges expired logs daily (soft-delete then hard-delete after 7 days)
- Dashboard shows storage used / limit per account
- Warning 30 days before logs would be purged
- Export logs before purge (ZIP download)
- Full error handling: purge job crash recovery (idempotent)

---

### FEAT-40 — Multi-Environment Workspaces
**Problem:** Dev, staging, and prod jobs mixed together with no separation.  
**Solution:** Workspace/environment separation with isolated dashboards.  
**Acceptance Criteria:**
- Workspaces: Production, Staging, Development (customizable names)
- Jobs belong to exactly one workspace
- Dashboard scoped to selected workspace (switcher in nav)
- Alert channels configured separately per workspace
- API keys scoped to workspace
- User access can be restricted per workspace
- Cross-workspace reporting for Admins (aggregate view)

---

### FEAT-41 — Job Health Heatmap
**Problem:** Hard to spot which day/time jobs consistently fail.  
**Solution:** Calendar heatmap of job health outcomes per day.  
**Acceptance Criteria:**
- GitHub-contribution-style calendar heatmap per job
- Color: green (all runs passed), yellow (some failed), red (all failed), gray (no runs)
- Hover shows: date, run count, success rate, avg duration
- Heatmap covers last 90 days
- Click a day to filter run history to that date
- Accessible: screen-reader labels per cell

---

### FEAT-42 — External Concurrency Lock
**Problem:** K8s `concurrencyPolicy: Forbid` fails silently; jobs still double-run.  
**Solution:** External distributed lock that enforces single-instance regardless of scheduler.  
**Acceptance Criteria:**
- Agent acquires lock via `POST /api/jobs/:id/lock` before starting job
- Lock is a DB-backed mutex with TTL (= job timeout + 10%)
- If lock exists: agent exits with code 0 (job skipped, not failed)
- Lock released via `DELETE /api/jobs/:id/lock` on completion
- Skipped runs logged as "Skipped (lock held)" in run history
- Lock status visible on job detail page (locked by / locked since / TTL remaining)

---

### FEAT-43 — Cloud-Native External Trigger
**Problem:** App service sleeping kills in-memory scheduled tasks.  
**Solution:** CronSentinel triggers the job externally via HTTP, independent of app state.  
**Acceptance Criteria:**
- Per-job config: `trigger_url` (HTTP endpoint to call) + method + headers + body
- CronSentinel calls the URL at scheduled time (not the app)
- Store: HTTP response code, response body, latency per trigger
- Retry on 5xx (up to 3 times with 30s backoff)
- Alert on: connection refused, timeout (configurable), 4xx/5xx response
- Trigger logs visible in run history
- Secret header support (e.g. `X-CronSentinel-Secret` for auth)

---

### FEAT-44 — Job Template Library
**Problem:** Teams reinvent the same DB backup, log cleanup, and report jobs from scratch.  
**Solution:** Built-in library of common job templates.  
**Acceptance Criteria:**
- Template library page at `/templates`
- At least 10 built-in templates: DB backup, log rotation, report generation, cache warmup, health check, data sync, cache clear, image cleanup, session cleanup, email digest
- Each template includes: name, description, default schedule, suggested timeout, heartbeat command
- "Use template" clones it into the user's job list for editing
- Community templates (user-submitted) in V3+
- Search/filter templates by category

---

### FEAT-45 — Public Status Page & Badge
**Problem:** Stakeholders keep asking "did the report run?" with no self-serve answer.  
**Solution:** Public status page and embeddable badge per job or job group.  
**Acceptance Criteria:**
- Public status page at `/status/:slug` (customizable slug)
- Shows selected jobs' last run status and time (no sensitive data)
- Embeddable SVG badge (like shields.io): `![Cron Status](https://app.cronsentinel.com/badge/:token)`
- Badge shows: status (passing/failing), last run time
- Badge cached at CDN for 60 seconds
- Status page customizable: logo, title, job selection
- Opt-in per job (disabled by default)

---

### FEAT-46 — Crontab Tampering Detection
**Problem:** Attackers persist by silently modifying crontab entries.  
**Solution:** Alert on unauthorized crontab modifications with before/after diff.  
**Acceptance Criteria:**
- Agent hashes crontab content every 5 minutes
- If hash changes: send full diff to `POST /api/crontab-snapshot` (per FEAT-07)
- Backend compares to last known-good snapshot
- If change not made via CronSentinel dashboard: fire "unexpected change" alert
- Alert severity: HIGH (potential security issue)
- Diff shown with line-by-line highlighting
- Integrates with SIEM via webhook (FEAT-14)

---

### FEAT-47 — Kubernetes CronJob Integration
**Problem:** K8s CronJob objects have no visibility into health without extra tooling.  
**Solution:** Native K8s integration via kubectl/API to monitor CronJob resources.  
**Acceptance Criteria:**
- CronSentinel agent runs as a K8s sidecar or DaemonSet
- Reads CronJob, Job, and Pod resources via K8s API
- Maps K8s CronJobs to CronSentinel jobs automatically
- Reports: last schedule time, last successful time, active job count, failed job count
- Pulls pod logs as execution logs
- Dashboard shows K8s-sourced jobs with K8s badge
- Handles multi-namespace and multi-cluster

---

### FEAT-48 — OpenTelemetry Export
**Problem:** Enterprise teams pipe all telemetry into OTEL stacks. Cron is a blind spot.  
**Solution:** Export job run metrics and events via OpenTelemetry protocol.  
**Acceptance Criteria:**
- Export spans per job run (start, end, duration, status as span attributes)
- Export metrics: job_run_total (counter), job_duration_ms (histogram), job_failed_total
- Configurable OTLP endpoint (OTLP/HTTP and OTLP/gRPC)
- Auth headers configurable for OTLP exporter
- Test connection button validates exporter config
- Traces show up in Jaeger/Tempo/Datadog with proper service.name

---

### FEAT-49 — Compliance Audit Reports
**Problem:** Finance and healthcare teams must prove jobs ran on schedule for audits.  
**Solution:** Exportable compliance report with SLA adherence proof.  
**Acceptance Criteria:**
- Report generator at `/reports/compliance`
- Select: date range, jobs to include, SLA window per job
- Report shows: each job, scheduled times, actual run times, duration, status, SLA met/breached
- Export as PDF (with logo, timestamp, report ID) and CSV
- Report signed with a hash (tamper-evident)
- Schedule auto-reports: email PDF monthly/weekly to configured recipients
- Report generation logged in audit trail

---

### FEAT-50 — Job Dependency Chains
**Problem:** Job B must run after Job A succeeds. Cron has no way to express this.  
**Solution:** DAG-style job dependency chains with pass/fail branching.  
**Acceptance Criteria:**
- Per-job: add upstream dependencies (other jobs in same workspace)
- Job only runs if all dependencies completed successfully in the same window
- Visual DAG editor showing dependency graph
- On dependency failure: downstream job is skipped (logged as "Skipped: dependency failed")
- Cycle detection: warn and block circular dependencies
- Dependency chains limited to 10 levels deep
- Alert if dependency chain takes longer than expected total window

---

## Completed Features

> Features that have been fully implemented, tested, and are in production.

- **2026-03-28** — FEAT-01 | Heartbeat Monitoring | Monitoring | MVP
- **2026-03-28** — FEAT-02 | Absence-Based Alerting | Monitoring | MVP (updated 2026-03-30: default `notify_heartbeat_missed=true`; unique `(job_id, scheduled_fire_at)` + insert-before-dispatch for multi-replica idempotency)
- **2026-03-28** — FEAT-03 | Execution Log Capture | Monitoring | MVP
- **2026-03-29** — FEAT-04 | Live Status Dashboard | Monitoring | MVP
- **2026-03-29** — FEAT-05 | Execution History Log | Monitoring | MVP
- **2026-03-29** — FEAT-06 | Daemon & Server Heartbeat | Reliability | MVP
- **2026-03-29** — FEAT-07 | Crontab Change Detection | Reliability | MVP
- **2026-03-29** — FEAT-08 | Job Timeout & Kill Switch | Reliability | MVP (`timeout_remote_kill_enabled`; agent polls `GET /api/jobs/:id/runs/pending-kill` + `POST .../kill-ack` with runs ingest token; 90s grace then `timed_out`; see [docs/agent-wrapper.md](docs/agent-wrapper.md); local execution + DB sweeper)
- **2026-03-29** — FEAT-09 | Visual Cron Builder | UX | MVP
- **2026-03-29** — FEAT-10 | Next-Run Previewer | UX | MVP
- **2026-03-29** — FEAT-11 | 60-Second Onboarding | UX | MVP (wizard + `GET/PATCH /api/settings/onboarding` on `account_billing` merged with localStorage)
- **2026-03-29** — FEAT-12 | No-Redeploy Schedule Editor | UX | MVP (`enabled` + `job_config_audit`; modal editor; optimistic save + retry; confirm on schedule/monitoring change for healthy jobs)
- **2026-03-29** — FEAT-13 | Secure Env Variable Manager | Security | MVP (AES-256-GCM at rest via `CRONSENTINEL_ENV_ENCRYPTION_KEY` or dev-derived key; `job_env_vars`; UI masked values + warnings; `GET/PUT/DELETE /api/jobs/:id/env`; agent `GET .../env/agent` with run-ingest token; log redaction on ingest + local runs; mock-backend parity)
- **2026-03-29** — FEAT-14 | Multi-Channel Alert Integrations | Integrations | MVP (`alert_channels`, `job_alert_channels`, `alert_delivery_log`; Slack + generic webhook + Twilio SMS; encrypted configs; unified dispatch with 3× exponential backoff; SMTP remains singleton `notification_settings`; per-job routing + SMTP sentinel `11111111-1111-1111-1111-111111111111`; `CRONSENTINEL_PUBLIC_BASE_URL` for UI links; Settings UI + edit-job channel picker; API `GET/POST/PATCH/DELETE /api/settings/alert-channels`, test + delivery log)
- **2026-03-30** — FEAT-15 | REST API | Integrations | MVP (`api_keys` table; bcrypt-hashed keys; `GET/POST/DELETE /api/settings/api-keys`; Bearer auth + 1000 req/hour per key on `/api/v1/*`; jobs/runs CRUD + cursor pagination + `GET /jobs/:id/heartbeat-token` + manual run; `{data,error,meta}` envelope; `/api/openapi.json` + `/api/docs` Swagger UI; Settings UI `ApiKeysSettings`)
- **2026-03-30** — FEAT-16 | Predictable Flat Pricing | DevX | MVP (`account_billing`; embedded `internal/pricing/default_pricing.json` + `CRONSENTINEL_PRICING_CONFIG` override; `CRONSENTINEL_PLAN` env overrides DB plan; `GET/PATCH /api/settings/billing`; monitor cap on `POST /api/jobs` + `POST /api/v1/jobs` (409 / `plan_limit_exceeded`); monthly alert cap in `notify.Dispatcher`; Settings `BillingSettings` + ≥80% banner; mock-backend parity)
- **2026-03-30** — FEAT-17 | Runtime Duration Trends | Monitoring | V2 (`GET /api/jobs/:id/runs/duration-trend?range=7d|30d|90d`; p50/p95/p99 via nearest-rank; `DurationTrendChart.tsx` + `durationTrendUtils.ts`; recharts `ComposedChart` + `Scatter` + `ReferenceLine`; outlier >&gt;2×p95 highlighted; 7d/30d/90d toggle; empty/loading/error states; pre-existing `v1ListJobs` scan bug for `remoteKill` fixed)
- **UI/UX Reviewed — 2026-03-29** — FEAT-12 pass: Arctic/Obsidian tokens + DM Sans / IBM Plex Mono + `data-theme` (`cs-theme`); edit-job confirm via `AlertDialog`; dialog overlay/shadow/radius; `CronExpressionHelper` / `NextRunPreviewer` typography and token-colored surfaces; theme toggle in main tabs. Files: [frontend/src/index.css](frontend/src/index.css), [frontend/src/main.tsx](frontend/src/main.tsx), [frontend/index.html](frontend/index.html), [frontend/src/components/theme-provider.tsx](frontend/src/components/theme-provider.tsx), [frontend/src/components/ui/dialog.tsx](frontend/src/components/ui/dialog.tsx), [frontend/src/components/ui/alert-dialog.tsx](frontend/src/components/ui/alert-dialog.tsx), [frontend/src/components/ui/sonner.tsx](frontend/src/components/ui/sonner.tsx), [frontend/src/features/layout/MainTabs.tsx](frontend/src/features/layout/MainTabs.tsx), [frontend/src/features/layout/ThemeToggle.tsx](frontend/src/features/layout/ThemeToggle.tsx), [frontend/src/App.tsx](frontend/src/App.tsx), [frontend/src/features/jobs/CronExpressionHelper.tsx](frontend/src/features/jobs/CronExpressionHelper.tsx), [frontend/src/features/jobs/NextRunPreviewer.tsx](frontend/src/features/jobs/NextRunPreviewer.tsx), [ui-audit-FEAT-12.md](ui-audit-FEAT-12.md).

---

## Notes for Cursor Agent

- Always check this file first before starting any work
- Pick the **first unchecked `[ ]` item** in the backlog
- Read its full specification in the Feature Specifications section
- After completing a feature:
  1. Check off the item: change `[ ]` to `[x]`
  2. Move the completed entry to the **Completed Features** section
  3. Add the completion date next to it
- Never skip a feature or work out of order without explicit instruction
- Always write tests, error handling, and production-ready code for every feature
