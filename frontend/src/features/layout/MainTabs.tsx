import { Activity, Clock, FileCode2, LayoutDashboard, Server, Settings } from 'lucide-react'
import type { ReactNode } from 'react'

type Tab = 'dashboard' | 'jobs' | 'scripts' | 'runs' | 'servers' | 'settings'

type MainTabsProps = {
  activeTab: Tab
  onTabChange: (tab: Tab) => void
  counts: Record<Tab, number>
}

export function MainTabs({ activeTab, onTabChange, counts }: MainTabsProps) {
  const tabs: [Tab, ReactNode, string][] = [
    ['dashboard', <LayoutDashboard key="dashboard" className="h-3.5 w-3.5" />, 'Dashboard'],
    ['jobs', <Clock key="jobs" className="h-3.5 w-3.5" />, 'Cron Jobs'],
    ['scripts', <FileCode2 key="scripts" className="h-3.5 w-3.5" />, 'Scripts'],
    ['runs', <Activity key="runs" className="h-3.5 w-3.5" />, 'Run History'],
    ['servers', <Server key="servers" className="h-3.5 w-3.5" />, 'Servers'],
    ['settings', <Settings key="settings" className="h-3.5 w-3.5" />, 'Settings'],
  ]

  return (
    <div
      className="flex min-w-0 flex-1 items-stretch gap-0 overflow-x-auto"
      role="tablist"
      aria-label="Main navigation tabs"
    >
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
          <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold tabular-nums ${
            activeTab === id ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
          }`}>
            {id === 'settings' ? '—' : counts[id]}
          </span>
        </button>
      ))}
    </div>
  )
}
