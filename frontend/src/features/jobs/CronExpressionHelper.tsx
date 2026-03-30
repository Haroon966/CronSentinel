import { useMemo, useRef, useState, type ReactElement } from 'react'
import {
  AlertCircle,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Info,
  Search,
} from 'lucide-react'
import cronstrue from 'cronstrue'

import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import {
  CUSTOM_SELECT_VALUE,
  composeCronExpression,
  fieldSelectValue,
  splitCronExpression,
} from '@/features/jobs/cronFields'
import { NextRunPreviewer } from '@/features/jobs/NextRunPreviewer'

const CRON_PRESETS_ROW = [
  { label: 'Every minute', expr: '* * * * *' },
  { label: 'Every hour', expr: '0 * * * *' },
  { label: 'Daily', expr: '0 9 * * *' },
  { label: 'Weekly', expr: '0 9 * * 1' },
  { label: 'Monthly', expr: '0 9 1 * *' },
] as const

const CRON_PATTERNS = [
  {
    category: 'Common Intervals',
    patterns: [
      { label: 'Every minute', value: '* * * * *', desc: 'Runs every minute' },
      { label: 'Every 5 min', value: '*/5 * * * *', desc: 'Runs every 5 minutes' },
      { label: 'Every 15 min', value: '*/15 * * * *', desc: 'Runs every 15 minutes' },
      { label: 'Every 30 min', value: '*/30 * * * *', desc: 'Runs every 30 minutes' },
      { label: 'Every hour', value: '0 * * * *', desc: 'At the start of every hour' },
      { label: 'Every 2 hours', value: '0 */2 * * *', desc: 'Runs every 2 hours' },
      { label: 'Every 6 hours', value: '0 */6 * * *', desc: 'Runs every 6 hours' },
      { label: 'Every 12 hours', value: '0 */12 * * *', desc: 'Runs every 12 hours' },
    ],
  },
  {
    category: 'Daily Schedules',
    patterns: [
      { label: 'Daily midnight', value: '0 0 * * *', desc: 'Every day at 12:00 AM' },
      { label: 'Daily 6 AM', value: '0 6 * * *', desc: 'Every day at 6:00 AM' },
      { label: 'Daily 9 AM', value: '0 9 * * *', desc: 'Every day at 9:00 AM' },
      { label: 'Daily noon', value: '0 12 * * *', desc: 'Every day at 12:00 PM' },
      { label: 'Daily 6 PM', value: '0 18 * * *', desc: 'Every day at 6:00 PM' },
      { label: 'Daily 11 PM', value: '0 23 * * *', desc: 'Every day at 11:00 PM' },
    ],
  },
  {
    category: 'Weekly',
    patterns: [
      { label: 'Mon–Fri 9 AM', value: '0 9 * * 1-5', desc: 'Weekdays at 9:00 AM' },
      { label: 'Every Monday', value: '0 9 * * 1', desc: 'Mondays at 9:00 AM' },
      { label: 'Every Sunday', value: '0 0 * * 0', desc: 'Sundays at midnight' },
      { label: 'Weekends noon', value: '0 12 * * 6,0', desc: 'Sat & Sun at noon' },
    ],
  },
  {
    category: 'Monthly',
    patterns: [
      { label: '1st of month', value: '0 0 1 * *', desc: 'First day of every month' },
      { label: '15th of month', value: '0 0 15 * *', desc: '15th of every month' },
      { label: 'Last day (approx)', value: '0 0 28-31 * *', desc: 'Around end of month' },
    ],
  },
] as const

const MINUTE_PRESETS = ['*', '*/5', '*/10', '*/15', '*/30', '0', '15', '30', '45'] as const
const HOUR_PRESETS = ['*', '*/2', '*/3', '*/6', '*/12', '0', '6', '9', '12', '18'] as const
const DOM_PRESETS = ['*', '1', '15', '28-31'] as const
const MONTH_PRESETS = ['*', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'] as const
const DOW_PRESETS = ['*', '0', '1', '1-5', '2', '3', '4', '5', '6', '0,6'] as const

function FieldError({ msg, id }: { msg: string; id: string }): ReactElement | null {
  if (!msg) return null
  return (
    <p id={id} role="alert" className="flex items-center gap-1 text-xs text-destructive mt-1">
      <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
      {msg}
    </p>
  )
}

type FieldKey = 'minute' | 'hour' | 'dom' | 'month' | 'dow'

function CronFieldSelect({
  label,
  fieldId,
  presetValues,
  token,
  onTokenChange,
}: {
  label: string
  fieldId: string
  presetValues: readonly string[]
  token: string
  onTokenChange: (next: string) => void
}): ReactElement {
  const selectVal = fieldSelectValue(token, presetValues)
  const showCustom = selectVal === CUSTOM_SELECT_VALUE

  return (
    <div className="flex min-w-[4.5rem] flex-1 flex-col gap-1">
      <Label htmlFor={showCustom ? `${fieldId}-custom` : fieldId} className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      <Select
        value={selectVal}
        onValueChange={v => {
          if (v === CUSTOM_SELECT_VALUE) {
            onTokenChange(token.trim() || '*')
            return
          }
          onTokenChange(v)
        }}
      >
        <SelectTrigger id={fieldId} className="h-8 text-xs font-mono" aria-label={`${label} cron field`}>
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          {presetValues.map(p => (
            <SelectItem key={p} value={p} className="font-mono text-xs">
              {p}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_SELECT_VALUE} className="text-xs">
            Custom…
          </SelectItem>
        </SelectContent>
      </Select>
      {showCustom && (
        <input
          id={`${fieldId}-custom`}
          type="text"
          value={token}
          onChange={e => onTokenChange(e.target.value)}
          aria-label={`${label} custom value`}
          className="h-8 w-full rounded-md border border-border/60 px-2 font-mono text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        />
      )}
    </div>
  )
}

export function CronExpressionHelper({
  value,
  onChange,
  errors,
  id,
  presets,
  timezone,
}: {
  value: string
  onChange: (v: string) => void
  errors?: string
  id: string
  presets?: { label: string; schedule: string }[]
  timezone?: string
}): ReactElement {
  const mainInputRef = useRef<HTMLInputElement>(null)
  const [showPatterns, setShowPatterns] = useState(false)
  const [patternSearch, setPatternSearch] = useState('')
  const [clockTime, setClockTime] = useState('09:00')
  const [clockMode, setClockMode] = useState<'daily' | 'weekdays' | 'weekly-sunday'>('daily')

  const split = useMemo(() => splitCronExpression(value), [value])
  const parts: [string, string, string, string, string] | null =
    split.ok ? split.parts : null

  const setPart = (index: 0 | 1 | 2 | 3 | 4, nextToken: string): void => {
    if (!parts) {
      const fallback: [string, string, string, string, string] = ['*', '*', '*', '*', '*']
      fallback[index] = nextToken
      onChange(composeCronExpression(fallback))
      return
    }
    const next: [string, string, string, string, string] = [...parts] as [
      string,
      string,
      string,
      string,
      string,
    ]
    next[index] = nextToken
    onChange(composeCronExpression(next))
  }

  const explanation = useMemo(() => {
    try {
      if (!value.trim()) return null
      const p = value.trim().split(/\s+/).filter(Boolean)
      if (p.length !== 5) return { ok: false, text: '5 fields required (min hr dom mon dow)' }
      const text = cronstrue.toString(value.trim(), { throwExceptionOnParseError: true, verbose: true })
      return { ok: true, text }
    } catch (e) {
      return { ok: false, text: e instanceof Error ? e.message : 'Invalid expression' }
    }
  }, [value])

  const filteredPatterns = CRON_PATTERNS.map(cat => ({
    ...cat,
    patterns: cat.patterns.filter(
      p =>
        !patternSearch ||
        p.label.toLowerCase().includes(patternSearch.toLowerCase()) ||
        p.desc.toLowerCase().includes(patternSearch.toLowerCase()) ||
        p.value.includes(patternSearch),
    ),
  })).filter(cat => cat.patterns.length > 0)

  const describeIds = [errors ? `${id}-error` : null, explanation ? `${id}-explain` : null, `${id}-next-preview`]
    .filter(Boolean)
    .join(' ')

  const fieldIds: Record<FieldKey, string> = {
    minute: `${id}-field-minute`,
    hour: `${id}-field-hour`,
    dom: `${id}-field-dom`,
    month: `${id}-field-month`,
    dow: `${id}-field-dow`,
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Schedule presets">
        {CRON_PRESETS_ROW.map(p => (
          <Button
            key={p.label}
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-xs px-2"
            onClick={() => onChange(p.expr)}
          >
            {p.label}
          </Button>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 text-xs px-2"
          onClick={() => mainInputRef.current?.focus()}
          aria-label="Custom: focus cron expression field"
        >
          Custom
        </Button>
      </div>

      <div className="flex gap-1.5">
        <div className="relative flex-1">
          <input
            ref={mainInputRef}
            id={id}
            type="text"
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder="*/5 * * * *"
            aria-invalid={!!errors}
            aria-describedby={describeIds || undefined}
            className={`h-8 w-full rounded-md border border-input bg-card font-mono text-xs px-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${errors ? 'border-destructive' : 'border-border/60'}`}
          />
          <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
            {explanation?.ok ? (
              <Check className="h-3 w-3 text-[var(--cs-healthy)]" aria-hidden="true" />
            ) : value.trim() ? (
              <AlertCircle className="h-3 w-3 text-destructive" aria-hidden="true" />
            ) : (
              <Clock className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
            )}
          </div>
        </div>
        {presets && presets.length > 0 && (
          <Select onValueChange={v => onChange(v)}>
            <SelectTrigger className="h-8 w-28 text-xs" aria-label="Job template schedule preset">
              <SelectValue placeholder="Preset" />
            </SelectTrigger>
            <SelectContent>
              {presets.map(p => (
                <SelectItem key={p.schedule} value={p.schedule} className="text-xs">
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div
        className="flex flex-wrap gap-2 rounded border border-border/50 bg-muted/10 p-2"
        role="group"
        aria-label="Cron fields: minute, hour, day of month, month, day of week"
      >
        {parts ? (
          <>
            <CronFieldSelect
              label="Min"
              fieldId={fieldIds.minute}
              presetValues={MINUTE_PRESETS}
              token={parts[0]}
              onTokenChange={v => setPart(0, v)}
            />
            <CronFieldSelect
              label="Hour"
              fieldId={fieldIds.hour}
              presetValues={HOUR_PRESETS}
              token={parts[1]}
              onTokenChange={v => setPart(1, v)}
            />
            <CronFieldSelect
              label="Day"
              fieldId={fieldIds.dom}
              presetValues={DOM_PRESETS}
              token={parts[2]}
              onTokenChange={v => setPart(2, v)}
            />
            <CronFieldSelect
              label="Month"
              fieldId={fieldIds.month}
              presetValues={MONTH_PRESETS}
              token={parts[3]}
              onTokenChange={v => setPart(3, v)}
            />
            <CronFieldSelect
              label="DOW"
              fieldId={fieldIds.dow}
              presetValues={DOW_PRESETS}
              token={parts[4]}
              onTokenChange={v => setPart(4, v)}
            />
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Enter five space-separated fields above to use the field builder, or pick a preset.
          </p>
        )}
      </div>

      <div className="rounded border border-border/50 bg-card p-2">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-muted-foreground">Clock Helper</span>
          <span className="text-xs text-muted-foreground tabular-nums">TZ: {timezone || 'Local'}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            type="time"
            value={clockTime}
            onChange={e => setClockTime(e.target.value)}
            aria-label="Time of day for clock helper"
            className="h-8 rounded-md border border-border/60 px-2 text-xs"
          />
          <Select value={clockMode} onValueChange={v => setClockMode(v as typeof clockMode)}>
            <SelectTrigger className="h-8 w-36 text-xs" aria-label="Clock helper repeat pattern">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekdays">Weekdays</SelectItem>
              <SelectItem value="weekly-sunday">Weekly (Sunday)</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => {
              const [hhRaw, mmRaw] = clockTime.split(':')
              const hh = Number.parseInt(hhRaw, 10)
              const mm = Number.parseInt(mmRaw, 10)
              if (!Number.isFinite(hh) || !Number.isFinite(mm)) return
              const dow = clockMode === 'daily' ? '*' : clockMode === 'weekdays' ? '1-5' : '0'
              onChange(`${mm} ${hh} * * ${dow}`)
            }}
          >
            Use clock
          </Button>
        </div>
      </div>

      {explanation && (
        <div
          id={`${id}-explain`}
          className={`flex items-start gap-1.5 rounded border px-2.5 py-1.5 text-xs ${explanation.ok ? 'border-[var(--cs-healthy-border)] bg-[var(--cs-healthy-bg)] text-[var(--cs-healthy-text)]' : 'border-[var(--cs-failed-border)] bg-[var(--cs-failed-bg)] text-[var(--cs-failed-text)]'}`}
        >
          <Info className="h-3 w-3 shrink-0 mt-0.5" aria-hidden="true" />
          <span className="italic">{explanation.text}</span>
        </div>
      )}

      <NextRunPreviewer expression={value} idPrefix={id} />

      <div className="rounded border border-border/50 overflow-hidden">
        <button
          type="button"
          onClick={() => setShowPatterns(v => !v)}
          className="w-full flex items-center justify-between px-2.5 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted/30 transition-colors motion-reduce:transition-none"
          aria-expanded={showPatterns}
        >
          <span className="flex items-center gap-1.5">
            <CalendarClock className="h-3 w-3" aria-hidden="true" />
            Quick Patterns
          </span>
          {showPatterns ? <ChevronUp className="h-3 w-3" aria-hidden="true" /> : <ChevronDown className="h-3 w-3" aria-hidden="true" />}
        </button>
        {showPatterns && (
          <div className="border-t border-border/40 bg-card p-2 space-y-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" aria-hidden="true" />
              <input
                type="search"
                placeholder="Search patterns…"
                value={patternSearch}
                onChange={e => setPatternSearch(e.target.value)}
                aria-label="Search quick patterns"
                className="h-8 w-full rounded-md border border-border/50 bg-card pl-7 pr-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              />
            </div>
            <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
              {filteredPatterns.map(cat => (
                <div key={cat.category}>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">{cat.category}</p>
                  <div className="grid grid-cols-2 gap-1">
                    {cat.patterns.map(p => (
                      <button
                        key={p.value}
                        type="button"
                        onClick={() => {
                          onChange(p.value)
                          setShowPatterns(false)
                        }}
                        className="text-left rounded border border-border/50 px-2 py-1.5 hover:border-primary/40 hover:bg-primary/5 transition-colors"
                      >
                        <p className="font-mono text-xs text-primary">{p.value}</p>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">{p.desc}</p>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {filteredPatterns.length === 0 && (
                <p className="text-center text-xs text-muted-foreground py-3">No patterns found for &quot;{patternSearch}&quot;</p>
              )}
            </div>
          </div>
        )}
      </div>

      {errors && <FieldError msg={errors} id={`${id}-error`} />}
    </div>
  )
}
