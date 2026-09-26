import { useState, useEffect, useRef } from 'react'
import {
  PanelLeftOpen, Save, Plus, Upload, Pencil, Trash2, X, Check, RefreshCw, CheckCircle2,
  AlertTriangle, CloudUpload, Lock, Loader2, FileDown, Download, RotateCcw, Layers, ChevronDown,
} from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { useVersion } from '@/lib/version'
import { refreshAfterImport } from '@/lib/engine-sync'
import { ImportProgressBar } from '@/components/ImportProgressBar'
import { startSync, useSyncJob } from '@/lib/sync-job'
import type { AiStatus, Locale, PresetConflict, PresetPack, ProfileSetPreset, ServerFile } from '@/types'

interface Props {
  filesDir: string
  onSave: (filesDir: string) => void
  onToggleSidebar: () => void
}

type Tab = 'general' | 'ai' | 'delphix' | 'profileSets' | 'files'

export function Settings({ filesDir, onSave, onToggleSidebar }: Props) {
  const { t } = useT()
  const [tab, setTab] = useState<Tab>('general')

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-200 bg-white flex-shrink-0">
        <button onClick={onToggleSidebar} className="text-slate-400 hover:text-slate-600 transition-colors md:hidden">
          <PanelLeftOpen size={18} />
        </button>
        <h2 className="text-sm font-semibold text-slate-800">{t('settings.title')}</h2>
      </div>

      <div className="flex gap-1 px-5 pt-4 flex-shrink-0 border-b border-slate-200 bg-white overflow-x-auto">
        {(['general', 'ai', 'delphix', 'profileSets', 'files'] as Tab[]).map(id => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap flex-shrink-0',
              tab === id
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            )}
          >
            {t(`settings.tab.${id}`)}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto p-5">
        {tab === 'general' && (
          <GeneralTab filesDir={filesDir} onSave={onSave} />
        )}
        {tab === 'ai' && (
          <AiTab />
        )}
        {tab === 'delphix' && (
          <DelphixTab />
        )}
        {tab === 'profileSets' && (
          <PresetsTab />
        )}
        {tab === 'files' && (
          <FilesTab />
        )}
      </div>
    </div>
  )
}

function GeneralTab({ filesDir, onSave }: Omit<Props, 'onToggleSidebar'>) {
  const { t } = useT()
  const [localDir, setLocalDir] = useState(filesDir)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await api.updateConfig({ filesDir: localDir })
      onSave(localDir)
      toast.success(t('settings.saved'))
    } catch {
      toast.error(t('settings.saveError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-lg space-y-5">
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
        <div>
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
            {t('settings.filesDir')}
          </label>
          <input
            type="text"
            value={localDir}
            onChange={e => setLocalDir(e.target.value)}
            placeholder={t('settings.filesDirPlaceholder')}
            className={fieldCls}
          />
          <p className="text-xs text-slate-400 mt-1">{t('settings.filesDirHint')}</p>
        </div>
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
        >
          <Save size={14} />
          {saving ? t('settings.saving') : t('settings.save')}
        </button>
      </div>

      <AboutCard />
    </div>
  )
}

/**
 * What build this is, and how to move to a newer one.
 *
 * There is no "check for updates" button on purpose: the tool makes no network call the user
 * did not ask for, which is the same promise the local-model default makes. The update command
 * is spelled out instead — running it is the check.
 */
function AboutCard() {
  const { t } = useT()
  const version = useVersion()
  if (!version?.display) return null

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-3">
      <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
        {t('settings.about')}
      </h3>

      <dl className="space-y-1.5 text-sm">
        <div className="flex items-baseline gap-3">
          <dt className="text-slate-500 w-20 flex-shrink-0">{t('settings.version')}</dt>
          <dd className="font-mono text-slate-800 break-all">{version.display}</dd>
        </div>
        {version.commit && (
          <div className="flex items-baseline gap-3">
            <dt className="text-slate-500 w-20 flex-shrink-0">{t('settings.commit')}</dt>
            <dd className="font-mono text-slate-800">{version.commit}</dd>
          </div>
        )}
      </dl>

      {version.channel !== 'release' && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          {version.channel === 'dev' ? t('settings.versionDev') : t('settings.versionUnknown')}
        </p>
      )}

      <div>
        <p className="text-xs text-slate-400 mb-1.5">{t('settings.updateHint')}</p>
        <code className="block text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-700">
          dlpx-helper update
        </code>
      </div>
    </div>
  )
}

const PROVIDERS = [
  { id: 'ollama', label: 'Ollama (local)', needsKey: false, hint: 'settings.ai.ollamaHint' },
  { id: 'anthropic', label: 'Claude / Anthropic', needsKey: true, hint: null },
  { id: 'gemini', label: 'Google Gemini', needsKey: true, hint: null },
  { id: 'copilot', label: 'GitHub Models (Copilot)', needsKey: true, hint: 'settings.ai.copilotHint' },
] as const

type ProviderId = (typeof PROVIDERS)[number]['id']

function AiTab() {
  const { t } = useT()
  const [cfg, setCfg] = useState<Record<string, string | boolean>>({})
  const [status, setStatus] = useState<AiStatus | null>(null)
  // Starts true: the first status probe is already in flight when the tab mounts.
  const [checking, setChecking] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = () => { api.getConfig().then(c => setCfg(c as unknown as Record<string, string | boolean>)).catch(() => {}) }
  const check = () => {
    setChecking(true)
    api.getAiStatus().then(setStatus).catch(() => setStatus(null)).finally(() => setChecking(false))
  }

  // Inlined rather than calling check(), which raises the flag that already starts true.
  useEffect(() => {
    load()
    api.getAiStatus().then(setStatus).catch(() => setStatus(null)).finally(() => setChecking(false))
  }, [])

  const provider = (cfg.aiProvider as ProviderId) || 'ollama'
  const meta = PROVIDERS.find(p => p.id === provider) ?? PROVIDERS[0]
  const get = (suffix: string) => String(cfg[`ai.${provider}.${suffix}`] ?? '')
  const set = (key: string, value: string) => setCfg(c => ({ ...c, [key]: value }))

  const save = async () => {
    setSaving(true)
    try {
      // Only the AI keys are sent; the other tabs own the rest of the config.
      const patch = Object.fromEntries(
        Object.entries(cfg).filter(([k]) => k === 'aiProvider' || (k.startsWith('ai.') && !k.endsWith('.set')))
      )
      const updated = await api.updateConfig(patch as never)
      setCfg(updated as unknown as Record<string, string | boolean>)
      toast.success(t('settings.saved'))
      check()
    } catch {
      toast.error(t('settings.saveError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-lg space-y-5">
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
        <div>
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
            {t('settings.ai.provider')}
          </label>
          <select
            value={provider}
            onChange={e => set('aiProvider', e.target.value)}
            className={fieldCls}
          >
            {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          {meta.hint && <p className="text-xs text-slate-400 mt-1">{t(meta.hint)}</p>}
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
            {t('settings.ai.model')}
          </label>
          <input
            type="text"
            value={get('model')}
            onChange={e => set(`ai.${provider}.model`, e.target.value)}
            className={fieldCls}
          />
          {provider === 'ollama' && status?.ok && status.models && status.models.length > 0 && (
            <p className="text-xs text-slate-400 mt-1">
              {t('settings.ai.installedModels', { models: status.models.join(', ') })}
            </p>
          )}
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
            {t('settings.ai.baseUrl')}
          </label>
          <input
            type="text"
            value={get('baseUrl')}
            onChange={e => set(`ai.${provider}.baseUrl`, e.target.value)}
            className={fieldCls}
          />
        </div>

        {provider === 'ollama' && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                {t('settings.ai.numCtx')}
              </label>
              <input
                type="number"
                min={2048}
                step={1024}
                value={get('numCtx')}
                onChange={e => set(`ai.${provider}.numCtx`, e.target.value)}
                className={fieldCls}
              />
              <p className="text-xs text-slate-400 mt-1">{t('settings.ai.numCtxHint')}</p>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                {t('settings.ai.keepAlive')}
              </label>
              <input
                type="text"
                value={get('keepAlive')}
                onChange={e => set(`ai.${provider}.keepAlive`, e.target.value)}
                className={fieldCls}
              />
              <p className="text-xs text-slate-400 mt-1">{t('settings.ai.keepAliveHint')}</p>
            </div>
          </div>
        )}

        {meta.needsKey && (
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              {t('settings.ai.apiKey')}
            </label>
            <input
              type="password"
              value={get('apiKey')}
              onChange={e => set(`ai.${provider}.apiKey`, e.target.value)}
              disabled={Boolean(cfg[`ai.${provider}.apiKey.fromEnv`])}
              className={cn(fieldCls, cfg[`ai.${provider}.apiKey.fromEnv`] && 'opacity-60')}
            />
            <p className="text-xs text-slate-400 mt-1">
              {cfg[`ai.${provider}.apiKey.fromEnv`]
                ? t('settings.secretFromEnv', { name: String(cfg[`ai.${provider}.apiKey.fromEnv`]) })
                : cfg[`ai.${provider}.apiKey.set`] ? t('settings.ai.apiKeySet') : t('settings.ai.apiKeyHint')}
            </p>
          </div>
        )}

        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
        >
          <Save size={14} />
          {saving ? t('settings.saving') : t('settings.save')}
        </button>
      </div>

      <div className={cn(
        'rounded-xl border p-4 flex items-start gap-2.5 text-sm',
        status?.ok ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50'
      )}>
        {status?.ok
          ? <CheckCircle2 size={16} className="text-green-600 flex-shrink-0 mt-0.5" />
          : <AlertTriangle size={16} className="text-amber-600 flex-shrink-0 mt-0.5" />}
        <div className="flex-1 min-w-0">
          <p className={cn('font-medium', status?.ok ? 'text-green-800' : 'text-amber-800')}>
            {status?.ok ? t('settings.ai.statusOk') : t('settings.ai.statusDown')}
          </p>
          {status && !status.ok && status.error && (
            <p className="text-xs text-amber-700 mt-0.5 break-words">{status.error}</p>
          )}
        </div>
        <button
          onClick={check}
          disabled={checking}
          className="flex items-center gap-1 flex-shrink-0 text-xs font-medium text-slate-600 hover:text-slate-800 transition-colors"
        >
          <RefreshCw size={12} className={cn(checking && 'animate-spin')} /> {t('settings.ai.recheck')}
        </button>
      </div>
    </div>
  )
}

/** SQLite's datetime('now') is UTC without a zone marker. */
const formatLoadedAt = (value: string, locale: Locale) =>
  new Date(`${value.replace(' ', 'T')}Z`).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })

/**
 * Profile sets shipped with the tool.
 *
 * Loading one writes the set and everything it leans on, as one of two packs: essential, the
 * minimum for its law, or extended, all of it. Loading it again is a reset, not a copy: the server
 * finds the same rows and puts them back the way they ship, removing what the chosen pack does not
 * carry. What stands in the way — something of the user's under a name the preset uses — comes back
 * as conflicts to confirm. Unloading removes what it brought.
 */
function PresetsTab() {
  const { t, locale } = useT()
  const [presets, setPresets] = useState<ProfileSetPreset[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState<{ id: string; unloading: boolean } | null>(null)

  useEffect(() => {
    api.getPresets().then(setPresets).catch(() => { setFailed(true); setPresets([]) })
  }, [])

  const text = (byLocale: Partial<Record<Locale, string>>) => byLocale[locale] ?? byLocale.en ?? ''
  const packName = (pack: PresetPack) => t(`presets.pack.${pack}`)
  const announceKept = (kept: PresetConflict[]) => {
    if (!kept.length) return
    toast.info(t('presets.kept', { names: kept.map(c => `${c.name} (${t(`presets.kind.${c.kind}`)})`).join(', ') }))
  }
  const refresh = async () => {
    await refreshAfterImport()
    setPresets(await api.getPresets())
  }

  const run = async (preset: ProfileSetPreset, pack: PresetPack, overwrite: boolean): Promise<void> => {
    const name = text(preset.name)
    try {
      const out = await api.loadPreset(preset.id, pack, overwrite)
      const done = out.mode === 'reset' ? 'presets.resetDone' : out.mode === 'switched' ? 'presets.switched' : 'presets.loaded'
      toast.success(t(done, { name, pack: packName(out.pack) }))
      announceKept(out.kept)
      await refresh()
    } catch (e) {
      const err = e as Error & { code?: string; conflicts?: PresetConflict[] }
      if (err.code === 'preset-conflict' && err.conflicts) {
        const names = err.conflicts.map(c => `${c.name} (${t(`presets.kind.${c.kind}`)})`).join(', ')
        if (confirm(t('presets.conflictConfirm', { name, names }))) return run(preset, pack, true)
        return
      }
      toast.error(err.message)
    }
  }

  const load = async (preset: ProfileSetPreset, pack: PresetPack) => {
    const name = text(preset.name)
    if (preset.loaded) {
      const question = preset.loaded.pack === pack
        ? t('presets.resetConfirm', { name })
        : t('presets.switchConfirm', { name, pack: packName(pack) })
      if (!confirm(question)) return
    }
    setBusy({ id: preset.id, unloading: false })
    try { await run(preset, pack, false) } finally { setBusy(null) }
  }

  const unload = async (preset: ProfileSetPreset) => {
    const name = text(preset.name)
    if (!confirm(t('presets.unloadConfirm', { name }))) return
    setBusy({ id: preset.id, unloading: true })
    try {
      const out = await api.unloadPreset(preset.id)
      toast.success(t('presets.unloaded', { name, n: out.removed.length }))
      announceKept(out.kept)
      await refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-slate-500">{t('presets.intro')}</p>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {presets === null ? (
          <div className="flex items-center gap-2 p-4 text-sm text-slate-400">
            <div className="w-4 h-4 rounded-full border-2 border-slate-300 border-t-blue-500 animate-spin" />
            {t('presets.loading')}
          </div>
        ) : failed ? (
          <p className="p-6 text-sm text-amber-700 text-center">{t('presets.listError')}</p>
        ) : presets.length === 0 ? (
          <p className="p-6 text-sm text-slate-400 text-center italic">{t('presets.empty')}</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {presets.map(preset => {
              const summary = text(preset.summary)
              const blocked = preset.problems.length > 0
              const working = busy?.id === preset.id
              return (
                <li key={preset.id} className="flex items-start gap-3 px-4 py-3.5">
                  <Layers size={16} className="hidden sm:block text-slate-400 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-800">{text(preset.name)}</p>
                    {summary && <p className="text-xs text-slate-500 mt-0.5">{summary}</p>}
                    <p className="text-xs text-slate-400 mt-1">
                      {t('presets.counts', {
                        version: preset.version ?? '—',
                        classifiers: preset.packs.extended.classifiers,
                        domains: preset.packs.extended.domains,
                        algorithms: preset.packs.extended.algorithms,
                      })}
                    </p>
                    {preset.loaded && (
                      <p className="flex items-center gap-1 text-xs text-emerald-700 mt-1">
                        <CheckCircle2 size={12} />
                        {t('presets.loadedAt', {
                          pack: packName(preset.loaded.pack),
                          date: formatLoadedAt(preset.loaded.loaded_at, locale),
                        })}
                      </p>
                    )}
                    {preset.loaded && preset.version !== null && preset.loaded.version !== preset.version && (
                      <p className="text-xs text-amber-700 mt-1">{t('presets.newVersion', { version: preset.version })}</p>
                    )}
                    {blocked && (
                      <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                        <p className="font-medium">{t('presets.invalid')}</p>
                        <ul className="list-disc pl-4 mt-1 space-y-0.5">
                          {preset.problems.map((problem, i) => <li key={i}>{problem}</li>)}
                        </ul>
                      </div>
                    )}

                  {/* Below the text rather than beside it: three buttons beside it left the text a sliver. */}
                  <div className="flex flex-wrap items-center gap-2 mt-3">
                    {preset.docs.length > 0 ? (
                      <a
                        href={api.presetDocUrl(preset.id, locale)}
                        download
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors"
                      >
                        <FileDown size={13} /> {t('presets.doc')}
                      </a>
                    ) : (
                      <span
                        title={t('presets.noDoc')}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 border border-slate-100 rounded-lg cursor-not-allowed"
                      >
                        <FileDown size={13} /> {t('presets.doc')}
                      </span>
                    )}
                    <PackMenu
                      preset={preset}
                      disabled={blocked || busy !== null}
                      onPick={pack => load(preset, pack)}
                      className={cn(
                        'flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors disabled:opacity-60',
                        preset.loaded
                          ? 'text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100'
                          : 'text-white bg-blue-600 hover:bg-blue-700'
                      )}
                    >
                      {working && !busy.unloading ? <Loader2 size={13} className="animate-spin" /> : preset.loaded ? <RotateCcw size={13} /> : <Download size={13} />}
                      {working && !busy.unloading ? t('presets.working') : preset.loaded ? t('presets.reset') : t('presets.load')}
                    </PackMenu>
                    {preset.loaded && (
                      <button
                        onClick={() => unload(preset)}
                        disabled={busy !== null}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-700 bg-white hover:bg-red-50 border border-red-200 rounded-lg transition-colors disabled:opacity-60"
                      >
                        {working && busy.unloading ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                        {working && busy.unloading ? t('presets.unloading') : t('presets.unload')}
                      </button>
                    )}
                  </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

/**
 * The load button, opening the choice of pack. Each pack says what it brings, and the one loaded
 * is marked. Drawn fixed for the reason the sidebar's menus are: positioned inside the settings
 * page, the panel would scroll with it and could end up past the visible edge. Scrolling closes it.
 */
function PackMenu({ preset, disabled, onPick, className, children }: {
  preset: ProfileSetPreset
  disabled: boolean
  onPick: (pack: PresetPack) => void
  className: string
  children: React.ReactNode
}) {
  const { t } = useT()
  const [at, setAt] = useState<{ top: number; right: number } | null>(null)
  const open = at !== null
  const box = useRef<HTMLDivElement>(null)
  const close = () => setAt(null)

  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (open) { close(); return }
    const r = e.currentTarget.getBoundingClientRect()
    setAt({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) })
  }

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

  const packs = (['essential', 'extended'] as const).filter(pack => preset.packs[pack])

  return (
    <div ref={box}>
      <button onClick={toggle} disabled={disabled} aria-haspopup="menu" aria-expanded={open} className={className}>
        {children}
        <ChevronDown size={12} />
      </button>
      {at && (
        <div
          role="menu"
          style={{ top: at.top, right: at.right }}
          className="fixed z-50 w-72 max-w-[calc(100vw-16px)] rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
        >
          {packs.map(pack => {
            const counts = preset.packs[pack]!
            return (
              <button
                key={pack}
                role="menuitem"
                onClick={() => { close(); onPick(pack) }}
                className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-slate-50 transition-colors"
              >
                <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
                  {t(`presets.pack.${pack}`)}
                  {preset.loaded?.pack === pack && (
                    <span className="flex items-center gap-0.5 text-[10px] font-medium text-emerald-700">
                      <Check size={11} /> {t('presets.pack.current')}
                    </span>
                  )}
                </span>
                <span className="text-xs text-slate-500">{t(`presets.pack.${pack}Hint`)}</span>
                <span className="text-[11px] text-slate-400">
                  {t('presets.pack.counts', { domains: counts.domains, classifiers: counts.classifiers, algorithms: counts.algorithms })}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function FilesTab() {
  const { t } = useT()
  const [files, setFiles] = useState<ServerFile[]>([])
  const [loading, setLoading] = useState(true)
  const [editingFile, setEditingFile] = useState<{ name: string; content: string } | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newContent, setNewContent] = useState('')
  const [saving, setSaving] = useState(false)
  const uploadRef = useRef<HTMLInputElement>(null)

  const load = () => {
    setLoading(true)
    api.getFiles()
      .then(setFiles)
      .catch(() => toast.error(t('files.listError')))
      .finally(() => setLoading(false))
  }

  // Runs once on mount. Inlined for the same reason as elsewhere: `load` raises a flag that
  // already starts true. It closes over `t`, but the file list is locale-independent.
  useEffect(() => {
    api.getFiles().then(setFiles).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const startEdit = async (file: ServerFile) => {
    try {
      const content = await api.getFileContent(file.name)
      setEditingFile({ name: file.name, content })
      setIsCreating(false)
    } catch {
      toast.error(t('files.loadError'))
    }
  }

  const saveEdit = async () => {
    if (!editingFile) return
    setSaving(true)
    try {
      await api.updateFile(editingFile.name, editingFile.content)
      toast.success(t('files.savedOk'))
      setEditingFile(null)
      load()
    } catch {
      toast.error(t('files.saveError'))
    } finally {
      setSaving(false)
    }
  }

  const saveNew = async () => {
    if (!newName.trim()) { toast.warning(t('files.nameRequired')); return }
    setSaving(true)
    try {
      await api.createFile({ name: newName.trim(), content: newContent })
      toast.success(t('files.createdOk'))
      setIsCreating(false)
      setNewName('')
      setNewContent('')
      load()
    } catch {
      toast.error(t('files.createError'))
    } finally {
      setSaving(false)
    }
  }

  const deleteFile = async (name: string) => {
    if (!window.confirm(t('files.confirmDelete', { name }))) return
    try {
      await api.deleteFile(name)
      toast.success(t('files.deletedOk'))
      if (editingFile?.name === name) setEditingFile(null)
      load()
    } catch {
      toast.error(t('files.deleteError'))
    }
  }

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async ev => {
      try {
        await api.createFile({ name: file.name, content: ev.target?.result as string })
        toast.success(t('files.uploadedOk', { name: file.name }))
        load()
      } catch {
        toast.error(t('files.uploadError'))
      }
    }
    reader.readAsText(file, 'utf-8')
    e.target.value = ''
  }

  const startCreate = () => {
    setIsCreating(true)
    setEditingFile(null)
    setNewName('')
    setNewContent('')
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex gap-2">
        <button
          onClick={startCreate}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors"
        >
          <Plus size={14} /> {t('files.new')}
        </button>
        <button
          onClick={() => uploadRef.current?.click()}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-600 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors"
        >
          <Upload size={14} /> {t('files.upload')}
        </button>
        <input ref={uploadRef} type="file" accept="text/*,.txt,.csv" className="hidden" onChange={handleUpload} />
      </div>

      {isCreating && (
        <div className="bg-white rounded-xl border border-blue-200 shadow-sm p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-700">{t('files.newFileTitle')}</span>
            <button onClick={() => setIsCreating(false)} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
          </div>
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder={t('files.namePlaceholder')}
            className={fieldCls}
          />
          <textarea
            value={newContent}
            onChange={e => setNewContent(e.target.value)}
            rows={8}
            placeholder={t('files.contentPlaceholder')}
            className={cn(fieldCls, 'resize-y font-mono text-xs')}
          />
          <div className="flex gap-2">
            <button onClick={saveNew} disabled={saving} className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg transition-colors">
              <Check size={13} /> {t('files.save')}
            </button>
            <button onClick={() => setIsCreating(false)} className="px-3 py-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors">
              {t('files.cancel')}
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center gap-2 p-4 text-sm text-slate-400">
            <div className="w-4 h-4 rounded-full border-2 border-slate-300 border-t-blue-500 animate-spin" />
            {t('files.loading')}
          </div>
        ) : files.length === 0 ? (
          <p className="p-6 text-sm text-slate-400 text-center italic">
            {t('files.empty')}
          </p>
        ) : (
          <ul className="divide-y divide-slate-50">
              {files.map(f => (
                <li key={f.name} className={cn('flex items-center justify-between px-4 py-2.5 hover:bg-slate-50 transition-colors', editingFile?.name === f.name && 'bg-blue-50')}>
                  <span className="font-mono text-xs text-slate-700">{f.name}</span>
                  <div className="flex gap-1">
                    <button onClick={() => startEdit(f)} className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors" title={t('files.editTitle')}>
                      <Pencil size={13} />
                    </button>
                    <button onClick={() => deleteFile(f.name)} className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors" title={t('files.deleteTitle')}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </li>
              ))}
          </ul>
        )}
      </div>

      {editingFile && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-700 font-mono">{editingFile.name}</span>
            <button onClick={() => setEditingFile(null)} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
          </div>
          <textarea
            value={editingFile.content}
            onChange={e => setEditingFile({ ...editingFile, content: e.target.value })}
            rows={12}
            className={cn(fieldCls, 'resize-y font-mono text-xs')}
          />
          <div className="flex gap-2">
            <button onClick={saveEdit} disabled={saving} className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg transition-colors">
              <Check size={13} /> {t('files.save')}
            </button>
            <button onClick={() => setEditingFile(null)} className="px-3 py-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors">
              {t('files.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}


/**
 * The connection to one Delphix Continuous Compliance engine.
 *
 * An integration, not a set of credentials: configuring it copies the whole engine down at once,
 * and from then on the fields are locked. There is nothing useful about editing a URL under a
 * mirror of the instance that URL no longer names — changing engine means dropping this one,
 * which takes what came with it, and setting up the other.
 */
function DelphixTab() {
  const { t } = useT()
  const [baseUrl, setBaseUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [selfSigned, setSelfSigned] = useState(false)
  // What the config returned for the password: a mask, never the real value. Comparing against
  // it tells us whether the user actually typed a new one.
  const [maskedPassword, setMaskedPassword] = useState('')
  // Set when the password comes from an environment variable: the field then has no effect.
  const [passwordEnv, setPasswordEnv] = useState<string | null>(null)
  /** Whether an engine is stored, which is what locks the fields. Null until the config arrives. */
  const [linked, setLinked] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)
  // Import and export live outside this screen, so leaving Settings mid-job and coming back finds
  // the bar where it was and the buttons still locked.
  const job = useSyncJob()
  const busy = job?.kind ?? (removing ? 'remove' : null)
  const [status, setStatus] = useState<{ configured?: boolean; ok?: boolean; error?: string; apiRoot?: string } | null>(null)
  const [checking, setChecking] = useState(false)

  /** Puts the stored connection on screen. `linked` is what locks the fields. */
  const apply = (c: Record<string, string>) => {
    setBaseUrl(c['delphix.baseUrl'] ?? '')
    setUsername(c['delphix.username'] ?? '')
    setPassword(c['delphix.password'] ?? '')
    setMaskedPassword(c['delphix.password'] ?? '')
    setPasswordEnv(c['delphix.password.fromEnv'] ?? null)
    setSelfSigned(String(c['delphix.allowSelfSigned']) === 'true')
    setLinked(Boolean(c['delphix.baseUrl']))
  }

  const load = () => api.getConfig()
    .then(cfg => apply(cfg as unknown as Record<string, string>))
    .catch(() => {})

  useEffect(() => {
    api.getConfig().then(cfg => apply(cfg as unknown as Record<string, string>)).catch(() => {})
  }, [])

  // Tests what is on screen, so the button works before anything is saved. An untouched
  // password field still holds the mask, so it is sent blank and the server uses the stored one.
  const check = async () => {
    setChecking(true)
    try {
      setStatus(await api.delphixTest({
        baseUrl,
        username,
        password: password === maskedPassword ? '' : password,
        allowSelfSigned: selfSigned,
      }))
    } catch (e) {
      setStatus({ ok: false, error: (e as Error).message })
    } finally { setChecking(false) }
  }

  /** Brings the engine down. Shared by the first save and the Refresh button. */
  const pullEverything = () => startSync('import', t)

  /**
   * Saves the connection and, if it works, copies the engine down straight away.
   *
   * The import is not a separate step someone has to know to take: an integration that is
   * configured but empty is a screen full of nothing, and the first thing anyone would do next.
   */
  const save = async () => {
    setSaving(true)
    try {
      await api.updateConfig({
        'delphix.baseUrl': baseUrl,
        'delphix.username': username,
        'delphix.password': password,
        'delphix.allowSelfSigned': String(selfSigned),
      } as unknown as Record<string, string>)
      const probe = await api.delphixTest({ baseUrl, username, password: '', allowSelfSigned: selfSigned })
      setStatus(probe)
      if (!probe.ok) { toast.error(t('settings.dlpxFail')); return }
      await load()
      toast.success(t('settings.saved'))
      await pullEverything()
    } catch { toast.error(t('settings.saveError')) }
    finally { setSaving(false) }
  }

  const sendEverything = () => startSync('export', t)

  const removeIntegration = async () => {
    if (!confirm(t('settings.dlpxRemoveConfirm'))) return
    setRemoving(true)
    try {
      const out = await api.deleteDelphixIntegration()
      toast.success(t('settings.dlpxRemoved', {
        sets: out.removed.profileSets, classifiers: out.removed.classifiers,
        domains: out.removed.domains, algorithms: out.removed.algorithms,
      }))
      setStatus(null)
      await load()
      await refreshAfterImport()
    } catch (e) {
      toast.error((e as Error).message)
    } finally { setRemoving(false) }
  }

  const working = saving || busy !== null
  const locked = linked === true

  return (
    <div className="max-w-lg space-y-5">
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
        {locked && (
          <p className="flex gap-2 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-3">
            <Lock size={14} className="flex-shrink-0 mt-0.5 text-slate-400" />
            {t('settings.dlpxLocked')}
          </p>
        )}
        <div>
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
            {t('settings.dlpxUrl')}
          </label>
          <input type="text" value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
                 disabled={locked} placeholder="masking.example.com"
                 className={cn(fieldCls, locked && 'opacity-60')} />
          <p className="text-xs text-slate-400 mt-1">{t('settings.dlpxUrlHint')}</p>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
            {t('settings.dlpxUser')}
          </label>
          <input type="text" value={username} onChange={e => setUsername(e.target.value)}
                 disabled={locked} autoComplete="off"
                 className={cn(fieldCls, locked && 'opacity-60')} />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
            {t('settings.dlpxPassword')}
          </label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                 autoComplete="new-password" disabled={locked || Boolean(passwordEnv)}
                 className={cn(fieldCls, (locked || passwordEnv) && 'opacity-60')} />
          <p className="text-xs text-slate-400 mt-1">
            {passwordEnv
              ? t('settings.secretFromEnv', { name: passwordEnv })
              : t('settings.dlpxPasswordHint')}
          </p>
        </div>
        <label className={cn('flex items-start gap-2 text-sm text-slate-700', locked && 'opacity-60')}>
          <input type="checkbox" checked={selfSigned} onChange={e => setSelfSigned(e.target.checked)}
                 disabled={locked} className="mt-1" />
          <span>
            {t('settings.dlpxSelfSigned')}
            <span className="block text-xs text-slate-400">{t('settings.dlpxSelfSignedHint')}</span>
          </span>
        </label>

        {locked ? (
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={pullEverything} disabled={working}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors">
              {busy === 'import' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              {busy === 'import' ? t('settings.dlpxRefreshing') : t('settings.dlpxRefresh')}
            </button>
            <button onClick={sendEverything} disabled={working}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 disabled:opacity-60 transition-colors">
              {busy === 'export' ? <Loader2 size={14} className="animate-spin" /> : <CloudUpload size={14} />}
              {busy === 'export' ? t('settings.dlpxSendingAll') : t('settings.dlpxSendAll')}
            </button>
            <button onClick={check} disabled={working || checking}
                    className="px-4 py-2 text-sm font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-60 transition-colors">
              {checking ? t('settings.dlpxTesting') : t('settings.dlpxTest')}
            </button>
            <button onClick={removeIntegration} disabled={working}
                    className="ml-auto flex items-center gap-2 px-4 py-2 text-sm font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-60 transition-colors">
              <Trash2 size={14} />{t('settings.dlpxRemove')}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button onClick={save} disabled={working || !baseUrl.trim()}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors">
              <Save size={14} />{saving ? t('settings.saving') : t('settings.dlpxConnect')}
            </button>
            <button onClick={check} disabled={checking}
                    className="px-4 py-2 text-sm font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-60 transition-colors">
              {checking ? t('settings.dlpxTesting') : t('settings.dlpxTest')}
            </button>
          </div>
        )}

        {job?.progress && <ImportProgressBar progress={job.progress} />}
        {!locked && <p className="text-xs text-slate-400">{t('settings.dlpxConnectHint')}</p>}
      </div>

      {status && (
        <div className={cn('rounded-xl border p-4 text-sm',
          status.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                    : 'bg-amber-50 border-amber-200 text-amber-900')}>
          {status.ok
            ? <>{t('settings.dlpxOk')} <span className="font-mono text-xs">{status.apiRoot}</span></>
            : <>{t('settings.dlpxFail')} {status.error === 'not-configured' ? t('settings.dlpxNotSet') : status.error}</>}
        </div>
      )}
    </div>
  )
}

const fieldCls = 'w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow'
