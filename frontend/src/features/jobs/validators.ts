const CRON_RE = /^(\S+\s+){4}\S+$/

export function validateCron(schedule: string) {
  if (!schedule.trim()) return 'Schedule is required'
  if (!CRON_RE.test(schedule.trim())) return '5 space-separated cron fields required'
  return ''
}

export function validateJobName(name: string) {
  return name.trim() ? '' : 'Job name is required'
}

export function validateCommand(command: string) {
  return command.trim() ? '' : 'Command is required'
}
