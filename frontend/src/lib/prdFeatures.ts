/**
 * Single source of truth for PRD backlog status in the UI.
 * Keep in sync with `cronsentinel-prd.md` Feature Backlog checkboxes.
 */
import type { Tab } from '@/lib/urlRouting'

export const PRD_FILE = 'cronsentinel-prd.md'
export const AGENT_FILE = 'cursor-agent.md'

export type PrdTier = 'mvp' | 'v2' | 'v3'

export type PrdFeature = {
  id: string
  name: string
  tier: PrdTier
  category: string
  priority: string
  done: boolean
}

/** Mirrors `## Feature Backlog` in cronsentinel-prd.md (FEAT-01 … FEAT-50). */
export const PRD_FEATURES: readonly PrdFeature[] = [
  { id: 'FEAT-01', name: 'Heartbeat Monitoring', tier: 'mvp', category: 'Monitoring', priority: 'MVP', done: true },
  { id: 'FEAT-02', name: 'Absence-Based Alerting', tier: 'mvp', category: 'Monitoring', priority: 'MVP', done: true },
  { id: 'FEAT-03', name: 'Execution Log Capture', tier: 'mvp', category: 'Monitoring', priority: 'MVP', done: true },
  { id: 'FEAT-04', name: 'Live Status Dashboard', tier: 'mvp', category: 'Monitoring', priority: 'MVP', done: true },
  { id: 'FEAT-05', name: 'Execution History Log', tier: 'mvp', category: 'Monitoring', priority: 'MVP', done: true },
  { id: 'FEAT-06', name: 'Daemon & Server Heartbeat', tier: 'mvp', category: 'Reliability', priority: 'MVP', done: true },
  { id: 'FEAT-07', name: 'Crontab Change Detection', tier: 'mvp', category: 'Reliability', priority: 'MVP', done: true },
  { id: 'FEAT-08', name: 'Job Timeout & Kill Switch', tier: 'mvp', category: 'Reliability', priority: 'MVP', done: true },
  { id: 'FEAT-09', name: 'Visual Cron Builder', tier: 'mvp', category: 'UX', priority: 'MVP', done: true },
  { id: 'FEAT-10', name: 'Next-Run Previewer', tier: 'mvp', category: 'UX', priority: 'MVP', done: true },
  { id: 'FEAT-11', name: '60-Second Onboarding', tier: 'mvp', category: 'UX', priority: 'MVP', done: true },
  { id: 'FEAT-12', name: 'No-Redeploy Schedule Editor', tier: 'mvp', category: 'UX', priority: 'MVP', done: true },
  { id: 'FEAT-13', name: 'Secure Env Variable Manager', tier: 'mvp', category: 'Security', priority: 'MVP', done: true },
  { id: 'FEAT-14', name: 'Multi-Channel Alert Integrations', tier: 'mvp', category: 'Integrations', priority: 'MVP', done: true },
  { id: 'FEAT-15', name: 'REST API', tier: 'mvp', category: 'Integrations', priority: 'MVP', done: true },
  { id: 'FEAT-16', name: 'Predictable Flat Pricing', tier: 'mvp', category: 'DevX', priority: 'MVP', done: true },
  { id: 'FEAT-17', name: 'Runtime Duration Trends', tier: 'v2', category: 'Monitoring', priority: 'V2', done: true },
  { id: 'FEAT-18', name: 'SLA Window Tracking', tier: 'v2', category: 'Monitoring', priority: 'V2', done: false },
  { id: 'FEAT-19', name: 'Smart Alert Deduplication', tier: 'v2', category: 'Monitoring', priority: 'V2', done: false },
  { id: 'FEAT-20', name: 'Runtime Anomaly Detection', tier: 'v2', category: 'Monitoring', priority: 'V2', done: false },
  { id: 'FEAT-21', name: 'Concurrency Guard', tier: 'v2', category: 'Reliability', priority: 'V2', done: false },
  { id: 'FEAT-22', name: 'DST-Safe Scheduler', tier: 'v2', category: 'Reliability', priority: 'V2', done: false },
  { id: 'FEAT-23', name: 'Clock Drift Detection', tier: 'v2', category: 'Reliability', priority: 'V2', done: false },
  { id: 'FEAT-24', name: 'Auto-Retry with Backoff', tier: 'v2', category: 'Reliability', priority: 'V2', done: false },
  { id: 'FEAT-25', name: 'Late-Start Detection', tier: 'v2', category: 'Reliability', priority: 'V2', done: false },
  { id: 'FEAT-26', name: 'Missed-Run Counter & Alert', tier: 'v2', category: 'Reliability', priority: 'V2', done: false },
  { id: 'FEAT-27', name: 'Job Pileup Guard', tier: 'v2', category: 'Reliability', priority: 'V2', done: false },
  { id: 'FEAT-28', name: 'Host Resource Monitor', tier: 'v2', category: 'Reliability', priority: 'V2', done: false },
  { id: 'FEAT-29', name: 'Job Config Version History', tier: 'v2', category: 'Reliability', priority: 'V2', done: false },
  { id: 'FEAT-30', name: 'Global Search', tier: 'v2', category: 'UX', priority: 'V2', done: false },
  { id: 'FEAT-31', name: 'Mobile Alerts & Responsive UI', tier: 'v2', category: 'UX', priority: 'V2', done: false },
  { id: 'FEAT-32', name: 'Job Pause / Suspend Mode', tier: 'v2', category: 'UX', priority: 'V2', done: false },
  { id: 'FEAT-33', name: 'Wrong User Context Validator', tier: 'v2', category: 'Security', priority: 'V2', done: false },
  { id: 'FEAT-34', name: 'Secret Masking in Logs & UI', tier: 'v2', category: 'Security', priority: 'V2', done: false },
  { id: 'FEAT-35', name: 'Role-Based Access Control', tier: 'v2', category: 'Security', priority: 'V2', done: false },
  { id: 'FEAT-36', name: 'Immutable Audit Log', tier: 'v2', category: 'Security', priority: 'V2', done: false },
  { id: 'FEAT-37', name: 'On-Call Schedule Routing', tier: 'v2', category: 'Integrations', priority: 'V2', done: false },
  { id: 'FEAT-38', name: 'Inbound Webhook Trigger', tier: 'v2', category: 'Integrations', priority: 'V2', done: false },
  { id: 'FEAT-39', name: 'Configurable Log Retention', tier: 'v2', category: 'DevX', priority: 'V2', done: false },
  { id: 'FEAT-40', name: 'Multi-Environment Workspaces', tier: 'v2', category: 'DevX', priority: 'V2', done: false },
  { id: 'FEAT-41', name: 'Job Health Heatmap', tier: 'v3', category: 'Monitoring', priority: 'V3', done: false },
  { id: 'FEAT-42', name: 'External Concurrency Lock', tier: 'v3', category: 'Reliability', priority: 'V3', done: false },
  { id: 'FEAT-43', name: 'Cloud-Native External Trigger', tier: 'v3', category: 'Reliability', priority: 'V3', done: false },
  { id: 'FEAT-44', name: 'Job Template Library', tier: 'v3', category: 'UX', priority: 'V3', done: false },
  { id: 'FEAT-45', name: 'Public Status Page & Badge', tier: 'v3', category: 'UX', priority: 'V3', done: false },
  { id: 'FEAT-46', name: 'Crontab Tampering Detection', tier: 'v3', category: 'Security', priority: 'V3', done: false },
  { id: 'FEAT-47', name: 'Kubernetes CronJob Integration', tier: 'v3', category: 'Integrations', priority: 'V3', done: false },
  { id: 'FEAT-48', name: 'OpenTelemetry Export', tier: 'v3', category: 'Integrations', priority: 'V3', done: false },
  { id: 'FEAT-49', name: 'Compliance Audit Reports', tier: 'v3', category: 'DevX', priority: 'V3', done: false },
  { id: 'FEAT-50', name: 'Job Dependency Chains', tier: 'v3', category: 'DevX', priority: 'V3', done: false },
] as const

export type AppScreenTab = Exclude<Tab, 'roadmap'>

/** Which PRD features each main UI area primarily implements (for labels and discovery). */
export const UI_TAB_PRD_FEATURES: Record<AppScreenTab, readonly string[]> = {
  dashboard: ['FEAT-04'],
  jobs: ['FEAT-01', 'FEAT-02', 'FEAT-07', 'FEAT-08', 'FEAT-09', 'FEAT-10', 'FEAT-12', 'FEAT-13'],
  scripts: ['FEAT-15'],
  runs: ['FEAT-03', 'FEAT-05', 'FEAT-17'],
  servers: ['FEAT-06', 'FEAT-07'],
  settings: ['FEAT-11', 'FEAT-14', 'FEAT-15', 'FEAT-16'],
}

/** Shown on first launch / wizard — not tied to a single tab. */
export const PRD_GLOBAL_ONBOARDING_FEATURE = 'FEAT-11'

export const AGENT_SESSION_STEPS: readonly string[] = [
  `Read ${PRD_FILE} in full before other work.`,
  'Pick the first unchecked item in the Feature Backlog — only one feature per session.',
  'Plan (files, schema, API, UI, tests, edge cases); get approval if non-trivial.',
  'Implement with tests and the checklist in the agent doc.',
  `Update ${PRD_FILE}: mark the item done and append to Completed Features.`,
  'Report changes, how to test, and follow-ups.',
]

export function getPrdProgress(): { completed: number; total: number; pending: number } {
  const total = PRD_FEATURES.length
  const completed = PRD_FEATURES.filter(f => f.done).length
  return { completed, total, pending: total - completed }
}

export function prdFeatureById(id: string): PrdFeature | undefined {
  return PRD_FEATURES.find(f => f.id === id)
}
