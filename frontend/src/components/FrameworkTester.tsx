import { useState, useEffect, useCallback } from 'react'
import { Play, Code2, Zap, Save, Copy, Check, PanelLeftOpen, Plus, Trash2, RotateCcw, FlaskConical, BookOpen, AlertTriangle, CloudUpload, Loader2, FilePlus2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { getFrameworkMetadata, nonDeterminismKey } from '@/lib/framework-metadata'
import { useT, type I18n } from '@/lib/i18n'
import { ConfigForm } from './ConfigForm'
import { DuplicatePrompt } from './DuplicatePrompt'
import { useAlgorithms, refreshAlgorithms } from '@/lib/algorithms'
import { announceExport } from '@/lib/engine-sync'
import { forgetEngineReferences } from '@/lib/references'
import { FrameworkDoc } from './FrameworkDoc'
import { cn } from '@/lib/utils'
import type { Algorithm, Framework, JsonSchema, JsonSchemaProperty } from '@/types'

/** Recursively finds all AlgorithmInstanceReference {name} values in a config object. */
function collectAlgoRefNames(val: unknown): string[] {
  if (!val || typeof val !== 'object') return []
  if (Array.isArray(val)) return val.flatMap(collectAlgoRefNames)
  const obj = val as Record<string, unknown>
  const keys = Object.keys(obj)
  if (
    keys.includes('name') &&
    typeof obj.name === 'string' &&
    obj.name.length > 0 &&
    keys.every(k => k === 'name' || k === 'algorithmMetadata')
  ) {
    return [obj.name as string]
  }
  return Object.values(obj).flatMap(collectAlgoRefNames)
}

function parseConfig(raw: string): Record<string, unknown> {
  try {
    const first = JSON.parse(raw)
    if (typeof first === 'string') return JSON.parse(first)
    return first as Record<string, unknown>
  } catch { return {} }
}

interface Props {
  framework: Framework
  /** Set when a saved algorithm was opened: the panel edits that row instead of creating one. */
  algorithm?: Algorithm | null
  initialConfig?: Record<string, unknown>
  initialInput?: string
  onToggleSidebar: () => void
  /** The open algorithm no longer exists — the caller has to leave this screen. */
  onDeleted: () => void
}

export function FrameworkTester({ framework, algorithm, initialConfig, initialInput, onToggleSidebar, onDeleted }: Props) {
  const { t, tx, locale } = useT()
  const meta = getFrameworkMetadata(framework.className, locale)
  const [tab, setTab] = useState<'test' | 'doc'>('test')
  const [schema, setSchema] = useState<JsonSchema | null>(null)
  const [schemaLoading, setSchemaLoading] = useState(true)
  const [config, setConfig] = useState<Record<string, unknown>>(initialConfig ?? {})
  const [rawMode, setRawMode] = useState(false)
  const [rawJson, setRawJson] = useState(JSON.stringify(initialConfig ?? {}, null, 2))
  const [input, setInput] = useState(initialInput ?? '')
  const [output, setOutput] = useState<{ value: string; ok: boolean } | null>(null)
  const [masking, setMasking] = useState(false)
  const [algoName, setAlgoName] = useState('')
  // Only shown while editing: "save as new" is the escape hatch from update-in-place.
  const [savingAsNew, setSavingAsNew] = useState(false)
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  const [copied, setCopied] = useState(false)

  // Batch mode state (for frameworks like Shuffle)
  const [batchRows, setBatchRows] = useState<string[]>(() => meta?.example?.batchRows ?? [''])
  const [batchResults, setBatchResults] = useState<Array<{ output?: string; error?: string } | null>>([])
  const [batchMasking, setBatchMasking] = useState(false)

  const [maskMode, setMaskMode] = useState<'MASK' | 'REIDENTIFY'>('MASK')
  const { algorithms: savedAlgorithms } = useAlgorithms()

  // Multi-column mode state
  const [mcColumns, setMcColumns] = useState<Array<{ name: string; type: string; value: string }>>([
    { name: 'key', type: 'STRING', value: '' },
    { name: 'string1', type: 'STRING', value: '' },
  ])
  const [mcResult, setMcResult] = useState<Record<string, string | null> | null>(null)
  const [mcError, setMcError] = useState<string | null>(null)
  const [mcMasking, setMcMasking] = useState(false)
  const [mcAddName, setMcAddName] = useState('')

  // No reset effect here on purpose. App.tsx keys this component by the open algorithm's id
  // (falling back to the class), so picking a different one remounts and the useState
  // initialisers above already carry initialConfig/initialInput. Keying by class alone was not
  // enough once the sidebar could switch between two algorithms built on the same framework:
  // the key never changed, nothing remounted, and the second one opened showing the first's
  // configuration under the second's name.

  // Re-fetched on a locale change so the field labels and hints follow the language. The flag
  // starts true and is only ever cleared: re-raising it here would blank a schema that is
  // already on screen just to re-label it.
  useEffect(() => {
    api.getSchema(framework.className)
      .then((data) => {
        const enriched = enrichSchema(data.schema, framework.className, locale)
        setSchema(enriched)
        // Seed enum fields that are absent from config to their first option,
        // so the displayed dropdown value and the actual config are always in sync.
        if (enriched.properties && !initialConfig) {
          setConfig(prev => {
            const filled = { ...prev }
            for (const [k, p] of Object.entries(enriched.properties!)) {
              if (p.enum && filled[k] === undefined) filled[k] = p.enum[0]
            }
            setRawJson(JSON.stringify(filled, null, 2))
            return filled
          })
        }
      })
      .catch(() => setSchema(null))
      .finally(() => setSchemaLoading(false))
  }, [framework.className, locale]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep raw JSON in sync when config changes (form → raw)
  const handleConfigChange = useCallback((newConfig: Record<string, unknown>) => {
    setConfig(newConfig)
    if (!rawMode) setRawJson(JSON.stringify(newConfig, null, 2))
  }, [rawMode])

  const toggleRaw = () => {
    if (!rawMode) {
      setRawJson(JSON.stringify(config, null, 2))
    } else {
      try {
        const parsed = JSON.parse(rawJson)
        setConfig(parsed)
      } catch {
        toast.error(t('tester.invalidJson'))
        return
      }
    }
    setRawMode(!rawMode)
  }

  const getEffectiveConfig = (): Record<string, unknown> => {
    if (rawMode) {
      try { return JSON.parse(rawJson) } catch { return {} }
    }
    return config
  }

  // Recomputed on every render: editing ivLength or hashMethod flips the warning live.
  const nonDetKey = nonDeterminismKey(framework.className, getEffectiveConfig())

  const loadExample = async () => {
    if (!meta?.example) return
    const { config: exCfg, input: exInput, sampleFiles, columns: exColumns, batchRows: exRows } = meta.example
    const cfg = structuredClone(exCfg) as Record<string, unknown>

    if (sampleFiles && Object.keys(sampleFiles).length > 0) {
      try {
        await Promise.all(
          Object.entries(sampleFiles).map(async ([fieldPath, fileName]) => {
            const { uri } = await api.ensureSampleFile(fileName)
            const parts = fieldPath.split('.')
            // Navigate to the parent object and set .uri on it
            let node = cfg as Record<string, unknown>
            for (const part of parts.slice(0, -1)) {
              node = node[part] as Record<string, unknown>
            }
            const last = parts[parts.length - 1]
            node[last] = { ...(node[last] as object ?? {}), uri }
          })
        )
      } catch {
        toast.error(t('tester.sampleFileError'))
        return
      }
    }

    setConfig(cfg)
    setRawJson(JSON.stringify(cfg, null, 2))
    if (exInput !== undefined) setInput(exInput)
    if (exColumns) setMcColumns(exColumns)
    if (exRows) setBatchRows(exRows)
    toast.success(t('tester.exampleLoaded'))
  }

  const executeMask = async () => {
    setMasking(true)
    setOutput(null)
    try {
      const effectiveConfig = getEffectiveConfig()
      const refNames = collectAlgoRefNames(effectiveConfig)
      const additionalAlgorithms = savedAlgorithms
        .filter(t => refNames.includes(t.name))
        .map(a => ({ name: a.name, className: a.framework, config: parseConfig(a.config) }))
      const result = await api.mask({ framework: framework.className, config: effectiveConfig, input, mode: maskMode, additionalAlgorithms })
      if (result.output !== undefined) {
        setOutput({ value: result.output, ok: true })
      } else {
        setOutput({ value: result.error ?? t('tester.unknownError'), ok: false })
      }
    } catch (e) {
      setOutput({ value: (e as Error).message, ok: false })
    } finally {
      setMasking(false)
    }
  }

  const executeMultiColumn = async () => {
    setMcMasking(true)
    setMcResult(null)
    setMcError(null)
    try {
      const result = await api.maskMultiColumn({
        framework: framework.className,
        config: getEffectiveConfig(),
        columns: mcColumns.map(c => ({ name: c.name, value: c.value || null, type: c.type })),
      })
      if (result.columns) {
        setMcResult(result.columns)
      } else {
        setMcError(result.error ?? t('tester.unknownError'))
      }
    } catch (e) {
      setMcError((e as Error).message)
    } finally {
      setMcMasking(false)
    }
  }

  const executeBatch = async () => {
    const nonEmpty = batchRows.filter(r => r.trim())
    if (nonEmpty.length < 2) { toast.warning(t('tester.batchMinValues')); return }
    setBatchMasking(true)
    setBatchResults([])
    try {
      const result = await api.maskBatch({ framework: framework.className, config: getEffectiveConfig(), inputs: batchRows })
      setBatchResults(result.results)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBatchMasking(false)
    }
  }

  const copyOutput = async () => {
    if (!output) return
    await navigator.clipboard.writeText(output.value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  /** Creates a new algorithm from what is on screen. Always needs a name. */
  const saveAsNew = async () => {
    if (!algoName.trim()) { toast.warning(t('tester.algoNameRequired')); return }
    try {
      await api.saveAlgorithm({
        name: algoName.trim(),
        framework: framework.className,
        display_name: framework.displayName,
        config: JSON.stringify(getEffectiveConfig()),
        input,
        output: output?.ok ? output.value : null,
      })
      toast.success(t('tester.algoSaved'))
      setAlgoName('')
      setSavingAsNew(false)
      await refreshAlgorithms()
    } catch {
      toast.error(t('tester.algoSaveError'))
    }
  }

  /**
   * Writes back to the algorithm that is open. The name is never sent: on the engine it is
   * identity and cannot be changed, and the tool follows the same rule — a new name means a
   * copy, which is what "save as new" and Duplicate are for.
   */
  const saveChanges = async () => {
    if (!algorithm) return
    setSaving(true)
    try {
      await api.updateAlgorithm(algorithm.id, {
        config: JSON.stringify(getEffectiveConfig()),
        input,
        output: output?.ok ? output.value : '',
      })
      toast.success(t('tester.algoUpdated'))
      await refreshAlgorithms()
    } catch {
      toast.error(t('tester.algoSaveError'))
    } finally {
      setSaving(false)
    }
  }

  /** Sends the open algorithm to the configured engine — updating it there when it came from
   *  that same engine, which is what delphix_origin/delphix_name record. */
  const sendToEngine = async () => {
    if (!algorithm) return
    setSending(true)
    try {
      const out = await api.delphixExport(algorithm.id)
      toast.success(t(out.mode === 'updated' ? 'saved.exportUpdated' : 'saved.exportCreated',
        { name: out.name }))
      if (out.renamed) toast.warning(t('saved.exportRenamed', { name: out.name }))
      announceExport(t, out)
      forgetEngineReferences()
      await refreshAlgorithms()
    } catch (e) {
      const err = e as Error & { code?: string }
      toast.error(err.code === 'not-configured'
        ? t('saved.engineNotSet')
        : t('saved.exportFailed', { error: err.message }))
    } finally {
      setSending(false)
    }
  }

  const deleteAlgorithm = async () => {
    if (!algorithm) return
    if (!confirm(t('saved.confirmDelete'))) return
    try {
      await api.deleteAlgorithm(algorithm.id)
      toast.success(t('saved.deleted'))
      await refreshAlgorithms()
      onDeleted()
    } catch {
      toast.error(t('tester.unknownError'))
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-200 bg-white flex-shrink-0">
        <button onClick={onToggleSidebar} className="text-slate-400 hover:text-slate-600 transition-colors">
          <PanelLeftOpen size={18} />
        </button>
        <div className="flex-1 min-w-0">
          {/* Editing an algorithm, its name leads and the framework becomes the subtitle: the
              name is what was picked in the sidebar and what the engine knows it by. */}
          <h2 className="text-sm font-semibold text-slate-800 truncate">
            {algorithm ? algorithm.name : framework.displayName}
          </h2>
          <p className="text-xs text-slate-400 truncate">
            {algorithm
              ? <>{framework.displayName} <span className="font-mono">· {framework.className}</span></>
              : <span className="font-mono">{framework.className}</span>}
          </p>
        </div>

        {algorithm && (
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button
              onClick={() => setDuplicating(v => !v)}
              title={t('saved.duplicate')}
              className={headerBtn}
            >
              <Copy size={12} /> <span className="hidden lg:inline">{t('saved.duplicate')}</span>
            </button>
            <button
              onClick={sendToEngine}
              disabled={sending}
              title={t('saved.exportToEngine')}
              className={cn(headerBtn, 'text-blue-700 bg-blue-50 hover:bg-blue-100 border-blue-200')}
            >
              {sending ? <Loader2 size={12} className="animate-spin" /> : <CloudUpload size={12} />}
              <span className="hidden lg:inline">{t('saved.exportToEngine')}</span>
            </button>
            <button
              onClick={deleteAlgorithm}
              title={t('saved.delete')}
              className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>

      {duplicating && algorithm && (
        <div className="px-5 py-3 border-b border-slate-200 bg-white flex-shrink-0">
          <DuplicatePrompt
            suggested={`${algorithm.name} (2)`}
            onCancel={() => setDuplicating(false)}
            onConfirm={async (name) => {
              await api.duplicateAlgorithm(algorithm.id, name)
              setDuplicating(false)
              await refreshAlgorithms()
            }}
          />
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 px-5 border-b border-slate-200 bg-white flex-shrink-0">
        {([
          { id: 'test', label: t('tester.tabTest'), Icon: FlaskConical },
          { id: 'doc', label: t('tester.tabDoc'), Icon: BookOpen },
        ] as const).map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            aria-current={tab === id}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === id
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            )}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {tab === 'doc' ? (
        <div className="flex-1 overflow-auto p-5 bg-slate-50">
          <FrameworkDoc className={framework.className} />
        </div>
      ) : (
      <>
      {/* Info bar */}
      {meta && (
        <div className="px-5 py-3 bg-blue-50 border-b border-blue-100 flex-shrink-0">
          <p className="text-sm text-blue-800">{meta.description}</p>
          {meta.inputFormat && (
            <p className="text-xs text-blue-600 mt-1">
              <span className="font-medium">{t('tester.format')}</span>{meta.inputFormat}
            </p>
          )}
        </div>
      )}

      {/* Non-determinism warning — depends on the current configuration, so it appears
          and disappears as the user edits the parameter that controls it. */}
      {nonDetKey && (
        <div className="px-5 py-2.5 bg-amber-50 border-b border-amber-200 flex items-start gap-2 flex-shrink-0">
          <AlertTriangle size={15} className="text-amber-600 flex-shrink-0 mt-px" />
          <p className="text-xs text-amber-900">
            <span className="font-semibold">{t('tester.nonDeterministic')}. </span>
            {t(nonDetKey)}
          </p>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-auto p-5">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 h-full">

          {/* Config card */}
          <div className="bg-white rounded-xl border border-slate-200 flex flex-col shadow-sm">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
              <span className="text-sm font-semibold text-slate-700">{t('tester.configuration')}</span>
              <div className="flex items-center gap-2">
                {/* A saved algorithm already has its configuration: loading the example would
                    silently overwrite it, and saving afterwards would keep the example. */}
                {meta?.example && !algorithm && (
                  <button onClick={loadExample} className={btnSm + ' text-amber-700 bg-amber-50 hover:bg-amber-100 border-amber-200'}>
                    <Zap size={12} /> {t('tester.example')}
                  </button>
                )}
                <button
                  onClick={toggleRaw}
                  className={cn(btnSm, rawMode ? 'text-blue-700 bg-blue-50 border-blue-200' : 'text-slate-500 bg-slate-50 hover:bg-slate-100 border-slate-200')}
                  title={t('tester.editJson')}
                >
                  <Code2 size={12} /> {rawMode ? t('tester.form') : t('tester.json')}
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {schemaLoading ? (
                <div className="flex items-center gap-2 text-sm text-slate-400">
                  <div className="w-4 h-4 rounded-full border-2 border-slate-300 border-t-blue-500 animate-spin" />
                  {t('tester.loadingSchema')}
                </div>
              ) : rawMode ? (
                <textarea
                  value={rawJson}
                  onChange={(e) => setRawJson(e.target.value)}
                  rows={14}
                  className="w-full font-mono text-xs bg-slate-50 border border-slate-200 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                  placeholder="{}"
                />
              ) : (
                <ConfigForm schema={schema} values={config} onChange={handleConfigChange} />
              )}
            </div>
          </div>

          {/* Execution card */}
          <div className="bg-white rounded-xl border border-slate-200 flex flex-col shadow-sm">
            <div className="px-4 py-3 border-b border-slate-100">
              <span className="text-sm font-semibold text-slate-700">{t('tester.execution')}</span>
            </div>
            <div className="flex-1 overflow-auto p-4 flex flex-col gap-4">

              {meta?.multiColumnMode ? (
                /* ── Multi-column mode (GenericDataRow frameworks like MultiColumnCondition) ── */
                <>
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{t('tester.rowColumns')}</label>
                      <div className="flex items-center gap-1.5">
                        <select
                          value={mcAddName}
                          onChange={e => setMcAddName(e.target.value)}
                          className="text-xs border border-slate-200 rounded-md px-2 py-1 bg-white text-slate-600 focus:outline-none focus:ring-1 focus:ring-blue-400"
                        >
                          <option value="">{t('tester.selectColumn')}</option>
                          {MC_COL_OPTIONS.filter(o => !mcColumns.some(c => c.name === o.name)).map(o => (
                            <option key={o.name} value={o.name}>{o.name} ({o.type})</option>
                          ))}
                        </select>
                        <button
                          onClick={() => {
                            const opt = MC_COL_OPTIONS.find(o => o.name === mcAddName)
                            if (!opt || mcColumns.some(c => c.name === opt.name)) return
                            setMcColumns(cols => [...cols, { name: opt.name, type: opt.type, value: '' }])
                            setMcAddName('')
                          }}
                          disabled={!mcAddName}
                          className="flex items-center gap-1 text-xs font-medium px-2 py-1 text-blue-600 border border-blue-200 bg-blue-50 hover:bg-blue-100 rounded-md disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          <Plus size={12} /> {t('tester.addColumn')}
                        </button>
                      </div>
                    </div>

                    <div className="rounded-lg border border-slate-200 overflow-hidden">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200">
                            <th className="text-left px-3 py-2 text-xs font-semibold text-slate-500 w-28">{t('tester.column')}</th>
                            <th className="text-left px-3 py-2 text-xs font-semibold text-slate-500 w-24">{t('tester.type')}</th>
                            <th className="text-left px-3 py-2 text-xs font-semibold text-slate-500">{t('tester.value')}</th>
                            <th className="w-8" />
                          </tr>
                        </thead>
                        <tbody>
                          {mcColumns.map((col, i) => (
                            <tr key={col.name} className="border-b border-slate-100 last:border-0">
                              <td className="px-3 py-1.5 font-mono text-xs text-slate-700 font-semibold">{col.name}</td>
                              <td className="px-2 py-1">
                                <select
                                  value={col.type}
                                  onChange={e => setMcColumns(cols => cols.map((c, j) => j === i ? { ...c, type: e.target.value } : c))}
                                  className="text-xs border border-slate-200 rounded px-1.5 py-0.5 bg-white text-slate-600 focus:outline-none"
                                >
                                  <option value="STRING">STRING</option>
                                  <option value="NUMERIC">NUMERIC</option>
                                  <option value="DATE">DATE</option>
                                </select>
                              </td>
                              <td className="px-2 py-1">
                                <input
                                  value={col.value}
                                  onChange={e => setMcColumns(cols => cols.map((c, j) => j === i ? { ...c, value: e.target.value } : c))}
                                  className="w-full text-sm font-mono bg-transparent border-0 outline-none focus:ring-1 focus:ring-blue-400 rounded px-1 py-0.5"
                                  placeholder={col.type === 'DATE' ? '2024-01-15T00:00:00' : col.type === 'NUMERIC' ? '0' : t('tester.valuePlaceholder')}
                                />
                              </td>
                              <td className="px-2 py-1">
                                {mcColumns.length > 1 && (
                                  <button
                                    onClick={() => setMcColumns(cols => cols.filter((_, j) => j !== i))}
                                    className="text-slate-300 hover:text-red-400 transition-colors"
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-xs text-slate-400 mt-1.5">
                      {tx('tester.mcHint', {
                        key: <code className="bg-slate-100 px-1 rounded">key</code>,
                        strings: <code className="bg-slate-100 px-1 rounded">string1…string10</code>,
                        numerics: <code className="bg-slate-100 px-1 rounded">numeric1…3</code>,
                        dates: <code className="bg-slate-100 px-1 rounded">date1…3</code>,
                      })}
                    </p>
                  </div>

                  <button
                    onClick={executeMultiColumn}
                    disabled={mcMasking}
                    className="flex items-center justify-center gap-2 w-full py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  >
                    {mcMasking ? (
                      <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                    ) : (
                      <Play size={14} fill="currentColor" />
                    )}
                    {mcMasking ? t('tester.maskingRow') : t('tester.maskRow')}
                  </button>

                  {/* Multi-column result */}
                  {(mcResult || mcError) && (
                    <div>
                      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">{t('tester.result')}</label>
                      {mcError ? (
                        <div className="rounded-lg px-3 py-2.5 text-sm font-mono bg-red-50 text-red-800 border border-red-200 break-all">
                          {mcError}
                        </div>
                      ) : (
                        <div className="rounded-lg border border-green-200 overflow-hidden">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="bg-green-50 border-b border-green-200">
                                <th className="text-left px-3 py-2 text-xs font-semibold text-slate-500 w-28">{t('tester.column')}</th>
                                <th className="text-left px-3 py-2 text-xs font-semibold text-slate-500">{t('tester.original')}</th>
                                <th className="text-left px-3 py-2 text-xs font-semibold text-slate-500">{t('tester.masked')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {mcColumns.map(col => {
                                const masked = mcResult![col.name]
                                const changed = masked !== col.value
                                return (
                                  <tr key={col.name} className="border-b border-green-100 last:border-0">
                                    <td className="px-3 py-1.5 font-mono text-xs text-slate-600 font-semibold">{col.name}</td>
                                    <td className="px-3 py-1.5 font-mono text-xs text-slate-500">{col.value || <span className="italic text-slate-300">{t('tester.emptyValue')}</span>}</td>
                                    <td className={cn('px-3 py-1.5 font-mono text-sm font-semibold', changed ? 'text-green-700' : 'text-slate-400')}>
                                      {masked ?? <span className="italic font-normal text-slate-300">null</span>}
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  <SaveBar
                    editing={!!algorithm}
                    name={algoName}
                    onName={setAlgoName}
                    savingAsNew={savingAsNew}
                    onSavingAsNew={setSavingAsNew}
                    saving={saving}
                    onSaveChanges={saveChanges}
                    onSaveAsNew={saveAsNew}
                  />
                </>
              ) : meta?.batchMode ? (
                /* ── Batch mode (Shuffle) ── */
                <>
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{t('tester.batchValues')}</label>
                      <button
                        onClick={() => setBatchRows(r => [...r, ''])}
                        className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 transition-colors"
                      >
                        <Plus size={12} /> {t('tester.addRow')}
                      </button>
                    </div>
                    <div className="rounded-lg border border-slate-200 overflow-hidden">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200">
                            <th className="text-left px-3 py-2 text-xs font-semibold text-slate-500 w-8">#</th>
                            <th className="text-left px-3 py-2 text-xs font-semibold text-slate-500">{t('tester.originalValue')}</th>
                            <th className="text-left px-3 py-2 text-xs font-semibold text-slate-500">{t('tester.result')}</th>
                            <th className="w-8" />
                          </tr>
                        </thead>
                        <tbody>
                          {batchRows.map((row, i) => {
                            const res = batchResults[i]
                            return (
                              <tr key={i} className="border-b border-slate-100 last:border-0">
                                <td className="px-3 py-1.5 text-xs text-slate-400 font-mono">{i + 1}</td>
                                <td className="px-2 py-1">
                                  <input
                                    value={row}
                                    onChange={e => setBatchRows(rows => rows.map((r, j) => j === i ? e.target.value : r))}
                                    className="w-full text-sm font-mono bg-transparent border-0 outline-none focus:ring-1 focus:ring-blue-400 rounded px-1 py-0.5"
                                    placeholder={t('tester.valuePlaceholder')}
                                  />
                                </td>
                                <td className="px-3 py-1.5">
                                  {res ? (
                                    res.error
                                      ? <span className="text-xs text-red-600 font-mono">{res.error}</span>
                                      : <span className="text-sm font-mono text-green-700">{res.output}</span>
                                  ) : (
                                    <span className="text-xs text-slate-300 italic">—</span>
                                  )}
                                </td>
                                <td className="px-2 py-1">
                                  {batchRows.length > 1 && (
                                    <button
                                      onClick={() => {
                                        setBatchRows(r => r.filter((_, j) => j !== i))
                                        setBatchResults(r => r.filter((_, j) => j !== i))
                                      }}
                                      className="text-slate-300 hover:text-red-400 transition-colors"
                                    >
                                      <Trash2 size={12} />
                                    </button>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-xs text-slate-400 mt-1.5">
                      {t('tester.batchHint')}
                    </p>
                  </div>

                  <button
                    onClick={executeBatch}
                    disabled={batchMasking}
                    className="flex items-center justify-center gap-2 w-full py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  >
                    {batchMasking ? (
                      <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                    ) : (
                      <Play size={14} fill="currentColor" />
                    )}
                    {batchMasking ? t('tester.shuffling') : t('tester.shuffleBatch')}
                  </button>
                </>
              ) : (
                /* ── Single-value mode ── */
                <>
                  {/* Mode toggle — only for reversible frameworks */}
                  {meta?.reversible && (
                    <div className="flex rounded-lg border border-slate-200 overflow-hidden text-sm font-medium">
                      <button
                        onClick={() => { setMaskMode('MASK'); setOutput(null) }}
                        className={cn(
                          'flex-1 py-1.5 transition-colors',
                          maskMode === 'MASK'
                            ? 'bg-blue-600 text-white'
                            : 'bg-white text-slate-500 hover:bg-slate-50'
                        )}
                      >
                        {t('tester.tokenize')}
                      </button>
                      <button
                        onClick={() => { setMaskMode('REIDENTIFY'); setOutput(null) }}
                        className={cn(
                          'flex-1 py-1.5 transition-colors',
                          maskMode === 'REIDENTIFY'
                            ? 'bg-amber-500 text-white'
                            : 'bg-white text-slate-500 hover:bg-slate-50'
                        )}
                      >
                        <RotateCcw size={12} className="inline mr-1" />
                        {t('tester.detokenize')}
                      </button>
                    </div>
                  )}

                  {/* Input */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                      {maskMode === 'REIDENTIFY' ? t('tester.inputToken') : t('tester.inputValue')}
                    </label>
                    <textarea
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      rows={3}
                      placeholder={maskMode === 'REIDENTIFY' ? t('tester.tokenPlaceholder') : t('tester.inputPlaceholder')}
                      className={cn(fieldInput, 'resize-none font-mono')}
                    />
                  </div>

                  {/* Execute button */}
                  <button
                    onClick={executeMask}
                    disabled={masking}
                    className={cn(
                      'flex items-center justify-center gap-2 w-full py-2.5 text-white text-sm font-semibold rounded-lg disabled:opacity-60 disabled:cursor-not-allowed transition-colors',
                      maskMode === 'REIDENTIFY'
                        ? 'bg-amber-500 hover:bg-amber-600'
                        : 'bg-blue-600 hover:bg-blue-700'
                    )}
                  >
                    {masking ? (
                      <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                    ) : maskMode === 'REIDENTIFY' ? (
                      <RotateCcw size={14} />
                    ) : (
                      <Play size={14} fill="currentColor" />
                    )}
                    {masking
                      ? (maskMode === 'REIDENTIFY' ? t('tester.detokenizing') : t('tester.masking'))
                      : (maskMode === 'REIDENTIFY' ? t('tester.detokenize') : t('tester.mask'))}
                  </button>

                  {/* Output */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
                        {maskMode === 'REIDENTIFY' ? t('tester.originalValueLabel') : t('tester.result')}
                      </label>
                      {output && (
                        <button onClick={copyOutput} className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 transition-colors">
                          {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                          {copied ? t('tester.copied') : t('tester.copy')}
                        </button>
                      )}
                    </div>
                    <div className={cn(
                      'min-h-[72px] rounded-lg px-3 py-2.5 text-sm font-mono break-all',
                      output
                        ? output.ok
                          ? maskMode === 'REIDENTIFY'
                            ? 'bg-amber-50 text-amber-800 border border-amber-200'
                            : 'bg-green-50 text-green-800 border border-green-200'
                          : 'bg-red-50 text-red-800 border border-red-200'
                        : 'bg-slate-50 text-slate-400 border border-slate-100 italic flex items-center'
                    )}>
                      {output ? output.value : t('tester.awaiting')}
                    </div>
                  </div>

                  <SaveBar
                    editing={!!algorithm}
                    name={algoName}
                    onName={setAlgoName}
                    savingAsNew={savingAsNew}
                    onSavingAsNew={setSavingAsNew}
                    saving={saving}
                    onSaveChanges={saveChanges}
                    onSaveAsNew={saveAsNew}
                  />
                </>
              )}

            </div>
          </div>
        </div>
      </div>
      </>
      )}
    </div>
  )
}

/** Recursively navigates a property schema following dot-path parts.
 *  Arrays auto-descend into `items` without requiring an explicit path segment. */
function enrichProp(
  prop: JsonSchemaProperty,
  parts: string[],
  description?: string,
  title?: string,
): JsonSchemaProperty {
  if (parts.length === 0) {
    return {
      ...prop,
      ...(description && !prop.description ? { description } : {}),
      ...(title ? { title } : {}),
    }
  }
  // Auto-descend into array items
  if (prop.type === 'array' && prop.items) {
    return { ...prop, items: enrichProp(prop.items, parts, description, title) }
  }
  const [head, ...rest] = parts
  if (prop.properties?.[head]) {
    return {
      ...prop,
      properties: { ...prop.properties, [head]: enrichProp(prop.properties[head], rest, description, title) },
    }
  }
  return prop
}

function enrichSchema(schema: JsonSchema, className: string, locale: I18n['locale']): JsonSchema {
  const meta = getFrameworkMetadata(className, locale)
  if (!schema?.properties || (!meta?.params && !meta?.labels)) return schema
  const enriched: JsonSchema = { ...schema, properties: { ...schema.properties } }

  for (const [path, desc] of Object.entries(meta?.params ?? {})) {
    const [root, ...rest] = path.split('.')
    if (!enriched.properties![root]) continue
    enriched.properties![root] = enrichProp(enriched.properties![root], rest, desc, undefined)
  }
  for (const [path, title] of Object.entries(meta?.labels ?? {})) {
    const [root, ...rest] = path.split('.')
    if (!enriched.properties![root]) continue
    enriched.properties![root] = enrichProp(enriched.properties![root], rest, undefined, title)
  }
  return enriched
}

const headerBtn = 'flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 text-slate-600 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors disabled:opacity-50'

/**
 * The save controls, in both layouts the tester has.
 *
 * Two shapes, because saving means two different things here. With an algorithm open the
 * button writes back to it and there is no name field — the name is identity and the engine
 * refuses to change it, so the tool does not offer to either. Creating a new one is still
 * reachable, behind "save as new", which is the only path that asks for a name.
 */
function SaveBar({ editing, name, onName, savingAsNew, onSavingAsNew, saving, onSaveChanges, onSaveAsNew }: {
  editing: boolean
  name: string
  onName: (v: string) => void
  savingAsNew: boolean
  onSavingAsNew: (v: boolean) => void
  saving: boolean
  onSaveChanges: () => void
  onSaveAsNew: () => void
}) {
  const { t } = useT()

  if (!editing || savingAsNew) {
    return (
      <div className="mt-auto pt-2 border-t border-slate-100 space-y-1.5">
        <div className="flex gap-2">
          <input
            type="text"
            autoFocus={savingAsNew}
            value={name}
            onChange={(e) => onName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSaveAsNew()
              if (e.key === 'Escape' && savingAsNew) onSavingAsNew(false)
            }}
            placeholder={t('tester.algoNamePlaceholder')}
            className={cn(fieldInput, 'flex-1')}
          />
          <button
            onClick={onSaveAsNew}
            title={t('tester.saveAsNew')}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-green-700 bg-green-50 hover:bg-green-100 border border-green-200 rounded-lg transition-colors"
          >
            <Save size={14} />
          </button>
        </div>
        {savingAsNew && (
          <button
            onClick={() => onSavingAsNew(false)}
            className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
          >
            {t('tester.cancel')}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 mt-auto pt-2 border-t border-slate-100">
      <button
        onClick={onSaveChanges}
        disabled={saving}
        className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-green-700 bg-green-50 hover:bg-green-100 border border-green-200 rounded-lg transition-colors disabled:opacity-60"
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
        {saving ? t('tester.saving') : t('tester.saveChanges')}
      </button>
      <button
        onClick={() => onSavingAsNew(true)}
        className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-600 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors"
      >
        <FilePlus2 size={14} /> {t('tester.saveAsNew')}
      </button>
    </div>
  )
}

/** Available column slots for GenericDataRow-based frameworks (MultiColumnCondition etc.). */
const MC_COL_OPTIONS: Array<{ name: string; type: 'STRING' | 'NUMERIC' | 'DATE' }> = [
  { name: 'key', type: 'STRING' },
  ...Array.from({ length: 10 }, (_, i) => ({ name: `string${i + 1}`, type: 'STRING' as const })),
  ...Array.from({ length: 3 }, (_, i) => ({ name: `numeric${i + 1}`, type: 'NUMERIC' as const })),
  ...Array.from({ length: 3 }, (_, i) => ({ name: `date${i + 1}`, type: 'DATE' as const })),
]

const btnSm = 'flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-md border transition-colors'
const fieldInput = 'w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow'
