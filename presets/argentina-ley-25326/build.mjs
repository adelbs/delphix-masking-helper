#!/usr/bin/env node
/**
 * Builds the Argentina (Ley 25.326 de Protección de los Datos Personales) pre-configured profile set:
 * preset.json and files/.
 *
 *   node presets/argentina-ley-25326/build.mjs
 *
 * source/ holds the hand-kept lists — given names (RENAPER), surnames, neighbourhoods — and the
 * geography of the 2022 census: the 528 departamentos and partidos and the 2,280 gobiernos locales
 * with their population, and the 4,027 localidades censales of the INDEC, all located with the
 * Georef service. Everything in files/ and preset.json is generated from them and from the
 * definitions below — edit here, then build, then run verify.mjs.
 *
 * Structure of the set
 *   L1     direct identifiers      DNI, CUIT and CUIL with a valid check digit, foreigner documents,
 *                                  names, contact, address, CBU and CVU with valid check digits,
 *                                  vehicles, property, company names (art. 2 covers legal persons)
 *   L2     quasi-identifiers       birth date, age, sex, localidad, partido or departamento,
 *                                  postal code, neighbourhood…
 *   L3     sensitive data          art. 2 and 7: racial and ethnic origin, political opinions,
 *                                  religious, philosophical or moral convictions, trade unions,
 *                                  sexual life — and genetic and biometric data (Convenio 108+),
 *                                  gender identity (Ley 26.743), victims of gender violence
 *   SALUD  health data             art. 8: health identifiers, coverage, ICD-10, HIV, mental,
 *                                  reproductive health, disability certificate…
 *   FIN    financial data          art. 26: BCRA debtor situation, income, assets, social
 *                                  programmes, monotributo category
 *   PENAL  criminal records        art. 7.4: records and court file numbers
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
  description: 'Nombre de la columna (y variantes usadas en sistemas argentinos).',
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

const DEPARTAMENTOS = readLines('departamentos.tsv').map((line) => {
  const [code, name, provinceCode, province, lat, lon, population, aliases] = line.split('\t')
  return { code, name, provinceCode, province, lat: Number(lat), lon: Number(lon), population: Number(population), aliases: aliases ? aliases.split('|') : [] }
})
const GOBIERNOS = readLines('gobiernos-locales.tsv').map((line) => {
  const [code, name, category, provinceCode, province, lat, lon, population, aliases] = line.split('\t')
  return { code, name, category, provinceCode, province, lat: Number(lat), lon: Number(lon), population: Number(population), aliases: aliases ? aliases.split('|') : [] }
})
const LOCALIDADES = readLines('localidades.tsv').map((line) => {
  const [code, name, provinceCode, departmentCode, localGovernment, lat, lon] = line.split('\t')
  return { code, name, provinceCode, departmentCode, localGovernment, lat: Number(lat), lon: Number(lon) }
})
if (DEPARTAMENTOS.length !== 528) throw new Error(`expected the 528 departamentos, partidos and comunas of the 2022 census, found ${DEPARTAMENTOS.length}`)
if (GOBIERNOS.length !== 2280) throw new Error(`expected the 2,280 gobiernos locales of the 2022 census, found ${GOBIERNOS.length}`)
if (LOCALIDADES.length !== 4027) throw new Error(`expected the 4,027 localidades censales, found ${LOCALIDADES.length}`)
for (const d of DEPARTAMENTOS) if (!/^\d{5}$/.test(d.code) || d.code.slice(0, 2) !== d.provinceCode || Number.isNaN(d.lat)) throw new Error(`${d.name}: bad code or location`)
for (const g of GOBIERNOS) if (!/^\d{6}$/.test(g.code) || g.code.slice(0, 2) !== g.provinceCode || Number.isNaN(g.lat)) throw new Error(`${g.name}: bad code or location`)
for (const l of LOCALIDADES) if (!/^\d{8}$/.test(l.code) || l.code.slice(0, 2) !== l.provinceCode || Number.isNaN(l.lat)) throw new Error(`${l.name}: bad code or location`)
const PROVINCES = unique(DEPARTAMENTOS.map((d) => d.province))

// ── Shared algorithms ───────────────────────────────────────────────────────

// Vowels map to vowels and consonants to consonants, so a masked document number keeps its
// structure; digits map to digits. Separators are in no group and stay. minMaskedPositions 0 lets
// a placeholder such as "S/D" through instead of failing the row.
algorithm('AR_CM_ALFANUM', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'AEIOU', 'BCDFGHJKLMNPQRSTVWXYZ', 'aeiou', 'bcdfghjklmnpqrstvwxyz', 'ÁÉÍÓÚÜ', 'áéíóúü'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, 'AAA123456')
// Digits only: the dots of a DNI, the letters of a file number stay.
algorithm('AR_CM_DIGITOS', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '28.456.789')
// Digits and upper-case letters, one group each: a plate stays a plate.
algorithm('AR_CM_DIGITOS_LETRAS', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, 'AE 123 KD')
// Hex letters form their own group, so a MAC, UUID or IPv6 stays valid hex.
algorithm('AR_CM_HEX', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'abcdef', 'ABCDEF', 'ghijklmnopqrstuvwxyz', 'GHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '3c:22:fb:9a:10:e4')
decompose('AR_REDACTAR', [['(.+)', { type: 'REDACT', redactCharacter: 'X' }]], keep, 'clave123')
lookup('AR_SUPRIMIR', 'ar-sin-informacion.txt', ['Sin información'], 'Trastorno depresivo recurrente', 'PRESERVE_LOOKUP_FILE')

// Yes/no columns keep their vocabulary: a CHAR(1) S/N stays S/N.
decompose('AR_BANDERA', [
  [String.raw`(?i)(s[ií]|no)`, apply(lookup('AR_BANDERA_SI_NO', 'ar-bandera-si-no.txt', ['Sí', 'No']))],
  ['(?i)(true|false)', apply(lookup('AR_BANDERA_TRUE_FALSE', 'ar-bandera-true-false.txt', ['true', 'false']))],
  ['(?i)(yes)', apply(lookup('AR_BANDERA_YES_NO', 'ar-bandera-yes-no.txt', ['Yes', 'No']))],
  ['(?i)([sn])', apply(lookup('AR_BANDERA_S_N', 'ar-bandera-s-n.txt', ['S', 'N']))],
  ['(?i)([yx])', apply(lookup('AR_BANDERA_Y_N', 'ar-bandera-y-n.txt', ['Y', 'N']))],
  ['([01])', apply(lookup('AR_BANDERA_0_1', 'ar-bandera-0-1.txt', ['0', '1']))],
], keep, 'S')

const FLAG = String.raw`(?i)(s[ií]|no|true|false|yes|[snyx01])`
/**
 * A categorical attribute: flags stay flags, numeric codes are replaced by another code of `codes`
 * (or get other digits), and any other value is replaced by one from `values` — or suppressed, when
 * no list is given.
 */
function categorical(name, fileName, values, input, codes) {
  const replacement = values ? lookup(`${name}_LISTA`, fileName, values) : 'AR_SUPRIMIR'
  const code = codes ? apply(lookup(`${name}_CODIGO`, fileName.replace(/\.txt$/, '-codigos.txt'), codes)) : apply('AR_CM_ALFANUM')
  return decompose(name, [[FLAG, apply('AR_BANDERA')], [String.raw`(\d{1,6})`, code]], apply(replacement), input)
}
categorical('AR_CATEGORIA_SUPRIMIDA', null, null, 'Trastorno depresivo recurrente')
const CM = apply('AR_CM_ALFANUM')
const DIGITS = apply('AR_CM_DIGITOS')

// ── L1 · DNI, CUIT and CUIL ─────────────────────────────────────────────────
//
// The DNI of the RENAPER has no check digit: seven or eight digits, written with thousands dots,
// the same number for life (and the number of the older Libreta de Enrolamiento and Libreta Cívica).
// Foreign residents get DNIs from 90 million up. It is masked digit by digit, dots kept, one-to-one.
//
// CUIT (AFIP, now ARCA) and CUIL (ANSES) share one format: a two-digit type — 20 man, 27 woman, 23
// and 24 either, 30, 33 and 34 legal persons — eight digits, the DNI for a natural person, and a
// check digit: weights 5 4 3 2 7 6 5 4 3 2 from the left, modulus 11, digit 11 − r, 0 when r is 0.
// When r is 1 there is no digit: the type changes instead — 20 and 27 become 23 (digit 9 and 4), 30
// becomes 33 (9), 23 becomes 24 and 33 becomes 34 (6). Check Digit writes 11 − r and 10 as 0, so
// each CUIT goes through two steps:
//   1. Check Digit with doubled weights keeps the type, masks the eight digits like the DNI and
//      writes an auxiliary digit, which is 9 exactly when the remainder of the masked body is 1;
//   2. a Regex Decompose rewrites type and digit when the auxiliary digit is 9, and otherwise
//      recomputes the digit with the true weights over the body it leaves as it is.
// A natural person's masked CUIT still carries their masked DNI.
const CUIT_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
decompose('AR_IDENTIDAD', [['(.*)', keep]], keep, '20284567891')
decompose('AR_CUIT_CUERPO', [[String.raw`(\d{2})(\d{8})`, keep, DIGITS]], DIGITS, '2028456789')
function cuitCheck(name, weights, body, input) {
  return algorithm(name, 'checkdigit.Checkdigit', {
    // Check Digit applies the weights from the right.
    weightList: [...weights].reverse(), modulusNumber: 11,
    checkDigitIndex: 10, numDigitsForCheckdigitCalculation: 10,
    calculateChecksumRightToLeft: true,
    numericAlgorithm: use(body), alphaNumericAlgorithm: use(body),
    preserveRegex: String.raw`[.\-\s/]`,
    inputHandlingConfig: { characterHandling: 'STANDARD', invalidInputHandling: 'ERROR', shortInputHandling: 'FALLBACK', padCharacter: '0', trimWhitespace: true },
  }, input)
}
cuitCheck('AR_CUIT_AUX', CUIT_WEIGHTS.map((w) => 2 * w), 'AR_CUIT_CUERPO', '20-28456789-0')
cuitCheck('AR_CUIT_DV', CUIT_WEIGHTS, 'AR_IDENTIDAD', '20-28456789-0')
const CUIT_MIDDLE = String.raw`([\s\-./]?\d{8}[\s\-./]?)`
decompose('AR_CUIT_AJUSTE', [
  [`(20)${CUIT_MIDDLE}(9)`, redactAs('23'), keep, redactAs('9')],
  [`(27)${CUIT_MIDDLE}(9)`, redactAs('23'), keep, redactAs('4')],
  [`(23)${CUIT_MIDDLE}(9)`, redactAs('24'), keep, redactAs('6')],
  [`(24)${CUIT_MIDDLE}(9)`, redactAs('23'), keep, redactAs('3')],
  [`(30)${CUIT_MIDDLE}(9)`, redactAs('33'), keep, redactAs('9')],
  [`(33)${CUIT_MIDDLE}(9)`, redactAs('34'), keep, redactAs('6')],
  [`(34)${CUIT_MIDDLE}(9)`, redactAs('33'), keep, redactAs('3')],
], apply('AR_CUIT_DV'), '20-28456789-0')
chain('AR_CUIT_CADENA', ['AR_CUIT_AUX', 'AR_CUIT_AJUSTE'], '20-28456789-1')
const CUIT_SHAPE = String.raw`(\d{2}[\s\-./]?\d{8}[\s\-./]?\d)`
decompose('AR_CUIT', [[CUIT_SHAPE, apply('AR_CUIT_CADENA')]], DIGITS, '20-28456789-1')

// A document column holds DNIs, CUITs and CUILs, and passports: each value goes by its shape.
decompose('AR_DOCUMENTO', [
  [CUIT_SHAPE, apply('AR_CUIT_CADENA')],
  [String.raw`(\d{1,3}(?:\.\d{3}){1,2}|\d{6,8})`, DIGITS],
], CM, '28.456.789')

const DOC_OWNER = 'cliente|cli|paciente|pac|usuario|afiliado|asegurado|beneficiario|benef|titular|empleado|emp|agente|trabajador|contratado|alumno|estudiante|deudor|codeudor|garante|fiador|tomador|propietario|inquilino|locatario|locador|conductor|tutor|responsable|representante|apoderado|persona|ciudadano|votante|elector|contribuyente|proveedor|socio|conyuge|padre|madre|hijo|familiar|jubilado|pensionado'
domain('AR_L1_DNI', 'AR_DOCUMENTO',
  byName(
    [`dni|d_n_i|n(o|ro|um|umero)_?(de_?)?(doc|documento|dni|le|lc)|documento_?(nacional|de_?identidad|identidad)|doc_?(identidad|nro|num|numero)|nro_?doc|numdoc|nrodoc|libreta_?(de_?)?(enrolamiento|c[ií]vica)|(${DOC_OWNER})_?(dni|doc|documento|nro_?doc)|dni_?(${DOC_OWNER})|c[eé]dula(_?(de_?)?identidad)?`, 0.9],
    ['documento|doc|tipo_?y_?n(ro|umero)_?(de_?)?doc', 0.6],
  ),
  byType(STRING(6), NUMBER(6)),
  byPattern([
    [String.raw`\d{1,2}\.\d{3}\.\d{3}`, 0.8],
    [String.raw`[1-9]\d{6,7}`, 0.4],
  ], { reject: 0.3 }))

domain('AR_L1_CUIT', 'AR_CUIT',
  byName([`cuit[a-z0-9_]*|cuil[a-z0-9_]*|cdi|n(o|ro|um|umero)_?(de_?)?(cuit|cuil|cdi)|clave_?[uú]nica_?(de_?)?(identificaci[oó]n_?)?(tributaria|laboral)|(${DOC_OWNER})_?(cuit|cuil)|id_?(tributario|fiscal)|identificaci[oó]n_?(tributaria|fiscal)|nro_?afip|tax_?id`, 0.9]),
  byPattern([
    [String.raw`(20|2[347]|3[034])-\d{8}-\d`, 0.95],
    [String.raw`(20|2[347]|3[034])\d{9}`, 0.6],
  ], { reject: 0.3 }))

// ── L1 · Other identity documents ───────────────────────────────────────────

// The DNI's tramit number (número de trámite, eleven digits) and copy letter are printed on the
// card and asked by online services to prove the card is in the holder's hands.
domain('AR_L1_TRAMITE_DNI', 'AR_CM_ALFANUM',
  byName(['n(o|ro|um|umero)_?(de_?)?tr[aá]mite(_?dni)?|tramite_?dni|id_?tr[aá]mite|ejemplar(_?dni)?|n(ro|umero)_?ejemplar', 0.85]),
  byPattern([[String.raw`00\d{9}`, 0.5]], { reject: 0.3 }))

// Foreigners: the residence certificate and the precarious residence of the Dirección Nacional de
// Migraciones, the foreign identity card, the visa.
domain('AR_L1_DOCUMENTO_EXTRANJERO', 'AR_CM_ALFANUM',
  byName(['residencia_?precaria|certificado_?(de_?)?residencia|radicaci[oó]n(_?(n(o|ro|um|umero)|expediente))?|expediente_?migratorio|documento_?extranjero|doc_?extranjero|c[eé]dula_?extranjera|n(o|ro|um|umero)_?(visa|residencia)|visa(_?(n(o|ro|um|umero)))?|dnm_?(expediente|n(ro|umero))', 0.85]))

domain('AR_L1_PASAPORTE', 'AR_CM_ALFANUM',
  byName(['pasaporte[a-z0-9_]*|n(o|ro|um|umero)_?pasaporte|passport[a-z0-9_]*', 0.9]),
  byPattern([[String.raw`[A-Z]{3}\d{6}`, 0.4]], { reject: 0.3 }))

// Civil registry: the birth, marriage and death certificates (acta, tomo, folio).
domain('AR_L1_REGISTRO_CIVIL', 'AR_CM_ALFANUM',
  byName(['acta_?(de_?)?(nacimiento|matrimonio|defunci[oó]n|uni[oó]n_?convivencial)(_?(n(o|ro|um|umero)|tomo|folio))?|n(o|ro|um|umero)_?acta|partida_?(de_?)?(nacimiento|defunci[oó]n|matrimonio)|certificado_?(de_?)?(nacimiento|defunci[oó]n|hecho_?vital)|tomo_?(acta|partida)|folio_?(acta|partida)', 0.85]))

// Professional registrations (matrícula nacional MN, provincial MP): public registers that name the person.
domain('AR_L1_MATRICULA_PROFESIONAL', 'AR_CM_ALFANUM',
  byName(['matr[ií]cula(_?(profesional|nacional|provincial|m[eé]dica|colegio))?|mat_?(prof|nac|prov)|m_?n|m_?p|n(o|ro|um|umero)_?matr[ií]cula|refeps|registro_?profesional', 0.8]))

// ── L1 · Names ──────────────────────────────────────────────────────────────

const NOT_A_PERSON = 'producto|prod|item|articulo|empresa|emp|razon|social|fantasia|comercial|archivo|calle|via|barrio|localidad|municipio|ciudad|partido|departamento|depto|dpto|provincia|pais|banco|sucursal|plan|campana|proyecto|servicio|tabla|columna|campo|usuario|host|servidor|dominio|marca|modelo|categoria|tipo|colegio|escuela|establecimiento|institucion|curso|materia|documento|doc|centro|unidad|clinica|hospital|sanatorio|obra|prepaga|area|dependencia|reparticion|cargo|sistema|app|aplicacion|grupo|lista|reporte|informe|proceso|evento|tarea|perfil|rol|clase|objeto|cuenta|medicamento|diagnostico|estudio|programa|beneficio|sindicato|gremio|religion|pueblo|lengua|lugar|sede|local|tienda|deposito|proveedor|convenio|contrato|poliza|seguro|aseguradora|entidad|organismo|organizacion|parametro|variable|metodo|funcion|indice|job|script|cola|recurso|red|dispositivo|plantilla|imagen|foto|pagina|sitio|modulo|menu|opcion|accion|permiso|concepto|impuesto|moneda|emisor|factura|comprobante|pago|forma|zona|ruta|linea|actividad|rubro|sector|file|table|column|field|user|server|product|company|category|type|school|document|department|system|group|report|role|account|place|store|supplier|contract|device|image|page|module|action|key|label|code|project|city|country|street|bank'
const PERSON_ROLE = 'cliente|cli|paciente|pac|usuario|afiliado|asegurado|beneficiario|benef|titular|empleado|agente|trabajador|contratado|alumno|estudiante|deudor|codeudor|garante|fiador|tomador|propietario|inquilino|locatario|locador|conductor|tutor|responsable|representante|apoderado|persona|ciudadano|contribuyente|madre|padre|conyuge|concubino|conviviente|contacto|referencia|victima|denunciante|denunciado|imputado|procesado|testigo|medico|docente|socio|heredero|causante|donante|curador|jubilado|pensionado|customer|patient|employee|member|holder|mother|father|spouse|contact|person|student|driver|owner'
const PARTICLES = String.raw`(?i)(de|del|la|las|los|y|e|san|santa|van|von|di|da|dos)`

algorithm('AR_NOMBRE', 'name.Name', {
  lookupFile: { uri: file('ar-nombres.txt', GIVEN_NAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Soledad')
algorithm('AR_APELLIDO', 'name.Name', {
  lookupFile: { uri: file('ar-apellidos.txt', SURNAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Fernández')
// A word of a name. "de", "del", "la" stay where they are: "María del Carmen", "Ana López de Rossi".
decompose('AR_PALABRA_NOMBRE', [[PARTICLES, keep]], apply('AR_NOMBRE'), 'Carmen')
decompose('AR_PALABRA_APELLIDO', [[PARTICLES, keep]], apply('AR_APELLIDO'), 'Rossi')
const N = apply('AR_PALABRA_NOMBRE')
const S = apply('AR_PALABRA_APELLIDO')

decompose('AR_NOMBRES', [
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, N],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, N, N],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, N, N],
], CM, 'María del Carmen')
decompose('AR_APELLIDOS', [
  [String.raw`(\S+)`, S],
  [String.raw`(\S+)\s+(\S+)`, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, S, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, S, S, S, S],
], CM, 'López de Rossi')
// Argentine order: given names, then the surname — usually one, the father's, sometimes both. Two
// words are a given name and a surname; three, two given names and a surname ("Juan Carlos Pérez");
// four, two and two; five, three and two. APELLIDO, NOMBRES with a comma, as in lists and in the
// padrón.
decompose('AR_NOMBRE_COMPLETO', [
  [String.raw`([^,]+),\s*(.+)`, apply('AR_APELLIDOS'), apply('AR_NOMBRES')],
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, N, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, N, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, N, S, S, S],
], CM, 'Juan Carlos Fernández')
const NAME_WORDS = ['de', 'del', 'la', 'las', 'los', 'y']

domain('AR_L1_NOMBRE', 'AR_NOMBRES',
  byName(
    ['primer_?nombre|segundo_?nombre|nombres?_?(de_?)?pila|pri(mer)?_?nom|seg(undo)?_?nom|nombre_?1|nombre_?2|first_?names?|given_?names?|fname|middle_?names?|nombres(?!_?(completos?|y_?apellidos?|apellidos?))', 0.85],
    [`nombre(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|apellidos?|usuario|corto|largo))|nom(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}))|name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))`, 0.5],
  ),
  byList([['ar-detectar-nombres.txt', [...GIVEN_NAMES, ...NAME_WORDS], 0.7]], { tokenize: true, reject: 0.3 }))

domain('AR_L1_APELLIDO', 'AR_APELLIDOS',
  byName(['apellidos?|primer_?apellido|segundo_?apellido|apellido_?(1|2|paterno|materno|casada)|ape_?(1|2)|last_?names?|surnames?|family_?names?|lname', 0.85]),
  byList([['ar-detectar-apellidos.txt', [...SURNAMES, ...NAME_WORDS], 0.7]], { tokenize: true, reject: 0.3 }))

domain('AR_L1_NOMBRE_COMPLETO', 'AR_NOMBRE_COMPLETO',
  byName(
    [`nombres?_?(completos?|y_?apellidos?|apellidos?)|apellidos?_?(y_?)?nombres?|ape_?nom|apeynom|apynom|apenom|ayn|nombre_?(del_?|de_?la_?)?(${PERSON_ROLE})|(${PERSON_ROLE})_?(nombre|nom|apynom)|nom_?(${PERSON_ROLE})|nombre_?(madre|padre|tutor|conyuge|contacto_?emergencia|referencia)|full_?name|person_?name`, 0.9],
    ['madre|padre|tutor|conyuge|conviviente|concubin[oa]|representante_?legal|apoderado|garante|fiador|beneficiario|heredero|titular|referencia_?(personal|familiar)', 0.6],
    // A bare NOMBRE holds a given name or a full name: the values decide between the two domains.
    [`nombre(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|apellidos?|usuario|corto|largo))|nom(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}))|name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))`, 0.5],
  ),
  byList([['ar-detectar-nombres.txt', [...GIVEN_NAMES, ...NAME_WORDS], 0.6], ['ar-detectar-apellidos.txt', [...SURNAMES, ...NAME_WORDS], 0.6]], { tokenize: true, reject: 0.3 }))

// Legal persons are data subjects too (art. 2: "personas físicas o de existencia ideal"): a company
// or trade name becomes a fictitious one.
const COMPANIES = ['Comercializadora del Plata S.A.', 'Construcciones Andinas S.R.L.', 'Transportes La Pampa S.A.', 'Supermercados El Hornero S.A.', 'Metalúrgica del Litoral S.R.L.', 'Clínica San Lucas S.A.', 'Instituto Nuevo Horizonte S.R.L.', 'Servicios Integrales del Sur S.A.', 'Agropecuaria Los Caldenes S.A.', 'Distribuidora La Cumbre S.R.L.', 'Soluciones Digitales Pampeanas S.A.S.', 'Parrilla Don Ceferino S.R.L.', 'Hotel Mirador del Lago S.A.', 'Laboratorio Vida Sana S.A.', 'Seguridad Atalaya S.R.L.', 'Textil La Aguja S.A.', 'Autopartes del Oeste S.R.L.', 'Farmacia El Buen Vecino S.C.S.', 'Logística Puerto Nuevo S.A.', 'Cooperativa Agrícola La Unión Ltda.', 'Fundación Manos Unidas', 'Panificadora Pan de Campo S.R.L.', 'Estudio Contable Asociados S.R.L.', 'Bodega Valle Escondido S.A.']
lookup('AR_EMPRESA', 'ar-empresas.txt', COMPANIES, 'Arcos Dorados Argentina S.A.', 'PRESERVE_LOOKUP_FILE')
domain('AR_L1_RAZON_SOCIAL', 'AR_EMPRESA',
  byName(['raz[oó]n_?social|denominaci[oó]n_?social|nombre_?(de_?)?fantas[ií]a|nombre_?(empresa|comercio|proveedor|sociedad|persona_?jur[ií]dica|comercial)|(empresa|proveedor|sociedad)_?(nombre|razon_?social)|legal_?name|company_?name|business_?name|trade_?name', 0.85]),
  byPattern([[String.raw`.*\b(S\.?\s?A\.?(\s?S\.?)?|S\.?\s?R\.?\s?L\.?|S\.?\s?C\.?\s?S\.?|S\.?\s?A\.?\s?U\.?|Ltda\.?|Coop(erativa)?\.?)\s*$`, 0.8]], { reject: 0.3 }))

// ── L1 · Contact ────────────────────────────────────────────────────────────

decompose('AR_EMAIL', [
  // The top-level domain becomes .test, reserved for tests: a masked address can never deliver.
  [String.raw`([^@\s]+)@([^@\s]+)\.([A-Za-z]{2,24}(?:\.[A-Za-z]{2})?)`, CM, CM, redactAs('test')],
], CM, 'soledad.fernandez@hotmail.com.ar')
domain('AR_L1_EMAIL', 'AR_EMAIL',
  byName(['e_?mail[a-z0-9_]*|mail[a-z0-9_]*|correo(_?electr[oó]nico)?[a-z0-9_]*|dir_?correo|direcci[oó]n_?(de_?)?correo|direcci[oó]n_?electr[oó]nica', 0.85]),
  byType(STRING(5)),
  byPattern([[String.raw`[A-Za-z0-9._%+'\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}`, 1]], { reject: 0.2 }))

// Ten national digits: an area code of two to four digits (11 Buenos Aires, 351 Córdoba, 2966 Río
// Gallegos) and the subscriber number. Mobiles add 9 after the country code, or 15 after the area
// code when dialled at home. Country code, area code, 15 and the separators stay; the subscriber
// number is masked — at least six digits.
decompose('AR_TELEFONO', [
  [String.raw`(\+?54[\s\-]?(?:9[\s\-]?)?)?(\(?0?(?:11|[23]\d{1,3})\)?[\s\-]+)(15[\s\-]?)?(\d{2,4})([\s\-]?)(\d{4})`, keep, keep, keep, DIGITS, keep, DIGITS],
  [String.raw`(\+?54[\s\-]?(?:9[\s\-]?)?|0)?(11|[23]\d{2,3})(\d{6,8})`, keep, keep, DIGITS],
  // A local number written without its area code, with or without 15.
  [String.raw`(15[\s\-]?)?(\d{3,4})([\s\-]?)(\d{4})`, keep, DIGITS, keep, DIGITS],
], DIGITS, '+54 9 11 4567-8901')
domain('AR_L1_TELEFONO', 'AR_TELEFONO',
  byName(['tel|tel[eé]fono[a-z0-9_]*|tel_?(fijo|particular|laboral|m[oó]vil|celular|casa|oficina|contacto|alternativo)|celular[a-z0-9_]*|cel|m[oó]vil|whats_?app|n(o|ro|um|umero)_?(tel|tel[eé]fono|celular|cel|contacto|movil)|caracter[ií]stica_?tel|fax|phone[a-z0-9_]*|mobile[a-z0-9_]*', 0.85]),
  byPattern([
    [String.raw`(\+?54[\s\-]?9?[\s\-]?)?\(?0?(11|[23]\d{2,3})\)?[\s\-]?(15[\s\-]?)?\d{3,4}[\s\-]?\d{4}`, 0.9],
    [String.raw`(15[\s\-]?)?\d{4}-\d{4}`, 0.6],
  ], { reject: 0.3 }))

// Argentine addresses name the street and its height — "Av. Rivadavia 4520 Piso 3 Dto. B" — or,
// in La Plata and planned towns, a numbered street; in neighbourhoods and housing plans, block and
// lot. The whole line becomes a fictitious one.
const STREETS = ['San Martín', 'Belgrano', 'Rivadavia', 'Sarmiento', 'Mitre', 'Moreno', 'Urquiza', '9 de Julio', '25 de Mayo', 'Güemes', 'Alsina', 'Lavalle', 'Brown', 'Italia', 'España', 'Pellegrini', 'Roca', 'Alem', 'Hipólito Yrigoyen', 'Tucumán', 'Córdoba', 'Santa Fe', 'Corrientes', 'Entre Ríos', 'Mendoza', 'Saavedra', 'Dorrego', 'Colón', 'Maipú', 'Chacabuco', 'Las Heras', 'Pueyrredón', 'Laprida', 'Lamadrid', 'Castelli', 'Rodríguez Peña', 'Balcarce', 'Independencia', 'Libertad', 'Constitución', 'Francia', 'Juan B. Justo', 'Perón', 'Illia', 'Malvinas Argentinas', 'Los Aromos', 'Las Acacias', 'Los Sauces', 'Estrada', 'Paraguay', 'Uruguay', 'Chile', 'Bolivia', 'Catamarca', 'La Rioja', 'Jujuy', 'Salta', 'Misiones', 'Echeverría', 'Avellaneda', 'Almafuerte', 'Rawson', 'Ameghino', 'Newbery', 'Vélez Sarsfield', 'Arenales', 'Necochea', 'Suipacha', 'Ituzaingó', 'Pringles', 'Garibaldi']
lookup('AR_DIRECCION', 'ar-direcciones.txt', (() => {
  const random = seeded(25326)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const num = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
  const out = new Set()
  while (out.size < 4000) {
    const r = random()
    const street = `${random() < 0.2 ? 'Av. ' : ''}${pick(STREETS)} ${num(1, 60) * 50 + num(0, 49)}`
    if (r < 0.45) out.add(street)
    else if (r < 0.7) out.add(`${street} Piso ${num(1, 14)} Dto. ${pick(['A', 'B', 'C', 'D', 'E', 'F', '1', '2', '3', '4'])}`)
    else if (r < 0.78) out.add(`${street} PB ${pick(['A', 'B', 'C', '1', '2'])}`)
    else if (r < 0.88) out.add(`Calle ${num(1, 200)} N° ${num(100, 2999)}`)
    else if (r < 0.96) out.add(`Mz. ${num(1, 60)} Lote ${num(1, 40)}`)
    else out.add(`Ruta ${pick(['Provincial', 'Nacional'])} ${num(1, 100)} Km ${num(1, 400)}`)
  }
  return [...out]
})(), 'Av. Corrientes 1234 Piso 5 Dto. B', 'PRESERVE_LOOKUP_FILE')
domain('AR_L1_DIRECCION', 'AR_DIRECCION',
  byName(['(?<!(mac|ip|e_?mail|web|url|correo)_?)direcci[oó]n(?!_?(ip|mac|email|e_?mail|correo|electr[oó]nica|web|url|tipo|id|general|nacional|provincial|t[eé]cnica|regional))[a-z0-9_]*|domicilio(?!_?(fiscal_?electr[oó]nico|electr[oó]nico))[a-z0-9_]*|dom_?(real|legal|fiscal|particular|laboral|postal|cliente|paciente)|calle(_?y_?(n(ro|umero)|altura))?|residencia|lugar_?(de_?)?residencia|(?<!(mac|ip|e_?mail|web|url)_?)address(?!_?(ip|mac|email|e_?mail|web|url|type|id))[a-z0-9_]*', 0.8]),
  byType(STRING(6)),
  byPattern([
    [String.raw`(?i)(av|avda|avenida|bv|bvard|boulevard|diag|diagonal|pje|pasaje|calle)\.?\s+[a-záéíóúñü0-9.' ]{1,40}\s+(n[°º]\s*)?\d{1,5}.*`, 0.8],
    [String.raw`(?i)[a-záéíóúñü0-9.' ]{3,40}\s+(n[°º]\s*)?\d{1,5}\s*,?\s*(piso|p\.|pb|dto|depto|dpto|departamento)\b.*`, 0.8],
    [String.raw`(?i)[a-záéíóúñü.' ]{3,40}\s+\d{2,5}`, 0.4],
    [String.raw`(?i).*\b(mz|mza|manzana)\.?\s*\d+.*\b(lote|casa|lt)\.?\s*\d+.*`, 0.7],
  ], { reject: 0.2 }))

domain('AR_L1_DIRECCION_COMPLEMENTO', 'AR_CM_ALFANUM',
  byName(['piso|dto|depto|dpto|departamento_?(dom|domicilio|n(ro|umero))|unidad_?funcional|uf|torre|manzana|mz|mza|lote|casa_?(n(o|ro|um|umero))?|altura|n(ro|umero)_?(puerta|calle|domicilio)|puerta|entre_?calles?|monoblock|block|oficina|local', 0.7]))

// ── L1 · Banking and payments ───────────────────────────────────────────────

// CBU (bank accounts) and CVU (payment accounts), 22 digits in two blocks with a check digit each:
// bank and branch with weights 7 1 3 9 7 1 3, account with 3 9 7 1 3 9 7 1 3 9 7 1 3, digit
// (10 − sum mod 10) mod 10. The first block — the bank, or 000 and the payment provider — stays;
// the account is masked and its digit recomputed.
algorithm('AR_CBU_CUENTA', 'checkdigit.Checkdigit', {
  weightList: [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3].reverse(), modulusNumber: 10,
  checkDigitIndex: 13, numDigitsForCheckdigitCalculation: 13,
  calculateChecksumRightToLeft: true,
  numericAlgorithm: use('AR_CM_DIGITOS'), alphaNumericAlgorithm: use('AR_CM_DIGITOS'),
  preserveRegex: '',
  inputHandlingConfig: { characterHandling: 'STANDARD', invalidInputHandling: 'ERROR', shortInputHandling: 'FALLBACK', padCharacter: '0', trimWhitespace: true },
}, '40090418135201')
decompose('AR_CBU', [[String.raw`(\d{8})([\s\-]?)(\d{14})`, keep, keep, apply('AR_CBU_CUENTA')]], DIGITS, '2850590940090418135201')
domain('AR_L1_CBU', 'AR_CBU',
  byName(['cbu[a-z0-9_]*|cvu[a-z0-9_]*|clave_?bancaria_?uniforme|clave_?virtual_?uniforme|n(o|ro|um|umero)_?(cbu|cvu)|(cbu|cvu)_?(destino|origen|acreditaci[oó]n|cliente|proveedor)', 0.9]),
  byPattern([[String.raw`\d{8}[\s\-]?\d{14}`, 0.9]], { reject: 0.3 }))

// An alias CBU: six to twenty letters, digits, dots and hyphens — "gato.mesa.lluvia".
domain('AR_L1_ALIAS_CBU', 'AR_CM_ALFANUM',
  byName(['alias_?(cbu|cvu|bancario|cuenta|transferencia)|(cbu|cvu)_?alias', 0.9]),
  byPattern([[String.raw`[a-z0-9\-]{2,12}\.[a-z0-9\-]{2,12}\.[a-z0-9\-]{2,12}`, 0.5]], { reject: 0.3 }))

domain('AR_L1_CUENTA_BANCARIA', 'AR_CM_DIGITOS',
  byName(['cuenta_?(bancaria|banco|corriente|sueldo|haberes|acreditaci[oó]n|destino|origen)|caja_?(de_?)?ahorros?|n(o|ro|um|umero)_?(de_?)?(cuenta|cta)|nro_?cta|num_?cta|cta_?(cte|corriente|ahorro|bancaria|sueldo)|tipo_?y_?n(o|ro|um|umero)_?cuenta|iban|account_?(no|num|number)|bank_?account|billetera(_?virtual)?', 0.85]))

// Payment Card fails a row that has no digits to mask; only values shaped like a card reach it.
algorithm('AR_TARJETA_LUHN', 'characterMapping.PaymentCard', { minMaskedPositions: 6, preserve: 0 }, '4509953566233704')
decompose('AR_TARJETA', [[String.raw`(\d[\d\s\-]{11,22}\d)`, apply('AR_TARJETA_LUHN')]], keep, '4509 9535 6623 3704')
domain('AR_L1_TARJETA', 'AR_TARJETA',
  byName(['tarjeta(_?(cr[eé]dito|d[eé]bito|n(o|ro|um|umero)))?|n(o|ro|um|umero)_?tarjeta|pan|card_?(no|num|number)|credit_?card|tc_?(numero|num|nro)|td_?(numero|num|nro)', 0.85]),
  // 0.9, not 1: an IMEI is 15 Luhn-valid digits too, and its own column name should win.
  byPattern([[String.raw`\d{13,19}`, 0.9, { checksum: 'LUHN', clean: String.raw`[\s\-]` }]], { reject: 0.3 }))

// ── L1 · Network, devices, vehicles, property ───────────────────────────────

algorithm('AR_OCTETO', 'characterMapping.NumericMapping', { minValue: 1, maxValue: 254 }, '10')
decompose('AR_IP', [
  [String.raw`(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})`, apply('AR_OCTETO'), apply('AR_OCTETO'), apply('AR_OCTETO'), apply('AR_OCTETO')],
], apply('AR_CM_HEX'), '181.47.132.21')
domain('AR_L1_IP', 'AR_IP',
  byName(['ip|ip_?(address|addr|origen|destino|cliente|usuario|acceso|login|remota|publica)|direcci[oó]n_?ip|dir_?ip|ipv[46]|remote_?addr(ess)?|client_?ip|host_?ip', 0.85]),
  byPattern([
    [String.raw`((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)`, 1],
    [String.raw`[0-9A-Fa-f]{1,4}(:[0-9A-Fa-f]{0,4}){2,7}`, 0.9],
  ], { reject: 0.3 }))

domain('AR_L1_DISPOSITIVO', 'AR_CM_HEX',
  byName(['imei|imsi|iccid|mac|mac_?address|direcci[oó]n_?mac|device_?(id|uuid|serial)|id_?(dispositivo|equipo|celular)|serial_?(equipo|celular|dispositivo)|advertising_?id|idfa|gaid|cookie(_?id)?|session_?id|id_?sesi[oó]n', 0.8]),
  byPattern([
    [String.raw`([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}`, 1],
    [String.raw`\d{15}`, 0.8, { checksum: 'LUHN' }],
  ], { reject: 0.3 }))

// Plates (dominio): Mercosur cars AB 123 CD and motorcycles A 123 BCD since 2016; before, cars
// ABC 123 and motorcycles 123 ABC. Letters stay letters and digits digits, position by position.
domain('AR_L1_DOMINIO', 'AR_CM_DIGITOS_LETRAS',
  byName(['dominio(_?(veh[ií]culo|automotor|auto|moto|rodado))?|patente(_?(veh[ií]culo|auto|moto))?|n(o|ro|um|umero)_?(dominio|patente)|placa|license_?plate|plate(_?(no|number))?', 0.85]),
  byPattern([
    [String.raw`[A-Z]{2}\s?\d{3}\s?[A-Z]{2}`, 0.8],
    [String.raw`[A-Z]{3}\s?\d{3}`, 0.7],
    [String.raw`[A-Z]\d{3}[A-Z]{3}`, 0.7],
    [String.raw`\d{3}\s?[A-Z]{3}`, 0.5],
  ], { reject: 0.3 }))

domain('AR_L1_VEHICULO', 'AR_CM_ALFANUM',
  byName(['vin|chasis|n(o|ro|um|umero)_?(chasis|motor|cuadro|serie|vin)|motor_?n(o|ro|um|umero)|c[eé]dula_?(verde|azul|(de_?)?identificaci[oó]n_?(del_?)?automotor)|t[ií]tulo_?(del_?)?automotor|dnrpa|registro_?automotor|licencia_?(de_?)?conducir(_?(n(o|ro|um|umero)))?|carnet_?(de_?)?conducir', 0.85]),
  byPattern([[String.raw`[A-HJ-NPR-Z0-9]{17}`, 0.7]], { reject: 0.3 }))

// Real estate: the partida inmobiliaria, the cadastral nomenclature and the registry number of the
// property registry identify the owner's home.
domain('AR_L1_INMUEBLE', 'AR_CM_ALFANUM',
  byName(['partida_?(inmobiliaria|municipal|arba|abl|catastral)?|n(o|ro|um|umero)_?partida|nomenclatura_?catastral|nomenclatura|catastro|circunscripci[oó]n|parcela|matr[ií]cula_?(registral|inmueble|folio_?real)|folio_?real|n(o|ro|um|umero)_?(abl|inmobiliario|arba|rentas)|cuenta_?(rentas|municipal|abl|inmobiliaria)|padr[oó]n_?(inmobiliario|municipal)', 0.8]))

domain('AR_L1_CONTRATO', 'AR_CM_ALFANUM',
  byName(['n(o|ro|um|umero)_?(contrato|p[oó]liza|operaci[oó]n|cr[eé]dito|pr[eé]stamo|solicitud|afiliado|afiliaci[oó]n|socio|suscriptor|cliente|medidor|servicio|suministro|legajo|expediente_?(administrativo|interno)|beneficio|carnet)|contrato_?(n(o|ro|um|umero))|legajo(_?(personal|empleado|agente|alumno))?|c[oó]digo_?(cliente|socio|afiliado|empleado|alumno)|id_?(cliente|socio|afiliado|empleado|agente|alumno)|n(o|ro)_?socio|n(ro|umero)_?libreta_?universitaria', 0.7]))

domain('AR_L1_USUARIO', 'AR_CM_ALFANUM',
  byName(['usuario|user_?name|username|login|apodo|nick(_?name)?|perfil_?(instagram|facebook|twitter|tiktok|linkedin|x)|instagram|facebook|twitter|tiktok|linkedin|red_?social|handle', 0.7]))

domain('AR_L1_CREDENCIAL', 'AR_REDACTAR',
  byName(['contrase[nñ]a|clave(?!_?(producto|catastral|primaria|for[aá]nea|valor|bancaria|virtual|[uú]nica))|clave_?fiscal|password|passwd|pwd|pass|hash_?(clave|contrasena|password)|pin|c[oó]digo_?(seguridad|verificaci[oó]n|acceso|otp)|cvv|cvc|token(_?(acceso|refresh|api))?|access_?token|refresh_?token|api_?key|secreto|secret|otp|pregunta_?secreta|respuesta_?secreta', 0.9]))

decompose('AR_COORDENADA', [
  // The integer part and first decimal stay (about 11 km): the place is generalized, not moved.
  [String.raw`(-?\d{1,3}[.,]\d)(\d+)\s*([,;])\s*(-?\d{1,3}[.,]\d)(\d+)`, keep, DIGITS, keep, keep, DIGITS],
  [String.raw`(-?\d{1,3}[.,]\d)(\d+)`, keep, DIGITS],
], keep, '-34.603722')
domain('AR_L1_GEOLOCALIZACION', 'AR_COORDENADA',
  byName(
    ['lat|latitud|lon|lng|longitud|coordenadas?|coord_?[xy]|geo_?(lat|lon|lng|loc|localizacion|posicion)|georreferenciaci[oó]n|geolocalizaci[oó]n|gps(_?(ubicaci[oó]n|posici[oó]n|coordenadas))?|ubicaci[oó]n_?gps', 0.85],
    ['long', 0.5],
  ),
  byPattern([
    [String.raw`-(2[1-9]|[34]\d|5[0-5])\.\d{3,}\s*,\s*-(5[3-9]|6\d|7[0-3])\.\d{3,}`, 0.9],
    [String.raw`-(2[1-9]|[34]\d|5[0-5]|6\d|7[0-3])\.\d{4,}`, 0.4],
  ], { reject: 0.3 }))

// ── L1 · Free text ──────────────────────────────────────────────────────────

algorithm('AR_TEXTO_LIBRE', 'freeTextRedaction.FreeTextRedaction', {
  regularExpressions: [
    String.raw`(?<![\d.])\d{1,2}\.\d{3}\.\d{3}(?![\d.])`,
    String.raw`(?<!\d)(20|2[347]|3[034])-?\d{8}-?\d(?!\d)`,
    String.raw`(?<!\d)\d{7,8}(?!\d)`,
    String.raw`(?<!\d)\d{22}(?!\d)`,
    String.raw`[\w.+\-]+@[\w\-]+(\.[\w\-]+)+`,
    String.raw`(?<![\d\-])(\+?549?)?(11|[23]\d{2,3})(15)?\d{6,8}(?![\d\-])`,
    String.raw`(?<![\d\-])(15-?)?\d{4}-\d{4}(?![\d\-])`,
    String.raw`(?<!\d)\d{13,19}(?!\d)`,
    String.raw`(?<![A-Za-z])([A-Z]{2}\d{3}[A-Z]{2}|[A-Z]{3}\d{3}|[A-Z]\d{3}[A-Z]{3})(?![A-Za-z\d])`,
    String.raw`(?<!\d)(\d{1,3}\.){3}\d{1,3}(?!\d)`,
  ].map((patternString) => ({ patternString })),
  regExRedactValue: '[DATO]',
  lookupFile: { uri: file('ar-texto-nombres.txt', unique([...GIVEN_NAMES, ...SURNAMES].flatMap((v) => [v, v.toUpperCase(), fold(v), fold(v).toUpperCase()]))) },
  lookupFileRedactValue: '[NOMBRE]',
  isDenyList: true,
}, 'Cliente Fernández, DNI 28.456.789, correo s.fernandez@hotmail.com, cel 1145678901')

domain('AR_L1_TEXTO_LIBRE', 'AR_TEXTO_LIBRE',
  byName(['observaci[oó]n(es)?|obs|comentarios?|notas?|anotaci[oó]n(es)?|descripci[oó]n_?(reclamo|queja|solicitud|caso|hechos|novedad|atenci[oó]n|incidente)|detalle_?(reclamo|solicitud|caso|atenci[oó]n)|hechos|relato|justificaci[oó]n|(?<!(id|cd|cod|codigo|tipo|fecha|estado|num|nro)_?)mensaje(?!_?(id|tipo|codigo|fecha|estado|cola|log))|texto(_?libre)?|resumen_?(caso|atenci[oó]n)|queja|reclamo|motivo_?(reclamo|contacto|llamado)|remarks?|comments?|notes?|free_?text|memo', 0.6]),
  byType(STRING(30)),
  byPattern([
    [String.raw`\d{1,2}\.\d{3}\.\d{3}`, 0.6],
    [String.raw`[\w.+\-]+@[\w\-]+\.[A-Za-z]{2,}`, 0.7],
    [String.raw`(20|2[347]|3[034])-\d{8}-\d`, 0.7],
  ], { reject: 0, partial: true }))

// ── L2 · Quasi-identifiers ──────────────────────────────────────────────────

// Small shifts: large enough to break the link to the person, small enough that ages, school years
// and the 13th, 16th and 18th birthdays move for few people.
algorithm('AR_FECHA_NACIMIENTO', 'dateAlgorithms.DateShift', { minRange: -60, maxRange: 60, unit: 'DAYS', roll: false }, '1985-07-20')
algorithm('AR_FECHA_EVENTO', 'dateAlgorithms.DateShift', { minRange: -30, maxRange: 30, unit: 'DAYS', roll: false }, '2021-03-15')

domain('AR_L2_FECHA_NACIMIENTO', 'AR_FECHA_NACIMIENTO',
  byName(['(fecha|fec|fch|f)_?(de_?)?nac(imiento)?|fnac|fechanac(imiento)?|cumplea[nñ]os|dob|date_?of_?birth|birth_?date|birthday', 0.9]),
  byType(...DATES, STRING(6)))

// The decade stays and the unit is masked.
decompose('AR_ANIO', [[String.raw`(\d{3})(\d)`, keep, DIGITS]], keep, '1985')
domain('AR_L2_ANIO_NACIMIENTO', 'AR_ANIO',
  byName(['a[nñ]o_?(de_?)?nac(imiento)?|anio_?nac(imiento)?|year_?of_?birth|birth_?year|yob|clase', 0.9]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// 37 becomes 3x. From 100 on, 90.
decompose('AR_EDAD', [
  [String.raw`(\d{3,})`, redactAs('90')],
  [String.raw`([1-9])(\d)([.,]\d+)`, keep, DIGITS, keep],
  [String.raw`([1-9])(\d)`, keep, DIGITS],
  [String.raw`(\d)`, DIGITS],
], keep, '37')
domain('AR_L2_EDAD', 'AR_EDAD',
  byName(['edad(_?(actual|a[nñ]os|anios|paciente|afiliado|cliente|al_?(ingreso|diagn[oó]stico|fallecimiento)))?|grupo_?etario|rango_?(de_?)?edad|quinquenio|age(_?(years|group))?', 0.85]),
  byType(NUMBER(0, 6), STRING(0, 6)))

domain('AR_L2_FECHA_EVENTO', 'AR_FECHA_EVENTO',
  byName(['(fecha|fec|fch|f)_?(de_?)?(defunci[oó]n|fallecimiento|muerte|matrimonio|uni[oó]n_?convivencial|divorcio|ingreso|egreso|alta|baja|retiro|contrataci[oó]n|desvinculaci[oó]n|despido|jubilaci[oó]n|internaci[oó]n|diagn[oó]stico|atenci[oó]n|consulta|parto|detenci[oó]n|condena|emisi[oó]n(_?(dni|documento))?|vencimiento_?dni|radicaci[oó]n|vacunaci[oó]n|cirug[ií]a|accidente|licencia)|fec_?(emision|defuncion|ingreso|egreso|baja)|date_?of_?(death|marriage|hire|admission|discharge)', 0.8]),
  byType(...DATES, STRING(6)))

// Each vocabulary replaced within itself: M/F stays M/F. The DNI admits X since 2021 (Decreto
// 476/2021): a few thousand people, so an X becomes M or F.
decompose('AR_SEXO', [
  ['(?i)(femenino|masculino|no\\s+binario)', apply(lookup('AR_SEXO_FEMENINO_MASCULINO', 'ar-sexo-femenino-masculino.txt', ['Femenino', 'Masculino']))],
  ['(?i)(mujer|var[oó]n|hombre)', apply(lookup('AR_SEXO_MUJER_VARON', 'ar-sexo-mujer-varon.txt', ['Mujer', 'Varón']))],
  ['(?i)(female|male)', apply(lookup('AR_SEXO_FEMALE_MALE', 'ar-sexo-female-male.txt', ['Female', 'Male']))],
  ['(?i)([fmx])', apply(lookup('AR_SEXO_F_M', 'ar-sexo-f-m.txt', ['F', 'M']))],
  ['([12])', apply(lookup('AR_SEXO_1_2', 'ar-sexo-1-2.txt', ['1', '2']))],
], keep, 'F')
domain('AR_L2_SEXO', 'AR_SEXO',
  byName(['sexo(_?(biol[oó]gico|al_?nacer|registral|dni|paciente|afiliado|cliente))?|(tp|tipo|cod|cd|id)_?sexo|g[eé]nero(?!_?(identidad|autopercibido))|sex|gender(?!_?identity)', 0.85]),
  byList([['ar-detectar-sexo.txt', ['f', 'm', 'x', 'femenino', 'masculino', 'mujer', 'varón', 'hombre', 'no binario', 'female', 'male'], 0.5]], { reject: 0.5 }))

// ── L2 · Where people live ──────────────────────────────────────────────────
//
// Two levels of the 2022 census. The 528 departamentos — partidos in Buenos Aires, comunas in the
// capital: 203 had fewer than 20,000 inhabitants. The 2,280 gobiernos locales — municipios, comunas,
// comisiones de fomento and municipales: 1,952 had fewer than 20,000, and more than half of those fewer than
// 2,000. With a birth date and a sex, one of them points at a handful of people. A small one
// becomes the nearest of the same province with at least 20,000 — a real place, nearby, shared by
// many. The province stays. A localidad takes the fate of its gobierno local; one outside any
// gobierno local is rural and is generalized too.

const distance = (a, b) => {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}
const SMALL_PLACE = 20000
const nearest = (place, candidates) => candidates.reduce((best, x) => (distance(place, x) < distance(place, best) ? x : best))
const nearestLarge = (units) => {
  const large = units.filter((u) => u.population >= SMALL_PLACE)
  return (place) => {
    const sameProvince = large.filter((x) => x.provinceCode === place.provinceCode)
    return nearest(place, sameProvince.length ? sameProvince : large)
  }
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
// Each name as written comes before the capitals and the spellings without accents of the others,
// so a place whose official name has no accents does not take an accentless target from a homonym.
const variants = (pairs) => {
  const all = pairs.map(([from, to]) => spellings(from, to))
  return [...all.map((v) => v[0]), ...all.flatMap((v) => v.slice(1))]
}
// With the province, as systems write it to tell homonyms apart: "San José - Entre Ríos", "San José (Entre Ríos)".
const SEPARATORS = [[' - ', ''], [', ', ''], [' (', ')'], ['/', ''], ['-', '']]

/**
 * The generalization table of one level. `places` carry name, aliases, province, `small` and
 * `to` — the place they become. A name shared by several places is generalized only when all are
 * small, to the fate of the most populous — among the country's places by name alone, among the
 * province's written with the province.
 */
function generalization(places) {
  const byName = new Map()
  const byNameProvince = new Map()
  const add = (map, key, name, p) => {
    const entry = map.get(key) ?? { spellings: new Set(), all: new Set() }
    entry.spellings.add(name)
    entry.all.add(p)
    map.set(key, entry)
  }
  for (const p of places) {
    for (const name of spellingsOf(p)) {
      add(byName, nameKey(name), name, p)
      add(byNameProvince, `${nameKey(name)}|${p.provinceCode}`, name, p)
    }
  }
  const mostPopulous = (all) => [...all].reduce((a, b) => (b.weight > a.weight ? b : a))
  const pairs = []
  let names = 0
  for (const { spellings: names_, all } of byName.values()) {
    if ([...all].some((p) => !p.small)) continue
    const to = mostPopulous(all).to.name
    for (const name of names_) pairs.push([name, to])
    names++
  }
  for (const { spellings: names_, all } of byNameProvince.values()) {
    if ([...all].some((p) => !p.small)) continue
    const from = mostPopulous(all)
    for (const name of names_) for (const [a, b] of SEPARATORS) pairs.push([`${name}${a}${from.province}${b}`, `${from.to.name}${a}${from.to.province}${b}`])
  }
  const withProvince = (p) => spellingsOf(p).flatMap((name) => SEPARATORS.map(([a, b]) => `${name}${a}${p.province}${b}`))
  const kept = new Set(variants(places.filter((p) => !p.small).flatMap((p) => [...withProvince(p), ...spellingsOf(p)].map((n) => [n, n]))).map(([from]) => from))
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

// Departamentos and partidos.
const departamentoTo = nearestLarge(DEPARTAMENTOS)
const departamentoPlaces = DEPARTAMENTOS.map((d) => ({ ...d, small: d.population < SMALL_PLACE, weight: d.population, to: d.population < SMALL_PLACE ? departamentoTo(d) : d }))
const departamentoTable = generalization(departamentoPlaces)
cleansing('AR_DEPARTAMENTO', 'ar-departamentos-generalizados.txt', departamentoTable.table, 'Ancasti', '|')

// Gobiernos locales and localidades.
const gobiernoTo = nearestLarge(GOBIERNOS)
const gobiernoByCode = new Map(GOBIERNOS.map((g) => [g.code, g]))
const gobiernoPlaces = GOBIERNOS.map((g) => ({ ...g, small: g.population < SMALL_PLACE, weight: g.population, to: g.population < SMALL_PLACE ? gobiernoTo(g) : g }))
const gobiernoPlaceByCode = new Map(gobiernoPlaces.map((g) => [g.code, g]))
const localidadPlaces = LOCALIDADES.map((l) => {
  const g = gobiernoPlaceByCode.get(l.localGovernment)
  const province = DEPARTAMENTOS.find((d) => d.provinceCode === l.provinceCode).province
  if (g) return { ...l, province, small: g.small, weight: g.population, to: g.to }
  return { ...l, province, small: true, weight: 0, to: gobiernoTo(l) }
})
const localidadTable = generalization([...gobiernoPlaces, ...localidadPlaces])
cleansing('AR_LOCALIDAD', 'ar-localidades-generalizadas.txt', localidadTable.table, 'Colonia Hocker', '|')

// INDEC codes: five digits for a departamento, six for a gobierno local, eight for a localidad
// censal. A small one's code becomes the code of the place it is generalized to — for a localidad,
// the localidad of that gobierno local that bears its name, or the nearest to it.
const localidadesOf = new Map()
for (const l of LOCALIDADES) localidadesOf.set(l.localGovernment, [...(localidadesOf.get(l.localGovernment) ?? []), l])
const mainLocalidad = (g) => {
  const own = localidadesOf.get(g.code) ?? localidadPlaces.filter((l) => !l.small && l.provinceCode === g.provinceCode)
  return own.find((l) => nameKey(l.name) === nameKey(g.name)) ?? nearest(g, own)
}
const codePairs = [
  ...departamentoPlaces.filter((d) => d.small).map((d) => [d.code, d.to.code]),
  ...gobiernoPlaces.filter((g) => g.small).map((g) => [g.code, g.to.code]),
  ...localidadPlaces.filter((l) => l.small).map((l) => [l.code, mainLocalidad(l.to).code]),
]
cleansing('AR_CODIGO_GEOGRAFICO', 'ar-codigos-geograficos-generalizados.txt', codePairs, '10014', '|')

const PERSONAL_WORDS = new Set([...GIVEN_NAMES, ...SURNAMES].map((w) => fold(w).toLowerCase()))
const PROVINCE_NAMES = new Set([...PROVINCES, 'Buenos Aires', 'Capital Federal', 'CABA', 'Tierra del Fuego', 'Argentina'].map((n) => fold(n).toLowerCase()))
const placeNames = (places) => unique(places.flatMap(spellingsOf))
  .filter((n) => !PERSONAL_WORDS.has(fold(n).toLowerCase()) && !PROVINCE_NAMES.has(fold(n).toLowerCase()) && !/^Comuna \d+$/.test(n))

domain('AR_L2_LOCALIDAD', 'AR_LOCALIDAD',
  byName(['localidad(?!_?(cod|codigo|id|indec))(_?(residencia|nacimiento|domicilio|paciente|cliente|origen|emisi[oó]n))?|loc(_?(res|nac|dom))?|municipio(?!_?(cod|codigo|id|indec))(_?(residencia|domicilio))?|ciudad(_?(residencia|nacimiento|domicilio|cliente|origen))?|(nom|nombre|desc)_?(localidad|municipio|ciudad)|lugar_?(de_?)?nacimiento|pueblo_?(residencia|natal)|city|town', 0.85]),
  byList([['ar-detectar-localidades.txt', placeNames([...GOBIERNOS, ...LOCALIDADES]), 0.8]], { reject: 0.4 }))

domain('AR_L2_DEPARTAMENTO', 'AR_DEPARTAMENTO',
  byName(
    ['partido(?!_?(pol[ií]tico|afiliaci[oó]n|cod|codigo|id))(_?(residencia|domicilio))?|departamento_?(geogr[aá]fico|residencia|provincial|indec)|(nom|nombre|desc)_?(partido|departamento|depto|dpto)', 0.85],
    // DEPARTAMENTO and DPTO also name the flat of an address: the values decide.
    ['departamento(?!_?(n(o|ro|umero)|piso|cod|codigo|id))|depto|dpto', 0.5],
  ),
  byList([['ar-detectar-departamentos.txt', placeNames(DEPARTAMENTOS), 0.8]], { reject: 0.4 }))

domain('AR_L2_CODIGO_GEOGRAFICO', 'AR_CODIGO_GEOGRAFICO',
  byName(['(cod|codigo|cd|id)_?(localidad|loc|municipio|gobierno_?local|departamento|depto|dpto|partido)(_?(indec|censal|res|residencia|nac|nacimiento))?|(cod|codigo)_?indec|indec_?(cod|codigo|localidad|departamento)|codloc|coddepto|cod_?gl|localidad_?censal_?(id|cod)', 0.85]),
  byPattern([[String.raw`(0[26]|1[0480]|2[26]|3[0484]|4[26]|5[048]|6[26]|7[048]|8[26]|9[04])\d{3}(\d|\d{3})?`, 0.4]], { reject: 0.3 }))

// Código Postal Argentino: a letter for the province, four digits and three letters that narrow it
// to a block face. The old four-digit code names a town. The letter and the first two digits stay.
decompose('AR_CODIGO_POSTAL', [
  [String.raw`([A-Za-z])(\d{2})(\d{2})([A-Za-z]{3})`, keep, keep, redactAs('00'), redactAs('AAA')],
  [String.raw`([A-Za-z]?)(\d{2})(\d{2})`, keep, keep, redactAs('00')],
], keep, 'C1043AAZ')
domain('AR_L2_CODIGO_POSTAL', 'AR_CODIGO_POSTAL',
  byName(['c[oó]digo_?postal|cod_?postal|codpostal|cpa|zip(_?code)?|postal_?code|cp', 0.85]),
  byType(STRING(4, 8), NUMBER(0, 4)),
  byPattern([[String.raw`[A-HJ-NP-Z]\d{4}[A-Z]{3}`, 0.8], [String.raw`[A-HJ-NP-Z]?[1-9]\d{3}`, 0.4]], { reject: 0.3 }))

lookup('AR_BARRIO', 'ar-barrios.txt', NEIGHBOURHOODS, 'Barrio Parque Los Andes', 'PRESERVE_LOOKUP_FILE')
domain('AR_L2_BARRIO', 'AR_BARRIO',
  byName(['barrio(_?(residencia|domicilio|cliente|cerrado|privado))?|(nom|nombre)_?barrio|country|club_?de_?campo|villa_?(de_?)?emergencia|asentamiento(_?informal)?|renabap|neighbou?rhood|paraje', 0.8]))

// Nationalities: Argentine and the largest foreign communities — Paraguayans and Bolivians first.
const NATIONALITIES = ['Argentina', 'Paraguaya', 'Boliviana', 'Venezolana', 'Peruana', 'Chilena', 'Uruguaya', 'Colombiana', 'Brasileña', 'Italiana', 'Española', 'China', 'Dominicana', 'Estadounidense']
lookup('AR_NACIONALIDAD', 'ar-nacionalidades.txt', NATIONALITIES, 'Senegalesa')
domain('AR_L2_NACIONALIDAD', 'AR_NACIONALIDAD',
  byName(['nacionalidad|pa[ií]s_?(de_?)?(nacimiento|origen|nacionalidad)|ciudadan[ií]a|nationality|citizenship|country_?of_?birth', 0.8]),
  byList([['ar-detectar-nacionalidades.txt', [...NATIONALITIES, 'argentino', 'paraguayo', 'boliviano', 'venezolano', 'peruano', 'chileno', 'uruguayo', 'colombiano', 'brasileño', 'italiano', 'español', 'chino', 'dominicano', 'paraguay', 'bolivia', 'venezuela', 'perú', 'chile', 'uruguay', 'colombia', 'brasil', 'italia', 'españa', 'extranjero', 'extranjera'], 0.7]], { reject: 0.4 }))

// The Civil and Commercial Code (2015) added the unión convivencial.
const MARITAL = ['Soltero/a', 'Casado/a', 'Unión convivencial', 'Separado/a de hecho', 'Divorciado/a', 'Viudo/a']
categorical('AR_ESTADO_CIVIL', 'ar-estado-civil.txt', MARITAL, 'Concubinato', ['1', '2', '3', '4', '5', '6'])
domain('AR_L2_ESTADO_CIVIL', 'AR_ESTADO_CIVIL',
  byName(['estado_?civil|est_?civil|(cod|tipo|id)_?estado_?civil|situaci[oó]n_?conyugal|marital_?status|civil_?status', 0.85]),
  byList([['ar-detectar-estado-civil.txt', [...MARITAL, 'soltero', 'soltera', 'casado', 'casada', 'concubinato', 'unión convivencial', 'union de hecho', 'separado', 'separada', 'divorciado', 'divorciada', 'viudo', 'viuda'], 0.7]], { reject: 0.4 }))

lookup('AR_OCUPACION', 'ar-ocupaciones.txt', ['Empleado administrativo', 'Vendedor', 'Cajero', 'Chofer', 'Repartidor', 'Albañil', 'Maestro mayor de obras', 'Docente', 'Enfermero', 'Médico', 'Contador', 'Abogado', 'Ingeniero', 'Programador', 'Recepcionista', 'Personal de maestranza', 'Vigilador', 'Cocinero', 'Mozo', 'Electricista', 'Plomero', 'Mecánico', 'Productor agropecuario', 'Peón rural', 'Operario', 'Asesor comercial', 'Operador de call center', 'Empleado de depósito', 'Peluquero', 'Costurero', 'Empleada doméstica', 'Estudiante', 'Jubilado', 'Monotributista', 'Ama de casa'], 'Gerente regional de operaciones')
decompose('AR_OCUPACION_O_CODIGO', [
  // Clasificador Nacional de Ocupaciones (CNO) of the INDEC, five digits.
  [String.raw`(\d{2,5})`, DIGITS],
], apply('AR_OCUPACION'), 'Gerente regional de operaciones')
domain('AR_L2_OCUPACION', 'AR_OCUPACION_O_CODIGO',
  byName(
    ['ocupaci[oó]n|profesi[oó]n|oficio|cno|(cod|codigo)_?(ocupacion|cno|profesion)|puesto_?(de_?)?trabajo|categor[ií]a_?laboral|cargo_?(actual|empleado|agente)|occupation|profession|job_?title', 0.8],
    ['cargo|puesto', 0.5],
  ))

lookup('AR_EMPLEADOR', 'ar-empleadores.txt', COMPANIES, 'Mercado Libre S.R.L.', 'PRESERVE_LOOKUP_FILE')
domain('AR_L2_EMPLEADOR', 'AR_EMPLEADOR',
  byName(['empleador(_?(nombre|raz[oó]n_?social|cuit))?|(nombre|nom)_?(empleador|empresa_?donde_?trabaja)|empresa_?(donde_?)?(trabaja|labora)|lugar_?(de_?)?trabajo|patr[oó]n|employer(_?name)?|workplace', 0.9]))

const EDUCATION = ['Sin instrucción', 'Primario incompleto', 'Primario completo', 'Secundario incompleto', 'Secundario completo', 'Terciario no universitario incompleto', 'Terciario no universitario completo', 'Universitario incompleto', 'Universitario completo', 'Posgrado']
categorical('AR_NIVEL_EDUCATIVO', 'ar-nivel-educativo.txt', EDUCATION, 'Doctorado', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
domain('AR_L2_NIVEL_EDUCATIVO', 'AR_NIVEL_EDUCATIVO',
  byName(['nivel_?(educativo|de_?instrucci[oó]n|de_?estudios|acad[eé]mico|alcanzado)|m[aá]ximo_?nivel(_?educativo)?|estudios_?(alcanzados|cursados)|instrucci[oó]n|escolaridad|education(_?level)?', 0.8]),
  byList([['ar-detectar-nivel-educativo.txt', [...EDUCATION, 'primario', 'primaria', 'secundario', 'secundaria', 'terciario', 'universitario', 'posgrado', 'polimodal', 'egb', 'sin estudios'], 0.6]], { reject: 0.4 }))

lookup('AR_ESTABLECIMIENTO_EDUCATIVO', 'ar-establecimientos-educativos.txt', ['Escuela N° 12 Domingo F. Sarmiento', 'Escuela Primaria N° 45', 'Escuela de Educación Secundaria N° 3', 'Escuela Técnica N° 8', 'Colegio Nacional', 'Instituto San José', 'Colegio Nuestra Señora del Rosario', 'Escuela Normal Superior', 'Instituto Superior de Formación Docente N° 21', 'Universidad Nacional del Litoral', 'Universidad Nacional de Cuyo', 'Escuela Agrotécnica'], 'Colegio Nacional de Buenos Aires')
domain('AR_L2_ESTABLECIMIENTO_EDUCATIVO', 'AR_ESTABLECIMIENTO_EDUCATIVO',
  byName(['escuela(_?(nombre|egreso))?|colegio(_?(nombre|egreso))?|(nombre|nom)_?(escuela|colegio|establecimiento_?educativo|universidad|instituto)|establecimiento_?educativo|instituci[oó]n_?educativa|universidad|cue(_?anexo)?|school(_?name)?|university', 0.75]))

// Capped at 5 as text: large families are rare, and a rare count identifies.
decompose('AR_CONTEO_LIMITADO', [[String.raw`([0-5])`, keep], [String.raw`(\d+)`, redactAs('5')]], keep, '9')
domain('AR_L2_PERSONAS_A_CARGO', 'AR_CONTEO_LIMITADO',
  byName(['personas_?a_?cargo|familiares_?a_?cargo|n(o|ro|um|umero)_?(de_?)?(hijos|dependientes|personas_?a_?cargo)|cant(idad)?_?(hijos|dependientes|personas_?hogar|convivientes)|hijos|cargas_?de_?familia|dependientes|personas_?(en_?el_?)?hogar|tama[nñ]o_?hogar|number_?of_?children|dependents', 0.8]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// ── L3 · Sensitive data (art. 2 and 7) ──────────────────────────────────────

// The 2022 census asked two questions: whether the person recognizes as indigenous or descendant of
// indigenous peoples, and as afro-descendant.
const ETHNIC_GROUPS = ['Indígena o descendiente de pueblos indígenas u originarios', 'Afrodescendiente', 'Ninguno', 'Prefiere no responder']
categorical('AR_ORIGEN_ETNICO', 'ar-origen-etnico.txt', ETHNIC_GROUPS, 'Afroargentino')
domain('AR_L3_ORIGEN_ETNICO', 'AR_ORIGEN_ETNICO',
  byName(['etnia|origen_?([eé]tnico|racial)|grupo_?[eé]tnico|pertenencia_?[eé]tnica|autorreconocimiento(_?[eé]tnico)?|auto_?reconocimiento|(cod|codigo|tipo|id)_?(etnia|origen_?etnico)|raza|afrodescendiente|afroargentin[oa]|ind[ií]gena|originario|ethnicity|race', 0.95]),
  byList([['ar-detectar-origen-etnico.txt', [...ETHNIC_GROUPS, 'indígena', 'originario', 'pueblo originario', 'afrodescendiente', 'afroargentino', 'afroargentina', 'negro', 'ninguno', 'ninguna', 'mestizo', 'blanco', 'criollo'], 0.9],
    // Belonging is often a yes/no flag or a census code: it backs up the column name but decides nothing alone.
    ['ar-detectar-codigos-banderas.txt', ['s', 'n', 'sí', 'no', '1', '2', '3', '4', '5', '6'], 0.3],
  ], { reject: 0.4 }))

// Indigenous peoples of the 2022 census; the replacement list has the most numerous.
const PEOPLES_TOP = ['Mapuche', 'Guaraní', 'Diaguita', 'Kolla', 'Qom', 'Wichí', 'Comechingón', 'Huarpe', 'Tehuelche', 'Mocoví', 'Ranquel', 'Aymara', 'Quechua', 'Tupí Guaraní', 'Charrúa', 'Omaguaca', 'Atacama', 'Pilagá', 'Chané', 'Tonokoté']
const PEOPLES_ALL = [...PEOPLES_TOP, 'Mbya Guaraní', 'Ava Guaraní', 'Chorote', 'Chulupí', 'Nivaclé', 'Lule', 'Vilela', 'Lule Vilela', 'Ocloya', 'Tilián', 'Tapiete', 'Toba', 'Sanavirón', 'Selk\'nam', 'Ona', 'Yagán', 'Haush', 'Pampa', 'Rankulche', 'Querandí', 'Tastil', 'Fiscara', 'Iogys', 'Kolla Atacameño', 'Mapuche Tehuelche', 'Guaycurú', 'Tupí', 'Chaná', 'Chicha', 'Cacán', 'Pacará', 'Toara', 'Quilmes', 'Calchaquí', 'Kolla Guaraní', 'Mocoví Qom', 'Chiriguano']
categorical('AR_PUEBLO_INDIGENA', 'ar-pueblos-indigenas.txt', PEOPLES_TOP, 'Selk\'nam')
domain('AR_L3_PUEBLO_INDIGENA', 'AR_PUEBLO_INDIGENA',
  byName(['pueblo(_?(ind[ií]gena|originario))?|(cod|codigo|nombre|nom)_?pueblo|comunidad_?(ind[ií]gena|originaria|aborigen)|personer[ií]a_?jur[ií]dica_?(comunidad|ind[ií]gena)|renaci|inai|aborigen|indigenous_?people', 0.9]),
  byList([['ar-detectar-pueblos-indigenas.txt', [...PEOPLES_ALL, 'toba', 'mataco', 'coya', 'colla', 'araucano', 'guarani', 'wichi', 'qom', 'mbyá'], 0.9]], { reject: 0.4 }))

const LANGUAGES = ['Español', 'Guaraní', 'Quechua', 'Mapuzungun', 'Qom (toba)', 'Wichí', 'Aymara', 'Mocoví', 'Pilagá', 'Chorote', 'Lengua de señas argentina', 'Ninguna lengua indígena']
categorical('AR_LENGUA', 'ar-lenguas.txt', LANGUAGES, 'Tapiete')
domain('AR_L3_LENGUA_INDIGENA', 'AR_LENGUA',
  byName(['lengua_?(ind[ií]gena|originaria|materna|nativa)|idioma_?(ind[ií]gena|originario|materno|nativo)|habla_?(lengua|idioma)_?(ind[ií]gena|originari[oa])|mother_?tongue|native_?language', 0.9]),
  byList([['ar-detectar-lenguas.txt', [...LANGUAGES, 'guaraní', 'guarani', 'quechua', 'quichua', 'mapudungun', 'mapuzungun', 'qom', 'toba', 'wichí', 'aymara', 'mocoví', 'pilagá', 'español', 'castellano'], 0.8]], { reject: 0.4 }))

// Religions as the CONICET surveys on beliefs (2008, 2019) group them.
const RELIGIONS = ['Católica', 'Evangélica', 'Pentecostal', 'Testigo de Jehová', 'Iglesia de Jesucristo de los Santos de los Últimos Días', 'Judía', 'Musulmana', 'Budista', 'Umbanda', 'Otra', 'Sin religión']
categorical('AR_RELIGION', 'ar-religiones.txt', RELIGIONS, 'Ortodoxa')
domain('AR_L3_RELIGION', 'AR_RELIGION',
  byName(['religi[oó]n|creencia_?religiosa|convicci[oó]n_?religiosa|credo|confesi[oó]n_?religiosa|culto|iglesia(_?(a_?la_?que_?pertenece|nombre))?|denominaci[oó]n_?religiosa|(cod|codigo|tipo)_?religion|religion|church', 0.95]),
  byList([['ar-detectar-religiones.txt', [...RELIGIONS, 'católico', 'catolico', 'cristiano', 'cristiana', 'evangélico', 'protestante', 'pentecostal', 'adventista', 'testigo de jehová', 'mormón', 'judío', 'musulmán', 'budista', 'umbanda', 'ateo', 'agnóstico', 'ninguna', 'ninguno'], 0.9]], { reject: 0.4 }))

// Art. 2 names "convicciones filosóficas o morales" apart from religion.
domain('AR_L3_CONVICCION_FILOSOFICA', 'AR_CATEGORIA_SUPRIMIDA',
  byName(['convicci[oó]n(es)?_?(filos[oó]ficas?|morales?|personales?)|creencias?_?(filos[oó]ficas?|morales?|personales?)|objeci[oó]n_?(de_?)?conciencia|objetor_?(de_?)?conciencia|masoner[ií]a|logia|beliefs?|philosophical_?beliefs?', 0.9]))

const OPINIONS = ['Izquierda', 'Centroizquierda', 'Centro', 'Centroderecha', 'Derecha', 'Independiente', 'Prefiere no responder']
categorical('AR_OPINION_POLITICA', 'ar-opiniones-politicas.txt', OPINIONS, 'Libertario')
domain('AR_L3_OPINION_POLITICA', 'AR_OPINION_POLITICA',
  byName(['opini[oó]n_?pol[ií]tica|orientaci[oó]n_?pol[ií]tica|tendencia_?pol[ií]tica|ideolog[ií]a(_?pol[ií]tica)?|preferencia_?(pol[ií]tica|partidaria|electoral)|intenci[oó]n_?(de_?)?voto|simpat[ií]a_?pol[ií]tica|political_?(opinion|orientation|view)|voting_?intention', 0.9]),
  byList([['ar-detectar-opiniones-politicas.txt', [...OPINIONS, 'izquierda', 'derecha', 'centro', 'progresista', 'conservador', 'liberal', 'libertario', 'peronista', 'kirchnerista', 'radical', 'macrista', 'independiente', 'indeciso', 'voto en blanco', 'ninguno'], 0.7]], { reject: 0.4 }))

// Parties with national legal personality. Membership lists are kept by the electoral justice.
const PARTIES = ['Partido Justicialista', 'Unión Cívica Radical', 'Propuesta Republicana (PRO)', 'La Libertad Avanza', 'Coalición Cívica ARI', 'Frente Renovador', 'Partido Socialista', 'Partido Obrero', 'Partido de los Trabajadores Socialistas', 'Izquierda Socialista', 'Movimiento Socialista de los Trabajadores', 'Nuevo MAS', 'Partido GEN', 'Partido Demócrata Cristiano', 'Movimiento de Integración y Desarrollo', 'Partido Intransigente', 'Partido Demócrata Progresista', 'Partido Libertario', 'Partido Humanista', 'Partido Comunista', 'Frente Grande', 'Nuevo Encuentro', 'Kolina', 'Partido de la Victoria', 'Partido Autonomista', 'Partido Conservador Popular', 'Unión Celeste y Blanco', 'Partido Federal']
categorical('AR_PARTIDO_POLITICO', 'ar-partidos-politicos.txt', [...PARTIES, 'Sin afiliación'], 'Movimiento Popular Neuquino')
domain('AR_L3_AFILIACION_PARTIDARIA', 'AR_PARTIDO_POLITICO',
  byName(
    ['partido_?pol[ií]tico(_?(afiliaci[oó]n|nombre))?|afiliaci[oó]n_?(pol[ií]tica|partidaria|partido)|afiliado_?partido|militancia(_?pol[ií]tica)?|militante|(cod|codigo|nombre|nom)_?partido_?pol|agrupaci[oó]n_?pol[ií]tica|fuerza_?pol[ií]tica|political_?party|party_?membership', 0.95],
    // PARTIDO also names the partido of an address in Buenos Aires: the values decide.
    ['partido', 0.5],
  ),
  byList([['ar-detectar-partidos-politicos.txt', [...PARTIES, 'PJ', 'UCR', 'PRO', 'LLA', 'CC-ARI', 'ARI', 'FIT', 'FIT-U', 'Frente de Izquierda', 'PTS', 'MST', 'MID', 'Peronismo', 'Radicalismo', 'Unión por la Patria', 'Juntos por el Cambio', 'Frente de Todos', 'Hacemos', 'Movimiento Popular Neuquino'], 0.8]], { reject: 0.4 }))

// Trade union membership: payslips show the union dues and the union's code.
domain('AR_L3_AFILIACION_SINDICAL', 'AR_CATEGORIA_SUPRIMIDA',
  byName(['sindicato(_?(nombre|afiliado|afiliaci[oó]n|codigo))?|gremio(_?(nombre|afiliado|codigo))?|sindicalizado|afiliado_?(sindicato|gremio)|afiliaci[oó]n_?(sindical|gremial)|cuota_?(sindical|gremial)|aporte_?(sindical|gremial)|descuento_?(sindical|gremial)|asociaci[oó]n_?sindical|delegado_?(gremial|sindical)|comisi[oó]n_?interna|tutela_?sindical|convenio_?colectivo_?(de_?trabajo)?|cct|trade_?union|union_?member(ship)?', 0.95]),
  byList([['ar-detectar-sindicatos.txt', ['CGT', 'CTA', 'CTA-T', 'CTA-A', 'UOM', 'UOCRA', 'SMATA', 'UPCN', 'ATE', 'CTERA', 'SUTEBA', 'UTA', 'La Bancaria', 'Camioneros', 'FAECYS', 'Comercio', 'Luz y Fuerza', 'FATSA', 'Sanidad', 'UATRE', 'Aceiteros', 'UTEP', 'ADEMYS', 'AMSAFE', 'UEPC', 'SADOP', 'Confederación General del Trabajo', 'Central de Trabajadores de la Argentina', 'Unión Obrera Metalúrgica', 'Unión Personal Civil de la Nación', 'Asociación Trabajadores del Estado', 'sindicalizado', 'afiliado'], 0.6]], { reject: 0.3 }))

domain('AR_L3_BIOMETRICO', 'AR_REDACTAR',
  byName(['biometr[ií]a[a-z_]*|biom[eé]trico[a-z_]*|huella(_?dactilar)?(_?(template|plantilla|imagen|hash))?|huellas|dactilar|template_?(facial|huella|biometrico)|plantilla_?(facial|biom[eé]trica)|rostro_?(hash|template)|reconocimiento_?facial|validaci[oó]n_?(facial|biom[eé]trica|renaper)|firma_?(biom[eé]trica|digitalizada|ol[oó]grafa)|iris|voz_?(biom[eé]trica|template)|fingerprints?|face_?(template|hash|encoding)|biometric[a-z_]*', 0.9]),
  byType(STRING()))

// Genetic data: sensitive under the Convenio 108+ (Ley 27.699); the Banco Nacional de Datos
// Genéticos keeps the samples of the families of the disappeared.
domain('AR_L3_GENETICO', 'AR_REDACTAR',
  byName(['adn|dna|gen[eé]tic[oa]s?|datos?_?gen[eé]ticos?|genoma|genotip[a-z_]*|prueba_?(gen[eé]tica|de_?adn|de_?filiaci[oó]n|de_?paternidad)|perfil_?gen[eé]tico|mutaci[oó]n|brca[12]?|cariotipo|pesquisa_?neonatal|bndg|genetic[a-z_]*', 0.9]))

const ORIENTATIONS = ['Heterosexual', 'Gay', 'Lesbiana', 'Bisexual', 'Pansexual', 'Asexual', 'Otra', 'Prefiere no responder']
categorical('AR_ORIENTACION_SEXUAL', 'ar-orientaciones-sexuales.txt', ORIENTATIONS, 'Homosexual')
domain('AR_L3_ORIENTACION_SEXUAL', 'AR_ORIENTACION_SEXUAL',
  byName(['orientaci[oó]n_?sexual|orient_?sexual|(cod|codigo|tipo)_?orientacion_?sexual|preferencia_?sexual|sexual_?orientation', 0.95]),
  byList([['ar-detectar-orientaciones-sexuales.txt', [...ORIENTATIONS, 'hetero', 'homosexual', 'lgbt', 'lgbtiq+', 'lgbtiq+nb', 'queer'], 0.8]], { reject: 0.4 }))

domain('AR_L3_VIDA_SEXUAL', 'AR_CATEGORIA_SUPRIMIDA',
  byName(['vida_?sexual|actividad_?sexual|conducta_?sexual|pr[aá]cticas?_?sexuales?|parejas?_?sexuales?|n(o|ro|um|umero)_?parejas|sexualmente_?activ[oa]|inicio_?(de_?)?(las_?)?relaciones_?sexuales|relaciones_?sexuales|sex(ual)?_?life|sexual_?(activity|behavio(u)?r|partners)', 0.9]))

// Gender identity (Ley 26.743): the registry correction is confidential — nobody may access the
// original birth record without the person's authorization (art. 9).
const IDENTITIES = ['Mujer cis', 'Varón cis', 'Mujer trans / travesti', 'Varón trans / masculinidad trans', 'No binario', 'Otra', 'Prefiere no responder']
categorical('AR_IDENTIDAD_GENERO', 'ar-identidades-genero.txt', IDENTITIES, 'Transgénero')
domain('AR_L3_IDENTIDAD_GENERO', 'AR_IDENTIDAD_GENERO',
  byName(['identidad_?(de_?)?g[eé]nero|(cod|codigo|tipo)_?identidad_?genero|g[eé]nero_?(autopercibido|identitario)|rectificaci[oó]n_?registral|cambio_?(de_?)?(g[eé]nero|sexo_?registral)|ley_?26743|transg[eé]nero|persona_?trans|travesti|pronombres?|gender_?identity', 0.95]),
  byList([['ar-detectar-identidades-genero.txt', [...IDENTITIES, 'cis', 'cisgénero', 'transgénero', 'trans', 'travesti', 'no binario', 'no binarie', 'mujer', 'varón', 'femenino', 'masculino', 'x'], 0.7]], { reject: 0.4 }))

// Victims of gender violence (Ley 26.485), trafficking (Ley 26.364) and sexual crimes: the law orders
// the protection of their identity. The values share no vocabulary and are suppressed.
domain('AR_L3_VICTIMA', 'AR_CATEGORIA_SUPRIMIDA',
  byName(['v[ií]ctima(_?(de_?)?(violencia(_?(de_?)?g[eé]nero|_?familiar|_?dom[eé]stica)?|trata|abuso(_?sexual)?|delito(_?sexual)?|explotaci[oó]n))?|violencia_?(de_?)?g[eé]nero|violencia_?(familiar|dom[eé]stica|sexual)|tipo_?(de_?)?violencia|medida_?(de_?)?(protecci[oó]n|restricci[oó]n|exclusi[oó]n)|perimetral|restricci[oó]n_?(de_?)?acercamiento|bot[oó]n_?antip[aá]nico|linea_?144|trata(_?(de_?)?personas)?|restituci[oó]n_?(de_?)?identidad|conadi|hij[oa]_?(de_?)?desaparecid[oa]s?', 0.9]))

// ── SALUD · Health data (art. 8, Ley 26.529) ────────────────────────────────

// Health identifiers: the medical record (historia clínica, Ley 26.529), the affiliate number of the
// obra social or PAMI, authorizations.
domain('AR_SALUD_IDENTIFICADOR', 'AR_CM_ALFANUM',
  byName(
    ['n(o|ro|um|umero)_?(historia(_?cl[ií]nica)?|hc|afiliado(_?(obra_?social|os|pami|prepaga))?|beneficio_?pami|credencial|internaci[oó]n|autorizaci[oó]n|orden|receta|prescripci[oó]n)|historia_?cl[ií]nica|hc_?(n(o|ro|um|umero))?|afiliado_?(obra_?social|os|pami|prepaga)|n(ro|umero)_?(os|pami)|credencial_?(obra_?social|prepaga|pami)|c[oó]digo_?(paciente|afiliado)|id_?paciente|hce', 0.85],
    ['afiliado|internaci[oó]n|autorizaci[oó]n|episodio', 0.55],
  ))

// Coverage: the obra social — most are run by a union, so the code tells the trade and the union —,
// the prepaid plan, PAMI (retirees), Incluir Salud (non-contributory pensions), or public coverage only.
const COVERAGE = ['PAMI', 'IOMA', 'OSDE', 'Swiss Medical', 'Galeno', 'Medifé', 'OSECAC', 'OSPRERA', 'Unión Personal', 'OSDEPYM', 'OSPE', 'Sancor Salud', 'APROSS', 'IAPOS', 'OSEP', 'IOSFA', 'Obra social provincial', 'Prepaga', 'Sin cobertura (sistema público)']
decompose('AR_COBERTURA_SALUD', [
  [FLAG, apply('AR_BANDERA')],
  // RNOS code of the Superintendencia de Servicios de Salud: six digits, or with hyphens (1-0020-4).
  [String.raw`(\d[\d\-]{3,8}\d)`, DIGITS],
], apply(lookup('AR_OBRA_SOCIAL', 'ar-obras-sociales.txt', COVERAGE, undefined, 'PRESERVE_LOOKUP_FILE')), 'OSUOMRA')
domain('AR_SALUD_COBERTURA', 'AR_COBERTURA_SALUD',
  byName(['obra_?social(_?(nombre|codigo|afiliado))?|os|(cod|codigo|nombre|nom)_?(obra_?social|os|prepaga|rnos)|rnos|prepaga|medicina_?prepaga|cobertura(_?(m[eé]dica|de_?salud|social))?|financiador|plan_?(de_?)?salud|pami|incluir_?salud|profe', 0.85]),
  byList([['ar-detectar-cobertura.txt', [...COVERAGE, 'osde', 'swiss medical', 'galeno', 'medife', 'omint', 'accord salud', 'osuomra', 'oschoca', 'ospjn', 'osprera', 'ospedyc', 'ioma', 'pami', 'apross', 'iapos', 'incluir salud', 'profe', 'sin obra social', 'hospital público'], 0.8]], { reject: 0.4 }),
  byPattern([[String.raw`\d-\d{4}-\d`, 0.7]], { reject: 0 }))

const ICD10 = ['I10', 'E11', 'E78', 'J45', 'J06', 'J02', 'J20', 'K29', 'K21', 'K59', 'M54', 'M17', 'M25', 'N39', 'N20', 'R51', 'R10', 'H10', 'H66', 'L23', 'L30', 'B34', 'A09', 'E03', 'E66', 'D50', 'I83', 'K80', 'K40', 'S93', 'S60', 'Z00', 'J30', 'J32', 'G43', 'M79', 'R05']
const ICD10_DECIMAL = ['E11.9', 'E78.5', 'J45.9', 'J06.9', 'J02.9', 'J20.9', 'K29.7', 'K21.9', 'K59.0', 'M54.5', 'M17.9', 'N39.0', 'N20.0', 'R10.4', 'H10.9', 'H66.9', 'L23.9', 'L30.9', 'B34.9', 'A09.9', 'E03.9', 'E66.9', 'D50.9', 'I83.9', 'K80.2', 'K40.9', 'S93.4', 'S60.0', 'Z00.0', 'J30.4', 'J32.9', 'G43.9', 'M79.1']
decompose('AR_DIAGNOSTICO', [
  [String.raw`([A-TV-Za-tv-z]\d{2}\.\d{1,2})`, apply(lookup('AR_CIE10_DECIMAL', 'ar-cie10-decimal.txt', ICD10_DECIMAL, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [String.raw`([A-TV-Za-tv-z]\d{2,3}X?)`, apply(lookup('AR_CIE10', 'ar-cie10.txt', ICD10, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [FLAG, apply('AR_BANDERA')],
], apply(lookup('AR_DIAGNOSTICO_TEXTO', 'ar-diagnosticos.txt', ['Hipertensión arterial', 'Diabetes mellitus tipo 2', 'Asma', 'Lumbalgia', 'Gastritis crónica', 'Faringitis aguda', 'Infección urinaria', 'Migraña', 'Hipotiroidismo', 'Dislipemia', 'Obesidad', 'Artrosis de rodilla', 'Bronquitis aguda', 'Amigdalitis aguda', 'Dermatitis de contacto', 'Otitis media aguda', 'Esguince de tobillo', 'Conjuntivitis', 'Anemia ferropénica', 'Reflujo gastroesofágico', 'Síndrome de intestino irritable', 'Tendinitis', 'Sinusitis aguda', 'Cefalea tensional', 'Várices', 'Hernia inguinal', 'Litiasis renal', 'Litiasis vesicular', 'Gastroenteritis aguda', 'Control de salud'])), 'F33.1')
domain('AR_SALUD_DIAGNOSTICO', 'AR_DIAGNOSTICO',
  byName(['diagn[oó]stico[a-z_]*|dx(_?(principal|secundario|ingreso|egreso)[0-9]?)?|cie_?10|cie(_?(10|11|principal))?|(cod|codigo)_?(diagnostico|dx|cie)|impresi[oó]n_?diagn[oó]stica|enfermedad(es)?[a-z_]*|patolog[ií]a|comorbilidad(es)?|antecedentes?_?(m[eé]dicos|patol[oó]gicos|familiares|personales|cl[ií]nicos)|causa_?(de_?)?(muerte|defunci[oó]n|licencia|internaci[oó]n|consulta)|motivo_?(de_?)?(consulta|licencia|internaci[oó]n)|alergias?|diagnos(is|es)|icd_?(10|11)?', 0.85]),
  // 0.5: codes shaped like ICD-10 appear in other catalogs too; the name has to agree.
  byPattern([[String.raw`[A-TV-Za-tv-z]\d{2}(\.\d{1,2}|\d|X)?`, 0.5]], { reject: 0.3 }))

// Procedures: the Nomenclador Nacional and the provincial ones code them with six digits.
decompose('AR_PROCEDIMIENTO', [[String.raw`(\d{2}\.?\d{2}\.?\d{2})`, DIGITS]], apply(lookup('AR_PROCEDIMIENTO_TEXTO', 'ar-procedimientos.txt', ['Consulta médica en consultorio', 'Consulta de guardia', 'Hemograma completo', 'Glucemia', 'Orina completa', 'Creatinina', 'Radiografía de tórax', 'Ecografía abdominal', 'Electrocardiograma', 'Control prenatal'])), 'Prueba de carga viral para VIH')
domain('AR_SALUD_PROCEDIMIENTO', 'AR_PROCEDIMIENTO',
  byName(['nomenclador|(cod|codigo)_?(nomenclador|prestaci[oó]n|pr[aá]ctica|procedimiento)|procedimiento(_?(m[eé]dico|quir[uú]rgico|realizado|autorizado))?|pr[aá]ctica(_?(m[eé]dica|realizada|autorizada))?|prestaci[oó]n_?(m[eé]dica|realizada|autorizada)|estudio_?(solicitado|realizado)|cirug[ií]a(_?realizada)?|intervenci[oó]n_?quir[uú]rgica|medical_?procedure', 0.85]))

const MEDICATIONS = ['Paracetamol', 'Ibuprofeno', 'Diclofenac', 'Dipirona', 'Metformina', 'Glibenclamida', 'Losartán', 'Enalapril', 'Amlodipina', 'Atenolol', 'Atorvastatina', 'Omeprazol', 'Levotiroxina', 'Amoxicilina', 'Cefalexina', 'Salbutamol', 'Loratadina', 'Hidroclorotiazida', 'Aspirina', 'Betametasona', 'Azitromicina', 'Sulfato ferroso', 'Ácido fólico', 'Complejo B']
categorical('AR_MEDICAMENTO', 'ar-medicamentos.txt', MEDICATIONS, 'Sertralina 50 mg')
domain('AR_SALUD_MEDICAMENTO', 'AR_MEDICAMENTO',
  byName(['medicamentos?(_?(recetado|prescrito|dispensado|nombre|uso))?|f[aá]rmacos?|droga(_?(gen[eé]rica|principal))?|monodroga|principio_?activo|troquel|gtin|(cod|codigo)_?(medicamento|troquel|alfabeta|kairos)|receta(_?(m[eé]dica|electr[oó]nica|archivada))?|prescripci[oó]n_?(medicamento)?|posolog[ií]a|tratamiento_?farmacol[oó]gico|medications?|drugs?_?prescribed', 0.85]),
  byList([['ar-detectar-medicamentos.txt', [...MEDICATIONS, 'sertralina', 'fluoxetina', 'escitalopram', 'quetiapina', 'clonazepam', 'alprazolam', 'lorazepam', 'litio', 'metilfenidato', 'risperidona', 'olanzapina', 'haloperidol', 'tenofovir', 'emtricitabina', 'dolutegravir', 'efavirenz', 'insulina', 'warfarina', 'acenocumarol', 'levetiracetam', 'ácido valproico', 'misoprostol', 'mifepristona', 'levonorgestrel', 'anticonceptivo', 'rivotril', 'tafirol', 'ibupirac'], 0.7]], { reject: 0.3 }))

domain('AR_SALUD_TEXTO_CLINICO', 'AR_TEXTO_LIBRE',
  byName(['anamnesis|evoluci[oó]n(_?(m[eé]dica|cl[ií]nica|enfermer[ií]a))?|enfermedad_?actual|examen_?f[ií]sico|plan_?(de_?)?(tratamiento|manejo)|indicaciones_?m[eé]dicas|conducta(_?m[eé]dica)?|epicrisis|resumen_?(de_?)?(alta|internaci[oó]n|atenci[oó]n)|nota_?(m[eé]dica|de_?enfermer[ií]a|cl[ií]nica)|notas?_?(m[eé]dicas|cl[ií]nicas)|triage(_?texto)?|informe_?(anatomopatol[oó]gico|patolog[ií]a|radiol[oó]gico|m[eé]dico)|clinical_?notes?|discharge_?summary', 0.85]),
  byType(STRING(30)))

domain('AR_SALUD_RESULTADO_ESTUDIO', 'AR_CM_ALFANUM',
  byName(
    ['resultado_?(del_?)?(estudio|an[aá]lisis|laboratorio|pcr|serolog[ií]a|biopsia|glucemia|papanicolaou|pap|hisopado|covid)|(estudio|an[aá]lisis)_?(resultado|laboratorio)|glucemia|hemoglobina_?glicosilada|hba1c|colesterol|imc|presi[oó]n_?arterial|tensi[oó]n_?arterial|test_?(de_?)?embarazo|toxicol[oó]gico|alcoholemia|test_?(de_?)?drogas|lab_?results?|test_?results?', 0.8],
    ['resultado', 0.5],
  ))

// HIV, viral hepatitis, tuberculosis and STIs (Ley 27.675): confidentiality and a ban on
// discriminating by serological status. Suppressed, flags kept.
domain('AR_SALUD_VIH', 'AR_CATEGORIA_SUPRIMIDA',
  byName(['vih(_?(estado|resultado|test|diagn[oó]stico|positivo))?|hiv|sida|aids|serolog[ií]a_?(vih|hiv)|estado_?serol[oó]gico|carga_?viral|cd4|tarv|antirretroviral(es)?|hepatitis_?(b|c|viral)|hbsag|tuberculosis|tbc|its|ets|infecci[oó]n(es)?_?(de_?)?transmisi[oó]n_?sexual|s[ií]filis|vdrl', 0.9]))

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', '0+', '0-']
lookup('AR_GRUPO_SANGUINEO', 'ar-grupos-sanguineos.txt', BLOOD_GROUPS, '0+', 'PRESERVE_LOOKUP_FILE')
domain('AR_SALUD_GRUPO_SANGUINEO', 'AR_GRUPO_SANGUINEO',
  byName(['grupo_?sangu[ií]neo|grupo_?y_?factor|tipo_?(de_?)?sangre|rh|factor_?rh|gs_?rh|grupo_?rh|abo(_?rh)?|blood_?(type|group)', 0.9]),
  byList([['ar-detectar-grupos-sanguineos.txt', [...BLOOD_GROUPS, 'O+', 'O-', 'a positivo', 'a negativo', 'b positivo', 'b negativo', 'ab positivo', 'ab negativo', '0 positivo', '0 negativo', 'o positivo', 'o negativo'], 0.9]], { reject: 0.4 }))

// Disability: the Certificado Único de Discapacidad (CUD, Ley 22.431) states the type.
const DISABILITIES = ['Motora', 'Auditiva', 'Visual', 'Visceral', 'Intelectual', 'Mental', 'Múltiple', 'Ninguna']
decompose('AR_DISCAPACIDAD', [
  [FLAG, apply('AR_BANDERA')],
  // A CUD number.
  [String.raw`([A-Za-z0-9\-/]*\d{4,}[A-Za-z0-9\-/]*)`, CM],
], apply(lookup('AR_DISCAPACIDAD_TIPO', 'ar-discapacidades.txt', DISABILITIES)), 'Trastorno del espectro autista')
domain('AR_SALUD_DISCAPACIDAD', 'AR_DISCAPACIDAD',
  byName(['discapacidad[a-z_]*|(tipo|cod|codigo|categoria)_?discapacidad|persona_?con_?discapacidad|pcd|cud|certificado_?([uú]nico_?)?(de_?)?discapacidad|n(o|ro|um|umero)_?cud|condici[oó]n_?(de_?)?discapacidad|pensi[oó]n_?(no_?contributiva_?)?(por_?)?invalidez|movilidad_?reducida|disabilit(y|ies)', 0.9]),
  byList([['ar-detectar-discapacidades.txt', [...DISABILITIES, 'motriz', 'física', 'sordera', 'hipoacusia', 'ceguera', 'baja visión', 'cognitiva', 'psicosocial', 'autismo', 'tea', 'ninguna', 'no aplica'], 0.6]], { reject: 0.3 }))

// Occupational health: pre-employment and periodic exams, work accidents and occupational diseases
// (Ley 24.557, ART), sick leave.
categorical('AR_SALUD_LABORAL', 'ar-aptitud-laboral.txt', ['Apto', 'Apto con preexistencias', 'No apto', 'Pendiente'], 'No apto temporariamente')
domain('AR_SALUD_OCUPACIONAL', 'AR_SALUD_LABORAL',
  byName(['aptitud_?(laboral|m[eé]dica|psicof[ií]sica)|examen_?(preocupacional|peri[oó]dico|de_?egreso|psicot[eé]cnico)|preocupacional|accidente_?(de_?)?trabajo|accidente_?in_?itinere|enfermedad_?profesional|siniestro_?art|denuncia_?art|art_?(siniestro|denuncia)|licencia_?(m[eé]dica|por_?enfermedad|psiqui[aá]trica|por_?maternidad)|d[ií]as_?(de_?)?licencia|ausentismo|carpeta_?m[eé]dica|incapacidad(_?(laboral|laborativa|porcentaje))?|comisi[oó]n_?m[eé]dica|preexistencias?', 0.85]),
  byList([['ar-detectar-aptitud-laboral.txt', ['apto', 'no apto', 'apto con preexistencias', 'pendiente', 'apto condicional'], 0.6]], { reject: 0.3 }))

// Sexual and reproductive health, including the voluntary interruption of pregnancy (Ley 27.610,
// which orders confidentiality), and mental health (Ley 26.657). Suppressed, flags kept.
domain('AR_SALUD_REPRODUCTIVA', 'AR_CATEGORIA_SUPRIMIDA',
  byName(['embarazo|embarazada|gestante|gestaci[oó]n|edad_?gestacional|semanas_?(de_?)?gestaci[oó]n|fum|fecha_?[uú]ltima_?menstruaci[oó]n|control_?prenatal|prenatal|parto(_?tipo)?|ces[aá]rea|aborto|ive|ile|interrupci[oó]n_?(voluntaria|legal)(_?del_?embarazo)?|m[eé]todo_?anticonceptivo|anticoncepci[oó]n|anticonceptivo|salud_?(sexual|reproductiva)|fertilidad|fertilizaci[oó]n_?asistida|reproducci[oó]n_?asistida|pregnan(t|cy)|contracepti(on|ve)', 0.9]))

domain('AR_SALUD_MENTAL', 'AR_CATEGORIA_SUPRIMIDA',
  byName(['salud_?mental|trastorno[a-z_]*|psiqui[aá]tri[a-z_]*|psicol[oó]gi[a-z_]*|depresi[oó]n|ansiedad|suicid[a-z_]*|intento_?(de_?)?suicidio|autolesi[oó]n|internaci[oó]n_?involuntaria|consumo_?(problem[aá]tico|de_?(sustancias|alcohol|drogas))|adicci[oó]n(es)?|sedronar|alcoholismo|tabaquismo|mental_?health', 0.9]))

// ── FIN · Financial data (art. 26) ──────────────────────────────────────────

// The Central de Deudores of the BCRA grades each debtor from 1 (normal) to 6 (unrecoverable by
// technical disposition). The situation stays within its band — 1–2, 3–4, 5–6 — so the analysis
// keeps its shape.
decompose('AR_SITUACION_CREDITICIA', [
  [String.raw`(?i)(situaci[oó]n\s*)?([12])`, keep, apply(lookup('AR_SITUACION_1_2', 'ar-situacion-1-2.txt', ['1', '2']))],
  [String.raw`(?i)(situaci[oó]n\s*)?([34])`, keep, apply(lookup('AR_SITUACION_3_4', 'ar-situacion-3-4.txt', ['3', '4']))],
  [String.raw`(?i)(situaci[oó]n\s*)?([56])`, keep, apply(lookup('AR_SITUACION_5_6', 'ar-situacion-5-6.txt', ['5', '6']))],
  // A credit bureau score keeps its number of digits.
  [String.raw`(\d{2,4})`, DIGITS],
  [FLAG, apply('AR_BANDERA')],
], apply(lookup('AR_ESTADO_CREDITO', 'ar-estados-credito.txt', ['Normal', 'Riesgo bajo', 'Riesgo medio', 'Riesgo alto', 'Irrecuperable', 'Con seguimiento especial', 'Con problemas', 'En gestión judicial', 'Refinanciado', 'Sin deudas informadas'])), '3')
domain('AR_FIN_SITUACION_CREDITICIA', 'AR_SITUACION_CREDITICIA',
  byName(['situaci[oó]n_?(crediticia|bcra|deudor|central_?deudores)|sit_?(bcra|deudor|cred)|central_?(de_?)?deudores|cendeu|clasificaci[oó]n_?(del_?)?deudor|score(_?(crediticio|veraz|nosis|equifax|interno))?|puntaje_?crediticio|veraz|nosis|equifax|informe_?comercial|cheques_?rechazados|d[ií]as_?(de_?)?(atraso|mora)|morosidad|moroso|en_?mora|gesti[oó]n_?judicial|credit_?score|credit_?rating', 0.9]),
  byList([['ar-detectar-situacion-crediticia.txt', ['normal', 'riesgo bajo', 'riesgo medio', 'riesgo alto', 'irrecuperable', 'con seguimiento especial', 'con problemas', 'alto riesgo de insolvencia', 'irrecuperable por disposición técnica', 'situación 1', 'situación 2', 'situación 3', 'situación 4', 'situación 5', 'situación 6'], 0.7]], { reject: 0.3 }))

algorithm('AR_VALOR_DEUDA', 'characterMapping.NumericMapping', { minValue: 10000, maxValue: 500000000 }, '1850000')
domain('AR_FIN_DEUDA', 'AR_VALOR_DEUDA',
  byName(['saldo_?(deudor|deuda|cr[eé]dito|capital|pr[eé]stamo|adeudado|tarjeta)|monto_?(de_?la_?)?(deuda|cuota|cr[eé]dito|pr[eé]stamo|adeudado|en_?mora|financiado)|importe_?(deuda|cuota|adeudado|mora)|deuda(_?total)?|l[ií]mite_?(de_?)?(cr[eé]dito|compra|tarjeta)|cuota_?mensual|loan_?(amount|balance)|outstanding_?balance|debt', 0.85]),
  byType(NUMBER()))

algorithm('AR_INGRESOS', 'characterMapping.NumericMapping', { minValue: 300000, maxValue: 30000000 }, '1450000')
domain('AR_FIN_INGRESOS', 'AR_INGRESOS',
  byName(['salario(_?(b[aá]sico|mensual|bruto|neto))?|sueldo(_?(b[aá]sico|bruto|neto|mensual))?|remuneraci[oó]n(_?(bruta|neta|total|imponible))?|haberes?|ingresos?(_?(mensuales?|totales?|familiares?|declarados?|netos?|brutos?))?|neto_?a_?cobrar|bruto_?mensual|facturaci[oó]n_?anual|salary|income|wages?', 0.85]),
  byType(NUMBER()))

algorithm('AR_PATRIMONIO', 'characterMapping.NumericMapping', { minValue: 1000000, maxValue: 3000000000 }, '85000000')
domain('AR_FIN_PATRIMONIO', 'AR_PATRIMONIO',
  byName(['patrimonio(_?(neto|total))?|bienes_?personales|activos?_?(totales?)?|valuaci[oó]n_?(fiscal|inmueble|veh[ií]culo)|valor_?(del_?)?(inmueble|veh[ií]culo|bienes|tasaci[oó]n|mercado)|tasaci[oó]n|saldo_?(cuenta|caja_?ahorro|plazo_?fijo|inversi[oó]n)|plazo_?fijo(_?monto)?|tenencia_?(d[oó]lares|moneda_?extranjera|cripto)|net_?worth|account_?balance', 0.85]),
  byType(NUMBER()))

algorithm('AR_VALOR_JUBILACION', 'characterMapping.NumericMapping', { minValue: 250000, maxValue: 12000000 }, '420000')
domain('AR_FIN_JUBILACION', 'AR_VALOR_JUBILACION',
  byName(['haber_?(jubilatorio|previsional|mensual)|jubilaci[oó]n_?(monto|haber|importe)|pensi[oó]n_?(monto|haber|importe)|monto_?(jubilaci[oó]n|pensi[oó]n|asignaci[oó]n|prestaci[oó]n|beneficio)|importe_?(asignaci[oó]n|beneficio|prestaci[oó]n)|cuota_?alimentaria|pension_?amount', 0.9]),
  byType(NUMBER()))

// Social benefits of ANSES and national programmes: being a beneficiary tells about income, children,
// pregnancy or disability.
const PROGRAMMES = ['Asignación Universal por Hijo', 'Asignación por Embarazo', 'Prestación Alimentar', 'Progresar', 'Asignaciones familiares', 'Jubilación', 'Pensión no contributiva', 'Pensión Universal para el Adulto Mayor', 'Volver al Trabajo', 'Acompañamiento Social', 'Programa Hogar', 'Subsidio de energía', 'Ninguno']
categorical('AR_PROGRAMA_SOCIAL', 'ar-programas-sociales.txt', PROGRAMMES, 'Potenciar Trabajo')
domain('AR_FIN_PROGRAMA_SOCIAL', 'AR_PROGRAMA_SOCIAL',
  byName(['programa_?social|plan_?social|beneficiario_?(programa|plan|asignaci[oó]n|auh|anses)|prestaci[oó]n_?(social|anses|alimentar)|asignaci[oó]n_?(universal|por_?hijo|por_?embarazo|familiar)|auh|aue|tarjeta_?alimentar|progresar|potenciar_?trabajo|volver_?al_?trabajo|puam|pnc|pensi[oó]n_?no_?contributiva|beneficio_?anses|tipo_?(de_?)?beneficio|segmentaci[oó]n_?(energ[eé]tica|subsidios?)|nivel_?(de_?)?(subsidio|ingresos_?rase)|rase|social_?programme', 0.9]),
  byList([['ar-detectar-programas-sociales.txt', [...PROGRAMMES, 'auh', 'aue', 'tarjeta alimentar', 'potenciar trabajo', 'puam', 'pnc', 'asignación universal', 'nivel 1', 'nivel 2', 'nivel 3', 'n1', 'n2', 'n3', 'ninguno'], 0.8],
    ['ar-detectar-codigos-banderas.txt', ['s', 'n', 'sí', 'no', '1', '2', '3', '4', '5', '6'], 0.3],
  ], { reject: 0.4 }))

// The monotributo category (A to K) is an income band set by the ARCA. It stays within its tier.
decompose('AR_MONOTRIBUTO', [
  [String.raw`(?i)(categor[ií]a\s*)?([A-D])`, keep, apply(lookup('AR_MONOTRIBUTO_A_D', 'ar-monotributo-a-d.txt', ['A', 'B', 'C', 'D']))],
  [String.raw`(?i)(categor[ií]a\s*)?([E-H])`, keep, apply(lookup('AR_MONOTRIBUTO_E_H', 'ar-monotributo-e-h.txt', ['E', 'F', 'G', 'H']))],
  [String.raw`(?i)(categor[ií]a\s*)?([I-K])`, keep, apply(lookup('AR_MONOTRIBUTO_I_K', 'ar-monotributo-i-k.txt', ['I', 'J', 'K']))],
], keep, 'C')
domain('AR_FIN_MONOTRIBUTO', 'AR_MONOTRIBUTO',
  byName(['categor[ií]a_?(de_?)?monotributo|monotributo(_?categor[ií]a)?|cat_?monotributo|categor[ií]a_?(afip|arca)|r[eé]gimen_?simplificado', 0.9]),
  byType(STRING(1, 12)))

// Housing tenure as the 2022 census asks it.
const TENURES = ['Propietario de la vivienda y el terreno', 'Propietario solo de la vivienda', 'Inquilino', 'Ocupante por préstamo', 'Ocupante por trabajo', 'Otra situación']
categorical('AR_TENENCIA_VIVIENDA', 'ar-tenencia-vivienda.txt', TENURES, 'Ocupante de hecho')
domain('AR_FIN_VIVIENDA', 'AR_TENENCIA_VIVIENDA',
  byName(['tenencia_?(de_?)?(la_?)?vivienda|r[eé]gimen_?(de_?)?tenencia|tipo_?(de_?)?tenencia|vivienda_?(propia|alquilada|tipo_?tenencia)|condici[oó]n_?(de_?)?ocupaci[oó]n|housing_?tenure', 0.9]),
  byList([['ar-detectar-tenencia-vivienda.txt', [...TENURES, 'propietario', 'propia', 'inquilino', 'alquila', 'alquilada', 'prestada', 'cedida', 'ocupante', 'toma', 'usurpada'], 0.6]], { reject: 0.3 }))

// ── PENAL · Criminal records and proceedings (art. 7.4) ─────────────────────

categorical('AR_ANTECEDENTES', 'ar-antecedentes.txt', ['No registra antecedentes', 'Registra antecedentes', 'Imputado', 'Procesado', 'Condenado', 'Sobreseído', 'Absuelto', 'Sin información'], 'Condenado por robo en 2019')
domain('AR_PENAL_ANTECEDENTES', 'AR_ANTECEDENTES',
  byName(
    ['antecedentes?(_?(penales|judiciales|policiales|contravencionales))?|certificado_?(de_?)?(antecedentes|reincidencia|buena_?conducta)|reincidencia|registro_?nacional_?(de_?)?reincidencia|rnr|condena(_?(penal|tipo))?|delito(_?(tipo|imputado))?|tipo_?(de_?)?delito|contravenci[oó]n(es)?|situaci[oó]n_?procesal|prisi[oó]n_?preventiva|detenido|privad[oa]_?(de_?)?(la_?)?libertad|interno_?(spf|penitenciario)|reincidente|pedido_?(de_?)?captura|rebeld[ií]a|criminal_?record', 0.95],
    ['estado_?(del_?)?proceso|sentencia|fallo', 0.55],
  ))

// Court file numbers: the national and federal courts write the chamber's code, the number and the
// year (CCC 12345/2023); Buenos Aires criminal investigations, PP-department-office-number-year. The
// number is masked; court, office and year stay.
decompose('AR_EXPEDIENTE', [
  [String.raw`([A-Za-z]{2,4}[\s\-]?)(\d{1,6})(\/\d{2,4}(?:\/[A-Za-z0-9]{1,6})*)`, keep, DIGITS, keep],
  [String.raw`((?:PP|IPP)[\s\-]?\d{2}[\s\-]\d{2}[\s\-])(\d{6})([\s\-]\d{2}(?:\/\d{2})?)`, keep, DIGITS, keep],
  [String.raw`(\d{1,6})(\/\d{2,4})`, DIGITS, keep],
], CM, 'CCC 12345/2023')
domain('AR_PENAL_EXPEDIENTE', 'AR_EXPEDIENTE',
  byName(
    ['n(o|ro|um|umero)_?(de_?)?(expediente|causa|legajo_?penal|ipp|sumario|denuncia|carpeta_?judicial)(_?(judicial|penal))?|expediente_?(judicial|penal)|causa_?(penal|judicial|n(o|ro|um|umero))|ipp|cuij|sumario_?policial|denuncia_?(penal|policial)', 0.9],
    ['expediente|causa', 0.5],
  ),
  byPattern([[String.raw`[A-Z]{2,4}\s?\d{1,6}\/\d{4}`, 0.7], [String.raw`PP-\d{2}-\d{2}-\d{6}-\d{2}(\/\d{2})?`, 0.8]], { reject: 0.3 }))

// ── Preset ──────────────────────────────────────────────────────────────────

const referenced = JSON.stringify([domains, algorithms.map((x) => x.config)])
const orphans = algorithms.filter((a) => !referenced.includes(`"${a.name}"`))
if (orphans.length) throw new Error(`algorithms nobody uses: ${orphans.map((a) => a.name).join(', ')}`)
const noInput = algorithms.filter((a) => a.input === undefined)
if (noInput.length) throw new Error(`algorithms without a sample input: ${noInput.map((a) => a.name).join(', ')}`)

// The essential pack: identity documents, names, contact, address and birth date. Loading it brings
// these domains and only what they lean on; the extended pack is everything.
const ESSENTIAL = [
  'AR_L1_DNI', 'AR_L1_CUIT', 'AR_L1_DOCUMENTO_EXTRANJERO', 'AR_L1_PASAPORTE',
  'AR_L1_NOMBRE', 'AR_L1_APELLIDO', 'AR_L1_NOMBRE_COMPLETO', 'AR_L1_EMAIL', 'AR_L1_TELEFONO',
  'AR_L1_DIRECCION', 'AR_L1_DIRECCION_COMPLEMENTO', 'AR_L2_FECHA_NACIMIENTO',
]
const notDomains = ESSENTIAL.filter((name) => !domains.some((d) => d.name === name))
if (notDomains.length) throw new Error(`essential pack names domains the set does not have: ${notDomains.join(', ')}`)

const VERSION = 1
const preset = {
  version: VERSION,
  name: {
    en: 'Argentina — Ley 25.326 (personal data protection)',
    'pt-BR': 'Argentina — Ley 25.326 (proteção de dados pessoais)',
    es: 'Argentina — Ley 25.326 (protección de los datos personales)',
  },
  summary: {
    en: 'Discovers and masks Argentine personal data under Law 25.326: direct identifiers (DNI, CUIT and CUIL with a valid check digit, CBU and CVU with valid check digits, names, contact, address, company names), quasi-identifiers (birth date, localidad, partido, postal code), the sensitive data of articles 2 and 7 — racial and ethnic origin, politics, religious, philosophical or moral convictions, trade unions, health, sexual life — plus genetic and biometric data, gender identity, victims of gender violence, financial data (BCRA debtor situation, social benefits) and criminal records.',
    'pt-BR': 'Descobre e mascara dados pessoais argentinos segundo a Lei 25.326: identificadores diretos (DNI, CUIT e CUIL com dígito verificador válido, CBU e CVU com dígitos verificadores válidos, nomes, contato, endereço, razão social), quase-identificadores (data de nascimento, localidade, partido, código postal), os dados sensíveis dos artigos 2 e 7 — origem racial e étnica, política, convicções religiosas, filosóficas ou morais, sindicatos, saúde, vida sexual —, além de dados genéticos e biométricos, identidade de gênero, vítimas de violência de gênero, dados financeiros (situação na Central de Deudores do BCRA, benefícios sociais) e antecedentes criminais.',
    es: 'Descubre y enmascara datos personales argentinos conforme a la Ley 25.326: identificadores directos (DNI, CUIT y CUIL con dígito verificador válido, CBU y CVU con dígitos verificadores válidos, nombres, contacto, domicilio, razón social), cuasi-identificadores (fecha de nacimiento, localidad, partido, código postal), los datos sensibles de los artículos 2 y 7 — origen racial y étnico, política, convicciones religiosas, filosóficas o morales, afiliación sindical, salud, vida sexual —, y además datos genéticos y biométricos, identidad de género, víctimas de violencia de género, datos financieros (situación en la Central de Deudores del BCRA, prestaciones sociales) y antecedentes penales.',
  },
  profileSet: {
    name: `AR - Ley 25.326 - v${VERSION}`,
    description: 'Identificadores directos, cuasi-identificadores, datos sensibles (arts. 2 y 7), datos genéticos y biométricos, identidad de género, datos de salud, datos financieros (art. 26) y antecedentes penales, conforme a la Ley 25.326 de Protección de los Datos Personales.',
    threshold: 60,
    classifiers: classifiers.map((c) => c.name),
  },
  packs: {
    essential: {
      description: 'Paquete esencial de la Ley 25.326: DNI, CUIT y CUIL, documentos de extranjeros, pasaporte, nombres, contacto, domicilio y fecha de nacimiento.',
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

const smallDepartamentos = departamentoPlaces.filter((d) => d.small)
const smallGobiernos = gobiernoPlaces.filter((g) => g.small)
const smallLocalidades = localidadPlaces.filter((l) => l.small)
console.log(`${domains.length} domains, ${classifiers.length} classifiers, ${algorithms.length} algorithms, ${files.size} files`)
console.log(`departamentos: ${smallDepartamentos.length} of ${DEPARTAMENTOS.length} under ${SMALL_PLACE}, ${departamentoTable.names} names generalized, ${departamentoTable.table.length} table lines`)
console.log(`gobiernos locales: ${smallGobiernos.length} of ${GOBIERNOS.length} under ${SMALL_PLACE}; localidades: ${smallLocalidades.length} of ${LOCALIDADES.length} in them or outside any; ${localidadTable.names} names generalized, ${localidadTable.table.length} table lines`)
console.log(`codes: ${codePairs.length} table lines`)
