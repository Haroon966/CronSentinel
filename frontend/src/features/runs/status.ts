export function isRunSuccess(status: string) {
  const s = status.toLowerCase()
  return ['success', 'ok', 'completed'].includes(s)
}

/** True when the run hit the configured execution timeout (distinct from exit-code failure). */
export function isRunTimedOut(status: string) {
  return status.toLowerCase() === 'timed_out'
}

export function isRunFailure(status: string) {
  const s = status.toLowerCase()
  return s.includes('fail') || s.includes('error') || isRunTimedOut(status)
}
