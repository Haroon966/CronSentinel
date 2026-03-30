import { useCallback, useEffect, useId, useState, type ReactElement } from 'react'
import { AlertCircle, Check, Copy, Loader2, SkipForward, Sparkles } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CronExpressionHelper } from '@/features/jobs/CronExpressionHelper'
import { validateCron, validateJobName } from '@/features/jobs/validators'
import type { NotificationSettingsDTO } from '@/features/settings/NotificationSettings'
import {
  getOnboardingState,
  markOnboardingCompleted,
  markOnboardingSkipped,
  type OnboardingStep,
  updateOnboardingState,
} from '@/features/onboarding/onboardingStorage'
import { apiFetch, getFetchErrorMessage, isApiError } from '@/lib/api'

const DEFAULT_COMMAND = 'echo "cron test"'
const DEFAULT_SCHEDULE = '*/5 * * * *'

type CreateJobResponse = { ok?: boolean; id?: string; heartbeat_token?: string }

function heartbeatPostUrl(apiBase: string, token: string): string {
  const base = (apiBase.trim() !== '' ? apiBase : typeof window !== 'undefined' ? window.location.origin : '')
    .replace(/\/$/, '')
  return `${base}/api/heartbeat/${encodeURIComponent(token)}`
}

function heartbeatCurlOneLiner(url: string): string {
  return `curl -fsS -X POST '${url}' -H 'Content-Type: text/plain' --data-raw 'ok'`
}

type OnboardingJobRef = { id: string; last_heartbeat_at?: string | null }

export type OnboardingWizardProps = {
  open: boolean
  apiBaseUrl: string
  onStorageChange: () => void
  onOpenNotificationSettings: () => void
  onRefreshJobs: () => Promise<void>
}

export function OnboardingWizard({
  open,
  apiBaseUrl,
  onStorageChange,
  onOpenNotificationSettings,
  onRefreshJobs,
}: OnboardingWizardProps): ReactElement | null {
  const titleId = useId()
  const [step, setStep] = useState<OnboardingStep>(1)
  const [jobName, setJobName] = useState('')
  const [schedule, setSchedule] = useState(DEFAULT_SCHEDULE)
  const [jobId, setJobId] = useState<string | null>(null)
  const [heartbeatToken, setHeartbeatToken] = useState<string | null>(null)
  const [nameErr, setNameErr] = useState('')
  const [scheduleErr, setScheduleErr] = useState('')
  const [creating, setCreating] = useState(false)
  const [notifLoading, setNotifLoading] = useState(false)
  const [notifSaving, setNotifSaving] = useState(false)
  const [notifForm, setNotifForm] = useState<NotificationSettingsDTO | null>(null)
  const [notifLoadErr, setNotifLoadErr] = useState<string | null>(null)
  const [testSending, setTestSending] = useState(false)
  const [testOk, setTestOk] = useState(false)
  const [testErr, setTestErr] = useState<string | null>(null)

  const syncFromStorage = useCallback((): void => {
    const s = getOnboardingState()
    setStep(s.step)
    setJobName(s.jobName ?? '')
    setSchedule(s.schedule ?? DEFAULT_SCHEDULE)
    setJobId(s.jobId ?? null)
    setHeartbeatToken(s.heartbeatToken ?? null)
    setNameErr('')
    setScheduleErr('')
    setTestOk(false)
    setTestErr(null)
  }, [])

  useEffect(() => {
    if (!open) return
    syncFromStorage()
  }, [open, syncFromStorage])

  useEffect(() => {
    if (!open || step !== 3) return
    let cancelled = false
    setNotifLoading(true)
    setNotifLoadErr(null)
    apiFetch<NotificationSettingsDTO>(`${apiBaseUrl}/api/settings/notifications`)
      .then(s => {
        if (cancelled || s == null) return
        setNotifForm(s)
      })
      .catch(e => {
        if (cancelled) return
        const msg = getFetchErrorMessage(e)
        setNotifLoadErr(msg)
        toast.error('Could not load notification settings', { description: msg })
      })
      .finally(() => {
        if (!cancelled) setNotifLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, step, apiBaseUrl])

  const skip = (): void => {
    markOnboardingSkipped()
    void apiFetch(`${apiBaseUrl}/api/settings/onboarding`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipped: true }),
    }).catch(() => { /* non-fatal */ })
    onStorageChange()
    toast.message('Onboarding skipped', { description: 'You can add jobs anytime from the Jobs tab.' })
  }

  const goStep2 = async (): Promise<void> => {
    const ne = validateJobName(jobName)
    const se = validateCron(schedule)
    setNameErr(ne)
    setScheduleErr(se)
    if (ne || se) return
    setCreating(true)
    try {
      const body = {
        name: jobName.trim(),
        schedule: schedule.trim(),
        command: DEFAULT_COMMAND,
        timezone: 'Local',
        working_directory: '',
        comment: '',
        logging_enabled: true,
        timeout_seconds: 300,
        heartbeat_grace_seconds: 300,
        success_exit_code: 0,
      }
      const res = await apiFetch<CreateJobResponse>(`${apiBaseUrl}/api/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const id = res?.id?.trim()
      const tok = res?.heartbeat_token?.trim()
      if (!id || !tok) {
        toast.error('Job created but response was incomplete', { description: 'Try refreshing the Jobs tab.' })
        return
      }
      setJobId(id)
      setHeartbeatToken(tok)
      const nextStep = 2 as const
      setStep(nextStep)
      updateOnboardingState({
        step: nextStep,
        jobId: id,
        heartbeatToken: tok,
        jobName: jobName.trim(),
        schedule: schedule.trim(),
      })
      onStorageChange()
      await onRefreshJobs()
      toast.success('Job created', { description: 'Copy your heartbeat URL on the next step.' })
    } catch (e) {
      toast.error('Could not create job', { description: getFetchErrorMessage(e) })
    } finally {
      setCreating(false)
    }
  }

  const copyText = (label: string, text: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => toast.success(`${label} copied`),
      () => toast.error('Copy failed'),
    )
  }

  const saveNotificationsAndContinue = async (): Promise<void> => {
    if (!notifForm) {
      setStep(4)
      updateOnboardingState({ step: 4 })
      onStorageChange()
      return
    }
    setNotifSaving(true)
    try {
      await apiFetch(`${apiBaseUrl}/api/settings/notifications`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: notifForm.enabled,
          smtp_host: notifForm.smtp_host,
          smtp_port: notifForm.smtp_port,
          smtp_username: notifForm.smtp_username,
          smtp_password: '',
          smtp_tls: notifForm.smtp_tls,
          from_address: notifForm.from_address,
          to_addresses: notifForm.to_addresses,
          notify_scheduled_success: notifForm.notify_scheduled_success,
          notify_scheduled_failure: notifForm.notify_scheduled_failure,
          notify_manual_success: notifForm.notify_manual_success,
          notify_manual_failure: notifForm.notify_manual_failure,
          notify_heartbeat_missed: notifForm.notify_heartbeat_missed,
          notify_server_unreachable: notifForm.notify_server_unreachable,
          notify_crontab_changed: notifForm.notify_crontab_changed,
        }),
      })
      toast.success('Alert settings saved')
    } catch (e) {
      toast.error('Could not save settings', { description: getFetchErrorMessage(e) })
      return
    } finally {
      setNotifSaving(false)
    }
    setStep(4)
    updateOnboardingState({ step: 4 })
    onStorageChange()
  }

  const continueWithoutNotifSave = (): void => {
    setStep(4)
    updateOnboardingState({ step: 4 })
    onStorageChange()
  }

  const sendTestHeartbeat = async (): Promise<void> => {
    const tok = heartbeatToken
    if (!tok) {
      setTestErr('Missing heartbeat token. Go back to step 2 or restart onboarding.')
      return
    }
    setTestSending(true)
    setTestErr(null)
    setTestOk(false)
    const url = heartbeatPostUrl(apiBaseUrl, tok)
    try {
      await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'onboarding-test',
      })
      await onRefreshJobs()
      await new Promise(r => setTimeout(r, 400))
      await onRefreshJobs()
      const list = await apiFetch<OnboardingJobRef[]>(`${apiBaseUrl}/api/jobs`)
      const j = list?.find(x => x.id === jobId)
      if (j?.last_heartbeat_at) {
        setTestOk(true)
        toast.success('Heartbeat received', { description: 'CronSentinel recorded your test ping.' })
      } else {
        setTestOk(true)
        toast.success('Request accepted', { description: 'If status does not update, wait a few seconds and refresh.' })
      }
    } catch (e) {
      const msg = getFetchErrorMessage(e)
      setTestErr(msg)
      if (isApiError(e) && e.status === 429) {
        toast.error('Rate limited', { description: 'Wait about 10 seconds between pings for the same token, then retry.' })
      } else {
        toast.error('Test heartbeat failed', { description: msg })
      }
    } finally {
      setTestSending(false)
    }
  }

  const finish = (): void => {
    markOnboardingCompleted()
    void apiFetch(`${apiBaseUrl}/api/settings/onboarding`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ completed: true }),
    }).catch(() => { /* non-fatal */ })
    onStorageChange()
    toast.success('You are set up', { description: 'Your job appears on the Jobs tab.' })
  }

  if (!open) return null

  const hbUrl = heartbeatToken ? heartbeatPostUrl(apiBaseUrl, heartbeatToken) : ''
  const curlLine = hbUrl ? heartbeatCurlOneLiner(hbUrl) : ''

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="relative flex max-h-[min(90vh,720px)] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border/60 bg-card shadow-[var(--cs-shadow-modal)]">
        <div className="shrink-0 border-b border-border/50 bg-muted/30 px-4 py-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Sparkles className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
              <div className="min-w-0">
                <h2 id={titleId} className="text-sm font-bold text-foreground">
                  Get started in under a minute
                </h2>
                <p className="text-[10px] text-muted-foreground mt-0.5">Step {step} of 4</p>
              </div>
            </div>
            <Button type="button" variant="ghost" size="sm" className="h-8 shrink-0 text-xs" onClick={skip}>
              <SkipForward className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
              Skip
            </Button>
          </div>
          <ol className="mt-3 flex gap-1" aria-label="Onboarding progress">
            {([1, 2, 3, 4] as const).map(n => (
              <li
                key={n}
                className={`h-1 flex-1 rounded-full ${n <= step ? 'bg-primary' : 'bg-border/80'}`}
                aria-current={n === step ? 'step' : undefined}
              />
            ))}
          </ol>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {step === 1 && (
            <>
              <p className="text-[11px] text-muted-foreground leading-snug">
                Name your first monitored job and set its schedule. We use a simple test command so you can focus on the heartbeat URL next.
              </p>
              <div>
                <Label htmlFor="onb-job-name" className="text-xs">
                  Job name
                </Label>
                <Input
                  id="onb-job-name"
                  value={jobName}
                  onChange={e => {
                    setJobName(e.target.value)
                    if (nameErr) setNameErr('')
                  }}
                  placeholder="e.g. nightly-backup"
                  className="mt-1 h-9 text-sm"
                  autoComplete="off"
                />
                {nameErr ? (
                  <p className="text-[10px] text-destructive mt-1 flex items-center gap-1" role="alert">
                    <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
                    {nameErr}
                  </p>
                ) : null}
              </div>
              <div>
                <Label className="text-xs">Schedule</Label>
                <div className="mt-1">
                  <CronExpressionHelper
                    id="onb-schedule"
                    value={schedule}
                    onChange={v => {
                      setSchedule(v)
                      if (scheduleErr) setScheduleErr('')
                    }}
                    errors={scheduleErr}
                    timezone="Local"
                  />
                </div>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <p className="text-[11px] text-muted-foreground leading-snug">
                Add this URL to your cron job (or run the curl command once to test). Each successful POST counts as a heartbeat.
              </p>
              <div className="rounded border border-border/50 bg-muted/20 p-2 space-y-2">
                <div>
                  <p className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Heartbeat URL</p>
                  <div className="flex gap-1">
                    <code className="flex-1 break-all rounded border border-border/40 bg-card px-2 py-1.5 text-xs leading-snug font-mono">
                      {hbUrl || '—'}
                    </code>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 shrink-0"
                      disabled={!hbUrl}
                      onClick={() => copyText('URL', hbUrl)}
                    >
                      <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
                <div>
                  <p className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">One-line curl</p>
                  <div className="flex gap-1">
                    <code className="flex-1 break-all rounded border border-border/40 bg-card px-2 py-1.5 text-xs leading-snug font-mono">
                      {curlLine || '—'}
                    </code>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 shrink-0"
                      disabled={!curlLine}
                      onClick={() => copyText('curl command', curlLine)}
                    >
                      <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <p className="text-[11px] text-muted-foreground leading-snug">
                Enter where email alerts should go and turn on missed-heartbeat notifications. Full SMTP setup lives in Settings.
              </p>
              <p className="text-[10px] text-muted-foreground border border-dashed border-border/60 rounded px-2 py-1.5 bg-muted/10">
                Slack, webhooks, and SMS are available under <strong className="font-medium text-foreground/90">Settings → Multi-channel alerts</strong>. Use email below for the quickest path.
              </p>
              {notifLoading && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Loading settings…
                </div>
              )}
              {notifLoadErr && !notifLoading && (
                <p className="text-[10px] text-destructive" role="alert">
                  {notifLoadErr}
                </p>
              )}
              {notifForm && !notifLoading && (
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="onb-to" className="text-xs">
                      Alert email (To)
                    </Label>
                    <Input
                      id="onb-to"
                      value={notifForm.to_addresses}
                      onChange={e => setNotifForm(f => (f ? { ...f, to_addresses: e.target.value } : f))}
                      placeholder="you@example.com"
                      className="mt-1 h-9 text-sm"
                    />
                  </div>
                  <label className="flex gap-2 items-start cursor-pointer rounded border border-border/50 p-2.5">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-border"
                      checked={notifForm.notify_heartbeat_missed}
                      onChange={e =>
                        setNotifForm(f => (f ? { ...f, notify_heartbeat_missed: e.target.checked } : f))
                      }
                    />
                    <span className="text-[11px] leading-snug">
                      <span className="font-semibold block">Email when a heartbeat is missed</span>
                      <span className="text-muted-foreground">Fires if your job does not POST within the schedule window plus grace period.</span>
                    </span>
                  </label>
                  <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={onOpenNotificationSettings}>
                    Open full notification settings
                  </Button>
                </div>
              )}
            </>
          )}

          {step === 4 && (
            <>
              <p className="text-[11px] text-muted-foreground leading-snug">
                Send a test ping from this browser. If it fails, check the tips below.
              </p>
              <Button
                type="button"
                className="w-full"
                onClick={() => void sendTestHeartbeat()}
                disabled={testSending || !heartbeatToken}
              >
                {testSending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" />
                    Sending…
                  </>
                ) : (
                  'Send test heartbeat'
                )}
              </Button>
              {testOk && (
                <div className="flex items-start gap-2 rounded border border-[var(--cs-healthy-border)] bg-[var(--cs-healthy-bg)] px-2.5 py-2 text-xs text-[var(--cs-healthy-text)]">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--cs-healthy)]" aria-hidden="true" />
                  <span>Test sent. Check the Jobs list for updated heartbeat time.</span>
                </div>
              )}
              {testErr && (
                <div className="space-y-1 rounded border border-[var(--cs-late-border)] bg-[var(--cs-late-bg)] px-2.5 py-2 text-xs text-[var(--cs-late-text)]" role="alert">
                  <p className="font-semibold">Troubleshooting</p>
                  <ul className="list-disc pl-4 space-y-0.5">
                    <li>Confirm the API URL matches this app (same origin or VITE_API_BASE_URL).</li>
                    <li>If you see rate limited, wait ~10 seconds and try again.</li>
                    <li>Run the curl command from step 2 on the machine that runs your cron.</li>
                    <li>Check that the job still exists on the Jobs tab.</li>
                  </ul>
                  <p className="text-[10px] opacity-90 pt-1">{testErr}</p>
                </div>
              )}
            </>
          )}
        </div>

        <div className="shrink-0 border-t border-border/50 bg-muted/20 px-4 py-3 flex flex-wrap gap-2 justify-end">
          {step === 1 && (
            <Button type="button" onClick={() => void goStep2()} disabled={creating}>
              {creating ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" />
                  Creating…
                </>
              ) : (
                'Continue'
              )}
            </Button>
          )}
          {step === 2 && (
            <Button
              type="button"
              onClick={() => {
                setStep(3)
                updateOnboardingState({ step: 3 })
                onStorageChange()
              }}
            >
              Continue
            </Button>
          )}
          {step === 3 && (
            <>
              <Button type="button" variant="outline" onClick={continueWithoutNotifSave} disabled={notifSaving}>
                Skip for now
              </Button>
              <Button type="button" onClick={() => void saveNotificationsAndContinue()} disabled={notifSaving || notifLoading}>
                {notifSaving ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" />
                    Saving…
                  </>
                ) : (
                  'Save & continue'
                )}
              </Button>
            </>
          )}
          {step === 4 && (
            <Button type="button" onClick={finish}>
              Done
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
