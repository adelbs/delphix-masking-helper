import { useState, useEffect } from 'react'
import { Download, Upload, Trash2, Play, Search, BookmarkCheck, PanelLeftOpen, ChevronDown, ChevronUp, Pencil, Check, X, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import type { Algorithm, SavedTest } from '@/types'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'

interface Props {
  algorithms: Algorithm[]
  onEdit: (algo: Algorithm, config: Record<string, unknown>, input: string) => void
  onToggleSidebar: () => void
}

/** Handles records saved before and after the double-serialisation fix. */
function parseConfig(raw: string): Record<string, unknown> {
  try {
    const first = JSON.parse(raw)
    if (typeof first === 'string') return JSON.parse(first)
    return first as Record<string, unknown>
  } catch {
    return {}
  }
}

export function SavedTests({ algorithms, onEdit, onToggleSidebar }: Props) {
  const { t: msg } = useT()
  const [tests, setTests] = useState<SavedTest[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      const data = await api.getTests()
      setTests(data)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const filtered = tests.filter((t) =>
    query === '' ||
    t.name.toLowerCase().includes(query.toLowerCase()) ||
    t.display_name.toLowerCase().includes(query.toLowerCase())
  )

  const handleDelete = async (id: number) => {
    if (!confirm(msg('saved.confirmDelete'))) return
    await api.deleteTest(id)
    setTests(ts => ts.filter(t => t.id !== id))
    toast.success(msg('saved.deleted'))
  }

  const handleUpdate = async (id: number, patch: { name?: string; input?: string }) => {
    const updated = await api.updateTest(id, patch)
    setTests(ts => ts.map(t => t.id === id ? updated : t))
    toast.success(msg('saved.saved'))
  }

  const handleEdit = (t: SavedTest, inputOverride?: string) => {
    const algo = algorithms.find((a) => a.className === t.algorithm)
    if (!algo) { toast.error(msg('saved.algoNotFound')); return }
    onEdit(algo, parseConfig(t.config), inputOverride ?? t.input)
  }

  const handleExport = async () => {
    const data = await api.exportTests()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'delphix-tests.json'
    a.click()
  }

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      const result = await api.importTests(data)
      toast.success(msg('saved.imported', { n: result.imported }))
      await load()
    } catch {
      toast.error(msg('saved.importError'))
    }
    e.target.value = ''
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-200 bg-white flex-shrink-0">
        <button onClick={onToggleSidebar} className="text-slate-400 hover:text-slate-600 transition-colors">
          <PanelLeftOpen size={18} />
        </button>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <BookmarkCheck size={16} className="text-slate-600 flex-shrink-0" />
          <h2 className="text-sm font-semibold text-slate-800">{msg('saved.title')}</h2>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleExport} className={actionBtn}>
            <Download size={14} /> {msg('saved.export')}
          </button>
          <label className={cn(actionBtn, 'cursor-pointer')}>
            <Upload size={14} /> {msg('saved.import')}
            <input type="file" accept=".json" className="hidden" onChange={handleImport} />
          </label>
        </div>
      </div>

      {/* Search */}
      <div className="px-5 py-3 border-b border-slate-100 bg-white flex-shrink-0">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder={msg('saved.filter')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-auto p-5">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-slate-400 text-sm">{msg('saved.loading')}</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-slate-400 text-sm gap-2">
            <BookmarkCheck size={24} className="text-slate-300" />
            {tests.length === 0 ? msg('saved.empty') : msg('saved.noResults')}
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((t) => (
              <TestCard
                key={t.id}
                test={t}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onSave={handleUpdate}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function TestCard({ test: t, onEdit, onDelete, onSave }: {
  test: SavedTest
  onEdit: (t: SavedTest, inputOverride?: string) => void
  onDelete: (id: number) => void
  onSave: (id: number, patch: { name?: string; input?: string }) => Promise<void>
}) {
  const { t: msg, locale } = useT()
  const [expanded, setExpanded] = useState(false)
  const [nameDraft, setNameDraft] = useState(t.name)
  const [editingName, setEditingName] = useState(false)
  const [inputDraft, setInputDraft] = useState(t.input)
  const [saving, setSaving] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [execResult, setExecResult] = useState<{ value: string; ok: boolean } | null>(null)

  useEffect(() => {
    setNameDraft(t.name)
    setInputDraft(t.input)
    setExecResult(null)
  }, [t.name, t.input])

  const dirty = nameDraft !== t.name || inputDraft !== t.input

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(t.id, { name: nameDraft, input: inputDraft })
    } finally {
      setSaving(false)
    }
  }

  const handleCancelEdit = () => {
    setNameDraft(t.name)
    setInputDraft(t.input)
    setEditingName(false)
  }

  const handleExecute = async () => {
    setExecuting(true)
    setExecResult(null)
    try {
      const config = parseConfig(t.config)
      const result = await api.mask({
        algorithm: t.algorithm,
        config,
        input: inputDraft,
      })
      setExecResult(result.output !== undefined
        ? { value: result.output, ok: true }
        : { value: result.error ?? msg('saved.unknownError'), ok: false }
      )
    } catch (e) {
      setExecResult({ value: (e as Error).message, ok: false })
    } finally {
      setExecuting(false)
    }
  }

  let configPreview = ''
  try {
    const parsed = parseConfig(t.config)
    const keys = Object.keys(parsed)
    configPreview = keys.length === 0 ? '{}' : `{ ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''} }`
  } catch { configPreview = t.config }

  return (
    <div className={cn(
      'bg-white rounded-xl border shadow-sm transition-colors',
      expanded ? 'border-blue-200' : 'border-slate-200 hover:border-slate-300'
    )}>
      {/* Header row */}
      <div className="flex items-start gap-3 p-4">
        <div className="min-w-0 flex-1">
          {editingName ? (
            <div className="flex items-center gap-1.5 mb-0.5">
              <input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setEditingName(false)
                  if (e.key === 'Escape') { setNameDraft(t.name); setEditingName(false) }
                }}
                className="flex-1 text-sm font-semibold text-slate-800 border-b border-blue-400 outline-none bg-transparent"
              />
              <button onClick={() => setEditingName(false)} className="text-green-600 hover:text-green-700"><Check size={13} /></button>
              <button onClick={() => { setNameDraft(t.name); setEditingName(false) }} className="text-slate-400 hover:text-slate-600"><X size={13} /></button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 mb-0.5 group">
              <p className="font-semibold text-slate-800 text-sm truncate">{nameDraft}</p>
              <button
                onClick={() => { setEditingName(true); setExpanded(true) }}
                className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-slate-600 transition-opacity"
              >
                <Pencil size={11} />
              </button>
            </div>
          )}
          <p className="text-xs text-slate-400">
            <span className="font-mono">{t.display_name}</span>
            {' · '}
            {new Date(t.updated_at).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })}
          </p>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            onClick={() => onEdit(t)}
            title={msg('saved.editTitle')}
            className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 text-slate-600 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors"
          >
            <ExternalLink size={12} /> {msg('saved.edit')}
          </button>
          <button
            onClick={() => onDelete(t.id)}
            className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
          >
            <Trash2 size={14} />
          </button>
          <button
            onClick={() => setExpanded(v => !v)}
            className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {/* Collapsed summary */}
      {!expanded && (
        <div className="px-4 pb-3 space-y-1 text-xs text-slate-600">
          {t.input && (
            <div className="flex gap-1.5">
              <span className="text-slate-400 font-medium flex-shrink-0">{msg('saved.inputShort')}</span>
              <span className="font-mono truncate">{t.input}</span>
            </div>
          )}
          {t.output != null && (
            <div className="flex gap-1.5">
              <span className="text-slate-400 font-medium flex-shrink-0">{msg('saved.outputShort')}</span>
              <span className="font-mono font-semibold text-green-700 truncate">{t.output}</span>
            </div>
          )}
        </div>
      )}

      {/* Expanded area */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-slate-100 pt-3 space-y-3">

          {/* Editable input */}
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
              {msg('saved.inputValue')}
            </label>
            <textarea
              value={inputDraft}
              onChange={(e) => { setInputDraft(e.target.value); setExecResult(null) }}
              rows={2}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-mono text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
            />
          </div>

          {/* Config read-only */}
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
              {msg('saved.configuration')}
            </label>
            <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs font-mono text-slate-500 break-all">
              {configPreview}
            </div>
          </div>

          {/* Execution result */}
          {execResult && (
            <div className={cn(
              'rounded-lg px-3 py-2.5 text-sm font-mono break-all',
              execResult.ok
                ? 'bg-green-50 text-green-800 border border-green-200'
                : 'bg-red-50 text-red-800 border border-red-200'
            )}>
              <span className="text-xs font-sans font-semibold uppercase tracking-wide opacity-60 mr-2">
                {execResult.ok ? msg('saved.outputLabel') : msg('saved.errorLabel')}
              </span>
              {execResult.value}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1 flex-wrap">
            <button
              onClick={handleExecute}
              disabled={executing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-60"
            >
              {executing
                ? <div className="w-3 h-3 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                : <Play size={11} fill="currentColor" />}
              {executing ? msg('saved.running') : msg('saved.run')}
            </button>

            <button
              onClick={() => onEdit(t, inputDraft)}
              title={msg('saved.editInTesterTitle')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors"
            >
              <ExternalLink size={11} /> {msg('saved.editInTester')}
            </button>

            {dirty && (
              <>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-green-700 bg-green-50 hover:bg-green-100 border border-green-200 rounded-lg transition-colors disabled:opacity-60"
                >
                  <Check size={11} />
                  {saving ? msg('saved.saving') : msg('saved.saveChanges')}
                </button>
                <button
                  onClick={handleCancelEdit}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  <X size={11} /> {msg('saved.cancel')}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const actionBtn = 'flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 text-slate-600 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors'
