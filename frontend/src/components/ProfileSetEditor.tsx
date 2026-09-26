import { useState } from 'react'
import { PanelLeftOpen, Save, Trash2, CloudUpload, Loader2, Layers, Search } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { useClassifiers } from '@/lib/classifiers'
import { refreshProfileSets, useProfileSets } from '@/lib/profile-sets'
import { isSending, startObjectExport, useSyncJob } from '@/lib/sync-job'
import { ImportProgressBar } from '@/components/ImportProgressBar'
import type { Classifier, ProfileSet } from '@/types'

const cardCls = 'bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4'
const labelCls = 'block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5'
const helpCls = 'text-xs text-slate-400 mt-1'
/** How much of a set's description the engine keeps; the rest stays here and goes up shortened. */
const ENGINE_DESCRIPTION_MAX = 50
const fieldCls = 'w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'

/**
 * A profile set: which classifiers a profiling job runs, and how sure it has to be.
 *
 * The set itself decides nothing — a classifier scores, a domain's classifiers combine, and both
 * of those belong to the classifiers, where they are configured and tested. So this is a register
 * and nothing more: a name, a threshold, and the membership.
 */
export function ProfileSetEditor({ profileSet: opened, onToggleSidebar, onDeleted, onCreated }: {
  /** null while creating. */
  profileSet: ProfileSet | null
  onToggleSidebar: () => void
  onDeleted: () => void
  onCreated: (created: ProfileSet) => void
}) {
  const { t } = useT()
  const { classifiers } = useClassifiers()
  const { profileSets } = useProfileSets()

  // The live row: sending to the engine links it server-side, and the header should say so.
  const profileSet = opened ? (profileSets.find(s => s.id === opened.id) ?? opened) : null
  const editing = profileSet !== null

  const [name, setName] = useState(profileSet?.name ?? '')
  const [description, setDescription] = useState(profileSet?.description ?? '')
  const [threshold, setThreshold] = useState(profileSet?.assignment_threshold ?? 80)
  const [members, setMembers] = useState<Set<number>>(() => new Set(profileSet?.classifier_ids ?? []))
  const [busy, setBusy] = useState(false)
  // Sending runs as the app's sync job, so it outlives this screen; this set is sending if the
  // job is about it, and no other send may start while any job runs.
  const job = useSyncJob()
  const sending = isSending(job, 'profileSet', profileSet?.id)

  const toggleMember = (id: number) => setMembers(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const save = async () => {
    const trimmed = name.trim()
    if (!trimmed) { toast.error(t('profileSet.nameRequired')); return }
    if (!members.size) { toast.error(t('profileSet.membersRequired')); return }
    setBusy(true)
    try {
      const body = { name: trimmed, description, threshold, classifierIds: [...members] }
      if (editing) {
        await api.updateProfileSet(profileSet.id, body)
        toast.success(t('profileSet.saved'))
        await refreshProfileSets()
      } else {
        const created = await api.createProfileSet(body)
        toast.success(t('profileSet.created'))
        await refreshProfileSets()
        onCreated(created)
      }
    } catch (e) {
      const err = e as Error & { code?: string }
      toast.error(
        err.code === 'name-taken' ? t('profileSet.nameTaken')
        : err.code === 'threshold-invalid' ? t('profileSet.thresholdInvalid')
        : err.message)
    } finally { setBusy(false) }
  }

  const remove = async () => {
    if (!editing || !confirm(t('profileSet.confirmDelete'))) return
    try {
      await api.deleteProfileSet(profileSet.id)
      toast.success(t('profileSet.deleted'))
      await refreshProfileSets()
      onDeleted()
    } catch { toast.error(t('tester.unknownError')) }
  }

  const dirty = editing && (
    name.trim() !== profileSet.name
    || description !== profileSet.description
    || threshold !== profileSet.assignment_threshold
    || members.size !== profileSet.classifier_ids.length
    || profileSet.classifier_ids.some(id => !members.has(id))
  )

  /** The saved version is what travels, so an unsaved edit is refused rather than silently left behind. */
  const sendToEngine = async () => {
    if (!editing) return
    if (dirty) { toast.error(t('profileSet.saveFirst')); return }
    await startObjectExport('profileSet', { id: profileSet.id, name: profileSet.name }, t)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-200 bg-white flex-shrink-0">
        <button onClick={onToggleSidebar} className="text-slate-400 hover:text-slate-600 transition-colors">
          <PanelLeftOpen size={18} />
        </button>
        <Layers size={16} className="text-slate-500 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-slate-800 truncate">
            {editing ? profileSet.name : t('profileSet.newTitle')}
          </h2>
          <p className="text-xs text-slate-400 truncate">
            {t('profileSet.count', { n: members.size })}
            {' · '}
            {editing && profileSet.delphix_origin ? t('profileSet.fromEngine') : t('profileSet.local')}
          </p>
        </div>
        {editing && (
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button
              onClick={sendToEngine}
              disabled={job !== null}
              className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors disabled:opacity-50"
            >
              {sending ? <Loader2 size={12} className="animate-spin" /> : <CloudUpload size={12} />}
              <span className="hidden lg:inline">{t('saved.exportToEngine')}</span>
            </button>
            <button
              onClick={remove}
              title={t('saved.delete')}
              className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>
      {sending && job?.progress && (
        <div className="px-5 py-2.5 border-b border-slate-200 bg-white flex-shrink-0">
          <ImportProgressBar progress={job.progress} />
        </div>
      )}

      <div className="flex-1 overflow-auto p-5 bg-slate-50">
        <div className="max-w-2xl space-y-5">
          <div className={cardCls}>
            <div>
              <label className={labelCls}>{t('profileSet.name')}</label>
              <input
                autoFocus={!editing}
                type="text"
                maxLength={100}
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t('profileSet.namePlaceholder')}
                className={fieldCls}
              />
              <p className={helpCls}>{t('profileSet.nameHint')}</p>
            </div>

            <div>
              <label className={labelCls}>{t('profileSet.description')}</label>
              <input
                type="text"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder={t('profileSet.descriptionPlaceholder')}
                className={fieldCls}
              />
              {description.length > ENGINE_DESCRIPTION_MAX && (
                <p className={helpCls}>{t('profileSet.descriptionEngineLimit', { n: ENGINE_DESCRIPTION_MAX })}</p>
              )}
            </div>

            <div>
              <label className={labelCls}>{t('profileSet.threshold')}</label>
              <input
                type="number"
                min={1}
                max={100}
                value={threshold}
                onChange={e => setThreshold(Number(e.target.value))}
                className={cn(fieldCls, 'w-28')}
              />
              <p className={helpCls}>{t('profileSet.thresholdHint')}</p>
            </div>
          </div>

          <MemberPicker classifiers={classifiers} members={members} onToggle={toggleMember} onSet={setMembers} />

          <button
            onClick={save}
            disabled={busy || !name.trim() || !members.size || (editing && !dirty)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {editing ? t('tester.saveChanges') : t('profileSet.create')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Which classifiers the set holds. Three hundred of them on a stock engine, so it filters. */
function MemberPicker({ classifiers, members, onToggle, onSet }: {
  classifiers: Classifier[]
  members: Set<number>
  onToggle: (id: number) => void
  onSet: (next: Set<number>) => void
}) {
  const { t } = useT()
  const [query, setQuery] = useState('')

  const q = query.trim().toLowerCase()
  const shown = q
    ? classifiers.filter(c => c.name.toLowerCase().includes(q) || c.domain_name.toLowerCase().includes(q))
    : classifiers

  // "Select all" acts on what is on screen, not on everything: filtering to a domain and taking
  // the lot is the way a set gets built, and a button that quietly added the other three hundred
  // would be a trap.
  const addShown = () => onSet(new Set([...members, ...shown.map(c => c.id)]))

  return (
    <div className={cardCls}>
      <div>
        <h3 className="text-sm font-semibold text-slate-800">{t('profileSet.members')}</h3>
        <p className={helpCls}>{t('profileSet.membersHint')}</p>
      </div>

      {classifiers.length === 0 ? (
        <p className="text-sm text-slate-500">{t('profileSet.membersNone')}</p>
      ) : (
        <>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('profileSet.membersSearch')}
              className={cn(fieldCls, 'pl-7')}
            />
          </div>

          <div className="flex items-center gap-3 text-xs">
            <span className="font-medium text-slate-600">
              {t('profileSet.membersSelected', { n: members.size, total: classifiers.length })}
            </span>
            <button onClick={addShown} className="text-blue-600 hover:text-blue-800 font-medium">
              {t('profileSet.membersAll')}
            </button>
            <button onClick={() => onSet(new Set())} className="text-slate-400 hover:text-slate-600">
              {t('profileSet.membersClear')}
            </button>
          </div>

          <div className="max-h-96 overflow-auto rounded-lg border border-slate-200 divide-y divide-slate-100">
            {shown.length === 0 && (
              <p className="text-sm text-slate-400 px-3 py-3">{t('profileSet.membersNoMatch')}</p>
            )}
            {shown.map(c => (
              <label key={c.id} className="flex items-start gap-3 px-3 py-2 cursor-pointer hover:bg-slate-50">
                <input type="checkbox" className="mt-1" checked={members.has(c.id)} onChange={() => onToggle(c.id)} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-slate-800 truncate">{c.name}</span>
                  <span className="block text-xs text-slate-400 truncate">{c.domain_name} · {c.framework}</span>
                </span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
