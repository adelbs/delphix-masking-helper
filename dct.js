// Talks to Delphix Data Control Tower (DCT), the other place this tool can integrate with.
//
// DCT centralises Continuous Compliance: algorithms, data classes, classifiers and discovery
// policies live in DCT itself ("DCT-managed") and are synchronised to a compliance node when a
// job runs. This module speaks DCT's API but answers in the shapes `delphix.js` answers in for an
// engine, so everything above it — import, export, what travels together — is written once.
//
// API contract, read from the OpenAPI spec DCT serves (DCT API 3.29, /dct/static/api-external.yaml):
//
//   base            {host}/dct/v3
//   header          Authorization: apk <api key>
//   lists           GET /<objects>?limit=&cursor=  -> {items, response_metadata: {next_cursor, total}}
//   writes          POST, PATCH, DELETE answer with {job}; the job is followed at GET /jobs/{id}
//   GET|POST /algorithms        PATCH|DELETE /algorithms/{id}       (name, framework_id, config)
//   GET|POST /data-classes      PATCH|DELETE /data-classes/{id}     (name, default_algorithm_id, …)
//   GET|POST /classifiers       PATCH|DELETE /classifiers/{id}      (name, framework, data_class_id, config)
//   GET|POST /discovery-policies  PATCH|DELETE /discovery-policies/{id}
//            /discovery-policies/{id}/classifiers  (+ /remove)      — membership is its own call
//   POST /masking-file-uploads  (multipart)  -> {file: {file_reference_id}}
//   GET /masking-plugins        -> the plugins, each with its frameworks
//   GET|POST /hook-templates    PATCH|DELETE /hook-templates/{id}
//
// What differs from an engine, measured against a DCT 2026 lab on 2026-10-12:
//
// - Identity is an id (a UUID) for every object, and names are not unique: DCT keeps a data class
//   called EMAIL of its own beside one mirrored from each connected engine, and accepts a second
//   user algorithm under a name already taken. So this module only deals with DCT-managed objects
//   (`dct_managed`), resolves a name to the user's object before DCT's built-in one, and updates
//   by id rather than creating a twin.
// - A configuration names another algorithm by its id: `{ "name": "<uuid>" }`, where an engine
//   writes the algorithm name. Configurations are translated both ways, so the row here keeps
//   names and runs locally.
// - DCT's built-in algorithms carry no `dlpx-core:` prefix, and a few have their own names
//   ("CreditCard" for the plugin's "Credit Card", "NullValueLookup" for "Null Secure Lookup").
//   Here they are always "dlpx-core:<name>", the way the plugin and an engine call them.
// - A file uploaded for an algorithm belongs to that algorithm: a second one naming the same
//   upload is refused ("The file … is used by other objects"). Classifiers may share one.
// - DCT keeps no restriction on characters in names and descriptions, and no 50-character limit
//   on a policy's description: the text goes as written.
// - DCT has no way to download an uploaded file, so lists and lookup files do not come down.

const { request, plainError } = require('./http-client');

class DctError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const CORE_PLUGIN = 'dlpx-core';
const CORE_PREFIX = `${CORE_PLUGIN}:`;

// The classifier frameworks: DCT calls TYPE "DATA_TYPE".
const CLASSIFIER_FRAMEWORK = { PATH: 'PATH', TYPE: 'DATA_TYPE', REGEX: 'REGEX', LIST: 'LIST' };
const LOCAL_CLASSIFIER_FRAMEWORK = Object.fromEntries(Object.entries(CLASSIFIER_FRAMEWORK).map(([a, b]) => [b, a]));

// ── HTTP ──────────────────────────────────────────────────────────────────────

/** The API root. Accepts the DCT host or a URL already ending in /dct/v3. */
function apiRoot(baseUrl) {
  const url = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
  return /\/dct\/v3$/.test(url) ? url : `${url.replace(/\/+$/, '').replace(/\/dct$/, '')}/dct/v3`;
}

/** DCT keys carry their own "apk " prefix in some copies; the header wants exactly one. */
const authHeader = (key) => `apk ${String(key).trim().replace(/^apk\s+/i, '')}`;

async function call(cfg, method, path, { body, form } = {}) {
  const url = `${apiRoot(cfg.baseUrl)}${path}`;
  const headers = { Accept: 'application/json', Authorization: authHeader(cfg.apiKey) };
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  // A DCT under load can leave a read unanswered for a minute; a read is safe to ask again. A write
  // is not — a POST that did arrive would create a twin — so only GETs are retried.
  let res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await request(url, {
        method, headers, body: payload, insecure: cfg.allowSelfSigned, timeoutMs: form ? 300000 : 120000,
      });
      if (method === 'GET' && res.status >= 502 && res.status <= 504 && attempt < 3) continue;
      break;
    } catch (err) {
      if (method === 'GET' && attempt < 3) continue;
      throw new DctError(`Could not reach Data Control Tower at ${apiRoot(cfg.baseUrl)} — ${err.cause?.code ?? err.cause?.message ?? err.message}`, 0);
    }
  }
  const text = res.buffer.toString('utf8');
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { /* an HTML error page */ } }
  if (!res.ok) {
    // DCT answers {error_description} for its own refusals and {detail} for a route it lacks.
    const detail = data?.error_description || data?.detail || data?.message
      || plainError(text, res.status);
    throw new DctError(res.status === 401 ? `Data Control Tower refused the API key (${detail}).` : detail, res.status);
  }
  return data;
}

// Sending a preset is hundreds of writes, and each one needs the current lists — of algorithms to
// turn names into ids, of data classes to find the one a classifier votes for. Lists are kept for
// a few seconds and dropped on any write to the same kind of object, so a long push reads each
// list once per change instead of once per object.
const LIST_TTL_MS = 15000;
const listCache = new Map();

const kindOf = (path) => path.split('?')[0].split('/')[1];

function forget(path) {
  const kind = kindOf(path);
  for (const key of listCache.keys()) if (kindOf(key.slice(key.indexOf('|') + 1)) === kind) listCache.delete(key);
}

/** Every item of a list, following the cursor. */
function list(cfg, path) {
  const key = `${apiRoot(cfg.baseUrl)}|${path}`;
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.promise;
  const promise = listUncached(cfg, path).catch((err) => { listCache.delete(key); throw err; });
  listCache.set(key, { at: Date.now(), promise });
  return promise;
}

async function listUncached(cfg, path) {
  const out = [];
  let cursor = null;
  for (;;) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await call(cfg, 'GET', `${path}${sep}limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    out.push(...(data?.items ?? []));
    cursor = data?.response_metadata?.next_cursor;
    if (!cursor) return out;
  }
}

const DONE = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'TIMEDOUT', 'ABANDONED', 'SUSPENDED']);

/** Waits for the job a write started, and fails when it did. */
async function waitForJob(cfg, job, { timeoutMs = 180000 } = {}) {
  if (!job?.id) return job;
  const deadline = Date.now() + timeoutMs;
  let current = job;
  while (!DONE.has(current.status)) {
    if (Date.now() > deadline) {
      throw new DctError(`Data Control Tower is still running job ${job.id}. Check it there before trying again.`, 0);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    current = await call(cfg, 'GET', `/jobs/${encodeURIComponent(job.id)}`);
  }
  if (current.status !== 'COMPLETED') {
    throw new DctError(current.error_details || `Data Control Tower's job ended as ${current.status.toLowerCase()}.`, 0);
  }
  return current;
}

/** A write and the job it starts, as one step. */
async function write(cfg, method, path, body) {
  try {
    const data = await call(cfg, method, path, { body });
    await waitForJob(cfg, data?.job);
    return data;
  } finally {
    forget(path);
  }
}

// ── Session ───────────────────────────────────────────────────────────────────

async function probe(cfg) {
  if (!cfg.baseUrl || !cfg.apiKey) return { ok: false, error: 'not-configured' };
  try {
    await call(cfg, 'GET', '/algorithms?limit=1');
    return { ok: true, apiRoot: apiRoot(cfg.baseUrl) };
  } catch (err) {
    return { ok: false, error: err.message, status: err.status };
  }
}

// ── Algorithms ────────────────────────────────────────────────────────────────

/** What a name is compared on when a plugin name and DCT's name for the same built-in differ. */
const loose = (name) => String(name).replace(/^dlpx-core:/i, '').replace(/^legacy\s+/i, '')
  .replace(/[\s_-]+/g, '').toLowerCase();

// The built-ins DCT renamed beyond spacing and case, plugin name → DCT name.
const BUILTIN_ALIAS = {
  nullsecurelookup: 'nullvaluelookup',
  shuffle: 'secureshuffle',
};

/** The key a built-in is found by, whichever of the two spellings a name uses. */
const builtinKey = (name) => BUILTIN_ALIAS[loose(name)] ?? loose(name);

const localBuiltinName = (name) => `${CORE_PREFIX}${name}`;

/**
 * DCT's algorithms as an index: what the user created, DCT's built-ins, and a way from a name as
 * it is written here to the id DCT knows it by — and back.
 */
async function algorithmIndex(cfg) {
  const all = (await list(cfg, '/algorithms')).filter((a) => a.dct_managed);
  const user = all.filter((a) => !a.is_default_instance);
  const builtin = all.filter((a) => a.is_default_instance);
  const byId = new Map(all.map((a) => [a.id, a]));
  const userByName = new Map();
  for (const a of user) if (!userByName.has(a.name)) userByName.set(a.name, a);
  const builtinByKey = new Map(builtin.map((a) => [builtinKey(a.name), a]));

  /** The DCT algorithm a name here means, or undefined. */
  const resolve = (name) => {
    const text = String(name ?? '').trim();
    if (!text) return undefined;
    if (!text.toLowerCase().startsWith(CORE_PREFIX) && userByName.has(text)) return userByName.get(text);
    return builtinByKey.get(builtinKey(text)) ?? userByName.get(text);
  };
  /** The name here for a DCT algorithm. */
  const nameOf = (a) => (a.is_default_instance ? localBuiltinName(a.name) : a.name);
  /** The name here for what an id points at; an id DCT does not list stays as it is. */
  const nameForId = (id) => (byId.has(id) ? nameOf(byId.get(id)) : id);
  return { all, user, builtin, byId, resolve, nameOf, nameForId };
}

/** Whether a configuration node names another algorithm (`{ name }`, optionally with metadata). */
const isAlgorithmReference = (node) =>
  typeof node?.name === 'string' && node.name.trim() !== ''
  && Object.keys(node).every((key) => key === 'name' || key === 'algorithmMetadata');

/** A copy of a configuration whose references `map` rewrote. */
function mapReferences(config, map) {
  return (function walk(node) {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const copy = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, walk(value)]));
    if (isAlgorithmReference(node)) copy.name = map(node.name.trim());
    return copy;
  })(config ?? {});
}

/**
 * The algorithms DCT manages, shaped as `delphix.listAlgorithms` shapes an engine's.
 *
 * Built-ins come with the `dlpx-core:` name, no `createdBy` (they are read-only, like an engine's
 * plugin instances) and `aliases`: the other spellings the plugin uses for the same algorithm.
 */
async function listAlgorithms(cfg) {
  const index = await algorithmIndex(cfg);
  const { classNameFor } = require('./delphix');
  return index.all.map((a) => {
    const name = index.nameOf(a);
    return {
      id: a.id,
      algorithmName: name,
      frameworkName: a.framework_name ?? null,
      frameworkPlugin: a.plugin_name ?? null,
      className: a.plugin_name === CORE_PLUGIN ? classNameFor(a.framework_name) : null,
      algorithmType: 'COMPONENT',
      description: a.description ?? '',
      createdBy: a.is_default_instance ? null : (a.account_name || 'dct'),
      tokenizationSupported: Boolean(a.is_tokenization_supported),
      config: mapReferences(a.config, index.nameForId),
      ...(a.is_default_instance ? { aliases: [builtinKey(name)] } : {}),
    };
  });
}

async function getAlgorithm(cfg, name) {
  const found = (await listAlgorithms(cfg)).find((a) => a.algorithmName === name);
  if (!found) throw new DctError(`Data Control Tower has no algorithm "${name}".`, 404);
  return { ...found, algorithmExtension: found.config };
}

/** The frameworks of DCT's own dlpx-core plugin, by name. */
async function coreFrameworks(cfg) {
  const plugins = await list(cfg, '/masking-plugins');
  const core = plugins.find((p) => p.name === CORE_PLUGIN && p.dct_managed)
    ?? plugins.find((p) => p.name === CORE_PLUGIN);
  return new Map((core?.frameworks ?? []).map((f) => [f.name, f.id]));
}

/** `delphix.frameworks` for DCT: the dlpx-core frameworks, in the engine's shape. */
async function frameworks(cfg) {
  return [...(await coreFrameworks(cfg))].map(([name, id]) => ({ id, name, plugin: CORE_PLUGIN }));
}

/**
 * Creates or updates an algorithm. `existingName` — or, without it, the name — finds the user's
 * algorithm of that name, which is updated by id instead of a twin being created beside it.
 */
async function saveAlgorithm(cfg, { name, className, config, description, existingName }) {
  const { frameworkNameFor } = require('./delphix');
  const frameworkName = frameworkNameFor(className);
  if (!frameworkName) throw new DctError(`No Delphix framework matches ${className}.`, 0);
  const frameworkId = (await coreFrameworks(cfg)).get(frameworkName);
  if (!frameworkId) {
    throw new DctError(
      `Data Control Tower has no "${frameworkName}" framework in its ${CORE_PLUGIN} plugin, so it cannot run this `
      + 'algorithm. Its masking plugin is likely older than the one this tool loads.', 0);
  }

  const index = await algorithmIndex(cfg);
  const missing = [];
  const translated = mapReferences(config, (ref) => {
    const target = index.resolve(ref);
    if (!target) missing.push(ref);
    return target ? target.id : ref;
  });
  if (missing.length) {
    throw new DctError(`Data Control Tower has no algorithm called ${missing.map((m) => `"${m}"`).join(', ')}.`, 404);
  }

  const target = existingName ?? name;
  const current = index.user.find((a) => a.name === target && a.framework_id === frameworkId)
    ?? index.user.find((a) => a.name === target);
  const empty = !config || Object.keys(config).length === 0;
  if (current) {
    if (empty && Object.keys(current.config ?? {}).length > 0) {
      throw new DctError(
        `The local copy of "${target}" has no configuration, and sending it would erase the one in `
        + 'Data Control Tower. Bring it down again first.', 0);
    }
    if (current.framework_id !== frameworkId) {
      throw new DctError(`Data Control Tower already has an algorithm called "${target}" on another framework.`, 409);
    }
    const renamed = name !== current.name;
    // Nothing to change is nothing to send — and, for a Checkdigit, the only way through: DCT
    // answers 500 to every update of one, however small (its own validate-config passes it).
    if (sameJson(current.config, translated) && (!description || description === (current.description ?? ''))) {
      return { mode: 'unchanged', name: current.name, id: current.id, renamed };
    }
    try {
      await write(cfg, 'PATCH', `/algorithms/${current.id}`, {
        config: translated, ...(description ? { description } : {}),
      });
    } catch (err) {
      if (err.status !== 500) throw err;
      throw new DctError(`Data Control Tower failed to update "${current.name}" (HTTP 500). It does this for every `
        + `change to a ${current.framework_name} algorithm; delete the algorithm there and send it again.`, 500);
    }
    return { mode: 'updated', name: current.name, id: current.id, renamed };
  }
  const out = await write(cfg, 'POST', '/algorithms', {
    name, framework_id: frameworkId, config: translated, ...(description ? { description } : {}),
  });
  return { mode: 'created', name, id: out?.id ?? null };
}

/** Whether two JSON values say the same thing, whatever the order of their keys. */
function sameJson(a, b) {
  const norm = (v) => (Array.isArray(v) ? v.map(norm)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])])) : v);
  return JSON.stringify(norm(a ?? {})) === JSON.stringify(norm(b ?? {}));
}

// ── Data classes (domains) ────────────────────────────────────────────────────

/** The data classes DCT manages, the user's before DCT's built-in ones of the same name. */
async function dataClasses(cfg) {
  const all = (await list(cfg, '/data-classes')).filter((d) => d.dct_managed);
  return [...all.filter((d) => !d.built_in), ...all.filter((d) => d.built_in)];
}

/** `delphix.listDomains` for DCT: one row per name, algorithms named as they are here. */
async function listDomains(cfg) {
  const [classes, index] = await Promise.all([dataClasses(cfg), algorithmIndex(cfg)]);
  const seen = new Set();
  const out = [];
  for (const d of classes) {
    if (seen.has(d.name)) continue;
    seen.add(d.name);
    out.push({
      id: d.id,
      domainName: d.name,
      description: d.description ?? '',
      defaultAlgorithmCode: d.default_algorithm_id ? index.nameForId(d.default_algorithm_id) : '',
      defaultTokenizationCode: d.default_token_algorithm_id ? index.nameForId(d.default_token_algorithm_id) : '',
      createdBy: d.built_in ? null : (d.account_name || 'dct'),
    });
  }
  return out;
}

async function getDomain(cfg, name) {
  const found = (await dataClasses(cfg)).find((d) => d.name === name);
  if (!found) throw new DctError(`Data Control Tower has no data class "${name}".`, 404);
  return found;
}

/**
 * Creates the data class, or updates the user's one of that name. DCT's built-in data classes
 * cannot be changed, so one of those is left as it is (`engine-owned`).
 */
async function saveDomain(cfg, { name, defaultAlgorithm, defaultTokenization, description }) {
  const index = await algorithmIndex(cfg);
  const idFor = (ref) => {
    if (!ref) return null;
    const a = index.resolve(ref);
    if (!a) throw new DctError(`Data Control Tower has no algorithm "${ref}" for the data class "${name}".`, 404);
    return a.id;
  };
  const algorithmId = idFor(defaultAlgorithm);
  if (!algorithmId) {
    throw new DctError(`Data Control Tower requires a default algorithm, and the data class "${name}" has none.`, 400);
  }
  const tokenId = idFor(defaultTokenization);
  const current = (await dataClasses(cfg)).find((d) => d.name === name);
  if (current?.built_in) return { mode: 'engine-owned', name, id: current.id };

  const body = {
    default_algorithm_id: algorithmId,
    ...(tokenId ? { default_token_algorithm_id: tokenId } : {}),
    ...(description ? { description } : {}),
  };
  if (current) {
    const same = current.default_algorithm_id === algorithmId
      && (current.default_token_algorithm_id ?? null) === (tokenId ?? null)
      && (!description || description === (current.description ?? ''));
    if (same) return { mode: 'unchanged', name, id: current.id };
    await write(cfg, 'PATCH', `/data-classes/${current.id}`, body);
    // A data class also lists the algorithms it may use; the defaults must be among them.
    const wanted = [algorithmId, tokenId].filter((id) => id && !(current.algorithm_ids ?? []).includes(id));
    if (wanted.length) await write(cfg, 'POST', `/data-classes/${current.id}/algorithms`, { algorithm_ids: wanted });
    return { mode: 'updated', name, id: current.id };
  }
  const out = await write(cfg, 'POST', '/data-classes', {
    name, ...body, algorithm_ids: [...new Set([algorithmId, tokenId].filter(Boolean))],
  });
  return { mode: 'created', name, id: out?.id ?? null };
}

async function deleteDomain(cfg, name) {
  const current = await getDomain(cfg, name);
  return write(cfg, 'DELETE', `/data-classes/${current.id}`);
}

// ── Uploads ───────────────────────────────────────────────────────────────────

async function uploadFile(cfg, name, content) {
  const form = new FormData();
  form.append('file', new Blob([content]), name);
  const data = await call(cfg, 'POST', '/masking-file-uploads', { form });
  forget('/masking-file-uploads');
  const reference = data?.file?.file_reference_id;
  if (!reference) throw new DctError(`Data Control Tower took "${name}" but gave back no address for it.`, 0);
  return reference;
}

async function uploadedFiles(cfg) {
  return new Set((await list(cfg, '/masking-file-uploads')).map((f) => f.file_reference_id).filter(Boolean));
}

/** DCT has no download for an uploaded file. The caller reports the file as still needed. */
async function classifierFiles() {
  throw new DctError('Data Control Tower offers no way to download an uploaded file.', 0);
}
const lookupFile = classifierFiles;

// ── Classifiers ───────────────────────────────────────────────────────────────

/** The classifier frameworks, name here → name in DCT (which is also its id there). */
async function classifierFrameworks() {
  return { ...CLASSIFIER_FRAMEWORK };
}

/** The classifiers DCT manages, in the engine's shape. Built-ins carry `builtIn`. */
async function listClassifiers(cfg) {
  return (await list(cfg, '/classifiers')).filter((c) => c.dct_managed).map((c) => ({
    classifierId: c.id,
    classifierName: c.name,
    frameworkId: c.framework,
    frameworkName: LOCAL_CLASSIFIER_FRAMEWORK[c.framework] ?? c.framework,
    domainName: c.data_class_name ?? '',
    description: c.description ?? '',
    classifierConfiguration: c.config ?? {},
    builtIn: Boolean(c.built_in),
  }));
}

async function getClassifier(cfg, id) {
  const c = await call(cfg, 'GET', `/classifiers/${encodeURIComponent(id)}`);
  return {
    classifierId: c.id, classifierName: c.name, frameworkId: c.framework,
    domainName: c.data_class_name ?? '', description: c.description ?? '',
    classifierConfiguration: c.config ?? {}, builtIn: Boolean(c.built_in),
  };
}

/**
 * Creates or updates a classifier. Identity is the id; without one, the user's classifier of the
 * same name is updated. DCT, unlike an engine, lets the framework change — with the config.
 */
async function saveClassifier(cfg, { name, framework, domain, config, description, existingId, prepareConfig }) {
  const dctFramework = CLASSIFIER_FRAMEWORK[framework];
  if (!dctFramework) throw new DctError(`Data Control Tower has no "${framework}" classifier framework.`, 0);
  const dataClass = (await dataClasses(cfg)).find((d) => d.name === domain);
  if (!dataClass) throw new DctError(`Data Control Tower has no data class "${domain}".`, 404);

  let current = null;
  if (existingId != null) {
    current = await getClassifier(cfg, existingId).catch((err) => {
      if (err.status === 404) return null;
      throw err;
    });
  }
  if (!current) {
    current = (await listClassifiers(cfg)).find((c) => c.classifierName === name && !c.builtIn) ?? null;
  }
  if (current?.builtIn) {
    throw new DctError(`"${name}" is one of Data Control Tower's built-in classifiers, which cannot be changed.`, 409);
  }
  const ready = prepareConfig ? await prepareConfig(current?.classifierConfiguration ?? null) : (config ?? {});
  const body = {
    name, framework: dctFramework, data_class_id: dataClass.id, config: ready,
    ...(description ? { description } : {}),
  };
  if (current) {
    const same = current.classifierName === name && current.frameworkId === dctFramework
      && current.domainName === domain && sameJson(current.classifierConfiguration, ready)
      && (current.description ?? '') === (description ?? '');
    if (same) return { mode: 'unchanged', id: current.classifierId, name };
    await write(cfg, 'PATCH', `/classifiers/${current.classifierId}`, body);
    return { mode: 'updated', id: current.classifierId, name };
  }
  const out = await write(cfg, 'POST', '/classifiers', body);
  return { mode: 'created', id: out?.id ?? null, name };
}

// ── Discovery policies (profile sets) ─────────────────────────────────────────

/** The discovery policies DCT manages, each with the ids of its classifiers. */
async function listProfileSets(cfg) {
  const policies = (await list(cfg, '/discovery-policies'))
    .filter((p) => p.dct_managed && p.discovery_method !== 'EXPRESSIONS');
  const out = [];
  for (const p of policies) {
    const members = await list(cfg, `/discovery-policies/${p.id}/classifiers`);
    out.push({
      profileSetId: p.id,
      profileSetName: p.name,
      description: p.description ?? '',
      assignmentThreshold: p.assignment_threshold,
      classifierIds: members.map((c) => c.id),
      builtIn: Boolean(p.built_in),
    });
  }
  return out;
}

async function getProfileSet(cfg, id) {
  const p = await call(cfg, 'GET', `/discovery-policies/${encodeURIComponent(id)}`);
  const members = await list(cfg, `/discovery-policies/${p.id}/classifiers`);
  return {
    profileSetId: p.id, profileSetName: p.name, description: p.description ?? '',
    assignmentThreshold: p.assignment_threshold, classifierIds: members.map((c) => c.id), builtIn: Boolean(p.built_in),
  };
}

/** Creates or updates a discovery policy, and makes its classifiers exactly `classifierIds`. */
async function saveProfileSet(cfg, { name, description, threshold, classifierIds, existingId }) {
  let current = null;
  if (existingId != null) {
    current = await getProfileSet(cfg, existingId).catch((err) => {
      if (err.status === 404) return null;
      throw err;
    });
  }
  if (!current) {
    current = (await listProfileSets(cfg)).find((s) => s.profileSetName === name && !s.builtIn) ?? null;
  }
  const ids = [...new Set(classifierIds.map(String))];
  const details = {
    name,
    ...(description ? { description } : {}),
    ...(threshold ? { assignment_threshold: Number(threshold) } : {}),
  };
  if (current) {
    await write(cfg, 'PATCH', `/discovery-policies/${current.profileSetId}`, details);
    const have = new Set(current.classifierIds.map(String));
    const add = ids.filter((id) => !have.has(id));
    const remove = [...have].filter((id) => !ids.includes(id));
    if (add.length) await write(cfg, 'POST', `/discovery-policies/${current.profileSetId}/classifiers`, { classifier_ids: add });
    if (remove.length) await write(cfg, 'POST', `/discovery-policies/${current.profileSetId}/classifiers/remove`, { classifier_ids: remove });
    return { mode: 'updated', id: current.profileSetId, name, descriptionCut: false };
  }
  const out = await write(cfg, 'POST', '/discovery-policies', { ...details, classifier_ids: ids });
  return { mode: 'created', id: out?.id ?? null, name, descriptionCut: false };
}

// ── Hook templates ────────────────────────────────────────────────────────────

async function listHookTemplates(cfg) {
  return (await list(cfg, '/hook-templates')).map((h) => ({
    id: h.id, name: h.name, description: h.description ?? '', shell: h.shell ?? 'bash',
    command: h.command ?? '', dctManaged: Boolean(h.dct_managed), engineId: h.engine_id ?? null,
    // Only which variables the script gets; whatever secret DCT holds for them stays there.
    credentials: (h.credentials_env_vars ?? []).map((c) => ({ base_var_name: c.base_var_name })),
  }));
}

/** Creates or updates a hook template, matched by id first and then by name among DCT's own. */
async function saveHookTemplate(cfg, { name, description, shell, command, existingId }) {
  const all = await listHookTemplates(cfg);
  const current = (existingId && all.find((h) => h.id === existingId && h.dctManaged))
    ?? all.find((h) => h.name === name && h.dctManaged);
  const body = { name, shell, command, ...(description ? { description } : {}) };
  if (current) {
    await write(cfg, 'PATCH', `/hook-templates/${current.id}`, body);
    return { mode: 'updated', id: current.id, name };
  }
  const out = await write(cfg, 'POST', '/hook-templates', body);
  return { mode: 'created', id: out?.hook_template?.id ?? null, name };
}

module.exports = {
  DctError, apiRoot, probe, list, waitForJob,
  frameworks, listAlgorithms, getAlgorithm, saveAlgorithm,
  listDomains, getDomain, saveDomain, deleteDomain,
  classifierFrameworks, listClassifiers, getClassifier, saveClassifier,
  listProfileSets, getProfileSet, saveProfileSet,
  uploadFile, uploadedFiles, classifierFiles, lookupFile,
  listHookTemplates, saveHookTemplate,
  builtinKey,
};
