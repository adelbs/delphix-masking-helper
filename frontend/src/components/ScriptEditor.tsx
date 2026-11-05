import { forwardRef, useMemo, useRef, type KeyboardEvent } from 'react'
import { cn } from '../lib/utils'
import { tokenize, TOKEN_CLASS, type ScriptLanguage } from '../lib/script-highlight'

interface Props {
  value: string
  onChange: (value: string) => void
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  /** Each move of the caret or the selection, so an insert lands where the user left it. */
  onSelect?: (start: number, end: number) => void
  language: ScriptLanguage
  rows?: number
  readOnly?: boolean
  /** Takes the whole height of its parent instead of a number of rows. */
  fill?: boolean
}

// The text, the spacing and the wrapping of both layers must match to the pixel.
const LAYER = 'm-0 px-3 py-2 font-mono text-xs leading-5 whitespace-pre break-normal [tab-size:4]'

/**
 * A plain textarea whose text is transparent, over a highlighted copy of the same text: typing,
 * selection, undo and the caret are the browser's own, and the colours come from underneath.
 */
const ScriptEditor = forwardRef<HTMLTextAreaElement, Props>(function ScriptEditor({ value, onChange, onKeyDown, onSelect, language, rows = 20, readOnly, fill }, ref) {
  const under = useRef<HTMLPreElement>(null)
  const tokens = useMemo(() => tokenize(value, language), [value, language])

  return (
    <div className={cn('relative rounded-lg border border-slate-200 bg-slate-50 focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-transparent', fill && 'h-full')}>
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
        onSelect={e => onSelect?.(e.currentTarget.selectionStart, e.currentTarget.selectionEnd)}
        readOnly={readOnly}
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
        className={cn(LAYER, 'relative block w-full bg-transparent text-transparent caret-slate-800 selection:bg-blue-200/60 outline-hidden overflow-auto', fill ? 'h-full resize-none' : 'resize-y')}
      />
    </div>
  )
})

export default ScriptEditor
