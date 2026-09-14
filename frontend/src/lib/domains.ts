import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { getFrameworkGroup, type FrameworkGroup } from '@/lib/framework-metadata'
import type { Algorithm, Domain } from '@/types'

/**
 * The domains, shared the same way the algorithms are — the sidebar shows them while the
 * editor writes to them, so one cache with subscribers is what keeps the two in step.
 */
let cache: Domain[] | null = null
let mountFetch: Promise<Domain[]> | null = null
const listeners = new Set<(rows: Domain[]) => void>()

function publish(rows: Domain[]) {
  cache = rows
  for (const notify of listeners) notify(rows)
}

function ensureLoaded(): Promise<Domain[]> {
  if (cache) return Promise.resolve(cache)
  mountFetch ??= api.getDomains()
    .then(rows => { publish(rows); return rows })
    .catch(() => [])
    .finally(() => { mountFetch = null })
  return mountFetch
}

/** Call after any write. Always hits the server, for the same reason as the algorithm store. */
export async function refreshDomains(): Promise<Domain[]> {
  try {
    const rows = await api.getDomains()
    publish(rows)
    return rows
  } catch {
    return cache ?? []
  }
}

export function useDomains(): { domains: Domain[]; loading: boolean; refresh: () => Promise<Domain[]> } {
  const [domains, setDomains] = useState<Domain[]>(() => cache ?? [])
  const [loading, setLoading] = useState(cache === null)

  useEffect(() => {
    let live = true
    listeners.add(setDomains)
    ensureLoaded().then(() => { if (live) setLoading(false) })
    return () => { live = false; listeners.delete(setDomains) }
  }, [])

  return { domains, loading, refresh: refreshDomains }
}

/**
 * Which sidebar category a domain belongs to: the group of the framework behind the algorithm
 * it points at.
 *
 * Two hops, and either can miss. The domain names an algorithm by name — it may be a built-in
 * the engine has and this machine does not — and even when the algorithm is here, the engine's
 * own algorithms are not all framework-based: on a stock instance roughly a fifth of the
 * domains point at COMPONENT algorithms with no framework at all. Both misses land in `other`,
 * which is a real bucket rather than an error.
 */
export function domainGroup(domain: Domain, algorithms: Algorithm[]): FrameworkGroup {
  const algorithm = algorithms.find(a => a.name === domain.default_algorithm)
  return algorithm ? getFrameworkGroup(algorithm.framework) : 'other'
}
