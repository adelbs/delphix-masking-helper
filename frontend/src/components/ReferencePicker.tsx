import { Fragment, useEffect, useId, useRef, useState } from 'react'
import { AlertTriangle, Check, Loader2, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useT, type MessageKey } from '@/lib/i18n'
import type { ReferenceOption } from '@/lib/references'
import type { EngineReferences } from '@/types'

/** Beyond this many matches the list asks for more typing instead of rendering them all. */
const SHOWN = 80

/**
 * A searchable field for naming an algorithm or a domain.
 *
 * It lists what can be referenced — saved here, built into the plugin, held by the engine — and
 * still takes any typed name, because a reference can legitimately point at something none of
 * those sources knows about. What it adds is the check: below the field it says where the name
 * was found, or warns that it was found nowhere, before a typo surfaces as a failed test or send.
 */
export function ReferencePicker({
  kind, value, onChange, options, engineState, placeholder, maxLength, className, engineNotRunnable = false, misfit,
}: {
  kind: 'algorithm' | 'domain'
  value: string
  onChange: (value: string) => void
  options: ReferenceOption[]
  engineState: EngineReferences['state']
  placeholder?: string
  maxLength?: number
  /** Styling for the input, so the field matches the form around it. */
  className?: string
  /** An algorithm only the engine has cannot run in this tool's test — say so when it matters. */
  engineNotRunnable?: boolean
  /** Names that exist but do not fit this field, and what to say when one is typed. */
  misfit?: { options: ReferenceOption[]; message: MessageKey }
}) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const listId = useId()

  const typed = value.trim()
  const query = typed.toLowerCase()
  const matches = query ? options.filter(o => o.value.toLowerCase().includes(query)) : options
  const shown = matches.slice(0, SHOWN)
  const exact = typed ? options.find(o => o.value === typed) : undefined
  const misfitHit = Boolean(typed && !exact && misfit?.options.some(o => o.value === typed))
  const differentCase = typed && !exact && !misfitHit ? options.find(o => o.value.toLowerCase() === query) : undefined

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  const choose = (name: string) => {
    onChange(name)
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActive(i => Math.min(i + 1, Math.max(shown.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && open && shown[active]) {
      e.preventDefault()
      choose(shown[active].value)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  const foundText = (o: ReferenceOption) => {
    switch (o.source) {
      case 'saved': return t('reference.foundSaved', { detail: o.detail ?? '' })
      case 'plugin': return t('reference.foundPlugin')
      case 'local': return t('reference.foundLocal')
      default:
        if (kind === 'domain') return t('reference.foundEngineDomain')
        return t(engineNotRunnable ? 'reference.foundEngineNotRunnable' : 'reference.foundEngineAlgorithm')
    }
  }

  let status: React.ReactNode = null
  if (typed && exact) {
    status = (
      <p className={cn('mt-1 flex gap-1 text-xs', exact.source === 'engine' && engineNotRunnable ? 'text-amber-700' : 'text-emerald-700')}>
        <Check size={12} className="mt-0.5 flex-shrink-0" />{foundText(exact)}
      </p>
    )
  } else if (misfitHit && misfit) {
    status = (
      <p className="mt-1 flex gap-1.5 text-xs text-amber-700">
        <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
        <span>{t(misfit.message)}</span>
      </p>
    )
  } else if (differentCase) {
    status = (
      <p className="mt-1 text-xs text-amber-700">
        {t('reference.differentCase', { name: differentCase.value })}{' '}
        <button type="button" onClick={() => choose(differentCase.value)} className="font-medium underline">
          {t('reference.useSuggestion')}
        </button>
      </p>
    )
  } else if (typed && engineState === 'loading') {
    status = (
      <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-400">
        <Loader2 size={11} className="animate-spin" />{t('reference.checkingEngine')}
      </p>
    )
  } else if (typed) {
    const unchecked = engineState === 'not-configured' ? t('reference.engineNotConfigured')
      : engineState === 'unavailable' ? t('reference.engineUnavailable') : null
    status = (
      <p className="mt-1 flex gap-1.5 text-xs text-amber-700">
        <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
        <span>
          {t(kind === 'algorithm' ? 'reference.notFoundAlgorithm' : 'reference.notFoundDomain')}
          {unchecked && ` ${t('reference.engineNotChecked', { reason: unchecked })}`}
        </span>
      </p>
    )
  }

  return (
    <div ref={box} className="relative">
      <div className="relative">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
        <input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && shown[active] ? `${listId}-${active}` : undefined}
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          spellCheck={false}
          onChange={e => { onChange(e.target.value); setOpen(true); setActive(0) }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className={cn(className, 'pl-8')}
        />
      </div>

      {open && (
        <div id={listId} role="listbox"
             className="absolute z-30 mt-1 w-full max-h-72 overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
          {shown.length === 0 && (
            <p className="px-3 py-2 text-xs text-slate-500">{t('reference.noMatches')}</p>
          )}
          {shown.map((o, i) => (
            <Fragment key={`${o.source}:${o.value}`}>
              {(i === 0 || shown[i - 1].source !== o.source) && (
                <p className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  {t(`reference.group.${o.source}` as MessageKey)}
                </p>
              )}
              <button
                type="button"
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={e => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(o.value)}
                className={cn('flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm',
                  i === active ? 'bg-blue-50 text-blue-900' : 'text-slate-700')}
              >
                <span className="truncate">{o.value}</span>
                {o.detail && <span className="ml-auto flex-shrink-0 text-xs text-slate-400">{o.detail}</span>}
              </button>
            </Fragment>
          ))}
          {matches.length > SHOWN && (
            <p className="px-3 py-1.5 text-xs text-slate-400">{t('reference.more', { n: matches.length - SHOWN })}</p>
          )}
          {engineState === 'loading' && (
            <p className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-400">
              <Loader2 size={11} className="animate-spin" />{t('reference.checkingEngine')}
            </p>
          )}
        </div>
      )}

      {status}
    </div>
  )
}
