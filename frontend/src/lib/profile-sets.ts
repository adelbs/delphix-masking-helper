import { api } from '@/lib/api'
import { createListStore } from '@/lib/list-store'
import type { ProfileSet } from '@/types'

/**
 * The profile sets, cached and shared like the domains and classifiers: the sidebar lists them
 * while the editor writes to them, so one store with subscribers keeps the two in step.
 */
const store = createListStore<ProfileSet>('profileSets', () => api.getProfileSets())

/** Call after any write — including one that only changed the membership. */
export const refreshProfileSets = store.refresh

export function useProfileSets(): { profileSets: ProfileSet[]; loading: boolean } {
  const { rows, loading } = store.useList()
  return { profileSets: rows, loading }
}
