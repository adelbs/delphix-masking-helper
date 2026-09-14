#!/usr/bin/env node
/**
 * Builds the Chile (Ley 21.719) pre-configured profile set: preset.json and files/.
 *
 *   node presets/chile-ley-21719/build.mjs
 *
 * source/ holds the hand-kept lists (names, surnames, streets, the 346 comunas). Everything in
 * files/ and preset.json is generated from them and from the definitions below — edit here, then
 * build, then run verify.mjs.
 *
 * Structure of the set
 *   L1  direct identifiers      RUT, names, contact, documents, accounts, devices, vehicles
 *   L2  quasi-identifiers       birth date, age, sex, comuna, postal code, occupation…
 *   L3  sensitive data (art. 2) ethnicity, health, biometrics, sexual life, beliefs,
 *                               political/union affiliation, socioeconomic situation, criminal
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
/** A detection list also finds values written without accents or ñ. */
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
  return algorithm(name, 'decompose.RegexDecompose', {
    maskPatterns: patterns.map(([regex, ...actions]) => ({ regex, actions })),
    fallbackAction: fallback,
    trimInput: true,
    requireMask: false,
  }, input)
}

function lookup(name, fileName, values, input, caseMode = 'PRESERVE_INPUT') {
  return algorithm(name, 'secureLookup.SecureLookup', {
    lookupFile: { uri: file(fileName, values) },
    hashMethod: 'SHA256',
    maskedValueCase: caseMode,
    inputCaseSensitive: false,
    trimWhitespaceFromInput: true,
    trimWhitespaceInLookupFile: true,
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
  description: 'Nombre de la columna (y variantes usadas en sistemas chilenos).',
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
// One code per classifier — Delphix refuses JavaSqlType twice, and a second TYPE classifier in the
// same domain would be merged with this one, which drops SQL codes.
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

const NOMBRES = unique(readLines('nombres.txt'))
const APELLIDOS = unique(readLines('apellidos.txt'))

const COMUNAS = readLines('comunas.tsv').map((line) => {
  const [cut, name, provincia, region, population] = line.split('\t')
  return { cut, name, provincia, region, population: Number(population) || 0 }
})
if (COMUNAS.length !== 346) throw new Error(`expected 346 comunas, found ${COMUNAS.length}`)

// ── Shared algorithms ───────────────────────────────────────────────────────

const LETTERS = 'ghijklmnñopqrstuvwxyz'
const ACCENTED = 'áéíóúü'
// The one Character Mapping the set composes with. Hex letters form their own group, so a MAC,
// UUID or IPv6 stays valid hex; accented letters and ñ are mapped too, since left alone they help
// re-identify a name. Digits map exactly as a digits-only mapping would, so it also masks RUT
// bodies and phone numbers.
// One configuration serves every composition: digits map exactly as a digits-only mapping would.
// minMaskedPositions 0 lets a placeholder such as "S/I" through instead of failing the row.
algorithm('CL_CM_ALFANUM', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'abcdef', 'ABCDEF', LETTERS, LETTERS.toUpperCase(), ACCENTED, ACCENTED.toUpperCase()],
  caseSensitive: true,
  minMaskedPositions: 0,
}, 'A12.345.678-Ñ')
decompose('CL_SIN_CAMBIO', [['(.*)', keep]], keep)
decompose('CL_REDACTAR', [['(.+)', { type: 'REDACT', redactCharacter: 'X' }]], keep, 'secreto123')
lookup('CL_SUPRIMIR', 'cl-sin-informacion.txt', ['Sin información'], 'Depresión mayor', 'PRESERVE_LOOKUP_FILE')

// Yes/no columns keep their vocabulary: a CHAR(1) S/N stays S/N.
decompose('CL_BANDERA', [
  [String.raw`(?i)(s[ií]|no)`, apply(lookup('CL_BANDERA_SI_NO', 'cl-bandera-si-no.txt', ['Si', 'No']))],
  ['(?i)(true|false)', apply(lookup('CL_BANDERA_TRUE_FALSE', 'cl-bandera-true-false.txt', ['true', 'false']))],
  ['(?i)([sn])', apply(lookup('CL_BANDERA_S_N', 'cl-bandera-s-n.txt', ['S', 'N']))],
  ['(?i)(y)', apply(lookup('CL_BANDERA_Y_N', 'cl-bandera-y-n.txt', ['Y', 'N']))],
  ['([01])', apply(lookup('CL_BANDERA_0_1', 'cl-bandera-0-1.txt', ['0', '1']))],
], keep, 'S')

const FLAG = String.raw`(?i)(s[ií]|no|true|false|[sny01])`
/**
 * A categorical sensitive attribute: flags stay flags, numeric codes get other digits, and any
 * other value is replaced by one from `values` — or suppressed, when no list is given.
 */
function categorical(name, fileName, values, input) {
  const replacement = values ? lookup(`${name}_LISTA`, fileName, values) : 'CL_SUPRIMIR'
  return decompose(name, [[FLAG, apply('CL_BANDERA')], [String.raw`(\d{1,6})`, apply('CL_CM_ALFANUM')]], apply(replacement), input)
}
categorical('CL_CATEGORIA_SUPRIMIDA', null, null, 'Trastorno depresivo')

// ── L1 · RUT / RUN ──────────────────────────────────────────────────────────
//
// The RUT check digit is modulo 11, weights 2..7 from the right, and 10 is written K. The Check
// Digit framework writes 10 as 0, so a plain configuration leaves ~9 % of masked RUTs invalid.
// Two passes avoid that:
//   1. mask the body and write an auxiliary digit computed with the weights doubled (mod 11).
//      That digit is 9 exactly when the real check digit is K.
//   2. auxiliary 9 → write K; otherwise recompute the real check digit, leaving the body as is.
// The body mapping is a Character Mapping over digits, the same one the body-only domain uses,
// so a RUT keeps its masked body whether it is stored whole or split into body and check digit.

const RUT_WEIGHTS = [2, 3, 4, 5, 6, 7, 2, 3]
const DOUBLED = RUT_WEIGHTS.map((w) => (2 * w) % 11)
const RUT_BODY = { 8: String.raw`\d{2}\.?\d{3}\.?\d{3}`, 7: String.raw`\d\.?\d{3}\.?\d{3}`, 6: String.raw`\d{3}\.?\d{3}` }
const checkDigit = (digits, weights, numeric) => ({
  weightList: weights.slice(0, digits), modulusNumber: 11, checkDigitIndex: digits,
  calculateChecksumRightToLeft: true, numDigitsForCheckdigitCalculation: digits,
  numericAlgorithm: use(numeric), preserveRegex: String.raw`[.\-]`,
  inputHandlingConfig: { characterHandling: 'STANDARD', invalidInputHandling: 'ERROR', shortInputHandling: 'FALLBACK', padCharacter: '0', trimWhitespace: true },
})
for (const n of [8, 7, 6]) {
  algorithm(`CL_RUT_CUERPO_${n}`, 'checkdigit.Checkdigit', checkDigit(n, DOUBLED, 'CL_CM_ALFANUM'))
  algorithm(`CL_RUT_DV_${n}`, 'checkdigit.Checkdigit', checkDigit(n, RUT_WEIGHTS, 'CL_SIN_CAMBIO'))
}
decompose('CL_RUT_PASO_1',
  [8, 7, 6].map((n) => [`(${RUT_BODY[n]}-?[0-9kK])`, apply(`CL_RUT_CUERPO_${n}`)]),
  apply('CL_CM_ALFANUM'))
decompose('CL_RUT_PASO_2', [
  ...[8, 7, 6].map((n) => [`(${RUT_BODY[n]}-?)(9)`, keep, redactAs('K')]),
  ...[8, 7, 6].map((n) => [`(${RUT_BODY[n]}-?[0-9])`, apply(`CL_RUT_DV_${n}`)]),
], keep)
algorithm('CL_RUT', 'stringAlgorithmChain.StringAlgorithmChain',
  { algorithmReferences: [use('CL_RUT_PASO_1'), use('CL_RUT_PASO_2')] }, '12.345.678-5')
lookup('CL_RUT_DV', 'cl-digito-verificador.txt', ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'K'], 'K')

domain('CL_L1_RUT', 'CL_RUT',
  byName(
    ['rut|run|r_u_t|rol_?unico_?(tributario|nacional)?|n(ro|um|umero)?_?rut|rut_?(cli|pac|emp|afil|benef|tit|prov|func|trab|usu|pers|cte|contr|deud|aval|repr|alum|est|pro|med|cond|prop|aseg)[a-z]*|rutcli[a-z]*|rutpac[a-z]*|tax_?id|id_?tributario', 0.8],
  ),
  byType(STRING(7)),
  byPattern([
    [String.raw`\d{1,2}\.\d{3}\.\d{3}-[\dkK]`, 1],
    [String.raw`\d{7,8}-[\dkK]`, 0.95],
    [String.raw`\d{6,8}[kK]`, 0.9],
    [String.raw`\d{3}\.\d{3}-[\dkK]`, 0.8],
  ], { reject: 0.2 }))

domain('CL_L1_RUT_CUERPO', 'CL_CM_ALFANUM',
  byName(
    ['rut_?(num|nro|numero|cuerpo|sin_?dv|sdv|base|n)|n(ro|um)?_?rut_?sin_?dv|rutnum|rut_?sin_?digito', 0.85],
    ['rut|run', 0.6],
  ),
  byType(NUMBER(5, 10), STRING(5, 10)),
  byPattern([[String.raw`\d{1,2}\.?\d{3}\.?\d{3}`, 0.4]], { reject: 0.3 }))

domain('CL_L1_RUT_DV', 'CL_RUT_DV',
  byName(['dv|d_v|digito_?verificador|dig_?verif(icador)?|dig_?ver|dv_?(rut|run)|(rut|run)_?dv|dvrut|rutdv|check_?digit', 0.9]),
  byType(STRING(0, 2), NUMBER(0, 2)),
  byPattern([[String.raw`[\dkK]`, 0.3]], { reject: 0.3 }))

// ── L1 · Names ──────────────────────────────────────────────────────────────

const NOT_A_PERSON = 'producto|prod|articulo|item|empresa|emp|compania|razon|fantasia|archivo|arch|file|calle|via|comuna|region|provincia|ciudad|pais|banco|sucursal|plan|campana|proyecto|servicio|equipo|tabla|columna|campo|usuario|user|host|servidor|dominio|marca|modelo|categoria|tipo|estado|colegio|establecimiento|institucion|isapre|afp|curso|carrera|asignatura|documento|doc|centro|unidad|area|depto|departamento|cargo|sistema|app|aplicacion|grupo|lista|reporte|informe|proceso|evento|tarea|perfil|rol|clase|objeto|cuenta|medicamento|farmaco|diagnostico|examen|programa|beneficio|partido|sindicato|religion|etnia|pueblo|lugar|local|tienda|bodega|proveedor|convenio|contrato|poliza|seguro|org|organizacion|entidad|parametro|variable|metodo|funcion|indice|job|script|cola|recurso|red|equipo|dispositivo|plantilla|template|imagen|foto|pagina|sitio|modulo|menu|opcion|accion|permiso'
const PERSON_ROLE = 'cliente|cli|paciente|pac|trabajador|trab|funcionario|func|alumno|estudiante|afiliado|beneficiario|titular|madre|padre|tutor|apoderado|conyuge|pareja|medico|doctor|profesional|responsable|contacto|emergencia|aval|codeudor|deudor|remitente|destinatario|receptor|firmante|testigo|representante|propietario|arrendatario|asegurado|contratante|victima|denunciante|imputado|socio|donante|heredero|causante|persona|pers|conductor|chofer|vendedor|ejecutivo|agente|empleado|colaborador'

decompose('CL_NOMBRES', [
  [String.raw`(\S+)`, apply('CL_NOMBRE_PILA')],
  [String.raw`(\S+)\s+(\S+)`, apply('CL_NOMBRE_PILA'), apply('CL_NOMBRE_PILA')],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, apply('CL_NOMBRE_PILA'), apply('CL_NOMBRE_PILA'), apply('CL_NOMBRE_PILA')],
], apply('CL_CM_ALFANUM'), 'Juan Carlos')
algorithm('CL_NOMBRE_PILA', 'name.Name', {
  lookupFile: { uri: file('cl-nombres.txt', NOMBRES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'María')
decompose('CL_APELLIDOS', [
  [String.raw`(\S+)`, apply('CL_APELLIDO')],
  [String.raw`(\S+)\s+(\S+)`, apply('CL_APELLIDO'), apply('CL_APELLIDO')],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, apply('CL_APELLIDO'), apply('CL_APELLIDO'), apply('CL_APELLIDO')],
], apply('CL_CM_ALFANUM'), 'Pérez González')
algorithm('CL_APELLIDO', 'name.Name', {
  lookupFile: { uri: file('cl-apellidos.txt', APELLIDOS) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Muñoz')
// Chilean convention: given name(s), then paternal and maternal surname.
const N = apply('CL_NOMBRE_PILA')
const A = apply('CL_APELLIDO')
decompose('CL_NOMBRE_COMPLETO', [
  [String.raw`([^,]+),\s*(.+)`, apply('CL_APELLIDOS'), apply('CL_NOMBRES')],
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, A],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, A, A],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, A, A],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, N, A, A],
], apply('CL_CM_ALFANUM'), 'Juan Carlos Pérez González')

domain('CL_L1_NOMBRE', 'CL_NOMBRES',
  byName(
    [`primer_?nombre|segundo_?nombre|nombres?_?pila|nombre_?social|first_?name|given_?names?|fname|name_?first|middle_?name|nombre[12]|nombres(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completos?|y_?apellidos?|apellidos?))`, 0.85],
    [`nombre(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|compl|full|y_?apellidos?|apellidos?))|nomb?(?!_?(${NOT_A_PERSON}|completo))|name(?!_?(${NOT_A_PERSON}))`, 0.5],
  ),
  byList([['cl-detectar-nombres.txt', NOMBRES, 0.7]], { tokenize: true, reject: 0.3 }))

domain('CL_L1_APELLIDO', 'CL_APELLIDOS',
  byName(['apellidos?|apellido_?(paterno|materno|pat|mat|uno|dos|[12])|ape_?(pat|mat|paterno|materno|[12])|apepat|apemat|appat|apmat|ap_?(pat|mat|paterno|materno)|a_?paterno|a_?materno|paterno|materno|last_?name|surname|lname|family_?name|second_?last_?name|mother_?last_?name', 0.85]),
  byList([['cl-detectar-apellidos.txt', APELLIDOS, 0.7]], { tokenize: true, reject: 0.3 }))

domain('CL_L1_NOMBRE_COMPLETO', 'CL_NOMBRE_COMPLETO',
  byName(
    [`nombre_?(completo|compl|full)|nombres?_?y_?apellidos?|nombres?_?apellidos?|nombreapellido|nom_?completo|nomcompleto|nombrecompleto|full_?name|fullname|person_?name|customer_?name|employee_?name|patient_?name|nombre_?(${PERSON_ROLE})`, 0.9],
    ['titular|beneficiario|contacto_?emergencia|conyuge|apoderado|tutor_?legal|representante_?legal|paciente|victima|asegurado|contratante|razon_?social_?persona', 0.6],
    // A bare NOMBRE holds a given name or a full name: the values decide between the two domains.
    [`nombre(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|compl|full|y_?apellidos?|apellidos?))|name(?!_?(${NOT_A_PERSON}))`, 0.5],
  ),
  byList([['cl-detectar-nombres.txt', NOMBRES, 0.6], ['cl-detectar-apellidos.txt', APELLIDOS, 0.6]], { tokenize: true, reject: 0.3 }))

// ── L1 · Contact ────────────────────────────────────────────────────────────

decompose('CL_EMAIL', [
  // The top-level domain becomes .test, reserved for tests: a masked address can never deliver.
  [String.raw`([^@\s]+)@([^@\s]+)\.([A-Za-z]{2,24})`, apply('CL_CM_ALFANUM'), apply('CL_CM_ALFANUM'), redactAs('test')],
], apply('CL_CM_ALFANUM'), 'juan.perez@gmail.com')
domain('CL_L1_EMAIL', 'CL_EMAIL',
  byName(['e_?mail[a-z0-9_]*|mail[a-z0-9_]*|correo(_?electronico)?[a-z0-9_]*|casilla(_?electronica)?|email_?address', 0.85]),
  byType(STRING(5)),
  byPattern([[String.raw`[A-Za-z0-9._%+'\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}`, 1]], { reject: 0.2 }))

const phoneActions = [keep, keep, apply('CL_CM_ALFANUM'), keep, apply('CL_CM_ALFANUM')]
decompose('CL_TELEFONO', [
  // Country code, the mobile 9 and area codes stay; the subscriber digits are masked.
  [String.raw`(\+?56[\s\-]?)?(\(?9\)?[\s\-]?)(\d{4})([\s\-]?)(\d{4})`, ...phoneActions],
  [String.raw`(\+?56[\s\-]?)?(\(?(?:2|[3-7]\d)\)?[\s\-]?)(\d{3,4})([\s\-]?)(\d{4})`, ...phoneActions],
], apply('CL_CM_ALFANUM'), '+56 9 8765 4321')
domain('CL_L1_TELEFONO', 'CL_TELEFONO',
  byName(['tel|telefono[a-z0-9_]*|tel[eé]fono|fono[a-z0-9_]*|celular[a-z0-9_]*|cel|movil|m[oó]vil|whatsapp|wsp|fax|phone[a-z0-9_]*|mobile|cellphone|n(ro|um)_?tel(efono)?|telef|tlf|tfno|anexo', 0.85]),
  byPattern([
    [String.raw`(\+?56[\s\-]?)?9[\s\-]?\d{4}[\s\-]?\d{4}`, 0.9],
    [String.raw`(\+?56[\s\-]?)?\(?(2|[3-7]\d)\)?[\s\-]?\d{3,4}[\s\-]?\d{4}`, 0.7],
    [String.raw`\+?\d[\d\s()\-]{7,15}`, 0.3],
  ], { reject: 0.3 }))

lookup('CL_DIRECCION', 'cl-direcciones.txt', (() => {
  const random = seeded(21719)
  const streets = readLines('calles.txt')
  const out = new Set()
  while (out.size < 3000) {
    let street = streets[Math.floor(random() * streets.length)]
    if (street.startsWith('Calle ') && random() < 0.5) street = street.slice(6)
    const number = Math.floor(random() < 0.7 ? 1 + random() * 2999 : 3000 + random() * 12000)
    const extra = random() < 0.15 ? `, depto ${1 + Math.floor(random() * 20)}0${1 + Math.floor(random() * 9)}`
      : random() < 0.06 ? `, casa ${'ABCDEFGH'[Math.floor(random() * 8)]}` : ''
    out.add(`${street} ${number}${extra}`)
  }
  return [...out]
})(), 'Av. Providencia 1234, depto 502', 'PRESERVE_LOOKUP_FILE')
domain('CL_L1_DIRECCION', 'CL_DIRECCION',
  byName(['direccion(?!_?(ip|mac|web|url|correo|mail|electronica|email))[a-z_]*|direcci[oó]n|dir|domicilio[a-z_]*|calle|avenida|pasaje|address|street|addr|dir_?(particular|comercial|laboral|envio|despacho|facturacion|cliente|paciente|trabajo)|residencia|villa|poblacion|lugar_?residencia|home_?address', 0.8]),
  byType(STRING(6)),
  byPattern([
    [String.raw`(?i)(av(enida)?\.?|calle|pasaje|psje\.?|pje\.?|camino|diagonal|villa|poblaci[oó]n|block)\s+.+\d+.*`, 0.8],
    [String.raw`[A-Za-zÁÉÍÓÚÑáéíóúñ'.\s]{4,}\s#?\d{1,5}(\s*,?\s*(depto|dpto|dep|of|oficina|casa|block)\.?\s*\w+)?`, 0.4],
  ], { reject: 0.2 }))

domain('CL_L1_DIRECCION_COMPLEMENTO', 'CL_CM_ALFANUM',
  byName(['depto|dpto|n(ro|um)_?depto|block|torre|casa_?(num|nro)|n(ro|um|umero)_?casa|n(ro|um|umero)_?domicilio|numeracion|n(ro|um|umero)_?calle|house_?number|apartment|apt|unit_?number|lote|sitio|parcela|manzana', 0.7]))

// ── L1 · Documents, accounts, devices, vehicles ─────────────────────────────

domain('CL_L1_NUMERO_DOCUMENTO', 'CL_CM_ALFANUM',
  byName(
    ['(n(ro|um|umero)?_?)?serie_?(ci|cedula|carnet|documento|identidad)?|serie_?ci|n(ro|um|umero)_?serie|folio_?(ci|cedula|carnet)|n(ro|um|umero)_?(de_?)?documento_?(identidad|ci|cedula)|n(ro|um|umero)_?(cedula|carnet|ci)|document_?number', 0.85],
    ['n(ro|um|umero)_?(de_?)?(documento|doc)|documento_?identidad|cedula|carnet', 0.6],
  ),
  byPattern([[String.raw`\d{3}\.\d{3}\.\d{3}`, 0.5], [String.raw`[A-Za-z]\d{9}`, 0.4]], { reject: 0.3 }))

domain('CL_L1_PASAPORTE', 'CL_CM_ALFANUM',
  byName(['pasaporte[a-z_]*|passport[a-z_]*|n(ro|um|umero)_?pasaporte|pasap', 0.85]),
  byPattern([[String.raw`[A-Za-z]{1,2}\d{6,9}`, 0.3]], { reject: 0.3 }))

domain('CL_L1_DOCUMENTO_EXTRANJERO', 'CL_CM_ALFANUM',
  byName(['dni|doc_?extranjero|documento_?extranjero|id_?extranjero|cedula_?extranjera|n(ro|um|umero)_?identificacion|identificacion_?extranjera|ci_?extranjera|nie|n(ro|um)_?visa|permiso_?residencia|residencia_?definitiva|id_?nacional|national_?id', 0.8]))

domain('CL_L1_CUENTA_BANCARIA', 'CL_CM_ALFANUM',
  byName(['cuenta_?(corriente|vista|rut|bancaria|banco|ahorro|deposito|abono|pago|destino|origen|cte)|cta_?(cte|corriente|vista|bancaria|banco|ahorro)|ctacte|n(ro|um|umero)?_?cuenta(_?(banco|bancaria|corriente|vista))?|account_?(number|no|num|nbr)|bank_?account', 0.85]))

// Payment Card fails a row that has no digits to mask; only values shaped like a card reach it.
algorithm('CL_TARJETA_LUHN', 'characterMapping.PaymentCard', { minMaskedPositions: 6, preserve: 0 })
decompose('CL_TARJETA', [[String.raw`(\d[\d\s\-]{11,22}\d)`, apply('CL_TARJETA_LUHN')]], keep, '4111 1111 1111 1111')
domain('CL_L1_TARJETA', 'CL_TARJETA',
  byName(['tarjeta(_?(credito|debito|cred|deb|num|nro|numero))?|n(ro|um|umero)_?tarjeta|pan|card_?(number|no|num)|credit_?card|cc_?(number|num)|tdc|tc_?num', 0.85]),
  // 0.9, not 1: an IMEI is 15 Luhn-valid digits too, and its own column name should win.
  byPattern([[String.raw`\d{13,19}`, 0.9, { checksum: 'LUHN', clean: String.raw`[\s\-]` }]], { reject: 0.3 }))

algorithm('CL_OCTETO', 'characterMapping.NumericMapping', { minValue: 1, maxValue: 254 })
decompose('CL_IP', [
  [String.raw`(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})`, apply('CL_OCTETO'), apply('CL_OCTETO'), apply('CL_OCTETO'), apply('CL_OCTETO')],
], apply('CL_CM_ALFANUM'), '200.27.1.10')
domain('CL_L1_IP', 'CL_IP',
  byName(['ip|ip_?(address|addr|origen|destino|cliente|usuario|remota|publica|privada|acceso|conexion|login)|direccion_?ip|dir_?ip|ipv[46]|remote_?addr|client_?ip|host_?ip', 0.85]),
  byPattern([
    [String.raw`((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)`, 1],
    [String.raw`[0-9A-Fa-f]{1,4}(:[0-9A-Fa-f]{0,4}){2,7}`, 0.9],
  ], { reject: 0.3 }))

domain('CL_L1_DISPOSITIVO', 'CL_CM_ALFANUM',
  byName(['imei|imsi|iccid|mac|mac_?address|direccion_?mac|device_?id|id_?dispositivo|dispositivo_?id|uuid_?dispositivo|advertising_?id|idfa|gaid|cookie(_?id)?|session_?id|id_?sesion|fingerprint_?dispositivo|serial_?equipo|n(ro|um)_?serie_?equipo', 0.8]),
  byPattern([
    [String.raw`([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}`, 1],
    [String.raw`\d{15}`, 0.8, { checksum: 'LUHN' }],
  ], { reject: 0.3 }))

const CONSONANTS = 'BCDFGHJKLPRSTVWXYZ'
// Consonants map to consonants: a masked plate is still a plausible Chilean plate.
algorithm('CL_PATENTE', 'characterMapping.CharacterMapping', {
  characterGroups: [CONSONANTS, 'AEIMNOQU', CONSONANTS.toLowerCase(), 'aeimnoqu', '0123456789'],
  caseSensitive: true,
}, 'BBCD-12')
domain('CL_L1_PATENTE', 'CL_PATENTE',
  byName(['patente(_?(vehiculo|auto|unica|nro|num))?|placa(_?patente)?|ppu|matricula_?(vehiculo|auto)|license_?plate|plate(_?number)?|n(ro|um)_?patente', 0.85]),
  byPattern([
    [`[${CONSONANTS}]{4}[\\s·.\\-]?\\d{2}`, 1],
    [String.raw`[A-Z]{2}[\s·.\-]?\d{2}[\s·.\-]?\d{2}`, 0.6],
    [`[${CONSONANTS}]{3}[\\s·.\\-]?\\d{2}`, 0.6],
    [`[${CONSONANTS}]{4,5}[\\s·.\\-]?\\d`, 0.5],
  ], { reject: 0.3 }))

domain('CL_L1_VEHICULO_ID', 'CL_CM_ALFANUM',
  byName(['vin|chasis|n(ro|um|umero)_?chasis|n(ro|um|umero)_?motor|serie_?motor|vin_?number', 0.8]),
  byPattern([[String.raw`[A-HJ-NPR-Z0-9]{17}`, 0.7]], { reject: 0.3 }))

domain('CL_L1_NUMERO_CONTRATO', 'CL_CM_ALFANUM',
  byName(['contrato|n(ro|um|umero)_?contrato|p[oó]liza|n(ro|um|umero)_?poliza|n(ro|um)_?operacion|operacion_?credito|n(ro|um)_?credito|n(ro|um|umero)_?socio|n(ro|um|umero)_?cliente|cod(igo)?_?cliente|n(ro|um|umero)_?afiliado|folio_?(contrato|poliza|credito)|n(ro|um)_?siniestro|n(ro|um)_?beneficiario|n(ro|um)_?matricula|matricula_?alumno|n(ro|um)_?carnet_?(socio|afiliado)', 0.7]))

domain('CL_L1_USUARIO_RRSS', 'CL_CM_ALFANUM',
  byName(['usuario|username|user_?name|login|nick(name)?|alias|cuenta_?usuario|usr|facebook|instagram|twitter|tiktok|linkedin|red_?social|perfil_?(facebook|instagram|twitter|linkedin)|skype|telegram|handle', 0.7]))

domain('CL_L1_CREDENCIAL', 'CL_REDACTAR',
  byName(['password|passwd|pwd|pass|contrasen[aã]|contraseña|clave(?!_?(producto|articulo|sucursal|interna|tipo|registro|primaria|foranea|elector))[a-z_]*|pin|hash_?password|password_?hash|secret|token_?acceso|access_?token|refresh_?token|api_?key|otp|respuesta_?secreta|pregunta_?secreta', 0.9]))

decompose('CL_COORDENADA', [
  // The integer part and first decimal stay (about 11 km): the place is generalized, not moved.
  [String.raw`(-?\d{1,3}\.\d)(\d+)\s*,\s*(-?\d{1,3}\.\d)(\d+)`, keep, apply('CL_CM_ALFANUM'), keep, apply('CL_CM_ALFANUM')],
  [String.raw`(-?\d{1,3}\.\d)(\d+)`, keep, apply('CL_CM_ALFANUM')],
], keep, '-33.448891')
domain('CL_L1_GEOLOCALIZACION', 'CL_COORDENADA',
  byName(
    ['lat|latitud|latitude|lon|lng|longitude|coordenadas?|coord_?[xy]|geo_?(lat|lon|lng|loc|localizacion|posicion)|geolocalizacion|ubicacion_?gps|gps|posicion_?gps', 0.85],
    ['longitud|long', 0.5],
  ),
  byPattern([
    [String.raw`-?\d{1,2}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}`, 0.9],
    [String.raw`-(1[7-9]|[2-5]\d)\.\d{3,}`, 0.7],
    [String.raw`-(6[6-9]|7\d|8[01]|109)\.\d{3,}`, 0.7],
  ], { reject: 0.3 }))

// ── L1 · Free text ──────────────────────────────────────────────────────────

algorithm('CL_TEXTO_LIBRE', 'freeTextRedaction.FreeTextRedaction', {
  regularExpressions: [
    String.raw`\d{1,2}\.\d{3}\.\d{3}-[\dkK]`,
    String.raw`\d{7,8}-[\dkK]`,
    String.raw`[\w.+\-]+@[\w\-]+(\.[\w\-]+)+`,
    String.raw`\+?56\d{9}`,
    String.raw`(?<!\d)9\d{8}(?!\d)`,
    String.raw`(?<![A-Za-z])[BCDFGHJKLPRSTVWXYZ]{4}-?\d{2}(?!\d)`,
    String.raw`(?<!\d)\d{13,19}(?!\d)`,
    String.raw`(?<!\d)(\d{1,3}\.){3}\d{1,3}(?!\d)`,
  ].map((patternString) => ({ patternString })),
  regExRedactValue: '[DATO]',
  lookupFile: { uri: file('cl-texto-nombres.txt', unique([...NOMBRES, ...APELLIDOS].flatMap((v) => [v, v.toUpperCase(), fold(v), fold(v).toUpperCase()]))) },
  lookupFileRedactValue: '[NOMBRE]',
  isDenyList: true,
}, 'Paciente Soto, RUT 12.345.678-5, correo p.soto@gmail.com')

domain('CL_L1_TEXTO_LIBRE', 'CL_TEXTO_LIBRE',
  byName(['observaciones?|obs|comentarios?|glosa|notas?|detalle|descripcion_?(caso|reclamo|incidente|solicitud|problema|atencion)|texto_?libre|mensaje|reclamo|consulta_?texto|motivo_?(texto|detalle)|narrativa|relato|resumen_?caso|remarks|comments?|notes?|free_?text|memo', 0.6]),
  byType(STRING(30)),
  byPattern([
    [String.raw`\d{1,2}\.\d{3}\.\d{3}-[\dkK]`, 0.7],
    [String.raw`[\w.+\-]+@[\w\-]+\.[A-Za-z]{2,}`, 0.7],
    [String.raw`(\+?56\s?)?9\s?\d{4}\s?\d{4}`, 0.5],
  ], { reject: 0, partial: true }))

// ── L2 · Quasi-identifiers ──────────────────────────────────────────────────

// Small shifts: large enough to break the link to the person, small enough that ages, school
// years and the 18th birthday move for few people. Dates in columns that combine with the birth
// date (hiring, death, admission) move less.
algorithm('CL_FECHA_NACIMIENTO', 'dateAlgorithms.DateShift', { minRange: -60, maxRange: 60, unit: 'DAYS', roll: false }, '1985-07-20')
algorithm('CL_FECHA_EVENTO', 'dateAlgorithms.DateShift', { minRange: -30, maxRange: 30, unit: 'DAYS', roll: false }, '2021-03-15')

domain('CL_L2_FECHA_NACIMIENTO', 'CL_FECHA_NACIMIENTO',
  byName(['fecha_?(de_?)?nac(imiento)?|fec_?nac(imiento)?|f_?nac(imiento|im)?|fnac|fechanac(imiento)?|fecnac|nacimiento|fch_?nac|dob|birth_?date|date_?of_?birth|birthdate|birthday|cumplea(n|ñ)os', 0.9]),
  byType(...DATES, STRING(6)))

decompose('CL_ANIO', [[String.raw`(\d{3})(\d)`, keep, apply('CL_CM_ALFANUM')]], keep, '1985')
domain('CL_L2_ANIO_NACIMIENTO', 'CL_ANIO',
  byName(['an(i)?o_?nac(imiento)?|año_?nac(imiento)?|birth_?year|year_?of_?birth|ano_?nacim', 0.9]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// The decade stays and the unit is masked: 37 becomes 3x. From 100 on, 90.
decompose('CL_EDAD', [
  [String.raw`(\d{3,})`, redactAs('90')],
  [String.raw`([1-9])(\d)(\.\d+)`, keep, apply('CL_CM_ALFANUM'), keep],
  [String.raw`([1-9])(\d)`, keep, apply('CL_CM_ALFANUM')],
  [String.raw`(\d)`, apply('CL_CM_ALFANUM')],
], keep, '37')
domain('CL_L2_EDAD', 'CL_EDAD',
  byName(['edad(_?(actual|paciente|cliente|afiliado|beneficiario|ingreso|anos|años))?|age|anos_?edad|rango_?etario|edad_?en_?anos', 0.85]),
  byType(NUMBER(0, 6), STRING(0, 6)))

domain('CL_L2_FECHA_EVENTO', 'CL_FECHA_EVENTO',
  byName(['fecha_?(de_?)?(defuncion|fallecimiento|muerte|matrimonio|casamiento|divorcio|ingreso_?(laboral|empresa|trabajo)|contratacion|contrato|egreso|despido|desvinculacion|renuncia|jubilacion|pension|licencia|hospitalizacion|alta_?medica|diagnostico|atencion|consulta|parto|embarazo|detencion|condena|vacunacion|cirugia|examen)|fec_?(defuncion|ingreso_?laboral|egreso|contrato|alta|atencion|diagnostico)|death_?date|hire_?date|termination_?date|date_?of_?death|admission_?date|discharge_?date', 0.8]),
  byType(...DATES, STRING(6)))

decompose('CL_SEXO', [
  ['(?i)(femenino|masculino)', apply(lookup('CL_SEXO_PALABRA', 'cl-sexo-palabra.txt', ['Femenino', 'Masculino']))],
  ['(?i)(mujer|hombre)', apply(lookup('CL_SEXO_MUJER_HOMBRE', 'cl-sexo-mujer-hombre.txt', ['Mujer', 'Hombre']))],
  ['(?i)(female|male)', apply(lookup('CL_SEXO_INGLES', 'cl-sexo-ingles.txt', ['Female', 'Male']))],
  ['(?i)([fm])', apply(lookup('CL_SEXO_F_M', 'cl-sexo-f-m.txt', ['F', 'M']))],
  ['(?i)(h)', apply(lookup('CL_SEXO_H_M', 'cl-sexo-h-m.txt', ['H', 'M']))],
], keep, 'F')
domain('CL_L2_SEXO', 'CL_SEXO',
  byName(['sexo(_?(biologico|registral|paciente|cliente))?|sex|g[eé]nero(?!_?(identidad|social|autopercibido))|gender|cod_?sexo', 0.85]),
  byList([['cl-detectar-sexo.txt', ['f', 'm', 'h', 'femenino', 'masculino', 'mujer', 'hombre', 'female', 'male', 'fem', 'masc'], 0.5]], { reject: 0.5 }))

// Comunas below 20,000 inhabitants (Censo 2024) become the most populous comuna of their
// province, or of their region when that one is also small. The value is still a real comuna.
const SMALL_COMUNA = 20000
const largest = (list) => list.reduce((a, b) => (b.population > a.population ? b : a))
const generalized = (c) => {
  if (c.population === 0 || c.population >= SMALL_COMUNA) return c
  const head = largest(COMUNAS.filter((x) => x.provincia === c.provincia))
  return head.population >= SMALL_COMUNA ? head : largest(COMUNAS.filter((x) => x.region === c.region))
}
if (COMUNAS.some((c) => c.name.includes(','))) throw new Error('a comuna name has a comma')
algorithm('CL_COMUNA', 'dataCleansing.DataCleansing', {
  lookupFile: { uri: file('cl-comuna-generalizada.txt', unique(COMUNAS.flatMap((c) => {
    const to = generalized(c).name
    return [`${c.name},${to}`, `${fold(c.name)},${to}`]
  }))) },
  delimiter: ',', caseSensitive: false, trimWhitespace: true,
}, 'Torres del Paine')
domain('CL_L2_COMUNA', 'CL_COMUNA',
  byName(
    ['comuna[a-z_]*|nom(bre)?_?comuna|municipio|municipalidad|localidad', 0.85],
    ['ciudad[a-z_]*|city|town', 0.6],
  ),
  byList([['cl-detectar-comunas.txt', COMUNAS.map((c) => c.name), 0.9]], { reject: 0.4 }))

algorithm('CL_CODIGO_COMUNA', 'dataCleansing.DataCleansing', {
  lookupFile: { uri: file('cl-codigo-comuna-generalizado.txt', unique(COMUNAS.flatMap((c) => {
    const to = generalized(c).cut
    return [`${c.cut},${to}`, `${Number(c.cut)},${Number(to)}`]
  }))) },
  delimiter: ',', caseSensitive: false, trimWhitespace: true,
}, '12301')
domain('CL_L2_CODIGO_COMUNA', 'CL_CODIGO_COMUNA',
  byName(['cod(igo)?_?comuna|id_?comuna|cut(_?comuna)?|comuna_?(cod|codigo|id|cut)|cod_?com', 0.85]),
  byType(NUMBER(0, 6), STRING(0, 6)),
  byList([['cl-detectar-codigo-comuna.txt', COMUNAS.flatMap((c) => [c.cut, String(Number(c.cut))]), 0.5]], { reject: 0.3 }))

decompose('CL_CODIGO_POSTAL', [[String.raw`(\d{3})-?(\d{4})`, keep, redactAs('0000')]], apply('CL_CM_ALFANUM'), '8320123')
domain('CL_L2_CODIGO_POSTAL', 'CL_CODIGO_POSTAL',
  byName(['cod(igo)?_?postal|cp|zip(_?code)?|postal_?code|codpostal|c_?postal', 0.9]),
  byPattern([[String.raw`\d{7}`, 0.2]], { reject: 0.3 }))

const NACIONALIDADES = ['Chilena', 'Venezolana', 'Peruana', 'Haitiana', 'Colombiana', 'Boliviana', 'Argentina', 'Ecuatoriana', 'China', 'Española', 'Brasileña', 'Dominicana', 'Cubana', 'Estadounidense', 'Paraguaya', 'Uruguaya', 'Mexicana']
lookup('CL_NACIONALIDAD', 'cl-nacionalidades.txt', NACIONALIDADES, 'Peruana')
domain('CL_L2_NACIONALIDAD', 'CL_NACIONALIDAD',
  byName(['nacionalidad|nationality|pais_?(de_?)?(nacimiento|origen)|ciudadania|citizenship|country_?of_?birth', 0.8]),
  byList([['cl-detectar-nacionalidades.txt', [...NACIONALIDADES, 'chileno', 'venezolano', 'peruano', 'haitiano', 'colombiano', 'boliviano', 'argentino', 'ecuatoriano', 'chino', 'español', 'brasileño', 'dominicano', 'cubano', 'paraguayo', 'uruguayo', 'mexicano', 'chile', 'venezuela', 'perú', 'haití', 'colombia', 'bolivia', 'ecuador', 'extranjero', 'extranjera'], 0.7]], { reject: 0.4 }))

lookup('CL_ESTADO_CIVIL', 'cl-estado-civil.txt', ['Soltero', 'Casado', 'Viudo', 'Divorciado', 'Separado', 'Conviviente civil'], 'Casada')
domain('CL_L2_ESTADO_CIVIL', 'CL_ESTADO_CIVIL',
  byName(['estado_?civil|est_?civil|ecivil|marital_?status|civil_?status|situacion_?conyugal', 0.85]),
  byList([['cl-detectar-estado-civil.txt', ['soltero', 'soltera', 'casado', 'casada', 'viudo', 'viuda', 'divorciado', 'divorciada', 'separado', 'separada', 'separado de hecho', 'conviviente', 'conviviente civil', 'acuerdo de unión civil', 'auc', 'anulado', 'anulada', 'single', 'married', 'widowed', 'divorced'], 0.7]], { reject: 0.4 }))

lookup('CL_OCUPACION', 'cl-ocupaciones.txt', ['Administrativo', 'Vendedor', 'Técnico en mantención', 'Contador', 'Ingeniero', 'Profesor', 'Enfermero', 'Técnico en enfermería', 'Conductor', 'Operario', 'Asistente de servicios', 'Cajero', 'Guardia de seguridad', 'Analista', 'Supervisor', 'Jefe de área', 'Ejecutivo comercial', 'Secretario', 'Auxiliar de aseo', 'Bodeguero', 'Electricista', 'Mecánico', 'Cocinero', 'Garzón', 'Recepcionista', 'Programador', 'Diseñador', 'Abogado', 'Médico', 'Kinesiólogo', 'Psicólogo', 'Trabajador social', 'Agricultor', 'Pescador', 'Comerciante', 'Estudiante', 'Dueña de casa', 'Jubilado', 'Independiente', 'Cesante'], 'Gerente Regional Aysén')
domain('CL_L2_OCUPACION', 'CL_OCUPACION',
  byName(['cargo(?!_?(fijo|variable|monto|adicional|servicio|tarifa|valor|cuenta|extra))|ocupaci[oó]n|profesi[oó]n|oficio|puesto(_?trabajo)?|job_?title|occupation|actividad_?laboral|titulo_?profesional', 0.8]))

lookup('CL_EMPLEADOR', 'cl-empleadores.txt', ['Comercial Los Andes SpA', 'Servicios Integrales del Sur Ltda.', 'Constructora Cordillera S.A.', 'Transportes Pacífico Norte SpA', 'Agrícola Valle Central Ltda.', 'Inversiones Maule SpA', 'Distribuidora Austral S.A.', 'Clínica San Esteban SpA', 'Colegio Particular Los Robles', 'Consultora Andina Ltda.', 'Minera Altiplano SpA', 'Pesquera Bahía Azul S.A.', 'Tecnologías del Biobío SpA', 'Supermercados La Estrella Ltda.', 'Ferretería El Maestro SpA', 'Hotelera Puerto Claro S.A.', 'Logística Santa Rosa SpA', 'Servicios de Aseo Los Aromos Ltda.', 'Frutícola Aconcagua S.A.', 'Laboratorio Cruz del Sur SpA', 'Ilustre Municipalidad de Villa Nueva', 'Fundación Manos Unidas', 'Corporación Educacional Horizonte', 'Seguridad Privada Centinela Ltda.', 'Maderas del Sur SpA'], 'Codelco')
domain('CL_L2_EMPLEADOR', 'CL_EMPLEADOR',
  byName(['empleador|nombre_?empleador|razon_?social_?empleador|empresa_?(empleadora|trabajo|laboral)|lugar_?(de_?)?trabajo|employer|institucion_?laboral', 0.8]))

const NIVELES = ['Sin estudios', 'Básica incompleta', 'Básica completa', 'Media incompleta', 'Media completa', 'Técnico nivel superior incompleta', 'Técnico nivel superior completa', 'Profesional incompleta', 'Profesional completa', 'Postgrado']
lookup('CL_NIVEL_EDUCACIONAL', 'cl-nivel-educacional.txt', NIVELES, 'Media completa')
domain('CL_L2_NIVEL_EDUCACIONAL', 'CL_NIVEL_EDUCACIONAL',
  byName(['nivel_?educa(cional|tivo)|escolaridad|nivel_?estudios|education_?level|grado_?academico|anos_?escolaridad', 0.8]),
  byList([['cl-detectar-nivel-educacional.txt', [...NIVELES, 'básica', 'media', 'universitaria', 'universitaria completa', 'universitaria incompleta', 'técnica', 'técnico profesional', 'magíster', 'doctorado', 'ninguno'], 0.6]], { reject: 0.4 }))

lookup('CL_ESTABLECIMIENTO', 'cl-establecimientos.txt', ['Escuela Básica N° 12', 'Escuela Rural Los Aromos', 'Liceo Bicentenario A-45', 'Liceo Técnico Profesional B-23', 'Colegio San Andrés', 'Colegio Santa Teresa', 'Colegio Particular Subvencionado El Roble', 'Complejo Educacional Horizonte', 'Instituto Profesional del Pacífico', 'Centro de Formación Técnica Andino', 'Universidad del Valle Central', 'Jardín Infantil Los Pollitos', 'Sala Cuna Rayito de Sol', 'Escuela Especial Nuevos Caminos', 'Liceo Polivalente C-18'], 'Liceo Bicentenario de Excelencia')
domain('CL_L2_ESTABLECIMIENTO_EDUCACIONAL', 'CL_ESTABLECIMIENTO',
  byName(['colegio|liceo|escuela|establecimiento_?(educacional|estudio|escolar)|nombre_?(colegio|escuela|liceo)|universidad|casa_?de_?estudios|school(_?name)?|jardin_?infantil|sala_?cuna', 0.75]))

// Capped at 5 as text. Min/Max BigDecimal fails on a placeholder despite its default value, and a
// numeric algorithm inside a Regex Decompose fails in the local runner's type adapter.
decompose('CL_CANTIDAD_ACOTADA', [[String.raw`([0-5])`, keep], [String.raw`(\d+)`, redactAs('5')]], keep, '9')
domain('CL_L2_CARGAS_FAMILIARES', 'CL_CANTIDAD_ACOTADA',
  byName(['cargas?_?familiares?|n(ro|um)?_?cargas|cantidad_?cargas|n(ro|um|umero)?_?hijos|cant_?hijos|hijos|integrantes_?(grupo_?)?(familiar|hogar)|n(ro|um)_?integrantes|tamano_?hogar|personas_?(en_?)?hogar', 0.8]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// ── L3 · Sensitive data (art. 2 g) ─────────────────────────────────────────

const PUEBLOS = ['Mapuche', 'Aymara', 'Rapa Nui', 'Lickanantay', 'Quechua', 'Colla', 'Diaguita', 'Chango', 'Kawésqar', 'Yagán', "Selk'nam", 'Afrodescendiente chileno', 'Ninguno']
categorical('CL_PUEBLO_ORIGINARIO', 'cl-pueblos.txt', PUEBLOS, 'Mapuche-Huilliche')
domain('CL_L3_ETNIA', 'CL_PUEBLO_ORIGINARIO',
  byName(['etnia|[eé]tnico|origen_?[eé]tnico|pueblo_?(originario|ind[ií]gena|orig)|pertenencia_?(etnica|indigena|pueblo)|calidad_?indigena|ind[ií]gena|raza|race|ethnicity|ethnic_?group|ascendencia|afrodescendiente|comunidad_?indigena', 0.9]),
  byList([['cl-detectar-pueblos.txt', [...PUEBLOS, 'mapuche-huilliche', 'huilliche', 'williche', 'pehuenche', 'lafkenche', 'picunche', 'nagche', 'aimara', 'aymará', 'rapanui', 'pascuense', 'likan antai', 'atacameño', 'kolla', 'kawashkar', 'kawéskar', 'alacalufe', 'yámana', 'yamana', 'selknam', 'ona', 'afrodescendiente', 'no pertenece', 'no pertenece a ningún pueblo', 'otro pueblo'], 0.9]], { reject: 0.4 }))

const CIE10 = ['I10', 'E11', 'E78', 'J45', 'J06', 'J02', 'J20', 'K29', 'K21', 'K59', 'M54', 'M17', 'M25', 'N39', 'N20', 'R51', 'R10', 'H10', 'H66', 'L23', 'L30', 'B34', 'A09', 'E03', 'E66', 'D50', 'I83', 'K80', 'K40', 'S93', 'S60', 'Z00', 'J30', 'J32', 'G43', 'M79', 'R05']
const CIE10_DECIMAL = ['E11.9', 'E78.5', 'J45.9', 'J06.9', 'J02.9', 'J20.9', 'K29.7', 'K21.9', 'K59.0', 'M54.5', 'M17.9', 'N39.0', 'N20.0', 'R10.4', 'H10.9', 'H66.9', 'L23.9', 'L30.9', 'B34.9', 'A09.9', 'E03.9', 'E66.9', 'D50.9', 'I83.9', 'K80.2', 'K40.9', 'S93.4', 'S60.0', 'Z00.0', 'J30.4', 'J32.9', 'G43.9', 'M79.1']
decompose('CL_DIAGNOSTICO', [
  [String.raw`([A-TV-Za-tv-z]\d{2}\.\d{1,2})`, apply(lookup('CL_CIE10_DECIMAL', 'cl-cie10-decimal.txt', CIE10_DECIMAL, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [String.raw`([A-TV-Za-tv-z]\d{2,3})`, apply(lookup('CL_CIE10', 'cl-cie10.txt', CIE10, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [FLAG, apply('CL_BANDERA')],
], apply(lookup('CL_DIAGNOSTICO_TEXTO', 'cl-diagnosticos.txt', ['Hipertensión arterial esencial', 'Diabetes mellitus tipo 2', 'Asma bronquial', 'Lumbago', 'Gastritis crónica', 'Rinofaringitis aguda', 'Infección urinaria', 'Migraña', 'Hipotiroidismo', 'Dislipidemia', 'Obesidad', 'Artrosis de rodilla', 'Bronquitis aguda', 'Faringitis aguda', 'Dermatitis de contacto', 'Otitis media', 'Esguince de tobillo', 'Conjuntivitis', 'Anemia ferropénica', 'Reflujo gastroesofágico', 'Síndrome de colon irritable', 'Tendinitis', 'Sinusitis aguda', 'Cefalea tensional', 'Insuficiencia venosa', 'Hernia inguinal', 'Litiasis renal', 'Colelitiasis', 'Resfrío común', 'Control de salud'])), 'F32.9')
domain('CL_L3_SALUD_DIAGNOSTICO', 'CL_DIAGNOSTICO',
  byName(['diagn[oó]stico[a-z_]*|diag|dx|cie_?10|cod(igo)?_?cie|cie|icd_?10|icd|patolog[ií]a[a-z_]*|enfermedad(es)?[a-z_]*|morbilidad|condicion_?(medica|salud|cronica)|problema_?salud|ges|hipotesis_?diagnostica|causa_?(licencia|muerte|defuncion|hospitalizacion|consulta)|motivo_?(consulta|hospitalizacion|licencia)|comorbilidad(es)?|antecedentes_?(medicos|morbidos|m[oó]rbidos|clinicos)|alergias?|condicion_?preexistente|preexistencias?', 0.85]),
  byPattern([[String.raw`[A-TV-Za-tv-z]\d{2}(\.\d{1,2}|\d)?`, 0.6]], { reject: 0.3 }))

const MEDICAMENTOS = ['Paracetamol', 'Ibuprofeno', 'Losartán', 'Enalapril', 'Metformina', 'Atorvastatina', 'Omeprazol', 'Levotiroxina', 'Amoxicilina', 'Salbutamol', 'Loratadina', 'Clorfenamina', 'Naproxeno', 'Ácido acetilsalicílico', 'Amlodipino', 'Hidroclorotiazida', 'Prednisona', 'Diclofenaco', 'Ketoprofeno', 'Metamizol', 'Cetirizina', 'Budesonida', 'Azitromicina', 'Cefadroxilo', 'Famotidina', 'Domperidona']
categorical('CL_MEDICAMENTO', 'cl-medicamentos.txt', MEDICAMENTOS, 'Sertralina 50 mg')
domain('CL_L3_SALUD_MEDICAMENTO', 'CL_MEDICAMENTO',
  byName(['medicamentos?|f[aá]rmacos?|principio_?activo|prescripci[oó]n|receta(_?medica)?|tratamiento(_?farmacologico)?|medication|drug(_?name)?|posologia', 0.85]),
  byList([['cl-detectar-medicamentos.txt', [...MEDICAMENTOS, 'sertralina', 'fluoxetina', 'escitalopram', 'quetiapina', 'clonazepam', 'alprazolam', 'litio', 'carbonato de litio', 'metilfenidato', 'risperidona', 'aripiprazol', 'tenofovir', 'efavirenz', 'dolutegravir', 'insulina', 'warfarina', 'levetiracetam', 'ácido valproico', 'naltrexona', 'misoprostol', 'levonorgestrel'], 0.7]], { reject: 0.3 }))

domain('CL_L3_SALUD_IDENTIFICADOR', 'CL_CM_ALFANUM',
  byName(
    ['ficha_?clinica|n(ro|um|umero)_?ficha|historia_?clinica|n(ro|um)_?historia|nhc|n(ro|um)_?episodio|n(ro|um)_?atencion|folio_?(atencion|urgencia|licencia|receta)|licencia_?medica|n(ro|um)_?licencia|folio_?lm|n(ro|um)_?interconsulta|n(ro|um)_?dau|n(ro|um|umero)_?biopsia|medical_?record_?number|mrn', 0.85],
    ['ficha|hc|episodio', 0.6],
  ))

domain('CL_L3_SALUD_TEXTO_CLINICO', 'CL_TEXTO_LIBRE',
  byName(['anamnesis|evoluci[oó]n(_?(medica|clinica))?|epicrisis|indicaciones(_?medicas)?|examen_?fisico|notas?_?clinicas?|informe_?(medico|clinico|alta)|resumen_?(alta|clinico)|observacion(es)?_?(medica|clinica)s?|hallazgos|interconsulta|historia_?enfermedad|plan_?tratamiento|clinical_?notes?|progress_?notes?', 0.85]),
  byType(STRING(30)))

domain('CL_L3_SALUD_RESULTADO_EXAMEN', 'CL_CM_ALFANUM',
  byName(
    ['resultado_?(examen|laboratorio|lab|test|pcr|antigeno|biopsia|imagen|vih|hiv|covid)|ex[aá]menes?_?(resultado|laboratorio)|vih|hiv|carga_?viral|cd4|glicemia|hemoglobina(_?glicosilada)?|colesterol|presion_?arterial|imc|test_?(covid|embarazo|vih|drogas)|lab_?result', 0.8],
    ['resultado|examen', 0.5],
  ))

const GRUPOS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']
lookup('CL_GRUPO_SANGUINEO', 'cl-grupo-sanguineo.txt', GRUPOS, 'O+', 'PRESERVE_LOOKUP_FILE')
domain('CL_L3_SALUD_GRUPO_SANGUINEO', 'CL_GRUPO_SANGUINEO',
  byName(['grupo_?sangu[ií]neo|grupo_?sang|tipo_?(de_?)?sangre|tipo_?sanguineo|factor_?rh|rh|blood_?type|blood_?group', 0.9]),
  byList([['cl-detectar-grupo-sanguineo.txt', [...GRUPOS, '0+', '0-', 'a rh+', 'a rh-', 'b rh+', 'b rh-', 'ab rh+', 'ab rh-', 'o rh+', 'o rh-', 'a positivo', 'a negativo', 'b positivo', 'b negativo', 'ab positivo', 'ab negativo', 'o positivo', 'o negativo', 'orh+', 'orh-'], 0.9]], { reject: 0.4 }))

const DISCAPACIDADES = ['Física', 'Visual', 'Auditiva', 'Intelectual', 'Psíquica', 'Múltiple', 'Visceral', 'Sin discapacidad']
categorical('CL_DISCAPACIDAD', 'cl-discapacidad.txt', DISCAPACIDADES, 'Psíquica severa')
domain('CL_L3_SALUD_DISCAPACIDAD', 'CL_DISCAPACIDAD',
  byName(['discapacidad[a-z_]*|grado_?discapacidad|credencial_?discapacidad|invalidez|porcentaje_?invalidez|rnd|registro_?nacional_?discapacidad|disability|dependencia_?(severa|moderada|funcional)|necesidades_?educativas_?especiales|nee|pension_?invalidez', 0.9]),
  byList([['cl-detectar-discapacidad.txt', [...DISCAPACIDADES, 'fisica', 'psiquica', 'mental', 'sensorial', 'leve', 'moderada', 'severa', 'profunda', 'ninguna'], 0.6]], { reject: 0.3 }))

// Reproductive and mental health, sexual life, union and professional affiliation: the values
// have no shared vocabulary, so they are suppressed (flags and numeric codes keep their shape).
domain('CL_L3_SALUD_SEXUAL_REPRODUCTIVA', 'CL_CATEGORIA_SUPRIMIDA',
  byName(['embarazo|embarazada|gestaci[oó]n|semanas_?gestacion|edad_?gestacional|fecha_?ultima_?regla|fur|aborto|ive|interrupcion_?(voluntaria_?)?(del_?)?embarazo|anticonceptivos?|metodo_?anticonceptivo|fertilidad|infertilidad|reproduccion_?asistida|paridad|gestas|partos|cesarea|its|ets|infeccion_?transmision_?sexual|pregnan[a-z]*|contracepti[a-z]*', 0.9]))

domain('CL_L3_SALUD_MENTAL_ADICCIONES', 'CL_CATEGORIA_SUPRIMIDA',
  byName(['salud_?mental|psiquiatri[a-z]*|psicologi[a-z]*|trastorno[a-z_]*|depresi[oó]n|ansiedad|suicid[a-z]*|autolesi[oó]n|adicci[oó]n(es)?|consumo_?(de_?)?(drogas|alcohol|sustancias)|alcoholismo|drogadiccion|dependencia_?(alcohol|drogas)|senda|tratamiento_?(adicciones|drogas|alcohol)|mental_?health|substance_?(use|abuse)', 0.9]))

domain('CL_L3_BIOMETRICO', 'CL_REDACTAR',
  byName(['huella(_?(dactilar|digital))?|dactilar|biometri[a-z_]*|template_?(facial|biometrico|huella)|rostro|reconocimiento_?facial|facial_?(template|id)|iris|retina|voz_?(huella|biometrica)|firma_?(digitalizada|biometrica|manuscrita)|fingerprint|face_?(id|template|encoding)|palm_?print', 0.9]),
  byType(STRING()))

domain('CL_L3_PERFIL_GENETICO', 'CL_REDACTAR',
  byName(['adn|dna|genoma|genotipo|genetic[a-z_]*|gen[eé]tica|secuencia_?genetica|marcador_?genetico|perfil_?(genetico|biologico)|mutacion(_?genetica)?|snp|brca|haplotipo|cariotipo', 0.9]))

const ORIENTACIONES = ['Heterosexual', 'Homosexual', 'Lesbiana', 'Gay', 'Bisexual', 'Pansexual', 'Asexual', 'Otra', 'Prefiere no responder']
categorical('CL_ORIENTACION_SEXUAL', 'cl-orientacion-sexual.txt', ORIENTACIONES, 'Bisexual')
domain('CL_L3_ORIENTACION_SEXUAL', 'CL_ORIENTACION_SEXUAL',
  byName(['orientaci[oó]n_?sexual|sexual_?orientation|orient_?sexual', 0.95]),
  byList([['cl-detectar-orientacion-sexual.txt', [...ORIENTACIONES, 'hetero', 'homo', 'queer', 'no responde', 'straight', 'lesbian'], 0.8]], { reject: 0.4 }))

const IDENTIDADES = ['Mujer', 'Hombre', 'Mujer trans', 'Hombre trans', 'No binario', 'Género fluido', 'Otra', 'Prefiere no responder']
categorical('CL_IDENTIDAD_GENERO', 'cl-identidad-genero.txt', IDENTIDADES, 'Hombre trans')
domain('CL_L3_IDENTIDAD_GENERO', 'CL_IDENTIDAD_GENERO',
  byName(['identidad_?(de_?)?g[eé]nero|gender_?identity|g[eé]nero_?(identidad|social|autopercibido)|transg[eé]nero|transexual|cambio_?(de_?)?sexo_?registral|rectificacion_?(de_?)?sexo|pronombres?', 0.95]),
  byList([['cl-detectar-identidad-genero.txt', [...IDENTIDADES, 'cisgénero', 'transgénero', 'no binaria', 'no binarie', 'trans', 'femenino', 'masculino'], 0.7]], { reject: 0.4 }))

domain('CL_L3_VIDA_SEXUAL', 'CL_CATEGORIA_SUPRIMIDA',
  byName(['vida_?sexual|conducta_?sexual|actividad_?sexual|parejas?_?sexuales?|practicas_?sexuales|sexual_?(activity|behavior|history)|historia_?sexual|comportamiento_?sexual', 0.9]))

const RELIGIONES = ['Católica', 'Evangélica o protestante', 'Testigo de Jehová', 'Santos de los Últimos Días', 'Judía', 'Musulmana', 'Ortodoxa', 'Budista', 'Hinduista', "Fe Bahá'í", 'Otra religión o credo', 'Ninguna religión o credo']
categorical('CL_RELIGION', 'cl-religiones.txt', RELIGIONES, 'Evangélica')
domain('CL_L3_RELIGION', 'CL_RELIGION',
  byName(['religi[oó]n[a-z_]*|credo|confesion_?religiosa|culto|iglesia|creencia_?religiosa|religious_?affiliation|denominacion_?religiosa|comunidad_?religiosa', 0.95]),
  byList([['cl-detectar-religiones.txt', [...RELIGIONES, 'católico', 'catolica', 'evangélico', 'evangélica', 'cristiano', 'cristiana', 'protestante', 'pentecostal', 'mormón', 'judío', 'musulmán', 'islam', 'ortodoxo', 'budismo', 'ateo', 'atea', 'agnóstico', 'agnóstica', 'ninguna', 'sin religión', 'otra'], 0.9]], { reject: 0.4 }))

const IDEOLOGIAS = ['Izquierda', 'Centroizquierda', 'Centro', 'Centroderecha', 'Derecha', 'Independiente', 'Sin identificación política', 'Prefiere no responder']
categorical('CL_IDEOLOGIA', 'cl-ideologias.txt', IDEOLOGIAS, 'Centroderecha')
domain('CL_L3_CONVICCION_IDEOLOGICA', 'CL_IDEOLOGIA',
  byName(['ideolog[ií]a|convicci[oó]n(es)?(_?(ideologica|filosofica|politica)s?)?|posicion_?politica|postura_?politica|tendencia_?politica|orientacion_?politica|pensamiento_?politico|creencias?|filosofia_?de_?vida|political_?(view|orientation|opinion)', 0.9]),
  byList([['cl-detectar-ideologias.txt', [...IDEOLOGIAS, 'centro izquierda', 'centro derecha', 'liberal', 'conservador', 'progresista', 'ninguna'], 0.7]], { reject: 0.4 }))

const PARTIDOS = ['Partido Demócrata Cristiano', 'Partido por la Democracia', 'Partido Radical de Chile', 'Partido Socialista de Chile', 'Federación Regionalista Verde Social', 'Partido Liberal de Chile', 'Partido de la Gente', 'Evolución Política', 'Partido Comunista de Chile', 'Unión Demócrata Independiente', 'Renovación Nacional', 'Frente Amplio', 'Partido Nacional Libertario', 'Partido Republicano', 'Independiente']
categorical('CL_PARTIDO_POLITICO', 'cl-partidos.txt', PARTIDOS, 'Renovación Nacional')
domain('CL_L3_AFILIACION_POLITICA', 'CL_PARTIDO_POLITICO',
  byName(['partido(_?pol[ií]tico)?|militancia|militante|afiliaci[oó]n_?(politica|partidaria|partido)|afiliado_?partido|political_?party|party_?affiliation|coalici[oó]n|sector_?politico', 0.95]),
  byList([['cl-detectar-partidos.txt', [...PARTIDOS, 'PDC', 'PPD', 'PR', 'PS', 'FRVS', 'PL', 'PDG', 'EVOPOLI', 'EVÓPOLI', 'PC', 'PCCh', 'UDI', 'RN', 'FA', 'PNL', 'PRep', 'Partido Humanista', 'Partido Ecologista Verde', 'Revolución Democrática', 'Convergencia Social', 'Comunes', 'Demócratas', 'Amarillos por Chile', 'Partido Social Cristiano', 'Partido Igualdad', 'Acción Humanista', 'Partido Cristiano de Chile', 'independiente', 'sin militancia'], 0.8]], { reject: 0.4 }))

domain('CL_L3_AFILIACION_SINDICAL', 'CL_CATEGORIA_SUPRIMIDA',
  byName(['sindicato[a-z_]*|sindical|sindicalizado|afiliaci[oó]n_?sindical|socio_?sindicato|cuota_?sindical|dirigente_?sindical|federacion_?sindical|union_?member(ship)?|trade_?union|negociacion_?colectiva', 0.95]))

domain('CL_L3_AFILIACION_GREMIAL', 'CL_CATEGORIA_SUPRIMIDA',
  byName(['gremio|gremial|asociacion_?gremial|colegio_?profesional|afiliacion_?gremial|colegiatura|n(ro|um)_?colegiatura|colegio_?de_?(medicos|abogados|profesores|ingenieros|enfermeras|psicologos|arquitectos|contadores)|professional_?association|asociacion_?(de_?)?funcionarios', 0.9]))

// ── L3 · Socioeconomic situation ────────────────────────────────────────────
//
// Sensitive under Ley 21.719 and absent from GDPR-based templates: health insurance tier,
// Registro Social de Hogares, state benefits, commercial debt, pension fund, housing, student aid.

const PREVISIONES = ['FONASA A', 'FONASA B', 'FONASA C', 'FONASA D', 'Isapre Banmédica', 'Isapre Colmena', 'Isapre Consalud', 'Isapre Cruz Blanca', 'Isapre Vida Tres', 'Isapre Nueva Masvida', 'Isapre Esencial', 'Isapre Fundación', 'Isapre Cruz del Norte', 'Isalud', 'Capredena', 'Dipreca', 'Particular', 'Sin previsión']
const TRAMO_FONASA = lookup('CL_TRAMO_FONASA', 'cl-tramo-fonasa.txt', ['A', 'B', 'C', 'D'])
decompose('CL_PREVISION_SALUD', [
  ['([A-Da-d])', apply(TRAMO_FONASA)],
  [String.raw`(?i)(fonasa\s*[\-:]?\s*(?:tramo\s*)?)([A-D])`, keep, apply(TRAMO_FONASA)],
  [FLAG, apply('CL_BANDERA')],
], apply(lookup('CL_PREVISION_SALUD_LISTA', 'cl-prevision-salud.txt', PREVISIONES)), 'FONASA B')
domain('CL_L3_SOCIOEC_PREVISION_SALUD', 'CL_PREVISION_SALUD',
  byName(
    ['tramo_?fonasa|fonasa|grupo_?fonasa|tramo_?salud|previsi[oó]n_?(de_?)?salud|isapre|institucion_?(de_?)?salud_?previsional|sistema_?(de_?)?salud|seguro_?salud|health_?insurance|capredena|dipreca', 0.95],
    ['previsi[oó]n', 0.6],
  ),
  byList([
    ['cl-detectar-prevision-salud.txt', [...PREVISIONES, 'fonasa', 'tramo a', 'tramo b', 'tramo c', 'tramo d', 'banmédica', 'colmena', 'consalud', 'cruz blanca', 'cruzblanca', 'vida tres', 'nueva masvida', 'masvida', 'esencial', 'fundación', 'cruz del norte', 'isapre', 'prais', 'ninguna', 'sin previsión'], 0.8],
    // The bare tier letter backs up the column name but is far too common to decide on its own.
    ['cl-detectar-tramo-fonasa.txt', ['a', 'b', 'c', 'd'], 0.3],
  ], { reject: 0.4 }))

domain('CL_L3_SOCIOEC_PLAN_SALUD', 'CL_CM_ALFANUM',
  byName(['plan_?(isapre|salud|de_?salud)|cod(igo)?_?plan_?(isapre|salud)?|precio_?plan|valor_?plan|cotizacion_?(pactada|salud|isapre|adicional)|uf_?plan|excedente_?cotizacion|cotizacion_?7', 0.85]))

decompose('CL_RSH', [
  [String.raw`(\d{1,3})(\s*%)`, apply(lookup('CL_RSH_TRAMO_NUMERO', 'cl-rsh-tramo-numero.txt', ['40', '50', '60', '70', '80', '90', '100'])), keep],
  [String.raw`(?i)(tramo\s*)(\d{1,3})(.*)`, keep, apply('CL_RSH_TRAMO_NUMERO'), keep],
  [String.raw`(\d{1,3})`, apply('CL_RSH_TRAMO_NUMERO')],
  [FLAG, apply('CL_BANDERA')],
], apply(lookup('CL_RSH_TRAMO_TEXTO', 'cl-rsh-tramo-texto.txt', ['Tramo 40%', 'Tramo 50%', 'Tramo 60%', 'Tramo 70%', 'Tramo 80%', 'Tramo 90%', 'Tramo 100%'])), 'Tramo 40%')
domain('CL_L3_SOCIOEC_RSH', 'CL_RSH',
  byName(['rsh|registro_?social_?(de_?)?hogares|calificaci[oó]n_?socioecon[oó]mica|cse|tramo_?(rsh|socioeconomico|cse|registro_?social)|percentil_?(rsh|socioeconomico|vulnerabilidad)|ficha_?proteccion_?social|fps|puntaje_?(fps|ficha|cas|rsh)|ficha_?cas|indice_?vulnerabilidad|ivm|vulnerabilidad(_?social)?|situacion_?socioeconomica', 0.95]))

decompose('CL_NIVEL_SOCIOECONOMICO', [
  [String.raw`(\d{1,2})`, apply(lookup('CL_QUINTIL', 'cl-quintil.txt', ['1', '2', '3', '4', '5']))],
], apply(lookup('CL_GSE', 'cl-gse.txt', ['ABC1', 'C1a', 'C1b', 'C2', 'C3', 'D', 'E'], undefined, 'PRESERVE_LOOKUP_FILE')), 'C2')
domain('CL_L3_SOCIOEC_NIVEL', 'CL_NIVEL_SOCIOECONOMICO',
  byName(['nse|gse|grupo_?socioeconomico|estrato_?socioeconomico|nivel_?socioeconomico|quintil(_?(de_?)?ingresos?)?|decil(_?(de_?)?ingresos?)?|clase_?social', 0.9]),
  byList([['cl-detectar-gse.txt', ['abc1', 'c1', 'c1a', 'c1b', 'c2', 'c3', 'd', 'e', 'ab'], 0.5]], { reject: 0.3 }))

const BENEFICIOS = ['Pensión Garantizada Universal', 'Subsidio Único Familiar', 'Asignación Familiar', 'Aporte Familiar Permanente', 'Bono de Invierno', 'Bono Bodas de Oro', 'Bono por Hijo', 'Ingreso Ético Familiar', 'Subsistema Seguridades y Oportunidades', 'Chile Solidario', 'Subsidio Eléctrico', 'Subsidio al Agua Potable', 'Bolsillo Familiar Electrónico', 'Pensión de Invalidez', 'Aporte Previsional Solidario', 'Bono Logro Escolar', 'Bono Control Niño Sano', 'Chile Crece Contigo', 'Chile Cuida', 'Programa de Alimentación Escolar', 'Ninguno']
categorical('CL_BENEFICIO_SOCIAL', 'cl-beneficios-sociales.txt', BENEFICIOS, 'PGU')
domain('CL_L3_SOCIOEC_BENEFICIO_SOCIAL', 'CL_BENEFICIO_SOCIAL',
  byName(['beneficio(s|_?social|_?estatal)?|beneficiario_?(programa|beneficio|subsidio|bono|pgu|pbs|suf)|programa_?(social|estatal|gobierno)|subsidio(?!_?(habitacional|arriendo|vivienda|ds))[a-z_]*|bono(?!_?(produccion|desempeno|anual|gestion|termino|vacaciones|trabajador|colacion|movilizacion))[a-z_]*|pgu|pbs|aps|suf|ife|ief|ingreso_?etico_?familiar|chile_?solidario|seguridades_?(y_?)?oportunidades|aporte_?familiar_?permanente|bolsillo_?familiar|asignacion_?familiar|pension_?(basica|garantizada|asistencial|solidaria)|pasis|chile_?cuida|chile_?crece|bono_?invierno|junaeb|pae', 0.9]),
  byList([['cl-detectar-beneficios.txt', [...BENEFICIOS, 'pgu', 'suf', 'pbs', 'aps', 'ief', 'ife', 'ife universal', 'bono marzo', 'bono invierno', 'pasis', 'subsidio familiar', 'pensión básica solidaria', 'aporte previsional solidario de vejez', 'ninguno'], 0.8]], { reject: 0.4 }))

const ESTADOS_CREDITICIOS = ['Al día', 'Mora 1 a 30 días', 'Mora 31 a 90 días', 'Mora sobre 90 días', 'Repactado', 'Castigado', 'Protestado', 'Sin información']
categorical('CL_MOROSIDAD', 'cl-estado-crediticio.txt', ESTADOS_CREDITICIOS, 'Moroso DICOM')
domain('CL_L3_SOCIOEC_MOROSIDAD', 'CL_MOROSIDAD',
  byName(['dicom|boletin_?comercial|morosidad|moroso|morosa|deuda_?morosa|protestos?|deudor_?moroso|score_?(crediticio|credito|riesgo|equifax|dicom)|puntaje_?(crediticio|riesgo|credito)|clasificacion_?(de_?)?(riesgo|crediticia|deudor)|riesgo_?crediticio|equifax|sinacofi|transunion|informe_?comercial|cartera_?vencida|castigo|dias_?(de_?)?mora|tramo_?mora|estado_?(deuda|credito|crediticio|morosidad)|credit_?score|delinquen[a-z]*|repactacion|renegociacion|quiebra|insolvencia|liquidacion_?voluntaria|reorganizacion_?(de_?)?deudor', 0.9]))

algorithm('CL_MONTO_DEUDA', 'characterMapping.NumericMapping', { minValue: 10000, maxValue: 50000000 }, '1250000')
domain('CL_L3_SOCIOEC_MONTO_DEUDA', 'CL_MONTO_DEUDA',
  byName(['monto_?(deuda|moroso|mora|adeudado|castigado|protestado|vencido)|deuda(_?(total|vigente|vencida|consolidada))?|saldo_?(deuda|adeudado|insoluto|moroso|vencido)|total_?adeudado|monto_?protesto|debt(_?amount)?|outstanding_?balance', 0.85]),
  byType(NUMBER()))

algorithm('CL_MONTO_INGRESO', 'characterMapping.NumericMapping', { minValue: 450000, maxValue: 8000000 }, '985000')
domain('CL_L3_SOCIOEC_INGRESOS', 'CL_MONTO_INGRESO',
  byName(['sueldo[a-z_]*|salario[a-z_]*|remuneraci[oó]n[a-z_]*|renta(_?(imponible|liquida|bruta|mensual|anual|promedio|declarada|familiar|hogar|per_?capita))?|ingreso_?(mensual|liquido|bruto|familiar|hogar|per_?capita|total|promedio|declarado|autonomo|laboral)|ingresos(_?[a-z]+)?|haberes|liquido_?a_?pagar|imponible|total_?haberes|salary|wage|income|gross_?pay|net_?pay|patrimonio|avaluo_?fiscal|capacidad_?(de_?)?pago|gastos_?mensuales', 0.85]),
  byType(NUMBER()))

const AFPS = ['AFP Capital', 'AFP Cuprum', 'AFP Habitat', 'AFP Modelo', 'AFP PlanVital', 'AFP ProVida', 'AFP Uno', 'IPS', 'Capredena', 'Dipreca', 'Sin previsión']
categorical('CL_AFP', 'cl-afp.txt', AFPS, 'AFP Modelo')
domain('CL_L3_SOCIOEC_PREVISION_AFP', 'CL_AFP',
  byName(['afp|nombre_?afp|cod(igo)?_?afp|administradora_?(de_?)?fondos(_?de_?pensiones)?|institucion_?previsional|prevision_?social|entidad_?previsional|ips|inp|caja_?(de_?)?prevision|regimen_?previsional|sistema_?previsional|pension_?fund', 0.95]),
  byList([['cl-detectar-afp.txt', [...AFPS, 'capital', 'cuprum', 'habitat', 'hábitat', 'modelo', 'planvital', 'plan vital', 'provida', 'uno', 'inp', 'ex inp', 'ips (ex inp)'], 0.9]], { reject: 0.4 }))

algorithm('CL_MONTO_PREVISIONAL', 'characterMapping.NumericMapping', { minValue: 100000, maxValue: 250000000 }, '38500000')
domain('CL_L3_SOCIOEC_SALDO_PREVISIONAL', 'CL_MONTO_PREVISIONAL',
  byName(['saldo_?(afp|cuenta_?individual|cotizaciones|previsional|obligatorio|apv|cuenta_?2|fondo)|fondo_?(de_?)?(pensiones|previsional)|cotizaci[oó]n(es)?_?(afp|previsional|obligatoria|pension)|monto_?pension|pension_?(monto|mensual|autofinanciada)|apv|apvc|cuenta_?2|bono_?reconocimiento|renta_?vitalicia|retiro_?programado|pension_?amount|retirement_?balance', 0.9]),
  byType(NUMBER()))

const VIVIENDAS = ['Propia pagada', 'Propia pagándose', 'Arrendada con contrato', 'Arrendada sin contrato', 'Cedida por familiar', 'Cedida por trabajo', 'Usufructo', 'Allegado', 'Ocupación irregular', 'Campamento']
categorical('CL_VIVIENDA', 'cl-vivienda.txt', VIVIENDAS, 'Allegado')
domain('CL_L3_SOCIOEC_VIVIENDA', 'CL_VIVIENDA',
  byName(['tipo_?vivienda|tenencia_?(de_?)?(la_?)?vivienda|situacion_?(habitacional|vivienda)|vivienda_?(propia|arrendada|cedida)|allegad[oa]s?|allegamiento|hacinamiento|campamento|toma_?terreno|subsidio_?(habitacional|ds1|ds49|ds19|arriendo|vivienda)|ds_?49|ds_?1|comite_?vivienda|deficit_?habitacional|material_?vivienda|housing_?(type|tenure|status)|dividendo_?hipotecario', 0.95]),
  byList([['cl-detectar-vivienda.txt', [...VIVIENDAS, 'propia', 'arrendada', 'arriendo', 'cedida', 'allegada', 'toma', 'mediagua'], 0.6]], { reject: 0.3 }))

const APOYOS_ESTUDIO = ['Gratuidad', 'Beca Bicentenario', 'Beca Juan Gómez Millas', 'Beca Nuevo Milenio', 'Beca Excelencia Académica', 'Beca Vocación de Profesor', 'Crédito con Aval del Estado', 'Fondo Solidario de Crédito Universitario', 'Beca de Alimentación', 'Beca Presidente de la República', 'Beca Indígena', 'Sin beneficio']
categorical('CL_FINANCIAMIENTO_ESTUDIOS', 'cl-financiamiento-estudios.txt', APOYOS_ESTUDIO, 'CAE')
domain('CL_L3_SOCIOEC_FINANCIAMIENTO_ESTUDIOS', 'CL_FINANCIAMIENTO_ESTUDIOS',
  byName(['beca[a-z_]*|gratuidad|credito_?(cae|aval_?del_?estado|universitario|fscu|corfo)|cae|fscu|fuas|beneficio_?estudiantil|arancel_?(diferenciado|referencia)|tne|beneficio_?(mineduc|arancel)|scholarship|student_?loan|financiamiento_?(de_?)?estudios|deuda_?(cae|universitaria)', 0.9]),
  byList([['cl-detectar-financiamiento-estudios.txt', [...APOYOS_ESTUDIO, 'cae', 'fscu', 'baes', 'bjgm', 'bnm', 'bvp', 'beca', 'sin beneficio'], 0.7]], { reject: 0.3 }))

// ── L3 · Criminal records ───────────────────────────────────────────────────

categorical('CL_ANTECEDENTES', 'cl-antecedentes.txt', ['Sin antecedentes', 'Con antecedentes', 'Sin información'], 'Condenado por robo')
domain('CL_L3_PENAL_ANTECEDENTES', 'CL_ANTECEDENTES',
  byName(['antecedentes(?!_?(medicos|morbidos|m[oó]rbidos|familiares|clinicos|academicos|laborales|comerciales|generales))(_?(penales|judiciales|policiales|criminales))?|certificado_?antecedentes|condenas?|condenad[oa]|delitos?|tipo_?delito|prontuario|reincidente|reincidencia|imputad[oa]|formalizad[oa]|sentencia(_?condenatoria)?|pena|privacion_?(de_?)?libertad|libertad_?condicional|inhabilidad(es)?|registro_?(de_?)?inhabilidades|inhabilitad[oa]|criminal_?record|conviction|offen[cs]e|detenid[oa]|detencion|orden_?(de_?)?detencion|medida_?cautelar|violencia_?intrafamiliar|vif|causa_?penal', 0.95]))

domain('CL_L3_PENAL_CAUSA', 'CL_CM_ALFANUM',
  byName(['rol_?causa|rit|ruc|rol_?(tribunal|judicial)|n(ro|um|umero)_?causa|causa_?rol|rol_?unico_?(de_?)?causa|parte_?policial|n(ro|um)_?parte|folio_?(parte|denuncia)|n(ro|um|umero)_?denuncia|expediente(_?(judicial|penal))?|case_?number', 0.9]),
  byPattern([[String.raw`[A-Za-z]{1,3}-\d{1,6}-\d{4}`, 0.8], [String.raw`\d{10}-[\dkK]`, 0.8]], { reject: 0.3 }))

// ── Preset ──────────────────────────────────────────────────────────────────

const orphans = algorithms.filter((a) => {
  const referenced = JSON.stringify([domains, algorithms.map((x) => x.config)])
  return !referenced.includes(`"${a.name}"`)
})
if (orphans.length) throw new Error(`algorithms nobody uses: ${orphans.map((a) => a.name).join(', ')}`)

const preset = {
  version: 1,
  name: {
    en: 'Chile — Law 21.719 (personal data protection)',
    'pt-BR': 'Chile — Lei 21.719 (proteção de dados pessoais)',
    es: 'Chile — Ley 21.719 (protección de datos personales)',
  },
  summary: {
    en: 'Discovers and masks Chilean personal data in three layers: direct identifiers (RUT with a valid check digit, names, contact, documents), quasi-identifiers (birth date, comuna, age) and the sensitive categories of article 2, including socioeconomic situation.',
    'pt-BR': 'Descobre e mascara dados pessoais chilenos em três camadas: identificadores diretos (RUT com dígito verificador válido, nomes, contato, documentos), quase-identificadores (data de nascimento, comuna, idade) e as categorias sensíveis do artigo 2, incluindo situação socioeconômica.',
    es: 'Descubre y enmascara datos personales chilenos en tres capas: identificadores directos (RUT con dígito verificador válido, nombres, contacto, documentos), cuasi-identificadores (fecha de nacimiento, comuna, edad) y las categorías sensibles del artículo 2, incluida la situación socioeconómica.',
  },
  profileSet: {
    name: 'CL - Ley 21.719 - Datos personales',
    description: 'Identificadores directos, cuasi-identificadores y datos sensibles (art. 2 g) de la Ley 21.719.',
    threshold: 60,
    classifiers: classifiers.map((c) => c.name),
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
