// The download of a pre-configured discovery policy: a zip that loads it into Delphix without this
// tool — Data Control Tower or a Continuous Compliance Engine, whichever the person running it picks.
//
//   <id>-v<version>/
//     README.txt               how to run it, in three languages
//     import.sh                for Linux and macOS (bash, curl, jq)
//     import.ps1               for Windows (Windows PowerShell 5.1 or PowerShell 7)
//     docs/doc.<locale>.pdf    the documentation
//     data/index.json          what there is, in dependency order, and what each pack holds
//     data/engine/…            each object as an engine's Masking API takes it
//     data/dct/…               each object as Data Control Tower's API takes it
//     data/files/…             the lookup and list files
//
// The two scripts carry no knowledge of the preset. Every object is written here already shaped for
// each API, with tokens where only the target knows the value:
//
//   {{FW:<framework name>}}   an algorithm framework's id there
//   {{CFW:<PATH|TYPE|…>}}     a classifier framework's id (engine) — in DCT the name is the id
//   {{ALG:<algorithm>}}       the algorithm as the target names it: its name on an engine, its id in DCT
//   {{FILE:<file>}}           the address the file got when it was uploaded
//   {{DC:<data class>}}       a data class's id (DCT)
//   {{CLS:<classifier>}}      a classifier's id, inside quotes for DCT and bare for an engine
//
// so a script reads a template, swaps its tokens and sends it — no walking a configuration tree,
// which keeps both scripts small and the PowerShell one within what Windows PowerShell 5.1 parses.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const delphix = require('./delphix');

const SCRIPTS_DIR = path.join(__dirname, 'presets', '_bundle');
const CORE_PREFIX = 'dlpx-core:';

// A plugin built-in, as Data Control Tower names it: no prefix, and a few renamed outright.
const DCT_BUILTIN = {
  'credit card': 'CreditCard',
  'date shift fixed': 'DateShiftFixed',
  'null secure lookup': 'NullValueLookup',
  'shuffle': 'SecureShuffle',
  'repeat first digit': 'RepeatFirstDigit',
};
function dctBuiltinName(name) {
  const bare = name.slice(CORE_PREFIX.length).replace(/^Legacy\s+/i, '');
  return DCT_BUILTIN[bare.toLowerCase()] ?? bare;
}

const PRESET_FILE = /^preset-file:\/\/(.+)$/;

/** A configuration with its file addresses and algorithm references turned into tokens. */
function tokenize(config) {
  const names = delphix.algorithmReferenceNames(config);
  const algorithms = Object.fromEntries(names.map((n) => [n, `{{ALG:${n}}}`]));
  const files = {};
  for (const value of delphix.configStrings(config)) {
    const m = PRESET_FILE.exec(value.trim());
    if (m) files[value] = `{{FILE:${m[1]}}}`;
  }
  return delphix.rewriteConfig(config, { algorithms, files });
}

/** The algorithms in an order where each comes after everything it references. */
function dependencyOrder(algorithms) {
  const byName = new Map(algorithms.map((a) => [a.name.trim(), a]));
  const out = [];
  const state = new Map();
  const visit = (name) => {
    if (state.get(name) === 'done' || !byName.has(name)) return;
    if (state.get(name) === 'visiting') throw new Error(`"${name}" ends up referencing itself.`);
    state.set(name, 'visiting');
    for (const ref of delphix.algorithmReferenceNames(byName.get(name).config)) visit(ref);
    state.set(name, 'done');
    out.push(byName.get(name));
  };
  for (const a of algorithms) visit(a.name.trim());
  return out;
}

const fileNameFor = (i, name) => `${String(i + 1).padStart(3, '0')}-${name.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`;

/**
 * Everything the zip holds, as `{ path, content, mode? }`.
 *
 * `presetPack(p, pack)` is the server's own cut of a pack, so the pack a script loads is exactly the
 * one the tool would load.
 */
function bundleEntries(p, presetPack) {
  const root = `${p.id}-v${p.version}`;
  const entries = [];
  const add = (rel, content, mode) => entries.push({ path: `${root}/${rel}`, content, mode });
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

  const algorithms = dependencyOrder(p.algorithms);
  const builtins = {};
  const index = {
    format: 1,
    id: p.id,
    version: p.version,
    versionDate: p.versionDate,
    name: p.name,
    policy: null,
    algorithms: [],
    dataClasses: [],
    classifiers: [],
    files: p.files,
    builtins,
    packs: {},
  };

  algorithms.forEach((a, i) => {
    const framework = delphix.frameworkNameFor(a.framework);
    if (!framework) throw new Error(`No Delphix framework matches ${a.framework} (${a.name}).`);
    const config = tokenize(a.config ?? {});
    for (const ref of delphix.algorithmReferenceNames(a.config ?? {})) {
      if (ref.startsWith(CORE_PREFIX)) builtins[ref] = dctBuiltinName(ref);
    }
    const file = `algorithms/${fileNameFor(i, a.name)}`;
    const description = a.description || a.displayName || '';
    add(`data/engine/${file}`, json({
      algorithmName: a.name, algorithmType: 'COMPONENT', frameworkId: `{{FW:${framework}}}`,
      algorithmExtension: config, ...(description ? { description } : {}),
    }));
    add(`data/dct/${file}`, json({
      name: a.name, framework_id: `{{FW:${framework}}}`, config, ...(description ? { description } : {}),
    }));
    index.algorithms.push({ name: a.name, framework, file });
  });

  p.domains.forEach((d, i) => {
    for (const ref of [d.algorithm, d.tokenization]) {
      if (ref && ref.startsWith(CORE_PREFIX)) builtins[ref] = dctBuiltinName(ref);
    }
    const file = `data-classes/${fileNameFor(i, d.name)}`;
    add(`data/engine/${file}`, json({
      domainName: d.name,
      ...(d.algorithm ? { defaultAlgorithmCode: `{{ALG:${d.algorithm}}}` } : {}),
      ...(d.tokenization ? { defaultTokenizationCode: `{{ALG:${d.tokenization}}}` } : {}),
    }));
    add(`data/dct/${file}`, json({
      name: d.name,
      default_algorithm_id: `{{ALG:${d.algorithm}}}`,
      ...(d.tokenization ? { default_token_algorithm_id: `{{ALG:${d.tokenization}}}` } : {}),
      algorithm_ids: [...new Set([d.algorithm, d.tokenization].filter(Boolean))].map((n) => `{{ALG:${n}}}`),
    }));
    index.dataClasses.push({ name: d.name, file });
  });

  p.classifiers.forEach((c, i) => {
    const config = tokenize(c.config ?? {});
    const file = `classifiers/${fileNameFor(i, c.name)}`;
    add(`data/engine/${file}`, json({
      classifierName: c.name, domainName: c.domain, frameworkId: `{{CFW:${c.framework}}}`,
      classifierConfiguration: config,
      ...(c.description ? { description: delphix.toEngineText(c.description) } : {}),
    }));
    add(`data/dct/${file}`, json({
      name: c.name, framework: c.framework === 'TYPE' ? 'DATA_TYPE' : c.framework,
      data_class_id: `{{DC:${c.domain}}}`, config, ...(c.description ? { description: c.description } : {}),
    }));
    index.classifiers.push({ name: c.name, dataClass: c.domain, file });
  });

  // The policy is written once per pack: its members and, for the essential pack, its description
  // are the pack's own.
  const set = p.profileSet;
  index.policy = { name: set.name, threshold: set.threshold ?? null, files: {} };
  for (const pack of Object.keys(p.packs?.essential ? { essential: 1, extended: 1 } : { extended: 1 })) {
    const view = presetPack(p, pack);
    const members = (view.profileSet.classifiers ?? []).map((n) => n.trim());
    const description = view.profileSet.description ?? '';
    const file = `policy/${pack}.json`;
    add(`data/engine/${file}`, json({
      profileSetName: set.name,
      classifierIds: members.map((n) => `{{CLS:${n}}}`),
      ...(set.threshold ? { assignmentThreshold: set.threshold } : {}),
      ...(description ? { description: delphix.engineSetDescription(description) } : {}),
    }).replace(/"(\{\{CLS:[^}]+\}\})"/g, '$1'));   // an engine's classifier ids are numbers
    add(`data/dct/${file}`, json({
      name: set.name,
      classifier_ids: members.map((n) => `{{CLS:${n}}}`),
      ...(set.threshold ? { assignment_threshold: set.threshold } : {}),
      ...(description ? { description } : {}),
    }));
    index.policy.files[pack] = file;
    index.packs[pack] = {
      algorithms: view.algorithms.map((a) => a.name.trim()),
      dataClasses: view.domains.map((d) => d.name.trim()),
      classifiers: view.classifiers.map((c) => c.name.trim()),
      files: view.files,
    };
  }

  add('data/index.json', json(index));
  for (const name of p.files) add(`data/files/${name}`, fs.readFileSync(path.join(p.dir, 'files', name)));
  for (const locale of p.docs) add(`docs/doc.${locale}.pdf`, fs.readFileSync(path.join(p.dir, `doc.${locale}.pdf`)));

  const readme = fs.readFileSync(path.join(SCRIPTS_DIR, 'README.txt'), 'utf8')
    .replaceAll('{{NAME}}', p.name.en ?? p.id).replaceAll('{{VERSION}}', String(p.version));
  add('README.txt', readme.replace(/\r?\n/g, '\r\n'));
  add('import.sh', fs.readFileSync(path.join(SCRIPTS_DIR, 'import.sh')), 0o755);
  // Windows PowerShell 5.1 reads a script without a byte order mark as the machine's ANSI code page,
  // which garbles every accented message: the file goes with a UTF-8 BOM and CRLF line ends.
  const ps1 = fs.readFileSync(path.join(SCRIPTS_DIR, 'import.ps1'), 'utf8').replace(/^\uFEFF/, '').replace(/\r?\n/g, '\r\n');
  add('import.ps1', Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(ps1, 'utf8')]));
  return entries;
}

// ── Zip ───────────────────────────────────────────────────────────────────────
//
// Small enough to write by hand: deflated entries, UTF-8 names, and the Unix mode in the external
// attributes so import.sh unpacks executable.

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function zip(entries, when = new Date()) {
  const { time, day } = dosTime(when);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content, 'utf8');
    const name = Buffer.from(e.path, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);            // names are UTF-8
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);   // made by Unix, so the mode below is read
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((0o100000 | (e.mode ?? 0o644)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** The zip of a preset, ready to send. */
function presetBundle(p, presetPack) {
  return zip(bundleEntries(p, presetPack));
}

module.exports = { presetBundle, bundleEntries, dctBuiltinName };
