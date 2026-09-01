import { useEffect, useRef, useState } from 'react'
import type { JsonSchema, JsonSchemaProperty, SavedTest, ServerFile } from '@/types'
import { cn, camelToLabel } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { api } from '@/lib/api'
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react'

const ALGO_REF_URN = 'AlgorithmInstanceReference'
function isAlgorithmRef(schema: JsonSchemaProperty): boolean {
  return !!(schema.id?.includes(ALGO_REF_URN) || schema.$ref?.includes(ALGO_REF_URN))
}

interface ConfigFormProps {
  schema: JsonSchema | null
  values: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => void
}

export function ConfigForm({ schema, values, onChange }: ConfigFormProps) {
  const { t } = useT()
  if (!schema?.properties) {
    return <p className="text-sm text-slate-400 italic">{t('form.noParams')}</p>
  }

  return (
    <div className="space-y-4">
      {Object.entries(schema.properties).map(([key, prop]) => (
        <FieldRenderer
          key={key}
          fieldKey={key}
          schema={prop}
          value={values[key]}
          onChange={(val) => onChange({ ...values, [key]: val })}
        />
      ))}
    </div>
  )
}

interface FieldProps {
  fieldKey: string
  schema: JsonSchemaProperty
  value: unknown
  onChange: (val: unknown) => void
}

function FieldRenderer({ fieldKey, schema, value, onChange }: FieldProps) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-0.5">
        {schema.title ?? camelToLabel(fieldKey)}
        {schema.required && <span className="text-red-500 ml-1">*</span>}
      </label>
      {schema.description && (
        <p className="text-xs text-slate-400 mb-1.5">{schema.description}</p>
      )}
      <FieldInput fieldKey={fieldKey} schema={schema} value={value} onChange={onChange} />
    </div>
  )
}

function FieldInput({ fieldKey, schema, value, onChange }: FieldProps) {
  const { t } = useT()
  if (isAlgorithmRef(schema)) {
    return <AlgorithmRefField value={value} onChange={onChange} />
  }

  if (schema.enum) {
    return (
      <select
        value={String(value ?? schema.enum[0])}
        onChange={(e) => onChange(e.target.value)}
        className={inputCls}
      >
        {schema.enum.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    )
  }

  if (schema.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
        />
        <span className="text-sm text-slate-600">{t('form.enabled')}</span>
      </label>
    )
  }

  if (schema.type === 'integer' || schema.type === 'number') {
    return (
      <input
        type="number"
        value={value != null ? String(value) : ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        className={inputCls}
      />
    )
  }

  if (schema.id?.includes('FileReference')) {
    return <FilePickerField value={value as { uri: string } | null} onChange={onChange} />
  }

  if (schema.type === 'array') {
    if (isConditionsField(schema)) {
      return <ConditionArrayField value={value} onChange={onChange} />
    }
    return <ArrayField fieldKey={fieldKey} schema={schema} value={value} onChange={onChange} />
  }

  if (schema.type === 'object') {
    return <ObjectField fieldKey={fieldKey} schema={schema} value={value} onChange={onChange} />
  }

  return (
    <input
      type="text"
      value={value != null ? String(value) : ''}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      className={inputCls}
    />
  )
}

// --- MultiColumnCondition specialized editor ---

const COLUMN_SLOTS = [
  { group: 'string', slots: ['string1','string2','string3','string4','string5','string6','string7','string8','string9','string10'] },
  { group: 'numeric', slots: ['numeric1','numeric2','numeric3'] },
  { group: 'date', slots: ['date1','date2','date3'] },
  { group: 'binary', slots: ['binary1','binary2','binary3'] },
] as const

type SlotGroup = (typeof COLUMN_SLOTS)[number]['group']
const ALL_SLOTS = COLUMN_SLOTS.flatMap(g => g.slots)

function isConditionsField(schema: JsonSchemaProperty): boolean {
  const itemProps = schema.items?.properties
  if (!itemProps) return false
  return 'key' in itemProps && ('string1' in itemProps || 'numeric1' in itemProps)
}

type Condition = Record<string, unknown>

function ConditionArrayField({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const { t } = useT()
  const [items, setItems] = useState<Condition[]>(Array.isArray(value) ? (value as Condition[]) : [])
  const [expanded, setExpanded] = useState<number[]>([])

  useEffect(() => {
    setItems(Array.isArray(value) ? (value as Condition[]) : [])
  }, [value])

  const update = (next: Condition[]) => { setItems(next); onChange(next) }

  const addCondition = () => {
    const idx = items.length
    update([...items, { key: [] }])
    setExpanded(e => [...e, idx])
  }

  const removeCondition = (idx: number) => {
    update(items.filter((_, i) => i !== idx))
    setExpanded(e => e.filter(i => i !== idx).map(i => i > idx ? i - 1 : i))
  }

  const updateCondition = (idx: number, c: Condition) => {
    const next = [...items]; next[idx] = c; update(next)
  }

  const toggle = (idx: number) =>
    setExpanded(e => e.includes(idx) ? e.filter(i => i !== idx) : [...e, idx])

  return (
    <div className="space-y-2">
      {items.map((cond, idx) => {
        const keys = Array.isArray(cond.key) ? (cond.key as string[]) : []
        const activeSlots = ALL_SLOTS.filter(s => cond[s] != null)
        const isOpen = expanded.includes(idx)
        const summary = keys.length ? keys.map(k => `"${k}"`).join(', ') : t('form.noKey')
        return (
          <div key={idx} className="border border-slate-200 rounded-lg">
            <div
              className="flex items-center gap-2 px-3 py-2 bg-slate-50 cursor-pointer select-none"
              onClick={() => toggle(idx)}
            >
              {isOpen ? <ChevronDown size={14} className="text-slate-400 shrink-0" /> : <ChevronRight size={14} className="text-slate-400 shrink-0" />}
              <span className="text-sm font-medium text-slate-700 flex-1">
                {t('form.condition', { n: idx + 1 })}
                <span className="ml-2 font-normal text-slate-400 text-xs">
                  key ∈ {'{' + summary + '}'} · {t('form.columnCount', { n: activeSlots.length })}
                </span>
              </span>
              <button
                type="button"
                onClick={e => { e.stopPropagation(); removeCondition(idx) }}
                className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
              >
                <X size={14} />
              </button>
            </div>
            {isOpen && (
              <div className="px-3 py-3 space-y-4 border-t border-slate-200">
                <ConditionKeyField
                  keys={keys}
                  onChange={k => updateCondition(idx, { ...cond, key: k })}
                />
                {activeSlots.map(slot => (
                  <ConditionSlotField
                    key={slot}
                    slot={slot}
                    value={cond[slot]}
                    onChange={v => updateCondition(idx, { ...cond, [slot]: v })}
                    onRemove={() => {
                      const next = { ...cond }; delete next[slot]
                      updateCondition(idx, next)
                    }}
                  />
                ))}
                <AddSlotButton
                  activeSlots={activeSlots}
                  onAdd={slot => updateCondition(idx, { ...cond, [slot]: {} })}
                />
              </div>
            )}
          </div>
        )
      })}
      <button
        type="button"
        onClick={addCondition}
        className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 font-medium py-1"
      >
        <Plus size={14} /> {t('form.addCondition')}
      </button>
    </div>
  )
}

function ConditionKeyField({ keys, onChange }: { keys: string[]; onChange: (k: string[]) => void }) {
  const { t } = useT()
  const [draft, setDraft] = useState('')

  const add = () => {
    const v = draft.trim()
    if (v && !keys.includes(v)) onChange([...keys, v])
    setDraft('')
  }

  return (
    <div>
      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
        {t('form.keyValues')}
      </label>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {keys.map(k => (
          <span key={k} className="inline-flex items-center gap-1 bg-blue-100 text-blue-700 text-xs font-medium px-2 py-0.5 rounded-full">
            {k}
            <button type="button" onClick={() => onChange(keys.filter(x => x !== k))} className="hover:text-red-600">
              <X size={10} />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          placeholder={t('form.keyValuePlaceholder')}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          className={cn(inputCls, 'flex-1')}
        />
        <button
          type="button"
          onClick={add}
          className="px-3 py-1.5 text-sm bg-slate-100 hover:bg-slate-200 rounded-md text-slate-700 transition-colors"
        >
          {t('form.add')}
        </button>
      </div>
    </div>
  )
}

function ConditionSlotField({ slot, value, onChange, onRemove }: {
  slot: string; value: unknown; onChange: (v: unknown) => void; onRemove: () => void
}) {
  const { t } = useT()
  const group = COLUMN_SLOTS.find(g => (g.slots as readonly string[]).includes(slot))?.group
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{group ? t(`form.slot.${group}`) : ''}</span>
        <span className="text-sm font-medium text-slate-700">{slot}</span>
        <button
          type="button"
          onClick={onRemove}
          className="ml-auto p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
        >
          <X size={12} />
        </button>
      </div>
      <AlgorithmRefField value={value} onChange={onChange} />
    </div>
  )
}

function AddSlotButton({ activeSlots, onAdd }: { activeSlots: string[]; onAdd: (slot: string) => void }) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const available: Array<{ group: SlotGroup; slots: string[] }> = COLUMN_SLOTS
    .map(g => ({ group: g.group, slots: (g.slots as readonly string[]).filter(s => !activeSlots.includes(s)) }))
    .filter(g => g.slots.length > 0)

  if (available.length === 0) return null

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 font-medium py-1"
      >
        <Plus size={14} /> {t('form.addSlot')}
      </button>
      {open && (
        <div className="mt-2 border border-slate-200 rounded-lg bg-slate-50 py-1">
          {available.map(g => (
            <div key={g.group}>
              <div className="px-3 py-1 text-xs font-semibold text-slate-400 uppercase tracking-wide">{t(`form.slot.${g.group}`)}</div>
              <div className="flex flex-wrap gap-1.5 px-3 pb-2">
                {g.slots.map(s => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => { onAdd(s); setOpen(false) }}
                    className="px-2.5 py-1 text-sm text-slate-700 bg-white border border-slate-200 rounded-md hover:border-blue-400 hover:text-blue-700 transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// --- end MultiColumnCondition editor ---

function ArrayField({ schema, value, onChange }: FieldProps) {
  const { t } = useT()
  const itemSchema = schema.items ?? {}
  const [items, setItems] = useState<unknown[]>(Array.isArray(value) ? value : [])

  useEffect(() => {
    setItems(Array.isArray(value) ? value : [])
  }, [value])

  const update = (newItems: unknown[]) => {
    setItems(newItems)
    onChange(newItems)
  }

  const addItem = () => {
    const empty = itemSchema.type === 'object' && itemSchema.properties
      ? Object.fromEntries(Object.keys(itemSchema.properties).map((k) => [k, null]))
      : ''
    update([...items, empty])
  }

  const removeItem = (idx: number) => update(items.filter((_, i) => i !== idx))

  const updateItem = (idx: number, val: unknown) => {
    const next = [...items]
    next[idx] = val
    update(next)
  }

  return (
    <div className="space-y-2">
      {items.map((item, idx) => (
        <div key={idx} className="flex gap-2 items-start">
          <div className="flex-1">
            {itemSchema.type === 'object' && itemSchema.properties ? (
              <div className="pl-3 border-l-2 border-slate-200 space-y-3">
                {Object.entries(itemSchema.properties).map(([k, p]) => (
                  <FieldRenderer
                    key={k}
                    fieldKey={k}
                    schema={p}
                    value={(item as Record<string, unknown>)?.[k]}
                    onChange={(val) => updateItem(idx, { ...(item as Record<string, unknown>), [k]: val })}
                  />
                ))}
              </div>
            ) : (
              <input
                type="text"
                value={item != null ? String(item) : ''}
                onChange={(e) => updateItem(idx, e.target.value)}
                className={inputCls}
              />
            )}
          </div>
          <button
            type="button"
            onClick={() => removeItem(idx)}
            className="mt-1 p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addItem}
        className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 font-medium py-1"
      >
        <Plus size={14} /> {t('form.addItem')}
      </button>
    </div>
  )
}

function ObjectField({ schema, value, onChange }: FieldProps) {
  const val = (value ?? {}) as Record<string, unknown>

  // Object with additionalProperties → key/value map editor
  if (schema.additionalProperties && !schema.properties) {
    return <MapField value={val} onChange={onChange} />
  }

  // Nested object with known properties
  if (schema.properties) {
    return (
      <div className="pl-3 border-l-2 border-slate-200 space-y-3">
        {Object.entries(schema.properties).map(([k, p]) => (
          <FieldRenderer
            key={k}
            fieldKey={k}
            schema={p}
            value={val[k]}
            onChange={(v) => onChange({ ...val, [k]: v })}
          />
        ))}
      </div>
    )
  }

  // Generic object → JSON textarea
  const [raw, setRaw] = useState(JSON.stringify(value, null, 2) || '{}')
  return (
    <textarea
      value={raw}
      rows={3}
      onChange={(e) => {
        setRaw(e.target.value)
        try { onChange(JSON.parse(e.target.value)) } catch { /* wait for valid JSON */ }
      }}
      className={cn(inputCls, 'font-mono text-xs')}
    />
  )
}

interface MapFieldProps {
  value: Record<string, unknown>
  onChange: (val: unknown) => void
}

function MapField({ value, onChange }: MapFieldProps) {
  const { t } = useT()
  const [pairs, setPairs] = useState<[string, string][]>(
    Object.entries(value).map(([k, v]) => [k, String(v)])
  )
  const lastEmitted = useRef(JSON.stringify(value))

  useEffect(() => {
    const incoming = JSON.stringify(value)
    if (incoming !== lastEmitted.current) {
      lastEmitted.current = incoming
      setPairs(Object.entries(value).map(([k, v]) => [k, String(v)]))
    }
  }, [value])

  const update = (next: [string, string][]) => {
    setPairs(next)
    const obj: Record<string, string> = {}
    for (const [k, v] of next) if (k) obj[k] = v
    lastEmitted.current = JSON.stringify(obj)
    onChange(obj)
  }

  return (
    <div className="space-y-1.5">
      {pairs.map(([k, v], idx) => (
        <div key={idx} className="flex gap-1.5 items-center">
          <input
            type="text"
            placeholder={t('form.mapKey')}
            value={k}
            onChange={(e) => {
              const next = [...pairs] as [string, string][]
              next[idx] = [e.target.value, v]
              update(next)
            }}
            className={cn(inputCls, 'flex-1')}
          />
          <input
            type="text"
            placeholder={t('form.mapValue')}
            value={v}
            onChange={(e) => {
              const next = [...pairs] as [string, string][]
              next[idx] = [k, e.target.value]
              update(next)
            }}
            className={cn(inputCls, 'flex-1')}
          />
          <button
            type="button"
            onClick={() => update(pairs.filter((_, i) => i !== idx))}
            className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => update([...pairs, ['', '']])}
        className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 font-medium py-1"
      >
        <Plus size={14} /> {t('form.addPair')}
      </button>
    </div>
  )
}

interface FilePickerProps {
  value: { uri: string } | null | undefined
  onChange: (val: unknown) => void
}

function FilePickerField({ value, onChange }: FilePickerProps) {
  const { t, tx } = useT()
  const [files, setFiles] = useState<ServerFile[]>([])
  const [loading, setLoading] = useState(true)
  const refetchedFor = useRef<string | null>(null)

  useEffect(() => {
    api.getFiles()
      .then(setFiles)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const selectedUri = value?.uri ?? ''

  // Loading an example can create its sample file on the server after this list was
  // fetched. Re-list once when the selected file is missing, so it isn't shown blank.
  useEffect(() => {
    if (!selectedUri || refetchedFor.current === selectedUri) return
    if (files.some(f => f.uri === selectedUri)) return
    refetchedFor.current = selectedUri
    api.getFiles().then(setFiles).catch(() => {})
  }, [selectedUri, files])

  const handleChange = (uri: string) => {
    onChange(uri ? { uri } : null)
  }

  if (loading) {
    return <select disabled className={inputCls}><option>{t('form.loadingFiles')}</option></select>
  }

  if (files.length === 0) {
    return (
      <div className="space-y-1">
        <select disabled className={inputCls}><option>{t('form.noServerFiles')}</option></select>
        <p className="text-xs text-slate-400">
          {tx('form.addFilesHint', { path: <span className="font-medium text-slate-500">{t('form.settingsFilesPath')}</span> })}
        </p>
      </div>
    )
  }

  return (
    <select
      value={selectedUri}
      onChange={e => handleChange(e.target.value)}
      className={inputCls}
    >
      <option value="">{t('form.noFile')}</option>
      {files.map(f => (
        <option key={f.uri} value={f.uri}>{f.name}</option>
      ))}
    </select>
  )
}

function AlgorithmRefField({ value, onChange }: { value: unknown; onChange: (val: unknown) => void }) {
  const { t } = useT()
  const current = value as { name?: string } | null | undefined
  const [nameInput, setNameInput] = useState(current?.name ?? '')
  const [tests, setTests] = useState<SavedTest[]>([])

  useEffect(() => {
    api.getTests().then(setTests).catch(() => {})
  }, [])

  useEffect(() => {
    setNameInput((value as { name?: string } | null | undefined)?.name ?? '')
  }, [value])

  const emit = (name: string) => onChange(name ? { name } : null)

  const matched = tests.find(t => t.name === nameInput)

  return (
    <div className="space-y-1.5">
      {tests.length > 0 && (
        <select
          value={matched ? nameInput : ''}
          onChange={e => { setNameInput(e.target.value); emit(e.target.value) }}
          className={inputCls}
        >
          <option value="">{t('form.chooseSaved')}</option>
          {tests.map(t => (
            <option key={t.id} value={t.name}>
              {t.name}  ({t.display_name})
            </option>
          ))}
        </select>
      )}
      <input
        type="text"
        placeholder={t('form.algoNamePlaceholder')}
        value={nameInput}
        onChange={e => { setNameInput(e.target.value); emit(e.target.value) }}
        className={inputCls}
      />
      {matched && (
        <p className="text-xs text-blue-600">
          {t('form.usingSavedConfig')}<span className="font-medium">{matched.display_name}</span>
        </p>
      )}
    </div>
  )
}

const inputCls =
  'w-full rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-800 ' +
  'placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent ' +
  'transition-shadow'
