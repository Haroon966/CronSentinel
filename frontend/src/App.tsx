import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Code2,
  Cpu,
  FileCode2,
  HardDrive,
  Loader2,
  Monitor,
  Play,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
  WifiOff,
  X,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'

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
  command: string; comment: string
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

/** Converts a cron expression to a short human-readable string. */
function cronToHuman(spec: string): string {
  const f = spec.trim().split(/\s+/)
  if (f.length !== 5) return spec
  const [min, hr, , , dow] = f
  if (spec === '* * * * *') return 'Every minute'
  if (/^\*\/\d+$/.test(min) && hr === '*') {
    const n = min.slice(2); return `Every ${n} minute${n === '1' ? '' : 's'}`
  }
  if (min === '0' && /^\*\/\d+$/.test(hr)) {
    const n = hr.slice(2); return `Every ${n} hour${n === '1' ? '' : 's'}`
  }
  if (min === '0' && hr === '*') return 'Every hour'
  if (/^\d+$/.test(min) && /^\d+$/.test(hr)) {
    const h = parseInt(hr), m = parseInt(min)
    const period = h >= 12 ? 'PM' : 'AM'
    const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h
    const t = `${h12}:${String(m).padStart(2, '0')} ${period}`
    if (dow !== '*' && /^\d+$/.test(dow)) {
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
      return `Every ${days[parseInt(dow)]} at ${t}`
    }
    return `At ${t}, every day`
  }
  return spec
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
  const [minimalMode, setMinimalMode]     = useState(false)
  const [showJobForm, setShowJobForm]     = useState(false)
  const [showScriptForm, setShowScriptForm] = useState(false)
  const [selectedRun, setSelectedRun]     = useState<string>('')
  const [logsLoading, setLogsLoading]     = useState(false)
  const [logs, setLogs]                   = useState({ stdout: '', stderr: '' })
  const [logsModalJobId, setLogsModalJobId] = useState<string | null>(null)
  const [logsModalRunId, setLogsModalRunId] = useState('')
  const [modalLogsLoading, setModalLogsLoading] = useState(false)
  const [modalLogs, setModalLogs] = useState({ stdout: '', stderr: '' })

  // ── Per-action loading ────────────────────────────────────────────────────
  const [scriptSaving, setScriptSaving]     = useState(false)
  const [jobSaving, setJobSaving]           = useState(false)
  const [deletingScript, setDeletingScript] = useState<string | null>(null)
  const [deletingJob, setDeletingJob]       = useState<string | null>(null)
  const [runningJob, setRunningJob]         = useState<string | null>(null)

  // ── Delete confirmation ───────────────────────────────────────────────────
  const [confirmDeleteScript, setConfirmDeleteScript] = useState<string | null>(null)
  const [confirmDeleteJob, setConfirmDeleteJob]       = useState<string | null>(null)

  // ── Form state ────────────────────────────────────────────────────────────
  const [newScript, setNewScript] = useState({ name: '', content: 'echo "hello from script"' })
  const [newJob, setNewJob]       = useState({
    name: '', schedule: '*/5 * * * *', command: 'echo "cron test"',
    comment: '', logging_enabled: true, timeout_seconds: 300,
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

  // ── Log streaming ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedRun) return
    setLogsLoading(true); setLogs({ stdout: '', stderr: '' })
    apiFetch<{ stdout: string; stderr: string }>(`${API}/api/runs/${selectedRun}/logs`)
      .then(d => { setLogs(d ?? { stdout: '', stderr: '' }); setLogsLoading(false) })
      .catch(err => { setLogsLoading(false); toast.error('Failed to load logs', { description: err instanceof Error ? err.message : 'Unknown error' }) })
    const ev = new EventSource(`${API}/api/runs/${selectedRun}/stream`)
    ev.onmessage = (msg) => {
      try {
        const p = JSON.parse(msg.data) as { stream?: string; line?: string; stdout?: string; stderr?: string }
        setLogs(prev => ({
          stdout: p.stream === 'stdout' && p.line ? `${prev.stdout}${p.line}\n` : p.stdout ?? prev.stdout,
          stderr: p.stream === 'stderr' && p.line ? `${prev.stderr}${p.line}\n` : p.stderr ?? prev.stderr,
        }))
      } catch { /* malformed frame */ }
    }
    ev.onerror = () => ev.close()
    return () => ev.close()
  }, [selectedRun])

  useEffect(() => {
    if (!logsModalRunId) return
    setModalLogsLoading(true)
    setModalLogs({ stdout: '', stderr: '' })
    apiFetch<{ stdout: string; stderr: string }>(`${API}/api/runs/${logsModalRunId}/logs`)
      .then(d => {
        setModalLogs(d ?? { stdout: '', stderr: '' })
        setModalLogsLoading(false)
      })
      .catch(err => {
        setModalLogsLoading(false)
        toast.error('Failed to load logs', { description: err instanceof Error ? err.message : 'Unknown error' })
      })
    const ev = new EventSource(`${API}/api/runs/${logsModalRunId}/stream`)
    ev.onmessage = (msg) => {
      try {
        const p = JSON.parse(msg.data) as { stream?: string; line?: string; stdout?: string; stderr?: string }
        setModalLogs(prev => ({
          stdout: p.stream === 'stdout' && p.line ? `${prev.stdout}${p.line}\n` : p.stdout ?? prev.stdout,
          stderr: p.stream === 'stderr' && p.line ? `${prev.stderr}${p.line}\n` : p.stderr ?? prev.stderr,
        }))
      } catch { /* malformed frame */ }
    }
    ev.onerror = () => ev.close()
    return () => ev.close()
  }, [logsModalRunId])

  // ── Derived ───────────────────────────────────────────────────────────────
  const successCount    = runs.filter(r => ['success', 'ok', 'completed'].includes(r.status.toLowerCase())).length
  const failedCount     = runs.filter(r => r.status.toLowerCase().includes('fail') || r.status.toLowerCase().includes('error')).length
  const selectedRunData = runs.find(r => r.id === selectedRun) ?? null
  const modalRuns = logsModalJobId ? runs.filter(r => r.job_id === logsModalJobId) : []
  const modalJob = logsModalJobId ? jobs.find(j => j.id === logsModalJobId) : null
  const selectedModalRun = modalRuns.find(r => r.id === logsModalRunId) ?? null

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
      setNewJob({ name: '', schedule: '*/5 * * * *', command: 'echo "cron test"', comment: '', logging_enabled: true, timeout_seconds: 300 })
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

  const runJob = async (id: string, name: string) => {
    setRunningJob(id)
    try {
      await apiFetch(`${API}/api/jobs/${encodeURIComponent(id)}/run`, { method: 'POST' })
      toast.success('Job started', { description: name }); refresh()
    } catch (err) { toast.error('Failed to start job', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally { setRunningJob(null) }
  }

  const openLogsModal = (jobId: string) => {
    const latestRun = runs.find(r => r.job_id === jobId)
    setLogsModalJobId(jobId)
    setLogsModalRunId(latestRun?.id ?? '')
  }

  // ── Sidebar content ───────────────────────────────────────────────────────
  const now = new Date().toLocaleTimeString()
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

        {apiOnline === true ? (
          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-600">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 motion-safe:animate-pulse" aria-hidden="true" />
            System Status: Optimal
          </span>
        ) : apiOnline === false ? (
          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-red-500">
            <WifiOff className="h-3 w-3" aria-hidden="true" /> Offline
          </span>
        ) : null}

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
                  <div className="flex items-center gap-3 mb-3">
                    <div>
                      <h1 className="text-[15px] font-bold tracking-tight text-amber-500 uppercase">Scheduled Tasks</h1>
                      <p className="text-[11px] text-muted-foreground">{jobs.length} of {jobs.length} scheduled tasks</p>
                    </div>
                    <div className="flex-1" />
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
                      Minimal Mode
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
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label htmlFor="job-name" className="text-xs text-muted-foreground">Job name</Label>
                          <Input id="job-name" placeholder="e.g. daily-backup" value={newJob.name}
                            onChange={e => { setNewJob(j => ({ ...j, name: e.target.value })); if (jobErrors.name) setJobErrors(p => ({ ...p, name: '' })) }}
                            aria-invalid={!!jobErrors.name} className="h-8 text-xs" />
                          <FieldError msg={jobErrors.name} id="job-name-error" />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="job-schedule" className="text-xs text-muted-foreground">Schedule</Label>
                          <div className="flex gap-1.5">
                            <Input id="job-schedule" placeholder="*/5 * * * *" value={newJob.schedule}
                              onChange={e => { setNewJob(j => ({ ...j, schedule: e.target.value })); if (jobErrors.schedule) setJobErrors(p => ({ ...p, schedule: '' })) }}
                              aria-invalid={!!jobErrors.schedule} className="h-8 font-mono text-xs flex-1" />
                            <Select onValueChange={v => { setNewJob(j => ({ ...j, schedule: v })); setJobErrors(p => ({ ...p, schedule: '' })) }}>
                              <SelectTrigger className="h-8 w-32 text-xs"><SelectValue placeholder="Preset" /></SelectTrigger>
                              <SelectContent>{presets.map(p => <SelectItem key={p.schedule} value={p.schedule} className="text-xs">{p.label}</SelectItem>)}</SelectContent>
                            </Select>
                          </div>
                          <FieldError msg={jobErrors.schedule} id="job-schedule-error" />
                        </div>
                        <div className="col-span-2 space-y-1">
                          <Label htmlFor="job-command" className="text-xs text-muted-foreground">Command</Label>
                          <Input id="job-command" placeholder='echo "cron test"' value={newJob.command}
                            onChange={e => { setNewJob(j => ({ ...j, command: e.target.value })); if (jobErrors.command) setJobErrors(p => ({ ...p, command: '' })) }}
                            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveJob() }}
                            aria-invalid={!!jobErrors.command} className="h-8 font-mono text-xs" />
                          <FieldError msg={jobErrors.command} id="job-command-error" />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="job-comment" className="text-xs text-muted-foreground">Comment <span className="opacity-50">(optional)</span></Label>
                          <Input id="job-comment" placeholder="Description…" value={newJob.comment}
                            onChange={e => setNewJob(j => ({ ...j, comment: e.target.value }))} className="h-8 text-xs" />
                        </div>
                        <div className="flex items-end">
                          <Button size="sm" onClick={saveJob} disabled={jobSaving} className="h-8 text-xs gap-1.5 w-full">
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
                  ) : (
                    <ul className="space-y-2" role="list">
                      {jobs.map(j => (
                        <li key={j.id} className="rounded-lg border border-border/50 bg-white shadow-xs overflow-hidden">
                          <div className="flex items-center gap-3 px-4 py-3">
                            {/* Run history dots */}
                            <RunDots jobId={j.id} runs={runs} />

                            {/* Command — prominent, like the reference */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <code className="flex-1 truncate rounded bg-muted/60 border border-border/50 px-2.5 py-1 text-[12px] font-mono text-foreground">
                                  {j.command}
                                </code>
                              </div>

                              {!minimalMode && (
                                <div className="space-y-1.5 mt-2">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="inline-flex items-center gap-1 rounded-sm border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                                      <Clock className="h-2.5 w-2.5" aria-hidden="true" />
                                      {cronToHuman(j.schedule)}
                                    </span>
                                    {j.comment && (
                                      <span className="text-[11px] text-muted-foreground italic">{j.comment}</span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="text-[10px] text-muted-foreground/60 font-mono">#{j.id.slice(0, 8)}</span>
                                    {j.logging_enabled && (
                                      <span className="inline-flex items-center rounded-sm border border-violet-200 bg-violet-50 px-1.5 py-px text-[10px] font-semibold text-violet-600">Logged</span>
                                    )}
                                    {(() => {
                                      const last = runs.find(r => r.job_id === j.id)
                                      return last ? <RunBadge status={last.status} /> : null
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
                                aria-label={`View logs for ${j.name}`}
                                className="h-7 w-7 text-muted-foreground hover:text-violet-600 hover:bg-violet-50"
                                onClick={() => openLogsModal(j.id)}
                              >
                                <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
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
                  <div className="flex items-center gap-3 mb-3">
                    <div>
                      <h1 className="text-[15px] font-bold tracking-tight text-amber-500 uppercase">Run History</h1>
                      <p className="text-[11px] text-muted-foreground">
                        {successCount} succeeded · {failedCount} failed · {runs.length} total
                      </p>
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
                      {runs.slice(0, 50).map(r => (
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
                              <p className="text-xs font-semibold text-foreground">{r.job_name}</p>
                              <code className="block truncate text-[10px] text-muted-foreground font-mono mt-0.5">
                                {new Date(r.started_at).toLocaleString()}
                                {r.ended_at && <span className="ml-2 text-muted-foreground/60">· {runDuration(r)}</span>}
                              </code>
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
                  {runs.length > 50 && (
                    <p className="mt-3 text-center text-[11px] text-muted-foreground">Showing 50 of {runs.length} runs</p>
                  )}
                </div>
              )}

            </div>
          </ScrollArea>
        </div>
      </div>

      {logsModalJobId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-5xl rounded-xl border border-border/60 bg-[#1f1f2c] text-slate-100 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-700/70 px-4 py-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-amber-300">View Logs</p>
                <p className="mt-1 text-sm font-semibold text-slate-100">{modalJob?.name ?? 'Runs'}</p>
                <p className="text-[11px] text-slate-400">{modalRuns.length} logs</p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => refresh(true)}
                  className="h-8 border-slate-600 bg-slate-800 text-xs text-slate-100 hover:bg-slate-700"
                >
                  <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                  Refresh
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => { setLogsModalJobId(null); setLogsModalRunId('') }}
                  aria-label="Close logs modal"
                  className="h-8 w-8 text-slate-300 hover:bg-slate-700 hover:text-white"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </div>

            <div className="grid h-[68vh] grid-cols-[320px_1fr] gap-0">
              <div className="border-r border-slate-700/70 p-3">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Log Files</p>
                <div className="space-y-2 overflow-y-auto pr-1">
                  {modalRuns.length === 0 ? (
                    <div className="rounded border border-dashed border-slate-600 p-4 text-xs text-slate-400">
                      No runs yet for this job.
                    </div>
                  ) : (
                    modalRuns.map(r => (
                      <button
                        key={r.id}
                        onClick={() => setLogsModalRunId(r.id)}
                        className={`w-full rounded border px-3 py-2 text-left text-xs transition-colors ${
                          logsModalRunId === r.id
                            ? 'border-violet-400 bg-violet-500/15'
                            : 'border-slate-700 bg-slate-800/60 hover:bg-slate-800'
                        }`}
                      >
                        <p className="font-semibold text-slate-100">{new Date(r.started_at).toLocaleString()}</p>
                        <p className="mt-0.5 text-[10px] text-slate-400">
                          Status: {r.status}
                          {r.exit_code != null ? ` · Exit: ${r.exit_code}` : ''}
                          {r.ended_at ? ` · ${runDuration(r)}` : ''}
                        </p>
                      </button>
                    ))
                  )}
                </div>
              </div>

              <div className="p-3">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Log Content</p>
                {modalLogsLoading ? (
                  <div className="flex h-[58vh] items-center justify-center text-sm text-slate-400">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                    Loading logs...
                  </div>
                ) : !selectedModalRun ? (
                  <div className="flex h-[58vh] items-center justify-center rounded border border-dashed border-slate-600 text-sm text-slate-400">
                    Select a run to view logs.
                  </div>
                ) : (
                  <div className="h-[58vh] overflow-auto rounded border border-slate-700 bg-[#0f1118] p-3 font-mono text-[11px] leading-relaxed text-slate-200">
                    <pre className="whitespace-pre-wrap break-words">
{`--- [ JOB START ] ---
Job:       ${selectedModalRun.job_name}
Command:   ${selectedModalRun.command ?? '(not available)'}
Timestamp: ${new Date(selectedModalRun.started_at).toLocaleString()}
Status:    ${selectedModalRun.status}${selectedModalRun.exit_code != null ? ` (exit ${selectedModalRun.exit_code})` : ''}
Size:      ${formatLogSize(modalLogs.stdout, modalLogs.stderr)}

--- [ STDOUT ] ---
${modalLogs.stdout || '(empty)'}

--- [ STDERR ] ---
${modalLogs.stderr || '(empty)'}
`}
                    </pre>
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end border-t border-slate-700/70 px-4 py-3">
              <Button
                variant="outline"
                onClick={() => { setLogsModalJobId(null); setLogsModalRunId('') }}
                className="border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700"
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
