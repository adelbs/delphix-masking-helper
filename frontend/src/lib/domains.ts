import { api } from '@/lib/api'
import { getFrameworkGroup, type FrameworkGroup } from '@/lib/framework-metadata'
import { createListStore } from '@/lib/list-store'
import type { Algorithm, Domain } from '@/types'

/**
 * The domains, shared the same way the algorithms are — the sidebar shows them while the
 * editor writes to them, so one cache with subscribers is what keeps the two in step.
 */
const store = createListStore<Domain>('domains', () => api.getDomains())

/** Call after any write. Always hits the server, for the same reason as the algorithm store. */
export const refreshDomains = store.refresh

export function useDomains(): { domains: Domain[]; loading: boolean; refresh: () => Promise<Domain[]> } {
  const { rows, loading } = store.useList()
  return { domains: rows, loading, refresh: refreshDomains }
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
