#!/usr/bin/env node
/**
 * Checks the Colombia (Ley 1581 de 2012) preset.
 *
 *   node presets/colombia-ley-1581/verify.mjs               # classifiers, then algorithms
 *   node presets/colombia-ley-1581/verify.mjs classifiers   # only the local profiling check
 *   node presets/colombia-ley-1581/verify.mjs algorithms    # only masking, against the app
 *
 * Classifiers run through classifiers/, the same evaluator the classifier test uses: every
 * configuration is reviewed, then a battery of columns — well named, badly named and unrelated —
 * is profiled with the whole set at its threshold. The table that generalizes municipalities is
 * audited offline. Algorithms run in the app (DLPX_URL, default http://localhost:3000), which needs
 * the Delphix jars in lib/; every NIT they write is checked against the DIAN check-digit rule.
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

// ── Check digit ─────────────────────────────────────────────────────────────

const NIT_WEIGHTS = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71]
const nitDigit = (body) => {
  const r = [...body].reverse().reduce((s, d, i) => s + Number(d) * NIT_WEIGHTS[i], 0) % 11
  return r >= 2 ? 11 - r : r
}
const nitRemainder = (body) => [...body].reverse().reduce((s, d, i) => s + Number(d) * NIT_WEIGHTS[i], 0) % 11
const validNit = (v) => {
  const m = v.replace(/[.\s]/g, '').match(/^(\d+)-?(\d)$/)
  return !!m && String(nitDigit(m[1])) === m[2]
}

// ── Test data ───────────────────────────────────────────────────────────────

let seed = 1581
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
const MUNICIPALITIES = source('municipios.tsv').map((l) => { const [code, name, departmentCode, department, , , population, aliases] = l.split('\t'); return { code, name, departmentCode, department, population: Number(population), aliases: aliases ? aliases.split('|') : [] } })
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '')
const PERSONAL = new Set([...GIVEN, ...SURNAMES].map((w) => fold(w).toLowerCase()))
const LARGE_NAMES = MUNICIPALITIES.filter((m) => m.population >= 20000).map((m) => m.name)
const SMALL_NAMES = MUNICIPALITIES.filter((m) => m.population < 20000 && !PERSONAL.has(fold(m.name).toLowerCase())).map((m) => m.name)

const pad = (n, w) => String(n).padStart(w, '0')
const digits = (n) => many(() => int(0, 9), n).join('')
const dots = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
const cedula = () => pick([String(int(1000000, 99999999)), `1${digits(9)}`])
const nit = () => { const b = pick([`${pick([8, 9])}${digits(8)}`, cedula()]); return `${b}-${nitDigit(b)}` }
const luhn = (prefix, length) => {
  const ds = [...prefix].map(Number)
  while (ds.length < length - 1) ds.push(int(0, 9))
  const sum = ds.slice().reverse().reduce((s, d, i) => s + (i % 2 === 0 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0)
  return ds.join('') + String((10 - (sum % 10)) % 10)
}
const iso = (y0, y1) => `${int(y0, y1)}-${pad(int(1, 12), 2)}-${pad(int(1, 28), 2)}`
const fullName = () => `${pick(GIVEN)}${random() < 0.4 ? ` ${pick(GIVEN)}` : ''} ${pick(SURNAMES)} ${pick(SURNAMES)}`
const mobile = () => pick([`3${int(0, 2)}${int(0, 9)} ${int(100, 999)} ${int(1000, 9999)}`, `3${int(10, 29)}${int(1000000, 9999999)}`, `+57 3${int(10, 29)} ${int(100, 999)} ${int(1000, 9999)}`])
const landline = () => `60${int(1, 8)} ${int(200, 899)} ${int(1000, 9999)}`
const address = () => `${pick(['Calle', 'Carrera', 'Cra.', 'Cl', 'Diagonal', 'Transversal', 'Av. Calle'])} ${int(1, 150)}${pick(['', 'A', 'B', ' Bis', ' Sur'])} # ${int(1, 120)}-${int(1, 99)}${pick(['', ' Apto 301', ' Torre 2 Apto 504'])}`
const plate = () => pick([`${many(() => pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 3).join('')}${int(100, 999)}`, `${many(() => pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 3).join('')}${int(10, 99)}${pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ')}`])
const radicado = () => `11001${pick(['31', '40', '60'])}${pick(['03', '05', '09'])}${pad(int(1, 50), 3)}${int(2015, 2025)}${pad(int(1, 99999), 5)}00`

// ── Classifiers ─────────────────────────────────────────────────────────────

const SQL = { varchar: 12, char: 1, number: 2, integer: 4, date: 91, timestamp: 93, clob: 2005 }
const col = (name, type, length, values, expect) => ({ name, sqlType: SQL[type], length, values, expect })

const COLUMNS = [
  // L1 — well named
  col('NUMERO_DOCUMENTO', 'varchar', 15, many(() => dots(cedula())), 'CO_L1_CEDULA'),
  col('CEDULA', 'number', 10, many(cedula), 'CO_L1_CEDULA'),
  col('CC_CLIENTE', 'varchar', 12, many(cedula), 'CO_L1_CEDULA'),
  col('TARJETA_IDENTIDAD', 'varchar', 11, many(() => `1${digits(9)}`), 'CO_L1_CEDULA'),
  col('NIT', 'varchar', 13, many(nit), 'CO_L1_NIT'),
  col('NIT_PROVEEDOR', 'varchar', 15, many(() => { const b = `${pick([8, 9])}${digits(8)}`; return `${dots(b)}-${nitDigit(b)}` }), 'CO_L1_NIT'),
  col('NUMERO_PPT', 'varchar', 10, many(() => String(int(1000000, 9999999))), 'CO_L1_DOCUMENTO_EXTRANJERO'),
  col('PASAPORTE', 'varchar', 10, many(() => `A${pick('BCDEFGHJKLMNPRSTUVWXYZ')}${int(100000, 999999)}`), 'CO_L1_PASAPORTE'),
  col('INDICATIVO_SERIAL', 'varchar', 10, many(() => String(int(10000000, 99999999))), 'CO_L1_REGISTRO_CIVIL'),
  col('TARJETA_PROFESIONAL', 'varchar', 12, many(() => `${int(10000, 999999)}-${pick(['T', 'D', 'CUN'])}`), 'CO_L1_TARJETA_PROFESIONAL'),
  col('PRIMER_NOMBRE', 'varchar', 30, many(() => pick(GIVEN)), 'CO_L1_NOMBRE'),
  col('PRIMER_APELLIDO', 'varchar', 30, many(() => pick(SURNAMES)), 'CO_L1_APELLIDO'),
  col('APELLIDOS', 'varchar', 60, many(() => `${pick(SURNAMES)} ${pick(SURNAMES)}`), 'CO_L1_APELLIDO'),
  col('NOMBRE_COMPLETO', 'varchar', 120, many(fullName), 'CO_L1_NOMBRE_COMPLETO'),
  col('NOMBRE_CLIENTE', 'varchar', 120, many(fullName), 'CO_L1_NOMBRE_COMPLETO'),
  col('NOMBRE', 'varchar', 120, many(fullName), 'CO_L1_NOMBRE_COMPLETO'),
  col('NOMBRE_ACUDIENTE', 'varchar', 120, many(fullName), 'CO_L1_NOMBRE_COMPLETO'),
  col('CORREO_ELECTRONICO', 'varchar', 100, many(() => `${fold(pick(GIVEN)).toLowerCase()}.${int(1, 999)}@gmail.com`), 'CO_L1_EMAIL'),
  col('EMAIL', 'varchar', 100, many(() => `contacto${int(1, 999)}@empresa.com.co`), 'CO_L1_EMAIL'),
  col('CELULAR', 'varchar', 20, many(mobile), 'CO_L1_TELEFONO'),
  col('TELEFONO_FIJO', 'varchar', 14, many(landline), 'CO_L1_TELEFONO'),
  col('DIRECCION_RESIDENCIA', 'varchar', 120, many(address), 'CO_L1_DIRECCION'),
  col('DIRECCION', 'varchar', 120, many(address), 'CO_L1_DIRECCION'),
  col('COMPLEMENTO', 'varchar', 30, many(() => `Apto ${int(101, 1204)}`), 'CO_L1_DIRECCION_COMPLEMENTO'),
  col('NUMERO_CUENTA', 'varchar', 14, many(() => digits(11)), 'CO_L1_CUENTA_BANCARIA'),
  col('NUMERO_TARJETA', 'varchar', 19, many(() => luhn('4', 16)), 'CO_L1_TARJETA'),
  col('LLAVE_BREB', 'varchar', 60, many(() => pick([`@${fold(pick(GIVEN)).toLowerCase()}${int(1, 999)}`, `3${int(10, 29)}${int(1000000, 9999999)}`, `${fold(pick(GIVEN)).toLowerCase()}@gmail.com`])), 'CO_L1_LLAVE_BREB'),
  col('IP_ORIGEN', 'varchar', 15, many(() => `${int(1, 223)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`), 'CO_L1_IP'),
  col('MAC_ADDRESS', 'varchar', 17, many(() => many(() => int(0, 255).toString(16).padStart(2, '0'), 6).join(':')), 'CO_L1_DISPOSITIVO'),
  col('IMEI', 'varchar', 15, many(() => luhn('35', 15)), 'CO_L1_DISPOSITIVO'),
  col('PLACA', 'varchar', 7, many(plate), 'CO_L1_PLACA'),
  col('NUMERO_CHASIS', 'varchar', 17, many(() => many(() => pick('ABCDEFGHJKLMNPRSTUVWXYZ0123456789'), 17).join('')), 'CO_L1_VEHICULO'),
  col('FOLIO_MATRICULA', 'varchar', 15, many(() => `${pick(['50C', '50N', '001', '370'])}-${int(10000, 9999999)}`), 'CO_L1_INMUEBLE'),
  col('NUMERO_CONTRATO', 'varchar', 12, many(() => `CT-${int(100000, 999999)}`), 'CO_L1_CONTRATO'),
  col('USUARIO', 'varchar', 30, many(() => `${fold(pick(GIVEN)).toLowerCase()}${int(1, 99)}`), 'CO_L1_USUARIO'),
  col('CONTRASENA', 'varchar', 60, many(() => `$2a$10$${many(() => pick('abcdefghijklmnopqrstuvwxyz0123456789'), 53).join('')}`), 'CO_L1_CREDENCIAL'),
  col('LATITUD', 'varchar', 12, many(() => `4.${int(100000, 999999)}`), 'CO_L1_GEOLOCALIZACION'),
  col('OBSERVACIONES', 'clob', 4000, many(() => `Cliente solicita actualizar datos. CC ${dots(cedula())}, correo ${fold(pick(GIVEN)).toLowerCase()}@gmail.com.`), 'CO_L1_TEXTO_LIBRE'),

  // L1 — badly named: only the values can tell
  col('CAMPO1', 'varchar', 15, many(() => dots(cedula())), 'CO_L1_CEDULA'),
  col('CAMPO2', 'varchar', 30, many(() => pick(GIVEN)), 'CO_L1_NOMBRE'),
  col('CAMPO3', 'varchar', 30, many(() => pick(SURNAMES)), 'CO_L1_APELLIDO'),
  col('CAMPO4', 'varchar', 120, many(fullName), 'CO_L1_NOMBRE_COMPLETO'),
  col('CAMPO5', 'varchar', 100, many(() => `${fold(pick(GIVEN)).toLowerCase()}@hotmail.com`), 'CO_L1_EMAIL'),
  col('CAMPO6', 'varchar', 16, many(() => `3${int(10, 29)} ${int(100, 999)} ${int(1000, 9999)}`), 'CO_L1_TELEFONO'),
  col('CAMPO7', 'varchar', 120, many(address), 'CO_L1_DIRECCION'),
  col('CAMPO8', 'varchar', 19, many(() => luhn('5', 16)), 'CO_L1_TARJETA'),
  col('CAMPO9', 'varchar', 15, many(() => `192.168.${int(0, 255)}.${int(1, 254)}`), 'CO_L1_IP'),
  col('CAMPO10', 'varchar', 7, many(plate), 'CO_L1_PLACA'),
  col('CAMPO11', 'varchar', 15, many(() => { const b = `${pick([8, 9])}${digits(8)}`; return `${dots(b)}-${nitDigit(b)}` }), 'CO_L1_NIT'),
  col('TXT', 'clob', 4000, many(() => `Paciente ${pick(GIVEN)} ${pick(SURNAMES)}, CC ${dots(cedula())}, cel 3${int(10, 29)}${int(1000000, 9999999)}.`), 'CO_L1_TEXTO_LIBRE'),

  // L2
  col('FECHA_NACIMIENTO', 'date', 0, many(() => iso(1940, 2010)), 'CO_L2_FECHA_NACIMIENTO'),
  col('FEC_NAC', 'varchar', 10, many(() => iso(1940, 2010)), 'CO_L2_FECHA_NACIMIENTO'),
  col('fechaNacimiento', 'timestamp', 0, many(() => iso(1940, 2010)), 'CO_L2_FECHA_NACIMIENTO'),
  col('ANIO_NACIMIENTO', 'number', 4, many(() => String(int(1940, 2010))), 'CO_L2_ANIO_NACIMIENTO'),
  col('EDAD', 'number', 3, many(() => String(int(0, 99))), 'CO_L2_EDAD'),
  col('FECHA_DEFUNCION', 'date', 0, many(() => iso(2000, 2025)), 'CO_L2_FECHA_EVENTO'),
  col('FECHA_EXPEDICION_DOCUMENTO', 'date', 0, many(() => iso(1990, 2025)), 'CO_L2_FECHA_EVENTO'),
  col('SEXO', 'char', 1, many(() => pick(['F', 'M'])), 'CO_L2_SEXO'),
  col('GENERO', 'varchar', 10, many(() => pick(['Femenino', 'Masculino'])), 'CO_L2_SEXO'),
  col('MUNICIPIO', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'CO_L2_MUNICIPIO'),
  col('CIUDAD', 'varchar', 60, many(() => pick(['Bogotá, D.C.', 'Medellín', 'Cali', 'Barranquilla', 'Bucaramanga', 'Pereira'])), 'CO_L2_MUNICIPIO'),
  col('LUGAR_NACIMIENTO', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'CO_L2_MUNICIPIO'),
  col('CAMPO12', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'CO_L2_MUNICIPIO'),
  col('COD_MUNICIPIO', 'varchar', 5, many(() => pick(MUNICIPALITIES).code), 'CO_L2_CODIGO_MUNICIPIO'),
  col('CODIGO_POSTAL', 'varchar', 6, many(() => `${pick(['11', '05', '76', '08'])}${digits(4)}`), 'CO_L2_CODIGO_POSTAL'),
  col('BARRIO', 'varchar', 40, many(() => pick(['Chapinero', 'Laureles', 'El Poblado', 'Granada'])), 'CO_L2_BARRIO'),
  col('VEREDA', 'varchar', 40, many(() => `Vereda ${pick(['La Esperanza', 'El Salitre', 'Santa Rosa'])}`), 'CO_L2_VEREDA'),
  col('NACIONALIDAD', 'varchar', 20, many(() => pick(['Colombiana', 'Venezolana', 'Ecuatoriana', 'Peruana'])), 'CO_L2_NACIONALIDAD'),
  col('ESTADO_CIVIL', 'varchar', 30, many(() => pick(['Soltero', 'Casado', 'Unión libre', 'Viudo'])), 'CO_L2_ESTADO_CIVIL'),
  col('PROFESION', 'varchar', 60, many(() => pick(['Docente', 'Conductor', 'Enfermera'])), 'CO_L2_OCUPACION'),
  col('NOMBRE_EMPLEADOR', 'varchar', 80, many(() => `Comercializadora ${int(1, 99)} S.A.S.`), 'CO_L2_EMPLEADOR'),
  col('NIVEL_EDUCATIVO', 'varchar', 40, many(() => pick(['Bachiller', 'Universitario', 'Básica primaria'])), 'CO_L2_ESCOLARIDAD'),
  col('NOMBRE_COLEGIO', 'varchar', 80, many(() => pick(['Colegio San Bartolomé', 'Institución Educativa La Salle'])), 'CO_L2_INSTITUCION_EDUCATIVA'),
  col('PERSONAS_A_CARGO', 'number', 2, many(() => String(int(0, 8))), 'CO_L2_PERSONAS_A_CARGO'),

  // L3
  col('PERTENENCIA_ETNICA', 'varchar', 60, many(() => pick(['Indígena', 'Afrocolombiano', 'Ninguno', 'Raizal'])), 'CO_L3_GRUPO_ETNICO'),
  col('COD_ETNIA', 'char', 1, many(() => pick(['1', '2', '3', '4', '5', '6'])), 'CO_L3_GRUPO_ETNICO'),
  col('CAMPO13', 'varchar', 60, many(() => pick(['Indígena', 'Afrocolombiano', 'Raizal', 'Palenquero', 'Negro', 'Ningún grupo étnico'])), 'CO_L3_GRUPO_ETNICO'),
  col('PUEBLO_INDIGENA', 'varchar', 30, many(() => pick(['Wayuu', 'Zenú', 'Nasa', 'Pastos'])), 'CO_L3_PUEBLO_INDIGENA'),
  col('LENGUA_NATIVA', 'varchar', 30, many(() => pick(['Wayuunaiki', 'Nasa Yuwe', 'Español'])), 'CO_L3_LENGUA_NATIVA'),
  col('RELIGION', 'varchar', 40, many(() => pick(['Católica', 'Cristiana', 'Ninguna'])), 'CO_L3_RELIGION'),
  col('OBJECION_CONCIENCIA', 'varchar', 60, many(() => pick(['Servicio militar', 'Ninguna'])), 'CO_L3_CONVICCION_FILOSOFICA'),
  col('INTENCION_VOTO', 'varchar', 40, many(() => pick(['Izquierda', 'Derecha', 'Centro'])), 'CO_L3_ORIENTACION_POLITICA'),
  col('PARTIDO_POLITICO', 'varchar', 60, many(() => pick(['Partido Liberal', 'Centro Democrático', 'Pacto Histórico', 'Alianza Verde'])), 'CO_L3_AFILIACION_PARTIDO'),
  col('SINDICALIZADO', 'char', 1, many(() => pick(['S', 'N'])), 'CO_L3_SINDICATO'),
  col('LIDER_SOCIAL', 'char', 1, many(() => pick(['S', 'N'])), 'CO_L3_ORGANIZACION_SOCIAL'),
  col('HUELLA_DACTILAR', 'varchar', 200, many(() => many(() => pick('ABCDEF0123456789'), 64).join('')), 'CO_L3_BIOMETRICO'),
  col('PRUEBA_ADN', 'varchar', 200, many(() => 'AGTC'.repeat(10)), 'CO_L3_GENETICO'),
  col('ORIENTACION_SEXUAL', 'varchar', 30, many(() => pick(['Heterosexual', 'Gay', 'Bisexual'])), 'CO_L3_ORIENTACION_SEXUAL'),
  col('VIDA_SEXUAL_ACTIVA', 'char', 1, many(() => pick(['S', 'N'])), 'CO_L3_VIDA_SEXUAL'),
  col('IDENTIDAD_GENERO', 'varchar', 30, many(() => pick(['Mujer trans', 'Hombre cisgénero', 'Persona no binaria'])), 'CO_L3_IDENTIDAD_GENERO'),
  col('HECHO_VICTIMIZANTE', 'varchar', 60, many(() => pick(['Desplazamiento forzado', 'Homicidio', 'Amenaza'])), 'CO_L3_VICTIMA_CONFLICTO'),
  col('VICTIMA_CONFLICTO', 'char', 1, many(() => pick(['S', 'N'])), 'CO_L3_VICTIMA_CONFLICTO'),
  col('REINCORPORADO', 'char', 1, many(() => pick(['S', 'N'])), 'CO_L3_REINCORPORACION'),

  // SALUD
  col('NUMERO_HISTORIA_CLINICA', 'varchar', 12, many(() => String(int(100000, 9999999))), 'CO_SALUD_IDENTIFICADOR'),
  col('REGIMEN', 'varchar', 20, many(() => pick(['Contributivo', 'Subsidiado'])), 'CO_SALUD_AFILIACION'),
  col('EPS', 'varchar', 30, many(() => pick(['Nueva EPS', 'EPS Sura', 'Sanitas', 'Salud Total EPS'])), 'CO_SALUD_AFILIACION'),
  col('DX_PRINCIPAL', 'varchar', 6, many(() => pick(['E119', 'I10X', 'J459', 'F321'])), 'CO_SALUD_DIAGNOSTICO'),
  col('CIE10', 'varchar', 6, many(() => pick(['E11.9', 'I10', 'J45.9', 'F32.1'])), 'CO_SALUD_DIAGNOSTICO'),
  col('CAUSA_DEFUNCION', 'varchar', 6, many(() => pick(['I219', 'C509', 'X954', 'J189'])), 'CO_SALUD_DIAGNOSTICO'),
  col('CODIGO_CUPS', 'varchar', 6, many(() => pick(['890201', '902210', '903841'])), 'CO_SALUD_PROCEDIMIENTO'),
  col('MEDICAMENTO', 'varchar', 40, many(() => pick(['Sertralina', 'Acetaminofén', 'Metformina'])), 'CO_SALUD_MEDICAMENTO'),
  col('EVOLUCION', 'clob', 4000, many(() => `Paciente refiere dolor abdominal de ${int(1, 9)} días de evolución.`), 'CO_SALUD_TEXTO_CLINICO'),
  col('RESULTADO_VIH', 'varchar', 12, many(() => pick(['Reactivo', 'No reactivo'])), 'CO_SALUD_RESULTADO_EXAMEN'),
  col('GRUPO_SANGUINEO', 'varchar', 4, many(() => pick(['A+', 'O-', 'AB+', 'O+'])), 'CO_SALUD_GRUPO_SANGUINEO'),
  col('TIPO_DISCAPACIDAD', 'varchar', 40, many(() => pick(['Física', 'Visual', 'Auditiva', 'Ninguna'])), 'CO_SALUD_DISCAPACIDAD'),
  col('CONCEPTO_APTITUD', 'varchar', 30, many(() => pick(['Apto', 'No apto'])), 'CO_SALUD_OCUPACIONAL'),
  col('GESTANTE', 'char', 1, many(() => pick(['S', 'N'])), 'CO_SALUD_REPRODUCTIVA'),
  col('TRASTORNO_MENTAL', 'varchar', 60, many(() => pick(['Depresión', 'Ansiedad'])), 'CO_SALUD_MENTAL'),

  // FIN
  col('SCORE_DATACREDITO', 'number', 3, many(() => String(int(150, 950))), 'CO_FIN_CREDITO'),
  col('REPORTADO', 'char', 1, many(() => pick(['S', 'N'])), 'CO_FIN_CREDITO'),
  col('SALDO_DEUDA', 'number', 12, many(() => String(int(100000, 90000000))), 'CO_FIN_DEUDA'),
  col('SALARIO', 'number', 10, many(() => String(int(1750905, 20000000))), 'CO_FIN_INGRESOS'),
  col('VALOR_AVALUO', 'number', 12, many(() => String(int(50000000, 900000000))), 'CO_FIN_PATRIMONIO'),
  col('MESADA_PENSIONAL', 'number', 10, many(() => String(int(1750905, 8000000))), 'CO_FIN_PENSION'),
  col('ESTRATO', 'number', 1, many(() => String(int(1, 6))), 'CO_FIN_ESTRATO'),
  col('GRUPO_SISBEN', 'varchar', 3, many(() => `${pick(['A', 'B', 'C', 'D'])}${int(1, 5)}`), 'CO_FIN_SISBEN'),
  col('BENEFICIARIO_RENTA_CIUDADANA', 'char', 1, many(() => pick(['S', 'N'])), 'CO_FIN_PROGRAMA_SOCIAL'),
  col('TENENCIA_VIVIENDA', 'varchar', 40, many(() => pick(['Propia', 'Arriendo', 'Familiar'])), 'CO_FIN_VIVIENDA'),

  // PENAL
  col('ANTECEDENTES_JUDICIALES', 'varchar', 60, many(() => pick(['No tiene asuntos pendientes', 'Registra antecedentes'])), 'CO_PENAL_ANTECEDENTES'),
  col('NUMERO_RADICADO', 'varchar', 23, many(radicado), 'CO_PENAL_RADICADO'),

  // Not personal data: nothing should be assigned
  col('ID', 'integer', 10, many((i) => String(i + 1)), ''),
  col('RUTA_ARCHIVO', 'varchar', 200, many(() => `/datos/archivo${int(1, 99)}.txt`), ''),
  col('NOMBRE_PRODUCTO', 'varchar', 80, many(() => pick(['Leche entera 1L', 'Arroz 5 kg', 'Café molido 500 g'])), ''),
  col('RAZON_SOCIAL', 'varchar', 80, many(() => `Comercializadora ${int(1, 99)} S.A.S.`), ''),
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
  col('DEPARTAMENTO', 'varchar', 30, many(() => pick(['Antioquia', 'Cundinamarca', 'Valle del Cauca', 'Santander'])), ''),
  col('COD_BANCO', 'varchar', 4, many(() => pick(['1007', '1051', '1013'])), ''),
  col('URL_PAGINA', 'varchar', 200, many(() => `https://www.ejemplo.com.co/p/${int(1, 999)}`), ''),
  col('TIPO_DOCUMENTO', 'varchar', 3, many(() => pick(['CC', 'TI', 'CE', 'NIT', 'PA'])), ''),
  col('MONEDA', 'varchar', 3, many(() => pick(['COP', 'USD'])), ''),
  col('CATEGORIA', 'varchar', 30, many(() => pick(['Lácteos', 'Panadería'])), ''),
  col('CUFE', 'varchar', 96, many(() => many(() => pick('0123456789abcdef'), 96).join('')), ''),
  col('CODIGO_CIIU', 'varchar', 4, many(() => pick(['4711', '6201', '8621'])), ''),
  col('IDIOMA', 'varchar', 5, many(() => pick(['es-CO', 'en', 'es'])), ''),
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

// ── Municipalities, offline ─────────────────────────────────────────────────
//
// Every municipality of under 20,000 inhabitants must become one of at least 20,000 of the same
// department when written with its department and by its code; by its name alone, unless the name
// is shared with a large one.

function verifyGeneralization() {
  const table = new Map(fs.readFileSync(nodePath.join(HERE, 'files', 'co-municipios-generalizados.txt'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('|')))
  const codes = new Map(fs.readFileSync(nodePath.join(HERE, 'files', 'co-codigos-municipio-generalizados.txt'), 'utf8').split('\n').filter(Boolean).map((l) => l.split(',')))
  const byCode = new Map(MUNICIPALITIES.map((m) => [m.code, m]))
  const byNameDepartment = new Map(MUNICIPALITIES.map((m) => [`${m.name} - ${m.department}`, m]))
  const key = (n) => fold(n).toLowerCase()
  const byName = new Map()
  for (const m of MUNICIPALITIES) for (const n of new Set([m.name, ...m.aliases].map(key))) byName.set(n, [...(byName.get(n) ?? []), m])
  let ok = 0
  let shared = 0
  for (const m of MUNICIPALITIES) {
    const problems = []
    const withDepartment = table.get(`${m.name} - ${m.department}`)
    const code = codes.get(m.code)
    if (m.population >= 20000) {
      if (withDepartment || code) problems.push('a large municipality is generalized')
      if (table.has(m.name)) problems.push('a large municipality name is generalized')
    } else {
      const target = withDepartment && byNameDepartment.get(withDepartment)
      if (!target) problems.push(`with its department: ${withDepartment ?? 'not in the table'}`)
      else if (target.population < 20000 || target.departmentCode !== m.departmentCode) problems.push(`became ${withDepartment}`)
      const byCodeTarget = code && byCode.get(code)
      if (!byCodeTarget || byCodeTarget.name !== target?.name) problems.push(`code ${m.code} → ${code}`)
      const homonyms = byName.get(key(m.name))
      if (homonyms.length > 1) shared++
      const alone = table.get(m.name)
      const withLarge = homonyms.some((x) => x.population >= 20000)
      if (withLarge) { if (alone) problems.push('a name shared with a large municipality is generalized') }
      else if (!alone || !(byName.get(key(alone)) ?? []).some((x) => x.population >= 20000)) problems.push(`by name: ${alone ?? 'not in the table'}`)
      for (const variant of [...(withLarge ? [] : [m.name.toUpperCase()]), `${m.name.toUpperCase()} (${m.department.toUpperCase()})`]) if (!table.has(variant) && !table.has(fold(variant))) problems.push(`no line for ${variant}`)
    }
    if (problems.length) { failures++; console.log(`  ✗ ${m.name}/${m.department} (${m.population}): ${problems.join('; ')}`) }
    else ok++
  }
  console.log(`municipalities: ${ok} of ${MUNICIPALITIES.length} generalized as expected (${shared} small ones share a name)`)
}

// ── Algorithms ──────────────────────────────────────────────────────────────

const words = (s) => s.trim().split(/\s+/).length
const sameShape = (i, o) => i.length === o.length && i.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9') === o.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9')
const digitShape = (i, o) => i.length === o.length && i.replace(/\d/g, '9') === o.replace(/\d/g, '9')
const MASKING = {
  CO_L1_CEDULA: { inputs: ['79.456.123', '1023456789', '1.023.456.789', '52123456', '800197268-4', 'AB123456'], check: (i, o) => (/-\d$/.test(i) ? validNit(o) && digitShape(i, o) : sameShape(i, o)) },
  CO_L1_NIT: {
    inputs: ['800.197.268-4', '800197268-4', '8001972684', '79456123-7', '1.023.456.789-5', '123456-3', ...many(nit, 20)],
    check: (i, o) => validNit(o) && digitShape(i, o),
  },
  CO_L1_DOCUMENTO_EXTRANJERO: { inputs: ['1234567', 'PEP 123456789'], check: sameShape },
  CO_L1_PASAPORTE: { inputs: ['AB123456'], check: sameShape },
  CO_L1_REGISTRO_CIVIL: { inputs: ['52345678'], check: sameShape },
  CO_L1_TARJETA_PROFESIONAL: { inputs: ['123456-T'], check: sameShape },
  CO_L1_NOMBRE: { inputs: ['Luz', 'JUAN CARLOS', 'María del Pilar', 'Ana María Luz Elena'], check: (i, o) => words(i) === words(o) && (!/ del /.test(i) || / del /.test(o)) },
  CO_L1_APELLIDO: { inputs: ['Rodríguez', 'GÓMEZ LÓPEZ', 'López de Gómez'], check: (i, o) => words(i) === words(o) && (!/ de /.test(i) || / de /.test(o)) },
  CO_L1_NOMBRE_COMPLETO: {
    inputs: ['Luz Rodríguez', 'JUAN RODRÍGUEZ GÓMEZ', 'Juan Carlos Rodríguez Gómez', 'María del Pilar Gómez Rojas', 'RODRÍGUEZ GÓMEZ, JUAN CARLOS'],
    check: (i, o) => words(i) === words(o) && [' del ', ' de '].every((w) => i.includes(w) === o.includes(w)),
  },
  CO_L1_EMAIL: { inputs: ['luz.rodriguez@gmail.com', 'josé.muñoz@empresa.com.co'], check: (i, o) => /@[^@]+\.test$/.test(o) },
  CO_L1_TELEFONO: {
    inputs: ['+57 310 456 7890', '3104567890', '601 345 6789', '(604) 444-5555', '3456789', '+573104567890'],
    // Country code and the first three digits stay; the length does too.
    check: (i, o) => (/^\d{7}$/.test(i) ? digitShape(i, o) : o.length === i.length && o.slice(0, i.length - 8).replace(/\d$/, '') === i.slice(0, i.length - 8).replace(/\d$/, '')),
  },
  CO_L1_DIRECCION: { inputs: ['Carrera 7 # 32-16 Oficina 1203', 'Calle 100 No. 19-54 Apto 802'] },
  CO_L1_DIRECCION_COMPLEMENTO: { inputs: ['Torre 3 Apto 502', 'Int. 4'] },
  CO_L1_CUENTA_BANCARIA: { inputs: ['123-456789-01'], check: digitShape },
  CO_L1_TARJETA: { inputs: ['4539 5787 6362 1486'] },
  CO_L1_LLAVE_BREB: {
    inputs: ['@luzrodriguez83', '3104567890', 'luz.rodriguez@gmail.com', '1023456789'],
    check: (i, o) => (i.includes('@') && !i.startsWith('@') ? o.endsWith('.test') : sameShape(i, o) && (!i.startsWith('@') || o.startsWith('@'))),
  },
  CO_L1_IP: { inputs: ['190.85.46.120', '2800:e2:f80::1'], check: (i, o) => (i.includes('.') ? o.split('.').every((p) => Number(p) >= 1 && Number(p) <= 254) : /^[0-9a-f:]+$/i.test(o)) },
  CO_L1_DISPOSITIVO: { inputs: ['3c:22:fb:9a:10:e4', '356938035643809'], check: (i, o) => (i.includes(':') ? /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(o) : /^\d{15}$/.test(o)) },
  CO_L1_PLACA: { inputs: ['KDZ123', 'ABC-123', 'XYZ12D'], check: sameShape },
  CO_L1_VEHICULO: { inputs: ['9FBHS41A1YM123456'], check: sameShape },
  CO_L1_INMUEBLE: { inputs: ['50C-1234567', '050010100000000010001000000000'], check: (i, o) => digitShape(i, o) && (/-/.test(i) ? o.startsWith('50C-') : o.slice(0, 5) === i.slice(0, 5)) },
  CO_L1_CONTRATO: { inputs: ['CT-123456'] },
  CO_L1_USUARIO: { inputs: ['@luz_rodriguez'] },
  CO_L1_CREDENCIAL: { inputs: ['Clave#2024'], check: (i, o) => /^X+$/.test(o) },
  CO_L1_GEOLOCALIZACION: { inputs: ['4.609710', '4.609710,-74.081750'], check: (i, o) => o.slice(0, 3) === i.slice(0, 3) },
  CO_L1_TEXTO_LIBRE: {
    inputs: ['Cliente Rodríguez, CC 79.456.123, correo l.rodriguez@gmail.com, cel 3104567890.'],
    check: (i, o) => !/79\.456\.123|l\.rodriguez@gmail\.com|3104567890|Rodríguez/.test(o),
  },
  CO_L2_FECHA_NACIMIENTO: { inputs: ['1985-07-20', '2012-01-15'], check: (i, o) => Math.abs(new Date(o.slice(0, 10)) - new Date(i)) <= 60 * 864e5 },
  CO_L2_ANIO_NACIMIENTO: { inputs: ['1985'], check: (i, o) => o.startsWith('198'), same: true },
  CO_L2_EDAD: { inputs: ['37', '7', '104'], check: (i, o) => (i === '104' ? o === '90' : i.length === 1 || o[0] === i[0]), same: true },
  CO_L2_FECHA_EVENTO: { inputs: ['2021-03-15'] },
  CO_L2_SEXO: { inputs: ['F', 'M', 'Femenino', 'masculino', 'Hombre', '1'], same: true },
  CO_L2_MUNICIPIO: { inputs: ['Jardín', 'Medellín', 'PROVIDENCIA', 'La Unión - Sucre', 'Mapiripana', 'La Unión'], same: true },
  CO_L2_CODIGO_MUNICIPIO: { inputs: ['05364', '05001'], same: true },
  CO_L2_CODIGO_POSTAL: { inputs: ['110231'], check: (i, o) => o === '110000' },
  CO_L2_BARRIO: { inputs: ['Chapinero Alto'], same: true },
  CO_L2_VEREDA: { inputs: ['Vereda La Esperanza'] },
  CO_L2_NACIONALIDAD: { inputs: ['Haitiana'], same: true },
  CO_L2_ESTADO_CIVIL: { inputs: ['Unión libre', '2'], same: true },
  CO_L2_OCUPACION: { inputs: ['Gerente de operaciones regionales', '2221'] },
  CO_L2_EMPLEADOR: { inputs: ['Ecopetrol S.A.'] },
  CO_L2_ESCOLARIDAD: { inputs: ['Posdoctorado', '7'], same: true },
  CO_L2_INSTITUCION_EDUCATIVA: { inputs: ['Colegio Mayor de San Bartolomé'] },
  CO_L2_PERSONAS_A_CARGO: { inputs: ['9', '2'], check: (i, o) => Number(o) <= 5, same: true },
  CO_L3_GRUPO_ETNICO: { inputs: ['Afrocolombiana', '5', 'N'], same: true },
  CO_L3_PUEBLO_INDIGENA: { inputs: ['Kuna', '720'], same: true },
  CO_L3_LENGUA_NATIVA: { inputs: ['Tikuna'], same: true },
  CO_L3_RELIGION: { inputs: ['Anglicana', 'N'], same: true },
  CO_L3_CONVICCION_FILOSOFICA: { inputs: ['Se niega a transfusiones'] },
  CO_L3_ORIENTACION_POLITICA: { inputs: ['Uribista'], same: true },
  CO_L3_AFILIACION_PARTIDO: { inputs: ['Polo Democrático Alternativo', 'S'], same: true },
  CO_L3_SINDICATO: { inputs: ['SINTRAINAL', 'S'], same: true },
  CO_L3_ORGANIZACION_SOCIAL: { inputs: ['Junta de Acción Comunal vereda El Salitre'] },
  CO_L3_BIOMETRICO: { inputs: ['A1B2C3D4E5F6'] },
  CO_L3_GENETICO: { inputs: ['BRCA1 positivo'] },
  CO_L3_ORIENTACION_SEXUAL: { inputs: ['Homosexual'], same: true },
  CO_L3_VIDA_SEXUAL: { inputs: ['Activa'] },
  CO_L3_IDENTIDAD_GENERO: { inputs: ['Transgénero'], same: true },
  CO_L3_VICTIMA_CONFLICTO: { inputs: ['Masacre', 'S'], same: true },
  CO_L3_REINCORPORACION: { inputs: ['Excombatiente FARC-EP'] },
  CO_SALUD_IDENTIFICADOR: { inputs: ['HC-2024-00123'] },
  CO_SALUD_AFILIACION: { inputs: ['Subsidiado', 'Medimás EPS'], same: true },
  CO_SALUD_DIAGNOSTICO: { inputs: ['F33.1', 'B24X', 'E119', 'Depresión mayor'], same: true },
  CO_SALUD_PROCEDIMIENTO: { inputs: ['906249', 'Prueba de carga viral para VIH'], same: true },
  CO_SALUD_MEDICAMENTO: { inputs: ['Sertralina 50 mg'] },
  CO_SALUD_TEXTO_CLINICO: { inputs: ['Paciente Rodríguez, CC 79.456.123, consulta por cefalea.'], check: (i, o) => !o.includes('79.456.123') },
  CO_SALUD_RESULTADO_EXAMEN: { inputs: ['Reactivo'] },
  CO_SALUD_GRUPO_SANGUINEO: { inputs: ['O+'], same: true },
  CO_SALUD_DISCAPACIDAD: { inputs: ['Trastorno del espectro autista', 'N'], same: true },
  CO_SALUD_OCUPACIONAL: { inputs: ['No apto temporalmente', 'S'], same: true },
  CO_SALUD_REPRODUCTIVA: { inputs: ['12 semanas de gestación', 'S'], same: true },
  CO_SALUD_MENTAL: { inputs: ['Trastorno bipolar'] },
  CO_FIN_CREDITO: { inputs: ['Reportado en DataCrédito', '745', 'N'], same: true },
  CO_FIN_DEUDA: { inputs: ['8500000'] },
  CO_FIN_INGRESOS: { inputs: ['3200000'] },
  CO_FIN_PATRIMONIO: { inputs: ['185000000'] },
  CO_FIN_PENSION: { inputs: ['2400000'] },
  CO_FIN_ESTRATO: { inputs: ['1', '3', '6', 'Estrato 4'], same: true },
  CO_FIN_SISBEN: { inputs: ['A3', 'B7', 'C15', 'D21', '45.32', 'Pobreza extrema'], same: true },
  CO_FIN_PROGRAMA_SOCIAL: { inputs: ['Familias en Acción', 'S'], same: true },
  CO_FIN_VIVIENDA: { inputs: ['Invasión'], same: true },
  CO_PENAL_ANTECEDENTES: { inputs: ['Condenado por hurto en 2019', 'S'], same: true },
  CO_PENAL_RADICADO: { inputs: ['11001310300120200012300', '11001-31-03-001-2020-00123-00'], check: (i, o) => { const d = (x) => x.replace(/\D/g, ''); return digitShape(i, o) && d(o).slice(0, 16) === d(i).slice(0, 16) && d(o).slice(-2) === d(i).slice(-2) } },
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
  CO_L1_NOMBRE: (i, o) => words(i) > 3 || o.split(/\s+/).every((w) => PARTICLE.test(w) || has('co-nombres.txt', w)),
  CO_L1_APELLIDO: (i, o) => o.split(/\s+/).every((w) => PARTICLE.test(w) || has('co-apellidos.txt', w)),
  CO_L1_NOMBRE_COMPLETO: (i, o) => i.includes(',') || (has('co-nombres.txt', o.split(/\s+/)[0]) && has('co-apellidos.txt', o.split(/\s+/).at(-1))),
  CO_L1_DIRECCION: (i, o) => has('co-direcciones.txt', o),
  CO_L2_SEXO: (i, o) => ({ f: ['f', 'm'], m: ['f', 'm'], femenino: ['femenino', 'masculino'], masculino: ['femenino', 'masculino'], hombre: ['mujer', 'hombre'], 1: ['1', '2'] })[i.toLowerCase()].includes(o.toLowerCase()),
  // Jardín becomes a municipality of 20,000 or more of Antioquia; Medellín stays; Providencia becomes
  // San Andrés; La Unión is shared with large municipalities and stays alone, but not with its
  // department.
  CO_L2_MUNICIPIO: (i, o) => ({ Medellín: o === 'Medellín', PROVIDENCIA: o === 'SAN ANDRÉS', 'La Unión': o === 'La Unión', 'La Unión - Sucre': / - Sucre$/.test(o) && o !== i && LARGE.has(o.slice(0, -8).toLowerCase()), Mapiripana: o === 'Inírida' })[i] ?? LARGE.has(o.toLowerCase()),
  CO_L2_CODIGO_MUNICIPIO: (i, o) => (i === '05001' ? o === i : o.slice(0, 2) === '05' && o !== i),
  CO_L2_BARRIO: (i, o) => has('co-barrios.txt', o),
  CO_L2_VEREDA: (i, o) => o === 'Zona rural',
  CO_L2_NACIONALIDAD: (i, o) => has('co-nacionalidades.txt', o),
  CO_L2_ESTADO_CIVIL: (i, o) => (/^\d$/.test(i) ? /^[1-6]$/.test(o) : has('co-estado-civil.txt', o)),
  CO_L2_OCUPACION: (i, o) => (/^\d+$/.test(i) ? /^\d{4}$/.test(o) : has('co-ocupaciones.txt', o)),
  CO_L2_EMPLEADOR: (i, o) => has('co-empleadores.txt', o),
  CO_L2_ESCOLARIDAD: (i, o) => (/^\d+$/.test(i) ? has('co-escolaridad-codigos.txt', o) : has('co-escolaridad.txt', o)),
  CO_L2_INSTITUCION_EDUCATIVA: (i, o) => has('co-instituciones-educativas.txt', o),
  CO_L3_GRUPO_ETNICO: (i, o) => flag(i, o) ?? (/^\d$/.test(i) ? has('co-grupos-etnicos-codigos.txt', o) : has('co-grupos-etnicos.txt', o)),
  CO_L3_PUEBLO_INDIGENA: (i, o) => (/^\d+$/.test(i) ? has('co-pueblos-indigenas-codigos.txt', o) : has('co-pueblos-indigenas.txt', o)),
  CO_L3_LENGUA_NATIVA: (i, o) => has('co-lenguas.txt', o),
  CO_L3_RELIGION: (i, o) => flag(i, o) ?? has('co-religiones.txt', o),
  CO_L3_CONVICCION_FILOSOFICA: (i, o) => o === SUPPRESSED,
  CO_L3_ORIENTACION_POLITICA: (i, o) => has('co-orientaciones-politicas.txt', o),
  CO_L3_AFILIACION_PARTIDO: (i, o) => flag(i, o) ?? has('co-partidos.txt', o),
  CO_L3_SINDICATO: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  CO_L3_ORGANIZACION_SOCIAL: (i, o) => o === SUPPRESSED,
  CO_L3_ORIENTACION_SEXUAL: (i, o) => has('co-orientaciones-sexuales.txt', o),
  CO_L3_VIDA_SEXUAL: (i, o) => o === SUPPRESSED,
  CO_L3_IDENTIDAD_GENERO: (i, o) => has('co-identidades-genero.txt', o),
  CO_L3_VICTIMA_CONFLICTO: (i, o) => flag(i, o) ?? has('co-hechos-victimizantes.txt', o),
  CO_L3_REINCORPORACION: (i, o) => o === SUPPRESSED,
  CO_SALUD_AFILIACION: (i, o) => (/subsidiado/i.test(i) ? has('co-regimenes-salud.txt', o) : has('co-eps.txt', o)),
  CO_SALUD_DIAGNOSTICO: (i, o) => (/\.\d/.test(i) ? has('co-cie10-decimal.txt', o) : /^[A-Z]\d{2,3}X?$/i.test(i) ? has('co-cie10.txt', o) : has('co-diagnosticos.txt', o)),
  CO_SALUD_PROCEDIMIENTO: (i, o) => (/^\d+$/.test(i) ? has('co-cups.txt', o) : has('co-procedimientos.txt', o)),
  CO_SALUD_MEDICAMENTO: (i, o) => has('co-medicamentos.txt', o),
  CO_SALUD_GRUPO_SANGUINEO: (i, o) => has('co-grupos-sanguineos.txt', o),
  CO_SALUD_DISCAPACIDAD: (i, o) => flag(i, o) ?? has('co-discapacidades.txt', o),
  CO_SALUD_OCUPACIONAL: (i, o) => flag(i, o) ?? has('co-aptitud-laboral.txt', o),
  CO_SALUD_REPRODUCTIVA: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  CO_SALUD_MENTAL: (i, o) => o === SUPPRESSED,
  CO_FIN_CREDITO: (i, o) => flag(i, o) ?? (/^\d{3}$/.test(i) ? /^\d{3}$/.test(o) : has('co-estados-credito.txt', o)),
  CO_FIN_ESTRATO: (i, o) => { const d = Number(i.match(/\d/)[0]); const band = Math.ceil(d / 2); return o.replace(/\d$/, '') === i.replace(/\d$/, '') && Math.ceil(Number(o.at(-1)) / 2) === band },
  CO_FIN_SISBEN: (i, o) => {
    const m = i.match(/^([A-D])(\d+)$/)
    if (m) { const n = Number(o.slice(1)); return o[0] === m[1] && n >= 1 && n <= { A: 5, B: 7, C: 18, D: 21 }[m[1]] }
    return /^\d/.test(i) ? /^\d{2}\.\d{2}$/.test(o) : has('co-sisben-grupos.txt', o)
  },
  CO_FIN_PROGRAMA_SOCIAL: (i, o) => flag(i, o) ?? has('co-programas-sociales.txt', o),
  CO_FIN_VIVIENDA: (i, o) => has('co-tenencia-vivienda.txt', o),
  CO_PENAL_ANTECEDENTES: (i, o) => flag(i, o) ?? has('co-antecedentes.txt', o),
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
  const TYPED = new Set(['CO_L2_FECHA_NACIMIENTO', 'CO_L2_FECHA_EVENTO', 'CO_FIN_DEUDA', 'CO_FIN_INGRESOS', 'CO_FIN_PATRIMONIO', 'CO_FIN_PENSION'])
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

  // NITs stay NITs: 200 distinct inputs of every length give 200 distinct valid outputs, and the
  // remainder 1 — where Check Digit alone would be wrong — is among them.
  const nits = [...new Set(many(nit, 200))]
  const outputs = new Set()
  let invalid = 0
  let remainderOne = 0
  let i = 0
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < nits.length) {
      const { output } = await run('CO_NIT', nits[i++])
      outputs.add(output)
      if (!output || !validNit(output)) invalid++
      else if (nitRemainder(output.replace(/[.\s]/g, '').split('-')[0]) === 1) remainderOne++
    }
  }))
  if (outputs.size !== nits.length || invalid || !remainderOne) { failures++; console.log(`  ✗ NIT: ${nits.length} inputs gave ${outputs.size} distinct outputs, ${invalid} invalid, ${remainderOne} with remainder 1`) }
  else console.log(`NIT: ${nits.length} distinct inputs, ${outputs.size} distinct valid outputs (${remainderOne} with remainder 1)`)

  const cedulas = [...new Set(many(cedula, 150))]
  const cedulaOut = new Set()
  for (const c of cedulas) cedulaOut.add((await run('CO_DOCUMENTO', c)).output)
  if (cedulaOut.size !== cedulas.length) { failures++; console.log(`  ✗ cédula: ${cedulas.length} inputs gave ${cedulaOut.size} distinct outputs`) }
  else console.log(`cédula: ${cedulas.length} distinct inputs, ${cedulaOut.size} distinct outputs`)

  // A natural person's NIT is the cédula and a check digit: masked, the body is the masked cédula.
  let agree = 0
  const people = many(() => String(int(1000000, 99999999)), 20)
  for (const c of people) {
    const [a, b] = await Promise.all([run('CO_DOCUMENTO', c), run('CO_NIT', `${c}-${nitDigit(c)}`)])
    if (a.output && b.output && b.output.split('-')[0] === a.output) agree++
  }
  if (agree !== people.length) { failures++; console.log(`  ✗ cédula and NIT agree for ${agree} of ${people.length} people`) }
  else console.log(`cédula and NIT of the same person agree: ${agree} of ${people.length}`)
}

if (only !== 'algorithms') { verifyClassifiers(); verifyGeneralization() }
if (only !== 'classifiers') await verifyAlgorithms()
console.log(failures ? `\n${failures} problem(s)` : '\nall good')
process.exit(failures ? 1 : 0)
