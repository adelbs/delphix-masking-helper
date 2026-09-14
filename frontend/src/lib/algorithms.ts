import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
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
 * makes "save in the tester" show up in the sidebar without a page reload.
 */
let cache: Algorithm[] | null = null
let mountFetch: Promise<Algorithm[]> | null = null
const listeners = new Set<(rows: Algorithm[]) => void>()

function publish(rows: Algorithm[]) {
  cache = rows
  for (const notify of listeners) notify(rows)
}

/**
 * Fetches only when nothing has been loaded yet, and only once however many components ask
 * during the same render pass. This is the mount path.
 */
function ensureLoaded(): Promise<Algorithm[]> {
  if (cache) return Promise.resolve(cache)
  mountFetch ??= api.getAlgorithms()
    .then(rows => { publish(rows); return rows })
    .catch(() => [])
    .finally(() => { mountFetch = null })
  return mountFetch
}

/**
 * Re-reads the list and tells everyone. Call it after anything that writes — save, update,
 * delete, duplicate, import. Always hits the server: a caller that just wrote is precisely the
 * one that must not be served the copy taken before the write.
 */
export async function refreshAlgorithms(): Promise<Algorithm[]> {
  try {
    const rows = await api.getAlgorithms()
    publish(rows)
    return rows
  } catch {
    // A failed refresh leaves the last good list on screen rather than blanking the sidebar.
    return cache ?? []
  }
}

export function useAlgorithms(): {
  algorithms: Algorithm[]
  loading: boolean
  refresh: () => Promise<Algorithm[]>
} {
  const [algorithms, setAlgorithms] = useState<Algorithm[]>(() => cache ?? [])
  const [loading, setLoading] = useState(cache === null)

  useEffect(() => {
    let live = true
    listeners.add(setAlgorithms)
    ensureLoaded().then(() => { if (live) setLoading(false) })
    return () => { live = false; listeners.delete(setAlgorithms) }
  }, [])

  return { algorithms, loading, refresh: refreshAlgorithms }
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
