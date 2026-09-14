import { useState, useEffect } from 'react'
import { X, Server, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { useT, type MessageKey } from '@/lib/i18n'
import { useIssueText } from '@/lib/classifiers'
import { announceImport } from '@/lib/engine-sync'

/**
 * Lists the engine's classifiers and copies the chosen ones down.
 *
 * One that cannot be tested here — a regular expression construct or a check this tool does not
 * evaluate — still imports and still sends back unchanged, so it is flagged rather than greyed
 * out. Only a framework this tool does not know is unselectable.
 */
export function ClassifierImport({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const { t } = useT()
  const issueText = useIssueText()
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.delphixClassifiers>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.delphixClassifiers().then(setRows).catch((e: Error & { code?: string }) =>
      setError(e.code === 'not-configured' ? t('saved.engineNotSet') : e.message))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: number) => setPicked(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const selectable = (rows ?? []).filter(r => r.framework !== null)
  const allPicked = selectable.length > 0 && selectable.every(r => picked.has(r.classifierId))
  const toggleAll = () => setPicked(allPicked ? new Set() : new Set(selectable.map(r => r.classifierId)))

  const run = async () => {
    setBusy(true)
    try {
      const out = await api.delphixImportClassifiers([...picked])
      toast.success(t('classifier.importDone', { n: out.imported.length }))
      announceImport(t, out)
      onImported()
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-slate-200">
          <Server size={16} className="text-blue-600" />
          <h3 className="text-sm font-semibold text-slate-800 flex-1">{t('classifier.importTitle')}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-auto p-5">
          {error && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">{error}</p>}
          {!rows && !error && (
            <p className="text-sm text-slate-400 flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" />{t('saved.importLoading')}
            </p>
          )}
          {rows && rows.length === 0 && !error && (
            <p className="text-sm text-slate-500">{t('classifier.importNone')}</p>
          )}
          {selectable.length > 0 && (
            <label className="flex items-center gap-3 pb-2.5 mb-1 border-b border-slate-200 cursor-pointer">
              <input type="checkbox" checked={allPicked} onChange={toggleAll}
                     ref={el => { if (el) el.indeterminate = picked.size > 0 && !allPicked }} />
              <span className="text-sm font-medium text-slate-600">
                {t('saved.importSelectAll', { n: selectable.length })}
              </span>
            </label>
          )}
          {(rows ?? []).map(r => (
            <label key={r.classifierId}
                   className="flex items-start gap-3 py-2.5 border-b border-slate-100 last:border-0 cursor-pointer">
              <input type="checkbox" className="mt-1"
                     disabled={r.framework === null}
                     checked={picked.has(r.classifierId)}
                     onChange={() => toggle(r.classifierId)} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-slate-800 truncate">{r.classifierName}</span>
                <span className="block text-xs text-slate-400 truncate">
                  {r.domainName || '—'} · {r.framework ? t(`classifier.fw.${r.framework}` as MessageKey) : '?'}
                </span>
                {r.alreadyImported && (
                  <span className="block text-xs text-slate-400">{t('classifier.importAlready')}</span>
                )}
                {r.framework === null && (
                  <span className="block text-xs text-amber-700">{t('classifier.importUnknownFramework')}</span>
                )}
                {r.issues.length > 0 && (
                  <span className="block text-xs text-amber-700">
                    {t('classifier.importUnsupported', { reason: issueText(r.framework, r.issues[0]) })}
                  </span>
                )}
                {r.downloadFiles.length > 0 && (
                  <span className="block text-xs text-slate-500">
                    {t('sync.filesComeAlong', { files: r.downloadFiles.join(', ') })}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>

        <div className="px-5 py-4 border-t border-slate-200">
          <button onClick={run} disabled={busy || picked.size === 0}
                  className="px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {t('saved.importSelected', { n: picked.size })}
          </button>
        </div>
      </div>
    </div>
  )
}
