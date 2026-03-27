import { Activity, Clock, FileCode2 } from 'lucide-react'
import type { ReactNode } from 'react'

type Tab = 'jobs' | 'scripts' | 'runs'

type MainTabsProps = {
  activeTab: Tab
  onTabChange: (tab: Tab) => void
  counts: Record<Tab, number>
}

export function MainTabs({ activeTab, onTabChange, counts }: MainTabsProps) {
  const tabs: [Tab, ReactNode, string][] = [
    ['jobs', <Clock key="jobs" className="h-3.5 w-3.5" />, 'Cron Jobs'],
    ['scripts', <FileCode2 key="scripts" className="h-3.5 w-3.5" />, 'Scripts'],
    ['runs', <Activity key="runs" className="h-3.5 w-3.5" />, 'Run History'],
  ]

  return (
    <div className="shrink-0 border-b border-border/50 bg-white px-4 flex items-center gap-0 h-11" role="tablist" aria-label="Main navigation tabs">
      {tabs.map(([id, icon, label]) => (
        <button
          key={id}
          onClick={() => onTabChange(id)}
          id={`tab-${id}`}
          role="tab"
          aria-controls={`panel-${id}`}
          className={`flex items-center gap-1.5 px-4 h-full border-b-2 text-xs font-semibold transition-colors ${
            activeTab === id
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
          }`}
          aria-selected={activeTab === id}
          tabIndex={activeTab === id ? 0 : -1}
        >
          {icon}
          {label}
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
            activeTab === id ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
          }`}>
            {counts[id]}
          </span>
        </button>
      ))}
    </div>
  )
}
