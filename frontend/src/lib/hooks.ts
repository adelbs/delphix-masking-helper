import { api } from '@/lib/api'
import { createListStore } from '@/lib/list-store'
import type { Hook } from '@/types'

/** The hooks saved here, cached and shared like every other list the sidebar shows. */
const store = createListStore<Hook>('hooks', () => api.getHooks())

/** Call after any write. */
export const refreshHooks = store.refresh

export function useHooks(): { hooks: Hook[]; loading: boolean } {
  const { rows, loading } = store.useList()
  return { hooks: rows, loading }
}

/** The DCT the integration points at, from the settings alone — no call to DCT, so it is at once. */
export interface DctDefaults { url?: string; insecure?: boolean; hasKey?: boolean }

export async function dctFromSettings(): Promise<DctDefaults> {
  try {
    const c = (await api.getConfig()) as unknown as Record<string, unknown>
    const raw = String(c['delphix.baseUrl'] ?? '').trim()
    if (c['delphix.target'] !== 'dct' || !raw) return {}
    return {
      url: /^https?:\/\//i.test(raw) ? raw.replace(/\/+$/, '') : `https://${raw.replace(/\/+$/, '')}`,
      insecure: c['delphix.allowSelfSigned'] === true || c['delphix.allowSelfSigned'] === 'true',
      hasKey: Boolean(c['delphix.apiKey.set']),
    }
  } catch {
    return {}
  }
}
