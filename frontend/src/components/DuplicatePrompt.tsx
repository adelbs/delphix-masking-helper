import { useState } from 'react'
import { X, Check, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useT } from '@/lib/i18n'

/** Asks for the new algorithm's name. Duplicating is how a new name is given, since the engine
 *  treats the name as identity and refuses to change it on an existing algorithm. */
export function DuplicatePrompt({ suggested, onConfirm, onCancel }: {
  suggested: string
  onConfirm: (name: string) => Promise<void>
  onCancel: () => void
}) {
  const { t: msg } = useT()
  const [name, setName] = useState(suggested)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = async () => {
    const trimmed = name.trim()
    if (!trimmed) { setError(msg('saved.duplicateNameRequired')); return }
    setBusy(true); setError(null)
    try {
      await onConfirm(trimmed)
      toast.success(msg('saved.duplicateDone', { name: trimmed }))
    } catch (e) {
      setError((e as Error).message)
    } finally { setBusy(false) }
  }

  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
        <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
          {msg('saved.duplicateName')}
        </label>
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null) }}
            onKeyDown={(e) => { if (e.key === 'Enter') confirm(); if (e.key === 'Escape') onCancel() }}
            className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <button onClick={confirm} disabled={busy}
                  className="flex items-center gap-1 text-xs font-semibold px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            {msg('saved.duplicateConfirm')}
          </button>
          <button onClick={onCancel} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg">
            <X size={14} />
          </button>
        </div>
        {error && <p className="text-xs text-amber-800 mt-1.5">{error}</p>}
        <p className="text-xs text-slate-400 mt-1.5">{msg('saved.duplicateHint')}</p>
      </div>
  )
}
