// AI assistant: builds the algorithm knowledge base and talks to the configured provider.
//
// Providers are pluggable; every one exposes the same streaming contract:
//   stream({ cfg, system, messages, onDelta, signal }) -> Promise<string>   (full text)
//
// "copilot" is GitHub Models (https://models.github.ai) — GitHub Copilot itself has no
// public chat API for third-party apps, and GitHub Models is the OpenAI-compatible
// endpoint that ships with a Copilot/GitHub account, authenticated with a PAT.

const fs = require('fs');
const http = require('node:http');
const https = require('node:https');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const KNOWLEDGE_PATH = path.join(__dirname, 'frontend', 'src', 'lib', 'algo-knowledge.en.json');

// ── Provider defaults ─────────────────────────────────────────────────────────

const PROVIDERS = {
  // numCtx matters: Ollama defaults to a small context (4096 on this hardware) regardless of
  // what the model supports, and the algorithm catalog alone is ~12k tokens.
  //
  // keepAlive matters for the same reason from the other end: Ollama unloads an idle model
  // after 5 minutes and the cached prompt prefix goes with it. On a CPU-only machine that
  // prefix is worth minutes - measured at 248s for an 11.9k-token catalog against llama3.2:3b
  // on an i9-9880H - so a pause in the conversation would cost that again. An hour holds the
  // model through a working session; set ai.ollama.keepAlive to '5m' to get Ollama's own
  // default back, or to '0' to unload immediately after each answer.
  //
  // temperature 0 because picking an algorithm is not a creative task: there is one right
  // answer and Ollama's own default of 0.8 samples away from it. Measured on llama3.2:3b with
  // these four cases, dropping to 0 moved two answers from the wrong algorithm to the right one.
  ollama:    { label: 'Ollama (local)',      model: 'llama3.1',      baseUrl: 'http://localhost:11434', needsKey: false, numCtx: 16384, keepAlive: '1h', temperature: 0 },
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
  if (p.keepAlive) DEFAULTS[`ai.${id}.keepAlive`] = p.keepAlive;
  if (p.temperature != null) DEFAULTS[`ai.${id}.temperature`] = String(p.temperature);
}

/** Reads a numeric setting that is allowed to be 0. */
function numberOr(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function providerSettings(config, provider) {
  const id = PROVIDERS[provider] ? provider : 'ollama';
  return {
    id,
    model: config[`ai.${id}.model`] || PROVIDERS[id].model,
    baseUrl: (config[`ai.${id}.baseUrl`] || PROVIDERS[id].baseUrl).replace(/\/+$/, ''),
    apiKey: config[`ai.${id}.apiKey`] || '',
    numCtx: Number(config[`ai.${id}.numCtx`]) || PROVIDERS[id].numCtx,
    keepAlive: config[`ai.${id}.keepAlive`] || PROVIDERS[id].keepAlive,
    // Not `||`: the useful value here is 0, which would fall through to the default.
    temperature: numberOr(config[`ai.${id}.temperature`], PROVIDERS[id].temperature),
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

/**
 * `canSave` decides whether the assistant is taught to emit a save block at all.
 *
 * It is off for a local model, and that is a measured decision rather than a cautious one. Across
 * twelve answers from llama3.2:3b and llama3.1:8b, neither ever answered "no algorithm does this"
 * — not even with a rule in this prompt saying so in as many words, and not on the two questions
 * where that was the only correct answer. What they produced instead was a configuration that
 * runs and does not solve the problem, which the runner accepts and the user discovers much
 * later. Claude, given this same prompt, declined both. A model that cannot say no should not be
 * handed the button that writes to the user's saved algorithms; explaining and recommending is
 * what these models do well, and that is what they are asked for here.
 */
function buildSystemPrompt(catalog, { canSave = true } = {}) {
  const purpose = canSave
    ? `You help with two things:
1. Explaining how an algorithm works, what its parameters do, and which one fits a situation.
2. Building a ready-to-use algorithm configuration when the user describes a masking problem.

The user usually does NOT know which algorithm (framework) to use — that is your job. Read the
situation they describe, pick the right algorithm from the catalog below, and configure it.`
    : `Your job is to explain and to recommend:
1. Explaining how an algorithm works, what its parameters do, and which one fits a situation.
2. Naming the algorithm that fits a masking problem, and spelling out the parameter values it
   needs, so the user can fill the form themselves.

The user usually does NOT know which algorithm (framework) to use — that is your job. Read the
situation they describe and name the right one from the catalog below.

You do NOT create or save algorithms in this configuration. Never emit a save block or claim you
have saved anything. Give the parameters as a short list of name and value, and say which screen
to open: the user picks the algorithm in the sidebar and fills the form there.`;

  return `You are the built-in assistant of the Delphix Masking Helper, a local tool for
understanding, testing and building masking algorithms from the Delphix masking plugin.

${purpose}

# Rules

- Only ever use algorithms and parameters that appear in the catalog. Never invent a parameter
  name, an enum value, or a className.
- Parameters marked "required" must be present in the configuration.
- Keep answers concise and practical. Answer in the same language the user writes in.
- When the user asks a conceptual question, just answer it — do not create an algorithm.

${canSave ? `# Creating an algorithm

When the user asks you to create/build/configure an algorithm, end your reply with a block:

${SAVE_TAG_OPEN}
{"name": "short-descriptive-name", "className": "algorithm.plugin....", "config": { ... }, "testInput": "a representative sample value"}
${SAVE_TAG_CLOSE}

The tool validates that configuration by actually running the algorithm on "testInput" and, if it
works, saves it under "Saved Tests/Algorithms". "testInput" is mandatory and must be a realistic
value for the column being masked — without one there is nothing to validate and the block is
rejected. Emit at most one block per reply. Before the block, explain in one short paragraph which
algorithm you chose and why. Do not show the block contents again as a code fence — the tool
renders it for the user.` : `# Recommending a configuration

Answer with the algorithm's name, then its parameters as a short list of name and value, then one
sentence on why. Mention a realistic sample value the user can paste into the tester to check the
result. Do not wrap the answer in a block of any kind.`}

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
Choice: Character Mapping with preserveRanges:
  {"characterGroups": ["0123456789"], "preserveRanges": [{"start": 1, "length": 4, "direction": "REVERSE"}]}

Problem: "mask a phone number but keep the first 2 digits (the area code)."
Choice: Character Mapping with preserveRanges counting from the front. direction FORWARD counts
from the start of the value, REVERSE from its end; start is 1-based:
  {"characterGroups": ["0123456789"], "preserveRanges": [{"start": 1, "length": 2, "direction": "FORWARD"}]}
Not the Phone algorithm: it generates a whole new number and has no parameter that preserves any
part of the original. And preserveLeadingZeros does not do this either — it only protects a run
of zeros at the front, not an arbitrary prefix.

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
- Payment Card is for payment card numbers only — it preserves the BIN and keeps the Luhn check
  digit valid. Never reach for it for phone numbers, national IDs or generic digit strings.
- Date Shift moves a date by a range of some unit. No range guarantees the year survives: a shift
  of days or months can cross a year boundary, and unit YEARS changes the year by definition.
  Nothing in this catalog masks the month and day while guaranteeing the year is untouched.
- Every algorithm masks the one value it is given. Only the Multi-Column ones see other columns,
  and even they receive named slots, not arbitrary column values. An algorithm cannot build its
  output by combining other columns of the row.

# When nothing fits

Not every request has an answer in this catalog. When none of the algorithms does what the user
asked, say so plainly, name the closest one, and state exactly what it does not do.${canSave
  ? ` Do NOT emit a\n${SAVE_TAG_OPEN} block in that case, and`
  : ' Do'} do not stretch an algorithm to look like an answer.

The tool validates a configuration by running it — so a wrong algorithm that happens to execute
is saved as if it were right. That failure is worse than an honest "the plugin does not do this",
because the user finds out much later. Saying no is a good answer here.

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

// Node's global fetch drops a request that has produced no bytes after 300 seconds
// (UND_ERR_HEADERS_TIMEOUT), and the deadline is not configurable from a plain fetch call.
// A local model earns that silence honestly: the catalog is ~12k tokens, and a CPU-only
// Ollama takes minutes to read it before it can emit a first token - measured at 248s here,
// close enough to the ceiling that the first question of the day died on it. node:http sets
// no such deadline, so the local provider gets its own transport. The hosted providers keep
// fetch: they answer in seconds, and their SDKs and redirects are not worth reimplementing.
function postUntimed(url, body, headers, signal) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
      signal,
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let detail = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { detail += c; });
        res.on('end', () => reject(new Error(
          `${res.statusCode} ${res.statusMessage}${detail ? ` — ${detail.slice(0, 300)}` : ''}`)));
        return;
      }
      // Shaped like a fetch Response so readLines reads either the same way: an
      // IncomingMessage is an async iterable of Buffers, a fetch body one of Uint8Arrays.
      resolve({ body: res });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function streamOllama({ cfg, system, messages, onDelta, signal }) {
  const res = await postUntimed(`${cfg.baseUrl}/api/chat`, {
    model: cfg.model,
    stream: true,
    keep_alive: cfg.keepAlive,
    options: { num_ctx: cfg.numCtx, temperature: cfg.temperature },
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

/**
 * Reads the system prompt into Ollama's prefix cache so the first real question does not
 * have to. Nothing about the answer matters - num_predict: 1 stops the generation as soon
 * as the prompt is in - and every later request repeats this exact prefix, so Ollama skips
 * straight past it. Local provider only: the hosted ones have nothing to warm.
 */
async function warmOllama({ cfg, system, signal }) {
  const started = Date.now();
  const res = await postUntimed(`${cfg.baseUrl}/api/chat`, {
    model: cfg.model,
    stream: false,
    keep_alive: cfg.keepAlive,
    options: { num_ctx: cfg.numCtx, num_predict: 1 },
    messages: [{ role: 'system', content: system }, { role: 'user', content: 'ready?' }],
  }, {}, signal);
  let raw = '';
  await readLines(res, (line) => { raw += line; });
  let promptTokens = null;
  try { promptTokens = JSON.parse(raw).prompt_eval_count ?? null; } catch { /* timing only */ }
  return { ms: Date.now() - started, promptTokens };
}

/**
 * The plugin's schemas come from Jackson, which writes draft-3: "required" is a boolean on each
 * property. Constrained decoding wants the modern shape - "required" as an array on the object -
 * so this rewrites it, drops Jackson's "id", and closes the object so nothing can be invented.
 */
function toStandardSchema(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(toStandardSchema);
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'id' || k === 'required') continue;
    out[k] = toStandardSchema(v);
  }
  if (out.type === 'object' && out.properties) {
    const required = Object.entries(node.properties)
      .filter(([, prop]) => prop && prop.required === true)
      .map(([name]) => name);
    if (required.length) out.required = required;
    out.additionalProperties = false;
  }
  return out;
}

/**
 * Second attempt at a configuration the runner rejected, with the algorithm's real schema as a
 * grammar rather than as advice. Ollama's `format` constrains generation to the schema, so the
 * result cannot invent a key, misspell one, or use an enum value that does not exist - the
 * failures that dominated a local model's output. It cannot make a value *right*: a group of
 * "phone_number" where "0123456789" was meant satisfies "array of string" perfectly. So this
 * narrows the model's job to choosing values, and the runner still has the last word.
 *
 * Local provider only. The hosted models emit valid JSON on their own, and each has its own
 * structured-output mechanism that has nothing to do with this one.
 */
async function repairConfig({ cfg, schema, algorithm, request, badConfig, error, signal }) {
  if (cfg.id !== 'ollama') return null;
  const res = await postUntimed(`${cfg.baseUrl}/api/chat`, {
    model: cfg.model,
    stream: false,
    keep_alive: cfg.keepAlive,
    format: toStandardSchema(schema),
    options: { num_ctx: cfg.numCtx, temperature: 0 },
    messages: [
      { role: 'system', content:
        `You configure the Delphix masking algorithm "${algorithm}". Reply with the `
        + 'configuration JSON and nothing else.\n\n'
        + 'preserveRanges marks parts of the value to leave unmasked: "start" is 1-based, '
        + 'direction FORWARD counts from the front of the value and REVERSE from its end.\n'
        + 'A character group is the set of interchangeable characters themselves — '
        + '"0123456789" for digits — never a description of the field.' },
      { role: 'user', content:
        `What the user asked for: ${request}\n\n`
        + `This configuration was rejected by the algorithm:\n${JSON.stringify(badConfig)}\n\n`
        + `The error was: ${error}\n\nProduce a corrected configuration.` },
    ],
  }, {}, signal);
  let raw = '';
  await readLines(res, (line) => { raw += line; });
  try {
    return JSON.parse(JSON.parse(raw).message.content);
  } catch {
    return null;   // a repair that does not parse is simply no repair
  }
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
  extractSaveBlock, streamChat, probe, warmOllama, repairConfig, toStandardSchema,
};
