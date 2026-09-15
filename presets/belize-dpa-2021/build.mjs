#!/usr/bin/env node
/**
 * Builds the Belize (Data Protection Act, 2021) pre-configured profile set: preset.json and files/.
 *
 *   node presets/belize-dpa-2021/build.mjs
 *
 * source/ holds the hand-kept lists (given names, surnames, streets) and the 221 cities, towns,
 * villages and communities of the 2022 census with their district, location and population.
 * Everything in files/ and preset.json is generated from them and from the definitions below —
 * edit here, then build, then run verify.mjs.
 *
 * Structure of the set
 *   L1      direct identifiers        social security number, TIN, names, contact, documents…
 *   L2      quasi-identifiers         birth date, age, sex, town or village, occupation…
 *   L3      sensitive personal data   the section 2 categories: ethnic origin, religious and similar
 *                                     beliefs, political opinions, membership of a political body,
 *                                     trade union, genetic and biometric data, sexual orientation
 *                                     and sexual life
 *   HEALTH  health records            not in the section 2 list, but health records (s. 2, s. 33)
 *   FIN     financial record or position (s. 2 (i), sensitive)
 *   PENAL   criminal record and proceedings (s. 2 (j) and (k), sensitive; s. 10(2))
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
  description: 'Column name (and the variants used in Belizean systems).',
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

/** Values: [regex, strength, { checksum, clean, note }]. Whole value unless `partial`. */
const byPattern = (rules, { reject = 0.3, partial = false } = {}) => (d) => ({
  name: `${d} - Regex`, framework: 'REGEX', domain: d,
  description: 'Shape of the values.',
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
  description: 'Known values.',
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

const GIVEN_NAMES = unique(readLines('given-names.txt'))
const SURNAMES = unique(readLines('surnames.txt'))

const PLACES = readLines('places.tsv').map((line) => {
  const [name, district, lat, lon, population] = line.split('\t')
  return { code: name + '|' + district, name, district, lat: Number(lat), lon: Number(lon), population: Number(population) }
})
if (PLACES.length !== 221) throw new Error(`expected the 221 places of the 2022 census, found ${PLACES.length}`)
const DISTRICTS = ['Belize', 'Cayo', 'Corozal', 'Orange Walk', 'Stann Creek', 'Toledo']
for (const p of PLACES) if (!DISTRICTS.includes(p.district)) throw new Error(`${p.name}: unknown district ${p.district}`)

// ── Shared algorithms ───────────────────────────────────────────────────────

// Vowels map to vowels and consonants to consonants, so a masked document number keeps its
// structure; digits map to digits. Separators are in no group and stay. minMaskedPositions 0 lets
// a placeholder such as "N/A" through instead of failing the row.
algorithm('BZ_CM_ALNUM', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'AEIOU', 'BCDFGHJKLMNPQRSTVWXYZ', 'aeiou', 'bcdfghjklmnpqrstvwxyz', 'ÁÉÍÓÚÜ', 'áéíóúü'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '000123456')
// Hex letters form their own group, so a MAC, UUID or IPv6 stays valid hex.
algorithm('BZ_CM_HEX', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'abcdef', 'ABCDEF', 'ghijklmnopqrstuvwxyz', 'GHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '3c:22:fb:9a:10:e4')
decompose('BZ_REDACT', [['(.+)', { type: 'REDACT', redactCharacter: 'X' }]], keep, 'secret123')
lookup('BZ_SUPPRESS', 'bz-not-stated.txt', ['Not stated'], 'Major depressive disorder', 'PRESERVE_LOOKUP_FILE')

// Yes/no columns keep their vocabulary: a CHAR(1) Y/N stays Y/N.
decompose('BZ_FLAG', [
  ['(?i)(yes|no)', apply(lookup('BZ_FLAG_YES_NO', 'bz-flag-yes-no.txt', ['Yes', 'No']))],
  [String.raw`(?i)(s[ií])`, apply(lookup('BZ_FLAG_SI_NO', 'bz-flag-si-no.txt', ['Sí', 'No']))],
  ['(?i)(true|false)', apply(lookup('BZ_FLAG_TRUE_FALSE', 'bz-flag-true-false.txt', ['true', 'false']))],
  ['(?i)([yn])', apply(lookup('BZ_FLAG_Y_N', 'bz-flag-y-n.txt', ['Y', 'N']))],
  ['(?i)(s)', apply(lookup('BZ_FLAG_S_N', 'bz-flag-s-n.txt', ['S', 'N']))],
  ['([01])', apply(lookup('BZ_FLAG_0_1', 'bz-flag-0-1.txt', ['0', '1']))],
], keep, 'Y')

const FLAG = String.raw`(?i)(yes|no|s[ií]|true|false|[yns01])`
/**
 * A categorical attribute: flags stay flags, numeric codes get other digits, and any other value
 * is replaced by one from `values` — or suppressed, when no list is given.
 */
function categorical(name, fileName, values, input) {
  const replacement = values ? lookup(`${name}_LIST`, fileName, values) : 'BZ_SUPPRESS'
  return decompose(name, [[FLAG, apply('BZ_FLAG')], [String.raw`(\d{1,6})`, apply('BZ_CM_ALNUM')]], apply(replacement), input)
}
categorical('BZ_SUPPRESSED_CATEGORY', null, null, 'Major depressive disorder')
const CM = apply('BZ_CM_ALNUM')

// ── L1 · Identity numbers ───────────────────────────────────────────────────
//
// Belize has no national identity card for citizens. The Social Security Board card is the everyday
// identification: every worker must have one, banks and the credit bureau ask for it, and hospitals
// issue health cards against it. The number has nine digits and is issued in sequence, with no
// public check digit. The Belize Tax Service TIN has six digits and a check digit that is not shown
// to the taxpayer. Both are masked digit by digit: length, separators and uniqueness stay.

domain('BZ_L1_SOCIAL_SECURITY_NUMBER', 'BZ_CM_ALNUM',
  byName(['ssn|ss_?(no|num|number|nbr)|social_?security(_?(no|num|number|nbr|card|id))?|soc_?sec(_?(no|num|number))?|ssb_?(no|num|number|id|card)|social_?sec_?card|insured_?(person_?)?(no|num|number)|n(o|um|ro|umero)_?(de_?)?seguro_?social|seguro_?social', 0.9]),
  byPattern([
    [String.raw`\d{3}[\s\-]\d{3}[\s\-]\d{3}`, 0.7],
    [String.raw`\d{9}`, 0.5],
  ], { reject: 0.3 }))

domain('BZ_L1_TIN', 'BZ_CM_ALNUM',
  byName(['tin|tin_?(no|num|number)|tax_?(id|identification)(_?(no|num|number))?|tax_?payer_?(id|no|num|number)|taxpayer_?(id|no|num|number)|bts_?(no|id|tin|number)|gst_?(no|number|reg|registration)(_?no)?|n(o|um|ro)_?contribuyente|nit', 0.9]))

domain('BZ_L1_PASSPORT', 'BZ_CM_ALNUM',
  byName(['passport[a-z_]*|pass_?port_?(no|num|number)|pp_?(no|num|number)|travel_?document(_?(no|num|number))?|pasaporte[a-z_]*', 0.85]),
  byPattern([[String.raw`[A-Z]{1,2}\d{6,8}`, 0.3]], { reject: 0.3 }))

// The voter ID card of the Elections and Boundaries Department carries an ID number and a
// registration number.
domain('BZ_L1_VOTER_ID', 'BZ_CM_ALNUM',
  byName(['voter_?(id|card|reg|registration)(_?(no|num|number|card))?|voters_?(id|card|reg|registration)(_?(no|num|number))?|elector(al)?_?(id|no|num|number|card|reg|registration)(_?(no|num|number))?|ebd_?(no|id|reg|number)|registration_?(no|num|number)_?(voter|elector)|elector_?reg_?no', 0.85]))

domain('BZ_L1_DRIVERS_LICENCE', 'BZ_CM_ALNUM',
  byName(['drivers?_?licen[cs]e(_?(no|num|number))?|driving_?licen[cs]e(_?(no|num|number))?|dl_?(no|num|number)|licen[cs]e_?(no|num|number)(?!_?(plate|vehicle|business|trade|liquor|professional))|licencia_?(de_?)?conducir', 0.85]))

domain('BZ_L1_IMMIGRATION_DOCUMENT', 'BZ_CM_ALNUM',
  byName(['permanent_?residen(ce|cy|t)(_?(permit|card|no|num|number|id))?|pr_?(card|permit)(_?(no|number))?|work_?permit(_?(no|num|number))?|temporary_?employment_?permit|tep_?(no|num|number)|immigration_?(permit|document|card|file|status_?no|no|num|number)|visa_?(no|num|number)|residen(ce|cy)_?permit(_?(no|number))?|nationality_?certificate(_?(no|number))?|naturali[sz]ation_?(certificate|cert|no|number)|refugee_?(id|card|no|number)|asylum_?(id|no|number)|qrp_?(id|no|number|card)|carne_?migratorio|permiso_?(de_?)?(residencia|trabajo)', 0.85]))

// Birth, death and marriage registrations of the Vital Statistics Unit.
domain('BZ_L1_VITAL_RECORD', 'BZ_CM_ALNUM',
  byName(
    ['birth_?cert(ificate)?(_?(no|num|number|entry))?|death_?cert(ificate)?(_?(no|num|number))?|marriage_?cert(ificate)?(_?(no|num|number))?|registry_?entry(_?(no|number))?|vital_?(record|statistics)_?(no|num|number)|certificado_?(de_?)?(nacimiento|defuncion|matrimonio)|acta_?(de_?)?(nacimiento|defuncion|matrimonio)', 0.85],
    ['entry_?(no|number)', 0.55],
  ))

// ── L1 · Names ──────────────────────────────────────────────────────────────

const NOT_A_PERSON = 'product|prod|item|article|company|business|trade|brand|file|street|road|avenue|village|town|city|district|country|bank|branch|plan|campaign|project|service|table|column|field|user|host|server|domain|model|category|type|school|college|institution|course|programme|program|subject|document|doc|centre|center|unit|clinic|hospital|area|department|dept|position|system|app|application|group|list|report|process|event|task|profile|role|class|object|account|drug|medication|diagnosis|study|benefit|party|union|religion|ethnicity|language|place|store|shop|warehouse|supplier|vendor|contract|policy|insurance|org|organi[sz]ation|entity|parameter|variable|method|function|index|job|script|queue|resource|network|device|template|image|photo|page|site|module|menu|option|action|permission|tax|currency|issuer|invoice|payment|form|zone|route|line|sector|building|display|key|tag|label|title|code|config|setting|firm|employer|estate|parcel|registration_?section|producto|articulo|empresa|archivo|calle|distrito|pais|banco|escuela|colegio|documento|servicio|categoria|tipo|usuario'
const PERSON_ROLE = 'customer|cust|client|patient|employee|emp|staff|worker|member|student|pupil|insured|beneficiary|holder|account_?holder|policy_?holder|mother|father|parent|guardian|spouse|partner|next_?of_?kin|doctor|physician|nurse|contact|emergency_?contact|guarantor|debtor|borrower|applicant|signatory|witness|representative|owner|tenant|landlord|victim|complainant|accused|defendant|donor|heir|person|driver|agent|citizen|elector|voter|taxpayer|child|dependant|dependent|relative|officer|teacher|cliente|paciente|empleado|beneficiario|titular|madre|padre|conyuge|persona'

// Each word from the list; three words are the most a given-name column holds.
decompose('BZ_GIVEN_NAMES', [
  [String.raw`(\S+)`, apply('BZ_GIVEN_NAME')],
  [String.raw`(\S+)\s+(\S+)`, apply('BZ_GIVEN_NAME'), apply('BZ_GIVEN_NAME')],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, apply('BZ_GIVEN_NAME'), apply('BZ_GIVEN_NAME'), apply('BZ_GIVEN_NAME')],
], CM, 'Maria Isabel')
algorithm('BZ_GIVEN_NAME', 'name.Name', {
  lookupFile: { uri: file('bz-given-names.txt', GIVEN_NAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Kenrick')
// Surnames: one, as the civil registry writes them, or two in the Hispanic way, or hyphenated.
decompose('BZ_SURNAMES', [
  // Before the single word, which would take the hyphenated surname whole.
  [String.raw`([^\s\-]+)(\-)([^\s\-]+)`, apply('BZ_SURNAME'), keep, apply('BZ_SURNAME')],
  [String.raw`(\S+)`, apply('BZ_SURNAME')],
  [String.raw`(\S+)\s+(\S+)`, apply('BZ_SURNAME'), apply('BZ_SURNAME')],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, apply('BZ_SURNAME'), apply('BZ_SURNAME'), apply('BZ_SURNAME')],
], CM, 'Gillett')
algorithm('BZ_SURNAME', 'name.Name', {
  lookupFile: { uri: file('bz-surnames.txt', SURNAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Cayetano')
// Belizean order is the English one — given name, middle name, surname — and Hispanic families
// often add a second surname: three words are given, middle and surname; four, two of each.
const N = apply('BZ_GIVEN_NAME')
const S = apply('BZ_SURNAME')
decompose('BZ_FULL_NAME', [
  [String.raw`([^,]+),\s*(.+)`, apply('BZ_SURNAMES'), apply('BZ_GIVEN_NAMES')],
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, S],
  // A middle initial stays an initial.
  [String.raw`(\S+)(\s+)([A-Za-z]\.?)(\s+)(\S+)`, N, keep, keep, keep, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, N, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, N, S, S],
], CM, 'Kenrick A. Gillett')

domain('BZ_L1_GIVEN_NAME', 'BZ_GIVEN_NAMES',
  byName(
    [`first_?names?|given_?names?|fore_?names?|christian_?name|fname|name_?first|middle_?names?|mname|name_?middle|nombres?_?(de_?)?pila|primer_?nombre|segundo_?nombre|nombres(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completos?|y_?apellidos?|apellidos?))`, 0.85],
    [`name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))|nombre(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|y_?apellidos?|apellidos?))`, 0.5],
  ),
  byList([['bz-detect-given-names.txt', GIVEN_NAMES, 0.7]], { tokenize: true, reject: 0.3 }))

domain('BZ_L1_SURNAME', 'BZ_SURNAMES',
  byName(['last_?names?|surnames?|family_?names?|lname|name_?last|maiden_?name|mothers?_?maiden_?name|maiden|second_?surname|married_?name|apellidos?|apellido_?(paterno|materno)|primer_?apellido|segundo_?apellido', 0.85]),
  byList([['bz-detect-surnames.txt', SURNAMES, 0.7]], { tokenize: true, reject: 0.3 }))

domain('BZ_L1_FULL_NAME', 'BZ_FULL_NAME',
  byName(
    [`full_?name|fullname|complete_?name|person_?name|name_?of_?(${PERSON_ROLE})|(${PERSON_ROLE})_?name|nombre_?(completo|compl)|nombres?_?y_?apellidos?`, 0.9],
    ['beneficiary|guardian|next_?of_?kin|spouse|emergency_?contact|guarantor|account_?holder|policy_?holder|legal_?representative|attorney|patient|victim|complainant|accused|defendant|insured_?person|titular|beneficiario|conyuge', 0.6],
    // A bare NAME holds a given name or a full name: the values decide between the two domains.
    [`name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))|nombre(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|y_?apellidos?|apellidos?))`, 0.5],
  ),
  byList([['bz-detect-given-names.txt', GIVEN_NAMES, 0.6], ['bz-detect-surnames.txt', SURNAMES, 0.6]], { tokenize: true, reject: 0.3 }))

// ── L1 · Contact ────────────────────────────────────────────────────────────

decompose('BZ_EMAIL', [
  // The top-level domain becomes .test, reserved for tests: a masked address can never deliver.
  [String.raw`([^@\s]+)@([^@\s]+)\.([A-Za-z]{2,24})`, CM, CM, redactAs('test')],
], CM, 'kenrick.gillett@gmail.com')
domain('BZ_L1_EMAIL', 'BZ_EMAIL',
  byName(['e_?mail[a-z0-9_]*|mail[a-z0-9_]*|email_?address|correo(_?electronico)?[a-z0-9_]*', 0.85]),
  byType(STRING(5)),
  byPattern([[String.raw`[A-Za-z0-9._%+'\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}`, 1]], { reject: 0.2 }))

// Seven digits after +501. The first digit is the district of a landline (2 Belize, 3 Orange Walk,
// 4 Corozal, 5 Stann Creek, 7 Toledo, 8 Cayo) or 6 for a mobile: it stays, with +501 and the
// separators; the other six digits are masked.
decompose('BZ_PHONE', [
  [String.raw`(\+?\(?501\)?[\s\-]?)?([2-8])(\d{2})([\s\-]?)(\d{4})`, keep, keep, CM, keep, CM],
], CM, '+501 622-4567')
domain('BZ_L1_PHONE', 'BZ_PHONE',
  byName(['tel|telephone[a-z0-9_]*|tel_?(no|num|number|home|work|mobile|cell)|phone[a-z0-9_]*|ph_?(no|num|number)|mobile[a-z0-9_]*|cell|cell_?(phone|no|number)|cellphone|cellular|contact_?(no|num|number)|fax|whatsapp|telefono[a-z0-9_]*|celular|movil|n(o|um|ro)_?tel(efono)?', 0.85]),
  byPattern([
    [String.raw`(\+?\(?501\)?[\s\-]?)6\d{2}[\s\-]?\d{4}`, 1],
    [String.raw`6\d{2}[\s\-]?\d{4}`, 0.8],
    [String.raw`(\+?\(?501\)?[\s\-]?)?[2-578]\d{2}[\s\-]?\d{4}`, 0.7],
    [String.raw`\+?\d[\d\s()\-]{6,15}`, 0.3],
  ], { reject: 0.3 }))

// Belizean addresses name the house number and street, a mile marker on a highway, or a lot in a
// neighbourhood, and end with the town: there are no postal codes.
const HIGHWAYS = [
  ['Philip Goldson Highway', ['Ladyville', 'Sandhill', 'Orange Walk Town', 'Corozal Town']],
  ['George Price Highway', ['Hattieville', 'Belmopan', 'Roaring Creek', 'San Ignacio', 'Santa Elena']],
  ['Hummingbird Highway', ['Belmopan', 'Dangriga', 'Middlesex']],
  ['Southern Highway', ['Dangriga', 'Independence', 'Punta Gorda', 'Big Falls']],
  ['Burrell Boom Road', ['Burrell Boom', 'Ladyville']],
  ['Coastal Highway', ['Gales Point', 'Dangriga']],
]
const NEIGHBOURHOODS = [
  ['Lake Independence', 'Belize City'], ['Port Loyola', 'Belize City'], ['Collet', 'Belize City'], ['Mesopotamia', 'Belize City'],
  ["Queen's Square", 'Belize City'], ['Pickstock', 'Belize City'], ['Fort George', 'Belize City'], ['Caribbean Shores', 'Belize City'],
  ["King's Park", 'Belize City'], ['Belama Phase 2', 'Belize City'], ['Buttonwood Bay', 'Belize City'], ['Jane Usher Boulevard Area', 'Belize City'],
  ['Yarborough', 'Belize City'], ['Vista del Mar', 'Ladyville'], ['Los Lagos', 'Ladyville'], ['Salvapan', 'Belmopan'],
  ['Las Flores', 'Belmopan'], ['San Martin', 'Belmopan'], ['Maya Mopan', 'Belmopan'], ['Cahal Pech', 'San Ignacio'],
  ['Santa Rita', 'Corozal Town'], ['San Andres Area', 'Corozal Town'], ['Louisiana', 'Orange Walk Town'], ['Santa Ana', 'Orange Walk Town'],
  ['Tubroose', 'Dangriga'], ['Lopez', 'Dangriga'], ['Hopeville', 'Punta Gorda'], ['Boca del Rio', 'San Pedro Town'],
  ['San Mateo', 'San Pedro Town'], ['DFC Area', 'San Pedro Town'],
]
lookup('BZ_ADDRESS', 'bz-addresses.txt', (() => {
  const random = seeded(2021)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const streets = readLines('streets.txt')
  const out = new Set()
  while (out.size < 3000) {
    const r = random()
    const house = 1 + Math.floor(random() * 250)
    if (r < 0.45) out.add(`#${house} ${pick(streets)}`)
    else if (r < 0.65) {
      const [highway, places] = pick(HIGHWAYS)
      out.add(`Mile ${1 + Math.floor(random() * 60)}${random() < 0.3 ? `${'½'}` : ''} ${highway}, ${pick(places)}`)
    } else if (r < 0.85) {
      const [area, town] = pick(NEIGHBOURHOODS)
      out.add(`Lot ${house}, ${area}, ${town}`)
    } else out.add(`${house} ${pick(streets)}, Apt. ${1 + Math.floor(random() * 12)}${'ABCD'[Math.floor(random() * 4)]}`)
  }
  return [...out]
})(), '#24 Cleghorn Street, Belize City', 'PRESERVE_LOOKUP_FILE')
domain('BZ_L1_ADDRESS', 'BZ_ADDRESS',
  byName(['(?<!(mac|ip|e_?mail|web|url)_?)address(?!_?(ip|mac|email|e_?mail|web|url|book|type|id))[a-z0-9_]*|(?<!(mac|ip|e_?mail|web|url)_?)addr(ess)?_?(line|1|2)?[a-z0-9_]*|street(_?(address|name))?|residential_?address|home_?address|mailing_?address|postal_?address|physical_?address|residence|place_?of_?residence|domicile|direccion(?!_?(ip|mac|correo|electronica))[a-z_]*|domicilio[a-z_]*', 0.8]),
  byType(STRING(6)),
  byPattern([
    [String.raw`(?i)#?\s*\d+[A-Z]?\s+.*\b(street|st\.?|avenue|ave\.?|road|rd\.?|drive|dr\.?|lane|boulevard|blvd\.?|highway|hwy)\b.*`, 0.8],
    [String.raw`(?i).*\bmile\s+\d+.*\b(highway|road|hwy)\b.*`, 0.9],
    [String.raw`(?i).*\blot\s*(no\.?\s*|#\s*)?\d+\s*,.+`, 0.6],
  ], { reject: 0.2 }))

domain('BZ_L1_ADDRESS_DETAIL', 'BZ_CM_ALNUM',
  byName(['house_?(no|num|number)|apt(_?(no|number))?|apartment(_?(no|number))?|unit_?(no|num|number)|flat_?(no|number)|lot_?(no|num|number)|floor_?(no|number)?|suite(_?no)?|building_?(no|number)|num_?casa|n(o|um|ro)_?casa|apto', 0.7]))

// ── L1 · Banking ────────────────────────────────────────────────────────────

domain('BZ_L1_BANK_ACCOUNT', 'BZ_CM_ALNUM',
  byName(['account_?(no|num|number|nbr)|acct_?(no|num|number|nbr)?|acc_?(no|num|number)|bank_?(account|acct)(_?(no|num|number))?|savings_?(account|acct)(_?(no|number))?|checking_?(account|acct)(_?(no|number))?|chequing_?(account|acct)(_?(no|number))?|share_?account(_?no)?|iban|cuenta_?(bancaria|ahorros?|corriente)|n(o|um|ro)_?(de_?)?cuenta', 0.85]))

// Payment Card fails a row that has no digits to mask; only values shaped like a card reach it.
algorithm('BZ_CARD_LUHN', 'characterMapping.PaymentCard', { minMaskedPositions: 6, preserve: 0 }, '4916313123456780')
decompose('BZ_CARD', [[String.raw`(\d[\d\s\-]{11,22}\d)`, apply('BZ_CARD_LUHN')]], keep, '4916 3131 2345 6780')
domain('BZ_L1_PAYMENT_CARD', 'BZ_CARD',
  byName(['card_?(no|num|number)|credit_?card(_?(no|num|number))?|debit_?card(_?(no|num|number))?|cc_?(no|num|number)|pan|card_?pan|masked_?pan|tarjeta(_?(credito|debito))?|n(o|um|ro)_?tarjeta', 0.85]),
  // 0.9, not 1: an IMEI is 15 Luhn-valid digits too, and its own column name should win.
  byPattern([[String.raw`\d{13,19}`, 0.9, { checksum: 'LUHN', clean: String.raw`[\s\-]` }]], { reject: 0.3 }))

// ── L1 · Network, devices, vehicles, land ───────────────────────────────────

algorithm('BZ_OCTET', 'characterMapping.NumericMapping', { minValue: 1, maxValue: 254 }, '10')
decompose('BZ_IP', [
  [String.raw`(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})`, apply('BZ_OCTET'), apply('BZ_OCTET'), apply('BZ_OCTET'), apply('BZ_OCTET')],
], apply('BZ_CM_HEX'), '200.32.211.10')
domain('BZ_L1_IP_ADDRESS', 'BZ_IP',
  byName(['ip|ip_?(address|addr|origin|source|destination|client|user|remote|public|private|login)|ipv[46]|remote_?addr(ess)?|client_?ip|host_?ip|source_?ip|direccion_?ip', 0.85]),
  byPattern([
    [String.raw`((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)`, 1],
    [String.raw`[0-9A-Fa-f]{1,4}(:[0-9A-Fa-f]{0,4}){2,7}`, 0.9],
  ], { reject: 0.3 }))

domain('BZ_L1_DEVICE_ID', 'BZ_CM_HEX',
  byName(['imei|imsi|iccid|mac|mac_?address|device_?(id|uuid|serial)|advertising_?id|idfa|gaid|cookie(_?id)?|session_?id|serial_?(no|number)_?(device|phone|handset)|handset_?serial', 0.8]),
  byPattern([
    [String.raw`([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}`, 1],
    [String.raw`\d{15}`, 0.8, { checksum: 'LUHN' }],
  ], { reject: 0.3 }))

// Plates carry a district or town code (BZ, CY, CZL, OW, SC, TOL, BMP, SP…) and a serial number;
// motorcycles, taxis and trucks add a category letter. Codes and letters stay, digits are masked.
const PLATE_CODE = 'BMP|CZL|TOL|BZ|BC|CY|OW|SC|SP|SI|SE|PG|DG'
decompose('BZ_PLATE', [
  [`(${PLATE_CODE})([\\s\\-]?)([A-Z])([\\s\\-]?)(\\d{3,5})`, keep, keep, keep, keep, CM],
  [`(${PLATE_CODE})([\\s\\-]?)(\\d{3,5})`, keep, keep, CM],
  [String.raw`([A-Z])([\s\-]?)(\d{3,5})`, keep, keep, CM],
  [String.raw`(\d{3,5})`, CM],
], CM, 'CY C-12345')
domain('BZ_L1_LICENCE_PLATE', 'BZ_PLATE',
  byName(['licen[cs]e_?plates?(_?(no|num|number))?|plates?(_?(no|num|number))?|vehicle_?(reg|registration|plate|licen[cs]e)(_?(no|num|number))?|registration_?plate|number_?plate|tag_?(no|number)|placas?|matricula', 0.85]),
  byPattern([
    [`(${PLATE_CODE})[\\s\\-]?([A-Z][\\s\\-]?)?\\d{3,5}`, 0.8],
    [String.raw`[A-Z][\s\-]\d{4,5}`, 0.4],
  ], { reject: 0.3 }))

domain('BZ_L1_VIN', 'BZ_CM_ALNUM',
  byName(['vin|vin_?(no|number)|vehicle_?identification_?(no|number)|chassis(_?(no|number))?|engine_?(no|number|serial)|motor_?(no|number)|serial_?(no|number)_?vehicle|n(o|um|ro)_?(de_?)?(serie|chasis|motor)', 0.8]),
  byPattern([[String.raw`[A-HJ-NPR-Z0-9]{17}`, 0.7]], { reject: 0.3 }))

// The Land Registry identifies registered land by registration section, block and parcel: the
// parcel leads to its proprietor. Section names and the words stay; the numbers are masked.
decompose('BZ_PARCEL', [
  [String.raw`(?i)(.*?block\s*(?:no\.?\s*)?)(\d+)(.*?parcel\s*(?:no\.?\s*)?)(\d+)(.*)`, keep, CM, keep, CM, keep],
], CM, 'Caribbean Shores, Block 16, Parcel 1234')
domain('BZ_L1_LAND_PARCEL', 'BZ_PARCEL',
  byName(['parcel(_?(no|num|number|id))?|block_?(and_?)?parcel|land_?(title|parcel|registry|register|certificate|lease)(_?(no|num|number))?|title_?(deed_?)?(no|number)|land_?certificate|lease_?(no|number)|minister_?s_?fiat(_?no)?|fiat_?grant(_?no)?|deed_?(no|number)|cadastr[a-z_]*|finca|folio_?real', 0.85]),
  byPattern([[String.raw`(?i).*block\s*(no\.?\s*)?\d+.*parcel\s*(no\.?\s*)?\d+.*`, 0.9]], { reject: 0.3 }))

domain('BZ_L1_CONTRACT_NUMBER', 'BZ_CM_ALNUM',
  byName(['contract_?(no|num|number)|policy_?(no|num|number)|loan_?(no|num|number|id)|mortgage_?(no|number)|member(ship)?_?(no|num|number|id)|customer_?(no|num|number|id)|client_?(no|num|number|id)|cust_?(no|num|id)|employee_?(no|num|number|id)|emp_?(no|num|id)|staff_?(no|num|number|id)|payroll_?(no|number)|claim_?(no|num|number)|meter_?(no|number)|bel_?account(_?no)?|bws_?account(_?no)?|student_?(no|num|number|id)|n(o|um|ro)_?(de_?)?(contrato|poliza|cliente|empleado)', 0.7]))

domain('BZ_L1_USERNAME', 'BZ_CM_ALNUM',
  byName(['user_?name|username|login(_?(name|id))?|user_?id_?login|nick_?name|nickname|alias|screen_?name|handle|facebook|instagram|twitter|tiktok|linkedin|social_?media(_?(handle|account|profile))?|telegram|usuario', 0.7]))

domain('BZ_L1_CREDENTIAL', 'BZ_REDACT',
  byName(['password|passwd|pwd|pass_?word|pass|pin(_?(code|no|number))?|passcode|hash_?password|password_?hash|secret|secret_?(answer|question)|security_?(answer|question)|access_?token|refresh_?token|api_?key|otp|contrasen[aã]|contraseña|clave(?!_?(producto|prod|articulo|postal))', 0.9]))

decompose('BZ_COORDINATE', [
  // The integer part and first decimal stay (about 11 km): the place is generalized, not moved.
  [String.raw`(-?\d{1,3}\.\d)(\d+)\s*,\s*(-?\d{1,3}\.\d)(\d+)`, keep, CM, keep, CM],
  [String.raw`(-?\d{1,3}\.\d)(\d+)`, keep, CM],
], keep, '17.251234')
domain('BZ_L1_GEOLOCATION', 'BZ_COORDINATE',
  byName(
    ['lat|latitude|lon|lng|longitude|coordinates?|coord_?[xy]|geo_?(lat|lon|lng|loc|location|position)|geolocation|gps(_?(location|position|coordinates))?|latitud|coordenadas?', 0.85],
    ['long|longitud', 0.5],
  ),
  byPattern([
    [String.raw`1[5-8]\.\d{3,}\s*,\s*-8[7-9]\.\d{3,}`, 0.9],
    [String.raw`1[5-8]\.\d{3,}`, 0.5],
    [String.raw`-8[7-9]\.\d{3,}`, 0.7],
  ], { reject: 0.3 }))

// ── L1 · Free text ──────────────────────────────────────────────────────────

algorithm('BZ_FREE_TEXT', 'freeTextRedaction.FreeTextRedaction', {
  regularExpressions: [
    String.raw`(?<![\d\-])\d{3}-\d{3}-\d{3}(?![\d\-])`,
    String.raw`(?<!\d)\d{9}(?!\d)`,
    String.raw`[\w.+\-]+@[\w\-]+(\.[\w\-]+)+`,
    String.raw`(?<![\d\-])(\+?501-?)?[2-8]\d{2}-\d{4}(?![\d\-])`,
    String.raw`(?<!\d)(\+?501)?[2-8]\d{6}(?!\d)`,
    String.raw`(?<!\d)\d{13,19}(?!\d)`,
    `(?<![A-Za-z])(${PLATE_CODE})-?[A-Z]?-?\\d{3,5}(?![A-Za-z\\d])`,
    String.raw`(?<!\d)(\d{1,3}\.){3}\d{1,3}(?!\d)`,
  ].map((patternString) => ({ patternString })),
  regExRedactValue: '[DATA]',
  lookupFile: { uri: file('bz-text-names.txt', unique([...GIVEN_NAMES, ...SURNAMES].flatMap((v) => [v, v.toUpperCase(), fold(v), fold(v).toUpperCase()]))) },
  lookupFileRedactValue: '[NAME]',
  isDenyList: true,
}, 'Customer Gillett, SSN 000123456, email k.gillett@gmail.com, tel 622-4567')

domain('BZ_L1_FREE_TEXT', 'BZ_FREE_TEXT',
  byName(['remarks?|comments?|notes?|observations?|narrative|free_?text|memo|messages?(?!_?(id|type|code|key|no|num|number|date|status|queue|count|log))|complaint(_?(text|details|description))?|description_?(of_?)?(case|complaint|incident|request|issue|problem|events)|incident_?(details|description|narrative)|case_?(notes?|summary|details)|statement|details|summary|observaciones?|comentarios?|notas?', 0.6]),
  byType(STRING(30)),
  byPattern([
    [String.raw`\d{3}-?\d{3}-?\d{3}`, 0.6],
    [String.raw`[\w.+\-]+@[\w\-]+\.[A-Za-z]{2,}`, 0.7],
    [String.raw`(\+?501\s?)?[2-8]\d{2}-\d{4}`, 0.6],
  ], { reject: 0, partial: true }))

// ── L2 · Quasi-identifiers ──────────────────────────────────────────────────

// Small shifts: large enough to break the link to the person, small enough that ages, school years
// and the 16th and 18th birthdays move for few people. Dates that combine with the birth date move less.
algorithm('BZ_BIRTH_DATE', 'dateAlgorithms.DateShift', { minRange: -60, maxRange: 60, unit: 'DAYS', roll: false }, '1985-07-20')
algorithm('BZ_EVENT_DATE', 'dateAlgorithms.DateShift', { minRange: -30, maxRange: 30, unit: 'DAYS', roll: false }, '2021-03-15')

domain('BZ_L2_BIRTH_DATE', 'BZ_BIRTH_DATE',
  byName(['dob|d_?o_?b|date_?of_?birth|birth_?date|birthdate|birthday|born_?(on|date)|bdate|fecha_?(de_?)?nac(imiento)?|fec_?nac(imiento)?|f_?nac(imiento)?|nacimiento', 0.9]),
  byType(...DATES, STRING(6)))

// The decade stays and the unit is masked.
decompose('BZ_YEAR', [[String.raw`(\d{3})(\d)`, keep, CM]], keep, '1985')
domain('BZ_L2_BIRTH_YEAR', 'BZ_YEAR',
  byName(['birth_?year|year_?of_?birth|yob|yr_?of_?birth|an(i)?o_?(de_?)?nac(imiento)?|año_?(de_?)?nac(imiento)?', 0.9]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// 37 becomes 3x. From 100 on, 90.
decompose('BZ_AGE', [
  [String.raw`(\d{3,})`, redactAs('90')],
  [String.raw`([1-9])(\d)(\.\d+)`, keep, CM, keep],
  [String.raw`([1-9])(\d)`, keep, CM],
  [String.raw`(\d)`, CM],
], keep, '37')
domain('BZ_L2_AGE', 'BZ_AGE',
  byName(['age(_?(years|yrs|in_?years|at_?(admission|death|entry|diagnosis|registration)|group|range|band|bracket|last_?birthday))?|years_?old|edad(_?(actual|anos|años))?', 0.85]),
  byType(NUMBER(0, 6), STRING(0, 6)))

domain('BZ_L2_EVENT_DATE', 'BZ_EVENT_DATE',
  byName(['date_?of_?(death|marriage|divorce|hire|hiring|employment|engagement|termination|dismissal|resignation|retirement|admission|discharge|diagnosis|visit|consultation|delivery|arrest|conviction|sentence|sentencing|naturali[sz]ation|injury|surgery)|(death|marriage|divorce|hire|hiring|employment|employment_?start|start_?of_?employment|termination|separation|resignation|retirement|admission|discharge|diagnosis|visit|delivery|arrest|conviction|sentencing|naturali[sz]ation|pension_?start|injury|vaccination|surgery|immigration)_?date|dod|fecha_?(de_?)?(defuncion|fallecimiento|matrimonio|divorcio|ingreso|egreso|contratacion|jubilacion|diagnostico)', 0.8]),
  byType(...DATES, STRING(6)))

// Each vocabulary replaced within itself: M/F stays M/F.
decompose('BZ_SEX', [
  ['(?i)(female|male)', apply(lookup('BZ_SEX_FEMALE_MALE', 'bz-sex-female-male.txt', ['Female', 'Male']))],
  ['(?i)(woman|man)', apply(lookup('BZ_SEX_WOMAN_MAN', 'bz-sex-woman-man.txt', ['Woman', 'Man']))],
  ['(?i)(femenino|masculino)', apply(lookup('BZ_SEX_SPANISH', 'bz-sex-spanish.txt', ['Femenino', 'Masculino']))],
  ['(?i)(mujer|hombre)', apply(lookup('BZ_SEX_MUJER_HOMBRE', 'bz-sex-mujer-hombre.txt', ['Mujer', 'Hombre']))],
  ['(?i)([fm])', apply(lookup('BZ_SEX_F_M', 'bz-sex-f-m.txt', ['F', 'M']))],
  ['(?i)([hm])', apply(lookup('BZ_SEX_H_M', 'bz-sex-h-m.txt', ['H', 'M']))],
], keep, 'F')
domain('BZ_L2_SEX', 'BZ_SEX',
  byName(['sex(_?(code|at_?birth|registered))?|gender(?!_?(identity|expression))(_?code)?|sexo|genero(?!_?(identidad))', 0.85]),
  byList([['bz-detect-sex.txt', ['f', 'm', 'h', 'female', 'male', 'woman', 'man', 'fem', 'mujer', 'hombre', 'femenino', 'masculino'], 0.5]], { reject: 0.5 }))

// ── L2 · Where people live ──────────────────────────────────────────────────
//
// Belize has six districts, a city, a capital, seven towns and some two hundred villages and
// communities (2022 census). The district stays: the smallest, Toledo, has 38,944 people. 208 of the
// 221 places had fewer than 5,000 inhabitants: with a birth date and a sex, one of them points at a
// handful of people. Small ones become the nearest place of the same district with at least 5,000 —
// a real place, nearby, shared by many.

const distance = (a, b) => {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}
const SMALL_PLACE = 5000
const placeTo = new Map(PLACES.map((p) => {
  if (p.population >= SMALL_PLACE) return [p.code, p]
  const candidates = PLACES.filter((x) => x.district === p.district && x.population >= SMALL_PLACE)
  return [p.code, candidates.reduce((best, x) => (distance(p, x) < distance(p, best) ? x : best))]
}))
// Names as they are also written: without "Town", the twin towns apart, the communities the census
// counts inside another one.
const ALIASES = {
  'Belize City': ['Belize'], 'Corozal Town': ['Corozal'], 'Orange Walk Town': ['Orange Walk', 'San Lorenzo'],
  // "San Pedro" is how San Pedro Town is written: the village of the same name in Corozal keeps it too.
  'San Pedro Town': ['San Pedro', 'San Pedro Ambergris Caye', 'Ambergris Caye'],
  'Benque Viejo Del Carmen': ['Benque Viejo del Carmen', 'Benque Viejo', 'Benque'], 'Independence': ['Mango Creek', 'Independence and Mango Creek'],
  'Bullet Tree Falls': ['Bullet Tree', 'Paslow Falls'], 'Armenia': ['Agua Viva'], 'Santa Familia': ['Branch Mouth'], 'Cotton Tree': ['Harmonyville'],
  'Trial Farm': ['Indian Hill Estate'], 'Chan Pine Ridge': ['Richmond Hill'], 'St. Margaret': ['Saint Margaret', 'St Margaret', 'Ringtail Village'],
  'St. Mathews': ['Saint Mathews', 'St Mathews', 'Beaver Dam'], 'Golden Stream': ['Moody Hill'], 'Cattle Landing': ['Wilson Road'], 'Mafredi': ['Crique Trosa'],
  'Trio': ['Swasey'], 'Consejo': ['Finca Solana'], 'El Progresso (7 Miles)': ['El Progresso', 'Seven Miles', '7 Miles'], 'St. Anns': ['Saint Anns', 'St Anns'],
  'St. Pauls Bank': ['Saint Pauls Bank', 'St Pauls Bank'], 'Kendal, Sanctuary Bay': ['Kendal', 'Sanctuary Bay'], 'Long Bank, Melinda Road': ['Long Bank', 'Melinda Road'],
}
const DISTRICT_NAMES = new Set([...DISTRICTS, 'Belize District', 'Cayo District', 'Corozal District', 'Orange Walk District', 'Stann Creek District', 'Toledo District'].map((n) => n.toLowerCase()))
/** Name → generalized name. A name shared by several places is generalized only when all are small. */
const placePairs = (() => {
  const byName = new Map()
  for (const p of PLACES) for (const name of [p.name, ...(ALIASES[p.name] ?? [])]) byName.set(name, [...(byName.get(name) ?? []), p])
  return [...byName.entries()].map(([name, all]) => {
    if (all.some((p) => p.population >= SMALL_PLACE)) return [name, name]
    return [name, placeTo.get(all.reduce((a, b) => (b.population > a.population ? b : a)).code).name]
  })
})()
const variants = (pairs) => unique(pairs.flatMap(([from, to]) => [
  `${from}|${to}`, `${fold(from)}|${to}`, `${from.toUpperCase()}|${to.toUpperCase()}`, `${fold(from).toUpperCase()}|${fold(to).toUpperCase()}`,
])).map((line) => line.split('|'))
const PERSONAL_WORDS = new Set([...GIVEN_NAMES, ...SURNAMES].map((w) => fold(w).toLowerCase()))

cleansing('BZ_TOWN_VILLAGE', 'bz-town-village-generalized.txt', variants(placePairs), 'Crooked Tree', '|')
domain('BZ_L2_TOWN_VILLAGE', 'BZ_TOWN_VILLAGE',
  byName(
    ['town|village|town_?(or_?)?village|city_?(town_?)?village|ctv|community(?!_?(service|group|organi[sz]ation|work))|locality|settlement|home_?town|hometown|place_?of_?birth|birth_?place|birthplace|place_?of_?residence_?(town|village)|residence_?(town|village|community)|town_?of_?residence|village_?of_?residence|aldea|comunidad|localidad|lugar_?(de_?)?nacimiento', 0.85],
    ['city|ciudad|municipality|pueblo', 0.5],
  ),
  byList([['bz-detect-towns-villages.txt', placePairs.map(([name]) => name).filter((n) => !PERSONAL_WORDS.has(fold(n).toLowerCase()) && !DISTRICT_NAMES.has(n.toLowerCase())), 0.8]], { reject: 0.4 }))

// Neighbourhoods and registration sections within a town are replaced by a common one: a place
// still, no longer theirs.
lookup('BZ_NEIGHBOURHOOD', 'bz-neighbourhoods.txt', NEIGHBOURHOODS.map(([area]) => area), "King's Park", 'PRESERVE_LOOKUP_FILE')
domain('BZ_L2_NEIGHBOURHOOD', 'BZ_NEIGHBOURHOOD',
  byName(['neighbou?rhood|subdivision|barrio|colonia|residential_?area|area_?of_?residence|housing_?(area|scheme|estate)|registration_?section|reg_?section|urbanizacion|sector_?residencial', 0.85]))

// Birth countries of the 2022 census: Guatemala, El Salvador, Honduras, the United States and
// Mexico first.
const NATIONALITIES = ['Belizean', 'Guatemalan', 'Salvadoran', 'Honduran', 'Mexican', 'American', 'Canadian', 'Chinese', 'Taiwanese', 'Indian', 'Nicaraguan', 'Jamaican', 'British', 'Cuban', 'Filipino', 'Nigerian']
lookup('BZ_NATIONALITY', 'bz-nationalities.txt', NATIONALITIES, 'Guatemalan')
domain('BZ_L2_NATIONALITY', 'BZ_NATIONALITY',
  byName(['nationality|citizenship|country_?of_?(birth|origin|citizenship|nationality)|birth_?country|nacionalidad|pais_?(de_?)?(nacimiento|origen)|ciudadania', 0.8]),
  byList([['bz-detect-nationalities.txt', [...NATIONALITIES, 'belize', 'guatemala', 'el salvador', 'salvadorian', 'honduras', 'mexico', 'united states', 'usa', 'us', 'canada', 'china', 'taiwan', 'india', 'nicaragua', 'jamaica', 'united kingdom', 'uk', 'cuba', 'philippines', 'nigeria', 'beliceña', 'beliceño', 'guatemalteca', 'guatemalteco', 'salvadoreña', 'salvadoreño', 'hondureña', 'hondureño', 'mexicana', 'mexicano'], 0.7]], { reject: 0.4 }))

// Marital and union status as the 2022 census asks for them.
const MARITAL = ['Never married', 'Married', 'Common-law union', 'Visiting partner', 'Divorced', 'Widowed', 'Legally separated']
lookup('BZ_MARITAL_STATUS', 'bz-marital-status.txt', MARITAL, 'Common-law union')
domain('BZ_L2_MARITAL_STATUS', 'BZ_MARITAL_STATUS',
  byName(['marital_?status|civil_?status|union_?status|marriage_?status|relationship_?status|estado_?civil|edo_?civil', 0.85]),
  byList([['bz-detect-marital-status.txt', [...MARITAL, 'single', 'married', 'common law', 'common-law', 'divorced', 'widow', 'widower', 'widowed', 'separated', 'soltero', 'soltera', 'casado', 'casada', 'unión libre', 'divorciado', 'viudo', 'viuda'], 0.7]], { reject: 0.4 }))

lookup('BZ_OCCUPATION', 'bz-occupations.txt', ['Clerk', 'Sales clerk', 'Shop assistant', 'Construction worker', 'Heavy equipment operator', 'Driver', 'Teacher', 'Nurse', 'General practitioner', 'Accountant', 'Engineer', 'Attorney', 'Maintenance technician', 'Cashier', 'Waiter', 'Cook', 'Security guard', 'Mason', 'Electrician', 'Plumber', 'Mechanic', 'Farmer', 'Farm labourer', 'Cane cutter', 'Fisherman', 'Tour guide', 'Housekeeper', 'Student', 'Retired', 'Self-employed', 'Programmer', 'Graphic designer', 'Receptionist', 'Janitor', 'Supervisor', 'Area manager', 'Sales representative', 'Storekeeper', 'Delivery driver', 'Unemployed'], 'Regional Operations Manager, Toledo')
domain('BZ_L2_OCCUPATION', 'BZ_OCCUPATION',
  byName(
    ['occupation|profession|job_?title|designation|job_?description_?title|post_?title|position_?title|ocupaci[oó]n|profesi[oó]n|puesto', 0.8],
    ['job|position|post|trade(?!_?(name|mark|licen[cs]e))|cargo(?!_?(fijo|monto|valor))', 0.5],
  ))

lookup('BZ_EMPLOYER', 'bz-employers.txt', ['Caribbean Trading Company Ltd.', 'Cayo Valley Services Ltd.', 'Northern Construction Ltd.', 'Coastal Transport Ltd.', 'Orange Walk Agro Industries Ltd.', 'Southern Distributors Ltd.', 'Barrier Reef Hotels Ltd.', 'Mahogany Medical Centre Ltd.', 'Pine Ridge Academy Ltd.', 'Maya Mountain Consultants Ltd.', 'Hummingbird Quarry Ltd.', 'Placencia Fisheries Ltd.', 'Jaguar Technologies Ltd.', 'Sunrise Supermarkets Ltd.', 'Builders Hardware Ltd.', 'Commerce Free Zone Logistics Ltd.', 'Clean Sweep Services Ltd.', 'Cross Roads Laboratories Ltd.', 'Corozal Import Export Ltd.', 'Valley Auto Parts Ltd.', 'Helping Hands Foundation', 'Village Council of New Haven', 'Sentinel Security Services Ltd.', 'Rainforest Furniture Ltd.', 'Hearth and Grill Restaurants Ltd.'], 'Belize Electricity Limited')
domain('BZ_L2_EMPLOYER', 'BZ_EMPLOYER',
  byName(['employer(_?name)?|name_?of_?employer|employer_?business_?name|company_?of_?employment|workplace|work_?place|place_?of_?(work|employment)|employed_?(at|by|with)|current_?employer|patrono|empleador|lugar_?(de_?)?trabajo', 0.8]))

// Levels of the Belizean system: primary to Standard 6, secondary to Form 4, sixth form, tertiary.
const EDUCATION = ['None', 'Preschool', 'Primary incomplete', 'Primary (Standard 6)', 'Secondary incomplete', 'Secondary (Form 4)', 'Sixth form / junior college', 'Vocational', 'Associate degree', "Bachelor's degree", "Master's degree", 'Doctorate']
lookup('BZ_EDUCATION', 'bz-education.txt', EDUCATION, 'Secondary (Form 4)')
domain('BZ_L2_EDUCATION', 'BZ_EDUCATION',
  byName(['education(_?(level|attainment|status|completed))?|educational_?(level|attainment)|highest_?(level_?(of_?)?)?(education|qualification|grade)|level_?of_?education|qualification|schooling|grade_?completed|escolaridad|nivel_?(educativo|de_?estudios)', 0.8]),
  byList([['bz-detect-education.txt', [...EDUCATION, 'primary', 'secondary', 'high school', 'sixth form', 'junior college', 'tertiary', 'university', 'college', 'associate', 'bachelor', 'bachelors', 'masters', 'phd', 'none', 'primaria', 'secundaria', 'universidad'], 0.6]], { reject: 0.4 }))

lookup('BZ_SCHOOL', 'bz-schools.txt', ['Ebenezer Methodist Primary School', 'St. Joseph Anglican Primary School', 'Sacred Heart RC Primary School', 'Holy Family Primary School', 'Mount Carmel Government School', 'Valley View Community High School', 'Northern Coastal High School', 'Southern Plains Technical High School', 'Riverside Institute of Technology', 'Central Belize Sixth Form', 'Maya Mountain Junior College', 'Caribbean Coast Adventist Academy', 'Seaside Christian High School', 'Pine Ridge Vocational Centre', 'Mahogany Hill University College'], 'St. John\'s College')
domain('BZ_L2_SCHOOL', 'BZ_SCHOOL',
  byName(['school(_?name)?|name_?of_?school|high_?school|primary_?school|secondary_?school|sixth_?form|junior_?college|college(_?name)?|university(_?name)?|institution_?attended|alma_?mater|escuela|colegio|universidad', 0.75]))

// Capped at 5 as text: large households are rare, and a rare count identifies.
decompose('BZ_CAPPED_COUNT', [[String.raw`([0-5])`, keep], [String.raw`(\d+)`, redactAs('5')]], keep, '9')
domain('BZ_L2_DEPENDANTS', 'BZ_CAPPED_COUNT',
  byName(['dependants?|dependents?|no_?of_?(children|dependants|dependents|kids)|num(ber)?_?(of_?)?(children|dependants|dependents|kids)|children|household_?(size|members)|persons_?in_?household|hijos|n(o|um|ro)_?hijos|dependientes', 0.8]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// ── L3 · Sensitive personal data (section 2) ────────────────────────────────

// Ethnic groups of the 2022 census, the three Maya peoples apart.
const ETHNIC = ['Mestizo/Hispanic/Latino', 'Creole', 'Maya Ketchi', 'Maya Mopan', 'Maya Yucatec', 'Garifuna', 'East Indian', 'Mennonite', 'Chinese', 'Caucasian/White', 'African', 'Asian', 'Other', 'Not stated']
categorical('BZ_ETHNICITY', 'bz-ethnic-groups.txt', ETHNIC, 'Garinagu')
domain('BZ_L3_ETHNICITY', 'BZ_ETHNICITY',
  byName(['ethnic(ity|_?group|_?origin|_?background|_?identity)?|race|racial_?(origin|group|background)|indigenous(_?(status|group|people|peoples))?|is_?indigenous|maya_?(group|people)|etnia|grupo_?etnico|origen_?etnico|raza', 0.9]),
  byList([['bz-detect-ethnic-groups.txt', [...ETHNIC, 'mestizo', 'hispanic', 'latino', 'creole', 'kriol', 'maya', 'mayan', "q'eqchi'", 'qeqchi', 'kekchi', 'ketchi', 'mopan', 'yucatec', 'garifuna', 'garinagu', 'east indian', 'mennonite', 'chinese', 'white', 'caucasian', 'black', 'african', 'asian', 'indian', 'mixed', 'other', 'not stated', 'indígena'], 0.9],
    // Self-identification is often a yes/no flag: it backs up the column name but decides nothing alone.
    ['bz-detect-flag.txt', ['y', 'n', 'yes', 'no', 's', 'sí', '0', '1'], 0.3],
  ], { reject: 0.4 }))

// Languages of the 2022 census. Q'eqchi', Mopan, Yucatec and Garifuna point at an indigenous people,
// German (Plautdietsch) at the Mennonite communities.
const LANGUAGES = ['English', 'Spanish', 'Kriol', "Maya Q'eqchi'", 'Maya Mopan', 'Maya Yucatec', 'Garifuna', 'German (Plautdietsch)', 'Chinese', 'Hindi', 'Other']
categorical('BZ_LANGUAGE', 'bz-languages.txt', LANGUAGES, 'Garifuna')
domain('BZ_L3_LANGUAGE', 'BZ_LANGUAGE',
  byName(
    ['mother_?tongue|first_?language|native_?language|home_?language|language_?(spoken|at_?home|spoken_?at_?home|first|native|mother)|languages_?spoken|primary_?language|lengua(_?materna)?|idioma_?(materno|nativo)', 0.9],
    ['language|idioma', 0.55],
  ),
  byList([['bz-detect-languages.txt', [...LANGUAGES, 'kriol', 'creole', "q'eqchi'", 'qeqchi', 'kekchi', 'ketchi', 'mopan', 'yucatec', 'maya', 'garifuna', 'german', 'plautdietsch', 'low german', 'mandarin', 'cantonese', 'hindi', 'español', 'inglés'], 0.8]], { reject: 0.4 }))

// Religions of the 2022 census and of the 2010 detail.
const RELIGIONS = ['Roman Catholic', 'Pentecostal', 'Seventh-day Adventist', 'Anglican', 'Mennonite', 'Baptist', 'Methodist', 'Nazarene', "Jehovah's Witness", 'Evangelical', 'Church of God', 'Latter-day Saints', 'Hindu', 'Muslim', "Bahá'í", 'Buddhist', 'Rastafarian', 'Other', 'None']
categorical('BZ_RELIGION', 'bz-religions.txt', RELIGIONS, 'Salvation Army')
domain('BZ_L3_RELIGION', 'BZ_RELIGION',
  byName(['religion[a-z_]*|religious_?(affiliation|denomination|belief|beliefs|preference|group)|denomination|faith|church(_?(name|affiliation|member|membership|attended))?|creed|congregation|religi[oó]n|credo|iglesia', 0.95]),
  byList([['bz-detect-religions.txt', [...RELIGIONS, 'catholic', 'rc', 'pentecostal', 'adventist', 'sda', 'anglican', 'mennonite', 'baptist', 'methodist', 'nazarene', 'jehovah witness', 'evangelical', 'church of god', 'mormon', 'lds', 'hindu', 'muslim', 'islam', 'bahai', 'buddhist', 'rastafari', 'christian', 'protestant', 'salvation army', 'none', 'no religion', 'atheist', 'agnostic', 'católica'], 0.9]], { reject: 0.4 }))

// "Religious beliefs or other beliefs of a similar nature": no shared vocabulary, so suppressed.
domain('BZ_L3_BELIEF', 'BZ_SUPPRESSED_CATEGORY',
  byName(['beliefs?|philosophical_?(beliefs?|convictions?)|conscientious_?objection|conscientious_?objector|moral_?(beliefs?|convictions?)|personal_?convictions?|worldview|creencias?_?(filosoficas?|morales?|personales)|convicci[oó]n(es)?|objecion_?(de_?)?conciencia', 0.9]))

const IDEOLOGIES = ['Left', 'Centre-left', 'Centre', 'Centre-right', 'Right', 'No preference', 'Prefers not to say']
categorical('BZ_POLITICAL_OPINION', 'bz-political-opinions.txt', IDEOLOGIES, 'Centre-right')
domain('BZ_L3_POLITICAL_OPINION', 'BZ_POLITICAL_OPINION',
  byName(['political_?(opinion|opinions|view|views|orientation|leaning|leanings|preference|ideology)|ideology|voting_?intention|vote_?intention|intended_?vote|party_?preference|preferred_?party|swing_?voter|opini[oó]n_?pol[ií]tica|ideolog[ií]a|intencion_?(de_?)?voto', 0.9]),
  byList([['bz-detect-political-opinions.txt', [...IDEOLOGIES, 'left wing', 'right wing', 'centre left', 'center left', 'centre right', 'center right', 'center', 'liberal', 'conservative', 'progressive', 'undecided', 'swing'], 0.7]], { reject: 0.4 }))

// "Membership of a political body": the parties of the 2025 general election.
const PARTIES = ["People's United Party", 'United Democratic Party', 'Belize Progressive Party', 'Belize Justice Movement', "People's Democratic Movement", "People's National Party", 'Independent', 'No party']
categorical('BZ_POLITICAL_PARTY', 'bz-political-parties.txt', PARTIES, 'Vision Inspired by the People')
domain('BZ_L3_POLITICAL_MEMBERSHIP', 'BZ_POLITICAL_PARTY',
  byName(
    ['political_?(party|body|membership|affiliation|group)|party_?(membership|member|affiliation|card|branch|division|supporter)|member_?of_?(party|political_?(party|body))|partido(_?pol[ií]tico)?|afiliaci[oó]n_?pol[ií]tica|militancia|militante', 0.95],
    ['party(?!_?(id|key|type|role|site|ref|code|number|no|size))', 0.5],
  ),
  byList([['bz-detect-political-parties.txt', [...PARTIES, 'PUP', 'UDP', 'BPP', 'BJM', 'PDM', 'PNP', 'VIP', 'Vision Inspired by the People', 'Belize Peoples Front', 'independent', 'none', 'no party', 'blue', 'red'], 0.8]], { reject: 0.4 }))

domain('BZ_L3_TRADE_UNION', 'BZ_SUPPRESSED_CATEGORY',
  byName(['trade_?union(_?(member|membership|name|dues))?|union_?(member|membership|affiliation|name|dues|fees|code|branch|local|representative)|unioni[sz]ed|labou?r_?union|bargaining_?unit|collective_?(agreement|bargaining)|staff_?association|sindicato[a-z_]*|sindical(izado)?|afiliaci[oó]n_?sindical|cuota_?sindical', 0.95]),
  byList([['bz-detect-trade-unions.txt', ['BNTU', 'PSU', 'NTUCB', 'CWU', 'BWU', 'BEWU', 'BCWU', 'BWSWU', 'KHMHAWU', 'SWU', 'APSSM', 'UBFSU', 'Belize National Teachers Union', 'Public Service Union', 'Christian Workers Union', 'Belize Workers Union', 'Belize Energy Workers Union', 'Belize Communication Workers Union', 'Belize Water Services Workers Union', 'Southern Workers Union', 'Association of Public Service Senior Managers', 'unionized', 'union member'], 0.6]], { reject: 0.3 }))

domain('BZ_L3_GENETIC', 'BZ_REDACT',
  byName(['dna|genetic[a-z_]*|genome|genotyp[a-z_]*|gene_?(test|result|marker|panel)|genetic_?(test|marker|profile|result)|mutation|brca[12]?|karyotype|paternity_?test|snp|haplotype|newborn_?screening|adn|gen[eé]tic[oa]', 0.9]))

domain('BZ_L3_BIOMETRIC', 'BZ_REDACT',
  byName(['fingerprints?|finger_?prints?|thumb_?prints?|biometric[a-z_]*|face_?(template|encoding|id|print|hash)|facial_?(template|recognition|id|image_?hash)|iris(_?(scan|template|code))?|retina(_?scan)?|voice_?(print|template)|palm_?print|signature_?(image|biometric|capture|pad)|minutiae|huellas?(_?dactilar(es)?)?|biometri[a-z_]*', 0.9]),
  byType(STRING()))

const ORIENTATIONS = ['Heterosexual', 'Gay', 'Lesbian', 'Bisexual', 'Pansexual', 'Asexual', 'Other', 'Prefers not to say']
categorical('BZ_SEXUAL_ORIENTATION', 'bz-sexual-orientations.txt', ORIENTATIONS, 'Bisexual')
domain('BZ_L3_SEXUAL_ORIENTATION', 'BZ_SEXUAL_ORIENTATION',
  byName(['sexual_?(orientation|preference)|orientation_?sexual|orient_?sexual|orientaci[oó]n_?sexual|preferencia_?sexual', 0.95]),
  byList([['bz-detect-sexual-orientations.txt', [...ORIENTATIONS, 'straight', 'homosexual', 'queer', 'lgbt', 'lgbtq', 'lgbtqi+', 'prefer not to say'], 0.8]], { reject: 0.4 }))

domain('BZ_L3_SEXUAL_LIFE', 'BZ_SUPPRESSED_CATEGORY',
  byName(['sex(ual)?_?life|sexual_?(activity|behavio(u)?r|history|partners?|practices?)|sexually_?active|number_?of_?sexual_?partners|age_?(at_?)?first_?(sex|intercourse)|vida_?sexual|conducta_?sexual|actividad_?sexual', 0.9]))

// Not named in section 2; treated as sensitive because it exposes people to the same discrimination.
const IDENTITIES = ['Woman', 'Man', 'Trans woman', 'Trans man', 'Non-binary', 'Gender fluid', 'Other', 'Prefers not to say']
categorical('BZ_GENDER_IDENTITY', 'bz-gender-identities.txt', IDENTITIES, 'Trans man')
domain('BZ_L3_GENDER_IDENTITY', 'BZ_GENDER_IDENTITY',
  byName(['gender_?(identity|expression)|preferred_?pronouns?|pronouns?|transgender|trans_?status|identidad_?(de_?)?g[eé]nero|g[eé]nero_?autopercibido', 0.95]),
  byList([['bz-detect-gender-identities.txt', [...IDENTITIES, 'cisgender', 'transgender', 'trans', 'nonbinary', 'female', 'male'], 0.7]], { reject: 0.4 }))

// ── HEALTH · Health records ─────────────────────────────────────────────────

domain('BZ_HEALTH_ID', 'BZ_CM_ALNUM',
  byName(
    ['bhis(_?(no|num|number|id|card))?|nhi(_?(no|num|number|id|card|member_?(no|id)))?|medical_?record(_?(no|num|number))?|mrn|patient_?(id|no|num|number)|chart_?(no|num|number)|health_?(record|card|id)(_?(no|num|number))?|hospital_?(no|num|number)|admission_?(no|num|number)|prescription_?(no|num|number)|sick_?(note|leave|certificate)_?(no|num|number)|medical_?certificate_?(no|num|number)|expediente_?cl[ií]nico|historia_?cl[ií]nica', 0.85],
    ['chart|admission|episode', 0.55],
  ))

const ICD10 = ['I10', 'E11', 'E78', 'J45', 'J06', 'J02', 'J20', 'K29', 'K21', 'K59', 'M54', 'M17', 'M25', 'N39', 'N20', 'R51', 'R10', 'H10', 'H66', 'L23', 'L30', 'B34', 'A09', 'E03', 'E66', 'D50', 'I83', 'K80', 'K40', 'S93', 'S60', 'Z00', 'J30', 'J32', 'G43', 'M79', 'R05']
const ICD10_DECIMAL = ['E11.9', 'E78.5', 'J45.9', 'J06.9', 'J02.9', 'J20.9', 'K29.7', 'K21.9', 'K59.0', 'M54.5', 'M17.9', 'N39.0', 'N20.0', 'R10.4', 'H10.9', 'H66.9', 'L23.9', 'L30.9', 'B34.9', 'A09.9', 'E03.9', 'E66.9', 'D50.9', 'I83.9', 'K80.2', 'K40.9', 'S93.4', 'S60.0', 'Z00.0', 'J30.4', 'J32.9', 'G43.9', 'M79.1']
decompose('BZ_DIAGNOSIS', [
  [String.raw`([A-TV-Za-tv-z]\d{2}\.\d{1,2})`, apply(lookup('BZ_ICD10_DECIMAL', 'bz-icd10-decimal.txt', ICD10_DECIMAL, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [String.raw`([A-TV-Za-tv-z]\d{2,3})`, apply(lookup('BZ_ICD10', 'bz-icd10.txt', ICD10, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [FLAG, apply('BZ_FLAG')],
], apply(lookup('BZ_DIAGNOSIS_TEXT', 'bz-diagnoses.txt', ['Essential hypertension', 'Type 2 diabetes mellitus', 'Asthma', 'Low back pain', 'Chronic gastritis', 'Acute nasopharyngitis', 'Urinary tract infection', 'Migraine', 'Hypothyroidism', 'Dyslipidaemia', 'Obesity', 'Osteoarthritis of the knee', 'Acute bronchitis', 'Acute tonsillitis', 'Contact dermatitis', 'Acute otitis media', 'Ankle sprain', 'Conjunctivitis', 'Iron deficiency anaemia', 'Gastro-oesophageal reflux disease', 'Irritable bowel syndrome', 'Tendinitis', 'Acute sinusitis', 'Tension headache', 'Varicose veins', 'Inguinal hernia', 'Kidney stones', 'Gallstones', 'Acute gastroenteritis', 'Routine child health check'])), 'F32.9')
domain('BZ_HEALTH_DIAGNOSIS', 'BZ_DIAGNOSIS',
  byName(['diagnos(is|es|tic)[a-z_]*|dx|icd_?(10|11)?(_?code)?|medical_?(condition|history|problem|diagnosis)|health_?(condition|problem)|chronic_?(condition|disease|illness)|illness(es)?|disease[a-z_]*|comorbidit(y|ies)|allerg(y|ies)|cause_?of_?(death|admission|illness|injury|sick_?leave)|reason_?for_?(visit|admission|consultation|sick_?leave)|presenting_?complaint|chief_?complaint|pre_?existing_?conditions?|diagn[oó]stico[a-z_]*|cie_?10|enfermedad(es)?', 0.85]),
  // 0.5: codes shaped like ICD-10 appear in other catalogs too; the name has to agree.
  byPattern([[String.raw`[A-TV-Za-tv-z]\d{2}(\.\d{1,2}|\d)?`, 0.5]], { reject: 0.3 }))

const MEDICATIONS = ['Paracetamol', 'Ibuprofen', 'Naproxen', 'Diclofenac', 'Metformin', 'Glibenclamide', 'Losartan', 'Enalapril', 'Amlodipine', 'Atorvastatin', 'Omeprazole', 'Levothyroxine', 'Amoxicillin', 'Ciprofloxacin', 'Salbutamol', 'Loratadine', 'Chlorphenamine', 'Aspirin', 'Prednisone', 'Hydrochlorothiazide', 'Simvastatin', 'Ferrous sulphate', 'Folic acid', 'Cetirizine', 'Azithromycin', 'Multivitamin']
categorical('BZ_MEDICATION', 'bz-medications.txt', MEDICATIONS, 'Sertraline 50 mg')
domain('BZ_HEALTH_MEDICATION', 'BZ_MEDICATION',
  byName(['medications?|medicines?|drugs?_?(name|prescribed)|prescribed_?(drugs?|medications?)|prescription_?(drug|medication|item)s?|active_?ingredient|dosage|treatment_?(drug|medication)|medicamentos?|f[aá]rmacos?|receta', 0.85]),
  byList([['bz-detect-medications.txt', [...MEDICATIONS, 'acetaminophen', 'sertraline', 'fluoxetine', 'escitalopram', 'quetiapine', 'clonazepam', 'alprazolam', 'diazepam', 'lithium', 'methylphenidate', 'risperidone', 'olanzapine', 'haloperidol', 'tenofovir', 'emtricitabine', 'efavirenz', 'dolutegravir', 'insulin', 'warfarin', 'levetiracetam', 'valproic acid', 'naltrexone', 'misoprostol', 'levonorgestrel', 'depo-provera'], 0.7]], { reject: 0.3 }))

domain('BZ_HEALTH_CLINICAL_TEXT', 'BZ_FREE_TEXT',
  byName(['clinical_?notes?|progress_?notes?|nurs(e|ing)_?notes?|doctors?_?notes?|physician_?notes?|medical_?notes?|discharge_?(summary|notes?)|clinical_?summary|history_?of_?present(ing)?_?illness|hpi|physical_?exam(ination)?|assessment_?(and_?)?plan|treatment_?plan|care_?plan|triage_?notes?|soap_?notes?|anamnesis|evoluci[oó]n(_?m[eé]dica)?|nota_?m[eé]dica|epicrisis', 0.85]),
  byType(STRING(30)))

domain('BZ_HEALTH_TEST_RESULT', 'BZ_CM_ALNUM',
  byName(
    ['lab_?(result|test|value)s?|test_?results?|laboratory_?(result|test)s?|hiv(_?(status|test|result))?|viral_?load|cd4(_?count)?|blood_?(sugar|glucose|pressure)|glucose|hba1c|cholesterol|bmi|pregnancy_?test|drug_?(test|screen)|covid_?(test|result)|pcr_?result|pap_?(smear|test)(_?result)?|mammogram_?result|x_?ray_?result|resultado_?(examen|laboratorio|prueba)', 0.8],
    ['result|test', 0.5],
  ))

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']
lookup('BZ_BLOOD_GROUP', 'bz-blood-groups.txt', BLOOD_GROUPS, 'O+', 'PRESERVE_LOOKUP_FILE')
domain('BZ_HEALTH_BLOOD_GROUP', 'BZ_BLOOD_GROUP',
  byName(['blood_?(type|group)|abo(_?rh)?|rh_?factor|rh|grupo_?sangu[ií]neo|tipo_?(de_?)?sangre', 0.9]),
  byList([['bz-detect-blood-groups.txt', [...BLOOD_GROUPS, '0+', '0-', 'a pos', 'a neg', 'b pos', 'b neg', 'ab pos', 'ab neg', 'o pos', 'o neg', 'a positive', 'a negative', 'b positive', 'b negative', 'ab positive', 'ab negative', 'o positive', 'o negative'], 0.9]], { reject: 0.4 }))

// The functional domains the 2022 census asks about.
const DISABILITIES = ['Seeing', 'Hearing', 'Walking or climbing steps', 'Remembering or concentrating', 'Self-care', 'Communicating', 'Multiple', 'None']
categorical('BZ_DISABILITY', 'bz-disabilities.txt', DISABILITIES, 'Severe psychosocial disability')
domain('BZ_HEALTH_DISABILITY', 'BZ_DISABILITY',
  byName(['disabilit(y|ies)[a-z_]*|disabled|impairments?|handicap(ped)?|special_?needs|functional_?limitations?|difficulty_?(seeing|hearing|walking|remembering|concentrating|self_?care|communicating)|invalidity(_?(status|grade))?|discapacidad[a-z_]*', 0.9]),
  byList([['bz-detect-disabilities.txt', [...DISABILITIES, 'visual', 'blind', 'deaf', 'hearing impaired', 'physical', 'mobility', 'intellectual', 'mental', 'psychosocial', 'learning', 'autism', 'multiple', 'none', 'no disability'], 0.6]], { reject: 0.3 }))

// Reproductive and mental health: the values have no shared vocabulary, so they are suppressed
// (flags and numeric codes keep their shape).
domain('BZ_HEALTH_REPRODUCTIVE', 'BZ_SUPPRESSED_CATEGORY',
  byName(['pregnan(t|cy)[a-z_]*|gestation(al)?(_?age)?|weeks_?(of_?)?(pregnancy|gestation)|lmp|last_?menstrual_?period|abortions?|miscarriages?|contracepti(on|ve)[a-z_]*|family_?planning(_?method)?|fertility|infertility|ivf|gravida|antenatal|prenatal|postnatal|postpartum|sti|sexually_?transmitted(_?infection)?|embarazo|aborto|anticonceptivos?|planificaci[oó]n_?familiar', 0.9]))

domain('BZ_HEALTH_MENTAL', 'BZ_SUPPRESSED_CATEGORY',
  byName(['mental_?(health|illness|disorder|condition)|psychiatr[a-z_]*|psycholog[a-z_]*|depression|anxiety|suicid[a-z_]*|self_?harm|substance_?(use|abuse|misuse)|alcohol(ism|_?use|_?abuse|_?dependence)|drug_?(use|abuse|addiction|dependence)|addiction[a-z_]*|rehab(ilitation)?_?(programme|program|centre|center|status)|salud_?mental|trastorno[a-z_]*|adicci[oó]n(es)?', 0.9]))

// ── FIN · Financial record or position (s. 2 (i), sensitive) ─────────────────

decompose('BZ_CREDIT', [
  // A three-digit score gets other digits; flags stay flags.
  [String.raw`(\d{2,3})`, CM],
  [FLAG, apply('BZ_FLAG')],
], apply(lookup('BZ_CREDIT_STATUS', 'bz-credit-statuses.txt', ['Current', '30 days past due', '60 days past due', '90 days past due', '120 days past due', 'Over 120 days past due', 'In collections', 'Written off', 'Restructured', 'No credit history'])), '90 days past due')
domain('BZ_FIN_CREDIT_REFERENCE', 'BZ_CREDIT',
  byName(['credit_?(score|rating|history|report|status|bureau|reference|risk|grade|standing)|crif(_?(score|report|status))?|delinquen(cy|t)(_?(status|days))?|days_?(past_?due|in_?arrears|overdue)|dpd|arrears(_?(status|days))?|past_?due(_?(days|status))?|overdue_?(days|status)|default_?(status|flag|indicator)|defaulted|written_?off|write_?off(_?(status|flag))?|collections?_?status|bad_?debt|loan_?(status|classification|grade)|non_?performing|npl|morosidad|score_?credit[oa]', 0.9]))

algorithm('BZ_DEBT_AMOUNT', 'characterMapping.NumericMapping', { minValue: 200, maxValue: 1000000 }, '8500')
domain('BZ_FIN_DEBT', 'BZ_DEBT_AMOUNT',
  byName(['loan_?(amount|balance|principal|outstanding)|outstanding_?(balance|amount|debt|loan|principal)|debt(_?(amount|total|balance))?|amount_?(owed|due|outstanding|in_?arrears|overdue)|balance_?(owed|outstanding|due)|arrears_?amount|credit_?limit|mortgage_?(balance|amount)|instal?lment(_?amount)?|monthly_?(payment|repayment)|saldo_?(deudor|prestamo|pr[eé]stamo)|monto_?(deuda|prestamo)|deuda', 0.85]),
  byType(NUMBER()))

algorithm('BZ_INCOME', 'characterMapping.NumericMapping', { minValue: 700, maxValue: 40000 }, '2400')
domain('BZ_FIN_INCOME', 'BZ_INCOME',
  byName(['salary|salaries|wages?|income[a-z_]*|gross_?(pay|salary|income|earnings)|net_?(pay|salary|income|earnings)|(monthly|annual|weekly|fortnightly)_?(income|salary|earnings|pay|wage)|earnings|remuneration|basic_?(pay|salary)|insurable_?earnings|household_?income|take_?home_?pay|salario|sueldo|ingresos?(_?[a-z]+)?', 0.85]),
  byType(NUMBER()))

algorithm('BZ_ASSETS', 'characterMapping.NumericMapping', { minValue: 20000, maxValue: 5000000 }, '185000')
domain('BZ_FIN_ASSETS', 'BZ_ASSETS',
  byName(['net_?worth|assets?_?(value|total)|total_?assets|property_?value|land_?value|market_?value|appraised_?value|valuation_?amount|savings(_?balance)?|account_?balance|deposit_?balance|fixed_?deposit(_?amount)?|investment_?(balance|value|amount)|share_?(balance|capital)|patrimonio|valor_?(catastral|propiedad|comercial)', 0.85]),
  byType(NUMBER()))

algorithm('BZ_PENSION_AMOUNT', 'characterMapping.NumericMapping', { minValue: 100, maxValue: 10000 }, '680')
domain('BZ_FIN_PENSION', 'BZ_PENSION_AMOUNT',
  byName(['pension(_?(amount|payment|monthly|benefit_?amount|balance))?|monthly_?pension|retirement_?(pension|benefit|amount|balance)|ncp_?(amount|payment)|survivors?_?pension(_?amount)?|invalidity_?pension(_?amount)?|gratuity(_?amount)?|provident_?fund(_?balance)?|pensi[oó]n(_?monto)?|jubilaci[oó]n(_?monto)?', 0.9]),
  byType(NUMBER()))

// The benefits the Social Security Board pays. Most reveal a health event: sickness, maternity,
// employment injury, invalidity.
const SSB_BENEFITS = ['Sickness benefit', 'Maternity allowance', 'Maternity grant', 'Employment injury benefit', 'Invalidity pension', "Survivors' pension", 'Retirement pension', 'Funeral grant', 'Non-contributory pension', 'None']
categorical('BZ_SSB_BENEFIT', 'bz-ssb-benefits.txt', SSB_BENEFITS, 'Disablement benefit')
domain('BZ_FIN_SSB_BENEFIT', 'BZ_SSB_BENEFIT',
  byName(['ssb_?(benefit|claim)(_?(type|status|category))?|benefit_?(type|claim|category|name|code)|claim_?type|(sickness|maternity|funeral|invalidity|survivors?|employment_?injury|disablement)_?(benefit|allowance|grant|claim)|social_?security_?(benefit|claim)(_?type)?|tipo_?(de_?)?beneficio', 0.9]),
  byList([['bz-detect-ssb-benefits.txt', [...SSB_BENEFITS, 'sickness', 'maternity', 'employment injury', 'injury benefit', 'disablement', 'invalidity', 'survivors', 'retirement', 'funeral', 'ncp', 'none'], 0.8]], { reject: 0.4 }))

// Social assistance, 2026: BOOST and the Food Assistance Programme of the Ministry of Human
// Development, the non-contributory pension, National Health Insurance.
const PROGRAMMES = ['BOOST', 'Food Assistance Programme', 'Non-Contributory Pension Programme', 'National Health Insurance', 'Other programme', 'None']
categorical('BZ_SOCIAL_PROGRAMME', 'bz-social-programmes.txt', PROGRAMMES, 'Pantry programme')
domain('BZ_FIN_SOCIAL_PROGRAMME', 'BZ_SOCIAL_PROGRAMME',
  byName(['boost(_?(beneficiary|programme|program|member|recipient))?|food_?(assistance|pantry)(_?(programme|program|beneficiary|recipient))?|pantry_?(programme|program|beneficiary)|social_?(programme|program|assistance|welfare|benefit|transfer)s?|welfare_?(programme|program|recipient|status)|cash_?transfer|beneficiary_?of_?(programme|program)|programme_?beneficiary|ncp_?(beneficiary|recipient)|non_?contributory_?pension_?(beneficiary|recipient)|nhi_?(enrolled|registered|beneficiary|status)|human_?development_?(programme|program|case)|programa_?social', 0.9]),
  byList([['bz-detect-social-programmes.txt', [...PROGRAMMES, 'boost', 'boost+', 'food pantry', 'pantry', 'grocery bag', 'food assistance', 'ncp', 'non contributory pension', 'nhi', 'none'], 0.8],
    // Being a beneficiary is often a yes/no flag: it backs up the column name but decides nothing alone.
    ['bz-detect-flag.txt', ['y', 'n', 'yes', 'no', 's', 'sí', '0', '1'], 0.3],
  ], { reject: 0.4 }))

decompose('BZ_POVERTY', [
  [String.raw`([1-5])`, apply(lookup('BZ_QUINTILE', 'bz-quintile.txt', ['1', '2', '3', '4', '5']))],
  [String.raw`([6-9]|10)`, apply(lookup('BZ_DECILE_HIGH', 'bz-decile-high.txt', ['6', '7', '8', '9', '10']))],
  [String.raw`(?i)(decile\s*)(\d{1,2})`, keep, apply(lookup('BZ_DECILE', 'bz-decile.txt', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']))],
  [String.raw`(?i)(quintile\s*)([1-5])`, keep, apply('BZ_QUINTILE')],
], apply(lookup('BZ_POVERTY_STATUS', 'bz-poverty-statuses.txt', ['Extremely poor', 'Poor', 'Vulnerable', 'Not poor'], undefined, 'PRESERVE_LOOKUP_FILE')), 'Extremely poor')
domain('BZ_FIN_POVERTY', 'BZ_POVERTY',
  byName(['poverty(_?(status|level|line|index|score|category))?|indigen(ce|t)(_?status)?|socio_?economic_?(status|level|index|group|class|score)|wealth_?(index|quintile)|income_?(quintile|decile|bracket|band)|quintile|decile|vulnerability_?(index|score)|mpi|means_?test(_?(score|result))?|pobreza|nivel_?socioecon[oó]mico|quintil|decil', 0.9]),
  byList([['bz-detect-poverty.txt', ['extremely poor', 'indigent', 'poor', 'not poor', 'vulnerable', 'non poor', 'low', 'middle', 'high'], 0.4]], { reject: 0.3 }))

// Dwelling ownership as the 2022 census asks for it.
const TENURES = ['Owned', 'Owned with mortgage', 'Rented (private)', 'Rented (government)', 'Rent free', 'Leased', 'Squatted', 'Other']
categorical('BZ_HOUSING', 'bz-housing-tenure.txt', TENURES, 'Family land')
domain('BZ_FIN_HOUSING', 'BZ_HOUSING',
  byName(
    ['housing_?(tenure|status|type|situation)|dwelling_?(tenure|ownership|type)|home_?ownership|own_?or_?rent|rent_?or_?own|owns_?(home|house)|squatt(er|ing)(_?status)?|tenencia_?(de_?)?(la_?)?vivienda|tipo_?(de_?)?vivienda', 0.95],
    ['tenure', 0.55],
  ),
  byList([['bz-detect-housing-tenure.txt', [...TENURES, 'own', 'owner', 'mortgage', 'mortgaged', 'rent', 'rented', 'renting', 'rent free', 'lease', 'squatter', 'family land', 'government'], 0.6]], { reject: 0.3 }))

// ── PENAL · Criminal record and proceedings (s. 2 (j), (k)) ─────────────────

categorical('BZ_CRIMINAL_RECORD', 'bz-criminal-record.txt', ['No criminal record', 'Has criminal record', 'Charged', 'Case dismissed', 'Acquitted', 'Convicted', 'Not stated'], 'Convicted of burglary, 2019')
domain('BZ_PENAL_CRIMINAL_RECORD', 'BZ_CRIMINAL_RECORD',
  byName(
    ['criminal_?(record|history|conviction|convictions|status|background|charges?|proceedings|case_?(status|outcome))|police_?(record|certificate|clearance|report_?status)|convictions?(_?(status|record|details))?|convicted|previous_?convictions|offen[cs]es?(_?(type|committed|code|description|details))?|charged_?with|arrests?(_?(record|history))?|sentence(_?(imposed|type|length|details))?|incarcerat(ed|ion)|imprisonment|remand(ed)?(_?status)?|bail(_?status)?|probation(_?status)?|parole|verdict|acquitt(al|ed)|antecedentes_?penales|record_?policial|delitos?|sentencia', 0.95],
    ['court_?(outcome|disposal|decision|status)|case_?(outcome|disposal)|disposal', 0.55],
  ))

domain('BZ_PENAL_CASE_NUMBER', 'BZ_CM_ALNUM',
  byName(
    ['court_?case_?(no|num|number)|criminal_?case_?(no|num|number)|indictment_?(no|num|number)|charge_?sheet_?(no|num|number)|police_?(report|occurrence|case)_?(no|num|number)|occurrence_?(no|num|number)|docket_?(no|num|number)|claim_?no_?court|inquest_?(no|number)|n(o|um|ro|umero)_?(de_?)?causa|expediente_?(judicial|penal)', 0.9],
    ['case_?(no|num|number|ref|reference)', 0.55],
  ),
  byPattern([
    [String.raw`[A-Z]{1,3}\s?\d{1,5}/\d{4}`, 0.5],
    [String.raw`(?i)\d{1,6}\s+of\s+\d{4}`, 0.5],
  ], { reject: 0.3 }))

// ── Preset ──────────────────────────────────────────────────────────────────

const referenced = JSON.stringify([domains, algorithms.map((x) => x.config)])
const orphans = algorithms.filter((a) => !referenced.includes(`"${a.name}"`))
if (orphans.length) throw new Error(`algorithms nobody uses: ${orphans.map((a) => a.name).join(', ')}`)

// The essential pack: identity documents, names, contact, address and birth date. Loading it brings
// these domains and only what they lean on; the extended pack is everything.
const ESSENTIAL = [
  'BZ_L1_SOCIAL_SECURITY_NUMBER', 'BZ_L1_TIN', 'BZ_L1_PASSPORT',
  'BZ_L1_GIVEN_NAME', 'BZ_L1_SURNAME', 'BZ_L1_FULL_NAME', 'BZ_L1_EMAIL', 'BZ_L1_PHONE',
  'BZ_L1_ADDRESS', 'BZ_L1_ADDRESS_DETAIL', 'BZ_L2_BIRTH_DATE',
]
const notDomains = ESSENTIAL.filter((name) => !domains.some((d) => d.name === name))
if (notDomains.length) throw new Error(`essential pack names domains the set does not have: ${notDomains.join(', ')}`)

const VERSION = 2
const preset = {
  version: VERSION,
  name: {
    en: 'Belize — Data Protection Act, 2021 (personal data protection)',
    'pt-BR': 'Belize — Data Protection Act, 2021 (proteção de dados pessoais)',
    es: 'Belice — Data Protection Act, 2021 (protección de datos personales)',
  },
  summary: {
    en: 'Discovers and masks Belizean personal data under the Data Protection Act, 2021: direct identifiers (social security number, TIN, names, contact, documents), quasi-identifiers (birth date, town or village), the sensitive personal data of section 2 — including financial record or position and criminal proceedings — and health records.',
    'pt-BR': 'Descobre e mascara dados pessoais de Belize segundo o Data Protection Act, 2021: identificadores diretos (número da previdência social, TIN, nomes, contato, documentos), quase-identificadores (data de nascimento, cidade ou vila), os dados pessoais sensíveis da seção 2 — incluindo registro ou situação financeira e processos criminais — e registros de saúde.',
    es: 'Descubre y enmascara datos personales de Belice conforme a la Data Protection Act, 2021: identificadores directos (número de seguridad social, TIN, nombres, contacto, documentos), cuasi-identificadores (fecha de nacimiento, ciudad o aldea), los datos personales sensibles de la sección 2 — incluidos el historial o la situación financiera y los procesos penales — y registros de salud.',
  },
  profileSet: {
    name: `BZ - Data Protection Act 2021 - v${VERSION}`,
    description: 'Direct identifiers, quasi-identifiers, sensitive personal data (section 2), health records, financial record or position, and criminal record and proceedings, under the Data Protection Act, 2021 of Belize.',
    threshold: 60,
    classifiers: classifiers.map((c) => c.name),
  },
  packs: {
    essential: {
      description: 'Essential pack of the Data Protection Act, 2021: social security number, TIN, passport, names, contact, address and birth date.',
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
