/** CronSentinel design tokens (see cursor-ui-agent.md) — use with `cn()`. */
export const cs = {
  healthy: {
    surface: 'bg-[var(--cs-healthy-bg)] border-[var(--cs-healthy-border)] text-[var(--cs-healthy-text)]',
    dot: 'bg-[var(--cs-healthy)]',
    text: 'text-[var(--cs-healthy-text)]',
    icon: 'text-[var(--cs-healthy)]',
  },
  late: {
    surface: 'bg-[var(--cs-late-bg)] border-[var(--cs-late-border)] text-[var(--cs-late-text)]',
    dot: 'bg-[var(--cs-late)]',
    text: 'text-[var(--cs-late-text)]',
    icon: 'text-[var(--cs-late)]',
  },
  failed: {
    surface: 'bg-[var(--cs-failed-bg)] border-[var(--cs-failed-border)] text-[var(--cs-failed-text)]',
    dot: 'bg-[var(--cs-failed)]',
    text: 'text-[var(--cs-failed-text)]',
    icon: 'text-[var(--cs-failed)]',
  },
  paused: {
    surface: 'bg-[var(--cs-paused-bg)] border-[var(--cs-paused-border)] text-[var(--cs-paused-text)]',
    dot: 'bg-[var(--cs-paused)]',
    text: 'text-[var(--cs-paused-text)]',
    icon: 'text-[var(--cs-paused)]',
  },
  pending: {
    surface: 'bg-[var(--cs-pending-bg)] border-[var(--cs-pending-border)] text-[var(--cs-pending-text)]',
    dot: 'bg-[var(--cs-pending)]',
    text: 'text-[var(--cs-pending-text)]',
  },
} as const
