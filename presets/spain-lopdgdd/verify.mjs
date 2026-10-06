#!/usr/bin/env node
/**
 * Checks the Spain (RGPD and LOPDGDD) preset.
 *
 *   node presets/spain-lopdgdd/verify.mjs               # classifiers, then algorithms
 *   node presets/spain-lopdgdd/verify.mjs classifiers    # only the local profiling check
 *   node presets/spain-lopdgdd/verify.mjs algorithms     # only masking, against the app
 *
 * Classifiers run through classifiers/, the same evaluator the classifier test uses: every
 * configuration is reviewed, then a battery of columns — well named, badly named, named in Catalan,
 * Galician or Basque, and unrelated — is profiled with the whole set at its threshold and with the
 * essential pack. The tables that generalize municipios, their INE codes and the postal codes are
 * audited offline. Algorithms run in the app (DLPX_URL, default http://localhost:3000), which needs
 * the Delphix jars in lib/; every DNI, NIE, Seguridad Social number, IBAN, CCC, referencia
 * catastral and CUPS they write is checked against its own control rule.
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

// ── Control rules ───────────────────────────────────────────────────────────

const LETTERS_23 = 'TRWAGMYFPDXBNJZSQVHLCKE'
/** DNI, NIE and the NIF of a natural person (K, L, M): the number modulo 23. */
const validDni = (value) => {
  const m = value.replace(/[.\s-]/g, '').match(/^([XYZKLM]?)(\d{7,8})([A-Z])$/i)
  if (!m) return false
  const prefix = 'XYZ'.indexOf(m[1].toUpperCase())
  return LETTERS_23[Number(`${prefix >= 0 ? prefix : ''}${m[2]}`) % 23] === m[3].toUpperCase()
}
/** Seguridad Social: the first ten digits modulo 97, an eight-digit number under 10⁷ losing its zero. */
const validNss = (value) => {
  const d = value.replace(/\D/g, '')
  if (d.length !== 12) return false
  const [p, n, c] = [d.slice(0, 2), d.slice(2, 10), d.slice(10)]
  const x = Number(n) < 1e7 ? BigInt(n) + BigInt(p) * 10000000n : BigInt(p + n)
  return Number(x % 97n) === Number(c)
}
const CCC_WEIGHTS = [1, 2, 4, 8, 5, 10, 9, 7, 3, 6]
const cccDigit = (ten) => {
  const t = [...ten].reduce((a, c, i) => a + Number(c) * CCC_WEIGHTS[i], 0) % 11
  return t === 0 ? 0 : t === 1 ? 1 : 11 - t
}
const validCcc = (value) => {
  const d = value.replace(/\D/g, '').slice(-20)
  return d.length === 20 && String(cccDigit(`00${d.slice(0, 8)}`)) === d[8] && String(cccDigit(d.slice(10))) === d[9]
}
/** ISO 13616: move ESkk to the end, read E as 14 and S as 28, remainder 1 modulo 97. */
const validIban = (value) => {
  const c = value.replace(/\s/g, '')
  if (!/^ES\d{22}$/.test(c)) return false
  let r = 0
  for (const x of `${c.slice(4)}1428${c.slice(2, 4)}`) r = (r * 10 + Number(x)) % 97
  return r === 1 && validCcc(c)
}
const RC_WEIGHTS = [13, 15, 12, 5, 4, 17, 9, 21, 3, 7, 1]
const RC_LETTERS = 'MQWERTYUIOPASDFGHJKLBZX'
const rcValue = (c) => (/\d/.test(c) ? Number(c) : c.charCodeAt(0) - 64 > 14 ? c.charCodeAt(0) - 63 : c.charCodeAt(0) - 64)
const rcLetters = (rc) => [rc.slice(0, 7) + rc.slice(14, 18), rc.slice(7, 14) + rc.slice(14, 18)].map((s) => RC_LETTERS[[...s].reduce((t, c, i) => t + rcValue(c) * RC_WEIGHTS[i], 0) % 23]).join('')
const validRc = (rc) => /^[0-9A-Z]{18}[A-Z]{2}$/.test(rc) && rcLetters(rc) === rc.slice(18)
const cupsLetters = (sixteen) => { const r = Number(BigInt(sixteen) % 529n); return `${LETTERS_23[Math.floor(r / 23)]}${LETTERS_23[r % 23]}` }
const validCups = (value) => { const c = value.replace(/\s/g, ''); return /^ES\d{16}[A-Z]{2}(\d[A-Z])?$/.test(c) && cupsLetters(c.slice(2, 18)) === c.slice(18, 20) }

// ── Test data ───────────────────────────────────────────────────────────────

let seed = 32018
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
const COMUNIDADES = source('comunidades.tsv').map((l) => l.split('\t')[1])
const PROVINCIAS = source('provincias.tsv').map((l) => {
  const [code, name, aliases, , , capital, , , population] = l.split('\t')
  return { code, name, aliases: aliases ? aliases.split(';') : [], capital, population: Number(population) }
})
const MUNICIPIOS = source('municipios.tsv').map((l) => {
  const [code, dc, name, aliases, provinceCode, province, , , , population] = l.split('\t')
  return { code, dc, name, aliases: aliases ? aliases.split(';') : [], provinceCode, province, population: Number(population) }
})
// As the build reads them: a code's municipios of its own province, and no code without one.
const POSTAL = source('codigos-postales.tsv').map((l) => { const [code, m] = l.split('\t'); return { code, municipios: m.split(';').filter((x) => x.slice(0, 2) === code.slice(0, 2)) } }).filter((c) => c.municipios.length)
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '')
const key = (n) => fold(n).toLowerCase()
const PERSONAL = new Set([...GIVEN, ...SURNAMES].map(key))
const REGIONS = new Set([...PROVINCIAS.flatMap((p) => [p.name, ...p.aliases]), ...COMUNIDADES].map(key))
const small = (m) => m.population < 20000
const bearersOf = new Map()
for (const m of MUNICIPIOS) for (const n of [m.name, ...m.aliases]) bearersOf.set(key(n), [...(bearersOf.get(key(n)) ?? []), m])
// Names a test column can use: small municipios that share nothing with a person, a region or a
// large homonym, so the expected answer is unambiguous.
const SMALL_NAMES = MUNICIPIOS
  .filter((m) => small(m) && !m.name.includes('/') && !PERSONAL.has(key(m.name)) && !REGIONS.has(key(m.name)) && bearersOf.get(key(m.name)).every(small))
  .map((m) => m.name)
const LARGE_NAMES = MUNICIPIOS.filter((m) => !small(m)).map((m) => m.name)

const pad = (n, w) => String(n).padStart(w, '0')
const digits = (n) => many(() => int(0, 9), n).join('')
const dni = () => { const n = int(1000000, 99999999); return `${pad(n, 8)}${LETTERS_23[n % 23]}` }
const dniDotted = () => { const n = int(10000000, 99999999); const s = String(n); return `${s.slice(0, 2)}.${s.slice(2, 5)}.${s.slice(5)}-${LETTERS_23[n % 23]}` }
const nie = () => { const p = int(0, 2); const n = int(0, 9999999); return `${'XYZ'[p]}${pad(n, 7)}${LETTERS_23[Number(`${p}${pad(n, 7)}`) % 23]}` }
const companyNif = () => `${pick(['A', 'B', 'B', 'B', 'G', 'Q'])}${digits(7)}${int(0, 9)}`
const nss = () => {
  const p = pad(int(1, 52), 2)
  const n = pad(int(1, 99999999), 8)
  const x = Number(n) < 1e7 ? BigInt(n) + BigInt(p) * 10000000n : BigInt(p + n)
  return `${p}${n}${pad(Number(x % 97n), 2)}`
}
const BANKS = ['2100', '0049', '0182', '0081', '2038', '0128', '1465', '3058', '0075', '2080']
const ccc = () => {
  const bank = `${pick(BANKS)}${digits(4)}`
  const account = digits(10)
  return `${bank}${cccDigit(`00${bank}`)}${cccDigit(account)}${account}`
}
const iban = (spaced = false) => {
  const bban = ccc()
  let r = 0
  for (const x of `${bban}142800`) r = (r * 10 + Number(x)) % 97
  const compact = `ES${pad(98 - r, 2)}${bban}`
  return spaced ? compact.replace(/(.{4})/g, '$1 ').trim() : compact
}
const rcUrban = () => {
  const base = `${digits(7)}${pick(['VK', 'VH', 'DS', 'UL', 'PB', 'BC', 'YJ'])}${digits(4)}${pick('NSEO')}${pad(int(1, 30), 4)}`
  return base + rcLetters(base)
}
const rcRural = () => {
  const base = `${pad(int(1, 52), 2)}${pad(int(1, 300), 3)}A${pad(int(1, 50), 3)}${digits(5)}0000`
  return base + rcLetters(base)
}
const cups = () => { const s = `${pick(['0021', '0022', '0031', '0026'])}${digits(12)}`; return `ES${s}${cupsLetters(s)}${random() < 0.3 ? '0F' : ''}` }
const luhn = (prefix, length) => {
  const ds = [...prefix].map(Number)
  while (ds.length < length - 1) ds.push(int(0, 9))
  const sum = ds.slice().reverse().reduce((s, d, i) => s + (i % 2 === 0 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0)
  return ds.join('') + String((10 - (sum % 10)) % 10)
}
const iso = (y0, y1) => `${int(y0, y1)}-${pad(int(1, 12), 2)}-${pad(int(1, 28), 2)}`
const fullName = () => `${pick(GIVEN)}${random() < 0.3 ? ` ${pick(GIVEN)}` : ''} ${pick(SURNAMES)} ${pick(SURNAMES)}`
const phone = () => pick([`6${digits(2)} ${digits(2)} ${digits(2)} ${digits(2)}`, `+34 6${digits(8)}`, `7${digits(8)}`, `91 ${digits(3)} ${digits(2)} ${digits(2)}`, `9${digits(8)}`])
const address = () => pick([
  `Calle ${pick(['Mayor', 'Real', 'de la Iglesia', 'Cervantes'])}, ${int(1, 99)}, ${int(1, 8)}º ${pick(['A', 'B', 'izda.'])}`,
  `Avda. de la Constitución ${int(1, 200)}, bajo`,
  `C/ San Juan ${int(1, 80)}, ${int(1, 5)}º ${int(1, 4)}ª`,
  `Plaza de España, ${int(1, 20)}`,
])
const letters = (n, from = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') => many(() => pick(from), n).join('')
const plate = () => pick([`${digits(4)} ${letters(3, 'BCDFGHJKLMNPRSTVWXYZ')}`, `${digits(4)}${letters(3, 'BCDFGHJKLMNPRSTVWXYZ')}`, `M-${digits(4)}-${letters(2)}`])
const nig = () => `${pick(['28079', '08019', '41091', '46250'])} ${pick(['41', '42', '43', '44'])} ${int(1, 2)} ${int(2015, 2026)} ${digits(7)}`

// ── Classifiers ─────────────────────────────────────────────────────────────

const SQL = { varchar: 12, char: 1, number: 2, integer: 4, date: 91, timestamp: 93, clob: 2005 }
const col = (name, type, length, values, expect) => ({ name, sqlType: SQL[type], length, values, expect })

const COLUMNS = [
  // L1 — well named
  col('DNI', 'varchar', 9, many(dni), 'ES_L1_DNI'),
  col('NIF_CLIENTE', 'varchar', 9, many(dni), 'ES_L1_DNI'),
  col('NUMERO_DOCUMENTO', 'varchar', 12, many(dniDotted), 'ES_L1_DNI'),
  col('DNI_NIE', 'varchar', 9, many((i) => (i % 3 ? dni() : nie())), 'ES_L1_DNI'),
  col('NIE', 'varchar', 9, many(nie), 'ES_L1_NIE'),
  col('PASAPORTE', 'varchar', 9, many(() => `${letters(3)}${digits(6)}`), 'ES_L1_PASAPORTE'),
  col('NUMERO_SOPORTE', 'varchar', 9, many(() => `${letters(3)}${digits(6)}`), 'ES_L1_SOPORTE_DOCUMENTO'),
  col('NUM_SEGURIDAD_SOCIAL', 'varchar', 12, many(nss), 'ES_L1_NSS'),
  col('NAF', 'varchar', 12, many(nss), 'ES_L1_NSS'),
  col('NIA', 'varchar', 10, many(() => digits(10)), 'ES_L1_CODIGO_ESTUDIANTE'),
  col('NUMERO_COLEGIADO', 'varchar', 12, many(() => `${pad(int(1, 52), 2)}${digits(5)}`), 'ES_L1_COLEGIADO'),
  col('NOMBRE', 'varchar', 30, many(() => pick(GIVEN)), 'ES_L1_NOMBRE'),
  col('PRIMER_APELLIDO', 'varchar', 30, many(() => pick(SURNAMES)), 'ES_L1_APELLIDO'),
  col('APELLIDOS', 'varchar', 60, many(() => `${pick(SURNAMES)} ${pick(SURNAMES)}`), 'ES_L1_APELLIDO'),
  col('NOMBRE_COMPLETO', 'varchar', 120, many(fullName), 'ES_L1_NOMBRE_COMPLETO'),
  col('NOMBRE_TITULAR', 'varchar', 120, many(fullName), 'ES_L1_NOMBRE_COMPLETO'),
  col('CORREO_ELECTRONICO', 'varchar', 100, many(() => `${key(pick(GIVEN))}.${int(1, 999)}@gmail.com`), 'ES_L1_EMAIL'),
  col('EMAIL', 'varchar', 100, many(() => `contacto${int(1, 999)}@empresa.es`), 'ES_L1_EMAIL'),
  col('TELEFONO', 'varchar', 16, many(phone), 'ES_L1_TELEFONO'),
  col('MOVIL', 'varchar', 16, many(() => `6${digits(8)}`), 'ES_L1_TELEFONO'),
  col('DIRECCION', 'varchar', 200, many(address), 'ES_L1_DIRECCION'),
  col('DOMICILIO', 'varchar', 200, many(address), 'ES_L1_DIRECCION'),
  col('PISO', 'varchar', 10, many(() => `${int(1, 9)}º`), 'ES_L1_DIRECCION_COMPLEMENTO'),
  col('IBAN', 'varchar', 34, many(() => iban()), 'ES_L1_CUENTA_BANCARIA'),
  col('CUENTA_CARGO', 'varchar', 34, many(() => iban(true)), 'ES_L1_CUENTA_BANCARIA'),
  col('CCC', 'varchar', 20, many(ccc), 'ES_L1_CUENTA_BANCARIA'),
  col('NUMERO_TARJETA', 'varchar', 19, many(() => luhn('4', 16)), 'ES_L1_TARJETA'),
  col('MONEDERO_DIGITAL', 'varchar', 64, many(() => `bc1q${letters(38, '023456789acdefghjklmnpqrstuvwxyz')}`), 'ES_L1_BILLETERA'),
  col('IP_ORIGEN', 'varchar', 15, many(() => `${int(1, 223)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`), 'ES_L1_IP'),
  col('MAC_ADDRESS', 'varchar', 17, many(() => many(() => int(0, 255).toString(16).padStart(2, '0'), 6).join(':')), 'ES_L1_DISPOSITIVO'),
  col('IMEI', 'varchar', 15, many(() => luhn('35', 15)), 'ES_L1_DISPOSITIVO'),
  col('COOKIE_ID', 'varchar', 40, many(() => `GA1.2.${int(100000000, 999999999)}.${int(1600000000, 1799999999)}`), 'ES_L1_COOKIE'),
  col('MATRICULA', 'varchar', 10, many(plate), 'ES_L1_MATRICULA'),
  col('NUMERO_BASTIDOR', 'varchar', 17, many(() => letters(17, 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789')), 'ES_L1_VEHICULO'),
  col('REFERENCIA_CATASTRAL', 'varchar', 20, many((i) => (i % 4 ? rcUrban() : rcRural())), 'ES_L1_REFERENCIA_CATASTRAL'),
  col('CUPS', 'varchar', 22, many(cups), 'ES_L1_CUPS'),
  col('NUMERO_CONTRATO', 'varchar', 12, many(() => `CT-${int(100000, 999999)}`), 'ES_L1_CONTRATO'),
  col('USUARIO', 'varchar', 30, many(() => `${key(pick(GIVEN))}${int(1, 99)}`), 'ES_L1_USUARIO'),
  col('CONTRASENA', 'varchar', 60, many(() => `$2a$10$${letters(53, 'abcdefghijklmnopqrstuvwxyz0123456789')}`), 'ES_L1_CREDENCIAL'),
  col('FOTOGRAFIA', 'varchar', 200, many(() => `/fotos/persona_${int(1, 9999)}.jpg`), 'ES_L1_IMAGEN'),
  col('LATITUD', 'varchar', 12, many(() => `40.${int(100000, 999999)}`), 'ES_L1_GEOLOCALIZACION'),
  col('OBSERVACIONES', 'clob', 4000, many(() => `El cliente pide actualizar sus datos. DNI ${dni()}, correo ${key(pick(GIVEN))}@gmail.com.`), 'ES_L1_TEXTO_LIBRE'),

  // L1 — in the other official languages
  col('NOM', 'varchar', 30, many(() => pick(GIVEN)), 'ES_L1_NOMBRE'),
  col('COGNOMS', 'varchar', 60, many(() => `${pick(SURNAMES)} ${pick(SURNAMES)}`), 'ES_L1_APELLIDO'),
  col('ADRECA', 'varchar', 200, many(address), 'ES_L1_DIRECCION'),
  col('IZENA', 'varchar', 30, many(() => pick(GIVEN)), 'ES_L1_NOMBRE'),
  col('ABIZENAK', 'varchar', 60, many(() => `${pick(SURNAMES)} ${pick(SURNAMES)}`), 'ES_L1_APELLIDO'),
  col('ENDEREZO', 'varchar', 200, many(address), 'ES_L1_DIRECCION'),
  col('DATA_NAIXEMENT', 'date', 0, many(() => iso(1940, 2010)), 'ES_L2_FECHA_NACIMIENTO'),

  // L1 — badly named: only the values can tell
  col('CAMPO1', 'varchar', 12, many(dni), 'ES_L1_DNI'),
  col('CAMPO2', 'varchar', 30, many(() => pick(GIVEN)), 'ES_L1_NOMBRE'),
  col('CAMPO3', 'varchar', 30, many(() => pick(SURNAMES)), 'ES_L1_APELLIDO'),
  col('CAMPO4', 'varchar', 120, many(fullName), 'ES_L1_NOMBRE_COMPLETO'),
  col('CAMPO5', 'varchar', 100, many(() => `${key(pick(GIVEN))}@hotmail.com`), 'ES_L1_EMAIL'),
  col('CAMPO6', 'varchar', 16, many(() => `6${digits(8)}`), 'ES_L1_TELEFONO'),
  col('CAMPO7', 'varchar', 200, many(address), 'ES_L1_DIRECCION'),
  col('CAMPO8', 'varchar', 19, many(() => luhn('5', 16)), 'ES_L1_TARJETA'),
  col('CAMPO9', 'varchar', 15, many(() => `192.168.${int(0, 255)}.${int(1, 254)}`), 'ES_L1_IP'),
  col('CAMPO10', 'varchar', 34, many(() => iban()), 'ES_L1_CUENTA_BANCARIA'),
  col('CAMPO11', 'varchar', 12, many(nie), 'ES_L1_NIE'),
  col('CAMPO14', 'varchar', 20, many(rcUrban), 'ES_L1_REFERENCIA_CATASTRAL'),
  col('CAMPO15', 'varchar', 22, many(cups), 'ES_L1_CUPS'),
  col('CAMPO16', 'varchar', 10, many(() => `${digits(4)} ${letters(3, 'BCDFGHJKLMNPRSTVWXYZ')}`), 'ES_L1_MATRICULA'),
  col('TXT', 'clob', 4000, many(() => `Paciente ${pick(GIVEN)} ${pick(SURNAMES)}, DNI ${dni()}, móvil 6${digits(8)}.`), 'ES_L1_TEXTO_LIBRE'),

  // L2
  col('FECHA_NACIMIENTO', 'date', 0, many(() => iso(1940, 2010)), 'ES_L2_FECHA_NACIMIENTO'),
  col('FEC_NAC', 'varchar', 10, many(() => iso(1940, 2010)), 'ES_L2_FECHA_NACIMIENTO'),
  col('fechaNacimiento', 'timestamp', 0, many(() => iso(1940, 2010)), 'ES_L2_FECHA_NACIMIENTO'),
  col('ANIO_NACIMIENTO', 'number', 4, many(() => String(int(1940, 2010))), 'ES_L2_ANIO_NACIMIENTO'),
  col('EDAD', 'number', 3, many(() => String(int(0, 99))), 'ES_L2_EDAD'),
  col('FECHA_DEFUNCION', 'date', 0, many(() => iso(2000, 2025)), 'ES_L2_FECHA_EVENTO'),
  col('FECHA_ALTA', 'date', 0, many(() => iso(1990, 2025)), 'ES_L2_FECHA_EVENTO'),
  col('SEXO', 'char', 1, many(() => pick(['H', 'M'])), 'ES_L2_SEXO'),
  col('GENERO', 'varchar', 10, many(() => pick(['Femenino', 'Masculino'])), 'ES_L2_SEXO'),
  col('MUNICIPIO', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'ES_L2_MUNICIPIO'),
  col('LOCALIDAD', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'ES_L2_MUNICIPIO'),
  col('LUGAR_NACIMIENTO', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'ES_L2_MUNICIPIO'),
  col('CAMPO12', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'ES_L2_MUNICIPIO'),
  col('COD_MUNICIPIO_INE', 'varchar', 6, many(() => { const m = pick(MUNICIPIOS); return m.code + m.dc }), 'ES_L2_CODIGO_MUNICIPIO'),
  col('CODIGO_POSTAL', 'varchar', 5, many(() => pick(POSTAL).code), 'ES_L2_CODIGO_POSTAL'),
  col('CP', 'varchar', 5, many(() => pick(POSTAL).code), 'ES_L2_CODIGO_POSTAL'),
  col('NACIONALIDAD', 'varchar', 20, many(() => pick(['Española', 'Marroquí', 'Rumana', 'Colombiana'])), 'ES_L2_NACIONALIDAD'),
  col('SITUACION_ADMINISTRATIVA', 'varchar', 50, many(() => pick(['Residencia temporal', 'Solicitante de protección internacional', 'Arraigo'])), 'ES_L2_SITUACION_ADMINISTRATIVA'),
  col('ESTADO_CIVIL', 'varchar', 30, many(() => pick(['Soltero', 'Casado', 'Pareja de hecho', 'Viudo'])), 'ES_L2_ESTADO_CIVIL'),
  col('PROFESION', 'varchar', 60, many(() => pick(['Camarero', 'Enfermero', 'Albañil'])), 'ES_L2_OCUPACION'),
  col('EMPRESA_EMPLEADORA', 'varchar', 80, many(() => `Distribuciones ${int(1, 99)} S.L.`), 'ES_L2_EMPLEADOR'),
  col('NIVEL_ESTUDIOS', 'varchar', 40, many(() => pick(['Bachillerato', 'Grado universitario', 'Educación primaria'])), 'ES_L2_NIVEL_EDUCATIVO'),
  col('NOMBRE_COLEGIO', 'varchar', 80, many(() => `CEIP ${pick(['Antonio Machado', 'Miguel de Cervantes'])}`), 'ES_L2_CENTRO_EDUCATIVO'),
  col('NUMERO_HIJOS', 'number', 2, many(() => String(int(0, 8))), 'ES_L2_PERSONAS_A_CARGO'),

  // L3
  col('ETNIA', 'varchar', 60, many(() => pick(['Gitana', 'Magrebí o árabe', 'Latinoamericana', 'Blanca o europea'])), 'ES_L3_ORIGEN_ETNICO'),
  col('CAMPO13', 'varchar', 60, many(() => pick(['Gitana', 'Asiática', 'Mixta', 'Otra'])), 'ES_L3_ORIGEN_ETNICO'),
  col('RELIGION', 'varchar', 40, many(() => pick(['Católica', 'Musulmana', 'Sin religión'])), 'ES_L3_RELIGION'),
  col('OBJECION_CONCIENCIA', 'varchar', 60, many(() => pick(['Transfusiones', 'Ninguna'])), 'ES_L3_CONVICCION_FILOSOFICA'),
  col('INTENCION_VOTO', 'varchar', 40, many(() => pick(['Izquierda', 'Derecha', 'Centro'])), 'ES_L3_OPINION_POLITICA'),
  col('PARTIDO_POLITICO', 'varchar', 60, many(() => pick(['PSOE', 'PP', 'Vox', 'Sumar'])), 'ES_L3_AFILIACION_PARTIDARIA'),
  col('CUOTA_SINDICAL', 'char', 1, many(() => pick(['S', 'N'])), 'ES_L3_AFILIACION_SINDICAL'),
  col('HUELLA_DACTILAR', 'varchar', 200, many(() => letters(64, 'ABCDEF0123456789')), 'ES_L3_BIOMETRICO'),
  col('PRUEBA_ADN', 'varchar', 200, many(() => 'AGTC'.repeat(10)), 'ES_L3_GENETICO'),
  col('ORIENTACION_SEXUAL', 'varchar', 30, many(() => pick(['Heterosexual', 'Gay', 'Bisexual'])), 'ES_L3_ORIENTACION_SEXUAL'),
  col('VIDA_SEXUAL_ACTIVA', 'char', 1, many(() => pick(['S', 'N'])), 'ES_L3_VIDA_SEXUAL'),
  col('IDENTIDAD_GENERO', 'varchar', 30, many(() => pick(['Mujer trans', 'Hombre cis'])), 'ES_L3_IDENTIDAD_GENERO'),
  col('VICTIMA_VIOLENCIA_GENERO', 'char', 1, many(() => pick(['S', 'N'])), 'ES_L3_VICTIMA'),

  // SALUD
  col('NUMERO_HISTORIA_CLINICA', 'varchar', 14, many(() => String(int(100000, 9999999))), 'ES_SALUD_IDENTIFICADOR'),
  col('CIP_SNS', 'varchar', 16, many(() => `${letters(4)}${digits(12)}`), 'ES_SALUD_IDENTIFICADOR'),
  col('MUTUALIDAD', 'varchar', 40, many(() => pick(['MUFACE', 'ISFAS', 'Seguridad Social (titular)'])), 'ES_SALUD_COBERTURA'),
  col('DIAGNOSTICO', 'varchar', 8, many(() => pick(['E11.9', 'I10', 'J45.909', 'F32.1'])), 'ES_SALUD_DIAGNOSTICO'),
  col('CAUSA_MUERTE', 'varchar', 6, many(() => pick(['I219', 'C509', 'X954', 'J189'])), 'ES_SALUD_DIAGNOSTICO'),
  col('PRUEBA_SOLICITADA', 'varchar', 7, many(() => pick(['0DTJ4ZZ', 'BW03ZZZ', '4A02X4Z'])), 'ES_SALUD_PROCEDIMIENTO'),
  col('MEDICAMENTO', 'varchar', 40, many(() => pick(['Sertralina', 'Paracetamol', 'Metformina'])), 'ES_SALUD_MEDICAMENTO'),
  col('EVOLUCION', 'clob', 4000, many(() => `Paciente refiere dolor abdominal de ${int(1, 9)} días de evolución.`), 'ES_SALUD_TEXTO_CLINICO'),
  col('RESULTADO_ANALITICA', 'varchar', 12, many(() => pick(['Normal', 'Alterado'])), 'ES_SALUD_RESULTADO_PRUEBA'),
  col('PRUEBA_VIH', 'varchar', 12, many(() => pick(['Positivo', 'Negativo'])), 'ES_SALUD_VIH'),
  col('GRUPO_SANGUINEO', 'varchar', 4, many(() => pick(['A+', '0-', 'AB+', 'O+'])), 'ES_SALUD_GRUPO_SANGUINEO'),
  col('GRADO_DISCAPACIDAD', 'varchar', 40, many(() => pick(['Física', 'Visual', 'Intelectual', 'Sin discapacidad reconocida'])), 'ES_SALUD_DISCAPACIDAD'),
  col('GRADO_DEPENDENCIA', 'varchar', 40, many(() => pick(['Grado I - Dependencia moderada', 'Grado III - Gran dependencia'])), 'ES_SALUD_DEPENDENCIA'),
  col('BAJA_MEDICA', 'char', 1, many(() => pick(['S', 'N'])), 'ES_SALUD_LABORAL'),
  col('EMBARAZADA', 'char', 1, many(() => pick(['S', 'N'])), 'ES_SALUD_REPRODUCTIVA'),
  col('TRASTORNO_MENTAL', 'varchar', 60, many(() => pick(['Depresión', 'Ansiedad'])), 'ES_SALUD_MENTAL'),

  // FIN
  col('FICHERO_MOROSOS', 'varchar', 40, many(() => pick(['Incluido en fichero de morosos', 'Sin incidencias'])), 'ES_FIN_HISTORIAL_CREDITICIO'),
  col('SALDO_DEUDOR', 'number', 12, many(() => String(int(100, 200000))), 'ES_FIN_DEUDA'),
  col('SALARIO_BRUTO_ANUAL', 'number', 10, many(() => String(int(15000, 90000))), 'ES_FIN_INGRESOS'),
  col('VALOR_CATASTRAL', 'number', 12, many(() => String(int(30000, 900000))), 'ES_FIN_PATRIMONIO'),
  col('IMPORTE_PENSION', 'number', 8, many(() => String(int(600, 3300))), 'ES_FIN_PENSION'),
  col('BENEFICIARIO_IMV', 'char', 1, many(() => pick(['S', 'N'])), 'ES_FIN_PRESTACION_SOCIAL'),
  col('BASE_IMPONIBLE', 'number', 12, many(() => String(int(5000, 150000))), 'ES_FIN_TRIBUTARIO'),

  // PENAL
  col('ANTECEDENTES_PENALES', 'varchar', 60, many(() => pick(['Sin antecedentes penales', 'Con antecedentes penales'])), 'ES_PENAL_ANTECEDENTES'),
  col('CERTIFICADO_DELITOS_SEXUALES', 'varchar', 40, many(() => pick(['Certificado negativo aportado', 'No aportado'])), 'ES_PENAL_DELITOS_SEXUALES'),
  col('NIG', 'varchar', 24, many(nig), 'ES_PENAL_PROCEDIMIENTO'),
  col('PUNTOS_CARNE', 'number', 2, many(() => String(int(0, 15))), 'ES_PENAL_SANCION_ADMINISTRATIVA'),

  // Not personal data: nothing should be assigned
  col('ID', 'integer', 10, many((i) => String(i + 1)), ''),
  col('RUTA_ARCHIVO', 'varchar', 200, many(() => `/datos/archivo${int(1, 99)}.txt`), ''),
  col('NOMBRE_PRODUCTO', 'varchar', 80, many(() => pick(['Aceite de oliva virgen extra 1 l', 'Jamón serrano loncheado 100 g', 'Turrón de Jijona 200 g'])), ''),
  col('IMPORTE_VENTA', 'number', 12, many(() => String(int(1000, 99999999))), ''),
  col('FECHA_CREACION', 'date', 0, many(() => iso(2015, 2025)), ''),
  col('FECHA_FACTURA', 'date', 0, many(() => iso(2015, 2025)), ''),
  col('CODIGO', 'varchar', 10, many(() => `A-${int(100, 999)}`), ''),
  col('DESCRIPCION_PRODUCTO', 'varchar', 400, many(() => 'Producto de consumo, envase de cartón reciclable.'), ''),
  col('ESTADO', 'varchar', 10, many(() => pick(['ACTIVO', 'INACTIVO'])), ''),
  col('CANTIDAD', 'number', 6, many(() => String(int(1, 500))), ''),
  col('SKU', 'varchar', 12, many(() => `SKU${int(10000, 99999)}`), ''),
  col('ID_TRANSACCION', 'varchar', 36, many(() => `TX${int(100000, 999999)}`), ''),
  col('AREA', 'varchar', 40, many(() => pick(['Financiera', 'Operaciones'])), ''),
  col('PROVINCIA', 'varchar', 30, many(() => pick(PROVINCIAS).name), ''),
  col('COMUNIDAD_AUTONOMA', 'varchar', 40, many(() => pick(COMUNIDADES)), ''),
  col('COD_ENTIDAD_BANCARIA', 'varchar', 4, many(() => pick(BANKS)), ''),
  col('URL_PAGINA', 'varchar', 200, many(() => `https://www.ejemplo.es/p/${int(1, 999)}`), ''),
  col('TIPO_DOCUMENTO', 'varchar', 6, many(() => pick(['DNI', 'NIE', 'PAS', 'NIF'])), ''),
  col('MONEDA', 'varchar', 3, many(() => pick(['EUR', 'USD', 'GBP'])), ''),
  col('CATEGORIA', 'varchar', 30, many(() => pick(['Alimentación', 'Droguería'])), ''),
  col('CODIGO_CNAE', 'varchar', 4, many(() => pick(['4711', '6201', '8621'])), ''),
  col('IDIOMA_INTERFAZ', 'varchar', 5, many(() => pick(['es-ES', 'ca', 'eu', 'gl'])), ''),
  col('VALOR_DEFECTO', 'varchar', 20, many(() => pick(['0', 'N/A', 'true'])), ''),
  col('ORDEN', 'number', 4, many(() => String(int(1, 99))), ''),
  col('ESTADO_PEDIDO', 'varchar', 10, many(() => pick(['Abierto', 'Cerrado', 'Pendiente'])), ''),
  col('ID_MENSAJE', 'varchar', 36, many(() => `MSG${int(100000, 999999)}`), ''),
  col('FECHA_FIN', 'date', 0, many(() => iso(2015, 2025)), ''),
  col('NOMBRE_ARCHIVO', 'varchar', 60, many(() => `informe_${int(1, 99)}.pdf`), ''),
  col('PESO_KG', 'number', 6, many(() => `${int(1, 99)}.5`), ''),
  // The NIF of a company is no one's personal data: article 4.1 of the Reglamento reaches natural
  // persons, and the set must leave the column alone.
  col('NIF_EMPRESA', 'varchar', 9, many(companyNif), ''),
  col('CIF_PROVEEDOR', 'varchar', 9, many(companyNif), ''),
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

// ── Municipios, codes and postal codes, offline ─────────────────────────────
//
// The invariants:
//   · a name all of whose bearers — municipios, provinces and comunidades alike — are under 20,000
//     is generalized, to the name of a municipio of at least 20,000 in the same province;
//   · a name any of whose bearers is large is left alone;
//   · written with its province, the same rule applies inside it, and the province stays;
//   · the INE code of a small municipio — with or without its check digit — becomes the code of a
//     large municipio of the same province, and the check digit is that municipio's own;
//   · a postal code whose main municipio is small becomes a postal code of a large municipio, and
//     keeps the two digits of its province.

const readTable = (name) => new Map(fs.readFileSync(nodePath.join(HERE, 'files', name), 'utf8').split('\n').filter(Boolean).map((l) => l.split('|')))

function verifyGeneralization() {
  const table = readTable('es-municipios-generalizados.txt')
  const codes = readTable('es-codigos-municipio-generalizados.txt')
  const postal = readTable('es-codigos-postales-generalizados.txt')
  const byCode = new Map(MUNICIPIOS.map((m) => [m.code, m]))
  const byCodeDc = new Map(MUNICIPIOS.map((m) => [m.code + m.dc, m]))
  const provinceOf = new Map(PROVINCIAS.map((p) => [p.code, p]))

  const LARGE_KEYS = new Set([...MUNICIPIOS.filter((m) => !small(m)).flatMap((m) => [m.name, ...m.aliases]), ...REGIONS].map(key))
  const largeIn = new Map()
  for (const m of MUNICIPIOS.filter((x) => !small(x))) for (const n of [m.name, ...m.aliases]) largeIn.set(`${key(n)}|${m.provinceCode}`, m)
  const provinceByName = new Map(PROVINCIAS.map((p) => [key(p.name), p]))
  // "Name (Province)" or "Name, Province" — the name itself may hold a comma, as the INE writes
  // "Ballestero, El".
  const split = (v) => {
    if (v.endsWith(')')) { const i = v.lastIndexOf(' ('); if (i > 0 && provinceByName.has(key(v.slice(i + 2, -1)))) return [v.slice(0, i), v.slice(i + 2, -1)] }
    const i = v.lastIndexOf(', ')
    if (i > 0 && provinceByName.has(key(v.slice(i + 2)))) return [v.slice(0, i), v.slice(i + 2)]
    return null
  }

  let badTargets = 0
  for (const [from, to] of table) {
    const q = split(to)
    const fq = split(from)
    // A qualified source keeps its province; an unqualified one may be a name like "Ballestero, El".
    const ok = q && fq ? largeIn.has(`${key(q[0])}|${provinceByName.get(key(q[1])).code}`) && key(fq[1]) === key(q[1]) : LARGE_KEYS.has(key(to))
    if (!ok) { badTargets++; if (badTargets <= 10) console.log(`  ✗ table: ${from} → ${to} is not a municipio of 20,000 (in its province)`) }
  }
  if (badTargets) failures++
  else console.log(`table: ${table.size} lines, every replacement names a municipio of at least 20,000, in the same province when it is written`)

  let ok = 0
  let keptByHomonym = 0
  let shown = 0
  for (const m of MUNICIPIOS) {
    const problems = []
    const province = provinceOf.get(m.provinceCode)
    const code = codes.get(m.code)
    const codeDc = codes.get(m.code + m.dc)
    const plainName = !m.name.includes('/')
    if (!small(m)) {
      if (table.get(m.name) || code || codeDc) problems.push('a large municipio is generalized')
    } else {
      const bearers = [...bearersOf.get(key(m.name)), ...(REGIONS.has(key(m.name)) ? [{ population: Infinity }] : [])]
      if (bearers.every(small)) {
        const to = table.get(m.name)
        if (!to) problems.push('not in the table by name')
        else if (plainName && !largeIn.has(`${key(to)}|${m.provinceCode}`)) {
          // A homonym in another province may have decided the fate of the name.
          const fate = bearers.reduce((a, b) => (b.population > a.population ? b : a))
          if (fate.provinceCode === m.provinceCode) problems.push(`goes to ${to}, outside its province`)
        }
      } else {
        keptByHomonym++
        if (table.get(m.name)) problems.push('a name shared with a large place is generalized')
      }
      // With its province beside it the province decides, and the name stays in it.
      const qualified = `${m.name} (${province.name})`
      const inside = MUNICIPIOS.filter((x) => key(x.name) === key(m.name) && x.provinceCode === m.provinceCode)
      if (inside.every(small) && !LARGE_KEYS.has(key(m.name))) {
        const to = table.get(qualified)
        if (!to) problems.push(`not in the table as "${qualified}"`)
        else if (!largeIn.has(`${key(to.slice(0, to.lastIndexOf(' (')))}|${m.provinceCode}`)) problems.push(`"${qualified}" → ${to}`)
      }
      const target = code && byCode.get(code)
      if (!target || small(target)) problems.push(`code ${m.code} → ${code}`)
      else if (target.provinceCode !== m.provinceCode) problems.push(`the code left its province: ${code}`)
      const targetDc = codeDc && byCodeDc.get(codeDc)
      if (!targetDc || targetDc !== target) problems.push(`code with check digit ${m.code}${m.dc} → ${codeDc}`)
    }
    if (problems.length) { failures++; if (shown++ < 15) console.log(`  ✗ ${m.name}/${m.province} (${m.population}): ${problems.join('; ')}`) }
    else ok++
  }
  console.log(`municipios: ${ok} of ${MUNICIPIOS.length} as expected (${MUNICIPIOS.filter(small).length} under 20,000, ${keptByHomonym} small ones keep their name because a homonym or a region is large)`)

  // Postal codes: the code of a small municipio becomes a code of a large one of the same province.
  let postalOk = 0
  let postalShown = 0
  const largeCodes = new Map()
  for (const c of POSTAL) largeCodes.set(c.code, byCode.get(c.municipios[0]))
  for (const c of POSTAL) {
    const main = byCode.get(c.municipios[0])
    const to = postal.get(c.code)
    let problem = null
    if (!small(main)) { if (to) problem = 'the code of a large municipio is generalized' }
    else if (!to) problem = 'not in the table'
    else if (to.slice(0, 2) !== c.code.slice(0, 2)) problem = `left its province: ${to}`
    else if (!largeCodes.get(to) || small(largeCodes.get(to))) problem = `${to} is not a code of a large municipio`
    if (problem) { failures++; if (postalShown++ < 10) console.log(`  ✗ postal code ${c.code} (${main.name}): ${problem}`) }
    else postalOk++
  }
  console.log(`postal codes: ${postalOk} of ${POSTAL.length} as expected (${postal.size} generalized)`)

  // Every province keeps its name and holds a target.
  let provOk = 0
  for (const p of PROVINCIAS) {
    const problems = []
    if (!MUNICIPIOS.some((m) => m.provinceCode === p.code && !small(m))) problems.push('no municipio of 20,000')
    if (table.get(p.name)) problems.push('a province is generalized')
    if (problems.length) { failures++; console.log(`  ✗ province ${p.name}: ${problems.join('; ')}`) }
    else provOk++
  }
  console.log(`provinces: ${provOk} of ${PROVINCIAS.length} kept, each with a target of its own`)
}

// ── Algorithms ──────────────────────────────────────────────────────────────

const words = (s) => s.trim().split(/\s+/).length
const sameShape = (i, o) => i.length === o.length && i.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9') === o.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9')
const digitShape = (i, o) => i.length === o.length && i.replace(/\d/g, '9') === o.replace(/\d/g, '9')
const coarse = (v) => v.split(/\s*,\s*/).map((part) => part.slice(0, part.search(/[.,]/) + 2)).join(',')
const MASKING = {
  ES_L1_DNI: {
    inputs: ['12345678Z', '12345678-z', '12.345.678-Z', '1234567L', 'X1234567L', 'K1234567S', 'B12345674', '12345678', ...many(dni, 6), ...many(dniDotted, 2)],
    // A company's NIF is nobody's personal datum: it comes back as it went in.
    keeps: (i) => /^[A-W]\d{7}[0-9A-J]$/.test(i) && !/^[KLM]/.test(i),
    check: (i, o) => {
      if (/^[ABCDEFGHJNPQRSUVW]/.test(i)) return o === i
      if (/^\d{8}$/.test(i)) return digitShape(i, o)
      return validDni(o) && digitShape(i.replace(/[A-Za-z]/g, '0'), o.replace(/[A-Za-z]/g, '0')) && (i[0].toUpperCase() === o[0].toUpperCase() || /\d/.test(i[0]))
    },
  },
  ES_L1_NIE: { inputs: ['X1234567L', 'Y-1234567-X', 'z1234567r', ...many(nie, 6)], check: (i, o) => validDni(o) && o[0] === i[0] && o.length === i.length },
  ES_L1_PASAPORTE: { inputs: ['PAA123456'], check: sameShape },
  ES_L1_SOPORTE_DOCUMENTO: { inputs: ['BAA123456'], check: sameShape },
  ES_L1_NSS: {
    inputs: ['281234567840', '28/12345678/40', '28 12345678 40', '080123456700', ...many(nss, 6)],
    check: (i, o) => validNss(o) && digitShape(i, o) && o.slice(0, 2) === i.slice(0, 2),
  },
  ES_L1_CODIGO_ESTUDIANTE: { inputs: ['2012345678'], check: sameShape },
  ES_L1_COLEGIADO: { inputs: ['2812345'], check: sameShape },
  ES_L1_NOMBRE: { inputs: ['Lucía', 'JOSÉ ANTONIO', 'María de los Ángeles'], check: (i, o) => words(i) === words(o) && (!/ de /.test(i) || / de /.test(o)) },
  ES_L1_APELLIDO: { inputs: ['García', 'FERNÁNDEZ LÓPEZ', 'de la Fuente'], check: (i, o) => words(i) === words(o) },
  ES_L1_NOMBRE_COMPLETO: {
    inputs: ['Lucía García', 'JOSÉ ANTONIO GARCÍA', 'José Antonio García Fernández', 'María de los Ángeles Pérez López', 'GARCÍA FERNÁNDEZ, JOSÉ ANTONIO'],
    check: (i, o) => words(i) === words(o) && [' de ', ' de los '].every((w) => i.includes(w) === o.includes(w)),
  },
  ES_L1_EMAIL: { inputs: ['lucia.garcia@gmail.com', 'josé.muñoz@empresa.es'], check: (i, o) => /@[^@]+\.test$/.test(o) },
  ES_L1_TELEFONO: {
    inputs: ['+34 612 34 56 78', '612345678', '91 123 45 67', '0034 712345678'],
    // The country code and the first digit stay, so a masked number still says mobile or landline.
    check: (i, o) => digitShape(i, o) && o.replace(/\D/g, '').slice(-9)[0] === i.replace(/\D/g, '').slice(-9)[0] && o !== i,
  },
  ES_L1_DIRECCION: { inputs: ['Calle Mayor, 12, 3º B', 'Avda. de la Constitución 45, bajo'] },
  ES_L1_DIRECCION_COMPLEMENTO: { inputs: ['3º B', 'Escalera 2'] },
  ES_L1_CUENTA_BANCARIA: {
    inputs: ['ES9121000418450200051332', 'ES91 2100 0418 4502 0005 1332', '21000418450200051332', '2100 0418 45 0200051332', ...many(() => iban(), 4), ...many(() => iban(true), 3), ...many(ccc, 3)],
    check: (i, o) => {
      const bank = (v) => v.replace(/\s/g, '').replace(/^ES\d{2}/, '').slice(0, 8)
      return (/^ES/.test(i) ? validIban(o) : validCcc(o)) && bank(o) === bank(i) && digitShape(i, o)
    },
  },
  ES_L1_TARJETA: { inputs: ['4532 0000 0000 0001'] },
  ES_L1_BILLETERA: { inputs: ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'], check: sameShape },
  ES_L1_IP: { inputs: ['83.45.120.12', '2a02:9000::1'], check: (i, o) => (i.includes('.') ? o.split('.').every((p) => Number(p) >= 1 && Number(p) <= 254) : /^[0-9a-f:]+$/i.test(o)) },
  ES_L1_DISPOSITIVO: { inputs: ['3c:22:fb:9a:10:e4', '356938035643809'], check: (i, o) => (i.includes(':') ? /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(o) : /^\d{15}$/.test(o)) },
  ES_L1_COOKIE: { inputs: ['GA1.2.123456789.1700000000'], check: sameShape },
  ES_L1_MATRICULA: {
    inputs: ['1234 BCD', '1234BCD', 'M-1234-AB', 'E-1234-BCD'],
    // The current series has no vowels, Ñ or Q, and keeps them out; a provincial plate keeps its province.
    check: (i, o) => sameShape(i, o) && (!/^\d{4}/.test(i) || !/[AEIOUÑQ]/.test(o)) && (!/^[A-Z]+-/.test(i) || o.split('-')[0] === i.split('-')[0]),
  },
  ES_L1_VEHICULO: { inputs: ['VSSZZZ6JZ9R123456'], check: sameShape },
  ES_L1_REFERENCIA_CATASTRAL: {
    inputs: ['9872023VH5797S0001WX', '8943507PB5284S0001KR', '5991807UL6359S0001KP', '3697301BC4839N0001KF', ...many(rcUrban, 4), ...many(rcRural, 2)],
    // Urban: the sheet and the unit stay; rural: municipio, sector, polígono and unit stay.
    check: (i, o) => validRc(o) && (/^\d{5}[A-Z]/.test(i) ? o.slice(0, 9) === i.slice(0, 9) && o.slice(14, 18) === i.slice(14, 18) : o.slice(7, 18) === i.slice(7, 18)),
  },
  ES_L1_CUPS: { inputs: ['ES1234123456789012JY', 'ES0021000000000001JN0F', ...many(cups, 4)], check: (i, o) => validCups(o) && o.slice(0, 6) === i.slice(0, 6) && o.length === i.length },
  ES_L1_CONTRATO: { inputs: ['CT-123456'] },
  ES_L1_USUARIO: { inputs: ['@lucia_garcia'] },
  ES_L1_CREDENCIAL: { inputs: ['Clave#2024'], check: (i, o) => /^X+$/.test(o) },
  ES_L1_IMAGEN: { inputs: ['/fotos/persona_12.jpg'], check: (i, o) => /^X+$/.test(o) },
  // The integer part and the first decimal stay — about 11 km.
  ES_L1_GEOLOCALIZACION: { inputs: ['40.416775', '40.416775,-3.703790'], check: (i, o) => coarse(o) === coarse(i) },
  ES_L1_TEXTO_LIBRE: {
    inputs: ['Cliente García, DNI 12345678Z, correo l.garcia@gmail.com, móvil 612345678.'],
    check: (i, o) => !/12345678Z|l\.garcia@gmail\.com|612345678|García/.test(o),
  },
  ES_L2_FECHA_NACIMIENTO: { inputs: ['1985-07-20', '2012-01-15'], check: (i, o) => Math.abs(new Date(o.slice(0, 10)) - new Date(i)) <= 60 * 864e5 },
  ES_L2_ANIO_NACIMIENTO: { inputs: ['1985'], check: (i, o) => o.startsWith('198'), same: true },
  ES_L2_EDAD: { inputs: ['37', '7', '104'], check: (i, o) => (i === '104' ? o === '90' : i.length === 1 || o[0] === i[0]), same: true },
  ES_L2_FECHA_EVENTO: { inputs: ['2021-03-15'] },
  ES_L2_SEXO: { inputs: ['H', 'M', 'V', 'F', 'Femenino', 'masculino', 'Hombre', '1'], same: true },
  ES_L2_MUNICIPIO: { inputs: ['Valdelageve', 'Madrid', 'MÓSTOLES', 'Valdelageve (Salamanca)', 'Alacant', 'Alicante', 'La Guijarrosa', 'Elche'], same: true },
  // 37334 Valdelageve is small and moves; 28079 Madrid and 03065 Elx are large and stay.
  ES_L2_CODIGO_MUNICIPIO: { inputs: ['37334', `37334${MUNICIPIOS.find((m) => m.code === '37334').dc}`, '28079', '03065'], same: true },
  ES_L2_CODIGO_POSTAL: { inputs: ['37766', '28013', '42193'], same: true },
  ES_L2_NACIONALIDAD: { inputs: ['Georgiana'], same: true },
  ES_L2_SITUACION_ADMINISTRATIVA: { inputs: ['Residencia en trámite', 'S'], same: true },
  ES_L2_ESTADO_CIVIL: { inputs: ['Unión de hecho', '2'], same: true },
  ES_L2_OCUPACION: { inputs: ['Director de operaciones', '2211'] },
  ES_L2_EMPLEADOR: { inputs: ['Corporación Industrial del Atlántico S.A.'] },
  ES_L2_NIVEL_EDUCATIVO: { inputs: ['Licenciatura en curso', '7'], same: true },
  ES_L2_CENTRO_EDUCATIVO: { inputs: ['Universidad de Salamanca'] },
  ES_L2_PERSONAS_A_CARGO: { inputs: ['9', '2'], check: (i, o) => Number(o) <= 5, same: true },
  ES_L3_ORIGEN_ETNICO: { inputs: ['Afrodescendiente', '3', 'N'], same: true },
  ES_L3_RELIGION: { inputs: ['Anglicana', 'N'], same: true },
  ES_L3_CONVICCION_FILOSOFICA: { inputs: ['Objetor a transfusiones'] },
  ES_L3_OPINION_POLITICA: { inputs: ['Progresista', '7'], same: true },
  ES_L3_AFILIACION_PARTIDARIA: { inputs: ['Ciudadanos', 'S'], same: true },
  ES_L3_AFILIACION_SINDICAL: { inputs: ['CCOO', 'S'], same: true },
  ES_L3_BIOMETRICO: { inputs: ['A1B2C3D4E5F6'] },
  ES_L3_GENETICO: { inputs: ['BRCA1 positivo'] },
  ES_L3_ORIENTACION_SEXUAL: { inputs: ['Homosexual'], same: true },
  ES_L3_VIDA_SEXUAL: { inputs: ['Activa'] },
  ES_L3_IDENTIDAD_GENERO: { inputs: ['Transgénero'], same: true },
  ES_L3_VICTIMA: { inputs: ['Violencia de género', 'S'], same: true },
  ES_SALUD_IDENTIFICADOR: { inputs: ['BBBB123456789012', 'AN1234567890'], check: sameShape },
  ES_SALUD_COBERTURA: { inputs: ['MUFACE', '12345'], same: true },
  ES_SALUD_DIAGNOSTICO: { inputs: ['F33.1', 'B24', 'E119', 'Depresión mayor'], same: true },
  ES_SALUD_PROCEDIMIENTO: { inputs: ['0DTJ4ZZ', '901234', 'Determinación de carga viral de VIH'], same: true },
  ES_SALUD_MEDICAMENTO: { inputs: ['Sertralina 50 mg'] },
  ES_SALUD_TEXTO_CLINICO: { inputs: ['Paciente García, DNI 12345678Z, consulta por cefalea.'], check: (i, o) => !o.includes('12345678Z') },
  ES_SALUD_RESULTADO_PRUEBA: { inputs: ['Positivo'] },
  ES_SALUD_VIH: { inputs: ['Positivo', 'S'], same: true },
  ES_SALUD_GRUPO_SANGUINEO: { inputs: ['O+'], same: true },
  ES_SALUD_DISCAPACIDAD: { inputs: ['Trastorno del espectro autista', 'N'], same: true },
  ES_SALUD_DEPENDENCIA: { inputs: ['Grado II nivel 1', '2'], same: true },
  ES_SALUD_LABORAL: { inputs: ['No apto temporal', 'S'], same: true },
  ES_SALUD_REPRODUCTIVA: { inputs: ['12 semanas de gestación', 'S'], same: true },
  ES_SALUD_MENTAL: { inputs: ['Trastorno bipolar'] },
  ES_FIN_HISTORIAL_CREDITICIO: { inputs: ['Incluido en ASNEF', '745', 'N'], same: true },
  ES_FIN_DEUDA: { inputs: ['18500'] },
  ES_FIN_INGRESOS: { inputs: ['28500'] },
  ES_FIN_PATRIMONIO: { inputs: ['185000'] },
  ES_FIN_PENSION: { inputs: ['1250'] },
  ES_FIN_PRESTACION_SOCIAL: { inputs: ['Ayuda de emergencia social', 'S'], same: true },
  ES_FIN_TRIBUTARIO: { inputs: ['-1240.55', '24350', '31000,10'], check: (i, o) => /^-/.test(i) === /^-/.test(o) && /[.,]\d+$/.test(i) === /[.,]\d+$/.test(o) },
  ES_PENAL_ANTECEDENTES: { inputs: ['Condenado por hurto en 2019', 'S'], same: true },
  ES_PENAL_DELITOS_SEXUALES: { inputs: ['Certificado positivo', 'S'], same: true },
  ES_PENAL_PROCEDIMIENTO: {
    inputs: ['28079 43 2 2023 0012345', 'PA 123/2023', '456/2024'],
    check: (i, o) => digitShape(i, o) && o.replace(/\d/g, '') === i.replace(/\d/g, '') && o.slice(0, -7) === i.slice(0, -7) || (!/^\d{5} /.test(i) && digitShape(i, o)),
  },
  ES_PENAL_SANCION_ADMINISTRATIVA: { inputs: ['Multa de tráfico por exceso de velocidad', '12', 'N'], same: true },
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
const PARTICLE = /^(de|del|la|las|los|y|i|e|san|santa)$/i
const EXPECT = {
  ES_L1_NOMBRE: (i, o) => o.split(/\s+/).every((w) => PARTICLE.test(w) || has('es-nombres.txt', w)),
  ES_L1_APELLIDO: (i, o) => o.split(/\s+/).every((w) => PARTICLE.test(w) || has('es-apellidos.txt', w)),
  ES_L1_NOMBRE_COMPLETO: (i, o) => i.includes(',') || (has('es-nombres.txt', o.split(/\s+/)[0]) && has('es-apellidos.txt', o.split(/\s+/).at(-1))),
  ES_L1_DIRECCION: (i, o) => has('es-direcciones.txt', o),
  ES_L2_SEXO: (i, o) => ({ h: ['h', 'm'], m: ['h', 'm'], v: ['v', 'm'], f: ['f', 'm'], femenino: ['femenino', 'masculino'], masculino: ['femenino', 'masculino'], hombre: ['mujer', 'hombre'], 1: ['1', '2'] })[i.toLowerCase()].includes(o.toLowerCase()),
  // Valdelageve (Salamanca, a few dozen people) becomes a large municipio of Salamanca; Madrid,
  // Móstoles, Alacant and its Castilian name, and Elche are large and stay; La Guijarrosa, created
  // in 2018, moves; written with its province it keeps that shape.
  ES_L2_MUNICIPIO: (i, o) => ({
    Madrid: o === 'Madrid',
    MÓSTOLES: o === 'MÓSTOLES',
    Alacant: o === 'Alacant',
    Alicante: o === 'Alicante',
    Elche: o === 'Elche',
    'Valdelageve (Salamanca)': / \(Salamanca\)$/.test(o) && LARGE.has(o.replace(/ \(Salamanca\)$/, '').toLowerCase()),
  })[i] ?? LARGE.has(o.toLowerCase()),
  ES_L2_CODIGO_MUNICIPIO: (i, o) => {
    const m = MUNICIPIOS.find((x) => x.code === i.slice(0, 5))
    if (!small(m)) return o === i
    const t = MUNICIPIOS.find((x) => x.code === o.slice(0, 5))
    return t && !small(t) && t.provinceCode === m.provinceCode && o.length === i.length && (i.length === 5 || o.slice(5) === t.dc)
  },
  ES_L2_CODIGO_POSTAL: (i, o) => {
    const main = MUNICIPIOS.find((x) => x.code === POSTAL.find((c) => c.code === i).municipios[0])
    return small(main) ? o.slice(0, 2) === i.slice(0, 2) && o !== i : o === i
  },
  ES_L2_NACIONALIDAD: (i, o) => has('es-nacionalidades.txt', o),
  ES_L2_SITUACION_ADMINISTRATIVA: (i, o) => flag(i, o) ?? has('es-situacion-administrativa.txt', o),
  ES_L2_ESTADO_CIVIL: (i, o) => (/^\d$/.test(i) ? /^[1-6]$/.test(o) : has('es-estado-civil.txt', o)),
  ES_L2_OCUPACION: (i, o) => (/^\d+$/.test(i) ? /^\d{4}$/.test(o) : has('es-ocupaciones.txt', o)),
  ES_L2_EMPLEADOR: (i, o) => has('es-empleadores.txt', o),
  ES_L2_NIVEL_EDUCATIVO: (i, o) => (/^\d+$/.test(i) ? has('es-nivel-educativo-codigos.txt', o) : has('es-nivel-educativo.txt', o)),
  ES_L2_CENTRO_EDUCATIVO: (i, o) => has('es-centros-educativos.txt', o),
  ES_L3_ORIGEN_ETNICO: (i, o) => flag(i, o) ?? (/^\d$/.test(i) ? has('es-origen-etnico-codigos.txt', o) : has('es-origen-etnico.txt', o)),
  ES_L3_RELIGION: (i, o) => flag(i, o) ?? has('es-religiones.txt', o),
  ES_L3_CONVICCION_FILOSOFICA: (i, o) => o === SUPPRESSED,
  ES_L3_OPINION_POLITICA: (i, o) => (/^\d+$/.test(i) ? has('es-opiniones-politicas-codigos.txt', o) : has('es-opiniones-politicas.txt', o)),
  ES_L3_AFILIACION_PARTIDARIA: (i, o) => flag(i, o) ?? has('es-partidos.txt', o),
  ES_L3_AFILIACION_SINDICAL: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  ES_L3_ORIENTACION_SEXUAL: (i, o) => has('es-orientaciones-sexuales.txt', o),
  ES_L3_VIDA_SEXUAL: (i, o) => o === SUPPRESSED,
  ES_L3_IDENTIDAD_GENERO: (i, o) => has('es-identidades-genero.txt', o),
  ES_L3_VICTIMA: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  ES_SALUD_COBERTURA: (i, o) => (/^\d+$/.test(i) ? digitShape(i, o) : has('es-cobertura-salud.txt', o)),
  ES_SALUD_DIAGNOSTICO: (i, o) => (/^[A-Z]\d/.test(i) ? has(i.includes('.') ? 'es-cie10-decimal.txt' : 'es-cie10.txt', o) : has('es-diagnosticos.txt', o)),
  ES_SALUD_PROCEDIMIENTO: (i, o) => (/^[0-9A-Z]{7}$/.test(i) ? sameShape(i, o) : /^\d+$/.test(i) ? digitShape(i, o) : has('es-procedimientos.txt', o)),
  ES_SALUD_MEDICAMENTO: (i, o) => has('es-medicamentos.txt', o),
  ES_SALUD_VIH: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  ES_SALUD_GRUPO_SANGUINEO: (i, o) => has('es-grupos-sanguineos.txt', o),
  ES_SALUD_DISCAPACIDAD: (i, o) => flag(i, o) ?? has('es-discapacidades.txt', o),
  ES_SALUD_DEPENDENCIA: (i, o) => (/^\d$/.test(i) ? has('es-dependencia-codigos.txt', o) : has('es-dependencia.txt', o)),
  ES_SALUD_LABORAL: (i, o) => flag(i, o) ?? has('es-aptitud-laboral.txt', o),
  ES_SALUD_REPRODUCTIVA: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  ES_SALUD_MENTAL: (i, o) => o === SUPPRESSED,
  ES_FIN_HISTORIAL_CREDITICIO: (i, o) => flag(i, o) ?? (/^\d+$/.test(i) ? digitShape(i, o) : has('es-estados-credito.txt', o)),
  ES_FIN_PRESTACION_SOCIAL: (i, o) => flag(i, o) ?? has('es-prestaciones-sociales.txt', o),
  ES_PENAL_ANTECEDENTES: (i, o) => flag(i, o) ?? has('es-antecedentes.txt', o),
  ES_PENAL_DELITOS_SEXUALES: (i, o) => flag(i, o) ?? has('es-certificado-delitos-sexuales.txt', o),
  ES_PENAL_SANCION_ADMINISTRATIVA: (i, o) => flag(i, o) ?? (/^\d+$/.test(i) ? /^\d+$/.test(o) : has('es-sanciones-administrativas.txt', o)),
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
  const TYPED = new Set(['ES_L2_FECHA_NACIMIENTO', 'ES_L2_FECHA_EVENTO', 'ES_FIN_DEUDA', 'ES_FIN_INGRESOS', 'ES_FIN_PATRIMONIO', 'ES_FIN_PENSION'])
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

  /** Many distinct valid inputs must give as many distinct valid outputs, of the same shape. */
  async function bulk(label, algorithmName, make, n, valid, kept) {
    const inputs = [...new Set(many(make, n))]
    const out = new Set()
    let bad = 0
    let notKept = 0
    let i = 0
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (i < inputs.length) {
        const input = inputs[i++]
        const { output } = await run(algorithmName, input)
        out.add(output)
        if (!output || !valid(output) || output === input || output.length !== input.length) bad++
        else if (kept && kept(input) !== kept(output)) notKept++
      }
    }))
    if (out.size !== inputs.length || bad || notKept) { failures++; console.log(`  ✗ ${label}: ${inputs.length} inputs gave ${out.size} distinct outputs, ${bad} invalid or unchanged, ${notKept} lost what they keep`) }
    else console.log(`${label}: ${inputs.length} distinct inputs, ${out.size} distinct valid outputs`)
  }
  await bulk('DNI', 'ES_DOCUMENTO', dni, 200, validDni)
  await bulk('DNI with dots', 'ES_DOCUMENTO', dniDotted, 50, (v) => validDni(v) && /^\d{2}\.\d{3}\.\d{3}-[A-Z]$/.test(v))
  await bulk('NIE', 'ES_DOCUMENTO', nie, 100, validDni, (v) => v[0])
  await bulk('Seguridad Social', 'ES_NSS', nss, 200, validNss, (v) => v.slice(0, 2))
  await bulk('IBAN compact', 'ES_CUENTA', () => iban(), 100, validIban, (v) => v.slice(4, 12))
  await bulk('IBAN printed in groups of four', 'ES_CUENTA', () => iban(true), 100, (v) => validIban(v) && /^ES\d{2}( \d{4}){5}$/.test(v), (v) => v.replace(/\s/g, '').slice(4, 12))
  await bulk('CCC', 'ES_CUENTA', ccc, 100, validCcc, (v) => v.slice(0, 8))
  await bulk('referencia catastral, urban', 'ES_REFERENCIA_CATASTRAL', rcUrban, 100, validRc, (v) => v.slice(7, 18))
  await bulk('referencia catastral, rural', 'ES_REFERENCIA_CATASTRAL', rcRural, 50, validRc, (v) => `${v.slice(0, 9)}${v.slice(14, 18)}`)
  await bulk('CUPS', 'ES_CUPS', cups, 100, validCups, (v) => v.slice(0, 6) + v.slice(20))
}

if (only !== 'algorithms') { verifyClassifiers(); verifyGeneralization() }
if (only !== 'classifiers') await verifyAlgorithms()
console.log(failures ? `\n${failures} problem(s)` : '\nall good')
process.exit(failures ? 1 : 0)
