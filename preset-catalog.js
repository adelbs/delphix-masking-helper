// The presets, without shipping them all.
//
// Each preset is tens of megabytes — mostly its documentation PDFs — and a user loads one or two.
// So an install brings only presets/index.json, the catalog: what the list shows for every preset,
// and the size and SHA-256 of each file it has. A preset's files come down when the user first
// does something with it — load, unload, open the documentation, download the package — into
// db/presets/<id>/: from the files attached to this install's release on GitHub (one zip with the
// data, one file per PDF, written by scripts/release-assets.mjs), and, for what the release lacks or
// a checkout between releases, file by file from the repository at the commit this install runs.
// Each file is checked against the catalog, so what lands is exactly what this version shipped. A
// machine without access to GitHub takes the zip copied by hand (importPackage).
//
// A checkout that has presets/<id>/ (the maintainer's, or an install from before) reads it from
// there and downloads nothing.
//
//   node preset-catalog.js --write   writes presets/index.json from the preset folders
//   node preset-catalog.js --check   fails when presets/index.json is not what --write would write

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const delphix = require('./delphix');
const { unzip } = require('./zip');

const ROOT = __dirname;
const PRESETS_DIR = path.join(ROOT, 'presets');
const CATALOG_FILE = path.join(PRESETS_DIR, 'index.json');
const CACHE_DIR = path.join(ROOT, 'db', 'presets');
const PRESET_LOCALES = ['en', 'pt-BR', 'es'];
const PRESET_PACKS = ['essential', 'extended'];
/** How a preset's configuration names one of its own files; rewritten to a path here on load. */
const PRESET_FILE_SCHEME = 'preset-file://';
const CATALOG_FORMAT = 1;
const DOWNLOADS_AT_ONCE = 6;

// ── The parts of a preset ─────────────────────────────────────────────────────

const listOf = (value) => (Array.isArray(value) ? value : []);

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

const presetPackIds = (p) => PRESET_PACKS.filter((pack) => pack === 'extended' || p.packs?.essential);

/**
 * The part of a preset one pack loads. Extended is all of it. Essential is the listed domains, the
 * classifiers that vote for them, the algorithms those domains name together with everything those
 * reference, and the files any of that reads — the same closure the engine sync follows.
 */
function presetPack(p, pack) {
  if (pack === 'extended') return { ...p, pack };
  const essential = p.packs.essential;
  const wanted = new Set(listOf(essential.domains));
  const domains = p.domains.filter((d) => wanted.has(d.name.trim()));
  const classifiers = p.classifiers.filter((c) => wanted.has(c.domain));

  const byName = new Map(p.algorithms.map((a) => [a.name.trim(), a]));
  const reached = new Set();
  const reach = (name) => {
    const key = String(name ?? '').trim();
    if (reached.has(key) || !byName.has(key)) return;
    reached.add(key);
    for (const ref of delphix.algorithmReferenceNames(byName.get(key).config)) reach(ref);
  };
  for (const d of domains) { reach(d.algorithm); reach(d.tokenization); }
  const algorithms = p.algorithms.filter((a) => reached.has(a.name.trim()));

  const read = new Set([...algorithms, ...classifiers].flatMap((item) => presetFileRefs(item.config)));
  const members = new Set(classifiers.map((c) => c.name.trim()));
  return {
    ...p,
    pack,
    domains,
    classifiers,
    algorithms,
    files: p.files.filter((file) => read.has(file)),
    profileSet: {
      ...p.profileSet,
      description: essential.description ?? p.profileSet.description,
      classifiers: listOf(p.profileSet.classifiers).filter((name) => members.has(name.trim())),
    },
  };
}

const presetCounts = (view) => ({
  classifiers: view.classifiers.length,
  domains: view.domains.length,
  algorithms: view.algorithms.length,
  files: view.files.length,
});

/** A manifest in the shape the functions above take. */
function manifestShape(id, dir, manifest) {
  return {
    id,
    dir,
    version: manifest?.version ?? null,
    versionDate: manifest?.versionDate ?? null,
    region: manifest?.region ?? null,
    country: manifest?.country ?? null,
    name: manifest?.name ?? {},
    summary: manifest?.summary ?? {},
    profileSet: manifest?.profileSet ?? {},
    packs: manifest?.packs ?? {},
    classifiers: listOf(manifest?.classifiers),
    domains: listOf(manifest?.domains),
    algorithms: listOf(manifest?.algorithms),
    files: listOf(manifest?.files),
  };
}

// ── The catalog ───────────────────────────────────────────────────────────────

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const isPresetDir = (dir) => fs.existsSync(path.join(dir, 'preset.json'));

/** The folders under presets/ that hold a preset. A folder starting with _ holds shared tooling. */
function presetFolders() {
  if (!fs.existsSync(PRESETS_DIR)) return [];
  return fs.readdirSync(PRESETS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_') && isPresetDir(path.join(PRESETS_DIR, e.name)))
    .map((e) => e.name)
    .sort();
}

/** The files a preset uses here: the manifest, the files it reads, its documentation. */
function usedFiles(dir, manifest) {
  const docs = PRESET_LOCALES.map((l) => `doc.${l}.pdf`).filter((f) => fs.existsSync(path.join(dir, f)));
  const files = listOf(manifest.files).filter((f) => typeof f === 'string' && f && path.basename(f) === f).map((f) => `files/${f}`);
  return ['preset.json', ...files, ...docs];
}

/** What the catalog says of one preset folder. */
function catalogEntry(id) {
  const dir = path.join(PRESETS_DIR, id);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'preset.json'), 'utf8'));
  const p = manifestShape(id, dir, manifest);
  return {
    id,
    version: p.version,
    versionDate: p.versionDate,
    region: p.region,
    country: p.country,
    name: p.name,
    summary: p.summary,
    profileSet: { name: p.profileSet.name ?? '' },
    packs: Object.fromEntries(presetPackIds(p).map((pack) => [pack, presetCounts(presetPack(p, pack))])),
    docs: PRESET_LOCALES.filter((l) => fs.existsSync(path.join(dir, `doc.${l}.pdf`))),
    files: usedFiles(dir, manifest).filter((f) => fs.existsSync(path.join(dir, f))).map((f) => {
      const file = path.join(dir, f);
      return { path: f, size: fs.statSync(file).size, sha256: sha256(file) };
    }),
  };
}

function buildCatalog() {
  return { format: CATALOG_FORMAT, presets: presetFolders().map(catalogEntry) };
}

let catalogCache = null;
/** presets/index.json, read again when it changes. */
function readCatalog() {
  let stat;
  try { stat = fs.statSync(CATALOG_FILE); } catch { return { format: CATALOG_FORMAT, presets: [] }; }
  if (catalogCache?.mtimeMs !== stat.mtimeMs) {
    let data;
    try { data = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')); } catch { data = { presets: [] }; }
    catalogCache = { mtimeMs: stat.mtimeMs, data: { format: data.format ?? CATALOG_FORMAT, presets: listOf(data.presets) } };
  }
  return catalogCache.data;
}

const catalogEntryOf = (id) => readCatalog().presets.find((e) => e.id === id) ?? null;

/** The ids of every preset there is: in the catalog, or in a folder here. */
function presetIds() {
  return [...new Set([...readCatalog().presets.map((e) => e.id), ...presetFolders()])].sort();
}

// ── Where a preset's files are ───────────────────────────────────────────────

const repoDir = (id) => path.join(PRESETS_DIR, id);
const cacheDir = (id) => path.join(CACHE_DIR, id);

/** Whether the files of this preset live in the checkout, so nothing is ever downloaded for it. */
const isLocal = (id) => isPresetDir(repoDir(id));

/**
 * How much of a preset is here: `local` (the checkout has it), `downloaded` (the cache holds what
 * this version needs to load), `outdated` (the cache holds an older one) or `remote` (nothing yet).
 * `size` is what a load would still download, in bytes.
 */
function downloadState(id) {
  if (isLocal(id)) return { state: 'local', size: 0 };
  const entry = catalogEntryOf(id);
  if (!entry) return { state: 'remote', size: 0 };
  const loadFiles = entry.files.filter((f) => !f.path.startsWith('doc.'));
  const missing = loadFiles.filter((f) => !sameFile(path.join(cacheDir(id), f.path), f, true));
  const size = missing.reduce((n, f) => n + f.size, 0);
  if (!missing.length) return { state: 'downloaded', size: 0 };
  return { state: isPresetDir(cacheDir(id)) ? 'outdated' : 'remote', size };
}

/**
 * Whether a file here is the one the catalog names. `quick` compares the size only — for the list,
 * which runs often; a download always checks the hash.
 */
function sameFile(file, want, quick = false) {
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (stat.size !== want.size) return false;
  return quick || sha256(file) === want.sha256;
}

// ── Downloading ──────────────────────────────────────────────────────────────

let releaseCache;
/**
 * What release.json says, in an install made from a release archive: its tag, its commit and the
 * files it brought. Null in a git checkout.
 */
function installedRelease() {
  if (releaseCache === undefined) {
    try { releaseCache = JSON.parse(fs.readFileSync(path.join(ROOT, 'release.json'), 'utf8')); } catch { releaseCache = null; }
  }
  return releaseCache;
}

const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();

let refCache;
/** The commit this install runs — what the catalog was written from — else its release tag. */
function sourceRef() {
  if (process.env.PRESETS_REF) return process.env.PRESETS_REF;
  if (refCache) return refCache;
  const release = installedRelease();
  if (release?.commit) return (refCache = release.commit);
  try { refCache = git('rev-parse', 'HEAD'); } catch { refCache = `v${require('./package.json').version}`; }
  return refCache;
}

let tagCache;
/** The release this install is, vMAJOR.MINOR.PATCH, or null: a checkout between releases has none. */
function releaseTag() {
  if (process.env.PRESETS_TAG !== undefined) return process.env.PRESETS_TAG || null;
  if (tagCache !== undefined) return tagCache;
  const release = installedRelease();
  let tag = release?.tag ?? null;
  if (!tag) { try { tag = git('describe', '--tags', '--exact-match', 'HEAD'); } catch { tag = null; } }
  tagCache = tag && /^v\d+\.\d+\.\d+$/.test(tag) ? tag : null;
  return tagCache;
}

/** owner/name of the repository, from package.json's repository. */
function repository() {
  const url = String(require('./package.json').repository?.url ?? '');
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)(\.git)?$/);
  if (!m) throw new PresetDownloadError(`No GitHub repository in package.json to download presets from (${url || 'none'}).`);
  return `${m[1]}/${m[2]}`;
}

/** Where the raw files of the repository are, at the commit this install runs. */
function rawBase() {
  if (process.env.PRESETS_BASE_URL) return process.env.PRESETS_BASE_URL.replace(/\/+$/, '');
  return `https://raw.githubusercontent.com/${repository()}/${sourceRef()}`;
}

/** Where the files attached to this install's release are, or null between releases. */
function releaseBase() {
  if (process.env.PRESETS_RELEASE_URL !== undefined) return process.env.PRESETS_RELEASE_URL.replace(/\/+$/, '') || null;
  const tag = releaseTag();
  return tag ? `https://github.com/${repository()}/releases/download/${tag}` : null;
}

/** The names of a preset's files attached to a release — what scripts/release-assets.mjs writes. */
const assetName = {
  data: (id) => `preset-${id}.zip`,
  doc: (id, locale) => `preset-${id}.doc.${locale}.pdf`,
};

class PresetDownloadError extends Error {}

/** The body at a URL; null for a 404, an error for anything else that is not a 200. */
async function fetchBody(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  } catch (err) {
    throw new PresetDownloadError(`Could not reach ${url}: ${err.cause?.message ?? err.message}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new PresetDownloadError(`${url} answered HTTP ${res.status}.`);
  return Buffer.from(await res.arrayBuffer());
}

const isFile = (body, want) => body.length === want.size && crypto.createHash('sha256').update(body).digest('hex') === want.sha256;

/** Writes a file the catalog names, refusing one that is not the file this version ships. */
function writeChecked(dir, want, body, from) {
  if (!isFile(body, want)) throw new PresetDownloadError(`${from}: ${want.path} is not the file this version ships (size or SHA-256 differ).`);
  const dest = path.join(dir, ...want.path.split('/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(`${dest}.part`, body);
  fs.renameSync(`${dest}.part`, dest);
}

/**
 * The files `todo` names, from the zip of `name` attached to the release, when there is one.
 * Returns what is still missing: everything when the release has no such file.
 */
async function fromRelease(dir, name, todo) {
  const base = releaseBase();
  if (!base || !todo.length) return todo;
  let body;
  try { body = await fetchBody(`${base}/${name}`); } catch { return todo; }
  if (!body) return todo;
  if (!name.endsWith('.zip')) {
    writeChecked(dir, todo[0], body, name);
    return todo.slice(1);
  }
  const inZip = new Map(unzip(body).map((e) => [e.path, e.data]));
  const left = [];
  for (const f of todo) {
    const data = inZip.get(f.path);
    if (data) writeChecked(dir, f, data, name); else left.push(f);
  }
  return left;
}

/** One file at a time from the repository, at the commit this install runs. */
async function fromRepository(id, dir, todo) {
  const base = `${rawBase()}/presets/${encodeURIComponent(id)}`;
  // A few at a time: a preset is dozens of small files.
  const queue = [...todo];
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const url = `${base}/${f.path.split('/').map(encodeURIComponent).join('/')}`;
      const body = await fetchBody(url);
      if (!body) throw new PresetDownloadError(`${url} answered HTTP 404.`);
      writeChecked(dir, f, body, url);
    }
  };
  await Promise.all(Array.from({ length: DOWNLOADS_AT_ONCE }, worker));
}

/** Removes from a preset's download what this version does not have. */
function pruneDownload(dir, entry) {
  const keep = new Set(entry.files.map((f) => path.join(dir, ...f.path.split('/'))));
  for (const sub of ['', 'files']) {
    const at = path.join(dir, sub);
    if (!fs.existsSync(at)) continue;
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      const file = path.join(at, e.name);
      if (e.isFile() && !keep.has(file)) fs.rmSync(file, { force: true });
    }
  }
}

const pending = new Map();
/** Runs `fn` after whatever else is running for this preset, so a file is never written twice at once. */
function serialized(id, fn) {
  const run = (pending.get(id) ?? Promise.resolve()).catch(() => {}).then(fn);
  pending.set(id, run);
  return run.finally(() => { if (pending.get(id) === run) pending.delete(id); });
}

/**
 * The folder with a preset's files, after downloading the ones `wanted` picks that are missing or
 * not this version's: 'load' (manifest and files), a doc locale, or 'all'.
 *
 * From the release first — one zip for the data, one file per PDF — and, for what it lacks (a
 * checkout between releases, a release published without them), file by file from the repository.
 * Either way each file is checked against the catalog.
 */
async function ensurePreset(id, wanted = 'load') {
  if (isLocal(id)) return repoDir(id);
  const entry = catalogEntryOf(id);
  if (!entry) return null;
  return serialized(id, async () => {
    const dir = cacheDir(id);
    const missing = (pick) => entry.files.filter(pick).filter((f) => !sameFile(path.join(dir, ...f.path.split('/')), f));
    // A PDF alone needs nothing else: the list already knows the preset from the catalog.
    const withData = wanted === 'load' || wanted === 'all';
    const data = withData ? await fromRelease(dir, assetName.data(id), missing((f) => !f.path.startsWith('doc.'))) : [];
    const docs = [];
    for (const locale of wanted === 'all' ? PRESET_LOCALES : withData ? [] : [wanted]) {
      docs.push(...await fromRelease(dir, assetName.doc(id, locale), missing((f) => f.path === `doc.${locale}.pdf`)));
    }
    await fromRepository(id, dir, [...data, ...docs]);
    pruneDownload(dir, entry);
    return dir;
  });
}

/**
 * Takes a preset's files from a zip someone copied here — for a machine that cannot reach GitHub.
 * Either zip a release has: the preset's data (preset-<id>.zip) or its package (<id>-v<N>.zip, the
 * Download package button). Which preset it is comes from the manifest inside, matched against the
 * catalog, and every file is checked like a download: a package of another version is refused.
 */
async function importPackage(buf) {
  let entries;
  try { entries = unzip(buf); } catch (err) { throw new PresetDownloadError(err.message); }
  // A zip made of a folder — the package, or a package unzipped and zipped again — has the files
  // under one folder: read them from inside it.
  const tops = new Set(entries.map((e) => e.path.split('/')[0]));
  const strip = tops.size === 1 && entries.every((e) => e.path.includes('/')) ? `${[...tops][0]}/` : '';
  const byPath = new Map(entries.map((e) => [e.path.slice(strip.length), e.data]));
  const prefix = byPath.has('preset.json') ? '' : byPath.has('data/preset.json') ? 'data/' : null;
  if (prefix === null) throw new PresetDownloadError('The zip has no preset.json: it is not the package of a discovery policy.');
  const manifest = byPath.get(`${prefix}preset.json`);
  const hash = crypto.createHash('sha256').update(manifest).digest('hex');
  const entry = readCatalog().presets.find((e) => e.files.some((f) => f.path === 'preset.json' && f.sha256 === hash));
  if (!entry) {
    let about = '';
    try { const m = JSON.parse(manifest.toString('utf8')); about = ` (${m.profileSet?.name ?? m.name?.en ?? 'unknown'})`; } catch { /* not JSON */ }
    throw new PresetDownloadError(`This package${about} is not one this version of the Helper ships: download the one of the release you installed.`);
  }
  if (isLocal(entry.id)) return { id: entry.id, files: 0 };
  return serialized(entry.id, async () => {
    const dir = cacheDir(entry.id);
    // A package lays the files out its own way: data/files/ and docs/ in the one for Delphix.
    const inZip = (f) => byPath.get(f.path.startsWith('doc.') ? (prefix ? `docs/${f.path}` : f.path) : `${prefix}${f.path}`);
    const missing = entry.files.filter((f) => !f.path.startsWith('doc.') && !inZip(f));
    if (missing.length) throw new PresetDownloadError(`The package lacks ${missing.map((f) => f.path).join(', ')}.`);
    let files = 0;
    for (const f of entry.files) {
      const data = inZip(f);
      if (!data) continue;
      writeChecked(dir, f, data, 'the package');
      files++;
    }
    pruneDownload(dir, entry);
    return { id: entry.id, files };
  });
}

/** Forgets the downloaded copy of a preset; it comes down again the next time it is used. */
function dropDownload(id) {
  if (isLocal(id)) return false;
  const dir = cacheDir(id);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/** The folder a preset's files are read from now, if any is here. */
function presetDir(id) {
  if (isLocal(id)) return repoDir(id);
  return isPresetDir(cacheDir(id)) ? cacheDir(id) : null;
}

module.exports = {
  PRESETS_DIR, CATALOG_FILE, CACHE_DIR, PRESET_LOCALES, PRESET_PACKS, PRESET_FILE_SCHEME,
  listOf, mapStrings, presetFileName, presetFileRefs, presetPackIds, presetPack, presetCounts,
  buildCatalog, readCatalog, catalogEntryOf, presetIds, presetDir, isLocal, downloadState,
  ensurePreset, importPackage, dropDownload, PresetDownloadError, sourceRef, releaseTag, rawBase, releaseBase,
  installedRelease, assetName, manifestShape,
};

// ── Command line ──────────────────────────────────────────────────────────────

if (require.main === module) {
  const mode = process.argv[2];
  const text = `${JSON.stringify(buildCatalog(), null, 2)}\n`;
  if (mode === '--write') {
    fs.writeFileSync(CATALOG_FILE, text);
    console.log(`presets/index.json: ${JSON.parse(text).presets.length} presets`);
  } else if (mode === '--check') {
    // An install has no preset folders to compare with: the catalog it has is the one it shipped.
    if (!presetFolders().length) { console.log('No preset folders here; nothing to check.'); process.exit(0); }
    const now = fs.existsSync(CATALOG_FILE) ? fs.readFileSync(CATALOG_FILE, 'utf8') : '';
    if (now !== text) {
      console.error('presets/index.json is out of date: run `npm run presets:catalog` and commit it.');
      process.exit(1);
    }
    console.log('presets/index.json is up to date.');
  } else {
    console.error('usage: node preset-catalog.js --write | --check');
    process.exit(2);
  }
}
