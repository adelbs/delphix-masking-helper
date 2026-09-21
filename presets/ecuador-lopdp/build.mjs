#!/usr/bin/env node
/**
 * Builds the Ecuador (Ley Orgánica de Protección de Datos Personales) pre-configured profile set:
 * preset.json and files/.
 *
 *   node presets/ecuador-lopdp/build.mjs
 *
 * source/ holds the hand-kept lists — given names, surnames, ciudadelas and barrios — and the
 * geography of the 2022 census: the 1,040 parroquias and the 224 cantones with their DPA code,
 * their population and their location. Everything in files/ and preset.json is generated from them
 * and from the definitions below — edit here, then build, then run verify.mjs.
 *
 * Structure of the set
 *   L1     direct identifiers      cédula and RUC with a valid check digit, foreigner documents,
 *                                  passport, civil registry, IESS, names, contact, address,
 *                                  accounts, cards, devices, cookies, plates, property, free text
 *   L2     quasi-identifiers       birth date, age, sex, parroquia, cantón and their DPA codes,
 *                                  postal code, ciudadela, marital status, occupation, employer,
 *                                  education
 *   L3     sensitive data          art. 4: etnia, **identidad cultural**, identidad de género,
 *                                  religión, ideología, filiación política, **condición
 *                                  migratoria**, orientación sexual, biometric and genetic data,
 *                                  and the stateless and refugee status the same article names
 *   SALUD  health data             art. 4 and art. 25 c): clinical record, insurance, ICD-10,
 *                                  procedures, medicines, HIV, disability (art. 25 d), occupational,
 *                                  reproductive and mental health
 *   FIN    financial data          the datos crediticios of arts. 28 and 29, debt, income, assets,
 *                                  pensions, social programmes, housing
 *   PENAL  criminal records        **pasado judicial is sensitive data in Ecuador** (art. 4):
 *                                  record certificates and court file numbers
 */
import fs from 'node:fs'
import nodePath from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = nodePath.dirname(fileURLToPath(import.meta.url))
const SOURCE = nodePath.join(HERE, 'source')
const FILES = nodePath.join(HERE, 'files')

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
  description: 'Nombre de la columna (y variantes usadas en sistemas ecuatorianos).',
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
const CIUDADELAS = unique(readLines('ciudadelas.txt'))

const CANTONES = readLines('cantones.tsv').map((line) => {
  const [code, name, provinceCode, province, lat, lon, population] = line.split('\t')
  return { code, name, provinceCode, province, lat: Number(lat), lon: Number(lon), population: Number(population), aliases: [] }
})
const cantonByCode = new Map(CANTONES.map((c) => [c.code, c]))
const PARROQUIAS = readLines('parroquias.tsv').map((line) => {
  const [code, name, cantonCode, canton, provinceCode, province, lat, lon, population] = line.split('\t')
  return { code, name, cantonCode, canton, provinceCode, province, lat: Number(lat), lon: Number(lon), population: Number(population), aliases: [] }
})
if (CANTONES.length !== 224) throw new Error(`expected 224 cantones, found ${CANTONES.length}`)
if (PARROQUIAS.length !== 1040) throw new Error(`expected 1,040 parroquias, found ${PARROQUIAS.length}`)
for (const p of PARROQUIAS) {
  if (!/^\d{6}$/.test(p.code) || p.code.slice(0, 4) !== p.cantonCode || p.code.slice(0, 2) !== p.provinceCode) throw new Error(`${p.name}: bad DPA code`)
  if (Number.isNaN(p.lat) || Number.isNaN(p.lon) || !cantonByCode.has(p.cantonCode)) throw new Error(`${p.name}: no location or cantón`)
}
const PROVINCES = unique(PARROQUIAS.map((p) => p.province))
if (PROVINCES.length !== 25) throw new Error(`expected the 24 provincias and the zona no delimitada, found ${PROVINCES.length}`)

// ── Shared algorithms ───────────────────────────────────────────────────────

// Vowels map to vowels and consonants to consonants, so a masked document number keeps its
// structure; digits map to digits. Separators are in no group and stay. minMaskedPositions 0 lets
// a placeholder such as "N/A" through instead of failing the row.
algorithm('EC_CM_ALFANUM', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'AEIOU', 'BCDFGHJKLMNPQRSTVWXYZ', 'aeiou', 'bcdfghjklmnpqrstvwxyz', 'ÁÉÍÓÚÜ', 'áéíóúü'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, 'A1234567')
// Digits only: the hyphens of a cédula or a phone stay.
algorithm('EC_CM_DIGITOS', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '1710034065')
// Digits and upper-case letters, one group each: a plate stays a plate.
algorithm('EC_CM_DIGITOS_LETRAS', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, 'PCA-1234')
// Hex letters form their own group, so a MAC, UUID or IPv6 stays valid hex.
algorithm('EC_CM_HEX', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'abcdef', 'ABCDEF', 'ghijklmnopqrstuvwxyz', 'GHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '3c:22:fb:9a:10:e4')
decompose('EC_REDACTAR', [['(.+)', { type: 'REDACT', redactCharacter: 'X' }]], keep, 'clave123')
lookup('EC_SUPRIMIR', 'ec-sin-informacion.txt', ['Sin información'], 'Trastorno depresivo recurrente', 'PRESERVE_LOOKUP_FILE')

// Yes/no columns keep their vocabulary: a CHAR(1) S/N stays S/N.
decompose('EC_BANDERA', [
  [String.raw`(?i)(s[ií]|no)`, apply(lookup('EC_BANDERA_SI_NO', 'ec-bandera-si-no.txt', ['Sí', 'No']))],
  ['(?i)(true|false)', apply(lookup('EC_BANDERA_TRUE_FALSE', 'ec-bandera-true-false.txt', ['true', 'false']))],
  ['(?i)(yes)', apply(lookup('EC_BANDERA_YES_NO', 'ec-bandera-yes-no.txt', ['Yes', 'No']))],
  ['(?i)([sn])', apply(lookup('EC_BANDERA_S_N', 'ec-bandera-s-n.txt', ['S', 'N']))],
  ['(?i)([yx])', apply(lookup('EC_BANDERA_Y_N', 'ec-bandera-y-n.txt', ['Y', 'N']))],
  ['([01])', apply(lookup('EC_BANDERA_0_1', 'ec-bandera-0-1.txt', ['0', '1']))],
], keep, 'S')
const FLAG = String.raw`(?i)(s[ií]|no|true|false|yes|[snyx01])`
/**
 * A categorical attribute: flags stay flags, numeric codes are replaced by another code of `codes`
 * (or get other digits), and any other value is replaced by one from `values` — or suppressed, when
 * no list is given.
 */
function categorical(name, fileName, values, input, codes) {
  const replacement = values ? lookup(`${name}_LISTA`, fileName, values) : 'EC_SUPRIMIR'
  const code = codes ? apply(lookup(`${name}_CODIGO`, fileName.replace(/\.txt$/, '-codigos.txt'), codes)) : apply('EC_CM_ALFANUM')
  return decompose(name, [[FLAG, apply('EC_BANDERA')], [String.raw`(\d{1,6})`, code]], apply(replacement), input)
}
categorical('EC_CATEGORIA_SUPRIMIDA', null, null, 'Trastorno depresivo recurrente')
const CM = apply('EC_CM_ALFANUM')
const DIGITS = apply('EC_CM_DIGITOS')

// ── L1 · Cédula and RUC ─────────────────────────────────────────────────────
//
// The **cédula de identidad** of the Registro Civil is the key of every Ecuadorian record: ten
// digits, `1710034065`. The first two are the province of issue (01 to 24, or 30 for a citizen
// registered abroad), the third says the holder is a natural person (0 to 5), and the tenth is a
// check digit computed with the coefficients 2 1 2 1 2 1 2 1 2, products over nine reduced by nine,
// ten minus the remainder of the sum modulo ten — which is exactly the **Luhn algorithm**.
//
// The **RUC** of the Servicio de Rentas Internas is thirteen digits. For a natural person it is the
// cédula followed by the establishment code `001`; the third digit decides: 0 to 5 a natural person,
// 6 a public body, 9 a private company. Only the natural person is a data subject — art. 4 defines
// the titular as a natural person — so a RUC whose third digit is 6 or 9 is left as it is.
//
// The Masking Engine's Payment Card framework keeps the Luhn residue of its input, so a valid cédula
// masks to another valid cédula in one step; `preserve` keeps the leading digits, and three of them
// keep the province of issue and the natural-person digit. The province stays for the same reason
// the provincia column stays: the set generalizes below it, not at it.
algorithm('EC_CEDULA_LUHN', 'characterMapping.PaymentCard', { minMaskedPositions: 1, preserve: 3 }, '1710034065')

const CEDULA_SHAPE = String.raw`(?:[0-2]\d|30)[0-5]\d{7}`
decompose('EC_CEDULA', [
  [`(${CEDULA_SHAPE})`, apply('EC_CEDULA_LUHN')],
  // Written with the check digit apart: 171003406-5.
  [String.raw`((?:[0-2]\d|30)[0-5]\d{6})([\s\-])(\d)`, apply('EC_CM_DIGITOS'), keep, DIGITS],
], DIGITS, '1710034065')

decompose('EC_RUC', [
  // A natural person's RUC is the cédula plus the establishment code.
  [`(${CEDULA_SHAPE})(00\\d)`, apply('EC_CEDULA_LUHN'), keep],
  // A public body (6) or a private company (9) is not a natural person: the law does not reach it.
  [String.raw`(\d{2}[69]\d{10})`, keep],
], DIGITS, '1710034065001')

// A document column holds cédulas, RUCs and passports: each value goes by its shape.
decompose('EC_DOCUMENTO', [
  [`(${CEDULA_SHAPE}00\\d)`, apply('EC_RUC')],
  [String.raw`(\d{2}[69]\d{10})`, keep],
  [`(${CEDULA_SHAPE})`, apply('EC_CEDULA')],
  // The cédula written with its check digit apart: 171003406-5.
  [String.raw`((?:[0-2]\d|30)[0-5]\d{6}[\s\-]\d)`, apply('EC_CEDULA')],
], CM, '1710034065')

const DOC_OWNER = 'cliente|cli|paciente|pac|usuario|afiliado|asegurado|beneficiario|benef|titular|empleado|emp|trabajador|colaborador|alumno|estudiante|deudor|codeudor|garante|solicitante|propietario|arrendatario|inquilino|conductor|responsable|representante|apoderado|persona|ciudadano|elector|votante|contribuyente|proveedor|socio|conyuge|conviviente|padre|madre|hijo|familiar|jubilado|pensionista|aportante|derechohabiente'
domain('EC_L1_CEDULA', 'EC_DOCUMENTO',
  byName(
    [`c[eé]dula(_?(de_?)?(identidad|ciudadan[ií]a))?|ci|n(o|ro|um|umero)_?(c[eé]dula|documento|doc|identificaci[oó]n|id(ent)?)|doc_?identidad|nro_?doc|num_?doc|identificacion|(${DOC_OWNER})_?(cedula|doc|documento)|cedula_?(${DOC_OWNER})`, 0.9],
    ['documento|doc', 0.6],
  ),
  byType(STRING(10), NUMBER(10)),
  byPattern([
    [String.raw`(0[1-9]|1\d|2[0-4]|30)[0-5]\d{7}`, 0.8],
    [String.raw`\d{10}`, 0.5],
  ], { reject: 0.3 }))

domain('EC_L1_RUC', 'EC_RUC',
  byName([`ruc[a-z0-9_]*|n(o|ro|um|umero)_?ruc|registro_?[uú]nico_?(de_?)?contribuyentes?|(${DOC_OWNER})_?ruc|ruc_?(${DOC_OWNER})|id_?tributario|tax_?id`, 0.9]),
  byPattern([[String.raw`(0[1-9]|1\d|2[0-4]|30)[0-9]\d{7}00\d`, 0.85], [String.raw`\d{13}`, 0.5]], { reject: 0.3 }))

// ── L1 · Other identity documents ───────────────────────────────────────────

// Art. 4 makes the condición migratoria sensitive; the document that carries it is an identifier.
domain('EC_L1_DOCUMENTO_EXTRANJERO', 'EC_CM_ALFANUM',
  byName(['c[eé]dula_?(de_?)?extranjer[ií]a|carn[eé]_?(de_?)?(extranjer[ií]a|refugiado|solicitante)|documento_?(de_?)?extranjer[oa]|doc_?extranjero|visa(_?(n(o|ro|um|umero)|tipo|categor[ií]a))?|n(o|ro|um|umero)_?(visa|refugiado|extranjer[ií]a)|permiso_?(de_?)?(residencia|trabajo)|amparo_?(legal|migratorio)|n(o|ro|um|umero)_?(de_?)?(tr[aá]mite_?migratorio|movimiento_?migratorio)', 0.85]))

domain('EC_L1_PASAPORTE', 'EC_CM_ALFANUM',
  byName(['pasaporte[a-z0-9_]*|n(o|ro|um|umero)_?pasaporte|passport[a-z0-9_]*', 0.9]),
  byPattern([[String.raw`[A-Z]{1,3}\d{6,8}`, 0.4]], { reject: 0.3 }))

// The Dirección General de Registro Civil, Identificación y Cedulación keeps the civil registry.
domain('EC_L1_ACTA', 'EC_CM_ALFANUM',
  byName(['acta_?(de_?)?(nacimiento|matrimonio|defunci[oó]n|uni[oó]n_?de_?hecho)(_?(n(o|ro|um|umero)|folio|tomo))?|n(o|ro|um|umero)_?acta|partida_?(de_?)?(nacimiento|matrimonio|defunci[oó]n)|tomo(_?(acta|registro))?|folio(_?(acta|registro))?|n(o|ro|um|umero)_?(de_?)?inscripci[oó]n_?civil|registro_?civil', 0.85]))

// The IESS numbers the insured; ISSFA and ISSPOL do the same for the armed forces and the police.
domain('EC_L1_SEGURO_SOCIAL', 'EC_CM_ALFANUM',
  byName(['iess[a-z0-9_]*|n(o|ro|um|umero)_?(iess|afiliaci[oó]n|afiliado|asegurado|patronal)|c[oó]digo_?(de_?)?(afiliado|asegurado|patronal)|issfa|isspol|seguro_?social_?campesino|n(o|ro|um|umero)_?(de_?)?(historia_?laboral|aportaciones)|biess', 0.85]))

domain('EC_L1_CODIGO_ESTUDIANTE', 'EC_CM_ALFANUM',
  byName(['c[oó]digo_?(de_?)?(estudiante|alumno|matr[ií]cula|educando)|cod_?(alumno|estudiante)|n(o|ro|um|umero)_?(de_?)?(matr[ií]cula|carn[eé]_?estudiantil)|carn[eé]_?(de_?)?(estudiante|universitario)|id_?(alumno|estudiante)|c[oó]digo_?amie_?(del_?)?estudiante', 0.8]))

domain('EC_L1_REGISTRO_PROFESIONAL', 'EC_CM_ALFANUM',
  byName(['registro_?(senescyt|profesional|de_?t[ií]tulo)|n(o|ro|um|umero)_?(de_?)?(registro_?senescyt|t[ií]tulo|colegiatura)|senescyt|c[oó]digo_?(de_?)?t[ií]tulo|matr[ií]cula_?profesional|licencia_?profesional', 0.85]))

// ── L1 · Names ──────────────────────────────────────────────────────────────

const NOT_A_PERSON = 'producto|prod|item|articulo|empresa|emp|razon|social|comercial|archivo|calle|avenida|pasaje|ciudadela|urbanizacion|barrio|parroquia|canton|provincia|region|depto|dpto|pais|banco|sucursal|agencia|plan|campana|proyecto|servicio|tabla|columna|campo|usuario|host|servidor|dominio|marca|modelo|categoria|tipo|escuela|colegio|institucion|universidad|curso|materia|documento|doc|unidad|clinica|hospital|iess|seguro|area|dependencia|cargo|sistema|app|aplicacion|grupo|lista|reporte|informe|proceso|evento|tarea|perfil|rol|clase|objeto|cuenta|medicamento|diagnostico|estudio|programa|beneficio|partido|sindicato|religion|pueblo|nacionalidad|lengua|idioma|lugar|sede|local|tienda|bodega|proveedor|convenio|contrato|poliza|aseguradora|entidad|organismo|organizacion|parametro|variable|metodo|funcion|indice|job|script|cola|recurso|red|dispositivo|plantilla|imagen|foto|pagina|sitio|modulo|menu|opcion|accion|permiso|concepto|impuesto|moneda|emisor|factura|comprobante|pago|forma|zona|ruta|linea|actividad|rubro|sector|file|table|column|field|user|server|product|company|category|type|school|document|department|system|group|report|role|account|place|store|supplier|contract|device|image|page|module|action|key|label|code|project|city|country|street|bank'
const PERSON_ROLE = 'cliente|cli|paciente|pac|usuario|afiliado|asegurado|beneficiario|benef|titular|empleado|trabajador|colaborador|alumno|estudiante|deudor|codeudor|garante|solicitante|propietario|arrendatario|inquilino|conductor|responsable|representante|apoderado|persona|ciudadano|contribuyente|madre|padre|conyuge|conviviente|contacto|referencia|victima|denunciante|procesado|testigo|medico|docente|socio|heredero|donante|tutor|jubilado|pensionista|derechohabiente|customer|patient|employee|member|holder|mother|father|spouse|contact|person|student|driver|owner'
const PARTICLES = String.raw`(?i)(de|del|la|las|los|y|e|san|santa|van|von|di|da)`

algorithm('EC_NOMBRE', 'name.Name', {
  lookupFile: { uri: file('ec-nombres.txt', GIVEN_NAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Narcisa')
algorithm('EC_APELLIDO', 'name.Name', {
  lookupFile: { uri: file('ec-apellidos.txt', SURNAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Zambrano')
// A word of a name. "de", "del", "la" stay where they are: "María de los Ángeles".
decompose('EC_PALABRA_NOMBRE', [[PARTICLES, keep]], apply('EC_NOMBRE'), 'Gioconda')
decompose('EC_PALABRA_APELLIDO', [[PARTICLES, keep]], apply('EC_APELLIDO'), 'Cedeño')
const N = apply('EC_PALABRA_NOMBRE')
const S = apply('EC_PALABRA_APELLIDO')

decompose('EC_NOMBRES', [
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, N],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, N, N],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, N, N],
], CM, 'María de los Ángeles')
decompose('EC_APELLIDOS', [
  [String.raw`(\S+)`, S],
  [String.raw`(\S+)\s+(\S+)`, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, S, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, S, S, S, S],
], CM, 'Zambrano Cedeño')
// Ecuadorian order: one or two given names, the father's surname and the mother's surname. Two
// words are a given name and a surname; three, a given name and two surnames; four, two and two.
decompose('EC_NOMBRE_COMPLETO', [
  [String.raw`([^,]+),\s*(.+)`, apply('EC_APELLIDOS'), apply('EC_NOMBRES')],
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, S, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, N, S, S, S],
], CM, 'Luis Alberto Zambrano Cedeño')
const NAME_WORDS = ['de', 'del', 'la', 'las', 'los', 'y']

domain('EC_L1_NOMBRE', 'EC_NOMBRES',
  byName(
    ['primer_?nombre|segundo_?nombre|nombres?_?(de_?)?pila|pri(mer)?_?nom|seg(undo)?_?nom|nombre_?1|nombre_?2|first_?names?|given_?names?|fname|middle_?names?|nombres(?!_?(completos?|y_?apellidos?|apellidos?))', 0.85],
    [`nombre(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|apellidos?|usuario|corto|largo))|nom(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}))|name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))`, 0.5],
  ),
  byList([['ec-detectar-nombres.txt', [...GIVEN_NAMES, ...NAME_WORDS], 0.7]], { tokenize: true, reject: 0.3 }))

domain('EC_L1_APELLIDO', 'EC_APELLIDOS',
  byName(['apellidos?|primer_?apellido|segundo_?apellido|apellido_?(1|2|paterno|materno|casada)|ape_?(1|2|pat|mat)|ap_?(paterno|materno)|last_?names?|surnames?|family_?names?|lname', 0.85]),
  byList([['ec-detectar-apellidos.txt', [...SURNAMES, ...NAME_WORDS], 0.7]], { tokenize: true, reject: 0.3 }))

domain('EC_L1_NOMBRE_COMPLETO', 'EC_NOMBRE_COMPLETO',
  byName(
    [`nombres?_?(completos?|y_?apellidos?|apellidos?)|apellidos?_?(y_?)?nombres?|nombre_?(del_?|de_?la_?)?(${PERSON_ROLE})|(${PERSON_ROLE})_?(nombre|nom)|nom_?(${PERSON_ROLE})|nombre_?(madre|padre|tutor|conyuge|conviviente|contacto_?emergencia|referencia)|full_?name|person_?name`, 0.9],
    ['madre|padre|tutor|conyuge|conviviente|representante_?legal|apoderado|garante|beneficiario|heredero|titular|referencia_?(personal|familiar)', 0.6],
    [`nombre(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|apellidos?|usuario|corto|largo))|nom(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}))|name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))`, 0.5],
  ),
  byList([['ec-detectar-nombres.txt', [...GIVEN_NAMES, ...NAME_WORDS], 0.65], ['ec-detectar-apellidos.txt', [...SURNAMES, ...NAME_WORDS], 0.65]], { tokenize: true, reject: 0.3 }))

// A persona natural with a business trades under a name of her own, beside the RUC that names her.
lookup('EC_RAZON_SOCIAL', 'ec-razones-sociales.txt', ['Comercial Andina Cía. Ltda.', 'Distribuidora del Pacífico S.A.', 'Importadora Los Andes Cía. Ltda.', 'Transportes Mitad del Mundo S.A.', 'Agrícola El Oro S.A.', 'Exportadora Bananera Costa S.A.', 'Constructora Chimborazo Cía. Ltda.', 'Textiles Otavalo Cía. Ltda.', 'Pesquera Manta S.A.', 'Florícola Cayambe S.A.', 'Servicios Integrales Quito Cía. Ltda.', 'Comercializadora Guayas S.A.', 'Laboratorio Vida Sana Cía. Ltda.', 'Seguridad Cóndor Cía. Ltda.', 'Editorial Equinoccio Cía. Ltda.', 'Hotel Mirador del Valle S.A.', 'Panadería Buen Pan Cía. Ltda.', 'Estudio Contable Asociados Cía. Ltda.', 'Turismo Galápagos Tours S.A.', 'Cacao Fino de Aroma S.A.'], 'Corporación Comercial Ecuatoriana S.A.', 'PRESERVE_LOOKUP_FILE')
domain('EC_L1_RAZON_SOCIAL', 'EC_RAZON_SOCIAL',
  byName(['raz[oó]n_?social|razonsocial|nombre_?(comercial|de_?la_?empresa|empresa)|denominaci[oó]n_?social|nombre_?legal|business_?name|company_?name|legal_?name', 0.85]))

// ── L1 · Contact ────────────────────────────────────────────────────────────

decompose('EC_EMAIL', [
  // The top-level domain becomes .test, reserved for tests: a masked address can never deliver.
  [String.raw`([^@\s]+)@([^@\s]+)\.([A-Za-z]{2,24}(?:\.[A-Za-z]{2})?)`, CM, CM, redactAs('test')],
], CM, 'narcisa.zambrano@gmail.com')
domain('EC_L1_EMAIL', 'EC_EMAIL',
  byName(['e_?mail[a-z0-9_]*|mail[a-z0-9_]*|correo(_?electr[oó]nico)?[a-z0-9_]*|dir_?correo|direcci[oó]n_?(de_?)?correo|direcci[oó]n_?electr[oó]nica', 0.85]),
  byType(STRING(5)),
  byPattern([[String.raw`[A-Za-z0-9._%+'\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}`, 1]], { reject: 0.2 }))

// A mobile is ten digits starting 09; a landline is a two-digit area code — 02 Pichincha, 04
// Guayas, 07 Azuay and El Oro — and seven digits. The country code, the 9 of a mobile and the area
// code stay, so a masked number keeps saying mobile or landline and which region.
decompose('EC_TELEFONO', [
  // The prefix is kept whole and the rest mapped digit by digit, so any grouping of the eight
  // remaining digits — 099 123 4567, 99 123 4567, 0991234567 — comes out with its own spacing.
  [String.raw`(\+?593[\s\-]?)(0?9)([\s\-]?)([\d\s\-]{8,12})`, keep, keep, keep, DIGITS],
  [String.raw`(0?9)([\s\-]?)([\d\s\-]{8,12})`, keep, keep, DIGITS],
  [String.raw`(\+?593[\s\-]?)?(\(?0?[2-7]\)?)([\s\-]?)([\d\s\-]{6,10})`, keep, keep, keep, DIGITS],
], DIGITS, '+593 99 123 4567')
domain('EC_L1_TELEFONO', 'EC_TELEFONO',
  byName(['tel|tel[eé]fono[a-z0-9_]*|tel_?(fijo|casa|oficina|trabajo|contacto|celular|m[oó]vil|convencional)|celular[a-z0-9_]*|cel|m[oó]vil|whats_?app|convencional|n(o|ro|um|umero)_?(tel|tel[eé]fono|celular|cel|contacto)|fax|phone[a-z0-9_]*|mobile[a-z0-9_]*', 0.85]),
  byPattern([
    [String.raw`(\+?593[\s\-]?)?0?9\d{2}[\s\-]?\d{3}[\s\-]?\d{3}`, 0.9],
    [String.raw`\(?0?[2-7]\)?[\s\-]?\d{3}[\s\-]?\d{4}`, 0.5],
  ], { reject: 0.3 }))

// Ecuadorian addresses name the main street and the cross street — "Av. Amazonas N34-120 y Av.
// República" —, or the ciudadela with manzana, villa and solar. The whole line becomes a
// fictitious one.
const VIAS = ['Av.', 'Avenida', 'Calle', 'Pasaje', 'Psje.', 'Callejón', 'Av. Gral.', 'Malecón']
const VIA_NAMES = ['Amazonas', 'República', '10 de Agosto', '9 de Octubre', '6 de Diciembre', 'Naciones Unidas', 'Eloy Alfaro', 'Shyris', 'Colón', 'Patria', 'Mariscal Sucre', 'Occidental', 'Simón Bolívar', 'De los Granados', 'Gaspar de Villarroel', 'Portugal', 'Brasil', 'América', 'Kennedy', 'Francisco de Orellana', 'Juan Tanca Marengo', 'Las Monjas', 'Víctor Emilio Estrada', 'Rodrigo de Chávez', 'Solano', 'Ordóñez Lasso', 'Remigio Crespo', 'Fray Vicente Solano', 'Flavio Reyes', 'Malecón Simón Bolívar']
lookup('EC_DIRECCION', 'ec-direcciones.txt', (() => {
  const random = seeded(593)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const num = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
  const letter = () => 'ABCDEFGHJKLMN'[Math.floor(random() * 13)]
  const out = new Set()
  while (out.size < 4000) {
    const street = `${pick(VIAS)} ${pick(VIA_NAMES)}`
    const r = random()
    if (r < 0.3) out.add(`${street} N${num(20, 60)}-${num(10, 300)} y ${pick(VIA_NAMES)}`)
    else if (r < 0.5) out.add(`${street} ${num(100, 2500)} y ${pick(VIA_NAMES)}`)
    else if (r < 0.7) out.add(`${pick(CIUDADELAS)}, Mz. ${letter()} Villa ${num(1, 60)}`)
    else if (r < 0.82) out.add(`${pick(CIUDADELAS)}, Solar ${num(1, 40)}`)
    else if (r < 0.92) out.add(`${street} ${num(100, 2500)}, Edificio ${pick(['Torres del Sol', 'Plaza Real', 'El Mirador', 'Altamira', 'Santa Fe'])}, Piso ${num(1, 14)}`)
    else out.add(`Km ${num(1, 60)} V[ií]a a ${pick(['Daule', 'Samborondón', 'la Costa', 'Salinas', 'Baños', 'Machachi'])}`.replace('[ií]', 'í'))
  }
  return [...out]
})(), 'Av. Amazonas N34-120 y Av. República', 'PRESERVE_LOOKUP_FILE')
domain('EC_L1_DIRECCION', 'EC_DIRECCION',
  byName(['(?<!(mac|ip|e_?mail|web|url|correo)_?)direcci[oó]n(?!_?(ip|mac|email|e_?mail|correo|electr[oó]nica|web|url|tipo|id|general|regional))[a-z0-9_]*|domicilio[a-z0-9_]*|dom_?(residencia|particular|laboral|cliente)|residencia|lugar_?(de_?)?residencia|calle(_?(principal|secundaria|y_?n[uú]mero))?|(?<!(mac|ip|e_?mail|web|url)_?)address(?!_?(ip|mac|email|e_?mail|web|url|type|id))[a-z0-9_]*', 0.8]),
  byType(STRING(6)),
  byPattern([
    [String.raw`(?i)(av|avenida|calle|ca|pasaje|psje|callej[oó]n|malec[oó]n)\.?\s+[a-záéíóúñ0-9.' ]{2,40}\s*(n\d{1,2}-\d{1,3}|\d{1,5}).*`, 0.8],
    [String.raw`(?i).*\b(mz|manzana)\.?\s*[a-z0-9]{1,3}\s*(villa|solar|lote|lt)\.?\s*\d{1,3}.*`, 0.8],
    [String.raw`(?i).*\b(cdla|ciudadela|urb|urbanizaci[oó]n|barrio|conjunto|lotizaci[oó]n|cooperativa)\.?\s+[a-záéíóúñ0-9.' ]{2,40}.*`, 0.7],
    [String.raw`(?i)k(m|il[oó]metro)\.?\s*\d{1,3}\s+(v[ií]a|carretera|autopista).*`, 0.7],
  ], { reject: 0.2 }))

domain('EC_L1_DIRECCION_COMPLEMENTO', 'EC_CM_ALFANUM',
  byName(['manzana|mz|solar|villa(_?n(o|ro|um|umero))?|lote|lt|interior|departamento_?(n(o|ro|um|umero)|interior)|dpto_?(n(o|ro|um|umero))?|piso|block|bloque|etapa|edificio|n(o|ro|um|umero)_?(casa|puerta|dpto|interior)|calle_?secundaria|intersecci[oó]n|referencia_?(de_?)?(direcci[oó]n|domicilio)|complemento(_?direcci[oó]n)?', 0.7]))

// ── L1 · Banking, payments, network, devices, vehicles, property ────────────

domain('EC_L1_CUENTA_BANCARIA', 'EC_CM_DIGITOS',
  byName(['cuenta_?(bancaria|banco|corriente|ahorros?|sueldo|n[oó]mina|abono|dep[oó]sito|destino|origen)|n(o|ro|um|umero)_?(de_?)?(cuenta|cta)|nro_?cta|num_?cta|cta_?(cte|corriente|ahorros?|bancaria)|iban|account_?(no|num|number)|bank_?account', 0.85]))

// Payment Card fails a row that has no digits to mask; only values shaped like a card reach it.
algorithm('EC_TARJETA_LUHN', 'characterMapping.PaymentCard', { minMaskedPositions: 6, preserve: 0 }, '4539578763621486')
decompose('EC_TARJETA', [[String.raw`(\d[\d\s\-]{11,22}\d)`, apply('EC_TARJETA_LUHN')]], keep, '4539 5787 6362 1486')
domain('EC_L1_TARJETA', 'EC_TARJETA',
  byName(['tarjeta(_?(cr[eé]dito|d[eé]bito|n(o|ro|um|umero)))?|n(o|ro|um|umero)_?tarjeta|pan|card_?(no|num|number)|credit_?card|tc_?(numero|num|nro)', 0.85]),
  // 0.9, not 1: an IMEI is 15 Luhn-valid digits too, and its own column name should win.
  byPattern([[String.raw`\d{13,19}`, 0.9, { checksum: 'LUHN', clean: String.raw`[\s\-]` }]], { reject: 0.3 }))

domain('EC_L1_BILLETERA', 'EC_CM_ALFANUM',
  byName(['billetera(_?(digital|electr[oó]nica|m[oó]vil))?|wallet(_?(id|address|direccion))?|de_?una|peigo|payphone|dinero_?electr[oó]nico|c[oó]digo_?qr|qr_?(id|codigo)|direcci[oó]n_?(bitcoin|btc|wallet)|btc_?(address|direccion)', 0.85]),
  byPattern([[String.raw`(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,59}`, 0.7]], { reject: 0.3 }))

algorithm('EC_OCTETO', 'characterMapping.NumericMapping', { minValue: 1, maxValue: 254 }, '10')
decompose('EC_IP', [
  [String.raw`(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})`, apply('EC_OCTETO'), apply('EC_OCTETO'), apply('EC_OCTETO'), apply('EC_OCTETO')],
], apply('EC_CM_HEX'), '186.42.163.10')
domain('EC_L1_IP', 'EC_IP',
  byName(['ip|ip_?(address|addr|origen|destino|cliente|usuario|acceso|login|remota|publica)|direcci[oó]n_?ip|dir_?ip|ipv[46]|remote_?addr(ess)?|client_?ip|host_?ip', 0.85]),
  byPattern([
    [String.raw`((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)`, 1],
    [String.raw`[0-9A-Fa-f]{1,4}(:[0-9A-Fa-f]{0,4}){2,7}`, 0.9],
  ], { reject: 0.3 }))

domain('EC_L1_DISPOSITIVO', 'EC_CM_HEX',
  byName(['imei|imsi|iccid|mac|mac_?address|direcci[oó]n_?mac|device_?(id|uuid|serial)|id_?(dispositivo|equipo|celular)|serial_?(equipo|celular|dispositivo)|advertising_?id|idfa|gaid|session_?id|id_?sesi[oó]n', 0.8]),
  byPattern([
    [String.raw`([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}`, 1],
    [String.raw`\d{15}`, 0.8, { checksum: 'LUHN' }],
  ], { reject: 0.3 }))

// The regulation treats the identifier a site stores in the browser as personal data when it
// singles out a person; profiling is defined in art. 4 of the law.
domain('EC_L1_COOKIE', 'EC_CM_ALFANUM',
  byName(['cookie(_?(id|value|valor|nombre))?|cookies|_?ga|_?gid|fbp|fbclid|utm_?(source|medium|campaign|term|content)|id_?(navegador|browser|visitante)|visitor_?id|tracking_?id|client_?id', 0.8]))

// Plates: three letters and three or four digits, and the first letter is the province — A Azuay,
// G Guayas, P Pichincha, M Manabí. The letter class stays a letter and the digits digits.
domain('EC_L1_PLACA', 'EC_CM_DIGITOS_LETRAS',
  byName(['placa(_?(veh[ií]culo|carro|moto|automotor))?|n(o|ro|um|umero)_?placa|matr[ií]cula_?(veh[ií]culo|automotor)|license_?plate|plate(_?(no|number))?', 0.85]),
  byPattern([
    [String.raw`[A-Z]{3}[\s\-]?\d{3,4}`, 0.7],
    [String.raw`[A-Z]{2}[\s\-]?\d{3,4}`, 0.4],
  ], { reject: 0.3 }))

domain('EC_L1_VEHICULO', 'EC_CM_ALFANUM',
  byName(['vin|chasis|n(o|ro|um|umero)_?(chasis|motor|serie|vin)|motor_?n(o|ro|um|umero)|matr[ií]cula(_?veh[ií]culo)?|licencia_?(de_?)?conducir(_?(n(o|ro|um|umero)|tipo))?|n(o|ro|um|umero)_?licencia|puntos_?licencia', 0.85]),
  byPattern([[String.raw`[A-HJ-NPR-Z0-9]{17}`, 0.7]], { reject: 0.3 }))

// The Registro de la Propiedad of each municipality and the municipal cadastre lead to the home.
domain('EC_L1_INMUEBLE', 'EC_CM_ALFANUM',
  byName(['clave_?catastral|c[oó]digo_?(catastral|predial|de_?predio)|n(o|ro|um|umero)_?(de_?)?(predio|inmueble|catastral)|catastro|ficha_?catastral|inscripci[oó]n_?(registral|de_?la_?propiedad)|registro_?(de_?la_?)?propiedad|repertorio|n(o|ro|um|umero)_?(de_?)?medidor', 0.8]))

domain('EC_L1_CONTRATO', 'EC_CM_ALFANUM',
  byName(['n(o|ro|um|umero)_?(contrato|p[oó]liza|cr[eé]dito|pr[eé]stamo|solicitud|expediente_?(administrativo|interno)|tr[aá]mite|referencia|cliente|socio|suscriptor|suministro|medidor|servicio|caso|ticket|beneficio)|contrato_?(n(o|ro|um|umero))|c[oó]digo_?(cliente|socio|empleado|afiliado|suministro)|id_?(cliente|socio|empleado|afiliado)|n(o|ro)_?empleado|c[oó]digo_?(de_?)?(empleado|trabajador|n[oó]mina)', 0.7]))

domain('EC_L1_USUARIO', 'EC_CM_ALFANUM',
  byName(['usuario|user_?name|username|login|alias|apodo|nick(_?name)?|perfil_?(instagram|facebook|twitter|tiktok|linkedin|x)|instagram|facebook|twitter|tiktok|linkedin|red_?social|handle', 0.7]))

domain('EC_L1_CREDENCIAL', 'EC_REDACTAR',
  byName(['contrase[nñ]a|clave(?!_?(catastral|primaria|for[aá]nea|valor|producto))|password|passwd|pwd|pass|hash_?(clave|contrasena|password)|pin|c[oó]digo_?(seguridad|verificaci[oó]n|acceso|otp)|cvv|cvc|token(_?(acceso|refresh|api))?|access_?token|refresh_?token|api_?key|llave_?(api|privada)|secreto|secret|otp|firma_?electr[oó]nica_?(clave|pin)|pregunta_?secreta|respuesta_?secreta|frase_?semilla|seed_?phrase', 0.9]))

decompose('EC_COORDENADA', [
  // The integer part and first decimal stay (about 11 km): the place is generalized, not moved.
  [String.raw`(-?\d{1,3}[.,]\d)(\d+)\s*([,;])\s*(-?\d{1,3}[.,]\d)(\d+)`, keep, DIGITS, keep, keep, DIGITS],
  [String.raw`(-?\d{1,3}[.,]\d)(\d+)`, keep, DIGITS],
], keep, '-0.180653')
domain('EC_L1_GEOLOCALIZACION', 'EC_COORDENADA',
  byName(
    ['lat|latitud|lon|lng|longitud|coordenadas?|coord_?[xy]|geo_?(lat|lon|lng|loc|localizacion|posicion)|georreferenciaci[oó]n|geolocalizaci[oó]n|gps(_?(ubicaci[oó]n|posici[oó]n|coordenadas))?|ubicaci[oó]n_?gps', 0.85],
    ['long', 0.5],
  ),
  byPattern([
    [String.raw`-?[0-5]\.\d{3,}\s*,\s*-(7[5-9]|8[01]|9[01])\.\d{3,}`, 0.9],
    [String.raw`-(7[5-9]|8[01])\.\d{4,}`, 0.5],
    [String.raw`-?[0-5]\.\d{4,}`, 0.4],
  ], { reject: 0.3 }))

// ── L1 · Free text ──────────────────────────────────────────────────────────

algorithm('EC_TEXTO_LIBRE', 'freeTextRedaction.FreeTextRedaction', {
  regularExpressions: [
    String.raw`(?<!\d)(0[1-9]|1\d|2[0-4]|30)[0-5]\d{7}00\d(?!\d)`,
    String.raw`(?<!\d)(0[1-9]|1\d|2[0-4]|30)[0-5]\d{7}(?!\d)`,
    String.raw`(?<!\d)\d{9}-\d(?!\d)`,
    String.raw`[\w.+\-]+@[\w\-]+(\.[\w\-]+)+`,
    String.raw`(?<![\d\-])(\+?593[\s\-]?)?0?9\d{2}[\s\-]?\d{3}[\s\-]?\d{3}(?![\d\-])`,
    String.raw`(?<!\d)\d{13,19}(?!\d)`,
    String.raw`(?<![A-Za-z])[A-Z]{3}[\s\-]?\d{3,4}(?![A-Za-z\d])`,
    String.raw`(?<!\d)(\d{1,3}\.){3}\d{1,3}(?!\d)`,
  ].map((patternString) => ({ patternString })),
  regExRedactValue: '[DATO]',
  lookupFile: { uri: file('ec-texto-nombres.txt', unique([...GIVEN_NAMES, ...SURNAMES].flatMap((v) => [v, v.toUpperCase(), fold(v), fold(v).toUpperCase()]))) },
  lookupFileRedactValue: '[NOMBRE]',
  isDenyList: true,
}, 'Cliente Zambrano, cédula 1710034065, correo n.zambrano@gmail.com, cel 0991234567')

domain('EC_L1_TEXTO_LIBRE', 'EC_TEXTO_LIBRE',
  byName(['observaci[oó]n(es)?|obs|comentarios?|notas?|anotaci[oó]n(es)?|glosa|sustento|descripci[oó]n_?(queja|reclamo|solicitud|caso|hechos|novedad|atenci[oó]n|denuncia)|detalle_?(reclamo|solicitud|caso|atenci[oó]n)|hechos|relato|justificaci[oó]n|(?<!(id|cd|cod|codigo|tipo|fecha|estado|num|nro)_?)mensaje(?!_?(id|tipo|codigo|fecha|estado|cola|log))|texto(_?libre)?|resumen_?(caso|atenci[oó]n)|queja|reclamo|denuncia_?texto|remarks?|comments?|notes?|free_?text|memo', 0.6]),
  byType(STRING(30)),
  byPattern([
    [String.raw`(0[1-9]|1\d|2[0-4]|30)[0-5]\d{7}`, 0.7],
    [String.raw`[\w.+\-]+@[\w\-]+\.[A-Za-z]{2,}`, 0.7],
    [String.raw`0?9\d{2}[\s\-]?\d{3}[\s\-]?\d{3}`, 0.6],
  ], { reject: 0, partial: true }))

// ── L2 · Quasi-identifiers ──────────────────────────────────────────────────

// Small shifts: large enough to break the link to the person, small enough that ages and school
// years move for few people.
algorithm('EC_FECHA_NACIMIENTO', 'dateAlgorithms.DateShift', { minRange: -60, maxRange: 60, unit: 'DAYS', roll: false }, '1985-07-20')
algorithm('EC_FECHA_EVENTO', 'dateAlgorithms.DateShift', { minRange: -30, maxRange: 30, unit: 'DAYS', roll: false }, '2021-03-15')

domain('EC_L2_FECHA_NACIMIENTO', 'EC_FECHA_NACIMIENTO',
  byName(['(fecha|fec|fch|f)_?(de_?)?nac(imiento)?|fnac|fechanac(imiento)?|cumplea[nñ]os|dob|date_?of_?birth|birth_?date|birthday', 0.9]),
  byType(...DATES, STRING(6)))

decompose('EC_ANIO', [[String.raw`(\d{3})(\d)`, keep, DIGITS]], keep, '1985')
domain('EC_L2_ANIO_NACIMIENTO', 'EC_ANIO',
  byName(['a[nñ]o_?(de_?)?nac(imiento)?|anio_?nac(imiento)?|year_?of_?birth|birth_?year|yob', 0.9]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// 37 becomes 3x. From 100 on, 90.
decompose('EC_EDAD', [
  [String.raw`(\d{3,})`, redactAs('90')],
  [String.raw`([1-9])(\d)([.,]\d+)`, keep, DIGITS, keep],
  [String.raw`([1-9])(\d)`, keep, DIGITS],
  [String.raw`(\d)`, DIGITS],
], keep, '37')
domain('EC_L2_EDAD', 'EC_EDAD',
  byName(['edad(_?(actual|a[nñ]os|anios|paciente|afiliado|cliente|al_?(ingreso|diagn[oó]stico|fallecimiento)))?|grupo_?etario|rango_?(de_?)?edad|quinquenio|age(_?(years|group))?', 0.85]),
  byType(NUMBER(0, 6), STRING(0, 6)))

domain('EC_L2_FECHA_EVENTO', 'EC_FECHA_EVENTO',
  byName(['(fecha|fec|fch|f)_?(de_?)?(defunci[oó]n|fallecimiento|muerte|matrimonio|divorcio|ingreso|salida|egreso|alta|baja|retiro|contrataci[oó]n|despido|jubilaci[oó]n|hospitalizaci[oó]n|internamiento|diagn[oó]stico|atenci[oó]n|consulta|parto|detenci[oó]n|sentencia|expedici[oó]n(_?(cedula|documento))?|caducidad_?c[eé]dula|vacunaci[oó]n|cirug[ií]a|accidente|reposo)|fec_?(exp|expedicion|defuncion|ingreso|salida|baja)|date_?of_?(death|marriage|hire|admission|discharge)', 0.8]),
  byType(...DATES, STRING(6)))

// Each vocabulary replaced within itself: M/F stays M/F.
decompose('EC_SEXO', [
  ['(?i)(femenino|masculino)', apply(lookup('EC_SEXO_FEMENINO_MASCULINO', 'ec-sexo-femenino-masculino.txt', ['Femenino', 'Masculino']))],
  ['(?i)(mujer|hombre)', apply(lookup('EC_SEXO_MUJER_HOMBRE', 'ec-sexo-mujer-hombre.txt', ['Mujer', 'Hombre']))],
  ['(?i)(female|male)', apply(lookup('EC_SEXO_FEMALE_MALE', 'ec-sexo-female-male.txt', ['Female', 'Male']))],
  ['(?i)([fm])', apply(lookup('EC_SEXO_F_M', 'ec-sexo-f-m.txt', ['F', 'M']))],
  ['(?i)([hm])', apply(lookup('EC_SEXO_H_M', 'ec-sexo-h-m.txt', ['H', 'M']))],
  ['([12])', apply(lookup('EC_SEXO_1_2', 'ec-sexo-1-2.txt', ['1', '2']))],
], keep, 'F')
domain('EC_L2_SEXO', 'EC_SEXO',
  byName(['sexo(_?(biol[oó]gico|al_?nacer|paciente|afiliado|cliente))?|(tp|tipo|cod|cd|id)_?sexo|g[eé]nero(?!_?(identidad|autopercibido))|sex|gender(?!_?identity)', 0.85]),
  byList([['ec-detectar-sexo.txt', ['f', 'm', 'h', 'femenino', 'masculino', 'mujer', 'hombre', 'female', 'male'], 0.5]], { reject: 0.5 }))

// ── L2 · Where people live ──────────────────────────────────────────────────
//
// Ecuador is divided into 24 provincias, 221 cantones and about 1,040 parroquias, each with a
// six-digit DPA code. The parroquia is the smallest unit a database usually keeps, and 913 of the
// 1,040 had fewer than 20,000 inhabitants in the 2022 census. A birth date, a sex and one of those
// parroquias point at a handful of people, so a small parroquia becomes the nearest one of at least
// 20,000 in its cantón — in its provincia when the cantón has none. The 93 cantones under 20,000
// follow the same rule inside their provincia. The provincias stay.

const distance = (a, b) => {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}
const SMALL_PLACE = 20000
const nearest = (place, candidates) => candidates.reduce((best, x) => (distance(place, x) < distance(place, best) ? x : best))
/**
 * The nearest large place of the first group that has one. Galápagos has no cantón and no parroquia
 * of 20,000, so a province where every place is below the threshold keeps its own: the most
 * populous place of the province, which is the largest group the province can offer.
 */
const nearestIn = (place, large, all, ...groups) => {
  for (const group of groups) {
    const candidates = large.filter(group)
    if (candidates.length) return nearest(place, candidates)
  }
  const inProvince = all.filter((x) => x.provinceCode === place.provinceCode)
  return inProvince.reduce((a, b) => (b.population > a.population ? b : a))
}
const largeParroquias = PARROQUIAS.filter((p) => p.population >= SMALL_PLACE)
const largeCantones = CANTONES.filter((c) => c.population >= SMALL_PLACE)
const spellingsOf = (p) => unique([p.name, ...(p.aliases ?? [])])
const nameKey = (name) => fold(name).toLowerCase()
// How systems write a name: as it is, in capitals, and without accents. The DPA layer publishes the
// names without their accents, so both spellings reach the table.
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
// With the cantón or the provincia, as systems write them to tell homonyms apart.
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

const cantonTo = (c) => nearestIn(c, largeCantones, CANTONES, (x) => x.provinceCode === c.provinceCode)
const cantonPlaces = CANTONES.map((c) => ({ ...c, small: c.population < SMALL_PLACE }))
const cantonPlaceByCode = new Map(cantonPlaces.map((c) => [c.code, c]))
for (const c of cantonPlaces) c.to = c.small ? cantonPlaceByCode.get(cantonTo(c).code) : c
for (const c of cantonPlaces) {
  c.qualifiers = [{ level: 'prov', code: c.provinceCode, name: c.province }]
  c.outQualifiers = c.qualifiers
}

const parroquiaTo = (p) => nearestIn(p, largeParroquias, PARROQUIAS, (x) => x.cantonCode === p.cantonCode, (x) => x.provinceCode === p.provinceCode)
const parroquiaPlaces = PARROQUIAS.map((p) => ({ ...p, small: p.population < SMALL_PLACE }))
const parroquiaByCode = new Map(parroquiaPlaces.map((p) => [p.code, p]))
for (const p of parroquiaPlaces) p.to = p.small ? parroquiaByCode.get(parroquiaTo(p).code) : p
// A parroquia is written with its cantón and with its provincia. The key carries the names as the
// source writes them; the replacement carries the cantón generalized in its turn. Where a cantón
// and its provincia share a name — Loja, Esmeraldas, Pastaza — the two qualifiers write the same
// string, and the provincia keeps it: that is how systems disambiguate homonyms.
const dedupe = (qualifiers) => qualifiers.filter((q) => q.level === 'prov' || !qualifiers.some((x) => x.level === 'prov' && x.name === q.name))
for (const p of parroquiaPlaces) {
  const canton = cantonPlaceByCode.get(p.cantonCode)
  p.qualifiers = dedupe([{ level: 'canton', code: p.cantonCode, name: canton.name }, { level: 'prov', code: p.provinceCode, name: p.province }])
  p.outQualifiers = [{ level: 'canton', name: canton.to.name }, { level: 'prov', name: p.province }]
}

const places = generalization([...parroquiaPlaces, ...cantonPlaces])
cleansing('EC_PARROQUIA', 'ec-parroquias-generalizadas.txt', places.table, 'Chavezpamba', '|')

// Codes of the División Política Administrativa: two digits for the provincia, four for the cantón
// and six for the parroquia. The codes follow the names.
const codePairs = [
  ...parroquiaPlaces.filter((p) => p.small).map((p) => [p.code, p.to.code]),
  ...cantonPlaces.filter((c) => c.small).map((c) => [c.code, c.to.code]),
]
cleansing('EC_DPA', 'ec-dpa-generalizado.txt', codePairs, '170158', '|')

const PERSONAL_WORDS = new Set([...GIVEN_NAMES, ...SURNAMES].map((w) => fold(w).toLowerCase()))
const PROVINCE_NAMES = new Set([...PROVINCES, 'Ecuador'].map((n) => fold(n).toLowerCase()))
const placeNames = (list) => unique(list.flatMap(spellingsOf))
  .filter((n) => !PERSONAL_WORDS.has(fold(n).toLowerCase()) && !PROVINCE_NAMES.has(fold(n).toLowerCase()))

domain('EC_L2_PARROQUIA', 'EC_PARROQUIA',
  byName(['parroquia(?!_?(cod|codigo|id|eclesiastica))(_?(residencia|nacimiento|domicilio))?|cant[oó]n(?!_?(cod|codigo|id))(_?(residencia|nacimiento|domicilio))?|canton(?!_?(cod|codigo|id))|ciudad(_?(residencia|nacimiento|domicilio|cliente))?|(nom|nombre|desc)_?(parroquia|canton|ciudad)|lugar_?(de_?)?nacimiento|city|town', 0.85]),
  byList([['ec-detectar-parroquias.txt', placeNames([...PARROQUIAS, ...CANTONES]), 0.8]], { reject: 0.4 }))

domain('EC_L2_DPA', 'EC_DPA',
  byName(['dpa[a-z0-9_]*|(cod|codigo|cd|id)_?(dpa|parroquia|canton|cant|ciudad|lugar)(_?(inei|inec|censo|res|residencia|nac|nacimiento))?|(cod|codigo)_?(inec|geogr[aá]fico|divisi[oó]n_?pol[ií]tica)|codparroquia|codcanton', 0.85]),
  byPattern([[String.raw`(0[1-9]|1\d|2[0-4]|90)\d{2}(\d{2})?`, 0.4]], { reject: 0.3 }))

lookup('EC_CIUDADELA', 'ec-ciudadelas.txt', CIUDADELAS, 'Cdla. Los Rosales', 'PRESERVE_LOOKUP_FILE')
domain('EC_L2_CIUDADELA', 'EC_CIUDADELA',
  byName(['ciudadela|cdla|urbanizaci[oó]n|urb|barrio(_?(residencia|domicilio))?|lotizaci[oó]n|cooperativa_?(de_?)?vivienda|conjunto_?(habitacional|residencial)|recinto|comuna|sector(_?(vivienda|domicilio|residencia))?|(nom|nombre)_?(ciudadela|barrio|urbanizacion)|neighbou?rhood', 0.8]))

// Six digits since 2007, and the first two are the provincia.
decompose('EC_CODIGO_POSTAL', [[String.raw`(\d{2})(\d{4})`, keep, redactAs('0000')], [String.raw`(\d{2})(\d{3})`, keep, redactAs('000')]], keep, '170150')
domain('EC_L2_CODIGO_POSTAL', 'EC_CODIGO_POSTAL',
  byName(['c[oó]digo_?postal|cod_?postal|codpostal|zip(_?code)?|postal_?code|cp', 0.85]),
  byType(STRING(5, 6), NUMBER(0, 6)))

const MARITAL = ['Soltero/a', 'Casado/a', 'Unión de hecho', 'Separado/a', 'Divorciado/a', 'Viudo/a']
categorical('EC_ESTADO_CIVIL', 'ec-estado-civil.txt', MARITAL, 'Unión libre', ['1', '2', '3', '4', '5', '6'])
domain('EC_L2_ESTADO_CIVIL', 'EC_ESTADO_CIVIL',
  byName(['estado_?civil|est_?civil|(cod|tipo|id)_?estado_?civil|situaci[oó]n_?conyugal|uni[oó]n_?de_?hecho|marital_?status|civil_?status', 0.85]),
  byList([['ec-detectar-estado-civil.txt', [...MARITAL, 'soltero', 'soltera', 'casado', 'casada', 'unión libre', 'union libre', 'unión de hecho', 'conviviente', 'separado', 'separada', 'divorciado', 'divorciada', 'viudo', 'viuda'], 0.7]], { reject: 0.4 }))

lookup('EC_OCUPACION', 'ec-ocupaciones.txt', ['Empleado administrativo', 'Vendedor', 'Cajero', 'Chofer', 'Repartidor', 'Albañil', 'Maestro de obra', 'Docente', 'Enfermero', 'Médico', 'Contador', 'Abogado', 'Ingeniero', 'Programador', 'Recepcionista', 'Personal de limpieza', 'Guardia de seguridad', 'Cocinero', 'Mesero', 'Electricista', 'Plomero', 'Mecánico', 'Agricultor', 'Jornalero', 'Pescador', 'Operario de producción', 'Asesor comercial', 'Agente de call center', 'Bodeguero', 'Estilista', 'Costurera', 'Comerciante informal', 'Ama de casa', 'Estudiante', 'Jubilado', 'Taxista', 'Florícola', 'Bananero'], 'Gerente de operaciones')
decompose('EC_OCUPACION_O_CODIGO', [
  // Clasificación Nacional de Ocupaciones: four digits.
  [String.raw`(\d{2,5})`, DIGITS],
], apply('EC_OCUPACION'), 'Gerente de operaciones')
domain('EC_L2_OCUPACION', 'EC_OCUPACION_O_CODIGO',
  byName(
    ['ocupaci[oó]n|profesi[oó]n|oficio|ciuo|(cod|codigo)_?(ocupacion|profesion|ciuo)|puesto_?(de_?)?trabajo|categor[ií]a_?ocupacional|cargo_?(actual|empleado)|occupation|profession|job_?title', 0.8],
    ['cargo|puesto', 0.5],
  ))

lookup('EC_EMPLEADOR', 'ec-empleadores.txt', ['Distribuidora Andina Cía. Ltda.', 'Constructora Pichincha S.A.', 'Transportes Mitad del Mundo S.A.', 'Supermercados del Litoral S.A.', 'Industrias Metálicas Guayas Cía. Ltda.', 'Clínica Santa Marianita S.A.', 'Unidad Educativa Nuevo Amanecer', 'Servicios Integrales del Austro Cía. Ltda.', 'Agroindustrias Los Ríos S.A.', 'Comercial El Ejido Cía. Ltda.', 'Soluciones Digitales Ecuador S.A.', 'Restaurante Sabor Manabita Cía. Ltda.', 'Hotel Mirador del Pichincha S.A.', 'Laboratorio Vida Sana Cía. Ltda.', 'Seguridad Cóndor Cía. Ltda.', 'Textiles Otavalo Cía. Ltda.', 'Repuestos del Oriente Cía. Ltda.', 'Farmacia El Buen Vecino', 'Logística Puerto Bolívar S.A.', 'Cooperativa Agrícola La Unión', 'Fundación Manos Unidas', 'Panadería Pan de Casa', 'Estudio Contable Asociados Cía. Ltda.', 'Florícola Valle del Sol S.A.'], 'Corporación Comercial Ecuatoriana S.A.', 'PRESERVE_LOOKUP_FILE')
domain('EC_L2_EMPLEADOR', 'EC_EMPLEADOR',
  byName(['empleador(_?(nombre|raz[oó]n_?social|ruc))?|(nombre|nom)_?(empleador|empresa_?donde_?trabaja|patrono)|empresa_?(donde_?)?(trabaja|labora)|lugar_?(de_?)?trabajo|centro_?(de_?)?(trabajo|labores)|entidad_?empleadora|employer(_?name)?|workplace', 0.9]))

const EDUCATION = ['Ninguno', 'Centro de alfabetización', 'Educación inicial', 'Educación general básica', 'Bachillerato', 'Superior no universitaria', 'Superior universitaria', 'Posgrado']
categorical('EC_NIVEL_INSTRUCCION', 'ec-nivel-instruccion.txt', EDUCATION, 'Educación superior en curso', ['1', '2', '3', '4', '5', '6', '7', '8'])
domain('EC_L2_NIVEL_INSTRUCCION', 'EC_NIVEL_INSTRUCCION',
  byName(['escolaridad|nivel_?(educativo|de_?estudios|acad[eé]mico|alcanzado|de_?instrucci[oó]n)|instrucci[oó]n(_?formal)?|grado_?(de_?)?(estudio|instrucci[oó]n|escolaridad)|m[aá]ximo_?nivel|a[nñ]os_?(de_?)?estudio|education(_?level)?', 0.8]),
  byList([['ec-detectar-nivel-instruccion.txt', [...EDUCATION, 'ninguno', 'alfabetización', 'inicial', 'básica', 'basica', 'bachillerato', 'superior', 'universitaria', 'posgrado', 'maestría', 'doctorado', 'analfabeto'], 0.6]], { reject: 0.4 }))

lookup('EC_INSTITUCION_EDUCATIVA', 'ec-instituciones-educativas.txt', ['Unidad Educativa Nuevo Amanecer', 'Unidad Educativa Fiscal 10 de Agosto', 'Escuela de Educación Básica Simón Bolívar', 'Colegio Nacional Mejía', 'Unidad Educativa Particular San José', 'Instituto Superior Tecnológico Central', 'Universidad Nacional del Litoral', 'Universidad Técnica del Norte', 'Escuela Politécnica del Austro', 'Unidad Educativa del Milenio', 'Colegio Particular Santa Mariana', 'Instituto Tecnológico Bolivariano'], 'Universidad Central del Ecuador')
domain('EC_L2_INSTITUCION_EDUCATIVA', 'EC_INSTITUCION_EDUCATIVA',
  byName(['unidad_?educativa|instituci[oó]n_?educativa|centro_?(educativo|de_?estudios)|(nombre|nom)_?(institucion_?educativa|escuela|colegio|universidad)|escuela|colegio|instituto|universidad|c[oó]digo_?amie|amie|school(_?name)?|university', 0.75]))

// Capped at 5 as text: large households are rare, and a rare count identifies.
decompose('EC_CONTEO_LIMITADO', [[String.raw`([0-5])`, keep], [String.raw`(\d+)`, redactAs('5')]], keep, '9')
domain('EC_L2_PERSONAS_A_CARGO', 'EC_CONTEO_LIMITADO',
  byName(['personas_?a_?cargo|cargas_?familiares|n(o|ro|um|umero)_?(de_?)?(hijos|dependientes|cargas|derechohabientes|personas_?a_?cargo)|cant(idad)?_?(hijos|dependientes|personas_?hogar|miembros)|hijos|dependientes|derechohabientes|personas_?(en_?el_?)?hogar|tama[nñ]o_?(del_?)?hogar|miembros_?(del_?)?hogar|number_?of_?children|dependents', 0.8]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// ── L3 · Sensitive data (art. 4) ────────────────────────────────────────────
//
// The list of article 4 is the longest in the region: etnia, identidad de género, **identidad
// cultural**, religión, ideología, filiación política, **pasado judicial**, **condición
// migratoria**, orientación sexual, salud, datos biométricos, datos genéticos, and the data of
// stateless people and refugees who need international protection — closing with the open clause
// "aquellos cuyo tratamiento indebido pueda dar origen a discriminación". Health has a group of its
// own below, and the pasado judicial the PENAL group; the rest is here.

// The 2022 census asked everyone how they identify themselves.
const ETHNIC_GROUPS = ['Mestizo', 'Montubio', 'Afroecuatoriano', 'Negro', 'Mulato', 'Indígena', 'Blanco', 'Otro']
categorical('EC_AUTOIDENTIFICACION', 'ec-autoidentificacion.txt', ETHNIC_GROUPS, 'Indígena', ['1', '2', '3', '4', '5', '6', '7', '8'])
domain('EC_L3_ETNIA', 'EC_AUTOIDENTIFICACION',
  byName(['etnia|origen_?([eé]tnico|racial)|grupo_?[eé]tnico|pertenencia_?[eé]tnica|autoidentificaci[oó]n(_?[eé]tnica)?|autodefinici[oó]n|(cod|codigo|tipo|id)_?(etnia|autoidentificacion)|raza|ind[ií]gena|montubio|afroecuatoriano|afrodescendiente|ethnicity|race', 0.95]),
  byList([['ec-detectar-etnia.txt', [...ETHNIC_GROUPS, 'mestizo', 'montubio', 'montuvio', 'afroecuatoriano', 'afrodescendiente', 'negro', 'mulato', 'indígena', 'blanco', 'otro'], 0.9],
    ['ec-detectar-codigos-banderas.txt', ['s', 'n', 'sí', 'no', '1', '2', '3', '4', '5', '6'], 0.3],
  ], { reject: 0.4 }))

// Article 4 names the **identidad cultural** apart from the etnia: the nationality or pueblo a
// person belongs to. The Constitution recognizes fourteen indigenous nationalities and eighteen
// kichwa pueblos, and naming one of them names a few thousand people.
const NATIONALITIES = ['Kichwa', 'Shuar', 'Achuar', 'Awá', 'Chachi', 'Épera', 'Tsáchila', "A'i Cofán", 'Siekopai', 'Siona', 'Shiwiar', 'Sapara', 'Andwa', 'Waorani', 'Otavalo', 'Karanki', 'Natabuela', 'Kayambi', 'Kitu Kara', 'Panzaleo', 'Chibuleo', 'Salasaka', 'Kisapincha', 'Tomabela', 'Waranka', 'Puruhá', 'Kañari', 'Saraguro', 'Palta', 'Ninguna']
categorical('EC_IDENTIDAD_CULTURAL', 'ec-identidad-cultural.txt', NATIONALITIES, 'Pueblo Manta-Huancavilca')
domain('EC_L3_IDENTIDAD_CULTURAL', 'EC_IDENTIDAD_CULTURAL',
  byName(['identidad_?cultural|nacionalidad_?(ind[ií]gena|originaria)|pueblo_?(ind[ií]gena|originario|al_?que_?pertenece)|pertenece_?(a_?)?(pueblo|nacionalidad|comunidad)|comunidad_?(ind[ií]gena|ancestral)|nacionalidad(?!_?(pais|extranjera|documento))_?(ecuatoriana)?|indigenous_?people', 0.9]),
  byList([['ec-detectar-nacionalidades-indigenas.txt', [...NATIONALITIES, 'kichwa', 'quichua', 'shuar', 'achuar', 'awá', 'chachi', 'épera', 'tsáchila', 'colorado', 'cofán', 'siona', 'secoya', 'siekopai', 'shiwiar', 'sapara', 'zápara', 'andwa', 'waorani', 'huaorani', 'otavalo', 'saraguro', 'puruhá', 'cañari', 'salasaka'], 0.85]], { reject: 0.4 }))

const LANGUAGES = ['Castellano', 'Kichwa', 'Shuar chicham', 'Achuar chicham', 'Awapit', "Cha'palaa", 'Sia pedee', "Tsa'fiki", "A'ingae", 'Paicoca', 'Shiwiar chicham', 'Sapara', 'Wao terero', 'Lengua de señas ecuatoriana', 'Inglés', 'Otra']
categorical('EC_LENGUA', 'ec-lenguas.txt', LANGUAGES, 'Kichwa de la sierra')
domain('EC_L3_LENGUA', 'EC_LENGUA',
  byName(['lengua(_?(ind[ií]gena|materna|nativa|originaria|ancestral|de_?se[nñ]as))?|idioma(_?(ind[ií]gena|materno|nativo|ancestral))?|habla_?(lengua|idioma)|mother_?tongue|native_?language', 0.9]),
  byList([['ec-detectar-lenguas.txt', [...LANGUAGES, 'kichwa', 'quichua', 'shuar', 'castellano', 'español', 'tsáfiki', 'chapalaa', 'awapit', 'lsec'], 0.8]], { reject: 0.4 }))

// Article 4 names the condición migratoria among the sensitive data, and names the data of
// stateless people and refugees who need international protection in the same sentence.
const MIGRATORY = ['Ecuatoriano', 'Residente permanente', 'Residente temporal', 'Visitante temporal', 'Refugiado', 'Solicitante de refugio', 'Asilado', 'Apátrida', 'En situación irregular', 'Persona en movilidad humana']
categorical('EC_CONDICION_MIGRATORIA', 'ec-condicion-migratoria.txt', MIGRATORY, 'Residente en trámite')
domain('EC_L3_CONDICION_MIGRATORIA', 'EC_CONDICION_MIGRATORIA',
  byName(['condici[oó]n_?migratoria|estatus_?migratorio|situaci[oó]n_?migratoria|categor[ií]a_?migratoria|movilidad_?humana|refugiad[oa]|solicitante_?(de_?)?(refugio|asilo)|asilad[oa]|ap[aá]trida|protecci[oó]n_?internacional|migrante|desplazad[oa]|retornad[oa]|deportad[oa]|migratory_?status|refugee', 0.95]),
  byList([['ec-detectar-condicion-migratoria.txt', [...MIGRATORY, 'refugiado', 'solicitante de refugio', 'asilado', 'apátrida', 'regular', 'irregular', 'residente', 'visitante', 'turista'], 0.8]], { reject: 0.4 }))

// The nationality of a foreign country: not named as sensitive, but it singles out the Venezuelan
// and Colombian communities the law's stateless and refugee clause is written for.
const COUNTRIES = ['Ecuatoriana', 'Venezolana', 'Colombiana', 'Peruana', 'Cubana', 'Haitiana', 'China', 'Española', 'Estadounidense', 'Argentina', 'Chilena', 'Boliviana', 'Mexicana', 'Italiana']
lookup('EC_NACIONALIDAD_PAIS', 'ec-nacionalidades.txt', COUNTRIES, 'Panameña')
domain('EC_L3_NACIONALIDAD', 'EC_NACIONALIDAD_PAIS',
  byName(['nacionalidad_?(pais|extranjera|documento)|pa[ií]s_?(de_?)?(nacimiento|origen|nacionalidad|procedencia)|ciudadan[ií]a|nationality|citizenship|country_?of_?birth', 0.85]),
  byList([['ec-detectar-nacionalidades.txt', [...COUNTRIES, 'ecuatoriano', 'venezolano', 'colombiano', 'peruano', 'cubano', 'haitiano', 'chino', 'español', 'estadounidense', 'ecuador', 'venezuela', 'colombia', 'perú', 'extranjero', 'extranjera'], 0.7]], { reject: 0.4 }))

const RELIGIONS = ['Católica', 'Evangélica', 'Testigo de Jehová', 'Iglesia de Jesucristo de los Santos de los Últimos Días', 'Adventista', 'Protestante', 'Judía', 'Musulmana', 'Otra', 'Ninguna']
categorical('EC_RELIGION', 'ec-religiones.txt', RELIGIONS, 'Ortodoxa')
domain('EC_L3_RELIGION', 'EC_RELIGION',
  byName(['religi[oó]n|creencia_?(religiosa|espiritual)|convicci[oó]n_?(religiosa|espiritual)|credo|confesi[oó]n_?religiosa|culto|iglesia(_?(a_?la_?que_?pertenece|nombre))?|denominaci[oó]n_?religiosa|(cod|codigo|tipo)_?religion|religion|church', 0.95]),
  byList([['ec-detectar-religiones.txt', [...RELIGIONS, 'católico', 'catolico', 'cristiano', 'cristiana', 'evangélico', 'adventista', 'testigo de jehová', 'mormón', 'judío', 'musulmán', 'ateo', 'agnóstico', 'ninguna', 'ninguno'], 0.9]], { reject: 0.4 }))

// Article 4 names the **ideología** on its own, beside the filiación política.
const IDEOLOGIES = ['Izquierda', 'Centroizquierda', 'Centro', 'Centroderecha', 'Derecha', 'Independiente', 'Prefiere no responder']
categorical('EC_IDEOLOGIA', 'ec-ideologias.txt', IDEOLOGIES, 'Oficialista')
domain('EC_L3_IDEOLOGIA', 'EC_IDEOLOGIA',
  byName(['ideolog[ií]a(_?pol[ií]tica)?|opini[oó]n_?pol[ií]tica|orientaci[oó]n_?pol[ií]tica|tendencia_?pol[ií]tica|preferencia_?(pol[ií]tica|partidaria|electoral)|intenci[oó]n_?(de_?)?voto|simpat[ií]a_?pol[ií]tica|convicci[oó]n_?(filos[oó]fica|moral)|political_?(opinion|orientation|view)|voting_?intention', 0.9]),
  byList([['ec-detectar-ideologias.txt', [...IDEOLOGIES, 'izquierda', 'derecha', 'centro', 'progresista', 'conservador', 'independiente', 'indeciso', 'voto nulo', 'ninguno'], 0.7]], { reject: 0.4 }))

// Party membership: the organizations on the Registro del Consejo Nacional Electoral.
const PARTIES = ['Revolución Ciudadana', 'Acción Democrática Nacional', 'Movimiento CREO', 'Partido Social Cristiano', 'Pachakutik', 'Izquierda Democrática', 'Sociedad Patriótica', 'Construye', 'Avanza', 'Centro Democrático', 'Partido Socialista Ecuatoriano', 'Unidad Popular', 'Sin afiliación']
categorical('EC_PARTIDO', 'ec-partidos.txt', PARTIES, 'Movimiento Suma')
domain('EC_L3_FILIACION_POLITICA', 'EC_PARTIDO',
  byName(['partido(_?pol[ií]tico)?(_?(afiliaci[oó]n|nombre))?|organizaci[oó]n_?pol[ií]tica|movimiento_?pol[ií]tico|filiaci[oó]n_?(pol[ií]tica|partidaria)|afiliaci[oó]n_?(pol[ií]tica|partidaria|partido)|militancia(_?pol[ií]tica)?|militante|(cod|codigo|nombre|nom)_?partido|political_?party|party_?membership', 0.95]),
  byList([['ec-detectar-partidos.txt', [...PARTIES, 'PSC', 'ID', 'PSP', 'CREO', 'ADN', 'RC', 'Pachakutik', 'Avanza', 'Construye'], 0.8]], { reject: 0.4 }))

domain('EC_L3_AFILIACION_SINDICAL', 'EC_CATEGORIA_SUPRIMIDA',
  byName(['sindicato(_?(nombre|afiliado|afiliaci[oó]n|codigo))?|sindicalizado|afiliado_?sindicato|afiliaci[oó]n_?sindical|cuota_?sindical|descuento_?sindical|aporte_?sindical|asociaci[oó]n_?(sindical|de_?trabajadores)|comit[eé]_?de_?empresa|contrato_?colectivo|fuero_?sindical|dirigente_?sindical|trade_?union|union_?member(ship)?', 0.95]),
  byList([['ec-detectar-sindicatos.txt', ['FUT', 'CEOSL', 'CEDOCUT', 'CTE', 'UGTE', 'UNE', 'FENOCIN', 'Comité de Empresa', 'Frente Unitario de Trabajadores', 'sindicalizado', 'afiliado'], 0.6]], { reject: 0.3 }))

// Art. 4 defines the biometric datum as the one that permits or confirms the unique identification
// of a person — the template, not the photograph the algorithms cannot reach.
domain('EC_L3_BIOMETRICO', 'EC_REDACTAR',
  byName(['biometr[ií]a[a-z_]*|biom[eé]trico[a-z_]*|huella(_?(dactilar|digital))?(_?(template|plantilla|imagen|hash))?|huellas|dactilar|dactiloscop[ií]a|template_?(facial|huella|biometrico)|plantilla_?(facial|biom[eé]trica)|rostro_?(hash|template)|reconocimiento_?facial|firma_?(biom[eé]trica|digitalizada|electr[oó]nica)|iris|voz_?(biom[eé]trica|template)|fingerprints?|face_?(template|hash|encoding)|biometric[a-z_]*', 0.9]),
  byType(STRING()))

domain('EC_L3_GENETICO', 'EC_REDACTAR',
  byName(['adn|dna|gen[eé]tic[oa]s?|datos?_?gen[eé]ticos?|genoma|genotip[a-z_]*|prueba_?(gen[eé]tica|de_?adn|de_?paternidad|de_?filiaci[oó]n)|perfil_?gen[eé]tico|mutaci[oó]n|brca[12]?|cariotipo|tamizaje_?neonatal|genetic[a-z_]*', 0.9]))

const ORIENTATIONS = ['Heterosexual', 'Gay', 'Lesbiana', 'Bisexual', 'Pansexual', 'Asexual', 'Otra', 'Prefiere no responder']
categorical('EC_ORIENTACION_SEXUAL', 'ec-orientaciones-sexuales.txt', ORIENTATIONS, 'Homosexual')
domain('EC_L3_ORIENTACION_SEXUAL', 'EC_ORIENTACION_SEXUAL',
  byName(['orientaci[oó]n_?sexual|preferencias?_?sexuales?|(cod|codigo|tipo)_?orientacion_?sexual|vida_?sexual|sexual_?orientation', 0.95]),
  byList([['ec-detectar-orientaciones-sexuales.txt', [...ORIENTATIONS, 'hetero', 'homosexual', 'lgbti', 'lgbtiq+', 'glbti', 'queer'], 0.8]], { reject: 0.4 }))

const IDENTITIES = ['Mujer cisgénero', 'Hombre cisgénero', 'Mujer trans', 'Hombre trans', 'Persona no binaria', 'Intersexual', 'Otra', 'Prefiere no responder']
categorical('EC_IDENTIDAD_GENERO', 'ec-identidades-genero.txt', IDENTITIES, 'Transgénero')
domain('EC_L3_IDENTIDAD_GENERO', 'EC_IDENTIDAD_GENERO',
  byName(['identidad_?(de_?)?g[eé]nero|(cod|codigo|tipo)_?identidad_?genero|g[eé]nero_?(autopercibido|identitario)|expresi[oó]n_?de_?g[eé]nero|transg[eé]nero|persona_?trans|intersexual|nombre_?social|pronombres?|gender_?identity', 0.95]),
  byList([['ec-detectar-identidades-genero.txt', [...IDENTITIES, 'cisgénero', 'cis', 'transgénero', 'trans', 'no binario', 'no binaria', 'intersexual', 'mujer', 'hombre'], 0.7]], { reject: 0.4 }))

// The Ley Orgánica Integral para Prevenir y Erradicar la Violencia contra las Mujeres protects the
// identity of the victim, and the open clause of art. 4 reaches the data that exposes her.
domain('EC_L3_VICTIMA', 'EC_CATEGORIA_SUPRIMIDA',
  byName(['v[ií]ctima(_?(de_?)?(violencia(_?(de_?g[eé]nero|intrafamiliar|f[ií]sica|sexual|psicol[oó]gica|econ[oó]mica))?|delito|trata|abuso|desaparici[oó]n))?|violencia_?(de_?)?g[eé]nero|violencia_?(intrafamiliar|dom[eé]stica|sexual|psicol[oó]gica)|tipo_?(de_?)?violencia|medida_?(de_?)?protecci[oó]n|boleta_?de_?auxilio|desaparici[oó]n_?forzada|trata_?(de_?)?personas|denunciante_?violencia', 0.9]))

// ── SALUD · Health data (art. 4, art. 25 c and arts. 30 to 32) ──────────────
//
// Health data is sensitive by art. 4 and a special category by art. 25 c). Art. 31.2 says it in so
// many words: los datos relativos a la salud que se traten, **siempre que sea posible, deberán ser
// previamente anonimizados o seudonimizados**. That sentence is what this group is for.

domain('EC_SALUD_IDENTIFICADOR', 'EC_CM_ALFANUM',
  byName(
    ['n(o|ro|um|umero)_?(historia(_?cl[ií]nica)?|hc|hcu|expediente(_?cl[ií]nico)?|ingreso|atenci[oó]n|consulta|cita|referencia_?m[eé]dica|receta)|historia_?cl[ií]nica(_?[uú]nica)?|hc_?(n(o|ro|um|umero))?|hcu|n(o|ro|um|umero)_?(asegurado|afiliado_?iess)|c[oó]digo_?(paciente|historia|atenci[oó]n)|id_?paciente|rdacaa', 0.85],
    ['expediente|atenci[oó]n|ingreso|consulta', 0.55],
  ))

const COVERAGE = ['IESS (Seguro General)', 'Seguro Social Campesino', 'ISSFA', 'ISSPOL', 'Ministerio de Salud Pública', 'Seguro privado con hospitalización', 'Seguro privado sin hospitalización', 'Sin seguro']
decompose('EC_COBERTURA_SALUD', [
  [FLAG, apply('EC_BANDERA')],
  [String.raw`(\d{1,8})`, DIGITS],
], apply(lookup('EC_COBERTURA', 'ec-cobertura-salud.txt', COVERAGE, undefined, 'PRESERVE_LOOKUP_FILE')), 'IESS')
domain('EC_SALUD_COBERTURA', 'EC_COBERTURA_SALUD',
  byName(['cobertura(_?(m[eé]dica|de_?salud|social))?|seguro_?(m[eé]dico|salud)|r[eé]gimen(_?(de_?)?salud)?|tipo_?(de_?)?seguro|proveedor_?(de_?)?salud|iess(_?(afiliado|cobertura))?|issfa|isspol|seguro_?campesino|msp|aseguradora_?(m[eé]dica|salud)|plan_?(m[eé]dico|de_?salud)|medicina_?prepagada', 0.85]),
  byList([['ec-detectar-cobertura.txt', [...COVERAGE, 'iess', 'issfa', 'isspol', 'msp', 'seguro campesino', 'privado', 'sin seguro', 'prepagada'], 0.8]], { reject: 0.4 }))

const ICD10 = ['I10', 'E11', 'E78', 'J45', 'J06', 'J02', 'J20', 'K29', 'K21', 'K59', 'M54', 'M17', 'M25', 'N39', 'N20', 'R51', 'R10', 'H10', 'H66', 'L23', 'L30', 'B34', 'A09', 'E03', 'E66', 'D50', 'I83', 'K80', 'K40', 'S93', 'S60', 'Z00', 'J30', 'J32', 'G43', 'M79', 'R05']
const ICD10_DECIMAL = ['E11.9', 'E78.5', 'J45.9', 'J06.9', 'J02.9', 'J20.9', 'K29.7', 'K21.9', 'K59.0', 'M54.5', 'M17.9', 'N39.0', 'N20.0', 'R10.4', 'H10.9', 'H66.9', 'L23.9', 'L30.9', 'B34.9', 'A09.9', 'E03.9', 'E66.9', 'D50.9', 'I83.9', 'K80.2', 'K40.9', 'S93.4', 'S60.0', 'Z00.0', 'J30.4', 'J32.9', 'G43.9', 'M79.1']
decompose('EC_DIAGNOSTICO', [
  [String.raw`([A-TV-Za-tv-z]\d{2}\.\d{1,2})`, apply(lookup('EC_CIE10_DECIMAL', 'ec-cie10-decimal.txt', ICD10_DECIMAL, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [String.raw`([A-TV-Za-tv-z]\d{2,3}X?)`, apply(lookup('EC_CIE10', 'ec-cie10.txt', ICD10, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [FLAG, apply('EC_BANDERA')],
], apply(lookup('EC_DIAGNOSTICO_TEXTO', 'ec-diagnosticos.txt', ['Hipertensión arterial', 'Diabetes mellitus tipo 2', 'Asma', 'Lumbalgia', 'Gastritis crónica', 'Faringitis aguda', 'Infección de vías urinarias', 'Migraña', 'Hipotiroidismo', 'Dislipidemia', 'Obesidad', 'Artrosis de rodilla', 'Bronquitis aguda', 'Amigdalitis aguda', 'Dermatitis de contacto', 'Otitis media aguda', 'Esguince de tobillo', 'Conjuntivitis', 'Anemia ferropénica', 'Enfermedad por reflujo gastroesofágico', 'Síndrome de intestino irritable', 'Tendinitis', 'Sinusitis aguda', 'Cefalea tensional', 'Várices', 'Hernia inguinal', 'Litiasis renal', 'Colelitiasis', 'Gastroenteritis aguda', 'Control de salud'])), 'F33.1')
domain('EC_SALUD_DIAGNOSTICO', 'EC_DIAGNOSTICO',
  byName(['diagn[oó]stico[a-z_]*|dx(_?(principal|secundario|ingreso|egreso)[0-9]?)?|cie_?10|cie(_?(10|11|principal))?|(cod|codigo)_?(diagnostico|dx|cie)|impresi[oó]n_?diagn[oó]stica|enfermedad(es)?[a-z_]*|patolog[ií]a|comorbilidad(es)?|antecedentes?_?(m[eé]dicos|patol[oó]gicos|cl[ií]nicos|personales)|causa_?(de_?)?(muerte|defunci[oó]n|incapacidad|hospitalizaci[oó]n|consulta)|motivo_?(de_?)?(consulta|reposo|hospitalizaci[oó]n)|alergias?|diagnos(is|es)|icd_?(10|11)?', 0.85]),
  byPattern([[String.raw`[A-TV-Za-tv-z]\d{2}(\.\d{1,2}|\d|X)?`, 0.5]], { reject: 0.3 }))

decompose('EC_PROCEDIMIENTO', [[String.raw`(\d{4,6})`, DIGITS]], apply(lookup('EC_PROCEDIMIENTO_TEXTO', 'ec-procedimientos.txt', ['Consulta médica general', 'Consulta de emergencia', 'Biometría hemática', 'Glucosa en sangre', 'Elemental y microscópico de orina', 'Creatinina', 'Radiografía de tórax', 'Ecografía abdominal', 'Electrocardiograma', 'Control prenatal'])), 'Prueba de carga viral para VIH')
domain('EC_SALUD_PROCEDIMIENTO', 'EC_PROCEDIMIENTO',
  byName(['procedimiento(_?(m[eé]dico|quir[uú]rgico|realizado|autorizado))?|(cod|codigo)_?(procedimiento|prestaci[oó]n|servicio_?salud|cpt)|cpt|prestaci[oó]n_?(m[eé]dica|de_?salud)|examen_?(ordenado|realizado)|cirug[ií]a(_?realizada)?|intervenci[oó]n_?quir[uú]rgica|medical_?procedure', 0.85]))

const MEDICATIONS = ['Paracetamol', 'Ibuprofeno', 'Diclofenaco', 'Metformina', 'Glibenclamida', 'Losartán', 'Enalapril', 'Amlodipino', 'Atorvastatina', 'Omeprazol', 'Levotiroxina', 'Amoxicilina', 'Cefalexina', 'Salbutamol', 'Loratadina', 'Hidroclorotiazida', 'Ácido acetilsalicílico', 'Prednisona', 'Azitromicina', 'Sulfato ferroso', 'Ácido fólico', 'Complejo B']
categorical('EC_MEDICAMENTO', 'ec-medicamentos.txt', MEDICATIONS, 'Sertralina 50 mg')
domain('EC_SALUD_MEDICAMENTO', 'EC_MEDICAMENTO',
  byName(['medicamentos?(_?(recetado|prescrito|entregado|despachado|nombre|uso))?|f[aá]rmacos?|principio_?activo|denominaci[oó]n_?com[uú]n_?internacional|dci|receta(_?m[eé]dica)?|prescripci[oó]n(_?medicamento)?|posolog[ií]a|tratamiento_?farmacol[oó]gico|(cod|codigo)_?medicamento|cuadro_?nacional_?(de_?)?medicamentos|medications?|drugs?_?prescribed', 0.85]),
  byList([['ec-detectar-medicamentos.txt', [...MEDICATIONS, 'paracetamol', 'sertralina', 'fluoxetina', 'escitalopram', 'quetiapina', 'clonazepam', 'alprazolam', 'lorazepam', 'litio', 'metilfenidato', 'risperidona', 'olanzapina', 'haloperidol', 'tenofovir', 'emtricitabina', 'dolutegravir', 'efavirenz', 'insulina', 'warfarina', 'levetiracetam', 'ácido valproico', 'misoprostol', 'levonorgestrel', 'anticonceptivo'], 0.7]], { reject: 0.3 }))

domain('EC_SALUD_TEXTO_CLINICO', 'EC_TEXTO_LIBRE',
  byName(['anamnesis|evoluci[oó]n(_?(m[eé]dica|cl[ií]nica|enfermer[ií]a))?|enfermedad_?actual|examen_?f[ií]sico|plan_?(de_?)?(manejo|tratamiento)|indicaciones_?m[eé]dicas|conducta(_?m[eé]dica)?|epicrisis|resumen_?(de_?)?(alta|egreso|atenci[oó]n)|nota_?(m[eé]dica|de_?enfermer[ií]a|cl[ií]nica)|notas?_?(m[eé]dicas|cl[ií]nicas)|triaje(_?texto)?|informe_?(patolog[ií]a|radiolog[ií]a|m[eé]dico)|clinical_?notes?|discharge_?summary', 0.85]),
  byType(STRING(30)))

domain('EC_SALUD_RESULTADO_EXAMEN', 'EC_CM_ALFANUM',
  byName(
    ['resultado_?(del_?)?(examen|prueba|laboratorio|pcr|serolog[ií]a|biopsia|glucosa|citolog[ií]a|papanicolaou)|(examen|prueba)_?(resultado|laboratorio)|glucemia|hemoglobina(_?glicosilada)?|hba1c|colesterol|imc|presi[oó]n_?arterial|prueba_?(de_?)?embarazo|toxicol[oó]gico|alcoholemia|lab_?results?|test_?results?', 0.8],
    ['resultado|prueba', 0.5],
  ))

// The Ley de Prevención y Atención Integral del VIH/SIDA orders confidentiality and forbids
// demanding a test to get or keep a job.
domain('EC_SALUD_VIH', 'EC_CATEGORIA_SUPRIMIDA',
  byName(['vih(_?(estado|resultado|prueba|diagn[oó]stico|positivo))?|hiv|sida|aids|serolog[ií]a_?(vih|hiv)|estado_?serol[oó]gico|carga_?viral|cd4|tarv|antirretroviral(es)?|its|ets|infecci[oó]n(es)?_?(de_?)?transmisi[oó]n_?sexual|s[ií]filis|hepatitis_?[bc]|tuberculosis|tb', 0.9]))

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']
lookup('EC_GRUPO_SANGUINEO', 'ec-grupos-sanguineos.txt', BLOOD_GROUPS, 'O+', 'PRESERVE_LOOKUP_FILE')
domain('EC_SALUD_GRUPO_SANGUINEO', 'EC_GRUPO_SANGUINEO',
  byName(['grupo_?sangu[ií]neo|tipo_?(de_?)?sangre|rh|factor_?rh|gs_?rh|grupo_?rh|abo(_?rh)?|blood_?(type|group)', 0.9]),
  byList([['ec-detectar-grupos-sanguineos.txt', [...BLOOD_GROUPS, '0+', '0-', 'a positivo', 'a negativo', 'b positivo', 'b negativo', 'ab positivo', 'ab negativo', 'o positivo', 'o negativo'], 0.9]], { reject: 0.4 }))

// Art. 25 d) makes the data of persons with disabilities and of their substitutes a special
// category of its own — no other law of the region does.
const DISABILITIES = ['Física', 'Auditiva', 'Visual', 'Intelectual', 'Psicosocial', 'Del lenguaje', 'Múltiple', 'Ninguna']
categorical('EC_DISCAPACIDAD', 'ec-discapacidades.txt', DISABILITIES, 'Trastorno del espectro autista')
domain('EC_SALUD_DISCAPACIDAD', 'EC_DISCAPACIDAD',
  byName(['discapacidad[a-z_]*|(tipo|cod|codigo|categoria|porcentaje|grado)_?discapacidad|persona_?con_?discapacidad|pcd|conadis|carn[eé]_?(de_?)?(conadis|discapacidad)|certificado_?(de_?)?discapacidad|condici[oó]n_?(de_?)?discapacidad|sustituto(_?de_?persona_?con_?discapacidad)?|necesidades_?(educativas_?)?especiales|movilidad_?reducida|disabilit(y|ies)', 0.9]),
  byList([['ec-detectar-discapacidades.txt', [...DISABILITIES, 'física', 'motora', 'auditiva', 'sordera', 'visual', 'ceguera', 'intelectual', 'cognitiva', 'psicosocial', 'mental', 'lenguaje', 'múltiple', 'autismo', 'ninguna', 'no aplica'], 0.6]], { reject: 0.3 }))

categorical('EC_APTITUD_LABORAL', 'ec-aptitud-laboral.txt', ['Apto', 'Apto con restricciones', 'No apto', 'Pendiente'], 'No apto temporalmente')
domain('EC_SALUD_OCUPACIONAL', 'EC_APTITUD_LABORAL',
  byName(['aptitud_?(laboral|m[eé]dica)|certificado_?(de_?)?aptitud|examen_?(m[eé]dico_?)?(ocupacional|preocupacional|de_?ingreso|de_?retiro|peri[oó]dico)|accidente_?(de_?)?trabajo|enfermedad_?(laboral|profesional|ocupacional)|riesgos?_?(del_?)?trabajo|incapacidad(_?(m[eé]dica|laboral|d[ií]as))?|reposo_?m[eé]dico|d[ií]as_?(de_?)?(incapacidad|reposo)|licencia_?(m[eé]dica|por_?enfermedad|de_?maternidad)|ausentismo|comit[eé]_?(de_?)?seguridad', 0.85]),
  byList([['ec-detectar-aptitud-laboral.txt', ['apto', 'no apto', 'apto con restricciones', 'pendiente', 'apto con recomendaciones'], 0.6]], { reject: 0.3 }))

domain('EC_SALUD_REPRODUCTIVA', 'EC_CATEGORIA_SUPRIMIDA',
  byName(['embarazo|embarazada|gestante|gestaci[oó]n|edad_?gestacional|semanas_?(de_?)?gestaci[oó]n|fum|fecha_?[uú]ltima_?(regla|menstruaci[oó]n)|control_?prenatal|prenatal|parto(_?tipo)?|ces[aá]rea|aborto|m[eé]todo_?(de_?)?planificaci[oó]n|planificaci[oó]n_?familiar|anticoncepci[oó]n|anticonceptivo|fertilidad|salud_?(sexual|reproductiva)|pregnan(t|cy)|contracepti(on|ve)', 0.9]))

domain('EC_SALUD_MENTAL', 'EC_CATEGORIA_SUPRIMIDA',
  byName(['salud_?mental|trastorno[a-z_]*|psiqui[aá]tri[a-z_]*|psicol[oó]gi[a-z_]*|depresi[oó]n|ansiedad|suicid[a-z_]*|intento_?(de_?)?suicidio|autolesi[oó]n|consumo_?(de_?)?(sustancias|alcohol|drogas)|adicci[oó]n(es)?|alcoholismo|tabaquismo|mental_?health', 0.9]))

// ── FIN · Financial and socioeconomic data ──────────────────────────────────
//
// Art. 4 defines the **datos personales crediticios** as those that make up the economic behaviour
// of a natural person, and arts. 28 and 29 give them a regime of their own: they may be used only
// to analyse solvency, never for a secondary purpose, and may not be communicated once five years
// have passed since the obligation became due.

decompose('EC_HISTORIAL_CREDITICIO', [
  [String.raw`(\d{1,4})`, DIGITS],
  [FLAG, apply('EC_BANDERA')],
], apply(lookup('EC_ESTADO_CREDITO', 'ec-estados-credito.txt', ['A-1 Riesgo normal', 'A-2 Riesgo normal', 'A-3 Riesgo normal', 'B-1 Riesgo potencial', 'B-2 Riesgo potencial', 'C-1 Riesgo deficiente', 'C-2 Riesgo deficiente', 'D Riesgo dudoso', 'E Pérdida', 'Al día', 'Reportado en el buró de crédito', 'En cobranza judicial', 'Refinanciado', 'Castigado', 'Sin historial crediticio'])), 'Reportado en el buró de crédito')
domain('EC_FIN_HISTORIAL_CREDITICIO', 'EC_HISTORIAL_CREDITICIO',
  byName(['historial_?(crediticio|de_?cr[eé]dito)|bur[oó]_?(de_?)?cr[eé]dito|central_?(de_?)?riesgos?|equifax|credit_?report|score(_?(crediticio|interno))?|puntaje_?(de_?)?cr[eé]dito|calificaci[oó]n_?(de_?)?(riesgo|cr[eé]dito|cartera|deudor)|categor[ií]a_?(de_?)?riesgo|d[ií]as_?(de_?)?(mora|atraso)|estado_?(de_?)?(cr[eé]dito|cartera|obligaci[oó]n)|morosidad|moroso|cobranza_?judicial|credit_?score|credit_?rating', 0.9]))

algorithm('EC_VALOR_DEUDA', 'characterMapping.NumericMapping', { minValue: 100, maxValue: 250000 }, '8400')
domain('EC_FIN_DEUDA', 'EC_VALOR_DEUDA',
  byName(['saldo_?(deuda|cr[eé]dito|capital|obligaci[oó]n|cartera|en_?mora|adeudado)|monto_?(de_?la_?)?(deuda|cuota|obligaci[oó]n|cr[eé]dito|pr[eé]stamo|mora|desembolsado)|deuda(_?total)?|l[ií]mite_?(de_?)?(cr[eé]dito|tarjeta)|cupo_?(de_?)?cr[eé]dito|cuota_?mensual|loan_?(amount|balance)|outstanding_?balance|debt', 0.85]),
  byType(NUMBER()))

// The unified basic wage was 470 dollars a month in 2025; Ecuador uses the US dollar.
algorithm('EC_INGRESOS', 'characterMapping.NumericMapping', { minValue: 450, maxValue: 9000 }, '1200')
domain('EC_FIN_INGRESOS', 'EC_INGRESOS',
  byName(['sueldo(_?(b[aá]sico|mensual|bruto|neto|unificado))?|salario(_?(b[aá]sico|mensual|bruto|neto))?|remuneraci[oó]n(_?(b[aá]sica|mensual|unificada))?|rmu|ingresos?(_?(mensuales?|totales?|familiares?|declarados?|netos?))?|honorarios|renta(_?(bruta|neta|mensual|anual|imponible))?|ingreso_?(base|familiar|percapita)|salary|income|wages?', 0.85]),
  byType(NUMBER()))

algorithm('EC_PATRIMONIO', 'characterMapping.NumericMapping', { minValue: 1000, maxValue: 600000 }, '85000')
domain('EC_FIN_PATRIMONIO', 'EC_PATRIMONIO',
  byName(['patrimonio(_?(neto|l[ií]quido))?|activos?_?(totales?)?|valor_?(del_?)?(inmueble|predio|veh[ií]culo|bienes|aval[uú]o|comercial)|aval[uú]o(_?catastral)?|saldo_?(cuenta|ahorros?|dep[oó]sito|inversi[oó]n|fondo)|dep[oó]sito_?a_?plazo|inversiones|declaraci[oó]n_?(juramentada|patrimonial)|net_?worth|account_?balance', 0.85]),
  byType(NUMBER()))

algorithm('EC_VALOR_PENSION', 'characterMapping.NumericMapping', { minValue: 200, maxValue: 3000 }, '520')
domain('EC_FIN_PENSION', 'EC_VALOR_PENSION',
  byName(['pensi[oó]n(_?(monto|mensual|valor|jubilar))?|monto_?(pensi[oó]n|jubilaci[oó]n|beneficio|subsidio)|valor_?(pensi[oó]n|subsidio|beneficio)|jubilaci[oó]n(_?monto)?|pensi[oó]n_?(de_?)?alimentos|pensi[oó]n_?alimenticia|sut[eé]|pension_?amount', 0.9]),
  byType(NUMBER()))

const PROGRAMMES = ['Bono de Desarrollo Humano', 'Bono Joaquín Gallegos Lara', 'Pensión para Adultos Mayores', 'Pensión para Personas con Discapacidad', 'Crédito de Desarrollo Humano', 'Bono 1000 Días', 'Ninguno']
categorical('EC_PROGRAMA_SOCIAL', 'ec-programas-sociales.txt', PROGRAMMES, 'Bono de contingencia')
domain('EC_FIN_PROGRAMA_SOCIAL', 'EC_PROGRAMA_SOCIAL',
  byName(['programa_?social|beneficiario_?(programa|subsidio|bono|pensi[oó]n)|bono(_?(desarrollo_?humano|joaqu[ií]n_?gallegos|1000_?d[ií]as|contingencia))?|bdh|pensi[oó]n_?(adultos?_?mayores|toda_?una_?vida)|cr[eé]dito_?(de_?)?desarrollo_?humano|registro_?social|subsidio(_?(gas|electricidad|tipo))?|transferencia_?monetaria|ayuda_?(social|estatal)|social_?programme', 0.9]),
  byList([['ec-detectar-programas-sociales.txt', [...PROGRAMMES, 'bono de desarrollo humano', 'bdh', 'joaquín gallegos lara', 'adultos mayores', 'discapacidad', 'ninguno'], 0.8],
    ['ec-detectar-codigos-banderas.txt', ['s', 'n', 'sí', 'no', '1', '2', '3', '4', '5', '6'], 0.3],
  ], { reject: 0.4 }))

// The Registro Social scores every household and decides who gets a subsidy: as revealing as an
// income figure.
const SOCIOECONOMIC = ['Quintil 1', 'Quintil 2', 'Quintil 3', 'Quintil 4', 'Quintil 5', 'Pobreza extrema', 'Pobreza', 'No pobre', 'Sin clasificación']
categorical('EC_REGISTRO_SOCIAL', 'ec-registro-social.txt', SOCIOECONOMIC, 'Pobreza extrema', ['1', '2', '3', '4', '5'])
domain('EC_FIN_REGISTRO_SOCIAL', 'EC_REGISTRO_SOCIAL',
  byName(['registro_?social|[ií]ndice_?(de_?)?registro_?social|puntaje_?(registro_?social|rs)|clasificaci[oó]n_?socioecon[oó]mica|nivel_?socioecon[oó]mico|nse|condici[oó]n_?(de_?)?pobreza|pobreza|quintil(_?(de_?)?(ingreso|riqueza))?|decil|estrato_?socioecon[oó]mico', 0.9]),
  byList([['ec-detectar-registro-social.txt', [...SOCIOECONOMIC, 'quintil', 'pobre', 'pobreza extrema', 'no pobre', 'a', 'b', 'c+', 'c-', 'd'], 0.6]], { reject: 0.4 }))

const TENURES = ['Propia y totalmente pagada', 'Propia y la está pagando', 'Propia (regalada, donada, heredada)', 'Prestada o cedida', 'Por servicios', 'Arrendada', 'Anticresis']
categorical('EC_TENENCIA_VIVIENDA', 'ec-tenencia-vivienda.txt', TENURES, 'Ocupación de hecho')
domain('EC_FIN_VIVIENDA', 'EC_TENENCIA_VIVIENDA',
  byName(['tenencia_?(de_?)?(la_?)?vivienda|tipo_?(de_?)?tenencia|vivienda_?(propia|arrendada|tipo_?tenencia)|condici[oó]n_?(de_?)?(la_?)?vivienda|ocupaci[oó]n_?vivienda|anticresis|housing_?tenure', 0.9]),
  byList([['ec-detectar-tenencia-vivienda.txt', [...TENURES, 'propia', 'arrendada', 'arriendo', 'prestada', 'cedida', 'anticresis', 'por servicios'], 0.6]], { reject: 0.3 }))

// ── PENAL · Criminal records (sensitive data by art. 4) ─────────────────────
//
// Ecuador is the only country of the region whose law names the **pasado judicial** among the
// sensitive data of art. 4. The group is separate only because the shapes are: everything in it is
// sensitive data, and art. 26 forbids processing it without one of the grounds it lists.

categorical('EC_ANTECEDENTES', 'ec-antecedentes.txt', ['No registra antecedentes penales', 'Registra antecedentes', 'Procesado', 'Sentenciado', 'Absuelto', 'Sobreseído', 'Sin información'], 'Sentenciado por hurto en 2019')
domain('EC_PENAL_ANTECEDENTES', 'EC_ANTECEDENTES',
  byName(
    ['antecedentes?(_?(penales|policiales|judiciales))?|pasado_?judicial|certificado_?(de_?)?(antecedentes|pasado_?judicial)|r[eé]cord_?policial|reincidencia|condena(_?(penal|tipo))?|delito(_?(tipo|cometido))?|tipo_?(de_?)?delito|situaci[oó]n_?jur[ií]dica|boleta_?(de_?)?(captura|excarcelaci[oó]n)|privad[oa]_?(de_?)?libertad|ppl|snai|centro_?(de_?)?rehabilitaci[oó]n_?social|criminal_?record', 0.95],
    ['estado_?(del_?)?proceso|sentencia|fallo', 0.55],
  ))

// The Función Judicial numbers a case with the judicial unit, the year and a correlative:
// `17294-2024-00123`. The Fiscalía numbers its own file the same way.
decompose('EC_EXPEDIENTE_JUDICIAL', [
  [String.raw`(\d{5})(-)(\d{4})(-)(\d{5})`, DIGITS, keep, keep, keep, DIGITS],
  [String.raw`(\d{1,6})([\s\-/])([A-Za-z]{2,10})([\s\-/])(\d{4})`, DIGITS, keep, keep, keep, keep],
  [String.raw`([A-Za-z]{1,6}[\s\-]?)(\d{1,6})([\s\-/])(\d{4})`, keep, DIGITS, keep, keep],
  [String.raw`(\d{1,6})([\s\-/])(\d{4})`, DIGITS, keep, keep],
], CM, '17294-2024-00123')
domain('EC_PENAL_EXPEDIENTE', 'EC_EXPEDIENTE_JUDICIAL',
  byName(
    ['n(o|ro|um|umero)_?(de_?)?(expediente_?(judicial|penal|fiscal)|causa|proceso_?(judicial|penal)|denuncia|noticia_?del_?delito|referencia_?(judicial|fiscal))|expediente_?(judicial|penal|fiscal)|n(o|ro|um|umero)_?(de_?)?juicio|juicio_?n(o|ro|um|umero)|causa_?penal|noticia_?del_?delito|satje', 0.9],
    ['expediente|causa|proceso|juicio', 0.5],
  ),
  byPattern([[String.raw`\d{5}-\d{4}-\d{5}`, 0.9], [String.raw`\d{1,6}-[A-Z]{2,10}-\d{4}`, 0.5]], { reject: 0.3 }))

// ── Preset ──────────────────────────────────────────────────────────────────

const referenced = JSON.stringify([domains, algorithms.map((x) => x.config)])
const orphans = algorithms.filter((a) => !referenced.includes(`"${a.name}"`))
if (orphans.length) throw new Error(`algorithms nobody uses: ${orphans.map((a) => a.name).join(', ')}`)
const noInput = algorithms.filter((a) => a.input === undefined)
if (noInput.length) throw new Error(`algorithms without a sample input: ${noInput.map((a) => a.name).join(', ')}`)

// The essential pack: identity documents, names, contact, address and birth date. Loading it brings
// these domains and only what they lean on; the extended pack is everything.
const ESSENTIAL = [
  'EC_L1_CEDULA', 'EC_L1_RUC', 'EC_L1_DOCUMENTO_EXTRANJERO', 'EC_L1_PASAPORTE',
  'EC_L1_NOMBRE', 'EC_L1_APELLIDO', 'EC_L1_NOMBRE_COMPLETO', 'EC_L1_EMAIL', 'EC_L1_TELEFONO',
  'EC_L1_DIRECCION', 'EC_L1_DIRECCION_COMPLEMENTO', 'EC_L2_FECHA_NACIMIENTO',
]
const notDomains = ESSENTIAL.filter((name) => !domains.some((d) => d.name === name))
if (notDomains.length) throw new Error(`essential pack names domains the set does not have: ${notDomains.join(', ')}`)

const VERSION = 1
const preset = {
  version: VERSION,
  name: {
    en: 'Ecuador — Ley Orgánica de Protección de Datos Personales',
    'pt-BR': 'Equador — Ley Orgánica de Protección de Datos Personales',
    es: 'Ecuador — Ley Orgánica de Protección de Datos Personales',
  },
  summary: {
    en: 'Discovers and masks Ecuadorian personal data under the Ley Orgánica de Protección de Datos Personales (Official Register 459 of 2021) and its regulation of 2023: direct identifiers (cédula and RUC with a valid check digit, foreigner documents, names, contact, address, accounts, plates), quasi-identifiers (birth date, parroquia and DPA code, postal code), the sensitive data of article 4 — ethnicity, cultural identity, gender identity, religion, ideology, political affiliation, migratory status, sexual orientation, health, biometric and genetic data —, the judicial record the same article makes sensitive, health data, credit data and criminal proceedings.',
    'pt-BR': 'Descobre e mascara dados pessoais equatorianos segundo a Ley Orgánica de Protección de Datos Personales (Registro Oficial 459 de 2021) e seu regulamento de 2023: identificadores diretos (cédula e RUC com dígito verificador válido, documentos de estrangeiros, nomes, contato, endereço, contas, placas), quase-identificadores (data de nascimento, paróquia e código DPA, código postal), os dados sensíveis do artigo 4 — etnia, identidade cultural, identidade de gênero, religião, ideologia, filiação política, condição migratória, orientação sexual, saúde, dados biométricos e genéticos —, o passado judicial que o mesmo artigo torna sensível, dados de saúde, dados de crédito e processos penais.',
    es: 'Descubre y enmascara datos personales ecuatorianos conforme a la Ley Orgánica de Protección de Datos Personales (Registro Oficial 459 de 2021) y su reglamento de 2023: identificadores directos (cédula y RUC con dígito verificador válido, documentos de extranjeros, nombres, contacto, dirección, cuentas, placas), cuasi-identificadores (fecha de nacimiento, parroquia y código DPA, código postal), los datos sensibles del artículo 4 — etnia, identidad cultural, identidad de género, religión, ideología, filiación política, condición migratoria, orientación sexual, salud, datos biométricos y genéticos —, el pasado judicial que el mismo artículo hace sensible, datos de salud, datos crediticios y procesos penales.',
  },
  profileSet: {
    name: `EC - LOPDP - v${VERSION}`,
    description: 'Identificadores directos, cuasi-identificadores, datos sensibles (art. 4), datos de salud, datos crediticios y pasado judicial, conforme a la Ley Orgánica de Protección de Datos Personales del Ecuador y su reglamento.',
    threshold: 60,
    classifiers: classifiers.map((c) => c.name),
  },
  packs: {
    essential: {
      description: 'Paquete esencial de la LOPDP: cédula, RUC, documentos de extranjeros, pasaporte, nombres, contacto, dirección y fecha de nacimiento.',
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

const smallParroquias = parroquiaPlaces.filter((p) => p.small)
const smallCantones = cantonPlaces.filter((c) => c.small)
const inSmall = smallParroquias.reduce((a, p) => a + p.population, 0)
console.log(`${domains.length} domains, ${classifiers.length} classifiers, ${algorithms.length} algorithms, ${files.size} files`)
console.log(`parroquias: ${smallParroquias.length} of ${PARROQUIAS.length} under ${SMALL_PLACE} (${inSmall} people); cantones: ${smallCantones.length} of ${CANTONES.length}`)
console.log(`${places.names} names generalized, ${places.table.length} table lines, ${codePairs.length} codes`)
