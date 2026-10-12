import { useEffect, useRef, useState } from 'react'
import ScriptEditor from './ScriptEditor'
import {
  PanelLeftOpen, Save, Trash2, CloudUpload, Loader2, TerminalSquare, Play, Square, Download, Plus, X,
  Wand2, CornerDownLeft, KeyRound,
} from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useT, type MessageKey } from '@/lib/i18n'
import { refreshHooks, useHooks } from '@/lib/hooks'
import { CONTEXT_VARIABLES, HOOK_POINTS, HOOK_TEMPLATES, templateScript, variableSyntax } from '@/lib/hook-catalog'
import type { Hook, HookRuntime, HookShell } from '@/types'

const SHELLS: HookShell[] = ['bash', 'shell', 'expect', 'ps', 'psd']
const isPowerShell = (shell: HookShell) => shell === 'ps' || shell === 'psd'

/** One line of what a run printed. */
interface Line { stream: 'stdout' | 'stderr' | 'info'; text: string }

/**
 * A hook: a script Delphix runs at a point of a dataset's life, kept here with what it is for.
 *
 * The editor is three things side by side: the hook itself (what DCT keeps as a hook template —
 * name, description, shell, script, the credential variables it reads), a run on this machine
 * against test values, and what a script can read once Delphix runs it.
 */
export function HookEditor({ hook: opened, onToggleSidebar, onDeleted, onCreated }: {
  hook: Hook | null
  onToggleSidebar: () => void
  onDeleted: () => void
  onCreated: (created: Hook) => void
}) {
  const { t, locale } = useT()
  const { hooks } = useHooks()
  // The live row: sending sets delphix_origin server-side.
  const hook = opened ? (hooks.find(h => h.id === opened.id) ?? opened) : null
  const editing = hook !== null

  const [name, setName] = useState(hook?.name ?? '')
  const [description, setDescription] = useState(hook?.description ?? '')
  const [shell, setShell] = useState<HookShell>(hook?.shell ?? 'bash')
  const [command, setCommand] = useState(hook?.command ?? '')
  const [credentials, setCredentials] = useState<string[]>(hook?.credentials ?? [])
  const [newCredential, setNewCredential] = useState('')
  const [variables, setVariables] = useState<Array<{ name: string; value: string }>>(hook?.variables ?? [])
  // Credential values for a run: typed each time, never saved.
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [timeoutSec, setTimeoutSec] = useState(300)
  const [busy, setBusy] = useState(false)
  const [sending, setSending] = useState(false)
  const [runtime, setRuntime] = useState<HookRuntime | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ code: number | null; ms: number; timedOut: boolean } | null>(null)
  const runAbort = useRef<AbortController | null>(null)
  const editor = useRef<HTMLTextAreaElement>(null)
  const output = useRef<HTMLPreElement>(null)

  useEffect(() => {
    api.getHookRuntime().then(r => {
      setRuntime(r)
      // A new hook starts in what this system runs natively.
      if (!opened) setShell(r.native)
    }).catch(() => {})
    api.getConfig().then(c => {
      const cfg = c as unknown as Record<string, string>
      setTarget(cfg['delphix.baseUrl'] ? (cfg['delphix.target'] === 'dct' ? 'dct' : 'engine') : null)
    }).catch(() => {})
  }, [opened])

  // Stop a run still going when the editor goes away.
  useEffect(() => () => runAbort.current?.abort(), [])

  useEffect(() => {
    if (output.current) output.current.scrollTop = output.current.scrollHeight
  }, [lines])

  const dirty = !editing || name !== hook.name || description !== hook.description || shell !== hook.shell
    || command !== hook.command || JSON.stringify(credentials) !== JSON.stringify(hook.credentials)
    || JSON.stringify(variables) !== JSON.stringify(hook.variables)

  const save = async () => {
    setBusy(true)
    const body = { name: name.trim(), description, shell, command, credentials, variables: variables.filter(v => v.name.trim()) }
    try {
      if (editing) {
        await api.updateHook(hook.id, body)
        toast.success(t('hook.saved'))
        await refreshHooks()
      } else {
        const created = await api.createHook(body)
        toast.success(t('hook.created'))
        await refreshHooks()
        onCreated(created)
      }
    } catch (e) {
      const err = e as Error & { code?: string }
      toast.error(err.code === 'name-taken' ? t('hook.nameTaken') : err.code === 'name-required' ? t('hook.nameRequired') : err.message)
    } finally { setBusy(false) }
  }

  const remove = async () => {
    if (!editing || !confirm(t('hook.confirmDelete'))) return
    await api.deleteHook(hook.id)
    toast.success(t('hook.deleted'))
    await refreshHooks()
    onDeleted()
  }

  const send = async () => {
    if (!editing) return
    if (dirty) { toast.warning(t('hook.saveFirst')); return }
    setSending(true)
    try {
      const out = await api.delphixExportHook(hook.id)
      toast.success(t(out.mode === 'created' ? 'hook.exportCreated' : 'hook.exportUpdated', { name: out.name }))
      if (hook.credentials.length) toast.info(t('hook.exportCredentials', { names: hook.credentials.join(', ') }))
      await refreshHooks()
    } catch (e) {
      toast.error(t('saved.exportFailed', { error: (e as Error).message }))
    } finally { setSending(false) }
  }

  /** The script as a file, to try on another server. */
  const download = () => {
    const ps = isPowerShell(shell)
    const ext = ps ? 'ps1' : shell === 'expect' ? 'exp' : 'sh'
    const body = ps ? `${String.fromCharCode(0xFEFF)}${command.replace(/\r?\n/g, '\r\n')}` : command.replace(/\r\n/g, '\n')
    const base = (name.trim() || 'hook').replace(/[^A-Za-z0-9._-]+/g, '_')
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${base}.${ext}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const applyTemplate = (id: string) => {
    const template = HOOK_TEMPLATES.find(x => x.id === id)
    if (!template) return
    if (command.trim() && !confirm(t('hook.templateReplace'))) return
    const ps = runtime?.native === 'ps' || isPowerShell(shell)
    const nextShell: HookShell = ps ? 'ps' : 'bash'
    setShell(nextShell)
    setCommand(templateScript(template, nextShell))
    setDescription(template.description[locale])
    if (!name.trim()) setName(template.name[locale])
    setCredentials(template.credentials)
    setVariables(template.variables.map(v => ({ ...v })))
  }

  /** Swaps the script for the other language of the same ready-made hook, when it is one. */
  const changeShell = (next: HookShell) => {
    const template = HOOK_TEMPLATES.find(x => templateScript(x, shell) === command)
    setShell(next)
    if (template) setCommand(templateScript(template, next))
  }

  const insert = (text: string) => {
    const area = editor.current
    if (!area) { setCommand(c => c + text); return }
    const start = area.selectionStart
    const end = area.selectionEnd
    const next = command.slice(0, start) + text + command.slice(end)
    setCommand(next)
    requestAnimationFrame(() => {
      area.focus()
      area.selectionStart = area.selectionEnd = start + text.length
    })
  }

  const run = async () => {
    if (running) { runAbort.current?.abort(); return }
    const env = [
      ...variables.filter(v => v.name.trim()),
      ...credentials.flatMap(base => ['USER', 'PASSWORD'].map(part => ({ name: `${base}_${part}`, value: secrets[`${base}_${part}`] ?? '' })))
        .filter(v => v.value !== ''),
    ]
    const controller = new AbortController()
    runAbort.current = controller
    setLines([])
    setResult(null)
    setRunning(true)
    const push = (line: Line) => setLines(prev => [...prev, line])
    try {
      await api.runHook({ shell, command, env, timeoutSec }, {
        start: (p) => push({ stream: 'info', text: t('hook.runStarted', { interpreter: p.interpreter }) }),
        out: (p) => push({ stream: p.stream, text: p.text }),
        exit: (p) => setResult({ code: p.code, ms: p.ms, timedOut: p.timedOut }),
        error: (p) => push({
          stream: 'stderr',
          text: p.code === 'no-interpreter' ? t('hook.noInterpreter', { shell: t(`hook.shell.${p.shell as HookShell}`) }) : (p.message ?? p.code),
        }),
      }, controller.signal)
    } catch (e) {
      if (!controller.signal.aborted) push({ stream: 'stderr', text: (e as Error).message })
      else push({ stream: 'info', text: t('hook.runStopped') })
    } finally {
      setRunning(false)
      runAbort.current = null
    }
  }

  const unavailable = runtime && !runtime.shells[shell]
  const groups: Array<{ scope: typeof CONTEXT_VARIABLES[number]['scope']; key: MessageKey }> = [
    { scope: 'oracle', key: 'hook.ctx.oracle' }, { scope: 'oracleVdb', key: 'hook.ctx.oracleVdb' },
    { scope: 'sqlserver', key: 'hook.ctx.sqlserver' }, { scope: 'appdata', key: 'hook.ctx.appdata' },
    { scope: 'credential', key: 'hook.ctx.credential' },
  ]

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-200 bg-white shrink-0">
        <button onClick={onToggleSidebar} className="text-slate-400 hover:text-slate-600 transition-colors">
          <PanelLeftOpen size={18} />
        </button>
        <TerminalSquare size={16} className="text-slate-500 shrink-0" />
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-slate-800 truncate">{editing ? hook.name : t('hook.newTitle')}</h2>
          <p className="text-xs text-slate-400 truncate">
            {editing && hook.delphix_origin ? t('hook.fromDct') : t('hook.local')}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={download}
            disabled={!command.trim()}
            title={t('hook.downloadHint')}
            className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 text-slate-600 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors disabled:opacity-50"
          >
            <Download size={12} />
            <span className="hidden lg:inline">{t('hook.download')}</span>
          </button>
          {editing && (
            <>
              <button
                onClick={send}
                disabled={sending || target !== 'dct'}
                title={target === 'dct' ? undefined : t('hook.sendNeedsDct')}
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
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-5 bg-slate-50">
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 max-w-6xl">
          {/* The hook itself */}
          <div className="space-y-5 min-w-0">
            <div className="bg-white rounded-xl border border-slate-200 shadow-xs p-5 space-y-4">
              <div>
                <label className={labelCls}><Wand2 size={12} className="inline mr-1 -mt-0.5" />{t('hook.templates')}</label>
                <select value="" onChange={e => applyTemplate(e.target.value)} className={fieldCls}>
                  <option value="">{t('hook.templatePick')}</option>
                  {HOOK_TEMPLATES.map(x => <option key={x.id} value={x.id}>{x.name[locale]}</option>)}
                </select>
                <p className={hintCls}>{t('hook.templatesHint')}</p>
              </div>
              <div>
                <label className={labelCls}>{t('hook.name')}</label>
                <input type="text" value={name} maxLength={256} onChange={e => setName(e.target.value)}
                       placeholder={t('hook.namePlaceholder')} className={fieldCls} />
              </div>
              <div>
                <label className={labelCls}>{t('hook.description')}</label>
                <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3}
                          placeholder={t('hook.descriptionPlaceholder')} className={fieldCls} />
                <p className={hintCls}>{t('hook.descriptionHint')}</p>
              </div>
              <div>
                <label className={labelCls}>{t('hook.shellLabel')}</label>
                <select value={shell} onChange={e => changeShell(e.target.value as HookShell)} className={fieldCls}>
                  {SHELLS.map(s => <option key={s} value={s}>{t(`hook.shell.${s}`)}</option>)}
                </select>
                {unavailable && <p className="text-xs text-amber-700 mt-1">{t('hook.shellUnavailable')}</p>}
              </div>
              <div>
                <label className={labelCls}>{t('hook.command')}</label>
                <ScriptEditor
                  ref={editor}
                  value={command}
                  onChange={setCommand}
                  onKeyDown={e => {
                    if (e.key === 'Tab') { e.preventDefault(); insert('  ') }
                  }}
                  language={isPowerShell(shell) ? 'powershell' : shell === 'expect' ? 'expect' : 'bash'}
                  rows={20}
                />
              </div>
              <div>
                <label className={labelCls}><KeyRound size={12} className="inline mr-1 -mt-0.5" />{t('hook.credentials')}</label>
                <div className="flex flex-wrap gap-1.5">
                  {credentials.map(c => (
                    <span key={c} className="flex items-center gap-1 px-2 py-0.5 text-xs font-mono bg-slate-100 border border-slate-200 rounded">
                      {c}
                      <button onClick={() => setCredentials(credentials.filter(x => x !== c))} className="text-slate-400 hover:text-red-500"><X size={11} /></button>
                    </span>
                  ))}
                  <input
                    type="text" value={newCredential} onChange={e => setNewCredential(e.target.value.toUpperCase())}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && /^[A-Z_][A-Z0-9_]*$/.test(newCredential) && !credentials.includes(newCredential)) {
                        setCredentials([...credentials, newCredential]); setNewCredential('')
                      }
                    }}
                    placeholder={t('hook.credentialPlaceholder')}
                    className="px-2 py-0.5 text-xs font-mono border border-slate-200 rounded bg-slate-50 w-44"
                  />
                </div>
                <p className={hintCls}>{t('hook.credentialsHint')}</p>
              </div>
              <button
                onClick={save}
                disabled={busy || !name.trim() || (editing && !dirty)}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                {editing ? t('tester.saveChanges') : t('hook.create')}
              </button>
            </div>
          </div>

          {/* Trying it, and what it can read */}
          <div className="space-y-5 min-w-0">
            <div className="bg-white rounded-xl border border-slate-200 shadow-xs p-5 space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-800">{t('hook.test')}</h3>
                <p className={hintCls}>{t('hook.testHint')}</p>
              </div>
              <div className="space-y-1.5">
                {variables.map((v, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <input value={v.name} onChange={e => setVariables(variables.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                           placeholder="NAME" className={cn(smallField, 'w-48 font-mono')} />
                    <input value={v.value} onChange={e => setVariables(variables.map((x, j) => j === i ? { ...x, value: e.target.value } : x))}
                           placeholder={t('hook.value')} className={cn(smallField, 'flex-1')} />
                    <button onClick={() => setVariables(variables.filter((_, j) => j !== i))} className="p-1 text-slate-400 hover:text-red-500"><X size={13} /></button>
                  </div>
                ))}
                {credentials.flatMap(base => ['USER', 'PASSWORD'].map(part => `${base}_${part}`)).map(key => (
                  <div key={key} className="flex items-center gap-1.5">
                    <span className={cn(smallField, 'w-48 font-mono bg-amber-50 border-amber-200 flex items-center gap-1')}><KeyRound size={11} />{key}</span>
                    <input type="password" autoComplete="new-password" value={secrets[key] ?? ''}
                           onChange={e => setSecrets({ ...secrets, [key]: e.target.value })}
                           placeholder={t('hook.secretPlaceholder')} className={cn(smallField, 'flex-1')} />
                    <span className="w-6" />
                  </div>
                ))}
                <button onClick={() => setVariables([...variables, { name: '', value: '' }])}
                        className="flex items-center gap-1 text-xs text-blue-700 hover:underline">
                  <Plus size={12} /> {t('hook.addVariable')}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={run}
                  disabled={!command.trim() || Boolean(unavailable)}
                  className={cn('flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg transition-colors disabled:opacity-60',
                    running ? 'bg-red-600 hover:bg-red-700 text-white' : 'bg-emerald-600 hover:bg-emerald-700 text-white')}
                >
                  {running ? <><Square size={13} /> {t('hook.stop')}</> : <><Play size={13} /> {t('hook.run')}</>}
                </button>
                <label className="flex items-center gap-1.5 text-xs text-slate-500">
                  {t('hook.timeout')}
                  <input type="number" min={1} max={3600} value={timeoutSec}
                         onChange={e => setTimeoutSec(Math.max(1, Math.min(3600, Number(e.target.value) || 300)))}
                         className={cn(smallField, 'w-20')} />
                </label>
                {running && <Loader2 size={14} className="animate-spin text-slate-400" />}
              </div>
              {(lines.length > 0 || result) && (
                <div className="rounded-lg border border-slate-800 bg-slate-950 overflow-hidden">
                  <pre ref={output} className="max-h-80 overflow-auto p-3 text-xs leading-5 font-mono whitespace-pre-wrap break-words">
                    {lines.map((l, i) => (
                      <span key={i} className={l.stream === 'stderr' ? 'text-rose-300' : l.stream === 'info' ? 'text-sky-300 italic' : 'text-slate-100'}>
                        {l.stream === 'info' ? `${l.text}\n` : l.text}
                      </span>
                    ))}
                  </pre>
                  {result && (
                    <div className={cn('px-3 py-1.5 text-xs border-t border-slate-800',
                      result.code === 0 ? 'text-emerald-300' : 'text-rose-300')}>
                      {result.timedOut
                        ? t('hook.timedOut', { seconds: Math.round(result.ms / 1000) })
                        : t('hook.exited', { code: String(result.code), seconds: (result.ms / 1000).toFixed(1) })}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="bg-white rounded-xl border border-slate-200 shadow-xs p-5 space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-800">{t('hook.context')}</h3>
                <p className={hintCls}>{t('hook.contextHint')}</p>
              </div>
              {groups.map(g => (
                <div key={g.scope}>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">{t(g.key)}</p>
                  <ul className="space-y-0.5">
                    {CONTEXT_VARIABLES.filter(v => v.scope === g.scope).map(v => {
                      const insertable = !v.name.startsWith('<')
                      return (
                        <li key={v.name} className="flex items-start gap-2 text-xs">
                          <button
                            disabled={!insertable}
                            onClick={() => insert(variableSyntax(shell, v.name))}
                            title={insertable ? t('hook.insert') : undefined}
                            className={cn('shrink-0 flex items-center gap-1 font-mono px-1.5 py-0.5 rounded border',
                              insertable ? 'border-slate-200 bg-slate-50 hover:border-blue-300 hover:bg-blue-50 text-slate-700' : 'border-transparent text-slate-500 cursor-default')}
                          >
                            {insertable && <CornerDownLeft size={10} className="text-slate-400" />}{v.name}
                          </button>
                          <span className="text-slate-500 pt-0.5">{v.text[locale]}</span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
              <div className="text-xs text-slate-500 border-t border-slate-100 pt-3">
                <p className="font-semibold text-slate-600 mb-1">{t('hook.points')}</p>
                <p><span className="text-slate-400">dSource:</span> {HOOK_POINTS.dsource.join(' · ')}</p>
                <p><span className="text-slate-400">VDB:</span> {HOOK_POINTS.vdb.join(' · ')}</p>
                <p className="mt-1 text-slate-400">{t('hook.pointsHint')}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

const labelCls = 'block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5'
const hintCls = 'text-xs text-slate-400 mt-1'
const fieldCls = 'w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:border-transparent'
const smallField = 'rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-hidden focus:ring-1 focus:ring-blue-500'
