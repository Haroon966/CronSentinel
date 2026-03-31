import { describe, expect, it } from 'vitest'
import {
  formatDuration,
  isOutlier,
  MIN_POINTS_TO_SHOW_CHART,
  OUTLIER_MULTIPLIER,
  VALID_RANGES,
} from './durationTrendUtils'

describe('VALID_RANGES', () => {
  it('contains exactly 7d, 30d, 90d', () => {
    expect(VALID_RANGES).toEqual(['7d', '30d', '90d'])
  })
})

describe('MIN_POINTS_TO_SHOW_CHART', () => {
  it('requires at least 3 points', () => {
    expect(MIN_POINTS_TO_SHOW_CHART).toBe(3)
  })
})

describe('OUTLIER_MULTIPLIER', () => {
  it('is 2 (2× p95 threshold)', () => {
    expect(OUTLIER_MULTIPLIER).toBe(2)
  })
})

describe('formatDuration', () => {
  it('formats sub-second values in ms', () => {
    expect(formatDuration(0)).toBe('0 ms')
    expect(formatDuration(999)).toBe('999 ms')
    expect(formatDuration(500)).toBe('500 ms')
  })

  it('formats 1–59 second values in seconds', () => {
    expect(formatDuration(1000)).toBe('1.00 s')
    expect(formatDuration(1500)).toBe('1.50 s')
    expect(formatDuration(59_999)).toBe('60.00 s')
  })

  it('formats 1+ minute values as m+s', () => {
    expect(formatDuration(60_000)).toBe('1m 0s')
    expect(formatDuration(90_000)).toBe('1m 30s')
    expect(formatDuration(3_600_000)).toBe('60m 0s')
  })
})

describe('isOutlier', () => {
  it('returns false when p95 is 0 (no baseline yet)', () => {
    expect(isOutlier(10_000, 0)).toBe(false)
  })

  it('returns false for a run exactly at 2× p95', () => {
    // Boundary: > not >= , so exactly 2× is NOT an outlier.
    expect(isOutlier(2000, 1000)).toBe(false)
  })

  it('returns true for a run exceeding 2× p95', () => {
    expect(isOutlier(2001, 1000)).toBe(true)
  })

  it('returns false for a normal fast run', () => {
    expect(isOutlier(500, 1000)).toBe(false)
  })

  it('returns true for an extreme outlier', () => {
    // p95 = 5s, run = 60s → 12× p95
    expect(isOutlier(60_000, 5_000)).toBe(true)
  })

  it('returns false when duration equals p95', () => {
    expect(isOutlier(1000, 1000)).toBe(false)
  })
})
