import { useEffect, useState } from 'react'

/**
 * A list read from the server and held once for the whole app, with subscribers — the shape the
 * algorithm, domain, classifier and profile set stores share.
 *
 * **The state lives on `globalThis`, not in the module, and that is the point.** Vite's hot reload
 * runs a changed module again, and every module importing it. A cache and listener set declared
 * at module level then split in two: the sidebar stayed subscribed to the old copy while the
 * screen that had just written refreshed the new one, so a preset load or an editor save showed
 * nothing in the sidebar until the page was reloaded. Keyed on the global, every copy of the
 * module — old or new — reads and notifies the same list. In a production build there is only
 * ever one copy, and this costs nothing.
 */
interface ListState<T> {
  cache: T[] | null
  /** The first fetch, shared by every component that mounts during the same render pass. */
  mountFetch: Promise<T[]> | null
  listeners: Set<(rows: T[]) => void>
}

const GLOBAL_KEY = '__dlpxListStores'

function stateFor<T>(key: string): ListState<T> {
  const holder = globalThis as unknown as Record<string, Record<string, ListState<unknown>> | undefined>
  const stores = (holder[GLOBAL_KEY] ??= {})
  stores[key] ??= { cache: null, mountFetch: null, listeners: new Set() }
  return stores[key] as ListState<T>
}

export function createListStore<T>(key: string, fetchRows: () => Promise<T[]>) {
  const state = stateFor<T>(key)

  const publish = (rows: T[]) => {
    state.cache = rows
    for (const notify of state.listeners) notify(rows)
  }

  /** Fetches only when nothing has been loaded yet, and only once per render pass. The mount path. */
  const ensureLoaded = (): Promise<T[]> => {
    if (state.cache) return Promise.resolve(state.cache)
    state.mountFetch ??= fetchRows()
      .then(rows => { publish(rows); return rows })
      .catch(() => [] as T[])
      .finally(() => { state.mountFetch = null })
    return state.mountFetch
  }

  /**
   * Re-reads the list and tells everyone. Call it after anything that writes. Always hits the
   * server: a caller that just wrote is precisely the one that must not get the copy from before.
   */
  const refresh = async (): Promise<T[]> => {
    try {
      const rows = await fetchRows()
      publish(rows)
      return rows
    } catch {
      // A failed refresh leaves the last good list on screen rather than blanking the sidebar.
      return state.cache ?? []
    }
  }

  const useList = (): { rows: T[]; loading: boolean } => {
    const [rows, setRows] = useState<T[]>(() => state.cache ?? [])
    const [loading, setLoading] = useState(state.cache === null)

    useEffect(() => {
      let live = true
      state.listeners.add(setRows)
      ensureLoaded().then(() => { if (live) setLoading(false) })
      return () => { live = false; state.listeners.delete(setRows) }
    }, [])

    return { rows, loading }
  }

  return { refresh, useList }
}
