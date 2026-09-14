import { useState, useEffect } from 'react'
import { Toaster } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Sidebar } from '@/components/Sidebar'
import { WelcomeScreen } from '@/components/WelcomeScreen'
import { FrameworkTester } from '@/components/FrameworkTester'
import { DomainEditor } from '@/components/DomainEditor'
import { ClassifierEditor } from '@/components/ClassifierEditor'
import { ProfileSetEditor } from '@/components/ProfileSetEditor'
import { Settings } from '@/components/Settings'
import { SetupNeeded } from '@/components/SetupNeeded'
import { isLocalePref, readStoredPref, resolveLocale, storePref } from '@/lib/i18n'
import { I18nProvider } from '@/lib/i18n/I18nProvider'
import { parseConfig, refreshAlgorithms } from '@/lib/algorithms'
import type { Algorithm, Classifier, Domain, Framework, LocalePref, ProfileSet, View } from '@/types'

interface TesterState {
  framework: Framework
  /** Set when the panel was opened from a saved algorithm rather than from a bare framework. */
  algorithm: Algorithm | null
  config: Record<string, unknown>
  input: string
}

export default function App() {
  const [frameworks, setFrameworks] = useState<Framework[]>([])
  // The jars can all be in lib/ and the list still fail — a Java that will not start, a
  // classpath the platform reads differently. Swallowing that left an empty sidebar with
  // nothing to act on, so the reason is kept and shown where the list should have been.
  const [frameworkError, setFrameworkError] = useState<string | null>(null)
  const [view, setView] = useState<View>('welcome')
  const [tester, setTester] = useState<TesterState | null>(null)
  // null with view 'domain' means the editor is creating one.
  const [domain, setDomain] = useState<Domain | null>(null)
  // Same convention: null with view 'classifier' means creating one.
  const [classifier, setClassifier] = useState<Classifier | null>(null)
  // And again for the profile sets.
  const [profileSet, setProfileSet] = useState<ProfileSet | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // Set by "New algorithm": the home screen then says to pick a framework, which the sidebar
  // has just opened. Cleared on the next trip home, so the hint does not outlive the errand.
  const [pickFramework, setPickFramework] = useState(false)
  const [filesDir, setFilesDir] = useState('')
  // Seeded from localStorage so the first paint is already in the right language;
  // the server config is the source of truth and overrides it once it arrives.
  const [localePref, setLocalePref] = useState<LocalePref>(readStoredPref)
  // null while unknown; the app is unusable without the Delphix libraries, so it renders the
  // setup screen instead of an empty sidebar with no explanation.
  const [setup, setSetup] = useState<{ ready: boolean; missing: string[]; libDir: string } | null>(null)

  const checkSetup = () =>
    api.getSetup()
      .then(s => {
        setSetup(s)
        if (s.ready) {
          api.getFrameworks()
            .then(list => { setFrameworks(list); setFrameworkError(null) })
            .catch((err: Error) => { setFrameworks([]); setFrameworkError(err.message) })
        }
      })
      // A server that cannot answer at all is a different problem; let the app render and fail
      // where the user acts, rather than trapping them behind a setup screen that is not the cause.
      .catch(() => setSetup({ ready: true, missing: [], libDir: '' }))

  useEffect(() => {
    checkSetup()
    api.getConfig().then(cfg => {
      setFilesDir(cfg.filesDir)
      if (isLocalePref(cfg.locale)) {
        setLocalePref(cfg.locale)
        storePref(cfg.locale)
      }
    }).catch(() => {})
  }, [])

  const applyLocalePref = (pref: LocalePref) => {
    setLocalePref(pref)
    storePref(pref)
  }

  // The sidebar switcher applies immediately, so it persists on its own instead of
  // waiting for a Save button. A failed write only costs the cross-browser preference.
  const changeLocale = (pref: LocalePref) => {
    applyLocalePref(pref)
    api.updateConfig({ locale: pref }).catch(() => {})
  }

  const selectFramework = (framework: Framework) => {
    setTester({ framework, algorithm: null, config: {}, input: '' })
    setView('tester')
    setSidebarOpen(false)
  }

  /**
   * "New algorithm" from the sidebar. There is nothing to create yet — an algorithm is a
   * configured framework — so this puts the home screen up with the hint on, and leaves the
   * drawer open on a narrow screen, where the frameworks the sidebar just opened are the very
   * thing to pick from.
   */
  const newAlgorithm = () => {
    setTester(null); setDomain(null); setClassifier(null); setProfileSet(null)
    setView('welcome')
    setPickFramework(true)
    setSidebarOpen(true)
  }

  /**
   * Opens a saved algorithm in the same panel, with its configuration loaded.
   *
   * The framework arrives resolved: the sidebar looks it up, because App sits above
   * I18nProvider and so cannot word the failure in the user's language.
   */
  const selectAlgorithm = (algorithm: Algorithm, framework: Framework) => {
    setTester({ framework, algorithm, config: parseConfig(algorithm.config), input: algorithm.input })
    setView('tester')
    setSidebarOpen(false)
  }

  /** Opens what the assistant just saved. The list is re-read first: the row was created
   *  server-side moments ago, so a cached copy would not have it yet. */
  const openAlgorithmById = async (id: number) => {
    const rows = await refreshAlgorithms()
    const algorithm = rows.find(a => a.id === id)
    const framework = algorithm && frameworks.find(f => f.className === algorithm.framework)
    if (algorithm && framework) selectAlgorithm(algorithm, framework)
  }

  const selectDomain = (d: Domain) => {
    setDomain(d)
    setView('domain')
    setSidebarOpen(false)
  }

  const newDomain = () => {
    setDomain(null)
    setView('domain')
    setSidebarOpen(false)
  }

  const selectClassifier = (c: Classifier) => {
    setClassifier(c)
    setView('classifier')
    setSidebarOpen(false)
  }

  const newClassifier = () => {
    setClassifier(null)
    setView('classifier')
    setSidebarOpen(false)
  }

  const selectProfileSet = (s: ProfileSet) => {
    setProfileSet(s)
    setView('profileSet')
    setSidebarOpen(false)
  }

  const newProfileSet = () => {
    setProfileSet(null)
    setView('profileSet')
    setSidebarOpen(false)
  }

  const showHome = () => {
    setView('welcome'); setTester(null); setDomain(null); setClassifier(null); setProfileSet(null)
    setSidebarOpen(false)
    setPickFramework(false)
  }
  const showSettings = () => { setView('settings'); setSidebarOpen(false) }
  const toggleSidebar = () => setSidebarOpen(v => !v)

  const onTester = view === 'tester'
  const sidebarProps = {
    frameworks,
    loadError: frameworkError,
    // Only one of the two ever highlights: a bare framework has no algorithm, and an open
    // algorithm is the more specific answer to "where am I".
    activeClassName: onTester && !tester?.algorithm ? (tester?.framework.className ?? null) : null,
    activeAlgorithmId: onTester ? (tester?.algorithm?.id ?? null) : null,
    activeDomainId: view === 'domain' ? (domain?.id ?? null) : null,
    activeClassifierId: view === 'classifier' ? (classifier?.id ?? null) : null,
    activeProfileSetId: view === 'profileSet' ? (profileSet?.id ?? null) : null,
    onSelectFramework: selectFramework,
    onSelectAlgorithm: selectAlgorithm,
    onNewAlgorithm: newAlgorithm,
    onSelectDomain: selectDomain,
    onNewDomain: newDomain,
    onSelectClassifier: selectClassifier,
    onNewClassifier: newClassifier,
    onSelectProfileSet: selectProfileSet,
    onNewProfileSet: newProfileSet,
    onOpenSettings: showSettings,
    onGoHome: showHome,
    localePref,
    onLocaleChange: changeLocale,
  }

  if (setup && !setup.ready) {
    return (
      <I18nProvider locale={resolveLocale(localePref)}>
        <Toaster position="bottom-right" richColors />
        <SetupNeeded missing={setup.missing} libDir={setup.libDir} onRetry={checkSetup} />
      </I18nProvider>
    )
  }

  return (
    <I18nProvider locale={resolveLocale(localePref)}>
      <Toaster position="bottom-right" richColors />

      <div className="flex h-full overflow-hidden bg-slate-50">

        <aside className="hidden md:flex md:w-64 md:flex-shrink-0 flex-col">
          <Sidebar {...sidebarProps} />
        </aside>

        <div className={cn('fixed inset-0 z-50 md:hidden transition-all duration-300', sidebarOpen ? 'pointer-events-auto' : 'pointer-events-none')}>
          <div
            className={cn('absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-300', sidebarOpen ? 'opacity-100' : 'opacity-0')}
            onClick={() => setSidebarOpen(false)}
          />
          <aside className={cn('absolute inset-y-0 left-0 w-72 flex flex-col shadow-2xl transition-transform duration-300 ease-in-out', sidebarOpen ? 'translate-x-0' : '-translate-x-full')}>
            <Sidebar {...sidebarProps} onClose={() => setSidebarOpen(false)} />
          </aside>
        </div>

        <main className="flex-1 overflow-hidden flex flex-col">
          {view === 'welcome' && (
            <WelcomeScreen
              onOpenSidebar={() => setSidebarOpen(true)}
              onOpenAlgorithm={openAlgorithmById}
              onOpenSettings={showSettings}
              pickFramework={pickFramework}
              onDismissPick={() => setPickFramework(false)}
            />
          )}
          {view === 'tester' && tester && (
            <FrameworkTester
              // The algorithm id leads: two algorithms built on the same framework share a
              // className, and keying by that alone left the second one showing the first's
              // configuration, because the component never remounted.
              key={tester.algorithm ? `algo:${tester.algorithm.id}` : `fw:${tester.framework.className}`}
              framework={tester.framework}
              algorithm={tester.algorithm}
              initialConfig={tester.config}
              initialInput={tester.input}
              onToggleSidebar={toggleSidebar}
              onDeleted={showHome}
            />
          )}
          {view === 'domain' && (
            <DomainEditor
              // Creating and editing are different forms; keying them apart clears the fields
              // when you go from one domain to another, or from a domain to a new one.
              key={domain ? `domain:${domain.id}` : 'domain:new'}
              domain={domain}
              onToggleSidebar={toggleSidebar}
              onDeleted={showHome}
              onCreated={selectDomain}
            />
          )}
          {view === 'classifier' && (
            <ClassifierEditor
              key={classifier ? `classifier:${classifier.id}` : 'classifier:new'}
              classifier={classifier}
              onToggleSidebar={toggleSidebar}
              onDeleted={showHome}
              onCreated={selectClassifier}
            />
          )}
          {view === 'profileSet' && (
            <ProfileSetEditor
              key={profileSet ? `profileSet:${profileSet.id}` : 'profileSet:new'}
              profileSet={profileSet}
              onToggleSidebar={toggleSidebar}
              onDeleted={showHome}
              onCreated={selectProfileSet}
            />
          )}
          {view === 'settings' && (
            <Settings
              filesDir={filesDir}
              onSave={(d) => setFilesDir(d)}
              onToggleSidebar={toggleSidebar}
            />
          )}
        </main>

      </div>
    </I18nProvider>
  )
}
