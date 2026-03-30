import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, MessageSquare, Radio, Send, Trash2, Webhook } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { API_BASE_URL, apiFetch, getFetchErrorMessage } from '@/lib/api'

export type AlertChannelItem = {
  id: string
  kind: string
  label: string
  enabled: boolean
  created_at: string
  slack_webhook_set?: boolean
  generic_webhook_set?: boolean
  twilio_configured?: boolean
}

type DeliveryLogRow = {
  id: string
  created_at: string
  channel_id?: string
  channel_kind: string
  channel_label: string
  alert_type: string
  job_id?: string
  run_id?: string
  server_hint?: string
  status: string
  attempts: number
  error_message?: string
}

const KINDS = [
  { value: 'slack_webhook', label: 'Slack (incoming webhook)' },
  { value: 'generic_webhook', label: 'Generic webhook (JSON POST)' },
  { value: 'sms_twilio', label: 'SMS (Twilio)' },
] as const

export function AlertChannelsSettings() {
  const [loading, setLoading] = useState(true)
  const [channels, setChannels] = useState<AlertChannelItem[]>([])
  const [logItems, setLogItems] = useState<DeliveryLogRow[]>([])
  const [savingId, setSavingId] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const [newKind, setNewKind] = useState<string>('slack_webhook')
  const [newLabel, setNewLabel] = useState('')
  const [newWebhookURL, setNewWebhookURL] = useState('')
  const [newGenericURL, setNewGenericURL] = useState('')
  const [twilioSid, setTwilioSid] = useState('')
  const [twilioToken, setTwilioToken] = useState('')
  const [twilioFrom, setTwilioFrom] = useState('')
  const [twilioTo, setTwilioTo] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [ch, logRes] = await Promise.all([
        apiFetch<AlertChannelItem[]>(`${API_BASE_URL}/api/settings/alert-channels`),
        apiFetch<{ items?: DeliveryLogRow[] }>(`${API_BASE_URL}/api/settings/alert-delivery-log?limit=40`),
      ])
      setChannels(Array.isArray(ch) ? ch : [])
      setLogItems(Array.isArray(logRes?.items) ? logRes.items! : [])
    } catch (e) {
      toast.error('Could not load alert channels', { description: getFetchErrorMessage(e) })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const createBody = useMemo(() => {
    const base: Record<string, unknown> = { kind: newKind, label: newLabel.trim(), enabled: true }
    if (newKind === 'slack_webhook') base.webhook_url = newWebhookURL.trim()
    if (newKind === 'generic_webhook') base.url = newGenericURL.trim()
    if (newKind === 'sms_twilio') {
      base.account_sid = twilioSid.trim()
      base.auth_token = twilioToken.trim()
      base.from = twilioFrom.trim()
      base.to = twilioTo.trim()
    }
    return base
  }, [newKind, newLabel, newWebhookURL, newGenericURL, twilioSid, twilioToken, twilioFrom, twilioTo])

  const canCreate = useMemo(() => {
    if (newKind === 'slack_webhook') return newWebhookURL.trim().length > 8
    if (newKind === 'generic_webhook') return newGenericURL.trim().length > 8
    return twilioSid.trim() && twilioToken.trim() && twilioFrom.trim() && twilioTo.trim()
  }, [newKind, newWebhookURL, newGenericURL, twilioSid, twilioToken, twilioFrom, twilioTo])

  const createChannel = async () => {
    if (!canCreate) return
    setCreating(true)
    try {
      await apiFetch(`${API_BASE_URL}/api/settings/alert-channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody),
      })
      toast.success('Channel added')
      setNewWebhookURL('')
      setNewGenericURL('')
      setTwilioSid('')
      setTwilioToken('')
      setTwilioFrom('')
      setTwilioTo('')
      setNewLabel('')
      await load()
    } catch (e) {
      toast.error('Could not add channel', { description: getFetchErrorMessage(e) })
    } finally {
      setCreating(false)
    }
  }

  const patchChannel = async (id: string, patch: Record<string, unknown>) => {
    setSavingId(id)
    try {
      await apiFetch(`${API_BASE_URL}/api/settings/alert-channels/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      await load()
    } catch (e) {
      toast.error('Could not update channel', { description: getFetchErrorMessage(e) })
    } finally {
      setSavingId(null)
    }
  }

  const testChannel = async (id: string) => {
    setTestingId(id)
    try {
      await apiFetch(`${API_BASE_URL}/api/settings/alert-channels/${encodeURIComponent(id)}/test`, { method: 'POST' })
      toast.success('Test sent', { description: 'Check Slack, SMS, or your webhook receiver.' })
      await load()
    } catch (e) {
      toast.error('Test failed', { description: getFetchErrorMessage(e) })
    } finally {
      setTestingId(null)
    }
  }

  const deleteChannel = async (id: string) => {
    if (!window.confirm('Remove this alert channel? Per-job routing that references it will be cleared for that channel id.')) return
    setDeletingId(id)
    try {
      await apiFetch(`${API_BASE_URL}/api/settings/alert-channels/${encodeURIComponent(id)}`, { method: 'DELETE' })
      toast.success('Channel removed')
      await load()
    } catch (e) {
      toast.error('Could not remove channel', { description: getFetchErrorMessage(e) })
    } finally {
      setDeletingId(null)
    }
  }

  const kindIcon = (k: string) => {
    if (k === 'slack_webhook') return <MessageSquare className="h-3.5 w-3.5" />
    if (k === 'generic_webhook') return <Webhook className="h-3.5 w-3.5" />
    if (k === 'sms_twilio') return <Radio className="h-3.5 w-3.5" />
    return <Send className="h-3.5 w-3.5" />
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border/60 bg-card py-12 text-muted-foreground">
        <Loader2 className="h-7 w-7 motion-safe:animate-spin text-primary/60" />
        <p className="text-sm">Loading alert channels…</p>
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-4 pb-8">
      <Card className="border-border/60 py-0 gap-0 shadow-xs">
        <CardHeader className="space-y-1 border-b border-border/40 bg-gradient-to-r from-sky-500/5 to-transparent px-5 py-4">
          <CardTitle className="flex items-center gap-2 text-base font-semibold tracking-tight text-primary uppercase">
            <Send className="h-4 w-4 shrink-0" />
            Multi-channel alerts
          </CardTitle>
          <CardDescription className="text-[11px] leading-relaxed">
            Deliver the same alerts as email to Slack, a generic JSON webhook, or Twilio SMS. Secrets are encrypted at rest (
            <code className="rounded bg-muted px-1 py-px text-[10px] font-mono">CRONSENTINEL_ENV_ENCRYPTION_KEY</code>). Set{' '}
            <code className="rounded bg-muted px-1 py-px text-[10px] font-mono">CRONSENTINEL_PUBLIC_BASE_URL</code> on the server
            so links in alerts open the UI (jobs / runs tabs).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-5 py-4">
          <div className="rounded-lg border border-border/50 bg-muted/10 p-3 space-y-3">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Add channel</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">Kind</Label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
                  value={newKind}
                  onChange={e => setNewKind(e.target.value)}
                >
                  {KINDS.map(k => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Label (optional)</Label>
                <Input value={newLabel} onChange={e => setNewLabel(e.target.value)} className="h-9 text-xs" placeholder="#ops-alerts" />
              </div>
            </div>
            {newKind === 'slack_webhook' && (
              <div className="space-y-1">
                <Label className="text-xs">Slack webhook URL</Label>
                <Input
                  value={newWebhookURL}
                  onChange={e => setNewWebhookURL(e.target.value)}
                  className="h-9 text-xs font-mono"
                  placeholder="https://hooks.slack.com/services/…"
                  autoComplete="off"
                />
              </div>
            )}
            {newKind === 'generic_webhook' && (
              <div className="space-y-1">
                <Label className="text-xs">Webhook URL</Label>
                <Input
                  value={newGenericURL}
                  onChange={e => setNewGenericURL(e.target.value)}
                  className="h-9 text-xs font-mono"
                  placeholder="https://example.com/cronsentinel-hook"
                  autoComplete="off"
                />
              </div>
            )}
            {newKind === 'sms_twilio' && (
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs">Account SID</Label>
                  <Input value={twilioSid} onChange={e => setTwilioSid(e.target.value)} className="h-9 text-xs font-mono" autoComplete="off" />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs">Auth token</Label>
                  <Input
                    value={twilioToken}
                    onChange={e => setTwilioToken(e.target.value)}
                    type="password"
                    className="h-9 text-xs font-mono"
                    autoComplete="new-password"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">From (E.164)</Label>
                  <Input value={twilioFrom} onChange={e => setTwilioFrom(e.target.value)} className="h-9 text-xs font-mono" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">To (E.164)</Label>
                  <Input value={twilioTo} onChange={e => setTwilioTo(e.target.value)} className="h-9 text-xs font-mono" />
                </div>
              </div>
            )}
            <Button type="button" size="sm" className="h-8 text-xs" disabled={!canCreate || creating} onClick={() => void createChannel()}>
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Add channel'}
            </Button>
          </div>

          {channels.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">No extra channels yet. Email (SMTP) is still configured in the card above.</p>
          ) : (
            <ul className="space-y-2">
              {channels.map(ch => (
                <li
                  key={ch.id}
                  className="flex flex-col gap-2 rounded-lg border border-border/50 bg-card px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex items-start gap-2 min-w-0">
                    <span className="mt-0.5 text-muted-foreground">{kindIcon(ch.kind)}</span>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold truncate">{ch.label || ch.kind}</p>
                      <p className="text-[10px] text-muted-foreground font-mono truncate">{ch.kind}</p>
                      <label className="mt-1 flex items-center gap-2 text-[10px] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={ch.enabled}
                          disabled={savingId === ch.id}
                          onChange={e => void patchChannel(ch.id, { enabled: e.target.checked })}
                        />
                        Enabled
                      </label>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 shrink-0">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-[10px]"
                      disabled={testingId === ch.id || !ch.enabled}
                      onClick={() => void testChannel(ch.id)}
                    >
                      {testingId === ch.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Test'}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-[10px] text-destructive hover:text-destructive"
                      disabled={deletingId === ch.id}
                      onClick={() => void deleteChannel(ch.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/60 py-0 gap-0 shadow-xs">
        <CardHeader className="border-b border-border/40 px-5 py-3">
          <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Delivery log</CardTitle>
          <CardDescription className="text-[10px]">Recent attempts per channel (after retries).</CardDescription>
        </CardHeader>
        <CardContent className="px-0 py-0">
          {logItems.length === 0 ? (
            <p className="text-xs text-muted-foreground px-5 py-4">No deliveries recorded yet.</p>
          ) : (
            <div className="max-h-64 overflow-auto">
              <table className="w-full text-[10px]">
                <thead className="sticky top-0 bg-muted/40 border-b border-border/60">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">Time</th>
                    <th className="text-left font-medium px-2 py-2">Channel</th>
                    <th className="text-left font-medium px-2 py-2">Alert</th>
                    <th className="text-left font-medium px-2 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {logItems.map(row => (
                    <tr key={row.id} className="border-b border-border/40">
                      <td className="px-3 py-1.5 font-mono text-muted-foreground whitespace-nowrap">
                        {new Date(row.created_at).toLocaleString()}
                      </td>
                      <td className="px-2 py-1.5">{row.channel_label || row.channel_kind}</td>
                      <td className="px-2 py-1.5">{row.alert_type}</td>
                      <td className="px-2 py-1.5">
                        <span className={row.status === 'sent' ? 'text-[var(--cs-healthy-text)]' : 'text-destructive'}>{row.status}</span>
                        {row.error_message ? (
                          <span className="block text-muted-foreground truncate max-w-[200px]" title={row.error_message}>
                            {row.error_message}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="px-5 py-2 border-t border-border/40">
            <Button type="button" variant="ghost" size="sm" className="h-7 text-[10px]" onClick={() => void load()}>
              Refresh log
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
