/** Valid time-range options for the duration trend chart. */
export const VALID_RANGES = ['7d', '30d', '90d'] as const
export type DurationTrendRange = (typeof VALID_RANGES)[number]

/** Minimum data points required before the chart is rendered instead of the empty state. */
export const MIN_POINTS_TO_SHOW_CHART = 3

/** Runs exceeding this multiple of p95 are classified as outliers. */
export const OUTLIER_MULTIPLIER = 2

/** Formats a duration in milliseconds into a human-readable string. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`
  const m = Math.floor(ms / 60_000)
  const s = ((ms % 60_000) / 1000).toFixed(0)
  return `${m}m ${s}s`
}

/** Returns true when a run duration exceeds OUTLIER_MULTIPLIER × p95. */
export function isOutlier(durationMs: number, p95: number): boolean {
  return p95 > 0 && durationMs > OUTLIER_MULTIPLIER * p95
}
