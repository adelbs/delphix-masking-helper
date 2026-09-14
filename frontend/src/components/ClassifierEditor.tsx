import { useEffect, useState } from 'react'
import {
  PanelLeftOpen, Save, Trash2, CloudUpload, Loader2, Radar, Plus, X, Play, AlertTriangle,
} from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useT, type MessageKey } from '@/lib/i18n'
import {
  blankEntry, defaultConfig, percentOf, refreshClassifiers, useClassifierCatalog, useClassifiers, useIssueText,
} from '@/lib/classifiers'
import { refreshDomains, useDomains } from '@/lib/domains'
import { refreshAlgorithms } from '@/lib/algorithms'
import { domainOptions, forgetEngineReferences, useEngineReferences } from '@/lib/references'
import { announceExport } from '@/lib/engine-sync'
import { FilePickerField } from '@/components/ConfigForm'
import { ReferencePicker } from '@/components/ReferencePicker'
import type {
  Classifier, ClassifierCatalog, ClassifierDomainScore, ClassifierField, ClassifierFrameworkName,
  ClassifierFrameworkSpec, ClassifierReport, ClassifierReview, ClassifierTestResult, ClassifierValueRow,
} from '@/types'

const FRAMEWORKS: ClassifierFrameworkName[] = ['PATH', 'TYPE', 'REGEX', 'LIST']
const FAMILY_ORDER = ['text', 'number', 'date', 'timestamp', 'binary', 'boolean', 'other']
const UNBOUNDED = 2147483647
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
type Row = Record<string, unknown>

/** Message keys built from engine names (frameworks, settings, option values). */
const k = (key: string) => key as MessageKey
const camel = (code: string) => code.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

/**
 * A classifier: its framework's settings on the left, a test bench on the right.
 *
 * The form is generated from the framework catalog the server serves, with an explanation for
 * every setting, and reviewed as you type — what Delphix would refuse, what cannot be tested
 * here, what is probably a slip. The test sends the configuration as it stands, saved or not.
 */
export function ClassifierEditor({ classifier: opened, onToggleSidebar, onDeleted, onCreated }: {
  /** null while creating. */
  classifier: Classifier | null
  onToggleSidebar: () => void
  onDeleted: () => void
  onCreated: (created: Classifier) => void
}) {
  const { t } = useT()
  const { catalog, error: catalogError } = useClassifierCatalog()
  const { classifiers } = useClassifiers()
  const { domains } = useDomains()
  const engineRefs = useEngineReferences()

  // The live row: sending to the engine links it server-side, and the header should say so.
  const classifier = opened ? (classifiers.find(c => c.id === opened.id) ?? opened) : null
  const editing = classifier !== null

  const [name, setName] = useState(classifier?.name ?? '')
  const [domain, setDomain] = useState(classifier?.domain_name ?? '')
  const [description, setDescription] = useState(classifier?.description ?? '')
  const [framework, setFramework] = useState<ClassifierFrameworkName>(classifier?.framework ?? 'PATH')
  // null until edited: a new classifier starts from the framework fallbacks once the catalog is in.
  const [config, setConfig] = useState<Row | null>(classifier?.config ?? null)
  const [busy, setBusy] = useState(false)
  const [sending, setSending] = useState(false)

  const effective = config ?? (catalog ? defaultConfig(catalog, framework) : null)
  const spec = catalog?.frameworks[framework]

  // Reviewed a moment after typing stops. The key ties a review to the configuration it read,
  // so a late answer for an older version is never shown against a newer one.
  const configText = effective ? JSON.stringify(effective) : ''
  const reviewKey = `${framework}|${configText}`
  const [review, setReview] = useState<{ key: string; result: ClassifierReview } | null>(null)
  useEffect(() => {
    if (!configText) return
    const key = `${framework}|${configText}`
    const timer = setTimeout(() => {
      api.reviewClassifier(framework, JSON.parse(configText) as Row)
        .then(result => setReview({ key, result }))
        .catch(() => {})
    }, 300)
    return () => clearTimeout(timer)
  }, [framework, configText])
  const currentReview = review?.key === reviewKey ? review.result : null
  const refused = (currentReview?.errors.length ?? 0) > 0

  const changeFramework = (fw: ClassifierFrameworkName) => {
    setFramework(fw)
    setConfig(catalog ? defaultConfig(catalog, fw) : null)
  }

  const dirty = editing && (
    name.trim() !== classifier.name
    || domain.trim() !== classifier.domain_name
    || description !== classifier.description
    || configText !== JSON.stringify(classifier.config))

  const failureText = (e: unknown) => {
    const err = e as Error & { code?: string }
    switch (err.code) {
      case 'name-taken': return t('classifier.nameTaken')
      case 'name-required': return t('classifier.nameRequired')
      case 'name-too-long': return t('classifier.nameTooLong')
      case 'domain-required': return t('classifier.domainRequired')
      case 'invalid-config': return t('classifier.fixIssues')
      case 'not-configured': return t('saved.engineNotSet')
      default: return err.message
    }
  }

  const save = async () => {
    if (!effective) return
    setBusy(true)
    try {
      if (editing) {
        await api.updateClassifier(classifier.id, { name: name.trim(), domain: domain.trim(), description, config: effective })
        toast.success(t('classifier.saved'))
        await refreshClassifiers()
      } else {
        const created = await api.createClassifier({
          name: name.trim(), framework, domain: domain.trim(), description, config: effective,
        })
        toast.success(t('classifier.created'))
        await refreshClassifiers()
        onCreated(created)
      }
    } catch (e) {
      toast.error(failureText(e))
    } finally { setBusy(false) }
  }

  const sendToEngine = async () => {
    if (!editing) return
    if (dirty) { toast.warning(t('classifier.saveFirst')); return }
    setSending(true)
    try {
      const out = await api.delphixExportClassifier(classifier.id)
      toast.success(t(out.mode === 'updated' ? 'classifier.exportUpdated' : 'classifier.exportCreated', { name: out.name }))
      // The domain had to go first — the engine will not keep a classifier whose domain it lacks.
      if (out.domain) toast.success(t('classifier.exportSentDomain', { name: out.domain.name }))
      announceExport(t, out)
      forgetEngineReferences()
      await Promise.all([refreshClassifiers(), refreshDomains(), refreshAlgorithms()])
    } catch (e) {
      const err = e as Error & { code?: string }
      toast.error(err.code === 'domain-missing'
        ? t('classifier.exportDomainMissing', { name: classifier.domain_name })
        : failureText(e))
    } finally { setSending(false) }
  }

  const remove = async () => {
    if (!editing) return
    if (!confirm(t('classifier.confirmDelete'))) return
    try {
      await api.deleteClassifier(classifier.id)
      toast.success(t('classifier.deleted'))
      await refreshClassifiers()
      onDeleted()
    } catch { toast.error(t('tester.unknownError')) }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-200 bg-white flex-shrink-0">
        <button onClick={onToggleSidebar} className="text-slate-400 hover:text-slate-600 transition-colors">
          <PanelLeftOpen size={18} />
        </button>
        <Radar size={16} className="text-slate-500 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-slate-800 truncate">
            {editing ? classifier.name : t('classifier.newTitle')}
          </h2>
          <p className="text-xs text-slate-400 truncate">
            {t(k(`classifier.fw.${framework}`))}
            {' · '}
            {editing && classifier.delphix_origin ? t('classifier.fromEngine') : t('classifier.local')}
          </p>
        </div>
        {editing && (
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button
              onClick={sendToEngine}
              disabled={sending}
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

      <div className="flex-1 overflow-auto p-5 bg-slate-50">
        <div className="grid gap-5 xl:grid-cols-2 items-start">
          <div className="space-y-5 min-w-0">
            <div className={cardCls}>
              <div>
                <label className={labelCls}>{t('classifier.name')}</label>
                <input
                  autoFocus={!editing}
                  type="text"
                  maxLength={100}
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder={t('classifier.namePlaceholder')}
                  className={fieldCls}
                />
                <p className={helpCls}>{t('classifier.nameHint')}</p>
              </div>

              <div>
                <label className={labelCls}>{t('classifier.domain')}</label>
                <ReferencePicker
                  kind="domain"
                  value={domain}
                  onChange={setDomain}
                  options={domainOptions(domains, engineRefs.domains)}
                  engineState={engineRefs.state}
                  maxLength={100}
                  placeholder={t('classifier.domainPlaceholder')}
                  className={fieldCls}
                />
                <p className={helpCls}>{t('classifier.domainHint')}</p>
              </div>

              <div>
                <label className={labelCls}>{t('classifier.description')}</label>
                <input
                  type="text"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder={t('classifier.descriptionPlaceholder')}
                  className={fieldCls}
                />
              </div>

              <div>
                <label className={labelCls}>{t('classifier.framework')}</label>
                {editing ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                    <FrameworkSummary framework={framework} />
                    <p className={helpCls}>{t('classifier.frameworkFixed')}</p>
                  </div>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {FRAMEWORKS.map(fw => (
                      <button
                        key={fw}
                        type="button"
                        onClick={() => changeFramework(fw)}
                        className={cn(
                          'text-left rounded-lg border px-3 py-2 transition-colors',
                          fw === framework ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500' : 'border-slate-200 bg-white hover:border-slate-300'
                        )}
                      >
                        <FrameworkSummary framework={fw} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {catalogError ? (
              <p className="flex gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3 break-words">
                <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
                {t('classifier.catalogFailed', { error: catalogError })}
              </p>
            ) : !spec || !effective ? (
              <p className="text-sm text-slate-400 flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" />{t('classifier.loadingCatalog')}
              </p>
            ) : (
              <SettingsForm spec={spec} framework={framework} config={effective} onChange={setConfig} />
            )}

            {currentReview && <ReviewPanel framework={framework} review={currentReview} />}

            <button
              onClick={save}
              disabled={busy || !effective || refused || !name.trim() || !domain.trim() || (editing && !dirty)}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {editing ? t('tester.saveChanges') : t('classifier.create')}
            </button>
          </div>

          <TestPanel
            catalog={catalog}
            classifier={effective ? {
              id: classifier?.id,
              name: name.trim() || classifier?.name || '',
              framework,
              domain: domain.trim(),
              config: effective,
            } : null}
          />
        </div>
      </div>
    </div>
  )
}

function FrameworkSummary({ framework }: { framework: ClassifierFrameworkName }) {
  const { t } = useT()
  const target = framework === 'PATH' || framework === 'TYPE' ? 'metadata' : 'data'
  return (
    <span className="block">
      <span className="flex items-center gap-2">
        <span className="text-sm font-semibold text-slate-800">{t(k(`classifier.fw.${framework}`))}</span>
        <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded',
          target === 'metadata' ? 'bg-violet-100 text-violet-700' : 'bg-emerald-100 text-emerald-700')}>
          {t(k(`classifier.target.${target}`))}
        </span>
      </span>
      <span className="block text-xs text-slate-500 mt-0.5">{t(k(`classifier.fw.${framework}.desc`))}</span>
    </span>
  )
}

// ── Review ────────────────────────────────────────────────────────────────────

function ReviewPanel({ framework, review }: { framework: ClassifierFrameworkName; review: ClassifierReview }) {
  const { t } = useT()
  const issueText = useIssueText()
  const groups = [
    { key: 'errors', items: review.errors, cls: 'border-red-200 bg-red-50 text-red-800', title: t('classifier.issues.errors') },
    { key: 'limitations', items: review.limitations, cls: 'border-amber-200 bg-amber-50 text-amber-800', title: t('classifier.issues.limitations') },
    { key: 'hints', items: review.hints, cls: 'border-slate-200 bg-white text-slate-600', title: t('classifier.issues.hints') },
  ].filter(g => g.items.length)
  if (!groups.length) return null
  return (
    <div className="space-y-3">
      {groups.map(g => (
        <div key={g.key} className={cn('rounded-xl border p-4', g.cls)}>
          <p className="text-xs font-semibold uppercase tracking-wide mb-1.5">{g.title}</p>
          <ul className="text-sm space-y-1 list-disc pl-4">
            {g.items.map((item, i) => <li key={i} className="break-words">{issueText(framework, item)}</li>)}
          </ul>
        </div>
      ))}
    </div>
  )
}

// ── Settings ──────────────────────────────────────────────────────────────────

function SettingsForm({ spec, framework, config, onChange }: {
  spec: ClassifierFrameworkSpec
  framework: ClassifierFrameworkName
  config: Row
  onChange: (config: Row) => void
}) {
  const { t } = useT()
  const general = spec.settings.filter(f => applies(framework, f, config, config))
  return (
    <>
      <EntryList listKey={spec.list.key} fields={spec.list.fields} framework={framework} config={config} onChange={onChange} />
      {general.length > 0 && (
        <div className={cardCls}>
          <h3 className="text-sm font-semibold text-slate-800">{t('classifier.group.general')}</h3>
          {general.map(f => (
            <FieldInput key={f.key} framework={framework} field={f} value={config[f.key]}
                        onChange={v => onChange({ ...config, [f.key]: v })} />
          ))}
        </div>
      )}
    </>
  )
}

/** Settings that do not apply to the current choice are hidden, and reset when they stop applying. */
function applies(framework: ClassifierFrameworkName, field: ClassifierField, entry: Row, config: Row): boolean {
  if (framework === 'TYPE') {
    if (field.key === 'sqlType') return entry.typeName === 'JavaSqlType'
    if (field.key === 'minimumLength' || field.key === 'maximumLength') return entry.typeName !== 'Date'
  }
  if (framework === 'LIST' && field.key === 'tokenizationDelimiter') return config.tokenizeInput === true
  return true
}

function EntryList({ listKey, fields, framework, config, onChange }: {
  listKey: string
  fields: ClassifierField[]
  framework: ClassifierFrameworkName
  config: Row
  onChange: (config: Row) => void
}) {
  const { t } = useT()
  const entries = Array.isArray(config[listKey]) ? (config[listKey] as Row[]) : []
  const setEntries = (next: Row[]) => onChange({ ...config, [listKey]: next })

  const updateEntry = (i: number, key: string, value: unknown) => {
    setEntries(entries.map((e, j) => {
      if (j !== i) return e
      const entry = { ...e, [key]: value }
      // Delphix refuses lengths on Date and an SQL code on anything but JavaSqlType.
      if (framework === 'TYPE' && key === 'typeName') {
        if (value === 'Date') { entry.minimumLength = 0; entry.maximumLength = 0 }
        if (value !== 'JavaSqlType') entry.sqlType = 0
      }
      return entry
    }))
  }

  return (
    <div className={cardCls}>
      <div>
        <h3 className="text-sm font-semibold text-slate-800">{t(k(`classifier.group.${listKey}`))}</h3>
        <p className={helpCls}>{t(k(`classifier.group.${listKey}.hint`))}</p>
      </div>
      {entries.map((entry, i) => (
        <div key={i} className="rounded-lg border border-slate-200 p-3 space-y-3">
          <div className="flex items-center">
            <span className="text-xs font-semibold text-slate-400 flex-1">{t('classifier.rowN', { n: i + 1 })}</span>
            <button
              type="button"
              onClick={() => setEntries(entries.filter((_, j) => j !== i))}
              disabled={entries.length <= 1}
              title={t('classifier.removeRow')}
              className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-400"
            >
              <X size={14} />
            </button>
          </div>
          {fields.filter(f => applies(framework, f, entry, config)).map(f => (
            <FieldInput key={f.key} framework={framework} field={f} value={entry[f.key]}
                        onChange={v => updateEntry(i, f.key, v)} />
          ))}
        </div>
      ))}
      <button
        type="button"
        onClick={() => setEntries([...entries, blankEntry(fields)])}
        className="flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-800"
      >
        <Plus size={13} /> {t('classifier.addRow')}
      </button>
    </div>
  )
}

const MONO = new Set(['fieldValue', 'parentValue', 'regex', 'dataCleanRegex', 'tokenizationDelimiter'])

function FieldInput({ framework, field, value, onChange }: {
  framework: ClassifierFrameworkName
  field: ClassifierField
  value: unknown
  onChange: (value: unknown) => void
}) {
  const { t } = useT()
  const label = t(k(`classifier.p.${framework}.${field.key}`))
  const showFallback = field.fallback !== undefined && field.fallback !== '' && field.kind !== 'text'
  const help = (
    <p className={helpCls}>
      {t(k(`classifier.p.${framework}.${field.key}.help`))}
      {showFallback && ` ${t('classifier.default', { value: String(field.fallback) })}`}
    </p>
  )
  const setNumber = (raw: string) => onChange(raw === '' ? undefined : Number(raw))

  if (field.kind === 'flag') {
    return (
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input type="checkbox" className="mt-0.5" checked={value === true} onChange={e => onChange(e.target.checked)} />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-slate-700">{label}</span>
          {help}
        </span>
      </label>
    )
  }

  let input: React.ReactNode
  switch (field.kind) {
    case 'choice': {
      const options = field.options ?? []
      const current = String(value ?? '')
      // A value Delphix knows but this tool does not list stays visible rather than being
      // silently replaced by the first option.
      const unlisted = current !== '' && !options.includes(current)
      input = (
        <select value={current} onChange={e => onChange(e.target.value)} className={fieldCls}>
          {unlisted && <option value={current}>{current}</option>}
          {options.map(o => <option key={o} value={o}>{t(k(`classifier.enum.${field.key}.${o}`))}</option>)}
        </select>
      )
      break
    }
    case 'number': {
      const n = typeof value === 'number' ? value : Number(field.fallback ?? 0)
      input = (
        <div className="flex items-center gap-3">
          <input type="range" min={field.min ?? 0} max={field.max ?? 1} step={0.01} value={n}
                 onChange={e => setNumber(e.target.value)} className="flex-1 accent-blue-600" />
          <input type="number" min={field.min ?? 0} max={field.max ?? 1} step={0.01}
                 value={typeof value === 'number' ? value : ''}
                 placeholder={field.fallback !== undefined ? String(field.fallback) : ''}
                 onChange={e => setNumber(e.target.value)} className={cn(fieldCls, 'w-24')} />
        </div>
      )
      break
    }
    case 'integer':
      input = (
        <input type="number" step={1} min={field.min}
               value={typeof value === 'number' ? value : ''}
               placeholder={field.fallback !== undefined ? String(field.fallback) : ''}
               onChange={e => setNumber(e.target.value)} className={fieldCls} />
      )
      break
    case 'file':
      input = (
        <FilePickerField
          value={typeof value === 'string' && value ? { uri: value } : null}
          onChange={v => onChange((v as { uri: string } | null)?.uri ?? '')}
        />
      )
      break
    default:
      input = field.key === 'note' ? (
        <textarea rows={2} value={String(value ?? '')} onChange={e => onChange(e.target.value)} className={fieldCls} />
      ) : (
        <input type="text" value={String(value ?? '')} onChange={e => onChange(e.target.value)}
               spellCheck={false} maxLength={field.maxChars}
               className={cn(fieldCls, MONO.has(field.key) && 'font-mono')} />
      )
  }

  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1">{label}</label>
      {input}
      {help}
    </div>
  )
}

// ── Test bench ────────────────────────────────────────────────────────────────

function TestPanel({ catalog, classifier }: {
  catalog: ClassifierCatalog | null
  classifier: { id?: number; name: string; framework: ClassifierFrameworkName; domain: string; config: Row } | null
}) {
  const { t } = useT()
  const [fieldName, setFieldName] = useState('')
  const [parent, setParent] = useState('')
  const [sqlType, setSqlType] = useState(12)
  const [length, setLength] = useState('')
  const [autoIncrement, setAutoIncrement] = useState(false)
  const [values, setValues] = useState('')
  const [threshold, setThreshold] = useState(1)
  const [result, setResult] = useState<ClassifierTestResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async () => {
    if (!classifier) return
    setBusy(true)
    setError(null)
    try {
      const out = await api.testClassifier({
        classifier,
        field: {
          name: fieldName,
          parent: parent || undefined,
          sqlType,
          length: length === '' ? null : Number(length),
          autoIncrement,
          values: values.trim() === '' ? [] : values.split(/\r?\n/),
        },
        threshold,
      })
      setResult(out)
    } catch (e) {
      const err = e as Error & { code?: string; files?: string[] }
      setResult(null)
      setError(
        err.code === 'invalid-config' ? t('classifier.fixIssues')
        : err.code === 'cannot-evaluate' ? t('classifier.cannotEvaluate')
        : err.code === 'file-missing' ? t('classifier.fileMissing', { files: (err.files ?? []).join(', ') })
        : err.message)
    } finally { setBusy(false) }
  }

  const sqlTypes = [...(catalog?.sqlTypes ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  // Grouped by family in the order people reach for them; any family the server adds goes last.
  const families = [
    ...FAMILY_ORDER.filter(f => sqlTypes.some(s => s.family === f)),
    ...[...new Set(sqlTypes.map(s => s.family))].filter(f => !FAMILY_ORDER.includes(f)),
  ]

  return (
    <div className={cn(cardCls, 'xl:sticky xl:top-0')}>
      <div>
        <h3 className="text-sm font-semibold text-slate-800">{t('classifier.test')}</h3>
        <p className={helpCls}>{t('classifier.testHint')}</p>
      </div>

      <div className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2">
        <p className="text-xs font-semibold text-slate-600">{t('classifier.columnSection')}</p>
        <p className="text-xs text-slate-500 mt-0.5">{t('classifier.columnSectionHint')}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={labelCls}>{t('classifier.fieldName')}</label>
          <input type="text" value={fieldName} onChange={e => setFieldName(e.target.value)}
                 placeholder={t('classifier.fieldNamePlaceholder')} className={cn(fieldCls, 'font-mono')} />
          <p className={helpCls}>{t('classifier.fieldNameHint')}</p>
        </div>
        <div>
          <label className={labelCls}>{t('classifier.parent')}</label>
          <input type="text" value={parent} onChange={e => setParent(e.target.value)}
                 placeholder={t('classifier.parentPlaceholder')} className={cn(fieldCls, 'font-mono')} />
          <p className={helpCls}>{t('classifier.parentHint')}</p>
        </div>
        <div>
          <label className={labelCls}>{t('classifier.sqlType')}</label>
          <select value={sqlType} onChange={e => setSqlType(Number(e.target.value))} disabled={!sqlTypes.length} className={fieldCls}>
            {!sqlTypes.length && <option value={sqlType}>{t('classifier.loadingCatalog')}</option>}
            {families.map(family => (
              <optgroup key={family} label={capitalize(t(k(`classifier.family.${family}`)))}>
                {sqlTypes.filter(s => s.family === family).map(s => (
                  <option key={s.code} value={s.code}>{s.name} ({s.code})</option>
                ))}
              </optgroup>
            ))}
          </select>
          <p className={helpCls}>{t('classifier.sqlTypeHint')}</p>
        </div>
        <div>
          <label className={labelCls}>{t('classifier.length')}</label>
          <input type="number" min={0} value={length} onChange={e => setLength(e.target.value)}
                 placeholder={t('classifier.lengthPlaceholder')} className={fieldCls} />
          <p className={helpCls}>{t('classifier.lengthHint')}</p>
        </div>
      </div>

      <label className="flex items-start gap-2.5 cursor-pointer">
        <input type="checkbox" className="mt-0.5" checked={autoIncrement} onChange={e => setAutoIncrement(e.target.checked)} />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-slate-700">{t('classifier.autoIncrement')}</span>
          <span className={cn(helpCls, 'block')}>{t('classifier.autoIncrementHint')}</span>
        </span>
      </label>

      <div>
        <label className={labelCls}>{t('classifier.values')}</label>
        <textarea rows={6} value={values} onChange={e => setValues(e.target.value)}
                  placeholder={t('classifier.valuesPlaceholder')} spellCheck={false}
                  className={cn(fieldCls, 'font-mono')} />
        <p className={helpCls}>{t('classifier.valuesHint')}</p>
      </div>

      <div>
        <label className={labelCls}>{t('classifier.threshold')}</label>
        <input type="number" min={1} max={100} value={threshold}
               onChange={e => setThreshold(Number(e.target.value))} className={cn(fieldCls, 'w-28')} />
        <p className={helpCls}>{t('classifier.thresholdHint')}</p>
      </div>

      <button
        onClick={run}
        disabled={busy || !classifier}
        className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm font-semibold rounded-lg hover:bg-emerald-700 disabled:opacity-60 transition-colors"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} fill="currentColor" />}
        {busy ? t('classifier.running') : t('classifier.run')}
      </button>

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3 break-words">{error}</p>
      )}
      {result && classifier && (
        <TestResult result={result} selfId={classifier.id ?? 'unsaved'} domain={classifier.domain} catalog={catalog} />
      )}
    </div>
  )
}

function Percent({ confidence, large }: { confidence: number | null; large?: boolean }) {
  if (confidence === null) return <span className="text-slate-400">—</span>
  const p = percentOf(confidence)
  return (
    <span className={cn('tabular-nums font-semibold',
      large ? 'text-2xl' : 'text-sm',
      p > 0 ? 'text-emerald-600' : p < 0 ? 'text-red-600' : 'text-slate-500')}>
      {p > 0 ? '+' : ''}{p}%
    </span>
  )
}

function TestResult({ result, selfId, domain, catalog }: {
  result: ClassifierTestResult
  selfId: number | string
  domain: string
  catalog: ClassifierCatalog | null
}) {
  const { t } = useT()

  if (result.failure) {
    return (
      <p className="flex gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3 break-words">
        <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
        {t('classifier.failure', { error: result.failure })}
      </p>
    )
  }

  const self = result.classifiers.find(c => c.id === selfId) ?? null
  const mine: ClassifierDomainScore | null = result.ranking.find(d => d.domain === domain) ?? null
  const column = result.column
  const sqlName = catalog?.sqlTypes.find(s => s.code === column.sqlType)?.name ?? String(column.sqlType)
  const inDomain = result.classifiers.filter(c => c.domain === domain)
  const merged = result.mergedTypes.filter(m => m.domain === domain)

  return (
    <div className="space-y-4 border-t border-slate-200 pt-4">
      <p className="text-xs text-slate-500">
        {t('classifier.seen', {
          type: sqlName,
          family: t(k(`classifier.family.${column.family}`)),
          length: column.length === UNBOUNDED ? t('classifier.unbounded') : String(column.length),
        })}
      </p>

      {self && <OwnResult own={self} />}

      <div className="rounded-lg border border-slate-200 p-3 space-y-2">
        <div className="flex items-baseline gap-3">
          <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide flex-1">
            {t('classifier.domainResult', { name: domain })}
          </h4>
          {mine && <Percent confidence={mine.score} large />}
        </div>

        {!mine ? (
          <p className="text-sm text-slate-500">{t('classifier.domainNoResult')}</p>
        ) : (
          <>
            <p className={cn('text-sm rounded-md px-2.5 py-1.5',
              result.assigned === domain ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800')}>
              {t(result.assigned === domain ? 'classifier.assigned' : 'classifier.notAssigned', { threshold: result.threshold })}
            </p>
            <ul className="text-sm text-slate-600 space-y-0.5">
              <li>
                {mine.metadata
                  ? <>{t('classifier.metaPart', { name: mine.metadata.classifier, percent: percentOf(mine.metadata.score) })}
                      {!mine.counted.metadata && ` ${t('classifier.partIgnored')}`}</>
                  : t('classifier.metaNone')}
              </li>
              <li>
                {mine.values
                  ? <>{t('classifier.dataPart', {
                        name: mine.values.classifier, percent: percentOf(mine.values.score),
                        matched: mine.values.hits, total: result.sampleSize,
                      })}
                      {!mine.counted.values && ` ${t('classifier.partIgnored')}`}</>
                  : result.valuesSkipped ? t(k(`classifier.valuesSkipped.${camel(result.valuesSkipped)}`))
                  : t('classifier.dataNone')}
              </li>
            </ul>
            {mine.counted.metadata && mine.counted.values && <p className={helpCls}>{t('classifier.combinedHow')}</p>}
          </>
        )}

        {merged.map(m => (
          <p key={m.name} className={helpCls}>
            {t('classifier.combinedTypes', { n: m.from.length, names: m.from.join(', ') })}
          </p>
        ))}

        {inDomain.length > 1 && (
          <div className="pt-1">
            <p className="text-xs font-semibold text-slate-500 mb-1">{t('classifier.domainClassifiers')}</p>
            <ul className="space-y-0.5">
              {inDomain.map((c, i) => (
                <li key={`${c.id}-${i}`} className="flex items-center gap-2 text-xs">
                  <span className={cn('truncate flex-1', c.id === selfId ? 'font-semibold text-slate-800' : 'text-slate-600')}>
                    {c.name} <span className="text-slate-400">· {c.framework}</span>
                  </span>
                  <span className="text-slate-400 truncate max-w-[45%]">{t(k(`classifier.status.${camel(c.outcome)}`))}</span>
                  <Percent confidence={c.score} />
                </li>
              ))}
            </ul>
          </div>
        )}

        {result.skipped.length > 0 && (
          <p className="text-xs text-amber-700">
            {t('classifier.skippedPeers', { n: result.skipped.length, names: result.skipped.map(s => s.name).join(', ') })}
          </p>
        )}
      </div>
    </div>
  )
}

function OwnResult({ own }: { own: ClassifierReport }) {
  const { t } = useT()
  const explain = own.explain ?? {}
  const rows = explain.rows ?? []

  let summary: string | null = null
  if (own.framework === 'PATH') {
    summary = explain.rule != null ? t('classifier.detail.pathMatched', { n: explain.rule + 1 }) : t('classifier.detail.pathNone')
  } else if (own.framework === 'TYPE') {
    summary = explain.accepted ? t('classifier.detail.typeAccepted', { type: explain.accepted })
      : explain.rejected ? t(k(`classifier.detail.reason.${camel(explain.rejected)}`)) : null
  } else if (rows.length) {
    summary = t('classifier.detail.valuesSummary', { matched: own.hits, total: rows.length })
  }

  const via = (row: ClassifierValueRow) => {
    if (row.words) return row.words.map(w => (w.list != null ? `${w.word} ✓` : w.word)).join(' · ')
    if (row.pattern != null) return t('classifier.detail.pattern', { n: row.pattern + 1 })
    if (row.checksumFailed?.length) return t('classifier.detail.checksumFailed', { n: row.checksumFailed[0] + 1 })
    if (row.list != null) return t('classifier.detail.list', { n: row.list + 1 })
    return '—'
  }

  return (
    <div className="rounded-lg border border-slate-200 p-3 space-y-2">
      <div className="flex items-baseline gap-3">
        <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide flex-1">{t('classifier.thisClassifier')}</h4>
        <Percent confidence={own.score} large />
      </div>
      {own.outcome !== 'counted' && (
        <p className="text-xs text-slate-500">{t(k(`classifier.status.${camel(own.outcome)}`))}</p>
      )}
      {own.problem && <p className="text-xs text-red-700 break-words">{own.problem}</p>}
      {summary && <p className="text-sm text-slate-700">{summary}</p>}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-200">
                <th className="py-1 pr-2 font-semibold">{t('classifier.detail.value')}</th>
                <th className="py-1 pr-2 font-semibold">{t('classifier.detail.via')}</th>
                <th className="py-1 font-semibold text-right">{t('classifier.detail.result')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b border-slate-100 last:border-0">
                  <td className="py-1 pr-2 font-mono text-slate-700 break-all">{row.value}</td>
                  <td className="py-1 pr-2 text-slate-500">{via(row)}</td>
                  <td className="py-1 text-right"><Percent confidence={row.score} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const cardCls = 'bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4'
const labelCls = 'block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5'
const helpCls = 'text-xs text-slate-400 mt-1'
const fieldCls = 'w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'
