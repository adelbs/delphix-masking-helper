#!/usr/bin/env node
/**
 * Checks the Ecuador (LOPDP) preset.
 *
 *   node presets/ecuador-lopdp/verify.mjs               # classifiers, then algorithms
 *   node presets/ecuador-lopdp/verify.mjs classifiers   # only the local profiling check
 *   node presets/ecuador-lopdp/verify.mjs algorithms    # only masking, against the app
 *
 * Classifiers run through classifiers/, the same evaluator the classifier test uses: every
 * configuration is reviewed, then a battery of columns — well named, badly named and unrelated —
 * is profiled with the whole set at its threshold. The table that generalizes parroquias and
 * cantones is audited offline. Algorithms run in the app (DLPX_URL, default
 * http://localhost:3000), which needs the Delphix jars in lib/; every cédula and RUC they write is
 * checked against its check-digit rule.
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

// ── Check digits ────────────────────────────────────────────────────────────

// Cédula: coefficients 2 1 2 1 2 1 2 1 2 over the first nine digits, products over nine reduced by
// nine, ten minus the remainder of the sum modulo ten — the Luhn algorithm.
const COEF = [2, 1, 2, 1, 2, 1, 2, 1, 2]
const cedulaDigit = (body) => {
  const sum = [...body].reduce((a, d, i) => { const p = Number(d) * COEF[i]; return a + (p > 9 ? p - 9 : p) }, 0)
  return String((10 - (sum % 10)) % 10)
}
const PROVINCE_CODES = new Set([...Array.from({ length: 24 }, (_, i) => String(i + 1).padStart(2, '0')), '30'])
const validCedula = (v) => /^\d{10}$/.test(v) && PROVINCE_CODES.has(v.slice(0, 2)) && Number(v[2]) <= 5 && cedulaDigit(v.slice(0, 9)) === v[9]

// Private company: third digit 9, check digit in the tenth position, coefficients 4 3 2 7 6 5 4 3 2
// modulo 11. Public body: third digit 6, check digit in the ninth, coefficients 3 2 7 6 5 4 3 2.
const PRIVATE = [4, 3, 2, 7, 6, 5, 4, 3, 2]
const PUBLIC = [3, 2, 7, 6, 5, 4, 3, 2]
const mod11 = (body, weights) => { const r = [...body].reduce((a, d, i) => a + Number(d) * weights[i], 0) % 11; return r === 0 ? '0' : String(11 - r) }
const validRuc = (v) => {
  if (!/^\d{13}$/.test(v) || !PROVINCE_CODES.has(v.slice(0, 2))) return false
  if (Number(v[2]) <= 5) return validCedula(v.slice(0, 10)) && /^00\d$/.test(v.slice(10))
  if (v[2] === '9') return mod11(v.slice(0, 9), PRIVATE) === v[9]
  if (v[2] === '6') return mod11(v.slice(0, 8), PUBLIC) === v[8]
  return false
}

// ── Test data ───────────────────────────────────────────────────────────────

let seed = 593
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
const CIUDADELAS = source('ciudadelas.txt')
const CANTONES = source('cantones.tsv').map((l) => {
  const [code, name, provinceCode, province, , , population] = l.split('\t')
  return { code, name, provinceCode, province, population: Number(population) }
})
const PARROQUIAS = source('parroquias.tsv').map((l) => {
  const [code, name, cantonCode, canton, provinceCode, province, , , population] = l.split('\t')
  return { code, name, cantonCode, canton, provinceCode, province, population: Number(population) }
})
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '')
const PERSONAL = new Set([...GIVEN, ...SURNAMES].map((w) => fold(w).toLowerCase()))
const SMALL_NAMES = PARROQUIAS.filter((p) => p.population < 20000 && !PERSONAL.has(fold(p.name).toLowerCase())).map((p) => p.name)
const LARGE_NAMES = PARROQUIAS.filter((p) => p.population >= 20000).map((p) => p.name)

const pad = (n, w) => String(n).padStart(w, '0')
const digits = (n) => many(() => int(0, 9), n).join('')
const cedulaBody = () => pad(int(1, 24), 2) + String(int(0, 5)) + digits(6)
const cedula = () => { const b = cedulaBody(); return b + cedulaDigit(b) }
const rucNatural = () => `${cedula()}001`
// A body whose remainder is 1 would need a check digit of ten: the SRI never issues one.
const rucPrivate = () => { for (;;) { const b = `${pad(int(1, 24), 2)}9${digits(6)}`; const d = mod11(b, PRIVATE); if (d.length === 1) return `${b}${d}001` } }
const rucPublic = () => { for (;;) { const b = `${pad(int(1, 24), 2)}6${digits(5)}`; const d = mod11(b, PUBLIC); if (d.length === 1) return `${b}${d}0001` } }
const luhn = (prefix, length) => {
  const ds = [...prefix].map(Number)
  while (ds.length < length - 1) ds.push(int(0, 9))
  const sum = ds.slice().reverse().reduce((s, d, i) => s + (i % 2 === 0 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0)
  return ds.join('') + String((10 - (sum % 10)) % 10)
}
const iso = (y0, y1) => `${int(y0, y1)}-${pad(int(1, 12), 2)}-${pad(int(1, 28), 2)}`
const fullName = () => `${pick(GIVEN)}${random() < 0.4 ? ` ${pick(GIVEN)}` : ''} ${pick(SURNAMES)} ${pick(SURNAMES)}`
const phone = () => pick([`09${int(10, 99)}${int(100, 999)}${int(100, 999)}`, `+593 9${digits(8)}`, `09${int(10, 99)} ${int(100, 999)} ${int(100, 999)}`, `0${int(2, 7)} ${int(100, 999)}-${int(1000, 9999)}`])
const address = () => pick([`Av. Amazonas N${int(20, 60)}-${int(10, 300)} y Av. República`, `Calle Bolívar ${int(100, 2500)} y Sucre`, `${pick(CIUDADELAS)}, Mz. B Villa ${int(1, 40)}`, `Km ${int(1, 50)} Vía a Daule`])
const letters = (n) => many(() => pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), n).join('')
const plate = () => pick([`${letters(3)}-${int(100, 999)}`, `${letters(3)}-${int(1000, 9999)}`, `${letters(3)}${int(1000, 9999)}`])

// ── Classifiers ─────────────────────────────────────────────────────────────

const SQL = { varchar: 12, char: 1, number: 2, integer: 4, date: 91, timestamp: 93, clob: 2005 }
const col = (name, type, length, values, expect) => ({ name, sqlType: SQL[type], length, values, expect })

const COLUMNS = [
  // L1 — well named
  col('NUMERO_DOCUMENTO', 'varchar', 12, many(cedula), 'EC_L1_CEDULA'),
  col('CEDULA', 'varchar', 10, many(cedula), 'EC_L1_CEDULA'),
  col('CEDULA_CLIENTE', 'varchar', 10, many(cedula), 'EC_L1_CEDULA'),
  col('RUC', 'varchar', 13, many(rucNatural), 'EC_L1_RUC'),
  col('RUC_PROVEEDOR', 'varchar', 13, many(rucPrivate), 'EC_L1_RUC'),
  col('CARNE_EXTRANJERIA', 'varchar', 12, many(() => `${letters(1)}${int(100000, 999999)}`), 'EC_L1_DOCUMENTO_EXTRANJERO'),
  col('PASAPORTE', 'varchar', 10, many(() => `${letters(1)}${int(1000000, 9999999)}`), 'EC_L1_PASAPORTE'),
  col('ACTA_NACIMIENTO', 'varchar', 14, many(() => `${int(1, 400)}/${int(1980, 2020)}`), 'EC_L1_ACTA'),
  col('NUMERO_AFILIACION_IESS', 'varchar', 14, many(() => String(int(100000000, 999999999))), 'EC_L1_SEGURO_SOCIAL'),
  col('CODIGO_ALUMNO', 'varchar', 12, many(() => `${int(2015, 2025)}${int(10000, 99999)}`), 'EC_L1_CODIGO_ESTUDIANTE'),
  col('REGISTRO_SENESCYT', 'varchar', 20, many(() => `${int(1000, 9999)}-${int(10, 99)}-${int(100000, 999999)}`), 'EC_L1_REGISTRO_PROFESIONAL'),
  col('PRIMER_NOMBRE', 'varchar', 30, many(() => pick(GIVEN)), 'EC_L1_NOMBRE'),
  col('APELLIDO_PATERNO', 'varchar', 30, many(() => pick(SURNAMES)), 'EC_L1_APELLIDO'),
  col('APELLIDOS', 'varchar', 60, many(() => `${pick(SURNAMES)} ${pick(SURNAMES)}`), 'EC_L1_APELLIDO'),
  col('NOMBRE_COMPLETO', 'varchar', 120, many(fullName), 'EC_L1_NOMBRE_COMPLETO'),
  col('NOMBRE_CLIENTE', 'varchar', 120, many(fullName), 'EC_L1_NOMBRE_COMPLETO'),
  col('NOMBRE', 'varchar', 120, many(fullName), 'EC_L1_NOMBRE_COMPLETO'),
  col('RAZON_SOCIAL', 'varchar', 80, many(() => `Comercial ${int(1, 99)} Cía. Ltda.`), 'EC_L1_RAZON_SOCIAL'),
  col('CORREO_ELECTRONICO', 'varchar', 100, many(() => `${fold(pick(GIVEN)).toLowerCase()}.${int(1, 999)}@gmail.com`), 'EC_L1_EMAIL'),
  col('EMAIL', 'varchar', 100, many(() => `contacto${int(1, 999)}@empresa.com.ec`), 'EC_L1_EMAIL'),
  col('TELEFONO', 'varchar', 16, many(phone), 'EC_L1_TELEFONO'),
  col('CELULAR', 'varchar', 16, many(() => `09${digits(8)}`), 'EC_L1_TELEFONO'),
  col('DIRECCION', 'varchar', 150, many(address), 'EC_L1_DIRECCION'),
  col('DOMICILIO', 'varchar', 150, many(address), 'EC_L1_DIRECCION'),
  col('MANZANA', 'varchar', 8, many(() => `Mz. ${pick(['A', 'B', 'C', 'D'])}`), 'EC_L1_DIRECCION_COMPLEMENTO'),
  col('NUMERO_CUENTA', 'varchar', 20, many(() => digits(12)), 'EC_L1_CUENTA_BANCARIA'),
  col('NUMERO_TARJETA', 'varchar', 19, many(() => luhn('4', 16)), 'EC_L1_TARJETA'),
  col('BILLETERA_DIGITAL', 'varchar', 64, many(() => `bc1q${many(() => pick('023456789acdefghjklmnpqrstuvwxyz'), 38).join('')}`), 'EC_L1_BILLETERA'),
  col('IP_ORIGEN', 'varchar', 15, many(() => `${int(1, 223)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`), 'EC_L1_IP'),
  col('MAC_ADDRESS', 'varchar', 17, many(() => many(() => int(0, 255).toString(16).padStart(2, '0'), 6).join(':')), 'EC_L1_DISPOSITIVO'),
  col('IMEI', 'varchar', 15, many(() => luhn('35', 15)), 'EC_L1_DISPOSITIVO'),
  col('COOKIE_ID', 'varchar', 40, many(() => `GA1.2.${int(100000000, 999999999)}.${int(1600000000, 1799999999)}`), 'EC_L1_COOKIE'),
  col('PLACA', 'varchar', 10, many(plate), 'EC_L1_PLACA'),
  col('NUMERO_CHASIS', 'varchar', 17, many(() => many(() => pick('ABCDEFGHJKLMNPRSTUVWXYZ0123456789'), 17).join('')), 'EC_L1_VEHICULO'),
  col('CLAVE_CATASTRAL', 'varchar', 20, many(() => `${int(10, 99)}-${int(100, 999)}-${int(100, 999)}`), 'EC_L1_INMUEBLE'),
  col('NUMERO_CONTRATO', 'varchar', 12, many(() => `CT-${int(100000, 999999)}`), 'EC_L1_CONTRATO'),
  col('USUARIO', 'varchar', 30, many(() => `${fold(pick(GIVEN)).toLowerCase()}${int(1, 99)}`), 'EC_L1_USUARIO'),
  col('CONTRASENA', 'varchar', 60, many(() => `$2a$10$${many(() => pick('abcdefghijklmnopqrstuvwxyz0123456789'), 53).join('')}`), 'EC_L1_CREDENCIAL'),
  col('LATITUD', 'varchar', 12, many(() => `-0.${int(100000, 999999)}`), 'EC_L1_GEOLOCALIZACION'),
  col('OBSERVACIONES', 'clob', 4000, many(() => `Cliente solicita actualizar datos. Cédula ${cedula()}, correo ${fold(pick(GIVEN)).toLowerCase()}@gmail.com.`), 'EC_L1_TEXTO_LIBRE'),

  // L1 — badly named: only the values can tell
  col('CAMPO1', 'varchar', 12, many(cedula), 'EC_L1_CEDULA'),
  col('CAMPO2', 'varchar', 30, many(() => pick(GIVEN)), 'EC_L1_NOMBRE'),
  col('CAMPO3', 'varchar', 30, many(() => pick(SURNAMES)), 'EC_L1_APELLIDO'),
  col('CAMPO4', 'varchar', 120, many(fullName), 'EC_L1_NOMBRE_COMPLETO'),
  col('CAMPO5', 'varchar', 100, many(() => `${fold(pick(GIVEN)).toLowerCase()}@hotmail.com`), 'EC_L1_EMAIL'),
  col('CAMPO6', 'varchar', 16, many(() => `09${digits(8)}`), 'EC_L1_TELEFONO'),
  col('CAMPO7', 'varchar', 150, many(address), 'EC_L1_DIRECCION'),
  col('CAMPO8', 'varchar', 19, many(() => luhn('5', 16)), 'EC_L1_TARJETA'),
  col('CAMPO9', 'varchar', 15, many(() => `192.168.${int(0, 255)}.${int(1, 254)}`), 'EC_L1_IP'),
  col('CAMPO10', 'varchar', 10, many(plate), 'EC_L1_PLACA'),
  col('CAMPO11', 'varchar', 13, many(rucNatural), 'EC_L1_RUC'),
  col('TXT', 'clob', 4000, many(() => `Paciente ${pick(GIVEN)} ${pick(SURNAMES)}, cédula ${cedula()}, cel 09${digits(8)}.`), 'EC_L1_TEXTO_LIBRE'),

  // L2
  col('FECHA_NACIMIENTO', 'date', 0, many(() => iso(1940, 2010)), 'EC_L2_FECHA_NACIMIENTO'),
  col('FEC_NAC', 'varchar', 10, many(() => iso(1940, 2010)), 'EC_L2_FECHA_NACIMIENTO'),
  col('fechaNacimiento', 'timestamp', 0, many(() => iso(1940, 2010)), 'EC_L2_FECHA_NACIMIENTO'),
  col('ANIO_NACIMIENTO', 'number', 4, many(() => String(int(1940, 2010))), 'EC_L2_ANIO_NACIMIENTO'),
  col('EDAD', 'number', 3, many(() => String(int(0, 99))), 'EC_L2_EDAD'),
  col('FECHA_DEFUNCION', 'date', 0, many(() => iso(2000, 2025)), 'EC_L2_FECHA_EVENTO'),
  col('FECHA_INGRESO', 'date', 0, many(() => iso(1990, 2025)), 'EC_L2_FECHA_EVENTO'),
  col('SEXO', 'char', 1, many(() => pick(['F', 'M'])), 'EC_L2_SEXO'),
  col('GENERO', 'varchar', 10, many(() => pick(['Femenino', 'Masculino'])), 'EC_L2_SEXO'),
  col('PARROQUIA', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'EC_L2_PARROQUIA'),
  col('CANTON', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'EC_L2_PARROQUIA'),
  col('LUGAR_NACIMIENTO', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'EC_L2_PARROQUIA'),
  col('CAMPO12', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'EC_L2_PARROQUIA'),
  col('CODIGO_PARROQUIA', 'varchar', 6, many(() => pick(PARROQUIAS).code), 'EC_L2_DPA'),
  col('CODIGO_POSTAL', 'varchar', 6, many(() => String(int(170101, 179999))), 'EC_L2_CODIGO_POSTAL'),
  col('CIUDADELA', 'varchar', 60, many(() => pick(CIUDADELAS)), 'EC_L2_CIUDADELA'),
  col('ESTADO_CIVIL', 'varchar', 30, many(() => pick(['Soltero', 'Casado', 'Unión de hecho', 'Viudo'])), 'EC_L2_ESTADO_CIVIL'),
  col('PROFESION', 'varchar', 60, many(() => pick(['Docente', 'Chofer', 'Enfermera'])), 'EC_L2_OCUPACION'),
  col('NOMBRE_EMPLEADOR', 'varchar', 80, many(() => `Distribuidora ${int(1, 99)} Cía. Ltda.`), 'EC_L2_EMPLEADOR'),
  col('NIVEL_INSTRUCCION', 'varchar', 40, many(() => pick(['Bachillerato', 'Superior universitaria', 'Educación general básica'])), 'EC_L2_NIVEL_INSTRUCCION'),
  col('UNIDAD_EDUCATIVA', 'varchar', 80, many(() => `Unidad Educativa ${pick(['San José', 'Las Flores'])}`), 'EC_L2_INSTITUCION_EDUCATIVA'),
  col('PERSONAS_A_CARGO', 'number', 2, many(() => String(int(0, 8))), 'EC_L2_PERSONAS_A_CARGO'),

  // L3
  col('AUTOIDENTIFICACION', 'varchar', 60, many(() => pick(['Mestizo', 'Montubio', 'Indígena', 'Afroecuatoriano'])), 'EC_L3_ETNIA'),
  col('CAMPO13', 'varchar', 60, many(() => pick(['Mestizo', 'Montubio', 'Mulato', 'Blanco'])), 'EC_L3_ETNIA'),
  col('IDENTIDAD_CULTURAL', 'varchar', 60, many(() => pick(['Kichwa', 'Shuar', 'Tsáchila', 'Waorani'])), 'EC_L3_IDENTIDAD_CULTURAL'),
  col('LENGUA_MATERNA', 'varchar', 30, many(() => pick(['Kichwa', 'Castellano', 'Shuar chicham'])), 'EC_L3_LENGUA'),
  col('CONDICION_MIGRATORIA', 'varchar', 40, many(() => pick(['Refugiado', 'Residente temporal', 'Ecuatoriano'])), 'EC_L3_CONDICION_MIGRATORIA'),
  col('PAIS_ORIGEN', 'varchar', 20, many(() => pick(['Ecuatoriana', 'Venezolana', 'Colombiana'])), 'EC_L3_NACIONALIDAD'),
  col('RELIGION', 'varchar', 40, many(() => pick(['Católica', 'Evangélica', 'Ninguna'])), 'EC_L3_RELIGION'),
  col('INTENCION_VOTO', 'varchar', 40, many(() => pick(['Izquierda', 'Derecha', 'Centro'])), 'EC_L3_IDEOLOGIA'),
  col('PARTIDO_POLITICO', 'varchar', 60, many(() => pick(['Revolución Ciudadana', 'Pachakutik', 'Partido Social Cristiano'])), 'EC_L3_FILIACION_POLITICA'),
  col('CUOTA_SINDICAL', 'char', 1, many(() => pick(['S', 'N'])), 'EC_L3_AFILIACION_SINDICAL'),
  col('HUELLA_DACTILAR', 'varchar', 200, many(() => many(() => pick('ABCDEF0123456789'), 64).join('')), 'EC_L3_BIOMETRICO'),
  col('PRUEBA_ADN', 'varchar', 200, many(() => 'AGTC'.repeat(10)), 'EC_L3_GENETICO'),
  col('ORIENTACION_SEXUAL', 'varchar', 30, many(() => pick(['Heterosexual', 'Gay', 'Bisexual'])), 'EC_L3_ORIENTACION_SEXUAL'),
  col('IDENTIDAD_GENERO', 'varchar', 30, many(() => pick(['Mujer trans', 'Hombre cisgénero'])), 'EC_L3_IDENTIDAD_GENERO'),
  col('VICTIMA_VIOLENCIA', 'char', 1, many(() => pick(['S', 'N'])), 'EC_L3_VICTIMA'),

  // SALUD
  col('NUMERO_HISTORIA_CLINICA', 'varchar', 12, many(() => String(int(100000, 9999999))), 'EC_SALUD_IDENTIFICADOR'),
  col('COBERTURA_MEDICA', 'varchar', 30, many(() => pick(['IESS', 'ISSFA', 'MSP', 'Seguro privado con hospitalización'])), 'EC_SALUD_COBERTURA'),
  col('DIAGNOSTICO', 'varchar', 6, many(() => pick(['E11.9', 'I10', 'J45.9', 'F32.1'])), 'EC_SALUD_DIAGNOSTICO'),
  col('CAUSA_DEFUNCION', 'varchar', 6, many(() => pick(['I219', 'C509', 'X954', 'J189'])), 'EC_SALUD_DIAGNOSTICO'),
  col('CODIGO_PROCEDIMIENTO', 'varchar', 6, many(() => String(int(10000, 999999))), 'EC_SALUD_PROCEDIMIENTO'),
  col('MEDICAMENTO', 'varchar', 40, many(() => pick(['Sertralina', 'Paracetamol', 'Metformina'])), 'EC_SALUD_MEDICAMENTO'),
  col('EVOLUCION', 'clob', 4000, many(() => `Paciente refiere dolor abdominal de ${int(1, 9)} días de evolución.`), 'EC_SALUD_TEXTO_CLINICO'),
  col('RESULTADO_EXAMEN', 'varchar', 12, many(() => pick(['Normal', 'Alterado'])), 'EC_SALUD_RESULTADO_EXAMEN'),
  col('PRUEBA_VIH', 'varchar', 12, many(() => pick(['Reactivo', 'No reactivo'])), 'EC_SALUD_VIH'),
  col('GRUPO_SANGUINEO', 'varchar', 4, many(() => pick(['A+', 'O-', 'AB+', 'O+'])), 'EC_SALUD_GRUPO_SANGUINEO'),
  col('TIPO_DISCAPACIDAD', 'varchar', 40, many(() => pick(['Física', 'Visual', 'Auditiva', 'Ninguna'])), 'EC_SALUD_DISCAPACIDAD'),
  col('APTITUD_LABORAL', 'varchar', 30, many(() => pick(['Apto', 'No apto'])), 'EC_SALUD_OCUPACIONAL'),
  col('GESTANTE', 'char', 1, many(() => pick(['S', 'N'])), 'EC_SALUD_REPRODUCTIVA'),
  col('TRASTORNO_MENTAL', 'varchar', 60, many(() => pick(['Depresión', 'Ansiedad'])), 'EC_SALUD_MENTAL'),

  // FIN
  col('HISTORIAL_CREDITICIO', 'varchar', 40, many(() => pick(['A-1 Riesgo normal', 'D Riesgo dudoso', 'E Pérdida'])), 'EC_FIN_HISTORIAL_CREDITICIO'),
  col('SALDO_DEUDA', 'number', 10, many(() => String(int(100, 200000))), 'EC_FIN_DEUDA'),
  col('SUELDO', 'number', 8, many(() => String(int(470, 6000))), 'EC_FIN_INGRESOS'),
  col('VALOR_AVALUO', 'number', 10, many(() => String(int(5000, 400000))), 'EC_FIN_PATRIMONIO'),
  col('MONTO_PENSION', 'number', 8, many(() => String(int(200, 2000))), 'EC_FIN_PENSION'),
  col('BENEFICIARIO_BONO', 'char', 1, many(() => pick(['S', 'N'])), 'EC_FIN_PROGRAMA_SOCIAL'),
  col('REGISTRO_SOCIAL', 'varchar', 30, many(() => pick(['Quintil 1', 'Pobreza', 'No pobre'])), 'EC_FIN_REGISTRO_SOCIAL'),
  col('TENENCIA_VIVIENDA', 'varchar', 40, many(() => pick(['Propia y totalmente pagada', 'Arrendada', 'Prestada o cedida'])), 'EC_FIN_VIVIENDA'),

  // PENAL
  col('ANTECEDENTES_PENALES', 'varchar', 60, many(() => pick(['No registra antecedentes penales', 'Registra antecedentes'])), 'EC_PENAL_ANTECEDENTES'),
  col('NUMERO_JUICIO', 'varchar', 20, many(() => `${int(10000, 99999)}-${int(2015, 2026)}-${pad(int(1, 99999), 5)}`), 'EC_PENAL_EXPEDIENTE'),

  // Not personal data: nothing should be assigned
  col('ID', 'integer', 10, many((i) => String(i + 1)), ''),
  col('RUTA_ARCHIVO', 'varchar', 200, many(() => `/datos/archivo${int(1, 99)}.txt`), ''),
  col('NOMBRE_PRODUCTO', 'varchar', 80, many(() => pick(['Arroz flor 1 kg', 'Panela granulada 500 g', 'Café molido 250 g'])), ''),
  col('VALOR_VENTA', 'number', 12, many(() => String(int(1000, 99999999))), ''),
  col('FECHA_CREACION', 'date', 0, many(() => iso(2015, 2025)), ''),
  col('FECHA_FACTURA', 'date', 0, many(() => iso(2015, 2025)), ''),
  col('CODIGO', 'varchar', 10, many(() => `A-${int(100, 999)}`), ''),
  col('DESCRIPCION_PRODUCTO', 'varchar', 400, many(() => 'Producto de consumo masivo, empaque de cartón reciclable.'), ''),
  col('ESTADO', 'varchar', 10, many(() => pick(['ACTIVO', 'INACTIVO'])), ''),
  col('CANTIDAD', 'number', 6, many(() => String(int(1, 500))), ''),
  col('SKU', 'varchar', 12, many(() => `SKU${int(10000, 99999)}`), ''),
  col('ID_TRANSACCION', 'varchar', 36, many(() => `TX${int(100000, 999999)}`), ''),
  col('AREA', 'varchar', 40, many(() => pick(['Financiera', 'Operaciones'])), ''),
  col('PROVINCIA', 'varchar', 30, many(() => pick(['Pichincha', 'Guayas', 'Azuay', 'Manabí'])), ''),
  col('COD_BANCO', 'varchar', 4, many(() => pick(['0010', '0030', '0034'])), ''),
  col('URL_PAGINA', 'varchar', 200, many(() => `https://www.ejemplo.com.ec/p/${int(1, 999)}`), ''),
  col('TIPO_DOCUMENTO', 'varchar', 4, many(() => pick(['CED', 'RUC', 'PAS', 'CE'])), ''),
  col('MONEDA', 'varchar', 3, many(() => pick(['USD'])), ''),
  col('CATEGORIA', 'varchar', 30, many(() => pick(['Abarrotes', 'Panadería'])), ''),
  col('CODIGO_CIIU', 'varchar', 4, many(() => pick(['G4711', 'J6201', 'Q8621'])), ''),
  col('IDIOMA_INTERFAZ', 'varchar', 5, many(() => pick(['es-EC', 'en', 'es'])), ''),
  col('VALOR_DEFECTO', 'varchar', 20, many(() => pick(['0', 'N/A', 'true'])), ''),
  col('ORDEN', 'number', 4, many(() => String(int(1, 99))), ''),
  col('CONDICION_ARTICULO', 'varchar', 10, many(() => pick(['Nuevo', 'Usado'])), ''),
  col('ESTADO_PEDIDO', 'varchar', 10, many(() => pick(['Abierto', 'Cerrado', 'Pendiente'])), ''),
  col('ID_MENSAJE', 'varchar', 36, many(() => `MSG${int(100000, 999999)}`), ''),
  col('FECHA_FIN', 'date', 0, many(() => iso(2015, 2025)), ''),
  col('NOMBRE_ARCHIVO', 'varchar', 60, many(() => `reporte_${int(1, 99)}.pdf`), ''),
  col('PESO_KG', 'number', 6, many(() => `${int(1, 99)}.5`), ''),
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
  // With no domain for the ciudadela, an address classifier finds one: the column is still masked.
  const ALSO = { CIUDADELA: 'EC_L1_DIRECCION' }
  const packPassed = profile(pack, (c) => (essential.has(c.expect) ? c.expect : (ALSO[c.name] ?? '')), 'essential pack, ')
  console.log(`profiled ${COLUMNS.length} columns with the essential pack (${pack.length} classifiers): ${packPassed} as expected`)
}

// ── Parroquias and cantones, offline ────────────────────────────────────────
//
// Every parroquia of under 20,000 inhabitants must become one of at least 20,000 of the same
// cantón — or of the same provincia when its cantón has none — written with its cantón, with its
// provincia and by its DPA code; by its name alone, unless the name is shared with a large place.
// A provincia where nothing reaches 20,000 — Galápagos — keeps its own most populous place.

const readTable = (name) => new Map(fs.readFileSync(nodePath.join(HERE, 'files', name), 'utf8').split('\n').filter(Boolean).map((l) => l.split('|')))

function verifyGeneralization() {
  const table = readTable('ec-parroquias-generalizadas.txt')
  const codes = readTable('ec-dpa-generalizado.txt')
  const byCode = new Map(PARROQUIAS.map((p) => [p.code, p]))
  const places = [...PARROQUIAS, ...CANTONES]
  const key = (n) => fold(n).toLowerCase()
  const byName = new Map()
  for (const p of places) byName.set(key(p.name), [...(byName.get(key(p.name)) ?? []), p])
  // A name borne only by small places follows the most populous of them, and that bearer may be a
  // cantón: the target is then a large cantón, not a large parroquia.
  const largeNames = new Set([...LARGE_NAMES, ...CANTONES.filter((c) => c.population >= 20000).map((c) => c.name)])
  // In a provincia where nothing reaches 20,000 the target is the most populous place there.
  const provinceHasLarge = new Set(PARROQUIAS.filter((p) => p.population >= 20000).map((p) => p.provinceCode))
  const biggestOfProvince = new Map()
  for (const p of PARROQUIAS) {
    const best = biggestOfProvince.get(p.provinceCode)
    if (!best || p.population > best.population) biggestOfProvince.set(p.provinceCode, p)
  }
  let ok = 0
  let shared = 0
  let shown = 0
  for (const p of PARROQUIAS) {
    const problems = []
    const withProvince = table.get(`${p.name} - ${p.province}`)
    const alone = table.get(p.name)
    const code = codes.get(p.code)
    const homonyms = byName.get(key(p.name))
    const acceptable = (name) => largeNames.has(name) || (!provinceHasLarge.has(p.provinceCode) && name === biggestOfProvince.get(p.provinceCode).name)
    if (p.population >= 20000) {
      if (withProvince || alone || code) problems.push('a large parroquia is generalized')
    } else {
      if (homonyms.length > 1) shared++
      if (homonyms.some((x) => x.population >= 20000 && x.provinceCode === p.provinceCode)) { if (withProvince) problems.push('a name shared with a large place of its provincia is generalized') }
      else if (!withProvince || !withProvince.endsWith(` - ${p.province}`) || !acceptable(withProvince.slice(0, -` - ${p.province}`.length))) problems.push(`with its provincia: ${withProvince ?? 'not in the table'}`)
      if (homonyms.some((x) => x.population >= 20000)) { if (alone) problems.push('a name shared with a large place is generalized') }
      else if (!alone || !acceptable(alone)) problems.push(`by name: ${alone ?? 'not in the table'}`)
      const target = code && byCode.get(code)
      if (!target || target.provinceCode !== p.provinceCode) problems.push(`DPA ${p.code} → ${code}`)
      else if (target.population < 20000 && provinceHasLarge.has(p.provinceCode)) problems.push(`DPA ${p.code} → ${code} is small`)
      // The nearest large parroquia of the same cantón, when that cantón has one.
      const inCanton = PARROQUIAS.some((x) => x.cantonCode === p.cantonCode && x.population >= 20000)
      if (target && inCanton && target.cantonCode !== p.cantonCode) problems.push(`DPA left its cantón: ${code}`)
    }
    if (problems.length) { failures++; if (shown++ < 15) console.log(`  ✗ ${p.name}/${p.canton}/${p.province} (${p.population}): ${problems.join('; ')}`) }
    else ok++
  }
  console.log(`parroquias: ${ok} of ${PARROQUIAS.length} generalized as expected (${shared} small ones share a name)`)

  let cantonOk = 0
  for (const c of CANTONES) {
    const problems = []
    const code = codes.get(c.code)
    if (c.population >= 20000) { if (code) problems.push('a large cantón is generalized') }
    else {
      const target = CANTONES.find((x) => x.code === code)
      if (!target || target.provinceCode !== c.provinceCode) problems.push(`DPA ${c.code} → ${code}`)
      else if (target.population < 20000 && CANTONES.some((x) => x.provinceCode === c.provinceCode && x.population >= 20000)) problems.push(`DPA ${c.code} → ${code} is small`)
    }
    if (problems.length) { failures++; console.log(`  ✗ cantón ${c.name}/${c.province} (${c.population}): ${problems.join('; ')}`) }
    else cantonOk++
  }
  console.log(`cantones: ${cantonOk} of ${CANTONES.length} generalized as expected`)
}

// ── Algorithms ──────────────────────────────────────────────────────────────

const words = (s) => s.trim().split(/\s+/).length
const sameShape = (i, o) => i.length === o.length && i.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9') === o.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9')
const digitShape = (i, o) => i.length === o.length && i.replace(/\d/g, '9') === o.replace(/\d/g, '9')
const MASKING = {
  EC_L1_CEDULA: {
    inputs: ['1710034065', '0926687856', '1710034065001', '1790010937001', ...many(cedula, 10)],
    // A company RUC is not personal data and comes back as it went in, so "unchanged" is expected
    // here; the batch below checks that every cédula does change.
    check: (i, o) => (i.length === 13 ? validRuc(o) && (i[2] === '9' || i[2] === '6' ? o === i : o !== i) : validCedula(o) && digitShape(i, o) && o !== i),
    same: true,
  },
  EC_L1_RUC: {
    inputs: ['1710034065001', ...many(rucNatural, 8), ...many(rucPrivate, 4), ...many(rucPublic, 4)],
    check: (i, o) => validRuc(o) && o.slice(0, 3) === i.slice(0, 3),
    same: true,
  },
  EC_L1_DOCUMENTO_EXTRANJERO: { inputs: ['R123456'], check: sameShape },
  EC_L1_PASAPORTE: { inputs: ['A1234567'], check: sameShape },
  EC_L1_ACTA: { inputs: ['123/1985'], check: sameShape },
  EC_L1_SEGURO_SOCIAL: { inputs: ['123456789'], check: sameShape },
  EC_L1_CODIGO_ESTUDIANTE: { inputs: ['202012345'], check: sameShape },
  EC_L1_REGISTRO_PROFESIONAL: { inputs: ['1005-12-1234567'], check: sameShape },
  EC_L1_NOMBRE: { inputs: ['Narcisa', 'LUIS ALBERTO', 'María de los Ángeles'], check: (i, o) => words(i) === words(o) && (!/ de /.test(i) || / de /.test(o)) },
  EC_L1_APELLIDO: { inputs: ['Zambrano', 'CEDEÑO LOOR', 'Zambrano de Vera'], check: (i, o) => words(i) === words(o) && (!/ de /.test(i) || / de /.test(o)) },
  EC_L1_NOMBRE_COMPLETO: {
    inputs: ['Narcisa Zambrano', 'LUIS ALBERTO ZAMBRANO', 'Luis Alberto Zambrano Cedeño', 'María de los Ángeles Zambrano Vera', 'ZAMBRANO CEDEÑO, LUIS ALBERTO'],
    check: (i, o) => words(i) === words(o) && [' de ', ' de los '].every((w) => i.includes(w) === o.includes(w)),
  },
  EC_L1_RAZON_SOCIAL: { inputs: ['Corporación Comercial Ecuatoriana S.A.'] },
  EC_L1_EMAIL: { inputs: ['narcisa.zambrano@gmail.com', 'josé.muñoz@empresa.com.ec'], check: (i, o) => /@[^@]+\.test$/.test(o) },
  EC_L1_TELEFONO: {
    inputs: ['+593 99 123 4567', '0991234567', '02 234-5678', '0987654321'],
    // The country code, the 9 of a mobile and the area code stay, and the length does too.
    check: (i, o) => digitShape(i, o) && o.replace(/\D/g, '').slice(-9)[0] === i.replace(/\D/g, '').slice(-9)[0] && o !== i,
  },
  EC_L1_DIRECCION: { inputs: ['Av. Amazonas N34-120 y Av. República', 'Km 12 Vía a Daule'] },
  EC_L1_DIRECCION_COMPLEMENTO: { inputs: ['Mz. B Villa 12', 'Solar 7'] },
  EC_L1_CUENTA_BANCARIA: { inputs: ['2100123456'], check: digitShape },
  EC_L1_TARJETA: { inputs: ['4539 5787 6362 1486'] },
  EC_L1_BILLETERA: { inputs: ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'], check: sameShape },
  EC_L1_IP: { inputs: ['186.42.163.10', '2800:68:1a::1'], check: (i, o) => (i.includes('.') ? o.split('.').every((p) => Number(p) >= 1 && Number(p) <= 254) : /^[0-9a-f:]+$/i.test(o)) },
  EC_L1_DISPOSITIVO: { inputs: ['3c:22:fb:9a:10:e4', '356938035643809'], check: (i, o) => (i.includes(':') ? /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(o) : /^\d{15}$/.test(o)) },
  EC_L1_COOKIE: { inputs: ['GA1.2.123456789.1700000000'], check: sameShape },
  EC_L1_PLACA: { inputs: ['PCA-1234', 'GSB-123'], check: sameShape },
  EC_L1_VEHICULO: { inputs: ['8AJHA8CD3J1234567'], check: sameShape },
  EC_L1_INMUEBLE: { inputs: ['12-345-678'], check: sameShape },
  EC_L1_CONTRATO: { inputs: ['CT-123456'] },
  EC_L1_USUARIO: { inputs: ['@narcisa_zambrano'] },
  EC_L1_CREDENCIAL: { inputs: ['Clave#2024'], check: (i, o) => /^X+$/.test(o) },
  EC_L1_GEOLOCALIZACION: { inputs: ['-0.180653', '-0.180653,-78.467834'], check: (i, o) => o.slice(0, 4) === i.slice(0, 4) },
  EC_L1_TEXTO_LIBRE: {
    inputs: ['Cliente Zambrano, cédula 1710034065, correo n.zambrano@gmail.com, cel 0991234567.'],
    check: (i, o) => !/1710034065|n\.zambrano@gmail\.com|0991234567|Zambrano/.test(o),
  },
  EC_L2_FECHA_NACIMIENTO: { inputs: ['1985-07-20', '2012-01-15'], check: (i, o) => Math.abs(new Date(o.slice(0, 10)) - new Date(i)) <= 60 * 864e5 },
  EC_L2_ANIO_NACIMIENTO: { inputs: ['1985'], check: (i, o) => o.startsWith('198'), same: true },
  EC_L2_EDAD: { inputs: ['37', '7', '104'], check: (i, o) => (i === '104' ? o === '90' : i.length === 1 || o[0] === i[0]), same: true },
  EC_L2_FECHA_EVENTO: { inputs: ['2021-03-15'] },
  EC_L2_SEXO: { inputs: ['F', 'M', 'Femenino', 'masculino', 'Hombre', '1'], same: true },
  EC_L2_PARROQUIA: { inputs: ['Chavezpamba', 'Quito', 'CUMBAYÁ', 'Facundo Vela - Bolívar', 'Isabela', 'Guayaquil'], same: true },
  EC_L2_DPA: { inputs: ['170158', '170150'], same: true },
  EC_L2_CIUDADELA: { inputs: ['Cdla. Kennedy'], same: true },
  EC_L2_CODIGO_POSTAL: { inputs: ['170150'], check: (i, o) => o === '170000' },
  EC_L2_ESTADO_CIVIL: { inputs: ['Unión libre', '2'], same: true },
  EC_L2_OCUPACION: { inputs: ['Gerente de operaciones', '2221'] },
  EC_L2_EMPLEADOR: { inputs: ['Corporación Comercial Ecuatoriana S.A.'] },
  EC_L2_NIVEL_INSTRUCCION: { inputs: ['Educación superior en curso', '7'], same: true },
  EC_L2_INSTITUCION_EDUCATIVA: { inputs: ['Universidad Central del Ecuador'] },
  EC_L2_PERSONAS_A_CARGO: { inputs: ['9', '2'], check: (i, o) => Number(o) <= 5, same: true },
  EC_L3_ETNIA: { inputs: ['Indígena', '3', 'N'], same: true },
  EC_L3_IDENTIDAD_CULTURAL: { inputs: ['Pueblo Manta-Huancavilca'], same: true },
  EC_L3_LENGUA: { inputs: ['Kichwa de la sierra'], same: true },
  EC_L3_CONDICION_MIGRATORIA: { inputs: ['Residente en trámite'], same: true },
  EC_L3_NACIONALIDAD: { inputs: ['Panameña'], same: true },
  EC_L3_RELIGION: { inputs: ['Ortodoxa', 'N'], same: true },
  EC_L3_IDEOLOGIA: { inputs: ['Oficialista'], same: true },
  EC_L3_FILIACION_POLITICA: { inputs: ['Movimiento Suma', 'S'], same: true },
  EC_L3_AFILIACION_SINDICAL: { inputs: ['UNE', 'S'], same: true },
  EC_L3_BIOMETRICO: { inputs: ['A1B2C3D4E5F6'] },
  EC_L3_GENETICO: { inputs: ['BRCA1 positivo'] },
  EC_L3_ORIENTACION_SEXUAL: { inputs: ['Homosexual'], same: true },
  EC_L3_IDENTIDAD_GENERO: { inputs: ['Transgénero'], same: true },
  EC_L3_VICTIMA: { inputs: ['Violencia intrafamiliar', 'S'], same: true },
  EC_SALUD_IDENTIFICADOR: { inputs: ['HC-2024-00123'] },
  EC_SALUD_COBERTURA: { inputs: ['IESS', '12345'], same: true },
  EC_SALUD_DIAGNOSTICO: { inputs: ['F33.1', 'B24X', 'E119', 'Depresión mayor'], same: true },
  EC_SALUD_PROCEDIMIENTO: { inputs: ['901234', 'Prueba de carga viral para VIH'], same: true },
  EC_SALUD_MEDICAMENTO: { inputs: ['Sertralina 50 mg'] },
  EC_SALUD_TEXTO_CLINICO: { inputs: ['Paciente Zambrano, cédula 1710034065, consulta por cefalea.'], check: (i, o) => !o.includes('1710034065') },
  EC_SALUD_RESULTADO_EXAMEN: { inputs: ['Reactivo'] },
  EC_SALUD_VIH: { inputs: ['Reactivo', 'S'], same: true },
  EC_SALUD_GRUPO_SANGUINEO: { inputs: ['O+'], same: true },
  EC_SALUD_DISCAPACIDAD: { inputs: ['Trastorno del espectro autista', 'N'], same: true },
  EC_SALUD_OCUPACIONAL: { inputs: ['No apto temporalmente', 'S'], same: true },
  EC_SALUD_REPRODUCTIVA: { inputs: ['12 semanas de gestación', 'S'], same: true },
  EC_SALUD_MENTAL: { inputs: ['Trastorno bipolar'] },
  EC_FIN_HISTORIAL_CREDITICIO: { inputs: ['Reportado en el buró de crédito', '745', 'N'], same: true },
  EC_FIN_DEUDA: { inputs: ['8400'] },
  EC_FIN_INGRESOS: { inputs: ['1200'] },
  EC_FIN_PATRIMONIO: { inputs: ['85000'] },
  EC_FIN_PENSION: { inputs: ['520'] },
  EC_FIN_PROGRAMA_SOCIAL: { inputs: ['Bono de contingencia', 'S'], same: true },
  EC_FIN_REGISTRO_SOCIAL: { inputs: ['Pobreza extrema', '2'], same: true },
  EC_FIN_VIVIENDA: { inputs: ['Ocupación de hecho'], same: true },
  EC_PENAL_ANTECEDENTES: { inputs: ['Sentenciado por hurto en 2019', 'S'], same: true },
  EC_PENAL_EXPEDIENTE: {
    inputs: ['17294-2024-00123', '1234/2023', 'PN-456-2022'],
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
const LARGE = new Set([...LARGE_NAMES, ...CANTONES.filter((c) => c.population >= 20000).map((c) => c.name), 'Santa Cruz', 'Puerto Ayora'].map((n) => n.toLowerCase()))
const PARTICLE = /^(de|del|la|las|los|y|e|san|santa)$/i
const EXPECT = {
  EC_L1_NOMBRE: (i, o) => o.split(/\s+/).every((w) => PARTICLE.test(w) || has('ec-nombres.txt', w)),
  EC_L1_APELLIDO: (i, o) => o.split(/\s+/).every((w) => PARTICLE.test(w) || has('ec-apellidos.txt', w)),
  EC_L1_NOMBRE_COMPLETO: (i, o) => i.includes(',') || (has('ec-nombres.txt', o.split(/\s+/)[0]) && has('ec-apellidos.txt', o.split(/\s+/).at(-1))),
  EC_L1_RAZON_SOCIAL: (i, o) => has('ec-razones-sociales.txt', o),
  EC_L1_DIRECCION: (i, o) => has('ec-direcciones.txt', o),
  EC_L2_SEXO: (i, o) => ({ f: ['f', 'm'], m: ['f', 'm'], femenino: ['femenino', 'masculino'], masculino: ['femenino', 'masculino'], hombre: ['mujer', 'hombre'], 1: ['1', '2'] })[i.toLowerCase()].includes(o.toLowerCase()),
  // Chavezpamba and Isabela are small and become larger places; Quito, Cumbayá and Guayaquil stay;
  // Facundo Vela written with its provincia keeps the shape "name - provincia".
  EC_L2_PARROQUIA: (i, o) => ({
    Quito: o === 'Quito',
    CUMBAYÁ: o === 'CUMBAYÁ',
    Guayaquil: o === 'Guayaquil',
    'Facundo Vela - Bolívar': / - Bolívar$/.test(o) && LARGE.has(o.replace(/ - Bolívar$/, '').toLowerCase()),
  })[i] ?? LARGE.has(o.toLowerCase()),
  EC_L2_DPA: (i, o) => (i === '170150' ? o === i : o.length === i.length && o.slice(0, 2) === i.slice(0, 2) && o !== i),
  EC_L2_CIUDADELA: (i, o) => has('ec-ciudadelas.txt', o),
  EC_L3_NACIONALIDAD: (i, o) => has('ec-nacionalidades.txt', o),
  EC_L2_ESTADO_CIVIL: (i, o) => (/^\d$/.test(i) ? /^[1-6]$/.test(o) : has('ec-estado-civil.txt', o)),
  EC_L2_OCUPACION: (i, o) => (/^\d+$/.test(i) ? /^\d{4}$/.test(o) : has('ec-ocupaciones.txt', o)),
  EC_L2_EMPLEADOR: (i, o) => has('ec-empleadores.txt', o),
  EC_L2_NIVEL_INSTRUCCION: (i, o) => (/^\d+$/.test(i) ? has('ec-nivel-instruccion-codigos.txt', o) : has('ec-nivel-instruccion.txt', o)),
  EC_L2_INSTITUCION_EDUCATIVA: (i, o) => has('ec-instituciones-educativas.txt', o),
  EC_L3_ETNIA: (i, o) => flag(i, o) ?? (/^\d$/.test(i) ? has('ec-autoidentificacion-codigos.txt', o) : has('ec-autoidentificacion.txt', o)),
  EC_L3_IDENTIDAD_CULTURAL: (i, o) => has('ec-identidad-cultural.txt', o),
  EC_L3_LENGUA: (i, o) => has('ec-lenguas.txt', o),
  EC_L3_CONDICION_MIGRATORIA: (i, o) => has('ec-condicion-migratoria.txt', o),
  EC_L3_RELIGION: (i, o) => flag(i, o) ?? has('ec-religiones.txt', o),
  EC_L3_IDEOLOGIA: (i, o) => has('ec-ideologias.txt', o),
  EC_L3_FILIACION_POLITICA: (i, o) => flag(i, o) ?? has('ec-partidos.txt', o),
  EC_L3_AFILIACION_SINDICAL: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  EC_L3_ORIENTACION_SEXUAL: (i, o) => has('ec-orientaciones-sexuales.txt', o),
  EC_L3_IDENTIDAD_GENERO: (i, o) => has('ec-identidades-genero.txt', o),
  EC_L3_VICTIMA: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  EC_SALUD_COBERTURA: (i, o) => (/^\d+$/.test(i) ? digitShape(i, o) : has('ec-cobertura-salud.txt', o)),
  EC_SALUD_DIAGNOSTICO: (i, o) => (/^[A-Z]\d/.test(i) ? has(i.includes('.') ? 'ec-cie10-decimal.txt' : 'ec-cie10.txt', o) : has('ec-diagnosticos.txt', o)),
  EC_SALUD_PROCEDIMIENTO: (i, o) => (/^\d+$/.test(i) ? digitShape(i, o) : has('ec-procedimientos.txt', o)),
  EC_SALUD_MEDICAMENTO: (i, o) => has('ec-medicamentos.txt', o),
  EC_SALUD_VIH: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  EC_SALUD_GRUPO_SANGUINEO: (i, o) => has('ec-grupos-sanguineos.txt', o),
  EC_SALUD_DISCAPACIDAD: (i, o) => flag(i, o) ?? has('ec-discapacidades.txt', o),
  EC_SALUD_OCUPACIONAL: (i, o) => flag(i, o) ?? has('ec-aptitud-laboral.txt', o),
  EC_SALUD_REPRODUCTIVA: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  EC_SALUD_MENTAL: (i, o) => o === SUPPRESSED,
  EC_FIN_HISTORIAL_CREDITICIO: (i, o) => flag(i, o) ?? (/^\d+$/.test(i) ? digitShape(i, o) : has('ec-estados-credito.txt', o)),
  EC_FIN_PROGRAMA_SOCIAL: (i, o) => flag(i, o) ?? has('ec-programas-sociales.txt', o),
  EC_FIN_REGISTRO_SOCIAL: (i, o) => flag(i, o) ?? (/^\d$/.test(i) ? has('ec-registro-social-codigos.txt', o) : has('ec-registro-social.txt', o)),
  EC_FIN_VIVIENDA: (i, o) => has('ec-tenencia-vivienda.txt', o),
  EC_PENAL_ANTECEDENTES: (i, o) => flag(i, o) ?? has('ec-antecedentes.txt', o),
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
  const TYPED = new Set(['EC_L2_FECHA_NACIMIENTO', 'EC_L2_FECHA_EVENTO', 'EC_FIN_DEUDA', 'EC_FIN_INGRESOS', 'EC_FIN_PATRIMONIO', 'EC_FIN_PENSION'])
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
        : !test.same && output === input ? 'unchanged'
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

  // Cédulas stay cédulas: 200 distinct inputs give 200 distinct valid outputs, all keeping the
  // province of issue and the digit that says the holder is a natural person.
  const cedulas = [...new Set(many(cedula, 200))]
  const out = new Set()
  let bad = 0
  let kept = 0
  let i = 0
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < cedulas.length) {
      const input = cedulas[i++]
      const { output } = await run('EC_CEDULA', input)
      out.add(output)
      if (!output || !validCedula(output)) bad++
      else if (output.slice(0, 3) === input.slice(0, 3)) kept++
    }
  }))
  if (out.size !== cedulas.length || bad || kept !== cedulas.length) { failures++; console.log(`  ✗ cédula: ${cedulas.length} inputs gave ${out.size} distinct outputs, ${bad} invalid, ${kept} kept province and type`) }
  else console.log(`cédula: ${cedulas.length} distinct inputs, ${out.size} distinct valid outputs, all keeping province and type`)

  // A natural person's RUC carries the cédula, and both must mask the same way; a company's RUC is
  // not personal data and must come back untouched.
  let agree = 0
  const pairs = many(cedula, 25)
  for (const c of pairs) {
    const a = await run('EC_DOCUMENTO', c)
    const b = await run('EC_DOCUMENTO', `${c}001`)
    if (a.output && b.output && b.output === `${a.output}001`) agree++
  }
  if (agree !== pairs.length) { failures++; console.log(`  ✗ cédula × RUC: ${agree} of ${pairs.length} agree`) }
  else console.log(`cédula × RUC: ${agree} of ${pairs.length} mask to the same ten digits`)

  const companies = [...new Set([...many(rucPrivate, 20), ...many(rucPublic, 20)])]
  let untouched = 0
  for (const r of companies) { const { output } = await run('EC_DOCUMENTO', r); if (output === r) untouched++ }
  if (untouched !== companies.length) { failures++; console.log(`  ✗ company RUC: ${untouched} of ${companies.length} left untouched`) }
  else console.log(`company RUC: ${companies.length} of ${companies.length} left untouched — a legal person is not a data subject`)
}

if (only !== 'algorithms') { verifyClassifiers(); verifyGeneralization() }
if (only !== 'classifiers') await verifyAlgorithms()
console.log(failures ? `\n${failures} problem(s)` : '\nall good')
process.exit(failures ? 1 : 0)
