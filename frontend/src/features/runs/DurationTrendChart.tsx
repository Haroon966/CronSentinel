import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ComposedChart,
  Scatter,
  XAxis,
  YAxis,
  ReferenceLine,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts'
import { AlertCircle, BarChart2, RefreshCw } from 'lucide-react'

import { API_BASE_URL, apiFetch, getFetchErrorMessage } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  VALID_RANGES,
  MIN_POINTS_TO_SHOW_CHART,
  OUTLIER_MULTIPLIER,
  formatDuration,
  isOutlier,
  type DurationTrendRange,
} from './durationTrendUtils'
export type { DurationTrendRange } from './durationTrendUtils'
export { VALID_RANGES, MIN_POINTS_TO_SHOW_CHART, OUTLIER_MULTIPLIER, formatDuration, isOutlier } from './durationTrendUtils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TrendPoint = {
  run_id: string
  started_at: string
  duration_ms: number
  status: string
}

type TrendStats = {
  p50: number
  p95: number
  p99: number
}

type TrendResponse = {
  job_id: string
  range: DurationTrendRange
  points: TrendPoint[]
  stats: TrendStats
}

// A flattened version of TrendPoint used by recharts (ts is epoch ms for the X axis).
type ChartPoint = TrendPoint & {
  ts: number
  isOutlier: boolean
}

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

const STATUS_COLOR: Record<string, string> = {
  success: 'var(--cs-healthy)',
  failure: 'var(--cs-failed)',
  timed_out: 'var(--cs-late)',
}

const OUTLIER_COLOR = 'var(--cs-failed)'

function dotColor(point: ChartPoint): string {
  if (point.isOutlier) return OUTLIER_COLOR
  const s = point.status.toLowerCase()
  return STATUS_COLOR[s] ?? 'var(--cs-pending)'
}

// ---------------------------------------------------------------------------
// Custom dot shape for <Scatter>
// ---------------------------------------------------------------------------

interface DotProps {
  cx?: number
  cy?: number
  payload?: ChartPoint
}

function RunDot({ cx = 0, cy = 0, payload }: DotProps) {
  if (!payload) return null
  const color = dotColor(payload)
  const r = payload.isOutlier ? 6 : 4
  return (
    <circle
      cx={cx}
      cy={cy}
      r={r}
      fill={color}
      fillOpacity={payload.isOutlier ? 1 : 0.85}
      stroke={payload.isOutlier ? 'var(--cs-failed-border)' : 'transparent'}
      strokeWidth={payload.isOutlier ? 1.5 : 0}
      aria-hidden="true"
    />
  )
}

// ---------------------------------------------------------------------------
// Custom tooltip
// ---------------------------------------------------------------------------


interface TooltipRenderProps {
  active?: boolean
  payload?: Array<{ payload: ChartPoint }>
}

function DurationTooltip({ active, payload }: TooltipRenderProps) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (!d) return null
  const localTime = new Date(d.started_at).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  const statusLabel =
  
    d.status === 'timed_out' ? 'Timed Out' : d.status.charAt(0).toUpperCase() + d.status.slice(1)
  return (
    <div
      className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md"
      role="status"
      aria-live="polite"
    >
      <p className="font-medium text-popover-foreground">{localTime}</p>
      <p className="mt-0.5 text-muted-foreground">
        Duration:{' '}
        <span className="font-semibold text-popover-foreground">{formatDuration(d.duration_ms)}</span>
      </p>
      <p className="mt-0.5 text-muted-foreground">
        Status:{' '}
        <span
          className="font-semibold"
          style={{ color: dotColor(d) }}
        >
          {statusLabel}
          {d.isOutlier ? ' · outlier' : ''}
        </span>
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers for axis ticks
// ---------------------------------------------------------------------------

function formatXTick(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatYTick(ms: number): string {
  if (ms === 0) return '0'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60_000)}m`
}

// ---------------------------------------------------------------------------
// Skeleton loader
// ---------------------------------------------------------------------------

function ChartSkeleton() {
  return (
    <div className="flex h-full w-full flex-col gap-2 px-2 pb-2 pt-4" aria-hidden="true">
      {[60, 40, 75].map((pct, i) => (
        <div
          key={i}
          className="h-3 animate-pulse rounded bg-muted"
          style={{ width: `${pct}%` }}
        />
      ))}
      <div className="mt-2 h-32 animate-pulse rounded bg-muted" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Legend row
// ---------------------------------------------------------------------------

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: color }}
        aria-hidden="true"
      />
      {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface DurationTrendChartProps {
  jobId: string
}

export function DurationTrendChart({ jobId }: DurationTrendChartProps) {
  const [range, setRange] = useState<DurationTrendRange>('30d')
  const [data, setData] = useState<TrendResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const fetch = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch<TrendResponse>(
        `${API_BASE_URL}/api/jobs/${encodeURIComponent(jobId)}/runs/duration-trend?range=${range}`,
        { signal: ac.signal },
      )
      if (!ac.signal.aborted) {
        setData(res)
      }
    } catch (e) {
      if (!ac.signal.aborted) {
        setError(getFetchErrorMessage(e))
      }
    } finally {
      if (!ac.signal.aborted) {
        setLoading(false)
      }
    }
  }, [jobId, range])

  useEffect(() => {
    void fetch()
    return () => {
      abortRef.current?.abort()
    }
  }, [fetch])

  // Build chart points with outlier flag.
  const chartPoints: ChartPoint[] = (() => {
    if (!data) return []
    const p95 = data.stats.p95
    return data.points.map(pt => ({
      ...pt,
      ts: new Date(pt.started_at).getTime(),
      isOutlier: isOutlier(pt.duration_ms, p95),
    }))
  })()

  const isEmpty = !loading && !error && chartPoints.length < MIN_POINTS_TO_SHOW_CHART

  return (
    <section
      className="mb-4 rounded-lg border border-border/60 bg-card p-4"
      aria-label="Runtime duration trends chart"
    >
      {/* Header row */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <BarChart2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-xs font-semibold uppercase tracking-wide text-primary">
            Duration Trends
          </h2>
        </div>
        <div className="flex-1" />
        {/* Range toggle */}
        <div
          className="flex overflow-hidden rounded-md border border-border/60 text-[10px] font-semibold"
          role="group"
          aria-label="Select time range"
        >
          {VALID_RANGES.map(r => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`px-2.5 py-1.5 transition-colors ${
                range === r
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-card text-muted-foreground hover:bg-muted/40'
              }`}
              aria-pressed={range === r}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Chart body */}
      <div className="h-52">
        {loading ? (
          <ChartSkeleton />
        ) : error ? (
          <div
            className="flex h-full flex-col items-center justify-center gap-2 text-center"
            role="alert"
          >
            <AlertCircle className="h-6 w-6 text-[var(--cs-failed)]" aria-hidden="true" />
            <p className="text-xs text-muted-foreground">{error}</p>
            <Button type="button" variant="secondary" size="sm" onClick={() => void fetch()}>
              <RefreshCw className="mr-1.5 h-3 w-3" aria-hidden="true" />
              Retry
            </Button>
          </div>
        ) : isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
            <BarChart2 className="h-8 w-8 text-muted-foreground/40" aria-hidden="true" />
            <p className="text-xs font-medium text-muted-foreground">Not enough data yet</p>
            <p className="max-w-[260px] text-[11px] text-muted-foreground/70">
              At least {MIN_POINTS_TO_SHOW_CHART} runs with recorded durations are needed to show
              the trend chart. Run the job a few more times to see the chart.
            </p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="var(--border)"
                opacity={0.5}
                aria-hidden="true"
              />
              <XAxis
                dataKey="ts"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                tickFormatter={formatXTick}
                tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                axisLine={{ stroke: 'var(--border)' }}
                tickLine={{ stroke: 'var(--border)' }}
                aria-label="Run date"
              />
              <YAxis
                tickFormatter={formatYTick}
                tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                axisLine={{ stroke: 'var(--border)' }}
                tickLine={{ stroke: 'var(--border)' }}
                width={44}
                aria-label="Run duration"
              />
              <Tooltip
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                content={(props: any) => <DurationTooltip {...(props as TooltipRenderProps)} />}
                cursor={{ stroke: 'var(--border)', strokeWidth: 1 }}
              />

              {/* Percentile reference lines */}
              {data && data.stats.p50 > 0 && (
                <ReferenceLine
                  y={data.stats.p50}
                  stroke="var(--cs-healthy)"
                  strokeDasharray="4 3"
                  strokeWidth={1.5}
                  label={{
                    value: `p50 ${formatDuration(data.stats.p50)}`,
                    position: 'insideTopRight',
                    fontSize: 9,
                    fill: 'var(--cs-healthy)',
                  }}
                  aria-label={`Median (p50): ${formatDuration(data.stats.p50)}`}
                />
              )}
              {data && data.stats.p95 > 0 && (
                <ReferenceLine
                  y={data.stats.p95}
                  stroke="var(--cs-late)"
                  strokeDasharray="4 3"
                  strokeWidth={1.5}
                  label={{
                    value: `p95 ${formatDuration(data.stats.p95)}`,
                    position: 'insideTopRight',
                    fontSize: 9,
                    fill: 'var(--cs-late)',
                  }}
                  aria-label={`95th percentile (p95): ${formatDuration(data.stats.p95)}`}
                />
              )}
              {data && data.stats.p99 > 0 && (
                <ReferenceLine
                  y={data.stats.p99}
                  stroke="var(--cs-failed)"
                  strokeDasharray="4 3"
                  strokeWidth={1.5}
                  label={{
                    value: `p99 ${formatDuration(data.stats.p99)}`,
                    position: 'insideTopRight',
                    fontSize: 9,
                    fill: 'var(--cs-failed)',
                  }}
                  aria-label={`99th percentile (p99): ${formatDuration(data.stats.p99)}`}
                />
              )}

              {/* Run data points */}
              <Scatter
                data={chartPoints}
                shape={<RunDot />}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Legend (only when chart is visible) */}
      {!loading && !error && !isEmpty && (
        <div
          className="mt-2 flex flex-wrap items-center gap-3"
          role="list"
          aria-label="Chart legend"
        >
          <LegendDot color="var(--cs-healthy)" label="Success" />
          <LegendDot color="var(--cs-failed)" label="Failed" />
          <LegendDot color="var(--cs-late)" label="Timed Out" />
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground" role="listitem">
            <span
              className="inline-block h-3 w-3 rounded-full border border-[var(--cs-failed-border)]"
              style={{ background: 'var(--cs-failed)' }}
              aria-hidden="true"
            />
            Outlier (&gt;{OUTLIER_MULTIPLIER}× p95)
          </span>
          {data && data.points.length > 0 && (
            <span className="ml-auto text-[10px] text-muted-foreground">
              {data.points.length} run{data.points.length === 1 ? '' : 's'} in {range}
            </span>
          )}
        </div>
      )}
    </section>
  )
}
