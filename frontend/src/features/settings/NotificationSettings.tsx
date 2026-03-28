import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, CalendarClock, Hand, Loader2, Mail, Server, ShieldCheck, Users, X } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { API_BASE_URL, apiFetch, getFetchErrorMessage, isApiError } from '@/lib/api'

export type NotificationSettingsDTO = {
  enabled: boolean
  smtp_host: string
  smtp_port: number
  smtp_username: string
  smtp_password_set: boolean
  smtp_password_from_env?: boolean
  smtp_tls: boolean
  from_address: string
  to_addresses: string
  notify_scheduled_success: boolean
  notify_scheduled_failure: boolean
  notify_manual_success: boolean
  notify_manual_failure: boolean
  notify_heartbeat_missed: boolean
}

const emptyForm = (): Omit<NotificationSettingsDTO, 'smtp_password_set'> & { smtp_password: string } => ({
  enabled: false,
  smtp_host: '',
  smtp_port: 587,
  smtp_username: '',
  smtp_password: '',
  smtp_tls: true,
  from_address: '',
  to_addresses: '',
  notify_scheduled_success: false,
  notify_scheduled_failure: false,
  notify_manual_success: false,
  notify_manual_failure: false,
  notify_heartbeat_missed: false,
})

type ToggleRowProps = {
  id: string
  checked: boolean
  onChange: (v: boolean) => void
  title: string
  description: string
}

function ToggleRow({ id, checked, onChange, title, description }: ToggleRowProps) {
  return (
    <label
      htmlFor={id}
      className="flex gap-3 rounded-lg border border-border/50 bg-white p-3.5 cursor-pointer transition-colors hover:bg-muted/25 focus-within:ring-2 focus-within:ring-primary/30 focus-within:ring-offset-1"
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-border text-primary focus:ring-primary"
      />
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-foreground">{title}</span>
        <span className="block text-[10px] text-muted-foreground leading-snug mt-0.5">{description}</span>
      </span>
    </label>
  )
}

export function NotificationSettings() {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [passwordWasSet, setPasswordWasSet] = useState(false)
  const [passwordFromEnv, setPasswordFromEnv] = useState(false)
  const [form, setForm] = useState(emptyForm)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const s = await apiFetch<NotificationSettingsDTO>(`${API_BASE_URL}/api/settings/notifications`)
      if (s == null || typeof s !== 'object') {
        const msg = 'The server returned an empty or invalid settings payload.'
        setLoadError(msg)
        toast.error('Invalid settings response', { description: msg })
        return
      }
      setPasswordWasSet(Boolean(s.smtp_password_set))
      setPasswordFromEnv(Boolean(s.smtp_password_from_env))
      setForm({
        enabled: s.enabled,
        smtp_host: s.smtp_host ?? '',
        smtp_port: s.smtp_port > 0 ? s.smtp_port : 587,
        smtp_username: s.smtp_username ?? '',
        smtp_password: '',
        smtp_tls: s.smtp_tls !== false,
        from_address: s.from_address ?? '',
        to_addresses: s.to_addresses ?? '',
        notify_scheduled_success: s.notify_scheduled_success,
        notify_scheduled_failure: s.notify_scheduled_failure,
        notify_manual_success: s.notify_manual_success,
        notify_manual_failure: s.notify_manual_failure,
        notify_heartbeat_missed: Boolean(s.notify_heartbeat_missed),
      })
    } catch (e) {
      const msg = getFetchErrorMessage(e)
      setLoadError(msg)
      toast.error('Could not load settings', { description: msg })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const canSendTest = useMemo(() => {
    const user = form.smtp_username.trim()
    const hasPasswordForServer =
      passwordFromEnv || passwordWasSet || form.smtp_password.trim().length > 0
    if (user && !hasPasswordForServer) return false
    return (
      form.enabled &&
      form.smtp_host.trim().length > 0 &&
      form.from_address.trim().length > 0 &&
      form.to_addresses.trim().length > 0
    )
  }, [
    form.enabled,
    form.smtp_host,
    form.from_address,
    form.to_addresses,
    form.smtp_username,
    form.smtp_password,
    passwordWasSet,
    passwordFromEnv,
  ])

  const save = async () => {
    setSaving(true)
    setActionError(null)
    try {
      await apiFetch(`${API_BASE_URL}/api/settings/notifications`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: form.enabled,
          smtp_host: form.smtp_host,
          smtp_port: form.smtp_port,
          smtp_username: form.smtp_username,
          smtp_password: form.smtp_password,
          smtp_tls: form.smtp_tls,
          from_address: form.from_address,
          to_addresses: form.to_addresses,
          notify_scheduled_success: form.notify_scheduled_success,
          notify_scheduled_failure: form.notify_scheduled_failure,
          notify_manual_success: form.notify_manual_success,
          notify_manual_failure: form.notify_manual_failure,
          notify_heartbeat_missed: form.notify_heartbeat_missed,
        }),
      })
      toast.success('Settings saved', { description: 'Notification preferences were updated.' })
      setForm(f => ({ ...f, smtp_password: '' }))
      await load()
    } catch (e) {
      const msg = getFetchErrorMessage(e)
      setActionError(msg)
      toast.error('Could not save settings', { description: msg })
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setActionError(null)
    try {
      await apiFetch(`${API_BASE_URL}/api/settings/notifications/test`, { method: 'POST' })
      toast.success('Test email sent', {
        description: 'Check the recipient inbox (and spam). If it failed, the error would appear above.',
      })
    } catch (e) {
      const msg = getFetchErrorMessage(e)
      const hint =
        isApiError(e) && e.status === 400
          ? (msg.toLowerCase().includes('password')
              ? ' Enter your SMTP password, click Save changes, then send the test again (the test uses saved settings).'
              : ' Turn on notifications and complete SMTP host, From, and To, then save.')
          : isApiError(e) && e.status === 502
            ? ' Check host, port (465 = SSL, 587 = STARTTLS), username, and password with your provider.'
            : ''
      setActionError(msg + hint)
      toast.error('Test email not sent', { description: msg })
    } finally {
      setTesting(false)
    }
  }

  if (loading) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border/60 bg-white py-16 text-muted-foreground"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <Loader2 className="h-8 w-8 motion-safe:animate-spin text-primary/60" aria-hidden />
        <p className="text-sm font-medium">Loading notification settings…</p>
      </div>
    )
  }

  if (loadError) {
    return (
      <div
        className="max-w-2xl rounded-xl border border-destructive/30 bg-destructive/5 px-5 py-6"
        role="alert"
        aria-live="assertive"
      >
        <div className="flex gap-3">
          <AlertCircle className="h-5 w-5 shrink-0 text-destructive mt-0.5" aria-hidden />
          <div className="min-w-0 space-y-2">
            <p className="text-sm font-semibold text-destructive">Could not load notification settings</p>
            <p className="text-xs text-destructive/90 leading-relaxed">{loadError}</p>
            <p className="text-[11px] text-muted-foreground">
              Check that the backend is running and up to date, then try again.
            </p>
            <Button type="button" size="sm" variant="outline" className="mt-2 h-8 text-xs" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-4 pb-8">
      <Card className="overflow-hidden border-border/60 py-0 gap-0 shadow-xs">
        <CardHeader className="space-y-1 border-b border-border/40 bg-gradient-to-r from-amber-500/5 to-transparent px-5 py-4">
          <CardTitle className="flex items-center gap-2 text-[15px] font-bold tracking-tight text-amber-600 uppercase">
            <Mail className="h-4 w-4 text-amber-500 shrink-0" aria-hidden />
            Email notifications
          </CardTitle>
          <CardDescription className="text-[11px] leading-relaxed">
            Get alerts when jobs finish and use the same mail server for <strong className="font-medium text-foreground/80">Run history → Email history</strong>.
            Optional env override:{' '}
            <code className="rounded bg-muted px-1 py-px text-[10px] font-mono text-foreground/90">NOTIFICATION_SMTP_PASSWORD</code>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-0 px-0">
          <div className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">Send notification emails</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                When off, no messages are sent — you can still edit fields below.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={form.enabled}
              aria-label={form.enabled ? 'Email notifications on' : 'Email notifications off'}
              onClick={() => setForm(f => ({ ...f, enabled: !f.enabled }))}
              className={`relative h-7 w-[52px] shrink-0 cursor-pointer rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${
                form.enabled ? 'bg-primary' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`pointer-events-none absolute top-0.5 left-0.5 block h-[22px] w-[22px] rounded-full bg-white shadow transition-transform motion-reduce:transition-none ${
                  form.enabled ? 'translate-x-[26px]' : 'translate-x-0'
                }`}
              />
              <span className="sr-only">{form.enabled ? 'On' : 'Off'}</span>
            </button>
          </div>
          {!form.enabled && (
            <div className="mx-5 mb-4 rounded-md border border-amber-200/80 bg-amber-50/80 px-3 py-2 text-[11px] text-amber-900">
              <span className="font-medium">Heads up:</span> alerts and test emails stay disabled until you turn this on and save.
            </div>
          )}
        </CardContent>
      </Card>

      <Card className={`border-border/60 py-0 gap-0 shadow-xs transition-opacity ${!form.enabled ? 'opacity-90' : ''}`}>
        <CardHeader className="flex flex-row items-center gap-2 space-y-0 border-b border-border/40 px-5 py-3.5">
          <Server className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden />
          <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            SMTP server
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 px-5 py-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-1">
            <Label htmlFor="smtp-host" className="text-xs font-medium">
              Host
            </Label>
            <Input
              id="smtp-host"
              value={form.smtp_host}
              onChange={e => setForm(f => ({ ...f, smtp_host: e.target.value }))}
              placeholder="smtp.mailprovider.com"
              className="h-9 text-xs"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-1">
            <Label htmlFor="smtp-port" className="text-xs font-medium">
              Port
            </Label>
            <Input
              id="smtp-port"
              type="number"
              inputMode="numeric"
              value={form.smtp_port}
              onChange={e => setForm(f => ({ ...f, smtp_port: Number(e.target.value) || 587 }))}
              className="h-9 text-xs font-mono"
              aria-describedby="smtp-port-hint"
            />
            <p id="smtp-port-hint" className="text-[10px] text-muted-foreground">
              {form.smtp_port === 465
                ? 'Port 465 uses TLS immediately — the STARTTLS option below is ignored. Uncheck it to avoid confusion.'
                : '587 + STARTTLS below is typical. For port 465, use implicit TLS only (see hint when you set port to 465).'}
            </p>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="smtp-user" className="text-xs font-medium">
              Username <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="smtp-user"
              value={form.smtp_username}
              onChange={e => setForm(f => ({ ...f, smtp_username: e.target.value }))}
              className="h-9 text-xs"
              autoComplete="username"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="smtp-pass" className="text-xs font-medium">
              Password <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="smtp-pass"
              type="password"
              value={form.smtp_password}
              onChange={e => setForm(f => ({ ...f, smtp_password: e.target.value }))}
              placeholder={passwordWasSet ? 'Leave blank to keep current password' : 'If your server requires auth'}
              className="h-9 text-xs"
              autoComplete="new-password"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/40 bg-muted/15 px-3 py-2.5">
              <input
                type="checkbox"
                checked={form.smtp_tls}
                onChange={e => setForm(f => ({ ...f, smtp_tls: e.target.checked }))}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-border"
              />
              <span>
                <span className="block text-xs font-medium text-foreground">Use STARTTLS after connect</span>
                <span className="block text-[10px] text-muted-foreground mt-0.5">
                  Disable only if your relay uses plain SMTP on a trusted network.
                </span>
              </span>
            </label>
          </div>
        </CardContent>
      </Card>

      <Card className={`border-border/60 py-0 gap-0 shadow-xs transition-opacity ${!form.enabled ? 'opacity-90' : ''}`}>
        <CardHeader className="flex flex-row items-center gap-2 space-y-0 border-b border-border/40 px-5 py-3.5">
          <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden />
          <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Sender & recipients
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 px-5 py-4">
          <div className="space-y-1.5">
            <Label htmlFor="from-addr" className="text-xs font-medium">
              From
            </Label>
            <Input
              id="from-addr"
              value={form.from_address}
              onChange={e => setForm(f => ({ ...f, from_address: e.target.value }))}
              placeholder="cron@yourdomain.com"
              className="h-9 text-xs"
              autoComplete="email"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="to-addr" className="text-xs font-medium">
              To
            </Label>
            <Input
              id="to-addr"
              value={form.to_addresses}
              onChange={e => setForm(f => ({ ...f, to_addresses: e.target.value }))}
              placeholder="you@example.com, team@example.com"
              className="h-9 text-xs"
              aria-describedby="to-addr-hint"
            />
            <p id="to-addr-hint" className="text-[10px] text-muted-foreground">
              Separate multiple addresses with commas.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className={`border-border/60 py-0 gap-0 shadow-xs transition-opacity ${!form.enabled ? 'opacity-90' : ''}`}>
        <CardHeader className="flex flex-row items-center gap-2 space-y-0 border-b border-border/40 px-5 py-3.5">
          <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden />
          <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            When to notify
          </CardTitle>
        </CardHeader>
        <CardContent className="px-5 py-4">
          <p className="text-[11px] text-muted-foreground mb-4">
            Choose which job outcomes trigger an email. Run History export ignores these and only needs SMTP to be valid.
          </p>
          <div className="flex flex-col gap-6 sm:flex-row sm:items-stretch sm:gap-0">
            <div className="min-w-0 flex-1 space-y-3">
              <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-amber-600/90">
                <CalendarClock className="h-3.5 w-3.5 shrink-0" aria-hidden />
                Scheduled runs
              </div>
              <div className="space-y-2">
                <ToggleRow
                  id="notify-sch-ok"
                  checked={form.notify_scheduled_success}
                  onChange={v => setForm(f => ({ ...f, notify_scheduled_success: v }))}
                  title="Success"
                  description="Cron fired the job and it exited cleanly."
                />
                <ToggleRow
                  id="notify-sch-fail"
                  checked={form.notify_scheduled_failure}
                  onChange={v => setForm(f => ({ ...f, notify_scheduled_failure: v }))}
                  title="Failure"
                  description="Non-zero exit, timeout, or start error after schedule."
                />
              </div>
            </div>
            <Separator orientation="horizontal" className="sm:hidden" />
            <Separator orientation="vertical" className="mx-5 hidden w-px shrink-0 self-stretch sm:block min-h-[148px]" />
            <div className="min-w-0 flex-1 space-y-3">
              <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-amber-600/90">
                <Hand className="h-3.5 w-3.5 shrink-0" aria-hidden />
                Manual runs
              </div>
              <div className="space-y-2">
                <ToggleRow
                  id="notify-man-ok"
                  checked={form.notify_manual_success}
                  onChange={v => setForm(f => ({ ...f, notify_manual_success: v }))}
                  title="Success"
                  description='After you click "Run" and the job succeeds.'
                />
                <ToggleRow
                  id="notify-man-fail"
                  checked={form.notify_manual_failure}
                  onChange={v => setForm(f => ({ ...f, notify_manual_failure: v }))}
                  title="Failure"
                  description="Manual run exits with error or cannot start."
                />
              </div>
            </div>
          </div>
          <Separator className="my-4" />
          <ToggleRow
            id="notify-hb-missed"
            checked={form.notify_heartbeat_missed}
            onChange={v => setForm(f => ({ ...f, notify_heartbeat_missed: v }))}
            title="Missed heartbeat"
            description="Email when a job does not POST to its heartbeat URL within the schedule window plus grace period."
          />
        </CardContent>
        <CardFooter className="flex flex-col gap-3 border-t border-border/40 bg-muted/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          {actionError && (
            <div
              className="order-first flex w-full items-start gap-2 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive sm:col-span-full"
              role="alert"
            >
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden />
              <p className="min-w-0 flex-1 leading-snug">{actionError}</p>
              <button
                type="button"
                className="shrink-0 rounded p-0.5 text-destructive hover:bg-destructive/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40"
                aria-label="Dismiss error"
                onClick={() => setActionError(null)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <p className="text-[10px] text-muted-foreground order-2 sm:order-1">
            Save applies all sections. <strong className="font-medium text-foreground/80">Send test email</strong> uses the last{' '}
            <em>saved</em> settings from the server — click Save after changing password or host, then test.
          </p>
          <div className="flex flex-wrap gap-2 order-1 sm:order-2">
            <Button
              type="button"
              size="sm"
              onClick={save}
              disabled={saving}
              className="h-9 min-w-[88px] text-xs gap-1.5"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden /> : null}
              Save changes
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={test}
              disabled={testing || !canSendTest}
              className="h-9 text-xs gap-1.5"
              title={
                !canSendTest
                  ? 'Enable notifications, fill host/from/to, and if you use SMTP login save a password (Save changes) before testing.'
                  : 'Sends using saved server settings. Save first if you changed password or host.'
              }
            >
              {testing ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden /> : <Mail className="h-3.5 w-3.5" aria-hidden />}
              Send test email
            </Button>
          </div>
        </CardFooter>
      </Card>
    </div>
  )
}
