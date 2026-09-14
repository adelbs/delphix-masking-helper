#!/usr/bin/env node
/**
 * Checks the Chile (Ley 21.719) preset.
 *
 *   node presets/chile-ley-21719/verify.mjs               # classifiers, then algorithms
 *   node presets/chile-ley-21719/verify.mjs classifiers   # only the local profiling check
 *   node presets/chile-ley-21719/verify.mjs algorithms    # only masking, against the app
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

let seed = 42
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
const COMUNAS = source('comunas.tsv').map((l) => l.split('\t')[1])

function dv(body) {
  let sum = 0
  let weight = 2
  for (const digit of String(body).split('').reverse()) {
    sum += Number(digit) * weight
    weight = weight === 7 ? 2 : weight + 1
  }
  const r = 11 - (sum % 11)
  return r === 11 ? '0' : r === 10 ? 'K' : String(r)
}
const validRut = (text) => {
  const clean = text.trim().replace(/[.\-]/g, '').toUpperCase()
  return /^\d{6,8}[\dK]$/.test(clean) && dv(clean.slice(0, -1)) === clean.slice(-1)
}
const rutBody = () => int(1_000_000, 27_000_000)
const dotted = (b) => `${b.toLocaleString('de-DE')}-${dv(b)}`
const luhn = (prefix, length) => {
  const digits = [...prefix].map(Number)
  while (digits.length < length - 1) digits.push(int(0, 9))
  const sum = digits.slice().reverse().reduce((s, d, i) => s + (i % 2 === 0 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0)
  return digits.join('') + String((10 - (sum % 10)) % 10)
}
const iso = (y0, y1) => `${int(y0, y1)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`
const fullName = () => `${pick(NOMBRES)}${random() < 0.4 ? ` ${pick(NOMBRES)}` : ''} ${pick(APELLIDOS)} ${pick(APELLIDOS)}`
const CONS = 'BCDFGHJKLPRSTVWXYZ'
const plate = () => `${many(() => pick(CONS), 4).join('')}${random() < 0.5 ? '-' : ''}${int(10, 99)}`

// ── Classifiers ─────────────────────────────────────────────────────────────

const SQL = { varchar: 12, char: 1, number: 2, integer: 4, date: 91, timestamp: 93, clob: 2005 }
const col = (name, type, length, values, expect) => ({ name, sqlType: SQL[type], length, values, expect })

const COLUMNS = [
  // L1 — well named
  col('RUT', 'varchar', 12, many(() => dotted(rutBody())), 'CL_L1_RUT'),
  col('RUT_CLIENTE', 'varchar', 10, many(() => { const b = rutBody(); return `${b}-${dv(b)}` }), 'CL_L1_RUT'),
  col('rutPaciente', 'varchar', 12, many(() => dotted(rutBody())), 'CL_L1_RUT'),
  col('NRO_RUT', 'varchar', 9, many(() => { const b = rutBody(); return `${b}${dv(b)}` }), 'CL_L1_RUT'),
  col('RUT_NUM', 'number', 8, many(() => String(rutBody())), 'CL_L1_RUT_CUERPO'),
  col('RUT', 'number', 8, many(() => String(rutBody())), 'CL_L1_RUT_CUERPO'),
  col('DV', 'char', 1, many(() => dv(rutBody())), 'CL_L1_RUT_DV'),
  col('RUT_DV', 'char', 1, many(() => dv(rutBody())), 'CL_L1_RUT_DV'),
  col('NUM_SERIE_CEDULA', 'varchar', 11, many(() => `${int(100, 999)}.${int(100, 999)}.${int(100, 999)}`), 'CL_L1_NUMERO_DOCUMENTO'),
  col('PASAPORTE', 'varchar', 10, many(() => `F${int(10000000, 99999999)}`), 'CL_L1_PASAPORTE'),
  col('DNI', 'varchar', 12, many(() => String(int(10000000, 99999999))), 'CL_L1_DOCUMENTO_EXTRANJERO'),
  col('NOMBRES', 'varchar', 60, many(() => `${pick(NOMBRES)}${random() < 0.5 ? ` ${pick(NOMBRES)}` : ''}`), 'CL_L1_NOMBRE'),
  col('PRIMER_NOMBRE', 'varchar', 30, many(() => pick(NOMBRES)), 'CL_L1_NOMBRE'),
  col('APELLIDO_PATERNO', 'varchar', 30, many(() => pick(APELLIDOS)), 'CL_L1_APELLIDO'),
  col('APE_MAT', 'varchar', 30, many(() => pick(APELLIDOS)), 'CL_L1_APELLIDO'),
  col('NOMBRE_COMPLETO', 'varchar', 120, many(fullName), 'CL_L1_NOMBRE_COMPLETO'),
  col('NOMBRE_CLIENTE', 'varchar', 120, many(fullName), 'CL_L1_NOMBRE_COMPLETO'),
  col('NOMBRE', 'varchar', 120, many(fullName), 'CL_L1_NOMBRE_COMPLETO'),
  col('TITULAR', 'varchar', 120, many(fullName), 'CL_L1_NOMBRE_COMPLETO'),
  col('EMAIL', 'varchar', 100, many(() => `${pick(NOMBRES).toLowerCase()}.${int(1, 999)}@gmail.com`), 'CL_L1_EMAIL'),
  col('CORREO_ELECTRONICO', 'varchar', 100, many(() => `contacto${int(1, 999)}@empresa.cl`), 'CL_L1_EMAIL'),
  col('TELEFONO_CELULAR', 'varchar', 20, many(() => `+56 9 ${int(1000, 9999)} ${int(1000, 9999)}`), 'CL_L1_TELEFONO'),
  col('FONO', 'varchar', 12, many(() => `22${int(1000000, 9999999)}`), 'CL_L1_TELEFONO'),
  col('DIRECCION', 'varchar', 120, many(() => `Los Aromos ${int(1, 3000)}`), 'CL_L1_DIRECCION'),
  col('DOMICILIO_PARTICULAR', 'varchar', 120, many(() => `Av. Providencia ${int(1, 3000)}, depto ${int(101, 1802)}`), 'CL_L1_DIRECCION'),
  col('DEPTO', 'varchar', 6, many(() => String(int(101, 1802))), 'CL_L1_DIRECCION_COMPLEMENTO'),
  col('NRO_CUENTA_CORRIENTE', 'varchar', 14, many(() => String(int(10000000, 999999999))), 'CL_L1_CUENTA_BANCARIA'),
  col('NUMERO_TARJETA', 'varchar', 19, many(() => luhn('4', 16)), 'CL_L1_TARJETA'),
  col('IP_ORIGEN', 'varchar', 15, many(() => `${int(1, 223)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`), 'CL_L1_IP'),
  col('MAC_ADDRESS', 'varchar', 17, many(() => many(() => int(0, 255).toString(16).padStart(2, '0'), 6).join(':')), 'CL_L1_DISPOSITIVO'),
  col('IMEI', 'varchar', 15, many(() => luhn('35', 15)), 'CL_L1_DISPOSITIVO'),
  col('PATENTE', 'varchar', 8, many(plate), 'CL_L1_PATENTE'),
  col('NRO_CHASIS', 'varchar', 17, many(() => many(() => pick('ABCDEFGHJKLMNPRSTUVWXYZ0123456789'), 17).join('')), 'CL_L1_VEHICULO_ID'),
  col('NRO_POLIZA', 'varchar', 12, many(() => `POL-${int(100000, 999999)}`), 'CL_L1_NUMERO_CONTRATO'),
  col('USERNAME', 'varchar', 30, many(() => `${pick(NOMBRES).toLowerCase()}${int(1, 99)}`), 'CL_L1_USUARIO_RRSS'),
  col('PASSWORD_HASH', 'varchar', 60, many(() => `$2a$10$${many(() => pick('abcdefghijklmnopqrstuvwxyz0123456789'), 53).join('')}`), 'CL_L1_CREDENCIAL'),
  col('CLAVE_ACCESO', 'varchar', 20, many(() => `clave${int(1000, 9999)}`), 'CL_L1_CREDENCIAL'),
  col('LATITUD', 'varchar', 12, many(() => `-${int(18, 54)}.${int(100000, 999999)}`), 'CL_L1_GEOLOCALIZACION'),
  col('COORDENADAS', 'varchar', 30, many(() => `-33.${int(1000, 9999)},-70.${int(1000, 9999)}`), 'CL_L1_GEOLOCALIZACION'),
  col('OBSERVACIONES', 'clob', 4000, many(() => `Cliente llamó para actualizar sus datos. RUT ${dotted(rutBody())}, correo ${pick(NOMBRES).toLowerCase()}@gmail.com.`), 'CL_L1_TEXTO_LIBRE'),

  // L1 — badly named: only the values can tell
  col('CAMPO1', 'varchar', 12, many(() => dotted(rutBody())), 'CL_L1_RUT'),
  col('COL_A', 'varchar', 30, many(() => pick(NOMBRES)), 'CL_L1_NOMBRE'),
  col('COL_B', 'varchar', 30, many(() => pick(APELLIDOS)), 'CL_L1_APELLIDO'),
  col('DATO_X', 'varchar', 120, many(fullName), 'CL_L1_NOMBRE_COMPLETO'),
  col('CAMPO3', 'varchar', 100, many(() => `${pick(NOMBRES).toLowerCase()}@hotmail.com`), 'CL_L1_EMAIL'),
  col('CAMPO4', 'varchar', 12, many(() => `9${int(10000000, 99999999)}`), 'CL_L1_TELEFONO'),
  col('CAMPO5', 'varchar', 120, many(() => `Calle Arturo Prat ${int(1, 3000)}`), 'CL_L1_DIRECCION'),
  col('CAMPO6', 'varchar', 19, many(() => luhn('5', 16)), 'CL_L1_TARJETA'),
  col('CAMPO7', 'varchar', 15, many(() => `192.168.${int(0, 255)}.${int(1, 254)}`), 'CL_L1_IP'),
  col('CAMPO8', 'varchar', 8, many(plate), 'CL_L1_PATENTE'),
  col('TXT', 'clob', 4000, many(() => `Paciente ${pick(NOMBRES)} ${pick(APELLIDOS)}, RUT ${dotted(rutBody())}, fono +56 9 ${int(1000, 9999)} ${int(1000, 9999)}.`), 'CL_L1_TEXTO_LIBRE'),

  // L2
  col('FECHA_NACIMIENTO', 'date', 0, many(() => iso(1940, 2010)), 'CL_L2_FECHA_NACIMIENTO'),
  col('FEC_NAC', 'varchar', 10, many(() => iso(1940, 2010)), 'CL_L2_FECHA_NACIMIENTO'),
  col('fechaNacimiento', 'timestamp', 0, many(() => iso(1940, 2010)), 'CL_L2_FECHA_NACIMIENTO'),
  col('ANIO_NACIMIENTO', 'number', 4, many(() => String(int(1940, 2010))), 'CL_L2_ANIO_NACIMIENTO'),
  col('EDAD', 'number', 3, many(() => String(int(0, 99))), 'CL_L2_EDAD'),
  col('FECHA_DEFUNCION', 'date', 0, many(() => iso(2000, 2025)), 'CL_L2_FECHA_EVENTO'),
  col('SEXO', 'char', 1, many(() => pick(['F', 'M'])), 'CL_L2_SEXO'),
  col('GENERO', 'varchar', 10, many(() => pick(['Femenino', 'Masculino'])), 'CL_L2_SEXO'),
  col('COMUNA', 'varchar', 40, many(() => pick(COMUNAS)), 'CL_L2_COMUNA'),
  col('CAMPO9', 'varchar', 40, many(() => pick(COMUNAS)), 'CL_L2_COMUNA'),
  col('COD_COMUNA', 'number', 5, many(() => String(int(13101, 13132))), 'CL_L2_CODIGO_COMUNA'),
  col('CODIGO_POSTAL', 'varchar', 7, many(() => String(int(1000000, 9999999))), 'CL_L2_CODIGO_POSTAL'),
  col('NACIONALIDAD', 'varchar', 20, many(() => pick(['Chilena', 'Peruana', 'Venezolana'])), 'CL_L2_NACIONALIDAD'),
  col('ESTADO_CIVIL', 'varchar', 20, many(() => pick(['Soltero', 'Casada', 'Viudo'])), 'CL_L2_ESTADO_CIVIL'),
  col('CARGO', 'varchar', 60, many(() => pick(['Analista', 'Jefe de área', 'Vendedor'])), 'CL_L2_OCUPACION'),
  col('EMPLEADOR', 'varchar', 80, many(() => `Empresa ${int(1, 99)} SpA`), 'CL_L2_EMPLEADOR'),
  col('NIVEL_EDUCACIONAL', 'varchar', 40, many(() => pick(['Media completa', 'Básica incompleta'])), 'CL_L2_NIVEL_EDUCACIONAL'),
  col('COLEGIO', 'varchar', 80, many(() => `Liceo A-${int(1, 99)}`), 'CL_L2_ESTABLECIMIENTO_EDUCACIONAL'),
  col('CARGAS_FAMILIARES', 'number', 2, many(() => String(int(0, 8))), 'CL_L2_CARGAS_FAMILIARES'),

  // L3
  col('PUEBLO_ORIGINARIO', 'varchar', 30, many(() => pick(['Mapuche', 'Aymara', 'No pertenece'])), 'CL_L3_ETNIA'),
  col('CAMPO10', 'varchar', 30, many(() => pick(['Mapuche', 'Aymara', 'Diaguita', 'Rapa Nui'])), 'CL_L3_ETNIA'),
  col('DIAGNOSTICO', 'varchar', 10, many(() => pick(['E11.9', 'I10', 'J45.9', 'F32.1'])), 'CL_L3_SALUD_DIAGNOSTICO'),
  col('COD_CIE10', 'varchar', 6, many(() => pick(['E11', 'I10', 'F20', 'B20'])), 'CL_L3_SALUD_DIAGNOSTICO'),
  col('MEDICAMENTO', 'varchar', 40, many(() => pick(['Sertralina', 'Paracetamol', 'Losartán'])), 'CL_L3_SALUD_MEDICAMENTO'),
  col('NRO_FICHA_CLINICA', 'varchar', 10, many(() => String(int(100000, 999999))), 'CL_L3_SALUD_IDENTIFICADOR'),
  col('ANAMNESIS', 'clob', 4000, many(() => `Paciente refiere dolor abdominal de ${int(1, 9)} días de evolución.`), 'CL_L3_SALUD_TEXTO_CLINICO'),
  col('RESULTADO_VIH', 'varchar', 12, many(() => pick(['Reactivo', 'No reactivo'])), 'CL_L3_SALUD_RESULTADO_EXAMEN'),
  col('GRUPO_SANGUINEO', 'varchar', 4, many(() => pick(['A+', 'O-', 'AB+'])), 'CL_L3_SALUD_GRUPO_SANGUINEO'),
  col('DISCAPACIDAD', 'varchar', 20, many(() => pick(['Física', 'Visual', 'Sin discapacidad'])), 'CL_L3_SALUD_DISCAPACIDAD'),
  col('EMBARAZO', 'char', 1, many(() => pick(['S', 'N'])), 'CL_L3_SALUD_SEXUAL_REPRODUCTIVA'),
  col('SALUD_MENTAL', 'varchar', 60, many(() => pick(['Depresión', 'Ansiedad'])), 'CL_L3_SALUD_MENTAL_ADICCIONES'),
  col('HUELLA_DACTILAR', 'varchar', 200, many(() => many(() => pick('ABCDEF0123456789'), 64).join('')), 'CL_L3_BIOMETRICO'),
  col('PERFIL_GENETICO', 'varchar', 200, many(() => 'AGTC'.repeat(10)), 'CL_L3_PERFIL_GENETICO'),
  col('ORIENTACION_SEXUAL', 'varchar', 30, many(() => pick(['Heterosexual', 'Gay', 'Bisexual'])), 'CL_L3_ORIENTACION_SEXUAL'),
  col('IDENTIDAD_GENERO', 'varchar', 30, many(() => pick(['Mujer', 'Hombre trans', 'No binario'])), 'CL_L3_IDENTIDAD_GENERO'),
  col('VIDA_SEXUAL', 'varchar', 30, many(() => 'Activa'), 'CL_L3_VIDA_SEXUAL'),
  col('RELIGION', 'varchar', 40, many(() => pick(['Católica', 'Evangélica', 'Ninguna'])), 'CL_L3_RELIGION'),
  col('IDEOLOGIA', 'varchar', 40, many(() => pick(['Izquierda', 'Derecha', 'Centro'])), 'CL_L3_CONVICCION_IDEOLOGICA'),
  col('PARTIDO_POLITICO', 'varchar', 60, many(() => pick(['Renovación Nacional', 'Partido Socialista de Chile', 'UDI'])), 'CL_L3_AFILIACION_POLITICA'),
  col('AFILIACION_SINDICAL', 'char', 1, many(() => pick(['S', 'N'])), 'CL_L3_AFILIACION_SINDICAL'),
  col('COLEGIO_PROFESIONAL', 'varchar', 60, many(() => 'Colegio Médico'), 'CL_L3_AFILIACION_GREMIAL'),
  col('TRAMO_FONASA', 'char', 1, many(() => pick(['A', 'B', 'C', 'D'])), 'CL_L3_SOCIOEC_PREVISION_SALUD'),
  col('ISAPRE', 'varchar', 30, many(() => pick(['Colmena', 'Banmédica', 'Consalud'])), 'CL_L3_SOCIOEC_PREVISION_SALUD'),
  col('PREVISION', 'varchar', 30, many(() => pick(['FONASA B', 'Isapre Colmena', 'FONASA A'])), 'CL_L3_SOCIOEC_PREVISION_SALUD'),
  col('PLAN_ISAPRE', 'varchar', 20, many(() => `PLN-${int(100, 999)}`), 'CL_L3_SOCIOEC_PLAN_SALUD'),
  col('TRAMO_RSH', 'varchar', 10, many(() => `${pick([40, 50, 60, 70, 80, 90, 100])}%`), 'CL_L3_SOCIOEC_RSH'),
  col('QUINTIL', 'number', 1, many(() => String(int(1, 5))), 'CL_L3_SOCIOEC_NIVEL'),
  col('BENEFICIO_SOCIAL', 'varchar', 60, many(() => pick(['Pensión Garantizada Universal', 'Subsidio Único Familiar'])), 'CL_L3_SOCIOEC_BENEFICIO_SOCIAL'),
  col('DICOM', 'char', 1, many(() => pick(['S', 'N'])), 'CL_L3_SOCIOEC_MOROSIDAD'),
  col('MONTO_DEUDA', 'number', 12, many(() => String(int(10000, 9000000))), 'CL_L3_SOCIOEC_MONTO_DEUDA'),
  col('SUELDO_LIQUIDO', 'number', 10, many(() => String(int(500000, 5000000))), 'CL_L3_SOCIOEC_INGRESOS'),
  col('AFP', 'varchar', 20, many(() => pick(['Modelo', 'Habitat', 'Uno'])), 'CL_L3_SOCIOEC_PREVISION_AFP'),
  col('SALDO_AFP', 'number', 12, many(() => String(int(100000, 90000000))), 'CL_L3_SOCIOEC_SALDO_PREVISIONAL'),
  col('TIPO_VIVIENDA', 'varchar', 30, many(() => pick(['Propia pagada', 'Allegado'])), 'CL_L3_SOCIOEC_VIVIENDA'),
  col('BECA', 'varchar', 40, many(() => pick(['Gratuidad', 'Beca Bicentenario'])), 'CL_L3_SOCIOEC_FINANCIAMIENTO_ESTUDIOS'),
  col('ANTECEDENTES_PENALES', 'varchar', 30, many(() => pick(['Sin antecedentes', 'Con antecedentes'])), 'CL_L3_PENAL_ANTECEDENTES'),
  col('RIT', 'varchar', 15, many(() => `O-${int(1, 9999)}-${int(2015, 2025)}`), 'CL_L3_PENAL_CAUSA'),

  // Not personal data: nothing should be assigned
  col('ID', 'integer', 10, many((i) => String(i + 1)), ''),
  col('ESTRUCTURA', 'varchar', 40, many(() => pick(['Árbol', 'Lista'])), ''),
  col('RUTA_ARCHIVO', 'varchar', 200, many(() => `/datos/archivo${int(1, 99)}.txt`), ''),
  col('NOMBRE_PRODUCTO', 'varchar', 80, many(() => pick(['Leche entera 1L', 'Pan amasado', 'Arroz grado 1'])), ''),
  col('NOMBRE_EMPRESA', 'varchar', 80, many(() => `Comercial ${int(1, 99)} SpA`), ''),
  col('MONTO_VENTA', 'number', 12, many(() => String(int(1000, 99999999))), ''),
  col('FECHA_CREACION', 'date', 0, many(() => iso(2015, 2025)), ''),
  col('CODIGO', 'varchar', 10, many(() => `A-${int(100, 999)}`), ''),
  col('DESCRIPCION_PRODUCTO', 'varchar', 400, many(() => 'Producto de consumo masivo, envase de cartón reciclable.'), ''),
  col('ESTADO', 'varchar', 10, many(() => pick(['ACTIVO', 'INACTIVO'])), ''),
  col('CANTIDAD', 'number', 6, many(() => String(int(1, 500))), ''),
  col('SKU', 'varchar', 12, many(() => `SKU${int(10000, 99999)}`), ''),
  col('HOTEL', 'varchar', 60, many(() => 'Hotel Central'), ''),
  col('TRANSACCION_ID', 'varchar', 36, many(() => `TX${int(100000, 999999)}`), ''),
  col('DEPARTAMENTO', 'varchar', 40, many(() => pick(['Finanzas', 'Operaciones'])), ''),
  col('CLAVE_PRODUCTO', 'varchar', 10, many(() => `P-${int(100, 999)}`), ''),
  col('CARGO_FIJO', 'number', 8, many(() => String(int(1000, 9999))), ''),
  col('LONGITUD_CABLE', 'number', 6, many(() => `${int(1, 99)}.5`), ''),
  col('PAGE_URL', 'varchar', 200, many(() => `https://www.ejemplo.cl/p/${int(1, 999)}`), ''),
  col('TIPO_DOCUMENTO', 'varchar', 20, many(() => pick(['FACTURA', 'BOLETA'])), ''),
  col('CATEGORIA', 'varchar', 30, many(() => pick(['Lácteos', 'Panadería'])), ''),
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
const MASKING = {
  CL_L1_RUT: {
    inputs: ['12.345.678-5', '7.654.321-6', '12345678-5', '76543216', '9.075.310-K', '9075310k', 'Juan', ...many(() => dotted(rutBody()), 30), ...many(() => { const b = rutBody(); return `${b}-${dv(b)}` }, 30)],
    // Text that is not a RUT still has to be masked, not passed through.
    check: (input, output) => (/\d/.test(input) ? validRut(output) && output.length === input.length : output !== input),
  },
  CL_L1_RUT_CUERPO: { inputs: ['12345678', '7654321'], check: (i, o) => /^\d+$/.test(o) && o.length === i.length },
  CL_L1_RUT_DV: { inputs: ['5', 'K'], check: (i, o) => /^[\dK]$/.test(o), same: true },
  CL_L1_NUMERO_DOCUMENTO: { inputs: ['123.456.789', 'A012345678'] },
  CL_L1_PASAPORTE: { inputs: ['F12345678'] },
  CL_L1_DOCUMENTO_EXTRANJERO: { inputs: ['AB1234567'] },
  // Four words fall through to the Character Mapping: it must mask them, not act as a name lookup.
  CL_L1_NOMBRE: { inputs: ['María', 'JUAN CARLOS', 'Millaray', 'Ana María José Luisa'], check: (i, o) => words(i) === words(o) },
  CL_L1_APELLIDO: { inputs: ['González', 'PÉREZ MUÑOZ', 'San Martín'], check: (i, o) => words(i) === words(o) },
  CL_L1_NOMBRE_COMPLETO: {
    inputs: ['Juan Carlos Pérez González', 'MARÍA JOSÉ MUÑOZ ROJAS', 'Pedro Soto', 'González Rojas, Ana María'],
    check: (i, o) => words(i) === words(o),
  },
  CL_L1_EMAIL: { inputs: ['juan.perez@gmail.com', 'maría.muñoz@empresa.cl'], check: (i, o) => /@[^@]+\.test$/.test(o) },
  CL_L1_TELEFONO: {
    inputs: ['+56 9 8765 4321', '987654321', '(2) 2345 6789', '+56 32 212 3456'],
    check: (i, o) => o.length === i.length && (!i.startsWith('+56 9') || o.startsWith('+56 9')),
  },
  CL_L1_DIRECCION: { inputs: ['Av. Providencia 1234, depto 502'] },
  CL_L1_DIRECCION_COMPLEMENTO: { inputs: ['502', 'Block B'] },
  CL_L1_CUENTA_BANCARIA: { inputs: ['000123456789'] },
  CL_L1_TARJETA: { inputs: ['4111 1111 1111 1111'] },
  CL_L1_IP: {
    inputs: ['200.27.1.10', '2001:db8::1'],
    check: (i, o) => (i.includes('.')
      ? o.split('.').every((p) => Number(p) >= 1 && Number(p) <= 254)
      : /^[0-9a-f:]+$/i.test(o)),
  },
  CL_L1_DISPOSITIVO: { inputs: ['3c:22:fb:9a:10:e4', '356938035643809'] },
  CL_L1_PATENTE: { inputs: ['BBCD-12', 'GHJK45'], check: (i, o) => /^[BCDFGHJKLPRSTVWXYZ]{4}-?\d{2}$/.test(o) },
  CL_L1_VEHICULO_ID: { inputs: ['9BWZZZ377VT004251'] },
  CL_L1_NUMERO_CONTRATO: { inputs: ['POL-123456'] },
  CL_L1_USUARIO_RRSS: { inputs: ['@maria_munoz'] },
  CL_L1_CREDENCIAL: { inputs: ['Secreta#2024'], check: (i, o) => /^X+$/.test(o) },
  CL_L1_GEOLOCALIZACION: { inputs: ['-33.448891', '-33.448891,-70.669265'], check: (i, o) => o.slice(0, 5) === i.slice(0, 5) },
  CL_L1_TEXTO_LIBRE: {
    inputs: ['Cliente Soto, RUT 12.345.678-5, correo p.soto@gmail.com, fono 987654321.'],
    check: (i, o) => !/12\.345\.678-5|p\.soto@gmail\.com|987654321/.test(o),
  },
  CL_L2_FECHA_NACIMIENTO: { inputs: ['1985-07-20', '2008-01-15'], check: (i, o) => Math.abs(new Date(o.slice(0, 10)) - new Date(i)) <= 60 * 864e5 },
  CL_L2_ANIO_NACIMIENTO: { inputs: ['1985'], check: (i, o) => o.startsWith('198'), same: true },
  CL_L2_EDAD: { inputs: ['37', '7', '104'], check: (i, o) => (i === '104' ? o === '90' : i.length === 1 || o[0] === i[0]), same: true },
  CL_L2_FECHA_EVENTO: { inputs: ['2021-03-15'] },
  CL_L2_SEXO: { inputs: ['F', 'Femenino', 'hombre'], same: true },
  CL_L2_COMUNA: { inputs: ['Torres del Paine', 'Santiago', 'Nunoa'], check: (i, o) => (i === 'Torres del Paine' ? o === 'Natales' : true), same: true },
  // Torres del Paine (12402) becomes Natales (12401); Santiago (13101) is large and stays.
  CL_L2_CODIGO_COMUNA: { inputs: ['12402', '13101'], check: (i, o) => o === (i === '12402' ? '12401' : i), same: true },
  CL_L2_CODIGO_POSTAL: { inputs: ['8320123'], check: (i, o) => o === '8320000' },
  CL_L2_NACIONALIDAD: { inputs: ['Peruana'], same: true },
  CL_L2_ESTADO_CIVIL: { inputs: ['Casada'], same: true },
  CL_L2_OCUPACION: { inputs: ['Gerente Regional Aysén'] },
  CL_L2_EMPLEADOR: { inputs: ['Codelco'] },
  CL_L2_NIVEL_EDUCACIONAL: { inputs: ['Media completa'], same: true },
  CL_L2_ESTABLECIMIENTO_EDUCACIONAL: { inputs: ['Liceo Bicentenario de Excelencia'] },
  CL_L2_CARGAS_FAMILIARES: { inputs: ['9', '2'], check: (i, o) => Number(o) <= 5, same: true },
  CL_L3_ETNIA: { inputs: ['Mapuche-Huilliche', 'S'], same: true },
  CL_L3_SALUD_DIAGNOSTICO: { inputs: ['F32.9', 'B20', 'Depresión mayor'], same: true },
  CL_L3_SALUD_MEDICAMENTO: { inputs: ['Sertralina 50 mg'] },
  CL_L3_SALUD_IDENTIFICADOR: { inputs: ['HC-2024-00123'] },
  CL_L3_SALUD_TEXTO_CLINICO: { inputs: ['Paciente Muñoz, RUT 9.075.310-K, consulta por cefalea.'], check: (i, o) => !o.includes('9.075.310-K') },
  CL_L3_SALUD_RESULTADO_EXAMEN: { inputs: ['Reactivo'] },
  CL_L3_SALUD_GRUPO_SANGUINEO: { inputs: ['O+'], same: true },
  CL_L3_SALUD_DISCAPACIDAD: { inputs: ['Psíquica severa', 'N'], same: true },
  CL_L3_SALUD_SEXUAL_REPRODUCTIVA: { inputs: ['Embarazo de 12 semanas', 'S'], same: true },
  CL_L3_SALUD_MENTAL_ADICCIONES: { inputs: ['Trastorno bipolar'] },
  CL_L3_BIOMETRICO: { inputs: ['A1B2C3D4E5F6'] },
  CL_L3_PERFIL_GENETICO: { inputs: ['BRCA1 positivo'] },
  CL_L3_ORIENTACION_SEXUAL: { inputs: ['Bisexual'], same: true },
  CL_L3_IDENTIDAD_GENERO: { inputs: ['Hombre trans'], same: true },
  CL_L3_VIDA_SEXUAL: { inputs: ['Activa'] },
  CL_L3_RELIGION: { inputs: ['Evangélica'], same: true },
  CL_L3_CONVICCION_IDEOLOGICA: { inputs: ['Centroderecha'], same: true },
  CL_L3_AFILIACION_POLITICA: { inputs: ['Renovación Nacional'], same: true },
  CL_L3_AFILIACION_SINDICAL: { inputs: ['Sindicato N°2 de Trabajadores', 'S'], same: true },
  CL_L3_AFILIACION_GREMIAL: { inputs: ['Colegio Médico de Chile'] },
  CL_L3_SOCIOEC_PREVISION_SALUD: { inputs: ['FONASA B', 'B', 'Isapre Colmena'], same: true },
  CL_L3_SOCIOEC_PLAN_SALUD: { inputs: ['PLN-4521'] },
  CL_L3_SOCIOEC_RSH: { inputs: ['40%', 'Tramo 40%', '70'], same: true },
  CL_L3_SOCIOEC_NIVEL: { inputs: ['C2', '3'], same: true },
  CL_L3_SOCIOEC_BENEFICIO_SOCIAL: { inputs: ['PGU', 'S'], same: true },
  CL_L3_SOCIOEC_MOROSIDAD: { inputs: ['Moroso DICOM', 'S', '650'], same: true },
  CL_L3_SOCIOEC_MONTO_DEUDA: { inputs: ['1250000'] },
  CL_L3_SOCIOEC_INGRESOS: { inputs: ['985000', '1250000.50'] },
  CL_L3_SOCIOEC_PREVISION_AFP: { inputs: ['AFP Modelo'], same: true },
  CL_L3_SOCIOEC_SALDO_PREVISIONAL: { inputs: ['38500000'] },
  CL_L3_SOCIOEC_VIVIENDA: { inputs: ['Allegado'], same: true },
  CL_L3_SOCIOEC_FINANCIAMIENTO_ESTUDIOS: { inputs: ['CAE'], same: true },
  CL_L3_PENAL_ANTECEDENTES: { inputs: ['Condenado por robo', 'S'], same: true },
  CL_L3_PENAL_CAUSA: { inputs: ['O-1234-2023'] },
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
const EXPECT = {
  CL_L1_NOMBRE: (i, o) => words(i) > 3 || o.split(/\s+/).every((w) => has('cl-nombres.txt', w)),
  CL_L1_APELLIDO: (i, o) => words(i) > 3 || o.split(/\s+/).every((w) => has('cl-apellidos.txt', w)),
  CL_L1_NOMBRE_COMPLETO: (i, o) => i.includes(',') || (has('cl-nombres.txt', o.split(/\s+/)[0]) && has('cl-apellidos.txt', o.split(/\s+/).at(-1))),
  CL_L1_DIRECCION: (i, o) => has('cl-direcciones.txt', o),
  CL_L2_SEXO: (i, o) => ({ f: ['f', 'm'], femenino: ['femenino', 'masculino'], hombre: ['mujer', 'hombre'] })[i.toLowerCase()].includes(o.toLowerCase()),
  CL_L2_CODIGO_COMUNA: (i, o) => has('cl-detectar-codigo-comuna.txt', o),
  CL_L2_NACIONALIDAD: (i, o) => has('cl-nacionalidades.txt', o),
  CL_L2_ESTADO_CIVIL: (i, o) => has('cl-estado-civil.txt', o),
  CL_L2_OCUPACION: (i, o) => has('cl-ocupaciones.txt', o),
  CL_L2_EMPLEADOR: (i, o) => has('cl-empleadores.txt', o),
  CL_L2_NIVEL_EDUCACIONAL: (i, o) => has('cl-nivel-educacional.txt', o),
  CL_L2_ESTABLECIMIENTO_EDUCACIONAL: (i, o) => has('cl-establecimientos.txt', o),
  CL_L3_ETNIA: (i, o) => flag(i, o) ?? has('cl-pueblos.txt', o),
  CL_L3_SALUD_DIAGNOSTICO: (i, o) => (/\.\d/.test(i) ? has('cl-cie10-decimal.txt', o) : /^[A-Z]\d{2}$/i.test(i) ? has('cl-cie10.txt', o) : has('cl-diagnosticos.txt', o)),
  CL_L3_SALUD_MEDICAMENTO: (i, o) => has('cl-medicamentos.txt', o),
  CL_L3_SALUD_GRUPO_SANGUINEO: (i, o) => has('cl-grupo-sanguineo.txt', o),
  CL_L3_SALUD_DISCAPACIDAD: (i, o) => flag(i, o) ?? has('cl-discapacidad.txt', o),
  CL_L3_SALUD_SEXUAL_REPRODUCTIVA: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  CL_L3_SALUD_MENTAL_ADICCIONES: (i, o) => o === SUPPRESSED,
  CL_L3_VIDA_SEXUAL: (i, o) => o === SUPPRESSED,
  CL_L3_AFILIACION_SINDICAL: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  CL_L3_AFILIACION_GREMIAL: (i, o) => o === SUPPRESSED,
  CL_L3_ORIENTACION_SEXUAL: (i, o) => has('cl-orientacion-sexual.txt', o),
  CL_L3_IDENTIDAD_GENERO: (i, o) => has('cl-identidad-genero.txt', o),
  CL_L3_RELIGION: (i, o) => has('cl-religiones.txt', o),
  CL_L3_CONVICCION_IDEOLOGICA: (i, o) => has('cl-ideologias.txt', o),
  CL_L3_AFILIACION_POLITICA: (i, o) => has('cl-partidos.txt', o),
  CL_L3_SOCIOEC_PREVISION_SALUD: (i, o) => (/^[A-D]$/i.test(i) ? /^[A-D]$/i.test(o) : /^fonasa/i.test(i) ? /^FONASA [A-D]$/i.test(o) : has('cl-prevision-salud.txt', o)),
  CL_L3_SOCIOEC_RSH: (i, o) => (/^tramo/i.test(i) ? /^Tramo (40|50|60|70|80|90|100)%$/i.test(o) : /^(40|50|60|70|80|90|100)%?$/.test(o)),
  CL_L3_SOCIOEC_NIVEL: (i, o) => (/^\d+$/.test(i) ? /^[1-5]$/.test(o) : has('cl-gse.txt', o)),
  CL_L3_SOCIOEC_BENEFICIO_SOCIAL: (i, o) => flag(i, o) ?? has('cl-beneficios-sociales.txt', o),
  CL_L3_SOCIOEC_MOROSIDAD: (i, o) => flag(i, o) ?? (/^\d+$/.test(i) ? /^\d+$/.test(o) && o.length === i.length : has('cl-estado-crediticio.txt', o)),
  CL_L3_SOCIOEC_PREVISION_AFP: (i, o) => has('cl-afp.txt', o),
  CL_L3_SOCIOEC_VIVIENDA: (i, o) => has('cl-vivienda.txt', o),
  CL_L3_SOCIOEC_FINANCIAMIENTO_ESTUDIOS: (i, o) => has('cl-financiamiento-estudios.txt', o),
  CL_L3_PENAL_ANTECEDENTES: (i, o) => flag(i, o) ?? has('cl-antecedentes.txt', o),
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

  const jobs = preset.domains.flatMap((d) => (MASKING[d.name]?.inputs ?? []).map((input) => ({ domain: d, input })))
  // Real columns hold placeholders too. Masking them may change them or not, but must not fail —
  // except in typed columns (dates, amounts), where the database would not hold them.
  const TYPED = new Set(['CL_L2_FECHA_NACIMIENTO', 'CL_L2_FECHA_EVENTO', 'CL_L3_SOCIOEC_MONTO_DEUDA', 'CL_L3_SOCIOEC_INGRESOS', 'CL_L3_SOCIOEC_SALDO_PREVISIONAL'])
  for (const d of preset.domains.filter((x) => !TYPED.has(x.name))) {
    for (const input of ['S/I', 'sin dato', '-']) jobs.push({ domain: d, input, placeholder: true })
  }
  let passed = 0
  let next = 0
  const lines = []
  async function worker() {
    while (next < jobs.length) {
      const { domain, input, placeholder } = jobs[next++]
      const test = MASKING[domain.name]
      const algo = byName.get(domain.algorithm)
      const out = await mask(algo.framework, resolve(algo.config), input, additional).catch((err) => ({ error: err.message }))
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
}

if (only !== 'algorithms') verifyClassifiers()
if (only !== 'classifiers') await verifyAlgorithms()
console.log(failures ? `\n${failures} problem(s)` : '\nall good')
process.exit(failures ? 1 : 0)
