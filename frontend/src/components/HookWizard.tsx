import { useEffect, useMemo, useRef, useState } from 'react'
import { Wand2, X, ChevronLeft, ChevronRight, Check, Loader2, KeyRound, Info } from 'lucide-react'
import ScriptEditor from './ScriptEditor'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { dctFromSettings, refreshHooks } from '@/lib/hooks'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import {
  DB_KINDS, STEP_IDS, STEP_NEEDS, VDB_TOKENS, buildScript, credentialNames, defaultSchema, defaultSpec, effective,
  envNames, needsVdb, testVariables, vdbVariables, type DbKind, type RunTarget, type StepId, type WizardSpec,
} from '@/lib/hook-builder'
import type { Hook, HookShell, HookVariable, HookWizardOptions } from '@/types'

const SHELLS: HookShell[] = ['bash', 'shell', 'expect', 'ps', 'psd']
const PAGES = ['hook', 'vdb', 'actions', 'details', 'review'] as const
type Page = typeof PAGES[number]

const DB_LABEL: Record<DbKind, string> = {
  ORACLE: 'Oracle', MSSQL: 'SQL Server', POSTGRES: 'PostgreSQL', MYSQL: 'MySQL', MARIADB: 'MariaDB', DB2: 'DB2', SYBASE: 'Sybase',
}

/** What the wizard hands back: a whole hook, ready to save. */
export interface WizardResult {
  spec: WizardSpec
  name: string
  description: string
  shell: HookShell
  command: string
  credentials: string[]
  /** What a run on this machine needs: the variables the script reads and its credentials' parts. */
  variables: HookVariable[]
}

const isVar = (v: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v)

/**
 * Asks what a hook should do on a VDB, page by page, and writes it: the masking connection, the
 * rule set, the jobs, the collection, running them, refreshing the children, the log.
 */
export function HookWizard({ initial, initialName, onClose, onDone }: {
  /** The plan of a hook the wizard already wrote, to change it. */
  initial?: WizardSpec | null
  initialName?: string
  onClose: () => void
  onDone: (result: WizardResult) => Promise<void> | void
}) {
  const { t } = useT()
  const [spec, setSpec] = useState<WizardSpec | null>(initial ?? null)
  const [name, setName] = useState(initialName ?? '')
  const [page, setPage] = useState<Page>('hook')
  const [options, setOptions] = useState<HookWizardOptions | null>(null)
  const [busy, setBusy] = useState(false)
  const [tried, setTried] = useState(false)
  const [settingsKey, setSettingsKey] = useState(false)
  // The text field a token goes into: the last one focused, with where its caret was.
  const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)

  // The wizard opens at once; DCT's lists fill in when DCT answers, which may take seconds.
  useEffect(() => {
    // The DCT of the integration, from the settings — at once, before DCT itself answers.
    dctFromSettings().then(d => {
      setSettingsKey(Boolean(d.hasKey))
      if (!d.url) return
      const blank = defaultSpec('bash').dct.url
      setSpec(s => (s && (s.dct.url === blank || !s.dct.url.trim()) ? { ...s, dct: { ...s.dct, url: d.url!, insecure: d.insecure ?? s.dct.insecure } } : s))
    })
    if (!initial) {
      api.getHookRuntime().catch(() => null).then(runtime => {
        const native = runtime?.native ?? 'bash'
        setSpec(s => (s ? { ...s, shell: native } : defaultSpec(native)))
        dctFromSettings().then(d => { if (d.url) setSpec(s => (s && s.dct.url === defaultSpec('bash').dct.url ? { ...s, dct: { ...s.dct, url: d.url!, insecure: d.insecure ?? s.dct.insecure } } : s)) })
        setName(t('wizard.defaultName'))
      })
    }
    api.getHookWizardOptions().catch(() => null).then(opts => {
      setOptions(opts)
      if (initial || opts?.target !== 'dct') return
      const blank = defaultSpec('bash')
      setSpec(s => {
        const base = s ?? blank
        // Only what the user has not touched yet.
        const dct = base.dct.url === blank.dct.url ? { ...base.dct, url: opts.dctUrl, insecure: opts.insecure } : base.dct
        const policy = !base.discoveryJob.policy && opts.policies.length === 1 ? opts.policies[0].name : base.discoveryJob.policy
        return { ...base, dct, discoveryJob: { ...base.discoveryJob, policy } }
      })
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [busy, onClose])

  const eff = useMemo(() => (spec ? effective(spec) : null), [spec])
  const script = useMemo(() => (spec && page === 'review' ? buildScript(spec, name.trim() || t('wizard.defaultName')) : ''), [spec, page, name, t])

  if (!spec || !eff) {
    return (
      <Shell onClose={onClose} title={t(initial ? 'wizard.titleEdit' : 'wizard.title')}>
        <div className="flex items-center justify-center py-24 text-slate-400"><Loader2 className="animate-spin" size={20} /></div>
      </Shell>
    )
  }

  const up = <K extends keyof WizardSpec>(key: K, patch: Partial<WizardSpec[K]>) =>
    setSpec(s => (s ? { ...s, [key]: { ...(s[key] as object), ...patch } } : s))

  const problems = validate(page)
  const index = PAGES.indexOf(page)
  const go = (to: number) => {
    if (to > index && problems.length) { setTried(true); return }
    setTried(false)
    setPage(PAGES[Math.max(0, Math.min(PAGES.length - 1, to))])
  }

  function validate(p: Page): string[] {
    const s = eff!
    const out: string[] = []
    if (p === 'hook') {
      if (!name.trim()) out.push(t('wizard.err.name'))
      if (!/^https?:\/\/\S+$/i.test(s.dct.url.trim()) && !/^[\w.-]+(:\d+)?(\/\S*)?$/.test(s.dct.url.trim())) out.push(t('wizard.err.url'))
      if (!isVar(s.dct.keyCredential)) out.push(t('wizard.err.credential'))
    }
    if (p === 'vdb' && needsVdb(s) && s.vdb.find !== 'env' && !s.vdb.value.trim()) out.push(t('wizard.err.vdb'))
    if (p === 'actions' && !STEP_IDS.some(id => id !== 'log' && s[id].on)) out.push(t('wizard.err.noStep'))
    if (p === 'details') {
      const c = s.connector
      if (c.on) {
        if (!c.name.trim()) out.push(t('wizard.err.stepName', { step: t('wizard.step.connector') }))
        if (!isVar(c.credential)) out.push(t('wizard.err.credential'))
        if (!(s.vdb.db === 'ORACLE' && c.oracleMode === 'jdbc') && (!c.host.trim() || !c.port.trim())) out.push(t('wizard.err.hostPort'))
      }
      for (const id of ['ruleSet', 'discoveryJob', 'maskingJob', 'collection'] as const) {
        if (s[id].on && !s[id].name.trim()) out.push(t('wizard.err.stepName', { step: t(`wizard.step.${id}`) }))
      }
      if (s.discoveryJob.on && !s.discoveryJob.policy.trim()) out.push(t('wizard.err.policy'))
      for (const id of ['runDiscovery', 'runMasking', 'runCollection'] as const) {
        if (s[id].on && s[id].use === 'other' && !s[id].ref.trim()) out.push(t('wizard.err.ref', { step: t(`wizard.step.${id}`) }))
      }
      if (s.log.on && !s.log.path.trim()) out.push(t('wizard.err.log'))
    }
    return out
  }

  const finish = async () => {
    const all = PAGES.flatMap(p => validate(p))
    if (all.length) { setTried(true); return }
    setBusy(true)
    try {
      const title = name.trim()
      const steps = STEP_IDS.filter(id => eff[id].on).map(id => t(`wizard.step.${id}`).toLowerCase())
      await onDone({
        spec,
        name: title,
        description: t('wizard.description', { steps: steps.join(', '), credentials: credentialNames(spec).join(', ') }),
        shell: spec.shell,
        command: buildScript(spec, title),
        credentials: credentialNames(spec),
        variables: testVariables(spec, settingsKey),
      })
    } finally {
      setBusy(false)
    }
  }

  /** A [TOKEN] at the caret of the field focused last, through its own onChange. */
  const insertToken = (token: string) => {
    const el = field.current
    if (!el || !el.isConnected) { toast.info(t('wizard.tokenPickField')); return }
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? start
    const next = el.value.slice(0, start) + token + el.value.slice(end)
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, next)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.focus()
    const at = start + token.length
    requestAnimationFrame(() => { el.setSelectionRange(at, at) })
  }

  const needs = (id: StepId): StepId[] => (STEP_NEEDS[id] ?? []).filter(dep => !eff[dep].on)
  const toggle = (id: StepId) => up(id, { on: !eff[id].on } as Partial<WizardSpec[typeof id]>)

  return (
    <Shell onClose={busy ? () => {} : onClose} title={t(initial ? 'wizard.titleEdit' : 'wizard.title')}>
      {/* Where we are */}
      <div className="flex items-center gap-1 px-5 py-2.5 border-b border-slate-100 bg-slate-50 overflow-x-auto">
        {PAGES.map((p, i) => (
          <button key={p} onClick={() => go(i)} disabled={i > index && problems.length > 0}
                  className={cn('flex items-center gap-1.5 shrink-0 px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                    p === page ? 'bg-blue-600 text-white' : i < index ? 'text-blue-700 hover:bg-blue-50' : 'text-slate-400 hover:bg-slate-100')}>
            <span className={cn('flex items-center justify-center w-4 h-4 rounded-full text-[10px]',
              p === page ? 'bg-white/25' : i < index ? 'bg-blue-100' : 'bg-slate-200')}>
              {i < index ? <Check size={10} /> : i + 1}
            </span>
            {t(`wizard.page.${p}`)}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4" onFocusCapture={e => {
        const el = e.target
        if ((el instanceof HTMLInputElement && (el.type === 'text' || el.type === '') && !el.dataset.notokens) || el instanceof HTMLTextAreaElement) field.current = el
      }}>
        {page === 'hook' && (
          <>
            <Field label={t('wizard.name')}>
              <input value={name} maxLength={256} onChange={e => setName(e.target.value)} className={fieldCls} />
            </Field>
            <Field label={t('wizard.shell')} hint={spec.shell === 'expect' ? t('wizard.expectHint') : undefined}>
              <select value={spec.shell} onChange={e => setSpec({ ...spec, shell: e.target.value as HookShell })} className={fieldCls}>
                {SHELLS.map(s => <option key={s} value={s}>{t(`hook.shell.${s}`)}</option>)}
              </select>
            </Field>
            <Field label={t('wizard.dctUrl')} hint={options?.target === 'dct' ? t('wizard.dctFromSettings') : t('wizard.dctUrlHint')}>
              <input value={spec.dct.url} onChange={e => up('dct', { url: e.target.value })} placeholder="https://dct.example.com" className={fieldCls} />
            </Field>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={spec.dct.insecure} onChange={e => up('dct', { insecure: e.target.checked })} />
              {t('wizard.insecure')}
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label={t('wizard.keyCredential')} hint={t('wizard.keyCredentialHint', { name: spec.dct.keyCredential })}>
                <input value={spec.dct.keyCredential} onChange={e => up('dct', { keyCredential: e.target.value.toUpperCase() })} className={cn(fieldCls, 'font-mono')} />
              </Field>
              <Field label={t('wizard.timeout')} hint={t('wizard.timeoutHint')}>
                <input type="number" min={1} max={10080} value={spec.dct.timeoutMinutes}
                       onChange={e => up('dct', { timeoutMinutes: Math.max(1, Number(e.target.value) || 240) })} className={fieldCls} />
              </Field>
            </div>
          </>
        )}

        {page === 'vdb' && (
          <>
            <Field label={t('wizard.db')}>
              <select value={spec.vdb.db} onChange={e => up('vdb', { db: e.target.value as DbKind })} className={fieldCls}>
                {DB_KINDS.map(k => <option key={k} value={k}>{DB_LABEL[k]}</option>)}
              </select>
            </Field>
            <Field label={t('wizard.find')}>
              <div className="space-y-1.5">
                {(['env', 'name', 'id'] as const).map(mode => (
                  <label key={mode} className="flex items-start gap-2 text-sm text-slate-700">
                    <input type="radio" className="mt-1" checked={spec.vdb.find === mode} onChange={() => up('vdb', { find: mode })} />
                    <span>
                      {t(`wizard.find.${mode}`)}
                      {mode === 'env' && <span className="block text-xs text-slate-400">{t('wizard.find.envHint', { vars: vdbVariables(spec.vdb.db).join(', ') })}</span>}
                    </span>
                  </label>
                ))}
              </div>
            </Field>
            {spec.vdb.find !== 'env' && (
              <Field label={t(spec.vdb.find === 'name' ? 'wizard.find.nameValue' : 'wizard.find.idValue')} hint={t('wizard.tokensHint')}>
                <input value={spec.vdb.value} onChange={e => up('vdb', { value: e.target.value })} className={fieldCls} />
              </Field>
            )}
            <Note>{t('wizard.vdbNote')}</Note>
          </>
        )}

        {page === 'actions' && (
          <div className="space-y-1">
            {STEP_IDS.map(id => {
              const missing = needs(id)
              const noJob = id === 'collection' && !eff.discoveryJob.on && !eff.maskingJob.on
              const disabled = missing.length > 0 || noJob
              return (
                <label key={id} className={cn('flex items-start gap-3 rounded-lg px-3 py-2 border transition-colors',
                  eff[id].on ? 'border-blue-200 bg-blue-50/60' : 'border-transparent hover:bg-slate-50', disabled && 'opacity-50')}>
                  <input type="checkbox" className="mt-0.5" checked={eff[id].on} disabled={disabled} onChange={() => toggle(id)} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-slate-800">{t(`wizard.step.${id}`)}</span>
                    <span className="block text-xs text-slate-500">{t(`wizard.stepHint.${id}`)}</span>
                    {disabled && (
                      <span className="block text-xs text-amber-700 mt-0.5">
                        {noJob ? t('wizard.needsJob') : t('wizard.needs', { steps: missing.map(m => t(`wizard.step.${m}`)).join(', ') })}
                      </span>
                    )}
                  </span>
                </label>
              )
            })}
          </div>
        )}

        {page === 'details' && (
          <>
            <div className="sticky -top-4 z-10 -mx-5 -mt-4 px-5 pt-4 pb-2 bg-white">
              <div className="flex items-start gap-2 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 shadow-xs">
                <Info size={13} className="shrink-0 mt-0.5 text-slate-400" />
                <div className="min-w-0">
                  <div className="flex flex-wrap gap-1">
                    {[...VDB_TOKENS, 'TIMESTAMP'].map(x => (
                      <button key={x} type="button"
                              // Keeps the focus, and the caret, in the field.
                              onMouseDown={e => e.preventDefault()}
                              onClick={() => insertToken(`[${x}]`)}
                              title={t('wizard.tokenInsert')}
                              className="font-mono text-[11px] text-blue-700 hover:text-blue-900 hover:underline bg-white border border-slate-200 hover:border-blue-300 rounded px-1">
                        [{x}]
                      </button>
                    ))}
                  </div>
                  <p className="mt-1">{t('wizard.tokensHint')} {t('wizard.tokensClick')}</p>
                </div>
              </div>
            </div>
            {eff.connector.on && (
              <Section title={t('wizard.step.connector')}>
                <Field label={t('wizard.connector.name')}>
                  <input value={spec.connector.name} onChange={e => up('connector', { name: e.target.value })} className={fieldCls} />
                </Field>
                <Field label={t('wizard.connector.credential')} hint={t('wizard.connector.credentialHint', { name: spec.connector.credential })}>
                  <input value={spec.connector.credential} data-notokens="1" onChange={e => up('connector', { credential: e.target.value.toUpperCase() })} className={cn(fieldCls, 'font-mono')} />
                </Field>
                {spec.vdb.db === 'ORACLE' && (
                  <Field label={t('wizard.connector.oracleMode')}>
                    <select value={spec.connector.oracleMode} onChange={e => up('connector', { oracleMode: e.target.value as 'sid' | 'jdbc' })} className={fieldCls}>
                      <option value="sid">{t('wizard.connector.oracleSid')}</option>
                      <option value="jdbc">{t('wizard.connector.oracleJdbc')}</option>
                    </select>
                  </Field>
                )}
                {!(spec.vdb.db === 'ORACLE' && spec.connector.oracleMode === 'jdbc') && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Field label={t('wizard.connector.host')}>
                      <input value={spec.connector.host} onChange={e => up('connector', { host: e.target.value })} className={fieldCls} />
                    </Field>
                    <Field label={t('wizard.connector.port')} hint={spec.vdb.db === 'POSTGRES' || spec.vdb.db === 'MYSQL' || spec.vdb.db === 'MARIADB' ? t('wizard.connector.portHint') : undefined}>
                      <input value={spec.connector.port} onChange={e => up('connector', { port: e.target.value })} className={fieldCls} />
                    </Field>
                    {spec.vdb.db === 'ORACLE' ? (
                      <Field label={t('wizard.connector.sid')}>
                        <input value={spec.connector.sid} onChange={e => up('connector', { sid: e.target.value })} className={fieldCls} />
                      </Field>
                    ) : (
                      <Field label={t('wizard.connector.database')}>
                        <input value={spec.connector.database} onChange={e => up('connector', { database: e.target.value })} className={fieldCls} />
                      </Field>
                    )}
                    {spec.vdb.db === 'MSSQL' && (
                      <Field label={t('wizard.connector.instance')}>
                        <input value={spec.connector.instance} onChange={e => up('connector', { instance: e.target.value })} className={fieldCls} />
                      </Field>
                    )}
                  </div>
                )}
                <Field label={t('wizard.connector.schema')} hint={t('wizard.connector.schemaHint')}>
                  <input value={spec.connector.schema} placeholder={defaultSchema(spec.vdb.db, spec.connector.credential)}
                         onChange={e => up('connector', { schema: e.target.value })} className={fieldCls} />
                </Field>
                <Field label={t('wizard.connector.orchestrator')} hint={t('wizard.connector.orchestratorHint')}>
                  {options?.orchestrators.length ? (
                    <select value={spec.connector.orchestrator} onChange={e => up('connector', { orchestrator: e.target.value })} className={fieldCls}>
                      <option value="">{t('wizard.connector.orchestratorAuto')}</option>
                      {options.orchestrators.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                  ) : (
                    <input value={spec.connector.orchestrator} placeholder={t('wizard.connector.orchestratorAuto')}
                           onChange={e => up('connector', { orchestrator: e.target.value })} className={cn(fieldCls, 'font-mono')} />
                  )}
                </Field>
              </Section>
            )}
            {eff.waitReady.on && (
              <Section title={t('wizard.step.waitReady')}>
                <Field label={t('wizard.waitMinutes')}>
                  <input type="number" min={1} max={240} value={spec.waitReady.minutes}
                         onChange={e => up('waitReady', { minutes: Math.max(1, Number(e.target.value) || 15) })} className={cn(fieldCls, 'w-32')} />
                </Field>
              </Section>
            )}
            {eff.ruleSet.on && (
              <Section title={t('wizard.step.ruleSet')}>
                <Field label={t('wizard.objectName')} hint={t('wizard.ruleSetHint')}>
                  <input value={spec.ruleSet.name} onChange={e => up('ruleSet', { name: e.target.value })} className={fieldCls} />
                </Field>
              </Section>
            )}
            {eff.discoveryJob.on && (
              <Section title={t('wizard.step.discoveryJob')}>
                <Field label={t('wizard.objectName')}>
                  <input value={spec.discoveryJob.name} onChange={e => up('discoveryJob', { name: e.target.value })} className={fieldCls} />
                </Field>
                <Field label={t('wizard.policy')} hint={t('wizard.policyHint')}>
                  <input value={spec.discoveryJob.policy} list="wizard-policies" onChange={e => up('discoveryJob', { policy: e.target.value })} className={fieldCls} />
                  <datalist id="wizard-policies">
                    {options?.policies.map(p => <option key={p.id} value={p.name} />)}
                  </datalist>
                </Field>
              </Section>
            )}
            {eff.maskingJob.on && (
              <Section title={t('wizard.step.maskingJob')}>
                <Field label={t('wizard.objectName')}>
                  <input value={spec.maskingJob.name} onChange={e => up('maskingJob', { name: e.target.value })} className={fieldCls} />
                </Field>
              </Section>
            )}
            {eff.collection.on && (
              <Section title={t('wizard.step.collection')}>
                <Field label={t('wizard.objectName')} hint={t('wizard.collectionHint')}>
                  <input value={spec.collection.name} onChange={e => up('collection', { name: e.target.value })} className={fieldCls} />
                </Field>
                <Field label={t('wizard.failureHandling')}>
                  <select value={spec.collection.failureHandling}
                          onChange={e => up('collection', { failureHandling: e.target.value as WizardSpec['collection']['failureHandling'] })} className={fieldCls}>
                    {(['CANCEL_ALL', 'CANCEL_SUBSEQUENT', 'IGNORE'] as const).map(f => <option key={f} value={f}>{t(`wizard.failure.${f}`)}</option>)}
                  </select>
                </Field>
              </Section>
            )}
            {(['runDiscovery', 'runMasking', 'runCollection'] as const).filter(id => eff[id].on).map(id => (
              <Section key={id} title={t(`wizard.step.${id}`)}>
                <RunPicker
                  value={eff[id]}
                  canUseCreated={id === 'runDiscovery' ? eff.discoveryJob.on : id === 'runMasking' ? eff.maskingJob.on : eff.collection.on}
                  onChange={patch => up(id, patch)}
                />
              </Section>
            ))}
            {eff.refreshChildren.on && (
              <Section title={t('wizard.step.refreshChildren')}>
                <div className="space-y-1.5">
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input type="radio" checked={spec.refreshChildren.wait} onChange={() => up('refreshChildren', { wait: true })} />
                    {t('wizard.refresh.wait')}
                  </label>
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input type="radio" checked={!spec.refreshChildren.wait} onChange={() => up('refreshChildren', { wait: false })} />
                    {t('wizard.refresh.async')}
                  </label>
                  <label className="flex items-start gap-2 text-sm text-slate-700 pt-1">
                    <input type="checkbox" className="mt-0.5" checked={spec.refreshChildren.snapshotFirst} onChange={e => up('refreshChildren', { snapshotFirst: e.target.checked })} />
                    <span>{t('wizard.refresh.snapshotFirst')}<span className="block text-xs text-slate-400">{t('wizard.refresh.snapshotHint')}</span></span>
                  </label>
                </div>
              </Section>
            )}
            {eff.log.on && (
              <Section title={t('wizard.step.log')}>
                <Field label={t('wizard.log.path')} hint={t('wizard.log.hint')}>
                  <input value={spec.log.path} onChange={e => up('log', { path: e.target.value })} className={cn(fieldCls, 'font-mono')} />
                </Field>
              </Section>
            )}
          </>
        )}

        {page === 'review' && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                <p className="text-xs font-semibold text-amber-800 mb-1 flex items-center gap-1"><KeyRound size={12} />{t('wizard.review.credentials')}</p>
                <ul className="text-xs text-amber-900 space-y-0.5">
                  <li><span className="font-mono">{spec.dct.keyCredential}</span> — {t('wizard.review.keyCredential')}</li>
                  {eff.connector.on && <li><span className="font-mono">{spec.connector.credential}</span> — {t('wizard.review.dbCredential')}</li>}
                </ul>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs font-semibold text-slate-600 mb-1">{t('wizard.review.variables')}</p>
                <p className="text-xs text-slate-600 font-mono break-words">{envNames(spec).join(', ')}</p>
              </div>
            </div>
            <Note>{t('wizard.review.point')}</Note>
            <div className="h-[420px]">
              <ScriptEditor value={script} onChange={() => {}} readOnly fill
                            language={spec.shell === 'ps' || spec.shell === 'psd' ? 'powershell' : spec.shell === 'expect' ? 'expect' : 'bash'} />
            </div>
          </>
        )}

        {options?.error && page === 'hook' && <p className="text-xs text-amber-700">{t('wizard.optionsError', { error: options.error })}</p>}
      </div>

      <div className="flex items-center gap-3 px-5 py-3 border-t border-slate-200 bg-white">
        {tried && problems.length > 0 && (
          <ul className="flex-1 min-w-0 text-xs text-red-600 space-y-0.5">{problems.map(p => <li key={p}>{p}</li>)}</ul>
        )}
        <div className="flex items-center gap-2 ml-auto shrink-0">
          <button onClick={onClose} disabled={busy} className="px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 rounded-lg">{t('wizard.cancel')}</button>
          {index > 0 && (
            <button onClick={() => go(index - 1)} disabled={busy}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-lg">
              <ChevronLeft size={14} />{t('wizard.back')}
            </button>
          )}
          {page !== 'review' ? (
            <button onClick={() => go(index + 1)}
                    className="flex items-center gap-1 px-4 py-1.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              {t('wizard.next')}<ChevronRight size={14} />
            </button>
          ) : (
            <button onClick={finish} disabled={busy}
                    className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-60">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
              {t(initial ? 'wizard.apply' : 'wizard.create')}
            </button>
          )}
        </div>
      </div>
    </Shell>
  )
}

/** The wizard from the sidebar: what it writes is saved as a new hook, and opened. */
export function NewHookWizard({ onClose, onCreated }: { onClose: () => void; onCreated: (hook: Hook) => void }) {
  const { t } = useT()
  const create = async (r: WizardResult) => {
    try {
      const created = await api.createHook({
        name: r.name, description: r.description, shell: r.shell, command: r.command,
        credentials: r.credentials, variables: r.variables, template: JSON.stringify(r.spec),
      })
      await refreshHooks()
      toast.success(t('hook.created'))
      onCreated(created)
    } catch (e) {
      const err = e as Error & { code?: string }
      toast.error(err.code === 'name-taken' ? t('hook.nameTaken') : err.message)
    }
  }
  return <HookWizard onClose={onClose} onDone={create} />
}

function RunPicker({ value, canUseCreated, onChange }: {
  value: RunTarget
  canUseCreated: boolean
  onChange: (patch: Partial<RunTarget>) => void
}) {
  const { t } = useT()
  return (
    <div className="space-y-1.5">
      <label className={cn('flex items-center gap-2 text-sm text-slate-700', !canUseCreated && 'opacity-50')}>
        <input type="radio" disabled={!canUseCreated} checked={value.use === 'created'} onChange={() => onChange({ use: 'created' })} />
        {t('wizard.run.created')}
      </label>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="radio" checked={value.use === 'other'} onChange={() => onChange({ use: 'other' })} />
        {t('wizard.run.other')}
      </label>
      {value.use === 'other' && (
        <input value={value.ref} onChange={e => onChange({ ref: e.target.value })} placeholder={t('wizard.run.refPlaceholder')} className={fieldCls} />
      )}
    </div>
  )
}

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="flex flex-col w-full max-w-4xl max-h-[92vh] bg-white rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-slate-200">
          <Wand2 size={16} className="text-blue-600" />
          <h2 className="flex-1 text-sm font-semibold text-slate-800">{title}</h2>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 rounded"><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 p-4 space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      {children}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-xs text-slate-400 mt-1">{hint}</p>}
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
      <Info size={13} className="shrink-0 mt-0.5 text-slate-400" /><span>{children}</span>
    </p>
  )
}

const fieldCls = 'w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:border-transparent'
