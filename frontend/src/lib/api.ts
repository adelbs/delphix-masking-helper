import type {
  Algorithm, AiStatus, AppConfig, ChatHandlers, ChatMessage,
  JsonSchema, MaskResult, SavedTest, ServerFile,
} from '@/types'

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
    const err = new Error(error) as Error & { code?: string }
    // Some failures are states the UI can word better in the user's own language.
    if (typeof code === 'string') err.code = code
    throw err
  }
  return data as T
}

export const api = {
  getAlgorithms: () =>
    request<Algorithm[]>('/api/algorithms'),

  getSchema: (className: string) =>
    request<{ schema: JsonSchema }>(`/api/algorithms/${encodeURIComponent(className)}/schema`),

  mask: (payload: { algorithm: string; config: unknown; input: string; mode?: string; additionalAlgorithms?: Array<{ name: string; className: string; config: unknown }> }) =>
    request<MaskResult>('/api/mask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  getTests: (algorithm?: string) => {
    const qs = algorithm ? `?algorithm=${encodeURIComponent(algorithm)}` : ''
    return request<SavedTest[]>(`/api/tests${qs}`)
  },

  saveTest: (test: Omit<SavedTest, 'id' | 'created_at' | 'updated_at' | 'key_value'>) =>
    request<SavedTest>('/api/tests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(test),
    }),

  /** Copies a saved algorithm under a new name. Replaces renaming: on the engine the name is
   *  identity, so a copy is the only thing a new name can mean. */
  duplicateTest: (id: number, name: string) =>
    request<SavedTest>(`/api/tests/${id}/duplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),

  updateTest: (id: number, patch: { input?: string; config?: string; output?: string }) =>
    request<SavedTest>(`/api/tests/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  deleteTest: (id: number) =>
    request<{ ok: boolean }>(`/api/tests/${id}`, { method: 'DELETE' }),

  exportTests: () =>
    request<SavedTest[]>('/api/tests/export'),

  importTests: (tests: unknown[]) =>
    request<{ imported: number }>('/api/tests/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tests),
    }),

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

  maskBatch: (payload: { algorithm: string; config: unknown; inputs: string[] }) =>
    request<{ results: Array<{ output?: string; error?: string }> }>('/api/mask-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  maskMultiColumn: (payload: {
    algorithm: string;
    config: unknown;
    columns: Array<{ name: string; value: string | null; type: string }>;
  }) =>
    request<{ columns?: Record<string, string | null>; error?: string; errorType?: string }>('/api/mask-multicolumn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

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

  delphixAlgorithms: () =>
    request<Array<{
      algorithmName: string; frameworkName: string | null; className: string | null;
      description: string; config: Record<string, unknown>;
      supported: boolean; alreadyImported: boolean;
      /** Lookup files the engine holds and this machine does not — the algorithm imports fine
       *  but cannot run until a copy of each exists in the files folder. */
      missingFiles: string[];
    }>>('/api/delphix/algorithms'),

  delphixImport: (names: string[]) =>
    request<{
      imported: string[];
      skipped: Array<{ name: string; reason: string; framework?: string }>;
      needsFiles: Array<{ name: string; files: string[] }>;
    }>(
      '/api/delphix/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names }),
      }),

  delphixExport: (id: number, name?: string) =>
    request<{
      mode: 'created' | 'updated'; name: string; engine: string; renamed: boolean;
      /** file:// references that were sent as they are — paths on this machine, which the
       *  engine has no way to open. */
      localFiles: string[];
    }>(
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

    const reader = res.body.getReader()
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
        const payload = JSON.parse(line.slice(5).trim())
        switch (event) {
          case 'delta': handlers.onDelta(payload.delta); break
          case 'replace': handlers.onReplace(payload.text); break
          case 'saved': handlers.onSaved(payload); break
          case 'save-error': handlers.onSaveError(payload.message); break
          case 'warn': handlers.onSaveError(payload.message); break
          case 'error': handlers.onError(payload.message); break
        }
      }
    }
  },

  ensureSampleFile: (name: string) =>
    request<{ name: string; uri: string }>('/api/files/ensure-sample', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
}
