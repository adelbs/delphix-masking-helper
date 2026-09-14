import { useState, useEffect } from 'react'
import { X, Server, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { announceImport } from '@/lib/engine-sync'
import { ImportProgressBar } from '@/components/ImportProgressBar'
import { useImportProgress } from '@/lib/import-progress'

/**
 * Lists the engine's profile sets and copies the chosen ones down.
 *
 * A set is only a selection, so importing one brings the classifiers it names — and, through
 * them, their domains, those domains' algorithms and the list files. A stock engine's sets run to
 * a hundred and sixty classifiers, which is why this is the slowest import of the three and the
 * one that most needed a progress bar.
 */
export function ProfileSetImport({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const { t } = useT()
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.delphixProfileSets>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const { progress, report, clear } = useImportProgress()

  useEffect(() => {
    api.delphixProfileSets().then(setRows).catch((e: Error & { code?: string }) =>
      setError(e.code === 'not-configured' ? t('saved.engineNotSet') : e.message))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: number) => setPicked(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const all = rows ?? []
  const allPicked = all.length > 0 && all.every(r => picked.has(r.profileSetId))
  const toggleAll = () => setPicked(allPicked ? new Set() : new Set(all.map(r => r.profileSetId)))

  const run = async () => {
    setBusy(true)
    clear()
    try {
      const out = await api.delphixImportProfileSets([...picked], report)
      toast.success(t('profileSet.importDone', { n: out.imported.length }))
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
          <h3 className="text-sm font-semibold text-slate-800 flex-1">{t('profileSet.importTitle')}</h3>
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
            <p className="text-sm text-slate-500">{t('profileSet.importNone')}</p>
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
            <label key={r.profileSetId} className="flex items-start gap-3 py-2.5 border-b border-slate-100 last:border-0 cursor-pointer">
              <input type="checkbox" className="mt-1" checked={picked.has(r.profileSetId)}
                     onChange={() => toggle(r.profileSetId)} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-slate-800 truncate">{r.profileSetName}</span>
                <span className="block text-xs text-slate-400">
                  {t('profileSet.importMembers', { n: r.classifiers, threshold: r.assignmentThreshold ?? '—' })}
                </span>
                {r.description && (
                  <span className="block text-xs text-slate-500 truncate">{r.description}</span>
                )}
                {r.untestable > 0 && (
                  <span className="block text-xs text-amber-700">
                    {t('profileSet.importUntestable', { n: r.untestable })}
                  </span>
                )}
                {r.alreadyImported && (
                  <span className="block text-xs text-slate-400">{t('profileSet.importAlready')}</span>
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
