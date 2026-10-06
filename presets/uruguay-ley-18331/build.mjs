#!/usr/bin/env node
/**
 * Builds the Uruguay (Ley 18.331 de Protección de Datos Personales) pre-configured profile set:
 * preset.json and files/.
 *
 *   node presets/uruguay-ley-18331/build.mjs
 *
 * source/ holds the hand-kept lists — given names, surnames, barrios and balnearios — and the
 * geography of the 2023 census: the 652 localidades censales with their INE code, their population
 * and their location, and the 19 departamentos. Everything in files/ and preset.json is generated
 * from them and from the definitions below — edit here, then build, then run verify.mjs.
 *
 * Structure of the set
 *   L1     direct identifiers      cédula de identidad and RUT with a valid check digit, foreigner
 *                                  documents, passport, credencial cívica, BPS, names, **razón
 *                                  social** — art. 4 D) makes a legal person a data subject too —,
 *                                  contact, address, accounts, cards, devices, cookies, plates,
 *                                  property, free text
 *   L2     quasi-identifiers       birth date, age, sex, localidad and its INE code, barrio, postal
 *                                  code, marital status, occupation, employer, education
 *   L3     sensitive data          art. 4 E): racial and ethnic origin, political preferences,
 *                                  religious **or moral** convictions, trade union membership and
 *                                  sexual life — plus the biometric data of art. 4 Ñ), genetic
 *                                  data, gender identity and nationality
 *   SALUD  health data             art. 4 E), art. 17 C) and art. 19: clinical record, coverage,
 *                                  ICD-10, procedures, medicines, HIV, disability, carné de salud,
 *                                  reproductive and mental health
 *   FIN    commercial data         the actividad comercial o crediticia of art. 22, debt, income,
 *                                  assets, pensions, social programmes, housing
 *   PENAL  offences                art. 18, final paragraph: data on criminal, civil or
 *                                  administrative offences may be processed only by the competent
 *                                  public authorities
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
  description: 'Nombre de la columna (y variantes usadas en sistemas uruguayos).',
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
const BARRIOS = unique(readLines('barrios.txt'))

const DEPARTAMENTOS = readLines('departamentos.tsv').map((line) => {
  const [code, name, lat, lon, population] = line.split('\t')
  return { code, name, lat: Number(lat), lon: Number(lon), population: Number(population), aliases: [] }
})
const departmentByCode = new Map(DEPARTAMENTOS.map((d) => [d.code, d]))
const LOCALIDADES = readLines('localidades.tsv').map((line) => {
  const [code, name, departmentCode, department, lat, lon, population, approximate] = line.split('\t')
  return {
    code, name, departmentCode, department, lat: Number(lat), lon: Number(lon),
    population: Number(population), approximate: approximate === 'D', aliases: [],
  }
})
if (DEPARTAMENTOS.length !== 19) throw new Error(`expected the 19 departamentos, found ${DEPARTAMENTOS.length}`)
if (LOCALIDADES.length !== 652) throw new Error(`expected the 652 localidades censales, found ${LOCALIDADES.length}`)
for (const l of LOCALIDADES) {
  if (!/^\d{5}$/.test(l.code) || l.code.slice(0, 2) !== l.departmentCode) throw new Error(`${l.name}: bad INE code`)
  if (Number.isNaN(l.lat) || Number.isNaN(l.lon) || !departmentByCode.has(l.departmentCode)) throw new Error(`${l.name}: no location or departamento`)
}
// Every departamento holds at least one localidad of 20,000, so a generalized value never leaves
// its departamento. The smallest departamento, Flores, has some 24,600 inhabitants.
for (const d of DEPARTAMENTOS) {
  if (!LOCALIDADES.some((l) => l.departmentCode === d.code && l.population >= 20000)) throw new Error(`${d.name}: no localidad of 20,000`)
}

// ── Shared algorithms ───────────────────────────────────────────────────────

// Vowels map to vowels and consonants to consonants, so a masked document number keeps its
// structure; digits map to digits. Separators are in no group and stay. minMaskedPositions 0 lets
// a placeholder such as "N/A" through instead of failing the row.
algorithm('UY_CM_ALFANUM', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'AEIOU', 'BCDFGHJKLMNPQRSTVWXYZ', 'aeiou', 'bcdfghjklmnpqrstvwxyz', 'ÁÉÍÓÚÜ', 'áéíóúü'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, 'A1234567')
// Digits only: the dots and the hyphen of a cédula stay.
algorithm('UY_CM_DIGITOS', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '1.234.567-2')
// Digits and upper-case letters, one group each: a plate or a credencial cívica keeps its shape.
algorithm('UY_CM_DIGITOS_LETRAS', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, 'SAB 1234')
// Hex letters form their own group, so a MAC, UUID or IPv6 stays valid hex.
algorithm('UY_CM_HEX', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'abcdef', 'ABCDEF', 'ghijklmnopqrstuvwxyz', 'GHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '3c:22:fb:9a:10:e4')
decompose('UY_REDACTAR', [['(.+)', { type: 'REDACT', redactCharacter: 'X' }]], keep, 'clave123')
lookup('UY_SUPRIMIR', 'uy-sin-informacion.txt', ['Sin información'], 'Trastorno depresivo recurrente', 'PRESERVE_LOOKUP_FILE')
decompose('UY_IDENTIDAD', [['(.*)', keep]], keep, '211003420017')

// Yes/no columns keep their vocabulary: a CHAR(1) S/N stays S/N.
decompose('UY_BANDERA', [
  [String.raw`(?i)(s[ií]|no)`, apply(lookup('UY_BANDERA_SI_NO', 'uy-bandera-si-no.txt', ['Sí', 'No']))],
  ['(?i)(true|false)', apply(lookup('UY_BANDERA_TRUE_FALSE', 'uy-bandera-true-false.txt', ['true', 'false']))],
  ['(?i)(yes)', apply(lookup('UY_BANDERA_YES_NO', 'uy-bandera-yes-no.txt', ['Yes', 'No']))],
  ['(?i)([sn])', apply(lookup('UY_BANDERA_S_N', 'uy-bandera-s-n.txt', ['S', 'N']))],
  ['(?i)([yx])', apply(lookup('UY_BANDERA_Y_N', 'uy-bandera-y-n.txt', ['Y', 'N']))],
  ['([01])', apply(lookup('UY_BANDERA_0_1', 'uy-bandera-0-1.txt', ['0', '1']))],
], keep, 'S')
const FLAG = String.raw`(?i)(s[ií]|no|true|false|yes|[snyx01])`
/**
 * A categorical attribute: flags stay flags, numeric codes are replaced by another code of `codes`
 * (or get other digits), and any other value is replaced by one from `values` — or suppressed, when
 * no list is given.
 */
function categorical(name, fileName, values, input, codes) {
  const replacement = values ? lookup(`${name}_LISTA`, fileName, values) : 'UY_SUPRIMIR'
  const code = codes ? apply(lookup(`${name}_CODIGO`, fileName.replace(/\.txt$/, '-codigos.txt'), codes)) : apply('UY_CM_ALFANUM')
  return decompose(name, [[FLAG, apply('UY_BANDERA')], [String.raw`(\d{1,6})`, code]], apply(replacement), input)
}
categorical('UY_CATEGORIA_SUPRIMIDA', null, null, 'Trastorno depresivo recurrente')
const CM = apply('UY_CM_ALFANUM')
const DIGITS = apply('UY_CM_DIGITOS')

// ── L1 · Cédula de identidad and RUT ────────────────────────────────────────
//
// The **cédula de identidad** of the Dirección Nacional de Identificación Civil is the key of every
// Uruguayan record: seven digits and a check digit, written `1.234.567-2`. The digit is the classic
// modulus 10 — weights 2 9 8 7 6 3 4 from the left, ten minus the remainder — which is exactly what
// Check Digit computes, so one step masks the seven digits and writes the eighth.
//
// The **RUT** of the Dirección General Impositiva is twelve digits: two for the kind of taxpayer,
// six for the number, three for the branch and one check digit, modulus 11 over the weights
// 4 3 2 9 8 7 6 5 4 3 2, eleven minus the remainder, written 0 when that is eleven and **1 when it
// is ten**. Check Digit writes (modulus − remainder) and writes ten as `0`, so it agrees everywhere
// except on the remainder of 1, where the true digit is 1 and it writes 0 — the remainder of 0 gives
// the same written zero. An **auxiliary Check Digit with doubled weights** tells the two apart —
// doubling maps 0 to 0 and 1 to 2, so the auxiliary writes zero for the first and nine for the
// second — and a Regex Decompose then writes the true digit and drops the auxiliary.
//
// Article 4 D) of the law makes the data of a **legal person** personal data too, so the RUT of a
// company is masked like any other identifier — unlike the sets of countries whose law reaches only
// natural persons.
const CI_WEIGHTS = [2, 9, 8, 7, 6, 3, 4]
const RUT_WEIGHTS = [4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
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

checkDigit('UY_CEDULA_CD', CI_WEIGHTS, 10, 'UY_CM_DIGITOS', '1.234.567-2')
const CI_SHAPE = String.raw`\d{1,3}\.?\d{3}\.?\d{3}[\s\-]?\d|\d{6,8}`
decompose('UY_CEDULA', [[`(${CI_SHAPE})`, apply('UY_CEDULA_CD')]], DIGITS, '1.234.567-2')

const RUT_HEAD = String.raw`\d{11}[\s\-]?`
// Two digits for the kind of taxpayer and three for the branch stay; the six of the number change.
decompose('UY_RUT_CUERPO', [[String.raw`(\d{2})(\d{6})(\d{3})`, keep, DIGITS, keep]], DIGITS, '21100342001')
checkDigit('UY_RUT_CD', RUT_WEIGHTS, 11, 'UY_RUT_CUERPO', '211003420017')
widen('UY_RUT_ESPACIO', RUT_HEAD, '211003420017')
checkDigit('UY_RUT_AUX', [...doubled(RUT_WEIGHTS), 0], 11, 'UY_IDENTIDAD', '2110034200170')
resolve('UY_RUT_VERIFICADOR', RUT_HEAD, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 1], '2110034200170')
chain('UY_RUT', ['UY_RUT_CD', 'UY_RUT_ESPACIO', 'UY_RUT_AUX', 'UY_RUT_VERIFICADOR'], '211003420017')

// A document column holds cédulas, RUTs and passports: each value goes by its shape.
decompose('UY_DOCUMENTO', [
  [String.raw`(\d{12})`, apply('UY_RUT')],
  [`(${CI_SHAPE})`, apply('UY_CEDULA')],
], CM, '1.234.567-2')

const DOC_OWNER = 'cliente|cli|paciente|pac|usuario|afiliado|asegurado|beneficiario|benef|titular|empleado|emp|trabajador|funcionario|colaborador|alumno|estudiante|deudor|codeudor|garante|solicitante|propietario|arrendatario|inquilino|conductor|responsable|representante|apoderado|persona|ciudadano|elector|votante|contribuyente|proveedor|socio|conyuge|concubino|padre|madre|hijo|familiar|jubilado|pensionista|aportante'
domain('UY_L1_CEDULA', 'UY_DOCUMENTO',
  byName(
    [`c[eé]dula(_?(de_?)?identidad)?|ci|c_?i|n(o|ro|um|umero)_?(c[eé]dula|documento|doc|identificaci[oó]n|id(ent)?)|doc_?identidad|nro_?doc|num_?doc|identificacion|(${DOC_OWNER})_?(cedula|ci|doc|documento)|cedula_?(${DOC_OWNER})`, 0.9],
    ['documento|doc', 0.6],
  ),
  byType(STRING(6), NUMBER(6)),
  byPattern([
    [String.raw`\d\.\d{3}\.\d{3}-\d`, 0.95],
    [String.raw`\d{1,3}\.?\d{3}\.?\d{3}-\d`, 0.8],
    // Eight bare digits are a cédula without its dots — and also any eight-digit code, so this
    // only backs up a column name that already says cédula.
    [String.raw`\d{8}`, 0.4],
  ], { reject: 0.3 }))

domain('UY_L1_RUT', 'UY_RUT',
  byName([`rut(?!a)[a-z0-9_]*|n(o|ro|um|umero)_?rut|registro_?[uú]nico_?tributario|(${DOC_OWNER})_?rut|rut_?(${DOC_OWNER})|id_?tributario|tax_?id|n(o|ro|um|umero)_?(de_?)?contribuyente`, 0.9]),
  byPattern([[String.raw`\d{12}`, 0.7], [String.raw`\d{2}[\s\-.]?\d{6}[\s\-.]?\d{3}[\s\-.]?\d`, 0.8]], { reject: 0.3 }))

// ── L1 · Other identity documents ───────────────────────────────────────────

domain('UY_L1_DOCUMENTO_EXTRANJERO', 'UY_CM_ALFANUM',
  byName(['c[eé]dula_?(de_?)?extranjer[ií]a|documento_?(de_?)?extranjer[oa]|doc_?extranjero|n(o|ro|um|umero)_?(extranjer[ií]a|refugiado)|carn[eé]_?(de_?)?(extranjer[ií]a|refugiado)|residencia_?(legal|permanente|temporaria)|permiso_?(de_?)?(residencia|trabajo)|visa(_?(n(o|ro|um|umero)|tipo))?|condici[oó]n_?migratoria|c[eé]dula_?mercosur', 0.85]))

domain('UY_L1_PASAPORTE', 'UY_CM_ALFANUM',
  byName(['pasaporte[a-z0-9_]*|n(o|ro|um|umero)_?pasaporte|passport[a-z0-9_]*', 0.9]),
  byPattern([[String.raw`[A-Z]\d{6,7}`, 0.4]], { reject: 0.3 }))

// The Corte Electoral identifies every voter with a series of three letters and a number.
domain('UY_L1_CREDENCIAL_CIVICA', 'UY_CM_DIGITOS_LETRAS',
  byName(['credencial(_?c[ií]vica)?|serie_?(y_?)?n(o|ro|um|umero)?(_?credencial)?|n(o|ro|um|umero)_?(credencial|c[ií]vico)|inscripci[oó]n_?c[ií]vica|registro_?c[ií]vico|padr[oó]n_?electoral', 0.85]),
  byPattern([[String.raw`[A-Z]{3}[\s\-]?\d{4,5}`, 0.45]], { reject: 0.3 }))

// The Dirección General de Registro de Estado Civil keeps the civil registry.
domain('UY_L1_PARTIDA', 'UY_CM_ALFANUM',
  byName(['partida_?(de_?)?(nacimiento|matrimonio|defunci[oó]n|uni[oó]n_?concubinaria)(_?(n(o|ro|um|umero)|folio|tomo|acta))?|n(o|ro|um|umero)_?(partida|acta)|acta_?(de_?)?(nacimiento|matrimonio|defunci[oó]n)|tomo(_?(partida|registro))?|folio(_?(partida|registro))?|registro_?(de_?)?estado_?civil|testimonio_?(de_?)?partida', 0.85]))

// The Banco de Previsión Social numbers every worker and every employer.
domain('UY_L1_SEGURO_SOCIAL', 'UY_CM_ALFANUM',
  byName(['bps[a-z0-9_]*|n(o|ro|um|umero)_?(bps|afiliaci[oó]n|afiliado|empresa_?bps|aportante|historia_?laboral)|c[oó]digo_?(de_?)?(afiliado|empresa_?bps)|n(o|ro|um|umero)_?(de_?)?(empresa|obra)|afiliaci[oó]n_?bps|caja_?(profesional|notarial|bancaria|militar|policial)|fonasa', 0.85]))

domain('UY_L1_CODIGO_ESTUDIANTE', 'UY_CM_ALFANUM',
  byName(['c[oó]digo_?(de_?)?(estudiante|alumno|matr[ií]cula)|cod_?(alumno|estudiante)|n(o|ro|um|umero)_?(de_?)?(matr[ií]cula|estudiante)|carn[eé]_?(de_?)?(estudiante|universitario)|id_?(alumno|estudiante)|c[eé]dula_?estudiantil|gurí|gur[ií]_?(id|codigo)', 0.8]))

domain('UY_L1_MATRICULA_PROFESIONAL', 'UY_CM_ALFANUM',
  byName(['matr[ií]cula_?(profesional|m[eé]dica|de_?abogado)|n(o|ro|um|umero)_?(de_?)?(matr[ií]cula|registro_?profesional|caja_?profesional)|registro_?(m[eé]dico|profesional)|n(o|ro|um|umero)_?(de_?)?t[ií]tulo|habilitaci[oó]n_?profesional', 0.85]))

// ── L1 · Names ──────────────────────────────────────────────────────────────

const NOT_A_PERSON = 'producto|prod|item|articulo|empresa|emp|razon|social|fantasia|comercial|archivo|calle|avenida|camino|pasaje|rambla|barrio|balneario|localidad|departamento|depto|dpto|pais|banco|sucursal|agencia|plan|campana|proyecto|servicio|tabla|columna|campo|usuario|host|servidor|dominio|marca|modelo|categoria|tipo|escuela|liceo|colegio|institucion|universidad|curso|materia|documento|doc|unidad|clinica|hospital|mutualista|bps|seguro|area|dependencia|cargo|sistema|app|aplicacion|grupo|lista|reporte|informe|proceso|evento|tarea|perfil|rol|clase|objeto|cuenta|medicamento|diagnostico|estudio|programa|beneficio|partido|sindicato|religion|lengua|idioma|lugar|sede|local|tienda|deposito|proveedor|convenio|contrato|poliza|aseguradora|entidad|organismo|organizacion|parametro|variable|metodo|funcion|indice|job|script|cola|recurso|red|dispositivo|plantilla|imagen|foto|pagina|sitio|modulo|menu|opcion|accion|permiso|concepto|impuesto|moneda|emisor|factura|comprobante|pago|forma|zona|ruta|linea|actividad|rubro|sector|file|table|column|field|user|server|product|company|category|type|school|document|department|system|group|report|role|account|place|store|supplier|contract|device|image|page|module|action|key|label|code|project|city|country|street|bank'
const PERSON_ROLE = 'cliente|cli|paciente|pac|usuario|afiliado|asegurado|beneficiario|benef|titular|empleado|trabajador|funcionario|colaborador|alumno|estudiante|deudor|codeudor|garante|solicitante|propietario|arrendatario|inquilino|conductor|responsable|representante|apoderado|persona|ciudadano|contribuyente|madre|padre|conyuge|concubino|contacto|referencia|victima|denunciante|imputado|testigo|medico|docente|socio|heredero|donante|tutor|jubilado|pensionista|customer|patient|employee|member|holder|mother|father|spouse|contact|person|student|driver|owner'
const PARTICLES = String.raw`(?i)(de|del|la|las|los|y|e|da|do|dos|san|santa|van|von|di|le)`

algorithm('UY_NOMBRE', 'name.Name', {
  lookupFile: { uri: file('uy-nombres.txt', GIVEN_NAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Washington')
algorithm('UY_APELLIDO', 'name.Name', {
  lookupFile: { uri: file('uy-apellidos.txt', SURNAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Rodríguez')
// A word of a name. "de", "da", "los" stay where they are: "María de los Ángeles", "Da Silva".
decompose('UY_PALABRA_NOMBRE', [[PARTICLES, keep]], apply('UY_NOMBRE'), 'Serrana')
decompose('UY_PALABRA_APELLIDO', [[PARTICLES, keep]], apply('UY_APELLIDO'), 'Techera')
const N = apply('UY_PALABRA_NOMBRE')
const S = apply('UY_PALABRA_APELLIDO')

decompose('UY_NOMBRES', [
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, N],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, N, N],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, N, N],
], CM, 'María de los Ángeles')
decompose('UY_APELLIDOS', [
  [String.raw`(\S+)`, S],
  [String.raw`(\S+)\s+(\S+)`, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, S, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, S, S, S, S],
], CM, 'Rodríguez Techera')
// Uruguayan order: one or two given names, the father's surname and the mother's surname. Two words
// are a given name and a surname; three, a given name and two surnames; four, two and two.
decompose('UY_NOMBRE_COMPLETO', [
  [String.raw`([^,]+),\s*(.+)`, apply('UY_APELLIDOS'), apply('UY_NOMBRES')],
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, S, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, N, S, S, S],
], CM, 'Juan Pablo Rodríguez Techera')
const NAME_WORDS = ['de', 'del', 'la', 'las', 'los', 'y', 'da', 'dos']

domain('UY_L1_NOMBRE', 'UY_NOMBRES',
  byName(
    ['primer_?nombre|segundo_?nombre|nombres?_?(de_?)?pila|pri(mer)?_?nom|seg(undo)?_?nom|nombre_?1|nombre_?2|first_?names?|given_?names?|fname|middle_?names?|nombres(?!_?(completos?|y_?apellidos?|apellidos?))', 0.85],
    [`nombre(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|apellidos?|usuario|corto|largo))|nom(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}))|name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))`, 0.5],
  ),
  byList([['uy-detectar-nombres.txt', [...GIVEN_NAMES, ...NAME_WORDS], 0.7]], { tokenize: true, reject: 0.3 }))

domain('UY_L1_APELLIDO', 'UY_APELLIDOS',
  byName(['apellidos?|primer_?apellido|segundo_?apellido|apellido_?(1|2|paterno|materno)|ape_?(1|2|pat|mat)|ap_?(paterno|materno)|last_?names?|surnames?|family_?names?|lname', 0.85]),
  byList([['uy-detectar-apellidos.txt', [...SURNAMES, ...NAME_WORDS], 0.7]], { tokenize: true, reject: 0.3 }))

domain('UY_L1_NOMBRE_COMPLETO', 'UY_NOMBRE_COMPLETO',
  byName(
    [`nombres?_?(completos?|y_?apellidos?|apellidos?)|apellidos?_?(y_?)?nombres?|nombre_?(del_?|de_?la_?)?(${PERSON_ROLE})|(${PERSON_ROLE})_?(nombre|nom)|nom_?(${PERSON_ROLE})|nombre_?(madre|padre|tutor|conyuge|concubino|contacto_?emergencia|referencia)|full_?name|person_?name`, 0.9],
    ['madre|padre|tutor|conyuge|concubino|representante_?legal|apoderado|garante|beneficiario|heredero|titular|referencia_?(personal|familiar)', 0.6],
    [`nombre(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|apellidos?|usuario|corto|largo))|nom(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}))|name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))`, 0.5],
  ),
  byList([['uy-detectar-nombres.txt', [...GIVEN_NAMES, ...NAME_WORDS], 0.65], ['uy-detectar-apellidos.txt', [...SURNAMES, ...NAME_WORDS], 0.65]], { tokenize: true, reject: 0.3 }))

// Article 4 D) makes personal data any information about a determinate or determinable **natural or
// legal** person, and article 9 C) names the razón social, the nombre de fantasía and the RUT of a
// legal person among the data a listing may hold. A company is a data subject in Uruguay.
lookup('UY_RAZON_SOCIAL', 'uy-razones-sociales.txt', ['Comercial del Plata S.A.', 'Distribuidora Oriental S.R.L.', 'Importadora Rambla S.A.', 'Transportes Santa Lucía S.R.L.', 'Agropecuaria Cuchilla Grande S.A.', 'Frigorífico Las Piedras S.A.', 'Constructora Río de la Plata S.A.', 'Textiles Uruguay S.R.L.', 'Pesquera Costa Atlántica S.A.', 'Forestal Tacuarembó S.A.', 'Servicios Integrales Montevideo S.R.L.', 'Comercializadora del Este S.A.', 'Laboratorio Salud Total S.R.L.', 'Seguridad Vigía S.R.L.', 'Editorial Solís S.R.L.', 'Hotel Mirador del Cerro S.A.', 'Panadería Buen Pan S.R.L.', 'Estudio Contable Asociados S.R.L.', 'Turismo Punta del Diablo S.A.', 'Lácteos Colonia S.A.'], 'Corporación Comercial Oriental S.A.', 'PRESERVE_LOOKUP_FILE')
domain('UY_L1_RAZON_SOCIAL', 'UY_RAZON_SOCIAL',
  byName(['raz[oó]n_?social|razonsocial|nombre_?(de_?)?fantas[ií]a|nombre_?(comercial|de_?la_?empresa|empresa)|denominaci[oó]n_?social|nombre_?legal|business_?name|company_?name|legal_?name', 0.85]))

// ── L1 · Contact ────────────────────────────────────────────────────────────

decompose('UY_EMAIL', [
  // The top-level domain becomes .test, reserved for tests: a masked address can never deliver.
  [String.raw`([^@\s]+)@([^@\s]+)\.([A-Za-z]{2,24}(?:\.[A-Za-z]{2})?)`, CM, CM, redactAs('test')],
], CM, 'serrana.rodriguez@gmail.com')
domain('UY_L1_EMAIL', 'UY_EMAIL',
  byName(['e_?mail[a-z0-9_]*|mail[a-z0-9_]*|correo(_?electr[oó]nico)?[a-z0-9_]*|dir_?correo|direcci[oó]n_?(de_?)?correo|direcci[oó]n_?electr[oó]nica', 0.85]),
  byType(STRING(5)),
  byPattern([[String.raw`[A-Za-z0-9._%+'\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}`, 1]], { reject: 0.2 }))

// A mobile is nine digits starting `09`; a landline is eight, starting with 2 in Montevideo and
// with 4 in the interior. The country code and the prefix stay, so a masked number keeps saying
// mobile or landline and which region.
decompose('UY_TELEFONO', [
  [String.raw`(\+?598[\s\-]?)(0?9\d)([\s\-]?)([\d\s\-]{6,9})`, keep, keep, keep, DIGITS],
  [String.raw`(0?9\d)([\s\-]?)([\d\s\-]{6,9})`, keep, keep, DIGITS],
  [String.raw`(\+?598[\s\-]?)?(\(?0?[24]\)?)([\s\-]?)([\d\s\-]{6,10})`, keep, keep, keep, DIGITS],
], DIGITS, '+598 99 123 456')
domain('UY_L1_TELEFONO', 'UY_TELEFONO',
  byName(['tel|tel[eé]fono[a-z0-9_]*|tel_?(fijo|casa|oficina|trabajo|contacto|celular|m[oó]vil)|celular[a-z0-9_]*|cel|m[oó]vil|whats_?app|n(o|ro|um|umero)_?(tel|tel[eé]fono|celular|cel|contacto)|fax|phone[a-z0-9_]*|mobile[a-z0-9_]*', 0.85]),
  byPattern([
    [String.raw`(\+?598[\s\-]?)?0?9\d[\s\-]?\d{3}[\s\-]?\d{3}`, 0.9],
    [String.raw`\(?0?[24]\)?[\s\-]?\d{3}[\s\-]?\d{4}`, 0.5],
  ], { reject: 0.3 }))

// Uruguayan addresses name the street and the door number — "Av. 18 de Julio 1234 apto. 501" —, and
// often the corner. The whole line becomes a fictitious one.
const VIAS = ['Av.', 'Avenida', 'Bv.', 'Bulevar', 'Calle', 'Camino', 'Cno.', 'Pasaje', 'Rambla', 'Ruta']
const VIA_NAMES = ['18 de Julio', 'Italia', 'Rivera', 'Brasil', 'Bulevar Artigas', 'General Flores', 'Agraciada', 'Millán', '8 de Octubre', 'Luis Alberto de Herrera', 'Bolivia', 'Arocena', 'Colonia', 'Mercedes', 'Paysandú', 'Uruguay', 'Canelones', 'Maldonado', 'Durazno', 'Soriano', 'San José', 'Cerro Largo', 'Constituyente', 'Ejido', 'Yaguarón', 'Ciudadela', 'Sarandí', 'Piedras', 'Buenos Aires', 'Juan Carlos Gómez', 'Carlos Gardel', 'Garibaldi', 'Larrañaga', 'Centenario', 'Batlle y Ordóñez']
lookup('UY_DIRECCION', 'uy-direcciones.txt', (() => {
  const random = seeded(18331)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const num = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
  const out = new Set()
  while (out.size < 4000) {
    const street = `${pick(VIAS)} ${pick(VIA_NAMES)}`
    const r = random()
    if (r < 0.3) out.add(`${street} ${num(100, 4500)}`)
    else if (r < 0.55) out.add(`${street} ${num(100, 4500)} apto. ${num(101, 1200)}`)
    else if (r < 0.7) out.add(`${street} ${num(100, 4500)} esq. ${pick(VIA_NAMES)}`)
    else if (r < 0.82) out.add(`${street} ${num(100, 4500)}, ${pick(BARRIOS)}`)
    else if (r < 0.92) out.add(`${street} ${num(100, 4500)} bis, Padrón ${num(1000, 99999)}`)
    else out.add(`Ruta ${num(1, 109)} km ${num(1, 400)}`)
  }
  return [...out]
})(), 'Av. 18 de Julio 1234 apto. 501', 'PRESERVE_LOOKUP_FILE')
domain('UY_L1_DIRECCION', 'UY_DIRECCION',
  byName(['(?<!(mac|ip|e_?mail|web|url|correo)_?)direcci[oó]n(?!_?(ip|mac|email|e_?mail|correo|electr[oó]nica|web|url|tipo|id|general|regional))[a-z0-9_]*|domicilio[a-z0-9_]*|dom_?(residencia|particular|laboral|cliente|fiscal|constituido)|residencia|lugar_?(de_?)?residencia|calle(_?(y_?n[uú]mero|esquina))?|(?<!(mac|ip|e_?mail|web|url)_?)address(?!_?(ip|mac|email|e_?mail|web|url|type|id))[a-z0-9_]*', 0.8]),
  byType(STRING(6)),
  byPattern([
    [String.raw`(?i)(av|avenida|bv|bulevar|calle|camino|cno|pasaje|rambla|ruta)\.?\s+[a-záéíóúñ0-9.' ]{2,40}\s*\d{1,5}.*`, 0.8],
    [String.raw`(?i).*\b(apto|apartamento|esq|esquina|padr[oó]n|bis|piso|puerta)\.?\s*[a-z0-9]{1,6}.*`, 0.6],
    [String.raw`(?i)ruta\s*\d{1,3}\s*(km|kil[oó]metro)\.?\s*\d{1,3}.*`, 0.7],
  ], { reject: 0.2 }))

domain('UY_L1_DIRECCION_COMPLEMENTO', 'UY_CM_ALFANUM',
  byName(['apartamento|apto|apto_?n(o|ro|um|umero)|piso|block|bloque|torre|puerta|unidad_?(habitacional|padron)|esquina|esq|entre_?calles|manzana|solar|n(o|ro|um|umero)_?(puerta|apto|apartamento)|complemento(_?direcci[oó]n)?|referencia_?(de_?)?(direcci[oó]n|domicilio)', 0.7]))

// ── L1 · Banking, payments, network, devices, vehicles, property ────────────

domain('UY_L1_CUENTA_BANCARIA', 'UY_CM_DIGITOS',
  byName(['cuenta_?(bancaria|banco|corriente|ahorros?|sueldo|n[oó]mina|abono|dep[oó]sito|destino|origen)|n(o|ro|um|umero)_?(de_?)?(cuenta|cta)|nro_?cta|num_?cta|cta_?(cte|corriente|ahorros?|bancaria)|iban|account_?(no|num|number)|bank_?account', 0.85]))

// Payment Card fails a row that has no digits to mask; only values shaped like a card reach it.
algorithm('UY_TARJETA_LUHN', 'characterMapping.PaymentCard', { minMaskedPositions: 6, preserve: 0 }, '4093820000000001')
decompose('UY_TARJETA', [[String.raw`(\d[\d\s\-]{11,22}\d)`, apply('UY_TARJETA_LUHN')]], keep, '4093 8200 0000 0001')
domain('UY_L1_TARJETA', 'UY_TARJETA',
  byName(['tarjeta(_?(cr[eé]dito|d[eé]bito|n(o|ro|um|umero)))?|n(o|ro|um|umero)_?tarjeta|pan|card_?(no|num|number)|credit_?card|tc_?(numero|num|nro)', 0.85]),
  // 0.9, not 1: an IMEI is 15 Luhn-valid digits too, and its own column name should win.
  byPattern([[String.raw`\d{13,19}`, 0.9, { checksum: 'LUHN', clean: String.raw`[\s\-]` }]], { reject: 0.3 }))

domain('UY_L1_BILLETERA', 'UY_CM_ALFANUM',
  byName(['billetera(_?(digital|electr[oó]nica|m[oó]vil))?|wallet(_?(id|address|direccion))?|prex|mi_?dinero|midinero|oca_?blue|dinero_?electr[oó]nico|c[oó]digo_?qr|qr_?(id|codigo)|direcci[oó]n_?(bitcoin|btc|wallet)|btc_?(address|direccion)', 0.85]),
  byPattern([[String.raw`(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,59}`, 0.7]], { reject: 0.3 }))

algorithm('UY_OCTETO', 'characterMapping.NumericMapping', { minValue: 1, maxValue: 254 }, '10')
decompose('UY_IP', [
  [String.raw`(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})`, apply('UY_OCTETO'), apply('UY_OCTETO'), apply('UY_OCTETO'), apply('UY_OCTETO')],
], apply('UY_CM_HEX'), '164.73.45.12')
domain('UY_L1_IP', 'UY_IP',
  byName(['ip|ip_?(address|addr|origen|destino|cliente|usuario|acceso|login|remota|publica)|direcci[oó]n_?ip|dir_?ip|ipv[46]|remote_?addr(ess)?|client_?ip|host_?ip', 0.85]),
  byPattern([
    [String.raw`((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)`, 1],
    [String.raw`[0-9A-Fa-f]{1,4}(:[0-9A-Fa-f]{0,4}){2,7}`, 0.9],
  ], { reject: 0.3 }))

domain('UY_L1_DISPOSITIVO', 'UY_CM_HEX',
  byName(['imei|imsi|iccid|mac|mac_?address|direcci[oó]n_?mac|device_?(id|uuid|serial)|id_?(dispositivo|equipo|celular)|serial_?(equipo|celular|dispositivo)|advertising_?id|idfa|gaid|session_?id|id_?sesi[oó]n', 0.8]),
  byPattern([
    [String.raw`([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}`, 1],
    [String.raw`\d{15}`, 0.8, { checksum: 'LUHN' }],
  ], { reject: 0.3 }))

// Article 21 allows profiling for advertising from public sources, and defines the hábitos de
// consumo these identifiers build; article 4 Ñ) was added in 2020 for the biometric ones.
domain('UY_L1_COOKIE', 'UY_CM_ALFANUM',
  byName(['cookie(_?(id|value|valor|nombre))?|cookies|_?ga|_?gid|fbp|fbclid|utm_?(source|medium|campaign|term|content)|id_?(navegador|browser|visitante)|visitor_?id|tracking_?id|client_?id', 0.8]))

// Plates: three letters and four digits since 2015, and the first letter is the departamento —
// A Montevideo, B Artigas, C Canelones, and so on to S Treinta y Tres.
domain('UY_L1_PLACA', 'UY_CM_DIGITOS_LETRAS',
  byName(['(?<!(cod|codigo|tipo)_?)matr[ií]cula(?!_?(profesional|m[eé]dica|estudiante|de_?abogado))(_?(veh[ií]culo|auto|moto))?|placa(_?(veh[ií]culo|auto|moto))?|n(o|ro|um|umero)_?(matr[ií]cula|placa|chapa)|chapa(_?veh[ií]culo)?|license_?plate|plate(_?(no|number))?', 0.85]),
  byPattern([
    [String.raw`[A-Z]{3}[\s\-]?\d{4}`, 0.7],
    [String.raw`[A-Z]{3}[\s\-]?\d{3}`, 0.4],
  ], { reject: 0.3 }))

domain('UY_L1_VEHICULO', 'UY_CM_ALFANUM',
  byName(['vin|chasis|n(o|ro|um|umero)_?(chasis|motor|serie|vin)|motor_?n(o|ro|um|umero)|libreta_?(de_?)?circulaci[oó]n|licencia_?(de_?)?conducir(_?(n(o|ro|um|umero)|categor[ií]a))?|n(o|ro|um|umero)_?licencia|permiso_?[uú]nico_?nacional_?(de_?)?conducir|punc', 0.85]),
  byPattern([[String.raw`[A-HJ-NPR-Z0-9]{17}`, 0.7]], { reject: 0.3 }))

// The Dirección Nacional de Catastro numbers every parcel with a padrón, and the Registro de la
// Propiedad records its owner.
domain('UY_L1_INMUEBLE', 'UY_CM_ALFANUM',
  byName(['padr[oó]n(_?(inmueble|rural|urbano|n(o|ro|um|umero)))?|n(o|ro|um|umero)_?(de_?)?(padr[oó]n|inmueble|predio|catastral)|c[oó]digo_?catastral|catastro|inscripci[oó]n_?registral|registro_?(de_?la_?)?propiedad|n(o|ro|um|umero)_?(de_?)?(unidad|contador|medidor)', 0.8]))

domain('UY_L1_CONTRATO', 'UY_CM_ALFANUM',
  byName(['n(o|ro|um|umero)_?(contrato|p[oó]liza|cr[eé]dito|pr[eé]stamo|solicitud|expediente_?(administrativo|interno)|tr[aá]mite|referencia|cliente|socio|suscriptor|suministro|servicio|caso|ticket|beneficio|siniestro)|contrato_?(n(o|ro|um|umero))|c[oó]digo_?(cliente|socio|empleado|afiliado|suministro)|id_?(cliente|socio|empleado|afiliado)|n(o|ro)_?(empleado|funcionario)|c[oó]digo_?(de_?)?(empleado|funcionario|planilla)', 0.7]))

domain('UY_L1_USUARIO', 'UY_CM_ALFANUM',
  byName(['usuario|user_?name|username|login|alias|apodo|nick(_?name)?|perfil_?(instagram|facebook|twitter|tiktok|linkedin|x)|instagram|facebook|twitter|tiktok|linkedin|red_?social|handle', 0.7]))

domain('UY_L1_CREDENCIAL', 'UY_REDACTAR',
  byName(['contrase[nñ]a|clave(?!_?(catastral|primaria|for[aá]nea|valor|producto))|password|passwd|pwd|pass|hash_?(clave|contrasena|password)|pin|c[oó]digo_?(seguridad|verificaci[oó]n|acceso|otp)|cvv|cvc|token(_?(acceso|refresh|api))?|access_?token|refresh_?token|api_?key|llave_?(api|privada)|secreto|secret|otp|firma_?(electr[oó]nica|digital)_?(clave|pin)|pregunta_?secreta|respuesta_?secreta|frase_?semilla|seed_?phrase', 0.9]))

decompose('UY_COORDENADA', [
  // The integer part and first decimal stay (about 11 km): the place is generalized, not moved.
  [String.raw`(-?\d{1,3}[.,]\d)(\d+)\s*([,;])\s*(-?\d{1,3}[.,]\d)(\d+)`, keep, DIGITS, keep, keep, DIGITS],
  [String.raw`(-?\d{1,3}[.,]\d)(\d+)`, keep, DIGITS],
], keep, '-34.903280')
domain('UY_L1_GEOLOCALIZACION', 'UY_COORDENADA',
  byName(
    ['lat|latitud|lon|lng|longitud|coordenadas?|coord_?[xy]|geo_?(lat|lon|lng|loc|localizacion|posicion)|georreferenciaci[oó]n|geolocalizaci[oó]n|gps(_?(ubicaci[oó]n|posici[oó]n|coordenadas))?|ubicaci[oó]n_?gps', 0.85],
    ['long', 0.5],
  ),
  byPattern([
    [String.raw`-3[0-5]\.\d{3,}\s*,\s*-5[3-8]\.\d{3,}`, 0.9],
    [String.raw`-5[3-8]\.\d{4,}`, 0.5],
    [String.raw`-3[0-5]\.\d{4,}`, 0.4],
  ], { reject: 0.3 }))

// ── L1 · Free text ──────────────────────────────────────────────────────────

algorithm('UY_TEXTO_LIBRE', 'freeTextRedaction.FreeTextRedaction', {
  regularExpressions: [
    String.raw`(?<!\d)\d{1,3}\.\d{3}\.\d{3}-\d(?!\d)`,
    String.raw`(?<!\d)\d{7,8}(?!\d)`,
    String.raw`(?<!\d)\d{12}(?!\d)`,
    String.raw`[\w.+\-]+@[\w\-]+(\.[\w\-]+)+`,
    String.raw`(?<![\d\-])(\+?598[\s\-]?)?0?9\d[\s\-]?\d{3}[\s\-]?\d{3}(?![\d\-])`,
    String.raw`(?<!\d)\d{13,19}(?!\d)`,
    String.raw`(?<![A-Za-z])[A-Z]{3}[\s\-]?\d{4}(?![A-Za-z\d])`,
    String.raw`(?<!\d)(\d{1,3}\.){3}\d{1,3}(?!\d)`,
  ].map((patternString) => ({ patternString })),
  regExRedactValue: '[DATO]',
  lookupFile: { uri: file('uy-texto-nombres.txt', unique([...GIVEN_NAMES, ...SURNAMES].flatMap((v) => [v, v.toUpperCase(), fold(v), fold(v).toUpperCase()]))) },
  lookupFileRedactValue: '[NOMBRE]',
  isDenyList: true,
}, 'Cliente Rodríguez, CI 1.234.567-2, correo s.rodriguez@gmail.com, cel 099123456')

domain('UY_L1_TEXTO_LIBRE', 'UY_TEXTO_LIBRE',
  byName(['observaci[oó]n(es)?|obs|comentarios?|notas?|anotaci[oó]n(es)?|glosa|descripci[oó]n_?(queja|reclamo|solicitud|caso|hechos|novedad|atenci[oó]n|denuncia)|detalle_?(reclamo|solicitud|caso|atenci[oó]n)|hechos|relato|justificaci[oó]n|(?<!(id|cd|cod|codigo|tipo|fecha|estado|num|nro)_?)mensaje(?!_?(id|tipo|codigo|fecha|estado|cola|log))|texto(_?libre)?|resumen_?(caso|atenci[oó]n)|queja|reclamo|denuncia_?texto|remarks?|comments?|notes?|free_?text|memo', 0.6]),
  byType(STRING(30)),
  byPattern([
    [String.raw`\d\.\d{3}\.\d{3}-\d`, 0.8],
    [String.raw`[\w.+\-]+@[\w\-]+\.[A-Za-z]{2,}`, 0.7],
    [String.raw`0?9\d[\s\-]?\d{3}[\s\-]?\d{3}`, 0.6],
  ], { reject: 0, partial: true }))

// ── L2 · Quasi-identifiers ──────────────────────────────────────────────────

// Small shifts: large enough to break the link to the person, small enough that ages and school
// years move for few people.
algorithm('UY_FECHA_NACIMIENTO', 'dateAlgorithms.DateShift', { minRange: -60, maxRange: 60, unit: 'DAYS', roll: false }, '1985-07-20')
algorithm('UY_FECHA_EVENTO', 'dateAlgorithms.DateShift', { minRange: -30, maxRange: 30, unit: 'DAYS', roll: false }, '2021-03-15')

domain('UY_L2_FECHA_NACIMIENTO', 'UY_FECHA_NACIMIENTO',
  byName(['(fecha|fec|fch|f)_?(de_?)?nac(imiento)?|fnac|fechanac(imiento)?|cumplea[nñ]os|dob|date_?of_?birth|birth_?date|birthday', 0.9]),
  byType(...DATES, STRING(6)))

decompose('UY_ANIO', [[String.raw`(\d{3})(\d)`, keep, DIGITS]], keep, '1985')
domain('UY_L2_ANIO_NACIMIENTO', 'UY_ANIO',
  byName(['a[nñ]o_?(de_?)?nac(imiento)?|anio_?nac(imiento)?|year_?of_?birth|birth_?year|yob', 0.9]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// 37 becomes 3x. From 100 on, 90.
decompose('UY_EDAD', [
  [String.raw`(\d{3,})`, redactAs('90')],
  [String.raw`([1-9])(\d)([.,]\d+)`, keep, DIGITS, keep],
  [String.raw`([1-9])(\d)`, keep, DIGITS],
  [String.raw`(\d)`, DIGITS],
], keep, '37')
domain('UY_L2_EDAD', 'UY_EDAD',
  byName(['edad(_?(actual|a[nñ]os|anios|paciente|afiliado|cliente|al_?(ingreso|diagn[oó]stico|fallecimiento)))?|grupo_?etario|tramo_?(de_?)?edad|rango_?(de_?)?edad|quinquenio|age(_?(years|group))?', 0.85]),
  byType(NUMBER(0, 6), STRING(0, 6)))

domain('UY_L2_FECHA_EVENTO', 'UY_FECHA_EVENTO',
  byName(['(fecha|fec|fch|f)_?(de_?)?(defunci[oó]n|fallecimiento|muerte|matrimonio|divorcio|ingreso|egreso|alta|baja|cese|retiro|contrataci[oó]n|despido|jubilaci[oó]n|internaci[oó]n|hospitalizaci[oó]n|diagn[oó]stico|atenci[oó]n|consulta|parto|detenci[oó]n|sentencia|expedici[oó]n(_?(cedula|documento))?|vencimiento_?c[eé]dula|vacunaci[oó]n|cirug[ií]a|accidente|certificaci[oó]n)|fec_?(exp|expedicion|defuncion|ingreso|egreso|baja)|date_?of_?(death|marriage|hire|admission|discharge)', 0.8]),
  byType(...DATES, STRING(6)))

// Each vocabulary replaced within itself: M/F stays M/F.
decompose('UY_SEXO', [
  ['(?i)(femenino|masculino)', apply(lookup('UY_SEXO_FEMENINO_MASCULINO', 'uy-sexo-femenino-masculino.txt', ['Femenino', 'Masculino']))],
  ['(?i)(mujer|hombre)', apply(lookup('UY_SEXO_MUJER_HOMBRE', 'uy-sexo-mujer-hombre.txt', ['Mujer', 'Hombre']))],
  ['(?i)(female|male)', apply(lookup('UY_SEXO_FEMALE_MALE', 'uy-sexo-female-male.txt', ['Female', 'Male']))],
  ['(?i)([fm])', apply(lookup('UY_SEXO_F_M', 'uy-sexo-f-m.txt', ['F', 'M']))],
  ['(?i)([hm])', apply(lookup('UY_SEXO_H_M', 'uy-sexo-h-m.txt', ['H', 'M']))],
  ['([12])', apply(lookup('UY_SEXO_1_2', 'uy-sexo-1-2.txt', ['1', '2']))],
], keep, 'F')
domain('UY_L2_SEXO', 'UY_SEXO',
  byName(['sexo(_?(biol[oó]gico|al_?nacer|paciente|afiliado|cliente))?|(tp|tipo|cod|cd|id)_?sexo|g[eé]nero(?!_?(identidad|autopercibido))|sex|gender(?!_?identity)', 0.85]),
  byList([['uy-detectar-sexo.txt', ['f', 'm', 'h', 'femenino', 'masculino', 'mujer', 'hombre', 'female', 'male'], 0.5]], { reject: 0.5 }))

// ── L2 · Where people live ──────────────────────────────────────────────────
//
// Uruguay is divided into 19 departamentos and, for the census, into 652 localidades. They are
// small: 624 of the 652 had fewer than 20,000 inhabitants in the 2023 census — 873,000 people, a
// quarter of the country — and the smallest has a handful. A birth date, a sex and one of those
// localidades point at a handful of people, so a small localidad becomes the nearest one of at
// least 20,000 in the same departamento. Every departamento has one, so a generalized value never
// leaves its departamento, and the 19 departamentos stay.

const distance = (a, b) => {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}
const SMALL_PLACE = 20000
const nearest = (place, candidates) => candidates.reduce((best, x) => (distance(place, x) < distance(place, best) ? x : best))
const largeLocalidades = LOCALIDADES.filter((l) => l.population >= SMALL_PLACE)
const spellingsOf = (p) => unique([p.name, ...(p.aliases ?? [])])
const nameKey = (name) => fold(name).toLowerCase()
// How systems write a name: as it is, in capitals, and without accents. The INE publishes the names
// in capitals without their accents, so both spellings reach the table.
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
// With the departamento, as systems write it to tell homonyms apart: "Santa Lucía - Canelones".
const SEPARATORS = [[' - ', ''], [', ', ''], [' (', ')'], ['/', ''], ['-', '']]

/**
 * The generalization table. `places` carry name, `small`, `to` — the place they become — and
 * `qualifiers`, the parents systems write beside the name, each with the code that scopes the
 * homonyms. A name shared by several places is generalized only when all of them are small, to the
 * fate of the most populous; written with a qualifier, the same rule applies inside it.
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
    const target = from.to.outQualifiers.find((q) => q.level === qualifier.level) ?? qualifier
    for (const name of written) for (const [a, b] of SEPARATORS) pairs.push([`${name}${a}${qualifier.name}${b}`, `${from.to.name}${a}${target.name}${b}`])
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

const localidadPlaces = LOCALIDADES.map((l) => ({ ...l, small: l.population < SMALL_PLACE }))
const localidadByCode = new Map(localidadPlaces.map((l) => [l.code, l]))
const localidadTo = (l) => nearest(l, largeLocalidades.filter((x) => x.departmentCode === l.departmentCode))
for (const l of localidadPlaces) l.to = l.small ? localidadByCode.get(localidadTo(l).code) : l
// The departamento is the only qualifier, and it never changes: the target is always inside it.
for (const l of localidadPlaces) {
  l.qualifiers = [{ level: 'dep', code: l.departmentCode, name: l.department }]
  l.outQualifiers = l.qualifiers
}
// The 19 departamentos are all far above the threshold and are never generalized; they join the
// table only so that a name shared with a departamento is left alone.
const departmentPlaces = DEPARTAMENTOS.map((d) => ({ ...d, small: false, to: null, qualifiers: [], outQualifiers: [] }))
for (const d of departmentPlaces) d.to = d

const places = generalization([...localidadPlaces, ...departmentPlaces])
cleansing('UY_LOCALIDAD', 'uy-localidades-generalizadas.txt', places.table, 'Baltasar Brum', '|')

// Codes of the Instituto Nacional de Estadística: two digits for the departamento and five for the
// localidad. The codes follow the names.
const codePairs = localidadPlaces.filter((l) => l.small).map((l) => [l.code, l.to.code])
cleansing('UY_CODIGO_INE', 'uy-codigos-ine-generalizados.txt', codePairs, '02621', '|')

const PERSONAL_WORDS = new Set([...GIVEN_NAMES, ...SURNAMES].map((w) => fold(w).toLowerCase()))
const DEPARTMENT_NAMES = new Set([...DEPARTAMENTOS.map((d) => d.name), 'Uruguay'].map((n) => fold(n).toLowerCase()))
const placeNames = (list) => unique(list.flatMap(spellingsOf))
  .filter((n) => !PERSONAL_WORDS.has(fold(n).toLowerCase()) && !DEPARTMENT_NAMES.has(fold(n).toLowerCase()))

domain('UY_L2_LOCALIDAD', 'UY_LOCALIDAD',
  byName(['localidad(?!_?(cod|codigo|id))(_?(residencia|nacimiento|domicilio))?|ciudad(_?(residencia|nacimiento|domicilio|cliente))?|pueblo(?!_?(indigena|originario))|(nom|nombre|desc)_?(localidad|ciudad|pueblo)|lugar_?(de_?)?nacimiento|city|town', 0.85]),
  byList([['uy-detectar-localidades.txt', placeNames(LOCALIDADES), 0.8]], { reject: 0.4 }))

domain('UY_L2_CODIGO_INE', 'UY_CODIGO_INE',
  byName(['(cod|codigo|cd|id)_?(localidad|ciudad|lugar|ine)(_?(ine|censo|res|residencia|nac|nacimiento))?|c[oó]digo_?(ine|localidad|geogr[aá]fico)|codloc|cod_?dpto_?loc', 0.85]),
  byPattern([[String.raw`(0[1-9]|1[0-9])\d{3}`, 0.4]], { reject: 0.3 }))

lookup('UY_BARRIO', 'uy-barrios.txt', BARRIOS, 'Barrio Los Rosales', 'PRESERVE_LOOKUP_FILE')
domain('UY_L2_BARRIO', 'UY_BARRIO',
  byName(['barrio(_?(residencia|domicilio|nombre))?|balneario|zona(_?(residencia|domicilio))?|urbanizaci[oó]n|complejo(_?habitacional)?|asentamiento|(nom|nombre)_?(barrio|balneario|zona)|neighbou?rhood', 0.8]))

// Five digits: the first two are the departamento and the postal zone.
decompose('UY_CODIGO_POSTAL', [[String.raw`(\d{2})(\d{3})`, keep, redactAs('000')]], keep, '11300')
domain('UY_L2_CODIGO_POSTAL', 'UY_CODIGO_POSTAL',
  byName(['c[oó]digo_?postal|cod_?postal|codpostal|zip(_?code)?|postal_?code|cp', 0.85]),
  byType(STRING(5, 5), NUMBER(0, 5)))

const MARITAL = ['Soltero/a', 'Casado/a', 'Unión libre o concubinato', 'Separado/a', 'Divorciado/a', 'Viudo/a']
categorical('UY_ESTADO_CIVIL', 'uy-estado-civil.txt', MARITAL, 'Unión concubinaria', ['1', '2', '3', '4', '5', '6'])
domain('UY_L2_ESTADO_CIVIL', 'UY_ESTADO_CIVIL',
  byName(['estado_?civil|est_?civil|(cod|tipo|id)_?estado_?civil|situaci[oó]n_?conyugal|uni[oó]n_?(libre|concubinaria)|concubinato|marital_?status|civil_?status', 0.85]),
  byList([['uy-detectar-estado-civil.txt', [...MARITAL, 'soltero', 'soltera', 'casado', 'casada', 'unión libre', 'union libre', 'concubinato', 'concubino', 'separado', 'separada', 'divorciado', 'divorciada', 'viudo', 'viuda'], 0.7]], { reject: 0.4 }))

lookup('UY_OCUPACION', 'uy-ocupaciones.txt', ['Empleado administrativo', 'Vendedor', 'Cajero', 'Chofer', 'Repartidor', 'Albañil', 'Capataz de obra', 'Docente', 'Enfermero', 'Médico', 'Contador', 'Abogado', 'Ingeniero', 'Programador', 'Recepcionista', 'Personal de limpieza', 'Guardia de seguridad', 'Cocinero', 'Mozo', 'Electricista', 'Sanitario', 'Mecánico', 'Peón rural', 'Tambero', 'Esquilador', 'Operario de frigorífico', 'Asesor comercial', 'Teleoperador', 'Depositero', 'Peluquero', 'Costurera', 'Feriante', 'Ama de casa', 'Estudiante', 'Jubilado', 'Taxista', 'Portuario', 'Forestal'], 'Gerente de operaciones')
decompose('UY_OCUPACION_O_CODIGO', [
  // Clasificación Nacional de Ocupaciones: four digits.
  [String.raw`(\d{2,5})`, DIGITS],
], apply('UY_OCUPACION'), 'Gerente de operaciones')
domain('UY_L2_OCUPACION', 'UY_OCUPACION_O_CODIGO',
  byName(
    ['ocupaci[oó]n|profesi[oó]n|oficio|cno|ciuo|(cod|codigo)_?(ocupacion|profesion|cno|ciuo)|puesto_?(de_?)?trabajo|categor[ií]a_?ocupacional|cargo_?(actual|empleado)|occupation|profession|job_?title', 0.8],
    ['cargo|puesto', 0.5],
  ))

lookup('UY_EMPLEADOR', 'uy-empleadores.txt', ['Distribuidora del Plata S.A.', 'Constructora Oriental S.A.', 'Transportes Santa Lucía S.R.L.', 'Supermercados del Centro S.A.', 'Industrias Metálicas Rincón S.R.L.', 'Sanatorio Santa Teresa S.A.', 'Liceo Nuevo Amanecer', 'Servicios Integrales del Norte S.R.L.', 'Agropecuaria Cuchilla Grande S.A.', 'Comercial Los Álamos S.R.L.', 'Soluciones Digitales Uruguay S.A.', 'Restaurante Sabor Criollo S.R.L.', 'Hotel Mirador del Río S.A.', 'Laboratorio Vida Sana S.R.L.', 'Seguridad Vigía S.R.L.', 'Textiles La Aguja S.R.L.', 'Repuestos del Este S.R.L.', 'Farmacia El Buen Vecino', 'Logística Puerto Nuevo S.A.', 'Cooperativa Agraria La Unión', 'Fundación Manos Unidas', 'Panadería Pan de Casa', 'Estudio Contable Asociados S.R.L.', 'Forestal Tacuarembó S.A.'], 'Corporación Comercial Oriental S.A.', 'PRESERVE_LOOKUP_FILE')
domain('UY_L2_EMPLEADOR', 'UY_EMPLEADOR',
  byName(['empleador(_?(nombre|raz[oó]n_?social|rut))?|(nombre|nom)_?(empleador|empresa_?donde_?trabaja|patrono)|empresa_?(donde_?)?(trabaja|labora)|lugar_?(de_?)?trabajo|centro_?(de_?)?trabajo|entidad_?empleadora|employer(_?name)?|workplace', 0.9]))

const EDUCATION = ['Sin instrucción', 'Preescolar', 'Primaria', 'Ciclo básico', 'Bachillerato', 'Enseñanza técnica (UTU)', 'Magisterio o profesorado', 'Terciario no universitario', 'Universidad', 'Posgrado']
categorical('UY_NIVEL_EDUCATIVO', 'uy-nivel-educativo.txt', EDUCATION, 'Educación terciaria en curso', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
domain('UY_L2_NIVEL_EDUCATIVO', 'UY_NIVEL_EDUCATIVO',
  byName(['escolaridad|nivel_?(educativo|de_?estudios|acad[eé]mico|alcanzado|de_?instrucci[oó]n)|instrucci[oó]n(_?formal)?|grado_?(de_?)?(estudio|instrucci[oó]n|escolaridad)|m[aá]ximo_?nivel|a[nñ]os_?(de_?)?estudio|education(_?level)?', 0.8]),
  byList([['uy-detectar-nivel-educativo.txt', [...EDUCATION, 'sin instrucción', 'primaria', 'ciclo básico', 'bachillerato', 'utu', 'magisterio', 'terciario', 'universidad', 'posgrado', 'maestría', 'doctorado'], 0.6]], { reject: 0.4 }))

lookup('UY_INSTITUCION_EDUCATIVA', 'uy-instituciones-educativas.txt', ['Escuela N.º 123 Artigas', 'Escuela N.º 45 José Pedro Varela', 'Liceo N.º 7 de Montevideo', 'Liceo Departamental', 'Escuela Técnica UTU de Paysandú', 'Colegio y Liceo Nuestra Señora del Rosario', 'Instituto de Formación Docente', 'Universidad de la República', 'Universidad Tecnológica', 'Escuela Rural N.º 88', 'Centro Educativo Asociado', 'Instituto Superior de Educación Física'], 'Universidad de la República')
domain('UY_L2_INSTITUCION_EDUCATIVA', 'UY_INSTITUCION_EDUCATIVA',
  byName(['instituci[oó]n_?educativa|centro_?(educativo|de_?estudios)|escuela|liceo|colegio|instituto|universidad|utu|(nombre|nom)_?(escuela|liceo|colegio|universidad|institucion_?educativa)|c[oó]digo_?(de_?)?(escuela|liceo|centro)|school(_?name)?|university', 0.75]))

// Capped at 5 as text: large households are rare, and a rare count identifies.
decompose('UY_CONTEO_LIMITADO', [[String.raw`([0-5])`, keep], [String.raw`(\d+)`, redactAs('5')]], keep, '9')
domain('UY_L2_PERSONAS_A_CARGO', 'UY_CONTEO_LIMITADO',
  byName(['personas_?a_?cargo|n(o|ro|um|umero)_?(de_?)?(hijos|dependientes|personas_?a_?cargo|beneficiarios)|cant(idad)?_?(hijos|dependientes|personas_?hogar|integrantes|miembros)|hijos|dependientes|integrantes_?(del_?)?hogar|personas_?(en_?el_?)?hogar|tama[nñ]o_?(del_?)?hogar|number_?of_?children|dependents', 0.8]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// ── L3 · Sensitive data (art. 4 E and art. 4 Ñ) ─────────────────────────────
//
// Article 4 E) is short and old: "datos personales que revelen origen racial y étnico, preferencias
// políticas, convicciones religiosas **o morales**, afiliación sindical e informaciones referentes
// a la salud o a la vida sexual". Article 18 forbids building databases that store information
// which **directly or indirectly** reveals sensitive data, and allows statistical or scientific
// treatment only when the data is dissociated from its subjects. Article 4 Ñ), added by Ley 19.924
// in 2020, defines the biometric datum, and article 18-BIS requires an impact assessment before
// processing it. Health has a group of its own below; the rest is here.

// The 2023 census asked about ascendencia, and lets a person name more than one.
const ASCENDENCIA = ['Afro o negra', 'Asiática o amarilla', 'Blanca', 'Indígena', 'Otra', 'Ninguna']
categorical('UY_ASCENDENCIA', 'uy-ascendencia.txt', ASCENDENCIA, 'Afrodescendiente', ['1', '2', '3', '4', '5', '6'])
domain('UY_L3_ASCENDENCIA', 'UY_ASCENDENCIA',
  byName(['ascendencia(_?[eé]tnico?_?racial)?|etnia|origen_?([eé]tnico|racial)|grupo_?[eé]tnico|pertenencia_?[eé]tnica|autoidentificaci[oó]n(_?[eé]tnica)?|autodefinici[oó]n|(cod|codigo|tipo|id)_?(etnia|ascendencia)|raza|afrodescendiente|afro|ind[ií]gena|ethnicity|race', 0.95]),
  byList([['uy-detectar-ascendencia.txt', [...ASCENDENCIA, 'afro', 'negra', 'negro', 'afrodescendiente', 'asiática', 'amarilla', 'blanca', 'blanco', 'indígena', 'charrúa', 'otra', 'ninguna'], 0.9],
    ['uy-detectar-codigos-banderas.txt', ['s', 'n', 'sí', 'no', '1', '2', '3', '4', '5', '6'], 0.3],
  ], { reject: 0.4 }))

// Uruguay's indigenous peoples were declared extinct for a century; the census brought the charrúa
// descendants back into the count, and naming the people names a few thousand people.
const PUEBLOS = ['Charrúa', 'Guaraní', 'Chaná', 'Minuán', 'Otro pueblo originario', 'No pertenece a ningún pueblo']
categorical('UY_PUEBLO', 'uy-pueblos.txt', PUEBLOS, 'Pueblo originario')
domain('UY_L3_PUEBLO_ORIGINARIO', 'UY_PUEBLO',
  byName(['pueblo_?(ind[ií]gena|originario)|nacionalidad_?ind[ií]gena|pertenece_?(a_?)?(pueblo|comunidad)|comunidad_?(ind[ií]gena|originaria)|charr[uú]a|indigenous_?people', 0.9]),
  byList([['uy-detectar-pueblos.txt', [...PUEBLOS, 'charrúa', 'charrua', 'guaraní', 'chaná', 'minuán', 'originario'], 0.85]], { reject: 0.4 }))

// The law does not name nationality, but it sits beside the racial and ethnic origin it does name,
// and in Uruguay it separates the nationals from the Venezuelan and Cuban communities.
const COUNTRIES = ['Uruguaya', 'Argentina', 'Brasileña', 'Venezolana', 'Cubana', 'Paraguaya', 'Peruana', 'Chilena', 'Boliviana', 'Colombiana', 'Española', 'Italiana', 'Rusa', 'Estadounidense']
lookup('UY_NACIONALIDAD', 'uy-nacionalidades.txt', COUNTRIES, 'Panameña')
domain('UY_L3_NACIONALIDAD', 'UY_NACIONALIDAD',
  byName(['nacionalidad|pa[ií]s_?(de_?)?(nacimiento|origen|nacionalidad|procedencia)|ciudadan[ií]a(_?(legal|natural))?|nationality|citizenship|country_?of_?birth|condici[oó]n_?(de_?)?(migratoria|refugiado)|persona_?(migrante|refugiada)', 0.85]),
  byList([['uy-detectar-nacionalidades.txt', [...COUNTRIES, 'uruguayo', 'uruguaya', 'argentino', 'brasileño', 'venezolano', 'cubano', 'paraguayo', 'peruano', 'chileno', 'boliviano', 'colombiano', 'español', 'italiano', 'uruguay', 'argentina', 'brasil', 'venezuela', 'cuba', 'extranjero', 'extranjera'], 0.7]], { reject: 0.4 }))

// Uruguay is the most secular country of the region: "creyente sin religión" and "ateo o agnóstico"
// are the second and third largest answers, and the umbandista faith is counted on its own.
const RELIGIONS = ['Católica', 'Cristiana no católica', 'Evangélica', 'Umbandista o afroumbandista', 'Testigo de Jehová', 'Judía', 'Otra', 'Creyente sin religión', 'Ateo o agnóstico', 'Ninguna']
categorical('UY_RELIGION', 'uy-religiones.txt', RELIGIONS, 'Ortodoxa')
domain('UY_L3_RELIGION', 'UY_RELIGION',
  byName(['religi[oó]n|creencia_?(religiosa|espiritual)|convicci[oó]n(es)?_?(religiosa|espiritual)|credo|confesi[oó]n_?religiosa|culto|iglesia(_?(a_?la_?que_?pertenece|nombre))?|denominaci[oó]n_?religiosa|(cod|codigo|tipo)_?religion|religion|church', 0.95]),
  byList([['uy-detectar-religiones.txt', [...RELIGIONS, 'católico', 'catolico', 'cristiano', 'cristiana', 'evangélico', 'umbandista', 'testigo de jehová', 'judío', 'ateo', 'agnóstico', 'creyente', 'ninguna', 'ninguno'], 0.9]], { reject: 0.4 }))

// Article 4 E) names the **convicciones morales** in the same breath as the religious ones — a
// category only El Salvador and Peru list as well.
domain('UY_L3_CONVICCION_MORAL', 'UY_CATEGORIA_SUPRIMIDA',
  byName(['convicci[oó]n(es)?_?(morales?|filos[oó]ficas?|personales?|[eé]ticas?)|creencias?_?(morales?|filos[oó]ficas?|personales?)|objeci[oó]n_?(de_?)?conciencia|objetor_?(de_?)?conciencia|masoner[ií]a|logia|beliefs?|moral_?beliefs?', 0.9]))

// "Preferencias políticas" — the law's own words, and in a country where the Corte Electoral keeps
// the internal-election rolls this is a real column.
const IDEOLOGIES = ['Izquierda', 'Centroizquierda', 'Centro', 'Centroderecha', 'Derecha', 'Independiente', 'Prefiere no responder']
categorical('UY_PREFERENCIA_POLITICA', 'uy-preferencias-politicas.txt', IDEOLOGIES, 'Oficialista')
domain('UY_L3_PREFERENCIA_POLITICA', 'UY_PREFERENCIA_POLITICA',
  byName(['preferencias?_?(pol[ií]tica|partidaria|electoral)|ideolog[ií]a(_?pol[ií]tica)?|opini[oó]n_?pol[ií]tica|orientaci[oó]n_?pol[ií]tica|tendencia_?pol[ií]tica|intenci[oó]n_?(de_?)?voto|simpat[ií]a_?pol[ií]tica|political_?(opinion|orientation|view|preference)|voting_?intention', 0.95]),
  byList([['uy-detectar-preferencias-politicas.txt', [...IDEOLOGIES, 'izquierda', 'derecha', 'centro', 'progresista', 'conservador', 'independiente', 'indeciso', 'voto en blanco', 'ninguno'], 0.7]], { reject: 0.4 }))

// The parties on the Corte Electoral's register; the internal elections make membership a record.
const PARTIES = ['Frente Amplio', 'Partido Nacional', 'Partido Colorado', 'Cabildo Abierto', 'Partido Independiente', 'Identidad Soberana', 'Partido Ecologista Radical Intransigente', 'Partido Constitucional Ambientalista', 'Asamblea Popular', 'Sin afiliación']
categorical('UY_PARTIDO', 'uy-partidos.txt', PARTIES, 'Partido Socialista')
domain('UY_L3_AFILIACION_PARTIDARIA', 'UY_PARTIDO',
  byName(['partido(_?pol[ií]tico)?(_?(afiliaci[oó]n|nombre))?|lema(_?partidario)?|sublema|agrupaci[oó]n_?pol[ií]tica|afiliaci[oó]n_?(pol[ií]tica|partidaria|partido)|militancia(_?pol[ií]tica)?|militante|(cod|codigo|nombre|nom)_?partido|hoja_?de_?votaci[oó]n|political_?party|party_?membership', 0.95]),
  byList([['uy-detectar-partidos.txt', [...PARTIES, 'FA', 'PN', 'PC', 'CA', 'PI', 'Frente Amplio', 'Partido Nacional', 'Partido Colorado', 'Cabildo Abierto'], 0.8]], { reject: 0.4 }))

// Article 4 E) names the afiliación sindical, and article 18 lets a union keep the data of its own
// members — which is exactly the database this domain protects everywhere else.
domain('UY_L3_AFILIACION_SINDICAL', 'UY_CATEGORIA_SUPRIMIDA',
  byName(['sindicato(_?(nombre|afiliado|afiliaci[oó]n|codigo))?|sindicalizado|afiliado_?sindicato|afiliaci[oó]n_?sindical|cuota_?sindical|descuento_?sindical|aporte_?sindical|asociaci[oó]n_?(sindical|de_?funcionarios)|gremio|consejo_?de_?salarios|fuero_?sindical|dirigente_?sindical|trade_?union|union_?member(ship)?', 0.95]),
  byList([['uy-detectar-sindicatos.txt', ['PIT-CNT', 'PIT CNT', 'FUECYS', 'SUNCA', 'AEBU', 'FFOSE', 'COFE', 'ADEOM', 'SUTEL', 'FUM-TEP', 'UNTMRA', 'FENAPES', 'Gremio', 'sindicalizado', 'afiliado'], 0.6]], { reject: 0.3 }))

// Article 4 Ñ), added in 2020: the biometric datum is the one that permits or confirms the unique
// identification of a person. Article 18-BIS requires an impact assessment before processing it.
domain('UY_L3_BIOMETRICO', 'UY_REDACTAR',
  byName(['biometr[ií]a[a-z_]*|biom[eé]trico[a-z_]*|huella(_?(dactilar|digital))?(_?(template|plantilla|imagen|hash))?|huellas|dactilar|dactilosc[oó]pic[oa]|template_?(facial|huella|biometrico)|plantilla_?(facial|biom[eé]trica)|rostro_?(hash|template)|reconocimiento_?(facial|de_?voz)|firma_?(biom[eé]trica|digitalizada|electr[oó]nica)|iris|voz_?(biom[eé]trica|template)|fingerprints?|face_?(template|hash|encoding)|biometric[a-z_]*', 0.9]),
  byType(STRING()))

domain('UY_L3_GENETICO', 'UY_REDACTAR',
  byName(['adn|dna|gen[eé]tic[oa]s?|datos?_?gen[eé]ticos?|genoma|genotip[a-z_]*|prueba_?(gen[eé]tica|de_?adn|de_?paternidad|de_?filiaci[oó]n)|perfil_?gen[eé]tico|mutaci[oó]n|brca[12]?|cariotipo|pesquisa_?neonatal|genetic[a-z_]*', 0.9]))

const ORIENTATIONS = ['Heterosexual', 'Gay', 'Lesbiana', 'Bisexual', 'Pansexual', 'Asexual', 'Otra', 'Prefiere no responder']
categorical('UY_ORIENTACION_SEXUAL', 'uy-orientaciones-sexuales.txt', ORIENTATIONS, 'Homosexual')
domain('UY_L3_ORIENTACION_SEXUAL', 'UY_ORIENTACION_SEXUAL',
  byName(['orientaci[oó]n_?sexual|preferencias?_?sexuales?|(cod|codigo|tipo)_?orientacion_?sexual|sexual_?orientation', 0.95]),
  byList([['uy-detectar-orientaciones-sexuales.txt', [...ORIENTATIONS, 'hetero', 'homosexual', 'lgbti', 'lgbtiq+', 'queer'], 0.8]], { reject: 0.4 }))

// "Informaciones referentes a … la vida sexual" — named word for word in article 4 E).
domain('UY_L3_VIDA_SEXUAL', 'UY_CATEGORIA_SUPRIMIDA',
  byName(['vida_?sexual|actividad_?sexual|conducta_?sexual|pr[aá]cticas?_?sexuales?|parejas?_?sexuales?|n(o|ro|um|umero)_?parejas|sexualmente_?activ[oa]|inicio_?(de_?)?(la_?)?vida_?sexual|relaciones_?sexuales|sex(ual)?_?life|sexual_?(activity|behavio(u)?r|partners)', 0.9]))

// The Ley 19.684 integral para personas trans created a register and a reparation quota, so gender
// identity is a real column in Uruguayan systems.
const IDENTITIES = ['Mujer cisgénero', 'Hombre cisgénero', 'Mujer trans', 'Hombre trans', 'Persona no binaria', 'Otra', 'Prefiere no responder']
categorical('UY_IDENTIDAD_GENERO', 'uy-identidades-genero.txt', IDENTITIES, 'Transgénero')
domain('UY_L3_IDENTIDAD_GENERO', 'UY_IDENTIDAD_GENERO',
  byName(['identidad_?(de_?)?g[eé]nero|(cod|codigo|tipo)_?identidad_?genero|g[eé]nero_?(autopercibido|identitario)|expresi[oó]n_?de_?g[eé]nero|transg[eé]nero|persona_?trans|registro_?(de_?personas_?)?trans|nombre_?social|pronombres?|gender_?identity', 0.95]),
  byList([['uy-detectar-identidades-genero.txt', [...IDENTITIES, 'cisgénero', 'cis', 'transgénero', 'trans', 'no binario', 'no binaria', 'mujer', 'hombre'], 0.7]], { reject: 0.4 }))

// The Ley 19.580 de violencia hacia las mujeres protects the identity of the victim, and article 18
// reaches the data whose improper use discriminates.
domain('UY_L3_VICTIMA', 'UY_CATEGORIA_SUPRIMIDA',
  byName(['v[ií]ctima(_?(de_?)?(violencia(_?(de_?g[eé]nero|dom[eé]stica|intrafamiliar|sexual|psicol[oó]gica|econ[oó]mica))?|delito|trata|abuso|desaparici[oó]n))?|violencia_?(de_?)?g[eé]nero|violencia_?(dom[eé]stica|intrafamiliar|sexual|psicol[oó]gica)|tipo_?(de_?)?violencia|medida_?(de_?)?(protecci[oó]n|cautelar)|tobillera_?electr[oó]nica|trata_?(de_?)?personas|denunciante_?violencia', 0.9]))

// ── SALUD · Health data (art. 4 E, art. 17 C and art. 19) ───────────────────
//
// Article 19 lets sanitary establishments and health professionals process the data of the patients
// who come to them, "respetando los principios del secreto profesional". Article 17 C) lets health
// data be communicated for sanitary, emergency or epidemiological reasons while "preservando la
// identidad de los titulares de los datos mediante **mecanismos de disociación adecuados**" — the
// sentence this group is written for.

domain('UY_SALUD_IDENTIFICADOR', 'UY_CM_ALFANUM',
  byName(
    ['n(o|ro|um|umero)_?(historia(_?cl[ií]nica)?|hc|hce|ficha(_?cl[ií]nica)?|episodio|ingreso|atenci[oó]n|consulta|cita|receta)|historia_?cl[ií]nica(_?electr[oó]nica)?|hc_?(n(o|ro|um|umero))?|n(o|ro|um|umero)_?(afiliado|socio|carn[eé]_?asistencia)|c[oó]digo_?(paciente|historia|atenci[oó]n)|id_?paciente', 0.85],
    ['expediente|atenci[oó]n|ingreso|consulta|episodio', 0.55],
  ))

const COVERAGE = ['ASSE', 'Mutualista (IAMC)', 'Seguro privado integral', 'Sanidad Militar', 'Sanidad Policial', 'Hospital de Clínicas', 'Policlínica municipal', 'Sin cobertura']
decompose('UY_COBERTURA_SALUD', [
  [FLAG, apply('UY_BANDERA')],
  [String.raw`(\d{1,8})`, DIGITS],
], apply(lookup('UY_COBERTURA', 'uy-cobertura-salud.txt', COVERAGE, undefined, 'PRESERVE_LOOKUP_FILE')), 'ASSE')
domain('UY_SALUD_COBERTURA', 'UY_COBERTURA_SALUD',
  byName(['cobertura(_?(m[eé]dica|de_?salud|asistencial))?|seguro_?(m[eé]dico|salud)|prestador(_?(de_?)?salud)?|r[eé]gimen(_?(de_?)?salud)?|tipo_?(de_?)?(seguro|cobertura)|asse|mutualista|iamc|fonasa|sanidad_?(militar|policial)|emergencia_?m[oó]vil|aseguradora_?(m[eé]dica|salud)|plan_?(m[eé]dico|de_?salud)', 0.85]),
  byList([['uy-detectar-cobertura.txt', [...COVERAGE, 'asse', 'mutualista', 'iamc', 'fonasa', 'sanidad', 'privado', 'sin cobertura'], 0.8]], { reject: 0.4 }))

const ICD10 = ['I10', 'E11', 'E78', 'J45', 'J06', 'J02', 'J20', 'K29', 'K21', 'K59', 'M54', 'M17', 'M25', 'N39', 'N20', 'R51', 'R10', 'H10', 'H66', 'L23', 'L30', 'B34', 'A09', 'E03', 'E66', 'D50', 'I83', 'K80', 'K40', 'S93', 'S60', 'Z00', 'J30', 'J32', 'G43', 'M79', 'R05']
const ICD10_DECIMAL = ['E11.9', 'E78.5', 'J45.9', 'J06.9', 'J02.9', 'J20.9', 'K29.7', 'K21.9', 'K59.0', 'M54.5', 'M17.9', 'N39.0', 'N20.0', 'R10.4', 'H10.9', 'H66.9', 'L23.9', 'L30.9', 'B34.9', 'A09.9', 'E03.9', 'E66.9', 'D50.9', 'I83.9', 'K80.2', 'K40.9', 'S93.4', 'S60.0', 'Z00.0', 'J30.4', 'J32.9', 'G43.9', 'M79.1']
decompose('UY_DIAGNOSTICO', [
  [String.raw`([A-TV-Za-tv-z]\d{2}\.\d{1,2})`, apply(lookup('UY_CIE10_DECIMAL', 'uy-cie10-decimal.txt', ICD10_DECIMAL, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [String.raw`([A-TV-Za-tv-z]\d{2,3}X?)`, apply(lookup('UY_CIE10', 'uy-cie10.txt', ICD10, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [FLAG, apply('UY_BANDERA')],
], apply(lookup('UY_DIAGNOSTICO_TEXTO', 'uy-diagnosticos.txt', ['Hipertensión arterial', 'Diabetes mellitus tipo 2', 'Asma', 'Lumbalgia', 'Gastritis crónica', 'Faringitis aguda', 'Infección urinaria', 'Migraña', 'Hipotiroidismo', 'Dislipemia', 'Obesidad', 'Artrosis de rodilla', 'Bronquitis aguda', 'Amigdalitis aguda', 'Dermatitis de contacto', 'Otitis media aguda', 'Esguince de tobillo', 'Conjuntivitis', 'Anemia ferropénica', 'Reflujo gastroesofágico', 'Síndrome de intestino irritable', 'Tendinitis', 'Sinusitis aguda', 'Cefalea tensional', 'Várices', 'Hernia inguinal', 'Litiasis renal', 'Colelitiasis', 'Gastroenteritis aguda', 'Control en salud'])), 'F33.1')
domain('UY_SALUD_DIAGNOSTICO', 'UY_DIAGNOSTICO',
  byName(['diagn[oó]stico[a-z_]*|dx(_?(principal|secundario|ingreso|egreso)[0-9]?)?|cie_?10|cie(_?(10|11|principal))?|(cod|codigo)_?(diagnostico|dx|cie)|impresi[oó]n_?diagn[oó]stica|enfermedad(es)?[a-z_]*|patolog[ií]a|comorbilidad(es)?|antecedentes?_?(m[eé]dicos|patol[oó]gicos|cl[ií]nicos|personales)|causa_?(de_?)?(muerte|defunci[oó]n|incapacidad|internaci[oó]n|consulta)|motivo_?(de_?)?(consulta|certificaci[oó]n|internaci[oó]n)|alergias?|diagnos(is|es)|icd_?(10|11)?', 0.85]),
  byPattern([[String.raw`[A-TV-Za-tv-z]\d{2}(\.\d{1,2}|\d|X)?`, 0.5]], { reject: 0.3 }))

decompose('UY_PROCEDIMIENTO', [[String.raw`(\d{4,6})`, DIGITS]], apply(lookup('UY_PROCEDIMIENTO_TEXTO', 'uy-procedimientos.txt', ['Consulta médica general', 'Consulta de emergencia', 'Hemograma completo', 'Glicemia', 'Examen de orina', 'Creatininemia', 'Radiografía de tórax', 'Ecografía abdominal', 'Electrocardiograma', 'Control obstétrico'])), 'Prueba de carga viral para VIH')
domain('UY_SALUD_PROCEDIMIENTO', 'UY_PROCEDIMIENTO',
  byName(['procedimiento(_?(m[eé]dico|quir[uú]rgico|realizado|autorizado))?|(cod|codigo)_?(procedimiento|prestaci[oó]n|servicio_?salud)|prestaci[oó]n_?(m[eé]dica|de_?salud)|examen_?(ordenado|realizado)|cirug[ií]a(_?realizada)?|intervenci[oó]n_?quir[uú]rgica|t[eé]cnica_?(diagn[oó]stica|quir[uú]rgica)|medical_?procedure', 0.85]))

const MEDICATIONS = ['Paracetamol', 'Ibuprofeno', 'Diclofenac', 'Metformina', 'Glibenclamida', 'Losartán', 'Enalapril', 'Amlodipina', 'Atorvastatina', 'Omeprazol', 'Levotiroxina', 'Amoxicilina', 'Cefradina', 'Salbutamol', 'Loratadina', 'Hidroclorotiazida', 'Ácido acetilsalicílico', 'Prednisona', 'Azitromicina', 'Sulfato ferroso', 'Ácido fólico', 'Complejo B']
categorical('UY_MEDICAMENTO', 'uy-medicamentos.txt', MEDICATIONS, 'Sertralina 50 mg')
domain('UY_SALUD_MEDICAMENTO', 'UY_MEDICAMENTO',
  byName(['medicamentos?(_?(recetado|prescrito|entregado|despachado|nombre|uso))?|f[aá]rmacos?|principio_?activo|denominaci[oó]n_?com[uú]n_?internacional|dci|receta(_?m[eé]dica)?|prescripci[oó]n(_?medicamento)?|posolog[ií]a|tratamiento_?farmacol[oó]gico|(cod|codigo)_?medicamento|formulario_?terap[eé]utico|medications?|drugs?_?prescribed', 0.85]),
  byList([['uy-detectar-medicamentos.txt', [...MEDICATIONS, 'paracetamol', 'sertralina', 'fluoxetina', 'escitalopram', 'quetiapina', 'clonazepam', 'alprazolam', 'lorazepam', 'litio', 'metilfenidato', 'risperidona', 'olanzapina', 'haloperidol', 'tenofovir', 'emtricitabina', 'dolutegravir', 'efavirenz', 'insulina', 'warfarina', 'levetiracetam', 'ácido valproico', 'misoprostol', 'levonorgestrel', 'anticonceptivo'], 0.7]], { reject: 0.3 }))

domain('UY_SALUD_TEXTO_CLINICO', 'UY_TEXTO_LIBRE',
  byName(['anamnesis|evoluci[oó]n(_?(m[eé]dica|cl[ií]nica|enfermer[ií]a))?|enfermedad_?actual|examen_?f[ií]sico|plan_?(de_?)?(manejo|tratamiento)|indicaciones_?m[eé]dicas|conducta(_?m[eé]dica)?|epicrisis|resumen_?(de_?)?(alta|egreso|atenci[oó]n)|nota_?(m[eé]dica|de_?enfermer[ií]a|cl[ií]nica)|notas?_?(m[eé]dicas|cl[ií]nicas)|triaje(_?texto)?|informe_?(patolog[ií]a|radiolog[ií]a|m[eé]dico)|clinical_?notes?|discharge_?summary', 0.85]),
  byType(STRING(30)))

domain('UY_SALUD_RESULTADO_EXAMEN', 'UY_CM_ALFANUM',
  byName(
    ['resultado_?(del_?)?(examen|prueba|an[aá]lisis|laboratorio|pcr|serolog[ií]a|biopsia|glicemia|citolog[ií]a|papanicolaou)|(examen|prueba|an[aá]lisis)_?(resultado|laboratorio)|glicemia|hemoglobina(_?glicosilada)?|hba1c|colesterol|imc|presi[oó]n_?arterial|test_?(de_?)?embarazo|espirometr[ií]a|alcoholemia|lab_?results?|test_?results?', 0.8],
    ['resultado|prueba|analisis', 0.5],
  ))

// The Ley 18.987 and the Ley 18.426 on sexual and reproductive health, and the Ley 18.256 on
// tobacco, all bind the record; the HIV result is protected by the Ley 18.335 de derechos del
// paciente and by medical secrecy.
domain('UY_SALUD_VIH', 'UY_CATEGORIA_SUPRIMIDA',
  byName(['vih(_?(estado|resultado|prueba|diagn[oó]stico|positivo))?|hiv|sida|aids|serolog[ií]a_?(vih|hiv)|estado_?serol[oó]gico|carga_?viral|cd4|tarv|antirretroviral(es)?|its|ets|infecci[oó]n(es)?_?(de_?)?transmisi[oó]n_?sexual|s[ií]filis|hepatitis_?[bc]|tuberculosis|tbc', 0.9]))

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']
lookup('UY_GRUPO_SANGUINEO', 'uy-grupos-sanguineos.txt', BLOOD_GROUPS, 'O+', 'PRESERVE_LOOKUP_FILE')
domain('UY_SALUD_GRUPO_SANGUINEO', 'UY_GRUPO_SANGUINEO',
  byName(['grupo_?sangu[ií]neo|tipo_?(de_?)?sangre|rh|factor_?rh|gs_?rh|grupo_?rh|abo(_?rh)?|blood_?(type|group)', 0.9]),
  byList([['uy-detectar-grupos-sanguineos.txt', [...BLOOD_GROUPS, '0+', '0-', 'a positivo', 'a negativo', 'b positivo', 'b negativo', 'ab positivo', 'ab negativo', 'o positivo', 'o negativo'], 0.9]], { reject: 0.4 }))

const DISABILITIES = ['Física o motriz', 'Auditiva', 'Visual', 'Intelectual', 'Psíquica o mental', 'Múltiple', 'Ninguna']
categorical('UY_DISCAPACIDAD', 'uy-discapacidades.txt', DISABILITIES, 'Trastorno del espectro autista')
domain('UY_SALUD_DISCAPACIDAD', 'UY_DISCAPACIDAD',
  byName(['discapacidad[a-z_]*|(tipo|cod|codigo|categoria|porcentaje|grado)_?discapacidad|persona_?con_?discapacidad|pcd|certificado_?(de_?)?discapacidad|bpc_?discapacidad|pronadis|condici[oó]n_?(de_?)?discapacidad|necesidades_?(educativas_?)?especiales|movilidad_?reducida|disabilit(y|ies)', 0.9]),
  byList([['uy-detectar-discapacidades.txt', [...DISABILITIES, 'física', 'motriz', 'auditiva', 'sordera', 'visual', 'ceguera', 'intelectual', 'psíquica', 'mental', 'múltiple', 'autismo', 'ninguna', 'no aplica'], 0.6]], { reject: 0.3 }))

// The carné de salud básico is compulsory for every worker in Uruguay, which puts a health
// certificate in the personnel table of almost every employer.
categorical('UY_APTITUD_LABORAL', 'uy-aptitud-laboral.txt', ['Apto', 'Apto con restricciones', 'No apto', 'Pendiente'], 'No apto temporalmente')
domain('UY_SALUD_OCUPACIONAL', 'UY_APTITUD_LABORAL',
  byName(['carn[eé]_?(de_?)?salud(_?(basico|b[aá]sico|laboral|vencimiento))?|aptitud_?(laboral|m[eé]dica)|certificado_?(de_?)?aptitud|examen_?(m[eé]dico_?)?(ocupacional|preocupacional|de_?ingreso|de_?egreso|peri[oó]dico)|accidente_?(de_?)?trabajo|enfermedad_?(laboral|profesional|ocupacional)|bse_?(siniestro|accidente)|incapacidad(_?(m[eé]dica|laboral|d[ií]as))?|certificaci[oó]n_?m[eé]dica|d[ií]as_?(de_?)?(incapacidad|certificaci[oó]n)|licencia_?(m[eé]dica|por_?enfermedad|maternal)|ausentismo', 0.85]),
  byList([['uy-detectar-aptitud-laboral.txt', ['apto', 'no apto', 'apto con restricciones', 'pendiente', 'apto con recomendaciones'], 0.6]], { reject: 0.3 }))

domain('UY_SALUD_REPRODUCTIVA', 'UY_CATEGORIA_SUPRIMIDA',
  byName(['embarazo|embarazada|gestante|gestaci[oó]n|edad_?gestacional|semanas_?(de_?)?gestaci[oó]n|fum|fecha_?[uú]ltima_?(regla|menstruaci[oó]n)|control_?(obst[eé]trico|prenatal)|prenatal|parto(_?tipo)?|ces[aá]rea|interrupci[oó]n_?(del_?)?embarazo|aborto|m[eé]todo_?(de_?)?anticoncepci[oó]n|planificaci[oó]n_?familiar|anticoncepci[oó]n|anticonceptivo|fertilidad|salud_?(sexual|reproductiva)|pregnan(t|cy)|contracepti(on|ve)', 0.9]))

domain('UY_SALUD_MENTAL', 'UY_CATEGORIA_SUPRIMIDA',
  byName(['salud_?mental|trastorno[a-z_]*|psiqui[aá]tri[a-z_]*|psicol[oó]gi[a-z_]*|depresi[oó]n|ansiedad|suicid[a-z_]*|intento_?(de_?)?autoeliminaci[oó]n|iae|intento_?(de_?)?suicidio|autolesi[oó]n|consumo_?(de_?)?(sustancias|alcohol|drogas)|adicci[oó]n(es)?|alcoholismo|tabaquismo|mental_?health', 0.9]))

// ── FIN · Commercial and credit data (art. 22) ──────────────────────────────
//
// Article 22 authorizes the processing of data on patrimonial or credit solvency from public
// sources or from the creditor, and sets a hard limit only Uruguay writes this way: the data on a
// natural person's commercial obligations may be registered for **five years**, renewable once, and
// a settled obligation stays for five more, not renewable. Whoever copies such a database into a
// test environment copies the clock with it.

decompose('UY_HISTORIAL_CREDITICIO', [
  [String.raw`(\d{1,4})`, DIGITS],
  [FLAG, apply('UY_BANDERA')],
], apply(lookup('UY_ESTADO_CREDITO', 'uy-estados-credito.txt', ['Categoría 1C — riesgo mínimo', 'Categoría 1A — riesgo bajo', 'Categoría 2A — riesgo medio', 'Categoría 2B — riesgo medio alto', 'Categoría 3 — riesgo alto', 'Categoría 4 — muy alto', 'Categoría 5 — irrecuperable', 'Al día', 'Informado en el Clearing de Informes', 'En gestión de cobranza', 'Refinanciado', 'Castigado', 'Sin historial crediticio'])), 'Informado en el Clearing de Informes')
domain('UY_FIN_HISTORIAL_CREDITICIO', 'UY_HISTORIAL_CREDITICIO',
  byName(['historial_?(crediticio|de_?cr[eé]dito)|clearing(_?(de_?)?informes)?|central_?(de_?)?riesgos?|bur[oó]_?(de_?)?cr[eé]dito|equifax|score(_?(crediticio|interno))?|puntaje_?(de_?)?cr[eé]dito|calificaci[oó]n_?(de_?)?(riesgo|cr[eé]dito|cartera|deudor)|categor[ií]a_?(bcu|de_?riesgo)|d[ií]as_?(de_?)?(mora|atraso)|estado_?(de_?)?(cr[eé]dito|cartera|obligaci[oó]n)|morosidad|moroso|deudor_?moroso|gesti[oó]n_?(de_?)?cobranza|credit_?score|credit_?rating', 0.9]))

// Uruguay uses the peso uruguayo; the national minimum wage was some 23,600 pesos a month in 2025.
algorithm('UY_VALOR_DEUDA', 'characterMapping.NumericMapping', { minValue: 5000, maxValue: 5000000 }, '184000')
domain('UY_FIN_DEUDA', 'UY_VALOR_DEUDA',
  byName(['saldo_?(deuda|cr[eé]dito|capital|obligaci[oó]n|cartera|en_?mora|adeudado)|monto_?(de_?la_?)?(deuda|cuota|obligaci[oó]n|cr[eé]dito|pr[eé]stamo|mora|otorgado)|deuda(_?total)?|l[ií]mite_?(de_?)?(cr[eé]dito|tarjeta)|l[ií]nea_?(de_?)?cr[eé]dito|cuota_?mensual|loan_?(amount|balance)|outstanding_?balance|debt', 0.85]),
  byType(NUMBER()))

algorithm('UY_INGRESOS', 'characterMapping.NumericMapping', { minValue: 22000, maxValue: 400000 }, '65000')
domain('UY_FIN_INGRESOS', 'UY_INGRESOS',
  byName(['sueldo(_?(nominal|l[ií]quido|mensual|bruto|neto|b[aá]sico))?|salario(_?(nominal|l[ií]quido|mensual|bruto|neto|b[aá]sico|m[ií]nimo))?|remuneraci[oó]n(_?(nominal|mensual))?|ingresos?(_?(mensuales?|totales?|familiares?|declarados?|netos?))?|haberes|honorarios|partida(_?salarial)?|renta(_?(bruta|neta|mensual|anual))?|ingreso_?(base|familiar|per_?capita)|salary|income|wages?', 0.85]),
  byType(NUMBER()))

algorithm('UY_PATRIMONIO', 'characterMapping.NumericMapping', { minValue: 50000, maxValue: 20000000 }, '3400000')
domain('UY_FIN_PATRIMONIO', 'UY_PATRIMONIO',
  byName(['patrimonio(_?(neto|l[ií]quido|fiscal))?|activos?_?(totales?)?|valor_?(del_?)?(inmueble|padr[oó]n|veh[ií]culo|bienes|tasaci[oó]n|aforo|comercial)|tasaci[oó]n|aforo(_?catastral)?|valor_?real(_?catastral)?|saldo_?(cuenta|caja_?de_?ahorro|dep[oó]sito|inversi[oó]n|fondo)|dep[oó]sito_?a_?plazo|inversiones|declaraci[oó]n_?jurada_?(de_?)?(bienes|patrimonio)|net_?worth|account_?balance', 0.85]),
  byType(NUMBER()))

algorithm('UY_VALOR_PENSION', 'characterMapping.NumericMapping', { minValue: 15000, maxValue: 200000 }, '32000')
domain('UY_FIN_PENSION', 'UY_VALOR_PENSION',
  byName(['pasividad|jubilaci[oó]n(_?(monto|mensual|valor))?|pensi[oó]n(_?(monto|mensual|valor|alimenticia|por_?invalidez|a_?la_?vejez))?|monto_?(pasividad|jubilaci[oó]n|pensi[oó]n|beneficio|subsidio)|valor_?(pasividad|pensi[oó]n|subsidio|beneficio)|haber_?(jubilatorio|pensionario)|pension_?amount', 0.9]),
  byType(NUMBER()))

const PROGRAMMES = ['Tarjeta Uruguay Social', 'Asignaciones Familiares Plan de Equidad', 'Asistencia a la Vejez', 'Uruguay Trabaja', 'Jóvenes en Red', 'Canasta de servicios', 'Sistema Nacional de Cuidados', 'Ninguno']
categorical('UY_PROGRAMA_SOCIAL', 'uy-programas-sociales.txt', PROGRAMMES, 'Plan de emergencia')
domain('UY_FIN_PROGRAMA_SOCIAL', 'UY_PROGRAMA_SOCIAL',
  byName(['programa_?social|beneficiario_?(programa|subsidio|prestaci[oó]n|tarjeta)|tarjeta_?uruguay_?social|tus|asignaci[oó]n(es)?_?familiar(es)?|afam(_?pe)?|plan_?(de_?)?equidad|asistencia_?(a_?la_?)?vejez|uruguay_?trabaja|j[oó]venes_?en_?red|mides|canasta(_?(de_?)?servicios)?|transferencia_?monetaria|ayuda_?(social|estatal)|social_?programme', 0.9]),
  byList([['uy-detectar-programas-sociales.txt', [...PROGRAMMES, 'tarjeta uruguay social', 'tus', 'afam-pe', 'plan de equidad', 'asistencia a la vejez', 'uruguay trabaja', 'ninguno'], 0.8],
    ['uy-detectar-codigos-banderas.txt', ['s', 'n', 'sí', 'no', '1', '2', '3', '4', '5', '6'], 0.3],
  ], { reject: 0.4 }))

// The Índice de Carencias Críticas decides who gets a MIDES transfer: as revealing as an income.
const SOCIOECONOMIC = ['Quintil 1', 'Quintil 2', 'Quintil 3', 'Quintil 4', 'Quintil 5', 'Bajo la línea de pobreza', 'Sobre la línea de pobreza', 'Sin clasificación']
categorical('UY_NIVEL_SOCIOECONOMICO', 'uy-nivel-socioeconomico.txt', SOCIOECONOMIC, 'Bajo la línea de pobreza', ['1', '2', '3', '4', '5'])
domain('UY_FIN_NIVEL_SOCIOECONOMICO', 'UY_NIVEL_SOCIOECONOMICO',
  byName(['[ií]ndice_?(de_?)?carencias?_?cr[ií]ticas?|icc|puntaje_?(mides|icc)|nivel_?socioecon[oó]mico|nse|condici[oó]n_?(de_?)?pobreza|pobreza|indigencia|quintil(_?(de_?)?(ingreso|riqueza))?|decil|estrato_?socioecon[oó]mico', 0.9]),
  byList([['uy-detectar-nivel-socioeconomico.txt', [...SOCIOECONOMIC, 'quintil', 'pobre', 'indigente', 'no pobre', 'bajo la línea', 'a', 'b', 'c', 'd', 'e'], 0.6]], { reject: 0.4 }))

const TENURES = ['Propietario de la vivienda y el terreno', 'Propietario de la vivienda y no del terreno', 'Inquilino o arrendatario', 'Ocupante en relación de dependencia', 'Ocupante gratuito', 'Ocupante sin permiso']
categorical('UY_TENENCIA_VIVIENDA', 'uy-tenencia-vivienda.txt', TENURES, 'Ocupación de hecho')
domain('UY_FIN_VIVIENDA', 'UY_TENENCIA_VIVIENDA',
  byName(['tenencia_?(de_?)?(la_?)?vivienda|tipo_?(de_?)?tenencia|vivienda_?(propia|alquilada|tipo_?tenencia)|condici[oó]n_?(de_?)?(la_?)?vivienda|ocupaci[oó]n_?vivienda|r[eé]gimen_?(de_?)?tenencia|housing_?tenure', 0.9]),
  byList([['uy-detectar-tenencia-vivienda.txt', [...TENURES, 'propietario', 'propia', 'inquilino', 'arrendatario', 'alquilada', 'ocupante', 'gratuito', 'sin permiso'], 0.6]], { reject: 0.3 }))

// ── PENAL · Offences (art. 18, final paragraph) ─────────────────────────────
//
// The last paragraph of article 18 puts the data on the commission of **criminal, civil or
// administrative** offences under a regime of its own: it "sólo puede ser objeto de tratamiento por
// parte de las autoridades públicas competentes". A private company that copies such a column into
// a test environment is processing data it may not process at all — which is why this group exists.

categorical('UY_ANTECEDENTES', 'uy-antecedentes.txt', ['No registra antecedentes judiciales', 'Registra antecedentes', 'Procesado', 'Condenado', 'Absuelto', 'Sobreseído', 'Sin información'], 'Condenado por hurto en 2019')
domain('UY_PENAL_ANTECEDENTES', 'UY_ANTECEDENTES',
  byName(
    ['antecedentes?(_?(penales|policiales|judiciales))?|certificado_?(de_?)?antecedentes(_?judiciales)?|itf|record_?policial|reincidencia|condena(_?(penal|tipo))?|delito(_?(tipo|cometido))?|tipo_?(de_?)?delito|situaci[oó]n_?(jur[ií]dica|procesal)|procesamiento|privad[oa]_?(de_?)?libertad|inr|establecimiento_?(carcelario|penitenciario)|infracci[oó]n(es)?_?(penal|civil|administrativa)|criminal_?record', 0.95],
    ['estado_?(del_?)?proceso|sentencia|fallo', 0.55],
  ))

// The Poder Judicial numbers every case with an Identificador Único de Expediente: the office, a
// correlative and the year, `2-12345/2024`.
decompose('UY_EXPEDIENTE_JUDICIAL', [
  [String.raw`(\d{1,4})(-)(\d{1,6})(/)(\d{4})`, DIGITS, keep, DIGITS, keep, keep],
  [String.raw`(\d{1,6})([\s\-/])([A-Za-z]{2,10})([\s\-/])(\d{4})`, DIGITS, keep, keep, keep, keep],
  [String.raw`([A-Za-z]{1,6}[\s\-]?)(\d{1,6})([\s\-/])(\d{4})`, keep, DIGITS, keep, keep],
  [String.raw`(\d{1,6})([\s\-/])(\d{4})`, DIGITS, keep, keep],
], CM, '2-12345/2024')
domain('UY_PENAL_EXPEDIENTE', 'UY_EXPEDIENTE_JUDICIAL',
  byName(
    ['iue|identificador_?[uú]nico_?(de_?)?expediente|n(o|ro|um|umero)_?(de_?)?(expediente_?(judicial|penal|fiscal)|causa|proceso_?(judicial|penal)|denuncia|ficha)|expediente_?(judicial|penal|fiscal)|causa_?penal|n(o|ro|um|umero)_?(de_?)?(ficha|carpeta)_?(fiscal|judicial)', 0.9],
    ['expediente|causa|proceso|ficha', 0.5],
  ),
  byPattern([[String.raw`\d{1,4}-\d{1,6}/\d{4}`, 0.85], [String.raw`\d{1,6}-[A-Z]{2,10}-\d{4}`, 0.5]], { reject: 0.3 }))

// ── Preset ──────────────────────────────────────────────────────────────────

const referenced = JSON.stringify([domains, algorithms.map((x) => x.config)])
const orphans = algorithms.filter((a) => !referenced.includes(`"${a.name}"`))
if (orphans.length) throw new Error(`algorithms nobody uses: ${orphans.map((a) => a.name).join(', ')}`)
const noInput = algorithms.filter((a) => a.input === undefined)
if (noInput.length) throw new Error(`algorithms without a sample input: ${noInput.map((a) => a.name).join(', ')}`)

// The essential pack: identity documents, names, contact, address and birth date. Loading it brings
// these domains and only what they lean on; the extended pack is everything.
const ESSENTIAL = [
  'UY_L1_CEDULA', 'UY_L1_RUT', 'UY_L1_DOCUMENTO_EXTRANJERO', 'UY_L1_PASAPORTE',
  'UY_L1_NOMBRE', 'UY_L1_APELLIDO', 'UY_L1_NOMBRE_COMPLETO', 'UY_L1_RAZON_SOCIAL',
  'UY_L1_EMAIL', 'UY_L1_TELEFONO', 'UY_L1_DIRECCION', 'UY_L1_DIRECCION_COMPLEMENTO',
  'UY_L2_FECHA_NACIMIENTO',
]
const notDomains = ESSENTIAL.filter((name) => !domains.some((d) => d.name === name))
if (notDomains.length) throw new Error(`essential pack names domains the set does not have: ${notDomains.join(', ')}`)

// The version and the day it was built: bump both whenever anything in the set changes, so that
// whoever loaded an older one can see how old it is.
const VERSION = 1
const VERSION_DATE = '2026-09-30'
const preset = {
  version: VERSION,
  versionDate: VERSION_DATE,
  name: {
    en: 'Uruguay — Ley 18.331 de Protección de Datos Personales',
    'pt-BR': 'Uruguai — Ley 18.331 de Protección de Datos Personales',
    es: 'Uruguay — Ley 18.331 de Protección de Datos Personales',
  },
  summary: {
    en: 'Discovers and masks Uruguayan personal data under Ley 18.331 and its amendments (Ley 19.670 of 2018, Ley 19.924 of 2020) and Decree 64/020: direct identifiers (cédula de identidad and RUT with a valid check digit, credencial cívica, names, razón social — article 4 D) makes a legal person a data subject too —, contact, address, accounts, plates), quasi-identifiers (birth date, localidad and INE code, barrio, postal code), the sensitive data of article 4 E) — racial and ethnic origin, political preferences, religious or moral convictions, trade union membership, health and sexual life —, the biometric data of article 4 Ñ), health data, the commercial and credit data of article 22 and the offence data of article 18.',
    'pt-BR': 'Descobre e mascara dados pessoais uruguaios segundo a Ley 18.331 e suas alterações (Ley 19.670 de 2018, Ley 19.924 de 2020) e o Decreto 64/020: identificadores diretos (cédula de identidad e RUT com dígito verificador válido, credencial cívica, nomes, razão social — o artigo 4 D) faz da pessoa jurídica titular também —, contato, endereço, contas, matrículas), quase-identificadores (data de nascimento, localidade e código INE, bairro, código postal), os dados sensíveis do artigo 4 E) — origem racial e étnica, preferências políticas, convicções religiosas ou morais, filiação sindical, saúde e vida sexual —, os dados biométricos do artigo 4 Ñ), dados de saúde, os dados comerciais e de crédito do artigo 22 e os dados de infrações do artigo 18.',
    es: 'Descubre y enmascara datos personales uruguayos conforme a la Ley 18.331 y sus modificativas (Ley 19.670 de 2018, Ley 19.924 de 2020) y el Decreto 64/020: identificadores directos (cédula de identidad y RUT con dígito verificador válido, credencial cívica, nombres, razón social — el artículo 4 D) hace titular también a la persona jurídica —, contacto, dirección, cuentas, matrículas), cuasi-identificadores (fecha de nacimiento, localidad y código INE, barrio, código postal), los datos sensibles del artículo 4 E) — origen racial y étnico, preferencias políticas, convicciones religiosas o morales, afiliación sindical, salud y vida sexual —, los datos biométricos del artículo 4 Ñ), datos de salud, los datos comerciales y crediticios del artículo 22 y los datos de infracciones del artículo 18.',
  },
  profileSet: {
    name: `UY - Ley 18.331 - v${VERSION}`,
    description: 'Identificadores directos, cuasi-identificadores, datos sensibles (art. 4 E y art. 4 Ñ), datos de salud, datos de la actividad comercial o crediticia (art. 22) e infracciones (art. 18), conforme a la Ley 18.331 de Protección de Datos Personales del Uruguay y el Decreto 64/020.',
    threshold: 60,
    classifiers: classifiers.map((c) => c.name),
  },
  packs: {
    essential: {
      description: 'Paquete esencial de la Ley 18.331: cédula de identidad, RUT, documentos de extranjeros, pasaporte, nombres, razón social, contacto, dirección y fecha de nacimiento.',
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

const small = localidadPlaces.filter((l) => l.small)
const inSmall = small.reduce((a, l) => a + l.population, 0)
const approximate = localidadPlaces.filter((l) => l.approximate).length
console.log(`${domains.length} domains, ${classifiers.length} classifiers, ${algorithms.length} algorithms, ${files.size} files`)
console.log(`localidades: ${small.length} of ${LOCALIDADES.length} under ${SMALL_PLACE} (${inSmall} people), ${approximate} located at their departamento's centre`)
console.log(`${places.names} names generalized, ${places.table.length} table lines, ${codePairs.length} codes`)
