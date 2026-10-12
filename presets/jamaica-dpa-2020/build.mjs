#!/usr/bin/env node
/**
 * Builds the Jamaica (Data Protection Act, 2020) pre-configured profile set: preset.json and files/.
 *
 *   node presets/jamaica-dpa-2020/build.mjs
 *
 * source/ holds the hand-kept lists (given names, surnames, streets, Kingston and St. Andrew
 * neighbourhoods) and the 140 towns of the 2022 census with their parish and population. Everything
 * in files/ and preset.json is generated from them and from the definitions below — edit here, then
 * build, then run verify.mjs.
 *
 * Structure of the set
 *   L1      direct identifiers        TRN, NIS number, names, contact, documents…
 *   L2      quasi-identifiers         birth date, age, sex, town, neighbourhood, occupation…
 *   L3      sensitive personal data   the section 2 categories: genetic and biometric data (the Act
 *                                     counts photographs, height, eye colour and blood type as
 *                                     biometric), filiation, racial or ethnic origin, political
 *                                     opinions, religious, philosophical or similar beliefs, trade
 *                                     union membership and sex life
 *   HEALTH  physical or mental health or condition (s. 2, sensitive)
 *   FIN     financial data            not sensitive under the Act, but confidential by other laws
 *                                     (Banking Services Act, Credit Reporting Act)
 *   PENAL   the commission or alleged commission of an offence, and its proceedings (s. 2, sensitive)
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

/**
 * A Data Cleansing of place codes, looked up without the zeros on the left, which stay where they are:
 * 05364, 5364 and 0005364 all become the same place. Only for codes — check-digit tables keep their
 * zeros, which count there.
 */
function codeCleansing(name, fileName, pairs, input, delimiter = ',') {
  for (const [from, to] of pairs) if (from.includes(delimiter) || to.includes(delimiter)) throw new Error(`${fileName}: "${from}" holds the delimiter`)
  if (!pairs.every(([from, to]) => /^\d+$/.test(from) && /^\d+$/.test(to))) throw new Error(`${fileName}: not a table of codes`)
  // The zero-free forms join the table.
  const strip = (code) => code.replace(/^0+(?=\d)/, '')
  const rows = new Map(pairs)
  const stripped = new Map()
  for (const [from, to] of pairs) {
    const [key, value] = [strip(from), strip(to)]
    if (stripped.has(key) && stripped.get(key) !== value) throw new Error(`${fileName}: ${key} becomes ${stripped.get(key)} and ${value}`)
    stripped.set(key, value)
    if (rows.has(key) && rows.get(key) !== value) throw new Error(`${fileName}: ${key} becomes ${rows.get(key)} and, without zeros, ${value}`)
    rows.set(key, value)
  }
  cleansing(`${name}_TABLE`, fileName, [...rows], input, delimiter)
  return decompose(name, [[String.raw`(0*)([1-9]\d*)`, keep, apply(`${name}_TABLE`)]], keep, input)
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
  description: 'Column name and the variants used in Jamaican systems.',
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

const PARISHES = ['Kingston', 'Saint Andrew', 'Saint Thomas', 'Portland', 'Saint Mary', 'Saint Ann', 'Trelawny', 'Saint James', 'Hanover', 'Westmoreland', 'Saint Elizabeth', 'Manchester', 'Clarendon', 'Saint Catherine']
// The parish capitals. Half Way Tree is the seat of St. Andrew, which shares a municipal corporation
// with Kingston.
const CAPITALS = {
  Kingston: 'Kingston', 'Saint Andrew': 'Half Way Tree', 'Saint Thomas': 'Morant Bay', Portland: 'Port Antonio', 'Saint Mary': 'Port Maria',
  'Saint Ann': "Saint Ann's Bay", Trelawny: 'Falmouth', 'Saint James': 'Montego Bay', Hanover: 'Lucea', Westmoreland: 'Savanna-la-Mar',
  'Saint Elizabeth': 'Black River', Manchester: 'Mandeville', Clarendon: 'May Pen', 'Saint Catherine': 'Spanish Town',
}
const PLACES = readLines('places.tsv').map((line) => {
  const [name, parish, population] = line.split('\t')
  return { name, parish, population: Number(population) }
})
if (PLACES.length !== 140) throw new Error(`expected the 140 towns of the 2022 census list, found ${PLACES.length}`)
for (const p of PLACES) if (!PARISHES.includes(p.parish)) throw new Error(`${p.name}: unknown parish ${p.parish}`)
for (const [parish, capital] of Object.entries(CAPITALS)) if (!PLACES.some((p) => p.name === capital && p.parish === parish)) throw new Error(`${capital} is not among the places of ${parish}`)

// ── Shared algorithms ───────────────────────────────────────────────────────

// Vowels map to vowels and consonants to consonants, so a masked document number keeps its
// structure; digits map to digits. Separators are in no group and stay. minMaskedPositions 0 lets
// a placeholder such as "N/A" through instead of failing the row.
algorithm('JM_CM_ALNUM', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'AEIOU', 'BCDFGHJKLMNPQRSTVWXYZ', 'aeiou', 'bcdfghjklmnpqrstvwxyz'],
  caseSensitive: true,
  minMaskedPositions: 0,
  preserveLeadingZeros: true,
}, '000123456')
// Hex letters form their own group, so a MAC, UUID or IPv6 stays valid hex.
algorithm('JM_CM_HEX', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'abcdef', 'ABCDEF', 'ghijklmnopqrstuvwxyz', 'GHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
  preserveLeadingZeros: true,
}, '3c:22:fb:9a:10:e4')
decompose('JM_REDACT', [['(.+)', { type: 'REDACT', redactCharacter: 'X' }]], keep, 'secret123')
lookup('JM_SUPPRESS', 'jm-not-stated.txt', ['Not stated'], 'Major depressive disorder', 'PRESERVE_LOOKUP_FILE')

// Yes/no columns keep their vocabulary: a CHAR(1) Y/N stays Y/N.
decompose('JM_FLAG', [
  ['(?i)(yes|no)', apply(lookup('JM_FLAG_YES_NO', 'jm-flag-yes-no.txt', ['Yes', 'No']))],
  ['(?i)(true|false)', apply(lookup('JM_FLAG_TRUE_FALSE', 'jm-flag-true-false.txt', ['true', 'false']))],
  ['(?i)([yn])', apply(lookup('JM_FLAG_Y_N', 'jm-flag-y-n.txt', ['Y', 'N']))],
  ['([01])', apply(lookup('JM_FLAG_0_1', 'jm-flag-0-1.txt', ['0', '1']))],
], keep, 'Y')

const FLAG = '(?i)(yes|no|true|false|[yn01])'
/**
 * A categorical attribute: flags stay flags, numeric codes get other digits, and any other value
 * is replaced by one from `values` — or suppressed, when no list is given.
 */
function categorical(name, fileName, values, input) {
  const replacement = values ? lookup(`${name}_LIST`, fileName, values) : 'JM_SUPPRESS'
  return decompose(name, [[FLAG, apply('JM_FLAG')], [String.raw`(\d{1,6})`, apply('JM_CM_ALNUM')]], apply(replacement), input)
}
categorical('JM_SUPPRESSED_CATEGORY', null, null, 'Major depressive disorder')
const CM = apply('JM_CM_ALNUM')

// ── L1 · Identity numbers ───────────────────────────────────────────────────
//
// The Taxpayer Registration Number of Tax Administration Jamaica is the number every adult carries:
// nine digits, usually written 123-456-789, asked for by banks, employers, the NIS and the NHT. The
// National Identification and Registration Act, 2021 makes the TRN the National Identification
// Number of NIDS, and the driver's licence is issued under it. There is no public check digit: the
// number is masked digit by digit, keeping its length, its separators and its uniqueness — and, since
// the masking is deterministic, the licence and the TRN of the same person still match.

domain('JM_L1_TRN', 'JM_CM_ALNUM',
  byName(['trn|trn_?(no|num|number|nbr)|taxpayer_?(registration_?)?(no|num|number|id)|tax_?(payer_?)?reg(istration)?_?(no|num|number)|tax_?(id|identification)(_?(no|num|number))?|nin|nin_?(no|number)|nids(_?(no|num|number|id))?|national_?(id|identification)(_?(no|num|number|card))?', 0.9]),
  byPattern([
    [String.raw`\d{3}[\s\-]\d{3}[\s\-]\d{3}`, 0.7],
    [String.raw`\d{9}`, 0.5],
  ], { reject: 0.3 }))

// The National Insurance Scheme number of the Ministry of Labour and Social Security.
domain('JM_L1_NIS_NUMBER', 'JM_CM_ALNUM',
  byName(['nis|nis_?(no|num|number|nbr|id|card)|national_?insurance(_?(no|num|number|scheme_?(no|number)))?|ni_?(no|num|number)|insured_?(person_?)?(no|num|number)|social_?security(_?(no|num|number))?|ssn', 0.9]))

domain('JM_L1_PASSPORT', 'JM_CM_ALNUM',
  byName(['passport[a-z_]*|pass_?port_?(no|num|number)|pp_?(no|num|number)|travel_?document(_?(no|num|number))?', 0.85]),
  byPattern([[String.raw`[A-Z]{1,2}\d{6,8}`, 0.3]], { reject: 0.3 }))

// The voter identification card of the Electoral Office of Jamaica.
domain('JM_L1_VOTER_ID', 'JM_CM_ALNUM',
  byName(['voter_?(id|card|reg|registration)(_?(no|num|number|card))?|voters_?(id|card|reg|registration)(_?(no|num|number))?|elector(al)?_?(id|no|num|number|card|reg|registration)(_?(no|num|number))?|eoj_?(no|id|reg|number)|polling_?(division|station)_?(no|number)?', 0.85]))

domain('JM_L1_DRIVERS_LICENCE', 'JM_CM_ALNUM',
  byName(['drivers?_?licen[cs]e(_?(no|num|number))?|driving_?licen[cs]e(_?(no|num|number))?|dl_?(no|num|number)|licen[cs]e_?(no|num|number)(?!_?(plate|vehicle|business|trade|liquor|professional|firearm))|permit_?(no|number)_?driver', 0.85]))

domain('JM_L1_IMMIGRATION_DOCUMENT', 'JM_CM_ALNUM',
  byName(['permanent_?residen(ce|cy|t)(_?(permit|card|no|num|number|id))?|work_?permit(_?(no|num|number))?|immigration_?(permit|document|card|file|status_?no|no|num|number)|visa_?(no|num|number)|residen(ce|cy)_?permit(_?(no|number))?|pica_?(no|number|file|ref)|citizenship_?certificate(_?(no|number))?|naturali[sz]ation_?(certificate|cert|no|number)|csme_?(certificate|skills_?certificate)(_?(no|number))?|skills_?certificate(_?(no|number))?|refugee_?(id|card|no|number)|asylum_?(id|no|number)|alien_?(no|number|registration)', 0.85]))

// Birth, death and marriage registrations of the Registrar General's Department.
domain('JM_L1_VITAL_RECORD', 'JM_CM_ALNUM',
  byName(
    ['birth_?cert(ificate)?(_?(no|num|number|entry|pin))?|death_?cert(ificate)?(_?(no|num|number))?|marriage_?cert(ificate)?(_?(no|num|number))?|registry_?entry(_?(no|number))?|rgd_?(no|number|entry|pin|ref)|vital_?(record|statistics)_?(no|num|number)|registration_?(no|number)_?(birth|death|marriage)', 0.85],
    ['entry_?(no|number)', 0.55],
  ))

// ── L1 · Names ──────────────────────────────────────────────────────────────

const NOT_A_PERSON = 'product|prod|item|article|company|business|trade|brand|file|street|road|avenue|village|town|city|district|parish|country|bank|branch|plan|campaign|project|service|table|column|field|user|host|server|domain|model|category|type|school|college|institution|course|programme|program|subject|document|doc|centre|center|unit|clinic|hospital|area|department|dept|position|system|app|application|group|list|report|process|event|task|profile|role|class|object|account|drug|medication|diagnosis|study|benefit|party|union|religion|ethnicity|language|place|store|shop|warehouse|supplier|vendor|contract|policy|insurance|org|organi[sz]ation|entity|parameter|variable|method|function|index|job|script|queue|resource|network|device|template|image|photo|page|site|module|menu|option|action|permission|tax|currency|issuer|invoice|payment|form|zone|route|line|sector|building|display|key|tag|label|title|code|config|setting|firm|employer|estate|parcel|scheme|community'
const PERSON_ROLE = 'customer|cust|client|patient|employee|emp|staff|worker|member|student|pupil|insured|beneficiary|holder|account_?holder|policy_?holder|mother|father|parent|guardian|spouse|partner|next_?of_?kin|doctor|physician|nurse|contact|emergency_?contact|guarantor|debtor|borrower|applicant|signatory|witness|representative|owner|tenant|landlord|victim|complainant|accused|defendant|donor|heir|person|driver|agent|citizen|elector|voter|taxpayer|child|dependant|dependent|relative|officer|teacher|contributor|pensioner|claimant'

// Each word from the list; three words are the most a given-name column holds.
decompose('JM_GIVEN_NAMES', [
  [String.raw`(\S+)`, apply('JM_GIVEN_NAME')],
  [String.raw`(\S+)\s+(\S+)`, apply('JM_GIVEN_NAME'), apply('JM_GIVEN_NAME')],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, apply('JM_GIVEN_NAME'), apply('JM_GIVEN_NAME'), apply('JM_GIVEN_NAME')],
], CM, 'Shelly-Ann Novelette')
algorithm('JM_GIVEN_NAME', 'name.Name', {
  lookupFile: { uri: file('jm-given-names.txt', GIVEN_NAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Delroy')
// Surnames: one, or two joined by a hyphen, as married women often write theirs.
decompose('JM_SURNAMES', [
  // Before the single word, which would take the hyphenated surname whole.
  [String.raw`([^\s\-]+)(\-)([^\s\-]+)`, apply('JM_SURNAME'), keep, apply('JM_SURNAME')],
  [String.raw`(\S+)`, apply('JM_SURNAME')],
  [String.raw`(\S+)\s+(\S+)`, apply('JM_SURNAME'), apply('JM_SURNAME')],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, apply('JM_SURNAME'), apply('JM_SURNAME'), apply('JM_SURNAME')],
], CM, 'Campbell')
algorithm('JM_SURNAME', 'name.Name', {
  lookupFile: { uri: file('jm-surnames.txt', SURNAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Beckford')
// The English order: given name, middle names, surname. A hyphenated surname is the last word.
const N = apply('JM_GIVEN_NAME')
const S = apply('JM_SURNAMES')
decompose('JM_FULL_NAME', [
  [String.raw`([^,]+),\s*(.+)`, apply('JM_SURNAMES'), apply('JM_GIVEN_NAMES')],
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, S],
  // A middle initial stays an initial.
  [String.raw`(\S+)(\s+)([A-Za-z]\.?)(\s+)(\S+)`, N, keep, keep, keep, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, N, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, N, S],
], CM, 'Delroy A. Beckford')

domain('JM_L1_GIVEN_NAME', 'JM_GIVEN_NAMES',
  byName(
    [`first_?names?|given_?names?|fore_?names?|christian_?name|fname|name_?first|middle_?names?|mname|name_?middle`, 0.85],
    [`name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))`, 0.5],
  ),
  byList([['jm-detect-given-names.txt', GIVEN_NAMES, 0.7]], { tokenize: true, reject: 0.3 }))

domain('JM_L1_SURNAME', 'JM_SURNAMES',
  byName(['last_?names?|surnames?|family_?names?|lname|name_?last|maiden_?name|mothers?_?maiden_?name|maiden|married_?name|former_?(sur)?name', 0.85]),
  byList([['jm-detect-surnames.txt', SURNAMES, 0.7]], { tokenize: true, reject: 0.3 }))

domain('JM_L1_FULL_NAME', 'JM_FULL_NAME',
  byName(
    [`full_?name|fullname|complete_?name|person_?name|name_?of_?(${PERSON_ROLE})|(${PERSON_ROLE})_?name`, 0.9],
    ['beneficiary|guardian|next_?of_?kin|spouse|emergency_?contact|guarantor|account_?holder|policy_?holder|legal_?representative|attorney|patient|victim|complainant|accused|defendant|insured_?person|nominee|executor|justice_?of_?the_?peace', 0.6],
    // A bare NAME holds a given name or a full name: the values decide between the two domains.
    [`name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))`, 0.5],
  ),
  // 0.65: a full name found word by word reaches the threshold without the column name, and a
  // single word still goes to the given-name or surname domain, at 0.7.
  byList([['jm-detect-given-names.txt', GIVEN_NAMES, 0.65], ['jm-detect-surnames.txt', SURNAMES, 0.65]], { tokenize: true, reject: 0.3 }))

// ── L1 · Contact ────────────────────────────────────────────────────────────

decompose('JM_EMAIL', [
  // The top-level domain becomes .test, reserved for tests: a masked address can never deliver.
  [String.raw`([^@\s]+)@([^@\s]+)\.([A-Za-z]{2,24})`, CM, CM, redactAs('test')],
], CM, 'delroy.beckford@gmail.com')
domain('JM_L1_EMAIL', 'JM_EMAIL',
  byName(['e_?mail[a-z0-9_]*|mail[a-z0-9_]*|email_?address', 0.85]),
  byType(STRING(5)),
  byPattern([[String.raw`[\p{L}\p{N}._%+'\-]+@[\p{L}\p{N}.\-]+\.[A-Za-z]{2,24}`, 1]], { reject: 0.2 }))

// Jamaica is in the North American plan: +1, area code 876 or 658, then seven digits. The country
// and area codes and the separators stay; the seven digits are masked.
decompose('JM_PHONE', [
  [String.raw`(\+?1[\s\-.]?)?(\(?(?:876|658)\)?[\s\-.]?)(\d{3})([\s\-.]?)(\d{4})`, keep, keep, CM, keep, CM],
  [String.raw`(\d{3})([\s\-.]?)(\d{4})`, CM, keep, CM],
], CM, '+1 876-555-0123')
domain('JM_L1_PHONE', 'JM_PHONE',
  byName(['tel|telephone[a-z0-9_]*|tel_?(no|num|number|home|work|mobile|cell)|phone[a-z0-9_]*|ph_?(no|num|number)|mobile[a-z0-9_]*|cell|cell_?(phone|no|number)|cellphone|cellular|contact_?(no|num|number)|fax|whatsapp', 0.85]),
  byPattern([
    [String.raw`(\+?1[\s\-.]?)?\(?(876|658)\)?[\s\-.]?\d{3}[\s\-.]?\d{4}`, 1],
    [String.raw`[2-9]\d{2}[\s\-.]\d{4}`, 0.5],
    [String.raw`\+?\d[\d\s()\-.]{6,15}`, 0.3],
  ], { reject: 0.3 }))

// Jamaican addresses: house number and street, with the postal zone in Kingston and St. Andrew
// ("Kingston 10"); a lot in a housing scheme; or, in the country, the district and the post office.
// There are no postal codes in use.
const SCHEMES = [
  ['Greater Portmore', 'Portmore'], ['Edgewater', 'Portmore'], ['Independence City', 'Portmore'], ['Waterford', 'Portmore'], ['Hellshire', 'Portmore'],
  ['Ensom City', 'Spanish Town'], ['Willowdene', 'Spanish Town'], ['Lakes Pen', 'Spanish Town'], ['Duhaney Park', 'Kingston 20'], ['Havendale', 'Kingston 19'],
  ['Cedar Grove', 'Portmore'], ['Westgreen', 'Montego Bay'], ['Ironshore', 'Montego Bay'], ['Coral Gardens', 'Montego Bay'], ['Bogue Village', 'Montego Bay'],
  ['Melrose Hill', 'Mandeville'], ['Hopeton', 'May Pen'], ['Sevens', 'May Pen'], ['Seville Meadows', 'Spanish Town'], ['Old Harbour Glades', 'Old Harbour'],
]
const DISTRICTS = [
  ['Content', 'Linstead', 'Saint Catherine'], ['Kitson Town', 'Spanish Town', 'Saint Catherine'], ['Mocho', 'May Pen', 'Clarendon'], ['Coleyville', 'Christiana', 'Manchester'],
  ['Nain', 'Santa Cruz', 'Saint Elizabeth'], ['Bluefields', 'Savanna-la-Mar', 'Westmoreland'], ['Green Island', 'Lucea', 'Hanover'], ['Wakefield', 'Falmouth', 'Trelawny'],
  ['Bamboo', "Brown's Town", 'Saint Ann'], ['Islington', 'Port Maria', 'Saint Mary'], ['Hope Bay', 'Port Antonio', 'Portland'], ['Golden Grove', 'Morant Bay', 'Saint Thomas'],
  ['Cambridge', 'Montego Bay', 'Saint James'], ['Gordon Town', 'Kingston 6', 'Saint Andrew'],
]
lookup('JM_ADDRESS', 'jm-addresses.txt', (() => {
  const random = seeded(2020)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const streets = readLines('streets.txt')
  const out = new Set()
  while (out.size < 3000) {
    const r = random()
    const house = 1 + Math.floor(random() * 250)
    if (r < 0.5) out.add(`${house} ${pick(streets)}`)
    else if (r < 0.7) {
      const [scheme, town] = pick(SCHEMES)
      out.add(`Lot ${house}, ${scheme}, ${town}`)
    } else if (r < 0.85) {
      const [district, office, parish] = pick(DISTRICTS)
      out.add(`${district} District, ${office} P.O., ${parish.replace('Saint ', 'St. ')}`)
    } else out.add(`Apt. ${1 + Math.floor(random() * 12)}${'ABCD'[Math.floor(random() * 4)]}, ${house} ${pick(streets)}`)
  }
  return [...out]
})(), '12 Hope Road, Kingston 6', 'PRESERVE_LOOKUP_FILE')
domain('JM_L1_ADDRESS', 'JM_ADDRESS',
  byName(['(?<!(mac|ip|e_?mail|web|url)_?)address(?!_?(ip|mac|email|e_?mail|web|url|book|type|id))[a-z0-9_]*|(?<!(mac|ip|e_?mail|web|url)_?)addr(ess)?_?(line|1|2)?[a-z0-9_]*|street(_?(address|name))?|residential_?address|home_?address|mailing_?address|postal_?address|physical_?address|residence|place_?of_?residence|domicile|post_?office|p_?o_?box', 0.8]),
  byType(STRING(6)),
  byPattern([
    [String.raw`(?i)#?\s*\d+[A-Z]?\s+.*\b(street|st\.?|avenue|ave\.?|road|rd\.?|drive|dr\.?|lane|boulevard|blvd\.?|crescent|close|terrace|way|highway|hwy)\b.*`, 0.8],
    [String.raw`(?i).*\bkingston\s+\d{1,2}\b.*`, 0.8],
    [String.raw`(?i).+\bdistrict\b.*\bp\.?\s?o\.?(\W.*)?`, 0.9],
    [String.raw`(?i).*\blot\s*(no\.?\s*|#\s*)?\d+\s*,.+`, 0.6],
  ], { reject: 0.2 }))

domain('JM_L1_ADDRESS_DETAIL', 'JM_CM_ALNUM',
  byName(['house_?(no|num|number)|apt(_?(no|number))?|apartment(_?(no|number))?|unit_?(no|num|number)|flat_?(no|number)|lot_?(no|num|number)|floor_?(no|number)?|suite(_?no)?|building_?(no|number)', 0.7]))

// ── L1 · Banking ────────────────────────────────────────────────────────────

domain('JM_L1_BANK_ACCOUNT', 'JM_CM_ALNUM',
  byName(['account_?(no|num|number|nbr)|acct_?(no|num|number|nbr)?|acc_?(no|num|number)|bank_?(account|acct)(_?(no|num|number))?|savings_?(account|acct)(_?(no|number))?|chequing_?(account|acct)(_?(no|number))?|checking_?(account|acct)(_?(no|number))?|share_?account(_?no)?|iban', 0.85]))

// Credit Card fails a row that has no digits to mask; only values shaped like a card reach it.
decompose('JM_CARD', [[String.raw`(\d[\d\s\-]{11,22}\d)`, apply(ENGINE.CREDIT_CARD)]], keep, '4916 3131 2345 6780')
domain('JM_L1_PAYMENT_CARD', 'JM_CARD',
  byName(['card_?(no|num|number)|credit_?card(_?(no|num|number))?|debit_?card(_?(no|num|number))?|keycard(_?(no|number))?|cc_?(no|num|number)|pan|card_?pan|masked_?pan', 0.85]),
  // An IMEI is 15 Luhn-valid digits too: 15-digit cards are American Express (34, 37), and the rest
  // is left to the device domain. 0.9, not 1, so that a column name still wins.
  byPattern([[String.raw`3[47]\d{13}|[1-9]\d{12,13}|[1-9]\d{15,18}`, 0.9, { checksum: 'LUHN', clean: String.raw`[\s\-]` }]], { reject: 0.3 }))

// ── L1 · Network, devices, vehicles, land ───────────────────────────────────

algorithm('JM_OCTET', 'characterMapping.NumericMapping', { minValue: 1, maxValue: 254 }, '10')
decompose('JM_IP', [
  [String.raw`(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})`, apply('JM_OCTET'), apply('JM_OCTET'), apply('JM_OCTET'), apply('JM_OCTET')],
], apply('JM_CM_HEX'), '72.27.211.10')
domain('JM_L1_IP_ADDRESS', 'JM_IP',
  byName(['ip|ip_?(address|addr|origin|source|destination|client|user|remote|public|private|login)|ipv[46]|remote_?addr(ess)?|client_?ip|host_?ip|source_?ip', 0.85]),
  byPattern([
    [String.raw`((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)`, 1],
    [String.raw`[0-9A-Fa-f]{1,4}(:[0-9A-Fa-f]{0,4}){2,7}`, 0.9],
  ], { reject: 0.3 }))

domain('JM_L1_DEVICE_ID', 'JM_CM_HEX',
  byName(['imei|imsi|iccid|mac|mac_?address|device_?(id|uuid|serial)|advertising_?id|idfa|gaid|cookie(_?id)?|session_?id|serial_?(no|number)_?(device|phone|handset)|handset_?serial', 0.8]),
  byPattern([
    [String.raw`([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}`, 1],
    [String.raw`\d{15}`, 0.8, { checksum: 'LUHN' }],
  ], { reject: 0.3 }))

// Private plates are four digits and two letters (1234 AB). Public passenger and commercial vehicles,
// rentals and dealers put two letters first (PP 1234, CA 1234, RR 1234); government plates are digits
// only. Letters stay, digits are masked.
decompose('JM_PLATE', [
  [String.raw`(\d{4})([\s\-]?)([A-Z]{2})`, CM, keep, keep],
  [String.raw`([A-Z]{2})([\s\-]?)(\d{4})`, keep, keep, CM],
  [String.raw`(\d{2})([\s\-]?)(\d{4})`, CM, keep, CM],
], CM, '1234 AB')
domain('JM_L1_LICENCE_PLATE', 'JM_PLATE',
  byName(['licen[cs]e_?plates?(_?(no|num|number))?|plates?(_?(no|num|number))?|vehicle_?(reg|registration|plate|licen[cs]e)(_?(no|num|number))?|registration_?plate|number_?plate|reg_?plate|tag_?(no|number)', 0.85]),
  byPattern([
    [String.raw`\d{4}[\s\-]?[A-Z]{2}`, 0.8],
    [String.raw`(P[A-HJ-NP]|C[A-HJ-N]|RR|DA|MA|MB)[\s\-]?\d{4}`, 0.5],
  ], { reject: 0.3 }))

domain('JM_L1_VIN', 'JM_CM_ALNUM',
  byName(['vin|vin_?(no|number)|vehicle_?identification_?(no|number)|chassis(_?(no|number))?|engine_?(no|number|serial)|motor_?(no|number)|serial_?(no|number)_?vehicle', 0.8]),
  byPattern([[String.raw`[A-HJ-NPR-Z0-9]{17}`, 0.7]], { reject: 0.3 }))

// Registered land is identified by the volume and folio of its certificate of title, and valued
// under a valuation number of the National Land Agency: both lead to the proprietor. The words stay;
// the numbers are masked.
decompose('JM_LAND_TITLE', [
  [String.raw`(?i)(.*?vol(?:ume)?\.?\s*)(\d+)(.*?fol(?:io)?\.?\s*)(\d+)(.*)`, keep, CM, keep, CM, keep],
], CM, 'Volume 1234 Folio 567')
domain('JM_L1_LAND_TITLE', 'JM_LAND_TITLE',
  byName(['vol(ume)?_?(and_?)?fol(io)?|title_?(deed_?)?(no|number|vol|volume|ref)|certificate_?of_?title|land_?(title|registry|register|certificate|parcel)(_?(no|num|number))?|valuation_?(no|num|number|roll)|nla_?(no|number|valuation)|parcel(_?(no|num|number|id))?|deed_?(no|number)|lease_?(no|number)|strata_?(plan|lot)(_?(no|number))?|folio(_?(no|number))?', 0.85]),
  // Valuation numbers have no shape to go by: a column of them is left to its name, not rejected.
  byPattern([[String.raw`(?i).*vol(ume)?\.?\s*\d+.*fol(io)?\.?\s*\d+.*`, 0.9]], { reject: 0 }))

domain('JM_L1_CONTRACT_NUMBER', 'JM_CM_ALNUM',
  byName(['contract_?(no|num|number)|policy_?(no|num|number)|loan_?(no|num|number|id)|mortgage_?(no|number)|member(ship)?_?(no|num|number|id)|customer_?(no|num|number|id)|client_?(no|num|number|id)|cust_?(no|num|id)|employee_?(no|num|number|id)|emp_?(no|num|id)|staff_?(no|num|number|id)|payroll_?(no|number)|claim_?(no|num|number)|meter_?(no|number)|jps_?account(_?no)?|nwc_?account(_?no)?|nht_?(no|number|contributor_?(no|number)?)|student_?(no|num|number|id)|pupil_?(no|number|id)', 0.7]))

domain('JM_L1_USERNAME', 'JM_CM_ALNUM',
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
domain('JM_L1_CREDENTIAL', 'JM_REDACT',
  byName(['password|passwd|pwd|pass_?word|pass|pin(_?(code|no|number))?|passcode|hash_?password|password_?hash|secret|secret_?(answer|question)|security_?(answer|question)|access_?token|refresh_?token|api_?key|otp', 0.9]),
  byPattern(PASSWORD_HASHES, { reject: 0.3 }))

decompose('JM_COORDINATE', [
  // The integer part and first decimal stay (about 11 km): the place is generalized, not moved.
  [String.raw`(-?\d{1,3}\.\d)(\d+)\s*,\s*(-?\d{1,3}\.\d)(\d+)`, keep, CM, keep, CM],
  [String.raw`(-?\d{1,3}\.\d)(\d+)`, keep, CM],
], keep, '18.012345')
domain('JM_L1_GEOLOCATION', 'JM_COORDINATE',
  byName(
    ['lat|latitude|lon|lng|longitude|coordinates?|coord_?[xy]|geo_?(lat|lon|lng|loc|location|position)|geolocation|gps(_?(location|position|coordinates))?', 0.85],
    ['long', 0.5],
  ),
  byPattern([
    [String.raw`1[78]\.\d{3,}\s*,\s*-7[678]\.\d{3,}`, 0.9],
    [String.raw`1[78]\.\d{3,}`, 0.5],
    [String.raw`-7[678]\.\d{3,}`, 0.7],
  ], { reject: 0.3 }))

// ── L1 · Free text ──────────────────────────────────────────────────────────

algorithm('JM_FREE_TEXT', 'freeTextRedaction.FreeTextRedaction', {
  regularExpressions: [
    String.raw`(?<![\d\-])\d{3}-\d{3}-\d{3}(?![\d\-])`,
    String.raw`(?<!\d)\d{9}(?!\d)`,
    String.raw`[\w.+\-]+@[\w\-]+(\.[\w\-]+)+`,
    String.raw`(?<![\d\-])(\+?1[\s\-.]?)?\(?(876|658)\)?[\s\-.]?\d{3}[\s\-.]?\d{4}(?![\d\-])`,
    String.raw`(?<![\d\-])[2-9]\d{2}-\d{4}(?![\d\-])`,
    String.raw`(?<!\d)\d{13,19}(?!\d)`,
    String.raw`(?<![A-Za-z\d])\d{4}\s?[A-Z]{2}(?![A-Za-z\d])`,
    String.raw`(?<!\d)(\d{1,3}\.){3}\d{1,3}(?!\d)`,
  ].map((patternString) => ({ patternString })),
  regExRedactValue: '[DATA]',
  lookupFile: { uri: file('jm-text-names.txt', unique([...GIVEN_NAMES, ...SURNAMES].flatMap((v) => [v, v.toUpperCase(), fold(v), fold(v).toUpperCase()]))) },
  lookupFileRedactValue: '[NAME]',
  isDenyList: true,
}, 'Customer Beckford, TRN 123-456-789, email d.beckford@gmail.com, tel 876-555-0123')

domain('JM_L1_FREE_TEXT', 'JM_FREE_TEXT',
  byName(['remarks?|comments?|notes?|observations?|narrative|free_?text|memo|messages?(?!_?(id|type|code|key|no|num|number|date|status|queue|count|log))|complaint(_?(text|details|description))?|description_?(of_?)?(case|complaint|incident|request|issue|problem|events)|incident_?(details|description|narrative)|case_?(notes?|summary|details)|statement|details|summary', 0.6]),
  byType(STRING(30)),
  byPattern([
    [String.raw`\d{3}-?\d{3}-?\d{3}`, 0.6],
    [String.raw`[\w.+\-]+@[\w\-]+\.[A-Za-z]{2,}`, 0.7],
    [String.raw`(876|658)[\s\-.]?\d{3}[\s\-.]?\d{4}`, 0.6],
  ], { reject: 0, partial: true }))

// ── L2 · Quasi-identifiers ──────────────────────────────────────────────────

// Small shifts: large enough to break the link to the person, small enough that ages, school years
// and the 16th and 18th birthdays move for few people. Dates that combine with the birth date move less.
algorithm('JM_BIRTH_DATE', 'dateAlgorithms.DateShift', { minRange: -60, maxRange: 60, unit: 'DAYS', roll: false }, '1985-07-20')
algorithm('JM_EVENT_DATE', 'dateAlgorithms.DateShift', { minRange: -30, maxRange: 30, unit: 'DAYS', roll: false }, '2021-03-15')

domain('JM_L2_BIRTH_DATE', 'JM_BIRTH_DATE',
  byName(['dob|d_?o_?b|date_?of_?birth|birth_?date|birthdate|birthday|born_?(on|date)|bdate', 0.9]),
  byType(...DATES, STRING(6)))

// The decade stays and the unit is masked.
decompose('JM_YEAR', [[String.raw`(\d{3})(\d)`, keep, CM]], keep, '1985')
domain('JM_L2_BIRTH_YEAR', 'JM_YEAR',
  byName(['birth_?year|year_?of_?birth|yob|yr_?of_?birth', 0.9]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// 37 becomes 3x. From 100 on, 90.
decompose('JM_AGE', [
  [String.raw`([1-9]\d{2,})`, redactAs('90')],
  [String.raw`([1-9])(\d)(\.\d+)`, keep, CM, keep],
  [String.raw`([1-9])(\d)`, keep, CM],
  [String.raw`(\d)`, CM],
], keep, '37')
domain('JM_L2_AGE', 'JM_AGE',
  byName(['age(_?(years|yrs|in_?years|at_?(admission|death|entry|diagnosis|registration)|group|range|band|bracket|last_?birthday))?|years_?old', 0.85]),
  byType(NUMBER(0, 6), STRING(0, 6)))

domain('JM_L2_EVENT_DATE', 'JM_EVENT_DATE',
  byName(['date_?of_?(death|marriage|divorce|hire|hiring|employment|engagement|termination|dismissal|resignation|retirement|admission|discharge|diagnosis|visit|consultation|delivery|arrest|conviction|sentence|sentencing|naturali[sz]ation|injury|surgery)|(death|marriage|divorce|hire|hiring|employment|employment_?start|start_?of_?employment|termination|separation|resignation|retirement|admission|discharge|diagnosis|visit|delivery|arrest|conviction|sentencing|naturali[sz]ation|pension_?start|injury|vaccination|surgery|immigration)_?date|dod', 0.8]),
  byType(...DATES, STRING(6)))

// Each vocabulary replaced within itself: M/F stays M/F.
decompose('JM_SEX', [
  ['(?i)(female|male)', apply(lookup('JM_SEX_FEMALE_MALE', 'jm-sex-female-male.txt', ['Female', 'Male']))],
  ['(?i)(woman|man)', apply(lookup('JM_SEX_WOMAN_MAN', 'jm-sex-woman-man.txt', ['Woman', 'Man']))],
  ['(?i)([fm])', apply(lookup('JM_SEX_F_M', 'jm-sex-f-m.txt', ['F', 'M']))],
], keep, 'F')
domain('JM_L2_SEX', 'JM_SEX',
  byName(['sex(_?(code|at_?birth|registered))?|gender(?!_?(identity|expression))(_?code)?', 0.85]),
  // A column of single letters is the sex on its own; the words are stronger evidence.
  byList([
    ['jm-detect-sex.txt', ['female', 'male', 'woman', 'man', 'fem'], 0.8],
    ['jm-detect-sex-letter.txt', ['f', 'm'], 0.6],
  ], { reject: 0.5 }))

// ── L2 · Where people live ──────────────────────────────────────────────────
//
// Jamaica has fourteen parishes, and the parish stays: the smallest, Hanover, has about 70,000
// people. Towns are another matter: 116 of the 140 towns of the 2022 census list had fewer than
// 10,000 inhabitants, and with a birth date and a sex one of them points at a handful of people.
// A small town becomes the capital of its parish — a real place, the one that stands for the parish,
// shared by everyone in it. The capitals stay, even the small ones (Morant Bay, Black River): a
// capital in a masked column says the parish, no more.

const SMALL_PLACE = 10000
const CAPITAL_NAMES = new Set(Object.values(CAPITALS))
const keepsName = (p) => p.population >= SMALL_PLACE || CAPITAL_NAMES.has(p.name)
// Names as they are also written.
const ALIASES = {
  "Saint Ann's Bay": ["St. Ann's Bay", "St Ann's Bay", 'St. Anns Bay', 'St Anns Bay', 'Saint Anns Bay'],
  'Savanna-la-Mar': ['Savanna la Mar', 'Savanna La Mar', 'Sav-la-Mar', 'Sav la Mar'],
  'Half Way Tree': ['Halfway Tree', 'Half-Way-Tree'], 'Montego Bay': ['Mobay', 'Mo Bay'],
}
// Every "Saint" place is also written "St." and "St"; every apostrophe can be left out.
const writings = (name) => unique([name, ...(ALIASES[name] ?? []),
  ...(name.startsWith('Saint ') ? [name.replace('Saint ', 'St. '), name.replace('Saint ', 'St ')] : [])].flatMap((n) => [n, n.replace(/'/g, '')]))
const PARISH_NAMES = new Set(PARISHES.flatMap((p) => writings(p)).flatMap((p) => [p, `${p} Parish`]).map((n) => n.toLowerCase()))
/** Name → generalized name. A name shared by several places is generalized only when all are small. */
const placePairs = (() => {
  const byName = new Map()
  for (const p of PLACES) for (const name of writings(p.name)) byName.set(name, [...(byName.get(name) ?? []), p])
  return [...byName.entries()].map(([name, all]) => {
    if (all.some(keepsName)) return [name, name]
    const parishes = unique(all.map((p) => p.parish))
    // Homonyms in two parishes: the larger one decides.
    const p = all.reduce((a, b) => (b.population > a.population ? b : a))
    if (parishes.length > 1) console.log(`  · ${name} is a town of ${parishes.join(' and ')}: generalized as in ${p.parish}`)
    return [name, CAPITALS[p.parish]]
  })
})()
const variants = (pairs) => unique(pairs.flatMap(([from, to]) => [
  `${from}|${to}`, `${fold(from)}|${to}`, `${from.toUpperCase()}|${to.toUpperCase()}`, `${fold(from).toUpperCase()}|${fold(to).toUpperCase()}`,
])).map((line) => line.split('|'))
const PERSONAL_WORDS = new Set([...GIVEN_NAMES, ...SURNAMES].map((w) => fold(w).toLowerCase()))

cleansing('JM_TOWN', 'jm-town-generalized.txt', variants(placePairs), 'Port Royal', '|')
domain('JM_L2_TOWN', 'JM_TOWN',
  byName(
    ['town|village|community(?!_?(service|group|organi[sz]ation|work|council))|locality|settlement|home_?town|hometown|place_?of_?birth|birth_?place|birthplace|residence_?(town|village|community|district)|town_?of_?residence|post_?office_?(name|town)|postal_?town', 0.85],
    ['city|municipality', 0.5],
  ),
  byList([['jm-detect-towns.txt', placePairs.map(([name]) => name).filter((n) => !PERSONAL_WORDS.has(fold(n).toLowerCase()) && !PARISH_NAMES.has(n.toLowerCase())), 0.8]], { reject: 0.4 }))

// Neighbourhoods of Kingston and St. Andrew, and housing schemes elsewhere, are replaced by a common
// one: a place still, no longer theirs.
lookup('JM_NEIGHBOURHOOD', 'jm-neighbourhoods.txt', readLines('neighbourhoods.txt'), 'Barbican', 'PRESERVE_LOOKUP_FILE')
domain('JM_L2_NEIGHBOURHOOD', 'JM_NEIGHBOURHOOD',
  byName(['neighbou?rhood|subdivision|housing_?(area|scheme|estate|development)|residential_?area|area_?of_?residence|scheme_?name|community_?name|district_?name', 0.85]))

// Birth countries most often recorded for people living in Jamaica, and the diaspora.
const NATIONALITIES = ['Jamaican', 'American', 'British', 'Canadian', 'Chinese', 'Indian', 'Haitian', 'Cuban', 'Trinidadian', 'Guyanese', 'Barbadian', 'Venezuelan', 'Colombian', 'Dominican', 'Nigerian', 'Filipino']
lookup('JM_NATIONALITY', 'jm-nationalities.txt', NATIONALITIES, 'Guyanese')
domain('JM_L2_NATIONALITY', 'JM_NATIONALITY',
  byName(['nationality|citizenship|country_?of_?(birth|origin|citizenship|nationality)|birth_?country', 0.8]),
  byList([['jm-detect-nationalities.txt', [...NATIONALITIES, 'jamaica', 'united states', 'usa', 'us', 'united kingdom', 'uk', 'canada', 'china', 'india', 'haiti', 'cuba', 'trinidad and tobago', 'trinidad', 'guyana', 'barbados', 'venezuela', 'colombia', 'dominican republic', 'nigeria', 'philippines'], 0.7]], { reject: 0.4 }))

// Marital status and union status as the census asks for them: many unions are common-law or visiting.
const MARITAL = ['Never married', 'Married', 'Common-law union', 'Visiting union', 'Divorced', 'Widowed', 'Separated']
lookup('JM_MARITAL_STATUS', 'jm-marital-status.txt', MARITAL, 'Visiting union')
domain('JM_L2_MARITAL_STATUS', 'JM_MARITAL_STATUS',
  byName(['marital_?status|civil_?status|union_?status|union_?type|marriage_?status|relationship_?status|conjugal_?status', 0.85]),
  byList([['jm-detect-marital-status.txt', [...MARITAL, 'single', 'married', 'common law', 'common-law', 'visiting', 'divorced', 'widow', 'widower', 'widowed', 'separated'], 0.7]], { reject: 0.4 }))

lookup('JM_OCCUPATION', 'jm-occupations.txt', ['Clerk', 'Sales clerk', 'Shop assistant', 'Construction worker', 'Heavy equipment operator', 'Driver', 'Teacher', 'Nurse', 'General practitioner', 'Accountant', 'Engineer', 'Attorney-at-law', 'Maintenance technician', 'Cashier', 'Waiter', 'Cook', 'Security guard', 'Mason', 'Electrician', 'Plumber', 'Mechanic', 'Farmer', 'Farm labourer', 'Fisherman', 'Higgler', 'Tour guide', 'Housekeeper', 'Customer service representative', 'Student', 'Retired', 'Self-employed', 'Programmer', 'Graphic designer', 'Receptionist', 'Janitor', 'Supervisor', 'Area manager', 'Sales representative', 'Storekeeper', 'Delivery driver', 'Unemployed'], 'Regional Operations Manager, Western Division')
domain('JM_L2_OCCUPATION', 'JM_OCCUPATION',
  byName(
    ['occupation|profession|job_?title|designation|post_?title|position_?title', 0.8],
    ['job|position|post|trade(?!_?(name|mark|licen[cs]e))', 0.5],
  ))

lookup('JM_EMPLOYER', 'jm-employers.txt', ['Blue Mountain Trading Company Ltd.', 'Rio Cobre Services Ltd.', 'Island Construction Ltd.', 'Coastal Transport Ltd.', 'Clarendon Agro Industries Ltd.', 'Southern Distributors Ltd.', 'North Coast Hotels Ltd.', 'Lignum Vitae Medical Centre Ltd.', 'Hope River Academy Ltd.', 'Cockpit Country Consultants Ltd.', 'Dry Harbour Quarry Ltd.', 'Pedro Bank Fisheries Ltd.', 'Doctor Bird Technologies Ltd.', 'Sunrise Supermarkets Ltd.', 'Builders Hardware Ltd.', 'Harbour View Logistics Ltd.', 'Clean Sweep Services Ltd.', 'Cross Roads Laboratories Ltd.', 'Caymanas Import Export Ltd.', 'Valley Auto Parts Ltd.', 'Helping Hands Foundation', 'Ackee Tree Restaurants Ltd.', 'Sentinel Security Services Ltd.', 'Mahoe Furniture Ltd.', 'Contact Centre Partners Ltd.'], 'Jamaica Public Service Company Limited')
domain('JM_L2_EMPLOYER', 'JM_EMPLOYER',
  byName(['employer(_?name)?|name_?of_?employer|employer_?business_?name|company_?of_?employment|workplace|work_?place|place_?of_?(work|employment)|employed_?(at|by|with)|current_?employer', 0.8]))

// Levels of the Jamaican system: primary to grade 6, secondary to grade 11 (CSEC), sixth form (CAPE),
// HEART/NSTA Trust vocational training, tertiary.
const EDUCATION = ['No schooling', 'Early childhood', 'Primary', 'Lower secondary (grade 9)', 'Secondary (CSEC)', 'Sixth form (CAPE)', 'Vocational (NVQ-J)', 'Associate degree', "Bachelor's degree", "Master's degree", 'Doctorate']
lookup('JM_EDUCATION', 'jm-education.txt', EDUCATION, 'Secondary (CSEC)')
domain('JM_L2_EDUCATION', 'JM_EDUCATION',
  byName(['education(_?(level|attainment|status|completed))?|educational_?(level|attainment)|highest_?(level_?(of_?)?)?(education|qualification|grade)|level_?of_?education|qualification|schooling|grade_?completed|csec_?(subjects|passes|grades)|cape_?(subjects|passes|grades)|cxc_?(subjects|passes|grades)', 0.8]),
  byList([['jm-detect-education.txt', [...EDUCATION, 'primary', 'secondary', 'high school', 'sixth form', 'csec', 'cxc', 'cape', 'nvq-j', 'nvqj', 'heart', 'tertiary', 'university', 'college', 'associate', 'bachelor', 'bachelors', 'masters', 'phd', 'none'], 0.6]], { reject: 0.4 }))

lookup('JM_SCHOOL', 'jm-schools.txt', ['Mount Olive Primary School', "St. Mark's Anglican Primary School", 'Sacred Heart Preparatory School', 'Holy Family Primary School', 'Mount Carmel All-Age School', 'Valley View High School', 'Northern Coastal High School', 'Southern Plains Technical High School', 'Riverside College of Technology', 'Central Jamaica Community College', 'Blue Mountain Teachers College', 'Caribbean Coast Adventist Academy', 'Seaside Christian High School', 'Pine Ridge Vocational Centre', 'Mahogany Hill University College'], 'Jamaica College')
domain('JM_L2_SCHOOL', 'JM_SCHOOL',
  byName(['school(_?name)?|name_?of_?school|high_?school|primary_?school|secondary_?school|prep_?school|sixth_?form|college(_?name)?|university(_?name)?|institution_?attended|alma_?mater', 0.75]))

// Capped at 5 as text: large households are rare, and a rare count identifies.
decompose('JM_CAPPED_COUNT', [[String.raw`([0-5])`, keep], [String.raw`(\d+)`, redactAs('5')]], keep, '9')
domain('JM_L2_DEPENDANTS', 'JM_CAPPED_COUNT',
  byName(['dependants?|dependents?|no_?of_?(children|dependants|dependents|kids)|num(ber)?_?(of_?)?(children|dependants|dependents|kids)|children|household_?(size|members)|persons_?in_?household', 0.8]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// ── L3 · Sensitive personal data (section 2) ────────────────────────────────

// (a) Genetic data: DNA, as the DNA Evidence Act, 2016 defines it.
domain('JM_L3_GENETIC', 'JM_REDACT',
  byName(['dna|genetic[a-z_]*|genome|genotyp[a-z_]*|gene_?(test|result|marker|panel)|genetic_?(test|marker|profile|result)|mutation|brca[12]?|karyotype|paternity_?test|dna_?(profile|sample|index)|snp|haplotype|newborn_?screening|sickle_?cell_?(genotype|trait)', 0.9]),
  // A nucleotide sequence (IUPAC letters) long enough not to be a word.
  byPattern([[String.raw`[ACGTUN]{24,}`, 0.9]], { reject: 0.3 }))

// (a) Biometric data: the Act names the photograph and the facial image, finger, palm, toe and foot
// prints, iris and retina scans, vein patterns, the gait, the signature, keystrokes and the voice.
domain('JM_L3_BIOMETRIC', 'JM_REDACT',
  byName(['fingerprints?|finger_?prints?|thumb_?prints?|biometric[a-z_]*|face_?(template|encoding|id|print|hash|image)|facial_?(template|recognition|id|image|image_?hash)|photo(graph)?(_?(image|file|path|blob|data|url))?|passport_?photo|selfie|headshot|mugshot|iris(_?(scan|template|code))?|retina(_?scan)?|vein_?(pattern|scan)|palm_?(print|vein)|toe_?print|foot_?print|voice_?(print|template|sample|recording)|signature_?(image|biometric|capture|pad|specimen|scan)|specimen_?signature|handwritten_?signature|keystroke(_?(dynamics|pattern))?|typing_?pattern|gait(_?(pattern|analysis))?|minutiae', 0.9]),
  byType(STRING()))

// Height and eye colour are biometric data too, by name in section 2. Height keeps its unit and its
// first figure; eye colour is replaced from a list.
lookup('JM_INCHES', 'jm-inches.txt', ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'], '8')
decompose('JM_HEIGHT', [
  [String.raw`(1|2)(\d{2})(\s*cm)?`, keep, CM, keep],
  [String.raw`([12]\.)(\d{1,2})(\s*m)?`, keep, CM, keep],
  [String.raw`([4-7])(\s*(?:'|ft\.?|feet)\s*)(\d{1,2})(\s*(?:"|''|in\.?|inches)?)`, keep, keep, apply('JM_INCHES'), keep],
], keep, '172')
domain('JM_L3_HEIGHT', 'JM_HEIGHT',
  byName(['height(_?(cm|m|in|inches|ft|feet|metres?|meters?))?|stature|ht_?(cm|in)', 0.85]))

const EYE_COLOURS = ['Brown', 'Dark brown', 'Light brown', 'Black', 'Hazel', 'Green', 'Blue', 'Grey']
categorical('JM_EYE_COLOUR', 'jm-eye-colours.txt', EYE_COLOURS, 'Amber')
domain('JM_L3_EYE_COLOUR', 'JM_EYE_COLOUR',
  byName(['eye_?colou?r|eyes_?colou?r|colou?r_?of_?eyes|eyes', 0.9]),
  byList([['jm-detect-eye-colours.txt', [...EYE_COLOURS, 'brn', 'blk', 'blu', 'grn', 'hzl', 'gry', 'amber'], 0.6]], { reject: 0.4 }))

// (b) Filiation: who a person descends from, and whether they were born in wedlock. The Status of
// Children Act abolished illegitimacy in 1976, but older registers and benefit files keep the mark.
const FILIATION = ['Born in wedlock', 'Born out of wedlock', 'Legitimated', 'Adopted', 'Father not recorded', 'Not stated']
categorical('JM_FILIATION', 'jm-filiation.txt', FILIATION, 'Father unknown')
domain('JM_L3_FILIATION', 'JM_FILIATION',
  byName(['filiation|legitimacy|legitimate|illegitimate|legitimated|born_?(in|out_?of)_?wedlock|wedlock(_?status)?|parentage|paternity(?!_?(test|leave))(_?(status|acknowledged|declared|established|order))?|father_?(unknown|named|recorded|on_?record|acknowledged)|affiliation_?order|adopt(ed|ion)(_?(status|order|flag|date))?|birth_?parents?|biological_?(mother|father|parents?)', 0.9]),
  byList([['jm-detect-filiation.txt', [...FILIATION, 'legitimate', 'illegitimate', 'in wedlock', 'out of wedlock', 'adopted', 'father unknown', 'unknown father'], 0.8],
    // Often a yes/no flag (father named, adopted): it backs up the column name but decides nothing alone.
    ['jm-detect-flag.txt', ['y', 'n', 'yes', 'no', '0', '1'], 0.3],
  ], { reject: 0.4 }))

// (b) Racial or ethnic origin, as the 2011 census asked for it; the Maroons are a people of their own.
const ETHNIC = ['Black', 'East Indian', 'Chinese', 'White', 'Mixed', 'Maroon', 'Other', 'Not stated']
categorical('JM_ETHNICITY', 'jm-ethnic-groups.txt', ETHNIC, 'Syrian/Lebanese')
domain('JM_L3_ETHNICITY', 'JM_ETHNICITY',
  byName(['ethnic(ity|_?group|_?origin|_?background|_?identity)?|race|racial_?(origin|group|background)|indigenous(_?(status|group|people|peoples))?|maroon(_?(community|status))?', 0.9]),
  byList([['jm-detect-ethnic-groups.txt', [...ETHNIC, 'african', 'afro-jamaican', 'black', 'indian', 'east indian', 'indo-jamaican', 'chinese', 'chinese-jamaican', 'white', 'european', 'mixed', 'mixed race', 'maroon', 'syrian', 'lebanese', 'syrian/lebanese', 'other', 'not stated'], 0.9],
    // Self-identification is often a yes/no flag: it backs up the column name but decides nothing alone.
    ['jm-detect-flag.txt', ['y', 'n', 'yes', 'no', '0', '1'], 0.3],
  ], { reject: 0.4 }))

// (c) Religious beliefs: the denominations of the 2011 census.
const RELIGIONS = ['Church of God', 'Seventh-day Adventist', 'Pentecostal', 'Baptist', 'Anglican', 'Roman Catholic', 'United Church', 'Methodist', 'Revivalist', 'Brethren', "Jehovah's Witness", 'Moravian', 'Rastafarian', 'Hindu', 'Muslim', 'Jewish', "Bahá'í", 'Other', 'None']
categorical('JM_RELIGION', 'jm-religions.txt', RELIGIONS, 'Salvation Army')
domain('JM_L3_RELIGION', 'JM_RELIGION',
  byName(['religion[a-z_]*|religious_?(affiliation|denomination|belief|beliefs|preference|group)|denomination|faith|church(_?(name|affiliation|member|membership|attended))?|creed|congregation', 0.95]),
  byList([['jm-detect-religions.txt', [...RELIGIONS, 'church of god', 'new testament church of god', 'church of god of prophecy', 'adventist', 'sda', 'pentecostal', 'baptist', 'anglican', 'catholic', 'rc', 'united church', 'methodist', 'revival', 'pocomania', 'brethren', 'jehovah witness', 'moravian', 'rastafari', 'rasta', 'hindu', 'muslim', 'islam', 'jewish', 'bahai', 'christian', 'protestant', 'salvation army', 'none', 'no religion', 'atheist', 'agnostic'], 0.9]], { reject: 0.4 }))

// (c) "Philosophical beliefs … or other beliefs of a similar nature": no shared vocabulary, so suppressed.
domain('JM_L3_BELIEF', 'JM_SUPPRESSED_CATEGORY',
  byName(['beliefs?|philosophical_?(beliefs?|convictions?)|conscientious_?objection|conscientious_?objector|moral_?(beliefs?|convictions?)|personal_?convictions?|worldview', 0.9]))

// (c) Political opinions: a leaning, and the party a person supports.
const IDEOLOGIES = ['Left', 'Centre-left', 'Centre', 'Centre-right', 'Right', 'No preference', 'Prefers not to say']
categorical('JM_POLITICAL_OPINION', 'jm-political-opinions.txt', IDEOLOGIES, 'Centre-right')
domain('JM_L3_POLITICAL_OPINION', 'JM_POLITICAL_OPINION',
  byName(['political_?(opinion|opinions|view|views|orientation|leaning|leanings|preference|ideology)|ideology|voting_?intention|vote_?intention|intended_?vote|swing_?voter', 0.9]),
  byList([['jm-detect-political-opinions.txt', [...IDEOLOGIES, 'left wing', 'right wing', 'centre left', 'center left', 'centre right', 'center right', 'center', 'liberal', 'conservative', 'progressive', 'undecided', 'swing'], 0.7]], { reject: 0.4 }))

// The two parties that have alternated in government since 1944.
const PARTIES = ['Jamaica Labour Party', "People's National Party", 'Independent', 'No party']
categorical('JM_POLITICAL_PARTY', 'jm-political-parties.txt', PARTIES, 'National Democratic Movement')
domain('JM_L3_POLITICAL_AFFILIATION', 'JM_POLITICAL_PARTY',
  byName(
    ['political_?(party|body|membership|affiliation|group)|party_?(membership|member|affiliation|card|group|supporter|preference)|preferred_?party|member_?of_?(party|political_?(party|body))|party_?(of_?)?choice', 0.95],
    ['party(?!_?(id|key|type|role|site|ref|code|number|no|size))', 0.5],
  ),
  byList([['jm-detect-political-parties.txt', [...PARTIES, 'JLP', 'PNP', 'NDM', 'National Democratic Movement', 'labourite', 'comrade', 'green', 'orange', 'independent', 'none', 'no party'], 0.8]], { reject: 0.4 }))

// (d) Membership in any trade union.
domain('JM_L3_TRADE_UNION', 'JM_SUPPRESSED_CATEGORY',
  byName(['trade_?union(_?(member|membership|name|dues))?|union_?(member|membership|affiliation|name|dues|fees|code|branch|local|delegate|representative)|unioni[sz]ed|labou?r_?union|bargaining_?unit|collective_?(agreement|bargaining)|staff_?association|shop_?steward', 0.95]),
  byList([['jm-detect-trade-unions.txt', ['BITU', 'NWU', 'UAWU', 'JCTU', 'JTA', 'NAJ', 'JCSA', 'UCASE', 'TUCAW', 'JALGO', 'Bustamante Industrial Trade Union', "National Workers' Union", 'National Workers Union', 'University and Allied Workers Union', 'Jamaica Confederation of Trade Unions', "Jamaica Teachers' Association", 'Jamaica Teachers Association', 'Nurses Association of Jamaica', 'Jamaica Civil Service Association', 'Union of Clerical, Administrative and Supervisory Employees', 'Jamaica Association of Local Government Officers', 'Police Federation', 'unionized', 'union member'], 0.6]], { reject: 0.3 }))

// (f) Sex life. Sexual orientation reveals it, and in Jamaica it also exposes people to the criminal
// law: the Offences Against the Person Act still punishes sex between men.
const ORIENTATIONS = ['Heterosexual', 'Gay', 'Lesbian', 'Bisexual', 'Pansexual', 'Asexual', 'Other', 'Prefers not to say']
categorical('JM_SEXUAL_ORIENTATION', 'jm-sexual-orientations.txt', ORIENTATIONS, 'Bisexual')
domain('JM_L3_SEXUAL_ORIENTATION', 'JM_SEXUAL_ORIENTATION',
  byName(['sexual_?(orientation|preference)|orientation_?sexual|orient_?sexual|msm(_?(status|flag))?', 0.95]),
  byList([['jm-detect-sexual-orientations.txt', [...ORIENTATIONS, 'straight', 'homosexual', 'queer', 'lgbt', 'lgbtq', 'lgbtqi+', 'prefer not to say'], 0.8]], { reject: 0.4 }))

domain('JM_L3_SEXUAL_LIFE', 'JM_SUPPRESSED_CATEGORY',
  byName(['sex(ual)?_?life|sexual_?(activity|behavio(u)?r|history|partners?|practices?)|sexually_?active|number_?of_?sexual_?partners|age_?(at_?)?first_?(sex|intercourse)|transactional_?sex|sex_?work(er)?', 0.9]))

// Not named in section 2; treated as sensitive because it exposes people to the same discrimination.
const IDENTITIES = ['Woman', 'Man', 'Trans woman', 'Trans man', 'Non-binary', 'Gender fluid', 'Other', 'Prefers not to say']
categorical('JM_GENDER_IDENTITY', 'jm-gender-identities.txt', IDENTITIES, 'Trans man')
domain('JM_L3_GENDER_IDENTITY', 'JM_GENDER_IDENTITY',
  byName(['gender_?(identity|expression)|preferred_?pronouns?|pronouns?|transgender|trans_?status', 0.95]),
  byList([['jm-detect-gender-identities.txt', [...IDENTITIES, 'cisgender', 'transgender', 'trans', 'nonbinary', 'female', 'male'], 0.7]], { reject: 0.4 }))

// ── HEALTH · Physical or mental health or condition (s. 2 (e)) ───────────────

domain('JM_HEALTH_ID', 'JM_CM_ALNUM',
  byName(
    ['nhf(_?(card|no|num|number|id|member_?(no|id)))?|jadep(_?(card|no|number|id))?|drug_?serv(_?(no|number|card))?|medical_?record(_?(no|num|number))?|mrn|patient_?(id|no|num|number)|docket_?(no|num|number)_?(patient|hospital|clinic)|chart_?(no|num|number)|health_?(record|card|id|insurance)(_?(no|num|number))?|hospital_?(no|num|number)|admission_?(no|num|number)|prescription_?(no|num|number)|sick_?(note|leave|certificate)_?(no|num|number)|medical_?certificate_?(no|num|number)', 0.85],
    ['chart|admission|episode', 0.55],
  ))

const ICD10 = ['I10', 'E11', 'E78', 'J45', 'J06', 'J02', 'J20', 'K29', 'K21', 'K59', 'M54', 'M17', 'M25', 'N39', 'N20', 'R51', 'R10', 'H10', 'H66', 'L23', 'L30', 'B34', 'A09', 'E03', 'E66', 'D50', 'I83', 'K80', 'K40', 'S93', 'S60', 'Z00', 'J30', 'J32', 'G43', 'M79', 'R05']
const ICD10_DECIMAL = ['E11.9', 'E78.5', 'J45.9', 'J06.9', 'J02.9', 'J20.9', 'K29.7', 'K21.9', 'K59.0', 'M54.5', 'M17.9', 'N39.0', 'N20.0', 'R10.4', 'H10.9', 'H66.9', 'L23.9', 'L30.9', 'B34.9', 'A09.9', 'E03.9', 'E66.9', 'D50.9', 'I83.9', 'K80.2', 'K40.9', 'S93.4', 'S60.0', 'Z00.0', 'J30.4', 'J32.9', 'G43.9', 'M79.1']
decompose('JM_DIAGNOSIS', [
  [String.raw`([A-TV-Za-tv-z]\d{2}\.\d{1,2})`, apply(lookup('JM_ICD10_DECIMAL', 'jm-icd10-decimal.txt', ICD10_DECIMAL, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [String.raw`([A-TV-Za-tv-z]\d{2,3})`, apply(lookup('JM_ICD10', 'jm-icd10.txt', ICD10, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [FLAG, apply('JM_FLAG')],
], apply(lookup('JM_DIAGNOSIS_TEXT', 'jm-diagnoses.txt', ['Essential hypertension', 'Type 2 diabetes mellitus', 'Asthma', 'Low back pain', 'Chronic gastritis', 'Acute nasopharyngitis', 'Urinary tract infection', 'Migraine', 'Hypothyroidism', 'Dyslipidaemia', 'Obesity', 'Osteoarthritis of the knee', 'Acute bronchitis', 'Acute tonsillitis', 'Contact dermatitis', 'Acute otitis media', 'Ankle sprain', 'Conjunctivitis', 'Iron deficiency anaemia', 'Gastro-oesophageal reflux disease', 'Irritable bowel syndrome', 'Tendinitis', 'Acute sinusitis', 'Tension headache', 'Varicose veins', 'Inguinal hernia', 'Kidney stones', 'Gallstones', 'Acute gastroenteritis', 'Routine child health check'])), 'F32.9')
domain('JM_HEALTH_DIAGNOSIS', 'JM_DIAGNOSIS',
  byName(['diagnos(is|es|tic)[a-z_]*|dx|icd_?(10|11)?(_?code)?|medical_?(condition|history|problem|diagnosis)|health_?(condition|problem)|chronic_?(condition|disease|illness)|illness(es)?|disease[a-z_]*|comorbidit(y|ies)|allerg(y|ies)|cause_?of_?(death|admission|illness|injury|sick_?leave)|reason_?for_?(visit|admission|consultation|sick_?leave)|presenting_?complaint|chief_?complaint|pre_?existing_?conditions?', 0.85]),
  // 0.5: codes shaped like ICD-10 appear in other catalogs too; the name has to agree.
  byPattern([[String.raw`[A-TV-Za-tv-z]\d{2}(\.\d{1,2}|\d)?`, 0.5]], { reject: 0.3 }))

const MEDICATIONS = ['Paracetamol', 'Ibuprofen', 'Naproxen', 'Diclofenac', 'Metformin', 'Glibenclamide', 'Losartan', 'Enalapril', 'Amlodipine', 'Atorvastatin', 'Omeprazole', 'Levothyroxine', 'Amoxicillin', 'Ciprofloxacin', 'Salbutamol', 'Loratadine', 'Chlorphenamine', 'Aspirin', 'Prednisone', 'Hydrochlorothiazide', 'Simvastatin', 'Ferrous sulphate', 'Folic acid', 'Cetirizine', 'Azithromycin', 'Multivitamin']
categorical('JM_MEDICATION', 'jm-medications.txt', MEDICATIONS, 'Sertraline 50 mg')
domain('JM_HEALTH_MEDICATION', 'JM_MEDICATION',
  byName(['medications?|medicines?|drugs?_?(name|prescribed)|prescribed_?(drugs?|medications?)|prescription_?(drug|medication|item)s?|active_?ingredient|dosage|treatment_?(drug|medication)', 0.85]),
  byList([['jm-detect-medications.txt', [...MEDICATIONS, 'acetaminophen', 'sertraline', 'fluoxetine', 'escitalopram', 'quetiapine', 'clonazepam', 'alprazolam', 'diazepam', 'lithium', 'methylphenidate', 'risperidone', 'olanzapine', 'haloperidol', 'tenofovir', 'emtricitabine', 'efavirenz', 'dolutegravir', 'hydroxyurea', 'insulin', 'warfarin', 'levetiracetam', 'valproic acid', 'naltrexone', 'misoprostol', 'levonorgestrel', 'depo-provera'], 0.7]], { reject: 0.3 }))

domain('JM_HEALTH_CLINICAL_TEXT', 'JM_FREE_TEXT',
  byName(['clinical_?notes?|progress_?notes?|nurs(e|ing)_?notes?|doctors?_?notes?|physician_?notes?|medical_?notes?|discharge_?(summary|notes?)|clinical_?summary|history_?of_?present(ing)?_?illness|hpi|physical_?exam(ination)?|assessment_?(and_?)?plan|treatment_?plan|care_?plan|triage_?notes?|soap_?notes?|anamnesis', 0.85]),
  byType(STRING(30)))

domain('JM_HEALTH_TEST_RESULT', 'JM_CM_ALNUM',
  byName(
    ['lab_?(result|test|value)s?|test_?results?|laboratory_?(result|test)s?|hiv(_?(status|test|result))?|viral_?load|cd4(_?count)?|blood_?(sugar|glucose|pressure)|glucose|hba1c|cholesterol|bmi|pregnancy_?test|drug_?(test|screen)|covid_?(test|result)|pcr_?result|pap_?(smear|test)(_?result)?|mammogram_?result|x_?ray_?result|psa(_?result)?', 0.8],
    ['result|test', 0.5],
  ))

// Blood type is health data and, by name in section 2, biometric data as well.
const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']
domain('JM_HEALTH_BLOOD_GROUP', ENGINE.BLOOD_TYPE,
  byName(['blood_?(type|group)|abo(_?rh)?|rh_?factor|rh', 0.9]),
  byList([['jm-detect-blood-groups.txt', [...BLOOD_GROUPS, '0+', '0-', 'a pos', 'a neg', 'b pos', 'b neg', 'ab pos', 'ab neg', 'o pos', 'o neg', 'a positive', 'a negative', 'b positive', 'b negative', 'ab positive', 'ab negative', 'o positive', 'o negative'], 0.9]], { reject: 0.4 }))

// The functional domains of the census disability questions.
const DISABILITIES = ['Seeing', 'Hearing', 'Walking or climbing steps', 'Remembering or concentrating', 'Self-care', 'Communicating', 'Multiple', 'None']
categorical('JM_DISABILITY', 'jm-disabilities.txt', DISABILITIES, 'Severe psychosocial disability')
domain('JM_HEALTH_DISABILITY', 'JM_DISABILITY',
  byName(['disabilit(y|ies)[a-z_]*|disabled|impairments?|handicap(ped)?|special_?needs|functional_?limitations?|difficulty_?(seeing|hearing|walking|remembering|concentrating|self_?care|communicating)|invalidity(_?(status|grade))?|jcpd_?(no|number|registered|registration)', 0.9]),
  byList([['jm-detect-disabilities.txt', [...DISABILITIES, 'visual', 'blind', 'deaf', 'hearing impaired', 'physical', 'mobility', 'intellectual', 'mental', 'psychosocial', 'learning', 'autism', 'multiple', 'none', 'no disability'], 0.6]], { reject: 0.3 }))

// Reproductive and mental health: the values have no shared vocabulary, so they are suppressed
// (flags and numeric codes keep their shape).
domain('JM_HEALTH_REPRODUCTIVE', 'JM_SUPPRESSED_CATEGORY',
  byName(['pregnan(t|cy)[a-z_]*|gestation(al)?(_?age)?|weeks_?(of_?)?(pregnancy|gestation)|lmp|last_?menstrual_?period|abortions?|miscarriages?|contracepti(on|ve)[a-z_]*|family_?planning(_?method)?|fertility|infertility|ivf|gravida|antenatal|prenatal|postnatal|postpartum|sti|sexually_?transmitted(_?infection)?', 0.9]))

domain('JM_HEALTH_MENTAL', 'JM_SUPPRESSED_CATEGORY',
  byName(['mental_?(health|illness|disorder|condition)|psychiatr[a-z_]*|psycholog[a-z_]*|depression|anxiety|suicid[a-z_]*|self_?harm|substance_?(use|abuse|misuse)|alcohol(ism|_?use|_?abuse|_?dependence)|drug_?(use|abuse|addiction|dependence)|ganja_?use|cannabis_?use|addiction[a-z_]*|rehab(ilitation)?_?(programme|program|centre|center|status)', 0.9]))

// ── FIN · Financial data ────────────────────────────────────────────────────
//
// The Act does not count financial data as sensitive, but banks keep it under the duty of
// confidentiality of the Banking Services Act, 2014, and credit bureaus under the Credit Reporting
// Act, 2010. Reduced to a balance, an income or a benefit, it still identifies in a small population.

decompose('JM_CREDIT', [
  // A three-digit score gets other digits; flags stay flags.
  [String.raw`(\d{2,3})`, CM],
  [FLAG, apply('JM_FLAG')],
], apply(lookup('JM_CREDIT_STATUS', 'jm-credit-statuses.txt', ['Current', '30 days past due', '60 days past due', '90 days past due', '120 days past due', 'Over 120 days past due', 'In collections', 'Written off', 'Restructured', 'No credit history'])), '90 days past due')
domain('JM_FIN_CREDIT_REFERENCE', 'JM_CREDIT',
  byName(['credit_?(score|rating|history|report|status|bureau|reference|risk|grade|standing)|crif(_?(score|report|status))?|creditinfo(_?(score|report|status))?|delinquen(cy|t)(_?(status|days))?|days_?(past_?due|in_?arrears|overdue)|dpd|arrears(_?(status|days))?|past_?due(_?(days|status))?|overdue_?(days|status)|default_?(status|flag|indicator)|defaulted|written_?off|write_?off(_?(status|flag))?|collections?_?status|bad_?debt|loan_?(status|classification|grade)|non_?performing|npl', 0.9]))

domain('JM_FIN_DEBT', ENGINE.CM_NUMERIC,
  byName(['loan_?(amount|balance|principal|outstanding)|outstanding_?(balance|amount|debt|loan|principal)|debt(_?(amount|total|balance))?|amount_?(owed|due|outstanding|in_?arrears|overdue)|balance_?(owed|outstanding|due)|arrears_?amount|credit_?limit|mortgage_?(balance|amount)|instal?lment(_?amount)?|monthly_?(payment|repayment)', 0.85]),
  byType(NUMBER()))

domain('JM_FIN_INCOME', ENGINE.CM_NUMERIC,
  byName(['salary|salaries|wages?|income[a-z_]*|gross_?(pay|salary|income|earnings)|net_?(pay|salary|income|earnings)|(monthly|annual|weekly|fortnightly)_?(income|salary|earnings|pay|wage)|earnings|remuneration|basic_?(pay|salary)|emoluments?|insurable_?earnings|household_?income|take_?home_?pay', 0.85]),
  byType(NUMBER()))

domain('JM_FIN_ASSETS', ENGINE.CM_NUMERIC,
  byName(['net_?worth|assets?_?(value|total)|total_?assets|property_?value|land_?value|market_?value|appraised_?value|valuation_?amount|savings(_?balance)?|account_?balance|deposit_?balance|fixed_?deposit(_?amount)?|investment_?(balance|value|amount)|share_?(balance|capital)|unit_?trust_?(balance|value)', 0.85]),
  byType(NUMBER()))

domain('JM_FIN_PENSION', ENGINE.CM_NUMERIC,
  byName(['pension(_?(amount|payment|monthly|benefit_?amount|balance))?|monthly_?pension|retirement_?(pension|benefit|amount|balance)|nis_?pension(_?amount)?|survivors?_?pension(_?amount)?|widow(er)?s?_?pension(_?amount)?|invalidity_?pension(_?amount)?|gratuity(_?amount)?|superannuation(_?(balance|amount))?|provident_?fund(_?balance)?', 0.9]),
  byType(NUMBER()))

// The benefits the National Insurance Scheme pays. Most reveal a health event or a death in the family.
const NIS_BENEFITS = ['Old age pension', 'Invalidity benefit', "Widow's or widower's benefit", "Orphan's benefit", 'Special child benefit', 'Employment injury benefit', 'Disablement benefit', 'Maternity allowance', 'Funeral grant', 'Death benefit', 'None']
categorical('JM_NIS_BENEFIT', 'jm-nis-benefits.txt', NIS_BENEFITS, 'Special child benefit')
domain('JM_FIN_NIS_BENEFIT', 'JM_NIS_BENEFIT',
  byName(['nis_?(benefit|claim)(_?(type|status|category))?|benefit_?(type|claim|category|name|code)|claim_?type|(sickness|maternity|funeral|invalidity|survivors?|widow(er)?s?|orphans?|employment_?injury|disablement|old_?age)_?(benefit|allowance|grant|claim)|national_?insurance_?(benefit|claim)(_?type)?', 0.9]),
  byList([['jm-detect-nis-benefits.txt', [...NIS_BENEFITS, 'old age', 'invalidity', 'widow', 'widower', 'orphan', 'special child', 'employment injury', 'disablement', 'maternity', 'funeral', 'death', 'none'], 0.8]], { reject: 0.4 }))

// Social assistance, 2026: PATH, the cash transfer of the Ministry of Labour and Social Security,
// the social pension, the Rehabilitation Programme and the NHF and JADEP subsidies.
const PROGRAMMES = ['PATH', 'Social Pension', 'Rehabilitation Programme', 'Poor Relief', 'NHF subsidy', 'JADEP', 'Other programme', 'None']
categorical('JM_SOCIAL_PROGRAMME', 'jm-social-programmes.txt', PROGRAMMES, 'School feeding programme')
domain('JM_FIN_SOCIAL_PROGRAMME', 'JM_SOCIAL_PROGRAMME',
  byName(['path(_?(beneficiary|programme|program|member|recipient|status|family))?|programme_?of_?advancement|social_?(programme|program|assistance|welfare|benefit|transfer|pension)s?|welfare_?(programme|program|recipient|status)|cash_?transfer|poor_?relief|beneficiary_?of_?(programme|program)|programme_?beneficiary|rehabilitation_?(grant|programme|program)|compassionate_?grant', 0.9]),
  byList([['jm-detect-social-programmes.txt', [...PROGRAMMES, 'path', 'programme of advancement through health and education', 'social pension', 'poor relief', 'rehabilitation grant', 'compassionate grant', 'nhf', 'jadep', 'none'], 0.8],
    // Being a beneficiary is often a yes/no flag: it backs up the column name but decides nothing alone.
    ['jm-detect-flag.txt', ['y', 'n', 'yes', 'no', '0', '1'], 0.3],
  ], { reject: 0.4 }))

decompose('JM_POVERTY', [
  [String.raw`([1-5])`, apply(lookup('JM_QUINTILE', 'jm-quintile.txt', ['1', '2', '3', '4', '5']))],
  [String.raw`([6-9]|10)`, apply(lookup('JM_DECILE_HIGH', 'jm-decile-high.txt', ['6', '7', '8', '9', '10']))],
  [String.raw`(?i)(decile\s*)(\d{1,2})`, keep, apply(lookup('JM_DECILE', 'jm-decile.txt', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']))],
  [String.raw`(?i)(quintile\s*)([1-5])`, keep, apply('JM_QUINTILE')],
], apply(lookup('JM_POVERTY_STATUS', 'jm-poverty-statuses.txt', ['Food poor', 'Poor', 'Vulnerable', 'Not poor'], undefined, 'PRESERVE_LOOKUP_FILE')), 'Food poor')
domain('JM_FIN_POVERTY', 'JM_POVERTY',
  byName(['poverty(_?(status|level|line|index|score|category))?|food_?poor|socio_?economic_?(status|level|index|group|class|score)|wealth_?(index|quintile)|consumption_?(quintile|decile)|income_?(quintile|decile|bracket|band)|quintile|decile|vulnerability_?(index|score)|mpi|means_?test(_?(score|result))?|beneficiary_?identification_?(score|system)|bis_?score', 0.9]),
  byList([['jm-detect-poverty.txt', ['food poor', 'indigent', 'poor', 'not poor', 'vulnerable', 'non poor', 'low', 'middle', 'high'], 0.4]], { reject: 0.3 }))

// Dwelling tenure as the census asks for it; many households live on family land or capture land.
const TENURES = ['Owned', 'Owned with mortgage', 'Rented', 'Leased', 'Rent free', 'Family land', 'Squatted', 'Other']
categorical('JM_HOUSING', 'jm-housing-tenure.txt', TENURES, 'Captured land')
domain('JM_FIN_HOUSING', 'JM_HOUSING',
  byName(
    ['housing_?(tenure|status|type|situation)|dwelling_?(tenure|ownership|type)|home_?ownership|own_?or_?rent|rent_?or_?own|owns_?(home|house)|squatt(er|ing)(_?status)?|land_?tenure|captured_?land|family_?land', 0.95],
    ['tenure', 0.55],
  ),
  byList([['jm-detect-housing-tenure.txt', [...TENURES, 'own', 'owner', 'mortgage', 'mortgaged', 'rent', 'rented', 'renting', 'rent free', 'lease', 'squatter', 'captured land', 'family land', 'government'], 0.6]], { reject: 0.3 }))

// ── PENAL · Offences and proceedings (s. 2 (g)) ─────────────────────────────
//
// The Act protects the alleged commission of an offence and its proceedings, not only convictions.
// The Criminal Records (Rehabilitation of Offenders) Act lets old convictions be expunged: a copy
// that keeps them undoes that.

categorical('JM_CRIMINAL_RECORD', 'jm-criminal-record.txt', ['No criminal record', 'Has criminal record', 'Charged', 'Case dismissed', 'Acquitted', 'Convicted', 'Record expunged', 'Not stated'], 'Convicted of larceny, 2019')
domain('JM_PENAL_CRIMINAL_RECORD', 'JM_CRIMINAL_RECORD',
  byName(
    ['criminal_?(record|history|conviction|convictions|status|background|charges?|proceedings|case_?(status|outcome))|police_?(record|certificate|clearance|report_?status)|convictions?(_?(status|record|details))?|convicted|previous_?convictions|offen[cs]es?(_?(type|committed|code|description|details))?|charged_?with|arrests?(_?(record|history))?|sentence(_?(imposed|type|length|details))?|incarcerat(ed|ion)|imprisonment|remand(ed)?(_?status)?|bail(_?status)?|probation(_?status)?|parole|verdict|acquitt(al|ed)|expunge(d|ment)', 0.95],
    ['court_?(outcome|disposal|decision|status)|case_?(outcome|disposal)|disposal', 0.55],
  ))

domain('JM_PENAL_CASE_NUMBER', 'JM_CM_ALNUM',
  byName(
    ['court_?case_?(no|num|number)|criminal_?case_?(no|num|number)|indictment_?(no|num|number)|information_?(no|num|number)|charge_?sheet_?(no|num|number)|police_?(report|station_?diary|case)_?(no|num|number)|station_?diary_?(no|number|entry)|docket_?(no|num|number)|inquest_?(no|number)', 0.9],
    ['case_?(no|num|number|ref|reference)', 0.55],
  ),
  byPattern([
    [String.raw`[A-Z]{1,4}\s?\d{1,5}/\d{4}`, 0.5],
    [String.raw`(?i)\d{1,6}\s+of\s+\d{4}`, 0.5],
  ], { reject: 0.3 }))

// ── Preset ──────────────────────────────────────────────────────────────────

const referenced = JSON.stringify([domains, algorithms.map((x) => x.config)])
const orphans = algorithms.filter((a) => !referenced.includes(`"${a.name}"`))
if (orphans.length) throw new Error(`algorithms nobody uses: ${orphans.map((a) => a.name).join(', ')}`)

// The essential pack: identity documents, names, contact, address and birth date. Loading it brings
// these domains and only what they lean on; the extended pack is everything.
const ESSENTIAL = [
  'JM_L1_TRN', 'JM_L1_NIS_NUMBER', 'JM_L1_PASSPORT', 'JM_L1_DRIVERS_LICENCE',
  'JM_L1_GIVEN_NAME', 'JM_L1_SURNAME', 'JM_L1_FULL_NAME', 'JM_L1_EMAIL', 'JM_L1_PHONE',
  'JM_L1_ADDRESS', 'JM_L1_ADDRESS_DETAIL', 'JM_L2_BIRTH_DATE',
]
const notDomains = ESSENTIAL.filter((name) => !domains.some((d) => d.name === name))
if (notDomains.length) throw new Error(`essential pack names domains the set does not have: ${notDomains.join(', ')}`)

// The version and the day it was built: bump both whenever anything in the set changes, so that
// whoever loaded an older one can see how old it is.
const VERSION = 2
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
  region: 'caribbean',
  country: 'JM',
  name: {
    en: 'Jamaica — Data Protection Act, 2020 (personal data protection)',
    'pt-BR': 'Jamaica — Data Protection Act, 2020 (proteção de dados pessoais)',
    es: 'Jamaica — Data Protection Act, 2020 (protección de datos personales)',
  },
  summary: {
    en: 'Discovers and masks Jamaican personal data under the Data Protection Act, 2020: direct identifiers (TRN, NIS number, names, contact, documents), quasi-identifiers (birth date, town, neighbourhood), the sensitive personal data of section 2 — genetic and biometric data, filiation, ethnic origin, beliefs, political opinions, trade union membership, health, sex life and offences — and financial data.',
    'pt-BR': 'Descobre e mascara dados pessoais da Jamaica segundo o Data Protection Act, 2020: identificadores diretos (TRN, número do NIS, nomes, contato, documentos), quase-identificadores (data de nascimento, cidade, bairro), os dados pessoais sensíveis da seção 2 — dados genéticos e biométricos, filiação, origem étnica, crenças, opiniões políticas, filiação sindical, saúde, vida sexual e infrações — e dados financeiros.',
    es: 'Descubre y enmascara datos personales de Jamaica conforme a la Data Protection Act, 2020: identificadores directos (TRN, número del NIS, nombres, contacto, documentos), cuasi-identificadores (fecha de nacimiento, ciudad, barrio), los datos personales sensibles de la sección 2 — datos genéticos y biométricos, filiación, origen étnico, creencias, opiniones políticas, afiliación sindical, salud, vida sexual e infracciones — y datos financieros.',
  },
  profileSet: {
    name: `JM - Data Protection Act 2020 - v${VERSION}`,
    description: 'Data Protection Act 2020 - personal data',
    threshold: 60,
    classifiers: classifiers.map((c) => c.name),
  },
  packs: {
    essential: {
      description: 'Essential pack of the Data Protection Act 2020',
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

console.log(`${domains.length} domains, ${classifiers.length} classifiers, ${algorithms.length} algorithms, ${files.size} files`)
