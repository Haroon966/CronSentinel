/** Canonical paths per PRD: /dashboard, /jobs, /runs, /jobs/:jobId/history for filtered run history. */

export type Tab = 'dashboard' | 'jobs' | 'scripts' | 'runs' | 'servers' | 'settings'

/** Map pathname to tab + optional job filter for run history. */
export function parsePathname(pathname: string): { tab: Tab; runsJobId: string } {
  const p = pathname.replace(/\/+$/, '') || '/'
  const historyMatch = /^\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/history$/i.exec(p)
  if (historyMatch) {
    return { tab: 'runs', runsJobId: historyMatch[1] }
  }
  switch (p) {
    case '/dashboard':
      return { tab: 'dashboard', runsJobId: '' }
    case '/jobs':
      return { tab: 'jobs', runsJobId: '' }
    case '/scripts':
      return { tab: 'scripts', runsJobId: '' }
    case '/runs':
      return { tab: 'runs', runsJobId: '' }
    case '/servers':
      return { tab: 'servers', runsJobId: '' }
    case '/settings':
      return { tab: 'settings', runsJobId: '' }
    case '/':
    default:
      return { tab: 'jobs', runsJobId: '' }
  }
}

/** Build pathname for current tab; run history with a job uses /jobs/:id/history. */
export function buildPathname(activeTab: Tab, runsJobId: string): string {
  if (activeTab === 'runs' && runsJobId.trim()) {
    return `/jobs/${runsJobId.trim()}/history`
  }
  const map: Record<Tab, string> = {
    dashboard: '/dashboard',
    jobs: '/jobs',
    scripts: '/scripts',
    runs: '/runs',
    servers: '/servers',
    settings: '/settings',
  }
  return map[activeTab]
}
