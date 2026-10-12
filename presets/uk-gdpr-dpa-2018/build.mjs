#!/usr/bin/env node
/**
 * Builds the United Kingdom (UK GDPR and Data Protection Act 2018) pre-configured profile set:
 * preset.json and files/.
 *
 *   node presets/uk-gdpr-dpa-2018/build.mjs
 *
 * source/ holds the hand-kept lists (given names, surnames, streets) and the 4,643 places of the
 * GeoNames list of towns and cities of more than 1,000 people in the United Kingdom, with their local
 * authority, nation and population. Everything in files/ and preset.json is generated from them and
 * from the definitions below — edit here, then build, then run verify.mjs.
 *
 * Structure of the set
 *   L1      direct identifiers        National Insurance number, NHS number, UTR, names, contact,
 *                                     documents, bank details…
 *   L2      quasi-identifiers         birth date, age, sex, postcode, town, occupation…
 *   L3      special category data     the Article 9 categories of the UK GDPR: racial or ethnic
 *                                     origin, political opinions, religious or philosophical beliefs,
 *                                     trade union membership, genetic and biometric data, sex life and
 *                                     sexual orientation (and gender identity, which the Gender
 *                                     Recognition Act 2004 protects)
 *   HEALTH  data concerning health (Article 9)
 *   FIN     financial data            not special category, but confidential by other rules (the
 *                                     banker's duty of confidence, the Consumer Credit Act 1974)
 *   PENAL   criminal convictions and offences (Article 10, and section 11(2) of the Act: the alleged
 *           commission of offences and the proceedings, too)
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

/**
 * The same Character Mapping without preserveLeadingZeros. Inside a check-digit computation the
 * number has a fixed width, and a zero on the left is a digit to mask, not padding.
 */
function fixedWidth(name) {
  const source = algorithms.find((a) => a.name === name)
  if (!source) throw new Error(`fixedWidth: ${name} must be defined first`)
  if (!source.config.preserveLeadingZeros) return name
  const twin = `${name}_FIXED_WIDTH`
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
function cleansing(name, fileName, pairs, input, delimiter = ',') {
  for (const [from, to] of pairs) if (from.includes(delimiter) || to.includes(delimiter)) throw new Error(`${fileName}: "${from}" holds the delimiter`)
  return algorithm(name, 'dataCleansing.DataCleansing', {
    lookupFile: { uri: file(fileName, pairs.map(([from, to]) => `${from}${delimiter}${to}`)) },
    delimiter, caseSensitive: true, trimWhitespace: true,
  }, input)
}

/** String Algorithm Chain. Delphix allows eight algorithms per chain. */
function chain(name, steps, input) {
  if (steps.length > 8) throw new Error(`${name}: more than eight steps`)
  return algorithm(name, 'stringAlgorithmChain.StringAlgorithmChain', { algorithmReferences: steps.map(use) }, input)
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
  description: 'Column name and the variants used in UK systems.',
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
  description: 'Rules out columns whose type cannot hold this data.',
  config: { allowedTypes: allowed, matchAutoIncrementingColumn: false, matchStrength: 0, rejectStrength: 1 },
})

/**
 * Values: [regex, strength, { checksum, clean, note }]. Whole value unless `partial`. The spaces a
 * CHAR column pads with are cleaned away, and a pattern that starts with a digit also takes zeros
 * on the left (see presets/_lib/detect.mjs).
 */
const byPattern = (rules, { reject = 0.3, partial = false } = {}) => (d) => ({
  name: `${d} - Regex`, framework: 'REGEX', domain: d,
  description: 'Shape of the values.',
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
      description: 'Known values.',
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
    description: 'Known values.',
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

// ── Source lists ────────────────────────────────────────────────────────────

const GIVEN_NAMES = unique(readLines('given-names.txt'))
const SURNAMES = unique(readLines('surnames.txt'))

const NATIONS = ['England', 'Scotland', 'Wales', 'Northern Ireland']
const PLACES = readLines('places.tsv').map((line) => {
  const [name, area, nation, population] = line.split('\t')
  return { name, area, nation, population: Number(population) }
})
if (PLACES.length < 4600) throw new Error(`expected the 4,643 places of the GeoNames list, found ${PLACES.length}`)
for (const p of PLACES) if (!NATIONS.includes(p.nation) || !Number.isFinite(p.population)) throw new Error(`${p.name}: bad line`)

// ── Shared algorithms ───────────────────────────────────────────────────────

// Vowels map to vowels and consonants to consonants, so a masked document number keeps its
// structure; digits map to digits. Separators are in no group and stay. minMaskedPositions 0 lets
// a placeholder such as "N/A" through instead of failing the row.
algorithm('UK_CM_ALNUM', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'AEIOU', 'BCDFGHJKLMNPQRSTVWXYZ', 'aeiou', 'bcdfghjklmnpqrstvwxyz'],
  caseSensitive: true,
  minMaskedPositions: 0,
  preserveLeadingZeros: true,
}, '000123456')
// Digits only, for numbers whose digits sit at fixed positions (check-digit bodies, sort codes):
// there a zero on the left is a digit to mask, not padding.
algorithm('UK_CM_DIGITS', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '943476591')
// Hex letters form their own group, so a MAC, UUID or IPv6 stays valid hex.
algorithm('UK_CM_HEX', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'abcdef', 'ABCDEF', 'ghijklmnopqrstuvwxyz', 'GHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
  preserveLeadingZeros: true,
}, '3c:22:fb:9a:10:e4')
decompose('UK_REDACT', [['(.+)', { type: 'REDACT', redactCharacter: 'X' }]], keep, 'secret123')
decompose('UK_IDENTITY', [['(.*)', keep]], keep, '9434765919')
lookup('UK_SUPPRESS', 'uk-not-stated.txt', ['Not stated'], 'Major depressive disorder', 'PRESERVE_LOOKUP_FILE')

// Yes/no columns keep their vocabulary: a CHAR(1) Y/N stays Y/N.
decompose('UK_FLAG', [
  ['(?i)(yes|no)', apply(lookup('UK_FLAG_YES_NO', 'uk-flag-yes-no.txt', ['Yes', 'No']))],
  ['(?i)(true|false)', apply(lookup('UK_FLAG_TRUE_FALSE', 'uk-flag-true-false.txt', ['true', 'false']))],
  ['(?i)([yn])', apply(lookup('UK_FLAG_Y_N', 'uk-flag-y-n.txt', ['Y', 'N']))],
  ['([01])', apply(lookup('UK_FLAG_0_1', 'uk-flag-0-1.txt', ['0', '1']))],
], keep, 'Y')

const FLAG = '(?i)(yes|no|true|false|[yn01])'
/**
 * A categorical attribute: flags stay flags, numeric codes get other digits, and any other value
 * is replaced by one from `values` — or suppressed, when no list is given.
 */
function categorical(name, fileName, values, input) {
  const replacement = values ? lookup(`${name}_LIST`, fileName, values) : 'UK_SUPPRESS'
  return decompose(name, [[FLAG, apply('UK_FLAG')], [String.raw`(\d{1,6})`, apply('UK_CM_ALNUM')]], apply(replacement), input)
}
categorical('UK_SUPPRESSED_CATEGORY', null, null, 'Major depressive disorder')
const CM = apply('UK_CM_ALNUM')
const DIGITS = apply('UK_CM_DIGITS')

// ── Check digits ────────────────────────────────────────────────────────────
//
// The NHS number and the UTR are both modulus 11 numbers, and the plugin's Check Digit writes
// (11 − remainder), with a "0" both for ten and for eleven. Where the true rule needs something
// else for remainder 0 or 1, an **auxiliary Check Digit with doubled weights** tells the two
// apart — doubling maps remainder 0 to 0 and 1 to 2, so the auxiliary writes zero for the first and
// nine for the second — and a Regex Decompose writes the true digit and drops the auxiliary. The
// technique is the one of the Peruvian DNI and RUC; no lookup table of numbers is needed.

const doubled = (weights) => weights.map((w) => (2 * w) % 11)
const INPUT_HANDLING = { characterHandling: 'STANDARD', invalidInputHandling: 'ERROR', shortInputHandling: 'FALLBACK', padCharacter: '0', trimWhitespace: true }
/** Check Digit over `weights` (left to right, the check position excluded), written at `index`. */
function checkDigit(name, weights, index, body, input) {
  return algorithm(name, 'checkdigit.Checkdigit', {
    // Check Digit applies the weights from the right.
    weightList: [...weights].reverse(), modulusNumber: 11,
    checkDigitIndex: index, numDigitsForCheckdigitCalculation: weights.length,
    calculateChecksumRightToLeft: true,
    numericAlgorithm: use(fixedWidth(body)), alphaNumericAlgorithm: use(fixedWidth(body)),
    preserveRegex: String.raw`[.\-\s]`,
    inputHandlingConfig: INPUT_HANDLING,
  }, input)
}
/** Rewrites what follows `head`: one pattern per digit, because Redaction writes a fixed string. */
function digitAfter(name, head, write, input) {
  return decompose(name, Array.from({ length: 10 }, (_, d) => [`(${head})(${d})`, keep, redactAs(write(d))]), keep, input)
}
/** The same, for a digit in front of `tail`. */
function digitBefore(name, tail, write, input) {
  return decompose(name, Array.from({ length: 10 }, (_, d) => [`(${d})(${tail})`, redactAs(write(d)), keep]), keep, input)
}
/**
 * Writes the true check digit from the pair (what Check Digit wrote, what the auxiliary wrote):
 * `table[0]` for a written zero the auxiliary confirms (remainder 0), `table[10]` for the zero that
 * stands for ten (remainder 1), `table[1..9]` for the rest.
 */
const resolvePatterns = (wrap, table) => [
  [wrap('00'), table[0]], [wrap(String.raw`0\d`), table[10]],
  ...Array.from({ length: 9 }, (_, i) => [wrap(String.raw`${i + 1}\d`), table[i + 1]]),
]

// ── L1 · National Insurance number ──────────────────────────────────────────
//
// The National Insurance number (NINO) of HMRC and the DWP: two prefix letters, six digits and a
// suffix letter A to D, usually written QQ 12 34 56 C. It follows a person through tax, benefits and
// the State Pension, and employers, banks and the NHS all hold it. The letters say nothing about the
// person (prefixes are issued in series); the six digits are the person. They are masked, the letters
// and the spacing stay, so the result is still a well-formed NINO.

decompose('UK_NINO', [
  [String.raw`(?i)([a-z]{2})(\s?\d{2}\s?\d{2}\s?\d{2}\s?)([a-d]?)`, keep, DIGITS, keep],
], CM, 'QQ 12 34 56 C')
domain('UK_L1_NINO', 'UK_NINO',
  byName(['nino|ni_?(no|num|number|nbr)|nin|national_?insurance(_?(no|num|number|nbr))?|nat_?ins(_?(no|num|number))?|ni_?num|insurance_?number_?ni', 0.9]),
  byPattern([
    [String.raw`[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]`, 0.95],
    // Without the suffix, two letters and six digits are a common shape for any reference.
    [String.raw`[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{2}\s?\d{2}\s?\d{2}`, 0.4],
  ], { reject: 0.3 }))

// ── L1 · NHS number, CHI number, H&C number ─────────────────────────────────
//
// England, Wales and the Isle of Man give each patient a ten-digit NHS number; Scotland, a CHI number
// (Community Health Index), whose first six digits are the date of birth; Northern Ireland, a Health
// and Care number. All three end in the same modulus 11 check digit: nine digits weighted 10 down to
// 2, eleven minus the remainder, 0 for eleven — and a number whose remainder is 1 (a check digit of
// ten) is never issued.
//
// The nine digits are masked — the first kept, since it tells the issuing system; a CHI keeps a real
// date (the day becomes 01–28, the month 01–12) — and the check digit recomputed. When the masked
// digits give remainder 1, the ninth digit moves up by one and the check digit is computed again: a
// valid number, about one body in eleven moved one step.

const NHS_WEIGHTS = [10, 9, 8, 7, 6, 5, 4, 3, 2]
const NHS_HEAD = String.raw`\d{3}[\s\-]?\d{3}[\s\-]?\d{3}`
const NHS_FIRST_EIGHT = String.raw`\d{3}[\s\-]?\d{3}[\s\-]?\d{2}`
lookup('UK_CHI_DAY', 'uk-chi-day.txt', Array.from({ length: 28 }, (_, i) => String(i + 1).padStart(2, '0')), '17')
lookup('UK_CHI_MONTH', 'uk-chi-month.txt', Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')), '05')
decompose('UK_NHS_BODY', [
  // A CHI: a date of birth, then four digits.
  [String.raw`(0[1-9]|[12]\d|3[01])(0[1-9]|1[0-2])(\d{5})`, apply('UK_CHI_DAY'), apply('UK_CHI_MONTH'), DIGITS],
  [String.raw`(\d)(\d{8})`, keep, DIGITS],
], DIGITS, '943476591')
checkDigit('UK_NHS_CD', NHS_WEIGHTS, 9, 'UK_NHS_BODY', '9434765919')
digitAfter('UK_NHS_WIDEN', NHS_HEAD, (d) => `${d}0`, '9434765919')
checkDigit('UK_NHS_AUX', [...doubled(NHS_WEIGHTS), 0], 10, 'UK_IDENTITY', '94347659190')
// Remainder 0 is a real 0; remainder 1 is marked Z for the next step.
decompose('UK_NHS_RESOLVE', resolvePatterns((pair) => `(${NHS_HEAD})(${pair})`, ['0', ...'123456789', 'Z']).map(([regex, write]) => [regex, keep, redactAs(write)]), keep, '94347659190')
// The ninth digit moves up by one (9 becomes 0): the remainder moves by two or by four, never to 1.
digitAfter('UK_NHS_STEP', NHS_FIRST_EIGHT, (d) => `${(d + 1) % 10}`, '943476591')
decompose('UK_NHS_REPAIR', [[String.raw`(${NHS_HEAD})(Z)`, apply('UK_NHS_STEP'), redactAs('0')]], keep, '943476591Z')
checkDigit('UK_NHS_RECOMPUTE', NHS_WEIGHTS, 9, 'UK_IDENTITY', '9434765920')
chain('UK_NHS_NUMBER', ['UK_NHS_CD', 'UK_NHS_WIDEN', 'UK_NHS_AUX', 'UK_NHS_RESOLVE', 'UK_NHS_REPAIR', 'UK_NHS_RECOMPUTE'], '943 476 5919')
// Only ten-digit values go through the chain; anything else is masked character by character.
decompose('UK_NHS_COLUMN', [[String.raw`(\d{3}[\s\-]?\d{3}[\s\-]?\d{4})`, apply('UK_NHS_NUMBER')]], CM, '943 476 5919')

domain('UK_L1_NHS_NUMBER', 'UK_NHS_COLUMN',
  byName(['nhs_?(no|num|number|nbr|id)?|nhsno|nhs_?number|chi(_?(no|num|number))?|community_?health_?index(_?(no|number))?|h_?and_?c(_?(no|number))?|hcn|health_?and_?care_?(no|num|number)|patient_?nhs_?(no|number)', 0.9]),
  // The check digit is computed over the cleaned value, so zeros a CHAR column filled in on the left
  // are cleaned away first — only those beyond the ten digits: a CHI may start with a zero of its own.
  byPattern([[String.raw`\d{3}[\s\-]?\d{3}[\s\-]?\d{4}`, 0.8, { checksum: 'MOD11_NHS', clean: String.raw`^0+(?=(?:[\s\-]?\d){10}\s*$)|[\s\-]` }]], { reject: 0.3 }))

// ── L1 · Unique Taxpayer Reference ──────────────────────────────────────────
//
// The UTR of HMRC: ten digits for Self Assessment, Corporation Tax and partnerships, sometimes
// followed by a K. Its check digit is the **first** digit: the other nine weighted 6 7 8 9 10 5 4 3 2,
// eleven minus the remainder, less nine when that is ten or eleven (so remainder 0 gives 2 and
// remainder 1 gives 1). The nine digits are masked and the first recomputed.

const UTR_WEIGHTS = [6, 7, 8, 9, 10, 5, 4, 3, 2]
const UTR_TAIL = String.raw`[\s\-]?\d{4}[\s\-]?\d{5}`
// The UTR is often written as two groups of five: the first holds the check digit and four more.
checkDigit('UK_UTR_CD', UTR_WEIGHTS, 0, 'UK_CM_DIGITS', '1234567890')
digitBefore('UK_UTR_WIDEN', UTR_TAIL, (d) => `${d}0`, '1234567890')
checkDigit('UK_UTR_AUX', [0, ...doubled(UTR_WEIGHTS)], 1, 'UK_IDENTITY', '10234567890')
decompose('UK_UTR_RESOLVE', resolvePatterns((pair) => `(${pair})(${UTR_TAIL})`, ['2', ...'123456789', '1']).map(([regex, write]) => [regex, redactAs(write), keep]), keep, '10234567890')
chain('UK_UTR_DIGITS', ['UK_UTR_CD', 'UK_UTR_WIDEN', 'UK_UTR_AUX', 'UK_UTR_RESOLVE'], '1234567890')
decompose('UK_UTR', [[String.raw`(\d${UTR_TAIL})(\s?[Kk]?)`, apply('UK_UTR_DIGITS'), keep]], CM, '12345 67890')
domain('UK_L1_UTR', 'UK_UTR',
  byName(['utr|sa_?utr|ct_?utr|unique_?tax(payer)?_?ref(erence)?(_?(no|num|number))?|self_?assessment_?(ref|reference|utr|no|number)|tax_?ref(erence)?(_?(no|num|number))?|taxpayer_?ref(erence)?|corporation_?tax_?(ref|reference|utr)', 0.9]),
  byPattern([[String.raw`\d{5}\s?\d{5}\s?K?`, 0.4]], { reject: 0.3 }))

// ── L1 · Documents ──────────────────────────────────────────────────────────

domain('UK_L1_PASSPORT', 'UK_CM_ALNUM',
  byName(['passport[a-z_]*|pass_?port_?(no|num|number)|pp_?(no|num|number)|travel_?document(_?(no|num|number))?', 0.85]),
  byPattern([[String.raw`\d{9}|[A-Z]{1,2}\d{6,8}`, 0.3]], { reject: 0.3 }))

// The DVLA licence number is 16 characters: five of the surname, six for the date of birth (the
// month plus 5 for a woman), two initials, a digit and two check letters — the holder in plain
// sight. Northern Ireland licences are eight digits. Masked character by character.
domain('UK_L1_DRIVING_LICENCE', 'UK_CM_ALNUM',
  byName(['drivers?_?licen[cs]e(_?(no|num|number))?|driving_?licen[cs]e(_?(no|num|number))?|dl_?(no|num|number)|dvla_?(no|number|licen[cs]e)|licen[cs]e_?(no|num|number)(?!_?(plate|vehicle|business|premises|liquor|tv|television|software))', 0.85]),
  byPattern([[String.raw`[A-Z9]{5}\d[0156]\d([0][1-9]|[12]\d|3[01])\d[A-Z9]{2}\d[A-Z]{2}`, 0.95]], { reject: 0.3 }))

// Biometric residence permits, eVisa share codes, Home Office references, visas and settlement
// (EU Settlement Scheme) decisions.
domain('UK_L1_IMMIGRATION_DOCUMENT', 'UK_CM_ALNUM',
  byName(['brp(_?(no|num|number))?|biometric_?residen(ce|cy)_?permit(_?(no|number))?|residen(ce|cy)_?permit(_?(no|number))?|share_?code|right_?to_?(work|rent)_?(code|share_?code|check)|evisa(_?(no|number|ref))?|home_?office_?(ref|reference|no|number)|ho_?ref|visa_?(no|num|number|ref)|euss(_?(ref|reference|no|number))?|settled_?status_?(ref|reference)|immigration_?(status|permission|document|ref|reference|no|number)|ukvi_?(ref|reference|no|number)|certificate_?of_?sponsorship|cos_?(no|number|ref)|asylum_?(ref|reference|no|number)|arc_?(no|number|card)|naturali[sz]ation_?(certificate|cert|no|number)|registration_?certificate_?(no|number)', 0.85]))

// Birth, death, marriage and civil partnership registrations: the GRO index references and the
// entry numbers of the certificates of England and Wales, Scotland and Northern Ireland.
domain('UK_L1_VITAL_RECORD', 'UK_CM_ALNUM',
  byName(
    ['birth_?cert(ificate)?(_?(no|num|number|entry|ref))?|death_?cert(ificate)?(_?(no|num|number|ref))?|marriage_?cert(ificate)?(_?(no|num|number|ref))?|civil_?partnership_?cert(ificate)?(_?(no|number))?|gro_?(index|ref|reference|no|number)|registry_?entry(_?(no|number))?|vital_?(record|statistics)_?(no|num|number)|registration_?district_?(no|number|entry)', 0.85],
    ['entry_?(no|number)', 0.55],
  ))

// ── L1 · Names ──────────────────────────────────────────────────────────────

const NOT_A_PERSON = 'product|prod|item|article|company|business|trade|brand|file|street|road|avenue|village|town|city|county|district|borough|council|country|bank|branch|plan|campaign|project|service|table|column|field|user|host|server|domain|model|category|type|school|college|institution|course|programme|program|subject|document|doc|centre|center|unit|clinic|hospital|surgery|practice|trust|area|department|dept|position|system|app|application|group|list|report|process|event|task|profile|role|class|object|account|drug|medication|diagnosis|study|benefit|party|union|religion|ethnicity|language|place|store|shop|warehouse|supplier|vendor|contract|policy|insurance|org|organi[sz]ation|entity|parameter|variable|method|function|index|job|script|queue|resource|network|device|template|image|photo|page|site|module|menu|option|action|permission|tax|currency|issuer|invoice|payment|form|zone|route|line|sector|building|display|key|tag|label|title|code|config|setting|firm|employer|estate|parcel|scheme|community|ward|constituency'
const PERSON_ROLE = 'customer|cust|client|patient|employee|emp|staff|worker|member|student|pupil|insured|beneficiary|holder|account_?holder|policy_?holder|mother|father|parent|guardian|spouse|partner|next_?of_?kin|doctor|gp|physician|nurse|carer|contact|emergency_?contact|guarantor|debtor|borrower|applicant|signatory|witness|representative|owner|tenant|landlord|victim|complainant|accused|defendant|donor|heir|person|driver|agent|citizen|elector|voter|taxpayer|child|dependant|dependent|relative|officer|teacher|contributor|pensioner|claimant|resident|occupier'

// Each word from the list; three words are the most a given-name column holds.
decompose('UK_GIVEN_NAMES', [
  [String.raw`(\S+)`, apply('UK_GIVEN_NAME')],
  [String.raw`(\S+)\s+(\S+)`, apply('UK_GIVEN_NAME'), apply('UK_GIVEN_NAME')],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, apply('UK_GIVEN_NAME'), apply('UK_GIVEN_NAME'), apply('UK_GIVEN_NAME')],
], CM, 'Mary Elizabeth')
algorithm('UK_GIVEN_NAME', 'name.Name', {
  lookupFile: { uri: file('uk-given-names.txt', GIVEN_NAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Oliver')
// Surnames: one, or two joined by a hyphen (double-barrelled).
decompose('UK_SURNAMES', [
  // Before the single word, which would take the double-barrelled surname whole.
  [String.raw`([^\s\-]+)(\-)([^\s\-]+)`, apply('UK_SURNAME'), keep, apply('UK_SURNAME')],
  [String.raw`(\S+)`, apply('UK_SURNAME')],
  [String.raw`(\S+)\s+(\S+)`, apply('UK_SURNAME'), apply('UK_SURNAME')],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, apply('UK_SURNAME'), apply('UK_SURNAME'), apply('UK_SURNAME')],
], CM, 'Smith')
algorithm('UK_SURNAME', 'name.Name', {
  lookupFile: { uri: file('uk-surnames.txt', SURNAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Smith')
// The English order: title, given name, middle names, surname. The title stays; a hyphenated
// surname is the last word.
const N = apply('UK_GIVEN_NAME')
const S = apply('UK_SURNAMES')
const TITLE = String.raw`(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Sir|Dame|Rev|Revd|Lady|Lord)\.?\s+`
decompose('UK_FULL_NAME', [
  [String.raw`([^,]+),\s*(.+)`, apply('UK_SURNAMES'), apply('UK_GIVEN_NAMES')],
  [String.raw`(?i)(${TITLE})(\S+)`, keep, S],
  [String.raw`(?i)(${TITLE})(\S+)\s+(\S+)`, keep, N, S],
  [String.raw`(?i)(${TITLE})(\S+)\s+(\S+)\s+(\S+)`, keep, N, N, S],
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, S],
  // A middle initial stays an initial.
  [String.raw`(\S+)(\s+)([A-Za-z]\.?)(\s+)(\S+)`, N, keep, keep, keep, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, N, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, N, S],
], CM, 'Mrs Mary E. Smith')

domain('UK_L1_GIVEN_NAME', 'UK_GIVEN_NAMES',
  byName(
    [`first_?names?|given_?names?|fore_?names?|christian_?name|fname|name_?first|middle_?names?|mname|name_?middle|preferred_?(first_?)?name|known_?as`, 0.85],
    [`name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))`, 0.5],
  ),
  byList([['uk-detect-given-names.txt', GIVEN_NAMES, 0.7]], { tokenize: true, reject: 0.3 }))

domain('UK_L1_SURNAME', 'UK_SURNAMES',
  byName(['last_?names?|surnames?|family_?names?|lname|name_?last|maiden_?name|mothers?_?maiden_?name|maiden|birth_?surname|previous_?surname|married_?name|former_?(sur)?name', 0.85]),
  byList([['uk-detect-surnames.txt', SURNAMES, 0.7]], { tokenize: true, reject: 0.3 }))

domain('UK_L1_FULL_NAME', 'UK_FULL_NAME',
  byName(
    [`full_?name|fullname|complete_?name|person_?name|name_?of_?(${PERSON_ROLE})|(${PERSON_ROLE})_?name`, 0.9],
    ['beneficiary|guardian|next_?of_?kin|spouse|emergency_?contact|guarantor|account_?holder|policy_?holder|legal_?representative|attorney|lasting_?power_?of_?attorney|patient|victim|complainant|accused|defendant|insured_?person|nominee|executor|appointee', 0.6],
    // A bare NAME holds a given name or a full name: the values decide between the two domains.
    [`name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))`, 0.5],
  ),
  // 0.65: a full name found word by word reaches the threshold without the column name, and a
  // single word still goes to the given-name or surname domain, at 0.7.
  byList([['uk-detect-given-names.txt', GIVEN_NAMES, 0.65], ['uk-detect-surnames.txt', SURNAMES, 0.65]], { tokenize: true, reject: 0.3 }))

// ── L1 · Contact ────────────────────────────────────────────────────────────

decompose('UK_EMAIL', [
  // The top-level domain becomes .test, reserved for tests: a masked address can never deliver.
  [String.raw`([^@\s]+)@([^@\s]+)\.([A-Za-z]{2,24})`, CM, CM, redactAs('test')],
], CM, 'mary.smith@example.co.uk')
domain('UK_L1_EMAIL', 'UK_EMAIL',
  byName(['e_?mail[a-z0-9_]*|mail[a-z0-9_]*|email_?address', 0.85]),
  byType(STRING(5)),
  byPattern([[String.raw`[\p{L}\p{N}._%+'\-]+@[\p{L}\p{N}.\-]+\.[A-Za-z]{2,24}`, 1]], { reject: 0.2 }))

// UK numbers: +44 or a trunk 0, then ten digits — 07 for mobiles, 01 and 02 for geographic numbers,
// 03 and 08 for non-geographic ones. The country code, the trunk 0, the next two digits (the mobile
// range or the start of the area code) and the separators stay; the rest is masked.
decompose('UK_PHONE', [
  // Ten digits after the trunk 0 (nine for a few old numbers): counting them keeps zeros a CHAR column
  // filled in on the left out of the number.
  [String.raw`(\+?44\s?(?:\(0\)\s?)?|\(?0)(\d{2})((?:[\s\-.)]*\d){7,8})`, keep, keep, CM],
  [String.raw`(\d{3})([\s\-.]?)(\d{4})`, CM, keep, CM],
], CM, '+44 7700 900123')
domain('UK_L1_PHONE', 'UK_PHONE',
  byName(['tel|telephone[a-z0-9_]*|tel_?(no|num|number|home|work|mobile)|phone[a-z0-9_]*|ph_?(no|num|number)|mobile[a-z0-9_]*|mob(_?(no|num|number))?|cell|cell_?(phone|no|number)|cellphone|contact_?(no|num|number)|landline|fax|whatsapp', 0.85]),
  byPattern([
    // UK numbers start with 0 or +44. The look-ahead keeps the pattern from taking zeros on the left
    // as padding: with them, any zero-filled number of ten digits (an NHS number) would read as a phone.
    [String.raw`(?=[+(0])(\+?44\s?(\(0\)\s?)?|\(?0)[1-35789]\d{1,3}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{3,4}`, 1],
    [String.raw`\+?\d[\d\s()\-.]{6,15}`, 0.3],
  ], { reject: 0.3 }))

// Addresses: house number or name and street, often with a flat; the postcode is a domain of its own.
const ADDRESS_TOWNS = ['London', 'Birmingham', 'Manchester', 'Leeds', 'Glasgow', 'Bristol', 'Cardiff', 'Belfast', 'Edinburgh', 'Sheffield', 'Liverpool', 'Nottingham', 'Leicester', 'Coventry', 'Newcastle upon Tyne', 'Swansea', 'Aberdeen', 'Derry', 'Reading', 'Norwich']
const HOUSE_NAMES = ['Rose Cottage', 'The Old Rectory', 'Ivy House', 'Orchard House', 'The Coach House', 'Mill House', 'Hillcrest', 'Woodlands', 'The Barn', 'Meadow View']
const BUILDINGS = ['Victoria House', 'Albion Court', 'Riverside Court', 'Kings Court', 'Park View', 'Westminster House', 'Regent House', 'Abbey Court']
lookup('UK_ADDRESS', 'uk-addresses.txt', (() => {
  const random = seeded(2018)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const streets = readLines('streets.txt')
  const out = new Set()
  while (out.size < 3000) {
    const r = random()
    const house = 1 + Math.floor(random() * 250)
    if (r < 0.5) out.add(`${house} ${pick(streets)}`)
    else if (r < 0.7) out.add(`${house} ${pick(streets)}, ${pick(ADDRESS_TOWNS)}`)
    else if (r < 0.85) out.add(`Flat ${1 + Math.floor(random() * 40)}, ${pick(BUILDINGS)}, ${pick(streets)}`)
    else out.add(`${pick(HOUSE_NAMES)}, ${pick(streets)}`)
  }
  return [...out]
})(), '10 Downing Street, London', 'PRESERVE_LOOKUP_FILE')
domain('UK_L1_ADDRESS', 'UK_ADDRESS',
  byName(['(?<!(mac|ip|e_?mail|web|url)_?)address(?!_?(ip|mac|email|e_?mail|web|url|book|type|id))[a-z0-9_]*|(?<!(mac|ip|e_?mail|web|url)_?)addr(ess)?_?(line|1|2|3)?[a-z0-9_]*|street(_?(address|name))?|residential_?address|home_?address|mailing_?address|postal_?address|correspondence_?address|residence|place_?of_?residence|domicile|po_?box', 0.8]),
  byType(STRING(6)),
  byPattern([
    [String.raw`(?i)\d+[A-Z]?,?\s+.*\b(street|st\.?|road|rd\.?|avenue|ave\.?|lane|ln\.?|drive|dr\.?|close|crescent|cres\.?|way|gardens|gdns\.?|place|pl\.?|court|ct\.?|terrace|grove|square|sq\.?|hill|mews|row|walk|park|green|view|rise|parade|broadway|approach)\b.*`, 0.8],
    [String.raw`(?i)(flat|apartment|apt\.?|unit)\s*\d+[A-Z]?\b.*`, 0.8],
    [String.raw`(?i).+,.*\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b.*`, 0.8],
  ], { reject: 0.2 }))

domain('UK_L1_ADDRESS_DETAIL', 'UK_CM_ALNUM',
  byName(['house_?(no|num|number|name)|building_?(no|number|name)|flat_?(no|number)?|apt(_?(no|number))?|apartment(_?(no|number))?|unit_?(no|num|number)|floor_?(no|number)?|suite(_?no)?|sub_?building(_?name)?', 0.7]))

// ── L1 · Banking ────────────────────────────────────────────────────────────

domain('UK_L1_BANK_ACCOUNT', 'UK_CM_ALNUM',
  byName(['account_?(no|num|number|nbr)|acct_?(no|num|number|nbr)?|acc_?(no|num|number)|bank_?(account|acct)(_?(no|num|number))?|current_?(account|acct)(_?(no|number))?|savings_?(account|acct)(_?(no|number))?|building_?society_?(account|roll)(_?(no|number))?|roll_?(no|number)', 0.85]))

// A sort code names a bank (the first two digits) and a branch. The bank stays; the branch is masked.
decompose('UK_SORT_CODE', [[String.raw`(\d{2})([\s\-]?\d{2}[\s\-]?\d{2})`, keep, DIGITS]], CM, '20-00-00')
domain('UK_L1_SORT_CODE', 'UK_SORT_CODE',
  byName(['sort_?code|sortcode|bank_?sort(_?code)?|branch_?sort_?code|nsc', 0.9]),
  byPattern([[String.raw`\d{2}-\d{2}-\d{2}`, 0.6]], { reject: 0.3 }))

// A UK IBAN holds the bank code (four letters), the sort code and the account number. The plugin's
// IBAN algorithm masks the last characters — the fourteen digits of the compact form, seventeen
// characters of the printed one — and recomputes the two IBAN check digits, so the result passes
// validation. The bank code stays.
algorithm('UK_IBAN_COMPACT', 'iban.IBAN', { validateInput: false, numCharsToMask: 14 }, 'GB82WEST12345698765432')
algorithm('UK_IBAN_PRINTED', 'iban.IBAN', { validateInput: false, numCharsToMask: 17 }, 'GB82 WEST 1234 5698 7654 32')
decompose('UK_IBAN', [
  [String.raw`(?i)(GB\d{2}[A-Z]{4}\d{14})`, apply('UK_IBAN_COMPACT')],
  [String.raw`(?i)(GB\d{2} [A-Z]{4} \d{4} \d{4} \d{4} \d{2})`, apply('UK_IBAN_PRINTED')],
], CM, 'GB82 WEST 1234 5698 7654 32')
domain('UK_L1_IBAN', 'UK_IBAN',
  byName(['iban(_?(no|number|code))?|international_?bank_?account(_?number)?', 0.9]),
  byPattern([[String.raw`GB\d{2}\s?[A-Z]{4}(\s?\d{4}){3}\s?\d{2}`, 1, { checksum: 'MOD97', clean: String.raw`\s` }]], { reject: 0.3 }))

// Credit Card fails a row that has no digits to mask; only values shaped like a card reach it.
decompose('UK_CARD', [[String.raw`(\d[\d\s\-]{11,22}\d)`, apply(ENGINE.CREDIT_CARD)]], keep, '4929 1234 5678 9012')
domain('UK_L1_PAYMENT_CARD', 'UK_CARD',
  byName(['card_?(no|num|number)|credit_?card(_?(no|num|number))?|debit_?card(_?(no|num|number))?|cc_?(no|num|number)|pan|card_?pan|masked_?pan|primary_?account_?number', 0.85]),
  // An IMEI is 15 Luhn-valid digits too: 15-digit cards are American Express (34, 37), and the rest
  // is left to the device domain. 0.9, not 1, so that a column name still wins.
  byPattern([[String.raw`3[47]\d{13}|[1-9]\d{12,13}|[1-9]\d{15,18}`, 0.9, { checksum: 'LUHN', clean: String.raw`[\s\-]` }]], { reject: 0.3 }))

// ── L1 · Network, devices, vehicles, property ───────────────────────────────

algorithm('UK_OCTET', 'characterMapping.NumericMapping', { minValue: 1, maxValue: 254 }, '10')
decompose('UK_IP', [
  [String.raw`(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})`, apply('UK_OCTET'), apply('UK_OCTET'), apply('UK_OCTET'), apply('UK_OCTET')],
], apply('UK_CM_HEX'), '81.2.69.160')
domain('UK_L1_IP_ADDRESS', 'UK_IP',
  byName(['ip|ip_?(address|addr|origin|source|destination|client|user|remote|public|private|login)|ipv[46]|remote_?addr(ess)?|client_?ip|host_?ip|source_?ip', 0.85]),
  byPattern([
    [String.raw`((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)`, 1],
    [String.raw`[0-9A-Fa-f]{1,4}(:[0-9A-Fa-f]{0,4}){2,7}`, 0.9],
  ], { reject: 0.3 }))

domain('UK_L1_DEVICE_ID', 'UK_CM_HEX',
  byName(['imei|imsi|iccid|mac|mac_?address|device_?(id|uuid|serial)|advertising_?id|idfa|gaid|cookie(_?id)?|session_?id|serial_?(no|number)_?(device|phone|handset)|handset_?serial', 0.8]),
  byPattern([
    [String.raw`([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}`, 1],
    [String.raw`\d{15}`, 0.8, { checksum: 'LUHN' }],
  ], { reject: 0.3 }))

// Number plates since 2001 are two letters for the region, two digits for the age and three random
// letters (AB12 CDE); the earlier ones put a letter for the year in front (A123 BCD) or behind
// (ABC 123D), and Northern Ireland has its own (ABZ 1234). Plates use no I or Q. The region and
// the age stay in the current format — they say where and when a car was first registered, as a
// year of birth would — and the rest is masked within the plate alphabet.
algorithm('UK_CM_PLATE', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'ABCDEFGHJKLMNOPRSTUVWXYZ', 'abcdefghjklmnoprstuvwxyz'],
  caseSensitive: true,
  minMaskedPositions: 0,
  preserveLeadingZeros: false,
}, 'AB12 CDE')
const PLATE = apply('UK_CM_PLATE')
decompose('UK_PLATE', [
  [String.raw`(?i)([a-z]{2}\d{2})(\s?)([a-z]{3})`, keep, keep, PLATE],
  [String.raw`(?i)([a-z])(\d{1,3})(\s?)([a-z]{3})`, keep, PLATE, keep, PLATE],
  [String.raw`(?i)([a-z]{3})(\s?)(\d{1,3})([a-z])`, PLATE, keep, PLATE, keep],
], PLATE, 'AB12 CDE')
domain('UK_L1_LICENCE_PLATE', 'UK_PLATE',
  byName(['licen[cs]e_?plates?(_?(no|num|number))?|plates?(_?(no|num|number))?|vrm|vehicle_?(reg|registration|registration_?mark|plate)(_?(no|num|number))?|registration_?(plate|mark)|number_?plate|reg_?(no|number|plate|mark)|car_?reg(istration)?', 0.85]),
  byPattern([
    [String.raw`[A-Z]{2}\d{2}\s?[A-Z]{3}`, 0.9],
    [String.raw`[A-Z]\d{1,3}\s?[A-Z]{3}|[A-Z]{3}\s?\d{1,3}[A-Z]`, 0.6],
    [String.raw`[A-Z]{2}[IZ]\s?\d{1,4}`, 0.6],
  ], { reject: 0.3 }))

domain('UK_L1_VIN', 'UK_CM_ALNUM',
  byName(['vin|vin_?(no|number)|vehicle_?identification_?(no|number)|chassis(_?(no|number))?|engine_?(no|number|serial)|v5c(_?(ref|reference|no|number))?|logbook_?(ref|reference|no|number)', 0.8]),
  byPattern([[String.raw`[A-HJ-NPR-Z0-9]{17}`, 0.7]], { reject: 0.3 }))

// Property: the Unique Property Reference Number of the address register, the HM Land Registry title
// number, the council tax account and the energy meter numbers (MPAN, MPRN) all lead to a household.
domain('UK_L1_PROPERTY', 'UK_CM_ALNUM',
  byName(['uprn|unique_?property_?ref(erence)?(_?(no|num|number))?|title_?(no|number)|land_?registry_?(title|ref|reference|no|number)|registers_?of_?scotland_?(ref|title)|council_?tax_?(account|ref|reference|no|number)(_?(no|number))?|ctax_?(ref|account)|business_?rates_?(account|ref)|mpan|mprn|meter_?point_?(ref|reference|admin(istration)?_?number)|meter_?(serial|no|number)|property_?(ref|reference|id)', 0.85]))

domain('UK_L1_CONTRACT_NUMBER', 'UK_CM_ALNUM',
  byName(['contract_?(no|num|number)|policy_?(no|num|number)|loan_?(no|num|number|id)|mortgage_?(no|number|account)|member(ship)?_?(no|num|number|id)|customer_?(no|num|number|id|ref)|client_?(no|num|number|id|ref)|cust_?(no|num|id)|employee_?(no|num|number|id)|emp_?(no|num|id)|staff_?(no|num|number|id)|payroll_?(no|number)|works_?(no|number)|claim_?(no|num|number|ref)|student_?(no|num|number|id)|upn|unique_?pupil_?number|uln|unique_?learner_?number|pupil_?(no|number|id)|library_?card_?(no|number)|tenancy_?(ref|reference|no|number)|housing_?(ref|reference)', 0.7]))

domain('UK_L1_USERNAME', 'UK_CM_ALNUM',
  byName(['user_?name|username|login(_?(name|id))?|user_?id_?login|nick_?name|nickname|alias|screen_?name|handle|facebook|instagram|twitter|tiktok|linkedin|social_?media(_?(handle|account|profile))?|telegram', 0.7]))

// Password hashes carry their scheme: bcrypt, crypt (MD5, SHA-256, SHA-512), Argon2, PBKDF2 and the
// LDAP {SSHA} forms. A bare hex digest could be any hash, and is left to the column name.
const PASSWORD_HASHES = [
  [String.raw`\$2[abxy]?\$\d{2}\$[./A-Za-z0-9]{53}`, 0.95],
  [String.raw`\$(1|5|6)\$(rounds=\d+\$)?[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{22,86}`, 0.95],
  [String.raw`\$argon2(id|i|d)\$v=\d+\$m=\d+,t=\d+,p=\d+\$\S+`, 0.95],
  [String.raw`pbkdf2_sha(1|256|512)\$\d+\$\S+\$\S+`, 0.95],
  [String.raw`\{(SSHA|SHA|SSHA256|SSHA512|SMD5|MD5|CRYPT)\}\S+`, 0.95],
]
domain('UK_L1_CREDENTIAL', 'UK_REDACT',
  byName(['password|passwd|pwd|pass_?word|pass|pin(_?(code|no|number))?|passcode|hash_?password|password_?hash|secret|secret_?(answer|question)|security_?(answer|question)|memorable_?(word|information|date)|access_?token|refresh_?token|api_?key|otp', 0.9]),
  byPattern(PASSWORD_HASHES, { reject: 0.3 }))

decompose('UK_COORDINATE', [
  // The integer part and first decimal stay (about 11 km): the place is generalized, not moved.
  [String.raw`(-?\d{1,3}\.\d)(\d+)\s*,\s*(-?\d{1,3}\.\d)(\d+)`, keep, CM, keep, CM],
  [String.raw`(-?\d{1,3}\.\d)(\d+)`, keep, CM],
], keep, '51.501009')
domain('UK_L1_GEOLOCATION', 'UK_COORDINATE',
  byName(
    ['lat|latitude|lon|lng|longitude|coordinates?|coord_?[xy]|geo_?(lat|lon|lng|loc|location|position)|geolocation|gps(_?(location|position|coordinates))?|easting|northing|grid_?ref(erence)?', 0.85],
    ['long', 0.5],
  ),
  byPattern([
    // Great Britain and Northern Ireland: latitude 49 to 61, longitude 8 West to 2 East.
    [String.raw`(49|5\d|60)\.\d{3,}\s*,\s*-?[0-8]\.\d{3,}`, 0.9],
    [String.raw`(49|5\d|60)\.\d{4,}`, 0.4],
  ], { reject: 0.3 }))

// ── L1 · Free text ──────────────────────────────────────────────────────────

algorithm('UK_FREE_TEXT', 'freeTextRedaction.FreeTextRedaction', {
  regularExpressions: [
    // National Insurance number, NHS number, UTR.
    String.raw`(?<![A-Za-z])[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]?(?![A-Za-z\d])`,
    String.raw`(?<![\d\-])\d{3}[\s\-]?\d{3}[\s\-]?\d{4}(?![\d\-])`,
    String.raw`(?<!\d)\d{5}\s?\d{5}(?!\d)`,
    String.raw`[\w.+\-]+@[\w\-]+(\.[\w\-]+)+`,
    String.raw`(?<![\d\-])(\+?44\s?(\(0\)\s?)?|\(?0)[1-35789]\d{1,3}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{3,4}(?![\d\-])`,
    String.raw`(?<!\d)\d{13,19}(?!\d)`,
    String.raw`(?i)(?<![A-Za-z\d])GB\d{2}\s?[A-Z]{4}(\s?\d{4}){3}\s?\d{2}(?![A-Za-z\d])`,
    // Postcodes and number plates.
    String.raw`(?<![A-Za-z\d])[A-Z]{1,2}\d[A-Z\d]?\s?\d[ABD-HJLNP-UW-Z]{2}(?![A-Za-z\d])`,
    String.raw`(?<![A-Za-z\d])[A-Z]{2}\d{2}\s?[A-Z]{3}(?![A-Za-z\d])`,
    String.raw`(?<!\d)(\d{1,3}\.){3}\d{1,3}(?!\d)`,
  ].map((patternString) => ({ patternString })),
  regExRedactValue: '[DATA]',
  lookupFile: { uri: file('uk-text-names.txt', unique([...GIVEN_NAMES, ...SURNAMES].flatMap((v) => [v, v.toUpperCase(), fold(v), fold(v).toUpperCase()]))) },
  lookupFileRedactValue: '[NAME]',
  isDenyList: true,
}, 'Customer Smith, NI number QQ 12 34 56 C, email mary.smith@example.co.uk, tel 07700 900123')

// Free Text Redaction looks at one word at a time, and UK numbers are written with spaces: QQ 12 34
// 56 C, 943 476 5919, 07700 900123, SW1A 2AA. A Regex Decompose first redacts those
// spaced forms in the text; the redaction then finds the rest word by word.
const SPACED = `(?<![A-Za-z\\d])(?:${[
  String.raw`[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} \d{2} ?\d{2} ?[A-D]?`,
  String.raw`\d{3} \d{3} \d{4}`,
  String.raw`\d{5} \d{5}`,
  String.raw`(?:\+44 ?(?:\(0\) ?)?|\(?0)\d{2,4}\)? \d{3,4} ?\d{3,4}`,
  String.raw`GB\d{2} [A-Z]{4}(?: \d{4}){3} \d{2}`,
  String.raw`[A-Z]{1,2}\d[A-Z\d]? \d[ABD-HJLNP-UW-Z]{2}`,
  String.raw`[A-Z]{2}\d{2} [A-Z]{3}`,
].join('|')})(?![A-Za-z\\d])`
const ANY = String.raw`([\s\S]*?)`
const DATA = redactAs('[DATA]')
// Up to four of them, the most first: a pattern matches the whole value.
decompose('UK_TEXT_SPACED', [4, 3, 2, 1].map((n) => [
  `${ANY}(${SPACED})`.repeat(n) + String.raw`([\s\S]*)`,
  ...Array.from({ length: n }, () => [keep, DATA]).flat(), keep,
]), keep, 'NI number AB 12 34 56 C, tel 07700 900123')
chain('UK_FREE_TEXT_ALL', ['UK_TEXT_SPACED', 'UK_FREE_TEXT'], 'Customer Smith, NI number AB 12 34 56 C, NHS 943 476 5919, tel 07700 900123, SW1A 2AA')

domain('UK_L1_FREE_TEXT', 'UK_FREE_TEXT_ALL',
  byName(['remarks?|comments?|notes?|observations?|narrative|free_?text|memo|messages?(?!_?(id|type|code|key|no|num|number|date|status|queue|count|log))|complaint(_?(text|details|description))?|description_?(of_?)?(case|complaint|incident|request|issue|problem|events)|incident_?(details|description|narrative)|case_?(notes?|summary|details)|statement|details|summary', 0.6]),
  byType(STRING(30)),
  byPattern([
    [String.raw`[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]`, 0.7],
    [String.raw`[\w.+\-]+@[\w\-]+\.[A-Za-z]{2,}`, 0.7],
    [String.raw`(\+44\s?|0)7\d{3}\s?\d{6}`, 0.6],
  ], { reject: 0, partial: true }))

// ── L2 · Quasi-identifiers ──────────────────────────────────────────────────

// Small shifts: large enough to break the link to the person, small enough that ages, school years
// and the 16th and 18th birthdays move for few people. Dates that combine with the birth date move less.
algorithm('UK_BIRTH_DATE', 'dateAlgorithms.DateShift', { minRange: -60, maxRange: 60, unit: 'DAYS', roll: false }, '1985-07-20')
algorithm('UK_EVENT_DATE', 'dateAlgorithms.DateShift', { minRange: -30, maxRange: 30, unit: 'DAYS', roll: false }, '2021-03-15')

domain('UK_L2_BIRTH_DATE', 'UK_BIRTH_DATE',
  byName(['dob|d_?o_?b|date_?of_?birth|birth_?date|birthdate|birthday|born_?(on|date)|bdate', 0.9]),
  byType(...DATES, STRING(6)))

// The decade stays and the unit is masked.
decompose('UK_YEAR', [[String.raw`(\d{3})(\d)`, keep, CM]], keep, '1985')
domain('UK_L2_BIRTH_YEAR', 'UK_YEAR',
  byName(['birth_?year|year_?of_?birth|yob|yr_?of_?birth', 0.9]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// 37 becomes 3x. From 100 on, 90.
decompose('UK_AGE', [
  [String.raw`([1-9]\d{2,})`, redactAs('90')],
  [String.raw`([1-9])(\d)(\.\d+)`, keep, CM, keep],
  [String.raw`([1-9])(\d)`, keep, CM],
  [String.raw`(\d)`, CM],
], keep, '37')
domain('UK_L2_AGE', 'UK_AGE',
  byName(['age(_?(years|yrs|in_?years|at_?(admission|death|entry|diagnosis|registration|referral)|group|range|band|bracket|last_?birthday))?|years_?old', 0.85]),
  byType(NUMBER(0, 6), STRING(0, 6)))

domain('UK_L2_EVENT_DATE', 'UK_EVENT_DATE',
  byName(['date_?of_?(death|marriage|civil_?partnership|divorce|dissolution|hire|employment|engagement|termination|dismissal|resignation|retirement|admission|discharge|diagnosis|referral|visit|appointment|consultation|delivery|arrest|charge|caution|conviction|sentence|sentencing|naturali[sz]ation|injury|surgery)|(death|marriage|divorce|hire|hiring|employment|employment_?start|start_?of_?employment|termination|leaving|resignation|retirement|admission|discharge|diagnosis|referral|appointment|visit|delivery|arrest|caution|conviction|sentencing|naturali[sz]ation|pension_?start|injury|vaccination|surgery|arrival)_?date|dod', 0.8]),
  byType(...DATES, STRING(6)))

// Each vocabulary replaced within itself: M/F stays M/F.
decompose('UK_SEX', [
  ['(?i)(female|male)', apply(lookup('UK_SEX_FEMALE_MALE', 'uk-sex-female-male.txt', ['Female', 'Male']))],
  ['(?i)(woman|man)', apply(lookup('UK_SEX_WOMAN_MAN', 'uk-sex-woman-man.txt', ['Woman', 'Man']))],
  ['(?i)([fm])', apply(lookup('UK_SEX_F_M', 'uk-sex-f-m.txt', ['F', 'M']))],
], keep, 'F')
domain('UK_L2_SEX', 'UK_SEX',
  byName(['sex(_?(code|at_?birth|registered|registered_?at_?birth))?|gender(?!_?(identity|expression|recognition))(_?code)?', 0.85]),
  // A column of single letters is the sex on its own; the words are stronger evidence.
  byList([
    ['uk-detect-sex.txt', ['female', 'male', 'woman', 'man', 'fem'], 0.8],
    ['uk-detect-sex-letter.txt', ['f', 'm'], 0.6],
  ], { reject: 0.5 }))

// ── L2 · Where people live ──────────────────────────────────────────────────
//
// A full postcode is a street, or part of one — about fifteen addresses. The outward code (SW1A, M1,
// G2) is a postcode district of thousands of addresses, the level at which the ONS and the NHS
// publish data; it stays, and the inward code (digit and two letters) is masked within the alphabet
// postcodes use, which leaves out C, I, K, M, O and V.

algorithm('UK_CM_INWARD', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'ABDEFGHJLNPQRSTUWXYZ', 'abdefghjlnpqrstuwxyz'],
  caseSensitive: true,
  minMaskedPositions: 0,
  preserveLeadingZeros: false,
}, '1AA')
decompose('UK_POSTCODE', [
  [String.raw`(?i)([a-z]{1,2}\d[a-z\d]?)(\s*)(\d[a-z]{2})`, keep, keep, apply('UK_CM_INWARD')],
], keep, 'SW1A 2AA')
domain('UK_L2_POSTCODE', 'UK_POSTCODE',
  byName(['post_?code|postcode|postal_?code|post_?cd|zip(_?code)?|pcode', 0.9]),
  byPattern([[String.raw`[A-Z]{1,2}\d[A-Z\d]?\s*\d[ABD-HJLNP-UW-Z]{2}`, 0.95]], { reject: 0.3 }))

// Towns. The United Kingdom has 4,643 places of more than 1,000 people in the GeoNames list, and
// 3,990 of them have fewer than 20,000 — with a birth date and a sex, one of them points at a
// handful of people. A small place becomes the main town of its local authority (council, unitary
// authority or county): a real place, shared by everyone in it. Every part of London becomes London.

const SMALL_PLACE = 20000
// The town that stands for each local authority: the largest, except where GeoNames gives a
// district's population to a single place, or where the county town is the one people name.
const SEATS = {
  Kent: 'Maidstone', Cornwall: 'Truro', 'Isles of Scilly': 'Hugh Town', 'Eilean Siar': 'Stornoway',
  Somerset: 'Taunton', 'Rhondda Cynon Taf': 'Pontypridd', 'Derbyshire': 'Chesterfield',
  'Knowsley': 'Huyton', 'Redcar and Cleveland': 'Redcar', 'Caerphilly County Borough': 'Caerphilly',
  'Lancashire': 'Preston', 'County of Flintshire': 'Mold', 'Neath Port Talbot': 'Neath',
}
const AREAS = unique(PLACES.map((p) => p.area))
const SEAT_OF = Object.fromEntries(AREAS.map((area) => {
  const here = PLACES.filter((p) => p.area === area)
  const seat = SEATS[area] ?? here.reduce((a, b) => (b.population > a.population ? b : a)).name
  if (!here.some((p) => p.name === seat)) throw new Error(`${seat} is not among the places of ${area}`)
  return [area, seat]
}))
const SEAT_NAMES = new Set(Object.values(SEAT_OF))
const keepsName = (p) => p.population >= SMALL_PLACE || SEAT_NAMES.has(p.name)
// Names as they are also written: "St" for "Saint", hyphens for spaces.
const writings = (name) => unique([name,
  ...(name.startsWith('Saint ') ? [name.replace('Saint ', 'St. '), name.replace('Saint ', 'St ')] : []),
  ...(name.startsWith('St ') ? [name.replace('St ', 'St. '), name.replace('St ', 'Saint ')] : []),
  ...(name.includes('-') ? [name.replace(/-/g, ' ')] : []),
].flatMap((n) => [n, n.replace(/'/g, '')]))
// A town that shares its name with its local authority (Bristol, York) is still a town; the nations are not.
const AREA_NAMES = new Set([...NATIONS, 'Great Britain', 'United Kingdom', 'UK'].map((n) => n.toLowerCase()))
/** Name → generalized name. A name shared by several places is generalized only when all are small. */
const placePairs = (() => {
  const byPlaceName = new Map()
  for (const p of PLACES) byPlaceName.set(p.name, [...(byPlaceName.get(p.name) ?? []), p])
  // Another writing of a name only where no place is called that: St Ives is a town of Cornwall, not
  // Saint Ives of Cambridgeshire written short.
  const real = new Set(byPlaceName.keys())
  for (const p of PLACES) for (const name of writings(p.name)) if (!real.has(name)) byPlaceName.set(name, [...(byPlaceName.get(name) ?? []), p])
  return [...byPlaceName.entries()].map(([name, all]) => {
    if (all.some(keepsName)) return [name, name]
    // Homonyms in two areas: the larger one decides.
    const p = all.reduce((a, b) => (b.population > a.population ? b : a))
    return [name, SEAT_OF[p.area]]
  })
})()
const variants = (pairs) => unique(pairs.flatMap(([from, to]) => [
  `${from}|${to}`, `${fold(from)}|${to}`, `${from.toUpperCase()}|${to.toUpperCase()}`, `${fold(from).toUpperCase()}|${fold(to).toUpperCase()}`,
])).map((line) => line.split('|'))
const PERSONAL_WORDS = new Set([...GIVEN_NAMES, ...SURNAMES].map((w) => fold(w).toLowerCase()))

cleansing('UK_TOWN', 'uk-town-generalized.txt', variants(placePairs), 'Grasmere', '|')
domain('UK_L2_TOWN', 'UK_TOWN',
  byName(
    ['town|village|hamlet|community(?!_?(service|group|organi[sz]ation|work|council|interest))|locality|settlement|home_?town|hometown|place_?of_?birth|birth_?place|birthplace|residence_?(town|village)|town_?of_?residence|post_?town|postal_?town', 0.85],
    ['city|municipality', 0.5],
  ),
  byList([['uk-detect-towns.txt', placePairs.map(([name]) => name).filter((n) => !PERSONAL_WORDS.has(fold(n).toLowerCase()) && !AREA_NAMES.has(n.toLowerCase())), 0.8]], { reject: 0.4 }))

// The most common nationalities of UK residents (ONS, Annual Population Survey).
const NATIONALITIES = ['British', 'Irish', 'Indian', 'Polish', 'Pakistani', 'Romanian', 'Italian', 'Portuguese', 'Nigerian', 'Chinese', 'Spanish', 'Bangladeshi', 'Lithuanian', 'French', 'German', 'American', 'Bulgarian', 'Filipino', 'South African', 'Ukrainian', 'Hong Kong']
lookup('UK_NATIONALITY', 'uk-nationalities.txt', NATIONALITIES, 'Latvian')
domain('UK_L2_NATIONALITY', 'UK_NATIONALITY',
  byName(['nationality|citizenship|country_?of_?(birth|origin|citizenship|nationality)|birth_?country', 0.8]),
  byList([['uk-detect-nationalities.txt', [...NATIONALITIES, 'english', 'scottish', 'welsh', 'northern irish', 'united kingdom', 'uk', 'gb', 'great britain', 'england', 'scotland', 'wales', 'ireland', 'india', 'poland', 'pakistan', 'romania', 'italy', 'portugal', 'nigeria', 'china', 'spain', 'bangladesh', 'lithuania', 'france', 'germany', 'united states', 'usa', 'us', 'bulgaria', 'philippines', 'south africa', 'ukraine', 'latvian', 'jamaican', 'somali'], 0.7]], { reject: 0.4 }))

// Legal partnership status as the 2021 census asks for it: civil partnerships next to marriages.
const MARITAL = ['Never married or civil partnered', 'Married', 'In a civil partnership', 'Separated', 'Divorced', 'Formerly in a civil partnership', 'Widowed', 'Surviving civil partner', 'Cohabiting']
lookup('UK_MARITAL_STATUS', 'uk-marital-status.txt', MARITAL, 'Cohabiting')
domain('UK_L2_MARITAL_STATUS', 'UK_MARITAL_STATUS',
  byName(['marital_?status|civil_?status|legal_?partnership_?status|partnership_?status|marriage_?status|relationship_?status|living_?arrangements?', 0.85]),
  byList([['uk-detect-marital-status.txt', [...MARITAL, 'single', 'married', 'civil partnership', 'civil partner', 'cohabiting', 'cohabitee', 'divorced', 'dissolved', 'widow', 'widower', 'widowed', 'separated'], 0.7]], { reject: 0.4 }))

lookup('UK_OCCUPATION', 'uk-occupations.txt', ['Administrator', 'Sales assistant', 'Retail manager', 'Care worker', 'Nurse', 'General practitioner', 'Teacher', 'Teaching assistant', 'Accountant', 'Software developer', 'Engineer', 'Solicitor', 'Electrician', 'Plumber', 'Builder', 'Carpenter', 'HGV driver', 'Delivery driver', 'Warehouse operative', 'Chef', 'Bar staff', 'Waiter', 'Cleaner', 'Security officer', 'Customer service adviser', 'Call centre agent', 'Receptionist', 'Hairdresser', 'Police officer', 'Civil servant', 'Project manager', 'Marketing executive', 'Farmer', 'Mechanic', 'Postal worker', 'Student', 'Retired', 'Self-employed', 'Unemployed', 'Homemaker'], 'Regional Operations Manager, North West')
domain('UK_L2_OCCUPATION', 'UK_OCCUPATION',
  byName(
    ['occupation|profession|job_?title|designation|post_?title|position_?title|soc_?(code|2020)', 0.8],
    ['job|position|post|trade(?!_?(name|mark|licen[cs]e))', 0.5],
  ))

lookup('UK_EMPLOYER', 'uk-employers.txt', ['Northfield Trading Ltd', 'Riverside Services Ltd', 'Albion Construction Ltd', 'Pennine Transport Ltd', 'Highland Foods Ltd', 'Severn Distribution Ltd', 'Coastal Hotels Ltd', 'Meadowbank Healthcare Ltd', 'Greenfield Academy Trust', 'Thames Valley Consulting LLP', 'Cotswold Stone Ltd', 'North Sea Fisheries Ltd', 'Bluebell Technologies Ltd', 'Sunrise Supermarkets Ltd', 'Builders Merchants Ltd', 'Harbourside Logistics Ltd', 'Clean Sweep Services Ltd', 'Crossroads Laboratories Ltd', 'Midland Import Export Ltd', 'Valley Auto Parts Ltd', 'Helping Hands Charity', 'Oak Tree Restaurants Ltd', 'Sentinel Security Ltd', 'Heritage Furniture Ltd', 'Contact Centre Partners Ltd'], 'Acme Widgets plc')
domain('UK_L2_EMPLOYER', 'UK_EMPLOYER',
  byName(['employer(_?name)?|name_?of_?employer|employer_?business_?name|company_?of_?employment|workplace|work_?place|place_?of_?(work|employment)|employed_?(at|by|with)|current_?employer|paye_?employer', 0.8]))

// Highest qualification, in the levels of the Regulated Qualifications Framework and the Scottish
// framework: GCSEs and Standard Grades, A levels and Highers, apprenticeships, degrees.
const EDUCATION = ['No qualifications', 'GCSE or equivalent', 'A level or equivalent', 'Scottish Highers', 'Apprenticeship', 'NVQ level 3', 'BTEC', 'HNC or HND', "Bachelor's degree", "Master's degree", 'Doctorate']
lookup('UK_EDUCATION', 'uk-education.txt', EDUCATION, 'A level or equivalent')
domain('UK_L2_EDUCATION', 'UK_EDUCATION',
  byName(['education(_?(level|attainment|status|completed))?|educational_?(level|attainment)|highest_?(level_?(of_?)?)?(education|qualification|grade)|level_?of_?education|qualifications?|schooling|rqf_?level|scqf_?level|nvq_?level', 0.8]),
  byList([['uk-detect-education.txt', [...EDUCATION, 'none', 'gcse', 'gcses', 'o level', 'cse', 'standard grade', 'national 5', 'a level', 'a levels', 'as level', 'higher', 'highers', 'advanced higher', 'nvq', 'svq', 'btec', 'hnc', 'hnd', 'apprenticeship', 'degree', 'bachelor', 'bachelors', 'ba', 'bsc', 'masters', 'msc', 'ma', 'phd', 'doctorate'], 0.6]], { reject: 0.4 }))

lookup('UK_SCHOOL', 'uk-schools.txt', ['Oakfield Primary School', "St Mary's Church of England Primary School", 'Holy Trinity Catholic Primary School', 'Riverside Infant School', 'Meadowbank Junior School', 'Hillcrest Academy', 'Northfield High School', 'Westgate Community College', 'Kingsway Grammar School', 'Valley View Secondary School', 'Brookside Sixth Form College', 'Moorland College of Further Education', 'Greenfield University', 'Lakeside Free School', 'Parkview Special School'], 'Eton College')
domain('UK_L2_SCHOOL', 'UK_SCHOOL',
  byName(['school(_?name)?|name_?of_?school|high_?school|primary_?school|secondary_?school|academy(_?name)?|sixth_?form|college(_?name)?|university(_?name)?|institution_?attended|alma_?mater|urn_?school|dfe_?(no|number)', 0.75]))

// Capped at 5 as text: large households are rare, and a rare count identifies.
decompose('UK_CAPPED_COUNT', [[String.raw`([0-5])`, keep], [String.raw`(\d+)`, redactAs('5')]], keep, '9')
domain('UK_L2_DEPENDANTS', 'UK_CAPPED_COUNT',
  byName(['dependants?|dependents?|no_?of_?(children|dependants|dependents|kids)|num(ber)?_?(of_?)?(children|dependants|dependents|kids)|children|household_?(size|members)|persons_?in_?household', 0.8]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// ── L3 · Special category data (Article 9) ──────────────────────────────────

// Genetic data (Article 4(13)): the inherited characteristics an analysis of a sample reveals.
domain('UK_L3_GENETIC', 'UK_REDACT',
  byName(['dna|genetic[a-z_]*|genome|genomic[a-z_]*|genotyp[a-z_]*|gene_?(test|result|marker|panel)|genetic_?(test|marker|profile|result)|mutation|brca[12]?|karyotype|paternity_?test|dna_?(profile|sample|index)|snp|haplotype|newborn_?(blood_?spot|screening)|heel_?prick|sickle_?cell_?(genotype|trait)|carrier_?status', 0.9]),
  // A nucleotide sequence (IUPAC letters) long enough not to be a word.
  byPattern([[String.raw`[ACGTUN]{24,}`, 0.9]], { reject: 0.3 }))

// Biometric data (Article 4(14)): facial images, fingerprints and other physical or behavioural
// characteristics processed to identify a person.
domain('UK_L3_BIOMETRIC', 'UK_REDACT',
  byName(['fingerprints?|finger_?prints?|thumb_?prints?|biometric[a-z_]*|face_?(template|encoding|id|print|hash|image)|facial_?(template|recognition|id|image|image_?hash)|photo(graph)?(_?(image|file|path|blob|data|url))?|passport_?photo|selfie|headshot|mugshot|custody_?image|iris(_?(scan|template|code))?|retina(_?scan)?|vein_?(pattern|scan)|palm_?(print|vein)|voice_?(print|template|sample|recording)|signature_?(image|biometric|capture|pad|specimen|scan)|specimen_?signature|handwritten_?signature|keystroke(_?(dynamics|pattern))?|typing_?pattern|gait(_?(pattern|analysis))?|minutiae', 0.9]),
  byType(STRING()))

// Racial or ethnic origin, in the ethnic groups of the 2021 census of England and Wales (Scotland and
// Northern Ireland ask nearly the same question).
const ETHNIC = ['White British', 'White Irish', 'Gypsy or Irish Traveller', 'Roma', 'Other White', 'White and Black Caribbean', 'White and Black African', 'White and Asian', 'Other Mixed', 'Indian', 'Pakistani', 'Bangladeshi', 'Chinese', 'Other Asian', 'African', 'Caribbean', 'Other Black', 'Arab', 'Any other ethnic group', 'Prefer not to say']
categorical('UK_ETHNICITY', 'uk-ethnic-groups.txt', ETHNIC, 'Kashmiri')
domain('UK_L3_ETHNICITY', 'UK_ETHNICITY',
  byName(['ethnic(ity|_?group|_?origin|_?background|_?identity|_?category|_?code)?|race|racial_?(origin|group|background)|traveller(_?status)?', 0.9]),
  byList([['uk-detect-ethnic-groups.txt', [...ETHNIC, 'white', 'white british', 'english', 'welsh', 'scottish', 'northern irish', 'british', 'irish', 'gypsy', 'irish traveller', 'traveller', 'roma', 'mixed', 'multiple', 'asian', 'asian british', 'indian', 'pakistani', 'bangladeshi', 'chinese', 'black', 'black british', 'african', 'caribbean', 'arab', 'other', 'not stated'], 0.9],
    // Self-identification is often a yes/no flag: it backs up the column name but decides nothing alone.
    ['uk-detect-flag.txt', ['y', 'n', 'yes', 'no', '0', '1'], 0.3],
  ], { reject: 0.4 }))

// Religious beliefs: the census answers, and the main denominations.
const RELIGIONS = ['No religion', 'Christian', 'Church of England', 'Church of Scotland', 'Roman Catholic', 'Church of Ireland', 'Presbyterian', 'Methodist', 'Baptist', 'Pentecostal', "Jehovah's Witness", 'Muslim', 'Hindu', 'Sikh', 'Jewish', 'Buddhist', 'Other religion', 'Prefer not to say']
categorical('UK_RELIGION', 'uk-religions.txt', RELIGIONS, 'Quaker')
domain('UK_L3_RELIGION', 'UK_RELIGION',
  byName(['religion[a-z_]*|religious_?(affiliation|denomination|belief|beliefs|preference|group)|denomination|faith|church(_?(name|affiliation|member|membership|attended))?|creed|congregation', 0.95]),
  byList([['uk-detect-religions.txt', [...RELIGIONS, 'none', 'no religion', 'atheist', 'agnostic', 'humanist', 'christian', 'anglican', 'church of england', 'cofe', 'c of e', 'catholic', 'rc', 'church of scotland', 'presbyterian', 'methodist', 'baptist', 'pentecostal', 'quaker', 'jehovah witness', 'muslim', 'islam', 'hindu', 'sikh', 'jewish', 'buddhist', 'other', 'not stated'], 0.9]], { reject: 0.4 }))

// Philosophical beliefs: no shared vocabulary, so suppressed. Employment tribunals have recognised
// ethical veganism and gender-critical beliefs as protected beliefs under the Equality Act 2010.
domain('UK_L3_BELIEF', 'UK_SUPPRESSED_CATEGORY',
  byName(['beliefs?|philosophical_?(beliefs?|convictions?)|conscientious_?objection|conscientious_?objector|moral_?(beliefs?|convictions?)|personal_?convictions?|worldview|ethical_?veganism', 0.9]))

// Political opinions: a leaning, and the party a person supports.
const IDEOLOGIES = ['Left', 'Centre-left', 'Centre', 'Centre-right', 'Right', 'No preference', 'Prefer not to say']
categorical('UK_POLITICAL_OPINION', 'uk-political-opinions.txt', IDEOLOGIES, 'Centre-right')
domain('UK_L3_POLITICAL_OPINION', 'UK_POLITICAL_OPINION',
  byName(['political_?(opinion|opinions|view|views|orientation|leaning|leanings|preference|ideology)|ideology|voting_?intention|vote_?intention|intended_?vote|swing_?voter|brexit_?vote|referendum_?vote|leave_?or_?remain', 0.9]),
  byList([['uk-detect-political-opinions.txt', [...IDEOLOGIES, 'left wing', 'right wing', 'centre left', 'center left', 'centre right', 'center right', 'center', 'liberal', 'conservative', 'progressive', 'socialist', 'undecided', 'leave', 'remain', 'swing'], 0.7]], { reject: 0.4 }))

// The parties of the four parliaments.
const PARTIES = ['Labour', 'Conservative', 'Liberal Democrats', 'Reform UK', 'Green Party', 'Scottish National Party', 'Plaid Cymru', 'Sinn Féin', 'Democratic Unionist Party', 'Alliance Party', 'SDLP', 'Ulster Unionist Party', 'Independent', 'No party']
categorical('UK_POLITICAL_PARTY', 'uk-political-parties.txt', PARTIES, 'Yorkshire Party')
domain('UK_L3_POLITICAL_AFFILIATION', 'UK_POLITICAL_PARTY',
  byName(
    ['political_?(party|body|membership|affiliation|group)|party_?(membership|member|affiliation|card|group|supporter|preference)|preferred_?party|member_?of_?(party|political_?(party|body))|party_?(of_?)?choice|vote_?(2019|2024)|general_?election_?vote', 0.95],
    ['party(?!_?(id|key|type|role|site|ref|code|number|no|size))', 0.5],
  ),
  byList([['uk-detect-political-parties.txt', [...PARTIES, 'labour party', 'conservative party', 'conservatives', 'tory', 'tories', 'lib dem', 'lib dems', 'liberal democrat', 'reform', 'green', 'greens', 'snp', 'plaid', 'sinn fein', 'dup', 'uup', 'alliance', 'tuv', 'independent', 'none', 'no party'], 0.8]], { reject: 0.4 }))

// Trade union membership.
domain('UK_L3_TRADE_UNION', 'UK_SUPPRESSED_CATEGORY',
  byName(['trade_?union(_?(member|membership|name|subs|subscription|dues))?|union_?(member|membership|affiliation|name|subs|subscription|dues|fees|code|branch|rep|representative)|unioni[sz]ed|labou?r_?union|bargaining_?unit|collective_?(agreement|bargaining)|check_?off|staff_?association|shop_?steward', 0.95]),
  byList([['uk-detect-trade-unions.txt', ['Unison', 'Unite', 'GMB', 'RCN', 'Royal College of Nursing', 'NEU', 'National Education Union', 'NASUWT', 'PCS', 'Usdaw', 'CWU', 'UCU', 'BMA', 'RMT', 'ASLEF', 'EIS', 'Prospect', 'FDA', 'Community', 'NAHT', 'Equity', "Musicians' Union", 'Unite the Union', 'TSSA', 'POA', 'FBU', 'Fire Brigades Union', 'TUC', 'STUC', 'unionised', 'unionized', 'union member'], 0.6]], { reject: 0.3 }))

// Sexual orientation, in the categories of the 2021 census.
const ORIENTATIONS = ['Straight or heterosexual', 'Gay or lesbian', 'Bisexual', 'Pansexual', 'Asexual', 'Queer', 'Other sexual orientation', 'Prefer not to say']
categorical('UK_SEXUAL_ORIENTATION', 'uk-sexual-orientations.txt', ORIENTATIONS, 'Bisexual')
domain('UK_L3_SEXUAL_ORIENTATION', 'UK_SEXUAL_ORIENTATION',
  byName(['sexual_?(orientation|preference|identity)|orientation_?sexual|orient_?sexual|msm(_?(status|flag))?|lgbt(q|qi|qia)?(_?(status|flag))?', 0.95]),
  byList([['uk-detect-sexual-orientations.txt', [...ORIENTATIONS, 'straight', 'heterosexual', 'gay', 'lesbian', 'homosexual', 'bi', 'queer', 'lgbt', 'lgbtq', 'lgbtq+', 'prefer not to say'], 0.8]], { reject: 0.4 }))

domain('UK_L3_SEXUAL_LIFE', 'UK_SUPPRESSED_CATEGORY',
  byName(['sex(ual)?_?life|sexual_?(activity|behaviou?r|history|partners?|practices?)|sexually_?active|number_?of_?sexual_?partners|age_?(at_?)?first_?(sex|intercourse)|sex_?work(er)?', 0.9]))

// Gender identity: not an Article 9 category by name, but section 22 of the Gender Recognition Act
// 2004 makes it an offence to disclose, from official information, that a person applied for or holds
// a gender recognition certificate — and a copy of production data is a disclosure. The 2021 census
// question is whether the gender a person identifies with is the sex registered at birth.
const IDENTITIES = ['Same as sex registered at birth', 'Trans woman', 'Trans man', 'Non-binary', 'Other gender identity', 'Prefer not to say']
categorical('UK_GENDER_IDENTITY', 'uk-gender-identities.txt', IDENTITIES, 'Trans man')
domain('UK_L3_GENDER_IDENTITY', 'UK_GENDER_IDENTITY',
  byName(['gender_?(identity|expression|recognition(_?(certificate|cert|status))?|reassignment|same_?as_?birth)|grc(_?(holder|status|issued|date|no|number))?|preferred_?pronouns?|pronouns?|transgender|trans_?(status|history)|gender_?same_?as_?sex', 0.95]),
  byList([['uk-detect-gender-identities.txt', [...IDENTITIES, 'cisgender', 'transgender', 'trans', 'nonbinary', 'non binary', 'female', 'male', 'woman', 'man'], 0.7],
    // Holding a certificate is often a yes/no flag: it backs up the column name but decides nothing alone.
    ['uk-detect-flag.txt', ['y', 'n', 'yes', 'no', '0', '1'], 0.3],
  ], { reject: 0.4 }))

// ── HEALTH · Data concerning health (Article 9) ─────────────────────────────

domain('UK_HEALTH_ID', 'UK_CM_ALNUM',
  byName(
    ['medical_?record(_?(no|num|number))?|mrn|hospital_?(no|num|number|id)|patient_?(id|no|num|number)|case_?note_?(no|number)|pas_?(id|no|number)|chart_?(no|num|number)|health_?(record|card|id)(_?(no|num|number))?|ehic(_?(no|number))?|ghic(_?(no|number))?|admission_?(no|num|number)|prescription_?(no|num|number)|fit_?note_?(no|number|ref)|gp_?(practice_?)?(code|id)|ods_?code|practice_?code', 0.85],
    ['chart|admission|episode', 0.55],
  ))

const ICD10 = ['I10', 'E11', 'E78', 'J45', 'J06', 'J02', 'J20', 'K29', 'K21', 'K59', 'M54', 'M17', 'M25', 'N39', 'N20', 'R51', 'R10', 'H10', 'H66', 'L23', 'L30', 'B34', 'A09', 'E03', 'E66', 'D50', 'I83', 'K80', 'K40', 'S93', 'S60', 'Z00', 'J30', 'J32', 'G43', 'M79', 'R05']
const ICD10_DECIMAL = ['E11.9', 'E78.5', 'J45.9', 'J06.9', 'J02.9', 'J20.9', 'K29.7', 'K21.9', 'K59.0', 'M54.5', 'M17.9', 'N39.0', 'N20.0', 'R10.4', 'H10.9', 'H66.9', 'L23.9', 'L30.9', 'B34.9', 'A09.9', 'E03.9', 'E66.9', 'D50.9', 'I83.9', 'K80.2', 'K40.9', 'S93.4', 'S60.0', 'Z00.0', 'J30.4', 'J32.9', 'G43.9', 'M79.1']
decompose('UK_DIAGNOSIS', [
  [String.raw`([A-TV-Za-tv-z]\d{2}\.\d{1,2})`, apply(lookup('UK_ICD10_DECIMAL', 'uk-icd10-decimal.txt', ICD10_DECIMAL, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [String.raw`([A-TV-Za-tv-z]\d{2,3})`, apply(lookup('UK_ICD10', 'uk-icd10.txt', ICD10, undefined, 'PRESERVE_LOOKUP_FILE'))],
  // A SNOMED CT concept: six to eighteen digits, given other digits.
  [String.raw`(\d{6,18})`, CM],
  [FLAG, apply('UK_FLAG')],
], apply(lookup('UK_DIAGNOSIS_TEXT', 'uk-diagnoses.txt', ['Essential hypertension', 'Type 2 diabetes mellitus', 'Asthma', 'Low back pain', 'Chronic gastritis', 'Common cold', 'Urinary tract infection', 'Migraine', 'Hypothyroidism', 'Hyperlipidaemia', 'Obesity', 'Osteoarthritis of the knee', 'Acute bronchitis', 'Tonsillitis', 'Contact dermatitis', 'Otitis media', 'Ankle sprain', 'Conjunctivitis', 'Iron deficiency anaemia', 'Gastro-oesophageal reflux disease', 'Irritable bowel syndrome', 'Tendinitis', 'Sinusitis', 'Tension headache', 'Varicose veins', 'Inguinal hernia', 'Kidney stones', 'Gallstones', 'Gastroenteritis', 'Routine health check'])), 'F32.9')
domain('UK_HEALTH_DIAGNOSIS', 'UK_DIAGNOSIS',
  byName(['diagnos(is|es|tic)[a-z_]*|dx|icd_?(10|11)?(_?code)?|snomed(_?(ct|code|concept))?|read_?code|ctv3|medical_?(condition|history|problem|diagnosis)|health_?(condition|problem)|long_?term_?condition|chronic_?(condition|disease|illness)|illness(es)?|disease[a-z_]*|comorbidit(y|ies)|allerg(y|ies)|cause_?of_?(death|admission|illness|injury|absence)|reason_?for_?(visit|admission|referral|absence|sickness)|presenting_?complaint|chief_?complaint|pre_?existing_?conditions?', 0.85]),
  // 0.5: codes shaped like ICD-10 appear in other catalogs too; the name has to agree.
  byPattern([[String.raw`[A-TV-Za-tv-z]\d{2}(\.\d{1,2}|\d)?`, 0.5]], { reject: 0.3 }))

const MEDICATIONS = ['Paracetamol', 'Ibuprofen', 'Naproxen', 'Co-codamol', 'Metformin', 'Gliclazide', 'Ramipril', 'Lisinopril', 'Amlodipine', 'Atorvastatin', 'Simvastatin', 'Omeprazole', 'Lansoprazole', 'Levothyroxine', 'Amoxicillin', 'Flucloxacillin', 'Salbutamol', 'Beclometasone', 'Cetirizine', 'Aspirin', 'Prednisolone', 'Bendroflumethiazide', 'Ferrous sulfate', 'Folic acid', 'Colecalciferol', 'Doxycycline']
categorical('UK_MEDICATION', 'uk-medications.txt', MEDICATIONS, 'Sertraline 50 mg')
domain('UK_HEALTH_MEDICATION', 'UK_MEDICATION',
  byName(['medications?|medicines?|drugs?_?(name|prescribed)|prescribed_?(drugs?|medications?|items?)|prescription_?(drug|medication|item)s?|repeat_?prescriptions?|active_?ingredient|dosage|treatment_?(drug|medication)', 0.85]),
  byList([['uk-detect-medications.txt', [...MEDICATIONS, 'sertraline', 'fluoxetine', 'citalopram', 'mirtazapine', 'quetiapine', 'diazepam', 'lithium', 'methylphenidate', 'risperidone', 'olanzapine', 'methadone', 'buprenorphine', 'tenofovir', 'emtricitabine', 'dolutegravir', 'prep', 'insulin', 'warfarin', 'apixaban', 'levetiracetam', 'sodium valproate', 'naltrexone', 'misoprostol', 'levonorgestrel', 'desogestrel'], 0.7]], { reject: 0.3 }))

domain('UK_HEALTH_CLINICAL_TEXT', 'UK_FREE_TEXT_ALL',
  byName(['clinical_?notes?|progress_?notes?|nurs(e|ing)_?notes?|doctors?_?notes?|gp_?notes?|consultation_?notes?|medical_?notes?|discharge_?(summary|letter|notes?)|clinic_?letter|referral_?letter|clinical_?summary|history_?of_?present(ing)?_?illness|hpi|physical_?exam(ination)?|assessment_?(and_?)?plan|treatment_?plan|care_?plan|triage_?notes?|soap_?notes?', 0.85]),
  byType(STRING(30)))

domain('UK_HEALTH_TEST_RESULT', 'UK_CM_ALNUM',
  byName(
    ['lab_?(result|test|value)s?|test_?results?|pathology_?(result|report)s?|laboratory_?(result|test)s?|hiv(_?(status|test|result))?|viral_?load|cd4(_?count)?|blood_?(sugar|glucose|pressure)|glucose|hba1c|cholesterol|egfr|bmi|pregnancy_?test|drug_?(test|screen)|covid_?(test|result)|pcr_?result|lateral_?flow(_?result)?|smear_?(test|result)|cervical_?screening(_?result)?|mammogram_?result|x_?ray_?result|psa(_?result)?', 0.8],
    ['result|test', 0.5],
  ))

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']
domain('UK_HEALTH_BLOOD_GROUP', ENGINE.BLOOD_TYPE,
  byName(['blood_?(type|group)|abo(_?rh)?|rh_?factor|rh|rhesus', 0.9]),
  byList([['uk-detect-blood-groups.txt', [...BLOOD_GROUPS, '0+', '0-', 'a pos', 'a neg', 'b pos', 'b neg', 'ab pos', 'ab neg', 'o pos', 'o neg', 'a positive', 'a negative', 'b positive', 'b negative', 'ab positive', 'ab negative', 'o positive', 'o negative'], 0.9]], { reject: 0.4 }))

// Disability as the 2021 census asks for it (the Equality Act 2010 definition: a condition that
// limits day-to-day activities), and the impairment types of NHS and education returns.
const DISABILITIES = ['Disabled: limited a lot', 'Disabled: limited a little', 'Not disabled', 'Visual impairment', 'Hearing impairment', 'Mobility impairment', 'Learning disability', 'Mental health condition', 'Long-term illness', 'Multiple impairments']
categorical('UK_DISABILITY', 'uk-disabilities.txt', DISABILITIES, 'Severe psychosocial disability')
domain('UK_HEALTH_DISABILITY', 'UK_DISABILITY',
  byName(['disabilit(y|ies)[a-z_]*|disabled|impairments?|handicap(ped)?|special_?(educational_?)?needs|sen(d)?(_?(status|support|provision))?|ehcp|education_?health_?(and_?)?care_?plan|blue_?badge|reasonable_?adjustments?|limited_?(a_?lot|a_?little)|day_?to_?day_?activities_?limited|access_?to_?work', 0.9]),
  byList([['uk-detect-disabilities.txt', [...DISABILITIES, 'yes limited a lot', 'yes limited a little', 'no', 'disabled', 'not disabled', 'visual', 'blind', 'deaf', 'hearing impaired', 'physical', 'mobility', 'learning', 'autism', 'adhd', 'dyslexia', 'mental health', 'multiple', 'none', 'no disability'], 0.6]], { reject: 0.3 }))

// Reproductive and mental health: the values have no shared vocabulary, so they are suppressed
// (flags and numeric codes keep their shape).
domain('UK_HEALTH_REPRODUCTIVE', 'UK_SUPPRESSED_CATEGORY',
  byName(['pregnan(t|cy)[a-z_]*|gestation(al)?(_?age)?|weeks_?(of_?)?(pregnancy|gestation)|lmp|last_?menstrual_?period|edd|estimated_?due_?date|abortions?|termination_?of_?pregnancy|miscarriages?|contracepti(on|ve)[a-z_]*|family_?planning(_?method)?|fertility|infertility|ivf|gravida|parity|antenatal|maternity_?(status|care)|postnatal|postpartum|sti|sexually_?transmitted(_?infection)?|sexual_?health', 0.9]))

domain('UK_HEALTH_MENTAL', 'UK_SUPPRESSED_CATEGORY',
  byName(['mental_?(health|illness|disorder|condition)|psychiatr[a-z_]*|psycholog[a-z_]*|depression|anxiety|suicid[a-z_]*|self_?harm|sectioned|mental_?health_?act(_?(section|status))?|substance_?(use|abuse|misuse)|alcohol(ism|_?use|_?abuse|_?dependence)|drug_?(use|abuse|misuse|addiction|dependence)|addiction[a-z_]*|iapt|talking_?therapies|camhs', 0.9]))

// ── FIN · Financial data ────────────────────────────────────────────────────
//
// Not special category under the UK GDPR, but kept under the banker's duty of confidence (Tournier
// v National Provincial, 1924) and the rules of the FCA, and shared by credit reference agencies
// under the Consumer Credit Act 1974. Reduced to a balance, an income or a benefit, it still identifies.

decompose('UK_CREDIT', [
  // A credit score (three or four digits) gets other digits; flags stay flags.
  [String.raw`(\d{2,4})`, CM],
  [FLAG, apply('UK_FLAG')],
], apply(lookup('UK_CREDIT_STATUS', 'uk-credit-statuses.txt', ['Up to date', '1 payment missed', '2 payments missed', '3 payments missed', 'In arrears', 'Default', 'Arrangement to pay', 'County Court Judgment', 'Individual Voluntary Arrangement', 'Debt Relief Order', 'Bankruptcy', 'Settled', 'No credit history'])), '3 payments missed')
domain('UK_FIN_CREDIT_REFERENCE', 'UK_CREDIT',
  byName(['credit_?(score|rating|history|report|status|file|reference|risk|grade|standing)|experian(_?(score|report|status))?|equifax(_?(score|report|status))?|transunion(_?(score|report|status))?|ccj(s)?|county_?court_?judg(e)?ments?|iva|individual_?voluntary_?arrangement|debt_?relief_?order|dro|bankrupt(cy)?(_?(status|flag|date))?|insolven(cy|t)(_?(status|flag))?|delinquen(cy|t)(_?(status|days))?|days_?(past_?due|in_?arrears|overdue)|dpd|arrears(_?(status|days))?|missed_?payments?|default_?(status|flag|indicator)|defaulted|written_?off|write_?off(_?(status|flag))?|collections?_?status|bad_?debt|loan_?(status|classification|grade)', 0.9]))

domain('UK_FIN_DEBT', ENGINE.CM_NUMERIC,
  byName(['loan_?(amount|balance|principal|outstanding)|outstanding_?(balance|amount|debt|loan|principal)|debt(_?(amount|total|balance))?|amount_?(owed|due|outstanding|in_?arrears|overdue)|balance_?(owed|outstanding|due)|arrears_?amount|credit_?limit|overdraft(_?(limit|balance))?|mortgage_?(balance|amount)|instal?ment(_?amount)?|monthly_?(payment|repayment)', 0.85]),
  byType(NUMBER()))

domain('UK_FIN_INCOME', ENGINE.CM_NUMERIC,
  byName(['salary|salaries|wages?|income[a-z_]*|gross_?(pay|salary|income|earnings)|net_?(pay|salary|income|earnings)|(monthly|annual|weekly|fortnightly)_?(income|salary|earnings|pay|wage)|earnings|remuneration|basic_?(pay|salary)|take_?home_?pay|household_?income|taxable_?pay|p60_?pay|bonus(_?amount)?', 0.85]),
  byType(NUMBER()))

domain('UK_FIN_ASSETS', ENGINE.CM_NUMERIC,
  byName(['net_?worth|assets?_?(value|total)|total_?assets|property_?value|house_?value|market_?value|valuation(_?amount)?|savings(_?balance)?|account_?balance|current_?balance|deposit_?balance|isa_?(balance|value)|investment_?(balance|value|amount)|share_?(holding|value)|capital_?(savings|value)', 0.85]),
  byType(NUMBER()))

domain('UK_FIN_PENSION', ENGINE.CM_NUMERIC,
  byName(['pension(_?(amount|payment|monthly|weekly|annual|benefit_?amount|balance|pot|value))?|monthly_?pension|state_?pension(_?amount)?|retirement_?(pension|benefit|amount|balance)|pension_?pot|annuity(_?amount)?|lump_?sum|transfer_?value|superannuation(_?(balance|amount))?', 0.9]),
  byType(NUMBER()))

// Benefits of the DWP, HMRC and the councils. Most reveal a health condition, a disability or caring
// responsibilities: PIP, DLA, ESA and Attendance Allowance are paid because of one.
const BENEFITS = ['Universal Credit', 'Personal Independence Payment', 'Disability Living Allowance', 'Employment and Support Allowance', "Jobseeker's Allowance", 'Pension Credit', 'State Pension', 'Child Benefit', "Carer's Allowance", 'Attendance Allowance', 'Housing Benefit', 'Council Tax Reduction', 'None']
categorical('UK_BENEFIT', 'uk-benefits.txt', BENEFITS, 'Bereavement Support Payment')
domain('UK_FIN_BENEFIT', 'UK_BENEFIT',
  byName(['benefits?_?(type|claim|category|name|code|status|received|entitlement)|claim_?type|universal_?credit(_?(status|claimant|flag))?|uc_?(claimant|status|flag)|pip(_?(award|rate|status))?|dla(_?(award|rate|status))?|esa(_?(status|group))?|jsa(_?(status))?|pension_?credit|child_?benefit|carers?_?allowance|attendance_?allowance|housing_?benefit|council_?tax_?(reduction|support|benefit)|dwp_?(benefit|claim)|in_?receipt_?of_?benefits?|welfare_?(benefit|status)|free_?school_?meals|fsm(_?(eligible|status|flag))?', 0.9]),
  byList([['uk-detect-benefits.txt', [...BENEFITS, 'uc', 'pip', 'dla', 'esa', 'jsa', 'universal credit', 'pension credit', 'state pension', 'child benefit', 'carers allowance', 'attendance allowance', 'housing benefit', 'council tax reduction', 'tax credits', 'working tax credit', 'child tax credit', 'none'], 0.8],
    // Being a claimant is often a yes/no flag: it backs up the column name but decides nothing alone.
    ['uk-detect-flag.txt', ['y', 'n', 'yes', 'no', '0', '1'], 0.3],
  ], { reject: 0.4 }))

// The Indices of Multiple Deprivation rank small areas: a decile or quintile, and the neighbourhood
// it comes from, say much about a household.
decompose('UK_DEPRIVATION', [
  [String.raw`([1-5])`, apply(lookup('UK_QUINTILE', 'uk-quintile.txt', ['1', '2', '3', '4', '5']))],
  [String.raw`([6-9]|10)`, apply(lookup('UK_DECILE_HIGH', 'uk-decile-high.txt', ['6', '7', '8', '9', '10']))],
  [String.raw`(?i)(decile\s*)(\d{1,2})`, keep, apply(lookup('UK_DECILE', 'uk-decile.txt', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']))],
  [String.raw`(?i)(quintile\s*)([1-5])`, keep, apply('UK_QUINTILE')],
  // A rank among the 33,755 LSOAs of England (or the areas of the other nations): other digits.
  [String.raw`(\d{2,5})`, CM],
], apply(lookup('UK_DEPRIVATION_STATUS', 'uk-deprivation-statuses.txt', ['Most deprived', 'Deprived', 'Average', 'Less deprived', 'Least deprived'], undefined, 'PRESERVE_LOOKUP_FILE')), 'Most deprived')
domain('UK_FIN_DEPRIVATION', 'UK_DEPRIVATION',
  byName(['imd(_?(decile|quintile|rank|score))?|simd(_?(decile|quintile|rank))?|wimd(_?(decile|quintile|rank))?|nimdm(_?(decile|rank))?|index_?of_?multiple_?deprivation|deprivation(_?(decile|quintile|rank|score|index|level))?|idaci(_?(decile|score))?|socio_?economic_?(status|class|classification|group|index)|ns_?sec|acorn(_?(category|group))?|mosaic(_?(group|type))?|income_?(quintile|decile|bracket|band)|quintile|decile', 0.9]),
  byList([['uk-detect-deprivation.txt', ['most deprived', 'deprived', 'least deprived', 'less deprived', 'average', 'affluent', 'low', 'middle', 'high'], 0.4]], { reject: 0.3 }))

// Tenure as the 2021 census asks for it.
const TENURES = ['Owned outright', 'Owned with a mortgage', 'Shared ownership', 'Social rented from council', 'Social rented from housing association', 'Private rented', 'Lives rent free', 'Temporary accommodation', 'Other']
categorical('UK_HOUSING', 'uk-housing-tenure.txt', TENURES, 'Sofa surfing')
domain('UK_FIN_HOUSING', 'UK_HOUSING',
  byName(
    ['housing_?(tenure|status|type|situation|need)|dwelling_?(tenure|ownership|type)|home_?ownership|own_?or_?rent|rent_?or_?own|owns_?(home|house)|homeless(ness)?(_?(status|duty|flag))?|temporary_?accommodation|council_?tenant|social_?housing', 0.95],
    ['tenure', 0.55],
  ),
  byList([['uk-detect-housing-tenure.txt', [...TENURES, 'owned', 'owner occupied', 'mortgage', 'mortgaged', 'rent', 'rented', 'renting', 'council', 'housing association', 'private rented', 'rent free', 'shared ownership', 'homeless', 'temporary accommodation', 'lodger'], 0.6]], { reject: 0.3 }))

// ── PENAL · Criminal convictions and offences (Article 10; DPA 2018 s. 11(2)) ─
//
// Section 11(2) of the Act extends Article 10 to the alleged commission of offences and to the
// proceedings and their disposal. The Rehabilitation of Offenders Act 1974 lets convictions and
// cautions become spent: a copy that keeps them undoes that.

categorical('UK_CRIMINAL_RECORD', 'uk-criminal-record.txt', ['No convictions', 'Unspent conviction', 'Spent conviction', 'Caution', 'Conditional caution', 'Youth caution', 'Penalty notice', 'Charged', 'Acquitted', 'Convicted', 'No further action', 'Not stated'], 'Convicted of theft, 2019')
domain('UK_PENAL_CRIMINAL_RECORD', 'UK_CRIMINAL_RECORD',
  byName(
    ['criminal_?(record|history|conviction|convictions|status|background|charges?|proceedings|case_?(status|outcome))|police_?(record|caution|report_?status)|convictions?(_?(status|record|details))?|unspent_?convictions?|spent_?convictions?|convicted|previous_?convictions|cautions?(_?(status|details|record))?|offen[cs]es?(_?(type|committed|code|description|details))?|charged_?with|arrests?(_?(record|history))?|sentence(_?(imposed|type|length|details))?|custodial_?sentence|incarcerat(ed|ion)|imprisonment|prison(_?(status|release))?|remand(ed)?(_?status)?|bail(_?status)?|probation(_?status)?|licen[cs]e_?conditions|parole|verdict|acquitt(al|ed)|nfa|no_?further_?action', 0.95],
    ['court_?(outcome|disposal|decision|status)|case_?(outcome|disposal)|disposal', 0.55],
  ))

domain('UK_PENAL_CASE_NUMBER', 'UK_CM_ALNUM',
  byName(
    ['court_?case_?(no|num|number|ref)|criminal_?case_?(no|num|number)|indictment_?(no|num|number)|pnc_?(id|no|number|ref)|police_?national_?computer_?(id|no|number)|cro_?(no|number)|crime_?(ref|reference|no|number)|crime_?report_?(no|number)|police_?(ref|reference|report_?(no|number)|incident_?(no|number))|custody_?(no|number|record_?(no|number))|urn_?(police|case)|case_?urn|prisoner_?(no|number)|prison_?(no|number)|noms_?(no|number|id)|nomis_?(id|no|number)', 0.9],
    ['case_?(no|num|number|ref|reference)', 0.55],
  ),
  byPattern([
    // A PNC identifier (year/serial and a check letter), a Crown Court case number.
    [String.raw`\d{2,4}/\d{1,7}[A-HJ-NP-RT-Z]`, 0.7],
    [String.raw`[TSA]\d{8}`, 0.5],
  ], { reject: 0.3 }))

// Disclosure and Barring Service checks (Disclosure Scotland and AccessNI in the other nations): the
// certificate number, the level and the outcome all say whether a record was found.
decompose('UK_DBS', [
  [String.raw`(\d{6,14})`, CM],
  [FLAG, apply('UK_FLAG')],
], apply(lookup('UK_DBS_OUTCOME', 'uk-dbs-outcomes.txt', ['Basic', 'Standard', 'Enhanced', 'Enhanced with barred list', 'Clear', 'Information disclosed', 'Pending'])), '001234567890')
domain('UK_PENAL_DBS', 'UK_DBS',
  byName(['dbs(_?(cert|certificate|no|num|number|ref|reference|check|status|level|result|outcome|date|update_?service))?|crb(_?(cert|check|no|number|status))?|disclosure_?(cert|certificate|no|number|level|result|outcome)|disclosure_?scotland|pvg(_?(no|number|scheme|membership|status))?|access_?ni(_?(no|number|check|status))?|barred_?list(_?(check|status))?|barring_?status', 0.95]))

// ── Preset ──────────────────────────────────────────────────────────────────

const referenced = JSON.stringify([domains, algorithms.map((x) => x.config)])
const orphans = algorithms.filter((a) => !referenced.includes(`"${a.name}"`))
if (orphans.length) throw new Error(`algorithms nobody uses: ${orphans.map((a) => a.name).join(', ')}`)

// The essential pack: identity documents, names, contact, address and birth date. Loading it brings
// these domains and only what they lean on; the extended pack is everything.
const ESSENTIAL = [
  'UK_L1_NINO', 'UK_L1_NHS_NUMBER', 'UK_L1_PASSPORT', 'UK_L1_DRIVING_LICENCE',
  'UK_L1_GIVEN_NAME', 'UK_L1_SURNAME', 'UK_L1_FULL_NAME', 'UK_L1_EMAIL', 'UK_L1_PHONE',
  'UK_L1_ADDRESS', 'UK_L1_ADDRESS_DETAIL', 'UK_L2_POSTCODE', 'UK_L2_BIRTH_DATE',
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
  country: 'GB',
  name: {
    en: 'United Kingdom — UK GDPR and Data Protection Act 2018 (data protection)',
    'pt-BR': 'Reino Unido — UK GDPR e Data Protection Act 2018 (proteção de dados)',
    es: 'Reino Unido — UK GDPR y Data Protection Act 2018 (protección de datos)',
  },
  summary: {
    en: 'Discovers and masks UK personal data under the UK GDPR and the Data Protection Act 2018, as amended by the Data (Use and Access) Act 2025: direct identifiers (National Insurance number, NHS number, UTR, names, contact, documents, bank details), quasi-identifiers (birth date, postcode, town), the special categories of Article 9 — ethnic origin, political opinions, beliefs, trade union membership, genetic, biometric and health data, sex life and sexual orientation — criminal offence data, and financial data.',
    'pt-BR': 'Descobre e mascara dados pessoais do Reino Unido segundo o UK GDPR e o Data Protection Act 2018, com as alterações do Data (Use and Access) Act 2025: identificadores diretos (National Insurance number, NHS number, UTR, nomes, contato, documentos, dados bancários), quase-identificadores (data de nascimento, postcode, cidade), as categorias especiais do artigo 9 — origem étnica, opiniões políticas, crenças, filiação sindical, dados genéticos, biométricos e de saúde, vida sexual e orientação sexual —, dados de infrações penais e dados financeiros.',
    es: 'Descubre y enmascara datos personales del Reino Unido conforme al UK GDPR y la Data Protection Act 2018, con las modificaciones de la Data (Use and Access) Act 2025: identificadores directos (National Insurance number, NHS number, UTR, nombres, contacto, documentos, datos bancarios), cuasi-identificadores (fecha de nacimiento, postcode, ciudad), las categorías especiales del artículo 9 — origen étnico, opiniones políticas, creencias, afiliación sindical, datos genéticos, biométricos y de salud, vida sexual y orientación sexual —, datos de infracciones penales y datos financieros.',
  },
  profileSet: {
    name: `UK - UK GDPR and DPA 2018 - v${VERSION}`,
    description: 'UK GDPR and DPA 2018 - personal data',
    threshold: 60,
    classifiers: classifiers.map((c) => c.name),
  },
  packs: {
    essential: {
      description: 'Essential pack of the UK GDPR and DPA 2018',
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

const generalized = PLACES.filter((p) => !keepsName(p)).length
console.log(`${domains.length} domains, ${classifiers.length} classifiers, ${algorithms.length} algorithms, ${files.size} files; ${generalized} of ${PLACES.length} places generalized`)
