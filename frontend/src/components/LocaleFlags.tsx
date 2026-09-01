import { cn } from '@/lib/utils'
import { useT, LOCALES, LOCALE_NAMES, detectLocale } from '@/lib/i18n'
import type { Locale, LocalePref } from '@/types'

/** Flags are drawn inline instead of using emoji: regional-indicator emoji do not
 *  render as flags on Windows, where they degrade to the letter pair ("BR", "ES"). */
function FlagBR() {
  return (
    <svg viewBox="0 0 60 42" className="w-full h-full">
      <rect width="60" height="42" fill="#009c3b" />
      <path d="M30 4 56 21 30 38 4 21Z" fill="#ffdf00" />
      <circle cx="30" cy="21" r="9" fill="#002776" />
    </svg>
  )
}

function FlagES() {
  return (
    <svg viewBox="0 0 60 42" className="w-full h-full">
      <rect width="60" height="42" fill="#c60b1e" />
      <rect y="10.5" width="60" height="21" fill="#ffc400" />
    </svg>
  )
}

/** Union Jack: reads better than the US flag at this size, where 13 stripes alias into mush. */
function FlagEN() {
  return (
    <svg viewBox="0 0 60 42" className="w-full h-full">
      <rect width="60" height="42" fill="#012169" />
      <path d="M0 0 60 42M60 0 0 42" stroke="#fff" strokeWidth="8" />
      <path d="M0 0 60 42M60 0 0 42" stroke="#c8102e" strokeWidth="4" />
      <path d="M30 0V42M0 21H60" stroke="#fff" strokeWidth="14" />
      <path d="M30 0V42M0 21H60" stroke="#c8102e" strokeWidth="8" />
    </svg>
  )
}

const FLAGS: Record<Locale, () => React.ReactElement> = {
  'en': FlagEN,
  'pt-BR': FlagBR,
  'es': FlagES,
}

interface Props {
  pref: LocalePref
  onChange: (pref: LocalePref) => void
}

/** Language switcher: three flags, applied on click. Under 'auto' the detected
 *  language is shown as active but marked, so "following the browser" stays visible. */
export function LocaleFlags({ pref, onChange }: Props) {
  const { t } = useT()
  const active = pref === 'auto' ? detectLocale() : pref

  return (
    <div className="flex items-center gap-1.5 px-3 pt-1">
      <span className="sr-only">{t('sidebar.language')}</span>
      {LOCALES.map((l) => {
        const Flag = FLAGS[l]
        const isActive = active === l
        return (
          <button
            key={l}
            onClick={() => onChange(l)}
            aria-label={LOCALE_NAMES[l]}
            aria-current={isActive}
            title={isActive && pref === 'auto'
              ? t('sidebar.languageAuto', { locale: LOCALE_NAMES[l] })
              : LOCALE_NAMES[l]}
            className={cn(
              'w-7 h-5 rounded-sm overflow-hidden transition-all',
              'focus:outline-none focus:ring-1 focus:ring-blue-500',
              isActive
                ? cn('ring-2 ring-offset-1 ring-offset-slate-900 opacity-100',
                     pref === 'auto' ? 'ring-slate-500' : 'ring-blue-500')
                : 'opacity-45 hover:opacity-80'
            )}
          >
            <Flag />
          </button>
        )
      })}
      {pref !== 'auto' && (
        <button
          onClick={() => onChange('auto')}
          title={t('sidebar.languageResetHint')}
          className="ml-auto text-[10px] uppercase tracking-wide text-slate-500 hover:text-slate-300 transition-colors"
        >
          {t('sidebar.languageReset')}
        </button>
      )}
    </div>
  )
}
