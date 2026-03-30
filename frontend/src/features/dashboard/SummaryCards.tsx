import { Activity, AlertTriangle, CheckCircle2, LayoutList } from 'lucide-react'
import type { ReactElement } from 'react'

import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export type SummaryCounts = {
  total: number
  healthy: number
  late: number
  failed: number
}

type SummaryCardsProps = {
  counts: SummaryCounts
  className?: string
}

type CardDef = {
  key: keyof SummaryCounts
  label: string
  icon: typeof LayoutList
  accent: string
}

const CARDS: CardDef[] = [
  { key: 'total', label: 'Total jobs', icon: LayoutList, accent: 'text-foreground' },
  { key: 'healthy', label: 'Healthy', icon: CheckCircle2, accent: 'text-[var(--cs-healthy)]' },
  { key: 'late', label: 'Late', icon: Activity, accent: 'text-[var(--cs-late)]' },
  { key: 'failed', label: 'Failed', icon: AlertTriangle, accent: 'text-[var(--cs-failed)]' },
]

export function SummaryCards({ counts, className }: SummaryCardsProps): ReactElement {
  return (
    <div
      className={cn('grid grid-cols-2 gap-3 lg:grid-cols-4', className)}
      role="region"
      aria-label="Job status summary"
    >
      {CARDS.map(({ key, label, icon: Icon, accent }) => (
        <Card key={key} className="border-border/60 shadow-none">
          <CardContent className="flex items-center gap-3 p-4">
            <div className={cn('rounded-md bg-muted/80 p-2', accent)}>
              <Icon className="h-4 w-4" aria-hidden />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
              <p className="text-xl font-bold tabular-nums tracking-tight">{counts[key]}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
