export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080'

export async function apiFetch<T = unknown>(url: string, opts?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, opts)
  } catch {
    throw new Error('Cannot reach the server. Check your connection and retry.')
  }

  if (!res.ok) {
    let msg = `Server error (${res.status})`
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) msg = body.error
    } catch {
      // Keep generic error message if payload is not JSON.
    }
    throw new Error(msg)
  }

  const text = await res.text()
  return (text ? JSON.parse(text) : null) as T
}
