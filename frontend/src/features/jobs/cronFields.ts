import { Cron } from 'croner'

export const CUSTOM_SELECT_VALUE = '__custom__'

/** Debounce delay for next-run preview (PRD FEAT-10). */
export const NEXT_RUN_PREVIEW_DEBOUNCE_MS = 250

/** Number of upcoming runs to list in the preview. */
export const NEXT_RUN_PREVIEW_COUNT = 10

const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_DAY = 24 * MS_PER_HOUR

/** Warn when the first next run is farther than this from "now". */
export const NEXT_RUN_WARN_MIN_GAP_MS = MS_PER_DAY

/** Warn when more than this many executions fall inside a 1-hour window from `from`. */
export const HIGH_FREQUENCY_RUNS_PER_HOUR_THRESHOLD = 60

const MAX_RUN_ITERATIONS = 5000

export type SplitCronResult =
  | { ok: true; parts: [string, string, string, string, string] }
  | { ok: false; reason: 'empty' | 'field_count' }

/** Split a standard 5-field cron expression into parts. */
export function splitCronExpression(raw: string): SplitCronResult {
  const t = raw.trim()
  if (!t) return { ok: false, reason: 'empty' }
  const parts = t.split(/\s+/).filter(Boolean)
  if (parts.length !== 5) return { ok: false, reason: 'field_count' }
  return { ok: true, parts: [parts[0], parts[1], parts[2], parts[3], parts[4]] }
}

export function composeCronExpression(parts: readonly [string, string, string, string, string]): string {
  return parts.join(' ')
}

/** Whether `token` is listed in the given preset options (exact match). */
export function fieldSelectValue(token: string, presetValues: readonly string[]): string {
  return presetValues.includes(token) ? token : CUSTOM_SELECT_VALUE
}

/**
 * Next N fire times from `currentDate` (Croner matches typical crontab 5-field semantics).
 * Returns null if the expression cannot be parsed or has no upcoming runs.
 */
export function getNextNCronDates(cronExpr: string, n: number, currentDate: Date = new Date()): Date[] | null {
  const trimmed = cronExpr.trim()
  if (!trimmed) return null
  try {
    const job = new Cron(trimmed)
    const runs = job.nextRuns(n, currentDate)
    return runs.length > 0 ? runs : null
  } catch {
    return null
  }
}

/** True when the string is a non-empty 5-field cron that Croner accepts and can schedule. */
export function isCronExpressionSchedulable(raw: string): boolean {
  const s = splitCronExpression(raw)
  if (!s.ok) return false
  return getNextNCronDates(raw, 1) !== null
}

/**
 * Count how many times the job would run in (from, from + windowMs].
 * Returns null if the expression cannot be parsed.
 */
export function countRunsInWindow(cronExpr: string, windowMs: number, from: Date = new Date()): number | null {
  const trimmed = cronExpr.trim()
  if (!trimmed) return null
  const endMs = from.getTime() + windowMs
  try {
    const job = new Cron(trimmed)
    let count = 0
    let cursor: Date | null = from
    let prevTime = Number.NEGATIVE_INFINITY
    for (let i = 0; i < MAX_RUN_ITERATIONS; i++) {
      const next = job.nextRun(cursor)
      if (!next) break
      const t = next.getTime()
      if (t <= prevTime) break
      if (t > endMs) break
      count++
      prevTime = t
      cursor = new Date(t + 1)
    }
    return count
  } catch {
    return null
  }
}

/** True if the first upcoming run is strictly more than `thresholdMs` after `from`. */
export function isNextRunBeyondMs(cronExpr: string, thresholdMs: number, from: Date = new Date()): boolean | null {
  const dates = getNextNCronDates(cronExpr, 1, from)
  if (!dates?.length) return null
  return dates[0].getTime() - from.getTime() > thresholdMs
}

/** True if more than `threshold` runs occur in the first hour starting at `from`. */
export function exceedsRunsPerHourThreshold(
  cronExpr: string,
  threshold: number,
  from: Date = new Date(),
): boolean | null {
  const n = countRunsInWindow(cronExpr, MS_PER_HOUR, from)
  if (n === null) return null
  return n > threshold
}
