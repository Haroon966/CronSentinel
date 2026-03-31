import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Code2,
  Copy,
  Cpu,
  Download,
  FileCode2,
  HardDrive,
  History,
  Info,
  KeyRound,
  Loader2,
  Mail,
  Monitor,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Terminal,
  Timer,
  Trash2,
  Network,
  WifiOff,
  X,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import cronstrue from 'cronstrue'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { API_BASE_URL, apiFetch, downloadBlob, getFetchErrorMessage } from '@/lib/api'
import { cs } from '@/lib/csTheme'
import { getUxMetricsSnapshot, markJobCreateStarted, markJobCreated, markJobRunStarted, markLogsOpened } from '@/lib/uxMetrics'
import { rangeFromPreset, parseRunsRangePreset, type RunsRangePreset } from '@/features/runs/dateRangePresets'
import { isRunFailure, isRunSuccess, isRunTimedOut } from '@/features/runs/status'
import { LogHighlighter } from '@/features/runs/LogHighlighter'
import { DurationTrendChart } from '@/features/runs/DurationTrendChart'
import { CronExpressionHelper } from '@/features/jobs/CronExpressionHelper'
import { validateCron, validateJobName, validateCommand } from '@/features/jobs/validators'
import { validateScriptName } from '@/features/scripts/validators'
import { formatCountdown, nextRunFromCron } from '@/features/jobs/time'
import { MainTabs } from '@/features/layout/MainTabs'
import { ThemeToggle } from '@/features/layout/ThemeToggle'
import { Dashboard, type DashboardServerRow } from '@/features/dashboard/Dashboard'
import { CrontabDiffView } from '@/features/servers/CrontabDiffView'
import { OnboardingWizard } from '@/features/onboarding/OnboardingWizard'
import {
  getOnboardingState,
  markOnboardingSkipped,
  resetOnboardingJobProgress,
  shouldShowOnboardingGate,
} from '@/features/onboarding/onboardingStorage'
import { ApiKeysSettings } from '@/features/settings/ApiKeysSettings'
import { AlertChannelsSettings, type AlertChannelItem } from '@/features/settings/AlertChannelsSettings'
import { BillingSettings, type BillingDTO } from '@/features/settings/BillingSettings'
import { NotificationSettings } from '@/features/settings/NotificationSettings'
import { buildPathname, parsePathname, type Tab } from '@/lib/urlRouting'

// ─── Types ──────────────────────────────────────────────────────────────────

type SystemLoad = { load1: number; load5: number; load15: number }
type SystemMem = { total: number; used: number; free: number; used_percent: number }
type SystemHost = {
  hostname?: string
  os?: string
  platform?: string
  platform_family?: string
  platform_version?: string
  kernel_version?: string
  kernel_arch?: string
  boot_time_unix?: number
  virtualization_system?: string
  virtualization_role?: string
}
type SystemCPU = {
  model_name?: string
  logical_cores?: number
  physical_cores?: number
  mhz_max?: number
}
type SystemDisk = {
  path: string
  fstype?: string
  total: number
  used: number
  free: number
  used_percent: number
}
type SystemNet = {
  name: string
  bytes_sent: number
  bytes_recv: number
  packets_sent: number
  packets_recv: number
}
type SystemGPUDevice = { name: string; vendor?: string; driver?: string }
type SystemGPU = { status: string; reason?: string; devices?: SystemGPUDevice[] }
type SystemInfo = {
  uptime_seconds?: number
  cpu_count?: number
  host?: SystemHost
  cpu?: SystemCPU
  memory?: SystemMem
  swap?: SystemMem
  load?: SystemLoad
  disks?: SystemDisk[]
  network?: SystemNet[]
  gpu?: SystemGPU
  errors?: string[]
}

type Script = { name: string; content: string; created_at: string }
type Job = {
  id: string; name: string; schedule: string
  timezone?: string
  command: string; working_directory?: string; venv_path?: string; comment: string
  logging_enabled: boolean; timeout_seconds: number
  timeout_remote_kill_enabled?: boolean
  heartbeat_token?: string
  heartbeat_grace_seconds?: number
  last_heartbeat_at?: string | null
  heartbeat_status?: string
  heartbeat_deadline_at?: string
  heartbeat_prev_fire_at?: string
  heartbeat_interval_seconds?: number
  heartbeat_first_ping_due_by?: string
  runs_ingest_token?: string
  success_exit_code?: number
  dashboard_status?: string
  last_run_status?: string | null
  last_run_at?: string | null
  last_run_duration_ms?: number | null
  enabled?: boolean
  alert_use_default_channels?: boolean
  alert_channel_ids?: string[]
}

type JobEnvItem = { name: string; masked_value: string; sensitive_hint?: boolean }
type JobEnvPutResponse = { ok?: boolean; name?: string; masked_value?: string; warnings?: string[] }

/** Body for PUT /api/jobs/:id (venv_path is UI-only; not sent). */
type JobPutBody = {
  name: string
  schedule: string
  timezone: string
  working_directory: string
  command: string
  comment: string
  logging_enabled: boolean
  timeout_seconds: number
  timeout_remote_kill_enabled?: boolean
  heartbeat_grace_seconds: number
  success_exit_code: number
  enabled: boolean
  alert_routing?: { use_default_channels: boolean; channel_ids: string[] }
}
type Run = {
  id: string; job_id?: string; job_name: string
  command?: string
  status: string; exit_code?: number
  started_at: string; ended_at?: string
  failure_reason: string; failure_fix: string
  duration_ms?: number
  stdout_truncated?: boolean
  stderr_truncated?: boolean
  log_preview?: string
}
type Preset = { label: string; schedule: string }
type MonitoredServer = {
  id: string
  name: string
  created_at: string
  last_seen_at: string | null
  health: DashboardServerRow['health']
  crontab_poll_interval_seconds?: number
}

type CrontabSnapshotRow = {
  id: string
  created_at: string
  content_hash: string
  user_context: string
  capture_error?: string | null
  diff_from_previous?: string | null
}
type ScheduleMode = 'cron' | 'human' | 'both'
type RunsResponse = { items: Run[]; total: number; limit: number; offset: number; has_more: boolean }
const VALID_TABS: Tab[] = ['dashboard', 'jobs', 'scripts', 'runs', 'servers', 'settings']
/** Matches backend notify.SMTPSentinelJobChannelID for per-job custom alert routing. */
const SMTP_ALERT_CHANNEL_SENTINEL = '11111111-1111-1111-1111-111111111111'
const VALID_RUN_FILTERS = ['all', 'running', 'success', 'failed', 'timed_out'] as const
type RunsFilter = (typeof VALID_RUN_FILTERS)[number]

// ─── Utilities ───────────────────────────────────────────────────────────────

function formatUptime(s: number) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d} day${d > 1 ? 's' : ''}, ${h} hours`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function formatBytes(b: number) {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`
  if (b >= 1e6) return `${(b / 1e6).toFixed(0)} MB`
  return `${b} B`
}

function buildOsPrimaryLine(h: SystemInfo['host']): string {
  if (!h) return '—'
  const plat = [h.platform, h.platform_version].filter(Boolean).join(' ').trim()
  const os = (h.os || '').trim()
  if (plat && os) return `${plat} (${os})`
  if (plat) return plat
  if (os) return os
  return '—'
}

function formatBootTimeUnix(ts: number | undefined): string {
  if (ts == null || ts === 0) return '—'
  try {
    return new Date(ts * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return '—'
  }
}

function kernelArchLine(h: SystemInfo['host']): string {
  if (!h) return ''
  const k = [h.kernel_version, h.kernel_arch].filter(Boolean)
  return k.join(' · ')
}

function logicalCpuCount(sys: SystemInfo): number | undefined {
  return sys.cpu?.logical_cores ?? sys.cpu_count
}

function cpuProductName(sys: SystemInfo): string {
  return (sys.cpu?.model_name ?? '').trim()
}

/** Logical + physical core summary for System Information. */
function formatCpuCoresDetail(sys: SystemInfo): string {
  const n = logicalCpuCount(sys)
  if (n == null) return '—'
  let s = `${n} logical`
  const phys = sys.cpu?.physical_cores
  if (phys != null && phys > 0) s += ` · ${phys} physical`
  s += n === 1 ? ' core' : ' cores'
  return s
}

/** Safe cronstrue wrapper — returns human-readable text or the raw spec on failure. */
function cronToHuman(spec: string): string {
  try {
    return cronstrue.toString(spec.trim(), { throwExceptionOnParseError: true })
  } catch {
    return spec
  }
}

function runDuration(r: Run): string {
  if (!r.ended_at) return ''
  const ms = new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
}

/** Full URL for POST heartbeat (uses page origin when API is same-origin). */
function heartbeatRequestUrl(token: string): string {
  const base = (API_BASE_URL.trim() !== '' ? API_BASE_URL : (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/$/, '')
  return `${base}/api/heartbeat/${encodeURIComponent(token)}`
}

function apiOriginBase(): string {
  return (API_BASE_URL.trim() !== '' ? API_BASE_URL : (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/$/, '')
}

function runIngestUrl(jobId: string): string {
  return `${apiOriginBase()}/api/jobs/${encodeURIComponent(jobId)}/runs`
}

function runIngestCurlExample(jobId: string, token: string): string {
  const u = runIngestUrl(jobId)
  return `curl -sS -X POST '${u}' \\\n  -H 'Authorization: Bearer ${token}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"exit_code":0,"stdout":"ok","stderr":"","duration_ms":100,"started_at":"2026-03-28T12:00:00Z"}'`
}

function jobEnvAgentUrl(jobId: string): string {
  return `${apiOriginBase()}/api/jobs/${encodeURIComponent(jobId)}/env/agent`
}

function jobEnvFetchCurlExample(jobId: string, token: string): string {
  const u = jobEnvAgentUrl(jobId)
  return `curl -sS '${u}' \\\n  -H 'Authorization: Bearer ${token}' \\\n  -H 'Accept: application/json'`
}

function serverHeartbeatRequestUrl(token: string): string {
  return `${apiOriginBase()}/api/server-heartbeat/${encodeURIComponent(token)}`
}

/** Suggested user-crontab line (~60s). */
function serverHeartbeatCronLine(token: string): string {
  const u = serverHeartbeatRequestUrl(token)
  return `* * * * * curl -fsS -X POST '${u}' -H 'Content-Type: text/plain' --data-raw 'ok' >/dev/null 2>&1`
}

function crontabSnapshotPostUrl(token: string): string {
  return `${apiOriginBase()}/api/crontab-snapshot/${encodeURIComponent(token)}`
}

function formatHeartbeatTs(iso: string | null | undefined): string {
  if (iso == null || iso === '') return '—'
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' })
  } catch {
    return String(iso)
  }
}

function HeartbeatStatusBadge({ status }: { status?: string }) {
  const s = (status || 'never').toLowerCase()
  const cls =
    s === 'healthy'
      ? cs.healthy.surface
      : s === 'late'
        ? cs.late.surface
        : s === 'dead'
          ? cs.failed.surface
          : 'bg-muted/60 border-border/50 text-muted-foreground'
  const label =
    s === 'healthy' ? 'Heartbeat OK' : s === 'late' ? 'Heartbeat late' : s === 'dead' ? 'Heartbeat missed' : 'No ping yet'
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${cls}`}
      title="Based on schedule, grace period, and last POST to the heartbeat URL"
    >
      <Activity className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
      {label}
    </span>
  )
}

function formatLogSize(stdout: string, stderr: string) {
  const bytes = new TextEncoder().encode(`${stdout}${stderr}`).length
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`
  return `${bytes} B`
}

function parsePositiveInt(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** Standard UUID only. Malformed values would make GET /api/runs return 400 and fail the whole refresh batch. */
function parseRunsJobIdFromUrl(raw: string | null): string {
  const s = (raw ?? '').trim()
  if (!s) return ''
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return s
  return ''
}

function buildInitialStateFromUrl(pathname: string, search: string) {
  const pathInfo = parsePathname(pathname)
  const params = new URLSearchParams(search)
  const tabParam = params.get('tab')
  const runsFilterParam = params.get('runsFilter')
  const runsRange = parseRunsRangePreset(params.get('runsRange'))
  let runsStartedAfter = params.get('runsStartedAfter') ?? ''
  let runsStartedBefore = params.get('runsStartedBefore') ?? ''
  if (runsRange === '7d' || runsRange === '30d' || runsRange === '90d') {
    const r = rangeFromPreset(runsRange)
    runsStartedAfter = r.startedAfter
    runsStartedBefore = r.startedBefore
  } else if (runsRange === 'all') {
    runsStartedAfter = ''
    runsStartedBefore = ''
  }
  let activeTab = pathInfo.tab
  let runsJobId = pathInfo.runsJobId
  if (tabParam && VALID_TABS.includes(tabParam as Tab)) {
    activeTab = tabParam as Tab
  }
  const qJob = parseRunsJobIdFromUrl(params.get('runsJobId'))
  if (qJob) runsJobId = qJob
  return {
    activeTab,
    runsFilter: (VALID_RUN_FILTERS.includes(runsFilterParam as RunsFilter) ? runsFilterParam : 'all') as RunsFilter,
    runsSearch: params.get('runsSearch') ?? '',
    runsJobId,
    runsPageSize: parsePositiveInt(params.get('runsPageSize'), 25, 25, 100),
    runsOffset: parsePositiveInt(params.get('runsOffset'), 0, 0, 1_000_000),
    runsStartedAfter,
    runsStartedBefore,
    runsMinDurationMs: params.get('runsMinDurationMs') ?? '',
    runsMaxDurationMs: params.get('runsMaxDurationMs') ?? '',
    runsRange,
  }
}

// ─── Pure sub-components ─────────────────────────────────────────────────────

function ProgressBar({ pct, warn = 70, danger = 90 }: { pct: number; warn?: number; danger?: number }) {
  const color = pct >= danger ? 'bg-[var(--cs-failed)]' : pct >= warn ? 'bg-[var(--cs-late)]' : 'bg-[var(--cs-healthy)]'
  return (
    <div className="h-1.5 w-full rounded-full bg-border/50 overflow-hidden">
      <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  )
}

/** 5 colored dots showing the last 5 run outcomes for a job. */
function RunDots({ jobId, runs }: { jobId: string; runs: Run[] }) {
  const history = runs.filter(r => r.job_id === jobId).slice(0, 5)
  return (
    <div className="flex gap-1 shrink-0" aria-label="Last 5 run results">
      {Array.from({ length: 5 }, (_, i) => {
        const r = history[i]
        const s = r?.status.toLowerCase() ?? null
        const color = s == null ? 'bg-border' :
          ['success', 'ok', 'completed'].includes(s) ? 'bg-[var(--cs-healthy)]' :
          s === 'timed_out' ? 'bg-[var(--cs-late)]' :
          s.includes('fail') || s.includes('error') ? 'bg-[var(--cs-failed)]' : 'bg-[var(--cs-pending)]'
        return (
          <span
            key={i}
            className={`h-2.5 w-2.5 rounded-full ${color}`}
            title={r ? `${r.status} — ${new Date(r.started_at).toLocaleString()}` : 'No run'}
          />
        )
      })}
    </div>
  )
}

/** Status badge: color + icon, never color alone. */
function RunBadge({ status }: { status: string }) {
  const s = status.toLowerCase()
  if (isRunSuccess(status))
    return (
      <Badge className={`${cs.healthy.surface} hover:opacity-95 gap-1 border text-xs`}>
        <Check className="h-2.5 w-2.5" />{status}
      </Badge>
    )
  if (isRunTimedOut(status))
    return (
      <Badge className={`${cs.late.surface} hover:opacity-95 gap-1 border text-xs`}>
        <Timer className="h-2.5 w-2.5" />timed out
      </Badge>
    )
  if (isRunFailure(status))
    return <Badge variant="destructive" className="gap-1 text-xs"><X className="h-2.5 w-2.5" />{status}</Badge>
  if (['running', 'pending', 'started'].includes(s))
    return (
      <Badge
        className="gap-1 border border-[var(--cs-border-medium)] bg-[var(--cs-accent-subtle)] text-[var(--cs-accent-text)] hover:opacity-95 text-xs"
      >
        <Loader2 className="h-2.5 w-2.5 motion-safe:animate-spin" />{status}
      </Badge>
    )
  return <Badge variant="secondary" className="text-xs">{status}</Badge>
}

function FieldError({ msg, id }: { msg: string; id: string }) {
  if (!msg) return null
  return (
    <p id={id} role="alert" className="flex items-center gap-1 text-xs text-destructive mt-1">
      <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />{msg}
    </p>
  )
}

/** Shared expanded stdout/stderr block for run history (list + table). */
function RunHistoryLogPanel({
  run,
  logsLoading,
  logsStdout,
  logsStderr,
  logsTruncOut,
  logsTruncErr,
}: {
  run: Run
  logsLoading: boolean
  logsStdout: string
  logsStderr: string
  logsTruncOut: boolean
  logsTruncErr: boolean
}): ReactElement {
  return (
    <div className="border-t border-border/50 px-4 py-3 bg-muted/20" aria-label="Run logs">
      {logsLoading ? (
        <div className="flex items-center gap-2 py-2 text-muted-foreground" aria-busy="true">
          <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />
          <span className="text-xs">Loading logs…</span>
        </div>
      ) : (
        <div className="space-y-2">
          {(run.stdout_truncated || run.stderr_truncated || logsTruncOut || logsTruncErr) && (
            <div className={`rounded border px-3 py-2 text-xs ${cs.late.surface}`} role="status">
              Log output was truncated at 1 MB per stream on ingest.
              {(run.stdout_truncated || logsTruncOut) && ' stdout'}
              {(run.stderr_truncated || logsTruncErr) && ' stderr'}
            </div>
          )}
          {run.failure_fix && (
            <div className={`rounded border px-3 py-2 ${cs.late.surface}`}>
              <p className="text-xs font-semibold uppercase tracking-wider mb-0.5 opacity-90">Suggested fix</p>
              <p className="text-sm opacity-95">{run.failure_fix}</p>
            </div>
          )}
          {(['stdout', 'stderr'] as const).map((pipe) => (
            <div key={pipe}>
              <div className="flex items-center gap-1.5 mb-1">
                <span
                  className={`h-2 w-2 rounded-full ${pipe === 'stdout' ? cs.healthy.dot : cs.failed.dot}`}
                  aria-hidden="true"
                />
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{pipe}</span>
              </div>
              <div role="log" aria-live="polite" aria-label={`Standard ${pipe === 'stdout' ? 'output' : 'error'}`}>
                {pipe === 'stdout' && <Terminal className="mb-1.5 h-3 w-3 text-muted-foreground" aria-hidden="true" />}
                <LogHighlighter
                  text={(pipe === 'stdout' ? logsStdout : logsStderr) || '(empty)'}
                  variant={pipe === 'stdout' ? 'stdout' : 'stderr'}
                  dense
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main App ────────────────────────────────────────────────────────────────

export default function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const initialUiState = useMemo(
    () => buildInitialStateFromUrl(location.pathname, location.search),
    [],
  )

  // ── Data state ────────────────────────────────────────────────────────────
  const [scripts, setScripts]   = useState<Script[]>([])
  const [jobs, setJobs]         = useState<Job[]>([])
  const [runs, setRuns]         = useState<Run[]>([])
  const [system, setSystem]     = useState<SystemInfo>({})
  const [presets, setPresets]   = useState<Preset[]>([])
  const [servers, setServers]   = useState<MonitoredServer[]>([])

  // ── Connectivity ──────────────────────────────────────────────────────────
  const [apiOnline, setApiOnline]   = useState<boolean | null>(null)
  const [billing, setBilling] = useState<BillingDTO | null>(null)
  const [billingError, setBillingError] = useState<string | null>(null)
  const [billingBannerDismissed, setBillingBannerDismissed] = useState(false)
  const [onboardingServer, setOnboardingServer] = useState<{ completed: boolean; skipped: boolean } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [, bumpOnboarding] = useState(0)

  // ── UI state ──────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab]         = useState<Tab>(initialUiState.activeTab)
  const [sidebarOpen, setSidebarOpen]     = useState(true)
  const [minimalMode, setMinimalMode]     = useState(() => {
    try { return localStorage.getItem('cronsentinel-minimal-mode') === 'true' } catch { return false }
  })
  const [scheduleMode, setScheduleMode]   = useState<ScheduleMode>(() => {
    try {
      const s = localStorage.getItem('cronsentinel-schedule-mode')
      return (s === 'cron' || s === 'human' || s === 'both') ? s : 'both'
    } catch { return 'both' }
  })
  const [jobSearch, setJobSearch]         = useState('')
  const [runsFilter, setRunsFilter]       = useState<RunsFilter>(initialUiState.runsFilter)
  const [runsSearch, setRunsSearch]       = useState(initialUiState.runsSearch)
  const [runsJobId, setRunsJobId]         = useState(initialUiState.runsJobId)
  const [runsPageSize, setRunsPageSize]   = useState(initialUiState.runsPageSize)
  const [runsOffset, setRunsOffset]       = useState(initialUiState.runsOffset)
  const [runsStartedAfter, setRunsStartedAfter] = useState(initialUiState.runsStartedAfter)
  const [runsStartedBefore, setRunsStartedBefore] = useState(initialUiState.runsStartedBefore)
  const [runsMinDurationMs, setRunsMinDurationMs] = useState(initialUiState.runsMinDurationMs)
  const [runsMaxDurationMs, setRunsMaxDurationMs] = useState(initialUiState.runsMaxDurationMs)
  const [runsRangePreset, setRunsRangePreset] = useState<RunsRangePreset>(initialUiState.runsRange)
  const [runsTotal, setRunsTotal]         = useState(0)
  const [runsHasMore, setRunsHasMore]     = useState(false)
  const [runsCompactMode, setRunsCompactMode] = useState(false)
  const [showJobForm, setShowJobForm]     = useState(false)
  const [showJobAdvanced, setShowJobAdvanced] = useState(false)
  const [showEditAdvanced, setShowEditAdvanced] = useState(false)
  const [showScriptForm, setShowScriptForm] = useState(false)
  const [selectedRun, setSelectedRun]     = useState<string>('')
  const [logsLoading, setLogsLoading]     = useState(false)
  const [logs, setLogs]                   = useState({ stdout: '', stderr: '' })
  const [logsTrunc, setLogsTrunc]         = useState({ stdout: false, stderr: false })
  const [logsModalJobId, setLogsModalJobId] = useState<string | null>(null)
  const [logsModalRunId, setLogsModalRunId] = useState('')
  const [modalLogsLoading, setModalLogsLoading] = useState(false)
  const [modalLogs, setModalLogs] = useState({ stdout: '', stderr: '' })
  const [modalLogsTrunc, setModalLogsTrunc] = useState({ stdout: false, stderr: false })
  const [logsModalAutoFollow, setLogsModalAutoFollow] = useState(false)
  const logsModalTitleId = useId()
  const logsModalDescriptionId = useId()

  // ── Per-action loading ────────────────────────────────────────────────────
  const [scriptSaving, setScriptSaving]     = useState(false)
  const [jobSaving, setJobSaving]           = useState(false)
  const [deletingScript, setDeletingScript] = useState<string | null>(null)
  const [deletingJob, setDeletingJob]       = useState<string | null>(null)
  const [runningJob, setRunningJob]         = useState<string | null>(null)
  const [emailHistorySending, setEmailHistorySending] = useState(false)
  const [runsCsvDownloading, setRunsCsvDownloading] = useState(false)
  const [newServerName, setNewServerName] = useState('')
  const [serverRegistering, setServerRegistering] = useState(false)
  const [deletingServerId, setDeletingServerId] = useState<string | null>(null)
  const [confirmDeleteServer, setConfirmDeleteServer] = useState<string | null>(null)
  const [lastCreatedServerToken, setLastCreatedServerToken] = useState<{ name: string; token: string } | null>(null)
  const [crontabSectionOpen, setCrontabSectionOpen] = useState<Record<string, boolean>>({})
  const [crontabSnapshotsByServer, setCrontabSnapshotsByServer] = useState<Record<string, CrontabSnapshotRow[]>>({})
  const [crontabSnapLoading, setCrontabSnapLoading] = useState<string | null>(null)
  const [pollIntervalDraft, setPollIntervalDraft] = useState<Record<string, string>>({})
  const [pollSavingId, setPollSavingId] = useState<string | null>(null)
  const pendingEditPutRef = useRef<JobPutBody | null>(null)
  const pendingEditJobsSnapshotRef = useRef<Job[] | null>(null)

  // ── Edit job ──────────────────────────────────────────────────────────────
  const [editingJobId, setEditingJobId]   = useState<string | null>(null)
  const [editJob, setEditJob]             = useState({
    name: '',
    schedule: '',
    timezone: 'Local',
    command: '',
    working_directory: '',
    venv_path: '',
    comment: '',
    logging_enabled: true,
    timeout_seconds: 300,
    timeout_remote_kill_enabled: false,
    heartbeat_grace_minutes: 5,
    success_exit_code: 0,
    enabled: true,
    alert_use_default_channels: true,
    alert_channel_ids: [] as string[],
  })
  const [editJobErrors, setEditJobErrors] = useState({ name: '', schedule: '', command: '' })
  const [editJobSaving, setEditJobSaving] = useState(false)
  const [editJobScheduleConfirmOpen, setEditJobScheduleConfirmOpen] = useState(false)
  const editJobConfirmDescId = useId()
  const [alertChannelPickList, setAlertChannelPickList] = useState<AlertChannelItem[]>([])

  // ── Delete confirmation ───────────────────────────────────────────────────
  const [confirmDeleteScript, setConfirmDeleteScript] = useState<string | null>(null)
  const [confirmDeleteJob, setConfirmDeleteJob]       = useState<string | null>(null)
  const [jobEnvById, setJobEnvById]                   = useState<Record<string, JobEnvItem[]>>({})
  const [jobEnvDraftById, setJobEnvDraftById]         = useState<Record<string, { name: string; value: string }>>({})
  const [jobEnvSavingId, setJobEnvSavingId]           = useState<string | null>(null)
  const [confirmDeleteEnv, setConfirmDeleteEnv]       = useState<{ jobId: string; name: string } | null>(null)

  // ── Form state ────────────────────────────────────────────────────────────
  const [newScript, setNewScript] = useState({ name: '', content: 'echo "hello from script"' })
  const [newJob, setNewJob]       = useState({
    name: '', schedule: '*/5 * * * *', command: 'echo "cron test"',
    timezone: 'Local', working_directory: '', venv_path: '', comment: '', logging_enabled: true, timeout_seconds: 300,
    timeout_remote_kill_enabled: false,
    heartbeat_grace_seconds: 300,
    success_exit_code: 0,
    enabled: true,
  })
  const [scriptErrors, setScriptErrors] = useState({ name: '' })
  const [jobErrors, setJobErrors]       = useState({ name: '', schedule: '', command: '' })

  // ── Refresh ───────────────────────────────────────────────────────────────
  const refresh = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true)
    try {
      const runsParams = new URLSearchParams({
        limit: String(runsPageSize),
        offset: String(runsOffset),
        status: runsFilter,
      })
      if (runsSearch.trim()) runsParams.set('search', runsSearch.trim())
      if (runsStartedAfter.trim()) runsParams.set('started_after', runsStartedAfter.trim())
      if (runsStartedBefore.trim()) runsParams.set('started_before', runsStartedBefore.trim())
      if (runsMinDurationMs.trim()) runsParams.set('min_duration_ms', runsMinDurationMs.trim())
      if (runsMaxDurationMs.trim()) runsParams.set('max_duration_ms', runsMaxDurationMs.trim())
      if (runsJobId.trim()) runsParams.set('job_id', runsJobId.trim())
      const billingFetch = apiFetch<{ billing: BillingDTO }>(`${API_BASE_URL}/api/settings/billing`)
        .then(r => ({ ok: true as const, data: r.billing }))
        .catch((e: unknown) => ({ ok: false as const, err: getFetchErrorMessage(e) }))
      const onboardingFetch = apiFetch<{ onboarding?: { completed_at?: string | null; skipped?: boolean } }>(
        `${API_BASE_URL}/api/settings/onboarding`,
      )
        .then(r => ({
          ok: true as const,
          completed: Boolean(r?.onboarding?.completed_at),
          skipped: Boolean(r?.onboarding?.skipped),
        }))
        .catch(() => ({ ok: false as const }))

      const [sc, jb, ru, sy, pr, sv, billOut, obOut] = await Promise.all([
        apiFetch<Script[]>(`${API_BASE_URL}/api/scripts`),
        apiFetch<Job[]>(`${API_BASE_URL}/api/jobs`),
        apiFetch<RunsResponse>(`${API_BASE_URL}/api/runs?${runsParams.toString()}`),
        apiFetch<SystemInfo>(`${API_BASE_URL}/api/system`),
        apiFetch<Preset[]>(`${API_BASE_URL}/api/jobs/presets`),
        apiFetch<MonitoredServer[]>(`${API_BASE_URL}/api/servers`),
        billingFetch,
        onboardingFetch,
      ])
      if (obOut.ok) {
        setOnboardingServer({ completed: obOut.completed, skipped: obOut.skipped })
      } else {
        setOnboardingServer(null)
      }
      if (billOut.ok) {
        setBilling(billOut.data)
        setBillingError(null)
      } else {
        setBillingError(billOut.err)
      }
      setScripts(sc ?? []); setJobs(jb ?? []); setRuns(ru?.items ?? [])
      setServers(Array.isArray(sv) ? sv : [])
      setRunsTotal(ru?.total ?? 0)
      setRunsHasMore(Boolean(ru?.has_more))
      setSystem(sy ?? {}); setPresets(pr ?? [])
      setApiOnline(true)
    } catch (err) {
      setApiOnline(false)
      if (showSpinner) toast.error('Refresh failed', { description: getFetchErrorMessage(err) })
    } finally { if (showSpinner) setRefreshing(false) }
  }, [runsFilter, runsOffset, runsPageSize, runsSearch, runsJobId, runsStartedAfter, runsStartedBefore, runsMinDurationMs, runsMaxDurationMs])

  const showOnboarding = shouldShowOnboardingGate(getOnboardingState(), apiOnline === true, jobs.length, onboardingServer)

  const emailFilteredRuns = useCallback(async () => {
    const limit = Math.min(500, Math.max(1, runsTotal))
    if (!window.confirm(`Send an email with up to ${limit} run(s) (newest first) matching your current filters to the addresses configured in Settings?`)) return
    setEmailHistorySending(true)
    try {
      const res = await apiFetch<{ status: string; run_count?: number }>(`${API_BASE_URL}/api/runs/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: runsFilter,
          search: runsSearch.trim(),
          job_id: runsJobId.trim(),
          limit,
        }),
      })
      toast.message('Run history email queued', {
        description: `${res?.run_count ?? 0} run(s) included in the message.`,
      })
    } catch (e) {
      toast.error('Email export failed', { description: getFetchErrorMessage(e) })
    } finally {
      setEmailHistorySending(false)
    }
  }, [runsFilter, runsSearch, runsJobId, runsTotal])

  const buildRunsExportQueryString = useCallback((): string => {
    const runsParams = new URLSearchParams({ limit: '500', status: runsFilter })
    if (runsSearch.trim()) runsParams.set('search', runsSearch.trim())
    if (runsStartedAfter.trim()) runsParams.set('started_after', runsStartedAfter.trim())
    if (runsStartedBefore.trim()) runsParams.set('started_before', runsStartedBefore.trim())
    if (runsMinDurationMs.trim()) runsParams.set('min_duration_ms', runsMinDurationMs.trim())
    if (runsMaxDurationMs.trim()) runsParams.set('max_duration_ms', runsMaxDurationMs.trim())
    if (runsJobId.trim()) runsParams.set('job_id', runsJobId.trim())
    return runsParams.toString()
  }, [runsFilter, runsSearch, runsJobId, runsStartedAfter, runsStartedBefore, runsMinDurationMs, runsMaxDurationMs])

  const exportRunsCsv = useCallback(async () => {
    const qs = buildRunsExportQueryString()
    setRunsCsvDownloading(true)
    try {
      await downloadBlob(`${API_BASE_URL}/api/runs/export.csv?${qs}`, 'runs-export.csv')
      toast.success('CSV download started')
    } catch (e) {
      toast.error('CSV export failed', { description: getFetchErrorMessage(e) })
    } finally {
      setRunsCsvDownloading(false)
    }
  }, [buildRunsExportQueryString])

  useEffect(() => { refresh(); const t = setInterval(() => refresh(), 5000); return () => clearInterval(t) }, [refresh])

  useEffect(() => {
    let cancelled = false
    if (jobs.length === 0) {
      setJobEnvById({})
      return
    }
    void Promise.all(
      jobs.map(async j => {
        try {
          const r = await apiFetch<{ items: JobEnvItem[] }>(`${API_BASE_URL}/api/jobs/${encodeURIComponent(j.id)}/env`)
          return { id: j.id, items: r.items ?? [] }
        } catch {
          return { id: j.id, items: [] as JobEnvItem[] }
        }
      }),
    ).then(rows => {
      if (cancelled) return
      const m: Record<string, JobEnvItem[]> = {}
      for (const x of rows) m[x.id] = x.items
      setJobEnvById(m)
    })
    return () => {
      cancelled = true
    }
  }, [jobs])

  const saveJobEnvVar = useCallback(
    async (jobId: string) => {
      const draft = jobEnvDraftById[jobId] ?? { name: '', value: '' }
      const name = draft.name.trim()
      if (!name) {
        toast.error('Variable name is required')
        return
      }
      setJobEnvSavingId(jobId)
      try {
        const res = await apiFetch<JobEnvPutResponse>(
          `${API_BASE_URL}/api/jobs/${encodeURIComponent(jobId)}/env`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, value: draft.value }),
          },
        )
        const list = await apiFetch<{ items: JobEnvItem[] }>(`${API_BASE_URL}/api/jobs/${encodeURIComponent(jobId)}/env`)
        setJobEnvById(prev => ({ ...prev, [jobId]: list.items ?? [] }))
        setJobEnvDraftById(prev => ({ ...prev, [jobId]: { name: '', value: '' } }))
        const w = res.warnings ?? []
        if (w.length) {
          toast.message('Saved with warnings', { description: w.join(' · ') })
        } else {
          toast.success('Environment variable saved', { description: `${name} = ${res.masked_value ?? '****'}` })
        }
      } catch (e) {
        toast.error('Save failed', { description: getFetchErrorMessage(e) })
      } finally {
        setJobEnvSavingId(null)
      }
    },
    [jobEnvDraftById],
  )

  const removeJobEnvVar = useCallback(async (jobId: string, name: string) => {
    try {
      await apiFetch(
        `${API_BASE_URL}/api/jobs/${encodeURIComponent(jobId)}/env?name=${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      )
      setJobEnvById(prev => ({
        ...prev,
        [jobId]: (prev[jobId] ?? []).filter(x => x.name !== name),
      }))
      toast.success('Environment variable removed', { description: name })
    } catch (e) {
      toast.error('Delete failed', { description: getFetchErrorMessage(e) })
    }
  }, [])

  useEffect(() => {
    if (apiOnline !== true) return
    const ob = getOnboardingState()
    if (!ob.jobId || ob.completed || ob.skipped) return
    if (!jobs.some(j => j.id === ob.jobId)) {
      resetOnboardingJobProgress()
      bumpOnboarding(x => x + 1)
      toast.info('Your onboarding job was removed — wizard restarted from step 1.')
    }
  }, [apiOnline, jobs])

  useLayoutEffect(() => {
    const ui = buildInitialStateFromUrl(location.pathname, location.search)
    setActiveTab(ui.activeTab)
    setRunsFilter(ui.runsFilter)
    setRunsSearch(ui.runsSearch)
    setRunsJobId(ui.runsJobId)
    setRunsPageSize(ui.runsPageSize)
    setRunsOffset(ui.runsOffset)
    setRunsStartedAfter(ui.runsStartedAfter)
    setRunsStartedBefore(ui.runsStartedBefore)
    setRunsMinDurationMs(ui.runsMinDurationMs)
    setRunsMaxDurationMs(ui.runsMaxDurationMs)
    setRunsRangePreset(ui.runsRange)
  }, [location.pathname, location.search])

  useEffect(() => {
    const path = buildPathname(activeTab, runsJobId)
    const params = new URLSearchParams()
    if (activeTab === 'runs') {
      params.set('runsFilter', runsFilter)
      if (runsSearch.trim()) params.set('runsSearch', runsSearch.trim())
      params.set('runsPageSize', String(runsPageSize))
      params.set('runsOffset', String(runsOffset))
      if (runsStartedAfter.trim()) params.set('runsStartedAfter', runsStartedAfter.trim())
      if (runsStartedBefore.trim()) params.set('runsStartedBefore', runsStartedBefore.trim())
      if (runsMinDurationMs.trim()) params.set('runsMinDurationMs', runsMinDurationMs.trim())
      if (runsMaxDurationMs.trim()) params.set('runsMaxDurationMs', runsMaxDurationMs.trim())
      if (runsJobId.trim()) params.set('runsJobId', runsJobId.trim())
      params.set('runsRange', runsRangePreset)
    }
    const search = params.toString()
    const next = search ? `${path}?${search}` : path
    const cur = `${location.pathname}${location.search}`
    if (next !== cur) {
      navigate(next, { replace: true })
    }
  }, [
    activeTab,
    runsFilter,
    runsSearch,
    runsJobId,
    runsPageSize,
    runsOffset,
    runsStartedAfter,
    runsStartedBefore,
    runsMinDurationMs,
    runsMaxDurationMs,
    runsRangePreset,
    navigate,
    location.pathname,
    location.search,
  ])

  useEffect(() => { try { localStorage.setItem('cronsentinel-minimal-mode', String(minimalMode)) } catch { /* */ } }, [minimalMode])
  useEffect(() => { try { localStorage.setItem('cronsentinel-schedule-mode', scheduleMode) } catch { /* */ } }, [scheduleMode])
  useEffect(() => {
    if (showJobForm) markJobCreateStarted()
  }, [showJobForm])

  // ── Log streaming ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedRun) return
    setLogsLoading(true)
    setLogs({ stdout: '', stderr: '' })
    setLogsTrunc({ stdout: false, stderr: false })
    let cancelled = false

    const ev = new EventSource(`${API_BASE_URL}/api/runs/${selectedRun}/stream`)
    let streamReceived = false

    ev.onmessage = (msg) => {
      if (cancelled) return
      try {
        const p = JSON.parse(msg.data) as { stream?: string; line?: string; stdout?: string; stderr?: string }
        streamReceived = true
        setLogsLoading(false)
        setLogs(prev => ({
          stdout: p.stream === 'stdout' && p.line ? `${prev.stdout}${p.line}\n` : p.stdout ?? prev.stdout,
          stderr: p.stream === 'stderr' && p.line ? `${prev.stderr}${p.line}\n` : p.stderr ?? prev.stderr,
        }))
      } catch { /* malformed frame */ }
    }
    ev.onerror = () => ev.close()

    apiFetch<{ stdout: string; stderr: string; stdout_truncated?: boolean; stderr_truncated?: boolean }>(`${API_BASE_URL}/api/runs/${selectedRun}/logs`)
      .then(d => {
        if (cancelled) return
        if (!streamReceived) {
          setLogs(d ?? { stdout: '', stderr: '' })
          setLogsTrunc({ stdout: Boolean(d?.stdout_truncated), stderr: Boolean(d?.stderr_truncated) })
        }
        setLogsLoading(false)
      })
      .catch(err => {
        if (cancelled) return
        setLogsLoading(false)
        toast.error('Failed to load logs', { description: err instanceof Error ? err.message : 'Unknown error' })
      })

    return () => { cancelled = true; ev.close() }
  }, [selectedRun])

  const modalLogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (modalLogRef.current) {
      modalLogRef.current.scrollTop = modalLogRef.current.scrollHeight
    }
  }, [modalLogs])

  useEffect(() => {
    if (!logsModalRunId) return
    setModalLogsLoading(true)
    setModalLogs({ stdout: '', stderr: '' })
    setModalLogsTrunc({ stdout: false, stderr: false })
    let cancelled = false

    // Open the SSE stream FIRST so we never miss live lines due to the race
    // between job execution and the initial /logs fetch completing.
    // The backend will immediately replay the final state if the run already finished.
    const ev = new EventSource(`${API_BASE_URL}/api/runs/${logsModalRunId}/stream`)
    let streamReceived = false

    ev.onmessage = (msg) => {
      if (cancelled) return
      try {
        const p = JSON.parse(msg.data) as { stream?: string; line?: string; stdout?: string; stderr?: string; status?: string }
        streamReceived = true
        setModalLogsLoading(false)
        setModalLogs(prev => ({
          stdout: p.stream === 'stdout' && p.line ? `${prev.stdout}${p.line}\n` : p.stdout ?? prev.stdout,
          stderr: p.stream === 'stderr' && p.line ? `${prev.stderr}${p.line}\n` : p.stderr ?? prev.stderr,
        }))
      } catch { /* malformed frame */ }
    }
    ev.onerror = () => ev.close()

    // Also fetch existing logs as a fallback for completed runs where SSE may not fire
    apiFetch<{ stdout: string; stderr: string; stdout_truncated?: boolean; stderr_truncated?: boolean }>(`${API_BASE_URL}/api/runs/${logsModalRunId}/logs`)
      .then(d => {
        if (cancelled) return
        // Only use REST snapshot if SSE hasn't delivered a full payload yet
        if (!streamReceived) {
          setModalLogs(d ?? { stdout: '', stderr: '' })
          setModalLogsTrunc({ stdout: Boolean(d?.stdout_truncated), stderr: Boolean(d?.stderr_truncated) })
        }
        setModalLogsLoading(false)
      })
      .catch(err => {
        if (cancelled) return
        setModalLogsLoading(false)
        toast.error('Failed to load logs', { description: err instanceof Error ? err.message : 'Unknown error' })
      })

    return () => { cancelled = true; ev.close() }
  }, [logsModalRunId])

  // ── Derived ───────────────────────────────────────────────────────────────
  const pageSuccessCount = runs.filter(r => isRunSuccess(r.status)).length
  const pageFailedCount = runs.filter(r => isRunFailure(r.status)).length
  const pageTimedOutCount = runs.filter(r => isRunTimedOut(r.status)).length
  const runsFiltered = useMemo(
    () =>
      runs.filter((r) => {
        const s = r.status.toLowerCase()
        if (runsFilter === 'running') return s === 'running'
        if (runsFilter === 'success') return isRunSuccess(r.status)
        if (runsFilter === 'failed') return isRunFailure(r.status)
        if (runsFilter === 'timed_out') return isRunTimedOut(r.status)
        return true
      }),
    [runs, runsFilter],
  )
  const modalRuns = useMemo(
    () => (logsModalJobId ? runs.filter(r => r.job_id === logsModalJobId) : []),
    [logsModalJobId, runs],
  )
  const modalJob = logsModalJobId ? jobs.find(j => j.id === logsModalJobId) : null
  const selectedModalRun = modalRuns.find(r => r.id === logsModalRunId) ?? null
  const runningModalRun = modalRuns.find(r => r.status.toLowerCase() === 'running') ?? null
  const filteredJobs = jobSearch.trim()
    ? jobs.filter(j =>
        j.name.toLowerCase().includes(jobSearch.toLowerCase()) ||
        j.command.toLowerCase().includes(jobSearch.toLowerCase()) ||
        (j.comment ?? '').toLowerCase().includes(jobSearch.toLowerCase())
      )
    : jobs

  const runningJobsCount = runs.filter(r => r.status.toLowerCase() === 'running').length
  const runsRangeLabel = runsTotal === 0
    ? '0 of 0'
    : `${runsOffset + 1}-${Math.min(runsOffset + runs.length, runsTotal)} of ${runsTotal}`

  // ── Actions ───────────────────────────────────────────────────────────────
  const saveScript = async () => {
    const e = validateScriptName(newScript.name)
    if (e) { setScriptErrors({ name: e }); return }
    setScriptErrors({ name: '' }); setScriptSaving(true)
    try {
      await apiFetch(`${API_BASE_URL}/api/scripts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newScript) })
      toast.success('Script saved', { description: newScript.name })
      setNewScript({ name: '', content: 'echo "hello from script"' })
      setShowScriptForm(false); refresh()
    } catch (err) { toast.error('Failed to save script', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally { setScriptSaving(false) }
  }

  const requestDeleteScript = (name: string) => {
    setConfirmDeleteScript(name)
    setTimeout(() => setConfirmDeleteScript(c => c === name ? null : c), 4000)
  }
  const deleteScript = async (name: string) => {
    setConfirmDeleteScript(null); setDeletingScript(name)
    try {
      await apiFetch(`${API_BASE_URL}/api/scripts/${encodeURIComponent(name)}`, { method: 'DELETE' })
      toast.success('Script deleted', { description: name }); refresh()
    } catch (err) { toast.error('Failed to delete script', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally { setDeletingScript(null) }
  }

  const saveJob = async () => {
    const ne = validateJobName(newJob.name), se = validateCron(newJob.schedule), ce = validateCommand(newJob.command)
    if (ne || se || ce) { setJobErrors({ name: ne, schedule: se, command: ce }); return }
    setJobErrors({ name: '', schedule: '', command: '' }); setJobSaving(true)
    try {
      await apiFetch(`${API_BASE_URL}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newJob) })
      toast.success('Job created', { description: newJob.name })
      markJobCreated()
      setNewJob({ name: '', schedule: '*/5 * * * *', timezone: 'Local', command: 'echo "cron test"', working_directory: '', venv_path: '', comment: '', logging_enabled: true, timeout_seconds: 300, timeout_remote_kill_enabled: false, heartbeat_grace_seconds: 300, success_exit_code: 0, enabled: true })
      setShowJobForm(false); refresh()
    } catch (err) { toast.error('Failed to create job', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally { setJobSaving(false) }
  }

  const requestDeleteJob = (id: string) => {
    setConfirmDeleteJob(id)
    setTimeout(() => setConfirmDeleteJob(c => c === id ? null : c), 4000)
  }
  const deleteJob = async (id: string, name: string) => {
    setConfirmDeleteJob(null); setDeletingJob(id)
    try {
      await apiFetch(`${API_BASE_URL}/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' })
      toast.success('Job deleted', { description: name }); refresh()
    } catch (err) { toast.error('Failed to delete job', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally { setDeletingJob(null) }
  }

  const registerServer = async () => {
    const name = newServerName.trim()
    if (!name) {
      toast.error('Server name is required')
      return
    }
    setServerRegistering(true)
    try {
      const res = await apiFetch<{ heartbeat_token?: string }>(`${API_BASE_URL}/api/servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (res?.heartbeat_token) {
        setLastCreatedServerToken({ name, token: res.heartbeat_token })
      }
      setNewServerName('')
      toast.success('Server registered', { description: 'Copy the heartbeat URL or cron line below — the token is only shown once here.' })
      await refresh()
    } catch (e) {
      toast.error('Could not register server', { description: getFetchErrorMessage(e) })
    } finally {
      setServerRegistering(false)
    }
  }

  const requestDeleteServer = (id: string) => {
    setConfirmDeleteServer(id)
    setTimeout(() => setConfirmDeleteServer(c => (c === id ? null : c)), 4000)
  }

  const deleteServerRow = async (id: string, displayName: string) => {
    setConfirmDeleteServer(null)
    setDeletingServerId(id)
    try {
      await apiFetch(`${API_BASE_URL}/api/servers/${encodeURIComponent(id)}`, { method: 'DELETE' })
      toast.success('Server removed', { description: displayName })
      await refresh()
    } catch (e) {
      toast.error('Could not remove server', { description: getFetchErrorMessage(e) })
    } finally {
      setDeletingServerId(null)
    }
  }

  const loadCrontabSnapshots = useCallback(async (serverId: string) => {
    setCrontabSnapLoading(serverId)
    try {
      const rows = await apiFetch<CrontabSnapshotRow[]>(
        `${API_BASE_URL}/api/crontab-snapshots?server_id=${encodeURIComponent(serverId)}`,
      )
      setCrontabSnapshotsByServer(prev => ({ ...prev, [serverId]: Array.isArray(rows) ? rows : [] }))
    } catch (e) {
      toast.error('Could not load crontab snapshots', { description: getFetchErrorMessage(e) })
    } finally {
      setCrontabSnapLoading(null)
    }
  }, [])

  const savePollInterval = async (serverId: string) => {
    const raw = pollIntervalDraft[serverId] ?? '300'
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n) || n < 60 || n > 86400) {
      toast.error('Interval must be between 60 and 86400 seconds')
      return
    }
    setPollSavingId(serverId)
    try {
      await apiFetch(`${API_BASE_URL}/api/servers/${encodeURIComponent(serverId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crontab_poll_interval_seconds: n }),
      })
      toast.success('Crontab poll interval saved')
      await refresh()
    } catch (e) {
      toast.error('Could not save interval', { description: getFetchErrorMessage(e) })
    } finally {
      setPollSavingId(null)
    }
  }

  const startEditJob = (j: Job) => {
    setEditingJobId(j.id)
    setShowEditAdvanced(false)
    setEditJob({
      name: j.name,
      schedule: j.schedule,
      timezone: j.timezone ?? 'Local',
      command: j.command,
      working_directory: j.working_directory ?? '',
      venv_path: j.venv_path ?? '',
      comment: j.comment,
      logging_enabled: j.logging_enabled,
      timeout_seconds: j.timeout_seconds,
      timeout_remote_kill_enabled: j.timeout_remote_kill_enabled === true,
      heartbeat_grace_minutes: Math.max(1, Math.round((j.heartbeat_grace_seconds ?? 300) / 60)),
      success_exit_code: j.success_exit_code ?? 0,
      enabled: j.enabled !== false,
      alert_use_default_channels: j.alert_use_default_channels !== false,
      alert_channel_ids: Array.isArray(j.alert_channel_ids) ? [...j.alert_channel_ids] : [],
    })
    setEditJobErrors({ name: '', schedule: '', command: '' })
    void apiFetch<AlertChannelItem[]>(`${API_BASE_URL}/api/settings/alert-channels`)
      .then(list => setAlertChannelPickList(Array.isArray(list) ? list : []))
      .catch(() => setAlertChannelPickList([]))
  }

  const cancelEditJob = (): void => {
    setEditingJobId(null)
    setShowEditAdvanced(false)
    setEditJobScheduleConfirmOpen(false)
  }

  /**
   * Confirm when an enabled job is "healthy" and user changes schedule or monitoring enabled flag.
   * (See FEAT-12 — avoid accidental changes to actively monitored schedules.)
   */
  const saveEditJob = async (opts?: { skipScheduleActiveConfirm?: boolean }): Promise<void> => {
    const id = editingJobId
    if (!id) return
    const ne = validateJobName(editJob.name),
      se = validateCron(editJob.schedule),
      ce = validateCommand(editJob.command)
    if (ne || se || ce) {
      setEditJobErrors({ name: ne, schedule: se, command: ce })
      return
    }
    setEditJobErrors({ name: '', schedule: '', command: '' })

    const j0 = jobs.find(x => x.id === id)
    if (!j0) {
      toast.error('Job no longer in list', { description: 'Refresh and try again.' })
      cancelEditJob()
      return
    }

    const payload: JobPutBody = {
      name: editJob.name.trim(),
      schedule: editJob.schedule.trim(),
      timezone: editJob.timezone,
      working_directory: editJob.working_directory.trim(),
      command: editJob.command.trim(),
      comment: editJob.comment,
      logging_enabled: editJob.logging_enabled,
      timeout_seconds: editJob.timeout_seconds,
      timeout_remote_kill_enabled: editJob.timeout_remote_kill_enabled,
      heartbeat_grace_seconds: Math.min(604800, Math.max(60, editJob.heartbeat_grace_minutes * 60)),
      success_exit_code: editJob.success_exit_code,
      enabled: editJob.enabled,
      alert_routing: {
        use_default_channels: editJob.alert_use_default_channels,
        channel_ids: editJob.alert_use_default_channels ? [] : [...editJob.alert_channel_ids],
      },
    }

    const wasActive = j0.enabled !== false && (j0.dashboard_status ?? '').toLowerCase() === 'healthy'
    const scheduleOrEnabledChanged =
      payload.schedule !== j0.schedule || payload.enabled !== (j0.enabled !== false)
    if (!opts?.skipScheduleActiveConfirm && wasActive && scheduleOrEnabledChanged) {
      setEditJobScheduleConfirmOpen(true)
      return
    }

    const snap = jobs.map(j => ({ ...j }))
    pendingEditPutRef.current = payload
    pendingEditJobsSnapshotRef.current = snap

    const optimistic: Job = {
      ...j0,
      name: payload.name,
      schedule: payload.schedule,
      timezone: payload.timezone,
      working_directory: payload.working_directory || undefined,
      command: payload.command,
      comment: payload.comment,
      logging_enabled: payload.logging_enabled,
      timeout_seconds: payload.timeout_seconds,
      timeout_remote_kill_enabled: payload.timeout_remote_kill_enabled,
      heartbeat_grace_seconds: payload.heartbeat_grace_seconds,
      success_exit_code: payload.success_exit_code,
      enabled: payload.enabled,
      dashboard_status: payload.enabled ? j0.dashboard_status : 'paused',
      alert_use_default_channels: editJob.alert_use_default_channels,
      alert_channel_ids: editJob.alert_use_default_channels ? [] : [...editJob.alert_channel_ids],
    }
    setJobs(prev => prev.map(j => (j.id === id ? optimistic : j)))

    setEditJobSaving(true)
    try {
      await apiFetch(`${API_BASE_URL}/api/jobs/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      pendingEditPutRef.current = null
      pendingEditJobsSnapshotRef.current = null
      toast.success('Job updated')
      cancelEditJob()
      await refresh()
    } catch (err) {
      const snapBack = pendingEditJobsSnapshotRef.current
      if (snapBack) setJobs(snapBack)
      const msg = getFetchErrorMessage(err)
      toast.error('Failed to update job', {
        description: msg,
        duration: 12_000,
        action: {
          label: 'Retry',
          onClick: () => {
            void saveEditJob({ skipScheduleActiveConfirm: true })
          },
        },
      })
    } finally {
      setEditJobSaving(false)
    }
  }

  const runJob = async (id: string, name: string) => {
    setRunningJob(id)
    try {
      const resp = await apiFetch<{ run_id?: string }>(`${API_BASE_URL}/api/jobs/${encodeURIComponent(id)}/run`, { method: 'POST' })
      toast.success('Job started', { description: name })
      markJobRunStarted()
      refresh()
      setLogsModalJobId(id)
      if (resp?.run_id) setLogsModalRunId(resp.run_id)
      setLogsModalAutoFollow(true)
    } catch (err) { toast.error('Failed to start job', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally { setRunningJob(null) }
  }

  const cloneJob = (j: Job) => {
    setNewJob({
      name: `${j.name}-copy`,
      schedule: j.schedule,
      timezone: j.timezone ?? 'Local',
      command: j.command,
      working_directory: j.working_directory ?? '',
      venv_path: j.venv_path ?? '',
      comment: j.comment,
      logging_enabled: j.logging_enabled,
      timeout_seconds: j.timeout_seconds,
      timeout_remote_kill_enabled: j.timeout_remote_kill_enabled === true,
      heartbeat_grace_seconds: j.heartbeat_grace_seconds ?? 300,
      success_exit_code: j.success_exit_code ?? 0,
      enabled: j.enabled !== false,
    })
    setJobErrors({ name: '', schedule: '', command: '' })
    setShowJobForm(true)
    setActiveTab('jobs')
    window.scrollTo({ top: 0, behavior: 'smooth' })
    toast.info('Job cloned — edit and save to create', { description: j.name })
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success('Copied to clipboard'),
      () => toast.error('Failed to copy')
    )
  }

  const openLogsModal = (jobId: string) => {
    const openedAt = Date.now()
    const latestRun = runs.find(r => r.job_id === jobId)
    setLogsModalJobId(jobId)
    setLogsModalRunId(latestRun?.id ?? '')
    setLogsModalAutoFollow(false)
    markLogsOpened(openedAt)
  }

  useEffect(() => {
    if (!logsModalJobId) return
    if (!logsModalRunId && modalRuns.length > 0) {
      setLogsModalRunId((runningModalRun ?? modalRuns[0]).id)
      return
    }
    if (logsModalAutoFollow && runningModalRun && logsModalRunId !== runningModalRun.id) {
      setLogsModalRunId(runningModalRun.id)
      return
    }
    if (logsModalRunId) {
      const stillExists = modalRuns.some(r => r.id === logsModalRunId)
      if (!stillExists && modalRuns.length > 0) {
        setLogsModalRunId((runningModalRun ?? modalRuns[0]).id)
      }
    }
  }, [logsModalJobId, logsModalRunId, logsModalAutoFollow, modalRuns, runningModalRun])

  // ── Sidebar clock ─────────────────────────────────────────────────────────
  const [now, setNow] = useState(() => new Date().toLocaleTimeString())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date().toLocaleTimeString()), 1000)
    return () => clearInterval(t)
  }, [])

  // Escape closes logs modal first, otherwise skips onboarding wizard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (logsModalJobId) {
        setLogsModalJobId(null)
        setLogsModalRunId('')
        return
      }
      if (showOnboarding) {
        markOnboardingSkipped()
        bumpOnboarding(x => x + 1)
        toast.message('Onboarding skipped', { description: 'You can add jobs anytime from the Jobs tab.' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [logsModalJobId, showOnboarding])

  const memPct = system.memory?.used_percent ?? 0
  const sysLoading = apiOnline === true && !('uptime_seconds' in system)
  const sidebarKernelLine = kernelArchLine(system.host)
  const uxMetrics = getUxMetricsSnapshot()
  const nextRunByJob = useMemo(() => {
    const out: Record<string, Date | null> = {}
    for (const job of jobs) {
      out[job.id] = nextRunFromCron(job.schedule, job.timezone || 'Local')
    }
    return out
  }, [jobs])

  const billingNearLimit = useMemo(() => {
    if (!billing || apiOnline !== true) return false
    if (billing.max_monitors <= 0 || billing.max_alerts_per_month <= 0) return false
    return billing.monitors_utilization >= 0.8 || billing.alerts_utilization >= 0.8
  }, [billing, apiOnline])

  // ══════════════════════════════════════════════════════════════════════════
  return (
    <div className="h-screen overflow-hidden flex flex-col bg-background text-foreground">

      {/* ── Offline banner ── */}
      {apiOnline === false && (
        <div role="alert" aria-live="assertive" className="flex items-center justify-center gap-2 bg-destructive/10 border-b border-destructive/20 px-4 py-1.5 text-destructive text-xs font-medium shrink-0">
          <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />
          Backend is unreachable. Auto-retrying every 5s, or click Refresh now.
        </div>
      )}

      {apiOnline === true && billingNearLimit && !billingBannerDismissed && billing && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 bg-amber-500/10 border-b border-amber-500/25 px-4 py-2 text-amber-950 dark:text-amber-100 text-xs shrink-0"
        >
          <div className="flex items-start gap-2 min-w-0">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" aria-hidden />
            <span className="leading-snug">
              Approaching plan limits: monitors {billing.monitors_used} / {billing.max_monitors}, alerts sent this UTC month{' '}
              {billing.alerts_sent_this_month} / {billing.max_alerts_per_month}.
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button type="button" variant="link" className="h-auto p-0 text-xs text-amber-900 dark:text-amber-200" onClick={() => setActiveTab('settings')}>
              Open Settings
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-[10px] text-amber-900/80 dark:text-amber-200/90"
              onClick={() => setBillingBannerDismissed(true)}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <OnboardingWizard
        open={showOnboarding}
        apiBaseUrl={API_BASE_URL}
        onStorageChange={() => bumpOnboarding(x => x + 1)}
        onOpenNotificationSettings={() => setActiveTab('settings')}
        onRefreshJobs={async () => {
          await refresh()
        }}
      />

      {/* ── Top header (brand, tabs, status, theme, refresh) ─────────────── */}
      <header className="shrink-0 border-b border-border/50 bg-card flex items-stretch min-h-12 px-5 gap-3">
        <div className="flex items-center gap-2 shrink-0 self-center">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary shadow-sm" aria-hidden="true">
            <Zap className="h-4 w-4 text-primary-foreground" />
          </div>
          <div className="leading-none">
            <p className="text-sm font-bold tracking-tight">
              Cron<span className="text-primary">Sentinel</span>
            </p>
          </div>
        </div>

        <div className="flex min-h-12 min-w-0 flex-1 items-stretch border-l border-border/40 pl-3">
          <MainTabs
            activeTab={activeTab}
            onTabChange={setActiveTab}
            counts={{
              dashboard: jobs.length,
              jobs: jobs.length,
              scripts: scripts.length,
              runs: runs.length,
              servers: servers.length,
              settings: 0,
            }}
          />
        </div>

        <div className="flex items-center gap-2 shrink-0 self-center">
          {runningJobsCount > 0 && (
            <span
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${cs.late.surface}`}
            >
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              {runningJobsCount} job{runningJobsCount > 1 ? 's' : ''} running
            </span>
          )}
          {apiOnline === true ? (
            <span className={`flex items-center gap-1.5 text-xs font-semibold ${cs.healthy.text}`}>
              <span className={`h-1.5 w-1.5 rounded-full motion-safe:animate-pulse ${cs.healthy.dot}`} aria-hidden="true" />
              Live
            </span>
          ) : apiOnline === false ? (
            <span className={`flex items-center gap-1.5 text-xs font-semibold ${cs.failed.text}`}>
              <WifiOff className="h-3 w-3" aria-hidden="true" /> Offline
            </span>
          ) : null}

          <span className="text-xs text-muted-foreground/50 hidden sm:block" title="Data auto-refreshes every 5 seconds">
            auto-refresh 5s
          </span>
          <ThemeToggle />
          <Button
            variant="outline"
            size="sm"
            onClick={() => refresh(true)}
            disabled={refreshing}
            aria-label={refreshing ? 'Refreshing…' : 'Refresh data'}
            className="h-7 gap-1.5 text-xs border-border/60"
          >
            {refreshing
              ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />
              : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
            Refresh
          </Button>
        </div>
      </header>

      {/* ── Body (sidebar + main) ─────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1 overflow-hidden">

        {/* ── Left sidebar ───────────────────────────────────────────────── */}
        {sidebarOpen && (
          <aside className="w-52 shrink-0 border-r border-border/40 bg-muted/40 flex flex-col overflow-y-auto">

            {/* System status */}
            <div className="px-4 pt-4 pb-3 border-b border-border/40">
              <div className="flex items-center gap-2">
                <span
                  className={`h-2.5 w-2.5 rounded-full shrink-0 ${apiOnline === true ? `${cs.healthy.dot} motion-safe:animate-pulse` : cs.failed.dot}`}
                  aria-hidden="true"
                />
                <span className="text-xs font-semibold">
                  {apiOnline === true ? 'System Status: Optimal' : apiOnline === false ? 'Backend Offline' : 'Connecting…'}
                </span>
              </div>
              {apiOnline === true && (
                <p className="text-xs text-muted-foreground mt-0.5 pl-4.5">All systems running normally</p>
              )}
              <p className="text-xs text-muted-foreground/60 mt-0.5 pl-4.5">Last updated: {now}</p>
            </div>

            {/* System information (auto-detected server specs) */}
            <div className="px-3 pt-3 pb-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">System Information</p>
              <div className="space-y-1.5">
                <div className="rounded border border-border/40 bg-card/80 px-2.5 py-2">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <Server className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Operating system</span>
                  </div>
                  <p className="text-xs font-semibold text-foreground leading-snug">{buildOsPrimaryLine(system.host)}</p>
                  {sidebarKernelLine ? (
                    <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug">{sidebarKernelLine}</p>
                  ) : null}
                  {system.host?.platform_family ? (
                    <p className="text-[10px] text-muted-foreground mt-0.5">Family: {system.host.platform_family}</p>
                  ) : null}
                  {(system.host?.virtualization_system || system.host?.virtualization_role) ? (
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      Virtualization: {[system.host.virtualization_system, system.host.virtualization_role].filter(Boolean).join(' / ')}
                    </p>
                  ) : null}
                </div>
                <div className="rounded border border-border/40 bg-card/80 px-2.5 py-2">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <Server className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Hostname</span>
                  </div>
                  <p className="text-xs font-semibold text-foreground break-all">{system.host?.hostname?.trim() || '—'}</p>
                </div>
                <div className="rounded border border-border/40 bg-card/80 px-2.5 py-2">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <Clock className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Boot time</span>
                  </div>
                  <p className="text-xs font-semibold text-foreground">{formatBootTimeUnix(system.host?.boot_time_unix)}</p>
                </div>
                <div className="rounded border border-border/40 bg-card/80 px-2.5 py-2">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <Timer className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Uptime</span>
                  </div>
                  <p className="text-xs font-semibold text-foreground">
                    {system.uptime_seconds != null ? formatUptime(system.uptime_seconds) : '—'}
                  </p>
                </div>
                <div className="rounded border border-border/40 bg-card/80 px-2.5 py-2">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Cpu className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">CPU</span>
                  </div>
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Processor name</p>
                  <p className="text-xs font-semibold text-foreground leading-snug mt-0.5 break-words" title={cpuProductName(system) || undefined}>
                    {cpuProductName(system) || 'Not reported by the operating system'}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-1.5">
                    {formatCpuCoresDetail(system)}
                    {system.cpu?.mhz_max != null && system.cpu.mhz_max > 0 ? (
                      <span> · up to {system.cpu.mhz_max.toFixed(0)} MHz</span>
                    ) : null}
                  </p>
                </div>
                <div className="rounded border border-border/40 bg-card/80 px-2.5 py-2">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <Monitor className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Memory</span>
                  </div>
                  <p className="text-xs font-semibold text-foreground">
                    {system.memory?.total != null ? `${formatBytes(system.memory.total)} total` : '—'}
                  </p>
                </div>
                <div className="rounded border border-border/40 bg-card/80 px-2.5 py-2">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <HardDrive className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Swap</span>
                  </div>
                  <p className="text-xs font-semibold text-foreground">
                    {system.swap != null && system.swap.total > 0
                      ? `${formatBytes(system.swap.total)} total · ${system.swap.used_percent.toFixed(0)}% used`
                      : system.swap != null && system.swap.total === 0 ? 'None configured' : '—'}
                  </p>
                </div>
                {system.disks && system.disks.length > 0 ? (
                  <div className="rounded border border-border/40 bg-card/80 px-2.5 py-2 space-y-1">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <HardDrive className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Storage</span>
                    </div>
                    {system.disks.map(d => (
                      <div key={d.path} className="border-t border-border/30 first:border-t-0 first:pt-0 pt-1.5 space-y-0.5">
                        <p className="text-[10px] font-medium break-all">{d.path}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {d.fstype ? `${d.fstype} · ` : ''}{formatBytes(d.used)} / {formatBytes(d.total)} ({d.used_percent.toFixed(0)}%){d.free != null ? ` · ${formatBytes(d.free)} free` : ''}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : null}
                {system.network && system.network.length > 0 ? (
                  <div className="rounded border border-border/40 bg-card/80 px-2.5 py-2 space-y-1">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <Network className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Network</span>
                    </div>
                    {system.network.map(n => (
                      <div key={n.name} className="border-t border-border/30 first:border-t-0 first:pt-0 pt-1.5 space-y-0.5">
                        <p className="text-[10px] font-medium">{n.name}</p>
                        <p className="text-[10px] text-muted-foreground">
                          ↓ {formatBytes(n.bytes_recv)} · ↑ {formatBytes(n.bytes_sent)}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="rounded border border-border/40 bg-card/80 px-2.5 py-2">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Zap className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">GPU</span>
                  </div>
                  {system.gpu?.status === 'ok' && system.gpu.devices && system.gpu.devices.length > 0 ? (
                    <div className="space-y-2">
                      {system.gpu.devices.map((g, i) => (
                        <div key={`${g.name}-${i}`}>
                          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                            {system.gpu!.devices!.length > 1 ? `GPU ${i + 1} name` : 'Graphics processor name'}
                          </p>
                          <p className="text-xs font-semibold text-foreground leading-snug mt-0.5 break-words" title={g.name}>
                            {g.name}
                          </p>
                          {(g.vendor || g.driver) ? (
                            <p className="text-[10px] text-muted-foreground mt-0.5">
                              {g.vendor ? <span>{g.vendor}</span> : null}
                              {g.vendor && g.driver ? <span> · </span> : null}
                              {g.driver ? <span>driver: {g.driver}</span> : null}
                            </p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[10px] text-muted-foreground leading-snug">
                      {system.gpu?.reason || 'Not detected'}
                    </p>
                  )}
                </div>
                {system.errors && system.errors.length > 0 ? (
                  <div className="rounded border border-destructive/30 bg-destructive/5 px-2.5 py-2">
                    <p className="text-[10px] font-semibold text-destructive mb-0.5">Partial data</p>
                    <ul className="text-[9px] text-muted-foreground space-y-0.5 list-disc pl-3.5">
                      {system.errors.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </div>
                ) : null}
              </div>
            </div>

            {/* Performance metrics */}
            <div className="px-3 pb-4 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Performance Metrics</p>
              <div className="space-y-2">

                {/* Memory */}
                <div className="rounded border border-border/40 bg-card/80 px-2.5 py-2 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <Monitor className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Memory</span>
                    </div>
                    {system.memory && (
                      <span className="text-xs text-muted-foreground">{memPct.toFixed(0)}%</span>
                    )}
                  </div>
                  {system.memory ? (
                    <>
                      <p className="text-xs font-semibold">{formatBytes(system.memory.used)} / {formatBytes(system.memory.total)}</p>
                      <p className={`text-xs font-medium ${cs.healthy.text}`}>{formatBytes(system.memory.free ?? Math.max(0, system.memory.total - system.memory.used))} free</p>
                      <ProgressBar pct={memPct} />
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">—</p>
                  )}
                </div>

                {/* CPU utilization (model name lives under System Information) */}
                <div className="rounded border border-border/40 bg-card/80 px-2.5 py-2 space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <Cpu className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">CPU</span>
                  </div>
                  <p className="text-xs font-semibold">
                    {logicalCpuCount(system) != null
                      ? `${logicalCpuCount(system)} core${logicalCpuCount(system) !== 1 ? 's' : ''}`
                      : '—'}
                  </p>
                  {system.load && (
                    <>
                      <p className="text-xs text-muted-foreground">Load: {system.load.load1.toFixed(2)}</p>
                      <ProgressBar pct={Math.min(100, system.load.load1 * 25)} />
                    </>
                  )}
                </div>

                {/* Disk */}
                {system.disks && system.disks.length > 0 && (
                  <div className="rounded border border-border/40 bg-card/80 px-2.5 py-2 space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <HardDrive className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Disk</span>
                    </div>
                    {system.disks.map(d => (
                      <div key={d.path} className="space-y-1">
                        <div className="flex justify-between gap-1">
                          <p className="text-xs font-medium truncate" title={d.path}>{d.path}</p>
                          <p className="text-xs text-muted-foreground shrink-0">{d.used_percent.toFixed(0)}%</p>
                        </div>
                        <ProgressBar pct={d.used_percent} />
                      </div>
                    ))}
                  </div>
                )}

                {/* Load averages */}
                {system.load && (
                  <div className="rounded border border-border/40 bg-card/80 px-2.5 py-2">
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <Activity className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Load Average</span>
                    </div>
                    <div className="grid grid-cols-3 gap-1 text-center">
                      {[['1m', system.load.load1], ['5m', system.load.load5], ['15m', system.load.load15]].map(([label, val]) => (
                        <div key={label as string} className="rounded bg-muted/50 px-1 py-1">
                          <p className="text-[10px] text-muted-foreground uppercase">{label as string}</p>
                          <p className="text-xs font-semibold">{(val as number).toFixed(2)}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="rounded border border-border/40 bg-card/80 px-2.5 py-2">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <Info className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">UX Insights</span>
                  </div>
                  <div className="space-y-1 text-xs text-muted-foreground">
                    <p>Avg create job: {uxMetrics.avgCreateMs > 0 ? `${uxMetrics.avgCreateMs}ms` : 'n/a'}</p>
                    <p>Avg open logs: {uxMetrics.avgOpenLogsMs > 0 ? `${uxMetrics.avgOpenLogsMs}ms` : 'n/a'}</p>
                    <p>Created: {uxMetrics.jobsCreated} · Run now: {uxMetrics.jobsRun}</p>
                  </div>
                </div>

                {sysLoading && (
                  <div className="flex items-center justify-center py-4 text-muted-foreground" aria-busy="true">
                    <Loader2 className="h-4 w-4 motion-safe:animate-spin mr-2" aria-hidden="true" />
                    <span className="text-xs">Loading…</span>
                  </div>
                )}

              </div>
            </div>
          </aside>
        )}

        {/* Sidebar collapse toggle */}
        <button
          onClick={() => setSidebarOpen(o => !o)}
          aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          className="shrink-0 w-4 border-r border-border/40 bg-muted/60 hover:bg-muted flex items-center justify-center text-muted-foreground/60 hover:text-muted-foreground transition-colors"
        >
          {sidebarOpen ? <ChevronLeft className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>

        {/* ── Main content area ─────────────────────────────────────────── */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">

          {/* Tab content — min-h-0 so flex gives a bounded height; ScrollArea can scroll */}
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-5">

              {/* ══════════════════════════════════════════════════════════ */}
              {/* DASHBOARD TAB (FEAT-04)                                   */}
              {/* ══════════════════════════════════════════════════════════ */}
              {activeTab === 'dashboard' && (
                <Dashboard
                  jobs={jobs}
                  servers={servers.map(s => ({ id: s.id, name: s.name, health: s.health }))}
                  loading={(apiOnline === null && jobs.length === 0) || (refreshing && jobs.length === 0)}
                  apiOffline={apiOnline === false}
                  onRefresh={refresh}
                  onViewRuns={(jobId) => {
                    setRunsJobId(jobId)
                    setRunsOffset(0)
                    setActiveTab('runs')
                  }}
                  onManageServers={() => setActiveTab('servers')}
                />
              )}

              {/* ══════════════════════════════════════════════════════════ */}
              {/* JOBS TAB                                                  */}
              {/* ══════════════════════════════════════════════════════════ */}
              {activeTab === 'jobs' && (
                <div role="tabpanel" id="panel-jobs" aria-labelledby="tab-jobs">
                  {/* Section header */}
                  <div className="sticky top-0 z-10 -mx-5 mb-3 flex items-center gap-3 border-b border-border/40 bg-background/95 px-5 py-2 backdrop-blur flex-wrap">
                    <div>
                      <h1 className="text-base font-semibold tracking-tight text-primary uppercase">Scheduled Tasks</h1>
                      <p className="text-[11px] text-muted-foreground">
                        {filteredJobs.length}{jobSearch ? ` of ${jobs.length}` : ''} scheduled task{jobs.length !== 1 ? 's' : ''}
                        {pageSuccessCount > 0 && <span className="text-[var(--cs-healthy-text)] ml-1.5">· {pageSuccessCount} ok</span>}
                        {pageFailedCount > 0 && (
                          <span className={`ml-1 ${cs.failed.text}`}>· {pageFailedCount} failed</span>
                        )}
                      </p>
                    </div>
                    <div className="flex-1" />
                    {/* Search */}
                    <div className="relative">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" aria-hidden="true" />
                      <input
                        type="search"
                        placeholder="Search jobs…"
                        value={jobSearch}
                        onChange={e => setJobSearch(e.target.value)}
                        className="h-8 rounded-md border border-border/60 bg-card pl-7 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary w-36"
                        aria-label="Search jobs"
                      />
                    </div>
                    {/* Schedule mode */}
                    <div className="flex rounded-md border border-border/60 overflow-hidden text-[10px] font-semibold">
                      {(['cron', 'human', 'both'] as ScheduleMode[]).map(m => (
                        <button
                          key={m}
                          onClick={() => setScheduleMode(m)}
                          className={`px-2 py-1 capitalize transition-colors ${scheduleMode === m ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-muted/40'}`}
                          title={m === 'cron' ? 'Show cron expression' : m === 'human' ? 'Show human-readable' : 'Show both'}
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
                      <div
                        role="checkbox"
                        aria-checked={minimalMode}
                        tabIndex={0}
                        onClick={() => setMinimalMode(m => !m)}
                        onKeyDown={e => e.key === ' ' && setMinimalMode(m => !m)}
                        className={`h-4 w-4 rounded border flex items-center justify-center cursor-pointer ${minimalMode ? 'bg-primary border-primary' : 'border-border bg-card'}`}
                      >
                        {minimalMode && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                      </div>
                      Minimal
                    </label>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => refresh(true)}
                      disabled={refreshing}
                      className="h-8 gap-1.5 text-xs"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
                      Refresh
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => setShowJobForm(f => !f)}
                      className="h-8 gap-1.5 text-xs"
                    >
                      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                      New Task
                    </Button>
                  </div>

                  {/* ── Inline add-job form ── */}
                  {showJobForm && (
                    <div className="mb-4 rounded-lg border border-primary/20 bg-card p-4 shadow-sm" role="region" aria-label="Add new cron job">
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-xs font-semibold text-foreground">New Cron Job</p>
                        <button onClick={() => setShowJobForm(false)} aria-label="Close form" className="text-muted-foreground hover:text-foreground">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div className="space-y-3">
                        {/* Row 1: Name + Comment */}
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <Label htmlFor="job-name" className="text-xs text-muted-foreground">Job name</Label>
                            <Input id="job-name" placeholder="e.g. daily-backup" value={newJob.name}
                              onChange={e => { setNewJob(j => ({ ...j, name: e.target.value })); if (jobErrors.name) setJobErrors(p => ({ ...p, name: '' })) }}
                              aria-invalid={!!jobErrors.name} className="h-8 text-xs" />
                            <FieldError msg={jobErrors.name} id="job-name-error" />
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor="job-comment" className="text-xs text-muted-foreground">Comment <span className="opacity-50">(optional)</span></Label>
                            <Input id="job-comment" placeholder="What does this job do?" value={newJob.comment}
                              onChange={e => setNewJob(j => ({ ...j, comment: e.target.value }))} className="h-8 text-xs" />
                          </div>
                        </div>
                        {/* Row 2: Schedule */}
                        <div className="space-y-1">
                          <Label htmlFor="job-schedule" className="text-xs text-muted-foreground">Schedule</Label>
                          <CronExpressionHelper
                            id="job-schedule"
                            value={newJob.schedule}
                            onChange={v => { setNewJob(j => ({ ...j, schedule: v })); if (jobErrors.schedule) setJobErrors(p => ({ ...p, schedule: '' })) }}
                            errors={jobErrors.schedule}
                            presets={presets}
                            timezone={newJob.timezone}
                          />
                        </div>
                        {/* Row 3: Command */}
                        <div className="space-y-1">
                          <Label htmlFor="job-command" className="text-xs text-muted-foreground">Command</Label>
                          <Textarea id="job-command" placeholder='echo "cron test"' value={newJob.command}
                            onChange={e => { setNewJob(j => ({ ...j, command: e.target.value })); if (jobErrors.command) setJobErrors(p => ({ ...p, command: '' })) }}
                            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveJob() }}
                            aria-invalid={!!jobErrors.command} rows={2} className="font-mono text-xs resize-none" />
                          <FieldError msg={jobErrors.command} id="job-command-error" />
                        </div>
                        <button
                          type="button"
                          onClick={() => setShowJobAdvanced(v => !v)}
                          className="flex w-full items-center justify-between rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-muted/40"
                        >
                          <span>Advanced options (working dir, venv, timeout, logging)</span>
                          {showJobAdvanced ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        </button>
                        {showJobAdvanced && (
                          <div className="space-y-3 rounded-md border border-border/40 bg-muted/10 p-3">
                            <div className="space-y-1">
                              <Label htmlFor="job-timezone" className="text-xs text-muted-foreground">Timezone</Label>
                              <Select value={newJob.timezone} onValueChange={v => setNewJob(j => ({ ...j, timezone: v }))}>
                                <SelectTrigger id="job-timezone" className="h-8 text-xs w-52"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="Local">Local (server)</SelectItem>
                                  <SelectItem value="UTC">UTC</SelectItem>
                                  <SelectItem value="Asia/Karachi">Asia/Karachi</SelectItem>
                                  <SelectItem value="Asia/Dubai">Asia/Dubai</SelectItem>
                                  <SelectItem value="Europe/London">Europe/London</SelectItem>
                                  <SelectItem value="America/New_York">America/New_York</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <div className="space-y-1">
                                <Label htmlFor="job-workdir" className="text-xs text-muted-foreground">Working directory <span className="opacity-50">(optional)</span></Label>
                                <Input id="job-workdir" placeholder="/home/user/myproject" value={newJob.working_directory}
                                  onChange={e => setNewJob(j => ({ ...j, working_directory: e.target.value }))}
                                  className="h-8 font-mono text-xs" />
                              </div>
                              <div className="space-y-1">
                                <Label htmlFor="job-venv" className="text-xs text-muted-foreground">Python venv <span className="opacity-50">(optional)</span></Label>
                                <Input id="job-venv" placeholder="/home/user/project/.venv" value={newJob.venv_path}
                                  onChange={e => setNewJob(j => ({ ...j, venv_path: e.target.value }))}
                                  className="h-8 font-mono text-xs" />
                              </div>
                            </div>
                            <div className="space-y-1">
                              <Label htmlFor="job-timeout" className="text-xs text-muted-foreground">
                                Timeout <span className="opacity-50">(seconds; 0 = no limit)</span>
                              </Label>
                              <Input id="job-timeout" type="number" min={0} max={604800}
                                value={newJob.timeout_seconds}
                                onChange={e =>
                                  setNewJob(j => ({
                                    ...j,
                                    timeout_seconds: Math.min(604800, Math.max(0, parseInt(e.target.value, 10) || 0)),
                                  }))
                                }
                                className="h-8 text-xs w-36" />
                              <p className="text-[10px] text-muted-foreground">Stuck runs are marked timed out after this many seconds (server-side jobs). Ingested runs are unaffected.</p>
                              <label className="flex items-start gap-2 text-[11px] text-muted-foreground cursor-pointer max-w-lg">
                                <input
                                  type="checkbox"
                                  checked={newJob.timeout_remote_kill_enabled}
                                  onChange={e => setNewJob(j => ({ ...j, timeout_remote_kill_enabled: e.target.checked }))}
                                  className="mt-0.5 h-3.5 w-3.5 rounded border-border"
                                />
                                <span>Enable remote kill hint for agents (SIGTERM via <code className="text-[10px]">pending-kill</code> API before final timeout).</span>
                              </label>
                            </div>
                            <div className="space-y-1">
                              <Label htmlFor="job-hb-grace" className="text-xs text-muted-foreground">
                                Heartbeat grace (seconds)
                              </Label>
                              <Input
                                id="job-hb-grace"
                                type="number"
                                min={1}
                                max={604800}
                                value={newJob.heartbeat_grace_seconds}
                                onChange={e => setNewJob(j => ({ ...j, heartbeat_grace_seconds: Math.min(604800, Math.max(1, parseInt(e.target.value, 10) || 300)) }))}
                                className="h-8 text-xs w-40"
                              />
                              <p className="text-[10px] text-muted-foreground">Time after each scheduled slot to receive a POST before marking missed.</p>
                            </div>
                            <div className="space-y-1">
                              <Label htmlFor="job-success-exit" className="text-xs text-muted-foreground">
                                Success exit code <span className="opacity-50">(0–255)</span>
                              </Label>
                              <Input
                                id="job-success-exit"
                                type="number"
                                min={0}
                                max={255}
                                value={newJob.success_exit_code}
                                onChange={e => setNewJob(j => ({ ...j, success_exit_code: Math.min(255, Math.max(0, parseInt(e.target.value, 10) || 0)) }))}
                                className="h-8 text-xs w-28"
                              />
                              <p className="text-[10px] text-muted-foreground">Runs that exit with this code count as success (for server runs and log ingest).</p>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                id="new-job-logging-switch"
                                role="switch"
                                aria-checked={newJob.logging_enabled}
                                aria-label="Enable execution logging for new job"
                                onClick={() => setNewJob(j => ({ ...j, logging_enabled: !j.logging_enabled }))}
                                className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${newJob.logging_enabled ? 'bg-primary' : 'bg-muted'}`}
                              >
                                <span
                                  className={`pointer-events-none absolute top-0.5 h-4 w-4 rounded-full shadow transition-transform motion-reduce:transition-none ${newJob.logging_enabled ? 'translate-x-4 bg-primary-foreground' : 'translate-x-0.5 bg-card'}`}
                                />
                              </button>
                              <div>
                                <Label htmlFor="new-job-logging-switch" className="text-sm font-medium text-foreground cursor-pointer">
                                  Enable logging
                                </Label>
                                <p className="text-xs text-muted-foreground">Capture stdout/stderr for each run</p>
                              </div>
                            </div>
                          </div>
                        )}
                        {/* Row 5: Submit */}
                        <div className="flex items-center justify-between pt-1">
                          <span className="text-[10px] text-muted-foreground">Advanced options are optional.</span>
                          <Button size="sm" onClick={saveJob} disabled={jobSaving} className="h-8 text-xs gap-1.5">
                            {jobSaving ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" /> : <Clock className="h-3.5 w-3.5" aria-hidden="true" />}
                            {jobSaving ? 'Creating…' : 'Create Job'}
                          </Button>
                        </div>
                      </div>
                      <p className="text-[10px] text-muted-foreground/60 mt-2">Tip: Ctrl+Enter in command field to create</p>
                    </div>
                  )}

                  {/* ── Job list ── */}
                  {jobs.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-12 text-center bg-card">
                      <Clock className="h-8 w-8 text-muted-foreground/30" aria-hidden="true" />
                      <p className="text-sm font-medium text-muted-foreground">No jobs scheduled yet</p>
                      <p className="text-xs text-muted-foreground/60">Create your first automation with New Task.</p>
                    </div>
                  ) : filteredJobs.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-12 text-center bg-card">
                      <Search className="h-8 w-8 text-muted-foreground/30" aria-hidden="true" />
                      <p className="text-sm font-medium text-muted-foreground">No jobs match "{jobSearch}"</p>
                      <button onClick={() => setJobSearch('')} className="text-xs text-primary hover:underline">Clear search</button>
                    </div>
                  ) : (
                    <>
                    <ul className="space-y-2" role="list">
                      {filteredJobs.map(j => (
                        <li key={j.id} className="rounded-lg border border-border/50 bg-card shadow-xs overflow-hidden">
                          <div className="flex items-center gap-3 px-4 py-3">
                            {/* Run history dots */}
                            <RunDots jobId={j.id} runs={runs} />

                            {/* Job info */}
                            <div className="flex-1 min-w-0">
                              {/* Job name + last status */}
                              <div className="flex items-center gap-2 mb-1.5">
                                <span className="text-[13px] font-semibold text-foreground truncate">{j.name}</span>
                                {runningJob === j.id && (
                                  <span
                                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${cs.late.surface}`}
                                  >
                                    <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden="true" /> Starting…
                                  </span>
                                )}
                                {(() => {
                                  const last = runs.find(r => r.job_id === j.id)
                                  if (!last) return null
                                  if (last.status.toLowerCase() === 'running')
                                    return (
                                      <span
                                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${cs.late.surface}`}
                                      >
                                        <span className={`h-1.5 w-1.5 animate-pulse rounded-full ${cs.late.dot}`} /> Running
                                      </span>
                                    )
                                  return <RunBadge status={last.status} />
                                })()}
                                <HeartbeatStatusBadge status={j.heartbeat_status} />
                              </div>

                              {/* Command block */}
                              <code className="flex items-center gap-1.5 w-full rounded bg-muted/60 border border-border/50 px-2.5 py-1 text-[11px] font-mono text-foreground overflow-hidden">
                                <span className="text-muted-foreground/50 shrink-0">$</span>
                                <span className="truncate">{j.command}</span>
                              </code>

                              {!minimalMode && (
                                <div className="space-y-1 mt-1.5">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    {(scheduleMode === 'human' || scheduleMode === 'both') && (
                                      <span
                                        className={`inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-xs font-semibold ${cs.late.surface}`}
                                      >
                                        <Clock className="h-2.5 w-2.5" aria-hidden="true" />
                                        {cronToHuman(j.schedule)}
                                      </span>
                                    )}
                                    {(scheduleMode === 'cron' || scheduleMode === 'both') && (
                                      <span className="inline-flex items-center gap-1 rounded-sm border border-border/50 bg-muted/50 px-2 py-0.5 text-xs font-mono text-muted-foreground">
                                        {j.schedule}
                                      </span>
                                    )}
                                    <span
                                      className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-px text-xs ${cs.paused.surface}`}
                                    >
                                      TZ {j.timezone || 'Local'}
                                    </span>
                                    {j.working_directory && (
                                      <span
                                        className="inline-flex max-w-[180px] items-center gap-1 truncate rounded-sm border border-[var(--cs-accent-subtle)] bg-[var(--cs-accent-subtle)]/40 px-1.5 py-px text-xs font-mono text-[var(--cs-accent-text)]"
                                        title={j.working_directory}
                                      >
                                        📁 {j.working_directory}
                                      </span>
                                    )}
                                    {j.venv_path && (
                                      <span
                                        className={`inline-flex max-w-[160px] items-center gap-1 truncate rounded-sm border px-1.5 py-px text-xs font-semibold ${cs.healthy.surface}`}
                                        title={j.venv_path}
                                      >
                                        🐍 venv
                                      </span>
                                    )}
                                    {j.comment && (
                                      <span className="text-xs text-muted-foreground italic truncate max-w-[200px]" title={j.comment}>— {j.comment}</span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-mono text-xs text-muted-foreground/50">#{j.id.slice(0, 8)}</span>
                                    {j.timeout_seconds !== 300 && (
                                      <span
                                        className={`inline-flex items-center rounded-sm border px-1.5 py-px text-xs ${cs.late.surface}`}
                                      >
                                        ⏱ {j.timeout_seconds === 0 ? 'no timeout limit' : `${j.timeout_seconds}s timeout`}
                                      </span>
                                    )}
                                    {j.logging_enabled && (
                                      <span
                                        className={`inline-flex items-center rounded-sm border px-1.5 py-px text-xs font-semibold ${cs.paused.surface}`}
                                      >
                                        Logged
                                      </span>
                                    )}
                                    {(() => {
                                      const last = runs.find(r => r.job_id === j.id)
                                      if (!last) return <span className="text-xs text-muted-foreground/40">Never run</span>
                                      return (
                                        <span className="text-xs text-muted-foreground/60">
                                          Last ran {new Date(last.started_at).toLocaleString()}
                                          {last.ended_at && ` · ${runDuration(last)}`}
                                        </span>
                                      )
                                    })()}
                                    {(() => {
                                      const nextRun = nextRunByJob[j.id]
                                      if (!nextRun) return <span className="text-xs text-muted-foreground/40">Next run: unknown</span>
                                      return (
                                        <span
                                          className={`inline-flex items-center rounded-sm border px-1.5 py-px text-xs ${cs.healthy.surface}`}
                                        >
                                          Next run in {formatCountdown(nextRun)} · {nextRun.toLocaleString()}
                                        </span>
                                      )
                                    })()}
                                  </div>
                                  {j.heartbeat_token && (
                                    <div className={`space-y-1 rounded-md border px-2 py-1.5 ${cs.healthy.surface}`}>
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-[11px] font-semibold uppercase tracking-wider">Heartbeat URL</span>
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="sm"
                                          className="h-6 text-[10px] px-2"
                                          onClick={() => copyToClipboard(heartbeatRequestUrl(j.heartbeat_token!))}
                                        >
                                          <Copy className="h-3 w-3 mr-1" aria-hidden="true" />
                                          Copy URL
                                        </Button>
                                      </div>
                                      <code
                                        className="block select-all break-all font-mono text-xs text-foreground/90"
                                        title="POST JSON or empty body after each successful run"
                                      >
                                        {heartbeatRequestUrl(j.heartbeat_token)}
                                      </code>
                                      <p className="text-xs leading-snug text-muted-foreground">
                                        Grace period: {j.heartbeat_grace_seconds ?? 300}s · Last ping: {formatHeartbeatTs(j.last_heartbeat_at)}{' '}
                                        · Ping expected by: {formatHeartbeatTs(j.heartbeat_deadline_at)}
                                      </p>
                                    </div>
                                  )}
                                  {j.runs_ingest_token && (
                                    <div className={`space-y-1 rounded-md border px-2 py-1.5 ${cs.paused.surface}`}>
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-[11px] font-semibold uppercase tracking-wider">Run log ingest</span>
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="sm"
                                          className="h-6 text-[10px] px-2"
                                          onClick={() => copyToClipboard(runIngestCurlExample(j.id, j.runs_ingest_token!))}
                                        >
                                          <Copy className="h-3 w-3 mr-1" aria-hidden="true" />
                                          Copy curl
                                        </Button>
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="sm"
                                          className="h-6 text-[10px] px-2"
                                          onClick={() => copyToClipboard(runIngestUrl(j.id))}
                                        >
                                          Copy URL
                                        </Button>
                                      </div>
                                      <code
                                        className="block select-all break-all font-mono text-xs text-foreground/90"
                                        title="POST JSON with Bearer token"
                                      >
                                        {runIngestUrl(j.id)}
                                      </code>
                                      <p className="text-xs leading-snug text-muted-foreground">
                                        POST run logs from your cron host with <code className="font-mono">Authorization: Bearer</code> (or{' '}
                                        <code className="font-mono">X-Runs-Ingest-Token</code>). Success exit code for this job: {j.success_exit_code ?? 0}.
                                      </p>
                                    </div>
                                  )}
                                  <div className={`space-y-2 rounded-md border px-2 py-1.5 ${cs.healthy.surface}`}>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <KeyRound className="h-3.5 w-3.5 text-muted-foreground" aria-hidden={true} />
                                      <span className="text-[11px] font-semibold uppercase tracking-wider">Job environment</span>
                                    </div>
                                    <p className="text-xs leading-snug text-muted-foreground">
                                      Encrypted at rest. Values stay masked here. Run logs (local and ingested) redact these values. Names:{' '}
                                      <code className="font-mono">[A-Za-z_][A-Za-z0-9_]*</code>.
                                    </p>
                                    {j.runs_ingest_token && (
                                      <>
                                        <div className="flex flex-wrap items-center gap-2">
                                          <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            className="h-6 text-[10px] px-2"
                                            onClick={() => copyToClipboard(jobEnvFetchCurlExample(j.id, j.runs_ingest_token!))}
                                          >
                                            <Copy className="h-3 w-3 mr-1" aria-hidden="true" />
                                            Copy fetch curl
                                          </Button>
                                          <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            className="h-6 text-[10px] px-2"
                                            onClick={() => copyToClipboard(jobEnvAgentUrl(j.id))}
                                          >
                                            <Copy className="h-3 w-3 mr-1" aria-hidden="true" />
                                            Copy URL
                                          </Button>
                                        </div>
                                        <code
                                          className="block select-all break-all font-mono text-xs text-foreground/90"
                                          title="GET with same Bearer or X-Runs-Ingest-Token as run ingest"
                                        >
                                          {jobEnvAgentUrl(j.id)}
                                        </code>
                                      </>
                                    )}
                                    <ul className="space-y-1.5 list-none m-0 p-0" aria-label={`Environment variables for ${j.name}`}>
                                      {(jobEnvById[j.id] ?? []).length === 0 ? (
                                        <li className="text-xs text-muted-foreground/80">No variables yet.</li>
                                      ) : (
                                        (jobEnvById[j.id] ?? []).map(ev => (
                                          <li
                                            key={ev.name}
                                            className="flex flex-wrap items-center gap-2 rounded border border-border/50 bg-background/50 px-2 py-1 text-xs"
                                          >
                                            <span className="font-mono font-semibold text-foreground">{ev.name}</span>
                                            <span className="font-mono text-muted-foreground">{ev.masked_value}</span>
                                            {ev.sensitive_hint ? (
                                              <Badge variant="outline" className="h-5 text-[10px]">
                                                Sensitive pattern
                                              </Badge>
                                            ) : null}
                                            <Button
                                              type="button"
                                              variant="ghost"
                                              size="sm"
                                              className="h-6 ml-auto text-[10px] text-destructive hover:text-destructive"
                                              onClick={() => setConfirmDeleteEnv({ jobId: j.id, name: ev.name })}
                                              aria-label={`Remove environment variable ${ev.name}`}
                                            >
                                              <Trash2 className="h-3 w-3" aria-hidden="true" />
                                            </Button>
                                          </li>
                                        ))
                                      )}
                                    </ul>
                                    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
                                      <div className="space-y-0.5 min-w-[120px] flex-1">
                                        <Label htmlFor={`job-env-name-${j.id}`} className="text-[10px] text-muted-foreground">
                                          Name
                                        </Label>
                                        <Input
                                          id={`job-env-name-${j.id}`}
                                          className="h-8 font-mono text-xs"
                                          placeholder="MY_VAR"
                                          autoComplete="off"
                                          value={(jobEnvDraftById[j.id] ?? { name: '', value: '' }).name}
                                          onChange={e =>
                                            setJobEnvDraftById(prev => ({
                                              ...prev,
                                              [j.id]: { ...(prev[j.id] ?? { name: '', value: '' }), name: e.target.value },
                                            }))
                                          }
                                        />
                                      </div>
                                      <div className="space-y-0.5 min-w-[140px] flex-[2]">
                                        <Label htmlFor={`job-env-val-${j.id}`} className="text-[10px] text-muted-foreground">
                                          Value
                                        </Label>
                                        <Input
                                          id={`job-env-val-${j.id}`}
                                          type="password"
                                          className="h-8 font-mono text-xs"
                                          placeholder="Secret value"
                                          autoComplete="new-password"
                                          value={(jobEnvDraftById[j.id] ?? { name: '', value: '' }).value}
                                          onChange={e =>
                                            setJobEnvDraftById(prev => ({
                                              ...prev,
                                              [j.id]: { ...(prev[j.id] ?? { name: '', value: '' }), value: e.target.value },
                                            }))
                                          }
                                        />
                                      </div>
                                      <Button
                                        type="button"
                                        size="sm"
                                        className="h-8 text-xs shrink-0"
                                        disabled={jobEnvSavingId === j.id}
                                        onClick={() => void saveJobEnvVar(j.id)}
                                      >
                                        {jobEnvSavingId === j.id ? (
                                          <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />
                                        ) : (
                                          'Save variable'
                                        )}
                                      </Button>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>

                            {/* Action buttons */}
                            <div className="flex items-center gap-1 shrink-0">
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Copy command for ${j.name}`}
                                className="h-7 w-7 text-muted-foreground hover:bg-muted hover:text-primary"
                                onClick={() => copyToClipboard(j.command)}
                                title="Copy command"
                              >
                                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Clone job ${j.name}`}
                                className="h-7 w-7 text-muted-foreground hover:bg-muted hover:text-primary"
                                onClick={() => cloneJob(j)}
                                title="Clone job"
                              >
                                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`View logs for ${j.name}`}
                                className="h-7 w-7 text-muted-foreground hover:bg-muted hover:text-primary"
                                onClick={() => openLogsModal(j.id)}
                              >
                                <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Run history for ${j.name}`}
                                className="h-7 w-7 text-muted-foreground hover:bg-muted hover:text-primary"
                                title="Open Run History for this job (last 30 days)"
                                onClick={() => {
                                  const win = rangeFromPreset('30d')
                                  setRunsRangePreset('30d')
                                  setRunsStartedAfter(win.startedAfter)
                                  setRunsStartedBefore(win.startedBefore)
                                  setRunsJobId(j.id)
                                  setRunsOffset(0)
                                  setActiveTab('runs')
                                }}
                              >
                                <History className="h-3.5 w-3.5" aria-hidden="true" />
                              </Button>
                              <Button variant="ghost" size="icon" aria-label={`Edit job ${j.name}`}
                                className="h-7 w-7 text-muted-foreground hover:bg-muted hover:text-primary"
                                onClick={() => startEditJob(j)}>
                                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                              </Button>
                              <Button variant="ghost" size="icon" aria-label={`Run ${j.name} now`}
                                disabled={runningJob === j.id}
                                className="h-7 w-7 text-muted-foreground hover:bg-muted hover:text-primary"
                                onClick={() => runJob(j.id, j.name)}>
                                {runningJob === j.id
                                  ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />
                                  : <Play className="h-3.5 w-3.5" aria-hidden="true" />}
                              </Button>

                              {confirmDeleteJob === j.id ? (
                                <div className="flex gap-1" role="group" aria-label={`Confirm delete ${j.name}`}>
                                  <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteJob(null)} className="h-7 px-2 text-[10px]">Cancel</Button>
                                  <Button variant="destructive" size="sm" onClick={() => deleteJob(j.id, j.name)} disabled={deletingJob === j.id} className="h-7 px-2 text-[10px] gap-1">
                                    {deletingJob === j.id ? <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden="true" /> : <Trash2 className="h-3 w-3" aria-hidden="true" />}
                                    Delete
                                  </Button>
                                </div>
                              ) : (
                                <Button variant="ghost" size="icon" aria-label={`Delete job ${j.name}`}
                                  disabled={deletingJob === j.id}
                                  className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                  onClick={() => requestDeleteJob(j.id)}>
                                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                                </Button>
                              )}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                    <Dialog open={editingJobId !== null} onOpenChange={open => { if (!open) cancelEditJob() }}>
                      <DialogContent aria-describedby="edit-job-dlg-desc">
                        <DialogHeader>
                          <DialogTitle>Edit job</DialogTitle>
                          <DialogDescription id="edit-job-dlg-desc">
                            {jobs.find(x => x.id === editingJobId)?.name ?? 'Change schedule, timeouts, and monitoring without redeploying.'}
                          </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-3 max-h-[min(70vh,520px)] overflow-y-auto pr-1">
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                              <Label htmlFor="edit-dlg-name" className="text-xs text-muted-foreground">Job name</Label>
                              <Input
                                id="edit-dlg-name"
                                value={editJob.name}
                                onChange={e => {
                                  setEditJob(v => ({ ...v, name: e.target.value }))
                                  if (editJobErrors.name) setEditJobErrors(p => ({ ...p, name: '' }))
                                }}
                                aria-invalid={!!editJobErrors.name}
                                className="h-8 text-xs"
                              />
                              <FieldError msg={editJobErrors.name} id="edit-dlg-name-err" />
                            </div>
                            <div className="space-y-1">
                              <Label htmlFor="edit-dlg-comment" className="text-xs text-muted-foreground">
                                Description <span className="opacity-50">(optional)</span>
                              </Label>
                              <Input
                                id="edit-dlg-comment"
                                value={editJob.comment}
                                onChange={e => setEditJob(v => ({ ...v, comment: e.target.value }))}
                                className="h-8 text-xs"
                              />
                            </div>
                          </div>
                          <div className="flex items-start gap-2 rounded-md border border-border/50 px-2 py-2">
                            <input
                              id="edit-dlg-enabled"
                              type="checkbox"
                              className="mt-0.5 h-4 w-4 shrink-0 rounded border-border"
                              checked={editJob.enabled}
                              onChange={e => setEditJob(v => ({ ...v, enabled: e.target.checked }))}
                              aria-describedby="edit-dlg-enabled-hint"
                            />
                            <div className="min-w-0">
                              <Label htmlFor="edit-dlg-enabled" className="text-sm font-medium text-foreground cursor-pointer">
                                Monitoring enabled
                              </Label>
                              <p id="edit-dlg-enabled-hint" className="text-xs text-muted-foreground mt-0.5">
                                When off, the job is paused: no server-side runs and no missed-heartbeat alerts.
                              </p>
                            </div>
                          </div>
                          <div className="rounded-md border border-border/50 bg-muted/10 px-3 py-2.5 space-y-2">
                            <p className="text-xs font-medium text-foreground">Alert channels</p>
                            <p className="text-[10px] text-muted-foreground leading-snug">
                              Default: all enabled account channels plus SMTP (when configured). Custom: only the checkboxes you select (include “Email (SMTP)” if you still want mail).
                            </p>
                            <label className="flex items-start gap-2 text-xs cursor-pointer">
                              <input
                                type="radio"
                                name="edit-alert-routing"
                                className="mt-0.5 h-4 w-4 shrink-0"
                                checked={editJob.alert_use_default_channels}
                                onChange={() => setEditJob(v => ({ ...v, alert_use_default_channels: true }))}
                              />
                              <span>Use account default</span>
                            </label>
                            <label className="flex items-start gap-2 text-xs cursor-pointer">
                              <input
                                type="radio"
                                name="edit-alert-routing"
                                className="mt-0.5 h-4 w-4 shrink-0"
                                checked={!editJob.alert_use_default_channels}
                                onChange={() => setEditJob(v => ({ ...v, alert_use_default_channels: false }))}
                              />
                              <span>Custom selection</span>
                            </label>
                            {!editJob.alert_use_default_channels && (
                              <div className="ml-5 space-y-1.5 max-h-36 overflow-y-auto border-l border-border/50 pl-3">
                                <label className="flex items-center gap-2 text-[11px] cursor-pointer">
                                  <input
                                    type="checkbox"
                                    className="h-3.5 w-3.5 shrink-0 rounded border-border"
                                    checked={editJob.alert_channel_ids.includes(SMTP_ALERT_CHANNEL_SENTINEL)}
                                    onChange={e => {
                                      const on = e.target.checked
                                      setEditJob(v => ({
                                        ...v,
                                        alert_channel_ids: on
                                          ? [...new Set([...v.alert_channel_ids, SMTP_ALERT_CHANNEL_SENTINEL])]
                                          : v.alert_channel_ids.filter(x => x !== SMTP_ALERT_CHANNEL_SENTINEL),
                                      }))
                                    }}
                                  />
                                  Email (SMTP)
                                </label>
                                {alertChannelPickList.map(c => (
                                  <label key={c.id} className="flex items-center gap-2 text-[11px] cursor-pointer">
                                    <input
                                      type="checkbox"
                                      className="h-3.5 w-3.5 shrink-0 rounded border-border"
                                      checked={editJob.alert_channel_ids.includes(c.id)}
                                      onChange={e => {
                                        const on = e.target.checked
                                        setEditJob(v => ({
                                          ...v,
                                          alert_channel_ids: on
                                            ? [...new Set([...v.alert_channel_ids, c.id])]
                                            : v.alert_channel_ids.filter(x => x !== c.id),
                                        }))
                                      }}
                                    />
                                    <span className="truncate">
                                      {c.label || c.kind}{' '}
                                      <span className="text-muted-foreground">({c.kind})</span>
                                    </span>
                                  </label>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor="edit-dlg-sched" className="text-xs text-muted-foreground">Schedule</Label>
                            <CronExpressionHelper
                              id="edit-dlg-sched"
                              value={editJob.schedule}
                              onChange={v => {
                                setEditJob(ev => ({ ...ev, schedule: v }))
                                if (editJobErrors.schedule) setEditJobErrors(p => ({ ...p, schedule: '' }))
                              }}
                              errors={editJobErrors.schedule}
                              presets={presets}
                              timezone={editJob.timezone}
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                              <Label htmlFor="edit-dlg-grace-min" className="text-xs text-muted-foreground">
                                Heartbeat grace <span className="opacity-50">(whole minutes)</span>
                              </Label>
                              <Input
                                id="edit-dlg-grace-min"
                                type="number"
                                min={1}
                                max={10080}
                                value={editJob.heartbeat_grace_minutes}
                                onChange={e =>
                                  setEditJob(v => ({
                                    ...v,
                                    heartbeat_grace_minutes: Math.min(10080, Math.max(1, parseInt(e.target.value, 10) || 1)),
                                  }))
                                }
                                className="h-8 text-xs"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label htmlFor="edit-dlg-timeout" className="text-xs text-muted-foreground">
                                Timeout <span className="opacity-50">(seconds; 0 = none)</span>
                              </Label>
                              <Input
                                id="edit-dlg-timeout"
                                type="number"
                                min={0}
                                max={604800}
                                value={editJob.timeout_seconds}
                                onChange={e =>
                                  setEditJob(v => ({
                                    ...v,
                                    timeout_seconds: Math.min(604800, Math.max(0, parseInt(e.target.value, 10) || 0)),
                                  }))
                                }
                                className="h-8 text-xs"
                              />
                              <label className="flex items-start gap-2 text-[11px] text-muted-foreground cursor-pointer mt-2 max-w-lg">
                                <input
                                  type="checkbox"
                                  checked={editJob.timeout_remote_kill_enabled}
                                  onChange={e => setEditJob(v => ({ ...v, timeout_remote_kill_enabled: e.target.checked }))}
                                  className="mt-0.5 h-3.5 w-3.5 rounded border-border"
                                />
                                <span>Remote kill hint for agents (SIGTERM before final timeout).</span>
                              </label>
                            </div>
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor="edit-dlg-cmd" className="text-xs text-muted-foreground">Command</Label>
                            <Textarea
                              id="edit-dlg-cmd"
                              value={editJob.command}
                              onChange={e => {
                                setEditJob(v => ({ ...v, command: e.target.value }))
                                if (editJobErrors.command) setEditJobErrors(p => ({ ...p, command: '' }))
                              }}
                              onKeyDown={e => {
                                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void saveEditJob()
                              }}
                              aria-invalid={!!editJobErrors.command}
                              rows={2}
                              className="font-mono text-xs resize-none"
                            />
                            <FieldError msg={editJobErrors.command} id="edit-dlg-cmd-err" />
                          </div>
                          <button
                            type="button"
                            onClick={() => setShowEditAdvanced(v => !v)}
                            className="flex w-full items-center justify-between rounded-md border border-border/60 bg-muted/20 px-2.5 py-2 text-xs font-medium text-muted-foreground hover:bg-muted/40"
                          >
                            <span>More (timezone, working dir, venv, success exit, logging)</span>
                            {showEditAdvanced ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                          </button>
                          {showEditAdvanced && (
                            <div className="space-y-3 rounded-md border border-border/40 bg-muted/10 p-3">
                              <div className="space-y-1">
                                <Label htmlFor="edit-dlg-tz" className="text-xs text-muted-foreground">Timezone</Label>
                                <Select value={editJob.timezone} onValueChange={v => setEditJob(ev => ({ ...ev, timezone: v }))}>
                                  <SelectTrigger id="edit-dlg-tz" className="h-8 text-xs w-52">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="Local">Local (server)</SelectItem>
                                    <SelectItem value="UTC">UTC</SelectItem>
                                    <SelectItem value="Asia/Karachi">Asia/Karachi</SelectItem>
                                    <SelectItem value="Asia/Dubai">Asia/Dubai</SelectItem>
                                    <SelectItem value="Europe/London">Europe/London</SelectItem>
                                    <SelectItem value="America/New_York">America/New_York</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="grid grid-cols-2 gap-3">
                                <div className="space-y-1">
                                  <Label htmlFor="edit-dlg-wd" className="text-xs text-muted-foreground">
                                    Working directory <span className="opacity-50">(optional)</span>
                                  </Label>
                                  <Input
                                    id="edit-dlg-wd"
                                    value={editJob.working_directory}
                                    placeholder="/home/user/myproject"
                                    onChange={e => setEditJob(v => ({ ...v, working_directory: e.target.value }))}
                                    className="h-8 font-mono text-xs"
                                  />
                                </div>
                                <div className="space-y-1">
                                  <Label htmlFor="edit-dlg-venv" className="text-xs text-muted-foreground">
                                    Python venv <span className="opacity-50">(optional)</span>
                                  </Label>
                                  <Input
                                    id="edit-dlg-venv"
                                    value={editJob.venv_path}
                                    placeholder="/home/user/project/.venv"
                                    onChange={e => setEditJob(v => ({ ...v, venv_path: e.target.value }))}
                                    className="h-8 font-mono text-xs"
                                  />
                                </div>
                              </div>
                              <div className="space-y-1">
                                <Label htmlFor="edit-dlg-exit" className="text-xs text-muted-foreground">
                                  Success exit code <span className="opacity-50">(0–255)</span>
                                </Label>
                                <Input
                                  id="edit-dlg-exit"
                                  type="number"
                                  min={0}
                                  max={255}
                                  value={editJob.success_exit_code}
                                  onChange={e =>
                                    setEditJob(v => ({
                                      ...v,
                                      success_exit_code: Math.min(255, Math.max(0, parseInt(e.target.value, 10) || 0)),
                                    }))
                                  }
                                  className="h-8 text-xs w-28"
                                />
                              </div>
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  id="edit-dlg-logging-switch"
                                  role="switch"
                                  aria-checked={editJob.logging_enabled}
                                  aria-label="Enable execution logging"
                                  onClick={() => setEditJob(v => ({ ...v, logging_enabled: !v.logging_enabled }))}
                                  className={`relative h-5 w-9 shrink-0 rounded-full transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${editJob.logging_enabled ? 'bg-primary' : 'bg-muted'}`}
                                >
                                  <span
                                    className={`pointer-events-none absolute top-0.5 h-4 w-4 rounded-full shadow transition-transform motion-reduce:transition-none ${editJob.logging_enabled ? 'translate-x-4 bg-primary-foreground' : 'translate-x-0.5 bg-card'}`}
                                  />
                                </button>
                                <Label htmlFor="edit-dlg-logging-switch" className="text-sm font-medium text-foreground cursor-pointer">
                                  Enable logging
                                </Label>
                              </div>
                            </div>
                          )}
                        </div>
                        <DialogFooter className="gap-2 sm:gap-2">
                          <Button type="button" variant="outline" onClick={cancelEditJob} className="h-8 text-xs">
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            onClick={() => void saveEditJob()}
                            disabled={editJobSaving}
                            className="h-8 text-xs gap-1.5"
                          >
                            {editJobSaving ? (
                              <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />
                            ) : (
                              <Check className="h-3.5 w-3.5" aria-hidden="true" />
                            )}
                            {editJobSaving ? 'Saving…' : 'Save'}
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                    <AlertDialog open={editJobScheduleConfirmOpen} onOpenChange={setEditJobScheduleConfirmOpen}>
                      <AlertDialogContent aria-describedby={editJobConfirmDescId}>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Save schedule or monitoring change?</AlertDialogTitle>
                          <AlertDialogDescription id={editJobConfirmDescId}>
                            This job is healthy and monitored. Changing the schedule or the monitoring switch can shift
                            heartbeat deadlines and alert timing.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            type="button"
                            onClick={() => {
                              void saveEditJob({ skipScheduleActiveConfirm: true })
                            }}
                          >
                            Save changes
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                    <AlertDialog
                      open={confirmDeleteEnv !== null}
                      onOpenChange={open => {
                        if (!open) setConfirmDeleteEnv(null)
                      }}
                    >
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Remove environment variable?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This deletes{' '}
                            <span className="font-mono text-foreground">{confirmDeleteEnv?.name ?? ''}</span> for this job.
                            Host scripts that export this variable from CronSentinel should be updated.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            type="button"
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => {
                              const p = confirmDeleteEnv
                              setConfirmDeleteEnv(null)
                              if (p) void removeJobEnvVar(p.jobId, p.name)
                            }}
                          >
                            Remove
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                    </>
                  )}
                </div>
              )}

              {/* ══════════════════════════════════════════════════════════ */}
              {/* SCRIPTS TAB                                               */}
              {/* ══════════════════════════════════════════════════════════ */}
              {activeTab === 'scripts' && (
                <div role="tabpanel" id="panel-scripts" aria-labelledby="tab-scripts">
                  <div className="flex items-center gap-3 mb-3">
                    <div>
                      <h1 className="text-base font-semibold tracking-tight text-primary uppercase">Scripts</h1>
                      <p className="text-[11px] text-muted-foreground">{scripts.length} saved script{scripts.length !== 1 ? 's' : ''}</p>
                    </div>
                    <div className="flex-1" />
                    <Button size="sm" onClick={() => setShowScriptForm(f => !f)} className="h-8 gap-1.5 text-xs">
                      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                      New Script
                    </Button>
                  </div>

                  {/* ── Inline add-script form ── */}
                  {showScriptForm && (
                    <div className="mb-4 rounded-lg border border-primary/20 bg-card p-4 shadow-sm" role="region" aria-label="Add new script">
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-xs font-semibold">New Script</p>
                        <button onClick={() => setShowScriptForm(false)} aria-label="Close form" className="text-muted-foreground hover:text-foreground">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div className="space-y-2">
                        <div className="space-y-1">
                          <Label htmlFor="script-name" className="text-xs text-muted-foreground">Script name</Label>
                          <Input id="script-name" placeholder="e.g. backup" value={newScript.name}
                            onChange={e => { setNewScript(s => ({ ...s, name: e.target.value })); if (scriptErrors.name) setScriptErrors({ name: '' }) }}
                            aria-invalid={!!scriptErrors.name} className="h-8 text-xs" />
                          <FieldError msg={scriptErrors.name} id="script-name-error" />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="script-content" className="text-xs text-muted-foreground">Content</Label>
                          <Textarea id="script-content" rows={6} value={newScript.content}
                            onChange={e => setNewScript(s => ({ ...s, content: e.target.value }))}
                            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveScript() }}
                            className="font-mono text-xs resize-none" />
                          <p className="text-[10px] text-muted-foreground/60">Tip: Ctrl+Enter to save</p>
                        </div>
                        <div className="flex justify-end">
                          <Button size="sm" onClick={saveScript} disabled={scriptSaving} className="h-8 text-xs gap-1.5">
                            {scriptSaving ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" /> : <Code2 className="h-3.5 w-3.5" aria-hidden="true" />}
                            {scriptSaving ? 'Saving…' : 'Save Script'}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ── Script list ── */}
                  {scripts.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-12 text-center bg-card">
                      <FileCode2 className="h-8 w-8 text-muted-foreground/30" aria-hidden="true" />
                      <p className="text-sm font-medium text-muted-foreground">No scripts yet</p>
                      <p className="text-xs text-muted-foreground/60">Click "New Script" to add your first one</p>
                    </div>
                  ) : (
                    <ul className="space-y-2" role="list">
                      {scripts.map(s => (
                        <li key={s.name} className="rounded-lg border border-border/50 bg-card shadow-xs overflow-hidden">
                          <div className="flex items-center gap-3 px-4 py-3">
                            <div
                              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border ${cs.late.surface}`}
                              aria-hidden="true"
                            >
                              <FileCode2 className={`h-4 w-4 ${cs.late.icon}`} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-semibold text-foreground mb-0.5">{s.name}<span className="text-muted-foreground font-normal">.sh</span></p>
                              <code className="block truncate text-[10px] text-muted-foreground font-mono">
                                {s.content.split('\n').find(l => l && !l.startsWith('#!') && !l.startsWith('set ')) ?? s.content.split('\n')[0]}
                              </code>
                              <p className="text-[10px] text-muted-foreground/60 mt-0.5">{new Date(s.created_at).toLocaleString()}</p>
                            </div>
                            {confirmDeleteScript === s.name ? (
                              <div className="flex gap-1 shrink-0" role="group" aria-label={`Confirm delete ${s.name}`}>
                                <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteScript(null)} className="h-7 px-2 text-[10px]">Cancel</Button>
                                <Button variant="destructive" size="sm" onClick={() => deleteScript(s.name)} disabled={deletingScript === s.name} className="h-7 px-2 text-[10px] gap-1">
                                  {deletingScript === s.name ? <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden="true" /> : <Trash2 className="h-3 w-3" aria-hidden="true" />}
                                  Delete
                                </Button>
                              </div>
                            ) : (
                              <Button variant="ghost" size="icon" aria-label={`Delete script ${s.name}`}
                                disabled={deletingScript === s.name}
                                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                onClick={() => requestDeleteScript(s.name)}>
                                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                              </Button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* ══════════════════════════════════════════════════════════ */}
              {/* RUNS TAB                                                  */}
              {/* ══════════════════════════════════════════════════════════ */}
              {activeTab === 'runs' && (
                <div role="tabpanel" id="panel-runs" aria-labelledby="tab-runs">
                  {runsJobId.trim() && (
                    <DurationTrendChart jobId={runsJobId.trim()} />
                  )}
                  {apiOnline === false && (
                    <div
                      role="alert"
                      className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"
                    >
                      <div className="flex items-center gap-2 text-destructive">
                        <WifiOff className="h-4 w-4 shrink-0" aria-hidden />
                        <span>Could not refresh run history. Check the API and try again.</span>
                      </div>
                      <Button type="button" variant="secondary" size="sm" onClick={() => void refresh(true)}>
                        Retry
                      </Button>
                    </div>
                  )}
                  <div className="flex items-center gap-3 mb-3 flex-wrap">
                    <div>
                      <h1 className="text-base font-semibold tracking-tight text-primary uppercase">Run History</h1>
                      <p className="text-[11px] text-muted-foreground">
                        On this page: {pageSuccessCount} succeeded · {pageFailedCount} failed · showing {runs.length} of {runsTotal}
                      </p>
                      {runsJobId.trim() ? (
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                          <span className="text-[10px] font-medium text-muted-foreground">Filtered to job:</span>
                          <Badge variant="secondary" className="gap-1 text-[10px] font-normal">
                            {jobs.find(j => j.id === runsJobId.trim())?.name ?? runsJobId.trim().slice(0, 8)}
                          </Badge>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-[10px]"
                            onClick={() => {
                              setRunsJobId('')
                              setRunsOffset(0)
                            }}
                          >
                            Clear job filter
                          </Button>
                        </div>
                      ) : null}
                    </div>
                    <div className="flex-1" />
                    <div className="relative">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" aria-hidden="true" />
                      <input
                        type="search"
                        placeholder="Search runs…"
                        value={runsSearch}
                        onChange={e => { setRunsSearch(e.target.value); setRunsOffset(0) }}
                        className="h-8 rounded-md border border-border/60 bg-card pl-7 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary w-36"
                        aria-label="Search runs"
                      />
                    </div>
                    {/* Status filter */}
                    <div className="flex rounded-md border border-border/60 overflow-hidden text-[10px] font-semibold">
                      {([
                        ['all',        'All',       runs.length],
                        ['running',  'Running',     runs.filter(r => r.status.toLowerCase() === 'running').length],
                        ['success',    'Success',     pageSuccessCount],
                        ['failed',     'Failed',      pageFailedCount],
                        ['timed_out',  'Timed out',   pageTimedOutCount],
                      ] as ['all'|'running'|'success'|'failed'|'timed_out', string, number][]).map(([id, label, count]) => (
                        <button
                          key={id}
                          onClick={() => { setRunsFilter(id); setRunsOffset(0) }}
                          className={`px-2.5 py-1.5 flex items-center gap-1 transition-colors ${runsFilter === id ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-muted/40'}`}
                        >
                          {label}
                          <span className={`rounded px-1 text-[11px] tabular-nums ${runsFilter === id ? 'bg-primary-foreground/20' : 'bg-muted'}`}>{count}</span>
                        </button>
                      ))}
                    </div>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={runsCompactMode}
                        onChange={e => setRunsCompactMode(e.target.checked)}
                        className="h-3.5 w-3.5"
                      />
                      Compact
                    </label>
                    <Select value={String(runsPageSize)} onValueChange={(v) => { setRunsPageSize(Number(v)); setRunsOffset(0) }}>
                      <SelectTrigger className="h-8 w-[108px] text-xs">
                        <SelectValue placeholder="Page size" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="25">25 / page</SelectItem>
                        <SelectItem value="50">50 / page</SelectItem>
                        <SelectItem value="100">100 / page</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 text-[10px] text-muted-foreground"
                      onClick={() => {
                        setRunsRangePreset('all')
                        setRunsStartedAfter('')
                        setRunsStartedBefore('')
                        setRunsMinDurationMs('')
                        setRunsMaxDurationMs('')
                        setRunsOffset(0)
                      }}
                    >
                      Clear date/duration
                    </Button>
                    <Separator orientation="vertical" className="hidden h-6 sm:block" aria-hidden />
                    <div className="flex flex-col gap-0.5 sm:items-start">
                      <div className="flex flex-wrap gap-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 text-[11px] gap-1.5 border-primary/20 bg-card hover:bg-primary/5 hover:border-primary/35"
                          disabled={runsCsvDownloading}
                          onClick={() => void exportRunsCsv()}
                          title="Download up to 500 runs matching current filters (CSV)."
                        >
                          {runsCsvDownloading ? (
                            <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin shrink-0" aria-hidden />
                          ) : (
                            <Download className="h-3.5 w-3.5 shrink-0 text-primary/80" aria-hidden />
                          )}
                          Download CSV
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 text-[11px] gap-1.5 border-primary/20 bg-card hover:bg-primary/5 hover:border-primary/35"
                          disabled={emailHistorySending || runsTotal === 0}
                          onClick={() => void emailFilteredRuns()}
                          aria-describedby="runs-email-export-hint"
                          title="Sends up to 500 newest runs that match the current status filter and search. Configure SMTP under Settings."
                        >
                          {emailHistorySending ? (
                            <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin shrink-0" aria-hidden />
                          ) : (
                            <Mail className="h-3.5 w-3.5 shrink-0 text-primary/80" aria-hidden />
                          )}
                          Email export
                        </Button>
                      </div>
                      <p id="runs-email-export-hint" className="text-[9px] text-muted-foreground leading-snug max-w-[220px] hidden sm:block">
                        CSV: up to 500 rows per download. Email: plain-text to Settings recipients (max 500).
                      </p>
                    </div>
                  </div>

                  <div className="mb-3 flex flex-col gap-2 rounded-md border border-border/50 bg-muted/20 p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground shrink-0">Date range</span>
                      <div className="flex flex-wrap gap-1" role="group" aria-label="Date range preset">
                        {(
                          [
                            ['all', 'All time'],
                            ['7d', 'Last 7 days'],
                            ['30d', 'Last 30 days'],
                            ['90d', 'Last 90 days'],
                            ['custom', 'Custom'],
                          ] as const
                        ).map(([key, label]) => (
                          <Button
                            key={key}
                            type="button"
                            variant={runsRangePreset === key ? 'default' : 'outline'}
                            size="sm"
                            className="h-7 px-2 text-[10px]"
                            onClick={() => {
                              setRunsRangePreset(key)
                              if (key === 'all') {
                                setRunsStartedAfter('')
                                setRunsStartedBefore('')
                              } else if (key === '7d' || key === '30d' || key === '90d') {
                                const r = rangeFromPreset(key)
                                setRunsStartedAfter(r.startedAfter)
                                setRunsStartedBefore(r.startedBefore)
                              }
                              setRunsOffset(0)
                            }}
                          >
                            {label}
                          </Button>
                        ))}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                    <div className="space-y-0.5 min-w-[140px] flex-1 sm:flex-none sm:min-w-[180px]">
                      <Label className="text-[9px] uppercase tracking-wide text-muted-foreground">started_after (RFC3339)</Label>
                      <Input
                        className="h-8 text-[11px] font-mono"
                        placeholder="2026-03-01T00:00:00Z"
                        value={runsStartedAfter}
                        onChange={e => {
                          setRunsRangePreset('custom')
                          setRunsStartedAfter(e.target.value)
                          setRunsOffset(0)
                        }}
                        aria-label="Filter runs started after"
                      />
                    </div>
                    <div className="space-y-0.5 min-w-[140px] flex-1 sm:flex-none sm:min-w-[180px]">
                      <Label className="text-[9px] uppercase tracking-wide text-muted-foreground">started_before (RFC3339)</Label>
                      <Input
                        className="h-8 text-[11px] font-mono"
                        placeholder="2026-03-31T23:59:59Z"
                        value={runsStartedBefore}
                        onChange={e => {
                          setRunsRangePreset('custom')
                          setRunsStartedBefore(e.target.value)
                          setRunsOffset(0)
                        }}
                        aria-label="Filter runs started before"
                      />
                    </div>
                    <div className="space-y-0.5 w-[120px]">
                      <Label className="text-[9px] uppercase tracking-wide text-muted-foreground">min_duration_ms</Label>
                      <Input
                        className="h-8 text-[11px] font-mono"
                        type="number"
                        min={0}
                        placeholder="1000"
                        value={runsMinDurationMs}
                        onChange={e => {
                          setRunsRangePreset('custom')
                          setRunsMinDurationMs(e.target.value)
                          setRunsOffset(0)
                        }}
                        aria-label="Minimum duration milliseconds"
                      />
                    </div>
                    <div className="space-y-0.5 w-[120px]">
                      <Label className="text-[9px] uppercase tracking-wide text-muted-foreground">max_duration_ms</Label>
                      <Input
                        className="h-8 text-[11px] font-mono"
                        type="number"
                        min={0}
                        placeholder="60000"
                        value={runsMaxDurationMs}
                        onChange={e => {
                          setRunsRangePreset('custom')
                          setRunsMaxDurationMs(e.target.value)
                          setRunsOffset(0)
                        }}
                        aria-label="Maximum duration milliseconds"
                      />
                    </div>
                    </div>
                  </div>

                  {runs.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-12 text-center bg-card">
                      <Activity className="h-8 w-8 text-muted-foreground/30" aria-hidden="true" />
                      <p className="text-sm font-medium text-muted-foreground">No runs recorded yet</p>
                      <p className="text-xs text-muted-foreground/60">Trigger a job to see results here</p>
                    </div>
                  ) : (
                    <>
                      <div className="hidden md:block rounded-md border border-border/60 overflow-hidden bg-card">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Job</TableHead>
                              <TableHead>Started</TableHead>
                              <TableHead>Duration</TableHead>
                              <TableHead>Exit</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead className="min-w-[140px] max-w-[280px]">Log preview</TableHead>
                              <TableHead className="w-10" aria-label="Expand" />
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {runsFiltered.map((r) => (
                              <Fragment key={r.id}>
                                <TableRow
                                  className="cursor-pointer"
                                  tabIndex={0}
                                  onClick={() => setSelectedRun(selectedRun === r.id ? '' : r.id)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault()
                                      setSelectedRun(selectedRun === r.id ? '' : r.id)
                                    }
                                  }}
                                  data-state={selectedRun === r.id ? 'selected' : undefined}
                                >
                                  <TableCell className="font-medium text-xs max-w-[140px] truncate">{r.job_name}</TableCell>
                                  <TableCell className="text-[11px] text-muted-foreground whitespace-nowrap">
                                    {new Date(r.started_at).toLocaleString()}
                                  </TableCell>
                                  <TableCell className="text-[11px] text-muted-foreground whitespace-nowrap">
                                    {r.ended_at ? runDuration(r) : '—'}
                                  </TableCell>
                                  <TableCell className="text-[11px] font-mono">{r.exit_code != null ? r.exit_code : '—'}</TableCell>
                                  <TableCell>
                                    <RunBadge status={r.status} />
                                  </TableCell>
                                  <TableCell className="text-[10px] text-muted-foreground max-w-[280px]">
                                    <span className="line-clamp-2 break-all" title={r.log_preview ?? ''}>
                                      {(r.log_preview ?? '').trim() || '—'}
                                    </span>
                                  </TableCell>
                                  <TableCell className="p-2">
                                    <ChevronRight
                                      className={`h-3.5 w-3.5 text-muted-foreground/50 transition-transform ${selectedRun === r.id ? 'rotate-90' : ''}`}
                                      aria-hidden
                                    />
                                  </TableCell>
                                </TableRow>
                                {selectedRun === r.id && (
                                  <TableRow className="hover:bg-transparent">
                                    <TableCell colSpan={7} className="p-0">
                                      <RunHistoryLogPanel
                                        run={r}
                                        logsLoading={logsLoading}
                                        logsStdout={logs.stdout}
                                        logsStderr={logs.stderr}
                                        logsTruncOut={logsTrunc.stdout}
                                        logsTruncErr={logsTrunc.stderr}
                                      />
                                    </TableCell>
                                  </TableRow>
                                )}
                              </Fragment>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                      <ul className="space-y-2 md:hidden" role="list">
                        {runsFiltered.map((r) => (
                          <li key={r.id} className="rounded-lg border border-border/50 bg-card shadow-xs overflow-hidden">
                            <button
                              type="button"
                              className={`w-full flex items-center gap-3 px-4 ${runsCompactMode ? 'py-2' : 'py-3'} text-left transition-colors ${selectedRun === r.id ? 'bg-primary/5' : 'hover:bg-muted/30'}`}
                              onClick={() => setSelectedRun(selectedRun === r.id ? '' : r.id)}
                              aria-expanded={selectedRun === r.id}
                              aria-label={`${r.job_name}, ${r.status}`}
                            >
                              <RunBadge status={r.status} />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <p className="text-xs font-semibold text-foreground">{r.job_name}</p>
                                  {r.exit_code != null && (
                                    <span
                                      className={`rounded border px-1.5 py-px font-mono text-xs ${
                                        isRunSuccess(r.status)
                                          ? cs.healthy.surface
                                          : isRunTimedOut(r.status)
                                            ? cs.late.surface
                                            : cs.failed.surface
                                      }`}
                                    >
                                      exit {r.exit_code}
                                    </span>
                                  )}
                                </div>
                                {r.command && (
                                  <code className="block truncate text-[10px] text-muted-foreground font-mono mt-0.5 max-w-xs">
                                    $ {r.command}
                                  </code>
                                )}
                                <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                                  {new Date(r.started_at).toLocaleString()}
                                  {r.ended_at && <span className="ml-2">· {runDuration(r)}</span>}
                                </p>
                                {(r.log_preview ?? '').trim() ? (
                                  <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2 break-all" title={r.log_preview}>
                                    {r.log_preview}
                                  </p>
                                ) : null}
                                {r.failure_reason && (
                                  <p className="flex items-center gap-1 text-[10px] text-destructive mt-0.5">
                                    <AlertCircle className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
                                    {r.failure_reason}
                                  </p>
                                )}
                                {r.failure_fix && (
                                  <span className={`mt-1 inline-flex rounded border px-1.5 py-px text-xs ${cs.late.surface}`}>
                                    Suggested fix available
                                  </span>
                                )}
                              </div>
                              <ChevronRight
                                className={`h-3.5 w-3.5 text-muted-foreground/50 shrink-0 transition-transform ${selectedRun === r.id ? 'rotate-90' : ''}`}
                                aria-hidden="true"
                              />
                            </button>
                            {selectedRun === r.id && (
                              <RunHistoryLogPanel
                                run={r}
                                logsLoading={logsLoading}
                                logsStdout={logs.stdout}
                                logsStderr={logs.stderr}
                                logsTruncOut={logsTrunc.stdout}
                                logsTruncErr={logsTrunc.stderr}
                              />
                            )}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {runsTotal > 0 && (
                    <div className="mt-3 flex items-center justify-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-[11px]"
                      onClick={() => setRunsOffset(o => Math.max(0, o - runsPageSize))}
                      disabled={runsOffset === 0}
                    >
                      Previous
                    </Button>
                    <span className="text-[11px] text-muted-foreground">
                      {runsRangeLabel}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-[11px]"
                      onClick={() => setRunsOffset(o => o + runsPageSize)}
                      disabled={!runsHasMore}
                    >
                      Next
                    </Button>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'servers' && (
                <div role="tabpanel" id="panel-servers" aria-labelledby="tab-servers">
                  <div className="sticky top-0 z-10 -mx-5 mb-3 flex flex-wrap items-center gap-3 border-b border-border/40 bg-background/95 px-5 py-2 backdrop-blur">
                    <div>
                      <h1 className="text-[15px] font-bold tracking-tight text-primary uppercase">Servers</h1>
                      <p className="text-[11px] text-muted-foreground max-w-xl">
                        Each host POSTs to a dedicated URL about every 60 seconds. If CronSentinel sees no ping for 3 minutes, it can email a{' '}
                        <strong className="font-medium text-foreground/90">server unreachable</strong> alert. Use the same server token to POST{' '}
                        <strong className="font-medium text-foreground/90">crontab snapshots</strong> on your configured interval (default 5 minutes); when the
                        file changes, CronSentinel can email a diff and show it below.
                      </p>
                    </div>
                    <div className="flex-1" />
                  </div>

                  {apiOnline === false && (
                    <div
                      role="alert"
                      className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"
                    >
                      <div className="flex items-center gap-2 text-destructive">
                        <WifiOff className="h-4 w-4 shrink-0" aria-hidden />
                        <span>Could not load servers. Check the API and try again.</span>
                      </div>
                      <Button type="button" variant="secondary" size="sm" onClick={() => void refresh(true)}>
                        Retry
                      </Button>
                    </div>
                  )}

                  {lastCreatedServerToken && (
                    <div
                      className="mb-4 rounded-lg border border-primary/25 bg-primary/5 p-4"
                      role="status"
                      aria-live="polite"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs font-semibold text-foreground">
                          New token for <span className="text-primary">{lastCreatedServerToken.name}</span>
                        </p>
                        <button
                          type="button"
                          aria-label="Dismiss token reminder"
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() => setLastCreatedServerToken(null)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        Add one of these to the machine (cron, systemd timer, or a small loop). On failure, retry with backoff so a blip does not spam the API.
                      </p>
                      <div className="mt-3 space-y-2">
                        <div>
                          <p className="text-[10px] font-medium text-muted-foreground mb-0.5">POST URL</p>
                          <code className="block break-all rounded border border-border/60 bg-card px-2 py-1.5 text-[10px] font-mono">
                            {serverHeartbeatRequestUrl(lastCreatedServerToken.token)}
                          </code>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="mt-1.5 h-7 text-[10px] gap-1"
                            onClick={() => copyToClipboard(serverHeartbeatRequestUrl(lastCreatedServerToken.token))}
                          >
                            <Copy className="h-3 w-3" aria-hidden />
                            Copy URL
                          </Button>
                        </div>
                        <div>
                          <p className="text-[10px] font-medium text-muted-foreground mb-0.5">Cron (once per minute)</p>
                          <code className="block break-all rounded border border-border/60 bg-card px-2 py-1.5 text-[10px] font-mono whitespace-pre-wrap">
                            {serverHeartbeatCronLine(lastCreatedServerToken.token)}
                          </code>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="mt-1.5 h-7 text-[10px] gap-1"
                            onClick={() => copyToClipboard(serverHeartbeatCronLine(lastCreatedServerToken.token))}
                          >
                            <Copy className="h-3 w-3" aria-hidden />
                            Copy cron line
                          </Button>
                        </div>
                        <div>
                          <p className="text-[10px] font-medium text-muted-foreground mb-0.5">Bash loop (~60s, backoff on error)</p>
                          <code className="block break-all rounded border border-border/60 bg-card px-2 py-1.5 text-[10px] font-mono whitespace-pre-wrap">
                            {`while true; do\n  if curl -fsS -X POST '${serverHeartbeatRequestUrl(lastCreatedServerToken.token)}' -H 'Content-Type: text/plain' --data-raw 'ok'; then\n    sleep 60\n  else\n    sleep $((8 + RANDOM % 8))\n  fi\ndone`}
                          </code>
                        </div>
                        <div>
                          <p className="text-[10px] font-medium text-muted-foreground mb-0.5">Crontab snapshot endpoint (same token)</p>
                          <code className="block break-all rounded border border-border/60 bg-card px-2 py-1.5 text-[10px] font-mono">
                            {crontabSnapshotPostUrl(lastCreatedServerToken.token)}
                          </code>
                          <p className="text-[9px] text-muted-foreground/70 mt-1 max-w-xl leading-snug">
                            POST JSON with <code className="text-[9px]">content</code> (full crontab text), optional <code className="text-[9px]">capture_error</code>{' '}
                            when <code className="text-[9px]">crontab -l</code> fails, and <code className="text-[9px]">user_context</code> (e.g. user). Poll about every{' '}
                            <strong className="font-medium">5 minutes</strong> unless you change the interval under the server row. Optional <code className="text-[9px]">content_hash</code>{' '}
                            must match SHA-256 of <code className="text-[9px]">content</code> if sent.
                          </p>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="mt-1.5 h-7 text-[10px] gap-1"
                            onClick={() =>
                              copyToClipboard(
                                `curl -sS -X POST '${crontabSnapshotPostUrl(lastCreatedServerToken.token)}' -H 'Content-Type: application/json' -d '{"content":"0 * * * * echo demo","user_context":"root"}'`,
                              )
                            }
                          >
                            <Copy className="h-3 w-3" aria-hidden />
                            Copy minimal crontab POST example
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="mb-4 rounded-lg border border-border/50 bg-card p-4 shadow-sm">
                    <p className="text-xs font-semibold mb-2">Register a server</p>
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="space-y-1 min-w-[200px] flex-1">
                        <Label htmlFor="new-server-name" className="text-[10px] text-muted-foreground">
                          Display name
                        </Label>
                        <Input
                          id="new-server-name"
                          value={newServerName}
                          onChange={e => setNewServerName(e.target.value)}
                          placeholder="e.g. prod-worker-1"
                          className="h-8 text-xs"
                          onKeyDown={e => {
                            if (e.key === 'Enter') void registerServer()
                          }}
                        />
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        className="h-8 text-xs gap-1.5"
                        disabled={serverRegistering}
                        onClick={() => void registerServer()}
                      >
                        {serverRegistering ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden /> : <Server className="h-3.5 w-3.5" aria-hidden />}
                        Add server
                      </Button>
                    </div>
                  </div>

                  {servers.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-12 text-center bg-card">
                      <Server className="h-8 w-8 text-muted-foreground/30" aria-hidden />
                      <p className="text-sm font-medium text-muted-foreground">No servers yet</p>
                      <p className="text-xs text-muted-foreground/60 max-w-sm">
                        Register a name above, then install the heartbeat on the host. Status updates every few seconds with the rest of the app.
                      </p>
                    </div>
                  ) : (
                    <ul className="space-y-2" role="list">
                      {servers.map(s => (
                        <li
                          key={s.id}
                          className="rounded-lg border border-border/50 bg-card shadow-xs overflow-hidden"
                        >
                          <div className="flex items-center gap-3 px-4 py-3">
                            <div
                              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border ${
                                s.health === 'ok'
                                  ? cs.healthy.surface
                                  : s.health === 'pending'
                                    ? cs.late.surface
                                    : cs.failed.surface
                              }`}
                              aria-hidden
                            >
                              <Server
                                className={`h-4 w-4 ${
                                  s.health === 'ok'
                                    ? cs.healthy.icon
                                    : s.health === 'pending'
                                      ? cs.late.icon
                                      : cs.failed.icon
                                }`}
                              />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-semibold text-foreground">{s.name}</p>
                              <p className="text-[10px] text-muted-foreground mt-0.5">
                                <span className="font-medium text-foreground/80">Status: </span>
                                {s.health === 'ok' ? 'Live' : s.health === 'pending' ? 'Waiting for first ping' : 'Unreachable'}
                                <span className="mx-1.5">·</span>
                                <span className="font-medium text-foreground/80">Last ping: </span>
                                {formatHeartbeatTs(s.last_seen_at ?? undefined)}
                              </p>
                            </div>
                            {confirmDeleteServer === s.id ? (
                              <div className="flex gap-1 shrink-0" role="group" aria-label={`Confirm delete ${s.name}`}>
                                <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteServer(null)} className="h-7 px-2 text-[10px]">
                                  Cancel
                                </Button>
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  onClick={() => void deleteServerRow(s.id, s.name)}
                                  disabled={deletingServerId === s.id}
                                  className="h-7 px-2 text-[10px] gap-1"
                                >
                                  {deletingServerId === s.id ? (
                                    <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden />
                                  ) : (
                                    <Trash2 className="h-3 w-3" aria-hidden />
                                  )}
                                  Delete
                                </Button>
                              </div>
                            ) : (
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Remove server ${s.name}`}
                                disabled={deletingServerId === s.id}
                                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                onClick={() => requestDeleteServer(s.id)}
                              >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                              </Button>
                            )}
                          </div>
                          <div className="border-t border-border/40 bg-muted/15">
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 px-4 py-2 text-left text-[10px] font-semibold text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                              aria-expanded={Boolean(crontabSectionOpen[s.id])}
                              onClick={() => {
                                setCrontabSectionOpen(o => {
                                  const nextOpen = !o[s.id]
                                  if (nextOpen) {
                                    void loadCrontabSnapshots(s.id)
                                  }
                                  return { ...o, [s.id]: nextOpen }
                                })
                              }}
                            >
                              {crontabSectionOpen[s.id] ? (
                                <ChevronUp className="h-3.5 w-3.5 shrink-0" aria-hidden />
                              ) : (
                                <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
                              )}
                              Crontab snapshots
                            </button>
                            {crontabSectionOpen[s.id] && (
                              <div className="space-y-3 px-4 pb-4 pt-0">
                                <div className="flex flex-wrap items-end gap-2">
                                  <div className="space-y-1">
                                    <Label htmlFor={`poll-${s.id}`} className="text-[10px] text-muted-foreground">
                                      Crontab poll interval (seconds)
                                    </Label>
                                    <Input
                                      id={`poll-${s.id}`}
                                      className="h-8 w-28 text-xs"
                                      inputMode="numeric"
                                      value={pollIntervalDraft[s.id] ?? String(s.crontab_poll_interval_seconds ?? 300)}
                                      onChange={e => setPollIntervalDraft(d => ({ ...d, [s.id]: e.target.value }))}
                                    />
                                  </div>
                                  <Button
                                    type="button"
                                    size="sm"
                                    className="h-8 text-[10px]"
                                    disabled={pollSavingId === s.id}
                                    onClick={() => void savePollInterval(s.id)}
                                  >
                                    {pollSavingId === s.id ? (
                                      <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
                                    ) : null}
                                    Save interval
                                  </Button>
                                </div>
                                <p className="text-[9px] text-muted-foreground leading-snug">
                                  Agent should POST to{' '}
                                  <code className="break-all text-[9px]">{crontabSnapshotPostUrl('…token…')}</code> using this server&apos;s heartbeat token.
                                </p>
                                {crontabSnapLoading === s.id ? (
                                  <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground" aria-busy="true">
                                    <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
                                    Loading snapshots…
                                  </div>
                                ) : (crontabSnapshotsByServer[s.id] ?? []).length === 0 ? (
                                  <p className="text-[11px] text-muted-foreground py-2">No snapshots yet. Send a POST from the host to register the first crontab.</p>
                                ) : (
                                  <ul className="space-y-3" role="list">
                                    {(crontabSnapshotsByServer[s.id] ?? []).map(row => (
                                      <li key={row.id} className="rounded-md border border-border/50 bg-card p-3 text-[10px]">
                                        <p className="font-medium text-foreground">
                                          {new Date(row.created_at).toLocaleString()}
                                          {row.user_context ? (
                                            <span className="font-normal text-muted-foreground"> · {row.user_context}</span>
                                          ) : null}
                                        </p>
                                        <p className="text-muted-foreground mt-0.5 break-all">
                                          hash <code className="text-[9px]">{row.content_hash}</code>
                                        </p>
                                        {row.capture_error ? (
                                          <p className="mt-1 text-destructive text-[10px] whitespace-pre-wrap break-words">{row.capture_error}</p>
                                        ) : null}
                                        {row.diff_from_previous ? (
                                          <div className="mt-2">
                                            <p className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Change vs previous</p>
                                            {/(^|\n)[+-] /.test(row.diff_from_previous) ? (
                                              <CrontabDiffView diff={row.diff_from_previous} />
                                            ) : (
                                              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-[var(--cs-bg-sunken)] p-2 font-mono text-xs text-foreground">
                                                {row.diff_from_previous}
                                              </pre>
                                            )}
                                          </div>
                                        ) : null}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {activeTab === 'settings' && (
                <div role="tabpanel" id="panel-settings" aria-labelledby="tab-settings">
                  <div className="sticky top-0 z-10 -mx-5 mb-4 border-b border-border/40 bg-background/95 px-5 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
                    <h1 className="text-base font-semibold tracking-tight text-primary uppercase">Settings</h1>
                    <p className="text-[11px] text-muted-foreground mt-0.5 max-w-lg leading-relaxed">
                      Configure how CronSentinel sends mail: job alerts, test messages, and the Run history email export — plus Slack, webhooks, and SMS.
                    </p>
                  </div>
                  <NotificationSettings />
                  <div className="mt-8">
                    <BillingSettings
                      billing={billing}
                      loading={billing === null && billingError === null && apiOnline === true}
                      loadError={billingError}
                      onRefresh={() => refresh()}
                      onPlanSaved={() => refresh()}
                    />
                  </div>
                  <div className="mt-8">
                    <AlertChannelsSettings />
                  </div>
                  <div className="mt-8">
                    <ApiKeysSettings />
                  </div>
                </div>
              )}

            </div>
          </ScrollArea>
        </div>
      </div>

      {logsModalJobId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--cs-overlay-scrim)] p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby={logsModalTitleId}
          aria-describedby={logsModalDescriptionId}
          onClick={() => { setLogsModalJobId(null); setLogsModalRunId('') }}
        >
          <div
            className="flex w-full max-w-5xl flex-col rounded-xl border border-border bg-card text-card-foreground shadow-[var(--cs-shadow-modal)]"
            style={{ maxHeight: '92vh' }}
            onClick={e => e.stopPropagation()}
          >

            {/* ── Terminal title bar ── */}
            <div className="flex shrink-0 items-center gap-2 rounded-t-xl border-b border-border bg-muted/40 px-4 py-2.5">
              <span className={`h-3 w-3 rounded-full opacity-90 ${cs.failed.dot}`} />
              <span className={`h-3 w-3 rounded-full opacity-90 ${cs.late.dot}`} />
              <span className={`h-3 w-3 rounded-full opacity-90 ${cs.healthy.dot}`} />
              <div className="flex-1 text-center">
                <span id={logsModalTitleId} className="font-mono text-xs text-muted-foreground">
                  {modalJob?.name ?? 'Runs'} — logs
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => { setLogsModalJobId(null); setLogsModalRunId('') }}
                aria-label="Close logs"
                className="h-6 w-6 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>

            {/* ── Sub-header: status + controls ── */}
            <div className="flex shrink-0 items-center justify-between border-b border-border bg-muted/25 px-4 py-2">
              <div className="flex flex-wrap items-center gap-3">
                {selectedModalRun && (
                  <>
                    {selectedModalRun.status.toLowerCase() === 'running' ? (
                      <span className={`flex items-center gap-1.5 text-xs font-semibold ${cs.late.text}`}>
                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> Running…
                      </span>
                    ) : ['success', 'ok', 'completed'].includes(selectedModalRun.status.toLowerCase()) ? (
                      <span className={`flex items-center gap-1.5 text-xs font-semibold ${cs.healthy.text}`}>
                        <Check className="h-3 w-3" aria-hidden="true" />
                        Completed{selectedModalRun.exit_code != null ? ` · exit ${selectedModalRun.exit_code}` : ''}
                      </span>
                    ) : selectedModalRun.status.toLowerCase() === 'timed_out' ? (
                      <span className={`flex items-center gap-1.5 text-xs font-semibold ${cs.late.text}`}>
                        <Timer className="h-3 w-3" aria-hidden="true" />
                        Timed out{selectedModalRun.exit_code != null ? ` · exit ${selectedModalRun.exit_code}` : ''}
                      </span>
                    ) : (
                      <span className={`flex items-center gap-1.5 text-xs font-semibold ${cs.failed.text}`}>
                        <X className="h-3 w-3" aria-hidden="true" />
                        Failed{selectedModalRun.exit_code != null ? ` · exit ${selectedModalRun.exit_code}` : ''}
                      </span>
                    )}
                    <span className="font-mono text-xs text-muted-foreground">
                      {new Date(selectedModalRun.started_at).toLocaleString()}
                      {selectedModalRun.ended_at && ` · ${runDuration(selectedModalRun)}`}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      Size: {formatLogSize(modalLogs.stdout, modalLogs.stderr)}
                    </span>
                    {modalJob && nextRunByJob[modalJob.id] && (
                      <span className={`font-mono text-xs ${cs.healthy.text}`}>
                        Next run: {formatCountdown(nextRunByJob[modalJob.id] as Date)}
                      </span>
                    )}
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
                {runningModalRun && logsModalRunId === runningModalRun.id && (
                  <span className={`flex items-center gap-1 text-xs font-semibold ${cs.healthy.text}`}>
                    <span className={`h-1.5 w-1.5 animate-pulse rounded-full ${cs.healthy.dot}`} aria-hidden="true" />
                    Live
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => refresh(true)}
                  className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <RefreshCw className="h-2.5 w-2.5" aria-hidden="true" /> Refresh
                </Button>
                <button
                  type="button"
                  onClick={() => {
                    const text = `--- JOB: ${selectedModalRun?.job_name} ---\nCommand: ${selectedModalRun?.command ?? ''}\nStatus: ${selectedModalRun?.status}\n\n--- STDOUT ---\n${modalLogs.stdout || '(empty)'}\n\n--- STDERR ---\n${modalLogs.stderr || '(empty)'}`
                    copyToClipboard(text)
                  }}
                  className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="Copy log to clipboard"
                  aria-label="Copy current run logs to clipboard"
                >
                  <Copy className="h-2.5 w-2.5" /> Copy
                </button>
              </div>
            </div>
            <p id={logsModalDescriptionId} className="sr-only">
              Live logs and historical runs for the selected job.
            </p>

            {/* ── Body: run list + terminal ── */}
            <div className="flex min-h-0 flex-1 overflow-hidden">

              {/* Run list sidebar */}
              <div className="flex w-64 shrink-0 flex-col border-r border-border bg-muted/15">
                <p className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Runs ({modalRuns.length})
                </p>
                <div className="flex-1 space-y-1 overflow-y-auto px-2 pb-2">
                  {modalRuns.length === 0 ? (
                    <div className="mt-2 rounded border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
                      No runs yet for this job.
                    </div>
                  ) : (
                    modalRuns.map(r => {
                      const st = r.status.toLowerCase()
                      const isSuccess = ['success', 'ok', 'completed'].includes(st)
                      const isTimedOut = st === 'timed_out'
                      const isFail = st.includes('fail') || st.includes('error')
                      const isActive = logsModalRunId === r.id
                      return (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => { setLogsModalAutoFollow(false); setLogsModalRunId(r.id) }}
                          className={`w-full rounded border px-2.5 py-2 text-left text-xs transition-colors ${
                            isActive
                              ? 'border-primary/50 bg-primary/10'
                              : 'border-transparent hover:bg-muted/50'
                          }`}
                        >
                          <div className="mb-0.5 flex items-center gap-1.5">
                            <span
                              className={`h-1.5 w-1.5 shrink-0 rounded-full ${isSuccess ? cs.healthy.dot : isTimedOut ? cs.late.dot : isFail ? cs.failed.dot : `${cs.late.dot} animate-pulse`}`}
                              aria-hidden="true"
                            />
                            <span className="truncate font-semibold text-foreground">{new Date(r.started_at).toLocaleTimeString()}</span>
                          </div>
                          <p className="pl-3 text-xs text-muted-foreground">
                            {new Date(r.started_at).toLocaleDateString()}
                            {r.exit_code != null ? ` · exit ${r.exit_code}` : ''}
                            {r.ended_at ? ` · ${runDuration(r)}` : ''}
                          </p>
                        </button>
                      )
                    })
                  )}
                </div>
              </div>

              {/* Terminal pane */}
              <div className="flex min-w-0 flex-1 flex-col bg-[var(--cs-bg-sunken)]">
                {modalLogsLoading ? (
                  <div className="text-muted-foreground flex flex-1 items-center justify-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading logs…
                  </div>
                ) : !selectedModalRun ? (
                  <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
                    ← Select a run to view its output
                  </div>
                ) : (
                  <div ref={modalLogRef} className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed text-foreground">
                    {selectedModalRun.failure_fix && (
                      <div className={`mb-3 rounded border px-3 py-2 ${cs.late.surface}`}>
                        <p className="mb-0.5 text-xs font-semibold uppercase tracking-wider opacity-90">Suggested fix</p>
                        <p className="text-sm opacity-95">{selectedModalRun.failure_fix}</p>
                      </div>
                    )}
                    {(modalLogsTrunc.stdout || modalLogsTrunc.stderr) && (
                      <div className={`mb-3 rounded border px-3 py-2 text-xs ${cs.late.surface}`} role="status">
                        Output truncated at 1 MB per stream on ingest.
                        {modalLogsTrunc.stdout && ' stdout'}
                        {modalLogsTrunc.stderr && ' stderr'}
                      </div>
                    )}
                    <div className="mb-3 space-y-0.5 border-b border-border pb-2">
                      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">── job execution ──</p>
                      <p className="text-muted-foreground">
                        <span className="text-primary">job:</span> {selectedModalRun.job_name}
                      </p>
                      <p className="text-muted-foreground">
                        <span className="text-primary">command:</span>{' '}
                        <span className="text-foreground">{selectedModalRun.command ?? '(not available)'}</span>
                      </p>
                      <p className="text-muted-foreground">
                        <span className="text-primary">started:</span> {new Date(selectedModalRun.started_at).toLocaleString()}
                      </p>
                      <p className="text-muted-foreground">
                        <span className="text-primary">status:</span>{' '}
                        <span
                          className={
                            ['success', 'ok', 'completed'].includes(selectedModalRun.status.toLowerCase())
                              ? cs.healthy.text
                              : selectedModalRun.status.toLowerCase() === 'running'
                                ? cs.late.text
                                : selectedModalRun.status.toLowerCase() === 'timed_out'
                                  ? cs.late.text
                                  : cs.failed.text
                          }
                        >
                          {selectedModalRun.status}
                          {selectedModalRun.exit_code != null ? ` (exit ${selectedModalRun.exit_code})` : ''}
                        </span>
                      </p>
                    </div>
                    <div className="mt-2">
                      <div className="mb-1 flex items-center gap-1.5">
                        <span className={`h-1.5 w-1.5 rounded-full ${cs.healthy.dot}`} aria-hidden="true" />
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">stdout</span>
                      </div>
                      <LogHighlighter text={modalLogs.stdout || '(empty)'} variant="stdout" dense={false} />
                    </div>
                    <div className="mt-3">
                      <div className="mb-1 flex items-center gap-1.5">
                        <span className={`h-1.5 w-1.5 rounded-full ${cs.failed.dot}`} aria-hidden="true" />
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">stderr</span>
                      </div>
                      <LogHighlighter text={modalLogs.stderr || '(empty)'} variant="stderr" dense={false} />
                    </div>
                    {runningModalRun && logsModalRunId === runningModalRun.id && (
                      <div className={`mt-2 flex items-center gap-1.5 text-xs ${cs.healthy.text}`}>
                        <span className={`h-2 w-2 animate-pulse rounded-full ${cs.healthy.dot}`} aria-hidden="true" />
                        Waiting for output…
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* ── Footer ── */}
            <div className="flex shrink-0 items-center justify-between rounded-b-xl border-t border-border bg-muted/25 px-4 py-2">
              <span className="font-mono text-xs text-muted-foreground">
                {selectedModalRun ? `run/${selectedModalRun.id.slice(0, 8)}` : 'no run selected'}
                {' · job/'}{logsModalJobId?.slice(0, 8)}
              </span>
              <Button
                variant="outline"
                onClick={() => { setLogsModalJobId(null); setLogsModalRunId('') }}
                className="h-7 px-3 text-xs"
              >
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
