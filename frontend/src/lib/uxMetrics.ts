const KEY = 'cronsentinel-ux-metrics'

type MetricStore = {
  jobCreateStartAt?: number
  totals: {
    jobsCreated: number
    jobsRun: number
    logsOpened: number
  }
  samples: {
    timeToCreateJobMs: number[]
    timeToOpenLogsMs: number[]
  }
}

function readStore(): MetricStore {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<MetricStore>
    return {
      jobCreateStartAt: parsed.jobCreateStartAt,
      totals: {
        jobsCreated: parsed.totals?.jobsCreated ?? 0,
        jobsRun: parsed.totals?.jobsRun ?? 0,
        logsOpened: parsed.totals?.logsOpened ?? 0,
      },
      samples: {
        timeToCreateJobMs: parsed.samples?.timeToCreateJobMs ?? [],
        timeToOpenLogsMs: parsed.samples?.timeToOpenLogsMs ?? [],
      },
    }
  } catch {
    return { totals: { jobsCreated: 0, jobsRun: 0, logsOpened: 0 }, samples: { timeToCreateJobMs: [], timeToOpenLogsMs: [] } }
  }
}

function writeStore(next: MetricStore) {
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Best effort only.
  }
}

function pushSample(arr: number[], value: number): number[] {
  const out = [...arr, value]
  return out.slice(Math.max(0, out.length - 30))
}

export function markJobCreateStarted() {
  const store = readStore()
  store.jobCreateStartAt = Date.now()
  writeStore(store)
}

export function markJobCreated() {
  const store = readStore()
  store.totals.jobsCreated += 1
  if (store.jobCreateStartAt) {
    const elapsed = Date.now() - store.jobCreateStartAt
    store.samples.timeToCreateJobMs = pushSample(store.samples.timeToCreateJobMs, elapsed)
    delete store.jobCreateStartAt
  }
  writeStore(store)
}

export function markJobRunStarted() {
  const store = readStore()
  store.totals.jobsRun += 1
  writeStore(store)
}

export function markLogsOpened(openStartedAt: number) {
  const store = readStore()
  store.totals.logsOpened += 1
  const elapsed = Date.now() - openStartedAt
  store.samples.timeToOpenLogsMs = pushSample(store.samples.timeToOpenLogsMs, elapsed)
  writeStore(store)
}

export function getUxMetricsSnapshot() {
  const store = readStore()
  const avg = (vals: number[]) => (vals.length === 0 ? 0 : Math.round(vals.reduce((a, b) => a + b, 0) / vals.length))
  return {
    ...store.totals,
    avgCreateMs: avg(store.samples.timeToCreateJobMs),
    avgOpenLogsMs: avg(store.samples.timeToOpenLogsMs),
  }
}
