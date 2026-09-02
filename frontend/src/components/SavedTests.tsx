import { useState, useEffect } from 'react'
import { Download, Upload, Trash2, Play, Search, BookmarkCheck, PanelLeftOpen, ChevronDown, ChevronUp, Check, X, ExternalLink, Server, CloudUpload, Loader2, Copy } from 'lucide-react'
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
  const [engineOpen, setEngineOpen] = useState(false)
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

  // The mount fetch is inlined because `load` raises the loading flag first, and it already
  // starts true — `load` stays for the explicit refreshes, where the spinner is wanted.
  useEffect(() => {
    api.getTests().then(setTests).catch(() => {}).finally(() => setLoading(false))
  }, [])

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
          <button onClick={() => setEngineOpen(true)} className={cn(actionBtn, 'text-blue-700 border-blue-200 bg-blue-50 hover:bg-blue-100')}>
            <Server size={14} /> {msg('saved.importFromEngine')}
          </button>
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
                // Keyed by content, not just id: when a row comes back from the server changed,
                // the card remounts and its draft restarts from the new value. That is what the
                // effect mirroring t.input into state used to do.
                key={`${t.id}:${t.updated_at}`}
                test={t}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onSave={handleUpdate}
                onDuplicated={load}
              />
            ))}
          </div>
        )}
      </div>

      {engineOpen && (
        <EngineImport onClose={() => setEngineOpen(false)} onImported={load} />
      )}
    </div>
  )
}

/** Lists what the configured engine has and imports the chosen algorithms. */
function EngineImport({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const { t: msg } = useT()
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.delphixAlgorithms>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  // Runs once when the dialog opens. `msg` is only read to word one error, and the dialog is
  // never open across a language change, so it is deliberately not a dependency.
  useEffect(() => {
    api.delphixAlgorithms().then(setRows).catch((e: Error & { code?: string }) =>
      setError(e.code === 'not-configured' ? msg('saved.engineNotSet') : e.message))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (name: string) => setPicked(prev => {
    const next = new Set(prev)
    if (next.has(name)) next.delete(name); else next.add(name)
    return next
  })

  const run = async () => {
    setBusy(true)
    try {
      const out = await api.delphixImport([...picked])
      toast.success(msg('saved.importDone', { n: out.imported.length }))
      if (out.skipped.length) toast.warning(msg('saved.importSkipped', { n: out.skipped.length }))
      // The rows are saved either way; this is about what they still need before they can run.
      if (out.needsFiles?.length) {
        const files = [...new Set(out.needsFiles.flatMap(r => r.files))]
        toast.warning(msg('saved.importNeedsFilesDone', {
          n: out.needsFiles.length, files: files.join(', '),
        }))
      }
      onImported()
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally { setBusy(false) }
  }

  const importable = (rows ?? []).filter(r => r.supported)
  const allPicked = importable.length > 0 && importable.every(r => picked.has(r.algorithmName))

  // Only the importable rows: the others cannot be selected one by one either, and putting
  // them in would leave the box looking unchecked however many times it is clicked.
  const toggleAll = () =>
    setPicked(allPicked ? new Set() : new Set(importable.map(r => r.algorithmName)))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-slate-200">
          <Server size={16} className="text-blue-600" />
          <h3 className="text-sm font-semibold text-slate-800 flex-1">{msg('saved.importTitle')}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-auto p-5">
          {error && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">{error}</p>}
          {!rows && !error && (
            <p className="text-sm text-slate-400 flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" />{msg('saved.importLoading')}
            </p>
          )}
          {rows && importable.length === 0 && !error && (
            <p className="text-sm text-slate-500">{msg('saved.importNone')}</p>
          )}
          {rows && importable.length > 0 && (
            <label className="flex items-center gap-3 pb-2.5 mb-1 border-b border-slate-200 cursor-pointer">
              <input type="checkbox" checked={allPicked} onChange={toggleAll}
                     ref={el => { if (el) el.indeterminate = picked.size > 0 && !allPicked }} />
              <span className="text-sm font-medium text-slate-600">
                {msg('saved.importSelectAll', { n: importable.length })}
              </span>
            </label>
          )}
          {rows?.map(r => (
            <label key={r.algorithmName}
                   className={cn('flex items-start gap-3 py-2.5 border-b border-slate-100 last:border-0',
                                 r.supported ? 'cursor-pointer' : 'opacity-55')}>
              <input type="checkbox" disabled={!r.supported} className="mt-1"
                     checked={picked.has(r.algorithmName)}
                     onChange={() => toggle(r.algorithmName)} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-slate-800 truncate">{r.algorithmName}</span>
                <span className="block text-xs text-slate-400 truncate">{r.frameworkName ?? '—'}</span>
                {!r.supported && (
                  <span className="text-xs text-amber-700">{msg('saved.importUnsupported')}</span>
                )}
                {r.alreadyImported && (
                  <span className="text-xs text-slate-400">{msg('saved.importAlready')}</span>
                )}
                {r.supported && r.missingFiles?.length > 0 && (
                  <span className="block text-xs text-amber-700">
                    {msg('saved.importNeedsFiles', {
                      n: r.missingFiles.length, files: r.missingFiles.join(', '),
                    })}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>

        <div className="px-5 py-4 border-t border-slate-200">
          <button onClick={run} disabled={busy || picked.size === 0}
                  className="px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {msg('saved.importSelected', { n: picked.size })}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Asks for the new algorithm's name. Duplicating is how a new name is given, since the engine
 *  treats the name as identity and refuses to change it on an existing algorithm. */
function DuplicatePrompt({ suggested, onConfirm, onCancel }: {
  suggested: string
  onConfirm: (name: string) => Promise<void>
  onCancel: () => void
}) {
  const { t: msg } = useT()
  const [name, setName] = useState(suggested)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = async () => {
    const trimmed = name.trim()
    if (!trimmed) { setError(msg('saved.duplicateNameRequired')); return }
    setBusy(true); setError(null)
    try {
      await onConfirm(trimmed)
      toast.success(msg('saved.duplicateDone', { name: trimmed }))
    } catch (e) {
      setError((e as Error).message)
    } finally { setBusy(false) }
  }

  return (
    <div className="px-4 pb-4 -mt-1">
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
        <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
          {msg('saved.duplicateName')}
        </label>
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null) }}
            onKeyDown={(e) => { if (e.key === 'Enter') confirm(); if (e.key === 'Escape') onCancel() }}
            className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <button onClick={confirm} disabled={busy}
                  className="flex items-center gap-1 text-xs font-semibold px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            {msg('saved.duplicateConfirm')}
          </button>
          <button onClick={onCancel} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg">
            <X size={14} />
          </button>
        </div>
        {error && <p className="text-xs text-amber-800 mt-1.5">{error}</p>}
        <p className="text-xs text-slate-400 mt-1.5">{msg('saved.duplicateHint')}</p>
      </div>
    </div>
  )
}

function TestCard({ test: t, onEdit, onDelete, onSave, onDuplicated }: {
  test: SavedTest
  onEdit: (t: SavedTest, inputOverride?: string) => void
  onDelete: (id: number) => void
  onSave: (id: number, patch: { input?: string }) => Promise<void>
  onDuplicated: () => void
}) {
  const { t: msg, locale } = useT()
  const [sending, setSending] = useState(false)
  const [duplicating, setDuplicating] = useState(false)

  // Sends this algorithm to the configured engine. A row that came from that same engine is
  // updated there rather than copied, which is what delphix_origin/delphix_name record.
  const sendToEngine = async () => {
    setSending(true)
    try {
      const out = await api.delphixExport(t.id)
      toast.success(msg(out.mode === 'updated' ? 'saved.exportUpdated' : 'saved.exportCreated',
        { name: out.name }))
      // The engine rejects a changed algorithmName on update, so a local rename cannot travel.
      // Saying so beats leaving the user to notice the old name in the toast.
      if (out.renamed) toast.warning(msg('saved.exportRenamed', { name: out.name }))
      // Sent, not blocked: the path could be a real one on the engine's host, and only whoever
      // runs it knows. One picked from this machine's files folder will not be.
      if (out.localFiles?.length) {
        toast.warning(msg('saved.exportLocalFiles', {
          n: out.localFiles.length, files: out.localFiles.join(', '),
        }))
      }
    } catch (e) {
      const err = e as Error & { code?: string }
      toast.error(err.code === 'not-configured'
        ? msg('saved.engineNotSet')
        : msg('saved.exportFailed', { error: err.message }))
    } finally { setSending(false) }
  }
  const [expanded, setExpanded] = useState(false)
  const [inputDraft, setInputDraft] = useState(t.input)
  const [saving, setSaving] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [execResult, setExecResult] = useState<{ value: string; ok: boolean } | null>(null)

  const dirty = inputDraft !== t.input

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(t.id, { input: inputDraft })
    } finally {
      setSaving(false)
    }
  }

  const handleCancelEdit = () => {
    setInputDraft(t.input)
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

  const configPreview = (() => {
    try {
      const keys = Object.keys(parseConfig(t.config))
      return keys.length === 0 ? '{}' : `{ ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''} }`
    } catch { return t.config }
  })()

  return (
    <div className={cn(
      'bg-white rounded-xl border shadow-sm transition-colors',
      expanded ? 'border-blue-200' : 'border-slate-200 hover:border-slate-300'
    )}>
      {/* Header row */}
      <div className="flex items-start gap-3 p-4">
        <div className="min-w-0 flex-1">
          {/* The name is identity, as on the engine: it is set when the algorithm is created or
              duplicated, never edited in place. */}
          <p className="font-semibold text-slate-800 text-sm truncate mb-0.5">{t.name}</p>
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
            onClick={() => setDuplicating(true)}
            title={msg('saved.duplicate')}
            className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 text-slate-600 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors"
          >
            <Copy size={12} /> {msg('saved.duplicate')}
          </button>
          <button
            onClick={sendToEngine}
            disabled={sending}
            title={msg('saved.exportToEngine')}
            className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors disabled:opacity-50"
          >
            {sending ? <Loader2 size={12} className="animate-spin" /> : <CloudUpload size={12} />}
            {msg('saved.exportToEngine')}
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

      {duplicating && (
        <DuplicatePrompt
          suggested={`${t.name} (2)`}
          onCancel={() => setDuplicating(false)}
          onConfirm={async (name) => {
            await api.duplicateTest(t.id, name)
            setDuplicating(false)
            onDuplicated()
          }}
        />
      )}

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
