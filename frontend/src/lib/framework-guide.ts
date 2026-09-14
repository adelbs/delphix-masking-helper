import type { Locale } from '@/types'
import type { GuideEntry } from '../../vite-plugin-framework-guide'

export type { GuideEntry }
export type Guide = Record<string, GuideEntry>

/** One chunk per locale, so opening the Documentation tab pulls only the active language. */
const LOADERS: Record<Locale, () => Promise<{ default: Guide }>> = {
  'en': () => import('virtual:framework-guide/en'),
  'pt-BR': () => import('virtual:framework-guide/pt-BR'),
  'es': () => import('virtual:framework-guide/es'),
}

const cache = new Map<Locale, Promise<Guide>>()

export function loadGuide(locale: Locale): Promise<Guide> {
  let p = cache.get(locale)
  if (!p) {
    p = LOADERS[locale]().then(m => m.default).catch(() => ({} as Guide))
    cache.set(locale, p)
  }
  return p
}
