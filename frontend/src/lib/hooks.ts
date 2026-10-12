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
