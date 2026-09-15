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
  CREATE TABLE IF NOT EXISTS profile_sets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Unique here and on the engine; like a classifier, the engine renames it in place and
    -- identifies it by delphix_id.
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    -- The confidence a domain must reach, 1-100, for a profiling job to assign it. The engine
    -- falls back to its own asdd/DefaultAssignmentThreshold when a set carries none.
    assignment_threshold INTEGER NOT NULL DEFAULT 80,
    delphix_id     INTEGER,
    delphix_origin TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Which classifiers a set runs. The engine holds the same thing as classifierIds[]; here it is
  -- a table so deleting a classifier cannot leave an id behind that points at nothing.
  CREATE TABLE IF NOT EXISTS profile_set_classifiers (
    profile_set_id INTEGER NOT NULL,
    classifier_id  INTEGER NOT NULL,
    PRIMARY KEY (profile_set_id, classifier_id)
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
async function importFromEngine(cfg, { algorithms = [], domains = [], classifiers = [], profileSets = [], onProgress = null }) {
  const origin = delphix.apiRoot(cfg.baseUrl);
  const out = { profileSets: [], classifiers: [], domains: [], algorithms: [], skipped: [], downloaded: [], needsFiles: [] };

  // Progress, for the dialog to show. The work is discovered as it goes — a classifier drags its
  // domain, a domain its algorithms — so the total is never known up front: it is always what is
  // finished plus what is still queued, and it grows. `step` is called as an item is taken up,
  // whatever becomes of it, so the count reaches the total even when items are skipped.
  let done = 0;
  const step = (kind, name, queued) => {
    done += 1;
    if (onProgress) onProgress({ kind, name, done, total: done + queued });
  };
  if (onProgress) onProgress({ kind: 'reading', name: null, done: 0, total: 0 });

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
  const pendingClassifiers = new Set(classifiers.map(Number));
  // Which engine classifier ids each imported set holds. Resolved to local rows only after the
  // classifiers themselves are in, because that is when they have local ids to point at.
  const memberships = [];

  if (profileSets.length) {
    const sets = await delphix.listProfileSets(cfg);
    const wanted = new Set(profileSets.map(Number));
    const picked = sets.filter((s) => wanted.has(Number(s.profileSetId)));
    for (const [i, s] of picked.entries()) {
      step('profileSet', s.profileSetName, (picked.length - 1 - i)
        + pendingClassifiers.size + pendingDomains.size + pendingAlgorithms.length);
      const threshold = Number(s.assignmentThreshold) || THRESHOLD_DEFAULT;
      // By the engine id first, since a set renamed there is still the one that was imported.
      const existing = db.prepare('SELECT id FROM profile_sets WHERE delphix_id = ? AND delphix_origin = ?').get(s.profileSetId, origin)
        ?? db.prepare('SELECT id FROM profile_sets WHERE name = ?').get(s.profileSetName);
      let localId;
      try {
        if (existing) {
          db.prepare(`
            UPDATE profile_sets SET name = ?, description = ?, assignment_threshold = ?,
                   delphix_id = ?, delphix_origin = ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(s.profileSetName, s.description ?? '', threshold, s.profileSetId, origin, existing.id);
          localId = existing.id;
        } else {
          localId = db.prepare(`
            INSERT INTO profile_sets (name, description, assignment_threshold, delphix_id, delphix_origin)
            VALUES (?, ?, ?, ?, ?)
          `).run(s.profileSetName, s.description ?? '', threshold, s.profileSetId, origin).lastInsertRowid;
        }
      } catch {
        // Renamed on the engine onto a name another local set holds.
        out.skipped.push({ kind: 'profileSet', name: s.profileSetName, reason: 'name-taken' });
        continue;
      }
      const members = (s.classifierIds ?? []).map(Number);
      for (const id of members) pendingClassifiers.add(id);
      memberships.push({ localId, members });
      out.profileSets.push(s.profileSetName);
    }
  }

  if (pendingClassifiers.size) {
    const [list, frameworks] = await Promise.all([delphix.listClassifiers(cfg), delphix.classifierFrameworks(cfg)]);
    const frameworkOf = Object.fromEntries(Object.entries(frameworks).map(([name, id]) => [id, name]));
    const picked = list.filter((c) => pendingClassifiers.has(Number(c.classifierId)));
    for (const [i, c] of picked.entries()) {
      step('classifier', c.classifierName, (picked.length - 1 - i) + pendingDomains.size + pendingAlgorithms.length);
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

  // The sets can only be filled in now: a member is an engine id, and the row it names here has
  // just been created or updated. An id the engine holds but this machine could not take (an
  // unsupported framework) is simply not in the set — and is already named in `skipped`.
  const localByEngineId = new Map(
    db.prepare('SELECT id, delphix_id FROM classifiers WHERE delphix_origin = ? AND delphix_id IS NOT NULL')
      .all(origin).map((r) => [Number(r.delphix_id), r.id])
  );
  for (const { localId, members } of memberships) {
    setMembers(localId, members.map((id) => localByEngineId.get(id)).filter((id) => id != null));
  }

  const domainQueue = [...pendingDomains];
  for (const [i, name] of domainQueue.entries()) {
    step('domain', name, (domainQueue.length - 1 - i) + pendingAlgorithms.length);
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
    step('algorithm', name, pendingAlgorithms.length);
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
  // `all` is the whole engine at once: nothing "came along", because everything was asked for.
  const along = (list, own) => (kind === 'all' || kind === own
    ? list.filter((name) => !imported.includes(name))
    : list);
  return {
    imported,
    related: {
      domains: along(out.domains, 'domains'),
      algorithms: along(out.algorithms, 'algorithms'),
      classifiers: along(out.classifiers, 'classifiers'),
    },
    skipped: out.skipped,
    downloaded: out.downloaded,
    needsFiles: out.needsFiles,
  };
}

/**
 * Runs an import as server-sent events.
 *
 * Bringing everything down takes a while — the engine is listed, then each item is read, and a
 * lookup file may be downloaded along the way — and a plain POST leaves the dialog with nothing
 * to show for it. So each item announces itself as it is taken up, and the reply the dialog used
 * to receive as JSON arrives as the final `done` event.
 *
 * A failure has to travel the same way: by the time the first item is read the status code is
 * long gone, so it is sent as an `error` event instead. Only a refusal raised before any of this
 * — no engine configured — is still a plain JSON 400.
 */
async function streamImport(res, cfg, selection, kind, pickImported) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    const out = await importFromEngine(cfg, { ...selection, onProgress: (p) => send('progress', p) });
    send('done', importReply(out, kind, pickImported(out)));
  } catch (err) {
    send('error', { message: err.message });
  }
  res.end();
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
    // Domains and classifiers already sent in this push, by row id. Sending everything means the
    // same domain is reached by dozens of classifiers; without this each one would PUT it again.
    domainsDone: new Map(),
    classifiersDone: new Map(),
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
  const { framework, config, columns, additionalAlgorithms } = req.body;
  if (!framework || !Array.isArray(columns)) {
    return res.status(400).json({ error: 'framework and columns[] are required' });
  }
  try {
    // A `key` in the request body is ignored on purpose — the key is a constant.
    const result = await runJava({ command: 'mask_multicolumn', framework, config, columns, key: MASKING_KEY, additionalAlgorithms });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Execute batch masking (for frameworks like Shuffle that require multiple values)
app.post('/api/mask-batch', async (req, res) => {
  const { framework, config, inputs, additionalAlgorithms } = req.body;
  if (!framework || !Array.isArray(inputs)) {
    return res.status(400).json({ error: 'framework and inputs[] are required' });
  }
  try {
    const result = await runJava({ command: 'mask_batch', framework, config, inputs, key: MASKING_KEY, additionalAlgorithms });
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
          // The framework behind each built-in. A domain names an algorithm and most of them name
          // one of these, which is never a saved row here — the plugin already holds it — so this
          // is the only way the sidebar can tell what kind of thing such a domain masks.
          frameworkOf: Object.fromEntries(offered.map((item) => [item.name, String(item.framework ?? '')])),
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
  // The membership goes with it: a profile set holding a dangling id would send that id to the
  // engine, which answers 404 for a classifier nobody can name any more.
  db.prepare('DELETE FROM profile_set_classifiers WHERE classifier_id = ?').run(req.params.id);
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

// ── Profile sets ──────────────────────────────────────────────────────────────
//
// A profile set is what a profiling job runs: the classifiers it should try, and the confidence a
// domain has to reach before the job assigns it. Everything else about profiling — how a
// classifier scores, how the scores of a domain combine — belongs to the classifiers, where it is
// configured and tested. So a set is a register: which ones, and how sure is sure enough.

const THRESHOLD_DEFAULT = 80;

/** A set with the classifiers it holds, ordered the way the sidebar and the editor show them. */
function profileSetRow(r) {
  if (!r) return null;
  const members = db.prepare(`
    SELECT c.* FROM profile_set_classifiers m
      JOIN classifiers c ON c.id = m.classifier_id
     WHERE m.profile_set_id = ?
     ORDER BY c.name COLLATE NOCASE
  `).all(r.id);
  return {
    ...r,
    classifier_ids: members.map((c) => c.id),
    // Enough of each member for the list to read without a second request.
    classifiers: members.map((c) => ({ id: c.id, name: c.name, framework: c.framework, domain_name: c.domain_name })),
  };
}

function profileSetNameProblem(name, exceptId = null) {
  if (!name) return { code: 'name-required', error: 'Give the profile set a name.' };
  if (name.length > 100) return { code: 'name-too-long', error: 'Profile set names are limited to 100 characters.' };
  const clash = db.prepare('SELECT id FROM profile_sets WHERE name = ?').get(name);
  if (clash && clash.id !== exceptId) return { code: 'name-taken', error: `Another profile set is already called "${name}".`, status: 409 };
  return null;
}

/** 1-100, as the engine requires. Anything else is refused rather than quietly clamped. */
function thresholdProblem(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    return { code: 'threshold-invalid', error: 'The assignment threshold is a whole number from 1 to 100.' };
  }
  return null;
}

/** Replaces a set's membership, keeping only ids that name a classifier held here. */
function setMembers(profileSetId, ids) {
  const known = new Set(db.prepare('SELECT id FROM classifiers').all().map((r) => r.id));
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(Number))].filter((id) => known.has(id));
  db.prepare('DELETE FROM profile_set_classifiers WHERE profile_set_id = ?').run(profileSetId);
  const add = db.prepare('INSERT OR IGNORE INTO profile_set_classifiers (profile_set_id, classifier_id) VALUES (?, ?)');
  for (const id of wanted) add.run(profileSetId, id);
  return wanted;
}

app.get('/api/profile-sets', (req, res) => {
  res.json(db.prepare('SELECT * FROM profile_sets ORDER BY name COLLATE NOCASE').all().map(profileSetRow));
});

app.post('/api/profile-sets', (req, res) => {
  const name = String(req.body.name ?? '').trim();
  const threshold = req.body.threshold ?? THRESHOLD_DEFAULT;

  const nameProblem = profileSetNameProblem(name);
  if (nameProblem) return res.status(nameProblem.status ?? 400).json(nameProblem);
  const bad = thresholdProblem(threshold);
  if (bad) return res.status(400).json(bad);

  const info = db.prepare(`
    INSERT INTO profile_sets (name, description, assignment_threshold) VALUES (?, ?, ?)
  `).run(name, String(req.body.description ?? ''), Number(threshold));
  setMembers(info.lastInsertRowid, req.body.classifierIds);
  res.status(201).json(profileSetRow(db.prepare('SELECT * FROM profile_sets WHERE id = ?').get(info.lastInsertRowid)));
});

app.put('/api/profile-sets/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM profile_sets WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Profile set not found' });

  const name = req.body.name === undefined ? current.name : String(req.body.name).trim();
  const description = req.body.description === undefined ? current.description : String(req.body.description);
  const threshold = req.body.threshold === undefined ? current.assignment_threshold : req.body.threshold;

  const nameProblem = profileSetNameProblem(name, current.id);
  if (nameProblem) return res.status(nameProblem.status ?? 400).json(nameProblem);
  const bad = thresholdProblem(threshold);
  if (bad) return res.status(400).json(bad);

  db.prepare(`
    UPDATE profile_sets SET name = ?, description = ?, assignment_threshold = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(name, description, Number(threshold), current.id);
  if (req.body.classifierIds !== undefined) setMembers(current.id, req.body.classifierIds);
  res.json(profileSetRow(db.prepare('SELECT * FROM profile_sets WHERE id = ?').get(current.id)));
});

app.delete('/api/profile-sets/:id', (req, res) => {
  db.prepare('DELETE FROM profile_set_classifiers WHERE profile_set_id = ?').run(req.params.id);
  db.prepare('DELETE FROM profile_sets WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
/**
 * Pushes one classifier, after its domain.
 *
 * Returns what `delphix.saveClassifier` returned plus the domain that went ahead of it, if one
 * did. Shared with the profile set export, which has to send every member before it can name them.
 */
async function pushClassifierRow(ctx, row) {
  const already = ctx.classifiersDone.get(row.id);
  if (already) return already;
  const config = parseStoredConfig(row.config);
  let domain = null;
  const domainRow = db.prepare('SELECT * FROM domains WHERE name = ?').get(row.domain_name);
  if (domainRow) {
    domain = await pushDomainRow(ctx, domainRow);
  } else {
    const exists = await delphix.getDomain(ctx.cfg, row.domain_name).then(() => true).catch((err) => {
      if (err.status === 404) return false;
      throw err;
    });
    if (!exists) {
      const err = new Error(`Neither this machine nor the engine has a domain called "${row.domain_name}".`);
      err.code = 'domain-missing';
      err.domain = row.domain_name;
      throw err;
    }
  }

  const out = await delphix.saveClassifier(ctx.cfg, {
    name: row.name,
    framework: row.framework,
    domain: row.domain_name,
    config,
    description: row.description,
    existingId: row.delphix_origin === ctx.origin ? row.delphix_id : null,
    prepareConfig: (current) => engineReadyFiles(ctx, config, current),
  });
  db.prepare(`UPDATE classifiers SET delphix_id = ?, delphix_origin = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(out.id, ctx.origin, row.id);
  const result = { ...out, domain: domain && { mode: domain.mode, name: domain.name } };
  ctx.classifiersDone.set(row.id, result);
  return result;
}

app.post('/api/delphix/classifiers/export/:id', async (req, res) => {
  const cfg = delphixCfg();
  if (!delphix.isConfigured(cfg)) {
    return res.status(400).json({ code: 'not-configured', error: 'No Delphix engine configured yet.' });
  }
  const row = db.prepare('SELECT * FROM classifiers WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Classifier not found' });
  const { errors } = classifierKit.reviewClassifier(row.framework, parseStoredConfig(row.config));
  if (errors.length) return res.status(400).json(configRefusal('invalid-config', errors));

  try {
    const ctx = exportContext(cfg);
    const out = await pushClassifierRow(ctx, row);
    res.json({
      mode: out.mode, name: out.name, engine: ctx.origin, domain: out.domain,
      sent: ctx.sent, skipped: ctx.skipped, uploaded: ctx.uploaded,
    });
  } catch (err) {
    if (err.code === 'domain-missing') {
      return res.status(400).json({ code: err.code, domain: err.domain, error: err.message });
    }
    exportFailure(res, err);
  }
});

// ── Profile sets on the engine ────────────────────────────────────────────────
/** Sends the set after every classifier in it, and names them there by the ids it gets back. */
app.post('/api/delphix/profile-sets/export/:id', async (req, res) => {
  const cfg = delphixCfg();
  if (!delphix.isConfigured(cfg)) {
    return res.status(400).json({ code: 'not-configured', error: 'No Delphix engine configured yet.' });
  }
  const row = db.prepare('SELECT * FROM profile_sets WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Profile set not found' });
  const members = db.prepare(`
    SELECT c.* FROM profile_set_classifiers m
      JOIN classifiers c ON c.id = m.classifier_id
     WHERE m.profile_set_id = ? ORDER BY c.name COLLATE NOCASE
  `).all(row.id);
  if (!members.length) {
    return res.status(400).json({ code: 'no-members', error: 'A profile set with no classifier has nothing to send.' });
  }

  try {
    const ctx = exportContext(cfg);
    // Every member first: the engine stores classifierIds, so a set can only be posted once each
    // of them has an id there. A member that fails stops the push — posting the set without it
    // would silently create a set that profiles for less than it was built to.
    const classifierIds = [];
    const sent = [];
    for (const member of members) {
      const out = await pushClassifierRow(ctx, member);
      if (out.id == null) {
        throw new Error(`The engine accepted "${member.name}" but returned no id, so the set cannot name it.`);
      }
      classifierIds.push(out.id);
      sent.push({ name: out.name, mode: out.mode });
    }

    const out = await delphix.saveProfileSet(cfg, {
      name: row.name,
      description: row.description,
      threshold: row.assignment_threshold,
      classifierIds,
      existingId: row.delphix_origin === ctx.origin ? row.delphix_id : null,
    });
    db.prepare(`UPDATE profile_sets SET delphix_id = ?, delphix_origin = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(out.id, ctx.origin, row.id);

    res.json({
      mode: out.mode, name: out.name, engine: ctx.origin,
      classifiers: sent,
      sent: ctx.sent, skipped: ctx.skipped, uploaded: ctx.uploaded,
    });
  } catch (err) {
    if (err.code === 'domain-missing') {
      return res.status(400).json({ code: err.code, domain: err.domain, error: err.message });
    }
    exportFailure(res, err);
  }
});

// ── The integration as a whole ────────────────────────────────────────────────
//
// One engine, and everything on it. Picking objects one by one was the old shape; what a user
// actually wants is their instance mirrored here, brought up to date on demand, and put back
// when they are done. So there are three buttons — bring it all down, send it all up, and drop
// the integration — and no per-object import anywhere.

/** Copies the whole engine down: every profile set, classifier, domain and algorithm on it. */
app.post('/api/delphix/sync/import', async (req, res) => {
  const cfg = delphixCfg();
  if (!delphix.isConfigured(cfg)) {
    return res.status(400).json({ code: 'not-configured', error: 'No Delphix engine configured yet.' });
  }

  let selection;
  try {
    const [sets, classifiers, domains, algorithms] = await Promise.all([
      delphix.listProfileSets(cfg), delphix.listClassifiers(cfg),
      delphix.listDomains(cfg), delphix.listAlgorithms(cfg),
    ]);
    selection = {
      profileSets: sets.map((s) => s.profileSetId),
      classifiers: classifiers.map((c) => c.classifierId),
      domains: domains.map((d) => d.domainName),
      // The engine's own plugin instances are left out. This tool holds the same plugin, so a
      // saved copy of one would be a row that answers to nothing and cannot be sent back.
      algorithms: algorithms.filter((a) => a.createdBy).map((a) => a.algorithmName),
    };
  } catch (err) {
    // The listing failed, which is before the stream starts, so this can still be a status code.
    return res.status(err.status && err.status < 500 ? 400 : 502).json({ error: err.message });
  }

  await streamImport(res, cfg, selection, 'all',
    (out) => [...out.profileSets, ...out.classifiers, ...out.domains, ...out.algorithms]);
});

/**
 * Sends everything held here to the engine.
 *
 * In dependency order — algorithms, then the domains that name them, then the classifiers that
 * vote for those, then the sets that run the classifiers — so nothing is ever posted before what
 * it references. One export context throughout, which is what keeps a domain reached by three
 * hundred classifiers from being written three hundred times.
 *
 * A failure stops the run and says where it got to. Continuing past one would leave the engine
 * holding a half-sent picture that looks complete.
 */
app.post('/api/delphix/sync/export', async (req, res) => {
  const cfg = delphixCfg();
  if (!delphix.isConfigured(cfg)) {
    return res.status(400).json({ code: 'not-configured', error: 'No Delphix engine configured yet.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const algorithms = db.prepare('SELECT * FROM saved_algorithms ORDER BY name COLLATE NOCASE').all();
  const domains = db.prepare('SELECT * FROM domains ORDER BY name COLLATE NOCASE').all();
  const classifiers = db.prepare('SELECT * FROM classifiers ORDER BY name COLLATE NOCASE').all();
  const sets = db.prepare('SELECT * FROM profile_sets ORDER BY name COLLATE NOCASE').all();
  const total = algorithms.length + domains.length + classifiers.length + sets.length;

  const ctx = exportContext(cfg);
  const out = { algorithms: [], domains: [], classifiers: [], profileSets: [], skipped: [] };
  let done = 0;
  const step = (kind, name) => { done += 1; send('progress', { kind, name, done, total }); };

  try {
    for (const row of algorithms) {
      step('algorithm', row.name);
      const sent = await pushAlgorithmRow(ctx, row, { description: row.display_name });
      out.algorithms.push(sent.name);
    }
    for (const row of domains) {
      step('domain', row.name);
      await pushDomainRow(ctx, row);
      out.domains.push(row.name);
    }
    for (const row of classifiers) {
      step('classifier', row.name);
      const { errors } = classifierKit.reviewClassifier(row.framework, parseStoredConfig(row.config));
      if (errors.length) {
        // Delphix would refuse it anyway; naming it beats failing the other three hundred.
        out.skipped.push({ kind: 'classifier', name: row.name, reason: 'invalid-config' });
        continue;
      }
      await pushClassifierRow(ctx, row);
      out.classifiers.push(row.name);
    }
    for (const row of sets) {
      step('profileSet', row.name);
      const members = db.prepare(`
        SELECT c.* FROM profile_set_classifiers m
          JOIN classifiers c ON c.id = m.classifier_id
         WHERE m.profile_set_id = ? ORDER BY c.name COLLATE NOCASE
      `).all(row.id);
      if (!members.length) {
        out.skipped.push({ kind: 'profileSet', name: row.name, reason: 'no-members' });
        continue;
      }
      const classifierIds = [];
      for (const member of members) {
        const pushed = await pushClassifierRow(ctx, member);
        if (pushed.id != null) classifierIds.push(pushed.id);
      }
      const saved = await delphix.saveProfileSet(cfg, {
        name: row.name, description: row.description, threshold: row.assignment_threshold,
        classifierIds, existingId: row.delphix_origin === ctx.origin ? row.delphix_id : null,
      });
      db.prepare(`UPDATE profile_sets SET delphix_id = ?, delphix_origin = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(saved.id, ctx.origin, row.id);
      out.profileSets.push(saved.name);
    }

    send('done', { ...out, engine: ctx.origin, uploaded: ctx.uploaded, references: ctx.skipped });
  } catch (err) {
    send('error', { message: err.message, done, total });
  }
  res.end();
});

/**
 * Drops the integration: the stored connection, and every row linked to that engine.
 *
 * "Linked" is `delphix_origin`, which is the only record there is of where a row came from — and
 * it is also set on anything *sent* to that engine. So a locally built algorithm that was pushed
 * once is deleted too. That is said plainly in the dialog rather than worked around, because the
 * alternative is a second flag that would lie the moment a row is both.
 *
 * Downloaded files stay in filesDir. They are addressed by name and may well be a copy someone
 * put there by hand; deleting a file nobody can get back to punish a forgotten reference is the
 * wrong trade.
 */
app.delete('/api/delphix/integration', (req, res) => {
  const cfg = delphixCfg();
  const origin = delphix.isConfigured(cfg) ? delphix.apiRoot(cfg.baseUrl) : null;

  const removed = { profileSets: 0, classifiers: 0, domains: 0, algorithms: 0 };
  if (origin) {
    const setIds = db.prepare('SELECT id FROM profile_sets WHERE delphix_origin = ?').all(origin).map((r) => r.id);
    for (const id of setIds) db.prepare('DELETE FROM profile_set_classifiers WHERE profile_set_id = ?').run(id);
    removed.profileSets = db.prepare('DELETE FROM profile_sets WHERE delphix_origin = ?').run(origin).changes;

    const classifierIds = db.prepare('SELECT id FROM classifiers WHERE delphix_origin = ?').all(origin).map((r) => r.id);
    for (const id of classifierIds) db.prepare('DELETE FROM profile_set_classifiers WHERE classifier_id = ?').run(id);
    removed.classifiers = db.prepare('DELETE FROM classifiers WHERE delphix_origin = ?').run(origin).changes;

    removed.domains = db.prepare('DELETE FROM domains WHERE delphix_origin = ?').run(origin).changes;
    removed.algorithms = db.prepare('DELETE FROM saved_algorithms WHERE delphix_origin = ?').run(origin).changes;
    db.prepare('DELETE FROM engine_uploads WHERE origin = ?').run(origin);
  }

  for (const key of ['delphix.baseUrl', 'delphix.username', 'delphix.password', 'delphix.allowSelfSigned']) {
    db.prepare('DELETE FROM config WHERE key = ?').run(key);
  }
  res.json({ ok: true, engine: origin, removed });
});

// ── Pre-configured profile sets ───────────────────────────────────────────────
//
// A preset is a profile set shipped with the tool together with everything it leans on: the
// classifiers it runs, their domains, those domains' algorithms and the files any of them read.
// Each lives in presets/<id>/ — the format is described in presets/README.md.
//
// Loading writes all of it in one transaction, and tags every row with the preset it came from.
// That tag is what makes loading twice a reset rather than a second copy: the rows are found
// again — a classifier or set even after being renamed here — and put back the way they ship.

const PRESETS_DIR = path.join(__dirname, 'presets');
const PRESET_LOCALES = ['en', 'pt-BR', 'es'];
/** How a preset's configuration names one of its own files; rewritten to a path here on load. */
const PRESET_FILE_SCHEME = 'preset-file://';

const PRESET_TABLES = {
  algorithm: 'saved_algorithms',
  domain: 'domains',
  classifier: 'classifiers',
  profileSet: 'profile_sets',
};

for (const table of Object.values(PRESET_TABLES)) {
  for (const col of ['preset_id', 'preset_item']) {
    const has = db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('${table}') WHERE name = ?`).get(col);
    if (!has.n) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
  }
}
db.exec(`
  CREATE TABLE IF NOT EXISTS preset_loads (
    preset_id TEXT PRIMARY KEY,
    version   INTEGER NOT NULL,
    loaded_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

/** Every string in a configuration, passed through `fn`. */
function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  }
  return value;
}

const presetFileName = (s) => (s.startsWith(PRESET_FILE_SCHEME) ? s.slice(PRESET_FILE_SCHEME.length) : null);

function presetFileRefs(config) {
  const names = [];
  mapStrings(config ?? {}, (s) => { const name = presetFileName(s); if (name) names.push(name); return s; });
  return names;
}

/** The configuration as it is stored here: each `preset-file://` pointing at the copy in filesDir. */
const resolvePresetFiles = (config, dir) => mapStrings(config ?? {}, (s) => {
  const name = presetFileName(s);
  return name ? pathToFileURL(path.join(dir, name)).href : s;
});

const listOf = (value) => (Array.isArray(value) ? value : []);

function readPreset(id) {
  const dir = path.join(PRESETS_DIR, id);
  let manifest = null;
  let unreadable = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'preset.json'), 'utf8'));
  } catch (err) {
    unreadable = `preset.json: ${err.message}`;
  }
  const preset = {
    id,
    dir,
    version: manifest?.version ?? null,
    name: manifest?.name ?? {},
    summary: manifest?.summary ?? {},
    profileSet: manifest?.profileSet ?? {},
    classifiers: listOf(manifest?.classifiers),
    domains: listOf(manifest?.domains),
    algorithms: listOf(manifest?.algorithms),
    files: listOf(manifest?.files),
    docs: PRESET_LOCALES.filter((locale) => fs.existsSync(path.join(dir, `doc.${locale}.pdf`))),
  };
  preset.problems = manifest ? presetProblems(preset) : [unreadable];
  return preset;
}

function readPresets() {
  if (!fs.existsSync(PRESETS_DIR)) return [];
  return fs.readdirSync(PRESETS_DIR, { withFileTypes: true })
    // A folder starting with _ holds tooling shared by the presets (the documentation builder).
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_'))
    .map((entry) => readPreset(entry.name))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * What stops a preset from loading. Checked when listing, so a broken one says why on screen
 * instead of failing halfway through a load. The framework classes of the algorithms are the one
 * thing left to the load itself: only the plugin knows them, and asking costs a JVM.
 */
function presetProblems(p) {
  const out = [];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(p.id)) out.push(`The folder name "${p.id}" is not a valid id: use lower-case letters, digits and hyphens.`);
  if (!Number.isInteger(p.version) || p.version < 1) out.push('version must be a whole number from 1 up.');
  if (!p.name.en) out.push('name.en is required.');

  const names = (kind, list) => {
    const seen = new Set();
    for (const item of list) {
      const name = typeof item?.name === 'string' ? item.name.trim() : '';
      if (!name || name.length > 100) out.push(`Every ${kind} needs a name of up to 100 characters.`);
      else if (seen.has(name)) out.push(`Two ${kind}s are called "${name}".`);
      seen.add(name);
    }
    return seen;
  };
  const classifierNames = names('classifier', p.classifiers);
  const domainNames = names('domain', p.domains);
  names('algorithm', p.algorithms);

  const set = p.profileSet;
  if (typeof set.name !== 'string' || !set.name.trim() || set.name.length > 100) out.push('profileSet.name is required, up to 100 characters.');
  if (thresholdProblem(set.threshold ?? THRESHOLD_DEFAULT)) out.push('profileSet.threshold must be a whole number from 1 to 100.');
  const members = listOf(set.classifiers);
  if (!members.length) out.push('profileSet.classifiers must name at least one classifier.');
  for (const name of members) {
    if (!classifierNames.has(name)) out.push(`profileSet.classifiers names "${name}", which is not among the classifiers.`);
  }

  for (const file of p.files) {
    if (typeof file !== 'string' || !file || path.basename(file) !== file) out.push(`files: "${file}" must be a plain file name.`);
    else if (!fs.existsSync(path.join(p.dir, 'files', file))) out.push(`files: ${file} is not in the files/ folder.`);
  }
  const declared = new Set(p.files);
  const undeclared = (kind, item) => {
    for (const ref of presetFileRefs(item.config)) {
      if (!declared.has(ref)) out.push(`${kind} "${item.name}" reads ${ref}, which files does not list.`);
    }
  };

  for (const c of p.classifiers) {
    if (!classifierKit.isFramework(c.framework)) { out.push(`classifier "${c.name}": "${c.framework}" is not a classifier framework.`); continue; }
    // Everything the set leans on ships with it, the same rule the engine sync follows.
    if (!domainNames.has(c.domain)) out.push(`classifier "${c.name}" votes for "${c.domain}", which is not among the domains.`);
    undeclared('classifier', c);
    const { errors } = classifierKit.reviewClassifier(c.framework, resolvePresetFiles(c.config, filesDirPath()));
    for (const e of errors) out.push(`classifier "${c.name}": ${e.message}`);
  }
  for (const a of p.algorithms) {
    if (typeof a.framework !== 'string' || !a.framework) out.push(`algorithm "${a.name}" has no framework.`);
    undeclared('algorithm', a);
  }
  return out;
}

/** What the settings tab lists. */
function presetListing(p) {
  return {
    id: p.id,
    version: p.version,
    name: p.name,
    summary: p.summary,
    profileSet: { name: p.profileSet.name ?? '', threshold: p.profileSet.threshold ?? THRESHOLD_DEFAULT },
    counts: {
      classifiers: p.classifiers.length,
      domains: p.domains.length,
      algorithms: p.algorithms.length,
      files: p.files.length,
    },
    docs: p.docs,
    loaded: db.prepare('SELECT version, loaded_at FROM preset_loads WHERE preset_id = ?').get(p.id) ?? null,
    problems: p.problems,
  };
}

/**
 * Where each item of a preset goes, and what is in the way.
 *
 * The row a load writes is the one tagged with this preset and item — found even if a classifier
 * or set was renamed here — or else the one holding the name. Anything holding the name that is
 * not that row, or a row holding it that did not come from this preset, is a conflict: loading
 * would overwrite or remove something the user made, so it is refused unless confirmed.
 */
function planPreset(p) {
  const plan = { targets: new Map(), clashes: [], conflicts: [] };
  const items = [
    ...p.algorithms.map((item) => ['algorithm', item]),
    ...p.domains.map((item) => ['domain', item]),
    ...p.classifiers.map((item) => ['classifier', item]),
    ['profileSet', p.profileSet],
  ];
  for (const [kind, item] of items) {
    const table = PRESET_TABLES[kind];
    const name = item.name.trim();
    const tagged = db.prepare(`SELECT * FROM ${table} WHERE preset_id = ? AND preset_item = ?`).get(p.id, name);
    const holders = db.prepare(`SELECT * FROM ${table} WHERE name = ?`).all(name);
    const target = tagged ?? holders[0] ?? null;
    plan.targets.set(`${kind}:${name}`, target);
    if (target && target.preset_id !== p.id) plan.conflicts.push({ kind, name });
    for (const row of holders.filter((r) => r.id !== target?.id)) {
      plan.clashes.push({ kind, row });
      plan.conflicts.push({ kind, name });
    }
  }

  // A file is only in the way the first time: after that, resetting means overwriting it.
  const loadedBefore = db.prepare('SELECT 1 FROM preset_loads WHERE preset_id = ?').get(p.id);
  if (!loadedBefore) {
    for (const file of p.files) {
      const dest = path.join(filesDirPath(), file);
      if (fs.existsSync(dest) && !fs.readFileSync(dest).equals(fs.readFileSync(path.join(p.dir, 'files', file)))) {
        plan.conflicts.push({ kind: 'file', name: file });
      }
    }
  }
  plan.loadedBefore = Boolean(loadedBefore);
  return plan;
}

function removePresetClash(kind, id) {
  if (kind === 'classifier') db.prepare('DELETE FROM profile_set_classifiers WHERE classifier_id = ?').run(id);
  if (kind === 'profileSet') db.prepare('DELETE FROM profile_set_classifiers WHERE profile_set_id = ?').run(id);
  db.prepare(`DELETE FROM ${PRESET_TABLES[kind]} WHERE id = ?`).run(id);
}

/**
 * Writes a planned preset. The engine link of a row it lands on is kept, so sending the set to
 * Delphix after a reset updates what is there instead of creating a copy.
 */
function applyPreset(p, plan, displayName) {
  const dir = filesDirPath();
  const target = (kind, name) => plan.targets.get(`${kind}:${name.trim()}`);
  const classifierIds = new Map();
  let setId;

  db.exec('BEGIN');
  try {
    for (const { kind, row } of plan.clashes) removePresetClash(kind, row.id);

    for (const a of p.algorithms) {
      const name = a.name.trim();
      const config = JSON.stringify(resolvePresetFiles(a.config, dir));
      const row = target('algorithm', name);
      if (row) {
        db.prepare(`
          UPDATE saved_algorithms SET name = ?, framework = ?, display_name = ?, config = ?, input = ?, output = NULL,
            preset_id = ?, preset_item = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(name, a.framework, displayName.get(a.framework), config, String(a.input ?? ''), p.id, name, row.id);
      } else {
        db.prepare(`
          INSERT INTO saved_algorithms (name, framework, display_name, config, input, key_value, output, preset_id, preset_item)
          VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
        `).run(name, a.framework, displayName.get(a.framework), config, String(a.input ?? ''), MASKING_KEY, p.id, name);
      }
    }

    for (const d of p.domains) {
      const name = d.name.trim();
      const row = target('domain', name);
      const algorithm = String(d.algorithm ?? '');
      const tokenization = String(d.tokenization ?? '');
      if (row) {
        db.prepare(`
          UPDATE domains SET default_algorithm = ?, default_tokenization = ?, preset_id = ?, preset_item = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(algorithm, tokenization, p.id, name, row.id);
      } else {
        db.prepare(`
          INSERT INTO domains (name, default_algorithm, default_tokenization, preset_id, preset_item) VALUES (?, ?, ?, ?, ?)
        `).run(name, algorithm, tokenization, p.id, name);
      }
    }

    for (const c of p.classifiers) {
      const name = c.name.trim();
      const row = target('classifier', name);
      const config = JSON.stringify(resolvePresetFiles(c.config, dir));
      if (row) {
        // The engine will not change a classifier's framework, so a row that had another one is
        // no longer the engine's classifier: it loses the link, and sending it creates a new one.
        const keepLink = row.framework === c.framework;
        db.prepare(`
          UPDATE classifiers SET name = ?, framework = ?, domain_name = ?, description = ?, config = ?,
            delphix_id = ?, delphix_origin = ?, preset_id = ?, preset_item = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(name, c.framework, c.domain, String(c.description ?? ''), config,
          keepLink ? row.delphix_id : null, keepLink ? row.delphix_origin : null, p.id, name, row.id);
        classifierIds.set(name, row.id);
      } else {
        const info = db.prepare(`
          INSERT INTO classifiers (name, framework, domain_name, description, config, preset_id, preset_item)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(name, c.framework, c.domain, String(c.description ?? ''), config, p.id, name);
        classifierIds.set(name, Number(info.lastInsertRowid));
      }
    }

    const set = p.profileSet;
    const setName = set.name.trim();
    const setRow = target('profileSet', setName);
    const threshold = Number(set.threshold ?? THRESHOLD_DEFAULT);
    let setId;
    if (setRow) {
      db.prepare(`
        UPDATE profile_sets SET name = ?, description = ?, assignment_threshold = ?, preset_id = ?, preset_item = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(setName, String(set.description ?? ''), threshold, p.id, setName, setRow.id);
      setId = setRow.id;
    } else {
      setId = Number(db.prepare(`
        INSERT INTO profile_sets (name, description, assignment_threshold, preset_id, preset_item) VALUES (?, ?, ?, ?, ?)
      `).run(setName, String(set.description ?? ''), threshold, p.id, setName).lastInsertRowid);
    }
    setMembers(setId, listOf(set.classifiers).map((name) => classifierIds.get(name.trim())));

    // Rows an older version of the preset shipped and this one does not: left alone, but no longer
    // counted as the preset's, so a later reset does not pretend to own them.
    const shipped = {
      algorithm: p.algorithms.map((a) => a.name.trim()),
      domain: p.domains.map((d) => d.name.trim()),
      classifier: p.classifiers.map((c) => c.name.trim()),
      profileSet: [setName],
    };
    for (const [kind, table] of Object.entries(PRESET_TABLES)) {
      db.prepare(`
        UPDATE ${table} SET preset_id = NULL, preset_item = NULL
        WHERE preset_id = ? AND preset_item NOT IN (SELECT value FROM json_each(?))
      `).run(p.id, JSON.stringify(shipped[kind]));
    }

    db.prepare(`
      INSERT INTO preset_loads (preset_id, version, loaded_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(preset_id) DO UPDATE SET version = excluded.version, loaded_at = excluded.loaded_at
    `).run(p.id, p.version);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  ensureDir(dir);
  for (const file of p.files) fs.copyFileSync(path.join(p.dir, 'files', file), path.join(dir, file));
  return { mode: plan.loadedBefore ? 'reset' : 'loaded', profileSetId: setId, files: p.files };
}

app.get('/api/presets', (req, res) => {
  res.json(readPresets().map(presetListing));
});

/** The documentation PDF, in the requested language when there is one, else English, else any. */
app.get('/api/presets/:id/doc', (req, res) => {
  const p = readPresets().find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'No pre-configured profile set by that id.' });
  const locale = [req.query.locale, 'en', ...p.docs].find((l) => p.docs.includes(l));
  if (!locale) return res.status(404).json({ code: 'no-doc', error: 'This profile set has no documentation yet.' });
  res.download(path.join(p.dir, `doc.${locale}.pdf`), `${p.id}.${locale}.pdf`);
});

/**
 * Creates the preset — or, when it was loaded before, puts every row back the way it ships.
 * Answers 409 with `conflicts` when that would overwrite something that did not come from it;
 * sending `overwrite: true` is the confirmation.
 */
app.post('/api/presets/:id/load', async (req, res) => {
  const p = readPresets().find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'No pre-configured profile set by that id.' });
  if (p.problems.length) {
    return res.status(400).json({ code: 'preset-invalid', problems: p.problems, error: p.problems.join(' ') });
  }

  let displayName;
  try {
    displayName = new Map((await runJava({ command: 'list' })).map((a) => [a.className, a.displayName]));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  const unknown = p.algorithms.filter((a) => !displayName.has(a.framework));
  if (unknown.length) {
    const problems = unknown.map((a) => `algorithm "${a.name}": the plugin has no framework ${a.framework}.`);
    return res.status(400).json({ code: 'preset-invalid', problems, error: problems.join(' ') });
  }

  const plan = planPreset(p);
  if (plan.conflicts.length && req.body?.overwrite !== true) {
    return res.status(409).json({
      code: 'preset-conflict',
      conflicts: plan.conflicts,
      error: `Already on this machine, and not from this profile set: ${plan.conflicts.map((c) => c.name).join(', ')}.`,
    });
  }
  try {
    res.json(applyPreset(p, plan, displayName));
  } catch (err) {
    res.status(500).json({ error: err.message });
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
