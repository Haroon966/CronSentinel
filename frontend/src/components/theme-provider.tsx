"use client"

import { ThemeProvider as NextThemesProvider } from 'next-themes'
import type { ReactNode, ReactElement } from 'react'

export function ThemeProvider({ children }: { children: ReactNode }): ReactElement {
  return (
    <NextThemesProvider attribute="data-theme" defaultTheme="system" enableSystem storageKey="cs-theme">
      {children}
    </NextThemesProvider>
  )
}
