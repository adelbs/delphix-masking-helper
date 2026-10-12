import { forwardRef, useMemo, useRef, type KeyboardEvent } from 'react'
import { cn } from '../lib/utils'
import { tokenize, TOKEN_CLASS, type ScriptLanguage } from '../lib/script-highlight'

interface Props {
  value: string
  onChange: (value: string) => void
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  language: ScriptLanguage
  rows?: number
}

// The text, the spacing and the wrapping of both layers must match to the pixel.
const LAYER = 'm-0 px-3 py-2 font-mono text-xs leading-5 whitespace-pre break-normal [tab-size:4]'

/**
 * A plain textarea whose text is transparent, over a highlighted copy of the same text: typing,
 * selection, undo and the caret are the browser's own, and the colours come from underneath.
 */
const ScriptEditor = forwardRef<HTMLTextAreaElement, Props>(function ScriptEditor({ value, onChange, onKeyDown, language, rows = 20 }, ref) {
  const under = useRef<HTMLPreElement>(null)
  const tokens = useMemo(() => tokenize(value, language), [value, language])

  return (
    <div className="relative rounded-lg border border-slate-200 bg-slate-50 focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-transparent">
      <pre ref={under} aria-hidden className={cn(LAYER, 'absolute inset-0 overflow-hidden pointer-events-none')}>
        {tokens.map((tk, i) => <span key={i} className={TOKEN_CLASS[tk.kind]}>{tk.text}</span>)}
        {/* A final newline needs a line under it, as the textarea gives it one. */}
        {'\n'}
      </pre>
      <textarea
        ref={ref}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={e => {
          if (!under.current) return
          under.current.scrollTop = e.currentTarget.scrollTop
          under.current.scrollLeft = e.currentTarget.scrollLeft
        }}
        rows={rows}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        className={cn(LAYER, 'relative block w-full resize-y bg-transparent text-transparent caret-slate-800 selection:bg-blue-200/60 outline-hidden overflow-auto')}
      />
    </div>
  )
})

export default ScriptEditor
