#!/usr/bin/env node
/**
 * Checks the Uruguay (Ley 18.331) preset.
 *
 *   node presets/uruguay-ley-18331/verify.mjs               # classifiers, then algorithms
 *   node presets/uruguay-ley-18331/verify.mjs classifiers   # only the local profiling check
 *   node presets/uruguay-ley-18331/verify.mjs algorithms    # only masking, against the app
 *
 * Classifiers run through classifiers/, the same evaluator the classifier test uses: every
 * configuration is reviewed, then a battery of columns — well named, badly named and unrelated —
 * is profiled with the whole set at its threshold. The table that generalizes localidades is
 * audited offline. Algorithms run in the app (DLPX_URL, default http://localhost:3000), which needs
 * the Delphix jars in lib/; every cédula and RUT they write is checked against its check-digit rule.
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

// Cédula de identidad: weights 2 9 8 7 6 3 4 over the seven digits, modulus 10, ten minus the
// remainder. Published worked example: 1.234.567 gives 2.
const CI_WEIGHTS = [2, 9, 8, 7, 6, 3, 4]
const cedulaDigit = (body) => String((10 - ([...body].reduce((a, d, i) => a + Number(d) * CI_WEIGHTS[i], 0) % 10)) % 10)
const validCedula = (v) => { const d = v.replace(/\D/g, ''); return /^\d{8}$/.test(d) && cedulaDigit(d.slice(0, 7)) === d[7] }

// RUT: weights 4 3 2 9 8 7 6 5 4 3 2 over the first eleven digits, modulus 11, eleven minus the
// remainder, written 0 when that is eleven and 1 when it is ten. Antel's 21-100342-001-7 checks out.
const RUT_WEIGHTS = [4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
const rutDigit = (body) => {
  const value = 11 - ([...body].reduce((a, d, i) => a + Number(d) * RUT_WEIGHTS[i], 0) % 11)
  return String(value === 11 ? 0 : value === 10 ? 1 : value)
}
const validRut = (v) => { const d = v.replace(/\D/g, ''); return /^\d{12}$/.test(d) && rutDigit(d.slice(0, 11)) === d[11] }

// ── Test data ───────────────────────────────────────────────────────────────

let seed = 18331
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
const DEPARTAMENTOS = source('departamentos.tsv').map((l) => {
  const [code, name, , , population] = l.split('\t')
  return { code, name, population: Number(population) }
})
const LOCALIDADES = source('localidades.tsv').map((l) => {
  const [code, name, departmentCode, department, , , population, approximate] = l.split('\t')
  return { code, name, departmentCode, department, population: Number(population), approximate: approximate === 'D' }
})
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '')
const PERSONAL = new Set([...GIVEN, ...SURNAMES].map((w) => fold(w).toLowerCase()))
const DEPARTMENT_NAMES = new Set(DEPARTAMENTOS.map((d) => fold(d.name).toLowerCase()))
const SMALL_NAMES = LOCALIDADES.filter((l) => l.population < 20000 && !PERSONAL.has(fold(l.name).toLowerCase()) && !DEPARTMENT_NAMES.has(fold(l.name).toLowerCase())).map((l) => l.name)
const LARGE_NAMES = LOCALIDADES.filter((l) => l.population >= 20000).map((l) => l.name)

const pad = (n, w) => String(n).padStart(w, '0')
const digits = (n) => many(() => int(0, 9), n).join('')
const cedulaBody = () => String(int(1000000, 5999999))
const cedula = () => { const b = cedulaBody(); return `${b[0]}.${b.slice(1, 4)}.${b.slice(4)}-${cedulaDigit(b)}` }
const cedulaPlain = () => { const b = cedulaBody(); return b + cedulaDigit(b) }
const rut = () => { const b = `${pad(int(11, 22), 2)}${digits(6)}001`; return b + rutDigit(b) }
const luhn = (prefix, length) => {
  const ds = [...prefix].map(Number)
  while (ds.length < length - 1) ds.push(int(0, 9))
  const sum = ds.slice().reverse().reduce((s, d, i) => s + (i % 2 === 0 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0)
  return ds.join('') + String((10 - (sum % 10)) % 10)
}
const iso = (y0, y1) => `${int(y0, y1)}-${pad(int(1, 12), 2)}-${pad(int(1, 28), 2)}`
const fullName = () => `${pick(GIVEN)}${random() < 0.4 ? ` ${pick(GIVEN)}` : ''} ${pick(SURNAMES)} ${pick(SURNAMES)}`
const phone = () => pick([`09${int(1, 9)} ${int(100, 999)} ${int(100, 999)}`, `+598 9${digits(7)}`, `09${digits(7)}`, `2${int(100, 999)} ${int(10, 99)} ${int(10, 99)}`])
const address = () => pick([`Av. 18 de Julio ${int(100, 2500)}`, `Bv. Artigas ${int(100, 3500)} apto. ${int(101, 900)}`, `Calle Mercedes ${int(100, 1900)} esq. Río Branco`, `Ruta ${int(1, 9)} km ${int(10, 300)}`])
const letters = (n) => many(() => pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), n).join('')
const plate = () => `${letters(3)}${pick([' ', '-'])}${int(1000, 9999)}`

// ── Classifiers ─────────────────────────────────────────────────────────────

const SQL = { varchar: 12, char: 1, number: 2, integer: 4, date: 91, timestamp: 93, clob: 2005 }
const col = (name, type, length, values, expect) => ({ name, sqlType: SQL[type], length, values, expect })

const COLUMNS = [
  // L1 — well named
  col('NUMERO_DOCUMENTO', 'varchar', 14, many(cedula), 'UY_L1_CEDULA'),
  col('CEDULA', 'varchar', 14, many(cedula), 'UY_L1_CEDULA'),
  col('CI_CLIENTE', 'varchar', 10, many(cedulaPlain), 'UY_L1_CEDULA'),
  col('RUT', 'varchar', 12, many(rut), 'UY_L1_RUT'),
  col('RUT_PROVEEDOR', 'varchar', 12, many(rut), 'UY_L1_RUT'),
  col('CEDULA_EXTRANJERIA', 'varchar', 12, many(() => `${letters(1)}${int(100000, 999999)}`), 'UY_L1_DOCUMENTO_EXTRANJERO'),
  col('PASAPORTE', 'varchar', 10, many(() => `${letters(1)}${int(100000, 999999)}`), 'UY_L1_PASAPORTE'),
  col('CREDENCIAL_CIVICA', 'varchar', 10, many(() => `${letters(3)} ${int(10000, 99999)}`), 'UY_L1_CREDENCIAL_CIVICA'),
  col('PARTIDA_NACIMIENTO', 'varchar', 14, many(() => `${int(1, 400)}/${int(1980, 2020)}`), 'UY_L1_PARTIDA'),
  col('NUMERO_BPS', 'varchar', 14, many(() => String(int(100000000, 999999999))), 'UY_L1_SEGURO_SOCIAL'),
  col('CODIGO_ALUMNO', 'varchar', 12, many(() => `${int(2015, 2025)}${int(10000, 99999)}`), 'UY_L1_CODIGO_ESTUDIANTE'),
  col('MATRICULA_PROFESIONAL', 'varchar', 12, many(() => `MP-${int(10000, 99999)}`), 'UY_L1_MATRICULA_PROFESIONAL'),
  col('PRIMER_NOMBRE', 'varchar', 30, many(() => pick(GIVEN)), 'UY_L1_NOMBRE'),
  col('APELLIDO_PATERNO', 'varchar', 30, many(() => pick(SURNAMES)), 'UY_L1_APELLIDO'),
  col('APELLIDOS', 'varchar', 60, many(() => `${pick(SURNAMES)} ${pick(SURNAMES)}`), 'UY_L1_APELLIDO'),
  col('NOMBRE_COMPLETO', 'varchar', 120, many(fullName), 'UY_L1_NOMBRE_COMPLETO'),
  col('NOMBRE_CLIENTE', 'varchar', 120, many(fullName), 'UY_L1_NOMBRE_COMPLETO'),
  col('NOMBRE', 'varchar', 120, many(fullName), 'UY_L1_NOMBRE_COMPLETO'),
  col('RAZON_SOCIAL', 'varchar', 80, many(() => `Comercial ${int(1, 99)} S.R.L.`), 'UY_L1_RAZON_SOCIAL'),
  col('NOMBRE_FANTASIA', 'varchar', 80, many(() => `Distribuidora ${int(1, 99)} S.A.`), 'UY_L1_RAZON_SOCIAL'),
  col('CORREO_ELECTRONICO', 'varchar', 100, many(() => `${fold(pick(GIVEN)).toLowerCase()}.${int(1, 999)}@gmail.com`), 'UY_L1_EMAIL'),
  col('EMAIL', 'varchar', 100, many(() => `contacto${int(1, 999)}@empresa.com.uy`), 'UY_L1_EMAIL'),
  col('TELEFONO', 'varchar', 16, many(phone), 'UY_L1_TELEFONO'),
  col('CELULAR', 'varchar', 16, many(() => `09${digits(7)}`), 'UY_L1_TELEFONO'),
  col('DIRECCION', 'varchar', 150, many(address), 'UY_L1_DIRECCION'),
  col('DOMICILIO', 'varchar', 150, many(address), 'UY_L1_DIRECCION'),
  col('APARTAMENTO', 'varchar', 8, many(() => `apto. ${int(101, 900)}`), 'UY_L1_DIRECCION_COMPLEMENTO'),
  col('NUMERO_CUENTA', 'varchar', 20, many(() => digits(14)), 'UY_L1_CUENTA_BANCARIA'),
  col('NUMERO_TARJETA', 'varchar', 19, many(() => luhn('4', 16)), 'UY_L1_TARJETA'),
  col('BILLETERA_DIGITAL', 'varchar', 64, many(() => `bc1q${many(() => pick('023456789acdefghjklmnpqrstuvwxyz'), 38).join('')}`), 'UY_L1_BILLETERA'),
  col('IP_ORIGEN', 'varchar', 15, many(() => `${int(1, 223)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`), 'UY_L1_IP'),
  col('MAC_ADDRESS', 'varchar', 17, many(() => many(() => int(0, 255).toString(16).padStart(2, '0'), 6).join(':')), 'UY_L1_DISPOSITIVO'),
  col('IMEI', 'varchar', 15, many(() => luhn('35', 15)), 'UY_L1_DISPOSITIVO'),
  col('COOKIE_ID', 'varchar', 40, many(() => `GA1.2.${int(100000000, 999999999)}.${int(1600000000, 1799999999)}`), 'UY_L1_COOKIE'),
  col('MATRICULA_VEHICULO', 'varchar', 10, many(plate), 'UY_L1_PLACA'),
  col('NUMERO_CHASIS', 'varchar', 17, many(() => many(() => pick('ABCDEFGHJKLMNPRSTUVWXYZ0123456789'), 17).join('')), 'UY_L1_VEHICULO'),
  col('PADRON', 'varchar', 12, many(() => String(int(1000, 99999))), 'UY_L1_INMUEBLE'),
  col('NUMERO_CONTRATO', 'varchar', 12, many(() => `CT-${int(100000, 999999)}`), 'UY_L1_CONTRATO'),
  col('USUARIO', 'varchar', 30, many(() => `${fold(pick(GIVEN)).toLowerCase()}${int(1, 99)}`), 'UY_L1_USUARIO'),
  col('CONTRASENA', 'varchar', 60, many(() => `$2a$10$${many(() => pick('abcdefghijklmnopqrstuvwxyz0123456789'), 53).join('')}`), 'UY_L1_CREDENCIAL'),
  col('LATITUD', 'varchar', 12, many(() => `-34.${int(100000, 999999)}`), 'UY_L1_GEOLOCALIZACION'),
  col('OBSERVACIONES', 'clob', 4000, many(() => `Cliente solicita actualizar datos. CI ${cedula()}, correo ${fold(pick(GIVEN)).toLowerCase()}@gmail.com.`), 'UY_L1_TEXTO_LIBRE'),

  // L1 — badly named: only the values can tell
  col('CAMPO1', 'varchar', 14, many(cedula), 'UY_L1_CEDULA'),
  col('CAMPO2', 'varchar', 30, many(() => pick(GIVEN)), 'UY_L1_NOMBRE'),
  col('CAMPO3', 'varchar', 30, many(() => pick(SURNAMES)), 'UY_L1_APELLIDO'),
  col('CAMPO4', 'varchar', 120, many(fullName), 'UY_L1_NOMBRE_COMPLETO'),
  col('CAMPO5', 'varchar', 100, many(() => `${fold(pick(GIVEN)).toLowerCase()}@hotmail.com`), 'UY_L1_EMAIL'),
  col('CAMPO6', 'varchar', 16, many(() => `09${digits(7)}`), 'UY_L1_TELEFONO'),
  col('CAMPO7', 'varchar', 150, many(address), 'UY_L1_DIRECCION'),
  col('CAMPO8', 'varchar', 19, many(() => luhn('5', 16)), 'UY_L1_TARJETA'),
  col('CAMPO9', 'varchar', 15, many(() => `192.168.${int(0, 255)}.${int(1, 254)}`), 'UY_L1_IP'),
  col('CAMPO10', 'varchar', 10, many(plate), 'UY_L1_PLACA'),
  col('CAMPO11', 'varchar', 12, many(rut), 'UY_L1_RUT'),
  col('TXT', 'clob', 4000, many(() => `Paciente ${pick(GIVEN)} ${pick(SURNAMES)}, CI ${cedula()}, cel 09${digits(7)}.`), 'UY_L1_TEXTO_LIBRE'),

  // L2
  col('FECHA_NACIMIENTO', 'date', 0, many(() => iso(1940, 2010)), 'UY_L2_FECHA_NACIMIENTO'),
  col('FEC_NAC', 'varchar', 10, many(() => iso(1940, 2010)), 'UY_L2_FECHA_NACIMIENTO'),
  col('fechaNacimiento', 'timestamp', 0, many(() => iso(1940, 2010)), 'UY_L2_FECHA_NACIMIENTO'),
  col('ANIO_NACIMIENTO', 'number', 4, many(() => String(int(1940, 2010))), 'UY_L2_ANIO_NACIMIENTO'),
  col('EDAD', 'number', 3, many(() => String(int(0, 99))), 'UY_L2_EDAD'),
  col('FECHA_DEFUNCION', 'date', 0, many(() => iso(2000, 2025)), 'UY_L2_FECHA_EVENTO'),
  col('FECHA_INGRESO', 'date', 0, many(() => iso(1990, 2025)), 'UY_L2_FECHA_EVENTO'),
  col('SEXO', 'char', 1, many(() => pick(['F', 'M'])), 'UY_L2_SEXO'),
  col('GENERO', 'varchar', 10, many(() => pick(['Femenino', 'Masculino'])), 'UY_L2_SEXO'),
  col('LOCALIDAD', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'UY_L2_LOCALIDAD'),
  col('CIUDAD', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'UY_L2_LOCALIDAD'),
  col('LUGAR_NACIMIENTO', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'UY_L2_LOCALIDAD'),
  col('CAMPO12', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'UY_L2_LOCALIDAD'),
  col('CODIGO_LOCALIDAD', 'varchar', 5, many(() => pick(LOCALIDADES).code), 'UY_L2_CODIGO_INE'),
  col('CODIGO_POSTAL', 'varchar', 5, many(() => String(int(11000, 12900))), 'UY_L2_CODIGO_POSTAL'),
  col('BARRIO', 'varchar', 60, many(() => pick(BARRIOS)), 'UY_L2_BARRIO'),
  col('ESTADO_CIVIL', 'varchar', 30, many(() => pick(['Soltero', 'Casado', 'Concubinato', 'Viudo'])), 'UY_L2_ESTADO_CIVIL'),
  col('PROFESION', 'varchar', 60, many(() => pick(['Docente', 'Chofer', 'Enfermero'])), 'UY_L2_OCUPACION'),
  col('NOMBRE_EMPLEADOR', 'varchar', 80, many(() => `Distribuidora ${int(1, 99)} S.R.L.`), 'UY_L2_EMPLEADOR'),
  col('NIVEL_EDUCATIVO', 'varchar', 40, many(() => pick(['Bachillerato', 'Universidad', 'Ciclo básico'])), 'UY_L2_NIVEL_EDUCATIVO'),
  col('LICEO', 'varchar', 80, many(() => `Liceo N.º ${int(1, 70)}`), 'UY_L2_INSTITUCION_EDUCATIVA'),
  col('PERSONAS_A_CARGO', 'number', 2, many(() => String(int(0, 8))), 'UY_L2_PERSONAS_A_CARGO'),

  // L3
  col('ASCENDENCIA', 'varchar', 60, many(() => pick(['Afro o negra', 'Blanca', 'Indígena', 'Asiática o amarilla'])), 'UY_L3_ASCENDENCIA'),
  col('CAMPO13', 'varchar', 60, many(() => pick(['Afro o negra', 'Blanca', 'Indígena', 'Otra'])), 'UY_L3_ASCENDENCIA'),
  col('PUEBLO_ORIGINARIO', 'varchar', 60, many(() => pick(['Charrúa', 'Guaraní', 'Chaná'])), 'UY_L3_PUEBLO_ORIGINARIO'),
  col('NACIONALIDAD', 'varchar', 20, many(() => pick(['Uruguaya', 'Venezolana', 'Argentina'])), 'UY_L3_NACIONALIDAD'),
  col('RELIGION', 'varchar', 40, many(() => pick(['Católica', 'Umbandista o afroumbandista', 'Ateo o agnóstico'])), 'UY_L3_RELIGION'),
  col('OBJECION_CONCIENCIA', 'varchar', 60, many(() => pick(['Transfusiones', 'Ninguna'])), 'UY_L3_CONVICCION_MORAL'),
  col('INTENCION_VOTO', 'varchar', 40, many(() => pick(['Izquierda', 'Derecha', 'Centro'])), 'UY_L3_PREFERENCIA_POLITICA'),
  col('PARTIDO_POLITICO', 'varchar', 60, many(() => pick(['Frente Amplio', 'Partido Nacional', 'Partido Colorado'])), 'UY_L3_AFILIACION_PARTIDARIA'),
  col('CUOTA_SINDICAL', 'char', 1, many(() => pick(['S', 'N'])), 'UY_L3_AFILIACION_SINDICAL'),
  col('HUELLA_DACTILAR', 'varchar', 200, many(() => many(() => pick('ABCDEF0123456789'), 64).join('')), 'UY_L3_BIOMETRICO'),
  col('PRUEBA_ADN', 'varchar', 200, many(() => 'AGTC'.repeat(10)), 'UY_L3_GENETICO'),
  col('ORIENTACION_SEXUAL', 'varchar', 30, many(() => pick(['Heterosexual', 'Gay', 'Bisexual'])), 'UY_L3_ORIENTACION_SEXUAL'),
  col('VIDA_SEXUAL_ACTIVA', 'char', 1, many(() => pick(['S', 'N'])), 'UY_L3_VIDA_SEXUAL'),
  col('IDENTIDAD_GENERO', 'varchar', 30, many(() => pick(['Mujer trans', 'Hombre cisgénero'])), 'UY_L3_IDENTIDAD_GENERO'),
  col('VICTIMA_VIOLENCIA', 'char', 1, many(() => pick(['S', 'N'])), 'UY_L3_VICTIMA'),

  // SALUD
  col('NUMERO_HISTORIA_CLINICA', 'varchar', 12, many(() => String(int(100000, 9999999))), 'UY_SALUD_IDENTIFICADOR'),
  col('COBERTURA_MEDICA', 'varchar', 30, many(() => pick(['ASSE', 'Mutualista (IAMC)', 'Sanidad Militar', 'Seguro privado integral'])), 'UY_SALUD_COBERTURA'),
  col('DIAGNOSTICO', 'varchar', 6, many(() => pick(['E11.9', 'I10', 'J45.9', 'F32.1'])), 'UY_SALUD_DIAGNOSTICO'),
  col('CAUSA_DEFUNCION', 'varchar', 6, many(() => pick(['I219', 'C509', 'X954', 'J189'])), 'UY_SALUD_DIAGNOSTICO'),
  col('CODIGO_PROCEDIMIENTO', 'varchar', 6, many(() => String(int(10000, 999999))), 'UY_SALUD_PROCEDIMIENTO'),
  col('MEDICAMENTO', 'varchar', 40, many(() => pick(['Sertralina', 'Paracetamol', 'Metformina'])), 'UY_SALUD_MEDICAMENTO'),
  col('EVOLUCION', 'clob', 4000, many(() => `Paciente refiere dolor abdominal de ${int(1, 9)} días de evolución.`), 'UY_SALUD_TEXTO_CLINICO'),
  col('RESULTADO_EXAMEN', 'varchar', 12, many(() => pick(['Normal', 'Alterado'])), 'UY_SALUD_RESULTADO_EXAMEN'),
  col('PRUEBA_VIH', 'varchar', 12, many(() => pick(['Reactivo', 'No reactivo'])), 'UY_SALUD_VIH'),
  col('GRUPO_SANGUINEO', 'varchar', 4, many(() => pick(['A+', 'O-', 'AB+', 'O+'])), 'UY_SALUD_GRUPO_SANGUINEO'),
  col('TIPO_DISCAPACIDAD', 'varchar', 40, many(() => pick(['Física o motriz', 'Visual', 'Auditiva', 'Ninguna'])), 'UY_SALUD_DISCAPACIDAD'),
  col('CARNE_SALUD', 'varchar', 30, many(() => pick(['Apto', 'No apto'])), 'UY_SALUD_OCUPACIONAL'),
  col('GESTANTE', 'char', 1, many(() => pick(['S', 'N'])), 'UY_SALUD_REPRODUCTIVA'),
  col('TRASTORNO_MENTAL', 'varchar', 60, many(() => pick(['Depresión', 'Ansiedad'])), 'UY_SALUD_MENTAL'),

  // FIN
  col('CLEARING_DE_INFORMES', 'varchar', 40, many(() => pick(['Al día', 'Categoría 3 — riesgo alto', 'Castigado'])), 'UY_FIN_HISTORIAL_CREDITICIO'),
  col('SALDO_DEUDA', 'number', 12, many(() => String(int(5000, 2000000))), 'UY_FIN_DEUDA'),
  col('SUELDO_NOMINAL', 'number', 10, many(() => String(int(22000, 200000))), 'UY_FIN_INGRESOS'),
  col('VALOR_TASACION', 'number', 12, many(() => String(int(100000, 9000000))), 'UY_FIN_PATRIMONIO'),
  col('MONTO_PASIVIDAD', 'number', 10, many(() => String(int(15000, 120000))), 'UY_FIN_PENSION'),
  col('BENEFICIARIO_TUS', 'char', 1, many(() => pick(['S', 'N'])), 'UY_FIN_PROGRAMA_SOCIAL'),
  col('NIVEL_SOCIOECONOMICO', 'varchar', 30, many(() => pick(['Quintil 1', 'Bajo la línea de pobreza', 'Quintil 4'])), 'UY_FIN_NIVEL_SOCIOECONOMICO'),
  col('TENENCIA_VIVIENDA', 'varchar', 50, many(() => pick(['Inquilino o arrendatario', 'Ocupante gratuito', 'Propietario de la vivienda y el terreno'])), 'UY_FIN_VIVIENDA'),

  // PENAL
  col('ANTECEDENTES_JUDICIALES', 'varchar', 60, many(() => pick(['No registra antecedentes judiciales', 'Registra antecedentes'])), 'UY_PENAL_ANTECEDENTES'),
  col('IUE', 'varchar', 20, many(() => `${int(1, 999)}-${int(1, 99999)}/${int(2015, 2026)}`), 'UY_PENAL_EXPEDIENTE'),

  // Not personal data: nothing should be assigned
  col('ID', 'integer', 10, many((i) => String(i + 1)), ''),
  col('RUTA_ARCHIVO', 'varchar', 200, many(() => `/datos/archivo${int(1, 99)}.txt`), ''),
  col('NOMBRE_PRODUCTO', 'varchar', 80, many(() => pick(['Yerba mate 1 kg', 'Dulce de leche 400 g', 'Café molido 250 g'])), ''),
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
  col('DEPARTAMENTO', 'varchar', 30, many(() => pick(['Montevideo', 'Canelones', 'Maldonado', 'Salto'])), ''),
  col('COD_BANCO', 'varchar', 4, many(() => pick(['0001', '0091', '0128'])), ''),
  col('URL_PAGINA', 'varchar', 200, many(() => `https://www.ejemplo.com.uy/p/${int(1, 999)}`), ''),
  col('TIPO_DOCUMENTO', 'varchar', 4, many(() => pick(['CI', 'RUT', 'PAS', 'CE'])), ''),
  col('MONEDA', 'varchar', 3, many(() => pick(['UYU', 'USD', 'UI'])), ''),
  col('CATEGORIA', 'varchar', 30, many(() => pick(['Almacén', 'Panadería'])), ''),
  col('CODIGO_CIIU', 'varchar', 4, many(() => pick(['4711', '6201', '8621'])), ''),
  col('IDIOMA_INTERFAZ', 'varchar', 5, many(() => pick(['es-UY', 'en', 'es'])), ''),
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
  // The essential pack has no domain for the barrio, and nothing else claims it: the column is
  // left alone, which is what the pack is for.
  const ALSO = {}
  const packPassed = profile(pack, (c) => (essential.has(c.expect) ? c.expect : (ALSO[c.name] ?? '')), 'essential pack, ')
  console.log(`profiled ${COLUMNS.length} columns with the essential pack (${pack.length} classifiers): ${packPassed} as expected`)
}

// ── Localidades, offline ────────────────────────────────────────────────────
//
// Every localidad of under 20,000 inhabitants must become one of at least 20,000 of the same
// departamento, written with its departamento and by its INE code; by its name alone, unless the
// name is shared with a large localidad or with a departamento. Every departamento has a target, so
// a generalized value never leaves its departamento.

const readTable = (name) => new Map(fs.readFileSync(nodePath.join(HERE, 'files', name), 'utf8').split('\n').filter(Boolean).map((l) => l.split('|')))

function verifyGeneralization() {
  const table = readTable('uy-localidades-generalizadas.txt')
  const codes = readTable('uy-codigos-ine-generalizados.txt')
  const byCode = new Map(LOCALIDADES.map((l) => [l.code, l]))
  const key = (n) => fold(n).toLowerCase()
  const byName = new Map()
  for (const l of LOCALIDADES) byName.set(key(l.name), [...(byName.get(key(l.name)) ?? []), l])
  const largeNames = new Set(LARGE_NAMES)
  let ok = 0
  let shared = 0
  let sharedWithDepartment = 0
  let shown = 0
  for (const l of LOCALIDADES) {
    const problems = []
    const withDepartment = table.get(`${l.name} - ${l.department}`)
    const alone = table.get(l.name)
    const code = codes.get(l.code)
    const homonyms = byName.get(key(l.name))
    // A name that is also a departamento is left alone: rewriting it would corrupt a departamento
    // column. Every localidad in that position is itself above the threshold.
    const isDepartmentName = DEPARTMENT_NAMES.has(key(l.name))
    if (l.population >= 20000) {
      if (withDepartment || alone || code) problems.push('a large localidad is generalized')
    } else {
      if (homonyms.length > 1) shared++
      if (isDepartmentName) {
        sharedWithDepartment++
        if (alone) problems.push('a name shared with a departamento is generalized')
      } else {
        if (homonyms.some((x) => x.population >= 20000 && x.departmentCode === l.departmentCode)) { if (withDepartment) problems.push('a name shared with a large localidad of its departamento is generalized') }
        else if (!withDepartment || !withDepartment.endsWith(` - ${l.department}`) || !largeNames.has(withDepartment.slice(0, -` - ${l.department}`.length))) problems.push(`with its departamento: ${withDepartment ?? 'not in the table'}`)
        if (homonyms.some((x) => x.population >= 20000)) { if (alone) problems.push('a name shared with a large localidad is generalized') }
        else if (!alone || !largeNames.has(alone)) problems.push(`by name: ${alone ?? 'not in the table'}`)
      }
      const target = code && byCode.get(code)
      if (!target || target.population < 20000) problems.push(`INE code ${l.code} → ${code}`)
      else if (target.departmentCode !== l.departmentCode) problems.push(`the code left its departamento: ${code}`)
    }
    if (problems.length) { failures++; if (shown++ < 15) console.log(`  ✗ ${l.name}/${l.department} (${l.population}): ${problems.join('; ')}`) }
    else ok++
  }
  console.log(`localidades: ${ok} of ${LOCALIDADES.length} generalized as expected (${shared} small ones share a name, ${sharedWithDepartment} carry a departamento's name)`)

  // Every departamento must hold a target, and no departamento may be generalized.
  let depOk = 0
  for (const d of DEPARTAMENTOS) {
    const problems = []
    if (!LOCALIDADES.some((l) => l.departmentCode === d.code && l.population >= 20000)) problems.push('no localidad of 20,000')
    if (table.get(d.name)) problems.push('a departamento is generalized')
    if (codes.get(d.code)) problems.push('a departamento code is generalized')
    if (problems.length) { failures++; console.log(`  ✗ departamento ${d.name} (${d.population}): ${problems.join('; ')}`) }
    else depOk++
  }
  console.log(`departamentos: ${depOk} of ${DEPARTAMENTOS.length} kept, each with a target of its own`)
}

// ── Algorithms ──────────────────────────────────────────────────────────────

const words = (s) => s.trim().split(/\s+/).length
const sameShape = (i, o) => i.length === o.length && i.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9') === o.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9')
const digitShape = (i, o) => i.length === o.length && i.replace(/\d/g, '9') === o.replace(/\d/g, '9')
const MASKING = {
  UY_L1_CEDULA: {
    inputs: ['1.234.567-2', '12345672', '211003420017', ...many(cedula, 8), ...many(cedulaPlain, 4)],
    check: (i, o) => (i.replace(/\D/g, '').length === 12 ? validRut(o) : validCedula(o) && digitShape(i, o)),
  },
  UY_L1_RUT: { inputs: ['211003420017', ...many(rut, 10)], check: (i, o) => validRut(o) && o.slice(0, 2) === i.slice(0, 2) && o.slice(8, 11) === i.slice(8, 11) },
  UY_L1_DOCUMENTO_EXTRANJERO: { inputs: ['R123456'], check: sameShape },
  UY_L1_PASAPORTE: { inputs: ['A123456'], check: sameShape },
  UY_L1_CREDENCIAL_CIVICA: { inputs: ['ABC 12345', 'DAA12345'], check: sameShape },
  UY_L1_PARTIDA: { inputs: ['123/1985'], check: sameShape },
  UY_L1_SEGURO_SOCIAL: { inputs: ['123456789'], check: sameShape },
  UY_L1_CODIGO_ESTUDIANTE: { inputs: ['202012345'], check: sameShape },
  UY_L1_MATRICULA_PROFESIONAL: { inputs: ['MP-12345'], check: sameShape },
  UY_L1_NOMBRE: { inputs: ['Washington', 'JUAN PABLO', 'María de los Ángeles'], check: (i, o) => words(i) === words(o) && (!/ de /.test(i) || / de /.test(o)) },
  UY_L1_APELLIDO: { inputs: ['Rodríguez', 'TECHERA SOSA', 'Da Silva'], check: (i, o) => words(i) === words(o) },
  UY_L1_NOMBRE_COMPLETO: {
    inputs: ['Serrana Rodríguez', 'JUAN PABLO RODRÍGUEZ', 'Juan Pablo Rodríguez Techera', 'María de los Ángeles Sosa Píriz', 'RODRÍGUEZ TECHERA, JUAN PABLO'],
    check: (i, o) => words(i) === words(o) && [' de ', ' de los '].every((w) => i.includes(w) === o.includes(w)),
  },
  UY_L1_RAZON_SOCIAL: { inputs: ['Corporación Comercial Oriental S.A.'] },
  UY_L1_EMAIL: { inputs: ['serrana.rodriguez@gmail.com', 'josé.muñoz@empresa.com.uy'], check: (i, o) => /@[^@]+\.test$/.test(o) },
  UY_L1_TELEFONO: {
    inputs: ['+598 99 123 456', '099123456', '2 400 12 34', '098765432'],
    // The country code, the 9 of a mobile and the area code stay, and the length does too.
    check: (i, o) => digitShape(i, o) && o.replace(/\D/g, '').slice(-9)[0] === i.replace(/\D/g, '').slice(-9)[0] && o !== i,
  },
  UY_L1_DIRECCION: { inputs: ['Av. 18 de Julio 1234 apto. 501', 'Ruta 5 km 120'] },
  UY_L1_DIRECCION_COMPLEMENTO: { inputs: ['apto. 501', 'Torre B'] },
  UY_L1_CUENTA_BANCARIA: { inputs: ['001234567890'], check: digitShape },
  UY_L1_TARJETA: { inputs: ['4093 8200 0000 0001'] },
  UY_L1_BILLETERA: { inputs: ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'], check: sameShape },
  UY_L1_IP: { inputs: ['164.73.45.12', '2800:a4:1a::1'], check: (i, o) => (i.includes('.') ? o.split('.').every((p) => Number(p) >= 1 && Number(p) <= 254) : /^[0-9a-f:]+$/i.test(o)) },
  UY_L1_DISPOSITIVO: { inputs: ['3c:22:fb:9a:10:e4', '356938035643809'], check: (i, o) => (i.includes(':') ? /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(o) : /^\d{15}$/.test(o)) },
  UY_L1_COOKIE: { inputs: ['GA1.2.123456789.1700000000'], check: sameShape },
  UY_L1_PLACA: { inputs: ['SAB 1234', 'ABC-1234'], check: sameShape },
  UY_L1_VEHICULO: { inputs: ['8AJHA8CD3J1234567'], check: sameShape },
  UY_L1_INMUEBLE: { inputs: ['12345'], check: sameShape },
  UY_L1_CONTRATO: { inputs: ['CT-123456'] },
  UY_L1_USUARIO: { inputs: ['@serrana_rodriguez'] },
  UY_L1_CREDENCIAL: { inputs: ['Clave#2024'], check: (i, o) => /^X+$/.test(o) },
  UY_L1_GEOLOCALIZACION: { inputs: ['-34.903280', '-34.903280,-56.188160'], check: (i, o) => o.slice(0, 5) === i.slice(0, 5) },
  UY_L1_TEXTO_LIBRE: {
    inputs: ['Cliente Rodríguez, CI 1.234.567-2, correo s.rodriguez@gmail.com, cel 099123456.'],
    check: (i, o) => !/1\.234\.567-2|s\.rodriguez@gmail\.com|099123456|Rodríguez/.test(o),
  },
  UY_L2_FECHA_NACIMIENTO: { inputs: ['1985-07-20', '2012-01-15'], check: (i, o) => Math.abs(new Date(o.slice(0, 10)) - new Date(i)) <= 60 * 864e5 },
  UY_L2_ANIO_NACIMIENTO: { inputs: ['1985'], check: (i, o) => o.startsWith('198'), same: true },
  UY_L2_EDAD: { inputs: ['37', '7', '104'], check: (i, o) => (i === '104' ? o === '90' : i.length === 1 || o[0] === i[0]), same: true },
  UY_L2_FECHA_EVENTO: { inputs: ['2021-03-15'] },
  UY_L2_SEXO: { inputs: ['F', 'M', 'Femenino', 'masculino', 'Hombre', '1'], same: true },
  UY_L2_LOCALIDAD: { inputs: ['Baltasar Brum', 'Montevideo', 'SALTO', 'Piriápolis - Maldonado', 'Santa Lucía', 'Las Piedras'], same: true },
  UY_L2_CODIGO_INE: { inputs: ['02621', '02020'], same: true },
  UY_L2_BARRIO: { inputs: ['Pocitos'], same: true },
  UY_L2_CODIGO_POSTAL: { inputs: ['11300'], check: (i, o) => o === '11000' },
  UY_L2_ESTADO_CIVIL: { inputs: ['Unión concubinaria', '2'], same: true },
  UY_L2_OCUPACION: { inputs: ['Gerente de operaciones', '2221'] },
  UY_L2_EMPLEADOR: { inputs: ['Corporación Comercial Oriental S.A.'] },
  UY_L2_NIVEL_EDUCATIVO: { inputs: ['Educación terciaria en curso', '7'], same: true },
  UY_L2_INSTITUCION_EDUCATIVA: { inputs: ['Universidad de la República'] },
  UY_L2_PERSONAS_A_CARGO: { inputs: ['9', '2'], check: (i, o) => Number(o) <= 5, same: true },
  UY_L3_ASCENDENCIA: { inputs: ['Afrodescendiente', '3', 'N'], same: true },
  UY_L3_PUEBLO_ORIGINARIO: { inputs: ['Pueblo originario'], same: true },
  UY_L3_NACIONALIDAD: { inputs: ['Panameña'], same: true },
  UY_L3_RELIGION: { inputs: ['Ortodoxa', 'N'], same: true },
  UY_L3_CONVICCION_MORAL: { inputs: ['Se niega a transfusiones'] },
  UY_L3_PREFERENCIA_POLITICA: { inputs: ['Oficialista'], same: true },
  UY_L3_AFILIACION_PARTIDARIA: { inputs: ['Partido Socialista', 'S'], same: true },
  UY_L3_AFILIACION_SINDICAL: { inputs: ['SUNCA', 'S'], same: true },
  UY_L3_BIOMETRICO: { inputs: ['A1B2C3D4E5F6'] },
  UY_L3_GENETICO: { inputs: ['BRCA1 positivo'] },
  UY_L3_ORIENTACION_SEXUAL: { inputs: ['Homosexual'], same: true },
  UY_L3_VIDA_SEXUAL: { inputs: ['Activa'] },
  UY_L3_IDENTIDAD_GENERO: { inputs: ['Transgénero'], same: true },
  UY_L3_VICTIMA: { inputs: ['Violencia doméstica', 'S'], same: true },
  UY_SALUD_IDENTIFICADOR: { inputs: ['HC-2024-00123'] },
  UY_SALUD_COBERTURA: { inputs: ['ASSE', '12345'], same: true },
  UY_SALUD_DIAGNOSTICO: { inputs: ['F33.1', 'B24X', 'E119', 'Depresión mayor'], same: true },
  UY_SALUD_PROCEDIMIENTO: { inputs: ['901234', 'Prueba de carga viral para VIH'], same: true },
  UY_SALUD_MEDICAMENTO: { inputs: ['Sertralina 50 mg'] },
  UY_SALUD_TEXTO_CLINICO: { inputs: ['Paciente Rodríguez, CI 1.234.567-2, consulta por cefalea.'], check: (i, o) => !o.includes('1.234.567-2') },
  UY_SALUD_RESULTADO_EXAMEN: { inputs: ['Reactivo'] },
  UY_SALUD_VIH: { inputs: ['Reactivo', 'S'], same: true },
  UY_SALUD_GRUPO_SANGUINEO: { inputs: ['O+'], same: true },
  UY_SALUD_DISCAPACIDAD: { inputs: ['Trastorno del espectro autista', 'N'], same: true },
  UY_SALUD_OCUPACIONAL: { inputs: ['No apto temporalmente', 'S'], same: true },
  UY_SALUD_REPRODUCTIVA: { inputs: ['12 semanas de gestación', 'S'], same: true },
  UY_SALUD_MENTAL: { inputs: ['Trastorno bipolar'] },
  UY_FIN_HISTORIAL_CREDITICIO: { inputs: ['Informado en el Clearing de Informes', '745', 'N'], same: true },
  UY_FIN_DEUDA: { inputs: ['184000'] },
  UY_FIN_INGRESOS: { inputs: ['65000'] },
  UY_FIN_PATRIMONIO: { inputs: ['3400000'] },
  UY_FIN_PENSION: { inputs: ['32000'] },
  UY_FIN_PROGRAMA_SOCIAL: { inputs: ['Plan de emergencia', 'S'], same: true },
  UY_FIN_NIVEL_SOCIOECONOMICO: { inputs: ['Bajo la línea de pobreza', '2'], same: true },
  UY_FIN_VIVIENDA: { inputs: ['Ocupación de hecho'], same: true },
  UY_PENAL_ANTECEDENTES: { inputs: ['Condenado por hurto en 2019', 'S'], same: true },
  UY_PENAL_EXPEDIENTE: {
    inputs: ['2-12345/2024', '1234/2023', 'PN-456-2022'],
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
const PARTICLE = /^(de|del|la|las|los|y|e|da|do|dos|san|santa)$/i
const EXPECT = {
  UY_L1_NOMBRE: (i, o) => o.split(/\s+/).every((w) => PARTICLE.test(w) || has('uy-nombres.txt', w)),
  UY_L1_APELLIDO: (i, o) => o.split(/\s+/).every((w) => PARTICLE.test(w) || has('uy-apellidos.txt', w)),
  UY_L1_NOMBRE_COMPLETO: (i, o) => i.includes(',') || (has('uy-nombres.txt', o.split(/\s+/)[0]) && has('uy-apellidos.txt', o.split(/\s+/).at(-1))),
  UY_L1_RAZON_SOCIAL: (i, o) => has('uy-razones-sociales.txt', o),
  UY_L1_DIRECCION: (i, o) => has('uy-direcciones.txt', o),
  UY_L2_SEXO: (i, o) => ({ f: ['f', 'm'], m: ['f', 'm'], femenino: ['femenino', 'masculino'], masculino: ['femenino', 'masculino'], hombre: ['mujer', 'hombre'], 1: ['1', '2'] })[i.toLowerCase()].includes(o.toLowerCase()),
  // Baltasar Brum, Piriápolis and Santa Lucía are small and become large localidades; Montevideo,
  // Salto and Las Piedras stay; Piriápolis written with its departamento keeps that shape.
  UY_L2_LOCALIDAD: (i, o) => ({
    Montevideo: o === 'Montevideo',
    SALTO: o === 'SALTO',
    'Las Piedras': o === 'Las Piedras',
    'Piriápolis - Maldonado': / - Maldonado$/.test(o) && LARGE.has(o.replace(/ - Maldonado$/, '').toLowerCase()),
  })[i] ?? LARGE.has(o.toLowerCase()),
  UY_L2_CODIGO_INE: (i, o) => (i === '02020' ? o === i : o.length === i.length && o.slice(0, 2) === i.slice(0, 2) && o !== i),
  UY_L2_BARRIO: (i, o) => has('uy-barrios.txt', o),
  UY_L3_NACIONALIDAD: (i, o) => has('uy-nacionalidades.txt', o),
  UY_L2_ESTADO_CIVIL: (i, o) => (/^\d$/.test(i) ? /^[1-6]$/.test(o) : has('uy-estado-civil.txt', o)),
  UY_L2_OCUPACION: (i, o) => (/^\d+$/.test(i) ? /^\d{4}$/.test(o) : has('uy-ocupaciones.txt', o)),
  UY_L2_EMPLEADOR: (i, o) => has('uy-empleadores.txt', o),
  UY_L2_NIVEL_EDUCATIVO: (i, o) => (/^\d+$/.test(i) ? has('uy-nivel-educativo-codigos.txt', o) : has('uy-nivel-educativo.txt', o)),
  UY_L2_INSTITUCION_EDUCATIVA: (i, o) => has('uy-instituciones-educativas.txt', o),
  UY_L3_ASCENDENCIA: (i, o) => flag(i, o) ?? (/^\d$/.test(i) ? has('uy-ascendencia-codigos.txt', o) : has('uy-ascendencia.txt', o)),
  UY_L3_PUEBLO_ORIGINARIO: (i, o) => has('uy-pueblos.txt', o),
  UY_L3_RELIGION: (i, o) => flag(i, o) ?? has('uy-religiones.txt', o),
  UY_L3_CONVICCION_MORAL: (i, o) => o === SUPPRESSED,
  UY_L3_PREFERENCIA_POLITICA: (i, o) => has('uy-preferencias-politicas.txt', o),
  UY_L3_AFILIACION_PARTIDARIA: (i, o) => flag(i, o) ?? has('uy-partidos.txt', o),
  UY_L3_AFILIACION_SINDICAL: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  UY_L3_ORIENTACION_SEXUAL: (i, o) => has('uy-orientaciones-sexuales.txt', o),
  UY_L3_VIDA_SEXUAL: (i, o) => o === SUPPRESSED,
  UY_L3_IDENTIDAD_GENERO: (i, o) => has('uy-identidades-genero.txt', o),
  UY_L3_VICTIMA: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  UY_SALUD_COBERTURA: (i, o) => (/^\d+$/.test(i) ? digitShape(i, o) : has('uy-cobertura-salud.txt', o)),
  UY_SALUD_DIAGNOSTICO: (i, o) => (/^[A-Z]\d/.test(i) ? has(i.includes('.') ? 'uy-cie10-decimal.txt' : 'uy-cie10.txt', o) : has('uy-diagnosticos.txt', o)),
  UY_SALUD_PROCEDIMIENTO: (i, o) => (/^\d+$/.test(i) ? digitShape(i, o) : has('uy-procedimientos.txt', o)),
  UY_SALUD_MEDICAMENTO: (i, o) => has('uy-medicamentos.txt', o),
  UY_SALUD_VIH: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  UY_SALUD_GRUPO_SANGUINEO: (i, o) => has('uy-grupos-sanguineos.txt', o),
  UY_SALUD_DISCAPACIDAD: (i, o) => flag(i, o) ?? has('uy-discapacidades.txt', o),
  UY_SALUD_OCUPACIONAL: (i, o) => flag(i, o) ?? has('uy-aptitud-laboral.txt', o),
  UY_SALUD_REPRODUCTIVA: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  UY_SALUD_MENTAL: (i, o) => o === SUPPRESSED,
  UY_FIN_HISTORIAL_CREDITICIO: (i, o) => flag(i, o) ?? (/^\d+$/.test(i) ? digitShape(i, o) : has('uy-estados-credito.txt', o)),
  UY_FIN_PROGRAMA_SOCIAL: (i, o) => flag(i, o) ?? has('uy-programas-sociales.txt', o),
  UY_FIN_NIVEL_SOCIOECONOMICO: (i, o) => flag(i, o) ?? (/^\d$/.test(i) ? has('uy-nivel-socioeconomico-codigos.txt', o) : has('uy-nivel-socioeconomico.txt', o)),
  UY_FIN_VIVIENDA: (i, o) => has('uy-tenencia-vivienda.txt', o),
  UY_PENAL_ANTECEDENTES: (i, o) => flag(i, o) ?? has('uy-antecedentes.txt', o),
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
  const TYPED = new Set(['UY_L2_FECHA_NACIMIENTO', 'UY_L2_FECHA_EVENTO', 'UY_FIN_DEUDA', 'UY_FIN_INGRESOS', 'UY_FIN_PATRIMONIO', 'UY_FIN_PENSION'])
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

  // Cédulas stay cédulas: 200 distinct inputs give 200 distinct valid outputs, dots and hyphen kept.
  const cedulas = [...new Set(many(cedula, 200))]
  const out = new Set()
  let bad = 0
  let i = 0
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < cedulas.length) {
      const { output } = await run('UY_CEDULA', cedulas[i++])
      out.add(output)
      if (!output || !validCedula(output) || !/^\d\.\d{3}\.\d{3}-\d$/.test(output)) bad++
    }
  }))
  if (out.size !== cedulas.length || bad) { failures++; console.log(`  ✗ cédula: ${cedulas.length} inputs gave ${out.size} distinct outputs, ${bad} invalid or reshaped`) }
  else console.log(`cédula: ${cedulas.length} distinct inputs, ${out.size} distinct valid outputs keeping their dots and hyphen`)

  // RUTs: the kind of taxpayer and the branch stay, the number changes and the digit is recomputed.
  const ruts = [...new Set(many(rut, 200))]
  const rutOut = new Set()
  let rutBad = 0
  let kept = 0
  let hardCase = 0
  let j = 0
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (j < ruts.length) {
      const input = ruts[j++]
      const { output } = await run('UY_RUT', input)
      rutOut.add(output)
      if (!output || !validRut(output)) { rutBad++; continue }
      if (output.slice(0, 2) === input.slice(0, 2) && output.slice(8, 11) === input.slice(8, 11)) kept++
      // The remainder the plain Check Digit gets wrong: the auxiliary has to catch it.
      if ([...output.slice(0, 11)].reduce((a, d, x) => a + Number(d) * RUT_WEIGHTS[x], 0) % 11 <= 1) hardCase++
    }
  }))
  if (rutOut.size !== ruts.length || rutBad || kept !== ruts.length || hardCase < 5) {
    failures++
    console.log(`  ✗ RUT: ${ruts.length} inputs gave ${rutOut.size} distinct outputs, ${rutBad} invalid, ${kept} kept kind and branch, ${hardCase} exercised the auxiliary`)
  } else console.log(`RUT: ${ruts.length} distinct inputs, ${rutOut.size} distinct valid outputs, all keeping their kind and branch (${hardCase} exercised the auxiliary digit)`)
}

if (only !== 'algorithms') { verifyClassifiers(); verifyGeneralization() }
if (only !== 'classifiers') await verifyAlgorithms()
console.log(failures ? `\n${failures} problem(s)` : '\nall good')
process.exit(failures ? 1 : 0)
