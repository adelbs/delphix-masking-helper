// AI assistant: builds the algorithm knowledge base and talks to the configured provider.
//
// Providers are pluggable; every one exposes the same streaming contract:
//   stream({ cfg, system, messages, onDelta, signal }) -> Promise<string>   (full text)
//
// "copilot" is GitHub Models (https://models.github.ai) — GitHub Copilot itself has no
// public chat API for third-party apps, and GitHub Models is the OpenAI-compatible
// endpoint that ships with a Copilot/GitHub account, authenticated with a PAT.

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const KNOWLEDGE_PATH = path.join(__dirname, 'frontend', 'src', 'lib', 'algo-knowledge.en.json');

// ── Provider defaults ─────────────────────────────────────────────────────────

const PROVIDERS = {
  // numCtx matters: Ollama defaults to a small context (4096 on this hardware) regardless of
  // what the model supports, and the algorithm catalog alone is ~12k tokens.
  ollama:    { label: 'Ollama (local)',      model: 'llama3.1',      baseUrl: 'http://localhost:11434', needsKey: false, numCtx: 16384 },
  anthropic: { label: 'Claude / Anthropic',  model: 'claude-opus-5', baseUrl: '',                       needsKey: true  },
  gemini:    { label: 'Google Gemini',       model: 'gemini-2.5-pro', baseUrl: 'https://generativelanguage.googleapis.com', needsKey: true },
  copilot:   { label: 'GitHub Models (Copilot)', model: 'gpt-4o',    baseUrl: 'https://models.github.ai/inference', needsKey: true },
};

const DEFAULTS = { aiProvider: 'ollama' };
for (const [id, p] of Object.entries(PROVIDERS)) {
  DEFAULTS[`ai.${id}.model`] = p.model;
  DEFAULTS[`ai.${id}.baseUrl`] = p.baseUrl;
  if (p.needsKey) DEFAULTS[`ai.${id}.apiKey`] = '';
  if (p.numCtx) DEFAULTS[`ai.${id}.numCtx`] = String(p.numCtx);
}

function providerSettings(config, provider) {
  const id = PROVIDERS[provider] ? provider : 'ollama';
  return {
    id,
    model: config[`ai.${id}.model`] || PROVIDERS[id].model,
    baseUrl: (config[`ai.${id}.baseUrl`] || PROVIDERS[id].baseUrl).replace(/\/+$/, ''),
    apiKey: config[`ai.${id}.apiKey`] || '',
    numCtx: Number(config[`ai.${id}.numCtx`]) || PROVIDERS[id].numCtx,
  };
}

// ── Algorithm catalog ─────────────────────────────────────────────────────────

/** Flattens a JSON Schema into dot-path lines matching the knowledge `params` keys. */
function flattenSchema(schema, prefix = '', depth = 0, out = []) {
  if (!schema || depth > 3) return out;
  const props = schema.properties || (schema.items && schema.items.properties);
  if (!props) return out;
  for (const [key, prop] of Object.entries(props)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    const bits = [];
    if (prop.enum) bits.push(`enum: ${prop.enum.join('|')}`);
    else if (prop.type === 'array') bits.push(`array<${prop.items?.type || 'object'}>`);
    else if (prop.type) bits.push(prop.type);
    if (prop.required) bits.push('required');
    if (prop.id?.includes('FileReference')) bits.push('file reference: {"uri": "file:///abs/path"}');
    if (prop.id?.includes('AlgorithmInstanceReference') || prop.$ref?.includes('AlgorithmInstanceReference')) {
      bits.push('algorithm reference: {"name": "dlpx-core:Something"}');
    }
    out.push({ path: dotted, meta: bits.join(', ') });
    flattenSchema(prop, dotted, depth + 1, out);
  }
  return out;
}

let catalogPromise = null;

/** Builds (once) a compact text catalog of every algorithm: prose + real schema. */
function buildCatalog(runJava) {
  if (catalogPromise) return catalogPromise;
  catalogPromise = (async () => {
    const knowledge = JSON.parse(fs.readFileSync(KNOWLEDGE_PATH, 'utf8'));
    const list = await runJava({ command: 'list' });
    const entries = await Promise.all(list.map(async (algo) => {
      const simple = algo.className.split('.').pop();
      const know = knowledge[simple] || {};
      let schema = null;
      try {
        const res = await runJava({ command: 'schema', algorithm: algo.className });
        schema = res.schema;
      } catch { /* an algorithm without a readable schema still gets its prose */ }

      const lines = [`## ${algo.displayName}`, `className: ${algo.className}`];
      if (know.description) lines.push(`What it does: ${know.description}`);
      if (know.inputFormat) lines.push(`Input: ${know.inputFormat}`);
      const params = flattenSchema(schema);
      if (params.length) {
        lines.push('Parameters:');
        for (const { path: p, meta } of params) {
          const desc = know.params?.[p];
          lines.push(`  - ${p}${meta ? ` (${meta})` : ''}${desc ? ` — ${desc}` : ''}`);
        }
      } else {
        lines.push('Parameters: none.');
      }
      return lines.join('\n');
    }));
    return entries.join('\n\n');
  })().catch((err) => { catalogPromise = null; throw err; });
  return catalogPromise;
}

const SAVE_TAG_OPEN = '<save-algorithm>';
const SAVE_TAG_CLOSE = '</save-algorithm>';

function buildSystemPrompt(catalog) {
  return `You are the built-in assistant of the Delphix Masking Helper, a local tool for
understanding, testing and building masking algorithms from the Delphix masking plugin.

You help with two things:
1. Explaining how an algorithm works, what its parameters do, and which one fits a situation.
2. Building a ready-to-use algorithm configuration when the user describes a masking problem.

The user usually does NOT know which algorithm (framework) to use — that is your job. Read the
situation they describe, pick the right algorithm from the catalog below, and configure it.

# Rules

- Only ever use algorithms and parameters that appear in the catalog. Never invent a parameter
  name, an enum value, or a className.
- Parameters marked "required" must be present in the configuration.
- Keep answers concise and practical. Answer in the same language the user writes in.
- When the user asks a conceptual question, just answer it — do not create an algorithm.

# Creating an algorithm

When the user asks you to create/build/configure an algorithm, end your reply with a block:

${SAVE_TAG_OPEN}
{"name": "short-descriptive-name", "className": "algorithm.plugin....", "config": { ... }, "testInput": "a representative sample value"}
${SAVE_TAG_CLOSE}

The tool will validate that configuration by actually running the algorithm on "testInput" and,
if it works, save it under "Saved Tests/Algorithms". Emit at most one block per reply. Before the
block, explain in one short paragraph which algorithm you chose and why. Do not show the block
contents again as a code fence — the tool renders it for the user.

## Worked examples of the mapping from problem to configuration

Problem: "a numeric field in a CHAR column, left-padded with zeros, 15 characters, generate a
random number keeping the same number of leading zeros as the original value."
Choice: Character Mapping with a single digits group and preserveLeadingZeros enabled. It keeps
the length, maps digits to digits, and the preserveLeadingZeros flag keeps the padding run intact
while randomizing the rest:
  {"characterGroups": ["0123456789"], "preserveLeadingZeros": true, "minMaskedPositions": 1}
  000000000012345 -> 000000000031564   (11 leading zeros preserved)
Do NOT reach for Segment Mapping here: its segments are fixed-length, so it cannot follow a
zero-padding run whose length varies from row to row.

Problem: "mask a name so the same name always becomes the same fake name across tables."
Choice: Secure Lookup with hashMethod SHA256 — deterministic by key, draws from a lookup file.

Problem: "shift dates but keep the ordering of events."
Choice: Date Shift — the shift is deterministic per key, which preserves chronology.

Problem: "hide the middle of an account number but keep the last 4 digits."
Choice: Character Mapping with preserveRanges, or Payment Card when it is a card number
(it also keeps the Luhn check digit valid).

# Known constraints not expressed in the schemas

- Character Mapping: preserveLeadingZeros and preserveRanges may NOT be used together.
- Character Mapping: to mask digits only, use a single group "0123456789".
- minMaskedPositions is a floor on how many characters must actually change, not the field
  length. Setting it near the value length fails on inputs where fewer characters can change
  (a zero-padded number has few maskable digits). Leave it at 1 unless asked otherwise.
- Regex Decompose: an action sets redactString OR redactCharacter, never both.
- Character Replacement: a rule uses filteredCharacters OR the input/output pair, never both.
- Omit any optional parameter you have no reason to set. A minimal configuration that runs beats
  a thorough one that fails validation.

# Algorithm catalog

${catalog}`;
}

/** Pulls the save block out of a finished reply. Returns { spec, text } with the block removed. */
function extractSaveBlock(text) {
  const start = text.indexOf(SAVE_TAG_OPEN);
  if (start === -1) return { spec: null, text };
  const end = text.indexOf(SAVE_TAG_CLOSE, start);
  const body = text.slice(start + SAVE_TAG_OPEN.length, end === -1 ? undefined : end);
  const cleaned = text.slice(0, start) + (end === -1 ? '' : text.slice(end + SAVE_TAG_CLOSE.length));
  try {
    const spec = JSON.parse(body.replace(/^\s*```(?:json)?/, '').replace(/```\s*$/, '').trim());
    return { spec, text: cleaned.trim() };
  } catch {
    return { spec: null, text: cleaned.trim(), parseError: true };
  }
}

// ── Providers ─────────────────────────────────────────────────────────────────

async function streamAnthropic({ cfg, system, messages, onDelta, signal }) {
  const client = new (Anthropic.default || Anthropic)({ apiKey: cfg.apiKey });
  const stream = client.messages.stream({
    model: cfg.model,
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    system,
    messages,
  }, { signal });
  stream.on('text', (delta) => onDelta(delta));
  const final = await stream.finalMessage();
  return final.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/** Reads an SSE or NDJSON body line by line. */
async function readLines(res, onLine) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onLine(line);
    }
  }
  if (buffer.trim()) onLine(buffer.trim());
}

async function post(url, body, headers, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
  }
  return res;
}

async function streamOllama({ cfg, system, messages, onDelta, signal }) {
  const res = await post(`${cfg.baseUrl}/api/chat`, {
    model: cfg.model,
    stream: true,
    options: { num_ctx: cfg.numCtx },
    messages: [{ role: 'system', content: system }, ...messages],
  }, {}, signal);
  let full = '';
  await readLines(res, (line) => {
    try {
      const obj = JSON.parse(line);
      const piece = obj.message?.content || '';
      if (piece) { full += piece; onDelta(piece); }
    } catch { /* keep-alive or partial line */ }
  });
  return full;
}

/** Shared by every OpenAI-compatible endpoint (GitHub Models today). */
async function streamOpenAICompatible({ cfg, system, messages, onDelta, signal }) {
  const res = await post(`${cfg.baseUrl}/chat/completions`, {
    model: cfg.model,
    stream: true,
    messages: [{ role: 'system', content: system }, ...messages],
  }, { Authorization: `Bearer ${cfg.apiKey}` }, signal);
  let full = '';
  await readLines(res, (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '[DONE]') return;
    try {
      const piece = JSON.parse(data).choices?.[0]?.delta?.content || '';
      if (piece) { full += piece; onDelta(piece); }
    } catch { /* ignore */ }
  });
  return full;
}

async function streamGemini({ cfg, system, messages, onDelta, signal }) {
  const url = `${cfg.baseUrl}/v1beta/models/${encodeURIComponent(cfg.model)}:streamGenerateContent?alt=sse`;
  const res = await post(url, {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
  }, { 'x-goog-api-key': cfg.apiKey }, signal);
  let full = '';
  await readLines(res, (line) => {
    if (!line.startsWith('data:')) return;
    try {
      const parts = JSON.parse(line.slice(5).trim()).candidates?.[0]?.content?.parts || [];
      for (const p of parts) if (p.text) { full += p.text; onDelta(p.text); }
    } catch { /* ignore */ }
  });
  return full;
}

const STREAMERS = {
  anthropic: streamAnthropic,
  ollama: streamOllama,
  gemini: streamGemini,
  copilot: streamOpenAICompatible,
};

async function streamChat(opts) {
  const fn = STREAMERS[opts.cfg.id];
  if (!fn) throw new Error(`Unknown provider: ${opts.cfg.id}`);
  if (PROVIDERS[opts.cfg.id].needsKey && !opts.cfg.apiKey) {
    throw new Error(`No API key configured for ${PROVIDERS[opts.cfg.id].label}. Add one under Settings → AI.`);
  }
  return fn(opts);
}

/** Cheap reachability probe so the UI can tell "not configured" from "provider down". */
async function probe(cfg) {
  if (cfg.id === 'ollama') {
    try {
      const res = await fetch(`${cfg.baseUrl}/api/tags`, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return { ok: false, error: `${res.status} ${res.statusText}` };
      const models = (await res.json()).models?.map((m) => m.name) ?? [];
      return { ok: true, models };
    } catch (err) {
      return { ok: false, error: `Ollama is not reachable at ${cfg.baseUrl} (${err.message})` };
    }
  }
  if (!cfg.apiKey) return { ok: false, error: 'No API key configured.' };
  return { ok: true, models: [] };
}

module.exports = {
  PROVIDERS, DEFAULTS, providerSettings, buildCatalog, buildSystemPrompt,
  extractSaveBlock, streamChat, probe,
};
