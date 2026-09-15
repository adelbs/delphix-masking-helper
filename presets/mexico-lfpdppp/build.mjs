#!/usr/bin/env node
/**
 * Builds the Mexico (LFPDPPP 2025) pre-configured profile set: preset.json and files/.
 *
 *   node presets/mexico-lfpdppp/build.mjs
 *
 * source/ holds the hand-kept lists (given names, surnames, streets, colonias) and the 2,469
 * municipalities of the 2020 census. Everything in files/ and preset.json is generated from them and
 * from the definitions below — edit here, then build, then run verify.mjs.
 *
 * Structure of the set
 *   L1     direct identifiers      CURP, RFC, NSS, INE, names, contact, CLABE, documents, devices
 *   L2     quasi-identifiers       birth date, age, sex, municipality, colonia, postal code…
 *   L3     sensitive data (art. 2) ethnic origin, indigenous language, health, genetics, beliefs,
 *                                  political opinions, sexual preference
 *   FIN    financial and patrimonial data, which need express consent (art. 7)
 *   PENAL  criminal records
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

/**
 * A weighted check digit the plugin has no framework for: CURP and RFC weigh letters, which Check
 * Digit cannot do. The masked body arrives followed by a `0` placeholder, and the running sum
 * travels through it a few characters at a time, each step one lookup table:
 *   first step   c1 c2        → c1 c2 s
 *   next steps   s c3 c4      → c3 c4 s'
 *   last step    s cn cm 0    → cn cm d      (d, the check digit, takes the placeholder's place)
 * `chunks` lists the positions (0-based) each step reads and `alphabets` what each position can
 * hold, which keeps the tables small. Every table is a Data Cleansing file: exact, and needing no
 * key. The cost is one Regex Decompose and one hash lookup per step, for every value masked — so
 * fewer, larger steps are faster.
 */
function checksum(name, fileStem, { chunks, alphabets, contribution, modulus, symbol, checkDigit, init = 0 }) {
  const sums = [...Array(modulus).keys()]
  const combos = (positions) => positions.reduce((found, p) => found.flatMap((prefix) => alphabets[p].map((c) => prefix + c)), [''])
  const add = (s, positions, chars) => positions.reduce((total, p, i) => (total + contribution(p, [...chars][i])) % modulus, s)
  const steps = []
  let read = 0
  chunks.forEach((positions, k) => {
    const first = k === 0
    const last = k === chunks.length - 1
    const pairs = first
      ? combos(positions).map((chars) => [chars, `${chars}${symbol(add(init, positions, chars))}`])
      : sums.flatMap((s) => combos(positions).map((chars) => (last
        ? [`${symbol(s)}${chars}0`, `${chars}${checkDigit(add(s, positions, chars))}`]
        : [`${symbol(s)}${chars}`, `${chars}${symbol(add(s, positions, chars))}`])))
    const table = cleansing(`${name}_T${k + 1}`, `${fileStem}-${k + 1}.txt`, pairs)
    const width = positions.length + (first ? 0 : 1) + (last ? 1 : 0)
    steps.push(decompose(`${name}_P${k + 1}`, [[`(.{${read}})(.{${width}})(.*)`, keep, apply(table), keep]], keep))
    read += positions.length
  })
  return chain(name, steps)
}
const LETTERS_AZ = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']
const DIGITS = [...'0123456789']

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
  description: 'Nombre de la columna (y variantes usadas en sistemas mexicanos).',
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

const MUNICIPIOS = readLines('municipios.tsv').map((line) => {
  const [code, name, state, lat, lon, population] = line.split('\t')
  return { code, name, state, lat: Number(lat), lon: Number(lon), population: Number(population) || 0 }
})
if (MUNICIPIOS.length !== 2469) throw new Error(`expected the 2,469 municipalities of the 2020 census, found ${MUNICIPIOS.length}`)

// ── Shared algorithms ───────────────────────────────────────────────────────

// Vowels map to vowels and consonants to consonants, so a masked CURP, RFC or plate keeps its
// structure. Ñ and ñ are in no group: the RFC alphabet has Ñ, and the check digit tables must
// recognize every character a masked key can hold. Digits map exactly as a digits-only mapping
// would. minMaskedPositions 0 lets a placeholder such as "S/D" through instead of failing the row.
algorithm('MX_CM_ALFANUM', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'AEIOU', 'BCDFGHJKLMNPQRSTVWXYZ', 'aeiou', 'bcdfghjklmnpqrstvwxyz', 'ÁÉÍÓÚÜ', 'áéíóúü'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, 'HEGA850720')
// Hex letters form their own group, so a MAC, UUID or IPv6 stays valid hex.
algorithm('MX_CM_HEX', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'abcdef', 'ABCDEF', 'ghijklmnopqrstuvwxyz', 'GHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '3c:22:fb:9a:10:e4')
decompose('MX_REDACTAR', [['(.+)', { type: 'REDACT', redactCharacter: 'X' }]], keep, 'secreto123')
lookup('MX_SUPRIMIR', 'mx-sin-informacion.txt', ['Sin información'], 'Trastorno depresivo', 'PRESERVE_LOOKUP_FILE')

// Yes/no columns keep their vocabulary: a CHAR(1) S/N stays S/N.
decompose('MX_BANDERA', [
  [String.raw`(?i)(s[ií]|no)`, apply(lookup('MX_BANDERA_SI_NO', 'mx-bandera-si-no.txt', ['Sí', 'No']))],
  ['(?i)(true|false)', apply(lookup('MX_BANDERA_TRUE_FALSE', 'mx-bandera-true-false.txt', ['true', 'false']))],
  ['(?i)([sn])', apply(lookup('MX_BANDERA_S_N', 'mx-bandera-s-n.txt', ['S', 'N']))],
  ['(?i)(y)', apply(lookup('MX_BANDERA_Y_N', 'mx-bandera-y-n.txt', ['Y', 'N']))],
  ['([01])', apply(lookup('MX_BANDERA_0_1', 'mx-bandera-0-1.txt', ['0', '1']))],
], keep, 'S')

const FLAG = String.raw`(?i)(s[ií]|no|true|false|[sny01])`
/**
 * A categorical attribute: flags stay flags, numeric codes get other digits, and any other value
 * is replaced by one from `values` — or suppressed, when no list is given.
 */
function categorical(name, fileName, values, input) {
  const replacement = values ? lookup(`${name}_LISTA`, fileName, values) : 'MX_SUPRIMIR'
  return decompose(name, [[FLAG, apply('MX_BANDERA')], [String.raw`(\d{1,6})`, apply('MX_CM_ALFANUM')]], apply(replacement), input)
}
categorical('MX_CATEGORIA_SUPRIMIDA', null, null, 'Trastorno depresivo')

// ── Dates inside keys ───────────────────────────────────────────────────────
//
// CURP, RFC and the INE voter key carry the birth date as YYMMDD. The decade stays and the unit of
// the year is masked, as in a birth year column. Month and day go through Numeric Mapping, which is
// one-to-one within its range: days 1–28 among themselves, 29–30 among themselves, 31 stays with a
// 31-day month. The result is always a real date and two different dates never collide.

const MES = algorithm('MX_MES', 'characterMapping.NumericMapping', { minValue: 1, maxValue: 12 })
const DIA_28 = algorithm('MX_DIA_1_28', 'characterMapping.NumericMapping', { minValue: 1, maxValue: 28 })
const DIA_30 = algorithm('MX_DIA_29_30', 'characterMapping.NumericMapping', { minValue: 29, maxValue: 30 })
const MES_30 = lookup('MX_MES_30_DIAS', 'mx-meses-30-dias.txt', ['01', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'])
const MES_31 = lookup('MX_MES_31_DIAS', 'mx-meses-31-dias.txt', ['01', '03', '05', '07', '08', '10', '12'])
const CM = apply('MX_CM_ALFANUM')
decompose('MX_FECHA_AAMMDD', [
  [String.raw`(\d)(\d)(0[1-9]|1[0-2])(0[1-9]|1\d|2[0-8])`, keep, CM, apply(MES), apply(DIA_28)],
  [String.raw`(\d)(\d)(0[13-9]|1[0-2])(29|30)`, keep, CM, apply(MES_30), apply(DIA_30)],
  [String.raw`(\d)(\d)(0[13578]|1[02])(31)`, keep, CM, apply(MES_31), keep],
  [String.raw`(\d)(\d)(02)(29)`, keep, CM, keep, redactAs('28')],
], CM, '850720')

// ── L1 · CURP ───────────────────────────────────────────────────────────────
//
// Clave Única de Registro de Población: 4 letters from the names, birth date, sex, state of birth,
// 3 internal consonants, a differentiator (digit before 2000, letter after) and a check digit.
// The check digit weighs every character (0–9 → 0–9, A–N → 10–23, Ñ 24, O–Z → 25–36) by 18 down
// to 2, modulo 10. Masked: letters and consonants by Character Mapping, the date as above, sex and
// state by lookup, then the check digit recomputed.

const ENTIDADES_CURP = ['AS', 'BC', 'BS', 'CC', 'CL', 'CM', 'CS', 'CH', 'DF', 'DG', 'GT', 'GR', 'HG', 'JC', 'MC', 'MN', 'MS', 'NT', 'NL', 'OC', 'PL', 'QT', 'QR', 'SP', 'SL', 'SR', 'TC', 'TS', 'TL', 'VZ', 'YN', 'ZS', 'NE']
const SEXO_H_M = lookup('MX_SEXO_H_M', 'mx-sexo-h-m.txt', ['H', 'M'])
lookup('MX_ENTIDAD_CURP', 'mx-entidad-curp.txt', ENTIDADES_CURP, undefined, 'PRESERVE_LOOKUP_FILE')
const CURP_ALPHABET = [...'0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ']
decompose('MX_CURP_CUERPO', [
  [String.raw`([A-Z])([A-Z])([A-Z]{2})(\d{6})([HM])([A-Z]{2})([A-Z]{3})([0-9A-Z])(\d)`,
    CM, CM, CM, apply('MX_FECHA_AAMMDD'), apply(SEXO_H_M), apply('MX_ENTIDAD_CURP'), CM, CM, redactAs('0')],
  [String.raw`([A-Z])([A-Z])([A-Z]{2})(\d{6})(X)([A-Z]{2})([A-Z]{3})([0-9A-Z])(\d)`,
    CM, CM, CM, apply('MX_FECHA_AAMMDD'), keep, apply('MX_ENTIDAD_CURP'), CM, CM, redactAs('0')],
], keep)
// Eight steps, one String Algorithm Chain: letters, letters, the date two digits at a time, sex with
// the state, two consonants, and the last consonant with the differentiator and the check digit.
checksum('MX_CURP_DV', 'mx-curp-dv', {
  chunks: [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11, 12], [13, 14], [15, 16]],
  alphabets: [...Array(4).fill(LETTERS_AZ), ...Array(6).fill(DIGITS), [...'HMX'], ...Array(5).fill(LETTERS_AZ), [...DIGITS, ...LETTERS_AZ]],
  modulus: 10, symbol: String,
  contribution: (p, c) => CURP_ALPHABET.indexOf(c) * (18 - p),
  checkDigit: (s) => String((10 - s) % 10),
})
chain('MX_CURP_VALIDA', ['MX_CURP_CUERPO', 'MX_CURP_DV'])
decompose('MX_CURP', [
  [String.raw`([A-Z]{4}\d{6}[HMX][A-Z]{5}[0-9A-Z]\d)`, apply('MX_CURP_VALIDA')],
], CM, 'HEGA850720MDFRRL04')

domain('MX_L1_CURP', 'MX_CURP',
  byName(['curp[a-z0-9_]*|c_?u_?r_?p|clave_?unica(_?de_?registro)?(_?de_?poblacion)?|curp_?(cte|cliente|emp|empleado|trab|trabajador|pac|paciente|alumno|benef|beneficiario|titular|asegurado|afiliado|derechohabiente|receptor|usuario|persona)|(cte|cliente|emp|trab|pac|alumno|benef|titular|asegurado)_?curp', 0.9]),
  byType(STRING(18)),
  byPattern([
    [`[A-Z][AEIOUX][A-Z]{2}\\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\\d|3[01])[HMX](${ENTIDADES_CURP.join('|')})[B-DF-HJ-NP-TV-Z]{3}[0-9A-Z]\\d`, 1],
    [String.raw`[A-Z]{4}\d{6}[HMX][A-Z]{5}[0-9A-Z]\d`, 0.9],
  ], { reject: 0.2 }))

// ── L1 · RFC ────────────────────────────────────────────────────────────────
//
// Registro Federal de Contribuyentes: 13 characters for a person (4 letters, YYMMDD, 2-character
// differentiator, check digit), 12 for a company. The check digit is modulo 11 over the SAT table
// (0–9, A–N → 10–23, & 24, O–Z → 25–36, space 37, Ñ 38) with weights 13 down to 2; 10 is written A.
// A company RFC is weighed as if preceded by a space: it gets one ("_", worth 37) for the
// computation and loses it after. A person's RFC and CURP share the first ten characters, and
// mask them with the same algorithms, so they still agree after masking.

const RFC_TABLE = [...'0123456789ABCDEFGHIJKLMN&OPQRSTUVWXYZ Ñ']
const RFC_ALPHABET = [...RFC_TABLE.filter((c) => c !== ' '), '_']
const rfcValue = (c) => (c === '_' ? 37 : RFC_TABLE.indexOf(c))
decompose('MX_RFC_CUERPO_FISICA', [
  [String.raw`([A-ZÑ&])([A-ZÑ&])([A-ZÑ&]{2})(\d{6})([A-Z0-9]{2})([0-9A])`, CM, CM, CM, apply('MX_FECHA_AAMMDD'), CM, redactAs('0')],
], keep)
decompose('MX_RFC_CUERPO_MORAL', [
  [String.raw`([A-ZÑ&]{3})(\d{6})([A-Z0-9]{2})([0-9A])`, CM, apply('MX_FECHA_AAMMDD'), CM, redactAs('0')],
], keep)
decompose('MX_RFC_RELLENO', [[String.raw`(.)(.{11})`,
  apply(cleansing('MX_RFC_RELLENO_TABLA', 'mx-rfc-relleno.txt', RFC_ALPHABET.filter((c) => c !== '_').map((c) => [c, `_${c}`]))), keep]], keep)
decompose('MX_RFC_SIN_RELLENO', [[String.raw`(_)(.{12})`, drop, keep]], keep)
// Six steps: letters (the first may be the company padding), letters, the date two digits at a
// time, and the differentiator with the check digit.
const RFC_LETTERS = [...LETTERS_AZ, '&', 'Ñ']
checksum('MX_RFC_DV', 'mx-rfc-dv', {
  chunks: [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11]],
  alphabets: [[...RFC_LETTERS, '_'], ...Array(3).fill(RFC_LETTERS), ...Array(6).fill(DIGITS), ...Array(2).fill([...DIGITS, ...LETTERS_AZ])],
  modulus: 11, symbol: (s) => '0123456789A'[s],
  contribution: (p, c) => rfcValue(c) * (13 - p),
  checkDigit: (s) => (s === 0 ? '0' : s === 1 ? 'A' : String(11 - s)),
})
chain('MX_RFC_FISICA', ['MX_RFC_CUERPO_FISICA', 'MX_RFC_DV'])
chain('MX_RFC_MORAL', ['MX_RFC_CUERPO_MORAL', 'MX_RFC_RELLENO', 'MX_RFC_DV', 'MX_RFC_SIN_RELLENO'])
decompose('MX_RFC', [
  [String.raw`([A-ZÑ&]{4}\d{6}[A-Z0-9]{2}[0-9A])`, apply('MX_RFC_FISICA')],
  [String.raw`([A-ZÑ&]{3}\d{6}[A-Z0-9]{2}[0-9A])`, apply('MX_RFC_MORAL')],
  // Without the differentiator (old records): letters and date only.
  [String.raw`([A-ZÑ&])([A-ZÑ&])([A-ZÑ&]{2})(\d{6})`, CM, CM, CM, apply('MX_FECHA_AAMMDD')],
], CM, 'HEGA850720ABA')

domain('MX_L1_RFC', 'MX_RFC',
  byName(['rfc[a-z0-9_]*|r_?f_?c|registro_?federal(_?de)?(_?contribuyentes)?|rfc_?(cte|cliente|emp|empleado|trab|trabajador|prov|proveedor|receptor|emisor|titular|contribuyente|persona|pf|fisica)|(cte|cliente|emp|trab|prov|receptor|emisor|titular)_?rfc|tax_?id|id_?fiscal', 0.9]),
  byType(STRING(10)),
  byPattern([
    [String.raw`[A-ZÑ&]{4}\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])[A-Z0-9]{2}[0-9A]`, 1],
    [String.raw`[A-ZÑ&]{3}\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])[A-Z0-9]{2}[0-9A]`, 0.9],
    [String.raw`[A-ZÑ&]{4}\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])`, 0.6],
  ], { reject: 0.2 }))

// ── L1 · NSS (IMSS) ─────────────────────────────────────────────────────────
//
// Número de Seguridad Social: 11 digits (subdelegation, registration year, birth year, sequence and
// a check digit). The check digit is Luhn — the same check as a payment card — so Payment Card masks
// it and keeps it valid, one-to-one. Payment Card fails a row with no digits: only 11-digit values
// reach it.

algorithm('MX_NSS_LUHN', 'characterMapping.PaymentCard', { preserve: 0 })
decompose('MX_NSS', [
  [String.raw`(\d{11})`, apply('MX_NSS_LUHN')],
], CM, '12345678903')

domain('MX_L1_NSS', 'MX_NSS',
  byName(['nss[a-z0-9_]*|n_?s_?s|num(ero)?_?(de_?)?seguro_?social|n(o|um|ro)_?(seg|seguro)_?soc(ial)?|num(ero)?_?(de_?)?seguridad_?social|numero_?imss|n(o|um|ro)_?imss|imss_?(num|nss|no)|afiliacion_?imss|nss_?(trab|trabajador|emp|empleado|asegurado|derechohabiente)', 0.9]),
  byType(STRING(11, 13), NUMBER(10, 11)),
  byPattern([[String.raw`\d{11}`, 0.7, { checksum: 'LUHN' }], [String.raw`\d{2}-?\d{2}-?\d{2}-?\d{4}-?\d`, 0.4]], { reject: 0.3 }))

// ── L1 · INE ────────────────────────────────────────────────────────────────

const ENTIDADES_NUM = Array.from({ length: 32 }, (_, i) => String(i + 1).padStart(2, '0'))
lookup('MX_ENTIDAD_NUMERO', 'mx-entidad-numero.txt', ENTIDADES_NUM)
decompose('MX_CLAVE_ELECTOR', [
  // Consonants of the names, birth date, state, sex and a 3-digit differentiator.
  [String.raw`([A-Z]{6})(\d{6})(\d{2})([HM])(\d{3})`, CM, apply('MX_FECHA_AAMMDD'), apply('MX_ENTIDAD_NUMERO'), apply(SEXO_H_M), CM],
], CM, 'GRHRAL85072009M100')
domain('MX_L1_CLAVE_ELECTOR', 'MX_CLAVE_ELECTOR',
  byName(['clave_?(de_?)?elector|cve_?elector|clave_?electoral|clave_?ine|clave_?ife|elector_?(clave|key)|voter_?key', 0.9]),
  byType(STRING(18)),
  byPattern([[String.raw`[A-Z]{6}\d{8}[HM]\d{3}`, 1]], { reject: 0.2 }))

domain('MX_L1_CREDENCIAL_INE', 'MX_CM_ALFANUM',
  byName(
    ['ocr(_?(ine|ife|credencial))?|cic(_?(ine|ife|credencial))?|id_?ciudadano|identificador_?ciudadano|folio_?(ine|ife|credencial|credencial_?elector)|n(o|um|ro)_?(credencial_?(de_?)?elector|ine|ife)|num(ero)?_?(de_?)?(ine|ife)|credencial_?(ine|ife|elector|para_?votar)|ine|ife|numero_?vertical|num_?emision', 0.85],
    ['credencial|identificacion_?oficial|n(o|um|ro)_?identificacion', 0.55],
  ),
  byPattern([[String.raw`\d{13}`, 0.3], [String.raw`\d{9}`, 0.2]], { reject: 0.3 }))

// ── L1 · Names ──────────────────────────────────────────────────────────────

const NOT_A_PERSON = 'producto|prod|articulo|art|item|empresa|emp|compania|razon|comercial|fantasia|archivo|arch|file|calle|via|colonia|col|municipio|mpio|mun|alcaldia|delegacion|localidad|estado|edo|entidad|region|ciudad|pais|banco|sucursal|plaza|plan|campana|proyecto|servicio|equipo|tabla|columna|campo|usuario|user|host|servidor|dominio|marca|modelo|categoria|tipo|colegio|escuela|plantel|establecimiento|institucion|afore|curso|carrera|materia|documento|doc|centro|unidad|umf|clinica|hospital|area|depto|departamento|puesto|sistema|app|aplicacion|grupo|lista|reporte|informe|proceso|evento|tarea|perfil|rol|clase|objeto|cuenta|medicamento|farmaco|diagnostico|estudio|programa|beneficio|partido|sindicato|religion|etnia|pueblo|lengua|lugar|local|tienda|almacen|bodega|proveedor|prov|convenio|contrato|poliza|seguro|aseguradora|org|organizacion|dependencia|entidad|parametro|variable|metodo|funcion|indice|job|script|cola|recurso|red|dispositivo|plantilla|template|imagen|foto|pagina|sitio|modulo|menu|opcion|accion|permiso|regimen|concepto|impuesto|moneda|emisor|comprobante|cfdi|uso|pago|forma|metodo|zona|ruta|linea|giro|actividad|rama|sector'
const PERSON_ROLE = 'cliente|cte|cli|paciente|pac|trabajador|trab|empleado|colaborador|alumno|estudiante|afiliado|asegurado|derechohabiente|beneficiario|benef|titular|madre|padre|tutor|conyuge|pareja|medico|doctor|profesional|responsable|contacto|emergencia|aval|obligado|coacreditado|deudor|acreditado|remitente|destinatario|receptor|firmante|testigo|representante|apoderado|propietario|arrendatario|contratante|victima|denunciante|imputado|socio|donante|heredero|persona|pers|conductor|chofer|vendedor|ejecutivo|agente|solicitante|usuario_?final|ciudadano|elector|votante|contribuyente|jefe_?(de_?)?familia|hijo|hija|familiar|dependiente'

decompose('MX_NOMBRES', [
  [String.raw`(\S+)`, apply('MX_NOMBRE_PILA')],
  [String.raw`(\S+)\s+(\S+)`, apply('MX_NOMBRE_PILA'), apply('MX_NOMBRE_PILA')],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, apply('MX_NOMBRE_PILA'), apply('MX_NOMBRE_PILA'), apply('MX_NOMBRE_PILA')],
], CM, 'María Guadalupe')
algorithm('MX_NOMBRE_PILA', 'name.Name', {
  lookupFile: { uri: file('mx-nombres.txt', NOMBRES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Guadalupe')
decompose('MX_APELLIDOS', [
  [String.raw`(\S+)`, apply('MX_APELLIDO')],
  [String.raw`(\S+)\s+(\S+)`, apply('MX_APELLIDO'), apply('MX_APELLIDO')],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, apply('MX_APELLIDO'), apply('MX_APELLIDO'), apply('MX_APELLIDO')],
], CM, 'Hernández López')
algorithm('MX_APELLIDO', 'name.Name', {
  lookupFile: { uri: file('mx-apellidos.txt', APELLIDOS) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Hernández')
// Mexican convention: given name(s), then paternal and maternal surname.
const N = apply('MX_NOMBRE_PILA')
const A = apply('MX_APELLIDO')
decompose('MX_NOMBRE_COMPLETO', [
  [String.raw`([^,]+),\s*(.+)`, apply('MX_APELLIDOS'), apply('MX_NOMBRES')],
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, A],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, A, A],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, A, A],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, N, A, A],
], CM, 'María Guadalupe Hernández López')

domain('MX_L1_NOMBRE', 'MX_NOMBRES',
  byName(
    [`primer_?nombre|segundo_?nombre|nombres?_?(de_?)?pila|nombre_?social|first_?name|given_?names?|fname|name_?first|middle_?name|nombre[12]|nombres(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completos?|y_?apellidos?|apellidos?))|nom_?(pila|trab|emp)`, 0.85],
    [`nombre(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|compl|full|y_?apellidos?|apellidos?))|nomb?(?!_?(${NOT_A_PERSON}|completo))|name(?!_?(${NOT_A_PERSON}))`, 0.5],
  ),
  byList([['mx-detectar-nombres.txt', NOMBRES, 0.7]], { tokenize: true, reject: 0.3 }))

domain('MX_L1_APELLIDO', 'MX_APELLIDOS',
  byName(['apellidos?|apellido_?(paterno|materno|pat|mat|uno|dos|[12])|ape_?(pat|mat|paterno|materno|[12])|apepat|apemat|appat|apmat|ap_?(pat|mat|paterno|materno)|a_?paterno|a_?materno|paterno|materno|primer_?apellido|segundo_?apellido|last_?name|surname|lname|family_?name|second_?last_?name|mother_?last_?name', 0.85]),
  byList([['mx-detectar-apellidos.txt', APELLIDOS, 0.7]], { tokenize: true, reject: 0.3 }))

domain('MX_L1_NOMBRE_COMPLETO', 'MX_NOMBRE_COMPLETO',
  byName(
    [`nombre_?(completo|compl|full)|nombres?_?y_?apellidos?|nombres?_?apellidos?|nombreapellido|nom_?completo|nomcompleto|nombrecompleto|full_?name|fullname|person_?name|customer_?name|employee_?name|patient_?name|nombre_?(${PERSON_ROLE})|nombre_?razon_?social_?receptor`, 0.9],
    ['titular|beneficiario|contacto_?emergencia|conyuge|tutor_?legal|representante_?legal|apoderado_?legal|paciente|victima|asegurado|contratante|derechohabiente|acreditado|obligado_?solidario|aval', 0.6],
    // A bare NOMBRE holds a given name or a full name: the values decide between the two domains.
    [`nombre(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|compl|full|y_?apellidos?|apellidos?))|name(?!_?(${NOT_A_PERSON}))`, 0.5],
  ),
  byList([['mx-detectar-nombres.txt', NOMBRES, 0.6], ['mx-detectar-apellidos.txt', APELLIDOS, 0.6]], { tokenize: true, reject: 0.3 }))

// ── L1 · Contact ────────────────────────────────────────────────────────────

decompose('MX_EMAIL', [
  // The top-level domain becomes .test, reserved for tests: a masked address can never deliver.
  [String.raw`([^@\s]+)@([^@\s]+)\.([A-Za-z]{2,24})`, CM, CM, redactAs('test')],
], CM, 'guadalupe.hernandez@gmail.com')
domain('MX_L1_EMAIL', 'MX_EMAIL',
  byName(['e_?mail[a-z0-9_]*|mail[a-z0-9_]*|correo(_?electronico)?[a-z0-9_]*|email_?address|correo_?(personal|laboral|contacto|receptor|cliente)', 0.85]),
  byType(STRING(5)),
  byPattern([[String.raw`[A-Za-z0-9._%+'\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}`, 1]], { reject: 0.2 }))

// Since 2019 every Mexican number has 10 digits: a 2-digit area code for Mexico City, Guadalajara
// and Monterrey (55, 56, 33, 81), 3 digits elsewhere. +52, the old mobile 1 and the area code stay.
const phoneActions = [keep, keep, keep, CM, keep, CM]
decompose('MX_TELEFONO', [
  [String.raw`(\+?52[\s\-]?)?(1[\s\-]?)?(\(?(?:55|56|33|81)\)?[\s\-]?)(\d{4})([\s\-]?)(\d{4})`, ...phoneActions],
  [String.raw`(\+?52[\s\-]?)?(1[\s\-]?)?(\(?[2-9]\d{2}\)?[\s\-]?)(\d{3})([\s\-]?)(\d{4})`, ...phoneActions],
], CM, '+52 55 1234 5678')
domain('MX_L1_TELEFONO', 'MX_TELEFONO',
  byName(['tel|telefono[a-z0-9_]*|tel[eé]fono|tel_?(cel|casa|particular|oficina|trabajo|movil|contacto|fijo|recados)|celular[a-z0-9_]*|cel|movil|m[oó]vil|whatsapp|wa|fax|phone[a-z0-9_]*|mobile|cellphone|n(o|um|ro)_?tel(efono)?|telef|tlf|lada|extension', 0.85]),
  byPattern([
    [String.raw`(\+?52[\s\-]?)?(1[\s\-]?)?\(?(55|56|33|81)\)?[\s\-]?\d{4}[\s\-]?\d{4}`, 0.9],
    [String.raw`(\+?52[\s\-]?)?(1[\s\-]?)?\(?[2-9]\d{2}\)?[\s\-]?\d{3}[\s\-]?\d{4}`, 0.8],
    [String.raw`\+?\d[\d\s()\-]{7,15}`, 0.3],
  ], { reject: 0.3 }))

lookup('MX_DIRECCION', 'mx-direcciones.txt', (() => {
  const random = seeded(2025)
  const streets = readLines('calles.txt')
  const out = new Set()
  while (out.size < 3000) {
    let street = streets[Math.floor(random() * streets.length)]
    if (street.startsWith('Calle ') && random() < 0.5) street = street.slice(6)
    const r = random()
    if (r < 0.1) {
      out.add(`${street} Mz. ${1 + Math.floor(random() * 60)} Lt. ${1 + Math.floor(random() * 40)}`)
      continue
    }
    const number = Math.floor(random() < 0.7 ? 1 + random() * 999 : 1000 + random() * 8999)
    const inner = random() < 0.2 ? ` Int. ${1 + Math.floor(random() * 30)}` : random() < 0.06 ? ` Depto. ${'ABCDEF'[Math.floor(random() * 6)]}${1 + Math.floor(random() * 9)}` : ''
    out.add(`${street} ${number}${inner}`)
  }
  return [...out]
})(), 'Av. Insurgentes Sur 1602 Int. 4', 'PRESERVE_LOOKUP_FILE')
domain('MX_L1_DIRECCION', 'MX_DIRECCION',
  byName(['direccion(?!_?(ip|mac|web|url|correo|mail|electronica|email))[a-z_]*|direcci[oó]n|dir|domicilio(?!_?fiscal)[a-z_]*|calle(_?y_?numero)?|avenida|(?<!(mac|ip|e_?mail|web|url)_?)address|street|(?<!(mac|ip|e_?mail|web|url)_?)addr|dir_?(particular|comercial|laboral|envio|entrega|facturacion|cliente|paciente|trabajo)|entre_?calles|y_?calle|residencia|lugar_?(de_?)?residencia|home_?address', 0.8]),
  byType(STRING(6)),
  byPattern([
    [String.raw`(?i)(av(enida)?\.?|calle|c\.|privada|priv\.?|andador|cerrada|calzada|calz\.?|blvd\.?|boulevard|bulevar|prolongaci[oó]n|prol\.?|carretera|camino|circuito|retorno)\s+.+\d+.*`, 0.8],
    [String.raw`[A-Za-zÁÉÍÓÚÑáéíóúñ'.\s]{4,}\s(#|no\.?\s?)?\d{1,5}(\s*(int|interior|depto|dpto|local)\.?\s*\w+)?`, 0.4],
    [String.raw`(?i).+\s(mz|mza|manzana)\.?\s*\d+\s*(lt|lte|lote)\.?\s*\d+`, 0.7],
  ], { reject: 0.2 }))

domain('MX_L1_DIRECCION_COMPLEMENTO', 'MX_CM_ALFANUM',
  byName(['n(o|um|ro|umero)_?(ext|exterior|int|interior)|num_?ext|num_?int|no_?ext|no_?int|numext|numint|exterior|interior|depto|dpto|manzana|mza|mz|lote|lt|lte|edificio|torre|casa_?(num|no|numero)|house_?number|apartment|apt|unit_?number', 0.7]))

// ── L1 · Banking ────────────────────────────────────────────────────────────

// CLABE: 3-digit bank, 3-digit plaza, 11-digit account, check digit with weights 3 7 1, modulo 10 —
// something the Check Digit framework does natively. The bank code stays, so reports by bank still
// add up; the rest is masked and the check digit recomputed.
decompose('MX_CLABE_CUERPO', [[String.raw`(\d{3})(\d{14})`, keep, CM]], keep)
algorithm('MX_CLABE_VALIDA', 'checkdigit.Checkdigit', {
  weightList: Array.from({ length: 17 }, (_, i) => [3, 7, 1][i % 3]), modulusNumber: 10, checkDigitIndex: 17,
  calculateChecksumRightToLeft: false, numDigitsForCheckdigitCalculation: 17,
  numericAlgorithm: use('MX_CLABE_CUERPO'),
  inputHandlingConfig: { characterHandling: 'STANDARD', invalidInputHandling: 'ERROR', shortInputHandling: 'FALLBACK', padCharacter: '0', trimWhitespace: true },
})
decompose('MX_CLABE', [[String.raw`(\d{18})`, apply('MX_CLABE_VALIDA')]], CM, '002180700545678911')
domain('MX_L1_CLABE', 'MX_CLABE',
  byName(['clabe[a-z0-9_]*|cta_?clabe|cuenta_?clabe|clabe_?interbancaria|clave_?bancaria_?estandarizada|cuenta_?interbancaria|clabe_?(deposito|pago|cliente|beneficiario|trab|nomina)', 0.9]),
  byType(STRING(18), NUMBER(18)),
  byPattern([[String.raw`\d{18}`, 0.7]], { reject: 0.3 }))

domain('MX_L1_CUENTA_BANCARIA', 'MX_CM_ALFANUM',
  byName(['cuenta_?(bancaria|banco|cheques|ahorro|deposito|abono|pago|destino|origen|nomina|debito|inversion)|cta_?(bancaria|banco|cheques|ahorro|nomina)|n(o|um|ro|umero)?_?(de_?)?cuenta(_?(banco|bancaria|cheques|nomina))?|account_?(number|no|num|nbr)|bank_?account|num_?cta|no_?cta', 0.85]))

// Payment Card fails a row that has no digits to mask; only values shaped like a card reach it.
algorithm('MX_TARJETA_LUHN', 'characterMapping.PaymentCard', { minMaskedPositions: 6, preserve: 0 })
decompose('MX_TARJETA', [[String.raw`(\d[\d\s\-]{11,22}\d)`, apply('MX_TARJETA_LUHN')]], keep, '4152 3131 2345 6780')
domain('MX_L1_TARJETA', 'MX_TARJETA',
  byName(['tarjeta(_?(credito|debito|cred|deb|num|no|numero|bancaria))?|n(o|um|ro|umero)_?tarjeta|pan|card_?(number|no|num)|credit_?card|cc_?(number|num)|tdc|tdd|num_?tdc|plastico', 0.85]),
  // 0.9, not 1: an IMEI is 15 Luhn-valid digits too, and its own column name should win.
  byPattern([[String.raw`\d{13,19}`, 0.9, { checksum: 'LUHN', clean: String.raw`[\s\-]` }]], { reject: 0.3 }))

// ── L1 · Other documents ────────────────────────────────────────────────────

domain('MX_L1_PASAPORTE', 'MX_CM_ALFANUM',
  byName(['pasaporte[a-z_]*|passport[a-z_]*|n(o|um|ro|umero)_?pasaporte|pasap', 0.85]),
  byPattern([[String.raw`[A-Z]\d{8}`, 0.3]], { reject: 0.3 }))

domain('MX_L1_DOCUMENTO_MIGRATORIO', 'MX_CM_ALFANUM',
  byName(['tarjeta_?(de_?)?residente|residente_?(temporal|permanente)|documento_?migratorio|doc_?migratorio|forma_?migratoria|fm_?[23]|fmm|n(o|um|ro)_?(documento_?)?migratorio|id_?extranjero|documento_?extranjero|identificacion_?extranjera|dni|visa|n(o|um|ro)_?visa|national_?id', 0.8]))

domain('MX_L1_CEDULA_PROFESIONAL', 'MX_CM_ALFANUM',
  byName(['cedula_?profesional|ced_?prof|cedula_?(prof|medica|especialidad)|n(o|um|ro)_?cedula|cedula', 0.85]),
  byPattern([[String.raw`\d{7,8}`, 0.3]], { reject: 0.3 }))

domain('MX_L1_LICENCIA_CONDUCIR', 'MX_CM_ALFANUM',
  byName(['licencia_?(de_?)?(conducir|manejo|chofer|automovilista|motociclista|federal)|n(o|um|ro)_?licencia|licencia|driver_?license|drivers_?license', 0.8]))

domain('MX_L1_EFIRMA', 'MX_CM_ALFANUM',
  byName(['e_?firma|efirma|fiel|firma_?electronica(_?avanzada)?|n(o|um|ro)_?certificado(_?(sat|fiel|efirma|csd))?|certificado_?(sat|fiel|efirma|digital)|no_?certificado|serial_?certificado|csd', 0.85]),
  byPattern([[String.raw`0000[0-9]{16}`, 0.8]], { reject: 0.3 }))

// ── L1 · Network, devices, vehicles ─────────────────────────────────────────

algorithm('MX_OCTETO', 'characterMapping.NumericMapping', { minValue: 1, maxValue: 254 })
decompose('MX_IP', [
  [String.raw`(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})`, apply('MX_OCTETO'), apply('MX_OCTETO'), apply('MX_OCTETO'), apply('MX_OCTETO')],
], apply('MX_CM_HEX'), '189.203.4.10')
domain('MX_L1_IP', 'MX_IP',
  byName(['ip|ip_?(address|addr|origen|destino|cliente|usuario|remota|publica|privada|acceso|conexion|login)|direccion_?ip|dir_?ip|ipv[46]|remote_?addr|client_?ip|host_?ip', 0.85]),
  byPattern([
    [String.raw`((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)`, 1],
    [String.raw`[0-9A-Fa-f]{1,4}(:[0-9A-Fa-f]{0,4}){2,7}`, 0.9],
  ], { reject: 0.3 }))

domain('MX_L1_DISPOSITIVO', 'MX_CM_HEX',
  byName(['imei|imsi|iccid|mac|mac_?address|direccion_?mac|device_?id|id_?dispositivo|dispositivo_?id|uuid_?dispositivo|advertising_?id|idfa|gaid|cookie(_?id)?|session_?id|id_?sesion|serie_?equipo|n(o|um|ro)_?serie_?(equipo|celular|telefono)', 0.8]),
  byPattern([
    [String.raw`([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}`, 1],
    [String.raw`\d{15}`, 0.8, { checksum: 'LUHN' }],
  ], { reject: 0.3 }))

// Plates never use I, O or Q; letters map among the others, so a masked plate is still valid.
const PLATE_LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ'
algorithm('MX_PLACA', 'characterMapping.CharacterMapping', {
  characterGroups: [PLATE_LETTERS, PLATE_LETTERS.toLowerCase(), '0123456789'],
  caseSensitive: true,
}, 'URU-197-A')
domain('MX_L1_PLACA', 'MX_PLACA',
  byName(['placas?(_?(vehiculo|auto|circulacion|vehicular|num|no|numero))?|n(o|um|ro)_?placas?|matricula(_?(vehiculo|auto|vehicular))?|license_?plate|plate(_?number)?|tarjeta_?(de_?)?circulacion', 0.85]),
  byPattern([
    [`[${PLATE_LETTERS}]{3}[\\s\\-]?\\d{3}[\\s\\-]?[${PLATE_LETTERS}]`, 1],
    [`[${PLATE_LETTERS}][\\s\\-]?\\d{2}[\\s\\-]?[${PLATE_LETTERS}]{3}`, 0.8],
    [`[${PLATE_LETTERS}]{3}[\\s\\-]?\\d{2}[\\s\\-]?\\d{2}`, 0.8],
    [`\\d{3}[\\s\\-]?[${PLATE_LETTERS}]{3}`, 0.6],
  ], { reject: 0.3 }))

domain('MX_L1_NIV', 'MX_CM_ALFANUM',
  byName(['niv|vin|n(o|um|ro|umero)_?(de_?)?(serie|identificacion)_?(vehicular|vehiculo)|serie_?vehicul(o|ar)|n(o|um|ro)_?serie|numero_?serie|n(o|um|ro)_?motor|chasis|repuve|folio_?repuve|constancia_?repuve|vin_?number', 0.8]),
  byPattern([[String.raw`[A-HJ-NPR-Z0-9]{17}`, 0.7]], { reject: 0.3 }))

domain('MX_L1_NUMERO_CONTRATO', 'MX_CM_ALFANUM',
  byName(['contrato|n(o|um|ro|umero)_?contrato|p[oó]liza|n(o|um|ro|umero)_?poliza|n(o|um|ro)_?(de_?)?credito(_?(infonavit|fovissste))?|credito_?(infonavit|fovissste)|n(o|um|ro)_?operacion|n(o|um|ro|umero)_?(de_?)?socio|n(o|um|ro|umero)_?(de_?)?cliente|id_?cliente|cve_?cliente|clave_?cliente|n(o|um|ro|umero)_?(de_?)?empleado|num_?emp|no_?emp|n(o|um|ro)_?nomina|n(o|um|ro)_?afiliado|n(o|um|ro)_?siniestro|n(o|um|ro)_?(de_?)?matricula|matricula_?(alumno|estudiante)|n(o|um|ro)_?expediente_?(cliente|laboral|personal)|folio_?(contrato|poliza|credito|cliente)', 0.7]))

domain('MX_L1_USUARIO_RRSS', 'MX_CM_ALFANUM',
  byName(['usuario|username|user_?name|login|nick(name)?|alias|cuenta_?usuario|usr|facebook|instagram|twitter|tiktok|linkedin|red_?social|perfil_?(facebook|instagram|twitter|linkedin|tiktok)|telegram|handle', 0.7]))

domain('MX_L1_CREDENCIAL', 'MX_REDACTAR',
  byName(['password|passwd|pwd|pass|contrasen[aã]|contraseña|clave(?!_?(producto|prod|serv|prodserv|articulo|sucursal|interna|tipo|registro|primaria|foranea|elector|electoral|unica|bancaria|interbancaria|municipio|mun|entidad|ent|localidad|loc|escuela|centro|cct|clues|sat|producto|servicio|unidad|plaza|banco|pais|moneda|regimen|uso|cfdi|postal|lada|zona|ageb|area))[a-z_]*|pin|nip|ciec|contrasena_?(sat|efirma|fiel)|hash_?password|password_?hash|secret|token_?acceso|access_?token|refresh_?token|api_?key|otp|respuesta_?secreta|pregunta_?secreta', 0.9]))

decompose('MX_COORDENADA', [
  // The integer part and first decimal stay (about 11 km): the place is generalized, not moved.
  [String.raw`(-?\d{1,3}\.\d)(\d+)\s*,\s*(-?\d{1,3}\.\d)(\d+)`, keep, CM, keep, CM],
  [String.raw`(-?\d{1,3}\.\d)(\d+)`, keep, CM],
], keep, '19.432608')
domain('MX_L1_GEOLOCALIZACION', 'MX_COORDENADA',
  byName(
    ['lat|latitud|latitude|lon|lng|longitude|coordenadas?|coord_?[xy]|geo_?(lat|lon|lng|loc|localizacion|posicion)|geolocalizacion|ubicacion_?gps|gps|posicion_?gps', 0.85],
    ['longitud|long', 0.5],
  ),
  byPattern([
    [String.raw`(1[4-9]|2\d|3[0-3])\.\d{3,}\s*,\s*-(8[6-9]|9\d|1[01]\d)\.\d{3,}`, 0.9],
    [String.raw`(1[4-9]|2\d|3[0-3])\.\d{3,}`, 0.6],
    [String.raw`-(8[6-9]|9\d|1[01]\d)\.\d{3,}`, 0.7],
  ], { reject: 0.3 }))

// ── L1 · Free text ──────────────────────────────────────────────────────────

algorithm('MX_TEXTO_LIBRE', 'freeTextRedaction.FreeTextRedaction', {
  regularExpressions: [
    String.raw`[A-Z]{4}\d{6}[HMX][A-Z]{5}[0-9A-Z]\d`,
    String.raw`[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{2}[0-9A]`,
    String.raw`[A-Z]{6}\d{8}[HM]\d{3}`,
    String.raw`[\w.+\-]+@[\w\-]+(\.[\w\-]+)+`,
    String.raw`(?<!\d)(\+?52)?1?\d{10}(?!\d)`,
    String.raw`(?<!\d)\d{11}(?!\d)`,
    String.raw`(?<!\d)\d{13,19}(?!\d)`,
    String.raw`(?<![A-Za-z])[A-HJ-NPR-Z]{3}-?\d{3}-?[A-HJ-NPR-Z](?![A-Za-z])`,
    String.raw`(?<!\d)(\d{1,3}\.){3}\d{1,3}(?!\d)`,
  ].map((patternString) => ({ patternString })),
  regExRedactValue: '[DATO]',
  lookupFile: { uri: file('mx-texto-nombres.txt', unique([...NOMBRES, ...APELLIDOS].flatMap((v) => [v, v.toUpperCase(), fold(v), fold(v).toUpperCase()]))) },
  lookupFileRedactValue: '[NOMBRE]',
  isDenyList: true,
}, 'Cliente Hernández, CURP HEGA850720MDFRRL04, correo g.hernandez@gmail.com')

domain('MX_L1_TEXTO_LIBRE', 'MX_TEXTO_LIBRE',
  byName(['observaciones?|obs|comentarios?|notas?|detalle|descripcion_?(caso|queja|reclamo|incidente|solicitud|problema|atencion|hechos)|texto_?libre|mensaje|queja|reclamo|referencias?(_?domicilio)?|motivo_?(texto|detalle)|narrativa|relato|resumen_?caso|remarks|comments?|notes?|free_?text|memo|bitacora', 0.6]),
  byType(STRING(30)),
  byPattern([
    [String.raw`[A-Z]{4}\d{6}[HMX][A-Z]{5}[0-9A-Z]\d`, 0.7],
    [String.raw`[\w.+\-]+@[\w\-]+\.[A-Za-z]{2,}`, 0.7],
    [String.raw`[A-ZÑ&]{4}\d{6}[A-Z0-9]{3}`, 0.6],
    [String.raw`(\+?52\s?)?\d{2,3}\s?\d{3,4}\s?\d{4}`, 0.5],
  ], { reject: 0, partial: true }))

// ── L2 · Quasi-identifiers ──────────────────────────────────────────────────

// Small shifts: large enough to break the link to the person, small enough that ages, school years
// and the 18th birthday move for few people. Dates that combine with the birth date move less.
algorithm('MX_FECHA_NACIMIENTO', 'dateAlgorithms.DateShift', { minRange: -60, maxRange: 60, unit: 'DAYS', roll: false }, '1985-07-20')
algorithm('MX_FECHA_EVENTO', 'dateAlgorithms.DateShift', { minRange: -30, maxRange: 30, unit: 'DAYS', roll: false }, '2021-03-15')

domain('MX_L2_FECHA_NACIMIENTO', 'MX_FECHA_NACIMIENTO',
  byName(['fecha_?(de_?)?nac(imiento)?|fec_?nac(imiento)?|fch_?nac|f_?nac(imiento|im)?|fnac|fechanac(imiento)?|fecnac|nacimiento|dob|birth_?date|date_?of_?birth|birthdate|birthday|cumplea(n|ñ)os', 0.9]),
  byType(...DATES, STRING(6)))

// The decade stays and the unit is masked — with the same mapping as the year inside a CURP.
decompose('MX_ANIO', [[String.raw`(\d{3})(\d)`, keep, CM]], keep, '1985')
domain('MX_L2_ANIO_NACIMIENTO', 'MX_ANIO',
  byName(['an(i)?o_?(de_?)?nac(imiento)?|año_?(de_?)?nac(imiento)?|birth_?year|year_?of_?birth|ano_?nacim', 0.9]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// 37 becomes 3x. From 100 on, 90.
decompose('MX_EDAD', [
  [String.raw`(\d{3,})`, redactAs('90')],
  [String.raw`([1-9])(\d)(\.\d+)`, keep, CM, keep],
  [String.raw`([1-9])(\d)`, keep, CM],
  [String.raw`(\d)`, CM],
], keep, '37')
domain('MX_L2_EDAD', 'MX_EDAD',
  byName(['edad(_?(actual|paciente|cliente|afiliado|asegurado|derechohabiente|beneficiario|ingreso|anos|años|cumplida))?|age|anos_?cumplidos|rango_?(de_?)?edad|grupo_?(de_?)?edad|edad_?en_?anos', 0.85]),
  byType(NUMBER(0, 6), STRING(0, 6)))

domain('MX_L2_FECHA_EVENTO', 'MX_FECHA_EVENTO',
  byName(['fecha_?(de_?)?(defuncion|fallecimiento|muerte|matrimonio|divorcio|ingreso|alta_?(imss|patronal|laboral)|baja(_?(imss|laboral))?|contratacion|contrato|egreso|despido|renuncia|jubilacion|pension|incapacidad|hospitalizacion|alta_?medica|diagnostico|atencion|consulta|parto|embarazo|detencion|sentencia|vacunacion|cirugia|estudio|reingreso|antiguedad)|fec_?(defuncion|ingreso|alta|baja|egreso|contrato|atencion|diagnostico|incapacidad)|fch_?(ingreso|alta|baja|egreso)|death_?date|hire_?date|termination_?date|date_?of_?death|admission_?date|discharge_?date', 0.8]),
  byType(...DATES, STRING(6)))

// H/M first: it is what CURP and INE use, and an M alone is read as Mujer.
decompose('MX_SEXO', [
  ['(?i)(femenino|masculino)', apply(lookup('MX_SEXO_PALABRA', 'mx-sexo-palabra.txt', ['Femenino', 'Masculino']))],
  ['(?i)(mujer|hombre)', apply(lookup('MX_SEXO_MUJER_HOMBRE', 'mx-sexo-mujer-hombre.txt', ['Mujer', 'Hombre']))],
  ['(?i)(female|male)', apply(lookup('MX_SEXO_INGLES', 'mx-sexo-ingles.txt', ['Female', 'Male']))],
  ['(?i)([hm])', apply(SEXO_H_M)],
  ['(?i)(f)', apply(lookup('MX_SEXO_F_M', 'mx-sexo-f-m.txt', ['F', 'M']))],
], keep, 'M')
domain('MX_L2_SEXO', 'MX_SEXO',
  byName(['sexo(_?(biologico|registral|paciente|cliente|asegurado|trabajador))?|sex|g[eé]nero(?!_?(identidad|social|autopercibido))|gender|cve_?sexo|cod_?sexo', 0.85]),
  byList([['mx-detectar-sexo.txt', ['h', 'm', 'f', 'x', 'hombre', 'mujer', 'femenino', 'masculino', 'female', 'male', 'fem', 'masc'], 0.5]], { reject: 0.5 }))

// Municipalities under 20,000 inhabitants (2020 census) become the nearest municipality of the
// same state that has at least 20,000. The result is a real municipality, nearby, and every group
// of people who end up sharing a name holds at least 20,000.
const SMALL = 20000
const distance = (a, b) => {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}
const generalized = new Map(MUNICIPIOS.map((m) => {
  if (m.population >= SMALL) return [m.code, m]
  const candidates = MUNICIPIOS.filter((x) => x.state === m.state && x.population >= SMALL)
  return [m.code, candidates.reduce((best, x) => (distance(m, x) < distance(m, best) ? x : best))]
}))
// Several municipalities share a name (seven are called Benito Juárez). A name is generalized only
// when every municipality of that name is small, towards the target of the most populous of them;
// the 5-digit code has no such ambiguity.
const byMunicipioName = new Map()
for (const m of MUNICIPIOS) byMunicipioName.set(m.name, [...(byMunicipioName.get(m.name) ?? []), m])
const nameTarget = (name) => {
  const all = byMunicipioName.get(name)
  if (all.some((m) => m.population >= SMALL)) return name
  return generalized.get(all.reduce((a, b) => (b.population > a.population ? b : a)).code).name
}
cleansing('MX_MUNICIPIO', 'mx-municipio-generalizado.txt', unique([...byMunicipioName.keys()].flatMap((name) => {
  const to = nameTarget(name)
  return [`${name}|${to}`, `${fold(name)}|${to}`, `${name.toUpperCase()}|${to.toUpperCase()}`, `${fold(name).toUpperCase()}|${fold(to).toUpperCase()}`]
})).map((line) => line.split('|')), 'Santa María Tlahuitoltepec', '|')
// Detection leaves out names that are also given names or surnames (Juárez, Hidalgo, Guadalupe).
const PERSONAL_WORDS = new Set([...NOMBRES, ...APELLIDOS].map((w) => fold(w).toLowerCase()))
domain('MX_L2_MUNICIPIO', 'MX_MUNICIPIO',
  byName(
    ['municipio[a-z_]*|nom(bre)?_?(mun|mpio|municipio)|mpio|mun|d_?mnpio|mnpio|alcaldia|delegacion(?!_?(imss|issste|sat|federal|estatal|regional|administrativa))|demarcacion(_?territorial)?|municipio_?(residencia|nacimiento|domicilio)', 0.85],
    ['ciudad[a-z_]*|city|town|d_?ciudad', 0.6],
  ),
  byList([['mx-detectar-municipios.txt', [...byMunicipioName.keys()].filter((name) => !PERSONAL_WORDS.has(fold(name).toLowerCase())), 0.9]], { reject: 0.4 }))

cleansing('MX_CLAVE_MUNICIPIO', 'mx-clave-municipio-generalizada.txt', unique(MUNICIPIOS.flatMap((m) => {
  const to = generalized.get(m.code).code
  return [`${m.code},${to}`, `${Number(m.code)},${Number(to)}`]
})).map((line) => line.split(',')), '20426')
domain('MX_L2_CLAVE_MUNICIPIO', 'MX_CLAVE_MUNICIPIO',
  byName(['cve_?(geo|mun|mpio|municipio|inegi)|clave_?(geo(estadistica)?|mun|mpio|municipio|inegi)(_?(inegi|municipal))?|cod(igo)?_?(mun|mpio|municipio|inegi)|id_?(mun|mpio|municipio)|c_?mnpio|municipio_?(cve|clave|id|cod|inegi)|cvegeo', 0.85]),
  byType(NUMBER(0, 5), STRING(0, 5)),
  byList([['mx-detectar-clave-municipio.txt', MUNICIPIOS.flatMap((m) => [m.code, String(Number(m.code))]), 0.5]], { reject: 0.3 }))

// Localities are replaced by the name of a municipality of over 100,000: a place still, no longer theirs.
lookup('MX_LOCALIDAD', 'mx-localidades.txt', MUNICIPIOS.filter((m) => m.population >= 100000).map((m) => m.name).filter((n) => !n.includes(',')), 'San Isidro Buenavista', 'PRESERVE_LOOKUP_FILE')
domain('MX_L2_LOCALIDAD', 'MX_LOCALIDAD',
  byName(['localidad[a-z_]*|nom(bre)?_?loc(alidad)?|poblado|ranch[oe]ria|ejido|comunidad(?!_?(indigena|religiosa))|pueblo_?(residencia|origen)|lugar_?(de_?)?nacimiento|origen_?(localidad|poblacion)', 0.8]))

lookup('MX_COLONIA', 'mx-colonias.txt', readLines('colonias.txt'), 'Santa María la Ribera', 'PRESERVE_LOOKUP_FILE')
domain('MX_L2_COLONIA', 'MX_COLONIA',
  byName(['colonia[a-z_]*|nom(bre)?_?colonia|fraccionamiento|fracc|barrio|asentamiento|d_?asenta|nom_?asentamiento|tipo_?asentamiento|unidad_?habitacional|conjunto_?habitacional|ageb|manzana_?inegi', 0.85]))

// Five digits; the first two are the state (or a Mexico City borough). The first three stay.
decompose('MX_CODIGO_POSTAL', [[String.raw`(\d{3})(\d{2})`, keep, redactAs('00')]], CM, '06700')
domain('MX_L2_CODIGO_POSTAL', 'MX_CODIGO_POSTAL',
  byName(['cod(igo)?_?postal|cp|c_?p|zip(_?code)?|postal_?code|codpostal|d_?codigo|domicilio_?fiscal(_?receptor)?|lugar_?expedicion|cp_?(fiscal|domicilio|receptor|emisor)', 0.9]),
  byPattern([[String.raw`\d{5}`, 0.2]], { reject: 0.3 }))

const NACIONALIDADES = ['Mexicana', 'Estadounidense', 'Guatemalteca', 'Hondureña', 'Salvadoreña', 'Venezolana', 'Colombiana', 'Cubana', 'Haitiana', 'Española', 'Argentina', 'Canadiense', 'China', 'Nicaragüense', 'Peruana', 'Brasileña', 'Francesa', 'Italiana', 'Alemana', 'Chilena']
lookup('MX_NACIONALIDAD', 'mx-nacionalidades.txt', NACIONALIDADES, 'Guatemalteca')
domain('MX_L2_NACIONALIDAD', 'MX_NACIONALIDAD',
  byName(['nacionalidad|nationality|pais_?(de_?)?(nacimiento|origen)|ciudadania|citizenship|country_?of_?birth|extranjero', 0.8]),
  byList([['mx-detectar-nacionalidades.txt', [...NACIONALIDADES, 'mexicano', 'estadounidense', 'guatemalteco', 'hondureño', 'salvadoreño', 'venezolano', 'colombiano', 'cubano', 'haitiano', 'español', 'argentino', 'chino', 'nicaragüense', 'peruano', 'brasileño', 'francés', 'italiano', 'alemán', 'chileno', 'méxico', 'estados unidos', 'guatemala', 'honduras', 'el salvador', 'venezuela', 'colombia', 'cuba', 'haití', 'extranjera', 'extranjero'], 0.7]], { reject: 0.4 }))

lookup('MX_ESTADO_CIVIL', 'mx-estado-civil.txt', ['Soltero', 'Casado', 'Unión libre', 'Separado', 'Divorciado', 'Viudo'], 'Casada')
domain('MX_L2_ESTADO_CIVIL', 'MX_ESTADO_CIVIL',
  byName(['estado_?civil|edo_?civil|est_?civil|ecivil|situacion_?conyugal|marital_?status|civil_?status', 0.85]),
  byList([['mx-detectar-estado-civil.txt', ['soltero', 'soltera', 'casado', 'casada', 'unión libre', 'union libre', 'concubinato', 'concubino', 'concubina', 'separado', 'separada', 'divorciado', 'divorciada', 'viudo', 'viuda', 'single', 'married', 'widowed', 'divorced'], 0.7]], { reject: 0.4 }))

lookup('MX_OCUPACION', 'mx-ocupaciones.txt', ['Empleado administrativo', 'Comerciante', 'Vendedor', 'Obrero', 'Operador de maquinaria', 'Chofer', 'Profesor', 'Enfermero', 'Médico general', 'Contador', 'Ingeniero', 'Abogado', 'Técnico en mantenimiento', 'Cajero', 'Mesero', 'Cocinero', 'Guardia de seguridad', 'Albañil', 'Electricista', 'Plomero', 'Mecánico', 'Agricultor', 'Jornalero agrícola', 'Ganadero', 'Pescador', 'Estudiante', 'Trabajador del hogar', 'Jubilado', 'Pensionado', 'Trabajador por cuenta propia', 'Programador', 'Diseñador gráfico', 'Recepcionista', 'Auxiliar de limpieza', 'Supervisor', 'Gerente de área', 'Asesor de ventas', 'Almacenista', 'Repartidor', 'Desempleado'], 'Gerente Regional Zona Sierra Tarahumara')
domain('MX_L2_OCUPACION', 'MX_OCUPACION',
  byName(['ocupaci[oó]n|profesi[oó]n|oficio|puesto(?!_?(votacion|venta|trabajo_?id))(_?(trabajo|laboral|actual))?|cargo(?!_?(fijo|variable|monto|adicional|servicio|tarifa|valor|cuenta|extra|automatico|recurrente|domiciliado))|job_?title|occupation|actividad_?(laboral|economica_?persona)|categoria_?laboral', 0.8]))

lookup('MX_EMPLEADOR', 'mx-empleadores.txt', ['Comercializadora del Bajío S.A. de C.V.', 'Servicios Integrales del Norte S.A. de C.V.', 'Constructora Sierra Madre S.A. de C.V.', 'Transportes Golfo Pacífico S.A. de C.V.', 'Agroindustrias del Valle S.P.R. de R.L.', 'Distribuidora Centro Occidente S.A. de C.V.', 'Grupo Hotelero Costa Azul S.A. de C.V.', 'Clínica San Rafael S.C.', 'Colegio Particular Los Fresnos A.C.', 'Consultores Asociados del Sureste S.C.', 'Minera Cerro Alto S.A. de C.V.', 'Pesquera Bahía Grande S.A. de C.V.', 'Tecnologías de la Laguna S.A.P.I. de C.V.', 'Abarrotes La Estrella S.A. de C.V.', 'Ferretería El Constructor S.A. de C.V.', 'Logística Puerta Norte S.A. de C.V.', 'Servicios de Limpieza Los Álamos S.A. de C.V.', 'Laboratorios Cruz del Sur S.A. de C.V.', 'Maquiladora Frontera S. de R.L. de C.V.', 'Autopartes del Centro S.A. de C.V.', 'Fundación Manos Unidas I.A.P.', 'Ayuntamiento de Villa Nueva', 'Seguridad Privada Centinela S.A. de C.V.', 'Muebles y Maderas del Sur S.A. de C.V.', 'Restaurantes La Hacienda S.A. de C.V.'], 'Petróleos Mexicanos')
domain('MX_L2_EMPLEADOR', 'MX_EMPLEADOR',
  byName(['empleador|patron(?!_?(busqueda|regex|expresion))|nombre_?patron|razon_?social_?(patron|empleador)|registro_?patronal_?nombre|empresa_?(empleadora|trabajo|laboral)|lugar_?(de_?)?trabajo|centro_?(de_?)?trabajo|employer|dependencia_?laboral', 0.8]))

const ESCOLARIDADES = ['Sin escolaridad', 'Preescolar', 'Primaria incompleta', 'Primaria completa', 'Secundaria incompleta', 'Secundaria completa', 'Preparatoria o bachillerato', 'Carrera técnica o comercial', 'Normal', 'Licenciatura', 'Maestría', 'Doctorado']
lookup('MX_ESCOLARIDAD', 'mx-escolaridad.txt', ESCOLARIDADES, 'Secundaria completa')
domain('MX_L2_ESCOLARIDAD', 'MX_ESCOLARIDAD',
  byName(['escolaridad|nivel_?(educativo|educacional|escolar|de_?estudios|academico)|grado_?(de_?)?estudios|grado_?academico|ultimo_?grado|education_?level|anos_?(de_?)?escolaridad', 0.8]),
  byList([['mx-detectar-escolaridad.txt', [...ESCOLARIDADES, 'primaria', 'secundaria', 'preparatoria', 'bachillerato', 'técnico', 'carrera técnica', 'profesional', 'universidad', 'posgrado', 'ninguno', 'ninguna'], 0.6]], { reject: 0.4 }))

lookup('MX_ESCUELA', 'mx-escuelas.txt', ['Escuela Primaria Miguel Hidalgo', 'Escuela Primaria Rural Emiliano Zapata', 'Escuela Secundaria Técnica No. 14', 'Telesecundaria Josefa Ortiz de Domínguez', 'Colegio de Bachilleres Plantel 5', 'Preparatoria Oficial No. 22', 'CBTIS No. 45', 'CONALEP Plantel Norte', 'Jardín de Niños Rosaura Zapata', 'Escuela Normal del Estado', 'Instituto Tecnológico del Valle', 'Universidad Autónoma del Centro', 'Universidad Tecnológica del Sur', 'Centro de Atención Múltiple No. 8', 'Colegio Particular Los Fresnos'], 'Instituto Cultural Tampico')
domain('MX_L2_ESCUELA', 'MX_ESCUELA',
  byName(['escuela|colegio|plantel|nombre_?(escuela|plantel|colegio|institucion_?educativa)|institucion_?educativa|universidad|preparatoria|secundaria|primaria|bachillerato|school(_?name)?|jardin_?de_?ninos|guarderia|estancia_?infantil', 0.75]))

domain('MX_L2_CCT', 'MX_CM_ALFANUM',
  byName(['cct|clave_?(de_?)?(centro_?de_?trabajo|escuela|plantel)|cve_?(cct|escuela|plantel)|centro_?de_?trabajo_?clave', 0.85]),
  byPattern([[String.raw`\d{2}[A-Z]{3}\d{4}[A-Z]`, 0.9]], { reject: 0.3 }))

// Capped at 5 as text: large households are rare, and a rare count identifies.
decompose('MX_CANTIDAD_ACOTADA', [[String.raw`([0-5])`, keep], [String.raw`(\d+)`, redactAs('5')]], keep, '9')
domain('MX_L2_DEPENDIENTES', 'MX_CANTIDAD_ACOTADA',
  byName(['dependientes(_?economicos)?|n(o|um|ro)?_?dependientes|num_?hijos|n(o|um|ro)?_?hijos|cant_?hijos|hijos|integrantes_?(del_?)?(hogar|familia)|n(o|um|ro)_?integrantes|tamano_?(del_?)?hogar|personas_?(en_?)?(el_?)?hogar|hijos_?nacidos_?vivos', 0.8]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// ── L3 · Sensitive data (art. 2, VI) ────────────────────────────────────────

const PUEBLOS = ['Nahua', 'Maya', 'Zapoteco', 'Mixteco', 'Otomí', 'Totonaco', 'Tsotsil', 'Tseltal', 'Mazahua', 'Mazateco', 'Huasteco', "Ch'ol", 'Purépecha', 'Chinanteco', 'Mixe', 'Tlapaneco', 'Rarámuri', 'Mayo', 'Zoque', 'Chontal de Tabasco', 'Popoluca', 'Chatino', 'Amuzgo', 'Tojolabal', 'Wixárika', 'Tepehuano', 'Triqui', 'Cora', 'Yaqui', 'Afromexicano', 'No se considera indígena']
categorical('MX_PUEBLO', 'mx-pueblos.txt', PUEBLOS, 'Kumiai')
domain('MX_L3_ETNIA', 'MX_PUEBLO',
  byName(['etnia|[eé]tnico|origen_?[eé]tnico|grupo_?[eé]tnico|pueblo_?(indigena|originario|orig)|autoadscripcion(_?(indigena|afromexicana|afro))?|se_?considera_?(indigena|afromexican[oa]|afro)|indigena|ind[ií]gena|afromexican[oa]|afrodescendiente|afro|raza|race|ethnicity|ethnic_?group|comunidad_?indigena|pertenencia_?(etnica|indigena)', 0.9]),
  byList([['mx-detectar-pueblos.txt', [...PUEBLOS, 'náhuatl', 'nahuatl', 'mexicanero', 'maya peninsular', 'yucateco', 'zapoteca', 'mixteca', "ñuu savi", 'ñuu sau', 'hñähñu', 'ñhañu', 'totonaca', 'tzotzil', 'tzeltal', 'jñatho', 'ha shuta enima', 'tének', 'teenek', 'huasteca', 'chol', "p'urhépecha", 'tarasco', 'mixe', 'ayuuk', "me'phaa", 'tlapaneca', 'tarahumara', 'yoreme', 'zoque', 'yokot', 'popoloca', 'chatina', 'amuzga', 'huichol', "o'dam", 'triqui', 'náayeri', 'yoeme', 'seri', 'comcaac', 'kickapoo', 'lacandón', 'mam', 'kumiai', 'pame', 'huave', 'ikoots', 'tepehua', 'afrodescendiente', 'afromexicana', 'negro', 'negra', 'moreno', 'indígena', 'no indígena', 'ninguno'], 0.9],
    // Self-identification is often a yes/no flag: it backs up the column name but decides nothing alone.
    ['mx-detectar-bandera.txt', ['s', 'n', 'sí', 'no', 'y', '0', '1'], 0.3],
  ], { reject: 0.4 }))

const LENGUAS = ['Náhuatl', 'Maya', 'Tseltal', 'Tsotsil', 'Mixteco', 'Zapoteco', 'Otomí', 'Totonaco', "Ch'ol", 'Mazateco', 'Huasteco', 'Mazahua', 'Tlapaneco', 'Chinanteco', 'Purépecha', 'Mixe', 'Tarahumara', 'Zoque', 'Tojolabal', 'Chatino', 'Huichol', 'Amuzgo', 'Triqui', 'Cora', 'Yaqui', 'Mayo', 'No habla lengua indígena']
categorical('MX_LENGUA_INDIGENA', 'mx-lenguas.txt', LENGUAS, 'Chocholteco')
domain('MX_L3_LENGUA_INDIGENA', 'MX_LENGUA_INDIGENA',
  byName(['lengua(_?(indigena|materna|originaria))?|habla_?(lengua_?)?(indigena|originaria)|hli|hablante_?(de_?)?lengua_?indigena|idioma_?(indigena|materno|originario)|lengua_?que_?habla|language_?indigenous|native_?language', 0.9]),
  byList([['mx-detectar-lenguas.txt', [...LENGUAS, 'nahuatl', 'maya', 'tzeltal', 'tzotzil', 'mixteco', 'zapoteco', 'otomí', 'hñähñu', 'totonaca', 'chol', 'tének', 'purépecha', 'tarasco', 'ayuuk', 'rarámuri', 'wixárika', 'español', 'ninguna', 'no habla'], 0.8]], { reject: 0.4 }))

const CIE10 = ['I10', 'E11', 'E78', 'J45', 'J06', 'J02', 'J20', 'K29', 'K21', 'K59', 'M54', 'M17', 'M25', 'N39', 'N20', 'R51', 'R10', 'H10', 'H66', 'L23', 'L30', 'B34', 'A09', 'E03', 'E66', 'D50', 'I83', 'K80', 'K40', 'S93', 'S60', 'Z00', 'J30', 'J32', 'G43', 'M79', 'R05']
const CIE10_DECIMAL = ['E11.9', 'E78.5', 'J45.9', 'J06.9', 'J02.9', 'J20.9', 'K29.7', 'K21.9', 'K59.0', 'M54.5', 'M17.9', 'N39.0', 'N20.0', 'R10.4', 'H10.9', 'H66.9', 'L23.9', 'L30.9', 'B34.9', 'A09.9', 'E03.9', 'E66.9', 'D50.9', 'I83.9', 'K80.2', 'K40.9', 'S93.4', 'S60.0', 'Z00.0', 'J30.4', 'J32.9', 'G43.9', 'M79.1']
decompose('MX_DIAGNOSTICO', [
  [String.raw`([A-TV-Za-tv-z]\d{2}\.\d{1,2})`, apply(lookup('MX_CIE10_DECIMAL', 'mx-cie10-decimal.txt', CIE10_DECIMAL, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [String.raw`([A-TV-Za-tv-z]\d{2,3})`, apply(lookup('MX_CIE10', 'mx-cie10.txt', CIE10, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [FLAG, apply('MX_BANDERA')],
], apply(lookup('MX_DIAGNOSTICO_TEXTO', 'mx-diagnosticos.txt', ['Hipertensión arterial sistémica', 'Diabetes mellitus tipo 2', 'Asma', 'Lumbalgia', 'Gastritis crónica', 'Rinofaringitis aguda', 'Infección de vías urinarias', 'Migraña', 'Hipotiroidismo', 'Dislipidemia', 'Obesidad', 'Gonartrosis', 'Bronquitis aguda', 'Faringoamigdalitis aguda', 'Dermatitis de contacto', 'Otitis media aguda', 'Esguince de tobillo', 'Conjuntivitis', 'Anemia por deficiencia de hierro', 'Enfermedad por reflujo gastroesofágico', 'Síndrome de intestino irritable', 'Tendinitis', 'Sinusitis aguda', 'Cefalea tensional', 'Insuficiencia venosa periférica', 'Hernia inguinal', 'Litiasis renal', 'Colelitiasis', 'Gastroenteritis aguda', 'Control de niño sano'])), 'F32.9')
domain('MX_L3_SALUD_DIAGNOSTICO', 'MX_DIAGNOSTICO',
  byName(['diagn[oó]stico[a-z_]*|diag|dx|cie_?10|cie_?11|cod(igo)?_?cie|cie|icd_?10|icd|patolog[ií]a[a-z_]*|padecimiento[a-z_]*|enfermedad(es)?[a-z_]*|morbilidad|condicion_?(medica|de_?salud|cronica)|problema_?(de_?)?salud|impresion_?diagnostica|causa_?(incapacidad|muerte|defuncion|hospitalizacion|consulta)|motivo_?(de_?)?(consulta|hospitalizacion|incapacidad)|comorbilidad(es)?|antecedentes_?(medicos|patologicos|personales_?patologicos|heredofamiliares|clinicos)|alergias?|enfermedad_?preexistente|preexistencias?|enfermedad_?cronica|riesgo_?de_?trabajo', 0.85]),
  // 0.5: codes shaped like CIE-10 are everywhere in CFDI catalogs (G01, S01); the name has to agree.
  byPattern([[String.raw`[A-TV-Za-tv-z]\d{2}(\.\d{1,2}|\d)?`, 0.5]], { reject: 0.3 }))

const MEDICAMENTOS = ['Paracetamol', 'Ibuprofeno', 'Naproxeno', 'Metamizol', 'Ketorolaco', 'Diclofenaco', 'Metformina', 'Glibenclamida', 'Losartán', 'Enalapril', 'Captopril', 'Amlodipino', 'Atorvastatina', 'Bezafibrato', 'Omeprazol', 'Butilhioscina', 'Levotiroxina', 'Amoxicilina', 'Ciprofloxacino', 'Salbutamol', 'Loratadina', 'Ambroxol', 'Clorfenamina', 'Ácido acetilsalicílico', 'Prednisona', 'Complejo B']
categorical('MX_MEDICAMENTO', 'mx-medicamentos.txt', MEDICAMENTOS, 'Sertralina 50 mg')
domain('MX_L3_SALUD_MEDICAMENTO', 'MX_MEDICAMENTO',
  byName(['medicamentos?|f[aá]rmacos?|sustancia_?activa|principio_?activo|prescripci[oó]n|receta(_?medica)?|tratamiento(_?farmacologico)?|medication|drug(_?name)?|posologia|clave_?cuadro_?basico|cuadro_?basico', 0.85]),
  byList([['mx-detectar-medicamentos.txt', [...MEDICAMENTOS, 'sertralina', 'fluoxetina', 'escitalopram', 'paroxetina', 'quetiapina', 'clonazepam', 'alprazolam', 'diazepam', 'carbonato de litio', 'litio', 'metilfenidato', 'risperidona', 'olanzapina', 'aripiprazol', 'tenofovir', 'emtricitabina', 'efavirenz', 'dolutegravir', 'bictegravir', 'insulina', 'insulina glargina', 'warfarina', 'levetiracetam', 'ácido valproico', 'naltrexona', 'misoprostol', 'mifepristona', 'levonorgestrel'], 0.7]], { reject: 0.3 }))

domain('MX_L3_SALUD_IDENTIFICADOR', 'MX_CM_ALFANUM',
  byName(
    ['expediente_?clinico|n(o|um|ro|umero)_?expediente(_?clinico)?|historia_?clinica|n(o|um|ro)_?historia|nhc|n(o|um|ro)_?episodio|folio_?(atencion|urgencias|receta|incapacidad|certificado_?(de_?)?defuncion)|n(o|um|ro)_?incapacidad|certificado_?(de_?)?incapacidad|serie_?folio_?incapacidad|n(o|um|ro)_?(de_?)?cama|n(o|um|ro)_?interconsulta|n(o|um|ro)_?(de_?)?receta|agregado_?medico|n(o|um|ro)_?biopsia|medical_?record_?number|mrn', 0.85],
    ['expediente|episodio|cama', 0.55],
  ))

domain('MX_L3_SALUD_TEXTO_CLINICO', 'MX_TEXTO_LIBRE',
  byName(['nota_?(medica|de_?evolucion|evolucion|de_?ingreso|ingreso|de_?egreso|egreso|de_?urgencias|urgencias|postoperatoria|preoperatoria|de_?enfermeria|clinica)s?|notas?_?clinicas?|padecimiento_?actual|interrogatorio|exploracion_?fisica|evoluci[oó]n(_?(medica|clinica))?|epicrisis|indicaciones(_?medicas)?|resumen_?clinico|resumen_?(de_?)?egreso|historia_?(de_?la_?)?enfermedad|plan_?(de_?)?tratamiento|pronostico|hallazgos|interpretacion|clinical_?notes?|progress_?notes?', 0.85]),
  byType(STRING(30)))

domain('MX_L3_SALUD_RESULTADO_EXAMEN', 'MX_CM_ALFANUM',
  byName(
    ['resultado_?(estudio|examen|laboratorio|lab|prueba|pcr|antigeno|biopsia|imagen|vih|covid|papanicolaou|mastografia)|estudios?_?(de_?)?laboratorio|vih|hiv|carga_?viral|cd4|glucosa|glicemia|hemoglobina(_?glucosilada)?|hba1c|colesterol|trigliceridos|presion_?arterial|tension_?arterial|imc|prueba_?(covid|embarazo|vih|antidoping|toxicologica)|antidoping|lab_?result', 0.8],
    ['resultado|estudio', 0.5],
  ))

const GRUPOS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']
lookup('MX_GRUPO_SANGUINEO', 'mx-grupo-sanguineo.txt', GRUPOS, 'O+', 'PRESERVE_LOOKUP_FILE')
domain('MX_L3_SALUD_GRUPO_SANGUINEO', 'MX_GRUPO_SANGUINEO',
  byName(['grupo_?sangu[ií]neo|grupo_?sang|tipo_?(de_?)?sangre|tipo_?sanguineo|factor_?rh|rh|blood_?type|blood_?group', 0.9]),
  byList([['mx-detectar-grupo-sanguineo.txt', [...GRUPOS, '0+', '0-', 'a rh+', 'a rh-', 'b rh+', 'b rh-', 'ab rh+', 'ab rh-', 'o rh+', 'o rh-', 'a positivo', 'a negativo', 'b positivo', 'b negativo', 'ab positivo', 'ab negativo', 'o positivo', 'o negativo'], 0.9]], { reject: 0.4 }))

// The categories of the 2020 census (INEGI): activities people have difficulty doing.
const DISCAPACIDADES = ['Caminar, subir o bajar', 'Ver, aun usando lentes', 'Oír, aun usando aparato auditivo', 'Hablar o comunicarse', 'Recordar o concentrarse', 'Bañarse, vestirse o comer', 'Condición mental', 'Sin discapacidad']
categorical('MX_DISCAPACIDAD', 'mx-discapacidad.txt', DISCAPACIDADES, 'Discapacidad psicosocial severa')
domain('MX_L3_SALUD_DISCAPACIDAD', 'MX_DISCAPACIDAD',
  byName(['discapacidad[a-z_]*|tipo_?(de_?)?discapacidad|grado_?(de_?)?discapacidad|certificado_?(de_?)?discapacidad|persona_?con_?discapacidad|pcd|invalidez|porcentaje_?(de_?)?invalidez|pension_?(de_?)?invalidez|limitacion(_?(fisica|actividad))?|disability|dependencia_?funcional|nee|necesidades_?educativas_?especiales|condicion_?mental', 0.9]),
  byList([['mx-detectar-discapacidad.txt', [...DISCAPACIDADES, 'motriz', 'visual', 'auditiva', 'de lenguaje', 'intelectual', 'psicosocial', 'mental', 'múltiple', 'física', 'sensorial', 'ninguna', 'sin limitación'], 0.6]], { reject: 0.3 }))

// Reproductive and mental health, sexual life, philosophical beliefs, union membership: the values
// have no shared vocabulary, so they are suppressed (flags and numeric codes keep their shape).
domain('MX_L3_SALUD_SEXUAL_REPRODUCTIVA', 'MX_CATEGORIA_SUPRIMIDA',
  byName(['embarazo|embarazada|gestaci[oó]n|semanas_?(de_?)?gestacion|edad_?gestacional|fum|fecha_?ultima_?menstruacion|aborto|ile|ive|interrupcion_?(legal_?|voluntaria_?)?(del_?)?embarazo|anticonceptivos?|metodo_?(de_?)?planificacion(_?familiar)?|planificacion_?familiar|fertilidad|infertilidad|reproduccion_?asistida|gestas|partos|cesareas?|puerperio|its|ets|infeccion_?(de_?)?transmision_?sexual|prep|pregnan[a-z]*|contracepti[a-z]*', 0.9]))

domain('MX_L3_SALUD_MENTAL_ADICCIONES', 'MX_CATEGORIA_SUPRIMIDA',
  byName(['salud_?mental|psiquiatri[a-z]*|psicologi[a-z]*|trastorno[a-z_]*|depresi[oó]n|ansiedad|suicid[a-z]*|autolesi[oó]n|adicci[oó]n(es)?|consumo_?(de_?)?(drogas|alcohol|sustancias|tabaco)|alcoholismo|farmacodependencia|drogadiccion|toxicomania|dependencia_?(alcohol|drogas|sustancias)|cij|conadic|tratamiento_?(adicciones|drogas|alcohol)|anexo_?(rehabilitacion)?|mental_?health|substance_?(use|abuse)', 0.9]))

domain('MX_L3_BIOMETRICO', 'MX_REDACTAR',
  byName(['huella(_?(dactilar|digital))?|huellas|dactilar|biometri[a-z_]*|template_?(facial|biometrico|huella)|rostro|reconocimiento_?facial|facial_?(template|id)|iris|retina|voz_?(huella|biometrica)|firma_?(digitalizada|biometrica|autografa_?digital)|fingerprint|face_?(id|template|encoding)|palm_?print|minucias', 0.9]),
  byType(STRING()))

domain('MX_L3_INFORMACION_GENETICA', 'MX_REDACTAR',
  byName(['adn|dna|genoma|genotipo|genetic[a-z_]*|gen[eé]tic[ao]|informacion_?genetica|secuencia_?genetica|marcador_?genetico|perfil_?(genetico|biologico)|mutacion(_?genetica)?|snp|brca|haplotipo|cariotipo|tamiz_?(genetico|metabolico)|prueba_?(de_?)?paternidad', 0.9]))

const ORIENTACIONES = ['Heterosexual', 'Homosexual', 'Lesbiana', 'Gay', 'Bisexual', 'Pansexual', 'Asexual', 'Otra', 'Prefiere no responder']
categorical('MX_PREFERENCIA_SEXUAL', 'mx-preferencia-sexual.txt', ORIENTACIONES, 'Bisexual')
domain('MX_L3_PREFERENCIA_SEXUAL', 'MX_PREFERENCIA_SEXUAL',
  byName(['preferencia_?sexual|orientaci[oó]n_?sexual|sexual_?(orientation|preference)|orient_?sexual|pref_?sexual', 0.95]),
  byList([['mx-detectar-preferencia-sexual.txt', [...ORIENTACIONES, 'hetero', 'homo', 'queer', 'no responde', 'straight', 'lesbian', 'lgbt', 'lgbtiq+'], 0.8]], { reject: 0.4 }))

const IDENTIDADES = ['Mujer', 'Hombre', 'Mujer trans', 'Hombre trans', 'No binario', 'Género fluido', 'Otra', 'Prefiere no responder']
categorical('MX_IDENTIDAD_GENERO', 'mx-identidad-genero.txt', IDENTIDADES, 'Hombre trans')
domain('MX_L3_IDENTIDAD_GENERO', 'MX_IDENTIDAD_GENERO',
  byName(['identidad_?(de_?)?g[eé]nero|gender_?identity|g[eé]nero_?(identidad|social|autopercibido)|transg[eé]nero|transexual|persona_?trans|reconocimiento_?(de_?)?identidad|cambio_?(de_?)?(sexo|genero)|pronombres?', 0.95]),
  byList([['mx-detectar-identidad-genero.txt', [...IDENTIDADES, 'cisgénero', 'transgénero', 'no binaria', 'no binarie', 'trans', 'muxe', 'femenino', 'masculino'], 0.7]], { reject: 0.4 }))

domain('MX_L3_VIDA_SEXUAL', 'MX_CATEGORIA_SUPRIMIDA',
  byName(['vida_?sexual|conducta_?sexual|actividad_?sexual|parejas?_?sexuales?|practicas_?sexuales|inicio_?(de_?)?vida_?sexual|ivsa|sexual_?(activity|behavior|history)|historia_?sexual|comportamiento_?sexual', 0.9]))

// Religion groups of the 2020 census (INEGI).
const RELIGIONES = ['Católica', 'Protestante o cristiana evangélica', 'Pentecostal', 'Testigo de Jehová', 'Adventista del Séptimo Día', 'Iglesia de Jesucristo de los Santos de los Últimos Días', 'Judaica', 'Islámica', 'Budista', 'Espiritualista', 'Otra religión', 'Sin religión', 'Sin adscripción religiosa']
categorical('MX_RELIGION', 'mx-religiones.txt', RELIGIONES, 'Luz del Mundo')
domain('MX_L3_RELIGION', 'MX_RELIGION',
  byName(['religi[oó]n[a-z_]*|credo|culto|iglesia|creencia_?religiosa|confesion_?religiosa|denominacion_?religiosa|asociacion_?religiosa|religious_?affiliation|comunidad_?religiosa', 0.95]),
  byList([['mx-detectar-religiones.txt', [...RELIGIONES, 'católico', 'catolica', 'cristiano', 'cristiana', 'evangélico', 'evangélica', 'protestante', 'pentecostal', 'mormón', 'testigos de jehová', 'adventista', 'judío', 'judía', 'musulmán', 'islam', 'budismo', 'luz del mundo', 'ateo', 'atea', 'agnóstico', 'agnóstica', 'ninguna', 'creyente', 'otra'], 0.9]], { reject: 0.4 }))

domain('MX_L3_CREENCIA_FILOSOFICA_MORAL', 'MX_CATEGORIA_SUPRIMIDA',
  byName(['creencias?_?(filosoficas?|morales?|personales)|convicci[oó]n(es)?(_?(filosoficas?|morales?|eticas?|personales))?|objecion_?(de_?)?conciencia|postura_?(etica|moral)|valores_?personales|filosofia_?(de_?)?vida|cosmovision', 0.9]))

const IDEOLOGIAS = ['Izquierda', 'Centro izquierda', 'Centro', 'Centro derecha', 'Derecha', 'Sin preferencia', 'Prefiere no responder']
categorical('MX_OPINION_POLITICA', 'mx-opiniones-politicas.txt', IDEOLOGIAS, 'Centro derecha')
domain('MX_L3_OPINION_POLITICA', 'MX_OPINION_POLITICA',
  byName(['opini[oó]n(es)?_?pol[ií]ticas?|ideolog[ií]a(_?politica)?|posicion_?politica|postura_?politica|tendencia_?politica|orientacion_?politica|preferencia_?(politica|electoral|partidista)|intencion_?(de_?)?voto|simpatia_?(politica|partidista)|political_?(view|orientation|opinion)', 0.9]),
  byList([['mx-detectar-opiniones-politicas.txt', [...IDEOLOGIAS, 'centroizquierda', 'centroderecha', 'liberal', 'conservador', 'progresista', 'ninguna', 'apartidista'], 0.7]], { reject: 0.4 }))

// National parties with registration in 2026 (INE), and the ones that held it recently.
const PARTIDOS = ['Morena', 'Partido Acción Nacional', 'Partido Revolucionario Institucional', 'Partido del Trabajo', 'Partido Verde Ecologista de México', 'Movimiento Ciudadano', 'Partido Paz', 'Somos México', 'Candidatura independiente', 'Sin militancia']
categorical('MX_PARTIDO_POLITICO', 'mx-partidos.txt', PARTIDOS, 'Partido de la Revolución Democrática')
domain('MX_L3_AFILIACION_POLITICA', 'MX_PARTIDO_POLITICO',
  byName(['partido(_?pol[ií]tico)?|militancia|militante|afiliaci[oó]n_?(politica|partidista|partido)|afiliado_?(a_?)?partido|padron_?(de_?)?militantes|political_?party|party_?affiliation|coalici[oó]n|simpatizante', 0.95]),
  byList([['mx-detectar-partidos.txt', [...PARTIDOS, 'movimiento regeneración nacional', 'MORENA', 'PAN', 'PRI', 'PT', 'PVEM', 'MC', 'PRD', 'Partido de la Revolución Democrática', 'PES', 'Partido Encuentro Solidario', 'Fuerza por México', 'Redes Sociales Progresistas', 'Nueva Alianza', 'PANAL', 'PAZ', 'independiente', 'sin partido', 'ninguno'], 0.8]], { reject: 0.4 }))

domain('MX_L3_AFILIACION_SINDICAL', 'MX_CATEGORIA_SUPRIMIDA',
  byName(['sindicato[a-z_]*|sindical|sindicalizado|afiliaci[oó]n_?sindical|agremiado|cuota_?sindical|delegado_?sindical|seccion_?sindical|trabajador_?(de_?)?confianza|tipo_?(de_?)?trabajador_?(sindicalizado|confianza)|union_?member(ship)?|trade_?union|contrato_?colectivo', 0.95]),
  byList([['mx-detectar-sindicatos.txt', ['SNTE', 'CNTE', 'STPRM', 'SUTERM', 'CTM', 'CROC', 'CROM', 'FSTSE', 'SME', 'STRM', 'SNTSS', 'STUNAM', 'sindicalizado', 'confianza', 'sindicato nacional de trabajadores de la educación'], 0.6]], { reject: 0.3 }))

// ── FIN · Financial and patrimonial data (art. 7: express consent) ──────────

const MOP = lookup('MX_MOP', 'mx-mop.txt', ['01', '02', '03', '04', '05', '06', '07', '96', '97'])
decompose('MX_BURO_CREDITO', [
  // Buró de Crédito payment behaviour codes (MOP) stay codes; a 3-digit score gets other digits.
  [String.raw`(0[0-7]|9[679])`, apply(MOP)],
  [String.raw`(?i)(mop\s*)(0[0-7]|9[679])`, keep, apply(MOP)],
  [String.raw`(\d{3})`, CM],
  [FLAG, apply('MX_BANDERA')],
], apply(lookup('MX_ESTADO_CREDITICIO', 'mx-estado-crediticio.txt', ['Al corriente', 'Atraso de 1 a 29 días', 'Atraso de 30 a 59 días', 'Atraso de 60 a 89 días', 'Atraso de 90 a 119 días', 'Atraso de 120 a 149 días', 'Atraso de 150 días a 12 meses', 'Atraso mayor a 12 meses', 'Cuenta con quebranto', 'Sin historial'])), 'MOP 05')
domain('MX_FIN_BURO_CREDITO', 'MX_BURO_CREDITO',
  byName(['buro(_?(de_?)?credito)?|bur[oó]|circulo_?(de_?)?credito|historial_?crediticio|score(_?(buro|crediticio|credito|riesgo|bc))?|bc_?score|puntaje_?(crediticio|buro|riesgo|credito)|calificacion_?(crediticia|buro|riesgo)|mop|forma_?de_?pago_?buro|clave_?(de_?)?observacion|morosidad|moroso|morosa|atraso|dias_?(de_?)?atraso|dias_?(de_?)?mora|cartera_?vencida|quebranto|estatus_?(credito|crediticio|cartera)|estado_?(de_?)?(cuenta_?)?(credito|crediticio|cartera)|credit_?score|delinquen[a-z]*|reestructura|insolvencia|concurso_?mercantil', 0.9]))

algorithm('MX_MONTO_DEUDA', 'characterMapping.NumericMapping', { minValue: 1000, maxValue: 5000000 }, '85000')
domain('MX_FIN_MONTO_DEUDA', 'MX_MONTO_DEUDA',
  byName(['monto_?(deuda|adeudo|adeudado|vencido|quebranto|credito|prestamo|financiado)|adeudo(_?(total|vigente|vencido))?|deuda(_?(total|vigente|vencida))?|saldo_?(deudor|insoluto|vencido|credito|prestamo|tarjeta|adeudo)|limite_?(de_?)?credito|linea_?(de_?)?credito|pago_?minimo|debt(_?amount)?|outstanding_?balance', 0.85]),
  byType(NUMBER()))

algorithm('MX_INGRESO_MENSUAL', 'characterMapping.NumericMapping', { minValue: 8000, maxValue: 250000 }, '18500')
domain('MX_FIN_INGRESO_MENSUAL', 'MX_INGRESO_MENSUAL',
  byName(['sueldo(?!_?(diario|base_?cotizacion))[a-z_]*|salario(?!_?(diario|base_?(de_?)?cotizacion|minimo_?(general|profesional|zona)))[a-z_]*|remuneraci[oó]n[a-z_]*|ingreso_?(mensual|neto|bruto|familiar|del_?hogar|hogar|per_?capita|total|promedio|declarado|laboral|comprobable|anual)|ingresos(_?[a-z]+)?|percepciones?(_?(totales|gravadas|exentas))?|total_?percepciones|neto_?a_?pagar|nomina_?(neta|bruta)|gasto_?(mensual|familiar)|capacidad_?(de_?)?pago|salary|wage|income|gross_?pay|net_?pay', 0.85]),
  byType(NUMBER()))

algorithm('MX_SALARIO_DIARIO', 'characterMapping.NumericMapping', { minValue: 280, maxValue: 3000 }, '452.10')
domain('MX_FIN_SALARIO_DIARIO', 'MX_SALARIO_DIARIO',
  byName(['sdi|sbc|salario_?diario(_?integrado)?|sueldo_?diario|salario_?base_?(de_?)?cotizacion|sal_?(diario|base|integrado)|sd_?integrado|cuota_?diaria|daily_?wage', 0.9]),
  byType(NUMBER()))

algorithm('MX_PATRIMONIO', 'characterMapping.NumericMapping', { minValue: 200000, maxValue: 30000000 }, '1850000')
domain('MX_FIN_PATRIMONIO', 'MX_PATRIMONIO',
  byName(['patrimonio(_?(neto|total))?|valor_?(catastral|comercial|avaluo|inmueble|propiedad|vivienda|vehiculo|de_?la_?garantia)|avaluo|bienes_?(inmuebles|muebles)|valor_?bienes|activos_?(personales|totales)|saldo_?(inversion|ahorro|cuenta)|monto_?(inversion|ahorro)|net_?worth|assets', 0.85]),
  byType(NUMBER()))

const AFORES = ['Afore Azteca', 'Afore Banamex', 'Afore Coppel', 'Afore Inbursa', 'Afore Invercap', 'PensionISSSTE', 'Afore Principal', 'Afore Profuturo', 'Afore SURA', 'Afore XXI Banorte', 'Sin Afore']
categorical('MX_AFORE', 'mx-afores.txt', AFORES, 'Afore Coppel')
domain('MX_FIN_AFORE', 'MX_AFORE',
  byName(['afore|nombre_?afore|cve_?afore|clave_?afore|administradora_?(de_?)?fondos_?(para_?el_?)?retiro|sar|siefore|cuenta_?individual_?(afore|retiro)|regimen_?(de_?)?pension(_?(ley_?73|ley_?97))?|pension_?fund', 0.95]),
  byList([['mx-detectar-afores.txt', [...AFORES, 'azteca', 'banamex', 'citibanamex', 'coppel', 'inbursa', 'invercap', 'pensionissste', 'principal', 'profuturo', 'profuturo gnp', 'sura', 'xxi banorte', 'xxi', 'banorte', 'prestadora de servicios', 'cuenta asignada'], 0.9]], { reject: 0.4 }))

algorithm('MX_SALDO_RETIRO', 'characterMapping.NumericMapping', { minValue: 5000, maxValue: 5000000 }, '385000')
domain('MX_FIN_SALDO_RETIRO', 'MX_SALDO_RETIRO',
  byName(['saldo_?(afore|retiro|rcv|subcuenta|vivienda|infonavit|fovissste|sar|cuenta_?individual|voluntario)|subcuenta_?(de_?)?(retiro|vivienda|rcv)|aportaciones?_?(voluntarias|patronales|infonavit)|monto_?pension|pension_?(mensual|monto)|retiro_?cesantia_?vejez|rcv|ahorro_?voluntario|retirement_?balance', 0.9]),
  byType(NUMBER()))

const CREDITOS_VIVIENDA = ['Crédito Infonavit', 'Crédito Fovissste', 'Cofinavit', 'Crédito hipotecario bancario', 'Crédito de otra institución', 'Sin crédito de vivienda']
categorical('MX_CREDITO_VIVIENDA', 'mx-credito-vivienda.txt', CREDITOS_VIVIENDA, 'Mejoravit')
domain('MX_FIN_CREDITO_VIVIENDA', 'MX_CREDITO_VIVIENDA',
  byName(['tipo_?(de_?)?credito_?(vivienda|hipotecario)|credito_?(vivienda|hipotecario)|hipoteca|infonavit|fovissste|cofinavit|mejoravit|descuento_?infonavit|factor_?(de_?)?descuento|aviso_?(de_?)?retencion|mortgage', 0.9]),
  byList([['mx-detectar-credito-vivienda.txt', [...CREDITOS_VIVIENDA, 'infonavit', 'fovissste', 'cofinavit', 'mejoravit', 'bancario', 'hipotecario', 'ninguno', 'sin crédito'], 0.8]], { reject: 0.4 }))

// Social security coverage reveals formal or informal work — the Mexican counterpart of an insurer.
const DERECHOHABIENCIAS = ['IMSS', 'ISSSTE', 'ISSSTE estatal', 'IMSS-Bienestar', 'Pemex', 'Sedena', 'Semar', 'Seguro privado', 'Otra institución', 'No afiliado']
decompose('MX_SEGURIDAD_SOCIAL', [
  [FLAG, apply('MX_BANDERA')],
  [String.raw`(\d{1,2})`, CM],
], apply(lookup('MX_SEGURIDAD_SOCIAL_LISTA', 'mx-seguridad-social.txt', DERECHOHABIENCIAS, undefined, 'PRESERVE_LOOKUP_FILE')), 'ISSSTE')
domain('MX_FIN_SEGURIDAD_SOCIAL', 'MX_SEGURIDAD_SOCIAL',
  byName(['derechohabiencia|derecho_?habiencia|afiliacion_?(a_?)?(servicios_?de_?salud|seguridad_?social)|institucion_?(de_?)?(seguridad_?social|salud)|servicio_?medico|seguridad_?social|regimen_?(de_?)?seguridad_?social|seguro_?(medico|de_?salud|popular)|imss_?bienestar|insabi|umf|unidad_?medica_?familiar|health_?insurance', 0.9]),
  byList([['mx-detectar-seguridad-social.txt', [...DERECHOHABIENCIAS, 'imss bienestar', 'insabi', 'seguro popular', 'issste estatal', 'pemex', 'sedena', 'semar', 'privado', 'ninguna', 'sin derechohabiencia', 'no derechohabiente'], 0.8]], { reject: 0.4 }))

const PROGRAMAS = ['Pensión para el Bienestar de las Personas Adultas Mayores', 'Pensión Mujeres Bienestar', 'Pensión para el Bienestar de las Personas con Discapacidad', 'Beca Universal Rita Cetina', 'Beca Universal Benito Juárez', 'Jóvenes Construyendo el Futuro', 'Jóvenes Escribiendo el Futuro', 'Sembrando Vida', 'Producción para el Bienestar', 'Programa para el Bienestar de Niñas y Niños', 'Tandas para el Bienestar', 'Vivienda para el Bienestar', 'Ninguno']
categorical('MX_PROGRAMA_SOCIAL', 'mx-programas-sociales.txt', PROGRAMAS, 'Prospera')
domain('MX_FIN_PROGRAMA_SOCIAL', 'MX_PROGRAMA_SOCIAL',
  byName(['programa_?(social|del_?bienestar|bienestar|federal|de_?apoyo|gobierno)|programas_?sociales|beneficiario_?(de_?)?(programa|pension|beca|apoyo)|apoyo_?(social|gubernamental|bienestar|economico)|pension_?(bienestar|adultos_?mayores|mujeres|discapacidad|65)|beca_?(bienestar|benito_?juarez|rita_?cetina)|becas?_?bienestar|jovenes_?construyendo|jcf|sembrando_?vida|prospera|oportunidades|progresa|padron_?(de_?)?beneficiarios|tarjeta_?bienestar|social_?program', 0.9]),
  byList([['mx-detectar-programas.txt', [...PROGRAMAS, 'pensión bienestar', 'adultos mayores', '65 y más', 'beca benito juárez', 'beca rita cetina', 'jóvenes construyendo el futuro', 'sembrando vida', 'prospera', 'oportunidades', 'progresa', 'liconsa', 'ninguno'], 0.8]], { reject: 0.4 }))

// AMAI socioeconomic levels; income quintiles and deciles become other numbers of the same range.
decompose('MX_NIVEL_SOCIOECONOMICO', [
  [String.raw`([1-5])`, apply(lookup('MX_QUINTIL', 'mx-quintil.txt', ['1', '2', '3', '4', '5']))],
  [String.raw`([6-9]|10)`, apply(lookup('MX_DECIL_ALTO', 'mx-decil-alto.txt', ['6', '7', '8', '9', '10']))],
  [String.raw`(?i)(decil\s*)(\d{1,2})`, keep, apply(lookup('MX_DECIL', 'mx-decil.txt', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']))],
], apply(lookup('MX_NSE', 'mx-nse.txt', ['A/B', 'C+', 'C', 'C-', 'D+', 'D', 'E'], undefined, 'PRESERVE_LOOKUP_FILE')), 'C-')
domain('MX_FIN_NIVEL_SOCIOECONOMICO', 'MX_NIVEL_SOCIOECONOMICO',
  byName(['nse|nivel_?socioeconomico|nivel_?socio_?economico|estrato(_?socioeconomico)?|clase_?social|decil(_?(de_?)?ingresos?)?|quintil(_?(de_?)?ingresos?)?|grado_?(de_?)?marginacion|indice_?(de_?)?marginacion|marginacion|rezago_?social|pobreza(_?(extrema|moderada|multidimensional))?|carencias?_?sociales?|vulnerabilidad(_?(por_?ingresos|social))?|socioeconomic_?level', 0.9]),
  byList([['mx-detectar-nse.txt', ['a/b', 'ab', 'c+', 'c', 'c-', 'd+', 'd', 'e', 'muy alto', 'alto', 'medio', 'bajo', 'muy bajo'], 0.4]], { reject: 0.3 }))

const VIVIENDAS = ['Propia', 'Propia en proceso de pago', 'Rentada o alquilada', 'Prestada', 'Intestada o en litigio', 'Otra situación']
categorical('MX_VIVIENDA', 'mx-vivienda.txt', VIVIENDAS, 'Asentamiento irregular')
domain('MX_FIN_VIVIENDA', 'MX_VIVIENDA',
  byName(['tenencia_?(de_?)?(la_?)?vivienda|tipo_?(de_?)?vivienda|situacion_?(de_?la_?)?vivienda|vivienda_?(propia|rentada|prestada)|condicion_?(de_?)?(la_?)?vivienda|material_?(de_?)?(la_?)?vivienda|piso_?de_?tierra|hacinamiento|asentamiento_?irregular|housing_?(type|tenure|status)', 0.95]),
  byList([['mx-detectar-vivienda.txt', [...VIVIENDAS, 'propia', 'rentada', 'alquilada', 'prestada', 'intestada', 'en litigio', 'hipotecada', 'familiar'], 0.6]], { reject: 0.3 }))

// SAT tax regimes (c_RegimenFiscal of CFDI 4.0) that apply to individuals.
const REGIMENES = [['605', 'Sueldos y Salarios e Ingresos Asimilados a Salarios'], ['606', 'Arrendamiento'], ['607', 'Régimen de Enajenación o Adquisición de Bienes'], ['608', 'Demás ingresos'], ['610', 'Residentes en el Extranjero sin Establecimiento Permanente en México'], ['611', 'Ingresos por Dividendos (socios y accionistas)'], ['612', 'Personas Físicas con Actividades Empresariales y Profesionales'], ['614', 'Ingresos por intereses'], ['615', 'Régimen de los ingresos por obtención de premios'], ['616', 'Sin obligaciones fiscales'], ['621', 'Incorporación Fiscal'], ['625', 'Régimen de las Actividades Empresariales con ingresos a través de Plataformas Tecnológicas'], ['626', 'Régimen Simplificado de Confianza']]
decompose('MX_REGIMEN_FISCAL', [
  [String.raw`(6\d{2})`, apply(lookup('MX_REGIMEN_FISCAL_CLAVE', 'mx-regimen-fiscal-clave.txt', REGIMENES.map(([c]) => c)))],
  [String.raw`(6\d{2})(\s*[-–]\s*)(.+)`, apply('MX_REGIMEN_FISCAL_CLAVE'), keep, apply(lookup('MX_REGIMEN_FISCAL_NOMBRE', 'mx-regimen-fiscal-nombre.txt', REGIMENES.map(([, n]) => n), undefined, 'PRESERVE_LOOKUP_FILE'))],
], apply('MX_REGIMEN_FISCAL_NOMBRE'), '612')
domain('MX_FIN_REGIMEN_FISCAL', 'MX_REGIMEN_FISCAL',
  byName(['regimen_?fiscal(_?receptor)?|c_?regimen_?fiscal|cve_?regimen|clave_?regimen(_?fiscal)?|regimen_?(sat|tributario)|tax_?regime', 0.9]))

// ── PENAL · Criminal records ────────────────────────────────────────────────

categorical('MX_ANTECEDENTES', 'mx-antecedentes.txt', ['Sin antecedentes penales', 'Con antecedentes penales', 'Sin información'], 'Sentenciado por robo')
domain('MX_PENAL_ANTECEDENTES', 'MX_ANTECEDENTES',
  byName(['antecedentes(?!_?(medicos|patologicos|personales_?patologicos|heredofamiliares|gineco|obstetricos|familiares|clinicos|academicos|laborales|crediticios|comerciales|generales))(_?(penales|judiciales|policiacos|criminales|no_?penales))?|carta_?(de_?)?no_?antecedentes|constancia_?(de_?)?(no_?)?antecedentes|sentencia(_?condenatoria)?|sentenciad[oa]|condena(do|da)?|delitos?|tipo_?(de_?)?delito|reincidente|reincidencia|imputad[oa]|vinculado_?a_?proceso|vinculacion_?a_?proceso|prision_?preventiva|pena|reclusion|interno|centro_?penitenciario|cereso|libertad_?condicional|criminal_?record|conviction|offen[cs]e|detenid[oa]|orden_?de_?aprehension|medida_?cautelar|violencia_?familiar', 0.95]))

domain('MX_PENAL_CAUSA', 'MX_CM_ALFANUM',
  byName(['carpeta_?(de_?)?investigacion|n(o|um|ro)_?carpeta|averiguacion_?previa|n(o|um|ro)_?averiguacion|causa_?penal|n(o|um|ro|umero)_?(de_?)?causa|expediente_?(judicial|penal)|n(o|um|ro)_?expediente_?(judicial|penal)|toca_?penal|n(o|um|ro)_?toca|amparo_?(n(o|um|ro))?|n(o|um|ro)_?(de_?)?denuncia|folio_?denuncia|case_?number', 0.9]),
  byPattern([
    [String.raw`[A-Z]{2,6}(/[A-Z0-9\-]{1,12}){2,}/\d{2,6}[/\-]\d{2,4}`, 0.8],
    [String.raw`\d{1,5}/\d{4}`, 0.5],
  ], { reject: 0.3 }))

// ── Preset ──────────────────────────────────────────────────────────────────

const referenced = JSON.stringify([domains, algorithms.map((x) => x.config)])
const orphans = algorithms.filter((a) => !referenced.includes(`"${a.name}"`))
if (orphans.length) throw new Error(`algorithms nobody uses: ${orphans.map((a) => a.name).join(', ')}`)

// The essential pack: identity documents, names, contact, address and birth date. Loading it brings
// these domains and only what they lean on; the extended pack is everything.
const ESSENTIAL = [
  'MX_L1_CURP', 'MX_L1_RFC', 'MX_L1_NSS', 'MX_L1_CLAVE_ELECTOR', 'MX_L1_PASAPORTE',
  'MX_L1_NOMBRE', 'MX_L1_APELLIDO', 'MX_L1_NOMBRE_COMPLETO', 'MX_L1_EMAIL', 'MX_L1_TELEFONO',
  'MX_L1_DIRECCION', 'MX_L1_DIRECCION_COMPLEMENTO', 'MX_L2_FECHA_NACIMIENTO',
]
const notDomains = ESSENTIAL.filter((name) => !domains.some((d) => d.name === name))
if (notDomains.length) throw new Error(`essential pack names domains the set does not have: ${notDomains.join(', ')}`)

const VERSION = 2
const preset = {
  version: VERSION,
  name: {
    en: 'Mexico — LFPDPPP (personal data held by private parties)',
    'pt-BR': 'México — LFPDPPP (dados pessoais em posse de particulares)',
    es: 'México — LFPDPPP (datos personales en posesión de los particulares)',
  },
  summary: {
    en: 'Discovers and masks Mexican personal data under the 2025 federal law: direct identifiers (CURP, RFC and NSS with valid check digits, INE voter key, CLABE, names, contact), quasi-identifiers (birth date, municipality, postal code), the sensitive data of article 2 and the financial and patrimonial data that need express consent.',
    'pt-BR': 'Descobre e mascara dados pessoais mexicanos segundo a lei federal de 2025: identificadores diretos (CURP, RFC e NSS com dígito verificador válido, chave de eleitor do INE, CLABE, nomes, contato), quase-identificadores (data de nascimento, município, código postal), os dados sensíveis do artigo 2 e os dados financeiros e patrimoniais que exigem consentimento expresso.',
    es: 'Descubre y enmascara datos personales mexicanos conforme a la ley federal de 2025: identificadores directos (CURP, RFC y NSS con dígito verificador válido, clave de elector, CLABE, nombres, contacto), cuasi-identificadores (fecha de nacimiento, municipio, código postal), los datos sensibles del artículo 2 y los datos financieros y patrimoniales que requieren consentimiento expreso.',
  },
  profileSet: {
    name: `MX - LFPDPPP - v${VERSION}`,
    description: 'Identificadores directos, cuasi-identificadores, datos sensibles (art. 2, VI) y datos financieros y patrimoniales (art. 7) de la LFPDPPP 2025.',
    threshold: 60,
    classifiers: classifiers.map((c) => c.name),
  },
  packs: {
    essential: {
      description: 'Paquete esencial de la LFPDPPP 2025: CURP, RFC, NSS, clave de elector, pasaporte, nombres, contacto, domicilio y fecha de nacimiento.',
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
