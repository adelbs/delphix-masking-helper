#!/usr/bin/env node
/**
 * Builds the Costa Rica (Ley 8968 de Protección de la Persona frente al Tratamiento de sus Datos
 * Personales) pre-configured profile set: preset.json and files/.
 *
 *   node presets/costarica-ley-8968/build.mjs
 *
 * source/ holds the hand-kept lists — given names, surnames and barrios — and the geography of the
 * División Territorial Administrativa of 2025: the 492 distritos with their code, their cantón and
 * provincia, their location and their population, the 84 cantones and the 7 provincias. Everything
 * in files/ and preset.json is generated from them and from the definitions below — edit here,
 * then build, then run verify.mjs.
 *
 * Structure of the set
 *   L1     direct identifiers      cédula de identidad, DIMEX, NITE, passport, names, contact,
 *                                  address and señas, the IBAN **with valid check digits**, cards,
 *                                  devices, cookies, plates, property, free text
 *   L2     quasi-identifiers       birth date, age, sex, distrito and cantón, the district code
 *                                  that is also the postal code, barrio, marital status,
 *                                  occupation, employer, education
 *   L3     sensitive data          art. 3 e) and art. 9.1: racial or ethnic origin, political
 *                                  opinions, religious, spiritual or philosophical convictions,
 *                                  biomedical and genetic information, sexual life and orientation
 *                                  — plus the attributes the anti-discrimination clause of art. 4
 *                                  reaches: indigenous people, nationality, migratory condition,
 *                                  gender identity, trade union membership
 *   SALUD  health data             art. 9.1, whose exception d) is written for health care itself
 *   FIN    economic data           art. 3 e) names the **condición socioeconómica** among the
 *                                  sensitive data, and art. 1 covers the data of a person's
 *                                  **bienes**; art. 9.4 sends credit behaviour to the rules of the
 *                                  Sistema Financiero Nacional
 *   PENAL  offences                art. 8 c) and the retention clock of Ley 6723 as reformed by
 *                                  Ley 10453 of 2024
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
  description: 'Nombre de la columna (y variantes usadas en sistemas costarricenses).',
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

const PROVINCIAS = readLines('provincias.tsv').map((line) => {
  const [code, name, lat, lon, population] = line.split('\t')
  return { code, name, lat: Number(lat), lon: Number(lon), population: Number(population), aliases: [] }
})
const provinceByCode = new Map(PROVINCIAS.map((p) => [p.code, p]))
const CANTONES = readLines('cantones.tsv').map((line) => {
  const [code, name, provinceCode, province, lat, lon, population] = line.split('\t')
  return { code, name, provinceCode, province, lat: Number(lat), lon: Number(lon), population: Number(population), aliases: [] }
})
const cantonByCode = new Map(CANTONES.map((c) => [c.code, c]))
/**
 * A distrito with no published figure of its own is one the Dirección General de Estadística
 * created after the distribution the estimate comes from; `population` is left empty in the source
 * and the distrito counts as small, which is the conservative choice.
 */
const DISTRITOS = readLines('distritos.tsv').map((line) => {
  const [code, name, aliases, cantonCode, canton, provinceCode, province, lat, lon, population] = line.split('\t')
  return {
    code, name, aliases: aliases ? aliases.split(';') : [],
    cantonCode, canton, provinceCode, province,
    lat: Number(lat), lon: Number(lon),
    population: population ? Number(population) : null,
  }
})
if (PROVINCIAS.length !== 7) throw new Error(`expected the 7 provincias, found ${PROVINCIAS.length}`)
if (CANTONES.length !== 84) throw new Error(`expected the 84 cantones, found ${CANTONES.length}`)
if (DISTRITOS.length !== 492) throw new Error(`expected the 492 distritos, found ${DISTRITOS.length}`)
for (const d of DISTRITOS) {
  if (!/^\d{5}$/.test(d.code) || d.code.slice(0, 3) !== d.cantonCode || d.code[0] !== d.provinceCode) throw new Error(`${d.name}: bad DTA code ${d.code}`)
  if (Number.isNaN(d.lat) || Number.isNaN(d.lon)) throw new Error(`${d.name}: no location`)
  if (!cantonByCode.has(d.cantonCode) || !provinceByCode.has(d.provinceCode)) throw new Error(`${d.name}: no cantón or provincia`)
}
for (const c of CANTONES) {
  if (!/^\d{3}$/.test(c.code) || c.code[0] !== c.provinceCode) throw new Error(`${c.name}: bad cantón code ${c.code}`)
}
// Every provincia holds a distrito of 20,000, so a generalized distrito never leaves its provincia.
for (const p of PROVINCIAS) {
  if (!DISTRITOS.some((d) => d.provinceCode === p.code && d.population >= 20000)) throw new Error(`${p.name}: no distrito of 20,000`)
}


// ── Shared algorithms ───────────────────────────────────────────────────────

// Vowels map to vowels and consonants to consonants, so a masked document number keeps its
// structure; digits map to digits. Separators are in no group and stay. minMaskedPositions 0 lets
// a placeholder such as "N/A" through instead of failing the row.
algorithm('CR_CM_ALFANUM', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'AEIOU', 'BCDFGHJKLMNPQRSTVWXYZ', 'aeiou', 'bcdfghjklmnpqrstvwxyz', 'ÁÉÍÓÚÜ', 'áéíóúü'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, 'A1234567')
// Digits only: the hyphens of a cédula stay.
algorithm('CR_CM_DIGITOS', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '1-0234-0567')
// A digit that may not become a zero: the first of a cédula is the provincia of the birth entry,
// and 0 is not a provincia.
algorithm('CR_CM_DIGITO_1_9', 'characterMapping.CharacterMapping', {
  characterGroups: ['123456789'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '1')
// Digits and upper-case letters, one group each: a plate or a passport keeps its shape.
algorithm('CR_CM_DIGITOS_LETRAS', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, 'BLM123')
// Hex letters form their own group, so a MAC, UUID or IPv6 stays valid hex.
algorithm('CR_CM_HEX', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'abcdef', 'ABCDEF', 'ghijklmnopqrstuvwxyz', 'GHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '3c:22:fb:9a:10:e4')
decompose('CR_REDACTAR', [['(.+)', { type: 'REDACT', redactCharacter: 'X' }]], keep, 'clave123')
lookup('CR_SUPRIMIR', 'cr-sin-informacion.txt', ['Sin información'], 'Trastorno depresivo recurrente', 'PRESERVE_LOOKUP_FILE')

// Yes/no columns keep their vocabulary: a CHAR(1) S/N stays S/N.
decompose('CR_BANDERA', [
  [String.raw`(?i)(s[ií]|no)`, apply(lookup('CR_BANDERA_SI_NO', 'cr-bandera-si-no.txt', ['Sí', 'No']))],
  ['(?i)(true|false)', apply(lookup('CR_BANDERA_TRUE_FALSE', 'cr-bandera-true-false.txt', ['true', 'false']))],
  ['(?i)(yes)', apply(lookup('CR_BANDERA_YES_NO', 'cr-bandera-yes-no.txt', ['Yes', 'No']))],
  ['(?i)([sn])', apply(lookup('CR_BANDERA_S_N', 'cr-bandera-s-n.txt', ['S', 'N']))],
  ['(?i)([yx])', apply(lookup('CR_BANDERA_Y_N', 'cr-bandera-y-n.txt', ['Y', 'N']))],
  ['([01])', apply(lookup('CR_BANDERA_0_1', 'cr-bandera-0-1.txt', ['0', '1']))],
], keep, 'S')
const FLAG = String.raw`(?i)(s[ií]|no|true|false|yes|[snyx01])`
/**
 * A categorical attribute: flags stay flags, numeric codes are replaced by another code of `codes`
 * (or get other digits), and any other value is replaced by one from `values` — or suppressed, when
 * no list is given.
 */
function categorical(name, fileName, values, input, codes) {
  const replacement = values ? lookup(`${name}_LISTA`, fileName, values) : 'CR_SUPRIMIR'
  const code = codes ? apply(lookup(`${name}_CODIGO`, fileName.replace(/\.txt$/, '-codigos.txt'), codes)) : apply('CR_CM_ALFANUM')
  return decompose(name, [[FLAG, apply('CR_BANDERA')], [String.raw`(\d{1,6})`, code]], apply(replacement), input)
}
categorical('CR_CATEGORIA_SUPRIMIDA', null, null, 'Trastorno depresivo recurrente')
const CM = apply('CR_CM_ALFANUM')
const DIGITS = apply('CR_CM_DIGITOS')
const PROV_DIGIT = apply('CR_CM_DIGITO_1_9')

// ── L1 · Identity documents ─────────────────────────────────────────────────
//
// The **cédula de identidad** of the Tribunal Supremo de Elecciones is the key of every Costa Rican
// record. Its canonical form is ten digits, `0P-TTTT-AAAA`: a provincia P, the tomo and the asiento
// of the birth entry, and the leading zeroes are usually dropped, so the number is written
// `1-0234-0567` or `102340567`. **It carries no check digit** — the Dirección General de
// Tributación validates a cédula against the Registro Civil itself — so nothing has to be
// recomputed and the whole number is masked, the provincia digit included: it is the provincia of
// the birth entry and would otherwise survive into the copy.
//
// A foreign resident is identified by a **DIMEX** of eleven or twelve digits, and a foreign person
// without residence by a **NITE**, `3-120-XXXXXX`. The NITE is where the law draws its sharpest
// line: only a **persona física** is a titular under art. 3 b) and g), so a NITE of the 3-120
// series is masked while the **cédula jurídica** of a company — the same `3-NNN-NNNNNN` shape, and
// from the fourth quarter of 2026 `3-101-A00001` under Decreto 44648-MJ — is left exactly as it is.
const CEDULA_SHAPES = [
  // 0P-TTTT-AAAA, the canonical ten digits.
  [String.raw`(0)(\d)[\s\-]?(\d{4})[\s\-]?(\d{4})`, keep, PROV_DIGIT, DIGITS, DIGITS],
  // P-TTTT-AAAA with separators, the form documents and forms use.
  [String.raw`(\d)[\s\-](\d{3,4})[\s\-](\d{3,4})`, PROV_DIGIT, DIGITS, DIGITS],
  // Nine bare digits.
  [String.raw`(\d)(\d{8})`, PROV_DIGIT, DIGITS],
]
decompose('CR_CEDULA', CEDULA_SHAPES, DIGITS, '1-0234-0567')
const CEDULA_SHAPE = String.raw`0?\d[\s\-]?\d{3,4}[\s\-]?\d{3,4}`

// Eleven or twelve digits, all masked: the leading digits are the country of the migratory record.
decompose('CR_DIMEX', [[String.raw`(\d{11,12})`, DIGITS]], DIGITS, '155812345678')

// The 3-120 series belongs to a foreign natural person; every other 3-NNN number is a legal person
// and no titular of the law.
decompose('CR_NITE', [
  [String.raw`(3[\s\-]?120[\s\-]?)(\d{6})`, keep, DIGITS],
  [String.raw`(3[\s\-]?130[\s\-]?[\dA-Za-z]{6})`, keep],
], CM, '3-120-123456')

// A document column holds cédulas, DIMEX, NITE and cédulas jurídicas: each value goes by its shape.
decompose('CR_DOCUMENTO', [
  [String.raw`(3[\s\-]?120[\s\-]?\d{6})`, apply('CR_NITE')],
  // Any other 3-NNN-NNNNNN is a company, with the numeric series or the alphanumeric one of 2026.
  [String.raw`(3[\s\-]?\d{3}[\s\-]?[\dA-Za-z]{6})`, keep],
  [String.raw`(\d{11,12})`, apply('CR_DIMEX')],
  [`(${CEDULA_SHAPE})`, apply('CR_CEDULA')],
], CM, '1-0234-0567')

const DOC_OWNER = 'cliente|cli|paciente|pac|usuario|afiliado|asegurado|beneficiario|benef|titular|empleado|emp|trabajador|funcionario|colaborador|alumno|estudiante|deudor|codeudor|fiador|garante|solicitante|propietario|arrendatario|inquilino|conductor|responsable|representante|apoderado|persona|ciudadano|elector|votante|contribuyente|proveedor|socio|conyuge|padre|madre|hijo|familiar|pensionado|jubilado|aportante|patrono'
domain('CR_L1_CEDULA', 'CR_DOCUMENTO',
  byName(
    // Not a cédula jurídica — a company is no titular — and not the *kind* of document.
    [`c[eé]dula(?!_?jur[ií]dica)(_?(de_?)?identidad)?|ced|n(o|ro|um|umero)_?(c[eé]dula|documento|doc|identificaci[oó]n|id(ent)?)|doc_?identidad|nro_?doc|num_?doc|(?<!(tipo|cod|codigo|desc|clase)_)identificaci[oó]n(?!_?(tipo|clase|juridica|jur[ií]dica))|identificaci[oó]n_?f[ií]sica|licencia(_?(de_?)?conducir)?(_?n(o|ro|um|umero))?|n(o|ro|um|umero)_?licencia|licencia_?cosevi|driver_?licen[cs]e|(${DOC_OWNER})_?(cedula|ced|doc|documento)|cedula_?(${DOC_OWNER})`, 0.9],
    ['documento|doc', 0.6],
  ),
  byType(STRING(6), NUMBER(6)),
  byPattern([
    [String.raw`\d-\d{4}-\d{4}`, 0.95],
    [String.raw`0\d-\d{4}-\d{4}`, 0.9],
    [String.raw`\d-\d{3}-\d{3}`, 0.7],
    // Nine bare digits are a cédula without its hyphens — and also any nine-digit code, so this
    // only backs up a column name that already says cédula.
    [String.raw`[1-9]\d{8}`, 0.4],
  ], { reject: 0.3 }))

domain('CR_L1_DIMEX', 'CR_DIMEX',
  byName([`dimex|c[eé]dula_?(de_?)?residencia|documento_?(de_?)?identidad_?migratorio|n(o|ro|um|umero)_?(dimex|residencia|extranjer[ií]a|refugiado)|carn[eé]_?(de_?)?(residencia|refugiado)|id_?migratorio|(${DOC_OWNER})_?dimex`, 0.9]),
  byPattern([[String.raw`\d{11,12}`, 0.5]], { reject: 0.3 }))

domain('CR_L1_NITE', 'CR_NITE',
  byName(['nite|n(o|ro|um|umero)_?(de_?)?identificaci[oó]n_?(tributaria_?)?especial|identificacion_?tributaria_?especial', 0.9]),
  byPattern([[String.raw`3[\s\-]?120[\s\-]?\d{6}`, 0.9]], { reject: 0.3 }))

domain('CR_L1_PASAPORTE', 'CR_CM_DIGITOS_LETRAS',
  byName(['pasaporte[a-z0-9_]*|n(o|ro|um|umero)_?pasaporte|passport[a-z0-9_]*', 0.9]),
  byPattern([[String.raw`[A-Z]{1,2}\d{6,8}`, 0.4]], { reject: 0.3 }))

// The Caja Costarricense de Seguro Social numbers the insured and the employer; the insured number
// is the cédula, the patronal number is built from the cédula of the employer.
domain('CR_L1_SEGURO_SOCIAL', 'CR_CM_ALFANUM',
  byName(['n(o|ro|um|umero)_?(asegurado|seguro_?social|patronal|patrono|afiliado|afiliaci[oó]n)|c[oó]digo_?(asegurado|patrono|patronal)|asegurado[a-z0-9_]*|ccss[a-z0-9_]*|n[uú]mero_?ccss|carn[eé]_?(ccss|asegurado)|planilla_?(ccss|n(o|ro|um|umero))|sicere', 0.85]))

domain('CR_L1_CODIGO_ESTUDIANTE', 'CR_CM_ALFANUM',
  byName(['c[oó]digo_?(de_?)?(estudiante|alumno|matr[ií]cula)|cod_?(alumno|estudiante)|n(o|ro|um|umero)_?(de_?)?(matr[ií]cula|estudiante)|carn[eé]_?(de_?)?(estudiante|universitario)|id_?(alumno|estudiante)|c[eé]dula_?escolar|identificaci[oó]n_?estudiantil', 0.8]))

domain('CR_L1_MATRICULA_PROFESIONAL', 'CR_CM_ALFANUM',
  byName(['c[oó]digo_?(profesional|m[eé]dico)|n(o|ro|um|umero)_?(de_?)?(colegiado|incorporaci[oó]n|registro_?profesional)|colegiado|incorporaci[oó]n_?(al_?)?colegio|carn[eé]_?profesional|n(o|ro|um|umero)_?(de_?)?t[ií]tulo', 0.85]))


// ── L1 · Names ──────────────────────────────────────────────────────────────

const NOT_A_PERSON = 'producto|prod|item|articulo|empresa|emp|razon|social|comercial|fantasia|archivo|calle|avenida|camino|carretera|ruta|barrio|caserio|poblado|distrito|canton|provincia|pais|banco|sucursal|agencia|plan|campana|proyecto|servicio|tabla|columna|campo|usuario|host|servidor|dominio|marca|modelo|categoria|tipo|escuela|colegio|liceo|institucion|universidad|curso|materia|documento|doc|unidad|clinica|hospital|ebais|seguro|area|dependencia|cargo|sistema|app|aplicacion|grupo|lista|reporte|informe|proceso|evento|tarea|perfil|rol|clase|objeto|cuenta|medicamento|diagnostico|estudio|programa|beneficio|partido|sindicato|religion|lengua|idioma|lugar|sede|local|tienda|deposito|bodega|proveedor|convenio|contrato|poliza|aseguradora|entidad|organismo|organizacion|institucional|parametro|variable|metodo|funcion|indice|job|script|cola|recurso|red|dispositivo|plantilla|imagen|foto|pagina|sitio|modulo|menu|opcion|accion|permiso|concepto|impuesto|moneda|emisor|factura|comprobante|pago|forma|zona|linea|actividad|rubro|sector|finca|plano|file|table|column|field|user|server|product|company|category|type|school|document|department|system|group|report|role|account|place|store|supplier|contract|device|image|page|module|action|key|label|code|project|city|country|street|bank'
const PERSON_ROLE = 'cliente|cli|paciente|pac|usuario|afiliado|asegurado|beneficiario|benef|titular|empleado|trabajador|funcionario|colaborador|alumno|estudiante|deudor|codeudor|fiador|garante|solicitante|propietario|arrendatario|inquilino|conductor|responsable|representante|apoderado|persona|ciudadano|contribuyente|madre|padre|conyuge|contacto|referencia|victima|denunciante|imputado|testigo|medico|docente|socio|heredero|donante|tutor|pensionado|jubilado|customer|patient|employee|member|holder|mother|father|spouse|contact|person|student|driver|owner'
const PARTICLES = String.raw`(?i)(de|del|la|las|los|y|e|da|do|dos|san|santa|von|van|di|le)`

algorithm('CR_NOMBRE', 'name.Name', {
  lookupFile: { uri: file('cr-nombres.txt', GIVEN_NAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Xinia')
algorithm('CR_APELLIDO', 'name.Name', {
  lookupFile: { uri: file('cr-apellidos.txt', SURNAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Jiménez')
// A word of a name. "de", "los", "la" stay where they are: "María de los Ángeles", "De la Cruz".
decompose('CR_PALABRA_NOMBRE', [[PARTICLES, keep]], apply('CR_NOMBRE'), 'Yorleny')
decompose('CR_PALABRA_APELLIDO', [[PARTICLES, keep]], apply('CR_APELLIDO'), 'Oconitrillo')
const N = apply('CR_PALABRA_NOMBRE')
const S = apply('CR_PALABRA_APELLIDO')

decompose('CR_NOMBRES', [
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, N],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, N, N],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, N, N],
], CM, 'María de los Ángeles')
decompose('CR_APELLIDOS', [
  [String.raw`(\S+)`, S],
  [String.raw`(\S+)\s+(\S+)`, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, S, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, S, S, S, S],
], CM, 'Jiménez Oconitrillo')
// Costa Rican order: one or two given names, the father's surname and the mother's surname. Two
// words are a given name and a surname; three, a given name and two surnames; four, two and two.
decompose('CR_NOMBRE_COMPLETO', [
  [String.raw`([^,]+),\s*(.+)`, apply('CR_APELLIDOS'), apply('CR_NOMBRES')],
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, S, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, N, S, S, S],
], CM, 'José Pablo Jiménez Oconitrillo')
const NAME_WORDS = ['de', 'del', 'la', 'las', 'los', 'y']

domain('CR_L1_NOMBRE', 'CR_NOMBRES',
  byName(
    ['primer_?nombre|segundo_?nombre|nombres?_?(de_?)?pila|pri(mer)?_?nom|seg(undo)?_?nom|nombre_?1|nombre_?2|first_?names?|given_?names?|fname|middle_?names?|nombres(?!_?(completos?|y_?apellidos?|apellidos?))', 0.85],
    [`nombre(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|apellidos?|usuario|corto|largo))|nom(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}))|name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))`, 0.5],
  ),
  byList([['cr-detectar-nombres.txt', [...GIVEN_NAMES, ...NAME_WORDS], 0.7]], { tokenize: true, reject: 0.3 }))

domain('CR_L1_APELLIDO', 'CR_APELLIDOS',
  byName(['apellidos?|primer_?apellido|segundo_?apellido|apellido_?(1|2|paterno|materno)|ape_?(1|2|pat|mat)|ap_?(paterno|materno)|last_?names?|surnames?|family_?names?|lname', 0.85]),
  byList([['cr-detectar-apellidos.txt', [...SURNAMES, ...NAME_WORDS], 0.7]], { tokenize: true, reject: 0.3 }))

domain('CR_L1_NOMBRE_COMPLETO', 'CR_NOMBRE_COMPLETO',
  byName(
    [`nombres?_?(completos?|y_?apellidos?|apellidos?)|apellidos?_?(y_?)?nombres?|nombre_?(del_?|de_?la_?)?(${PERSON_ROLE})|(${PERSON_ROLE})_?(nombre|nom)|nom_?(${PERSON_ROLE})|nombre_?(madre|padre|tutor|conyuge|contacto_?emergencia|referencia)|full_?name|person_?name`, 0.9],
    ['madre|padre|tutor|conyuge|representante_?legal|apoderado|fiador|garante|beneficiario|heredero|titular|referencia_?(personal|familiar)', 0.6],
    [`nombre(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|apellidos?|usuario|corto|largo))|nom(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}))|name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))`, 0.5],
  ),
  byList([['cr-detectar-nombres.txt', [...GIVEN_NAMES, ...NAME_WORDS], 0.65], ['cr-detectar-apellidos.txt', [...SURNAMES, ...NAME_WORDS], 0.65]], { tokenize: true, reject: 0.3 }))

// ── L1 · Contact ────────────────────────────────────────────────────────────

decompose('CR_EMAIL', [
  // The top-level domain becomes .test, reserved for tests: a masked address can never deliver.
  [String.raw`([^@\s]+)@([^@\s]+)\.([A-Za-z]{2,24}(?:\.[A-Za-z]{2})?)`, CM, CM, redactAs('test')],
], CM, 'jose.jimenez@gmail.com')
domain('CR_L1_EMAIL', 'CR_EMAIL',
  byName(['e_?mail[a-z0-9_]*|mail[a-z0-9_]*|correo(_?electr[oó]nico)?[a-z0-9_]*|dir_?correo|direcci[oó]n_?(de_?)?correo|direcci[oó]n_?electr[oó]nica', 0.85]),
  byType(STRING(5)),
  byPattern([[String.raw`[A-Za-z0-9._%+'\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}`, 1]], { reject: 0.2 }))

// Every Costa Rican number has eight digits and no area code: 2 for a landline, 4 for IP telephony,
// 5 to 8 for a mobile. Article 9.3 keeps the **números de teléfono privados** out of the data of
// unrestricted access, which is what makes this a column of its own. The first digit stays, so a
// masked number still says landline or mobile — and SINPE Móvil makes a mobile number a payment
// address as well.
decompose('CR_TELEFONO', [
  [String.raw`(\+?506[\s\-]?)([2458-9])([\d\s\-]{7,10})`, keep, keep, DIGITS],
  [String.raw`(\(?\+?506\)?[\s\-]?)([2458-9])([\d\s\-]{7,10})`, keep, keep, DIGITS],
  [String.raw`([2458-9])([\d\s\-]{7,9})`, keep, DIGITS],
], DIGITS, '+506 8312 4567')
domain('CR_L1_TELEFONO', 'CR_TELEFONO',
  byName(['tel|tel[eé]fono[a-z0-9_]*|tel_?(fijo|casa|habitaci[oó]n|oficina|trabajo|contacto|celular|m[oó]vil)|celular[a-z0-9_]*|cel|m[oó]vil|whats_?app|sinpe_?m[oó]vil|n(o|ro|um|umero)_?(tel|tel[eé]fono|celular|cel|contacto)|fax|phone[a-z0-9_]*|mobile[a-z0-9_]*', 0.85]),
  byPattern([
    [String.raw`(\+?506[\s\-]?)?[5-8]\d{3}[\s\-]?\d{4}`, 0.8],
    [String.raw`(\+?506[\s\-]?)?[24]\d{3}[\s\-]?\d{4}`, 0.6],
  ], { reject: 0.3 }))

// Costa Rica has almost no street addresses: an address is a distance and a direction from a
// landmark — "200 metros norte de la iglesia católica" — and the **dirección exacta de la
// residencia** is the first thing article 9.3 takes out of the data of unrestricted access. The
// whole line becomes a fictitious one.
const LANDMARKS = ['la iglesia católica', 'el parque central', 'la escuela', 'el EBAIS', 'la plaza de deportes', 'el salón comunal', 'la pulpería', 'el supermercado', 'la gasolinera', 'el cementerio', 'la Cruz Roja', 'el puente', 'la entrada principal', 'la delegación de policía', 'el templo católico', 'la cancha de fútbol', 'el bar La Esquina', 'la farmacia', 'el colegio técnico', 'la bomba']
const DIRECTIONS = ['norte', 'sur', 'este', 'oeste', 'noreste', 'noroeste', 'sureste', 'suroeste']
const DWELLINGS = ['casa esquinera color verde', 'casa de dos plantas', 'casa blanca con portón negro', 'apartamento 3', 'última casa a mano derecha', 'casa con tapia de ladrillo', 'portón café', 'casa número 12', 'tercera casa a mano izquierda', 'edificio de apartamentos, segundo piso']
const COMPLEXES = ['Urbanización Los Laureles', 'Residencial El Roble', 'Urbanización La Guaria', 'Residencial Montelimar', 'Urbanización Santa Cecilia', 'Residencial Las Brisas', 'Urbanización El Prado', 'Condominio Villa Real', 'Residencial Los Arcos', 'Urbanización La Paz']
lookup('CR_DIRECCION', 'cr-direcciones.txt', (() => {
  const random = seeded(8968)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const num = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
  const metres = () => [25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 600, 800][Math.floor(random() * 13)]
  const out = new Set()
  while (out.size < 4000) {
    const r = random()
    if (r < 0.4) out.add(`${metres()} metros ${pick(DIRECTIONS)} de ${pick(LANDMARKS)}, ${pick(DWELLINGS)}`)
    else if (r < 0.6) out.add(`${metres()} metros ${pick(DIRECTIONS)} y ${metres()} ${pick(DIRECTIONS)} de ${pick(LANDMARKS)}`)
    else if (r < 0.75) out.add(`${pick(COMPLEXES)}, casa ${num(1, 240)}`)
    else if (r < 0.85) out.add(`${pick(COMPLEXES)}, etapa ${num(1, 6)}, casa ${num(1, 90)}`)
    else if (r < 0.93) out.add(`Avenida ${num(1, 40)}, Calle ${num(1, 60)}, ${pick(DWELLINGS)}`)
    else out.add(`Barrio ${pick(BARRIOS)}, ${metres()} metros ${pick(DIRECTIONS)} de ${pick(LANDMARKS)}`)
  }
  return [...out]
})(), '200 metros norte de la iglesia católica, casa esquinera color verde', 'PRESERVE_LOOKUP_FILE')
domain('CR_L1_DIRECCION', 'CR_DIRECCION',
  byName(['(?<!(mac|ip|e_?mail|web|url|correo)_?)direcci[oó]n(?!_?(ip|mac|email|e_?mail|correo|electr[oó]nica|web|url|tipo|id|general|regional))[a-z0-9_]*|domicilio[a-z0-9_]*|dom_?(residencia|particular|laboral|cliente|fiscal|exacto)|residencia|lugar_?(de_?)?residencia|se[nñ]as(_?(exactas|adicionales|particulares))?|otras_?se[nñ]as|(?<!(mac|ip|e_?mail|web|url)_?)address(?!_?(ip|mac|email|e_?mail|web|url|type|id))[a-z0-9_]*', 0.8]),
  byType(STRING(6)),
  byPattern([
    [String.raw`(?i).*\d{2,3}\s*(m|mts|metros)\.?\s+(norte|sur|este|oeste|noreste|noroeste|sureste|suroeste).*`, 0.9],
    [String.raw`(?i)(urbanizaci[oó]n|residencial|condominio|barrio|caser[ií]o)\s+[a-záéíóúñ0-9.' ]{2,40}.*`, 0.7],
    [String.raw`(?i).*(avenida|calle)\s*\d{1,3}.*(calle|avenida)\s*\d{1,3}.*`, 0.7],
    [String.raw`(?i).*\b(contiguo|frente|diagonal|costado|detr[aá]s)\b.*`, 0.6],
  ], { reject: 0.2 }))

domain('CR_L1_DIRECCION_COMPLEMENTO', 'CR_CM_ALFANUM',
  byName(['apartamento|apto|apto_?n(o|ro|um|umero)|piso|torre|bloque|block|casa_?n(o|ro|um|umero)|n(o|ro|um|umero)_?(casa|apto|apartamento|local|oficina)|lote|etapa|filial|condominio|complemento(_?direcci[oó]n)?|referencia_?(de_?)?(direcci[oó]n|domicilio)|apartado(_?postal)?|apdo|p_?o_?box', 0.7]))


// ── L1 · Bank accounts: the IBAN and its two check digits ───────────────────
//
// Since 2017 every Costa Rican account is an IBAN of 22 characters: `CR`, two check digits, a
// reserved zero, three digits for the bank and fourteen for the account — the 17-digit Cuenta
// Cliente of SINPE with five characters in front. The check digits are the ISO 13616 ones: move
// `CRkk` to the end, read `C` as 12 and `R` as 27, and the number is valid when it leaves a
// remainder of 1 modulo 97. Masking the account without rewriting them produces an IBAN every
// library rejects, and Costa Rican systems validate it.
//
// No framework computes a remainder modulo 97, and Check Digit writes one character while these
// are two. So the set computes it with lookup tables, the way the Panama set computes the DV of a
// RUC: a **two-digit state** — the remainder so far — starts at the left of the number and travels
// right one character at a time, each step a Data Cleansing that turns "state + character" into
// "character + new state". At the right end a table of 97 lines turns the remainder into the check
// digits, and a second traveller carries them back to the front, where `CR` and the spaces of the
// printed form wait as one-character markers.
//
// The bank stays: it is not personal data, and keeping it keeps a test account inside a real bank.
const MARK_CR = '~'
const MARK_SPACE = '_'
const pad2 = (n) => String(n).padStart(2, '0')
const IBAN_ALPHABET = [...'0123456789', MARK_SPACE]

function buildIban() {
  // A digit is consumed and the remainder advances; a space marker is only stepped over.
  const steps = []
  for (let s = 0; s < 97; s++) {
    for (let d = 0; d <= 9; d++) steps.push([`${pad2(s)}${d}`, `${d}${pad2((s * 10 + d) % 97)}`])
    steps.push([`${pad2(s)}${MARK_SPACE}`, `${MARK_SPACE}${pad2(s)}`])
  }
  const step = cleansing('CR_IBAN_PASO', 'cr-iban-paso.txt', steps, '001', '|')
  // 98 − (r·10⁶ + 1227·100) mod 97, where 10⁶ ≡ 27 and 122700 ≡ 92 (mod 97).
  const finals = Array.from({ length: 97 }, (_, r) => [pad2(r), pad2(98 - ((r * 27 + 92) % 97))])
  const final = cleansing('CR_IBAN_RESULTADO', 'cr-iban-resultado.txt', finals, '18', '|')
  const carry = cleansing('CR_IBAN_TRASLADO', 'cr-iban-traslado.txt',
    Array.from({ length: 100 }, (_, n) => pad2(n)).flatMap((kk) => IBAN_ALPHABET.map((c) => [`${c}${kk}`, `${kk}${c}`])), '605', '|')

  // The printed form groups the 22 characters in fours: CR05 0152 0200 1026 2840 66.
  const prepare = [
    [String.raw`(?i)(CR)(\d{2})( )(\d{4})( )(\d{4})( )(\d{4})( )(\d{4})( )(\d{2})`,
      redactAs(`${MARK_CR}`), redactAs('00'), redactAs(MARK_SPACE), keep, redactAs(MARK_SPACE), DIGITS,
      redactAs(MARK_SPACE), DIGITS, redactAs(MARK_SPACE), DIGITS, redactAs(MARK_SPACE), DIGITS],
    [String.raw`(?i)(CR)(\d{2})(\d{4})(\d{14})`, redactAs(`${MARK_CR}`), redactAs('00'), keep, DIGITS],
  ]
  const restore = [
    [String.raw`(${MARK_CR})(\d{2})(${MARK_SPACE})(\d{4})(${MARK_SPACE})(\d{4})(${MARK_SPACE})(\d{4})(${MARK_SPACE})(\d{4})(${MARK_SPACE})(\d{2})`,
      redactAs('CR'), keep, redactAs(' '), keep, redactAs(' '), keep, redactAs(' '), keep, redactAs(' '), keep, redactAs(' '), keep],
    [String.raw`(${MARK_CR})(\d{2})(\d{18})`, redactAs('CR'), keep, keep],
  ]
  // Eighteen digits and, in the printed form, five markers: 23 positions for the state to pass. A
  // step that finds the value too short does not match, and the compact form simply stops early.
  const POSITIONS = 23
  const steps2 = [decompose('CR_IBAN_PREPARAR', prepare, keep, 'CR05015202001026284066')]
  for (let k = 1; k <= POSITIONS; k++) {
    steps2.push(decompose(`CR_IBAN_IDA_${pad2(k)}`, [[`(.{${k}})(.{3})(.*)`, keep, apply(step), keep]], keep, '~000152020010262840 66'))
  }
  steps2.push(decompose('CR_IBAN_CALCULAR', [['(.*)(.{2})', keep, apply(final)]], keep, '~01520200102628406618'))
  for (let k = POSITIONS; k >= 1; k--) {
    steps2.push(decompose(`CR_IBAN_VUELTA_${pad2(k)}`, [[`(.{${k}})(.{3})(.*)`, keep, apply(carry), keep]], keep, '~01520200102628406605'))
  }
  steps2.push(decompose('CR_IBAN_RESTAURAR', restore, keep, '~05015202001026284066'))
  return chain('CR_IBAN', steps2, 'CR05015202001026284066')
}
buildIban()

// A Cuenta Cliente written on its own is the same 17 digits without the IBAN in front, and carries
// no check digit of its own: the bank stays and the account changes.
decompose('CR_CUENTA', [
  [String.raw`(?i)(CR\d{2}[\s]?\d{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{2})`, apply('CR_IBAN')],
  [String.raw`(?i)(CR\d{20})`, apply('CR_IBAN')],
  [String.raw`(\d{3})(\d{14})`, keep, DIGITS],
], DIGITS, 'CR05015202001026284066')
domain('CR_L1_CUENTA_BANCARIA', 'CR_CUENTA',
  byName(['cuenta_?(bancaria|banco|corriente|ahorros?|cliente|salario|planilla|abono|dep[oó]sito|destino|origen|iban)|n(o|ro|um|umero)_?(de_?)?(cuenta|cta)|nro_?cta|num_?cta|cta_?(cte|corriente|ahorros?|bancaria|cliente)|iban[a-z0-9_]*|cuenta_?iban|account_?(no|num|number)|bank_?account', 0.9]),
  byPattern([
    [String.raw`CR\d{20}`, 0.95],
    [String.raw`CR\d{2}(\s\d{4}){4}\s\d{2}`, 0.95],
    [String.raw`\d{17}`, 0.5],
  ], { reject: 0.3 }))

// ── L1 · Cards, wallets, network, devices, vehicles, property ──────────────

// Payment Card fails a row that has no digits to mask; only values shaped like a card reach it.
algorithm('CR_TARJETA_LUHN', 'characterMapping.PaymentCard', { minMaskedPositions: 6, preserve: 0 }, '4532000000000001')
decompose('CR_TARJETA', [[String.raw`(\d[\d\s\-]{11,22}\d)`, apply('CR_TARJETA_LUHN')]], keep, '4532 0000 0000 0001')
domain('CR_L1_TARJETA', 'CR_TARJETA',
  byName(['tarjeta(_?(cr[eé]dito|d[eé]bito|n(o|ro|um|umero)))?|n(o|ro|um|umero)_?tarjeta|pan|card_?(no|num|number)|credit_?card|tc_?(numero|num|nro)', 0.85]),
  // 0.9, not 1: an IMEI is 15 Luhn-valid digits too, and its own column name should win.
  byPattern([[String.raw`\d{13,19}`, 0.9, { checksum: 'LUHN', clean: String.raw`[\s\-]` }]], { reject: 0.3 }))

domain('CR_L1_BILLETERA', 'CR_CM_ALFANUM',
  byName(['billetera(_?(digital|electr[oó]nica|m[oó]vil))?|wallet(_?(id|address|direccion))?|kash|tapp|monedero_?(digital|electr[oó]nico)|dinero_?electr[oó]nico|c[oó]digo_?qr|qr_?(id|codigo)|direcci[oó]n_?(bitcoin|btc|wallet)|btc_?(address|direccion)', 0.85]),
  byPattern([[String.raw`(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,59}`, 0.7]], { reject: 0.3 }))

algorithm('CR_OCTETO', 'characterMapping.NumericMapping', { minValue: 1, maxValue: 254 }, '10')
decompose('CR_IP', [
  [String.raw`(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})`, apply('CR_OCTETO'), apply('CR_OCTETO'), apply('CR_OCTETO'), apply('CR_OCTETO')],
], apply('CR_CM_HEX'), '201.196.45.12')
domain('CR_L1_IP', 'CR_IP',
  byName(['ip|ip_?(address|addr|origen|destino|cliente|usuario|acceso|login|remota|publica)|direcci[oó]n_?ip|dir_?ip|ipv[46]|remote_?addr(ess)?|client_?ip|host_?ip', 0.85]),
  byPattern([
    [String.raw`((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)`, 1],
    [String.raw`[0-9A-Fa-f]{1,4}(:[0-9A-Fa-f]{0,4}){2,7}`, 0.9],
  ], { reject: 0.3 }))

domain('CR_L1_DISPOSITIVO', 'CR_CM_HEX',
  byName(['imei|imsi|iccid|mac|mac_?address|direcci[oó]n_?mac|device_?(id|uuid|serial)|id_?(dispositivo|equipo|celular)|serial_?(equipo|celular|dispositivo)|advertising_?id|idfa|gaid|session_?id|id_?sesi[oó]n', 0.8]),
  byPattern([
    [String.raw`([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}`, 1],
    [String.raw`\d{15}`, 0.8, { checksum: 'LUHN' }],
  ], { reject: 0.3 }))

domain('CR_L1_COOKIE', 'CR_CM_ALFANUM',
  byName(['cookie(_?(id|value|valor|nombre))?|cookies|_?ga|_?gid|fbp|fbclid|utm_?(source|medium|campaign|term|content)|id_?(navegador|browser|visitante)|visitor_?id|tracking_?id|client_?id', 0.8]))

// Plates: digits for a private car, three letters and three digits since the Registro Nacional
// opened the alphanumeric series, and a class prefix for the rest — MOT a motorcycle, CL light
// cargo, C cargo, AB a bus, TSJ or TA a taxi.
decompose('CR_PLACA', [
  [String.raw`(?i)(MOT|CL|TSJ|TA|TB|TC|TG|TH|TL|TP|AB|SJB|PE|CD|C|M)([\s\-]?)(\d{3,6})`, keep, keep, DIGITS],
  [String.raw`([A-Za-z]{3})([\s\-]?)(\d{3})`, apply('CR_CM_DIGITOS_LETRAS'), keep, DIGITS],
  [String.raw`(\d{3,6})`, DIGITS],
], apply('CR_CM_DIGITOS_LETRAS'), 'BLM123')
domain('CR_L1_PLACA', 'CR_PLACA',
  byName(['placa(_?(veh[ií]culo|auto|moto|n(o|ro|um|umero)))?|n(o|ro|um|umero)_?placa|matr[ií]cula(?!_?(profesional|m[eé]dica|estudiante|consular))(_?(veh[ií]culo|auto|moto))?|license_?plate|plate(_?(no|number))?', 0.85]),
  byPattern([
    [String.raw`(?i)(MOT|CL|TSJ|AB|SJB)[\s\-]?\d{3,6}`, 0.8],
    [String.raw`[A-Z]{3}[\s\-]?\d{3}`, 0.5],
    [String.raw`\d{6}`, 0.35],
  ], { reject: 0.3 }))

domain('CR_L1_VEHICULO', 'CR_CM_ALFANUM',
  byName(['vin|chasis|n(o|ro|um|umero)_?(chasis|motor|serie|vin)|motor_?n(o|ro|um|umero)|t[ií]tulo_?(de_?)?propiedad_?veh[ií]culo|riteve|dekra|n(o|ro|um|umero)_?(de_?)?revisi[oó]n_?t[eé]cnica|marchamo', 0.85]),
  byPattern([[String.raw`[A-HJ-NPR-Z0-9]{17}`, 0.7]], { reject: 0.3 }))

// Article 1 covers the data of a person "o bienes" — the assets as well as the person — and article
// 12 of the regulation repeats it. The Registro Inmobiliario numbers every property with a folio
// real, `1-234567-000`, and the Catastro numbers its map with a plano catastrado, `SJ-1234567-2010`.
decompose('CR_INMUEBLE', [
  [String.raw`(?i)([A-Z]{1,2})([\s\-])(\d{6,7})([\s\-])(\d{4})`, keep, keep, DIGITS, keep, keep],
  [String.raw`(\d)([\s\-])(\d{6})([\s\-])(\d{3})`, PROV_DIGIT, keep, DIGITS, keep, DIGITS],
  [String.raw`(\d)([\s\-])(\d{6})`, PROV_DIGIT, keep, DIGITS],
], CM, '1-234567-000')
domain('CR_L1_INMUEBLE', 'CR_INMUEBLE',
  byName(['folio_?real|n(o|ro|um|umero)_?(de_?)?(finca|folio|folio_?real|plano|plano_?catastrado|matr[ií]cula_?inmueble|derecho)|finca(_?(n(o|ro|um|umero)|filial))?|plano_?catastrado|matr[ií]cula_?(inmobiliaria|catastral)|c[oó]digo_?catastral|n(o|ro|um|umero)_?(de_?)?(medidor|nis|servicio_?el[eé]ctrico)|nis(_?(ice|cnfl|aya))?', 0.85]),
  byPattern([[String.raw`[1-7]-\d{6}-\d{3}`, 0.8], [String.raw`(?i)(SJ|A|C|H|G|P|L)-\d{6,7}-\d{4}`, 0.8]], { reject: 0.3 }))

domain('CR_L1_CONTRATO', 'CR_CM_ALFANUM',
  byName(['n(o|ro|um|umero)_?(contrato|p[oó]liza|cr[eé]dito|pr[eé]stamo|solicitud|expediente_?(administrativo|interno)|tr[aá]mite|referencia|cliente|socio|suscriptor|suministro|servicio|caso|ticket|beneficio|siniestro|reclamo)|contrato_?(n(o|ro|um|umero))|c[oó]digo_?(cliente|socio|empleado|afiliado|suministro)|id_?(cliente|socio|empleado|afiliado)|n(o|ro)_?(empleado|funcionario)|c[oó]digo_?(de_?)?(empleado|funcionario|puesto)', 0.7]))

domain('CR_L1_USUARIO', 'CR_CM_ALFANUM',
  byName(['usuario|user_?name|username|login|alias|apodo|nick(_?name)?|perfil_?(instagram|facebook|twitter|tiktok|linkedin|x)|instagram|facebook|twitter|tiktok|linkedin|red_?social|handle', 0.7]))

domain('CR_L1_CREDENCIAL', 'CR_REDACTAR',
  byName(['contrase[nñ]a|clave(?!_?(catastral|primaria|for[aá]nea|valor|producto))|password|passwd|pwd|pass|hash_?(clave|contrasena|password)|pin|c[oó]digo_?(seguridad|verificaci[oó]n|acceso|otp)|cvv|cvc|token(_?(acceso|refresh|api))?|access_?token|refresh_?token|api_?key|llave_?(api|privada)|secreto|secret|otp|firma_?(electr[oó]nica|digital)_?(clave|pin)|pregunta_?secreta|respuesta_?secreta|frase_?semilla|seed_?phrase', 0.9]))

// Article 9.3 takes **la fotografía** out of the data of unrestricted access by name.
domain('CR_L1_IMAGEN', 'CR_REDACTAR',
  byName(['foto(graf[ií]a)?[a-z0-9_]*|imagen_?(persona|rostro|perfil|c[eé]dula|documento)|avatar|selfie|retrato|video_?(persona|entrevista)|audio_?(voz|llamada)|grabaci[oó]n(_?(llamada|voz))?|url_?foto|ruta_?(foto|imagen)|photo[a-z0-9_]*|picture|image_?(url|path|person)', 0.85]))

decompose('CR_COORDENADA', [
  // The integer part and first decimal stay (about 11 km): the place is generalized, not moved.
  [String.raw`(-?\d{1,3}[.,]\d)(\d+)\s*([,;])\s*(-?\d{1,3}[.,]\d)(\d+)`, keep, DIGITS, keep, keep, DIGITS],
  [String.raw`(-?\d{1,3}[.,]\d)(\d+)`, keep, DIGITS],
], keep, '9.935800')
domain('CR_L1_GEOLOCALIZACION', 'CR_COORDENADA',
  byName(
    ['lat|latitud|lon|lng|longitud|coordenadas?|coord_?[xy]|geo_?(lat|lon|lng|loc|localizacion|posicion)|georreferenciaci[oó]n|geolocalizaci[oó]n|gps(_?(ubicaci[oó]n|posici[oó]n|coordenadas))?|ubicaci[oó]n_?gps|crtm05|lambert', 0.85],
    ['long', 0.5],
  ),
  byPattern([
    [String.raw`(8|9|10|11)\.\d{3,}\s*,\s*-8[2-6]\.\d{3,}`, 0.9],
    [String.raw`-8[2-6]\.\d{4,}`, 0.5],
    [String.raw`(8|9|10|11)\.\d{4,}`, 0.4],
  ], { reject: 0.3 }))

// ── L1 · Free text ──────────────────────────────────────────────────────────

algorithm('CR_TEXTO_LIBRE', 'freeTextRedaction.FreeTextRedaction', {
  regularExpressions: [
    String.raw`(?<!\d)\d-\d{4}-\d{4}(?!\d)`,
    String.raw`(?<!\d)[1-9]\d{8}(?!\d)`,
    String.raw`(?<!\d)\d{11,12}(?!\d)`,
    String.raw`3-1[23]0-\d{6}`,
    String.raw`[\w.+\-]+@[\w\-]+(\.[\w\-]+)+`,
    // Free Text Redaction splits the text on whitespace and matches inside a word, so a phone
    // number written with a space in the middle is reached as two words, not as one number.
    String.raw`(?<![\d\-])(\+?506\-?)?[2458-9]\d{3}\-?\d{4}(?![\d\-])`,
    String.raw`(?<!\d)\d{13,19}(?!\d)`,
    String.raw`CR\d{20}`,
    String.raw`(?<!\d)(\d{1,3}\.){3}\d{1,3}(?!\d)`,
  ].map((patternString) => ({ patternString })),
  regExRedactValue: '[DATO]',
  lookupFile: { uri: file('cr-texto-nombres.txt', unique([...GIVEN_NAMES, ...SURNAMES].flatMap((v) => [v, v.toUpperCase(), fold(v), fold(v).toUpperCase()]))) },
  lookupFileRedactValue: '[NOMBRE]',
  isDenyList: true,
}, 'Cliente Jiménez, cédula 1-0234-0567, correo j.jimenez@gmail.com, cel 83124567')

domain('CR_L1_TEXTO_LIBRE', 'CR_TEXTO_LIBRE',
  byName(['observaci[oó]n(es)?|obs|comentarios?|notas?|anotaci[oó]n(es)?|glosa|descripci[oó]n_?(queja|reclamo|solicitud|caso|hechos|novedad|atenci[oó]n|denuncia)|detalle_?(reclamo|solicitud|caso|atenci[oó]n)|hechos|relato|justificaci[oó]n|(?<!(id|cd|cod|codigo|tipo|fecha|estado|num|nro)_?)mensaje(?!_?(id|tipo|codigo|fecha|estado|cola|log))|texto(_?libre)?|resumen_?(caso|atenci[oó]n)|queja|reclamo|denuncia_?texto|remarks?|comments?|notes?|free_?text|memo', 0.6]),
  byType(STRING(30)),
  byPattern([
    [String.raw`\d-\d{4}-\d{4}`, 0.8],
    [String.raw`[\w.+\-]+@[\w\-]+\.[A-Za-z]{2,}`, 0.7],
    [String.raw`[5-8]\d{3}[\s\-]?\d{4}`, 0.6],
  ], { reject: 0, partial: true }))


// ── L2 · Quasi-identifiers ──────────────────────────────────────────────────

// Small shifts: large enough to break the link to the person, small enough that ages and school
// years move for few people.
algorithm('CR_FECHA_NACIMIENTO', 'dateAlgorithms.DateShift', { minRange: -60, maxRange: 60, unit: 'DAYS', roll: false }, '1985-07-20')
algorithm('CR_FECHA_EVENTO', 'dateAlgorithms.DateShift', { minRange: -30, maxRange: 30, unit: 'DAYS', roll: false }, '2021-03-15')

domain('CR_L2_FECHA_NACIMIENTO', 'CR_FECHA_NACIMIENTO',
  byName(['(fecha|fec|fch|f)_?(de_?)?nac(imiento)?|fnac|fechanac(imiento)?|cumplea[nñ]os|dob|date_?of_?birth|birth_?date|birthday', 0.9]),
  byType(...DATES, STRING(6)))

decompose('CR_ANIO', [[String.raw`(\d{3})(\d)`, keep, DIGITS]], keep, '1985')
domain('CR_L2_ANIO_NACIMIENTO', 'CR_ANIO',
  byName(['a[nñ]o_?(de_?)?nac(imiento)?|anio_?nac(imiento)?|year_?of_?birth|birth_?year|yob', 0.9]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// 37 becomes 3x. From 100 on, 90.
decompose('CR_EDAD', [
  [String.raw`(\d{3,})`, redactAs('90')],
  [String.raw`([1-9])(\d)([.,]\d+)`, keep, DIGITS, keep],
  [String.raw`([1-9])(\d)`, keep, DIGITS],
  [String.raw`(\d)`, DIGITS],
], keep, '37')
domain('CR_L2_EDAD', 'CR_EDAD',
  byName(['edad(_?(actual|a[nñ]os|anios|paciente|afiliado|cliente|al_?(ingreso|diagn[oó]stico|fallecimiento)))?|grupo_?etario|tramo_?(de_?)?edad|rango_?(de_?)?edad|quinquenio|age(_?(years|group))?', 0.85]),
  byType(NUMBER(0, 6), STRING(0, 6)))

domain('CR_L2_FECHA_EVENTO', 'CR_FECHA_EVENTO',
  byName(['(fecha|fec|fch|f)_?(de_?)?(defunci[oó]n|fallecimiento|muerte|matrimonio|divorcio|ingreso|egreso|alta|baja|cese|retiro|contrataci[oó]n|despido|pensi[oó]n|jubilaci[oó]n|internamiento|hospitalizaci[oó]n|diagn[oó]stico|atenci[oó]n|consulta|parto|detenci[oó]n|sentencia|emisi[oó]n(_?(cedula|documento))?|vencimiento_?c[eé]dula|vacunaci[oó]n|cirug[ií]a|accidente|incapacidad)|fec_?(emi|emision|defuncion|ingreso|egreso|baja)|date_?of_?(death|marriage|hire|admission|discharge)', 0.8]),
  byType(...DATES, STRING(6)))

// Each vocabulary replaced within itself: M/F stays M/F.
decompose('CR_SEXO', [
  ['(?i)(femenino|masculino)', apply(lookup('CR_SEXO_FEMENINO_MASCULINO', 'cr-sexo-femenino-masculino.txt', ['Femenino', 'Masculino']))],
  ['(?i)(mujer|hombre)', apply(lookup('CR_SEXO_MUJER_HOMBRE', 'cr-sexo-mujer-hombre.txt', ['Mujer', 'Hombre']))],
  ['(?i)(female|male)', apply(lookup('CR_SEXO_FEMALE_MALE', 'cr-sexo-female-male.txt', ['Female', 'Male']))],
  ['(?i)([fm])', apply(lookup('CR_SEXO_F_M', 'cr-sexo-f-m.txt', ['F', 'M']))],
  ['(?i)([hm])', apply(lookup('CR_SEXO_H_M', 'cr-sexo-h-m.txt', ['H', 'M']))],
  ['([12])', apply(lookup('CR_SEXO_1_2', 'cr-sexo-1-2.txt', ['1', '2']))],
], keep, 'F')
domain('CR_L2_SEXO', 'CR_SEXO',
  byName(['sexo(_?(biol[oó]gico|al_?nacer|paciente|afiliado|cliente))?|(tp|tipo|cod|cd|id)_?sexo|g[eé]nero(?!_?(identidad|autopercibido))|sex|gender(?!_?identity)', 0.85]),
  byList([['cr-detectar-sexo.txt', ['f', 'm', 'h', 'femenino', 'masculino', 'mujer', 'hombre', 'female', 'male'], 0.5]], { reject: 0.5 }))

// ── L2 · Where people live ──────────────────────────────────────────────────
//
// The República de Costa Rica is divided into 7 provincias, 84 cantones and 492 distritos, and the
// distritos are small: most of them hold fewer than 20,000 people and the smallest hold a few
// hundred. Article 2 q) of the regulation says a natural person is identifiable when the identity
// can be determined "directa o **indirectamente**, mediante cualquier información referida a su
// identidad anatómica, fisiológica, psíquica, económica, cultural o social", and not identifiable
// when identification "requiere plazos o actividades desproporcionadas" — a relative test, which
// is exactly what a generalization answers. A birth date, a sex and one small distrito point at a
// handful of people, so a small distrito becomes the nearest distrito of at least 20,000 in the
// same cantón, or in the same provincia when the cantón has none. The cantón is generalized on the
// same rule, and the 7 provincias stay.

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
 * The nearest large place of the first group that has one. A cantón whose every distrito is below
 * the threshold sends its distritos to the provincia, which always has one.
 */
const nearestIn = (place, large, all, ...groups) => {
  for (const group of groups) {
    const candidates = large.filter(group)
    if (candidates.length) return nearest(place, candidates)
  }
  const inProvince = all.filter((x) => x.provinceCode === place.provinceCode)
  return inProvince.reduce((a, b) => ((b.population ?? 0) > (a.population ?? 0) ? b : a))
}
const largeDistritos = DISTRITOS.filter((d) => d.population >= SMALL_PLACE)
const largeCantones = CANTONES.filter((c) => c.population >= SMALL_PLACE)
const spellingsOf = (p) => unique([p.name, ...(p.aliases ?? [])])
const nameKey = (name) => fold(name).toLowerCase()
// How systems write a name: as it is, in capitals, and without accents. The decree publishes the
// names in capitals, so both spellings reach the table.
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
// With the cantón or the provincia, as systems write them to tell homonyms apart — and Costa Rica
// is full of them: 21 distritos are called San Rafael and 7 cantones share a name with a distrito.
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
  const mostPopulous = (all) => [...all].reduce((a, b) => ((b.population ?? 0) > (a.population ?? 0) ? b : a))
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

const distritoTo = (d) => nearestIn(d, largeDistritos, DISTRITOS, (x) => x.cantonCode === d.cantonCode, (x) => x.provinceCode === d.provinceCode)
const distritoPlaces = DISTRITOS.map((d) => ({ ...d, small: !(d.population >= SMALL_PLACE) }))
const distritoByCode = new Map(distritoPlaces.map((d) => [d.code, d]))
for (const d of distritoPlaces) d.to = d.small ? distritoByCode.get(distritoTo(d).code) : d
// A distrito is written with its cantón and with its provincia. Where a cantón and its provincia
// share a name — San José, Alajuela, Cartago, Heredia, Puntarenas, Limón — the two qualifiers write
// the same string, and the provincia keeps it: that is how systems disambiguate homonyms.
const dedupe = (qualifiers) => qualifiers.filter((q) => q.level === 'prov' || !qualifiers.some((x) => x.level === 'prov' && x.name === q.name))
for (const d of distritoPlaces) {
  const canton = cantonPlaceByCode.get(d.cantonCode)
  d.qualifiers = dedupe([{ level: 'canton', code: d.cantonCode, name: canton.name }, { level: 'prov', code: d.provinceCode, name: d.province }])
  d.outQualifiers = [{ level: 'canton', name: canton.to.name }, { level: 'prov', name: d.province }]
}
// The 7 provincias are far above the threshold and are never generalized; they join the table only
// so that a name shared with a provincia is left alone.
const provincePlaces = PROVINCIAS.map((p) => ({ ...p, small: false, to: null, qualifiers: [], outQualifiers: [] }))
for (const p of provincePlaces) p.to = p

const places = generalization([...distritoPlaces, ...cantonPlaces, ...provincePlaces])
cleansing('CR_DISTRITO', 'cr-distritos-generalizados.txt', places.table, 'Quitirrisí', '|')

/**
 * The code of the División Territorial Administrativa — one digit for the provincia, two for the
 * cantón, two for the distrito — **is also the postal code**: Correos de Costa Rica assigns 10101
 * to the distrito 101 01. So one table generalizes both, and a masked postal code still agrees
 * with the masked distrito beside it.
 */
const codePairs = [
  ...distritoPlaces.filter((d) => d.small).map((d) => [d.code, d.to.code]),
  ...cantonPlaces.filter((c) => c.small).map((c) => [c.code, c.to.code]),
]
cleansing('CR_CODIGO_DTA', 'cr-codigos-generalizados.txt', codePairs, '10707', '|')

const PERSONAL_WORDS = new Set([...GIVEN_NAMES, ...SURNAMES].map((w) => fold(w).toLowerCase()))
const PROVINCE_NAMES = new Set([...PROVINCIAS.map((p) => p.name), 'Costa Rica'].map((n) => fold(n).toLowerCase()))
const placeNames = (list) => unique(list.flatMap(spellingsOf))
  .filter((n) => !PERSONAL_WORDS.has(fold(n).toLowerCase()) && !PROVINCE_NAMES.has(fold(n).toLowerCase()))

domain('CR_L2_DISTRITO', 'CR_DISTRITO',
  byName(['distrito(?!_?(cod|codigo|id|electoral|judicial|escolar|riego))(_?(residencia|nacimiento|domicilio))?|cant[oó]n(?!_?(cod|codigo|id))(_?(residencia|nacimiento|domicilio))?|canton(?!_?(cod|codigo|id))|ciudad(_?(residencia|nacimiento|domicilio|cliente))?|poblado|caser[ií]o|(nom|nombre|desc)_?(distrito|canton|ciudad)|lugar_?(de_?)?nacimiento|city|town', 0.85]),
  byList([['cr-detectar-distritos.txt', placeNames([...DISTRITOS, ...CANTONES]), 0.8]], { reject: 0.4 }))

domain('CR_L2_CODIGO_DTA', 'CR_CODIGO_DTA',
  byName(['(cod|codigo|cd|id)_?(dta|distrito|canton|cant|provincia|ciudad|lugar|geogr[aá]fico)(_?(inec|censo|res|residencia|nac|nacimiento))?|c[oó]digo_?(de_?)?(distrito|canton|divisi[oó]n_?territorial)|coddistrito|codcanton|c[oó]digo_?postal|cod_?postal|codpostal|zip(_?code)?|postal_?code', 0.85]),
  byPattern([[String.raw`[1-7]\d{4}`, 0.4], [String.raw`[1-7]\d{2}`, 0.3]], { reject: 0.3 }))

// The 2025 decree names the barrios of every distrito: 1,276 of them, below the distrito and well
// below the threshold, so a barrio is replaced by another barrio rather than generalized upwards.
lookup('CR_BARRIO', 'cr-barrios.txt', BARRIOS, 'Barrio Escalante', 'PRESERVE_LOOKUP_FILE')
domain('CR_L2_BARRIO', 'CR_BARRIO',
  byName(['barrio(_?(residencia|domicilio|nombre))?|urbanizaci[oó]n|urb|residencial|condominio_?(nombre)?|zona(_?(residencia|domicilio))?|asentamiento|precario|(nom|nombre)_?(barrio|urbanizacion|residencial)|neighbou?rhood', 0.8]))

const MARITAL = ['Soltero/a', 'Casado/a', 'Unión libre o de hecho', 'Separado/a', 'Divorciado/a', 'Viudo/a']
categorical('CR_ESTADO_CIVIL', 'cr-estado-civil.txt', MARITAL, 'Unión de hecho', ['1', '2', '3', '4', '5', '6'])
domain('CR_L2_ESTADO_CIVIL', 'CR_ESTADO_CIVIL',
  byName(['estado_?civil|est_?civil|(cod|tipo|id)_?estado_?civil|situaci[oó]n_?conyugal|uni[oó]n_?(libre|de_?hecho)|marital_?status|civil_?status', 0.85]),
  byList([['cr-detectar-estado-civil.txt', [...MARITAL, 'soltero', 'soltera', 'casado', 'casada', 'unión libre', 'union libre', 'unión de hecho', 'separado', 'separada', 'divorciado', 'divorciada', 'viudo', 'viuda'], 0.7]], { reject: 0.4 }))

lookup('CR_OCUPACION', 'cr-ocupaciones.txt', ['Empleado administrativo', 'Dependiente de tienda', 'Cajero', 'Chofer', 'Mensajero', 'Albañil', 'Maestro de obras', 'Docente', 'Enfermero', 'Médico general', 'Contador', 'Abogado', 'Ingeniero', 'Programador', 'Recepcionista', 'Misceláneo', 'Oficial de seguridad', 'Cocinero', 'Salonero', 'Electricista', 'Fontanero', 'Mecánico', 'Peón agrícola', 'Recolector de café', 'Operario de planta', 'Asesor comercial', 'Teleoperador', 'Bodeguero', 'Estilista', 'Costurera', 'Vendedor ambulante', 'Ama de casa', 'Estudiante', 'Pensionado', 'Taxista', 'Guía de turismo', 'Agente de call center'], 'Gerente de operaciones')
decompose('CR_OCUPACION_O_CODIGO', [
  // Clasificación de Ocupaciones de Costa Rica: four digits.
  [String.raw`(\d{2,5})`, DIGITS],
], apply('CR_OCUPACION'), 'Gerente de operaciones')
domain('CR_L2_OCUPACION', 'CR_OCUPACION_O_CODIGO',
  byName(
    ['ocupaci[oó]n|profesi[oó]n|oficio|cocr|ciuo|(cod|codigo)_?(ocupacion|profesion|cocr|ciuo)|puesto_?(de_?)?trabajo|categor[ií]a_?ocupacional|cargo_?(actual|empleado)|occupation|profession|job_?title', 0.8],
    ['cargo|puesto', 0.5],
  ))

lookup('CR_EMPLEADOR', 'cr-empleadores.txt', ['Distribuidora Central S.A.', 'Constructora del Valle S.A.', 'Transportes La Meseta S.A.', 'Supermercados El Ahorro S.A.', 'Industrias Metálicas Tibás S.A.', 'Clínica Santa Fe S.A.', 'Colegio Nuevo Horizonte', 'Servicios Integrales del Pacífico S.A.', 'Agrícola Tres Ríos S.A.', 'Comercial Los Higuerones S.A.', 'Soluciones Digitales Costa Rica S.A.', 'Restaurante Sabor Tico S.A.', 'Hotel Mirador del Volcán S.A.', 'Laboratorio Vida Sana S.A.', 'Seguridad Vigía S.A.', 'Textiles La Aguja S.A.', 'Repuestos del Este S.A.', 'Farmacia El Buen Vecino', 'Logística Puerto Caldera S.A.', 'Cooperativa Agrícola La Unión R.L.', 'Fundación Manos Unidas', 'Panadería Pan Nuestro', 'Despacho Contable Asociados S.A.', 'Exportadora de Piña del Norte S.A.'], 'Corporación Comercial Centroamericana S.A.', 'PRESERVE_LOOKUP_FILE')
domain('CR_L2_EMPLEADOR', 'CR_EMPLEADOR',
  byName(['empleador(_?(nombre|raz[oó]n_?social|cedula))?|(nombre|nom)_?(empleador|empresa_?donde_?trabaja|patrono)|empresa_?(donde_?)?(trabaja|labora)|lugar_?(de_?)?trabajo|centro_?(de_?)?trabajo|patrono(_?nombre)?|entidad_?empleadora|employer(_?name)?|workplace', 0.9]))

const EDUCATION = ['Sin instrucción', 'Preescolar', 'Primaria incompleta', 'Primaria completa', 'Secundaria incompleta', 'Secundaria completa', 'Educación técnica', 'Parauniversitaria', 'Universitaria incompleta', 'Universitaria completa', 'Posgrado']
categorical('CR_NIVEL_EDUCATIVO', 'cr-nivel-educativo.txt', EDUCATION, 'Educación universitaria en curso', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'])
domain('CR_L2_NIVEL_EDUCATIVO', 'CR_NIVEL_EDUCATIVO',
  byName(['escolaridad|nivel_?(educativo|de_?estudios|acad[eé]mico|alcanzado|de_?instrucci[oó]n)|instrucci[oó]n(_?formal)?|grado_?(de_?)?(estudio|instrucci[oó]n|escolaridad)|m[aá]ximo_?nivel|a[nñ]os_?(de_?)?estudio|education(_?level)?', 0.8]),
  byList([['cr-detectar-nivel-educativo.txt', [...EDUCATION, 'sin instrucción', 'primaria', 'secundaria', 'bachillerato', 'técnico', 'universitaria', 'universidad', 'parauniversitaria', 'posgrado', 'maestría', 'doctorado'], 0.6]], { reject: 0.4 }))

lookup('CR_INSTITUCION_EDUCATIVA', 'cr-instituciones-educativas.txt', ['Escuela Juan Rafael Mora', 'Escuela República de Francia', 'Liceo de Costa Rica', 'Liceo del Sur', 'Colegio Técnico Profesional de Heredia', 'Colegio Científico de Alajuela', 'Universidad de Costa Rica', 'Universidad Nacional', 'Instituto Tecnológico de Costa Rica', 'Universidad Estatal a Distancia', 'Instituto Nacional de Aprendizaje', 'Escuela Unidocente La Esperanza'], 'Universidad de Costa Rica')
domain('CR_L2_INSTITUCION_EDUCATIVA', 'CR_INSTITUCION_EDUCATIVA',
  byName(['instituci[oó]n_?educativa|centro_?(educativo|de_?estudios)|escuela|colegio|liceo|instituto|universidad|ina|(nombre|nom)_?(escuela|colegio|liceo|universidad|institucion_?educativa)|c[oó]digo_?(de_?)?(escuela|colegio|centro)|school(_?name)?|university', 0.75]))

// Capped at 5 as text: large households are rare, and a rare count identifies.
decompose('CR_CONTEO_LIMITADO', [[String.raw`([0-5])`, keep], [String.raw`(\d+)`, redactAs('5')]], keep, '9')
domain('CR_L2_PERSONAS_A_CARGO', 'CR_CONTEO_LIMITADO',
  byName(['personas_?a_?cargo|n(o|ro|um|umero)_?(de_?)?(hijos|dependientes|personas_?a_?cargo|beneficiarios)|cant(idad)?_?(hijos|dependientes|personas_?hogar|integrantes|miembros)|hijos|dependientes|integrantes_?(del_?)?hogar|personas_?(en_?el_?)?hogar|tama[nñ]o_?(del_?)?hogar|number_?of_?children|dependents', 0.8]),
  byType(NUMBER(0, 4), STRING(0, 4)))


// ── L3 · Sensitive data (art. 3 e and art. 9.1) ─────────────────────────────
//
// Article 3 e) defines a sensitive datum as "información relativa al **fuero íntimo** de la
// persona, como por ejemplo los que revelen origen racial, opiniones políticas, convicciones
// religiosas o espirituales, **condición socioeconómica**, información **biomédica o genética**,
// vida y orientación sexual, **entre otros**" — an open list, and the only one in the region that
// names the socio-economic condition, which this set keeps in the FIN group below.
//
// Article 9.1 turns the definition into a prohibition: "Se **prohíbe** el tratamiento de datos de
// carácter personal que revelen el origen racial o étnico, opiniones políticas, convicciones
// religiosas, espirituales o filosóficas, así como los relativos a la salud, la vida y la
// orientación sexual, entre otros", with five narrow exceptions, and article 31 a) makes it a
// **falta gravísima** — fifteen to thirty base salaries and the suspension of the fichero for up
// to six months — for a private party to process them at all. A development or test copy that
// carries these columns in the clear is the plainest case of that falta.
//
// Article 4, second paragraph, adds the reason the attributes the list does not name are here too:
// informational self-determination exists "evitando que se propicien **acciones
// discriminatorias**".

// The census asks for self-identification and lets a person answer more than one.
const ETHNICITY = ['Indígena', 'Afrodescendiente o negra', 'Mulata', 'China', 'Blanca o mestiza', 'Otra', 'Ninguna']
categorical('CR_ETNIA', 'cr-etnias.txt', ETHNICITY, 'Afrodescendiente', ['1', '2', '3', '4', '5', '6', '7'])
domain('CR_L3_ETNIA', 'CR_ETNIA',
  byName(['etnia|origen_?([eé]tnico|racial)|grupo_?[eé]tnico|pertenencia_?[eé]tnica|autoidentificaci[oó]n(_?[eé]tnica)?|autodefinici[oó]n|(cod|codigo|tipo|id)_?etnia|raza|afrodescendiente|afrocostarricense|ind[ií]gena|ethnicity|race', 0.95]),
  byList([['cr-detectar-etnias.txt', [...ETHNICITY, 'indígena', 'afrodescendiente', 'negra', 'negro', 'mulata', 'mulato', 'china', 'chino', 'blanca', 'mestiza', 'mestizo', 'otra', 'ninguna'], 0.9],
    ['cr-detectar-codigos-banderas.txt', ['s', 'n', 'sí', 'no', '1', '2', '3', '4', '5', '6', '7'], 0.3],
  ], { reject: 0.4 }))

// Eight indigenous peoples and 24 territorios indígenas: naming the people or the territory names
// a few thousand people, and the territory names a few hundred.
const PUEBLOS = ['Bribri', 'Cabécar', 'Maleku', 'Chorotega', 'Huetar', 'Brunca o boruca', 'Ngäbe', 'Buglé', 'Teribe o térraba', 'Otro pueblo', 'No pertenece a ningún pueblo']
categorical('CR_PUEBLO', 'cr-pueblos.txt', PUEBLOS, 'Pueblo indígena')
domain('CR_L3_PUEBLO_INDIGENA', 'CR_PUEBLO',
  byName(['pueblo_?(ind[ií]gena|originario)|territorio_?ind[ií]gena|comunidad_?ind[ií]gena|adi_?ind[ií]gena|lengua_?(ind[ií]gena|materna)|idioma_?ind[ií]gena|bribri|cab[eé]car|ngäbe|ngabe|maleku|chorotega|huetar|br[uú]nca|boruca|teribe|t[eé]rraba|indigenous_?people', 0.9]),
  byList([['cr-detectar-pueblos.txt', [...PUEBLOS, 'bribri', 'cabécar', 'cabecar', 'maleku', 'guatuso', 'chorotega', 'huetar', 'brunca', 'boruca', 'ngäbe', 'ngabe', 'guaymí', 'buglé', 'teribe', 'térraba', 'bröran', 'talamanca', 'salitre', 'china kichá', 'quitirrisí', 'matambú', 'zapatón', 'ujarrás', 'cabagra', 'rey curré', 'altos de san antonio'], 0.85]], { reject: 0.4 }))

// The law does not name nationality, but it sits beside the racial and ethnic origin it does name,
// and in Costa Rica it separates the nationals from the Nicaraguan community — the attribute on
// which the "acciones discriminatorias" of article 4 most often turn. The migratory condition goes
// with it: the Dirección General de Migración records it, and it is as revealing as the passport.
const COUNTRIES = ['Costarricense', 'Nicaragüense', 'Panameña', 'Colombiana', 'Venezolana', 'Salvadoreña', 'Hondureña', 'Guatemalteca', 'Cubana', 'Mexicana', 'Estadounidense', 'Española', 'Italiana', 'China']
lookup('CR_NACIONALIDAD', 'cr-nacionalidades.txt', COUNTRIES, 'Peruana')
domain('CR_L3_NACIONALIDAD', 'CR_NACIONALIDAD',
  byName(['nacionalidad|pa[ií]s_?(de_?)?(nacimiento|origen|nacionalidad|procedencia)|ciudadan[ií]a|nationality|citizenship|country_?of_?birth', 0.85]),
  byList([['cr-detectar-nacionalidades.txt', [...COUNTRIES, 'costarricense', 'tico', 'tica', 'nicaragüense', 'nicaraguense', 'nica', 'panameño', 'colombiano', 'venezolano', 'salvadoreño', 'hondureño', 'guatemalteco', 'cubano', 'mexicano', 'estadounidense', 'español', 'costa rica', 'nicaragua', 'panamá', 'colombia', 'venezuela', 'extranjero', 'extranjera'], 0.7]], { reject: 0.4 }))

const MIGRATION = ['Residente permanente', 'Residente temporal', 'Categoría especial', 'Persona refugiada', 'Solicitante de refugio', 'Permiso de trabajo', 'Estancia transitoria', 'Condición irregular', 'No aplica']
categorical('CR_CONDICION_MIGRATORIA', 'cr-condicion-migratoria.txt', MIGRATION, 'Residencia en trámite')
domain('CR_L3_CONDICION_MIGRATORIA', 'CR_CONDICION_MIGRATORIA',
  byName(['condici[oó]n_?migratoria|estatus_?migratorio|categor[ií]a_?migratoria|situaci[oó]n_?migratoria|tipo_?(de_?)?residencia|residencia_?(permanente|temporal|categoria)|permiso_?(de_?)?(trabajo|residencia|laboral)|refugiad[oa]|solicitante_?(de_?)?refugio|asilo|apatrida|visa(_?(n(o|ro|um|umero)|tipo|categoria))?|migration_?status|immigration_?status', 0.9]),
  byList([['cr-detectar-condicion-migratoria.txt', [...MIGRATION, 'residente', 'permanente', 'temporal', 'refugiado', 'refugiada', 'asilo', 'irregular', 'indocumentado', 'especial', 'transitoria'], 0.7]], { reject: 0.4 }))

const RELIGIONS = ['Católica', 'Evangélica o protestante', 'Testigo de Jehová', 'Adventista del Séptimo Día', 'Iglesia de Jesucristo de los Santos de los Últimos Días', 'Judía', 'Musulmana', 'Budista', 'Otra', 'Sin religión']
categorical('CR_RELIGION', 'cr-religiones.txt', RELIGIONS, 'Ortodoxa')
domain('CR_L3_RELIGION', 'CR_RELIGION',
  byName(['religi[oó]n|creencia_?(religiosa|espiritual)|convicci[oó]n(es)?_?(religiosa|espiritual)|credo|confesi[oó]n_?religiosa|culto|iglesia(_?(a_?la_?que_?pertenece|nombre))?|denominaci[oó]n_?religiosa|(cod|codigo|tipo)_?religion|religion|church', 0.95]),
  byList([['cr-detectar-religiones.txt', [...RELIGIONS, 'católico', 'catolico', 'católica', 'cristiano', 'cristiana', 'evangélico', 'evangélica', 'protestante', 'pentecostal', 'bautista', 'testigo de jehová', 'adventista', 'mormón', 'judío', 'musulmán', 'budista', 'ateo', 'agnóstico', 'ninguna', 'sin religión'], 0.9]], { reject: 0.4 }))

// Article 9.1 names the **convicciones filosóficas** that article 3 e) leaves out, and article 9.1
// b) lets a foundation or association of a political, philosophical, religious or **sindical**
// purpose keep the data of its own members — which is the database this domain protects elsewhere.
domain('CR_L3_CONVICCION_FILOSOFICA', 'CR_CATEGORIA_SUPRIMIDA',
  byName(['convicci[oó]n(es)?_?(filos[oó]ficas?|morales?|personales?|[eé]ticas?)|creencias?_?(filos[oó]ficas?|morales?|personales?)|objeci[oó]n_?(de_?)?conciencia|objetor_?(de_?)?conciencia|masoner[ií]a|logia|beliefs?|philosophical_?beliefs?', 0.9]))

const IDEOLOGIES = ['Izquierda', 'Centroizquierda', 'Centro', 'Centroderecha', 'Derecha', 'Independiente', 'Prefiere no responder']
categorical('CR_PREFERENCIA_POLITICA', 'cr-preferencias-politicas.txt', IDEOLOGIES, 'Oficialista')
domain('CR_L3_OPINION_POLITICA', 'CR_PREFERENCIA_POLITICA',
  byName(['opini[oó]n_?pol[ií]tica|preferencias?_?(pol[ií]tica|partidaria|electoral)|ideolog[ií]a(_?pol[ií]tica)?|orientaci[oó]n_?pol[ií]tica|tendencia_?pol[ií]tica|intenci[oó]n_?(de_?)?voto|simpat[ií]a_?pol[ií]tica|political_?(opinion|orientation|view|preference)|voting_?intention', 0.95]),
  byList([['cr-detectar-preferencias-politicas.txt', [...IDEOLOGIES, 'izquierda', 'derecha', 'centro', 'progresista', 'conservador', 'independiente', 'indeciso', 'voto en blanco', 'ninguno'], 0.7]], { reject: 0.4 }))

// The parties on the register of the Tribunal Supremo de Elecciones. Membership is a public record
// there and a sensitive datum here: the adhesión partidaria reveals the opinión política.
const PARTIES = ['Liberación Nacional', 'Unidad Social Cristiana', 'Progreso Social Democrático', 'Nueva República', 'Frente Amplio', 'Liberal Progresista', 'Unidos Podemos', 'Acción Ciudadana', 'Pueblo Soberano', 'Integración Nacional', 'Esperanza Nacional', 'Avanza', 'Sin afiliación']
categorical('CR_PARTIDO', 'cr-partidos.txt', PARTIES, 'Partido Republicano Social Cristiano')
domain('CR_L3_AFILIACION_PARTIDARIA', 'CR_PARTIDO',
  byName(['partido(_?pol[ií]tico)?(_?(afiliaci[oó]n|nombre))?|adhesi[oó]n_?(partidaria|al_?partido)|afiliaci[oó]n_?(pol[ií]tica|partidaria|partido)|militancia(_?pol[ií]tica)?|militante|(cod|codigo|nombre|nom)_?partido|divisa_?pol[ií]tica|political_?party|party_?membership', 0.95]),
  byList([['cr-detectar-partidos.txt', [...PARTIES, 'PLN', 'PUSC', 'PAC', 'PPSD', 'PNR', 'PLP', 'PIN', 'Frente Amplio', 'Liberación Nacional', 'Unidad Social Cristiana'], 0.8]], { reject: 0.4 }))

domain('CR_L3_AFILIACION_SINDICAL', 'CR_CATEGORIA_SUPRIMIDA',
  byName(['sindicato(_?(nombre|afiliado|afiliaci[oó]n|codigo))?|sindicalizado|afiliado_?sindicato|afiliaci[oó]n_?sindical|cuota_?sindical|rebajo_?sindical|aporte_?sindical|asociaci[oó]n_?(sindical|solidarista|de_?empleados)|solidarismo|gremio|fuero_?sindical|dirigente_?sindical|trade_?union|union_?member(ship)?', 0.95]),
  byList([['cr-detectar-sindicatos.txt', ['ANEP', 'APSE', 'SEC', 'ANDE', 'UNDECA', 'SINAE', 'SITRAPEQUIA', 'SINTRAJAP', 'SITECO', 'CTRN', 'CMTC', 'Rerum Novarum', 'asociación solidarista', 'gremio', 'sindicalizado', 'afiliado'], 0.6]], { reject: 0.3 }))

// "Información biomédica o genética" — article 3 e) names both, and no exception of article 9.1
// covers a biometric template kept for convenience.
domain('CR_L3_BIOMETRICO', 'CR_REDACTAR',
  byName(['biometr[ií]a[a-z_]*|biom[eé]trico[a-z_]*|huella(_?(dactilar|digital))?(_?(template|plantilla|imagen|hash))?|huellas|dactilar|dactilosc[oó]pic[oa]|template_?(facial|huella|biometrico)|plantilla_?(facial|biom[eé]trica)|rostro_?(hash|template)|reconocimiento_?(facial|de_?voz)|firma_?(biom[eé]trica|digitalizada)|iris|voz_?(biom[eé]trica|template)|fingerprints?|face_?(template|hash|encoding)|biometric[a-z_]*', 0.9]),
  byType(STRING()))

domain('CR_L3_GENETICO', 'CR_REDACTAR',
  byName(['adn|dna|gen[eé]tic[oa]s?|datos?_?gen[eé]ticos?|genoma|genotip[a-z_]*|prueba_?(gen[eé]tica|de_?adn|de_?paternidad|de_?filiaci[oó]n)|perfil_?gen[eé]tico|mutaci[oó]n|brca[12]?|cariotipo|tamizaje_?neonatal|genetic[a-z_]*', 0.9]))

const ORIENTATIONS = ['Heterosexual', 'Gay', 'Lesbiana', 'Bisexual', 'Pansexual', 'Asexual', 'Otra', 'Prefiere no responder']
categorical('CR_ORIENTACION_SEXUAL', 'cr-orientaciones-sexuales.txt', ORIENTATIONS, 'Homosexual')
domain('CR_L3_ORIENTACION_SEXUAL', 'CR_ORIENTACION_SEXUAL',
  byName(['orientaci[oó]n_?sexual|preferencias?_?sexuales?|(cod|codigo|tipo)_?orientacion_?sexual|sexual_?orientation', 0.95]),
  byList([['cr-detectar-orientaciones-sexuales.txt', [...ORIENTATIONS, 'hetero', 'homosexual', 'lgbti', 'lgbtiq+', 'queer', 'diversidad sexual'], 0.8]], { reject: 0.4 }))

// "Vida y orientación sexual" — article 3 e) names the life as well as the orientation.
domain('CR_L3_VIDA_SEXUAL', 'CR_CATEGORIA_SUPRIMIDA',
  byName(['vida_?sexual|actividad_?sexual|conducta_?sexual|pr[aá]cticas?_?sexuales?|parejas?_?sexuales?|n(o|ro|um|umero)_?parejas|sexualmente_?activ[oa]|inicio_?(de_?)?(la_?)?vida_?sexual|relaciones_?sexuales|sex(ual)?_?life|sexual_?(activity|behavio(u)?r|partners)', 0.9]))

// The 2018 Sala Constitucional ruling and the TSE's 2018 directive let a person change the name and
// the sex marker of the cédula, so gender identity is a column in Costa Rican systems — and one of
// the attributes the anti-discrimination clause of article 4 is written for.
const IDENTITIES = ['Mujer cisgénero', 'Hombre cisgénero', 'Mujer trans', 'Hombre trans', 'Persona no binaria', 'Otra', 'Prefiere no responder']
categorical('CR_IDENTIDAD_GENERO', 'cr-identidades-genero.txt', IDENTITIES, 'Transgénero')
domain('CR_L3_IDENTIDAD_GENERO', 'CR_IDENTIDAD_GENERO',
  byName(['identidad_?(de_?)?g[eé]nero|(cod|codigo|tipo)_?identidad_?genero|g[eé]nero_?(autopercibido|identitario)|expresi[oó]n_?de_?g[eé]nero|transg[eé]nero|persona_?trans|nombre_?social|pronombres?|gender_?identity', 0.95]),
  byList([['cr-detectar-identidades-genero.txt', [...IDENTITIES, 'cisgénero', 'cis', 'transgénero', 'trans', 'no binario', 'no binaria', 'mujer', 'hombre'], 0.7]], { reject: 0.4 }))

// The Ley 8589 de penalización de la violencia contra las mujeres and the Ley 9095 against the
// trafficking of persons both protect the identity of the victim; article 4 reaches the data whose
// improper use discriminates.
domain('CR_L3_VICTIMA', 'CR_CATEGORIA_SUPRIMIDA',
  byName(['v[ií]ctima(_?(de_?)?(violencia(_?(de_?g[eé]nero|dom[eé]stica|intrafamiliar|sexual|psicol[oó]gica|patrimonial))?|delito|trata|abuso|desaparici[oó]n))?|violencia_?(de_?)?g[eé]nero|violencia_?(dom[eé]stica|intrafamiliar|sexual|psicol[oó]gica)|tipo_?(de_?)?violencia|medida_?(de_?)?protecci[oó]n|boleta_?(de_?)?violencia|trata_?(de_?)?personas|denunciante_?violencia|pani_?(caso|expediente)', 0.9]))


// ── SALUD · Health data (art. 9.1 and its exception d) ──────────────────────
//
// Article 9.1 prohibits the processing of the data "relativos a la salud", and its exception d)
// draws the only door: the treatment is allowed when it is necessary for prevention, medical
// diagnosis, health care or the management of health services, and then only by a health worker
// bound to professional secrecy "o por otra persona sujeta, asimismo, a una obligación equivalente
// de secreto". A test environment is nobody's health care, and the analyst who restores the dump
// is under no such obligation — so these columns do not belong there in the clear. Article 2 c) of
// the Ley 8239 de derechos de las personas usuarias de los servicios de salud guarantees the
// confidentiality of the expediente, and the CCSS keeps the whole country's expediente in the EDUS.

domain('CR_SALUD_IDENTIFICADOR', 'CR_CM_ALFANUM',
  byName(
    ['n(o|ro|um|umero)_?(expediente_?(cl[ií]nico|de_?salud|m[eé]dico)|hc|ficha(_?cl[ií]nica)?|episodio|ingreso|atenci[oó]n|consulta|cita|receta)|expediente_?(cl[ií]nico|digital|[uú]nico|m[eé]dico|salud)|edus[a-z0-9_]*|arca|sics|id_?paciente|c[oó]digo_?(paciente|expediente|atenci[oó]n)', 0.85],
    ['expediente|atenci[oó]n|ingreso|consulta|episodio', 0.55],
  ))

const COVERAGE = ['Asegurado directo asalariado', 'Asegurado directo cuenta propia', 'Asegurado voluntario', 'Asegurado por el Estado', 'Pensionado (IVM)', 'Pensionado (RNC)', 'Familiar asegurado', 'Convenio especial', 'Seguro privado', 'No asegurado']
decompose('CR_COBERTURA_SALUD', [
  [FLAG, apply('CR_BANDERA')],
  [String.raw`(\d{1,8})`, DIGITS],
], apply(lookup('CR_COBERTURA', 'cr-cobertura-salud.txt', COVERAGE, undefined, 'PRESERVE_LOOKUP_FILE')), 'Asegurado por el Estado')
domain('CR_SALUD_COBERTURA', 'CR_COBERTURA_SALUD',
  byName(['cobertura(_?(m[eé]dica|de_?salud|asistencial))?|seguro_?(m[eé]dico|salud|sem)|r[eé]gimen(_?(de_?)?(aseguramiento|salud|pensiones|ivm|rnc))?|tipo_?(de_?)?(seguro|cobertura|asegurado)|modalidad_?(de_?)?aseguramiento|ccss_?(regimen|cobertura)|aseguradora_?(m[eé]dica|salud)|plan_?(m[eé]dico|de_?salud)|ins_?(poliza|seguro)', 0.85]),
  byList([['cr-detectar-cobertura.txt', [...COVERAGE, 'asalariado', 'cuenta propia', 'voluntario', 'por el estado', 'pensionado', 'familiar', 'ivm', 'rnc', 'sem', 'no asegurado', 'privado'], 0.8]], { reject: 0.4 }))

const ICD10 = ['I10', 'E11', 'E78', 'J45', 'J06', 'J02', 'J20', 'K29', 'K21', 'K59', 'M54', 'M17', 'M25', 'N39', 'N20', 'R51', 'R10', 'H10', 'H66', 'L23', 'L30', 'B34', 'A09', 'E03', 'E66', 'D50', 'I83', 'K80', 'K40', 'S93', 'S60', 'Z00', 'J30', 'J32', 'G43', 'M79', 'R05', 'A90']
const ICD10_DECIMAL = ['E11.9', 'E78.5', 'J45.9', 'J06.9', 'J02.9', 'J20.9', 'K29.7', 'K21.9', 'K59.0', 'M54.5', 'M17.9', 'N39.0', 'N20.0', 'R10.4', 'H10.9', 'H66.9', 'L23.9', 'L30.9', 'B34.9', 'A09.9', 'E03.9', 'E66.9', 'D50.9', 'I83.9', 'K80.2', 'K40.9', 'S93.4', 'S60.0', 'Z00.0', 'J30.4', 'J32.9', 'G43.9', 'M79.1', 'A90.0']
decompose('CR_DIAGNOSTICO', [
  [String.raw`([A-TV-Za-tv-z]\d{2}\.\d{1,2})`, apply(lookup('CR_CIE10_DECIMAL', 'cr-cie10-decimal.txt', ICD10_DECIMAL, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [String.raw`([A-TV-Za-tv-z]\d{2,3}X?)`, apply(lookup('CR_CIE10', 'cr-cie10.txt', ICD10, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [FLAG, apply('CR_BANDERA')],
], apply(lookup('CR_DIAGNOSTICO_TEXTO', 'cr-diagnosticos.txt', ['Hipertensión arterial', 'Diabetes mellitus tipo 2', 'Asma', 'Lumbalgia', 'Gastritis crónica', 'Faringitis aguda', 'Infección urinaria', 'Migraña', 'Hipotiroidismo', 'Dislipidemia', 'Obesidad', 'Artrosis de rodilla', 'Bronquitis aguda', 'Amigdalitis aguda', 'Dermatitis de contacto', 'Otitis media aguda', 'Esguince de tobillo', 'Conjuntivitis', 'Anemia por deficiencia de hierro', 'Reflujo gastroesofágico', 'Síndrome de intestino irritable', 'Tendinitis', 'Sinusitis aguda', 'Cefalea tensional', 'Várices', 'Hernia inguinal', 'Litiasis renal', 'Colelitiasis', 'Diarrea aguda', 'Dengue sin signos de alarma', 'Control de salud'])), 'F33.1')
domain('CR_SALUD_DIAGNOSTICO', 'CR_DIAGNOSTICO',
  byName(['diagn[oó]stico[a-z_]*|dx(_?(principal|secundario|ingreso|egreso)[0-9]?)?|cie_?10|cie(_?(10|11|principal))?|(cod|codigo)_?(diagnostico|dx|cie)|impresi[oó]n_?diagn[oó]stica|enfermedad(es)?[a-z_]*|patolog[ií]a|comorbilidad(es)?|antecedentes?_?(m[eé]dicos|patol[oó]gicos|cl[ií]nicos|personales)|causa_?(de_?)?(muerte|defunci[oó]n|incapacidad|internamiento|consulta)|motivo_?(de_?)?(consulta|incapacidad|internamiento)|alergias?|diagnos(is|es)|icd_?(10|11)?', 0.85]),
  byPattern([[String.raw`[A-TV-Za-tv-z]\d{2}(\.\d{1,2}|\d|X)?`, 0.5]], { reject: 0.3 }))

decompose('CR_PROCEDIMIENTO', [[String.raw`(\d{4,6})`, DIGITS]], apply(lookup('CR_PROCEDIMIENTO_TEXTO', 'cr-procedimientos.txt', ['Consulta de medicina general', 'Consulta de urgencias', 'Hemograma completo', 'Glicemia en ayunas', 'Examen general de orina', 'Creatinina sérica', 'Radiografía de tórax', 'Ultrasonido abdominal', 'Electrocardiograma', 'Control prenatal'])), 'Prueba de carga viral para VIH')
domain('CR_SALUD_PROCEDIMIENTO', 'CR_PROCEDIMIENTO',
  byName(['procedimiento(_?(m[eé]dico|quir[uú]rgico|realizado|autorizado))?|(cod|codigo)_?(procedimiento|prestaci[oó]n|servicio_?salud)|prestaci[oó]n_?(m[eé]dica|de_?salud)|examen_?(ordenado|realizado)|cirug[ií]a(_?realizada)?|intervenci[oó]n_?quir[uú]rgica|t[eé]cnica_?(diagn[oó]stica|quir[uú]rgica)|medical_?procedure', 0.85]))

const MEDICATIONS = ['Acetaminofén', 'Ibuprofeno', 'Diclofenaco', 'Metformina', 'Glibenclamida', 'Losartán', 'Enalapril', 'Amlodipino', 'Atorvastatina', 'Omeprazol', 'Levotiroxina', 'Amoxicilina', 'Cefalexina', 'Salbutamol', 'Loratadina', 'Hidroclorotiazida', 'Ácido acetilsalicílico', 'Prednisona', 'Azitromicina', 'Sulfato ferroso', 'Ácido fólico', 'Complejo B']
categorical('CR_MEDICAMENTO', 'cr-medicamentos.txt', MEDICATIONS, 'Sertralina 50 mg')
domain('CR_SALUD_MEDICAMENTO', 'CR_MEDICAMENTO',
  byName(['medicamentos?(_?(recetado|prescrito|entregado|despachado|nombre|uso))?|f[aá]rmacos?|principio_?activo|denominaci[oó]n_?com[uú]n_?internacional|dci|receta(_?m[eé]dica)?|prescripci[oó]n(_?medicamento)?|posolog[ií]a|tratamiento_?farmacol[oó]gico|(cod|codigo)_?medicamento|lista_?oficial_?de_?medicamentos|lom|medications?|drugs?_?prescribed', 0.85]),
  byList([['cr-detectar-medicamentos.txt', [...MEDICATIONS, 'acetaminofén', 'sertralina', 'fluoxetina', 'escitalopram', 'quetiapina', 'clonazepam', 'alprazolam', 'lorazepam', 'litio', 'metilfenidato', 'risperidona', 'olanzapina', 'haloperidol', 'tenofovir', 'emtricitabina', 'dolutegravir', 'efavirenz', 'insulina', 'warfarina', 'levetiracetam', 'ácido valproico', 'misoprostol', 'levonorgestrel', 'anticonceptivo'], 0.7]], { reject: 0.3 }))

domain('CR_SALUD_TEXTO_CLINICO', 'CR_TEXTO_LIBRE',
  byName(['anamnesis|evoluci[oó]n(_?(m[eé]dica|cl[ií]nica|enfermer[ií]a))?|enfermedad_?actual|examen_?f[ií]sico|plan_?(de_?)?(manejo|tratamiento)|indicaciones_?m[eé]dicas|conducta(_?m[eé]dica)?|epicrisis|resumen_?(de_?)?(alta|egreso|atenci[oó]n)|nota_?(m[eé]dica|de_?enfermer[ií]a|cl[ií]nica)|notas?_?(m[eé]dicas|cl[ií]nicas)|triaje(_?texto)?|informe_?(patolog[ií]a|radiolog[ií]a|m[eé]dico)|clinical_?notes?|discharge_?summary', 0.85]),
  byType(STRING(30)))

domain('CR_SALUD_RESULTADO_EXAMEN', 'CR_CM_ALFANUM',
  byName(
    ['resultado_?(del_?)?(examen|prueba|an[aá]lisis|laboratorio|pcr|serolog[ií]a|biopsia|glicemia|citolog[ií]a|papanicolaou|vdrl)|(examen|prueba|an[aá]lisis)_?(resultado|laboratorio)|glicemia|hemoglobina(_?glicosilada)?|hba1c|colesterol|imc|presi[oó]n_?arterial|test_?(de_?)?embarazo|espirometr[ií]a|alcoholemia|lab_?results?|test_?results?', 0.8],
    ['resultado|prueba|analisis', 0.5],
  ))

// The Ley 7771 General sobre VIH-SIDA makes the condition confidential and its disclosure an
// offence; the health data of article 9.1 covers the rest.
domain('CR_SALUD_VIH', 'CR_CATEGORIA_SUPRIMIDA',
  byName(['vih(_?(estado|resultado|prueba|diagn[oó]stico|positivo))?|hiv|sida|aids|serolog[ií]a_?(vih|hiv)|estado_?serol[oó]gico|carga_?viral|cd4|tar|antirretroviral(es)?|its|ets|infecci[oó]n(es)?_?(de_?)?transmisi[oó]n_?sexual|s[ií]filis|hepatitis_?[bc]|tuberculosis|tbc', 0.9]))

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']
lookup('CR_GRUPO_SANGUINEO', 'cr-grupos-sanguineos.txt', BLOOD_GROUPS, 'O+', 'PRESERVE_LOOKUP_FILE')
domain('CR_SALUD_GRUPO_SANGUINEO', 'CR_GRUPO_SANGUINEO',
  byName(['grupo_?sangu[ií]neo|tipo_?(de_?)?sangre|rh|factor_?rh|gs_?rh|grupo_?rh|abo(_?rh)?|blood_?(type|group)', 0.9]),
  byList([['cr-detectar-grupos-sanguineos.txt', [...BLOOD_GROUPS, '0+', '0-', 'a positivo', 'a negativo', 'b positivo', 'b negativo', 'ab positivo', 'ab negativo', 'o positivo', 'o negativo'], 0.9]], { reject: 0.4 }))

// The Ley 7600 de igualdad de oportunidades and the Ley 9379 that created CONAPDIS both build
// registers of persons with a disability, and the certificate is a health datum.
const DISABILITIES = ['Física o motora', 'Auditiva', 'Visual', 'Intelectual', 'Psicosocial', 'Múltiple', 'Ninguna']
categorical('CR_DISCAPACIDAD', 'cr-discapacidades.txt', DISABILITIES, 'Trastorno del espectro autista')
domain('CR_SALUD_DISCAPACIDAD', 'CR_DISCAPACIDAD',
  byName(['discapacidad[a-z_]*|(tipo|cod|codigo|categoria|porcentaje|grado)_?discapacidad|persona_?con_?discapacidad|pcd|certificado_?(de_?)?discapacidad|conapdis|condici[oó]n_?(de_?)?discapacidad|necesidades_?(educativas_?)?especiales|movilidad_?reducida|ley_?7600|disabilit(y|ies)', 0.9]),
  byList([['cr-detectar-discapacidades.txt', [...DISABILITIES, 'física', 'motora', 'auditiva', 'sordera', 'visual', 'ceguera', 'intelectual', 'psicosocial', 'mental', 'múltiple', 'autismo', 'ninguna', 'no aplica'], 0.6]], { reject: 0.3 }))

categorical('CR_APTITUD_LABORAL', 'cr-aptitud-laboral.txt', ['Apto', 'Apto con restricciones', 'No apto', 'Pendiente'], 'No apto temporalmente')
domain('CR_SALUD_OCUPACIONAL', 'CR_APTITUD_LABORAL',
  byName(['aptitud_?(laboral|m[eé]dica)|certificado_?(de_?)?aptitud|examen_?(m[eé]dico_?)?(ocupacional|preocupacional|de_?ingreso|de_?egreso|peri[oó]dico)|accidente_?(de_?)?trabajo|riesgos?_?(del_?)?trabajo|enfermedad_?(laboral|profesional|ocupacional)|incapacidad(_?(m[eé]dica|laboral|d[ií]as))?|boleta_?(de_?)?incapacidad|d[ií]as_?(de_?)?incapacidad|licencia_?(m[eé]dica|por_?maternidad)|ausentismo', 0.85]),
  byList([['cr-detectar-aptitud-laboral.txt', ['apto', 'no apto', 'apto con restricciones', 'pendiente', 'apto con recomendaciones'], 0.6]], { reject: 0.3 }))

domain('CR_SALUD_REPRODUCTIVA', 'CR_CATEGORIA_SUPRIMIDA',
  byName(['embarazo|embarazada|gestante|gestaci[oó]n|edad_?gestacional|semanas_?(de_?)?gestaci[oó]n|fum|fecha_?[uú]ltima_?(regla|menstruaci[oó]n)|control_?(prenatal|obst[eé]trico)|prenatal|parto(_?tipo)?|ces[aá]rea|interrupci[oó]n_?(del_?)?embarazo|aborto|m[eé]todo_?(de_?)?anticoncepci[oó]n|planificaci[oó]n_?familiar|anticoncepci[oó]n|anticonceptivo|fertilidad|fecundaci[oó]n_?in_?vitro|salud_?(sexual|reproductiva)|pregnan(t|cy)|contracepti(on|ve)', 0.9]))

domain('CR_SALUD_MENTAL', 'CR_CATEGORIA_SUPRIMIDA',
  byName(['salud_?mental|trastorno[a-z_]*|psiqui[aá]tri[a-z_]*|psicol[oó]gi[a-z_]*|depresi[oó]n|ansiedad|suicid[a-z_]*|intento_?(de_?)?suicidio|autolesi[oó]n|consumo_?(de_?)?(sustancias|alcohol|drogas)|adicci[oó]n(es)?|alcoholismo|tabaquismo|iafa|mental_?health', 0.9]))

// ── FIN · Economic data (art. 3 e, art. 1 and art. 9.4) ─────────────────────
//
// Costa Rica is the only country in the region whose law names the **condición socioeconómica**
// among the sensitive data of article 3 e), beside the racial origin and the religious convictions.
// Article 1 states the law's reach over the data of a person "o **bienes**", and article 12 of the
// regulation repeats it — the assets as well as the person. Article 9.4 sends the data on credit
// behaviour to the rules of the Sistema Financiero Nacional, where the SUGEF keeps the Centro de
// Información Crediticia, "sin impedir el pleno ejercicio del derecho a la autodeterminación
// informativa ni exceder los límites de esta ley".

decompose('CR_HISTORIAL_CREDITICIO', [
  [String.raw`(?i)([A-E][12]?)`, apply(lookup('CR_CATEGORIA_SUGEF', 'cr-categorias-sugef.txt', ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D', 'E'], undefined, 'PRESERVE_LOOKUP_FILE'))],
  [String.raw`(\d{1,4})`, DIGITS],
  [FLAG, apply('CR_BANDERA')],
], apply(lookup('CR_ESTADO_CREDITO', 'cr-estados-credito.txt', ['Categoría A1 — riesgo normal', 'Categoría A2 — riesgo normal', 'Categoría B1 — riesgo bajo', 'Categoría B2 — riesgo bajo', 'Categoría C1 — riesgo medio', 'Categoría C2 — riesgo medio', 'Categoría D — riesgo alto', 'Categoría E — irrecuperable', 'Al día', 'En cobro administrativo', 'En cobro judicial', 'Readecuado', 'Sin historial crediticio'])), 'En cobro judicial')
domain('CR_FIN_HISTORIAL_CREDITICIO', 'CR_HISTORIAL_CREDITICIO',
  byName(['historial_?(crediticio|de_?cr[eé]dito)|cic(_?sugef)?|centro_?(de_?)?informaci[oó]n_?crediticia|sugef(_?(categoria|calificacion))?|central_?(de_?)?riesgos?|bur[oó]_?(de_?)?cr[eé]dito|protectora_?(de_?)?cr[eé]dito|score(_?(crediticio|interno))?|puntaje_?(de_?)?cr[eé]dito|calificaci[oó]n_?(de_?)?(riesgo|cr[eé]dito|cartera|deudor)|categor[ií]a_?(sugef|de_?riesgo)|d[ií]as_?(de_?)?(mora|atraso)|estado_?(de_?)?(cr[eé]dito|cartera|obligaci[oó]n)|morosidad|moroso|cobro_?judicial|credit_?score|credit_?rating', 0.9]))

// Costa Rica uses the colón; the monthly minimum wage for an unskilled worker was around 380,000
// colones in 2026.
algorithm('CR_VALOR_DEUDA', 'characterMapping.NumericMapping', { minValue: 50000, maxValue: 60000000 }, '2400000')
domain('CR_FIN_DEUDA', 'CR_VALOR_DEUDA',
  byName(['saldo_?(deuda|cr[eé]dito|capital|obligaci[oó]n|cartera|en_?mora|adeudado)|monto_?(de_?la_?)?(deuda|cuota|obligaci[oó]n|cr[eé]dito|pr[eé]stamo|mora|otorgado)|deuda(_?total)?|l[ií]mite_?(de_?)?(cr[eé]dito|tarjeta)|l[ií]nea_?(de_?)?cr[eé]dito|cuota_?mensual|loan_?(amount|balance)|outstanding_?balance|debt', 0.85]),
  byType(NUMBER()))

algorithm('CR_INGRESOS', 'characterMapping.NumericMapping', { minValue: 360000, maxValue: 6000000 }, '780000')
domain('CR_FIN_INGRESOS', 'CR_INGRESOS',
  byName(['sueldo(_?(bruto|neto|mensual|base|ordinario))?|salario(_?(bruto|neto|mensual|base|m[ií]nimo|escolar))?|remuneraci[oó]n(_?mensual)?|ingresos?(_?(mensuales?|totales?|familiares?|declarados?|netos?|brutos?))?|haberes|honorarios|renta(_?(bruta|neta|mensual|anual))?|ingreso_?(base|familiar|per_?capita)|salary|income|wages?', 0.85]),
  byType(NUMBER()))

algorithm('CR_PATRIMONIO', 'characterMapping.NumericMapping', { minValue: 1000000, maxValue: 500000000 }, '48000000')
domain('CR_FIN_PATRIMONIO', 'CR_PATRIMONIO',
  byName(['patrimonio(_?(neto|l[ií]quido|fiscal))?|activos?_?(totales?)?|valor_?(del_?)?(inmueble|finca|veh[ií]culo|bienes|tasaci[oó]n|fiscal|comercial)|tasaci[oó]n|valor_?(fiscal|catastral)|saldo_?(cuenta|ahorro|dep[oó]sito|inversi[oó]n|fondo)|certificado_?(de_?)?dep[oó]sito|inversiones|declaraci[oó]n_?(jurada_?)?(de_?)?(bienes|patrimonio)|net_?worth|account_?balance', 0.85]),
  byType(NUMBER()))

algorithm('CR_VALOR_PENSION', 'characterMapping.NumericMapping', { minValue: 150000, maxValue: 2500000 }, '420000')
domain('CR_FIN_PENSION', 'CR_VALOR_PENSION',
  byName(['jubilaci[oó]n(_?(monto|mensual|valor))?|pensi[oó]n(_?(monto|mensual|valor|alimentaria|alimenticia|por_?invalidez|por_?vejez))?|monto_?(jubilaci[oó]n|pensi[oó]n|beneficio|subsidio)|valor_?(pensi[oó]n|subsidio|beneficio)|rnc(_?monto)?|ivm(_?monto)?|r[eé]gimen_?no_?contributivo|pension_?amount', 0.9]),
  byType(NUMBER()))

// The SINIRUBE joins the registers of every social programme: whoever holds a row of it holds the
// condición socioeconómica article 3 e) calls sensitive.
const PROGRAMMES = ['Avancemos', 'Crecemos', 'Bono de vivienda (BANHVI)', 'Red de Cuido', 'Pensión del Régimen No Contributivo', 'Beca FONABE', 'Comedor escolar', 'Bono Proteger', 'Ayuda del IMAS', 'Ninguno']
categorical('CR_PROGRAMA_SOCIAL', 'cr-programas-sociales.txt', PROGRAMMES, 'Subsidio estatal')
domain('CR_FIN_PROGRAMA_SOCIAL', 'CR_PROGRAMA_SOCIAL',
  byName(['programa_?social|beneficiario_?(programa|subsidio|beca|bono|prestaci[oó]n)|avancemos|crecemos|bono_?(de_?)?vivienda|banhvi|fonabe|beca_?(fonabe|mep|estudiantil)|red_?(de_?)?cuido|comedor_?escolar|imas[a-z0-9_]*|sinirube|transferencia_?monetaria|ayuda_?(social|estatal)|subsidio(_?estatal)?|social_?programme', 0.9]),
  byList([['cr-detectar-programas-sociales.txt', [...PROGRAMMES, 'avancemos', 'crecemos', 'bono de vivienda', 'banhvi', 'fonabe', 'red de cuido', 'imas', 'rnc', 'ninguno'], 0.8],
    ['cr-detectar-codigos-banderas.txt', ['s', 'n', 'sí', 'no', '1', '2', '3', '4', '5', '6', '7'], 0.3],
  ], { reject: 0.4 }))

// "Condición socioeconómica" is the law's own phrase, and the SINIRUBE score and the IMAS line of
// poverty are exactly that.
const SOCIOECONOMIC = ['Pobreza extrema', 'Pobreza básica', 'Vulnerabilidad', 'No pobre', 'Quintil 1', 'Quintil 2', 'Quintil 3', 'Quintil 4', 'Quintil 5', 'Sin clasificación']
categorical('CR_CONDICION_SOCIOECONOMICA', 'cr-condicion-socioeconomica.txt', SOCIOECONOMIC, 'Pobreza extrema', ['1', '2', '3', '4', '5'])
domain('CR_FIN_CONDICION_SOCIOECONOMICA', 'CR_CONDICION_SOCIOECONOMICA',
  byName(['condici[oó]n_?socioecon[oó]mica|nivel_?socioecon[oó]mico|nse|estrato_?socioecon[oó]mico|clasificaci[oó]n_?(socioecon[oó]mica|imas|sinirube)|puntaje_?(imas|sinirube|ficha)|ficha_? ?(de_?)?informaci[oó]n_?social|fis|l[ií]nea_?(de_?)?pobreza|condici[oó]n_?(de_?)?pobreza|pobreza(_?extrema)?|vulnerabilidad|quintil(_?(de_?)?(ingreso|riqueza))?|decil|[ií]ndice_?(de_?)?desarrollo_?social', 0.9]),
  byList([['cr-detectar-condicion-socioeconomica.txt', [...SOCIOECONOMIC, 'pobreza extrema', 'pobreza básica', 'vulnerable', 'no pobre', 'quintil', 'decil', 'a', 'b', 'c', 'd', 'e'], 0.6]], { reject: 0.4 }))

const TENURES = ['Propia totalmente pagada', 'Propia pagando a plazos', 'Alquilada', 'En precario', 'Cedida o prestada', 'Otra']
categorical('CR_TENENCIA_VIVIENDA', 'cr-tenencia-vivienda.txt', TENURES, 'Vivienda en precario')
domain('CR_FIN_VIVIENDA', 'CR_TENENCIA_VIVIENDA',
  byName(['tenencia_?(de_?)?(la_?)?vivienda|tipo_?(de_?)?tenencia|vivienda_?(propia|alquilada|tipo_?tenencia)|condici[oó]n_?(de_?)?(la_?)?vivienda|ocupaci[oó]n_?vivienda|r[eé]gimen_?(de_?)?tenencia|tugurio|precario|housing_?tenure', 0.9]),
  byList([['cr-detectar-tenencia-vivienda.txt', [...TENURES, 'propia', 'alquilada', 'precario', 'cedida', 'prestada', 'tugurio', 'otra'], 0.6]], { reject: 0.3 }))

// ── PENAL · Offences (art. 8 c and the clock of Ley 6723) ───────────────────
//
// Article 8 c) lets the principles of the law be limited for "la prevención, persecución,
// investigación, detención y represión de las infracciones penales" — a limit written for the
// authorities, not for whoever copies their tables. Article 11 of the Ley 6723 del Registro y
// Archivos Judiciales, as reformed by the **Ley 10453 of 4 March 2024**, cancels an entry on a
// scale that runs from the end of the sentence to ten years after it, and a certification for
// employment shows only what is still current. A test copy keeps the entry for as long as the copy
// lives, which is longer than any of those terms.

categorical('CR_ANTECEDENTES', 'cr-antecedentes.txt', ['No registra antecedentes penales', 'Registra antecedentes', 'Con causa pendiente', 'Sentencia condenatoria', 'Sentencia absolutoria', 'Sobreseimiento', 'Sin información'], 'Condenado por hurto en 2019')
domain('CR_PENAL_ANTECEDENTES', 'CR_ANTECEDENTES',
  byName(
    ['antecedentes?(_?(penales|policiales|judiciales))?|hoja_?(de_?)?delincuencia|certificado_?(de_?)?antecedentes(_?penales)?|registro_?judicial|juzgamientos?|reincidencia|condena(_?(penal|tipo))?|delito(_?(tipo|cometido))?|tipo_?(de_?)?delito|situaci[oó]n_?(jur[ií]dica|procesal)|medida_?cautelar|privad[oa]_?(de_?)?libertad|centro_?penal|adaptaci[oó]n_?social|criminal_?record', 0.95],
    ['estado_?(del_?)?proceso|sentencia|fallo', 0.55],
  ))

// The Poder Judicial numbers every case with the year, a correlative, the office and the matter:
// `24-001234-0007-PE`.
decompose('CR_EXPEDIENTE_JUDICIAL', [
  [String.raw`(\d{2})(-)(\d{6})(-)(\d{4})(-)([A-Za-z]{2,4})`, keep, keep, DIGITS, keep, keep, keep, keep],
  [String.raw`(\d{2})(-)(\d{6})(-)(\d{4})`, keep, keep, DIGITS, keep, keep],
  [String.raw`(\d{1,6})([\s\-/])([A-Za-z]{2,10})([\s\-/])(\d{4})`, DIGITS, keep, keep, keep, keep],
  [String.raw`(\d{1,6})([\s\-/])(\d{4})`, DIGITS, keep, keep],
], CM, '24-001234-0007-PE')
domain('CR_PENAL_EXPEDIENTE', 'CR_EXPEDIENTE_JUDICIAL',
  byName(
    ['n(o|ro|um|umero)_?(de_?)?(expediente_?(judicial|penal|fiscal)|causa|proceso_?(judicial|penal)|denuncia|sumaria)|expediente_?(judicial|penal|fiscal)|causa_?penal|n(o|ro|um|umero)_?(de_?)?(carpeta|legajo)_?(fiscal|judicial)|n(o|ro|um|umero)_?[uú]nico_?(de_?)?expediente|oij_?(caso|expediente)', 0.9],
    ['expediente|causa|proceso|sumaria', 0.5],
  ),
  byPattern([[String.raw`\d{2}-\d{6}-\d{4}-[A-Z]{2,4}`, 0.9], [String.raw`\d{2}-\d{6}-\d{4}`, 0.7]], { reject: 0.3 }))


// ── Preset ──────────────────────────────────────────────────────────────────

const referenced = JSON.stringify([domains, algorithms.map((x) => x.config)])
const orphans = algorithms.filter((a) => !referenced.includes(`"${a.name}"`))
if (orphans.length) throw new Error(`algorithms nobody uses: ${orphans.map((a) => a.name).join(', ')}`)
const noInput = algorithms.filter((a) => a.input === undefined)
if (noInput.length) throw new Error(`algorithms without a sample input: ${noInput.map((a) => a.name).join(', ')}`)

// The essential pack: identity documents, names, contact, address and birth date. Loading it brings
// these domains and only what they lean on; the extended pack is everything.
const ESSENTIAL = [
  'CR_L1_CEDULA', 'CR_L1_DIMEX', 'CR_L1_NITE', 'CR_L1_PASAPORTE',
  'CR_L1_NOMBRE', 'CR_L1_APELLIDO', 'CR_L1_NOMBRE_COMPLETO',
  'CR_L1_EMAIL', 'CR_L1_TELEFONO', 'CR_L1_DIRECCION', 'CR_L1_DIRECCION_COMPLEMENTO',
  'CR_L2_FECHA_NACIMIENTO',
]
const notDomains = ESSENTIAL.filter((name) => !domains.some((d) => d.name === name))
if (notDomains.length) throw new Error(`essential pack names domains the set does not have: ${notDomains.join(', ')}`)

// The version and the day it was built: bump both whenever anything in the set changes, so that
// whoever loaded an older one can see how old it is.
const VERSION = 1
const VERSION_DATE = '2026-10-01'
const preset = {
  version: VERSION,
  versionDate: VERSION_DATE,
  name: {
    en: 'Costa Rica — Ley 8968 de Protección de la Persona frente al Tratamiento de sus Datos Personales',
    'pt-BR': 'Costa Rica — Ley 8968 de Protección de la Persona frente al Tratamiento de sus Datos Personales',
    es: 'Costa Rica — Ley 8968 de Protección de la Persona frente al Tratamiento de sus Datos Personales',
  },
  summary: {
    en: 'Discovers and masks Costa Rican personal data under Ley 8968 and its regulation (Decreto 37554-JP, as amended in 2016 and 2019): direct identifiers (cédula de identidad, DIMEX, NITE, names, contact, the landmark address of article 9.3, the IBAN with valid check digits, cards, plates, property), quasi-identifiers (birth date, distrito and cantón, the district code that is also the postal code, barrio), the sensitive data article 9.1 prohibits a private party from processing — racial or ethnic origin, political opinions, religious, spiritual or philosophical convictions, health, sexual life and orientation —, health data, the economic data article 3 e) calls a condición socioeconómica and article 1 extends to a person’s bienes, and criminal records.',
    'pt-BR': 'Descobre e mascara dados pessoais costarriquenhos segundo a Ley 8968 e seu regulamento (Decreto 37554-JP, alterado em 2016 e 2019): identificadores diretos (cédula de identidad, DIMEX, NITE, nomes, contato, o endereço por pontos de referência do art. 9.3, o IBAN com dígitos de controle válidos, cartões, placas, imóveis), quase-identificadores (data de nascimento, distrito e cantão, o código do distrito que também é o código postal, bairro), os dados sensíveis que o art. 9.1 proíbe o particular de tratar — origem racial ou étnica, opiniões políticas, convicções religiosas, espirituais ou filosóficas, saúde, vida e orientação sexual —, dados de saúde, os dados econômicos que o art. 3 e) chama de condición socioeconómica e que o art. 1 estende aos bens da pessoa, e antecedentes penais.',
    es: 'Descubre y enmascara datos personales costarricenses conforme a la Ley 8968 y su reglamento (Decreto 37554-JP, reformado en 2016 y 2019): identificadores directos (cédula de identidad, DIMEX, NITE, nombres, contacto, la dirección por señas del art. 9.3, el IBAN con dígitos de control válidos, tarjetas, placas, inmuebles), cuasi-identificadores (fecha de nacimiento, distrito y cantón, el código de distrito que también es el código postal, barrio), los datos sensibles que el art. 9.1 prohíbe tratar a un particular — origen racial o étnico, opiniones políticas, convicciones religiosas, espirituales o filosóficas, salud, vida y orientación sexual —, datos de salud, los datos económicos que el art. 3 e) llama condición socioeconómica y que el art. 1 extiende a los bienes de la persona, y antecedentes penales.',
  },
  profileSet: {
    name: `CR - Ley 8968 - v${VERSION}`,
    description: 'Identificadores directos, cuasi-identificadores, datos sensibles (art. 3 e y art. 9.1), datos de salud, condición socioeconómica y datos de bienes (art. 3 e y art. 1) y antecedentes penales, conforme a la Ley 8968 de Protección de la Persona frente al Tratamiento de sus Datos Personales de Costa Rica y su reglamento.',
    threshold: 60,
    classifiers: classifiers.map((c) => c.name),
  },
  packs: {
    essential: {
      description: 'Paquete esencial de la Ley 8968: cédula de identidad, DIMEX, NITE, pasaporte, nombres, contacto, dirección y fecha de nacimiento.',
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
const smallCantones = cantonPlaces.filter((c) => c.small)
const inSmall = smallDistritos.reduce((a, d) => a + (d.population ?? 0), 0)
const unknown = DISTRITOS.filter((d) => d.population === null).length
console.log(`${domains.length} domains, ${classifiers.length} classifiers, ${algorithms.length} algorithms, ${files.size} files`)
console.log(`distritos: ${smallDistritos.length} of ${DISTRITOS.length} under ${SMALL_PLACE} (${inSmall} people), ${unknown} without a published figure; cantones: ${smallCantones.length} of ${CANTONES.length}`)
console.log(`${places.names} names generalized, ${places.table.length} table lines, ${codePairs.length} codes`)
