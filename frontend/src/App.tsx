import { useState, useEffect } from 'react'
import { Toaster } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Sidebar } from '@/components/Sidebar'
import { WelcomeScreen } from '@/components/WelcomeScreen'
import { AlgoTester } from '@/components/AlgoTester'
import { SavedTests } from '@/components/SavedTests'
import { Settings } from '@/components/Settings'
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
  const [view, setView] = useState<View>('welcome')
  const [tester, setTester] = useState<TesterState | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [filesDir, setFilesDir] = useState('')
  // Seeded from localStorage so the first paint is already in the right language;
  // the server config is the source of truth and overrides it once it arrives.
  const [localePref, setLocalePref] = useState<LocalePref>(readStoredPref)

  useEffect(() => {
    api.getAlgorithms().catch(() => []).then(setAlgorithms)
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
    activeClassName: view === 'tester' ? (tester?.algo.className ?? null) : null,
    onSelect: (algo: Algorithm) => selectAlgo(algo),
    onShowSaved: showSaved,
    onOpenSettings: showSettings,
    onGoHome: showHome,
    localePref,
    onLocaleChange: changeLocale,
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
