#!/usr/bin/env node
/**
 * Checks the Costa Rica (Ley 8968) preset.
 *
 *   node presets/costarica-ley-8968/verify.mjs               # classifiers, then algorithms
 *   node presets/costarica-ley-8968/verify.mjs classifiers    # only the local profiling check
 *   node presets/costarica-ley-8968/verify.mjs algorithms     # only masking, against the app
 *
 * Classifiers run through classifiers/, the same evaluator the classifier test uses: every
 * configuration is reviewed, then a battery of columns — well named, badly named and unrelated —
 * is profiled with the whole set at its threshold. The table that generalizes distritos and the
 * one that generalizes their codes are audited offline. Algorithms run in the app (DLPX_URL,
 * default http://localhost:3000), which needs the Delphix jars in lib/; every IBAN they write is
 * checked against the ISO 13616 remainder.
 */
import fs from 'node:fs'
import nodePath from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = nodePath.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const kit = require('../../classifiers')
const preset = JSON.parse(fs.readFileSync(nodePath.join(HERE, 'preset.json'), 'utf8'))
const FILES_URL = `${pathToFileURL(nodePath.join(HERE, 'files')).href}/`
const resolve = (config) => JSON.parse(JSON.stringify(config).replaceAll('preset-file://', FILES_URL))
const API = process.env.DLPX_URL ?? 'http://localhost:3000'
const only = process.argv[2]
let failures = 0

// ── The IBAN remainder ──────────────────────────────────────────────────────
//
// ISO 13616: move `CRkk` to the end, read C as 12 and R as 27, and the number is valid when it
// leaves a remainder of 1 modulo 97. The BCCR's own example, CR05 0152 0200 1026 2840 66, does.
const ibanRemainder = (compact) => {
  let r = 0
  for (const c of `${compact.slice(4)}1227${compact.slice(2, 4)}`) r = (r * 10 + Number(c)) % 97
  return r
}
const validIban = (value) => {
  const compact = value.replace(/\s/g, '')
  return /^CR\d{20}$/.test(compact) && ibanRemainder(compact) === 1
}

// ── Test data ───────────────────────────────────────────────────────────────

let seed = 8968
const random = () => {
  seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
const pick = (list) => list[Math.floor(random() * list.length)]
const many = (make, n = 40) => Array.from({ length: n }, (_, i) => make(i))
const source = (name) => fs.readFileSync(nodePath.join(HERE, 'source', name), 'utf8').split('\n').filter(Boolean)
const GIVEN = source('nombres.txt')
const SURNAMES = source('apellidos.txt')
const BARRIOS = source('barrios.txt')
const PROVINCIAS = source('provincias.tsv').map((l) => {
  const [code, name, , , population] = l.split('\t')
  return { code, name, population: Number(population) }
})
const CANTONES = source('cantones.tsv').map((l) => {
  const [code, name, provinceCode, province, , , population] = l.split('\t')
  return { code, name, provinceCode, province, population: Number(population) }
})
const DISTRITOS = source('distritos.tsv').map((l) => {
  const [code, name, aliases, cantonCode, canton, provinceCode, province, , , population] = l.split('\t')
  return {
    code, name, aliases: aliases ? aliases.split(';') : [],
    cantonCode, canton, provinceCode, province,
    population: population ? Number(population) : null,
  }
})
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '')
const PERSONAL = new Set([...GIVEN, ...SURNAMES].map((w) => fold(w).toLowerCase()))
const PROVINCE_NAMES = new Set(PROVINCIAS.map((p) => fold(p.name).toLowerCase()))
const CANTON_NAMES = new Set(CANTONES.map((c) => fold(c.name).toLowerCase()))
const small = (place) => !(place.population >= 20000)
// Names a test column can use: small distritos that share nothing with a person, a provincia or a
// cantón, so the expected answer is unambiguous.
const SMALL_NAMES = DISTRITOS
  .filter((d) => small(d) && !PERSONAL.has(fold(d.name).toLowerCase()) && !PROVINCE_NAMES.has(fold(d.name).toLowerCase()) && !CANTON_NAMES.has(fold(d.name).toLowerCase()))
  .filter((d) => DISTRITOS.filter((x) => fold(x.name).toLowerCase() === fold(d.name).toLowerCase()).every(small))
  .map((d) => d.name)
const LARGE_NAMES = DISTRITOS.filter((d) => !small(d)).map((d) => d.name)

const pad = (n, w) => String(n).padStart(w, '0')
const digits = (n) => many(() => int(0, 9), n).join('')
const cedula = () => `${int(1, 7)}-${pad(int(0, 9999), 4)}-${pad(int(0, 9999), 4)}`
const cedulaPlain = () => `${int(1, 7)}${digits(8)}`
const dimex = () => pick([`${int(10, 19)}${digits(9)}`, `${int(10, 19)}${digits(10)}`])
const nite = () => `3-120-${digits(6)}`
const cedulaJuridica = () => `3-${pick(['101', '102', '002', '004', '006'])}-${digits(6)}`
const BANKS = ['0151', '0152', '0102', '0161', '0114', '0115', '0117']
const iban = (spaced = false) => {
  const body = `${pick(BANKS)}${digits(14)}`
  let r = 0
  for (const c of body) r = (r * 10 + Number(c)) % 97
  const compact = `CR${pad(98 - ((r * 27 + 92) % 97), 2)}${body}`
  return spaced ? compact.replace(/(.{4})/g, '$1 ').trim() : compact
}
const luhn = (prefix, length) => {
  const ds = [...prefix].map(Number)
  while (ds.length < length - 1) ds.push(int(0, 9))
  const sum = ds.slice().reverse().reduce((s, d, i) => s + (i % 2 === 0 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0)
  return ds.join('') + String((10 - (sum % 10)) % 10)
}
const iso = (y0, y1) => `${int(y0, y1)}-${pad(int(1, 12), 2)}-${pad(int(1, 28), 2)}`
const fullName = () => `${pick(GIVEN)}${random() < 0.4 ? ` ${pick(GIVEN)}` : ''} ${pick(SURNAMES)} ${pick(SURNAMES)}`
const phone = () => pick([`${int(2, 2)}${digits(3)} ${digits(4)}`, `+506 ${int(6, 8)}${digits(3)} ${digits(4)}`, `${int(6, 8)}${digits(7)}`, `4${digits(7)}`])
const LANDMARKS = ['la iglesia católica', 'el parque central', 'la escuela', 'el EBAIS', 'la plaza de deportes']
const address = () => pick([
  `${pick([100, 200, 300, 400, 500])} metros ${pick(['norte', 'sur', 'este', 'oeste'])} de ${pick(LANDMARKS)}, casa ${int(1, 90)}`,
  `Urbanización Los Laureles, casa ${int(1, 240)}`,
  `Avenida ${int(1, 40)}, Calle ${int(1, 60)}, casa esquinera`,
])
const letters = (n) => many(() => pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), n).join('')
const plate = () => pick([String(int(100000, 999999)), `${letters(3)}${int(100, 999)}`, `MOT${int(100000, 999999)}`])
const expediente = () => `${pad(int(10, 26), 2)}-${pad(int(1, 999999), 6)}-${pad(int(1, 9999), 4)}-${pick(['PE', 'CI', 'LA', 'FA'])}`
const folioReal = () => `${int(1, 7)}-${digits(6)}-${digits(3)}`

// ── Classifiers ─────────────────────────────────────────────────────────────

const SQL = { varchar: 12, char: 1, number: 2, integer: 4, date: 91, timestamp: 93, clob: 2005 }
const col = (name, type, length, values, expect) => ({ name, sqlType: SQL[type], length, values, expect })

const COLUMNS = [
  // L1 — well named
  col('NUMERO_CEDULA', 'varchar', 12, many(cedula), 'CR_L1_CEDULA'),
  col('CEDULA', 'varchar', 12, many(cedula), 'CR_L1_CEDULA'),
  col('CED_CLIENTE', 'varchar', 10, many(cedulaPlain), 'CR_L1_CEDULA'),
  col('IDENTIFICACION', 'varchar', 12, many(cedula), 'CR_L1_CEDULA'),
  col('DIMEX', 'varchar', 12, many(dimex), 'CR_L1_DIMEX'),
  col('NUMERO_RESIDENCIA', 'varchar', 12, many(dimex), 'CR_L1_DIMEX'),
  col('NITE', 'varchar', 12, many(nite), 'CR_L1_NITE'),
  col('PASAPORTE', 'varchar', 10, many(() => `${letters(1)}${int(1000000, 9999999)}`), 'CR_L1_PASAPORTE'),
  // A driving licence carries the cédula of its holder: same number, same domain.
  col('NUMERO_LICENCIA', 'varchar', 12, many(cedula), 'CR_L1_CEDULA'),
  col('NUMERO_ASEGURADO', 'varchar', 14, many(() => String(int(100000000, 999999999))), 'CR_L1_SEGURO_SOCIAL'),
  col('CODIGO_ESTUDIANTE', 'varchar', 12, many(() => `${int(2015, 2025)}${int(10000, 99999)}`), 'CR_L1_CODIGO_ESTUDIANTE'),
  col('NUMERO_COLEGIADO', 'varchar', 12, many(() => `MED-${int(1000, 9999)}`), 'CR_L1_MATRICULA_PROFESIONAL'),
  col('PRIMER_NOMBRE', 'varchar', 30, many(() => pick(GIVEN)), 'CR_L1_NOMBRE'),
  col('APELLIDO1', 'varchar', 30, many(() => pick(SURNAMES)), 'CR_L1_APELLIDO'),
  col('APELLIDOS', 'varchar', 60, many(() => `${pick(SURNAMES)} ${pick(SURNAMES)}`), 'CR_L1_APELLIDO'),
  col('NOMBRE_COMPLETO', 'varchar', 120, many(fullName), 'CR_L1_NOMBRE_COMPLETO'),
  col('NOMBRE_CLIENTE', 'varchar', 120, many(fullName), 'CR_L1_NOMBRE_COMPLETO'),
  col('NOMBRE', 'varchar', 120, many(fullName), 'CR_L1_NOMBRE_COMPLETO'),
  col('CORREO_ELECTRONICO', 'varchar', 100, many(() => `${fold(pick(GIVEN)).toLowerCase()}.${int(1, 999)}@gmail.com`), 'CR_L1_EMAIL'),
  col('EMAIL', 'varchar', 100, many(() => `contacto${int(1, 999)}@empresa.co.cr`), 'CR_L1_EMAIL'),
  col('TELEFONO', 'varchar', 16, many(phone), 'CR_L1_TELEFONO'),
  col('CELULAR', 'varchar', 16, many(() => `${int(6, 8)}${digits(7)}`), 'CR_L1_TELEFONO'),
  col('DIRECCION', 'varchar', 200, many(address), 'CR_L1_DIRECCION'),
  col('OTRAS_SENAS', 'varchar', 200, many(address), 'CR_L1_DIRECCION'),
  col('APARTADO_POSTAL', 'varchar', 20, many(() => `${int(1, 9999)}-${int(1000, 9999)}`), 'CR_L1_DIRECCION_COMPLEMENTO'),
  col('CUENTA_IBAN', 'varchar', 24, many(() => iban()), 'CR_L1_CUENTA_BANCARIA'),
  col('NUMERO_CUENTA', 'varchar', 24, many(() => iban()), 'CR_L1_CUENTA_BANCARIA'),
  col('NUMERO_TARJETA', 'varchar', 19, many(() => luhn('4', 16)), 'CR_L1_TARJETA'),
  col('BILLETERA_DIGITAL', 'varchar', 64, many(() => `bc1q${many(() => pick('023456789acdefghjklmnpqrstuvwxyz'), 38).join('')}`), 'CR_L1_BILLETERA'),
  col('IP_ORIGEN', 'varchar', 15, many(() => `${int(1, 223)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`), 'CR_L1_IP'),
  col('MAC_ADDRESS', 'varchar', 17, many(() => many(() => int(0, 255).toString(16).padStart(2, '0'), 6).join(':')), 'CR_L1_DISPOSITIVO'),
  col('IMEI', 'varchar', 15, many(() => luhn('35', 15)), 'CR_L1_DISPOSITIVO'),
  col('COOKIE_ID', 'varchar', 40, many(() => `GA1.2.${int(100000000, 999999999)}.${int(1600000000, 1799999999)}`), 'CR_L1_COOKIE'),
  col('PLACA_VEHICULO', 'varchar', 10, many(plate), 'CR_L1_PLACA'),
  col('NUMERO_CHASIS', 'varchar', 17, many(() => many(() => pick('ABCDEFGHJKLMNPRSTUVWXYZ0123456789'), 17).join('')), 'CR_L1_VEHICULO'),
  col('FOLIO_REAL', 'varchar', 16, many(folioReal), 'CR_L1_INMUEBLE'),
  col('NUMERO_CONTRATO', 'varchar', 12, many(() => `CT-${int(100000, 999999)}`), 'CR_L1_CONTRATO'),
  col('USUARIO', 'varchar', 30, many(() => `${fold(pick(GIVEN)).toLowerCase()}${int(1, 99)}`), 'CR_L1_USUARIO'),
  col('CONTRASENA', 'varchar', 60, many(() => `$2a$10$${many(() => pick('abcdefghijklmnopqrstuvwxyz0123456789'), 53).join('')}`), 'CR_L1_CREDENCIAL'),
  col('URL_FOTOGRAFIA', 'varchar', 200, many(() => `/fotos/persona_${int(1, 9999)}.jpg`), 'CR_L1_IMAGEN'),
  col('LATITUD', 'varchar', 12, many(() => `9.${int(100000, 999999)}`), 'CR_L1_GEOLOCALIZACION'),
  col('OBSERVACIONES', 'clob', 4000, many(() => `Cliente solicita actualizar datos. Cédula ${cedula()}, correo ${fold(pick(GIVEN)).toLowerCase()}@gmail.com.`), 'CR_L1_TEXTO_LIBRE'),

  // L1 — badly named: only the values can tell
  col('CAMPO1', 'varchar', 12, many(cedula), 'CR_L1_CEDULA'),
  col('CAMPO2', 'varchar', 30, many(() => pick(GIVEN)), 'CR_L1_NOMBRE'),
  col('CAMPO3', 'varchar', 30, many(() => pick(SURNAMES)), 'CR_L1_APELLIDO'),
  col('CAMPO4', 'varchar', 120, many(fullName), 'CR_L1_NOMBRE_COMPLETO'),
  col('CAMPO5', 'varchar', 100, many(() => `${fold(pick(GIVEN)).toLowerCase()}@hotmail.com`), 'CR_L1_EMAIL'),
  col('CAMPO6', 'varchar', 16, many(() => `${int(6, 8)}${digits(7)}`), 'CR_L1_TELEFONO'),
  col('CAMPO7', 'varchar', 200, many(address), 'CR_L1_DIRECCION'),
  col('CAMPO8', 'varchar', 19, many(() => luhn('5', 16)), 'CR_L1_TARJETA'),
  col('CAMPO9', 'varchar', 15, many(() => `192.168.${int(0, 255)}.${int(1, 254)}`), 'CR_L1_IP'),
  col('CAMPO10', 'varchar', 24, many(() => iban()), 'CR_L1_CUENTA_BANCARIA'),
  col('CAMPO11', 'varchar', 12, many(nite), 'CR_L1_NITE'),
  col('TXT', 'clob', 4000, many(() => `Paciente ${pick(GIVEN)} ${pick(SURNAMES)}, cédula ${cedula()}, cel ${int(6, 8)}${digits(7)}.`), 'CR_L1_TEXTO_LIBRE'),

  // L2
  col('FECHA_NACIMIENTO', 'date', 0, many(() => iso(1940, 2010)), 'CR_L2_FECHA_NACIMIENTO'),
  col('FEC_NAC', 'varchar', 10, many(() => iso(1940, 2010)), 'CR_L2_FECHA_NACIMIENTO'),
  col('fechaNacimiento', 'timestamp', 0, many(() => iso(1940, 2010)), 'CR_L2_FECHA_NACIMIENTO'),
  col('ANIO_NACIMIENTO', 'number', 4, many(() => String(int(1940, 2010))), 'CR_L2_ANIO_NACIMIENTO'),
  col('EDAD', 'number', 3, many(() => String(int(0, 99))), 'CR_L2_EDAD'),
  col('FECHA_DEFUNCION', 'date', 0, many(() => iso(2000, 2025)), 'CR_L2_FECHA_EVENTO'),
  col('FECHA_INGRESO', 'date', 0, many(() => iso(1990, 2025)), 'CR_L2_FECHA_EVENTO'),
  col('SEXO', 'char', 1, many(() => pick(['F', 'M'])), 'CR_L2_SEXO'),
  col('GENERO', 'varchar', 10, many(() => pick(['Femenino', 'Masculino'])), 'CR_L2_SEXO'),
  col('DISTRITO', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'CR_L2_DISTRITO'),
  col('CANTON', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'CR_L2_DISTRITO'),
  col('LUGAR_NACIMIENTO', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'CR_L2_DISTRITO'),
  col('CAMPO12', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'CR_L2_DISTRITO'),
  col('CODIGO_DISTRITO', 'varchar', 5, many(() => pick(DISTRITOS).code), 'CR_L2_CODIGO_DTA'),
  col('CODIGO_POSTAL', 'varchar', 5, many(() => pick(DISTRITOS).code), 'CR_L2_CODIGO_DTA'),
  col('BARRIO', 'varchar', 60, many(() => pick(BARRIOS)), 'CR_L2_BARRIO'),
  col('ESTADO_CIVIL', 'varchar', 30, many(() => pick(['Soltero', 'Casado', 'Unión libre', 'Viudo'])), 'CR_L2_ESTADO_CIVIL'),
  col('PROFESION', 'varchar', 60, many(() => pick(['Docente', 'Chofer', 'Enfermero'])), 'CR_L2_OCUPACION'),
  col('NOMBRE_PATRONO', 'varchar', 80, many(() => `Distribuidora ${int(1, 99)} S.A.`), 'CR_L2_EMPLEADOR'),
  col('ESCOLARIDAD', 'varchar', 40, many(() => pick(['Secundaria completa', 'Universitaria completa', 'Primaria completa'])), 'CR_L2_NIVEL_EDUCATIVO'),
  col('NOMBRE_COLEGIO', 'varchar', 80, many(() => `Colegio Técnico de ${pick(['Heredia', 'Cartago', 'Limón'])}`), 'CR_L2_INSTITUCION_EDUCATIVA'),
  col('PERSONAS_A_CARGO', 'number', 2, many(() => String(int(0, 8))), 'CR_L2_PERSONAS_A_CARGO'),

  // L3
  col('ETNIA', 'varchar', 60, many(() => pick(['Indígena', 'Afrodescendiente o negra', 'Mulata', 'Blanca o mestiza'])), 'CR_L3_ETNIA'),
  col('CAMPO13', 'varchar', 60, many(() => pick(['Indígena', 'Mulata', 'China', 'Otra'])), 'CR_L3_ETNIA'),
  col('PUEBLO_INDIGENA', 'varchar', 60, many(() => pick(['Bribri', 'Cabécar', 'Maleku', 'Ngäbe'])), 'CR_L3_PUEBLO_INDIGENA'),
  col('NACIONALIDAD', 'varchar', 20, many(() => pick(['Costarricense', 'Nicaragüense', 'Colombiana'])), 'CR_L3_NACIONALIDAD'),
  col('CONDICION_MIGRATORIA', 'varchar', 40, many(() => pick(['Residente permanente', 'Solicitante de refugio', 'Categoría especial'])), 'CR_L3_CONDICION_MIGRATORIA'),
  col('RELIGION', 'varchar', 40, many(() => pick(['Católica', 'Evangélica o protestante', 'Sin religión'])), 'CR_L3_RELIGION'),
  col('OBJECION_CONCIENCIA', 'varchar', 60, many(() => pick(['Transfusiones', 'Ninguna'])), 'CR_L3_CONVICCION_FILOSOFICA'),
  col('INTENCION_VOTO', 'varchar', 40, many(() => pick(['Izquierda', 'Derecha', 'Centro'])), 'CR_L3_OPINION_POLITICA'),
  col('PARTIDO_POLITICO', 'varchar', 60, many(() => pick(['Liberación Nacional', 'Unidad Social Cristiana', 'Frente Amplio'])), 'CR_L3_AFILIACION_PARTIDARIA'),
  col('CUOTA_SINDICAL', 'char', 1, many(() => pick(['S', 'N'])), 'CR_L3_AFILIACION_SINDICAL'),
  col('HUELLA_DACTILAR', 'varchar', 200, many(() => many(() => pick('ABCDEF0123456789'), 64).join('')), 'CR_L3_BIOMETRICO'),
  col('PRUEBA_ADN', 'varchar', 200, many(() => 'AGTC'.repeat(10)), 'CR_L3_GENETICO'),
  col('ORIENTACION_SEXUAL', 'varchar', 30, many(() => pick(['Heterosexual', 'Gay', 'Bisexual'])), 'CR_L3_ORIENTACION_SEXUAL'),
  col('VIDA_SEXUAL_ACTIVA', 'char', 1, many(() => pick(['S', 'N'])), 'CR_L3_VIDA_SEXUAL'),
  col('IDENTIDAD_GENERO', 'varchar', 30, many(() => pick(['Mujer trans', 'Hombre cisgénero'])), 'CR_L3_IDENTIDAD_GENERO'),
  col('VICTIMA_VIOLENCIA', 'char', 1, many(() => pick(['S', 'N'])), 'CR_L3_VICTIMA'),

  // SALUD
  col('EXPEDIENTE_CLINICO', 'varchar', 14, many(() => String(int(100000, 9999999))), 'CR_SALUD_IDENTIFICADOR'),
  col('REGIMEN_ASEGURAMIENTO', 'varchar', 40, many(() => pick(['Asegurado directo asalariado', 'Asegurado por el Estado', 'Pensionado (IVM)'])), 'CR_SALUD_COBERTURA'),
  col('DIAGNOSTICO', 'varchar', 6, many(() => pick(['E11.9', 'I10', 'J45.9', 'F32.1'])), 'CR_SALUD_DIAGNOSTICO'),
  col('CAUSA_MUERTE', 'varchar', 6, many(() => pick(['I219', 'C509', 'X954', 'J189'])), 'CR_SALUD_DIAGNOSTICO'),
  col('CODIGO_PROCEDIMIENTO', 'varchar', 6, many(() => String(int(10000, 999999))), 'CR_SALUD_PROCEDIMIENTO'),
  col('MEDICAMENTO', 'varchar', 40, many(() => pick(['Sertralina', 'Acetaminofén', 'Metformina'])), 'CR_SALUD_MEDICAMENTO'),
  col('EVOLUCION', 'clob', 4000, many(() => `Paciente refiere dolor abdominal de ${int(1, 9)} días de evolución.`), 'CR_SALUD_TEXTO_CLINICO'),
  col('RESULTADO_EXAMEN', 'varchar', 12, many(() => pick(['Normal', 'Alterado'])), 'CR_SALUD_RESULTADO_EXAMEN'),
  col('PRUEBA_VIH', 'varchar', 12, many(() => pick(['Reactivo', 'No reactivo'])), 'CR_SALUD_VIH'),
  col('GRUPO_SANGUINEO', 'varchar', 4, many(() => pick(['A+', 'O-', 'AB+', 'O+'])), 'CR_SALUD_GRUPO_SANGUINEO'),
  col('TIPO_DISCAPACIDAD', 'varchar', 40, many(() => pick(['Física o motora', 'Visual', 'Auditiva', 'Ninguna'])), 'CR_SALUD_DISCAPACIDAD'),
  col('APTITUD_LABORAL', 'varchar', 30, many(() => pick(['Apto', 'No apto'])), 'CR_SALUD_OCUPACIONAL'),
  col('GESTANTE', 'char', 1, many(() => pick(['S', 'N'])), 'CR_SALUD_REPRODUCTIVA'),
  col('TRASTORNO_MENTAL', 'varchar', 60, many(() => pick(['Depresión', 'Ansiedad'])), 'CR_SALUD_MENTAL'),

  // FIN
  col('CATEGORIA_SUGEF', 'varchar', 40, many(() => pick(['A1', 'B2', 'D', 'E'])), 'CR_FIN_HISTORIAL_CREDITICIO'),
  col('SALDO_DEUDA', 'number', 12, many(() => String(int(50000, 20000000))), 'CR_FIN_DEUDA'),
  col('SALARIO_BRUTO', 'number', 10, many(() => String(int(360000, 3000000))), 'CR_FIN_INGRESOS'),
  col('VALOR_FISCAL', 'number', 12, many(() => String(int(1000000, 200000000))), 'CR_FIN_PATRIMONIO'),
  col('MONTO_PENSION', 'number', 10, many(() => String(int(150000, 1500000))), 'CR_FIN_PENSION'),
  col('BENEFICIARIO_AVANCEMOS', 'char', 1, many(() => pick(['S', 'N'])), 'CR_FIN_PROGRAMA_SOCIAL'),
  col('CONDICION_SOCIOECONOMICA', 'varchar', 30, many(() => pick(['Pobreza extrema', 'No pobre', 'Vulnerabilidad'])), 'CR_FIN_CONDICION_SOCIOECONOMICA'),
  col('TENENCIA_VIVIENDA', 'varchar', 50, many(() => pick(['Alquilada', 'Propia totalmente pagada', 'En precario'])), 'CR_FIN_VIVIENDA'),

  // PENAL
  col('HOJA_DELINCUENCIA', 'varchar', 60, many(() => pick(['No registra antecedentes penales', 'Registra antecedentes'])), 'CR_PENAL_ANTECEDENTES'),
  col('EXPEDIENTE_JUDICIAL', 'varchar', 24, many(expediente), 'CR_PENAL_EXPEDIENTE'),

  // Not personal data: nothing should be assigned
  col('ID', 'integer', 10, many((i) => String(i + 1)), ''),
  col('RUTA_ARCHIVO', 'varchar', 200, many(() => `/datos/archivo${int(1, 99)}.txt`), ''),
  col('NOMBRE_PRODUCTO', 'varchar', 80, many(() => pick(['Café molido 250 g', 'Gallo pinto listo 500 g', 'Salsa Lizano 280 ml'])), ''),
  col('VALOR_VENTA', 'number', 12, many(() => String(int(1000, 99999999))), ''),
  col('FECHA_CREACION', 'date', 0, many(() => iso(2015, 2025)), ''),
  col('FECHA_FACTURA', 'date', 0, many(() => iso(2015, 2025)), ''),
  col('CODIGO', 'varchar', 10, many(() => `A-${int(100, 999)}`), ''),
  col('DESCRIPCION_PRODUCTO', 'varchar', 400, many(() => 'Producto de consumo masivo, envase de cartón reciclable.'), ''),
  col('ESTADO', 'varchar', 10, many(() => pick(['ACTIVO', 'INACTIVO'])), ''),
  col('CANTIDAD', 'number', 6, many(() => String(int(1, 500))), ''),
  col('SKU', 'varchar', 12, many(() => `SKU${int(10000, 99999)}`), ''),
  col('ID_TRANSACCION', 'varchar', 36, many(() => `TX${int(100000, 999999)}`), ''),
  col('AREA', 'varchar', 40, many(() => pick(['Financiera', 'Operaciones'])), ''),
  col('PROVINCIA', 'varchar', 30, many(() => pick(PROVINCIAS).name), ''),
  col('COD_BANCO', 'varchar', 4, many(() => pick(BANKS)), ''),
  col('URL_PAGINA', 'varchar', 200, many(() => `https://www.ejemplo.co.cr/p/${int(1, 999)}`), ''),
  col('TIPO_IDENTIFICACION', 'varchar', 6, many(() => pick(['CED', 'DIMEX', 'NITE', 'PAS'])), ''),
  col('MONEDA', 'varchar', 3, many(() => pick(['CRC', 'USD', 'EUR'])), ''),
  col('CATEGORIA', 'varchar', 30, many(() => pick(['Abarrotes', 'Panadería'])), ''),
  col('CODIGO_CIIU', 'varchar', 4, many(() => pick(['4711', '6201', '8621'])), ''),
  col('IDIOMA_INTERFAZ', 'varchar', 5, many(() => pick(['es-CR', 'en', 'es'])), ''),
  col('VALOR_DEFECTO', 'varchar', 20, many(() => pick(['0', 'N/A', 'true'])), ''),
  col('ORDEN', 'number', 4, many(() => String(int(1, 99))), ''),
  col('CONDICION_ARTICULO', 'varchar', 10, many(() => pick(['Nuevo', 'Usado'])), ''),
  col('ESTADO_PEDIDO', 'varchar', 10, many(() => pick(['Abierto', 'Cerrado', 'Pendiente'])), ''),
  col('ID_MENSAJE', 'varchar', 36, many(() => `MSG${int(100000, 999999)}`), ''),
  col('FECHA_FIN', 'date', 0, many(() => iso(2015, 2025)), ''),
  col('NOMBRE_ARCHIVO', 'varchar', 60, many(() => `reporte_${int(1, 99)}.pdf`), ''),
  col('PESO_KG', 'number', 6, many(() => `${int(1, 99)}.5`), ''),
  // A company's cédula jurídica is not personal data: article 3 b) and g) reach only a natural
  // person, and the set must leave the column alone.
  col('CEDULA_JURIDICA', 'varchar', 12, many(cedulaJuridica), ''),
]

function verifyClassifiers() {
  const readFile = (address) => fs.readFileSync(fileURLToPath(address), 'utf8')
  const resolved = preset.classifiers.map((c) => ({ name: c.name, domain: c.domain, framework: c.framework, config: resolve(c.config) }))

  let hints = 0
  for (const c of resolved) {
    const { errors, limitations, hints: h } = kit.reviewClassifier(c.framework, c.config)
    hints += h.length
    for (const issue of [...errors, ...limitations]) {
      failures++
      console.log(`  ✗ ${c.name}: ${issue.severity} ${issue.code} — ${issue.message}`)
    }
    for (const issue of h) console.log(`  · ${c.name}: hint ${issue.code} — ${issue.message}`)
  }
  console.log(`reviewed ${resolved.length} classifiers (${hints} hints)`)

  const covered = new Set(COLUMNS.map((c) => c.expect).filter(Boolean))
  const uncovered = preset.domains.map((d) => d.name).filter((d) => !covered.has(d))
  if (uncovered.length) { failures++; console.log(`  ✗ domains with no test column: ${uncovered.join(', ')}`) }

  const profile = (classifiers, expectOf, label) => {
    let passed = 0
    for (const column of COLUMNS) {
      const expect = expectOf(column)
      const field = { name: column.name, parent: null, sqlType: column.sqlType, length: column.length || null, autoIncrement: false, values: column.values }
      const result = kit.evaluateField({ classifiers, field, threshold: preset.profileSet.threshold, readFile })
      if (result.assigned === expect) { passed++; continue }
      failures++
      const ranking = result.ranking.slice(0, 3).map((r) => `${r.domain} ${r.percent}%`).join(', ')
      console.log(`  ✗ ${label}${column.name}: expected ${expect || '(none)'}, got ${result.assigned || '(none)'} — ${ranking}`)
    }
    return passed
  }
  const negatives = COLUMNS.filter((c) => !c.expect).length
  console.log(`profiled ${COLUMNS.length} columns (${negatives} not personal data): ${profile(resolved, (c) => c.expect, '')} as expected`)

  // The essential pack runs only the classifiers of its domains. Its columns must still land where
  // they did, and no other column may be taken for one of its domains.
  const essential = new Set(preset.packs.essential.domains)
  const pack = resolved.filter((c) => essential.has(c.domain))
  const ALSO = {}
  const packPassed = profile(pack, (c) => (essential.has(c.expect) ? c.expect : (ALSO[c.name] ?? '')), 'essential pack, ')
  console.log(`profiled ${COLUMNS.length} columns with the essential pack (${pack.length} classifiers): ${packPassed} as expected`)
}

// ── Distritos and cantones, offline ────────────────────────────────────────
//
// The set generalizes distritos **and** cantones in one table, because a column called CIUDAD may
// hold either. The invariants:
//   · a name all of whose bearers — distritos, cantones and provincias alike — are under 20,000 is
//     generalized, to the name of a place of at least 20,000;
//   · a name any of whose bearers is above the threshold is left alone, so a large place and a
//     provincia keep their own name;
//   · with the cantón or the provincia beside it, the same rule applies inside that qualifier;
//   · the code of a small distrito becomes the code of a large distrito of the same provincia, and
//     the code of a small cantón the code of a large cantón of the same provincia.

const readTable = (name) => new Map(fs.readFileSync(nodePath.join(HERE, 'files', name), 'utf8').split('\n').filter(Boolean).map((l) => l.split('|')))
const key = (n) => fold(n).toLowerCase()

function verifyGeneralization() {
  const table = readTable('cr-distritos-generalizados.txt')
  const codes = readTable('cr-codigos-generalizados.txt')
  const districtByCode = new Map(DISTRITOS.map((d) => [d.code, d]))
  const cantonByCode = new Map(CANTONES.map((c) => [c.code, c]))

  // Every place the table may name, at any level, by the spellings the source writes.
  const PLACES = [
    ...DISTRITOS.flatMap((d) => [d, ...d.aliases.map((name) => ({ ...d, name }))]),
    ...CANTONES,
    ...PROVINCIAS.map((p) => ({ ...p, province: p.name })),
  ]
  const bearers = new Map()
  for (const p of PLACES) bearers.set(key(p.name), [...(bearers.get(key(p.name)) ?? []), p])
  const LARGE_PLACE_NAMES = new Set(PLACES.filter((p) => !small(p)).map((p) => key(p.name)))
  const allSmall = (name) => bearers.get(key(name)).every(small)

  // Every replacement the table writes must be the name of a place of at least 20,000, with or
  // without the qualifier the source carried, in any of the five ways systems write it.
  const SEPARATORS = [[' - ', ''], [', ', ''], [' (', ')'], ['/', ''], ['-', '']]
  const QUALIFIERS = new Set([...CANTONES, ...PROVINCIAS].map((p) => key(p.name)))
  const base = (value) => {
    for (const [a, b] of SEPARATORS) {
      if (b && !value.endsWith(b)) continue
      const i = value.lastIndexOf(a)
      if (i <= 0) continue
      const tail = value.slice(i + a.length, b ? value.length - b.length : value.length)
      if (QUALIFIERS.has(key(tail))) return value.slice(0, i)
    }
    return value
  }
  let badTargets = 0
  for (const [from, to] of table) {
    if (!LARGE_PLACE_NAMES.has(key(base(to)))) { badTargets++; if (badTargets <= 10) console.log(`  ✗ table: ${from} → ${to} is not a place of 20,000`) }
  }
  if (badTargets) failures++
  else console.log(`table: ${table.size} lines, every replacement names a place of at least 20,000`)

  let ok = 0
  let shared = 0
  let keptByHomonym = 0
  let unknown = 0
  let shown = 0
  for (const d of DISTRITOS) {
    const problems = []
    const canton = cantonByCode.get(d.cantonCode)
    const code = codes.get(d.code)
    if (d.population === null) unknown++
    if (bearers.get(key(d.name)).length > 1) shared++
    if (!small(d)) {
      if (table.get(d.name) || code) problems.push('a large distrito is generalized')
    } else {
      // By name alone: generalized only when nothing of that name is large.
      if (allSmall(d.name)) {
        if (!table.get(d.name)) problems.push('not in the table by name')
      } else {
        keptByHomonym++
        if (table.get(d.name)) problems.push('a name shared with a large place is generalized')
      }
      // With the cantón beside it — unless the cantón carries the name of its provincia, where the
      // provincia keeps the string.
      if (canton.name !== d.province) {
        const qualified = `${d.name} - ${canton.name}`
        // Only the distritos of that cantón: the cantón itself is written with its provincia, not
        // with its own name, so it is no bearer of this key.
        const inside = DISTRITOS.filter((p) => key(p.name) === key(d.name) && p.cantonCode === d.cantonCode)
        if (inside.every(small)) { if (!table.get(qualified)) problems.push(`not in the table as "${qualified}"`) }
        else if (table.get(qualified)) problems.push(`"${qualified}" is generalized although something of that name in the cantón is large`)
      }
      const target = code && districtByCode.get(code)
      if (!target || small(target)) problems.push(`code ${d.code} → ${code}`)
      else if (target.code[0] !== d.code[0]) problems.push(`the code left its provincia: ${code}`)
    }
    if (problems.length) { failures++; if (shown++ < 15) console.log(`  ✗ ${d.name}/${canton.name} (${d.population}): ${problems.join('; ')}`) }
    else ok++
  }
  console.log(`distritos: ${ok} of ${DISTRITOS.length} as expected (${shared} share a name, ${keptByHomonym} small ones keep it because a homonym is large, ${unknown} have no published figure)`)

  // The cantones follow the same rule, one level up.
  let cantonOk = 0
  for (const c of CANTONES) {
    const problems = []
    const code = codes.get(c.code)
    if (small(c)) {
      const target = code && cantonByCode.get(code)
      if (!target || small(target)) problems.push(`code ${c.code} → ${code}`)
      else if (target.code[0] !== c.code[0]) problems.push(`the code left its provincia: ${code}`)
      if (allSmall(c.name) && !table.get(c.name)) problems.push('not in the table by name')
      if (!allSmall(c.name) && table.get(c.name)) problems.push('a name shared with a large place is generalized')
    } else if (code || table.get(c.name)) problems.push('a large cantón is generalized')
    if (problems.length) { failures++; console.log(`  ✗ cantón ${c.name} (${c.population}): ${problems.join('; ')}`) }
    else cantonOk++
  }
  console.log(`cantones: ${cantonOk} of ${CANTONES.length} as expected (${CANTONES.filter(small).length} under 20,000)`)

  // Every provincia must hold a target, and no provincia may be generalized.
  let provOk = 0
  for (const p of PROVINCIAS) {
    const problems = []
    if (!DISTRITOS.some((d) => d.provinceCode === p.code && !small(d))) problems.push('no distrito of 20,000')
    if (!CANTONES.some((c) => c.provinceCode === p.code && !small(c))) problems.push('no cantón of 20,000')
    if (table.get(p.name)) problems.push('a provincia is generalized')
    if (codes.get(p.code)) problems.push('a provincia code is generalized')
    if (problems.length) { failures++; console.log(`  ✗ provincia ${p.name} (${p.population}): ${problems.join('; ')}`) }
    else provOk++
  }
  console.log(`provincias: ${provOk} of ${PROVINCIAS.length} kept, each with a target of its own`)
}

// ── Algorithms ──────────────────────────────────────────────────────────────

const words = (s) => s.trim().split(/\s+/).length
const sameShape = (i, o) => i.length === o.length && i.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9') === o.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9')
const digitShape = (i, o) => i.length === o.length && i.replace(/\d/g, '9') === o.replace(/\d/g, '9')
const coarse = (v) => v.split(/\s*,\s*/).map((part) => part.slice(0, part.search(/[.,]/) + 2)).join(',')
const MASKING = {
  CR_L1_CEDULA: {
    inputs: ['1-0234-0567', '102340567', '0102340567', '155812345678', '3-120-123456', '3-101-123456', ...many(cedula, 8), ...many(cedulaPlain, 4)],
    // A company's cédula jurídica is nobody's personal datum: it comes back as it went in.
    keeps: (i) => /^3-1(01|02)-/.test(i),
    check: (i, o) => {
      // A company's cédula jurídica is nobody's personal datum and stays as it is.
      if (/^3-1(01|02)-/.test(i)) return o === i
      if (/^3-120-/.test(i)) return digitShape(i, o) && o.startsWith('3-120-') && o !== i
      // The provincia digit is masked too, and never becomes a zero.
      return digitShape(i, o) && o !== i && /^0?[1-9]/.test(o.replace(/\D/g, '') === o ? o : o)
    },
  },
  CR_L1_DIMEX: { inputs: ['155812345678', '12345678901'], check: (i, o) => digitShape(i, o) && o !== i },
  // The 3-120 series is a foreign natural person; 3-130 is a foreign company and stays.
  CR_L1_NITE: { inputs: ['3-120-123456', '3130ABC123'], keeps: (i) => i.startsWith('3130'), check: (i, o) => (i.startsWith('3-120') ? o.startsWith('3-120-') && o !== i : o === i) },
  CR_L1_PASAPORTE: { inputs: ['A1234567'], check: sameShape },
  CR_L1_SEGURO_SOCIAL: { inputs: ['123456789'], check: sameShape },
  CR_L1_CODIGO_ESTUDIANTE: { inputs: ['202012345'], check: sameShape },
  CR_L1_MATRICULA_PROFESIONAL: { inputs: ['MED-1234'], check: sameShape },
  CR_L1_NOMBRE: { inputs: ['Xinia', 'JOSÉ PABLO', 'María de los Ángeles'], check: (i, o) => words(i) === words(o) && (!/ de /.test(i) || / de /.test(o)) },
  CR_L1_APELLIDO: { inputs: ['Jiménez', 'OCONITRILLO MORA', 'De la Cruz'], check: (i, o) => words(i) === words(o) },
  CR_L1_NOMBRE_COMPLETO: {
    inputs: ['Xinia Jiménez', 'JOSÉ PABLO JIMÉNEZ', 'José Pablo Jiménez Oconitrillo', 'María de los Ángeles Mora Vargas', 'JIMÉNEZ OCONITRILLO, JOSÉ PABLO'],
    check: (i, o) => words(i) === words(o) && [' de ', ' de los '].every((w) => i.includes(w) === o.includes(w)),
  },
  CR_L1_EMAIL: { inputs: ['jose.jimenez@gmail.com', 'josé.muñoz@empresa.co.cr'], check: (i, o) => /@[^@]+\.test$/.test(o) },
  CR_L1_TELEFONO: {
    inputs: ['+506 8312 4567', '83124567', '2222 1234', '40001234'],
    // The country code and the first digit stay, so a masked number still says mobile or landline.
    check: (i, o) => digitShape(i, o) && o.replace(/\D/g, '').slice(-8)[0] === i.replace(/\D/g, '').slice(-8)[0] && o !== i,
  },
  CR_L1_DIRECCION: { inputs: ['200 metros norte de la iglesia católica, casa esquinera color verde', 'Urbanización Los Laureles, casa 12'] },
  CR_L1_DIRECCION_COMPLEMENTO: { inputs: ['Apartado 1234-1000', 'Casa 12'] },
  CR_L1_CUENTA_BANCARIA: {
    inputs: ['CR05015202001026284066', 'CR05 0152 0200 1026 2840 66', '15202001026284066', ...many(() => iban(), 6), ...many(() => iban(true), 4)],
    check: (i, o) => {
      if (/^CR/i.test(i)) return validIban(o) && o.replace(/\s/g, '').slice(4, 8) === i.replace(/\s/g, '').slice(4, 8) && (i.includes(' ') === o.includes(' ')) && o !== i
      return digitShape(i, o) && o.slice(0, 3) === i.slice(0, 3) && o !== i
    },
  },
  CR_L1_TARJETA: { inputs: ['4532 0000 0000 0001'] },
  CR_L1_BILLETERA: { inputs: ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'], check: sameShape },
  CR_L1_IP: { inputs: ['201.196.45.12', '2001:1388::1'], check: (i, o) => (i.includes('.') ? o.split('.').every((p) => Number(p) >= 1 && Number(p) <= 254) : /^[0-9a-f:]+$/i.test(o)) },
  CR_L1_DISPOSITIVO: { inputs: ['3c:22:fb:9a:10:e4', '356938035643809'], check: (i, o) => (i.includes(':') ? /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(o) : /^\d{15}$/.test(o)) },
  CR_L1_COOKIE: { inputs: ['GA1.2.123456789.1700000000'], check: sameShape },
  CR_L1_PLACA: { inputs: ['123456', 'BLM123', 'MOT123456'], check: (i, o) => sameShape(i, o) && (!/^MOT/.test(i) || o.startsWith('MOT')) },
  CR_L1_VEHICULO: { inputs: ['8AJHA8CD3J1234567'], check: sameShape },
  CR_L1_INMUEBLE: { inputs: ['1-234567-000', 'SJ-1234567-2010'], check: (i, o) => sameShape(i, o) && o !== i },
  CR_L1_CONTRATO: { inputs: ['CT-123456'] },
  CR_L1_USUARIO: { inputs: ['@jose_jimenez'] },
  CR_L1_CREDENCIAL: { inputs: ['Clave#2024'], check: (i, o) => /^X+$/.test(o) },
  CR_L1_IMAGEN: { inputs: ['/fotos/persona_12.jpg'], check: (i, o) => /^X+$/.test(o) },
  // The integer part and the first decimal stay — about 11 km.
  CR_L1_GEOLOCALIZACION: { inputs: ['9.935800', '9.935800,-84.092059'], check: (i, o) => coarse(o) === coarse(i) },
  CR_L1_TEXTO_LIBRE: {
    inputs: ['Cliente Jiménez, cédula 1-0234-0567, correo j.jimenez@gmail.com, cel 83124567.'],
    check: (i, o) => !/1-0234-0567|j\.jimenez@gmail\.com|83124567|Jiménez/.test(o),
  },
  CR_L2_FECHA_NACIMIENTO: { inputs: ['1985-07-20', '2012-01-15'], check: (i, o) => Math.abs(new Date(o.slice(0, 10)) - new Date(i)) <= 60 * 864e5 },
  CR_L2_ANIO_NACIMIENTO: { inputs: ['1985'], check: (i, o) => o.startsWith('198'), same: true },
  CR_L2_EDAD: { inputs: ['37', '7', '104'], check: (i, o) => (i === '104' ? o === '90' : i.length === 1 || o[0] === i[0]), same: true },
  CR_L2_FECHA_EVENTO: { inputs: ['2021-03-15'] },
  CR_L2_SEXO: { inputs: ['F', 'M', 'Femenino', 'masculino', 'Hombre', '1'], same: true },
  CR_L2_DISTRITO: { inputs: ['Quitirrisí', 'San José', 'DESAMPARADOS', 'Matambú - Hojancha', 'Monteverde', 'Pavas'], same: true },
  // 10707 Quitirrisí is small and moves; 10110 Hatillo and the cantón 107 Mora are large and stay.
  CR_L2_CODIGO_DTA: { inputs: ['10707', '10110', '107'], same: true },
  CR_L2_BARRIO: { inputs: ['Barrio Escalante'], same: true },
  CR_L2_ESTADO_CIVIL: { inputs: ['Unión de hecho', '2'], same: true },
  CR_L2_OCUPACION: { inputs: ['Gerente de operaciones', '2221'] },
  CR_L2_EMPLEADOR: { inputs: ['Corporación Comercial Centroamericana S.A.'] },
  CR_L2_NIVEL_EDUCATIVO: { inputs: ['Educación universitaria en curso', '7'], same: true },
  CR_L2_INSTITUCION_EDUCATIVA: { inputs: ['Universidad de Costa Rica'] },
  CR_L2_PERSONAS_A_CARGO: { inputs: ['9', '2'], check: (i, o) => Number(o) <= 5, same: true },
  CR_L3_ETNIA: { inputs: ['Afrodescendiente', '3', 'N'], same: true },
  CR_L3_PUEBLO_INDIGENA: { inputs: ['Pueblo indígena'], same: true },
  CR_L3_NACIONALIDAD: { inputs: ['Peruana'], same: true },
  CR_L3_CONDICION_MIGRATORIA: { inputs: ['Residencia en trámite', 'S'], same: true },
  CR_L3_RELIGION: { inputs: ['Ortodoxa', 'N'], same: true },
  CR_L3_CONVICCION_FILOSOFICA: { inputs: ['Se niega a transfusiones'] },
  CR_L3_OPINION_POLITICA: { inputs: ['Oficialista'], same: true },
  CR_L3_AFILIACION_PARTIDARIA: { inputs: ['Partido Republicano Social Cristiano', 'S'], same: true },
  CR_L3_AFILIACION_SINDICAL: { inputs: ['ANEP', 'S'], same: true },
  CR_L3_BIOMETRICO: { inputs: ['A1B2C3D4E5F6'] },
  CR_L3_GENETICO: { inputs: ['BRCA1 positivo'] },
  CR_L3_ORIENTACION_SEXUAL: { inputs: ['Homosexual'], same: true },
  CR_L3_VIDA_SEXUAL: { inputs: ['Activa'] },
  CR_L3_IDENTIDAD_GENERO: { inputs: ['Transgénero'], same: true },
  CR_L3_VICTIMA: { inputs: ['Violencia doméstica', 'S'], same: true },
  CR_SALUD_IDENTIFICADOR: { inputs: ['EDUS-2024-00123'] },
  CR_SALUD_COBERTURA: { inputs: ['Asegurado por el Estado', '12345'], same: true },
  CR_SALUD_DIAGNOSTICO: { inputs: ['F33.1', 'B24X', 'E119', 'Depresión mayor'], same: true },
  CR_SALUD_PROCEDIMIENTO: { inputs: ['901234', 'Prueba de carga viral para VIH'], same: true },
  CR_SALUD_MEDICAMENTO: { inputs: ['Sertralina 50 mg'] },
  CR_SALUD_TEXTO_CLINICO: { inputs: ['Paciente Jiménez, cédula 1-0234-0567, consulta por cefalea.'], check: (i, o) => !o.includes('1-0234-0567') },
  CR_SALUD_RESULTADO_EXAMEN: { inputs: ['Reactivo'] },
  CR_SALUD_VIH: { inputs: ['Reactivo', 'S'], same: true },
  CR_SALUD_GRUPO_SANGUINEO: { inputs: ['O+'], same: true },
  CR_SALUD_DISCAPACIDAD: { inputs: ['Trastorno del espectro autista', 'N'], same: true },
  CR_SALUD_OCUPACIONAL: { inputs: ['No apto temporalmente', 'S'], same: true },
  CR_SALUD_REPRODUCTIVA: { inputs: ['12 semanas de gestación', 'S'], same: true },
  CR_SALUD_MENTAL: { inputs: ['Trastorno bipolar'] },
  CR_FIN_HISTORIAL_CREDITICIO: { inputs: ['En cobro judicial', 'A1', '745', 'N'], same: true },
  CR_FIN_DEUDA: { inputs: ['2400000'] },
  CR_FIN_INGRESOS: { inputs: ['780000'] },
  CR_FIN_PATRIMONIO: { inputs: ['48000000'] },
  CR_FIN_PENSION: { inputs: ['420000'] },
  CR_FIN_PROGRAMA_SOCIAL: { inputs: ['Subsidio estatal', 'S'], same: true },
  CR_FIN_CONDICION_SOCIOECONOMICA: { inputs: ['Pobreza extrema', '2'], same: true },
  CR_FIN_VIVIENDA: { inputs: ['Vivienda en precario'], same: true },
  CR_PENAL_ANTECEDENTES: { inputs: ['Condenado por hurto en 2019', 'S'], same: true },
  CR_PENAL_EXPEDIENTE: {
    inputs: ['24-001234-0007-PE', '1234-2023', '12-000456-0164-CI'],
    check: (i, o) => digitShape(i, o) && o.replace(/\d/g, '') === i.replace(/\d/g, ''),
  },
}

const fileValues = new Map()
const has = (file, value) => {
  if (!fileValues.has(file)) {
    fileValues.set(file, new Set(fs.readFileSync(nodePath.join(HERE, 'files', file), 'utf8').split('\n').filter(Boolean).map((v) => v.toLowerCase())))
  }
  return fileValues.get(file).has(value.toLowerCase())
}
/** true or false for a S/N flag, null for anything else. */
const flag = (i, o) => (/^[SN]$/i.test(i) ? /^[SN]$/i.test(o) : null)
const SUPPRESSED = 'Sin información'
const LARGE = new Set(LARGE_NAMES.map((n) => n.toLowerCase()))
const PARTICLE = /^(de|del|la|las|los|y|e|san|santa)$/i
const EXPECT = {
  CR_L1_NOMBRE: (i, o) => o.split(/\s+/).every((w) => PARTICLE.test(w) || has('cr-nombres.txt', w)),
  CR_L1_APELLIDO: (i, o) => o.split(/\s+/).every((w) => PARTICLE.test(w) || has('cr-apellidos.txt', w)),
  CR_L1_NOMBRE_COMPLETO: (i, o) => i.includes(',') || (has('cr-nombres.txt', o.split(/\s+/)[0]) && has('cr-apellidos.txt', o.split(/\s+/).at(-1))),
  CR_L1_DIRECCION: (i, o) => has('cr-direcciones.txt', o),
  CR_L2_SEXO: (i, o) => ({ f: ['f', 'm'], m: ['f', 'm'], femenino: ['femenino', 'masculino'], masculino: ['femenino', 'masculino'], hombre: ['mujer', 'hombre'], 1: ['1', '2'] })[i.toLowerCase()].includes(o.toLowerCase()),
  // Quitirrisí, Matambú and Monteverde are small and become large distritos; San José and
  // Desamparados are large and stay, and so does Pavas; Matambú written with its cantón keeps that
  // shape.
  CR_L2_DISTRITO: (i, o) => ({
    'San José': o === 'San José',
    DESAMPARADOS: o === 'DESAMPARADOS',
    Pavas: o === 'Pavas',
    'Matambú - Hojancha': / - /.test(o) && LARGE.has(o.split(' - ')[0].toLowerCase()),
  })[i] ?? LARGE.has(o.toLowerCase()),
  CR_L2_CODIGO_DTA: (i, o) => {
    const place = [...DISTRITOS, ...CANTONES].find((p) => p.code === i)
    return small(place) ? o.length === i.length && o[0] === i[0] && o !== i : o === i
  },
  CR_L2_BARRIO: (i, o) => has('cr-barrios.txt', o),
  CR_L3_NACIONALIDAD: (i, o) => has('cr-nacionalidades.txt', o),
  CR_L3_CONDICION_MIGRATORIA: (i, o) => flag(i, o) ?? has('cr-condicion-migratoria.txt', o),
  CR_L2_ESTADO_CIVIL: (i, o) => (/^\d$/.test(i) ? /^[1-6]$/.test(o) : has('cr-estado-civil.txt', o)),
  CR_L2_OCUPACION: (i, o) => (/^\d+$/.test(i) ? /^\d{4}$/.test(o) : has('cr-ocupaciones.txt', o)),
  CR_L2_EMPLEADOR: (i, o) => has('cr-empleadores.txt', o),
  CR_L2_NIVEL_EDUCATIVO: (i, o) => (/^\d+$/.test(i) ? has('cr-nivel-educativo-codigos.txt', o) : has('cr-nivel-educativo.txt', o)),
  CR_L2_INSTITUCION_EDUCATIVA: (i, o) => has('cr-instituciones-educativas.txt', o),
  CR_L3_ETNIA: (i, o) => flag(i, o) ?? (/^\d$/.test(i) ? has('cr-etnias-codigos.txt', o) : has('cr-etnias.txt', o)),
  CR_L3_PUEBLO_INDIGENA: (i, o) => has('cr-pueblos.txt', o),
  CR_L3_RELIGION: (i, o) => flag(i, o) ?? has('cr-religiones.txt', o),
  CR_L3_CONVICCION_FILOSOFICA: (i, o) => o === SUPPRESSED,
  CR_L3_OPINION_POLITICA: (i, o) => has('cr-preferencias-politicas.txt', o),
  CR_L3_AFILIACION_PARTIDARIA: (i, o) => flag(i, o) ?? has('cr-partidos.txt', o),
  CR_L3_AFILIACION_SINDICAL: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  CR_L3_ORIENTACION_SEXUAL: (i, o) => has('cr-orientaciones-sexuales.txt', o),
  CR_L3_VIDA_SEXUAL: (i, o) => o === SUPPRESSED,
  CR_L3_IDENTIDAD_GENERO: (i, o) => has('cr-identidades-genero.txt', o),
  CR_L3_VICTIMA: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  CR_SALUD_COBERTURA: (i, o) => (/^\d+$/.test(i) ? digitShape(i, o) : has('cr-cobertura-salud.txt', o)),
  CR_SALUD_DIAGNOSTICO: (i, o) => (/^[A-Z]\d/.test(i) ? has(i.includes('.') ? 'cr-cie10-decimal.txt' : 'cr-cie10.txt', o) : has('cr-diagnosticos.txt', o)),
  CR_SALUD_PROCEDIMIENTO: (i, o) => (/^\d+$/.test(i) ? digitShape(i, o) : has('cr-procedimientos.txt', o)),
  CR_SALUD_MEDICAMENTO: (i, o) => has('cr-medicamentos.txt', o),
  CR_SALUD_VIH: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  CR_SALUD_GRUPO_SANGUINEO: (i, o) => has('cr-grupos-sanguineos.txt', o),
  CR_SALUD_DISCAPACIDAD: (i, o) => flag(i, o) ?? has('cr-discapacidades.txt', o),
  CR_SALUD_OCUPACIONAL: (i, o) => flag(i, o) ?? has('cr-aptitud-laboral.txt', o),
  CR_SALUD_REPRODUCTIVA: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  CR_SALUD_MENTAL: (i, o) => o === SUPPRESSED,
  CR_FIN_HISTORIAL_CREDITICIO: (i, o) => flag(i, o) ?? (/^\d+$/.test(i) ? digitShape(i, o) : /^[A-E][12]?$/.test(i) ? has('cr-categorias-sugef.txt', o) : has('cr-estados-credito.txt', o)),
  CR_FIN_PROGRAMA_SOCIAL: (i, o) => flag(i, o) ?? has('cr-programas-sociales.txt', o),
  CR_FIN_CONDICION_SOCIOECONOMICA: (i, o) => flag(i, o) ?? (/^\d$/.test(i) ? has('cr-condicion-socioeconomica-codigos.txt', o) : has('cr-condicion-socioeconomica.txt', o)),
  CR_FIN_VIVIENDA: (i, o) => has('cr-tenencia-vivienda.txt', o),
  CR_PENAL_ANTECEDENTES: (i, o) => flag(i, o) ?? has('cr-antecedentes.txt', o),
}

async function mask(framework, config, input, additionalAlgorithms) {
  const res = await fetch(`${API}/api/mask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ framework, config, input, additionalAlgorithms }),
  })
  return res.json()
}

async function verifyAlgorithms() {
  const byAlgorithmName = new Map(preset.algorithms.map((a) => [a.name, a]))
  // Each test sends only what the algorithm reaches, as the tester does.
  const reach = (name, seen = new Set()) => {
    if (seen.has(name) || !byAlgorithmName.has(name)) return seen
    seen.add(name)
    for (const [, ref] of JSON.stringify(byAlgorithmName.get(name).config).matchAll(/"name":"([^"]+)"/g)) reach(ref, seen)
    return seen
  }
  const closure = new Map()
  const additionalFor = (name) => {
    if (!closure.has(name)) closure.set(name, [...reach(name)].map((n) => byAlgorithmName.get(n)).map((a) => ({ name: a.name, className: a.framework, config: resolve(a.config) })))
    return closure.get(name)
  }
  const missing = preset.domains.map((d) => d.name).filter((d) => !MASKING[d])
  if (missing.length) { failures++; console.log(`  ✗ domains with no masking test: ${missing.join(', ')}`) }
  const run = (algorithmName, input) => { const algo = byAlgorithmName.get(algorithmName); return mask(algo.framework, resolve(algo.config), input, additionalFor(algorithmName)).catch((err) => ({ error: err.message })) }

  const jobs = preset.domains.flatMap((d) => (MASKING[d.name]?.inputs ?? []).map((input) => ({ domain: d, input })))
  for (const a of preset.algorithms) {
    if (a.input === undefined) { failures++; console.log(`  ✗ ${a.name} has no sample input`) }
    else jobs.push({ domain: { name: a.name, algorithm: a.name }, input: a.input, sample: true })
  }
  const TYPED = new Set(['CR_L2_FECHA_NACIMIENTO', 'CR_L2_FECHA_EVENTO', 'CR_FIN_DEUDA', 'CR_FIN_INGRESOS', 'CR_FIN_PATRIMONIO', 'CR_FIN_PENSION'])
  for (const d of preset.domains.filter((x) => !TYPED.has(x.name))) {
    for (const input of ['N/A', 'sin información', '-']) jobs.push({ domain: d, input, placeholder: true })
  }
  let passed = 0
  let next = 0
  const lines = []
  async function worker() {
    while (next < jobs.length) {
      const { domain, input, placeholder, sample } = jobs[next++]
      const test = MASKING[domain.name]
      const out = await run(domain.algorithm, input)
      const output = out.output
      const problem = output == null ? `error: ${out.error}`
        : placeholder || sample ? null
        : !test.same && !test.keeps?.(input) && output === input ? 'unchanged'
          : test.check && !test.check(input, output) ? 'check failed'
            : EXPECT[domain.name] && !EXPECT[domain.name](input, output) ? 'not in the expected vocabulary' : null
      if (problem) { failures++; lines.push(`  ✗ ${domain.name} (${domain.algorithm}) ${JSON.stringify(input)} → ${JSON.stringify(output)} ${problem}`) }
      else passed++
      if (process.env.VERBOSE) lines.push(`    ${domain.name} ${JSON.stringify(input)} → ${JSON.stringify(output)}`)
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  console.log(lines.sort().join('\n'))
  console.log(`masked ${jobs.length} values: ${passed} as expected`)

  // Cédulas stay cédulas: 200 distinct inputs give 200 distinct outputs, the hyphens kept and the
  // provincia digit masked without ever becoming a zero.
  const cedulas = [...new Set(many(cedula, 200))]
  const out = new Set()
  let bad = 0
  let moved = 0
  let i = 0
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < cedulas.length) {
      const input = cedulas[i++]
      const { output } = await run('CR_CEDULA', input)
      out.add(output)
      if (!output || !/^[1-9]-\d{4}-\d{4}$/.test(output)) bad++
      else if (output !== input) moved++
    }
  }))
  if (out.size !== cedulas.length || bad || moved !== cedulas.length) { failures++; console.log(`  ✗ cédula: ${cedulas.length} inputs gave ${out.size} distinct outputs, ${bad} reshaped, ${moved} changed`) }
  else console.log(`cédula: ${cedulas.length} distinct inputs, ${out.size} distinct outputs keeping their hyphens, provincia digit masked and never zero`)

  // IBANs: the bank stays, the account changes and the two check digits are recomputed, in the
  // compact form and in the printed one.
  for (const spaced of [false, true]) {
    const ibans = [...new Set(many(() => iban(spaced), 100))]
    const ibanOut = new Set()
    let ibanBad = 0
    let kept = 0
    let j = 0
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (j < ibans.length) {
        const input = ibans[j++]
        const { output } = await run('CR_IBAN', input)
        ibanOut.add(output)
        if (!output || !validIban(output) || (output.includes(' ') !== spaced)) { ibanBad++; continue }
        if (output.replace(/\s/g, '').slice(4, 8) === input.replace(/\s/g, '').slice(4, 8)) kept++
      }
    }))
    const label = spaced ? 'printed in groups of four' : 'compact'
    if (ibanOut.size !== ibans.length || ibanBad || kept !== ibans.length) {
      failures++
      console.log(`  ✗ IBAN ${label}: ${ibans.length} inputs gave ${ibanOut.size} distinct outputs, ${ibanBad} invalid, ${kept} kept the bank`)
    } else console.log(`IBAN ${label}: ${ibans.length} distinct inputs, ${ibanOut.size} distinct valid outputs, all keeping their bank`)
  }
}

if (only !== 'algorithms') { verifyClassifiers(); verifyGeneralization() }
if (only !== 'classifiers') await verifyAlgorithms()
console.log(failures ? `\n${failures} problem(s)` : '\nall good')
process.exit(failures ? 1 : 0)
