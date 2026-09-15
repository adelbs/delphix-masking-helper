import { api } from '@/lib/api'
import { createListStore } from '@/lib/list-store'
import type { Algorithm } from '@/types'

/**
 * The saved algorithms, held once for the whole app.
 *
 * Four places need this list — the sidebar, the tester (for sub-algorithm references), the
 * config form's reference field, and the bulk actions. They used to fetch it independently,
 * which was tolerable while the list lived on its own screen: you arrived, it loaded, you left.
 *
 * With the list in the sidebar that stops working. The sidebar is on screen while the tester
 * saves, deletes and imports, so it has to hear about those. One cache with subscribers is what
 * makes "save in the tester" show up in the sidebar without a page reload. The cache and its
 * subscribers are in `list-store.ts`, shared with the other lists.
 */
const store = createListStore<Algorithm>('algorithms', () => api.getAlgorithms())

/**
 * Re-reads the list and tells everyone. Call it after anything that writes — save, update,
 * delete, duplicate, import.
 */
export const refreshAlgorithms = store.refresh

export function useAlgorithms(): {
  algorithms: Algorithm[]
  loading: boolean
  refresh: () => Promise<Algorithm[]>
} {
  const { rows, loading } = store.useList()
  return { algorithms: rows, loading, refresh: refreshAlgorithms }
}

/** Handles records saved before and after the double-serialisation fix. */
export function parseConfig(raw: string): Record<string, unknown> {
  try {
    const first = JSON.parse(raw)
    if (typeof first === 'string') return JSON.parse(first) as Record<string, unknown>
    return first as Record<string, unknown>
  } catch {
    return {}
  }
}
