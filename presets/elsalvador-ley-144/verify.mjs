#!/usr/bin/env node
/**
 * Checks the El Salvador (Decreto 144) preset.
 *
 *   node presets/elsalvador-ley-144/verify.mjs               # classifiers, then algorithms
 *   node presets/elsalvador-ley-144/verify.mjs classifiers   # only the local profiling check
 *   node presets/elsalvador-ley-144/verify.mjs algorithms    # only masking, against the app
 *
 * Classifiers run through classifiers/, the same evaluator the classifier test uses: every
 * configuration is reviewed, then a battery of columns — well named, badly named and unrelated —
 * is profiled with the whole set at its threshold. The table that generalizes distritos is audited
 * offline. Algorithms run in the app (DLPX_URL, default http://localhost:3000), which needs the
 * Delphix jars in lib/; every DUI and NIT they write is checked against its check-digit rule.
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

const DUI_WEIGHTS = [9, 8, 7, 6, 5, 4, 3, 2]
const duiDigit = (body) => (10 - [...body].reduce((a, d, i) => a + Number(d) * DUI_WEIGHTS[i], 0) % 10) % 10
const validDui = (v) => { const d = v.replace(/\D/g, ''); return /^\d{9}$/.test(d) && duiDigit(d.slice(0, 8)) === Number(d[8]) }

const NIT_OLD_WEIGHTS = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2]
const NIT_NEW_WEIGHTS = [2, 7, 6, 5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
/** The correlative — the third block — decides which rule the digit follows. */
const nitDigit = (body) => {
  const correlative = Number(body.slice(10, 13))
  if (correlative <= 100) {
    const r = [...body].reduce((a, d, i) => a + Number(d) * NIT_OLD_WEIGHTS[i], 0) % 11
    return r === 10 ? 0 : r
  }
  const r = [...body].reduce((a, d, i) => a + Number(d) * NIT_NEW_WEIGHTS[i], 0) % 11
  return r > 1 ? 11 - r : 0
}
const validNit = (v) => { const d = v.replace(/\D/g, ''); return /^\d{14}$/.test(d) && nitDigit(d.slice(0, 13)) === Number(d[13]) }

// ── Test data ───────────────────────────────────────────────────────────────

let seed = 144
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
const DISTRITOS = source('distritos.tsv').map((l) => {
  const [code, name, municipalityCode, municipality, departmentCode, department, , , population] = l.split('\t')
  return { code, name, municipalityCode, municipality, departmentCode, department, population: Number(population), aliases: [] }
})
const MUNICIPIOS = source('municipios.tsv').map((l) => {
  const [code, name, departmentCode, department, , , population] = l.split('\t')
  return { code, name, departmentCode, department, population: Number(population), aliases: [] }
})
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '')
const PERSONAL = new Set([...GIVEN, ...SURNAMES].map((w) => fold(w).toLowerCase()))
const SMALL_NAMES = DISTRITOS.filter((d) => d.population < 20000 && !PERSONAL.has(fold(d.name).toLowerCase())).map((d) => d.name)
const LARGE_NAMES = DISTRITOS.filter((d) => d.population >= 20000).map((d) => d.name)

const pad = (n, w) => String(n).padStart(w, '0')
const digits = (n) => many(() => int(0, 9), n).join('')
const dui = () => { const b = pad(int(0, 99999999), 8); return `${b}-${duiDigit(b)}` }
const nit = (correlative = int(1, 999)) => {
  const body = `${pad(int(101, 1499), 4)}${pad(int(1, 28), 2)}${pad(int(1, 12), 2)}${pad(int(40, 99), 2)}${pad(correlative, 3)}`
  return `${body.slice(0, 4)}-${body.slice(4, 10)}-${body.slice(10, 13)}-${nitDigit(body)}`
}
const luhn = (prefix, length) => {
  const ds = [...prefix].map(Number)
  while (ds.length < length - 1) ds.push(int(0, 9))
  const sum = ds.slice().reverse().reduce((s, d, i) => s + (i % 2 === 0 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0)
  return ds.join('') + String((10 - (sum % 10)) % 10)
}
const iso = (y0, y1) => `${int(y0, y1)}-${pad(int(1, 12), 2)}-${pad(int(1, 28), 2)}`
const fullName = () => `${pick(GIVEN)}${random() < 0.4 ? ` ${pick(GIVEN)}` : ''} ${pick(SURNAMES)} ${pick(SURNAMES)}`
const phone = () => pick([`${pick([2, 6, 7])}${int(100, 999)}-${int(1000, 9999)}`, `+503 ${pick([6, 7])}${int(100, 999)}${int(1000, 9999)}`, `${pick([2, 7])}${digits(7)}`])
const COLONIAS = source('colonias.txt')
const address = () => pick([`Calle ${pick(['Arce', 'Rubén Darío', 'Los Héroes'])} #${int(1, 900)}, ${pick(COLONIAS)}`, `Avenida España #${int(1, 900)}, Pol. ${int(1, 30)}`, `${pick(COLONIAS)}, Pasaje ${int(1, 20)} #${int(1, 90)}`, `Km ${int(1, 80)} Carretera a Santa Ana`])
const letters = (n) => many(() => pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), n).join('')
const plate = () => pick([`P${int(100, 999)}-${int(100, 999)}`, `C ${int(100, 999)} ${int(100, 999)}`, `M${int(100, 999)}-${int(100, 999)}`])

// ── Classifiers ─────────────────────────────────────────────────────────────

const SQL = { varchar: 12, char: 1, number: 2, integer: 4, date: 91, timestamp: 93, clob: 2005 }
const col = (name, type, length, values, expect) => ({ name, sqlType: SQL[type], length, values, expect })

const COLUMNS = [
  // L1 — well named
  col('NUMERO_DOCUMENTO', 'varchar', 12, many(dui), 'SV_L1_DUI'),
  col('DUI', 'varchar', 10, many(dui), 'SV_L1_DUI'),
  col('DUI_CLIENTE', 'varchar', 10, many(dui), 'SV_L1_DUI'),
  col('NIT', 'varchar', 17, many(() => nit()), 'SV_L1_NIT'),
  col('NIT_PROVEEDOR', 'varchar', 17, many(() => nit(int(101, 999))), 'SV_L1_NIT'),
  col('NRC', 'varchar', 10, many(() => `${int(1000, 999999)}-${int(0, 9)}`), 'SV_L1_NRC'),
  col('CARNE_RESIDENTE', 'varchar', 12, many(() => `R${int(100000, 999999)}`), 'SV_L1_DOCUMENTO_EXTRANJERO'),
  col('PASAPORTE', 'varchar', 10, many(() => `${letters(1)}${int(1000000, 9999999)}`), 'SV_L1_PASAPORTE'),
  col('PARTIDA_NACIMIENTO', 'varchar', 14, many(() => `${int(1, 400)}/${int(1980, 2020)}`), 'SV_L1_PARTIDA'),
  col('NUMERO_ISSS', 'varchar', 12, many(() => String(int(100000000, 999999999))), 'SV_L1_SEGURO_SOCIAL'),
  col('NIE', 'varchar', 10, many(() => String(int(1000000, 9999999))), 'SV_L1_NIE'),
  col('JVPM', 'varchar', 10, many(() => `JVPM-${int(1000, 99999)}`), 'SV_L1_MATRICULA_PROFESIONAL'),
  col('PRIMER_NOMBRE', 'varchar', 30, many(() => pick(GIVEN)), 'SV_L1_NOMBRE'),
  col('PRIMER_APELLIDO', 'varchar', 30, many(() => pick(SURNAMES)), 'SV_L1_APELLIDO'),
  col('APELLIDOS', 'varchar', 60, many(() => `${pick(SURNAMES)} ${pick(SURNAMES)}`), 'SV_L1_APELLIDO'),
  col('NOMBRE_COMPLETO', 'varchar', 120, many(fullName), 'SV_L1_NOMBRE_COMPLETO'),
  col('NOMBRE_CLIENTE', 'varchar', 120, many(fullName), 'SV_L1_NOMBRE_COMPLETO'),
  col('NOMBRE', 'varchar', 120, many(fullName), 'SV_L1_NOMBRE_COMPLETO'),
  col('CORREO_ELECTRONICO', 'varchar', 100, many(() => `${fold(pick(GIVEN)).toLowerCase()}.${int(1, 999)}@gmail.com`), 'SV_L1_EMAIL'),
  col('EMAIL', 'varchar', 100, many(() => `contacto${int(1, 999)}@empresa.com.sv`), 'SV_L1_EMAIL'),
  col('TELEFONO', 'varchar', 16, many(phone), 'SV_L1_TELEFONO'),
  col('CELULAR', 'varchar', 16, many(() => `${pick([6, 7])}${int(100, 999)}-${int(1000, 9999)}`), 'SV_L1_TELEFONO'),
  col('DIRECCION', 'varchar', 150, many(address), 'SV_L1_DIRECCION'),
  col('DOMICILIO', 'varchar', 150, many(address), 'SV_L1_DIRECCION'),
  col('POLIGONO', 'varchar', 8, many(() => `Pol. ${int(1, 40)}`), 'SV_L1_DIRECCION_COMPLEMENTO'),
  col('NUMERO_CUENTA', 'varchar', 16, many(() => digits(12)), 'SV_L1_CUENTA_BANCARIA'),
  col('NUMERO_TARJETA', 'varchar', 19, many(() => luhn('4', 16)), 'SV_L1_TARJETA'),
  col('BILLETERA_CHIVO', 'varchar', 64, many(() => `bc1q${many(() => pick('023456789acdefghjklmnpqrstuvwxyz'), 38).join('')}`), 'SV_L1_BILLETERA'),
  col('IP_ORIGEN', 'varchar', 15, many(() => `${int(1, 223)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`), 'SV_L1_IP'),
  col('MAC_ADDRESS', 'varchar', 17, many(() => many(() => int(0, 255).toString(16).padStart(2, '0'), 6).join(':')), 'SV_L1_DISPOSITIVO'),
  col('IMEI', 'varchar', 15, many(() => luhn('35', 15)), 'SV_L1_DISPOSITIVO'),
  col('COOKIE_ID', 'varchar', 40, many(() => `GA1.2.${int(100000000, 999999999)}.${int(1600000000, 1799999999)}`), 'SV_L1_COOKIE'),
  col('PLACA', 'varchar', 10, many(plate), 'SV_L1_PLACA'),
  col('NUMERO_CHASIS', 'varchar', 17, many(() => many(() => pick('ABCDEFGHJKLMNPRSTUVWXYZ0123456789'), 17).join('')), 'SV_L1_VEHICULO'),
  col('MATRICULA_INMUEBLE', 'varchar', 16, many(() => `${int(10000000, 99999999)}-${int(10000, 99999)}`), 'SV_L1_INMUEBLE'),
  col('NUMERO_CONTRATO', 'varchar', 12, many(() => `CT-${int(100000, 999999)}`), 'SV_L1_CONTRATO'),
  col('USUARIO', 'varchar', 30, many(() => `${fold(pick(GIVEN)).toLowerCase()}${int(1, 99)}`), 'SV_L1_USUARIO'),
  col('CONTRASENA', 'varchar', 60, many(() => `$2a$10$${many(() => pick('abcdefghijklmnopqrstuvwxyz0123456789'), 53).join('')}`), 'SV_L1_CREDENCIAL'),
  col('LATITUD', 'varchar', 12, many(() => `13.${int(100000, 999999)}`), 'SV_L1_GEOLOCALIZACION'),
  col('OBSERVACIONES', 'clob', 4000, many(() => `Cliente solicita actualizar datos. DUI ${dui()}, correo ${fold(pick(GIVEN)).toLowerCase()}@gmail.com.`), 'SV_L1_TEXTO_LIBRE'),

  // L1 — badly named: only the values can tell
  col('CAMPO1', 'varchar', 12, many(dui), 'SV_L1_DUI'),
  col('CAMPO2', 'varchar', 30, many(() => pick(GIVEN)), 'SV_L1_NOMBRE'),
  col('CAMPO3', 'varchar', 30, many(() => pick(SURNAMES)), 'SV_L1_APELLIDO'),
  col('CAMPO4', 'varchar', 120, many(fullName), 'SV_L1_NOMBRE_COMPLETO'),
  col('CAMPO5', 'varchar', 100, many(() => `${fold(pick(GIVEN)).toLowerCase()}@hotmail.com`), 'SV_L1_EMAIL'),
  col('CAMPO6', 'varchar', 16, many(() => `7${int(100, 999)}-${int(1000, 9999)}`), 'SV_L1_TELEFONO'),
  col('CAMPO7', 'varchar', 150, many(address), 'SV_L1_DIRECCION'),
  col('CAMPO8', 'varchar', 19, many(() => luhn('5', 16)), 'SV_L1_TARJETA'),
  col('CAMPO9', 'varchar', 15, many(() => `192.168.${int(0, 255)}.${int(1, 254)}`), 'SV_L1_IP'),
  col('CAMPO10', 'varchar', 10, many(plate), 'SV_L1_PLACA'),
  col('CAMPO11', 'varchar', 17, many(() => nit()), 'SV_L1_NIT'),
  col('TXT', 'clob', 4000, many(() => `Paciente ${pick(GIVEN)} ${pick(SURNAMES)}, DUI ${dui()}, tel 7${int(100, 999)}-${int(1000, 9999)}.`), 'SV_L1_TEXTO_LIBRE'),

  // L2
  col('FECHA_NACIMIENTO', 'date', 0, many(() => iso(1940, 2010)), 'SV_L2_FECHA_NACIMIENTO'),
  col('FEC_NAC', 'varchar', 10, many(() => iso(1940, 2010)), 'SV_L2_FECHA_NACIMIENTO'),
  col('fechaNacimiento', 'timestamp', 0, many(() => iso(1940, 2010)), 'SV_L2_FECHA_NACIMIENTO'),
  col('ANIO_NACIMIENTO', 'number', 4, many(() => String(int(1940, 2010))), 'SV_L2_ANIO_NACIMIENTO'),
  col('EDAD', 'number', 3, many(() => String(int(0, 99))), 'SV_L2_EDAD'),
  col('FECHA_DEFUNCION', 'date', 0, many(() => iso(2000, 2025)), 'SV_L2_FECHA_EVENTO'),
  col('FECHA_INGRESO', 'date', 0, many(() => iso(1990, 2025)), 'SV_L2_FECHA_EVENTO'),
  col('SEXO', 'char', 1, many(() => pick(['F', 'M'])), 'SV_L2_SEXO'),
  col('GENERO', 'varchar', 10, many(() => pick(['Femenino', 'Masculino'])), 'SV_L2_SEXO'),
  col('DISTRITO', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'SV_L2_DISTRITO'),
  col('MUNICIPIO', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'SV_L2_DISTRITO'),
  col('LUGAR_NACIMIENTO', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'SV_L2_DISTRITO'),
  col('CAMPO12', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'SV_L2_DISTRITO'),
  col('COD_MUNICIPIO', 'varchar', 6, many(() => pick(DISTRITOS).code), 'SV_L2_CODIGO_GEOGRAFICO'),
  col('CODIGO_POSTAL', 'varchar', 4, many(() => String(int(1101, 3604))), 'SV_L2_CODIGO_POSTAL'),
  col('CANTON', 'varchar', 40, many(() => `Cantón ${pick(['El Espino', 'Los Amates', 'San Antonio'])}`), 'SV_L2_CANTON'),
  col('COLONIA', 'varchar', 60, many(() => pick(COLONIAS)), 'SV_L2_COLONIA'),
  col('ESTADO_FAMILIAR', 'varchar', 30, many(() => pick(['Soltero', 'Casado', 'Acompañado', 'Viudo'])), 'SV_L2_ESTADO_FAMILIAR'),
  col('PROFESION', 'varchar', 60, many(() => pick(['Docente', 'Motorista', 'Enfermera'])), 'SV_L2_OCUPACION'),
  col('NOMBRE_PATRONO', 'varchar', 80, many(() => `Distribuidora ${int(1, 99)} S.A. de C.V.`), 'SV_L2_EMPLEADOR'),
  col('NIVEL_EDUCATIVO', 'varchar', 40, many(() => pick(['Bachillerato', 'Universitario', 'Básica'])), 'SV_L2_ESCOLARIDAD'),
  col('CENTRO_ESCOLAR', 'varchar', 80, many(() => `Centro Escolar Cantón ${pick(['El Espino', 'Las Flores'])}`), 'SV_L2_CENTRO_EDUCATIVO'),
  col('PERSONAS_A_CARGO', 'number', 2, many(() => String(int(0, 8))), 'SV_L2_PERSONAS_A_CARGO'),

  // L3
  col('PERTENENCIA_ETNICA', 'varchar', 60, many(() => pick(['Náhuat Pipil', 'Lenca', 'Mestizo', 'Ninguno'])), 'SV_L3_ORIGEN_ETNICO'),
  col('CAMPO13', 'varchar', 60, many(() => pick(['Náhuat Pipil', 'Lenca', 'Kakawira', 'Mestizo'])), 'SV_L3_ORIGEN_ETNICO'),
  col('LENGUA_MATERNA', 'varchar', 30, many(() => pick(['Náhuat', 'Español', 'Lenca'])), 'SV_L3_LENGUA_INDIGENA'),
  col('NACIONALIDAD', 'varchar', 20, many(() => pick(['Salvadoreña', 'Hondureña', 'Nicaragüense'])), 'SV_L3_NACIONALIDAD'),
  col('RELIGION', 'varchar', 40, many(() => pick(['Católica', 'Evangélica', 'Ninguna'])), 'SV_L3_RELIGION'),
  col('OBJECION_CONCIENCIA', 'varchar', 60, many(() => pick(['Transfusiones', 'Ninguna'])), 'SV_L3_CONVICCION_FILOSOFICA'),
  col('INTENCION_VOTO', 'varchar', 40, many(() => pick(['Izquierda', 'Derecha', 'Centro'])), 'SV_L3_IDEOLOGIA_POLITICA'),
  col('PARTIDO_POLITICO', 'varchar', 60, many(() => pick(['Nuevas Ideas', 'ARENA', 'FMLN', 'GANA'])), 'SV_L3_AFILIACION_PARTIDARIA'),
  col('CUOTA_SINDICAL', 'char', 1, many(() => pick(['S', 'N'])), 'SV_L3_AFILIACION_SINDICAL'),
  col('HUELLA_DACTILAR', 'varchar', 200, many(() => many(() => pick('ABCDEF0123456789'), 64).join('')), 'SV_L3_BIOMETRICO'),
  col('PRUEBA_ADN', 'varchar', 200, many(() => 'AGTC'.repeat(10)), 'SV_L3_GENETICO'),
  col('ORIENTACION_SEXUAL', 'varchar', 30, many(() => pick(['Heterosexual', 'Gay', 'Bisexual'])), 'SV_L3_ORIENTACION_SEXUAL'),
  col('VIDA_SEXUAL_ACTIVA', 'char', 1, many(() => pick(['S', 'N'])), 'SV_L3_VIDA_SEXUAL'),
  col('IDENTIDAD_GENERO', 'varchar', 30, many(() => pick(['Mujer trans', 'Hombre cisgénero'])), 'SV_L3_IDENTIDAD_GENERO'),
  col('SITUACION_FAMILIAR', 'varchar', 60, many(() => pick(['Vive con madre', 'Vive solo'])), 'SV_L3_SITUACION_FAMILIAR'),
  col('HABITOS_CONSUMO', 'varchar', 60, many(() => pick(['Compra en línea semanal', 'Consumo de tabaco'])), 'SV_L3_HABITOS'),
  col('VICTIMA_VIOLENCIA', 'char', 1, many(() => pick(['S', 'N'])), 'SV_L3_VICTIMA'),

  // SALUD
  col('NUMERO_EXPEDIENTE_CLINICO', 'varchar', 12, many(() => String(int(100000, 9999999))), 'SV_SALUD_IDENTIFICADOR'),
  col('COBERTURA_MEDICA', 'varchar', 30, many(() => pick(['ISSS', 'MINSAL', 'Bienestar Magisterial', 'Privado'])), 'SV_SALUD_COBERTURA'),
  col('DIAGNOSTICO', 'varchar', 6, many(() => pick(['E11.9', 'I10', 'J45.9', 'F32.1'])), 'SV_SALUD_DIAGNOSTICO'),
  col('CAUSA_DEFUNCION', 'varchar', 6, many(() => pick(['I219', 'C509', 'X954', 'J189'])), 'SV_SALUD_DIAGNOSTICO'),
  col('CODIGO_PROCEDIMIENTO', 'varchar', 6, many(() => String(int(10000, 999999))), 'SV_SALUD_PROCEDIMIENTO'),
  col('MEDICAMENTO', 'varchar', 40, many(() => pick(['Sertralina', 'Acetaminofén', 'Metformina'])), 'SV_SALUD_MEDICAMENTO'),
  col('EVOLUCION', 'clob', 4000, many(() => `Paciente refiere dolor abdominal de ${int(1, 9)} días de evolución.`), 'SV_SALUD_TEXTO_CLINICO'),
  col('RESULTADO_EXAMEN', 'varchar', 12, many(() => pick(['Normal', 'Alterado'])), 'SV_SALUD_RESULTADO_EXAMEN'),
  col('PRUEBA_VIH', 'varchar', 12, many(() => pick(['Reactivo', 'No reactivo'])), 'SV_SALUD_VIH'),
  col('GRUPO_SANGUINEO', 'varchar', 4, many(() => pick(['A+', 'O-', 'AB+', 'O+'])), 'SV_SALUD_GRUPO_SANGUINEO'),
  col('TIPO_DISCAPACIDAD', 'varchar', 40, many(() => pick(['Física o motora', 'Visual', 'Auditiva', 'Ninguna'])), 'SV_SALUD_DISCAPACIDAD'),
  col('APTITUD_LABORAL', 'varchar', 30, many(() => pick(['Apto', 'No apto'])), 'SV_SALUD_OCUPACIONAL'),
  col('EMBARAZADA', 'char', 1, many(() => pick(['S', 'N'])), 'SV_SALUD_REPRODUCTIVA'),
  col('TRASTORNO_MENTAL', 'varchar', 60, many(() => pick(['Depresión', 'Ansiedad'])), 'SV_SALUD_MENTAL'),

  // FIN
  col('HISTORIAL_CREDITICIO', 'varchar', 40, many(() => pick(['Al día', 'Mora de 30 días'])), 'SV_FIN_HISTORIAL_CREDITICIO'),
  col('SALDO_DEUDA', 'number', 10, many(() => String(int(100, 200000))), 'SV_FIN_DEUDA'),
  col('SALARIO', 'number', 8, many(() => String(int(365, 4000))), 'SV_FIN_INGRESOS'),
  col('VALOR_AVALUO', 'number', 10, many(() => String(int(5000, 400000))), 'SV_FIN_PATRIMONIO'),
  col('MONTO_PENSION', 'number', 8, many(() => String(int(304, 2000))), 'SV_FIN_PENSION'),
  col('MONTO_REMESA', 'number', 8, many(() => String(int(20, 1500))), 'SV_FIN_REMESAS'),
  col('BENEFICIARIO_SUBSIDIO', 'char', 1, many(() => pick(['S', 'N'])), 'SV_FIN_PROGRAMA_SOCIAL'),
  col('TENENCIA_VIVIENDA', 'varchar', 40, many(() => pick(['Propia', 'Alquilada', 'Cedida'])), 'SV_FIN_VIVIENDA'),

  // PENAL
  col('ANTECEDENTES_PENALES', 'varchar', 60, many(() => pick(['No registra antecedentes penales', 'Registra antecedentes'])), 'SV_PENAL_ANTECEDENTES'),
  col('NUMERO_EXPEDIENTE_JUDICIAL', 'varchar', 20, many(() => `${int(1, 9999)}-${pick(['UDVM', 'UDV', 'ULP'])}-${int(2015, 2026)}`), 'SV_PENAL_EXPEDIENTE'),

  // Not personal data: nothing should be assigned
  col('ID', 'integer', 10, many((i) => String(i + 1)), ''),
  col('RUTA_ARCHIVO', 'varchar', 200, many(() => `/datos/archivo${int(1, 99)}.txt`), ''),
  col('NOMBRE_PRODUCTO', 'varchar', 80, many(() => pick(['Frijol rojo 1 lb', 'Maíz blanco 5 lb', 'Café molido 500 g'])), ''),
  col('RAZON_SOCIAL', 'varchar', 80, many(() => `Distribuidora ${int(1, 99)} S.A. de C.V.`), ''),
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
  col('DEPARTAMENTO', 'varchar', 30, many(() => pick(['San Salvador', 'Santa Ana', 'La Libertad', 'San Miguel'])), ''),
  col('COD_BANCO', 'varchar', 4, many(() => pick(['0001', '0012', '0023'])), ''),
  col('URL_PAGINA', 'varchar', 200, many(() => `https://www.ejemplo.com.sv/p/${int(1, 999)}`), ''),
  col('TIPO_DOCUMENTO', 'varchar', 4, many(() => pick(['DUI', 'NIT', 'PAS', 'CR'])), ''),
  col('MONEDA', 'varchar', 3, many(() => pick(['USD', 'BTC'])), ''),
  col('CATEGORIA', 'varchar', 30, many(() => pick(['Granos básicos', 'Panadería'])), ''),
  col('CODIGO_CIIU', 'varchar', 4, many(() => pick(['4711', '6201', '8621'])), ''),
  col('IDIOMA', 'varchar', 5, many(() => pick(['es-SV', 'en', 'es'])), ''),
  col('VALOR_DEFECTO', 'varchar', 20, many(() => pick(['0', 'N/A', 'true'])), ''),
  col('ORDEN', 'number', 4, many(() => String(int(1, 99))), ''),
  col('CONDICION', 'varchar', 10, many(() => pick(['Nuevo', 'Usado'])), ''),
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
  const ALSO = {}
  const packPassed = profile(pack, (c) => (essential.has(c.expect) ? c.expect : (ALSO[c.name] ?? '')), 'essential pack, ')
  console.log(`profiled ${COLUMNS.length} columns with the essential pack (${pack.length} classifiers): ${packPassed} as expected`)
}

// ── Distritos, offline ──────────────────────────────────────────────────────
//
// Every distrito of under 20,000 inhabitants must become one of at least 20,000 of the same
// municipio — or of the same departamento when its municipio has none — written with its
// departamento and by its code; by its name alone, unless the name is shared with a large one.

const readTable = (name) => new Map(fs.readFileSync(nodePath.join(HERE, 'files', name), 'utf8').split('\n').filter(Boolean).map((l) => l.split('|')))

function verifyGeneralization() {
  const table = readTable('sv-distritos-generalizados.txt')
  const codes = readTable('sv-codigos-geograficos-generalizados.txt')
  const byCode = new Map(DISTRITOS.map((d) => [d.code, d]))
  const places = [...DISTRITOS, ...MUNICIPIOS]
  const key = (n) => fold(n).toLowerCase()
  const byName = new Map()
  for (const p of places) byName.set(key(p.name), [...(byName.get(key(p.name)) ?? []), p])
  const largeNames = new Set(DISTRITOS.filter((d) => d.population >= 20000).map((d) => d.name))
  let ok = 0
  let shared = 0
  let shown = 0
  for (const d of DISTRITOS) {
    const problems = []
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
      if (!target || target.population < 20000 || target.departmentCode !== d.departmentCode) problems.push(`code ${d.code} → ${code}`)
      // The nearest large distrito of the same municipio, when that municipio has one.
      const inMunicipality = DISTRITOS.some((x) => x.municipalityCode === d.municipalityCode && x.population >= 20000)
      if (target && inMunicipality && target.municipalityCode !== d.municipalityCode) problems.push(`code left its municipio: ${code}`)
    }
    if (problems.length) { failures++; if (shown++ < 15) console.log(`  ✗ ${d.name}/${d.department} (${d.population}): ${problems.join('; ')}`) }
    else ok++
  }
  console.log(`distritos: ${ok} of ${DISTRITOS.length} generalized as expected (${shared} small ones share a name)`)
}

// ── Algorithms ──────────────────────────────────────────────────────────────

const words = (s) => s.trim().split(/\s+/).length
const sameShape = (i, o) => i.length === o.length && i.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9') === o.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9')
const digitShape = (i, o) => i.length === o.length && i.replace(/\d/g, '9') === o.replace(/\d/g, '9')
const MASKING = {
  SV_L1_DUI: { inputs: ['04567890-1', '045678901', '0513-010180-238-7', 'A123456', ...many(dui, 10)], check: (i, o) => (i.replace(/\D/g, '').length === 9 ? validDui(o) && digitShape(i, o) : i.replace(/\D/g, '').length === 14 ? validNit(o) && digitShape(i, o) : sameShape(i, o)) },
  SV_L1_NIT: {
    inputs: ['0513-010180-238-7', '05130101802387', '0614-050589-018-3', '04567890-1', ...many(() => nit(), 10), ...many(() => nit(int(1, 100)), 10)],
    check: (i, o) => (i.replace(/\D/g, '').length === 9 ? validDui(o) && digitShape(i, o) : validNit(o) && digitShape(i, o)),
  },
  SV_L1_NRC: { inputs: ['123456-7'], check: digitShape },
  SV_L1_DOCUMENTO_EXTRANJERO: { inputs: ['R123456'], check: sameShape },
  SV_L1_PASAPORTE: { inputs: ['A1234567'], check: sameShape },
  SV_L1_PARTIDA: { inputs: ['123/1985'], check: sameShape },
  SV_L1_SEGURO_SOCIAL: { inputs: ['123456789'], check: digitShape },
  SV_L1_NIE: { inputs: ['1234567'], check: digitShape },
  SV_L1_MATRICULA_PROFESIONAL: { inputs: ['JVPM-12345'], check: sameShape },
  SV_L1_NOMBRE: { inputs: ['Morena', 'JOSÉ ALBERTO', 'María de los Ángeles'], check: (i, o) => words(i) === words(o) && (!/ de /.test(i) || / de /.test(o)) },
  SV_L1_APELLIDO: { inputs: ['Menjívar', 'PORTILLO HERNÁNDEZ', 'Menjívar de Portillo'], check: (i, o) => words(i) === words(o) && (!/ de /.test(i) || / de /.test(o)) },
  SV_L1_NOMBRE_COMPLETO: {
    inputs: ['Morena Menjívar', 'JOSÉ ALBERTO MENJÍVAR', 'José Alberto Menjívar Portillo', 'María Guadalupe Menjívar de Portillo', 'MENJÍVAR PORTILLO, JOSÉ ALBERTO'],
    check: (i, o) => words(i) === words(o) && [' de ', ' de los '].every((w) => i.includes(w) === o.includes(w)),
  },
  SV_L1_EMAIL: { inputs: ['morena.menjivar@gmail.com', 'josé.muñoz@empresa.com.sv'], check: (i, o) => /@[^@]+\.test$/.test(o) },
  SV_L1_TELEFONO: {
    inputs: ['+503 7123-4567', '71234567', '2222-3333', '6123 4567'],
    // The country code and the first digit — landline or mobile — stay, and the length does too.
    check: (i, o) => digitShape(i, o) && o.replace(/\D/g, '').slice(-8)[0] === i.replace(/\D/g, '').slice(-8)[0] && o !== i,
  },
  SV_L1_DIRECCION: { inputs: ['Calle Arce #123, Colonia Escalón', 'Km 12 Carretera a Santa Ana'] },
  SV_L1_DIRECCION_COMPLEMENTO: { inputs: ['Pol. 12 #5', 'Block B'] },
  SV_L1_CUENTA_BANCARIA: { inputs: ['0123-456789-012'], check: digitShape },
  SV_L1_TARJETA: { inputs: ['4162 0935 0038 1234'] },
  SV_L1_BILLETERA: { inputs: ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'morena@chivowallet.com'], check: sameShape },
  SV_L1_IP: { inputs: ['190.86.45.12', '2800:e2:f80::1'], check: (i, o) => (i.includes('.') ? o.split('.').every((p) => Number(p) >= 1 && Number(p) <= 254) : /^[0-9a-f:]+$/i.test(o)) },
  SV_L1_DISPOSITIVO: { inputs: ['3c:22:fb:9a:10:e4', '356938035643809'], check: (i, o) => (i.includes(':') ? /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(o) : /^\d{15}$/.test(o)) },
  SV_L1_COOKIE: { inputs: ['GA1.2.123456789.1700000000'], check: sameShape },
  SV_L1_PLACA: { inputs: ['P123-456', 'C 123 456', 'M12345A'], check: sameShape },
  SV_L1_VEHICULO: { inputs: ['9FBHS41A1YM123456'], check: sameShape },
  SV_L1_INMUEBLE: { inputs: ['12345678-00000'], check: sameShape },
  SV_L1_CONTRATO: { inputs: ['CT-123456'] },
  SV_L1_USUARIO: { inputs: ['@morena_menjivar'] },
  SV_L1_CREDENCIAL: { inputs: ['Clave#2024'], check: (i, o) => /^X+$/.test(o) },
  SV_L1_GEOLOCALIZACION: { inputs: ['13.698935', '13.698935,-89.191439'], check: (i, o) => o.slice(0, 4) === i.slice(0, 4) },
  SV_L1_TEXTO_LIBRE: {
    inputs: ['Cliente Menjívar, DUI 04567890-1, correo m.menjivar@gmail.com, cel 7123-4567.'],
    check: (i, o) => !/04567890-1|m\.menjivar@gmail\.com|7123-4567|Menjívar/.test(o),
  },
  SV_L2_FECHA_NACIMIENTO: { inputs: ['1985-07-20', '2012-01-15'], check: (i, o) => Math.abs(new Date(o.slice(0, 10)) - new Date(i)) <= 60 * 864e5 },
  SV_L2_ANIO_NACIMIENTO: { inputs: ['1985'], check: (i, o) => o.startsWith('198'), same: true },
  SV_L2_EDAD: { inputs: ['37', '7', '104'], check: (i, o) => (i === '104' ? o === '90' : i.length === 1 || o[0] === i[0]), same: true },
  SV_L2_FECHA_EVENTO: { inputs: ['2021-03-15'] },
  SV_L2_SEXO: { inputs: ['F', 'M', 'Femenino', 'masculino', 'Hombre', '1'], same: true },
  SV_L2_DISTRITO: { inputs: ['Apaneca', 'San Salvador', 'PERQUÍN', 'El Rosario - La Paz', 'Candelaria', 'Santa Ana'], same: true },
  SV_L2_CODIGO_GEOGRAFICO: { inputs: ['010102', '010101'], same: true },
  SV_L2_CODIGO_POSTAL: { inputs: ['1101'], check: (i, o) => o === '1100' },
  SV_L2_CANTON: { inputs: ['Cantón El Espino'] },
  SV_L2_COLONIA: { inputs: ['Colonia San Benito'], same: true },
  SV_L2_ESTADO_FAMILIAR: { inputs: ['Unión no matrimonial', '2'], same: true },
  SV_L2_OCUPACION: { inputs: ['Gerente de operaciones', '2221'] },
  SV_L2_EMPLEADOR: { inputs: ['Grupo Agrisal S.A. de C.V.'] },
  SV_L2_ESCOLARIDAD: { inputs: ['Educación media incompleta', '7'], same: true },
  SV_L2_CENTRO_EDUCATIVO: { inputs: ['Universidad de El Salvador'] },
  SV_L2_PERSONAS_A_CARGO: { inputs: ['9', '2'], check: (i, o) => Number(o) <= 5, same: true },
  SV_L3_ORIGEN_ETNICO: { inputs: ['Indígena', '3', 'N'], same: true },
  SV_L3_LENGUA_INDIGENA: { inputs: ['Náhuat pipil'], same: true },
  SV_L3_NACIONALIDAD: { inputs: ['Panameña'], same: true },
  SV_L3_RELIGION: { inputs: ['Ortodoxa', 'N'], same: true },
  SV_L3_CONVICCION_FILOSOFICA: { inputs: ['Se niega a transfusiones'] },
  SV_L3_IDEOLOGIA_POLITICA: { inputs: ['Oficialista'], same: true },
  SV_L3_AFILIACION_PARTIDARIA: { inputs: ['Cambio Democrático', 'S'], same: true },
  SV_L3_AFILIACION_SINDICAL: { inputs: ['SIMETRISSS', 'S'], same: true },
  SV_L3_BIOMETRICO: { inputs: ['A1B2C3D4E5F6'] },
  SV_L3_GENETICO: { inputs: ['BRCA1 positivo'] },
  SV_L3_ORIENTACION_SEXUAL: { inputs: ['Homosexual'], same: true },
  SV_L3_VIDA_SEXUAL: { inputs: ['Activa'] },
  SV_L3_IDENTIDAD_GENERO: { inputs: ['Transgénero'], same: true },
  SV_L3_SITUACION_FAMILIAR: { inputs: ['Vive con su madre y dos hermanos'] },
  SV_L3_HABITOS: { inputs: ['Compra en línea cada semana'] },
  SV_L3_VICTIMA: { inputs: ['Violencia intrafamiliar', 'S'], same: true },
  SV_SALUD_IDENTIFICADOR: { inputs: ['EXP-2024-00123'] },
  SV_SALUD_COBERTURA: { inputs: ['ISSS', '12345'], same: true },
  SV_SALUD_DIAGNOSTICO: { inputs: ['F33.1', 'B24X', 'E119', 'Depresión mayor'], same: true },
  SV_SALUD_PROCEDIMIENTO: { inputs: ['901234', 'Prueba de carga viral para VIH'], same: true },
  SV_SALUD_MEDICAMENTO: { inputs: ['Sertralina 50 mg'] },
  SV_SALUD_TEXTO_CLINICO: { inputs: ['Paciente Menjívar, DUI 04567890-1, consulta por cefalea.'], check: (i, o) => !o.includes('04567890-1') },
  SV_SALUD_RESULTADO_EXAMEN: { inputs: ['Reactivo'] },
  SV_SALUD_VIH: { inputs: ['Reactivo', 'S'], same: true },
  SV_SALUD_GRUPO_SANGUINEO: { inputs: ['O+'], same: true },
  SV_SALUD_DISCAPACIDAD: { inputs: ['Trastorno del espectro autista', 'N'], same: true },
  SV_SALUD_OCUPACIONAL: { inputs: ['No apto temporalmente', 'S'], same: true },
  SV_SALUD_REPRODUCTIVA: { inputs: ['12 semanas de gestación', 'S'], same: true },
  SV_SALUD_MENTAL: { inputs: ['Trastorno bipolar'] },
  SV_FIN_HISTORIAL_CREDITICIO: { inputs: ['Reportado en el buró de crédito', '745', 'N'], same: true },
  SV_FIN_DEUDA: { inputs: ['5400'] },
  SV_FIN_INGRESOS: { inputs: ['612'] },
  SV_FIN_PATRIMONIO: { inputs: ['48000'] },
  SV_FIN_PENSION: { inputs: ['425'] },
  SV_FIN_REMESAS: { inputs: ['250'] },
  SV_FIN_PROGRAMA_SOCIAL: { inputs: ['Comunidades Solidarias', 'S'], same: true },
  SV_FIN_VIVIENDA: { inputs: ['Ocupación de hecho'], same: true },
  SV_PENAL_ANTECEDENTES: { inputs: ['Condenado por hurto en 2019', 'S'], same: true },
  SV_PENAL_EXPEDIENTE: {
    inputs: ['123-UDVM-2024', '1234/2023', 'PN-456-2022'],
    check: (i, o) => digitShape(i, o) && o.replace(/\d/g, '') === i.replace(/\d/g, '') && o.slice(-4) === i.slice(-4),
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
  SV_L1_NOMBRE: (i, o) => o.split(/\s+/).every((w) => PARTICLE.test(w) || has('sv-nombres.txt', w)),
  SV_L1_APELLIDO: (i, o) => o.split(/\s+/).every((w) => PARTICLE.test(w) || has('sv-apellidos.txt', w)),
  SV_L1_NOMBRE_COMPLETO: (i, o) => i.includes(',') || (has('sv-nombres.txt', o.split(/\s+/)[0]) && has('sv-apellidos.txt', o.split(/\s+/).at(-1))),
  SV_L1_DIRECCION: (i, o) => has('sv-direcciones.txt', o),
  SV_L2_SEXO: (i, o) => ({ f: ['f', 'm'], m: ['f', 'm'], femenino: ['femenino', 'masculino'], masculino: ['femenino', 'masculino'], hombre: ['mujer', 'hombre'], 1: ['1', '2'] })[i.toLowerCase()].includes(o.toLowerCase()),
  // Apaneca and Perquín become large distritos; San Salvador and Santa Ana stay; El Rosario is
  // shared by three small distritos and follows the most populous; Candelaria the same.
  SV_L2_DISTRITO: (i, o) => ({ 'San Salvador': o === 'San Salvador', 'Santa Ana': o === 'Santa Ana', 'El Rosario - La Paz': / - La Paz$/.test(o) && LARGE.has(o.replace(/ - La Paz$/, '').toLowerCase()) })[i] ?? LARGE.has(o.toLowerCase()),
  SV_L2_CODIGO_GEOGRAFICO: (i, o) => (i === '010101' ? o === i : o.length === i.length && o.slice(0, 2) === i.slice(0, 2) && o !== i),
  SV_L2_COLONIA: (i, o) => has('sv-colonias.txt', o),
  SV_L2_CANTON: (i, o) => o === 'Zona rural',
  SV_L3_NACIONALIDAD: (i, o) => has('sv-nacionalidades.txt', o),
  SV_L2_ESTADO_FAMILIAR: (i, o) => (/^\d$/.test(i) ? /^[1-6]$/.test(o) : has('sv-estado-familiar.txt', o)),
  SV_L2_OCUPACION: (i, o) => (/^\d+$/.test(i) ? /^\d{4}$/.test(o) : has('sv-ocupaciones.txt', o)),
  SV_L2_EMPLEADOR: (i, o) => has('sv-empleadores.txt', o),
  SV_L2_ESCOLARIDAD: (i, o) => (/^\d+$/.test(i) ? has('sv-escolaridad-codigos.txt', o) : has('sv-escolaridad.txt', o)),
  SV_L2_CENTRO_EDUCATIVO: (i, o) => has('sv-centros-educativos.txt', o),
  SV_L3_ORIGEN_ETNICO: (i, o) => flag(i, o) ?? (/^\d$/.test(i) ? has('sv-origen-etnico-codigos.txt', o) : has('sv-origen-etnico.txt', o)),
  SV_L3_LENGUA_INDIGENA: (i, o) => has('sv-lenguas.txt', o),
  SV_L3_RELIGION: (i, o) => flag(i, o) ?? has('sv-religiones.txt', o),
  SV_L3_CONVICCION_FILOSOFICA: (i, o) => o === SUPPRESSED,
  SV_L3_IDEOLOGIA_POLITICA: (i, o) => has('sv-ideologias-politicas.txt', o),
  SV_L3_AFILIACION_PARTIDARIA: (i, o) => flag(i, o) ?? has('sv-partidos.txt', o),
  SV_L3_AFILIACION_SINDICAL: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  SV_L3_ORIENTACION_SEXUAL: (i, o) => has('sv-orientaciones-sexuales.txt', o),
  SV_L3_VIDA_SEXUAL: (i, o) => o === SUPPRESSED,
  SV_L3_IDENTIDAD_GENERO: (i, o) => has('sv-identidades-genero.txt', o),
  SV_L3_SITUACION_FAMILIAR: (i, o) => o === SUPPRESSED,
  SV_L3_HABITOS: (i, o) => o === SUPPRESSED,
  SV_L3_VICTIMA: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  SV_SALUD_COBERTURA: (i, o) => (/^\d+$/.test(i) ? digitShape(i, o) : has('sv-cobertura-salud.txt', o)),
  SV_SALUD_DIAGNOSTICO: (i, o) => (/\.\d/.test(i) ? has('sv-cie10-decimal.txt', o) : /^[A-Z]\d{2,3}X?$/i.test(i) ? has('sv-cie10.txt', o) : has('sv-diagnosticos.txt', o)),
  SV_SALUD_PROCEDIMIENTO: (i, o) => (/^\d+$/.test(i) ? digitShape(i, o) : has('sv-procedimientos.txt', o)),
  SV_SALUD_MEDICAMENTO: (i, o) => has('sv-medicamentos.txt', o),
  SV_SALUD_VIH: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  SV_SALUD_GRUPO_SANGUINEO: (i, o) => has('sv-grupos-sanguineos.txt', o),
  SV_SALUD_DISCAPACIDAD: (i, o) => flag(i, o) ?? has('sv-discapacidades.txt', o),
  SV_SALUD_OCUPACIONAL: (i, o) => flag(i, o) ?? has('sv-aptitud-laboral.txt', o),
  SV_SALUD_REPRODUCTIVA: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  SV_SALUD_MENTAL: (i, o) => o === SUPPRESSED,
  SV_FIN_HISTORIAL_CREDITICIO: (i, o) => flag(i, o) ?? (/^\d+$/.test(i) ? digitShape(i, o) : has('sv-estados-credito.txt', o)),
  SV_FIN_PROGRAMA_SOCIAL: (i, o) => flag(i, o) ?? has('sv-programas-sociales.txt', o),
  SV_FIN_VIVIENDA: (i, o) => has('sv-tenencia-vivienda.txt', o),
  SV_PENAL_ANTECEDENTES: (i, o) => flag(i, o) ?? has('sv-antecedentes.txt', o),
}

async function mask(framework, config, input, additionalAlgorithms) {
  const res = await fetch(`${API}/api/mask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ framework, config, input, additionalAlgorithms }),
  })
  return res.json()
}

async function verifyAlgorithms() {
  const byName = new Map(preset.algorithms.map((a) => [a.name, a]))
  // Each test sends only what the algorithm reaches, as the tester does.
  const reach = (name, seen = new Set()) => {
    if (seen.has(name) || !byName.has(name)) return seen
    seen.add(name)
    for (const [, ref] of JSON.stringify(byName.get(name).config).matchAll(/"name":"([^"]+)"/g)) reach(ref, seen)
    return seen
  }
  const closure = new Map()
  const additionalFor = (name) => {
    if (!closure.has(name)) closure.set(name, [...reach(name)].map((n) => byName.get(n)).map((a) => ({ name: a.name, className: a.framework, config: resolve(a.config) })))
    return closure.get(name)
  }
  const missing = preset.domains.map((d) => d.name).filter((d) => !MASKING[d])
  if (missing.length) { failures++; console.log(`  ✗ domains with no masking test: ${missing.join(', ')}`) }
  const run = (algorithmName, input) => { const algo = byName.get(algorithmName); return mask(algo.framework, resolve(algo.config), input, additionalFor(algorithmName)).catch((err) => ({ error: err.message })) }

  const jobs = preset.domains.flatMap((d) => (MASKING[d.name]?.inputs ?? []).map((input) => ({ domain: d, input })))
  for (const a of preset.algorithms) {
    if (a.input === undefined) { failures++; console.log(`  ✗ ${a.name} has no sample input`) }
    else jobs.push({ domain: { name: a.name, algorithm: a.name }, input: a.input, sample: true })
  }
  const TYPED = new Set(['SV_L2_FECHA_NACIMIENTO', 'SV_L2_FECHA_EVENTO', 'SV_FIN_DEUDA', 'SV_FIN_INGRESOS', 'SV_FIN_PATRIMONIO', 'SV_FIN_PENSION', 'SV_FIN_REMESAS'])
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

  // DUIs stay DUIs: 150 distinct inputs give 150 distinct valid outputs.
  const duis = [...new Set(many(dui, 150))]
  const duiOut = new Set()
  let duiBad = 0
  let i = 0
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < duis.length) {
      const { output } = await run('SV_DUI', duis[i++])
      duiOut.add(output)
      if (!output || !validDui(output)) duiBad++
    }
  }))
  if (duiOut.size !== duis.length || duiBad) { failures++; console.log(`  ✗ DUI: ${duis.length} inputs gave ${duiOut.size} distinct outputs, ${duiBad} invalid`) }
  else console.log(`DUI: ${duis.length} distinct inputs, ${duiOut.size} distinct valid outputs`)

  // NITs of both rules: the correlative decides, and the masked NIT must keep its class.
  const nits = [...new Set([...many(() => nit(int(1, 100)), 100), ...many(() => nit(int(101, 999)), 100)])]
  const nitOut = new Set()
  let nitBad = 0
  let oldOnes = 0
  let newOnes = 0
  let j = 0
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (j < nits.length) {
      const input = nits[j++]
      const { output } = await run('SV_NIT', input)
      nitOut.add(output)
      if (!output || !validNit(output)) nitBad++
      else if (Number(input.replace(/\D/g, '').slice(10, 13)) <= 100) oldOnes++
      else newOnes++
    }
  }))
  if (nitOut.size !== nits.length || nitBad || !oldOnes || !newOnes) { failures++; console.log(`  ✗ NIT: ${nits.length} inputs gave ${nitOut.size} distinct outputs, ${nitBad} invalid (${oldOnes} old rule, ${newOnes} new rule)`) }
  else console.log(`NIT: ${nits.length} distinct inputs, ${nitOut.size} distinct valid outputs (${oldOnes} of the old rule, ${newOnes} of the new one)`)

  // The birth date inside a NIT must not survive.
  let kept = 0
  for (const input of many(() => nit(), 20)) {
    const { output } = await run('SV_NIT', input)
    if (output && output.replace(/\D/g, '').slice(4, 10) === input.replace(/\D/g, '').slice(4, 10)) kept++
  }
  if (kept > 2) { failures++; console.log(`  ✗ NIT: the birth date survived in ${kept} of 20`) }
  else console.log(`NIT: the birth date block changed in ${20 - kept} of 20`)
}

if (only !== 'algorithms') { verifyClassifiers(); verifyGeneralization() }
if (only !== 'classifiers') await verifyAlgorithms()
console.log(failures ? `\n${failures} problem(s)` : '\nall good')
process.exit(failures ? 1 : 0)
