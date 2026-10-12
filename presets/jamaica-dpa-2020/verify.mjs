#!/usr/bin/env node
/**
 * Checks the Jamaica (Data Protection Act, 2020) preset.
 *
 *   node presets/jamaica-dpa-2020/verify.mjs               # classifiers, then algorithms
 *   node presets/jamaica-dpa-2020/verify.mjs classifiers   # only the local profiling check
 *   node presets/jamaica-dpa-2020/verify.mjs algorithms    # only masking, against the app
 *
 * Classifiers run through classifiers/, the same evaluator the classifier test uses: every
 * configuration is reviewed, then a battery of columns — well named, badly named and unrelated —
 * is profiled with the whole set at its threshold. The table that generalizes towns is audited
 * offline. Algorithms run in the app (DLPX_URL, default http://localhost:3000), which needs the
 * Delphix jars in lib/.
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

let seed = 876
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
const PLACES = source('places.tsv').map((l) => { const [name, parish, population] = l.split('\t'); return { name, parish, population: Number(population) } })
const CAPITALS = {
  Kingston: 'Kingston', 'Saint Andrew': 'Half Way Tree', 'Saint Thomas': 'Morant Bay', Portland: 'Port Antonio', 'Saint Mary': 'Port Maria',
  'Saint Ann': "Saint Ann's Bay", Trelawny: 'Falmouth', 'Saint James': 'Montego Bay', Hanover: 'Lucea', Westmoreland: 'Savanna-la-Mar',
  'Saint Elizabeth': 'Black River', Manchester: 'Mandeville', Clarendon: 'May Pen', 'Saint Catherine': 'Spanish Town',
}
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '')
const PERSONAL = new Set([...GIVEN, ...SURNAMES].map((w) => fold(w).toLowerCase()))
const PARISH_NAMES = new Set(Object.keys(CAPITALS).map((n) => n.toLowerCase()))
const PLACE_NAMES = PLACES.map((p) => p.name).filter((n) => !PERSONAL.has(fold(n).toLowerCase()) && !PARISH_NAMES.has(n.toLowerCase()))

const pad = (n, w) => String(n).padStart(w, '0')
const trn = () => String(int(100000000, 199999999))
const trnDashed = () => trn().replace(/(\d{3})(\d{3})(\d{3})/, '$1-$2-$3')
const luhn = (prefix, length) => {
  const ds = [...prefix].map(Number)
  while (ds.length < length - 1) ds.push(int(0, 9))
  const sum = ds.slice().reverse().reduce((s, d, i) => s + (i % 2 === 0 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0)
  return ds.join('') + String((10 - (sum % 10)) % 10)
}
const iso = (y0, y1) => `${int(y0, y1)}-${pad(int(1, 12), 2)}-${pad(int(1, 28), 2)}`
const fullName = () => `${pick(GIVEN)}${random() < 0.4 ? ` ${pick(GIVEN)}` : ''} ${pick(SURNAMES)}`
const phone = () => pick([`876-${int(200, 999)}-${int(1000, 9999)}`, `+1 876 ${int(200, 999)} ${int(1000, 9999)}`, `(876) ${int(200, 999)}-${int(1000, 9999)}`, `1658${int(2000000, 9999999)}`])
const local = () => `${int(200, 999)}-${int(1000, 9999)}`
const plate = () => pick([`${int(1000, 9999)} ${pick(['AB', 'GH', 'FK', 'HW', 'JM'])}`, `${pick(['PP', 'PA', 'CA', 'CB', 'RR'])} ${int(1000, 9999)}`])
const STREETS = source('streets.txt')
const address = () => pick([`${int(1, 200)} ${pick(STREETS)}`, `Lot ${int(1, 900)}, Greater Portmore, Portmore`, `${pick(['Content', 'Mocho', 'Nain', 'Bamboo'])} District, ${pick(['Linstead', 'May Pen', 'Santa Cruz'])} P.O., St. ${pick(['Catherine', 'Ann', 'Elizabeth'])}`])
const title = () => pick([`Volume ${int(1000, 1600)} Folio ${int(1, 999)}`, `Vol. ${int(1000, 1600)} Fol. ${int(1, 999)}`])
const NEIGHBOURHOODS = source('neighbourhoods.txt')

// ── Classifiers ─────────────────────────────────────────────────────────────

const SQL = { varchar: 12, char: 1, number: 2, integer: 4, date: 91, timestamp: 93, clob: 2005 }
const col = (name, type, length, values, expect) => ({ name, sqlType: SQL[type], length, values, expect })

const COLUMNS = [
  // L1 — well named
  col('TRN', 'varchar', 11, many(trnDashed), 'JM_L1_TRN'),
  col('TRN_NO', 'varchar', 9, many(trn), 'JM_L1_TRN'),
  col('taxpayerRegistrationNumber', 'varchar', 11, many(trnDashed), 'JM_L1_TRN'),
  col('NIN', 'varchar', 9, many(trn), 'JM_L1_TRN'),
  col('NIS_NO', 'varchar', 10, many(() => `${pick(['A', 'B', 'C', 'D'])}${int(100000, 999999)}`), 'JM_L1_NIS_NUMBER'),
  col('NATIONAL_INSURANCE_NUMBER', 'varchar', 10, many(() => String(int(1000000, 9999999))), 'JM_L1_NIS_NUMBER'),
  col('PASSPORT_NO', 'varchar', 10, many(() => `A${int(1000000, 9999999)}`), 'JM_L1_PASSPORT'),
  col('VOTER_ID', 'varchar', 10, many(() => String(int(100000, 999999))), 'JM_L1_VOTER_ID'),
  col('DRIVERS_LICENCE_NO', 'varchar', 9, many(trn), 'JM_L1_DRIVERS_LICENCE'),
  col('WORK_PERMIT_NO', 'varchar', 12, many(() => `WP${int(10000, 99999)}`), 'JM_L1_IMMIGRATION_DOCUMENT'),
  col('BIRTH_CERT_NO', 'varchar', 12, many(() => `${int(1, 9999)}/${int(1950, 2024)}`), 'JM_L1_VITAL_RECORD'),
  col('FIRST_NAME', 'varchar', 30, many(() => pick(GIVEN)), 'JM_L1_GIVEN_NAME'),
  col('MIDDLE_NAME', 'varchar', 30, many(() => pick(GIVEN)), 'JM_L1_GIVEN_NAME'),
  col('LAST_NAME', 'varchar', 30, many(() => pick(SURNAMES)), 'JM_L1_SURNAME'),
  col('MAIDEN_NAME', 'varchar', 30, many(() => pick(SURNAMES)), 'JM_L1_SURNAME'),
  col('FULL_NAME', 'varchar', 120, many(fullName), 'JM_L1_FULL_NAME'),
  col('CUSTOMER_NAME', 'varchar', 120, many(fullName), 'JM_L1_FULL_NAME'),
  col('NAME', 'varchar', 120, many(fullName), 'JM_L1_FULL_NAME'),
  col('NEXT_OF_KIN', 'varchar', 120, many(fullName), 'JM_L1_FULL_NAME'),
  col('EMAIL', 'varchar', 100, many(() => `${fold(pick(GIVEN)).toLowerCase()}.${int(1, 999)}@gmail.com`), 'JM_L1_EMAIL'),
  col('EMAIL_ADDRESS', 'varchar', 100, many(() => `contact${int(1, 999)}@company.com.jm`), 'JM_L1_EMAIL'),
  col('MOBILE_NO', 'varchar', 20, many(phone), 'JM_L1_PHONE'),
  col('HOME_PHONE', 'varchar', 12, many(local), 'JM_L1_PHONE'),
  col('ADDRESS', 'varchar', 120, many(address), 'JM_L1_ADDRESS'),
  col('ADDRESS_LINE1', 'varchar', 120, many(() => `${int(1, 200)} ${pick(STREETS)}`), 'JM_L1_ADDRESS'),
  col('HOUSE_NO', 'varchar', 6, many(() => String(int(1, 400))), 'JM_L1_ADDRESS_DETAIL'),
  col('ACCOUNT_NO', 'varchar', 12, many(() => String(int(1e8, 9.9e10))), 'JM_L1_BANK_ACCOUNT'),
  col('CARD_NUMBER', 'varchar', 19, many(() => luhn('4', 16)), 'JM_L1_PAYMENT_CARD'),
  col('IP_ADDRESS', 'varchar', 15, many(() => `${int(1, 223)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`), 'JM_L1_IP_ADDRESS'),
  col('MAC_ADDRESS', 'varchar', 17, many(() => many(() => int(0, 255).toString(16).padStart(2, '0'), 6).join(':')), 'JM_L1_DEVICE_ID'),
  col('IMEI', 'varchar', 15, many(() => luhn('35', 15)), 'JM_L1_DEVICE_ID'),
  col('LICENSE_PLATE', 'varchar', 10, many(plate), 'JM_L1_LICENCE_PLATE'),
  col('VIN', 'varchar', 17, many(() => many(() => pick('ABCDEFGHJKLMNPRSTUVWXYZ0123456789'), 17).join('')), 'JM_L1_VIN'),
  col('TITLE_VOLUME_FOLIO', 'varchar', 40, many(title), 'JM_L1_LAND_TITLE'),
  col('VALUATION_NO', 'varchar', 20, many(() => `${int(10, 14)}${pick(['A', 'B', 'C'])}${int(10, 99)}-${int(100, 999)}-${int(100, 999)}`), 'JM_L1_LAND_TITLE'),
  col('POLICY_NO', 'varchar', 12, many(() => `POL-${int(100000, 999999)}`), 'JM_L1_CONTRACT_NUMBER'),
  col('NHT_NUMBER', 'varchar', 12, many(() => String(int(10000000, 99999999))), 'JM_L1_CONTRACT_NUMBER'),
  col('USERNAME', 'varchar', 30, many(() => `${fold(pick(GIVEN)).toLowerCase()}${int(1, 99)}`), 'JM_L1_USERNAME'),
  col('PASSWORD_HASH', 'varchar', 60, many(() => `$2a$10$${many(() => pick('abcdefghijklmnopqrstuvwxyz0123456789'), 53).join('')}`), 'JM_L1_CREDENTIAL'),
  col('LATITUDE', 'varchar', 12, many(() => `18.${int(100000, 999999)}`), 'JM_L1_GEOLOCATION'),
  col('COORDINATES', 'varchar', 30, many(() => `18.${int(1000, 9999)},-77.${int(1000, 9999)}`), 'JM_L1_GEOLOCATION'),
  col('REMARKS', 'clob', 4000, many(() => `Customer asked to update details. TRN ${trnDashed()}, email ${fold(pick(GIVEN)).toLowerCase()}@gmail.com.`), 'JM_L1_FREE_TEXT'),

  // L1 — badly named: only the values can tell
  col('FIELD1', 'varchar', 11, many(trnDashed), 'JM_L1_TRN'),
  col('FIELD2', 'varchar', 30, many(() => pick(GIVEN)), 'JM_L1_GIVEN_NAME'),
  col('FIELD3', 'varchar', 30, many(() => pick(SURNAMES)), 'JM_L1_SURNAME'),
  col('FIELD4', 'varchar', 120, many(fullName), 'JM_L1_FULL_NAME'),
  col('FIELD5', 'varchar', 100, many(() => `${fold(pick(GIVEN)).toLowerCase()}@yahoo.com`), 'JM_L1_EMAIL'),
  col('FIELD6', 'varchar', 16, many(() => `876-${int(200, 999)}-${int(1000, 9999)}`), 'JM_L1_PHONE'),
  col('FIELD7', 'varchar', 120, many(() => `${int(1, 200)} ${pick(STREETS)}`), 'JM_L1_ADDRESS'),
  col('FIELD8', 'varchar', 19, many(() => luhn('5', 16)), 'JM_L1_PAYMENT_CARD'),
  col('FIELD9', 'varchar', 15, many(() => `192.168.${int(0, 255)}.${int(1, 254)}`), 'JM_L1_IP_ADDRESS'),
  col('FIELD10', 'varchar', 10, many(() => `${int(1000, 9999)} ${pick(['AB', 'GH', 'FK', 'HW'])}`), 'JM_L1_LICENCE_PLATE'),
  col('FIELD11', 'varchar', 40, many(title), 'JM_L1_LAND_TITLE'),
  col('FIELD14', 'varchar', 120, many(() => `${pick(['Content', 'Mocho', 'Nain', 'Bamboo', 'Islington'])} District, ${pick(['Linstead', 'May Pen', 'Santa Cruz', 'Port Maria'])} P.O.`), 'JM_L1_ADDRESS'),
  col('TXT', 'clob', 4000, many(() => `Patient ${pick(GIVEN)} ${pick(SURNAMES)}, TRN ${trnDashed()}, tel 876-${int(200, 999)}-${int(1000, 9999)}.`), 'JM_L1_FREE_TEXT'),

  // L2
  col('DOB', 'date', 0, many(() => iso(1940, 2010)), 'JM_L2_BIRTH_DATE'),
  col('DATE_OF_BIRTH', 'varchar', 10, many(() => iso(1940, 2010)), 'JM_L2_BIRTH_DATE'),
  col('birthDate', 'timestamp', 0, many(() => iso(1940, 2010)), 'JM_L2_BIRTH_DATE'),
  col('YEAR_OF_BIRTH', 'number', 4, many(() => String(int(1940, 2010))), 'JM_L2_BIRTH_YEAR'),
  col('AGE', 'number', 3, many(() => String(int(0, 99))), 'JM_L2_AGE'),
  col('DATE_OF_DEATH', 'date', 0, many(() => iso(2000, 2025)), 'JM_L2_EVENT_DATE'),
  col('HIRE_DATE', 'date', 0, many(() => iso(2000, 2025)), 'JM_L2_EVENT_DATE'),
  col('SEX', 'char', 1, many(() => pick(['F', 'M'])), 'JM_L2_SEX'),
  col('GENDER', 'varchar', 10, many(() => pick(['Female', 'Male'])), 'JM_L2_SEX'),
  col('TOWN', 'varchar', 60, many(() => pick(PLACE_NAMES)), 'JM_L2_TOWN'),
  col('PLACE_OF_BIRTH', 'varchar', 60, many(() => pick(PLACE_NAMES)), 'JM_L2_TOWN'),
  col('FIELD12', 'varchar', 60, many(() => pick(PLACE_NAMES)), 'JM_L2_TOWN'),
  col('NEIGHBOURHOOD', 'varchar', 40, many(() => pick(NEIGHBOURHOODS)), 'JM_L2_NEIGHBOURHOOD'),
  col('NATIONALITY', 'varchar', 20, many(() => pick(['Jamaican', 'American', 'British', 'Haitian'])), 'JM_L2_NATIONALITY'),
  col('MARITAL_STATUS', 'varchar', 30, many(() => pick(['Single', 'Married', 'Common-law', 'Visiting'])), 'JM_L2_MARITAL_STATUS'),
  col('OCCUPATION', 'varchar', 60, many(() => pick(['Teacher', 'Farmer', 'Higgler'])), 'JM_L2_OCCUPATION'),
  col('JOB_TITLE', 'varchar', 60, many(() => pick(['Analyst', 'Head of department', 'Sales clerk'])), 'JM_L2_OCCUPATION'),
  col('EMPLOYER_NAME', 'varchar', 80, many(() => `Trading ${int(1, 99)} Ltd.`), 'JM_L2_EMPLOYER'),
  col('EDUCATION_LEVEL', 'varchar', 40, many(() => pick(['Primary', 'Secondary', 'Tertiary', 'CSEC'])), 'JM_L2_EDUCATION'),
  col('SCHOOL_NAME', 'varchar', 80, many(() => pick(['Jamaica College', 'Campion College', 'St. Jago High School'])), 'JM_L2_SCHOOL'),
  col('NO_OF_CHILDREN', 'number', 2, many(() => String(int(0, 8))), 'JM_L2_DEPENDANTS'),

  // L3
  col('DNA_PROFILE', 'varchar', 200, many(() => 'AGTC'.repeat(10)), 'JM_L3_GENETIC'),
  col('FINGERPRINT_TEMPLATE', 'varchar', 200, many(() => many(() => pick('ABCDEF0123456789'), 64).join('')), 'JM_L3_BIOMETRIC'),
  col('PHOTO_PATH', 'varchar', 200, many(() => `/photos/${int(10000, 99999)}.jpg`), 'JM_L3_BIOMETRIC'),
  col('SIGNATURE_IMAGE', 'varchar', 200, many(() => many(() => pick('ABCDEF0123456789'), 64).join('')), 'JM_L3_BIOMETRIC'),
  col('HEIGHT_CM', 'number', 3, many(() => String(int(140, 200))), 'JM_L3_HEIGHT'),
  col('EYE_COLOUR', 'varchar', 12, many(() => pick(['Brown', 'Dark brown', 'Hazel', 'Black'])), 'JM_L3_EYE_COLOUR'),
  col('LEGITIMACY', 'varchar', 30, many(() => pick(['Born in wedlock', 'Born out of wedlock'])), 'JM_L3_FILIATION'),
  col('FATHER_NAMED', 'char', 1, many(() => pick(['Y', 'N'])), 'JM_L3_FILIATION'),
  col('ETHNICITY', 'varchar', 30, many(() => pick(['Black', 'Mixed', 'East Indian', 'Chinese'])), 'JM_L3_ETHNICITY'),
  col('FIELD13', 'varchar', 30, many(() => pick(['Black', 'Mixed', 'East Indian', 'Chinese', 'White', 'Maroon'])), 'JM_L3_ETHNICITY'),
  col('RELIGION', 'varchar', 40, many(() => pick(['Church of God', 'Seventh-day Adventist', 'Pentecostal', 'None'])), 'JM_L3_RELIGION'),
  col('CONSCIENTIOUS_OBJECTION', 'varchar', 60, many(() => pick(['Blood transfusions', 'None'])), 'JM_L3_BELIEF'),
  col('VOTING_INTENTION', 'varchar', 40, many(() => pick(['Left', 'Right', 'Undecided'])), 'JM_L3_POLITICAL_OPINION'),
  col('PARTY_AFFILIATION', 'varchar', 60, many(() => pick(['Jamaica Labour Party', "People's National Party", 'JLP', 'PNP'])), 'JM_L3_POLITICAL_AFFILIATION'),
  col('UNION_MEMBER', 'char', 1, many(() => pick(['Y', 'N'])), 'JM_L3_TRADE_UNION'),
  col('SEXUAL_ORIENTATION', 'varchar', 30, many(() => pick(['Heterosexual', 'Gay', 'Bisexual'])), 'JM_L3_SEXUAL_ORIENTATION'),
  col('SEXUAL_ACTIVITY', 'varchar', 30, many(() => 'Active'), 'JM_L3_SEXUAL_LIFE'),
  col('GENDER_IDENTITY', 'varchar', 30, many(() => pick(['Woman', 'Trans man', 'Non-binary'])), 'JM_L3_GENDER_IDENTITY'),

  // HEALTH
  col('NHF_CARD_NO', 'varchar', 12, many(() => String(int(100000, 9999999))), 'JM_HEALTH_ID'),
  col('DIAGNOSIS', 'varchar', 10, many(() => pick(['E11.9', 'I10', 'J45.9', 'D57.1'])), 'JM_HEALTH_DIAGNOSIS'),
  col('ICD10_CODE', 'varchar', 6, many(() => pick(['E11', 'I10', 'F20', 'B20'])), 'JM_HEALTH_DIAGNOSIS'),
  col('MEDICATION', 'varchar', 40, many(() => pick(['Hydroxyurea', 'Paracetamol', 'Metformin'])), 'JM_HEALTH_MEDICATION'),
  col('CLINICAL_NOTES', 'clob', 4000, many(() => `Patient reports abdominal pain for ${int(1, 9)} days.`), 'JM_HEALTH_CLINICAL_TEXT'),
  col('HIV_STATUS', 'varchar', 12, many(() => pick(['Reactive', 'Non-reactive'])), 'JM_HEALTH_TEST_RESULT'),
  col('BLOOD_TYPE', 'varchar', 4, many(() => pick(['A+', 'O-', 'AB+'])), 'JM_HEALTH_BLOOD_GROUP'),
  col('DISABILITY_TYPE', 'varchar', 40, many(() => pick(['Seeing', 'Hearing', 'None'])), 'JM_HEALTH_DISABILITY'),
  col('PREGNANT', 'char', 1, many(() => pick(['Y', 'N'])), 'JM_HEALTH_REPRODUCTIVE'),
  col('MENTAL_HEALTH_CONDITION', 'varchar', 60, many(() => pick(['Depression', 'Anxiety'])), 'JM_HEALTH_MENTAL'),

  // FIN
  col('CREDIT_SCORE', 'number', 3, many(() => String(int(300, 850))), 'JM_FIN_CREDIT_REFERENCE'),
  col('ARREARS_STATUS', 'varchar', 30, many(() => pick(['Current', '90 days past due'])), 'JM_FIN_CREDIT_REFERENCE'),
  col('LOAN_BALANCE', 'number', 12, many(() => String(int(10000, 9000000))), 'JM_FIN_DEBT'),
  col('MONTHLY_SALARY', 'number', 10, many(() => String(int(40000, 900000))), 'JM_FIN_INCOME'),
  col('PROPERTY_VALUE', 'number', 12, many(() => String(int(3000000, 90000000))), 'JM_FIN_ASSETS'),
  col('PENSION_AMOUNT', 'number', 8, many(() => String(int(3500, 60000))), 'JM_FIN_PENSION'),
  col('BENEFIT_TYPE', 'varchar', 40, many(() => pick(['Old age pension', 'Invalidity benefit', 'Funeral grant'])), 'JM_FIN_NIS_BENEFIT'),
  col('PATH_BENEFICIARY', 'char', 1, many(() => pick(['Y', 'N'])), 'JM_FIN_SOCIAL_PROGRAMME'),
  col('POVERTY_STATUS', 'varchar', 20, many(() => pick(['Food poor', 'Poor', 'Not poor'])), 'JM_FIN_POVERTY'),
  col('HOUSING_TENURE', 'varchar', 30, many(() => pick(['Owned', 'Rented', 'Family land'])), 'JM_FIN_HOUSING'),

  // PENAL
  col('CRIMINAL_RECORD', 'varchar', 30, many(() => pick(['No criminal record', 'Has criminal record'])), 'JM_PENAL_CRIMINAL_RECORD'),
  col('COURT_CASE_NO', 'varchar', 15, many(() => `HCC ${int(1, 999)}/${int(2015, 2025)}`), 'JM_PENAL_CASE_NUMBER'),

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
  col('PAGE_URL', 'varchar', 200, many(() => `https://www.example.com.jm/p/${int(1, 999)}`), ''),
  col('DOCUMENT_TYPE', 'varchar', 20, many(() => pick(['Invoice', 'Credit note'])), ''),
  col('CURRENCY', 'varchar', 3, many(() => pick(['JMD', 'USD'])), ''),
  col('CATEGORY', 'varchar', 30, many(() => pick(['Dairy', 'Bakery'])), ''),
  col('PARISH', 'varchar', 30, many(() => pick(['Saint Andrew', 'Saint Catherine', 'Clarendon', 'Manchester', 'Kingston'])), ''),
  col('PARTY_ID', 'varchar', 10, many(() => `PTY-${int(1000, 9999)}`), ''),
  col('THIRD_PARTY', 'varchar', 60, many(() => `Vendor ${int(1, 99)} Ltd.`), ''),
  col('LANGUAGE_CODE', 'varchar', 5, many(() => pick(['en', 'es', 'en-US'])), ''),
  col('DEFAULT_VALUE', 'varchar', 20, many(() => pick(['0', 'N/A', 'true'])), ''),
  col('SORT_POSITION', 'number', 4, many(() => String(int(1, 99))), ''),
  col('CONDITION', 'varchar', 10, many(() => pick(['New', 'Used'])), ''),
  col('CASE_STATUS', 'varchar', 10, many(() => pick(['Open', 'Closed', 'Pending'])), ''),
  col('MESSAGE_ID', 'varchar', 36, many(() => `MSG${int(100000, 999999)}`), ''),
  col('IMAGE_WIDTH', 'number', 5, many(() => String(int(100, 4000))), ''),
  // Short names of packaged systems (a core banking table, say): nothing but the values to go by.
  col('PFNOM', 'char', 60, many(fullName), 'JM_L1_FULL_NAME'),
  col('PFMAIL', 'char', 80, many(() => `${pick(SURNAMES).toLowerCase().replace(/'/g, '')}.${int(1, 99)}@mail.com`), 'JM_L1_EMAIL'),
  col('PFSX', 'char', 1, many(() => pick(['F', 'M'])), 'JM_L2_SEX'),
  col('PFTRN', 'char', 11, many(trnDashed), 'JM_L1_TRN'),
  col('PFTEL', 'char', 16, many(() => `(876) ${int(200, 999)}-${int(1000, 9999)}`), 'JM_L1_PHONE'),
  col('DSPIMEI', 'char', 15, many(() => luhn('35', 15)), 'JM_L1_DEVICE_ID'),
  col('USPWD', 'char', 60, many(() => `$2b$12$${many(() => pick('./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'), 53).join('')}`), 'JM_L1_CREDENTIAL'),
  col('LBSEQ', 'clob', 4000, many(() => many(() => pick('ACGT'), 60).join('')), 'JM_L3_GENETIC'),
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

  // The same columns as a database may hand them over: CHAR values padded with spaces, and codes of
  // digits kept as text with zeros on the left. Each must still land where its bare twin does.
  const TEXT_TYPES = new Set([SQL.char, SQL.varchar, SQL.clob])
  const paddedColumns = COLUMNS.flatMap((column) => [
    ...(TEXT_TYPES.has(column.sqlType) ? [{ ...column, how: 'spaces', values: column.values.map((v) => v.padEnd(Math.max(column.length, v.length + 3))) }] : []),
    ...(TEXT_TYPES.has(column.sqlType) && column.values.every((v) => /^\d+$/.test(v)) ? [{ ...column, how: 'zeros', values: column.values.map((v) => v.padStart(Math.max(column.length, v.length + 2), '0')) }] : []),
  ])
  let paddedPassed = 0
  for (const column of paddedColumns) {
    const field = { name: column.name, parent: null, sqlType: column.sqlType, length: column.length || null, autoIncrement: false, values: column.values }
    const result = kit.evaluateField({ classifiers: resolved, field, threshold: preset.profileSet.threshold, readFile })
    if (result.assigned === column.expect) { paddedPassed++; continue }
    failures++
    const ranking = result.ranking.slice(0, 3).map((r) => `${r.domain} ${r.percent}%`).join(', ')
    console.log(`  ✗ ${column.name} padded with ${column.how}: expected ${column.expect || '(none)'}, got ${result.assigned || '(none)'} — ${ranking}`)
  }
  console.log(`profiled ${paddedColumns.length} padded columns: ${paddedPassed} as expected`)

  // The essential pack runs only the classifiers of its domains. Its columns must still land where
  // they did, and no other column may be taken for one of its domains now that the domains that
  // used to win those columns are not there.
  const essential = new Set(preset.packs.essential.domains)
  const pack = resolved.filter((c) => essential.has(c.domain))
  // Brown, Black, Green and Hazel are Jamaican surnames — Brown the most common of all — and a
  // column of eye colours reads as names once the eye-colour domain is not there to claim it.
  const ALSO = { EYE_COLOUR: 'JM_L1_FULL_NAME' }
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


// ── Towns, offline ──────────────────────────────────────────────────────────
//
// Every town of under 10,000 inhabitants that is not a parish capital must become the capital of
// its parish — unless its name is shared with a town of another parish that keeps it.

function verifyGeneralization() {
  const table = new Map(fs.readFileSync(nodePath.join(HERE, 'files', 'jm-town-generalized.txt'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('|')))
  const capitals = new Set(Object.values(CAPITALS))
  const keeps = (p) => p.population >= 10000 || capitals.has(p.name)
  const byName = new Map()
  for (const p of PLACES) byName.set(p.name, [...(byName.get(p.name) ?? []), p])
  let ok = 0
  let shared = 0
  for (const p of PLACES) {
    const to = table.get(p.name)
    const homonyms = byName.get(p.name)
    const problem = !to ? 'not in the table'
      : keeps(p) ? (to === p.name ? null : 'a large town or a capital was generalized')
        : homonyms.some(keeps) ? (to === p.name ? null : 'kept name expected')
          : homonyms.length === 1 && to !== CAPITALS[p.parish] ? `became ${to}, not the capital of ${p.parish}` : null
    if (homonyms.length > 1 && !keeps(p)) shared++
    if (problem) { failures++; console.log(`  ✗ ${p.name} (${p.parish}, ${p.population}): ${problem}`) }
    else ok++
  }
  for (const [from, to] of table) if (table.get(from.toUpperCase()) !== to.toUpperCase()) { failures++; console.log(`  ✗ ${from}: no upper-case line`) }
  const generalized = PLACES.filter((p) => !keeps(p)).length
  console.log(`towns: ${ok} of ${PLACES.length} as expected, ${generalized} become their parish capital (${shared} small towns share a name)`)
}

// ── Algorithms ──────────────────────────────────────────────────────────────

const words = (s) => s.trim().split(/\s+/).length
const sameShape = (i, o) => i.length === o.length && i.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9') === o.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9')
const digitShape = (i, o) => i.length === o.length && i.replace(/\d/g, '9') === o.replace(/\d/g, '9')
const MASKING = {
  JM_L1_TRN: { inputs: ['000123456', '123-456-789', '987 654 321', ...many(trn, 10)], check: digitShape },
  JM_L1_NIS_NUMBER: { inputs: ['A123456', '1234567'], check: sameShape },
  JM_L1_PASSPORT: { inputs: ['A0123456'], check: sameShape },
  JM_L1_VOTER_ID: { inputs: ['123456'] },
  JM_L1_DRIVERS_LICENCE: { inputs: ['123456789', '123-456-789'], check: digitShape },
  JM_L1_IMMIGRATION_DOCUMENT: { inputs: ['WP 12345'] },
  JM_L1_VITAL_RECORD: { inputs: ['1234/1985'] },
  // Four words fall through to the Character Mapping: it must mask them, not act as a name lookup.
  JM_L1_GIVEN_NAME: { inputs: ['Delroy', 'SHELLY-ANN', 'Novelette Marcia', 'Ann Marie Joy Grace'], check: (i, o) => words(i) === words(o) },
  JM_L1_SURNAME: { inputs: ['Beckford', 'CAMPBELL', 'Clarke-Bennett'], check: (i, o) => words(i) === words(o) && i.includes('-') === o.includes('-') },
  JM_L1_FULL_NAME: {
    inputs: ['Delroy Beckford', 'MARCIA ANN CAMPBELL', 'Delroy A. Beckford', 'Shelly-Ann Fraser-Pryce', 'Beckford, Delroy'],
    check: (i, o) => words(i) === words(o) && (!/ [A-Z]\. /.test(i) || / [A-Z]\. /.test(o)),
  },
  JM_L1_EMAIL: { inputs: ['delroy.beckford@gmail.com', 'info@company.com.jm'], check: (i, o) => /@[^@]+\.test$/.test(o) },
  JM_L1_PHONE: {
    inputs: ['+1 876-555-0123', '876-555-0123', '(876) 555-0123', '18765550123', '658-321-4567', '555-0123', '5550123'],
    // +1, the area code and the separators stay; the length does too.
    check: (i, o) => o.length === i.length && digitShape(i, o) && o.startsWith(i.match(/^(\+?1[\s.-]?)?(\(?(876|658)\)?)?/)[0]),
  },
  JM_L1_ADDRESS: { inputs: ['12 Hope Road, Kingston 6', 'Content District, Linstead P.O., St. Catherine'] },
  JM_L1_ADDRESS_DETAIL: { inputs: ['Apt. 4B', '12'] },
  JM_L1_BANK_ACCOUNT: { inputs: ['0123456789', '351-001-234'], check: digitShape },
  JM_L1_PAYMENT_CARD: { inputs: ['4916 3131 2345 6780'] },
  JM_L1_IP_ADDRESS: {
    inputs: ['72.27.211.10', '2001:db8::1'],
    check: (i, o) => (i.includes('.') ? o.split('.').every((p) => Number(p) >= 1 && Number(p) <= 254) : /^[0-9a-f:]+$/i.test(o)),
  },
  JM_L1_DEVICE_ID: { inputs: ['3c:22:fb:9a:10:e4', '356938035643809'], check: (i, o) => (i.includes(':') ? /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(o) : /^\d{15}$/.test(o)) },
  JM_L1_LICENCE_PLATE: {
    inputs: ['1234 AB', '5678GH', 'PP 1234', 'CA-5678', '12 3456'],
    check: (i, o) => digitShape(i, o) && i.replace(/\d/g, '') === o.replace(/\d/g, ''),
  },
  JM_L1_VIN: { inputs: ['1HGCM82633A004352'], check: sameShape },
  JM_L1_LAND_TITLE: {
    inputs: ['Volume 1234 Folio 567', 'Vol. 1234 Fol. 567', '1234/567'],
    check: (i, o) => digitShape(i, o) && o.replace(/\d/g, '') === i.replace(/\d/g, ''),
  },
  JM_L1_CONTRACT_NUMBER: { inputs: ['POL-123456'] },
  JM_L1_USERNAME: { inputs: ['@delroy_b'] },
  JM_L1_CREDENTIAL: { inputs: ['Secret#2024'], check: (i, o) => /^X+$/.test(o) },
  JM_L1_GEOLOCATION: { inputs: ['18.012345', '18.012345,-76.798765'], check: (i, o) => o.slice(0, 4) === i.slice(0, 4) },
  JM_L1_FREE_TEXT: {
    inputs: ['Customer Beckford, TRN 123-456-789, email d.beckford@gmail.com, tel 876-555-0123.'],
    check: (i, o) => !/123-456-789|d\.beckford@gmail\.com|876-555-0123|Beckford/.test(o),
  },
  JM_L2_BIRTH_DATE: { inputs: ['1985-07-20', '2008-01-15'], check: (i, o) => Math.abs(new Date(o.slice(0, 10)) - new Date(i)) <= 60 * 864e5 },
  JM_L2_BIRTH_YEAR: { inputs: ['1985'], check: (i, o) => o.startsWith('198'), same: true },
  JM_L2_AGE: { inputs: ['37', '7', '104'], check: (i, o) => (i === '104' ? o === '90' : i.length === 1 || o[0] === i[0]), same: true },
  JM_L2_EVENT_DATE: { inputs: ['2021-03-15'] },
  JM_L2_SEX: { inputs: ['F', 'M', 'Female', 'male', 'Woman'], same: true },
  JM_L2_TOWN: { inputs: ['Port Royal', 'Montego Bay', 'Ocho Rios', 'MAGGOTTY', 'St. Ann\'s Bay', 'Morant Bay'], same: true },
  JM_L2_NEIGHBOURHOOD: { inputs: ['Barbican'], same: true },
  JM_L2_NATIONALITY: { inputs: ['Guyanese'], same: true },
  JM_L2_MARITAL_STATUS: { inputs: ['Visiting'], same: true },
  JM_L2_OCCUPATION: { inputs: ['Regional Operations Manager, Western Division'] },
  JM_L2_EMPLOYER: { inputs: ['Jamaica Public Service Company Limited'] },
  JM_L2_EDUCATION: { inputs: ['CSEC'], same: true },
  JM_L2_SCHOOL: { inputs: ['Jamaica College'] },
  JM_L2_DEPENDANTS: { inputs: ['9', '2'], check: (i, o) => Number(o) <= 5, same: true },
  JM_L3_GENETIC: { inputs: ['HbSS sickle cell'] },
  JM_L3_BIOMETRIC: { inputs: ['A1B2C3D4E5F6'] },
  JM_L3_HEIGHT: {
    inputs: ['172', '165 cm', '1.72', `5'8"`, '6 ft 2 in'],
    // The unit and the first figure stay: 172 stays 1xx, 5'8" stays 5 feet.
    check: (i, o) => o[0] === i[0] && o.replace(/\d/g, '') === i.replace(/\d/g, ''),
  },
  JM_L3_EYE_COLOUR: { inputs: ['Amber', 'Brown'], same: true },
  JM_L3_FILIATION: { inputs: ['Father unknown', 'Y'], same: true },
  JM_L3_ETHNICITY: { inputs: ['Syrian/Lebanese', 'Y'], same: true },
  JM_L3_RELIGION: { inputs: ['Salvation Army', 'Y'], same: true },
  JM_L3_BELIEF: { inputs: ['Refuses blood transfusions'] },
  JM_L3_POLITICAL_OPINION: { inputs: ['Centre-right'], same: true },
  JM_L3_POLITICAL_AFFILIATION: { inputs: ["People's National Party", 'Y'], same: true },
  JM_L3_TRADE_UNION: { inputs: ['BITU', 'Y'], same: true },
  JM_L3_SEXUAL_ORIENTATION: { inputs: ['Bisexual'], same: true },
  JM_L3_SEXUAL_LIFE: { inputs: ['Active'] },
  JM_L3_GENDER_IDENTITY: { inputs: ['Trans man'], same: true },
  JM_HEALTH_ID: { inputs: ['NHF-2024-00123'] },
  JM_HEALTH_DIAGNOSIS: { inputs: ['D57.1', 'B20', 'Sickle cell anaemia'], same: true },
  JM_HEALTH_MEDICATION: { inputs: ['Hydroxyurea 500 mg'] },
  JM_HEALTH_CLINICAL_TEXT: { inputs: ['Patient Beckford, TRN 123-456-789, seen for headache.'], check: (i, o) => !o.includes('123-456-789') },
  JM_HEALTH_TEST_RESULT: { inputs: ['Reactive'] },
  JM_HEALTH_BLOOD_GROUP: { inputs: ['O+'], same: true },
  JM_HEALTH_DISABILITY: { inputs: ['Severe psychosocial disability', 'N'], same: true },
  JM_HEALTH_REPRODUCTIVE: { inputs: ['12 weeks pregnant', 'Y'], same: true },
  JM_HEALTH_MENTAL: { inputs: ['Bipolar disorder'] },
  JM_FIN_CREDIT_REFERENCE: { inputs: ['90 days past due', '745', 'N'], same: true },
  JM_FIN_DEBT: { inputs: ['850000'] },
  JM_FIN_INCOME: { inputs: ['240000', '240000.50'] },
  JM_FIN_ASSETS: { inputs: ['18500000'] },
  JM_FIN_PENSION: { inputs: ['6800'] },
  JM_FIN_NIS_BENEFIT: { inputs: ['Special child benefit', 'Y'], same: true },
  JM_FIN_SOCIAL_PROGRAMME: { inputs: ['School feeding programme', 'N'], same: true },
  JM_FIN_POVERTY: { inputs: ['Food poor', '3', 'Decile 8', 'Quintile 2'], same: true },
  JM_FIN_HOUSING: { inputs: ['Captured land'], same: true },
  JM_PENAL_CRIMINAL_RECORD: { inputs: ['Convicted of larceny, 2019', 'Y'], same: true },
  JM_PENAL_CASE_NUMBER: { inputs: ['HCC 123/2023', '456 of 2022'] },
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
const KEPT = new Set(PLACES.filter((p) => p.population >= 10000 || Object.values(CAPITALS).includes(p.name)).map((p) => p.name.toLowerCase()))
const EXPECT = {
  JM_L1_GIVEN_NAME: (i, o) => words(i) > 3 || o.split(/[\s-]+/).every((w) => has('jm-given-names.txt', w) || has('jm-given-names.txt', o)),
  JM_L1_SURNAME: (i, o) => o.split(/[\s\-]+/).every((w) => has('jm-surnames.txt', w)),
  JM_L1_FULL_NAME: (i, o) => i.includes(',') || (has('jm-given-names.txt', o.split(/\s+/)[0]) && o.split(/\s+/).at(-1).split('-').every((w) => has('jm-surnames.txt', w))),
  JM_L1_ADDRESS: (i, o) => has('jm-addresses.txt', o),
  JM_L2_SEX: (i, o) => ({ f: ['f', 'm'], m: ['f', 'm'], female: ['female', 'male'], male: ['female', 'male'], woman: ['woman', 'man'] })[i.toLowerCase()].includes(o.toLowerCase()),
  // Port Royal (Kingston) and Maggotty (St. Elizabeth) become their parish capital; Montego
  // Bay is large and stays; Ocho Rios is small and becomes St. Ann's Bay; Morant Bay and St. Ann's
  // Bay are capitals and stay.
  JM_L2_TOWN: (i, o) => ({ 'Port Royal': o === 'Kingston', 'Montego Bay': o === 'Montego Bay', 'Ocho Rios': o === "Saint Ann's Bay", MAGGOTTY: o === 'BLACK RIVER', "St. Ann's Bay": o === "St. Ann's Bay", 'Morant Bay': o === 'Morant Bay' })[i] ?? KEPT.has(o.toLowerCase()),
  JM_L2_NEIGHBOURHOOD: (i, o) => has('jm-neighbourhoods.txt', o),
  JM_L2_NATIONALITY: (i, o) => has('jm-nationalities.txt', o),
  JM_L2_MARITAL_STATUS: (i, o) => has('jm-marital-status.txt', o),
  JM_L2_OCCUPATION: (i, o) => has('jm-occupations.txt', o),
  JM_L2_EMPLOYER: (i, o) => has('jm-employers.txt', o),
  JM_L2_EDUCATION: (i, o) => has('jm-education.txt', o),
  JM_L2_SCHOOL: (i, o) => has('jm-schools.txt', o),
  JM_L3_EYE_COLOUR: (i, o) => has('jm-eye-colours.txt', o),
  JM_L3_FILIATION: (i, o) => flag(i, o) ?? has('jm-filiation.txt', o),
  JM_L3_ETHNICITY: (i, o) => flag(i, o) ?? has('jm-ethnic-groups.txt', o),
  JM_L3_RELIGION: (i, o) => flag(i, o) ?? has('jm-religions.txt', o),
  JM_L3_BELIEF: (i, o) => o === SUPPRESSED,
  JM_L3_POLITICAL_OPINION: (i, o) => has('jm-political-opinions.txt', o),
  JM_L3_POLITICAL_AFFILIATION: (i, o) => flag(i, o) ?? has('jm-political-parties.txt', o),
  JM_L3_TRADE_UNION: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  JM_L3_SEXUAL_ORIENTATION: (i, o) => has('jm-sexual-orientations.txt', o),
  JM_L3_SEXUAL_LIFE: (i, o) => o === SUPPRESSED,
  JM_L3_GENDER_IDENTITY: (i, o) => has('jm-gender-identities.txt', o),
  JM_HEALTH_DIAGNOSIS: (i, o) => (/\.\d/.test(i) ? has('jm-icd10-decimal.txt', o) : /^[A-Z]\d{2}$/i.test(i) ? has('jm-icd10.txt', o) : has('jm-diagnoses.txt', o)),
  JM_HEALTH_MEDICATION: (i, o) => has('jm-medications.txt', o),
  JM_HEALTH_BLOOD_GROUP: (i, o) => BLOOD_GROUPS.has(o),
  JM_HEALTH_DISABILITY: (i, o) => flag(i, o) ?? has('jm-disabilities.txt', o),
  JM_HEALTH_REPRODUCTIVE: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  JM_HEALTH_MENTAL: (i, o) => o === SUPPRESSED,
  JM_FIN_CREDIT_REFERENCE: (i, o) => flag(i, o) ?? (/^\d{3}$/.test(i) ? /^\d{3}$/.test(o) : has('jm-credit-statuses.txt', o)),
  JM_FIN_NIS_BENEFIT: (i, o) => flag(i, o) ?? has('jm-nis-benefits.txt', o),
  JM_FIN_SOCIAL_PROGRAMME: (i, o) => flag(i, o) ?? has('jm-social-programmes.txt', o),
  JM_FIN_POVERTY: (i, o) => (/^\d$/.test(i) ? /^[1-5]$/.test(o) : /^decile/i.test(i) ? /^Decile ([1-9]|10)$/.test(o) : /^quintile/i.test(i) ? /^Quintile [1-5]$/.test(o) : has('jm-poverty-statuses.txt', o)),
  JM_FIN_HOUSING: (i, o) => has('jm-housing-tenure.txt', o),
  JM_PENAL_CRIMINAL_RECORD: (i, o) => flag(i, o) ?? has('jm-criminal-record.txt', o),
}

async function mask(framework, config, input, additionalAlgorithms) {
  const res = await fetch(`${API}/api/mask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ framework, config, input, additionalAlgorithms }),
  })
  return res.json()
}

// Algorithms that come with the engine (presets/_lib/engine-algorithms.mjs) are not in the set: they
// run through a chain whose first step changes nothing — a chain takes two — and the runner finds
// them in its own catalog.
const ENGINE_IDENTITY = {
  name: 'VERIFY_IDENTITY', className: 'algorithm.plugin.decompose.RegexDecompose',
  config: { maskPatterns: [{ regex: '(.*)', actions: [{ type: 'PRESERVE' }] }], fallbackAction: { type: 'PRESERVE' }, requireMask: false },
}
const engineRun = (name) => ({ framework: 'algorithm.plugin.stringAlgorithmChain.StringAlgorithmChain', config: { algorithmReferences: [{ name: ENGINE_IDENTITY.name }, { name }] } })
const withIdentity = (list) => [...list, ENGINE_IDENTITY]
const BLOOD_GROUPS = new Set(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'])

async function verifyAlgorithms() {
  // An amount masked by the engine's CM Numeric keeps its number of digits: the same order of magnitude.
  const digitCount = (v) => String(v).replace(/\D/g, '').length
  for (const d of preset.domains) {
    if (d.algorithm !== 'dlpx-core:CM Numeric' || !MASKING[d.name]) continue
    const own = MASKING[d.name].check
    MASKING[d.name].check = (i, o) => digitCount(i) === digitCount(o) && (!own || own(i, o))
  }
  const additional = withIdentity(preset.algorithms.map((a) => ({ name: a.name, className: a.framework, config: resolve(a.config) })))
  const byName = new Map(preset.algorithms.map((a) => [a.name, a]))
  const missing = preset.domains.map((d) => d.name).filter((d) => !MASKING[d])
  if (missing.length) { failures++; console.log(`  ✗ domains with no masking test: ${missing.join(', ')}`) }
  const run = (algorithmName, input) => { const algo = byName.get(algorithmName) ?? engineRun(algorithmName); return mask(algo.framework, resolve(algo.config), input, additional).catch((err) => ({ error: err.message })) }

  const jobs = preset.domains.flatMap((d) => (MASKING[d.name]?.inputs ?? []).map((input) => ({ domain: d, input })))
  // Every algorithm masks its own sample input, which is what the tester opens it with.
  for (const a of preset.algorithms) {
    if (a.input === undefined) { failures++; console.log(`  ✗ ${a.name} has no sample input`) }
    else jobs.push({ domain: { name: a.name, algorithm: a.name }, input: a.input, sample: true })
  }
  // Real columns hold placeholders too. Masking them may change them or not, but must not fail —
  // except in typed columns (dates, amounts), where the database would not hold them.
  const TYPED = new Set(['JM_L2_BIRTH_DATE', 'JM_L2_EVENT_DATE', 'JM_FIN_DEBT', 'JM_FIN_INCOME', 'JM_FIN_ASSETS', 'JM_FIN_PENSION'])
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

  // Padding: a CHAR column fills a value with spaces, and a code kept as text may come with zeros
  // on the left. The padded value must mask as the bare one does — around the spaces, after the
  // zeros — so that it still joins its unpadded twin in another table.
  const same = (bare, out) => out.trim() === bare.trim()
  // With zeros: the same number as the bare value masks to, as wide as the padded value. A domain
  // that writes its numbers at full width (a CPF that lost a zero comes back with eleven digits)
  // gives the same number either way.
  const sameNumber = (bare, out) => out.replace(/^0+(?=\d)/, '') === bare.replace(/^0+(?=\d)/, '') && out.length >= bare.length
  const isDomain = new Set(preset.domains.map((d) => d.name))
  const padded = jobs.filter((j) => !j.placeholder && isDomain.has(j.domain.name) && !TYPED.has(j.domain.name)).flatMap(({ domain, input }) => [
    { domain, input, value: `${input}   `, fits: same },
    { domain, input, value: `  ${input}`, fits: same },
    ...(/^\d{2,}$/.test(input) ? [{ domain, input, value: `00${input}`, fits: sameNumber }] : []),
  ])
  let paddedPassed = 0
  const paddedLines = []
  let nextPadded = 0
  async function paddedWorker() {
    while (nextPadded < padded.length) {
      const { domain, input, value, fits } = padded[nextPadded++]
      const algo = byName.get(domain.algorithm) ?? engineRun(domain.algorithm)
      const run = (x) => mask(algo.framework, resolve(algo.config), x, additional).catch((err) => ({ error: err.message }))
      const [bare, out] = await Promise.all([run(input), run(value)])
      if (bare.output != null && out.output != null && fits(bare.output, out.output)) { paddedPassed++; continue }
      failures++
      paddedLines.push(`  ✗ padded ${domain.name} ${JSON.stringify(value)} → ${JSON.stringify(out.output ?? out.error)}, bare ${JSON.stringify(input)} → ${JSON.stringify(bare.output ?? bare.error)}`)
    }
  }
  await Promise.all(Array.from({ length: 6 }, paddedWorker))
  console.log(paddedLines.sort().join('\n'))
  console.log(`masked ${padded.length} padded values: ${paddedPassed} as their bare value`)

  // Different keys must stay different: a TRN used as a key cannot collide.
  const inputs = [...new Set(many(trn, 150))]
  const outputs = new Set()
  for (const input of inputs) outputs.add((await run('JM_CM_ALNUM', input)).output)
  if (outputs.size !== inputs.length) { failures++; console.log(`  ✗ JM_CM_ALNUM: ${inputs.length} TRNs gave ${outputs.size} distinct outputs`) }
  else console.log(`TRNs: ${inputs.length} distinct inputs, ${outputs.size} distinct outputs`)

  // The driver's licence carries the TRN: masked in either column, the same person gets the same number.
  let matching = 0
  for (const input of inputs.slice(0, 20)) {
    const [a, b] = await Promise.all(['JM_L1_TRN', 'JM_L1_DRIVERS_LICENCE'].map((d) => run(preset.domains.find((x) => x.name === d).algorithm, input)))
    if (a.output === b.output) matching++
  }
  if (matching !== 20) { failures++; console.log(`  ✗ TRN × driver's licence: ${matching} of 20 mask to the same number`) }
  else console.log(`TRN × driver's licence: 20 of 20 mask to the same number`)
}

if (only !== 'algorithms') { verifyClassifiers(); verifyGeneralization() }
if (only !== 'classifiers') await verifyAlgorithms()
console.log(failures ? `\n${failures} problem(s)` : '\nall good')
process.exit(failures ? 1 : 0)
