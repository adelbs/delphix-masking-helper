import { useEffect, useRef, useState } from 'react'
import ScriptEditor from './ScriptEditor'
import { HookWizard, type WizardResult } from './HookWizard'
import { HookAssistant } from './HookAssistant'
import {
  PanelLeftOpen, Save, Trash2, CloudUpload, Loader2, TerminalSquare, Play, Square, Download, Plus, X,
  Wand2, CornerDownLeft, KeyRound, Maximize2, Minimize2, Sparkles, Variable, Puzzle, FlaskConical, BookOpen, Copy,
} from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useT, type MessageKey } from '@/lib/i18n'
import { dctFromSettings, refreshHooks, useHooks } from '@/lib/hooks'
import { CONTEXT_VARIABLES, HOOK_POINTS, variableSyntax } from '@/lib/hook-catalog'
import { SNIPPET_IDS, buildScript, hasHelpers, parseSpec, snippet, snippetNeeds, testVariables, type SnippetId } from '@/lib/hook-builder'
import { syntaxExample, syntaxIds } from '@/lib/hook-syntax'
import type { Hook, HookRuntime, HookShell, HookVariable } from '@/types'

const SHELLS: HookShell[] = ['bash', 'shell', 'expect', 'ps', 'psd']
const isPowerShell = (shell: HookShell) => shell === 'ps' || shell === 'psd'
const languageOf = (shell: HookShell) => (isPowerShell(shell) ? 'powershell' : shell === 'expect' ? 'expect' : 'bash')

type Tab = 'ai' | 'context' | 'snippets' | 'syntax' | 'test'
const TABS: Array<{ id: Tab; icon: typeof Sparkles; key: MessageKey }> = [
  { id: 'ai', icon: Sparkles, key: 'hook.tab.ai' },
  { id: 'context', icon: Variable, key: 'hook.tab.context' },
  { id: 'snippets', icon: Puzzle, key: 'hook.tab.snippets' },
  { id: 'syntax', icon: BookOpen, key: 'hook.tab.syntax' },
  { id: 'test', icon: FlaskConical, key: 'hook.tab.test' },
]

/** Whether clicking a variable also adds it to the test values — remembered on this browser. */
const ADD_TEST_VAR = 'hook.addTestVariable'
const readFlag = () => { try { return localStorage.getItem(ADD_TEST_VAR) !== '0' } catch { return true } }

/** The test values as the server keeps them: named, and a key taken from the settings has no copy. */
const kept = (list: HookVariable[]) => list.filter(v => v.name.trim()).map(v => ({
  name: v.name.trim(), value: v.fromSettings ? '' : v.value, ...(v.secret ? { secret: true } : {}), ...(v.fromSettings ? { fromSettings: true } : {}),
}))

/** One line of what a run printed. */
interface Line { stream: 'stdout' | 'stderr' | 'info'; text: string }

/**
 * A hook: a script Delphix runs at a point of a dataset's life, kept here with what it is for.
 *
 * On the left, the hook itself — what DCT keeps as a hook template: name, description, shell,
 * script, the credential variables it reads. On the right, tabs that work on the script: the
 * assistant, what a hook can read, snippets that call DCT, and a run on this machine. The script
 * can take the whole window, with the tabs beside it.
 */
export function HookEditor({ hook: opened, onToggleSidebar, onDeleted, onCreated, onOpenSettings, initialTab }: {
  hook: Hook | null
  initialTab?: Tab
  onToggleSidebar: () => void
  onDeleted: () => void
  onCreated: (created: Hook) => void
  onOpenSettings?: () => void
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
  const [template, setTemplate] = useState<string | null>(hook?.template ?? null)
  const [credentials, setCredentials] = useState<string[]>(hook?.credentials ?? [])
  const [newCredential, setNewCredential] = useState('')
  // Test values for a run here, credentials' included: saved with the hook, never sent to DCT.
  const [variables, setVariables] = useState<HookVariable[]>(hook?.variables ?? [])
  const [addTestVar, setAddTestVar] = useState(readFlag)
  const [settingsKey, setSettingsKey] = useState(false)
  const [timeoutSec, setTimeoutSec] = useState(300)
  const [busy, setBusy] = useState(false)
  const [sending, setSending] = useState(false)
  const [runtime, setRuntime] = useState<HookRuntime | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const [dct, setDct] = useState<{ url?: string; insecure?: boolean }>({})
  const [lines, setLines] = useState<Line[]>([])
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ code: number | null; ms: number; timedOut: boolean } | null>(null)
  const [tab, setTab] = useState<Tab>(initialTab ?? 'ai')
  const [maximized, setMaximized] = useState(false)
  const [wizard, setWizard] = useState(false)
  const runAbort = useRef<AbortController | null>(null)
  const editor = useRef<HTMLTextAreaElement>(null)
  // Where the caret was last: clicking a button elsewhere takes the focus, not the position.
  const caret = useRef<{ start: number; end: number } | null>(null)
  const output = useRef<HTMLPreElement>(null)

  const spec = parseSpec(template)

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
    // The integration's DCT, from the settings: snippets and tips name it instead of an example host.
    dctFromSettings().then(d => { setSettingsKey(Boolean(d.hasKey)); if (d.url) setDct({ url: d.url, insecure: d.insecure }) })
  }, [opened])

  // Stop a run still going when the editor goes away.
  useEffect(() => () => runAbort.current?.abort(), [])

  useEffect(() => {
    if (output.current) output.current.scrollTop = output.current.scrollHeight
  }, [lines])

  useEffect(() => {
    if (!maximized) return
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !wizard) setMaximized(false) }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [maximized, wizard])

  const dirty = !editing || name !== hook.name || description !== hook.description || shell !== hook.shell
    || command !== hook.command || (template ?? null) !== (hook.template ?? null)
    || JSON.stringify(credentials) !== JSON.stringify(hook.credentials)
    || JSON.stringify(kept(variables)) !== JSON.stringify(kept(hook.variables))

  /** Saves what is on screen; true when it went through. */
  const save = async (): Promise<boolean> => {
    setBusy(true)
    const body = { name: name.trim(), description, shell, command, template, credentials, variables: kept(variables) }
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
      return true
    } catch (e) {
      const err = e as Error & { code?: string }
      toast.error(err.code === 'name-taken' ? t('hook.nameTaken') : err.code === 'name-required' ? t('hook.nameRequired') : err.message)
      return false
    } finally { setBusy(false) }
  }

  const remove = async () => {
    if (!editing || !confirm(t('hook.confirmDelete'))) return
    await api.deleteHook(hook.id)
    toast.success(t('hook.deleted'))
    await refreshHooks()
    onDeleted()
  }

  /** Sends the hook to DCT as a hook template, saving what changed first. */
  const send = async () => {
    if (!editing) return
    if (dirty && !(await save())) return
    setSending(true)
    try {
      const out = await api.delphixExportHook(hook.id)
      toast.success(t(out.mode === 'created' ? 'hook.exportCreated' : 'hook.exportUpdated', { name: out.name }))
      if (credentials.length) toast.info(t('hook.exportCredentials', { names: credentials.join(', ') }))
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

  /** A script the wizard wrote follows the shell: switching rewrites it in the other language. */
  const changeShell = (next: HookShell) => {
    if (spec && command === buildScript(spec, name.trim())) {
      const nextSpec = { ...spec, shell: next }
      setCommand(buildScript(nextSpec, name.trim()))
      setTemplate(JSON.stringify(nextSpec))
    }
    setShell(next)
  }

  const applyWizard = (r: WizardResult) => {
    setName(r.name)
    setDescription(r.description)
    setShell(r.shell)
    setCommand(r.command)
    setTemplate(JSON.stringify(r.spec))
    setCredentials(r.credentials)
    // Test values already typed for a variable the script still reads are kept, and so are the
    // ones added by hand.
    const next = r.variables.map(v => variables.find(x => x.name === v.name) ?? v)
    setVariables([...next, ...variables.filter(v => v.name.trim() && !next.some(x => x.name === v.name))])
    setWizard(false)
    setTab('test')
    toast.info(t('hook.wizardApplied'))
  }

  /** Puts text where the caret was last — or at the end, for a script never clicked into. */
  const insert = (text: string) => {
    const area = editor.current
    const at = caret.current ?? { start: command.length, end: command.length }
    const start = Math.min(at.start, command.length)
    const end = Math.min(at.end, command.length)
    const next = command.slice(0, start) + text + command.slice(end)
    const scroll = area?.scrollTop ?? 0
    setCommand(next)
    caret.current = { start: start + text.length, end: start + text.length }
    requestAnimationFrame(() => {
      if (!area) return
      area.focus()
      area.selectionStart = area.selectionEnd = start + text.length
      area.scrollTop = scroll
    })
  }

  /**
   * What an inserted snippet reads, made ready for a run here: its credentials on the hook, and
   * its test variables — those already there are left as they are.
   */
  const addNeeds = (text: string) => {
    const needs = snippetNeeds(text, shell, settingsKey)
    const newCredentials = needs.credentials.filter(c => !credentials.includes(c))
    const newVariables = needs.variables.filter(v => !variables.some(x => x.name === v.name))
    if (newCredentials.length) setCredentials(cs => [...cs, ...newCredentials.filter(c => !cs.includes(c))])
    if (newVariables.length) setVariables(vs => [...vs, ...newVariables.filter(v => !vs.some(x => x.name === v.name))])
    const names = [...newCredentials, ...newVariables.filter(v => !newCredentials.some(c => v.name.startsWith(`${c}_`))).map(v => v.name)]
    if (names.length) toast.info(t('hook.snippetNeedsAdded', { names: names.join(', ') }))
  }

  /** A snippet at the caret; the helpers it calls go on top first, when the script lacks them. */
  const insertSnippet = (id: SnippetId) => {
    // A block of its own: on a new line when the caret is in the middle of one.
    const where = Math.min(caret.current?.start ?? command.length, command.length)
    const code = (where > 0 && command[where - 1] !== '\n' ? '\n' : '') + snippet(id, shell, dct)
    if (id === 'helpers' || hasHelpers(command)) { insert(`${code}\n`); addNeeds(code); return }
    const helpers = `${snippet('helpers', shell, dct)}\n`
    addNeeds(helpers + code)
    // After the shebang and the comment lines that open the script.
    const lines = command.split('\n')
    let head = 0
    while (head < lines.length && (lines[head].startsWith('#!') || lines[head].startsWith('#') && !lines[head].startsWith('# ----'))) head++
    const pos = lines.slice(0, head).join('\n').length + (head ? 1 : 0)
    const at = caret.current ?? { start: command.length, end: command.length }
    const start = Math.min(at.start, command.length)
    const end = Math.min(at.end, command.length)
    let next = command.slice(0, start) + code + '\n' + command.slice(end)
    const shift = start >= pos ? helpers.length : 0
    next = next.slice(0, pos) + helpers + next.slice(pos)
    setCommand(next)
    caret.current = { start: start + shift + code.length + 1, end: start + shift + code.length + 1 }
    toast.info(t('hook.snippetHelpersAdded'))
  }

  const run = async () => {
    if (running) { runAbort.current?.abort(); return }
    // A credential's part left empty is left out, as Delphix sets only the parts a credential has.
    const env = kept(variables).filter(v => !credentialKeys.includes(v.name) || v.value !== '' || v.fromSettings)
    // The values tried are kept with the hook, for the next time it is opened.
    if (editing && JSON.stringify(kept(variables)) !== JSON.stringify(kept(hook.variables))) {
      api.updateHook(hook.id, { variables: kept(variables) }).then(() => refreshHooks()).catch(() => {})
    }
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

  /** A context variable at the caret, and among the test values when asked to and not there yet. */
  const insertVariable = (varName: string) => {
    insert(variableSyntax(shell, varName))
    if (addTestVar && !variables.some(v => v.name === varName)) {
      setVariables(vs => [...vs, { name: varName, value: '' }])
      toast.info(t('hook.testVariableAdded', { name: varName }))
    }
  }

  const credentialKeys = credentials.flatMap(base => [`${base}_USER`, `${base}_PASSWORD`])
  const setCredential = (key: string, patch: Partial<HookVariable>) => setVariables(vs => {
    const at = vs.findIndex(v => v.name === key)
    const base: HookVariable = at >= 0 ? vs[at] : { name: key, value: '', ...(key.endsWith('_PASSWORD') ? { secret: true } : {}) }
    const next = { ...base, ...patch }
    return at >= 0 ? vs.map((v, i) => (i === at ? next : v)) : [...vs, next]
  })
  const keyPassword = spec ? `${spec.dct.keyCredential}_PASSWORD` : null
  const dctHost = (text: string) => (dct.url ? text.replaceAll('https://dct.example.com', dct.url) : text)

  /** The wizard's test values, again: what the script reads, with what was typed kept. */
  const resetTestVariables = () => {
    if (!spec) return
    const want = testVariables(spec, settingsKey)
    setVariables([...want.map(v => variables.find(x => x.name === v.name) ?? v), ...variables.filter(v => !want.some(w => w.name === v.name))])
  }

  const unavailable = runtime && !runtime.shells[shell]
  const groups: Array<{ scope: typeof CONTEXT_VARIABLES[number]['scope']; key: MessageKey }> = [
    { scope: 'oracle', key: 'hook.ctx.oracle' }, { scope: 'oracleVdb', key: 'hook.ctx.oracleVdb' },
    { scope: 'sqlserver', key: 'hook.ctx.sqlserver' }, { scope: 'appdata', key: 'hook.ctx.appdata' },
    { scope: 'credential', key: 'hook.ctx.credential' },
  ]

  const scriptEditor = (
    <ScriptEditor
      ref={editor}
      value={command}
      onChange={setCommand}
      onSelect={(start, end) => { caret.current = { start, end } }}
      onKeyDown={e => {
        if (e.key === 'Tab') { e.preventDefault(); insert('  ') }
      }}
      language={languageOf(shell)}
      rows={maximized ? undefined : 22}
      fill={maximized}
    />
  )

  const tabs = (
    <div className={cn('bg-white rounded-xl border border-slate-200 shadow-xs flex flex-col min-h-0', maximized ? 'h-full' : 'min-h-[36rem]')}>
      <div className="flex border-b border-slate-200 px-2 shrink-0">
        {TABS.map(x => (
          <button key={x.id} onClick={() => setTab(x.id)}
                  className={cn('flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 -mb-px transition-colors',
                    tab === x.id ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-700')}>
            <x.icon size={13} />{t(x.key)}
          </button>
        ))}
      </div>
      <div className={cn('flex-1 min-h-0 p-4', tab === 'ai' ? 'flex flex-col' : 'overflow-y-auto')}>
        {tab === 'ai' && (
          <HookAssistant
            hook={{ name, description, shell, command, credentials }}
            onReplace={script => { setCommand(script); caret.current = null }}
            onInsert={insert}
            onOpenSettings={onOpenSettings}
          />
        )}

        {tab === 'context' && (
          <div className="space-y-3">
            <p className={hintCls}>{t('hook.contextHint')}</p>
            <label className="flex items-start gap-2 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
              <input type="checkbox" className="mt-0.5" checked={addTestVar} onChange={e => {
                setAddTestVar(e.target.checked)
                try { localStorage.setItem(ADD_TEST_VAR, e.target.checked ? '1' : '0') } catch { /* private window */ }
              }} />
              <span>{t('hook.addTestVariable')}<span className="block text-slate-400">{t('hook.addTestVariableHint')}</span></span>
            </label>
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
                          // Keeps the focus — and the selection — in the script.
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => insertVariable(v.name)}
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
        )}

        {tab === 'snippets' && (
          <div className="space-y-2">
            <p className={hintCls}>{t('hook.snippetsHint')}</p>
            {shell === 'expect' && <p className="text-xs text-amber-700">{t('hook.snippetsExpect')}</p>}
            {SNIPPET_IDS.map(id => (
              <details key={id} className="group rounded-lg border border-slate-200">
                <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer list-none">
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs font-medium text-slate-800">{t(`hook.snippet.${id}`)}</span>
                    <span className="block text-[11px] text-slate-400">{t(`hook.snippetHint.${id}`)}</span>
                  </span>
                  <button
                    onMouseDown={e => e.preventDefault()}
                    onClick={e => { e.preventDefault(); insertSnippet(id) }}
                    className="shrink-0 flex items-center gap-1 text-[11px] font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded px-2 py-0.5"
                  >
                    <CornerDownLeft size={10} />{t('hook.insert')}
                  </button>
                </summary>
                <pre className="max-h-64 overflow-auto border-t border-slate-100 bg-slate-950 text-slate-100 p-2.5 text-[11px] leading-4 font-mono whitespace-pre">
                  {snippet(id, shell, dct)}
                </pre>
              </details>
            ))}
          </div>
        )}

        {tab === 'syntax' && (
          <div className="space-y-2">
            <p className={hintCls}>{t('hook.syntaxHint', { shell: t(`hook.shell.${shell}`) })}</p>
            {shell === 'psd' && <p className="text-xs text-slate-500">{t('hook.syntaxPsd')}</p>}
            {syntaxIds(shell).map(id => {
              const code = dctHost(syntaxExample(shell, id))
              return (
                <details key={`${shell}:${id}`} className="group rounded-lg border border-slate-200">
                  <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer list-none">
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs font-medium text-slate-800">{t(`hook.syntax.${id}`)}</span>
                      <span className="block text-[11px] text-slate-400">{t(`hook.syntaxHint.${id}`)}</span>
                    </span>
                    <button
                      onMouseDown={e => e.preventDefault()}
                      onClick={e => { e.preventDefault(); void navigator.clipboard?.writeText(code).then(() => toast.success(t('hook.copied'))) }}
                      title={t('hook.copy')}
                      className="shrink-0 p-1 text-slate-400 hover:text-slate-700 rounded"
                    ><Copy size={12} /></button>
                    <button
                      onMouseDown={e => e.preventDefault()}
                      onClick={e => {
                        e.preventDefault()
                        const where = Math.min(caret.current?.start ?? command.length, command.length)
                        insert((where > 0 && command[where - 1] !== '\n' ? '\n' : '') + code + '\n')
                      }}
                      className="shrink-0 flex items-center gap-1 text-[11px] font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded px-2 py-0.5"
                    >
                      <CornerDownLeft size={10} />{t('hook.insert')}
                    </button>
                  </summary>
                  <pre className="max-h-64 overflow-auto border-t border-slate-100 bg-slate-950 text-slate-100 p-2.5 text-[11px] leading-4 font-mono whitespace-pre">{code}</pre>
                </details>
              )
            })}
          </div>
        )}

        {tab === 'test' && (
          <div className="space-y-4">
            <p className={hintCls}>{t('hook.testHint')}</p>
            <div className="space-y-1.5">
              {variables.map((v, i) => credentialKeys.includes(v.name) ? null : (
                <div key={i} className="flex items-center gap-1.5">
                  <input value={v.name} onChange={e => setVariables(variables.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                         placeholder="NAME" className={cn(smallField, 'w-48 font-mono')} />
                  <input value={v.value} type={v.secret ? 'password' : 'text'} autoComplete="off"
                         onChange={e => setVariables(variables.map((x, j) => j === i ? { ...x, value: e.target.value } : x))}
                         placeholder={t('hook.value')} className={cn(smallField, 'flex-1')} />
                  <button onClick={() => setVariables(variables.filter((_, j) => j !== i))} className="p-1 text-slate-400 hover:text-red-500"><X size={13} /></button>
                </div>
              ))}
              {credentialKeys.map(key => {
                const v = variables.find(x => x.name === key)
                const fromSettings = Boolean(v?.fromSettings)
                const offerSettings = key === keyPassword || (key.endsWith('_PASSWORD') && fromSettings)
                return (
                  <div key={key} className="space-y-0.5">
                    <div className="flex items-center gap-1.5">
                      <span className={cn(smallField, 'w-48 font-mono bg-amber-50 border-amber-200 flex items-center gap-1 truncate')}><KeyRound size={11} className="shrink-0" />{key}</span>
                      <input type={key.endsWith('_USER') ? 'text' : 'password'} autoComplete="new-password" value={fromSettings ? '' : (v?.value ?? '')}
                             disabled={fromSettings}
                             onChange={e => setCredential(key, { value: e.target.value })}
                             placeholder={fromSettings ? t('hook.keyFromSettingsOn') : t('hook.secretPlaceholder')}
                             className={cn(smallField, 'flex-1 disabled:opacity-60')} />
                      <span className="w-6" />
                    </div>
                    {offerSettings && (
                      <label className={cn('flex items-center gap-1.5 text-[11px] ml-1', settingsKey ? 'text-slate-500' : 'text-slate-300')}>
                        <input type="checkbox" checked={fromSettings} disabled={!settingsKey && !fromSettings}
                               onChange={e => setCredential(key, { fromSettings: e.target.checked || undefined, value: '' })} />
                        {t('hook.keyFromSettings')}
                      </label>
                    )}
                  </div>
                )
              })}
              <div className="flex items-center gap-3">
                <button onClick={() => setVariables([...variables, { name: '', value: '' }])}
                        className="flex items-center gap-1 text-xs text-blue-700 hover:underline">
                  <Plus size={12} /> {t('hook.addVariable')}
                </button>
                {spec && (
                  <button onClick={resetTestVariables} title={t('hook.testFromWizardHint')}
                          className="flex items-center gap-1 text-xs text-violet-700 hover:underline">
                    <Wand2 size={12} /> {t('hook.testFromWizard')}
                  </button>
                )}
              </div>
              <p className="text-[11px] text-slate-400">{t('hook.testSaved')}</p>
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
            {unavailable && <p className="text-xs text-amber-700">{t('hook.shellUnavailable')}</p>}
            {(lines.length > 0 || result) && (
              <div className="rounded-lg border border-slate-800 bg-slate-950 overflow-hidden">
                <pre ref={output} className="max-h-96 overflow-auto p-3 text-xs leading-5 font-mono whitespace-pre-wrap break-words">
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
        )}
      </div>
    </div>
  )

  const saveButton = (
    <button
      onClick={() => { void save() }}
      disabled={busy || !name.trim() || (editing && !dirty)}
      className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
      {editing ? t('tester.saveChanges') : t('hook.create')}
    </button>
  )

  const wizardModal = wizard && (
    <HookWizard
      initial={spec}
      initialName={name}
      onClose={() => setWizard(false)}
      onDone={applyWizard}
    />
  )

  if (maximized) {
    return (
      <div className="fixed inset-0 z-40 flex flex-col bg-slate-50">
        <div className="flex items-center gap-3 px-5 py-2.5 border-b border-slate-200 bg-white shrink-0">
          <TerminalSquare size={16} className="text-slate-500 shrink-0" />
          <h2 className="flex-1 min-w-0 text-sm font-semibold text-slate-800 truncate">{name.trim() || t('hook.newTitle')}</h2>
          <select value={shell} onChange={e => changeShell(e.target.value as HookShell)} className={cn(smallField, 'w-48')}>
            {SHELLS.map(s => <option key={s} value={s}>{t(`hook.shell.${s}`)}</option>)}
          </select>
          {saveButton}
          <button onClick={() => setMaximized(false)} title={t('hook.restore')}
                  className="flex items-center gap-1 text-xs font-medium px-2.5 py-2 text-slate-600 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg">
            <Minimize2 size={13} />{t('hook.restore')}
          </button>
        </div>
        <div className="flex-1 min-h-0 flex gap-4 p-4">
          <div className="flex-1 min-w-0 min-h-0">{scriptEditor}</div>
          <div className="w-[32rem] max-w-[45%] shrink-0 min-h-0">{tabs}</div>
        </div>
        {wizardModal}
      </div>
    )
  }

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
            {spec && ` · ${t('hook.byWizard')}`}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {spec && (
            <button
              onClick={() => setWizard(true)}
              title={t('hook.reopenWizardHint')}
              className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 text-violet-700 bg-violet-50 hover:bg-violet-100 border border-violet-200 rounded-lg transition-colors"
            >
              <Wand2 size={12} />
              <span className="hidden lg:inline">{t('hook.reopenWizard')}</span>
            </button>
          )}
          <button
            onClick={download}
            disabled={!command.trim()}
            title={t('hook.downloadHint')}
            className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 text-slate-600 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors disabled:opacity-50"
          >
            <Download size={12} />
            <span className="hidden lg:inline">{t('hook.download')}</span>
          </button>
          <button
            onClick={send}
            disabled={sending || busy || !editing || target !== 'dct'}
            title={target !== 'dct' ? t('hook.sendNeedsDct') : !editing ? t('hook.sendNeedsSave') : t('hook.sendHint')}
            className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors disabled:opacity-50"
          >
            {sending ? <Loader2 size={12} className="animate-spin" /> : <CloudUpload size={12} />}
            <span className="hidden lg:inline">{t('hook.sendDct')}</span>
          </button>
          {editing && (
            <button
              onClick={remove}
              title={t('saved.delete')}
              className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-5 bg-slate-50">
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 max-w-7xl">
          {/* The hook itself */}
          <div className="space-y-5 min-w-0">
            <div className="bg-white rounded-xl border border-slate-200 shadow-xs p-5 space-y-4">
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
                {spec && <p className={hintCls}>{t('hook.shellFollows')}</p>}
              </div>
              <div>
                <div className="flex items-center mb-1.5">
                  <label className={cn(labelCls, 'mb-0 flex-1')}>{t('hook.command')}</label>
                  <button onClick={() => setMaximized(true)} title={t('hook.maximize')}
                          className="flex items-center gap-1 text-xs text-slate-500 hover:text-blue-700 px-1.5 py-0.5 rounded hover:bg-blue-50">
                    <Maximize2 size={12} />{t('hook.maximize')}
                  </button>
                </div>
                {scriptEditor}
                {!command.trim() && !spec && (
                  <p className={hintCls}>{t('hook.emptyScript')}</p>
                )}
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
              {saveButton}
            </div>
          </div>

          {/* What works on the script */}
          <div className="min-w-0">{tabs}</div>
        </div>
      </div>
      {wizardModal}
    </div>
  )
}

const labelCls = 'block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5'
const hintCls = 'text-xs text-slate-400 mt-1'
const fieldCls = 'w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:border-transparent'
const smallField = 'rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-hidden focus:ring-1 focus:ring-blue-500'
