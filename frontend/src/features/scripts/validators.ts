const SCRIPT_NAME_RE = /^[a-zA-Z0-9._-]+$/

export function validateScriptName(name: string) {
  if (!name.trim()) return 'Script name is required'
  if (!SCRIPT_NAME_RE.test(name.trim())) return 'Only letters, digits, dots, hyphens, underscores'
  return ''
}
