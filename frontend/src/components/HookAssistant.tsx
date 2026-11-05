import { useEffect, useRef, useState } from 'react'
import { Send, Square, Sparkles, Trash2, Settings2, Replace, CornerDownLeft } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import type { AiStatus, ChatMessage, Hook } from '@/types'

/** A reply cut into prose and code blocks, so a block can go into the editor. */
function pieces(text: string): Array<{ code: boolean; text: string }> {
  const out: Array<{ code: boolean; text: string }> = []
  const fence = /```[\w-]*\n([\s\S]*?)(```|$)/g
  let at = 0
  for (const m of text.matchAll(fence)) {
    if (m.index! > at) out.push({ code: false, text: text.slice(at, m.index) })
    out.push({ code: true, text: m[1].replace(/\n$/, '') })
    at = m.index! + m[0].length
  }
  if (at < text.length) out.push({ code: false, text: text.slice(at) })
  return out
}

/**
 * The assistant on the hook on screen: it reads the script as it is now, at every question, and
 * answers with prose and a whole script that one click puts in the editor.
 */
export function HookAssistant({ hook, onReplace, onInsert, onOpenSettings }: {
  hook: Pick<Hook, 'name' | 'description' | 'shell' | 'command' | 'credentials'>
  onReplace: (script: string) => void
  onInsert: (text: string) => void
  onOpenSettings?: () => void
}) {
  const { t } = useT()
  const [turns, setTurns] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => { api.getAiStatus().then(setStatus).catch(() => setStatus(null)) }, [])
  useEffect(() => () => abort.current?.abort(), [])
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [turns])

  const ask = async (text: string) => {
    const message = text.trim()
    if (!message || busy) return
    const history: ChatMessage[] = [...turns, { role: 'user', content: message }]
    setTurns([...history, { role: 'assistant', content: '' }])
    setDraft('')
    setError(null)
    setBusy(true)
    const controller = new AbortController()
    abort.current = controller
    try {
      await api.streamHookAssist({ messages: history, hook }, delta => setTurns(ts => {
        const last = ts[ts.length - 1]
        return [...ts.slice(0, -1), { ...last, content: last.content + delta }]
      }), controller.signal)
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message)
    } finally {
      setBusy(false)
      abort.current = null
    }
  }

  const unavailable = status && !status.ok
  const suggestions = [t('hook.ai.suggestReview'), t('hook.ai.suggestExplain'), t('hook.ai.suggestWait')]

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 mb-2">
        <p className="flex-1 text-xs text-slate-400">
          {status ? t('hook.ai.model', { provider: status.provider, model: status.model }) : t('hook.ai.hint')}
        </p>
        {turns.length > 0 && (
          <button onClick={() => { abort.current?.abort(); setTurns([]); setError(null) }} title={t('hook.ai.clear')}
                  className="p-1 text-slate-400 hover:text-red-500 rounded"><Trash2 size={13} /></button>
        )}
      </div>
      {unavailable && (
        <div className="mb-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          {t('hook.ai.unavailable', { error: status?.error ?? '' })}
          {onOpenSettings && (
            <button onClick={onOpenSettings} className="ml-1 inline-flex items-center gap-1 underline"><Settings2 size={11} />{t('hook.ai.settings')}</button>
          )}
        </div>
      )}

      <div className="flex-1 min-h-[12rem] overflow-y-auto space-y-3 pr-1">
        {turns.length === 0 && (
          <div className="space-y-1.5 pt-1">
            <p className="flex items-center gap-1.5 text-xs text-slate-500"><Sparkles size={12} className="text-blue-500" />{t('hook.ai.intro')}</p>
            {suggestions.map(s => (
              <button key={s} onClick={() => ask(s)} disabled={busy}
                      className="block w-full text-left text-xs text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-100 rounded-lg px-3 py-1.5">
                {s}
              </button>
            ))}
          </div>
        )}
        {turns.map((turn, i) => (
          <div key={i} className={cn('text-xs leading-5', turn.role === 'user' ? 'ml-6 bg-blue-600 text-white rounded-lg px-3 py-2' : 'text-slate-700')}>
            {turn.role === 'user' ? <p className="whitespace-pre-wrap">{turn.content}</p> : (
              turn.content === '' && busy && i === turns.length - 1
                ? <p className="text-slate-400 italic">{t('hook.ai.thinking')}</p>
                : pieces(turn.content).map((p, j) => p.code ? (
                  <div key={j} className="my-2 rounded-lg border border-slate-800 bg-slate-950 overflow-hidden">
                    <pre className="max-h-72 overflow-auto p-2.5 text-[11px] leading-4 font-mono text-slate-100 whitespace-pre">{p.text}</pre>
                    {!(busy && i === turns.length - 1) && (
                      <div className="flex gap-1.5 px-2 py-1.5 border-t border-slate-800 bg-slate-900">
                        <button onClick={() => { if (!hook.command.trim() || confirm(t('hook.ai.confirmReplace'))) onReplace(p.text) }}
                                className="flex items-center gap-1 text-[11px] text-slate-100 bg-blue-600 hover:bg-blue-700 rounded px-2 py-0.5">
                          <Replace size={11} />{t('hook.ai.replace')}
                        </button>
                        <button onClick={() => onInsert(p.text)}
                                className="flex items-center gap-1 text-[11px] text-slate-200 hover:bg-slate-800 rounded px-2 py-0.5">
                          <CornerDownLeft size={11} />{t('hook.ai.insert')}
                        </button>
                      </div>
                    )}
                  </div>
                ) : <p key={j} className="whitespace-pre-wrap">{p.text.trim()}</p>)
            )}
          </div>
        ))}
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div ref={bottom} />
      </div>

      <div className="flex items-end gap-1.5 pt-2 mt-2 border-t border-slate-100">
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(draft) } }}
          rows={2}
          placeholder={t('hook.ai.placeholder')}
          className="flex-1 resize-none rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
        {busy ? (
          <button onClick={() => abort.current?.abort()} title={t('hook.ai.stop')} className="p-2 text-white bg-red-600 hover:bg-red-700 rounded-lg"><Square size={14} /></button>
        ) : (
          <button onClick={() => ask(draft)} disabled={!draft.trim()} title={t('hook.ai.send')}
                  className="p-2 text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50"><Send size={14} /></button>
        )}
      </div>
    </div>
  )
}
