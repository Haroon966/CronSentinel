export function isRunSuccess(status: string) {
  const s = status.toLowerCase()
  return ['success', 'ok', 'completed'].includes(s)
}

export function isRunFailure(status: string) {
  const s = status.toLowerCase()
  return s.includes('fail') || s.includes('error')
}
