import { useState, useRef, useEffect, useCallback } from 'react'
import { Send, Square, Sparkles, BookmarkCheck, AlertTriangle, Settings2, Trash2, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import type { AiStatus, ChatMessage, SavedAlgorithm } from '@/types'

interface Props {
  onShowSaved: () => void
  onOpenSettings: () => void
}

/** One turn in the transcript, plus whatever the assistant produced alongside the text. */
interface Turn extends ChatMessage {
  saved?: SavedAlgorithm
  notice?: string
  failed?: boolean
}

export function Chat({ onShowSaved, onOpenSettings }: Props) {
  const { t } = useT()
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<AiStatus | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const refreshStatus = useCallback(() => {
    api.getAiStatus().then(setStatus).catch(() => setStatus(null))
  }, [])

  useEffect(() => { refreshStatus() }, [refreshStatus])

  // While the model is loading there is nothing to react to but time: poll until it is in.
  const warming = status?.warm?.state === 'warming'
  useEffect(() => {
    if (!warming) return
    const id = setInterval(refreshStatus, 5000)
    return () => clearInterval(id)
  }, [warming, refreshStatus])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [turns, busy])

  const send = async (text: string) => {
    const message = text.trim()
    if (!message || busy) return

    const history: ChatMessage[] = [
      ...turns.map(({ role, content }) => ({ role, content })),
      { role: 'user' as const, content: message },
    ]
    setTurns(ts => [...ts, { role: 'user', content: message }, { role: 'assistant', content: '' }])
    setDraft('')
    setBusy(true)

    const controller = new AbortController()
    abortRef.current = controller
    // Only the trailing assistant turn is mutated while the reply streams in.
    const patchLast = (patch: Partial<Turn> | ((prev: Turn) => Partial<Turn>)) =>
      setTurns(ts => ts.map((turn, i) =>
        i === ts.length - 1 ? { ...turn, ...(typeof patch === 'function' ? patch(turn) : patch) } : turn))

    try {
      await api.streamChat(history, {
        onDelta: (delta) => patchLast(prev => ({ content: prev.content + delta })),
        onReplace: (final) => patchLast({ content: final }),
        onSaved: (saved) => patchLast({ saved }),
        onSaveError: (notice) => patchLast({ notice }),
        onError: (notice) => patchLast({ notice, failed: true }),
      }, controller.signal)
    } catch (err) {
      if (!controller.signal.aborted) patchLast({ notice: (err as Error).message, failed: true })
    } finally {
      setBusy(false)
      abortRef.current = null
      refreshStatus()
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(draft) }
  }

  const suggestions = [t('chat.suggestion1'), t('chat.suggestion2'), t('chat.suggestion3')]

  return (
    <div className="flex flex-col h-full min-h-0">
      {status?.provider === 'ollama' && (
        <div className="flex items-start gap-2 mx-auto w-full max-w-3xl mb-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <span className="font-medium">{t('chat.localLimits')}</span>{' '}
            {t('chat.localLimitsHint')}
          </div>
          <button onClick={onOpenSettings} className="flex items-center gap-1 flex-shrink-0 font-medium hover:underline">
            <Settings2 size={12} /> {t('chat.configure')}
          </button>
        </div>
      )}

      {warming && (
        <div className="flex items-start gap-2 mx-auto w-full max-w-3xl mb-3 px-3 py-2 rounded-lg bg-blue-50 border border-blue-200 text-xs text-blue-800">
          <Loader2 size={14} className="flex-shrink-0 mt-0.5 animate-spin" />
          <div className="flex-1">
            <span className="font-medium">
              {t('chat.warming', { model: status?.warm?.model ?? '', seconds: String(status?.warm?.elapsedSec ?? 0) })}
            </span>{' '}
            {t('chat.warmingHint')}
          </div>
        </div>
      )}

      {status && !status.ok && (
        <div className="flex items-start gap-2 mx-auto w-full max-w-3xl mb-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <span className="font-medium">{t('chat.providerDown', { provider: status.provider })}</span>{' '}
            {status.error}
          </div>
          <button onClick={onOpenSettings} className="flex items-center gap-1 flex-shrink-0 font-medium hover:underline">
            <Settings2 size={12} /> {t('chat.configure')}
          </button>
        </div>
      )}

      <div className="flex-1 overflow-auto min-h-0">
        <div className="mx-auto w-full max-w-3xl space-y-4 pb-2">
          {turns.length === 0 ? (
            <div className="space-y-2 pt-2">
              <p className="text-sm text-slate-500">{t('chat.empty')}</p>
              {suggestions.map(sug => (
                <button
                  key={sug}
                  onClick={() => send(sug)}
                  className="block w-full text-left px-3 py-2 text-sm text-slate-600 bg-white border border-slate-200 rounded-lg hover:border-blue-300 hover:text-blue-700 transition-colors"
                >
                  {sug}
                </button>
              ))}
            </div>
          ) : (
            turns.map((turn, i) => (
              <Bubble key={i} turn={turn} streaming={busy && i === turns.length - 1} onShowSaved={onShowSaved} />
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl pt-3">
        <div className="flex gap-2 items-end">
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder={t('chat.placeholder')}
            className="flex-1 resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          {busy ? (
            <button onClick={() => abortRef.current?.abort()} title={t('chat.stop')} className="p-2.5 rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors">
              <Square size={16} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={() => send(draft)}
              disabled={!draft.trim()}
              title={t('chat.send')}
              className="p-2.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Send size={16} />
            </button>
          )}
        </div>
        <div className="flex items-center justify-between mt-1.5 px-0.5">
          <span className="text-[11px] text-slate-400">{status ? `${status.provider} · ${status.model}` : ''}</span>
          {turns.length > 0 && (
            <button onClick={() => setTurns([])} className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-600 transition-colors">
              <Trash2 size={11} /> {t('chat.clear')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Bubble({ turn, streaming, onShowSaved }: { turn: Turn; streaming: boolean; onShowSaved: () => void }) {
  const { t } = useT()

  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-blue-600 px-3.5 py-2 text-sm text-white whitespace-pre-wrap">
          {turn.content}
        </div>
      </div>
    )
  }

  return (
    <div className="flex gap-2.5">
      <div className="w-6 h-6 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Sparkles size={13} className="text-blue-600" />
      </div>
      <div className="flex-1 min-w-0 space-y-2">
        {turn.content && (
          <div className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{turn.content}</div>
        )}
        {streaming && !turn.content && (
          <div className="flex gap-1 items-center h-5">
            {[0, 150, 300].map(d => (
              <span key={d} className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: `${d}ms` }} />
            ))}
          </div>
        )}

        {turn.saved && (
          <div className="rounded-xl border border-green-200 bg-green-50 p-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-green-800">
              <BookmarkCheck size={13} /> {t('chat.savedTitle')}
            </div>
            <p className="mt-1 text-sm font-medium text-slate-800">{turn.saved.name}</p>
            <p className="text-xs text-slate-500 font-mono">{turn.saved.displayName}</p>
            {turn.saved.output !== null && (
              <p className="mt-1.5 text-xs text-slate-600 font-mono break-all">
                {turn.saved.input} <span className="text-slate-400">→</span>{' '}
                <span className="font-semibold text-green-700">{turn.saved.output}</span>
              </p>
            )}
            <button onClick={onShowSaved} className="mt-2 text-xs font-medium text-green-800 hover:underline">
              {t('chat.savedOpen')}
            </button>
          </div>
        )}

        {turn.notice && (
          <div className={cn(
            'rounded-lg border px-3 py-2 text-xs',
            turn.failed ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-800'
          )}>
            {turn.notice}
          </div>
        )}
      </div>
    </div>
  )
}
