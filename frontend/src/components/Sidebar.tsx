import { useEffect, useRef, useState } from 'react'
import {
  Search, ShieldCheck, X, Settings, ChevronDown, ChevronRight,
  MoreHorizontal, Server, Plus, Check, Layers,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useT, type MessageKey } from '@/lib/i18n'
import { useAlgorithms } from '@/lib/algorithms'
import { useDomains } from '@/lib/domains'
import { useClassifiers } from '@/lib/classifiers'
import { useProfileSets } from '@/lib/profile-sets'
import { useBuiltinReferences } from '@/lib/references'
import {
  GROUP_MODES, groupAlgorithms, groupClassifiers, groupDomains, groupFrameworks, scopeOfSet,
  type Bucket, type GroupMode, type GroupableSection, type GroupingData,
} from '@/lib/grouping'
import { LocaleFlags } from '@/components/LocaleFlags'
import { useVersion } from '@/lib/version'
import type { Algorithm, Classifier, Domain, Framework, LocalePref, ProfileSet } from '@/types'

/**
 * The five macro sections. Those not built yet are announced and disabled — the shape of the
 * tool is easier to read with them visible than with them missing, and a disabled row promises
 * less than one that expands into nothing.
 */
const SECTIONS = ['frameworks', 'algorithms', 'domains', 'classifiers', 'profileSets'] as const
type SectionId = (typeof SECTIONS)[number]
const BUILT: SectionId[] = ['frameworks', 'algorithms', 'domains', 'classifiers', 'profileSets']

/** Open/closed state for both levels, remembered across reloads. */
const PREF_KEY = 'dlpx.sidebar.open'
/** How each section is grouped, remembered the same way. */
const GROUP_KEY = 'dlpx.sidebar.groupBy'

type OpenState = Record<string, boolean>
type GroupingState = Record<GroupableSection, GroupMode>

/** What each section grouped by before there was a choice. */
const DEFAULT_GROUPING: GroupingState = {
  frameworks: 'category', algorithms: 'framework', domains: 'framework', classifiers: 'domain',
}

function readGrouping(): GroupingState {
  try {
    const raw = localStorage.getItem(GROUP_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<GroupingState>
      // Only modes the section still offers: a value from an older build must not strand a
      // section on a grouping that no longer exists.
      const out = { ...DEFAULT_GROUPING }
      for (const section of Object.keys(DEFAULT_GROUPING) as GroupableSection[]) {
        const mode = saved[section]
        if (mode && (GROUP_MODES[section] as readonly string[]).includes(mode)) out[section] = mode
      }
      return out
    }
  } catch { /* private mode, cleared storage, or a value from an older shape */ }
  return { ...DEFAULT_GROUPING }
}

function readOpen(): OpenState {
  try {
    const raw = localStorage.getItem(PREF_KEY)
    if (raw) return JSON.parse(raw) as OpenState
  } catch { /* private mode, cleared storage, or a value from an older shape */ }
  // Frameworks open and its categories closed is the state the sidebar had before sections
  // existed, so nothing moves for someone who just updated.
  return { 'section:frameworks': true }
}

interface Props {
  frameworks: Framework[]
  /** Why the framework list is empty, when it is empty because the server could not produce it. */
  loadError: string | null
  activeClassName: string | null
  activeAlgorithmId: number | null
  activeDomainId: number | null
  activeClassifierId: number | null
  activeProfileSetId: number | null
  onSelectFramework: (framework: Framework) => void
  onSelectAlgorithm: (algorithm: Algorithm, framework: Framework) => void
  onNewAlgorithm: () => void
  onSelectDomain: (domain: Domain) => void
  onNewDomain: () => void
  onSelectClassifier: (classifier: Classifier) => void
  onNewClassifier: () => void
  onSelectProfileSet: (profileSet: ProfileSet) => void
  onNewProfileSet: () => void
  onOpenSettings: () => void
  onGoHome: () => void
  localePref: LocalePref
  onLocaleChange: (pref: LocalePref) => void
  onClose?: () => void
}

export function Sidebar({
  frameworks, loadError, activeClassName, activeAlgorithmId, activeDomainId, activeClassifierId,
  activeProfileSetId,
  onSelectFramework, onSelectAlgorithm, onNewAlgorithm, onSelectDomain, onNewDomain, onSelectClassifier, onNewClassifier,
  onSelectProfileSet, onNewProfileSet,
  onOpenSettings, onGoHome, localePref, onLocaleChange, onClose,
}: Props) {
  const { t } = useT()
  const { algorithms } = useAlgorithms()
  const { domains } = useDomains()
  const { classifiers } = useClassifiers()
  const { profileSets } = useProfileSets()
  // Which framework each plugin built-in configures. Most domains point at one of those rather
  // than at a saved algorithm, so without it three of the groupings collapse into "other".
  const builtins = useBuiltinReferences()
  const [query, setQuery] = useState('')
  // null is "every profile set" — the filter narrows, it never decides what a section is.
  const [setFilter, setSetFilter] = useState<number | null>(null)
  const [open, setOpen] = useState<OpenState>(readOpen)
  const [grouping, setGrouping] = useState<GroupingState>(readGrouping)

  useEffect(() => {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(open)) } catch { /* not worth failing over */ }
  }, [open])

  useEffect(() => {
    try { localStorage.setItem(GROUP_KEY, JSON.stringify(grouping)) } catch { /* same */ }
  }, [grouping])

  const regroup = (section: GroupableSection, mode: GroupMode) =>
    setGrouping(prev => ({ ...prev, [section]: mode }))

  /**
   * Groups are an accordion too: opening one closes every other group, in any section. Closing
   * one closes only that one.
   */
  const toggle = (key: string) => setOpen(prev => {
    const next = { ...prev }
    if (!prev[key]) {
      for (const other of Object.keys(next)) {
        if (!other.startsWith('section:')) next[other] = false
      }
    }
    next[key] = !prev[key]
    return next
  })

  /**
   * Sections are an accordion: opening one closes the rest.
   *
   * Only one section's worth of content is ever worth scrolling through at a time, and with
   * Frameworks fully expanded the Algorithms header was already pushed off the bottom. Closing
   * a section leaves it closed — this only ever opens one, never forces one open.
   *
   * Group state is untouched here; groups have their own accordion in `toggle`.
   */
  const toggleSection = (id: SectionId) => setOpen(prev => {
    const next = { ...prev }
    for (const other of SECTIONS) next[`section:${other}`] = false
    next[`section:${id}`] = !prev[`section:${id}`]
    return next
  })

  /**
   * "New algorithm" has nothing to create yet, unlike a new domain or classifier: an algorithm
   * *is* a framework you configured and named, so the only honest first step is choosing the
   * framework. The sidebar clears itself out of the way — every section and every category shut,
   * Frameworks open on its nine categories — and the panel says what to do with it.
   */
  const startNewAlgorithm = () => {
    // A filter still in the box would hide most of what there is to choose from.
    setQuery('')
    // Replaces the whole map rather than merging: every other key goes missing, which is closed.
    setOpen(() => ({ 'section:frameworks': true }))
    onNewAlgorithm()
  }

  /** An algorithm whose framework is missing from the plugin cannot be opened — say so here
   *  rather than letting the panel mount against nothing. */
  const openAlgorithm = (algorithm: Algorithm) => {
    const framework = frameworks.find(f => f.className === algorithm.framework)
    if (!framework) { toast.error(t('saved.frameworkNotFound')); return }
    onSelectAlgorithm(algorithm, framework)
  }

  const q = query.trim().toLowerCase()
  const matchFramework = (f: Framework) => f.displayName.toLowerCase().includes(q)
  const matchAlgorithm = (a: Algorithm) =>
    a.name.toLowerCase().includes(q) || a.display_name.toLowerCase().includes(q)

  const matchDomain = (d: Domain) =>
    d.name.toLowerCase().includes(q) || d.default_algorithm.toLowerCase().includes(q)

  const matchClassifier = (c: Classifier) =>
    c.name.toLowerCase().includes(q) || c.domain_name.toLowerCase().includes(q)

  // A set is found by its own name or by a classifier in it — which is how someone asks "which
  // set runs this classifier?" without opening each one.
  const matchProfileSet = (s: ProfileSet) =>
    s.name.toLowerCase().includes(q) || s.classifiers.some(c => c.name.toLowerCase().includes(q))

  const data: GroupingData = {
    algorithms, domains, classifiers, profileSets,
    builtinFrameworks: builtins?.frameworkOf ?? {},
  }

  /**
   * The second filter: one profile set, and only what it reaches.
   *
   * Followed outwards the way the sync follows it — the set's classifiers, the domains they vote
   * for, those domains' algorithms, and the frameworks behind them — so picking a set turns the
   * whole sidebar into the working set for one compliance rule. Null leaves every section alone.
   */
  const chosenSet = setFilter === null ? null : profileSets.find(s => s.id === setFilter) ?? null
  const scope = chosenSet ? scopeOfSet(chosenSet, data) : null

  const filter = <T,>(rows: T[], matches: (row: T) => boolean, inScope: (row: T) => boolean) => {
    let out = rows
    if (scope) out = out.filter(inScope)
    if (q) out = out.filter(matches)
    return out
  }

  const shownFrameworks = filter(frameworks, matchFramework, f => scope!.frameworkClasses.has(f.className))
  const shownAlgorithms = filter(algorithms, matchAlgorithm, a => scope!.algorithmNames.has(a.name))
  const shownDomains = filter(domains, matchDomain, d => scope!.domainNames.has(d.name))
  const shownClassifiers = filter(classifiers, matchClassifier, c => scope!.classifierIds.has(c.id))
  const shownProfileSets = filter(profileSets, matchProfileSet, s => s.id === setFilter)

  // A text search flattens every section: a heading you would have to open first is in the way
  // of an answer you already asked for by name. The set filter leaves the grouping alone.
  const flat = q !== ''
  const buckets = {
    frameworks: flat ? [] : groupFrameworks(shownFrameworks, grouping.frameworks, t),
    algorithms: flat ? [] : groupAlgorithms(shownAlgorithms, grouping.algorithms, data, t),
    domains: flat ? [] : groupDomains(shownDomains, grouping.domains, data, t),
    classifiers: flat ? [] : groupClassifiers(shownClassifiers, grouping.classifiers, data, t),
  }

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

      {/* Two filters, and they narrow together. The text one reaches every section — a name is
          found without knowing which one it lives in — and the profile set one keeps only what
          that set reaches, all the way out to the frameworks behind it. */}
      <div className="px-3 pb-2 flex-shrink-0 space-y-1.5">
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
        {profileSets.length > 0 && (
          <div className="relative">
            <Layers size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <select
              value={setFilter ?? ''}
              onChange={(e) => setSetFilter(e.target.value === '' ? null : Number(e.target.value))}
              title={t('sidebar.profileSetFilter')}
              className={cn(
                'w-full pl-7 pr-3 py-1.5 text-sm bg-slate-800 border border-slate-700 rounded-lg appearance-none',
                'focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500',
                setFilter === null ? 'text-slate-500' : 'text-slate-200'
              )}
            >
              <option value="">{t('sidebar.profileSetAll')}</option>
              {profileSets.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        )}
      </div>

      <nav className="flex-1 overflow-auto px-2 py-1">
        {SECTIONS.map((id) => {
          const built = BUILT.includes(id)
          // Filtering opens whatever still has something in it: a section that answers the
          // filter but stays shut is a count nobody asked for, in place of the answer.
          const filtering = q !== '' || setFilter !== null
          const isOpen = built && (filtering ? true : !!open[`section:${id}`])
          // A section with no match collapses out of the way on its own.
          const count = id === 'frameworks' ? shownFrameworks.length
            : id === 'algorithms' ? shownAlgorithms.length
            : id === 'domains' ? shownDomains.length
            : id === 'classifiers' ? shownClassifiers.length
            : id === 'profileSets' ? shownProfileSets.length : 0
          if (filtering && built && count === 0) return null

          return (
            // The whole open section — header, categories and items — sits on a lighter panel
            // with a blue edge, so where you are browsing reads at a glance even deep in a long
            // list, not only while the header is still on screen.
            <div key={id} className={cn(
              'mb-0.5 rounded-lg border-l-2 transition-colors',
              isOpen ? 'bg-slate-800 border-blue-500 pb-1 mb-1' : 'border-transparent'
            )}>
              <SectionHeader
                id={id}
                open={isOpen}
                disabled={!built}
                count={built ? count : null}
                onToggle={() => toggleSection(id)}
                actions={
                  id === 'frameworks' && built ? (
                    <SectionMenu
                      title={t('sidebar.frameworkActions')}
                      grouping={{ section: 'frameworks', mode: grouping.frameworks, onChange: regroup }}
                    />
                  ) : id === 'algorithms' && built ? (
                    <SectionMenu
                      title={t('saved.actions')}
                      newLabel={t('saved.new')}
                      onNew={startNewAlgorithm}
                      grouping={{ section: 'algorithms', mode: grouping.algorithms, onChange: regroup }}
                    />
                  ) : id === 'domains' && built ? (
                    <SectionMenu
                      title={t('domain.actions')}
                      newLabel={t('domain.new')}
                      onNew={onNewDomain}
                      grouping={{ section: 'domains', mode: grouping.domains, onChange: regroup }}
                    />
                  ) : id === 'classifiers' && built ? (
                    <SectionMenu
                      title={t('classifier.actions')}
                      newLabel={t('classifier.new')}
                      onNew={onNewClassifier}
                      grouping={{ section: 'classifiers', mode: grouping.classifiers, onChange: regroup }}
                    />
                  ) : id === 'profileSets' && built ? (
                    <SectionMenu
                      title={t('profileSet.actions')}
                      newLabel={t('profileSet.new')}
                      onNew={onNewProfileSet}
                    />
                  ) : null
                }
              />

              {isOpen && id === 'frameworks' && (
                <FrameworkList
                  frameworks={shownFrameworks}
                  loadError={loadError}
                  buckets={buckets.frameworks}
                  mode={grouping.frameworks}
                  open={open}
                  onToggleGroup={toggle}
                  activeClassName={activeClassName}
                  onSelect={onSelectFramework}
                />
              )}

              {isOpen && id === 'algorithms' && (
                <AlgorithmList
                  algorithms={shownAlgorithms}
                  buckets={buckets.algorithms}
                  mode={grouping.algorithms}
                  open={open}
                  onToggleGroup={toggle}
                  activeId={activeAlgorithmId}
                  onSelect={openAlgorithm}
                />
              )}

              {isOpen && id === 'domains' && (
                <DomainList
                  domains={shownDomains}
                  buckets={buckets.domains}
                  mode={grouping.domains}
                  open={open}
                  onToggleGroup={toggle}
                  activeId={activeDomainId}
                  onSelect={onSelectDomain}
                />
              )}

              {isOpen && id === 'classifiers' && (
                <ClassifierList
                  classifiers={shownClassifiers}
                  buckets={buckets.classifiers}
                  mode={grouping.classifiers}
                  open={open}
                  onToggleGroup={toggle}
                  activeId={activeClassifierId}
                  onSelect={onSelectClassifier}
                />
              )}

              {isOpen && id === 'profileSets' && (
                <ProfileSetList
                  profileSets={shownProfileSets}
                  activeId={activeProfileSetId}
                  onSelect={onSelectProfileSet}
                />
              )}
            </div>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="px-3 py-3 border-t border-slate-800 flex-shrink-0 space-y-1">
        <button
          onClick={onOpenSettings}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
        >
          <Settings size={15} />
          {t('sidebar.settings')}
        </button>
        <LocaleFlags pref={localePref} onChange={onLocaleChange} />
        <VersionLine />
      </div>

    </div>
  )
}

/**
 * The profile sets. Flat, unlike the other three: a set is not of a kind, and a name plus how
 * many classifiers it runs is the whole of what there is to say in a list.
 */
function ProfileSetList({ profileSets, activeId, onSelect }: {
  profileSets: ProfileSet[]
  activeId: number | null
  onSelect: (s: ProfileSet) => void
}) {
  const { t } = useT()

  if (profileSets.length === 0) {
    return <p className="text-slate-400 text-xs px-3 py-3">{t('profileSet.empty')}</p>
  }
  return (
    <>{profileSets.map(s => (
      <ItemButton
        key={s.id}
        label={s.name}
        hint={`${t('profileSet.count', { n: s.classifier_ids.length })} · ${s.assignment_threshold}%`}
        active={activeId === s.id}
        onClick={() => onSelect(s)}
      />
    ))}</>
  )
}

function SectionHeader({ id, open, disabled, count, onToggle, actions }: {
  id: SectionId
  open: boolean
  disabled: boolean
  count: number | null
  onToggle: () => void
  actions: React.ReactNode
}) {
  const { t } = useT()
  return (
    // The panel behind an open section is drawn by its container, not here. The header only
    // brightens: a selected item keeps its solid blue, so "where you are browsing" and "what
    // is open" still do not read as the same thing.
    <div className="flex items-center group">
      <button
        onClick={disabled ? undefined : onToggle}
        disabled={disabled}
        aria-expanded={disabled ? undefined : open}
        title={disabled ? t('section.soon') : undefined}
        className={cn(
          'flex items-center gap-1.5 flex-1 min-w-0 px-2 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-lg transition-colors',
          disabled
            ? 'text-slate-600 cursor-default'
            : open
              ? 'text-white'
              : 'text-slate-300 hover:text-white hover:bg-slate-800'
        )}
      >
        {disabled
          ? <span className="w-3 flex-shrink-0" />
          : open
            ? <ChevronDown size={12} className="flex-shrink-0 text-blue-400" />
            : <ChevronRight size={12} className="flex-shrink-0" />}
        <span className="truncate">{t(`section.${id}`)}</span>
        {count !== null && count > 0 && (
          <span className={cn('ml-auto text-[10px] font-normal tabular-nums',
                              open ? 'text-slate-400' : 'text-slate-500')}>{count}</span>
        )}
      </button>
      {actions}
    </div>
  )
}

const menuItem = 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-300 hover:bg-slate-700 hover:text-white transition-colors'

/** Items under their headings, or flat when the section is not grouped. */
function Buckets<T>({ buckets, items, prefix, open, onToggleGroup, upper, render }: {
  buckets: Bucket<T>[]
  items: T[]
  /** Namespaces the open/closed keys, so two sections grouped the same way stay independent. */
  prefix: string
  open: OpenState
  onToggleGroup: (key: string) => void
  upper?: boolean
  render: (item: T) => React.ReactNode
}) {
  if (!buckets.length) return <>{items.map(render)}</>
  return (
    <>{buckets.map(b => (
      <Group key={b.key} label={b.label} upper={upper} count={b.items.length}
             open={!!open[`${prefix}:${b.key}`]} onToggle={() => onToggleGroup(`${prefix}:${b.key}`)}>
        {b.items.map(render)}
      </Group>
    ))}</>
  )
}

/** Category headings are labels this tool wrote; a domain or a set name is data, shown as spelled. */
const upperFor = (mode: GroupMode) =>
  mode === 'category' || mode === 'framework' || mode === 'domainFramework'

function FrameworkList({ frameworks, loadError, buckets, mode, open, onToggleGroup, activeClassName, onSelect }: {
  frameworks: Framework[]
  loadError: string | null
  buckets: Bucket<Framework>[]
  mode: GroupMode
  open: OpenState
  onToggleGroup: (key: string) => void
  activeClassName: string | null
  onSelect: (f: Framework) => void
}) {
  const { t } = useT()

  if (loadError) {
    return (
      <div className="mx-1 my-2 px-3 py-2 rounded-lg bg-red-950 border border-red-900 text-xs text-red-200">
        <p className="font-medium">{t('sidebar.loadFailed')}</p>
        <p className="mt-1 text-red-300 break-words">{loadError}</p>
      </div>
    )
  }
  if (frameworks.length === 0) {
    return <p className="text-slate-400 text-xs text-center py-4">{t('sidebar.noResults')}</p>
  }
  return (
    <Buckets
      buckets={buckets} items={frameworks} prefix={`frameworks:${mode}`}
      open={open} onToggleGroup={onToggleGroup} upper={upperFor(mode)}
      render={f => (
        <ItemButton key={f.className} label={f.displayName}
                    active={activeClassName === f.className} onClick={() => onSelect(f)} />
      )}
    />
  )
}

function AlgorithmList({ algorithms, buckets, mode, open, onToggleGroup, activeId, onSelect }: {
  algorithms: Algorithm[]
  buckets: Bucket<Algorithm>[]
  mode: GroupMode
  open: OpenState
  onToggleGroup: (key: string) => void
  activeId: number | null
  onSelect: (a: Algorithm) => void
}) {
  const { t } = useT()

  if (algorithms.length === 0) {
    return <p className="text-slate-400 text-xs px-3 py-3">{t('sidebar.algorithmsEmpty')}</p>
  }
  return (
    <Buckets
      buckets={buckets} items={algorithms} prefix={`algorithms:${mode}`}
      open={open} onToggleGroup={onToggleGroup} upper={upperFor(mode)}
      render={a => (
        <ItemButton key={a.id} label={a.name} hint={a.display_name}
                    active={activeId === a.id} onClick={() => onSelect(a)} />
      )}
    />
  )
}

/**
 * A section's `⋯`: what it can create or pull down, and how it lays its items out.
 *
 * One menu for all five sections, because the shape is the same even where the parts differ —
 * Frameworks has nothing to create (they come from the plugin) and Profile Sets nothing to group
 * by, and each simply leaves that half out.
 */
function SectionMenu({ title, newLabel, importLabel, onImportFromEngine, onNew, grouping }: {
  title: string
  newLabel?: string
  importLabel?: string
  onImportFromEngine?: () => void
  onNew?: () => void
  grouping?: {
    section: GroupableSection
    mode: GroupMode
    onChange: (section: GroupableSection, mode: GroupMode) => void
  }
}) {
  const { t } = useT()
  // Anchored on open and drawn fixed, not absolute. The menu hangs off a section header that
  // lives inside the scrolling list: positioned inside it, the panel scrolls with the content
  // and can end up past the visible edge or off the top entirely. Fixed keeps it on screen, and
  // any scroll closes it rather than leaving it stranded away from its button.
  const [at, setAt] = useState<{ top: number; right: number } | null>(null)
  const open = at !== null
  const box = useRef<HTMLDivElement>(null)

  const show = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (open) { setAt(null); return }
    const r = e.currentTarget.getBoundingClientRect()
    setAt({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) })
  }
  const close = () => setAt(null)

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) close()
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    window.addEventListener('resize', close)
    // Capture phase: the list that scrolls is an ancestor, and scroll does not bubble.
    document.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
      window.removeEventListener('resize', close)
      document.removeEventListener('scroll', close, true)
    }
  }, [open])

  const creates = onNew && newLabel
  const imports = onImportFromEngine && importLabel

  return (
    <div ref={box}>
      <button
        onClick={show}
        title={title}
        className="p-1 mr-1 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors"
      >
        <MoreHorizontal size={14} />
      </button>
      {at && (
        <div
          style={{ top: at.top, right: at.right }}
          className="fixed z-50 w-56 rounded-lg border border-slate-700 bg-slate-800 py-1 shadow-xl"
        >
          {creates && (
            <button onClick={() => { close(); onNew() }} className={menuItem}>
              <Plus size={13} /> {newLabel}
            </button>
          )}
          {imports && (
            <button onClick={() => { close(); onImportFromEngine() }} className={menuItem}>
              <Server size={13} /> {importLabel}
            </button>
          )}
          {grouping && (
            <>
              {(creates || imports) && <div className="my-1 border-t border-slate-700" />}
              <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                {t('sidebar.groupBy')}
              </p>
              {GROUP_MODES[grouping.section].map(mode => (
                <button
                  key={mode}
                  onClick={() => { close(); grouping.onChange(grouping.section, mode) }}
                  aria-current={mode === grouping.mode}
                  className={cn(menuItem, mode === grouping.mode && 'text-white')}
                >
                  {mode === grouping.mode
                    ? <Check size={13} className="text-blue-400" />
                    : <span className="w-[13px] flex-shrink-0" />}
                  {t(`sidebar.group.${mode}` as MessageKey)}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function DomainList({ domains, buckets, mode, open, onToggleGroup, activeId, onSelect }: {
  domains: Domain[]
  buckets: Bucket<Domain>[]
  mode: GroupMode
  open: OpenState
  onToggleGroup: (key: string) => void
  activeId: number | null
  onSelect: (d: Domain) => void
}) {
  const { t } = useT()

  if (domains.length === 0) {
    return <p className="text-slate-400 text-xs px-3 py-3">{t('domain.empty')}</p>
  }
  return (
    <Buckets
      buckets={buckets} items={domains} prefix={`domains:${mode}`}
      open={open} onToggleGroup={onToggleGroup} upper={upperFor(mode)}
      render={d => (
        <ItemButton key={d.id} label={d.name} hint={d.default_algorithm || t('domain.noAlgorithm')}
                    active={activeId === d.id} onClick={() => onSelect(d)} />
      )}
    />
  )
}

function ClassifierList({ classifiers, buckets, mode, open, onToggleGroup, activeId, onSelect }: {
  classifiers: Classifier[]
  buckets: Bucket<Classifier>[]
  mode: GroupMode
  open: OpenState
  onToggleGroup: (key: string) => void
  activeId: number | null
  onSelect: (c: Classifier) => void
}) {
  const { t } = useT()

  if (classifiers.length === 0) {
    return <p className="text-slate-400 text-xs px-3 py-3">{t('classifier.empty')}</p>
  }
  // Grouped by domain the hint would only repeat the heading, so it carries the framework there
  // and both everywhere else.
  const hint = (c: Classifier) => mode === 'domain'
    ? t(`classifier.fw.${c.framework}`)
    : `${c.domain_name || t('classifier.noDomain')} · ${t(`classifier.fw.${c.framework}`)}`
  return (
    <Buckets
      buckets={buckets} items={classifiers} prefix={`classifiers:${mode}`}
      open={open} onToggleGroup={onToggleGroup} upper={upperFor(mode)}
      render={c => (
        <ItemButton key={c.id} label={c.name} hint={hint(c)}
                    active={activeId === c.id} onClick={() => onSelect(c)} />
      )}
    />
  )
}

function Group({ label, upper = true, count, open, onToggle, children }: {
  label: string
  upper?: boolean
  count: number
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        title={label}
        className={cn(
          'flex items-center gap-1.5 w-full pl-4 pr-2 py-1 text-[11px] font-semibold text-slate-400 hover:text-slate-200 transition-colors',
          upper && 'uppercase tracking-wider'
        )}
      >
        {open
          ? <ChevronDown size={11} className="flex-shrink-0" />
          : <ChevronRight size={11} className="flex-shrink-0" />}
        <span className="truncate">{label}</span>
        <span className="ml-auto text-[10px] font-normal text-slate-400 tabular-nums">{count}</span>
      </button>
      {open && children}
    </div>
  )
}

/** `title` carries the full name: three levels of nesting in a 256px panel truncate the longer
 *  ones, and an algorithm is picked by its exact name. */
function ItemButton({ label, hint, active, onClick }: {
  label: string
  hint?: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={hint ? `${label} · ${hint}` : label}
      className={cn(
        'w-full text-left pl-7 pr-2 py-1.5 rounded-lg text-sm transition-colors mb-0.5',
        active ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-700 hover:text-white'
      )}
    >
      <span className="block truncate">{label}</span>
      {hint && (
        <span className={cn('block truncate text-[10px]', active ? 'text-blue-100' : 'text-slate-400')}>
          {hint}
        </span>
      )}
    </button>
  )
}

/** The build, under the language flags. Renders nothing at all when there is none to show,
 *  rather than leaving a gap or the word "unknown" in the corner of every screen. */
function VersionLine() {
  const { t } = useT()
  const version = useVersion()
  if (!version?.display) return null
  return (
    <p
      // slate-400, not a dimmer grey: at slate-600 this sits near 2.4:1 on the slate-900 panel,
      // and a version string is read character by character — misreading a commit sha is the
      // whole cost. Size keeps it subordinate to the buttons above; colour does not have to.
      className="px-3 pt-1 text-[10px] text-slate-400 tabular-nums truncate"
      title={version.commit ? t('sidebar.versionCommit', { commit: version.commit }) : undefined}
    >
      {version.display}
    </p>
  )
}
