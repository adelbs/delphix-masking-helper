import { createContext, createElement, useContext, Fragment, type ReactNode } from 'react'
import type { Locale, LocalePref } from '@/types'
import { en } from './messages/en'
import { ptBR } from './messages/pt-BR'
import { es } from './messages/es'

export type MessageKey = keyof typeof en
export type Messages = Record<MessageKey, string>

const CATALOGS: Record<Locale, Messages> = { 'en': en, 'pt-BR': ptBR, 'es': es }

export const LOCALES: Locale[] = ['en', 'pt-BR', 'es']
export const LOCALE_NAMES: Record<Locale, string> = {
  'en': 'English',
  'pt-BR': 'Português (BR)',
  'es': 'Español',
}

const STORAGE_KEY = 'dlpx.locale'

/** Picks the best supported locale from the browser's language preferences. */
export function detectLocale(): Locale {
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const raw of langs) {
    const lang = (raw ?? '').toLowerCase()
    if (lang.startsWith('pt')) return 'pt-BR'
    if (lang.startsWith('es')) return 'es'
    if (lang.startsWith('en')) return 'en'
  }
  return 'en'
}

export function resolveLocale(pref: LocalePref): Locale {
  return pref === 'auto' ? detectLocale() : pref
}

export function isLocalePref(v: unknown): v is LocalePref {
  return v === 'auto' || v === 'en' || v === 'pt-BR' || v === 'es'
}

/** Cached locally so the first paint never flashes the wrong language. */
export function readStoredPref(): LocalePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (isLocalePref(v)) return v
  } catch { /* storage unavailable */ }
  return 'auto'
}

export function storePref(pref: LocalePref) {
  try { localStorage.setItem(STORAGE_KEY, pref) } catch { /* storage unavailable */ }
}

type Vars = Record<string, string | number>

/** Substitutes {placeholders}. A message with a `|` picks singular/plural from `n`. */
function format(template: string, vars?: Vars): string {
  let out = template
  if (vars && vars.n !== undefined && out.includes('|')) {
    const [one, other] = out.split('|')
    out = Number(vars.n) === 1 ? one : other
  }
  if (!vars) return out
  return out.replace(/\{(\w+)\}/g, (match, k: string) => (k in vars ? String(vars[k]) : match))
}

export interface I18n {
  locale: Locale
  t: (key: MessageKey, vars?: Vars) => string
  /** Like t(), but substitutes React nodes for the {placeholders}. */
  tx: (key: MessageKey, nodes: Record<string, ReactNode>) => ReactNode
}

export function buildI18n(locale: Locale): I18n {
  const catalog = CATALOGS[locale] ?? en
  const t: I18n['t'] = (key, vars) => format(catalog[key] ?? en[key] ?? key, vars)
  const tx: I18n['tx'] = (key, nodes) =>
    (catalog[key] ?? en[key] ?? key).split(/(\{\w+\})/g).map((part, i) => {
      const m = /^\{(\w+)\}$/.exec(part)
      return m && m[1] in nodes ? createElement(Fragment, { key: i }, nodes[m[1]]) : part
    })
  return { locale, t, tx }
}

export const I18nContext = createContext<I18n | null>(null)

export function useT(): I18n {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useT must be used inside <I18nProvider>')
  return ctx
}
