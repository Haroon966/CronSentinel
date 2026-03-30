import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { AlertTriangle, CalendarClock } from 'lucide-react'

import {
  exceedsRunsPerHourThreshold,
  getNextNCronDates,
  HIGH_FREQUENCY_RUNS_PER_HOUR_THRESHOLD,
  isNextRunBeyondMs,
  NEXT_RUN_PREVIEW_COUNT,
  NEXT_RUN_PREVIEW_DEBOUNCE_MS,
  NEXT_RUN_WARN_MIN_GAP_MS,
} from '@/features/jobs/cronFields'

function formatUtcMediumShort(d: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: 'UTC',
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZoneName: 'short',
  }).format(d)
}

function formatLocalMediumShort(d: Date): string {
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * Shows the next N cron fire times (local + UTC), debounced, with PRD FEAT-10 warnings.
 * Safe for invalid expressions (no throw).
 */
export function NextRunPreviewer({
  expression,
  idPrefix,
}: {
  expression: string
  idPrefix: string
}): ReactElement {
  const [debounced, setDebounced] = useState(expression)

  useEffect(() => {
    const timerId = window.setTimeout(() => {
      setDebounced(expression)
    }, NEXT_RUN_PREVIEW_DEBOUNCE_MS)
    return () => window.clearTimeout(timerId)
  }, [expression])

  const pending = expression !== debounced
  const trimmed = debounced.trim()
  const preview = useMemo(() => {
    if (!trimmed) {
      return { kind: 'empty' as const }
    }
    const dates = getNextNCronDates(trimmed, NEXT_RUN_PREVIEW_COUNT)
    if (!dates?.length) {
      return { kind: 'invalid' as const }
    }
    const now = new Date()
    const gapWarn = isNextRunBeyondMs(trimmed, NEXT_RUN_WARN_MIN_GAP_MS, now) === true
    const freqWarn = exceedsRunsPerHourThreshold(trimmed, HIGH_FREQUENCY_RUNS_PER_HOUR_THRESHOLD, now) === true
    return { kind: 'ok' as const, dates, gapWarn, freqWarn }
  }, [trimmed])

  const sectionId = `${idPrefix}-next-preview`
  const listId = `${idPrefix}-next-preview-list`

  return (
    <div
      id={sectionId}
      className={`rounded border border-border/40 bg-card px-2.5 py-2 ${pending ? 'opacity-70' : ''}`}
      aria-busy={pending}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1 text-xs font-semibold text-muted-foreground">
          <CalendarClock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Next {NEXT_RUN_PREVIEW_COUNT} runs
        </p>
        {pending ? (
          <span className="text-xs text-muted-foreground tabular-nums">Updating…</span>
        ) : null}
      </div>

      {preview.kind === 'empty' && (
        <p className="text-xs text-muted-foreground">Enter a schedule to see upcoming run times.</p>
      )}

      {preview.kind === 'invalid' && trimmed && (
        <p
          id={`${idPrefix}-next-preview-invalid`}
          role="alert"
          className="flex items-start gap-1 text-xs text-destructive"
        >
          <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" aria-hidden="true" />
          Cannot compute schedule — check the cron expression.
        </p>
      )}

      {preview.kind === 'ok' && (
        <>
          {(preview.gapWarn || preview.freqWarn) && (
            <ul className="mb-1.5 list-none space-y-0.5" role="list">
              {preview.gapWarn && (
                <li
                  className="flex items-start gap-1 text-xs text-[var(--cs-late-text)]"
                  role="status"
                >
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-[var(--cs-late)]" aria-hidden="true" />
                  First run is more than 24 hours away.
                </li>
              )}
              {preview.freqWarn && (
                <li
                  className="flex items-start gap-1 text-xs text-[var(--cs-late-text)]"
                  role="status"
                >
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-[var(--cs-late)]" aria-hidden="true" />
                  More than {HIGH_FREQUENCY_RUNS_PER_HOUR_THRESHOLD} runs per hour — very frequent.
                </li>
              )}
            </ul>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[16rem] border-collapse text-left text-xs" aria-labelledby={sectionId}>
              <caption className="sr-only">Upcoming run times in your local timezone and in UTC</caption>
              <thead>
                <tr className="border-b border-border/50 text-muted-foreground">
                  <th scope="col" className="py-0.5 pr-2 font-medium">
                    #
                  </th>
                  <th scope="col" className="py-0.5 pr-2 font-medium">
                    Local
                  </th>
                  <th scope="col" className="py-0.5 font-medium">
                    UTC
                  </th>
                </tr>
              </thead>
              <tbody id={listId}>
                {preview.dates.map((d, i) => (
                  <tr key={`${d.getTime()}-${i}`} className="border-b border-border/30 font-mono text-foreground last:border-0">
                    <th scope="row" className="py-0.5 pr-2 font-normal text-muted-foreground">
                      {i + 1}
                    </th>
                    <td className="py-0.5 pr-2 whitespace-nowrap">{formatLocalMediumShort(d)}</td>
                    <td className="py-0.5 whitespace-nowrap">{formatUtcMediumShort(d)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
