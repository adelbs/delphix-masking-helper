#!/usr/bin/env node
/**
 * Checks the Mexico (LFPDPPP) preset.
 *
 *   node presets/mexico-lfpdppp/verify.mjs               # classifiers, then algorithms
 *   node presets/mexico-lfpdppp/verify.mjs classifiers   # only the local profiling check
 *   node presets/mexico-lfpdppp/verify.mjs algorithms    # only masking, against the app
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

// ── Test data ───────────────────────────────────────────────────────────────

let seed = 52
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
const MUNICIPIOS = source('municipios.tsv').map((l) => { const [code, name, state, , , population] = l.split('\t'); return { code, name, state, population: Number(population) } })
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '')
const PERSONAL = new Set([...NOMBRES, ...APELLIDOS].map((w) => fold(w).toLowerCase()))
const MUNICIPIO_NAMES = MUNICIPIOS.map((m) => m.name).filter((n) => !PERSONAL.has(fold(n).toLowerCase()))

const pad2 = (n) => String(n).padStart(2, '0')
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const VOWELS = 'AEIOU'
const CONSONANTS = 'BCDFGHJKLMNPQRSTVWXYZ'
const ENTIDADES = ['AS', 'BC', 'BS', 'CC', 'CL', 'CM', 'CS', 'CH', 'DF', 'DG', 'GT', 'GR', 'HG', 'JC', 'MC', 'MN', 'MS', 'NT', 'NL', 'OC', 'PL', 'QT', 'QR', 'SP', 'SL', 'SR', 'TC', 'TS', 'TL', 'VZ', 'YN', 'ZS', 'NE']
const yymmdd = () => `${pad2(int(0, 99))}${pad2(int(1, 12))}${pad2(int(1, 28))}`

const CURP_TABLE = '0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ'
const curpDigit = (body) => { let s = 0; for (let i = 0; i < 17; i++) s += CURP_TABLE.indexOf(body[i]) * (18 - i); return String((10 - (s % 10)) % 10) }
const curp = () => {
  const body = `${pick(LETTERS)}${pick(VOWELS)}${pick(LETTERS)}${pick(LETTERS)}${yymmdd()}${pick('HM')}${pick(ENTIDADES)}${many(() => pick(CONSONANTS), 3).join('')}${pick('0123456789ABCDEF')}`
  return body + curpDigit(body)
}
const RFC_TABLE = '0123456789ABCDEFGHIJKLMN&OPQRSTUVWXYZ Ñ'
const rfcDigit = (body) => {
  const s12 = body.length === 11 ? ` ${body}` : body
  let s = 0
  for (let i = 0; i < 12; i++) s += RFC_TABLE.indexOf(s12[i]) * (13 - i)
  const r = s % 11
  return r === 0 ? '0' : r === 1 ? 'A' : String(11 - r)
}
const rfc = (company = false) => {
  const body = `${many(() => pick(LETTERS), company ? 3 : 4).join('')}${yymmdd()}${pick(LETTERS + '0123456789')}${pick(LETTERS + '0123456789')}`
  return body + rfcDigit(body)
}
const nssDigit = (ten) => { let s = 0; for (let i = 0; i < 10; i++) { const v = Number(ten[i]) * (i % 2 === 0 ? 1 : 2); s += v > 9 ? v - 9 : v } return String((10 - (s % 10)) % 10) }
const nss = () => { const ten = `${pad2(int(1, 99))}${pad2(int(0, 25))}${pad2(int(40, 99))}${String(int(0, 9999)).padStart(4, '0')}`; return ten + nssDigit(ten) }
const clabeDigit = (d17) => { let s = 0; for (let i = 0; i < 17; i++) s += (Number(d17[i]) * [3, 7, 1][i % 3]) % 10; return String((10 - (s % 10)) % 10) }
const clabe = () => { const d = `${pick(['002', '012', '014', '021', '030', '036', '044', '058', '072', '127', '137', '646'])}${String(int(0, 999)).padStart(3, '0')}${many(() => int(0, 9), 11).join('')}`; return d + clabeDigit(d) }
const claveElector = () => `${many(() => pick(CONSONANTS), 6).join('')}${yymmdd()}${pad2(int(1, 32))}${pick('HM')}${String(int(0, 999)).padStart(3, '0')}`
const luhn = (prefix, length) => {
  const digits = [...prefix].map(Number)
  while (digits.length < length - 1) digits.push(int(0, 9))
  const sum = digits.slice().reverse().reduce((s, d, i) => s + (i % 2 === 0 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0)
  return digits.join('') + String((10 - (sum % 10)) % 10)
}
const iso = (y0, y1) => `${int(y0, y1)}-${pad2(int(1, 12))}-${pad2(int(1, 28))}`
const fullName = () => `${pick(NOMBRES)}${random() < 0.4 ? ` ${pick(NOMBRES)}` : ''} ${pick(APELLIDOS)} ${pick(APELLIDOS)}`
const PL = 'ABCDEFGHJKLMNPRSTUVWXYZ'
const plate = () => `${many(() => pick(PL), 3).join('')}-${int(100, 999)}-${pick(PL)}`
const phone = () => pick([`55 ${int(1000, 9999)} ${int(1000, 9999)}`, `+52 33 ${int(1000, 9999)} ${int(1000, 9999)}`, `${pick(['222', '442', '999', '664'])}${int(1000000, 9999999)}`])

const validDate = (s) => { const m = Number(s.slice(2, 4)); const d = Number(s.slice(4, 6)); return m >= 1 && m <= 12 && d >= 1 && d <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] }
const validCurp = (s) => /^[A-Z]{4}\d{6}[HMX][A-Z]{5}[0-9A-Z]\d$/.test(s) && validDate(s.slice(4, 10)) && ENTIDADES.includes(s.slice(11, 13)) && curpDigit(s) === s[17]
const validRfc = (s) => /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{2}[0-9A]$/.test(s) && validDate(s.slice(-9, -3)) && rfcDigit(s.slice(0, -1)) === s.at(-1)
const validNss = (s) => /^\d{11}$/.test(s) && nssDigit(s) === s[10]
const validClabe = (s) => /^\d{18}$/.test(s) && clabeDigit(s) === s[17]

// ── Classifiers ─────────────────────────────────────────────────────────────

const SQL = { varchar: 12, char: 1, number: 2, integer: 4, date: 91, timestamp: 93, clob: 2005 }
const col = (name, type, length, values, expect) => ({ name, sqlType: SQL[type], length, values, expect })

const COLUMNS = [
  // L1 — well named
  col('CURP', 'char', 18, many(curp), 'MX_L1_CURP'),
  col('CURP_TRABAJADOR', 'varchar', 18, many(curp), 'MX_L1_CURP'),
  col('curpCliente', 'varchar', 20, many(curp), 'MX_L1_CURP'),
  col('RFC', 'varchar', 13, many(() => rfc()), 'MX_L1_RFC'),
  col('RfcReceptor', 'varchar', 13, many(() => rfc(random() < 0.3)), 'MX_L1_RFC'),
  col('RFC_EMPLEADO', 'varchar', 13, many(() => rfc()), 'MX_L1_RFC'),
  col('NSS', 'varchar', 11, many(nss), 'MX_L1_NSS'),
  col('NUM_SEGURO_SOCIAL', 'varchar', 11, many(nss), 'MX_L1_NSS'),
  col('CLAVE_ELECTOR', 'char', 18, many(claveElector), 'MX_L1_CLAVE_ELECTOR'),
  col('OCR_INE', 'varchar', 13, many(() => String(int(1e12, 9.99e12))), 'MX_L1_CREDENCIAL_INE'),
  col('CIC', 'varchar', 9, many(() => String(int(1e8, 9.99e8))), 'MX_L1_CREDENCIAL_INE'),
  col('NOMBRE', 'varchar', 120, many(fullName), 'MX_L1_NOMBRE_COMPLETO'),
  col('NOMBRES', 'varchar', 60, many(() => `${pick(NOMBRES)}${random() < 0.5 ? ` ${pick(NOMBRES)}` : ''}`), 'MX_L1_NOMBRE'),
  col('PRIMER_NOMBRE', 'varchar', 30, many(() => pick(NOMBRES)), 'MX_L1_NOMBRE'),
  col('APELLIDO_PATERNO', 'varchar', 30, many(() => pick(APELLIDOS)), 'MX_L1_APELLIDO'),
  col('AP_MATERNO', 'varchar', 30, many(() => pick(APELLIDOS)), 'MX_L1_APELLIDO'),
  col('NOMBRE_COMPLETO', 'varchar', 120, many(fullName), 'MX_L1_NOMBRE_COMPLETO'),
  col('NOMBRE_DERECHOHABIENTE', 'varchar', 120, many(fullName), 'MX_L1_NOMBRE_COMPLETO'),
  col('EMAIL', 'varchar', 100, many(() => `${fold(pick(NOMBRES)).toLowerCase()}.${int(1, 999)}@gmail.com`), 'MX_L1_EMAIL'),
  col('CORREO_ELECTRONICO', 'varchar', 100, many(() => `contacto${int(1, 999)}@empresa.com.mx`), 'MX_L1_EMAIL'),
  col('TEL_CELULAR', 'varchar', 20, many(phone), 'MX_L1_TELEFONO'),
  col('TELEFONO', 'varchar', 12, many(() => `55${int(10000000, 99999999)}`), 'MX_L1_TELEFONO'),
  col('DOMICILIO', 'varchar', 120, many(() => `Calle Hidalgo ${int(1, 999)}`), 'MX_L1_DIRECCION'),
  col('CALLE', 'varchar', 120, many(() => `Av. Insurgentes Sur ${int(1, 3000)} Int. ${int(1, 20)}`), 'MX_L1_DIRECCION'),
  col('NUM_EXT', 'varchar', 6, many(() => String(int(1, 3000))), 'MX_L1_DIRECCION_COMPLEMENTO'),
  col('CLABE', 'varchar', 18, many(clabe), 'MX_L1_CLABE'),
  col('CUENTA_CLABE', 'varchar', 18, many(clabe), 'MX_L1_CLABE'),
  col('NUM_CUENTA', 'varchar', 11, many(() => String(int(1e9, 9.9e10))), 'MX_L1_CUENTA_BANCARIA'),
  col('NUMERO_TARJETA', 'varchar', 19, many(() => luhn('4', 16)), 'MX_L1_TARJETA'),
  col('PASAPORTE', 'varchar', 10, many(() => `G${int(10000000, 99999999)}`), 'MX_L1_PASAPORTE'),
  col('TARJETA_RESIDENTE', 'varchar', 14, many(() => `${int(100000000, 999999999)}`), 'MX_L1_DOCUMENTO_MIGRATORIO'),
  col('CEDULA_PROFESIONAL', 'varchar', 8, many(() => String(int(1000000, 12999999))), 'MX_L1_CEDULA_PROFESIONAL'),
  col('NUM_LICENCIA', 'varchar', 12, many(() => `A${int(10000000, 99999999)}`), 'MX_L1_LICENCIA_CONDUCIR'),
  col('NO_CERTIFICADO', 'varchar', 20, many(() => `00001000000${int(100000000, 999999999)}`), 'MX_L1_EFIRMA'),
  col('IP_ORIGEN', 'varchar', 15, many(() => `${int(1, 223)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`), 'MX_L1_IP'),
  col('MAC_ADDRESS', 'varchar', 17, many(() => many(() => int(0, 255).toString(16).padStart(2, '0'), 6).join(':')), 'MX_L1_DISPOSITIVO'),
  col('IMEI', 'varchar', 15, many(() => luhn('35', 15)), 'MX_L1_DISPOSITIVO'),
  col('PLACAS', 'varchar', 9, many(plate), 'MX_L1_PLACA'),
  col('NIV', 'varchar', 17, many(() => many(() => pick('ABCDEFGHJKLMNPRSTUVWXYZ0123456789'), 17).join('')), 'MX_L1_NIV'),
  col('NUM_POLIZA', 'varchar', 12, many(() => `POL-${int(100000, 999999)}`), 'MX_L1_NUMERO_CONTRATO'),
  col('NUM_EMPLEADO', 'varchar', 8, many(() => String(int(10000, 99999))), 'MX_L1_NUMERO_CONTRATO'),
  col('USERNAME', 'varchar', 30, many(() => `${fold(pick(NOMBRES)).toLowerCase()}${int(1, 99)}`), 'MX_L1_USUARIO_RRSS'),
  col('PASSWORD_HASH', 'varchar', 60, many(() => `$2a$10$${many(() => pick('abcdefghijklmnopqrstuvwxyz0123456789'), 53).join('')}`), 'MX_L1_CREDENCIAL'),
  col('CONTRASENA_CIEC', 'varchar', 20, many(() => `ciec${int(1000, 9999)}`), 'MX_L1_CREDENCIAL'),
  col('LATITUD', 'varchar', 12, many(() => `${int(15, 32)}.${int(100000, 999999)}`), 'MX_L1_GEOLOCALIZACION'),
  col('COORDENADAS', 'varchar', 30, many(() => `19.${int(1000, 9999)},-99.${int(1000, 9999)}`), 'MX_L1_GEOLOCALIZACION'),
  col('OBSERVACIONES', 'clob', 4000, many(() => `Cliente solicitó actualizar datos. CURP ${curp()}, correo ${fold(pick(NOMBRES)).toLowerCase()}@gmail.com.`), 'MX_L1_TEXTO_LIBRE'),

  // L1 — badly named: only the values can tell
  col('CAMPO1', 'varchar', 18, many(curp), 'MX_L1_CURP'),
  col('CAMPO2', 'varchar', 13, many(() => rfc()), 'MX_L1_RFC'),
  col('DATO_INE', 'varchar', 18, many(claveElector), 'MX_L1_CLAVE_ELECTOR'),
  col('COL_A', 'varchar', 30, many(() => pick(NOMBRES)), 'MX_L1_NOMBRE'),
  col('COL_B', 'varchar', 30, many(() => pick(APELLIDOS)), 'MX_L1_APELLIDO'),
  col('DATO_X', 'varchar', 120, many(fullName), 'MX_L1_NOMBRE_COMPLETO'),
  col('CAMPO3', 'varchar', 100, many(() => `${fold(pick(NOMBRES)).toLowerCase()}@hotmail.com`), 'MX_L1_EMAIL'),
  col('CAMPO4', 'varchar', 15, many(() => `+52 55 ${int(1000, 9999)} ${int(1000, 9999)}`), 'MX_L1_TELEFONO'),
  col('CAMPO5', 'varchar', 120, many(() => `Calle Morelos ${int(1, 999)}`), 'MX_L1_DIRECCION'),
  col('CAMPO6', 'varchar', 19, many(() => luhn('5', 16)), 'MX_L1_TARJETA'),
  col('CAMPO7', 'varchar', 15, many(() => `192.168.${int(0, 255)}.${int(1, 254)}`), 'MX_L1_IP'),
  col('CAMPO8', 'varchar', 9, many(plate), 'MX_L1_PLACA'),
  col('TXT', 'clob', 4000, many(() => `Paciente ${pick(NOMBRES)} ${pick(APELLIDOS)}, CURP ${curp()}, tel 55${int(10000000, 99999999)}.`), 'MX_L1_TEXTO_LIBRE'),

  // L2
  col('FECHA_NACIMIENTO', 'date', 0, many(() => iso(1940, 2010)), 'MX_L2_FECHA_NACIMIENTO'),
  col('FEC_NAC', 'varchar', 10, many(() => iso(1940, 2010)), 'MX_L2_FECHA_NACIMIENTO'),
  col('fechaNacimiento', 'timestamp', 0, many(() => iso(1940, 2010)), 'MX_L2_FECHA_NACIMIENTO'),
  col('ANIO_NACIMIENTO', 'number', 4, many(() => String(int(1940, 2010))), 'MX_L2_ANIO_NACIMIENTO'),
  col('EDAD', 'number', 3, many(() => String(int(0, 99))), 'MX_L2_EDAD'),
  col('FECHA_DEFUNCION', 'date', 0, many(() => iso(2000, 2025)), 'MX_L2_FECHA_EVENTO'),
  col('FECHA_ALTA_IMSS', 'date', 0, many(() => iso(2000, 2025)), 'MX_L2_FECHA_EVENTO'),
  col('SEXO', 'char', 1, many(() => pick(['H', 'M'])), 'MX_L2_SEXO'),
  col('GENERO', 'varchar', 10, many(() => pick(['Femenino', 'Masculino'])), 'MX_L2_SEXO'),
  col('MUNICIPIO', 'varchar', 60, many(() => pick(MUNICIPIO_NAMES)), 'MX_L2_MUNICIPIO'),
  col('ALCALDIA', 'varchar', 60, many(() => pick(['Coyoacán', 'Iztapalapa', 'Tlalpan', 'Xochimilco'])), 'MX_L2_MUNICIPIO'),
  col('CAMPO9', 'varchar', 60, many(() => pick(MUNICIPIO_NAMES)), 'MX_L2_MUNICIPIO'),
  col('CVE_MUN', 'varchar', 5, many(() => pick(MUNICIPIOS).code), 'MX_L2_CLAVE_MUNICIPIO'),
  col('LOCALIDAD', 'varchar', 60, many(() => `San Juan ${int(1, 99)}`), 'MX_L2_LOCALIDAD'),
  col('COLONIA', 'varchar', 60, many(() => pick(['Del Valle', 'Centro', 'Roma Norte', 'Las Águilas'])), 'MX_L2_COLONIA'),
  col('CODIGO_POSTAL', 'varchar', 5, many(() => String(int(1000, 99999)).padStart(5, '0')), 'MX_L2_CODIGO_POSTAL'),
  col('DomicilioFiscalReceptor', 'varchar', 5, many(() => String(int(1000, 99999)).padStart(5, '0')), 'MX_L2_CODIGO_POSTAL'),
  col('NACIONALIDAD', 'varchar', 20, many(() => pick(['Mexicana', 'Guatemalteca', 'Venezolana'])), 'MX_L2_NACIONALIDAD'),
  col('ESTADO_CIVIL', 'varchar', 20, many(() => pick(['Soltero', 'Casada', 'Unión libre'])), 'MX_L2_ESTADO_CIVIL'),
  col('OCUPACION', 'varchar', 60, many(() => pick(['Comerciante', 'Obrero', 'Profesor'])), 'MX_L2_OCUPACION'),
  col('PUESTO', 'varchar', 60, many(() => pick(['Analista', 'Jefe de área', 'Vendedor'])), 'MX_L2_OCUPACION'),
  col('NOMBRE_PATRON', 'varchar', 80, many(() => `Comercial ${int(1, 99)} S.A. de C.V.`), 'MX_L2_EMPLEADOR'),
  col('ESCOLARIDAD', 'varchar', 40, many(() => pick(['Secundaria completa', 'Licenciatura'])), 'MX_L2_ESCOLARIDAD'),
  col('ESCUELA', 'varchar', 80, many(() => `Escuela Primaria ${pick(['Benito Juárez', 'Miguel Hidalgo'])}`), 'MX_L2_ESCUELA'),
  col('CCT', 'varchar', 10, many(() => `${pad2(int(1, 32))}${pick(['DPR', 'EST', 'DJN', 'DTV'])}${int(1000, 9999)}${pick(LETTERS)}`), 'MX_L2_CCT'),
  col('NUM_HIJOS', 'number', 2, many(() => String(int(0, 8))), 'MX_L2_DEPENDIENTES'),

  // L3
  col('PUEBLO_INDIGENA', 'varchar', 30, many(() => pick(['Nahua', 'Maya', 'Zapoteco', 'No se considera indígena'])), 'MX_L3_ETNIA'),
  col('AUTOADSCRIPCION_AFRO', 'char', 1, many(() => pick(['S', 'N'])), 'MX_L3_ETNIA'),
  col('CAMPO10', 'varchar', 30, many(() => pick(['Nahua', 'Mixteco', 'Otomí', 'Tseltal', 'Afromexicano'])), 'MX_L3_ETNIA'),
  col('LENGUA_INDIGENA', 'varchar', 30, many(() => pick(['Náhuatl', 'Maya', 'Mixteco', 'Ninguna'])), 'MX_L3_LENGUA_INDIGENA'),
  col('DIAGNOSTICO', 'varchar', 10, many(() => pick(['E11.9', 'I10', 'J45.9', 'F32.1'])), 'MX_L3_SALUD_DIAGNOSTICO'),
  col('CIE10', 'varchar', 6, many(() => pick(['E11', 'I10', 'F20', 'B20'])), 'MX_L3_SALUD_DIAGNOSTICO'),
  col('MEDICAMENTO', 'varchar', 40, many(() => pick(['Sertralina', 'Paracetamol', 'Metformina'])), 'MX_L3_SALUD_MEDICAMENTO'),
  col('NUM_EXPEDIENTE_CLINICO', 'varchar', 12, many(() => String(int(100000, 999999))), 'MX_L3_SALUD_IDENTIFICADOR'),
  col('NOTA_EVOLUCION', 'clob', 4000, many(() => `Paciente refiere dolor abdominal de ${int(1, 9)} días de evolución.`), 'MX_L3_SALUD_TEXTO_CLINICO'),
  col('RESULTADO_VIH', 'varchar', 12, many(() => pick(['Reactivo', 'No reactivo'])), 'MX_L3_SALUD_RESULTADO_EXAMEN'),
  col('TIPO_SANGRE', 'varchar', 4, many(() => pick(['A+', 'O-', 'AB+'])), 'MX_L3_SALUD_GRUPO_SANGUINEO'),
  col('TIPO_DISCAPACIDAD', 'varchar', 40, many(() => pick(['Motriz', 'Visual', 'Sin discapacidad'])), 'MX_L3_SALUD_DISCAPACIDAD'),
  col('EMBARAZO', 'char', 1, many(() => pick(['S', 'N'])), 'MX_L3_SALUD_SEXUAL_REPRODUCTIVA'),
  col('SALUD_MENTAL', 'varchar', 60, many(() => pick(['Depresión', 'Ansiedad'])), 'MX_L3_SALUD_MENTAL_ADICCIONES'),
  col('HUELLA_DACTILAR', 'varchar', 200, many(() => many(() => pick('ABCDEF0123456789'), 64).join('')), 'MX_L3_BIOMETRICO'),
  col('PERFIL_GENETICO', 'varchar', 200, many(() => 'AGTC'.repeat(10)), 'MX_L3_INFORMACION_GENETICA'),
  col('PREFERENCIA_SEXUAL', 'varchar', 30, many(() => pick(['Heterosexual', 'Gay', 'Bisexual'])), 'MX_L3_PREFERENCIA_SEXUAL'),
  col('IDENTIDAD_GENERO', 'varchar', 30, many(() => pick(['Mujer', 'Hombre trans', 'No binario'])), 'MX_L3_IDENTIDAD_GENERO'),
  col('VIDA_SEXUAL', 'varchar', 30, many(() => 'Activa'), 'MX_L3_VIDA_SEXUAL'),
  col('RELIGION', 'varchar', 40, many(() => pick(['Católica', 'Pentecostal', 'Sin religión'])), 'MX_L3_RELIGION'),
  col('OBJECION_CONCIENCIA', 'varchar', 60, many(() => pick(['Transfusiones', 'Ninguna'])), 'MX_L3_CREENCIA_FILOSOFICA_MORAL'),
  col('PREFERENCIA_ELECTORAL', 'varchar', 40, many(() => pick(['Izquierda', 'Derecha', 'Centro'])), 'MX_L3_OPINION_POLITICA'),
  col('PARTIDO_POLITICO', 'varchar', 60, many(() => pick(['Morena', 'Partido Acción Nacional', 'Movimiento Ciudadano'])), 'MX_L3_AFILIACION_POLITICA'),
  col('SINDICALIZADO', 'char', 1, many(() => pick(['S', 'N'])), 'MX_L3_AFILIACION_SINDICAL'),

  // FIN
  col('SCORE_BURO', 'number', 3, many(() => String(int(456, 760))), 'MX_FIN_BURO_CREDITO'),
  col('MOP', 'varchar', 2, many(() => pick(['01', '02', '03', '96', '97'])), 'MX_FIN_BURO_CREDITO'),
  col('MONTO_ADEUDO', 'number', 12, many(() => String(int(1000, 900000))), 'MX_FIN_MONTO_DEUDA'),
  col('SUELDO_MENSUAL', 'number', 10, many(() => String(int(8000, 90000))), 'MX_FIN_INGRESO_MENSUAL'),
  col('SDI', 'number', 10, many(() => `${int(280, 2900)}.${int(10, 99)}`), 'MX_FIN_SALARIO_DIARIO'),
  col('VALOR_CATASTRAL', 'number', 12, many(() => String(int(300000, 9000000))), 'MX_FIN_PATRIMONIO'),
  col('AFORE', 'varchar', 30, many(() => pick(['Afore Coppel', 'Profuturo', 'XXI Banorte'])), 'MX_FIN_AFORE'),
  col('SALDO_SUBCUENTA_VIVIENDA', 'number', 12, many(() => String(int(5000, 900000))), 'MX_FIN_SALDO_RETIRO'),
  col('TIPO_CREDITO_VIVIENDA', 'varchar', 30, many(() => pick(['Infonavit', 'Fovissste', 'Bancario'])), 'MX_FIN_CREDITO_VIVIENDA'),
  col('DERECHOHABIENCIA', 'varchar', 30, many(() => pick(['IMSS', 'ISSSTE', 'IMSS-Bienestar', 'No afiliado'])), 'MX_FIN_SEGURIDAD_SOCIAL'),
  col('PROGRAMA_SOCIAL', 'varchar', 80, many(() => pick(['Sembrando Vida', 'Pensión para el Bienestar de las Personas Adultas Mayores'])), 'MX_FIN_PROGRAMA_SOCIAL'),
  col('NSE', 'varchar', 3, many(() => pick(['A/B', 'C+', 'C', 'D+', 'E'])), 'MX_FIN_NIVEL_SOCIOECONOMICO'),
  col('TENENCIA_VIVIENDA', 'varchar', 30, many(() => pick(['Propia', 'Rentada o alquilada', 'Prestada'])), 'MX_FIN_VIVIENDA'),
  col('RegimenFiscalReceptor', 'varchar', 3, many(() => pick(['605', '612', '626'])), 'MX_FIN_REGIMEN_FISCAL'),

  // PENAL
  col('ANTECEDENTES_PENALES', 'varchar', 30, many(() => pick(['Sin antecedentes penales', 'Con antecedentes penales'])), 'MX_PENAL_ANTECEDENTES'),
  col('CAUSA_PENAL', 'varchar', 15, many(() => `${int(1, 999)}/${int(2015, 2025)}`), 'MX_PENAL_CAUSA'),

  // Not personal data: nothing should be assigned
  col('ID', 'integer', 10, many((i) => String(i + 1)), ''),
  col('ESTRUCTURA', 'varchar', 40, many(() => pick(['Árbol', 'Lista'])), ''),
  col('RUTA_ARCHIVO', 'varchar', 200, many(() => `/datos/archivo${int(1, 99)}.txt`), ''),
  col('NOMBRE_PRODUCTO', 'varchar', 80, many(() => pick(['Leche entera 1L', 'Tortilla de maíz', 'Frijol negro 1kg'])), ''),
  col('NOMBRE_EMPRESA', 'varchar', 80, many(() => `Comercial ${int(1, 99)} S.A. de C.V.`), ''),
  col('MONTO_VENTA', 'number', 12, many(() => String(int(1000, 99999999))), ''),
  col('FECHA_CREACION', 'date', 0, many(() => iso(2015, 2025)), ''),
  col('CODIGO', 'varchar', 10, many(() => `A-${int(100, 999)}`), ''),
  col('DESCRIPCION_PRODUCTO', 'varchar', 400, many(() => 'Producto de consumo básico, empaque de cartón reciclable.'), ''),
  col('ESTATUS', 'varchar', 10, many(() => pick(['ACTIVO', 'INACTIVO'])), ''),
  col('CANTIDAD', 'number', 6, many(() => String(int(1, 500))), ''),
  col('SKU', 'varchar', 12, many(() => `SKU${int(10000, 99999)}`), ''),
  col('HOTEL', 'varchar', 60, many(() => 'Hotel Central'), ''),
  col('TRANSACCION_ID', 'varchar', 36, many(() => `TX${int(100000, 999999)}`), ''),
  col('DEPARTAMENTO', 'varchar', 40, many(() => pick(['Finanzas', 'Operaciones'])), ''),
  col('CLAVE_PRODUCTO', 'varchar', 10, many(() => `P-${int(100, 999)}`), ''),
  col('CLAVE_PROD_SERV', 'varchar', 8, many(() => String(int(10000000, 99999999))), ''),
  col('CARGO_FIJO', 'number', 8, many(() => String(int(1000, 9999))), ''),
  col('LONGITUD_CABLE', 'number', 6, many(() => `${int(1, 99)}.5`), ''),
  col('PAGE_URL', 'varchar', 200, many(() => `https://www.ejemplo.com.mx/p/${int(1, 999)}`), ''),
  col('TIPO_COMPROBANTE', 'varchar', 20, many(() => pick(['I', 'E', 'P'])), ''),
  col('USO_CFDI', 'varchar', 4, many(() => pick(['G01', 'G03', 'S01'])), ''),
  col('MONEDA', 'varchar', 3, many(() => pick(['MXN', 'USD'])), ''),
  col('CATEGORIA', 'varchar', 30, many(() => pick(['Lácteos', 'Panadería'])), ''),
  col('ENTIDAD_FEDERATIVA', 'varchar', 30, many(() => pick(['Jalisco', 'Puebla', 'Nuevo León'])), ''),
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

  // The essential pack runs only the classifiers of its domains. Its columns must still land where
  // they did, and no other column may be taken for one of its domains now that the domains that
  // used to win those columns are not there.
  const essential = new Set(preset.packs.essential.domains)
  const pack = resolved.filter((c) => essential.has(c.domain))
  let packPassed = 0
  for (const column of COLUMNS) {
    const expect = essential.has(column.expect) ? column.expect : ''
    const field = { name: column.name, parent: null, sqlType: column.sqlType, length: column.length || null, autoIncrement: false, values: column.values }
    const result = kit.evaluateField({ classifiers: pack, field, threshold: preset.profileSet.threshold, readFile })
    if (result.assigned === expect) { packPassed++; continue }
    failures++
    const ranking = result.ranking.slice(0, 3).map((r) => `${r.domain} ${r.percent}%`).join(', ')
    console.log(`  ✗ essential pack, ${column.name}: expected ${expect || '(none)'}, got ${result.assigned || '(none)'} — ${ranking}`)
  }
  console.log(`profiled ${COLUMNS.length} columns with the essential pack (${pack.length} classifiers): ${packPassed} as expected`)
}

// ── Algorithms ──────────────────────────────────────────────────────────────

const words = (s) => s.trim().split(/\s+/).length
const sameShape = (i, o) => i.length === o.length && i.replace(/[A-Z]/g, 'A').replace(/\d/g, '9') === o.replace(/[A-Z]/g, 'A').replace(/\d/g, '9')
const MASKING = {
  MX_L1_CURP: {
    inputs: ['HEGA850720MDFRRL04', 'HEGA850720MDFRRL0', 'Juan', ...many(curp, 60)],
    // Text that is not a CURP still has to be masked, not passed through.
    check: (i, o) => (validCurp(i) ? validCurp(o) : o !== i),
  },
  MX_L1_RFC: {
    inputs: ['WMT970714R10', 'GODE561231GR8', 'GODE561231', ...many(() => rfc(), 40), ...many(() => rfc(true), 20)],
    check: (i, o) => (i.length >= 12 ? validRfc(o) && o.length === i.length : sameShape(i, o) && validDate(o.slice(4, 10))),
  },
  MX_L1_NSS: { inputs: ['12-34-56-7890-1', ...many(nss, 40)], check: (i, o) => (validNss(i) ? validNss(o) : o !== i) },
  MX_L1_CLAVE_ELECTOR: {
    inputs: many(claveElector, 20),
    check: (i, o) => /^[A-Z]{6}\d{8}[HM]\d{3}$/.test(o) && validDate(o.slice(6, 12)) && Number(o.slice(12, 14)) >= 1 && Number(o.slice(12, 14)) <= 32,
  },
  MX_L1_CREDENCIAL_INE: { inputs: ['1234567890123', 'IDMEX1234567890'] },
  // Four words fall through to the Character Mapping: it must mask them, not act as a name lookup.
  MX_L1_NOMBRE: { inputs: ['Guadalupe', 'JOSÉ LUIS', 'Xóchitl', 'Ana María José Luisa'], check: (i, o) => words(i) === words(o) },
  MX_L1_APELLIDO: { inputs: ['Hernández', 'GARCÍA LÓPEZ', 'Treviño'], check: (i, o) => words(i) === words(o) },
  MX_L1_NOMBRE_COMPLETO: {
    inputs: ['María Guadalupe Hernández López', 'JUAN PÉREZ GARCÍA', 'Pedro Soto', 'Hernández López, María Guadalupe'],
    check: (i, o) => words(i) === words(o),
  },
  MX_L1_EMAIL: { inputs: ['guadalupe.hernandez@gmail.com', 'josé.núñez@empresa.com.mx'], check: (i, o) => /@[^@]+\.test$/.test(o) },
  MX_L1_TELEFONO: {
    inputs: ['+52 55 1234 5678', '5512345678', '(222) 123 4567', '+52 1 33 1234 5678', '9991234567'],
    // +52, the mobile 1 and the area code stay; the length does too.
    check: (i, o) => o.length === i.length && o.startsWith(i.match(/^(\+?52[\s-]?)?(1[\s-]?)?\(?(55|56|33|81|\d{3})\)?/)[0]),
  },
  MX_L1_DIRECCION: { inputs: ['Av. Insurgentes Sur 1602 Int. 4'] },
  MX_L1_DIRECCION_COMPLEMENTO: { inputs: ['1602', 'Mz 12 Lt 5'] },
  MX_L1_CLABE: {
    inputs: ['002180700545678911', ...many(clabe, 30)],
    check: (i, o) => validClabe(o) && o.slice(0, 3) === i.slice(0, 3),
  },
  MX_L1_CUENTA_BANCARIA: { inputs: ['0123456789'] },
  MX_L1_TARJETA: { inputs: ['4152 3131 2345 6780'] },
  MX_L1_PASAPORTE: { inputs: ['G12345678'] },
  MX_L1_DOCUMENTO_MIGRATORIO: { inputs: ['123456789'] },
  MX_L1_CEDULA_PROFESIONAL: { inputs: ['12345678'] },
  MX_L1_LICENCIA_CONDUCIR: { inputs: ['A12345678'] },
  MX_L1_EFIRMA: { inputs: ['00001000000504465028'] },
  MX_L1_IP: {
    inputs: ['189.203.4.10', '2001:db8::1'],
    check: (i, o) => (i.includes('.') ? o.split('.').every((p) => Number(p) >= 1 && Number(p) <= 254) : /^[0-9a-f:]+$/i.test(o)),
  },
  MX_L1_DISPOSITIVO: { inputs: ['3c:22:fb:9a:10:e4', '356938035643809'], check: (i, o) => (i.includes(':') ? /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(o) : /^\d{15}$/.test(o)) },
  MX_L1_PLACA: { inputs: ['URU-197-A', 'A-12-BCD', 'ABC-12-34'], check: (i, o) => sameShape(i, o) && !/[IOQ]/.test(o) },
  MX_L1_NIV: { inputs: ['3VWFE21C04M000001'] },
  MX_L1_NUMERO_CONTRATO: { inputs: ['POL-123456'] },
  MX_L1_USUARIO_RRSS: { inputs: ['@lupita_hdz'] },
  MX_L1_CREDENCIAL: { inputs: ['Secreta#2024'], check: (i, o) => /^X+$/.test(o) },
  MX_L1_GEOLOCALIZACION: { inputs: ['19.432608', '19.432608,-99.133209'], check: (i, o) => o.slice(0, 4) === i.slice(0, 4) },
  MX_L1_TEXTO_LIBRE: {
    inputs: ['Cliente Hernández, CURP HEGA850720MDFRRL04, correo g.hernandez@gmail.com, tel 5512345678.'],
    check: (i, o) => !/HEGA850720MDFRRL04|g\.hernandez@gmail\.com|5512345678/.test(o),
  },
  MX_L2_FECHA_NACIMIENTO: { inputs: ['1985-07-20', '2008-01-15'], check: (i, o) => Math.abs(new Date(o.slice(0, 10)) - new Date(i)) <= 60 * 864e5 },
  MX_L2_ANIO_NACIMIENTO: { inputs: ['1985'], check: (i, o) => o.startsWith('198'), same: true },
  MX_L2_EDAD: { inputs: ['37', '7', '104'], check: (i, o) => (i === '104' ? o === '90' : i.length === 1 || o[0] === i[0]), same: true },
  MX_L2_FECHA_EVENTO: { inputs: ['2021-03-15'] },
  MX_L2_SEXO: { inputs: ['H', 'M', 'F', 'Femenino', 'hombre'], same: true },
  MX_L2_MUNICIPIO: { inputs: ['Santa María Tlahuitoltepec', 'Guadalajara', 'Benito Juárez', 'Tlahuitoltepec'], same: true },
  MX_L2_CLAVE_MUNICIPIO: { inputs: ['20426', '14039', '1001'], same: true },
  MX_L2_LOCALIDAD: { inputs: ['San Isidro Buenavista'] },
  MX_L2_COLONIA: { inputs: ['Santa María la Ribera'] },
  MX_L2_CODIGO_POSTAL: { inputs: ['06760', '44130'], check: (i, o) => o === `${i.slice(0, 3)}00`, same: true },
  MX_L2_NACIONALIDAD: { inputs: ['Guatemalteca'], same: true },
  MX_L2_ESTADO_CIVIL: { inputs: ['Unión libre'], same: true },
  MX_L2_OCUPACION: { inputs: ['Gerente Regional Zona Sierra Tarahumara'] },
  MX_L2_EMPLEADOR: { inputs: ['Petróleos Mexicanos'] },
  MX_L2_ESCOLARIDAD: { inputs: ['Secundaria completa'], same: true },
  MX_L2_ESCUELA: { inputs: ['Instituto Cultural Tampico'] },
  MX_L2_CCT: { inputs: ['09DPR1234X'], check: (i, o) => sameShape(i, o) },
  MX_L2_DEPENDIENTES: { inputs: ['9', '2'], check: (i, o) => Number(o) <= 5, same: true },
  MX_L3_ETNIA: { inputs: ['Kumiai', 'S'], same: true },
  MX_L3_LENGUA_INDIGENA: { inputs: ['Chocholteco', 'N'], same: true },
  MX_L3_SALUD_DIAGNOSTICO: { inputs: ['F32.9', 'B20', 'Depresión mayor'], same: true },
  MX_L3_SALUD_MEDICAMENTO: { inputs: ['Sertralina 50 mg'] },
  MX_L3_SALUD_IDENTIFICADOR: { inputs: ['EXP-2024-00123'] },
  MX_L3_SALUD_TEXTO_CLINICO: { inputs: ['Paciente López, CURP HEGA850720MDFRRL04, acude por cefalea.'], check: (i, o) => !o.includes('HEGA850720MDFRRL04') },
  MX_L3_SALUD_RESULTADO_EXAMEN: { inputs: ['Reactivo'] },
  MX_L3_SALUD_GRUPO_SANGUINEO: { inputs: ['O+'], same: true },
  MX_L3_SALUD_DISCAPACIDAD: { inputs: ['Discapacidad psicosocial severa', 'N'], same: true },
  MX_L3_SALUD_SEXUAL_REPRODUCTIVA: { inputs: ['Embarazo de 12 semanas', 'S'], same: true },
  MX_L3_SALUD_MENTAL_ADICCIONES: { inputs: ['Trastorno bipolar'] },
  MX_L3_BIOMETRICO: { inputs: ['A1B2C3D4E5F6'] },
  MX_L3_INFORMACION_GENETICA: { inputs: ['BRCA1 positivo'] },
  MX_L3_PREFERENCIA_SEXUAL: { inputs: ['Bisexual'], same: true },
  MX_L3_IDENTIDAD_GENERO: { inputs: ['Hombre trans'], same: true },
  MX_L3_VIDA_SEXUAL: { inputs: ['Activa'] },
  MX_L3_RELIGION: { inputs: ['Luz del Mundo'], same: true },
  MX_L3_CREENCIA_FILOSOFICA_MORAL: { inputs: ['Rechaza transfusiones'] },
  MX_L3_OPINION_POLITICA: { inputs: ['Centro derecha'], same: true },
  MX_L3_AFILIACION_POLITICA: { inputs: ['Partido de la Revolución Democrática'], same: true },
  MX_L3_AFILIACION_SINDICAL: { inputs: ['SNTE Sección 22', 'S'], same: true },
  MX_FIN_BURO_CREDITO: { inputs: ['MOP 05', '97', '650', 'Cartera vencida', 'N'], same: true },
  MX_FIN_MONTO_DEUDA: { inputs: ['85000'] },
  MX_FIN_INGRESO_MENSUAL: { inputs: ['18500', '18500.50'] },
  MX_FIN_SALARIO_DIARIO: { inputs: ['452'] },
  MX_FIN_PATRIMONIO: { inputs: ['1850000'] },
  MX_FIN_AFORE: { inputs: ['Afore Coppel'], same: true },
  MX_FIN_SALDO_RETIRO: { inputs: ['385000'] },
  MX_FIN_CREDITO_VIVIENDA: { inputs: ['Mejoravit'], same: true },
  MX_FIN_SEGURIDAD_SOCIAL: { inputs: ['ISSSTE', 'S'], same: true },
  MX_FIN_PROGRAMA_SOCIAL: { inputs: ['Prospera', 'N'], same: true },
  MX_FIN_NIVEL_SOCIOECONOMICO: { inputs: ['C-', '3', 'Decil 8'], same: true },
  MX_FIN_VIVIENDA: { inputs: ['Asentamiento irregular'], same: true },
  MX_FIN_REGIMEN_FISCAL: { inputs: ['612', '626 - Régimen Simplificado de Confianza', 'Arrendamiento'], same: true },
  MX_PENAL_ANTECEDENTES: { inputs: ['Sentenciado por robo', 'S'], same: true },
  MX_PENAL_CAUSA: { inputs: ['123/2024', 'CI-FIZP/ACD/UI-1/00123/01-2024'] },
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
const LARGE = new Map(MUNICIPIOS.map((m) => [m.name, m.population]))
const BY_CODE = new Map(MUNICIPIOS.map((m) => [m.code, m]))
const EXPECT = {
  MX_L1_NOMBRE: (i, o) => words(i) > 3 || o.split(/\s+/).every((w) => has('mx-nombres.txt', w)),
  MX_L1_APELLIDO: (i, o) => words(i) > 3 || o.split(/\s+/).every((w) => has('mx-apellidos.txt', w)),
  MX_L1_NOMBRE_COMPLETO: (i, o) => i.includes(',') || (has('mx-nombres.txt', o.split(/\s+/)[0]) && has('mx-apellidos.txt', o.split(/\s+/).at(-1))),
  MX_L1_DIRECCION: (i, o) => has('mx-direcciones.txt', o),
  MX_L2_SEXO: (i, o) => ({ h: ['h', 'm'], m: ['h', 'm'], f: ['f', 'm'], femenino: ['femenino', 'masculino'], hombre: ['mujer', 'hombre'] })[i.toLowerCase()].includes(o.toLowerCase()),
  // Santa María Tlahuitoltepec (Oaxaca, under 20,000) becomes a municipality of 20,000 or more;
  // Guadalajara and Benito Juárez (one of them is large) stay.
  MX_L2_MUNICIPIO: (i, o) => (i === 'Guadalajara' || i === 'Benito Juárez' ? o === i : i === 'Tlahuitoltepec' ? o === i : (LARGE.get(o) ?? 0) >= 20000),
  MX_L2_CLAVE_MUNICIPIO: (i, o) => {
    const from = BY_CODE.get(i.padStart(5, '0'))
    const to = BY_CODE.get(o.padStart(5, '0'))
    return Boolean(to) && to.population >= 20000 && to.state === from.state && (from.population < 20000 || to === from)
  },
  MX_L2_LOCALIDAD: (i, o) => has('mx-localidades.txt', o),
  MX_L2_COLONIA: (i, o) => has('mx-colonias.txt', o),
  MX_L2_NACIONALIDAD: (i, o) => has('mx-nacionalidades.txt', o),
  MX_L2_ESTADO_CIVIL: (i, o) => has('mx-estado-civil.txt', o),
  MX_L2_OCUPACION: (i, o) => has('mx-ocupaciones.txt', o),
  MX_L2_EMPLEADOR: (i, o) => has('mx-empleadores.txt', o),
  MX_L2_ESCOLARIDAD: (i, o) => has('mx-escolaridad.txt', o),
  MX_L2_ESCUELA: (i, o) => has('mx-escuelas.txt', o),
  MX_L3_ETNIA: (i, o) => flag(i, o) ?? has('mx-pueblos.txt', o),
  MX_L3_LENGUA_INDIGENA: (i, o) => flag(i, o) ?? has('mx-lenguas.txt', o),
  MX_L3_SALUD_DIAGNOSTICO: (i, o) => (/\.\d/.test(i) ? has('mx-cie10-decimal.txt', o) : /^[A-Z]\d{2}$/i.test(i) ? has('mx-cie10.txt', o) : has('mx-diagnosticos.txt', o)),
  MX_L3_SALUD_MEDICAMENTO: (i, o) => has('mx-medicamentos.txt', o),
  MX_L3_SALUD_GRUPO_SANGUINEO: (i, o) => has('mx-grupo-sanguineo.txt', o),
  MX_L3_SALUD_DISCAPACIDAD: (i, o) => flag(i, o) ?? has('mx-discapacidad.txt', o),
  MX_L3_SALUD_SEXUAL_REPRODUCTIVA: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  MX_L3_SALUD_MENTAL_ADICCIONES: (i, o) => o === SUPPRESSED,
  MX_L3_VIDA_SEXUAL: (i, o) => o === SUPPRESSED,
  MX_L3_CREENCIA_FILOSOFICA_MORAL: (i, o) => o === SUPPRESSED,
  MX_L3_AFILIACION_SINDICAL: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  MX_L3_PREFERENCIA_SEXUAL: (i, o) => has('mx-preferencia-sexual.txt', o),
  MX_L3_IDENTIDAD_GENERO: (i, o) => has('mx-identidad-genero.txt', o),
  MX_L3_RELIGION: (i, o) => has('mx-religiones.txt', o),
  MX_L3_OPINION_POLITICA: (i, o) => has('mx-opiniones-politicas.txt', o),
  MX_L3_AFILIACION_POLITICA: (i, o) => has('mx-partidos.txt', o),
  MX_FIN_BURO_CREDITO: (i, o) => flag(i, o) ?? (/mop/i.test(i) ? /^MOP \d{2}$/.test(o) && has('mx-mop.txt', o.slice(4)) : /^\d{2}$/.test(i) ? has('mx-mop.txt', o) : /^\d{3}$/.test(i) ? /^\d{3}$/.test(o) : has('mx-estado-crediticio.txt', o)),
  MX_FIN_AFORE: (i, o) => has('mx-afores.txt', o),
  MX_FIN_CREDITO_VIVIENDA: (i, o) => has('mx-credito-vivienda.txt', o),
  MX_FIN_SEGURIDAD_SOCIAL: (i, o) => flag(i, o) ?? has('mx-seguridad-social.txt', o),
  MX_FIN_PROGRAMA_SOCIAL: (i, o) => flag(i, o) ?? has('mx-programas-sociales.txt', o),
  MX_FIN_NIVEL_SOCIOECONOMICO: (i, o) => (/^\d$/.test(i) ? /^[1-5]$/.test(o) : /^decil/i.test(i) ? /^Decil ([1-9]|10)$/.test(o) : has('mx-nse.txt', o)),
  MX_FIN_VIVIENDA: (i, o) => has('mx-vivienda.txt', o),
  MX_FIN_REGIMEN_FISCAL: (i, o) => (/^\d{3}$/.test(i) ? has('mx-regimen-fiscal-clave.txt', o) : /^\d{3} - /.test(i) ? has('mx-regimen-fiscal-clave.txt', o.slice(0, 3)) && has('mx-regimen-fiscal-nombre.txt', o.slice(6)) : has('mx-regimen-fiscal-nombre.txt', o)),
  MX_PENAL_ANTECEDENTES: (i, o) => flag(i, o) ?? has('mx-antecedentes.txt', o),
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
  const TYPED = new Set(['MX_L2_FECHA_NACIMIENTO', 'MX_L2_FECHA_EVENTO', 'MX_FIN_MONTO_DEUDA', 'MX_FIN_INGRESO_MENSUAL', 'MX_FIN_SALARIO_DIARIO', 'MX_FIN_PATRIMONIO', 'MX_FIN_SALDO_RETIRO'])
  for (const d of preset.domains.filter((x) => !TYPED.has(x.name))) {
    for (const input of ['S/D', 'sin dato', '-']) jobs.push({ domain: d, input, placeholder: true })
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

  // The same person's CURP and RFC share their first ten characters; masked, they still must.
  let agree = 0
  const pairs = many(() => { const c = curp(); const body = c.slice(0, 10) + 'A1'; return [c, body + rfcDigit(body)] }, 20)
  for (const [c, r] of pairs) {
    const [mc, mr] = [(await run('MX_CURP', c)).output, (await run('MX_RFC', r)).output]
    if (mc && mr && mc.slice(0, 10) === mr.slice(0, 10)) agree++
    else { failures++; console.log(`  ✗ CURP ${c} → ${mc} and RFC ${r} → ${mr} no longer share their first ten characters`) }
  }
  console.log(`CURP and RFC of the same person: ${agree} of ${pairs.length} still agree`)

  // Different keys must stay different: a CURP, RFC, NSS or CLABE used as a key cannot collide.
  for (const [algorithmName, make] of [['MX_CURP', curp], ['MX_RFC', () => rfc()], ['MX_NSS', nss], ['MX_CLABE', clabe]]) {
    const inputs = [...new Set(many(make, 150))]
    const outputs = new Map()
    for (const input of inputs) outputs.set(input, (await run(algorithmName, input)).output)
    const distinct = new Set(outputs.values()).size
    if (distinct !== inputs.length) { failures++; console.log(`  ✗ ${algorithmName}: ${inputs.length} inputs gave ${distinct} distinct outputs`) }
    else console.log(`${algorithmName}: ${inputs.length} distinct inputs, ${distinct} distinct outputs`)
  }
}

if (only !== 'algorithms') verifyClassifiers()
if (only !== 'classifiers') await verifyAlgorithms()
console.log(failures ? `\n${failures} problem(s)` : '\nall good')
process.exit(failures ? 1 : 0)
