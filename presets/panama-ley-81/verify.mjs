#!/usr/bin/env node
/**
 * Checks the Panama (Ley 81 de 2019) preset.
 *
 *   node presets/panama-ley-81/verify.mjs               # classifiers, then algorithms
 *   node presets/panama-ley-81/verify.mjs classifiers   # only the local profiling check
 *   node presets/panama-ley-81/verify.mjs algorithms    # only masking, against the app
 *
 * Classifiers run through classifiers/, the same evaluator the classifier test uses: every
 * configuration is reviewed, then a battery of columns — well named, badly named and unrelated —
 * is profiled with the whole set at its threshold. Algorithms run in the app (DLPX_URL, default
 * http://localhost:3000), which needs the Delphix jars in lib/.
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

// ── The DV of a RUC ─────────────────────────────────────────────────────────
//
// The DGI table, written out the way the published algorithm builds it. Checked against the
// examples of the ANIP algorithm document before anything else runs.

function rucDv(ruc) {
  const rs = ruc.split('-')
  const z = (n) => '0'.repeat(Math.max(0, n))
  const tail = (t, a) => z(3 - t.length) + t + z(5 - a.length) + a
  // Constant 5, province (2), code of the letters (2), tomo (3), asiento (5).
  const LETTERS = { E: '50', N: '40', PE: '75' }
  let table
  if (rs[0] in LETTERS) table = `0000005` + `00` + LETTERS[rs[0]] + tail(rs[1], rs[2])
  else if (/AV$|PI$/.test(rs[0])) {
    const province = rs[0].slice(0, -2)
    // A one-digit province with AV or PI is padded with two zeros, as the DGI table does.
    table = `0000005` + '00'.repeat(Math.max(0, 2 - province.length)) + province + (rs[0].endsWith('AV') ? '15' : '79') + tail(rs[1], rs[2])
  } else table = `0000005` + z(2 - rs[0].length) + rs[0] + `00` + tail(rs[1], rs[2])
  const digit = (s) => { let j = 2; let sum = 0; for (const c of [...s].reverse()) { sum += j * Number(c); j++ } const r = sum % 11; return r > 1 ? 11 - r : 0 }
  const d1 = digit(table)
  return `${d1}${digit(table + d1)}`
}
for (const [ruc, dv] of [['8-442-445', '08'], ['PE-10-442', '50'], ['N-45-832', '58'], ['E-12-342', '10'], ['1AV-432-658', '96'], ['4PI-234-123', '96']]) {
  if (rucDv(ruc) !== dv) { console.log(`✗ the reference DV is wrong: ${ruc} gives ${rucDv(ruc)}, the DGI example says ${dv}`); process.exit(1) }
}

// ── Test data ───────────────────────────────────────────────────────────────

let seed = 507
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
const NOMBRES = source('nombres.txt')
const APELLIDOS = source('apellidos.txt')
const CORREGIMIENTOS = source('corregimientos.tsv').map((l) => { const [code, name, districtCode, district, provinceCode, , , , , population] = l.split('\t'); return { code, name, districtCode, district, provinceCode, population: Number(population) } })
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '')
const PERSONAL = new Set([...NOMBRES, ...APELLIDOS].map((w) => fold(w).toLowerCase()))
const CORREGIMIENTO_NAMES = CORREGIMIENTOS.map((c) => c.name).filter((n) => !PERSONAL.has(fold(n).toLowerCase()))

const pad2 = (n) => String(n).padStart(2, '0')
const digits = (n) => String(int(1, 9)) + many(() => int(0, 9), n - 1).join('')
/** A cédula of any kind, weighted towards the plain province form. */
const cedula = () => {
  const kind = pick(['', '', '', '', '', 'AV', 'PI', 'E', 'N', 'PE'])
  const province = String(int(1, 13))
  if (kind === 'E') return `E-${province}-${digits(int(3, 6))}`
  if (kind === 'N' || kind === 'PE') return `${kind}-${digits(int(1, 3))}-${digits(int(2, 5))}`
  return `${province}${kind}-${digits(int(1, 4))}-${digits(int(2, 6))}`
}
const plainCedula = () => `${int(1, 13)}-${digits(int(2, 4))}-${digits(int(3, 5))}`
const rucWithDv = (c = cedula()) => `${c} DV ${rucDv(c)}`
const juridico = () => `${digits(int(5, 9))}-${int(1, 3)}-${int(2008, 2025)}`
const luhn = (prefix, length) => {
  const ds = [...prefix].map(Number)
  while (ds.length < length - 1) ds.push(int(0, 9))
  const sum = ds.slice().reverse().reduce((s, d, i) => s + (i % 2 === 0 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0)
  return ds.join('') + String((10 - (sum % 10)) % 10)
}
const iso = (y0, y1) => `${int(y0, y1)}-${pad2(int(1, 12))}-${pad2(int(1, 28))}`
const fullName = () => `${pick(NOMBRES)}${random() < 0.4 ? ` ${pick(NOMBRES)}` : ''} ${pick(APELLIDOS)} ${pick(APELLIDOS)}`
const plate = () => `${pick('ABCDEFGHJKLMNPRSTUVWXYZ')}${pick('ABCDEFGHJKLMNPRSTUVWXYZ')}${int(1000, 9999)}`
const mobile = () => pick([`6${int(100, 999)}-${int(1000, 9999)}`, `+507 6${int(100, 999)}-${int(1000, 9999)}`, `6${int(1000000, 9999999)}`])

const CEDULA_SHAPE = /^(([1-9]|1[0-3])(AV|PI)?|E|N|PE)-\d{1,4}-\d{1,6}$/
/** Same kind of cédula, same length of tomo and asiento: only the digits and the province changed. */
const sameCedulaShape = (i, o) => {
  const a = i.match(/^(\d*)([A-Z]*)-(\d+)-(\d+)$/)
  const b = o.match(/^(\d*)([A-Z]*)-(\d+)-(\d+)$/)
  return Boolean(a && b) && a[2] === b[2] && a[3].length === b[3].length && a[4].length === b[4].length && (a[1] === '') === (b[1] === '')
}
const validRucDv = (s) => { const m = s.match(/^(.+) DV (\d\d)$/); return Boolean(m) && CEDULA_SHAPE.test(m[1]) && rucDv(m[1]) === m[2] }

// ── Classifiers ─────────────────────────────────────────────────────────────

const SQL = { varchar: 12, char: 1, number: 2, integer: 4, date: 91, timestamp: 93, clob: 2005 }
const col = (name, type, length, values, expect) => ({ name, sqlType: SQL[type], length, values, expect })

const COLUMNS = [
  // L1 — well named
  col('CEDULA', 'varchar', 15, many(cedula), 'PA_L1_CEDULA'),
  col('NUM_CEDULA', 'varchar', 15, many(plainCedula), 'PA_L1_CEDULA'),
  col('cedulaCliente', 'varchar', 20, many(cedula), 'PA_L1_CEDULA'),
  col('CIP', 'varchar', 15, many(plainCedula), 'PA_L1_CEDULA'),
  col('RUC', 'varchar', 25, many(() => (random() < 0.5 ? rucWithDv() : juridico())), 'PA_L1_RUC'),
  col('dRuc', 'varchar', 20, many(() => (random() < 0.5 ? plainCedula() : juridico())), 'PA_L1_RUC'),
  col('DV', 'char', 2, many(() => pad2(int(0, 99))), 'PA_L1_RUC_DV'),
  col('LICENCIA_CONDUCIR', 'varchar', 15, many(plainCedula), 'PA_L1_CEDULA'),
  col('NUM_SEGURO_SOCIAL', 'varchar', 10, many(() => String(int(100000, 9999999))), 'PA_L1_SEGURO_SOCIAL'),
  col('PASAPORTE', 'varchar', 10, many(() => `PA${int(100000, 999999)}`), 'PA_L1_PASAPORTE'),
  col('CARNE_MIGRATORIO', 'varchar', 14, many(() => `${int(100000, 999999)}`), 'PA_L1_DOCUMENTO_MIGRATORIO'),
  col('NUM_IDONEIDAD', 'varchar', 8, many(() => String(int(1000, 99999))), 'PA_L1_IDONEIDAD'),
  col('NOMBRE', 'varchar', 120, many(fullName), 'PA_L1_NOMBRE_COMPLETO'),
  col('NOMBRES', 'varchar', 60, many(() => `${pick(NOMBRES)}${random() < 0.5 ? ` ${pick(NOMBRES)}` : ''}`), 'PA_L1_NOMBRE'),
  col('PRIMER_NOMBRE', 'varchar', 30, many(() => pick(NOMBRES)), 'PA_L1_NOMBRE'),
  col('APELLIDO_PATERNO', 'varchar', 30, many(() => pick(APELLIDOS)), 'PA_L1_APELLIDO'),
  col('APELLIDO_CASADA', 'varchar', 30, many(() => pick(APELLIDOS)), 'PA_L1_APELLIDO'),
  col('NOMBRE_COMPLETO', 'varchar', 120, many(fullName), 'PA_L1_NOMBRE_COMPLETO'),
  col('NOMBRE_ACUDIENTE', 'varchar', 120, many(fullName), 'PA_L1_NOMBRE_COMPLETO'),
  col('EMAIL', 'varchar', 100, many(() => `${fold(pick(NOMBRES)).toLowerCase()}.${int(1, 999)}@gmail.com`), 'PA_L1_EMAIL'),
  col('CORREO_ELECTRONICO', 'varchar', 100, many(() => `contacto${int(1, 999)}@empresa.com.pa`), 'PA_L1_EMAIL'),
  col('TEL_CELULAR', 'varchar', 20, many(mobile), 'PA_L1_TELEFONO'),
  col('TELEFONO_RESIDENCIA', 'varchar', 12, many(() => `${int(200, 999)}-${int(1000, 9999)}`), 'PA_L1_TELEFONO'),
  col('DIRECCION', 'varchar', 120, many(() => `Vía España, Edificio Plaza, Piso ${int(1, 30)}, Apto. ${int(1, 30)}B`), 'PA_L1_DIRECCION'),
  col('DOMICILIO', 'varchar', 120, many(() => `Barriada Villa del Carmen, Casa ${int(1, 400)}`), 'PA_L1_DIRECCION'),
  col('NUM_CASA', 'varchar', 6, many(() => String(int(1, 400))), 'PA_L1_DIRECCION_COMPLEMENTO'),
  col('NUM_CUENTA', 'varchar', 12, many(() => String(int(1e9, 9.9e11))), 'PA_L1_CUENTA_BANCARIA'),
  col('NUMERO_TARJETA', 'varchar', 19, many(() => luhn('4', 16)), 'PA_L1_TARJETA'),
  col('TARJETA_CLAVE_SOCIAL', 'varchar', 19, many(() => luhn('6', 16)), 'PA_L1_TARJETA'),
  col('IP_ORIGEN', 'varchar', 15, many(() => `${int(1, 223)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`), 'PA_L1_IP'),
  col('MAC_ADDRESS', 'varchar', 17, many(() => many(() => int(0, 255).toString(16).padStart(2, '0'), 6).join(':')), 'PA_L1_DISPOSITIVO'),
  col('IMEI', 'varchar', 15, many(() => luhn('35', 15)), 'PA_L1_DISPOSITIVO'),
  col('PLACA', 'varchar', 8, many(plate), 'PA_L1_PLACA'),
  col('VIN', 'varchar', 17, many(() => many(() => pick('ABCDEFGHJKLMNPRSTUVWXYZ0123456789'), 17).join('')), 'PA_L1_VIN'),
  col('NUM_FINCA', 'varchar', 10, many(() => String(int(10000, 99999999))), 'PA_L1_FINCA'),
  col('NUM_POLIZA', 'varchar', 12, many(() => `POL-${int(100000, 999999)}`), 'PA_L1_NUMERO_CONTRATO'),
  col('NIS', 'varchar', 8, many(() => String(int(1000000, 9999999))), 'PA_L1_NUMERO_CONTRATO'),
  col('USERNAME', 'varchar', 30, many(() => `${fold(pick(NOMBRES)).toLowerCase()}${int(1, 99)}`), 'PA_L1_USUARIO_RRSS'),
  col('PASSWORD_HASH', 'varchar', 60, many(() => `$2a$10$${many(() => pick('abcdefghijklmnopqrstuvwxyz0123456789'), 53).join('')}`), 'PA_L1_CREDENCIAL'),
  col('LATITUD', 'varchar', 12, many(() => `${int(7, 9)}.${int(100000, 999999)}`), 'PA_L1_GEOLOCALIZACION'),
  col('COORDENADAS', 'varchar', 30, many(() => `8.${int(1000, 9999)},-79.${int(1000, 9999)}`), 'PA_L1_GEOLOCALIZACION'),
  col('OBSERVACIONES', 'clob', 4000, many(() => `Cliente solicitó actualizar datos. Cédula ${plainCedula()}, correo ${fold(pick(NOMBRES)).toLowerCase()}@gmail.com.`), 'PA_L1_TEXTO_LIBRE'),

  // L1 — badly named: only the values can tell
  col('CAMPO1', 'varchar', 15, many(cedula), 'PA_L1_CEDULA'),
  col('CAMPO2', 'varchar', 25, many(() => rucWithDv()), 'PA_L1_RUC'),
  col('COL_A', 'varchar', 30, many(() => pick(NOMBRES)), 'PA_L1_NOMBRE'),
  col('COL_B', 'varchar', 30, many(() => pick(APELLIDOS)), 'PA_L1_APELLIDO'),
  col('DATO_X', 'varchar', 120, many(fullName), 'PA_L1_NOMBRE_COMPLETO'),
  col('CAMPO3', 'varchar', 100, many(() => `${fold(pick(NOMBRES)).toLowerCase()}@hotmail.com`), 'PA_L1_EMAIL'),
  col('CAMPO4', 'varchar', 15, many(() => `+507 6${int(100, 999)}-${int(1000, 9999)}`), 'PA_L1_TELEFONO'),
  col('CAMPO5', 'varchar', 120, many(() => `Urbanización Los Ángeles, Calle ${int(1, 20)}, Casa ${int(1, 300)}`), 'PA_L1_DIRECCION'),
  col('CAMPO6', 'varchar', 19, many(() => luhn('5', 16)), 'PA_L1_TARJETA'),
  col('CAMPO7', 'varchar', 15, many(() => `192.168.${int(0, 255)}.${int(1, 254)}`), 'PA_L1_IP'),
  col('CAMPO8', 'varchar', 8, many(plate), 'PA_L1_PLACA'),
  col('TXT', 'clob', 4000, many(() => `Paciente ${pick(NOMBRES)} ${pick(APELLIDOS)}, cédula ${plainCedula()}, tel 6${int(100, 999)}-${int(1000, 9999)}.`), 'PA_L1_TEXTO_LIBRE'),

  // L2
  col('FECHA_NACIMIENTO', 'date', 0, many(() => iso(1940, 2010)), 'PA_L2_FECHA_NACIMIENTO'),
  col('FEC_NAC', 'varchar', 10, many(() => iso(1940, 2010)), 'PA_L2_FECHA_NACIMIENTO'),
  col('fechaNacimiento', 'timestamp', 0, many(() => iso(1940, 2010)), 'PA_L2_FECHA_NACIMIENTO'),
  col('ANIO_NACIMIENTO', 'number', 4, many(() => String(int(1940, 2010))), 'PA_L2_ANIO_NACIMIENTO'),
  col('EDAD', 'number', 3, many(() => String(int(0, 99))), 'PA_L2_EDAD'),
  col('FECHA_DEFUNCION', 'date', 0, many(() => iso(2000, 2025)), 'PA_L2_FECHA_EVENTO'),
  col('FECHA_INGRESO', 'date', 0, many(() => iso(2000, 2025)), 'PA_L2_FECHA_EVENTO'),
  col('SEXO', 'char', 1, many(() => pick(['F', 'M'])), 'PA_L2_SEXO'),
  col('GENERO', 'varchar', 10, many(() => pick(['Femenino', 'Masculino'])), 'PA_L2_SEXO'),
  col('DISTRITO', 'varchar', 60, many(() => pick(['Santa Isabel', 'Changuinola', 'David', 'Boquete', 'Las Tablas'])), 'PA_L2_DISTRITO'),
  col('CORREGIMIENTO', 'varchar', 60, many(() => pick(CORREGIMIENTO_NAMES)), 'PA_L2_CORREGIMIENTO'),
  col('CAMPO9', 'varchar', 60, many(() => pick(CORREGIMIENTO_NAMES)), 'PA_L2_CORREGIMIENTO'),
  col('COD_CORREGIMIENTO', 'varchar', 6, many(() => pick(CORREGIMIENTOS).code), 'PA_L2_CODIGO_LUGAR'),
  col('LUGAR_POBLADO', 'varchar', 60, many(() => `Los Llanos ${int(1, 99)}`), 'PA_L2_LUGAR_POBLADO'),
  col('BARRIADA', 'varchar', 60, many(() => pick(['Villa Lucre', 'Cerro Viento', 'Don Bosco', 'Las Cumbres'])), 'PA_L2_BARRIADA'),
  col('CODIGO_POSTAL', 'varchar', 5, many(() => `0${int(1000, 9999)}`), 'PA_L2_CODIGO_POSTAL'),
  col('NACIONALIDAD', 'varchar', 20, many(() => pick(['Panameña', 'Colombiana', 'Venezolana'])), 'PA_L2_NACIONALIDAD'),
  col('ESTADO_CIVIL', 'varchar', 30, many(() => pick(['Soltero', 'Casada', 'Unido'])), 'PA_L2_ESTADO_CIVIL'),
  col('OCUPACION', 'varchar', 60, many(() => pick(['Comerciante', 'Obrero', 'Educador'])), 'PA_L2_OCUPACION'),
  col('PUESTO', 'varchar', 60, many(() => pick(['Analista', 'Jefe de departamento', 'Vendedor'])), 'PA_L2_OCUPACION'),
  col('NOMBRE_PATRONO', 'varchar', 80, many(() => `Comercial ${int(1, 99)}, S.A.`), 'PA_L2_EMPLEADOR'),
  col('ESCOLARIDAD', 'varchar', 40, many(() => pick(['Premedia completa', 'Universitaria'])), 'PA_L2_ESCOLARIDAD'),
  col('COLEGIO', 'varchar', 80, many(() => `Centro Básico General ${pick(['Guararé', 'Las Mañanitas'])}`), 'PA_L2_ESCUELA'),
  col('NUM_HIJOS', 'number', 2, many(() => String(int(0, 8))), 'PA_L2_DEPENDIENTES'),

  // L3
  col('GRUPO_INDIGENA', 'varchar', 30, many(() => pick(['Ngäbe', 'Guna', 'Emberá', 'Ninguno'])), 'PA_L3_ETNIA'),
  col('AFRODESCENDIENTE', 'char', 1, many(() => pick(['S', 'N'])), 'PA_L3_ETNIA'),
  col('CAMPO10', 'varchar', 30, many(() => pick(['Ngäbe', 'Buglé', 'Guna', 'Wounaan', 'Afropanameño'])), 'PA_L3_ETNIA'),
  col('LENGUA_INDIGENA', 'varchar', 30, many(() => pick(['Ngäbere', 'Guna', 'Emberá', 'No habla lengua indígena'])), 'PA_L3_LENGUA_INDIGENA'),
  col('DIAGNOSTICO', 'varchar', 10, many(() => pick(['E11.9', 'I10', 'J45.9', 'F32.1'])), 'PA_L3_SALUD_DIAGNOSTICO'),
  col('CIE10', 'varchar', 6, many(() => pick(['E11', 'I10', 'F20', 'B20'])), 'PA_L3_SALUD_DIAGNOSTICO'),
  col('MEDICAMENTO', 'varchar', 40, many(() => pick(['Sertralina', 'Acetaminofén', 'Metformina'])), 'PA_L3_SALUD_MEDICAMENTO'),
  col('NUM_HISTORIA_CLINICA', 'varchar', 12, many(() => String(int(100000, 999999))), 'PA_L3_SALUD_IDENTIFICADOR'),
  col('NOTA_EVOLUCION', 'clob', 4000, many(() => `Paciente refiere dolor abdominal de ${int(1, 9)} días de evolución.`), 'PA_L3_SALUD_TEXTO_CLINICO'),
  col('RESULTADO_VIH', 'varchar', 12, many(() => pick(['Reactivo', 'No reactivo'])), 'PA_L3_SALUD_RESULTADO_EXAMEN'),
  col('TIPO_SANGRE', 'varchar', 4, many(() => pick(['A+', 'O-', 'AB+'])), 'PA_L3_SALUD_GRUPO_SANGUINEO'),
  col('TIPO_DISCAPACIDAD', 'varchar', 40, many(() => pick(['Física', 'Visual', 'Sin discapacidad'])), 'PA_L3_SALUD_DISCAPACIDAD'),
  col('EMBARAZO', 'char', 1, many(() => pick(['S', 'N'])), 'PA_L3_SALUD_SEXUAL_REPRODUCTIVA'),
  col('SALUD_MENTAL', 'varchar', 60, many(() => pick(['Depresión', 'Ansiedad'])), 'PA_L3_SALUD_MENTAL_ADICCIONES'),
  col('HUELLA_DACTILAR', 'varchar', 200, many(() => many(() => pick('ABCDEF0123456789'), 64).join('')), 'PA_L3_BIOMETRICO'),
  col('PERFIL_GENETICO', 'varchar', 200, many(() => 'AGTC'.repeat(10)), 'PA_L3_INFORMACION_GENETICA'),
  col('ORIENTACION_SEXUAL', 'varchar', 30, many(() => pick(['Heterosexual', 'Gay', 'Bisexual'])), 'PA_L3_ORIENTACION_SEXUAL'),
  col('IDENTIDAD_GENERO', 'varchar', 30, many(() => pick(['Mujer', 'Hombre trans', 'No binario'])), 'PA_L3_IDENTIDAD_GENERO'),
  col('VIDA_SEXUAL', 'varchar', 30, many(() => 'Activa'), 'PA_L3_VIDA_SEXUAL'),
  col('RELIGION', 'varchar', 40, many(() => pick(['Católica', 'Evangélica', 'Sin religión'])), 'PA_L3_RELIGION'),
  col('OBJECION_CONCIENCIA', 'varchar', 60, many(() => pick(['Transfusiones', 'Ninguna'])), 'PA_L3_CREENCIA_FILOSOFICA_MORAL'),
  col('PREFERENCIA_ELECTORAL', 'varchar', 40, many(() => pick(['Izquierda', 'Derecha', 'Centro'])), 'PA_L3_OPINION_POLITICA'),
  col('PARTIDO_POLITICO', 'varchar', 60, many(() => pick(['Partido Revolucionario Democrático', 'Realizando Metas', 'Movimiento Otro Camino'])), 'PA_L3_AFILIACION_POLITICA'),
  col('SINDICALIZADO', 'char', 1, many(() => pick(['S', 'N'])), 'PA_L3_AFILIACION_SINDICAL'),

  // FIN
  col('SCORE_APC', 'number', 3, many(() => String(int(300, 950))), 'PA_FIN_REFERENCIA_CREDITO'),
  col('MOROSIDAD', 'varchar', 30, many(() => pick(['Al día', 'Morosidad de 90 días'])), 'PA_FIN_REFERENCIA_CREDITO'),
  col('SALDO_PRESTAMO', 'number', 12, many(() => String(int(1000, 90000))), 'PA_FIN_MONTO_DEUDA'),
  col('SALARIO_MENSUAL', 'number', 10, many(() => String(int(650, 9000))), 'PA_FIN_INGRESO_MENSUAL'),
  col('VALOR_CATASTRAL', 'number', 12, many(() => String(int(30000, 900000))), 'PA_FIN_PATRIMONIO'),
  col('MONTO_PENSION', 'number', 8, many(() => String(int(120, 3000))), 'PA_FIN_PENSION'),
  col('TIPO_ASEGURADO', 'varchar', 40, many(() => pick(['Asegurado directo', 'Beneficiario', 'No tiene seguro social'])), 'PA_FIN_SEGURO_SOCIAL'),
  col('PROGRAMA_SOCIAL', 'varchar', 60, many(() => pick(['120 a los 65', 'Red de Oportunidades', 'Ángel Guardián'])), 'PA_FIN_PROGRAMA_SOCIAL'),
  col('NIVEL_POBREZA', 'varchar', 20, many(() => pick(['Pobreza extrema', 'Pobreza general', 'No pobre'])), 'PA_FIN_NIVEL_SOCIOECONOMICO'),
  col('TENENCIA_VIVIENDA', 'varchar', 30, many(() => pick(['Propia', 'Alquilada', 'Cedida o prestada'])), 'PA_FIN_VIVIENDA'),

  // PENAL
  col('RECORD_POLICIVO', 'varchar', 30, many(() => pick(['Sin antecedentes penales', 'Con antecedentes penales'])), 'PA_PENAL_ANTECEDENTES'),
  col('NUM_CARPETILLA', 'varchar', 15, many(() => String(int(100000000000, 999999999999))), 'PA_PENAL_CAUSA'),

  // Not personal data: nothing should be assigned
  col('ID', 'integer', 10, many((i) => String(i + 1)), ''),
  col('ESTRUCTURA', 'varchar', 40, many(() => pick(['Árbol', 'Lista'])), ''),
  col('RUTA_ARCHIVO', 'varchar', 200, many(() => `/datos/archivo${int(1, 99)}.txt`), ''),
  col('NOMBRE_PRODUCTO', 'varchar', 80, many(() => pick(['Leche entera 1L', 'Arroz 5 lb', 'Café molido 400 g'])), ''),
  col('NOMBRE_EMPRESA', 'varchar', 80, many(() => `Comercial ${int(1, 99)}, S.A.`), ''),
  col('MONTO_VENTA', 'number', 12, many(() => String(int(1000, 99999999))), ''),
  col('FECHA_CREACION', 'date', 0, many(() => iso(2015, 2025)), ''),
  col('FECHA_DOC', 'varchar', 10, many(() => `${pad2(int(1, 12))}-${pad2(int(1, 12))}-${int(2015, 2025)}`), ''),
  col('CODIGO', 'varchar', 10, many(() => `A-${int(100, 999)}`), ''),
  col('DESCRIPCION_PRODUCTO', 'varchar', 400, many(() => 'Producto de consumo básico, empaque de cartón reciclable.'), ''),
  col('ESTATUS', 'varchar', 10, many(() => pick(['ACTIVO', 'INACTIVO'])), ''),
  col('CANTIDAD', 'number', 6, many(() => String(int(1, 500))), ''),
  col('SKU', 'varchar', 12, many(() => `SKU${int(10000, 99999)}`), ''),
  col('HOTEL', 'varchar', 60, many(() => 'Hotel Central'), ''),
  col('TRANSACCION_ID', 'varchar', 36, many(() => `TX${int(100000, 999999)}`), ''),
  col('DEPARTAMENTO', 'varchar', 40, many(() => pick(['Finanzas', 'Operaciones'])), ''),
  col('CLAVE_PRODUCTO', 'varchar', 10, many(() => `P-${int(100, 999)}`), ''),
  col('CARGO_FIJO', 'number', 8, many(() => String(int(1000, 9999))), ''),
  col('LONGITUD_CABLE', 'number', 6, many(() => `${int(1, 99)}.5`), ''),
  col('PAGE_URL', 'varchar', 200, many(() => `https://www.ejemplo.com.pa/p/${int(1, 999)}`), ''),
  col('TIPO_DOCUMENTO', 'varchar', 20, many(() => pick(['Factura', 'Nota de crédito'])), ''),
  col('MONEDA', 'varchar', 3, many(() => pick(['PAB', 'USD'])), ''),
  col('CATEGORIA', 'varchar', 30, many(() => pick(['Lácteos', 'Panadería'])), ''),
  col('PROVINCIA', 'varchar', 30, many(() => pick(['Chiriquí', 'Coclé', 'Veraguas'])), ''),
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

  let passed = 0
  for (const column of COLUMNS) {
    const field = { name: column.name, parent: null, sqlType: column.sqlType, length: column.length || null, autoIncrement: false, values: column.values }
    const result = kit.evaluateField({ classifiers: resolved, field, threshold: preset.profileSet.threshold, readFile })
    if (result.assigned === column.expect) { passed++; continue }
    failures++
    const ranking = result.ranking.slice(0, 3).map((r) => `${r.domain} ${r.percent}%`).join(', ')
    console.log(`  ✗ ${column.name}: expected ${column.expect || '(none)'}, got ${result.assigned || '(none)'} — ${ranking}`)
  }
  console.log(`profiled ${COLUMNS.length} columns: ${passed} as expected`)
}

// ── Algorithms ──────────────────────────────────────────────────────────────

const words = (s) => s.trim().split(/\s+/).length
const sameShape = (i, o) => i.length === o.length && i.replace(/[A-Z]/g, 'A').replace(/\d/g, '9') === o.replace(/[A-Z]/g, 'A').replace(/\d/g, '9')
const MASKING = {
  PA_L1_CEDULA: {
    inputs: ['8-442-445', 'E-8-123456', 'N-19-1234', 'PE-10-442', '1AV-432-658', '4PI-234-123', '8-NT-12-3456', '8 442 445', 'Juan', ...many(cedula, 40)],
    // Text that is not a cédula still has to be masked, not passed through.
    check: (i, o) => (CEDULA_SHAPE.test(i) ? sameCedulaShape(i, o) : o !== i),
  },
  PA_L1_RUC: {
    inputs: ['8-442-445 DV 08', 'PE-10-442 DV 50', 'N-45-832 DV 58', 'E-12-342 DV 10', '1AV-432-658 DV 96', '4PI-234-123 DV 96',
      '8-442-445-08', '8-442-445 DV08', '8-442-445 08', '8-442-445', '155596713-2-2015', '155596713-2-2015 DV 59',
      ...many(() => rucWithDv(), 60)],
    check: (i, o) => {
      if (/^\d{3,}-/.test(i)) return o === i
      const m = i.match(/^(.+?)( DV |-| DV| )(\d\d)$/)
      if (!m) return CEDULA_SHAPE.test(i) ? sameCedulaShape(i, o) : o !== i
      const n = o.match(/^(.+?)( DV |-| DV| )(\d\d)$/)
      return Boolean(n) && n[2] === m[2] && sameCedulaShape(m[1], n[1]) && rucDv(n[1]) === n[3]
    },
    same: true,
  },
  PA_L1_RUC_DV: { inputs: ['08', '96'] },
  PA_L1_PASAPORTE: { inputs: ['PA0123456'] },
  PA_L1_DOCUMENTO_MIGRATORIO: { inputs: ['123456789'] },
  PA_L1_SEGURO_SOCIAL: { inputs: ['123-4567'] },
  PA_L1_IDONEIDAD: { inputs: ['12345'] },
  // Four words fall through to the Character Mapping: it must mask them, not act as a name lookup.
  PA_L1_NOMBRE: { inputs: ['Yamileth', 'LUIS CARLOS', 'Anayansi', 'Ana María José Luisa'], check: (i, o) => words(i) === words(o) },
  PA_L1_APELLIDO: { inputs: ['González', 'RODRÍGUEZ ÁBREGO', 'González de Pérez', 'Montezuma'], check: (i, o) => words(i) === words(o) && (!/ de /i.test(i) || / de /i.test(o)) },
  PA_L1_NOMBRE_COMPLETO: {
    inputs: ['María Elena González de Pérez', 'LUIS CARLOS SÁNCHEZ ÁBREGO', 'Pedro Batista', 'Yamileth Castillo de Moreno', 'González Pérez, Yamileth'],
    check: (i, o) => words(i) === words(o) && (!/ de /i.test(i) || / de /i.test(o)),
  },
  PA_L1_EMAIL: { inputs: ['yamileth.gonzalez@gmail.com', 'josé.núñez@empresa.com.pa'], check: (i, o) => /@[^@]+\.test$/.test(o) },
  PA_L1_TELEFONO: {
    inputs: ['+507 6123-4567', '61234567', '6123-4567', '223-4567', '(507) 775-1234', '507-6612-3456'],
    // +507 and the first digit stay; the length does too.
    check: (i, o) => o.length === i.length && o.startsWith(i.match(/^(\+?\(?507\)?[\s-]?)?\d/)[0]),
  },
  PA_L1_DIRECCION: { inputs: ['Calle 50, Edificio Global Bank, Piso 21, Oficina 2104'] },
  PA_L1_DIRECCION_COMPLEMENTO: { inputs: ['Casa 23', '12B'] },
  PA_L1_CUENTA_BANCARIA: { inputs: ['04-72-01-123456-7'] },
  PA_L1_TARJETA: { inputs: ['4916 3131 2345 6780'] },
  PA_L1_IP: {
    inputs: ['190.140.22.10', '2001:db8::1'],
    check: (i, o) => (i.includes('.') ? o.split('.').every((p) => Number(p) >= 1 && Number(p) <= 254) : /^[0-9a-f:]+$/i.test(o)),
  },
  PA_L1_DISPOSITIVO: { inputs: ['3c:22:fb:9a:10:e4', '356938035643809'], check: (i, o) => (i.includes(':') ? /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(o) : /^\d{15}$/.test(o)) },
  PA_L1_PLACA: {
    inputs: ['AB1234', '123456', 'T12345', 'CD 1234', 'M-45678'],
    check: (i, o) => sameShape(i, o) && (/^[A-Z]{2}\d{4}$/.test(i) || /^\d{6}$/.test(i) || o.match(/^[A-Z]+/)[0] === i.match(/^[A-Z]+/)[0]),
  },
  PA_L1_VIN: { inputs: ['3VWFE21C04M000001'] },
  PA_L1_FINCA: { inputs: ['30162456'] },
  PA_L1_NUMERO_CONTRATO: { inputs: ['POL-123456'] },
  PA_L1_USUARIO_RRSS: { inputs: ['@yami_gonzalez'] },
  PA_L1_CREDENCIAL: { inputs: ['Secreta#2024'], check: (i, o) => /^X+$/.test(o) },
  PA_L1_GEOLOCALIZACION: { inputs: ['8.983333', '8.983333,-79.516667'], check: (i, o) => o.slice(0, 3) === i.slice(0, 3) },
  PA_L1_TEXTO_LIBRE: {
    inputs: ['Cliente González, cédula 8-442-445, correo y.gonzalez@gmail.com, tel 6123-4567.'],
    check: (i, o) => !/8-442-445|y\.gonzalez@gmail\.com|6123-4567/.test(o),
  },
  PA_L2_FECHA_NACIMIENTO: { inputs: ['1985-07-20', '2008-01-15'], check: (i, o) => Math.abs(new Date(o.slice(0, 10)) - new Date(i)) <= 60 * 864e5 },
  PA_L2_ANIO_NACIMIENTO: { inputs: ['1985'], check: (i, o) => o.startsWith('198'), same: true },
  PA_L2_EDAD: { inputs: ['37', '7', '104'], check: (i, o) => (i === '104' ? o === '90' : i.length === 1 || o[0] === i[0]), same: true },
  PA_L2_FECHA_EVENTO: { inputs: ['2021-03-15'] },
  PA_L2_SEXO: { inputs: ['F', 'M', 'H', 'Femenino', 'hombre'], same: true },
  PA_L2_DISTRITO: { inputs: ['Santa Isabel', 'David', 'Taboga', 'SANTA ISABEL'], same: true },
  PA_L2_CORREGIMIENTO: { inputs: ['Cerro Punta', 'Bella Vista', 'Tocumen', 'Nämnoni'], same: true },
  PA_L2_CODIGO_LUGAR: { inputs: ['040612', '80812', '0306', '0801'], same: true },
  PA_L2_LUGAR_POBLADO: { inputs: ['Los Llanos de Ocú'] },
  PA_L2_BARRIADA: { inputs: ['Villa Guadalupe'] },
  PA_L2_CODIGO_POSTAL: { inputs: ['0801', '07090'], check: (i, o) => o === `${i.slice(0, 2)}${'0'.repeat(i.length - 2)}`, same: true },
  PA_L2_NACIONALIDAD: { inputs: ['Venezolana'], same: true },
  PA_L2_ESTADO_CIVIL: { inputs: ['Unida'], same: true },
  PA_L2_OCUPACION: { inputs: ['Gerente Regional de Operaciones Bocas del Toro'] },
  PA_L2_EMPLEADOR: { inputs: ['Autoridad del Canal de Panamá'] },
  PA_L2_ESCOLARIDAD: { inputs: ['Premedia completa'], same: true },
  PA_L2_ESCUELA: { inputs: ['Instituto Nacional de Panamá'] },
  PA_L2_DEPENDIENTES: { inputs: ['9', '2'], check: (i, o) => Number(o) <= 5, same: true },
  PA_L3_ETNIA: { inputs: ['Teribe', 'S'], same: true },
  PA_L3_LENGUA_INDIGENA: { inputs: ['Teribe', 'N'], same: true },
  PA_L3_SALUD_DIAGNOSTICO: { inputs: ['F32.9', 'B20', 'Depresión mayor'], same: true },
  PA_L3_SALUD_MEDICAMENTO: { inputs: ['Sertralina 50 mg'] },
  PA_L3_SALUD_IDENTIFICADOR: { inputs: ['HC-2024-00123'] },
  PA_L3_SALUD_TEXTO_CLINICO: { inputs: ['Paciente Batista, cédula 8-442-445, acude por cefalea.'], check: (i, o) => !o.includes('8-442-445') },
  PA_L3_SALUD_RESULTADO_EXAMEN: { inputs: ['Reactivo'] },
  PA_L3_SALUD_GRUPO_SANGUINEO: { inputs: ['O+'], same: true },
  PA_L3_SALUD_DISCAPACIDAD: { inputs: ['Discapacidad psicosocial severa', 'N'], same: true },
  PA_L3_SALUD_SEXUAL_REPRODUCTIVA: { inputs: ['Embarazo de 12 semanas', 'S'], same: true },
  PA_L3_SALUD_MENTAL_ADICCIONES: { inputs: ['Trastorno bipolar'] },
  PA_L3_BIOMETRICO: { inputs: ['A1B2C3D4E5F6'] },
  PA_L3_INFORMACION_GENETICA: { inputs: ['BRCA1 positivo'] },
  PA_L3_ORIENTACION_SEXUAL: { inputs: ['Bisexual'], same: true },
  PA_L3_IDENTIDAD_GENERO: { inputs: ['Hombre trans'], same: true },
  PA_L3_VIDA_SEXUAL: { inputs: ['Activa'] },
  PA_L3_RELIGION: { inputs: ['Episcopal'], same: true },
  PA_L3_CREENCIA_FILOSOFICA_MORAL: { inputs: ['Rechaza transfusiones'] },
  PA_L3_OPINION_POLITICA: { inputs: ['Centro derecha'], same: true },
  PA_L3_AFILIACION_POLITICA: { inputs: ['Partido Liberal'], same: true },
  PA_L3_AFILIACION_SINDICAL: { inputs: ['SUNTRACS', 'S'], same: true },
  PA_FIN_REFERENCIA_CREDITO: { inputs: ['Morosidad de 90 días', '745', 'N'], same: true },
  PA_FIN_MONTO_DEUDA: { inputs: ['8500'] },
  PA_FIN_INGRESO_MENSUAL: { inputs: ['1850', '1850.50'] },
  PA_FIN_PATRIMONIO: { inputs: ['185000'] },
  PA_FIN_PENSION: { inputs: ['680'] },
  PA_FIN_SEGURO_SOCIAL: { inputs: ['Beneficiario', 'S'], same: true },
  PA_FIN_PROGRAMA_SOCIAL: { inputs: ['Vale Digital', 'N'], same: true },
  PA_FIN_NIVEL_SOCIOECONOMICO: { inputs: ['Pobreza extrema', '3', 'Decil 8', 'Quintil 2'], same: true },
  PA_FIN_VIVIENDA: { inputs: ['Invasión'], same: true },
  PA_PENAL_ANTECEDENTES: { inputs: ['Condenado por hurto', 'S'], same: true },
  PA_PENAL_CAUSA: { inputs: ['202400012345', '1234-2023'] },
}

// What a masked value may be. A lookup answering from the wrong list still changes the value, so
// "changed" alone cannot see it: flags must stay in their vocabulary, list values must come from
// their own list.
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
const BY_CODE = new Map(CORREGIMIENTOS.map((c) => [c.code, c]))
const BIG = new Map(CORREGIMIENTOS.map((c) => [c.name, c.population]))
const EXPECT = {
  PA_L1_NOMBRE: (i, o) => words(i) > 3 || o.split(/\s+/).every((w) => has('pa-nombres.txt', w)),
  PA_L1_APELLIDO: (i, o) => o.split(/\s+/).filter((w) => !/^de$/i.test(w)).every((w) => has('pa-apellidos.txt', w)),
  PA_L1_NOMBRE_COMPLETO: (i, o) => i.includes(',') || (has('pa-nombres.txt', o.split(/\s+/)[0]) && has('pa-apellidos.txt', o.split(/\s+/).at(-1))),
  PA_L1_DIRECCION: (i, o) => has('pa-direcciones.txt', o),
  PA_L2_SEXO: (i, o) => ({ f: ['f', 'm'], m: ['f', 'm'], h: ['h', 'm'], femenino: ['femenino', 'masculino'], hombre: ['mujer', 'hombre'] })[i.toLowerCase()].includes(o.toLowerCase()),
  // Santa Isabel (Colón, 4,111) and Taboga become a district of 20,000 or more; David stays.
  PA_L2_DISTRITO: (i, o) => (i === 'David' ? o === i : o !== i && o.toLowerCase() !== i.toLowerCase()),
  // Cerro Punta (under 10,000) and Nämnoni become a corregimiento of 10,000 or more; Tocumen stays.
  PA_L2_CORREGIMIENTO: (i, o) => (i === 'Tocumen' ? o === i : i === 'Bella Vista' ? o === i : (BIG.get(o) ?? 0) >= 10000),
  PA_L2_CODIGO_LUGAR: (i, o) => {
    if (i.length <= 4) return /^\d{3,4}$/.test(o)
    const from = BY_CODE.get(i.padStart(6, '0'))
    const to = BY_CODE.get(o.padStart(6, '0'))
    return Boolean(to) && to.population >= 10000 && (from.population < 10000 || to === from)
  },
  PA_L2_LUGAR_POBLADO: (i, o) => has('pa-lugares-poblados.txt', o),
  PA_L2_BARRIADA: (i, o) => has('pa-barriadas.txt', o),
  PA_L2_NACIONALIDAD: (i, o) => has('pa-nacionalidades.txt', o),
  PA_L2_ESTADO_CIVIL: (i, o) => has('pa-estado-civil.txt', o),
  PA_L2_OCUPACION: (i, o) => has('pa-ocupaciones.txt', o),
  PA_L2_EMPLEADOR: (i, o) => has('pa-empleadores.txt', o),
  PA_L2_ESCOLARIDAD: (i, o) => has('pa-escolaridad.txt', o),
  PA_L2_ESCUELA: (i, o) => has('pa-escuelas.txt', o),
  PA_L3_ETNIA: (i, o) => flag(i, o) ?? has('pa-pueblos.txt', o),
  PA_L3_LENGUA_INDIGENA: (i, o) => flag(i, o) ?? has('pa-lenguas.txt', o),
  PA_L3_SALUD_DIAGNOSTICO: (i, o) => (/\.\d/.test(i) ? has('pa-cie10-decimal.txt', o) : /^[A-Z]\d{2}$/i.test(i) ? has('pa-cie10.txt', o) : has('pa-diagnosticos.txt', o)),
  PA_L3_SALUD_MEDICAMENTO: (i, o) => has('pa-medicamentos.txt', o),
  PA_L3_SALUD_GRUPO_SANGUINEO: (i, o) => has('pa-grupo-sanguineo.txt', o),
  PA_L3_SALUD_DISCAPACIDAD: (i, o) => flag(i, o) ?? has('pa-discapacidad.txt', o),
  PA_L3_SALUD_SEXUAL_REPRODUCTIVA: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  PA_L3_SALUD_MENTAL_ADICCIONES: (i, o) => o === SUPPRESSED,
  PA_L3_VIDA_SEXUAL: (i, o) => o === SUPPRESSED,
  PA_L3_CREENCIA_FILOSOFICA_MORAL: (i, o) => o === SUPPRESSED,
  PA_L3_AFILIACION_SINDICAL: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  PA_L3_ORIENTACION_SEXUAL: (i, o) => has('pa-orientacion-sexual.txt', o),
  PA_L3_IDENTIDAD_GENERO: (i, o) => has('pa-identidad-genero.txt', o),
  PA_L3_RELIGION: (i, o) => has('pa-religiones.txt', o),
  PA_L3_OPINION_POLITICA: (i, o) => has('pa-opiniones-politicas.txt', o),
  PA_L3_AFILIACION_POLITICA: (i, o) => has('pa-partidos.txt', o),
  PA_FIN_REFERENCIA_CREDITO: (i, o) => flag(i, o) ?? (/^\d{3}$/.test(i) ? /^\d{3}$/.test(o) : has('pa-referencia-credito.txt', o)),
  PA_FIN_SEGURO_SOCIAL: (i, o) => flag(i, o) ?? has('pa-seguro-social.txt', o),
  PA_FIN_PROGRAMA_SOCIAL: (i, o) => flag(i, o) ?? has('pa-programas-sociales.txt', o),
  PA_FIN_NIVEL_SOCIOECONOMICO: (i, o) => (/^\d$/.test(i) ? /^[1-5]$/.test(o) : /^decil/i.test(i) ? /^Decil ([1-9]|10)$/.test(o) : /^quintil/i.test(i) ? /^Quintil [1-5]$/.test(o) : has('pa-pobreza.txt', o)),
  PA_FIN_VIVIENDA: (i, o) => has('pa-vivienda.txt', o),
  PA_PENAL_ANTECEDENTES: (i, o) => flag(i, o) ?? has('pa-antecedentes.txt', o),
}

async function mask(framework, config, input, additionalAlgorithms) {
  const res = await fetch(`${API}/api/mask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ framework, config, input, additionalAlgorithms }),
  })
  return res.json()
}

async function verifyAlgorithms() {
  const additional = preset.algorithms.map((a) => ({ name: a.name, className: a.framework, config: resolve(a.config) }))
  const byName = new Map(preset.algorithms.map((a) => [a.name, a]))
  const missing = preset.domains.map((d) => d.name).filter((d) => !MASKING[d])
  if (missing.length) { failures++; console.log(`  ✗ domains with no masking test: ${missing.join(', ')}`) }
  const run = (algorithmName, input) => { const algo = byName.get(algorithmName); return mask(algo.framework, resolve(algo.config), input, additional).catch((err) => ({ error: err.message })) }

  const jobs = preset.domains.flatMap((d) => (MASKING[d.name]?.inputs ?? []).map((input) => ({ domain: d, input })))
  // Real columns hold placeholders too. Masking them may change them or not, but must not fail —
  // except in typed columns (dates, amounts), where the database would not hold them.
  const TYPED = new Set(['PA_L2_FECHA_NACIMIENTO', 'PA_L2_FECHA_EVENTO', 'PA_FIN_MONTO_DEUDA', 'PA_FIN_INGRESO_MENSUAL', 'PA_FIN_PATRIMONIO', 'PA_FIN_PENSION'])
  for (const d of preset.domains.filter((x) => !TYPED.has(x.name))) {
    for (const input of ['N/D', 'sin dato', '-']) jobs.push({ domain: d, input, placeholder: true })
  }
  let passed = 0
  let next = 0
  const lines = []
  async function worker() {
    while (next < jobs.length) {
      const { domain, input, placeholder } = jobs[next++]
      const test = MASKING[domain.name]
      const out = await run(domain.algorithm, input)
      const output = out.output
      const problem = output == null ? `error: ${out.error}`
        : placeholder ? null
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

  // A person's RUC is their cédula: masked, the RUC must still be the masked cédula.
  let agree = 0
  const people = many(() => cedula(), 20)
  for (const c of people) {
    const [mc, mr] = [(await run('PA_CEDULA', c)).output, (await run('PA_RUC', rucWithDv(c))).output]
    if (mc && mr && mr.startsWith(`${mc} DV `)) agree++
    else { failures++; console.log(`  ✗ cédula ${c} → ${mc} and its RUC → ${mr} no longer agree`) }
  }
  console.log(`cédula and RUC of the same person: ${agree} of ${people.length} still agree`)

  // Different keys must stay different: a cédula or RUC used as a key cannot collide.
  for (const [algorithmName, make] of [['PA_CEDULA', cedula], ['PA_RUC', () => rucWithDv()]]) {
    const inputs = [...new Set(many(make, 150))]
    const outputs = new Map()
    for (const input of inputs) outputs.set(input, (await run(algorithmName, input)).output)
    const distinct = new Set(outputs.values()).size
    if (distinct !== inputs.length) { failures++; console.log(`  ✗ ${algorithmName}: ${inputs.length} inputs gave ${distinct} distinct outputs`) }
    else console.log(`${algorithmName}: ${inputs.length} distinct inputs, ${distinct} distinct outputs`)
    if (algorithmName === 'PA_RUC') {
      const invalid = [...outputs.values()].filter((o) => !validRucDv(o))
      if (invalid.length) { failures++; console.log(`  ✗ PA_RUC: ${invalid.length} masked RUCs without a valid DV, e.g. ${invalid.slice(0, 3).join(', ')}`) }
      else console.log(`PA_RUC: every masked RUC has a valid DV`)
    }
  }
}

if (only !== 'algorithms') verifyClassifiers()
if (only !== 'classifiers') await verifyAlgorithms()
console.log(failures ? `\n${failures} problem(s)` : '\nall good')
process.exit(failures ? 1 : 0)
