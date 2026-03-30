import { useEffect, useMemo, type ReactElement } from 'react'
import cronstrue from 'cronstrue'
import { RefreshCw, Server, WifiOff } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatCountdown, nextRunFromCron } from '@/features/jobs/time'
import { cn } from '@/lib/utils'

import { JobStatusBadge } from './JobStatusBadge'
import { SummaryCards, type SummaryCounts } from './SummaryCards'

const DASHBOARD_REFRESH_MS = 30_000

export type DashboardJobRow = {
  id: string
  name: string
  schedule: string
  timezone?: string
  dashboard_status?: string
  last_run_status?: string | null
  last_run_at?: string | null
  last_run_duration_ms?: number | null
}

export type DashboardServerRow = {
  id: string
  name: string
  health: 'ok' | 'stale' | 'pending'
}

type DashboardProps = {
  jobs: DashboardJobRow[]
  /** Hosts that POST /api/server-heartbeat (optional summary strip). */
  servers?: DashboardServerRow[]
  loading: boolean
  /** True only after a failed refresh (distinct from initial null / in-flight). */
  apiOffline: boolean
  onRefresh: () => void
  onViewRuns: (jobId: string) => void
  onManageServers?: () => void
}

function cronToHuman(spec: string): string {
  try {
    return cronstrue.toString(spec.trim(), { throwExceptionOnParseError: true })
  } catch {
    return spec
  }
}

function formatLastRun(
  at: string | null | undefined,
  durationMs: number | null | undefined,
  status: string | null | undefined,
): string {
  if (!at) return '—'
  const d = new Date(at)
  const time = Number.isNaN(d.getTime()) ? at : d.toLocaleString()
  let dur = ''
  if (durationMs != null && Number.isFinite(durationMs)) {
    if (durationMs < 1000) dur = ` · ${durationMs}ms`
    else if (durationMs < 60000) dur = ` · ${(durationMs / 1000).toFixed(1)}s`
    else dur = ` · ${Math.floor(durationMs / 60000)}m ${Math.floor((durationMs % 60000) / 1000)}s`
  }
  const st = status ? ` · ${status}` : ''
  return `${time}${dur}${st}`
}

function nextRunSummary(job: DashboardJobRow): string {
  const tz = job.timezone?.trim() || 'Local'
  const next = nextRunFromCron(job.schedule, tz)
  if (!next) return '—'
  return `${next.toLocaleString()} (${formatCountdown(next)})`
}

function computeSummary(jobs: DashboardJobRow[]): SummaryCounts {
  let healthy = 0
  let late = 0
  let failed = 0
  for (const j of jobs) {
    const s = (j.dashboard_status ?? 'never_run').toLowerCase()
    if (s === 'healthy' || s === 'running') healthy += 1
    else if (s === 'late') late += 1
    else if (s === 'failed') failed += 1
  }
  return { total: jobs.length, healthy, late, failed }
}

function TableSkeletonRows(): ReactElement {
  return (
    <>
      {Array.from({ length: 5 }, (_, i) => (
        <TableRow key={i} aria-hidden>
          <TableCell colSpan={5}>
            <div className="h-9 w-full animate-pulse rounded-md bg-muted/70" />
          </TableCell>
        </TableRow>
      ))}
    </>
  )
}

export function Dashboard({ jobs, servers = [], loading, apiOffline, onRefresh, onViewRuns, onManageServers }: DashboardProps): ReactElement {
  const counts = useMemo(() => computeSummary(jobs), [jobs])

  useEffect(() => {
    const id = window.setInterval(() => {
      onRefresh()
    }, DASHBOARD_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [onRefresh])

  const showSkeleton = loading && jobs.length === 0
  const showErrorBanner = apiOffline

  return (
    <div role="tabpanel" id="panel-dashboard" aria-labelledby="tab-dashboard" className="space-y-5">
      <div className="sticky top-0 z-10 -mx-5 mb-1 flex flex-wrap items-center justify-between gap-3 border-b border-border/40 bg-background/95 px-5 py-2 backdrop-blur">
        <div>
          <h1 className="text-[15px] font-bold tracking-tight text-primary uppercase">Live status</h1>
          <p className="text-[11px] text-muted-foreground">
            Overview of all jobs · Refreshes every {DASHBOARD_REFRESH_MS / 1000}s while this tab is open
          </p>
          <p className="text-[10px] text-muted-foreground/90 mt-1 max-w-xl leading-snug">
            Missed-heartbeat alerts use Settings → “Missed heartbeat” and at least one working channel (SMTP, Slack, webhook, or SMS).
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => {
            onRefresh()
          }}
          disabled={loading}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'motion-safe:animate-spin')} aria-hidden />
          Refresh
        </Button>
      </div>

      {showErrorBanner && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"
        >
          <div className="flex items-center gap-2 text-destructive">
            <WifiOff className="h-4 w-4 shrink-0" aria-hidden />
            <span>Could not reach the API. Check your connection and try again.</span>
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={() => onRefresh()}>
            Retry
          </Button>
        </div>
      )}

      <SummaryCards counts={counts} />

      {servers.length > 0 && (
        <div className="rounded-lg border border-border/60 bg-card p-4 shadow-[var(--cs-shadow-card)]">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              <Server className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Monitored servers
            </div>
            {onManageServers && (
              <Button type="button" variant="ghost" size="sm" className="h-7 text-[10px]" onClick={onManageServers}>
                Manage
              </Button>
            )}
          </div>
          <ul className="flex flex-wrap gap-2" aria-label="Server heartbeat status">
            {servers.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/20 px-2.5 py-1.5 text-xs"
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    s.health === 'ok' ? 'bg-emerald-400' : s.health === 'pending' ? 'bg-amber-400' : 'bg-red-400'
                  }`}
                  aria-hidden
                />
                <span className="font-medium">{s.name}</span>
                <span className="text-muted-foreground">
                  {s.health === 'ok' ? 'Live' : s.health === 'pending' ? 'Waiting for first ping' : 'Unreachable'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Desktop table */}
      <div className="hidden md:block">
        <ScrollArea className="max-h-[min(70vh,720px)] rounded-md border border-border/60">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead>Next expected</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {showSkeleton ? (
                <TableSkeletonRows />
              ) : jobs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                    No jobs yet. Create one under Cron Jobs.
                  </TableCell>
                </TableRow>
              ) : (
                jobs.map((job) => (
                  <TableRow
                    key={job.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => onViewRuns(job.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onViewRuns(job.id)
                      }
                    }}
                    aria-label={`Open run history for ${job.name}`}
                  >
                    <TableCell className="font-medium">{job.name}</TableCell>
                    <TableCell className="max-w-[220px] whitespace-normal text-muted-foreground text-xs">
                      {cronToHuman(job.schedule)}
                    </TableCell>
                    <TableCell>
                      <JobStatusBadge status={job.dashboard_status ?? 'never_run'} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-normal max-w-[280px]">
                      {formatLastRun(job.last_run_at, job.last_run_duration_ms, job.last_run_status ?? undefined)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-normal max-w-[240px]">
                      {nextRunSummary(job)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </ScrollArea>
      </div>

      {/* Mobile cards */}
      <div className="flex flex-col gap-3 md:hidden">
        {showSkeleton ? (
          Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-36 animate-pulse rounded-xl border border-border/60 bg-muted/40" aria-hidden />
          ))
        ) : jobs.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border/60 py-10 text-center text-sm text-muted-foreground">
            No jobs yet. Create one under Cron Jobs.
          </p>
        ) : (
          jobs.map((job) => (
            <button
              key={job.id}
              type="button"
              onClick={() => onViewRuns(job.id)}
              className="rounded-xl border border-border/60 bg-card p-4 text-left shadow-sm transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="font-semibold text-sm">{job.name}</span>
                <JobStatusBadge status={job.dashboard_status ?? 'never_run'} />
              </div>
              <p className="mt-2 text-[11px] leading-snug text-muted-foreground">{cronToHuman(job.schedule)}</p>
              <p className="mt-2 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">Last run: </span>
                {formatLastRun(job.last_run_at, job.last_run_duration_ms, job.last_run_status ?? undefined)}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">Next: </span>
                {nextRunSummary(job)}
              </p>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
