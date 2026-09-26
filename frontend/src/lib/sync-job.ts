import { useEffect, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { api, type SyncJobEvents } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { announceExport, announceImport, refreshAfterImport } from '@/lib/engine-sync'
import type {
  AlgorithmExportResult, ClassifierExportResult, DomainExportResult, EngineImportResult, ImportProgress, ProfileSetExportResult,
  SyncExportResult, SyncJobResult,
} from '@/lib/engine-sync'
import { refreshAlgorithms } from '@/lib/algorithms'
import { refreshClassifiers } from '@/lib/classifiers'
import { refreshDomains } from '@/lib/domains'
import { refreshProfileSets } from '@/lib/profile-sets'
import { forgetEngineReferences } from '@/lib/references'

type Translate = ReturnType<typeof useT>['t']

/** An import's progress, with the furthest the bar has been allowed to reach. */
export type ImportReached = ImportProgress & { percent: number }

/** Bringing everything down, sending everything up, or sending one object with all it needs. */
export type SyncJobKind = 'import' | 'export' | ObjectExportKind

/** The objects that are sent one at a time from their editor. */
export type ObjectExportKind = 'algorithm' | 'domain' | 'classifier' | 'profileSet'

/** The one object a job is about, when it is about one. */
export interface SyncJobTarget { id: number; name: string }

export interface SyncJob {
  kind: SyncJobKind
  target: SyncJobTarget | null
  /** Null until the server has said anything. */
  progress: ImportReached | null
}

/**
 * The sync job running now, held for the whole app rather than by the screen that started it.
 *
 * Refreshing from the engine or sending everything to it takes minutes, and the request carries
 * on when someone leaves Settings: the stream keeps being read, and the server keeps working. When
 * the bar lived in the component's state it went with the component, so coming back showed idle
 * buttons over a job that was still running — and a second click would start another one on top
 * of it. Out here the bar is where it was, and the buttons stay locked until the job ends.
 *
 * A reload loses even this, so the server holds the job too and the page asks for it on load
 * (`resumeSync`): the bar comes back where the server has got to.
 *
 * On `globalThis`, for the reason `list-store.ts` gives: hot reload must not split it in two.
 */
interface SyncState {
  job: SyncJob | null
  listeners: Set<() => void>
  /** The on-load check for a job the server is running, while it is in flight. */
  resuming: Promise<void> | null
}

const GLOBAL_KEY = '__dlpxSyncJob'
const state: SyncState = ((globalThis as unknown as Record<string, SyncState | undefined>)[GLOBAL_KEY] ??=
  { job: null, listeners: new Set(), resuming: null })

function publish(job: SyncJob | null) {
  state.job = job
  for (const notify of state.listeners) notify()
}

function subscribe(notify: () => void) {
  state.listeners.add(notify)
  return () => { state.listeners.delete(notify) }
}

/**
 * The total is not known when an import starts — each object drags down what it references, so
 * the work is discovered as it goes and the total grows. The percentage is therefore kept as the
 * furthest it has reached: without that the bar would slide backwards the moment a domain
 * brought three algorithms along. The counter the bar shows is the honest one, and it is right
 * there beside it.
 */
function advance(far: ImportReached | null, p: ImportProgress): ImportReached {
  const percent = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0
  return { ...p, percent: Math.max(far?.percent ?? 0, percent) }
}

/** The job running now, or null. Re-renders whoever reads it as the job moves. */
export function useSyncJob(): SyncJob | null {
  return useSyncExternalStore(subscribe, () => state.job)
}

/** What a finished bring-everything-down says. */
async function finishImport(t: Translate, out: EngineImportResult) {
  toast.success(t('settings.dlpxImported', { n: out.imported.length }))
  announceImport(t, out)
  await refreshAfterImport()
}

/** Says which profile set descriptions the engine could hold only the start of. */
function announceCut(t: Translate, names: string[] | undefined) {
  if (names?.length) toast.warning(t('sync.descriptionCut', { n: names.length, names: names.join(', ') }))
}

/** What a finished send-everything-up says. */
function finishExport(t: Translate, out: SyncExportResult) {
  const n = out.algorithms.length + out.domains.length + out.classifiers.length + out.profileSets.length
  toast.success(t('settings.dlpxSent', { n }))
  if (out.uploaded.length) toast.success(t('sync.uploadedFiles', { n: out.uploaded.length, files: out.uploaded.join(', ') }))
  if (out.skipped.length) {
    toast.warning(t('settings.dlpxSentSkipped', { n: out.skipped.length, names: out.skipped.map(s => s.name).join(', ') }))
  }
  announceCut(t, out.descriptionCut)
}

/** What a finished send of one algorithm says. */
async function finishAlgorithm(t: Translate, out: AlgorithmExportResult) {
  toast.success(t(out.mode === 'updated' ? 'saved.exportUpdated' : 'saved.exportCreated', { name: out.name }))
  if (out.renamed) toast.warning(t('saved.exportRenamed', { name: out.name }))
  announceExport(t, out)
  forgetEngineReferences()
  await refreshAlgorithms()
}

/** What a finished send of one domain says. */
async function finishDomain(t: Translate, out: DomainExportResult) {
  toast.success(t(out.mode === 'updated' ? 'domain.exportUpdated' : 'domain.exportCreated', { name: out.name }))
  // The algorithms had to go first — the engine refuses a domain whose reference it does not
  // know — so say which ones travelled rather than leaving it to be discovered.
  announceExport(t, out)
  forgetEngineReferences()
  await Promise.all([refreshDomains(), refreshAlgorithms()])
}

/** What a finished send of one classifier says. */
async function finishClassifier(t: Translate, out: ClassifierExportResult) {
  toast.success(t(out.mode === 'updated' ? 'classifier.exportUpdated' : 'classifier.exportCreated', { name: out.name }))
  // The domain had to go first — the engine will not keep a classifier whose domain it lacks.
  if (out.domain) toast.success(t('classifier.exportSentDomain', { name: out.domain.name }))
  announceExport(t, out)
  forgetEngineReferences()
  await Promise.all([refreshClassifiers(), refreshDomains(), refreshAlgorithms()])
}

/** What a finished send of one profile set says. */
async function finishProfileSet(t: Translate, out: ProfileSetExportResult) {
  toast.success(t(out.mode === 'updated' ? 'profileSet.exportUpdated' : 'profileSet.exportCreated', { name: out.name }))
  if (out.classifiers.length) toast.success(t('profileSet.exportSentClassifiers', { n: out.classifiers.length }))
  announceExport(t, out)
  announceCut(t, out.descriptionCut)
  forgetEngineReferences()
  await refreshProfileSets()
}

/** A failure worded in the user's language where the server gave it a code, as itself otherwise. */
function failureMessage(t: Translate, e: Error & { code?: string; domain?: string }, kind: SyncJobKind) {
  if (e.code === 'no-members') return t('profileSet.exportNoMembers')
  if (e.code === 'domain-missing') return t('classifier.exportDomainMissing', { name: e.domain ?? '' })
  if (e.code === 'not-configured') return t('saved.engineNotSet')
  if (e.code === 'invalid-config') return t('classifier.fixIssues')
  // The algorithm editor has always said which send failed; the engine's reason alone is terse.
  if (kind === 'algorithm') return t('saved.exportFailed', { error: e.message })
  return e.message
}

/**
 * Follows a sync to its end: the bar while it runs, the toasts and the sidebar refresh when it
 * ends. None of that needs the screen that asked, so it all still happens if the screen has gone.
 *
 * `kind` is known up front when the job is being started here; a job picked up from the server is
 * named by the stream's first event instead.
 */
async function track(
  t: Translate,
  open: (events: SyncJobEvents) => Promise<SyncJobResult | null>,
  known?: { kind: SyncJobKind; target: SyncJobTarget | null },
) {
  let kind = known?.kind ?? null
  let target = known?.target ?? null
  if (kind) publish({ kind, target, progress: null })
  try {
    const out = await open({
      onJob: (k, tg) => { if (!kind) { kind = k; target = tg; publish({ kind, target, progress: null }) } },
      onProgress: p => { if (kind) publish({ kind, target, progress: advance(state.job?.progress ?? null, p) }) },
    })
    if (!out || !kind) return
    if (kind === 'import') await finishImport(t, out as EngineImportResult)
    else if (kind === 'export') finishExport(t, out as SyncExportResult)
    else if (kind === 'algorithm') await finishAlgorithm(t, out as AlgorithmExportResult)
    else if (kind === 'domain') await finishDomain(t, out as DomainExportResult)
    else if (kind === 'classifier') await finishClassifier(t, out as ClassifierExportResult)
    else await finishProfileSet(t, out as ProfileSetExportResult)
  } catch (e) {
    // Asking whether a job is running and hearing nothing is not worth a toast; a job that failed is.
    // It stays until dismissed: a send that ran for minutes should not end in a message that slips by.
    if (kind) toast.error(failureMessage(t, e as Error, kind), { duration: Infinity })
  } finally {
    if (kind) publish(null)
  }
}

/** Starts bringing everything down, or sending everything up. The buttons are locked while one runs. */
export function startSync(kind: 'import' | 'export', t: Translate): Promise<void> {
  if (state.job) return Promise.resolve()
  return track(t, kind === 'import' ? api.delphixSyncImport : api.delphixSyncExport, { kind, target: null })
}

const OBJECT_EXPORT = {
  algorithm: api.delphixExport,
  domain: api.delphixExportDomain,
  classifier: api.delphixExportClassifier,
  profileSet: api.delphixExportProfileSet,
} satisfies Record<ObjectExportKind, (id: number, events: SyncJobEvents) => Promise<SyncJobResult | null>>

/** Sends one algorithm, domain, classifier or profile set, with everything it references. */
export function startObjectExport(kind: ObjectExportKind, target: SyncJobTarget, t: Translate): Promise<void> {
  if (state.job) return Promise.resolve()
  return track(t, events => OBJECT_EXPORT[kind](target.id, events), { kind, target })
}

/** Whether the job running now is sending this very object — what its editor's bar shows. */
export function isSending(job: SyncJob | null, kind: ObjectExportKind, id: number | undefined): job is SyncJob {
  return job?.kind === kind && job.target?.id === id
}

/**
 * Picks up a sync the server is still running — the page was reloaded in the middle of one. Held
 * as one promise, so the double mount of StrictMode does not follow it twice and toast twice.
 */
export function resumeSync(t: Translate): Promise<void> {
  if (state.job) return Promise.resolve()
  state.resuming ??= track(t, api.delphixSyncCurrent).finally(() => { state.resuming = null })
  return state.resuming
}

/** Asks the server once on load, from inside the i18n provider so the toasts speak the language. */
export function useResumeSync() {
  const { t } = useT()
  useEffect(() => { void resumeSync(t) }, []) // eslint-disable-line react-hooks/exhaustive-deps
}
