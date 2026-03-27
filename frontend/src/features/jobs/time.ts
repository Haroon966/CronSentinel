export function cronMatch(field: string, val: number) {
  if (field === '*') return true
  if (field.startsWith('*/')) {
    const n = Number.parseInt(field.slice(2), 10)
    return Number.isFinite(n) && n > 0 && val % n === 0
  }
  return field.split(',').some((p) => Number.parseInt(p.trim(), 10) === val)
}

export function matchesCron(spec: string, now: Date) {
  const fields = spec.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const [min, hr, day, mon, dow] = fields
  return (
    cronMatch(min, now.getMinutes()) &&
    cronMatch(hr, now.getHours()) &&
    cronMatch(day, now.getDate()) &&
    cronMatch(mon, now.getMonth() + 1) &&
    cronMatch(dow, now.getDay())
  )
}

function toTzDate(d: Date, timezone: string): Date {
  if (!timezone || timezone === 'Local') return d
  const s = d.toLocaleString('en-US', { timeZone: timezone })
  return new Date(s)
}

export function nextRunFromCron(spec: string, timezone: string) {
  const start = new Date()
  const base = new Date(start)
  base.setSeconds(0, 0)
  base.setMinutes(base.getMinutes() + 1)

  for (let i = 0; i < 60 * 24 * 366; i += 1) {
    const probe = new Date(base.getTime() + i * 60_000)
    const wall = toTzDate(probe, timezone)
    if (matchesCron(spec, wall)) return probe
  }
  return null
}

export function formatCountdown(target: Date) {
  const ms = target.getTime() - Date.now()
  if (ms <= 0) return 'now'
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}
