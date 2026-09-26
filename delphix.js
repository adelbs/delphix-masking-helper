// Talks to a Delphix Continuous Compliance (Masking Engine) instance.
//
// API contract, read from a running instance's OpenAPI 3.0.1 spec (Masking API 5.1.49,
// served at /masking/api/swagger-basepath.json):
//
//   base            {host}/masking/api        — unversioned, resolves to the newest version.
//                                               A pinned /v5.1.49 also works but would break
//                                               against an instance on any other version.
//   POST /login     {username, password} -> 201 {Authorization: "<token>"}   (no auth needed)
//   header          Authorization: <token>    — the raw token, not "Bearer <token>"
//   GET  /algorithms?page_size=N              -> {responseList: [Algorithm], _pageInfo}
//   GET  /algorithms/{algorithmName}          -> Algorithm
//   POST /algorithms          (Algorithm)     -> 201 AsyncTask
//   PUT  /algorithms/{name}   (Algorithm)     -> 200 AsyncTask
//   GET  /algorithm/frameworks/               -> {responseList: [AlgorithmFramework]}
//   GET  /domains?page_size=N                 -> {responseList: [Domain], _pageInfo}
//   POST /domains             (Domain)        -> 201 Domain          (409 on a name clash)
//   PUT  /domains/{domainName} (Domain)       -> 200 Domain
//   DELETE /domains/{domainName}              -> 200
//
// An Algorithm on the engine is {algorithmName, algorithmType, frameworkId,
// algorithmExtension}. `algorithmExtension` is the same configuration object this tool
// already stores locally, which is what makes import and export a field mapping rather
// than a translation.
//
// A Domain is smaller still: {domainName, defaultAlgorithmCode, defaultTokenizationCode}
// plus a read-only createdBy. The two codes are algorithmName values — a domain is a name
// and two references, nothing more. domainName is the identity and travels in the path, so
// it cannot be renamed, exactly like algorithmName.

const https = require('node:https');
const zlib = require('node:zlib');

// Generated from the plugin JAR: MaskingComponent.getName() per framework class.
// These are the frameworkName values the Masking Engine reports in GET /algorithm/frameworks/.
const FRAMEWORK_BY_CLASS = {
  'algorithm.plugin.address.MultiColumnAddress': 'Multi Column Address',
  'algorithm.plugin.binaryLookup.BinaryLookup': 'Binary Lookup',
  'algorithm.plugin.characterMapping.CharacterMapping': 'Character Mapping',
  'algorithm.plugin.characterMapping.NumericMapping': 'CM Numeric',
  'algorithm.plugin.characterMapping.PaymentCard': 'Payment Card',
  'algorithm.plugin.characterReplacement.CharacterReplacement': 'Character Replacement',
  'algorithm.plugin.checkdigit.Checkdigit': 'Checkdigit',
  'algorithm.plugin.conditional.MultiColumnCondition': 'Multi Column Condition',
  'algorithm.plugin.dataCleansing.DataCleansing': 'Data Cleansing',
  'algorithm.plugin.dateAlgorithms.DateReplacement': 'Date Replacement',
  'algorithm.plugin.dateAlgorithms.DateShift': 'Date Shift',
  'algorithm.plugin.dateAlgorithms.DateShiftDiscrete': 'Date Shift Discrete',
  'algorithm.plugin.dateAlgorithms.DateShiftVariable': 'Date Shift Variable',
  'algorithm.plugin.dateAlgorithms.DependentDateShift': 'Dependent Date Shift',
  'algorithm.plugin.decompose.RegexDecompose': 'Regex Decompose',
  'algorithm.plugin.email.Email': 'Email',
  'algorithm.plugin.expression.NumericExpression': 'Numeric Expression',
  'algorithm.plugin.financialId.FinancialIdBr': 'BR - Financial ID',
  'algorithm.plugin.freeTextRedaction.FreeTextRedaction': 'Free Text Redaction',
  'algorithm.plugin.iban.IBAN': 'IBAN',
  'algorithm.plugin.mapping.Mapping': 'Mapping',
  'algorithm.plugin.minMax.MinMaxBigDecimal': 'MinMax Number',
  'algorithm.plugin.minMax.MinMaxLocalDateTime': 'MinMax Date',
  'algorithm.plugin.name.FullName': 'FullName',
  'algorithm.plugin.name.Name': 'Name',
  'algorithm.plugin.nullSecureLookup.NullSecureLookup': 'Null Secure Lookup',
  'algorithm.plugin.phone.Phone': 'Phone',
  'algorithm.plugin.redact.Redact': 'Redact Input',
  'algorithm.plugin.repeatFirstDigit.RepeatFirstDigit': 'Repeat First Digit',
  'algorithm.plugin.secureLookup.SecureLookup': 'Secure Lookup',
  'algorithm.plugin.segmentMapping.SegmentMapping': 'Segment Mapping',
  'algorithm.plugin.shuffle.Shuffle': 'Shuffle',
  'algorithm.plugin.stringAlgorithmChain.StringAlgorithmChain': 'String Algorithm Chain',
  'algorithm.plugin.tokenization.Tokenization': 'Tokenization',
};

const CLASS_BY_FRAMEWORK = Object.fromEntries(
  Object.entries(FRAMEWORK_BY_CLASS).map(([cls, name]) => [name, cls]),
);

/** The engine's frameworkName for one of our classNames, or null if the plugin has none. */
function frameworkNameFor(className) {
  return FRAMEWORK_BY_CLASS[className] ?? null;
}

/** Our className for an engine frameworkName, or null when the framework is one we do not expose. */
function classNameFor(frameworkName) {
  return CLASS_BY_FRAMEWORK[frameworkName] ?? null;
}

// ── Settings ──────────────────────────────────────────────────────────────────

const DEFAULTS = {
  'delphix.baseUrl': '',
  'delphix.username': '',
  'delphix.password': '',
  // Lab engines commonly serve a self-signed certificate; opting out of verification is a
  // deliberate, per-instance choice rather than a silent default.
  'delphix.allowSelfSigned': 'false',
};

function settings(config) {
  return {
    baseUrl: String(config['delphix.baseUrl'] || '').replace(/\/+$/, ''),
    username: config['delphix.username'] || '',
    password: config['delphix.password'] || '',
    allowSelfSigned: String(config['delphix.allowSelfSigned']) === 'true',
  };
}

const isConfigured = (cfg) => Boolean(cfg.baseUrl && cfg.username && cfg.password);

// ── Text the engine refuses ───────────────────────────────────────────────────
//
// The Masking API answers "Invalid character '(' in field 'description'" for any of these in the
// text of a classifier or a profile set — the description included, and the description is prose:
// "datos sensibles (art. 2, VI)". An algorithm's description is not checked. Refusing commas and
// parentheses here would push the problem onto every preset and every user, so the text goes up
// with each refused character swapped for one that reads the same, and comes back down swapped
// again. The row here keeps what was written.

const ENGINE_LOOKALIKE = {
  '~': '\u223C', '!': '\u01C3', '@': '\uFF20', '#': '\uFF03', '$': '\uFF04', '%': '\uFF05',
  '^': '\u02C6', '&': '\uFF06', '*': '\u2217', '(': '\uFF08', ')': '\uFF09', '"': '\u201D',
  '?': '\uFF1F', ':': '\u2236', ';': '\uFF1B', ',': '\u201A', '/': '\u2215', '\\': '\u2216',
  '`': '\u02CB', '+': '\uFF0B', '=': '\uFF1D', '[': '\uFF3B', ']': '\uFF3D', '{': '\uFF5B',
  '}': '\uFF5D', '|': '\u01C0', '<': '\u2039', '>': '\u203A', "'": '\u2019',
};
const FROM_LOOKALIKE = Object.fromEntries(Object.entries(ENGINE_LOOKALIKE).map(([a, b]) => [b, a]));
const REFUSED_RE = new RegExp(`[${Object.keys(ENGINE_LOOKALIKE).map((c) => `\\${c}`).join('')}]`, 'g');
const LOOKALIKE_RE = new RegExp(`[${Object.keys(FROM_LOOKALIKE).join('')}]`, 'g');

/** Text as the engine will take it in a classifier or profile set. */
const toEngineText = (text) => String(text ?? '').replace(REFUSED_RE, (c) => ENGINE_LOOKALIKE[c]);

/** Text from the engine, with the swapped characters put back. */
const fromEngineText = (text) => String(text ?? '').replace(LOOKALIKE_RE, (c) => FROM_LOOKALIKE[c]);

/**
 * The engine keeps at most 50 characters of a profile set's description (a classifier's has no
 * such limit). One more and it refuses the whole set with "Input does not match the expected
 * structure", which names neither the field nor the limit — and it comes last, after every
 * classifier in the set has already been sent. So the description is cut to fit, at a word where
 * one is near, and the row here keeps the whole of it.
 */
const PROFILE_SET_DESCRIPTION_MAX = 50;

function engineSetDescription(text) {
  const full = toEngineText(text);
  if (full.length <= PROFILE_SET_DESCRIPTION_MAX) return full;
  const cut = full.slice(0, PROFILE_SET_DESCRIPTION_MAX - 1);
  const space = cut.lastIndexOf(' ');
  const kept = space > PROFILE_SET_DESCRIPTION_MAX / 2 ? cut.slice(0, space) : cut;
  // A comma or a colon left hanging before the ellipsis reads like a typo.
  return `${kept.replace(/[\s\u201A\u2236\uFF1B.-]+$/u, '')}\u2026`;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

/** The API root. Accepts either the engine host or a URL already ending in /masking/api. */
function apiRoot(baseUrl) {
  const url = /^https?:\/\//i.test(baseUrl) ? baseUrl : `http://${baseUrl}`;
  return /\/masking\/api$/.test(url) ? url : `${url.replace(/\/+$/, '')}/masking/api`;
}

class DelphixError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * One request to the engine. JSON both ways by default; `form` sends multipart (an upload) and
 * `binary` returns the body as a Buffer (a download). Files can be large, so those get longer.
 */
async function call(cfg, method, path, { token, body, form, binary } = {}) {
  const url = `${apiRoot(cfg.baseUrl)}${path}`;
  const opts = {
    method,
    headers: { Accept: binary ? '*/*' : 'application/json' },
    signal: AbortSignal.timeout(form || binary ? 300000 : 30000),
  };
  if (token) opts.headers.Authorization = token;
  if (form) {
    opts.body = form;   // fetch writes the multipart boundary into Content-Type itself
  } else {
    opts.headers['Content-Type'] = 'application/json';
    if (body !== undefined) opts.body = JSON.stringify(body);
  }
  if (cfg.allowSelfSigned && url.startsWith('https:')) {
    opts.agent = new https.Agent({ rejectUnauthorized: false });
  }

  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    throw new DelphixError(
      `Could not reach the Delphix engine at ${apiRoot(cfg.baseUrl)} — ${err.message}`, 0);
  }

  const raw = Buffer.from(await res.arrayBuffer());
  if (binary && res.ok) return raw;
  const text = raw.toString('utf8');
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { /* non-JSON error page */ } }

  if (!res.ok) {
    // The engine reports failures as {errorMessage} and, for validation, {errors:[…]}.
    const detail = data?.errorMessage
      || (Array.isArray(data?.errors) ? data.errors.join('; ') : null)
      || (text ? text.slice(0, 300) : `HTTP ${res.status}`);
    throw new DelphixError(detail, res.status);
  }
  return data;
}

// ── Session ───────────────────────────────────────────────────────────────────

// The engine expires tokens on its own schedule (API_AUTHORIZATION_TIMEOUT), so the token is
// cached but every caller retries a login once on 401 rather than trusting the cache.
let cached = { key: null, token: null };

const cacheKey = (cfg) => `${apiRoot(cfg.baseUrl)}|${cfg.username}`;

async function login(cfg) {
  const data = await call(cfg, 'POST', '/login', {
    body: { username: cfg.username, password: cfg.password },
  });
  const token = data?.Authorization;
  if (!token) throw new DelphixError('The engine accepted the login but returned no token.', 0);
  cached = { key: cacheKey(cfg), token };
  return token;
}

async function token(cfg) {
  if (cached.key === cacheKey(cfg) && cached.token) return cached.token;
  return login(cfg);
}

/** Runs an authenticated call, logging in again once if the cached token has expired. */
async function authCall(cfg, method, path, options = {}) {
  try {
    return await call(cfg, method, path, { ...options, token: await token(cfg) });
  } catch (err) {
    if (err.status !== 401) throw err;
    cached = { key: null, token: null };
    return call(cfg, method, path, { ...options, token: await login(cfg) });
  }
}

const auth = (cfg, method, path, body) => authCall(cfg, method, path, { body });

// ── Operations ────────────────────────────────────────────────────────────────

/** Verifies the credentials and reports the engine's API version. */
async function probe(cfg) {
  if (!isConfigured(cfg)) return { ok: false, error: 'not-configured' };
  try {
    await login(cfg);
    return { ok: true, apiRoot: apiRoot(cfg.baseUrl) };
  } catch (err) {
    return { ok: false, error: err.message, status: err.status };
  }
}

/**
 * The frameworks installed on the engine.
 *
 * The plugin name matters: framework names are not unique across plugins — a stock engine
 * carries both a dlpx-core "IBAN" and one from a separate IBAN plugin. Ours are the
 * dlpx-core ones, and picking by name alone would sometimes attach the wrong framework.
 */
async function frameworks(cfg) {
  const data = await auth(cfg, 'GET', '/algorithm/frameworks/?page_size=500');
  return (data?.responseList ?? []).map((f) => ({
    id: f.frameworkId,
    name: f.frameworkName,
    plugin: f.plugin?.pluginName ?? null,
  }));
}

const CORE_PLUGIN = 'dlpx-core';

/** The dlpx-core frameworkId for a framework name, or undefined when the engine lacks it. */
function coreFrameworkId(list, frameworkName) {
  return list.find((f) => f.name === frameworkName && f.plugin === CORE_PLUGIN)?.id;
}

/**
 * Every algorithm on the engine, with our className resolved where we can run it.
 *
 * GET /algorithms returns frameworkId but not frameworkName, so the frameworks are fetched
 * and joined on the id — reading the name straight off the algorithm would leave every row
 * unidentified.
 */
async function listAlgorithms(cfg) {
  const [data, fw] = await Promise.all([
    auth(cfg, 'GET', '/algorithms?page_size=500'),
    frameworks(cfg),
  ]);
  const byId = new Map(fw.map((f) => [f.id, f]));
  return (data?.responseList ?? []).map((a) => {
    const f = byId.get(a.frameworkId);
    // Only dlpx-core frameworks map onto the classes this tool can run; a same-named
    // framework from another plugin is a different algorithm.
    const className = f && f.plugin === CORE_PLUGIN ? classNameFor(f.name) : null;
    return {
      algorithmName: a.algorithmName,
      frameworkName: f?.name ?? null,
      frameworkPlugin: f?.plugin ?? null,
      className,
      algorithmType: a.algorithmType,
      description: a.description ?? '',
      // Absent on the instances a plugin installs, which are read-only and come with the plugin.
      createdBy: a.createdBy ?? null,
      // What a domain's tokenization algorithm must be: the engine refuses any other.
      tokenizationSupported: Boolean(a.isTokenizationSupported),
      config: a.algorithmExtension ?? {},
    };
  });
}

/**
 * The domains on the engine.
 *
 * `defaultAlgorithmCode` is an algorithmName, not an id, so it joins straight onto the
 * algorithm list — and onto our own saved algorithms, which are keyed by name too.
 */
async function listDomains(cfg) {
  const data = await auth(cfg, 'GET', '/domains?page_size=500');
  return (data?.responseList ?? []).map((d) => ({
    domainName: d.domainName,
    defaultAlgorithmCode: d.defaultAlgorithmCode ?? '',
    defaultTokenizationCode: d.defaultTokenizationCode ?? '',
    createdBy: d.createdBy ?? null,
  }));
}

async function getDomain(cfg, name) {
  return auth(cfg, 'GET', `/domains/${encodeURIComponent(name)}`);
}

/**
 * Creates the domain, or updates it when the engine already has that name.
 *
 * Which of the two is decided by asking, not by remembering: unlike an algorithm, a domain
 * carries no configuration worth protecting, so a GET is cheap and always right — including
 * for a domain someone else created on the engine after we imported.
 */
async function saveDomain(cfg, { name, defaultAlgorithm, defaultTokenization }) {
  const payload = {
    domainName: name,
    ...(defaultAlgorithm ? { defaultAlgorithmCode: defaultAlgorithm } : {}),
    ...(defaultTokenization ? { defaultTokenizationCode: defaultTokenization } : {}),
  };
  const exists = await getDomain(cfg, name).then(() => true).catch(() => false);
  if (exists) {
    const path = `/domains/${encodeURIComponent(name)}`;
    return { mode: 'updated', name, result: await auth(cfg, 'PUT', path, payload) };
  }
  return { mode: 'created', name, result: await auth(cfg, 'POST', '/domains', payload) };
}

async function deleteDomain(cfg, name) {
  return auth(cfg, 'DELETE', `/domains/${encodeURIComponent(name)}`);
}

// Schemes the runner resolves by itself: a path on this machine, and the plugin's own
// jar entries. Anything else is held by the engine.
const LOCAL_FILE_SCHEMES = new Set(['file', 'jar']);

/**
 * The file name inside a reference the runner cannot resolve on its own, or null.
 *
 * A file uploaded to an engine stays in the engine's file store, and the algorithm carries
 * only a reference to it — "delphix-file://upload/<id>/<name>.txt". Importing brings the
 * reference down; the contents never move.
 */
function engineFileName(value) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(\S*)$/i.exec(String(value).trim());
  if (!m || LOCAL_FILE_SCHEMES.has(m[1].toLowerCase())) return null;
  const path = m[2].split(/[?#]/)[0];
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (!name) return null;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;   // a stray % in the name — take it literally rather than losing the file
  }
}

/**
 * Every string in a configuration, at any depth.
 *
 * Walked rather than read off known fields: file references appear at different depths
 * depending on the framework, and a sub-algorithm can carry one of its own.
 */
function configStrings(config) {
  const out = [];
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const value of Object.values(node)) {
      if (typeof value === 'string') out.push(value);
      else walk(value);
    }
  })(config);
  return out;
}

/** Every engine-held file an algorithm configuration expects to read. */
function engineFileNames(config) {
  const names = new Set();
  for (const value of configStrings(config)) {
    const name = engineFileName(value);
    if (name) names.add(name);
  }
  return [...names];
}

const getAlgorithm = (cfg, name) =>
  auth(cfg, 'GET', `/algorithms/${encodeURIComponent(name)}`);

/**
 * Creates or replaces an algorithm on the engine.
 * `existingName` is set when the local algorithm came from this engine — then it is updated
 * in place instead of a second copy being created beside it.
 */
async function saveAlgorithm(cfg, { name, className, config, description, existingName }) {
  const empty = !config || Object.keys(config).length === 0;

  const frameworkName = frameworkNameFor(className);
  if (!frameworkName) {
    throw new DelphixError(`No Delphix framework matches ${className}.`, 0);
  }
  const frameworkId = coreFrameworkId(await frameworks(cfg), frameworkName);
  if (frameworkId === undefined) {
    throw new DelphixError(
      `This engine has no "${frameworkName}" framework in its ${CORE_PLUGIN} plugin, so it cannot run this `
      + 'algorithm. Its masking plugin is likely older than the one this tool loads.', 0);
  }

  const payload = {
    algorithmName: name,
    algorithmType: 'COMPONENT',
    frameworkId,
    algorithmExtension: config ?? {},
    ...(description ? { description } : {}),
  };

  if (existingName) {
    // Replacing a real configuration with an empty one is destructive and never intentional:
    // it would leave the engine's algorithm stripped of every parameter.
    if (empty) {
      const current = await getAlgorithm(cfg, existingName).catch(() => null);
      if (current && Object.keys(current.algorithmExtension ?? {}).length > 0) {
        throw new DelphixError(
          `The local copy of "${existingName}" has no configuration, and sending it would erase `
          + 'the one on the engine. Import the algorithm again to pull its configuration down first.',
          0);
      }
    }
    const path = `/algorithms/${encodeURIComponent(existingName)}`;
    // The engine rejects a changed algorithmName on update ("Cannot update 'algorithmName'
    // field"), so the payload always carries the name it already has there.
    const task = await waitForTask(cfg, await auth(cfg, 'PUT', path, { ...payload, algorithmName: existingName }));
    return { mode: 'updated', name: existingName, task, renamed: name !== existingName };
  }
  return { mode: 'created', name, task: await waitForTask(cfg, await auth(cfg, 'POST', '/algorithms', payload)) };
}

// ── Tasks, uploads and downloads ──────────────────────────────────────────────

const FINISHED = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

/**
 * Waits for an AsyncTask and fails when it did.
 *
 * Creating or updating an algorithm answers 200 with a task that can still end in FAILED — a
 * lookup file the engine cannot find, for one — so the HTTP answer alone is not a success.
 */
async function waitForTask(cfg, task, { timeoutMs = 120000 } = {}) {
  if (!task?.asyncTaskId) return task;
  const deadline = Date.now() + timeoutMs;
  let current = task;
  while (!FINISHED.has(current.status)) {
    if (Date.now() > deadline) {
      throw new DelphixError(`The engine is still running ${task.operation ?? 'the task'} (#${task.asyncTaskId}). Check it there before trying again.`, 0);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    current = await auth(cfg, 'GET', `/async-tasks/${task.asyncTaskId}`);
  }
  if (current.status !== 'SUCCEEDED') {
    throw new DelphixError(current.exceptionDetail
      || `The engine's ${current.operation ?? 'task'} ended as ${current.status.toLowerCase()}.`, 0);
  }
  return current;
}

/** Puts a file in the engine's upload store and returns the address a configuration can name. */
async function uploadFile(cfg, name, content) {
  const form = new FormData();
  form.append('file', new Blob([content]), name);
  const data = await authCall(cfg, 'POST', '/file-uploads', { form });
  if (!data?.fileReferenceId) throw new DelphixError(`The engine took "${name}" but gave back no address for it.`, 0);
  return data.fileReferenceId;
}

/**
 * The addresses the engine's upload store can resolve right now.
 *
 * A new algorithm or classifier may only name one of these. An existing one keeps whatever it
 * already names — files uploaded long ago leave the store but stay valid on their owners.
 */
async function uploadedFiles(cfg) {
  const out = new Set();
  let seen = 0;
  for (let page = 1; ; page++) {
    const data = await auth(cfg, 'GET', `/file-uploads?page_size=500&page_number=${page}`);
    const list = data?.responseList ?? [];
    seen += list.length;
    for (const f of list) if (f.fileReferenceId) out.add(f.fileReferenceId);
    if (list.length === 0 || seen >= (data?._pageInfo?.total ?? seen)) break;
  }
  return out;
}

/** Waits for an export task and fetches what it produced. */
async function downloadResult(cfg, task) {
  const done = await waitForTask(cfg, task);
  // The reference is the download id as the engine wrote it (base64 with its padding); sent as is.
  return authCall(cfg, 'GET', `/file-downloads/${done.reference}`, { binary: true });
}

/**
 * A LIST classifier's files as the engine holds them: `{ reference, content }` per address.
 *
 * The engine hands them over as one zip whose entries are named after the upload — the address
 * `delphix-file://upload/f_<id>/<name>` becomes the entry `f_<id>_<name>` — so an entry is
 * matched to its address by that upload id.
 */
async function classifierFiles(cfg, classifierId, config) {
  const references = [...new Set(configStrings(config).filter((v) => engineFileName(v)))];
  if (!references.length) return [];
  const task = await auth(cfg, 'POST', `/classifiers/${encodeURIComponent(classifierId)}/export-files`);
  const entries = readZip(await downloadResult(cfg, task));
  const out = [];
  for (const reference of references) {
    const parts = reference.trim().split(/[?#]/)[0].split('/');
    const uploadId = parts[parts.length - 2];
    const entry = uploadId && entries.find((e) => e.name.startsWith(`${uploadId}_`));
    if (entry) out.push({ reference, content: entry.content });
  }
  return out;
}

/** A Secure Lookup algorithm's lookup file, exactly as it was uploaded. */
async function lookupFile(cfg, algorithmName) {
  const task = await auth(cfg, 'POST', `/algorithms/${encodeURIComponent(algorithmName)}/export-lookup-values`);
  return downloadResult(cfg, task);
}

/**
 * The files in a zip archive, as `{ name, content }`.
 *
 * Read from the central directory, stored or deflated entries only — which is what the engine
 * writes. Small enough not to be worth a dependency.
 */
function readZip(buffer) {
  const notZip = () => new DelphixError('The engine sent a download that is not a readable zip archive.', 0);
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw notZip();
  const entries = [];
  let at = buffer.readUInt32LE(end + 16);
  for (let n = buffer.readUInt16LE(end + 10); n > 0; n--) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) throw notZip();
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const skip = nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
    const header = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + skip;
    if (name.endsWith('/')) continue;
    const start = header + 30 + buffer.readUInt16LE(header + 26) + buffer.readUInt16LE(header + 28);
    const data = buffer.subarray(start, start + size);
    if (method === 0) entries.push({ name, content: Buffer.from(data) });
    else if (method === 8) entries.push({ name, content: zlib.inflateRawSync(data) });
    else throw new DelphixError(`"${name}" in the engine's download is compressed in a way this tool does not read.`, 0);
  }
  return entries;
}

// ── References inside a configuration ─────────────────────────────────────────

/**
 * Whether a configuration node names another algorithm. The plugin's schemas give every such
 * field the same shape: `{ name }`, optionally with `algorithmMetadata`.
 */
const isAlgorithmReference = (node) =>
  typeof node?.name === 'string' && node.name.trim() !== ''
  && Object.keys(node).every((key) => key === 'name' || key === 'algorithmMetadata');

/** Every algorithm a configuration names, at any depth. */
function algorithmReferenceNames(config) {
  const names = new Set();
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (isAlgorithmReference(node)) names.add(node.name.trim());
    for (const value of Object.values(node)) walk(value);
  })(config);
  return [...names];
}

/**
 * A copy of a configuration with references swapped: `algorithms` renames what the reference
 * objects name, `files` replaces file addresses. Values not in either map are left alone.
 */
function rewriteConfig(config, { algorithms = {}, files = {} } = {}) {
  return (function walk(node) {
    if (typeof node === 'string') return Object.hasOwn(files, node) ? files[node] : node;
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const copy = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, walk(value)]));
    if (isAlgorithmReference(node) && Object.hasOwn(algorithms, node.name.trim())) copy.name = algorithms[node.name.trim()];
    return copy;
  })(config);
}

// ── Classifiers ───────────────────────────────────────────────────────────────

/**
 * The classifier frameworks, name → id. Ids belong to an engine, so a classifier's framework
 * is kept locally by name and resolved against whichever engine it is sent to.
 */
async function classifierFrameworks(cfg) {
  const data = await auth(cfg, 'GET', '/classifiers/frameworks');
  return Object.fromEntries((data?.responseList ?? []).map((f) => [f.frameworkName, f.frameworkId]));
}

/** Every classifier on the engine. A stock one holds over three hundred, so it is read page by page. */
async function listClassifiers(cfg) {
  const out = [];
  for (let page = 1; ; page++) {
    const data = await auth(cfg, 'GET', `/classifiers?page_size=500&page_number=${page}`);
    const list = data?.responseList ?? [];
    out.push(...list);
    const total = data?._pageInfo?.total ?? out.length;
    if (list.length === 0 || out.length >= total) break;
  }
  return out;
}

const getClassifier = (cfg, id) => auth(cfg, 'GET', `/classifiers/${encodeURIComponent(id)}`);

/**
 * Creates or updates a classifier.
 *
 * Identity is the id, not the name — the engine renames a classifier on PUT — so an update goes
 * by `existingId`. Without one, a classifier of the same name already on the engine is updated
 * rather than answered with 409. Either way the framework stays what the engine has: it refuses
 * to change it ("Cannot update 'frameworkId' field"), and a same-named classifier on another
 * framework is a different thing that must not be overwritten.
 */
async function saveClassifier(cfg, { name, framework, domain, config, description, existingId, prepareConfig }) {
  const payload = {
    classifierName: name,
    domainName: domain,
    classifierConfiguration: config ?? {},
    ...(description ? { description: toEngineText(description) } : {}),
  };
  const ids = await classifierFrameworks(cfg);
  const frameworkId = ids[framework];
  if (frameworkId === undefined) {
    throw new DelphixError(`This engine has no "${framework}" classifier framework.`, 0);
  }

  let current = null;
  if (existingId != null) {
    current = await getClassifier(cfg, existingId).catch((err) => {
      if (err.status === 404) return null;   // deleted on the engine since — create it again
      throw err;
    });
  }
  if (!current) current = (await listClassifiers(cfg)).find((c) => c.classifierName === name) ?? null;

  if (current && current.frameworkId !== frameworkId) {
    throw new DelphixError(
      `The engine already has a classifier named "${name}" built on another framework.`, 409);
  }
  // The caller settles what the configuration may name only now that it can see what the engine
  // already has — a file an existing classifier owns stays valid there, a new one's must be uploaded.
  if (prepareConfig) payload.classifierConfiguration = await prepareConfig(current?.classifierConfiguration ?? null);

  if (current) {
    const result = await auth(cfg, 'PUT', `/classifiers/${current.classifierId}`,
      { ...payload, frameworkId: current.frameworkId });
    return { mode: 'updated', id: current.classifierId, name, result };
  }
  const result = await auth(cfg, 'POST', '/classifiers', { ...payload, frameworkId });
  return { mode: 'created', id: result?.classifierId ?? null, name, result };
}

// ── Profile sets ──────────────────────────────────────────────────────────────
//
// A profile set is what a profiling job actually runs: a named selection of classifiers and the
// confidence a domain has to reach before the job assigns it. It holds `classifierIds`, so a set
// means nothing without the classifiers it names — which is why importing one brings them along.

/** Every profile set on the engine, page by page like the classifiers. */
async function listProfileSets(cfg) {
  const out = [];
  for (let page = 1; ; page++) {
    const data = await auth(cfg, 'GET', `/profile-sets?page_size=500&page_number=${page}`);
    const list = data?.responseList ?? [];
    out.push(...list);
    const total = data?._pageInfo?.total ?? out.length;
    if (list.length === 0 || out.length >= total) break;
  }
  return out;
}

const getProfileSet = (cfg, id) => auth(cfg, 'GET', `/profile-sets/${encodeURIComponent(id)}`);

/**
 * Creates or updates a profile set.
 *
 * Identity is the id, as with a classifier: the engine renames a set in place. Without a known
 * id, a set of the same name is updated rather than answered with 409.
 */
async function saveProfileSet(cfg, { name, description, threshold, classifierIds, existingId }) {
  const payload = {
    profileSetName: name,
    classifierIds: classifierIds.map(Number),
    ...(description ? { description: engineSetDescription(description) } : {}),
    ...(threshold ? { assignmentThreshold: Number(threshold) } : {}),
  };
  const descriptionCut = Boolean(description) && toEngineText(description) !== payload.description;

  let current = null;
  if (existingId != null) {
    current = await getProfileSet(cfg, existingId).catch((err) => {
      if (err.status === 404) return null;   // deleted on the engine since — create it again
      throw err;
    });
  }
  if (!current) current = (await listProfileSets(cfg)).find((s) => s.profileSetName === name) ?? null;

  if (current) {
    const result = await auth(cfg, 'PUT', `/profile-sets/${current.profileSetId}`, payload);
    return { mode: 'updated', id: current.profileSetId, name, result, descriptionCut };
  }
  const result = await auth(cfg, 'POST', '/profile-sets', payload);
  return { mode: 'created', id: result?.profileSetId ?? null, name, result, descriptionCut };
}

module.exports = {
  DEFAULTS, settings, isConfigured, apiRoot, probe, toEngineText, fromEngineText, engineSetDescription,
  frameworks, coreFrameworkId, listAlgorithms, getAlgorithm, saveAlgorithm,
  listDomains, getDomain, saveDomain, deleteDomain,
  classifierFrameworks, listClassifiers, getClassifier, saveClassifier,
  listProfileSets, getProfileSet, saveProfileSet,
  frameworkNameFor, classNameFor, FRAMEWORK_BY_CLASS,
  engineFileName, engineFileNames, configStrings,
  waitForTask, uploadFile, uploadedFiles, classifierFiles, lookupFile, readZip,
  algorithmReferenceNames, rewriteConfig,
};
