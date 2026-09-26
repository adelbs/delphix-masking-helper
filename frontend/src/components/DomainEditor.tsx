import { useState } from 'react'
import { PanelLeftOpen, Save, Trash2, CloudUpload, Loader2, Tags } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { useAlgorithms } from '@/lib/algorithms'
import { refreshDomains, useDomains } from '@/lib/domains'
import { algorithmOptions, tokenizationOptions, useBuiltinReferences, useEngineReferences } from '@/lib/references'
import { ReferencePicker } from '@/components/ReferencePicker'
import { isSending, startObjectExport, useSyncJob } from '@/lib/sync-job'
import { ImportProgressBar } from '@/components/ImportProgressBar'
import type { Domain } from '@/types'

/**
 * A domain is a name and two algorithm references — the whole of the engine's Domain object,
 * so this panel is the whole editor.
 *
 * The name is set on create and never again: on the engine it travels in the URL path and
 * cannot be changed, and the tool follows the same rule it follows for algorithm names.
 */
export function DomainEditor({ domain: opened, onToggleSidebar, onDeleted, onCreated }: {
  /** null while creating. */
  domain: Domain | null
  onToggleSidebar: () => void
  onDeleted: () => void
  onCreated: (created: Domain) => void
}) {
  const { t } = useT()
  const { algorithms } = useAlgorithms()
  const { domains } = useDomains()
  const builtins = useBuiltinReferences()
  const engine = useEngineReferences()

  // The live row, not the one this panel was opened with. Sending to the engine sets
  // delphix_origin server-side, and reading it off the prop left the header still claiming
  // "local only" after a successful push, until you navigated away and back.
  const domain = opened ? (domains.find(d => d.id === opened.id) ?? opened) : null
  const [name, setName] = useState('')
  const [algorithm, setAlgorithm] = useState(domain?.default_algorithm ?? '')
  const [tokenization, setTokenization] = useState(domain?.default_tokenization ?? '')
  const [busy, setBusy] = useState(false)
  // Sending runs as the app's sync job, so it outlives this screen and its bar comes back with it.
  const job = useSyncJob()
  const sending = isSending(job, 'domain', domain?.id)

  const editing = domain !== null

  const save = async () => {
    setBusy(true)
    try {
      if (editing) {
        await api.updateDomain(domain.id, { defaultAlgorithm: algorithm, defaultTokenization: tokenization })
        toast.success(t('domain.saved'))
        await refreshDomains()
      } else {
        const created = await api.createDomain({
          name: name.trim(), defaultAlgorithm: algorithm, defaultTokenization: tokenization,
        })
        toast.success(t('domain.created'))
        await refreshDomains()
        onCreated(created)
      }
    } catch (e) {
      const err = e as Error & { code?: string }
      toast.error(
        err.code === 'name-taken' ? t('domain.nameTaken')
        : err.code === 'name-required' ? t('domain.nameRequired')
        : err.code === 'name-too-long' ? t('domain.nameTooLong')
        : err.message)
    } finally { setBusy(false) }
  }

  const sendToEngine = async () => {
    if (!editing) return
    await startObjectExport('domain', { id: domain.id, name: domain.name }, t)
  }

  const remove = async () => {
    if (!editing) return
    if (!confirm(t('domain.confirmDelete'))) return
    try {
      await api.deleteDomain(domain.id)
      toast.success(t('domain.deleted'))
      await refreshDomains()
      onDeleted()
    } catch { toast.error(t('tester.unknownError')) }
  }

  // The saved algorithms, the plugin's built-ins and the engine's: a domain on a stock engine
  // points at built-ins this machine may not hold, so the saved list alone would not do.
  const algorithmChoices = algorithmOptions(algorithms, builtins?.algorithms ?? null, engine.algorithms)
  // The engine refuses a tokenization algorithm that cannot tokenize, so only those are offered;
  // any other algorithm typed there is named as such rather than as unknown.
  const tokenizationChoices = tokenizationOptions(algorithms, builtins, engine.tokenization)

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-200 bg-white flex-shrink-0">
        <button onClick={onToggleSidebar} className="text-slate-400 hover:text-slate-600 transition-colors">
          <PanelLeftOpen size={18} />
        </button>
        <Tags size={16} className="text-slate-500 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-slate-800 truncate">
            {editing ? domain.name : t('domain.newTitle')}
          </h2>
          <p className="text-xs text-slate-400 truncate">
            {editing && domain.delphix_origin ? t('domain.fromEngine') : t('domain.local')}
          </p>
        </div>
        {editing && (
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button
              onClick={sendToEngine}
              disabled={job !== null}
              className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors disabled:opacity-50"
            >
              {sending ? <Loader2 size={12} className="animate-spin" /> : <CloudUpload size={12} />}
              <span className="hidden lg:inline">{t('saved.exportToEngine')}</span>
            </button>
            <button
              onClick={remove}
              title={t('saved.delete')}
              className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>
      {sending && job?.progress && (
        <div className="px-5 py-2.5 border-b border-slate-200 bg-white flex-shrink-0">
          <ImportProgressBar progress={job.progress} />
        </div>
      )}

      <div className="flex-1 overflow-auto p-5 bg-slate-50">
        <div className="max-w-lg space-y-5">
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
            <div>
              <label className={labelCls}>{t('domain.name')}</label>
              {editing ? (
                <p className="font-mono text-sm text-slate-800 py-2">{domain.name}</p>
              ) : (
                <input
                  autoFocus
                  type="text"
                  maxLength={100}
                  value={name}
                  onChange={e => setName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') save() }}
                  placeholder={t('domain.namePlaceholder')}
                  className={fieldCls}
                />
              )}
              <p className="text-xs text-slate-400 mt-1">
                {editing ? t('domain.nameFixed') : t('domain.nameHint')}
              </p>
            </div>

            <div>
              <label className={labelCls}>{t('domain.algorithm')}</label>
              <ReferencePicker
                kind="algorithm"
                value={algorithm}
                onChange={setAlgorithm}
                options={algorithmChoices}
                engineState={engine.state}
                maxLength={500}
                placeholder={t('domain.algorithmPlaceholder')}
                className={fieldCls}
              />
              <p className="text-xs text-slate-400 mt-1">{t('domain.algorithmHint')}</p>
            </div>

            <div>
              <label className={labelCls}>{t('domain.tokenization')}</label>
              <ReferencePicker
                kind="algorithm"
                value={tokenization}
                onChange={setTokenization}
                options={tokenizationChoices}
                misfit={{ options: algorithmChoices, message: 'reference.cannotTokenize' }}
                engineState={engine.state}
                maxLength={500}
                placeholder={t('domain.tokenizationPlaceholder')}
                className={fieldCls}
              />
              <p className="text-xs text-slate-400 mt-1">{t('domain.tokenizationHint')}</p>
            </div>

            <button
              onClick={save}
              disabled={busy || (!editing && !name.trim())}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {editing ? t('tester.saveChanges') : t('domain.create')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const labelCls = 'block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5'
const fieldCls = 'w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'
