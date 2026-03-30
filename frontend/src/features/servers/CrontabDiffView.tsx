import type { ReactElement } from 'react'

type CrontabDiffViewProps = {
  diff: string
}

/** Renders unified-style line diff (+ / - / context) with Tailwind highlights. */
export function CrontabDiffView({ diff }: CrontabDiffViewProps): ReactElement {
  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  return (
    <pre
      className="mt-1 max-h-64 overflow-auto rounded-md border border-border/60 bg-[var(--cs-bg-sunken)] p-2 font-mono text-xs leading-relaxed text-foreground"
      role="region"
      aria-label="Crontab diff"
    >
      {lines.map((line, i) => {
        if (line.startsWith('+ ')) {
          return (
            <div key={i} className="whitespace-pre-wrap break-all bg-[var(--cs-healthy-bg)] text-[var(--cs-healthy-text)]">
              + {line.slice(2)}
            </div>
          )
        }
        if (line.startsWith('- ')) {
          return (
            <div
              key={i}
              className="whitespace-pre-wrap break-all bg-[var(--cs-failed-bg)] text-[var(--cs-failed-text)] line-through decoration-[var(--cs-failed-border)]"
            >
              - {line.slice(2)}
            </div>
          )
        }
        return (
          <div key={i} className="whitespace-pre-wrap break-all text-muted-foreground">
            {line}
          </div>
        )
      })}
    </pre>
  )
}
