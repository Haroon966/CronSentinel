import { useCallback, useEffect, useState } from 'react'
import { Copy, ExternalLink, Key, Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  API_BASE_URL,
  createApiKey,
  fetchApiKeys,
  getFetchErrorMessage,
  revokeApiKey,
  type ApiKeyListItem,
} from '@/lib/api'

const DOCS_URL = `${API_BASE_URL}/api/docs`

export function ApiKeysSettings() {
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<ApiKeyListItem[]>([])
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [revealedKey, setRevealedKey] = useState<string | null>(null)
  const [revokeId, setRevokeId] = useState<string | null>(null)
  const [revoking, setRevoking] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = await fetchApiKeys()
      setItems(list)
    } catch (e) {
      toast.error('Could not load API keys', { description: getFetchErrorMessage(e) })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const onCreate = async () => {
    const n = name.trim()
    if (!n) {
      toast.error('Enter a name for this key')
      return
    }
    setCreating(true)
    try {
      const res = await createApiKey(n)
      setName('')
      setRevealedKey(res.key)
      await load()
      toast.success('API key created — copy it now; it will not be shown again.')
    } catch (e) {
      toast.error('Could not create API key', { description: getFetchErrorMessage(e) })
    } finally {
      setCreating(false)
    }
  }

  const doRevoke = async () => {
    if (!revokeId) return
    setRevoking(true)
    try {
      await revokeApiKey(revokeId)
      toast.success('API key revoked')
      setRevokeId(null)
      await load()
    } catch (e) {
      toast.error('Could not revoke API key', { description: getFetchErrorMessage(e) })
    } finally {
      setRevoking(false)
    }
  }

  const copyKey = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Copied to clipboard')
    } catch {
      toast.error('Could not copy')
    }
  }

  return (
    <Card className="border-border/60">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <Key className="h-4 w-4 text-primary" aria-hidden />
          REST API keys
        </CardTitle>
        <CardDescription>
          Use keys with{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-[11px]">Authorization: Bearer &lt;key&gt;</code> on{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-[11px]">/api/v1</code>. Rate limit: 1000 requests per hour per
          key.
        </CardDescription>
        <div className="pt-2">
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
          >
            Open API reference (Swagger UI)
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="api-key-name">New key name</Label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Input
              id="api-key-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. CI deploy"
              className="max-w-md"
              autoComplete="off"
              disabled={creating}
            />
            <Button type="button" onClick={() => void onCreate()} disabled={creating || !name.trim()}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create key'}
            </Button>
          </div>
        </div>

        {revealedKey && (
          <div
            role="status"
            className="rounded-md border border-border border-dashed bg-muted/40 p-3 text-sm"
            aria-live="polite"
          >
            <p className="font-medium text-foreground">Copy this secret now</p>
            <p className="mt-1 text-xs text-muted-foreground">It is only shown once.</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="break-all rounded bg-background px-2 py-1 text-xs">{revealedKey}</code>
              <Button type="button" size="sm" variant="secondary" onClick={() => void copyKey(revealedKey)}>
                <Copy className="h-3.5 w-3.5" aria-hidden />
                Copy
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setRevealedKey(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Loading keys…
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No API keys yet. Create one to use the REST API from scripts or CI.</p>
        ) : (
          <ul className="space-y-2" aria-label="API keys">
            {items.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-2 rounded-md border border-border/60 bg-card/50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <div className="font-medium text-foreground">{row.name}</div>
                  <div className="text-xs text-muted-foreground">
                    <span className="font-mono">{row.key_prefix}…</span>
                    <span className="mx-2">·</span>
                    created {new Date(row.created_at).toLocaleString()}
                    {row.revoked_at && (
                      <span className="text-destructive"> · revoked {new Date(row.revoked_at).toLocaleString()}</span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  {!row.revoked_at && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10"
                      onClick={() => setRevokeId(row.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      Revoke
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <AlertDialog open={revokeId !== null} onOpenChange={(v) => !v && setRevokeId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke API key?</AlertDialogTitle>
            <AlertDialogDescription>
              Scripts using this key will receive 401 until you create a new key and update them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={revoking}
              onClick={() => void doRevoke()}
            >
              {revoking ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Revoke'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
