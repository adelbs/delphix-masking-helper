#!/usr/bin/env node
/**
 * Checks the Peru (Ley 29733) preset.
 *
 *   node presets/peru-ley-29733/verify.mjs               # classifiers, then algorithms
 *   node presets/peru-ley-29733/verify.mjs classifiers   # only the local profiling check
 *   node presets/peru-ley-29733/verify.mjs algorithms    # only masking, against the app
 *
 * Classifiers run through classifiers/, the same evaluator the classifier test uses: every
 * configuration is reviewed, then a battery of columns — well named, badly named and unrelated —
 * is profiled with the whole set at its threshold. The table that generalizes distritos and
 * provincias is audited offline. Algorithms run in the app (DLPX_URL, default
 * http://localhost:3000), which needs the Delphix jars in lib/; every DNI and RUC they write is
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

const DNI_WEIGHTS = [3, 2, 7, 6, 5, 4, 3, 2]
const DNI_SERIES = [6, 7, 8, 9, 0, 1, 1, 2, 3, 4, 5]
const DNI_LETTERS = ['K', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']
/** RENIEC: eleven minus the remainder (zero stays zero) indexes the series. */
const dniPosition = (body) => (11 - ([...body].reduce((a, d, i) => a + Number(d) * DNI_WEIGHTS[i], 0) % 11)) % 11
const dniDigit = (body) => String(DNI_SERIES[dniPosition(body)])
const dniLetter = (body) => DNI_LETTERS[dniPosition(body)]
const validDni = (v) => {
  const m = /^(\d{8})[\s\-]?([0-9A-JKa-jk])$/.exec(v)
  return Boolean(m) && (/\d/.test(m[2]) ? dniDigit(m[1]) === m[2] : dniLetter(m[1]) === m[2].toUpperCase())
}

const RUC_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
/** SUNAT: eleven minus the remainder, ten written 0 and eleven written 1. */
const rucDigit = (body) => {
  const value = 11 - ([...body].reduce((a, d, i) => a + Number(d) * RUC_WEIGHTS[i], 0) % 11)
  return String(value === 10 ? 0 : value === 11 ? 1 : value)
}
const validRuc = (v) => /^\d{11}$/.test(v) && rucDigit(v.slice(0, 10)) === v[10]

// ── Test data ───────────────────────────────────────────────────────────────

let seed = 29733
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
const URBANIZACIONES = source('urbanizaciones.txt')
const PROVINCIAS = source('provincias.tsv').map((l) => {
  const [code, name, departmentCode, department, , , population] = l.split('\t')
  return { code, name, departmentCode, department, population: Number(population) }
})
const provinceByCode = new Map(PROVINCIAS.map((p) => [p.code, p]))
const DISTRITOS = source('distritos.tsv').map((l) => {
  const [code, name, provinceCode, province, departmentCode, department, , , population] = l.split('\t')
  return { code, name, provinceCode, province, departmentCode, department, population: Number(population || 0) }
})
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '')
const PERSONAL = new Set([...GIVEN, ...SURNAMES].map((w) => fold(w).toLowerCase()))
const SMALL_NAMES = DISTRITOS.filter((d) => d.population < 20000 && !PERSONAL.has(fold(d.name).toLowerCase())).map((d) => d.name)
const LARGE_NAMES = DISTRITOS.filter((d) => d.population >= 20000).map((d) => d.name)

const pad = (n, w) => String(n).padStart(w, '0')
const digits = (n) => many(() => int(0, 9), n).join('')
const dniBody = () => pad(int(0, 99999999), 8)
const dni = () => { const b = dniBody(); return `${b}-${dniDigit(b)}` }
const ruc = (prefix = pick(['10', '15', '17', '20'])) => { const b = prefix + digits(8); return b + rucDigit(b) }
const luhn = (prefix, length) => {
  const ds = [...prefix].map(Number)
  while (ds.length < length - 1) ds.push(int(0, 9))
  const sum = ds.slice().reverse().reduce((s, d, i) => s + (i % 2 === 0 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0)
  return ds.join('') + String((10 - (sum % 10)) % 10)
}
const iso = (y0, y1) => `${int(y0, y1)}-${pad(int(1, 12), 2)}-${pad(int(1, 28), 2)}`
const fullName = () => `${pick(GIVEN)}${random() < 0.4 ? ` ${pick(GIVEN)}` : ''} ${pick(SURNAMES)} ${pick(SURNAMES)}`
const phone = () => pick([`9${int(10, 99)}${int(100, 999)}${int(100, 999)}`, `+51 9${digits(8)}`, `9${int(10, 99)} ${int(100, 999)} ${int(100, 999)}`, `(01) ${int(100, 999)}-${int(1000, 9999)}`])
const address = () => pick([`Av. Arequipa ${int(100, 3500)}, ${pick(URBANIZACIONES)}`, `Jr. Puno ${int(100, 1900)} Int. ${int(101, 900)}`, `Mz. ${pick(['A', 'B', 'C'])} Lt. ${int(1, 30)}, ${pick(URBANIZACIONES)}`, `Km ${int(1, 90)} Carretera Central`])
const letters = (n) => many(() => pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), n).join('')
const plate = () => pick([`${letters(2)}${letters(1)}-${int(100, 999)}`, `${letters(1)}${int(1, 9)}${letters(1)}-${int(100, 999)}`, `${letters(2)}-${int(1000, 9999)}`])

// ── Classifiers ─────────────────────────────────────────────────────────────

const SQL = { varchar: 12, char: 1, number: 2, integer: 4, date: 91, timestamp: 93, clob: 2005 }
const col = (name, type, length, values, expect) => ({ name, sqlType: SQL[type], length, values, expect })

const COLUMNS = [
  // L1 — well named
  col('NUMERO_DOCUMENTO', 'varchar', 12, many(dni), 'PE_L1_DNI'),
  col('DNI', 'varchar', 10, many(dni), 'PE_L1_DNI'),
  col('DNI_CLIENTE', 'varchar', 10, many(() => dniBody()), 'PE_L1_DNI'),
  col('RUC', 'varchar', 11, many(() => ruc()), 'PE_L1_RUC'),
  col('RUC_PROVEEDOR', 'varchar', 11, many(() => ruc('20')), 'PE_L1_RUC'),
  col('DIGITO_VERIFICACION', 'char', 1, many(() => String(int(0, 9))), 'PE_L1_DIGITO_VERIFICACION'),
  col('CARNE_EXTRANJERIA', 'varchar', 12, many(() => String(int(100000000, 999999999))), 'PE_L1_CARNE_EXTRANJERIA'),
  col('PASAPORTE', 'varchar', 10, many(() => `${letters(1)}${int(1000000, 9999999)}`), 'PE_L1_PASAPORTE'),
  col('ACTA_NACIMIENTO', 'varchar', 14, many(() => `${int(1, 400)}/${int(1980, 2020)}`), 'PE_L1_ACTA'),
  col('CODIGO_ASEGURADO', 'varchar', 14, many(() => `${letters(3)}${digits(8)}`), 'PE_L1_SEGURO_SOCIAL'),
  col('CODIGO_ALUMNO', 'varchar', 12, many(() => `${int(2015, 2025)}${int(10000, 99999)}`), 'PE_L1_CODIGO_ESTUDIANTE'),
  col('COLEGIATURA', 'varchar', 10, many(() => `CMP-${int(10000, 99999)}`), 'PE_L1_COLEGIATURA'),
  col('PRIMER_NOMBRE', 'varchar', 30, many(() => pick(GIVEN)), 'PE_L1_NOMBRE'),
  col('APELLIDO_PATERNO', 'varchar', 30, many(() => pick(SURNAMES)), 'PE_L1_APELLIDO'),
  col('APELLIDOS', 'varchar', 60, many(() => `${pick(SURNAMES)} ${pick(SURNAMES)}`), 'PE_L1_APELLIDO'),
  col('NOMBRE_COMPLETO', 'varchar', 120, many(fullName), 'PE_L1_NOMBRE_COMPLETO'),
  col('NOMBRE_CLIENTE', 'varchar', 120, many(fullName), 'PE_L1_NOMBRE_COMPLETO'),
  col('NOMBRE', 'varchar', 120, many(fullName), 'PE_L1_NOMBRE_COMPLETO'),
  col('RAZON_SOCIAL', 'varchar', 80, many(() => `Inversiones ${int(1, 99)} S.A.C.`), 'PE_L1_RAZON_SOCIAL'),
  col('CORREO_ELECTRONICO', 'varchar', 100, many(() => `${fold(pick(GIVEN)).toLowerCase()}.${int(1, 999)}@gmail.com`), 'PE_L1_EMAIL'),
  col('EMAIL', 'varchar', 100, many(() => `contacto${int(1, 999)}@empresa.com.pe`), 'PE_L1_EMAIL'),
  col('TELEFONO', 'varchar', 16, many(phone), 'PE_L1_TELEFONO'),
  col('CELULAR', 'varchar', 16, many(() => `9${digits(8)}`), 'PE_L1_TELEFONO'),
  col('DIRECCION', 'varchar', 150, many(address), 'PE_L1_DIRECCION'),
  col('DOMICILIO', 'varchar', 150, many(address), 'PE_L1_DIRECCION'),
  col('MANZANA', 'varchar', 8, many(() => `Mz. ${pick(['A', 'B', 'C', 'D'])}`), 'PE_L1_DIRECCION_COMPLEMENTO'),
  col('NUMERO_CUENTA', 'varchar', 20, many(() => digits(14)), 'PE_L1_CUENTA_BANCARIA'),
  col('NUMERO_TARJETA', 'varchar', 19, many(() => luhn('4', 16)), 'PE_L1_TARJETA'),
  col('BILLETERA_DIGITAL', 'varchar', 64, many(() => `bc1q${many(() => pick('023456789acdefghjklmnpqrstuvwxyz'), 38).join('')}`), 'PE_L1_BILLETERA'),
  col('IP_ORIGEN', 'varchar', 15, many(() => `${int(1, 223)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`), 'PE_L1_IP'),
  col('MAC_ADDRESS', 'varchar', 17, many(() => many(() => int(0, 255).toString(16).padStart(2, '0'), 6).join(':')), 'PE_L1_DISPOSITIVO'),
  col('IMEI', 'varchar', 15, many(() => luhn('35', 15)), 'PE_L1_DISPOSITIVO'),
  col('COOKIE_ID', 'varchar', 40, many(() => `GA1.2.${int(100000000, 999999999)}.${int(1600000000, 1799999999)}`), 'PE_L1_COOKIE'),
  col('PLACA', 'varchar', 10, many(plate), 'PE_L1_PLACA'),
  col('NUMERO_CHASIS', 'varchar', 17, many(() => many(() => pick('ABCDEFGHJKLMNPRSTUVWXYZ0123456789'), 17).join('')), 'PE_L1_VEHICULO'),
  col('PARTIDA_REGISTRAL', 'varchar', 16, many(() => `P${int(10000000, 99999999)}`), 'PE_L1_INMUEBLE'),
  col('NUMERO_CONTRATO', 'varchar', 12, many(() => `CT-${int(100000, 999999)}`), 'PE_L1_CONTRATO'),
  col('USUARIO', 'varchar', 30, many(() => `${fold(pick(GIVEN)).toLowerCase()}${int(1, 99)}`), 'PE_L1_USUARIO'),
  col('CONTRASENA', 'varchar', 60, many(() => `$2a$10$${many(() => pick('abcdefghijklmnopqrstuvwxyz0123456789'), 53).join('')}`), 'PE_L1_CREDENCIAL'),
  col('LATITUD', 'varchar', 12, many(() => `-12.${int(100000, 999999)}`), 'PE_L1_GEOLOCALIZACION'),
  col('OBSERVACIONES', 'clob', 4000, many(() => `Cliente solicita actualizar datos. DNI ${dni()}, correo ${fold(pick(GIVEN)).toLowerCase()}@gmail.com.`), 'PE_L1_TEXTO_LIBRE'),

  // L1 — badly named: only the values can tell
  col('CAMPO1', 'varchar', 12, many(dni), 'PE_L1_DNI'),
  col('CAMPO2', 'varchar', 30, many(() => pick(GIVEN)), 'PE_L1_NOMBRE'),
  col('CAMPO3', 'varchar', 30, many(() => pick(SURNAMES)), 'PE_L1_APELLIDO'),
  col('CAMPO4', 'varchar', 120, many(fullName), 'PE_L1_NOMBRE_COMPLETO'),
  col('CAMPO5', 'varchar', 100, many(() => `${fold(pick(GIVEN)).toLowerCase()}@hotmail.com`), 'PE_L1_EMAIL'),
  col('CAMPO6', 'varchar', 16, many(() => `9${digits(8)}`), 'PE_L1_TELEFONO'),
  col('CAMPO7', 'varchar', 150, many(address), 'PE_L1_DIRECCION'),
  col('CAMPO8', 'varchar', 19, many(() => luhn('5', 16)), 'PE_L1_TARJETA'),
  col('CAMPO9', 'varchar', 15, many(() => `192.168.${int(0, 255)}.${int(1, 254)}`), 'PE_L1_IP'),
  col('CAMPO10', 'varchar', 10, many(plate), 'PE_L1_PLACA'),
  col('CAMPO11', 'varchar', 11, many(() => ruc()), 'PE_L1_RUC'),
  col('TXT', 'clob', 4000, many(() => `Paciente ${pick(GIVEN)} ${pick(SURNAMES)}, DNI ${dni()}, cel 9${digits(8)}.`), 'PE_L1_TEXTO_LIBRE'),

  // L2
  col('FECHA_NACIMIENTO', 'date', 0, many(() => iso(1940, 2010)), 'PE_L2_FECHA_NACIMIENTO'),
  col('FEC_NAC', 'varchar', 10, many(() => iso(1940, 2010)), 'PE_L2_FECHA_NACIMIENTO'),
  col('fechaNacimiento', 'timestamp', 0, many(() => iso(1940, 2010)), 'PE_L2_FECHA_NACIMIENTO'),
  col('ANIO_NACIMIENTO', 'number', 4, many(() => String(int(1940, 2010))), 'PE_L2_ANIO_NACIMIENTO'),
  col('EDAD', 'number', 3, many(() => String(int(0, 99))), 'PE_L2_EDAD'),
  col('FECHA_DEFUNCION', 'date', 0, many(() => iso(2000, 2025)), 'PE_L2_FECHA_EVENTO'),
  col('FECHA_INGRESO', 'date', 0, many(() => iso(1990, 2025)), 'PE_L2_FECHA_EVENTO'),
  col('SEXO', 'char', 1, many(() => pick(['F', 'M'])), 'PE_L2_SEXO'),
  col('GENERO', 'varchar', 10, many(() => pick(['Femenino', 'Masculino'])), 'PE_L2_SEXO'),
  col('DISTRITO', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'PE_L2_DISTRITO'),
  col('PROVINCIA', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'PE_L2_DISTRITO'),
  col('LUGAR_NACIMIENTO', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'PE_L2_DISTRITO'),
  col('CAMPO12', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'PE_L2_DISTRITO'),
  col('UBIGEO', 'varchar', 6, many(() => pick(DISTRITOS).code), 'PE_L2_UBIGEO'),
  col('CODIGO_POSTAL', 'varchar', 5, many(() => String(int(15001, 15999))), 'PE_L2_CODIGO_POSTAL'),
  col('CENTRO_POBLADO', 'varchar', 40, many(() => `Caserío ${pick(['El Milagro', 'Santa Rosa', 'La Esperanza'])}`), 'PE_L2_CENTRO_POBLADO'),
  col('URBANIZACION', 'varchar', 60, many(() => pick(URBANIZACIONES)), 'PE_L2_URBANIZACION'),
  col('ESTADO_CIVIL', 'varchar', 30, many(() => pick(['Soltero', 'Casado', 'Conviviente', 'Viudo'])), 'PE_L2_ESTADO_CIVIL'),
  col('PROFESION', 'varchar', 60, many(() => pick(['Docente', 'Chofer', 'Enfermera'])), 'PE_L2_OCUPACION'),
  col('NOMBRE_EMPLEADOR', 'varchar', 80, many(() => `Distribuidora ${int(1, 99)} S.A.C.`), 'PE_L2_EMPLEADOR'),
  col('NIVEL_EDUCATIVO', 'varchar', 40, many(() => pick(['Secundaria completa', 'Superior universitaria completa', 'Primaria completa'])), 'PE_L2_NIVEL_EDUCATIVO'),
  col('INSTITUCION_EDUCATIVA', 'varchar', 80, many(() => `I.E. ${int(1000, 9999)} ${pick(['San Martín', 'Las Flores'])}`), 'PE_L2_INSTITUCION_EDUCATIVA'),
  col('PERSONAS_A_CARGO', 'number', 2, many(() => String(int(0, 8))), 'PE_L2_PERSONAS_A_CARGO'),

  // L3
  col('AUTOIDENTIFICACION_ETNICA', 'varchar', 60, many(() => pick(['Quechua', 'Aimara', 'Mestizo', 'Blanco'])), 'PE_L3_ORIGEN_ETNICO'),
  col('CAMPO13', 'varchar', 60, many(() => pick(['Quechua', 'Aimara', 'Nikkei', 'Mestizo'])), 'PE_L3_ORIGEN_ETNICO'),
  col('PUEBLO_INDIGENA', 'varchar', 60, many(() => pick(['Asháninka', 'Awajún', 'Shipibo-Konibo', 'Yine'])), 'PE_L3_PUEBLO_INDIGENA'),
  col('LENGUA_MATERNA', 'varchar', 30, many(() => pick(['Quechua', 'Castellano', 'Aimara'])), 'PE_L3_LENGUA'),
  col('NACIONALIDAD', 'varchar', 20, many(() => pick(['Peruana', 'Venezolana', 'Colombiana'])), 'PE_L3_NACIONALIDAD'),
  col('RELIGION', 'varchar', 40, many(() => pick(['Católica', 'Evangélica', 'Ninguna'])), 'PE_L3_RELIGION'),
  col('OBJECION_CONCIENCIA', 'varchar', 60, many(() => pick(['Transfusiones', 'Ninguna'])), 'PE_L3_CONVICCION_FILOSOFICA'),
  col('INTENCION_VOTO', 'varchar', 40, many(() => pick(['Izquierda', 'Derecha', 'Centro'])), 'PE_L3_OPINION_POLITICA'),
  col('PARTIDO_POLITICO', 'varchar', 60, many(() => pick(['Fuerza Popular', 'Perú Libre', 'Acción Popular'])), 'PE_L3_AFILIACION_PARTIDARIA'),
  col('CUOTA_SINDICAL', 'char', 1, many(() => pick(['S', 'N'])), 'PE_L3_AFILIACION_SINDICAL'),
  col('HUELLA_DACTILAR', 'varchar', 200, many(() => many(() => pick('ABCDEF0123456789'), 64).join('')), 'PE_L3_BIOMETRICO'),
  col('PRUEBA_ADN', 'varchar', 200, many(() => 'AGTC'.repeat(10)), 'PE_L3_GENETICO'),
  col('ORIENTACION_SEXUAL', 'varchar', 30, many(() => pick(['Heterosexual', 'Gay', 'Bisexual'])), 'PE_L3_ORIENTACION_SEXUAL'),
  col('VIDA_SEXUAL_ACTIVA', 'char', 1, many(() => pick(['S', 'N'])), 'PE_L3_VIDA_SEXUAL'),
  col('IDENTIDAD_GENERO', 'varchar', 30, many(() => pick(['Mujer trans', 'Hombre cisgénero'])), 'PE_L3_IDENTIDAD_GENERO'),
  col('VICTIMA_VIOLENCIA', 'char', 1, many(() => pick(['S', 'N'])), 'PE_L3_VICTIMA'),

  // SALUD
  col('NUMERO_HISTORIA_CLINICA', 'varchar', 12, many(() => String(int(100000, 9999999))), 'PE_SALUD_IDENTIFICADOR'),
  col('COBERTURA_MEDICA', 'varchar', 30, many(() => pick(['EsSalud', 'SIS', 'EPS', 'Privado'])), 'PE_SALUD_COBERTURA'),
  col('DIAGNOSTICO', 'varchar', 6, many(() => pick(['E11.9', 'I10', 'J45.9', 'F32.1'])), 'PE_SALUD_DIAGNOSTICO'),
  col('CAUSA_DEFUNCION', 'varchar', 6, many(() => pick(['I219', 'C509', 'X954', 'J189'])), 'PE_SALUD_DIAGNOSTICO'),
  col('CODIGO_PROCEDIMIENTO', 'varchar', 6, many(() => String(int(10000, 999999))), 'PE_SALUD_PROCEDIMIENTO'),
  col('MEDICAMENTO', 'varchar', 40, many(() => pick(['Sertralina', 'Paracetamol', 'Metformina'])), 'PE_SALUD_MEDICAMENTO'),
  col('EVOLUCION', 'clob', 4000, many(() => `Paciente refiere dolor abdominal de ${int(1, 9)} días de evolución.`), 'PE_SALUD_TEXTO_CLINICO'),
  col('RESULTADO_EXAMEN', 'varchar', 12, many(() => pick(['Normal', 'Alterado'])), 'PE_SALUD_RESULTADO_EXAMEN'),
  col('PRUEBA_VIH', 'varchar', 12, many(() => pick(['Reactivo', 'No reactivo'])), 'PE_SALUD_VIH'),
  col('GRUPO_SANGUINEO', 'varchar', 4, many(() => pick(['A+', 'O-', 'AB+', 'O+'])), 'PE_SALUD_GRUPO_SANGUINEO'),
  col('TIPO_DISCAPACIDAD', 'varchar', 40, many(() => pick(['Física o motora', 'Visual', 'Auditiva', 'Ninguna'])), 'PE_SALUD_DISCAPACIDAD'),
  col('APTITUD_LABORAL', 'varchar', 30, many(() => pick(['Apto', 'No apto'])), 'PE_SALUD_OCUPACIONAL'),
  col('GESTANTE', 'char', 1, many(() => pick(['S', 'N'])), 'PE_SALUD_REPRODUCTIVA'),
  col('TRASTORNO_MENTAL', 'varchar', 60, many(() => pick(['Depresión', 'Ansiedad'])), 'PE_SALUD_MENTAL'),

  // FIN
  col('SUELDO', 'number', 8, many(() => String(int(1130, 12000))), 'PE_FIN_INGRESOS'),
  col('HISTORIAL_CREDITICIO', 'varchar', 40, many(() => pick(['Normal', 'Deficiente', 'Dudoso'])), 'PE_FIN_HISTORIAL_CREDITICIO'),
  col('SALDO_DEUDA', 'number', 10, many(() => String(int(100, 200000))), 'PE_FIN_DEUDA'),
  col('VALOR_AUTOVALUO', 'number', 10, many(() => String(int(5000, 400000))), 'PE_FIN_PATRIMONIO'),
  col('MONTO_PENSION', 'number', 8, many(() => String(int(300, 4000))), 'PE_FIN_PENSION'),
  col('BENEFICIARIO_PROGRAMA', 'char', 1, many(() => pick(['S', 'N'])), 'PE_FIN_PROGRAMA_SOCIAL'),
  col('CLASIFICACION_SOCIOECONOMICA', 'varchar', 30, many(() => pick(['Pobre', 'Pobre extremo', 'No pobre'])), 'PE_FIN_CLASIFICACION_SOCIOECONOMICA'),
  col('TENENCIA_VIVIENDA', 'varchar', 40, many(() => pick(['Propia', 'Alquilada', 'Cedida'])), 'PE_FIN_VIVIENDA'),

  // PENAL
  col('ANTECEDENTES_PENALES', 'varchar', 60, many(() => pick(['No registra antecedentes penales', 'Registra antecedentes'])), 'PE_PENAL_ANTECEDENTES'),
  col('NUMERO_EXPEDIENTE_JUDICIAL', 'varchar', 30, many(() => `${pad(int(1, 99999), 5)}-${int(2015, 2026)}-0-1801-JR-CI-${pad(int(1, 30), 2)}`), 'PE_PENAL_EXPEDIENTE'),

  // Not personal data: nothing should be assigned
  col('ID', 'integer', 10, many((i) => String(i + 1)), ''),
  col('RUTA_ARCHIVO', 'varchar', 200, many(() => `/datos/archivo${int(1, 99)}.txt`), ''),
  col('NOMBRE_PRODUCTO', 'varchar', 80, many(() => pick(['Arroz extra 1 kg', 'Maíz morado 500 g', 'Café molido 250 g'])), ''),
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
  col('DEPARTAMENTO', 'varchar', 30, many(() => pick(['Lima', 'Arequipa', 'La Libertad', 'Piura'])), ''),
  col('COD_BANCO', 'varchar', 4, many(() => pick(['0011', '0002', '0009'])), ''),
  col('URL_PAGINA', 'varchar', 200, many(() => `https://www.ejemplo.com.pe/p/${int(1, 999)}`), ''),
  col('TIPO_DOCUMENTO', 'varchar', 4, many(() => pick(['DNI', 'RUC', 'PAS', 'CE'])), ''),
  col('MONEDA', 'varchar', 3, many(() => pick(['PEN', 'USD'])), ''),
  col('CATEGORIA', 'varchar', 30, many(() => pick(['Abarrotes', 'Panadería'])), ''),
  col('CODIGO_CIIU', 'varchar', 4, many(() => pick(['4711', '6201', '8621'])), ''),
  col('IDIOMA_INTERFAZ', 'varchar', 5, many(() => pick(['es-PE', 'en', 'es'])), ''),
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
  // The essential pack has no domain for the urbanización, and an address classifier does find one:
  // the column is still masked, by the address algorithm.
  const ALSO = { URBANIZACION: 'PE_L1_DIRECCION' }
  const packPassed = profile(pack, (c) => (essential.has(c.expect) ? c.expect : (ALSO[c.name] ?? '')), 'essential pack, ')
  console.log(`profiled ${COLUMNS.length} columns with the essential pack (${pack.length} classifiers): ${packPassed} as expected`)
}

// ── Distritos and provincias, offline ───────────────────────────────────────
//
// Every distrito of under 20,000 inhabitants must become one of at least 20,000 of the same
// provincia — or of the same departamento when its provincia has none — written with its provincia,
// with its departamento and by its UBIGEO; by its name alone, unless the name is shared with a
// large place.

const readTable = (name) => new Map(fs.readFileSync(nodePath.join(HERE, 'files', name), 'utf8').split('\n').filter(Boolean).map((l) => l.split('|')))

function verifyGeneralization() {
  const table = readTable('pe-distritos-generalizados.txt')
  const codes = readTable('pe-ubigeo-generalizado.txt')
  const byCode = new Map(DISTRITOS.map((d) => [d.code, d]))
  const places = [...DISTRITOS, ...PROVINCIAS]
  const key = (n) => fold(n).toLowerCase()
  const byName = new Map()
  for (const p of places) byName.set(key(p.name), [...(byName.get(key(p.name)) ?? []), p])
  // A name borne only by small places is generalized to the fate of the most populous of them, and
  // that bearer may be a provincia: the target is then a large provincia, not a large distrito.
  const largeNames = new Set([...LARGE_NAMES, ...PROVINCIAS.filter((p) => p.population >= 20000).map((p) => p.name)])
  let ok = 0
  let shared = 0
  let shown = 0
  for (const d of DISTRITOS) {
    const problems = []
    // The provincia written beside a generalized distrito is the one it ends up in; when the
    // provincia is itself small it is generalized too, so the audit only asks for a large one.
    const province = provinceByCode.get(d.provinceCode)
    const withDepartment = table.get(`${d.name} - ${d.department}`)
    const alone = table.get(d.name)
    const code = codes.get(d.code)
    const homonyms = byName.get(key(d.name))
    if (d.population >= 20000) {
      if (withDepartment || alone || code) problems.push('a large distrito is generalized')
    } else {
      if (homonyms.length > 1) shared++
      if (homonyms.some((x) => x.population >= 20000 && x.departmentCode === d.departmentCode)) { if (withDepartment) problems.push('a name shared with a large place of its departamento is generalized') }
      else if (!withDepartment || !withDepartment.endsWith(` - ${d.department}`) || !largeNames.has(withDepartment.slice(0, -` - ${d.department}`.length))) problems.push(`with its departamento: ${withDepartment ?? 'not in the table'}`)
      if (homonyms.some((x) => x.population >= 20000)) { if (alone) problems.push('a name shared with a large place is generalized') }
      else if (!alone || !largeNames.has(alone)) problems.push(`by name: ${alone ?? 'not in the table'}`)
      const target = code && byCode.get(code)
      if (!target || target.population < 20000 || target.departmentCode !== d.departmentCode) problems.push(`UBIGEO ${d.code} → ${code}`)
      void province
      // The nearest large distrito of the same provincia, when that provincia has one.
      const inProvince = DISTRITOS.some((x) => x.provinceCode === d.provinceCode && x.population >= 20000)
      if (target && inProvince && target.provinceCode !== d.provinceCode) problems.push(`UBIGEO left its provincia: ${code}`)
    }
    if (problems.length) { failures++; if (shown++ < 15) console.log(`  ✗ ${d.name}/${d.province}/${d.department} (${d.population}): ${problems.join('; ')}`) }
    else ok++
  }
  console.log(`distritos: ${ok} of ${DISTRITOS.length} generalized as expected (${shared} small ones share a name)`)

  // Every provincia under 20,000 becomes a large one of its own departamento, by code and by name.
  let provOk = 0
  for (const p of PROVINCIAS) {
    const problems = []
    const code = codes.get(p.code)
    if (p.population >= 20000) { if (code) problems.push('a large provincia is generalized') }
    else {
      const target = PROVINCIAS.find((x) => x.code === code)
      if (!target || target.population < 20000 || target.departmentCode !== p.departmentCode) problems.push(`UBIGEO ${p.code} → ${code}`)
    }
    if (problems.length) { failures++; console.log(`  ✗ provincia ${p.name}/${p.department} (${p.population}): ${problems.join('; ')}`) }
    else provOk++
  }
  console.log(`provincias: ${provOk} of ${PROVINCIAS.length} generalized as expected`)
}

// ── Algorithms ──────────────────────────────────────────────────────────────

const words = (s) => s.trim().split(/\s+/).length
const sameShape = (i, o) => i.length === o.length && i.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9') === o.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9')
const digitShape = (i, o) => i.length === o.length && i.replace(/\d/g, '9') === o.replace(/\d/g, '9')
const MASKING = {
  PE_L1_DNI: {
    inputs: ['45678901', '45678901-7', '456789017', '20131378972', ...many(dni, 10), ...many(() => dniBody(), 5)],
    check: (i, o) => (/^\d{11}$/.test(i) ? validRuc(o) : /^\d{8}$/.test(i) ? digitShape(i, o) : validDni(o) && digitShape(i, o)),
  },
  PE_L1_RUC: { inputs: ['20131378972', '10456789017', ...many(() => ruc(), 10)], check: (i, o) => validRuc(o) && o.slice(0, 2) === i.slice(0, 2) },
  PE_L1_DIGITO_VERIFICACION: { inputs: ['7', 'K'], check: sameShape },
  PE_L1_CARNE_EXTRANJERIA: { inputs: ['001234567'], check: sameShape },
  PE_L1_PASAPORTE: { inputs: ['A1234567'], check: sameShape },
  PE_L1_ACTA: { inputs: ['123/1985'], check: sameShape },
  PE_L1_SEGURO_SOCIAL: { inputs: ['JUQU12345678'], check: sameShape },
  PE_L1_CODIGO_ESTUDIANTE: { inputs: ['20201234'], check: sameShape },
  PE_L1_COLEGIATURA: { inputs: ['CMP-12345'], check: sameShape },
  PE_L1_NOMBRE: { inputs: ['Milagros', 'JOSÉ CARLOS', 'María de los Ángeles'], check: (i, o) => words(i) === words(o) && (!/ de /.test(i) || / de /.test(o)) },
  PE_L1_APELLIDO: { inputs: ['Quispe', 'HUAMÁN ROJAS', 'Quispe de Huamán'], check: (i, o) => words(i) === words(o) && (!/ de /.test(i) || / de /.test(o)) },
  PE_L1_NOMBRE_COMPLETO: {
    inputs: ['Milagros Quispe', 'JUAN CARLOS QUISPE', 'Juan Carlos Quispe Huamán', 'María del Rosario Quispe de Huamán', 'QUISPE HUAMÁN, JUAN CARLOS'],
    check: (i, o) => words(i) === words(o) && [' de ', ' del '].every((w) => i.includes(w) === o.includes(w)),
  },
  PE_L1_RAZON_SOCIAL: { inputs: ['Corporación Comercial Peruana S.A.C.'] },
  PE_L1_EMAIL: { inputs: ['milagros.quispe@gmail.com', 'josé.muñoz@empresa.com.pe'], check: (i, o) => /@[^@]+\.test$/.test(o) },
  PE_L1_TELEFONO: {
    inputs: ['+51 987 654 321', '987654321', '(01) 234-5678', '944 123 456'],
    // The country code, the leading 9 of a mobile and the area code stay, and the length does too.
    check: (i, o) => digitShape(i, o) && o.replace(/\D/g, '').slice(-9)[0] === i.replace(/\D/g, '').slice(-9)[0] && o !== i,
  },
  PE_L1_DIRECCION: { inputs: ['Av. Arequipa 1234, Urb. Santa Patricia', 'Km 12 Carretera Central'] },
  PE_L1_DIRECCION_COMPLEMENTO: { inputs: ['Mz. B Lt. 12', 'Int. 301'] },
  PE_L1_CUENTA_BANCARIA: { inputs: ['0011-0123-0100123456'], check: digitShape },
  PE_L1_TARJETA: { inputs: ['4557 8800 0000 0001'] },
  PE_L1_BILLETERA: { inputs: ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'], check: sameShape },
  PE_L1_IP: { inputs: ['190.117.45.12', '2001:1388:f80::1'], check: (i, o) => (i.includes('.') ? o.split('.').every((p) => Number(p) >= 1 && Number(p) <= 254) : /^[0-9a-f:]+$/i.test(o)) },
  PE_L1_DISPOSITIVO: { inputs: ['3c:22:fb:9a:10:e4', '356938035643809'], check: (i, o) => (i.includes(':') ? /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(o) : /^\d{15}$/.test(o)) },
  PE_L1_COOKIE: { inputs: ['GA1.2.123456789.1700000000'], check: sameShape },
  PE_L1_PLACA: { inputs: ['ABC-123', 'A1B-234', 'MB-1234'], check: sameShape },
  PE_L1_VEHICULO: { inputs: ['8AJHA8CD3J1234567'], check: sameShape },
  PE_L1_INMUEBLE: { inputs: ['P12345678'], check: sameShape },
  PE_L1_CONTRATO: { inputs: ['CT-123456'] },
  PE_L1_USUARIO: { inputs: ['@milagros_quispe'] },
  PE_L1_CREDENCIAL: { inputs: ['Clave#2024'], check: (i, o) => /^X+$/.test(o) },
  PE_L1_GEOLOCALIZACION: { inputs: ['-12.046374', '-12.046374,-77.042793'], check: (i, o) => o.slice(0, 5) === i.slice(0, 5) },
  PE_L1_TEXTO_LIBRE: {
    inputs: ['Cliente Quispe, DNI 45678901, correo m.quispe@gmail.com, cel 987654321.'],
    check: (i, o) => !/45678901|m\.quispe@gmail\.com|987654321|Quispe/.test(o),
  },
  PE_L2_FECHA_NACIMIENTO: { inputs: ['1985-07-20', '2012-01-15'], check: (i, o) => Math.abs(new Date(o.slice(0, 10)) - new Date(i)) <= 60 * 864e5 },
  PE_L2_ANIO_NACIMIENTO: { inputs: ['1985'], check: (i, o) => o.startsWith('198'), same: true },
  PE_L2_EDAD: { inputs: ['37', '7', '104'], check: (i, o) => (i === '104' ? o === '90' : i.length === 1 || o[0] === i[0]), same: true },
  PE_L2_FECHA_EVENTO: { inputs: ['2021-03-15'] },
  PE_L2_SEXO: { inputs: ['F', 'M', 'Femenino', 'masculino', 'Hombre', '1'], same: true },
  PE_L2_DISTRITO: { inputs: ['Asunción', 'Lima', 'MIRAFLORES', 'Balsas - Amazonas', 'Chiliquín', 'Arequipa'], same: true },
  PE_L2_UBIGEO: { inputs: ['010102', '150101'], same: true },
  PE_L2_CENTRO_POBLADO: { inputs: ['Caserío El Milagro'] },
  PE_L2_URBANIZACION: { inputs: ['Urb. Santa Patricia'], same: true },
  PE_L2_CODIGO_POSTAL: { inputs: ['15001'], check: (i, o) => o === '15000' },
  PE_L2_ESTADO_CIVIL: { inputs: ['Unión de hecho', '2'], same: true },
  PE_L2_OCUPACION: { inputs: ['Gerente de operaciones', '2221'] },
  PE_L2_EMPLEADOR: { inputs: ['Corporación Comercial Peruana S.A.C.'] },
  PE_L2_NIVEL_EDUCATIVO: { inputs: ['Educación superior en curso', '7'], same: true },
  PE_L2_INSTITUCION_EDUCATIVA: { inputs: ['Universidad Nacional de Ingeniería'] },
  PE_L2_PERSONAS_A_CARGO: { inputs: ['9', '2'], check: (i, o) => Number(o) <= 5, same: true },
  PE_L3_ORIGEN_ETNICO: { inputs: ['Indígena', '3', 'N'], same: true },
  PE_L3_PUEBLO_INDIGENA: { inputs: ['Pueblo Ese Eja'], same: true },
  PE_L3_LENGUA: { inputs: ['Quechua chanka'], same: true },
  PE_L3_NACIONALIDAD: { inputs: ['Panameña'], same: true },
  PE_L3_RELIGION: { inputs: ['Ortodoxa', 'N'], same: true },
  PE_L3_CONVICCION_FILOSOFICA: { inputs: ['Se niega a transfusiones'] },
  PE_L3_OPINION_POLITICA: { inputs: ['Oficialista'], same: true },
  PE_L3_AFILIACION_PARTIDARIA: { inputs: ['Frente Amplio', 'S'], same: true },
  PE_L3_AFILIACION_SINDICAL: { inputs: ['SUTEP', 'S'], same: true },
  PE_L3_BIOMETRICO: { inputs: ['A1B2C3D4E5F6'] },
  PE_L3_GENETICO: { inputs: ['BRCA1 positivo'] },
  PE_L3_ORIENTACION_SEXUAL: { inputs: ['Homosexual'], same: true },
  PE_L3_VIDA_SEXUAL: { inputs: ['Activa'] },
  PE_L3_IDENTIDAD_GENERO: { inputs: ['Transgénero'], same: true },
  PE_L3_VICTIMA: { inputs: ['Violencia familiar', 'S'], same: true },
  PE_SALUD_IDENTIFICADOR: { inputs: ['HC-2024-00123'] },
  PE_SALUD_COBERTURA: { inputs: ['EsSalud', '12345'], same: true },
  PE_SALUD_DIAGNOSTICO: { inputs: ['F33.1', 'B24X', 'E119', 'Depresión mayor'], same: true },
  PE_SALUD_PROCEDIMIENTO: { inputs: ['901234', 'Prueba de carga viral para VIH'], same: true },
  PE_SALUD_MEDICAMENTO: { inputs: ['Sertralina 50 mg'] },
  PE_SALUD_TEXTO_CLINICO: { inputs: ['Paciente Quispe, DNI 45678901, consulta por cefalea.'], check: (i, o) => !o.includes('45678901') },
  PE_SALUD_RESULTADO_EXAMEN: { inputs: ['Reactivo'] },
  PE_SALUD_VIH: { inputs: ['Reactivo', 'S'], same: true },
  PE_SALUD_GRUPO_SANGUINEO: { inputs: ['O+'], same: true },
  PE_SALUD_DISCAPACIDAD: { inputs: ['Trastorno del espectro autista', 'N'], same: true },
  PE_SALUD_OCUPACIONAL: { inputs: ['No apto temporalmente', 'S'], same: true },
  PE_SALUD_REPRODUCTIVA: { inputs: ['12 semanas de gestación', 'S'], same: true },
  PE_SALUD_MENTAL: { inputs: ['Trastorno bipolar'] },
  PE_FIN_INGRESOS: { inputs: ['2800'] },
  PE_FIN_HISTORIAL_CREDITICIO: { inputs: ['Reportado en la central de riesgo', '745', 'N'], same: true },
  PE_FIN_DEUDA: { inputs: ['18400'] },
  PE_FIN_PATRIMONIO: { inputs: ['148000'] },
  PE_FIN_PENSION: { inputs: ['1050'] },
  PE_FIN_PROGRAMA_SOCIAL: { inputs: ['Bono Yanapay', 'S'], same: true },
  PE_FIN_CLASIFICACION_SOCIOECONOMICA: { inputs: ['Pobre extremo', '2'], same: true },
  PE_FIN_VIVIENDA: { inputs: ['Ocupación de hecho'], same: true },
  PE_PENAL_ANTECEDENTES: { inputs: ['Sentenciado por hurto en 2019', 'S'], same: true },
  PE_PENAL_EXPEDIENTE: {
    inputs: ['00123-2024-0-1801-JR-CI-01', '1234/2023', 'PN-456-2022'],
    check: (i, o) => digitShape(i, o) && o.replace(/\d/g, '') === i.replace(/\d/g, '') && o.slice(-4) !== undefined,
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
  PE_L1_NOMBRE: (i, o) => o.split(/\s+/).every((w) => PARTICLE.test(w) || has('pe-nombres.txt', w)),
  PE_L1_APELLIDO: (i, o) => o.split(/\s+/).every((w) => PARTICLE.test(w) || has('pe-apellidos.txt', w)),
  PE_L1_NOMBRE_COMPLETO: (i, o) => i.includes(',') || (has('pe-nombres.txt', o.split(/\s+/)[0]) && has('pe-apellidos.txt', o.split(/\s+/).at(-1))),
  PE_L1_RAZON_SOCIAL: (i, o) => has('pe-razones-sociales.txt', o),
  PE_L1_DIRECCION: (i, o) => has('pe-direcciones.txt', o),
  PE_L2_SEXO: (i, o) => ({ f: ['f', 'm'], m: ['f', 'm'], femenino: ['femenino', 'masculino'], masculino: ['femenino', 'masculino'], hombre: ['mujer', 'hombre'], 1: ['1', '2'] })[i.toLowerCase()].includes(o.toLowerCase()),
  // Asunción and Chiliquín are small and become large distritos; Lima, Miraflores and Arequipa stay;
  // Balsas written with its departamento keeps the shape "name - departamento".
  PE_L2_DISTRITO: (i, o) => ({
    Lima: o === 'Lima',
    MIRAFLORES: o === 'MIRAFLORES',
    Arequipa: o === 'Arequipa',
    'Balsas - Amazonas': / - Amazonas$/.test(o) && LARGE.has(o.replace(/ - Amazonas$/, '').toLowerCase()),
  })[i] ?? LARGE.has(o.toLowerCase()),
  PE_L2_UBIGEO: (i, o) => (i === '150101' ? o === i : o.length === i.length && o.slice(0, 2) === i.slice(0, 2) && o !== i),
  PE_L2_URBANIZACION: (i, o) => has('pe-urbanizaciones.txt', o),
  PE_L2_CENTRO_POBLADO: (i, o) => o === 'Zona rural',
  PE_L3_NACIONALIDAD: (i, o) => has('pe-nacionalidades.txt', o),
  PE_L2_ESTADO_CIVIL: (i, o) => (/^\d$/.test(i) ? /^[1-6]$/.test(o) : has('pe-estado-civil.txt', o)),
  PE_L2_OCUPACION: (i, o) => (/^\d+$/.test(i) ? /^\d{4}$/.test(o) : has('pe-ocupaciones.txt', o)),
  PE_L2_EMPLEADOR: (i, o) => has('pe-empleadores.txt', o),
  PE_L2_NIVEL_EDUCATIVO: (i, o) => (/^\d+$/.test(i) ? has('pe-nivel-educativo-codigos.txt', o) : has('pe-nivel-educativo.txt', o)),
  PE_L2_INSTITUCION_EDUCATIVA: (i, o) => has('pe-instituciones-educativas.txt', o),
  PE_L3_ORIGEN_ETNICO: (i, o) => flag(i, o) ?? (/^\d$/.test(i) ? has('pe-origen-etnico-codigos.txt', o) : has('pe-origen-etnico.txt', o)),
  PE_L3_PUEBLO_INDIGENA: (i, o) => has('pe-pueblos-indigenas.txt', o),
  PE_L3_LENGUA: (i, o) => has('pe-lenguas.txt', o),
  PE_L3_RELIGION: (i, o) => flag(i, o) ?? has('pe-religiones.txt', o),
  PE_L3_CONVICCION_FILOSOFICA: (i, o) => o === SUPPRESSED,
  PE_L3_OPINION_POLITICA: (i, o) => has('pe-ideologias-politicas.txt', o),
  PE_L3_AFILIACION_PARTIDARIA: (i, o) => flag(i, o) ?? has('pe-partidos.txt', o),
  PE_L3_AFILIACION_SINDICAL: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  PE_L3_ORIENTACION_SEXUAL: (i, o) => has('pe-orientaciones-sexuales.txt', o),
  PE_L3_VIDA_SEXUAL: (i, o) => o === SUPPRESSED,
  PE_L3_IDENTIDAD_GENERO: (i, o) => has('pe-identidades-genero.txt', o),
  PE_L3_VICTIMA: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  PE_SALUD_COBERTURA: (i, o) => (/^\d+$/.test(i) ? digitShape(i, o) : has('pe-cobertura-salud.txt', o)),
  PE_SALUD_DIAGNOSTICO: (i, o) => (/^[A-Z]\d/.test(i) ? has(i.includes('.') ? 'pe-cie10-decimal.txt' : 'pe-cie10.txt', o) : has('pe-diagnosticos.txt', o)),
  PE_SALUD_PROCEDIMIENTO: (i, o) => (/^\d+$/.test(i) ? digitShape(i, o) : has('pe-procedimientos.txt', o)),
  PE_SALUD_MEDICAMENTO: (i, o) => has('pe-medicamentos.txt', o),
  PE_SALUD_VIH: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  PE_SALUD_GRUPO_SANGUINEO: (i, o) => has('pe-grupos-sanguineos.txt', o),
  PE_SALUD_DISCAPACIDAD: (i, o) => flag(i, o) ?? has('pe-discapacidades.txt', o),
  PE_SALUD_OCUPACIONAL: (i, o) => flag(i, o) ?? has('pe-aptitud-laboral.txt', o),
  PE_SALUD_REPRODUCTIVA: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  PE_SALUD_MENTAL: (i, o) => o === SUPPRESSED,
  PE_FIN_HISTORIAL_CREDITICIO: (i, o) => flag(i, o) ?? (/^\d+$/.test(i) ? digitShape(i, o) : has('pe-estados-credito.txt', o)),
  PE_FIN_PROGRAMA_SOCIAL: (i, o) => flag(i, o) ?? has('pe-programas-sociales.txt', o),
  PE_FIN_CLASIFICACION_SOCIOECONOMICA: (i, o) => flag(i, o) ?? (/^\d$/.test(i) ? has('pe-clasificacion-socioeconomica-codigos.txt', o) : has('pe-clasificacion-socioeconomica.txt', o)),
  PE_FIN_VIVIENDA: (i, o) => has('pe-tenencia-vivienda.txt', o),
  PE_PENAL_ANTECEDENTES: (i, o) => flag(i, o) ?? has('pe-antecedentes.txt', o),
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
  const TYPED = new Set(['PE_L2_FECHA_NACIMIENTO', 'PE_L2_FECHA_EVENTO', 'PE_FIN_DEUDA', 'PE_FIN_INGRESOS', 'PE_FIN_PATRIMONIO', 'PE_FIN_PENSION'])
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

  // DNIs stay DNIs: 150 distinct inputs give 150 distinct outputs with a valid check character.
  const dnis = [...new Set(many(dni, 150))]
  const dniOut = new Set()
  let dniBad = 0
  let i = 0
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < dnis.length) {
      const { output } = await run('PE_DNI_CON_DIGITO', dnis[i++])
      dniOut.add(output)
      if (!output || !validDni(output)) dniBad++
    }
  }))
  if (dniOut.size !== dnis.length || dniBad) { failures++; console.log(`  ✗ DNI: ${dnis.length} inputs gave ${dniOut.size} distinct outputs, ${dniBad} invalid`) }
  else console.log(`DNI: ${dnis.length} distinct inputs, ${dniOut.size} distinct outputs with a valid check digit`)

  // The letter series of the documents issued up to 2007.
  const letterDnis = [...new Set(many(() => { const b = dniBody(); return `${b}-${dniLetter(b)}` }, 60))]
  let letterBad = 0
  let k = 0
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (k < letterDnis.length) {
      const { output } = await run('PE_DNI_CON_LETRA', letterDnis[k++])
      if (!output || !validDni(output)) letterBad++
    }
  }))
  if (letterBad) { failures++; console.log(`  ✗ DNI letter series: ${letterBad} of ${letterDnis.length} invalid`) }
  else console.log(`DNI letter series: ${letterDnis.length} inputs, all with a valid check letter`)

  // RUCs of every kind of taxpayer: the two leading digits stay and the digit is recomputed.
  const rucs = [...new Set(['10', '15', '17', '20'].flatMap((p) => many(() => ruc(p), 50)))]
  const rucOut = new Set()
  let rucBad = 0
  let keptPrefix = 0
  let hardCase = 0
  let j = 0
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (j < rucs.length) {
      const input = rucs[j++]
      const { output } = await run('PE_RUC', input)
      rucOut.add(output)
      if (!output || !validRuc(output)) { rucBad++; continue }
      if (output.slice(0, 2) === input.slice(0, 2)) keptPrefix++
      // The remainder the plain Check Digit gets wrong: the auxiliary has to catch it.
      if ([...output.slice(0, 10)].reduce((a, d, x) => a + Number(d) * RUC_WEIGHTS[x], 0) % 11 <= 1) hardCase++
    }
  }))
  if (rucOut.size !== rucs.length || rucBad || keptPrefix !== rucs.length || hardCase < 10) {
    failures++
    console.log(`  ✗ RUC: ${rucs.length} inputs gave ${rucOut.size} distinct outputs, ${rucBad} invalid, ${keptPrefix} kept their prefix, ${hardCase} exercised the auxiliary`)
  } else console.log(`RUC: ${rucs.length} distinct inputs, ${rucOut.size} distinct valid outputs, all keeping their kind (${hardCase} exercised the auxiliary digit)`)

  // A natural person's RUC is 10 followed by the DNI: both must mask to the same eight digits.
  let consistent = 0
  const pairs = many(() => dniBody(), 20)
  for (const body of pairs) {
    const a = await run('PE_DNI_CON_DIGITO', `${body}-${dniDigit(body)}`)
    const b = await run('PE_RUC', `10${body}${rucDigit(`10${body}`)}`)
    if (a.output && b.output && a.output.slice(0, 8) === b.output.slice(2, 10)) consistent++
  }
  if (consistent !== pairs.length) { failures++; console.log(`  ✗ DNI × RUC: ${consistent} of ${pairs.length} agree`) }
  else console.log(`DNI × RUC: ${consistent} of ${pairs.length} mask to the same eight digits`)
}

if (only !== 'algorithms') { verifyClassifiers(); verifyGeneralization() }
if (only !== 'classifiers') await verifyAlgorithms()
console.log(failures ? `\n${failures} problem(s)` : '\nall good')
process.exit(failures ? 1 : 0)
