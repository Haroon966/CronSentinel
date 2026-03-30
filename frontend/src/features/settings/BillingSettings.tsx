import { useEffect, useState } from 'react'
import { AlertTriangle, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { API_BASE_URL, apiFetch, getFetchErrorMessage } from '@/lib/api'

export type BillingDTO = {
  plan_slug: string
  plan_display_name: string
  plan_source: string
  max_monitors: number
  max_alerts_per_month: number
  monitors_used: number
  alerts_sent_this_month: number
  monitors_utilization: number
  alerts_utilization: number
  upgrade_url: string
  available_plan_slugs: string[]
}

type BillingSettingsProps = {
  billing: BillingDTO | null
  loading: boolean
  loadError: string | null
  onRefresh: () => void | Promise<void>
  onPlanSaved?: () => void | Promise<void>
}

export function BillingSettings({ billing, loading, loadError, onRefresh, onPlanSaved }: BillingSettingsProps) {
  const [planDraft, setPlanDraft] = useState<string>('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setPlanDraft('')
  }, [billing?.plan_slug])

  const effectiveDraft = planDraft || billing?.plan_slug || ''

  if (loading && !billing) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Plan &amp; usage</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
          Loading billing…
        </CardContent>
      </Card>
    )
  }

  if (loadError && !billing) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Plan &amp; usage</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-destructive">{loadError}</p>
          <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => void onRefresh()}>
            <RefreshCw className="h-3.5 w-3.5 mr-1" aria-hidden />
            Retry
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (!billing) return null

  const savePlan = async (): Promise<void> => {
    const slug = effectiveDraft.trim()
    if (!slug) return
    setSaving(true)
    try {
      const res = await apiFetch<{ billing?: BillingDTO }>(`${API_BASE_URL}/api/settings/billing`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_slug: slug }),
      })
      toast.success('Plan updated', { description: res.billing?.plan_display_name ?? slug })
      await onPlanSaved?.()
    } catch (e) {
      toast.error('Could not update plan', { description: getFetchErrorMessage(e) })
    } finally {
      setSaving(false)
    }
  }

  const nearLimit =
    billing.max_monitors > 0 &&
    billing.max_alerts_per_month > 0 &&
    (billing.monitors_utilization >= 0.8 || billing.alerts_utilization >= 0.8)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          Plan &amp; usage
          {nearLimit ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-3 w-3" aria-hidden />
              Near limit
            </span>
          ) : null}
        </CardTitle>
        <CardDescription className="text-[11px]">
          Flat per-monitor pricing with monthly alert caps (UTC). Plan is stored in the database unless{' '}
          <code className="text-[10px]">CRONSENTINEL_PLAN</code> is set in the environment.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-xs">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Current plan</p>
            <p className="mt-1 text-sm font-semibold text-foreground">{billing.plan_display_name}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              slug <code className="text-[10px]">{billing.plan_slug}</code> · source {billing.plan_source}
            </p>
          </div>
          <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Monitors</p>
            <p className="mt-1 tabular-nums text-sm font-semibold">
              {billing.monitors_used} / {billing.max_monitors}
            </p>
            <Meter value={billing.monitors_utilization} />
          </div>
          <div className="rounded-lg border border-border/60 bg-muted/20 p-3 sm:col-span-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Alerts sent (this UTC month)
            </p>
            <p className="mt-1 tabular-nums text-sm font-semibold">
              {billing.alerts_sent_this_month} / {billing.max_alerts_per_month}
            </p>
            <Meter value={billing.alerts_utilization} />
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5 min-w-[180px]">
            <Label htmlFor="billing-plan" className="text-[10px] text-muted-foreground">
              Change plan (self-hosted)
            </Label>
            <Select
              value={effectiveDraft}
              onValueChange={v => {
                setPlanDraft(v)
              }}
            >
              <SelectTrigger id="billing-plan" className="h-9 text-xs">
                <SelectValue placeholder="Plan" />
              </SelectTrigger>
              <SelectContent>
                {billing.available_plan_slugs.map(slug => (
                  <SelectItem key={slug} value={slug} className="text-xs">
                    {slug}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            size="sm"
            className="h-9 text-xs"
            disabled={saving || effectiveDraft.trim() === billing.plan_slug}
            onClick={() => void savePlan()}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin mr-1" aria-hidden /> : null}
            Save plan
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-9 text-xs" asChild>
            <a href={billing.upgrade_url} target="_blank" rel="noreferrer">
              Upgrade / billing
              <ExternalLink className="h-3 w-3 ml-1" aria-hidden />
            </a>
          </Button>
        </div>
      </CardContent>
      <CardFooter className="border-t border-border/40 pt-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 text-[10px] text-muted-foreground"
          onClick={() => void onRefresh()}
        >
          <RefreshCw className="h-3 w-3 mr-1" aria-hidden />
          Refresh usage
        </Button>
      </CardFooter>
    </Card>
  )
}

function Meter({ value }: { value: number }): React.ReactElement {
  const pct = Math.min(100, Math.round(value * 1000) / 10)
  return (
    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={`h-full rounded-full transition-all ${
          value >= 0.95 ? 'bg-destructive' : value >= 0.8 ? 'bg-amber-500' : 'bg-primary'
        }`}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}
