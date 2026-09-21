#!/usr/bin/env node
/**
 * Builds the Peru (Ley 29733 de Protección de Datos Personales) pre-configured profile set:
 * preset.json and files/.
 *
 *   node presets/peru-ley-29733/build.mjs
 *
 * source/ holds the hand-kept lists — given names, surnames, urbanizaciones — and the geography:
 * the 1,892 distritos and the 196 provincias with their UBIGEO code, their location and the
 * population the 2017 census counted. Everything in files/ and preset.json is generated from them
 * and from the definitions below — edit here, then build, then run verify.mjs.
 *
 * Structure of the set
 *   L1     direct identifiers      DNI and RUC with a valid check digit, foreigner card, passport,
 *                                  names, contact, address, accounts, cards, devices, cookies,
 *                                  plates, property, free text
 *   L2     quasi-identifiers       birth date, age, sex, distrito, provincia and their UBIGEO,
 *                                  postal code, urbanización, centro poblado, occupation, employer,
 *                                  education
 *   L3     sensitive data          art. 2, 5: biometric data that identifies on its own, racial and
 *                                  ethnic origin, political, religious, philosophical and moral
 *                                  opinions or convictions, trade union membership, and data on
 *                                  health or sexual life — plus genetic data, gender identity,
 *                                  indigenous people and language, nationality and victims
 *   SALUD  health data             clinical record, insurance, ICD-10, procedures, medicines, HIV,
 *                                  disability, occupational, reproductive and mental health
 *   FIN    financial data          **economic income is sensitive data in Peru** (art. 2, 5), plus
 *                                  credit history, debt, assets, pensions, social programmes,
 *                                  housing
 *   PENAL  criminal records        criminal record certificates and court file numbers
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
  if (!algorithms.some((a) => a.name === algorithmName)) throw new Error(`${name}: no algorithm ${algorithmName}`)
  domains.push({ name, algorithm: algorithmName })
  for (const make of detect) classifiers.push(make(name))
}

/** Column names: alternatives that must not be glued to other letters (digits and _ are fine). */
const words = (alternatives) => String.raw`(?i)(?<![a-z])(?:${alternatives})(?![a-z])`

const byName = (...rules) => (d) => ({
  name: `${d} - Path`, framework: 'PATH', domain: d,
  description: 'Nombre de la columna (y variantes usadas en sistemas peruanos).',
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

const GIVEN_NAMES = unique(readLines('nombres.txt'))
const SURNAMES = unique(readLines('apellidos.txt'))
const URBANIZACIONES = unique(readLines('urbanizaciones.txt'))

const PROVINCIAS = readLines('provincias.tsv').map((line) => {
  const [code, name, departmentCode, department, lat, lon, population] = line.split('\t')
  return { code, name, departmentCode, department, lat: Number(lat), lon: Number(lon), population: Number(population), aliases: [] }
})
const provinceByCode = new Map(PROVINCIAS.map((p) => [p.code, p]))
const DISTRITOS = readLines('distritos.tsv').map((line) => {
  const [code, name, provinceCode, province, departmentCode, department, lat, lon, population] = line.split('\t')
  const parent = provinceByCode.get(provinceCode)
  // Eighteen distritos were created after the 2017 census and have neither population nor a
  // location of their own: they sit at the centre of their provincia and count as small.
  return {
    code, name, provinceCode, province, departmentCode, department, aliases: [],
    lat: lat ? Number(lat) : parent.lat, lon: lon ? Number(lon) : parent.lon,
    population: population ? Number(population) : 0,
  }
})
if (PROVINCIAS.length !== 196) throw new Error(`expected 196 provincias, found ${PROVINCIAS.length}`)
if (DISTRITOS.length !== 1892) throw new Error(`expected 1,892 distritos, found ${DISTRITOS.length}`)
for (const d of DISTRITOS) {
  if (!/^\d{6}$/.test(d.code) || d.code.slice(0, 4) !== d.provinceCode || d.code.slice(0, 2) !== d.departmentCode) throw new Error(`${d.name}: bad UBIGEO`)
  if (Number.isNaN(d.lat) || Number.isNaN(d.lon)) throw new Error(`${d.name}: no location`)
}
const DEPARTMENTS = unique(DISTRITOS.map((d) => d.department))
if (DEPARTMENTS.length !== 25) throw new Error(`expected 25 departamentos, found ${DEPARTMENTS.length}`)

// ── Shared algorithms ───────────────────────────────────────────────────────

// Vowels map to vowels and consonants to consonants, so a masked document number keeps its
// structure; digits map to digits. Separators are in no group and stay. minMaskedPositions 0 lets
// a placeholder such as "N/A" through instead of failing the row.
algorithm('PE_CM_ALFANUM', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'AEIOU', 'BCDFGHJKLMNPQRSTVWXYZ', 'aeiou', 'bcdfghjklmnpqrstvwxyz', 'ÁÉÍÓÚÜ', 'áéíóúü'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, 'X123456')
// Digits only: the hyphens of a DNI or a phone stay.
algorithm('PE_CM_DIGITOS', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '45678901')
// Digits and upper-case letters, one group each: a plate stays a plate.
algorithm('PE_CM_DIGITOS_LETRAS', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, 'ABC-123')
// Hex letters form their own group, so a MAC, UUID or IPv6 stays valid hex.
algorithm('PE_CM_HEX', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'abcdef', 'ABCDEF', 'ghijklmnopqrstuvwxyz', 'GHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '3c:22:fb:9a:10:e4')
decompose('PE_REDACTAR', [['(.+)', { type: 'REDACT', redactCharacter: 'X' }]], keep, 'clave123')
lookup('PE_SUPRIMIR', 'pe-sin-informacion.txt', ['Sin información'], 'Trastorno depresivo recurrente', 'PRESERVE_LOOKUP_FILE')
decompose('PE_IDENTIDAD', [['(.*)', keep]], keep, '45678901')

// Yes/no columns keep their vocabulary: a CHAR(1) S/N stays S/N.
decompose('PE_BANDERA', [
  [String.raw`(?i)(s[ií]|no)`, apply(lookup('PE_BANDERA_SI_NO', 'pe-bandera-si-no.txt', ['Sí', 'No']))],
  ['(?i)(true|false)', apply(lookup('PE_BANDERA_TRUE_FALSE', 'pe-bandera-true-false.txt', ['true', 'false']))],
  ['(?i)(yes)', apply(lookup('PE_BANDERA_YES_NO', 'pe-bandera-yes-no.txt', ['Yes', 'No']))],
  ['(?i)([sn])', apply(lookup('PE_BANDERA_S_N', 'pe-bandera-s-n.txt', ['S', 'N']))],
  ['(?i)([yx])', apply(lookup('PE_BANDERA_Y_N', 'pe-bandera-y-n.txt', ['Y', 'N']))],
  ['([01])', apply(lookup('PE_BANDERA_0_1', 'pe-bandera-0-1.txt', ['0', '1']))],
], keep, 'S')
const FLAG = String.raw`(?i)(s[ií]|no|true|false|yes|[snyx01])`
/**
 * A categorical attribute: flags stay flags, numeric codes are replaced by another code of `codes`
 * (or get other digits), and any other value is replaced by one from `values` — or suppressed, when
 * no list is given.
 */
function categorical(name, fileName, values, input, codes) {
  const replacement = values ? lookup(`${name}_LISTA`, fileName, values) : 'PE_SUPRIMIR'
  const code = codes ? apply(lookup(`${name}_CODIGO`, fileName.replace(/\.txt$/, '-codigos.txt'), codes)) : apply('PE_CM_ALFANUM')
  return decompose(name, [[FLAG, apply('PE_BANDERA')], [String.raw`(\d{1,6})`, code]], apply(replacement), input)
}
categorical('PE_CATEGORIA_SUPRIMIDA', null, null, 'Trastorno depresivo recurrente')
const CM = apply('PE_CM_ALFANUM')
const DIGITS = apply('PE_CM_DIGITOS')

// ── L1 · DNI and RUC ────────────────────────────────────────────────────────
//
// The DNI of the Registro Nacional de Identificación y Estado Civil is the key of every Peruvian
// record: eight digits, plus a **verification character** that the card prints beside them and that
// some systems store glued to the number ("45678901-7"). RENIEC computes it modulus 11 over the
// weights 3 2 7 6 5 4 3 2 from the left; the position (eleven minus the remainder, zero when the
// remainder is zero, plus one) indexes two series — the digits 6 7 8 9 0 1 1 2 3 4 5 and the letters
// K A B C D E F G H I J, the letters belonging to the documents issued up to 14 August 2007.
//
// The RUC of SUNAT is eleven digits: two for the kind of taxpayer — 10 and 15 for a natural person,
// 17 for a succession, 20 for a legal person —, eight for the number (the DNI itself, for a natural
// person with a 10) and one check digit, modulus 11 over the weights 5 4 3 2 7 6 5 4 3 2, eleven
// minus the remainder, written 0 when that is ten and **1 when it is eleven**.
//
// Check Digit always writes (modulus − remainder) and writes ten as "0", so both rules agree with it
// except where the true digit is that one written zero: the DNI needs a series value there, and the
// RUC needs 1 when the remainder is 0 and 0 when it is 1. An **auxiliary Check Digit with doubled
// weights** tells those two remainders apart — doubling maps 0 to 0 and 1 to 2, so the auxiliary
// writes zero for the first and nine for the second — and a Regex Decompose then writes the true
// digit and drops the auxiliary. Four steps, no lookup table.
const DNI_WEIGHTS = [3, 2, 7, 6, 5, 4, 3, 2]
const RUC_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
const doubled = (weights) => weights.map((w) => (2 * w) % 11)

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

/**
 * Makes room for the auxiliary digit: the digit Check Digit has just written gains a `0` beside it,
 * which the auxiliary then overwrites. One pattern per digit, because Redaction writes a fixed
 * string and the digit has to survive.
 */
function widen(name, head, input) {
  return decompose(name, Array.from({ length: 10 }, (_, d) => [`(${head})(${d})`, keep, redactAs(`${d}0`)]), keep, input)
}
/**
 * Writes the true check digit from the pair (what Check Digit wrote, what the auxiliary wrote) and
 * drops the auxiliary. `table[0]` is the value for a written zero the auxiliary confirms, `table[10]`
 * the one for the ten Check Digit also writes as zero, and `table[1..9]` the rest.
 */
function resolve(name, head, table, input) {
  const patterns = [[`(${head})(00)`, keep, redactAs(String(table[0]))], [`(${head})(0\\d)`, keep, redactAs(String(table[10]))]]
  for (let d = 1; d <= 9; d++) patterns.push([`(${head})(${d}\\d)`, keep, redactAs(String(table[d]))])
  return decompose(name, patterns, keep, input)
}

// DNI: the eight digits are mapped digit by digit and the verification character is recomputed.
const DNI_HEAD = String.raw`\d{8}[\s\-]?`
const DNI_SERIES = [6, 7, 8, 9, 0, 1, 1, 2, 3, 4, 5]
const DNI_LETTERS = ['K', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']
checkDigit('PE_DNI_CD', DNI_WEIGHTS, 11, 'PE_CM_DIGITOS', '45678901')
widen('PE_DNI_ESPACIO', DNI_HEAD, '456789016')
checkDigit('PE_DNI_AUX', [...doubled(DNI_WEIGHTS), 0], 11, 'PE_IDENTIDAD', '4567890160')
resolve('PE_DNI_VERIFICADOR', DNI_HEAD, DNI_SERIES, '4567890160')
resolve('PE_DNI_LETRA', DNI_HEAD, DNI_LETTERS, '4567890160')
chain('PE_DNI_CON_DIGITO', ['PE_DNI_CD', 'PE_DNI_ESPACIO', 'PE_DNI_AUX', 'PE_DNI_VERIFICADOR'], '45678901-7')
chain('PE_DNI_CON_LETRA', ['PE_DNI_CD', 'PE_DNI_ESPACIO', 'PE_DNI_AUX', 'PE_DNI_LETRA'], '45678901-A')

// RUC: the two digits of the kind of taxpayer stay, the eight of the number are mapped, the digit is
// recomputed. A natural person's RUC is 10 followed by the DNI, so both stay consistent.
const RUC_HEAD = String.raw`\d{10}`
const RUC_TABLE = [1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0]
decompose('PE_RUC_CUERPO', [[String.raw`(\d{2})(\d{8})`, keep, DIGITS]], DIGITS, '2013137897')
checkDigit('PE_RUC_CD', RUC_WEIGHTS, 11, 'PE_RUC_CUERPO', '20131378972')
widen('PE_RUC_ESPACIO', RUC_HEAD, '20131378972')
checkDigit('PE_RUC_AUX', [...doubled(RUC_WEIGHTS), 0], 11, 'PE_IDENTIDAD', '201313789720')
resolve('PE_RUC_VERIFICADOR', RUC_HEAD, RUC_TABLE, '201313789720')
chain('PE_RUC', ['PE_RUC_CD', 'PE_RUC_ESPACIO', 'PE_RUC_AUX', 'PE_RUC_VERIFICADOR'], '20131378972')

// A document column holds DNIs, RUCs, foreigner cards and passports: each value goes by its shape.
decompose('PE_DOCUMENTO', [
  [String.raw`((?:10|15|17|20)\d{9})`, apply('PE_RUC')],
  [String.raw`(\d{8}[\s\-]?[0-9])`, apply('PE_DNI_CON_DIGITO')],
  [String.raw`(\d{8}[\s\-]?[A-JKa-jk])`, apply('PE_DNI_CON_LETRA')],
  [String.raw`(\d{8})`, DIGITS],
], CM, '45678901')

const DOC_OWNER = 'cliente|cli|paciente|pac|usuario|afiliado|asegurado|beneficiario|benef|titular|empleado|emp|trabajador|colaborador|alumno|estudiante|deudor|codeudor|fiador|avalista|solicitante|propietario|arrendatario|inquilino|conductor|responsable|representante|apoderado|persona|ciudadano|elector|votante|contribuyente|proveedor|socio|conyuge|padre|madre|hijo|familiar|jubilado|pensionista|aportante|derechohabiente'
domain('PE_L1_DNI', 'PE_DOCUMENTO',
  byName(
    [`dni|d_n_i|documento_?nacional(_?de_?identidad)?|n(o|ro|um|umero)_?(dni|documento|doc|identificaci[oó]n|id(ent)?)|doc_?identidad|nro_?doc|num_?doc|cui|c[oó]digo_?[uú]nico_?de_?identificaci[oó]n|(${DOC_OWNER})_?(dni|doc|documento)|dni_?(${DOC_OWNER})`, 0.9],
    ['documento|doc|identificaci[oó]n', 0.6],
  ),
  byType(STRING(8), NUMBER(8)),
  byPattern([
    [String.raw`\d{8}[\s\-][0-9A-JK]`, 0.9],
    [String.raw`\d{8}`, 0.5],
  ], { reject: 0.3 }))

domain('PE_L1_RUC', 'PE_RUC',
  byName([`ruc[a-z0-9_]*|n(o|ro|um|umero)_?ruc|registro_?[uú]nico_?(de_?)?contribuyente|(${DOC_OWNER})_?ruc|ruc_?(${DOC_OWNER})|id_?tributario|tax_?id`, 0.9]),
  byPattern([[String.raw`(10|15|17|20)\d{9}`, 0.9], [String.raw`\d{11}`, 0.5]], { reject: 0.3 }))

// The verification character kept in a column of its own cannot be recomputed there: the number it
// belongs to is not in the value, so it is mapped.
domain('PE_L1_DIGITO_VERIFICACION', 'PE_CM_DIGITOS_LETRAS',
  byName(['d[ií]gito_?(de_?)?verificaci[oó]n|digito_?verificador|dig_?ver|dv_?dni|dv|c[oó]digo_?(de_?)?verificaci[oó]n_?(dni|documento)|check_?digit', 0.8]),
  byType(STRING(0, 1), NUMBER(0, 1)))

// ── L1 · Other identity documents ───────────────────────────────────────────

domain('PE_L1_CARNE_EXTRANJERIA', 'PE_CM_ALFANUM',
  byName(['carn[eé]_?(de_?)?extranjer[ií]a|carnet_?extranjeria|c[\\.\\s]?e[\\.\\s]?_?(n(o|ro|um|umero))?|n(o|ro|um|umero)_?(carn[eé]|extranjer[ií]a)|permiso_?temporal_?(de_?)?permanencia|ptp|carn[eé]_?(de_?)?permiso_?temporal|cpp|calidad_?migratoria|condici[oó]n_?migratoria|n(o|ro|um|umero)_?(de_?)?(residencia|migraciones)|visa(_?n(o|ro|um|umero))?', 0.85]))

domain('PE_L1_PASAPORTE', 'PE_CM_ALFANUM',
  byName(['pasaporte[a-z0-9_]*|n(o|ro|um|umero)_?pasaporte|passport[a-z0-9_]*', 0.9]),
  byPattern([[String.raw`[A-Z]{1,2}\d{6,8}`, 0.4]], { reject: 0.3 }))

// RENIEC keeps the civil registry: birth, marriage and death records by acta, libro and folio.
domain('PE_L1_ACTA', 'PE_CM_ALFANUM',
  byName(['acta_?(de_?)?(nacimiento|matrimonio|defunci[oó]n)(_?(n(o|ro|um|umero)|folio|libro))?|n(o|ro|um|umero)_?acta|partida_?(de_?)?(nacimiento|matrimonio|defunci[oó]n)|folio_?(acta|libro|partida)|libro_?(acta|registro)|asiento_?registral_?civil|c[oó]digo_?[uú]nico_?de_?acta|cua', 0.85]))

// EsSalud numbers the insured with an "autogenerado"; the private pension system with the CUSPP.
domain('PE_L1_SEGURO_SOCIAL', 'PE_CM_ALFANUM',
  byName(['autogenerado|c[oó]digo_?(de_?)?(asegurado|autogenerado|essalud)|n(o|ro|um|umero)_?(essalud|asegurado|afiliado|autogenerado)|essalud[a-z0-9_]*|cuspp|c[oó]digo_?[uú]nico_?(de_?)?identificaci[oó]n_?(del_?)?spp|n(o|ro|um|umero)_?(afp|onp|cuenta_?individual|cic)|afp[a-z0-9_]*|onp[a-z0-9_]*|n(o|ro|um|umero)_?(de_?)?aportante', 0.85]))

domain('PE_L1_CODIGO_ESTUDIANTE', 'PE_CM_ALFANUM',
  byName(['c[oó]digo_?(de_?)?(estudiante|alumno|matr[ií]cula|educando)|cod_?(alumno|estudiante)|n(o|ro|um|umero)_?(de_?)?(matr[ií]cula|carn[eé]_?universitario)|carn[eé]_?(de_?)?(estudiante|universitario)|id_?(alumno|estudiante)|c[oó]digo_?modular_?(del_?)?estudiante|siagie', 0.8]))

domain('PE_L1_COLEGIATURA', 'PE_CM_ALFANUM',
  byName(['colegiatura|n(o|ro|um|umero)_?(de_?)?(colegiatura|colegiado|registro_?profesional)|cmp|c[oó]digo_?(m[eé]dico|profesional)|registro_?(m[eé]dico|profesional|cip|cal)|cip|matr[ií]cula_?profesional|habilitaci[oó]n_?profesional', 0.85]))

// ── L1 · Names ──────────────────────────────────────────────────────────────

const NOT_A_PERSON = 'producto|prod|item|articulo|empresa|emp|razon|social|comercial|archivo|calle|avenida|jiron|pasaje|urbanizacion|asentamiento|caserio|anexo|centro|poblado|barrio|distrito|provincia|departamento|region|depto|dpto|pais|banco|sucursal|agencia|plan|campana|proyecto|servicio|tabla|columna|campo|usuario|host|servidor|dominio|marca|modelo|categoria|tipo|escuela|colegio|institucion|universidad|curso|materia|documento|doc|unidad|clinica|hospital|essalud|seguro|area|dependencia|cargo|sistema|app|aplicacion|grupo|lista|reporte|informe|proceso|evento|tarea|perfil|rol|clase|objeto|cuenta|medicamento|diagnostico|estudio|programa|beneficio|partido|sindicato|religion|pueblo|lengua|idioma|lugar|sede|local|tienda|almacen|proveedor|convenio|contrato|poliza|aseguradora|entidad|organismo|organizacion|parametro|variable|metodo|funcion|indice|job|script|cola|recurso|red|dispositivo|plantilla|imagen|foto|pagina|sitio|modulo|menu|opcion|accion|permiso|concepto|impuesto|moneda|emisor|factura|comprobante|pago|forma|zona|ruta|linea|actividad|rubro|sector|file|table|column|field|user|server|product|company|category|type|school|document|department|system|group|report|role|account|place|store|supplier|contract|device|image|page|module|action|key|label|code|project|city|country|street|bank'
const PERSON_ROLE = 'cliente|cli|paciente|pac|usuario|afiliado|asegurado|beneficiario|benef|titular|empleado|trabajador|colaborador|alumno|estudiante|deudor|codeudor|fiador|avalista|solicitante|propietario|arrendatario|inquilino|conductor|responsable|representante|apoderado|persona|ciudadano|contribuyente|madre|padre|conyuge|conviviente|contacto|referencia|victima|denunciante|imputado|procesado|testigo|medico|docente|socio|heredero|donante|tutor|jubilado|pensionista|derechohabiente|customer|patient|employee|member|holder|mother|father|spouse|contact|person|student|driver|owner'
const PARTICLES = String.raw`(?i)(de|del|la|las|los|y|e|san|santa|van|von|di|da)`

algorithm('PE_NOMBRE', 'name.Name', {
  lookupFile: { uri: file('pe-nombres.txt', GIVEN_NAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Milagros')
algorithm('PE_APELLIDO', 'name.Name', {
  lookupFile: { uri: file('pe-apellidos.txt', SURNAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Quispe')
// A word of a name. "de", "del", "la" stay where they are: "María de los Ángeles", "Ana de Rojas".
decompose('PE_PALABRA_NOMBRE', [[PARTICLES, keep]], apply('PE_NOMBRE'), 'Rocío')
decompose('PE_PALABRA_APELLIDO', [[PARTICLES, keep]], apply('PE_APELLIDO'), 'Huamán')
const N = apply('PE_PALABRA_NOMBRE')
const S = apply('PE_PALABRA_APELLIDO')

decompose('PE_NOMBRES', [
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, N],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, N, N],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, N, N],
], CM, 'María del Rosario')
decompose('PE_APELLIDOS', [
  [String.raw`(\S+)`, S],
  [String.raw`(\S+)\s+(\S+)`, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, S, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, S, S, S, S],
], CM, 'Quispe Huamán')
// Peruvian order: one or two given names, the father's surname and the mother's surname. Two words
// are a given name and a surname; three, a given name and two surnames; four, two and two. RENIEC
// lists write APELLIDOS, NOMBRES with a comma.
decompose('PE_NOMBRE_COMPLETO', [
  [String.raw`([^,]+),\s*(.+)`, apply('PE_APELLIDOS'), apply('PE_NOMBRES')],
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, S, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, N, S, S, S],
], CM, 'Juan Carlos Quispe Huamán')
const NAME_WORDS = ['de', 'del', 'la', 'las', 'los', 'y']

domain('PE_L1_NOMBRE', 'PE_NOMBRES',
  byName(
    ['primer_?nombre|segundo_?nombre|nombres?_?(de_?)?pila|pri(mer)?_?nom|seg(undo)?_?nom|nombre_?1|nombre_?2|prenombres?|first_?names?|given_?names?|fname|middle_?names?|nombres(?!_?(completos?|y_?apellidos?|apellidos?))', 0.85],
    [`nombre(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|apellidos?|usuario|corto|largo))|nom(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}))|name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))`, 0.5],
  ),
  byList([['pe-detectar-nombres.txt', [...GIVEN_NAMES, ...NAME_WORDS], 0.7]], { tokenize: true, reject: 0.3 }))

domain('PE_L1_APELLIDO', 'PE_APELLIDOS',
  byName(['apellidos?|primer_?apellido|segundo_?apellido|apellido_?(1|2|paterno|materno|casada)|ape_?(1|2|pat|mat)|ap_?(paterno|materno)|last_?names?|surnames?|family_?names?|lname', 0.85]),
  byList([['pe-detectar-apellidos.txt', [...SURNAMES, ...NAME_WORDS], 0.7]], { tokenize: true, reject: 0.3 }))

domain('PE_L1_NOMBRE_COMPLETO', 'PE_NOMBRE_COMPLETO',
  byName(
    [`nombres?_?(completos?|y_?apellidos?|apellidos?)|apellidos?_?(y_?)?nombres?|nombre_?(del_?|de_?la_?)?(${PERSON_ROLE})|(${PERSON_ROLE})_?(nombre|nom)|nom_?(${PERSON_ROLE})|nombre_?(madre|padre|tutor|conyuge|conviviente|contacto_?emergencia|referencia)|full_?name|person_?name|razon_?social_?persona_?natural`, 0.9],
    ['madre|padre|tutor|conyuge|conviviente|representante_?legal|apoderado|fiador|beneficiario|heredero|titular|referencia_?(personal|familiar)', 0.6],
    // A bare NOMBRE holds a given name or a full name: the values decide between the two domains.
    [`nombre(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|apellidos?|usuario|corto|largo))|nom(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}))|name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))`, 0.5],
  ),
  byList([['pe-detectar-nombres.txt', [...GIVEN_NAMES, ...NAME_WORDS], 0.65], ['pe-detectar-apellidos.txt', [...SURNAMES, ...NAME_WORDS], 0.65]], { tokenize: true, reject: 0.3 }))

// A sole trader trades under a name of his own: the Ley 29733 protects the natural person behind
// the razón social, and the RUC that names him is in the same row.
lookup('PE_RAZON_SOCIAL', 'pe-razones-sociales.txt', ['Inversiones Andinas S.A.C.', 'Comercial Los Incas E.I.R.L.', 'Transportes Altiplano S.A.C.', 'Distribuidora del Pacífico S.R.L.', 'Constructora Huascarán S.A.', 'Agroindustrias del Norte S.A.C.', 'Servicios Generales Pachacámac E.I.R.L.', 'Textiles Gamarra S.A.C.', 'Minera Cordillera Blanca S.A.', 'Pesquera Costa Azul S.A.C.', 'Importaciones Amazonas E.I.R.L.', 'Grupo Logístico Callao S.A.C.', 'Consultora Tecnológica Lima S.A.C.', 'Farmacéutica San Marcos S.A.', 'Editorial Vicús E.I.R.L.', 'Turismo Valle Sagrado S.A.C.', 'Avícola El Mantaro S.A.', 'Café de Altura Chanchamayo S.A.C.', 'Seguridad Vigía Perú S.A.C.', 'Laboratorio Clínico Salud Total E.I.R.L.'], 'Corporación Comercial Peruana S.A.C.', 'PRESERVE_LOOKUP_FILE')
domain('PE_L1_RAZON_SOCIAL', 'PE_RAZON_SOCIAL',
  byName(['raz[oó]n_?social|razonsocial|nombre_?(comercial|de_?la_?empresa|empresa)|denominaci[oó]n_?social|nombre_?legal|business_?name|company_?name|legal_?name', 0.85]))

// ── L1 · Contact ────────────────────────────────────────────────────────────

decompose('PE_EMAIL', [
  // The top-level domain becomes .test, reserved for tests: a masked address can never deliver.
  [String.raw`([^@\s]+)@([^@\s]+)\.([A-Za-z]{2,24}(?:\.[A-Za-z]{2})?)`, CM, CM, redactAs('test')],
], CM, 'milagros.quispe@gmail.com')
domain('PE_L1_EMAIL', 'PE_EMAIL',
  byName(['e_?mail[a-z0-9_]*|mail[a-z0-9_]*|correo(_?electr[oó]nico)?[a-z0-9_]*|dir_?correo|direcci[oó]n_?(de_?)?correo|direcci[oó]n_?electr[oó]nica', 0.85]),
  byType(STRING(5)),
  byPattern([[String.raw`[A-Za-z0-9._%+'\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}`, 1]], { reject: 0.2 }))

// Nine digits for a mobile, all starting with 9; a landline is an area code — 1 for Lima and Callao,
// two digits elsewhere — and six or seven digits. The country code, the leading 9 and the area code
// stay, so a masked number keeps saying mobile or landline and which region.
decompose('PE_TELEFONO', [
  [String.raw`(\+?51[\s\-]?)?(9)(\d{2})([\s\-]?)(\d{3})([\s\-]?)(\d{3})`, keep, keep, DIGITS, keep, DIGITS, keep, DIGITS],
  [String.raw`(\(?0?1\)?[\s\-]?)(\d{3})([\s\-]?)(\d{4})`, keep, DIGITS, keep, DIGITS],
  [String.raw`(\(?0?[2-8]\d\)?[\s\-]?)(\d{3})([\s\-]?)(\d{3})`, keep, DIGITS, keep, DIGITS],
], DIGITS, '+51 987 654 321')
domain('PE_L1_TELEFONO', 'PE_TELEFONO',
  byName(['tel|tel[eé]fono[a-z0-9_]*|tel_?(fijo|casa|oficina|trabajo|contacto|celular|m[oó]vil)|celular[a-z0-9_]*|cel|m[oó]vil|whats_?app|anexo_?telef[oó]nico|n(o|ro|um|umero)_?(tel|tel[eé]fono|celular|cel|contacto)|fax|phone[a-z0-9_]*|mobile[a-z0-9_]*', 0.85]),
  byPattern([
    [String.raw`(\+?51[\s\-]?)?9\d{2}[\s\-]?\d{3}[\s\-]?\d{3}`, 0.9],
    [String.raw`\(?0?1\)?[\s\-]?\d{3}[\s\-]?\d{4}`, 0.5],
  ], { reject: 0.3 }))

// Peruvian addresses name the kind of street — avenida, jirón, calle, pasaje — and then the number,
// the urbanización or the asentamiento humano, the manzana and the lote: "Av. Arequipa 1234,
// Urb. Santa Patricia", "Mz. B Lt. 12, AA.HH. Villa El Salvador". The whole line becomes a
// fictitious one.
const VIAS = ['Av.', 'Avenida', 'Jr.', 'Jirón', 'Calle', 'Pasaje', 'Psje.', 'Prolongación', 'Alameda', 'Malecón', 'Carretera']
const VIA_NAMES = ['Arequipa', 'Abancay', 'Tacna', 'Brasil', 'La Marina', 'Javier Prado', 'Colonial', 'Grau', 'Bolívar', 'Túpac Amaru', 'Los Próceres', 'Las Palmeras', 'Universitaria', 'Canadá', 'Aviación', 'Angamos', 'Benavides', 'Primavera', 'El Sol', 'Los Olivos', 'Mariscal Castilla', 'San Martín', 'Independencia', 'Progreso', 'Los Héroes', 'Las Flores', 'Micaela Bastidas', 'Inca Garcilaso', 'Manco Cápac', 'Simón Bolívar', 'José Gálvez', 'Ramón Castilla', 'Amazonas', 'Huáscar', 'Pachacútec']
lookup('PE_DIRECCION', 'pe-direcciones.txt', (() => {
  const random = seeded(29733)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const num = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
  const out = new Set()
  while (out.size < 4000) {
    const street = `${pick(VIAS)} ${pick(VIA_NAMES)}`
    const r = random()
    if (r < 0.35) out.add(`${street} ${num(100, 3500)}, ${pick(URBANIZACIONES)}`)
    else if (r < 0.55) out.add(`${street} ${num(100, 3500)} Int. ${num(101, 1200)}`)
    else if (r < 0.7) out.add(`Mz. ${pick(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'])} Lt. ${num(1, 40)}, ${pick(URBANIZACIONES)}`)
    else if (r < 0.82) out.add(`${street} ${num(100, 3500)}`)
    else if (r < 0.92) out.add(`${pick(URBANIZACIONES)}, ${street} ${num(100, 900)}`)
    else out.add(`Km ${num(1, 120)} Carretera ${pick(['Central', 'Panamericana Norte', 'Panamericana Sur', 'Interoceánica', 'Longitudinal de la Sierra'])}`)
  }
  return [...out]
})(), 'Av. Arequipa 1234, Urb. Santa Patricia', 'PRESERVE_LOOKUP_FILE')
domain('PE_L1_DIRECCION', 'PE_DIRECCION',
  byName(['(?<!(mac|ip|e_?mail|web|url|correo)_?)direcci[oó]n(?!_?(ip|mac|email|e_?mail|correo|electr[oó]nica|web|url|tipo|id|general|regional))[a-z0-9_]*|domicilio[a-z0-9_]*|dom_?(residencia|particular|laboral|cliente|fiscal)|residencia|lugar_?(de_?)?residencia|direccion_?fiscal|calle(_?y_?n[uú]mero)?|(?<!(mac|ip|e_?mail|web|url)_?)address(?!_?(ip|mac|email|e_?mail|web|url|type|id))[a-z0-9_]*', 0.8]),
  byType(STRING(6)),
  byPattern([
    [String.raw`(?i)(av|avenida|jr|jir[oó]n|calle|ca|pasaje|psje|prolongaci[oó]n|alameda|malec[oó]n|carretera)\.?\s+[a-záéíóúñ0-9.' ]{2,40}\s*(n°|nro\.?|#)?\s*\d{1,5}.*`, 0.8],
    [String.raw`(?i).*\b(mz|manzana)\.?\s*[a-z0-9]{1,3}\s*(lt|lote)\.?\s*\d{1,3}.*`, 0.8],
    [String.raw`(?i).*\b(urb|urbanizaci[oó]n|aa\.?hh\.?|asentamiento_?humano|pueblo_?joven|coop|cooperativa|residencial|conjunto_?habitacional)\.?\s+[a-záéíóúñ0-9.' ]{2,40}.*`, 0.7],
    [String.raw`(?i)k(m|il[oó]metro)\.?\s*\d{1,3}\s+(carretera|autopista|v[ií]a).*`, 0.7],
  ], { reject: 0.2 }))

domain('PE_L1_DIRECCION_COMPLEMENTO', 'PE_CM_ALFANUM',
  byName(['manzana|mz|lote|lt|interior|int_?(direccion|domicilio)|dpto_?(n(o|ro|um|umero))?|departamento_?(n(o|ro|um|umero)|interior)|piso|block|bloque|etapa|sector_?(vivienda|domicilio)|n(o|ro|um|umero)_?(casa|puerta|dpto|interior)|complemento(_?direcci[oó]n)?|referencia_?(de_?)?(direcci[oó]n|domicilio)', 0.7]))

// ── L1 · Banking, payments, network, devices, vehicles, property ────────────

domain('PE_L1_CUENTA_BANCARIA', 'PE_CM_DIGITOS',
  byName(['cuenta_?(bancaria|banco|corriente|ahorro|sueldo|haberes|cts|abono|dep[oó]sito|destino|origen|detracci[oó]n)|n(o|ro|um|umero)_?(de_?)?(cuenta|cta)|nro_?cta|num_?cta|cta_?(cte|corriente|ahorro|bancaria)|cci|c[oó]digo_?(de_?)?cuenta_?interbancario|iban|account_?(no|num|number)|bank_?account', 0.85]))

// Payment Card fails a row that has no digits to mask; only values shaped like a card reach it.
algorithm('PE_TARJETA_LUHN', 'characterMapping.PaymentCard', { minMaskedPositions: 6, preserve: 0 }, '4557880000000001')
decompose('PE_TARJETA', [[String.raw`(\d[\d\s\-]{11,22}\d)`, apply('PE_TARJETA_LUHN')]], keep, '4557 8800 0000 0001')
domain('PE_L1_TARJETA', 'PE_TARJETA',
  byName(['tarjeta(_?(cr[eé]dito|d[eé]bito|n(o|ro|um|umero)))?|n(o|ro|um|umero)_?tarjeta|pan|card_?(no|num|number)|credit_?card|tc_?(numero|num|nro)', 0.85]),
  // 0.9, not 1: an IMEI is 15 Luhn-valid digits too, and its own column name should win.
  byPattern([[String.raw`\d{13,19}`, 0.9, { checksum: 'LUHN', clean: String.raw`[\s\-]` }]], { reject: 0.3 }))

// Mobile wallets: Yape and Plin are keyed by the phone number, and the QR carries it.
domain('PE_L1_BILLETERA', 'PE_CM_ALFANUM',
  byName(['billetera(_?(digital|electr[oó]nica|m[oó]vil))?|wallet(_?(id|address|direccion))?|yape[a-z0-9_]*|plin[a-z0-9_]*|tunki|lukita|agora_?pay|c[oó]digo_?qr|qr_?(id|codigo)|direcci[oó]n_?(bitcoin|btc|wallet)|btc_?(address|direccion)', 0.85]),
  byPattern([
    [String.raw`(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,59}`, 0.7],
  ], { reject: 0.3 }))

algorithm('PE_OCTETO', 'characterMapping.NumericMapping', { minValue: 1, maxValue: 254 }, '10')
decompose('PE_IP', [
  [String.raw`(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})`, apply('PE_OCTETO'), apply('PE_OCTETO'), apply('PE_OCTETO'), apply('PE_OCTETO')],
], apply('PE_CM_HEX'), '190.117.45.12')
domain('PE_L1_IP', 'PE_IP',
  byName(['ip|ip_?(address|addr|origen|destino|cliente|usuario|acceso|login|remota|publica)|direcci[oó]n_?ip|dir_?ip|ipv[46]|remote_?addr(ess)?|client_?ip|host_?ip', 0.85]),
  byPattern([
    [String.raw`((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)`, 1],
    [String.raw`[0-9A-Fa-f]{1,4}(:[0-9A-Fa-f]{0,4}){2,7}`, 0.9],
  ], { reject: 0.3 }))

domain('PE_L1_DISPOSITIVO', 'PE_CM_HEX',
  byName(['imei|imsi|iccid|mac|mac_?address|direcci[oó]n_?mac|device_?(id|uuid|serial)|id_?(dispositivo|equipo|celular)|serial_?(equipo|celular|dispositivo)|advertising_?id|idfa|gaid|session_?id|id_?sesi[oó]n', 0.8]),
  byPattern([
    [String.raw`([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}`, 1],
    [String.raw`\d{15}`, 0.8, { checksum: 'LUHN' }],
  ], { reject: 0.3 }))

// The reglamento defines the cookie in art. 2 and treats the identifier it stores as personal data
// when it singles out a person.
domain('PE_L1_COOKIE', 'PE_CM_ALFANUM',
  byName(['cookie(_?(id|value|valor|nombre))?|cookies|_?ga|_?gid|fbp|fbclid|utm_?(source|medium|campaign|term|content)|id_?(navegador|browser|visitante)|visitor_?id|tracking_?id|client_?id', 0.8]))

// Plates: three letters and three digits since 2011 (`ABC-123`), with a variant that mixes them
// (`A1B-234`); a motorcycle carries two digits and four (`NN-1234`).
domain('PE_L1_PLACA', 'PE_CM_DIGITOS_LETRAS',
  byName(['placa(_?(veh[ií]culo|carro|moto|automotor|rodaje))?|n(o|ro|um|umero)_?placa|placa_?[uú]nica_?nacional_?(de_?)?rodaje|punr|matr[ií]cula_?(veh[ií]culo|automotor)|license_?plate|plate(_?(no|number))?', 0.85]),
  byPattern([
    [String.raw`[A-Z][0-9A-Z][A-Z][\s\-]?\d{3}`, 0.8],
    [String.raw`[A-Z]{2}[\s\-]?\d{4}`, 0.5],
  ], { reject: 0.3 }))

domain('PE_L1_VEHICULO', 'PE_CM_ALFANUM',
  byName(['vin|chasis|n(o|ro|um|umero)_?(chasis|motor|serie|vin)|motor_?n(o|ro|um|umero)|tarjeta_?(de_?)?(identificaci[oó]n_?vehicular|propiedad|circulaci[oó]n)|licencia_?(de_?)?conducir(_?(n(o|ro|um|umero)))?|n(o|ro|um|umero)_?licencia|brevete', 0.85]),
  byPattern([[String.raw`[A-HJ-NPR-Z0-9]{17}`, 0.7]], { reject: 0.3 }))

// SUNARP keeps the property registry: partida registral, ficha and the cadastral code lead to the
// home and its owner.
domain('PE_L1_INMUEBLE', 'PE_CM_ALFANUM',
  byName(['partida_?(registral|electr[oó]nica)|n(o|ro|um|umero)_?partida_?registral|ficha_?registral|tomo_?(y_?)?folio|n(o|ro|um|umero)_?(de_?)?(predio|inmueble|catastral)|c[oó]digo_?(catastral|predial|de_?predio)|catastro|cup|asiento_?registral|sunarp|autoval[uú]o_?(n(o|ro|um|umero)|c[oó]digo)|hr_?pu', 0.8]))

domain('PE_L1_CONTRATO', 'PE_CM_ALFANUM',
  byName(['n(o|ro|um|umero)_?(contrato|p[oó]liza|cr[eé]dito|pr[eé]stamo|solicitud|expediente_?(administrativo|interno)|tr[aá]mite|referencia|cliente|socio|suscriptor|suministro|medidor|servicio|caso|ticket|beneficio)|contrato_?(n(o|ro|um|umero))|c[oó]digo_?(cliente|socio|empleado|afiliado|suministro)|id_?(cliente|socio|empleado|afiliado)|n(o|ro)_?empleado|c[oó]digo_?(de_?)?(empleado|trabajador|planilla)|n(o|ro|um|umero)_?expediente_?siga', 0.7]))

domain('PE_L1_USUARIO', 'PE_CM_ALFANUM',
  byName(['usuario|user_?name|username|login|alias|apodo|nick(_?name)?|perfil_?(instagram|facebook|twitter|tiktok|linkedin|x)|instagram|facebook|twitter|tiktok|linkedin|red_?social|handle', 0.7]))

domain('PE_L1_CREDENCIAL', 'PE_REDACTAR',
  byName(['contrase[nñ]a|clave(?!_?(catastral|primaria|for[aá]nea|valor|producto))|password|passwd|pwd|pass|hash_?(clave|contrasena|password)|pin|c[oó]digo_?(seguridad|verificaci[oó]n|acceso|otp)|cvv|cvc|token(_?(acceso|refresh|api))?|access_?token|refresh_?token|api_?key|llave_?(api|privada)|secreto|secret|otp|clave_?sol|clave_?(de_?)?internet|pregunta_?secreta|respuesta_?secreta|frase_?semilla|seed_?phrase', 0.9]))

decompose('PE_COORDENADA', [
  // The integer part and first decimal stay (about 11 km): the place is generalized, not moved.
  [String.raw`(-?\d{1,3}[.,]\d)(\d+)\s*([,;])\s*(-?\d{1,3}[.,]\d)(\d+)`, keep, DIGITS, keep, keep, DIGITS],
  [String.raw`(-?\d{1,3}[.,]\d)(\d+)`, keep, DIGITS],
], keep, '-12.046374')
domain('PE_L1_GEOLOCALIZACION', 'PE_COORDENADA',
  byName(
    ['lat|latitud|lon|lng|longitud|coordenadas?|coord_?[xy]|geo_?(lat|lon|lng|loc|localizacion|posicion)|georreferenciaci[oó]n|geolocalizaci[oó]n|gps(_?(ubicaci[oó]n|posici[oó]n|coordenadas))?|ubicaci[oó]n_?gps', 0.85],
    ['long', 0.5],
  ),
  byPattern([
    [String.raw`-\d{1,2}\.\d{3,}\s*,\s*-(7|8)\d\.\d{3,}`, 0.9],
    [String.raw`-(7[0-9]|8[01])\.\d{4,}`, 0.5],
    [String.raw`-\d{1,2}\.\d{4,}`, 0.4],
  ], { reject: 0.3 }))

// ── L1 · Free text ──────────────────────────────────────────────────────────

algorithm('PE_TEXTO_LIBRE', 'freeTextRedaction.FreeTextRedaction', {
  regularExpressions: [
    String.raw`(?<!\d)\d{8}-[0-9A-JKa-jk](?!\d)`,
    String.raw`(?<!\d)\d{8}(?!\d)`,
    String.raw`(?<!\d)(10|15|17|20)\d{9}(?!\d)`,
    String.raw`[\w.+\-]+@[\w\-]+(\.[\w\-]+)+`,
    String.raw`(?<![\d\-])(\+?51[\s\-]?)?9\d{2}[\s\-]?\d{3}[\s\-]?\d{3}(?![\d\-])`,
    String.raw`(?<!\d)\d{13,19}(?!\d)`,
    String.raw`(?<![A-Za-z])[A-Z][0-9A-Z][A-Z][\s\-]?\d{3}(?![A-Za-z\d])`,
    String.raw`(?<!\d)(\d{1,3}\.){3}\d{1,3}(?!\d)`,
  ].map((patternString) => ({ patternString })),
  regExRedactValue: '[DATO]',
  lookupFile: { uri: file('pe-texto-nombres.txt', unique([...GIVEN_NAMES, ...SURNAMES].flatMap((v) => [v, v.toUpperCase(), fold(v), fold(v).toUpperCase()]))) },
  lookupFileRedactValue: '[NOMBRE]',
  isDenyList: true,
}, 'Cliente Quispe, DNI 45678901, correo m.quispe@gmail.com, cel 987654321')

domain('PE_L1_TEXTO_LIBRE', 'PE_TEXTO_LIBRE',
  byName(['observaci[oó]n(es)?|obs|comentarios?|notas?|anotaci[oó]n(es)?|glosa|sustento|descripci[oó]n_?(queja|reclamo|solicitud|caso|hechos|novedad|atenci[oó]n|denuncia)|detalle_?(reclamo|solicitud|caso|atenci[oó]n)|hechos|relato|justificaci[oó]n|(?<!(id|cd|cod|codigo|tipo|fecha|estado|num|nro)_?)mensaje(?!_?(id|tipo|codigo|fecha|estado|cola|log))|texto(_?libre)?|resumen_?(caso|atenci[oó]n)|queja|reclamo|denuncia_?texto|remarks?|comments?|notes?|free_?text|memo', 0.6]),
  byType(STRING(30)),
  byPattern([
    [String.raw`\d{8}-[0-9A-JK]`, 0.7],
    [String.raw`[\w.+\-]+@[\w\-]+\.[A-Za-z]{2,}`, 0.7],
    [String.raw`9\d{2}[\s\-]?\d{3}[\s\-]?\d{3}`, 0.6],
  ], { reject: 0, partial: true }))

// ── L2 · Quasi-identifiers ──────────────────────────────────────────────────

// Small shifts: large enough to break the link to the person, small enough that ages and school
// years move for few people.
algorithm('PE_FECHA_NACIMIENTO', 'dateAlgorithms.DateShift', { minRange: -60, maxRange: 60, unit: 'DAYS', roll: false }, '1985-07-20')
algorithm('PE_FECHA_EVENTO', 'dateAlgorithms.DateShift', { minRange: -30, maxRange: 30, unit: 'DAYS', roll: false }, '2021-03-15')

domain('PE_L2_FECHA_NACIMIENTO', 'PE_FECHA_NACIMIENTO',
  byName(['(fecha|fec|fch|f)_?(de_?)?nac(imiento)?|fnac|fechanac(imiento)?|cumplea[nñ]os|dob|date_?of_?birth|birth_?date|birthday', 0.9]),
  byType(...DATES, STRING(6)))

// The decade stays and the unit is masked.
decompose('PE_ANIO', [[String.raw`(\d{3})(\d)`, keep, DIGITS]], keep, '1985')
domain('PE_L2_ANIO_NACIMIENTO', 'PE_ANIO',
  byName(['a[nñ]o_?(de_?)?nac(imiento)?|anio_?nac(imiento)?|year_?of_?birth|birth_?year|yob', 0.9]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// 37 becomes 3x. From 100 on, 90.
decompose('PE_EDAD', [
  [String.raw`(\d{3,})`, redactAs('90')],
  [String.raw`([1-9])(\d)([.,]\d+)`, keep, DIGITS, keep],
  [String.raw`([1-9])(\d)`, keep, DIGITS],
  [String.raw`(\d)`, DIGITS],
], keep, '37')
domain('PE_L2_EDAD', 'PE_EDAD',
  byName(['edad(_?(actual|a[nñ]os|anios|paciente|afiliado|cliente|al_?(ingreso|diagn[oó]stico|fallecimiento)))?|grupo_?etario|rango_?(de_?)?edad|quinquenio|age(_?(years|group))?', 0.85]),
  byType(NUMBER(0, 6), STRING(0, 6)))

domain('PE_L2_FECHA_EVENTO', 'PE_FECHA_EVENTO',
  byName(['(fecha|fec|fch|f)_?(de_?)?(defunci[oó]n|fallecimiento|muerte|matrimonio|divorcio|ingreso|cese|egreso|alta|baja|retiro|contrataci[oó]n|despido|jubilaci[oó]n|hospitalizaci[oó]n|internamiento|diagn[oó]stico|atenci[oó]n|consulta|parto|captura|detenci[oó]n|sentencia|condena|emisi[oó]n(_?(dni|documento))?|caducidad_?dni|vacunaci[oó]n|cirug[ií]a|accidente|descanso_?m[eé]dico)|fec_?(emi|emision|defuncion|ingreso|cese|baja)|date_?of_?(death|marriage|hire|admission|discharge)', 0.8]),
  byType(...DATES, STRING(6)))

// Each vocabulary replaced within itself: M/F stays M/F.
decompose('PE_SEXO', [
  ['(?i)(femenino|masculino)', apply(lookup('PE_SEXO_FEMENINO_MASCULINO', 'pe-sexo-femenino-masculino.txt', ['Femenino', 'Masculino']))],
  ['(?i)(mujer|hombre)', apply(lookup('PE_SEXO_MUJER_HOMBRE', 'pe-sexo-mujer-hombre.txt', ['Mujer', 'Hombre']))],
  ['(?i)(female|male)', apply(lookup('PE_SEXO_FEMALE_MALE', 'pe-sexo-female-male.txt', ['Female', 'Male']))],
  ['(?i)([fm])', apply(lookup('PE_SEXO_F_M', 'pe-sexo-f-m.txt', ['F', 'M']))],
  ['(?i)([hm])', apply(lookup('PE_SEXO_H_M', 'pe-sexo-h-m.txt', ['H', 'M']))],
  ['([12])', apply(lookup('PE_SEXO_1_2', 'pe-sexo-1-2.txt', ['1', '2']))],
], keep, 'F')
domain('PE_L2_SEXO', 'PE_SEXO',
  byName(['sexo(_?(biol[oó]gico|al_?nacer|paciente|afiliado|cliente))?|(tp|tipo|cod|cd|id)_?sexo|g[eé]nero(?!_?(identidad|autopercibido))|sex|gender(?!_?identity)', 0.85]),
  byList([['pe-detectar-sexo.txt', ['f', 'm', 'h', 'femenino', 'masculino', 'mujer', 'hombre', 'female', 'male'], 0.5]], { reject: 0.5 }))

// ── L2 · Where people live ──────────────────────────────────────────────────
//
// Peru is divided into 25 departamentos, 196 provincias and 1,892 distritos, each with a six-digit
// UBIGEO. The distrito is the smallest unit a database usually keeps, and it is very small: 1,633 of
// the 1,892 had fewer than 20,000 inhabitants in the 2017 census, and hundreds have fewer than a
// thousand. A birth date, a sex and one of those distritos point at a handful of people, so a small
// distrito becomes the nearest one of at least 20,000 in its provincia — in its departamento when
// the provincia has none. Thirty-three provincias are themselves under 20,000 and follow the same
// rule inside their departamento. The 25 departamentos stay.

const distance = (a, b) => {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}
const SMALL_PLACE = 20000
const nearest = (place, candidates) => candidates.reduce((best, x) => (distance(place, x) < distance(place, best) ? x : best))
const nearestIn = (place, large, ...groups) => {
  for (const group of groups) {
    const candidates = large.filter(group)
    if (candidates.length) return nearest(place, candidates)
  }
  return nearest(place, large)
}
const largeDistritos = DISTRITOS.filter((d) => d.population >= SMALL_PLACE)
const largeProvincias = PROVINCIAS.filter((p) => p.population >= SMALL_PLACE)
const spellingsOf = (p) => unique([p.name, ...(p.aliases ?? [])])
// Names that differ only in accents are the same name.
const nameKey = (name) => fold(name).toLowerCase()
// How systems write a name: as it is, in capitals, and without accents. A name that has no accents
// maps to the accented one; only a name whose accents were dropped maps to a name without them.
const spellings = (from, to) => {
  const out = new Map([[from, to], [from.toUpperCase(), to.toUpperCase()]])
  if (!out.has(fold(from))) out.set(fold(from), fold(to))
  if (!out.has(fold(from).toUpperCase())) out.set(fold(from).toUpperCase(), fold(to).toUpperCase())
  return [...out]
}
// Each name as written comes before the capitals and the spellings without accents of the others.
const variants = (pairs) => {
  const all = pairs.map(([from, to]) => spellings(from, to))
  return [...all.map((v) => v[0]), ...all.flatMap((v) => v.slice(1))]
}
// With the provincia or the departamento, as systems write them to tell homonyms apart:
// "Santa Rosa - El Dorado", "San Juan (Cajamarca)".
const SEPARATORS = [[' - ', ''], [', ', ''], [' (', ')'], ['/', ''], ['-', '']]

/**
 * The generalization table. `places` carry name, `small`, `to` — the place they become — and
 * `qualifiers`, the parents systems write beside the name to tell homonyms apart, each with the code
 * that scopes the homonyms. A name shared by several places is generalized only when all of them are
 * small, to the fate of the most populous; written with a qualifier, the same rule applies inside it.
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
      for (const q of p.qualifiers) add(`${nameKey(name)}|${q.code}`, name, p, q)
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
    // The qualifier travels with the name and follows the generalization: a distrito that becomes
    // one of another provincia is written with that provincia, generalized in its turn.
    const target = from.to.outQualifiers.find((q) => q.level === qualifier.level) ?? qualifier
    for (const name of written) for (const [a, b] of SEPARATORS) pairs.push([`${name}${a}${qualifier.name}${b}`, `${from.to.name}${a}${target.name}${b}`])
  }
  const qualified = (p) => spellingsOf(p).flatMap((name) => p.qualifiers.flatMap((q) => SEPARATORS.map(([a, b]) => `${name}${a}${q.name}${b}`)))
  const kept = new Set(variants(places.filter((p) => !p.small).flatMap((p) => [...qualified(p), ...spellingsOf(p)].map((n) => [n, n]))).map(([from]) => from))
  const generalized = new Map()
  const ambiguous = new Set()
  for (const [from, to] of variants(pairs)) {
    if (kept.has(from) || ambiguous.has(from)) continue
    // The same place reached through an alias differs only in accents: first wins.
    if (generalized.has(from) && fold(generalized.get(from)).toUpperCase() === fold(to).toUpperCase()) continue
    if (generalized.has(from) && generalized.get(from) !== to) { generalized.delete(from); ambiguous.add(from); continue }
    generalized.set(from, to)
  }
  return { table: [...generalized], names }
}

const provinciaTo = (p) => nearestIn(p, largeProvincias, (x) => x.departmentCode === p.departmentCode)
const provinciaPlaces = PROVINCIAS.map((p) => ({ ...p, small: p.population < SMALL_PLACE }))
const provinciaByCode = new Map(provinciaPlaces.map((p) => [p.code, p]))
for (const p of provinciaPlaces) p.to = p.small ? provinciaByCode.get(provinciaTo(p).code) : p
for (const p of provinciaPlaces) {
  p.qualifiers = [{ level: 'dep', code: p.departmentCode, name: p.department }]
  p.outQualifiers = p.qualifiers
}

const distritoTo = (d) => nearestIn(d, largeDistritos, (x) => x.provinceCode === d.provinceCode, (x) => x.departmentCode === d.departmentCode)
const distritoPlaces = DISTRITOS.map((d) => ({ ...d, small: d.population < SMALL_PLACE }))
const distritoByCode = new Map(distritoPlaces.map((d) => [d.code, d]))
for (const d of distritoPlaces) d.to = d.small ? distritoByCode.get(distritoTo(d).code) : d
// A distrito is written with its provincia and with its departamento. The key carries the names as
// the source writes them; the replacement carries the provincia generalized in its turn. Where a
// provincia and its departamento share a name — Lima, Junín, Cusco, Ica — the two qualifiers write
// the same string, and the departamento keeps it: that is how systems disambiguate homonyms.
const dedupe = (qualifiers) => qualifiers.filter((q) => q.level === 'dep' || !qualifiers.some((x) => x.level === 'dep' && x.name === q.name))
for (const d of distritoPlaces) {
  const province = provinciaByCode.get(d.provinceCode)
  d.qualifiers = dedupe([{ level: 'prov', code: d.provinceCode, name: province.name }, { level: 'dep', code: d.departmentCode, name: d.department }])
  d.outQualifiers = [{ level: 'prov', name: province.to.name }, { level: 'dep', name: d.department }]
}

const places = generalization([...distritoPlaces, ...provinciaPlaces])
cleansing('PE_DISTRITO', 'pe-distritos-generalizados.txt', places.table, 'Asunción', '|')

// UBIGEO of the Instituto Nacional de Estadística e Informática: two digits for the departamento,
// four for the provincia and six for the distrito. The codes follow the names.
const codePairs = [
  ...distritoPlaces.filter((d) => d.small).map((d) => [d.code, d.to.code]),
  ...provinciaPlaces.filter((p) => p.small).map((p) => [p.code, p.to.code]),
]
cleansing('PE_UBIGEO', 'pe-ubigeo-generalizado.txt', codePairs, '010102', '|')

const PERSONAL_WORDS = new Set([...GIVEN_NAMES, ...SURNAMES].map((w) => fold(w).toLowerCase()))
const DEPARTMENT_NAMES = new Set([...DEPARTMENTS, 'Perú', 'Lima'].map((n) => fold(n).toLowerCase()))
const placeNames = (list) => unique(list.flatMap(spellingsOf))
  .filter((n) => !PERSONAL_WORDS.has(fold(n).toLowerCase()) && !DEPARTMENT_NAMES.has(fold(n).toLowerCase()))

domain('PE_L2_DISTRITO', 'PE_DISTRITO',
  byName(['distrito(?!_?(cod|codigo|id|judicial|electoral|fiscal|escolar|de_?riego))(_?(residencia|nacimiento|domicilio))?|dist(?!_?(cod|codigo|id))|provincia(?!_?(cod|codigo|id))(_?(residencia|nacimiento|domicilio))?|prov(?!_?(cod|codigo|id))|ciudad(_?(residencia|nacimiento|domicilio|cliente))?|(nom|nombre|desc)_?(distrito|provincia|ciudad)|lugar_?(de_?)?nacimiento|city|town', 0.85]),
  byList([['pe-detectar-distritos.txt', placeNames([...DISTRITOS, ...PROVINCIAS]), 0.8]], { reject: 0.4 }))

domain('PE_L2_UBIGEO', 'PE_UBIGEO',
  byName(['ubigeo[a-z0-9_]*|(cod|codigo|cd|id)_?(ubigeo|distrito|dist|provincia|prov|ciudad|lugar)(_?(inei|reniec|res|residencia|nac|nacimiento))?|(cod|codigo)_?(inei|reniec|geogr[aá]fico)|coddist|codprov', 0.85]),
  byPattern([[String.raw`(0[1-9]|1\d|2[0-5])\d{2}(\d{2})?`, 0.4]], { reject: 0.3 }))

// Below the distrito are the centros poblados, caseríos and anexos: a few hundred people each, and
// the address of most rural households.
lookup('PE_ZONA_RURAL', 'pe-zona-rural.txt', ['Zona rural'], 'Caserío El Milagro', 'PRESERVE_LOOKUP_FILE')
domain('PE_L2_CENTRO_POBLADO', 'PE_ZONA_RURAL',
  byName(['centro_?poblado|ccpp|caser[ií]o|anexo(_?rural)?|comunidad_?(campesina|nativa|rural)|comunidad|aldea|paraje|zona_?rural|sector_?rural|hacienda|fundo|parcela(ci[oó]n)?|predio_?rural', 0.85]))

lookup('PE_URBANIZACION', 'pe-urbanizaciones.txt', URBANIZACIONES, 'Urb. Los Rosales', 'PRESERVE_LOOKUP_FILE')
domain('PE_L2_URBANIZACION', 'PE_URBANIZACION',
  byName(['urbanizaci[oó]n|urb|asentamiento_?humano|aa_?hh|pueblo_?joven|asociaci[oó]n_?(de_?)?vivienda|cooperativa_?(de_?)?vivienda|conjunto_?habitacional|residencial|barrio(_?(residencia|domicilio))?|(nom|nombre)_?(urbanizacion|barrio|residencial)|neighbou?rhood', 0.8]))

// Five digits since 2011: the first two are the departamento and the next the postal zone.
decompose('PE_CODIGO_POSTAL', [[String.raw`(\d{2})(\d{3})`, keep, redactAs('000')], [String.raw`(\d{2})(\d{2})`, keep, redactAs('00')]], keep, '15001')
domain('PE_L2_CODIGO_POSTAL', 'PE_CODIGO_POSTAL',
  byName(['c[oó]digo_?postal|cod_?postal|codpostal|zip(_?code)?|postal_?code|cp', 0.85]),
  byType(STRING(4, 5), NUMBER(0, 5)))

const MARITAL = ['Soltero/a', 'Casado/a', 'Conviviente', 'Separado/a', 'Divorciado/a', 'Viudo/a']
categorical('PE_ESTADO_CIVIL', 'pe-estado-civil.txt', MARITAL, 'Unión de hecho', ['1', '2', '3', '4', '5', '6'])
domain('PE_L2_ESTADO_CIVIL', 'PE_ESTADO_CIVIL',
  byName(['estado_?civil|est_?civil|(cod|tipo|id)_?estado_?civil|situaci[oó]n_?conyugal|uni[oó]n_?de_?hecho|marital_?status|civil_?status', 0.85]),
  byList([['pe-detectar-estado-civil.txt', [...MARITAL, 'soltero', 'soltera', 'casado', 'casada', 'conviviente', 'convivencia', 'unión de hecho', 'union de hecho', 'separado', 'separada', 'divorciado', 'divorciada', 'viudo', 'viuda'], 0.7]], { reject: 0.4 }))

lookup('PE_OCUPACION', 'pe-ocupaciones.txt', ['Empleado administrativo', 'Vendedor', 'Cajero', 'Chofer', 'Repartidor', 'Albañil', 'Maestro de obra', 'Docente', 'Enfermero', 'Médico', 'Contador', 'Abogado', 'Ingeniero', 'Programador', 'Recepcionista', 'Personal de limpieza', 'Vigilante', 'Cocinero', 'Mozo', 'Electricista', 'Gasfitero', 'Mecánico', 'Agricultor', 'Jornalero', 'Pescador', 'Operario de producción', 'Asesor de ventas', 'Agente de call center', 'Almacenero', 'Estilista', 'Costurera', 'Comerciante ambulante', 'Ama de casa', 'Estudiante', 'Jubilado', 'Taxista', 'Mototaxista', 'Minero', 'Artesano'], 'Gerente de operaciones')
decompose('PE_OCUPACION_O_CODIGO', [
  // Clasificación Nacional de Ocupaciones: four digits.
  [String.raw`(\d{2,5})`, DIGITS],
], apply('PE_OCUPACION'), 'Gerente de operaciones')
domain('PE_L2_OCUPACION', 'PE_OCUPACION_O_CODIGO',
  byName(
    ['ocupaci[oó]n|profesi[oó]n|oficio|cno|(cod|codigo)_?(ocupacion|profesion|cno)|puesto_?(de_?)?trabajo|categor[ií]a_?ocupacional|cargo_?(actual|empleado)|occupation|profession|job_?title', 0.8],
    ['cargo|puesto', 0.5],
  ))

lookup('PE_EMPLEADOR', 'pe-empleadores.txt', ['Distribuidora Andina S.A.C.', 'Constructora Pacífico S.A.', 'Transportes El Inca S.A.C.', 'Supermercados del Sur S.A.', 'Industrias Metálicas Rímac S.A.C.', 'Clínica Santa Rosa S.A.', 'Colegio Nuevo Amanecer', 'Servicios Integrales del Norte S.A.C.', 'Agroindustrias Valle Verde S.A.', 'Comercial Los Portales E.I.R.L.', 'Soluciones Digitales Perú S.A.C.', 'Restaurante Sabor Criollo E.I.R.L.', 'Hotel Mirador del Misti S.A.C.', 'Laboratorio Vida Sana S.A.C.', 'Seguridad Vigía S.A.C.', 'Textiles La Aguja S.A.C.', 'Repuestos del Oriente E.I.R.L.', 'Botica El Buen Vecino', 'Logística Puerto Callao S.A.C.', 'Cooperativa Agraria Cafetalera La Unión', 'Fundación Manos Unidas', 'Panadería Pan de Casa', 'Estudio Contable Asociados S.A.C.', 'Minera Cerro Verde Andino S.A.'], 'Corporación Comercial Peruana S.A.C.', 'PRESERVE_LOOKUP_FILE')
domain('PE_L2_EMPLEADOR', 'PE_EMPLEADOR',
  byName(['empleador(_?(nombre|raz[oó]n_?social|ruc))?|(nombre|nom)_?(empleador|empresa_?donde_?trabaja|patrono)|empresa_?(donde_?)?(trabaja|labora)|lugar_?(de_?)?trabajo|centro_?(de_?)?(trabajo|labores)|entidad_?empleadora|employer(_?name)?|workplace', 0.9]))

const EDUCATION = ['Sin nivel', 'Inicial', 'Primaria incompleta', 'Primaria completa', 'Secundaria incompleta', 'Secundaria completa', 'Superior técnica incompleta', 'Superior técnica completa', 'Superior universitaria incompleta', 'Superior universitaria completa', 'Maestría o doctorado']
categorical('PE_NIVEL_EDUCATIVO', 'pe-nivel-educativo.txt', EDUCATION, 'Educación superior en curso', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'])
domain('PE_L2_NIVEL_EDUCATIVO', 'PE_NIVEL_EDUCATIVO',
  byName(['escolaridad|nivel_?(educativo|de_?estudios|acad[eé]mico|alcanzado|de_?instrucci[oó]n)|grado_?(de_?)?(estudio|instrucci[oó]n|escolaridad)|m[aá]ximo_?nivel|a[nñ]os_?(de_?)?estudio|education(_?level)?', 0.8]),
  byList([['pe-detectar-nivel-educativo.txt', [...EDUCATION, 'inicial', 'primaria', 'secundaria', 'superior', 'técnica', 'universitaria', 'maestría', 'doctorado', 'sin nivel', 'analfabeto'], 0.6]], { reject: 0.4 }))

lookup('PE_INSTITUCION_EDUCATIVA', 'pe-instituciones-educativas.txt', ['I.E. 1234 Nuestra Señora del Carmen', 'I.E. José Carlos Mariátegui', 'I.E.P. San Agustín', 'Colegio Nacional Mariscal Cáceres', 'Institución Educativa Túpac Amaru', 'Instituto Superior Tecnológico del Norte', 'Universidad Nacional Mayor', 'Universidad Andina del Sur', 'CETPRO Manos Productivas', 'I.E. 0567 Virgen de Fátima', 'Colegio Parroquial San Pedro', 'Escuela Profesional de Enfermería'], 'Universidad Nacional de Ingeniería')
domain('PE_L2_INSTITUCION_EDUCATIVA', 'PE_INSTITUCION_EDUCATIVA',
  byName(['instituci[oó]n_?educativa|i_?e(_?p)?|centro_?(educativo|de_?estudios)|cetpro|(nombre|nom)_?(institucion_?educativa|escuela|colegio|universidad)|escuela|colegio|instituto|universidad|c[oó]digo_?modular|c[oó]digo_?(de_?)?local_?escolar|school(_?name)?|university', 0.75]))

// Capped at 5 as text: large households are rare, and a rare count identifies.
decompose('PE_CONTEO_LIMITADO', [[String.raw`([0-5])`, keep], [String.raw`(\d+)`, redactAs('5')]], keep, '9')
domain('PE_L2_PERSONAS_A_CARGO', 'PE_CONTEO_LIMITADO',
  byName(['personas_?a_?cargo|n(o|ro|um|umero)_?(de_?)?(hijos|dependientes|derechohabientes|personas_?a_?cargo)|cant(idad)?_?(hijos|dependientes|personas_?hogar|miembros)|hijos|dependientes|derechohabientes|personas_?(en_?el_?)?hogar|tama[nñ]o_?(del_?)?hogar|miembros_?(del_?)?hogar|number_?of_?children|dependents', 0.8]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// ── L3 · Sensitive data (art. 2, 5 of Ley 29733) ────────────────────────────
//
// The law's own list is short and blunt: biometric data that identifies on its own, racial and
// ethnic origin, **economic income**, political, religious, philosophical and moral opinions or
// convictions, trade union membership, and information on health or sexual life. Income lives in the
// FIN group below, where the money is; everything else is here, together with the genetic data, the
// gender identity, the indigenous people and language and the victim status that Peruvian law
// protects by other statutes and that re-identify just as fast.

// The 2017 census asked everyone from twelve up how they identify themselves.
const ETHNIC_GROUPS = ['Quechua', 'Aimara', 'Nativo o indígena de la Amazonía', 'Perteneciente a otro pueblo indígena u originario', 'Negro, moreno, zambo, mulato o afroperuano', 'Blanco', 'Mestizo', 'Nikkei', 'Tusán', 'Otro']
categorical('PE_ORIGEN_ETNICO', 'pe-origen-etnico.txt', ETHNIC_GROUPS, 'Indígena', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
domain('PE_L3_ORIGEN_ETNICO', 'PE_ORIGEN_ETNICO',
  byName(['etnia|origen_?([eé]tnico|racial)|grupo_?[eé]tnico|pertenencia_?[eé]tnica|autoidentificaci[oó]n(_?[eé]tnica)?|autorreconocimiento|(cod|codigo|tipo|id)_?(etnia|origen_?etnico)|raza|ind[ií]gena|afroperuano|afrodescendiente|ethnicity|race', 0.95]),
  byList([['pe-detectar-origen-etnico.txt', [...ETHNIC_GROUPS, 'quechua', 'aimara', 'aymara', 'amazónico', 'nativo', 'indígena', 'mestizo', 'blanco', 'negro', 'afroperuano', 'nikkei', 'tusán', 'otro'], 0.9],
    // Belonging is often a yes/no flag or a census code: it backs up the column name but decides nothing alone.
    ['pe-detectar-codigos-banderas.txt', ['s', 'n', 'sí', 'no', '1', '2', '3', '4', '5', '6'], 0.3],
  ], { reject: 0.4 }))

// The Base de Datos Oficial de Pueblos Indígenas u Originarios of the Ministerio de Cultura lists
// fifty-five peoples; the Ley 29785 gives them the right to prior consultation, and naming the
// people a person belongs to is naming their ethnic origin.
const PEOPLES = ['Quechuas', 'Aimara', 'Asháninka', 'Awajún', 'Shipibo-Konibo', 'Shawi', 'Matsigenka', 'Achuar', 'Wampis', 'Kukama Kukamiria', 'Yine', 'Kandozi', 'Harakbut', 'Ticuna', 'Bora', 'Yagua', 'Nomatsigenga', 'Ashaninka del Gran Pajonal', 'Kichwa', 'Uro', 'No pertenece a ningún pueblo']
categorical('PE_PUEBLO_INDIGENA', 'pe-pueblos-indigenas.txt', PEOPLES, 'Pueblo Ese Eja')
domain('PE_L3_PUEBLO_INDIGENA', 'PE_PUEBLO_INDIGENA',
  byName(['pueblo_?(ind[ií]gena|originario)|comunidad_?(nativa|campesina)_?(nombre|pertenencia)|pertenece_?(a_?)?(pueblo|comunidad)|bdpi|base_?de_?datos_?(de_?)?pueblos|etnia_?amaz[oó]nica|indigenous_?people', 0.9]),
  byList([['pe-detectar-pueblos.txt', [...PEOPLES, 'asháninka', 'ashaninka', 'awajún', 'aguaruna', 'shipibo', 'konibo', 'shawi', 'matsigenka', 'machiguenga', 'achuar', 'wampis', 'huambisa', 'kukama', 'yine', 'harakbut', 'ticuna', 'bora', 'yagua', 'kichwa', 'uro'], 0.85]], { reject: 0.4 }))

// Peru has forty-eight indigenous languages beside Spanish; the Ley 29735 makes them official where
// they prevail, and the language a person speaks says where they come from.
const LANGUAGES = ['Castellano', 'Quechua', 'Aimara', 'Asháninka', 'Awajún', 'Shipibo-Konibo', 'Shawi', 'Matsigenka', 'Achuar', 'Wampis', 'Kukama Kukamiria', 'Yine', 'Ticuna', 'Lengua de señas peruana', 'Portugués', 'Inglés', 'Otra lengua extranjera', 'Otra lengua originaria']
categorical('PE_LENGUA', 'pe-lenguas.txt', LANGUAGES, 'Quechua chanka')
domain('PE_L3_LENGUA', 'PE_LENGUA',
  byName(['lengua(_?(ind[ií]gena|materna|nativa|originaria|de_?se[nñ]as))?|idioma(_?(ind[ií]gena|materno|nativo|originario))?|habla_?(lengua|idioma)|lengua_?que_?aprendi[oó]|mother_?tongue|native_?language', 0.9]),
  byList([['pe-detectar-lenguas.txt', [...LANGUAGES, 'quechua', 'aimara', 'aymara', 'castellano', 'español', 'asháninka', 'awajún', 'shipibo', 'lsp', 'lengua de señas'], 0.8]], { reject: 0.4 }))

const NATIONALITIES = ['Peruana', 'Venezolana', 'Colombiana', 'Ecuatoriana', 'Boliviana', 'Chilena', 'Brasileña', 'Argentina', 'Española', 'Estadounidense', 'China', 'Japonesa', 'Haitiana', 'Italiana']
lookup('PE_NACIONALIDAD', 'pe-nacionalidades.txt', NATIONALITIES, 'Panameña')
domain('PE_L3_NACIONALIDAD', 'PE_NACIONALIDAD',
  byName(['nacionalidad|pa[ií]s_?(de_?)?(nacimiento|origen|nacionalidad|procedencia)|ciudadan[ií]a|nationality|citizenship|country_?of_?birth|condici[oó]n_?(de_?)?(migratoria|refugiado)|persona_?refugiada|migrante', 0.85]),
  byList([['pe-detectar-nacionalidades.txt', [...NATIONALITIES, 'peruano', 'peruana', 'venezolano', 'colombiano', 'ecuatoriano', 'boliviano', 'chileno', 'brasileño', 'argentino', 'español', 'estadounidense', 'chino', 'japonés', 'haitiano', 'perú', 'venezuela', 'colombia', 'ecuador', 'bolivia', 'extranjero', 'extranjera'], 0.7]], { reject: 0.4 }))

const RELIGIONS = ['Católica', 'Evangélica', 'Cristiana', 'Adventista', 'Testigo de Jehová', 'Iglesia de Jesucristo de los Santos de los Últimos Días', 'Israelita', 'Judía', 'Musulmana', 'Otra', 'Ninguna']
categorical('PE_RELIGION', 'pe-religiones.txt', RELIGIONS, 'Ortodoxa')
domain('PE_L3_RELIGION', 'PE_RELIGION',
  byName(['religi[oó]n|creencia_?(religiosa|espiritual)|convicci[oó]n_?(religiosa|espiritual)|credo|confesi[oó]n_?religiosa|culto|iglesia(_?(a_?la_?que_?pertenece|nombre))?|denominaci[oó]n_?religiosa|(cod|codigo|tipo)_?religion|religion|church', 0.95]),
  byList([['pe-detectar-religiones.txt', [...RELIGIONS, 'católico', 'catolico', 'cristiano', 'cristiana', 'evangélico', 'adventista', 'testigo de jehová', 'mormón', 'israelita', 'judío', 'musulmán', 'ateo', 'agnóstico', 'ninguna', 'ninguno'], 0.9]], { reject: 0.4 }))

// The law names the moral and philosophical convictions in the same breath as the religious ones.
domain('PE_L3_CONVICCION_FILOSOFICA', 'PE_CATEGORIA_SUPRIMIDA',
  byName(['convicci[oó]n(es)?_?(filos[oó]ficas?|morales?|espirituales?|personales?)|creencias?_?(filos[oó]ficas?|morales?|personales?)|opini[oó]n_?(filos[oó]fica|moral)|objeci[oó]n_?(de_?)?conciencia|objetor_?(de_?)?conciencia|logia|masoner[ií]a|beliefs?|philosophical_?beliefs?', 0.9]))

const IDEOLOGIES = ['Izquierda', 'Centroizquierda', 'Centro', 'Centroderecha', 'Derecha', 'Independiente', 'Prefiere no responder']
categorical('PE_IDEOLOGIA_POLITICA', 'pe-ideologias-politicas.txt', IDEOLOGIES, 'Oficialista')
domain('PE_L3_OPINION_POLITICA', 'PE_IDEOLOGIA_POLITICA',
  byName(['ideolog[ií]a(_?pol[ií]tica)?|opini[oó]n_?pol[ií]tica|orientaci[oó]n_?pol[ií]tica|tendencia_?pol[ií]tica|preferencia_?(pol[ií]tica|partidaria|electoral)|intenci[oó]n_?(de_?)?voto|simpat[ií]a_?pol[ií]tica|political_?(opinion|orientation|view)|voting_?intention', 0.9]),
  byList([['pe-detectar-ideologias-politicas.txt', [...IDEOLOGIES, 'izquierda', 'derecha', 'centro', 'progresista', 'conservador', 'independiente', 'indeciso', 'voto viciado', 'ninguno'], 0.7]], { reject: 0.4 }))

// Party membership: the parties on the Registro de Organizaciones Políticas of the JNE.
const PARTIES = ['Fuerza Popular', 'Perú Libre', 'Acción Popular', 'Alianza para el Progreso', 'Renovación Popular', 'Avanza País', 'Podemos Perú', 'Somos Perú', 'Partido Aprista Peruano', 'Partido Morado', 'Juntos por el Perú', 'Partido Popular Cristiano', 'Sin afiliación']
categorical('PE_PARTIDO', 'pe-partidos.txt', PARTIES, 'Frente Amplio')
domain('PE_L3_AFILIACION_PARTIDARIA', 'PE_PARTIDO',
  byName(['partido(_?pol[ií]tico)?(_?(afiliaci[oó]n|nombre))?|organizaci[oó]n_?pol[ií]tica|afiliaci[oó]n_?(pol[ií]tica|partidaria|partido)|afiliado_?partido|militancia(_?pol[ií]tica)?|militante|(cod|codigo|nombre|nom)_?partido|political_?party|party_?membership', 0.95]),
  byList([['pe-detectar-partidos.txt', [...PARTIES, 'APRA', 'PPC', 'AP', 'APP', 'Fuerza Popular', 'Perú Libre', 'Podemos', 'Somos Perú', 'Renovación Popular'], 0.8]], { reject: 0.4 }))

domain('PE_L3_AFILIACION_SINDICAL', 'PE_CATEGORIA_SUPRIMIDA',
  byName(['sindicato(_?(nombre|afiliado|afiliaci[oó]n|codigo))?|sindicalizado|afiliado_?sindicato|afiliaci[oó]n_?sindical|cuota_?sindical|descuento_?sindical|aporte_?sindical|asociaci[oó]n_?sindical|convenio_?colectivo|fuero_?sindical|dirigente_?sindical|trade_?union|union_?member(ship)?', 0.95]),
  byList([['pe-detectar-sindicatos.txt', ['CGTP', 'CUT Perú', 'CTP', 'CATP', 'SUTEP', 'FENTAP', 'SITRAMUN', 'Sindicato Unitario', 'Federación de Trabajadores', 'sindicalizado', 'afiliado'], 0.6]], { reject: 0.3 }))

// Art. 2, 5 makes sensitive the biometric data that identifies on its own — the template, not the
// photograph of a face in a file the algorithms cannot reach.
domain('PE_L3_BIOMETRICO', 'PE_REDACTAR',
  byName(['biometr[ií]a[a-z_]*|biom[eé]trico[a-z_]*|huella(_?(dactilar|digital))?(_?(template|plantilla|imagen|hash))?|huellas|dactilar|template_?(facial|huella|biometrico)|plantilla_?(facial|biom[eé]trica)|rostro_?(hash|template)|reconocimiento_?facial|firma_?(biom[eé]trica|digitalizada|electr[oó]nica)|iris|voz_?(biom[eé]trica|template)|fingerprints?|face_?(template|hash|encoding)|biometric[a-z_]*', 0.9]),
  byType(STRING()))

domain('PE_L3_GENETICO', 'PE_REDACTAR',
  byName(['adn|dna|gen[eé]tic[oa]s?|datos?_?gen[eé]ticos?|genoma|genotip[a-z_]*|prueba_?(gen[eé]tica|de_?adn|de_?paternidad|de_?filiaci[oó]n)|perfil_?gen[eé]tico|mutaci[oó]n|brca[12]?|cariotipo|tamizaje_?neonatal|genetic[a-z_]*', 0.9]))

const ORIENTATIONS = ['Heterosexual', 'Gay', 'Lesbiana', 'Bisexual', 'Pansexual', 'Asexual', 'Otra', 'Prefiere no responder']
categorical('PE_ORIENTACION_SEXUAL', 'pe-orientaciones-sexuales.txt', ORIENTATIONS, 'Homosexual')
domain('PE_L3_ORIENTACION_SEXUAL', 'PE_ORIENTACION_SEXUAL',
  byName(['orientaci[oó]n_?sexual|preferencias?_?sexuales?|(cod|codigo|tipo)_?orientacion_?sexual|sexual_?orientation', 0.95]),
  byList([['pe-detectar-orientaciones-sexuales.txt', [...ORIENTATIONS, 'hetero', 'homosexual', 'lgbti', 'lgbtiq+', 'queer'], 0.8]], { reject: 0.4 }))

domain('PE_L3_VIDA_SEXUAL', 'PE_CATEGORIA_SUPRIMIDA',
  byName(['vida_?sexual|actividad_?sexual|conducta_?sexual|pr[aá]cticas?_?sexuales?|parejas?_?sexuales?|n(o|ro|um|umero)_?parejas|sexualmente_?activ[oa]|inicio_?(de_?)?(la_?)?vida_?sexual|relaciones_?sexuales|sex(ual)?_?life|sexual_?(activity|behavio(u)?r|partners)', 0.9]))

const IDENTITIES = ['Mujer cisgénero', 'Hombre cisgénero', 'Mujer trans', 'Hombre trans', 'Persona no binaria', 'Otra', 'Prefiere no responder']
categorical('PE_IDENTIDAD_GENERO', 'pe-identidades-genero.txt', IDENTITIES, 'Transgénero')
domain('PE_L3_IDENTIDAD_GENERO', 'PE_IDENTIDAD_GENERO',
  byName(['identidad_?(de_?)?g[eé]nero|(cod|codigo|tipo)_?identidad_?genero|g[eé]nero_?(autopercibido|identitario)|expresi[oó]n_?de_?g[eé]nero|transg[eé]nero|persona_?trans|nombre_?social|pronombres?|gender_?identity', 0.95]),
  byList([['pe-detectar-identidades-genero.txt', [...IDENTITIES, 'cisgénero', 'cis', 'transgénero', 'trans', 'no binario', 'no binaria', 'mujer', 'hombre'], 0.7]], { reject: 0.4 }))

// The Registro Único de Víctimas of the Ley 28592 records the people harmed by the violence of 1980
// to 2000, and the Ley 30364 protects the identity of the victims of violence against women and the
// members of the family group. Both lists are kept apart from the rest by law.
domain('PE_L3_VICTIMA', 'PE_CATEGORIA_SUPRIMIDA',
  byName(['v[ií]ctima(_?(de_?)?(violencia(_?(de_?g[eé]nero|familiar|sexual|econ[oó]mica|psicol[oó]gica))?|delito|trata|desplazamiento|terrorismo|abuso))?|ruv|registro_?[uú]nico_?(de_?)?v[ií]ctimas|violencia_?(de_?)?g[eé]nero|violencia_?(familiar|dom[eé]stica|sexual|psicol[oó]gica)|tipo_?(de_?)?violencia|medida_?(de_?)?protecci[oó]n|ficha_?de_?valoraci[oó]n_?(de_?)?riesgo|desplazamiento_?forzado|trata_?(de_?)?personas|denunciante_?violencia|cem', 0.9]))

// ── SALUD · Health data (art. 2, 5) ─────────────────────────────────────────
//
// "Información relacionada a la salud" is sensitive without qualification, and the Ley 26842
// General de Salud and the Ley 30024 of the Registro Nacional de Historias Clínicas Electrónicas
// bind the clinical record to medical secrecy on top of that.

domain('PE_SALUD_IDENTIFICADOR', 'PE_CM_ALFANUM',
  byName(
    ['n(o|ro|um|umero)_?(historia(_?cl[ií]nica)?|hc|hce|expediente(_?cl[ií]nico)?|ingreso|atenci[oó]n|consulta|cita|referencia_?m[eé]dica|receta|fua)|historia_?cl[ií]nica|hc_?(n(o|ro|um|umero))?|hce|renhice|n(o|ro|um|umero)_?(asegurado|afiliado_?(sis|essalud))|c[oó]digo_?(paciente|historia|atenci[oó]n)|id_?paciente', 0.85],
    ['expediente|atenci[oó]n|ingreso|consulta', 0.55],
  ))

const COVERAGE = ['EsSalud', 'SIS (Seguro Integral de Salud)', 'EPS', 'Sanidad de las Fuerzas Armadas', 'Sanidad de la Policía Nacional', 'Seguro privado de salud', 'Seguro escolar privado', 'Sin seguro']
decompose('PE_COBERTURA_SALUD', [
  [FLAG, apply('PE_BANDERA')],
  [String.raw`(\d{1,8})`, DIGITS],
], apply(lookup('PE_COBERTURA', 'pe-cobertura-salud.txt', COVERAGE, undefined, 'PRESERVE_LOOKUP_FILE')), 'EsSalud')
domain('PE_SALUD_COBERTURA', 'PE_COBERTURA_SALUD',
  byName(['cobertura(_?(m[eé]dica|de_?salud|social))?|seguro_?(m[eé]dico|salud|integral)|r[eé]gimen(_?(de_?)?salud)?|tipo_?(de_?)?seguro|proveedor_?(de_?)?salud|essalud(_?(afiliado|cobertura))?|sis(_?(afiliado|tipo))?|eps|iafas|sanidad_?(pnp|ffaa|militar|policial)|aseguradora_?(m[eé]dica|salud)|plan_?(m[eé]dico|de_?salud)', 0.85]),
  byList([['pe-detectar-cobertura.txt', [...COVERAGE, 'essalud', 'sis', 'eps', 'sanidad', 'privado', 'sin seguro', 'seguro integral de salud'], 0.8]], { reject: 0.4 }))

const ICD10 = ['I10', 'E11', 'E78', 'J45', 'J06', 'J02', 'J20', 'K29', 'K21', 'K59', 'M54', 'M17', 'M25', 'N39', 'N20', 'R51', 'R10', 'H10', 'H66', 'L23', 'L30', 'B34', 'A09', 'E03', 'E66', 'D50', 'I83', 'K80', 'K40', 'S93', 'S60', 'Z00', 'J30', 'J32', 'G43', 'M79', 'R05']
const ICD10_DECIMAL = ['E11.9', 'E78.5', 'J45.9', 'J06.9', 'J02.9', 'J20.9', 'K29.7', 'K21.9', 'K59.0', 'M54.5', 'M17.9', 'N39.0', 'N20.0', 'R10.4', 'H10.9', 'H66.9', 'L23.9', 'L30.9', 'B34.9', 'A09.9', 'E03.9', 'E66.9', 'D50.9', 'I83.9', 'K80.2', 'K40.9', 'S93.4', 'S60.0', 'Z00.0', 'J30.4', 'J32.9', 'G43.9', 'M79.1']
decompose('PE_DIAGNOSTICO', [
  [String.raw`([A-TV-Za-tv-z]\d{2}\.\d{1,2})`, apply(lookup('PE_CIE10_DECIMAL', 'pe-cie10-decimal.txt', ICD10_DECIMAL, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [String.raw`([A-TV-Za-tv-z]\d{2,3}X?)`, apply(lookup('PE_CIE10', 'pe-cie10.txt', ICD10, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [FLAG, apply('PE_BANDERA')],
], apply(lookup('PE_DIAGNOSTICO_TEXTO', 'pe-diagnosticos.txt', ['Hipertensión arterial', 'Diabetes mellitus tipo 2', 'Asma', 'Lumbalgia', 'Gastritis crónica', 'Faringitis aguda', 'Infección del tracto urinario', 'Migraña', 'Hipotiroidismo', 'Dislipidemia', 'Obesidad', 'Artrosis de rodilla', 'Bronquitis aguda', 'Amigdalitis aguda', 'Dermatitis de contacto', 'Otitis media aguda', 'Esguince de tobillo', 'Conjuntivitis', 'Anemia ferropénica', 'Enfermedad por reflujo gastroesofágico', 'Síndrome de intestino irritable', 'Tendinitis', 'Sinusitis aguda', 'Cefalea tensional', 'Várices', 'Hernia inguinal', 'Litiasis renal', 'Colelitiasis', 'Gastroenteritis aguda', 'Control de salud'])), 'F33.1')
domain('PE_SALUD_DIAGNOSTICO', 'PE_DIAGNOSTICO',
  byName(['diagn[oó]stico[a-z_]*|dx(_?(principal|secundario|ingreso|egreso)[0-9]?)?|cie_?10|cie(_?(10|11|principal))?|(cod|codigo)_?(diagnostico|dx|cie)|impresi[oó]n_?diagn[oó]stica|enfermedad(es)?[a-z_]*|patolog[ií]a|comorbilidad(es)?|antecedentes?_?(m[eé]dicos|patol[oó]gicos|cl[ií]nicos|personales)|causa_?(de_?)?(muerte|defunci[oó]n|incapacidad|hospitalizaci[oó]n|consulta)|motivo_?(de_?)?(consulta|descanso|hospitalizaci[oó]n)|alergias?|diagnos(is|es)|icd_?(10|11)?', 0.85]),
  // 0.5: codes shaped like ICD-10 appear in other catalogs too; the name has to agree.
  byPattern([[String.raw`[A-TV-Za-tv-z]\d{2}(\.\d{1,2}|\d|X)?`, 0.5]], { reject: 0.3 }))

decompose('PE_PROCEDIMIENTO', [[String.raw`(\d{4,6})`, DIGITS]], apply(lookup('PE_PROCEDIMIENTO_TEXTO', 'pe-procedimientos.txt', ['Consulta médica general', 'Consulta de emergencia', 'Hemograma completo', 'Glucosa en sangre', 'Examen completo de orina', 'Creatinina', 'Radiografía de tórax', 'Ecografía abdominal', 'Electrocardiograma', 'Control prenatal'])), 'Prueba de carga viral para VIH')
domain('PE_SALUD_PROCEDIMIENTO', 'PE_PROCEDIMIENTO',
  byName(['procedimiento(_?(m[eé]dico|quir[uú]rgico|realizado|autorizado))?|(cod|codigo)_?(procedimiento|prestaci[oó]n|servicio_?salud|cpt)|cpt|prestaci[oó]n_?(m[eé]dica|de_?salud)|examen_?(ordenado|realizado)|cirug[ií]a(_?realizada)?|intervenci[oó]n_?quir[uú]rgica|medical_?procedure', 0.85]))

const MEDICATIONS = ['Paracetamol', 'Ibuprofeno', 'Diclofenaco', 'Metformina', 'Glibenclamida', 'Losartán', 'Enalapril', 'Amlodipino', 'Atorvastatina', 'Omeprazol', 'Levotiroxina', 'Amoxicilina', 'Cefalexina', 'Salbutamol', 'Loratadina', 'Hidroclorotiazida', 'Ácido acetilsalicílico', 'Prednisona', 'Azitromicina', 'Sulfato ferroso', 'Ácido fólico', 'Complejo B']
categorical('PE_MEDICAMENTO', 'pe-medicamentos.txt', MEDICATIONS, 'Sertralina 50 mg')
domain('PE_SALUD_MEDICAMENTO', 'PE_MEDICAMENTO',
  byName(['medicamentos?(_?(recetado|prescrito|entregado|despachado|nombre|uso))?|f[aá]rmacos?|principio_?activo|denominaci[oó]n_?com[uú]n_?internacional|dci|receta(_?m[eé]dica)?|prescripci[oó]n(_?medicamento)?|posolog[ií]a|tratamiento_?farmacol[oó]gico|(cod|codigo)_?medicamento|petitorio_?(nacional_?)?[uú]nico|medications?|drugs?_?prescribed', 0.85]),
  byList([['pe-detectar-medicamentos.txt', [...MEDICATIONS, 'paracetamol', 'sertralina', 'fluoxetina', 'escitalopram', 'quetiapina', 'clonazepam', 'alprazolam', 'lorazepam', 'litio', 'metilfenidato', 'risperidona', 'olanzapina', 'haloperidol', 'tenofovir', 'emtricitabina', 'dolutegravir', 'efavirenz', 'insulina', 'warfarina', 'levetiracetam', 'ácido valproico', 'misoprostol', 'levonorgestrel', 'anticonceptivo'], 0.7]], { reject: 0.3 }))

domain('PE_SALUD_TEXTO_CLINICO', 'PE_TEXTO_LIBRE',
  byName(['anamnesis|evoluci[oó]n(_?(m[eé]dica|cl[ií]nica|enfermer[ií]a))?|enfermedad_?actual|examen_?f[ií]sico|plan_?(de_?)?(manejo|tratamiento)|indicaciones_?m[eé]dicas|conducta(_?m[eé]dica)?|epicrisis|resumen_?(de_?)?(alta|egreso|atenci[oó]n)|nota_?(m[eé]dica|de_?enfermer[ií]a|cl[ií]nica)|notas?_?(m[eé]dicas|cl[ií]nicas)|triaje(_?texto)?|informe_?(patolog[ií]a|radiolog[ií]a|m[eé]dico)|clinical_?notes?|discharge_?summary', 0.85]),
  byType(STRING(30)))

domain('PE_SALUD_RESULTADO_EXAMEN', 'PE_CM_ALFANUM',
  byName(
    ['resultado_?(del_?)?(examen|prueba|laboratorio|pcr|serolog[ií]a|biopsia|glucosa|citolog[ií]a|papanicolaou)|(examen|prueba)_?(resultado|laboratorio)|glucemia|hemoglobina(_?glicosilada)?|hba1c|colesterol|imc|presi[oó]n_?arterial|prueba_?(de_?)?embarazo|toxicol[oó]gico|dosaje_?et[ií]lico|alcoholemia|lab_?results?|test_?results?', 0.8],
    ['resultado|prueba', 0.5],
  ))

// The Ley 26626 (CONTRASIDA) orders that the result of an HIV test be confidential and forbids
// demanding it to get or keep a job.
domain('PE_SALUD_VIH', 'PE_CATEGORIA_SUPRIMIDA',
  byName(['vih(_?(estado|resultado|prueba|diagn[oó]stico|positivo))?|hiv|sida|aids|serolog[ií]a_?(vih|hiv)|estado_?serol[oó]gico|carga_?viral|cd4|targa|tarv|antirretroviral(es)?|its|ets|infecci[oó]n(es)?_?(de_?)?transmisi[oó]n_?sexual|s[ií]filis|hepatitis_?[bc]|tuberculosis|tbc', 0.9]))

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']
lookup('PE_GRUPO_SANGUINEO', 'pe-grupos-sanguineos.txt', BLOOD_GROUPS, 'O+', 'PRESERVE_LOOKUP_FILE')
domain('PE_SALUD_GRUPO_SANGUINEO', 'PE_GRUPO_SANGUINEO',
  byName(['grupo_?sangu[ií]neo|tipo_?(de_?)?sangre|rh|factor_?rh|gs_?rh|grupo_?rh|abo(_?rh)?|blood_?(type|group)', 0.9]),
  byList([['pe-detectar-grupos-sanguineos.txt', [...BLOOD_GROUPS, '0+', '0-', 'a positivo', 'a negativo', 'b positivo', 'b negativo', 'ab positivo', 'ab negativo', 'o positivo', 'o negativo'], 0.9]], { reject: 0.4 }))

const DISABILITIES = ['Física o motora', 'Auditiva', 'Visual', 'Sordoceguera', 'Intelectual', 'Mental o psicosocial', 'Múltiple', 'Ninguna']
categorical('PE_DISCAPACIDAD', 'pe-discapacidades.txt', DISABILITIES, 'Trastorno del espectro autista')
domain('PE_SALUD_DISCAPACIDAD', 'PE_DISCAPACIDAD',
  byName(['discapacidad[a-z_]*|(tipo|cod|codigo|categoria)_?discapacidad|persona_?con_?discapacidad|pcd|conadis|carn[eé]_?(de_?)?(conadis|discapacidad)|certificado_?(de_?)?discapacidad|condici[oó]n_?(de_?)?discapacidad|necesidades_?(educativas_?)?especiales|movilidad_?reducida|disabilit(y|ies)', 0.9]),
  byList([['pe-detectar-discapacidades.txt', [...DISABILITIES, 'física', 'motora', 'auditiva', 'sordera', 'visual', 'ceguera', 'intelectual', 'cognitiva', 'psicosocial', 'mental', 'múltiple', 'autismo', 'ninguna', 'no aplica'], 0.6]], { reject: 0.3 }))

categorical('PE_APTITUD_LABORAL', 'pe-aptitud-laboral.txt', ['Apto', 'Apto con restricciones', 'No apto', 'Pendiente'], 'No apto temporalmente')
domain('PE_SALUD_OCUPACIONAL', 'PE_APTITUD_LABORAL',
  byName(['aptitud_?(laboral|m[eé]dica)|concepto_?(de_?)?aptitud|examen_?(m[eé]dico_?)?(ocupacional|preocupacional|de_?ingreso|de_?retiro|peri[oó]dico)|emo|accidente_?(de_?)?trabajo|enfermedad_?(laboral|profesional|ocupacional)|riesgo_?(profesional|laboral)|sctr|incapacidad(_?(m[eé]dica|laboral|d[ií]as))?|descanso_?m[eé]dico|d[ií]as_?(de_?)?(incapacidad|descanso)|licencia_?(m[eé]dica|por_?enfermedad|de_?maternidad)|ausentismo|comit[eé]_?(de_?)?seguridad', 0.85]),
  byList([['pe-detectar-aptitud-laboral.txt', ['apto', 'no apto', 'apto con restricciones', 'pendiente', 'apto con recomendaciones'], 0.6]], { reject: 0.3 }))

domain('PE_SALUD_REPRODUCTIVA', 'PE_CATEGORIA_SUPRIMIDA',
  byName(['embarazo|embarazada|gestante|gestaci[oó]n|edad_?gestacional|semanas_?(de_?)?gestaci[oó]n|fum|fecha_?[uú]ltima_?(regla|menstruaci[oó]n)|control_?prenatal|prenatal|parto(_?tipo)?|ces[aá]rea|aborto|m[eé]todo_?(de_?)?planificaci[oó]n|planificaci[oó]n_?familiar|anticoncepci[oó]n|anticonceptivo|fertilidad|salud_?(sexual|reproductiva)|pregnan(t|cy)|contracepti(on|ve)', 0.9]))

domain('PE_SALUD_MENTAL', 'PE_CATEGORIA_SUPRIMIDA',
  byName(['salud_?mental|trastorno[a-z_]*|psiqui[aá]tri[a-z_]*|psicol[oó]gi[a-z_]*|depresi[oó]n|ansiedad|suicid[a-z_]*|intento_?(de_?)?suicidio|autolesi[oó]n|consumo_?(de_?)?(sustancias|alcohol|drogas)|adicci[oó]n(es)?|alcoholismo|tabaquismo|mental_?health', 0.9]))

// ── FIN · Financial and socioeconomic data ──────────────────────────────────
//
// Art. 2, 5 counts **ingresos económicos** among the sensitive data, which is unusual: a salary
// column in Peru carries the same weight as a diagnosis. The rest of the group — debt, assets,
// pensions, credit history — is not sensitive by that article, but it identifies and the Ley 27489
// on risk bureaus governs it.

// The minimum wage was 1,130 soles a month from January 2025.
algorithm('PE_INGRESOS', 'characterMapping.NumericMapping', { minValue: 1025, maxValue: 25000 }, '2800')
domain('PE_FIN_INGRESOS', 'PE_INGRESOS',
  byName(['sueldo(_?(b[aá]sico|mensual|bruto|neto))?|salario(_?(b[aá]sico|mensual|bruto|neto))?|remuneraci[oó]n(_?(b[aá]sica|mensual|computable))?|ingresos?(_?(mensuales?|totales?|familiares?|declarados?|netos?|econ[oó]micos?))?|haberes|honorarios|renta(_?(bruta|neta|mensual|anual|de_?(primera|segunda|tercera|cuarta|quinta)_?categor[ií]a))?|ingreso_?(base|familiar|percapita)|salary|income|wages?', 0.9]),
  byType(NUMBER()))

decompose('PE_HISTORIAL_CREDITICIO', [
  [String.raw`(\d{1,4})`, DIGITS],
  [FLAG, apply('PE_BANDERA')],
], apply(lookup('PE_ESTADO_CREDITO', 'pe-estados-credito.txt', ['Normal', 'Con problema potencial', 'Deficiente', 'Dudoso', 'Pérdida', 'Al día', 'Reportado en central de riesgo', 'En cobranza judicial', 'Refinanciado', 'Castigado', 'Sin historial crediticio'])), 'Reportado en la central de riesgo')
domain('PE_FIN_HISTORIAL_CREDITICIO', 'PE_HISTORIAL_CREDITICIO',
  byName(['historial_?(crediticio|de_?cr[eé]dito)|central_?(de_?)?riesgo|infocorp|sentinel|equifax|experian|xchange|score(_?(crediticio|interno))?|puntaje_?(de_?)?cr[eé]dito|clasificaci[oó]n_?(sbs|crediticia|del_?deudor)|calificaci[oó]n_?(de_?)?(riesgo|cr[eé]dito|cartera)|categor[ií]a_?(de_?)?riesgo|d[ií]as_?(de_?)?(mora|atraso)|estado_?(de_?)?(cr[eé]dito|cartera|obligaci[oó]n)|morosidad|moroso|cobranza_?judicial|credit_?score|credit_?rating', 0.9]))

algorithm('PE_VALOR_DEUDA', 'characterMapping.NumericMapping', { minValue: 100, maxValue: 500000 }, '18400')
domain('PE_FIN_DEUDA', 'PE_VALOR_DEUDA',
  byName(['saldo_?(deuda|cr[eé]dito|capital|obligaci[oó]n|cartera|en_?mora|adeudado)|monto_?(de_?la_?)?(deuda|cuota|obligaci[oó]n|cr[eé]dito|pr[eé]stamo|mora|desembolsado)|deuda(_?total)?|l[ií]mite_?(de_?)?(cr[eé]dito|tarjeta)|l[ií]nea_?(de_?)?cr[eé]dito|cuota_?mensual|loan_?(amount|balance)|outstanding_?balance|debt', 0.85]),
  byType(NUMBER()))

algorithm('PE_PATRIMONIO', 'characterMapping.NumericMapping', { minValue: 1000, maxValue: 900000 }, '148000')
domain('PE_FIN_PATRIMONIO', 'PE_PATRIMONIO',
  byName(['patrimonio(_?(neto|l[ií]quido))?|activos?_?(totales?)?|valor_?(del_?)?(inmueble|predio|veh[ií]culo|bienes|aval[uú]o|comercial)|autoval[uú]o|aval[uú]o|saldo_?(cuenta|ahorro|dep[oó]sito|inversi[oó]n|cts|fondo)|dep[oó]sito_?a_?plazo|inversiones|declaraci[oó]n_?jurada_?(de_?)?(bienes|ingresos)|net_?worth|account_?balance', 0.85]),
  byType(NUMBER()))

algorithm('PE_VALOR_PENSION', 'characterMapping.NumericMapping', { minValue: 300, maxValue: 8000 }, '1050')
domain('PE_FIN_PENSION', 'PE_VALOR_PENSION',
  byName(['pensi[oó]n(_?(monto|mensual|valor))?|monto_?(pensi[oó]n|jubilaci[oó]n|beneficio|subsidio)|valor_?(pensi[oó]n|subsidio|beneficio)|haber_?(pensionable|jubilatorio)|pensi[oó]n_?(de_?)?alimentos|cuota_?alimentaria|pension_?amount', 0.9]),
  byType(NUMBER()))

const PROGRAMMES = ['Juntos', 'Pensión 65', 'Contigo', 'Cuna Más', 'Qali Warma', 'Beca 18', 'Trabaja Perú', 'FISE (vale de descuento de gas)', 'Techo Propio', 'Ninguno']
categorical('PE_PROGRAMA_SOCIAL', 'pe-programas-sociales.txt', PROGRAMMES, 'Bono Yanapay')
domain('PE_FIN_PROGRAMA_SOCIAL', 'PE_PROGRAMA_SOCIAL',
  byName(['programa_?social|beneficiario_?(programa|subsidio|bono|pensi[oó]n_?65)|juntos|pensi[oó]n_?65|cuna_?m[aá]s|qali_?warma|beca_?18|contigo|trabaja_?per[uú]|fise|techo_?propio|bono(_?(familiar|universal|yanapay|demogr[aá]fico))?|subsidio(_?(gas|energ[ií]a|transporte|tipo))?|transferencia_?monetaria|ayuda_?(social|estatal)|social_?programme', 0.9]),
  byList([['pe-detectar-programas-sociales.txt', [...PROGRAMMES, 'juntos', 'pensión 65', 'contigo', 'cuna más', 'qali warma', 'beca 18', 'fise', 'techo propio', 'ninguno'], 0.8],
    ['pe-detectar-codigos-banderas.txt', ['s', 'n', 'sí', 'no', '1', '2', '3', '4', '5', '6'], 0.3],
  ], { reject: 0.4 }))

// The SISFOH classifies every household as extremely poor, poor or not poor, and the classification
// is the reason a household gets a subsidy: it is as revealing as an income figure.
const SOCIOECONOMIC = ['Pobre extremo', 'Pobre', 'No pobre', 'Sin clasificación']
categorical('PE_CLASIFICACION_SOCIOECONOMICA', 'pe-clasificacion-socioeconomica.txt', SOCIOECONOMIC, 'Pobre extremo', ['1', '2', '3', '4'])
domain('PE_FIN_CLASIFICACION_SOCIOECONOMICA', 'PE_CLASIFICACION_SOCIOECONOMICA',
  byName(['clasificaci[oó]n_?socioecon[oó]mica|csc|sisfoh|padr[oó]n_?general_?(de_?)?hogares|nivel_?socioecon[oó]mico|nse|condici[oó]n_?(de_?)?pobreza|pobreza|quintil(_?(de_?)?(ingreso|riqueza))?|estrato_?socioecon[oó]mico', 0.9]),
  byList([['pe-detectar-clasificacion-socioeconomica.txt', [...SOCIOECONOMIC, 'pobre', 'pobre extremo', 'no pobre', 'a', 'b', 'c', 'd', 'e'], 0.6]], { reject: 0.4 }))

const TENURES = ['Propia totalmente pagada', 'Propia pagándola a plazos', 'Alquilada', 'Cedida por el centro de trabajo u otro hogar', 'Propia por invasión', 'Otra']
categorical('PE_TENENCIA_VIVIENDA', 'pe-tenencia-vivienda.txt', TENURES, 'Ocupación de hecho')
domain('PE_FIN_VIVIENDA', 'PE_TENENCIA_VIVIENDA',
  byName(['tenencia_?(de_?)?(la_?)?vivienda|tipo_?(de_?)?tenencia|vivienda_?(propia|alquilada|tipo_?tenencia)|condici[oó]n_?(de_?)?(la_?)?vivienda|ocupaci[oó]n_?vivienda|housing_?tenure', 0.9]),
  byList([['pe-detectar-tenencia-vivienda.txt', [...TENURES, 'propia', 'alquilada', 'alquiler', 'prestada', 'cedida', 'invasión', 'guardianía'], 0.6]], { reject: 0.3 }))

// ── PENAL · Criminal records and proceedings ────────────────────────────────

categorical('PE_ANTECEDENTES', 'pe-antecedentes.txt', ['No registra antecedentes penales', 'Registra antecedentes', 'Procesado', 'Sentenciado', 'Absuelto', 'Sobreseído', 'Sin información'], 'Sentenciado por hurto en 2019')
domain('PE_PENAL_ANTECEDENTES', 'PE_ANTECEDENTES',
  byName(
    ['antecedentes?(_?(penales|policiales|judiciales))?|certificado_?(de_?)?antecedentes|record_?policial|reincidencia|condena(_?(penal|tipo))?|delito(_?(tipo|cometido))?|tipo_?(de_?)?delito|situaci[oó]n_?jur[ií]dica|requisitoria|orden_?(de_?)?captura|privad[oa]_?(de_?)?libertad|interno_?(penal|penitenciario)|inpe|reo|deudor_?alimentario_?moroso|redam|criminal_?record', 0.95],
    ['estado_?(del_?)?proceso|sentencia|fallo', 0.55],
  ))

// Court and prosecution files: the Poder Judicial numbers a case with the correlative, the year, the
// judicial district and the specialty; the Ministerio Público numbers its case files its own way.
decompose('PE_EXPEDIENTE_JUDICIAL', [
  [String.raw`(\d{4,6})(-)(\d{4})(-)(\d)(-)(\d{4})(-)([A-Za-z\-]{2,12})(-)(\d{2})`, DIGITS, keep, keep, keep, keep, keep, keep, keep, keep, keep, DIGITS],
  [String.raw`(\d{1,6})([\s\-/])([A-Za-z]{2,10})([\s\-/])(\d{4})`, DIGITS, keep, keep, keep, keep],
  [String.raw`([A-Za-z]{1,6}[\s\-]?)(\d{1,6})([\s\-/])(\d{4})`, keep, DIGITS, keep, keep],
  [String.raw`(\d{1,6})([\s\-/])(\d{4})`, DIGITS, keep, keep],
], CM, '00123-2024-0-1801-JR-CI-01')
domain('PE_PENAL_EXPEDIENTE', 'PE_EXPEDIENTE_JUDICIAL',
  byName(
    ['n(o|ro|um|umero)_?(de_?)?(expediente_?(judicial|penal|fiscal)|causa|proceso_?(judicial|penal)|denuncia|carpeta_?fiscal|referencia_?(judicial|fiscal))|expediente_?(judicial|penal|fiscal)|carpeta_?fiscal|referencia_?(judicial|fiscal)|causa_?penal|n(o|ro|um|umero)_?[uú]nico_?(de_?)?expediente|cui_?judicial', 0.9],
    ['expediente|causa|proceso', 0.5],
  ),
  byPattern([[String.raw`\d{4,6}-\d{4}-\d-\d{4}-[A-Z\-]{2,12}-\d{2}`, 0.9], [String.raw`\d{1,6}-[A-Z]{2,10}-\d{4}`, 0.6]], { reject: 0.3 }))

// ── Preset ──────────────────────────────────────────────────────────────────

const referenced = JSON.stringify([domains, algorithms.map((x) => x.config)])
const orphans = algorithms.filter((a) => !referenced.includes(`"${a.name}"`))
if (orphans.length) throw new Error(`algorithms nobody uses: ${orphans.map((a) => a.name).join(', ')}`)
const noInput = algorithms.filter((a) => a.input === undefined)
if (noInput.length) throw new Error(`algorithms without a sample input: ${noInput.map((a) => a.name).join(', ')}`)

// The essential pack: identity documents, names, contact, address and birth date. Loading it brings
// these domains and only what they lean on; the extended pack is everything.
const ESSENTIAL = [
  'PE_L1_DNI', 'PE_L1_RUC', 'PE_L1_CARNE_EXTRANJERIA', 'PE_L1_PASAPORTE',
  'PE_L1_NOMBRE', 'PE_L1_APELLIDO', 'PE_L1_NOMBRE_COMPLETO', 'PE_L1_EMAIL', 'PE_L1_TELEFONO',
  'PE_L1_DIRECCION', 'PE_L1_DIRECCION_COMPLEMENTO', 'PE_L2_FECHA_NACIMIENTO',
]
const notDomains = ESSENTIAL.filter((name) => !domains.some((d) => d.name === name))
if (notDomains.length) throw new Error(`essential pack names domains the set does not have: ${notDomains.join(', ')}`)

const VERSION = 1
const preset = {
  version: VERSION,
  name: {
    en: 'Peru — Ley 29733 de Protección de Datos Personales',
    'pt-BR': 'Peru — Ley 29733 de Protección de Datos Personales',
    es: 'Perú — Ley 29733 de Protección de Datos Personales',
  },
  summary: {
    en: 'Discovers and masks Peruvian personal data under Ley 29733 and its regulation (Supreme Decree 016-2024-JUS): direct identifiers (DNI and RUC with a valid check digit, foreigner card, names, contact, address, accounts, plates), quasi-identifiers (birth date, distrito and UBIGEO, postal code), the sensitive data of article 2, 5 — biometric data that identifies on its own, racial and ethnic origin, economic income, political, religious, philosophical and moral convictions, trade union membership, health and sexual life —, plus genetic data, gender identity, indigenous people and language, financial data and criminal records.',
    'pt-BR': 'Descobre e mascara dados pessoais peruanos segundo a Ley 29733 e seu regulamento (Decreto Supremo 016-2024-JUS): identificadores diretos (DNI e RUC com dígito verificador válido, carné de extranjería, nomes, contato, endereço, contas, placas), quase-identificadores (data de nascimento, distrito e UBIGEO, código postal), os dados sensíveis do artigo 2, 5 — dados biométricos que identificam por si sós, origem racial e étnica, rendimentos econômicos, convicções políticas, religiosas, filosóficas e morais, filiação sindical, saúde e vida sexual —, além de dados genéticos, identidade de gênero, povo e língua indígenas, dados financeiros e antecedentes criminais.',
    es: 'Descubre y enmascara datos personales peruanos conforme a la Ley 29733 y su reglamento (Decreto Supremo 016-2024-JUS): identificadores directos (DNI y RUC con dígito verificador válido, carné de extranjería, nombres, contacto, dirección, cuentas, placas), cuasi-identificadores (fecha de nacimiento, distrito y UBIGEO, código postal), los datos sensibles del artículo 2, 5 — datos biométricos que por sí mismos identifican, origen racial y étnico, ingresos económicos, convicciones políticas, religiosas, filosóficas y morales, afiliación sindical, salud y vida sexual —, además de datos genéticos, identidad de género, pueblo y lengua indígenas, datos financieros y antecedentes penales.',
  },
  profileSet: {
    name: `PE - Ley 29733 - v${VERSION}`,
    description: 'Identificadores directos, cuasi-identificadores, datos sensibles (art. 2, 5), datos de salud, datos financieros y antecedentes penales, conforme a la Ley 29733 de Protección de Datos Personales del Perú y su reglamento (D.S. 016-2024-JUS).',
    threshold: 60,
    classifiers: classifiers.map((c) => c.name),
  },
  packs: {
    essential: {
      description: 'Paquete esencial de la Ley 29733: DNI, RUC, carné de extranjería, pasaporte, nombres, contacto, dirección y fecha de nacimiento.',
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

const smallDistritos = distritoPlaces.filter((d) => d.small)
const smallProvincias = provinciaPlaces.filter((p) => p.small)
const inSmall = smallDistritos.reduce((a, d) => a + d.population, 0)
console.log(`${domains.length} domains, ${classifiers.length} classifiers, ${algorithms.length} algorithms, ${files.size} files`)
console.log(`distritos: ${smallDistritos.length} of ${DISTRITOS.length} under ${SMALL_PLACE} (${inSmall} people); provincias: ${smallProvincias.length} of ${PROVINCIAS.length}`)
console.log(`${places.names} names generalized, ${places.table.length} table lines, ${codePairs.length} codes`)
