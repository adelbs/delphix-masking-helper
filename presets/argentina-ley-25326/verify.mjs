#!/usr/bin/env node
/**
 * Checks the Argentina (Ley 25.326) preset.
 *
 *   node presets/argentina-ley-25326/verify.mjs               # classifiers, then algorithms
 *   node presets/argentina-ley-25326/verify.mjs classifiers   # only the local profiling check
 *   node presets/argentina-ley-25326/verify.mjs algorithms    # only masking, against the app
 *
 * Classifiers run through classifiers/, the same evaluator the classifier test uses: every
 * configuration is reviewed, then a battery of columns — well named, badly named and unrelated —
 * is profiled with the whole set at its threshold. The tables that generalize departamentos,
 * gobiernos locales and localidades are audited offline. Algorithms run in the app (DLPX_URL,
 * default http://localhost:3000), which needs the Delphix jars in lib/; every CUIT and CBU they
 * write is checked against its check-digit rule.
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

const CUIT_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
const cuitRemainder = (body) => [...body].reduce((s, d, i) => s + Number(d) * CUIT_WEIGHTS[i], 0) % 11
/** The CUIT for a type and eight digits, or null when the remainder is 1 and the type must change. */
const cuitOf = (type, number) => { const r = cuitRemainder(`${type}${number}`); return r === 1 ? null : `${type}${number}${r === 0 ? 0 : 11 - r}` }
const validCuit = (v) => {
  const d = v.replace(/[\s\-./]/g, '')
  if (!/^(20|23|24|27|30|33|34)\d{9}$/.test(d)) return false
  const r = cuitRemainder(d.slice(0, 10))
  return r !== 1 && Number(d[10]) === (r === 0 ? 0 : 11 - r)
}
const mod10 = (s, weights) => (10 - ([...s].reduce((a, d, i) => a + Number(d) * weights[i], 0) % 10)) % 10
const CBU_BANK = [7, 1, 3, 9, 7, 1, 3]
const CBU_ACCOUNT = [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3]
const validCbu = (v) => { const d = v.replace(/[\s\-]/g, ''); return /^\d{22}$/.test(d) && Number(d[7]) === mod10(d.slice(0, 7), CBU_BANK) && Number(d[21]) === mod10(d.slice(8, 21), CBU_ACCOUNT) }

// ── Test data ───────────────────────────────────────────────────────────────

let seed = 25326
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
const DEPARTAMENTOS = source('departamentos.tsv').map((l) => { const [code, name, provinceCode, province, , , population, aliases] = l.split('\t'); return { code, name, provinceCode, province, population: Number(population), aliases: aliases ? aliases.split('|') : [] } })
const GOBIERNOS = source('gobiernos-locales.tsv').map((l) => { const [code, name, , provinceCode, province, , , population, aliases] = l.split('\t'); return { code, name, provinceCode, province, population: Number(population), aliases: aliases ? aliases.split('|') : [] } })
const gobiernoByCode = new Map(GOBIERNOS.map((g) => [g.code, g]))
const PROVINCE_OF = new Map(DEPARTAMENTOS.map((d) => [d.provinceCode, d.province]))
const LOCALIDADES = source('localidades.tsv').map((l) => {
  const [code, name, provinceCode, , localGovernment] = l.split('\t')
  const g = gobiernoByCode.get(localGovernment)
  return { code, name, provinceCode, province: PROVINCE_OF.get(provinceCode), localGovernment, population: g ? g.population : 0, aliases: [] }
})
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '')
const PERSONAL = new Set([...GIVEN, ...SURNAMES].map((w) => fold(w).toLowerCase()))
const SMALL_GOBIERNOS = GOBIERNOS.filter((g) => g.population < 20000 && !PERSONAL.has(fold(g.name).toLowerCase())).map((g) => g.name)
const SMALL_DEPARTAMENTOS = DEPARTAMENTOS.filter((d) => d.population < 20000 && !PERSONAL.has(fold(d.name).toLowerCase())).map((d) => d.name)

const pad = (n, w) => String(n).padStart(w, '0')
const digits = (n) => many(() => int(0, 9), n).join('')
const dots = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
const dni = () => String(pick([int(5000000, 49999999), int(92000000, 96999999)]))
const cuit = (types = ['20', '27', '23', '30', '33']) => { for (;;) { const c = cuitOf(pick(types), pad(pick([dni(), `${int(50000000, 71999999)}`]), 8)); if (c) return c } }
const dashed = (c) => `${c.slice(0, 2)}-${c.slice(2, 10)}-${c[10]}`
const cbu = () => { const b = pick(['0110', '0070', '0170', '0285', '0000003']).padEnd(7, String(int(0, 9))).slice(0, 7); const a = digits(13); return `${b}${mod10(b, CBU_BANK)}${a}${mod10(a, CBU_ACCOUNT)}` }
const luhn = (prefix, length) => {
  const ds = [...prefix].map(Number)
  while (ds.length < length - 1) ds.push(int(0, 9))
  const sum = ds.slice().reverse().reduce((s, d, i) => s + (i % 2 === 0 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0)
  return ds.join('') + String((10 - (sum % 10)) % 10)
}
const iso = (y0, y1) => `${int(y0, y1)}-${pad(int(1, 12), 2)}-${pad(int(1, 28), 2)}`
const fullName = () => `${pick(GIVEN)}${random() < 0.4 ? ` ${pick(GIVEN)}` : ''} ${pick(SURNAMES)}`
const mobile = () => pick([`+54 9 11 ${int(2000, 6999)}-${int(1000, 9999)}`, `11${int(20000000, 69999999)}`, `(0351) 15-${int(400, 699)}-${int(1000, 9999)}`, `+549341${int(4000000, 6999999)}`, `011 ${int(4000, 4999)}-${int(1000, 9999)}`])
const landline = () => pick([`(011) ${int(4000, 4999)}-${int(1000, 9999)}`, `0261 ${int(420, 499)}-${int(1000, 9999)}`, `${int(4000, 4999)}-${int(1000, 9999)}`])
const STREETS = ['San Martín', 'Belgrano', 'Rivadavia', 'Sarmiento', 'Mitre', 'Av. Corrientes', 'Av. Santa Fe', '9 de Julio', 'Güemes', 'Alsina']
const address = () => pick([`${pick(STREETS)} ${int(100, 5999)}`, `${pick(STREETS)} ${int(100, 5999)} Piso ${int(1, 12)} Dto. ${pick(['A', 'B', 'C'])}`, `Calle ${int(1, 150)} N° ${int(100, 2000)}`, `Mz. ${int(1, 40)} Lote ${int(1, 30)}`])
const letters = (n) => many(() => pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), n).join('')
const plate = () => pick([`${letters(2)} ${int(100, 999)} ${letters(2)}`, `${letters(3)} ${int(100, 999)}`, `${letters(2)}${int(100, 999)}${letters(2)}`, `${letters(1)}${int(100, 999)}${letters(3)}`])

// ── Classifiers ─────────────────────────────────────────────────────────────

const SQL = { varchar: 12, char: 1, number: 2, integer: 4, date: 91, timestamp: 93, clob: 2005 }
const col = (name, type, length, values, expect) => ({ name, sqlType: SQL[type], length, values, expect })

const COLUMNS = [
  // L1 — well named
  col('NRO_DOCUMENTO', 'varchar', 12, many(() => dots(dni())), 'AR_L1_DNI'),
  col('DNI', 'number', 8, many(dni), 'AR_L1_DNI'),
  col('DNI_TITULAR', 'varchar', 10, many(dni), 'AR_L1_DNI'),
  col('LIBRETA_ENROLAMIENTO', 'varchar', 10, many(() => String(int(1000000, 8999999))), 'AR_L1_DNI'),
  col('CUIT', 'varchar', 13, many(() => dashed(cuit())), 'AR_L1_CUIT'),
  col('CUIL_EMPLEADO', 'varchar', 11, many(() => cuit(['20', '27', '23'])), 'AR_L1_CUIT'),
  col('NUMERO_TRAMITE', 'varchar', 11, many(() => `00${digits(9)}`), 'AR_L1_TRAMITE_DNI'),
  col('RESIDENCIA_PRECARIA', 'varchar', 20, many(() => `${int(100000, 999999)}/${int(2019, 2025)}`), 'AR_L1_DOCUMENTO_EXTRANJERO'),
  col('PASAPORTE', 'varchar', 10, many(() => `${letters(3)}${int(100000, 999999)}`), 'AR_L1_PASAPORTE'),
  col('ACTA_NACIMIENTO', 'varchar', 10, many(() => String(int(100, 99999))), 'AR_L1_REGISTRO_CIVIL'),
  col('MATRICULA_PROFESIONAL', 'varchar', 12, many(() => `MN ${int(10000, 150000)}`), 'AR_L1_MATRICULA_PROFESIONAL'),
  col('PRIMER_NOMBRE', 'varchar', 30, many(() => pick(GIVEN)), 'AR_L1_NOMBRE'),
  col('NOMBRES', 'varchar', 60, many(() => `${pick(GIVEN)} ${pick(GIVEN)}`), 'AR_L1_NOMBRE'),
  col('APELLIDO', 'varchar', 30, many(() => pick(SURNAMES)), 'AR_L1_APELLIDO'),
  col('APELLIDO_Y_NOMBRE', 'varchar', 120, many(() => `${pick(SURNAMES).toUpperCase()}, ${pick(GIVEN).toUpperCase()}`), 'AR_L1_NOMBRE_COMPLETO'),
  col('APYNOM', 'varchar', 120, many(fullName), 'AR_L1_NOMBRE_COMPLETO'),
  col('NOMBRE_CLIENTE', 'varchar', 120, many(fullName), 'AR_L1_NOMBRE_COMPLETO'),
  col('NOMBRE', 'varchar', 120, many(fullName), 'AR_L1_NOMBRE_COMPLETO'),
  col('NOMBRE_TUTOR', 'varchar', 120, many(fullName), 'AR_L1_NOMBRE_COMPLETO'),
  col('RAZON_SOCIAL', 'varchar', 80, many(() => `${pick(['Distribuidora', 'Transportes', 'Agropecuaria'])} ${pick(SURNAMES)} ${pick(['S.A.', 'S.R.L.', 'S.A.S.'])}`), 'AR_L1_RAZON_SOCIAL'),
  col('MAIL', 'varchar', 100, many(() => `${fold(pick(GIVEN)).toLowerCase()}.${int(1, 999)}@gmail.com`), 'AR_L1_EMAIL'),
  col('CORREO_ELECTRONICO', 'varchar', 100, many(() => `contacto${int(1, 999)}@empresa.com.ar`), 'AR_L1_EMAIL'),
  col('CELULAR', 'varchar', 20, many(mobile), 'AR_L1_TELEFONO'),
  col('TEL_PARTICULAR', 'varchar', 16, many(landline), 'AR_L1_TELEFONO'),
  col('DOMICILIO', 'varchar', 120, many(address), 'AR_L1_DIRECCION'),
  col('CALLE_Y_NUMERO', 'varchar', 120, many(address), 'AR_L1_DIRECCION'),
  col('PISO', 'varchar', 4, many(() => String(int(1, 20))), 'AR_L1_DIRECCION_COMPLEMENTO'),
  col('CBU', 'varchar', 22, many(cbu), 'AR_L1_CBU'),
  col('CVU_DESTINO', 'varchar', 22, many(() => { const a = digits(13); return `0000003${mod10('0000003', CBU_BANK)}${a}${mod10(a, CBU_ACCOUNT)}` }), 'AR_L1_CBU'),
  col('ALIAS_CBU', 'varchar', 20, many(() => `${pick(['gato', 'mesa', 'sol', 'rio', 'luna'])}.${pick(['verde', 'azul', 'rojo'])}.${pick(['casa', 'mate', 'tango'])}`), 'AR_L1_ALIAS_CBU'),
  col('NRO_CUENTA', 'varchar', 16, many(() => `${int(100, 999)}-${digits(9)}/${int(0, 9)}`), 'AR_L1_CUENTA_BANCARIA'),
  col('NUMERO_TARJETA', 'varchar', 19, many(() => luhn('4', 16)), 'AR_L1_TARJETA'),
  col('IP_ORIGEN', 'varchar', 15, many(() => `${int(1, 223)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`), 'AR_L1_IP'),
  col('MAC_ADDRESS', 'varchar', 17, many(() => many(() => int(0, 255).toString(16).padStart(2, '0'), 6).join(':')), 'AR_L1_DISPOSITIVO'),
  col('IMEI', 'varchar', 15, many(() => luhn('35', 15)), 'AR_L1_DISPOSITIVO'),
  col('DOMINIO', 'varchar', 9, many(plate), 'AR_L1_DOMINIO'),
  col('PATENTE', 'varchar', 9, many(plate), 'AR_L1_DOMINIO'),
  col('NUMERO_CHASIS', 'varchar', 17, many(() => many(() => pick('ABCDEFGHJKLMNPRSTUVWXYZ0123456789'), 17).join('')), 'AR_L1_VEHICULO'),
  col('PARTIDA_INMOBILIARIA', 'varchar', 15, many(() => `${int(100, 135)}-${int(10000, 999999)}`), 'AR_L1_INMUEBLE'),
  col('LEGAJO', 'varchar', 10, many(() => String(int(1000, 99999))), 'AR_L1_CONTRATO'),
  col('USUARIO', 'varchar', 30, many(() => `${fold(pick(GIVEN)).toLowerCase()}${int(1, 99)}`), 'AR_L1_USUARIO'),
  col('CLAVE_FISCAL', 'varchar', 60, many(() => `$2a$10$${many(() => pick('abcdefghijklmnopqrstuvwxyz0123456789'), 53).join('')}`), 'AR_L1_CREDENCIAL'),
  col('LATITUD', 'varchar', 12, many(() => `-34.${int(100000, 999999)}`), 'AR_L1_GEOLOCALIZACION'),
  col('OBSERVACIONES', 'clob', 4000, many(() => `Cliente solicita actualizar datos. DNI ${dots(dni())}, correo ${fold(pick(GIVEN)).toLowerCase()}@gmail.com.`), 'AR_L1_TEXTO_LIBRE'),

  // L1 — badly named: only the values can tell
  col('CAMPO1', 'varchar', 12, many(() => dots(String(int(10000000, 45000000)))), 'AR_L1_DNI'),
  col('CAMPO2', 'varchar', 30, many(() => pick(GIVEN)), 'AR_L1_NOMBRE'),
  col('CAMPO3', 'varchar', 30, many(() => pick(SURNAMES)), 'AR_L1_APELLIDO'),
  col('CAMPO4', 'varchar', 120, many(fullName), 'AR_L1_NOMBRE_COMPLETO'),
  col('CAMPO5', 'varchar', 100, many(() => `${fold(pick(GIVEN)).toLowerCase()}@hotmail.com`), 'AR_L1_EMAIL'),
  col('CAMPO6', 'varchar', 20, many(() => `+54 9 11 ${int(2000, 6999)}-${int(1000, 9999)}`), 'AR_L1_TELEFONO'),
  col('CAMPO7', 'varchar', 120, many(() => `${pick(STREETS)} ${int(100, 5999)} Piso ${int(1, 12)} Dto. ${pick(['A', 'B'])}`), 'AR_L1_DIRECCION'),
  col('CAMPO8', 'varchar', 19, many(() => luhn('5', 16)), 'AR_L1_TARJETA'),
  col('CAMPO9', 'varchar', 15, many(() => `192.168.${int(0, 255)}.${int(1, 254)}`), 'AR_L1_IP'),
  col('CAMPO10', 'varchar', 9, many(() => `${letters(2)} ${int(100, 999)} ${letters(2)}`), 'AR_L1_DOMINIO'),
  col('CAMPO11', 'varchar', 13, many(() => dashed(cuit())), 'AR_L1_CUIT'),
  col('CAMPO12', 'varchar', 22, many(cbu), 'AR_L1_CBU'),
  col('CAMPO13', 'varchar', 60, many(() => `${pick(['Metalúrgica', 'Logística', 'Consultora'])} del ${pick(['Sur', 'Norte', 'Plata'])} S.R.L.`), 'AR_L1_RAZON_SOCIAL'),
  col('TXT', 'clob', 4000, many(() => `Paciente ${pick(GIVEN)} ${pick(SURNAMES)}, DNI ${dots(dni())}, cel 11${int(20000000, 69999999)}.`), 'AR_L1_TEXTO_LIBRE'),

  // L2
  col('FECHA_NACIMIENTO', 'date', 0, many(() => iso(1940, 2010)), 'AR_L2_FECHA_NACIMIENTO'),
  col('FEC_NAC', 'varchar', 10, many(() => iso(1940, 2010)), 'AR_L2_FECHA_NACIMIENTO'),
  col('fechaNacimiento', 'timestamp', 0, many(() => iso(1940, 2010)), 'AR_L2_FECHA_NACIMIENTO'),
  col('ANIO_NACIMIENTO', 'number', 4, many(() => String(int(1940, 2010))), 'AR_L2_ANIO_NACIMIENTO'),
  col('EDAD', 'number', 3, many(() => String(int(0, 99))), 'AR_L2_EDAD'),
  col('FECHA_DEFUNCION', 'date', 0, many(() => iso(2000, 2025)), 'AR_L2_FECHA_EVENTO'),
  col('FECHA_INGRESO', 'date', 0, many(() => iso(1990, 2025)), 'AR_L2_FECHA_EVENTO'),
  col('SEXO', 'char', 1, many(() => pick(['F', 'M', 'F', 'M', 'X'])), 'AR_L2_SEXO'),
  col('GENERO', 'varchar', 10, many(() => pick(['Femenino', 'Masculino'])), 'AR_L2_SEXO'),
  col('LOCALIDAD', 'varchar', 60, many(() => pick(SMALL_GOBIERNOS)), 'AR_L2_LOCALIDAD'),
  col('CIUDAD', 'varchar', 60, many(() => pick(['Rosario', 'Córdoba', 'Mar del Plata', 'Mendoza', 'Salta', 'San Miguel de Tucumán'])), 'AR_L2_LOCALIDAD'),
  col('LUGAR_NACIMIENTO', 'varchar', 60, many(() => pick(SMALL_GOBIERNOS)), 'AR_L2_LOCALIDAD'),
  col('CAMPO14', 'varchar', 60, many(() => pick(SMALL_GOBIERNOS)), 'AR_L2_LOCALIDAD'),
  col('PARTIDO', 'varchar', 40, many(() => pick(['La Matanza', 'Lomas de Zamora', 'Quilmes', 'Tigre', 'Pilar', 'Tordillo', 'General Guido'])), 'AR_L2_DEPARTAMENTO'),
  col('DEPARTAMENTO_GEOGRAFICO', 'varchar', 40, many(() => pick(SMALL_DEPARTAMENTOS)), 'AR_L2_DEPARTAMENTO'),
  col('COD_LOCALIDAD', 'varchar', 8, many(() => pick(LOCALIDADES).code), 'AR_L2_CODIGO_GEOGRAFICO'),
  col('CODIGO_POSTAL', 'varchar', 8, many(() => `${pick(['B', 'C', 'X', 'S'])}${int(1000, 9999)}${letters(3)}`), 'AR_L2_CODIGO_POSTAL'),
  col('CP', 'number', 4, many(() => String(int(1000, 9431))), 'AR_L2_CODIGO_POSTAL'),
  col('BARRIO', 'varchar', 40, many(() => pick(['Palermo', 'Caballito', 'Nueva Córdoba', 'Fisherton'])), 'AR_L2_BARRIO'),
  col('NACIONALIDAD', 'varchar', 20, many(() => pick(['Argentina', 'Paraguaya', 'Boliviana', 'Peruana'])), 'AR_L2_NACIONALIDAD'),
  col('ESTADO_CIVIL', 'varchar', 30, many(() => pick(['Soltero', 'Casada', 'Unión convivencial', 'Viudo'])), 'AR_L2_ESTADO_CIVIL'),
  col('PROFESION', 'varchar', 60, many(() => pick(['Docente', 'Chofer', 'Enfermera'])), 'AR_L2_OCUPACION'),
  col('NOMBRE_EMPLEADOR', 'varchar', 80, many(() => `Comercializadora ${int(1, 99)} S.A.`), 'AR_L2_EMPLEADOR'),
  col('NIVEL_EDUCATIVO', 'varchar', 40, many(() => pick(['Secundario completo', 'Universitario incompleto', 'Primario completo'])), 'AR_L2_NIVEL_EDUCATIVO'),
  col('NOMBRE_ESCUELA', 'varchar', 80, many(() => `Escuela N° ${int(1, 999)}`), 'AR_L2_ESTABLECIMIENTO_EDUCATIVO'),
  col('CANTIDAD_HIJOS', 'number', 2, many(() => String(int(0, 8))), 'AR_L2_PERSONAS_A_CARGO'),

  // L3
  col('PUEBLO_ORIGINARIO', 'varchar', 30, many(() => pick(['Mapuche', 'Guaraní', 'Qom', 'Wichí', 'Kolla'])), 'AR_L3_PUEBLO_INDIGENA'),
  col('AFRODESCENDIENTE', 'char', 1, many(() => pick(['S', 'N'])), 'AR_L3_ORIGEN_ETNICO'),
  col('CAMPO15', 'varchar', 60, many(() => pick(['Indígena', 'Afrodescendiente', 'Ninguno'])), 'AR_L3_ORIGEN_ETNICO'),
  col('LENGUA_INDIGENA', 'varchar', 30, many(() => pick(['Guaraní', 'Quechua', 'Mapuzungun', 'Wichí'])), 'AR_L3_LENGUA_INDIGENA'),
  col('RELIGION', 'varchar', 40, many(() => pick(['Católica', 'Evangélica', 'Sin religión'])), 'AR_L3_RELIGION'),
  col('OBJECION_CONCIENCIA', 'varchar', 60, many(() => pick(['Transfusiones', 'Ninguna'])), 'AR_L3_CONVICCION_FILOSOFICA'),
  col('INTENCION_VOTO', 'varchar', 40, many(() => pick(['Izquierda', 'Derecha', 'Centro'])), 'AR_L3_OPINION_POLITICA'),
  col('AFILIACION_PARTIDARIA', 'varchar', 60, many(() => pick(['Partido Justicialista', 'Unión Cívica Radical', 'PRO', 'La Libertad Avanza'])), 'AR_L3_AFILIACION_PARTIDARIA'),
  col('CUOTA_SINDICAL', 'char', 1, many(() => pick(['S', 'N'])), 'AR_L3_AFILIACION_SINDICAL'),
  col('GREMIO', 'varchar', 20, many(() => pick(['UOM', 'Comercio', 'UOCRA', 'Camioneros', 'ATE'])), 'AR_L3_AFILIACION_SINDICAL'),
  col('HUELLA_DACTILAR', 'varchar', 200, many(() => many(() => pick('ABCDEF0123456789'), 64).join('')), 'AR_L3_BIOMETRICO'),
  col('PERFIL_GENETICO', 'varchar', 200, many(() => 'AGTC'.repeat(10)), 'AR_L3_GENETICO'),
  col('ORIENTACION_SEXUAL', 'varchar', 30, many(() => pick(['Heterosexual', 'Gay', 'Bisexual'])), 'AR_L3_ORIENTACION_SEXUAL'),
  col('VIDA_SEXUAL_ACTIVA', 'char', 1, many(() => pick(['S', 'N'])), 'AR_L3_VIDA_SEXUAL'),
  col('IDENTIDAD_GENERO', 'varchar', 40, many(() => pick(['Mujer trans / travesti', 'Varón cis', 'No binario'])), 'AR_L3_IDENTIDAD_GENERO'),
  col('NOMBRE_AUTOPERCIBIDO', 'varchar', 60, many(() => pick(GIVEN)), 'AR_L1_NOMBRE'),
  col('GENERO_AUTOPERCIBIDO', 'varchar', 40, many(() => pick(['Mujer trans', 'Varón', 'No binario', 'Mujer'])), 'AR_L3_IDENTIDAD_GENERO'),
  col('VICTIMA_VIOLENCIA_GENERO', 'char', 1, many(() => pick(['S', 'N'])), 'AR_L3_VICTIMA'),

  // SALUD
  col('NRO_AFILIADO', 'varchar', 16, many(() => `${digits(11)}/${pad(int(0, 9), 2)}`), 'AR_SALUD_IDENTIFICADOR'),
  col('HISTORIA_CLINICA', 'varchar', 12, many(() => String(int(100000, 9999999))), 'AR_SALUD_IDENTIFICADOR'),
  col('OBRA_SOCIAL', 'varchar', 30, many(() => pick(['OSDE', 'PAMI', 'IOMA', 'OSECAC', 'Swiss Medical'])), 'AR_SALUD_COBERTURA'),
  col('COD_RNOS', 'varchar', 8, many(() => `${int(1, 4)}-${pad(int(1, 9999), 4)}-${int(0, 9)}`), 'AR_SALUD_COBERTURA'),
  col('DIAGNOSTICO', 'varchar', 6, many(() => pick(['E11.9', 'I10', 'J45.9', 'F32.1'])), 'AR_SALUD_DIAGNOSTICO'),
  col('CAUSA_DEFUNCION', 'varchar', 6, many(() => pick(['I219', 'C509', 'X954', 'J189'])), 'AR_SALUD_DIAGNOSTICO'),
  col('COD_PRACTICA', 'varchar', 6, many(() => pick(['420101', '170101', '660475'])), 'AR_SALUD_PROCEDIMIENTO'),
  col('MEDICAMENTO', 'varchar', 40, many(() => pick(['Sertralina', 'Paracetamol', 'Metformina', 'Clonazepam'])), 'AR_SALUD_MEDICAMENTO'),
  col('EVOLUCION', 'clob', 4000, many(() => `Paciente refiere dolor abdominal de ${int(1, 9)} días de evolución.`), 'AR_SALUD_TEXTO_CLINICO'),
  col('RESULTADO_ANALISIS', 'varchar', 12, many(() => pick(['Normal', 'Alterado'])), 'AR_SALUD_RESULTADO_ESTUDIO'),
  col('SEROLOGIA_VIH', 'varchar', 12, many(() => pick(['Reactivo', 'No reactivo'])), 'AR_SALUD_VIH'),
  col('GRUPO_SANGUINEO', 'varchar', 4, many(() => pick(['A+', '0-', 'AB+', '0+'])), 'AR_SALUD_GRUPO_SANGUINEO'),
  col('CUD', 'varchar', 30, many(() => pick(['Motora', 'Visual', 'Auditiva', 'Intelectual'])), 'AR_SALUD_DISCAPACIDAD'),
  col('EXAMEN_PREOCUPACIONAL', 'varchar', 30, many(() => pick(['Apto', 'No apto'])), 'AR_SALUD_OCUPACIONAL'),
  col('EMBARAZADA', 'char', 1, many(() => pick(['S', 'N'])), 'AR_SALUD_REPRODUCTIVA'),
  col('TRASTORNO_MENTAL', 'varchar', 60, many(() => pick(['Depresión', 'Ansiedad'])), 'AR_SALUD_MENTAL'),

  // FIN
  col('SITUACION_BCRA', 'number', 1, many(() => String(int(1, 6))), 'AR_FIN_SITUACION_CREDITICIA'),
  col('SCORE_VERAZ', 'number', 3, many(() => String(int(1, 999))), 'AR_FIN_SITUACION_CREDITICIA'),
  col('SALDO_DEUDA', 'number', 12, many(() => String(int(10000, 90000000))), 'AR_FIN_DEUDA'),
  col('SUELDO_BRUTO', 'number', 10, many(() => String(int(500000, 9000000))), 'AR_FIN_INGRESOS'),
  col('VALUACION_FISCAL', 'number', 12, many(() => String(int(5000000, 900000000))), 'AR_FIN_PATRIMONIO'),
  col('HABER_JUBILATORIO', 'number', 10, many(() => String(int(300000, 3000000))), 'AR_FIN_JUBILACION'),
  col('BENEFICIARIO_AUH', 'char', 1, many(() => pick(['S', 'N'])), 'AR_FIN_PROGRAMA_SOCIAL'),
  col('CATEGORIA_MONOTRIBUTO', 'char', 1, many(() => pick('ABCDEFGHIJK')), 'AR_FIN_MONOTRIBUTO'),
  col('TENENCIA_VIVIENDA', 'varchar', 40, many(() => pick(['Propietario', 'Inquilino', 'Ocupante por préstamo'])), 'AR_FIN_VIVIENDA'),

  // PENAL
  col('ANTECEDENTES_PENALES', 'varchar', 60, many(() => pick(['No registra antecedentes', 'Registra antecedentes'])), 'AR_PENAL_ANTECEDENTES'),
  col('NRO_EXPEDIENTE', 'varchar', 20, many(() => `${pick(['CCC', 'CNT', 'CAF', 'CIV'])} ${int(1, 99999)}/${int(2010, 2025)}`), 'AR_PENAL_EXPEDIENTE'),

  // Not personal data: nothing should be assigned
  col('ID', 'integer', 10, many((i) => String(i + 1)), ''),
  col('RUTA_ARCHIVO', 'varchar', 200, many(() => `/datos/archivo${int(1, 99)}.txt`), ''),
  col('NOMBRE_PRODUCTO', 'varchar', 80, many(() => pick(['Leche entera 1L', 'Yerba mate 1 kg', 'Dulce de leche 400 g'])), ''),
  col('IMPORTE_VENTA', 'number', 12, many(() => String(int(1000, 99999999))), ''),
  col('FECHA_CREACION', 'date', 0, many(() => iso(2015, 2025)), ''),
  col('FECHA_FACTURA', 'date', 0, many(() => iso(2015, 2025)), ''),
  col('CODIGO', 'varchar', 10, many(() => `A-${int(100, 999)}`), ''),
  col('DESCRIPCION_PRODUCTO', 'varchar', 400, many(() => 'Producto de consumo masivo, envase de cartón reciclable.'), ''),
  col('ESTADO', 'varchar', 10, many(() => pick(['ACTIVO', 'INACTIVO'])), ''),
  col('CANTIDAD', 'number', 6, many(() => String(int(1, 500))), ''),
  col('SKU', 'varchar', 12, many(() => `SKU${int(10000, 99999)}`), ''),
  col('ID_TRANSACCION', 'varchar', 36, many(() => `TX${int(100000, 999999)}`), ''),
  col('AREA', 'varchar', 40, many(() => pick(['Finanzas', 'Operaciones'])), ''),
  col('PROVINCIA', 'varchar', 30, many(() => pick(['Buenos Aires', 'Córdoba', 'Santa Fe', 'Mendoza'])), ''),
  col('COD_BANCO', 'varchar', 3, many(() => pick(['011', '007', '017', '285'])), ''),
  col('URL_PAGINA', 'varchar', 200, many(() => `https://www.ejemplo.com.ar/p/${int(1, 999)}`), ''),
  col('TIPO_DOCUMENTO', 'varchar', 4, many(() => pick(['DNI', 'LE', 'LC', 'CUIT', 'PAS'])), ''),
  col('MONEDA', 'varchar', 3, many(() => pick(['ARS', 'USD'])), ''),
  col('CATEGORIA', 'varchar', 30, many(() => pick(['Lácteos', 'Almacén'])), ''),
  col('CAE', 'varchar', 14, many(() => `7${digits(13)}`), ''),
  col('PUNTO_VENTA', 'number', 5, many(() => String(int(1, 20))), ''),
  col('CONDICION_IVA', 'varchar', 30, many(() => pick(['Responsable Inscripto', 'Consumidor Final', 'Exento'])), ''),
  col('IDIOMA', 'varchar', 5, many(() => pick(['es-AR', 'en', 'es'])), ''),
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

// ── Geography, offline ──────────────────────────────────────────────────────
//
// Every place of under 20,000 inhabitants must become one of at least 20,000 of the same province
// when written with its province and by its code; by its name alone, unless the name is shared with
// a large place. A large place stays. A localidad counts as large when its gobierno local is.

const readTable = (name) => new Map(fs.readFileSync(nodePath.join(HERE, 'files', name), 'utf8').split('\n').filter(Boolean).map((l) => l.split('|')))

/**
 * `places` share one name table; `targets` are the large places a small one may become, and
 * `ofCode` finds the place of a code.
 */
function audit(label, places, table, codes, targets, ofCode) {
  const key = (n) => fold(n).toLowerCase()
  const byName = new Map()
  for (const p of places) for (const n of new Set([p.name, ...p.aliases].map(key))) byName.set(n, [...(byName.get(n) ?? []), p])
  const targetNames = new Set(targets.flatMap((t) => [t.name, ...t.aliases].map((n) => `${n}|${t.provinceCode}`)))
  const isTarget = (name, provinceCode) => (provinceCode ? targetNames.has(`${name}|${provinceCode}`) : targets.some((t) => t.name === name || t.aliases.includes(name)))
  let ok = 0
  let shared = 0
  let shown = 0
  for (const p of places) {
    const problems = []
    const homonyms = byName.get(key(p.name))
    const withProvince = table.get(`${p.name} - ${p.province}`)
    const alone = table.get(p.name)
    const code = codes.get(p.code)
    if (p.population >= 20000) {
      if (withProvince || alone || code) problems.push('a large place is generalized')
    } else {
      if (homonyms.length > 1) shared++
      if (homonyms.some((x) => x.population >= 20000 && x.provinceCode === p.provinceCode)) { if (withProvince) problems.push('a name shared with a large place of its province is generalized') }
      else if (!withProvince || !withProvince.endsWith(` - ${p.province}`) || !isTarget(withProvince.slice(0, -` - ${p.province}`.length), p.provinceCode)) problems.push(`with its province: ${withProvince ?? 'not in the table'}`)
      if (homonyms.some((x) => x.population >= 20000)) { if (alone) problems.push('a name shared with a large place is generalized') }
      else if (!alone || !isTarget(alone)) problems.push(`by name: ${alone ?? 'not in the table'}`)
      const target = code && ofCode(code)
      if (!target || target.population < 20000 || target.provinceCode !== p.provinceCode) problems.push(`code ${p.code} → ${code}`)
    }
    if (problems.length) { failures++; if (shown++ < 15) console.log(`  ✗ ${label} ${p.name}/${p.province} (${p.population}): ${problems.join('; ')}`) }
    else ok++
  }
  console.log(`${label}: ${ok} of ${places.length} generalized as expected (${shared} small ones share a name)`)
}

function verifyGeneralization() {
  const codes = readTable('ar-codigos-geograficos-generalizados.txt')
  const byCode = new Map([...DEPARTAMENTOS, ...GOBIERNOS, ...LOCALIDADES].map((p) => [p.code, p]))
  const ofCode = (c) => byCode.get(c)
  audit('departamentos', DEPARTAMENTOS, readTable('ar-departamentos-generalizados.txt'), codes, DEPARTAMENTOS.filter((d) => d.population >= 20000), ofCode)
  audit('gobiernos locales and localidades', [...GOBIERNOS, ...LOCALIDADES], readTable('ar-localidades-generalizadas.txt'), codes, GOBIERNOS.filter((g) => g.population >= 20000), ofCode)
}

// ── Algorithms ──────────────────────────────────────────────────────────────

const words = (s) => s.trim().split(/\s+/).length
const sameShape = (i, o) => i.length === o.length && i.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9') === o.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9')
const digitShape = (i, o) => i.length === o.length && i.replace(/\d/g, '9') === o.replace(/\d/g, '9')
const MASKING = {
  AR_L1_DNI: { inputs: ['28.456.789', '28456789', '5123456', '94.123.456', '20-28456789-1', 'AAA123456'], check: (i, o) => (/-\d$/.test(i) ? validCuit(o) && digitShape(i, o) : sameShape(i, o)) },
  AR_L1_CUIT: {
    inputs: ['20-28456789-1', '20284567891', '27-12345678-0', '30-50001091-2', '23 28456789 4', ...many(() => dashed(cuit(['20', '23', '24', '27', '30', '33', '34'])), 20)],
    check: (i, o) => validCuit(o) && digitShape(i, o),
  },
  AR_L1_TRAMITE_DNI: { inputs: ['00123456789'], check: sameShape },
  AR_L1_DOCUMENTO_EXTRANJERO: { inputs: ['123456/2021'], check: sameShape },
  AR_L1_PASAPORTE: { inputs: ['AAA123456'], check: sameShape },
  AR_L1_REGISTRO_CIVIL: { inputs: ['1234 Tomo 2A'], check: sameShape },
  AR_L1_MATRICULA_PROFESIONAL: { inputs: ['MN 123456'], check: sameShape },
  AR_L1_NOMBRE: { inputs: ['Soledad', 'JUAN CARLOS', 'María del Carmen', 'Ana María Luz Belén'], check: (i, o) => words(i) === words(o) && (!/ del /.test(i) || / del /.test(o)) },
  AR_L1_APELLIDO: { inputs: ['Fernández', 'GÓMEZ ROSSI', 'López de Rossi'], check: (i, o) => words(i) === words(o) && (!/ de /.test(i) || / de /.test(o)) },
  AR_L1_NOMBRE_COMPLETO: {
    inputs: ['Soledad Fernández', 'JUAN CARLOS PÉREZ', 'Juan Carlos Fernández Rossi', 'María del Carmen Gómez', 'FERNÁNDEZ, JUAN CARLOS'],
    check: (i, o) => words(i) === words(o) && [' del ', ' de '].every((w) => i.includes(w) === o.includes(w)),
  },
  AR_L1_RAZON_SOCIAL: { inputs: ['Arcos Dorados Argentina S.A.'] },
  AR_L1_EMAIL: { inputs: ['soledad.fernandez@hotmail.com.ar', 'josé.muñoz@empresa.com'], check: (i, o) => /@[^@]+\.test$/.test(o) },
  AR_L1_TELEFONO: {
    inputs: ['+54 9 11 4567-8901', '1145678901', '+5491145678901', '(011) 4567-8901', '(0351) 15-456-7890', '0261 425-1234', '4567-8901', '15-4567-8901'],
    // The length stays, and so do country code, 9, area code and 15.
    check: (i, o) => {
      if (!digitShape(i, o)) return false
      const kept = i.match(/^(\+?54[\s\-]?(9[\s\-]?)?)?(\(?0?(11|[23]\d{1,3})\)?[\s\-]+)?(15[\s\-]?)?/)?.[0] ?? ''
      const plain = i.match(/^(\+?549?|0)?(11|[23]\d{2,3})(?=\d{6,8}$)/)?.[0] ?? ''
      const head = kept.length >= plain.length ? kept : plain
      return o.startsWith(head) && o.replace(/\D/g, '').slice(-6) !== i.replace(/\D/g, '').slice(-6)
    },
  },
  AR_L1_DIRECCION: { inputs: ['Av. Corrientes 1234 Piso 5 Dto. B', 'Calle 7 N° 1234'] },
  AR_L1_DIRECCION_COMPLEMENTO: { inputs: ['Piso 3 Dto. B', 'UF 12'] },
  AR_L1_CBU: { inputs: ['2850590940090418135201', '28505909-40090418135201', '0000003100010000000001', ...many(cbu, 10)], check: (i, o) => digitShape(i, o) && o.slice(0, 8) === i.slice(0, 8) && (validCbu(i.replace('0000003100010000000001', '')) ? validCbu(o) : true) },
  AR_L1_ALIAS_CBU: { inputs: ['gato.mesa.lluvia'], check: sameShape },
  AR_L1_CUENTA_BANCARIA: { inputs: ['123-456789/0'], check: digitShape },
  AR_L1_TARJETA: { inputs: ['4509 9535 6623 3704'] },
  AR_L1_IP: { inputs: ['181.47.132.21', '2800:810:4f2::1'], check: (i, o) => (i.includes('.') ? o.split('.').every((p) => Number(p) >= 1 && Number(p) <= 254) : /^[0-9a-f:]+$/i.test(o)) },
  AR_L1_DISPOSITIVO: { inputs: ['3c:22:fb:9a:10:e4', '356938035643809'], check: (i, o) => (i.includes(':') ? /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(o) : /^\d{15}$/.test(o)) },
  AR_L1_DOMINIO: { inputs: ['AE 123 KD', 'ABC123', 'A123BCD', '123 ABC'], check: sameShape },
  AR_L1_VEHICULO: { inputs: ['8AJFB8CD1K1234567'], check: sameShape },
  AR_L1_INMUEBLE: { inputs: ['123-456789'], check: sameShape },
  AR_L1_CONTRATO: { inputs: ['LEG-12345'] },
  AR_L1_USUARIO: { inputs: ['@sole_fernandez'] },
  AR_L1_CREDENCIAL: { inputs: ['Clave#2024'], check: (i, o) => /^X+$/.test(o) },
  AR_L1_GEOLOCALIZACION: { inputs: ['-34.603722', '-34.603722,-58.381592'], check: (i, o) => o.slice(0, 5) === i.slice(0, 5) },
  AR_L1_TEXTO_LIBRE: {
    inputs: ['Cliente Fernández, DNI 28.456.789, CUIL 20-28456789-1, correo s.fernandez@hotmail.com, cel 1145678901.'],
    check: (i, o) => !/28\.456\.789|20-28456789-1|s\.fernandez@hotmail\.com|1145678901|Fernández/.test(o),
  },
  AR_L2_FECHA_NACIMIENTO: { inputs: ['1985-07-20', '2012-01-15'], check: (i, o) => Math.abs(new Date(o.slice(0, 10)) - new Date(i)) <= 60 * 864e5 },
  AR_L2_ANIO_NACIMIENTO: { inputs: ['1985'], check: (i, o) => o.startsWith('198'), same: true },
  AR_L2_EDAD: { inputs: ['37', '7', '104'], check: (i, o) => (i === '104' ? o === '90' : i.length === 1 || o[0] === i[0]), same: true },
  AR_L2_FECHA_EVENTO: { inputs: ['2021-03-15'] },
  AR_L2_SEXO: { inputs: ['F', 'M', 'X', 'Femenino', 'masculino', 'Varón', '1'], same: true },
  AR_L2_LOCALIDAD: { inputs: ['El Chaltén', 'Rosario', 'MAR DEL PLATA', 'Tres Lagos - Santa Cruz', 'Colonia Hocker', 'San José', 'Tilcara', 'Purmamarca'], same: true },
  AR_L2_DEPARTAMENTO: { inputs: ['Ancasti', 'La Matanza', 'Iruya - Salta', 'TORDILLO'], same: true },
  AR_L2_CODIGO_GEOGRAFICO: { inputs: ['10014', '06427', '785035', '06357110'], same: true },
  AR_L2_CODIGO_POSTAL: { inputs: ['C1043AAZ', '1636', 'B1636'], check: (i, o) => ({ C1043AAZ: 'C1000AAA', 1636: '1600', B1636: 'B1600' })[i] === o },
  AR_L2_BARRIO: { inputs: ['Barrio Parque Los Andes'], same: true },
  AR_L2_NACIONALIDAD: { inputs: ['Senegalesa'], same: true },
  AR_L2_ESTADO_CIVIL: { inputs: ['Concubinato', '2'], same: true },
  AR_L2_OCUPACION: { inputs: ['Gerente regional de operaciones', '10311'] },
  AR_L2_EMPLEADOR: { inputs: ['Mercado Libre S.R.L.'] },
  AR_L2_NIVEL_EDUCATIVO: { inputs: ['Doctorado', '7'], same: true },
  AR_L2_ESTABLECIMIENTO_EDUCATIVO: { inputs: ['Colegio Nacional de Buenos Aires'] },
  AR_L2_PERSONAS_A_CARGO: { inputs: ['9', '2'], check: (i, o) => Number(o) <= 5, same: true },
  AR_L3_ORIGEN_ETNICO: { inputs: ['Afroargentino', 'N'], same: true },
  AR_L3_PUEBLO_INDIGENA: { inputs: ['Selk\'nam', 'Mapuche'], same: true },
  AR_L3_LENGUA_INDIGENA: { inputs: ['Tapiete'], same: true },
  AR_L3_RELIGION: { inputs: ['Ortodoxa', 'N'], same: true },
  AR_L3_CONVICCION_FILOSOFICA: { inputs: ['Se niega a transfusiones'] },
  AR_L3_OPINION_POLITICA: { inputs: ['Libertario'], same: true },
  AR_L3_AFILIACION_PARTIDARIA: { inputs: ['Movimiento Popular Neuquino', 'S'], same: true },
  AR_L3_AFILIACION_SINDICAL: { inputs: ['UOM', 'S'], same: true },
  AR_L3_BIOMETRICO: { inputs: ['A1B2C3D4E5F6'] },
  AR_L3_GENETICO: { inputs: ['BRCA1 positivo'] },
  AR_L3_ORIENTACION_SEXUAL: { inputs: ['Homosexual'], same: true },
  AR_L3_VIDA_SEXUAL: { inputs: ['Activa'] },
  AR_L3_IDENTIDAD_GENERO: { inputs: ['Transgénero'], same: true },
  AR_L3_VICTIMA: { inputs: ['Violencia física y psicológica', 'S'], same: true },
  AR_SALUD_IDENTIFICADOR: { inputs: ['15012345678/00'] },
  AR_SALUD_COBERTURA: { inputs: ['OSUOMRA', '1-0020-4', '400909'], same: true },
  AR_SALUD_DIAGNOSTICO: { inputs: ['F33.1', 'B24X', 'E119', 'Depresión mayor'], same: true },
  AR_SALUD_PROCEDIMIENTO: { inputs: ['420101', 'Prueba de carga viral para VIH'] },
  AR_SALUD_MEDICAMENTO: { inputs: ['Sertralina 50 mg'] },
  AR_SALUD_TEXTO_CLINICO: { inputs: ['Paciente Fernández, DNI 28.456.789, consulta por cefalea.'], check: (i, o) => !o.includes('28.456.789') },
  AR_SALUD_RESULTADO_ESTUDIO: { inputs: ['Reactivo'] },
  AR_SALUD_VIH: { inputs: ['Reactivo', 'S'], same: true },
  AR_SALUD_GRUPO_SANGUINEO: { inputs: ['0+'], same: true },
  AR_SALUD_DISCAPACIDAD: { inputs: ['Trastorno del espectro autista', 'N', 'ARG-01-00012345678-20190101'], same: true },
  AR_SALUD_OCUPACIONAL: { inputs: ['No apto temporariamente', 'S'], same: true },
  AR_SALUD_REPRODUCTIVA: { inputs: ['12 semanas de gestación', 'S'], same: true },
  AR_SALUD_MENTAL: { inputs: ['Trastorno bipolar'] },
  AR_FIN_SITUACION_CREDITICIA: { inputs: ['1', '3', '6', 'Situación 4', '745', 'Irrecuperable', 'N'], same: true },
  AR_FIN_DEUDA: { inputs: ['1850000'] },
  AR_FIN_INGRESOS: { inputs: ['1450000'] },
  AR_FIN_PATRIMONIO: { inputs: ['85000000'] },
  AR_FIN_JUBILACION: { inputs: ['420000'] },
  AR_FIN_PROGRAMA_SOCIAL: { inputs: ['Potenciar Trabajo', 'S'], same: true },
  AR_FIN_MONOTRIBUTO: { inputs: ['A', 'F', 'K', 'Categoría C'], same: true },
  AR_FIN_VIVIENDA: { inputs: ['Ocupante de hecho'], same: true },
  AR_PENAL_ANTECEDENTES: { inputs: ['Condenado por robo en 2019', 'S'], same: true },
  AR_PENAL_EXPEDIENTE: {
    inputs: ['CCC 12345/2023', 'CNT 4567/2021/CA1', 'PP-07-00-012345-23/00', '1234/2020'],
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
const LARGE_GL = new Set(GOBIERNOS.filter((g) => g.population >= 20000).map((g) => g.name.toLowerCase()))
const LARGE_DEP = new Set(DEPARTAMENTOS.filter((d) => d.population >= 20000).map((d) => d.name.toLowerCase()))
const PARTICLE = /^(de|del|la|las|los|y|e|san|santa)$/i
const EXPECT = {
  AR_L1_NOMBRE: (i, o) => words(i) > 3 || o.split(/\s+/).every((w) => PARTICLE.test(w) || has('ar-nombres.txt', w)),
  AR_L1_APELLIDO: (i, o) => o.split(/\s+/).every((w) => PARTICLE.test(w) || has('ar-apellidos.txt', w)),
  AR_L1_NOMBRE_COMPLETO: (i, o) => i.includes(',') || (has('ar-nombres.txt', o.split(/\s+/)[0]) && has('ar-apellidos.txt', o.split(/\s+/).at(-1))),
  AR_L1_RAZON_SOCIAL: (i, o) => has('ar-empresas.txt', o),
  AR_L1_DIRECCION: (i, o) => has('ar-direcciones.txt', o),
  AR_L2_SEXO: (i, o) => ({ f: ['f', 'm'], m: ['f', 'm'], x: ['f', 'm'], femenino: ['femenino', 'masculino'], masculino: ['femenino', 'masculino'], varón: ['mujer', 'varón'], 1: ['1', '2'] })[i.toLowerCase()].includes(o.toLowerCase()),
  // El Chaltén and Tres Lagos become El Calafate; Rosario and Mar del Plata stay; San José is shared
  // with large places and stays; the rest become a gobierno local of 20,000 or more.
  AR_L2_LOCALIDAD: (i, o) => ({ Rosario: o === 'Rosario', 'MAR DEL PLATA': o === 'MAR DEL PLATA', 'San José': o === 'San José', 'El Chaltén': o === 'El Calafate', 'Tres Lagos - Santa Cruz': o === 'El Calafate - Santa Cruz' })[i] ?? LARGE_GL.has(o.toLowerCase()),
  AR_L2_DEPARTAMENTO: (i, o) => ({ 'La Matanza': o === 'La Matanza', 'Iruya - Salta': / - Salta$/.test(o) && LARGE_DEP.has(o.slice(0, -8).toLowerCase()) })[i] ?? (o !== i && LARGE_DEP.has(fold(o).toLowerCase()) || [...LARGE_DEP].some((n) => fold(n) === fold(o).toLowerCase())),
  // La Matanza and Mar del Plata stay; Ancasti and Tres Lagos do not.
  AR_L2_CODIGO_GEOGRAFICO: (i, o) => (['06427', '06357110'].includes(i) ? o === i : o.length === i.length && o.slice(0, 2) === i.slice(0, 2) && o !== i),
  AR_L2_BARRIO: (i, o) => has('ar-barrios.txt', o),
  AR_L2_NACIONALIDAD: (i, o) => has('ar-nacionalidades.txt', o),
  AR_L2_ESTADO_CIVIL: (i, o) => (/^\d$/.test(i) ? /^[1-6]$/.test(o) : has('ar-estado-civil.txt', o)),
  AR_L2_OCUPACION: (i, o) => (/^\d+$/.test(i) ? /^\d{5}$/.test(o) : has('ar-ocupaciones.txt', o)),
  AR_L2_EMPLEADOR: (i, o) => has('ar-empleadores.txt', o),
  AR_L2_NIVEL_EDUCATIVO: (i, o) => (/^\d+$/.test(i) ? has('ar-nivel-educativo-codigos.txt', o) : has('ar-nivel-educativo.txt', o)),
  AR_L2_ESTABLECIMIENTO_EDUCATIVO: (i, o) => has('ar-establecimientos-educativos.txt', o),
  AR_L3_ORIGEN_ETNICO: (i, o) => flag(i, o) ?? has('ar-origen-etnico.txt', o),
  AR_L3_PUEBLO_INDIGENA: (i, o) => has('ar-pueblos-indigenas.txt', o),
  AR_L3_LENGUA_INDIGENA: (i, o) => has('ar-lenguas.txt', o),
  AR_L3_RELIGION: (i, o) => flag(i, o) ?? has('ar-religiones.txt', o),
  AR_L3_CONVICCION_FILOSOFICA: (i, o) => o === SUPPRESSED,
  AR_L3_OPINION_POLITICA: (i, o) => has('ar-opiniones-politicas.txt', o),
  AR_L3_AFILIACION_PARTIDARIA: (i, o) => flag(i, o) ?? has('ar-partidos-politicos.txt', o),
  AR_L3_AFILIACION_SINDICAL: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  AR_L3_ORIENTACION_SEXUAL: (i, o) => has('ar-orientaciones-sexuales.txt', o),
  AR_L3_VIDA_SEXUAL: (i, o) => o === SUPPRESSED,
  AR_L3_IDENTIDAD_GENERO: (i, o) => has('ar-identidades-genero.txt', o),
  AR_L3_VICTIMA: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  AR_SALUD_COBERTURA: (i, o) => (/\d/.test(i) ? digitShape(i, o) : has('ar-obras-sociales.txt', o)),
  AR_SALUD_DIAGNOSTICO: (i, o) => (/\.\d/.test(i) ? has('ar-cie10-decimal.txt', o) : /^[A-Z]\d{2,3}X?$/i.test(i) ? has('ar-cie10.txt', o) : has('ar-diagnosticos.txt', o)),
  AR_SALUD_PROCEDIMIENTO: (i, o) => (/^\d+$/.test(i) ? /^\d{6}$/.test(o) : has('ar-procedimientos.txt', o)),
  AR_SALUD_MEDICAMENTO: (i, o) => has('ar-medicamentos.txt', o),
  AR_SALUD_VIH: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  AR_SALUD_GRUPO_SANGUINEO: (i, o) => has('ar-grupos-sanguineos.txt', o),
  AR_SALUD_DISCAPACIDAD: (i, o) => flag(i, o) ?? (/\d/.test(i) ? sameShape(i, o) : has('ar-discapacidades.txt', o)),
  AR_SALUD_OCUPACIONAL: (i, o) => flag(i, o) ?? has('ar-aptitud-laboral.txt', o),
  AR_SALUD_REPRODUCTIVA: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  AR_SALUD_MENTAL: (i, o) => o === SUPPRESSED,
  AR_FIN_SITUACION_CREDITICIA: (i, o) => {
    if (flag(i, o) !== null) return flag(i, o)
    const m = i.match(/^(\D*)([1-6])$/)
    if (m) return o.startsWith(m[1]) && /^[1-6]$/.test(o.slice(m[1].length)) && Math.ceil(Number(o.at(-1)) / 2) === Math.ceil(Number(m[2]) / 2)
    return /^\d+$/.test(i) ? /^\d{3}$/.test(o) : has('ar-estados-credito.txt', o)
  },
  AR_FIN_PROGRAMA_SOCIAL: (i, o) => flag(i, o) ?? has('ar-programas-sociales.txt', o),
  AR_FIN_MONOTRIBUTO: (i, o) => { const tier = (c) => ('ABCD'.includes(c) ? 0 : 'EFGH'.includes(c) ? 1 : 2); return o.slice(0, -1) === i.slice(0, -1) && /[A-K]$/.test(o) && tier(o.at(-1)) === tier(i.at(-1)) },
  AR_FIN_VIVIENDA: (i, o) => has('ar-tenencia-vivienda.txt', o),
  AR_PENAL_ANTECEDENTES: (i, o) => flag(i, o) ?? has('ar-antecedentes.txt', o),
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
  const TYPED = new Set(['AR_L2_FECHA_NACIMIENTO', 'AR_L2_FECHA_EVENTO', 'AR_FIN_DEUDA', 'AR_FIN_INGRESOS', 'AR_FIN_PATRIMONIO', 'AR_FIN_JUBILACION'])
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

  // CUITs stay CUITs: 240 distinct inputs of every type give distinct valid outputs, and some of
  // them had to change type — the remainder 1, where Check Digit alone would be wrong.
  const cuits = [...new Set(many(() => cuit(['20', '23', '24', '27', '30', '33', '34']), 240))]
  const outputs = new Set()
  let invalid = 0
  let typeChanged = 0
  let i = 0
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < cuits.length) {
      const input = cuits[i++]
      const { output } = await run('AR_CUIT', input)
      outputs.add(output)
      if (!output || !validCuit(output)) invalid++
      else if (output.slice(0, 2) !== input.slice(0, 2)) typeChanged++
    }
  }))
  if (outputs.size !== cuits.length || invalid || !typeChanged) { failures++; console.log(`  ✗ CUIT: ${cuits.length} inputs gave ${outputs.size} distinct outputs, ${invalid} invalid, ${typeChanged} with a new type`) }
  else console.log(`CUIT: ${cuits.length} distinct inputs, ${outputs.size} distinct valid outputs (${typeChanged} changed type)`)

  const cbus = [...new Set(many(cbu, 150))]
  const cbuOut = new Set()
  let cbuInvalid = 0
  let k = 0
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (k < cbus.length) {
      const { output } = await run('AR_CBU', cbus[k++])
      cbuOut.add(output)
      if (!output || !validCbu(output)) cbuInvalid++
    }
  }))
  if (cbuOut.size !== cbus.length || cbuInvalid) { failures++; console.log(`  ✗ CBU: ${cbus.length} inputs gave ${cbuOut.size} distinct outputs, ${cbuInvalid} invalid`) }
  else console.log(`CBU: ${cbus.length} distinct inputs, ${cbuOut.size} distinct valid outputs`)

  const dnis = [...new Set(many(dni, 150))]
  const dniOut = new Set()
  for (const d of dnis) dniOut.add((await run('AR_DOCUMENTO', d)).output)
  if (dniOut.size !== dnis.length) { failures++; console.log(`  ✗ DNI: ${dnis.length} inputs gave ${dniOut.size} distinct outputs`) }
  else console.log(`DNI: ${dnis.length} distinct inputs, ${dniOut.size} distinct outputs`)

  // A natural person's CUIL carries the DNI: masked, it carries the masked DNI.
  let agree = 0
  const people = many(() => String(int(10000000, 49999999)), 20)
  for (const d of people) {
    const c = cuitOf('20', d) ?? cuitOf('27', d) ?? cuitOf('24', d)
    const [a, b] = await Promise.all([run('AR_DOCUMENTO', d), run('AR_CUIT', dashed(c))])
    if (a.output && b.output && b.output.split('-')[1] === a.output) agree++
  }
  if (agree !== people.length) { failures++; console.log(`  ✗ DNI and CUIL agree for ${agree} of ${people.length} people`) }
  else console.log(`DNI and CUIL of the same person agree: ${agree} of ${people.length}`)
}

if (only !== 'algorithms') { verifyClassifiers(); verifyGeneralization() }
if (only !== 'classifiers') await verifyAlgorithms()
console.log(failures ? `\n${failures} problem(s)` : '\nall good')
process.exit(failures ? 1 : 0)
