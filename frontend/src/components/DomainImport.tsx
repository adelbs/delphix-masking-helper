import { useState, useEffect } from 'react'
import { X, Server, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { announceImport } from '@/lib/engine-sync'
import { ImportProgressBar } from '@/components/ImportProgressBar'
import { useImportProgress } from '@/lib/import-progress'

/**
 * Lists the engine's domains and copies the chosen ones down.
 *
 * Nothing is filtered out. A domain whose algorithm this tool cannot run is still a correct
 * domain — it lands in the "other" category in the sidebar and exports back unchanged — so
 * unlike the algorithm import there is no unsupported state to grey out. The algorithms a domain
 * names come down with it, when this tool can run them.
 */
export function DomainImport({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const { t } = useT()
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.delphixDomains>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const { progress, report, clear } = useImportProgress()

  useEffect(() => {
    api.delphixDomains().then(setRows).catch((e: Error & { code?: string }) =>
      setError(e.code === 'not-configured' ? t('saved.engineNotSet') : e.message))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (name: string) => setPicked(prev => {
    const next = new Set(prev)
    if (next.has(name)) next.delete(name); else next.add(name)
    return next
  })

  const all = rows ?? []
  const allPicked = all.length > 0 && all.every(r => picked.has(r.domainName))
  const toggleAll = () => setPicked(allPicked ? new Set() : new Set(all.map(r => r.domainName)))

  const run = async () => {
    setBusy(true)
    clear()
    try {
      const out = await api.delphixImportDomains([...picked], report)
      toast.success(t('domain.importDone', { n: out.imported.length }))
      announceImport(t, out)
      onImported()
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally { setBusy(false); clear() }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-slate-200">
          <Server size={16} className="text-blue-600" />
          <h3 className="text-sm font-semibold text-slate-800 flex-1">{t('domain.importTitle')}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-auto p-5">
          {error && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">{error}</p>}
          {!rows && !error && (
            <p className="text-sm text-slate-400 flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" />{t('saved.importLoading')}
            </p>
          )}
          {rows && all.length === 0 && !error && (
            <p className="text-sm text-slate-500">{t('domain.importNone')}</p>
          )}
          {all.length > 0 && (
            <label className="flex items-center gap-3 pb-2.5 mb-1 border-b border-slate-200 cursor-pointer">
              <input type="checkbox" checked={allPicked} onChange={toggleAll}
                     ref={el => { if (el) el.indeterminate = picked.size > 0 && !allPicked }} />
              <span className="text-sm font-medium text-slate-600">
                {t('saved.importSelectAll', { n: all.length })}
              </span>
            </label>
          )}
          {all.map(r => (
            <label key={r.domainName}
                   className="flex items-start gap-3 py-2.5 border-b border-slate-100 last:border-0 cursor-pointer">
              <input type="checkbox" className="mt-1"
                     checked={picked.has(r.domainName)}
                     onChange={() => toggle(r.domainName)} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-slate-800 truncate">{r.domainName}</span>
                <span className="block text-xs text-slate-400 truncate">
                  {r.defaultAlgorithmCode || '—'}
                  {r.defaultTokenizationCode && ` · ${r.defaultTokenizationCode}`}
                </span>
                {r.alreadyImported && (
                  <span className={cn('text-xs text-slate-400')}>{t('domain.importAlready')}</span>
                )}
              </span>
            </label>
          ))}
        </div>

        <div className="px-5 py-4 border-t border-slate-200 space-y-3">
          <button onClick={run} disabled={busy || picked.size === 0}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {busy && <Loader2 size={14} className="animate-spin" />}
            {t('saved.importSelected', { n: picked.size })}
          </button>
          {progress && <ImportProgressBar progress={progress} />}
        </div>
      </div>
    </div>
  )
}
