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
 * The name is looked for in two places, and it has to be both. Among the algorithms **saved
 * here** — and then among the plugin's **built-ins**, which is where most domains actually
 * point: a stock engine's domains name `dlpx-core:` instances constantly, and those are never
 * saved rows, because the import skips them on purpose (the plugin here already holds them).
 * Judging by the saved rows alone put nine domains in ten under `other`.
 *
 * What is left over is genuinely unknowable here: an algorithm that exists only on the engine,
 * or one of its COMPONENT algorithms, which have no framework at all. Those land in `other`,
 * which is a real bucket rather than an error.
 */
export function domainGroup(
  domain: Domain,
  algorithms: Algorithm[],
  builtinFrameworks: Record<string, string> = {},
): FrameworkGroup {
  const name = domain.default_algorithm
  const saved = algorithms.find(a => a.name === name)
  if (saved) return getFrameworkGroup(saved.framework)
  // Built-ins are listed under `dlpx-core:<name>`; a domain may spell the reference either way.
  const builtin = builtinFrameworks[name] ?? builtinFrameworks[`dlpx-core:${name}`]
  return builtin ? getFrameworkGroup(builtin) : 'other'
}
