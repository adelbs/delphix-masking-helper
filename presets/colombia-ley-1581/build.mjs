#!/usr/bin/env node
/**
 * Builds the Colombia (Ley Estatutaria 1581 de 2012) pre-configured profile set: preset.json and files/.
 *
 *   node presets/colombia-ley-1581/build.mjs
 *
 * source/ holds the hand-kept lists — given names, surnames, neighbourhoods — and the 1,122
 * municipalities and non-municipalized areas of DIVIPOLA with their department, location and the
 * DANE population projection for 2026. Everything in files/ and preset.json is generated from them
 * and from the definitions below — edit here, then build, then run verify.mjs.
 *
 * Structure of the set
 *   L1     direct identifiers      cédula, NIT with a valid check digit, foreigner documents, names,
 *                                  contact, address, bank details, Bre-B key, vehicles, property…
 *   L2     quasi-identifiers       birth date, age, sex, municipality, postal code, neighbourhood…
 *   L3     sensitive data          art. 5: racial or ethnic origin, political orientation, religious
 *                                  or philosophical convictions, trade unions, social and human
 *                                  rights organizations, parties, sexual life, biometric data —
 *                                  and victims of the armed conflict and people in reincorporation
 *   SALUD  health data             art. 5: health identifiers, affiliation, ICD-10, procedures…
 *   FIN    financial data          Ley 1266 de 2008 (financial habeas data): credit reports, income,
 *                                  socioeconomic stratum, Sisbén IV, social programmes
 *   PENAL  criminal records and judicial proceedings
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
  description: 'Nombre de la columna (y variantes usadas en sistemas colombianos).',
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
const NEIGHBOURHOODS = unique(readLines('barrios.txt'))

const MUNICIPALITIES = readLines('municipios.tsv').map((line) => {
  const [code, name, departmentCode, department, lat, lon, population, aliases] = line.split('\t')
  return { code, name, departmentCode, department, lat: Number(lat), lon: Number(lon), population: Number(population), aliases: aliases ? aliases.split('|') : [] }
})
if (MUNICIPALITIES.length !== 1122) throw new Error(`expected the 1,122 municipalities and non-municipalized areas of DIVIPOLA, found ${MUNICIPALITIES.length}`)
for (const m of MUNICIPALITIES) if (!/^\d{5}$/.test(m.code) || m.code.slice(0, 2) !== m.departmentCode || Number.isNaN(m.lat)) throw new Error(`${m.name}: bad code or location`)
const DEPARTMENTS = unique(MUNICIPALITIES.map((m) => m.department))

// ── Shared algorithms ───────────────────────────────────────────────────────

// Vowels map to vowels and consonants to consonants, so a masked document number keeps its
// structure; digits map to digits. Separators are in no group and stay. minMaskedPositions 0 lets
// a placeholder such as "S/I" through instead of failing the row.
algorithm('CO_CM_ALFANUM', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'AEIOU', 'BCDFGHJKLMNPQRSTVWXYZ', 'aeiou', 'bcdfghjklmnpqrstvwxyz', 'ÁÉÍÓÚÜ', 'áéíóúü'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, 'PA1234567')
// Digits only: the dots of a cédula, the letters of a folio or a court stay.
algorithm('CO_CM_DIGITOS', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '1.023.456.789')
// Digits and upper-case letters, one group each: a plate stays a plate.
algorithm('CO_CM_DIGITOS_LETRAS', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, 'KDZ')
// Hex letters form their own group, so a MAC, UUID or IPv6 stays valid hex.
algorithm('CO_CM_HEX', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'abcdef', 'ABCDEF', 'ghijklmnopqrstuvwxyz', 'GHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '3c:22:fb:9a:10:e4')
decompose('CO_REDACTAR', [['(.+)', { type: 'REDACT', redactCharacter: 'X' }]], keep, 'clave123')
lookup('CO_SUPRIMIR', 'co-sin-informacion.txt', ['Sin información'], 'Trastorno depresivo recurrente', 'PRESERVE_LOOKUP_FILE')

// Yes/no columns keep their vocabulary: a CHAR(1) S/N stays S/N.
decompose('CO_BANDERA', [
  [String.raw`(?i)(s[ií]|no)`, apply(lookup('CO_BANDERA_SI_NO', 'co-bandera-si-no.txt', ['Sí', 'No']))],
  ['(?i)(true|false)', apply(lookup('CO_BANDERA_TRUE_FALSE', 'co-bandera-true-false.txt', ['true', 'false']))],
  ['(?i)(yes)', apply(lookup('CO_BANDERA_YES_NO', 'co-bandera-yes-no.txt', ['Yes', 'No']))],
  ['(?i)([sn])', apply(lookup('CO_BANDERA_S_N', 'co-bandera-s-n.txt', ['S', 'N']))],
  ['(?i)([yx])', apply(lookup('CO_BANDERA_Y_N', 'co-bandera-y-n.txt', ['Y', 'N']))],
  ['([01])', apply(lookup('CO_BANDERA_0_1', 'co-bandera-0-1.txt', ['0', '1']))],
], keep, 'S')

const FLAG = String.raw`(?i)(s[ií]|no|true|false|yes|[snyx01])`
/**
 * A categorical attribute: flags stay flags, numeric codes are replaced by another code of `codes`
 * (or get other digits), and any other value is replaced by one from `values` — or suppressed, when
 * no list is given.
 */
function categorical(name, fileName, values, input, codes) {
  const replacement = values ? lookup(`${name}_LISTA`, fileName, values) : 'CO_SUPRIMIR'
  const code = codes ? apply(lookup(`${name}_CODIGO`, fileName.replace(/\.txt$/, '-codigos.txt'), codes)) : apply('CO_CM_ALFANUM')
  return decompose(name, [[FLAG, apply('CO_BANDERA')], [String.raw`(\d{1,6})`, code]], apply(replacement), input)
}
categorical('CO_CATEGORIA_SUPRIMIDA', null, null, 'Trastorno depresivo recurrente')
const CM = apply('CO_CM_ALFANUM')
const DIGITS = apply('CO_CM_DIGITOS')

// ── L1 · Cédula and NIT ─────────────────────────────────────────────────────
//
// The cédula de ciudadanía has no check digit: 3 to 10 digits, written with thousands dots. The same
// number follows a person through life — the NUIP of the civil birth registry is the tarjeta de
// identidad and then the cédula of those born since the 2000s — and it is the number of the driving
// licence and of the military service card. It is masked digit by digit, dots kept, one-to-one.
//
// The NIT of the DIAN is that number plus a check digit for a natural person (a company's has nine
// digits, starting with 8 or 9): weights 3 7 13 17 19 23 29 37 41 43 47 53 59 67 71 from the right,
// modulus 11, and the check digit is the remainder itself when it is 0 or 1, eleven minus it
// otherwise. Check Digit computes eleven minus the remainder and writes 10 as 0 — right except when
// the remainder is 1. So each NIT goes through two steps:
//   1. Check Digit with doubled weights masks the body and writes an auxiliary digit, which is 9
//      exactly when the remainder of the masked body is 1 (2·1 ≡ 2, and 11 − 2 = 9);
//   2. a Regex Decompose turns a final 9 into 1, and otherwise recomputes the digit with the true
//      weights over the body it leaves as it is.
// Check Digit needs as many weights as digits, so there is one pair of steps per body length.
const NIT_WEIGHTS = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71]
const NIT_LENGTHS = [6, 7, 8, 9, 10]
decompose('CO_IDENTIDAD', [['(.*)', keep]], keep, '8001972684')
function nitCheck(name, weights, body, input) {
  return algorithm(name, 'checkdigit.Checkdigit', {
    weightList: weights, modulusNumber: 11,
    checkDigitIndex: weights.length, numDigitsForCheckdigitCalculation: weights.length,
    calculateChecksumRightToLeft: true,
    numericAlgorithm: use(body), alphaNumericAlgorithm: use(body),
    preserveRegex: String.raw`[.\-\s]`,
    inputHandlingConfig: { characterHandling: 'STANDARD', invalidInputHandling: 'ERROR', shortInputHandling: 'FALLBACK', padCharacter: '0', trimWhitespace: true },
  }, input)
}
const dotted = (n) => { const head = n % 3 || 3; return `\\d{${head}}${'\\.?\\d{3}'.repeat((n - head) / 3)}` }
const NIT_SAMPLE = { 6: '123456-3', 7: '1234567-7', 8: '79456123-4', 9: '800197268-4', 10: '1023456789-5' }
const nitPatterns = []
for (const n of NIT_LENGTHS) {
  const weights = NIT_WEIGHTS.slice(0, n)
  const input = NIT_SAMPLE[n].replace(/-\d$/, '0')
  nitCheck(`CO_NIT_${n}_AUX`, weights.map((w) => 2 * w), 'CO_CM_DIGITOS', input)
  nitCheck(`CO_NIT_${n}_DV`, weights, 'CO_IDENTIDAD', input)
  decompose(`CO_NIT_${n}_AJUSTE`, [['(.*)(9)', keep, redactAs('1')]], apply(`CO_NIT_${n}_DV`), input)
  chain(`CO_NIT_${n}`, [`CO_NIT_${n}_AUX`, `CO_NIT_${n}_AJUSTE`], NIT_SAMPLE[n])
  nitPatterns.push([`(${dotted(n)}\\s?-?\\s?\\d)`, apply(`CO_NIT_${n}`)])
}
decompose('CO_NIT', nitPatterns, DIGITS, '800.197.268-4')

// A document column holds cédulas, tarjetas de identidad, NITs with their digit and passports: each
// value goes by its shape.
decompose('CO_DOCUMENTO', [
  [String.raw`(\d{1,3}(?:\.\d{3})+|\d{3,11})`, DIGITS],
  ...NIT_LENGTHS.map((n) => [`(${dotted(n)}\\s?-\\s?\\d)`, apply(`CO_NIT_${n}`)]),
], CM, '1.023.456.789')

const DOC_OWNER = 'cliente|cli|paciente|pac|usuario|afiliado|asegurado|beneficiario|benef|titular|empleado|emp|funcionario|trabajador|contratista|estudiante|alumno|deudor|codeudor|fiador|avalista|tomador|propietario|arrendatario|conductor|acudiente|responsable|representante|persona|ciudadano|votante|contribuyente|proveedor|tercero|cotizante'
domain('CO_L1_CEDULA', 'CO_DOCUMENTO',
  byName(
    [`c[eé]dula(_?(de_?)?ciudadan[ií]a)?|cc|c_c|n(o|ro|um|umero|u)_?(cc|c[eé]dula|documento|doc|identificaci[oó]n|id(ent)?)|documento_?(de_?)?identidad|doc_?identidad|identificaci[oó]n(_?(${DOC_OWNER}))?|(${DOC_OWNER})_?(cc|c[eé]dula|documento|doc|identificaci[oó]n)|tarjeta_?(de_?)?identidad|nuip|numero_?unico_?identificacion_?personal|licencia_?(de_?)?conducci[oó]n(_?(n(o|ro|um|umero)))?|pase_?(de_?)?conducci[oó]n|libreta_?militar(_?(n(o|ro|um|umero)))?|n(o|ro|um|umero)_?libreta`, 0.9],
    ['documento|doc_?id|id_?documento|nit_?cc|cc_?nit', 0.6],
  ),
  byType(STRING(3), NUMBER(3)),
  byPattern([
    [String.raw`\d{1,3}(\.\d{3}){1,3}`, 0.8],
    [String.raw`1\d{9}`, 0.5],
  ], { reject: 0.3 }))

domain('CO_L1_NIT', 'CO_NIT',
  byName(['nit[a-z0-9_]*|n(o|ro|um|umero)_?nit|nit_?(proveedor|cliente|empresa|tercero|emisor|adquiriente|receptor|contribuyente|empleador)|(proveedor|cliente|empresa|tercero|emisor|adquiriente|receptor|empleador)_?nit|rut|registro_?unico_?tributario|n(o|ro|um|umero)_?identificacion_?tributaria', 0.9]),
  byPattern([
    [String.raw`\d{3}\.?\d{3}\.?\d{3}-\d`, 0.9],
    [String.raw`\d{1,3}(\.\d{3}){1,3}-\d`, 0.8],
  ], { reject: 0.3 }))

// ── L1 · Other identity documents ───────────────────────────────────────────

// Foreigners: the cédula de extranjería, the Permiso por Protección Temporal of the Venezuelan
// migrants (PPT) and its predecessor, the Permiso Especial de Permanencia (PEP), the visa.
domain('CO_L1_DOCUMENTO_EXTRANJERO', 'CO_CM_ALFANUM',
  byName(['c[eé]dula_?(de_?)?extranjer[ií]a|ce|c_e|ppt|permiso_?(por_?)?protecci[oó]n_?temporal|pep|permiso_?especial_?(de_?)?permanencia|salvoconducto|visa(_?(n(o|ro|um|umero)))?|n(o|ro|um|umero)_?(ce|ppt|pep|visa)|documento_?migratorio|carne_?diplom[aá]tico', 0.85]))

domain('CO_L1_PASAPORTE', 'CO_CM_ALFANUM',
  byName(['pasaporte[a-z0-9_]*|n(o|ro|um|umero)_?pasaporte|passport[a-z0-9_]*', 0.9]),
  byPattern([[String.raw`[A-Z]{2}\d{6,7}`, 0.4]], { reject: 0.3 }))

// Civil registry: the serial indicator of the birth, marriage and death records.
domain('CO_L1_REGISTRO_CIVIL', 'CO_CM_ALFANUM',
  byName(['registro_?civil(_?(de_?)?(nacimiento|matrimonio|defunci[oó]n))?(_?(serial|indicativo|n(o|ro|um|umero)))?|indicativo_?serial|serial_?registro|certificado_?(de_?)?(nacido_?vivo|defunci[oó]n)|n(o|ro|um|umero)_?(registro_?civil|certificado_?defuncion)', 0.85]))

// Professional cards (tarjeta profesional) and registrations: public registers that name the person.
domain('CO_L1_TARJETA_PROFESIONAL', 'CO_CM_ALFANUM',
  byName(['tarjeta_?profesional(_?(n(o|ro|um|umero)))?|t_?p|n(o|ro|um|umero)_?tarjeta_?profesional|matr[ií]cula_?profesional|registro_?(m[eé]dico|profesional)|rethus|registro_?rethus', 0.85]))

// ── L1 · Names ──────────────────────────────────────────────────────────────

const NOT_A_PERSON = 'producto|prod|item|articulo|empresa|emp|razon|social|comercial|archivo|calle|via|barrio|municipio|mpio|ciudad|departamento|depto|dpto|pais|banco|sucursal|plan|campana|proyecto|servicio|tabla|columna|campo|usuario|host|servidor|dominio|marca|modelo|categoria|tipo|colegio|escuela|institucion|curso|materia|documento|doc|centro|unidad|clinica|hospital|ips|eps|area|dependencia|cargo|sistema|app|aplicacion|grupo|lista|reporte|informe|proceso|evento|tarea|perfil|rol|clase|objeto|cuenta|medicamento|diagnostico|estudio|programa|beneficio|partido|sindicato|religion|etnia|pueblo|lengua|lugar|sede|tienda|almacen|bodega|proveedor|convenio|contrato|poliza|seguro|aseguradora|entidad|organizacion|parametro|variable|metodo|funcion|indice|job|script|cola|recurso|red|dispositivo|plantilla|imagen|foto|pagina|sitio|modulo|menu|opcion|accion|permiso|concepto|impuesto|moneda|emisor|factura|pago|forma|zona|ruta|linea|actividad|sector|vereda|corregimiento|localidad|comuna|file|table|column|field|user|server|product|company|category|type|school|document|department|system|group|report|role|account|place|store|supplier|contract|device|image|page|module|action|key|label|code|project|city|country|street|bank'
const PERSON_ROLE = 'cliente|cli|paciente|pac|usuario|afiliado|asegurado|beneficiario|benef|titular|empleado|funcionario|trabajador|contratista|estudiante|alumno|deudor|codeudor|fiador|avalista|tomador|propietario|arrendatario|arrendador|conductor|acudiente|responsable|representante|apoderado|persona|ciudadano|contribuyente|madre|padre|conyuge|companero|contacto|referencia|victima|denunciante|sindicado|imputado|procesado|testigo|medico|docente|socio|accionista|heredero|causante|donante|tutor|curador|cotizante|customer|patient|employee|member|holder|mother|father|spouse|contact|person|student|driver|owner'
const PARTICLES = String.raw`(?i)(de|del|la|las|los|y|e|san|santa|van|von|di)`

algorithm('CO_NOMBRE', 'name.Name', {
  lookupFile: { uri: file('co-nombres.txt', GIVEN_NAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Luz')
algorithm('CO_APELLIDO', 'name.Name', {
  lookupFile: { uri: file('co-apellidos.txt', SURNAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Rodríguez')
// A word of a name. "de", "del", "la" stay where they are: "María del Pilar", "Ana López de Gómez".
decompose('CO_PALABRA_NOMBRE', [[PARTICLES, keep]], apply('CO_NOMBRE'), 'Pilar')
decompose('CO_PALABRA_APELLIDO', [[PARTICLES, keep]], apply('CO_APELLIDO'), 'Gómez')
const N = apply('CO_PALABRA_NOMBRE')
const S = apply('CO_PALABRA_APELLIDO')

decompose('CO_NOMBRES', [
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, N],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, N, N],
], CM, 'María del Pilar')
decompose('CO_APELLIDOS', [
  [String.raw`(\S+)`, S],
  [String.raw`(\S+)\s+(\S+)`, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, S, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, S, S, S, S],
], CM, 'López de Gómez')
// Colombian order: one or two given names, the father's surname, the mother's surname. Two words
// are a given name and a surname; three, a given name and two surnames; four, two and two; five,
// two given names and three words of surnames ("de" included). APELLIDOS NOMBRES with a comma, as in
// lists.
decompose('CO_NOMBRE_COMPLETO', [
  [String.raw`([^,]+),\s*(.+)`, apply('CO_APELLIDOS'), apply('CO_NOMBRES')],
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, S, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, N, S, S, S],
], CM, 'Juan Carlos Rodríguez Gómez')
const NAME_WORDS = ['de', 'del', 'la', 'las', 'los', 'y']

domain('CO_L1_NOMBRE', 'CO_NOMBRES',
  byName(
    ['primer_?nombre|segundo_?nombre|nombres?_?(de_?)?pila|pri(mer)?_?nom|seg(undo)?_?nom|nombre_?1|nombre_?2|first_?names?|given_?names?|fname|middle_?names?|nombres(?!_?(completos?|y_?apellidos?|apellidos?))', 0.85],
    [`nombre(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|apellidos?|usuario|corto|largo))|nom(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}))|name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))`, 0.5],
  ),
  byList([['co-detectar-nombres.txt', [...GIVEN_NAMES, ...NAME_WORDS], 0.7]], { tokenize: true, reject: 0.3 }))

domain('CO_L1_APELLIDO', 'CO_APELLIDOS',
  byName(['apellidos?|primer_?apellido|segundo_?apellido|pri(mer)?_?ape|seg(undo)?_?ape|apellido_?(1|2|paterno|materno|casada)|ape_?(1|2)|last_?names?|surnames?|family_?names?|lname', 0.85]),
  byList([['co-detectar-apellidos.txt', [...SURNAMES, ...NAME_WORDS], 0.7]], { tokenize: true, reject: 0.3 }))

domain('CO_L1_NOMBRE_COMPLETO', 'CO_NOMBRE_COMPLETO',
  byName(
    [`nombres?_?(completos?|y_?apellidos?|apellidos?)|nombre_?razon_?social|nombre_?(del_?|de_?la_?)?(${PERSON_ROLE})|(${PERSON_ROLE})_?(nombre|nom)|nom_?(${PERSON_ROLE})|nombre_?(madre|padre|acudiente|conyuge|contacto_?emergencia|referencia)|full_?name|person_?name`, 0.9],
    ['madre|padre|acudiente|conyuge|companero_?permanente|representante_?legal|apoderado|codeudor|fiador|beneficiario|heredero|titular|referencia_?(personal|familiar)', 0.6],
    // A bare NOMBRE holds a given name or a full name: the values decide between the two domains.
    [`nombre(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|apellidos?|usuario|corto|largo))|nom(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}))|name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))`, 0.5],
  ),
  byList([['co-detectar-nombres.txt', [...GIVEN_NAMES, ...NAME_WORDS], 0.6], ['co-detectar-apellidos.txt', [...SURNAMES, ...NAME_WORDS], 0.6]], { tokenize: true, reject: 0.3 }))

// ── L1 · Contact ────────────────────────────────────────────────────────────

decompose('CO_EMAIL', [
  // The top-level domain becomes .test, reserved for tests: a masked address can never deliver.
  [String.raw`([^@\s]+)@([^@\s]+)\.([A-Za-z]{2,24}(?:\.[A-Za-z]{2})?)`, CM, CM, redactAs('test')],
], CM, 'luz.rodriguez@gmail.com')
domain('CO_L1_EMAIL', 'CO_EMAIL',
  byName(['e_?mail[a-z0-9_]*|mail[a-z0-9_]*|correo(_?electr[oó]nico)?[a-z0-9_]*|dir_?correo|direcci[oó]n_?(de_?)?correo|direcci[oó]n_?electr[oó]nica', 0.85]),
  byType(STRING(5)),
  byPattern([[String.raw`[A-Za-z0-9._%+'\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}`, 1]], { reject: 0.2 }))

// Ten digits since the 2021 numbering plan: a mobile starts with 3 (the next two digits are the
// operator's range), a landline with 60 and the region (601 Bogotá, 604 Antioquia…). Country code 57,
// those three digits and the separators stay; the other seven digits are masked.
decompose('CO_TELEFONO', [
  [String.raw`(\+?57[\s\-]?)?(\(?3\d{2}\)?)([\s\-]?)(\d{3})([\s\-]?)(\d{4})`, keep, keep, keep, DIGITS, keep, DIGITS],
  [String.raw`(\+?57[\s\-]?)?(\(?60[1-8]\)?)([\s\-]?)(\d{3})([\s\-]?)(\d{4})`, keep, keep, keep, DIGITS, keep, DIGITS],
  // A seven-digit landline written before 2021, without its region.
  [String.raw`([2-8]\d{2})([\s\-]?)(\d{4})`, DIGITS, keep, DIGITS],
], DIGITS, '+57 310 456 7890')
domain('CO_L1_TELEFONO', 'CO_TELEFONO',
  byName(['tel|tel[eé]fono[a-z0-9_]*|tel_?(fijo|movil|m[oó]vil|celular|casa|oficina|contacto)|celular[a-z0-9_]*|cel|m[oó]vil|whats_?app|n(o|ro|um|umero)_?(tel|tel[eé]fono|celular|cel|contacto|movil)|fax|ext(ension)?_?tel|phone[a-z0-9_]*|mobile[a-z0-9_]*', 0.85]),
  byPattern([
    [String.raw`(\+?57[\s\-]?)?3[0-2]\d[\s\-]?\d{3}[\s\-]?\d{4}`, 1],
    [String.raw`(\+?57[\s\-]?)?\(?60[1-8]\)?[\s\-]?\d{3}[\s\-]?\d{4}`, 0.9],
  ], { reject: 0.3 }))

// Colombian urban addresses follow the grid: the street the building faces, its number, the crossing
// street and the distance to it — "Calle 45 # 23-10". The whole line becomes a fictitious one.
lookup('CO_DIRECCION', 'co-direcciones.txt', (() => {
  const random = seeded(1581)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const num = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
  const letter = () => (random() < 0.2 ? pick(['A', 'B', 'C', ' Bis', ' Sur']) : '')
  const out = new Set()
  while (out.size < 4000) {
    const via = pick(['Calle', 'Carrera', 'Calle', 'Carrera', 'Diagonal', 'Transversal', 'Avenida Calle', 'Avenida Carrera'])
    const base = `${via} ${num(1, 170)}${letter()} # ${num(1, 120)}${random() < 0.15 ? pick(['A', 'B']) : ''}-${num(1, 99)}`
    const r = random()
    if (r < 0.45) out.add(base)
    else if (r < 0.7) out.add(`${base} Apto ${num(1, 25)}0${num(1, 8)}`)
    else if (r < 0.85) out.add(`${base} Torre ${num(1, 8)} Apto ${num(1, 25)}0${num(1, 8)}`)
    else if (r < 0.93) out.add(`${base} Casa ${num(1, 60)}`)
    else out.add(`Kilómetro ${num(1, 40)} Vía ${pick(['principal', 'al mar', 'a la costa', 'departamental'])}`)
  }
  return [...out]
})(), 'Carrera 7 # 32-16 Oficina 1203', 'PRESERVE_LOOKUP_FILE')
const VIA = String.raw`(calle|cll?|carrera|cra|crr|kra?|cr|avenida|av|ak|ac|diagonal|dg|transversal|tv|tr|circular|cq|autopista|aut)`
domain('CO_L1_DIRECCION', 'CO_DIRECCION',
  byName(['(?<!(mac|ip|e_?mail|web|url|correo)_?)direcci[oó]n(?!_?(ip|mac|email|e_?mail|correo|electr[oó]nica|web|url|tipo|id|general|t[eé]cnica|seccional|regional))[a-z0-9_]*|(?<!(mac|ip|e_?mail|web|url)_?)dir(?!_?(ip|mac|correo|email))_?(residencia|domicilio|correspondencia|notificaci[oó]n|entrega|cobro|oficina|trabajo|cliente|paciente)?|domicilio[a-z0-9_]*|residencia|lugar_?(de_?)?residencia|(?<!(mac|ip|e_?mail|web|url)_?)address(?!_?(ip|mac|email|e_?mail|web|url|type|id))[a-z0-9_]*', 0.8]),
  byType(STRING(6)),
  byPattern([
    [`(?i)((av|avenida)\\.?\\s+)?${VIA}\\.?\\s*\\d+\\s*[a-z]?(\\s*(bis|sur|este))?\\s*(#|no\\.?|n[°º]|num\\.?)?\\s*\\d+\\s*[a-z]?\\s*-\\s*\\d+.*`, 0.9],
    [String.raw`(?i).*\b(vereda|finca|corregimiento|kil[oó]metro|km)\b.*`, 0.4],
  ], { reject: 0.2 }))

domain('CO_L1_DIRECCION_COMPLEMENTO', 'CO_CM_ALFANUM',
  byName(['complemento(_?direcci[oó]n)?|apto|apartamento|interior|int|torre|bloque|casa_?(n(o|ro|um|umero))?|manzana|mz|lote|piso|oficina|local|conjunto(_?residencial)?|edificio', 0.7]))

// ── L1 · Banking and payments ───────────────────────────────────────────────

domain('CO_L1_CUENTA_BANCARIA', 'CO_CM_DIGITOS',
  byName(['cuenta_?(bancaria|banco|ahorros?|corriente|n[oó]mina|deposito|dep[oó]sito|abono|pago|destino|origen)|n(o|ro|um|umero)_?cuenta|nro_?cta|num_?cta|cta_?(bancaria|ahorros|corriente)|tipo_?y_?n(o|ro|um|umero)_?cuenta|iban|account_?(no|num|number)|bank_?account|dep[oó]sito_?electr[oó]nico|billetera', 0.85]))

// Payment Card fails a row that has no digits to mask; only values shaped like a card reach it.
algorithm('CO_TARJETA_LUHN', 'characterMapping.PaymentCard', { minMaskedPositions: 6, preserve: 0 }, '4539578763621486')
decompose('CO_TARJETA', [[String.raw`(\d[\d\s\-]{11,22}\d)`, apply('CO_TARJETA_LUHN')]], keep, '4539 5787 6362 1486')
domain('CO_L1_TARJETA', 'CO_TARJETA',
  byName(['tarjeta(_?(cr[eé]dito|d[eé]bito|n(o|ro|um|umero)))?|n(o|ro|um|umero)_?tarjeta|pan|card_?(no|num|number)|credit_?card|tc_?(numero|num)', 0.85]),
  // 0.9, not 1: an IMEI is 15 Luhn-valid digits too, and its own column name should win.
  byPattern([[String.raw`\d{13,19}`, 0.9, { checksum: 'LUHN', clean: String.raw`[\s\-]` }]], { reject: 0.3 }))

// Bre-B, the instant payment system of the Banco de la República (2025): a key is an identity
// document number, a mobile number, an e-mail, or an alphanumeric key that starts with @.
decompose('CO_LLAVE_BREB', [
  [String.raw`([^@\s]+@[^@\s]+)`, apply('CO_EMAIL')],
  [String.raw`(@)(\S+)`, keep, CM],
  [String.raw`(3\d{9})`, apply('CO_TELEFONO')],
  [String.raw`(\d{3,11})`, DIGITS],
], CM, '@luzrodriguez83')
domain('CO_L1_LLAVE_BREB', 'CO_LLAVE_BREB',
  byName(['llave(_?(bre_?b|breb|pago|transferencia))?|bre_?b(_?llave)?|breb|llave_?alfanum[eé]rica', 0.9]),
  byPattern([[String.raw`@[A-Za-z0-9]{3,20}`, 0.6]], { reject: 0.2 }))

// ── L1 · Network, devices, vehicles, property ───────────────────────────────

algorithm('CO_OCTETO', 'characterMapping.NumericMapping', { minValue: 1, maxValue: 254 }, '10')
decompose('CO_IP', [
  [String.raw`(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})`, apply('CO_OCTETO'), apply('CO_OCTETO'), apply('CO_OCTETO'), apply('CO_OCTETO')],
], apply('CO_CM_HEX'), '190.85.46.120')
domain('CO_L1_IP', 'CO_IP',
  byName(['ip|ip_?(address|addr|origen|destino|cliente|usuario|acceso|login|remota|publica)|direcci[oó]n_?ip|dir_?ip|ipv[46]|remote_?addr(ess)?|client_?ip|host_?ip', 0.85]),
  byPattern([
    [String.raw`((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)`, 1],
    [String.raw`[0-9A-Fa-f]{1,4}(:[0-9A-Fa-f]{0,4}){2,7}`, 0.9],
  ], { reject: 0.3 }))

domain('CO_L1_DISPOSITIVO', 'CO_CM_HEX',
  byName(['imei|imsi|iccid|mac|mac_?address|direcci[oó]n_?mac|device_?(id|uuid|serial)|id_?(dispositivo|equipo|celular)|serial_?(equipo|celular|dispositivo)|advertising_?id|idfa|gaid|cookie(_?id)?|session_?id|id_?sesi[oó]n', 0.8]),
  byPattern([
    [String.raw`([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}`, 1],
    [String.raw`\d{15}`, 0.8, { checksum: 'LUHN' }],
  ], { reject: 0.3 }))

// Plates: three letters and three digits for cars (KDZ123), three letters, two digits and a letter
// for motorcycles (ABC12D). Letters stay letters and digits digits, position by position.
decompose('CO_PLACA', [
  [String.raw`([A-Za-z]{3})([\s\-]?)(\d{3})`, apply('CO_CM_DIGITOS_LETRAS'), keep, DIGITS],
  [String.raw`([A-Za-z]{3})([\s\-]?)(\d{2})([A-Za-z]?)`, apply('CO_CM_DIGITOS_LETRAS'), keep, DIGITS, apply('CO_CM_DIGITOS_LETRAS')],
], CM, 'KDZ-123')
domain('CO_L1_PLACA', 'CO_PLACA',
  byName(['placa(_?(veh[ií]culo|carro|moto|automotor))?|n(o|ro|um|umero)_?placa|license_?plate|plate(_?(no|number))?', 0.85]),
  byPattern([
    [String.raw`[A-Z]{3}[\s\-]?\d{3}`, 0.8],
    [String.raw`[A-Z]{3}[\s\-]?\d{2}[A-Z]`, 0.8],
  ], { reject: 0.3 }))

domain('CO_L1_VEHICULO', 'CO_CM_ALFANUM',
  byName(['vin|chasis|n(o|ro|um|umero)_?(chasis|motor|serie|vin)|serie_?veh[ií]culo|motor_?n(o|ro|um|umero)|licencia_?(de_?)?tr[aá]nsito(_?(n(o|ro|um|umero)))?|tarjeta_?(de_?)?propiedad|runt', 0.85]),
  byPattern([[String.raw`[A-HJ-NPR-Z0-9]{17}`, 0.7]], { reject: 0.3 }))

// Real estate: the folio de matrícula inmobiliaria names the registry office (50C, 001, 370…) and a
// number; the national cadastral number (30 digits) starts with the DIVIPOLA code. Office and
// municipality stay, the rest is mapped.
decompose('CO_INMUEBLE', [
  [String.raw`(\d{2,3}[A-Za-z]?)([\s\-]+)(\d{3,9})`, keep, keep, DIGITS],
  [String.raw`(\d{5})(\d{25})`, keep, DIGITS],
], DIGITS, '50C-1234567')
domain('CO_L1_INMUEBLE', 'CO_INMUEBLE',
  byName(['folio_?(de_?)?matr[ií]cula(_?inmobiliaria)?|matr[ií]cula_?inmobiliaria|fmi|c[eé]dula_?catastral|n(o|ro|um|umero)_?predial(_?nacional)?|c[oó]digo_?catastral|chip(_?predio)?|referencia_?catastral|predio_?(n(o|ro|um|umero)|codigo|id)', 0.85]),
  byPattern([[String.raw`\d{2,3}[A-Z]?-\d{3,9}`, 0.6], [String.raw`\d{30}`, 0.7]], { reject: 0.3 }))

domain('CO_L1_CONTRATO', 'CO_CM_ALFANUM',
  byName(['n(o|ro|um|umero)_?(contrato|p[oó]liza|obligaci[oó]n|cr[eé]dito|pr[eé]stamo|radicado_?(pqr|solicitud)|solicitud|afiliaci[oó]n|matr[ií]cula|carn[eé]|suscriptor|contador|medidor|cliente|cuenta_?contrato|factura_?servicio)|contrato_?(n(o|ro|um|umero))|matr[ií]cula(?!_?(inmobiliaria|profesional|mercantil))(_?(estudiante|alumno))?|c[oó]digo_?(estudiante|empleado|cliente|afiliado|suscriptor)|id_?(cliente|empleado|afiliado|estudiante)|n(o|ro|um|umero)_?suscriptor|nic|niu|cuenta_?contrato|carne', 0.7]))

domain('CO_L1_USUARIO', 'CO_CM_ALFANUM',
  byName(['usuario|user_?name|username|login|alias|apodo|nick(_?name)?|perfil_?(instagram|facebook|twitter|tiktok|linkedin|x)|instagram|facebook|twitter|tiktok|linkedin|red_?social|handle', 0.7]))

domain('CO_L1_CREDENCIAL', 'CO_REDACTAR',
  byName(['contrase[nñ]a|clave(?!_?(producto|catastral|primaria|for[aá]nea|valor|dian))|password|passwd|pwd|pass|hash_?(clave|contrasena|password)|pin|c[oó]digo_?(seguridad|verificaci[oó]n|acceso|otp)|cvv|cvc|token(_?(acceso|refresh|api))?|access_?token|refresh_?token|api_?key|llave_?api|secreto|secret|otp|pregunta_?secreta|respuesta_?secreta', 0.9]))

decompose('CO_COORDENADA', [
  // The integer part and first decimal stay (about 11 km): the place is generalized, not moved.
  [String.raw`(-?\d{1,3}[.,]\d)(\d+)\s*([,;])\s*(-?\d{1,3}[.,]\d)(\d+)`, keep, DIGITS, keep, keep, DIGITS],
  [String.raw`(-?\d{1,3}[.,]\d)(\d+)`, keep, DIGITS],
], keep, '4.609710')
domain('CO_L1_GEOLOCALIZACION', 'CO_COORDENADA',
  byName(
    ['lat|latitud|lon|lng|longitud|coordenadas?|coord_?[xy]|geo_?(lat|lon|lng|loc|localizacion|posicion)|georreferenciaci[oó]n|geolocalizaci[oó]n|gps(_?(ubicaci[oó]n|posici[oó]n|coordenadas))?|ubicaci[oó]n_?gps', 0.85],
    ['long', 0.5],
  ),
  byPattern([
    [String.raw`-?([0-9]|1[0-3])\.\d{3,}\s*,\s*-(6[6-9]|7\d|8[01])\.\d{3,}`, 0.9],
    [String.raw`-(6[6-9]|7\d|8[01])\.\d{4,}`, 0.6],
    [String.raw`-?([0-9]|1[0-3])\.\d{4,}`, 0.3],
  ], { reject: 0.3 }))

// ── L1 · Free text ──────────────────────────────────────────────────────────

algorithm('CO_TEXTO_LIBRE', 'freeTextRedaction.FreeTextRedaction', {
  regularExpressions: [
    String.raw`(?<![\d.])\d{1,3}(\.\d{3}){1,3}(-\d)?(?![\d.])`,
    String.raw`(?<!\d)\d{6,10}-\d(?!\d)`,
    String.raw`(?<!\d)\d{6,11}(?!\d)`,
    String.raw`[\w.+\-]+@[\w\-]+(\.[\w\-]+)+`,
    String.raw`(?<![\d\-])(\+?57)?3\d{2}[\-]?\d{3}[\-]?\d{4}(?![\d\-])`,
    String.raw`(?<!\d)\d{13,19}(?!\d)`,
    String.raw`(?<![A-Za-z])[A-Z]{3}-?\d{2}[A-Z\d](?![A-Za-z\d])`,
    String.raw`(?<!\d)(\d{1,3}\.){3}\d{1,3}(?!\d)`,
  ].map((patternString) => ({ patternString })),
  regExRedactValue: '[DATO]',
  lookupFile: { uri: file('co-texto-nombres.txt', unique([...GIVEN_NAMES, ...SURNAMES].flatMap((v) => [v, v.toUpperCase(), fold(v), fold(v).toUpperCase()]))) },
  lookupFileRedactValue: '[NOMBRE]',
  isDenyList: true,
}, 'Cliente Rodríguez, CC 79.456.123, correo l.rodriguez@gmail.com, cel 3104567890')

domain('CO_L1_TEXTO_LIBRE', 'CO_TEXTO_LIBRE',
  byName(['observaci[oó]n(es)?|obs|comentarios?|notas?|anotaci[oó]n(es)?|descripci[oó]n_?(pqr|pqrs|pqrsd|queja|reclamo|solicitud|caso|hechos|novedad|atenci[oó]n)|detalle_?(pqr|solicitud|caso|atenci[oó]n)|hechos|relato|justificaci[oó]n|(?<!(id|cd|cod|codigo|tipo|fecha|estado|num|nro)_?)mensaje(?!_?(id|tipo|codigo|fecha|estado|cola|log))|texto(_?libre)?|resumen_?(caso|atenci[oó]n)|queja|reclamo|pqrs?d?|remarks?|comments?|notes?|free_?text|memo', 0.6]),
  byType(STRING(30)),
  byPattern([
    [String.raw`\d{1,3}(\.\d{3}){2,3}`, 0.6],
    [String.raw`[\w.+\-]+@[\w\-]+\.[A-Za-z]{2,}`, 0.7],
    [String.raw`3\d{2}\s?\d{3}\s?\d{4}`, 0.6],
  ], { reject: 0, partial: true }))

// ── L2 · Quasi-identifiers ──────────────────────────────────────────────────

// Small shifts: large enough to break the link to the person, small enough that ages, school years
// and the 14th and 18th birthdays move for few people.
algorithm('CO_FECHA_NACIMIENTO', 'dateAlgorithms.DateShift', { minRange: -60, maxRange: 60, unit: 'DAYS', roll: false }, '1985-07-20')
algorithm('CO_FECHA_EVENTO', 'dateAlgorithms.DateShift', { minRange: -30, maxRange: 30, unit: 'DAYS', roll: false }, '2021-03-15')

domain('CO_L2_FECHA_NACIMIENTO', 'CO_FECHA_NACIMIENTO',
  byName(['(fecha|fec|fch|f)_?(de_?)?nac(imiento)?|fnac|fechanac(imiento)?|cumplea[nñ]os|dob|date_?of_?birth|birth_?date|birthday', 0.9]),
  byType(...DATES, STRING(6)))

// The decade stays and the unit is masked.
decompose('CO_ANIO', [[String.raw`(\d{3})(\d)`, keep, DIGITS]], keep, '1985')
domain('CO_L2_ANIO_NACIMIENTO', 'CO_ANIO',
  byName(['a[nñ]o_?(de_?)?nac(imiento)?|anio_?nac(imiento)?|year_?of_?birth|birth_?year|yob', 0.9]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// 37 becomes 3x. From 100 on, 90.
decompose('CO_EDAD', [
  [String.raw`(\d{3,})`, redactAs('90')],
  [String.raw`([1-9])(\d)([.,]\d+)`, keep, DIGITS, keep],
  [String.raw`([1-9])(\d)`, keep, DIGITS],
  [String.raw`(\d)`, DIGITS],
], keep, '37')
domain('CO_L2_EDAD', 'CO_EDAD',
  byName(['edad(_?(actual|a[nñ]os|anios|paciente|afiliado|cliente|al_?(ingreso|diagn[oó]stico|fallecimiento)))?|grupo_?etario|rango_?(de_?)?edad|quinquenio|age(_?(years|group))?', 0.85]),
  byType(NUMBER(0, 6), STRING(0, 6)))

domain('CO_L2_FECHA_EVENTO', 'CO_FECHA_EVENTO',
  byName(['(fecha|fec|fch|f)_?(de_?)?(defunci[oó]n|fallecimiento|muerte|matrimonio|divorcio|ingreso|retiro|vinculaci[oó]n|desvinculaci[oó]n|contrataci[oó]n|terminaci[oó]n_?contrato|pensi[oó]n|hospitalizaci[oó]n|egreso|diagn[oó]stico|atenci[oó]n|consulta|parto|captura|condena|expedici[oó]n(_?(documento|c[eé]dula|cc))?|desplazamiento|declaraci[oó]n|hecho_?victimizante|vacunaci[oó]n|cirug[ií]a|accidente|incapacidad)|fec_?(exp|expedicion|defuncion|ingreso|retiro)|date_?of_?(death|marriage|hire|admission|discharge)', 0.8]),
  byType(...DATES, STRING(6)))

// Each vocabulary replaced within itself: M/F stays M/F.
decompose('CO_SEXO', [
  ['(?i)(femenino|masculino)', apply(lookup('CO_SEXO_FEMENINO_MASCULINO', 'co-sexo-femenino-masculino.txt', ['Femenino', 'Masculino']))],
  ['(?i)(mujer|hombre)', apply(lookup('CO_SEXO_MUJER_HOMBRE', 'co-sexo-mujer-hombre.txt', ['Mujer', 'Hombre']))],
  ['(?i)(female|male)', apply(lookup('CO_SEXO_FEMALE_MALE', 'co-sexo-female-male.txt', ['Female', 'Male']))],
  ['(?i)([fm])', apply(lookup('CO_SEXO_F_M', 'co-sexo-f-m.txt', ['F', 'M']))],
  ['(?i)([hm])', apply(lookup('CO_SEXO_H_M', 'co-sexo-h-m.txt', ['H', 'M']))],
  // DANE and RIPS codes: 1 man, 2 woman.
  ['([12])', apply(lookup('CO_SEXO_1_2', 'co-sexo-1-2.txt', ['1', '2']))],
], keep, 'F')
domain('CO_L2_SEXO', 'CO_SEXO',
  byName(['sexo(_?(biol[oó]gico|al_?nacer|paciente|afiliado|cliente))?|(tp|tipo|cod|cd|id)_?sexo|g[eé]nero(?!_?(identidad|autopercibido))|sex|gender(?!_?identity)', 0.85]),
  byList([['co-detectar-sexo.txt', ['f', 'm', 'h', 'femenino', 'masculino', 'mujer', 'hombre', 'female', 'male'], 0.5]], { reject: 0.5 }))

// ── L2 · Where people live ──────────────────────────────────────────────────
//
// DIVIPOLA has 1,102 municipalities, Bogotá and 20 non-municipalized areas of the Amazon and
// Orinoquía. 694 of the 1,122 had fewer than 20,000 inhabitants in the DANE projection for 2026 (the
// smallest inhabited one, La Guadalupe, 347): with a birth date and a sex, one of them points at a handful of people.
// A small one becomes the nearest municipality of the same department with at least 20,000 — a real
// place, nearby, shared by many. The department stays.

const distance = (a, b) => {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}
const SMALL_MUNICIPALITY = 20000
const large = MUNICIPALITIES.filter((m) => m.population >= SMALL_MUNICIPALITY)
const municipalityTo = new Map(MUNICIPALITIES.map((m) => {
  if (m.population >= SMALL_MUNICIPALITY) return [m.code, m]
  const sameDepartment = large.filter((x) => x.departmentCode === m.departmentCode)
  const candidates = sameDepartment.length ? sameDepartment : large
  return [m.code, candidates.reduce((best, x) => (distance(m, x) < distance(m, best) ? x : best))]
}))
const small = MUNICIPALITIES.filter((m) => m.population < SMALL_MUNICIPALITY)
const spellingsOf = (m) => unique([m.name, ...m.aliases])

// Names that differ only in accents are the same name.
const nameKey = (name) => fold(name).toLowerCase()
const byMunicipalityName = new Map()
for (const m of MUNICIPALITIES) {
  for (const name of spellingsOf(m)) {
    const entry = byMunicipalityName.get(nameKey(name)) ?? { spellings: new Set(), all: new Set() }
    entry.spellings.add(name)
    entry.all.add(m)
    byMunicipalityName.set(nameKey(name), entry)
  }
}
const municipalityPairs = []
for (const { spellings, all } of byMunicipalityName.values()) {
  if ([...all].some((m) => m.population >= SMALL_MUNICIPALITY)) continue
  const to = municipalityTo.get([...all].reduce((a, b) => (b.population > a.population ? b : a)).code).name
  for (const name of spellings) municipalityPairs.push([name, to])
}
// With the department, as systems write it to tell homonyms apart: "La Unión - Sucre", "La Unión (Sucre)".
const SEPARATORS = [[' - ', ''], [', ', ''], [' (', ')'], ['/', ''], ['-', '']]
const withDepartment = (m) => spellingsOf(m).flatMap((name) => SEPARATORS.map(([a, b]) => `${name}${a}${m.department}${b}`))
const withDepartmentPairs = small.flatMap((m) => {
  const to = municipalityTo.get(m.code)
  return spellingsOf(m).flatMap((name) => SEPARATORS.map(([a, b]) => [`${name}${a}${m.department}${b}`, `${to.name}${a}${to.department}${b}`]))
})
// How systems write a name: as it is, in capitals, and without accents. A name that has no accents
// maps to the accented one; only a name whose accents were dropped maps to a name without them.
const spellings = (from, to) => {
  const out = new Map([[from, to], [from.toUpperCase(), to.toUpperCase()]])
  if (!out.has(fold(from))) out.set(fold(from), fold(to))
  if (!out.has(fold(from).toUpperCase())) out.set(fold(from).toUpperCase(), fold(to).toUpperCase())
  return [...out]
}
const variants = (pairs) => pairs.flatMap(([from, to]) => spellings(from, to))
const kept = new Set(variants(large.flatMap((m) => [...spellingsOf(m), ...withDepartment(m)].map((n) => [n, n]))).map(([from]) => from))
const generalized = new Map()
const ambiguous = new Set()
for (const [from, to] of variants([...municipalityPairs, ...withDepartmentPairs])) {
  if (kept.has(from) || ambiguous.has(from)) continue
  // The same place reached through an alias differs only in accents: first wins.
  if (generalized.has(from) && fold(generalized.get(from)).toUpperCase() === fold(to).toUpperCase()) continue
  if (generalized.has(from) && generalized.get(from) !== to) { generalized.delete(from); ambiguous.add(from); continue }
  generalized.set(from, to)
}
cleansing('CO_MUNICIPIO', 'co-municipios-generalizados.txt', [...generalized], 'Jardín', '|')
// DIVIPOLA codes, five digits: two for the department, three for the municipality.
cleansing('CO_CODIGO_MUNICIPIO', 'co-codigos-municipio-generalizados.txt', small.map((m) => [m.code, municipalityTo.get(m.code).code]), '05364')

const PERSONAL_WORDS = new Set([...GIVEN_NAMES, ...SURNAMES].map((w) => fold(w).toLowerCase()))
const DEPARTMENT_NAMES = new Set([...DEPARTMENTS, 'Bogotá', 'San Andrés y Providencia', 'Quindío', 'Colombia'].map((n) => fold(n).toLowerCase()))
const MUNICIPALITY_NAMES = unique(MUNICIPALITIES.flatMap(spellingsOf))
  .filter((n) => !PERSONAL_WORDS.has(fold(n).toLowerCase()) && !DEPARTMENT_NAMES.has(fold(n).toLowerCase()))

domain('CO_L2_MUNICIPIO', 'CO_MUNICIPIO',
  byName(['municipio(?!_?(dane|cod|codigo|id))(_?(residencia|nacimiento|expedici[oó]n|domicilio|paciente|cliente|ocurrencia|atenci[oó]n|notificaci[oó]n))?|mpio(_?(res|nac|residencia|nacimiento))?|ciudad(_?(residencia|nacimiento|expedici[oó]n|domicilio|cliente|origen))?|(nom|nombre|desc)_?(municipio|mpio|ciudad)|lugar_?(de_?)?(nacimiento|expedici[oó]n)|municipio_?expedici[oó]n|city|town|localidad_?residencia', 0.85]),
  byList([['co-detectar-municipios.txt', MUNICIPALITY_NAMES, 0.8]], { reject: 0.4 }))

domain('CO_L2_CODIGO_MUNICIPIO', 'CO_CODIGO_MUNICIPIO',
  byName(['(cod|codigo|cd|id)_?(municipio|mpio|ciudad|mun)(_?(dane|res|residencia|nac|nacimiento|ocurrencia|divipola))?|(cod|codigo)_?dane(_?(municipio|mpio))?|divipola|cod_?mpio|codmpio|dane_?mpio', 0.85]),
  byPattern([[String.raw`(05|08|11|13|15|17|18|19|20|23|25|27|41|44|47|50|52|54|63|66|68|70|73|76|81|85|86|88|91|94|95|97|99)\d{3}`, 0.4]], { reject: 0.3 }))

// Postal code (4-72): six digits, two for the department, two for the postal zone and two for the
// district. The department stays; the rest becomes zeros.
decompose('CO_CODIGO_POSTAL', [[String.raw`(\d{2})(\d{4})`, keep, redactAs('0000')]], keep, '110231')
domain('CO_L2_CODIGO_POSTAL', 'CO_CODIGO_POSTAL',
  byName(['c[oó]digo_?postal|cod_?postal|codpostal|zip(_?code)?|postal_?code|cp', 0.85]),
  byType(STRING(6, 6), NUMBER(0, 6)))

lookup('CO_BARRIO', 'co-barrios.txt', NEIGHBOURHOODS, 'Chapinero Alto', 'PRESERVE_LOOKUP_FILE')
domain('CO_L2_BARRIO', 'CO_BARRIO',
  byName(['barrio(_?(residencia|domicilio|cliente))?|(nom|nombre)_?barrio|urbanizaci[oó]n|conjunto_?residencial|localidad(?!_?(c[oó]digo|cod))|comuna|upz|neighbou?rhood', 0.8]))

// Rural addresses name the vereda or the corregimiento: a few dozen families. Replaced by a generic
// rural area.
lookup('CO_ZONA_RURAL', 'co-zona-rural.txt', ['Zona rural'], 'Vereda La Esperanza', 'PRESERVE_LOOKUP_FILE')
domain('CO_L2_VEREDA', 'CO_ZONA_RURAL',
  byName(['vereda(_?(residencia|nombre))?|corregimiento|centro_?poblado|inspecci[oó]n_?(de_?)?polic[ií]a|resguardo(_?ind[ií]gena)?|caser[ií]o|finca|parcela', 0.85]))

// Nationalities: Colombian and the largest foreign communities — Venezuelans first by far.
const NATIONALITIES = ['Colombiana', 'Venezolana', 'Ecuatoriana', 'Peruana', 'Estadounidense', 'Española', 'Mexicana', 'Argentina', 'Chilena', 'Brasileña', 'Cubana', 'Panameña', 'Italiana', 'Francesa', 'China', 'Alemana']
lookup('CO_NACIONALIDAD', 'co-nacionalidades.txt', NATIONALITIES, 'Haitiana')
domain('CO_L2_NACIONALIDAD', 'CO_NACIONALIDAD',
  byName(['nacionalidad|pa[ií]s_?(de_?)?(nacimiento|origen|nacionalidad)|ciudadan[ií]a|nationality|citizenship|country_?of_?birth', 0.8]),
  byList([['co-detectar-nacionalidades.txt', [...NATIONALITIES, 'colombiano', 'venezolano', 'ecuatoriano', 'peruano', 'estadounidense', 'español', 'mexicano', 'argentino', 'chileno', 'brasileño', 'cubano', 'panameño', 'italiano', 'francés', 'chino', 'alemán', 'colombia', 'venezuela', 'ecuador', 'perú', 'estados unidos', 'españa', 'méxico', 'extranjero', 'extranjera'], 0.7]], { reject: 0.4 }))

const MARITAL = ['Soltero(a)', 'Casado(a)', 'Unión marital de hecho', 'Separado(a)', 'Divorciado(a)', 'Viudo(a)']
categorical('CO_ESTADO_CIVIL', 'co-estado-civil.txt', MARITAL, 'Unión libre', ['1', '2', '3', '4', '5', '6'])
domain('CO_L2_ESTADO_CIVIL', 'CO_ESTADO_CIVIL',
  byName(['estado_?civil|est_?civil|(cod|tipo|id)_?estado_?civil|situaci[oó]n_?conyugal|marital_?status|civil_?status', 0.85]),
  byList([['co-detectar-estado-civil.txt', [...MARITAL, 'soltero', 'soltera', 'casado', 'casada', 'unión libre', 'union libre', 'unión marital', 'separado', 'separada', 'divorciado', 'divorciada', 'viudo', 'viuda'], 0.7]], { reject: 0.4 }))

lookup('CO_OCUPACION', 'co-ocupaciones.txt', ['Auxiliar administrativo', 'Asistente administrativo', 'Vendedor', 'Cajero', 'Conductor', 'Mensajero', 'Obrero de construcción', 'Maestro de obra', 'Docente', 'Enfermero', 'Auxiliar de enfermería', 'Médico general', 'Contador', 'Abogado', 'Ingeniero civil', 'Ingeniero de sistemas', 'Desarrollador de software', 'Recepcionista', 'Aseador', 'Vigilante', 'Cocinero', 'Mesero', 'Electricista', 'Plomero', 'Mecánico', 'Agricultor', 'Jornalero', 'Recolector de café', 'Pescador', 'Operario de producción', 'Asesor comercial', 'Agente de call center', 'Bodeguero', 'Estilista', 'Modista', 'Estudiante', 'Pensionado', 'Independiente', 'Hogar'], 'Gerente de operaciones regionales')
decompose('CO_OCUPACION_O_CIUO', [
  // CIUO-08 A.C.: the Colombian adaptation of the international occupation code, four digits.
  [String.raw`(\d{4,5})`, DIGITS],
], apply('CO_OCUPACION'), 'Gerente de operaciones regionales')
domain('CO_L2_OCUPACION', 'CO_OCUPACION_O_CIUO',
  byName(
    ['ocupaci[oó]n|profesi[oó]n|oficio|ciuo|(cod|codigo)_?(ocupacion|ciuo|profesion)|actividad_?econ[oó]mica_?(persona|afiliado)|cargo_?(actual|empleado|trabajador)|occupation|profession|job_?title', 0.8],
    ['cargo', 0.5],
  ))

lookup('CO_EMPLEADOR', 'co-empleadores.txt', ['Comercializadora El Progreso S.A.S.', 'Construcciones Andinas S.A.S.', 'Transportes La Sabana S.A.S.', 'Supermercados La Económica S.A.S.', 'Metalmecánica del Valle S.A.', 'Clínica Santa Lucía S.A.S.', 'Colegio Nuevo Horizonte S.A.S.', 'Servicios Integrales del Caribe S.A.S.', 'Agropecuaria Los Llanos S.A.S.', 'Distribuidora La Montaña S.A.S.', 'Soluciones Digitales Andinas S.A.S.', 'Restaurante Sabor Criollo S.A.S.', 'Hotel Mirador del Café S.A.S.', 'Laboratorio Vida Sana S.A.S.', 'Seguridad Atalaya Ltda.', 'Confecciones La Aguja S.A.S.', 'Autopartes del Oriente S.A.S.', 'Droguería El Buen Vecino', 'Logística Puerto Nuevo S.A.S.', 'Alcaldía Municipal de Villanueva', 'Fundación Manos Unidas', 'Cooperativa Agraria La Unión', 'Panadería Pan de Casa', 'Contadores Asociados S.A.S.'], 'Ecopetrol S.A.')
domain('CO_L2_EMPLEADOR', 'CO_EMPLEADOR',
  byName(['empleador(_?(nombre|raz[oó]n_?social))?|(nombre|nom)_?(empleador|empresa_?donde_?trabaja|empresa_?labora)|empresa_?(donde_?)?(trabaja|labora)|lugar_?(de_?)?trabajo|empresa_?empleadora|patrono|employer(_?name)?|workplace', 0.8]))

const EDUCATION = ['Ninguno', 'Preescolar', 'Básica primaria', 'Básica secundaria', 'Media (bachiller)', 'Técnica profesional', 'Tecnológica', 'Universitaria', 'Especialización', 'Maestría', 'Doctorado']
categorical('CO_ESCOLARIDAD', 'co-escolaridad.txt', EDUCATION, 'Posdoctorado', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'])
domain('CO_L2_ESCOLARIDAD', 'CO_ESCOLARIDAD',
  byName(['escolaridad|nivel_?(educativo|de_?estudios|acad[eé]mico|escolaridad|formaci[oó]n)|grado_?(de_?)?(instrucci[oó]n|escolaridad)|m[aá]ximo_?nivel|formaci[oó]n_?acad[eé]mica|education(_?level)?', 0.8]),
  byList([['co-detectar-escolaridad.txt', [...EDUCATION, 'primaria', 'secundaria', 'bachiller', 'bachillerato', 'técnico', 'tecnólogo', 'profesional', 'universitario', 'pregrado', 'posgrado', 'especialista', 'magíster', 'ninguno'], 0.6]], { reject: 0.4 }))

lookup('CO_INSTITUCION_EDUCATIVA', 'co-instituciones-educativas.txt', ['Institución Educativa San José', 'Colegio Nuestra Señora del Rosario', 'Institución Educativa Técnica Agropecuaria', 'Colegio Departamental La Esperanza', 'Institución Educativa Simón Bolívar', 'Colegio Distrital Nueva Granada', 'Instituto Técnico Industrial', 'Corporación Universitaria del Valle', 'Universidad Regional del Oriente', 'Fundación Universitaria Los Andes del Sur', 'Servicio de formación técnica regional', 'Colegio Santa María'], 'Colegio Mayor de San Bartolomé')
domain('CO_L2_INSTITUCION_EDUCATIVA', 'CO_INSTITUCION_EDUCATIVA',
  byName(['colegio(_?(nombre|egreso))?|(nombre|nom)_?(colegio|instituci[oó]n_?educativa|universidad|establecimiento_?educativo)|instituci[oó]n_?educativa|establecimiento_?educativo|universidad|(cod|codigo)_?dane_?(colegio|establecimiento|sede)|school(_?name)?|university', 0.75]))

// Capped at 5 as text: large families are rare, and a rare count identifies.
decompose('CO_CONTEO_LIMITADO', [[String.raw`([0-5])`, keep], [String.raw`(\d+)`, redactAs('5')]], keep, '9')
domain('CO_L2_PERSONAS_A_CARGO', 'CO_CONTEO_LIMITADO',
  byName(['personas_?a_?cargo|n(o|ro|um|umero)_?(de_?)?(hijos|dependientes|personas_?a_?cargo)|cant(idad)?_?(hijos|dependientes|personas_?hogar)|hijos|dependientes|personas_?(en_?el_?)?hogar|tama[nñ]o_?hogar|number_?of_?children|dependents', 0.8]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// ── L3 · Sensitive data (art. 5) ────────────────────────────────────────────

// Ethnic self-recognition as the 2018 census asks it, with its codes.
const ETHNIC_GROUPS = ['Indígena', 'Gitano(a) o Rrom', 'Raizal del Archipiélago de San Andrés, Providencia y Santa Catalina', 'Palenquero(a) de San Basilio', 'Negro(a), mulato(a), afrodescendiente, afrocolombiano(a)', 'Ningún grupo étnico']
categorical('CO_GRUPO_ETNICO', 'co-grupos-etnicos.txt', ETHNIC_GROUPS, 'Afrocolombiana', ['1', '2', '3', '4', '5', '6'])
domain('CO_L3_GRUPO_ETNICO', 'CO_GRUPO_ETNICO',
  byName(['etnia|grupo_?[eé]tnico|pertenencia_?[eé]tnica|autorreconocimiento(_?[eé]tnico)?|auto_?reconocimiento|(cod|codigo|tipo|id)_?(etnia|pertenencia_?etnica)|raza|origen_?[eé]tnico|afrocolombiano|afrodescendiente|raizal|palenquero|rrom|gitano|ethnicity|race', 0.95]),
  byList([['co-detectar-grupos-etnicos.txt', [...ETHNIC_GROUPS, 'indígena', 'gitano', 'rrom', 'raizal', 'palenquero', 'negro', 'mulato', 'afrodescendiente', 'afrocolombiano', 'afrocolombiana', 'ninguno', 'ninguna', 'mestizo', 'blanco'], 0.9],
    // Belonging is often a yes/no flag or a census code: it backs up the column name but decides nothing alone.
    ['co-detectar-codigos-banderas.txt', ['s', 'n', 'sí', 'no', '1', '2', '3', '4', '5', '6'], 0.3],
  ], { reject: 0.4 }))

// The 115 indigenous peoples of the 2018 census; the replacement list has the most numerous.
const PEOPLES_TOP = ['Wayuu', 'Zenú', 'Nasa', 'Pastos', 'Emberá Chamí', 'Emberá Katío', 'Pijao', 'Misak', 'Sikuani', 'Inga', 'Arhuaco', 'Kankuamo', 'Yanacona', 'Kogui', 'Tikuna', 'Awá', 'Mokaná', 'U\'wa', 'Kamëntsá', 'Muisca']
const PEOPLES_ALL = ['Achagua', 'Amorúa', 'Andoke', 'Arhuaco', 'Awá', 'Bara', 'Barasano', 'Barí', 'Betoye', 'Bora', 'Carapana', 'Karijona', 'Chimila', 'Chiricoa', 'Cocama', 'Coconuco', 'Coreguaje', 'Pijao', 'Cubeo', 'Cuiba', 'Cuna Tule', 'Curripaco', 'Desano', 'Dujos', 'Emberá', 'Emberá Katío', 'Emberá Chamí', 'Eperara Siapidara', 'Emberá Dobida', 'Nutabe', 'Misak', 'Ambaló', 'Kizgó', 'Guanaca', 'Wanano', 'Guayabero', 'Cañamomo Lomaprieta', 'Inga', 'Kamëntsá', 'Kofán', 'Kogui', 'Letuama', 'Makaguaje', 'Hitnu', 'Makuna', 'Nukak', 'Masiguare', 'Matapí', 'Miraña', 'Muisca', 'Nonuya', 'Ocaina', 'Nasa', 'Polindara', 'Piapoco', 'Piaroa', 'Piratapuyo', 'Pisamira', 'Puinave', 'Pastos', 'Quillacinga', 'Sáliva', 'Sikuani', 'Siona', 'Siriano', 'Taiwano', 'Tanimuka', 'Tariano', 'Tatuyo', 'Totoró', 'Tikuna', 'Tsiripu', 'Tukano', 'U\'wa', 'Tuyuca', 'Wounaan', 'Wayuu', 'Uitoto', 'Muruí', 'Muinane', 'Yagua', 'Yanacona', 'Yauna', 'Yukuna', 'Yukpa', 'Yurutí', 'Zenú', 'Guane', 'Mokaná', 'Kichwa', 'Kankuamo', 'Tayrona', 'Chitarero', 'Quimbaya', 'Calima', 'Panches', 'Wiwa']
categorical('CO_PUEBLO_INDIGENA', 'co-pueblos-indigenas.txt', PEOPLES_TOP, 'Kuna', ['720', '800', '500', '560', '282', '281', '200', '290', '580', '340'])
domain('CO_L3_PUEBLO_INDIGENA', 'CO_PUEBLO_INDIGENA',
  byName(['pueblo(_?ind[ií]gena)?|(cod|codigo|nombre|nom)_?pueblo|resguardo_?ind[ií]gena|cabildo(_?ind[ií]gena)?|comunidad_?(ind[ií]gena|negra|afro)|consejo_?comunitario|parcialidad|kumpania|indigenous_?people', 0.9]),
  byList([['co-detectar-pueblos-indigenas.txt', [...PEOPLES_ALL, 'wayúu', 'wayú', 'guajiro', 'paez', 'páez', 'guambiano', 'embera', 'katío', 'chamí', 'senú', 'ticuna', 'huitoto', 'witoto', 'kuna', 'tule'], 0.9]], { reject: 0.4 }))

// Native languages: 65 in Colombia, besides the creole of San Andrés and Palenque and Romaní.
const LANGUAGES = ['Español', 'Wayuunaiki', 'Nasa Yuwe', 'Emberá', 'Namtrik', 'Sikuani', 'Inga', 'Kriol (creole sanandresano)', 'Lengua palenquera', 'Romaní', 'Ikʉ (arhuaco)', 'Ninguna lengua nativa']
categorical('CO_LENGUA', 'co-lenguas.txt', LANGUAGES, 'Tikuna')
domain('CO_L3_LENGUA_NATIVA', 'CO_LENGUA',
  byName(['lengua_?(nativa|materna|ind[ií]gena|propia)|idioma_?(nativo|materno|ind[ií]gena)|habla_?lengua|lengua(?!_?(extranjera|codigo|cod))|mother_?tongue|native_?language', 0.9]),
  byList([['co-detectar-lenguas.txt', [...LANGUAGES, 'wayuunaiki', 'nasa yuwe', 'embera', 'namtrik', 'misak', 'sikuani', 'inga', 'kamëntsá', 'kriol', 'creole', 'palenquero', 'romaní', 'romanés', 'arhuaco', 'kogui', 'tikuna', 'tukano', 'curripaco', 'español', 'castellano'], 0.8]], { reject: 0.4 }))

const RELIGIONS = ['Católica', 'Cristiana evangélica', 'Pentecostal', 'Adventista del Séptimo Día', 'Testigo de Jehová', 'Iglesia de Jesucristo de los Santos de los Últimos Días', 'Judía', 'Musulmana', 'Budista', 'Espiritualidad ancestral', 'Otra', 'Ninguna']
categorical('CO_RELIGION', 'co-religiones.txt', RELIGIONS, 'Anglicana')
domain('CO_L3_RELIGION', 'CO_RELIGION',
  byName(['religi[oó]n|creencia_?religiosa|convicci[oó]n_?religiosa|credo|confesi[oó]n_?religiosa|culto|iglesia(_?(a_?la_?que_?pertenece|nombre))?|denominaci[oó]n_?religiosa|(cod|codigo|tipo)_?religion|religion|church', 0.95]),
  byList([['co-detectar-religiones.txt', [...RELIGIONS, 'católico', 'catolico', 'cristiano', 'cristiana', 'evangélico', 'protestante', 'pentecostal', 'adventista', 'testigo de jehová', 'mormón', 'judío', 'musulmán', 'budista', 'ateo', 'agnóstico', 'ninguna', 'ninguno'], 0.9]], { reject: 0.4 }))

domain('CO_L3_CONVICCION_FILOSOFICA', 'CO_CATEGORIA_SUPRIMIDA',
  byName(['convicci[oó]n(es)?_?(filos[oó]fica|moral|personal)|creencias?_?(filos[oó]ficas?|personales)|objeci[oó]n_?(de_?)?conciencia|objetor_?(de_?)?conciencia|masoner[ií]a|logia|beliefs?|philosophical_?beliefs?', 0.9]))

const IDEOLOGIES = ['Izquierda', 'Centroizquierda', 'Centro', 'Centroderecha', 'Derecha', 'Independiente', 'Prefiere no responder']
categorical('CO_ORIENTACION_POLITICA', 'co-orientaciones-politicas.txt', IDEOLOGIES, 'Uribista')
domain('CO_L3_ORIENTACION_POLITICA', 'CO_ORIENTACION_POLITICA',
  byName(['orientaci[oó]n_?pol[ií]tica|opini[oó]n_?pol[ií]tica|tendencia_?pol[ií]tica|ideolog[ií]a(_?pol[ií]tica)?|preferencia_?(pol[ií]tica|partidista|electoral)|intenci[oó]n_?(de_?)?voto|simpat[ií]a_?pol[ií]tica|political_?(opinion|orientation|view)|voting_?intention', 0.9]),
  byList([['co-detectar-orientaciones-politicas.txt', [...IDEOLOGIES, 'izquierda', 'derecha', 'centro', 'progresista', 'conservador', 'liberal', 'uribista', 'petrista', 'independiente', 'indeciso', 'voto en blanco', 'ninguno'], 0.7]], { reject: 0.4 }))

// Political organizations with legal personality certified by the Consejo Nacional Electoral in
// September 2026. The law protects membership of parties and of the parties of the opposition.
const PARTIES = ['Partido Liberal Colombiano', 'Partido Conservador Colombiano', 'Partido Cambio Radical', 'Partido Alianza Verde', 'Movimiento Autoridades Indígenas de Colombia (AICO)', 'Partido Alianza Social Independiente (ASI)', 'Partido Político MIRA', 'Partido de la U', 'Partido Centro Democrático', 'Movimiento Alternativo Indígena y Social (MAIS)', 'Partido Comunes', 'Partido Colombia Justa Libres', 'Partido Colombia Renaciente', 'Movimiento Alianza Democrática Amplia', 'Partido Dignidad & Compromiso', 'Partido Nuevo Liberalismo', 'Movimiento Salvación Nacional', 'Partido Político Oxígeno', 'Partido Republicano', 'Partido Demócrata Colombiano', 'Partido Ecologista Colombiano', 'Partido Político La Fuerza', 'Partido Político Esperanza Democrática', 'Partido Político En Marcha', 'Movimiento Político Pacto Histórico', 'Partido Político Defensores de la Patria', 'Consejo Comunitario El Naranjo', 'Movimiento Unidad en Minga por Colombia']
categorical('CO_PARTIDO', 'co-partidos.txt', [...PARTIES, 'Sin afiliación'], 'Polo Democrático Alternativo')
domain('CO_L3_AFILIACION_PARTIDO', 'CO_PARTIDO',
  byName(['partido(_?pol[ií]tico)?(_?(afiliaci[oó]n|nombre|militancia))?|movimiento_?pol[ií]tico|afiliaci[oó]n_?(pol[ií]tica|partidista|partido)|militancia(_?pol[ií]tica)?|militante|(cod|codigo|nombre|nom)_?partido|colectividad|bancada|oposici[oó]n|political_?party|party_?membership', 0.95]),
  byList([['co-detectar-partidos.txt', [...PARTIES, 'Partido Liberal', 'Liberal', 'Conservador', 'Cambio Radical', 'Alianza Verde', 'AICO', 'ASI', 'MIRA', 'La U', 'Partido de la U', 'Centro Democrático', 'MAIS', 'Comunes', 'Colombia Justa Libres', 'Nuevo Liberalismo', 'Salvación Nacional', 'Pacto Histórico', 'Polo Democrático', 'Colombia Humana', 'Defensores de la Patria', 'En Marcha', 'Dignidad', 'Oxígeno'], 0.8]], { reject: 0.4 }))

// "Pertenencia a sindicatos": the values share no vocabulary beyond the confederations, so they are
// suppressed; flags stay flags.
domain('CO_L3_SINDICATO', 'CO_CATEGORIA_SUPRIMIDA',
  byName(['sindicato(_?(nombre|afiliado|afiliaci[oó]n|codigo))?|sindicalizado|afiliado_?sindicato|afiliaci[oó]n_?sindical|cuota_?sindical|descuento_?sindical|aporte_?sindical|asociaci[oó]n_?sindical|fuero_?sindical|directivo_?sindical|central_?obrera|convenci[oó]n_?colectiva|pacto_?colectivo|trade_?union|union_?member(ship)?', 0.95]),
  byList([['co-detectar-sindicatos.txt', ['CUT', 'CGT', 'CTC', 'FECODE', 'USO', 'SINTRAINAL', 'ANTHOC', 'ASMEDAS', 'SINTRAEMCALI', 'ADE', 'ADIDA', 'ASOINCA', 'SINTRAUNICOL', 'Central Unitaria de Trabajadores', 'Confederación General del Trabajo', 'Confederación de Trabajadores de Colombia', 'Federación Colombiana de Trabajadores de la Educación', 'Unión Sindical Obrera', 'sindicalizado'], 0.6]], { reject: 0.3 }))

// "Pertenencia a organizaciones sociales, de derechos humanos": social leaders and human rights
// defenders are among the people most exposed to violence in Colombia.
domain('CO_L3_ORGANIZACION_SOCIAL', 'CO_CATEGORIA_SUPRIMIDA',
  byName(['organizaci[oó]n_?(social|comunitaria|de_?base|de_?derechos_?humanos|defensora)|l[ií]der(esa)?_?(social|comunal|comunitario)|liderazgo_?social|defensor(a)?_?(de_?)?derechos_?humanos|ddhh|junta_?(de_?)?acci[oó]n_?comunal|jac|movimiento_?social|asociaci[oó]n_?(de_?)?(v[ií]ctimas|campesinos|mujeres)|colectivo_?social|ong_?(afiliado|miembro)|human_?rights_?defender', 0.9]))

domain('CO_L3_BIOMETRICO', 'CO_REDACTAR',
  byName(['biometr[ií]a[a-z_]*|biom[eé]trico[a-z_]*|huella(_?dactilar)?(_?(template|plantilla|imagen|hash))?|huellas|dactilar|template_?(facial|huella|biometrico)|plantilla_?(facial|biom[eé]trica)|rostro_?(hash|template)|reconocimiento_?facial|firma_?(biom[eé]trica|digitalizada|manuscrita)|iris|voz_?(biom[eé]trica|template)|fingerprints?|face_?(template|hash|encoding)|biometric[a-z_]*', 0.9]),
  byType(STRING()))

// Not in the list of art. 5, but the Constitutional Court treats genetic data as sensitive.
domain('CO_L3_GENETICO', 'CO_REDACTAR',
  byName(['adn|dna|gen[eé]tic[oa]s?|datos?_?gen[eé]ticos?|genoma|genotip[a-z_]*|prueba_?(gen[eé]tica|de_?adn|de_?paternidad)|perfil_?gen[eé]tico|mutaci[oó]n|brca[12]?|cariotipo|tamizaje_?neonatal|genetic[a-z_]*', 0.9]))

const ORIENTATIONS = ['Heterosexual', 'Gay', 'Lesbiana', 'Bisexual', 'Pansexual', 'Asexual', 'Otra', 'Prefiere no responder']
categorical('CO_ORIENTACION_SEXUAL', 'co-orientaciones-sexuales.txt', ORIENTATIONS, 'Homosexual')
domain('CO_L3_ORIENTACION_SEXUAL', 'CO_ORIENTACION_SEXUAL',
  byName(['orientaci[oó]n_?sexual|orient_?sexual|(cod|codigo|tipo)_?orientacion_?sexual|preferencia_?sexual|sexual_?orientation', 0.95]),
  byList([['co-detectar-orientaciones-sexuales.txt', [...ORIENTATIONS, 'hetero', 'homosexual', 'lgbti', 'lgbtiq+', 'queer'], 0.8]], { reject: 0.4 }))

domain('CO_L3_VIDA_SEXUAL', 'CO_CATEGORIA_SUPRIMIDA',
  byName(['vida_?sexual|actividad_?sexual|conducta_?sexual|pr[aá]cticas?_?sexuales?|parejas?_?sexuales?|n(o|ro|um|umero)_?parejas|sexualmente_?activ[oa]|inicio_?(de_?)?(la_?)?vida_?sexual|relaciones_?sexuales|sex(ual)?_?life|sexual_?(activity|behavio(u)?r|partners)', 0.9]))

const IDENTITIES = ['Mujer cisgénero', 'Hombre cisgénero', 'Mujer trans', 'Hombre trans', 'Persona no binaria', 'Otra', 'Prefiere no responder']
categorical('CO_IDENTIDAD_GENERO', 'co-identidades-genero.txt', IDENTITIES, 'Transgénero')
domain('CO_L3_IDENTIDAD_GENERO', 'CO_IDENTIDAD_GENERO',
  byName(['identidad_?(de_?)?g[eé]nero|(cod|codigo|tipo)_?identidad_?genero|g[eé]nero_?(autopercibido|identitario)|transg[eé]nero|persona_?trans|nombre_?identitario|pronombres?|gender_?identity', 0.95]),
  byList([['co-detectar-identidades-genero.txt', [...IDENTITIES, 'cisgénero', 'cis', 'transgénero', 'trans', 'no binario', 'no binaria', 'mujer', 'hombre', 'femenino', 'masculino'], 0.7]], { reject: 0.4 }))

// Victims of the armed conflict (Ley 1448 de 2011): the victimizing event of the Registro Único de
// Víctimas. Not in the list of art. 5, but its misuse exposes people to discrimination and to
// violence, and the law orders its confidentiality.
const VICTIMIZING_EVENTS = ['Desplazamiento forzado', 'Homicidio', 'Amenaza', 'Desaparición forzada', 'Pérdida de bienes muebles o inmuebles', 'Secuestro', 'Delitos contra la libertad y la integridad sexual', 'Minas antipersonal, munición sin explotar y artefacto explosivo improvisado', 'Vinculación de niños, niñas y adolescentes a grupos armados', 'Tortura', 'Lesiones personales', 'Abandono o despojo forzado de tierras', 'Acto terrorista', 'Confinamiento', 'No es víctima']
categorical('CO_VICTIMA', 'co-hechos-victimizantes.txt', VICTIMIZING_EVENTS, 'Masacre')
domain('CO_L3_VICTIMA_CONFLICTO', 'CO_VICTIMA',
  byName(['v[ií]ctima(_?(del_?)?(conflicto(_?armado)?|ruv))?|hecho_?victimizante|(cod|codigo|tipo)_?hecho(_?victimizante)?|ruv|registro_?[uú]nico_?(de_?)?v[ií]ctimas|desplazad[oa](_?(forzad[oa]))?|condici[oó]n_?(de_?)?(v[ií]ctima|desplazado)|poblaci[oó]n_?desplazada|estado_?ruv|sujeto_?(de_?)?reparaci[oó]n|victim_?of_?conflict', 0.95]),
  byList([['co-detectar-hechos-victimizantes.txt', [...VICTIMIZING_EVENTS, 'desplazado', 'desplazada', 'víctima', 'incluido', 'no incluido', 'masacre', 'reclutamiento forzado', 'despojo de tierras', 'mina antipersonal'], 0.8],
    ['co-detectar-codigos-banderas.txt', ['s', 'n', 'sí', 'no', '1', '2', '3', '4', '5', '6'], 0.3],
  ], { reject: 0.4 }))

// People in the reintegration or reincorporation process of the Agencia para la Reincorporación y
// la Normalización: ex-combatants.
domain('CO_L3_REINCORPORACION', 'CO_CATEGORIA_SUPRIMIDA',
  byName(['reincorporad[oa]|reincorporaci[oó]n|reintegrad[oa]|reintegraci[oó]n|desmovilizad[oa]|desmovilizaci[oó]n|excombatiente|ex_?combatiente|firmante_?(de_?)?paz|arn|poblaci[oó]n_?(en_?proceso_?de_?)?(reincorporaci[oó]n|reintegraci[oó]n)|ex_?farc|ex_?guerriller[oa]', 0.95]))

// ── SALUD · Health data (art. 5) ────────────────────────────────────────────

// Health identifiers: the medical record is identified by the patient's identity document number
// (Resolución 1995 de 1999), and falls under the document domain; the rest are internal numbers.
domain('CO_SALUD_IDENTIFICADOR', 'CO_CM_ALFANUM',
  byName(
    ['n(o|ro|um|umero)_?(historia(_?cl[ií]nica)?|hc|ingreso|atenci[oó]n|autorizaci[oó]n|orden_?m[eé]dica|f[oó]rmula|incapacidad|carn[eé]_?(eps|salud)|afiliaci[oó]n_?eps|mipres|prescripci[oó]n)|historia_?cl[ií]nica|hc_?(n(o|ro|um|umero))?|autorizaci[oó]n_?(servicio|eps)|mipres|c[oó]digo_?(paciente|afiliado)|id_?paciente|n(o|ro)_?rips', 0.85],
    ['atenci[oó]n|ingreso|autorizaci[oó]n|episodio', 0.55],
  ))

// Affiliation to the health system: the regime and the EPS. The subsidized regime tells that a
// person could not pay contributions.
const REGIMES = ['Contributivo', 'Subsidiado', 'Especial', 'De excepción', 'No afiliado']
const EPS = ['Nueva EPS', 'EPS Sura', 'EPS Sanitas', 'Salud Total EPS', 'Compensar EPS', 'Famisanar EPS', 'Coosalud EPS', 'Mutual Ser EPS', 'Emssanar EPS', 'Asmet Salud EPS', 'Capresoca EPS', 'SOS EPS', 'Aliansalud EPS', 'Cajacopi EPS', 'Comfenalco Valle EPS', 'Savia Salud EPS', 'Capital Salud EPS', 'Salud Mía EPS']
decompose('CO_AFILIACION_SALUD', [
  [FLAG, apply('CO_BANDERA')],
  [String.raw`(?i)(contributivo|subsidiado|especial|de\s+excepci[oó]n|excepci[oó]n|no\s+afiliado)`, apply(lookup('CO_REGIMEN_SALUD', 'co-regimenes-salud.txt', REGIMES))],
  [String.raw`(\d{1,6})`, DIGITS],
], apply(lookup('CO_EPS', 'co-eps.txt', EPS, undefined, 'PRESERVE_LOOKUP_FILE')), 'Subsidiado')
domain('CO_SALUD_AFILIACION', 'CO_AFILIACION_SALUD',
  byName(['r[eé]gimen(_?(de_?)?(salud|afiliaci[oó]n))?|tipo_?(de_?)?(regimen|afiliado|afiliaci[oó]n)|eps(_?(afiliado|actual|nombre|codigo))?|(cod|codigo|nombre|nom)_?eps|entidad_?promotora(_?(de_?)?salud)?|aseguradora_?salud|administradora_?(de_?)?salud|eapb|prepagada|medicina_?prepagada|plan_?complementario', 0.85]),
  byList([['co-detectar-afiliacion-salud.txt', [...REGIMES, ...EPS, 'contributivo', 'subsidiado', 'régimen especial', 'sura', 'sanitas', 'salud total', 'compensar', 'famisanar', 'coosalud', 'nueva eps', 'medimás', 'coomeva eps', 'savia salud', 'cafesalud'], 0.8]], { reject: 0.4 }))

const ICD10 = ['I10', 'E11', 'E78', 'J45', 'J06', 'J02', 'J20', 'K29', 'K21', 'K59', 'M54', 'M17', 'M25', 'N39', 'N20', 'R51', 'R10', 'H10', 'H66', 'L23', 'L30', 'B34', 'A09', 'E03', 'E66', 'D50', 'I83', 'K80', 'K40', 'S93', 'S60', 'Z00', 'J30', 'J32', 'G43', 'M79', 'R05']
const ICD10_DECIMAL = ['E11.9', 'E78.5', 'J45.9', 'J06.9', 'J02.9', 'J20.9', 'K29.7', 'K21.9', 'K59.0', 'M54.5', 'M17.9', 'N39.0', 'N20.0', 'R10.4', 'H10.9', 'H66.9', 'L23.9', 'L30.9', 'B34.9', 'A09.9', 'E03.9', 'E66.9', 'D50.9', 'I83.9', 'K80.2', 'K40.9', 'S93.4', 'S60.0', 'Z00.0', 'J30.4', 'J32.9', 'G43.9', 'M79.1']
decompose('CO_DIAGNOSTICO', [
  [String.raw`([A-TV-Za-tv-z]\d{2}\.\d{1,2})`, apply(lookup('CO_CIE10_DECIMAL', 'co-cie10-decimal.txt', ICD10_DECIMAL, undefined, 'PRESERVE_LOOKUP_FILE'))],
  // RIPS writes the four-character code without the dot: E119.
  [String.raw`([A-TV-Za-tv-z]\d{2,3}X?)`, apply(lookup('CO_CIE10', 'co-cie10.txt', ICD10, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [FLAG, apply('CO_BANDERA')],
], apply(lookup('CO_DIAGNOSTICO_TEXTO', 'co-diagnosticos.txt', ['Hipertensión esencial', 'Diabetes mellitus tipo 2', 'Asma', 'Lumbago', 'Gastritis crónica', 'Rinofaringitis aguda', 'Infección de vías urinarias', 'Migraña', 'Hipotiroidismo', 'Dislipidemia', 'Obesidad', 'Gonartrosis', 'Bronquitis aguda', 'Amigdalitis aguda', 'Dermatitis de contacto', 'Otitis media aguda', 'Esguince de tobillo', 'Conjuntivitis', 'Anemia ferropénica', 'Enfermedad por reflujo gastroesofágico', 'Síndrome de colon irritable', 'Tendinitis', 'Sinusitis aguda', 'Cefalea tensional', 'Várices', 'Hernia inguinal', 'Cálculo renal', 'Colelitiasis', 'Gastroenteritis aguda', 'Control de salud de rutina'])), 'F33.1')
domain('CO_SALUD_DIAGNOSTICO', 'CO_DIAGNOSTICO',
  byName(['diagn[oó]stico[a-z_]*|dx(_?(principal|relacionado|ingreso|egreso)[0-9]?)?|cie_?10|cie(_?(10|11|principal))?|(cod|codigo)_?(diagnostico|dx|cie)|impresi[oó]n_?diagn[oó]stica|enfermedad(es)?[a-z_]*|patolog[ií]a|comorbilidad(es)?|antecedentes?_?(m[eé]dicos|patol[oó]gicos|familiares|personales)|causa_?(de_?)?(muerte|defunci[oó]n|incapacidad|hospitalizaci[oó]n|consulta)|motivo_?(de_?)?(consulta|incapacidad|hospitalizaci[oó]n)|alergias?|diagnos(is|es)|icd_?(10|11)?', 0.85]),
  // 0.5: codes shaped like ICD-10 appear in other catalogs too; the name has to agree.
  byPattern([[String.raw`[A-TV-Za-tv-z]\d{2}(\.\d{1,2}|\d|X)?`, 0.5]], { reject: 0.3 }))

// CUPS: the Colombian classification of health procedures, six characters.
lookup('CO_CUPS', 'co-cups.txt', ['890201', '890301', '890701', '902210', '903841', '907106', '903895', '903815', '873420', '881302'], '906249', 'PRESERVE_LOOKUP_FILE')
decompose('CO_PROCEDIMIENTO', [[String.raw`(\d{6}|\d{2}\.\d{2}\.\d{2})`, apply('CO_CUPS')]], apply(lookup('CO_PROCEDIMIENTO_TEXTO', 'co-procedimientos.txt', ['Consulta de primera vez por medicina general', 'Consulta de control o de seguimiento por medicina general', 'Consulta de urgencias por medicina general', 'Hemograma', 'Glucosa en suero', 'Uroanálisis', 'Creatinina en suero', 'Radiografía de tórax', 'Ecografía abdominal', 'Electrocardiograma'])), 'Prueba de carga viral para VIH')
domain('CO_SALUD_PROCEDIMIENTO', 'CO_PROCEDIMIENTO',
  byName(['cups|(cod|codigo)_?(cups|procedimiento|servicio_?salud)|procedimiento(_?(m[eé]dico|quir[uú]rgico|realizado|autorizado))?|servicio_?(de_?)?salud_?(prestado|autorizado)|examen_?(ordenado|realizado)|cirug[ií]a(_?realizada)?|intervenci[oó]n_?quir[uú]rgica|medical_?procedure', 0.85]))

const MEDICATIONS = ['Acetaminofén', 'Ibuprofeno', 'Naproxeno', 'Diclofenaco', 'Metformina', 'Glibenclamida', 'Losartán', 'Enalapril', 'Amlodipino', 'Atorvastatina', 'Omeprazol', 'Levotiroxina', 'Amoxicilina', 'Cefalexina', 'Salbutamol', 'Loratadina', 'Hidroclorotiazida', 'Ácido acetilsalicílico', 'Prednisolona', 'Azitromicina', 'Sulfato ferroso', 'Ácido fólico', 'Complejo B', 'Dexametasona']
categorical('CO_MEDICAMENTO', 'co-medicamentos.txt', MEDICATIONS, 'Sertralina 50 mg')
domain('CO_SALUD_MEDICAMENTO', 'CO_MEDICAMENTO',
  byName(['medicamentos?(_?(formulado|prescrito|entregado|dispensado|nombre|uso))?|f[aá]rmacos?|principio_?activo|cum|(cod|codigo)_?(cum|medicamento)|f[oó]rmula_?m[eé]dica|prescripci[oó]n_?(medicamento)?|posolog[ií]a|tratamiento_?farmacol[oó]gico|medications?|drugs?_?prescribed', 0.85]),
  byList([['co-detectar-medicamentos.txt', [...MEDICATIONS, 'acetaminofen', 'sertralina', 'fluoxetina', 'escitalopram', 'quetiapina', 'clonazepam', 'alprazolam', 'lorazepam', 'litio', 'metilfenidato', 'risperidona', 'olanzapina', 'haloperidol', 'tenofovir', 'emtricitabina', 'dolutegravir', 'efavirenz', 'insulina', 'warfarina', 'levetiracetam', 'ácido valproico', 'misoprostol', 'levonorgestrel', 'anticonceptivo'], 0.7]], { reject: 0.3 }))

domain('CO_SALUD_TEXTO_CLINICO', 'CO_TEXTO_LIBRE',
  byName(['anamnesis|evoluci[oó]n(_?(m[eé]dica|cl[ií]nica|enfermer[ií]a))?|enfermedad_?actual|examen_?f[ií]sico|an[aá]lisis_?(y_?)?plan|plan_?(de_?)?manejo|conducta(_?m[eé]dica)?|epicrisis|resumen_?(de_?)?(egreso|atenci[oó]n)|nota_?(m[eé]dica|de_?enfermer[ií]a|cl[ií]nica)|notas?_?(m[eé]dicas|cl[ií]nicas)|triage(_?texto)?|motivo_?consulta_?texto|interpretaci[oó]n_?(resultado|examen)|informe_?(patolog[ií]a|radiolog[ií]a)|clinical_?notes?|discharge_?summary', 0.85]),
  byType(STRING(30)))

domain('CO_SALUD_RESULTADO_EXAMEN', 'CO_CM_ALFANUM',
  byName(
    ['resultado_?(del_?)?(examen|prueba|laboratorio|vih|covid|pcr|serolog[ií]a|biopsia|glicemia|citolog[ií]a|patolog[ií]a)|(examen|prueba)_?(resultado|laboratorio)|vih(_?(estado|resultado|prueba))?|carga_?viral|cd4|glicemia|glucosa|hemoglobina_?glicosilada|hba1c|colesterol|imc|presi[oó]n_?arterial|tensi[oó]n_?arterial|prueba_?(de_?)?embarazo|toxicol[oó]gico|alcoholemia|lab_?results?|test_?results?', 0.8],
    ['resultado|prueba', 0.5],
  ))

// Blood group and Rh are printed on the cédula and asked by most employers.
const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']
lookup('CO_GRUPO_SANGUINEO', 'co-grupos-sanguineos.txt', BLOOD_GROUPS, 'O+', 'PRESERVE_LOOKUP_FILE')
domain('CO_SALUD_GRUPO_SANGUINEO', 'CO_GRUPO_SANGUINEO',
  byName(['grupo_?sangu[ií]neo|tipo_?(de_?)?sangre|rh|factor_?rh|gs_?rh|grupo_?rh|hemoclasificaci[oó]n|abo(_?rh)?|blood_?(type|group)', 0.9]),
  byList([['co-detectar-grupos-sanguineos.txt', [...BLOOD_GROUPS, '0+', '0-', 'a positivo', 'a negativo', 'b positivo', 'b negativo', 'ab positivo', 'ab negativo', 'o positivo', 'o negativo'], 0.9]], { reject: 0.4 }))

// Disability as the certification of the Ministry of Health classifies it.
const DISABILITIES = ['Física', 'Auditiva', 'Visual', 'Sordoceguera', 'Intelectual', 'Psicosocial (mental)', 'Múltiple', 'Ninguna']
categorical('CO_DISCAPACIDAD', 'co-discapacidades.txt', DISABILITIES, 'Trastorno del espectro autista')
domain('CO_SALUD_DISCAPACIDAD', 'CO_DISCAPACIDAD',
  byName(['discapacidad[a-z_]*|(tipo|cod|codigo|categoria)_?discapacidad|persona_?con_?discapacidad|pcd|condici[oó]n_?(de_?)?discapacidad|certificado_?(de_?)?discapacidad|rlcpd|necesidades_?(educativas_?)?especiales|movilidad_?reducida|disabilit(y|ies)', 0.9]),
  byList([['co-detectar-discapacidades.txt', [...DISABILITIES, 'física', 'motora', 'auditiva', 'sordera', 'visual', 'ceguera', 'baja visión', 'sordoceguera', 'intelectual', 'cognitiva', 'mental', 'psicosocial', 'múltiple', 'autismo', 'ninguna', 'no aplica'], 0.6]], { reject: 0.3 }))

// Occupational health: fitness exams, work accidents and occupational diseases (ARL), sick leaves.
categorical('CO_SALUD_LABORAL', 'co-aptitud-laboral.txt', ['Apto', 'Apto con restricciones', 'No apto', 'Aplazado'], 'No apto temporalmente')
domain('CO_SALUD_OCUPACIONAL', 'CO_SALUD_LABORAL',
  byName(['concepto_?(de_?)?aptitud|aptitud_?(laboral|m[eé]dica)|examen_?(m[eé]dico_?)?(ocupacional|de_?ingreso|de_?retiro|peri[oó]dico)|resultado_?examen_?ocupacional|accidente_?(de_?)?trabajo|at_?(tipo|reporte)|furat|enfermedad_?laboral|furel|incapacidad(_?(m[eé]dica|laboral|tipo|motivo|d[ií]as))?|d[ií]as_?(de_?)?incapacidad|licencia_?(de_?)?(maternidad|paternidad)|calificaci[oó]n_?(de_?)?(p[eé]rdida|origen)|p[eé]rdida_?(de_?)?capacidad_?laboral|pcl|restricciones_?m[eé]dicas|recomendaciones_?m[eé]dicas|reintegro_?laboral', 0.85]),
  byList([['co-detectar-aptitud-laboral.txt', ['apto', 'no apto', 'apto con restricciones', 'aplazado', 'apto con recomendaciones'], 0.6]], { reject: 0.3 }))

// Reproductive and mental health: the values have no shared vocabulary, so they are suppressed
// (flags and numeric codes keep their shape).
domain('CO_SALUD_REPRODUCTIVA', 'CO_CATEGORIA_SUPRIMIDA',
  byName(['gestante|embarazo|embarazada|gestaci[oó]n|edad_?gestacional|semanas_?(de_?)?gestaci[oó]n|fum|fecha_?[uú]ltima_?menstruaci[oó]n|control_?prenatal|prenatal|parto(_?tipo)?|ces[aá]rea|aborto|ive|interrupci[oó]n_?voluntaria(_?del_?embarazo)?|m[eé]todo_?(de_?)?planificaci[oó]n|planificaci[oó]n_?familiar|anticoncepci[oó]n|anticonceptivo|fertilidad|infertilidad|its|ets|infecci[oó]n(es)?_?(de_?)?transmisi[oó]n_?sexual|pregnan(t|cy)|contracepti(on|ve)', 0.9]))

domain('CO_SALUD_MENTAL', 'CO_CATEGORIA_SUPRIMIDA',
  byName(['salud_?mental|trastorno[a-z_]*|psiqui[aá]tri[a-z_]*|psicol[oó]gi[a-z_]*|depresi[oó]n|ansiedad|suicid[a-z_]*|intento_?(de_?)?suicidio|autolesi[oó]n|consumo_?(de_?)?(sustancias|spa|alcohol|drogas)|spa|sustancias_?psicoactivas|adicci[oó]n(es)?|farmacodependencia|alcoholismo|tabaquismo|mental_?health', 0.9]))

// ── FIN · Financial data (Ley 1266 de 2008) ─────────────────────────────────

decompose('CO_CREDITO', [
  // A score (DataCrédito 150 to 950) keeps its number of digits; flags stay flags.
  [String.raw`(\d{1,4})`, DIGITS],
  [FLAG, apply('CO_BANDERA')],
], apply(lookup('CO_ESTADO_CREDITO', 'co-estados-credito.txt', ['Al día', 'Mora de 30 días', 'Mora de 60 días', 'Mora de 90 días', 'Mora de 120 días o más', 'Reportado negativamente', 'En cobro jurídico', 'Reestructurado', 'Castigado', 'Sin historial crediticio'])), 'Reportado en DataCrédito')
domain('CO_FIN_CREDITO', 'CO_CREDITO',
  byName(['score(_?(cr[eé]dito|datacr[eé]dito|cifin|transunion|experian|interno))?|puntaje_?(de_?)?cr[eé]dito|calificaci[oó]n_?(de_?)?(riesgo|cr[eé]dito|cartera)|centrales?_?(de_?)?riesgo|reporte_?(negativo|centrales|datacr[eé]dito|cifin)|reportado|dato_?negativo|datacr[eé]dito|cifin|transunion|d[ií]as_?(de_?)?mora|altura_?(de_?)?mora|edad_?(de_?)?mora|estado_?(de_?)?(cartera|obligaci[oó]n|cr[eé]dito)|morosidad|moroso|cartera_?castigada|cobro_?jur[ií]dico|credit_?score|credit_?rating', 0.9]))

algorithm('CO_VALOR_DEUDA', 'characterMapping.NumericMapping', { minValue: 100000, maxValue: 1000000000 }, '8500000')
domain('CO_FIN_DEUDA', 'CO_VALOR_DEUDA',
  byName(['saldo_?(deuda|cr[eé]dito|capital|obligaci[oó]n|cartera|en_?mora|adeudado)|valor_?(de_?la_?)?(deuda|cuota|obligaci[oó]n|cr[eé]dito|pr[eé]stamo|mora|en_?mora)|vr_?(cuota|deuda|mora|saldo)|deuda(_?total)?|cupo_?(de_?)?(cr[eé]dito|tarjeta)|cupo_?aprobado|monto_?(cr[eé]dito|pr[eé]stamo|desembolsado)|cuota_?mensual|loan_?(amount|balance)|outstanding_?balance|debt', 0.85]),
  byType(NUMBER()))

algorithm('CO_INGRESOS', 'characterMapping.NumericMapping', { minValue: 1000000, maxValue: 60000000 }, '3200000')
domain('CO_FIN_INGRESOS', 'CO_INGRESOS',
  byName(['salario(_?(b[aá]sico|integral|mensual|devengado))?|sueldo(_?(b[aá]sico|mensual))?|ingresos?(_?(mensuales?|totales?|familiares?|laborales?|declarados?))?|ibc|ingreso_?base_?(de_?)?cotizaci[oó]n|devengado|asignaci[oó]n_?b[aá]sica|honorarios|remuneraci[oó]n|vr_?(salario|ingreso)|valor_?(salario|ingresos?)|salary|income|wages?', 0.85]),
  byType(NUMBER()))

algorithm('CO_PATRIMONIO', 'characterMapping.NumericMapping', { minValue: 10000000, maxValue: 2000000000 }, '185000000')
domain('CO_FIN_PATRIMONIO', 'CO_PATRIMONIO',
  byName(['patrimonio(_?(l[ií]quido|bruto))?|activos?_?(totales?)?|valor_?(del_?)?(inmueble|veh[ií]culo|bienes|aval[uú]o|comercial|catastral|inversi[oó]n)|aval[uú]o(_?catastral)?|saldo_?(cuenta|ahorros|cdt|inversi[oó]n|cesant[ií]as|pensi[oó]n_?voluntaria)|cdt(_?valor)?|cesant[ií]as|net_?worth|account_?balance', 0.85]),
  byType(NUMBER()))

algorithm('CO_VALOR_PENSION', 'characterMapping.NumericMapping', { minValue: 1750905, maxValue: 30000000 }, '2400000')
domain('CO_FIN_PENSION', 'CO_VALOR_PENSION',
  byName(['mesada(_?pensional)?|valor_?(de_?la_?)?(pensi[oó]n|mesada|subsidio|auxilio|beneficio)|pensi[oó]n_?(valor|mensual|monto)|vr_?(pension|subsidio)|cuota_?alimentaria|pension_?amount', 0.9]),
  byType(NUMBER()))

// Socioeconomic stratum: 1 to 6, the class of the dwelling for utility tariffs. It stays within its
// band — low (1–2), middle (3–4), high (5–6) — so the analysis keeps its shape.
decompose('CO_ESTRATO', [
  [String.raw`(?i)(estrato\s*)?([12])`, keep, apply(lookup('CO_ESTRATO_BAJO', 'co-estrato-bajo.txt', ['1', '2']))],
  [String.raw`(?i)(estrato\s*)?([34])`, keep, apply(lookup('CO_ESTRATO_MEDIO', 'co-estrato-medio.txt', ['3', '4']))],
  [String.raw`(?i)(estrato\s*)?([56])`, keep, apply(lookup('CO_ESTRATO_ALTO', 'co-estrato-alto.txt', ['5', '6']))],
], keep, '3')
domain('CO_FIN_ESTRATO', 'CO_ESTRATO',
  byName(['estrato(_?(socioecon[oó]mico|vivienda|residencia))?|estr|nivel_?socioecon[oó]mico|stratum', 0.9]),
  byList([['co-detectar-estratos.txt', ['1', '2', '3', '4', '5', '6', 'estrato 1', 'estrato 2', 'estrato 3', 'estrato 4', 'estrato 5', 'estrato 6'], 0.4]], { reject: 0.4 }))

// Sisbén IV: group A (extreme poverty, A1–A5), B (moderate poverty, B1–B7), C (vulnerable, C1–C18),
// D (neither poor nor vulnerable, D1–D21). The letter stays, the subgroup changes within its group.
const range = (n) => Array.from({ length: n }, (_, i) => String(i + 1))
decompose('CO_SISBEN', [
  [String.raw`(?i)(A\s?)([1-5])`, keep, apply(lookup('CO_SISBEN_A', 'co-sisben-a.txt', range(5)))],
  [String.raw`(?i)(B\s?)([1-7])`, keep, apply(lookup('CO_SISBEN_B', 'co-sisben-b.txt', range(7)))],
  [String.raw`(?i)(C\s?)(1[0-8]|[1-9])`, keep, apply(lookup('CO_SISBEN_C', 'co-sisben-c.txt', range(18)))],
  [String.raw`(?i)(D\s?)(2[01]|1\d|[1-9])`, keep, apply(lookup('CO_SISBEN_D', 'co-sisben-d.txt', range(21)))],
  // A Sisbén III score, 0 to 100 with decimals.
  [String.raw`(\d{1,3})([.,]\d+)?`, DIGITS, keep],
], apply(lookup('CO_SISBEN_GRUPO', 'co-sisben-grupos.txt', ['Pobreza extrema', 'Pobreza moderada', 'Vulnerable', 'No pobre, no vulnerable'], undefined, 'PRESERVE_LOOKUP_FILE')), 'B4')
domain('CO_FIN_SISBEN', 'CO_SISBEN',
  byName(['sisb[eé]n(_?(iv|4|iii|grupo|puntaje|clasificaci[oó]n|nivel|categor[ií]a))?|grupo_?sisb[eé]n|puntaje_?sisb[eé]n|clasificaci[oó]n_?sisb[eé]n|nivel_?sisb[eé]n|ficha_?sisb[eé]n', 0.95]),
  byPattern([[String.raw`[A-D]\s?\d{1,2}`, 0.5]], { reject: 0.3 }))

// Social programmes of Prosperidad Social and the housing subsidies. Being a beneficiary tells about
// income.
const PROGRAMMES = ['Renta Ciudadana', 'Renta Joven', 'Colombia Mayor', 'Devolución del IVA', 'Mi Casa Ya', 'Subsidio familiar de vivienda', 'Subsidio de desempleo', 'Ninguno']
categorical('CO_PROGRAMA_SOCIAL', 'co-programas-sociales.txt', PROGRAMMES, 'Familias en Acción')
domain('CO_FIN_PROGRAMA_SOCIAL', 'CO_PROGRAMA_SOCIAL',
  byName(['programa_?(social|beneficiario|de_?gobierno|prosperidad)|beneficiario_?(programa|subsidio|renta|familias|colombia_?mayor)|renta_?(ciudadana|joven|b[aá]sica)|familias_?en_?acci[oó]n|j[oó]venes_?en_?acci[oó]n|colombia_?mayor|ingreso_?solidario|devoluci[oó]n_?(del_?)?iva|subsidio(_?(familiar|vivienda|desempleo|tipo))?|mi_?casa_?ya|transferencia_?monetaria|social_?programme', 0.9]),
  byList([['co-detectar-programas-sociales.txt', [...PROGRAMMES, 'familias en acción', 'jóvenes en acción', 'ingreso solidario', 'renta ciudadana', 'colombia mayor', 'devolución iva', 'mi casa ya', 'ninguno'], 0.8],
    ['co-detectar-codigos-banderas.txt', ['s', 'n', 'sí', 'no', '1', '2', '3', '4', '5', '6'], 0.3],
  ], { reject: 0.4 }))

const TENURES = ['Propia, totalmente pagada', 'Propia, la están pagando', 'En arriendo o subarriendo', 'En usufructo', 'Posesión sin título', 'Propiedad colectiva', 'Otra']
categorical('CO_TENENCIA_VIVIENDA', 'co-tenencia-vivienda.txt', TENURES, 'Invasión')
domain('CO_FIN_VIVIENDA', 'CO_TENENCIA_VIVIENDA',
  byName(['tenencia_?(de_?)?(la_?)?vivienda|tipo_?(de_?)?tenencia|vivienda_?(propia|arrendada|tipo_?tenencia)|condici[oó]n_?(de_?)?(la_?)?vivienda|ocupaci[oó]n_?vivienda|housing_?tenure', 0.9]),
  byList([['co-detectar-tenencia-vivienda.txt', [...TENURES, 'propia', 'arriendo', 'arrendada', 'familiar', 'usufructo', 'invasión', 'posesión', 'colectiva'], 0.6]], { reject: 0.3 }))

// ── PENAL · Criminal records and proceedings ────────────────────────────────

categorical('CO_ANTECEDENTES', 'co-antecedentes.txt', ['No tiene asuntos pendientes con las autoridades judiciales', 'Registra antecedentes', 'Imputado', 'Acusado', 'Condenado', 'Absuelto', 'Preclusión', 'Sin información'], 'Condenado por hurto en 2019')
domain('CO_PENAL_ANTECEDENTES', 'CO_ANTECEDENTES',
  byName(
    ['antecedentes?(_?(judiciales|penales|disciplinarios|fiscales))?|certificado_?(de_?)?antecedentes|medidas_?correctivas|rnmc|registro_?nacional_?(de_?)?medidas_?correctivas|condena(_?(penal|tipo))?|delito(_?(tipo|cometido))?|tipo_?(de_?)?delito|conducta_?punible|situaci[oó]n_?jur[ií]dica|medida_?(de_?)?aseguramiento|detenci[oó]n_?domiciliaria|privad[oa]_?(de_?)?(la_?)?libertad|recluso|interno_?inpec|td_?inpec|reincidente|orden_?(de_?)?captura|inhabilidad(es)?|sanciones_?disciplinarias|criminal_?record', 0.95],
    ['estado_?(del_?)?proceso|sentido_?(del_?)?fallo|fallo', 0.55],
  ))

// Judicial file number of the Rama Judicial, 23 digits: DIVIPOLA code (5), court corporation (2),
// specialty (2), office (3), year (4), consecutive (5) and appeal (2). The consecutive is masked; the
// office and the year stay. SPOA criminal news numbers (21 digits) are masked digit by digit.
decompose('CO_RADICADO', [
  [String.raw`(\d{5}[\s\-]?\d{2}[\s\-]?\d{2}[\s\-]?\d{3}[\s\-]?\d{4}[\s\-]?)(\d{5})([\s\-]?\d{2})`, keep, DIGITS, keep],
], CM, '11001310300120200012300')
domain('CO_PENAL_RADICADO', 'CO_RADICADO',
  byName(
    ['n(o|ro|um|umero)_?(de_?)?(radicado|radicaci[oó]n|proceso|expediente|noticia_?criminal|spoa|cui|denuncia|tutela|acci[oó]n_?de_?tutela)(_?(judicial|penal))?|radicado_?(judicial|proceso|penal|tutela)?|radicaci[oó]n_?proceso|c[oó]digo_?[uú]nico_?(de_?)?investigaci[oó]n|cui|spoa|noticia_?criminal', 0.9],
    ['proceso|expediente', 0.5],
  ),
  byPattern([[String.raw`\d{23}`, 0.8], [String.raw`\d{21}`, 0.5]], { reject: 0.3 }))

// ── Preset ──────────────────────────────────────────────────────────────────

const referenced = JSON.stringify([domains, algorithms.map((x) => x.config)])
const orphans = algorithms.filter((a) => !referenced.includes(`"${a.name}"`))
if (orphans.length) throw new Error(`algorithms nobody uses: ${orphans.map((a) => a.name).join(', ')}`)
const noInput = algorithms.filter((a) => a.input === undefined)
if (noInput.length) throw new Error(`algorithms without a sample input: ${noInput.map((a) => a.name).join(', ')}`)

// The essential pack: identity documents, names, contact, address and birth date. Loading it brings
// these domains and only what they lean on; the extended pack is everything.
const ESSENTIAL = [
  'CO_L1_CEDULA', 'CO_L1_NIT', 'CO_L1_DOCUMENTO_EXTRANJERO', 'CO_L1_PASAPORTE',
  'CO_L1_NOMBRE', 'CO_L1_APELLIDO', 'CO_L1_NOMBRE_COMPLETO', 'CO_L1_EMAIL', 'CO_L1_TELEFONO',
  'CO_L1_DIRECCION', 'CO_L1_DIRECCION_COMPLEMENTO', 'CO_L2_FECHA_NACIMIENTO',
]
const notDomains = ESSENTIAL.filter((name) => !domains.some((d) => d.name === name))
if (notDomains.length) throw new Error(`essential pack names domains the set does not have: ${notDomains.join(', ')}`)

const VERSION = 1
const preset = {
  version: VERSION,
  name: {
    en: 'Colombia — Ley 1581 de 2012 (personal data protection)',
    'pt-BR': 'Colômbia — Ley 1581 de 2012 (proteção de dados pessoais)',
    es: 'Colombia — Ley 1581 de 2012 (protección de datos personales)',
  },
  summary: {
    en: 'Discovers and masks Colombian personal data under Statutory Law 1581 of 2012: direct identifiers (cédula, NIT with a valid check digit, foreigner documents, names, contact, address, Bre-B key), quasi-identifiers (birth date, municipality, postal code), the sensitive data of article 5 — ethnic origin, politics, religion, trade unions, social organizations, health, sexual life, biometric data — victims of the armed conflict, and financial data under Law 1266 of 2008 (stratum, Sisbén, credit reports) and criminal records.',
    'pt-BR': 'Descobre e mascara dados pessoais colombianos segundo a Lei Estatutária 1581 de 2012: identificadores diretos (cédula, NIT com dígito verificador válido, documentos de estrangeiros, nomes, contato, endereço, chave Bre-B), quase-identificadores (data de nascimento, município, código postal), os dados sensíveis do artigo 5 — origem étnica, política, religião, sindicatos, organizações sociais, saúde, vida sexual, dados biométricos —, vítimas do conflito armado, dados financeiros da Lei 1266 de 2008 (estrato, Sisbén, centrais de risco) e antecedentes criminais.',
    es: 'Descubre y enmascara datos personales colombianos conforme a la Ley Estatutaria 1581 de 2012: identificadores directos (cédula, NIT con dígito de verificación válido, documentos de extranjeros, nombres, contacto, dirección, llave Bre-B), cuasi-identificadores (fecha de nacimiento, municipio, código postal), los datos sensibles del artículo 5 — origen étnico, política, religión, sindicatos, organizaciones sociales, salud, vida sexual, datos biométricos —, víctimas del conflicto armado, datos financieros de la Ley 1266 de 2008 (estrato, Sisbén, centrales de riesgo) y antecedentes penales.',
  },
  profileSet: {
    name: `CO - Ley 1581 de 2012 - v${VERSION}`,
    description: 'Identificadores directos, cuasi-identificadores, datos sensibles (art. 5), víctimas del conflicto armado, datos de salud, datos financieros (Ley 1266 de 2008) y antecedentes penales, conforme a la Ley Estatutaria 1581 de 2012 de protección de datos personales.',
    threshold: 60,
    classifiers: classifiers.map((c) => c.name),
  },
  packs: {
    essential: {
      description: 'Paquete esencial de la Ley 1581 de 2012: cédula, NIT, documentos de extranjeros, pasaporte, nombres, contacto, dirección y fecha de nacimiento.',
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
console.log(`municipalities: ${small.length} of ${MUNICIPALITIES.length} under ${SMALL_MUNICIPALITY}, ${municipalityPairs.length} names generalized, ${generalized.size} table lines`)
