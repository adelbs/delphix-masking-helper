import { useState, useEffect } from 'react'
import { X, Server, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { announceImport } from '@/lib/engine-sync'
import { ImportProgressBar } from '@/components/ImportProgressBar'
import { useImportProgress } from '@/lib/import-progress'

/** Lists what the configured engine has and imports the chosen algorithms. */
export function EngineImport({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const { t: msg } = useT()
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.delphixAlgorithms>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const { progress, report, clear } = useImportProgress()

  // Runs once when the dialog opens. `msg` is only read to word one error, and the dialog is
  // never open across a language change, so it is deliberately not a dependency.
  useEffect(() => {
    api.delphixAlgorithms().then(setRows).catch((e: Error & { code?: string }) =>
      setError(e.code === 'not-configured' ? msg('saved.engineNotSet') : e.message))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (name: string) => setPicked(prev => {
    const next = new Set(prev)
    if (next.has(name)) next.delete(name); else next.add(name)
    return next
  })

  const run = async () => {
    setBusy(true)
    clear()
    try {
      const out = await api.delphixImport([...picked], report)
      toast.success(msg('saved.importDone', { n: out.imported.length }))
      // The rows are saved either way; this is what came with them and what they still lack.
      announceImport(msg, out)
      onImported()
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally { setBusy(false); clear() }
  }

  const importable = (rows ?? []).filter(r => r.supported)
  const allPicked = importable.length > 0 && importable.every(r => picked.has(r.algorithmName))

  // Only the importable rows: the others cannot be selected one by one either, and putting
  // them in would leave the box looking unchecked however many times it is clicked.
  const toggleAll = () =>
    setPicked(allPicked ? new Set() : new Set(importable.map(r => r.algorithmName)))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-slate-200">
          <Server size={16} className="text-blue-600" />
          <h3 className="text-sm font-semibold text-slate-800 flex-1">{msg('saved.importTitle')}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-auto p-5">
          {error && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">{error}</p>}
          {!rows && !error && (
            <p className="text-sm text-slate-400 flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" />{msg('saved.importLoading')}
            </p>
          )}
          {rows && importable.length === 0 && !error && (
            <p className="text-sm text-slate-500">{msg('saved.importNone')}</p>
          )}
          {rows && importable.length > 0 && (
            <label className="flex items-center gap-3 pb-2.5 mb-1 border-b border-slate-200 cursor-pointer">
              <input type="checkbox" checked={allPicked} onChange={toggleAll}
                     ref={el => { if (el) el.indeterminate = picked.size > 0 && !allPicked }} />
              <span className="text-sm font-medium text-slate-600">
                {msg('saved.importSelectAll', { n: importable.length })}
              </span>
            </label>
          )}
          {rows?.map(r => (
            <label key={r.algorithmName}
                   className={cn('flex items-start gap-3 py-2.5 border-b border-slate-100 last:border-0',
                                 r.supported ? 'cursor-pointer' : 'opacity-55')}>
              <input type="checkbox" disabled={!r.supported} className="mt-1"
                     checked={picked.has(r.algorithmName)}
                     onChange={() => toggle(r.algorithmName)} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-slate-800 truncate">{r.algorithmName}</span>
                <span className="block text-xs text-slate-400 truncate">{r.frameworkName ?? '—'}</span>
                {!r.supported && (
                  <span className="text-xs text-amber-700">{msg('saved.importUnsupported')}</span>
                )}
                {r.alreadyImported && (
                  <span className="text-xs text-slate-400">{msg('saved.importAlready')}</span>
                )}
                {r.supported && r.downloadFiles?.length > 0 && (
                  <span className="block text-xs text-slate-500">
                    {msg('sync.filesComeAlong', { files: r.downloadFiles.join(', ') })}
                  </span>
                )}
                {r.supported && r.missingFiles?.length > 0 && (
                  <span className="block text-xs text-amber-700">
                    {msg('saved.importNeedsFiles', {
                      n: r.missingFiles.length, files: r.missingFiles.join(', '),
                    })}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>

        <div className="px-5 py-4 border-t border-slate-200 space-y-3">
          <button onClick={run} disabled={busy || picked.size === 0}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {busy && <Loader2 size={14} className="animate-spin" />}
            {msg('saved.importSelected', { n: picked.size })}
          </button>
          {progress && <ImportProgressBar progress={progress} />}
        </div>
      </div>
    </div>
  )
}
