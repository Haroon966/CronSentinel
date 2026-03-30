"use client"

import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useState, type ReactElement } from 'react'

import { Button } from '@/components/ui/button'

/** Toggles `data-theme` on &lt;html&gt; (storage key `cs-theme`). */
export function ThemeToggle(): ReactElement {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    // One-time client gate so the icon matches `resolvedTheme` after next-themes hydrates.
    queueMicrotask(() => setMounted(true))
  }, [])

  if (!mounted) {
    return (
      <Button type="button" variant="outline" size="icon-sm" className="shrink-0" disabled aria-hidden="true">
        <Sun className="h-3.5 w-3.5" />
      </Button>
    )
  }

  const isDark = resolvedTheme === 'dark'

  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      className="shrink-0"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {isDark ? <Sun className="h-3.5 w-3.5" aria-hidden="true" /> : <Moon className="h-3.5 w-3.5" aria-hidden="true" />}
    </Button>
  )
}
