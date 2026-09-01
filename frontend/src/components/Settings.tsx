import { useState, useEffect, useRef } from 'react'
import { PanelLeftOpen, Save, Plus, Upload, Pencil, Trash2, X, Check, RefreshCw, CheckCircle2, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import type { AiStatus, ServerFile } from '@/types'

interface Props {
  filesDir: string
  onSave: (filesDir: string) => void
  onToggleSidebar: () => void
}

type Tab = 'general' | 'ai' | 'files'

export function Settings({ filesDir, onSave, onToggleSidebar }: Props) {
  const { t } = useT()
  const [tab, setTab] = useState<Tab>('general')

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-200 bg-white flex-shrink-0">
        <button onClick={onToggleSidebar} className="text-slate-400 hover:text-slate-600 transition-colors md:hidden">
          <PanelLeftOpen size={18} />
        </button>
        <h2 className="text-sm font-semibold text-slate-800">{t('settings.title')}</h2>
      </div>

      <div className="flex gap-1 px-5 pt-4 flex-shrink-0 border-b border-slate-200 bg-white">
        {(['general', 'ai', 'files'] as Tab[]).map(id => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === id
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            )}
          >
            {t(`settings.tab.${id}`)}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto p-5">
        {tab === 'general' && (
          <GeneralTab filesDir={filesDir} onSave={onSave} />
        )}
        {tab === 'ai' && (
          <AiTab />
        )}
        {tab === 'files' && (
          <FilesTab />
        )}
      </div>
    </div>
  )
}

function GeneralTab({ filesDir, onSave }: Omit<Props, 'onToggleSidebar'>) {
  const { t } = useT()
  const [localDir, setLocalDir] = useState(filesDir)
  const [saving, setSaving] = useState(false)

  useEffect(() => { setLocalDir(filesDir) }, [filesDir])

  const save = async () => {
    setSaving(true)
    try {
      await api.updateConfig({ filesDir: localDir })
      onSave(localDir)
      toast.success(t('settings.saved'))
    } catch {
      toast.error(t('settings.saveError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-lg space-y-5">
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
        <div>
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
            {t('settings.filesDir')}
          </label>
          <input
            type="text"
            value={localDir}
            onChange={e => setLocalDir(e.target.value)}
            placeholder={t('settings.filesDirPlaceholder')}
            className={fieldCls}
          />
          <p className="text-xs text-slate-400 mt-1">{t('settings.filesDirHint')}</p>
        </div>
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
        >
          <Save size={14} />
          {saving ? t('settings.saving') : t('settings.save')}
        </button>
      </div>
    </div>
  )
}

const PROVIDERS = [
  { id: 'ollama', label: 'Ollama (local)', needsKey: false, hint: 'settings.ai.ollamaHint' },
  { id: 'anthropic', label: 'Claude / Anthropic', needsKey: true, hint: null },
  { id: 'gemini', label: 'Google Gemini', needsKey: true, hint: null },
  { id: 'copilot', label: 'GitHub Models (Copilot)', needsKey: true, hint: 'settings.ai.copilotHint' },
] as const

type ProviderId = (typeof PROVIDERS)[number]['id']

function AiTab() {
  const { t } = useT()
  const [cfg, setCfg] = useState<Record<string, string | boolean>>({})
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = () => { api.getConfig().then(c => setCfg(c as unknown as Record<string, string | boolean>)).catch(() => {}) }
  const check = () => {
    setChecking(true)
    api.getAiStatus().then(setStatus).catch(() => setStatus(null)).finally(() => setChecking(false))
  }

  useEffect(() => { load(); check() }, [])

  const provider = (cfg.aiProvider as ProviderId) || 'ollama'
  const meta = PROVIDERS.find(p => p.id === provider) ?? PROVIDERS[0]
  const get = (suffix: string) => String(cfg[`ai.${provider}.${suffix}`] ?? '')
  const set = (key: string, value: string) => setCfg(c => ({ ...c, [key]: value }))

  const save = async () => {
    setSaving(true)
    try {
      // Only the AI keys are sent; the other tabs own the rest of the config.
      const patch = Object.fromEntries(
        Object.entries(cfg).filter(([k]) => k === 'aiProvider' || (k.startsWith('ai.') && !k.endsWith('.set')))
      )
      const updated = await api.updateConfig(patch as never)
      setCfg(updated as unknown as Record<string, string | boolean>)
      toast.success(t('settings.saved'))
      check()
    } catch {
      toast.error(t('settings.saveError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-lg space-y-5">
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
        <div>
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
            {t('settings.ai.provider')}
          </label>
          <select
            value={provider}
            onChange={e => set('aiProvider', e.target.value)}
            className={fieldCls}
          >
            {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          {meta.hint && <p className="text-xs text-slate-400 mt-1">{t(meta.hint)}</p>}
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
            {t('settings.ai.model')}
          </label>
          <input
            type="text"
            value={get('model')}
            onChange={e => set(`ai.${provider}.model`, e.target.value)}
            className={fieldCls}
          />
          {provider === 'ollama' && status?.ok && status.models && status.models.length > 0 && (
            <p className="text-xs text-slate-400 mt-1">
              {t('settings.ai.installedModels', { models: status.models.join(', ') })}
            </p>
          )}
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
            {t('settings.ai.baseUrl')}
          </label>
          <input
            type="text"
            value={get('baseUrl')}
            onChange={e => set(`ai.${provider}.baseUrl`, e.target.value)}
            className={fieldCls}
          />
        </div>

        {meta.needsKey && (
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              {t('settings.ai.apiKey')}
            </label>
            <input
              type="password"
              value={get('apiKey')}
              onChange={e => set(`ai.${provider}.apiKey`, e.target.value)}
              className={fieldCls}
            />
            <p className="text-xs text-slate-400 mt-1">
              {cfg[`ai.${provider}.apiKey.set`] ? t('settings.ai.apiKeySet') : t('settings.ai.apiKeyHint')}
            </p>
          </div>
        )}

        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
        >
          <Save size={14} />
          {saving ? t('settings.saving') : t('settings.save')}
        </button>
      </div>

      <div className={cn(
        'rounded-xl border p-4 flex items-start gap-2.5 text-sm',
        status?.ok ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50'
      )}>
        {status?.ok
          ? <CheckCircle2 size={16} className="text-green-600 flex-shrink-0 mt-0.5" />
          : <AlertTriangle size={16} className="text-amber-600 flex-shrink-0 mt-0.5" />}
        <div className="flex-1 min-w-0">
          <p className={cn('font-medium', status?.ok ? 'text-green-800' : 'text-amber-800')}>
            {status?.ok ? t('settings.ai.statusOk') : t('settings.ai.statusDown')}
          </p>
          {status && !status.ok && status.error && (
            <p className="text-xs text-amber-700 mt-0.5 break-words">{status.error}</p>
          )}
        </div>
        <button
          onClick={check}
          disabled={checking}
          className="flex items-center gap-1 flex-shrink-0 text-xs font-medium text-slate-600 hover:text-slate-800 transition-colors"
        >
          <RefreshCw size={12} className={cn(checking && 'animate-spin')} /> {t('settings.ai.recheck')}
        </button>
      </div>
    </div>
  )
}

function FilesTab() {
  const { t } = useT()
  const [files, setFiles] = useState<ServerFile[]>([])
  const [loading, setLoading] = useState(true)
  const [editingFile, setEditingFile] = useState<{ name: string; content: string } | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newContent, setNewContent] = useState('')
  const [saving, setSaving] = useState(false)
  const uploadRef = useRef<HTMLInputElement>(null)

  const load = () => {
    setLoading(true)
    api.getFiles()
      .then(setFiles)
      .catch(() => toast.error(t('files.listError')))
      .finally(() => setLoading(false))
  }

  // Runs once on mount; `load` closes over `t` but the file list is locale-independent.
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const startEdit = async (file: ServerFile) => {
    try {
      const content = await api.getFileContent(file.name)
      setEditingFile({ name: file.name, content })
      setIsCreating(false)
    } catch {
      toast.error(t('files.loadError'))
    }
  }

  const saveEdit = async () => {
    if (!editingFile) return
    setSaving(true)
    try {
      await api.updateFile(editingFile.name, editingFile.content)
      toast.success(t('files.savedOk'))
      setEditingFile(null)
      load()
    } catch {
      toast.error(t('files.saveError'))
    } finally {
      setSaving(false)
    }
  }

  const saveNew = async () => {
    if (!newName.trim()) { toast.warning(t('files.nameRequired')); return }
    setSaving(true)
    try {
      await api.createFile({ name: newName.trim(), content: newContent })
      toast.success(t('files.createdOk'))
      setIsCreating(false)
      setNewName('')
      setNewContent('')
      load()
    } catch {
      toast.error(t('files.createError'))
    } finally {
      setSaving(false)
    }
  }

  const deleteFile = async (name: string) => {
    if (!window.confirm(t('files.confirmDelete', { name }))) return
    try {
      await api.deleteFile(name)
      toast.success(t('files.deletedOk'))
      if (editingFile?.name === name) setEditingFile(null)
      load()
    } catch {
      toast.error(t('files.deleteError'))
    }
  }

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async ev => {
      try {
        await api.createFile({ name: file.name, content: ev.target?.result as string })
        toast.success(t('files.uploadedOk', { name: file.name }))
        load()
      } catch {
        toast.error(t('files.uploadError'))
      }
    }
    reader.readAsText(file, 'utf-8')
    e.target.value = ''
  }

  const startCreate = () => {
    setIsCreating(true)
    setEditingFile(null)
    setNewName('')
    setNewContent('')
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex gap-2">
        <button
          onClick={startCreate}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors"
        >
          <Plus size={14} /> {t('files.new')}
        </button>
        <button
          onClick={() => uploadRef.current?.click()}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-600 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors"
        >
          <Upload size={14} /> {t('files.upload')}
        </button>
        <input ref={uploadRef} type="file" accept="text/*,.txt,.csv" className="hidden" onChange={handleUpload} />
      </div>

      {isCreating && (
        <div className="bg-white rounded-xl border border-blue-200 shadow-sm p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-700">{t('files.newFileTitle')}</span>
            <button onClick={() => setIsCreating(false)} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
          </div>
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder={t('files.namePlaceholder')}
            className={fieldCls}
          />
          <textarea
            value={newContent}
            onChange={e => setNewContent(e.target.value)}
            rows={8}
            placeholder={t('files.contentPlaceholder')}
            className={cn(fieldCls, 'resize-y font-mono text-xs')}
          />
          <div className="flex gap-2">
            <button onClick={saveNew} disabled={saving} className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg transition-colors">
              <Check size={13} /> {t('files.save')}
            </button>
            <button onClick={() => setIsCreating(false)} className="px-3 py-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors">
              {t('files.cancel')}
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center gap-2 p-4 text-sm text-slate-400">
            <div className="w-4 h-4 rounded-full border-2 border-slate-300 border-t-blue-500 animate-spin" />
            {t('files.loading')}
          </div>
        ) : files.length === 0 ? (
          <p className="p-6 text-sm text-slate-400 text-center italic">
            {t('files.empty')}
          </p>
        ) : (
          <ul className="divide-y divide-slate-50">
              {files.map(f => (
                <li key={f.name} className={cn('flex items-center justify-between px-4 py-2.5 hover:bg-slate-50 transition-colors', editingFile?.name === f.name && 'bg-blue-50')}>
                  <span className="font-mono text-xs text-slate-700">{f.name}</span>
                  <div className="flex gap-1">
                    <button onClick={() => startEdit(f)} className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors" title={t('files.editTitle')}>
                      <Pencil size={13} />
                    </button>
                    <button onClick={() => deleteFile(f.name)} className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors" title={t('files.deleteTitle')}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </li>
              ))}
          </ul>
        )}
      </div>

      {editingFile && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-700 font-mono">{editingFile.name}</span>
            <button onClick={() => setEditingFile(null)} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
          </div>
          <textarea
            value={editingFile.content}
            onChange={e => setEditingFile({ ...editingFile, content: e.target.value })}
            rows={12}
            className={cn(fieldCls, 'resize-y font-mono text-xs')}
          />
          <div className="flex gap-2">
            <button onClick={saveEdit} disabled={saving} className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg transition-colors">
              <Check size={13} /> {t('files.save')}
            </button>
            <button onClick={() => setEditingFile(null)} className="px-3 py-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors">
              {t('files.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}


const fieldCls = 'w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow'
