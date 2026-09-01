import { useEffect, useMemo, type ReactNode } from 'react'
import type { Locale } from '@/types'
import { buildI18n, I18nContext } from './index'

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo(() => buildI18n(locale), [locale])

  useEffect(() => { document.documentElement.lang = locale }, [locale])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
