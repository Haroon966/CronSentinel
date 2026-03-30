import { describe, expect, it } from 'vitest'
import {
  defaultOnboardingState,
  normalizeOnboardingState,
  shouldShowOnboardingGate,
} from './onboardingStorage'

describe('normalizeOnboardingState', () => {
  it('returns default for non-object', () => {
    expect(normalizeOnboardingState(null)).toEqual(defaultOnboardingState())
    expect(normalizeOnboardingState(undefined)).toEqual(defaultOnboardingState())
    expect(normalizeOnboardingState('x')).toEqual(defaultOnboardingState())
  })

  it('returns default for wrong version', () => {
    expect(normalizeOnboardingState({ v: 2, step: 2 })).toEqual(defaultOnboardingState())
  })

  it('clamps invalid step to 1', () => {
    expect(normalizeOnboardingState({ v: 1, step: 99 }).step).toBe(1)
    expect(normalizeOnboardingState({ v: 1, step: '2' }).step).toBe(1)
  })

  it('preserves valid fields', () => {
    const s = normalizeOnboardingState({
      v: 1,
      step: 3,
      jobId: 'uuid-here',
      heartbeatToken: 'tok',
      jobName: 'Backup',
      schedule: '0 * * * *',
      skipped: false,
      completed: false,
    })
    expect(s.step).toBe(3)
    expect(s.jobId).toBe('uuid-here')
    expect(s.heartbeatToken).toBe('tok')
    expect(s.jobName).toBe('Backup')
    expect(s.schedule).toBe('0 * * * *')
  })

  it('strips empty jobId', () => {
    const s = normalizeOnboardingState({ v: 1, step: 2, jobId: '   ' })
    expect(s.jobId).toBeUndefined()
  })
})

describe('shouldShowOnboardingGate', () => {
  it('hides when completed or skipped', () => {
    expect(shouldShowOnboardingGate({ v: 1, step: 1, completed: true }, true, 0)).toBe(false)
    expect(shouldShowOnboardingGate({ v: 1, step: 1, skipped: true }, true, 0)).toBe(false)
  })

  it('hides when offline', () => {
    expect(shouldShowOnboardingGate({ v: 1, step: 1 }, false, 0)).toBe(false)
  })

  it('shows step 1 when online and no jobs', () => {
    expect(shouldShowOnboardingGate({ v: 1, step: 1 }, true, 0)).toBe(true)
  })

  it('hides step 1 when jobs exist and no resume id', () => {
    expect(shouldShowOnboardingGate({ v: 1, step: 1 }, true, 2)).toBe(false)
  })

  it('shows when resuming with jobId even if jobs list non-empty', () => {
    expect(shouldShowOnboardingGate({ v: 1, step: 2, jobId: 'a' }, true, 3)).toBe(true)
  })

  it('hides when server recorded completion or skip', () => {
    expect(shouldShowOnboardingGate({ v: 1, step: 1 }, true, 0, { completed: true, skipped: false })).toBe(false)
    expect(shouldShowOnboardingGate({ v: 1, step: 1 }, true, 0, { completed: false, skipped: true })).toBe(false)
  })
})
