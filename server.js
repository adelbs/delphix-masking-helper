const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { DatabaseSync } = require('node:sqlite');
const ai = require('./ai');
const delphix = require('./delphix');

const app = express();
app.use(express.json());
const DIST = path.join(__dirname, 'frontend', 'dist');
app.use(express.static(DIST));

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
  return [RUNNER_JAR, ...jars].join(':');
}

// ── Java runner ───────────────────────────────────────────────────────────────

function runJava(request) {
  return new Promise((resolve, reject) => {
    const pluginJar = findPluginJar();
    if (!pluginJar) return reject(new Error(SETUP_HINT));

    const cp = buildClasspath();
    const proc = spawn('java', [
      `-Dplugin.jar=${pluginJar}`,
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

const DB_PATH = path.join(__dirname, 'db', 'tests.db');
ensureDir(path.dirname(DB_PATH));
const db = new DatabaseSync(DB_PATH);

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
  CREATE TABLE IF NOT EXISTS saved_tests (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    algorithm TEXT NOT NULL,
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
  const has = db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('saved_tests') WHERE name = ?`).get(col);
  if (!has.n) db.exec(`ALTER TABLE saved_tests ADD COLUMN ${col} ${decl}`);
}

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
  writeConfig(updated);
  ensureDir(path.resolve(__dirname, updated.filesDir));
  res.json(publicConfig(readConfig()));
});

// ── AI assistant ─────────────────────────────────────────────────────────────

// The catalog needs one JVM fork per algorithm, so it is built once and reused.
// Warmed in the background at startup so the first chat message isn't slow.
const buildCatalogCached = () => ai.buildCatalog(runJava);
buildCatalogCached().then(
  (c) => console.log(`AI: algorithm catalog ready (${(c.length / 1024).toFixed(0)} KB)`),
  (err) => console.warn(`AI: could not build the algorithm catalog — ${err.message}`)
);

app.get('/api/ai/status', async (req, res) => {
  const config = readConfig();
  const cfg = ai.providerSettings(config, config.aiProvider);
  const status = await ai.probe(cfg);
  res.json({ provider: cfg.id, model: cfg.model, baseUrl: cfg.baseUrl, ...status });
});

/** Runs the algorithm the model proposed; only a configuration that actually masks gets saved. */
async function validateAndSave(spec) {
  if (!spec || typeof spec !== 'object') return { error: 'Malformed algorithm block.' };
  const { name, className, config, testInput } = spec;
  if (!name || !className) return { error: 'The algorithm block is missing name or className.' };

  const list = await runJava({ command: 'list' });
  const algo = list.find((a) => a.className === className)
    || list.find((a) => a.className.split('.').pop() === String(className).split('.').pop());
  if (!algo) return { error: `Unknown algorithm: ${className}` };

  const input = testInput ?? '';
  let result;
  try {
    result = await runJava({ command: 'mask', algorithm: algo.className, config: config || {}, input, key: MASKING_KEY });
  } catch (err) {
    return { error: `The configuration failed to run: ${err.message}` };
  }
  if (result.error) return { error: `The configuration failed to run: ${result.error}` };

  const stmt = db.prepare(`
    INSERT INTO saved_tests (name, algorithm, display_name, config, input, key_value, output)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(name, algo.className, algo.displayName,
    JSON.stringify(config || {}), input, MASKING_KEY, result.output ?? null);
  return {
    saved: {
      id: Number(info.lastInsertRowid), name, className: algo.className,
      displayName: algo.displayName, input, output: result.output ?? null,
    },
  };
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
      system: ai.buildSystemPrompt(catalog),
      messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') })),
      onDelta: (delta) => send('delta', { delta }),
      signal: controller.signal,
    });

    const { spec, text, parseError } = ai.extractSaveBlock(full);
    if (text !== full) send('replace', { text });
    if (parseError) send('warn', { message: 'The assistant emitted an algorithm block that was not valid JSON.' });
    if (spec) {
      const outcome = await validateAndSave(spec);
      send(outcome.error ? 'save-error' : 'saved', outcome.error ? { message: outcome.error } : outcome.saved);
    }
    send('done', {});
  } catch (err) {
    if (!controller.signal.aborted) send('error', { message: err.message });
  }
  res.end();
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
      'SELECT delphix_name FROM saved_tests WHERE delphix_origin = ?').all(origin)
      .map((r) => r.delphix_name);
    res.json(list.map((a) => ({
      ...a,
      supported: Boolean(a.className) && known.has(a.className),
      alreadyImported: seen.includes(a.algorithmName),
    })));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/** Copies the named engine algorithms into the local saved list. */
app.post('/api/delphix/import', async (req, res) => {
  const cfg = delphixCfg();
  const names = Array.isArray(req.body.names) ? req.body.names : [];
  if (!names.length) return res.status(400).json({ error: 'names[] is required' });
  try {
    const origin = delphix.apiRoot(cfg.baseUrl);
    const remote = await delphix.listAlgorithms(cfg);
    const byName = Object.fromEntries(remote.map((a) => [a.algorithmName, a]));
    const list = await runJava({ command: 'list' });
    const display = Object.fromEntries(list.map((a) => [a.className, a.displayName]));

    const imported = [], skipped = [];
    const insert = db.prepare(`
      INSERT INTO saved_tests (name, algorithm, display_name, config, input, key_value, output,
                               delphix_name, delphix_origin)
      VALUES (?, ?, ?, ?, '', ?, NULL, ?, ?)
    `);
    const update = db.prepare(`
      UPDATE saved_tests SET name = ?, algorithm = ?, display_name = ?, config = ?,
             updated_at = datetime('now')
      WHERE delphix_name = ? AND delphix_origin = ?
    `);
    for (const name of names) {
      const a = byName[name];
      if (!a) { skipped.push({ name, reason: 'not-found' }); continue; }
      if (!a.className || !display[a.className]) {
        // A framework this tool cannot run locally — importing it would create a row that
        // can never be tested, so it is refused with the reason rather than half-imported.
        skipped.push({ name, reason: 'unsupported-framework', framework: a.frameworkName });
        continue;
      }
      const cfgJson = JSON.stringify(a.config ?? {});
      const existing = db.prepare(
        'SELECT id FROM saved_tests WHERE delphix_name = ? AND delphix_origin = ?').get(name, origin);
      if (existing) update.run(name, a.className, display[a.className], cfgJson, name, origin);
      else insert.run(name, a.className, display[a.className], cfgJson, MASKING_KEY, name, origin);
      imported.push(name);
    }
    res.json({ imported, skipped });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/** Pushes one saved algorithm to the engine — updating it when it came from there. */
app.post('/api/delphix/export/:id', async (req, res) => {
  const cfg = delphixCfg();
  if (!delphix.isConfigured(cfg)) {
    return res.status(400).json({ code: 'not-configured', error: 'No Delphix engine is configured.' });
  }
  const row = db.prepare('SELECT * FROM saved_tests WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Saved algorithm not found' });

  // Rows written before the double-serialisation fix hold a JSON *string*, not an object.
  // Sending that as algorithmExtension makes the engine fail with its generic 500.
  const config = parseStoredConfig(row.config);

  const origin = delphix.apiRoot(cfg.baseUrl);
  // Only update in place when the row came from *this* engine; the same name on a different
  // engine is a different algorithm.
  const linked = row.delphix_origin === origin ? row.delphix_name : null;
  const asked = req.body.name ? String(req.body.name).trim() : null;

  // The engine refuses a changed algorithmName on update, so a rename can only ever mean a new
  // algorithm. Asking for a name different from the linked one is therefore a deliberate
  // "save a copy under this name"; with no name given, the linked algorithm is updated and the
  // local rename is reported back instead of being silently dropped.
  const existingName = asked && asked !== linked ? null : linked;
  const name = asked || linked || String(row.name).trim();
  const renamedLocally = Boolean(existingName && !asked && String(row.name).trim() !== existingName);

  try {
    const out = await delphix.saveAlgorithm(cfg, {
      name,
      className: row.algorithm,
      config,
      description: req.body.description,
      existingName,
    });
    db.prepare(`UPDATE saved_tests SET delphix_name = ?, delphix_origin = ?,
                updated_at = datetime('now') WHERE id = ?`).run(out.name, origin, row.id);
    res.json({ mode: out.mode, name: out.name, engine: origin, renamed: Boolean(out.renamed) || renamedLocally });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

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
  // interface language (see `example.sampleFiles` in the algo-text.*.ts files).
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

// List algorithms
app.get('/api/algorithms', async (req, res) => {
  try {
    const result = await runJava({ command: 'list' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get JSON schema for an algorithm
app.get('/api/algorithms/:className/schema', async (req, res) => {
  try {
    const result = await runJava({
      command: 'schema',
      algorithm: req.params.className
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Execute multi-column masking (for GenericDataRow algorithms like MultiColumnCondition)
app.post('/api/mask-multicolumn', async (req, res) => {
  const { algorithm, config, columns } = req.body;
  if (!algorithm || !Array.isArray(columns)) {
    return res.status(400).json({ error: 'algorithm and columns[] are required' });
  }
  try {
    // A `key` in the request body is ignored on purpose — the key is a constant.
    const result = await runJava({ command: 'mask_multicolumn', algorithm, config, columns, key: MASKING_KEY });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Execute batch masking (for algorithms like Shuffle that require multiple values)
app.post('/api/mask-batch', async (req, res) => {
  const { algorithm, config, inputs } = req.body;
  if (!algorithm || !Array.isArray(inputs)) {
    return res.status(400).json({ error: 'algorithm and inputs[] are required' });
  }
  try {
    const result = await runJava({ command: 'mask_batch', algorithm, config, inputs, key: MASKING_KEY });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Execute masking
app.post('/api/mask', async (req, res) => {
  const { algorithm, config, input, mode, additionalAlgorithms } = req.body;
  if (!algorithm || input === undefined) {
    return res.status(400).json({ error: 'algorithm and input are required' });
  }
  try {
    const result = await runJava({ command: 'mask', algorithm, config, input, key: MASKING_KEY, mode, additionalAlgorithms });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List saved tests
app.get('/api/tests', (req, res) => {
  const { algorithm } = req.query;
  let stmt;
  if (algorithm) {
    stmt = db.prepare('SELECT * FROM saved_tests WHERE algorithm = ? ORDER BY updated_at DESC');
    res.json(stmt.all(algorithm));
  } else {
    stmt = db.prepare('SELECT * FROM saved_tests ORDER BY updated_at DESC');
    res.json(stmt.all());
  }
});

// Save a test
app.post('/api/tests', (req, res) => {
  const { name, algorithm, display_name, config, input, output } = req.body;
  if (!name || !algorithm) {
    return res.status(400).json({ error: 'name and algorithm are required' });
  }
  const stmt = db.prepare(`
    INSERT INTO saved_tests (name, algorithm, display_name, config, input, key_value, output)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const configStr = typeof config === 'string' ? config : JSON.stringify(config || {});
  const result = stmt.run(
    name, algorithm, display_name || algorithm,
    configStr, input || '', MASKING_KEY, output || null
  );
  const row = db.prepare('SELECT * FROM saved_tests WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(row);
});

// Update a test
app.put('/api/tests/:id', (req, res) => {
  const { config, input, output } = req.body;
  // The name is identity, mirroring the engine: it is set on create or on duplicate, never
  // edited. Accepting a new one here would let a local copy drift from the algorithm it tracks.
  const current = db.prepare('SELECT * FROM saved_tests WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Saved algorithm not found' });

  // Only what the caller sent is changed. Defaulting an absent field would let an update of,
  // say, just the input silently erase the configuration.
  const configStr = config === undefined
    ? current.config
    : (typeof config === 'string' ? config : JSON.stringify(config ?? {}));

  db.prepare(`
    UPDATE saved_tests
    SET config=?, input=?, key_value=?, output=?, updated_at=datetime('now')
    WHERE id=?
  `).run(
    configStr,
    input === undefined ? current.input : input,
    MASKING_KEY,
    output === undefined ? current.output : (output || null),
    req.params.id,
  );
  const row = db.prepare('SELECT * FROM saved_tests WHERE id = ?').get(req.params.id);
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
app.post('/api/tests/:id/duplicate', (req, res) => {
  const row = db.prepare('SELECT * FROM saved_tests WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Saved algorithm not found' });

  const name = String(req.body.name ?? '').trim();
  if (!name) return res.status(400).json({ code: 'name-required', error: 'A name is required.' });

  const clash = db.prepare('SELECT id FROM saved_tests WHERE name = ?').get(name);
  if (clash) return res.status(409).json({ code: 'name-taken', error: `"${name}" already exists.` });

  const info = db.prepare(`
    INSERT INTO saved_tests (name, algorithm, display_name, config, input, key_value, output)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, row.algorithm, row.display_name, row.config, row.input, MASKING_KEY, row.output);
  res.status(201).json(db.prepare('SELECT * FROM saved_tests WHERE id = ?').get(info.lastInsertRowid));
});

// Delete a test
app.delete('/api/tests/:id', (req, res) => {
  db.prepare('DELETE FROM saved_tests WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Export all tests
app.get('/api/tests/export', (req, res) => {
  const rows = db.prepare('SELECT * FROM saved_tests ORDER BY id').all();
  res.setHeader('Content-Disposition', 'attachment; filename="delphix-tests.json"');
  res.json(rows);
});

// Import tests
app.post('/api/tests/import', (req, res) => {
  const tests = req.body;
  if (!Array.isArray(tests)) return res.status(400).json({ error: 'Expected array' });
  const stmt = db.prepare(`
    INSERT INTO saved_tests (name, algorithm, display_name, config, input, key_value, output)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let count = 0;
  for (const t of tests) {
    try {
      stmt.run(t.name, t.algorithm, t.display_name, t.config, t.input, MASKING_KEY, t.output);
      count++;
    } catch {}
  }
  res.json({ imported: count });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(DIST, 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Delphix Masking Helper running at http://localhost:${PORT}`);
  const missing = missingJars();
  if (missing.length) {
    console.warn(`\n  ⚠  ${SETUP_HINT}`);
    console.warn(`     Nothing found for: ${missing.join(', ')}\n`);
  }
});
