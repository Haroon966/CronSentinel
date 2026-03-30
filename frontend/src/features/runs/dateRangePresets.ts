/** URL / UI preset for run history date window (FEAT-05). */
export type RunsRangePreset = 'all' | '7d' | '30d' | '90d' | 'custom'

export const VALID_RUNS_RANGE_PRESETS: RunsRangePreset[] = ['all', '7d', '30d', '90d', 'custom']

export function parseRunsRangePreset(raw: string | null): RunsRangePreset {
  const s = (raw ?? '').trim().toLowerCase()
  if (s === '7d' || s === '30d' || s === '90d' || s === 'custom' || s === 'all') return s
  return 'all'
}

/** Rolling window [startedAfter, startedBefore] as ISO strings (UTC). `all` clears both. */
export function rangeFromPreset(preset: RunsRangePreset, now: Date = new Date()): { startedAfter: string; startedBefore: string } {
  if (preset === 'all' || preset === 'custom') {
    return { startedAfter: '', startedBefore: '' }
  }
  const before = now.toISOString()
  const ms =
    preset === '7d' ? 7 * 24 * 60 * 60 * 1000 : preset === '30d' ? 30 * 24 * 60 * 60 * 1000 : 90 * 24 * 60 * 60 * 1000
  const after = new Date(now.getTime() - ms).toISOString()
  return { startedAfter: after, startedBefore: before }
}
