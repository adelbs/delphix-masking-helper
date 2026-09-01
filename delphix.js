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
//
// An Algorithm on the engine is {algorithmName, algorithmType, frameworkId,
// algorithmExtension}. `algorithmExtension` is the same configuration object this tool
// already stores locally, which is what makes import and export a field mapping rather
// than a translation.

const https = require('node:https');

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

async function call(cfg, method, path, { token, body } = {}) {
  const url = `${apiRoot(cfg.baseUrl)}${path}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  };
  if (token) opts.headers.Authorization = token;
  if (body !== undefined) opts.body = JSON.stringify(body);
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

  const text = await res.text();
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
async function auth(cfg, method, path, body) {
  try {
    return await call(cfg, method, path, { token: await token(cfg), body });
  } catch (err) {
    if (err.status !== 401) throw err;
    cached = { key: null, token: null };
    return call(cfg, method, path, { token: await login(cfg), body });
  }
}

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
      config: a.algorithmExtension ?? {},
    };
  });
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
    const task = await auth(cfg, 'PUT', path, { ...payload, algorithmName: existingName });
    return { mode: 'updated', name: existingName, task, renamed: name !== existingName };
  }
  return { mode: 'created', name, task: await auth(cfg, 'POST', '/algorithms', payload) };
}

module.exports = {
  DEFAULTS, settings, isConfigured, apiRoot, probe,
  frameworks, coreFrameworkId, listAlgorithms, getAlgorithm, saveAlgorithm,
  frameworkNameFor, classNameFor, FRAMEWORK_BY_CLASS,
};
