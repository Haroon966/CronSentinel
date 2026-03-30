import { Activity, Check, Loader2, Pause, X } from 'lucide-react'
import type { ReactElement } from 'react'

import { Badge } from '@/components/ui/badge'
import { cs } from '@/lib/csTheme'
import { cn } from '@/lib/utils'

export type DashboardStatus =
  | 'healthy'
  | 'late'
  | 'failed'
  | 'never_run'
  | 'running'
  | 'paused'

type JobStatusBadgeProps = {
  status: string
  className?: string
}

function normalizeStatus(raw: string): DashboardStatus {
  const s = raw.trim().toLowerCase()
  if (s === 'healthy' || s === 'late' || s === 'failed' || s === 'never_run' || s === 'running' || s === 'paused') {
    return s
  }
  return 'never_run'
}

export function JobStatusBadge({ status, className }: JobStatusBadgeProps): ReactElement {
  const key = normalizeStatus(status)
  const base = 'gap-1 text-xs font-semibold shrink-0 border'

  switch (key) {
    case 'healthy':
      return (
        <Badge className={cn(base, cs.healthy.surface, 'hover:opacity-95', className)}>
          <Check className="h-2.5 w-2.5" aria-hidden />
          Healthy
        </Badge>
      )
    case 'late':
      return (
        <Badge className={cn(base, cs.late.surface, 'hover:opacity-95', className)}>
          <Activity className="h-2.5 w-2.5" aria-hidden />
          Late
        </Badge>
      )
    case 'failed':
      return (
        <Badge variant="destructive" className={cn(base, className)}>
          <X className="h-2.5 w-2.5" aria-hidden />
          Failed
        </Badge>
      )
    case 'running':
      return (
        <Badge
          className={cn(
            base,
            'border-[var(--cs-border-medium)] bg-[var(--cs-accent-subtle)] text-[var(--cs-accent-text)] hover:opacity-95',
            className,
          )}
        >
          <Loader2 className="h-2.5 w-2.5 motion-safe:animate-spin" aria-hidden />
          Running
        </Badge>
      )
    case 'paused':
      return (
        <Badge className={cn(base, cs.paused.surface, 'hover:opacity-95', className)}>
          <Pause className="h-2.5 w-2.5" aria-hidden />
          Paused
        </Badge>
      )
    case 'never_run':
      return (
        <Badge variant="secondary" className={cn(base, className)}>
          Never run
        </Badge>
      )
  }
}
