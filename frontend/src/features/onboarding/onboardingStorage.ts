/** Versioned persistence for FEAT-11 wizard (resume, skip, complete). */
export const ONBOARDING_STORAGE_KEY = 'cronsentinel-onboarding-v1'

export type OnboardingStep = 1 | 2 | 3 | 4

export type OnboardingState = {
  v: 1
  step: OnboardingStep
  jobId?: string
  heartbeatToken?: string
  jobName?: string
  schedule?: string
  skipped?: boolean
  completed?: boolean
}

export function defaultOnboardingState(): OnboardingState {
  return { v: 1, step: 1 }
}

function isStep(n: unknown): n is OnboardingStep {
  return n === 1 || n === 2 || n === 3 || n === 4
}

/** Normalize parsed JSON into a valid state (for tests and recovery from corrupt storage). */
export function normalizeOnboardingState(raw: unknown): OnboardingState {
  if (raw == null || typeof raw !== 'object') return defaultOnboardingState()
  const o = raw as Record<string, unknown>
  if (o.v !== 1) return defaultOnboardingState()
  const step = isStep(o.step) ? o.step : 1
  const jobId = typeof o.jobId === 'string' && o.jobId.trim() ? o.jobId.trim() : undefined
  const heartbeatToken =
    typeof o.heartbeatToken === 'string' && o.heartbeatToken.trim() ? o.heartbeatToken.trim() : undefined
  const jobName = typeof o.jobName === 'string' ? o.jobName : undefined
  const schedule = typeof o.schedule === 'string' ? o.schedule : undefined
  return {
    v: 1,
    step,
    jobId,
    heartbeatToken,
    jobName,
    schedule,
    skipped: o.skipped === true,
    completed: o.completed === true,
  }
}

export function getOnboardingState(): OnboardingState {
  try {
    const raw = localStorage.getItem(ONBOARDING_STORAGE_KEY)
    if (raw == null || raw === '') return defaultOnboardingState()
    const parsed: unknown = JSON.parse(raw)
    return normalizeOnboardingState(parsed)
  } catch {
    return defaultOnboardingState()
  }
}

export function setOnboardingState(next: OnboardingState): void {
  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* quota / private mode */
  }
}

export function updateOnboardingState(partial: Partial<OnboardingState>): void {
  const cur = getOnboardingState()
  setOnboardingState({ ...cur, ...partial, v: 1 })
}

export function markOnboardingSkipped(): void {
  updateOnboardingState({ skipped: true })
}

export function markOnboardingCompleted(): void {
  updateOnboardingState({ completed: true, step: 4 })
}

export function resetOnboardingJobProgress(): void {
  updateOnboardingState({
    step: 1,
    jobId: undefined,
    heartbeatToken: undefined,
  })
}

/**
 * Whether the wizard should be visible.
 * Show for first-time setup when there are no jobs, or when resuming mid-wizard (jobId set).
 * Requires a successful jobs fetch (caller passes apiOnline === true).
 */
export function shouldShowOnboardingGate(
  state: OnboardingState,
  apiOnline: boolean,
  jobsLength: number,
  server?: { completed: boolean; skipped: boolean } | null,
): boolean {
  if (server?.completed || server?.skipped) return false
  if (state.completed || state.skipped) return false
  if (!apiOnline) return false
  if (state.jobId) return true
  return jobsLength === 0
}
