#!/usr/bin/env node
/**
 * Builds the Spain (Reglamento (UE) 2016/679 and Ley Orgánica 3/2018 de Protección de Datos
 * Personales y garantía de los derechos digitales) pre-configured profile set: preset.json and
 * files/.
 *
 *   node presets/spain-lopdgdd/build.mjs
 *
 * source/ holds the hand-kept lists — the given names and surnames the INE counts most often — and
 * the geography: the 8,132 municipios with their INE code and check digit, province, location and
 * population of the Padrón of 1 January 2025, the 52 provinces, the 19 comunidades and ciudades
 * autónomas, and the postal codes of the Callejero del Censo Electoral with the municipios they
 * reach. Everything in files/ and preset.json is generated from them and from the definitions
 * below — edit here, then build, then run verify.mjs.
 *
 * Structure of the set
 *   L1     direct identifiers      DNI and NIE **with a valid letter**, passport, Seguridad Social
 *                                  number **with valid control digits**, names, contact, address,
 *                                  the IBAN and the CCC **with valid control digits**, cards, the
 *                                  referencia catastral and the CUPS **with valid control letters**,
 *                                  plates, devices, free text
 *   L2     quasi-identifiers       birth date, age, sex, municipio and its INE code, postal code,
 *                                  nationality and residence status, marital status, occupation,
 *                                  employer, education
 *   L3     special categories      art. 9 RGPD and art. 9 LOPDGDD: racial or ethnic origin,
 *                                  political opinions, religious or philosophical beliefs, trade
 *                                  union membership, genetic and biometric data, sex life and
 *                                  sexual orientation — plus gender identity (Ley 4/2023, Ley
 *                                  15/2022) and victims of gender violence (LO 1/2004)
 *   SALUD  health data             art. 9 RGPD, Ley 41/2002 and the additional provision 17 of the
 *                                  LOPDGDD, dependency (Ley 39/2006) and disability
 *   FIN    economic data           credit information systems (art. 20 LOPDGDD), income, assets,
 *                                  benefits and the tax data art. 95 of the Ley General Tributaria
 *                                  calls reserved
 *   PENAL  offences                art. 10 RGPD and art. 10 LOPDGDD, the Registro Central de
 *                                  Delincuentes Sexuales (LO 8/2021, art. 57) and the
 *                                  administrative sanctions of art. 27 LOPDGDD
 */
import fs from 'node:fs'
import nodePath from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = nodePath.dirname(fileURLToPath(import.meta.url))
const SOURCE = nodePath.join(HERE, 'source')
const FILES = nodePath.join(HERE, 'files')

// ── Helpers ─────────────────────────────────────────────────────────────────
const readLines = (name) => fs.readFileSync(nodePath.join(SOURCE, name), 'utf8')
  .split('\n').map((s) => s.replace(/\r$/, '')).filter((s) => s.trim())
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

// Every algorithm carries a sample input: the tester opens it with that value. A lookup nested in
// another algorithm defaults to the first value of its own list.
function lookup(name, fileName, values, input = values[0], caseMode = 'PRESERVE_INPUT') {
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
function cleansing(name, fileName, pairs, input, delimiter = '|') {
  for (const [from, to] of pairs) if (from.includes(delimiter) || to.includes(delimiter)) throw new Error(`${fileName}: "${from}" holds the delimiter`)
  return algorithm(name, 'dataCleansing.DataCleansing', {
    lookupFile: { uri: file(fileName, pairs.map(([from, to]) => `${from}${delimiter}${to}`)) },
    delimiter, caseSensitive: true, trimWhitespace: true,
  }, input)
}

/**
 * String Algorithm Chain. Delphix allows eight algorithms per chain, so a longer chain nests, and
 * each part opens in the tester with the sample input of its own first step.
 */
const inputOf = (name) => algorithms.find((a) => a.name === name)?.input
function chain(name, steps, input) {
  if (steps.length <= 8) return algorithm(name, 'stringAlgorithmChain.StringAlgorithmChain', { algorithmReferences: steps.map(use) }, input)
  const parts = []
  for (let i = 0; i < steps.length; i += 8) {
    const part = steps.slice(i, i + 8)
    // Delphix refuses a chain of one algorithm, so a part of one step goes in as the step itself.
    parts.push(part.length === 1 ? part[0] : chain(`${name}_${parts.length + 1}`, part, inputOf(part[0])))
  }
  return chain(name, parts, input)
}

/**
 * A chain whose steps are built in order from an example, each step getting as sample input the
 * value the steps before it would hand it. `stages` are [build(input) → algorithm name, run(value)
 * → value]; `run` mirrors the step in JavaScript, with masking taken as the identity.
 */
function pipeline(name, example, stages) {
  let value = example
  const steps = []
  for (const [build, run] of stages) {
    steps.push(build(value))
    value = run(value)
  }
  chain(name, steps, example)
  return value
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
  description: 'Nombre de la columna (en castellano, en las otras lenguas oficiales y en inglés).',
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
const pad = (n, width) => String(n).padStart(width, '0')


// ── Source lists ────────────────────────────────────────────────────────────

const GIVEN_NAMES = unique(readLines('nombres.txt'))
const SURNAMES = unique(readLines('apellidos.txt'))

const COMUNIDADES = readLines('comunidades.tsv').map((line) => {
  const [code, name] = line.split('\t')
  return { code, name }
})
const PROVINCIAS = readLines('provincias.tsv').map((line) => {
  const [code, name, aliases, ccaaCode, ccaa, capital, lat, lon, population] = line.split('\t')
  return { code, name, aliases: aliases ? aliases.split(';') : [], ccaaCode, ccaa, capital, lat: Number(lat), lon: Number(lon), population: Number(population) }
})
const provinceByCode = new Map(PROVINCIAS.map((p) => [p.code, p]))
const MUNICIPIOS = readLines('municipios.tsv').map((line) => {
  const [code, dc, name, aliases, provinceCode, province, ccaaCode, lat, lon, population] = line.split('\t')
  return {
    code, dc, name, aliases: aliases ? aliases.split(';') : [],
    provinceCode, province, ccaaCode,
    lat: Number(lat), lon: Number(lon), population: Number(population),
  }
})
/**
 * The first two digits of a postal code are its province. The Callejero lists, for a few codes,
 * street segments filed under a municipio of another province — eight codes have no municipio in
 * their own province at all, one of them with a province 56 that does not exist. Those are left
 * out, and a code's main municipio is the first one of its own province.
 */
const POSTAL_CODES = readLines('codigos-postales.tsv').map((line) => {
  const [code, municipios] = line.split('\t')
  return { code, municipios: municipios.split(';').filter((m) => m.slice(0, 2) === code.slice(0, 2)) }
}).filter((c) => c.municipios.length)
if (COMUNIDADES.length !== 19) throw new Error(`expected 17 comunidades and 2 ciudades autónomas, found ${COMUNIDADES.length}`)
if (PROVINCIAS.length !== 52) throw new Error(`expected the 50 provinces and Ceuta and Melilla, found ${PROVINCIAS.length}`)
if (MUNICIPIOS.length !== 8132) throw new Error(`expected the 8,132 municipios, found ${MUNICIPIOS.length}`)
const municipioByCode = new Map(MUNICIPIOS.map((m) => [m.code, m]))
for (const m of MUNICIPIOS) {
  if (!/^\d{5}$/.test(m.code) || !/^\d$/.test(m.dc) || m.code.slice(0, 2) !== m.provinceCode) throw new Error(`${m.name}: bad INE code ${m.code}`)
  if (Number.isNaN(m.lat) || Number.isNaN(m.lon) || !(m.population >= 0)) throw new Error(`${m.name}: no location or population`)
  if (!provinceByCode.has(m.provinceCode)) throw new Error(`${m.name}: no province`)
}
for (const c of POSTAL_CODES) {
  if (!/^\d{5}$/.test(c.code) || !c.municipios.every((m) => municipioByCode.has(m))) throw new Error(`postal code ${c.code}: bad line`)
}
// Every province holds a municipio of 20,000 — its capital at least — so a generalized municipio
// never leaves its province.
for (const p of PROVINCIAS) {
  if (!MUNICIPIOS.some((m) => m.provinceCode === p.code && m.population >= 20000)) throw new Error(`${p.name}: no municipio of 20,000`)
}


// ── Shared algorithms ───────────────────────────────────────────────────────

// Vowels map to vowels and consonants to consonants, so a masked document number keeps its
// structure; digits map to digits. Separators are in no group and stay. minMaskedPositions 0 lets
// a placeholder such as "N/A" through instead of failing the row.
algorithm('ES_CM_ALFANUM', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'AEIOU', 'BCDFGHJKLMNPQRSTVWXYZ', 'aeiou', 'bcdfghjklmnpqrstvwxyz', 'ÁÉÍÓÚÜ', 'áéíóúü', 'ÀÈÒÏ', 'àèòï'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, 'A1234567')
// Digits only: dots, hyphens and slashes stay.
algorithm('ES_CM_DIGITOS', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '12345678')
// Digits and upper-case letters, one group each: a passport keeps its shape.
algorithm('ES_CM_DIGITOS_LETRAS', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, 'PAA123456')
// Hex letters form their own group, so a MAC, UUID or IPv6 stays valid hex.
algorithm('ES_CM_HEX', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'abcdef', 'ABCDEF', 'ghijklmnopqrstuvwxyz', 'GHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '3c:22:fb:9a:10:e4')
decompose('ES_REDACTAR', [['(.+)', { type: 'REDACT', redactCharacter: 'X' }]], keep, 'clave123')
lookup('ES_SUPRIMIR', 'es-sin-informacion.txt', ['Sin información'], 'Trastorno depresivo recurrente', 'PRESERVE_LOOKUP_FILE')

// Yes/no columns keep their vocabulary: a CHAR(1) S/N stays S/N.
decompose('ES_BANDERA', [
  [String.raw`(?i)(s[ií]|no)`, apply(lookup('ES_BANDERA_SI_NO', 'es-bandera-si-no.txt', ['Sí', 'No']))],
  ['(?i)(true|false)', apply(lookup('ES_BANDERA_TRUE_FALSE', 'es-bandera-true-false.txt', ['true', 'false']))],
  ['(?i)(yes)', apply(lookup('ES_BANDERA_YES_NO', 'es-bandera-yes-no.txt', ['Yes', 'No']))],
  ['(?i)([sn])', apply(lookup('ES_BANDERA_S_N', 'es-bandera-s-n.txt', ['S', 'N']))],
  ['(?i)([yx])', apply(lookup('ES_BANDERA_Y_N', 'es-bandera-y-n.txt', ['Y', 'N']))],
  ['([01])', apply(lookup('ES_BANDERA_0_1', 'es-bandera-0-1.txt', ['0', '1']))],
], keep, 'S')
const FLAG = String.raw`(?i)(s[ií]|no|true|false|yes|[snyx01])`
/**
 * A categorical attribute: flags stay flags, numeric codes are replaced by another code of `codes`
 * (or get other digits), and any other value is replaced by one from `values` — or suppressed, when
 * no list is given.
 */
function categorical(name, fileName, values, input, codes) {
  const replacement = values ? lookup(`${name}_LISTA`, fileName, values) : 'ES_SUPRIMIR'
  const code = codes ? apply(lookup(`${name}_CODIGO`, fileName.replace(/\.txt$/, '-codigos.txt'), codes)) : apply('ES_CM_ALFANUM')
  return decompose(name, [[FLAG, apply('ES_BANDERA')], [String.raw`(\d{1,6})`, code]], apply(replacement), input)
}
categorical('ES_CATEGORIA_SUPRIMIDA', null, null, 'Trastorno depresivo recurrente')
const CM = apply('ES_CM_ALFANUM')
const DIGITS = apply('ES_CM_DIGITOS')

/**
 * Spaces become `_` while a chain works, and come back at the end: a Data Cleansing trims the
 * value it looks up, so a step that saw a space at the edge of its window would find nothing.
 */
const SPACE = '_'
function spaces(name, from, to, input) {
  const other = from === ' ' ? String.raw`[^\s]*` : `[^${from}]*`
  const sep = from === ' ' ? String.raw`(\s)` : `(${from})`
  const patterns = []
  for (let n = 6; n >= 1; n--) {
    const regex = [`(${other})`, ...Array.from({ length: n }, () => `${sep}(${other})`)].join('')
    patterns.push([regex, keep, ...Array.from({ length: n }, () => [redactAs(to), keep]).flat()])
  }
  return decompose(name, patterns, keep, input)
}
const markSpaces = (v) => v.replace(/\s/g, SPACE)
const restoreSpaces = (v) => v.replaceAll(SPACE, ' ')


// ── Check characters computed by lookup tables ──────────────────────────────
//
// Spanish identifiers carry check characters no framework writes: the letter of the DNI is the
// number modulo 23, the control digits of the Seguridad Social number the number modulo 97, the two
// letters of a CUPS the number modulo 529, and the two letters of a referencia catastral a weighted
// sum modulo 23. Check Digit writes one digit modulo a number, never a letter and never two digits.
//
// So the set computes them the way the Costa Rica set computes the IBAN: a **state** — the
// remainder so far, written with as many digits as the modulus needs — is put in front of the
// value and travels right one character at a time. Each step is a Regex Decompose that hands three
// or four characters, "state + next character", to a Data Cleansing whose table answers
// "next character + new state". A step that finds no line for its window — because the state has
// already reached the end, or because the value is shorter — leaves it as it is, so one chain
// serves every written form. At the end a last table turns the remainder into the check characters.

/** Rightward steps: `state + character → character + state'`. */
function stateTable(name, fileName, modulus, width, next, alphabet, input) {
  const pairs = []
  for (let s = 0; s < modulus; s++) {
    for (const c of alphabet) {
      const t = next(s, c)
      if (t !== undefined) pairs.push([`${pad(s, width)}${c}`, `${c}${pad(t, width)}`])
    }
  }
  return cleansing(name, fileName, pairs, input)
}
/** One step that hands the window at position `k` to `table`. */
const stepAt = (name, k, width, table) => [
  (input) => decompose(name, [[`(.{${k}})(.{${width + 1}})(.*)`, keep, apply(table), keep]], keep, input),
  (value) => {
    const window = value.slice(k, k + width + 1)
    const row = tableRows(table).get(window)
    return row === undefined || value.length < k + width + 1 ? value : value.slice(0, k) + row + value.slice(k + width + 1)
  },
]
const rowsCache = new Map()
function tableRows(name) {
  if (!rowsCache.has(name)) {
    const fileName = algorithms.find((a) => a.name === name).config.lookupFile.uri.replace('preset-file://', '')
    rowsCache.set(name, new Map(files.get(fileName).map((line) => line.split('|'))))
  }
  return rowsCache.get(name)
}
const DIGIT_CHARS = [...'0123456789']
const LETTERS_23 = 'TRWAGMYFPDXBNJZSQVHLCKE'

// ── L1 · DNI, NIE and the NIF of a natural person ───────────────────────────
//
// The **DNI** of the Dirección General de la Policía is eight digits and a letter, `12345678Z`, and
// the letter is the number modulo 23 read in the table TRWAGMYFPDXBNJZSQVHLCKE. The **NIE** of a
// foreign national is the same with a prefix that counts as a digit — X 0, Y 1, Z 2 — and seven
// digits: `X1234567L`. The Agencia Tributaria gives a natural person without either a NIF that
// starts with **K** (a Spaniard under 14), **L** (a Spaniard resident abroad) or **M** (a foreigner
// without NIE), seven digits and the same letter of the seven digits alone. Every Spanish system
// validates the letter, so masking the digits without recomputing it produces numbers no form
// accepts.
//
// The digits change; the prefix stays, so a NIE stays a NIE; and the letter is recomputed by a
// state that crosses the value — X, Y and Z count as 0, 1 and 2, K, L and M as nothing, and the
// dots, hyphens and spaces of the written forms are stepped over. A lower-case letter comes back
// lower-case.
//
// The NIF of a **company** — a letter such as A or B, seven digits and a control character — is no
// one's personal data: article 4.1 of the Reglamento reaches natural persons only, and its recital
// 14 says so of legal persons. It passes through untouched.
const DNI_STEP = stateTable('ES_DNI_PASO', 'es-dni-paso.txt', 23, 2, (s, c) => {
  if (/\d/.test(c)) return (s * 10 + Number(c)) % 23
  if ('XYZ'.includes(c.toUpperCase())) return (s * 10 + 'XYZ'.indexOf(c.toUpperCase())) % 23
  if ('KLMklm.-'.includes(c) || c === SPACE) return s
  return undefined
}, [...DIGIT_CHARS, ...'XYZxyzKLMklm.-', SPACE], '00X')
const DNI_LETTER = cleansing('ES_DNI_LETRA_TABLA', 'es-dni-letra.txt',
  Array.from({ length: 23 }, (_, s) => [[`${pad(s, 2)}~`, LETTERS_23[s]], [`${pad(s, 2)}^`, LETTERS_23[s].toLowerCase()]]).flat(), '14~')
const DNI_FIRST = [...DIGIT_CHARS, ...'XYZKLMxyzklm']
function dniChain() {
  const POSITIONS = 12
  return pipeline('ES_DNI', '12345678Z', [
    // The digits change; the prefix of a NIE and the separators stay.
    [(input) => decompose('ES_DNI_CUERPO', [
      [String.raw`([XYZKLMxyzklm])([\s\-]?)(\d{7})([\s\-]?)([A-Za-z])`, keep, keep, DIGITS, keep, keep],
      [String.raw`(\d{1,2}\.\d{3}\.\d{3})([\s\-]?)([A-Za-z])`, DIGITS, keep, keep],
      [String.raw`(\d{6,8})([\s\-]?)([A-Za-z])`, DIGITS, keep, keep],
    ], keep, input), (v) => v],
    [(input) => spaces('ES_DNI_MARCAR', ' ', SPACE, input), markSpaces],
    // A state of 00 goes in front of the first character, and the old letter becomes a marker: `~`
    // for upper case, `^` for lower case.
    [(input) => decompose('ES_DNI_PREPARAR', DNI_FIRST.flatMap((c) => [
      [`(${c})(.*)([A-Z])`, redactAs(`00${c}`), keep, redactAs('~')],
      [`(${c})(.*)([a-z])`, redactAs(`00${c}`), keep, redactAs('^')],
    ]), keep, input), (v) => `00${v.slice(0, -1)}${/[a-z]$/.test(v) ? '^' : '~'}`],
    ...Array.from({ length: POSITIONS }, (_, k) => stepAt(`ES_DNI_PASO_${pad(k, 2)}`, k, 2, DNI_STEP)),
    [(input) => decompose('ES_DNI_LETRA', [[String.raw`(.*)(\d{2}[~^])`, keep, apply(DNI_LETTER)]], keep, input),
      (v) => v.replace(/(\d{2})([~^])$/, (_, s, m) => (m === '~' ? LETTERS_23[Number(s)] : LETTERS_23[Number(s)].toLowerCase()))],
    [(input) => spaces('ES_DNI_RESTAURAR', SPACE, ' ', input), restoreSpaces],
  ])
}
// With the masking taken as the identity, every chain must hand a valid example back unchanged.
if (dniChain() !== '12345678Z') throw new Error('DNI: the chain does not give the letter back')

// A document column holds DNIs, NIEs, the NIF of a company, a passport: each value goes by its shape.
const COMPANY_NIF = String.raw`[ABCDEFGHJNPQRSUVWabcdefghjnpqrsuvw][\s\-]?\d{7}[\s\-]?[0-9A-Ja-j]`
const NIE_SHAPE = String.raw`[XYZxyz][\s\-]?\d{7}[\s\-]?[A-Za-z]`
const NIF_KLM_SHAPE = String.raw`[KLMklm][\s\-]?\d{7}[\s\-]?[A-Za-z]`
const DNI_SHAPE = String.raw`\d{1,2}\.\d{3}\.\d{3}[\s\-]?[A-Za-z]|\d{6,8}[\s\-]?[A-Za-z]`
decompose('ES_DOCUMENTO', [
  [`(${NIE_SHAPE}|${NIF_KLM_SHAPE}|${DNI_SHAPE})`, apply('ES_DNI')],
  [`(${COMPANY_NIF})`, keep],
  // A DNI stored without its letter: the digits change.
  [String.raw`(\d{1,2}\.?\d{3}\.?\d{3})`, DIGITS],
  // A passport: three letters and six digits.
  [String.raw`([A-Za-z]{2,3}\d{6})`, apply('ES_CM_DIGITOS_LETRAS')],
], CM, '12345678Z')

const DOC_OWNER = 'cliente|cli|paciente|pac|usuario|afiliado|asegurado|beneficiario|benef|titular|empleado|emp|trabajador|funcionario|alumno|estudiante|deudor|avalista|fiador|garante|solicitante|propietario|arrendatario|inquilino|conductor|tomador|responsable|representante|apoderado|persona|ciudadano|elector|contribuyente|proveedor|socio|conyuge|padre|madre|hijo|familiar|pensionista|jubilado|interesado|declarante|perceptor'
domain('ES_L1_DNI', 'ES_DOCUMENTO',
  byName(
    // Not the *kind* of document, and not the NIF of a company.
    [`dni|d_n_i|nif(?!_?(empresa|entidad|sociedad|proveedor|pagador|emisor|retenedor))|n_i_f|n(o|ro|um|umero)_?(dni|nif|documento|doc|identificaci[oó]n|id(ent)?)|doc_?identidad|documento_?(nacional_?)?(de_?)?identidad|nro_?doc|num_?doc|(?<!(tipo|tp|cod|codigo|desc|clase)_)identificaci[oó]n(?!_?(tipo|clase|fiscal_?empresa))|nie_?nif|nif_?nie|dni_?nie|nie_?dni|(${DOC_OWNER})_?(dni|nif|doc|documento)|(dni|nif)_?(${DOC_OWNER})|carn[eé]_?(de_?)?conducir|n(o|ro|um|umero)_?permiso_?conducir|driver_?licen[cs]e|national_?id|id_?number`, 0.9],
    ['documento|doc|identificador_?fiscal|nif|tax_?id', 0.6],
  ),
  byType(STRING(6), NUMBER(6)),
  byPattern([
    [String.raw`\d{8}[\s\-]?[TRWAGMYFPDXBNJZSQVHLCKE]`, 0.95, { note: 'DNI' }],
    [String.raw`\d{1,2}\.\d{3}\.\d{3}[\s\-]?[TRWAGMYFPDXBNJZSQVHLCKE]`, 0.95],
    [String.raw`[KLM]\d{7}[TRWAGMYFPDXBNJZSQVHLCKE]`, 0.9],
    // Eight bare digits are a DNI without its letter — and also any eight-digit code, so this only
    // backs up a column name that already says DNI.
    [String.raw`\d{8}`, 0.4],
  ], { reject: 0.3 }))

domain('ES_L1_NIE', 'ES_DOCUMENTO',
  byName([`nie|n_i_e|n(o|ro|um|umero)_?(de_?)?(identidad_?(de_?)?)?extranjero|n(o|ro|um|umero)_?nie|tie|tarjeta_?(de_?)?(identidad_?(de_?)?)?extranjero|tarjeta_?(de_?)?residencia|(${DOC_OWNER})_?nie|nie_?(${DOC_OWNER})|foreigner_?id`, 0.9]),
  byPattern([[String.raw`[XYZ][\s\-]?\d{7}[\s\-]?[TRWAGMYFPDXBNJZSQVHLCKE]`, 0.95]], { reject: 0.3 }))

// The Spanish passport since 2006: three letters and six digits.
domain('ES_L1_PASAPORTE', 'ES_CM_DIGITOS_LETRAS',
  byName(['pasaporte[a-z0-9_]*|n(o|ro|um|umero)_?pasaporte|passaport|pasaportea|passport[a-z0-9_]*', 0.9]),
  // Three letters and six digits are also any internal code (MSG123456), so the values only back up
  // a column name.
  byPattern([[String.raw`[A-Z]{3}\d{6}`, 0.45], [String.raw`[A-Z]{2}\d{6}`, 0.35]], { reject: 0.3 }))

// The support number of the DNI and of the TIE — the IDESP printed on the card, `BAA123456` — is
// asked by banks and administrations to prove that the holder has the document in hand.
domain('ES_L1_SOPORTE_DOCUMENTO', 'ES_CM_DIGITOS_LETRAS',
  byName(['n(o|ro|um|umero)_?(de_?)?soporte(_?(dni|nie|tie|documento))?|soporte_?(dni|nie|tie|documento)|idesp|can_?(dni|nie)|n(o|ro|um|umero)_?can|card_?access_?number', 0.9]),
  byPattern([[String.raw`[A-Z]{3}\d{6}`, 0.4], [String.raw`E\d{8}`, 0.5]], { reject: 0.3 }))

// ── L1 · The Seguridad Social number and its two control digits ─────────────
//
// The Tesorería General de la Seguridad Social numbers every person it has ever affiliated with
// twelve digits: two for the province of the first registration, eight for the number and two of
// control — the first ten read as one number, modulo 97. A number whose eight digits start with a
// zero is an older one, and then the zero does not count: the control is (province × 10⁷ + number)
// modulo 97. The province stays, the eight digits change, and the state crosses the ten digits and
// becomes the two control digits itself; a leading zero is marked `!`, stepped over, and put back.
const NSS_STEP = stateTable('ES_NSS_PASO', 'es-nss-paso.txt', 97, 2, (s, c) => (/\d/.test(c) ? (s * 10 + Number(c)) % 97 : s),
  [...DIGIT_CHARS, '!', '/', '-', SPACE], '002')
const NSS_CONTROL = cleansing('ES_NSS_CONTROL_TABLA', 'es-nss-control.txt', Array.from({ length: 97 }, (_, s) => [`${pad(s, 2)}~`, pad(s, 2)]), '40~')
function nssChain() {
  const POSITIONS = 14
  return pipeline('ES_NSS_CADENA', '281234567840', [
    [(input) => decompose('ES_NSS_CUERPO', [[String.raw`(\d{2})([\s/\-]?)(\d{8})([\s/\-]?)(\d{2})`, keep, keep, DIGITS, keep, keep]], keep, input), (v) => v],
    [(input) => spaces('ES_NSS_MARCAR', ' ', SPACE, input), markSpaces],
    [(input) => decompose('ES_NSS_CERO', [[String.raw`(\d{2}[_/\-]?)(0)(\d{7}.*)`, keep, redactAs('!'), keep]], keep, input),
      (v) => v.replace(/^(\d{2}[_/-]?)0(\d{7})/, '$1!$2')],
    [(input) => decompose('ES_NSS_PREPARAR', DIGIT_CHARS.map((c) => [`(${c})(.*)(\\d{2})`, redactAs(`00${c}`), keep, redactAs('~')]), keep, input),
      (v) => `00${v.slice(0, -2)}~`],
    ...Array.from({ length: POSITIONS }, (_, k) => stepAt(`ES_NSS_PASO_${pad(k, 2)}`, k, 2, NSS_STEP)),
    [(input) => decompose('ES_NSS_CONTROL', [[String.raw`(.*)(\d{2}~)`, keep, apply(NSS_CONTROL)]], keep, input), (v) => v.replace(/~$/, '')],
    [(input) => decompose('ES_NSS_RESTAURAR', [[String.raw`(.*)(!)(.*)`, keep, redactAs('0'), keep]], keep, input), (v) => v.replace('!', '0')],
    [(input) => spaces('ES_NSS_ESPACIOS', SPACE, ' ', input), restoreSpaces],
  ])
}
if (nssChain() !== '281234567840') throw new Error('NSS: the chain does not give the control digits back')
// Only a value of the right shape enters the chain; anything else changes character by character.
decompose('ES_NSS', [[String.raw`(\d{2}[\s/\-]?\d{8}[\s/\-]?\d{2})`, apply('ES_NSS_CADENA')]], CM, '281234567840')
domain('ES_L1_NSS', 'ES_NSS',
  byName(['n(o|ro|um|umero)_?(de_?)?(afiliaci[oó]n|seguridad_?social|ss|naf|nuss|nass)|naf|nuss|nass|afiliaci[oó]n_?(a_?la_?)?(ss|seguridad_?social)|seguridad_?social|num_?ss|nss|n_s_s|social_?security(_?number)?|ssn', 0.9]),
  byType(STRING(11), NUMBER(11)),
  byPattern([[String.raw`(0[1-9]|[1-4]\d|5[0-3]|66)[\s/\-]?\d{8}[\s/\-]?\d{2}`, 0.6]], { reject: 0.3 }))

// The NIA of a pupil and the student number of a university.
domain('ES_L1_CODIGO_ESTUDIANTE', 'ES_CM_ALFANUM',
  byName(['nia|n(o|ro|um|umero)_?(de_?)?(identificaci[oó]n_?(del_?)?)?alumno|n(o|ro|um|umero)_?(de_?)?(matr[ií]cula|expediente)_?(alumno|acad[eé]mico|estudiante)|expediente_?acad[eé]mico|c[oó]digo_?(de_?)?(estudiante|alumno)|cod_?(alumno|estudiante)|id_?(alumno|estudiante)|nre|carn[eé]_?(de_?)?estudiante', 0.8]))

domain('ES_L1_COLEGIADO', 'ES_CM_ALFANUM',
  byName(['n(o|ro|um|umero)_?(de_?)?colegiad[oa]|colegiad[oa]|n(o|ro|um|umero)_?colegio_?profesional|c[oó]digo_?(profesional|m[eé]dico|facultativo)|n(o|ro|um|umero)_?(de_?)?(registro_?profesional|habilitaci[oó]n)|cias_?profesional', 0.85]))


// ── L1 · Names ──────────────────────────────────────────────────────────────

const NOT_A_PERSON = 'producto|prod|item|articulo|empresa|emp|razon|social|comercial|fiscal_?empresa|archivo|fichero|calle|via|avenida|camino|carretera|barrio|municipio|localidad|poblacion|provincia|comunidad|pais|banco|entidad|sucursal|oficina|agencia|plan|campana|proyecto|servicio|tabla|columna|campo|usuario|host|servidor|dominio|marca|modelo|categoria|tipo|centro|colegio|instituto|universidad|curso|asignatura|documento|doc|unidad|clinica|hospital|ambulatorio|seguro|area|departamento|cargo|sistema|app|aplicacion|grupo|lista|informe|proceso|evento|tarea|perfil|rol|clase|objeto|cuenta|medicamento|diagnostico|estudio|programa|prestacion|partido|sindicato|religion|lengua|idioma|lugar|sede|local|tienda|almacen|proveedor|convenio|contrato|poliza|aseguradora|organismo|organizacion|parametro|variable|metodo|funcion|indice|job|script|cola|recurso|red|dispositivo|plantilla|imagen|foto|pagina|sitio|modulo|menu|opcion|accion|permiso|concepto|impuesto|moneda|emisor|factura|pago|forma|zona|linea|actividad|sector|finca|edificio|file|table|column|field|user|server|product|company|category|type|school|document|department|system|group|report|role|account|place|store|supplier|contract|device|image|page|module|action|key|label|code|project|city|country|street|bank'
const PERSON_ROLE = 'cliente|cli|paciente|pac|usuario|afiliado|asegurado|beneficiario|benef|titular|empleado|trabajador|funcionario|alumno|estudiante|deudor|avalista|fiador|garante|solicitante|propietario|arrendatario|inquilino|conductor|tomador|responsable|representante|apoderado|persona|ciudadano|contribuyente|madre|padre|conyuge|contacto|referencia|victima|denunciante|investigado|testigo|medico|docente|socio|heredero|donante|tutor|pensionista|jubilado|interesado|customer|patient|employee|member|holder|mother|father|spouse|contact|person|student|driver|owner'
const PARTICLES = String.raw`(?i)(de|del|la|las|los|y|i|e|da|do|dos|das|san|santa|sant|von|van|di|le)`

algorithm('ES_NOMBRE', 'name.Name', {
  lookupFile: { uri: file('es-nombres.txt', GIVEN_NAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Lucía')
algorithm('ES_APELLIDO', 'name.Name', {
  lookupFile: { uri: file('es-apellidos.txt', SURNAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'García')
// A word of a name. "de", "la", "y" stay where they are: "María de los Ángeles", "Ortega y Gasset",
// "Puig i Cadafalch".
decompose('ES_PALABRA_NOMBRE', [[PARTICLES, keep]], apply('ES_NOMBRE'), 'Montserrat')
decompose('ES_PALABRA_APELLIDO', [[PARTICLES, keep]], apply('ES_APELLIDO'), 'Fernández')
const N = apply('ES_PALABRA_NOMBRE')
const S = apply('ES_PALABRA_APELLIDO')

decompose('ES_NOMBRES', [
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, N],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, N, N],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, N, N],
], CM, 'María de los Ángeles')
decompose('ES_APELLIDOS', [
  [String.raw`(\S+)`, S],
  [String.raw`(\S+)\s+(\S+)`, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, S, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, S, S, S, S],
], CM, 'García Fernández')
// Spanish order: one or two given names, the first surname and the second surname — by law the
// father's and the mother's, in the order the parents chose since Ley 20/2011. Two words are a
// given name and a surname; three, a given name and two surnames; four, two and two.
decompose('ES_NOMBRE_COMPLETO', [
  [String.raw`([^,]+),\s*(.+)`, apply('ES_APELLIDOS'), apply('ES_NOMBRES')],
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, S, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, N, S, S, S],
], CM, 'José Antonio García Fernández')
const NAME_WORDS = ['de', 'del', 'la', 'las', 'los', 'y', 'i']

// Column names in Castilian and in the other official languages: Catalan (nom, cognom), Galician
// (apelido) and Basque (izena, abizena).
domain('ES_L1_NOMBRE', 'ES_NOMBRES',
  byName(
    ['primer_?nombre|segundo_?nombre|nombres?_?(de_?)?pila|nombre_?propio|nombre_?1|nombre_?2|first_?names?|given_?names?|fname|middle_?names?|izena|nom_?(propi|de_?pila)|nombres(?!_?(completos?|y_?apellidos?|apellidos?))', 0.85],
    [`nombre(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|apellidos?|usuario|corto|largo))|nom(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|complet|cognoms?))|name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))`, 0.5],
  ),
  byList([['es-detectar-nombres.txt', [...GIVEN_NAMES, ...NAME_WORDS], 0.7]], { tokenize: true, reject: 0.3 }))

domain('ES_L1_APELLIDO', 'ES_APELLIDOS',
  byName(['apellidos?|primer_?apellido|segundo_?apellido|apellido_?(1|2|paterno|materno)|ape_?(1|2)|apell?_?(1|2)|cognoms?|primer_?cognom|segon_?cognom|apelidos?|abizen(a|ak)|last_?names?|surnames?|family_?names?|lname', 0.85]),
  byList([['es-detectar-apellidos.txt', [...SURNAMES, ...NAME_WORDS], 0.7]], { tokenize: true, reject: 0.3 }))

domain('ES_L1_NOMBRE_COMPLETO', 'ES_NOMBRE_COMPLETO',
  byName(
    [`nombres?_?(completos?|y_?apellidos?|apellidos?)|apellidos?_?(y_?)?nombres?|nombre_?(del_?|de_?la_?)?(${PERSON_ROLE})|(${PERSON_ROLE})_?(nombre|nom)|nom_?(${PERSON_ROLE})|nombre_?(madre|padre|tutor|conyuge|contacto_?emergencia|referencia)|nom_?complet|nom_?i_?cognoms|izen_?abizenak|full_?name|person_?name|razon_?social_?(persona|autonomo)`, 0.9],
    ['madre|padre|tutor|tutora|conyuge|representante_?legal|apoderado|avalista|fiador|beneficiario|heredero|titular|tomador|referencia_?(personal|familiar)', 0.6],
    [`nombre(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|apellidos?|usuario|corto|largo))|nom(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|complet|cognoms?))|name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))`, 0.5],
  ),
  byList([['es-detectar-nombres.txt', [...GIVEN_NAMES, ...NAME_WORDS], 0.65], ['es-detectar-apellidos.txt', [...SURNAMES, ...NAME_WORDS], 0.65]], { tokenize: true, reject: 0.3 }))

// ── L1 · Contact ────────────────────────────────────────────────────────────

decompose('ES_EMAIL', [
  // The top-level domain becomes .test, reserved for tests: a masked address can never deliver.
  [String.raw`([^@\s]+)@([^@\s]+)\.([A-Za-z]{2,24}(?:\.[A-Za-z]{2})?)`, CM, CM, redactAs('test')],
], CM, 'lucia.garcia@gmail.com')
domain('ES_L1_EMAIL', 'ES_EMAIL',
  byName(['e_?mail[a-z0-9_]*|mail[a-z0-9_]*|correo(_?electr[oó]nico)?[a-z0-9_]*|dir_?correo|direcci[oó]n_?(de_?)?correo|direcci[oó]n_?electr[oó]nica|correu(_?electr[oò]nic)?|helbide_?elektronikoa|enderezo_?electr[oó]nico', 0.85]),
  byType(STRING(5)),
  byPattern([[String.raw`[A-Za-z0-9._%+'\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}`, 1]], { reject: 0.2 }))

// Every Spanish number has nine digits: 6 and 7 for a mobile, 8 and 9 for a landline whose first
// digits are the province. The country code and the first digit stay, so a masked number still
// says mobile or landline — and Bizum makes a mobile number a payment address as well.
decompose('ES_TELEFONO', [
  [String.raw`((?:\+|00)34[\s\-]?)([6789])([\d\s\-]{8,13})`, keep, keep, DIGITS],
  [String.raw`(\(?(?:\+|00)34\)?[\s\-]?)([6789])([\d\s\-]{8,13})`, keep, keep, DIGITS],
  [String.raw`([6789])([\d\s\-]{8,13})`, keep, DIGITS],
], DIGITS, '+34 612 34 56 78')
domain('ES_L1_TELEFONO', 'ES_TELEFONO',
  byName(['tel|tlf|tfno|telf|tel[eé]fono[a-z0-9_]*|tel_?(fijo|casa|domicilio|oficina|trabajo|contacto|m[oó]vil)|m[oó]vil|movil[a-z0-9_]*|celular|whats_?app|bizum|n(o|ro|um|umero)_?(tel|tel[eé]fono|m[oó]vil|contacto)|tel[eè]fon|m[oò]bil|telefonoa|sakelako|fax|phone[a-z0-9_]*|mobile[a-z0-9_]*', 0.85]),
  byPattern([
    [String.raw`((\+|00)34[\s\-]?)?[67]\d{2}[\s\-]?\d{2,3}[\s\-]?\d{2,3}[\s\-]?\d{0,2}`, 0.8],
    [String.raw`((\+|00)34[\s\-]?)?[89]\d{1,2}[\s\-]?\d{2,3}[\s\-]?\d{2}[\s\-]?\d{2}`, 0.6],
  ], { reject: 0.3 }))

// A Spanish address is a type of street, a name, a number and the floor and door: "Calle Mayor, 12,
// 3º B". The whole line becomes a fictitious one, in the languages the street signs are written in.
const STREET_TYPES = [['Calle', 0.42], ['C/', 0.12], ['Avenida', 0.1], ['Avda.', 0.05], ['Plaza', 0.07], ['Paseo', 0.04], ['Camino', 0.03], ['Carretera', 0.02], ['Ronda', 0.02], ['Travesía', 0.02], ['Carrer', 0.05], ['Avinguda', 0.02], ['Rúa', 0.02], ['Kalea', 0.02]]
const STREETS = ['Mayor', 'Real', 'de la Iglesia', 'San Juan', 'de la Constitución', 'Cervantes', 'Antonio Machado', 'Federico García Lorca', 'del Sol', 'de la Libertad', 'del Carmen', 'San Francisco', 'Nueva', 'del Pilar', 'de Goya', 'de Castilla', 'de Andalucía', 'de Aragón', 'del Mar', 'de la Estación', 'de las Flores', 'del Río', 'de los Olivos', 'Juan Carlos I', 'Ramón y Cajal', 'Miguel Hernández', 'Rosalía de Castro', 'Pablo Picasso', 'Isaac Peral', 'Severo Ochoa', 'Alfonso XIII', 'de Colón', 'San Antonio', 'Santa María', 'de la Paz', 'del Ayuntamiento', 'de Europa', 'Blasco Ibáñez', 'Doctor Fleming', 'Reyes Católicos', 'Lope de Vega', 'Gran Vía', 'de Galicia', 'de Valencia', 'de la Fuente', 'de las Eras', 'del Molino', 'de la Ermita', 'Virgen del Rosario', 'Clara Campoamor']
const CATALAN_STREETS = ['Major', 'de Sant Pere', 'de la Pau', 'del Mar', 'de Balmes', 'de Mallorca', 'de Pompeu Fabra', 'de Jacint Verdaguer', 'del Sol', 'Nou']
const BASQUE_STREETS = ['Nagusia', 'Askatasuna', 'Elizalde', 'Zumalakarregi', 'Foruen']
const GALICIAN_STREETS = ['do Hórreo', 'Nova', 'da Raíña', 'do Vilar', 'de Rosalía de Castro']
lookup('ES_DIRECCION', 'es-direcciones.txt', (() => {
  const random = seeded(32018)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const num = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
  const type = () => {
    let r = random()
    for (const [t, p] of STREET_TYPES) { if ((r -= p) < 0) return t }
    return 'Calle'
  }
  const floor = () => pick([`${num(1, 9)}º ${pick(['A', 'B', 'C', 'D', 'izda.', 'dcha.', '1ª', '2ª'])}`, 'bajo', `bajo ${pick(['A', 'B'])}`, 'entresuelo', 'ático', `${num(1, 6)}º`, ''])
  const out = new Set()
  while (out.size < 4000) {
    const t = type()
    const n = num(1, 180)
    const f = floor()
    let street
    if (t === 'Carrer' || t === 'Avinguda') street = `${t} ${pick(CATALAN_STREETS)}`
    else if (t === 'Kalea') street = `${pick(BASQUE_STREETS)} kalea`
    else if (t === 'Rúa') street = `Rúa ${pick(GALICIAN_STREETS)}`
    else street = `${t} ${pick(STREETS)}`
    out.add(f ? `${street}, ${n}, ${f}` : `${street}, ${n}`)
  }
  return [...out]
})(), 'Calle Mayor, 12, 3º B', 'PRESERVE_LOOKUP_FILE')
domain('ES_L1_DIRECCION', 'ES_DIRECCION',
  byName(['(?<!(mac|ip|e_?mail|web|url|correo)_?)direcci[oó]n(?!_?(ip|mac|email|e_?mail|correo|electr[oó]nica|web|url|tipo|id|general|provincial|territorial))[a-z0-9_]*|domicilio[a-z0-9_]*|dom_?(particular|fiscal|social_?persona)|residencia(_?habitual)?|lugar_?(de_?)?residencia|nombre_?(de_?la_?)?(v[ií]a|calle)|v[ií]a_?(p[uú]blica)?|calle|adre[çc]a|domicili|enderezo|helbidea|(?<!(mac|ip|e_?mail|web|url)_?)address(?!_?(ip|mac|email|e_?mail|web|url|type|id))[a-z0-9_]*', 0.8]),
  byType(STRING(6)),
  byPattern([
    [String.raw`(?i)(calle|c/|avenida|avda\.?|av\.|plaza|pza\.?|paseo|p[ºo]\.?|camino|carretera|ctra\.?|ronda|traves[ií]a|glorieta|r[uú]a|carrer|avinguda|pla[çc]a|passeig|kalea|etorbidea)\s+.{2,60}\d.*`, 0.85],
    [String.raw`(?i).*\b\d{1,3}\s*,?\s*(\d{1,2}\s*[ºª°]|bajo|entresuelo|[aá]tico|izda?\.?|dcha?\.?)\b.*`, 0.7],
  ], { reject: 0.2 }))

domain('ES_L1_DIRECCION_COMPLEMENTO', 'ES_CM_ALFANUM',
  byName(['piso|planta|puerta|escalera|esc|portal|bloque|bl|letra_?puerta|n(o|ro|um|umero)_?(de_?)?(v[ií]a|calle|portal|casa)|num_?via|km|kil[oó]metro|urbanizaci[oó]n_?(nombre)?|complemento(_?direcci[oó]n)?|resto_?direcci[oó]n|apartado(_?(de_?)?correos)?|apdo|pis|porta|escala|solairua|atea|p_?o_?box', 0.7]))


// ── L1 · Bank accounts: the CCC, the IBAN and their control digits ──────────
//
// A Spanish account has twenty digits, the Código Cuenta Cliente: four for the bank, four for the
// branch, two control digits and ten for the account. The first control digit checks bank and
// branch, the second the account, each a weighted sum modulo 11 with the weights 1 2 4 8 5 10 9 7 3 6,
// eleven minus the remainder, 0 for eleven and 1 for ten. The IBAN puts `ES` and two more control
// digits in front, the ISO 13616 ones, modulo 97.
//
// Masking only the ten digits of the account keeps bank, branch and the first control digit valid.
// The plugin's IBAN algorithm masks the account and recomputes the IBAN digits — but not the second
// control digit, which no foreign IBAN has, so its output fails every Spanish check. The set fixes
// that: a state crosses the account from right to left and becomes the new second digit, the old
// and the new digit travel left to the IBAN digits as a pair, and a table of 10,000 lines corrects
// the IBAN digits for the change — (new − old) · 10¹⁶ modulo 97, since that is what the second
// digit weighs in the number the IBAN checks. The pair then disappears and the IBAN is valid again.
const CCC_WEIGHTS = [1, 2, 4, 8, 5, 10, 9, 7, 3, 6]
const cccDigit = (s) => (s === 0 ? 0 : s === 1 ? 1 : 11 - s)
// Right to left, Σ dᵢ·2ⁱ is d₀ + 2(d₁ + 2(d₂ + …)): each step doubles the state and adds the digit.
const CCC_STEP = cleansing('ES_CCC_PASO', 'es-ccc-paso.txt', Array.from({ length: 11 }, (_, s) => [
  ...DIGIT_CHARS.map((c) => [`${c}${pad(s, 2)}`, `${pad((2 * s + Number(c)) % 11, 2)}${c}`]),
  [`${SPACE}${pad(s, 2)}`, `${pad(s, 2)}${SPACE}`],
  [`-${pad(s, 2)}`, `${pad(s, 2)}-`],
]).flat(), '200')
// The old second digit waits as a letter a–j, which no step reads.
const OLD = (d) => 'abcdefghij'[d]
const CCC_FINAL = cleansing('ES_CCC_CONTROL_TABLA', 'es-ccc-control.txt',
  DIGIT_CHARS.flatMap((d) => Array.from({ length: 11 }, (_, s) => [`${OLD(Number(d))}${pad(s, 2)}`, String(cccDigit(s))])), 'f05')
const IBAN_FINAL = cleansing('ES_IBAN_CONTROL_TABLA', 'es-iban-control.txt',
  DIGIT_CHARS.flatMap((d) => Array.from({ length: 11 }, (_, s) => [`${OLD(Number(d))}${pad(s, 2)}`, `${d}${cccDigit(s)}${cccDigit(s)}`])), 'f05')
// The pair "old new" travels left over bank, branch and first digit.
const IBAN_CARRY = cleansing('ES_IBAN_TRASLADO', 'es-iban-traslado.txt',
  [...DIGIT_CHARS, SPACE].flatMap((c) => Array.from({ length: 100 }, (_, ab) => [`${c}${pad(ab, 2)}`, `${pad(ab, 2)}${c}`])), '456')
// 10¹⁶ ≡ 89 (mod 97).
const P16 = Number((10n ** 16n) % 97n)
const IBAN_DELTA = cleansing('ES_IBAN_AJUSTE', 'es-iban-ajuste.txt',
  Array.from({ length: 100 }, (_, kk) => DIGIT_CHARS.flatMap((a) => DIGIT_CHARS.map((b) => {
    const r = (((98 - kk) % 97) + 97) % 97
    const r2 = (((r + (Number(b) - Number(a)) * P16) % 97) + 97) % 97
    return [`${pad(kk, 2)}${a}${b}`, pad(98 - r2, 2)]
  }))).flat(), '9156')

const cccSum = (account) => [...account].reduce((t, c, i) => t + Number(c) * CCC_WEIGHTS[i], 0) % 11
/** The state crosses the account leftwards. `j` counts the characters already passed. */
const stepLeft = (name, j, table) => [
  (input) => decompose(name, [[`(.*)(.{3})(.{${j}})`, keep, apply(table), keep]], keep, input),
  (value) => {
    const at = value.length - j - 3
    if (at < 0) return value
    const row = tableRows(table).get(value.slice(at, at + 3))
    return row === undefined ? value : value.slice(0, at) + row + value.slice(at + 3)
  },
]
const stepRight = (name, k, table) => stepAt(name, k, 2, table)
/** The old second digit becomes a letter; a state of 00 goes after the last digit. */
const markOld = (name, head) => [
  (input) => decompose(name, DIGIT_CHARS.map((d) => [`(${head})(${d})(.*)`, keep, redactAs(OLD(Number(d))), keep]), keep, input),
  (value) => value.replace(new RegExp(`^(${head})(\\d)`), (_, h, d) => `${h}${OLD(Number(d))}`),
]
const stateAtEnd = (name) => [
  (input) => decompose(name, DIGIT_CHARS.map((d) => [`(.*)(${d})`, keep, redactAs(`${d}00`)]), keep, input),
  (value) => `${value}00`,
]

// The CCC alone: twenty digits, with or without separators.
const CCC_HEAD = String.raw`\d{4}[\s\-_]?\d{4}[\s\-_]?\d`
const CCC_BACK = pipeline('ES_CCC', '21000418450200051332', [
  [(input) => decompose('ES_CCC_CUENTA', [[String.raw`(\d{4}[\s\-]?\d{4}[\s\-]?\d{2}[\s\-]?)(\d{10})`, keep, DIGITS]], keep, input), (v) => v],
  [(input) => spaces('ES_CCC_MARCAR', ' ', SPACE, input), markSpaces],
  markOld('ES_CCC_ANTERIOR', CCC_HEAD),
  stateAtEnd('ES_CCC_ESTADO'),
  ...Array.from({ length: 11 }, (_, j) => stepLeft(`ES_CCC_PASO_${pad(j, 2)}`, j, CCC_STEP)),
  [(input) => decompose('ES_CCC_CONTROL', [[String.raw`(.*)([a-j]\d{2})(.*)`, keep, apply(CCC_FINAL), keep]], keep, input),
    (v) => v.replace(/([a-j])(\d{2})/, (_, m, s) => String(cccDigit(Number(s))))],
  [(input) => spaces('ES_CCC_RESTAURAR', SPACE, ' ', input), restoreSpaces],
])
if (CCC_BACK !== '21000418450200051332') throw new Error(`CCC: the chain gives ${CCC_BACK}`)

// The plugin's IBAN algorithm masks the last characters of the value — ten digits of the compact
// form, twelve characters of the printed one — and recomputes the IBAN digits.
algorithm('ES_IBAN_COMPACTO_MASCARA', 'iban.IBAN', { validateInput: false, numCharsToMask: 10 }, 'ES9121000418450200051332')
algorithm('ES_IBAN_IMPRESO_MASCARA', 'iban.IBAN', { validateInput: false, numCharsToMask: 12 }, 'ES91 2100 0418 4502 0005 1332')
function ibanChain(name, example, mask, head, accountChars, carryFrom) {
  return pipeline(name, example, [
    [() => mask, (v) => v],
    [(input) => spaces(`${name}_MARCAR`, ' ', SPACE, input), markSpaces],
    markOld(`${name}_ANTERIOR`, head),
    stateAtEnd(`${name}_ESTADO`),
    ...Array.from({ length: accountChars }, (_, j) => stepLeft(`${name}_PASO_${pad(j, 2)}`, j, CCC_STEP)),
    // "old, state" becomes "old, new, new": the pair travels, the second new stays in place.
    [(input) => decompose(`${name}_CONTROL`, [[`(.*)([a-j]\\d{2})(.{${accountChars}})`, keep, apply(IBAN_FINAL), keep]], keep, input),
      (v) => v.replace(/([a-j])(\d{2})(?=.{10,12}$)/, (_, m, s) => `${'abcdefghij'.indexOf(m)}${cccDigit(Number(s))}${cccDigit(Number(s))}`)],
    ...Array.from({ length: carryFrom - 3 }, (_, i) => stepRight(`${name}_TRASLADO_${pad(i, 2)}`, carryFrom - i, IBAN_CARRY)),
    [(input) => decompose(`${name}_AJUSTE`, [[String.raw`(ES)(\d{4})(.*)`, keep, apply(IBAN_DELTA), keep]], keep, input),
      (v) => v.replace(/^ES(\d{2})(\d)(\d)/, (_, kk, a, b) => `ES${tableRows(IBAN_DELTA).get(`${kk}${a}${b}`)}`)],
    [(input) => spaces(`${name}_RESTAURAR`, SPACE, ' ', input), restoreSpaces],
  ])
}
// Compact: ES kk, then bank, branch and first digit (nine characters) before the old second digit.
// Printed: ES kk, then " 2100 0418 4" — twelve characters with three spaces.
const IBAN_BACK = ibanChain('ES_IBAN_COMPACTO', 'ES9121000418450200051332', 'ES_IBAN_COMPACTO_MASCARA', String.raw`ES\d{11}`, 10, 12)
const IBAN_PRINTED_BACK = ibanChain('ES_IBAN_IMPRESO', 'ES91 2100 0418 4502 0005 1332', 'ES_IBAN_IMPRESO_MASCARA', String.raw`ES\d{2}_\d{4}_\d{4}_\d`, 12, 15)

if (IBAN_BACK !== 'ES9121000418450200051332' || IBAN_PRINTED_BACK !== 'ES91 2100 0418 4502 0005 1332') throw new Error(`IBAN: the chains give ${IBAN_BACK} and ${IBAN_PRINTED_BACK}`)
decompose('ES_CUENTA', [
  [String.raw`(ES\d{22})`, apply('ES_IBAN_COMPACTO')],
  [String.raw`(ES\d{2} \d{4} \d{4} \d{4} \d{4} \d{4})`, apply('ES_IBAN_IMPRESO')],
  [String.raw`(\d{4}[\s\-]?\d{4}[\s\-]?\d{2}[\s\-]?\d{10})`, apply('ES_CCC')],
], DIGITS, 'ES9121000418450200051332')
domain('ES_L1_CUENTA_BANCARIA', 'ES_CUENTA',
  byName(['cuenta_?(bancaria|banco|corriente|ahorros?|cliente|n[oó]mina|abono|cargo|domiciliaci[oó]n|iban|ccc)|n(o|ro|um|umero)_?(de_?)?(cuenta|cta)|nro_?cta|num_?cta|cta_?(cte|corriente|bancaria|cargo|abono)|iban[a-z0-9_]*|ccc|c_c_c|c[oó]digo_?cuenta_?cliente|compte(_?bancari)?|kontu_?zenbakia|conta_?banc[aá]ria|account_?(no|num|number)|bank_?account', 0.9]),
  byPattern([
    [String.raw`ES\d{22}`, 0.95],
    [String.raw`ES\d{2}( \d{4}){5}`, 0.95],
    [String.raw`\d{4}[\s\-]?\d{4}[\s\-]?\d{2}[\s\-]?\d{10}`, 0.7],
  ], { reject: 0.3 }))

// ── L1 · Cards, wallets, network, devices ───────────────────────────────────

// Payment Card fails a row that has no digits to mask; only values shaped like a card reach it.
algorithm('ES_TARJETA_LUHN', 'characterMapping.PaymentCard', { minMaskedPositions: 6, preserve: 0 }, '4532000000000001')
decompose('ES_TARJETA', [[String.raw`(\d[\d\s\-]{11,22}\d)`, apply('ES_TARJETA_LUHN')]], keep, '4532 0000 0000 0001')
domain('ES_L1_TARJETA', 'ES_TARJETA',
  byName(['tarjeta(_?(cr[eé]dito|d[eé]bito|n(o|ro|um|umero)))?|n(o|ro|um|umero)_?tarjeta|pan|targeta|txartela|card_?(no|num|number)|credit_?card', 0.85]),
  // 0.9, not 1: an IMEI is 15 Luhn-valid digits too, and its own column name should win.
  byPattern([[String.raw`\d{13,19}`, 0.9, { checksum: 'LUHN', clean: String.raw`[\s\-]` }]], { reject: 0.3 }))

domain('ES_L1_BILLETERA', 'ES_CM_ALFANUM',
  byName(['monedero(_?(digital|electr[oó]nico))?|billetera(_?(digital|electr[oó]nica))?|wallet(_?(id|address|direccion))?|direcci[oó]n_?(bitcoin|btc|wallet|cripto)|btc_?(address|direccion)|cartera_?(cripto|digital)', 0.85]),
  byPattern([[String.raw`(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,59}`, 0.7]], { reject: 0.3 }))

algorithm('ES_OCTETO', 'characterMapping.NumericMapping', { minValue: 1, maxValue: 254 }, '10')
decompose('ES_IP', [
  [String.raw`(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})`, apply('ES_OCTETO'), apply('ES_OCTETO'), apply('ES_OCTETO'), apply('ES_OCTETO')],
], apply('ES_CM_HEX'), '83.45.120.12')
domain('ES_L1_IP', 'ES_IP',
  byName(['ip|ip_?(address|addr|origen|destino|cliente|usuario|acceso|login|remota|publica)|direcci[oó]n_?ip|dir_?ip|adre[çc]a_?ip|ipv[46]|remote_?addr(ess)?|client_?ip|host_?ip', 0.85]),
  byPattern([
    [String.raw`((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)`, 1],
    [String.raw`[0-9A-Fa-f]{1,4}(:[0-9A-Fa-f]{0,4}){2,7}`, 0.9],
  ], { reject: 0.3 }))

domain('ES_L1_DISPOSITIVO', 'ES_CM_HEX',
  byName(['imei|imsi|iccid|mac|mac_?address|direcci[oó]n_?mac|device_?(id|uuid|serial)|id_?(dispositivo|equipo|terminal)|serial_?(equipo|terminal|dispositivo)|advertising_?id|idfa|gaid|session_?id|id_?sesi[oó]n', 0.8]),
  byPattern([
    [String.raw`([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}`, 1],
    [String.raw`\d{15}`, 0.8, { checksum: 'LUHN' }],
  ], { reject: 0.3 }))

domain('ES_L1_COOKIE', 'ES_CM_ALFANUM',
  byName(['cookie(_?(id|value|valor|nombre))?|cookies|_?ga|_?gid|fbp|fbclid|utm_?(source|medium|campaign|term|content)|id_?(navegador|browser|visitante)|visitor_?id|tracking_?id|client_?id', 0.8]))

// ── L1 · Vehicles ───────────────────────────────────────────────────────────
//
// Since 2000 a plate is four digits and three consonants, `1234 BCD`: no vowels, and neither Ñ nor
// Q. The older provincial plates carry the province, `M-1234-AB`, which stays. The letters are
// masked inside the alphabet the Dirección General de Tráfico uses, so a masked plate is still a
// plate.
algorithm('ES_CM_MATRICULA', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'BCDFGHJKLMNPRSTVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '1234 BCD')
decompose('ES_MATRICULA', [
  [String.raw`(\d{4})([\s\-]?)([BCDFGHJKLMNPRSTVWXYZ]{3})`, DIGITS, keep, apply('ES_CM_MATRICULA')],
  // The provincial series used every letter, vowels included.
  [String.raw`([A-Z]{1,2})([\s\-]?)(\d{4})([\s\-]?)([A-Z]{1,2})`, keep, keep, DIGITS, keep, apply('ES_CM_DIGITOS_LETRAS')],
  // Special plates: E for works vehicles, R for trailers, C for mopeds, H for historic ones.
  [String.raw`([ERCH])([\s\-]?)(\d{4})([\s\-]?)([BCDFGHJKLMNPRSTVWXYZ]{3})`, keep, keep, DIGITS, keep, apply('ES_CM_MATRICULA')],
], apply('ES_CM_DIGITOS_LETRAS'), '1234 BCD')
domain('ES_L1_MATRICULA', 'ES_MATRICULA',
  byName(['matr[ií]cula(?!_?(alumno|estudiante|acad[eé]mica|universitaria|curso|profesional))(_?(veh[ií]culo|coche|moto|turismo))?|n(o|ro|um|umero)_?matr[ií]cula|placa(_?matr[ií]cula)?|matr[ií]cula_?vehicle|license_?plate|plate(_?(no|number))?', 0.85]),
  byPattern([
    [String.raw`\d{4}[\s\-]?[BCDFGHJKLMNPRSTVWXYZ]{3}`, 0.9],
    [String.raw`[A-Z]{1,2}[\s\-]?\d{4}[\s\-]?[A-Z]{1,2}`, 0.6],
  ], { reject: 0.3 }))

domain('ES_L1_VEHICULO', 'ES_CM_ALFANUM',
  byName(['vin|bastidor|n(o|ro|um|umero)_?(de_?)?(bastidor|chasis|motor|serie|vin)|motor_?n(o|ro|um|umero)|itv|n(o|ro|um|umero)_?(de_?)?itv|permiso_?(de_?)?circulaci[oó]n|ficha_?t[eé]cnica', 0.85]),
  byPattern([[String.raw`[A-HJ-NPR-Z0-9]{17}`, 0.7]], { reject: 0.3 }))

// ── L1 · Property and supply: the referencia catastral and the CUPS ─────────
//
// The **referencia catastral** names every property in the Catastro with twenty characters: seven
// digits for the block and parcel of an urban property and seven for the map sheet, `9872023
// VH5797S`, or, for a rural one, the municipio, the sector, the polígono and the parcel; then four
// digits for the unit inside it, and two control letters. Each letter is a weighted sum of eleven
// characters — the weights 13 15 12 5 4 17 9 21 3 7 1 — modulo 23, read in the table
// MQWERTYUIOPASDFGHJKLBZX. The first letter checks the first half and the unit, the second the
// second half and the unit.
//
// The set masks the digits that name the parcel — the first seven of an urban reference, the five
// of the parcel of a rural one — and keeps the sheet or the polígono, which say where the property
// is no more precisely than a district. Only one letter depends on what changed, and a state
// recomputes it, step by step, with the weight of each position: the steps that cross the sheet
// carry the state without counting. Article 51 of the Texto Refundido de la Ley del Catastro
// Inmobiliario makes the holder of a property a protected datum; the reference beside a person's
// name is that link.
const RC_WEIGHTS = [13, 15, 12, 5, 4, 17, 9, 21, 3, 7, 1]
const RC_LETTERS = 'MQWERTYUIOPASDFGHJKLBZX'
const rcValue = (c) => (/\d/.test(c) ? Number(c) : c.charCodeAt(0) - 64 > 14 ? c.charCodeAt(0) - 63 : c.charCodeAt(0) - 64)
const RC_WEIGHT_TABLE = new Map(unique(RC_WEIGHTS).map((w) => [w, stateTable(`ES_RC_PESO_${pad(w, 2)}`, `es-rc-peso-${pad(w, 2)}.txt`, 23, 2, (s, c) => (s + Number(c) * w) % 23, DIGIT_CHARS, '005')]))
const RC_CARRY = stateTable('ES_RC_TRASLADO', 'es-rc-traslado.txt', 23, 2, (s) => s, [...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'], '05V')
const rcCheck = (rc) => [rc.slice(0, 7) + rc.slice(14, 18), rc.slice(7, 14) + rc.slice(14, 18)].map((s) => RC_LETTERS[[...s].reduce((t, c, i) => t + rcValue(c) * RC_WEIGHTS[i], 0) % 23]).join('')
const RC_FINAL = cleansing('ES_RC_LETRA_TABLA', 'es-rc-letra.txt',
  Array.from({ length: 23 }, (_, s) => [...RC_LETTERS].map((k) => [`${pad(s, 2)}${k}`, RC_LETTERS[s]])).flat(), '22W')
// Urban: the weights of positions 0–6 and 14–17 count, the sheet at 7–13 is carried.
const RC_URBAN = pipeline('ES_RC_URBANA', '9872023VH5797S0001WX', [
  [(input) => decompose('ES_RC_URBANA_PARCELA', [[String.raw`(\d{7})([A-Z0-9]{7}\d{4}[A-Z]{2})`, DIGITS, keep]], keep, input), (v) => v],
  [(input) => decompose('ES_RC_URBANA_PREPARAR', DIGIT_CHARS.map((d) => [`(${d})(.*)`, redactAs(`00${d}`), keep]), keep, input), (v) => `00${v}`],
  ...Array.from({ length: 18 }, (_, k) => stepAt(`ES_RC_URBANA_PASO_${pad(k, 2)}`, k, 2,
    k < 7 ? RC_WEIGHT_TABLE.get(RC_WEIGHTS[k]) : k < 14 ? RC_CARRY : RC_WEIGHT_TABLE.get(RC_WEIGHTS[k - 7]))),
  [(input) => decompose('ES_RC_URBANA_LETRA', [[String.raw`(.{18})(.{3})(.)`, keep, apply(RC_FINAL), keep]], keep, input),
    (v) => `${v.slice(0, 18)}${RC_LETTERS[Number(v.slice(18, 20))]}${v.slice(21)}`],
])
// Rural: the second letter, over positions 7–17; the state then steps over the first letter.
const RURAL_EXAMPLE = `13077A018000390000${rcCheck('13077A018000390000')}`
const RC_RURAL = pipeline('ES_RC_RUSTICA', RURAL_EXAMPLE, [
  [(input) => decompose('ES_RC_RUSTICA_PARCELA', [[String.raw`(\d{5}[A-Z]\d{3})(\d{5})(\d{4}[A-Z]{2})`, keep, DIGITS, keep]], keep, input), (v) => v],
  [(input) => decompose('ES_RC_RUSTICA_PREPARAR', DIGIT_CHARS.map((d) => [`(.{7})(${d})(.*)`, keep, redactAs(`00${d}`), keep]), keep, input), (v) => `${v.slice(0, 7)}00${v.slice(7)}`],
  ...Array.from({ length: 11 }, (_, i) => stepAt(`ES_RC_RUSTICA_PASO_${pad(i, 2)}`, 7 + i, 2, RC_WEIGHT_TABLE.get(RC_WEIGHTS[i]))),
  stepAt('ES_RC_RUSTICA_PASO_11', 18, 2, RC_CARRY),
  [(input) => decompose('ES_RC_RUSTICA_LETRA', [[String.raw`(.{19})(.{3})`, keep, apply(RC_FINAL)]], keep, input),
    (v) => `${v.slice(0, 19)}${RC_LETTERS[Number(v.slice(19, 21))]}`],
])
if (RC_URBAN !== '9872023VH5797S0001WX' || rcCheck('9872023VH5797S0001WX') !== 'WX') throw new Error(`referencia catastral: the urban chain gives ${RC_URBAN}`)
if (RC_RURAL !== RURAL_EXAMPLE) throw new Error(`referencia catastral: the rural chain gives ${RC_RURAL}`)
decompose('ES_REFERENCIA_CATASTRAL', [
  [String.raw`(\d{7}[A-Z0-9]{7}\d{4}[A-Z]{2})`, apply('ES_RC_URBANA')],
  [String.raw`(\d{5}[A-Z]\d{12}[A-Z]{2})`, apply('ES_RC_RUSTICA')],
  // Written in groups, or only the fourteen characters of the parcel: the parcel digits change, the
  // control letters are not recomputed.
  [String.raw`(\d{7})(\s?[A-Z0-9]{7}.*)`, DIGITS, keep],
], CM, '9872023VH5797S0001WX')
domain('ES_L1_REFERENCIA_CATASTRAL', 'ES_REFERENCIA_CATASTRAL',
  byName(['ref(erencia)?_?catastral|rc_?(inmueble|finca|catastral)|n(o|ro|um|umero)_?(de_?)?(finca|finca_?registral|registral|inmueble)|finca_?registral|catastro|refer[eè]ncia_?cadastral|erreferentzia_?katastrala|cadastral_?reference', 0.9]),
  byPattern([[String.raw`\d{7}[A-Z0-9]{7}\d{4}[A-Z]{2}`, 0.9], [String.raw`\d{5}[A-Z]\d{12}[A-Z]{2}`, 0.9]], { reject: 0.3 }))

// The **CUPS** names every electricity and gas supply point: `ES`, four digits for the distributor,
// twelve for the point, and two control letters — the sixteen digits modulo 529, divided by 23, read
// as two letters of the DNI table. A CUPS names a home: the bill, the consumption curve of the smart
// meter and the social bonus all hang from it. The distributor stays, the twelve digits change, and
// a state of three digits crosses the value; a suffix such as `0F` stays.
const CUPS_STEP = stateTable('ES_CUPS_PASO', 'es-cups-paso.txt', 529, 3, (s, c) => (/\d/.test(c) ? (s * 10 + Number(c)) % 529 : s), [...DIGIT_CHARS, 'E', 'S', SPACE], '000E')
const CUPS_FINAL = cleansing('ES_CUPS_LETRAS_TABLA', 'es-cups-letras.txt',
  Array.from({ length: 529 }, (_, s) => [`${pad(s, 3)}~`, `${LETTERS_23[Math.floor(s / 23)]}${LETTERS_23[s % 23]}`]), '473~')
const cupsCheck = (sixteen) => { const r = Number(BigInt(sixteen) % 529n); return `${LETTERS_23[Math.floor(r / 23)]}${LETTERS_23[r % 23]}` }
const CUPS = pipeline('ES_CUPS_CADENA', 'ES1234123456789012JY', [
  [(input) => decompose('ES_CUPS_PUNTO', [
    [String.raw`(ES\s?\d{4}\s?)(\d{4}\s?\d{4}\s?\d{4})(.*)`, keep, DIGITS, keep],
  ], keep, input), (v) => v],
  [(input) => spaces('ES_CUPS_MARCAR', ' ', SPACE, input), markSpaces],
  [(input) => decompose('ES_CUPS_PREPARAR', [
    [String.raw`(E)(.*[\d_])([A-Za-z]{2})(\d[A-Za-z])`, redactAs('000E'), keep, redactAs('~'), keep],
    [String.raw`(E)(.*[\d_])([A-Za-z]{2})`, redactAs('000E'), keep, redactAs('~')],
  ], keep, input), (v) => v.replace(/^E(.*[\d_])[A-Za-z]{2}(\d[A-Za-z])?$/, (_, mid, suffix) => `000E${mid}~${suffix ?? ''}`)],
  ...Array.from({ length: 22 }, (_, k) => stepAt(`ES_CUPS_PASO_${pad(k, 2)}`, k, 3, CUPS_STEP)),
  [(input) => decompose('ES_CUPS_LETRAS', [[String.raw`(.*)(\d{3}~)(.*)`, keep, apply(CUPS_FINAL), keep]], keep, input),
    (v) => v.replace(/(\d{3})~/, (_, s) => `${LETTERS_23[Math.floor(Number(s) / 23)]}${LETTERS_23[Number(s) % 23]}`)],
  [(input) => spaces('ES_CUPS_RESTAURAR', SPACE, ' ', input), restoreSpaces],
])
if (CUPS !== `ES1234123456789012${cupsCheck('1234123456789012')}`) throw new Error(`CUPS: the chain gives ${CUPS}`)
decompose('ES_CUPS', [[String.raw`(ES\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?[A-Za-z]{2}(?:\d[A-Za-z])?)`, apply('ES_CUPS_CADENA')]], CM, 'ES1234123456789012JY')
domain('ES_L1_CUPS', 'ES_CUPS',
  byName(['cups|c_u_p_s|c[oó]digo_?(universal_?)?(del_?)?punto_?(de_?)?suministro|punto_?(de_?)?suministro|cups_?(luz|gas|electricidad|electrico)', 0.95]),
  byPattern([[String.raw`ES\d{16}[A-Z]{2}(\d[A-Z])?`, 0.95]], { reject: 0.3 }))

domain('ES_L1_CONTRATO', 'ES_CM_ALFANUM',
  byName(['n(o|ro|um|umero)_?(contrato|p[oó]liza|pr[eé]stamo|solicitud|expediente_?(administrativo|interno)|tr[aá]mite|referencia|cliente|socio|abonado|suministro|servicio|caso|ticket|siniestro|reclamaci[oó]n|incidencia)|contrato_?(n(o|ro|um|umero))|c[oó]digo_?(cliente|socio|empleado|afiliado|abonado)|id_?(cliente|socio|empleado|afiliado)|n(o|ro)_?(empleado|personal|registro_?personal)|nrp|matr[ií]cula_?(empleado|personal)', 0.7]))

domain('ES_L1_USUARIO', 'ES_CM_ALFANUM',
  byName(['usuario|user_?name|username|login|alias|apodo|nick(_?name)?|perfil_?(instagram|facebook|twitter|tiktok|linkedin|x)|instagram|facebook|twitter|tiktok|linkedin|red_?social|handle|usuari|erabiltzailea', 0.7]))

domain('ES_L1_CREDENCIAL', 'ES_REDACTAR',
  byName(['contrase[nñ]a|clave(?!_?(catastral|primaria|for[aá]nea|valor|producto|cuenta_?cotizacion))|password|passwd|pwd|pass|hash_?(clave|contrasena|password)|pin|c[oó]digo_?(seguridad|verificaci[oó]n|acceso|otp)|cvv|cvc|token(_?(acceso|refresh|api))?|access_?token|refresh_?token|api_?key|llave_?(api|privada)|secreto|secret|otp|cl@ve_?pin|clave_?pin|certificado_?(digital|electr[oó]nico)_?(clave|pin|password)|pregunta_?secreta|respuesta_?secreta|frase_?semilla|seed_?phrase|contrasenya|pasahitza', 0.9]))

// The image of a person is a fundamental right of its own in Spain (art. 18.1 of the Constitution,
// Ley Orgánica 1/1982), and the LOPDGDD gives video surveillance an article (art. 22).
domain('ES_L1_IMAGEN', 'ES_REDACTAR',
  byName(['foto(graf[ií]a)?[a-z0-9_]*|imagen_?(persona|rostro|perfil|dni|documento)|avatar|selfie|retrato|video_?(persona|entrevista|vigilancia)|videovigilancia|grabaci[oó]n(_?(llamada|voz|c[aá]mara))?|audio_?(voz|llamada)|url_?foto|ruta_?(foto|imagen)|fotografia|irudia|photo[a-z0-9_]*|picture|image_?(url|path|person)', 0.85]))

decompose('ES_COORDENADA', [
  // The integer part and first decimal stay (about 11 km): the place is generalized, not moved.
  [String.raw`(-?\d{1,3}[.,]\d)(\d+)\s*([,;])\s*(-?\d{1,3}[.,]\d)(\d+)`, keep, DIGITS, keep, keep, DIGITS],
  [String.raw`(-?\d{1,3}[.,]\d)(\d+)`, keep, DIGITS],
], keep, '40.416775')
domain('ES_L1_GEOLOCALIZACION', 'ES_COORDENADA',
  byName(
    ['lat|latitud|lon|lng|longitud|coordenadas?|coord_?[xy]|utm_?[xy]|geo_?(lat|lon|lng|loc|localizacion|posicion)|georreferenciaci[oó]n|geolocalizaci[oó]n|gps(_?(ubicaci[oó]n|posici[oó]n|coordenadas))?|ubicaci[oó]n_?gps|latitude|longitude', 0.85],
    ['long', 0.5],
  ),
  byPattern([
    [String.raw`(2[7-9]|3\d|4[0-4])\.\d{3,}\s*,\s*-?(1[0-8]|\d)\.\d{3,}`, 0.9],
    [String.raw`(3[5-9]|4[0-4])\.\d{4,}`, 0.4],
  ], { reject: 0.3 }))

// ── L1 · Free text ──────────────────────────────────────────────────────────

algorithm('ES_TEXTO_LIBRE', 'freeTextRedaction.FreeTextRedaction', {
  regularExpressions: [
    String.raw`(?<![\dA-Za-z])\d{8}-?[A-Za-z](?![A-Za-z])`,
    String.raw`(?<![A-Za-z])[XYZxyz]-?\d{7}-?[A-Za-z](?![A-Za-z])`,
    String.raw`\d{1,2}\.\d{3}\.\d{3}-?[A-Za-z]`,
    String.raw`[\w.+\-]+@[\w\-]+(\.[\w\-]+)+`,
    // Free Text Redaction splits the text on whitespace and matches inside a word, so a phone
    // number written with spaces is reached in pieces, not as one number.
    String.raw`(?<![\d\-])((\+|00)34)?[6789]\d{8}(?![\d\-])`,
    String.raw`(?<!\d)\d{13,19}(?!\d)`,
    String.raw`ES\d{22}`,
    String.raw`(?<!\d)\d{20}(?!\d)`,
    String.raw`(?<!\d)\d{2}/?\d{8}/?\d{2}(?!\d)`,
    String.raw`(?<!\d)(\d{1,3}\.){3}\d{1,3}(?!\d)`,
  ].map((patternString) => ({ patternString })),
  regExRedactValue: '[DATO]',
  lookupFile: { uri: file('es-texto-nombres.txt', unique([...GIVEN_NAMES, ...SURNAMES].flatMap((v) => [v, v.toUpperCase(), fold(v), fold(v).toUpperCase()]))) },
  lookupFileRedactValue: '[NOMBRE]',
  isDenyList: true,
}, 'Cliente García, DNI 12345678Z, correo l.garcia@gmail.com, móvil 612345678')

domain('ES_L1_TEXTO_LIBRE', 'ES_TEXTO_LIBRE',
  byName(['observaci[oó]n(es)?|obs|comentarios?|notas?|anotaci[oó]n(es)?|descripci[oó]n_?(queja|reclamaci[oó]n|solicitud|caso|hechos|incidencia|atenci[oó]n|denuncia)|detalle_?(reclamaci[oó]n|solicitud|caso|incidencia)|hechos|relato|motivo_?(de_?la_?)?(reclamaci[oó]n|solicitud|llamada)|justificaci[oó]n|(?<!(id|cd|cod|codigo|tipo|fecha|estado|num|nro)_?)mensaje(?!_?(id|tipo|codigo|fecha|estado|cola|log))|texto(_?libre)?|resumen_?(caso|atenci[oó]n)|queja|reclamaci[oó]n|observacions|oharrak|remarks?|comments?|notes?|free_?text|memo', 0.6]),
  byType(STRING(30)),
  byPattern([
    [String.raw`\d{8}-?[TRWAGMYFPDXBNJZSQVHLCKE]`, 0.8],
    [String.raw`[\w.+\-]+@[\w\-]+\.[A-Za-z]{2,}`, 0.7],
    [String.raw`[67]\d{2}[\s\-]?\d{3}[\s\-]?\d{3}`, 0.6],
  ], { reject: 0, partial: true }))


// ── L2 · Quasi-identifiers ──────────────────────────────────────────────────

// Small shifts: large enough to break the link to the person, small enough that ages and school
// years move for few people.
algorithm('ES_FECHA_NACIMIENTO', 'dateAlgorithms.DateShift', { minRange: -60, maxRange: 60, unit: 'DAYS', roll: false }, '1985-07-20')
algorithm('ES_FECHA_EVENTO', 'dateAlgorithms.DateShift', { minRange: -30, maxRange: 30, unit: 'DAYS', roll: false }, '2021-03-15')

domain('ES_L2_FECHA_NACIMIENTO', 'ES_FECHA_NACIMIENTO',
  byName(['(fecha|fec|fch|f)_?(de_?)?nac(imiento)?|fnac|fechanac(imiento)?|cumplea[nñ]os|data_?(de_?)?naixement|data_?(de_?)?nacemento|jaiotze_?data|dob|date_?of_?birth|birth_?date|birthday', 0.9]),
  byType(...DATES, STRING(6)))

decompose('ES_ANIO', [[String.raw`(\d{3})(\d)`, keep, DIGITS]], keep, '1985')
domain('ES_L2_ANIO_NACIMIENTO', 'ES_ANIO',
  byName(['a[nñ]o_?(de_?)?nac(imiento)?|anio_?nac(imiento)?|any_?(de_?)?naixement|year_?of_?birth|birth_?year|yob', 0.9]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// 37 becomes 3x. From 100 on, 90.
decompose('ES_EDAD', [
  [String.raw`(\d{3,})`, redactAs('90')],
  [String.raw`([1-9])(\d)([.,]\d+)`, keep, DIGITS, keep],
  [String.raw`([1-9])(\d)`, keep, DIGITS],
  [String.raw`(\d)`, DIGITS],
], keep, '37')
domain('ES_L2_EDAD', 'ES_EDAD',
  byName(['edad(_?(actual|a[nñ]os|paciente|afiliado|cliente|al_?(ingreso|diagn[oó]stico|fallecimiento)))?|grupo_?(de_?)?edad|tramo_?(de_?)?edad|rango_?(de_?)?edad|edat|adina|age(_?(years|group))?', 0.85]),
  byType(NUMBER(0, 6), STRING(0, 6)))

domain('ES_L2_FECHA_EVENTO', 'ES_FECHA_EVENTO',
  byName(['(fecha|fec|fch|f)_?(de_?)?(defunci[oó]n|fallecimiento|matrimonio|divorcio|alta|baja|ingreso|cese|despido|jubilaci[oó]n|hospitalizaci[oó]n|diagn[oó]stico|atenci[oó]n|consulta|parto|detenci[oó]n|sentencia|condena|expedici[oó]n_?(dni|documento)|caducidad_?(dni|nie|documento)|vacunaci[oó]n|intervenci[oó]n|accidente|incapacidad|baja_?m[eé]dica)|fec_?(exp|expedicion|defuncion|alta|baja)|date_?of_?(death|marriage|hire|admission|discharge)', 0.8]),
  byType(...DATES, STRING(6)))

// Each vocabulary replaced within itself: H/M stays H/M. A single M is read as mujer — the Spanish
// administrative convention, H/M or V/M —, so F is the only letter of the F/M vocabulary.
decompose('ES_SEXO', [
  ['(?i)(femenino|masculino)', apply(lookup('ES_SEXO_FEMENINO_MASCULINO', 'es-sexo-femenino-masculino.txt', ['Femenino', 'Masculino']))],
  ['(?i)(mujer|hombre)', apply(lookup('ES_SEXO_MUJER_HOMBRE', 'es-sexo-mujer-hombre.txt', ['Mujer', 'Hombre']))],
  ['(?i)(dona|home)', apply(lookup('ES_SEXO_DONA_HOME', 'es-sexo-dona-home.txt', ['Dona', 'Home']))],
  ['(?i)(female|male)', apply(lookup('ES_SEXO_FEMALE_MALE', 'es-sexo-female-male.txt', ['Female', 'Male']))],
  ['(?i)([hm])', apply(lookup('ES_SEXO_H_M', 'es-sexo-h-m.txt', ['H', 'M']))],
  ['(?i)(v)', apply(lookup('ES_SEXO_V_M', 'es-sexo-v-m.txt', ['V', 'M']))],
  ['(?i)(f)', apply(lookup('ES_SEXO_F_M', 'es-sexo-f-m.txt', ['F', 'M']))],
  ['([12])', apply(lookup('ES_SEXO_1_2', 'es-sexo-1-2.txt', ['1', '2']))],
], keep, 'M')
domain('ES_L2_SEXO', 'ES_SEXO',
  byName(['sexo(_?(biol[oó]gico|registral|paciente|afiliado|cliente))?|(tp|tipo|cod|cd|id)_?sexo|g[eé]nero(?!_?(identidad|sentido))|sexe|sexua|sex|gender(?!_?identity)', 0.85]),
  byList([['es-detectar-sexo.txt', ['h', 'm', 'v', 'f', 'hombre', 'mujer', 'varón', 'femenino', 'masculino', 'home', 'dona', 'female', 'male'], 0.5]], { reject: 0.5 }))

// ── L2 · Where people live ──────────────────────────────────────────────────
//
// Spain has 8,132 municipios, and on the Padrón of 1 January 2025 7,700 of them had fewer than
// 20,000 inhabitants: fourteen and a half million people, almost a third of the country, live in a
// municipio where a birth date and a sex point at a handful of neighbours. The INE itself recoded
// the municipio of every person living in one of under 20,000 when it published the microdata of
// the 2011 census. So a small municipio becomes the nearest municipio of at least 20,000 in the same
// province — every province has one, its capital at least — and the province and the comunidad
// autónoma stay.
const distance = (a, b) => {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}
const SMALL_PLACE = 20000
const nearest = (place, candidates) => candidates.reduce((best, x) => (distance(place, x) < distance(place, best) ? x : best))
const largeMunicipios = MUNICIPIOS.filter((m) => m.population >= SMALL_PLACE)
const spellingsOf = (p) => unique([p.name, ...(p.aliases ?? [])])
const nameKey = (name) => fold(name).toLowerCase()
// How systems write a name: as it is, in capitals, and without accents.
const spellings = (from, to) => {
  const out = new Map([[from, to], [from.toUpperCase(), to.toUpperCase()]])
  if (!out.has(fold(from))) out.set(fold(from), fold(to))
  if (!out.has(fold(from).toUpperCase())) out.set(fold(from).toUpperCase(), fold(to).toUpperCase())
  return [...out]
}
const variants = (pairs) => {
  const all = pairs.map(([from, to]) => spellings(from, to))
  return [...all.map((v) => v[0]), ...all.flatMap((v) => v.slice(1))]
}
// With the province, as systems write it to tell homonyms apart: `Villanueva (Toledo)`,
// `Villanueva, Toledo`. Two forms only, and the province by its usual name: the table would
// otherwise pass a hundred thousand lines.
const SEPARATORS = [[' (', ')'], [', ', '']]

/**
 * The generalization table. `places` carry name, `small`, `to` — the place they become — and
 * `qualifiers`, the provinces systems write beside the name, each with the code that scopes the
 * homonyms. A name shared by several places is generalized only when all of them are small, to the
 * fate of the most populous; written with a qualifier, the same rule applies inside it, and the
 * qualifier stays as it was written.
 */
function generalization(places) {
  const byKey = new Map()
  const add = (key, name, p, qualifier) => {
    const entry = byKey.get(key) ?? { spellings: new Set(), all: new Set(), qualifier }
    entry.spellings.add(name)
    entry.all.add(p)
    byKey.set(key, entry)
  }
  for (const p of places) {
    for (const name of spellingsOf(p)) {
      add(nameKey(name), name, p, null)
      for (const q of p.qualifiers) add(`${nameKey(name)}|${q.code}|${nameKey(q.name)}`, name, p, q)
    }
  }
  const mostPopulous = (all) => [...all].reduce((a, b) => (b.population > a.population ? b : a))
  const pairs = []
  let names = 0
  for (const { spellings: written, all, qualifier } of byKey.values()) {
    if ([...all].some((p) => !p.small)) continue
    const from = mostPopulous(all)
    if (!qualifier) {
      for (const name of written) pairs.push([name, from.to.name])
      names++
      continue
    }
    for (const name of written) for (const [a, b] of SEPARATORS) pairs.push([`${name}${a}${qualifier.name}${b}`, `${from.to.name}${a}${qualifier.name}${b}`])
  }
  const qualified = (p) => spellingsOf(p).flatMap((name) => p.qualifiers.flatMap((q) => SEPARATORS.map(([a, b]) => `${name}${a}${q.name}${b}`)))
  const kept = new Set(variants(places.filter((p) => !p.small).flatMap((p) => [...qualified(p), ...spellingsOf(p)].map((n) => [n, n]))).map(([from]) => from))
  const generalized = new Map()
  const ambiguous = new Set()
  for (const [from, to] of variants(pairs)) {
    if (kept.has(from) || ambiguous.has(from)) continue
    if (generalized.has(from) && fold(generalized.get(from)).toUpperCase() === fold(to).toUpperCase()) continue
    if (generalized.has(from) && generalized.get(from) !== to) { generalized.delete(from); ambiguous.add(from); continue }
    generalized.set(from, to)
  }
  return { table: [...generalized], names }
}

const municipioTo = (m) => nearest(m, largeMunicipios.filter((x) => x.provinceCode === m.provinceCode))
const municipioPlaces = MUNICIPIOS.map((m) => ({ ...m, small: m.population < SMALL_PLACE }))
const municipioPlaceByCode = new Map(municipioPlaces.map((m) => [m.code, m]))
for (const m of municipioPlaces) m.to = m.small ? municipioPlaceByCode.get(municipioTo(m).code) : m
for (const m of municipioPlaces) {
  const p = provinceByCode.get(m.provinceCode)
  m.qualifiers = [{ level: 'prov', code: p.code, name: p.name }]
}
// Provinces and comunidades are far above the threshold and are never generalized; they join the
// table only so that a name shared with one of them — Valencia, Soria, Cantabria — is left alone.
const provincePlaces = PROVINCIAS.map((p) => ({ ...p, small: false, qualifiers: [] }))
const comunidadPlaces = COMUNIDADES.map((c) => ({ ...c, aliases: [], population: Infinity, small: false, qualifiers: [] }))
for (const p of [...provincePlaces, ...comunidadPlaces]) p.to = p

const places = generalization([...municipioPlaces, ...provincePlaces, ...comunidadPlaces])
cleansing('ES_MUNICIPIO', 'es-municipios-generalizados.txt', places.table, 'Valdelageve')

/**
 * The INE code of a municipio — two digits for the province, three for the municipio and, in many
 * registers, a check digit — follows the name: a small municipio's code becomes the code of the
 * municipio it is generalized to, with its own check digit, so it never leaves the province.
 */
const codePairs = municipioPlaces.filter((m) => m.small).flatMap((m) => [[m.code, m.to.code], [`${m.code}${m.dc}`, `${m.to.code}${m.to.dc}`]])
cleansing('ES_CODIGO_MUNICIPIO', 'es-codigos-municipio-generalizados.txt', codePairs, '37334')

/**
 * Postal codes follow the municipio they mostly serve — the one with most street segments in the
 * Callejero del Censo Electoral. A code of a small municipio becomes the main code of the municipio
 * it is generalized to, so a masked postal code agrees with the masked municipio beside it and keeps
 * its province in its first two digits.
 */
const mainPostalCode = new Map()
for (const c of POSTAL_CODES) {
  const m = c.municipios[0]
  if (!mainPostalCode.has(m)) mainPostalCode.set(m, c.code)
}
const postalPairs = []
for (const c of POSTAL_CODES) {
  const m = municipioPlaceByCode.get(c.municipios[0])
  if (!m.small) continue
  const target = mainPostalCode.get(m.to.code)
  if (!target || target.slice(0, 2) !== m.provinceCode) throw new Error(`postal code ${c.code}: no code for ${m.to.name}`)
  postalPairs.push([c.code, target])
}
cleansing('ES_CODIGO_POSTAL', 'es-codigos-postales-generalizados.txt', postalPairs, '37329')

const PERSONAL_WORDS = new Set([...GIVEN_NAMES, ...SURNAMES].map((w) => fold(w).toLowerCase()))
const REGION_NAMES = new Set([...PROVINCIAS.flatMap((p) => [p.name, ...p.aliases]), ...COMUNIDADES.map((c) => c.name), 'España'].map((n) => fold(n).toLowerCase()))
const placeNames = (list) => unique(list.flatMap(spellingsOf))
  .filter((n) => !n.includes('/') && !PERSONAL_WORDS.has(fold(n).toLowerCase()) && !REGION_NAMES.has(fold(n).toLowerCase()))

domain('ES_L2_MUNICIPIO', 'ES_MUNICIPIO',
  byName(['municipio(?!_?(cod|codigo|id|ine))(_?(residencia|nacimiento|domicilio|empadronamiento))?|localidad(_?(residencia|nacimiento|domicilio))?|poblaci[oó]n(?!_?(total|activa|objetivo))|ciudad(_?(residencia|nacimiento|domicilio))?|municipi|poblaci[oó]|concello|udalerria|herria|(nom|nombre|desc)_?(municipio|localidad|poblacion|ciudad)|lugar_?(de_?)?nacimiento|city|town|municipality', 0.85]),
  byList([['es-detectar-municipios.txt', placeNames(MUNICIPIOS), 0.8]], { reject: 0.4 }))

domain('ES_L2_CODIGO_MUNICIPIO', 'ES_CODIGO_MUNICIPIO',
  byName(['(cod|codigo|cd|id)_?(ine_?)?(municipio|mun|municipal|localidad|poblacion)(_?(ine|residencia|nacimiento|domicilio))?|c[oó]digo_?ine|cod_?ine|ine_?(municipio|code)|cmun|c_?mun|codmun|municipio_?ine|municipality_?code', 0.9]),
  byPattern([[String.raw`(0[1-9]|[1-4]\d|5[0-2])\d{3}\d?`, 0.4]], { reject: 0.3 }))

domain('ES_L2_CODIGO_POSTAL', 'ES_CODIGO_POSTAL',
  byName(['c[oó]digo_?postal|cod_?postal|codpostal|cp|c_p|cp_?(residencia|domicilio|cliente|envio)|dp|codi_?postal|posta_?kodea|zip(_?code)?|postal_?code', 0.9]),
  byPattern([[String.raw`(0[1-9]|[1-4]\d|5[0-2])\d{3}`, 0.4]], { reject: 0.3 }))

// Nationality and residence status are not among the special categories of article 9, but Ley
// 15/2022 de igualdad de trato forbids discrimination "con independencia de su nacionalidad" and of
// whether a person "disfruta o no de residencia legal", and in a test copy they are what points at
// the few foreign residents of a small place.
const COUNTRIES = ['Española', 'Marroquí', 'Rumana', 'Colombiana', 'Venezolana', 'Británica', 'Italiana', 'Ecuatoriana', 'China', 'Ucraniana', 'Peruana', 'Argentina', 'Hondureña', 'Francesa', 'Alemana', 'Búlgara', 'Portuguesa', 'Paraguaya', 'Pakistaní', 'Senegalesa', 'Cubana', 'Dominicana', 'Brasileña', 'Boliviana', 'Argelina', 'Rusa', 'Nicaragüense']
lookup('ES_NACIONALIDAD', 'es-nacionalidades.txt', COUNTRIES, 'Georgiana')
domain('ES_L2_NACIONALIDAD', 'ES_NACIONALIDAD',
  byName(['nacionalidad(_?(origen|actual))?|pa[ií]s_?(de_?)?(nacimiento|origen|nacionalidad|procedencia)|ciudadan[ií]a|nacionalitat|naziotasuna|nationality|citizenship|country_?of_?birth', 0.85]),
  byList([['es-detectar-nacionalidades.txt', [...COUNTRIES, 'español', 'española', 'marroquí', 'rumano', 'rumana', 'colombiano', 'venezolano', 'británico', 'italiano', 'ecuatoriano', 'chino', 'ucraniano', 'peruano', 'argentino', 'hondureño', 'francés', 'alemán', 'españa', 'marruecos', 'rumanía', 'colombia', 'venezuela', 'reino unido', 'italia', 'ecuador', 'china', 'ucrania', 'extranjero', 'extranjera', 'comunitario', 'extracomunitario'], 0.7]], { reject: 0.4 }))

const RESIDENCE = ['Residencia temporal', 'Residencia de larga duración', 'Residencia de larga duración UE', 'Certificado de registro de ciudadano de la UE', 'Tarjeta de familiar de ciudadano de la UE', 'Solicitante de protección internacional', 'Estatuto de refugiado', 'Protección subsidiaria', 'Protección temporal', 'Arraigo', 'Estancia por estudios', 'Situación irregular', 'No aplica']
categorical('ES_SITUACION_ADMINISTRATIVA', 'es-situacion-administrativa.txt', RESIDENCE, 'Residencia en trámite')
domain('ES_L2_SITUACION_ADMINISTRATIVA', 'ES_SITUACION_ADMINISTRATIVA',
  byName(['situaci[oó]n_?(administrativa|de_?residencia|de_?extranjer[ií]a|migratoria)|tipo_?(de_?)?(residencia|autorizaci[oó]n|permiso)|autorizaci[oó]n_?(de_?)?(residencia|trabajo|estancia)|permiso_?(de_?)?(residencia|trabajo)|estatuto_?(de_?)?(refugiado|ap[aá]trida)|protecci[oó]n_?internacional|solicitante_?(de_?)?asilo|asilo|arraigo|extranjer[ií]a|migration_?status|immigration_?status|residence_?permit', 0.9]),
  byList([['es-detectar-situacion-administrativa.txt', [...RESIDENCE, 'residente', 'larga duración', 'temporal', 'refugiado', 'refugiada', 'asilo', 'irregular', 'arraigo', 'comunitario', 'protección internacional', 'protección temporal'], 0.7]], { reject: 0.4 }))

const MARITAL = ['Soltero/a', 'Casado/a', 'Pareja de hecho', 'Separado/a', 'Divorciado/a', 'Viudo/a']
categorical('ES_ESTADO_CIVIL', 'es-estado-civil.txt', MARITAL, 'Unión de hecho', ['1', '2', '3', '4', '5', '6'])
domain('ES_L2_ESTADO_CIVIL', 'ES_ESTADO_CIVIL',
  byName(['estado_?civil|est_?civil|(cod|tipo|id)_?estado_?civil|pareja_?de_?hecho|estat_?civil|egoera_?zibila|marital_?status|civil_?status', 0.85]),
  byList([['es-detectar-estado-civil.txt', [...MARITAL, 'soltero', 'soltera', 'casado', 'casada', 'pareja de hecho', 'separado', 'separada', 'divorciado', 'divorciada', 'viudo', 'viuda'], 0.7]], { reject: 0.4 }))

lookup('ES_OCUPACION', 'es-ocupaciones.txt', ['Empleado administrativo', 'Dependiente de comercio', 'Cajero', 'Conductor de camión', 'Repartidor', 'Albañil', 'Encargado de obra', 'Profesor de educación secundaria', 'Maestro de educación primaria', 'Enfermero', 'Médico de familia', 'Auxiliar de enfermería', 'Contable', 'Abogado', 'Ingeniero', 'Programador informático', 'Recepcionista', 'Personal de limpieza', 'Vigilante de seguridad', 'Cocinero', 'Camarero', 'Electricista', 'Fontanero', 'Mecánico', 'Peón agrícola', 'Operario de fábrica', 'Comercial', 'Teleoperador', 'Mozo de almacén', 'Peluquero', 'Cuidador de personas mayores', 'Empleado de hogar', 'Estudiante', 'Jubilado', 'Taxista', 'Guía turístico', 'Funcionario'], 'Director de operaciones')
decompose('ES_OCUPACION_O_CODIGO', [
  // Clasificación Nacional de Ocupaciones (CNO-11): four digits.
  [String.raw`(\d{2,5})`, DIGITS],
], apply('ES_OCUPACION'), 'Director de operaciones')
domain('ES_L2_OCUPACION', 'ES_OCUPACION_O_CODIGO',
  byName(
    ['ocupaci[oó]n|profesi[oó]n|oficio|cno(_?11)?|(cod|codigo)_?(ocupacion|profesion|cno)|puesto_?(de_?)?trabajo|categor[ií]a_?profesional|grupo_?(de_?)?cotizaci[oó]n|cargo_?(actual|empleado)|professi[oó]|lanbidea|occupation|profession|job_?title', 0.8],
    ['cargo|puesto', 0.5],
  ))

lookup('ES_EMPLEADOR', 'es-empleadores.txt', ['Distribuciones Levante S.L.', 'Construcciones del Norte S.A.', 'Transportes La Meseta S.L.', 'Supermercados El Ahorro S.A.', 'Metalúrgica del Henares S.L.', 'Clínica Santa Teresa S.L.', 'Colegio Nuevo Horizonte', 'Servicios Integrales del Mediterráneo S.L.', 'Agrícola Tres Ríos S.A.T.', 'Comercial Los Olivos S.L.', 'Soluciones Digitales Ibéricas S.L.', 'Restaurante El Mesón S.L.', 'Hotel Mirador de la Sierra S.A.', 'Laboratorios Vida Sana S.L.', 'Seguridad Vigía S.A.', 'Textiles La Aguja S.L.', 'Recambios del Este S.L.', 'Farmacia El Buen Vecino C.B.', 'Logística Puerto Seco S.L.', 'Cooperativa Agrícola La Unión S. Coop.', 'Fundación Manos Unidas', 'Panadería La Espiga S.L.', 'Asesoría Contable Asociados S.L.', 'Conservas del Cantábrico S.A.'], 'Corporación Industrial del Atlántico S.A.', 'PRESERVE_LOOKUP_FILE')
domain('ES_L2_EMPLEADOR', 'ES_EMPLEADOR',
  byName(['empleador(_?(nombre|raz[oó]n_?social))?|(nombre|nom)_?(empleador|empresa_?donde_?trabaja)|empresa_?(donde_?)?(trabaja|empleadora)|lugar_?(de_?)?trabajo|centro_?(de_?)?trabajo|empresa_?empleadora|empresa_?actual|ocupador|employer(_?name)?|workplace', 0.9]))

const EDUCATION = ['Sin estudios', 'Educación primaria incompleta', 'Educación primaria', 'Educación secundaria obligatoria (ESO)', 'Bachillerato', 'Formación profesional de grado medio', 'Formación profesional de grado superior', 'Grado universitario', 'Máster', 'Doctorado']
categorical('ES_NIVEL_EDUCATIVO', 'es-nivel-educativo.txt', EDUCATION, 'Licenciatura en curso', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
domain('ES_L2_NIVEL_EDUCATIVO', 'ES_NIVEL_EDUCATIVO',
  byName(['nivel_?(educativo|de_?estudios|acad[eé]mico|formativo|de_?formaci[oó]n)|estudios(_?(terminados|finalizados|realizados|m[aá]ximos))?|titulaci[oó]n(_?acad[eé]mica)?|formaci[oó]n_?acad[eé]mica|m[aá]ximo_?nivel|cned|nivell_?(d_?)?estudis|ikasketa_?maila|education(_?level)?', 0.8]),
  byList([['es-detectar-nivel-educativo.txt', [...EDUCATION, 'sin estudios', 'primaria', 'eso', 'secundaria', 'bachillerato', 'fp', 'formación profesional', 'grado medio', 'grado superior', 'grado', 'licenciatura', 'diplomatura', 'máster', 'doctorado'], 0.6]], { reject: 0.4 }))

lookup('ES_CENTRO_EDUCATIVO', 'es-centros-educativos.txt', ['CEIP Miguel de Cervantes', 'CEIP Antonio Machado', 'IES Ramiro de Maeztu', 'IES Luis Vives', 'Colegio Nuestra Señora del Pilar', 'Colegio San José', 'Escola Pública Montseny', 'IES Rosalía de Castro', 'Universidad Complutense de Madrid', 'Universitat de Barcelona', 'Universidad de Sevilla', 'Universidad del País Vasco', 'Universidad Nacional de Educación a Distancia', 'Centro Integrado de Formación Profesional'], 'Universidad de Salamanca')
domain('ES_L2_CENTRO_EDUCATIVO', 'ES_CENTRO_EDUCATIVO',
  byName(['centro_?(educativo|escolar|de_?estudios|docente)|colegio|instituto|ies|ceip|escuela|universidad|facultad|escola|ikastetxea|(nombre|nom)_?(colegio|instituto|universidad|centro)|c[oó]digo_?(de_?)?centro|school(_?name)?|university', 0.75]))

// Capped at 5 as text: large households are rare, and a rare count identifies — the familia
// numerosa starts at three children.
decompose('ES_CONTEO_LIMITADO', [[String.raw`([0-5])`, keep], [String.raw`(\d+)`, redactAs('5')]], keep, '9')
domain('ES_L2_PERSONAS_A_CARGO', 'ES_CONTEO_LIMITADO',
  byName(['personas_?a_?cargo|n(o|ro|um|umero)_?(de_?)?(hijos|descendientes|dependientes|personas_?a_?cargo|miembros)|hijos|descendientes|miembros_?(de_?la_?)?(unidad_?familiar|hogar)|unidad_?familiar|personas_?(en_?el_?)?hogar|tama[nñ]o_?(del_?)?hogar|familia_?numerosa|fills|number_?of_?children|dependents', 0.8]),
  byType(NUMBER(0, 4), STRING(0, 4)))


// ── L3 · Special categories (art. 9 RGPD and art. 9 LOPDGDD) ───────────────
//
// Article 9.1 of the Reglamento prohibits processing data revealing racial or ethnic origin,
// political opinions, religious or philosophical beliefs or trade union membership, genetic data,
// biometric data for uniquely identifying a person, data concerning health and data concerning a
// person's sex life or sexual orientation. Article 9.1 of the LOPDGDD adds a Spanish rule: "a fin
// de evitar situaciones discriminatorias, el solo consentimiento del afectado no bastará para
// levantar la prohibición del tratamiento de datos cuya finalidad principal sea identificar su
// ideología, afiliación sindical, religión, orientación sexual, creencias u origen racial o étnico".
// Processing them outside article 9 is a very serious infringement (art. 72.1 e).

const ETHNICITY = ['Gitana', 'Blanca o europea', 'Magrebí o árabe', 'Africana subsahariana', 'Latinoamericana', 'Asiática', 'Mixta', 'Otra', 'Prefiere no responder']
categorical('ES_ORIGEN_ETNICO', 'es-origen-etnico.txt', ETHNICITY, 'Afrodescendiente', ['1', '2', '3', '4', '5', '6', '7', '8', '9'])
domain('ES_L3_ORIGEN_ETNICO', 'ES_ORIGEN_ETNICO',
  byName(['etnia|origen_?([eé]tnico|racial)|grupo_?[eé]tnico|pertenencia_?[eé]tnica|autoidentificaci[oó]n_?([eé]tnica|racial)|(cod|codigo|tipo|id)_?etnia|raza|comunidad_?gitana|pueblo_?gitano|ethnicity|race', 0.95]),
  byList([['es-detectar-origen-etnico.txt', [...ETHNICITY, 'gitano', 'gitana', 'roma', 'payo', 'paya', 'magrebí', 'árabe', 'africano', 'africana', 'subsahariano', 'latinoamericano', 'asiático', 'asiática', 'blanco', 'blanca', 'mixta', 'otra'], 0.9],
    ['es-detectar-codigos-banderas.txt', ['s', 'n', 'sí', 'no', '1', '2', '3', '4', '5', '6', '7', '8', '9'], 0.3],
  ], { reject: 0.4 }))

const RELIGIONS = ['Católica', 'Evangélica o protestante', 'Musulmana', 'Testigo de Jehová', 'Ortodoxa', 'Judía', 'Budista', 'Iglesia de Jesucristo de los Santos de los Últimos Días', 'Otra', 'Sin religión']
categorical('ES_RELIGION', 'es-religiones.txt', RELIGIONS, 'Anglicana')
domain('ES_L3_RELIGION', 'ES_RELIGION',
  byName(['religi[oó]n|creencia_?(religiosa)?|confesi[oó]n_?religiosa|confesionalidad|credo|culto|iglesia|(cod|codigo|tipo)_?religion|clase_?de_?religi[oó]n|ense[nñ]anza_?religiosa|asignatura_?religi[oó]n|casilla_?iglesia|asignaci[oó]n_?tributaria_?iglesia|religi[oó]|erlijioa|religion|church', 0.95]),
  byList([['es-detectar-religiones.txt', [...RELIGIONS, 'católico', 'catolico', 'cristiano', 'cristiana', 'evangélico', 'evangélica', 'protestante', 'musulmán', 'islam', 'testigo de jehová', 'ortodoxo', 'judío', 'budista', 'mormón', 'ateo', 'atea', 'agnóstico', 'agnóstica', 'ninguna', 'sin religión'], 0.9]], { reject: 0.4 }))

domain('ES_L3_CONVICCION_FILOSOFICA', 'ES_CATEGORIA_SUPRIMIDA',
  byName(['convicci[oó]n(es)?_?(filos[oó]ficas?|morales?|personales?|[eé]ticas?)|creencias?_?(filos[oó]ficas?|morales?|personales?)|ideolog[ií]a(?!_?pol[ií]tica)|objeci[oó]n_?(de_?)?conciencia|objetor_?(de_?)?conciencia|masoner[ií]a|logia|veganismo|philosophical_?beliefs?|beliefs?', 0.9]))

// The CIS asks for self-placement on a scale of 1 to 10, so a numeric code is replaced by another.
const IDEOLOGIES = ['Izquierda', 'Centroizquierda', 'Centro', 'Centroderecha', 'Derecha', 'Ninguna', 'Prefiere no responder']
categorical('ES_OPINION_POLITICA', 'es-opiniones-politicas.txt', IDEOLOGIES, 'Progresista', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
domain('ES_L3_OPINION_POLITICA', 'ES_OPINION_POLITICA',
  byName(['opini[oó]n_?pol[ií]tica|ideolog[ií]a_?pol[ií]tica|preferencias?_?(pol[ií]tica|partidista|electoral)|autoubicaci[oó]n_?ideol[oó]gica|escala_?ideol[oó]gica|orientaci[oó]n_?pol[ií]tica|tendencia_?pol[ií]tica|intenci[oó]n_?(de_?)?voto|recuerdo_?(de_?)?voto|simpat[ií]a_?pol[ií]tica|political_?(opinion|orientation|view|preference)|voting_?intention', 0.95]),
  byList([['es-detectar-opiniones-politicas.txt', [...IDEOLOGIES, 'izquierda', 'derecha', 'centro', 'progresista', 'conservador', 'liberal', 'socialista', 'comunista', 'nacionalista', 'independentista', 'apolítico', 'abstención', 'voto en blanco', 'ninguno'], 0.7]], { reject: 0.4 }))

const PARTIES = ['PP', 'PSOE', 'Vox', 'Sumar', 'Podemos', 'ERC', 'Junts', 'EH Bildu', 'PNV', 'BNG', 'Coalición Canaria', 'UPN', 'CUP', 'Compromís', 'Más Madrid', 'Sin afiliación']
categorical('ES_PARTIDO', 'es-partidos.txt', PARTIES, 'Ciudadanos')
domain('ES_L3_AFILIACION_PARTIDARIA', 'ES_PARTIDO',
  byName(['partido(_?pol[ií]tico)?(_?(afiliaci[oó]n|nombre|militancia))?|afiliaci[oó]n_?(pol[ií]tica|partidista|partido)|militancia(_?pol[ií]tica)?|militante|cuota_?(de_?)?(afiliado|militante)|(cod|codigo|nombre|nom)_?partido|partit|alderdia|political_?party|party_?membership', 0.95]),
  byList([['es-detectar-partidos.txt', [...PARTIES, 'Partido Popular', 'Partido Socialista Obrero Español', 'Partido Socialista', 'Ciudadanos', 'Cs', 'Esquerra Republicana', 'Junts per Catalunya', 'Bildu', 'Partido Nacionalista Vasco', 'EAJ-PNV', 'Bloque Nacionalista Galego', 'Izquierda Unida', 'IU'], 0.8]], { reject: 0.4 }))

domain('ES_L3_AFILIACION_SINDICAL', 'ES_CATEGORIA_SUPRIMIDA',
  byName(['sindicato(_?(nombre|afiliado|afiliaci[oó]n|c[oó]digo))?|sindicad[oa]|afiliado_?sindicato|afiliaci[oó]n_?sindical|cuota_?sindical|descuento_?sindical|delegado_?sindical|representante_?(de_?los_?)?trabajadores|comit[eé]_?(de_?)?empresa|horas_?sindicales|cr[eé]dito_?horario|sindicat|sindikatua|trade_?union|union_?member(ship)?', 0.95]),
  byList([['es-detectar-sindicatos.txt', ['CCOO', 'Comisiones Obreras', 'UGT', 'Unión General de Trabajadores', 'CSIF', 'USO', 'CGT', 'CNT', 'ELA', 'LAB', 'CIG', 'Intersindical', 'SATSE', 'ANPE', 'STEs', 'CSI-F', 'sindicado', 'afiliado', 'delegado sindical'], 0.6]], { reject: 0.3 }))

// "Datos biométricos dirigidos a identificar de manera unívoca a una persona física" (art. 9.1 RGPD).
domain('ES_L3_BIOMETRICO', 'ES_REDACTAR',
  byName(['biometr[ií]a[a-z_]*|biom[eé]trico[a-z_]*|huella(_?(dactilar|digital))?(_?(template|plantilla|imagen|hash))?|huellas|dactilar|template_?(facial|huella|biometrico)|plantilla_?(facial|biom[eé]trica)|rostro_?(hash|template)|reconocimiento_?(facial|de_?voz)|firma_?(biom[eé]trica|manuscrita_?digitalizada)|iris|voz_?(biom[eé]trica|template)|empremta|fingerprints?|face_?(template|hash|encoding)|biometric[a-z_]*', 0.9]),
  byType(STRING()))

domain('ES_L3_GENETICO', 'ES_REDACTAR',
  byName(['adn|dna|gen[eé]tic[oa]s?|datos?_?gen[eé]ticos?|genoma|genotip[a-z_]*|prueba_?(gen[eé]tica|de_?adn|de_?paternidad)|perfil_?gen[eé]tico|mutaci[oó]n|brca[12]?|cariotipo|cribado_?neonatal|prueba_?del_?tal[oó]n|genetic[a-z_]*', 0.9]))

const ORIENTATIONS = ['Heterosexual', 'Gay', 'Lesbiana', 'Bisexual', 'Pansexual', 'Asexual', 'Otra', 'Prefiere no responder']
categorical('ES_ORIENTACION_SEXUAL', 'es-orientaciones-sexuales.txt', ORIENTATIONS, 'Homosexual')
domain('ES_L3_ORIENTACION_SEXUAL', 'ES_ORIENTACION_SEXUAL',
  byName(['orientaci[oó]n_?sexual|preferencias?_?sexuales?|(cod|codigo|tipo)_?orientacion_?sexual|orientaci[oó]_?sexual|sexual_?orientation', 0.95]),
  byList([['es-detectar-orientaciones-sexuales.txt', [...ORIENTATIONS, 'hetero', 'homosexual', 'lgtbi', 'lgtbiq+', 'queer', 'diversidad sexual'], 0.8]], { reject: 0.4 }))

domain('ES_L3_VIDA_SEXUAL', 'ES_CATEGORIA_SUPRIMIDA',
  byName(['vida_?sexual|actividad_?sexual|conducta_?sexual|pr[aá]cticas?_?sexuales?|parejas?_?sexuales?|n(o|ro|um|umero)_?parejas|sexualmente_?activ[oa]|relaciones_?sexuales|sex(ual)?_?life|sexual_?(activity|behavio(u)?r|partners)', 0.9]))

// Ley 4/2023 lets a person rectify the sex registered in the Registro Civil by their own
// declaration, and Ley 15/2022 names "identidad sexual" and "expresión de género" among the grounds
// of discrimination.
const IDENTITIES = ['Mujer cis', 'Hombre cis', 'Mujer trans', 'Hombre trans', 'Persona no binaria', 'Otra', 'Prefiere no responder']
categorical('ES_IDENTIDAD_GENERO', 'es-identidades-genero.txt', IDENTITIES, 'Transgénero')
domain('ES_L3_IDENTIDAD_GENERO', 'ES_IDENTIDAD_GENERO',
  byName(['identidad_?(de_?)?g[eé]nero|identidad_?sexual|(cod|codigo|tipo)_?identidad_?genero|g[eé]nero_?(sentido|autopercibido)|expresi[oó]n_?de_?g[eé]nero|transg[eé]nero|persona_?trans|rectificaci[oó]n_?(registral_?)?(del_?)?sexo|nombre_?sentido|pronombres?|gender_?identity', 0.95]),
  byList([['es-detectar-identidades-genero.txt', [...IDENTITIES, 'cisgénero', 'cis', 'transgénero', 'trans', 'no binario', 'no binaria', 'mujer', 'hombre'], 0.7]], { reject: 0.4 }))

// Ley Orgánica 1/2004 de protección integral contra la violencia de género (art. 63) and Ley
// Orgánica 10/2022 de garantía integral de la libertad sexual protect the identity of the victim.
domain('ES_L3_VICTIMA', 'ES_CATEGORIA_SUPRIMIDA',
  byName(['v[ií]ctima(_?(de_?)?(violencia(_?(de_?g[eé]nero|dom[eé]stica|machista|sexual|vicaria))?|delito|trata|agresi[oó]n|acoso))?|violencia_?(de_?)?g[eé]nero|violencia_?(dom[eé]stica|machista|sexual|vicaria|intrafamiliar)|tipo_?(de_?)?violencia|orden_?(de_?)?protecci[oó]n|orden_?(de_?)?alejamiento|viogen|atenpro|trata_?(de_?)?(seres_?humanos|personas)', 0.9]))


// ── SALUD · Health data (art. 9 RGPD, Ley 41/2002 and DA 17ª LOPDGDD) ─────
//
// The additional provision 17 of the LOPDGDD lists the laws under which health data are processed
// — Ley General de Sanidad, Ley 41/2002 de autonomía del paciente, Ley de cohesión del SNS, Ley de
// investigación biomédica — and none of them is a test environment. Article 16.3 of Ley 41/2002 asks
// that any secondary access to the historia clínica keep the identifying data "separados de los de
// carácter clinicoasistencial, de manera que, como regla general, quede asegurado el anonimato". And
// when the provision 17 lets researchers use pseudonymized health data, it demands "una separación
// técnica y funcional entre el equipo investigador y quienes realicen la seudonimización y conserven
// la información que posibilite la reidentificación" — the engine key, kept apart from the copy.

domain('ES_SALUD_IDENTIFICADOR', 'ES_CM_ALFANUM',
  byName(
    ['n(o|ro|um|umero)_?(historia(_?cl[ií]nica)?|hc|nhc|episodio|ingreso|atenci[oó]n|consulta|cita|receta|tarjeta_?sanitaria)|historia_?cl[ií]nica|nhc|cip(_?(sns|autonomico|auton[oó]mico))?|c[oó]digo_?(de_?)?identificaci[oó]n_?personal|tarjeta_?sanitaria(_?individual)?|tsi|nuhsa|cipa|tis|id_?paciente|c[oó]digo_?(paciente|historia|episodio)|hist[oò]ria_?cl[ií]nica|osasun_?txartela', 0.85],
    ['historia|episodio|ingreso|consulta', 0.55],
  ),
  // The numbers of a historia clínica take any shape, so values that match neither card say nothing.
  byPattern([[String.raw`[A-Z]{4}\d{12}`, 0.7], [String.raw`AN\d{10}`, 0.7]], { reject: 0 }))

const COVERAGE = ['Seguridad Social (titular)', 'Seguridad Social (beneficiario)', 'MUFACE', 'ISFAS', 'MUGEJU', 'Mutua colaboradora', 'Seguro privado', 'Convenio especial', 'Sin cobertura']
decompose('ES_COBERTURA_SALUD', [
  [FLAG, apply('ES_BANDERA')],
  [String.raw`(\d{1,8})`, DIGITS],
], apply(lookup('ES_COBERTURA', 'es-cobertura-salud.txt', COVERAGE, undefined, 'PRESERVE_LOOKUP_FILE')), 'MUFACE')
domain('ES_SALUD_COBERTURA', 'ES_COBERTURA_SALUD',
  byName(['cobertura(_?(sanitaria|m[eé]dica|asistencial))?|aseguramiento|r[eé]gimen_?(de_?)?(aseguramiento|asistencia)|tipo_?(de_?)?(asegurado|aseguramiento|cobertura|beneficiario)|mutualidad|mutua(_?(laboral|colaboradora))?|muface|isfas|mugeju|aseguradora_?(m[eé]dica|salud)|seguro_?(m[eé]dico|de_?salud|privado)|entidad_?(de_?)?seguro', 0.85]),
  byList([['es-detectar-cobertura.txt', [...COVERAGE, 'seguridad social', 'titular', 'beneficiario', 'muface', 'isfas', 'mugeju', 'mutua', 'privado', 'adeslas', 'sanitas', 'asisa', 'dkv', 'convenio especial', 'sin cobertura'], 0.8]], { reject: 0.4 }))

// Spain codes diagnoses in CIE-10-ES since 2016: the same codes as the ICD-10 of the WHO.
const ICD10 = ['I10', 'E11', 'E78', 'J45', 'J06', 'J02', 'J20', 'K29', 'K21', 'K59', 'M54', 'M17', 'M25', 'N39', 'N20', 'R51', 'R10', 'H10', 'H66', 'L23', 'L30', 'B34', 'A09', 'E03', 'E66', 'D50', 'I83', 'K80', 'K40', 'S93', 'S60', 'Z00', 'J30', 'J32', 'G43', 'M79', 'R05']
const ICD10_DECIMAL = ['E11.9', 'E78.5', 'J45.909', 'J06.9', 'J02.9', 'J20.9', 'K29.70', 'K21.9', 'K59.00', 'M54.5', 'M17.9', 'N39.0', 'N20.0', 'R10.9', 'H10.9', 'H66.90', 'L23.9', 'L30.9', 'B34.9', 'A09', 'E03.9', 'E66.9', 'D50.9', 'I83.90', 'K80.20', 'K40.90', 'S93.409A', 'Z00.00', 'J30.9', 'J32.9', 'G43.909', 'M79.1', 'R05']
decompose('ES_DIAGNOSTICO', [
  [String.raw`([A-TV-Za-tv-z]\d{2}\.[\dA-Za-z]{1,4})`, apply(lookup('ES_CIE10_DECIMAL', 'es-cie10-decimal.txt', ICD10_DECIMAL, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [String.raw`([A-TV-Za-tv-z]\d{2,3}X?)`, apply(lookup('ES_CIE10', 'es-cie10.txt', ICD10, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [FLAG, apply('ES_BANDERA')],
], apply(lookup('ES_DIAGNOSTICO_TEXTO', 'es-diagnosticos.txt', ['Hipertensión arterial', 'Diabetes mellitus tipo 2', 'Asma', 'Lumbalgia', 'Gastritis crónica', 'Faringitis aguda', 'Infección urinaria', 'Migraña', 'Hipotiroidismo', 'Dislipemia', 'Obesidad', 'Artrosis de rodilla', 'Bronquitis aguda', 'Amigdalitis aguda', 'Dermatitis de contacto', 'Otitis media aguda', 'Esguince de tobillo', 'Conjuntivitis', 'Anemia ferropénica', 'Reflujo gastroesofágico', 'Síndrome de intestino irritable', 'Tendinitis', 'Sinusitis aguda', 'Cefalea tensional', 'Varices', 'Hernia inguinal', 'Litiasis renal', 'Colelitiasis', 'Gastroenteritis aguda', 'Revisión de salud'])), 'F33.1')
domain('ES_SALUD_DIAGNOSTICO', 'ES_DIAGNOSTICO',
  byName(['diagn[oó]stico[a-z_]*|dx(_?(principal|secundario|ingreso|alta)[0-9]?)?|cie_?10(_?es)?|cie(_?(9|10|11|principal))?|(cod|codigo)_?(diagnostico|dx|cie)|juicio_?(cl[ií]nico|diagn[oó]stico)|impresi[oó]n_?diagn[oó]stica|enfermedad(es)?[a-z_]*|patolog[ií]a|comorbilidad(es)?|antecedentes?_?(m[eé]dicos|patol[oó]gicos|cl[ií]nicos|personales|familiares)|causa_?(de_?)?(muerte|defunci[oó]n|baja|ingreso)|motivo_?(de_?)?(consulta|baja|ingreso)|alergias?|diagnosis|diagnos(is|es)|icd_?(10|11)?', 0.85]),
  byPattern([[String.raw`[A-TV-Za-tv-z]\d{2}(\.[\dA-Za-z]{1,4}|\d|X)?`, 0.5]], { reject: 0.3 }))

// Procedures in CIE-10-ES Procedimientos: seven characters, digits and letters but neither I nor O.
decompose('ES_PROCEDIMIENTO', [
  [String.raw`([0-9A-HJ-NP-Z]{7})`, apply('ES_CM_DIGITOS_LETRAS')],
  [String.raw`(\d{4,6})`, DIGITS],
], apply(lookup('ES_PROCEDIMIENTO_TEXTO', 'es-procedimientos.txt', ['Consulta de medicina de familia', 'Consulta de urgencias', 'Hemograma completo', 'Glucemia basal', 'Análisis de orina', 'Creatinina sérica', 'Radiografía de tórax', 'Ecografía abdominal', 'Electrocardiograma', 'Control de embarazo'])), 'Determinación de carga viral de VIH')
domain('ES_SALUD_PROCEDIMIENTO', 'ES_PROCEDIMIENTO',
  byName(['procedimiento(_?(m[eé]dico|quir[uú]rgico|realizado|autorizado|cie))?|(cod|codigo)_?(procedimiento|prestaci[oó]n|intervenci[oó]n)|prestaci[oó]n_?(sanitaria|asistencial)|prueba_?(diagn[oó]stica|realizada|solicitada)|intervenci[oó]n_?quir[uú]rgica|cirug[ií]a(_?realizada)?|t[eé]cnica_?(diagn[oó]stica|quir[uú]rgica)|medical_?procedure', 0.85]))

const MEDICATIONS = ['Paracetamol', 'Ibuprofeno', 'Metamizol', 'Omeprazol', 'Metformina', 'Enalapril', 'Losartán', 'Amlodipino', 'Atorvastatina', 'Simvastatina', 'Levotiroxina', 'Amoxicilina', 'Amoxicilina/ácido clavulánico', 'Azitromicina', 'Salbutamol', 'Loratadina', 'Hidroclorotiazida', 'Ácido acetilsalicílico', 'Prednisona', 'Dexketoprofeno', 'Hierro sulfato', 'Ácido fólico', 'Vitamina D']
categorical('ES_MEDICAMENTO', 'es-medicamentos.txt', MEDICATIONS, 'Sertralina 50 mg')
domain('ES_SALUD_MEDICAMENTO', 'ES_MEDICAMENTO',
  byName(['medicamentos?(_?(recetado|prescrito|dispensado|nombre|activo))?|f[aá]rmacos?|principio_?activo|dci|c[oó]digo_?nacional|cn_?(medicamento|f[aá]rmaco)|receta(_?(electr[oó]nica|m[eé]dica))?|prescripci[oó]n(_?medicamento)?|posolog[ií]a|tratamiento_?(farmacol[oó]gico|actual|cr[oó]nico)|(cod|codigo)_?medicamento|medicament|botika|medications?|drugs?_?prescribed', 0.85]),
  byList([['es-detectar-medicamentos.txt', [...MEDICATIONS, 'paracetamol', 'nolotil', 'sertralina', 'fluoxetina', 'escitalopram', 'paroxetina', 'quetiapina', 'lorazepam', 'alprazolam', 'diazepam', 'lormetazepam', 'litio', 'metilfenidato', 'risperidona', 'olanzapina', 'haloperidol', 'tenofovir', 'emtricitabina', 'dolutegravir', 'insulina', 'acenocumarol', 'sintrom', 'levetiracetam', 'ácido valproico', 'misoprostol', 'levonorgestrel', 'anticonceptivo', 'metadona'], 0.7]], { reject: 0.3 }))

domain('ES_SALUD_TEXTO_CLINICO', 'ES_TEXTO_LIBRE',
  byName(['anamnesis|evoluci[oó]n(_?(m[eé]dica|cl[ií]nica|enfermer[ií]a))?|enfermedad_?actual|exploraci[oó]n_?f[ií]sica|plan_?(de_?)?(tratamiento|cuidados)|tratamiento_?indicado|juicio_?cl[ií]nico_?texto|informe_?(de_?)?alta|informe_?(m[eé]dico|cl[ií]nico|radiol[oó]gico|anatomopatol[oó]gico)|epicrisis|nota_?(m[eé]dica|de_?enfermer[ií]a|cl[ií]nica)|notas?_?(m[eé]dicas|cl[ií]nicas)|triaje(_?texto)?|curso_?cl[ií]nico|clinical_?notes?|discharge_?summary', 0.85]),
  byType(STRING(30)))

domain('ES_SALUD_RESULTADO_PRUEBA', 'ES_CM_ALFANUM',
  byName(
    ['resultado_?(de_?la_?)?(prueba|an[aá]lisis|anal[ií]tica|laboratorio|pcr|serolog[ií]a|biopsia|citolog[ií]a)|(prueba|an[aá]lisis|anal[ií]tica)_?(resultado|laboratorio)|glucemia|glucosa|hemoglobina(_?glicada)?|hba1c|colesterol(_?(total|hdl|ldl))?|imc|tensi[oó]n_?arterial|test_?(de_?)?embarazo|espirometr[ií]a|alcoholemia|lab_?results?|test_?results?', 0.8],
    ['resultado|prueba|analisis|analitica', 0.5],
  ))

// HIV and the other sexually transmitted infections: the status that most often turns into
// discrimination, and Ley 15/2022 names the "estado serológico" among its grounds.
domain('ES_SALUD_VIH', 'ES_CATEGORIA_SUPRIMIDA',
  byName(['vih(_?(estado|resultado|prueba|diagn[oó]stico|positivo))?|hiv|sida|aids|serolog[ií]a_?(vih|hiv)|estado_?serol[oó]gico|carga_?viral|cd4|tar|tratamiento_?antirretroviral|antirretroviral(es)?|prep|profilaxis_?pre_?exposici[oó]n|its|ets|infecci[oó]n(es)?_?(de_?)?transmisi[oó]n_?sexual|s[ií]filis|hepatitis_?[bc]|tuberculosis|tbc', 0.9]))

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']
lookup('ES_GRUPO_SANGUINEO', 'es-grupos-sanguineos.txt', BLOOD_GROUPS, 'O+', 'PRESERVE_LOOKUP_FILE')
domain('ES_SALUD_GRUPO_SANGUINEO', 'ES_GRUPO_SANGUINEO',
  byName(['grupo_?sangu[ií]neo|tipo_?(de_?)?sangre|rh|factor_?rh|grupo_?rh|abo(_?rh)?|grup_?sanguini|blood_?(type|group)', 0.9]),
  byList([['es-detectar-grupos-sanguineos.txt', [...BLOOD_GROUPS, '0+', '0-', 'a positivo', 'a negativo', 'b positivo', 'b negativo', 'ab positivo', 'ab negativo', 'o positivo', 'o negativo', '0 positivo', '0 negativo'], 0.9]], { reject: 0.4 }))

// The certificate of disability states a degree — 33% opens the protection of the Real Decreto
// Legislativo 1/2013 — under the scale of Real Decreto 888/2022.
const DISABILITIES = ['Física', 'Orgánica', 'Visual', 'Auditiva', 'Intelectual', 'Enfermedad mental', 'Múltiple', 'Sin discapacidad reconocida']
categorical('ES_DISCAPACIDAD', 'es-discapacidades.txt', DISABILITIES, 'Trastorno del espectro autista')
domain('ES_SALUD_DISCAPACIDAD', 'ES_DISCAPACIDAD',
  byName(['discapacidad[a-z_]*|minusval[ií]a|(tipo|cod|codigo|grado|porcentaje)_?(de_?)?(discapacidad|minusval[ií]a)|persona_?con_?discapacidad|certificado_?(de_?)?discapacidad|tarjeta_?(de_?)?discapacidad|movilidad_?reducida|necesidades_?educativas_?especiales|neae|discapacitat|desgaitasuna|disabilit(y|ies)', 0.9]),
  byList([['es-detectar-discapacidades.txt', [...DISABILITIES, 'física', 'motora', 'orgánica', 'visual', 'ceguera', 'auditiva', 'sordera', 'intelectual', 'psíquica', 'mental', 'múltiple', 'autismo', 'tea', 'ninguna', 'no'], 0.6]], { reject: 0.3 }))

// Ley 39/2006 de dependencia grades a person I to III, and the grade decides the care and the
// benefit: a datum on health, and on the household beside it.
const DEPENDENCY = ['Grado I - Dependencia moderada', 'Grado II - Dependencia severa', 'Grado III - Gran dependencia', 'Sin grado reconocido', 'En valoración']
categorical('ES_DEPENDENCIA', 'es-dependencia.txt', DEPENDENCY, 'Grado II nivel 1', ['1', '2', '3'])
domain('ES_SALUD_DEPENDENCIA', 'ES_DEPENDENCIA',
  byName(['dependencia(_?(grado|reconocida|valoraci[oó]n))?|grado_?(de_?)?dependencia|gran_?dependencia|ley_?(de_?)?dependencia|pia|programa_?individual_?(de_?)?atenci[oó]n|cuidador_?(no_?profesional|familiar)|prestaci[oó]n_?(econ[oó]mica_?)?(vinculada_?al_?servicio|cuidados_?en_?el_?entorno_?familiar)|ayuda_?a_?domicilio|teleasistencia|depend[eè]ncia|mendekotasuna', 0.9]),
  byList([['es-detectar-dependencia.txt', [...DEPENDENCY, 'grado i', 'grado ii', 'grado iii', 'moderada', 'severa', 'gran dependencia', 'sin grado'], 0.7]], { reject: 0.3 }))

// Article 22.4 of Ley 31/1995 de prevención de riesgos laborales keeps the results of the
// surveillance of a worker's health from the employer except as fit or unfit; sick leave carries the
// diagnosis behind it.
categorical('ES_APTITUD_LABORAL', 'es-aptitud-laboral.txt', ['Apto', 'Apto con restricciones', 'No apto', 'Pendiente de calificación'], 'No apto temporal')
domain('ES_SALUD_LABORAL', 'ES_APTITUD_LABORAL',
  byName(['aptitud_?(laboral|m[eé]dica)|certificado_?(de_?)?aptitud|reconocimiento_?m[eé]dico|vigilancia_?(de_?la_?)?salud|examen_?(de_?)?salud|accidente_?(de_?)?trabajo|enfermedad_?(profesional|laboral)|incapacidad_?(temporal|permanente)|baja_?(m[eé]dica|laboral|por_?enfermedad)|it(_?(d[ií]as|motivo|contingencia))?|parte_?(de_?)?(baja|alta|confirmaci[oó]n)|d[ií]as_?(de_?)?baja|absentismo|contingencia_?(com[uú]n|profesional)', 0.85]),
  byList([['es-detectar-aptitud-laboral.txt', ['apto', 'no apto', 'apto con restricciones', 'pendiente', 'contingencia común', 'contingencia profesional', 'accidente de trabajo', 'enfermedad común'], 0.6],
    ['es-detectar-codigos-banderas.txt', ['s', 'n', 'sí', 'no', '1', '2', '3', '4', '5', '6', '7', '8', '9'], 0.3],
  ], { reject: 0.3 }))

domain('ES_SALUD_REPRODUCTIVA', 'ES_CATEGORIA_SUPRIMIDA',
  byName(['embarazo|embarazada|gestante|gestaci[oó]n|edad_?gestacional|semanas_?(de_?)?gestaci[oó]n|fur|fecha_?[uú]ltima_?regla|control_?(de_?)?embarazo|prenatal|parto(_?tipo)?|ces[aá]rea|ive|interrupci[oó]n_?(voluntaria_?)?(del_?)?embarazo|aborto|m[eé]todo_?anticonceptivo|anticoncepci[oó]n|planificaci[oó]n_?familiar|reproducci[oó]n_?asistida|fecundaci[oó]n_?in_?vitro|fiv|salud_?(sexual|reproductiva)|pregnan(t|cy)|contracepti(on|ve)', 0.9]))

domain('ES_SALUD_MENTAL', 'ES_CATEGORIA_SUPRIMIDA',
  byName(['salud_?mental|trastorno[a-z_]*|psiqui[aá]tri[a-z_]*|psicol[oó]gi[a-z_]*|depresi[oó]n|ansiedad|suicid[a-z_]*|tentativa_?(de_?)?suicidio|autolesi[oó]n|conducta_?suicida|consumo_?(de_?)?(sustancias|alcohol|drogas|t[oó]xicos)|adicci[oó]n(es)?|drogodependencia|alcoholismo|tabaquismo|ludopat[ií]a|cad|centro_?(de_?)?atenci[oó]n_?(a_?las_?)?(adicciones|drogodependencias)|mental_?health', 0.9]))


// ── FIN · Economic data (art. 20 LOPDGDD and art. 95 LGT) ───────────────────
//
// Article 20 of the LOPDGDD lets common credit information systems — the ASNEF and Badexcug files —
// keep a debt only "mientras persista el incumplimiento, con el límite máximo de cinco años", and
// article 3 forbids using that presumption to build a profile from other sources. The Central de
// Información de Riesgos of the Banco de España holds the loans of every borrower. Article 95
// of the Ley General Tributaria calls every datum the Agencia Tributaria obtains "reservado". And Ley
// 15/2022 names the "situación socioeconómica" among the grounds of discrimination.

decompose('ES_HISTORIAL_CREDITICIO', [
  [String.raw`(\d{1,4})`, DIGITS],
  [FLAG, apply('ES_BANDERA')],
], apply(lookup('ES_ESTADO_CREDITO', 'es-estados-credito.txt', ['Sin incidencias', 'Incluido en fichero de morosos', 'Deuda saldada', 'Deuda reclamada judicialmente', 'En reclamación', 'Riesgo normal', 'Riesgo en vigilancia especial', 'Riesgo dudoso', 'Riesgo fallido', 'Refinanciado', 'Sin historial'])), 'Incluido en ASNEF')
domain('ES_FIN_HISTORIAL_CREDITICIO', 'ES_HISTORIAL_CREDITICIO',
  byName(['historial_?(crediticio|de_?cr[eé]dito)|asnef|badexcug|experian|equifax|fichero_?(de_?)?(morosos|morosidad|solvencia)|cirbe|central_?(de_?)?(informaci[oó]n_?de_?)?riesgos|scoring(_?(crediticio|interno))?|score(_?crediticio)?|puntuaci[oó]n_?(de_?)?cr[eé]dito|calificaci[oó]n_?(de_?)?(riesgo|cr[eé]dito|solvencia)|clasificaci[oó]n_?(del_?)?riesgo|d[ií]as_?(de_?)?(impago|mora|atraso)|morosidad|moroso|impagad[oa]s?|situaci[oó]n_?(de_?)?(impago|deuda)|credit_?score|credit_?rating', 0.9]))

// Amounts in euros: the minimum wage of 2026 is some 1,200 euros a month in fourteen payments.
algorithm('ES_VALOR_DEUDA', 'characterMapping.NumericMapping', { minValue: 100, maxValue: 600000 }, '18500')
domain('ES_FIN_DEUDA', 'ES_VALOR_DEUDA',
  byName(['saldo_?(deudor|deuda|pendiente|vivo|impagado|pr[eé]stamo|hipoteca)|importe_?(de_?la_?)?(deuda|cuota|pr[eé]stamo|hipoteca|impagado|embargo|financiado)|deuda(_?total)?|capital_?pendiente|l[ií]mite_?(de_?)?(cr[eé]dito|tarjeta)|cuota_?(mensual|hipoteca|pr[eé]stamo)|embargo(_?(importe|cantidad))?|loan_?(amount|balance)|outstanding_?balance|debt', 0.85]),
  byType(NUMBER()))

algorithm('ES_INGRESOS', 'characterMapping.NumericMapping', { minValue: 1000, maxValue: 120000 }, '28500')
domain('ES_FIN_INGRESOS', 'ES_INGRESOS',
  byName(['sueldo(_?(bruto|neto|mensual|base|anual))?|salario(_?(bruto|neto|mensual|base|anual))?|n[oó]mina(_?(bruta|neta|importe))?|retribuci[oó]n(_?(bruta|anual|mensual))?|ingresos?(_?(mensuales?|anuales?|totales?|familiares?|netos?|brutos?|unidad_?familiar))?|rendimientos?_?(del_?)?(trabajo|capital)|renta(_?(bruta|neta|anual|disponible|per_?c[aá]pita))?|salari|sou|soldata|salary|income|wages?', 0.85]),
  byType(NUMBER()))

algorithm('ES_PATRIMONIO', 'characterMapping.NumericMapping', { minValue: 1000, maxValue: 3000000 }, '185000')
domain('ES_FIN_PATRIMONIO', 'ES_PATRIMONIO',
  byName(['patrimonio(_?(neto|total))?|valor_?(catastral|de_?tasaci[oó]n|del_?inmueble|de_?la_?vivienda|de_?mercado|del_?veh[ií]culo)|tasaci[oó]n|saldo_?(cuenta|ahorro|dep[oó]sito|inversi[oó]n|fondo|medio)|dep[oó]sitos?|inversiones|cartera_?(de_?)?valores|fondos?_?(de_?)?(inversi[oó]n|pensiones)|plan_?(de_?)?pensiones|net_?worth|account_?balance', 0.85]),
  byType(NUMBER()))

// The highest contributory pension of 2026 is around 3,360 euros a month.
algorithm('ES_VALOR_PENSION', 'characterMapping.NumericMapping', { minValue: 500, maxValue: 3400 }, '1250')
domain('ES_FIN_PENSION', 'ES_VALOR_PENSION',
  byName(['pensi[oó]n(_?(importe|mensual|anual|jubilaci[oó]n|viudedad|orfandad|incapacidad|alimentos|compensatoria|no_?contributiva))?|importe_?(pensi[oó]n|prestaci[oó]n|subsidio)|base_?reguladora|pensi[oó]_?(import)?|pension_?amount', 0.9]),
  byType(NUMBER()))

const BENEFITS = ['Ingreso Mínimo Vital', 'Prestación por desempleo', 'Subsidio por desempleo', 'Renta mínima autonómica', 'Pensión no contributiva', 'Prestación por hijo a cargo', 'Complemento de ayuda para la infancia', 'Bono social eléctrico', 'Bono social térmico', 'Prestación por dependencia', 'Beca de carácter general', 'Ninguna']
categorical('ES_PRESTACION_SOCIAL', 'es-prestaciones-sociales.txt', BENEFITS, 'Ayuda de emergencia social')
domain('ES_FIN_PRESTACION_SOCIAL', 'ES_PRESTACION_SOCIAL',
  byName(['prestaci[oó]n(_?(social|por_?desempleo|econ[oó]mica))?|subsidio(_?(desempleo|agrario))?|ingreso_?m[ií]nimo_?vital|imv|renta_?(m[ií]nima|garantizada|de_?inserci[oó]n|valenciana_?de_?inclusi[oó]n|social)|rmi|rgi|bono_?social|beneficiario_?(imv|prestaci[oó]n|subsidio|bono|beca)|beca(_?(mec|general|comedor))?|ayuda_?(social|de_?emergencia|al_?alquiler)|vulnerabilidad|riesgo_?(de_?)?exclusi[oó]n|situaci[oó]n_?socioecon[oó]mica|nivel_?socioecon[oó]mico|sepe|social_?benefit', 0.9]),
  byList([['es-detectar-prestaciones-sociales.txt', [...BENEFITS, 'imv', 'paro', 'desempleo', 'subsidio', 'renta mínima', 'rmi', 'rgi', 'pnc', 'bono social', 'beca', 'ninguna'], 0.8],
    ['es-detectar-codigos-banderas.txt', ['s', 'n', 'sí', 'no', '1', '2', '3', '4', '5', '6', '7', '8', '9'], 0.3],
  ], { reject: 0.4 }))

// Tax data: a base, a quota or the result of a return. Negative results — a refund — keep their
// sign, and cents stay cents.
algorithm('ES_IMPORTE_TRIBUTARIO', 'characterMapping.NumericMapping', { minValue: 0, maxValue: 250000 }, '24350')
decompose('ES_TRIBUTARIO', [
  [String.raw`(-?)(\d+)([.,]\d{1,2})`, keep, apply('ES_IMPORTE_TRIBUTARIO'), keep],
  [String.raw`(-?)(\d+)`, keep, apply('ES_IMPORTE_TRIBUTARIO')],
], keep, '-1240.55')
domain('ES_FIN_TRIBUTARIO', 'ES_TRIBUTARIO',
  byName(['irpf(_?(base|cuota|resultado|retenci[oó]n|importe))?|base_?(imponible|liquidable)(_?(general|ahorro))?|cuota_?([ií]ntegra|l[ií]quida|diferencial|tributaria)|resultado_?(de_?la_?)?declaraci[oó]n|declaraci[oó]n_?(de_?la_?)?renta|renta_?(declarada|imponible)|retenci[oó]n(es)?_?(irpf|practicadas)|modelo_?(100|190|714)|impuesto_?(sobre_?el_?)?patrimonio|deducci[oó]n(es)?_?(auton[oó]mica|estatal)|tax_?(base|return|amount)', 0.9]))


// ── PENAL · Offences (art. 10 RGPD, art. 10 and art. 27 LOPDGDD) ────────────
//
// Article 10 of the LOPDGDD allows data on criminal convictions and offences, outside the
// authorities, only where a law with the rank of law covers them, and article 72.1 f) makes any
// other processing a very serious infringement. Article 136 of the Código Penal cancels an entry in
// the Registro Central de Penados after a term that runs from six months to ten years; a copy keeps
// it for as long as the copy lives. Article 27 extends the regime to administrative infringements
// and sanctions — a fine, the points of a driving licence — which only the authority that imposes
// them may keep.

categorical('ES_ANTECEDENTES', 'es-antecedentes.txt', ['Sin antecedentes penales', 'Con antecedentes penales', 'Antecedentes cancelados', 'Causa pendiente', 'Sentencia condenatoria', 'Sentencia absolutoria', 'Sobreseimiento', 'Sin información'], 'Condenado por hurto en 2019')
domain('ES_PENAL_ANTECEDENTES', 'ES_ANTECEDENTES',
  byName(
    ['antecedentes?(_?(penales|policiales|judiciales))?|certificado_?(de_?)?antecedentes(_?penales)?|registro_?central_?(de_?)?penados|reincidencia|condena(_?(penal|tipo))?|delito(_?(tipo|cometido))?|tipo_?(de_?)?delito|situaci[oó]n_?(penal|procesal|penitenciaria)|medida_?cautelar|prisi[oó]n_?provisional|privad[oa]_?(de_?)?libertad|interno_?penitenciario|centro_?penitenciario|libertad_?condicional|antecedents_?penals|criminal_?record', 0.95],
    ['estado_?(del_?)?proceso|sentencia|fallo', 0.55],
  ))

// Article 57 of Ley Orgánica 8/2021 (LOPIVI) requires anyone working with minors to present a
// negative certificate of the Registro Central de Delincuentes Sexuales y de Trata de Seres Humanos;
// schools, clubs and companies keep the column — and its value is a criminal-record datum.
categorical('ES_DELITOS_SEXUALES', 'es-certificado-delitos-sexuales.txt', ['Certificado negativo aportado', 'Certificado pendiente', 'Certificado caducado', 'No aportado', 'Exento'], 'Certificado positivo')
domain('ES_PENAL_DELITOS_SEXUALES', 'ES_DELITOS_SEXUALES',
  byName(['certificado_?(negativo_?)?(de_?)?(delitos?_?(de_?naturaleza_?)?sexual(es)?|registro_?(central_?)?(de_?)?delincuentes_?sexuales)|delitos?_?sexuales|delincuentes_?sexuales|rcds|registro_?delincuentes|lopivi(_?certificado)?|certificat_?(de_?)?delictes_?sexuals', 0.95]),
  byList([['es-detectar-certificado-delitos-sexuales.txt', ['certificado negativo', 'negativo', 'positivo', 'aportado', 'no aportado', 'pendiente', 'caducado', 'exento'], 0.6]], { reject: 0.3 }))

// A court case carries a NIG — the general identification number of the procedure, printed in
// groups, `28079 43 2 2023 0012345` — and the number of the case in its court, `PA 123/2023`. The
// correlative changes; the code of the court seat, the jurisdiction and the year stay.
decompose('ES_PROCEDIMIENTO_JUDICIAL', [
  [String.raw`(\d{5}\s?\d{2}\s?\d\s?\d{4}\s?)(\d{7})`, keep, DIGITS],
  [String.raw`([A-Za-z]{1,6}\.?\s*)(\d{1,6})(\s*/\s*)(\d{2,4})`, keep, DIGITS, keep, keep],
  [String.raw`(\d{1,6})(\s*/\s*)(\d{2,4})`, DIGITS, keep, keep],
], CM, '28079 43 2 2023 0012345')
domain('ES_PENAL_PROCEDIMIENTO', 'ES_PROCEDIMIENTO_JUDICIAL',
  byName(
    ['nig|n(o|ro|um|umero)_?(de_?)?identificaci[oó]n_?general|n(o|ro|um|umero)_?(de_?)?(procedimiento|autos|diligencias|asunto|causa|sumario|ejecutoria|atestado|denuncia)(_?(judicial|penal|previas))?|procedimiento_?(judicial|penal)|diligencias_?(previas|urgentes)|sumario|atestado(_?policial)?|ejecutoria', 0.9],
    ['procedimiento|causa|autos|expediente_?judicial', 0.5],
  ),
  byPattern([[String.raw`\d{5}\s?\d{2}\s?\d\s?\d{4}\s?\d{7}`, 0.9]], { reject: 0.3 }))

categorical('ES_SANCION_ADMINISTRATIVA', 'es-sanciones-administrativas.txt', ['Sin sanciones', 'Sanción leve', 'Sanción grave', 'Sanción muy grave', 'Pérdida de puntos', 'Suspensión del permiso de conducir', 'Recurrida', 'Prescrita'], 'Multa de tráfico por exceso de velocidad')
domain('ES_PENAL_SANCION_ADMINISTRATIVA', 'ES_SANCION_ADMINISTRATIVA',
  byName(['sanci[oó]n(es)?(_?(administrativa|tipo|grado))?|infracci[oó]n(es)?(_?(administrativa|tr[aá]fico|tipo))?|expediente_?sancionador|multa(s)?(_?(tr[aá]fico|importe|tipo))?|denuncia_?(de_?)?tr[aá]fico|puntos?_?(del_?)?(carn[eé]|permiso)|saldo_?(de_?)?puntos|p[eé]rdida_?(de_?)?puntos|retirada_?(del_?)?(carn[eé]|permiso)|administrative_?(sanction|penalty)|traffic_?fine', 0.9]))


// ── Preset ──────────────────────────────────────────────────────────────────

const referenced = JSON.stringify([domains, algorithms.map((x) => x.config)])
const orphans = algorithms.filter((a) => !referenced.includes(`"${a.name}"`))
if (orphans.length) throw new Error(`algorithms nobody uses: ${orphans.map((a) => a.name).join(', ')}`)
const noInput = algorithms.filter((a) => a.input === undefined)
if (noInput.length) throw new Error(`algorithms without a sample input: ${noInput.map((a) => a.name).join(', ')}`)

// The essential pack: identity documents, names, contact, address and birth date. Loading it brings
// these domains and only what they lean on; the extended pack is everything.
const ESSENTIAL = [
  'ES_L1_DNI', 'ES_L1_NIE', 'ES_L1_PASAPORTE', 'ES_L1_NSS',
  'ES_L1_NOMBRE', 'ES_L1_APELLIDO', 'ES_L1_NOMBRE_COMPLETO',
  'ES_L1_EMAIL', 'ES_L1_TELEFONO', 'ES_L1_DIRECCION', 'ES_L1_DIRECCION_COMPLEMENTO',
  'ES_L2_FECHA_NACIMIENTO',
]
const notDomains = ESSENTIAL.filter((name) => !domains.some((d) => d.name === name))
if (notDomains.length) throw new Error(`essential pack names domains the set does not have: ${notDomains.join(', ')}`)

// The version and the day it was built: bump both whenever anything in the set changes, so that
// whoever loaded an older one can see how old it is.
const VERSION = 1
const VERSION_DATE = '2026-10-02'
const preset = {
  version: VERSION,
  versionDate: VERSION_DATE,
  name: {
    en: 'Spain — GDPR and Ley Orgánica 3/2018 (LOPDGDD)',
    'pt-BR': 'Espanha — RGPD e Ley Orgánica 3/2018 (LOPDGDD)',
    es: 'España — RGPD y Ley Orgánica 3/2018 (LOPDGDD)',
  },
  summary: {
    en: 'Discovers and masks Spanish personal data under the General Data Protection Regulation and Ley Orgánica 3/2018 (LOPDGDD): direct identifiers (DNI and NIE with a valid letter, Seguridad Social number, IBAN and CCC and the referencia catastral and CUPS with valid control characters, names, contact, address, plates), quasi-identifiers (birth date, municipio, INE code and postal code generalized below 20,000 inhabitants, nationality and residence status), the special categories of article 9 — for which article 9.1 of the LOPDGDD says consent alone is not enough —, health data, credit information and the tax data article 95 of the Ley General Tributaria calls reserved, and criminal records, sexual-offence certificates and administrative sanctions.',
    'pt-BR': 'Descobre e mascara dados pessoais espanhóis segundo o Regulamento Geral de Proteção de Dados e a Ley Orgánica 3/2018 (LOPDGDD): identificadores diretos (DNI e NIE com letra válida, número da Seguridad Social, IBAN e CCC, a referencia catastral e o CUPS com caracteres de controle válidos, nomes, contato, endereço, placas), quase-identificadores (data de nascimento, município, código INE e código postal generalizados abaixo de 20.000 habitantes, nacionalidade e situação de residência), as categorias especiais do artigo 9 — para as quais o artigo 9.1 da LOPDGDD diz que o consentimento sozinho não basta —, dados de saúde, informação de crédito e os dados tributários que o artigo 95 da Ley General Tributaria chama de reservados, e antecedentes penais, certificados de delitos sexuais e sanções administrativas.',
    es: 'Descubre y enmascara datos personales españoles conforme al Reglamento General de Protección de Datos y a la Ley Orgánica 3/2018 (LOPDGDD): identificadores directos (DNI y NIE con letra válida, número de la Seguridad Social, IBAN y CCC, la referencia catastral y el CUPS con caracteres de control válidos, nombres, contacto, dirección, matrículas), cuasi-identificadores (fecha de nacimiento, municipio, código INE y código postal generalizados por debajo de 20.000 habitantes, nacionalidad y situación administrativa), las categorías especiales del artículo 9 — para las que el artículo 9.1 de la LOPDGDD dice que el solo consentimiento no basta —, datos de salud, información crediticia y los datos tributarios que el artículo 95 de la Ley General Tributaria declara reservados, y antecedentes penales, certificados de delitos sexuales y sanciones administrativas.',
  },
  profileSet: {
    name: `ES - LOPDGDD - v${VERSION}`,
    description: 'Identificadores directos, cuasi-identificadores, categorías especiales de datos (art. 9 RGPD y art. 9 LOPDGDD), datos de salud, datos económicos y tributarios y datos penales y de infracciones administrativas (art. 10 RGPD, arts. 10 y 27 LOPDGDD), conforme al Reglamento (UE) 2016/679 y a la Ley Orgánica 3/2018 de Protección de Datos Personales y garantía de los derechos digitales.',
    threshold: 60,
    classifiers: classifiers.map((c) => c.name),
  },
  packs: {
    essential: {
      description: 'Paquete esencial de la LOPDGDD: DNI, NIE, pasaporte, número de la Seguridad Social, nombres, contacto, dirección y fecha de nacimiento.',
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

const small = municipioPlaces.filter((m) => m.small)
const inSmall = small.reduce((a, m) => a + m.population, 0)
const lines = [...files.values()].reduce((a, l) => a + l.length, 0)
console.log(`${domains.length} domains, ${classifiers.length} classifiers, ${algorithms.length} algorithms, ${files.size} files (${lines} lines)`)
console.log(`municipios: ${small.length} of ${MUNICIPIOS.length} under ${SMALL_PLACE} (${inSmall} people); ${places.names} names generalized, ${places.table.length} table lines, ${codePairs.length} codes, ${postalPairs.length} postal codes`)
