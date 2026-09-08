import { useState, useEffect } from 'react'
import { Toaster } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Sidebar } from '@/components/Sidebar'
import { WelcomeScreen } from '@/components/WelcomeScreen'
import { AlgoTester } from '@/components/AlgoTester'
import { SavedTests } from '@/components/SavedTests'
import { Settings } from '@/components/Settings'
import { SetupNeeded } from '@/components/SetupNeeded'
import { isLocalePref, readStoredPref, resolveLocale, storePref } from '@/lib/i18n'
import { I18nProvider } from '@/lib/i18n/I18nProvider'
import type { Algorithm, LocalePref, View } from '@/types'

interface TesterState {
  algo: Algorithm
  config: Record<string, unknown>
  input: string
}

export default function App() {
  const [algorithms, setAlgorithms] = useState<Algorithm[]>([])
  // The jars can all be in lib/ and the list still fail — a Java that will not start, a
  // classpath the platform reads differently. Swallowing that left an empty sidebar with
  // nothing to act on, so the reason is kept and shown where the list should have been.
  const [algoError, setAlgoError] = useState<string | null>(null)
  const [view, setView] = useState<View>('welcome')
  const [tester, setTester] = useState<TesterState | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
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
          api.getAlgorithms()
            .then(list => { setAlgorithms(list); setAlgoError(null) })
            .catch((err: Error) => { setAlgorithms([]); setAlgoError(err.message) })
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

  const selectAlgo = (algo: Algorithm, config: Record<string, unknown> = {}, input = '') => {
    setTester({ algo, config, input })
    setView('tester')
    setSidebarOpen(false)
  }

  const showHome = () => { setView('welcome'); setSidebarOpen(false) }
  const showSaved = () => { setView('saved'); setSidebarOpen(false) }
  const showSettings = () => { setView('settings'); setSidebarOpen(false) }
  const toggleSidebar = () => setSidebarOpen(v => !v)

  const sidebarProps = {
    algorithms,
    loadError: algoError,
    activeClassName: view === 'tester' ? (tester?.algo.className ?? null) : null,
    onSelect: (algo: Algorithm) => selectAlgo(algo),
    onShowSaved: showSaved,
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
              onShowSaved={showSaved}
              onOpenSettings={showSettings}
            />
          )}
          {view === 'tester' && tester && (
            <AlgoTester
              key={tester.algo.className}
              algo={tester.algo}
              initialConfig={tester.config}
              initialInput={tester.input}
              onToggleSidebar={toggleSidebar}
            />
          )}
          {view === 'saved' && (
            <SavedTests
              algorithms={algorithms}
              onEdit={(algo, config, input) => selectAlgo(algo, config, input)}
              onToggleSidebar={toggleSidebar}
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
