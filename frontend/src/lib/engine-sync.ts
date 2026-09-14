import { toast } from 'sonner'
import { refreshAlgorithms } from '@/lib/algorithms'
import { refreshDomains } from '@/lib/domains'
import { refreshClassifiers } from '@/lib/classifiers'
import { refreshProfileSets } from '@/lib/profile-sets'
import type { useT } from '@/lib/i18n'

type Translate = ReturnType<typeof useT>['t']

/** Something an import did not bring, and why. */
export interface EngineSkipped {
  kind?: 'algorithm' | 'domain' | 'classifier'
  name: string
  reason: 'not-found' | 'unsupported-framework' | 'name-taken' | string
  framework?: string
}

/** Every import answers the same way: what was picked, and what it brought or could not. */
export interface EngineImportResult {
  imported: string[]
  /** Brought along because something imported references them. */
  related: { domains: string[]; algorithms: string[]; classifiers: string[] }
  skipped: EngineSkipped[]
  /** Files written into the files folder. */
  downloaded: string[]
  /** Files still to be copied by hand — the engine offers no download for them. */
  needsFiles: Array<{ name: string; files: string[] }>
}

/**
 * Where an import has got to. The total is what is finished plus what is still queued, so it
 * grows as the import discovers what the picked objects reference — see `importFromEngine`.
 */
export interface ImportProgress {
  kind: 'reading' | 'profileSet' | 'classifier' | 'domain' | 'algorithm'
  /** The item being taken up; null while the engine is still being listed. */
  name: string | null
  done: number
  total: number
}

/** What sending everything up did, kind by kind. */
export interface SyncExportResult {
  engine: string
  algorithms: string[]
  domains: string[]
  classifiers: string[]
  profileSets: string[]
  /** Left behind, and why — a configuration the engine would refuse, a set with no members. */
  skipped: Array<{ kind: string; name: string; reason: string }>
  uploaded: string[]
  /** References left as they are: the engine's own plugin instances, or names only it holds. */
  references: Array<{ name: string; reason: string }>
}

/** What a push sent ahead of the object itself. */
export interface EngineExportResult {
  sent: Array<{ name: string; mode: 'created' | 'updated' }>
  /** References left as they are: the engine's own plugin instances, or names only it holds. */
  skipped: Array<{ name: string; reason: 'engine-owned' | 'not-local' }>
  uploaded: string[]
}

const listed = (names: string[]) => ({ n: names.length, names: names.join(', ') })

/** Tells what came along with an import, and what could not come. */
export function announceImport(t: Translate, out: EngineImportResult) {
  if (out.related.classifiers.length) toast.success(t('sync.importedClassifiers', listed(out.related.classifiers)))
  if (out.related.domains.length) toast.success(t('sync.importedDomains', listed(out.related.domains)))
  if (out.related.algorithms.length) toast.success(t('sync.importedAlgorithms', listed(out.related.algorithms)))
  if (out.downloaded.length) {
    toast.success(t('sync.downloadedFiles', { n: out.downloaded.length, files: out.downloaded.join(', ') }))
  }
  const skipped = (reason: string) => out.skipped.filter(s => s.reason === reason).map(s => s.name)
  const unsupported = skipped('unsupported-framework')
  if (unsupported.length) toast.warning(t('sync.skippedUnsupported', listed(unsupported)))
  const missing = skipped('not-found')
  if (missing.length) toast.warning(t('sync.skippedMissing', listed(missing)))
  const taken = skipped('name-taken')
  if (taken.length) toast.warning(t('sync.skippedNameTaken', listed(taken)))
  if (out.needsFiles.length) {
    const files = [...new Set(out.needsFiles.flatMap(f => f.files))]
    toast.warning(t('sync.needsFiles', { n: out.needsFiles.length, files: files.join(', ') }))
  }
}

/**
 * Re-reads every list an import can have touched.
 *
 * Since nothing travels alone — a profile set brings its classifiers, a classifier its domain, a
 * domain its algorithms — an import that was asked for one kind of thing routinely writes three
 * others. Refreshing only the kind that was picked left the sidebar showing stale counts until
 * the page was reloaded, which is not something anyone should have to know to do.
 *
 * The four reads are cheap and go out together; getting this right matters more than saving one
 * of them, because the one that is skipped is invisible until someone is confused by it.
 */
export function refreshAfterImport() {
  return Promise.all([refreshProfileSets(), refreshClassifiers(), refreshDomains(), refreshAlgorithms()])
}

/** Tells what went to the engine ahead of the object that references it. */
export function announceExport(t: Translate, out: EngineExportResult) {
  if (out.sent.length) toast.success(t('sync.sentAlgorithms', listed(out.sent.map(a => a.name))))
  if (out.uploaded.length) {
    toast.success(t('sync.uploadedFiles', { n: out.uploaded.length, files: out.uploaded.join(', ') }))
  }
}
