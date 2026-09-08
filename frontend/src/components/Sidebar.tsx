import { useState } from 'react'
import { Search, BookmarkCheck, ShieldCheck, X, Settings, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { getAlgoGroup, GROUP_ORDER, type AlgoGroup } from '@/lib/algo-metadata'
import { LocaleFlags } from '@/components/LocaleFlags'
import type { Algorithm, LocalePref } from '@/types'

interface Props {
  algorithms: Algorithm[]
  /** Why the list is empty, when it is empty because the server could not produce it. */
  loadError: string | null
  activeClassName: string | null
  onSelect: (algo: Algorithm) => void
  onShowSaved: () => void
  onOpenSettings: () => void
  onGoHome: () => void
  localePref: LocalePref
  onLocaleChange: (pref: LocalePref) => void
  onClose?: () => void
}

export function Sidebar({ algorithms, loadError, activeClassName, onSelect, onShowSaved, onOpenSettings, onGoHome, localePref, onLocaleChange, onClose }: Props) {
  const { t } = useT()
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(
    () => Object.fromEntries(GROUP_ORDER.map(g => [g, true]))
  )

  const toggleGroup = (group: AlgoGroup) =>
    setCollapsed(prev => ({ ...prev, [group]: !prev[group] }))

  const filtered = algorithms.filter((a) =>
    query === '' || a.displayName.toLowerCase().includes(query.toLowerCase())
  )

  const grouped = GROUP_ORDER.reduce<Record<AlgoGroup, Algorithm[]>>((acc, g) => {
    acc[g] = []
    return acc
  }, {} as Record<AlgoGroup, Algorithm[]>)
  for (const algo of filtered) {
    const g = getAlgoGroup(algo.className)
    if (!grouped[g]) grouped[g] = []
    grouped[g].push(algo)
  }
  const visibleGroups = GROUP_ORDER.filter(g => grouped[g]?.length > 0)

  return (
    <div className="flex flex-col h-full bg-slate-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-4 flex-shrink-0">
        <button
          onClick={onGoHome}
          title={t('sidebar.home')}
          className="flex items-center gap-2 -ml-1 px-1 py-0.5 rounded-lg text-left hover:bg-slate-800 transition-colors"
        >
          <ShieldCheck size={18} className="text-blue-400" />
          <span className="text-white font-semibold text-sm">{t('app.name')}</span>
        </button>
        {onClose && (
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <X size={18} />
          </button>
        )}
      </div>

      {/* Search */}
      <div className="px-3 pb-2 flex-shrink-0">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('sidebar.search')}
            className="w-full pl-7 pr-3 py-1.5 text-sm bg-slate-800 text-slate-200 border border-slate-700 rounded-lg placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
      </div>

      {/* Algorithm list */}
      <nav className="flex-1 overflow-auto px-2 py-1">
        {loadError ? (
          <div className="mx-1 my-4 px-3 py-2 rounded-lg bg-red-950 border border-red-900 text-xs text-red-200">
            <p className="font-medium">{t('sidebar.loadFailed')}</p>
            <p className="mt-1 text-red-300 break-words">{loadError}</p>
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-slate-500 text-xs text-center py-6">{t('sidebar.noResults')}</p>
        ) : query !== '' ? (
          /* Flat list when searching */
          filtered.map((algo) => (
            <AlgoButton key={algo.className} algo={algo} active={activeClassName === algo.className} onSelect={onSelect} />
          ))
        ) : (
          /* Grouped sections */
          visibleGroups.map((group) => (
            <div key={group} className="mb-1">
              <button
                onClick={() => toggleGroup(group)}
                className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-semibold text-slate-400 hover:text-slate-200 uppercase tracking-wider transition-colors"
              >
                {collapsed[group]
                  ? <ChevronRight size={12} className="flex-shrink-0" />
                  : <ChevronDown size={12} className="flex-shrink-0" />
                }
                {t(`group.${group}`)}
              </button>
              {!collapsed[group] && grouped[group].map((algo) => (
                <AlgoButton key={algo.className} algo={algo} active={activeClassName === algo.className} onSelect={onSelect} />
              ))}
            </div>
          ))
        )}
      </nav>

      {/* Footer */}
      <div className="px-3 py-3 border-t border-slate-800 flex-shrink-0 space-y-1">
        <button
          onClick={onShowSaved}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
        >
          <BookmarkCheck size={15} />
          {t('sidebar.savedTests')}
        </button>
        <button
          onClick={onOpenSettings}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
        >
          <Settings size={15} />
          {t('sidebar.settings')}
        </button>
        <LocaleFlags pref={localePref} onChange={onLocaleChange} />
      </div>
    </div>
  )
}

function AlgoButton({ algo, active, onSelect }: { algo: Algorithm; active: boolean; onSelect: (a: Algorithm) => void }) {
  return (
    <button
      onClick={() => onSelect(algo)}
      className={cn(
        'w-full text-left px-3 py-2 rounded-lg text-sm transition-colors mb-0.5',
        active
          ? 'bg-blue-600 text-white'
          : 'text-slate-300 hover:bg-slate-800 hover:text-white'
      )}
    >
      {algo.displayName}
    </button>
  )
}
