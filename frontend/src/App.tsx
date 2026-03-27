import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity,
  AlertCircle,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Code2,
  Copy,
  Cpu,
  FileCode2,
  HardDrive,
  Info,
  Loader2,
  Monitor,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Terminal,
  Trash2,
  WifiOff,
  X,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import cronstrue from 'cronstrue'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

const API = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080'

// ─── Types ──────────────────────────────────────────────────────────────────

type SystemMemory = { total: number; used: number; usedPercent: number }
type SystemLoad   = { load1: number; load5: number; load15: number }
type SystemDisk   = { path: string; used_percent: number }
type SystemInfo   = {
  uptime_seconds?: number
  cpu_count?: number
  memory?: SystemMemory
  load?: SystemLoad
  disks?: SystemDisk[]
}

type Script = { name: string; content: string; created_at: string }
type Job = {
  id: string; name: string; schedule: string
  command: string; working_directory?: string; venv_path?: string; comment: string
  logging_enabled: boolean; timeout_seconds: number
}
type Run = {
  id: string; job_id?: string; job_name: string
  command?: string
  status: string; exit_code?: number
  started_at: string; ended_at?: string
  failure_reason: string; failure_fix: string
}
type Preset = { label: string; schedule: string }
type Tab = 'jobs' | 'scripts' | 'runs'
type ScheduleMode = 'cron' | 'human' | 'both'

// ─── API helper ─────────────────────────────────────────────────────────────

async function apiFetch<T = unknown>(url: string, opts?: RequestInit): Promise<T> {
  let res: Response
  try { res = await fetch(url, opts) } catch {
    throw new Error('Cannot reach the server — check your connection')
  }
  if (!res.ok) {
    let msg = `Server error (${res.status})`
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) msg = body.error
    } catch { /* keep generic message */ }
    throw new Error(msg)
  }
  const text = await res.text()
  return (text ? JSON.parse(text) : null) as T
}

// ─── Validators ─────────────────────────────────────────────────────────────

const SCRIPT_NAME_RE = /^[a-zA-Z0-9._-]+$/
const CRON_RE = /^(\S+\s+){4}\S+$/

function validateScriptName(n: string) {
  if (!n.trim()) return 'Script name is required'
  if (!SCRIPT_NAME_RE.test(n.trim())) return 'Only letters, digits, dots, hyphens, underscores'
  return ''
}
function validateCron(s: string) {
  if (!s.trim()) return 'Schedule is required'
  if (!CRON_RE.test(s.trim())) return '5 space-separated cron fields required'
  return ''
}
function validateJobName(n: string) { return n.trim() ? '' : 'Job name is required' }
function validateCommand(c: string) { return c.trim() ? '' : 'Command is required' }

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

function formatLogSize(stdout: string, stderr: string) {
  const bytes = new TextEncoder().encode(`${stdout}${stderr}`).length
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`
  return `${bytes} B`
}

// ─── Pure sub-components ─────────────────────────────────────────────────────

function ProgressBar({ pct, warn = 70, danger = 90 }: { pct: number; warn?: number; danger?: number }) {
  const color = pct >= danger ? 'bg-red-400' : pct >= warn ? 'bg-amber-400' : 'bg-emerald-400'
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
          ['success', 'ok', 'completed'].includes(s) ? 'bg-emerald-400' :
          s.includes('fail') || s.includes('error') ? 'bg-red-400' : 'bg-amber-400'
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
  if (['success', 'ok', 'completed'].includes(s))
    return <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-50 gap-1 text-[10px]"><Check className="h-2.5 w-2.5" />{status}</Badge>
  if (s.includes('fail') || s.includes('error'))
    return <Badge variant="destructive" className="gap-1 text-[10px]"><X className="h-2.5 w-2.5" />{status}</Badge>
  if (['running', 'pending', 'started'].includes(s))
    return <Badge className="bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-50 gap-1 text-[10px]"><Loader2 className="h-2.5 w-2.5 motion-safe:animate-spin" />{status}</Badge>
  return <Badge variant="secondary" className="text-[10px]">{status}</Badge>
}

function FieldError({ msg, id }: { msg: string; id: string }) {
  if (!msg) return null
  return (
    <p id={id} role="alert" className="flex items-center gap-1 text-[11px] text-destructive mt-1">
      <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />{msg}
    </p>
  )
}

// ─── Cron Patterns ───────────────────────────────────────────────────────────

const CRON_PATTERNS = [
  {
    category: 'Common Intervals',
    patterns: [
      { label: 'Every minute',    value: '* * * * *',    desc: 'Runs every minute' },
      { label: 'Every 5 min',     value: '*/5 * * * *',  desc: 'Runs every 5 minutes' },
      { label: 'Every 15 min',    value: '*/15 * * * *', desc: 'Runs every 15 minutes' },
      { label: 'Every 30 min',    value: '*/30 * * * *', desc: 'Runs every 30 minutes' },
      { label: 'Every hour',      value: '0 * * * *',    desc: 'At the start of every hour' },
      { label: 'Every 2 hours',   value: '0 */2 * * *',  desc: 'Runs every 2 hours' },
      { label: 'Every 6 hours',   value: '0 */6 * * *',  desc: 'Runs every 6 hours' },
      { label: 'Every 12 hours',  value: '0 */12 * * *', desc: 'Runs every 12 hours' },
    ],
  },
  {
    category: 'Daily Schedules',
    patterns: [
      { label: 'Daily midnight',  value: '0 0 * * *',    desc: 'Every day at 12:00 AM' },
      { label: 'Daily 6 AM',      value: '0 6 * * *',    desc: 'Every day at 6:00 AM' },
      { label: 'Daily 9 AM',      value: '0 9 * * *',    desc: 'Every day at 9:00 AM' },
      { label: 'Daily noon',      value: '0 12 * * *',   desc: 'Every day at 12:00 PM' },
      { label: 'Daily 6 PM',      value: '0 18 * * *',   desc: 'Every day at 6:00 PM' },
      { label: 'Daily 11 PM',     value: '0 23 * * *',   desc: 'Every day at 11:00 PM' },
    ],
  },
  {
    category: 'Weekly',
    patterns: [
      { label: 'Mon–Fri 9 AM',    value: '0 9 * * 1-5',  desc: 'Weekdays at 9:00 AM' },
      { label: 'Every Monday',    value: '0 9 * * 1',    desc: 'Mondays at 9:00 AM' },
      { label: 'Every Sunday',    value: '0 0 * * 0',    desc: 'Sundays at midnight' },
      { label: 'Weekends noon',   value: '0 12 * * 6,0', desc: 'Sat & Sun at noon' },
    ],
  },
  {
    category: 'Monthly',
    patterns: [
      { label: '1st of month',    value: '0 0 1 * *',    desc: 'First day of every month' },
      { label: '15th of month',   value: '0 0 15 * *',   desc: '15th of every month' },
      { label: 'Last day (approx)',value: '0 0 28-31 * *',desc: 'Around end of month' },
    ],
  },
]

// ─── CronExpressionHelper ────────────────────────────────────────────────────

function CronExpressionHelper({
  value,
  onChange,
  errors,
  id,
  presets,
}: {
  value: string
  onChange: (v: string) => void
  errors?: string
  id: string
  presets?: { label: string; schedule: string }[]
}) {
  const [showPatterns, setShowPatterns] = useState(false)
  const [patternSearch, setPatternSearch] = useState('')

  const explanation = (() => {
    try {
      if (!value.trim()) return null
      const parts = value.trim().split(/\s+/)
      if (parts.length !== 5) return { ok: false, text: '5 fields required (min hr dom mon dow)' }
      const text = cronstrue.toString(value.trim(), { throwExceptionOnParseError: true, verbose: true })
      return { ok: true, text }
    } catch (e) {
      return { ok: false, text: e instanceof Error ? e.message : 'Invalid expression' }
    }
  })()

  const filteredPatterns = CRON_PATTERNS.map(cat => ({
    ...cat,
    patterns: cat.patterns.filter(p =>
      !patternSearch ||
      p.label.toLowerCase().includes(patternSearch.toLowerCase()) ||
      p.desc.toLowerCase().includes(patternSearch.toLowerCase()) ||
      p.value.includes(patternSearch)
    ),
  })).filter(cat => cat.patterns.length > 0)

  return (
    <div className="space-y-1">
      <div className="flex gap-1.5">
        <div className="relative flex-1">
          <input
            id={id}
            type="text"
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder="*/5 * * * *"
            aria-invalid={!!errors}
            aria-describedby={errors ? `${id}-error` : undefined}
            className={`h-8 w-full rounded-md border font-mono text-xs px-2.5 focus:outline-none focus:ring-1 focus:ring-primary ${errors ? 'border-destructive' : 'border-border/60'}`}
          />
          <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
            {explanation?.ok
              ? <Check className="h-3 w-3 text-emerald-500" />
              : value.trim()
                ? <AlertCircle className="h-3 w-3 text-destructive" />
                : <Clock className="h-3 w-3 text-muted-foreground" />}
          </div>
        </div>
        {presets && presets.length > 0 && (
          <Select onValueChange={v => onChange(v)}>
            <SelectTrigger className="h-8 w-28 text-xs"><SelectValue placeholder="Preset" /></SelectTrigger>
            <SelectContent>{presets.map(p => <SelectItem key={p.schedule} value={p.schedule} className="text-xs">{p.label}</SelectItem>)}</SelectContent>
          </Select>
        )}
      </div>

      {/* Human-readable explanation */}
      {explanation && (
        <div className={`flex items-start gap-1.5 rounded px-2.5 py-1.5 text-[11px] ${explanation.ok ? 'bg-emerald-50 border border-emerald-200 text-emerald-800' : 'bg-red-50 border border-red-200 text-red-700'}`}>
          <Info className="h-3 w-3 shrink-0 mt-0.5" aria-hidden="true" />
          <span className="italic">{explanation.text}</span>
        </div>
      )}

      {/* Quick patterns panel */}
      <div className="rounded border border-border/50 overflow-hidden">
        <button
          type="button"
          onClick={() => setShowPatterns(v => !v)}
          className="w-full flex items-center justify-between px-2.5 py-1.5 text-[11px] font-semibold text-muted-foreground hover:bg-muted/30 transition-colors"
        >
          <span className="flex items-center gap-1.5"><CalendarClock className="h-3 w-3" aria-hidden="true" />Quick Patterns</span>
          {showPatterns ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>
        {showPatterns && (
          <div className="border-t border-border/40 bg-white p-2 space-y-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
              <input
                type="search"
                placeholder="Search patterns…"
                value={patternSearch}
                onChange={e => setPatternSearch(e.target.value)}
                className="h-7 w-full rounded border border-border/50 pl-6 pr-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
              {filteredPatterns.map(cat => (
                <div key={cat.category}>
                  <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground mb-1">{cat.category}</p>
                  <div className="grid grid-cols-2 gap-1">
                    {cat.patterns.map(p => (
                      <button
                        key={p.value}
                        type="button"
                        onClick={() => { onChange(p.value); setShowPatterns(false) }}
                        className="text-left rounded border border-border/50 px-2 py-1.5 hover:border-primary/40 hover:bg-primary/5 transition-colors"
                      >
                        <p className="font-mono text-[10px] text-primary">{p.value}</p>
                        <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{p.desc}</p>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {filteredPatterns.length === 0 && (
                <p className="text-center text-[11px] text-muted-foreground py-3">No patterns found for "{patternSearch}"</p>
              )}
            </div>
          </div>
        )}
      </div>

      {errors && <FieldError msg={errors} id={`${id}-error`} />}
    </div>
  )
}

// ─── Main App ────────────────────────────────────────────────────────────────

export default function App() {
  // ── Data state ────────────────────────────────────────────────────────────
  const [scripts, setScripts]   = useState<Script[]>([])
  const [jobs, setJobs]         = useState<Job[]>([])
  const [runs, setRuns]         = useState<Run[]>([])
  const [system, setSystem]     = useState<SystemInfo>({})
  const [presets, setPresets]   = useState<Preset[]>([])

  // ── Connectivity ──────────────────────────────────────────────────────────
  const [apiOnline, setApiOnline]   = useState<boolean | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // ── UI state ──────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab]         = useState<Tab>('jobs')
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
  const [runsFilter, setRunsFilter]       = useState<'all' | 'running' | 'success' | 'failed'>('all')
  const [showJobForm, setShowJobForm]     = useState(false)
  const [showScriptForm, setShowScriptForm] = useState(false)
  const [selectedRun, setSelectedRun]     = useState<string>('')
  const [logsLoading, setLogsLoading]     = useState(false)
  const [logs, setLogs]                   = useState({ stdout: '', stderr: '' })
  const [logsModalJobId, setLogsModalJobId] = useState<string | null>(null)
  const [logsModalRunId, setLogsModalRunId] = useState('')
  const [modalLogsLoading, setModalLogsLoading] = useState(false)
  const [modalLogs, setModalLogs] = useState({ stdout: '', stderr: '' })
  const [logsModalAutoFollow, setLogsModalAutoFollow] = useState(false)

  // ── Per-action loading ────────────────────────────────────────────────────
  const [scriptSaving, setScriptSaving]     = useState(false)
  const [jobSaving, setJobSaving]           = useState(false)
  const [deletingScript, setDeletingScript] = useState<string | null>(null)
  const [deletingJob, setDeletingJob]       = useState<string | null>(null)
  const [runningJob, setRunningJob]         = useState<string | null>(null)

  // ── Edit job ──────────────────────────────────────────────────────────────
  const [editingJobId, setEditingJobId]   = useState<string | null>(null)
  const [editJob, setEditJob]             = useState({ name: '', schedule: '', command: '', working_directory: '', venv_path: '', comment: '', logging_enabled: true, timeout_seconds: 300 })
  const [editJobErrors, setEditJobErrors] = useState({ name: '', schedule: '', command: '' })
  const [editJobSaving, setEditJobSaving] = useState(false)

  // ── Delete confirmation ───────────────────────────────────────────────────
  const [confirmDeleteScript, setConfirmDeleteScript] = useState<string | null>(null)
  const [confirmDeleteJob, setConfirmDeleteJob]       = useState<string | null>(null)

  // ── Form state ────────────────────────────────────────────────────────────
  const [newScript, setNewScript] = useState({ name: '', content: 'echo "hello from script"' })
  const [newJob, setNewJob]       = useState({
    name: '', schedule: '*/5 * * * *', command: 'echo "cron test"',
    working_directory: '', venv_path: '', comment: '', logging_enabled: true, timeout_seconds: 300,
  })
  const [scriptErrors, setScriptErrors] = useState({ name: '' })
  const [jobErrors, setJobErrors]       = useState({ name: '', schedule: '', command: '' })

  // ── Refresh ───────────────────────────────────────────────────────────────
  const refresh = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true)
    try {
      const [sc, jb, ru, sy, pr] = await Promise.all([
        apiFetch<Script[]>(`${API}/api/scripts`),
        apiFetch<Job[]>(`${API}/api/jobs`),
        apiFetch<Run[]>(`${API}/api/runs`),
        apiFetch<SystemInfo>(`${API}/api/system`),
        apiFetch<Preset[]>(`${API}/api/jobs/presets`),
      ])
      setScripts(sc ?? []); setJobs(jb ?? []); setRuns(ru ?? [])
      setSystem(sy ?? {}); setPresets(pr ?? [])
      setApiOnline(true)
    } catch (err) {
      setApiOnline(false)
      if (showSpinner) toast.error('Refresh failed', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally { if (showSpinner) setRefreshing(false) }
  }, [])

  useEffect(() => { refresh(); const t = setInterval(() => refresh(), 5000); return () => clearInterval(t) }, [refresh])

  useEffect(() => { try { localStorage.setItem('cronsentinel-minimal-mode', String(minimalMode)) } catch { /* */ } }, [minimalMode])
  useEffect(() => { try { localStorage.setItem('cronsentinel-schedule-mode', scheduleMode) } catch { /* */ } }, [scheduleMode])

  // ── Log streaming ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedRun) return
    setLogsLoading(true)
    setLogs({ stdout: '', stderr: '' })
    let cancelled = false

    const ev = new EventSource(`${API}/api/runs/${selectedRun}/stream`)
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

    apiFetch<{ stdout: string; stderr: string }>(`${API}/api/runs/${selectedRun}/logs`)
      .then(d => {
        if (cancelled) return
        if (!streamReceived) setLogs(d ?? { stdout: '', stderr: '' })
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
    let cancelled = false

    // Open the SSE stream FIRST so we never miss live lines due to the race
    // between job execution and the initial /logs fetch completing.
    // The backend will immediately replay the final state if the run already finished.
    const ev = new EventSource(`${API}/api/runs/${logsModalRunId}/stream`)
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
    apiFetch<{ stdout: string; stderr: string }>(`${API}/api/runs/${logsModalRunId}/logs`)
      .then(d => {
        if (cancelled) return
        // Only use REST snapshot if SSE hasn't delivered a full payload yet
        if (!streamReceived) {
          setModalLogs(d ?? { stdout: '', stderr: '' })
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
  const successCount    = runs.filter(r => ['success', 'ok', 'completed'].includes(r.status.toLowerCase())).length
  const failedCount     = runs.filter(r => r.status.toLowerCase().includes('fail') || r.status.toLowerCase().includes('error')).length
  const selectedRunData = runs.find(r => r.id === selectedRun) ?? null
  const modalRuns = logsModalJobId ? runs.filter(r => r.job_id === logsModalJobId) : []
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

  // ── Actions ───────────────────────────────────────────────────────────────
  const saveScript = async () => {
    const e = validateScriptName(newScript.name)
    if (e) { setScriptErrors({ name: e }); return }
    setScriptErrors({ name: '' }); setScriptSaving(true)
    try {
      await apiFetch(`${API}/api/scripts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newScript) })
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
      await apiFetch(`${API}/api/scripts/${encodeURIComponent(name)}`, { method: 'DELETE' })
      toast.success('Script deleted', { description: name }); refresh()
    } catch (err) { toast.error('Failed to delete script', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally { setDeletingScript(null) }
  }

  const saveJob = async () => {
    const ne = validateJobName(newJob.name), se = validateCron(newJob.schedule), ce = validateCommand(newJob.command)
    if (ne || se || ce) { setJobErrors({ name: ne, schedule: se, command: ce }); return }
    setJobErrors({ name: '', schedule: '', command: '' }); setJobSaving(true)
    try {
      await apiFetch(`${API}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newJob) })
      toast.success('Job created', { description: newJob.name })
      setNewJob({ name: '', schedule: '*/5 * * * *', command: 'echo "cron test"', working_directory: '', venv_path: '', comment: '', logging_enabled: true, timeout_seconds: 300 })
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
      await apiFetch(`${API}/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' })
      toast.success('Job deleted', { description: name }); refresh()
    } catch (err) { toast.error('Failed to delete job', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally { setDeletingJob(null) }
  }

  const startEditJob = (j: Job) => {
    setEditingJobId(j.id)
    setEditJob({ name: j.name, schedule: j.schedule, command: j.command, working_directory: j.working_directory ?? '', venv_path: j.venv_path ?? '', comment: j.comment, logging_enabled: j.logging_enabled, timeout_seconds: j.timeout_seconds })
    setEditJobErrors({ name: '', schedule: '', command: '' })
  }

  const saveEditJob = async () => {
    const ne = validateJobName(editJob.name), se = validateCron(editJob.schedule), ce = validateCommand(editJob.command)
    if (ne || se || ce) { setEditJobErrors({ name: ne, schedule: se, command: ce }); return }
    setEditJobErrors({ name: '', schedule: '', command: '' }); setEditJobSaving(true)
    try {
      await apiFetch(`${API}/api/jobs/${encodeURIComponent(editingJobId!)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(editJob) })
      toast.success('Job updated'); setEditingJobId(null); refresh()
    } catch (err) { toast.error('Failed to update job', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally { setEditJobSaving(false) }
  }

  const runJob = async (id: string, name: string) => {
    setRunningJob(id)
    try {
      const resp = await apiFetch<{ run_id?: string }>(`${API}/api/jobs/${encodeURIComponent(id)}/run`, { method: 'POST' })
      toast.success('Job started', { description: name })
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
      command: j.command,
      working_directory: j.working_directory ?? '',
      venv_path: j.venv_path ?? '',
      comment: j.comment,
      logging_enabled: j.logging_enabled,
      timeout_seconds: j.timeout_seconds,
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
    const latestRun = runs.find(r => r.job_id === jobId)
    setLogsModalJobId(jobId)
    setLogsModalRunId(latestRun?.id ?? '')
    setLogsModalAutoFollow(false)
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

  // Escape closes logs modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && logsModalJobId) {
        setLogsModalJobId(null)
        setLogsModalRunId('')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [logsModalJobId])

  const memPct = system.memory?.usedPercent ?? 0

  // ══════════════════════════════════════════════════════════════════════════
  return (
    <div className="h-screen overflow-hidden flex flex-col bg-[#f5f5f2] text-foreground">

      {/* ── Offline banner ── */}
      {apiOnline === false && (
        <div role="alert" aria-live="assertive" className="flex items-center justify-center gap-2 bg-destructive/10 border-b border-destructive/20 px-4 py-1.5 text-destructive text-xs font-medium shrink-0">
          <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />
          Cannot reach the backend — retrying automatically…
        </div>
      )}

      {/* ── Top header ─────────────────────────────────────────────────────── */}
      <header className="shrink-0 border-b border-border/50 bg-white flex items-center h-12 px-5 gap-4">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-violet-500 to-indigo-600" aria-hidden="true">
            <Zap className="h-4 w-4 text-white" />
          </div>
          <div className="leading-none">
            <p className="text-[13px] font-bold tracking-tight">
              Cron<span className="text-primary">Sentinel</span>
            </p>
          </div>
        </div>

        <div className="flex-1" />

        {runningJobsCount > 0 && (
          <span className="flex items-center gap-1.5 rounded-full bg-amber-100 border border-amber-300 px-2.5 py-1 text-[11px] font-semibold text-amber-700">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            {runningJobsCount} job{runningJobsCount > 1 ? 's' : ''} running
          </span>
        )}
        {apiOnline === true ? (
          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-600">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 motion-safe:animate-pulse" aria-hidden="true" />
            Live
          </span>
        ) : apiOnline === false ? (
          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-red-500">
            <WifiOff className="h-3 w-3" aria-hidden="true" /> Offline
          </span>
        ) : null}

        <span className="text-[10px] text-muted-foreground/50 hidden sm:block" title="Data auto-refreshes every 5 seconds">
          auto-refresh 5s
        </span>
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
      </header>

      {/* ── Body (sidebar + main) ─────────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden">

        {/* ── Left sidebar ───────────────────────────────────────────────── */}
        {sidebarOpen && (
          <aside className="w-52 shrink-0 border-r border-border/40 bg-[#efefe9] flex flex-col overflow-y-auto">

            {/* System status */}
            <div className="px-4 pt-4 pb-3 border-b border-border/40">
              <div className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${apiOnline === true ? 'bg-emerald-500 motion-safe:animate-pulse' : 'bg-red-400'}`} aria-hidden="true" />
                <span className="text-[11px] font-semibold">
                  {apiOnline === true ? 'System Status: Optimal' : apiOnline === false ? 'Backend Offline' : 'Connecting…'}
                </span>
              </div>
              {apiOnline === true && (
                <p className="text-[10px] text-muted-foreground mt-0.5 pl-4.5">All systems running normally</p>
              )}
              <p className="text-[10px] text-muted-foreground/60 mt-0.5 pl-4.5">Last updated: {now}</p>
            </div>

            {/* System information */}
            <div className="px-3 pt-3 pb-2">
              <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground mb-2">System Information</p>
              <div className="space-y-1.5">
                <div className="rounded border border-border/40 bg-white/60 px-2.5 py-2">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <Clock className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                    <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">Uptime</span>
                  </div>
                  <p className="text-[11px] font-semibold text-foreground">
                    {system.uptime_seconds != null ? formatUptime(system.uptime_seconds) : '—'}
                  </p>
                </div>
              </div>
            </div>

            {/* Performance metrics */}
            <div className="px-3 pb-4 flex-1">
              <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Performance Metrics</p>
              <div className="space-y-2">

                {/* Memory */}
                <div className="rounded border border-border/40 bg-white/60 px-2.5 py-2 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <Monitor className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                      <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">Memory</span>
                    </div>
                    {system.memory && (
                      <span className="text-[9px] text-muted-foreground">{memPct.toFixed(0)}%</span>
                    )}
                  </div>
                  {system.memory ? (
                    <>
                      <p className="text-[11px] font-semibold">{formatBytes(system.memory.used)} / {formatBytes(system.memory.total)}</p>
                      <p className="text-[10px] text-emerald-600 font-medium">{formatBytes(system.memory.total - system.memory.used)} free</p>
                      <ProgressBar pct={memPct} />
                    </>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">—</p>
                  )}
                </div>

                {/* CPU */}
                <div className="rounded border border-border/40 bg-white/60 px-2.5 py-2 space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <Cpu className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                    <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">CPU</span>
                  </div>
                  <p className="text-[11px] font-semibold">{system.cpu_count ?? '—'} core{system.cpu_count !== 1 ? 's' : ''}</p>
                  {system.load && (
                    <>
                      <p className="text-[10px] text-muted-foreground">Load: {system.load.load1.toFixed(2)}</p>
                      <ProgressBar pct={Math.min(100, system.load.load1 * 25)} />
                    </>
                  )}
                </div>

                {/* Disk */}
                {system.disks && system.disks.length > 0 && (
                  <div className="rounded border border-border/40 bg-white/60 px-2.5 py-2 space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <HardDrive className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                      <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">Disk</span>
                    </div>
                    {system.disks.slice(0, 2).map(d => (
                      <div key={d.path} className="space-y-1">
                        <div className="flex justify-between">
                          <p className="text-[10px] font-medium">{d.path}</p>
                          <p className="text-[10px] text-muted-foreground">{d.used_percent.toFixed(0)}%</p>
                        </div>
                        <ProgressBar pct={d.used_percent} />
                      </div>
                    ))}
                  </div>
                )}

                {/* Load averages */}
                {system.load && (
                  <div className="rounded border border-border/40 bg-white/60 px-2.5 py-2">
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <Activity className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                      <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">Load Average</span>
                    </div>
                    <div className="grid grid-cols-3 gap-1 text-center">
                      {[['1m', system.load.load1], ['5m', system.load.load5], ['15m', system.load.load15]].map(([label, val]) => (
                        <div key={label as string} className="rounded bg-muted/50 px-1 py-1">
                          <p className="text-[8px] text-muted-foreground uppercase">{label as string}</p>
                          <p className="text-[10px] font-semibold">{(val as number).toFixed(2)}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Disk not available yet */}
                {system.cpu_count == null && (
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
          className="shrink-0 w-4 border-r border-border/40 bg-[#eaeae4] hover:bg-[#e0e0d8] flex items-center justify-center text-muted-foreground/60 hover:text-muted-foreground transition-colors"
        >
          {sidebarOpen ? <ChevronLeft className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>

        {/* ── Main content area ─────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden bg-[#f5f5f2]">

          {/* Tab bar */}
          <div className="shrink-0 border-b border-border/50 bg-white px-4 flex items-center gap-0 h-11">
            {([
              ['jobs',    <Clock    key="c" className="h-3.5 w-3.5" />, 'Cron Jobs',    jobs.length],
              ['scripts', <FileCode2 key="f" className="h-3.5 w-3.5" />, 'Scripts',     scripts.length],
              ['runs',    <Activity key="a" className="h-3.5 w-3.5" />, 'Run History', runs.length],
            ] as [Tab, React.ReactNode, string, number][]).map(([id, icon, label, count]) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`flex items-center gap-1.5 px-4 h-full border-b-2 text-xs font-semibold transition-colors ${
                  activeTab === id
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
                }`}
                aria-selected={activeTab === id}
              >
                {icon}
                {label}
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                  activeTab === id ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                }`}>
                  {count}
                </span>
              </button>
            ))}
          </div>

          {/* Tab content */}
          <ScrollArea className="flex-1">
            <div className="p-5">

              {/* ══════════════════════════════════════════════════════════ */}
              {/* JOBS TAB                                                  */}
              {/* ══════════════════════════════════════════════════════════ */}
              {activeTab === 'jobs' && (
                <div>
                  {/* Section header */}
                  <div className="flex items-center gap-3 mb-3 flex-wrap">
                    <div>
                      <h1 className="text-[15px] font-bold tracking-tight text-amber-500 uppercase">Scheduled Tasks</h1>
                      <p className="text-[11px] text-muted-foreground">
                        {filteredJobs.length}{jobSearch ? ` of ${jobs.length}` : ''} scheduled task{jobs.length !== 1 ? 's' : ''}
                        {successCount > 0 && <span className="text-emerald-600 ml-1.5">· {successCount} ok</span>}
                        {failedCount > 0 && <span className="text-red-500 ml-1">· {failedCount} failed</span>}
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
                        className="h-8 rounded-md border border-border/60 bg-white pl-7 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary w-36"
                        aria-label="Search jobs"
                      />
                    </div>
                    {/* Schedule mode */}
                    <div className="flex rounded-md border border-border/60 overflow-hidden text-[10px] font-semibold">
                      {(['cron', 'human', 'both'] as ScheduleMode[]).map(m => (
                        <button
                          key={m}
                          onClick={() => setScheduleMode(m)}
                          className={`px-2 py-1 capitalize transition-colors ${scheduleMode === m ? 'bg-primary text-white' : 'bg-white text-muted-foreground hover:bg-muted/40'}`}
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
                        className={`h-4 w-4 rounded border flex items-center justify-center cursor-pointer ${minimalMode ? 'bg-primary border-primary' : 'border-border bg-white'}`}
                      >
                        {minimalMode && <Check className="h-2.5 w-2.5 text-white" />}
                      </div>
                      Minimal
                    </label>
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
                    <div className="mb-4 rounded-lg border border-primary/20 bg-white p-4 shadow-sm" role="region" aria-label="Add new cron job">
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
                        {/* Row 4: Working dir + venv */}
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
                        {/* Row 4b: Timeout */}
                        <div className="space-y-1">
                          <Label htmlFor="job-timeout" className="text-xs text-muted-foreground">
                            Timeout <span className="opacity-50">(seconds — job is killed after this)</span>
                          </Label>
                          <Input id="job-timeout" type="number" min={1} max={86400}
                            value={newJob.timeout_seconds}
                            onChange={e => setNewJob(j => ({ ...j, timeout_seconds: Math.max(1, parseInt(e.target.value) || 300) }))}
                            className="h-8 text-xs w-36" />
                        </div>
                        {/* Row 5: Logging toggle + submit */}
                        <div className="flex items-center justify-between pt-1">
                          <label className="flex items-center gap-2 cursor-pointer select-none">
                            <div
                              role="checkbox"
                              aria-checked={newJob.logging_enabled}
                              tabIndex={0}
                              onClick={() => setNewJob(j => ({ ...j, logging_enabled: !j.logging_enabled }))}
                              onKeyDown={e => e.key === ' ' && setNewJob(j => ({ ...j, logging_enabled: !j.logging_enabled }))}
                              className={`relative h-5 w-9 rounded-full transition-colors cursor-pointer ${newJob.logging_enabled ? 'bg-violet-500' : 'bg-muted'}`}
                            >
                              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${newJob.logging_enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                            </div>
                            <div>
                              <span className="text-xs font-medium text-foreground">Enable logging</span>
                              <p className="text-[10px] text-muted-foreground">Capture stdout/stderr for each run</p>
                            </div>
                          </label>
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
                    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-12 text-center bg-white">
                      <Clock className="h-8 w-8 text-muted-foreground/30" aria-hidden="true" />
                      <p className="text-sm font-medium text-muted-foreground">No jobs scheduled yet</p>
                      <p className="text-xs text-muted-foreground/60">Click "New Task" above to create your first job</p>
                    </div>
                  ) : filteredJobs.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-12 text-center bg-white">
                      <Search className="h-8 w-8 text-muted-foreground/30" aria-hidden="true" />
                      <p className="text-sm font-medium text-muted-foreground">No jobs match "{jobSearch}"</p>
                      <button onClick={() => setJobSearch('')} className="text-xs text-primary hover:underline">Clear search</button>
                    </div>
                  ) : (
                    <ul className="space-y-2" role="list">
                      {filteredJobs.map(j => (
                        <li key={j.id} className="rounded-lg border border-border/50 bg-white shadow-xs overflow-hidden">
                          {/* ── Inline edit form ── */}
                          {editingJobId === j.id ? (
                            <div className="px-4 py-3 space-y-3" role="region" aria-label={`Edit job ${j.name}`}>
                              <div className="flex items-center justify-between">
                                <p className="text-xs font-semibold text-foreground">Edit Job</p>
                                <button onClick={() => setEditingJobId(null)} aria-label="Cancel edit" className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
                              </div>
                              <div className="space-y-3">
                                {/* Row 1: Name + Comment */}
                                <div className="grid grid-cols-2 gap-3">
                                  <div className="space-y-1">
                                    <Label htmlFor={`edit-name-${j.id}`} className="text-xs text-muted-foreground">Job name</Label>
                                    <Input id={`edit-name-${j.id}`} value={editJob.name}
                                      onChange={e => { setEditJob(v => ({ ...v, name: e.target.value })); if (editJobErrors.name) setEditJobErrors(p => ({ ...p, name: '' })) }}
                                      aria-invalid={!!editJobErrors.name} className="h-8 text-xs" />
                                    <FieldError msg={editJobErrors.name} id={`edit-name-err-${j.id}`} />
                                  </div>
                                  <div className="space-y-1">
                                    <Label htmlFor={`edit-comment-${j.id}`} className="text-xs text-muted-foreground">Comment <span className="opacity-50">(optional)</span></Label>
                                    <Input id={`edit-comment-${j.id}`} value={editJob.comment}
                                      onChange={e => setEditJob(v => ({ ...v, comment: e.target.value }))} className="h-8 text-xs" />
                                  </div>
                                </div>
                                {/* Row 2: Schedule */}
                                <div className="space-y-1">
                                  <Label htmlFor={`edit-sched-${j.id}`} className="text-xs text-muted-foreground">Schedule</Label>
                                  <CronExpressionHelper
                                    id={`edit-sched-${j.id}`}
                                    value={editJob.schedule}
                                    onChange={v => { setEditJob(ev => ({ ...ev, schedule: v })); if (editJobErrors.schedule) setEditJobErrors(p => ({ ...p, schedule: '' })) }}
                                    errors={editJobErrors.schedule}
                                    presets={presets}
                                  />
                                </div>
                                {/* Row 3: Command */}
                                <div className="space-y-1">
                                  <Label htmlFor={`edit-cmd-${j.id}`} className="text-xs text-muted-foreground">Command</Label>
                                  <Textarea id={`edit-cmd-${j.id}`} value={editJob.command}
                                    onChange={e => { setEditJob(v => ({ ...v, command: e.target.value })); if (editJobErrors.command) setEditJobErrors(p => ({ ...p, command: '' })) }}
                                    onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveEditJob() }}
                                    aria-invalid={!!editJobErrors.command} rows={2} className="font-mono text-xs resize-none" />
                                  <FieldError msg={editJobErrors.command} id={`edit-cmd-err-${j.id}`} />
                                </div>
                                {/* Row 4: Working dir + venv */}
                                <div className="grid grid-cols-2 gap-3">
                                  <div className="space-y-1">
                                    <Label htmlFor={`edit-workdir-${j.id}`} className="text-xs text-muted-foreground">Working directory <span className="opacity-50">(optional)</span></Label>
                                    <Input id={`edit-workdir-${j.id}`} value={editJob.working_directory} placeholder="/home/user/myproject"
                                      onChange={e => setEditJob(v => ({ ...v, working_directory: e.target.value }))}
                                      className="h-8 font-mono text-xs" />
                                  </div>
                                  <div className="space-y-1">
                                    <Label htmlFor={`edit-venv-${j.id}`} className="text-xs text-muted-foreground">Python venv <span className="opacity-50">(optional)</span></Label>
                                    <Input id={`edit-venv-${j.id}`} value={editJob.venv_path} placeholder="/home/user/project/.venv"
                                      onChange={e => setEditJob(v => ({ ...v, venv_path: e.target.value }))}
                                      className="h-8 font-mono text-xs" />
                                  </div>
                                </div>
                                {/* Row 4b: Timeout */}
                                <div className="space-y-1">
                                  <Label htmlFor={`edit-timeout-${j.id}`} className="text-xs text-muted-foreground">
                                    Timeout <span className="opacity-50">(seconds)</span>
                                  </Label>
                                  <Input id={`edit-timeout-${j.id}`} type="number" min={1} max={86400}
                                    value={editJob.timeout_seconds}
                                    onChange={e => setEditJob(v => ({ ...v, timeout_seconds: Math.max(1, parseInt(e.target.value) || 300) }))}
                                    className="h-8 text-xs w-36" />
                                </div>
                                {/* Row 5: Logging + actions */}
                                <div className="flex items-center justify-between pt-1">
                                  <label className="flex items-center gap-2 cursor-pointer select-none">
                                    <div
                                      role="checkbox"
                                      aria-checked={editJob.logging_enabled}
                                      tabIndex={0}
                                      onClick={() => setEditJob(v => ({ ...v, logging_enabled: !v.logging_enabled }))}
                                      onKeyDown={e => e.key === ' ' && setEditJob(v => ({ ...v, logging_enabled: !v.logging_enabled }))}
                                      className={`relative h-5 w-9 rounded-full transition-colors cursor-pointer ${editJob.logging_enabled ? 'bg-violet-500' : 'bg-muted'}`}
                                    >
                                      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${editJob.logging_enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                    </div>
                                    <span className="text-xs font-medium text-foreground">Enable logging</span>
                                  </label>
                                  <div className="flex gap-2">
                                    <Button size="sm" variant="outline" onClick={() => setEditingJobId(null)} className="h-8 text-xs">Cancel</Button>
                                    <Button size="sm" onClick={saveEditJob} disabled={editJobSaving} className="h-8 text-xs gap-1.5">
                                      {editJobSaving ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" /> : <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                                      {editJobSaving ? 'Saving…' : 'Save'}
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            </div>
                          ) : (
                          <div className="flex items-center gap-3 px-4 py-3">
                            {/* Run history dots */}
                            <RunDots jobId={j.id} runs={runs} />

                            {/* Job info */}
                            <div className="flex-1 min-w-0">
                              {/* Job name + last status */}
                              <div className="flex items-center gap-2 mb-1.5">
                                <span className="text-[13px] font-semibold text-foreground truncate">{j.name}</span>
                                {runningJob === j.id && (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 border border-amber-300 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                                    <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden="true" /> Starting…
                                  </span>
                                )}
                                {(() => {
                                  const last = runs.find(r => r.job_id === j.id)
                                  if (!last) return null
                                  if (last.status.toLowerCase() === 'running')
                                    return (
                                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 border border-amber-300 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                                        <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" /> Running
                                      </span>
                                    )
                                  return <RunBadge status={last.status} />
                                })()}
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
                                      <span className="inline-flex items-center gap-1 rounded-sm border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                                        <Clock className="h-2.5 w-2.5" aria-hidden="true" />
                                        {cronToHuman(j.schedule)}
                                      </span>
                                    )}
                                    {(scheduleMode === 'cron' || scheduleMode === 'both') && (
                                      <span className="inline-flex items-center gap-1 rounded-sm border border-border/50 bg-muted/50 px-2 py-0.5 text-[10px] font-mono text-muted-foreground">
                                        {j.schedule}
                                      </span>
                                    )}
                                    {j.working_directory && (
                                      <span className="inline-flex items-center gap-1 rounded-sm border border-sky-200 bg-sky-50 px-1.5 py-px text-[10px] font-mono text-sky-700 truncate max-w-[180px]" title={j.working_directory}>
                                        📁 {j.working_directory}
                                      </span>
                                    )}
                                    {j.venv_path && (
                                      <span className="inline-flex items-center gap-1 rounded-sm border border-emerald-200 bg-emerald-50 px-1.5 py-px text-[10px] font-semibold text-emerald-700 truncate max-w-[160px]" title={j.venv_path}>
                                        🐍 venv
                                      </span>
                                    )}
                                    {j.comment && (
                                      <span className="text-[10px] text-muted-foreground italic truncate max-w-[200px]" title={j.comment}>— {j.comment}</span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-[10px] text-muted-foreground/50 font-mono">#{j.id.slice(0, 8)}</span>
                                    {j.timeout_seconds && j.timeout_seconds !== 300 && (
                                      <span className="inline-flex items-center rounded-sm border border-orange-200 bg-orange-50 px-1.5 py-px text-[10px] text-orange-600">
                                        ⏱ {j.timeout_seconds}s timeout
                                      </span>
                                    )}
                                    {j.logging_enabled && (
                                      <span className="inline-flex items-center rounded-sm border border-violet-200 bg-violet-50 px-1.5 py-px text-[10px] font-semibold text-violet-600">Logged</span>
                                    )}
                                    {(() => {
                                      const last = runs.find(r => r.job_id === j.id)
                                      if (!last) return <span className="text-[10px] text-muted-foreground/40">Never run</span>
                                      return (
                                        <span className="text-[10px] text-muted-foreground/60">
                                          Last ran {new Date(last.started_at).toLocaleString()}
                                          {last.ended_at && ` · ${runDuration(last)}`}
                                        </span>
                                      )
                                    })()}
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
                                className="h-7 w-7 text-muted-foreground hover:text-sky-600 hover:bg-sky-50"
                                onClick={() => copyToClipboard(j.command)}
                                title="Copy command"
                              >
                                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Clone job ${j.name}`}
                                className="h-7 w-7 text-muted-foreground hover:text-amber-600 hover:bg-amber-50"
                                onClick={() => cloneJob(j)}
                                title="Clone job"
                              >
                                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`View logs for ${j.name}`}
                                className="h-7 w-7 text-muted-foreground hover:text-violet-600 hover:bg-violet-50"
                                onClick={() => openLogsModal(j.id)}
                              >
                                <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
                              </Button>
                              <Button variant="ghost" size="icon" aria-label={`Edit job ${j.name}`}
                                className="h-7 w-7 text-muted-foreground hover:text-blue-600 hover:bg-blue-50"
                                onClick={() => startEditJob(j)}>
                                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                              </Button>
                              <Button variant="ghost" size="icon" aria-label={`Run ${j.name} now`}
                                disabled={runningJob === j.id}
                                className="h-7 w-7 text-muted-foreground hover:text-emerald-600 hover:bg-emerald-50"
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
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* ══════════════════════════════════════════════════════════ */}
              {/* SCRIPTS TAB                                               */}
              {/* ══════════════════════════════════════════════════════════ */}
              {activeTab === 'scripts' && (
                <div>
                  <div className="flex items-center gap-3 mb-3">
                    <div>
                      <h1 className="text-[15px] font-bold tracking-tight text-amber-500 uppercase">Scripts</h1>
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
                    <div className="mb-4 rounded-lg border border-primary/20 bg-white p-4 shadow-sm" role="region" aria-label="Add new script">
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
                    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-12 text-center bg-white">
                      <FileCode2 className="h-8 w-8 text-muted-foreground/30" aria-hidden="true" />
                      <p className="text-sm font-medium text-muted-foreground">No scripts yet</p>
                      <p className="text-xs text-muted-foreground/60">Click "New Script" to add your first one</p>
                    </div>
                  ) : (
                    <ul className="space-y-2" role="list">
                      {scripts.map(s => (
                        <li key={s.name} className="rounded-lg border border-border/50 bg-white shadow-xs overflow-hidden">
                          <div className="flex items-center gap-3 px-4 py-3">
                            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-amber-50 border border-amber-200 shrink-0" aria-hidden="true">
                              <FileCode2 className="h-4 w-4 text-amber-600" />
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
                <div>
                  <div className="flex items-center gap-3 mb-3 flex-wrap">
                    <div>
                      <h1 className="text-[15px] font-bold tracking-tight text-amber-500 uppercase">Run History</h1>
                      <p className="text-[11px] text-muted-foreground">
                        {successCount} succeeded · {failedCount} failed · {runs.length} total
                      </p>
                    </div>
                    <div className="flex-1" />
                    {/* Status filter */}
                    <div className="flex rounded-md border border-border/60 overflow-hidden text-[10px] font-semibold">
                      {([
                        ['all',     'All',     runs.length],
                        ['running', 'Running', runs.filter(r => r.status.toLowerCase() === 'running').length],
                        ['success', 'Success', successCount],
                        ['failed',  'Failed',  failedCount],
                      ] as ['all'|'running'|'success'|'failed', string, number][]).map(([id, label, count]) => (
                        <button
                          key={id}
                          onClick={() => setRunsFilter(id)}
                          className={`px-2.5 py-1.5 flex items-center gap-1 transition-colors ${runsFilter === id ? 'bg-primary text-white' : 'bg-white text-muted-foreground hover:bg-muted/40'}`}
                        >
                          {label}
                          <span className={`rounded px-1 text-[9px] ${runsFilter === id ? 'bg-white/20' : 'bg-muted'}`}>{count}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {runs.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-12 text-center bg-white">
                      <Activity className="h-8 w-8 text-muted-foreground/30" aria-hidden="true" />
                      <p className="text-sm font-medium text-muted-foreground">No runs recorded yet</p>
                      <p className="text-xs text-muted-foreground/60">Trigger a job to see results here</p>
                    </div>
                  ) : (
                    <ul className="space-y-2" role="list">
                      {runs.filter(r => {
                        const s = r.status.toLowerCase()
                        if (runsFilter === 'running') return s === 'running'
                        if (runsFilter === 'success') return ['success','ok','completed'].includes(s)
                        if (runsFilter === 'failed') return s.includes('fail') || s.includes('error')
                        return true
                      }).slice(0, 50).map(r => (
                        <li key={r.id} className="rounded-lg border border-border/50 bg-white shadow-xs overflow-hidden">
                          {/* Run row — clickable to expand logs */}
                          <button
                            className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${selectedRun === r.id ? 'bg-primary/5' : 'hover:bg-muted/30'}`}
                            onClick={() => setSelectedRun(selectedRun === r.id ? '' : r.id)}
                            aria-expanded={selectedRun === r.id}
                            aria-label={`${r.job_name}, ${r.status}`}
                          >
                            <RunBadge status={r.status} />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <p className="text-xs font-semibold text-foreground">{r.job_name}</p>
                                {r.exit_code != null && (
                                  <span className={`text-[10px] font-mono px-1.5 py-px rounded border ${r.exit_code === 0 ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
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
                              {r.failure_reason && (
                                <p className="flex items-center gap-1 text-[10px] text-destructive mt-0.5">
                                  <AlertCircle className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
                                  {r.failure_reason}
                                </p>
                              )}
                            </div>
                            <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground/50 shrink-0 transition-transform ${selectedRun === r.id ? 'rotate-90' : ''}`} aria-hidden="true" />
                          </button>

                          {/* Expandable log viewer */}
                          {selectedRun === r.id && (
                            <div className="border-t border-border/50 px-4 py-3 bg-[#fafaf8]" aria-label="Run logs">
                              {logsLoading ? (
                                <div className="flex items-center gap-2 py-2 text-muted-foreground" aria-busy="true">
                                  <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />
                                  <span className="text-xs">Loading logs…</span>
                                </div>
                              ) : (
                                <div className="space-y-2">
                                  {selectedRunData?.failure_fix && (
                                    <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2">
                                      <p className="text-[10px] font-semibold text-amber-700 uppercase tracking-wider mb-0.5">Suggested fix</p>
                                      <p className="text-xs text-amber-800">{selectedRunData.failure_fix}</p>
                                    </div>
                                  )}
                                  {['stdout', 'stderr'].map(pipe => (
                                    <div key={pipe}>
                                      <div className="flex items-center gap-1.5 mb-1">
                                        <span className={`h-2 w-2 rounded-full ${pipe === 'stdout' ? 'bg-emerald-500' : 'bg-red-500'}`} aria-hidden="true" />
                                        <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">{pipe}</span>
                                      </div>
                                      <div role="log" aria-live="polite" aria-label={`Standard ${pipe === 'stdout' ? 'output' : 'error'}`}
                                        className="rounded bg-slate-950 px-3 pt-2 pb-3 font-mono text-[11px] leading-relaxed text-slate-300 max-h-40 overflow-auto">
                                        {pipe === 'stdout' && <Terminal className="mb-1.5 h-3 w-3 text-slate-500" aria-hidden="true" />}
                                        <pre className="whitespace-pre-wrap break-words">{(pipe === 'stdout' ? logs.stdout : logs.stderr) || '(empty)'}</pre>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {runs.length > 50 && runsFilter === 'all' && (
                    <p className="mt-3 text-center text-[11px] text-muted-foreground">Showing 50 of {runs.length} runs</p>
                  )}
                </div>
              )}

            </div>
          </ScrollArea>
        </div>
      </div>

      {logsModalJobId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Job logs">
          <div className="w-full max-w-5xl rounded-xl border border-slate-700 bg-[#12131a] text-slate-100 shadow-2xl flex flex-col" style={{ maxHeight: '92vh' }}>

            {/* ── Terminal title bar ── */}
            <div className="flex items-center gap-2 px-4 py-2.5 bg-[#1c1d28] border-b border-slate-700/80 rounded-t-xl shrink-0">
              <span className="h-3 w-3 rounded-full bg-red-500/80" />
              <span className="h-3 w-3 rounded-full bg-amber-400/80" />
              <span className="h-3 w-3 rounded-full bg-emerald-500/80" />
              <div className="flex-1 text-center">
                <span className="text-[11px] font-mono text-slate-400">
                  {modalJob?.name ?? 'Runs'} — terminal
                </span>
              </div>
              <Button variant="ghost" size="icon" onClick={() => { setLogsModalJobId(null); setLogsModalRunId('') }}
                aria-label="Close logs" className="h-6 w-6 text-slate-400 hover:text-white hover:bg-slate-700">
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>

            {/* ── Sub-header: status + controls ── */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700/60 bg-[#181922] shrink-0">
              <div className="flex items-center gap-3">
                {selectedModalRun && (
                  <>
                    {selectedModalRun.status.toLowerCase() === 'running' ? (
                      <span className="flex items-center gap-1.5 text-[11px] text-amber-300 font-semibold">
                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> Running…
                      </span>
                    ) : ['success', 'ok', 'completed'].includes(selectedModalRun.status.toLowerCase()) ? (
                      <span className="flex items-center gap-1.5 text-[11px] text-emerald-400 font-semibold">
                        <Check className="h-3 w-3" aria-hidden="true" />
                        Completed{selectedModalRun.exit_code != null ? ` · exit ${selectedModalRun.exit_code}` : ''}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 text-[11px] text-red-400 font-semibold">
                        <X className="h-3 w-3" aria-hidden="true" />
                        Failed{selectedModalRun.exit_code != null ? ` · exit ${selectedModalRun.exit_code}` : ''}
                      </span>
                    )}
                    <span className="text-[10px] text-slate-500 font-mono">
                      {new Date(selectedModalRun.started_at).toLocaleString()}
                      {selectedModalRun.ended_at && ` · ${runDuration(selectedModalRun)}`}
                    </span>
                    <span className="text-[10px] text-slate-500 font-mono">
                      Size: {formatLogSize(modalLogs.stdout, modalLogs.stderr)}
                    </span>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
                {runningModalRun && logsModalRunId === runningModalRun.id && (
                  <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-semibold">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
                    Live
                  </span>
                )}
                <Button variant="ghost" size="sm" onClick={() => refresh(true)}
                  className="h-6 px-2 text-[10px] text-slate-400 hover:text-white hover:bg-slate-700 gap-1">
                  <RefreshCw className="h-2.5 w-2.5" aria-hidden="true" /> Refresh
                </Button>
                <button
                  onClick={() => {
                    const text = `--- JOB: ${selectedModalRun?.job_name} ---\nCommand: ${selectedModalRun?.command ?? ''}\nStatus: ${selectedModalRun?.status}\n\n--- STDOUT ---\n${modalLogs.stdout || '(empty)'}\n\n--- STDERR ---\n${modalLogs.stderr || '(empty)'}`
                    copyToClipboard(text)
                  }}
                  className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-white px-2 py-1 rounded hover:bg-slate-700"
                  title="Copy log to clipboard"
                >
                  <Copy className="h-2.5 w-2.5" /> Copy
                </button>
              </div>
            </div>

            {/* ── Body: run list + terminal ── */}
            <div className="flex flex-1 overflow-hidden min-h-0">

              {/* Run list sidebar */}
              <div className="w-64 shrink-0 border-r border-slate-700/60 flex flex-col bg-[#14151e]">
                <p className="px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-slate-500">
                  Runs ({modalRuns.length})
                </p>
                <div className="flex-1 overflow-y-auto space-y-1 px-2 pb-2">
                  {modalRuns.length === 0 ? (
                    <div className="rounded border border-dashed border-slate-700 p-3 text-[11px] text-slate-500 text-center mt-2">
                      No runs yet for this job.
                    </div>
                  ) : (
                    modalRuns.map(r => {
                      const st = r.status.toLowerCase()
                      const isSuccess = ['success', 'ok', 'completed'].includes(st)
                      const isFail = st.includes('fail') || st.includes('error')
                      const isActive = logsModalRunId === r.id
                      return (
                        <button
                          key={r.id}
                          onClick={() => { setLogsModalAutoFollow(false); setLogsModalRunId(r.id) }}
                          className={`w-full rounded px-2.5 py-2 text-left text-[11px] transition-colors border ${
                            isActive
                              ? 'border-violet-500/60 bg-violet-500/10'
                              : 'border-transparent hover:bg-slate-800/60'
                          }`}
                        >
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${isSuccess ? 'bg-emerald-400' : isFail ? 'bg-red-400' : 'bg-amber-400 animate-pulse'}`} aria-hidden="true" />
                            <span className="font-semibold text-slate-200 truncate">{new Date(r.started_at).toLocaleTimeString()}</span>
                          </div>
                          <p className="text-[10px] text-slate-500 pl-3">
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
              <div className="flex-1 flex flex-col min-w-0 bg-[#0d0e14]">
                {modalLogsLoading ? (
                  <div className="flex flex-1 items-center justify-center gap-2 text-slate-400">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading logs…
                  </div>
                ) : !selectedModalRun ? (
                  <div className="flex flex-1 items-center justify-center text-slate-500 text-sm">
                    ← Select a run to view its output
                  </div>
                ) : (
                  <div ref={modalLogRef} className="flex-1 overflow-auto p-4 font-mono text-[11px] leading-relaxed">
                    {/* Failure fix suggestion */}
                    {selectedModalRun.failure_fix && (
                      <div className="mb-3 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-amber-400 mb-0.5">Suggested Fix</p>
                        <p className="text-amber-200 text-[11px]">{selectedModalRun.failure_fix}</p>
                      </div>
                    )}
                    {/* Job metadata header */}
                    <div className="mb-3 border-b border-slate-700/60 pb-2 space-y-0.5">
                      <p className="text-slate-500 text-[9px] uppercase tracking-widest">── job execution ──</p>
                      <p className="text-slate-400"><span className="text-amber-400">job:</span>       {selectedModalRun.job_name}</p>
                      <p className="text-slate-400"><span className="text-amber-400">command:</span>   <span className="text-slate-300">{selectedModalRun.command ?? '(not available)'}</span></p>
                      <p className="text-slate-400"><span className="text-amber-400">started:</span>   {new Date(selectedModalRun.started_at).toLocaleString()}</p>
                      <p className="text-slate-400"><span className="text-amber-400">status:</span>    <span className={['success','ok','completed'].includes(selectedModalRun.status.toLowerCase()) ? 'text-emerald-400' : selectedModalRun.status.toLowerCase() === 'running' ? 'text-amber-400' : 'text-red-400'}>{selectedModalRun.status}{selectedModalRun.exit_code != null ? ` (exit ${selectedModalRun.exit_code})` : ''}</span></p>
                    </div>
                    {/* stdout */}
                    <div className="mt-2">
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                        <span className="text-[9px] font-bold uppercase tracking-widest text-slate-500">stdout</span>
                      </div>
                      <pre className="whitespace-pre-wrap break-words text-emerald-300">
                        {modalLogs.stdout || <span className="text-slate-600 italic">(empty)</span>}
                      </pre>
                    </div>
                    {/* stderr */}
                    {modalLogs.stderr && (
                      <div className="mt-3">
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />
                          <span className="text-[9px] font-bold uppercase tracking-widest text-slate-500">stderr</span>
                        </div>
                        <pre className="whitespace-pre-wrap break-words text-red-300">
                          {modalLogs.stderr}
                        </pre>
                      </div>
                    )}
                    {runningModalRun && logsModalRunId === runningModalRun.id && (
                      <div className="mt-2 flex items-center gap-1.5 text-[10px] text-emerald-400">
                        <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
                        Waiting for output…
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* ── Footer ── */}
            <div className="flex items-center justify-between px-4 py-2 border-t border-slate-700/60 bg-[#181922] shrink-0 rounded-b-xl">
              <span className="text-[10px] text-slate-600 font-mono">
                {selectedModalRun ? `run/${selectedModalRun.id.slice(0, 8)}` : 'no run selected'}
                {' · job/'}{logsModalJobId?.slice(0, 8)}
              </span>
              <Button variant="ghost" onClick={() => { setLogsModalJobId(null); setLogsModalRunId('') }}
                className="h-7 px-3 text-xs text-slate-300 border border-slate-700 hover:bg-slate-800">
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
