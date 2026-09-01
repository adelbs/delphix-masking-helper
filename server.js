const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { DatabaseSync } = require('node:sqlite');
const ai = require('./ai');

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

// ── Config helpers (DB-backed) ────────────────────────────────────────────────

function readConfig() {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const stored = Object.fromEntries(rows.map(r => [r.key, r.value]));
  delete stored.globalKey;   // left over from when the key was editable; the constant wins
  return { ...DEFAULT_CONFIG, ...stored };
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
const isApiKey = (k) => k.startsWith('ai.') && k.endsWith('.apiKey');

/** Replaces stored API keys with a mask, plus a `<key>.set` flag so the UI can show state. */
function publicConfig(config) {
  const out = {};
  for (const [k, v] of Object.entries(config)) {
    if (isApiKey(k)) {
      out[k] = v ? KEY_MASK : '';
      out[`${k}.set`] = Boolean(v);
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
  const current = readConfig();
  const patch = {};
  for (const [k, v] of Object.entries(req.body)) {
    if (k === 'globalKey') continue;               // constant, never settable
    if (k.endsWith('.set')) continue;              // read-only UI flag
    if (isApiKey(k) && v === KEY_MASK) continue;   // untouched masked field
    patch[k] = v;
  }
  const updated = { ...current, ...patch };
  writeConfig(updated);
  ensureDir(path.resolve(__dirname, updated.filesDir));
  res.json(publicConfig(updated));
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
  const { name, config, input, output } = req.body;
  const stmt = db.prepare(`
    UPDATE saved_tests
    SET name=?, config=?, input=?, key_value=?, output=?, updated_at=datetime('now')
    WHERE id=?
  `);
  const configStr = typeof config === 'string' ? config : JSON.stringify(config || {});
  stmt.run(name, configStr, input || '', MASKING_KEY, output || null, req.params.id);
  const row = db.prepare('SELECT * FROM saved_tests WHERE id = ?').get(req.params.id);
  res.json(row);
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
