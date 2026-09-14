import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { ProfileSet } from '@/types'

/**
 * The profile sets, cached and shared like the domains and classifiers: the sidebar lists them
 * while the editor writes to them, so one store with subscribers keeps the two in step.
 */
let cache: ProfileSet[] | null = null
let mountFetch: Promise<ProfileSet[]> | null = null
const listeners = new Set<(rows: ProfileSet[]) => void>()

function publish(rows: ProfileSet[]) {
  cache = rows
  for (const notify of listeners) notify(rows)
}

function ensureLoaded(): Promise<ProfileSet[]> {
  if (cache) return Promise.resolve(cache)
  mountFetch ??= api.getProfileSets()
    .then(rows => { publish(rows); return rows })
    .catch(() => [])
    .finally(() => { mountFetch = null })
  return mountFetch
}

/** Call after any write — including one that only changed the membership. */
export async function refreshProfileSets(): Promise<ProfileSet[]> {
  try {
    const rows = await api.getProfileSets()
    publish(rows)
    return rows
  } catch {
    return cache ?? []
  }
}

export function useProfileSets(): { profileSets: ProfileSet[]; loading: boolean } {
  const [profileSets, setProfileSets] = useState<ProfileSet[]>(() => cache ?? [])
  const [loading, setLoading] = useState(cache === null)

  useEffect(() => {
    let live = true
    listeners.add(setProfileSets)
    ensureLoaded().then(() => { if (live) setLoading(false) })
    return () => { live = false; listeners.delete(setProfileSets) }
  }, [])

  return { profileSets, loading }
}
