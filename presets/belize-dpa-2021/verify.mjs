#!/usr/bin/env node
/**
 * Checks the Belize (Data Protection Act, 2021) preset.
 *
 *   node presets/belize-dpa-2021/verify.mjs               # classifiers, then algorithms
 *   node presets/belize-dpa-2021/verify.mjs classifiers   # only the local profiling check
 *   node presets/belize-dpa-2021/verify.mjs algorithms    # only masking, against the app
 *
 * Classifiers run through classifiers/, the same evaluator the classifier test uses: every
 * configuration is reviewed, then a battery of columns — well named, badly named and unrelated —
 * is profiled with the whole set at its threshold. The table that generalizes towns and villages
 * is audited offline. Algorithms run in the app (DLPX_URL, default http://localhost:3000), which
 * needs the Delphix jars in lib/.
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

let seed = 501
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
const GIVEN = source('given-names.txt')
const SURNAMES = source('surnames.txt')
const PLACES = source('places.tsv').map((l) => { const [name, district, , , population] = l.split('\t'); return { name, district, population: Number(population) } })
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '')
const PERSONAL = new Set([...GIVEN, ...SURNAMES].map((w) => fold(w).toLowerCase()))
const DISTRICT_NAMES = new Set(['belize', 'cayo', 'corozal', 'orange walk', 'stann creek', 'toledo'])
const PLACE_NAMES = PLACES.map((p) => p.name).filter((n) => !PERSONAL.has(fold(n).toLowerCase()) && !DISTRICT_NAMES.has(n.toLowerCase()))

const pad = (n, w) => String(n).padStart(w, '0')
const ssn = () => pad(int(1, 999999999), 9)
const ssnDashed = () => ssn().replace(/(\d{3})(\d{3})(\d{3})/, '$1-$2-$3')
const luhn = (prefix, length) => {
  const ds = [...prefix].map(Number)
  while (ds.length < length - 1) ds.push(int(0, 9))
  const sum = ds.slice().reverse().reduce((s, d, i) => s + (i % 2 === 0 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0)
  return ds.join('') + String((10 - (sum % 10)) % 10)
}
const iso = (y0, y1) => `${int(y0, y1)}-${pad(int(1, 12), 2)}-${pad(int(1, 28), 2)}`
const fullName = () => `${pick(GIVEN)}${random() < 0.4 ? ` ${pick(GIVEN)}` : ''} ${pick(SURNAMES)}`
const mobile = () => pick([`6${int(10, 99)}-${int(1000, 9999)}`, `+501 6${int(10, 99)}-${int(1000, 9999)}`, `6${int(100000, 999999)}`])
const landline = () => `${pick([2, 3, 4, 5, 7, 8])}${int(10, 99)}-${int(1000, 9999)}`
const plate = () => `${pick(['BZ', 'CY', 'CZL', 'OW', 'SC', 'TOL', 'BMP', 'SP'])} ${pick(['', 'C-', 'M-', 'T-'])}${int(1000, 99999)}`
const STREETS = source('streets.txt')
const address = () => pick([`#${int(1, 200)} ${pick(STREETS)}`, `Mile ${int(1, 50)} Philip Goldson Highway, Ladyville`])
const parcel = () => `${pick(['Caribbean Shores', 'Queen Charlotte Town', 'Belmopan', 'San Ignacio'])}, Block ${int(1, 60)}, Parcel ${int(1, 4000)}`

// ── Classifiers ─────────────────────────────────────────────────────────────

const SQL = { varchar: 12, char: 1, number: 2, integer: 4, date: 91, timestamp: 93, clob: 2005 }
const col = (name, type, length, values, expect) => ({ name, sqlType: SQL[type], length, values, expect })

const COLUMNS = [
  // L1 — well named
  col('SSN', 'varchar', 11, many(ssn), 'BZ_L1_SOCIAL_SECURITY_NUMBER'),
  col('SOCIAL_SECURITY_NO', 'varchar', 11, many(ssnDashed), 'BZ_L1_SOCIAL_SECURITY_NUMBER'),
  col('ssbNumber', 'varchar', 9, many(ssn), 'BZ_L1_SOCIAL_SECURITY_NUMBER'),
  col('TIN', 'varchar', 7, many(() => pad(int(1, 999999), 6)), 'BZ_L1_TIN'),
  col('TAX_ID', 'varchar', 7, many(() => pad(int(1, 9999999), 7)), 'BZ_L1_TIN'),
  col('PASSPORT_NO', 'varchar', 10, many(() => `P${int(100000, 9999999)}`), 'BZ_L1_PASSPORT'),
  col('VOTER_ID', 'varchar', 10, many(() => String(int(100000, 999999))), 'BZ_L1_VOTER_ID'),
  col('DRIVERS_LICENSE_NO', 'varchar', 10, many(() => String(int(10000, 999999))), 'BZ_L1_DRIVERS_LICENCE'),
  col('WORK_PERMIT_NO', 'varchar', 12, many(() => `WP${int(10000, 99999)}`), 'BZ_L1_IMMIGRATION_DOCUMENT'),
  col('BIRTH_CERT_NO', 'varchar', 12, many(() => `${int(1, 9999)}/${int(1950, 2024)}`), 'BZ_L1_VITAL_RECORD'),
  col('FIRST_NAME', 'varchar', 30, many(() => pick(GIVEN)), 'BZ_L1_GIVEN_NAME'),
  col('MIDDLE_NAME', 'varchar', 30, many(() => pick(GIVEN)), 'BZ_L1_GIVEN_NAME'),
  col('LAST_NAME', 'varchar', 30, many(() => pick(SURNAMES)), 'BZ_L1_SURNAME'),
  col('MAIDEN_NAME', 'varchar', 30, many(() => pick(SURNAMES)), 'BZ_L1_SURNAME'),
  col('FULL_NAME', 'varchar', 120, many(fullName), 'BZ_L1_FULL_NAME'),
  col('CUSTOMER_NAME', 'varchar', 120, many(fullName), 'BZ_L1_FULL_NAME'),
  col('NAME', 'varchar', 120, many(fullName), 'BZ_L1_FULL_NAME'),
  col('NEXT_OF_KIN', 'varchar', 120, many(fullName), 'BZ_L1_FULL_NAME'),
  col('EMAIL', 'varchar', 100, many(() => `${fold(pick(GIVEN)).toLowerCase()}.${int(1, 999)}@gmail.com`), 'BZ_L1_EMAIL'),
  col('EMAIL_ADDRESS', 'varchar', 100, many(() => `contact${int(1, 999)}@company.bz`), 'BZ_L1_EMAIL'),
  col('MOBILE_NO', 'varchar', 20, many(mobile), 'BZ_L1_PHONE'),
  col('HOME_PHONE', 'varchar', 12, many(landline), 'BZ_L1_PHONE'),
  col('ADDRESS', 'varchar', 120, many(address), 'BZ_L1_ADDRESS'),
  col('ADDRESS_LINE1', 'varchar', 120, many(() => `#${int(1, 200)} ${pick(STREETS)}`), 'BZ_L1_ADDRESS'),
  col('HOUSE_NO', 'varchar', 6, many(() => String(int(1, 400))), 'BZ_L1_ADDRESS_DETAIL'),
  col('ACCOUNT_NO', 'varchar', 12, many(() => String(int(1e8, 9.9e10))), 'BZ_L1_BANK_ACCOUNT'),
  col('CARD_NUMBER', 'varchar', 19, many(() => luhn('4', 16)), 'BZ_L1_PAYMENT_CARD'),
  col('IP_ADDRESS', 'varchar', 15, many(() => `${int(1, 223)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`), 'BZ_L1_IP_ADDRESS'),
  col('MAC_ADDRESS', 'varchar', 17, many(() => many(() => int(0, 255).toString(16).padStart(2, '0'), 6).join(':')), 'BZ_L1_DEVICE_ID'),
  col('IMEI', 'varchar', 15, many(() => luhn('35', 15)), 'BZ_L1_DEVICE_ID'),
  col('LICENSE_PLATE', 'varchar', 14, many(plate), 'BZ_L1_LICENCE_PLATE'),
  col('VIN', 'varchar', 17, many(() => many(() => pick('ABCDEFGHJKLMNPRSTUVWXYZ0123456789'), 17).join('')), 'BZ_L1_VIN'),
  col('PARCEL_NO', 'varchar', 60, many(parcel), 'BZ_L1_LAND_PARCEL'),
  col('POLICY_NO', 'varchar', 12, many(() => `POL-${int(100000, 999999)}`), 'BZ_L1_CONTRACT_NUMBER'),
  col('USERNAME', 'varchar', 30, many(() => `${fold(pick(GIVEN)).toLowerCase()}${int(1, 99)}`), 'BZ_L1_USERNAME'),
  col('PASSWORD_HASH', 'varchar', 60, many(() => `$2a$10$${many(() => pick('abcdefghijklmnopqrstuvwxyz0123456789'), 53).join('')}`), 'BZ_L1_CREDENTIAL'),
  col('LATITUDE', 'varchar', 12, many(() => `17.${int(100000, 999999)}`), 'BZ_L1_GEOLOCATION'),
  col('COORDINATES', 'varchar', 30, many(() => `17.${int(1000, 9999)},-88.${int(1000, 9999)}`), 'BZ_L1_GEOLOCATION'),
  col('REMARKS', 'clob', 4000, many(() => `Customer asked to update details. SSN ${ssn()}, email ${fold(pick(GIVEN)).toLowerCase()}@gmail.com.`), 'BZ_L1_FREE_TEXT'),

  // L1 — badly named: only the values can tell
  col('FIELD1', 'varchar', 11, many(ssnDashed), 'BZ_L1_SOCIAL_SECURITY_NUMBER'),
  col('FIELD2', 'varchar', 30, many(() => pick(GIVEN)), 'BZ_L1_GIVEN_NAME'),
  col('FIELD3', 'varchar', 30, many(() => pick(SURNAMES)), 'BZ_L1_SURNAME'),
  col('FIELD4', 'varchar', 120, many(fullName), 'BZ_L1_FULL_NAME'),
  col('FIELD5', 'varchar', 100, many(() => `${fold(pick(GIVEN)).toLowerCase()}@yahoo.com`), 'BZ_L1_EMAIL'),
  col('FIELD6', 'varchar', 15, many(() => `+501 6${int(10, 99)}-${int(1000, 9999)}`), 'BZ_L1_PHONE'),
  col('FIELD7', 'varchar', 120, many(() => `#${int(1, 200)} ${pick(STREETS)}`), 'BZ_L1_ADDRESS'),
  col('FIELD8', 'varchar', 19, many(() => luhn('5', 16)), 'BZ_L1_PAYMENT_CARD'),
  col('FIELD9', 'varchar', 15, many(() => `192.168.${int(0, 255)}.${int(1, 254)}`), 'BZ_L1_IP_ADDRESS'),
  col('FIELD10', 'varchar', 14, many(plate), 'BZ_L1_LICENCE_PLATE'),
  col('FIELD11', 'varchar', 60, many(parcel), 'BZ_L1_LAND_PARCEL'),
  col('TXT', 'clob', 4000, many(() => `Patient ${pick(GIVEN)} ${pick(SURNAMES)}, SSN ${ssn()}, tel 6${int(10, 99)}-${int(1000, 9999)}.`), 'BZ_L1_FREE_TEXT'),

  // L2
  col('DOB', 'date', 0, many(() => iso(1940, 2010)), 'BZ_L2_BIRTH_DATE'),
  col('DATE_OF_BIRTH', 'varchar', 10, many(() => iso(1940, 2010)), 'BZ_L2_BIRTH_DATE'),
  col('birthDate', 'timestamp', 0, many(() => iso(1940, 2010)), 'BZ_L2_BIRTH_DATE'),
  col('YEAR_OF_BIRTH', 'number', 4, many(() => String(int(1940, 2010))), 'BZ_L2_BIRTH_YEAR'),
  col('AGE', 'number', 3, many(() => String(int(0, 99))), 'BZ_L2_AGE'),
  col('DATE_OF_DEATH', 'date', 0, many(() => iso(2000, 2025)), 'BZ_L2_EVENT_DATE'),
  col('HIRE_DATE', 'date', 0, many(() => iso(2000, 2025)), 'BZ_L2_EVENT_DATE'),
  col('SEX', 'char', 1, many(() => pick(['F', 'M'])), 'BZ_L2_SEX'),
  col('GENDER', 'varchar', 10, many(() => pick(['Female', 'Male'])), 'BZ_L2_SEX'),
  col('VILLAGE', 'varchar', 60, many(() => pick(PLACE_NAMES)), 'BZ_L2_TOWN_VILLAGE'),
  col('TOWN', 'varchar', 60, many(() => pick(['Belize City', 'Belmopan', 'San Ignacio', 'Orange Walk Town', 'Dangriga', 'Punta Gorda', 'Corozal Town'])), 'BZ_L2_TOWN_VILLAGE'),
  col('PLACE_OF_BIRTH', 'varchar', 60, many(() => pick(PLACE_NAMES)), 'BZ_L2_TOWN_VILLAGE'),
  col('FIELD12', 'varchar', 60, many(() => pick(PLACE_NAMES)), 'BZ_L2_TOWN_VILLAGE'),
  col('NEIGHBOURHOOD', 'varchar', 40, many(() => pick(['Lake Independence', 'Port Loyola', "King's Park", 'Salvapan'])), 'BZ_L2_NEIGHBOURHOOD'),
  col('NATIONALITY', 'varchar', 20, many(() => pick(['Belizean', 'Guatemalan', 'Salvadoran', 'Honduran'])), 'BZ_L2_NATIONALITY'),
  col('MARITAL_STATUS', 'varchar', 30, many(() => pick(['Single', 'Married', 'Common-law'])), 'BZ_L2_MARITAL_STATUS'),
  col('OCCUPATION', 'varchar', 60, many(() => pick(['Teacher', 'Farmer', 'Tour guide'])), 'BZ_L2_OCCUPATION'),
  col('JOB_TITLE', 'varchar', 60, many(() => pick(['Analyst', 'Head of department', 'Sales clerk'])), 'BZ_L2_OCCUPATION'),
  col('EMPLOYER_NAME', 'varchar', 80, many(() => `Trading ${int(1, 99)} Ltd.`), 'BZ_L2_EMPLOYER'),
  col('EDUCATION_LEVEL', 'varchar', 40, many(() => pick(['Primary', 'Secondary', 'Tertiary'])), 'BZ_L2_EDUCATION'),
  col('SCHOOL_NAME', 'varchar', 80, many(() => pick(["St. John's College", 'Belize High School', 'Muffles College High School'])), 'BZ_L2_SCHOOL'),
  col('NO_OF_CHILDREN', 'number', 2, many(() => String(int(0, 8))), 'BZ_L2_DEPENDANTS'),

  // L3
  col('ETHNICITY', 'varchar', 30, many(() => pick(['Mestizo', 'Creole', 'Garifuna', 'Maya Mopan'])), 'BZ_L3_ETHNICITY'),
  col('INDIGENOUS', 'char', 1, many(() => pick(['Y', 'N'])), 'BZ_L3_ETHNICITY'),
  col('FIELD13', 'varchar', 30, many(() => pick(['Mestizo', 'Creole', 'Garifuna', "Q'eqchi'", 'Mennonite', 'East Indian'])), 'BZ_L3_ETHNICITY'),
  col('MOTHER_TONGUE', 'varchar', 30, many(() => pick(['English', 'Spanish', 'Kriol', 'Garifuna'])), 'BZ_L3_LANGUAGE'),
  col('RELIGION', 'varchar', 40, many(() => pick(['Roman Catholic', 'Pentecostal', 'Anglican', 'None'])), 'BZ_L3_RELIGION'),
  col('CONSCIENTIOUS_OBJECTION', 'varchar', 60, many(() => pick(['Blood transfusions', 'None'])), 'BZ_L3_BELIEF'),
  col('VOTING_INTENTION', 'varchar', 40, many(() => pick(['Left', 'Right', 'Undecided'])), 'BZ_L3_POLITICAL_OPINION'),
  col('PARTY_MEMBERSHIP', 'varchar', 60, many(() => pick(["People's United Party", 'United Democratic Party', 'PUP', 'UDP'])), 'BZ_L3_POLITICAL_MEMBERSHIP'),
  col('UNION_MEMBER', 'char', 1, many(() => pick(['Y', 'N'])), 'BZ_L3_TRADE_UNION'),
  col('DNA_PROFILE', 'varchar', 200, many(() => 'AGTC'.repeat(10)), 'BZ_L3_GENETIC'),
  col('FINGERPRINT_TEMPLATE', 'varchar', 200, many(() => many(() => pick('ABCDEF0123456789'), 64).join('')), 'BZ_L3_BIOMETRIC'),
  col('SEXUAL_ORIENTATION', 'varchar', 30, many(() => pick(['Heterosexual', 'Gay', 'Bisexual'])), 'BZ_L3_SEXUAL_ORIENTATION'),
  col('SEXUAL_ACTIVITY', 'varchar', 30, many(() => 'Active'), 'BZ_L3_SEXUAL_LIFE'),
  col('GENDER_IDENTITY', 'varchar', 30, many(() => pick(['Woman', 'Trans man', 'Non-binary'])), 'BZ_L3_GENDER_IDENTITY'),

  // HEALTH
  col('BHIS_NO', 'varchar', 12, many(() => String(int(100000, 9999999))), 'BZ_HEALTH_ID'),
  col('DIAGNOSIS', 'varchar', 10, many(() => pick(['E11.9', 'I10', 'J45.9', 'F32.1'])), 'BZ_HEALTH_DIAGNOSIS'),
  col('ICD10_CODE', 'varchar', 6, many(() => pick(['E11', 'I10', 'F20', 'B20'])), 'BZ_HEALTH_DIAGNOSIS'),
  col('MEDICATION', 'varchar', 40, many(() => pick(['Sertraline', 'Paracetamol', 'Metformin'])), 'BZ_HEALTH_MEDICATION'),
  col('CLINICAL_NOTES', 'clob', 4000, many(() => `Patient reports abdominal pain for ${int(1, 9)} days.`), 'BZ_HEALTH_CLINICAL_TEXT'),
  col('HIV_STATUS', 'varchar', 12, many(() => pick(['Reactive', 'Non-reactive'])), 'BZ_HEALTH_TEST_RESULT'),
  col('BLOOD_TYPE', 'varchar', 4, many(() => pick(['A+', 'O-', 'AB+'])), 'BZ_HEALTH_BLOOD_GROUP'),
  col('DISABILITY_TYPE', 'varchar', 40, many(() => pick(['Seeing', 'Hearing', 'None'])), 'BZ_HEALTH_DISABILITY'),
  col('PREGNANT', 'char', 1, many(() => pick(['Y', 'N'])), 'BZ_HEALTH_REPRODUCTIVE'),
  col('MENTAL_HEALTH_CONDITION', 'varchar', 60, many(() => pick(['Depression', 'Anxiety'])), 'BZ_HEALTH_MENTAL'),

  // FIN
  col('CREDIT_SCORE', 'number', 3, many(() => String(int(300, 850))), 'BZ_FIN_CREDIT_REFERENCE'),
  col('ARREARS_STATUS', 'varchar', 30, many(() => pick(['Current', '90 days past due'])), 'BZ_FIN_CREDIT_REFERENCE'),
  col('LOAN_BALANCE', 'number', 12, many(() => String(int(1000, 90000))), 'BZ_FIN_DEBT'),
  col('MONTHLY_SALARY', 'number', 10, many(() => String(int(900, 9000))), 'BZ_FIN_INCOME'),
  col('PROPERTY_VALUE', 'number', 12, many(() => String(int(30000, 900000))), 'BZ_FIN_ASSETS'),
  col('PENSION_AMOUNT', 'number', 8, many(() => String(int(100, 3000))), 'BZ_FIN_PENSION'),
  col('BENEFIT_TYPE', 'varchar', 40, many(() => pick(['Sickness benefit', 'Maternity allowance', 'Retirement pension'])), 'BZ_FIN_SSB_BENEFIT'),
  col('BOOST_BENEFICIARY', 'char', 1, many(() => pick(['Y', 'N'])), 'BZ_FIN_SOCIAL_PROGRAMME'),
  col('POVERTY_STATUS', 'varchar', 20, many(() => pick(['Extremely poor', 'Poor', 'Not poor'])), 'BZ_FIN_POVERTY'),
  col('HOUSING_TENURE', 'varchar', 30, many(() => pick(['Owned', 'Rented (private)', 'Rent free'])), 'BZ_FIN_HOUSING'),

  // PENAL
  col('CRIMINAL_RECORD', 'varchar', 30, many(() => pick(['No criminal record', 'Has criminal record'])), 'BZ_PENAL_CRIMINAL_RECORD'),
  col('COURT_CASE_NO', 'varchar', 15, many(() => `C${int(1, 999)}/${int(2015, 2025)}`), 'BZ_PENAL_CASE_NUMBER'),

  // Not personal data: nothing should be assigned
  col('ID', 'integer', 10, many((i) => String(i + 1)), ''),
  col('FILE_PATH', 'varchar', 200, many(() => `/data/file${int(1, 99)}.txt`), ''),
  col('PRODUCT_NAME', 'varchar', 80, many(() => pick(['Whole milk 1L', 'Rice 5 lb', 'Ground coffee 400 g'])), ''),
  col('COMPANY_NAME', 'varchar', 80, many(() => `Trading ${int(1, 99)} Ltd.`), ''),
  col('SALE_AMOUNT', 'number', 12, many(() => String(int(1000, 99999999))), ''),
  col('CREATED_DATE', 'date', 0, many(() => iso(2015, 2025)), ''),
  col('ENTRY_DATE', 'date', 0, many(() => iso(2015, 2025)), ''),
  col('DOC_DATE', 'varchar', 10, many(() => `${pad(int(1, 12), 2)}-${pad(int(1, 12), 2)}-${int(2015, 2025)}`), ''),
  col('CODE', 'varchar', 10, many(() => `A-${int(100, 999)}`), ''),
  col('PRODUCT_DESCRIPTION', 'varchar', 400, many(() => 'Staple consumer product, recyclable cardboard packaging.'), ''),
  col('STATUS', 'varchar', 10, many(() => pick(['ACTIVE', 'INACTIVE'])), ''),
  col('QUANTITY', 'number', 6, many(() => String(int(1, 500))), ''),
  col('SKU', 'varchar', 12, many(() => `SKU${int(10000, 99999)}`), ''),
  col('HOTEL', 'varchar', 60, many(() => 'Central Hotel'), ''),
  col('TRANSACTION_ID', 'varchar', 36, many(() => `TX${int(100000, 999999)}`), ''),
  col('DEPARTMENT', 'varchar', 40, many(() => pick(['Finance', 'Operations'])), ''),
  col('PRODUCT_KEY', 'varchar', 10, many(() => `P-${int(100, 999)}`), ''),
  col('BANK_CHARGES', 'number', 8, many(() => String(int(1, 99))), ''),
  col('CABLE_LENGTH', 'number', 6, many(() => `${int(1, 99)}.5`), ''),
  col('PAGE_URL', 'varchar', 200, many(() => `https://www.example.bz/p/${int(1, 999)}`), ''),
  col('DOCUMENT_TYPE', 'varchar', 20, many(() => pick(['Invoice', 'Credit note'])), ''),
  col('CURRENCY', 'varchar', 3, many(() => pick(['BZD', 'USD'])), ''),
  col('CATEGORY', 'varchar', 30, many(() => pick(['Dairy', 'Bakery'])), ''),
  col('DISTRICT', 'varchar', 30, many(() => pick(['Belize', 'Cayo', 'Toledo', 'Orange Walk'])), ''),
  col('PARTY_ID', 'varchar', 10, many(() => `PTY-${int(1000, 9999)}`), ''),
  col('THIRD_PARTY', 'varchar', 60, many(() => `Vendor ${int(1, 99)} Ltd.`), ''),
  col('LANGUAGE_CODE', 'varchar', 5, many(() => pick(['en', 'es', 'en-US'])), ''),
  col('DEFAULT_VALUE', 'varchar', 20, many(() => pick(['0', 'N/A', 'true'])), ''),
  col('SORT_POSITION', 'number', 4, many(() => String(int(1, 99))), ''),
  col('CONDITION', 'varchar', 10, many(() => pick(['New', 'Used'])), ''),
  col('CASE_STATUS', 'varchar', 10, many(() => pick(['Open', 'Closed', 'Pending'])), ''),
  col('MESSAGE_ID', 'varchar', 36, many(() => `MSG${int(100000, 999999)}`), ''),
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
  const negatives = COLUMNS.filter((c) => !c.expect).length
  console.log(`profiled ${COLUMNS.length} columns (${negatives} not personal data): ${passed} as expected`)

  // The essential pack runs only the classifiers of its domains. Its columns must still land where
  // they did, and no other column may be taken for one of its domains now that the domains that
  // used to win those columns are not there.
  const essential = new Set(preset.packs.essential.domains)
  const pack = resolved.filter((c) => essential.has(c.domain))
  // A seven-digit code whose name no essential domain knows looks like a landline by its values
  // alone. In the extended pack a column-name rule claims it (BHIS_NO is a health identifier); here
  // the telephone is the only candidate left, and profiling proposes it.
  const ALSO = { BHIS_NO: 'BZ_L1_PHONE' }
  let packPassed = 0
  for (const column of COLUMNS) {
    const expect = essential.has(column.expect) ? column.expect : (ALSO[column.name] ?? '')
    const field = { name: column.name, parent: null, sqlType: column.sqlType, length: column.length || null, autoIncrement: false, values: column.values }
    const result = kit.evaluateField({ classifiers: pack, field, threshold: preset.profileSet.threshold, readFile })
    if (result.assigned === expect) { packPassed++; continue }
    failures++
    const ranking = result.ranking.slice(0, 3).map((r) => `${r.domain} ${r.percent}%`).join(', ')
    console.log(`  ✗ essential pack, ${column.name}: expected ${expect || '(none)'}, got ${result.assigned || '(none)'} — ${ranking}`)
  }
  console.log(`profiled ${COLUMNS.length} columns with the essential pack (${pack.length} classifiers): ${packPassed} as expected`)
}

// ── Towns and villages, offline ─────────────────────────────────────────────
//
// Every place of under 5,000 inhabitants must become one of at least 5,000 of the same district —
// unless its name is shared with a place of another district, which the table cannot tell apart.

// Names that are also how a large place is written: a small place bearing one keeps it.
const WRITTEN_FOR = { 'San Pedro': 'San Pedro Town' }

function verifyGeneralization() {
  const table = new Map(fs.readFileSync(nodePath.join(HERE, 'files', 'bz-town-village-generalized.txt'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('|')))
  const byName = new Map()
  for (const p of PLACES) byName.set(p.name, [...(byName.get(p.name) ?? []), p])
  for (const [alias, town] of Object.entries(WRITTEN_FOR)) byName.set(alias, [...(byName.get(alias) ?? []), ...byName.get(town)])
  let ok = 0
  let shared = 0
  for (const p of PLACES) {
    const to = table.get(p.name)
    const target = (byName.get(to) ?? []).find((x) => x.population >= 5000)
    const homonyms = byName.get(p.name)
    const problem = !to ? 'not in the table'
      : p.population >= 5000 ? (to === p.name ? null : 'a large place was generalized')
        : homonyms.some((x) => x.population >= 5000) ? (to === p.name ? null : 'kept name expected')
          : !target ? `became ${to}, under 5,000`
            : homonyms.length === 1 && target.district !== p.district ? `became ${to}, in another district` : null
    if (homonyms.length > 1 && p.population < 5000) shared++
    if (problem) { failures++; console.log(`  ✗ ${p.name} (${p.district}, ${p.population}): ${problem}`) }
    else ok++
  }
  for (const [from, to] of table) if (table.get(from.toUpperCase()) !== to.toUpperCase()) { failures++; console.log(`  ✗ ${from}: no upper-case line`) }
  console.log(`towns and villages: ${ok} of ${PLACES.length} generalized as expected (${shared} small places share a name)`)
}

// ── Algorithms ──────────────────────────────────────────────────────────────

const words = (s) => s.trim().split(/\s+/).length
const sameShape = (i, o) => i.length === o.length && i.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9') === o.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9')
const digitShape = (i, o) => i.length === o.length && i.replace(/\d/g, '9') === o.replace(/\d/g, '9')
const MASKING = {
  BZ_L1_SOCIAL_SECURITY_NUMBER: { inputs: ['000123456', '123-456-789', '987 654 321', ...many(ssn, 10)], check: digitShape },
  BZ_L1_TIN: { inputs: ['123456', '1234567'], check: digitShape },
  BZ_L1_PASSPORT: { inputs: ['P0123456'], check: sameShape },
  BZ_L1_VOTER_ID: { inputs: ['123456'] },
  BZ_L1_DRIVERS_LICENCE: { inputs: ['BZ-012345'] },
  BZ_L1_IMMIGRATION_DOCUMENT: { inputs: ['PR 12345'] },
  BZ_L1_VITAL_RECORD: { inputs: ['1234/1985'] },
  // Four words fall through to the Character Mapping: it must mask them, not act as a name lookup.
  BZ_L1_GIVEN_NAME: { inputs: ['Kenrick', 'MARIA ISABEL', 'Shanice', 'Ana Maria Jose Luisa'], check: (i, o) => words(i) === words(o) },
  BZ_L1_SURNAME: { inputs: ['Gillett', 'CAYETANO', 'Gomez Cal', 'Young-Flowers'], check: (i, o) => words(i) === words(o) && i.includes('-') === o.includes('-') },
  BZ_L1_FULL_NAME: {
    inputs: ['Kenrick Gillett', 'MARIA ISABEL CHOC', 'Kenrick A. Gillett', 'Jose Luis Martinez Cal', 'Gillett, Kenrick'],
    check: (i, o) => words(i) === words(o) && (!/ [A-Z]\. /.test(i) || / [A-Z]\. /.test(o)),
  },
  BZ_L1_EMAIL: { inputs: ['kenrick.gillett@gmail.com', 'josé.núñez@company.bz'], check: (i, o) => /@[^@]+\.test$/.test(o) },
  BZ_L1_PHONE: {
    inputs: ['+501 622-4567', '6224567', '622-4567', '223-4567', '(501) 822-1234', '501-722-3456'],
    // +501 and the first digit stay; the length does too.
    check: (i, o) => o.length === i.length && o.startsWith(i.match(/^(\+?\(?501\)?[\s-]?)?\d/)[0]),
  },
  BZ_L1_ADDRESS: { inputs: ['#24 Cleghorn Street, Belize City', 'Mile 8 George Price Highway'] },
  BZ_L1_ADDRESS_DETAIL: { inputs: ['Apt. 4B', '12'] },
  BZ_L1_BANK_ACCOUNT: { inputs: ['010-123456-7'], check: digitShape },
  BZ_L1_PAYMENT_CARD: { inputs: ['4916 3131 2345 6780'] },
  BZ_L1_IP_ADDRESS: {
    inputs: ['200.32.211.10', '2001:db8::1'],
    check: (i, o) => (i.includes('.') ? o.split('.').every((p) => Number(p) >= 1 && Number(p) <= 254) : /^[0-9a-f:]+$/i.test(o)),
  },
  BZ_L1_DEVICE_ID: { inputs: ['3c:22:fb:9a:10:e4', '356938035643809'], check: (i, o) => (i.includes(':') ? /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(o) : /^\d{15}$/.test(o)) },
  BZ_L1_LICENCE_PLATE: {
    inputs: ['CY C-12345', 'BZ 12345', 'CZL-4567', 'M-1234', '12345'],
    check: (i, o) => digitShape(i, o) && (i.match(/^[A-Z]*/)[0] === o.match(/^[A-Z]*/)[0]),
  },
  BZ_L1_VIN: { inputs: ['1HGCM82633A004352'], check: sameShape },
  BZ_L1_LAND_PARCEL: {
    inputs: ['Caribbean Shores, Block 16, Parcel 1234', 'Block 45 Parcel 67', '16/1234'],
    check: (i, o) => digitShape(i, o) && o.replace(/\d/g, '') === i.replace(/\d/g, ''),
  },
  BZ_L1_CONTRACT_NUMBER: { inputs: ['POL-123456'] },
  BZ_L1_USERNAME: { inputs: ['@kenrick_g'] },
  BZ_L1_CREDENTIAL: { inputs: ['Secret#2024'], check: (i, o) => /^X+$/.test(o) },
  BZ_L1_GEOLOCATION: { inputs: ['17.251234', '17.251234,-88.759876'], check: (i, o) => o.slice(0, 4) === i.slice(0, 4) },
  BZ_L1_FREE_TEXT: {
    inputs: ['Customer Gillett, SSN 000123456, email k.gillett@gmail.com, tel 622-4567.'],
    check: (i, o) => !/000123456|k\.gillett@gmail\.com|622-4567|Gillett/.test(o),
  },
  BZ_L2_BIRTH_DATE: { inputs: ['1985-07-20', '2008-01-15'], check: (i, o) => Math.abs(new Date(o.slice(0, 10)) - new Date(i)) <= 60 * 864e5 },
  BZ_L2_BIRTH_YEAR: { inputs: ['1985'], check: (i, o) => o.startsWith('198'), same: true },
  BZ_L2_AGE: { inputs: ['37', '7', '104'], check: (i, o) => (i === '104' ? o === '90' : i.length === 1 || o[0] === i[0]), same: true },
  BZ_L2_EVENT_DATE: { inputs: ['2021-03-15'] },
  BZ_L2_SEX: { inputs: ['F', 'M', 'H', 'Female', 'male', 'Hombre'], same: true },
  BZ_L2_TOWN_VILLAGE: { inputs: ['Crooked Tree', 'Belmopan', 'Caye Caulker', 'HOPKINS', 'San Pedro', 'Mango Creek'], same: true },
  BZ_L2_NEIGHBOURHOOD: { inputs: ['Yarborough'], same: true },
  BZ_L2_NATIONALITY: { inputs: ['Guatemalan'], same: true },
  BZ_L2_MARITAL_STATUS: { inputs: ['Common-law'], same: true },
  BZ_L2_OCCUPATION: { inputs: ['Regional Operations Manager, Toledo'] },
  BZ_L2_EMPLOYER: { inputs: ['Belize Electricity Limited'] },
  BZ_L2_EDUCATION: { inputs: ['Sixth form'], same: true },
  BZ_L2_SCHOOL: { inputs: ["St. John's College"] },
  BZ_L2_DEPENDANTS: { inputs: ['9', '2'], check: (i, o) => Number(o) <= 5, same: true },
  BZ_L3_ETHNICITY: { inputs: ['Garinagu', 'Y'], same: true },
  BZ_L3_LANGUAGE: { inputs: ['Garifuna', 'N'], same: true },
  BZ_L3_RELIGION: { inputs: ['Salvation Army', 'Y'], same: true },
  BZ_L3_BELIEF: { inputs: ['Refuses blood transfusions'] },
  BZ_L3_POLITICAL_OPINION: { inputs: ['Centre-right'], same: true },
  BZ_L3_POLITICAL_MEMBERSHIP: { inputs: ['United Democratic Party', 'Y'], same: true },
  BZ_L3_TRADE_UNION: { inputs: ['BNTU', 'Y'], same: true },
  BZ_L3_GENETIC: { inputs: ['BRCA1 positive'] },
  BZ_L3_BIOMETRIC: { inputs: ['A1B2C3D4E5F6'] },
  BZ_L3_SEXUAL_ORIENTATION: { inputs: ['Bisexual'], same: true },
  BZ_L3_SEXUAL_LIFE: { inputs: ['Active'] },
  BZ_L3_GENDER_IDENTITY: { inputs: ['Trans man'], same: true },
  BZ_HEALTH_ID: { inputs: ['BHIS-2024-00123'] },
  BZ_HEALTH_DIAGNOSIS: { inputs: ['F32.9', 'B20', 'Major depression'], same: true },
  BZ_HEALTH_MEDICATION: { inputs: ['Sertraline 50 mg'] },
  BZ_HEALTH_CLINICAL_TEXT: { inputs: ['Patient Gillett, SSN 000123456, seen for headache.'], check: (i, o) => !o.includes('000123456') },
  BZ_HEALTH_TEST_RESULT: { inputs: ['Reactive'] },
  BZ_HEALTH_BLOOD_GROUP: { inputs: ['O+'], same: true },
  BZ_HEALTH_DISABILITY: { inputs: ['Severe psychosocial disability', 'N'], same: true },
  BZ_HEALTH_REPRODUCTIVE: { inputs: ['12 weeks pregnant', 'Y'], same: true },
  BZ_HEALTH_MENTAL: { inputs: ['Bipolar disorder'] },
  BZ_FIN_CREDIT_REFERENCE: { inputs: ['90 days past due', '745', 'N'], same: true },
  BZ_FIN_DEBT: { inputs: ['8500'] },
  BZ_FIN_INCOME: { inputs: ['2400', '2400.50'] },
  BZ_FIN_ASSETS: { inputs: ['185000'] },
  BZ_FIN_PENSION: { inputs: ['680'] },
  BZ_FIN_SSB_BENEFIT: { inputs: ['Disablement benefit', 'Y'], same: true },
  BZ_FIN_SOCIAL_PROGRAMME: { inputs: ['Pantry programme', 'N'], same: true },
  BZ_FIN_POVERTY: { inputs: ['Extremely poor', '3', 'Decile 8', 'Quintile 2'], same: true },
  BZ_FIN_HOUSING: { inputs: ['Family land'], same: true },
  BZ_PENAL_CRIMINAL_RECORD: { inputs: ['Convicted of burglary, 2019', 'Y'], same: true },
  BZ_PENAL_CASE_NUMBER: { inputs: ['C123/2023', '456 of 2022'] },
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
/** true or false for a Y/N flag, null for anything else. */
const flag = (i, o) => (/^[YN]$/i.test(i) ? /^[YN]$/i.test(o) : null)
const SUPPRESSED = 'Not stated'
const LARGE = new Set(PLACES.filter((p) => p.population >= 5000).map((p) => p.name.toLowerCase()))
const EXPECT = {
  BZ_L1_GIVEN_NAME: (i, o) => words(i) > 3 || o.split(/\s+/).every((w) => has('bz-given-names.txt', w)),
  BZ_L1_SURNAME: (i, o) => o.split(/[\s\-]+/).every((w) => has('bz-surnames.txt', w)),
  BZ_L1_FULL_NAME: (i, o) => i.includes(',') || (has('bz-given-names.txt', o.split(/\s+/)[0]) && has('bz-surnames.txt', o.split(/\s+/).at(-1))),
  BZ_L1_ADDRESS: (i, o) => has('bz-addresses.txt', o),
  BZ_L2_SEX: (i, o) => ({ f: ['f', 'm'], m: ['f', 'm'], h: ['h', 'm'], female: ['female', 'male'], male: ['female', 'male'], hombre: ['mujer', 'hombre'] })[i.toLowerCase()].includes(o.toLowerCase()),
  // Crooked Tree, Caye Caulker and Hopkins become a place of 5,000 or more; Belmopan stays; the
  // San Pedro is also how San Pedro Town is written and stays; Mango Creek is counted inside
  // Independence (4,878), which becomes Dangriga.
  BZ_L2_TOWN_VILLAGE: (i, o) => ({ Belmopan: o === 'Belmopan', 'San Pedro': o === 'San Pedro', 'Mango Creek': o === 'Dangriga', HOPKINS: o === 'DANGRIGA' })[i] ?? LARGE.has(o.toLowerCase()),
  BZ_L2_NEIGHBOURHOOD: (i, o) => has('bz-neighbourhoods.txt', o),
  BZ_L2_NATIONALITY: (i, o) => has('bz-nationalities.txt', o),
  BZ_L2_MARITAL_STATUS: (i, o) => has('bz-marital-status.txt', o),
  BZ_L2_OCCUPATION: (i, o) => has('bz-occupations.txt', o),
  BZ_L2_EMPLOYER: (i, o) => has('bz-employers.txt', o),
  BZ_L2_EDUCATION: (i, o) => has('bz-education.txt', o),
  BZ_L2_SCHOOL: (i, o) => has('bz-schools.txt', o),
  BZ_L3_ETHNICITY: (i, o) => flag(i, o) ?? has('bz-ethnic-groups.txt', o),
  BZ_L3_LANGUAGE: (i, o) => flag(i, o) ?? has('bz-languages.txt', o),
  BZ_L3_RELIGION: (i, o) => flag(i, o) ?? has('bz-religions.txt', o),
  BZ_L3_BELIEF: (i, o) => o === SUPPRESSED,
  BZ_L3_POLITICAL_OPINION: (i, o) => has('bz-political-opinions.txt', o),
  BZ_L3_POLITICAL_MEMBERSHIP: (i, o) => flag(i, o) ?? has('bz-political-parties.txt', o),
  BZ_L3_TRADE_UNION: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  BZ_L3_SEXUAL_ORIENTATION: (i, o) => has('bz-sexual-orientations.txt', o),
  BZ_L3_SEXUAL_LIFE: (i, o) => o === SUPPRESSED,
  BZ_L3_GENDER_IDENTITY: (i, o) => has('bz-gender-identities.txt', o),
  BZ_HEALTH_DIAGNOSIS: (i, o) => (/\.\d/.test(i) ? has('bz-icd10-decimal.txt', o) : /^[A-Z]\d{2}$/i.test(i) ? has('bz-icd10.txt', o) : has('bz-diagnoses.txt', o)),
  BZ_HEALTH_MEDICATION: (i, o) => has('bz-medications.txt', o),
  BZ_HEALTH_BLOOD_GROUP: (i, o) => has('bz-blood-groups.txt', o),
  BZ_HEALTH_DISABILITY: (i, o) => flag(i, o) ?? has('bz-disabilities.txt', o),
  BZ_HEALTH_REPRODUCTIVE: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  BZ_HEALTH_MENTAL: (i, o) => o === SUPPRESSED,
  BZ_FIN_CREDIT_REFERENCE: (i, o) => flag(i, o) ?? (/^\d{3}$/.test(i) ? /^\d{3}$/.test(o) : has('bz-credit-statuses.txt', o)),
  BZ_FIN_SSB_BENEFIT: (i, o) => flag(i, o) ?? has('bz-ssb-benefits.txt', o),
  BZ_FIN_SOCIAL_PROGRAMME: (i, o) => flag(i, o) ?? has('bz-social-programmes.txt', o),
  BZ_FIN_POVERTY: (i, o) => (/^\d$/.test(i) ? /^[1-5]$/.test(o) : /^decile/i.test(i) ? /^Decile ([1-9]|10)$/.test(o) : /^quintile/i.test(i) ? /^Quintile [1-5]$/.test(o) : has('bz-poverty-statuses.txt', o)),
  BZ_FIN_HOUSING: (i, o) => has('bz-housing-tenure.txt', o),
  BZ_PENAL_CRIMINAL_RECORD: (i, o) => flag(i, o) ?? has('bz-criminal-record.txt', o),
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
  // Every algorithm masks its own sample input, which is what the tester opens it with.
  for (const a of preset.algorithms) {
    if (a.input === undefined) { failures++; console.log(`  ✗ ${a.name} has no sample input`) }
    else jobs.push({ domain: { name: a.name, algorithm: a.name }, input: a.input, sample: true })
  }
  // Real columns hold placeholders too. Masking them may change them or not, but must not fail —
  // except in typed columns (dates, amounts), where the database would not hold them.
  const TYPED = new Set(['BZ_L2_BIRTH_DATE', 'BZ_L2_EVENT_DATE', 'BZ_FIN_DEBT', 'BZ_FIN_INCOME', 'BZ_FIN_ASSETS', 'BZ_FIN_PENSION'])
  for (const d of preset.domains.filter((x) => !TYPED.has(x.name))) {
    for (const input of ['N/A', 'not stated', '-']) jobs.push({ domain: d, input, placeholder: true })
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
      // A placeholder or an algorithm's own sample input only has to mask without failing.
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

  // Different keys must stay different: a social security number used as a key cannot collide.
  const inputs = [...new Set(many(ssn, 150))]
  const outputs = new Set()
  for (const input of inputs) outputs.add((await run('BZ_CM_ALNUM', input)).output)
  if (outputs.size !== inputs.length) { failures++; console.log(`  ✗ BZ_CM_ALNUM: ${inputs.length} social security numbers gave ${outputs.size} distinct outputs`) }
  else console.log(`social security numbers: ${inputs.length} distinct inputs, ${outputs.size} distinct outputs`)
}

if (only !== 'algorithms') { verifyClassifiers(); verifyGeneralization() }
if (only !== 'classifiers') await verifyAlgorithms()
console.log(failures ? `\n${failures} problem(s)` : '\nall good')
process.exit(failures ? 1 : 0)
