import type { ReactElement } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'

type LogHighlighterProps = {
  text: string
  /** Accent for stderr vs stdout */
  variant?: 'stdout' | 'stderr'
  /** Compact height for inline run row; false for modal */
  dense?: boolean
}

/** Syntax-highlighted log block (shell-like grammar). */
export function LogHighlighter({ text, variant = 'stdout', dense = true }: LogHighlighterProps): ReactElement {
  const lineColor = variant === 'stderr' ? 'var(--cs-failed-text)' : 'var(--cs-healthy-text)'
  return (
    <SyntaxHighlighter
      language="bash"
      style={oneDark}
      PreTag="div"
      showLineNumbers={false}
      wrapLines
      lineProps={() => ({
        style: { wordBreak: 'break-word', whiteSpace: 'pre-wrap' as const },
      })}
      customStyle={{
        margin: 0,
        padding: '0.5rem 0.75rem',
        background: 'var(--cs-bg-sunken)',
        fontSize: '12px',
        lineHeight: 1.5,
        borderRadius: '0.5rem',
        maxHeight: dense ? '10rem' : 'min(70vh, 28rem)',
        overflow: 'auto',
        border: '1px solid var(--cs-border-medium)',
      }}
      codeTagProps={{
        style: { fontFamily: 'var(--font-mono), ui-monospace, monospace', color: lineColor },
      }}
    >
      {text || ' '}
    </SyntaxHighlighter>
  )
}
