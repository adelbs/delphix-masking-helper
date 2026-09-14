import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { Algorithm, BuiltinReferences, Domain, EngineReferences } from '@/types'

/** Where a name offered by a reference field comes from. */
export type ReferenceSource = 'saved' | 'plugin' | 'engine' | 'local'

export interface ReferenceOption {
  value: string
  source: ReferenceSource
  /** A secondary label — the framework of a saved algorithm. */
  detail?: string
}

const NO_BUILTINS: BuiltinReferences = { algorithms: [], tokenization: [], tokenizationFrameworks: [] }

let builtins: Promise<BuiltinReferences> | null = null
let engine: Promise<EngineReferences> | null = null
let askEngineAgain = false

/** The plugin's built-in algorithms and which can tokenize; null until they arrive. Fetched once and shared. */
export function useBuiltinReferences(): BuiltinReferences | null {
  const [value, setValue] = useState<BuiltinReferences | null>(null)
  useEffect(() => {
    let live = true
    builtins ??= api.getBuiltinAlgorithms()
      .catch(() => { builtins = null; return NO_BUILTINS })
    builtins.then(v => { if (live) setValue(v) })
    return () => { live = false }
  }, [])
  return value
}

/** The plugin's built-in algorithm names; null until they arrive. */
export function useBuiltinAlgorithms(): string[] | null {
  return useBuiltinReferences()?.algorithms ?? null
}

const LOADING: EngineReferences = { state: 'loading', algorithms: [], tokenization: [], domains: [] }

/**
 * What the configured engine holds. Asked once per page and shared by every field — listing an
 * engine takes a while, and an unreachable one should cost a single wait, not one per field.
 */
export function useEngineReferences(): EngineReferences {
  const [value, setValue] = useState<EngineReferences>(LOADING)
  useEffect(() => {
    let live = true
    if (!engine) {
      engine = api.getEngineReferences(askEngineAgain)
        .catch((): EngineReferences => ({ state: 'unavailable', algorithms: [], tokenization: [], domains: [] }))
      askEngineAgain = false
    }
    engine.then(v => { if (live) setValue(v) })
    return () => { live = false }
  }, [])
  return value
}

/** Call after sending something to the engine, so the next field sees it there. */
export function forgetEngineReferences() {
  engine = null
  askEngineAgain = true
}

function collect(groups: Array<[ReferenceSource, Array<{ value: string; detail?: string }>]>): ReferenceOption[] {
  const seen = new Set<string>()
  const out: ReferenceOption[] = []
  for (const [source, items] of groups) {
    const sorted = [...items].sort((a, b) => a.value.localeCompare(b.value))
    for (const { value, detail } of sorted) {
      if (!value || seen.has(value)) continue
      seen.add(value)
      out.push({ value, source, detail })
    }
  }
  return out
}

/** Saved algorithms first, then the plugin's built-ins, then the engine's — each name once. */
export function algorithmOptions(saved: Algorithm[], builtinNames: string[] | null, engineNames: string[]): ReferenceOption[] {
  return collect([
    ['saved', saved.map(a => ({ value: a.name, detail: a.display_name }))],
    ['plugin', (builtinNames ?? []).map(value => ({ value }))],
    ['engine', engineNames.map(value => ({ value }))],
  ])
}

/**
 * What a domain's tokenization field may name: algorithms that tokenize and re-identify. The
 * engine flags its own; a saved algorithm is judged by its framework, a built-in by the plugin.
 */
export function tokenizationOptions(saved: Algorithm[], builtin: BuiltinReferences | null, engineNames: string[]): ReferenceOption[] {
  const frameworks = new Set(builtin?.tokenizationFrameworks ?? [])
  return collect([
    ['saved', saved.filter(a => frameworks.has(a.framework)).map(a => ({ value: a.name, detail: a.display_name }))],
    ['plugin', (builtin?.tokenization ?? []).map(value => ({ value }))],
    ['engine', engineNames.map(value => ({ value }))],
  ])
}

/** Domains on this machine first, then those only the engine has. */
export function domainOptions(local: Domain[], engineNames: string[]): ReferenceOption[] {
  return collect([
    ['local', local.map(d => ({ value: d.name }))],
    ['engine', engineNames.map(value => ({ value }))],
  ])
}
