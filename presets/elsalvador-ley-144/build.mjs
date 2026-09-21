#!/usr/bin/env node
/**
 * Builds the El Salvador (Ley para la Protección de Datos Personales, Decreto 144) pre-configured
 * profile set: preset.json and files/.
 *
 *   node presets/elsalvador-ley-144/build.mjs
 *
 * source/ holds the hand-kept lists — given names, surnames, colonias — and the geography of the
 * 2024 census: the 44 municipios and the 262 distritos with their population and location, as the
 * Banco Central de Reserva publishes them. Everything in files/ and preset.json is generated from
 * them and from the definitions below — edit here, then build, then run verify.mjs.
 *
 * Structure of the set
 *   L1     direct identifiers      DUI and NIT with a valid check digit, NRC, foreigner documents,
 *                                  passport, names, contact, address, accounts, cards, wallets,
 *                                  devices, cookies, plates, property, free text
 *   L2     quasi-identifiers       birth date, age, sex, distrito, municipio and their codes,
 *                                  postal code, colonia, cantón, occupation, employer, education
 *   L3     sensitive data          art. 4 g) and art. 59 b): ethnic origin, nationality, religious,
 *                                  spiritual or philosophical convictions, political affiliation and
 *                                  ideology, trade unions, sexual preferences and life, gender
 *                                  identity, biometric and genetic data, family and moral situation,
 *                                  personal habits, victims of violence
 *   SALUD  health data             art. 4 g) and art. 39: clinical record, coverage, ICD-10,
 *                                  procedures, medicines, HIV, disability, occupational, reproductive
 *                                  and mental health
 *   FIN    financial data          credit history (art. 3 a) leaves it to its own law), debt, income,
 *                                  assets, pensions, remittances, social programmes, housing
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
  description: 'Nombre de la columna (y variantes usadas en sistemas salvadoreños).',
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
const COLONIAS = unique(readLines('colonias.txt'))

const DISTRITOS = readLines('distritos.tsv').map((line) => {
  const [code, name, municipalityCode, municipality, departmentCode, department, lat, lon, population] = line.split('\t')
  return { code, name, municipalityCode, municipality, departmentCode, department, lat: Number(lat), lon: Number(lon), population: Number(population), aliases: [] }
})
const MUNICIPIOS = readLines('municipios.tsv').map((line) => {
  const [code, name, departmentCode, department, lat, lon, population] = line.split('\t')
  return { code, name, departmentCode, department, lat: Number(lat), lon: Number(lon), population: Number(population), aliases: [] }
})
if (DISTRITOS.length !== 262) throw new Error(`expected the 262 distritos of the 2024 census, found ${DISTRITOS.length}`)
if (MUNICIPIOS.length !== 44) throw new Error(`expected the 44 municipios of the 2024 census, found ${MUNICIPIOS.length}`)
for (const d of DISTRITOS) if (!/^\d{6}$/.test(d.code) || d.code.slice(0, 4) !== d.municipalityCode || Number.isNaN(d.lat)) throw new Error(`${d.name}: bad code or location`)
const DEPARTMENTS = unique(DISTRITOS.map((d) => d.department))

// ── Shared algorithms ───────────────────────────────────────────────────────

// Vowels map to vowels and consonants to consonants, so a masked document number keeps its
// structure; digits map to digits. Separators are in no group and stay. minMaskedPositions 0 lets
// a placeholder such as "N/A" through instead of failing the row.
algorithm('SV_CM_ALFANUM', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'AEIOU', 'BCDFGHJKLMNPQRSTVWXYZ', 'aeiou', 'bcdfghjklmnpqrstvwxyz', 'ÁÉÍÓÚÜ', 'áéíóúü'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, 'A123456')
// Digits only: the hyphens of a DUI or a NIT stay.
algorithm('SV_CM_DIGITOS', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '04567890')
// Digits and upper-case letters, one group each: a plate stays a plate.
algorithm('SV_CM_DIGITOS_LETRAS', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, 'P123-456')
// Hex letters form their own group, so a MAC, UUID or IPv6 stays valid hex.
algorithm('SV_CM_HEX', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'abcdef', 'ABCDEF', 'ghijklmnopqrstuvwxyz', 'GHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '3c:22:fb:9a:10:e4')
decompose('SV_REDACTAR', [['(.+)', { type: 'REDACT', redactCharacter: 'X' }]], keep, 'clave123')
lookup('SV_SUPRIMIR', 'sv-sin-informacion.txt', ['Sin información'], 'Trastorno depresivo recurrente', 'PRESERVE_LOOKUP_FILE')

// Yes/no columns keep their vocabulary: a CHAR(1) S/N stays S/N.
decompose('SV_BANDERA', [
  [String.raw`(?i)(s[ií]|no)`, apply(lookup('SV_BANDERA_SI_NO', 'sv-bandera-si-no.txt', ['Sí', 'No']))],
  ['(?i)(true|false)', apply(lookup('SV_BANDERA_TRUE_FALSE', 'sv-bandera-true-false.txt', ['true', 'false']))],
  ['(?i)(yes)', apply(lookup('SV_BANDERA_YES_NO', 'sv-bandera-yes-no.txt', ['Yes', 'No']))],
  ['(?i)([sn])', apply(lookup('SV_BANDERA_S_N', 'sv-bandera-s-n.txt', ['S', 'N']))],
  ['(?i)([yx])', apply(lookup('SV_BANDERA_Y_N', 'sv-bandera-y-n.txt', ['Y', 'N']))],
  ['([01])', apply(lookup('SV_BANDERA_0_1', 'sv-bandera-0-1.txt', ['0', '1']))],
], keep, 'S')

const FLAG = String.raw`(?i)(s[ií]|no|true|false|yes|[snyx01])`
/**
 * A categorical attribute: flags stay flags, numeric codes are replaced by another code of `codes`
 * (or get other digits), and any other value is replaced by one from `values` — or suppressed, when
 * no list is given.
 */
function categorical(name, fileName, values, input, codes) {
  const replacement = values ? lookup(`${name}_LISTA`, fileName, values) : 'SV_SUPRIMIR'
  const code = codes ? apply(lookup(`${name}_CODIGO`, fileName.replace(/\.txt$/, '-codigos.txt'), codes)) : apply('SV_CM_ALFANUM')
  return decompose(name, [[FLAG, apply('SV_BANDERA')], [String.raw`(\d{1,6})`, code]], apply(replacement), input)
}
categorical('SV_CATEGORIA_SUPRIMIDA', null, null, 'Trastorno depresivo recurrente')
const CM = apply('SV_CM_ALFANUM')
const DIGITS = apply('SV_CM_DIGITOS')

// ── L1 · DUI, NIT and NRC ───────────────────────────────────────────────────
//
// The DUI of the Registro Nacional de las Personas Naturales is the key of every Salvadoran record:
// eight digits and a check digit, written `04567890-1`. The digit is the classic modulus 10: weights
// 9, 8, 7, 6, 5, 4, 3 and 2 from the left, and ten minus the remainder, written 0 when it is ten.
// Since Decreto Legislativo 203 of December 2021 the DUI number **is** the NIT of an adult
// Salvadoran, so a NIT column may hold either shape.
//
// The fourteen-digit NIT — still issued to minors, foreigners and legal persons — carries more than
// an identifier: four digits for the municipality of birth or registration, six for the **date of
// birth** (ddmmyy), three for a correlative and one check digit. Its digit is modulus 11 over the
// thirteen digits, with two rules: when the correlative is 100 or less the digit is the remainder
// itself (ten written as 0), and above 100 it is eleven minus the remainder (zero when the remainder
// is 0 or 1). The set masks the whole body — the birth date included — and recomputes the digit.
const DUI_WEIGHTS = [9, 8, 7, 6, 5, 4, 3, 2]
const NIT_NEW_WEIGHTS = [2, 7, 6, 5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
const NIT_OLD_WEIGHTS = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2]
// Check Digit always writes (modulus − remainder): with the complementary weights, that is the
// remainder of the true weights, which is what an old NIT needs.
const complement = (weights) => weights.map((w) => (11 - (w % 11)) % 11)

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
checkDigit('SV_DUI', DUI_WEIGHTS, 10, 'SV_CM_DIGITOS', '04567890-1')

// The correlative decides which rule the digit follows, so each body masker keeps it in its class:
// an old NIT keeps a leading zero, a new one is mapped into 101–999.
algorithm('SV_NIT_CORRELATIVO', 'characterMapping.NumericMapping', { minValue: 101, maxValue: 999 }, '238')
decompose('SV_NIT_CUERPO_ANTIGUO', [[String.raw`(\d{10})(\d)(\d{2})`, DIGITS, redactAs('0'), DIGITS]], DIGITS, '0614050589018')
decompose('SV_NIT_CUERPO_NUEVO', [[String.raw`(\d{10})(\d{3})`, DIGITS, apply('SV_NIT_CORRELATIVO')]], DIGITS, '0513010180238')
checkDigit('SV_NIT_ANTIGUO', complement(NIT_OLD_WEIGHTS), 11, 'SV_NIT_CUERPO_ANTIGUO', '0614-050589-018-3')
checkDigit('SV_NIT_NUEVO', NIT_NEW_WEIGHTS, 11, 'SV_NIT_CUERPO_NUEVO', '0513-010180-238-7')
const NIT_SHAPE_OLD = String.raw`\d{4}-?\d{6}-?(?:0\d{2}|100)-?\d`
const NIT_SHAPE_NEW = String.raw`\d{4}-?\d{6}-?[1-9]\d{2}-?\d`
decompose('SV_NIT', [
  [`(${NIT_SHAPE_OLD})`, apply('SV_NIT_ANTIGUO')],
  [`(${NIT_SHAPE_NEW})`, apply('SV_NIT_NUEVO')],
  // A NIT column of an adult Salvadoran holds the DUI number.
  [String.raw`(\d{8}-?\d)`, apply('SV_DUI')],
], DIGITS, '0513-010180-238-7')

// A document column holds DUIs, NITs and passports: each value goes by its shape.
decompose('SV_DOCUMENTO', [
  [`(${NIT_SHAPE_OLD})`, apply('SV_NIT_ANTIGUO')],
  [`(${NIT_SHAPE_NEW})`, apply('SV_NIT_NUEVO')],
  [String.raw`(\d{8}-?\d)`, apply('SV_DUI')],
], CM, '04567890-1')

const DOC_OWNER = 'cliente|cli|paciente|pac|usuario|afiliado|asegurado|beneficiario|benef|titular|empleado|emp|trabajador|colaborador|alumno|estudiante|deudor|codeudor|fiador|solicitante|propietario|arrendatario|inquilino|conductor|responsable|representante|apoderado|persona|ciudadano|votante|contribuyente|proveedor|socio|conyuge|padre|madre|hijo|familiar|jubilado|pensionado|cotizante'
domain('SV_L1_DUI', 'SV_DOCUMENTO',
  byName(
    [`dui|d_u_i|documento_?[uú]nico(_?de_?identidad)?|n(o|ro|um|umero)_?(dui|documento|doc|identificaci[oó]n|id(ent)?)|doc_?identidad|numdoc|nrodoc|(${DOC_OWNER})_?(dui|doc|documento)|dui_?(${DOC_OWNER})|carn[eé]_?(de_?)?minoridad`, 0.9],
    ['documento|doc|identificaci[oó]n', 0.6],
  ),
  byType(STRING(8), NUMBER(8)),
  byPattern([
    [String.raw`\d{8}-\d`, 0.9],
    [String.raw`0\d{8}`, 0.5],
  ], { reject: 0.3 }))

domain('SV_L1_NIT', 'SV_NIT',
  byName([`nit[a-z0-9_]*|n(o|ro|um|umero)_?nit|n[uú]mero_?(de_?)?identificaci[oó]n_?tributaria|(${DOC_OWNER})_?nit|nit_?(${DOC_OWNER})|id_?tributario|tax_?id`, 0.9]),
  byPattern([
    [String.raw`\d{4}-\d{6}-\d{3}-\d`, 0.95],
    [String.raw`\d{14}`, 0.5],
  ], { reject: 0.3 }))

// The NRC of the Registro de Contribuyentes has no published check digit rule, so it is mapped
// digit by digit.
domain('SV_L1_NRC', 'SV_CM_DIGITOS',
  byName(['nrc[a-z0-9_]*|n(o|ro|um|umero)_?(de_?)?registro_?(de_?)?contribuyente|registro_?contribuyente|n(o|ro|um|umero)_?nrc', 0.9]),
  byPattern([[String.raw`\d{1,7}-\d`, 0.4]], { reject: 0.3 }))

// ── L1 · Other identity documents ───────────────────────────────────────────

domain('SV_L1_DOCUMENTO_EXTRANJERO', 'SV_CM_ALFANUM',
  byName(['carn[eé]_?(de_?)?residente|carn[eé]_?(de_?)?extranjer[oa]|documento_?(de_?)?extranjer[oa]|doc_?extranjero|residencia_?(n(o|ro|um|umero)|definitiva|temporal)|n(o|ro|um|umero)_?(residencia|extranjer[ií]a)|permiso_?(de_?)?(residencia|trabajo)|visa(_?(n(o|ro|um|umero)))?|gr[uú]a?_?migratoria', 0.85]))

domain('SV_L1_PASAPORTE', 'SV_CM_ALFANUM',
  byName(['pasaporte[a-z0-9_]*|n(o|ro|um|umero)_?pasaporte|passport[a-z0-9_]*', 0.9]),
  byPattern([[String.raw`[A-Z]\d{6,8}`, 0.4]], { reject: 0.3 }))

// The Registro del Estado Familiar of each alcaldía keeps the birth, marriage and death records.
domain('SV_L1_PARTIDA', 'SV_CM_ALFANUM',
  byName(['partida_?(de_?)?(nacimiento|matrimonio|defunci[oó]n)(_?(n(o|ro|um|umero)|folio|libro))?|n(o|ro|um|umero)_?partida|folio_?(partida|libro)|libro_?(partida|registro)|asiento_?(registral|partida)|certificaci[oó]n_?(de_?)?partida|registro_?(del_?)?estado_?familiar', 0.85]))

domain('SV_L1_SEGURO_SOCIAL', 'SV_CM_DIGITOS',
  byName(['isss[a-z0-9_]*|n(o|ro|um|umero)_?(isss|afiliaci[oó]n|patronal|asegurado)|afiliaci[oó]n_?isss|n(o|ro|um|umero)_?patronal|nup|n(o|ro|um|umero)_?[uú]nico_?previsional|afp[a-z0-9_]*|n(o|ro|um|umero)_?(afp|cuenta_?individual|ciap)|inpep|ipsfa|bienestar_?magisterial', 0.85]))

domain('SV_L1_NIE', 'SV_CM_DIGITOS',
  byName(['nie|n(o|ro|um|umero)_?(de_?)?identificaci[oó]n_?(del_?)?estudiante|c[oó]digo_?(de_?)?estudiante|carn[eé]_?(de_?)?estudiante|c[oó]digo_?(de_?)?alumno|n(o|ro|um|umero)_?(de_?)?carn[eé]', 0.8]))

domain('SV_L1_MATRICULA_PROFESIONAL', 'SV_CM_ALFANUM',
  byName(['jvpm|junta_?de_?vigilancia|n(o|ro|um|umero)_?(de_?)?(junta|jvpm)|matr[ií]cula_?(profesional|m[eé]dica)|registro_?(m[eé]dico|profesional)|n(o|ro|um|umero)_?colegiado|colegiatura', 0.85]))

// ── L1 · Names ──────────────────────────────────────────────────────────────

const NOT_A_PERSON = 'producto|prod|item|articulo|empresa|emp|razon|social|comercial|archivo|calle|avenida|pasaje|colonia|canton|caserio|barrio|distrito|municipio|departamento|depto|dpto|pais|banco|sucursal|agencia|plan|campana|proyecto|servicio|tabla|columna|campo|usuario|host|servidor|dominio|marca|modelo|categoria|tipo|centro|escuela|colegio|institucion|universidad|curso|materia|documento|doc|unidad|clinica|hospital|isss|seguro|area|dependencia|cargo|sistema|app|aplicacion|grupo|lista|reporte|informe|proceso|evento|tarea|perfil|rol|clase|objeto|cuenta|medicamento|diagnostico|estudio|programa|beneficio|partido|sindicato|religion|pueblo|lengua|lugar|sede|local|tienda|bodega|proveedor|convenio|contrato|poliza|aseguradora|entidad|organismo|organizacion|parametro|variable|metodo|funcion|indice|job|script|cola|recurso|red|dispositivo|plantilla|imagen|foto|pagina|sitio|modulo|menu|opcion|accion|permiso|concepto|impuesto|moneda|emisor|factura|comprobante|pago|forma|zona|ruta|linea|actividad|rubro|sector|file|table|column|field|user|server|product|company|category|type|school|document|department|system|group|report|role|account|place|store|supplier|contract|device|image|page|module|action|key|label|code|project|city|country|street|bank'
const PERSON_ROLE = 'cliente|cli|paciente|pac|usuario|afiliado|asegurado|beneficiario|benef|titular|empleado|trabajador|colaborador|alumno|estudiante|deudor|codeudor|fiador|solicitante|propietario|arrendatario|inquilino|conductor|responsable|representante|apoderado|persona|ciudadano|contribuyente|madre|padre|conyuge|companero|contacto|referencia|victima|denunciante|imputado|procesado|testigo|medico|docente|socio|heredero|donante|tutor|jubilado|pensionado|cotizante|customer|patient|employee|member|holder|mother|father|spouse|contact|person|student|driver|owner'
const PARTICLES = String.raw`(?i)(de|del|la|las|los|y|e|san|santa|van|von|di|da)`

algorithm('SV_NOMBRE', 'name.Name', {
  lookupFile: { uri: file('sv-nombres.txt', GIVEN_NAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Morena')
algorithm('SV_APELLIDO', 'name.Name', {
  lookupFile: { uri: file('sv-apellidos.txt', SURNAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Menjívar')
// A word of a name. "de", "del", "la" stay where they are: "María de los Ángeles", "Ana de Portillo".
decompose('SV_PALABRA_NOMBRE', [[PARTICLES, keep]], apply('SV_NOMBRE'), 'Guadalupe')
decompose('SV_PALABRA_APELLIDO', [[PARTICLES, keep]], apply('SV_APELLIDO'), 'Portillo')
const N = apply('SV_PALABRA_NOMBRE')
const S = apply('SV_PALABRA_APELLIDO')

decompose('SV_NOMBRES', [
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, N],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, N, N],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, N, N],
], CM, 'María Guadalupe')
decompose('SV_APELLIDOS', [
  [String.raw`(\S+)`, S],
  [String.raw`(\S+)\s+(\S+)`, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, S, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, S, S, S, S],
], CM, 'Menjívar de Portillo')
// Salvadoran order: one or two given names, the father's surname, the mother's surname — and, for a
// married woman, "de" and the husband's surname. Two words are a given name and a surname; three, a
// given name and two surnames; four, two and two. APELLIDOS, NOMBRES with a comma, as in lists.
decompose('SV_NOMBRE_COMPLETO', [
  [String.raw`([^,]+),\s*(.+)`, apply('SV_APELLIDOS'), apply('SV_NOMBRES')],
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, S, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, N, S, S, S],
], CM, 'José Alberto Menjívar Portillo')
const NAME_WORDS = ['de', 'del', 'la', 'las', 'los', 'y']

domain('SV_L1_NOMBRE', 'SV_NOMBRES',
  byName(
    ['primer_?nombre|segundo_?nombre|nombres?_?(de_?)?pila|pri(mer)?_?nom|seg(undo)?_?nom|nombre_?1|nombre_?2|first_?names?|given_?names?|fname|middle_?names?|nombres(?!_?(completos?|y_?apellidos?|apellidos?))', 0.85],
    [`nombre(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|apellidos?|usuario|corto|largo))|nom(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}))|name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))`, 0.5],
  ),
  byList([['sv-detectar-nombres.txt', [...GIVEN_NAMES, ...NAME_WORDS], 0.7]], { tokenize: true, reject: 0.3 }))

domain('SV_L1_APELLIDO', 'SV_APELLIDOS',
  byName(['apellidos?|primer_?apellido|segundo_?apellido|apellido_?(1|2|paterno|materno|casada)|ape_?(1|2)|apellido_?(de_?)?casada|last_?names?|surnames?|family_?names?|lname', 0.85]),
  byList([['sv-detectar-apellidos.txt', [...SURNAMES, ...NAME_WORDS], 0.7]], { tokenize: true, reject: 0.3 }))

domain('SV_L1_NOMBRE_COMPLETO', 'SV_NOMBRE_COMPLETO',
  byName(
    [`nombres?_?(completos?|y_?apellidos?|apellidos?)|apellidos?_?(y_?)?nombres?|nombre_?(del_?|de_?la_?)?(${PERSON_ROLE})|(${PERSON_ROLE})_?(nombre|nom)|nom_?(${PERSON_ROLE})|nombre_?(madre|padre|tutor|conyuge|contacto_?emergencia|referencia)|full_?name|person_?name`, 0.9],
    ['madre|padre|tutor|conyuge|companero_?(de_?)?vida|representante_?legal|apoderado|fiador|beneficiario|heredero|titular|referencia_?(personal|familiar)', 0.6],
    // A bare NOMBRE holds a given name or a full name: the values decide between the two domains.
    [`nombre(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|apellidos?|usuario|corto|largo))|nom(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}))|name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))`, 0.5],
  ),
  byList([['sv-detectar-nombres.txt', [...GIVEN_NAMES, ...NAME_WORDS], 0.6], ['sv-detectar-apellidos.txt', [...SURNAMES, ...NAME_WORDS], 0.6]], { tokenize: true, reject: 0.3 }))

// ── L1 · Contact ────────────────────────────────────────────────────────────

decompose('SV_EMAIL', [
  // The top-level domain becomes .test, reserved for tests: a masked address can never deliver.
  [String.raw`([^@\s]+)@([^@\s]+)\.([A-Za-z]{2,24}(?:\.[A-Za-z]{2})?)`, CM, CM, redactAs('test')],
], CM, 'morena.menjivar@gmail.com')
domain('SV_L1_EMAIL', 'SV_EMAIL',
  byName(['e_?mail[a-z0-9_]*|mail[a-z0-9_]*|correo(_?electr[oó]nico)?[a-z0-9_]*|dir_?correo|direcci[oó]n_?(de_?)?correo|direcci[oó]n_?electr[oó]nica', 0.85]),
  byType(STRING(5)),
  byPattern([[String.raw`[A-Za-z0-9._%+'\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}`, 1]], { reject: 0.2 }))

// Eight digits since the 2005 plan: a landline starts with 2, a mobile with 6 or 7, written
// `2222-3333`. The country code and the first digit — which says landline or mobile — stay; the
// other seven digits are mapped.
decompose('SV_TELEFONO', [
  [String.raw`(\+?503[\s\-]?)?([267])(\d{3})([\s\-]?)(\d{4})`, keep, keep, DIGITS, keep, DIGITS],
], DIGITS, '+503 7123-4567')
domain('SV_L1_TELEFONO', 'SV_TELEFONO',
  byName(['tel|tel[eé]fono[a-z0-9_]*|tel_?(fijo|casa|oficina|trabajo|contacto|celular|m[oó]vil)|celular[a-z0-9_]*|cel|m[oó]vil|whats_?app|n(o|ro|um|umero)_?(tel|tel[eé]fono|celular|cel|contacto)|fax|phone[a-z0-9_]*|mobile[a-z0-9_]*', 0.85]),
  byPattern([
    [String.raw`(\+?503[\s\-]?)?[267]\d{3}[\s\-]?\d{4}`, 0.9],
  ], { reject: 0.3 }))

// Salvadoran addresses name the street and the number, and then the colonia, the polígono and the
// pasaje — "Calle Arce #123, Colonia Escalón", "Blvd. Los Héroes, Pol. 12 #5". The whole line
// becomes a fictitious one.
const VIAS = ['Calle', 'Avenida', 'Av.', 'Pasaje', 'Boulevard', 'Blvd.', 'Diagonal', 'Alameda', 'Final Calle', 'Prolongación Avenida']
const VIA_NAMES = ['Arce', 'Rubén Darío', 'Juan Pablo II', 'Los Héroes', 'Masferrer', 'España', 'Independencia', 'Roosevelt', 'Constitución', 'La Revolución', 'El Espino', 'Las Palmas', 'Los Sisimiles', 'San Antonio Abad', 'Bernal', 'Sur', 'Norte', 'Oriente', 'Poniente', 'Delgado', 'Morazán', 'Barrios', 'Cuscatlán', 'Jerusalén', 'Los Andes', 'Las Américas', 'El Progreso', 'Santa Elena', 'La Sabana', 'Los Almendros']
lookup('SV_DIRECCION', 'sv-direcciones.txt', (() => {
  const random = seeded(144)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const num = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
  const out = new Set()
  while (out.size < 4000) {
    const street = `${pick(VIAS)} ${pick(VIA_NAMES)}`
    const r = random()
    if (r < 0.4) out.add(`${street} #${num(1, 900)}, ${pick(COLONIAS)}`)
    else if (r < 0.6) out.add(`${street} #${num(1, 900)}, Pol. ${num(1, 40)}, ${pick(COLONIAS)}`)
    else if (r < 0.75) out.add(`${street} #${num(1, 900)}`)
    else if (r < 0.85) out.add(`${pick(COLONIAS)}, Pasaje ${num(1, 25)} #${num(1, 120)}`)
    else if (r < 0.95) out.add(`Km ${num(1, 90)} Carretera a ${pick(['Santa Ana', 'San Miguel', 'La Libertad', 'Comalapa', 'Sonsonate', 'Chalatenango'])}`)
    else out.add(`${pick(COLONIAS)}, Block ${pick(['A', 'B', 'C', 'D'])} #${num(1, 60)}`)
  }
  return [...out]
})(), 'Calle Arce #123, Colonia Escalón', 'PRESERVE_LOOKUP_FILE')
domain('SV_L1_DIRECCION', 'SV_DIRECCION',
  byName(['(?<!(mac|ip|e_?mail|web|url|correo)_?)direcci[oó]n(?!_?(ip|mac|email|e_?mail|correo|electr[oó]nica|web|url|tipo|id|general|regional))[a-z0-9_]*|domicilio[a-z0-9_]*|dom_?(residencia|particular|laboral|cliente)|residencia|lugar_?(de_?)?residencia|calle(_?y_?n[uú]mero)?|(?<!(mac|ip|e_?mail|web|url)_?)address(?!_?(ip|mac|email|e_?mail|web|url|type|id))[a-z0-9_]*', 0.8]),
  byType(STRING(6)),
  byPattern([
    [String.raw`(?i)(calle|avenida|av|avda|pasaje|pje|boulevard|blvd|bulevar|diagonal|alameda|final|prolongaci[oó]n)\.?\s+[a-záéíóúñ0-9.' ]{2,40}\s*#?\s*\d{1,5}.*`, 0.8],
    [String.raw`(?i).*\b(colonia|col|residencial|res|reparto|urbanizaci[oó]n|lotificaci[oó]n|barrio|pol[ií]gono|pol)\.?\s+[a-záéíóúñ0-9.' ]{2,40}.*`, 0.7],
    [String.raw`(?i)k(m|il[oó]metro)\.?\s*\d{1,3}\s+(carretera|autopista).*`, 0.7],
  ], { reject: 0.2 }))

domain('SV_L1_DIRECCION_COMPLEMENTO', 'SV_CM_ALFANUM',
  byName(['pol[ií]gono|pol|block|bloque|pasaje_?(n(o|ro|um|umero))?|casa_?(n(o|ro|um|umero))?|apartamento|apto|local|nivel(?!_?(educativo|acad[eé]mico|de_?estudios|escolaridad))|piso|lote|manzana|mz|n(o|ro|um|umero)_?(casa|puerta|apartamento)|complemento(_?direcci[oó]n)?|referencia_?(de_?)?(direcci[oó]n|domicilio)', 0.7]))

// ── L1 · Banking, payments and wallets ──────────────────────────────────────

domain('SV_L1_CUENTA_BANCARIA', 'SV_CM_DIGITOS',
  byName(['cuenta_?(bancaria|banco|corriente|ahorro|sueldo|planilla|abono|dep[oó]sito|destino|origen)|n(o|ro|um|umero)_?(de_?)?(cuenta|cta)|nro_?cta|num_?cta|cta_?(cte|corriente|ahorro|bancaria)|iban|account_?(no|num|number)|bank_?account', 0.85]))

// Payment Card fails a row that has no digits to mask; only values shaped like a card reach it.
algorithm('SV_TARJETA_LUHN', 'characterMapping.PaymentCard', { minMaskedPositions: 6, preserve: 0 }, '4162093500381234')
decompose('SV_TARJETA', [[String.raw`(\d[\d\s\-]{11,22}\d)`, apply('SV_TARJETA_LUHN')]], keep, '4162 0935 0038 1234')
domain('SV_L1_TARJETA', 'SV_TARJETA',
  byName(['tarjeta(_?(cr[eé]dito|d[eé]bito|n(o|ro|um|umero)))?|n(o|ro|um|umero)_?tarjeta|pan|card_?(no|num|number)|credit_?card|tc_?(numero|num|nro)', 0.85]),
  // 0.9, not 1: an IMEI is 15 Luhn-valid digits too, and its own column name should win.
  byPattern([[String.raw`\d{13,19}`, 0.9, { checksum: 'LUHN', clean: String.raw`[\s\-]` }]], { reject: 0.3 }))

// Wallet addresses: the Chivo wallet and the bitcoin addresses that Salvadoran systems kept after
// the 2021 Bitcoin Law. A masked address keeps its shape but no longer passes its own checksum,
// which is what a test copy wants.
domain('SV_L1_BILLETERA', 'SV_CM_ALFANUM',
  byName(['billetera(_?(digital|virtual|chivo))?|wallet(_?(id|address|direccion))?|chivo(_?(id|wallet|usuario))?|direcci[oó]n_?(bitcoin|btc|wallet|lightning)|btc_?(address|direccion)|lightning_?(address|invoice)|llave_?p[uú]blica', 0.85]),
  byPattern([
    [String.raw`(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,59}`, 0.7],
    [String.raw`[a-z0-9._\-]+@(chivowallet|walletofsatoshi|strike)\.[a-z]{2,10}`, 0.6],
  ], { reject: 0.3 }))

// ── L1 · Network, devices, vehicles, property ───────────────────────────────

algorithm('SV_OCTETO', 'characterMapping.NumericMapping', { minValue: 1, maxValue: 254 }, '10')
decompose('SV_IP', [
  [String.raw`(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})`, apply('SV_OCTETO'), apply('SV_OCTETO'), apply('SV_OCTETO'), apply('SV_OCTETO')],
], apply('SV_CM_HEX'), '190.86.45.12')
domain('SV_L1_IP', 'SV_IP',
  byName(['ip|ip_?(address|addr|origen|destino|cliente|usuario|acceso|login|remota|publica)|direcci[oó]n_?ip|dir_?ip|ipv[46]|remote_?addr(ess)?|client_?ip|host_?ip', 0.85]),
  byPattern([
    [String.raw`((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)`, 1],
    [String.raw`[0-9A-Fa-f]{1,4}(:[0-9A-Fa-f]{0,4}){2,7}`, 0.9],
  ], { reject: 0.3 }))

domain('SV_L1_DISPOSITIVO', 'SV_CM_HEX',
  byName(['imei|imsi|iccid|mac|mac_?address|direcci[oó]n_?mac|device_?(id|uuid|serial)|id_?(dispositivo|equipo|celular)|serial_?(equipo|celular|dispositivo)|advertising_?id|idfa|gaid|session_?id|id_?sesi[oó]n', 0.8]),
  byPattern([
    [String.raw`([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}`, 1],
    [String.raw`\d{15}`, 0.8, { checksum: 'LUHN' }],
  ], { reject: 0.3 }))

// The law defines the cookie in art. 4 e): what a site stores to know the browsing habits of the
// person behind the browser.
domain('SV_L1_COOKIE', 'SV_CM_ALFANUM',
  byName(['cookie(_?(id|value|valor|nombre))?|cookies|_?ga|_?gid|fbp|fbclid|utm_?(source|medium|campaign|term|content)|id_?(navegador|browser|visitante)|visitor_?id|tracking_?id|client_?id', 0.8]))

// Plates: a letter for the class — P particular, A alquiler, C carga, M motocicleta, AB autobús,
// N nacional, O oficial, CD cuerpo diplomático — and six characters, `P123-456`; since 2021 the
// newest ones mix digits and letters.
domain('SV_L1_PLACA', 'SV_CM_DIGITOS_LETRAS',
  byName(['placa(_?(veh[ií]culo|carro|moto|automotor))?|n(o|ro|um|umero)_?placa|matr[ií]cula_?(veh[ií]culo|automotor)|license_?plate|plate(_?(no|number))?', 0.85]),
  byPattern([
    [String.raw`(P|A|C|M|N|O|AB|CD|E|R|EP)[\s\-]?\d{3}[\s\-]?\d{3}`, 0.8],
    [String.raw`(P|A|C|M|N|O|AB|CD|E|R|EP)[\s\-]?\d{3}[\s\-]?\d{2}[A-Z]`, 0.7],
  ], { reject: 0.3 }))

domain('SV_L1_VEHICULO', 'SV_CM_ALFANUM',
  byName(['vin|chasis|n(o|ro|um|umero)_?(chasis|motor|serie|vin)|motor_?n(o|ro|um|umero)|tarjeta_?(de_?)?circulaci[oó]n|licencia_?(de_?)?conducir(_?(n(o|ro|um|umero)))?|n(o|ro|um|umero)_?licencia', 0.85]),
  byPattern([[String.raw`[A-HJ-NPR-Z0-9]{17}`, 0.7]], { reject: 0.3 }))

// The Centro Nacional de Registros keeps the property registry: matrícula, asiento and the
// cadastral number lead to the home and its owner.
domain('SV_L1_INMUEBLE', 'SV_CM_ALFANUM',
  byName(['matr[ií]cula_?(inmueble|registral|cnr)|n(o|ro|um|umero)_?(matr[ií]cula|inmueble|catastral|partida_?catastral)|c[oó]digo_?catastral|catastro|inscripci[oó]n_?registral|asiento_?registral|folio_?real|n(o|ro|um|umero)_?(de_?)?predio', 0.8]))

domain('SV_L1_CONTRATO', 'SV_CM_ALFANUM',
  byName(['n(o|ro|um|umero)_?(contrato|p[oó]liza|cr[eé]dito|pr[eé]stamo|solicitud|expediente_?(administrativo|interno)|referencia|cliente|socio|suscriptor|medidor|servicio|caso|ticket|beneficio)|contrato_?(n(o|ro|um|umero))|c[oó]digo_?(cliente|socio|empleado|afiliado)|id_?(cliente|socio|empleado|afiliado)|n(o|ro)_?empleado|c[oó]digo_?(de_?)?empleado', 0.7]))

domain('SV_L1_USUARIO', 'SV_CM_ALFANUM',
  byName(['usuario|user_?name|username|login|alias|apodo|nick(_?name)?|perfil_?(instagram|facebook|twitter|tiktok|linkedin|x)|instagram|facebook|twitter|tiktok|linkedin|red_?social|handle', 0.7]))

domain('SV_L1_CREDENCIAL', 'SV_REDACTAR',
  byName(['contrase[nñ]a|clave(?!_?(catastral|primaria|for[aá]nea|valor|producto))|password|passwd|pwd|pass|hash_?(clave|contrasena|password)|pin|c[oó]digo_?(seguridad|verificaci[oó]n|acceso|otp)|cvv|cvc|token(_?(acceso|refresh|api))?|access_?token|refresh_?token|api_?key|llave_?(api|privada)|secreto|secret|otp|pregunta_?secreta|respuesta_?secreta|frase_?semilla|seed_?phrase', 0.9]))

decompose('SV_COORDENADA', [
  // The integer part and first decimal stay (about 11 km): the place is generalized, not moved.
  [String.raw`(-?\d{1,3}[.,]\d)(\d+)\s*([,;])\s*(-?\d{1,3}[.,]\d)(\d+)`, keep, DIGITS, keep, keep, DIGITS],
  [String.raw`(-?\d{1,3}[.,]\d)(\d+)`, keep, DIGITS],
], keep, '13.698935')
domain('SV_L1_GEOLOCALIZACION', 'SV_COORDENADA',
  byName(
    ['lat|latitud|lon|lng|longitud|coordenadas?|coord_?[xy]|geo_?(lat|lon|lng|loc|localizacion|posicion)|georreferenciaci[oó]n|geolocalizaci[oó]n|gps(_?(ubicaci[oó]n|posici[oó]n|coordenadas))?|ubicaci[oó]n_?gps', 0.85],
    ['long', 0.5],
  ),
  byPattern([
    [String.raw`1[34]\.\d{3,}\s*,\s*-(8[89]|90)\.\d{3,}`, 0.9],
    [String.raw`-(8[89]|90)\.\d{4,}`, 0.5],
    [String.raw`1[34]\.\d{4,}`, 0.4],
  ], { reject: 0.3 }))

// ── L1 · Free text ──────────────────────────────────────────────────────────

algorithm('SV_TEXTO_LIBRE', 'freeTextRedaction.FreeTextRedaction', {
  regularExpressions: [
    String.raw`(?<!\d)\d{8}-\d(?!\d)`,
    String.raw`(?<!\d)\d{4}-\d{6}-\d{3}-\d(?!\d)`,
    String.raw`(?<!\d)\d{9}(?!\d)`,
    String.raw`(?<!\d)\d{14}(?!\d)`,
    String.raw`[\w.+\-]+@[\w\-]+(\.[\w\-]+)+`,
    String.raw`(?<![\d\-])(\+?503[\s\-]?)?[267]\d{3}[\s\-]?\d{4}(?![\d\-])`,
    String.raw`(?<!\d)\d{13,19}(?!\d)`,
    String.raw`(?<![A-Za-z])(P|A|C|M|N|O|AB|CD)[\s\-]?\d{3}[\s\-]?\d{3}(?![A-Za-z\d])`,
    String.raw`(?<!\d)(\d{1,3}\.){3}\d{1,3}(?!\d)`,
  ].map((patternString) => ({ patternString })),
  regExRedactValue: '[DATO]',
  lookupFile: { uri: file('sv-texto-nombres.txt', unique([...GIVEN_NAMES, ...SURNAMES].flatMap((v) => [v, v.toUpperCase(), fold(v), fold(v).toUpperCase()]))) },
  lookupFileRedactValue: '[NOMBRE]',
  isDenyList: true,
}, 'Cliente Menjívar, DUI 04567890-1, correo m.menjivar@gmail.com, cel 7123-4567')

domain('SV_L1_TEXTO_LIBRE', 'SV_TEXTO_LIBRE',
  byName(['observaci[oó]n(es)?|obs|comentarios?|notas?|anotaci[oó]n(es)?|descripci[oó]n_?(queja|reclamo|solicitud|caso|hechos|novedad|atenci[oó]n|denuncia)|detalle_?(reclamo|solicitud|caso|atenci[oó]n)|hechos|relato|justificaci[oó]n|(?<!(id|cd|cod|codigo|tipo|fecha|estado|num|nro)_?)mensaje(?!_?(id|tipo|codigo|fecha|estado|cola|log))|texto(_?libre)?|resumen_?(caso|atenci[oó]n)|queja|reclamo|denuncia_?texto|remarks?|comments?|notes?|free_?text|memo', 0.6]),
  byType(STRING(30)),
  byPattern([
    [String.raw`\d{8}-\d`, 0.7],
    [String.raw`[\w.+\-]+@[\w\-]+\.[A-Za-z]{2,}`, 0.7],
    [String.raw`[267]\d{3}-\d{4}`, 0.6],
  ], { reject: 0, partial: true }))

// ── L2 · Quasi-identifiers ──────────────────────────────────────────────────

// Small shifts: large enough to break the link to the person, small enough that ages and school
// years move for few people.
algorithm('SV_FECHA_NACIMIENTO', 'dateAlgorithms.DateShift', { minRange: -60, maxRange: 60, unit: 'DAYS', roll: false }, '1985-07-20')
algorithm('SV_FECHA_EVENTO', 'dateAlgorithms.DateShift', { minRange: -30, maxRange: 30, unit: 'DAYS', roll: false }, '2021-03-15')

domain('SV_L2_FECHA_NACIMIENTO', 'SV_FECHA_NACIMIENTO',
  byName(['(fecha|fec|fch|f)_?(de_?)?nac(imiento)?|fnac|fechanac(imiento)?|cumplea[nñ]os|dob|date_?of_?birth|birth_?date|birthday', 0.9]),
  byType(...DATES, STRING(6)))

// The decade stays and the unit is masked.
decompose('SV_ANIO', [[String.raw`(\d{3})(\d)`, keep, DIGITS]], keep, '1985')
domain('SV_L2_ANIO_NACIMIENTO', 'SV_ANIO',
  byName(['a[nñ]o_?(de_?)?nac(imiento)?|anio_?nac(imiento)?|year_?of_?birth|birth_?year|yob', 0.9]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// 37 becomes 3x. From 100 on, 90.
decompose('SV_EDAD', [
  [String.raw`(\d{3,})`, redactAs('90')],
  [String.raw`([1-9])(\d)([.,]\d+)`, keep, DIGITS, keep],
  [String.raw`([1-9])(\d)`, keep, DIGITS],
  [String.raw`(\d)`, DIGITS],
], keep, '37')
domain('SV_L2_EDAD', 'SV_EDAD',
  byName(['edad(_?(actual|a[nñ]os|anios|paciente|afiliado|cliente|al_?(ingreso|diagn[oó]stico|fallecimiento)))?|grupo_?etario|rango_?(de_?)?edad|quinquenio|age(_?(years|group))?', 0.85]),
  byType(NUMBER(0, 6), STRING(0, 6)))

domain('SV_L2_FECHA_EVENTO', 'SV_FECHA_EVENTO',
  byName(['(fecha|fec|fch|f)_?(de_?)?(defunci[oó]n|fallecimiento|muerte|matrimonio|divorcio|ingreso|egreso|alta|baja|retiro|contrataci[oó]n|despido|jubilaci[oó]n|hospitalizaci[oó]n|internamiento|diagn[oó]stico|atenci[oó]n|consulta|parto|captura|detenci[oó]n|condena|expedici[oó]n(_?(dui|documento))?|vencimiento_?dui|vacunaci[oó]n|cirug[ií]a|accidente|incapacidad)|fec_?(exp|expedicion|defuncion|ingreso|egreso|baja)|date_?of_?(death|marriage|hire|admission|discharge)', 0.8]),
  byType(...DATES, STRING(6)))

// Each vocabulary replaced within itself: M/F stays M/F.
decompose('SV_SEXO', [
  ['(?i)(femenino|masculino)', apply(lookup('SV_SEXO_FEMENINO_MASCULINO', 'sv-sexo-femenino-masculino.txt', ['Femenino', 'Masculino']))],
  ['(?i)(mujer|hombre)', apply(lookup('SV_SEXO_MUJER_HOMBRE', 'sv-sexo-mujer-hombre.txt', ['Mujer', 'Hombre']))],
  ['(?i)(female|male)', apply(lookup('SV_SEXO_FEMALE_MALE', 'sv-sexo-female-male.txt', ['Female', 'Male']))],
  ['(?i)([fm])', apply(lookup('SV_SEXO_F_M', 'sv-sexo-f-m.txt', ['F', 'M']))],
  ['(?i)([hm])', apply(lookup('SV_SEXO_H_M', 'sv-sexo-h-m.txt', ['H', 'M']))],
  ['([12])', apply(lookup('SV_SEXO_1_2', 'sv-sexo-1-2.txt', ['1', '2']))],
], keep, 'F')
domain('SV_L2_SEXO', 'SV_SEXO',
  byName(['sexo(_?(biol[oó]gico|al_?nacer|paciente|afiliado|cliente))?|(tp|tipo|cod|cd|id)_?sexo|g[eé]nero(?!_?(identidad|autopercibido))|sex|gender(?!_?identity)', 0.85]),
  byList([['sv-detectar-sexo.txt', ['f', 'm', 'h', 'femenino', 'masculino', 'mujer', 'hombre', 'female', 'male'], 0.5]], { reject: 0.5 }))

// ── L2 · Where people live ──────────────────────────────────────────────────
//
// The 2023 restructuring turned the 262 municipalities into distritos of 44 municipios, and the 2024
// census counts both. 190 of the 262 distritos have fewer than 20,000 inhabitants — a quarter of the
// country lives in them, and the smallest has under 600. A birth date, a sex and one of those
// distritos point at a handful of people. A small distrito becomes the nearest one of at least
// 20,000 in the same municipio, or in the same departamento when its municipio has none; every
// municipio of the 44 is far above the threshold, so municipio and departamento stay.

const distance = (a, b) => {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}
const SMALL_PLACE = 20000
const nearest = (place, candidates) => candidates.reduce((best, x) => (distance(place, x) < distance(place, best) ? x : best))
const largeDistritos = DISTRITOS.filter((d) => d.population >= SMALL_PLACE)
const distritoTo = (d) => {
  const sameMunicipality = largeDistritos.filter((x) => x.municipalityCode === d.municipalityCode)
  const sameDepartment = largeDistritos.filter((x) => x.departmentCode === d.departmentCode)
  return nearest(d, sameMunicipality.length ? sameMunicipality : sameDepartment.length ? sameDepartment : largeDistritos)
}
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
// With the departamento, as systems write it to tell homonyms apart: "San José - La Libertad".
const SEPARATORS = [[' - ', ''], [', ', ''], [' (', ')'], ['/', ''], ['-', '']]

/**
 * The generalization table. `places` carry name, departamento, `small` and `to` — the place they
 * become. A name shared by several places is generalized only when all of them are small, to the
 * fate of the most populous; written with the departamento, the same rule applies inside it.
 */
function generalization(places) {
  const byName = new Map()
  const byNameDepartment = new Map()
  const add = (map, key, name, p) => {
    const entry = map.get(key) ?? { spellings: new Set(), all: new Set() }
    entry.spellings.add(name)
    entry.all.add(p)
    map.set(key, entry)
  }
  for (const p of places) {
    for (const name of spellingsOf(p)) {
      add(byName, nameKey(name), name, p)
      add(byNameDepartment, `${nameKey(name)}|${p.departmentCode}`, name, p)
    }
  }
  const mostPopulous = (all) => [...all].reduce((a, b) => (b.population > a.population ? b : a))
  const pairs = []
  let names = 0
  for (const { spellings: written, all } of byName.values()) {
    if ([...all].some((p) => !p.small)) continue
    const to = mostPopulous(all).to.name
    for (const name of written) pairs.push([name, to])
    names++
  }
  for (const { spellings: written, all } of byNameDepartment.values()) {
    if ([...all].some((p) => !p.small)) continue
    const from = mostPopulous(all)
    for (const name of written) for (const [a, b] of SEPARATORS) pairs.push([`${name}${a}${from.department}${b}`, `${from.to.name}${a}${from.to.department}${b}`])
  }
  const withDepartment = (p) => spellingsOf(p).flatMap((name) => SEPARATORS.map(([a, b]) => `${name}${a}${p.department}${b}`))
  const kept = new Set(variants(places.filter((p) => !p.small).flatMap((p) => [...withDepartment(p), ...spellingsOf(p)].map((n) => [n, n]))).map(([from]) => from))
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

const distritoPlaces = DISTRITOS.map((d) => ({ ...d, small: d.population < SMALL_PLACE, to: d.population < SMALL_PLACE ? distritoTo(d) : d }))
const municipioPlaces = MUNICIPIOS.map((m) => ({ ...m, small: false, to: m }))
const places = generalization([...distritoPlaces, ...municipioPlaces])
cleansing('SV_DISTRITO', 'sv-distritos-generalizados.txt', places.table, 'Apaneca', '|')

// Codes of the Dirección General de Estadística y Censos: two digits for the departamento, four for
// the municipio and six for the distrito.
const codePairs = distritoPlaces.filter((d) => d.small).map((d) => [d.code, d.to.code])
cleansing('SV_CODIGO_GEOGRAFICO', 'sv-codigos-geograficos-generalizados.txt', codePairs, '010102', '|')

const PERSONAL_WORDS = new Set([...GIVEN_NAMES, ...SURNAMES].map((w) => fold(w).toLowerCase()))
const DEPARTMENT_NAMES = new Set([...DEPARTMENTS, 'El Salvador'].map((n) => fold(n).toLowerCase()))
const placeNames = (list) => unique(list.flatMap(spellingsOf))
  .filter((n) => !PERSONAL_WORDS.has(fold(n).toLowerCase()) && !DEPARTMENT_NAMES.has(fold(n).toLowerCase()))

domain('SV_L2_DISTRITO', 'SV_DISTRITO',
  byName(['distrito(?!_?(cod|codigo|id|escolar|judicial))(_?(residencia|nacimiento|domicilio))?|municipio(?!_?(cod|codigo|id))(_?(residencia|nacimiento|domicilio))?|ciudad(_?(residencia|nacimiento|domicilio|cliente))?|(nom|nombre|desc)_?(distrito|municipio|ciudad)|lugar_?(de_?)?nacimiento|city|town', 0.85]),
  byList([['sv-detectar-distritos.txt', placeNames([...DISTRITOS, ...MUNICIPIOS]), 0.8]], { reject: 0.4 }))

domain('SV_L2_CODIGO_GEOGRAFICO', 'SV_CODIGO_GEOGRAFICO',
  byName(['(cod|codigo|cd|id)_?(distrito|municipio|mun|ciudad|lugar)(_?(digestyc|censo|res|residencia|nac|nacimiento))?|(cod|codigo)_?(digestyc|geogr[aá]fico)|coddis|codmun', 0.85]),
  byPattern([[String.raw`(0[1-9]|1[0-4])\d{2}(\d{2})?`, 0.4]], { reject: 0.3 }))

// Below the distrito are the cantones and caseríos: a few hundred people each, and the address of
// most rural households.
lookup('SV_ZONA_RURAL', 'sv-zona-rural.txt', ['Zona rural'], 'Cantón El Espino', 'PRESERVE_LOOKUP_FILE')
domain('SV_L2_CANTON', 'SV_ZONA_RURAL',
  byName(['cant[oó]n(_?(residencia|nombre))?|caser[ií]o|aldea|paraje|zona_?rural|comunidad(_?rural)?|hacienda|finca|parcelaci[oó]n', 0.85]))

lookup('SV_COLONIA', 'sv-colonias.txt', COLONIAS, 'Colonia San Benito', 'PRESERVE_LOOKUP_FILE')
domain('SV_L2_COLONIA', 'SV_COLONIA',
  byName(['colonia|col(?!_?(umna|or))|residencial|reparto|urbanizaci[oó]n|lotificaci[oó]n|barrio(_?(residencia|domicilio))?|(nom|nombre)_?(colonia|barrio|residencial)|comunidad(_?urbana)?|neighbou?rhood', 0.8]))

// Four digits: the first two are the departamento and the postal zone.
decompose('SV_CODIGO_POSTAL', [[String.raw`(\d{2})(\d{2})`, keep, redactAs('00')]], keep, '1101')
domain('SV_L2_CODIGO_POSTAL', 'SV_CODIGO_POSTAL',
  byName(['c[oó]digo_?postal|cod_?postal|codpostal|zip(_?code)?|postal_?code|cp', 0.85]),
  byType(STRING(4, 4), NUMBER(0, 4)))

const MARITAL = ['Soltero/a', 'Casado/a', 'Acompañado/a', 'Separado/a', 'Divorciado/a', 'Viudo/a']
categorical('SV_ESTADO_FAMILIAR', 'sv-estado-familiar.txt', MARITAL, 'Unión no matrimonial', ['1', '2', '3', '4', '5', '6'])
domain('SV_L2_ESTADO_FAMILIAR', 'SV_ESTADO_FAMILIAR',
  byName(['estado_?(familiar|civil)|est_?(familiar|civil)|(cod|tipo|id)_?estado_?(familiar|civil)|situaci[oó]n_?conyugal|marital_?status|civil_?status', 0.85]),
  byList([['sv-detectar-estado-familiar.txt', [...MARITAL, 'soltero', 'soltera', 'casado', 'casada', 'acompañado', 'acompañada', 'unión libre', 'union libre', 'separado', 'separada', 'divorciado', 'divorciada', 'viudo', 'viuda'], 0.7]], { reject: 0.4 }))

lookup('SV_OCUPACION', 'sv-ocupaciones.txt', ['Empleado administrativo', 'Vendedor', 'Cajero', 'Motorista', 'Repartidor', 'Albañil', 'Maestro de obra', 'Docente', 'Enfermero', 'Médico', 'Contador', 'Abogado', 'Ingeniero', 'Programador', 'Recepcionista', 'Personal de limpieza', 'Vigilante', 'Cocinero', 'Mesero', 'Electricista', 'Fontanero', 'Mecánico', 'Agricultor', 'Jornalero', 'Pescador', 'Operario de maquila', 'Asesor de ventas', 'Agente de call center', 'Bodeguero', 'Estilista', 'Costurera', 'Comerciante informal', 'Ama de casa', 'Estudiante', 'Jubilado'], 'Gerente de operaciones')
decompose('SV_OCUPACION_O_CODIGO', [
  // Clasificación Nacional de Ocupaciones: four digits.
  [String.raw`(\d{2,5})`, DIGITS],
], apply('SV_OCUPACION'), 'Gerente de operaciones')
domain('SV_L2_OCUPACION', 'SV_OCUPACION_O_CODIGO',
  byName(
    ['ocupaci[oó]n|profesi[oó]n|oficio|cno|(cod|codigo)_?(ocupacion|profesion|cno)|puesto_?(de_?)?trabajo|categor[ií]a_?ocupacional|cargo_?(actual|empleado)|occupation|profession|job_?title', 0.8],
    ['cargo|puesto', 0.5],
  ))

lookup('SV_EMPLEADOR', 'sv-empleadores.txt', ['Distribuidora Cuscatlán S.A. de C.V.', 'Constructora Salvadoreña S.A. de C.V.', 'Transportes El Trébol S.A. de C.V.', 'Supermercados La Despensa S.A. de C.V.', 'Industrias Metálicas del Pacífico S.A.', 'Clínica Santa Teresa S.A. de C.V.', 'Colegio Nuevo Amanecer', 'Servicios Integrales del Norte S.A. de C.V.', 'Agroindustrias El Volcán S.A. de C.V.', 'Comercial Los Almendros S.A. de C.V.', 'Soluciones Digitales Centroamericanas S.A.', 'Restaurante Sabor Criollo S.A. de C.V.', 'Hotel Mirador del Lago S.A. de C.V.', 'Laboratorio Vida Sana S.A. de C.V.', 'Seguridad Atalaya S.A. de C.V.', 'Textiles La Aguja S.A. de C.V.', 'Repuestos del Oriente S.A. de C.V.', 'Farmacia El Buen Vecino', 'Logística Puerto Nuevo S.A. de C.V.', 'Cooperativa Agrícola La Unión de R.L.', 'Fundación Manos Unidas', 'Panadería Pan de Casa', 'Despacho Contable Asociados S.A. de C.V.', 'Beneficio de Café Los Naranjos S.A.'], 'Grupo Agrisal S.A. de C.V.', 'PRESERVE_LOOKUP_FILE')
domain('SV_L2_EMPLEADOR', 'SV_EMPLEADOR',
  byName(['empleador(_?(nombre|raz[oó]n_?social|nit))?|(nombre|nom)_?(empleador|empresa_?donde_?trabaja|patrono)|empresa_?(donde_?)?(trabaja|labora)|lugar_?(de_?)?trabajo|patrono(_?nombre)?|employer(_?name)?|workplace', 0.9]))

const EDUCATION = ['Ninguno', 'Parvularia', 'Básica (1.º a 6.º)', 'Básica (7.º a 9.º)', 'Bachillerato', 'Técnico', 'Universitario', 'Postgrado', 'Maestría', 'Doctorado']
categorical('SV_ESCOLARIDAD', 'sv-escolaridad.txt', EDUCATION, 'Educación media incompleta', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
domain('SV_L2_ESCOLARIDAD', 'SV_ESCOLARIDAD',
  byName(['escolaridad|nivel_?(educativo|de_?estudios|acad[eé]mico|alcanzado)|grado_?(de_?)?(estudio|escolaridad)|m[aá]ximo_?nivel|a[nñ]os_?(de_?)?estudio|education(_?level)?', 0.8]),
  byList([['sv-detectar-escolaridad.txt', [...EDUCATION, 'parvularia', 'básica', 'basica', 'bachillerato', 'bachiller', 'técnico', 'universitario', 'postgrado', 'maestría', 'ninguno', 'analfabeta'], 0.6]], { reject: 0.4 }))

lookup('SV_CENTRO_EDUCATIVO', 'sv-centros-educativos.txt', ['Centro Escolar Cantón El Espino', 'Centro Escolar República de Panamá', 'Complejo Educativo Tomás Medina', 'Instituto Nacional General Francisco Menéndez', 'Colegio Nuestra Señora del Rosario', 'Liceo Salvadoreño', 'Escuela de Educación Parvularia N.º 3', 'Instituto Técnico Ricaldone', 'Universidad Nacional', 'Universidad Centroamericana', 'Centro Escolar Católico Santa Teresita', 'Complejo Educativo Walter Thilo Deininger'], 'Universidad de El Salvador')
domain('SV_L2_CENTRO_EDUCATIVO', 'SV_CENTRO_EDUCATIVO',
  byName(['centro_?(escolar|educativo)|complejo_?educativo|(nombre|nom)_?(centro_?escolar|escuela|colegio|instituci[oó]n_?educativa|universidad)|instituci[oó]n_?educativa|escuela|colegio|instituto|universidad|c[oó]digo_?(de_?)?(infraestructura|centro_?escolar)|school(_?name)?|university', 0.75]))

// Capped at 5 as text: large households are rare, and a rare count identifies.
decompose('SV_CONTEO_LIMITADO', [[String.raw`([0-5])`, keep], [String.raw`(\d+)`, redactAs('5')]], keep, '9')
domain('SV_L2_PERSONAS_A_CARGO', 'SV_CONTEO_LIMITADO',
  byName(['personas_?a_?cargo|n(o|ro|um|umero)_?(de_?)?(hijos|dependientes|personas_?a_?cargo)|cant(idad)?_?(hijos|dependientes|personas_?hogar|miembros)|hijos|dependientes|personas_?(en_?el_?)?hogar|tama[nñ]o_?(del_?)?hogar|miembros_?(del_?)?hogar|number_?of_?children|dependents', 0.8]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// ── L3 · Sensitive data (art. 4 g and art. 59 b) ────────────────────────────

// The 2024 census asked about self-identification with an indigenous people; the law names ethnic
// origin, and art. 59 b) adds nationality to the same sentence.
const ETHNIC_GROUPS = ['Náhuat Pipil', 'Lenca', 'Kakawira (Cacaopera)', 'Mestizo', 'Blanco', 'Negro o afrodescendiente', 'Otro', 'Ninguno']
categorical('SV_ORIGEN_ETNICO', 'sv-origen-etnico.txt', ETHNIC_GROUPS, 'Indígena', ['1', '2', '3', '4', '5', '6'])
domain('SV_L3_ORIGEN_ETNICO', 'SV_ORIGEN_ETNICO',
  byName(['etnia|origen_?([eé]tnico|racial)|grupo_?[eé]tnico|pertenencia_?[eé]tnica|autoidentificaci[oó]n(_?[eé]tnica)?|autorreconocimiento|(cod|codigo|tipo|id)_?(etnia|origen_?etnico)|raza|ind[ií]gena|pueblo_?(ind[ií]gena|originario)|afrodescendiente|ethnicity|race', 0.95]),
  byList([['sv-detectar-origen-etnico.txt', [...ETHNIC_GROUPS, 'náhuat', 'nahuat', 'pipil', 'lenca', 'kakawira', 'cacaopera', 'indígena', 'mestizo', 'blanco', 'negro', 'afrodescendiente', 'ninguno'], 0.9],
    // Belonging is often a yes/no flag or a census code: it backs up the column name but decides nothing alone.
    ['sv-detectar-codigos-banderas.txt', ['s', 'n', 'sí', 'no', '1', '2', '3', '4', '5', '6'], 0.3],
  ], { reject: 0.4 }))

const LANGUAGES = ['Español', 'Náhuat', 'Lenca (potón)', 'Kakawira', 'Lengua de señas salvadoreña', 'Inglés', 'Otra', 'Ninguna lengua indígena']
categorical('SV_LENGUA', 'sv-lenguas.txt', LANGUAGES, 'Náhuat pipil')
domain('SV_L3_LENGUA_INDIGENA', 'SV_LENGUA',
  byName(['lengua(_?(ind[ií]gena|materna|nativa|originaria|de_?se[nñ]as))?|idioma(_?(ind[ií]gena|materno|nativo))?|habla_?(lengua|idioma)|mother_?tongue|native_?language', 0.9]),
  byList([['sv-detectar-lenguas.txt', [...LANGUAGES, 'náhuat', 'nahuat', 'pipil', 'lenca', 'potón', 'kakawira', 'español', 'castellano', 'lessa'], 0.8]], { reject: 0.4 }))

// Art. 59 b) names nationality beside ethnic origin: in El Salvador it separates the nationals from
// the Nicaraguan, Honduran and Venezuelan communities and from returnees.
const NATIONALITIES = ['Salvadoreña', 'Hondureña', 'Guatemalteca', 'Nicaragüense', 'Costarricense', 'Mexicana', 'Estadounidense', 'Venezolana', 'Colombiana', 'China', 'Española', 'Italiana']
lookup('SV_NACIONALIDAD', 'sv-nacionalidades.txt', NATIONALITIES, 'Panameña')
domain('SV_L3_NACIONALIDAD', 'SV_NACIONALIDAD',
  byName(['nacionalidad|pa[ií]s_?(de_?)?(nacimiento|origen|nacionalidad|procedencia)|ciudadan[ií]a|nationality|citizenship|country_?of_?birth|condici[oó]n_?migratoria|persona_?retornada|deportad[oa]', 0.85]),
  byList([['sv-detectar-nacionalidades.txt', [...NATIONALITIES, 'salvadoreño', 'salvadoreña', 'hondureño', 'guatemalteco', 'nicaragüense', 'costarricense', 'mexicano', 'estadounidense', 'venezolano', 'colombiano', 'chino', 'español', 'el salvador', 'honduras', 'guatemala', 'nicaragua', 'estados unidos', 'extranjero', 'extranjera'], 0.7]], { reject: 0.4 }))

const RELIGIONS = ['Católica', 'Evangélica', 'Protestante histórica', 'Testigo de Jehová', 'Iglesia de Jesucristo de los Santos de los Últimos Días', 'Adventista', 'Judía', 'Musulmana', 'Otra', 'Ninguna']
categorical('SV_RELIGION', 'sv-religiones.txt', RELIGIONS, 'Ortodoxa')
domain('SV_L3_RELIGION', 'SV_RELIGION',
  byName(['religi[oó]n|creencia_?(religiosa|espiritual)|convicci[oó]n_?(religiosa|espiritual)|credo|confesi[oó]n_?religiosa|culto|iglesia(_?(a_?la_?que_?pertenece|nombre))?|denominaci[oó]n_?religiosa|(cod|codigo|tipo)_?religion|religion|church', 0.95]),
  byList([['sv-detectar-religiones.txt', [...RELIGIONS, 'católico', 'catolico', 'cristiano', 'cristiana', 'evangélico', 'protestante', 'adventista', 'testigo de jehová', 'mormón', 'judío', 'musulmán', 'ateo', 'agnóstico', 'ninguna', 'ninguno'], 0.9]], { reject: 0.4 }))

domain('SV_L3_CONVICCION_FILOSOFICA', 'SV_CATEGORIA_SUPRIMIDA',
  byName(['convicci[oó]n(es)?_?(filos[oó]ficas?|morales?|espirituales?|personales?)|creencias?_?(filos[oó]ficas?|morales?|personales?)|objeci[oó]n_?(de_?)?conciencia|objetor_?(de_?)?conciencia|logia|masoner[ií]a|beliefs?|philosophical_?beliefs?', 0.9]))

const IDEOLOGIES = ['Izquierda', 'Centroizquierda', 'Centro', 'Centroderecha', 'Derecha', 'Independiente', 'Prefiere no responder']
categorical('SV_IDEOLOGIA_POLITICA', 'sv-ideologias-politicas.txt', IDEOLOGIES, 'Oficialista')
domain('SV_L3_IDEOLOGIA_POLITICA', 'SV_IDEOLOGIA_POLITICA',
  byName(['ideolog[ií]a(_?pol[ií]tica)?|opini[oó]n_?pol[ií]tica|orientaci[oó]n_?pol[ií]tica|tendencia_?pol[ií]tica|preferencia_?(pol[ií]tica|partidaria|electoral)|intenci[oó]n_?(de_?)?voto|simpat[ií]a_?pol[ií]tica|political_?(opinion|orientation|view)|voting_?intention', 0.9]),
  byList([['sv-detectar-ideologias-politicas.txt', [...IDEOLOGIES, 'izquierda', 'derecha', 'centro', 'progresista', 'conservador', 'independiente', 'indeciso', 'voto nulo', 'ninguno'], 0.7]], { reject: 0.4 }))

// Party membership: the parties registered with the Tribunal Supremo Electoral.
const PARTIES = ['Nuevas Ideas', 'Alianza Republicana Nacionalista (ARENA)', 'Frente Farabundo Martí para la Liberación Nacional (FMLN)', 'Gran Alianza por la Unidad Nacional (GANA)', 'Partido de Concertación Nacional (PCN)', 'Partido Demócrata Cristiano (PDC)', 'Vamos', 'Nuestro Tiempo', 'Fuerza Solidaria', 'Fraternidad Patriota Salvadoreña', 'Sin afiliación']
categorical('SV_PARTIDO', 'sv-partidos.txt', PARTIES, 'Cambio Democrático')
domain('SV_L3_AFILIACION_PARTIDARIA', 'SV_PARTIDO',
  byName(['partido(_?pol[ií]tico)?(_?(afiliaci[oó]n|nombre))?|afiliaci[oó]n_?(pol[ií]tica|partidaria|partido)|afiliado_?partido|militancia(_?pol[ií]tica)?|militante|(cod|codigo|nombre|nom)_?partido|bandera_?pol[ií]tica|political_?party|party_?membership', 0.95]),
  byList([['sv-detectar-partidos.txt', [...PARTIES, 'Nuevas Ideas', 'ARENA', 'FMLN', 'GANA', 'PCN', 'PDC', 'Vamos', 'Nuestro Tiempo', 'CD', 'Cambio Democrático'], 0.8]], { reject: 0.4 }))

domain('SV_L3_AFILIACION_SINDICAL', 'SV_CATEGORIA_SUPRIMIDA',
  byName(['sindicato(_?(nombre|afiliado|afiliaci[oó]n|codigo))?|sindicalizado|afiliado_?sindicato|afiliaci[oó]n_?sindical|cuota_?sindical|descuento_?sindical|aporte_?sindical|asociaci[oó]n_?sindical|contrato_?colectivo|fuero_?sindical|directivo_?sindical|trade_?union|union_?member(ship)?', 0.95]),
  byList([['sv-detectar-sindicatos.txt', ['CATS', 'CSTS', 'CTS', 'SIMETRISSS', 'ANDES', 'SITRASAL', 'STISSS', 'SITRAIMAGRO', 'ASTTEL', 'FEASIES', 'Confederación Sindical de Trabajadores', 'sindicalizado', 'afiliado'], 0.6]], { reject: 0.3 }))

domain('SV_L3_BIOMETRICO', 'SV_REDACTAR',
  byName(['biometr[ií]a[a-z_]*|biom[eé]trico[a-z_]*|huella(_?dactilar)?(_?(template|plantilla|imagen|hash))?|huellas|dactilar|template_?(facial|huella|biometrico)|plantilla_?(facial|biom[eé]trica)|rostro_?(hash|template)|reconocimiento_?facial|firma_?(biom[eé]trica|digitalizada|electr[oó]nica)|iris|voz_?(biom[eé]trica|template)|fingerprints?|face_?(template|hash|encoding)|biometric[a-z_]*', 0.9]),
  byType(STRING()))

domain('SV_L3_GENETICO', 'SV_REDACTAR',
  byName(['adn|dna|gen[eé]tic[oa]s?|datos?_?gen[eé]ticos?|genoma|genotip[a-z_]*|prueba_?(gen[eé]tica|de_?adn|de_?paternidad|de_?filiaci[oó]n)|perfil_?gen[eé]tico|mutaci[oó]n|brca[12]?|cariotipo|tamizaje_?neonatal|genetic[a-z_]*', 0.9]))

const ORIENTATIONS = ['Heterosexual', 'Gay', 'Lesbiana', 'Bisexual', 'Pansexual', 'Asexual', 'Otra', 'Prefiere no responder']
categorical('SV_ORIENTACION_SEXUAL', 'sv-orientaciones-sexuales.txt', ORIENTATIONS, 'Homosexual')
domain('SV_L3_ORIENTACION_SEXUAL', 'SV_ORIENTACION_SEXUAL',
  byName(['orientaci[oó]n_?sexual|preferencias?_?sexuales?|(cod|codigo|tipo)_?orientacion_?sexual|sexual_?orientation', 0.95]),
  byList([['sv-detectar-orientaciones-sexuales.txt', [...ORIENTATIONS, 'hetero', 'homosexual', 'lgbti', 'lgbtiq+', 'queer'], 0.8]], { reject: 0.4 }))

domain('SV_L3_VIDA_SEXUAL', 'SV_CATEGORIA_SUPRIMIDA',
  byName(['vida_?sexual|actividad_?sexual|conducta_?sexual|pr[aá]cticas?_?sexuales?|parejas?_?sexuales?|n(o|ro|um|umero)_?parejas|sexualmente_?activ[oa]|inicio_?(de_?)?(la_?)?vida_?sexual|relaciones_?sexuales|sex(ual)?_?life|sexual_?(activity|behavio(u)?r|partners)', 0.9]))

const IDENTITIES = ['Mujer cisgénero', 'Hombre cisgénero', 'Mujer trans', 'Hombre trans', 'Persona no binaria', 'Otra', 'Prefiere no responder']
categorical('SV_IDENTIDAD_GENERO', 'sv-identidades-genero.txt', IDENTITIES, 'Transgénero')
domain('SV_L3_IDENTIDAD_GENERO', 'SV_IDENTIDAD_GENERO',
  byName(['identidad_?(de_?)?g[eé]nero|(cod|codigo|tipo)_?identidad_?genero|g[eé]nero_?(autopercibido|identitario)|expresi[oó]n_?de_?g[eé]nero|transg[eé]nero|persona_?trans|nombre_?identitario|pronombres?|gender_?identity', 0.95]),
  byList([['sv-detectar-identidades-genero.txt', [...IDENTITIES, 'cisgénero', 'cis', 'transgénero', 'trans', 'no binario', 'no binaria', 'mujer', 'hombre'], 0.7]], { reject: 0.4 }))

// Art. 4 g) counts the "situación moral y familiar" and the "hábitos personales" among the data
// whose misuse discriminates — categories no other law of the region spells out.
domain('SV_L3_SITUACION_FAMILIAR', 'SV_CATEGORIA_SUPRIMIDA',
  byName(['situaci[oó]n_?(moral|familiar)|composici[oó]n_?familiar|v[ií]nculo_?familiar|convivencia|vive_?con|estructura_?familiar|antecedentes_?familiares(?!_?(m[eé]dicos|patol[oó]gicos))|referencias?_?morales|conducta_?(moral|personal)|reputaci[oó]n', 0.85]))

domain('SV_L3_HABITOS', 'SV_CATEGORIA_SUPRIMIDA',
  byName(['h[aá]bitos?(_?(personales|de_?consumo|de_?navegaci[oó]n|alimenticios|de_?vida))?|estilo_?de_?vida|preferencias?(_?(de_?consumo|personales|de_?navegaci[oó]n))|perfil(_?(de_?)?(consumo|navegaci[oó]n|comportamiento))|comportamiento_?(de_?)?(compra|navegaci[oó]n|usuario)|intereses|gustos|historial_?(de_?)?(navegaci[oó]n|b[uú]squeda|compras)|browsing_?history|habits?', 0.85]))

// Victims: the Ley Especial Integral para una Vida Libre de Violencia para las Mujeres and the law
// on internal forced displacement both order the identity of the victim to be protected.
domain('SV_L3_VICTIMA', 'SV_CATEGORIA_SUPRIMIDA',
  byName(['v[ií]ctima(_?(de_?)?(violencia(_?(de_?g[eé]nero|intrafamiliar|sexual|patrimonial))?|delito|trata|desplazamiento|abuso))?|violencia_?(de_?)?g[eé]nero|violencia_?(intrafamiliar|dom[eé]stica|sexual|patrimonial)|tipo_?(de_?)?violencia|medida_?(de_?)?protecci[oó]n|orden_?(de_?)?restricci[oó]n|desplazamiento_?forzado|persona_?desplazada|trata_?(de_?)?personas|denunciante_?violencia', 0.9]))

// ── SALUD · Health data (art. 4 g and art. 39) ──────────────────────────────

domain('SV_SALUD_IDENTIFICADOR', 'SV_CM_ALFANUM',
  byName(
    ['n(o|ro|um|umero)_?(expediente(_?cl[ií]nico)?|hc|historia(_?cl[ií]nica)?|ingreso|atenci[oó]n|consulta|referencia_?m[eé]dica|receta)|expediente_?(cl[ií]nico|m[eé]dico)|historia_?cl[ií]nica|hc_?(n(o|ro|um|umero))?|n(o|ro|um|umero)_?(asegurado|afiliado_?isss)|c[oó]digo_?(paciente|expediente)|id_?paciente', 0.85],
    ['expediente|atenci[oó]n|ingreso|consulta', 0.55],
  ))

const COVERAGE = ['ISSS', 'MINSAL (sistema público)', 'Bienestar Magisterial', 'Sanidad Militar (COSAM)', 'ISBM', 'Seguro médico privado', 'FOSALUD', 'Sin cobertura']
decompose('SV_COBERTURA_SALUD', [
  [FLAG, apply('SV_BANDERA')],
  [String.raw`(\d{1,8})`, DIGITS],
], apply(lookup('SV_COBERTURA', 'sv-cobertura-salud.txt', COVERAGE, undefined, 'PRESERVE_LOOKUP_FILE')), 'ISSS')
domain('SV_SALUD_COBERTURA', 'SV_COBERTURA_SALUD',
  byName(['cobertura(_?(m[eé]dica|de_?salud|social))?|seguro_?(m[eé]dico|salud)|r[eé]gimen(_?(de_?)?salud)?|proveedor_?(de_?)?salud|isss(_?(afiliado|cobertura))?|minsal|fosalud|bienestar_?magisterial|cosam|isbm|aseguradora_?(m[eé]dica|salud)|plan_?m[eé]dico', 0.85]),
  byList([['sv-detectar-cobertura.txt', [...COVERAGE, 'isss', 'minsal', 'fosalud', 'bienestar magisterial', 'cosam', 'isbm', 'privado', 'sin cobertura', 'público'], 0.8]], { reject: 0.4 }))

const ICD10 = ['I10', 'E11', 'E78', 'J45', 'J06', 'J02', 'J20', 'K29', 'K21', 'K59', 'M54', 'M17', 'M25', 'N39', 'N20', 'R51', 'R10', 'H10', 'H66', 'L23', 'L30', 'B34', 'A09', 'E03', 'E66', 'D50', 'I83', 'K80', 'K40', 'S93', 'S60', 'Z00', 'J30', 'J32', 'G43', 'M79', 'R05']
const ICD10_DECIMAL = ['E11.9', 'E78.5', 'J45.9', 'J06.9', 'J02.9', 'J20.9', 'K29.7', 'K21.9', 'K59.0', 'M54.5', 'M17.9', 'N39.0', 'N20.0', 'R10.4', 'H10.9', 'H66.9', 'L23.9', 'L30.9', 'B34.9', 'A09.9', 'E03.9', 'E66.9', 'D50.9', 'I83.9', 'K80.2', 'K40.9', 'S93.4', 'S60.0', 'Z00.0', 'J30.4', 'J32.9', 'G43.9', 'M79.1']
decompose('SV_DIAGNOSTICO', [
  [String.raw`([A-TV-Za-tv-z]\d{2}\.\d{1,2})`, apply(lookup('SV_CIE10_DECIMAL', 'sv-cie10-decimal.txt', ICD10_DECIMAL, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [String.raw`([A-TV-Za-tv-z]\d{2,3}X?)`, apply(lookup('SV_CIE10', 'sv-cie10.txt', ICD10, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [FLAG, apply('SV_BANDERA')],
], apply(lookup('SV_DIAGNOSTICO_TEXTO', 'sv-diagnosticos.txt', ['Hipertensión arterial', 'Diabetes mellitus tipo 2', 'Asma', 'Lumbalgia', 'Gastritis crónica', 'Faringitis aguda', 'Infección de vías urinarias', 'Migraña', 'Hipotiroidismo', 'Dislipidemia', 'Obesidad', 'Artrosis de rodilla', 'Bronquitis aguda', 'Amigdalitis aguda', 'Dermatitis de contacto', 'Otitis media aguda', 'Esguince de tobillo', 'Conjuntivitis', 'Anemia ferropénica', 'Enfermedad por reflujo gastroesofágico', 'Síndrome de intestino irritable', 'Tendinitis', 'Sinusitis aguda', 'Cefalea tensional', 'Várices', 'Hernia inguinal', 'Litiasis renal', 'Colelitiasis', 'Gastroenteritis aguda', 'Control de salud'])), 'F33.1')
domain('SV_SALUD_DIAGNOSTICO', 'SV_DIAGNOSTICO',
  byName(['diagn[oó]stico[a-z_]*|dx(_?(principal|secundario|ingreso|egreso)[0-9]?)?|cie_?10|cie(_?(10|11|principal))?|(cod|codigo)_?(diagnostico|dx|cie)|impresi[oó]n_?diagn[oó]stica|enfermedad(es)?[a-z_]*|patolog[ií]a|comorbilidad(es)?|antecedentes?_?(m[eé]dicos|patol[oó]gicos|cl[ií]nicos|personales)|causa_?(de_?)?(muerte|defunci[oó]n|incapacidad|hospitalizaci[oó]n|consulta)|motivo_?(de_?)?(consulta|incapacidad|hospitalizaci[oó]n)|alergias?|diagnos(is|es)|icd_?(10|11)?', 0.85]),
  // 0.5: codes shaped like ICD-10 appear in other catalogs too; the name has to agree.
  byPattern([[String.raw`[A-TV-Za-tv-z]\d{2}(\.\d{1,2}|\d|X)?`, 0.5]], { reject: 0.3 }))

decompose('SV_PROCEDIMIENTO', [[String.raw`(\d{4,6})`, DIGITS]], apply(lookup('SV_PROCEDIMIENTO_TEXTO', 'sv-procedimientos.txt', ['Consulta médica general', 'Consulta de emergencia', 'Hemograma completo', 'Glucosa en sangre', 'Examen general de orina', 'Creatinina', 'Radiografía de tórax', 'Ultrasonografía abdominal', 'Electrocardiograma', 'Control prenatal'])), 'Prueba de carga viral para VIH')
domain('SV_SALUD_PROCEDIMIENTO', 'SV_PROCEDIMIENTO',
  byName(['procedimiento(_?(m[eé]dico|quir[uú]rgico|realizado|autorizado))?|(cod|codigo)_?(procedimiento|prestaci[oó]n|servicio_?salud)|prestaci[oó]n_?(m[eé]dica|de_?salud)|examen_?(ordenado|realizado)|cirug[ií]a(_?realizada)?|intervenci[oó]n_?quir[uú]rgica|medical_?procedure', 0.85]))

const MEDICATIONS = ['Acetaminofén', 'Ibuprofeno', 'Diclofenaco', 'Metformina', 'Glibenclamida', 'Losartán', 'Enalapril', 'Amlodipino', 'Atorvastatina', 'Omeprazol', 'Levotiroxina', 'Amoxicilina', 'Cefalexina', 'Salbutamol', 'Loratadina', 'Hidroclorotiazida', 'Ácido acetilsalicílico', 'Prednisona', 'Azitromicina', 'Sulfato ferroso', 'Ácido fólico', 'Complejo B']
categorical('SV_MEDICAMENTO', 'sv-medicamentos.txt', MEDICATIONS, 'Sertralina 50 mg')
domain('SV_SALUD_MEDICAMENTO', 'SV_MEDICAMENTO',
  byName(['medicamentos?(_?(recetado|prescrito|entregado|despachado|nombre|uso))?|f[aá]rmacos?|principio_?activo|receta(_?m[eé]dica)?|prescripci[oó]n(_?medicamento)?|posolog[ií]a|tratamiento_?farmacol[oó]gico|(cod|codigo)_?medicamento|medications?|drugs?_?prescribed', 0.85]),
  byList([['sv-detectar-medicamentos.txt', [...MEDICATIONS, 'acetaminofen', 'sertralina', 'fluoxetina', 'escitalopram', 'quetiapina', 'clonazepam', 'alprazolam', 'lorazepam', 'litio', 'metilfenidato', 'risperidona', 'olanzapina', 'haloperidol', 'tenofovir', 'emtricitabina', 'dolutegravir', 'efavirenz', 'insulina', 'warfarina', 'levetiracetam', 'ácido valproico', 'misoprostol', 'levonorgestrel', 'anticonceptivo'], 0.7]], { reject: 0.3 }))

domain('SV_SALUD_TEXTO_CLINICO', 'SV_TEXTO_LIBRE',
  byName(['anamnesis|evoluci[oó]n(_?(m[eé]dica|cl[ií]nica|enfermer[ií]a))?|enfermedad_?actual|examen_?f[ií]sico|plan_?(de_?)?(manejo|tratamiento)|indicaciones_?m[eé]dicas|conducta(_?m[eé]dica)?|epicrisis|resumen_?(de_?)?(alta|egreso|atenci[oó]n)|nota_?(m[eé]dica|de_?enfermer[ií]a|cl[ií]nica)|notas?_?(m[eé]dicas|cl[ií]nicas)|triage(_?texto)?|informe_?(patolog[ií]a|radiolog[ií]a|m[eé]dico)|clinical_?notes?|discharge_?summary', 0.85]),
  byType(STRING(30)))

domain('SV_SALUD_RESULTADO_EXAMEN', 'SV_CM_ALFANUM',
  byName(
    ['resultado_?(del_?)?(examen|prueba|laboratorio|pcr|serolog[ií]a|biopsia|glucosa|citolog[ií]a|papanicolaou)|(examen|prueba)_?(resultado|laboratorio)|glucemia|hemoglobina_?glicosilada|hba1c|colesterol|imc|presi[oó]n_?arterial|prueba_?(de_?)?embarazo|toxicol[oó]gico|alcoholemia|lab_?results?|test_?results?', 0.8],
    ['resultado|prueba', 0.5],
  ))

// The Ley de Prevención y Control de la Infección provocada por el VIH orders confidentiality and
// forbids demanding a test to get or keep a job.
domain('SV_SALUD_VIH', 'SV_CATEGORIA_SUPRIMIDA',
  byName(['vih(_?(estado|resultado|prueba|diagn[oó]stico|positivo))?|hiv|sida|aids|serolog[ií]a_?(vih|hiv)|estado_?serol[oó]gico|carga_?viral|cd4|tar|antirretroviral(es)?|its|ets|infecci[oó]n(es)?_?(de_?)?transmisi[oó]n_?sexual|s[ií]filis|hepatitis_?[bc]|tuberculosis|tb', 0.9]))

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']
lookup('SV_GRUPO_SANGUINEO', 'sv-grupos-sanguineos.txt', BLOOD_GROUPS, 'O+', 'PRESERVE_LOOKUP_FILE')
domain('SV_SALUD_GRUPO_SANGUINEO', 'SV_GRUPO_SANGUINEO',
  byName(['grupo_?sangu[ií]neo|tipo_?(de_?)?sangre|rh|factor_?rh|gs_?rh|grupo_?rh|abo(_?rh)?|blood_?(type|group)', 0.9]),
  byList([['sv-detectar-grupos-sanguineos.txt', [...BLOOD_GROUPS, '0+', '0-', 'a positivo', 'a negativo', 'b positivo', 'b negativo', 'ab positivo', 'ab negativo', 'o positivo', 'o negativo'], 0.9]], { reject: 0.4 }))

const DISABILITIES = ['Física o motora', 'Auditiva', 'Visual', 'Sordoceguera', 'Intelectual', 'Psicosocial', 'Múltiple', 'Ninguna']
categorical('SV_DISCAPACIDAD', 'sv-discapacidades.txt', DISABILITIES, 'Trastorno del espectro autista')
domain('SV_SALUD_DISCAPACIDAD', 'SV_DISCAPACIDAD',
  byName(['discapacidad[a-z_]*|(tipo|cod|codigo|categoria)_?discapacidad|persona_?con_?discapacidad|pcd|conaipd|carn[eé]_?(de_?)?discapacidad|condici[oó]n_?(de_?)?discapacidad|necesidades_?(educativas_?)?especiales|movilidad_?reducida|disabilit(y|ies)', 0.9]),
  byList([['sv-detectar-discapacidades.txt', [...DISABILITIES, 'física', 'motora', 'auditiva', 'sordera', 'visual', 'ceguera', 'intelectual', 'cognitiva', 'psicosocial', 'mental', 'múltiple', 'autismo', 'ninguna', 'no aplica'], 0.6]], { reject: 0.3 }))

categorical('SV_APTITUD_LABORAL', 'sv-aptitud-laboral.txt', ['Apto', 'Apto con restricciones', 'No apto', 'Pendiente'], 'No apto temporalmente')
domain('SV_SALUD_OCUPACIONAL', 'SV_APTITUD_LABORAL',
  byName(['aptitud_?(laboral|m[eé]dica)|concepto_?(de_?)?aptitud|examen_?(m[eé]dico_?)?(ocupacional|preempleo|de_?ingreso|de_?retiro|peri[oó]dico)|accidente_?(de_?)?trabajo|enfermedad_?(laboral|profesional)|riesgo_?profesional|incapacidad(_?(m[eé]dica|laboral|d[ií]as))?|d[ií]as_?(de_?)?incapacidad|licencia_?(m[eé]dica|por_?enfermedad|de_?maternidad)|ausentismo|comit[eé]_?(de_?)?seguridad', 0.85]),
  byList([['sv-detectar-aptitud-laboral.txt', ['apto', 'no apto', 'apto con restricciones', 'pendiente', 'apto con recomendaciones'], 0.6]], { reject: 0.3 }))

domain('SV_SALUD_REPRODUCTIVA', 'SV_CATEGORIA_SUPRIMIDA',
  byName(['embarazo|embarazada|gestante|gestaci[oó]n|edad_?gestacional|semanas_?(de_?)?gestaci[oó]n|fum|fecha_?[uú]ltima_?(regla|menstruaci[oó]n)|control_?prenatal|prenatal|parto(_?tipo)?|ces[aá]rea|aborto|m[eé]todo_?(de_?)?planificaci[oó]n|planificaci[oó]n_?familiar|anticoncepci[oó]n|anticonceptivo|fertilidad|salud_?(sexual|reproductiva)|pregnan(t|cy)|contracepti(on|ve)', 0.9]))

domain('SV_SALUD_MENTAL', 'SV_CATEGORIA_SUPRIMIDA',
  byName(['salud_?mental|trastorno[a-z_]*|psiqui[aá]tri[a-z_]*|psicol[oó]gi[a-z_]*|depresi[oó]n|ansiedad|suicid[a-z_]*|intento_?(de_?)?suicidio|autolesi[oó]n|consumo_?(de_?)?(sustancias|alcohol|drogas)|adicci[oó]n(es)?|alcoholismo|tabaquismo|mental_?health', 0.9]))

// ── FIN · Financial and socioeconomic data ──────────────────────────────────

// Art. 3 a) leaves credit history to the Ley de Regulación de los Servicios de Información sobre el
// Historial de Crédito, which has its own duty of confidentiality — the data still needs masking.
decompose('SV_HISTORIAL_CREDITICIO', [
  [String.raw`(\d{1,4})`, DIGITS],
  [FLAG, apply('SV_BANDERA')],
], apply(lookup('SV_ESTADO_CREDITO', 'sv-estados-credito.txt', ['Al día', 'Mora de 30 días', 'Mora de 60 días', 'Mora de 90 días', 'Mora de 120 días o más', 'Reportado negativamente', 'En cobro judicial', 'Refinanciado', 'Saneado', 'Sin historial crediticio'])), 'Reportado en el buró de crédito')
domain('SV_FIN_HISTORIAL_CREDITICIO', 'SV_HISTORIAL_CREDITICIO',
  byName(['historial_?(crediticio|de_?cr[eé]dito)|bur[oó]_?(de_?)?cr[eé]dito|infored|dicom|equifax|transunion|score(_?(crediticio|interno))?|puntaje_?(de_?)?cr[eé]dito|calificaci[oó]n_?(de_?)?(riesgo|cr[eé]dito|cartera)|categor[ií]a_?(de_?)?riesgo|d[ií]as_?(de_?)?mora|altura_?(de_?)?mora|estado_?(de_?)?(cr[eé]dito|cartera|obligaci[oó]n)|morosidad|moroso|cobro_?judicial|credit_?score|credit_?rating', 0.9]))

algorithm('SV_VALOR_DEUDA', 'characterMapping.NumericMapping', { minValue: 100, maxValue: 250000 }, '5400')
domain('SV_FIN_DEUDA', 'SV_VALOR_DEUDA',
  byName(['saldo_?(deuda|cr[eé]dito|capital|obligaci[oó]n|cartera|en_?mora|adeudado)|monto_?(de_?la_?)?(deuda|cuota|obligaci[oó]n|cr[eé]dito|pr[eé]stamo|mora|desembolsado)|deuda(_?total)?|l[ií]mite_?(de_?)?(cr[eé]dito|tarjeta)|cupo_?(de_?)?cr[eé]dito|cuota_?mensual|loan_?(amount|balance)|outstanding_?balance|debt', 0.85]),
  byType(NUMBER()))

// The minimum wage of commerce and services was 408.80 dollars a month in 2026.
algorithm('SV_INGRESOS', 'characterMapping.NumericMapping', { minValue: 365, maxValue: 6000 }, '612')
domain('SV_FIN_INGRESOS', 'SV_INGRESOS',
  byName(['salario(_?(b[aá]sico|mensual|bruto|neto|nominal))?|sueldo(_?(b[aá]sico|mensual|bruto|neto))?|ingresos?(_?(mensuales?|totales?|familiares?|declarados?|netos?))?|remuneraci[oó]n|devengado|honorarios|salario_?cotizable|ingreso_?(base|familiar)|salary|income|wages?', 0.85]),
  byType(NUMBER()))

algorithm('SV_PATRIMONIO', 'characterMapping.NumericMapping', { minValue: 1000, maxValue: 500000 }, '48000')
domain('SV_FIN_PATRIMONIO', 'SV_PATRIMONIO',
  byName(['patrimonio(_?(neto|l[ií]quido))?|activos?_?(totales?)?|valor_?(del_?)?(inmueble|veh[ií]culo|bienes|aval[uú]o|cat[aá]stro|comercial)|aval[uú]o|saldo_?(cuenta|ahorro|dep[oó]sito|inversi[oó]n|cuenta_?individual)|dep[oó]sito_?a_?plazo|inversiones|net_?worth|account_?balance', 0.85]),
  byType(NUMBER()))

algorithm('SV_VALOR_PENSION', 'characterMapping.NumericMapping', { minValue: 304, maxValue: 3000 }, '425')
domain('SV_FIN_PENSION', 'SV_VALOR_PENSION',
  byName(['pensi[oó]n(_?(monto|mensual|valor))?|monto_?(pensi[oó]n|jubilaci[oó]n|beneficio|subsidio)|valor_?(pensi[oó]n|subsidio|beneficio)|haber_?(pensional|jubilatorio)|cuota_?alimenticia|pension_?amount', 0.9]),
  byType(NUMBER()))

// Remittances: a quarter of Salvadoran households receive them, and the amount says who supports
// the family from abroad.
algorithm('SV_REMESAS', 'characterMapping.NumericMapping', { minValue: 20, maxValue: 2000 }, '250')
domain('SV_FIN_REMESAS', 'SV_REMESAS',
  byName(['remesa[a-z0-9_]*|monto_?remesa|env[ií]o_?(de_?)?(dinero|remesa)|receptor_?(de_?)?remesas|recibe_?remesas|remittance[a-z_]*|money_?transfer', 0.9]),
  byType(NUMBER()))

const PROGRAMMES = ['Subsidio al gas licuado', 'Subsidio a la energía eléctrica', 'Paquete agrícola', 'Paquete escolar', 'Pensión Básica Universal', 'Bono de salud', 'Ninguno']
categorical('SV_PROGRAMA_SOCIAL', 'sv-programas-sociales.txt', PROGRAMMES, 'Comunidades Solidarias')
domain('SV_FIN_PROGRAMA_SOCIAL', 'SV_PROGRAMA_SOCIAL',
  byName(['programa_?social|beneficiario_?(programa|subsidio|bono|pensi[oó]n_?b[aá]sica)|subsidio(_?(gas|energ[ií]a|transporte|tipo))?|paquete_?(agr[ií]cola|escolar)|pensi[oó]n_?b[aá]sica_?universal|bono(_?(salud|educaci[oó]n))?|transferencia_?monetaria|ayuda_?(social|estatal)|social_?programme', 0.9]),
  byList([['sv-detectar-programas-sociales.txt', [...PROGRAMMES, 'subsidio gas', 'subsidio energía', 'paquete agrícola', 'paquete escolar', 'pensión básica universal', 'comunidades solidarias', 'ninguno'], 0.8],
    ['sv-detectar-codigos-banderas.txt', ['s', 'n', 'sí', 'no', '1', '2', '3', '4', '5', '6'], 0.3],
  ], { reject: 0.4 }))

const TENURES = ['Propia totalmente pagada', 'Propia pagándose', 'Alquilada', 'Cedida o prestada', 'Guardianía', 'Otra']
categorical('SV_TENENCIA_VIVIENDA', 'sv-tenencia-vivienda.txt', TENURES, 'Ocupación de hecho')
domain('SV_FIN_VIVIENDA', 'SV_TENENCIA_VIVIENDA',
  byName(['tenencia_?(de_?)?(la_?)?vivienda|tipo_?(de_?)?tenencia|vivienda_?(propia|alquilada|tipo_?tenencia)|condici[oó]n_?(de_?)?(la_?)?vivienda|ocupaci[oó]n_?vivienda|housing_?tenure', 0.9]),
  byList([['sv-detectar-tenencia-vivienda.txt', [...TENURES, 'propia', 'alquilada', 'alquiler', 'prestada', 'cedida', 'guardianía', 'colono'], 0.6]], { reject: 0.3 }))

// ── PENAL · Criminal records and proceedings ────────────────────────────────

categorical('SV_ANTECEDENTES', 'sv-antecedentes.txt', ['No registra antecedentes penales', 'Registra antecedentes', 'Procesado', 'Condenado', 'Absuelto', 'Sobreseído', 'Sin información'], 'Condenado por hurto en 2019')
domain('SV_PENAL_ANTECEDENTES', 'SV_ANTECEDENTES',
  byName(
    ['antecedentes?(_?(penales|policiales|judiciales))?|solvencia_?(de_?)?(antecedentes|penal|policial)|certificado_?(de_?)?antecedentes|record_?policial|condena(_?(penal|tipo))?|delito(_?(tipo|cometido))?|tipo_?(de_?)?delito|situaci[oó]n_?jur[ií]dica|detenci[oó]n_?administrativa|privad[oa]_?(de_?)?libertad|interno_?(penal|centro_?penal)|reo|orden_?(de_?)?captura|r[eé]gimen_?de_?excepci[oó]n|criminal_?record', 0.95],
    ['estado_?(del_?)?proceso|sentencia|fallo', 0.55],
  ))

// Court and prosecution files: the Fiscalía numbers a case by unit, correlative and year; the
// courts write the reference of the tribunal and the year.
decompose('SV_EXPEDIENTE_JUDICIAL', [
  [String.raw`(\d{1,6})([\s\-/])([A-Za-z]{2,10})([\s\-/])(\d{4})`, DIGITS, keep, keep, keep, keep],
  [String.raw`([A-Za-z]{1,6}[\s\-]?)(\d{1,6})([\s\-/])(\d{4})`, keep, DIGITS, keep, keep],
  [String.raw`(\d{1,6})([\s\-/])(\d{4})`, DIGITS, keep, keep],
], CM, '123-UDVM-2024')
domain('SV_PENAL_EXPEDIENTE', 'SV_EXPEDIENTE_JUDICIAL',
  byName(
    ['n(o|ro|um|umero)_?(de_?)?(expediente_?(judicial|penal|fiscal)|causa|proceso_?(judicial|penal)|denuncia|referencia_?(judicial|fiscal)|aviso)|expediente_?(judicial|penal|fiscal)|referencia_?(judicial|fiscal)|causa_?penal|n(o|ro|um|umero)_?[uú]nico_?(de_?)?expediente|nue', 0.9],
    ['expediente|causa|proceso', 0.5],
  ),
  byPattern([[String.raw`\d{1,6}-[A-Z]{2,10}-\d{4}`, 0.7], [String.raw`[A-Z]{1,6}-?\d{1,6}-\d{4}`, 0.5]], { reject: 0.3 }))

// ── Preset ──────────────────────────────────────────────────────────────────

const referenced = JSON.stringify([domains, algorithms.map((x) => x.config)])
const orphans = algorithms.filter((a) => !referenced.includes(`"${a.name}"`))
if (orphans.length) throw new Error(`algorithms nobody uses: ${orphans.map((a) => a.name).join(', ')}`)
const noInput = algorithms.filter((a) => a.input === undefined)
if (noInput.length) throw new Error(`algorithms without a sample input: ${noInput.map((a) => a.name).join(', ')}`)

// The essential pack: identity documents, names, contact, address and birth date. Loading it brings
// these domains and only what they lean on; the extended pack is everything.
const ESSENTIAL = [
  'SV_L1_DUI', 'SV_L1_NIT', 'SV_L1_DOCUMENTO_EXTRANJERO', 'SV_L1_PASAPORTE',
  'SV_L1_NOMBRE', 'SV_L1_APELLIDO', 'SV_L1_NOMBRE_COMPLETO', 'SV_L1_EMAIL', 'SV_L1_TELEFONO',
  'SV_L1_DIRECCION', 'SV_L1_DIRECCION_COMPLEMENTO', 'SV_L2_FECHA_NACIMIENTO',
]
const notDomains = ESSENTIAL.filter((name) => !domains.some((d) => d.name === name))
if (notDomains.length) throw new Error(`essential pack names domains the set does not have: ${notDomains.join(', ')}`)

const VERSION = 1
const preset = {
  version: VERSION,
  name: {
    en: 'El Salvador — Ley para la Protección de Datos Personales (Decreto 144)',
    'pt-BR': 'El Salvador — Ley para la Protección de Datos Personales (Decreto 144)',
    es: 'El Salvador — Ley para la Protección de Datos Personales (Decreto 144)',
  },
  summary: {
    en: 'Discovers and masks Salvadoran personal data under the Law for the Protection of Personal Data (Legislative Decree 144 of 2024): direct identifiers (DUI and NIT with a valid check digit, NRC, names, contact, address, accounts, wallets, plates), quasi-identifiers (birth date, distrito, postal code), the sensitive data of article 4 g) — ethnic origin, religious, spiritual or philosophical convictions, political affiliation, trade unions, sexual preferences, health, biometric and genetic data, family and moral situation, personal habits —, nationality (art. 59 b), financial data and criminal records.',
    'pt-BR': 'Descobre e mascara dados pessoais salvadorenhos segundo a Ley para la Protección de Datos Personales (Decreto Legislativo 144 de 2024): identificadores diretos (DUI e NIT com dígito verificador válido, NRC, nomes, contato, endereço, contas, carteiras digitais, placas), quase-identificadores (data de nascimento, distrito, código postal), os dados sensíveis do artigo 4 g) — origem étnica, convicções religiosas, espirituais ou filosóficas, filiação política, sindicatos, preferências sexuais, saúde, dados biométricos e genéticos, situação familiar e moral, hábitos pessoais —, nacionalidade (art. 59 b), dados financeiros e antecedentes criminais.',
    es: 'Descubre y enmascara datos personales salvadoreños conforme a la Ley para la Protección de Datos Personales (Decreto Legislativo 144 de 2024): identificadores directos (DUI y NIT con dígito verificador válido, NRC, nombres, contacto, dirección, cuentas, billeteras, placas), cuasi-identificadores (fecha de nacimiento, distrito, código postal), los datos sensibles del artículo 4 g) — origen étnico, convicciones religiosas, espirituales o filosóficas, afiliación política, sindicatos, preferencias sexuales, salud, datos biométricos y genéticos, situación moral y familiar, hábitos personales —, la nacionalidad (art. 59 b), datos financieros y antecedentes penales.',
  },
  profileSet: {
    name: `SV - Decreto 144 - v${VERSION}`,
    description: 'Identificadores directos, cuasi-identificadores, datos sensibles (art. 4 g y art. 59 b), datos de salud, datos financieros y antecedentes penales, conforme a la Ley para la Protección de Datos Personales de El Salvador (Decreto Legislativo 144 de 2024).',
    threshold: 60,
    classifiers: classifiers.map((c) => c.name),
  },
  packs: {
    essential: {
      description: 'Paquete esencial del Decreto 144: DUI, NIT, documentos de extranjeros, pasaporte, nombres, contacto, dirección y fecha de nacimiento.',
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

const small = distritoPlaces.filter((d) => d.small)
const inSmall = small.reduce((a, d) => a + d.population, 0)
console.log(`${domains.length} domains, ${classifiers.length} classifiers, ${algorithms.length} algorithms, ${files.size} files`)
console.log(`distritos: ${small.length} of ${DISTRITOS.length} under ${SMALL_PLACE} (${inSmall} people), ${places.names} names generalized, ${places.table.length} table lines, ${codePairs.length} codes`)
