import type {
  Algorithm, AiStatus, AppConfig, ChatHandlers, ChatMessage, Classifier, ClassifierCatalog,
  ClassifierFrameworkName, ClassifierReview, ClassifierTestField, ClassifierTestResult,
  ProfileSet, ProfileSetPreset,
  BuiltinReferences, Domain, EngineReferences, Framework, JsonSchema, MaskResult, ServerFile, VersionInfo,
} from '@/types'
import type { EngineExportResult, EngineImportResult, ImportProgress, SyncExportResult } from '@/lib/engine-sync'

const json = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

/**
 * Every endpoint behind this helper answers with JSON. When one doesn't — the API server is
 * down and Vite's proxy answers 502 with an empty body, or something returns an HTML error
 * page — report that, rather than letting `res.json()` fail with "Unexpected end of JSON
 * input", which names neither the cause nor the fix.
 */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    throw new Error(`Cannot reach ${location.host}. Is the app still running?`)
  }

  const body = await res.text()

  if (!body.trim()) {
    throw new Error(
      res.status >= 502 && res.status <= 504
        ? 'The API server is not responding. Start it with `npm run dev` — Express listens on port 3000.'
        : `The server returned an empty response (HTTP ${res.status}).`
    )
  }

  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    throw new Error(`The server returned a non-JSON response (HTTP ${res.status}): ${body.slice(0, 200)}`)
  }

  const { error, code } = data as { error?: unknown; code?: unknown }
  if (!res.ok && typeof error === 'string') {
    const err = new Error(error) as Error & { code?: string; issues?: unknown[]; files?: unknown[]; conflicts?: unknown[] }
    // Some failures are states the UI can word better in the user's own language.
    if (typeof code === 'string') err.code = code
    // A refused configuration comes with its problems, so the form can point at each one.
    const { issues, files, conflicts } = data as { issues?: unknown; files?: unknown; conflicts?: unknown }
    if (Array.isArray(issues)) err.issues = issues
    if (Array.isArray(files)) err.files = files
    // A refused preset load names what it would overwrite, for the user to confirm.
    if (Array.isArray(conflicts)) err.conflicts = conflicts
    throw err
  }
  return data as T
}

/**
 * Reads a server-sent event stream to its end, handing each frame to `handle`.
 *
 * Shared by the chat and the imports: both answer with `event:` + `data:` frames, and both need
 * the reply to arrive in pieces rather than at the end.
 */
async function readEvents(body: ReadableStream<Uint8Array>, handle: (event: string, payload: any) => void) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    // SSE frames are separated by blank lines; each frame is `event:` + `data:`.
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '')
      buffer = buffer.slice(nl + 1)
      if (line.startsWith('event:')) { event = line.slice(6).trim(); continue }
      if (!line.startsWith('data:')) continue
      handle(event, JSON.parse(line.slice(5).trim()))
    }
  }
}

/**
 * POSTs a long job and follows it as it goes.
 *
 * The result is the reply the job ends with; what the stream adds is that `onProgress` hears
 * about each item on the way, so the screen can show a bar instead of freezing. A refusal raised
 * before the stream begins — no engine configured — still arrives as JSON, and is thrown the way
 * every other request throws it.
 */
async function streamJob<T>(
  url: string,
  body: unknown,
  onProgress: (p: ImportProgress) => void,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, { method: 'POST', ...json(body) })
  } catch {
    throw new Error(`Cannot reach ${location.host}. Is the app still running?`)
  }

  if (!res.body || !res.headers.get('content-type')?.includes('text/event-stream')) {
    const data = await res.json().catch(() => ({})) as { error?: string; code?: string }
    const err = new Error(data.error ?? `The server returned HTTP ${res.status}.`) as Error & { code?: string }
    if (data.code) err.code = data.code
    throw err
  }

  let result: T | null = null
  let failure: string | null = null
  await readEvents(res.body, (event, payload) => {
    if (event === 'progress') onProgress(payload as ImportProgress)
    if (event === 'done') result = payload as T
    if (event === 'error') failure = payload.message as string
  })
  if (failure) throw new Error(failure)
  // The stream ended without either event: the server died, or something cut the connection.
  if (!result) throw new Error('The job stopped before it finished.')
  return result
}

export const api = {
  /** Which build this is. Read from the git tag on the server, never from the network. */
  getVersion: () =>
    request<VersionInfo>('/api/version'),

  /** Whether the Delphix libraries are present; the app is unusable without them. */
  getSetup: () =>
    request<{ ready: boolean; missing: string[]; libDir: string; required: number; found: number }>(
      '/api/setup'),

  /** The masking frameworks the plugin provides. */
  getFrameworks: () =>
    request<Framework[]>('/api/frameworks'),

  getSchema: (className: string) =>
    request<{ schema: JsonSchema }>(`/api/frameworks/${encodeURIComponent(className)}/schema`),

  mask: (payload: { framework: string; config: unknown; input: string; mode?: string; additionalAlgorithms?: Array<{ name: string; className: string; config: unknown }> }) =>
    request<MaskResult>('/api/mask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  /** The saved algorithms, optionally only those built on one framework. */
  getAlgorithms: (framework?: string) => {
    const qs = framework ? `?framework=${encodeURIComponent(framework)}` : ''
    return request<Algorithm[]>(`/api/algorithms${qs}`)
  },

  saveAlgorithm: (algo: Omit<Algorithm, 'id' | 'created_at' | 'updated_at' | 'key_value'>) =>
    request<Algorithm>('/api/algorithms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(algo),
    }),

  /** Copies a saved algorithm under a new name. Replaces renaming: on the engine the name is
   *  identity, so a copy is the only thing a new name can mean. */
  duplicateAlgorithm: (id: number, name: string) =>
    request<Algorithm>(`/api/algorithms/${id}/duplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),

  updateAlgorithm: (id: number, patch: { input?: string; config?: string; output?: string }) =>
    request<Algorithm>(`/api/algorithms/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  deleteAlgorithm: (id: number) =>
    request<{ ok: boolean }>(`/api/algorithms/${id}`, { method: 'DELETE' }),

  getConfig: () =>
    request<AppConfig>('/api/config'),

  updateConfig: (config: Partial<AppConfig>) =>
    request<AppConfig>('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    }),

  getFiles: () =>
    request<ServerFile[]>('/api/files'),

  createFile: (payload: { name: string; content: string }) =>
    request<ServerFile>('/api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  getFileContent: (name: string) =>
    fetch(`/api/files/${encodeURIComponent(name)}`).then(r => r.text()),

  updateFile: (name: string, content: string) =>
    request<ServerFile>(`/api/files/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }),

  deleteFile: (name: string) =>
    request<{ ok: boolean }>(`/api/files/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  maskBatch: (payload: { framework: string; config: unknown; inputs: string[] }) =>
    request<{ results: Array<{ output?: string; error?: string }> }>('/api/mask-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  maskMultiColumn: (payload: {
    framework: string;
    config: unknown;
    columns: Array<{ name: string; value: string | null; type: string }>;
  }) =>
    request<{ columns?: Record<string, string | null>; error?: string; errorType?: string }>('/api/mask-multicolumn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  // ── Domains ────────────────────────────────────────────────────────────────
  getDomains: () =>
    request<Domain[]>('/api/domains'),

  createDomain: (body: { name: string; defaultAlgorithm?: string; defaultTokenization?: string }) =>
    request<Domain>('/api/domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  /** The name is identity and is not accepted here, mirroring the engine's own rule. */
  updateDomain: (id: number, patch: { defaultAlgorithm?: string; defaultTokenization?: string }) =>
    request<Domain>(`/api/domains/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  deleteDomain: (id: number) =>
    request<{ ok: boolean }>(`/api/domains/${id}`, { method: 'DELETE' }),
  /** Sends the domain and, first, the algorithms (and their files) it names that this machine holds. */
  delphixExportDomain: (id: number) =>
    request<{ mode: 'created' | 'updated'; name: string; engine: string } & EngineExportResult>(
      `/api/delphix/domains/export/${id}`, { method: 'POST' }),

  // ── Classifiers ────────────────────────────────────────────────────────────
  /** The frameworks' settings and the SQL types a test column can have. */
  getClassifierCatalog: () =>
    request<ClassifierCatalog>('/api/classifier-frameworks'),

  /** What Delphix would refuse, what cannot be tested here, and what is probably a slip. */
  reviewClassifier: (framework: ClassifierFrameworkName, config: Record<string, unknown>) =>
    request<ClassifierReview>('/api/classifiers/check', { method: 'POST', ...json({ framework, config }) }),

  getClassifiers: () =>
    request<Classifier[]>('/api/classifiers'),

  createClassifier: (body: {
    name: string; framework: ClassifierFrameworkName; domain: string; description?: string; config: Record<string, unknown>
  }) =>
    request<Classifier>('/api/classifiers', { method: 'POST', ...json(body) }),

  /** The framework is not accepted: the engine will not change it on an existing classifier. */
  updateClassifier: (id: number, patch: { name?: string; domain?: string; description?: string; config?: Record<string, unknown> }) =>
    request<Classifier>(`/api/classifiers/${id}`, { method: 'PUT', ...json(patch) }),

  deleteClassifier: (id: number) =>
    request<{ ok: boolean }>(`/api/classifiers/${id}`, { method: 'DELETE' }),

  /** Profiles one column with this classifier and the other saved classifiers of its domain. */
  testClassifier: (body: {
    classifier: { id?: number; name: string; framework: ClassifierFrameworkName; domain: string; config: Record<string, unknown> }
    field: ClassifierTestField
    threshold: number
  }) =>
    request<ClassifierTestResult>('/api/classifiers/test', { method: 'POST', ...json(body) }),

  // ── Profile sets ───────────────────────────────────────────────────────────

  getProfileSets: () =>
    request<ProfileSet[]>('/api/profile-sets'),

  createProfileSet: (body: { name: string; description?: string; threshold: number; classifierIds: number[] }) =>
    request<ProfileSet>('/api/profile-sets', { method: 'POST', ...json(body) }),

  updateProfileSet: (id: number, patch: { name?: string; description?: string; threshold?: number; classifierIds?: number[] }) =>
    request<ProfileSet>(`/api/profile-sets/${id}`, { method: 'PUT', ...json(patch) }),

  deleteProfileSet: (id: number) =>
    request<{ ok: boolean }>(`/api/profile-sets/${id}`, { method: 'DELETE' }),
  /** Sends every classifier in the set, then the set itself naming them by their engine ids. */
  delphixExportProfileSet: (id: number) =>
    request<{
      mode: 'created' | 'updated'; name: string; engine: string;
      classifiers: Array<{ name: string; mode: 'created' | 'updated' }>;
    } & EngineExportResult>(`/api/delphix/profile-sets/export/${id}`, { method: 'POST' }),
  // ── Pre-configured profile sets ────────────────────────────────────────────

  getPresets: () =>
    request<ProfileSetPreset[]>('/api/presets'),

  /** Creates the preset, or resets it when loaded before. A 409 carries `conflicts`; `overwrite` confirms them. */
  loadPreset: (id: string, overwrite = false) =>
    request<{ mode: 'loaded' | 'reset'; profileSetId: number; files: string[] }>(
      `/api/presets/${encodeURIComponent(id)}/load`, { method: 'POST', ...json({ overwrite }) }),

  /** A link rather than a request: the browser downloads the PDF itself. */
  presetDocUrl: (id: string, locale: string) =>
    `/api/presets/${encodeURIComponent(id)}/doc?locale=${encodeURIComponent(locale)}`,

  /** Sends the classifier and, first, its domain (with the domain's algorithms) and its list files. */
  delphixExportClassifier: (id: number) =>
    request<{
      mode: 'created' | 'updated'; name: string; engine: string;
      domain: { mode: 'created' | 'updated'; name: string } | null;
    } & EngineExportResult>(`/api/delphix/classifiers/export/${id}`, { method: 'POST' }),

  // ── Reference names ────────────────────────────────────────────────────────
  /** The plugin's built-in algorithms, named the way a reference names them, and which can tokenize. */
  getBuiltinAlgorithms: () =>
    request<BuiltinReferences>('/api/reference/builtins'),

  /** Algorithm and domain names on the configured engine. `refresh` skips the server's cache. */
  getEngineReferences: (refresh = false) =>
    request<EngineReferences>(`/api/reference/engine${refresh ? '?refresh=1' : ''}`),

  // ── Delphix engine ─────────────────────────────────────────────────────────
  delphixStatus: () =>
    request<{ configured: boolean; ok: boolean; error?: string; apiRoot?: string }>('/api/delphix/status'),

  /** Probes credentials straight from the form, before they are saved. */
  delphixTest: (body: { baseUrl: string; username: string; password: string; allowSelfSigned: boolean }) =>
    request<{ configured: boolean; ok: boolean; error?: string; apiRoot?: string }>('/api/delphix/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  // ── The integration as a whole ─────────────────────────────────────────────

  /** Brings the entire engine down: every profile set, classifier, domain and algorithm on it. */
  delphixSyncImport: (onProgress: (p: ImportProgress) => void) =>
    streamJob<EngineImportResult>('/api/delphix/sync/import', {}, onProgress),

  /** Sends everything held here up, in dependency order. */
  delphixSyncExport: (onProgress: (p: ImportProgress) => void) =>
    streamJob<SyncExportResult>('/api/delphix/sync/export', {}, onProgress),

  /** Forgets the connection and deletes every row linked to that engine. */
  deleteDelphixIntegration: () =>
    request<{ ok: boolean; engine: string | null; removed: Record<string, number> }>(
      '/api/delphix/integration', { method: 'DELETE' }),

  /** Sends the algorithm after the algorithms it references, uploading the files the engine lacks. */
  delphixExport: (id: number, name?: string) =>
    request<{
      mode: 'created' | 'updated'; name: string; engine: string; renamed: boolean;
    } & EngineExportResult>(
      `/api/delphix/export/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),

  getAiStatus: () =>
    request<AiStatus>('/api/ai/status'),

  /** POSTs the conversation and streams the reply back as server-sent events. */
  streamChat: async (messages: ChatMessage[], handlers: ChatHandlers, signal: AbortSignal) => {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal,
    })
    if (!res.body) throw new Error('No response body')

    await readEvents(res.body, (event, payload) => {
      switch (event) {
        case 'delta': handlers.onDelta(payload.delta); break
        case 'replace': handlers.onReplace(payload.text); break
        case 'saved': handlers.onSaved(payload); break
        case 'save-error': handlers.onSaveError(payload.message); break
        case 'warn': handlers.onSaveError(payload.message); break
        case 'error': handlers.onError(payload.message); break
      }
    })
  },

  ensureSampleFile: (name: string) =>
    request<{ name: string; uri: string }>('/api/files/ensure-sample', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
}
