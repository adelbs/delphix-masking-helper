const express = require('express');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const ai = require('./ai');
const delphix = require('./delphix');

const app = express();
app.use(express.json());
const DIST = path.join(__dirname, 'frontend', 'dist');
app.use(express.static(DIST));

// ── Version ───────────────────────────────────────────────────────────────────

/**
 * What version this is, resolved once at startup.
 *
 * The git tag is the authority, not package.json: the installer checks out
 * `--depth 1 --branch vX.Y.Z` detached and `update` fetches the tag by name, so an installed
 * tree always carries the exact tag it was installed from. package.json has to be bumped by
 * hand and has already drifted once, so it is only the fallback — for a zip download, or a
 * fork that has never tagged.
 *
 * Nothing here touches the network. The version shown is the one on disk; there is no check
 * for a newer release, deliberately — the tool does not call home.
 */
function detectVersion() {
  const pkgVersion = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || null;
    } catch { return null; }
  })();

  const git = (...args) => execFileSync('git', ['-C', __dirname, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();

  try {
    const commit = git('rev-parse', '--short', 'HEAD');

    // On a release tag exactly: that tag is the version. --dirty still matters here — a tree
    // sitting on the tag with edits on top is not that release, and claiming it is would send
    // a bug report chasing code the reporter does not actually have.
    try {
      const tag = git('describe', '--tags', '--exact-match', '--dirty');
      if (!tag.endsWith('-dirty')) return { display: tag, commit, channel: 'release' };
      return { display: tag, commit, channel: 'dev' };
    } catch { /* not sitting on a tag — fall through to the development form */ }

    // Otherwise the nearest tag plus the distance from it, which says "ahead of v1.0.3"
    // rather than pretending to be a release. --always keeps this working before the first tag.
    let described = null;
    try { described = git('describe', '--tags', '--always', '--dirty'); } catch { /* no tags at all */ }
    return { display: described || commit, commit, channel: 'dev' };
  } catch {
    // No git, or not a checkout: a zip download, or git missing from PATH at runtime.
    return { display: pkgVersion, commit: null, channel: 'unknown' };
  }
}

const VERSION = detectVersion();

/** Never fails and never blocks: VERSION was resolved at startup. */
app.get('/api/version', (req, res) => res.json(VERSION));

// ── Config ────────────────────────────────────────────────────────────────────

// The masking key is a project constant, not a setting: it is deliberately not exposed
// through /api/config and cannot be changed from the UI. Every deterministic algorithm
// derives its output from it, so changing it changes every masked value the tool produces
// — including the pairs printed in the reference guide. See the internal repository's
// documentation for what this key is and why it is fixed.
const MASKING_KEY = 'delphix-default-key';

const DEFAULT_CONFIG = {
  filesDir: path.join(__dirname, 'test-files'),
  // 'auto' | 'en' | 'pt-BR' | 'es' — 'auto' lets the browser language decide.
  locale: 'auto',
  ...ai.DEFAULTS,
  ...delphix.DEFAULTS,
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const LIB_DIR = path.join(__dirname, 'lib');
const RUNNER_JAR = path.join(__dirname, 'java-runner', 'AlgorithmRunner.jar');

// The jars are NOT distributed with this repository — they are Delphix product files.
// Ask Delphix for the Masking Devkit (SDK) and copy these into lib/. Matching is by
// prefix, so any SDK version works; see the "Delphix libraries" section in the README.
const REQUIRED_JARS = [
  'delphix-algorithm-plugin', 'masking-extensibility-api',
  'jackson-annotations', 'jackson-core', 'jackson-databind',
  'jackson-datatype-jdk8', 'jackson-datatype-jsr310', 'jackson-module-jsonSchema',
  'guava', 'failureaccess', 'ant-', 'commons-codec', 'commons-compiler',
  'commons-lang-', 'janino',
];

function listJars() {
  if (!fs.existsSync(LIB_DIR)) return [];
  return fs.readdirSync(LIB_DIR).filter(f => f.endsWith('.jar')).sort();
}

/** Required jar prefixes with nothing in lib/ matching them. */
function missingJars() {
  const jars = listJars();
  return REQUIRED_JARS.filter(prefix => !jars.some(j => j.startsWith(prefix)));
}

/** The plugin jar is whichever delphix-algorithm-plugin-*.jar was dropped in lib/. */
function findPluginJar() {
  if (process.env.DLPX_PLUGIN_JAR) return process.env.DLPX_PLUGIN_JAR;
  const jar = listJars().find(f => f.startsWith('delphix-algorithm-plugin'));
  return jar ? path.join(LIB_DIR, jar) : null;
}

const SETUP_HINT =
  'The Delphix jars are missing from lib/. They are not distributed with this repository: '
  + 'request the Masking Devkit (SDK) from Delphix and copy the jars listed in the README '
  + '("Delphix libraries") into lib/.';

function buildClasspath() {
  const jars = listJars().map(f => path.join(LIB_DIR, f));
  // path.delimiter, never a literal ':' — Windows separates classpath entries with ';' and
  // reads a ':' joined path as one bogus entry, so every command fails with the runner class
  // not found.
  return [RUNNER_JAR, ...jars].join(path.delimiter);
}

// ── Java runner ───────────────────────────────────────────────────────────────

function runJava(request) {
  return new Promise((resolve, reject) => {
    const pluginJar = findPluginJar();
    if (!pluginJar) return reject(new Error(SETUP_HINT));

    const cp = buildClasspath();
    const proc = spawn('java', [
      `-Dplugin.jar=${pluginJar}`,
      // Where the runner looks for a lookup file whose configuration names one held by a
      // Masking Engine — an imported algorithm carries the reference, never the contents.
      `-Dfiles.dir=${path.resolve(__dirname, readConfig().filesDir)}`,
      '-cp', cp,
      'AlgorithmRunner'
    ]);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);

    proc.on('close', code => {
      if (!stdout.trim()) {
        return reject(new Error(stderr.trim() || `Java process exited with code ${code}`));
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error(`Invalid JSON from runner: ${stdout.trim()}`));
      }
    });

    proc.on('error', err => reject(new Error(`Failed to start Java: ${err.message}`)));

    proc.stdin.write(JSON.stringify(request));
    proc.stdin.end();
  });
}

// ── Database ──────────────────────────────────────────────────────────────────

const DB_PATH = path.join(__dirname, 'db', 'algorithms.db');
const LEGACY_DB_PATH = path.join(__dirname, 'db', 'tests.db');
ensureDir(path.dirname(DB_PATH));

// The file used to be tests.db, from when a saved configuration was called a test. Aligning the
// vocabulary with Delphix — a framework is configured into an algorithm — renamed it. An existing
// install is moved rather than left behind, which would silently start it with an empty list.
if (!fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
  fs.renameSync(LEGACY_DB_PATH, DB_PATH);
  console.log('  ↻  db/tests.db renamed to db/algorithms.db');
}

const db = new DatabaseSync(DB_PATH);

// Same rename, one level down: the table and the column that names the plugin class.
// ALTER TABLE keeps the rows, so nothing has to be re-imported from the engine.
const tableNames = db.prepare(
  `SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r) => r.name);
if (tableNames.includes('saved_tests') && !tableNames.includes('saved_algorithms')) {
  db.exec('ALTER TABLE saved_tests RENAME TO saved_algorithms');
  const cols = db.prepare(`SELECT name FROM pragma_table_info('saved_algorithms')`)
    .all().map((r) => r.name);
  if (cols.includes('algorithm') && !cols.includes('framework')) {
    db.exec('ALTER TABLE saved_algorithms RENAME COLUMN algorithm TO framework');
  }
  console.log('  ↻  saved_tests migrated to saved_algorithms');
}

// The database holds the engine password and the AI keys in the clear, so it must not be
// readable by other accounts on the machine. This is the protection that actually applies to
// a local tool — the same posture as ~/.aws/credentials or ~/.npmrc. Encrypting the file with
// a key that lives beside it would obscure the values without protecting them.
try {
  fs.chmodSync(DB_PATH, 0o600);
} catch (err) {
  console.warn(`  ⚠  Could not restrict permissions on ${DB_PATH}: ${err.message}`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS domains (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    -- The identity, as on the engine, where it travels in the URL path and cannot be renamed.
    name      TEXT NOT NULL UNIQUE,
    -- Both are algorithmName values, exactly as the engine stores them: a domain is a name
    -- and two references. Kept as text, not a foreign key, because a domain may point at a
    -- built-in the engine has and this machine does not.
    default_algorithm    TEXT NOT NULL DEFAULT '',
    default_tokenization TEXT NOT NULL DEFAULT '',
    delphix_origin       TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS classifiers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Unique, as on the engine — but not identity there: the engine renames a classifier in
    -- place and identifies it by delphix_id.
    name        TEXT NOT NULL UNIQUE,
    -- PATH | TYPE | REGEX | LIST. Fixed once created, as the engine keeps it.
    framework   TEXT NOT NULL,
    -- The domain the classifier votes for, by name; text for the same reason a domain's
    -- algorithm is text: it may exist only on the engine.
    domain_name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    config      TEXT NOT NULL DEFAULT '{}',
    delphix_id     INTEGER,
    delphix_origin TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS saved_algorithms (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    framework TEXT NOT NULL,
    display_name TEXT NOT NULL,
    config    TEXT NOT NULL DEFAULT '{}',
    input     TEXT NOT NULL DEFAULT '',
    key_value TEXT NOT NULL DEFAULT '',
    output    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Where this algorithm lives on a Delphix engine, when it came from one or was pushed to one.
// Kept as its own migration so existing databases gain the columns without being recreated.
for (const [col, decl] of [
  ['delphix_name', 'TEXT'],       // algorithmName on the engine — exporting again updates it
  ['delphix_origin', 'TEXT'],     // the engine's API root, so a name is not reused across engines
]) {
  const has = db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('saved_algorithms') WHERE name = ?`).get(col);
  if (!has.n) db.exec(`ALTER TABLE saved_algorithms ADD COLUMN ${col} ${decl}`);
}

// The files this tool has put in each engine's upload store, by content, so sending the same file
// again reuses its address instead of piling up copies there. Only a shortcut: an entry is used
// after the engine confirms the address still resolves.
db.exec(`
  CREATE TABLE IF NOT EXISTS engine_uploads (
    origin     TEXT NOT NULL,
    sha256     TEXT NOT NULL,
    name       TEXT NOT NULL,
    reference  TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (origin, sha256, name)
  )
`);

// ── Config helpers (DB-backed) ────────────────────────────────────────────────

// A secret may come from the environment instead of the database, for anyone who would rather
// not have it on disk at all. The names are namespaced so nothing is adopted by accident.
const SECRET_ENV = {
  'delphix.password': 'DLPX_ENGINE_PASSWORD',
  'ai.anthropic.apiKey': 'DLPX_AI_ANTHROPIC_KEY',
  'ai.gemini.apiKey': 'DLPX_AI_GEMINI_KEY',
  'ai.copilot.apiKey': 'DLPX_AI_COPILOT_KEY',
};

/** Which secrets the environment is currently supplying. */
function fromEnv() {
  const out = {};
  for (const [key, name] of Object.entries(SECRET_ENV)) {
    if (process.env[name]) out[key] = process.env[name];
  }
  return out;
}

/** Config as it is on disk — no environment overlay. This is what may be written back. */
function readStoredConfig() {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const stored = Object.fromEntries(rows.map(r => [r.key, r.value]));
  delete stored.globalKey;   // left over from when the key was editable; the constant wins
  return { ...DEFAULT_CONFIG, ...stored };
}

/**
 * Config as the app should use it. The environment wins over the database, which is how a
 * secret is kept off disk entirely — so this must never be the basis of a write, or the
 * value it was meant to keep out of the file would be saved straight into it.
 */
function readConfig() {
  return { ...readStoredConfig(), ...fromEnv() };
}

function writeConfig(config) {
  const stmt = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(config)) stmt.run(k, String(v));
}

// The key used to be an editable setting; drop any value older installs stored.
db.prepare("DELETE FROM config WHERE key = 'globalKey'").run();

ensureDir(path.resolve(__dirname, readConfig().filesDir));

// ── API Routes ────────────────────────────────────────────────────────────────

// Config
const KEY_MASK = '\u2022'.repeat(8);
const isApiKey = (k) =>
  (k.startsWith('ai.') && k.endsWith('.apiKey')) || k === 'delphix.password';

/** Replaces stored API keys with a mask, plus a `<key>.set` flag so the UI can show state. */
function publicConfig(config) {
  const env = fromEnv();
  const out = {};
  for (const [k, v] of Object.entries(config)) {
    if (isApiKey(k)) {
      out[k] = v ? KEY_MASK : '';
      out[`${k}.set`] = Boolean(v);
      // Saving over an environment-provided secret would have no effect; the UI says so.
      if (env[k]) out[`${k}.fromEnv`] = SECRET_ENV[k];
    } else {
      out[k] = v;
    }
  }
  return out;
}

app.get('/api/config', (req, res) => {
  res.json(publicConfig(readConfig()));
});

app.put('/api/config', (req, res) => {
  const current = readStoredConfig();   // never readConfig(): env secrets must not be persisted
  const patch = {};
  for (const [k, v] of Object.entries(req.body)) {
    if (k === 'globalKey') continue;               // constant, never settable
    if (k.endsWith('.set') || k.endsWith('.fromEnv')) continue;   // read-only UI flags
    if (SECRET_ENV[k] && process.env[SECRET_ENV[k]]) continue;    // the environment owns it
    if (isApiKey(k) && v === KEY_MASK) continue;   // untouched masked field
    patch[k] = v;
  }
  const updated = { ...current, ...patch };
  const warmKeys = ['aiProvider', 'ai.ollama.model', 'ai.ollama.baseUrl', 'ai.ollama.numCtx'];
  // keepAlive is deliberately not here: it changes how long the model lingers, not the prompt.
  const rewarm = warmKeys.some((k) => k in patch && patch[k] !== current[k]);
  writeConfig(updated);
  ensureDir(path.resolve(__dirname, updated.filesDir));
  // A model the user just switched to is cold, and the wait is the same minutes it is at
  // startup. Start it now so the chat's indicator has something true to show.
  if (rewarm) buildCatalogCached().then(warmProvider, () => {});
  res.json(publicConfig(readConfig()));
});

// ── AI assistant ─────────────────────────────────────────────────────────────

// The catalog needs one JVM fork per framework, so it is built once and reused.
// Warmed in the background at startup so the first chat message isn't slow.
const buildCatalogCached = () => ai.buildCatalog(runJava);

// Local models are not given the algorithm-writing button — see buildSystemPrompt. This lives in
// one place because the warm-up and the chat must build a byte-identical prompt: a prefix that
// differs by one character is a cache miss, and a cache miss here costs minutes.
const canSaveWith = (cfg) => cfg.id !== 'ollama';
const systemFor = (cfg, catalog) => ai.buildSystemPrompt(catalog, { canSave: canSaveWith(cfg) });
buildCatalogCached().then(
  (c) => {
    console.log(`AI: framework catalog ready (${(c.length / 1024).toFixed(0)} KB)`);
    warmProvider(c);
  },
  (err) => console.warn(`AI: could not build the framework catalog — ${err.message}`)
);

// What the warm-up is doing right now, so the UI can say so. Minutes of silence before the
// first answer look exactly like a hung app, and the user has no way to tell the difference
// from the outside - this is what lets the chat say "loading the model", not "…".
const warmth = {
  state: 'idle', model: null, startedAt: null, ms: null, promptTokens: null, error: null,
  // What is being warmed, not just which model: num_ctx and the endpoint decide the cache as
  // much as the name does, so a change to either has to start over. Kept with the controller
  // that cancels the run it belongs to.
  key: null, controller: null,
};

/** Everything that invalidates Ollama's cached prefix, as one comparable string. */
const warmKeyOf = (cfg) => `${cfg.baseUrl}|${cfg.model}|${cfg.numCtx}`;

/**
 * Reads the system prompt into a local model before anyone asks a question. On a machine
 * without a GPU that pass costs minutes - the catalog is ~12k tokens - and it is paid once
 * per loaded model rather than once per question, so paying it here means the first question
 * is answered at the same speed as the tenth. Best effort by design: Ollama may not be
 * running, and that is the status card's job to report, not a reason to hold up the server.
 */
function warmProvider(catalog) {
  const cfg = ai.providerSettings(readConfig(), readConfig().aiProvider);
  if (cfg.id !== 'ollama') {
    Object.assign(warmth, { state: 'idle', model: null, startedAt: null, error: null });
    return;
  }
  const key = warmKeyOf(cfg);
  if (warmth.state === 'warming' && warmth.key === key) return;
  // A warm-up already running for different settings is now heating the wrong thing, and it
  // would hold a core for minutes doing it. Drop it.
  if (warmth.state === 'warming') warmth.controller?.abort();
  const controller = new AbortController();
  Object.assign(warmth, {
    state: 'warming', model: cfg.model, startedAt: Date.now(), ms: null, promptTokens: null,
    error: null, key, controller,
  });
  console.log(`AI: warming ${cfg.model} …`);
  ai.warmOllama({ cfg, system: systemFor(cfg, catalog), signal: controller.signal }).then(
    ({ ms, promptTokens }) => {
      if (warmth.key !== key) return;   // superseded by a newer warm-up
      Object.assign(warmth, { state: 'ready', ms, promptTokens });
      console.log(`AI: ${cfg.model} warm in ${(ms / 1000).toFixed(1)}s`
        + `${promptTokens ? ` (${promptTokens} prompt tokens cached)` : ''}`);
    },
    (err) => {
      if (warmth.key !== key) return;   // cancelled on purpose, or superseded
      Object.assign(warmth, { state: 'failed', error: err.message });
      console.warn(`AI: could not warm ${cfg.model} — ${err.message}`);
    }
  );
}

/** The warm-up as the UI needs it: state, which model, and how long it has been going. */
function warmStatus() {
  return {
    state: warmth.state,
    model: warmth.model,
    elapsedSec: warmth.state === 'warming' && warmth.startedAt
      ? Math.round((Date.now() - warmth.startedAt) / 1000)
      : null,
    seconds: warmth.ms != null ? Math.round(warmth.ms / 1000) : null,
    error: warmth.error,
  };
}

app.get('/api/ai/status', async (req, res) => {
  const config = readConfig();
  const cfg = ai.providerSettings(config, config.aiProvider);
  const status = await ai.probe(cfg);
  res.json({ provider: cfg.id, model: cfg.model, baseUrl: cfg.baseUrl, ...status, warm: warmStatus() });
});

/** Runs the algorithm the model proposed; only a configuration that actually masks gets saved. */
async function validateAndSave(spec) {
  if (!spec || typeof spec !== 'object') return { error: 'Malformed algorithm block.' };
  const { name, className, config, testInput } = spec;
  if (!name || !className) return { error: 'The algorithm block is missing name or className.' };

  const list = await runJava({ command: 'list' });
  const fw = list.find((f) => f.className === className)
    || list.find((f) => f.className.split('.').pop() === String(className).split('.').pop());
  if (!fw) return { error: `Unknown framework: ${className}` };

  // Without a value to mask there is no validation: every framework "runs" on an empty string,
  // so a configuration that solves nothing would be saved as if the runner had approved it.
  // A model that omits testInput has skipped the only step that can tell right from plausible.
  const input = typeof testInput === 'string' ? testInput.trim() : '';
  if (!input) {
    return { error: 'The algorithm block has no testInput, so the configuration could not be '
      + 'validated. Ask the assistant again, requesting a sample value to test with.' };
  }
  let result;
  try {
    result = await runJava({ command: 'mask', framework: fw.className, config: config || {}, input, key: MASKING_KEY });
  } catch (err) {
    return { error: `The configuration failed to run: ${err.message}` };
  }
  if (result.error) return { error: `The configuration failed to run: ${result.error}` };

  const stmt = db.prepare(`
    INSERT INTO saved_algorithms (name, framework, display_name, config, input, key_value, output)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(name, fw.className, fw.displayName,
    JSON.stringify(config || {}), input, MASKING_KEY, result.output ?? null);
  return {
    saved: {
      id: Number(info.lastInsertRowid), name, className: fw.className,
      displayName: fw.displayName, input, output: result.output ?? null,
    },
  };
}

/**
 * Asks the model for the configuration again, this time with the framework's schema constraining
 * what it is able to emit. Returns a new spec, or null when there is nothing better to try.
 */
async function repairSpec(spec, error, messages, cfg, signal) {
  const list = await runJava({ command: 'list' });
  const fw = list.find((f) => f.className === spec.className);
  if (!fw) return null;   // an unknown className is not a configuration problem
  let schema;
  try {
    ({ schema } = await runJava({ command: 'schema', framework: fw.className }));
  } catch {
    return null;
  }
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const config = await ai.repairConfig({
    cfg, schema, framework: fw.displayName,
    request: lastUser ? lastUser.content : '',
    badConfig: spec.config || {}, error, signal,
  });
  return config ? { ...spec, config } : null;
}

app.post('/api/chat', async (req, res) => {
  const config = readConfig();
  const cfg = ai.providerSettings(config, config.aiProvider);
  const messages = Array.isArray(req.body.messages) ? req.body.messages : [];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Abort on client disconnect. This must listen on the response: on the request,
  // 'close' fires as soon as the POST body has been consumed.
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  try {
    const catalog = await buildCatalogCached();
    const full = await ai.streamChat({
      cfg,
      system: systemFor(cfg, catalog),
      messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') })),
      onDelta: (delta) => send('delta', { delta }),
      signal: controller.signal,
    });

    const { spec, text, parseError } = ai.extractSaveBlock(full);
    if (text !== full) send('replace', { text });
    if (parseError) send('warn', { message: 'The assistant emitted an algorithm block that was not valid JSON.' });
    if (spec && !canSaveWith(cfg)) {
      // The prompt never taught it this, but a model that emits the block anyway must not reach
      // the database. The text has already had the block stripped out of it by extractSaveBlock.
      send('warn', { message: 'This assistant recommends a configuration but does not create it. '
        + 'Pick the algorithm in the sidebar and fill in the values it gave you.' });
    } else if (spec) {
      let outcome = await validateAndSave(spec);
      // One retry, and only for a local model: the runner's rejection plus the algorithm's own
      // schema as a decoding grammar is a far better brief than the catalog was. Costs nothing
      // when the first configuration already runs.
      if (outcome.error && cfg.id === 'ollama') {
        const repaired = await repairSpec(spec, outcome.error, messages, cfg, controller.signal);
        if (repaired) {
          send('warn', { message: 'The first configuration did not run; retried it against the algorithm schema.' });
          outcome = await validateAndSave(repaired);
        }
      }
      send(outcome.error ? 'save-error' : 'saved', outcome.error ? { message: outcome.error } : outcome.saved);
    }
    send('done', {});
  } catch (err) {
    if (!controller.signal.aborted) send('error', { message: err.message });
  }
  res.end();
});

/**
 * Whether the Delphix libraries are in place. Without them nothing in the app works — no
 * framework list, no masking, no assistant — so the UI blocks on this rather than rendering an
 * empty sidebar and leaving the user to guess.
 */
app.get('/api/setup', (req, res) => {
  const missing = missingJars();
  res.json({
    ready: missing.length === 0,
    missing,
    libDir: LIB_DIR,
    required: REQUIRED_JARS.length,
    found: listJars().length,
  });
});

// ── Delphix engine ────────────────────────────────────────────────────────────

/** Tolerates rows saved before and after the double-serialisation fix, like the frontend does. */
function parseStoredConfig(raw) {
  try {
    const first = JSON.parse(raw || '{}');
    return typeof first === 'string' ? JSON.parse(first) : (first ?? {});
  } catch {
    return {};
  }
}


const delphixCfg = () => delphix.settings(readConfig());

/** Reports whether the configured engine is reachable and the credentials work. */
app.get('/api/delphix/status', async (req, res) => {
  const cfg = delphixCfg();
  res.json({ configured: delphix.isConfigured(cfg), ...(await delphix.probe(cfg)) });
});

/**
 * Tries credentials that have not been saved yet, so "test connection" answers about what is
 * on screen. A blank password means "keep the stored one" — the form shows a mask, never the
 * real value, so it has nothing to send back.
 */
app.post('/api/delphix/test', async (req, res) => {
  const stored = readConfig();
  const cfg = delphix.settings({
    ...stored,
    'delphix.baseUrl': req.body.baseUrl ?? stored['delphix.baseUrl'],
    'delphix.username': req.body.username ?? stored['delphix.username'],
    'delphix.password': req.body.password || stored['delphix.password'],
    'delphix.allowSelfSigned': String(req.body.allowSelfSigned ?? stored['delphix.allowSelfSigned']),
  });
  res.json({ configured: delphix.isConfigured(cfg), ...(await delphix.probe(cfg)) });
});

/** The algorithms on the engine, flagged with whether this tool can run them locally. */
app.get('/api/delphix/algorithms', async (req, res) => {
  const cfg = delphixCfg();
  if (!delphix.isConfigured(cfg)) {
    return res.status(400).json({ code: 'not-configured', error: 'No Delphix engine is configured.' });
  }
  try {
    const list = await delphix.listAlgorithms(cfg);
    const origin = delphix.apiRoot(cfg.baseUrl);
    const known = new Set(
      (await runJava({ command: 'list' })).map((a) => a.className));
    // Already imported once? Then importing again overwrites that row rather than duplicating.
    const seen = db.prepare(
      'SELECT delphix_name FROM saved_algorithms WHERE delphix_origin = ?').all(origin)
      .map((r) => r.delphix_name);
    const local = localFileNames();
    res.json(list.map((a) => {
      // A Secure Lookup's file comes down with it; the engine offers no way to fetch anyone else's.
      const files = missingEngineFiles(a.config, local);
      const comes = canDownloadLookup(a);
      return {
        ...a,
        supported: Boolean(a.className) && known.has(a.className),
        alreadyImported: seen.includes(a.algorithmName),
        downloadFiles: comes ? files : [],
        missingFiles: comes ? [] : files,
      };
    }));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/** Copies the named engine algorithms down, with the algorithms and files they reference. */
app.post('/api/delphix/import', async (req, res) => {
  const cfg = delphixCfg();
  if (!delphix.isConfigured(cfg)) {
    return res.status(400).json({ code: 'not-configured', error: 'No Delphix engine is configured.' });
  }
  const names = Array.isArray(req.body.names) ? req.body.names.map(String) : [];
  if (!names.length) return res.status(400).json({ error: 'names[] is required' });
  try {
    const out = await importFromEngine(cfg, { algorithms: names });
    res.json(importReply(out, 'algorithms', out.algorithms.filter((name) => names.includes(name))));
  } catch (err) {
    res.status(err.status && err.status < 500 ? 400 : 502).json({ error: err.message });
  }
});

/**
 * Pushes one saved algorithm row to the engine and records where it landed.
 *
 * What it references goes first: every algorithm its configuration names that is this machine's
 * to send, and every file the engine could not otherwise open. The configuration that reaches the
 * engine names them as they end up there; the local row keeps its own addresses, which are the
 * ones that run here.
 *
 * Shared with the domain and classifier exports. Returns what `delphix.saveAlgorithm` returned
 * plus `renamedLocally`.
 */
async function pushAlgorithmRow(ctx, row, { asked = null, description } = {}) {
  if (ctx.done.has(row.id)) return ctx.done.get(row.id);
  if (ctx.visiting.has(row.id)) {
    const err = new Error(`"${row.name}" ends up referencing itself, so there is no order to send it in.`);
    err.code = 'reference-cycle';
    throw err;
  }
  ctx.visiting.add(row.id);
  try {
    const stored = parseStoredConfig(row.config);
    const linked = row.delphix_origin === ctx.origin ? row.delphix_name : null;
    const existingName = asked && asked !== linked ? null : linked;
    const name = asked || linked || String(row.name).trim();
    const renamedLocally = Boolean(existingName && !asked && String(row.name).trim() !== existingName);

    const renames = {};
    for (const reference of delphix.algorithmReferenceNames(stored)) {
      const target = await pushReference(ctx, reference, row.name);
      if (target !== reference) renames[reference] = target;
    }
    const engine = await ctx.engineAlgorithms();
    const current = existingName ? engine.get(existingName)?.config : null;
    const config = await engineReadyFiles(ctx, delphix.rewriteConfig(stored, { algorithms: renames }), current);

    const out = await delphix.saveAlgorithm(ctx.cfg, {
      name, className: row.framework, config, description, existingName,
    });
    db.prepare(`UPDATE saved_algorithms SET delphix_name = ?, delphix_origin = ?,
                updated_at = datetime('now') WHERE id = ?`).run(out.name, ctx.origin, row.id);
    engine.set(out.name, { algorithmName: out.name, createdBy: ctx.cfg.username, config });
    const result = { ...out, renamedLocally };
    ctx.done.set(row.id, result);
    return result;
  } finally {
    ctx.visiting.delete(row.id);
  }
}

app.post('/api/delphix/export/:id', async (req, res) => {
  const cfg = delphixCfg();
  if (!delphix.isConfigured(cfg)) {
    return res.status(400).json({ code: 'not-configured', error: 'No Delphix engine is configured.' });
  }
  const row = db.prepare('SELECT * FROM saved_algorithms WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Saved algorithm not found' });

  // Only update in place when the row came from *this* engine; the same name on a different
  // engine is a different algorithm. The engine refuses a changed algorithmName on update, so
  // a rename can only ever mean a new algorithm: asking for a name different from the linked
  // one is a deliberate "save a copy under this name", and with no name given the linked
  // algorithm is updated and the local rename reported back instead of silently dropped.
  const asked = req.body.name ? String(req.body.name).trim() : null;

  try {
    const ctx = exportContext(cfg);
    const out = await pushAlgorithmRow(ctx, row, { asked, description: req.body.description });
    res.json({
      mode: out.mode, name: out.name, engine: ctx.origin,
      renamed: Boolean(out.renamed) || out.renamedLocally,
      sent: ctx.sent, skipped: ctx.skipped, uploaded: ctx.uploaded,
    });
  } catch (err) {
    exportFailure(res, err);
  }
});

/** The names currently in filesDir — what an imported algorithm's file references can resolve to. */
function localFileNames() {
  const dir = path.resolve(__dirname, readConfig().filesDir);
  if (!fs.existsSync(dir)) return new Set();
  return new Set(fs.readdirSync(dir).filter((f) => !f.startsWith('.')));
}

/**
 * The engine-held files this configuration needs and filesDir does not have.
 *
 * An algorithm imported from an engine references its uploaded files by an address only the
 * engine can resolve, so the import brings down a configuration that cannot run until a copy
 * of each file exists locally. Reporting it at import time beats letting the first mask fail.
 *
 * `local` is passed in by callers that check a whole list, so one engine listing reads the
 * directory once instead of once per algorithm.
 */
function missingEngineFiles(config, local = localFileNames()) {
  return delphix.engineFileNames(config).filter((name) => !local.has(name));
}

// ── What travels together ─────────────────────────────────────────────────────
//
// Nothing moves between this machine and an engine without what it points at. A classifier
// brings its domain, a domain its two algorithms, an algorithm the algorithms and files its
// configuration names — on the way down as on the way up. The plugin's own instances are the
// exception both ways: the engine and this tool's plugin each already hold them.

const filesDirPath = () => path.resolve(__dirname, readConfig().filesDir);

/** Whether the engine will hand over an algorithm's file: only a Secure Lookup's single list. */
const canDownloadLookup = (a) =>
  a.frameworkName === 'Secure Lookup' && a.frameworkPlugin === 'dlpx-core'
  && delphix.engineFileNames(a.config).length === 1;

/**
 * Copies engine objects down together with everything they reference.
 *
 * What was picked is followed outwards — a classifier's domain, a domain's algorithms, an
 * algorithm's sub-algorithms — and each lands once however many paths reach it. Files come too,
 * into filesDir under their own names: a LIST classifier's lists and a Secure Lookup's lookup
 * file. What cannot come is reported rather than lost: a framework this tool cannot run, a name
 * the engine does not have, a file the engine offers no way to download.
 */
async function importFromEngine(cfg, { algorithms = [], domains = [], classifiers = [] }) {
  const origin = delphix.apiRoot(cfg.baseUrl);
  const out = { classifiers: [], domains: [], algorithms: [], skipped: [], downloaded: [], needsFiles: [] };
  const [remoteAlgorithms, remoteDomains, runnable] = await Promise.all([
    delphix.listAlgorithms(cfg), delphix.listDomains(cfg), runJava({ command: 'list' }),
  ]);
  const algorithmByName = new Map(remoteAlgorithms.map((a) => [a.algorithmName, a]));
  const domainByName = new Map(remoteDomains.map((d) => [d.domainName, d]));
  const displayName = new Map(runnable.map((a) => [a.className, a.displayName]));
  const dir = filesDirPath();
  ensureDir(dir);
  const local = localFileNames();

  // Writes each engine file the owner reads that is not here yet, when `fetchFiles` can get it.
  const bringFiles = async (owner, config, fetchFiles) => {
    const missing = [...new Set(delphix.configStrings(config).filter((value) => {
      const name = delphix.engineFileName(value);
      return name && !local.has(path.basename(name));
    }))];
    if (!missing.length) return;
    const fetched = fetchFiles
      ? await fetchFiles().catch((err) => { console.warn(`  ⚠  Could not download the files of "${owner}": ${err.message}`); return []; })
      : [];
    const still = [];
    for (const reference of missing) {
      const name = path.basename(delphix.engineFileName(reference));
      if (local.has(name)) continue;   // two addresses with one file name: the first copy serves both
      const hit = fetched.find((f) => f.reference === reference);
      if (!hit) { still.push(name); continue; }
      fs.writeFileSync(path.join(dir, name), hit.content);
      local.add(name);
      out.downloaded.push(name);
    }
    if (still.length) out.needsFiles.push({ name: owner, files: still });
  };

  const pendingDomains = new Set(domains);
  const pendingAlgorithms = algorithms.map((name) => ({ name, asked: true }));

  if (classifiers.length) {
    const [list, frameworks] = await Promise.all([delphix.listClassifiers(cfg), delphix.classifierFrameworks(cfg)]);
    const frameworkOf = Object.fromEntries(Object.entries(frameworks).map(([name, id]) => [id, name]));
    const wanted = new Set(classifiers.map(Number));
    for (const c of list) {
      if (!wanted.has(Number(c.classifierId))) continue;
      const framework = frameworkOf[c.frameworkId];
      if (!classifierKit.isFramework(framework)) {
        out.skipped.push({ kind: 'classifier', name: c.classifierName, reason: 'unsupported-framework' });
        continue;
      }
      const config = c.classifierConfiguration ?? {};
      // Matched by the engine id first, since a classifier renamed there is still the same one.
      const existing = db.prepare('SELECT id FROM classifiers WHERE delphix_id = ? AND delphix_origin = ?').get(c.classifierId, origin)
        ?? db.prepare('SELECT id FROM classifiers WHERE name = ?').get(c.classifierName);
      try {
        if (existing) {
          db.prepare(`
            UPDATE classifiers SET name = ?, framework = ?, domain_name = ?, description = ?, config = ?,
                   delphix_id = ?, delphix_origin = ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(c.classifierName, framework, c.domainName ?? '', c.description ?? '', JSON.stringify(config), c.classifierId, origin, existing.id);
        } else {
          db.prepare(`
            INSERT INTO classifiers (name, framework, domain_name, description, config, delphix_id, delphix_origin)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(c.classifierName, framework, c.domainName ?? '', c.description ?? '', JSON.stringify(config), c.classifierId, origin);
        }
      } catch {
        // Renamed on the engine onto a name another local classifier holds.
        out.skipped.push({ kind: 'classifier', name: c.classifierName, reason: 'name-taken' });
        continue;
      }
      out.classifiers.push(c.classifierName);
      if (c.domainName) pendingDomains.add(c.domainName);
      await bringFiles(c.classifierName, config, () => delphix.classifierFiles(cfg, c.classifierId, config));
    }
  }

  for (const name of pendingDomains) {
    const d = domainByName.get(name);
    if (!d) { out.skipped.push({ kind: 'domain', name, reason: 'not-found' }); continue; }
    if (db.prepare('SELECT id FROM domains WHERE name = ?').get(name)) {
      db.prepare(`
        UPDATE domains SET default_algorithm = ?, default_tokenization = ?, delphix_origin = ?, updated_at = datetime('now')
        WHERE name = ?
      `).run(d.defaultAlgorithmCode, d.defaultTokenizationCode, origin, name);
    } else {
      db.prepare(`
        INSERT INTO domains (name, default_algorithm, default_tokenization, delphix_origin) VALUES (?, ?, ?, ?)
      `).run(name, d.defaultAlgorithmCode, d.defaultTokenizationCode, origin);
    }
    out.domains.push(name);
    for (const reference of [d.defaultAlgorithmCode, d.defaultTokenizationCode]) {
      if (reference) pendingAlgorithms.push({ name: reference, asked: false });
    }
  }

  const seen = new Set();
  while (pendingAlgorithms.length) {
    const { name, asked } = pendingAlgorithms.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const a = algorithmByName.get(name);
    if (!a) { out.skipped.push({ kind: 'algorithm', name, reason: 'not-found' }); continue; }
    // A plugin instance reached through a reference is already here, in this tool's plugin.
    if (!asked && !a.createdBy) continue;
    if (!a.className || !displayName.has(a.className)) {
      // Importing it would create a row that can never be tested, so it is named instead.
      out.skipped.push({ kind: 'algorithm', name, reason: 'unsupported-framework', framework: a.frameworkName });
      continue;
    }
    const config = JSON.stringify(a.config ?? {});
    const existing = db.prepare('SELECT id FROM saved_algorithms WHERE delphix_name = ? AND delphix_origin = ?').get(name, origin);
    if (existing) {
      db.prepare(`
        UPDATE saved_algorithms SET name = ?, framework = ?, display_name = ?, config = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(name, a.className, displayName.get(a.className), config, existing.id);
    } else {
      db.prepare(`
        INSERT INTO saved_algorithms (name, framework, display_name, config, input, key_value, output, delphix_name, delphix_origin)
        VALUES (?, ?, ?, ?, '', ?, NULL, ?, ?)
      `).run(name, a.className, displayName.get(a.className), config, MASKING_KEY, name, origin);
    }
    out.algorithms.push(name);
    for (const reference of delphix.algorithmReferenceNames(a.config)) {
      pendingAlgorithms.push({ name: reference, asked: false });
    }
    await bringFiles(name, a.config, canDownloadLookup(a)
      ? async () => {
        const [reference] = delphix.configStrings(a.config).filter((value) => delphix.engineFileName(value));
        return [{ reference, content: await delphix.lookupFile(cfg, name) }];
      }
      : null);
  }
  return out;
}

/** One reply for every import: what was asked for, what came along with it, what could not come. */
function importReply(out, kind, imported) {
  const along = (list, own) => (kind === own ? list.filter((name) => !imported.includes(name)) : list);
  return {
    imported,
    related: { domains: along(out.domains, 'domains'), algorithms: along(out.algorithms, 'algorithms') },
    skipped: out.skipped,
    downloaded: out.downloaded,
    needsFiles: out.needsFiles,
  };
}

/**
 * The state of one push to the engine, so everything it drags along goes once: the engine's
 * algorithms and upload store (each read once, on first need) and what has been sent so far.
 */
function exportContext(cfg) {
  let engineAlgorithms = null;
  let uploadStore = null;
  return {
    cfg,
    origin: delphix.apiRoot(cfg.baseUrl),
    sent: [],        // referenced algorithms pushed along, in order
    skipped: [],     // referenced names left as they are, and why
    uploaded: [],    // files put in the upload store
    done: new Map(),
    visiting: new Set(),
    uploads: new Map(),
    engineAlgorithms: () => (engineAlgorithms ??= delphix.listAlgorithms(cfg)
      .then((list) => new Map(list.map((a) => [a.algorithmName, a])))),
    uploadStore: () => (uploadStore ??= delphix.uploadedFiles(cfg)),
  };
}

/**
 * Sends the algorithm a reference names, when it is this machine's to send, and returns the name
 * to reference on the engine.
 *
 * Left as they are: a plugin instance on the engine (read-only there — `PUT` is refused — and
 * already correct), and a name only the engine holds. A name neither side holds stops the push:
 * the engine would refuse what references it, with an error about the wrong object.
 */
async function pushReference(ctx, name, owner) {
  const skip = (reason) => {
    if (!ctx.skipped.some((s) => s.name === name)) ctx.skipped.push({ name, reason });
    return name;
  };
  const remote = (await ctx.engineAlgorithms()).get(name);
  if (remote && !remote.createdBy) return skip('engine-owned');
  const row = db.prepare('SELECT * FROM saved_algorithms WHERE name = ?').get(name);
  if (!row) {
    if (remote) return skip('not-local');
    const err = new Error(`"${owner}" references the algorithm "${name}", which neither this machine nor the engine has.`);
    err.code = 'reference-missing';
    throw err;
  }
  const already = ctx.done.has(row.id);
  try {
    const out = await pushAlgorithmRow(ctx, row);
    if (!already) ctx.sent.push({ name: out.name, mode: out.mode });
    return out.name;
  } catch (err) {
    if (err.code) throw err;
    const failure = new Error(`"${owner}" was not sent: "${name}", which it references, could not be. ${err.message}`);
    failure.code = 'reference-failed';
    throw failure;
  }
}

/** A file address the engine may not be able to open as it is, with where the copy here lives. */
function fileToSend(value) {
  const text = String(value).trim();
  if (/^delphix-file:\/\/upload\//i.test(text)) {
    const name = path.basename(delphix.engineFileName(text) ?? '');
    return name ? { onEngine: true, name, path: path.join(filesDirPath(), name) } : null;
  }
  if (/^file:\/\//i.test(text)) {
    let full = null;
    try {
      full = /^file:\/\/\//i.test(text)
        ? fileURLToPath(text)
        : path.join(filesDirPath(), path.basename(decodeURIComponent(text.slice('file://'.length).split(/[?#]/)[0])));
    } catch { /* not a usable path */ }
    return { onEngine: false, name: full ? path.basename(full) : text, path: full };
  }
  return null;   // jar:// ships inside the plugin; http(s) and mounts are the engine's own business
}

/**
 * The configuration as the engine must receive it: every file it names reachable there.
 *
 * An address the object already has on the engine stays — the engine keeps honouring files its
 * objects own, even after they leave the upload store — and so does an upload still in the store.
 * Anything else is uploaded from this machine (a `file://` path, or filesDir's copy of an engine
 * file) and the configuration pointed at the new address. Without a copy here the push stops.
 */
async function engineReadyFiles(ctx, config, current) {
  const owned = new Set(current ? delphix.configStrings(current) : []);
  const files = {};
  for (const value of new Set(delphix.configStrings(config))) {
    const file = fileToSend(value);
    if (!file || owned.has(value)) continue;
    if (file.onEngine && (await ctx.uploadStore()).has(value)) continue;
    if (!file.path || !fs.existsSync(file.path)) {
      const err = new Error(`"${file.name}" is not on this machine, so it could not go to the engine. Add it under Files and send again.`);
      err.code = 'file-missing';
      err.file = file.name;
      throw err;
    }
    files[value] = await uploadOnce(ctx, file.path, owned);
  }
  return delphix.rewriteConfig(config, { files });
}

/** Uploads a file unless this engine already holds the same content under the same name. */
async function uploadOnce(ctx, full, owned) {
  const content = fs.readFileSync(full);
  const name = path.basename(full);
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const key = `${sha256}/${name}`;
  if (ctx.uploads.has(key)) return ctx.uploads.get(key);

  const known = db.prepare('SELECT reference FROM engine_uploads WHERE origin = ? AND sha256 = ? AND name = ?')
    .get(ctx.origin, sha256, name);
  let reference = known && (owned.has(known.reference) || (await ctx.uploadStore()).has(known.reference))
    ? known.reference : null;
  if (!reference) {
    reference = await delphix.uploadFile(ctx.cfg, name, content);
    db.prepare('INSERT OR REPLACE INTO engine_uploads (origin, sha256, name, reference) VALUES (?, ?, ?, ?)')
      .run(ctx.origin, sha256, name, reference);
    (await ctx.uploadStore()).add(reference);
    ctx.uploaded.push(name);
  }
  ctx.uploads.set(key, reference);
  return reference;
}

/** The refusals a push can end in, with the status and code the editors word for the user. */
function exportFailure(res, err) {
  if (['file-missing', 'reference-missing', 'reference-cycle'].includes(err.code)) {
    return res.status(400).json({ code: err.code, error: err.message, ...(err.file ? { file: err.file } : {}) });
  }
  if (err.code === 'reference-failed') return res.status(502).json({ code: err.code, error: err.message });
  res.status(err.status && err.status < 500 ? 400 : 502).json({ error: err.message });
}

// File management
app.get('/api/files', (req, res) => {
  const dir = path.resolve(__dirname, readConfig().filesDir);
  ensureDir(dir);
  const files = fs.readdirSync(dir)
    .filter(f => !f.startsWith('.'))
    .map(name => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return { name, uri: pathToFileURL(full).href, size: stat.size, updatedAt: stat.mtime.toISOString() };
    });
  res.json(files);
});

const SAMPLE_FILES = {
  'firstnames.txt': [
    'Ana','Carlos','Maria','João','Lucas','Fernanda','Pedro','Beatriz',
    'Rafael','Juliana','Bruno','Camila','Diego','Larissa','Felipe',
    'Mariana','Thiago','Isabela','Rodrigo','Amanda',
  ].join('\n'),
  'lastnames.txt': [
    'Silva','Santos','Oliveira','Souza','Lima','Pereira','Costa','Ferreira',
    'Alves','Rodrigues','Nascimento','Carvalho','Gomes','Martins','Araújo',
    'Ribeiro','Almeida','Cavalcante','Barbosa','Monteiro',
  ].join('\n'),
  'mapping.csv': [
    'SP,São Paulo',
    'RJ,Rio de Janeiro',
    'MG,Minas Gerais',
    'RS,Rio Grande do Sul',
    'BA,Bahia',
    'PR,Paraná',
    'SC,Santa Catarina',
    'GO,Goiás',
    'PE,Pernambuco',
    'CE,Ceará',
  ].join('\n'),

  // Locale variants: the UI examples point at the file matching the active
  // interface language (see `example.sampleFiles` in the framework-text.*.ts files).
  'firstnames.en.txt': [
    'James','Mary','John','Patricia','Robert','Jennifer','Michael','Linda',
    'William','Elizabeth','David','Barbara','Richard','Susan','Joseph',
    'Jessica','Thomas','Sarah','Charles','Karen',
  ].join('\n'),
  'lastnames.en.txt': [
    'Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis',
    'Wilson','Anderson','Taylor','Thomas','Moore','Jackson','Martin',
    'Lee','Thompson','White','Harris','Clark',
  ].join('\n'),
  'mapping.en.csv': [
    'CA,California',
    'NY,New York',
    'TX,Texas',
    'FL,Florida',
    'IL,Illinois',
    'PA,Pennsylvania',
    'OH,Ohio',
    'GA,Georgia',
    'NC,North Carolina',
    'MI,Michigan',
  ].join('\n'),

  'firstnames.es.txt': [
    'Ana','Carlos','María','Juan','Lucía','Fernando','Pedro','Beatriz',
    'Rafael','Julia','Bruno','Camila','Diego','Laura','Felipe',
    'Mariana','Santiago','Isabel','Rodrigo','Amanda',
  ].join('\n'),
  'lastnames.es.txt': [
    'García','Rodríguez','González','Fernández','López','Martínez','Sánchez','Pérez',
    'Gómez','Martín','Jiménez','Ruiz','Hernández','Díaz','Moreno',
    'Álvarez','Muñoz','Romero','Alonso','Gutiérrez',
  ].join('\n'),
  'mapping.es.csv': [
    'MAD,Madrid',
    'BCN,Barcelona',
    'VLC,Valencia',
    'SEV,Sevilla',
    'ZGZ,Zaragoza',
    'MLG,Málaga',
    'BIO,Bilbao',
    'ALC,Alicante',
    'MUR,Murcia',
    'VLL,Valladolid',
  ].join('\n'),
};

// Ensures a named sample file exists in filesDir and returns its info.
// Creates it with built-in content only if the file doesn't already exist.
app.post('/api/files/ensure-sample', (req, res) => {
  const name = path.basename(req.body.name || '');
  if (!name || !SAMPLE_FILES[name]) return res.status(400).json({ error: `Unknown sample file: ${name}` });
  const dir = path.resolve(__dirname, readConfig().filesDir);
  ensureDir(dir);
  const full = path.join(dir, name);
  if (!fs.existsSync(full)) fs.writeFileSync(full, SAMPLE_FILES[name], 'utf8');
  const stat = fs.statSync(full);
  res.json({ name, uri: pathToFileURL(full).href, size: stat.size, updatedAt: stat.mtime.toISOString() });
});

app.post('/api/files', (req, res) => {
  const dir = path.resolve(__dirname, readConfig().filesDir);
  ensureDir(dir);
  const name = path.basename(req.body.name || '');
  if (!name) return res.status(400).json({ error: 'name is required' });
  const full = path.join(dir, name);
  fs.writeFileSync(full, req.body.content ?? '', 'utf8');
  const stat = fs.statSync(full);
  res.status(201).json({ name, uri: pathToFileURL(full).href, size: stat.size, updatedAt: stat.mtime.toISOString() });
});

app.get('/api/files/:name', (req, res) => {
  const dir = path.resolve(__dirname, readConfig().filesDir);
  const full = path.join(dir, path.basename(req.params.name));
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'File not found' });
  res.type('text/plain').send(fs.readFileSync(full, 'utf8'));
});

app.put('/api/files/:name', (req, res) => {
  const dir = path.resolve(__dirname, readConfig().filesDir);
  const full = path.join(dir, path.basename(req.params.name));
  fs.writeFileSync(full, req.body.content ?? '', 'utf8');
  const stat = fs.statSync(full);
  res.json({ name: path.basename(full), uri: pathToFileURL(full).href, size: stat.size, updatedAt: stat.mtime.toISOString() });
});

app.delete('/api/files/:name', (req, res) => {
  const dir = path.resolve(__dirname, readConfig().filesDir);
  const full = path.join(dir, path.basename(req.params.name));
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'File not found' });
  fs.unlinkSync(full);
  res.json({ ok: true });
});

// List the masking frameworks
app.get('/api/frameworks', async (req, res) => {
  try {
    const result = await runJava({ command: 'list' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get the JSON schema for a framework
app.get('/api/frameworks/:className/schema', async (req, res) => {
  try {
    const result = await runJava({
      command: 'schema',
      framework: req.params.className
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Execute multi-column masking (for GenericDataRow frameworks like MultiColumnCondition)
app.post('/api/mask-multicolumn', async (req, res) => {
  const { framework, config, columns } = req.body;
  if (!framework || !Array.isArray(columns)) {
    return res.status(400).json({ error: 'framework and columns[] are required' });
  }
  try {
    // A `key` in the request body is ignored on purpose — the key is a constant.
    const result = await runJava({ command: 'mask_multicolumn', framework, config, columns, key: MASKING_KEY });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Execute batch masking (for frameworks like Shuffle that require multiple values)
app.post('/api/mask-batch', async (req, res) => {
  const { framework, config, inputs } = req.body;
  if (!framework || !Array.isArray(inputs)) {
    return res.status(400).json({ error: 'framework and inputs[] are required' });
  }
  try {
    const result = await runJava({ command: 'mask_batch', framework, config, inputs, key: MASKING_KEY });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Execute masking
app.post('/api/mask', async (req, res) => {
  const { framework, config, input, mode, additionalAlgorithms } = req.body;
  if (!framework || input === undefined) {
    return res.status(400).json({ error: 'framework and input are required' });
  }
  try {
    const result = await runJava({ command: 'mask', framework, config, input, key: MASKING_KEY, mode, additionalAlgorithms });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List saved algorithms
app.get('/api/algorithms', (req, res) => {
  const { framework } = req.query;
  let stmt;
  if (framework) {
    stmt = db.prepare('SELECT * FROM saved_algorithms WHERE framework = ? ORDER BY updated_at DESC');
    res.json(stmt.all(framework));
  } else {
    stmt = db.prepare('SELECT * FROM saved_algorithms ORDER BY updated_at DESC');
    res.json(stmt.all());
  }
});

// Save an algorithm
app.post('/api/algorithms', (req, res) => {
  const { name, framework, display_name, config, input, output } = req.body;
  if (!name || !framework) {
    return res.status(400).json({ error: 'name and framework are required' });
  }
  const stmt = db.prepare(`
    INSERT INTO saved_algorithms (name, framework, display_name, config, input, key_value, output)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const configStr = typeof config === 'string' ? config : JSON.stringify(config || {});
  const result = stmt.run(
    name, framework, display_name || framework,
    configStr, input || '', MASKING_KEY, output || null
  );
  const row = db.prepare('SELECT * FROM saved_algorithms WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(row);
});

// Update an algorithm
app.put('/api/algorithms/:id', (req, res) => {
  const { config, input, output } = req.body;
  // The name is identity, mirroring the engine: it is set on create or on duplicate, never
  // edited. Accepting a new one here would let a local copy drift from the algorithm it tracks.
  const current = db.prepare('SELECT * FROM saved_algorithms WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Saved algorithm not found' });

  // Only what the caller sent is changed. Defaulting an absent field would let an update of,
  // say, just the input silently erase the configuration.
  const configStr = config === undefined
    ? current.config
    : (typeof config === 'string' ? config : JSON.stringify(config ?? {}));

  db.prepare(`
    UPDATE saved_algorithms
    SET config=?, input=?, key_value=?, output=?, updated_at=datetime('now')
    WHERE id=?
  `).run(
    configStr,
    input === undefined ? current.input : input,
    MASKING_KEY,
    output === undefined ? current.output : (output || null),
    req.params.id,
  );
  const row = db.prepare('SELECT * FROM saved_algorithms WHERE id = ?').get(req.params.id);
  res.json(row);
});

/**
 * Copies a saved algorithm under a new name.
 *
 * This replaces renaming. On a Masking Engine the algorithm name is its identity — `PUT` answers
 * "Cannot update 'algorithmName' field" — so a rename could never travel, while a copy under a
 * new name is exactly what the engine does support. The copy starts unlinked: it is a new
 * algorithm, not another view of the one already on the engine.
 */
app.post('/api/algorithms/:id/duplicate', (req, res) => {
  const row = db.prepare('SELECT * FROM saved_algorithms WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Saved algorithm not found' });

  const name = String(req.body.name ?? '').trim();
  if (!name) return res.status(400).json({ code: 'name-required', error: 'A name is required.' });

  const clash = db.prepare('SELECT id FROM saved_algorithms WHERE name = ?').get(name);
  if (clash) return res.status(409).json({ code: 'name-taken', error: `"${name}" already exists.` });

  const info = db.prepare(`
    INSERT INTO saved_algorithms (name, framework, display_name, config, input, key_value, output)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, row.framework, row.display_name, row.config, row.input, MASKING_KEY, row.output);
  res.status(201).json(db.prepare('SELECT * FROM saved_algorithms WHERE id = ?').get(info.lastInsertRowid));
});

// Delete an algorithm
app.delete('/api/algorithms/:id', (req, res) => {
  db.prepare('DELETE FROM saved_algorithms WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Export all algorithms
app.get('/api/algorithms/export', (req, res) => {
  const rows = db.prepare('SELECT * FROM saved_algorithms ORDER BY id').all();
  res.setHeader('Content-Disposition', 'attachment; filename="delphix-algorithms.json"');
  res.json(rows);
});

// Import algorithms
app.post('/api/algorithms/import', (req, res) => {
  const rows = req.body;
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'Expected array' });
  const stmt = db.prepare(`
    INSERT INTO saved_algorithms (name, framework, display_name, config, input, key_value, output)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let count = 0;
  for (const r of rows) {
    try {
      stmt.run(r.name, r.framework ?? r.algorithm, r.display_name, r.config, r.input, MASKING_KEY, r.output);
      count++;
    } catch {}
  }
  res.json({ imported: count });
});

// ── Domains ───────────────────────────────────────────────────────────────────
//
// A domain is a name plus two algorithm references, which is the whole of the engine's own
// Domain object. Nothing is derived or validated against the local algorithm list here: the
// engine accepts any algorithmName it knows, including built-ins this tool cannot run, and
// refusing those locally would make the tool unable to describe its own engine.

app.get('/api/domains', (req, res) => {
  res.json(db.prepare('SELECT * FROM domains ORDER BY name COLLATE NOCASE').all());
});

app.post('/api/domains', (req, res) => {
  const name = String(req.body.name ?? '').trim();
  if (!name) return res.status(400).json({ code: 'name-required', error: 'A name is required.' });
  if (name.length > 100) {
    return res.status(400).json({ code: 'name-too-long', error: 'The engine caps a domain name at 100 characters.' });
  }
  const clash = db.prepare('SELECT id FROM domains WHERE name = ?').get(name);
  if (clash) return res.status(409).json({ code: 'name-taken', error: `"${name}" already exists.` });

  const info = db.prepare(`
    INSERT INTO domains (name, default_algorithm, default_tokenization) VALUES (?, ?, ?)
  `).run(name, String(req.body.defaultAlgorithm ?? ''), String(req.body.defaultTokenization ?? ''));
  res.status(201).json(db.prepare('SELECT * FROM domains WHERE id = ?').get(info.lastInsertRowid));
});

/** Name is identity and is never updated — same rule the engine enforces on the path. */
app.put('/api/domains/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM domains WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Domain not found' });

  db.prepare(`
    UPDATE domains SET default_algorithm = ?, default_tokenization = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    req.body.defaultAlgorithm === undefined ? current.default_algorithm : String(req.body.defaultAlgorithm),
    req.body.defaultTokenization === undefined ? current.default_tokenization : String(req.body.defaultTokenization),
    req.params.id,
  );
  res.json(db.prepare('SELECT * FROM domains WHERE id = ?').get(req.params.id));
});

app.delete('/api/domains/:id', (req, res) => {
  db.prepare('DELETE FROM domains WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/** The domains on the engine, flagged with whether this machine already has the name. */
app.get('/api/delphix/domains', async (req, res) => {
  const cfg = delphixCfg();
  if (!delphix.isConfigured(cfg)) {
    return res.status(400).json({ code: 'not-configured', error: 'No Delphix engine configured yet.' });
  }
  try {
    const list = await delphix.listDomains(cfg);
    const seen = new Set(db.prepare('SELECT name FROM domains').all().map((r) => r.name));
    res.json(list.map((d) => ({ ...d, alreadyImported: seen.has(d.domainName) })));
  } catch (err) {
    res.status(err.status && err.status < 500 ? 400 : 502).json({ error: err.message });
  }
});

/** Copies the named engine domains down with their algorithms, updating any already held. */
app.post('/api/delphix/domains/import', async (req, res) => {
  const cfg = delphixCfg();
  if (!delphix.isConfigured(cfg)) {
    return res.status(400).json({ code: 'not-configured', error: 'No Delphix engine configured yet.' });
  }
  const names = Array.isArray(req.body.names) ? req.body.names.map(String) : [];
  try {
    const out = await importFromEngine(cfg, { domains: names });
    res.json(importReply(out, 'domains', out.domains));
  } catch (err) {
    res.status(err.status && err.status < 500 ? 400 : 502).json({ error: err.message });
  }
});

/**
 * Pushes one local domain to the engine, with the algorithms it names.
 *
 * **The algorithms go first, and that is not a nicety.** The engine validates the reference:
 * posting a domain whose `defaultAlgorithmCode` it does not know answers
 * `404 Could not find Algorithm '<name>'`. A domain built on an algorithm that only exists
 * here would simply fail, and the fix — "go and send the algorithm first" — is something the
 * tool can do itself (`pushReference`, which also leaves the engine's read-only plugin
 * instances alone: a stock engine's domains point at those constantly).
 *
 * A failure to send an algorithm stops the whole push. Continuing would post a domain whose
 * reference is missing, which fails anyway — with an error about the domain, pointing away
 * from the algorithm that actually went wrong.
 */
async function pushDomainRow(ctx, row) {
  // What the domain will reference is the name the algorithm ends up with *there* — a legacy
  // row whose local name drifted from its delphix_name would otherwise point at a name the
  // engine does not have.
  const reference = {};
  for (const field of ['default_algorithm', 'default_tokenization']) {
    const name = String(row[field] ?? '').trim();
    reference[field] = name ? await pushReference(ctx, name, row.name) : '';
  }

  const out = await delphix.saveDomain(ctx.cfg, {
    name: row.name,
    defaultAlgorithm: reference.default_algorithm,
    defaultTokenization: reference.default_tokenization,
  });
  db.prepare(`UPDATE domains SET delphix_origin = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(ctx.origin, row.id);
  return { mode: out.mode, name: out.name };
}

app.post('/api/delphix/domains/export/:id', async (req, res) => {
  const cfg = delphixCfg();
  if (!delphix.isConfigured(cfg)) {
    return res.status(400).json({ code: 'not-configured', error: 'No Delphix engine configured yet.' });
  }
  const row = db.prepare('SELECT * FROM domains WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Domain not found' });

  try {
    const ctx = exportContext(cfg);
    const out = await pushDomainRow(ctx, row);
    res.json({ ...out, engine: ctx.origin, sent: ctx.sent, skipped: ctx.skipped, uploaded: ctx.uploaded });
  } catch (err) {
    exportFailure(res, err);
  }
});

// ── Reference names ───────────────────────────────────────────────────────────
//
// Fields that name an algorithm or a domain offer what can actually be referenced: the saved
// algorithms (the client already has those), the plugin's built-in algorithms, and whatever the
// configured engine holds. A name outside all of them is still accepted — the field warns.

// Built-ins this project deliberately does not offer (a maintainers' decision).
const hiddenReference = (name) => /\bjapan/i.test(String(name));

let builtinReferences = null;

app.get('/api/reference/builtins', async (req, res) => {
  try {
    builtinReferences ??= runJava({ command: 'builtins' })
      .then((out) => {
        if (!Array.isArray(out?.instances)) throw new Error(out?.error || 'The runner did not list its built-in algorithms.');
        const offered = out.instances
          .map((item) => ({ ...item, name: String(item.name) }))
          .filter((item) => !hiddenReference(item.name))
          .map((item) => ({ ...item, name: item.name.includes(':') ? item.name : `dlpx-core:${item.name}` }));
        return {
          algorithms: offered.map((item) => item.name),
          tokenization: offered.filter((item) => item.tokenization).map((item) => item.name),
          tokenizationFrameworks: Array.isArray(out.tokenizationFrameworks) ? out.tokenizationFrameworks : [],
        };
      })
      .catch((err) => { builtinReferences = null; throw err; });
    res.json(await builtinReferences);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Listing an engine is slow and it may be down, so one answer is reused for a minute.
let engineReferences = { key: null, at: 0, promise: null };

app.get('/api/reference/engine', async (req, res) => {
  const cfg = delphixCfg();
  if (!delphix.isConfigured(cfg)) return res.json({ state: 'not-configured', algorithms: [], tokenization: [], domains: [] });
  const key = `${delphix.apiRoot(cfg.baseUrl)}|${cfg.username}`;
  const stale = engineReferences.key !== key || Date.now() - engineReferences.at > 60000;
  if (stale || req.query.refresh) {
    engineReferences = {
      key,
      at: Date.now(),
      promise: Promise.all([delphix.listAlgorithms(cfg), delphix.listDomains(cfg)])
        .then(([algorithms, domains]) => ({
          state: 'ready',
          algorithms: algorithms.map((a) => a.algorithmName).filter((name) => name && !hiddenReference(name)),
          tokenization: algorithms.filter((a) => a.tokenizationSupported).map((a) => a.algorithmName)
            .filter((name) => name && !hiddenReference(name)),
          domains: domains.map((d) => d.domainName).filter(Boolean),
        }))
        .catch((err) => ({ state: 'unavailable', error: err.message, algorithms: [], tokenization: [], domains: [] })),
    };
  }
  res.json(await engineReferences.promise);
});

// ── Classifiers ───────────────────────────────────────────────────────────────
//
// A classifier is one framework's configuration voting for one domain during profiling. Unlike
// a domain or an algorithm, its identity on the engine is a numeric id: the name is unique but
// can be changed. classifiers/ evaluates classifiers locally, so a configuration can be tried
// before it is sent.

const classifierKit = require('./classifiers');
const { fileURLToPath } = require('url');

const classifierRow = (r) => r && ({ ...r, config: parseStoredConfig(r.config) });

/** A refusal the editor can explain field by field: a code, the issues, and a plain summary. */
const configRefusal = (code, issues) => ({ code, issues, error: issues.map((i) => i.message).join(' ') });

const unknownFramework = (framework) => ({ code: 'framework-invalid', error: `"${framework}" is not a classifier framework.` });

/**
 * Where a LIST classifier's file is read from on this machine.
 *
 * A `file:///absolute/path` is read where it points. Any other address — an engine upload
 * (`delphix-file://upload/<id>/<name>`), `file://<name>`, a URL — is looked up by file name in
 * filesDir, the same convention algorithms follow for the engine's files.
 */
function resolveClassifierFile(ref) {
  const value = String(ref ?? '').trim();
  if (/^file:\/\/\//i.test(value)) {
    try {
      const full = fileURLToPath(value);
      return fs.existsSync(full) ? full : null;
    } catch {
      return null;
    }
  }
  const relative = /^file:\/\/([^/?#]+)/i.exec(value);
  let name = relative ? relative[1] : delphix.engineFileName(value);
  if (!name) return null;
  try { name = decodeURIComponent(name); } catch { /* keep it literal */ }
  const full = path.join(path.resolve(__dirname, readConfig().filesDir), path.basename(name));
  return fs.existsSync(full) ? full : null;
}

function classifierFilesMissing(framework, config) {
  if (framework !== 'LIST' || !Array.isArray(config?.valueLists)) return [];
  return config.valueLists.map((l) => l?.file).filter((f) => typeof f === 'string' && !resolveClassifierFile(f));
}

function readClassifierFile(ref) {
  const full = resolveClassifierFile(ref);
  if (!full) {
    const err = new Error(`No copy of ${ref} on this machine.`);
    err.code = 'file-missing';
    err.file = ref;
    throw err;
  }
  return fs.readFileSync(full, 'utf8');
}

app.get('/api/classifier-frameworks', (req, res) => {
  res.json(classifierKit.catalog());
});

/** What Delphix would refuse, what cannot be tested here, and what is probably a slip. */
app.post('/api/classifiers/check', (req, res) => {
  const framework = String(req.body.framework ?? '');
  if (!classifierKit.isFramework(framework)) return res.status(400).json(unknownFramework(framework));
  const { errors, limitations, hints } = classifierKit.reviewClassifier(framework, req.body.config ?? {});
  res.json({ errors, limitations, hints });
});

app.get('/api/classifiers', (req, res) => {
  res.json(db.prepare('SELECT * FROM classifiers ORDER BY name COLLATE NOCASE').all().map(classifierRow));
});

function classifierNameProblem(name, exceptId = null) {
  if (!name) return { code: 'name-required', error: 'Give the classifier a name.' };
  if (name.length > 100) return { code: 'name-too-long', error: 'Classifier names are limited to 100 characters.' };
  const clash = db.prepare('SELECT id FROM classifiers WHERE name = ?').get(name);
  if (clash && clash.id !== exceptId) return { code: 'name-taken', error: `Another classifier is already called "${name}".`, status: 409 };
  return null;
}

app.post('/api/classifiers', (req, res) => {
  const name = String(req.body.name ?? '').trim();
  const framework = String(req.body.framework ?? '');
  const domain = String(req.body.domain ?? '').trim();
  const config = req.body.config ?? {};

  const nameProblem = classifierNameProblem(name);
  if (nameProblem) return res.status(nameProblem.status ?? 400).json(nameProblem);
  if (!classifierKit.isFramework(framework)) return res.status(400).json(unknownFramework(framework));
  // A classifier without a domain has nothing to vote for, and the engine will not store one.
  if (!domain) return res.status(400).json({ code: 'domain-required', error: 'Choose the domain this classifier votes for.' });
  const { errors } = classifierKit.reviewClassifier(framework, config);
  if (errors.length) return res.status(400).json(configRefusal('invalid-config', errors));

  const info = db.prepare(`
    INSERT INTO classifiers (name, framework, domain_name, description, config) VALUES (?, ?, ?, ?, ?)
  `).run(name, framework, domain, String(req.body.description ?? ''), JSON.stringify(config));
  res.status(201).json(classifierRow(db.prepare('SELECT * FROM classifiers WHERE id = ?').get(info.lastInsertRowid)));
});

/** Name, domain, description and configuration can change; the framework cannot. */
app.put('/api/classifiers/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM classifiers WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Classifier not found' });

  const name = req.body.name === undefined ? current.name : String(req.body.name).trim();
  const domain = req.body.domain === undefined ? current.domain_name : String(req.body.domain).trim();
  const description = req.body.description === undefined ? current.description : String(req.body.description);
  const config = req.body.config === undefined ? parseStoredConfig(current.config) : req.body.config;

  const nameProblem = classifierNameProblem(name, current.id);
  if (nameProblem) return res.status(nameProblem.status ?? 400).json(nameProblem);
  if (!domain) return res.status(400).json({ code: 'domain-required', error: 'Choose the domain this classifier votes for.' });
  const { errors } = classifierKit.reviewClassifier(current.framework, config);
  if (errors.length) return res.status(400).json(configRefusal('invalid-config', errors));

  db.prepare(`
    UPDATE classifiers SET name = ?, domain_name = ?, description = ?, config = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(name, domain, description, JSON.stringify(config), current.id);
  res.json(classifierRow(db.prepare('SELECT * FROM classifiers WHERE id = ?').get(current.id)));
});

app.delete('/api/classifiers/:id', (req, res) => {
  db.prepare('DELETE FROM classifiers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/**
 * Profiles one column with a classifier — saved or not — together with the other saved
 * classifiers of its domain.
 *
 * A saved classifier that cannot take part (Delphix would refuse it, it uses something not
 * testable here, or its list file is missing) is left out and named in `skipped`, rather than
 * failing the test of the one being edited.
 */
app.post('/api/classifiers/test', (req, res) => {
  const c = req.body.classifier ?? {};
  const framework = String(c.framework ?? '');
  const domain = String(c.domain ?? '').trim();
  const editedId = c.id == null ? null : Number(c.id);
  if (!classifierKit.isFramework(framework)) return res.status(400).json(unknownFramework(framework));

  const edited = { id: editedId ?? 'unsaved', name: String(c.name ?? '').trim() || '(unsaved)', domain, framework, config: c.config ?? {} };
  const review = classifierKit.reviewClassifier(framework, edited.config);
  if (review.errors.length) return res.status(400).json(configRefusal('invalid-config', review.errors));
  if (review.limitations.length) return res.status(400).json(configRefusal('cannot-evaluate', review.limitations));
  const missing = classifierFilesMissing(framework, edited.config);
  if (missing.length) {
    return res.status(400).json({ code: 'file-missing', files: missing, error: `No copy of ${missing.join(', ')} on this machine.` });
  }

  const participants = [];
  const skipped = [];
  let placed = false;
  const peers = domain ? db.prepare('SELECT * FROM classifiers WHERE domain_name = ? ORDER BY id').all(domain) : [];
  for (const row of peers) {
    if (row.id === editedId) { participants.push(edited); placed = true; continue; }
    const config = parseStoredConfig(row.config);
    const peerReview = classifierKit.reviewClassifier(row.framework, config);
    const blocking = [...peerReview.errors, ...peerReview.limitations];
    const files = classifierFilesMissing(row.framework, config);
    if (blocking.length) { skipped.push({ name: row.name, error: blocking[0].message }); continue; }
    if (files.length) { skipped.push({ name: row.name, error: `No copy of ${files.join(', ')} on this machine.` }); continue; }
    participants.push({ id: row.id, name: row.name, domain, framework: row.framework, config });
  }
  if (!placed) participants.push(edited);

  const f = req.body.field ?? {};
  const field = {
    name: String(f.name ?? ''),
    parent: f.parent ? String(f.parent) : null,
    sqlType: f.sqlType == null || f.sqlType === '' ? 12 : Number(f.sqlType),
    length: f.length == null || f.length === '' ? null : Number(f.length),
    autoIncrement: Boolean(f.autoIncrement),
    values: Array.isArray(f.values) ? f.values.map((v) => String(v ?? '')) : [],
  };
  const threshold = Number.isFinite(Number(req.body.threshold)) ? Number(req.body.threshold) : 1;

  try {
    const result = classifierKit.evaluateField({ classifiers: participants, field, threshold, readFile: readClassifierFile });
    res.json({ ...result, skipped });
  } catch (err) {
    if (err instanceof classifierKit.EvaluationStopped) return res.json({ failure: err.message, skipped });
    if (err instanceof classifierKit.NotEvaluable) return res.status(400).json(configRefusal('cannot-evaluate', err.issues));
    if (err.code === 'file-missing') return res.status(400).json({ code: err.code, files: [err.file], error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/** The engine's classifiers, with what importing each would mean here. */
app.get('/api/delphix/classifiers', async (req, res) => {
  const cfg = delphixCfg();
  if (!delphix.isConfigured(cfg)) {
    return res.status(400).json({ code: 'not-configured', error: 'No Delphix engine configured yet.' });
  }
  try {
    const [list, frameworks] = await Promise.all([delphix.listClassifiers(cfg), delphix.classifierFrameworks(cfg)]);
    const nameOf = Object.fromEntries(Object.entries(frameworks).map(([name, id]) => [id, name]));
    // Held here by the engine id — a classifier renamed there is still the one imported — or by name.
    const rows = db.prepare('SELECT name, delphix_id, delphix_origin FROM classifiers').all();
    const origin = delphix.apiRoot(cfg.baseUrl);
    const seenIds = new Set(rows.filter((r) => r.delphix_origin === origin && r.delphix_id != null).map((r) => Number(r.delphix_id)));
    const seenNames = new Set(rows.map((r) => r.name));
    const local = localFileNames();
    res.json(list.map((c) => {
      const framework = classifierKit.isFramework(nameOf[c.frameworkId]) ? nameOf[c.frameworkId] : null;
      const config = c.classifierConfiguration ?? {};
      const review = framework ? classifierKit.reviewClassifier(framework, config) : null;
      return {
        classifierId: c.classifierId,
        classifierName: c.classifierName,
        framework,
        domainName: c.domainName ?? '',
        createdBy: c.createdBy ?? null,
        alreadyImported: seenIds.has(Number(c.classifierId)) || seenNames.has(c.classifierName),
        issues: review ? [...review.errors, ...review.limitations] : [],
        // The lists the engine will hand over with it — none has to be copied by hand.
        downloadFiles: framework === 'LIST' ? missingEngineFiles(config, local) : [],
      };
    }).sort((a, b) => a.classifierName.localeCompare(b.classifierName)));
  } catch (err) {
    res.status(err.status && err.status < 500 ? 400 : 502).json({ error: err.message });
  }
});

/**
 * Copies the chosen engine classifiers down with everything they lean on: the domain they vote
 * for, that domain's algorithms, and the list files — updating whatever is already held.
 */
app.post('/api/delphix/classifiers/import', async (req, res) => {
  const cfg = delphixCfg();
  if (!delphix.isConfigured(cfg)) {
    return res.status(400).json({ code: 'not-configured', error: 'No Delphix engine configured yet.' });
  }
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  try {
    const out = await importFromEngine(cfg, { classifiers: ids });
    res.json(importReply(out, 'classifiers', out.classifiers));
  } catch (err) {
    res.status(err.status && err.status < 500 ? 400 : 502).json({ error: err.message });
  }
});

/**
 * Sends one classifier, after its domain.
 *
 * The engine will not keep a classifier whose domain it lacks, so a domain held here goes first —
 * through the same push as the domain editor, which sends the domain's algorithms before it. A
 * domain held neither here nor there is reported rather than invented. A LIST's files go too,
 * uploaded when the engine could not open them otherwise. Limitations do not stop the push:
 * Delphix accepts what this tool merely cannot test.
 */
app.post('/api/delphix/classifiers/export/:id', async (req, res) => {
  const cfg = delphixCfg();
  if (!delphix.isConfigured(cfg)) {
    return res.status(400).json({ code: 'not-configured', error: 'No Delphix engine configured yet.' });
  }
  const row = db.prepare('SELECT * FROM classifiers WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Classifier not found' });
  const config = parseStoredConfig(row.config);
  const { errors } = classifierKit.reviewClassifier(row.framework, config);
  if (errors.length) return res.status(400).json(configRefusal('invalid-config', errors));

  const origin = delphix.apiRoot(cfg.baseUrl);
  try {
    const ctx = exportContext(cfg);
    let domain = null;
    const domainRow = db.prepare('SELECT * FROM domains WHERE name = ?').get(row.domain_name);
    if (domainRow) {
      domain = await pushDomainRow(ctx, domainRow);
    } else {
      const exists = await delphix.getDomain(cfg, row.domain_name).then(() => true).catch((err) => {
        if (err.status === 404) return false;
        throw err;
      });
      if (!exists) {
        return res.status(400).json({
          code: 'domain-missing', domain: row.domain_name,
          error: `Neither this machine nor the engine has a domain called "${row.domain_name}".`,
        });
      }
    }

    const out = await delphix.saveClassifier(cfg, {
      name: row.name,
      framework: row.framework,
      domain: row.domain_name,
      config,
      description: row.description,
      existingId: row.delphix_origin === origin ? row.delphix_id : null,
      prepareConfig: (current) => engineReadyFiles(ctx, config, current),
    });
    db.prepare(`UPDATE classifiers SET delphix_id = ?, delphix_origin = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(out.id, origin, row.id);
    res.json({
      mode: out.mode, name: out.name, engine: origin,
      domain: domain && { mode: domain.mode, name: domain.name },
      sent: ctx.sent, skipped: ctx.skipped, uploaded: ctx.uploaded,
    });
  } catch (err) {
    exportFailure(res, err);
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(DIST, 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const v = VERSION.display ? ` ${VERSION.display}` : '';
  console.log(`Delphix Masking Helper${v} running at http://localhost:${PORT}`);
  const missing = missingJars();
  if (missing.length) {
    console.warn(`\n  ⚠  ${SETUP_HINT}`);
    console.warn(`     Nothing found for: ${missing.join(', ')}\n`);
  }
});
