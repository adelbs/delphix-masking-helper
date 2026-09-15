#!/usr/bin/env node
/**
 * Builds the Panama (Ley 81 de 2019) pre-configured profile set: preset.json and files/.
 *
 *   node presets/panama-ley-81/build.mjs
 *
 * source/ holds the hand-kept lists (given names, surnames, streets, barriadas) and the 699
 * corregimientos of the 2023 census with their district, province, centroid and population.
 * Everything in files/ and preset.json is generated from them and from the definitions below —
 * edit here, then build, then run verify.mjs.
 *
 * Structure of the set
 *   L1     direct identifiers      cédula, RUC with its check digit, names, contact, documents…
 *   L2     quasi-identifiers       birth date, age, sex, district, corregimiento, barriada…
 *   L3     sensitive data (art. 4) ethnic origin, health, biometrics, genetics, beliefs,
 *                                  political opinions, union membership, sexual orientation
 *   FIN    economic, financial and credit data (art. 8.3, Ley 24 de 2002)
 *   PENAL  criminal records (art. 30)
 */
import fs from 'node:fs'
import nodePath from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = nodePath.dirname(fileURLToPath(import.meta.url))
const SOURCE = nodePath.join(HERE, 'source')
const FILES = nodePath.join(HERE, 'files')

// ── Helpers ─────────────────────────────────────────────────────────────────

const readLines = (name) => fs.readFileSync(nodePath.join(SOURCE, name), 'utf8')
  .split('\n').map((s) => s.trim()).filter(Boolean)
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC')
const unique = (values) => [...new Set(values)]
/** A detection list also finds values written without accents. */
const withFolded = (values) => unique(values.flatMap((v) => [v, fold(v)]))

const files = new Map()
function file(name, values) {
  const lines = unique(values)
  if (files.has(name) && files.get(name).join('\n') !== lines.join('\n')) throw new Error(`${name} defined twice`)
  files.set(name, lines)
  return `preset-file://${name}`
}

const algorithms = []
function algorithm(name, framework, config, input) {
  if (algorithms.some((a) => a.name === name)) throw new Error(`algorithm ${name} defined twice`)
  algorithms.push({ name, framework: `algorithm.plugin.${framework}`, config, ...(input === undefined ? {} : { input }) })
  return name
}
const use = (name) => ({ name })
const keep = { type: 'PRESERVE' }
const drop = { type: 'TRUNCATE' }
const apply = (name) => ({ type: 'APPLY_ALGORITHM', algorithm: use(name) })
const redactAs = (text) => ({ type: 'REDACT', redactString: text })

/** Regex Decompose: each pattern is [regex, ...one action per capture group]. */
function decompose(name, patterns, fallback, input) {
  for (const [regex, ...actions] of patterns) {
    const groups = new RegExp(`${regex.replace(/^\(\?i\)/, '')}|`).exec('').length - 1
    if (groups !== actions.length) throw new Error(`${name}: ${regex} has ${groups} groups and ${actions.length} actions`)
  }
  return algorithm(name, 'decompose.RegexDecompose', {
    maskPatterns: patterns.map(([regex, ...actions]) => ({ regex, actions })),
    fallbackAction: fallback,
    trimInput: true,
    requireMask: false,
  }, input)
}

function lookup(name, fileName, values, input, caseMode = 'PRESERVE_INPUT') {
  return algorithm(name, 'secureLookup.SecureLookup', {
    lookupFile: { uri: file(fileName, values) },
    hashMethod: 'SHA256',
    maskedValueCase: caseMode,
    inputCaseSensitive: false,
    trimWhitespaceFromInput: true,
    trimWhitespaceInLookupFile: true,
  }, input)
}

/** Data Cleansing: exact replacement of whole values, from [from, to] pairs. */
function cleansing(name, fileName, pairs, input, delimiter = ',') {
  for (const [from, to] of pairs) if (from.includes(delimiter) || to.includes(delimiter)) throw new Error(`${fileName}: "${from}" holds the delimiter`)
  return algorithm(name, 'dataCleansing.DataCleansing', {
    lookupFile: { uri: file(fileName, pairs.map(([from, to]) => `${from}${delimiter}${to}`)) },
    delimiter, caseSensitive: true, trimWhitespace: true,
  }, input)
}

/** String Algorithm Chain. Delphix allows eight algorithms per chain, so longer ones are nested. */
function chain(name, steps, input) {
  if (steps.length <= 8) return algorithm(name, 'stringAlgorithmChain.StringAlgorithmChain', { algorithmReferences: steps.map(use) }, input)
  const parts = []
  for (let i = 0; i < steps.length; i += 8) parts.push(chain(`${name}_${parts.length + 1}`, steps.slice(i, i + 8)))
  return chain(name, parts, input)
}

const domains = []
const classifiers = []
function domain(name, algorithmName, ...detect) {
  if (!algorithms.some((a) => a.name === algorithmName)) throw new Error(`${name}: no algorithm ${algorithmName}`)
  domains.push({ name, algorithm: algorithmName })
  for (const make of detect) classifiers.push(make(name))
}

/** Column names: alternatives that must not be glued to other letters (digits and _ are fine). */
const words = (alternatives) => String.raw`(?i)(?<![a-z])(?:${alternatives})(?![a-z])`

const byName = (...rules) => (d) => ({
  name: `${d} - Path`, framework: 'PATH', domain: d,
  description: 'Nombre de la columna (y variantes usadas en sistemas panameños).',
  config: {
    paths: rules.map(([alternatives, strength]) => ({
      matchType: 'REGEX', fieldValue: words(alternatives), parentValue: '',
      matchStrength: strength, caseSensitive: false, allowPartialMatch: true,
    })),
    rejectStrength: 0,
  },
})

const byType = (...allowed) => (d) => ({
  name: `${d} - Type`, framework: 'TYPE', domain: d,
  description: 'Descarta columnas cuyo tipo no puede contener este dato.',
  config: { allowedTypes: allowed, matchAutoIncrementingColumn: false, matchStrength: 0, rejectStrength: 1 },
})

/** Values: [regex, strength, { checksum, clean, note }]. Whole value unless `partial`. */
const byPattern = (rules, { reject = 0.3, partial = false } = {}) => (d) => ({
  name: `${d} - Regex`, framework: 'REGEX', domain: d,
  description: 'Formato de los valores.',
  config: {
    dataPatterns: rules.map(([regex, strength, extra = {}]) => ({
      ...(extra.note ? { note: extra.note } : {}),
      regex, matchStrength: strength,
      checksumType: extra.checksum ?? 'NONE',
      caseSensitive: false, allowPartialMatch: partial,
      dataCleanRegex: extra.clean ?? '',
    })),
    rejectStrength: reject,
  },
})

/** Values found in lists: [fileName, values, strength]. */
const byList = (lists, { reject = 0.3, tokenize = false } = {}) => (d) => ({
  name: `${d} - List`, framework: 'LIST', domain: d,
  description: 'Valores conocidos.',
  config: {
    valueLists: lists.map(([fileName, values, strength]) => ({ file: file(fileName, withFolded(values)), matchStrength: strength })),
    tokenizeInput: tokenize,
    rejectStrength: reject,
    tokenizationDelimiter: ' ',
  },
})

const STRING = (min = 0, max = 0) => ({ typeName: 'String', ...(min ? { minimumLength: min } : {}), ...(max ? { maximumLength: max } : {}) })
const NUMBER = (min = 0, max = 0) => ({ typeName: 'Number', ...(min ? { minimumLength: min } : {}), ...(max ? { maximumLength: max } : {}) })
// A TIMESTAMP is not a Date to the profiler: only its SQL code lets a TYPE classifier accept it.
const DATES = [{ typeName: 'Date' }, { typeName: 'JavaSqlType', sqlType: 93 }]

// Deterministic pseudo-random numbers, so a rebuild writes the same files.
function seeded(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── Source lists ────────────────────────────────────────────────────────────

const NOMBRES = unique(readLines('nombres.txt'))
const APELLIDOS = unique(readLines('apellidos.txt'))

const CORREGIMIENTOS = readLines('corregimientos.tsv').map((line) => {
  const [code, name, districtCode, district, provinceCode, province, kind, lat, lon, population] = line.split('\t')
  return { code, name, districtCode, district, provinceCode, province, kind, lat: Number(lat), lon: Number(lon), population: Number(population) || 0 }
})
if (CORREGIMIENTOS.length !== 699) throw new Error(`expected the 699 corregimientos of the 2023 census, found ${CORREGIMIENTOS.length}`)

// ── Shared algorithms ───────────────────────────────────────────────────────

// Vowels map to vowels and consonants to consonants, so a masked document number keeps its
// structure. Digits map exactly as a digits-only mapping would, which is what keeps a cédula and
// the RUC built on it equal after masking. Ñ is in no group: a group needs at least three
// characters, and mixing it with the consonants would put Ñ into ASCII-only columns.
// minMaskedPositions 0 lets a placeholder such as "N/D" through instead of failing the row.
algorithm('PA_CM_ALFANUM', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'AEIOU', 'BCDFGHJKLMNPQRSTVWXYZ', 'aeiou', 'bcdfghjklmnpqrstvwxyz', 'ÁÉÍÓÚÜ', 'áéíóúü'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '8-442-445')
// Hex letters form their own group, so a MAC, UUID or IPv6 stays valid hex.
algorithm('PA_CM_HEX', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'abcdef', 'ABCDEF', 'ghijklmnopqrstuvwxyz', 'GHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '3c:22:fb:9a:10:e4')
decompose('PA_REDACTAR', [['(.+)', { type: 'REDACT', redactCharacter: 'X' }]], keep, 'secreto123')
lookup('PA_SUPRIMIR', 'pa-sin-informacion.txt', ['Sin información'], 'Trastorno depresivo', 'PRESERVE_LOOKUP_FILE')

// Yes/no columns keep their vocabulary: a CHAR(1) S/N stays S/N.
decompose('PA_BANDERA', [
  [String.raw`(?i)(s[ií]|no)`, apply(lookup('PA_BANDERA_SI_NO', 'pa-bandera-si-no.txt', ['Sí', 'No']))],
  ['(?i)(true|false)', apply(lookup('PA_BANDERA_TRUE_FALSE', 'pa-bandera-true-false.txt', ['true', 'false']))],
  ['(?i)([sn])', apply(lookup('PA_BANDERA_S_N', 'pa-bandera-s-n.txt', ['S', 'N']))],
  ['(?i)(y)', apply(lookup('PA_BANDERA_Y_N', 'pa-bandera-y-n.txt', ['Y', 'N']))],
  ['([01])', apply(lookup('PA_BANDERA_0_1', 'pa-bandera-0-1.txt', ['0', '1']))],
], keep, 'S')

const FLAG = String.raw`(?i)(s[ií]|no|true|false|[sny01])`
/**
 * A categorical attribute: flags stay flags, numeric codes get other digits, and any other value
 * is replaced by one from `values` — or suppressed, when no list is given.
 */
function categorical(name, fileName, values, input) {
  const replacement = values ? lookup(`${name}_LISTA`, fileName, values) : 'PA_SUPRIMIR'
  return decompose(name, [[FLAG, apply('PA_BANDERA')], [String.raw`(\d{1,6})`, apply('PA_CM_ALFANUM')]], apply(replacement), input)
}
categorical('PA_CATEGORIA_SUPRIMIDA', null, null, 'Trastorno depresivo')
const CM = apply('PA_CM_ALFANUM')

// ── L1 · Cédula ─────────────────────────────────────────────────────────────
//
// Cédula de identidad personal (Tribunal Electoral): province of birth (1–13, where 10, 11 and 12
// are the Guna Yala, Emberá-Wounaan and Ngäbe-Buglé comarcas), tomo and asiento of the civil
// registry entry: 8-442-445. Letters replace or follow the province: E (resident foreigner, then
// province and number), N (naturalized), PE (born abroad), AV (registered before the civil registry
// law) and PI (indigenous). A foreigner without cédula files taxes as 8-NT-tomo-asiento.
// Masked: the province by Numeric Mapping within 1–13, tomo and asiento digit by digit. The letters
// stay, so the document type does too.

const PROVINCIA = String.raw`([1-9]|1[0-3])`
algorithm('PA_PROVINCIA_CEDULA', 'characterMapping.NumericMapping', { minValue: 1, maxValue: 13 }, '8')
const PROV = apply('PA_PROVINCIA_CEDULA')
decompose('PA_CEDULA', [
  [`${PROVINCIA}([\\s\\-])(\\d{1,4})([\\s\\-])(\\d{1,6})`, PROV, keep, CM, keep, CM],
  [`${PROVINCIA}(AV|PI)([\\s\\-])(\\d{1,4})([\\s\\-])(\\d{1,6})`, PROV, keep, keep, CM, keep, CM],
  [`(E)([\\s\\-])${PROVINCIA}([\\s\\-])(\\d{1,6})`, keep, keep, PROV, keep, CM],
  [String.raw`(N|PE)([\s\-])(\d{1,4})([\s\-])(\d{1,6})`, keep, keep, CM, keep, CM],
  [`${PROVINCIA}([\\s\\-]NT[\\s\\-])(\\d{1,4})([\\s\\-])(\\d{1,6})`, PROV, keep, CM, keep, CM],
], CM, '8-442-445')

// Any cédula in text: province with optional AV/PI, or E/N/PE, then tomo and asiento. A date
// written 12-05-1985 has the same shape and is excluded.
const NOT_A_DATE = String.raw`(?!\d{1,2}-\d{1,2}-(19|20)\d{2}$)`
const CEDULA_REGEX = String.raw`${NOT_A_DATE}(([1-9]|1[0-3])(AV|PI)?|E|N|PE)-\d{1,4}-\d{1,6}`

// The driver's license number in Panama is the cédula number, so license columns belong here too:
// the same algorithm keeps them equal to the cédula.
domain('PA_L1_CEDULA', 'PA_CEDULA',
  byName(
    ['cedula[a-z0-9_]*|c[eé]dula|ced|cip|n(o|um|ro|umero)_?(de_?)?cedula|cedula_?(identidad|personal|cliente|empleado|paciente|asegurado|beneficiario|titular|conyuge|acudiente)|(cliente|empleado|paciente|asegurado|beneficiario|titular)_?cedula|documento_?(de_?)?identidad|doc_?identidad|id_?personal|identificacion_?personal|n(o|um|ro)_?identificacion|numero_?documento|num_?doc|nro_?doc|national_?id|dni', 0.9],
    ['licencia_?(de_?)?(conducir|manejo|chofer|conductor)|n(o|um|ro)_?licencia(_?conducir)?|licencia|driver_?license|drivers_?license', 0.8],
  ),
  byType(STRING(5)),
  byPattern([
    [CEDULA_REGEX, 1],
    [String.raw`([1-9]|1[0-3])-NT-\d{1,4}-\d{1,6}`, 0.9],
  ], { reject: 0.2 }))

// ── L1 · RUC and its check digit ────────────────────────────────────────────
//
// Registro Único de Contribuyentes (DGI). A natural person's RUC is the cédula, so it is masked with
// the same algorithm and a person's RUC and cédula still agree. A legal entity's RUC (the Public
// Registry number: 155596713-2-2015) is not personal data under article 4 and stays as it is.
//
// The RUC carries a two-digit check digit, DV, written next to it (8-442-445 DV 08) or kept in a
// column of its own. The DGI computes it over a 21-position table: the cédula fields right-aligned
// in fixed widths — asiento 5, tomo 3, a two-digit code for the letters (AV 15, PI 79, E 50, N 40,
// PE 75), province 2 — and a constant 5. Weights grow from 2 at the right, modulo 11, 0 or 1 give
// 0; the second digit repeats the computation with the first one appended. A field longer than its
// width pushes the fields to its left, and a one-digit province with AV or PI is padded with two
// zeros instead of one.
//
// No framework computes that, so the set does, with lookup tables. After the cédula is masked, a
// three-character state — weighted sum, digit sum and position — starts at the right end and
// travels left one character at a time; each step is a Data Cleansing that turns "character +
// state" into "new state + character". At the left end a table turns the state into the DV, and a
// second traveller carries the two digits back to where the old DV was. Separators and letters are
// swapped for one-character markers while this happens, and restored at the end.

// The state is three characters: weighted sum and digit sum modulo 11, and a mode. The mode is the
// field being read (asiento, tomo, province) with where it starts and how many digits it has had,
// or END after E, N or PE, which have no province digits.
const B11 = '0123456789A'
const MODE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const MODES = []
for (let c = 0; c <= 6; c++) MODES.push({ phase: 'A', s: 2, c })
for (const s of [7, 8]) for (let c = 0; c <= 4; c++) MODES.push({ phase: 'T', s, c })
for (let p0 = 12; p0 <= 14; p0++) for (let c = 0; c <= 2; c++) for (const f of [false, true]) MODES.push({ phase: 'P', p0, c, f })
for (let p0 = 12; p0 <= 14; p0++) MODES.push({ phase: 'END', p0 })
if (MODES.length > MODE_CHARS.length) throw new Error('too many DV modes')
const modeKey = (m) => ({ A: `A${m.s}.${m.c}`, T: `T${m.s}.${m.c}`, P: `P${m.p0}.${m.c}.${m.f}`, END: `END${m.p0}` })[m.phase]
const MODE_INDEX = new Map(MODES.map((m, i) => [modeKey(m), i]))
const stateOf = (st) => `${B11[st.S]}${B11[st.D]}${MODE_CHARS[MODE_INDEX.get(modeKey(st.m))]}`
// Letter markers and the code each one stands for: [tens, units, pads a one-digit province twice].
const DV_CODES = { v: ['AV', 1, 5, true], i: ['PI', 7, 9, true], e: ['E', 5, 0, false], n: ['N', 4, 0, false], q: ['PE', 7, 5, false] }
const DV_ALPHABET = [...'0123456789', '_', '-', ...Object.keys(DV_CODES)]

function dvStep({ S, D, m }, c) {
  if (/\d/.test(c)) {
    if (m.phase === 'END' || m.c >= { A: 6, T: 4, P: 2 }[m.phase]) return null
    const d = Number(c)
    const weight = (m.phase === 'P' ? m.p0 : m.s) + m.c
    return { S: (S + weight * d) % 11, D: (D + d) % 11, m: { ...m, c: m.c + 1 } }
  }
  if (c in DV_CODES) {
    if (m.phase !== 'P' || m.c !== 0 || m.f) return null
    const [, tens, units, twice] = DV_CODES[c]
    const next = { S: (S + units * (m.p0 - 2) + tens * (m.p0 - 1)) % 11, D: (D + tens + units) % 11 }
    // E, N and PE have no province digits: nothing may follow them.
    return { ...next, m: twice ? { ...m, f: true } : { phase: 'END', p0: m.p0 } }
  }
  if (c === '_' && m.phase === 'A' && m.c > 0) return { S, D, m: { phase: 'T', s: 2 + Math.max(5, m.c), c: 0 } }
  if (c === '-' && m.phase === 'T' && m.c > 0) return { S, D, m: { phase: 'P', p0: m.s + Math.max(3, m.c) + 2, c: 0, f: false } }
  return null
}
function dvOf({ S, D, m }) {
  if (m.phase !== 'P' && m.phase !== 'END') return null
  if (m.phase === 'P' && m.c === 0) return null
  const five = m.phase === 'END' ? m.p0 + 2 : m.p0 + 2 + (m.f && m.c === 1 ? 1 : 0)
  const S1 = (S + 5 * five) % 11
  const D1 = (D + 5) % 11
  const digit = (s) => (s > 1 ? 11 - s : 0)
  const d1 = digit(S1)
  return `${d1}${digit((S1 + D1 + 2 * d1) % 11)}`
}

// Separators between the RUC and its DV: [regex, marker, how it is written back].
const DV_SEPARATORS = [[' +DV +', '!', ' DV '], [' +DV', '#', ' DV'], ['-', '$', '-'], [' +', '%', ' ']]
const NATURAL = String.raw`(?:(?:[1-9]|1[0-3])(?:AV|PI)?-\d{1,4}-\d{1,6}|(?:E|N|PE)-\d{1,4}-\d{1,6})`
const SEPARATOR = String.raw`(?: +DV +| +DV|-| +)`

function buildRucDv() {
  // Every state the traveller can reach, each transition out of it, and the DV of each final state.
  const steps = new Map()
  const finals = new Map()
  const seen = new Set()
  const start = { S: 0, D: 0, m: { phase: 'A', s: 2, c: 0 } }
  const queue = [start]
  while (queue.length) {
    const st = queue.pop()
    const key = stateOf(st)
    if (seen.has(key)) continue
    seen.add(key)
    const dv = dvOf(st)
    if (dv) finals.set(key, dv)
    for (const c of DV_ALPHABET) {
      const next = dvStep(st, c)
      if (!next) continue
      steps.set(`${c}${key}`, `${stateOf(next)}${c}`)
      queue.push(next)
    }
  }
  const initial = stateOf(start)

  const code = cleansing('PA_RUC_DV_LETRAS', 'pa-ruc-dv-letras.txt', Object.entries(DV_CODES).map(([marker, [letters]]) => [letters, marker]))
  const codeBack = cleansing('PA_RUC_DV_LETRAS_DE_VUELTA', 'pa-ruc-dv-letras-de-vuelta.txt', Object.entries(DV_CODES).map(([marker, [letters]]) => [marker, letters]))
  const prepare = []
  const restore = []
  for (const [regex, marker, written] of DV_SEPARATORS) {
    const start = redactAs(`${initial}${marker}`)
    const back = redactAs(written)
    prepare.push(
      [`${PROVINCIA}(-)(\\d{1,4})(-)(\\d{1,6})(${regex})(\\d{2})`, PROV, keep, CM, redactAs('_'), CM, start, drop],
      [`${PROVINCIA}(AV|PI)(-)(\\d{1,4})(-)(\\d{1,6})(${regex})(\\d{2})`, PROV, apply(code), keep, CM, redactAs('_'), CM, start, drop],
      [`(E)(-)${PROVINCIA}(-)(\\d{1,6})(${regex})(\\d{2})`, apply(code), keep, PROV, redactAs('_'), CM, start, drop],
      [`(N|PE)(-)(\\d{1,4})(-)(\\d{1,6})(${regex})(\\d{2})`, apply(code), keep, CM, redactAs('_'), CM, start, drop],
    )
    const m = `\\${marker}`
    restore.push(
      [`(\\d{1,2})(-)(\\d{1,4})(_)(\\d{1,6})(${m})(\\d\\d)`, keep, keep, keep, redactAs('-'), keep, back, keep],
      [`(\\d{1,2})([vi])(-)(\\d{1,4})(_)(\\d{1,6})(${m})(\\d\\d)`, keep, apply(codeBack), keep, keep, redactAs('-'), keep, back, keep],
      [`([enq])(-)(\\d{1,4})(_)(\\d{1,6})(${m})(\\d\\d)`, apply(codeBack), keep, keep, redactAs('-'), keep, back, keep],
    )
  }
  const chainSteps = [decompose('PA_RUC_DV_PREPARAR', prepare, keep)]
  const step = cleansing('PA_RUC_DV_PASO', 'pa-ruc-dv-paso.txt', [...steps])
  // The longest prepared cédula, 13PI-1234_123456, has 15 characters for the state to pass.
  const LONGEST = 15
  const pad = (n) => String(n).padStart(2, '0')
  for (let k = 1; k <= LONGEST; k++) chainSteps.push(decompose(`PA_RUC_DV_IDA_${pad(k)}`, [[`(.*)(.{4})(.{${k}})`, keep, apply(step), keep]], keep))
  const final = cleansing('PA_RUC_DV_RESULTADO', 'pa-ruc-dv-resultado.txt', [...finals])
  chainSteps.push(decompose('PA_RUC_DV_CALCULAR', [['(.{3})(.*)', apply(final), keep]], keep))
  // The DV travels right past the cédula and the separator marker, to the end where the old DV was.
  const markers = DV_SEPARATORS.map(([, marker]) => marker)
  const carry = cleansing('PA_RUC_DV_TRASLADO', 'pa-ruc-dv-traslado.txt',
    Array.from({ length: 100 }, (_, n) => String(n).padStart(2, '0')).flatMap((dd) => [...DV_ALPHABET, ...markers].map((c) => [`${dd}${c}`, `${c}${dd}`])))
  for (let k = 0; k <= LONGEST; k++) chainSteps.push(decompose(`PA_RUC_DV_VUELTA_${pad(k + 1)}`, [[`(.{${k}})(.{3})(.*)`, keep, apply(carry), keep]], keep))
  chainSteps.push(decompose('PA_RUC_DV_RESTAURAR', restore, keep))
  return chain('PA_RUC_DV', chainSteps)
}
buildRucDv()

decompose('PA_RUC', [
  // A natural person's RUC with its DV: the cédula masked, the DV recomputed.
  [`(${NATURAL}${SEPARATOR}\\d{2})`, apply('PA_RUC_DV')],
  // Without DV, it is a cédula.
  [`(${NATURAL})`, apply('PA_CEDULA')],
  [`${PROVINCIA}(-NT-)(\\d{1,4})(-)(\\d{1,6})(.*)`, PROV, keep, CM, keep, CM, CM],
  // A legal entity's RUC: not personal data.
  [String.raw`(\d{3,10}-\d{1,4}-\d{1,7}.*)`, keep],
], CM, '8-442-445 DV 08')

domain('PA_L1_RUC', 'PA_RUC',
  byName(['ruc[a-z0-9_]*|d_?ruc|n(o|um|ro|umero)_?(de_?)?ruc|registro_?unico(_?de)?(_?contribuyentes?)?|ruc_?(cliente|proveedor|emisor|receptor|contribuyente|persona|natural|empleado|beneficiario|titular)|(cliente|proveedor|emisor|receptor)_?ruc|tax_?id|id_?fiscal|nit', 0.9]),
  byType(STRING(5)),
  byPattern([
    [`${NATURAL}${SEPARATOR}\\d{2}`, 1],
    [CEDULA_REGEX, 0.6],
    [String.raw`\d{3,10}-\d{1,4}-\d{1,7}(\s*DV\s*\d{2})?`, 0.6],
  ], { reject: 0.2 }))

// The DV in a column of its own cannot be recomputed: an algorithm sees one column. It is masked,
// so it does not help link a row back to the real RUC.
decompose('PA_DV', [[String.raw`(\d{1,2})`, CM]], CM, '08')
domain('PA_L1_RUC_DV', 'PA_DV',
  byName(['dv|d_?dv|digito_?verificador|dig_?verif|dv_?ruc|ruc_?dv|check_?digit', 0.9]),
  byType(STRING(0, 3), NUMBER(0, 2)))

// ── L1 · Other documents ────────────────────────────────────────────────────

domain('PA_L1_PASAPORTE', 'PA_CM_ALFANUM',
  byName(['pasaporte[a-z_]*|passport[a-z_]*|n(o|um|ro|umero)_?pasaporte|pasap', 0.85]),
  byPattern([[String.raw`[A-Z]{1,2}\d{6,8}`, 0.3]], { reject: 0.3 }))

domain('PA_L1_DOCUMENTO_MIGRATORIO', 'PA_CM_ALFANUM',
  byName(['carne_?(migratorio|de_?migracion|residente|de_?residente|residencia|refugiado|trabajo)|carnet_?(migratorio|residente|residencia)|permiso_?(de_?)?(residencia|trabajo|migratorio)|n(o|um|ro)_?carne(t)?|documento_?migratorio|doc_?migratorio|filiacion_?migratoria|visa|n(o|um|ro)_?visa|id_?extranjero|documento_?extranjero|identificacion_?extranjera', 0.8]))

domain('PA_L1_SEGURO_SOCIAL', 'PA_CM_ALFANUM',
  byName(['n(o|um|ro|umero)_?(de_?)?seguro_?social|seguro_?social_?(num|no|nro|numero)|nss|n(o|um|ro)_?css|css_?(num|no|numero|asegurado)|n(o|um|ro)_?asegurado|num_?asegurado|n(o|um|ro)_?(de_?)?afiliado(_?css)?|carne_?(del_?)?seguro(_?social)?|ss_?number|social_?security', 0.85]))

// Idoneidad: the license every regulated profession needs to practice; the registry is public.
domain('PA_L1_IDONEIDAD', 'PA_CM_ALFANUM',
  byName(['idoneidad|n(o|um|ro|umero)_?(de_?)?idoneidad|registro_?(medico|profesional|de_?idoneidad)|licencia_?profesional|codigo_?(medico|profesional)|colegiatura|n(o|um|ro)_?registro_?profesional', 0.85]))

// ── L1 · Names ──────────────────────────────────────────────────────────────

const NOT_A_PERSON = 'producto|prod|articulo|art|item|empresa|emp|compania|razon|comercial|fantasia|archivo|arch|file|calle|via|avenida|barriada|urbanizacion|corregimiento|correg|distrito|dist|provincia|prov|comarca|lugar_?poblado|region|ciudad|pais|banco|sucursal|plaza|plan|campana|proyecto|servicio|equipo|tabla|columna|campo|usuario|user|host|servidor|dominio|marca|modelo|categoria|tipo|colegio|escuela|centro_?educativo|establecimiento|institucion|curso|carrera|materia|documento|doc|centro|unidad|policlinica|clinica|hospital|area|depto|departamento|puesto|sistema|app|aplicacion|grupo|lista|reporte|informe|proceso|evento|tarea|perfil|rol|clase|objeto|cuenta|medicamento|farmaco|diagnostico|estudio|programa|beneficio|partido|sindicato|religion|etnia|pueblo|lengua|lugar|local|tienda|almacen|bodega|proveedor|convenio|contrato|poliza|seguro|aseguradora|org|organizacion|dependencia|entidad|parametro|variable|metodo|funcion|indice|job|script|cola|recurso|red|dispositivo|plantilla|template|imagen|foto|pagina|sitio|modulo|menu|opcion|accion|permiso|concepto|impuesto|moneda|emisor|comprobante|factura|pago|forma|zona|ruta|linea|giro|actividad|rama|sector|finca|edificio|ph|proyecto'
const PERSON_ROLE = 'cliente|cte|cli|paciente|pac|trabajador|trab|empleado|colaborador|funcionario|servidor_?publico|alumno|estudiante|afiliado|asegurado|cotizante|jubilado|pensionado|beneficiario|benef|titular|madre|padre|acudiente|tutor|conyuge|pareja|medico|doctor|profesional|responsable|contacto|emergencia|fiador|codeudor|deudor|remitente|destinatario|receptor|firmante|testigo|representante|apoderado|propietario|arrendatario|inquilino|contratante|victima|denunciante|imputado|socio|donante|heredero|persona|pers|conductor|chofer|vendedor|ejecutivo|agente|solicitante|ciudadano|elector|votante|contribuyente|jefe_?(de_?)?hogar|hijo|hija|familiar|dependiente'

// Each word from the list; three words are the most a name column holds.
decompose('PA_NOMBRES', [
  [String.raw`(\S+)`, apply('PA_NOMBRE_PILA')],
  [String.raw`(\S+)\s+(\S+)`, apply('PA_NOMBRE_PILA'), apply('PA_NOMBRE_PILA')],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, apply('PA_NOMBRE_PILA'), apply('PA_NOMBRE_PILA'), apply('PA_NOMBRE_PILA')],
], CM, 'Luis Carlos')
algorithm('PA_NOMBRE_PILA', 'name.Name', {
  lookupFile: { uri: file('pa-nombres.txt', NOMBRES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Yamileth')
const DE = String.raw`([Dd][Ee]|[Vv][Dd][Aa]\.?\s+[Dd][Ee])`
// Surnames: paternal and maternal, and a married woman's "de" followed by her husband's surname.
decompose('PA_APELLIDOS', [
  [String.raw`(\S+)`, apply('PA_APELLIDO')],
  [String.raw`(\S+)\s+(\S+)`, apply('PA_APELLIDO'), apply('PA_APELLIDO')],
  [String.raw`(\S+)(\s+)${DE}(\s+)(\S+)`, apply('PA_APELLIDO'), keep, keep, keep, apply('PA_APELLIDO')],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, apply('PA_APELLIDO'), apply('PA_APELLIDO'), apply('PA_APELLIDO')],
], CM, 'González de Pérez')
algorithm('PA_APELLIDO', 'name.Name', {
  lookupFile: { uri: file('pa-apellidos.txt', APELLIDOS) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Ábrego')
// Panamanian convention: given name(s), then paternal and maternal surname; a married woman may
// write "de" and her husband's surname after her own.
const N = apply('PA_NOMBRE_PILA')
const A = apply('PA_APELLIDO')
decompose('PA_NOMBRE_COMPLETO', [
  [String.raw`([^,]+),\s*(.+)`, apply('PA_APELLIDOS'), apply('PA_NOMBRES')],
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, A],
  [String.raw`(\S+)(\s+)(\S+)(\s+)${DE}(\s+)(\S+)`, N, keep, A, keep, keep, keep, A],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, A, A],
  [String.raw`(\S+)(\s+)(\S+)(\s+)(\S+)(\s+)${DE}(\s+)(\S+)`, N, keep, N, keep, A, keep, keep, keep, A],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, A, A],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, N, A, A],
], CM, 'María Elena González de Pérez')

domain('PA_L1_NOMBRE', 'PA_NOMBRES',
  byName(
    [`primer_?nombre|segundo_?nombre|nombres?_?(de_?)?pila|nombre_?usual|first_?name|given_?names?|fname|name_?first|middle_?name|nombre[12]|nombres(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completos?|y_?apellidos?|apellidos?))|nom_?(pila|trab|emp)`, 0.85],
    [`nombre(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|compl|full|y_?apellidos?|apellidos?))|nomb?(?!_?(${NOT_A_PERSON}|completo))|name(?!_?(${NOT_A_PERSON}))`, 0.5],
  ),
  byList([['pa-detectar-nombres.txt', NOMBRES, 0.7]], { tokenize: true, reject: 0.3 }))

domain('PA_L1_APELLIDO', 'PA_APELLIDOS',
  byName(['apellidos?|apellido_?(paterno|materno|pat|mat|uno|dos|casada|de_?casada|[12])|ape_?(pat|mat|paterno|materno|casada|[12])|apepat|apemat|ap_?(pat|mat|paterno|materno)|a_?paterno|a_?materno|paterno|materno|primer_?apellido|segundo_?apellido|apellido_?usual|last_?name|surname|lname|family_?name|second_?last_?name|married_?name', 0.85]),
  byList([['pa-detectar-apellidos.txt', APELLIDOS, 0.7]], { tokenize: true, reject: 0.3 }))

domain('PA_L1_NOMBRE_COMPLETO', 'PA_NOMBRE_COMPLETO',
  byName(
    [`nombre_?(completo|compl|full)|nombres?_?y_?apellidos?|nombres?_?apellidos?|nombreapellido|nom_?completo|nomcompleto|nombrecompleto|full_?name|fullname|person_?name|customer_?name|employee_?name|patient_?name|nombre_?(${PERSON_ROLE})`, 0.9],
    ['titular|beneficiario|acudiente|contacto_?emergencia|conyuge|tutor_?legal|representante_?legal|apoderado|paciente|victima|asegurado|contratante|fiador|codeudor|jubilado|pensionado', 0.6],
    // A bare NOMBRE holds a given name or a full name: the values decide between the two domains.
    [`nombre(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|compl|full|y_?apellidos?|apellidos?))|name(?!_?(${NOT_A_PERSON}))`, 0.5],
  ),
  byList([['pa-detectar-nombres.txt', NOMBRES, 0.6], ['pa-detectar-apellidos.txt', APELLIDOS, 0.6]], { tokenize: true, reject: 0.3 }))

// ── L1 · Contact ────────────────────────────────────────────────────────────

decompose('PA_EMAIL', [
  // The top-level domain becomes .test, reserved for tests: a masked address can never deliver.
  [String.raw`([^@\s]+)@([^@\s]+)\.([A-Za-z]{2,24})`, CM, CM, redactAs('test')],
], CM, 'yamileth.gonzalez@gmail.com')
domain('PA_L1_EMAIL', 'PA_EMAIL',
  byName(['e_?mail[a-z0-9_]*|mail[a-z0-9_]*|correo(_?electronico)?[a-z0-9_]*|email_?address|correo_?(personal|laboral|contacto|receptor|cliente)', 0.85]),
  byType(STRING(5)),
  byPattern([[String.raw`[A-Za-z0-9._%+'\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}`, 1]], { reject: 0.2 }))

// Panama has no area codes: mobiles have 8 digits starting with 6, landlines 7. +507 and the first
// digit — mobile, or the region of a landline — stay; the rest is masked.
decompose('PA_TELEFONO', [
  [String.raw`(\+?\(?507\)?[\s\-]?)?(6)(\d{3})([\s\-]?)(\d{4})`, keep, keep, CM, keep, CM],
  [String.raw`(\+?\(?507\)?[\s\-]?)?([2-9])(\d{2})([\s\-]?)(\d{4})`, keep, keep, CM, keep, CM],
], CM, '+507 6123-4567')
domain('PA_L1_TELEFONO', 'PA_TELEFONO',
  byName(['tel|telefono[a-z0-9_]*|tel[eé]fono|tel_?(cel|casa|residencia|oficina|trabajo|movil|contacto|fijo|emergencia)|celular[a-z0-9_]*|cel|movil|m[oó]vil|whatsapp|wa|fax|phone[a-z0-9_]*|mobile|cellphone|n(o|um|ro)_?tel(efono)?|telef|tlf|extension', 0.85]),
  byPattern([
    [String.raw`(\+?\(?507\)?[\s\-]?)?6\d{3}[\s\-]?\d{4}`, 0.9],
    [String.raw`(\+?\(?507\)?[\s\-]?)?[2-9]\d{2}[\s\-]?\d{4}`, 0.7],
    [String.raw`\+?\d[\d\s()\-]{6,15}`, 0.3],
  ], { reject: 0.3 }))

// Panamanian addresses rarely have a street number: they name the street, the building, the floor
// and the apartment, or the barriada and the house.
lookup('PA_DIRECCION', 'pa-direcciones.txt', (() => {
  const random = seeded(2019)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const streets = readLines('calles.txt')
  const barriadas = readLines('barriadas.txt')
  const buildings = ['Plaza', 'Torre del Mar', 'Los Robles', 'Miramar', 'Bay View', 'Sol del Pacífico', 'Las Palmas', 'Continental', 'Balboa Plaza', 'Vista Hermosa', 'El Dorado', 'Mar del Sur', 'Gran Bahía', 'Terrazas', 'Altamira']
  const out = new Set()
  while (out.size < 3000) {
    const r = random()
    const house = 1 + Math.floor(random() * 400)
    if (r < 0.35) out.add(`${pick(streets)}, Edificio ${pick(buildings)}, Piso ${1 + Math.floor(random() * 40)}, Apto. ${1 + Math.floor(random() * 40)}${'ABCDEF'[Math.floor(random() * 6)]}`)
    else if (r < 0.7) out.add(`${pick(barriadas)}, Calle ${1 + Math.floor(random() * 30)}${random() < 0.3 ? ` ${'ABCDEF'[Math.floor(random() * 6)]}` : ''}, Casa ${house}`)
    else if (r < 0.85) out.add(`${pick(barriadas)}, Casa No. ${house}`)
    else out.add(`${pick(streets)}, Local ${1 + Math.floor(random() * 60)}`)
  }
  return [...out]
})(), 'Vía España, Edificio Plaza, Piso 12, Apto. 12B', 'PRESERVE_LOOKUP_FILE')
domain('PA_L1_DIRECCION', 'PA_DIRECCION',
  byName(['direccion(?!_?(ip|mac|web|url|correo|mail|electronica|email))[a-z_]*|direcci[oó]n|dir|domicilio[a-z_]*|calle(_?y_?casa)?|avenida|(?<!(mac|ip|e_?mail|web|url)_?)address|street|addr|dir_?(residencial|residencia|particular|comercial|laboral|envio|entrega|facturacion|cliente|paciente|trabajo)|residencia|lugar_?(de_?)?residencia|home_?address|ubicacion_?(domicilio|vivienda)|senas|punto_?de_?referencia', 0.8]),
  byType(STRING(6)),
  byPattern([
    [String.raw`(?i)(v[ií]a|ave?\.?|avenida|calle|c\.|carretera|paseo|boulevard|blvd\.?|corredor|camino)\s+.+`, 0.7],
    [String.raw`(?i).*(edificio|edif\.?|torre|ph)\s+.+(piso|apto\.?|apartamento|oficina|local)\s*\w+.*`, 0.8],
    [String.raw`(?i).*(barriada|urbanizaci[oó]n|urb\.|residencial|sector|manzana)\s+.+(casa|lote)\s*(n[oº°]\.?\s*)?\w+.*`, 0.8],
  ], { reject: 0.2 }))

domain('PA_L1_DIRECCION_COMPLEMENTO', 'PA_CM_ALFANUM',
  byName(['n(o|um|ro|umero)_?casa|casa_?(num|no|numero)|apto|apartamento|n(o|um|ro)_?apto|piso|edificio|torre|ph|lote|manzana|local|oficina_?num|house_?number|apartment|apt|unit_?number|floor', 0.7]))

// ── L1 · Banking ────────────────────────────────────────────────────────────

domain('PA_L1_CUENTA_BANCARIA', 'PA_CM_ALFANUM',
  byName(['cuenta_?(bancaria|banco|corriente|ahorro|ahorros|deposito|abono|pago|destino|origen|planilla|debito|ach|plazo_?fijo)|cta_?(bancaria|banco|corriente|ahorro|planilla|ach)|n(o|um|ro|umero)?_?(de_?)?cuenta(_?(banco|bancaria|corriente|ahorro|ach))?|account_?(number|no|num|nbr)|bank_?account|num_?cta|no_?cta|iban', 0.85]))

// Payment Card fails a row that has no digits to mask; only values shaped like a card reach it.
algorithm('PA_TARJETA_LUHN', 'characterMapping.PaymentCard', { minMaskedPositions: 6, preserve: 0 })
decompose('PA_TARJETA', [[String.raw`(\d[\d\s\-]{11,22}\d)`, apply('PA_TARJETA_LUHN')]], keep, '4916 3131 2345 6780')
domain('PA_L1_TARJETA', 'PA_TARJETA',
  byName(['tarjeta(_?(credito|debito|cred|deb|num|no|numero|bancaria|clave|clave_?social|prepago))?|clave_?social|n(o|um|ro|umero)_?tarjeta|pan|card_?(number|no|num)|credit_?card|cc_?(number|num)|tdc|tdd|num_?tdc|plastico', 0.85]),
  // 0.9, not 1: an IMEI is 15 Luhn-valid digits too, and its own column name should win.
  byPattern([[String.raw`\d{13,19}`, 0.9, { checksum: 'LUHN', clean: String.raw`[\s\-]` }]], { reject: 0.3 }))

// ── L1 · Network, devices, vehicles, property ───────────────────────────────

algorithm('PA_OCTETO', 'characterMapping.NumericMapping', { minValue: 1, maxValue: 254 })
decompose('PA_IP', [
  [String.raw`(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})`, apply('PA_OCTETO'), apply('PA_OCTETO'), apply('PA_OCTETO'), apply('PA_OCTETO')],
], apply('PA_CM_HEX'), '190.140.22.10')
domain('PA_L1_IP', 'PA_IP',
  byName(['ip|ip_?(address|addr|origen|destino|cliente|usuario|remota|publica|privada|acceso|conexion|login)|direccion_?ip|dir_?ip|ipv[46]|remote_?addr|client_?ip|host_?ip', 0.85]),
  byPattern([
    [String.raw`((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)`, 1],
    [String.raw`[0-9A-Fa-f]{1,4}(:[0-9A-Fa-f]{0,4}){2,7}`, 0.9],
  ], { reject: 0.3 }))

domain('PA_L1_DISPOSITIVO', 'PA_CM_HEX',
  byName(['imei|imsi|iccid|mac|mac_?address|direccion_?mac|device_?id|id_?dispositivo|dispositivo_?id|uuid_?dispositivo|advertising_?id|idfa|gaid|cookie(_?id)?|session_?id|id_?sesion|serie_?equipo|n(o|um|ro)_?serie_?(equipo|celular|telefono)', 0.8]),
  byPattern([
    [String.raw`([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}`, 1],
    [String.raw`\d{15}`, 0.8, { checksum: 'LUHN' }],
  ], { reject: 0.3 }))

// Plates since 2013 are two letters and four digits (AB1234); before, six digits. Category letters
// — motorcycle, taxi, bus, government, diplomatic corps, press — stay; serial letters and digits
// are masked.
const PLATE_CATEGORY = 'ADM|MB|MI|PR|BC|CD|CC|M|T|B|G|D|E'
decompose('PA_PLACA', [
  [`(${PLATE_CATEGORY})([\\s\\-]?)(\\d{3,6})`, keep, keep, CM],
  [String.raw`([A-Z]{2})([\s\-]?)(\d{4})`, CM, keep, CM],
  [String.raw`(\d{6})`, CM],
], CM, 'AB1234')
domain('PA_L1_PLACA', 'PA_PLACA',
  byName(['placas?(_?(vehiculo|auto|circulacion|vehicular|num|no|numero))?|n(o|um|ro)_?placas?|matricula(_?(vehiculo|auto|vehicular))?|license_?plate|plate(_?number)?|registro_?vehicular|revisado', 0.85]),
  byPattern([
    [String.raw`[A-Z]{2}[\s\-]?\d{4}`, 0.8],
    [`(${PLATE_CATEGORY})[\\s\\-]?\\d{3,6}`, 0.7],
    [String.raw`\d{6}`, 0.3],
  ], { reject: 0.3 }))

domain('PA_L1_VIN', 'PA_CM_ALFANUM',
  byName(['vin|n(o|um|ro|umero)_?(de_?)?(serie|identificacion)_?(vehicular|vehiculo)|serie_?vehicul(o|ar)|n(o|um|ro)_?serie|numero_?serie|n(o|um|ro)_?motor|chasis|n(o|um|ro)_?chasis|vin_?number', 0.8]),
  byPattern([[String.raw`[A-HJ-NPR-Z0-9]{17}`, 0.7]], { reject: 0.3 }))

// A finca number leads, through the public Registro Público, to its owner.
domain('PA_L1_FINCA', 'PA_CM_ALFANUM',
  byName(['finca|n(o|um|ro|umero)_?(de_?)?finca|folio_?real|codigo_?(de_?)?ubicacion|numero_?catastral|n(o|um|ro)_?catastro|catastro|inmueble_?(num|no|numero|registro)|registro_?(de_?la_?)?propiedad', 0.85]))

domain('PA_L1_NUMERO_CONTRATO', 'PA_CM_ALFANUM',
  byName(['contrato|n(o|um|ro|umero)_?contrato|p[oó]liza|n(o|um|ro|umero)_?poliza|n(o|um|ro)_?(de_?)?(prestamo|credito|hipoteca)|n(o|um|ro)_?operacion|n(o|um|ro|umero)_?(de_?)?socio|n(o|um|ro|umero)_?(de_?)?cliente|id_?cliente|cod(igo)?_?cliente|nis|n(o|um|ro)_?(de_?)?medidor|n(o|um|ro|umero)_?(de_?)?empleado|num_?emp|no_?emp|n(o|um|ro)_?planilla|posicion_?planilla|n(o|um|ro)_?siniestro|n(o|um|ro)_?(de_?)?matricula|n(o|um|ro)_?expediente_?(cliente|laboral|personal)|folio_?(contrato|poliza|credito|cliente)', 0.7]))

domain('PA_L1_USUARIO_RRSS', 'PA_CM_ALFANUM',
  byName(['usuario|username|user_?name|login|nick(name)?|alias|cuenta_?usuario|usr|facebook|instagram|twitter|tiktok|linkedin|red_?social|perfil_?(facebook|instagram|twitter|linkedin|tiktok)|telegram|handle', 0.7]))

domain('PA_L1_CREDENCIAL', 'PA_REDACTAR',
  byName(['password|passwd|pwd|pass|contrasen[aã]|contraseña|clave(?!_?(producto|prod|articulo|sucursal|interna|tipo|registro|primaria|foranea|social|banco|pais|moneda|catastral|ubicacion|zona|area|postal))[a-z_]*|pin|nip|hash_?password|password_?hash|secret|token_?acceso|access_?token|refresh_?token|api_?key|otp|respuesta_?secreta|pregunta_?secreta', 0.9]))

decompose('PA_COORDENADA', [
  // The integer part and first decimal stay (about 11 km): the place is generalized, not moved.
  [String.raw`(-?\d{1,3}\.\d)(\d+)\s*,\s*(-?\d{1,3}\.\d)(\d+)`, keep, CM, keep, CM],
  [String.raw`(-?\d{1,3}\.\d)(\d+)`, keep, CM],
], keep, '8.983333')
domain('PA_L1_GEOLOCALIZACION', 'PA_COORDENADA',
  byName(
    ['lat|latitud|latitude|lon|lng|longitude|coordenadas?|coord_?[xy]|geo_?(lat|lon|lng|loc|localizacion|posicion)|geolocalizacion|ubicacion_?gps|gps|posicion_?gps', 0.85],
    ['longitud|long', 0.5],
  ),
  byPattern([
    [String.raw`[7-9]\.\d{3,}\s*,\s*-(7[7-9]|8[0-3])\.\d{3,}`, 0.9],
    [String.raw`[7-9]\.\d{3,}`, 0.6],
    [String.raw`-(7[7-9]|8[0-3])\.\d{3,}`, 0.7],
  ], { reject: 0.3 }))

// ── L1 · Free text ──────────────────────────────────────────────────────────

algorithm('PA_TEXTO_LIBRE', 'freeTextRedaction.FreeTextRedaction', {
  regularExpressions: [
    String.raw`(?<![\w\-])(([1-9]|1[0-3])(AV|PI)?|E|N|PE)-\d{1,4}-\d{1,6}(?![\w\-])`,
    String.raw`[\w.+\-]+@[\w\-]+(\.[\w\-]+)+`,
    String.raw`(?<!\d)(\+?507)?6\d{3}-?\d{4}(?!\d)`,
    String.raw`(?<![\d\-])[2-9]\d{2}-\d{4}(?![\d\-])`,
    String.raw`(?<!\d)\d{13,19}(?!\d)`,
    String.raw`(?<![A-Za-z])[A-Z]{2}\d{4}(?![A-Za-z\d])`,
    String.raw`(?<!\d)(\d{1,3}\.){3}\d{1,3}(?!\d)`,
  ].map((patternString) => ({ patternString })),
  regExRedactValue: '[DATO]',
  lookupFile: { uri: file('pa-texto-nombres.txt', unique([...NOMBRES, ...APELLIDOS].flatMap((v) => [v, v.toUpperCase(), fold(v), fold(v).toUpperCase()]))) },
  lookupFileRedactValue: '[NOMBRE]',
  isDenyList: true,
}, 'Cliente González, cédula 8-442-445, correo y.gonzalez@gmail.com')

domain('PA_L1_TEXTO_LIBRE', 'PA_TEXTO_LIBRE',
  byName(['observaciones?|obs|comentarios?|notas?|detalle|descripcion_?(caso|queja|reclamo|incidente|solicitud|problema|atencion|hechos)|texto_?libre|mensaje|queja|reclamo|referencias?|motivo_?(texto|detalle)|narrativa|relato|resumen_?caso|remarks|comments?|notes?|free_?text|memo|bitacora', 0.6]),
  byType(STRING(30)),
  byPattern([
    [String.raw`(([1-9]|1[0-3])(AV|PI)?|E|N|PE)-\d{1,4}-\d{1,6}`, 0.6],
    [String.raw`[\w.+\-]+@[\w\-]+\.[A-Za-z]{2,}`, 0.7],
    [String.raw`(\+?507\s?)?6\d{3}-?\d{4}`, 0.5],
  ], { reject: 0, partial: true }))

// ── L2 · Quasi-identifiers ──────────────────────────────────────────────────

// Small shifts: large enough to break the link to the person, small enough that ages, school years
// and the 18th birthday move for few people. Dates that combine with the birth date move less.
algorithm('PA_FECHA_NACIMIENTO', 'dateAlgorithms.DateShift', { minRange: -60, maxRange: 60, unit: 'DAYS', roll: false }, '1985-07-20')
algorithm('PA_FECHA_EVENTO', 'dateAlgorithms.DateShift', { minRange: -30, maxRange: 30, unit: 'DAYS', roll: false }, '2021-03-15')

domain('PA_L2_FECHA_NACIMIENTO', 'PA_FECHA_NACIMIENTO',
  byName(['fecha_?(de_?)?nac(imiento)?|fec_?nac(imiento)?|fch_?nac|f_?nac(imiento|im)?|fnac|fechanac(imiento)?|fecnac|nacimiento|dob|birth_?date|date_?of_?birth|birthdate|birthday|cumplea(n|ñ)os', 0.9]),
  byType(...DATES, STRING(6)))

// The decade stays and the unit is masked.
decompose('PA_ANIO', [[String.raw`(\d{3})(\d)`, keep, CM]], keep, '1985')
domain('PA_L2_ANIO_NACIMIENTO', 'PA_ANIO',
  byName(['an(i)?o_?(de_?)?nac(imiento)?|año_?(de_?)?nac(imiento)?|birth_?year|year_?of_?birth|ano_?nacim', 0.9]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// 37 becomes 3x. From 100 on, 90.
decompose('PA_EDAD', [
  [String.raw`(\d{3,})`, redactAs('90')],
  [String.raw`([1-9])(\d)(\.\d+)`, keep, CM, keep],
  [String.raw`([1-9])(\d)`, keep, CM],
  [String.raw`(\d)`, CM],
], keep, '37')
domain('PA_L2_EDAD', 'PA_EDAD',
  byName(['edad(_?(actual|paciente|cliente|afiliado|asegurado|beneficiario|ingreso|anos|años|cumplida|jubilacion))?|age|anos_?cumplidos|rango_?(de_?)?edad|grupo_?(de_?)?edad|edad_?en_?anos', 0.85]),
  byType(NUMBER(0, 6), STRING(0, 6)))

domain('PA_L2_FECHA_EVENTO', 'PA_FECHA_EVENTO',
  byName(['fecha_?(de_?)?(defuncion|fallecimiento|muerte|matrimonio|union|divorcio|ingreso|inicio_?labores|contratacion|contrato|egreso|despido|renuncia|jubilacion|pension|incapacidad|hospitalizacion|alta_?medica|diagnostico|atencion|consulta|parto|embarazo|detencion|sentencia|vacunacion|cirugia|reingreso|afiliacion|inscripcion_?css|naturalizacion|residencia)|fec_?(defuncion|ingreso|egreso|contrato|atencion|diagnostico|incapacidad|jubilacion)|fch_?(ingreso|egreso)|death_?date|hire_?date|termination_?date|date_?of_?death|admission_?date|discharge_?date', 0.8]),
  byType(...DATES, STRING(6)))

// Each vocabulary replaced within itself: M/F stays M/F.
decompose('PA_SEXO', [
  ['(?i)(femenino|masculino)', apply(lookup('PA_SEXO_PALABRA', 'pa-sexo-palabra.txt', ['Femenino', 'Masculino']))],
  ['(?i)(mujer|hombre)', apply(lookup('PA_SEXO_MUJER_HOMBRE', 'pa-sexo-mujer-hombre.txt', ['Mujer', 'Hombre']))],
  ['(?i)(female|male)', apply(lookup('PA_SEXO_INGLES', 'pa-sexo-ingles.txt', ['Female', 'Male']))],
  ['(?i)([fm])', apply(lookup('PA_SEXO_F_M', 'pa-sexo-f-m.txt', ['F', 'M']))],
  ['(?i)([hm])', apply(lookup('PA_SEXO_H_M', 'pa-sexo-h-m.txt', ['H', 'M']))],
], keep, 'F')
domain('PA_L2_SEXO', 'PA_SEXO',
  byName(['sexo(_?(biologico|registral|paciente|cliente|asegurado|trabajador))?|sex|g[eé]nero(?!_?(identidad|social|autopercibido))|gender|cod_?sexo', 0.85]),
  byList([['pa-detectar-sexo.txt', ['h', 'm', 'f', 'hombre', 'mujer', 'femenino', 'masculino', 'female', 'male', 'fem', 'masc'], 0.5]], { reject: 0.5 }))

// ── L2 · Where people live ──────────────────────────────────────────────────
//
// Panama has 10 provinces, 3 provincial comarcas, 82 districts with inhabitants and 699 corregimientos
// (2023 census). 616 corregimientos and 47 districts are under 10,000 and 20,000 inhabitants: with a
// birth date and a sex, one of them points at a handful of people. Small ones become the nearest one
// of the same province that is large enough — a real place, nearby, shared by many.

const distance = (a, b) => {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}
/** Small places become the nearest large one of their province, or of the country if it has none. */
function generalize(places, small) {
  return new Map(places.map((p) => {
    if (p.population >= small) return [p.code, p]
    const same = places.filter((x) => x.provinceCode === p.provinceCode && x.population >= small)
    const candidates = same.length ? same : places.filter((x) => x.population >= small)
    return [p.code, candidates.reduce((best, x) => (distance(p, x) < distance(p, best) ? x : best))]
  }))
}
/** Name → generalized name. A name shared by several places is generalized only when all are small. */
function nameMap(places, generalized, small) {
  const byName = new Map()
  for (const p of places) byName.set(p.name, [...(byName.get(p.name) ?? []), p])
  return [...byName.keys()].map((name) => {
    const all = byName.get(name)
    if (all.some((p) => p.population >= small)) return [name, name]
    return [name, generalized.get(all.reduce((a, b) => (b.population > a.population ? b : a)).code).name]
  })
}
const variants = (pairs) => unique(pairs.flatMap(([from, to]) => [
  `${from}|${to}`, `${fold(from)}|${to}`, `${from.toUpperCase()}|${to.toUpperCase()}`, `${fold(from).toUpperCase()}|${fold(to).toUpperCase()}`,
])).map((line) => line.split('|'))
const PERSONAL_WORDS = new Set([...NOMBRES, ...APELLIDOS].map((w) => fold(w).toLowerCase()))

// Districts: population and centroid weighted over their corregimientos. The Guna Yala comarca has
// no districts.
const DISTRITOS = [...new Set(CORREGIMIENTOS.map((c) => c.districtCode))].map((code) => {
  const parts = CORREGIMIENTOS.filter((c) => c.districtCode === code)
  const population = parts.reduce((s, c) => s + c.population, 0)
  const weight = (f) => parts.reduce((s, c) => s + f(c) * (c.population || 1), 0) / parts.reduce((s, c) => s + (c.population || 1), 0)
  return { code, name: parts[0].district, provinceCode: parts[0].provinceCode, population, lat: weight((c) => c.lat), lon: weight((c) => c.lon) }
}).filter((d) => !/^no tiene/i.test(d.name))
const SMALL_DISTRITO = 20000
const SMALL_CORREGIMIENTO = 10000
const distritoTo = generalize(DISTRITOS, SMALL_DISTRITO)
const corregimientoTo = generalize(CORREGIMIENTOS, SMALL_CORREGIMIENTO)

cleansing('PA_DISTRITO', 'pa-distrito-generalizado.txt', variants(nameMap(DISTRITOS, distritoTo, SMALL_DISTRITO)), 'Santa Isabel', '|')
domain('PA_L2_DISTRITO', 'PA_DISTRITO',
  byName(['distrito[a-z_]*|nom(bre)?_?(dist|distrito)|dist|municipio|mun|distrito_?(residencia|nacimiento|domicilio)', 0.85]),
  byList([['pa-detectar-distritos.txt', DISTRITOS.map((d) => d.name).filter((n) => !PERSONAL_WORDS.has(fold(n).toLowerCase())), 0.8]], { reject: 0.4 }))

cleansing('PA_CORREGIMIENTO', 'pa-corregimiento-generalizado.txt', variants(nameMap(CORREGIMIENTOS, corregimientoTo, SMALL_CORREGIMIENTO)), 'Cerro Punta', '|')
domain('PA_L2_CORREGIMIENTO', 'PA_CORREGIMIENTO',
  byName(
    ['corregimiento[a-z_]*|nom(bre)?_?(correg|corregimiento)|correg|corr|corregimiento_?(residencia|nacimiento|domicilio)', 0.85],
    ['ciudad[a-z_]*|city|town|poblacion', 0.5],
  ),
  byList([['pa-detectar-corregimientos.txt', CORREGIMIENTOS.map((c) => c.name).filter((n) => !PERSONAL_WORDS.has(fold(n).toLowerCase())), 0.8]], { reject: 0.4 }))

// INEC codes: corregimiento PPDDCC, district PPDD, also without the leading zero.
cleansing('PA_CODIGO_CORREGIMIENTO', 'pa-codigo-corregimiento-generalizado.txt', unique(CORREGIMIENTOS.flatMap((c) => {
  const to = corregimientoTo.get(c.code).code
  return [`${c.code},${to}`, `${Number(c.code)},${Number(to)}`]
})).map((line) => line.split(',')), '040612')
cleansing('PA_CODIGO_DISTRITO', 'pa-codigo-distrito-generalizado.txt', unique(DISTRITOS.flatMap((d) => {
  const to = distritoTo.get(d.code).code
  return [`${d.code},${to}`, `${Number(d.code)},${Number(to)}`]
})).map((line) => line.split(',')), '0306')
decompose('PA_CODIGO_LUGAR', [
  [String.raw`(\d{5,6})`, apply('PA_CODIGO_CORREGIMIENTO')],
  [String.raw`(\d{3,4})`, apply('PA_CODIGO_DISTRITO')],
], keep, '040612')
domain('PA_L2_CODIGO_LUGAR', 'PA_CODIGO_LUGAR',
  byName(['cod(igo)?_?(correg|corregimiento|dist|distrito|lugar(_?poblado)?|inec|geografico)|cve_?(correg|dist|lugar)|id_?(correg|corregimiento|distrito)|correg_?(cod|id)|distrito_?(cod|id)|codigo_?censal', 0.85]),
  byType(NUMBER(0, 6), STRING(0, 6)),
  byList([['pa-detectar-codigo-lugar.txt', [...CORREGIMIENTOS.flatMap((c) => [c.code, String(Number(c.code))]), ...DISTRITOS.flatMap((d) => [d.code, String(Number(d.code))])], 0.4]], { reject: 0.3 }))

// Lugares poblados and barriadas are replaced by the name of a large corregimiento or a common
// barriada: a place still, no longer theirs.
lookup('PA_LUGAR_POBLADO', 'pa-lugares-poblados.txt', CORREGIMIENTOS.filter((c) => c.population >= 20000).map((c) => c.name), 'Cerro Punta', 'PRESERVE_LOOKUP_FILE')
domain('PA_L2_LUGAR_POBLADO', 'PA_LUGAR_POBLADO',
  byName(['lugar_?poblado|nom(bre)?_?lugar_?poblado|poblado|comunidad(?!_?(indigena|religiosa))|caserio|localidad|lugar_?(de_?)?nacimiento|pueblo_?(residencia|origen)', 0.8]))

lookup('PA_BARRIADA', 'pa-barriadas.txt', readLines('barriadas.txt'), 'Villa Guadalupe', 'PRESERVE_LOOKUP_FILE')
domain('PA_L2_BARRIADA', 'PA_BARRIADA',
  byName(['barriada[a-z_]*|barrio|urbanizacion|urb|residencial|sector|nom(bre)?_?(barriada|urbanizacion|barrio)|condominio|ph_?nombre|nombre_?ph', 0.85]))

// Postal codes exist but are little used. The province digits stay, the rest becomes zeros.
decompose('PA_CODIGO_POSTAL', [[String.raw`(\d{2})(\d{2,3})`, keep, { type: 'REDACT', redactCharacter: '0' }]], CM, '0801')
domain('PA_L2_CODIGO_POSTAL', 'PA_CODIGO_POSTAL',
  byName(['cod(igo)?_?postal|zona_?postal|cp|zip(_?code)?|postal_?code|codpostal|apartado_?postal', 0.85]),
  byPattern([[String.raw`\d{4,5}`, 0.2]], { reject: 0.3 }))

const NACIONALIDADES = ['Panameña', 'Colombiana', 'Venezolana', 'Nicaragüense', 'China', 'Estadounidense', 'Dominicana', 'Cubana', 'Costarricense', 'Española', 'Ecuatoriana', 'Peruana', 'Mexicana', 'Hondureña', 'Salvadoreña', 'Haitiana', 'Argentina', 'Italiana', 'India', 'Libanesa']
lookup('PA_NACIONALIDAD', 'pa-nacionalidades.txt', NACIONALIDADES, 'Venezolana')
domain('PA_L2_NACIONALIDAD', 'PA_NACIONALIDAD',
  byName(['nacionalidad|nationality|pais_?(de_?)?(nacimiento|origen)|ciudadania|citizenship|country_?of_?birth|extranjero', 0.8]),
  byList([['pa-detectar-nacionalidades.txt', [...NACIONALIDADES, 'panameño', 'colombiano', 'venezolano', 'nicaragüense', 'chino', 'estadounidense', 'dominicano', 'cubano', 'costarricense', 'español', 'ecuatoriano', 'peruano', 'mexicano', 'hondureño', 'salvadoreño', 'haitiano', 'argentino', 'italiano', 'indio', 'libanés', 'panamá', 'colombia', 'venezuela', 'nicaragua', 'estados unidos', 'república dominicana', 'cuba', 'costa rica', 'extranjera', 'extranjero'], 0.7]], { reject: 0.4 }))

// The marital status categories of the 2023 census.
const ESTADOS_CIVILES = ['Unido', 'Casado', 'Soltero', 'Separado de matrimonio', 'Separado de unión', 'Divorciado', 'Viudo']
lookup('PA_ESTADO_CIVIL', 'pa-estado-civil.txt', ESTADOS_CIVILES, 'Unida')
domain('PA_L2_ESTADO_CIVIL', 'PA_ESTADO_CIVIL',
  byName(['estado_?civil|edo_?civil|est_?civil|ecivil|estado_?conyugal|situacion_?conyugal|marital_?status|civil_?status', 0.85]),
  byList([['pa-detectar-estado-civil.txt', ['soltero', 'soltera', 'casado', 'casada', 'unido', 'unida', 'unión libre', 'union libre', 'separado', 'separada', 'divorciado', 'divorciada', 'viudo', 'viuda', 'single', 'married', 'widowed', 'divorced'], 0.7]], { reject: 0.4 }))

lookup('PA_OCUPACION', 'pa-ocupaciones.txt', ['Oficinista', 'Comerciante', 'Vendedor', 'Obrero de la construcción', 'Operador de equipo pesado', 'Conductor', 'Educador', 'Enfermero', 'Médico general', 'Contador', 'Ingeniero', 'Abogado', 'Técnico en mantenimiento', 'Cajero', 'Salonero', 'Cocinero', 'Agente de seguridad', 'Albañil', 'Electricista', 'Plomero', 'Mecánico', 'Agricultor', 'Jornalero', 'Ganadero', 'Pescador', 'Estudiante', 'Trabajador doméstico', 'Jubilado', 'Pensionado', 'Trabajador independiente', 'Programador', 'Diseñador gráfico', 'Recepcionista', 'Aseador', 'Supervisor', 'Gerente de área', 'Asesor de ventas', 'Bodeguero', 'Repartidor', 'Desempleado'], 'Gerente Regional de Operaciones Bocas del Toro')
domain('PA_L2_OCUPACION', 'PA_OCUPACION',
  byName(['ocupaci[oó]n|profesi[oó]n|oficio|puesto(?!_?(votacion|venta|trabajo_?id))(_?(trabajo|laboral|actual))?|cargo(?!_?(fijo|variable|monto|adicional|servicio|tarifa|valor|cuenta|extra|automatico|recurrente))|job_?title|occupation|actividad_?(laboral|economica_?persona)|categoria_?laboral', 0.8]))

lookup('PA_EMPLEADOR', 'pa-empleadores.txt', ['Comercializadora del Istmo, S.A.', 'Servicios Integrales del Pacífico, S.A.', 'Constructora Cerro Ancón, S.A.', 'Transportes Canal Seguro, S.A.', 'Agroindustrias de Azuero, S.A.', 'Distribuidora Chiriquí Central, S.A.', 'Hoteles Bahía Dorada, S.A.', 'Clínica San Fernando del Norte, S.A.', 'Colegio Particular Los Álamos, S.A.', 'Consultores Asociados de Veraguas, S.A.', 'Minera Cerro Verde, S.A.', 'Pesquera Golfo de Montijo, S.A.', 'Tecnologías del Istmo, S.A.', 'Supermercados La Estrella, S.A.', 'Ferretería El Constructor, S.A.', 'Logística Colón Libre, S.A.', 'Servicios de Limpieza Las Cumbres, S.A.', 'Laboratorios Cruz del Sur, S.A.', 'Zona Libre Import Export, S.A.', 'Autopartes de Coclé, S.A.', 'Fundación Manos Unidas', 'Municipio de Villa Nueva', 'Seguridad Privada Centinela, S.A.', 'Muebles y Maderas de Darién, S.A.', 'Restaurantes El Fogón, S.A.'], 'Autoridad del Canal de Panamá')
domain('PA_L2_EMPLEADOR', 'PA_EMPLEADOR',
  byName(['empleador|patrono|nombre_?patrono|razon_?social_?(patrono|empleador)|empresa_?(empleadora|trabajo|laboral)|lugar_?(de_?)?trabajo|centro_?(de_?)?trabajo|employer|institucion_?(donde_?)?labora|entidad_?(donde_?)?labora', 0.8]))

// Schooling levels of the Panamanian system (primaria, premedia, media) as the census groups them.
const ESCOLARIDADES = ['Ningún grado', 'Primaria incompleta', 'Primaria completa', 'Premedia incompleta', 'Premedia completa', 'Media incompleta', 'Bachiller', 'Vocacional', 'Superior no universitaria', 'Universitaria', 'Especialidad o postgrado', 'Maestría', 'Doctorado']
lookup('PA_ESCOLARIDAD', 'pa-escolaridad.txt', ESCOLARIDADES, 'Premedia completa')
domain('PA_L2_ESCOLARIDAD', 'PA_ESCOLARIDAD',
  byName(['escolaridad|nivel_?(educativo|educacional|escolar|de_?estudios|academico|de_?instruccion)|grado_?(de_?)?(estudios|instruccion)|grado_?academico|ultimo_?grado(_?aprobado)?|education_?level|anos_?(de_?)?escolaridad', 0.8]),
  byList([['pa-detectar-escolaridad.txt', [...ESCOLARIDADES, 'primaria', 'premedia', 'media', 'bachillerato', 'bachiller', 'técnico', 'universidad', 'licenciatura', 'postgrado', 'posgrado', 'ninguno', 'ninguna'], 0.6]], { reject: 0.4 }))

lookup('PA_ESCUELA', 'pa-escuelas.txt', ['Escuela República de Colombia', 'Escuela Juan Demóstenes Arosemena', 'Centro Básico General Las Mañanitas', 'Centro de Educación Básica General Guararé', 'Instituto Profesional y Técnico de Veraguas', 'Colegio Secundario de Aguadulce', 'Instituto América', 'Escuela Normal Juan Demóstenes Arosemena', 'Instituto Técnico Superior de Chiriquí', 'Universidad del Istmo Central', 'Universidad Tecnológica del Pacífico', 'Centro Regional Universitario de Azuero', 'Colegio Particular Los Álamos', 'Escuela Primaria Villa del Carmen', 'Colegio Bilingüe Las Cumbres'], 'Instituto Nacional de Panamá')
domain('PA_L2_ESCUELA', 'PA_ESCUELA',
  byName(['escuela|colegio|plantel|nombre_?(escuela|plantel|colegio|centro_?educativo|institucion_?educativa)|centro_?educativo|institucion_?educativa|universidad|instituto|school(_?name)?|cebg|centro_?basico', 0.75]))

// Capped at 5 as text: large households are rare, and a rare count identifies.
decompose('PA_CANTIDAD_ACOTADA', [[String.raw`([0-5])`, keep], [String.raw`(\d+)`, redactAs('5')]], keep, '9')
domain('PA_L2_DEPENDIENTES', 'PA_CANTIDAD_ACOTADA',
  byName(['dependientes|n(o|um|ro)?_?dependientes|num_?hijos|n(o|um|ro)?_?hijos|cant_?hijos|hijos|hijos_?nacidos_?vivos|integrantes_?(del_?)?(hogar|familia)|n(o|um|ro)_?integrantes|tamano_?(del_?)?hogar|personas_?(en_?)?(el_?)?hogar', 0.8]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// ── L3 · Sensitive data (Ley 81, art. 4, 11) ────────────────────────────────

// Indigenous and Afro-descendant groups as the 2023 census asks for them.
const PUEBLOS = ['Guna', 'Ngäbe', 'Buglé', 'Naso Tjërdi', 'Bokota', 'Emberá', 'Wounaan', 'Bri Bri', 'Otro pueblo indígena', 'Afropanameño', 'Afrodescendiente', 'Moreno', 'Negro', 'Afrocolonial', 'Afroantillano', 'Ninguno']
categorical('PA_PUEBLO', 'pa-pueblos.txt', PUEBLOS, 'Teribe')
domain('PA_L3_ETNIA', 'PA_PUEBLO',
  byName(['etnia|[eé]tnico|origen_?[eé]tnico|grupo_?[eé]tnico|pueblo_?(indigena|originario)|grupo_?indigena|indigena|ind[ií]gena|afro(panameno|descendiente|panameño)?|grupo_?afro(descendiente)?|autoidentificacion(_?(etnica|indigena|afro))?|se_?considera_?(indigena|afro|afrodescendiente)|raza|race|ethnicity|ethnic_?group|comunidad_?indigena|pertenencia_?(etnica|indigena)', 0.9]),
  byList([['pa-detectar-pueblos.txt', [...PUEBLOS, 'kuna', 'cuna', 'gunadule', 'guna yala', 'ngobe', 'ngöbe', 'guaymí', 'guaymi', 'bugle', 'naso', 'teribe', 'térraba', 'embera', 'wounan', 'waunana', 'bribri', 'afrodescendiente', 'afropanameña', 'negra', 'morena', 'afroantillana', 'negro colonial', 'negro antillano', 'indígena', 'no indígena', 'ninguna'], 0.9],
    // Self-identification is often a yes/no flag: it backs up the column name but decides nothing alone.
    ['pa-detectar-bandera.txt', ['s', 'n', 'sí', 'no', 'y', '0', '1'], 0.3],
  ], { reject: 0.4 }))

const LENGUAS = ['Ngäbere', 'Buglere', 'Guna', 'Emberá', 'Wounmeu', 'Naso Tjërdi', 'Bribri', 'Otra lengua indígena', 'No habla lengua indígena']
categorical('PA_LENGUA_INDIGENA', 'pa-lenguas.txt', LENGUAS, 'Teribe')
domain('PA_L3_LENGUA_INDIGENA', 'PA_LENGUA_INDIGENA',
  byName(['lengua(_?(indigena|materna|originaria))?|habla_?(lengua_?)?(indigena|originaria)|idioma_?(indigena|materno|originario)|lengua_?que_?habla|dialecto|native_?language', 0.9]),
  byList([['pa-detectar-lenguas.txt', [...LENGUAS, 'ngabere', 'ngöbere', 'guaymí', 'bugle', 'dulegaya', 'kuna', 'emberá', 'wounaan', 'naso', 'teribe', 'bribri', 'español', 'ninguna', 'no habla'], 0.8]], { reject: 0.4 }))

const CIE10 = ['I10', 'E11', 'E78', 'J45', 'J06', 'J02', 'J20', 'K29', 'K21', 'K59', 'M54', 'M17', 'M25', 'N39', 'N20', 'R51', 'R10', 'H10', 'H66', 'L23', 'L30', 'B34', 'A09', 'E03', 'E66', 'D50', 'I83', 'K80', 'K40', 'S93', 'S60', 'Z00', 'J30', 'J32', 'G43', 'M79', 'R05']
const CIE10_DECIMAL = ['E11.9', 'E78.5', 'J45.9', 'J06.9', 'J02.9', 'J20.9', 'K29.7', 'K21.9', 'K59.0', 'M54.5', 'M17.9', 'N39.0', 'N20.0', 'R10.4', 'H10.9', 'H66.9', 'L23.9', 'L30.9', 'B34.9', 'A09.9', 'E03.9', 'E66.9', 'D50.9', 'I83.9', 'K80.2', 'K40.9', 'S93.4', 'S60.0', 'Z00.0', 'J30.4', 'J32.9', 'G43.9', 'M79.1']
decompose('PA_DIAGNOSTICO', [
  [String.raw`([A-TV-Za-tv-z]\d{2}\.\d{1,2})`, apply(lookup('PA_CIE10_DECIMAL', 'pa-cie10-decimal.txt', CIE10_DECIMAL, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [String.raw`([A-TV-Za-tv-z]\d{2,3})`, apply(lookup('PA_CIE10', 'pa-cie10.txt', CIE10, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [FLAG, apply('PA_BANDERA')],
], apply(lookup('PA_DIAGNOSTICO_TEXTO', 'pa-diagnosticos.txt', ['Hipertensión arterial', 'Diabetes mellitus tipo 2', 'Asma bronquial', 'Lumbalgia', 'Gastritis crónica', 'Rinofaringitis aguda', 'Infección de vías urinarias', 'Migraña', 'Hipotiroidismo', 'Dislipidemia', 'Obesidad', 'Gonartrosis', 'Bronquitis aguda', 'Faringoamigdalitis aguda', 'Dermatitis de contacto', 'Otitis media aguda', 'Esguince de tobillo', 'Conjuntivitis', 'Anemia ferropénica', 'Enfermedad por reflujo gastroesofágico', 'Síndrome de intestino irritable', 'Tendinitis', 'Sinusitis aguda', 'Cefalea tensional', 'Insuficiencia venosa periférica', 'Hernia inguinal', 'Litiasis renal', 'Colelitiasis', 'Gastroenteritis aguda', 'Control de salud del niño'])), 'F32.9')
domain('PA_L3_SALUD_DIAGNOSTICO', 'PA_DIAGNOSTICO',
  byName(['diagn[oó]stico[a-z_]*|diag|dx|cie_?10|cie_?11|cod(igo)?_?cie|cie|icd_?10|icd|patolog[ií]a[a-z_]*|padecimiento[a-z_]*|enfermedad(es)?[a-z_]*|morbilidad|condicion_?(medica|de_?salud|cronica)|problema_?(de_?)?salud|impresion_?diagnostica|causa_?(incapacidad|muerte|defuncion|hospitalizacion|consulta)|motivo_?(de_?)?(consulta|hospitalizacion|incapacidad)|comorbilidad(es)?|antecedentes_?(medicos|patologicos|personales_?patologicos|heredofamiliares|clinicos)|alergias?|enfermedad_?preexistente|preexistencias?|enfermedad_?cronica|riesgo_?profesional', 0.85]),
  // 0.5: codes shaped like CIE-10 appear in other catalogs too; the name has to agree.
  byPattern([[String.raw`[A-TV-Za-tv-z]\d{2}(\.\d{1,2}|\d)?`, 0.5]], { reject: 0.3 }))

const MEDICAMENTOS = ['Acetaminofén', 'Ibuprofeno', 'Naproxeno', 'Diclofenaco', 'Ketorolaco', 'Metformina', 'Glibenclamida', 'Losartán', 'Enalapril', 'Amlodipina', 'Atorvastatina', 'Omeprazol', 'Levotiroxina', 'Amoxicilina', 'Ciprofloxacina', 'Salbutamol', 'Loratadina', 'Ambroxol', 'Clorfeniramina', 'Ácido acetilsalicílico', 'Prednisona', 'Complejo B', 'Hidroclorotiazida', 'Simvastatina', 'Ranitidina', 'Sulfato ferroso']
categorical('PA_MEDICAMENTO', 'pa-medicamentos.txt', MEDICAMENTOS, 'Sertralina 50 mg')
domain('PA_L3_SALUD_MEDICAMENTO', 'PA_MEDICAMENTO',
  byName(['medicamentos?|f[aá]rmacos?|sustancia_?activa|principio_?activo|prescripci[oó]n|receta(_?medica)?|tratamiento(_?farmacologico)?|medication|drug(_?name)?|posologia|lista_?oficial_?medicamentos', 0.85]),
  byList([['pa-detectar-medicamentos.txt', [...MEDICAMENTOS, 'paracetamol', 'sertralina', 'fluoxetina', 'escitalopram', 'paroxetina', 'quetiapina', 'clonazepam', 'alprazolam', 'diazepam', 'carbonato de litio', 'litio', 'metilfenidato', 'risperidona', 'olanzapina', 'aripiprazol', 'tenofovir', 'emtricitabina', 'efavirenz', 'dolutegravir', 'bictegravir', 'insulina', 'insulina glargina', 'warfarina', 'levetiracetam', 'ácido valproico', 'naltrexona', 'misoprostol', 'levonorgestrel'], 0.7]], { reject: 0.3 }))

domain('PA_L3_SALUD_IDENTIFICADOR', 'PA_CM_ALFANUM',
  byName(
    ['expediente_?clinico|n(o|um|ro|umero)_?expediente(_?clinico)?|historia_?clinica|n(o|um|ro)_?historia|nhc|n(o|um|ro)_?episodio|n(o|um|ro)_?(de_?)?admision|folio_?(atencion|urgencias|receta|incapacidad)|n(o|um|ro)_?incapacidad|certificado_?(de_?)?incapacidad|n(o|um|ro)_?(de_?)?cama|n(o|um|ro)_?interconsulta|n(o|um|ro)_?(de_?)?receta|n(o|um|ro)_?biopsia|medical_?record_?number|mrn', 0.85],
    ['expediente|episodio|cama', 0.55],
  ))

domain('PA_L3_SALUD_TEXTO_CLINICO', 'PA_TEXTO_LIBRE',
  byName(['nota_?(medica|de_?evolucion|evolucion|de_?ingreso|ingreso|de_?egreso|egreso|de_?urgencias|urgencias|postoperatoria|preoperatoria|de_?enfermeria|clinica)s?|notas?_?clinicas?|enfermedad_?actual|anamnesis|examen_?fisico|evoluci[oó]n(_?(medica|clinica))?|epicrisis|indicaciones(_?medicas)?|resumen_?clinico|resumen_?(de_?)?egreso|historia_?(de_?la_?)?enfermedad|plan_?(de_?)?tratamiento|pronostico|hallazgos|interpretacion|clinical_?notes?|progress_?notes?', 0.85]),
  byType(STRING(30)))

domain('PA_L3_SALUD_RESULTADO_EXAMEN', 'PA_CM_ALFANUM',
  byName(
    ['resultado_?(estudio|examen|laboratorio|lab|prueba|pcr|antigeno|biopsia|imagen|vih|covid|papanicolaou|mamografia)|examenes?_?(de_?)?laboratorio|vih|hiv|carga_?viral|cd4|glucosa|glicemia|hemoglobina(_?glicosilada)?|hba1c|colesterol|trigliceridos|presion_?arterial|imc|prueba_?(covid|embarazo|vih|antidoping|toxicologica)|antidoping|lab_?result', 0.8],
    ['resultado|examen', 0.5],
  ))

const GRUPOS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']
lookup('PA_GRUPO_SANGUINEO', 'pa-grupo-sanguineo.txt', GRUPOS, 'O+', 'PRESERVE_LOOKUP_FILE')
domain('PA_L3_SALUD_GRUPO_SANGUINEO', 'PA_GRUPO_SANGUINEO',
  byName(['grupo_?sangu[ií]neo|grupo_?sang|tipo_?(de_?)?sangre|tipo_?sanguineo|factor_?rh|rh|blood_?type|blood_?group', 0.9]),
  byList([['pa-detectar-grupo-sanguineo.txt', [...GRUPOS, '0+', '0-', 'a rh+', 'a rh-', 'b rh+', 'b rh-', 'ab rh+', 'ab rh-', 'o rh+', 'o rh-', 'a positivo', 'a negativo', 'b positivo', 'b negativo', 'ab positivo', 'ab negativo', 'o positivo', 'o negativo'], 0.9]], { reject: 0.4 }))

// The disability types SENADIS certifies.
const DISCAPACIDADES = ['Física', 'Visual', 'Auditiva', 'Intelectual', 'Psicosocial', 'Visceral', 'Múltiple', 'Sin discapacidad']
categorical('PA_DISCAPACIDAD', 'pa-discapacidad.txt', DISCAPACIDADES, 'Discapacidad psicosocial severa')
domain('PA_L3_SALUD_DISCAPACIDAD', 'PA_DISCAPACIDAD',
  byName(['discapacidad[a-z_]*|tipo_?(de_?)?discapacidad|grado_?(de_?)?discapacidad|certificado_?(de_?)?discapacidad|carne_?senadis|senadis|persona_?con_?discapacidad|pcd|invalidez|porcentaje_?(de_?)?invalidez|pension_?(de_?)?invalidez|limitacion(_?(fisica|actividad))?|disability|dependencia_?funcional|nee|necesidades_?educativas_?especiales', 0.9]),
  byList([['pa-detectar-discapacidad.txt', [...DISCAPACIDADES, 'motora', 'fisica', 'física motora', 'visual', 'auditiva', 'intelectual', 'mental', 'psicosocial', 'visceral', 'múltiple', 'sensorial', 'ninguna', 'sin limitación'], 0.6]], { reject: 0.3 }))

// Reproductive and mental health, sexual life, philosophical beliefs, union membership: the values
// have no shared vocabulary, so they are suppressed (flags and numeric codes keep their shape).
domain('PA_L3_SALUD_SEXUAL_REPRODUCTIVA', 'PA_CATEGORIA_SUPRIMIDA',
  byName(['embarazo|embarazada|gestaci[oó]n|semanas_?(de_?)?gestacion|edad_?gestacional|fum|fecha_?ultima_?menstruacion|aborto|anticonceptivos?|metodo_?(de_?)?planificacion(_?familiar)?|planificacion_?familiar|fertilidad|infertilidad|reproduccion_?asistida|gestas|partos|cesareas?|puerperio|its|ets|infeccion_?(de_?)?transmision_?sexual|prep|pregnan[a-z]*|contracepti[a-z]*', 0.9]))

domain('PA_L3_SALUD_MENTAL_ADICCIONES', 'PA_CATEGORIA_SUPRIMIDA',
  byName(['salud_?mental|psiquiatri[a-z]*|psicologi[a-z]*|trastorno[a-z_]*|depresi[oó]n|ansiedad|suicid[a-z]*|autolesi[oó]n|adicci[oó]n(es)?|consumo_?(de_?)?(drogas|alcohol|sustancias|tabaco)|alcoholismo|farmacodependencia|drogadiccion|toxicomania|dependencia_?(alcohol|drogas|sustancias)|tratamiento_?(adicciones|drogas|alcohol)|rehabilitacion_?(adicciones|drogas)|mental_?health|substance_?(use|abuse)', 0.9]))

domain('PA_L3_BIOMETRICO', 'PA_REDACTAR',
  byName(['huella(_?(dactilar|digital))?|huellas|dactilar|biometri[a-z_]*|template_?(facial|biometrico|huella)|rostro|reconocimiento_?facial|facial_?(template|id)|iris|retina|voz_?(huella|biometrica)|firma_?(digitalizada|biometrica|autografa_?digital)|fingerprint|face_?(id|template|encoding)|palm_?print|minucias', 0.9]),
  byType(STRING()))

domain('PA_L3_INFORMACION_GENETICA', 'PA_REDACTAR',
  byName(['adn|dna|genoma|genotipo|genetic[a-z_]*|gen[eé]tic[ao]|informacion_?genetica|secuencia_?genetica|marcador_?genetico|perfil_?(genetico|biologico)|mutacion(_?genetica)?|snp|brca|haplotipo|cariotipo|tamizaje_?(genetico|neonatal|metabolico)|prueba_?(de_?)?paternidad', 0.9]))

const ORIENTACIONES = ['Heterosexual', 'Homosexual', 'Lesbiana', 'Gay', 'Bisexual', 'Pansexual', 'Asexual', 'Otra', 'Prefiere no responder']
categorical('PA_ORIENTACION_SEXUAL', 'pa-orientacion-sexual.txt', ORIENTACIONES, 'Bisexual')
domain('PA_L3_ORIENTACION_SEXUAL', 'PA_ORIENTACION_SEXUAL',
  byName(['orientaci[oó]n_?sexual|preferencia_?sexual|sexual_?(orientation|preference)|orient_?sexual|pref_?sexual', 0.95]),
  byList([['pa-detectar-orientacion-sexual.txt', [...ORIENTACIONES, 'hetero', 'homo', 'queer', 'no responde', 'straight', 'lesbian', 'lgbt', 'lgbtiq+'], 0.8]], { reject: 0.4 }))

const IDENTIDADES = ['Mujer', 'Hombre', 'Mujer trans', 'Hombre trans', 'No binario', 'Género fluido', 'Otra', 'Prefiere no responder']
categorical('PA_IDENTIDAD_GENERO', 'pa-identidad-genero.txt', IDENTIDADES, 'Hombre trans')
domain('PA_L3_IDENTIDAD_GENERO', 'PA_IDENTIDAD_GENERO',
  byName(['identidad_?(de_?)?g[eé]nero|gender_?identity|g[eé]nero_?(identidad|social|autopercibido)|transg[eé]nero|transexual|persona_?trans|cambio_?(de_?)?(sexo|genero|nombre_?por_?genero)|pronombres?', 0.95]),
  byList([['pa-detectar-identidad-genero.txt', [...IDENTIDADES, 'cisgénero', 'transgénero', 'no binaria', 'trans', 'femenino', 'masculino'], 0.7]], { reject: 0.4 }))

domain('PA_L3_VIDA_SEXUAL', 'PA_CATEGORIA_SUPRIMIDA',
  byName(['vida_?sexual|conducta_?sexual|actividad_?sexual|parejas?_?sexuales?|practicas_?sexuales|inicio_?(de_?)?(la_?)?vida_?sexual|sexual_?(activity|behavior|history)|historia_?sexual|comportamiento_?sexual', 0.9]))

// Groups of the national religion surveys, and the indigenous religions of Panama.
const RELIGIONES = ['Católica', 'Evangélica', 'Adventista del Séptimo Día', 'Testigo de Jehová', 'Iglesia de Jesucristo de los Santos de los Últimos Días', 'Bahá\'í', 'Judía', 'Musulmana', 'Budista', 'Hindú', 'Mamatata', 'Ibeorgun', 'Otra religión', 'Sin religión']
categorical('PA_RELIGION', 'pa-religiones.txt', RELIGIONES, 'Episcopal')
domain('PA_L3_RELIGION', 'PA_RELIGION',
  byName(['religi[oó]n[a-z_]*|credo|culto|iglesia|creencia_?religiosa|confesion_?religiosa|denominacion_?religiosa|religious_?affiliation|comunidad_?religiosa|congregacion', 0.95]),
  byList([['pa-detectar-religiones.txt', [...RELIGIONES, 'católico', 'catolica', 'cristiano', 'cristiana', 'evangélico', 'evangélica', 'protestante', 'pentecostal', 'bautista', 'metodista', 'episcopal', 'mormón', 'testigos de jehová', 'adventista', 'bahai', 'judío', 'musulmán', 'islam', 'budismo', 'hinduismo', 'mama tata', 'ateo', 'atea', 'agnóstico', 'agnóstica', 'ninguna', 'creyente', 'otra'], 0.9]], { reject: 0.4 }))

domain('PA_L3_CREENCIA_FILOSOFICA_MORAL', 'PA_CATEGORIA_SUPRIMIDA',
  byName(['creencias?_?(filosoficas?|morales?|personales)|convicci[oó]n(es)?(_?(filosoficas?|morales?|eticas?|personales))?|objecion_?(de_?)?conciencia|postura_?(etica|moral)|valores_?personales|filosofia_?(de_?)?vida|cosmovision', 0.9]))

const IDEOLOGIAS = ['Izquierda', 'Centro izquierda', 'Centro', 'Centro derecha', 'Derecha', 'Sin preferencia', 'Prefiere no responder']
categorical('PA_OPINION_POLITICA', 'pa-opiniones-politicas.txt', IDEOLOGIAS, 'Centro derecha')
domain('PA_L3_OPINION_POLITICA', 'PA_OPINION_POLITICA',
  byName(['opini[oó]n(es)?_?pol[ií]ticas?|ideolog[ií]a(_?politica)?|posicion_?politica|postura_?politica|tendencia_?politica|orientacion_?politica|preferencia_?(politica|electoral|partidista)|intencion_?(de_?)?voto|simpatia_?(politica|partidista)|political_?(view|orientation|opinion)', 0.9]),
  byList([['pa-detectar-opiniones-politicas.txt', [...IDEOLOGIAS, 'centroizquierda', 'centroderecha', 'liberal', 'conservador', 'progresista', 'ninguna', 'apartidista'], 0.7]], { reject: 0.4 }))

// Parties legally constituted before the Tribunal Electoral in 2026.
const PARTIDOS = ['Partido Revolucionario Democrático', 'Realizando Metas', 'Cambio Democrático', 'Partido Panameñista', 'MOLIRENA', 'Movimiento Otro Camino', 'Frente Amplio por la Democracia', 'Partido Alianza', 'Partido Popular', 'Libre postulación', 'Sin partido']
categorical('PA_PARTIDO_POLITICO', 'pa-partidos.txt', PARTIDOS, 'Partido Liberal')
domain('PA_L3_AFILIACION_POLITICA', 'PA_PARTIDO_POLITICO',
  byName(['partido(_?pol[ií]tico)?|militancia|militante|adherente|inscrito_?partido|afiliaci[oó]n_?(politica|partidista|partido)|afiliado_?(a_?)?partido|padron_?(de_?)?(militantes|adherentes)|political_?party|party_?affiliation|alianza_?electoral|simpatizante|libre_?postulacion', 0.95]),
  byList([['pa-detectar-partidos.txt', [...PARTIDOS, 'PRD', 'RM', 'CD', 'MOCA', 'FAD', 'PP', 'Panameñista', 'Molirena', 'Movimiento Liberal Republicano Nacionalista', 'Alianza', 'Partido Popular', 'Acción Ciudadana Independiente', 'Partido Nacional Humanitario', 'Movimiento Radix', 'independiente', 'libre postulación', 'sin partido', 'ninguno'], 0.8]], { reject: 0.4 }))

domain('PA_L3_AFILIACION_SINDICAL', 'PA_CATEGORIA_SUPRIMIDA',
  byName(['sindicato[a-z_]*|sindical|sindicalizado|afiliaci[oó]n_?sindical|cuota_?sindical|delegado_?sindical|seccional_?sindical|gremio|gremial|asociacion_?(de_?)?(docentes|educadores|profesores|empleados)|union_?member(ship)?|trade_?union|convencion_?colectiva', 0.95]),
  byList([['pa-detectar-sindicatos.txt', ['SUNTRACS', 'CONATO', 'CONUSI', 'CONATRAB', 'ASOPROF', 'AEVE', 'UNEP', 'ANEP', 'SITRACHILCO', 'FENASEP', 'sindicalizado', 'sindicato único nacional de trabajadores de la construcción', 'asociación de educadores veragüenses'], 0.6]], { reject: 0.3 }))

// ── FIN · Economic, financial and credit data ───────────────────────────────

decompose('PA_APC', [
  // A three-digit APC score gets other digits; flags stay flags.
  [String.raw`(\d{2,3})`, CM],
  [FLAG, apply('PA_BANDERA')],
], apply(lookup('PA_REFERENCIA_CREDITO', 'pa-referencia-credito.txt', ['Al día', 'Morosidad de 30 días', 'Morosidad de 60 días', 'Morosidad de 90 días', 'Morosidad de 120 días', 'Morosidad de más de 120 días', 'Cuenta en cobro judicial', 'Cuenta castigada', 'Arreglo de pago', 'Sin historial'])), 'Morosidad de 90 días')
domain('PA_FIN_REFERENCIA_CREDITO', 'PA_APC',
  byName(['apc|referencia_?(de_?)?credito|referencias_?crediticias|historial_?(de_?)?credito|historial_?crediticio|score(_?(apc|crediticio|credito|riesgo))?|puntaje_?(crediticio|apc|riesgo|credito)|calificacion_?(crediticia|apc|riesgo)|morosidad|moroso|morosa|dias_?(de_?)?(atraso|mora)|cartera_?(vencida|morosa)|cobro_?judicial|castigad[oa]|estatus_?(credito|crediticio|cartera)|estado_?(de_?)?(cuenta_?)?(credito|crediticio|cartera)|credit_?score|delinquen[a-z]*', 0.9]))

algorithm('PA_MONTO_DEUDA', 'characterMapping.NumericMapping', { minValue: 100, maxValue: 500000 }, '8500')
domain('PA_FIN_MONTO_DEUDA', 'PA_MONTO_DEUDA',
  byName(['monto_?(deuda|adeudado|vencido|moroso|credito|prestamo|financiado|hipoteca)|deuda(_?(total|vigente|vencida))?|adeudo|saldo_?(deudor|insoluto|vencido|moroso|credito|prestamo|tarjeta|hipoteca)|limite_?(de_?)?credito|linea_?(de_?)?credito|pago_?minimo|letra_?(mensual|prestamo|hipoteca)|debt(_?amount)?|outstanding_?balance', 0.85]),
  byType(NUMBER()))

algorithm('PA_INGRESO_MENSUAL', 'characterMapping.NumericMapping', { minValue: 350, maxValue: 25000 }, '1850')
domain('PA_FIN_INGRESO_MENSUAL', 'PA_INGRESO_MENSUAL',
  byName(['salario[a-z_]*|sueldo[a-z_]*|remuneraci[oó]n[a-z_]*|ingreso_?(mensual|neto|bruto|familiar|del_?hogar|hogar|per_?capita|total|promedio|declarado|laboral|anual)|ingresos(_?[a-z]+)?|decimo_?tercer_?mes|xiii_?mes|total_?devengado|neto_?a_?pagar|planilla_?(neta|bruta)|gasto_?(mensual|familiar)|capacidad_?(de_?)?pago|salary|wage|income|gross_?pay|net_?pay', 0.85]),
  byType(NUMBER()))

algorithm('PA_PATRIMONIO', 'characterMapping.NumericMapping', { minValue: 10000, maxValue: 3000000 }, '185000')
domain('PA_FIN_PATRIMONIO', 'PA_PATRIMONIO',
  byName(['patrimonio(_?(neto|total))?|valor_?(catastral|comercial|avaluo|inmueble|propiedad|finca|vivienda|vehiculo|de_?la_?garantia)|avaluo|bienes_?(inmuebles|muebles)|valor_?bienes|activos_?(personales|totales)|saldo_?(inversion|ahorro|ahorros|cuenta|plazo_?fijo)|monto_?(inversion|ahorro|plazo_?fijo)|net_?worth|assets', 0.85]),
  byType(NUMBER()))

algorithm('PA_MONTO_PENSION', 'characterMapping.NumericMapping', { minValue: 120, maxValue: 6000 }, '680')
domain('PA_FIN_PENSION', 'PA_MONTO_PENSION',
  byName(['monto_?(pension|jubilacion)|pension_?(mensual|monto|vejez|invalidez|sobreviviente)|jubilacion_?(mensual|monto)|saldo_?(cuenta_?individual|siacap|retiro|fondo_?complementario)|cuenta_?individual|siacap|fondo_?(de_?)?cesantia|prima_?de_?antiguedad|retirement_?balance', 0.9]),
  byType(NUMBER()))

// Social security coverage as the 2023 census asks for it.
const COBERTURAS = ['Asegurado directo', 'Beneficiario', 'Jubilado o pensionado por vejez', 'Pensionado por enfermedad o accidente', 'Jubilado o pensionado de otro país', 'No tiene seguro social']
decompose('PA_SEGURO_SOCIAL', [
  [FLAG, apply('PA_BANDERA')],
  [String.raw`(\d{1,2})`, CM],
], apply(lookup('PA_SEGURO_SOCIAL_LISTA', 'pa-seguro-social.txt', COBERTURAS, undefined, 'PRESERVE_LOOKUP_FILE')), 'Beneficiario')
domain('PA_FIN_SEGURO_SOCIAL', 'PA_SEGURO_SOCIAL',
  byName(['tipo_?(de_?)?(asegurado|seguro_?social|cobertura)|condicion_?(de_?)?asegurado|cobertura_?(css|salud|seguro_?social)|afiliacion_?(a_?la_?)?(css|caja_?de_?seguro_?social|seguridad_?social)|asegurado_?css|es_?asegurado|seguro_?(medico|de_?salud|privado)|health_?insurance', 0.9]),
  byList([['pa-detectar-seguro-social.txt', [...COBERTURAS, 'asegurado', 'asegurada', 'beneficiaria', 'jubilado', 'jubilada', 'pensionado', 'pensionada', 'cotizante', 'no asegurado', 'no tiene', 'css', 'minsa', 'seguro privado'], 0.8]], { reject: 0.4 }))

// MIDES transfer programs and IFARHU's universal school assistance, 2026.
const PROGRAMAS = ['120 a los 65', 'Red de Oportunidades', 'Ángel Guardián', 'Bono Alimenticio Nutricional', 'PASE-U', 'Beca de excelencia IFARHU', 'Auxilio económico IFARHU', 'Subsidio SENADIS', 'Ninguno']
categorical('PA_PROGRAMA_SOCIAL', 'pa-programas-sociales.txt', PROGRAMAS, 'Vale Digital')
domain('PA_FIN_PROGRAMA_SOCIAL', 'PA_PROGRAMA_SOCIAL',
  byName(['programa_?(social|de_?transferencia|de_?apoyo|gobierno|mides)|programas_?sociales|beneficiario_?(de_?)?(programa|bono|beca|subsidio|mides)|bono_?(solidario|alimenticio|nutricional|digital)|vale_?digital|subsidio_?(estatal|social|senadis)|transferencia_?monetaria|red_?(de_?)?oportunidades|angel_?guardian|120_?a_?los_?65|pase_?u|beca_?universal|ifarhu|senapan|padron_?(de_?)?beneficiarios|social_?program', 0.9]),
  byList([['pa-detectar-programas.txt', [...PROGRAMAS, 'ciento veinte a los sesenta y cinco', 'red oportunidades', 'angel guardian', 'bono alimenticio', 'senapan', 'pase u', 'beca universal', 'vale digital', 'panamá solidario', 'bono solidario', 'ninguno'], 0.8]], { reject: 0.4 }))

decompose('PA_NIVEL_SOCIOECONOMICO', [
  [String.raw`([1-5])`, apply(lookup('PA_QUINTIL', 'pa-quintil.txt', ['1', '2', '3', '4', '5']))],
  [String.raw`([6-9]|10)`, apply(lookup('PA_DECIL_ALTO', 'pa-decil-alto.txt', ['6', '7', '8', '9', '10']))],
  [String.raw`(?i)(decil\s*)(\d{1,2})`, keep, apply(lookup('PA_DECIL', 'pa-decil.txt', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']))],
  [String.raw`(?i)(quintil\s*)([1-5])`, keep, apply('PA_QUINTIL')],
], apply(lookup('PA_POBREZA', 'pa-pobreza.txt', ['Pobreza extrema', 'Pobreza general', 'No pobre', 'Vulnerable'], undefined, 'PRESERVE_LOOKUP_FILE')), 'Pobreza extrema')
domain('PA_FIN_NIVEL_SOCIOECONOMICO', 'PA_NIVEL_SOCIOECONOMICO',
  byName(['nivel_?socioeconomico|nivel_?socio_?economico|estrato(_?socioeconomico)?|clase_?social|decil(_?(de_?)?ingresos?)?|quintil(_?(de_?)?ingresos?)?|pobreza(_?(extrema|general|multidimensional))?|indice_?(de_?)?pobreza|ipm|vulnerabilidad(_?(social|economica))?|carencias?|socioeconomic_?level|ficha_?socioeconomica', 0.9]),
  byList([['pa-detectar-pobreza.txt', ['pobreza extrema', 'pobreza general', 'pobre', 'no pobre', 'indigente', 'vulnerable', 'alto', 'medio', 'bajo', 'muy bajo'], 0.4]], { reject: 0.3 }))

// Housing tenure as the census asks for it.
const VIVIENDAS = ['Propia', 'Propia hipotecada', 'Alquilada', 'Cedida o prestada', 'Condena', 'Otra situación']
categorical('PA_VIVIENDA', 'pa-vivienda.txt', VIVIENDAS, 'Invasión')
domain('PA_FIN_VIVIENDA', 'PA_VIVIENDA',
  byName(['tenencia_?(de_?)?(la_?)?vivienda|tipo_?(de_?)?vivienda|situacion_?(de_?la_?)?vivienda|vivienda_?(propia|alquilada|prestada)|condicion_?(de_?)?(la_?)?vivienda|material_?(de_?)?(la_?)?vivienda|piso_?de_?tierra|hacinamiento|precarista|invasion|housing_?(type|tenure|status)', 0.95]),
  byList([['pa-detectar-vivienda.txt', [...VIVIENDAS, 'propia', 'hipotecada', 'alquilada', 'rentada', 'prestada', 'cedida', 'invasión', 'precarista', 'familiar'], 0.6]], { reject: 0.3 }))

// ── PENAL · Criminal records (art. 30) ──────────────────────────────────────

categorical('PA_ANTECEDENTES', 'pa-antecedentes.txt', ['Sin antecedentes penales', 'Con antecedentes penales', 'Sin información'], 'Condenado por hurto')
domain('PA_PENAL_ANTECEDENTES', 'PA_ANTECEDENTES',
  byName(['antecedentes(?!_?(medicos|patologicos|personales_?patologicos|heredofamiliares|gineco|obstetricos|familiares|clinicos|academicos|laborales|crediticios|comerciales|generales))(_?(penales|judiciales|policivos|policiales|criminales))?|record_?(policivo|policial|penal|criminal)|certificado_?(de_?)?antecedentes|sentencia(_?condenatoria)?|sentenciad[oa]|condena(do|da)?|delitos?|tipo_?(de_?)?delito|reincidente|reincidencia|imputad[oa]|privado_?de_?libertad|detencion_?provisional|medida_?cautelar|centro_?penitenciario|pena|reclusion|libertad_?condicional|criminal_?record|conviction|offen[cs]e|detenid[oa]|violencia_?domestica', 0.95]))

domain('PA_PENAL_CAUSA', 'PA_CM_ALFANUM',
  byName(['carpetilla|n(o|um|ro)_?carpetilla|carpeta_?(de_?)?investigacion|n(o|um|ro)_?carpeta|causa_?penal|n(o|um|ro|umero)_?(de_?)?causa|expediente_?(judicial|penal)|n(o|um|ro)_?expediente_?(judicial|penal)|n(o|um|ro)_?(de_?)?denuncia|folio_?denuncia|n(o|um|ro)_?proceso|case_?number', 0.9]),
  byPattern([
    [String.raw`\d{12,15}`, 0.4],
    [String.raw`\d{1,6}-\d{4}`, 0.5],
  ], { reject: 0.3 }))

// ── Preset ──────────────────────────────────────────────────────────────────

const referenced = JSON.stringify([domains, algorithms.map((x) => x.config)])
const orphans = algorithms.filter((a) => !referenced.includes(`"${a.name}"`))
if (orphans.length) throw new Error(`algorithms nobody uses: ${orphans.map((a) => a.name).join(', ')}`)

// The essential pack: identity documents, names, contact, address and birth date. Loading it brings
// these domains and only what they lean on; the extended pack is everything.
const ESSENTIAL = [
  'PA_L1_CEDULA', 'PA_L1_RUC', 'PA_L1_RUC_DV', 'PA_L1_PASAPORTE',
  'PA_L1_NOMBRE', 'PA_L1_APELLIDO', 'PA_L1_NOMBRE_COMPLETO', 'PA_L1_EMAIL', 'PA_L1_TELEFONO',
  'PA_L1_DIRECCION', 'PA_L1_DIRECCION_COMPLEMENTO', 'PA_L2_FECHA_NACIMIENTO',
]
const notDomains = ESSENTIAL.filter((name) => !domains.some((d) => d.name === name))
if (notDomains.length) throw new Error(`essential pack names domains the set does not have: ${notDomains.join(', ')}`)

const VERSION = 2
const preset = {
  version: VERSION,
  name: {
    en: 'Panama — Ley 81 de 2019 (personal data protection)',
    'pt-BR': 'Panamá — Ley 81 de 2019 (proteção de dados pessoais)',
    es: 'Panamá — Ley 81 de 2019 (protección de datos personales)',
  },
  summary: {
    en: 'Discovers and masks Panamanian personal data under Law 81 of 2019 and Executive Decree 285 of 2021: direct identifiers (cédula, RUC with a valid DV, names, contact, documents), quasi-identifiers (birth date, district, corregimiento), the sensitive data of article 4, economic and credit data, and criminal records.',
    'pt-BR': 'Descobre e mascara dados pessoais panamenhos segundo a Lei 81 de 2019 e o Decreto Executivo 285 de 2021: identificadores diretos (cédula, RUC com DV válido, nomes, contato, documentos), quase-identificadores (data de nascimento, distrito, corregimento), os dados sensíveis do artigo 4, dados econômicos e de crédito e antecedentes criminais.',
    es: 'Descubre y enmascara datos personales panameños conforme a la Ley 81 de 2019 y el Decreto Ejecutivo 285 de 2021: identificadores directos (cédula, RUC con DV válido, nombres, contacto, documentos), cuasi-identificadores (fecha de nacimiento, distrito, corregimiento), los datos sensibles del artículo 4, datos económicos y de crédito, y antecedentes penales.',
  },
  profileSet: {
    name: `PA - Ley 81 de 2019 - v${VERSION}`,
    description: 'Identificadores directos, cuasi-identificadores, datos sensibles (art. 4, 11), datos económicos y de crédito, y antecedentes penales, conforme a la Ley 81 de 2019 y el Decreto Ejecutivo 285 de 2021.',
    threshold: 60,
    classifiers: classifiers.map((c) => c.name),
  },
  packs: {
    essential: {
      description: 'Paquete esencial de la Ley 81 de 2019: cédula, RUC, pasaporte, nombres, contacto, dirección y fecha de nacimiento.',
      domains: ESSENTIAL,
    },
  },
  classifiers,
  domains,
  algorithms,
  files: [...files.keys()].sort(),
}

fs.rmSync(FILES, { recursive: true, force: true })
fs.mkdirSync(FILES, { recursive: true })
for (const [name, lines] of files) fs.writeFileSync(nodePath.join(FILES, name), `${lines.join('\n')}\n`)
fs.writeFileSync(nodePath.join(HERE, 'preset.json'), `${JSON.stringify(preset, null, 2)}\n`)

console.log(`${domains.length} domains, ${classifiers.length} classifiers, ${algorithms.length} algorithms, ${files.size} files`)
