import { useEffect, useRef, useState } from 'react'
import {
  Search, ShieldCheck, X, Settings, ChevronDown, ChevronRight,
  MoreHorizontal, Server, Plus,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { getFrameworkGroup, GROUP_ORDER } from '@/lib/framework-metadata'
import { useAlgorithms, refreshAlgorithms } from '@/lib/algorithms'
import { useDomains, refreshDomains, domainGroup } from '@/lib/domains'
import { useClassifiers, refreshClassifiers } from '@/lib/classifiers'
import { useProfileSets, refreshProfileSets } from '@/lib/profile-sets'
import { LocaleFlags } from '@/components/LocaleFlags'
import { EngineImport } from '@/components/EngineImport'
import { DomainImport } from '@/components/DomainImport'
import { ClassifierImport } from '@/components/ClassifierImport'
import { ProfileSetImport } from '@/components/ProfileSetImport'
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

type OpenState = Record<string, boolean>

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
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<OpenState>(readOpen)
  const [engineOpen, setEngineOpen] = useState(false)
  const [domainImportOpen, setDomainImportOpen] = useState(false)
  const [classifierImportOpen, setClassifierImportOpen] = useState(false)
  const [profileSetImportOpen, setProfileSetImportOpen] = useState(false)

  useEffect(() => {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(open)) } catch { /* not worth failing over */ }
  }, [open])

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

  const shownFrameworks = q ? frameworks.filter(matchFramework) : frameworks
  const shownAlgorithms = q ? algorithms.filter(matchAlgorithm) : algorithms
  const shownDomains = q ? domains.filter(matchDomain) : domains
  const shownClassifiers = q ? classifiers.filter(matchClassifier) : classifiers
  const shownProfileSets = q ? profileSets.filter(matchProfileSet) : profileSets

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

      {/* Search — spans both populated sections, so a name is found without knowing which one
          it lives in. */}
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

      <nav className="flex-1 overflow-auto px-2 py-1">
        {SECTIONS.map((id) => {
          const built = BUILT.includes(id)
          const isOpen = built && !!open[`section:${id}`]
          // While searching, a section with no match collapses out of the way on its own.
          const count = id === 'frameworks' ? shownFrameworks.length
            : id === 'algorithms' ? shownAlgorithms.length
            : id === 'domains' ? shownDomains.length
            : id === 'classifiers' ? shownClassifiers.length
            : id === 'profileSets' ? shownProfileSets.length : 0
          if (q && built && count === 0) return null

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
                  id === 'algorithms' && built ? (
                    <CreateImportActions
                      title={t('saved.actions')}
                      newLabel={t('saved.new')}
                      importLabel={t('saved.importFromEngine')}
                      onImportFromEngine={() => setEngineOpen(true)}
                      onNew={startNewAlgorithm}
                    />
                  ) : id === 'domains' && built ? (
                    <CreateImportActions
                      title={t('domain.actions')}
                      newLabel={t('domain.new')}
                      importLabel={t('domain.importFromEngine')}
                      onImportFromEngine={() => setDomainImportOpen(true)}
                      onNew={onNewDomain}
                    />
                  ) : id === 'classifiers' && built ? (
                    <CreateImportActions
                      title={t('classifier.actions')}
                      newLabel={t('classifier.new')}
                      importLabel={t('classifier.importFromEngine')}
                      onImportFromEngine={() => setClassifierImportOpen(true)}
                      onNew={onNewClassifier}
                    />
                  ) : id === 'profileSets' && built ? (
                    <CreateImportActions
                      title={t('profileSet.actions')}
                      newLabel={t('profileSet.new')}
                      importLabel={t('profileSet.importFromEngine')}
                      onImportFromEngine={() => setProfileSetImportOpen(true)}
                      onNew={onNewProfileSet}
                    />
                  ) : null
                }
              />

              {isOpen && id === 'frameworks' && (
                <FrameworkList
                  frameworks={shownFrameworks}
                  loadError={loadError}
                  flat={q !== ''}
                  open={open}
                  onToggleGroup={toggle}
                  activeClassName={activeClassName}
                  onSelect={onSelectFramework}
                />
              )}

              {isOpen && id === 'algorithms' && (
                <AlgorithmList
                  algorithms={shownAlgorithms}
                  flat={q !== ''}
                  open={open}
                  onToggleGroup={toggle}
                  activeId={activeAlgorithmId}
                  onSelect={openAlgorithm}
                />
              )}

              {isOpen && id === 'domains' && (
                <DomainList
                  domains={shownDomains}
                  algorithms={algorithms}
                  flat={q !== ''}
                  open={open}
                  onToggleGroup={toggle}
                  activeId={activeDomainId}
                  onSelect={onSelectDomain}
                />
              )}

              {isOpen && id === 'classifiers' && (
                <ClassifierList
                  classifiers={shownClassifiers}
                  flat={q !== ''}
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

      {engineOpen && (
        <EngineImport onClose={() => setEngineOpen(false)} onImported={refreshAlgorithms} />
      )}
      {domainImportOpen && (
        <DomainImport onClose={() => setDomainImportOpen(false)} onImported={refreshDomains} />
      )}
      {classifierImportOpen && (
        <ClassifierImport
          onClose={() => setClassifierImportOpen(false)}
          // An import can bring the classifiers' domains down with them.
          onImported={() => { refreshClassifiers(); refreshDomains() }}
        />
      )}

      {profileSetImportOpen && (
        <ProfileSetImport
          onClose={() => setProfileSetImportOpen(false)}
          // A set drags its classifiers down, and those drag their domains and algorithms.
          onImported={() => { refreshProfileSets(); refreshClassifiers(); refreshDomains(); refreshAlgorithms() }}
        />
      )}
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

function FrameworkList({ frameworks, loadError, flat, open, onToggleGroup, activeClassName, onSelect }: {
  frameworks: Framework[]
  loadError: string | null
  flat: boolean
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
  if (flat) {
    return <>{frameworks.map(f => (
      <ItemButton key={f.className} label={f.displayName}
                  active={activeClassName === f.className} onClick={() => onSelect(f)} />
    ))}</>
  }

  const grouped = groupBy(frameworks, f => getFrameworkGroup(f.className))
  return (
    <>{GROUP_ORDER.filter(g => grouped[g]?.length).map(group => (
      <Group key={group} label={t(`group.${group}`)} count={grouped[group].length}
             open={!!open[`frameworks:${group}`]} onToggle={() => onToggleGroup(`frameworks:${group}`)}>
        {grouped[group].map(f => (
          <ItemButton key={f.className} label={f.displayName}
                      active={activeClassName === f.className} onClick={() => onSelect(f)} />
        ))}
      </Group>
    ))}</>
  )
}

function AlgorithmList({ algorithms, flat, open, onToggleGroup, activeId, onSelect }: {
  algorithms: Algorithm[]
  flat: boolean
  open: OpenState
  onToggleGroup: (key: string) => void
  activeId: number | null
  onSelect: (a: Algorithm) => void
}) {
  const { t } = useT()

  if (algorithms.length === 0) {
    return <p className="text-slate-400 text-xs px-3 py-3">{t('sidebar.algorithmsEmpty')}</p>
  }
  if (flat) {
    return <>{algorithms.map(a => (
      <ItemButton key={a.id} label={a.name} hint={a.display_name}
                  active={activeId === a.id} onClick={() => onSelect(a)} />
    ))}</>
  }

  // The same categories as the frameworks, resolved from the class each algorithm configures.
  const grouped = groupBy(algorithms, a => getFrameworkGroup(a.framework))
  return (
    <>{GROUP_ORDER.filter(g => grouped[g]?.length).map(group => (
      <Group key={group} label={t(`group.${group}`)} count={grouped[group].length}
             open={!!open[`algorithms:${group}`]} onToggle={() => onToggleGroup(`algorithms:${group}`)}>
        {grouped[group].map(a => (
          <ItemButton key={a.id} label={a.name} hint={a.display_name}
                      active={activeId === a.id} onClick={() => onSelect(a)} />
        ))}
      </Group>
    ))}</>
  )
}

/** Create one, or pull the engine's down. The same menu on all three populated sections — what
 *  "create" means differs (an algorithm starts by choosing a framework), the shape does not. */
function CreateImportActions({ title, newLabel, importLabel, onImportFromEngine, onNew }: {
  title: string
  newLabel: string
  importLabel: string
  onImportFromEngine: () => void
  onNew: () => void
}) {
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
    document.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
      window.removeEventListener('resize', close)
      document.removeEventListener('scroll', close, true)
    }
  }, [open])

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
          className="fixed z-50 w-52 rounded-lg border border-slate-700 bg-slate-800 py-1 shadow-xl"
        >
          <button onClick={() => { close(); onNew() }} className={menuItem}>
            <Plus size={13} /> {newLabel}
          </button>
          <button onClick={() => { close(); onImportFromEngine() }} className={menuItem}>
            <Server size={13} /> {importLabel}
          </button>
        </div>
      )}
    </div>
  )
}

function DomainList({ domains, algorithms, flat, open, onToggleGroup, activeId, onSelect }: {
  domains: Domain[]
  algorithms: Algorithm[]
  flat: boolean
  open: OpenState
  onToggleGroup: (key: string) => void
  activeId: number | null
  onSelect: (d: Domain) => void
}) {
  const { t } = useT()

  if (domains.length === 0) {
    return <p className="text-slate-400 text-xs px-3 py-3">{t('domain.empty')}</p>
  }
  if (flat) {
    return <>{domains.map(d => (
      <ItemButton key={d.id} label={d.name} hint={d.default_algorithm || t('domain.noAlgorithm')}
                  active={activeId === d.id} onClick={() => onSelect(d)} />
    ))}</>
  }

  // Grouped by the framework behind the algorithm each domain points at — the same categories
  // the frameworks and the algorithms use. Two hops, and `domainGroup` sends either miss to
  // `other` rather than inventing a category.
  const grouped = groupBy(domains, d => domainGroup(d, algorithms))
  return (
    <>{GROUP_ORDER.filter(g => grouped[g]?.length).map(group => (
      <Group key={group} label={t(`group.${group}`)} count={grouped[group].length}
             open={!!open[`domains:${group}`]} onToggle={() => onToggleGroup(`domains:${group}`)}>
        {grouped[group].map(d => (
          <ItemButton key={d.id} label={d.name} hint={d.default_algorithm || t('domain.noAlgorithm')}
                      active={activeId === d.id} onClick={() => onSelect(d)} />
        ))}
      </Group>
    ))}</>
  )
}

function ClassifierList({ classifiers, flat, open, onToggleGroup, activeId, onSelect }: {
  classifiers: Classifier[]
  flat: boolean
  open: OpenState
  onToggleGroup: (key: string) => void
  activeId: number | null
  onSelect: (c: Classifier) => void
}) {
  const { t } = useT()

  if (classifiers.length === 0) {
    return <p className="text-slate-400 text-xs px-3 py-3">{t('classifier.empty')}</p>
  }
  const hint = (c: Classifier) => t(`classifier.fw.${c.framework}`)
  if (flat) {
    return <>{classifiers.map(c => (
      <ItemButton key={c.id} label={c.name} hint={`${c.domain_name} · ${hint(c)}`}
                  active={activeId === c.id} onClick={() => onSelect(c)} />
    ))}</>
  }

  // Grouped by domain: a domain is what its classifiers are weighed together for, so that is the
  // unit a profile run — and the tester — reads them in.
  const grouped = groupBy(classifiers, c => c.domain_name)
  const names = Object.keys(grouped).sort((a, b) => a.localeCompare(b))
  return (
    <>{names.map(domain => (
      <Group key={domain} label={domain || t('classifier.noDomain')} upper={false} count={grouped[domain].length}
             open={!!open[`classifiers:${domain}`]} onToggle={() => onToggleGroup(`classifiers:${domain}`)}>
        {grouped[domain].map(c => (
          <ItemButton key={c.id} label={c.name} hint={hint(c)}
                      active={activeId === c.id} onClick={() => onSelect(c)} />
        ))}
      </Group>
    ))}</>
  )
}

/** `upper` is off for labels that are data — a domain name is shown as the engine spells it. */
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

function groupBy<T>(rows: T[], key: (row: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {}
  for (const row of rows) (out[key(row)] ??= []).push(row)
  return out
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
