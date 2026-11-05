#!/usr/bin/env node
/**
 * Builds the Portugal (Regulamento (UE) 2016/679 and Lei n.º 58/2019, de 8 de agosto, which ensures
 * its execution in Portuguese law) pre-configured profile set: preset.json and files/.
 *
 *   node presets/portugal-lei-58-2019/build.mjs
 *
 * source/ holds the hand-kept lists — the given names and surnames most Portuguese carry — and the
 * geography: the 308 concelhos with their DICO code, distrito or autonomous region, location (from
 * GeoNames) and population of the Censos 2021 (INE); the 3,092 freguesias of the 2013 map with
 * their population in the same census, and the 303 the 2025 reorganization brought back (Lei n.º
 * 25-A/2025), with the population GeoNames gives them; and the 760 four-digit postal codes (CP4)
 * of the CTT with the concelhos they reach. Everything in files/ and preset.json is generated from
 * them and from the definitions below — edit here, then build, then run verify.mjs.
 *
 * Structure of the set
 *   L1     direct identifiers      the four numbers of the Cartão de Cidadão — the civil
 *                                  identification number and the document number **with valid
 *                                  check characters**, the NIF and the NISS **with a valid check
 *                                  digit** (the número de utente is in SAUDE) —, passport,
 *                                  residence permit, names, contact, address, the IBAN and NIB
 *                                  **with valid check digits**, cards, the CPE of an electricity
 *                                  or gas supply **with valid control letters**, plates, devices,
 *                                  free text
 *   L2     quasi-identifiers       birth date, age, sex, concelho and freguesia and their codes,
 *                                  postal code (generalized below 20,000 inhabitants), nationality
 *                                  and residence status, marital status, occupation, employer,
 *                                  education
 *   L3     special categories      art. 9 RGPD and art. 35.3 of the Constitution: ethnic origin,
 *                                  political opinions and party membership, religious or
 *                                  philosophical beliefs, trade union membership, genetic and
 *                                  biometric data, sex life and sexual orientation — plus gender
 *                                  identity (Lei n.º 38/2018) and victims of domestic violence
 *                                  (Lei n.º 112/2009)
 *   SAUDE  health data             art. 9 RGPD, art. 29 of Lei n.º 58/2019 and Lei n.º 12/2005: the
 *                                  número de utente **with a valid check digit**, the prescription
 *                                  number **with a valid check character**, health subsystems,
 *                                  diagnoses, disability, dependency, fitness for work
 *   FIN    economic data           credit, debt, income, assets, pensions, social benefits and the
 *                                  tax data article 64 of the Lei Geral Tributária keeps confidential
 *   PENAL  offences                art. 10 RGPD and art. 13 b) of Lei n.º 58/2019 — criminal and
 *                                  contraordenacional convictions —, the criminal record (Lei n.º
 *                                  37/2015) and the certificate for work with minors (Lei n.º
 *                                  113/2009)
 */
import fs from 'node:fs'
import nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { engineTextProblems } from '../_lib/engine-text.mjs'
import { ENGINE, isEngineAlgorithm } from '../_lib/engine-algorithms.mjs'
import { cleaning, zeroPadded, keepingZeros, wordByWord, valuePatterns } from '../_lib/detect.mjs'

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
/**
 * A Character Mapping of digits that keeps zeros on the left — padding, in a number of any width —
 * has a twin without the parameter for numbers of fixed width, where a zero is a digit like any
 * other: the body handed to a Check Digit, the account inside a NIB.
 */
function fixedWidth(name) {
  const source = algorithms.find((a) => a.name === name)
  if (!source) throw new Error(`fixedWidth: ${name} must be defined first`)
  if (!source.config.preserveLeadingZeros) return name
  const twin = `${name}_LARGURA_FIXA`
  if (!algorithms.some((a) => a.name === twin)) {
    const { preserveLeadingZeros, ...config } = source.config
    algorithm(twin, source.framework.replace(/^algorithm\.plugin\./, ''), config, source.input)
  }
  return twin
}
const use = (name) => ({ name })
const keep = { type: 'PRESERVE' }
const apply = (name) => ({ type: 'APPLY_ALGORITHM', algorithm: use(name) })
const redactAs = (text) => ({ type: 'REDACT', redactString: text })

/** Regex Decompose: each pattern is [regex, ...one action per capture group]. */
function decompose(name, patterns, fallback, input) {
  for (const [regex, ...actions] of patterns) {
    const groups = new RegExp(`${regex.replace(/^\(\?[a-z]+\)/, '')}|`).exec('').length - 1
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
  if (!isEngineAlgorithm(algorithmName) && !algorithms.some((a) => a.name === algorithmName)) throw new Error(`${name}: no algorithm ${algorithmName}`)
  domains.push({ name, algorithm: algorithmName })
  for (const make of detect) classifiers.push(make(name))
}

/** Column names: alternatives that must not be glued to other letters (digits and _ are fine). */
const words = (alternatives) => String.raw`(?i)(?<![a-z])(?:${alternatives})(?![a-z])`

const byName = (...rules) => (d) => ({
  name: `${d} - Path`, framework: 'PATH', domain: d,
  description: 'Nome da coluna em português ou em inglês.',
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
  description: 'Descarta colunas cujo tipo não pode conter este dado.',
  config: { allowedTypes: allowed, matchAutoIncrementingColumn: false, matchStrength: 0, rejectStrength: 1 },
})

/**
 * Values: [regex, strength, { checksum, clean, note }]. Whole value unless `partial`. The spaces a
 * CHAR column pads with are cleaned away, and a pattern that starts with a digit also takes zeros
 * on the left (see presets/_lib/detect.mjs).
 */
const byPattern = (rules, { reject = 0.3, partial = false } = {}) => (d) => ({
  name: `${d} - Regex`, framework: 'REGEX', domain: d,
  description: 'Formato dos valores.',
  config: {
    dataPatterns: rules.map(([regex, strength, extra = {}]) => ({
      ...(extra.note ? { note: extra.note } : {}),
      regex: zeroPadded(regex), matchStrength: strength,
      checksumType: extra.checksum ?? 'NONE',
      caseSensitive: false, allowPartialMatch: partial,
      dataCleanRegex: cleaning(extra.clean),
    })),
    rejectStrength: reject,
  },
})

/**
 * Values found in lists: [fileName, values, strength]. A List classifier compares the whole value,
 * padding included, unless it splits it into words: lists of single words are looked up word by
 * word, and lists with multi-word values become Regex patterns (presets/_lib/detect.mjs).
 */
const byList = (lists, { reject = 0.3, tokenize = false } = {}) => (d) => {
  const known = lists.map(([fileName, values, strength]) => ({ fileName, values: withFolded(values), shown: unique(values), strength }))
  if (tokenize || known.every((l) => wordByWord(l.values))) {
    return {
      name: `${d} - List`, framework: 'LIST', domain: d,
      description: 'Valores conhecidos.',
      config: {
        valueLists: known.map((l) => ({ file: file(l.fileName, l.values), matchStrength: l.strength })),
        tokenizeInput: true,
        rejectStrength: reject,
        tokenizationDelimiter: ' ',
      },
    }
  }
  return {
    name: `${d} - Values`, framework: 'REGEX', domain: d,
    description: 'Valores conhecidos.',
    config: {
      dataPatterns: known.flatMap((l) => valuePatterns(l.values, l.shown).map(({ note, regex, dataCleanRegex }) => ({
        note, regex, matchStrength: l.strength, checksumType: 'NONE', caseSensitive: false, allowPartialMatch: false, dataCleanRegex,
      }))),
      rejectStrength: reject,
    },
  }
}

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

const GIVEN_NAMES = unique(readLines('nomes.txt'))
const SURNAMES = unique(readLines('apelidos.txt'))

const REGIONS = readLines('distritos.tsv').map((line) => {
  const [code, name] = line.split('\t')
  return { code, name }
})
const regionByCode = new Map(REGIONS.map((r) => [r.code, r]))
const CONCELHOS = readLines('concelhos.tsv').map((line) => {
  const [code, name, regionCode, region, lat, lon, population] = line.split('\t')
  return { code, name, aliases: [], regionCode, region, lat: Number(lat), lon: Number(lon), population: Number(population) }
})
const concelhoByCode = new Map(CONCELHOS.map((c) => [c.code, c]))
/**
 * era: `2013-` a freguesia of the 2013 map that still exists, `2013-2025` a union of freguesias that
 * the 2025 reorganization dissolved, `2025-` one it brought back.
 */
const FREGUESIAS = readLines('freguesias.tsv').map((line) => {
  const [code, name, concelhoCode, population, era] = line.split('\t')
  return { code, name, aliases: [], concelhoCode, population: Number(population), era }
})
const POSTAL_CODES = readLines('codigos-postais.tsv').map((line) => {
  const [code, concelhos, counts] = line.split('\t')
  return { code, concelhos: concelhos.split(';'), counts: counts.split(';').map(Number) }
})
if (REGIONS.length !== 20) throw new Error(`expected 18 distritos and the 2 autonomous regions, found ${REGIONS.length}`)
if (CONCELHOS.length !== 308) throw new Error(`expected the 308 concelhos, found ${CONCELHOS.length}`)
if (FREGUESIAS.filter((f) => f.era.startsWith('2013')).length !== 3092) throw new Error('expected the 3,092 freguesias of the 2013 map')
for (const c of CONCELHOS) {
  if (!/^\d{4}$/.test(c.code) || !regionByCode.has(c.regionCode)) throw new Error(`${c.name}: bad DICO ${c.code}`)
  if (Number.isNaN(c.lat) || Number.isNaN(c.lon) || !(c.population > 0)) throw new Error(`${c.name}: no location or population`)
}
for (const f of FREGUESIAS) {
  if (!/^\d{4}[0-9A-Z]{2}$/.test(f.code) || f.code.slice(0, 4) !== f.concelhoCode || !concelhoByCode.has(f.concelhoCode)) throw new Error(`${f.name}: bad DICOFRE ${f.code}`)
}
for (const p of POSTAL_CODES) {
  if (!/^[1-9]\d{3}$/.test(p.code) || !p.concelhos.every((c) => concelhoByCode.has(c))) throw new Error(`postal code ${p.code}: bad line`)
}
// Every distrito and both regions hold a concelho of 20,000, so a generalized concelho never leaves
// its distrito or its archipelago.
for (const r of REGIONS) {
  if (!CONCELHOS.some((c) => c.regionCode === r.code && c.population >= 20000)) throw new Error(`${r.name}: no concelho of 20,000`)
}


// ── Shared algorithms ───────────────────────────────────────────────────────

// Vowels map to vowels and consonants to consonants, so a masked document number keeps its
// structure; digits map to digits; the accented vowels of Portuguese map among themselves — the acute
// ones together, the circumflex and the tilde together, since a group needs three letters. Ç and the
// separators are in no group and stay. minMaskedPositions 0 lets a placeholder such as "N/A" through
// instead of failing the row.
algorithm('PT_CM_ALFANUM', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'AEIOU', 'BCDFGHJKLMNPQRSTVWXYZ', 'aeiou', 'bcdfghjklmnpqrstvwxyz', 'ÁÉÍÓÚ', 'áéíóú', 'ÂÊÔÃÕ', 'âêôãõ'],
  caseSensitive: true,
  minMaskedPositions: 0,
  preserveLeadingZeros: true,
}, 'A1234567')
// Digits only: dots, hyphens and slashes stay.
algorithm('PT_CM_DIGITOS', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789'],
  caseSensitive: true,
  minMaskedPositions: 0,
  preserveLeadingZeros: true,
}, '12345678')
// Digits and upper-case letters, one group each: a passport keeps its shape.
algorithm('PT_CM_DIGITOS_LETRAS', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
  preserveLeadingZeros: true,
}, 'CB123456')
// Hex letters form their own group, so a MAC, UUID or IPv6 stays valid hex.
algorithm('PT_CM_HEX', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'abcdef', 'ABCDEF', 'ghijklmnopqrstuvwxyz', 'GHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
  preserveLeadingZeros: true,
}, '3c:22:fb:9a:10:e4')
decompose('PT_REDIGIR', [['(.+)', { type: 'REDACT', redactCharacter: 'X' }]], keep, 'senha123')
lookup('PT_SUPRIMIR', 'pt-sem-informacao.txt', ['Sem informação'], 'Perturbação depressiva recorrente', 'PRESERVE_LOOKUP_FILE')

// Yes/no columns keep their vocabulary: a CHAR(1) S/N stays S/N.
decompose('PT_INDICADOR', [
  [String.raw`(?i)(sim|n[aã]o)`, apply(lookup('PT_INDICADOR_SIM_NAO', 'pt-indicador-sim-nao.txt', ['Sim', 'Não']))],
  ['(?i)(true|false)', apply(lookup('PT_INDICADOR_TRUE_FALSE', 'pt-indicador-true-false.txt', ['true', 'false']))],
  ['(?i)(yes|no)', apply(lookup('PT_INDICADOR_YES_NO', 'pt-indicador-yes-no.txt', ['Yes', 'No']))],
  ['(?i)([sn])', apply(lookup('PT_INDICADOR_S_N', 'pt-indicador-s-n.txt', ['S', 'N']))],
  ['(?i)([yx])', apply(lookup('PT_INDICADOR_Y_N', 'pt-indicador-y-n.txt', ['Y', 'N']))],
  ['([01])', apply(lookup('PT_INDICADOR_0_1', 'pt-indicador-0-1.txt', ['0', '1']))],
], keep, 'S')
const FLAG = String.raw`(?i)(sim|n[aã]o|true|false|yes|no|[snyx01])`
/**
 * A categorical attribute: flags stay flags, numeric codes are replaced by another code of `codes`
 * (or get other digits), and any other value is replaced by one from `values` — or suppressed, when
 * no list is given.
 */
function categorical(name, fileName, values, input, codes) {
  const replacement = values ? lookup(`${name}_LISTA`, fileName, values) : 'PT_SUPRIMIR'
  const code = codes ? apply(lookup(`${name}_CODIGO`, fileName.replace(/\.txt$/, '-codigos.txt'), codes)) : apply('PT_CM_ALFANUM')
  // A code that goes through a lookup is looked up without the zeros on the left, which stay.
  const pattern = codes ? [String.raw`(0*)([1-9]\d{0,5}|0)`, keep, code] : [String.raw`(\d{1,6})`, code]
  return decompose(name, [[FLAG, apply('PT_INDICADOR')], pattern], apply(replacement), input)
}
categorical('PT_CATEGORIA_SUPRIMIDA', null, null, 'Perturbação depressiva recorrente')
const CM = apply('PT_CM_ALFANUM')
const DIGITS = apply('PT_CM_DIGITOS')
const FIXED_DIGITS = apply(fixedWidth('PT_CM_DIGITOS'))

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


// ── Check characters ────────────────────────────────────────────────────────
//
// Two Portuguese rules fit the plugin's Check Digit as it is. The civil identification number and
// the NIF are eight digits and a ninth weighted 9 down to 2, modulo 11, eleven minus the remainder —
// and Portugal writes both 10 and 11 as 0, which is what Check Digit writes too. The NISS is ten
// digits and an eleventh, nine minus the weighted sum (29 23 19 17 13 11 7 5 3 2) modulo 10: Check
// Digit writes ten minus the remainder, and since only natural persons are masked — their NISS
// starts with 1 — giving that leading 1 the weight 0 instead of 29 adds exactly the one that turns
// one rule into the other.
//
// The other three are no weighted sum Check Digit can write. The document number of the Cartão de
// Cidadão ends in a Luhn digit computed over digits and letters (A = 10 … Z = 35); the número de
// utente of the SNS in an ISO/IEC 7064 MOD 11,10 digit; the prescription number in an ISO/IEC 7064
// MOD 11-2 character, X for ten; and the NIB in two digits modulo 97. The set computes them the way
// the Spain set computes its control letters: a **state** — what the rule has accumulated so far —
// is put in front of the value and travels right one character at a time. Each step is a Regex
// Decompose that hands "state + next character" to a Data Cleansing whose table answers "next
// character + new state". A step that finds no line for its window — because the state has already
// reached the end, or because the value is shorter — leaves it as it is, so one chain serves every
// written form, separators included. At the end a last table turns the state into the check
// characters.

function checkDigit(name, weights, modulus, body, input) {
  return algorithm(name, 'checkdigit.Checkdigit', {
    // Check Digit applies the weights from the right.
    weightList: [...weights].reverse(), modulusNumber: modulus,
    checkDigitIndex: weights.length, numDigitsForCheckdigitCalculation: weights.length,
    calculateChecksumRightToLeft: true,
    numericAlgorithm: use(body), alphaNumericAlgorithm: use(body),
    preserveRegex: String.raw`[.\-\s]`,
    inputHandlingConfig: { characterHandling: 'STANDARD', invalidInputHandling: 'ERROR', shortInputHandling: 'FALLBACK', padCharacter: '0', trimWhitespace: true },
  }, input)
}

/** Rightward steps from explicit rows: `state + character → character + state'`. */
function stateRows(name, fileName, states, width, alphabet, next, input) {
  const pairs = []
  for (const s of states) {
    for (const c of alphabet) {
      const t = next(s, c)
      if (t !== undefined) pairs.push([`${typeof s === 'number' ? pad(s, width) : s}${c}`, `${c}${typeof t === 'number' ? pad(t, width) : t}`])
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
const SEPARATORS = [SPACE, '-', '.']
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

// The rules, in JavaScript, for the build's own checks.
const NIC_WEIGHTS = [9, 8, 7, 6, 5, 4, 3, 2]
const mod11Digit = (eight) => String((11 - ([...eight].reduce((t, c, i) => t + Number(c) * NIC_WEIGHTS[i], 0) % 11)) % 11 % 10)
const NISS_WEIGHTS = [29, 23, 19, 17, 13, 11, 7, 5, 3, 2]
const nissDigit = (ten) => String(9 - ([...ten].reduce((t, c, i) => t + Number(c) * NISS_WEIGHTS[i], 0) % 10))
const ALPHABET_36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const luhn36 = (payload) => {
  const s = [...payload.toUpperCase()].reverse().reduce((t, c, i) => {
    const v = ALPHABET_36.indexOf(c)
    return t + (i % 2 === 0 ? (2 * v > 9 ? 2 * v - 9 : 2 * v) : v)
  }, 0)
  return String((10 - (s % 10)) % 10)
}
const mod1110 = (digits) => {
  let p = 10
  for (const d of digits) { const s = (p + Number(d)) % 10 || 10; p = (2 * s) % 11 }
  return String((11 - p) % 10)
}
const mod112 = (digits) => {
  let p = 0
  for (const d of digits) p = ((p + Number(d)) * 2) % 11
  const c = (12 - p) % 11
  return c === 10 ? 'X' : String(c)
}
const nibCheck = (nineteen) => pad(98 - Number((BigInt(nineteen) * 100n) % 97n), 2)
// Published examples: the número de utente 629033874 of the Universidade dos Açores article, the
// ORCID iD 0000-0002-1825-0097 for MOD 11-2, the document numbers of python-stdnum.
if (mod1110('62903387') !== '4' || mod112('000000021825009') !== '7' || luhn36('000000000ZZ') !== '4') throw new Error('a check rule disagrees with its published example')


// ── L1 · The Cartão de Cidadão: civil identification number and document number ──
//
// The Cartão de Cidadão (Lei n.º 7/2007) carries four numbers of four separate registers — the
// número de identificação civil, the NIF, the número de utente of the SNS and the NISS — and its
// article 16.º, n.º 2 forbids interconnecting those registers without a law or the CNPD; article
// 35.º, n.º 5 of the Constitution forbids a single national number. Each number is masked on its
// own, by its own mapping, and none is derived from another.
//
// The **número de identificação civil** — the old number of the bilhete de identidade — is eight
// digits and a check digit (Lei n.º 12/91), and the **document number** of the card is that, two
// characters of the card's version and a last check digit (art. 17.º): `12345678 9 ZZ4`. The eight
// digits change; the first check digit is recomputed by Check Digit; the version stays; the last
// digit, a Luhn digit computed over digits and letters, is recomputed by a state that crosses the
// eleven characters before it, doubling every other one. The state is the sum so far and whether the
// next character doubles; separators carry it untouched.
algorithm('PT_NIC_CORPO', 'characterMapping.CharacterMapping', algorithms.find((a) => a.name === fixedWidth('PT_CM_DIGITOS')).config, '12345678')
checkDigit('PT_NIC', NIC_WEIGHTS, 11, 'PT_NIC_CORPO', '123456789')

const contribution = (v, double) => (double ? (2 * v > 9 ? 2 * v - 9 : 2 * v) : v)
const CC_STATES = range(0, 9).flatMap((s) => [`${s}2`, `${s}1`])
const CC_STEP = stateRows('PT_CC_PASSO', 'pt-cc-passo.txt', CC_STATES, 2, [...ALPHABET_36, ...'abcdefghijklmnopqrstuvwxyz', ...SEPARATORS], (state, c) => {
  const [s, double] = [Number(state[0]), state[1] === '2']
  if (SEPARATORS.includes(c)) return state
  const v = ALPHABET_36.indexOf(c.toUpperCase())
  return `${(s + contribution(v, double)) % 10}${double ? '1' : '2'}`
}, '02Z')
const CC_FINAL = cleansing('PT_CC_CONTROLO_TABELA', 'pt-cc-controlo.txt', CC_STATES.map((state) => [`${state}~`, String((10 - Number(state[0])) % 10)]), '61~')
const CC_EXAMPLE = `12345678 ${mod11Digit('12345678')} ZZ${luhn36(`12345678${mod11Digit('12345678')}ZZ`)}`
const CC_BACK = pipeline('PT_CC', CC_EXAMPLE, [
  // The civil number and its check digit; the version and the last digit wait.
  [(input) => decompose('PT_CC_NIC', [[String.raw`(\d{8}[\s\-]?\d)(.*)`, apply('PT_NIC'), keep]], keep, input), (v) => v],
  [(input) => spaces('PT_CC_MARCAR', ' ', SPACE, input), markSpaces],
  // A state of 0, doubling, goes in front of the first digit, and the old last digit becomes `~`.
  [(input) => decompose('PT_CC_PREPARAR', DIGIT_CHARS.map((d) => [`(${d})(.*)([0-9])`, redactAs(`02${d}`), keep, redactAs('~')]), keep, input),
    (v) => `02${v.slice(0, -1)}~`],
  ...Array.from({ length: 14 }, (_, k) => stepAt(`PT_CC_PASSO_${pad(k, 2)}`, k, 2, CC_STEP)),
  [(input) => decompose('PT_CC_CONTROLO', [[String.raw`(.*)(\d[12]~)`, keep, apply(CC_FINAL)]], keep, input),
    (v) => v.replace(/(\d)([12])~$/, (_, s) => String((10 - Number(s)) % 10))],
  [(input) => spaces('PT_CC_RESTAURAR', SPACE, ' ', input), restoreSpaces],
])
// With the masking taken as the identity, every chain must hand a valid example back unchanged.
if (CC_BACK !== CC_EXAMPLE) throw new Error(`Cartão de Cidadão: the chain gives ${CC_BACK} for ${CC_EXAMPLE}`)

// An identification column holds the full document number, the civil number with or without its
// check digit, an old bilhete de identidade of seven digits, a passport: each value goes by its shape.
decompose('PT_IDENTIFICACAO', [
  [String.raw`(\d{8}[\s\-]?\d[\s\-]?[A-Za-z0-9]{2}\d)`, apply('PT_CC')],
  [String.raw`(\d{8}[\s\-]?\d)`, apply('PT_NIC')],
  // Eight digits are the civil number without its check digit: masked as it is inside the others.
  [String.raw`(\d{8})`, apply('PT_NIC_CORPO')],
  [String.raw`(\d{5,7})`, DIGITS],
  [String.raw`([A-Za-z]{1,2}\d{6})`, apply('PT_CM_DIGITOS_LETRAS')],
], CM, CC_EXAMPLE)

const OWNER = 'cliente|cli|utente|doente|paciente|utilizador|segurado|beneficiario|benef|titular|funcionario|trabalhador|colaborador|empregado|aluno|estudante|devedor|fiador|avalista|requerente|proprietario|arrendatario|inquilino|condutor|tomador|responsavel|representante|procurador|pessoa|cidadao|eleitor|contribuinte|fornecedor|socio|conjuge|pai|mae|filho|familiar|pensionista|reformado|interessado|declarante|herdeiro'
domain('PT_L1_CARTAO_CIDADAO', 'PT_IDENTIFICACAO',
  byName(
    // Not the *kind* of document.
    [`cc|c_c|cart[aã]o_?(de_?)?cidad[aã]o|n(o|r|ro|um|umero)_?(cc|cart[aã]o_?cidad[aã]o|documento_?identifica[cç][aã]o|doc_?id|bi|identifica[cç][aã]o_?civil|id_?civil)|bi|b_i|bilhete_?(de_?)?identidade|nic|n_i_c|identifica[cç][aã]o_?civil|doc_?identifica[cç][aã]o|documento_?(de_?)?identifica[cç][aã]o|num_?doc|n_?doc|(?<!(tipo|tp|cod|codigo|desc)_)identifica[cç][aã]o(?!_?(tipo|fiscal|seguran[cç]a))|(${OWNER})_?(cc|bi|nic|doc|documento)|(cc|bi)_?(${OWNER})|national_?id|id_?number|id_?card`, 0.9],
    ['documento|doc|identificador', 0.6],
  ),
  byType(STRING(7), NUMBER(7)),
  byPattern([
    [String.raw`\d{8}\s?\d\s?[A-Z0-9]{2}\d`, 0.95, { note: 'Cartão de Cidadão' }],
    // The civil number with its check digit, written apart: a bare nine-digit value is left to the NIF.
    [String.raw`\d{8}[\s\-]\d`, 0.6],
    [String.raw`\d{8}`, 0.4],
  ], { reject: 0.3 }))

// ── L1 · NIF ────────────────────────────────────────────────────────────────
//
// The Autoridade Tributária numbers every taxpayer with nine digits; the first says what it is.
// 1, 2 and 3 are natural persons, 45 a non-resident natural person, and 8 the old empresário em nome
// individual — a natural person too. 5 is a company, 6 the public administration, 7 inheritances,
// funds and other entities, 9 irregular companies and condominiums: none of them anyone's personal
// data (art. 4.º 1 and recital 14 of the RGPD), so they pass untouched. A natural person's NIF keeps
// its first digit — still a natural person's —, the other seven change and the check digit is
// recomputed. The NIF is not the civil number: they share the rule, not the value.
decompose('PT_NIF_CORPO', [
  [String.raw`(45)(\d{6})`, keep, FIXED_DIGITS],
  [String.raw`([1-38])(\d{7})`, keep, FIXED_DIGITS],
], keep, '12345678')
checkDigit('PT_NIF_CD', NIC_WEIGHTS, 11, 'PT_NIF_CORPO', '123456789')
const PERSON_NIF = String.raw`(?:[1-38]\d{2}|45\d)[\s\-.]?\d{3}[\s\-.]?\d{3}`
const COMPANY_NIF = String.raw`(?:[5-79]|4[0-46-9])\d{2}[\s\-.]?\d{3}[\s\-.]?\d{3}`
decompose('PT_NIF', [
  [`(PT\\s?)(${PERSON_NIF})`, keep, apply('PT_NIF_CD')],
  [`(${PERSON_NIF})`, apply('PT_NIF_CD')],
  [`(PT\\s?)(${COMPANY_NIF})`, keep, keep],
  [`(${COMPANY_NIF})`, keep],
], CM, '123456789')
domain('PT_L1_NIF', 'PT_NIF',
  byName(
    [`nif(?!_?(empresa|entidade|sociedade|fornecedor|pagador|emitente|fiscal_?empresa|coletiv[oa]))|n_i_f|nifp?s|n(o|r|ro|um|umero)_?(de_?)?(contribuinte|identifica[cç][aã]o_?fiscal|nif|fiscal)|contribuinte|num_?contrib|n_?contrib|identifica[cç][aã]o_?fiscal|(${OWNER})_?nif|nif_?(${OWNER})|vat_?(no|number|id)?|tax_?id|tin`, 0.9],
    ['fiscal|ident_?fiscal', 0.5],
  ),
  byType(STRING(9), NUMBER(9)),
  byPattern([
    // Nine digits starting as a natural person's NIF: also any nine-digit code, a landline, a civil
    // number with its check digit, so the shape only backs up a name.
    [String.raw`(PT\s?)?(?:[123]\d{2}|45\d)[\s\-.]?\d{3}[\s\-.]?\d{3}`, 0.5, { note: 'NIF' }],
  ], { reject: 0.3 }))

// ── L1 · NISS ───────────────────────────────────────────────────────────────
//
// The Segurança Social numbers every beneficiary and contributor with eleven digits: 1 for a natural
// person, 2 for a legal person, nine more and a check digit. A person's NISS keeps its 1, the nine
// digits change and the check digit is recomputed; a legal person's passes untouched.
decompose('PT_NISS_CORPO', [[String.raw`(1)(\d{9})`, keep, FIXED_DIGITS]], keep, '1123456789')
checkDigit('PT_NISS_CD', [0, ...NISS_WEIGHTS.slice(1)], 10, 'PT_NISS_CORPO', `1123456789${nissDigit('1123456789')}`)
decompose('PT_NISS', [
  [String.raw`(1(?:[\s\-.]?\d){10})`, apply('PT_NISS_CD')],
  [String.raw`(2(?:[\s\-.]?\d){10})`, keep],
], CM, `1123456789${nissDigit('1123456789')}`)
domain('PT_L1_NISS', 'PT_NISS',
  byName(['niss|n_i_s_s|n(o|r|ro|um|umero)_?(de_?)?(identifica[cç][aã]o_?)?(da_?|na_?)?seguran[cç]a_?social|n(o|r|ro|um|umero)_?(ss|benefici[aá]rio_?ss)|seguran[cç]a_?social|num_?ss|nss|n_?ss|social_?security(_?number)?|ssn', 0.9]),
  byType(STRING(11), NUMBER(11)),
  byPattern([[String.raw`1\d{10}`, 0.6, { note: 'NISS' }]], { reject: 0.3 }))

// ── L1 · Other documents ────────────────────────────────────────────────────

// The Portuguese electronic passport: one or two letters and six digits.
domain('PT_L1_PASSAPORTE', 'PT_CM_DIGITOS_LETRAS',
  byName(['passaporte[a-z0-9_]*|n(o|r|ro|um|umero)_?passaporte|passport[a-z0-9_]*', 0.9]),
  // A letter and six digits are also any internal code, so the values only back up a column name.
  byPattern([[String.raw`[A-Z]{1,2}\d{6}`, 0.4]], { reject: 0.3 }))

// The residence documents of the Agência para a Integração, Migrações e Asilo (AIMA, the former SEF)
// and the registration certificate of a citizen of the Union: no public format, masked character by
// character.
domain('PT_L1_TITULO_RESIDENCIA', 'PT_CM_ALFANUM',
  byName(['t[ií]tulo_?(de_?)?resid[eê]ncia|autoriza[cç][aã]o_?(de_?)?resid[eê]ncia|cart[aã]o_?(de_?)?resid[eê]ncia|n(o|r|ro|um|umero)_?(t[ií]tulo|autoriza[cç][aã]o|cart[aã]o)_?(de_?)?resid[eê]ncia|ar_?cplp|certificado_?(de_?)?registo_?(de_?)?cidad[aã]o_?(da_?)?ue|n(o|r|ro|um|umero)_?(sef|aima)|residence_?permit', 0.9]))

// The driving licence of the IMT: its number has no public rule, and is masked character by character.
domain('PT_L1_CARTA_CONDUCAO', 'PT_CM_DIGITOS_LETRAS',
  byName(['carta_?(de_?)?condu[cç][aã]o|n(o|r|ro|um|umero)_?carta(_?(de_?)?condu[cç][aã]o)?|licen[cç]a_?(de_?)?condu[cç][aã]o|driv(er|ing)_?licen[cs]e', 0.9]))

domain('PT_L1_NUMERO_ESTUDANTE', 'PT_CM_ALFANUM',
  byName(['n(o|r|ro|um|umero)_?(de_?)?(aluno|estudante|matr[ií]cula_?(aluno|estudante)|processo_?(do_?)?aluno|mecanogr[aá]fico)|c[oó]digo_?(de_?)?(aluno|estudante)|cod_?(aluno|estudante)|id_?(aluno|estudante)|processo_?(do_?)?aluno|student_?(id|number)', 0.8]))

// The number of a professional order — the Ordem dos Médicos, dos Enfermeiros, dos Advogados — or the
// professional card of a contabilista certificado.
domain('PT_L1_CEDULA_PROFISSIONAL', 'PT_CM_ALFANUM',
  byName(['c[eé]dula_?profissional|n(o|r|ro|um|umero)_?(de_?)?(c[eé]dula|inscri[cç][aã]o_?(na_?)?ordem|ordem|ordem_?(dos_?)?(m[eé]dicos|enfermeiros|advogados|engenheiros|farmac[eê]uticos|psic[oó]logos))|n(o|r|ro|um|umero)_?(om|oe|oa|occ)|c[oó]digo_?(m[eé]dico|profissional)', 0.85]))


// ── L1 · Names ──────────────────────────────────────────────────────────────

const NOT_A_PERSON = 'produto|prod|item|artigo|empresa|emp|firma|razao|social|comercial|ficheiro|arquivo|rua|via|avenida|estrada|bairro|concelho|municipio|freguesia|localidade|distrito|regiao|pais|banco|entidade|balcao|agencia|plano|campanha|projeto|servico|tabela|coluna|campo|host|servidor|dominio|marca|modelo|categoria|tipo|centro|escola|instituto|universidade|curso|disciplina|documento|doc|unidade|clinica|hospital|seguro|area|departamento|cargo|sistema|app|aplicacao|grupo|lista|relatorio|processo|evento|tarefa|perfil|papel|classe|objeto|conta|medicamento|diagnostico|estudo|programa|prestacao|partido|sindicato|religiao|lingua|idioma|lugar|sede|loja|armazem|fornecedor|contrato|apolice|seguradora|organismo|organizacao|parametro|variavel|metodo|funcao|indice|job|script|fila|recurso|rede|dispositivo|modelo|imagem|foto|pagina|sitio|modulo|menu|opcao|acao|permissao|conceito|imposto|moeda|emissor|fatura|pagamento|forma|zona|linha|atividade|setor|predio|edificio|file|table|column|field|user|server|product|company|category|type|school|document|department|system|group|report|role|account|place|store|supplier|contract|device|image|page|module|action|key|label|code|project|city|country|street|bank'
const PERSON_ROLE = 'cliente|cli|utente|doente|paciente|utilizador|segurado|beneficiario|benef|titular|funcionario|trabalhador|colaborador|empregado|aluno|estudante|devedor|fiador|avalista|requerente|proprietario|arrendatario|inquilino|condutor|tomador|responsavel|representante|procurador|pessoa|cidadao|contribuinte|mae|pai|conjuge|contacto|referencia|vitima|denunciante|arguido|testemunha|medico|docente|socio|herdeiro|dador|tutor|pensionista|reformado|interessado|customer|patient|employee|member|holder|mother|father|spouse|contact|person|student|driver|owner'
const PARTICLES = String.raw`(?i)(de|da|do|das|dos|e|d')`

algorithm('PT_NOME', 'name.Name', {
  lookupFile: { uri: file('pt-nomes.txt', GIVEN_NAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Inês')
algorithm('PT_APELIDO', 'name.Name', {
  lookupFile: { uri: file('pt-apelidos.txt', SURNAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Gonçalves')
// A word of a name. "de", "da", "dos", "e" stay where they are: "Maria da Conceição", "Ferreira
// dos Santos", "Sousa e Silva".
decompose('PT_PALAVRA_NOME', [[PARTICLES, keep]], apply('PT_NOME'), 'Conceição')
decompose('PT_PALAVRA_APELIDO', [[PARTICLES, keep]], apply('PT_APELIDO'), 'Magalhães')
const N = apply('PT_PALAVRA_NOME')
const S = apply('PT_PALAVRA_APELIDO')

decompose('PT_NOMES', [
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, N],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, N, N],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, N, N],
], CM, 'Maria da Conceição')
decompose('PT_APELIDOS', [
  [String.raw`(\S+)`, S],
  [String.raw`(\S+)\s+(\S+)`, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, S, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, S, S, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, S, S, S, S, S],
], CM, 'Ferreira dos Santos')
// Portuguese order: one or two given names, then the surnames — the mother's first and the father's
// last, by custom, up to four in all (Código do Registo Civil, art. 103.º). Maria followed by a
// particle is a compound given name; otherwise two words are a given name and a surname; three, a given name and two surnames; four, two and two; more, two given names
// and the rest surnames. The particles stay where they are.
decompose('PT_NOME_COMPLETO', [
  [String.raw`([^,]+),\s*(.+)`, apply('PT_APELIDOS'), apply('PT_NOMES')],
  // Maria da Conceição, Maria de Fátima, Maria do Carmo, Maria dos Anjos: one given name of three words.
  [String.raw`(?iu)(maria)\s+(d[aeo]s?)\s+(\S+)\s+(.+)`, N, keep, N, apply('PT_APELIDOS')],
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, S, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, S, S, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, S, S, S, S, S],
], CM, 'Maria da Conceição Ferreira dos Santos')
const NAME_WORDS = ['de', 'da', 'do', 'das', 'dos', 'e']

domain('PT_L1_NOME', 'PT_NOMES',
  byName(
    ['primeiro_?nome|segundo_?nome|nomes?_?pr[oó]prios?|nome_?1|nome_?2|first_?names?|given_?names?|fname|middle_?names?|nomes(?!_?(completos?|apelidos?))', 0.85],
    [`nome(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|apelidos?|utilizador|curto|abreviado))|name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))`, 0.5],
  ),
  byList([['pt-detetar-nomes.txt', [...GIVEN_NAMES, ...NAME_WORDS], 0.7]], { tokenize: true, reject: 0.3 }))

domain('PT_L1_APELIDO', 'PT_APELIDOS',
  byName(['apelidos?|sobrenomes?|[uú]ltimo_?nome|apelido_?(1|2|materno|paterno)|nome_?(de_?)?fam[ií]lia|last_?names?|surnames?|family_?names?|lname', 0.85]),
  byList([['pt-detetar-apelidos.txt', [...SURNAMES, ...NAME_WORDS], 0.7]], { tokenize: true, reject: 0.3 }))

domain('PT_L1_NOME_COMPLETO', 'PT_NOME_COMPLETO',
  byName(
    [`nomes?_?(completos?|e_?apelidos?|apelidos?)|apelidos?_?(e_?)?nomes?|nome_?(do_?|da_?)?(${PERSON_ROLE})|(${PERSON_ROLE})_?nome|nome_?(m[aã]e|pai|tutor|c[oô]njuge|contacto_?(de_?)?emerg[eê]ncia|refer[eê]ncia)|full_?name|person_?name`, 0.9],
    ['filia[cç][aã]o_?(materna|paterna)|m[aã]e|pai|tutor|tutora|c[oô]njuge|representante_?legal|procurador|fiador|avalista|benefici[aá]rio|herdeiro|titular|tomador|refer[eê]ncia_?(pessoal|familiar)', 0.6],
    [`nome(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|apelidos?|utilizador|curto|abreviado))|name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))`, 0.5],
  ),
  byList([['pt-detetar-nomes.txt', [...GIVEN_NAMES, ...NAME_WORDS], 0.65], ['pt-detetar-apelidos.txt', [...SURNAMES, ...NAME_WORDS], 0.65]], { tokenize: true, reject: 0.3 }))

// ── L1 · Contact ────────────────────────────────────────────────────────────

decompose('PT_EMAIL', [
  // The top-level domain becomes .test, reserved for tests: a masked address can never deliver.
  [String.raw`([^@\s]+)@([^@\s]+)\.([A-Za-z]{2,24}(?:\.[A-Za-z]{2})?)`, CM, CM, redactAs('test')],
], CM, 'ines.goncalves@gmail.com')
domain('PT_L1_EMAIL', 'PT_EMAIL',
  byName(['e_?mail[a-z0-9_]*|mail[a-z0-9_]*|correio(_?eletr[oó]nico)?[a-z0-9_]*|endere[cç]o_?(de_?)?(e_?mail|correio_?eletr[oó]nico)', 0.85]),
  byType(STRING(5)),
  byPattern([[String.raw`[\p{L}\p{N}._%+'\-]+@[\p{L}\p{N}.\-]+\.[A-Za-z]{2,24}`, 1]], { reject: 0.2 }))

// Every Portuguese number has nine digits: 91, 92, 93 and 96 for a mobile, 2 and the area for a
// landline, 30 for a nomadic one. The country code and the first two digits stay — the operator or
// the area, no finer than a district —, so a masked number still says mobile or landline; and MB WAY
// makes a mobile number a payment address as well.
decompose('PT_TELEFONE', [
  [String.raw`((?:\+|00)351[\s\-]?)(9[1236]|2\d|30)([\d\s\-]{7,10})`, keep, keep, DIGITS],
  [String.raw`(\(?(?:\+|00)351\)?[\s\-]?)(9[1236]|2\d|30)([\d\s\-]{7,10})`, keep, keep, DIGITS],
  [String.raw`(9[1236]|2\d|30)([\d\s\-]{7,10})`, keep, DIGITS],
], DIGITS, '+351 912 345 678')
domain('PT_L1_TELEFONE', 'PT_TELEFONE',
  byName(['tel|tlf|tlm|telef|telefone[a-z0-9_]*|tel_?(fixo|casa|resid[eê]ncia|escrit[oó]rio|trabalho|contacto|m[oó]vel)|telem[oó]vel|tlmv|m[oó]vel|movel[a-z0-9_]*|n(o|r|ro|um|umero)_?(tel|telefone|telem[oó]vel|contacto)|contacto_?telef[oó]nico|whats_?app|mb_?way|fax|phone[a-z0-9_]*|mobile[a-z0-9_]*', 0.85]),
  byPattern([
    [String.raw`((\+|00)351[\s\-]?)?9[1236]\d[\s\-]?\d{3}[\s\-]?\d{3}`, 0.8],
    // A landline is nine digits starting with 2, as most NIFs now are: the shape alone is weak.
    [String.raw`(\+|00)351[\s\-]?2\d{2}[\s\-]?\d{3}[\s\-]?\d{3}`, 0.8],
    [String.raw`2\d[\s\-]\d{3}[\s\-]?\d{4}|2\d{2}[\s\-]\d{3}[\s\-]\d{3}`, 0.6],
  ], { reject: 0.3 }))

// A Portuguese address is a type of street, a name, a number and the floor and side: "Rua da
// Liberdade, 12, 3.º Esq.". The whole line becomes a fictitious one.
const STREET_TYPES = [['Rua', 0.5], ['Avenida', 0.13], ['Av.', 0.04], ['Travessa', 0.06], ['Largo', 0.05], ['Praça', 0.04], ['Estrada', 0.04], ['Calçada', 0.03], ['Alameda', 0.02], ['Beco', 0.02], ['Rotunda', 0.01], ['Praceta', 0.03], ['Urbanização', 0.03]]
const STREETS = ['da Liberdade', '25 de Abril', '5 de Outubro', '1.º de Maio', 'Luís de Camões', 'do Comércio', 'da Igreja', 'Dr. Manuel de Arriaga', 'Almirante Reis', 'Infante D. Henrique', 'D. João II', 'Gago Coutinho', 'da República', 'das Flores', 'do Sol', 'da Escola', 'Sá da Bandeira', 'Marquês de Pombal', 'Eça de Queirós', 'Alexandre Herculano', 'Almeida Garrett', 'Miguel Bombarda', 'Bocage', 'Florbela Espanca', 'Sophia de Mello Breyner', 'Aristides de Sousa Mendes', 'Humberto Delgado', 'Vasco da Gama', 'Pedro Álvares Cabral', 'dos Combatentes', 'da Fonte', 'do Moinho', 'da Estação', 'Nova', 'Direita', 'do Castelo', 'dos Pescadores', 'de Santo António', 'de São João', 'Padre António Vieira', 'Fernando Pessoa', 'Amália Rodrigues', 'José Saramago', 'do Mercado', 'da Boavista', 'das Oliveiras', 'do Pinhal', 'da Quinta', 'Dom Dinis', 'Afonso Henriques']
lookup('PT_MORADA', 'pt-moradas.txt', (() => {
  const random = seeded(582019)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const num = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
  const type = () => {
    let r = random()
    for (const [t, p] of STREET_TYPES) { if ((r -= p) < 0) return t }
    return 'Rua'
  }
  const floor = () => pick([`${num(1, 9)}.º Esq.`, `${num(1, 9)}.º Dto.`, `${num(1, 9)}.º Frente`, 'R/C Esq.', 'R/C Dto.', 'Cave', `${num(1, 6)}.º ${pick(['A', 'B', 'C'])}`, ''])
  const out = new Set()
  while (out.size < 4000) {
    const t = type()
    const n = num(1, 250)
    const f = floor()
    const street = t === 'Urbanização' ? `Urbanização ${pick(['da Quinta', 'do Pinhal', 'das Flores', 'da Boavista', 'do Sol'])}, Lote ${num(1, 60)}` : `${t} ${pick(STREETS)}`
    out.add(f ? `${street}, ${n}, ${f}` : `${street}, ${n}`)
  }
  return [...out]
})(), 'Rua da Liberdade, 12, 3.º Esq.', 'PRESERVE_LOOKUP_FILE')
domain('PT_L1_MORADA', 'PT_MORADA',
  byName(['morada[a-z0-9_]*|(?<!(mac|ip|e_?mail|web|url|correio)_?)endere[cç]o(?!_?(ip|mac|email|e_?mail|eletr[oó]nico|web|url|tipo|id))[a-z0-9_]*|domic[ií]lio(?!_?fiscal_?empresa)[a-z0-9_]*|(?<!(situa[cç][aã]o|tipo|t[ií]tulo|autoriza[cç][aã]o|cart[aã]o|estatuto|pa[ií]s|concelho|freguesia|distrito)_?)resid[eê]ncia(_?habitual)?(?!_?(fiscal|permit|status|permanente|tempor[aá]ria|cplp))|local_?(de_?)?resid[eê]ncia|arruamento|nome_?(da_?)?(rua|art[eé]ria)|art[eé]ria|rua|(?<!(mac|ip|e_?mail|web|url)_?)address(?!_?(ip|mac|email|e_?mail|web|url|type|id))[a-z0-9_]*', 0.8]),
  byType(STRING(6)),
  byPattern([
    [String.raw`(?iu)(rua|r\.|avenida|av\.?|travessa|tv\.?|largo|lg\.?|pra[çc]a|p[çc]\.?|estrada|est\.?|cal[çc]ada|alameda|beco|rotunda|praceta|urbaniza[çc][ãa]o|urb\.?|bairro|lugar|quinta|caminho)\s+.{2,60}\d.*`, 0.85],
    [String.raw`(?iu).*\b\d{1,4}\s*,?\s*(\d{1,2}\s*\.?\s*º\s*(esq|dto|dt|frente|fte)|r/?c|r[ée]s[\s\-]do[\s\-]ch[ãa]o|cave)\b.*`, 0.7],
  ], { reject: 0.2 }))

domain('PT_L1_MORADA_COMPLEMENTO', 'PT_CM_ALFANUM',
  byName(['andar|piso|porta|lado|fra[cç][aã]o|lote|bloco|entrada|n(o|r|ro|um|umero)_?(de_?)?(porta|pol[ií]cia|rua|casa|lote)|num_?porta|complemento_?(da_?)?(morada|endere[cç]o)|complemento(?![a-z_]*(depend|solid|salar|pens|reforma|abono|remunera))|resto_?(da_?)?morada|apartado|p_?o_?box', 0.7]))


// ── L1 · Bank accounts: the IBAN, the NIB and their check digits ────────────
//
// A Portuguese account is a NIB of twenty-one digits — four for the bank, four for the branch, eleven
// for the account and two check digits, 98 minus the first nineteen times 100 modulo 97 — and the
// IBAN puts PT50 in front. The NIB check makes the whole NIB one more than a multiple of 97, which
// makes every Portuguese IBAN's own digits 50: recompute the NIB check and the IBAN is valid again.
// The plugin's IBAN algorithm recomputes the ISO digits instead, and would leave the NIB check wrong.
//
// So the eleven digits of the account change, bank and branch stay, and a state — the number so far
// modulo 97 — crosses the nineteen digits and becomes the two check digits. In an IBAN printed in
// groups of four a space falls between them, which the last table writes back in place.
const NIB_STEP = stateRows('PT_NIB_PASSO', 'pt-nib-passo.txt', range(0, 96), 2, [...DIGIT_CHARS, ...SEPARATORS], (s, c) => (/\d/.test(c) ? (s * 10 + Number(c)) % 97 : s), '000')
const nibFrom = (s) => pad(98 - ((s * 100) % 97), 2)
const NIB_FINAL = cleansing('PT_NIB_CONTROLO_TABELA', 'pt-nib-controlo.txt',
  range(0, 96).flatMap((s) => [[`${pad(s, 2)}~^`, nibFrom(s)], [`${pad(s, 2)}~${SPACE}^`, `${nibFrom(s)[0]}${SPACE}${nibFrom(s)[1]}`]]), '45~^')
const NIB_EXAMPLE = `0002012312345678901${nibCheck('0002012312345678901')}`
const groupsOfFour = (v) => v.replace(/(.{4})/g, '$1 ').trim()
function nibChain(name, example) {
  return pipeline(name, example, [
    [(input) => decompose(`${name}_CONTA`, [
      [String.raw`(\d{8})(\d{11})(\d{2})`, keep, FIXED_DIGITS, keep],
      [String.raw`(\d{4} \d{4} )(\d{4} \d{4} \d{3})(\d \d)`, keep, FIXED_DIGITS, keep],
      [String.raw`(\d{4}[\s.\-]\d{4}[\s.\-])(\d{11})([\s.\-]\d{2})`, keep, FIXED_DIGITS, keep],
    ], keep, input), (v) => v],
    [(input) => spaces(`${name}_MARCAR`, ' ', SPACE, input), markSpaces],
    // A state of 00 goes in front of the first digit; the old check digits become `~` and `^`.
    [(input) => decompose(`${name}_PREPARAR`, DIGIT_CHARS.map((d) => [`(${d})(.*)(\\d)(${SPACE}?)(\\d)`, redactAs(`00${d}`), keep, redactAs('~'), keep, redactAs('^')]), keep, input),
      (v) => v.replace(/^(\d)(.*)(\d)(_?)(\d)$/, (_, d, mid, a, sep) => `00${d}${mid}~${sep}^`)],
    ...Array.from({ length: 24 }, (_, k) => stepAt(`${name}_PASSO_${pad(k, 2)}`, k, 2, NIB_STEP)),
    [(input) => decompose(`${name}_CONTROLO`, [[`(.*)(\\d{2}~${SPACE}?\\^)`, keep, apply(NIB_FINAL)]], keep, input),
      (v) => v.replace(/(\d{2})~(_?)\^$/, (_, s, sep) => (sep ? `${nibFrom(Number(s))[0]}${sep}${nibFrom(Number(s))[1]}` : nibFrom(Number(s))))],
    [(input) => spaces(`${name}_RESTAURAR`, SPACE, ' ', input), restoreSpaces],
  ])
}
const NIB_BACK = nibChain('PT_NIB', NIB_EXAMPLE)
if (NIB_BACK !== NIB_EXAMPLE) throw new Error(`NIB: the chain gives ${NIB_BACK}`)
// Printed in groups, the NIB of an IBAN: the same chain, its body pattern for the groups.
const NIB_PRINTED = groupsOfFour(NIB_EXAMPLE)
if (nibChain('PT_NIB_IMPRESSO', NIB_PRINTED) !== NIB_PRINTED) throw new Error('NIB in groups: the chain does not give the check digits back')
// An IBAN of another country, in a Portuguese bank's column: the plugin's IBAN algorithm masks its
// last digits and recomputes the ISO ones.
algorithm('PT_IBAN_ESTRANGEIRO', 'iban.IBAN', { validateInput: false, numCharsToMask: 8 }, 'ES9121000418450200051332')
decompose('PT_CONTA', [
  [String.raw`(PT50)(\d{21})`, keep, apply('PT_NIB')],
  [String.raw`(PT50 )(\d{4} \d{4} \d{4} \d{4} \d{4} \d)`, keep, apply('PT_NIB_IMPRESSO')],
  [String.raw`(\d{4}[\s.\-]?\d{4}[\s.\-]?\d{11}[\s.\-]?\d{2})`, apply('PT_NIB')],
  [String.raw`((?!PT)[A-Z]{2}\d{2}[A-Z0-9]{10,30})`, apply('PT_IBAN_ESTRANGEIRO')],
], DIGITS, `PT50${NIB_EXAMPLE}`)
domain('PT_L1_CONTA_BANCARIA', 'PT_CONTA',
  byName(['conta_?(banc[aá]ria|banco|corrente|ordem|poupan[cç]a|cliente|ordenado|d[eé]bito|cr[eé]dito|iban|nib)|n(o|r|ro|um|umero)_?(de_?)?(conta|cta)|num_?conta|cta_?(bancaria|ordem|debito)|iban[a-z0-9_]*|nib|n_i_b|account_?(no|num|number)|bank_?account', 0.9]),
  byPattern([
    [String.raw`PT50\d{21}`, 0.95, { checksum: 'MOD97' }],
    [String.raw`PT50( \d{4}){5} \d`, 0.95, { checksum: 'MOD97', clean: String.raw`\s` }],
    [String.raw`\d{4}[\s.\-]?\d{4}[\s.\-]?\d{11}[\s.\-]?\d{2}`, 0.7],
  ], { reject: 0.3 }))

// ── L1 · Cards, wallets, network, devices ───────────────────────────────────

// Payment Card fails a row that has no digits to mask; only values shaped like a card reach it.
decompose('PT_CARTAO', [[String.raw`(\d[\d\s\-]{11,22}\d)`, apply(ENGINE.CREDIT_CARD)]], keep, '4532 0000 0000 0001')
domain('PT_L1_CARTAO_PAGAMENTO', 'PT_CARTAO',
  byName(['cart[aã]o_?(de_?)?(cr[eé]dito|d[eé]bito|pagamento|multibanco)|n(o|r|ro|um|umero)_?cart[aã]o(_?(cr[eé]dito|d[eé]bito))?|pan|card_?(no|num|number)|credit_?card', 0.85]),
  // An IMEI is 15 Luhn-valid digits too: 15-digit cards are American Express (34, 37), and the rest
  // is left to the device domain. 0.9, not 1, so that a column name still wins.
  byPattern([[String.raw`3[47]\d{13}|[1-9]\d{12,13}|[1-9]\d{15,18}`, 0.9, { checksum: 'LUHN', clean: String.raw`[\s\-]` }]], { reject: 0.3 }))

domain('PT_L1_CARTEIRA_DIGITAL', 'PT_CM_ALFANUM',
  byName(['carteira_?(digital|cripto|bitcoin)|wallet(_?(id|address|endereco))?|endere[cç]o_?(bitcoin|btc|wallet|cripto)|btc_?(address|endereco)', 0.85]),
  byPattern([[String.raw`(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,59}`, 0.7]], { reject: 0.3 }))

algorithm('PT_OCTETO', 'characterMapping.NumericMapping', { minValue: 1, maxValue: 254 }, '10')
decompose('PT_IP', [
  [String.raw`(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})`, apply('PT_OCTETO'), apply('PT_OCTETO'), apply('PT_OCTETO'), apply('PT_OCTETO')],
], apply('PT_CM_HEX'), '85.243.120.12')
domain('PT_L1_IP', 'PT_IP',
  byName(['ip|ip_?(address|addr|origem|destino|cliente|utilizador|acesso|login|remoto|publico)|endere[cç]o_?ip|end_?ip|ipv[46]|remote_?addr(ess)?|client_?ip|host_?ip', 0.85]),
  byPattern([
    [String.raw`((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)`, 1],
    [String.raw`[0-9A-Fa-f]{1,4}(:[0-9A-Fa-f]{0,4}){2,7}`, 0.9],
  ], { reject: 0.3 }))

domain('PT_L1_DISPOSITIVO', 'PT_CM_HEX',
  byName(['imei|imsi|iccid|mac|mac_?address|endere[cç]o_?mac|device_?(id|uuid|serial)|id_?(dispositivo|equipamento|terminal)|serial_?(equipamento|terminal|dispositivo)|advertising_?id|idfa|gaid|session_?id|id_?sess[aã]o', 0.8]),
  byPattern([
    [String.raw`([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}`, 1],
    [String.raw`\d{15}`, 0.8, { checksum: 'LUHN' }],
  ], { reject: 0.3 }))

domain('PT_L1_COOKIE', 'PT_CM_ALFANUM',
  byName(['cookie(_?(id|value|valor|nome))?|cookies|_?ga|_?gid|fbp|fbclid|utm_?(source|medium|campaign|term|content)|id_?(navegador|browser|visitante)|visitor_?id|tracking_?id|client_?id', 0.8]))

// ── L1 · Vehicles ───────────────────────────────────────────────────────────
//
// Four series of plates have run since 1937, each two letters and four digits in another order:
// AA-00-00, 00-00-AA (1992), 00-AA-00 (2005) and AA-00-AA (2020). The letters are masked inside the
// 23 letters the series use — no K, W or Y —, the digits among digits, and the order stays, so a
// masked plate still dates the car to its series.
algorithm('PT_CM_MATRICULA', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'ABCDEFGHIJLMNOPQRSTUVXZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, 'AA-12-BC')
decompose('PT_MATRICULA', [
  [String.raw`([A-Z]{2}|\d{2})([\s\-]?)([A-Z]{2}|\d{2})([\s\-]?)([A-Z]{2}|\d{2})`, apply('PT_CM_MATRICULA'), keep, apply('PT_CM_MATRICULA'), keep, apply('PT_CM_MATRICULA')],
], apply('PT_CM_DIGITOS_LETRAS'), 'AA-12-BC')
domain('PT_L1_MATRICULA', 'PT_MATRICULA',
  byName(['matr[ií]cula(?!_?(aluno|estudante|acad[eé]mica|curso|escolar|profissional|predial))(_?(ve[ií]culo|viatura|carro|autom[oó]vel|mota))?|n(o|r|ro|um|umero)_?matr[ií]cula|chapa_?matr[ií]cula|license_?plate|plate(_?(no|number))?', 0.85]),
  byPattern([
    [String.raw`[A-Z]{2}-\d{2}-[A-Z]{2}|\d{2}-[A-Z]{2}-\d{2}|\d{2}-\d{2}-[A-Z]{2}|[A-Z]{2}-\d{2}-\d{2}`, 0.9],
    [String.raw`[A-Z]{2}\d{2}[A-Z]{2}|\d{2}[A-Z]{2}\d{2}|\d{4}[A-Z]{2}|[A-Z]{2}\d{4}`, 0.5],
  ], { reject: 0.3 }))

domain('PT_L1_VEICULO', 'PT_CM_ALFANUM',
  byName(['vin|chassis|chassi|n(o|r|ro|um|umero)_?(de_?)?(chassis|quadro|motor|vin|s[eé]rie)|certificado_?(de_?)?matr[ií]cula|dua|documento_?[uú]nico_?autom[oó]vel|livrete', 0.85]),
  byPattern([[String.raw`[A-HJ-NPR-Z0-9]{17}`, 0.7]], { reject: 0.3 }))

// ── L1 · Property and supply: the artigo matricial and the CPE ──────────────
//
// A property is an artigo matricial in the tax register — the freguesia, U for urban or R for rural,
// and a number: `110508-U-1234` — and a descrição in the land register. Beside a person's name it
// says where that person owns a house. The number of the article changes; the freguesia and the
// kind stay.
decompose('PT_IMOVEL', [
  [String.raw`(\d{6}[\s\-]?)([URO])([\s\-]?)(\d{1,6})(.*)`, keep, keep, keep, DIGITS, keep],
  [String.raw`([URO])([\s\-]?)(\d{1,6})(.*)`, keep, keep, DIGITS, keep],
  [String.raw`(\d{1,6})(/)(\d{8})`, DIGITS, keep, keep],
], CM, '110508-U-1234')
domain('PT_L1_IMOVEL', 'PT_IMOVEL',
  byName(['artigo_?matricial|art_?matricial|matriz_?predial|n(o|r|ro|um|umero)_?(de_?)?(artigo|matriz|descri[cç][aã]o_?predial|pr[eé]dio|im[oó]vel|fra[cç][aã]o)|descri[cç][aã]o_?predial|registo_?predial|caderneta_?predial|property_?(id|number)', 0.9]),
  byPattern([[String.raw`\d{6}[\s\-]?[UR][\s\-]?\d{1,6}`, 0.8]], { reject: 0.3 }))

// The **CPE** names every electricity supply point, the **CUI** every gas one: `PT`, four digits for
// the network operator — 0002 for the E-Redes on the mainland —, twelve for the point and two
// control letters. They follow the same rule as the Spanish CUPS — the sixteen digits modulo 529,
// divided by 23, read in the table TRWAGMYFPDXBNJZSQVHLCKE —, checked on two CPE published in public
// tenders (PT0002000066435112QY and PT0002000109439276TN). A CPE names a home: the bill, the smart
// meter's consumption curve and the social tariff hang from it. The operator stays, the twelve
// digits change, and a state of three digits crosses the value.
const LETTERS_23 = 'TRWAGMYFPDXBNJZSQVHLCKE'
const CPE_STEP = stateRows('PT_CPE_PASSO', 'pt-cpe-passo.txt', range(0, 528), 3, [...DIGIT_CHARS, 'P', 'T', SPACE], (s, c) => (/\d/.test(c) ? (s * 10 + Number(c)) % 529 : s), '000P')
const CPE_FINAL = cleansing('PT_CPE_LETRAS_TABELA', 'pt-cpe-letras.txt',
  range(0, 528).map((s) => [`${pad(s, 3)}~`, `${LETTERS_23[Math.floor(s / 23)]}${LETTERS_23[s % 23]}`]), '386~')
const cpeLetters = (sixteen) => { const r = Number(BigInt(sixteen) % 529n); return `${LETTERS_23[Math.floor(r / 23)]}${LETTERS_23[r % 23]}` }
if (cpeLetters('0002000066435112') !== 'QY' || cpeLetters('0002000109439276') !== 'TN') throw new Error('CPE: the rule disagrees with the published codes')
const CPE = pipeline('PT_CPE_CADEIA', 'PT0002000066435112QY', [
  [(input) => decompose('PT_CPE_PONTO', [
    [String.raw`(PT\s?\d{4}\s?)(\d{4}\s?\d{4}\s?\d{4}|\d{12})(.*)`, keep, FIXED_DIGITS, keep],
  ], keep, input), (v) => v],
  [(input) => spaces('PT_CPE_MARCAR', ' ', SPACE, input), markSpaces],
  [(input) => decompose('PT_CPE_PREPARAR', [
    [String.raw`(P)(.*[\d_])([A-Za-z]{2})(\d[A-Za-z])`, redactAs('000P'), keep, redactAs('~'), keep],
    [String.raw`(P)(.*[\d_])([A-Za-z]{2})`, redactAs('000P'), keep, redactAs('~')],
  ], keep, input), (v) => v.replace(/^P(.*[\d_])[A-Za-z]{2}(\d[A-Za-z])?$/, (_, mid, suffix) => `000P${mid}~${suffix ?? ''}`)],
  ...Array.from({ length: 22 }, (_, k) => stepAt(`PT_CPE_PASSO_${pad(k, 2)}`, k, 3, CPE_STEP)),
  [(input) => decompose('PT_CPE_LETRAS', [[String.raw`(.*)(\d{3}~)(.*)`, keep, apply(CPE_FINAL), keep]], keep, input),
    (v) => v.replace(/(\d{3})~/, (_, s) => `${LETTERS_23[Math.floor(Number(s) / 23)]}${LETTERS_23[Number(s) % 23]}`)],
  [(input) => spaces('PT_CPE_RESTAURAR', SPACE, ' ', input), restoreSpaces],
])
if (CPE !== 'PT0002000066435112QY') throw new Error(`CPE: the chain gives ${CPE}`)
decompose('PT_CPE', [[String.raw`(PT\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?[A-Za-z]{2}(?:\d[A-Za-z])?)`, apply('PT_CPE_CADEIA')]], CM, 'PT0002000066435112QY')
domain('PT_L1_PONTO_ENTREGA', 'PT_CPE',
  byName(['cpe|c_p_e|c[oó]digo_?(de_?)?ponto_?(de_?)?entrega|ponto_?(de_?)?entrega|cui|c[oó]digo_?universal_?(de_?)?instala[cç][aã]o|cpe_?(luz|gas|eletricidade)|cups', 0.95]),
  byPattern([[String.raw`PT\d{16}[A-Z]{2}(\d[A-Z])?`, 0.95]], { reject: 0.3 }))

domain('PT_L1_CONTRATO', 'PT_CM_ALFANUM',
  byName(['n(o|r|ro|um|umero)_?(contrato|ap[oó]lice|empr[eé]stimo|pedido|processo_?(administrativo|interno)|refer[eê]ncia|cliente|s[oó]cio|assinante|instala[cç][aã]o|servi[cç]o|caso|ticket|sinistro|reclama[cç][aã]o|ocorr[eê]ncia)|contrato_?(n(o|r|ro|um|umero))|c[oó]digo_?(cliente|s[oó]cio|funcion[aá]rio|assinante)|id_?(cliente|s[oó]cio|funcion[aá]rio)|n(o|r|ro)_?(funcion[aá]rio|mecanogr[aá]fico|colaborador)', 0.7]))

domain('PT_L1_UTILIZADOR', 'PT_CM_ALFANUM',
  byName(['utilizador|user_?name|username|login|alcunha|nick(_?name)?|perfil_?(instagram|facebook|twitter|tiktok|linkedin|x)|instagram|facebook|twitter|tiktok|linkedin|rede_?social|handle', 0.7]))

// Password hashes carry their scheme: bcrypt, crypt (MD5, SHA-256, SHA-512), Argon2, PBKDF2 and the
// LDAP {SSHA} forms. A bare hex digest could be any hash, and is left to the column name.
const PASSWORD_HASHES = [
  [String.raw`\$2[abxy]?\$\d{2}\$[./A-Za-z0-9]{53}`, 0.95],
  [String.raw`\$(1|5|6)\$(rounds=\d+\$)?[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{22,86}`, 0.95],
  [String.raw`\$argon2(id|i|d)\$v=\d+\$m=\d+,t=\d+,p=\d+\$\S+`, 0.95],
  [String.raw`pbkdf2_sha(1|256|512)\$\d+\$\S+\$\S+`, 0.95],
  [String.raw`\{(SSHA|SHA|SSHA256|SSHA512|SMD5|MD5|CRYPT)\}\S+`, 0.95],
]
domain('PT_L1_CREDENCIAL', 'PT_REDIGIR',
  byName(['palavra_?passe|senha|password|passwd|pwd|pass|hash_?(senha|password|palavra_?passe)|pin|c[oó]digo_?(seguran[cç]a|verifica[cç][aã]o|acesso|otp)|cvv|cvc|token(_?(acesso|refresh|api))?|access_?token|refresh_?token|api_?key|chave_?(api|privada|m[oó]vel_?digital)|segredo|secret|otp|pergunta_?secreta|resposta_?secreta|seed_?phrase', 0.9]),
  byPattern(PASSWORD_HASHES, { reject: 0.3 }))

// The image of a person is a right of its own (art. 26.º of the Constitution, art. 79.º of the Código
// Civil), and Lei n.º 58/2019 protects the image of the dead (art. 17.º) and limits video
// surveillance (art. 19.º).
domain('PT_L1_IMAGEM', 'PT_REDIGIR',
  byName(['foto(grafia)?[a-z0-9_]*|imagem_?(pessoa|rosto|perfil|cc|documento)|avatar|selfie|retrato|video_?(pessoa|entrevista|vigil[aâ]ncia)|videovigil[aâ]ncia|grava[cç][aã]o(_?(chamada|voz|c[aâ]mara))?|audio_?(voz|chamada)|url_?foto|caminho_?(foto|imagem)|photo[a-z0-9_]*|picture|image_?(url|path|person)', 0.85]))

decompose('PT_COORDENADA', [
  // The integer part and first decimal stay (about 11 km): the place is generalized, not moved.
  [String.raw`(-?\d{1,3}[.,]\d)(\d+)\s*([,;])\s*(-?\d{1,3}[.,]\d)(\d+)`, keep, DIGITS, keep, keep, DIGITS],
  [String.raw`(-?\d{1,3}[.,]\d)(\d+)`, keep, DIGITS],
], keep, '38.722252')
domain('PT_L1_GEOLOCALIZACAO', 'PT_COORDENADA',
  byName(
    ['lat|latitude|lon|lng|longitude|coordenadas?|coord_?[xy]|geo_?(lat|lon|lng|loc|localizacao|posicao)|georreferencia[cç][aã]o|geolocaliza[cç][aã]o|gps(_?(localiza[cç][aã]o|posi[cç][aã]o|coordenadas))?|localiza[cç][aã]o_?gps', 0.85],
    ['long', 0.5],
  ),
  byPattern([
    // The mainland, Madeira and the Azores.
    [String.raw`(3[2-9]|4[0-2])\.\d{3,}\s*,\s*-(\d|[12]\d|3[01])\.\d{3,}`, 0.9],
    [String.raw`(3[7-9]|4[0-2])\.\d{4,}`, 0.4],
  ], { reject: 0.3 }))

// ── L1 · Free text ──────────────────────────────────────────────────────────

algorithm('PT_TEXTO_LIVRE', 'freeTextRedaction.FreeTextRedaction', {
  regularExpressions: [
    // Free Text Redaction splits the text on whitespace and matches inside a word, so a number written
    // with spaces is reached in pieces: the eight digits of a civil number, then the rest.
    String.raw`(?<![\dA-Za-z])\d{8}-?\d-?[A-Za-z0-9]{2}\d(?![A-Za-z\d])`,
    String.raw`(?<![\d\-])\d{8,9}(?![\d\-])`,
    String.raw`(?<!\d)[12]\d{10}(?!\d)`,
    String.raw`[\w.+\-]+@[\w\-]+(\.[\w\-]+)+`,
    String.raw`(?<![\d\-])(\+|00)351\d{9}(?![\d\-])`,
    String.raw`(?<!\d)\d{13,19}(?!\d)`,
    String.raw`PT50\d{21}`,
    String.raw`(?<!\d)\d{21}(?!\d)`,
    String.raw`(?<!\d)(\d{1,3}\.){3}\d{1,3}(?!\d)`,
    String.raw`[A-Z]{2}-\d{2}-[A-Z]{2}|\d{2}-[A-Z]{2}-\d{2}`,
  ].map((patternString) => ({ patternString })),
  regExRedactValue: '[DADO]',
  lookupFile: { uri: file('pt-texto-nomes.txt', unique([...GIVEN_NAMES, ...SURNAMES].flatMap((v) => [v, v.toUpperCase(), fold(v), fold(v).toUpperCase()]))) },
  lookupFileRedactValue: '[NOME]',
  isDenyList: true,
}, 'Cliente Gonçalves, NIF 123456789, email i.goncalves@gmail.com, telemóvel 912345678')

domain('PT_L1_TEXTO_LIVRE', 'PT_TEXTO_LIVRE',
  byName(['observa[cç][aã]o(es|[oõ]es)?|obs|coment[aá]rios?|notas?|anota[cç][aã]o(es|[oõ]es)?|descri[cç][aã]o_?(queixa|reclama[cç][aã]o|pedido|caso|factos|ocorr[eê]ncia|atendimento|den[uú]ncia)|detalhe_?(reclama[cç][aã]o|pedido|caso|ocorr[eê]ncia)|factos|relato|motivo_?(da_?)?(reclama[cç][aã]o|pedido|chamada)|justifica[cç][aã]o|(?<!(id|cd|cod|codigo|tipo|data|estado|num|nr)_?)mensagem(?!_?(id|tipo|codigo|data|estado|fila|log))|texto(_?livre)?|resumo_?(caso|atendimento)|queixa|reclama[cç][aã]o|remarks?|comments?|notes?|free_?text|memo', 0.6]),
  byType(STRING(30)),
  byPattern([
    [String.raw`\d{8}\s?\d\s?[A-Z0-9]{2}\d`, 0.8],
    [String.raw`[\w.+\-]+@[\w\-]+\.[A-Za-z]{2,}`, 0.7],
    [String.raw`9[1236]\d[\s\-]?\d{3}[\s\-]?\d{3}`, 0.6],
  ], { reject: 0, partial: true }))


// ── L2 · Quasi-identifiers ──────────────────────────────────────────────────

// Small shifts: large enough to break the link to the person, small enough that ages and school
// years move for few people.
algorithm('PT_DATA_NASCIMENTO', 'dateAlgorithms.DateShift', { minRange: -60, maxRange: 60, unit: 'DAYS', roll: false }, '1985-07-20')
algorithm('PT_DATA_EVENTO', 'dateAlgorithms.DateShift', { minRange: -30, maxRange: 30, unit: 'DAYS', roll: false }, '2021-03-15')

domain('PT_L2_DATA_NASCIMENTO', 'PT_DATA_NASCIMENTO',
  byName(['(data|dt)_?(de_?)?nasc(imento)?|dtnasc|datanasc(imento)?|aniversario|anivers[aá]rio|dob|date_?of_?birth|birth_?date|birthday', 0.9]),
  byType(...DATES, STRING(6)))

decompose('PT_ANO', [[String.raw`(\d{3})(\d)`, keep, DIGITS]], keep, '1985')
domain('PT_L2_ANO_NASCIMENTO', 'PT_ANO',
  byName(['ano_?(de_?)?nasc(imento)?|year_?of_?birth|birth_?year|yob', 0.9]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// 37 becomes 3x. From 100 on, 90.
decompose('PT_IDADE', [
  [String.raw`([1-9]\d{2,})`, redactAs('90')],
  [String.raw`([1-9])(\d)([.,]\d+)`, keep, DIGITS, keep],
  [String.raw`([1-9])(\d)`, keep, DIGITS],
  [String.raw`(\d)`, DIGITS],
], keep, '37')
domain('PT_L2_IDADE', 'PT_IDADE',
  byName(['idade(_?(atual|anos|utente|doente|cliente|na_?(admiss[aã]o|data_?(do_?)?diagn[oó]stico|morte|[oó]bito)))?|grupo_?et[aá]rio|faixa_?et[aá]ria|escal[aã]o_?et[aá]rio|age(_?(years|group))?', 0.85]),
  byType(NUMBER(0, 6), STRING(0, 6)))

domain('PT_L2_DATA_EVENTO', 'PT_DATA_EVENTO',
  byName(['(data|dt)_?(de_?|do_?|da_?)?([oó]bito|falecimento|casamento|div[oó]rcio|admiss[aã]o|demiss[aã]o|cessa[cç][aã]o|despedimento|reforma|aposenta[cç][aã]o|internamento|alta|diagn[oó]stico|atendimento|consulta|parto|deten[cç][aã]o|senten[cç]a|condena[cç][aã]o|emiss[aã]o_?(cc|bi|documento)|validade_?(cc|bi|documento|t[ií]tulo)|vacina[cç][aã]o|interven[cç][aã]o|acidente|incapacidade|baixa_?m[eé]dica)|date_?of_?(death|marriage|hire|admission|discharge)', 0.8]),
  byType(...DATES, STRING(6)))

// Each vocabulary replaced within itself: F/M stays F/M. A single M is read as masculino — the
// convention of the Cartão de Cidadão and of every Portuguese register.
decompose('PT_SEXO', [
  ['(?iu)(feminino|masculino)', apply(lookup('PT_SEXO_FEMININO_MASCULINO', 'pt-sexo-feminino-masculino.txt', ['Feminino', 'Masculino']))],
  ['(?iu)(mulher|homem)', apply(lookup('PT_SEXO_MULHER_HOMEM', 'pt-sexo-mulher-homem.txt', ['Mulher', 'Homem']))],
  ['(?i)(female|male)', apply(lookup('PT_SEXO_FEMALE_MALE', 'pt-sexo-female-male.txt', ['Female', 'Male']))],
  ['(?i)([fm])', apply(lookup('PT_SEXO_F_M', 'pt-sexo-f-m.txt', ['F', 'M']))],
  ['(?i)(h)', apply(lookup('PT_SEXO_H_M', 'pt-sexo-h-m.txt', ['H', 'M']))],
  ['([12])', apply(lookup('PT_SEXO_1_2', 'pt-sexo-1-2.txt', ['1', '2']))],
], keep, 'F')
domain('PT_L2_SEXO', 'PT_SEXO',
  byName(['sexo(_?(biol[oó]gico|registado|utente|doente|cliente))?|(tp|tipo|cod|cd|id)_?sexo|g[eé]nero(?!_?(identidade|sentido))|sex|gender(?!_?identity)', 0.85]),
  // A column of single letters is the sex on its own; the words are stronger evidence.
  byList([
    ['pt-detetar-sexo.txt', ['homem', 'mulher', 'feminino', 'masculino', 'female', 'male'], 0.8],
    ['pt-detetar-sexo-letra.txt', ['f', 'm', 'h'], 0.6],
  ], { reject: 0.5 }))

// ── L2 · Where people live ──────────────────────────────────────────────────
//
// Portugal has 308 concelhos, and in the Censos 2021 188 of them had fewer than 20,000 inhabitants:
// 1.6 million people, in places where a birth date and a sex point at a handful of neighbours. A small
// concelho becomes the nearest concelho of at least 20,000 in the same distrito — every distrito has
// one, its capital at least — or, on the islands, in the same autonomous region: the Açores have
// Ponta Delgada, Ribeira Grande and Angra do Heroísmo; Madeira, Funchal, Santa Cruz and Câmara de
// Lobos. The distrito and the region stay.
//
// A freguesia below 20,000 — all but 119 of the 3,092 of the census — becomes the most populous
// freguesia of the concelho its own concelho ends up in: the town that names the concelho, as a rule.
// The table holds the freguesias of the 2013 map and the 303 the 2025 reorganization brought back,
// so either generation of names is found.
const distance = (a, b) => {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}
const SMALL_PLACE = 20000
const nearest = (place, candidates) => candidates.reduce((best, x) => (distance(place, x) < distance(place, best) ? x : best))
const largeConcelhos = CONCELHOS.filter((c) => c.population >= SMALL_PLACE)
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
// With what scopes the name, as systems write it to tell homonyms apart: `Lagoa (Faro)`, `Lagoa,
// Faro`; a freguesia with its concelho: `Santa Maria (Lagos)`.
const QUALIFIER_FORMS = [[' (', ')'], [', ', '']]

/**
 * The generalization table. `places` carry name, `small`, `to` — the place they become — and
 * `qualifiers`, the names systems write beside the name, each with the code that scopes the
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
    const toQualifier = from.toQualifier ?? qualifier.name
    for (const name of written) for (const [a, b] of QUALIFIER_FORMS) pairs.push([`${name}${a}${qualifier.name}${b}`, `${from.to.name}${a}${toQualifier}${b}`])
  }
  const qualified = (p) => spellingsOf(p).flatMap((name) => p.qualifiers.flatMap((q) => QUALIFIER_FORMS.map(([a, b]) => `${name}${a}${q.name}${b}`)))
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

const concelhoTo = (c) => nearest(c, largeConcelhos.filter((x) => x.regionCode === c.regionCode))
const concelhoPlaces = CONCELHOS.map((c) => ({ ...c, small: c.population < SMALL_PLACE }))
const concelhoPlaceByCode = new Map(concelhoPlaces.map((c) => [c.code, c]))
for (const c of concelhoPlaces) c.to = c.small ? concelhoPlaceByCode.get(concelhoTo(c).code) : c
for (const c of concelhoPlaces) c.qualifiers = [{ code: c.regionCode, name: c.region }]
// Distritos and regions are far above the threshold and are never generalized; they join the table
// only so that a name shared with one of them is left alone.
const regionPlaces = [...REGIONS, { code: 'RA', name: 'Região Autónoma dos Açores' }, { code: 'RM', name: 'Região Autónoma da Madeira' }, { code: 'PT', name: 'Portugal' }, { code: 'CO', name: 'Continente' }]
  .map((r) => ({ ...r, aliases: [], population: Infinity, small: false, qualifiers: [] }))
for (const r of regionPlaces) r.to = r

const concelhos = generalization([...concelhoPlaces, ...regionPlaces])
cleansing('PT_CONCELHO', 'pt-concelhos-generalizados.txt', concelhos.table, 'Mértola')

// Freguesias: the target is the most populous freguesia of the concelho the freguesia's concelho
// becomes — among those of the 2013 map that still exist, so that the replacement is a current name.
const freguesiaPlaces = FREGUESIAS.map((f) => ({ ...f, small: f.population < SMALL_PLACE }))
const seatOf = new Map()
for (const c of CONCELHOS) {
  const current = freguesiaPlaces.filter((f) => f.concelhoCode === c.code && f.era !== '2013-2025')
  seatOf.set(c.code, current.reduce((a, b) => (b.population > a.population ? b : a)))
}
for (const f of freguesiaPlaces) {
  const concelho = concelhoPlaceByCode.get(f.concelhoCode)
  f.to = f.small ? seatOf.get(concelho.to.code) : f
  f.qualifiers = [{ code: f.concelhoCode, name: concelho.name }]
  // Written with its concelho, a generalized freguesia is written with the concelho it moved to.
  f.toQualifier = concelho.to.name
}
const freguesias = generalization([...freguesiaPlaces, ...regionPlaces])
cleansing('PT_FREGUESIA', 'pt-freguesias-generalizadas.txt', freguesias.table, 'Santa Maria de Alvarenga')

/**
 * The DICO of a concelho — two digits for the distrito or island, two for the concelho — and the
 * DICOFRE of a freguesia — the DICO and two more — follow the names: a small concelho's code becomes
 * the code of the concelho it is generalized to, and a small freguesia's code the code of its target.
 * Four and six digits, three and five once the zero of a distrito below 10 is gone: no two collide.
 */
const codePairs = [
  ...concelhoPlaces.filter((c) => c.small).map((c) => [c.code, c.to.code]),
  ...freguesiaPlaces.filter((f) => f.small && f.to.code !== f.code).map((f) => [f.code, f.to.code]),
]
// Barcelos had more than 99 freguesias, and the INE gave the last ones letters: 0302FA. The table is
// looked up without the zeros on the left, as the other presets' code tables are, for both kinds.
{
  const strip = (code) => code.replace(/^0+(?=[1-9])/, '')
  const rows = new Map(codePairs)
  for (const [from, to] of codePairs) {
    const key = strip(from)
    if (rows.has(key) && rows.get(key) !== strip(to)) throw new Error(`autarchic codes: ${key} becomes ${rows.get(key)} and ${strip(to)}`)
    rows.set(key, strip(to))
  }
  cleansing('PT_CODIGO_AUTARQUICO_TABELA', 'pt-codigos-autarquicos-generalizados.txt', [...rows], '020901')
  decompose('PT_CODIGO_AUTARQUICO', [
    [String.raw`(0*)([1-9]\d{2,3}[A-Za-z]{2})`, keep, apply('PT_CODIGO_AUTARQUICO_TABELA')],
    [String.raw`(0*)([1-9]\d*)`, keep, apply('PT_CODIGO_AUTARQUICO_TABELA')],
  ], keep, '020901')
}

/**
 * Postal codes: the four digits (CP4) of the CTT follow the concelho they mostly serve. A CP4 of a
 * small concelho becomes the main CP4 of the concelho it is generalized to, so a masked postal code
 * agrees with the masked concelho beside it; the three digits after the hyphen (CP3), which narrow it
 * to a street, change digit by digit.
 */
const mainPostalCode = new Map()
for (const p of [...POSTAL_CODES].sort((a, b) => b.counts[0] - a.counts[0])) {
  if (!mainPostalCode.has(p.concelhos[0])) mainPostalCode.set(p.concelhos[0], p.code)
}
const postalPairs = []
for (const p of POSTAL_CODES) {
  const c = concelhoPlaceByCode.get(p.concelhos[0])
  if (!c.small) continue
  const target = mainPostalCode.get(c.to.code)
  if (!target) throw new Error(`postal code ${p.code}: no code for ${c.to.name}`)
  postalPairs.push([p.code, target])
}
cleansing('PT_CP4', 'pt-cp4-generalizados.txt', postalPairs, '7750')
decompose('PT_CODIGO_POSTAL', [
  [String.raw`(\d{4})(-)(\d{3})(\s+)(.+)`, apply('PT_CP4'), keep, DIGITS, keep, apply('PT_CONCELHO')],
  [String.raw`(\d{4})([\s\-]?)(\d{3})`, apply('PT_CP4'), keep, DIGITS],
  [String.raw`(\d{4})`, apply('PT_CP4')],
], keep, '7750-320')

const PERSONAL_WORDS = new Set([...GIVEN_NAMES, ...SURNAMES].map((w) => fold(w).toLowerCase()))
const REGION_NAMES = new Set(regionPlaces.map((r) => fold(r.name).toLowerCase()))
const placeNames = (list) => unique(list.flatMap(spellingsOf))
  .filter((n) => !PERSONAL_WORDS.has(fold(n).toLowerCase()) && !REGION_NAMES.has(fold(n).toLowerCase()))

domain('PT_L2_CONCELHO', 'PT_CONCELHO',
  byName(['concelho(?!_?(cod|codigo|id|dico))(_?(resid[eê]ncia|nascimento|naturalidade|morada))?|munic[ií]pio(?!_?(cod|codigo|id))(_?(resid[eê]ncia|nascimento))?|localidade(_?(resid[eê]ncia|nascimento|morada))?|cidade(_?(resid[eê]ncia|nascimento|morada))?|naturalidade|(nome|desc)_?(concelho|munic[ií]pio|localidade|cidade)|local_?(de_?)?nascimento|city|town|municipality', 0.85]),
  byList([['pt-detetar-concelhos.txt', placeNames(CONCELHOS), 0.8]], { reject: 0.4 }))

domain('PT_L2_FREGUESIA', 'PT_FREGUESIA',
  byName(['freguesia(?!_?(cod|codigo|id|dicofre))(_?(resid[eê]ncia|nascimento|naturalidade|morada))?|(nome|desc)_?freguesia|junta_?(de_?)?freguesia|parish', 0.9]),
  byList([['pt-detetar-freguesias.txt', placeNames(FREGUESIAS.filter((f) => !CONCELHOS.some((c) => nameKey(c.name) === nameKey(f.name)))), 0.6]], { reject: 0.4 }))

domain('PT_L2_CODIGO_AUTARQUICO', 'PT_CODIGO_AUTARQUICO',
  byName(['dico|dicofre|(cod|codigo|cd|id)_?(ine_?)?(concelho|munic[ií]pio|freguesia|localidade)(_?(ine|resid[eê]ncia|nascimento|morada))?|c[oó]digo_?ine|cod_?ine|ine_?(concelho|freguesia|code)|municipality_?code|parish_?code', 0.9]),
  byPattern([[String.raw`(0[1-9]|1[0-8]|3[12]|4[1-9])\d{2}([0-9A-Z]{2})?`, 0.4]], { reject: 0.3 }))

domain('PT_L2_CODIGO_POSTAL', 'PT_CODIGO_POSTAL',
  byName(['c[oó]digo_?postal|cod_?postal|codpostal|cp|c_p|cp_?(resid[eê]ncia|morada|cliente|envio)|cp4|cp7|postal_?code|zip(_?code)?', 0.9]),
  byPattern([[String.raw`[1-9]\d{3}-\d{3}`, 0.9], [String.raw`[1-9]\d{3}`, 0.3]], { reject: 0.3 }))

// Nationality is not a special category of article 9, but article 13.º of the Constitution forbids
// discrimination by "território de origem", and in a test copy it is what points at the few foreign
// residents of a small place. Portugal has more than a million foreign residents; the largest
// communities are Brazilian, Angolan, Cape Verdean, British, Indian and Nepalese.
const COUNTRIES = ['Portuguesa', 'Brasileira', 'Angolana', 'Cabo-verdiana', 'Britânica', 'Indiana', 'Italiana', 'Nepalesa', 'Ucraniana', 'Francesa', 'Guineense', 'Chinesa', 'Bangladeshiana', 'Romena', 'Espanhola', 'Alemã', 'São-tomense', 'Paquistanesa', 'Norte-americana', 'Moçambicana']
lookup('PT_NACIONALIDADE', 'pt-nacionalidades.txt', COUNTRIES, 'Timorense')
domain('PT_L2_NACIONALIDADE', 'PT_NACIONALIDADE',
  byName(['nacionalidade(_?(origem|atual))?|pa[ií]s_?(de_?)?(nascimento|origem|nacionalidade|proveni[eê]ncia)|cidadania|nationality|citizenship|country_?of_?birth', 0.85]),
  byList([['pt-detetar-nacionalidades.txt', [...COUNTRIES, 'português', 'portuguesa', 'brasileiro', 'brasileira', 'angolano', 'cabo-verdiano', 'britânico', 'indiano', 'italiano', 'nepalês', 'ucraniano', 'francês', 'guineense', 'chinês', 'romeno', 'espanhol', 'alemão', 'portugal', 'brasil', 'angola', 'cabo verde', 'reino unido', 'índia', 'nepal', 'ucrânia', 'estrangeiro', 'estrangeira'], 0.7]], { reject: 0.4 }))

const RESIDENCE = ['Autorização de residência temporária', 'Autorização de residência permanente', 'Autorização de residência CPLP', 'Estatuto de residente de longa duração', 'Certificado de registo de cidadão da UE', 'Cartão de residência de familiar de cidadão da UE', 'Requerente de proteção internacional', 'Estatuto de refugiado', 'Proteção subsidiária', 'Proteção temporária', 'Visto de estudo', 'Visto para procura de trabalho', 'Autorização de residência para investimento', 'Situação irregular', 'Não aplicável']
categorical('PT_SITUACAO_RESIDENCIA', 'pt-situacao-residencia.txt', RESIDENCE, 'Manifestação de interesse')
domain('PT_L2_SITUACAO_RESIDENCIA', 'PT_SITUACAO_RESIDENCIA',
  byName(['situa[cç][aã]o_?(de_?)?(resid[eê]ncia|migrat[oó]ria|documental|legal)|tipo_?(de_?)?(resid[eê]ncia|autoriza[cç][aã]o|visto|t[ií]tulo)|estatuto_?(de_?)?(refugiado|ap[aá]trida|residente)|prote[cç][aã]o_?(internacional|tempor[aá]ria|subsidi[aá]ria)|requerente_?(de_?)?asilo|asilo|manifesta[cç][aã]o_?(de_?)?interesse|migration_?status|immigration_?status|residence_?status', 0.9]),
  byList([['pt-detetar-situacao-residencia.txt', [...RESIDENCE, 'residente', 'temporária', 'permanente', 'cplp', 'longa duração', 'refugiado', 'refugiada', 'asilo', 'irregular', 'proteção temporária', 'manifestação de interesse'], 0.7]], { reject: 0.4 }))

const MARITAL = ['Solteiro(a)', 'Casado(a)', 'União de facto', 'Divorciado(a)', 'Separado(a) de pessoas e bens', 'Viúvo(a)']
categorical('PT_ESTADO_CIVIL', 'pt-estado-civil.txt', MARITAL, 'Casado em regime de comunhão de adquiridos', ['1', '2', '3', '4', '5', '6'])
domain('PT_L2_ESTADO_CIVIL', 'PT_ESTADO_CIVIL',
  byName(['estado_?civil|est_?civil|(cod|tipo|id)_?estado_?civil|uni[aã]o_?de_?facto|regime_?(de_?)?bens|marital_?status|civil_?status', 0.85]),
  byList([['pt-detetar-estado-civil.txt', [...MARITAL, 'solteiro', 'solteira', 'casado', 'casada', 'união de facto', 'divorciado', 'divorciada', 'separado', 'separada', 'viúvo', 'viúva'], 0.7]], { reject: 0.4 }))

lookup('PT_PROFISSAO', 'pt-profissoes.txt', ['Empregado administrativo', 'Empregado de balcão', 'Operador de caixa', 'Motorista de pesados', 'Estafeta', 'Pedreiro', 'Encarregado de obra', 'Professor do ensino secundário', 'Professor do 1.º ciclo', 'Enfermeiro', 'Médico de família', 'Assistente operacional', 'Contabilista certificado', 'Advogado', 'Engenheiro civil', 'Programador informático', 'Rececionista', 'Empregado de limpeza', 'Vigilante', 'Cozinheiro', 'Empregado de mesa', 'Eletricista', 'Canalizador', 'Mecânico de automóveis', 'Trabalhador agrícola', 'Operário fabril', 'Comercial', 'Operador de call center', 'Operador de armazém', 'Cabeleireiro', 'Ajudante de lar', 'Empregada doméstica', 'Estudante', 'Reformado', 'Motorista de TVDE', 'Guia turístico', 'Técnico superior', 'Pescador'], 'Diretor de operações')
decompose('PT_PROFISSAO_OU_CODIGO', [
  // Classificação Portuguesa das Profissões (CPP 2010): one to six digits.
  [String.raw`(\d{1,6})`, DIGITS],
], apply('PT_PROFISSAO'), 'Diretor de operações')
domain('PT_L2_PROFISSAO', 'PT_PROFISSAO_OU_CODIGO',
  byName(
    ['profiss[aã]o|ocupa[cç][aã]o|of[ií]cio|cpp(_?2010)?|(cod|codigo)_?(profiss[aã]o|ocupa[cç][aã]o|cpp)|categoria_?profissional|posto_?(de_?)?trabalho|fun[cç][aã]o_?(exercida|atual)|occupation|profession|job_?title', 0.8],
    ['cargo|fun[cç][aã]o', 0.5],
  ))

lookup('PT_ENTIDADE_EMPREGADORA', 'pt-empregadores.txt', ['Distribuição Atlântica, Lda.', 'Construções do Norte, S.A.', 'Transportes da Planície, Lda.', 'Supermercados Bom Preço, S.A.', 'Metalúrgica do Vale do Ave, Lda.', 'Clínica São Lucas, Lda.', 'Colégio Novo Horizonte', 'Serviços Integrados do Sul, Lda.', 'Cooperativa Agrícola Três Rios, C.R.L.', 'Comercial Os Olivais, Lda.', 'Soluções Digitais Lusas, Lda.', 'Restaurante O Lagar, Lda.', 'Hotel Miradouro da Serra, S.A.', 'Laboratórios Vida Sã, Lda.', 'Segurança Vigia, S.A.', 'Têxteis A Agulha, Lda.', 'Peças Auto do Centro, Lda.', 'Farmácia do Largo, Lda.', 'Logística Porto Seco, S.A.', 'Panificadora A Espiga, Lda.', 'Gabinete de Contabilidade Associados, Lda.', 'Conservas do Atlântico, S.A.', 'Associação de Solidariedade Mãos Unidas, IPSS', 'Cortiças do Alentejo, Lda.'], 'Corporação Industrial do Atlântico, S.A.', 'PRESERVE_LOOKUP_FILE')
domain('PT_L2_ENTIDADE_EMPREGADORA', 'PT_ENTIDADE_EMPREGADORA',
  byName(['entidade_?(empregadora|patronal)|empregador(_?(nome|firma))?|(nome|nom)_?(empregador|empresa_?onde_?trabalha)|empresa_?(onde_?)?(trabalha|empregadora)|local_?(de_?)?trabalho|empresa_?atual|employer(_?name)?|workplace', 0.9]))

const EDUCATION = ['Sem nível de escolaridade', 'Ensino básico - 1.º ciclo', 'Ensino básico - 2.º ciclo', 'Ensino básico - 3.º ciclo', 'Ensino secundário', 'Ensino pós-secundário não superior', 'Bacharelato', 'Licenciatura', 'Mestrado', 'Doutoramento']
categorical('PT_ESCOLARIDADE', 'pt-escolaridade.txt', EDUCATION, 'Curso profissional em curso', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
domain('PT_L2_ESCOLARIDADE', 'PT_ESCOLARIDADE',
  byName(['escolaridade|n[ií]vel_?(de_?)?(escolaridade|ensino|forma[cç][aã]o|instru[cç][aã]o|estudos)|habilita[cç][oõ]es(_?(liter[aá]rias|acad[eé]micas))?|grau_?acad[eé]mico|forma[cç][aã]o_?acad[eé]mica|education(_?level)?', 0.8]),
  byList([['pt-detetar-escolaridade.txt', [...EDUCATION, 'sem escolaridade', '1.º ciclo', '2.º ciclo', '3.º ciclo', '4.ª classe', '9.º ano', '12.º ano', 'secundário', 'bacharelato', 'licenciatura', 'mestrado', 'doutoramento'], 0.6]], { reject: 0.4 }))

lookup('PT_ESTABELECIMENTO_ENSINO', 'pt-estabelecimentos-ensino.txt', ['Escola Básica de Santo António', 'Escola Básica e Secundária D. Dinis', 'Escola Secundária Camões', 'Escola Secundária Alexandre Herculano', 'Agrupamento de Escolas Rio Novo', 'Colégio São José', 'Universidade de Lisboa', 'Universidade do Porto', 'Universidade de Coimbra', 'Universidade do Minho', 'Universidade de Aveiro', 'Universidade Nova de Lisboa', 'Instituto Politécnico de Leiria', 'Universidade do Algarve'], 'Universidade de Évora')
domain('PT_L2_ESTABELECIMENTO_ENSINO', 'PT_ESTABELECIMENTO_ENSINO',
  byName(['estabelecimento_?(de_?)?ensino|escola(_?(frequentada|atual))?|agrupamento(_?(de_?)?escolas)?|col[eé]gio|liceu|universidade|faculdade|instituto_?polit[eé]cnico|(nome|nom)_?(escola|universidade|faculdade)|c[oó]digo_?(de_?)?escola|school(_?name)?|university', 0.75]))

// Capped at 5 as text: large households are rare, and a rare count identifies.
decompose('PT_CONTAGEM_LIMITADA', [[String.raw`([0-5])`, keep], [String.raw`(\d+)`, redactAs('5')]], keep, '9')
domain('PT_L2_AGREGADO', 'PT_CONTAGEM_LIMITADA',
  byName(['dependentes|n(o|r|ro|um|umero)_?(de_?)?(filhos|dependentes|descendentes|membros)|filhos|descendentes|membros_?(do_?)?agregado|agregado_?familiar|dimens[aã]o_?(do_?)?agregado|pessoas_?(no_?)?agregado|number_?of_?children|dependents', 0.8]),
  byType(NUMBER(0, 4), STRING(0, 4)))


// ── L3 · Special categories (art. 9 RGPD and art. 35.º, n.º 3 of the Constitution) ──
//
// Article 9.1 of the Regulamento prohibits processing data revealing racial or ethnic origin,
// political opinions, religious or philosophical beliefs or trade union membership, genetic data,
// biometric data for uniquely identifying a person, data concerning health and data concerning a
// person's sex life or sexual orientation. Portugal wrote the rule into its Constitution in 1976:
// "a informática não pode ser utilizada para tratamento de dados referentes a convicções filosóficas
// ou políticas, filiação partidária ou sindical, fé religiosa, vida privada e origem étnica" save
// with express consent, a law with guarantees of non-discrimination, or "dados estatísticos não
// individualmente identificáveis". Processing them outside article 9 is a contraordenação muito grave
// (art. 37.º, n.º 1 d) of Lei n.º 58/2019), and using them against the purpose of the collection a
// crime whose penalty doubles (arts. 46.º to 48.º).

// Portugal's census does not ask for ethnicity; the INE's 2023 survey on living conditions, origins
// and trajectories (ICOT) asked for self-identification with these groups.
const ETHNICITY = ['Branca', 'Negra', 'Asiática', 'Cigana', 'Mista', 'Outra', 'Prefere não responder']
categorical('PT_ORIGEM_ETNICA', 'pt-origem-etnica.txt', ETHNICITY, 'Afrodescendente', ['1', '2', '3', '4', '5', '6', '7'])
domain('PT_L3_ORIGEM_ETNICA', 'PT_ORIGEM_ETNICA',
  byName(['etnia|origem_?([eé]tnica|racial|[eé]tnico_?racial)|grupo_?[eé]tnico|perten[cç]a_?[eé]tnica|autoidentifica[cç][aã]o_?([eé]tnica|racial)|(cod|codigo|tipo|id)_?etnia|ra[cç]a|comunidade_?cigana|ethnicity|race', 0.95]),
  byList([['pt-detetar-origem-etnica.txt', [...ETHNICITY, 'cigano', 'cigana', 'roma', 'negro', 'negra', 'afrodescendente', 'africano', 'africana', 'asiático', 'asiática', 'branco', 'branca', 'mista', 'outra'], 0.9],
    ['pt-detetar-codigos-indicadores.txt', ['s', 'n', 'sim', 'não', '1', '2', '3', '4', '5', '6', '7', '8', '9'], 0.3],
  ], { reject: 0.4 }))

// The religion question of the Censos 2021.
const RELIGIONS = ['Católica', 'Ortodoxa', 'Protestante ou evangélica', 'Testemunha de Jeová', 'Outra cristã', 'Judaica', 'Muçulmana', 'Budista', 'Hindu', 'Outra não cristã', 'Sem religião']
categorical('PT_RELIGIAO', 'pt-religioes.txt', RELIGIONS, 'Anglicana')
domain('PT_L3_RELIGIAO', 'PT_RELIGIAO',
  byName(['religi[aã]o|cren[cç]a_?(religiosa)?|confiss[aã]o_?religiosa|f[eé]_?religiosa|culto|igreja|(cod|codigo|tipo)_?religi[aã]o|educa[cç][aã]o_?moral_?(e_?)?religiosa|emrc|consigna[cç][aã]o_?(irs_?)?igreja|religion|church', 0.95]),
  byList([['pt-detetar-religioes.txt', [...RELIGIONS, 'católico', 'catolico', 'cristão', 'cristã', 'evangélico', 'evangélica', 'protestante', 'muçulmano', 'islão', 'testemunha de jeová', 'ortodoxo', 'judeu', 'judaica', 'budista', 'hindu', 'ateu', 'ateia', 'agnóstico', 'agnóstica', 'nenhuma', 'sem religião'], 0.9]], { reject: 0.4 }))

domain('PT_L3_CONVICCAO_FILOSOFICA', 'PT_CATEGORIA_SUPRIMIDA',
  byName(['convic[cç][aã]o(es|[oõ]es)?_?(filos[oó]ficas?|morais?|pessoais?|[eé]ticas?)|cren[cç]as?_?(filos[oó]ficas?|morais?|pessoais?)|ideologia(?!_?pol[ií]tica)|obje[cç][aã]o_?(de_?)?consci[eê]ncia|objetor_?(de_?)?consci[eê]ncia|ma[cç]onaria|loja_?ma[cç][oó]nica|veganismo|philosophical_?beliefs?|beliefs?', 0.9]))

const IDEOLOGIES = ['Esquerda', 'Centro-esquerda', 'Centro', 'Centro-direita', 'Direita', 'Nenhuma', 'Prefere não responder']
categorical('PT_OPINIAO_POLITICA', 'pt-opinioes-politicas.txt', IDEOLOGIES, 'Progressista', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
domain('PT_L3_OPINIAO_POLITICA', 'PT_OPINIAO_POLITICA',
  byName(['opini[aã]o_?pol[ií]tica|ideologia_?pol[ií]tica|prefer[eê]ncia_?(pol[ií]tica|partid[aá]ria|eleitoral)|autoposicionamento_?ideol[oó]gico|escala_?ideol[oó]gica|orienta[cç][aã]o_?pol[ií]tica|tend[eê]ncia_?pol[ií]tica|inten[cç][aã]o_?(de_?)?voto|sentido_?(de_?)?voto|simpatia_?pol[ií]tica|political_?(opinion|orientation|view|preference)|voting_?intention', 0.95]),
  byList([['pt-detetar-opinioes-politicas.txt', [...IDEOLOGIES, 'esquerda', 'direita', 'centro', 'progressista', 'conservador', 'liberal', 'socialista', 'comunista', 'social-democrata', 'apolítico', 'abstenção', 'voto em branco', 'nenhum'], 0.7]], { reject: 0.4 }))

const PARTIES = ['PS', 'PSD', 'Chega', 'IL', 'Livre', 'PCP', 'BE', 'PAN', 'CDS-PP', 'JPP', 'Sem filiação']
categorical('PT_PARTIDO', 'pt-partidos.txt', PARTIES, 'PEV')
domain('PT_L3_FILIACAO_PARTIDARIA', 'PT_PARTIDO',
  byName(['partido(_?pol[ií]tico)?(_?(filia[cç][aã]o|nome|militancia))?|filia[cç][aã]o_?(pol[ií]tica|partid[aá]ria|partido)|milit[aâ]ncia(_?pol[ií]tica)?|militante|quota_?(de_?)?(militante|filiado)|(cod|codigo|nome)_?partido|political_?party|party_?membership', 0.95]),
  byList([['pt-detetar-partidos.txt', [...PARTIES, 'Partido Socialista', 'Partido Social Democrata', 'Iniciativa Liberal', 'Partido Comunista Português', 'CDU', 'Bloco de Esquerda', 'Pessoas-Animais-Natureza', 'CDS', 'Aliança Democrática', 'AD', 'Juntos pelo Povo', 'PEV', 'Os Verdes'], 0.8]], { reject: 0.4 }))

domain('PT_L3_FILIACAO_SINDICAL', 'PT_CATEGORIA_SUPRIMIDA',
  byName(['sindicato(_?(nome|filiado|filia[cç][aã]o|c[oó]digo))?|sindicalizad[oa]|filiado_?sindicato|filia[cç][aã]o_?sindical|quota_?sindical|desconto_?sindical|delegado_?sindical|dirigente_?sindical|comiss[aã]o_?(de_?)?trabalhadores|cr[eé]dito_?(de_?)?horas_?sindical|trade_?union|union_?member(ship)?', 0.95]),
  byList([['pt-detetar-sindicatos.txt', ['CGTP', 'CGTP-IN', 'UGT', 'FENPROF', 'FNE', 'STAL', 'SEP', 'SIM', 'FNAM', 'SINTAP', 'STOP', 'SNESup', 'SBN', 'Mais Sindicato', 'sindicalizado', 'filiado', 'delegado sindical'], 0.6]], { reject: 0.3 }))

// "Dados biométricos para identificar uma pessoa de forma inequívoca" (art. 9.1 RGPD). Article 28.º,
// n.º 6 of Lei n.º 58/2019 lets an employer process its workers' biometric data only for attendance
// and access control, and only as representations whose collection cannot be reversed.
domain('PT_L3_BIOMETRICO', 'PT_REDIGIR',
  byName(['biometria[a-z_]*|biom[eé]trico[a-z_]*|impress[aã]o_?digital(_?(template|modelo|imagem|hash))?|impress[oõ]es_?digitais|dactilar|template_?(facial|digital|biometrico)|modelo_?(facial|biom[eé]trico)|rosto_?(hash|template)|reconhecimento_?(facial|de_?voz)|assinatura_?(biom[eé]trica|digitalizada)|[ií]ris|voz_?(biom[eé]trica|template)|fingerprints?|face_?(template|hash|encoding)|biometric[a-z_]*', 0.9]),
  byType(STRING()))

// Lei n.º 12/2005 makes genetic information the property of the person and forbids its use by
// employers and insurers (arts. 11.º to 13.º).
domain('PT_L3_GENETICO', 'PT_REDIGIR',
  byName(['adn|dna|gen[eé]tic[oa]s?|dados?_?gen[eé]ticos?|informa[cç][aã]o_?gen[eé]tica|genoma|gen[oó]tip[a-z_]*|teste_?(gen[eé]tico|de_?adn|de_?paternidade)|perfil_?gen[eé]tico|muta[cç][aã]o|brca[12]?|cari[oó]tipo|rastreio_?neonatal|teste_?do_?pezinho|genetic[a-z_]*', 0.9]),
  // A nucleotide sequence (IUPAC letters) long enough not to be a word.
  byPattern([[String.raw`[ACGTUN]{24,}`, 0.9]], { reject: 0.3 }))

const ORIENTATIONS = ['Heterossexual', 'Gay', 'Lésbica', 'Bissexual', 'Pansexual', 'Assexual', 'Outra', 'Prefere não responder']
categorical('PT_ORIENTACAO_SEXUAL', 'pt-orientacoes-sexuais.txt', ORIENTATIONS, 'Homossexual')
domain('PT_L3_ORIENTACAO_SEXUAL', 'PT_ORIENTACAO_SEXUAL',
  byName(['orienta[cç][aã]o_?sexual|prefer[eê]ncias?_?sexua(l|is)|(cod|codigo|tipo)_?orienta[cç][aã]o_?sexual|sexual_?orientation', 0.95]),
  byList([['pt-detetar-orientacoes-sexuais.txt', [...ORIENTATIONS, 'hétero', 'homossexual', 'lgbti', 'lgbtqia+', 'queer'], 0.8]], { reject: 0.4 }))

domain('PT_L3_VIDA_SEXUAL', 'PT_CATEGORIA_SUPRIMIDA',
  byName(['vida_?sexual|atividade_?sexual|comportamento_?sexual|pr[aá]ticas?_?sexua(l|is)|parceir[oa]s?_?sexua(l|is)|n(o|r|ro|um|umero)_?parceiros|sexualmente_?ativ[oa]|rela[cç][oõ]es_?sexuais|sex(ual)?_?life|sexual_?(activity|behavio(u)?r|partners)', 0.9]))

// Lei n.º 38/2018 recognises the right to self-determination of gender identity and expression, and
// lets a person change the sex in the civil register by declaration from the age of 18 (16 with
// consent).
const IDENTITIES = ['Mulher cis', 'Homem cis', 'Mulher trans', 'Homem trans', 'Pessoa não binária', 'Outra', 'Prefere não responder']
categorical('PT_IDENTIDADE_GENERO', 'pt-identidades-genero.txt', IDENTITIES, 'Transgénero')
domain('PT_L3_IDENTIDADE_GENERO', 'PT_IDENTIDADE_GENERO',
  byName(['identidade_?(de_?)?g[eé]nero|(cod|codigo|tipo)_?identidade_?g[eé]nero|g[eé]nero_?(sentido|autodeterminado)|express[aã]o_?(de_?)?g[eé]nero|transg[eé]nero|pessoa_?trans|mudan[cç]a_?(de_?)?(sexo|men[cç][aã]o_?do_?sexo)_?(no_?)?registo|nome_?social|pronomes?|gender_?identity', 0.95]),
  byList([['pt-detetar-identidades-genero.txt', [...IDENTITIES, 'cisgénero', 'cis', 'transgénero', 'trans', 'não binário', 'não binária', 'mulher', 'homem'], 0.7]], { reject: 0.4 }))

// Lei n.º 112/2009 gives the victim of domestic violence a status of her own and protects her
// identity; the records of the Comissão para a Cidadania e a Igualdade de Género and of the courts
// carry it.
domain('PT_L3_VITIMA', 'PT_CATEGORIA_SUPRIMIDA',
  byName(['v[ií]tima(_?(de_?)?(viol[eê]ncia(_?(dom[eé]stica|de_?g[eé]nero|sexual|no_?namoro))?|crime|tr[aá]fico|agress[aã]o|ass[eé]dio))?|estatuto_?(de_?)?v[ií]tima|viol[eê]ncia_?(dom[eé]stica|de_?g[eé]nero|sexual|no_?namoro|intrafamiliar)|tipo_?(de_?)?viol[eê]ncia|medida_?(de_?)?(afastamento|prote[cç][aã]o)|teleassist[eê]ncia_?v[ií]tima|casa_?(de_?)?abrigo|tr[aá]fico_?(de_?)?(seres_?humanos|pessoas)', 0.9]))


// ── SAUDE · Health data (art. 9 RGPD, art. 29.º of Lei n.º 58/2019, Lei n.º 12/2005) ──
//
// Article 29.º of Lei n.º 58/2019 puts health and genetic data under the principle of "necessidade de
// conhecer", requires that the data subject be notified of any access to them (n.º 6) and that access
// be logged (n.º 7 c). Article 4.º of Lei n.º 12/2005 asks health units to keep health and genetic
// information apart from the rest of a person's data and lets researchers reach it only anonymized.
// A test copy is neither care nor research: its developers have no need to know.

// The número de utente of the SNS (Decreto-Lei n.º 198/95, Portaria n.º 981/95): nine digits — the
// health region of the first registration (1 Norte … 5 Algarve, 6 Açores, 7 Madeira, 9 registered
// with the Cartão de Cidadão), seven for the person and a check digit by ISO/IEC 7064 MOD 11,10 (the
// Portaria says MOD 11-2, a slip a mathematician of the Universidade dos Açores pointed out). The
// region stays, the seven digits change and the state — what MOD 11,10 carries from one digit to the
// next, 1 to 10 — crosses them and becomes the check digit.
const NNU_STEP = stateRows('PT_UTENTE_PASSO', 'pt-utente-passo.txt', range(1, 10), 2, [...DIGIT_CHARS, ...SEPARATORS], (p, c) => {
  if (!/\d/.test(c)) return p
  const s = (p + Number(c)) % 10 || 10
  return (2 * s) % 11
}, '106')
const NNU_FINAL = cleansing('PT_UTENTE_CONTROLO_TABELA', 'pt-utente-controlo.txt', range(1, 10).map((p) => [`${pad(p, 2)}~`, String((11 - p) % 10)]), '07~')
const NNU_EXAMPLE = '629033874'
const NNU_BACK = pipeline('PT_UTENTE', NNU_EXAMPLE, [
  [(input) => decompose('PT_UTENTE_CORPO', [[String.raw`([1-79])([\s\-.]?\d{3}[\s\-.]?\d{3}[\s\-.]?\d)(\d)`, keep, FIXED_DIGITS, keep]], keep, input), (v) => v],
  [(input) => spaces('PT_UTENTE_MARCAR', ' ', SPACE, input), markSpaces],
  [(input) => decompose('PT_UTENTE_PREPARAR', DIGIT_CHARS.map((d) => [`(${d})(.*)(\\d)`, redactAs(`10${d}`), keep, redactAs('~')]), keep, input),
    (v) => `10${v.slice(0, -1)}~`],
  ...Array.from({ length: 12 }, (_, k) => stepAt(`PT_UTENTE_PASSO_${pad(k, 2)}`, k, 2, NNU_STEP)),
  [(input) => decompose('PT_UTENTE_CONTROLO', [[String.raw`(.*)(\d{2}~)`, keep, apply(NNU_FINAL)]], keep, input),
    (v) => v.replace(/(\d{2})~$/, (_, p) => String((11 - Number(p)) % 10))],
  [(input) => spaces('PT_UTENTE_RESTAURAR', SPACE, ' ', input), restoreSpaces],
])
if (NNU_BACK !== NNU_EXAMPLE) throw new Error(`número de utente: the chain gives ${NNU_BACK}`)
decompose('PT_NUMERO_UTENTE', [[String.raw`([1-79](?:[\s\-.]?\d){8})`, apply('PT_UTENTE')]], CM, NNU_EXAMPLE)
domain('PT_SAUDE_NUMERO_UTENTE', 'PT_NUMERO_UTENTE',
  byName(['n(o|r|ro|um|umero)_?(de_?)?utente(_?(do_?)?(sns|sa[uú]de|servi[cç]os_?de_?sa[uú]de))?|n(o|r|ro|um|umero)_?(nacional_?(de_?)?)?utente|nnu|n_n_u|utente_?sns|cart[aã]o_?(de_?)?utente|rnu|sns_?(id|number|numero)', 0.95]),
  byType(STRING(9), NUMBER(9)))

// The prescription number of the SNS: nineteen digits — the health region first — and a check
// character by ISO/IEC 7064 MOD 11-2, written X for ten. It is the code a patient gets by SMS to
// collect the medicines, and it links the patient to them. The region stays, seventeen digits change
// and the state — 0 to 10 — becomes the check character.
const RX_STEP = stateRows('PT_RECEITA_PASSO', 'pt-receita-passo.txt', range(0, 10), 2, [...DIGIT_CHARS, ...SEPARATORS], (p, c) => (/\d/.test(c) ? ((p + Number(c)) * 2) % 11 : p), '001')
const RX_FINAL = cleansing('PT_RECEITA_CONTROLO_TABELA', 'pt-receita-controlo.txt', range(0, 10).map((p) => [`${pad(p, 2)}~`, (12 - p) % 11 === 10 ? 'X' : String((12 - p) % 11)]), '05~')
const RX_EXAMPLE = `101000012345678901${mod112('101000012345678901')}`
const RX_BACK = pipeline('PT_RECEITA', RX_EXAMPLE, [
  [(input) => decompose('PT_RECEITA_CORPO', [[String.raw`([1-7])(\d{17})([\dXx])`, keep, FIXED_DIGITS, keep]], keep, input), (v) => v],
  [(input) => decompose('PT_RECEITA_PREPARAR', DIGIT_CHARS.map((d) => [`(${d})(.*)([\\dXx])`, redactAs(`00${d}`), keep, redactAs('~')]), keep, input),
    (v) => `00${v.slice(0, -1)}~`],
  ...Array.from({ length: 18 }, (_, k) => stepAt(`PT_RECEITA_PASSO_${pad(k, 2)}`, k, 2, RX_STEP)),
  [(input) => decompose('PT_RECEITA_CONTROLO', [[String.raw`(.*)(\d{2}~)`, keep, apply(RX_FINAL)]], keep, input),
    (v) => v.replace(/(\d{2})~$/, (_, p) => ((12 - Number(p)) % 11 === 10 ? 'X' : String((12 - Number(p)) % 11)))],
])
if (RX_BACK !== RX_EXAMPLE) throw new Error(`receita: the chain gives ${RX_BACK}`)
decompose('PT_NUMERO_RECEITA', [[String.raw`([1-7]\d{17}[\dXx])`, apply('PT_RECEITA')]], CM, RX_EXAMPLE)
domain('PT_SAUDE_RECEITA', 'PT_NUMERO_RECEITA',
  byName(['n(o|r|ro|um|umero)_?(da_?)?receita(_?(m[eé]dica|eletr[oó]nica))?|receita_?(m[eé]dica|eletr[oó]nica|sem_?papel)|c[oó]digo_?(de_?)?(acesso_?e_?)?dispensa|c[oó]digo_?(da_?)?receita|prescri[cç][aã]o_?(n(o|r|ro|um|umero)|id)|prescription_?(id|number)', 0.9]),
  byPattern([[String.raw`[1-7]\d{17}[\dX]`, 0.6]], { reject: 0.3 }))

// A health subsystem's number — the ADSE of the civil servants, the SAD of the police and the GNR,
// the ADM of the armed forces, the SAMS of the bank workers — and the numbers of a hospital: the
// processo clínico, the episode, the appointment.
domain('PT_SAUDE_IDENTIFICADOR', 'PT_CM_ALFANUM',
  byName(
    ['n(o|r|ro|um|umero)_?(de_?)?(processo(_?cl[ií]nico)?|epis[oó]dio|internamento|atendimento|consulta|benefici[aá]rio_?(adse|sad|adm|sams)|adse|sams)|processo_?cl[ií]nico|n_?processo|n(o|r|ro)_?benef|adse_?(n(o|r|ro|um|umero)|id)|id_?(utente|doente|paciente)|c[oó]digo_?(utente|doente|epis[oó]dio)|sclinico_?id|patient_?id|medical_?record_?(no|number)', 0.85],
    ['processo|epis[oó]dio|internamento|consulta', 0.55],
  ))

const COVERAGE = ['SNS', 'ADSE - titular', 'ADSE - beneficiário familiar', 'SAD/GNR', 'SAD/PSP', 'ADM', 'SAMS', 'Seguro de saúde privado', 'Sem subsistema']
decompose('PT_COBERTURA_SAUDE', [
  [FLAG, apply('PT_INDICADOR')],
  [String.raw`(\d{1,8})`, DIGITS],
], apply(lookup('PT_COBERTURA', 'pt-cobertura-saude.txt', COVERAGE, undefined, 'PRESERVE_LOOKUP_FILE')), 'ADSE - titular')
domain('PT_SAUDE_SUBSISTEMA', 'PT_COBERTURA_SAUDE',
  byName(['subsistema(_?(de_?)?sa[uú]de)?|entidade_?(financeira_?)?respons[aá]vel|efr|tipo_?(de_?)?(benefici[aá]rio|cobertura|seguro)|seguro_?(de_?)?sa[uú]de|seguradora_?(de_?)?sa[uú]de|plano_?(de_?)?sa[uú]de|cobertura(_?(de_?)?sa[uú]de)?|adse|sams|insurance_?(type|plan)|health_?insurance', 0.85]),
  byList([['pt-detetar-cobertura.txt', [...COVERAGE, 'sns', 'adse', 'sad', 'adm', 'sams', 'médis', 'multicare', 'advancecare', 'seguro privado', 'sem subsistema'], 0.8]], { reject: 0.4 }))

// Hospitals code diagnoses in ICD-10-CM since 2017 and primary care in ICPC-2: both write a letter and
// two digits, and the lookups keep that shape.
const ICD10 = ['I10', 'E11', 'E78', 'J45', 'J06', 'J02', 'J20', 'K29', 'K21', 'K59', 'M54', 'M17', 'M25', 'N39', 'N20', 'R51', 'R10', 'H10', 'H66', 'L23', 'L30', 'B34', 'A09', 'E03', 'E66', 'D50', 'I83', 'K80', 'K40', 'S93', 'S60', 'Z00', 'J30', 'J32', 'G43', 'M79', 'R05', 'K86', 'T90', 'A97', 'R74', 'L03', 'P76', 'K87', 'T93', 'D73']
const ICD10_DECIMAL = ['E11.9', 'E78.5', 'J45.909', 'J06.9', 'J02.9', 'J20.9', 'K29.70', 'K21.9', 'K59.00', 'M54.5', 'M17.9', 'N39.0', 'N20.0', 'R10.9', 'H10.9', 'H66.90', 'L23.9', 'L30.9', 'B34.9', 'A09', 'E03.9', 'E66.9', 'D50.9', 'I83.90', 'K80.20', 'K40.90', 'S93.409A', 'Z00.00', 'J30.9', 'J32.9', 'G43.909', 'M79.1', 'R05']
decompose('PT_DIAGNOSTICO', [
  [String.raw`([A-Za-z]\d{2}\.[\dA-Za-z]{1,4})`, apply(lookup('PT_CID10_DECIMAL', 'pt-cid10-decimal.txt', ICD10_DECIMAL, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [String.raw`([A-Za-z]\d{2,3}X?)`, apply(lookup('PT_CID10', 'pt-cid10.txt', ICD10, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [FLAG, apply('PT_INDICADOR')],
], apply(lookup('PT_DIAGNOSTICO_TEXTO', 'pt-diagnosticos.txt', ['Hipertensão arterial', 'Diabetes mellitus tipo 2', 'Asma', 'Lombalgia', 'Gastrite crónica', 'Faringite aguda', 'Infeção urinária', 'Enxaqueca', 'Hipotiroidismo', 'Dislipidemia', 'Obesidade', 'Artrose do joelho', 'Bronquite aguda', 'Amigdalite aguda', 'Dermatite de contacto', 'Otite média aguda', 'Entorse do tornozelo', 'Conjuntivite', 'Anemia ferropénica', 'Refluxo gastroesofágico', 'Síndrome do intestino irritável', 'Tendinite', 'Sinusite aguda', 'Cefaleia de tensão', 'Varizes', 'Hérnia inguinal', 'Litíase renal', 'Colelitíase', 'Gastroenterite aguda', 'Consulta de vigilância'])), 'F33.1')
domain('PT_SAUDE_DIAGNOSTICO', 'PT_DIAGNOSTICO',
  byName(['diagn[oó]stico[a-z_]*|dx(_?(principal|secund[aá]rio|admiss[aã]o|alta)[0-9]?)?|cid_?10|icd_?(10|11)?(_?cm)?|icpc(_?2)?|ciap(_?2)?|(cod|codigo)_?(diagn[oó]stico|dx|cid|icd|icpc)|doen[cç]a(s)?[a-z_]*|patologia|comorbilidade(s)?|antecedentes?_?(m[eé]dicos|patol[oó]gicos|cl[ií]nicos|pessoais|familiares)|causa_?(de_?)?(morte|[oó]bito|baixa|internamento)|motivo_?(de_?|da_?)?(consulta|baixa|internamento)|alergias?|problema_?(de_?)?sa[uú]de|diagnosis|diagnos(is|es)', 0.85]),
  byPattern([[String.raw`[A-TV-Za-tv-z]\d{2}(\.[\dA-Za-z]{1,4}|\d|X)?`, 0.5]], { reject: 0.3 }))

// Procedures in ICD-10-PCS: seven characters, digits and letters but neither I nor O.
decompose('PT_PROCEDIMENTO', [
  [String.raw`([0-9A-HJ-NP-Z]{7})`, apply('PT_CM_DIGITOS_LETRAS')],
  [String.raw`(\d{4,6})`, DIGITS],
], apply(lookup('PT_PROCEDIMENTO_TEXTO', 'pt-procedimentos.txt', ['Consulta de medicina geral e familiar', 'Consulta de urgência', 'Hemograma completo', 'Glicemia em jejum', 'Análise sumária de urina', 'Creatinina sérica', 'Radiografia do tórax', 'Ecografia abdominal', 'Eletrocardiograma', 'Consulta de saúde materna'])), 'Carga viral do VIH')
domain('PT_SAUDE_PROCEDIMENTO', 'PT_PROCEDIMENTO',
  byName(['procedimento(_?(m[eé]dico|cir[uú]rgico|realizado|autorizado))?|(cod|codigo)_?(procedimento|ato_?m[eé]dico|interven[cç][aã]o|mcdt)|ato_?m[eé]dico|mcdt|exame_?(complementar|realizado|requisitado)|interven[cç][aã]o_?cir[uú]rgica|cirurgia(_?realizada)?|t[eé]cnica_?(diagn[oó]stica|cir[uú]rgica)|medical_?procedure', 0.85]))

const MEDICATIONS = ['Paracetamol', 'Ibuprofeno', 'Metamizol', 'Omeprazol', 'Pantoprazol', 'Metformina', 'Enalapril', 'Losartan', 'Amlodipina', 'Atorvastatina', 'Sinvastatina', 'Levotiroxina', 'Amoxicilina', 'Amoxicilina + ácido clavulânico', 'Azitromicina', 'Salbutamol', 'Loratadina', 'Hidroclorotiazida', 'Ácido acetilsalicílico', 'Prednisolona', 'Diclofenac', 'Ácido fólico', 'Colecalciferol']
categorical('PT_MEDICAMENTO', 'pt-medicamentos.txt', MEDICATIONS, 'Sertralina 50 mg')
domain('PT_SAUDE_MEDICAMENTO', 'PT_MEDICAMENTO',
  byName(['medicamentos?(_?(prescrito|dispensado|nome|ativo))?|f[aá]rmacos?|subst[aâ]ncia_?ativa|dci|cnpem|c[oó]digo_?(do_?)?medicamento|n(o|r|ro)_?registo_?medicamento|posologia|terap[eê]utica(_?(atual|cr[oó]nica|farmacol[oó]gica))?|tratamento_?(farmacol[oó]gico|atual|cr[oó]nico)|medication(s)?|drugs?_?prescribed', 0.85]),
  byList([['pt-detetar-medicamentos.txt', [...MEDICATIONS, 'paracetamol', 'ben-u-ron', 'sertralina', 'fluoxetina', 'escitalopram', 'paroxetina', 'quetiapina', 'lorazepam', 'alprazolam', 'diazepam', 'lítio', 'metilfenidato', 'risperidona', 'olanzapina', 'haloperidol', 'tenofovir', 'emtricitabina', 'dolutegravir', 'insulina', 'varfarina', 'levetiracetam', 'ácido valpróico', 'misoprostol', 'levonorgestrel', 'contracetivo', 'metadona', 'buprenorfina'], 0.7]], { reject: 0.3 }))

domain('PT_SAUDE_TEXTO_CLINICO', 'PT_TEXTO_LIVRE',
  byName(['anamnese|hist[oó]ria_?cl[ií]nica|di[aá]rio_?cl[ií]nico|evolu[cç][aã]o(_?(m[eé]dica|cl[ií]nica|de_?enfermagem))?|exame_?objetivo|plano_?(de_?)?(tratamento|cuidados)|nota_?(de_?)?alta|carta_?(de_?)?alta|relat[oó]rio_?(m[eé]dico|cl[ií]nico|de_?alta|radiol[oó]gico|anatomopatol[oó]gico)|notas?_?(m[eé]dicas|cl[ií]nicas|de_?enfermagem)|triagem(_?texto)?|soap|clinical_?notes?|discharge_?summary', 0.85]),
  byType(STRING(30)))

domain('PT_SAUDE_RESULTADO_EXAME', 'PT_CM_ALFANUM',
  byName(
    ['resultado_?(do_?)?(exame|an[aá]lise|teste|laborat[oó]rio|pcr|serologia|bi[oó]psia|citologia)|(exame|an[aá]lise|teste)_?(resultado|laborat[oó]rio)|glicemia|glicose|hemoglobina(_?glicada)?|hba1c|colesterol(_?(total|hdl|ldl))?|imc|tens[aã]o_?arterial|teste_?(de_?)?gravidez|espirometria|taxa_?(de_?)?alcoolemia|lab_?results?|test_?results?', 0.8],
    ['resultado|exame|analise', 0.5],
  ))

// HIV and the other sexually transmitted infections: the status that most often turns into
// discrimination.
domain('PT_SAUDE_VIH', 'PT_CATEGORIA_SUPRIMIDA',
  byName(['vih(_?(estado|resultado|teste|diagn[oó]stico|positivo))?|hiv|sida|aids|serologia_?(vih|hiv)|estado_?serol[oó]gico|carga_?viral|cd4|tarv|terap[eê]utica_?antirretroviral|antirretrovira(l|is)|prep|profilaxia_?pr[eé]_?exposi[cç][aã]o|ist|ists|infe[cç][aã]o(es|[oõ]es)?_?sexualmente_?transmiss[ií]ve(l|is)|s[ií]filis|hepatite_?[bc]|tuberculose', 0.9]))

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']
domain('PT_SAUDE_GRUPO_SANGUINEO', ENGINE.BLOOD_TYPE,
  byName(['grupo_?sangu[ií]neo|tipo_?(de_?)?sangue|rh|fator_?rh|grupo_?rh|abo(_?rh)?|blood_?(type|group)', 0.9]),
  byList([['pt-detetar-grupos-sanguineos.txt', [...BLOOD_GROUPS, '0+', '0-', 'a positivo', 'a negativo', 'b positivo', 'b negativo', 'ab positivo', 'ab negativo', 'o positivo', 'o negativo'], 0.9]], { reject: 0.4 }))

// The Atestado Médico de Incapacidade Multiuso states a degree under the Tabela Nacional de
// Incapacidades; 60% opens the tax and social benefits of a person with disability.
const DISABILITIES = ['Motora', 'Orgânica', 'Visual', 'Auditiva', 'Intelectual', 'Psicossocial', 'Múltipla', 'Sem incapacidade reconhecida']
categorical('PT_INCAPACIDADE', 'pt-incapacidades.txt', DISABILITIES, 'Perturbação do espetro do autismo')
domain('PT_SAUDE_INCAPACIDADE', 'PT_INCAPACIDADE',
  byName(['incapacidade(_?(grau|percentagem|tipo))?|defici[eê]ncia[a-z_]*|(tipo|cod|codigo|grau|percentagem)_?(de_?)?(incapacidade|defici[eê]ncia)|atestado_?(m[eé]dico_?)?(de_?)?incapacidade(_?multiuso)?|amim|pessoa_?com_?defici[eê]ncia|mobilidade_?reduzida|necessidades_?(de_?sa[uú]de_?)?especiais|nee|disabilit(y|ies)', 0.9]),
  byList([['pt-detetar-incapacidades.txt', [...DISABILITIES, 'motora', 'física', 'orgânica', 'visual', 'cegueira', 'auditiva', 'surdez', 'intelectual', 'mental', 'psicossocial', 'múltipla', 'autismo', 'nenhuma', 'não'], 0.6]], { reject: 0.3 }))

// The complemento por dependência of the Segurança Social has two degrees, and the Estatuto do
// Cuidador Informal (Lei n.º 100/2019) hangs from it: a datum on health, and on the household beside it.
const DEPENDENCY = ['Dependência de 1.º grau', 'Dependência de 2.º grau', 'Sem dependência reconhecida', 'Em avaliação']
categorical('PT_DEPENDENCIA', 'pt-dependencia.txt', DEPENDENCY, 'Acamado', ['1', '2'])
domain('PT_SAUDE_DEPENDENCIA', 'PT_DEPENDENCIA',
  byName(['depend[eê]ncia(_?(grau|reconhecida|avalia[cç][aã]o))?|grau_?(de_?)?depend[eê]ncia|complemento_?(por_?)?depend[eê]ncia|cuidador_?informal|estatuto_?(do_?)?cuidador|apoio_?domicili[aá]rio|cuidados_?continuados|rncci|teleassist[eê]ncia', 0.9]),
  byList([['pt-detetar-dependencia.txt', [...DEPENDENCY, '1.º grau', '2.º grau', 'dependente', 'acamado', 'sem dependência'], 0.7]], { reject: 0.3 }))

// Lei n.º 102/2009 lets occupational medicine tell the employer only whether a worker is fit, and the
// Código do Trabalho (art. 17.º and 19.º) keeps health and medical tests from the employer; the sick
// leave certificate (CIT) carries the diagnosis behind it.
categorical('PT_APTIDAO', 'pt-aptidao.txt', ['Apto', 'Apto condicionalmente', 'Inapto temporariamente', 'Inapto definitivamente'], 'Inapto para trabalho noturno')
domain('PT_SAUDE_TRABALHO', 'PT_APTIDAO',
  byName(['aptid[aã]o_?(m[eé]dica|para_?o_?trabalho)?|ficha_?(de_?)?aptid[aã]o|medicina_?(do_?)?trabalho|sa[uú]de_?(no_?|do_?)?trabalho|exame_?(de_?)?(admiss[aã]o|peri[oó]dico|ocasional)|acidente_?(de_?)?trabalho|doen[cç]a_?profissional|incapacidade_?(tempor[aá]ria|permanente)|cit|certificado_?(de_?)?incapacidade_?tempor[aá]ria|baixa(_?(m[eé]dica|por_?doen[cç]a))?|dias_?(de_?)?baixa|absentismo', 0.85]),
  byList([['pt-detetar-aptidao.txt', ['apto', 'inapto', 'apto condicionalmente', 'inapto temporariamente', 'inapto definitivamente', 'baixa médica', 'acidente de trabalho', 'doença natural', 'doença profissional'], 0.6],
    ['pt-detetar-codigos-indicadores.txt', ['s', 'n', 'sim', 'não', '1', '2', '3', '4', '5', '6', '7', '8', '9'], 0.3],
  ], { reject: 0.3 }))

domain('PT_SAUDE_REPRODUTIVA', 'PT_CATEGORIA_SUPRIMIDA',
  byName(['gravidez|gr[aá]vida|gestante|gesta[cç][aã]o|idade_?gestacional|semanas_?(de_?)?gesta[cç][aã]o|dum|data_?([uú]ltima_?)?menstrua[cç][aã]o|vigil[aâ]ncia_?(da_?)?gravidez|pr[eé]_?natal|parto(_?tipo)?|ces[aá]riana|ivg|interrup[cç][aã]o_?(volunt[aá]ria_?)?(da_?)?gravidez|aborto|m[eé]todo_?contracetivo|contrace[cç][aã]o|planeamento_?familiar|pma|procria[cç][aã]o_?medicamente_?assistida|fertiliza[cç][aã]o_?in_?vitro|fiv|sa[uú]de_?(sexual|reprodutiva)|pregnan(t|cy)|contracepti(on|ve)', 0.9]))

domain('PT_SAUDE_MENTAL', 'PT_CATEGORIA_SUPRIMIDA',
  byName(['sa[uú]de_?mental|perturba[cç][aã]o[a-z_]*|psiqui[aá]tri[a-z_]*|psicol[oó]gi[a-z_]*|depress[aã]o|ansiedade|suic[ií]d[a-z_]*|tentativa_?(de_?)?suic[ií]dio|autoles[aã]o|comportamento_?suicida|consumo_?(de_?)?(subst[aâ]ncias|[aá]lcool|drogas)|adi[cç][oõ]es|toxicodepend[eê]ncia|alcoolismo|tabagismo|jogo_?patol[oó]gico|cri|dicad|internamento_?compulsivo|mental_?health', 0.9]))


// ── FIN · Economic data (art. 64.º LGT) ─────────────────────────────────────
//
// The Central de Responsabilidades de Crédito of the Banco de Portugal holds every loan of every
// borrower, and the PERSI (Decreto-Lei n.º 227/2012) the procedure a bank must follow before it
// sues for a defaulted consumer loan. Article 64.º of the Lei Geral Tributária binds everyone at the
// Autoridade Tributária to secrecy about a taxpayer's tax situation. Financial data are not a special
// category, but they are what the CNPD sees most often in breaches, and a salary beside a concelho
// identifies.

decompose('PT_HISTORICO_CREDITO', [
  [String.raw`(\d{1,4})`, DIGITS],
  [FLAG, apply('PT_INDICADOR')],
], apply(lookup('PT_ESTADO_CREDITO', 'pt-estados-credito.txt', ['Sem incidentes', 'Crédito vencido', 'Em incumprimento', 'Em PERSI', 'Crédito reestruturado', 'Insolvência declarada', 'Plano de pagamentos aprovado', 'Regularizado', 'Abatido ao ativo', 'Sem histórico'])), 'Incluído na lista de devedores')
domain('PT_FIN_CREDITO', 'PT_HISTORICO_CREDITO',
  byName(['hist[oó]rico_?(de_?)?cr[eé]dito|crc|central_?(de_?)?responsabilidades_?(de_?)?cr[eé]dito|mapa_?(de_?)?responsabilidades|persi|incumprimento|cr[eé]dito_?(vencido|malparado)|scoring(_?(de_?)?cr[eé]dito)?|score(_?cr[eé]dito)?|rating_?(de_?)?cr[eé]dito|nota[cç][aã]o_?(de_?)?risco|classe_?(de_?)?risco|dias_?(de_?)?(atraso|incumprimento|mora)|devedor_?(relapso|em_?mora)|insolv[eê]ncia(_?pessoal)?|per|peap|lista_?(negra|de_?devedores)|credit_?score|credit_?rating', 0.9]))

// Amounts in euros. The engine's CM Numeric keeps the number of digits, the sign and the decimals.
domain('PT_FIN_DIVIDA', ENGINE.CM_NUMERIC,
  byName(['saldo_?(devedor|em_?d[ií]vida|em_?atraso|cr[eé]dito|empr[eé]stimo|hipoteca)|montante_?(da_?)?(d[ií]vida|presta[cç][aã]o|empr[eé]stimo|cr[eé]dito|penhora|financiado)|d[ií]vida(_?total)?|capital_?(em_?d[ií]vida|em_?falta)|plafond|limite_?(de_?)?(cr[eé]dito|cart[aã]o)|presta[cç][aã]o_?(mensal|cr[eé]dito|habita[cç][aã]o)|penhora(_?(montante|valor))?|loan_?(amount|balance)|outstanding_?balance|debt', 0.85]),
  byType(NUMBER()))

domain('PT_FIN_RENDIMENTO', ENGINE.CM_NUMERIC,
  byName(['vencimento(_?(base|bruto|l[ií]quido|mensal|anual))?|sal[aá]rio(_?(base|bruto|l[ií]quido|mensal|anual))?|ordenado(_?(base|bruto|l[ií]quido))?|remunera[cç][aã]o(_?(base|bruta|l[ií]quida|anual|mensal))?|rendimentos?(_?(mensal|anual|total|familiar|l[ií]quido|bruto|do_?agregado|per_?capita))?|retribui[cç][aã]o|salary|income|wages?', 0.85]),
  byType(NUMBER()))

domain('PT_FIN_PATRIMONIO', ENGINE.CM_NUMERIC,
  byName(['patrim[oó]nio(_?(l[ií]quido|total))?|valor_?patrimonial(_?tribut[aá]vel)?|vpt|valor_?(de_?)?(avalia[cç][aã]o|mercado|do_?im[oó]vel|da_?habita[cç][aã]o|do_?ve[ií]culo)|saldo_?(conta|poupan[cç]a|dep[oó]sito|m[eé]dio)|dep[oó]sitos?(_?a_?prazo)?|aplica[cç][oõ]es_?financeiras|carteira_?(de_?)?t[ií]tulos|fundos?_?(de_?)?(investimento|pens[oõ]es)|ppr|net_?worth|account_?balance', 0.85]),
  byType(NUMBER()))

domain('PT_FIN_PENSAO', ENGINE.CM_NUMERIC,
  byName(['pens[aã]o(_?(montante|valor|mensal|anual|velhice|invalidez|sobreviv[eê]ncia|alimentos|social))?|reforma_?(montante|valor)|montante_?(da_?)?(pens[aã]o|presta[cç][aã]o|subs[ií]dio)|valor_?(da_?)?(pens[aã]o|presta[cç][aã]o|subs[ií]dio)|pension_?amount', 0.9]),
  byType(NUMBER()))

const BENEFITS = ['Rendimento Social de Inserção', 'Subsídio de desemprego', 'Subsídio social de desemprego', 'Abono de família', 'Complemento Solidário para Idosos', 'Prestação Social para a Inclusão', 'Garantia para a Infância', 'Tarifa social de energia', 'Ação Social Escolar - escalão A', 'Ação Social Escolar - escalão B', 'Bolsa de estudo', 'Nenhuma']
categorical('PT_PRESTACAO_SOCIAL', 'pt-prestacoes-sociais.txt', BENEFITS, 'Apoio extraordinário à renda')
domain('PT_FIN_PRESTACAO_SOCIAL', 'PT_PRESTACAO_SOCIAL',
  byName(['presta[cç][aã]o(_?(social|de_?desemprego))?|subs[ií]dio(_?(de_?desemprego|social|de_?doen[cç]a|parental))?|rendimento_?social_?(de_?)?inser[cç][aã]o|rsi|abono(_?(de_?)?fam[ií]lia)?|escal[aã]o_?(do_?)?(abono|ase|a[cç][aã]o_?social)|complemento_?solid[aá]rio|csi|presta[cç][aã]o_?social_?(para_?a_?)?inclus[aã]o|psi|tarifa_?social|a[cç][aã]o_?social_?escolar|ase|bolsa(_?(de_?)?estudo)?|benefici[aá]rio_?(rsi|abono|subs[ií]dio|bolsa)|apoio_?(social|[aà]_?renda|extraordin[aá]rio)|vulnerabilidade|car[eê]ncia_?econ[oó]mica|social_?benefit', 0.9]),
  byList([['pt-detetar-prestacoes-sociais.txt', [...BENEFITS, 'rsi', 'desemprego', 'subsídio', 'abono', 'csi', 'psi', 'tarifa social', 'escalão a', 'escalão b', 'bolsa', 'nenhuma'], 0.8],
    ['pt-detetar-codigos-indicadores.txt', ['s', 'n', 'sim', 'não', '1', '2', '3', '4', '5', '6', '7', '8', '9'], 0.3],
  ], { reject: 0.4 }))

// Tax data: a taxable income, a collection or the result of a return. A refund keeps its sign, and
// cents stay cents.
decompose('PT_FISCAL', [
  [String.raw`(-?)(\d+)([.,]\d{1,2})`, keep, apply(ENGINE.CM_NUMERIC), keep],
  [String.raw`(-?)(\d+)`, keep, apply(ENGINE.CM_NUMERIC)],
], keep, '-1240.55')
domain('PT_FIN_FISCAL', 'PT_FISCAL',
  byName(['irs(_?(rendimento|coleta|reembolso|liquida[cç][aã]o|reten[cç][aã]o|montante|a_?pagar))?|rendimento_?(coletável|colet[aá]vel|global|tribut[aá]vel)|mat[eé]ria_?colet[aá]vel|coleta(_?(l[ií]quida|total))?|reembolso_?(de_?)?irs|nota_?(de_?)?liquida[cç][aã]o|modelo_?(3|10|22)|imi(_?(valor|montante))?|reten[cç][aã]o_?na_?fonte|dedu[cç][oõ]es_?([aà]_?)?coleta|escal[aã]o_?(de_?)?irs|tax_?(base|return|amount)', 0.9]))


// ── PENAL · Offences (art. 10 RGPD and art. 13.º b) of Lei n.º 58/2019) ─────
//
// Portugal reads article 10 of the Regulamento as reaching contraordenações too: article 13.º b) of
// Lei n.º 58/2019 speaks of "dados pessoais relacionados com condenações penais e contraordenacionais".
// The criminal record is kept by the Direção-Geral da Administração da Justiça under Lei n.º 37/2015,
// which cancels an entry after five to ten years; a copy keeps it for as long as the copy lives.

categorical('PT_REGISTO_CRIMINAL', 'pt-registo-criminal.txt', ['Sem registo criminal', 'Com registo criminal', 'Registo cancelado', 'Processo pendente', 'Condenação', 'Absolvição', 'Arquivamento', 'Sem informação'], 'Condenado por furto em 2019')
domain('PT_PENAL_REGISTO_CRIMINAL', 'PT_REGISTO_CRIMINAL',
  byName(
    ['registo_?criminal|certificado_?(de_?)?registo_?criminal|crc_?(pessoa|individual)|antecedentes(_?(criminais|penais|policiais))?|cadastro(_?criminal)?|reincid[eê]ncia|condena[cç][aã]o(_?(penal|tipo))?|crime(_?(tipo|cometido|praticado))?|tipo_?(de_?)?crime|situa[cç][aã]o_?(penal|processual|prisional)|medida_?(de_?)?coa[cç][aã]o|pris[aã]o_?preventiva|recluso|estabelecimento_?prisional|liberdade_?condicional|pulseira_?eletr[oó]nica|criminal_?record', 0.95],
    ['estado_?(do_?)?processo|senten[cç]a|ac[oó]rd[aã]o|decis[aã]o_?judicial', 0.55],
  ))

// Lei n.º 113/2009 obliges whoever hires for work with regular contact with minors to ask for the
// candidate's criminal record certificate, and Lei n.º 103/2015 created the register of those
// convicted of crimes against the sexual self-determination of minors. Schools, clubs and companies
// keep the column — and its value is a criminal-record datum.
categorical('PT_CERTIFICADO_MENORES', 'pt-certificado-menores.txt', ['Certificado apresentado', 'Certificado pendente', 'Certificado caducado', 'Não apresentado', 'Dispensado'], 'Certificado com averbamento')
domain('PT_PENAL_CERTIFICADO_MENORES', 'PT_CERTIFICADO_MENORES',
  byName(['certificado_?(de_?)?registo_?criminal_?(para_?)?(fins_?de_?)?(contacto|trabalho)_?com_?menores|crc_?menores|lei_?113_?2009|registo_?(de_?)?(identifica[cç][aã]o_?criminal_?de_?)?condenados_?(por_?crimes_?)?(contra_?a_?)?(autodetermina[cç][aã]o_?sexual)?|crimes?_?sexua(l|is)(_?(contra_?)?menores)?|abuso_?sexual_?(de_?)?menores', 0.95]),
  byList([['pt-detetar-certificado-menores.txt', ['certificado apresentado', 'apresentado', 'não apresentado', 'pendente', 'caducado', 'dispensado', 'sem averbamento', 'com averbamento'], 0.6]], { reject: 0.3 }))

// A criminal case carries its NUIPC, `123/24.5PBLSB` — the number, the year, a control digit and the
// code of the police body and the place —, and a court case a number written the same way,
// `1234/23.0T8LSB`. The number changes; the year, the control digit and the code stay. The rule of the
// control digit is not public, so the masked number no longer passes it.
decompose('PT_PROCESSO', [
  [String.raw`(\d{1,7})(/\d{2}\.\d[A-Z0-9]{2,8})`, DIGITS, keep],
  [String.raw`(\d{1,7})(/\d{2,4})`, DIGITS, keep],
], CM, '123/24.5PBLSB')
domain('PT_PENAL_PROCESSO', 'PT_PROCESSO',
  byName(
    ['nuipc|n_u_i_p_c|n(o|r|ro|um|umero)_?([uú]nico_?)?(de_?)?(identifica[cç][aã]o_?(do_?)?)?processo(_?(crime|judicial|penal|inqu[eé]rito))?|processo_?(crime|judicial|penal|de_?inqu[eé]rito)|inqu[eé]rito(_?(n(o|r|ro|um|umero)))?|auto_?(de_?)?not[ií]cia|n(o|r|ro)_?auto', 0.9],
    ['processo|autos', 0.5],
  ),
  byPattern([[String.raw`\d{1,7}/\d{2}\.\d[A-Z0-9]{2,8}`, 0.9]], { reject: 0.3 }))

// Traffic offences under the Código da Estrada — the points of the driving licence (twelve, since
// 2016), the inhibition from driving — and the other contraordenações.
categorical('PT_CONTRAORDENACAO', 'pt-contraordenacoes.txt', ['Sem contraordenações', 'Contraordenação leve', 'Contraordenação grave', 'Contraordenação muito grave', 'Perda de pontos', 'Inibição de conduzir', 'Cassação da carta', 'Em impugnação', 'Prescrita'], 'Coima por excesso de velocidade')
domain('PT_PENAL_CONTRAORDENACAO', 'PT_CONTRAORDENACAO',
  byName(['contraordena[cç][aã]o(es|[oõ]es)?(_?(tipo|grau|rodovi[aá]ria))?|coima(s)?(_?(montante|valor|tipo))?|auto_?(de_?)?contraordena[cç][aã]o|infra[cç][aã]o(es|[oõ]es)?_?(rodovi[aá]ria|estradal|tr[aâ]nsito)|multa(s)?(_?(tr[aâ]nsito|montante))?|pontos_?(da_?)?carta|saldo_?(de_?)?pontos|perda_?(de_?)?pontos|inibi[cç][aã]o_?(de_?)?conduzir|cassa[cç][aã]o_?(da_?)?carta|administrative_?(sanction|penalty)|traffic_?fine', 0.9]))


// ── Preset ──────────────────────────────────────────────────────────────────

const referenced = JSON.stringify([domains, algorithms.map((x) => x.config)])
const orphans = algorithms.filter((a) => !referenced.includes(`"${a.name}"`))
if (orphans.length) throw new Error(`algorithms nobody uses: ${orphans.map((a) => a.name).join(', ')}`)
const noInput = algorithms.filter((a) => a.input === undefined)
if (noInput.length) throw new Error(`algorithms without a sample input: ${noInput.map((a) => a.name).join(', ')}`)

// The essential pack: the four numbers of the Cartão de Cidadão, the passport and the residence
// permit, names, contact, address and birth date. Loading it brings these domains and only what they
// lean on; the extended pack is everything.
const ESSENTIAL = [
  'PT_L1_CARTAO_CIDADAO', 'PT_L1_NIF', 'PT_L1_NISS', 'PT_SAUDE_NUMERO_UTENTE', 'PT_L1_PASSAPORTE', 'PT_L1_TITULO_RESIDENCIA',
  'PT_L1_NOME', 'PT_L1_APELIDO', 'PT_L1_NOME_COMPLETO',
  'PT_L1_EMAIL', 'PT_L1_TELEFONE', 'PT_L1_MORADA', 'PT_L1_MORADA_COMPLEMENTO',
  'PT_L2_DATA_NASCIMENTO',
]
const notDomains = ESSENTIAL.filter((name) => !domains.some((d) => d.name === name))
if (notDomains.length) throw new Error(`essential pack names domains the set does not have: ${notDomains.join(', ')}`)

// The version and the day it was built: bump both whenever anything in the set changes, so that
// whoever loaded an older one can see how old it is.
const VERSION = 1
const VERSION_DATE = '2026-10-12'
// Zeros on the left are padding only in the value a column holds — the top of a domain's tree. Inside
// it, a step may read a digit at a fixed position, and an optional zero would shift what it reads.
for (const d of domains) {
  const top = algorithms.find((a) => a.name === d.algorithm)
  if (top?.framework === 'algorithm.plugin.decompose.RegexDecompose') {
    top.config.maskPatterns = top.config.maskPatterns.map(({ regex, actions }) => keepingZeros(regex, actions))
  }
}
const preset = {
  version: VERSION,
  versionDate: VERSION_DATE,
  // Where the law applies, for grouping the list of presets: a region id and the ISO 3166 country code.
  region: 'europe',
  country: 'PT',
  name: {
    en: 'Portugal — GDPR and Lei n.º 58/2019',
    'pt-BR': 'Portugal — RGPD e Lei n.º 58/2019',
    es: 'Portugal — RGPD y Lei n.º 58/2019',
  },
  summary: {
    en: 'Discovers and masks Portuguese personal data under the General Data Protection Regulation and Lei n.º 58/2019, which ensures its execution: direct identifiers (the four numbers of the Cartão de Cidadão — civil identification and document number, NIF, NISS and número de utente — with valid check characters, passport, residence permit, names, contact, address, the IBAN and NIB and the CPE of a supply point with valid check characters, plates), quasi-identifiers (birth date, concelho, freguesia, their codes and postal code generalized below 20,000 inhabitants, nationality and residence status), the special categories of article 9 and of article 35 of the Constitution, health data under article 29 of the law and Lei n.º 12/2005, credit and the tax data article 64 of the Lei Geral Tributária keeps confidential, and criminal records, certificates for work with minors and contraordenações.',
    'pt-BR': 'Descobre e mascara dados pessoais portugueses segundo o Regulamento Geral de Proteção de Dados e a Lei n.º 58/2019, que assegura sua execução: identificadores diretos (os quatro números do Cartão de Cidadão — identificação civil e número de documento, NIF, NISS e número de utente — com caracteres de controle válidos, passaporte, título de residência, nomes, contato, endereço, o IBAN e o NIB e o CPE de um ponto de fornecimento com caracteres de controle válidos, placas), quase-identificadores (data de nascimento, concelho, freguesia, seus códigos e código postal generalizados abaixo de 20.000 habitantes, nacionalidade e situação de residência), as categorias especiais do artigo 9 e do artigo 35 da Constituição, dados de saúde sob o artigo 29 da lei e a Lei n.º 12/2005, crédito e os dados tributários que o artigo 64 da Lei Geral Tributária mantém confidenciais, e registo criminal, certificados para trabalho com menores e contraordenações.',
    es: 'Descubre y enmascara datos personales portugueses conforme al Reglamento General de Protección de Datos y a la Lei n.º 58/2019, que asegura su ejecución: identificadores directos (los cuatro números del Cartão de Cidadão — identificación civil y número de documento, NIF, NISS y número de utente — con caracteres de control válidos, pasaporte, título de residencia, nombres, contacto, dirección, el IBAN y el NIB y el CPE de un punto de suministro con caracteres de control válidos, matrículas), cuasi-identificadores (fecha de nacimiento, concelho, freguesia, sus códigos y código postal generalizados por debajo de 20.000 habitantes, nacionalidad y situación de residencia), las categorías especiales del artículo 9 y del artículo 35 de la Constitución, datos de salud bajo el artículo 29 de la ley y la Lei n.º 12/2005, crédito y los datos tributarios que el artículo 64 de la Lei Geral Tributária mantiene confidenciales, y registo criminal, certificados para trabajar con menores y contraordenações.',
  },
  profileSet: {
    name: `PT - Lei 58 de 2019 - v${VERSION}`,
    description: 'RGPD e Lei 58 de 2019 - dados pessoais',
    threshold: 60,
    classifiers: classifiers.map((c) => c.name),
  },
  packs: {
    essential: {
      description: 'Pacote essencial da Lei 58 de 2019',
      domains: ESSENTIAL,
    },
  },
  classifiers,
  domains,
  algorithms,
  files: [...files.keys()].sort(),
}

// The texts the engine reads must pass as they are: no refused character, a short set description.
const engineProblems = engineTextProblems(preset)
if (engineProblems.length) throw new Error(`texts the engine would refuse:\n  ${engineProblems.join('\n  ')}`)
fs.rmSync(FILES, { recursive: true, force: true })
fs.mkdirSync(FILES, { recursive: true })
for (const [name, lines] of files) fs.writeFileSync(nodePath.join(FILES, name), `${lines.join('\n')}\n`)
fs.writeFileSync(nodePath.join(HERE, 'preset.json'), `${JSON.stringify(preset, null, 2)}\n`)

const small = concelhoPlaces.filter((c) => c.small)
const inSmall = small.reduce((a, c) => a + c.population, 0)
const lines = [...files.values()].reduce((a, l) => a + l.length, 0)
console.log(`${domains.length} domains, ${classifiers.length} classifiers, ${algorithms.length} algorithms, ${files.size} files (${lines} lines)`)
console.log(`concelhos: ${small.length} of ${CONCELHOS.length} under ${SMALL_PLACE} (${inSmall} people); ${concelhos.table.length} table lines`)
console.log(`freguesias: ${freguesiaPlaces.filter((f) => f.small).length} of ${FREGUESIAS.length} under ${SMALL_PLACE}; ${freguesias.table.length} table lines; ${codePairs.length} codes, ${postalPairs.length} postal codes`)
