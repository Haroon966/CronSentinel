import { describe, expect, it } from 'vitest'
import {
  CUSTOM_SELECT_VALUE,
  composeCronExpression,
  countRunsInWindow,
  exceedsRunsPerHourThreshold,
  fieldSelectValue,
  getNextNCronDates,
  HIGH_FREQUENCY_RUNS_PER_HOUR_THRESHOLD,
  isCronExpressionSchedulable,
  isNextRunBeyondMs,
  splitCronExpression,
} from './cronFields'

describe('splitCronExpression', () => {
  it('parses five fields', () => {
    const r = splitCronExpression('*/5 * * * *')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.parts).toEqual(['*/5', '*', '*', '*', '*'])
  })

  it('rejects wrong field count', () => {
    expect(splitCronExpression('* * * *').ok).toBe(false)
    expect(splitCronExpression('').ok).toBe(false)
  })
})

describe('composeCronExpression', () => {
  it('joins parts with spaces', () => {
    expect(composeCronExpression(['0', '9', '*', '*', '1'])).toBe('0 9 * * 1')
  })
})

describe('fieldSelectValue', () => {
  it('returns token when in presets', () => {
    expect(fieldSelectValue('*', ['*', '0'])).toBe('*')
  })

  it('returns custom sentinel when not listed', () => {
    expect(fieldSelectValue('*/7', ['*', '0'])).toBe(CUSTOM_SELECT_VALUE)
  })
})

describe('getNextNCronDates', () => {
  it('returns five future instants for hourly cron', () => {
    const anchor = new Date('2026-03-29T12:30:00.000Z')
    const dates = getNextNCronDates('0 * * * *', 5, anchor)
    expect(dates).not.toBeNull()
    expect(dates).toHaveLength(5)
    if (!dates) return
    expect(dates[0].getUTCHours()).toBe(13)
    expect(dates[0].getUTCMinutes()).toBe(0)
  })

  it('returns null for garbage', () => {
    expect(getNextNCronDates('not a cron', 3)).toBeNull()
  })
})

describe('isCronExpressionSchedulable', () => {
  it('accepts valid five-field expressions', () => {
    expect(isCronExpressionSchedulable('0 * * * *')).toBe(true)
  })

  it('rejects invalid expressions', () => {
    expect(isCronExpressionSchedulable('99 99 99 99 99')).toBe(false)
  })
})

describe('countRunsInWindow', () => {
  it('counts about 60 minute marks in a 60-minute window for every-minute cron', () => {
    const from = new Date('2026-03-29T12:30:45.000Z')
    const n = countRunsInWindow('* * * * *', 60 * 60 * 1000, from)
    expect(n).not.toBeNull()
    expect(n).toBeGreaterThanOrEqual(59)
    expect(n).toBeLessThanOrEqual(61)
  })

  it('returns null for invalid cron', () => {
    expect(countRunsInWindow('not valid', 3600_000)).toBeNull()
  })
})

describe('isNextRunBeyondMs', () => {
  it('returns true when next run is after threshold', () => {
    const from = new Date('2026-03-29T12:00:00.000Z')
    const r = isNextRunBeyondMs('0 0 1 * *', 24 * 60 * 60 * 1000, from)
    expect(r).toBe(true)
  })

  it('returns null when expression is invalid', () => {
    expect(isNextRunBeyondMs('x y z', 1000)).toBeNull()
  })
})

describe('exceedsRunsPerHourThreshold', () => {
  it('detects sub-minute cadence when six fields are used', () => {
    const from = new Date('2026-03-29T12:00:00.000Z')
    const hot = exceedsRunsPerHourThreshold('*/30 * * * * *', HIGH_FREQUENCY_RUNS_PER_HOUR_THRESHOLD, from)
    expect(hot).toBe(true)
  })

  it('does not flag standard every-minute schedule', () => {
    const from = new Date('2026-03-29T12:00:00.000Z')
    expect(exceedsRunsPerHourThreshold('* * * * *', HIGH_FREQUENCY_RUNS_PER_HOUR_THRESHOLD, from)).toBe(false)
  })
})
