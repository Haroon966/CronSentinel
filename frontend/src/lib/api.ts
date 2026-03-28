/** Backend origin. Empty env values are ignored so requests don't hit the Vite dev server (which returns 404 for /api/*). */
function resolveApiBaseURL(): string {
  const raw = import.meta.env.VITE_API_BASE_URL
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (trimmed !== '') return trimmed.replace(/\/$/, '')
  // Same-origin in dev: Vite proxies /api → backend (see vite.config.ts)
  if (import.meta.env.DEV) return ''
  return 'http://localhost:8080'
}

export const API_BASE_URL = resolveApiBaseURL()

/** HTTP error from the API with optional parsed message. */
export class ApiError extends Error {
  readonly status: number
  readonly bodySnippet?: string

  constructor(message: string, status: number, options?: { cause?: unknown; bodySnippet?: string }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'ApiError'
    this.status = status
    this.bodySnippet = options?.bodySnippet
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError
}

/** Human-readable message for any thrown API/network error. */
export function getFetchErrorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) {
    if (e.name === 'AbortError') return 'The request was cancelled.'
    return e.message
  }
  return 'Something went wrong. Please try again.'
}

function messageForHttpStatus(status: number): string {
  if (status === 401 || status === 403) return 'You are not allowed to perform this action.'
  if (status === 404) return 'API not found. Rebuild or restart the backend, or check the API URL.'
  if (status === 408 || status === 504) return 'The server took too long to respond. Try again.'
  if (status >= 500) return `Server error (${status}). Try again in a moment.`
  if (status === 400) return 'The server could not accept this request.'
  return `Request failed (${status}).`
}

function parseErrorPayload(text: string, status: number): string {
  const fallback = messageForHttpStatus(status)
  if (!text.trim()) return fallback
  try {
    const j = JSON.parse(text) as { error?: string; message?: string }
    if (typeof j.error === 'string' && j.error.trim()) return j.error.trim()
    if (typeof j.message === 'string' && j.message.trim()) return j.message.trim()
  } catch {
    const snippet = text.slice(0, 200).trim()
    if (snippet && !snippet.startsWith('<')) return snippet
  }
  return fallback
}

export async function apiFetch<T = unknown>(url: string, opts?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, opts)
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error('The request was cancelled.', { cause: e })
    }
    throw new Error(
      'Cannot reach the server. Check that the API is running and your network connection.',
      { cause: e },
    )
  }

  const text = await res.text()

  if (!res.ok) {
    const msg = parseErrorPayload(text, res.status)
    throw new ApiError(msg, res.status, { bodySnippet: text ? text.slice(0, 500) : undefined })
  }

  if (!text.trim()) return null as T

  try {
    return JSON.parse(text) as T
  } catch (e) {
    throw new ApiError('The server returned invalid data (not JSON). Try refreshing the page.', res.status, {
      cause: e,
      bodySnippet: text.slice(0, 200),
    })
  }
}
