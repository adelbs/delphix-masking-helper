import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useT, type MessageKey } from '@/lib/i18n'
import type {
  Classifier, ClassifierCatalog, ClassifierField, ClassifierFrameworkName, ClassifierIssue,
} from '@/types'

/**
 * The classifiers, shared the same way the domains are — the sidebar lists them while the
 * editor writes to them, so one cache with subscribers keeps the two in step.
 */
let cache: Classifier[] | null = null
let mountFetch: Promise<Classifier[]> | null = null
const listeners = new Set<(rows: Classifier[]) => void>()

function publish(rows: Classifier[]) {
  cache = rows
  for (const notify of listeners) notify(rows)
}

function ensureLoaded(): Promise<Classifier[]> {
  if (cache) return Promise.resolve(cache)
  mountFetch ??= api.getClassifiers()
    .then(rows => { publish(rows); return rows })
    .catch(() => [])
    .finally(() => { mountFetch = null })
  return mountFetch
}

/** Call after any write. Always hits the server, for the same reason as the algorithm store. */
export async function refreshClassifiers(): Promise<Classifier[]> {
  try {
    const rows = await api.getClassifiers()
    publish(rows)
    return rows
  } catch {
    return cache ?? []
  }
}

export function useClassifiers(): { classifiers: Classifier[]; loading: boolean; refresh: () => Promise<Classifier[]> } {
  const [classifiers, setClassifiers] = useState<Classifier[]>(() => cache ?? [])
  const [loading, setLoading] = useState(cache === null)

  useEffect(() => {
    let live = true
    listeners.add(setClassifiers)
    ensureLoaded().then(() => { if (live) setLoading(false) })
    return () => { live = false; listeners.delete(setClassifiers) }
  }, [])

  return { classifiers, loading, refresh: refreshClassifiers }
}

/** The frameworks' settings and the SQL types. Static for the life of the server. */
let catalog: Promise<ClassifierCatalog> | null = null

/**
 * The catalog, or why it could not be read. The error matters: without the catalog the form
 * and the SQL type list stay empty, and a server older than the frontend (one left running from
 * before an update) looks exactly like that.
 */
export function useClassifierCatalog(): { catalog: ClassifierCatalog | null; error: string | null } {
  const [value, setValue] = useState<ClassifierCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    catalog ??= api.getClassifierCatalog().catch((err) => { catalog = null; throw err })
    catalog
      .then(c => { if (live) setValue(c) })
      .catch((err: Error) => { if (live) setError(err.message) })
    return () => { live = false }
  }, [])
  return { catalog: value, error }
}

/** A fresh entry for a framework's list: fallbacks filled in, required text left empty. */
export function blankEntry(fields: ClassifierField[]): Record<string, unknown> {
  const entry: Record<string, unknown> = {}
  for (const field of fields) {
    if (field.fallback !== undefined) entry[field.key] = field.fallback
    else if (field.kind === 'choice' && field.options?.length) entry[field.key] = field.options[0]
    else if (field.required) entry[field.key] = ''
  }
  return entry
}

/** What a new classifier starts from: one blank entry and every setting at its fallback. */
export function defaultConfig(catalog: ClassifierCatalog, framework: ClassifierFrameworkName): Record<string, unknown> {
  const spec = catalog.frameworks[framework]
  if (!spec) return {}
  return { [spec.list.key]: [blankEntry(spec.list.fields)], ...blankEntry(spec.settings) }
}

/** The whole percentage shown for a confidence, rounding halves up. */
export function percentOf(confidence: number): number {
  return Math.floor(Math.fround(Math.fround(confidence * 100) + 0.5))
}

const camel = (code: string) => code.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

/**
 * Turns an issue into a sentence in the user's language, prefixed with where it sits —
 * "Patterns #2 · Regular expression — …". Falls back to the server's English message for a code
 * the catalogs do not know.
 */
export function useIssueText(): (framework: ClassifierFrameworkName | null, issue: ClassifierIssue) => string {
  const { t } = useT()
  return (framework, issue) => {
    const key = `classifier.issue.${camel(issue.code)}`
    const translated = t(key as MessageKey, issue.params)
    const body = translated === key ? issue.message : translated
    const place: string[] = []
    const { list, index, field } = issue.where
    if (list) place.push(`${t(`classifier.group.${list}` as MessageKey)}${index != null ? ` #${index + 1}` : ''}`)
    if (field && framework) place.push(t(`classifier.p.${framework}.${field}` as MessageKey))
    return place.length ? `${place.join(' · ')} — ${body}` : body
  }
}
