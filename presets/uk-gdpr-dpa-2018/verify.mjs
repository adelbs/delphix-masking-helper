#!/usr/bin/env node
/**
 * Checks the United Kingdom (UK GDPR and Data Protection Act 2018) preset.
 *
 *   node presets/uk-gdpr-dpa-2018/verify.mjs               # classifiers, then algorithms
 *   node presets/uk-gdpr-dpa-2018/verify.mjs classifiers   # only the local profiling check
 *   node presets/uk-gdpr-dpa-2018/verify.mjs algorithms    # only masking, against the app
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

let seed = 44
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
const STREETS = source('streets.txt')
const PLACES = source('places.tsv').map((l) => { const [name, area, nation, population] = l.split('\t'); return { name, area, nation, population: Number(population) } })
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '')
const PERSONAL = new Set([...GIVEN, ...SURNAMES].map((w) => fold(w).toLowerCase()))
const PLACE_NAMES = PLACES.filter((p) => p.population >= 1000).map((p) => p.name).filter((n) => !PERSONAL.has(fold(n).toLowerCase()))

const pad = (n, w) => String(n).padStart(w, '0')
const digits = (n) => many(() => int(0, 9), n).join('')
const NINO_FIRST = 'ABCEGHJKLMNOPRSTWXYZ'
const NINO_SECOND = 'ABCEGHJKLMNPRSTWXYZ'
const nino = () => `${pick([...NINO_FIRST])}${pick([...NINO_SECOND])}${digits(6)}${pick(['A', 'B', 'C', 'D'])}`
const ninoSpaced = () => nino().replace(/^(..)(..)(..)(..)(.)$/, '$1 $2 $3 $4 $5')
const NHS_WEIGHTS = [10, 9, 8, 7, 6, 5, 4, 3, 2]
const nhs = () => {
  for (;;) {
    const body = `${pick(['4', '6', '7'])}${digits(8)}`
    const check = (11 - ([...body].reduce((s, d, i) => s + NHS_WEIGHTS[i] * d, 0) % 11)) % 11
    if (check !== 10) return `${body}${check}`
  }
}
const nhsSpaced = () => nhs().replace(/^(\d{3})(\d{3})(\d{4})$/, '$1 $2 $3')
const isNhs = (v) => {
  const d = v.replace(/\D/g, '')
  const check = (11 - ([...d.slice(0, 9)].reduce((s, x, i) => s + NHS_WEIGHTS[i] * x, 0) % 11)) % 11
  return d.length === 10 && check !== 10 && check === Number(d[9])
}
const UTR_WEIGHTS = [6, 7, 8, 9, 10, 5, 4, 3, 2]
const utrCheck = (body) => { const r = [...body].reduce((s, d, i) => s + UTR_WEIGHTS[i] * d, 0) % 11; return 11 - r > 9 ? 11 - r - 9 : 11 - r }
const utr = () => { const body = digits(9); return `${utrCheck(body)}${body}` }
const isUtr = (v) => { const d = v.replace(/\D/g, ''); return d.length === 10 && utrCheck(d.slice(1)) === Number(d[0]) }
const ibanCheck = (bban) => {
  const rearranged = `${bban}GB00`.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55))
  let r = 0
  for (const ch of rearranged) r = (r * 10 + Number(ch)) % 97
  return pad(98 - r, 2)
}
const iban = () => { const bban = `${pick(['NWBK', 'BARC', 'LOYD', 'HBUK', 'MIDL'])}${digits(14)}`; return `GB${ibanCheck(bban)}${bban}` }
const isIban = (v) => { const c = v.replace(/\s/g, ''); return /^GB\d{2}[A-Z]{4}\d{14}$/.test(c) && ibanCheck(c.slice(4)) === c.slice(2, 4) }
const luhn = (prefix, length) => {
  const ds = [...prefix].map(Number)
  while (ds.length < length - 1) ds.push(int(0, 9))
  const sum = ds.slice().reverse().reduce((s, d, i) => s + (i % 2 === 0 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0)
  return ds.join('') + String((10 - (sum % 10)) % 10)
}
const INWARD = 'ABDEFGHJLNPQRSTUWXYZ'
const OUTWARD = ['SW1A', 'M1', 'B33', 'LS6', 'G2', 'CF10', 'BT9', 'EH1', 'NE1', 'L1', 'CR2', 'DN55', 'W1A', 'EC1A', 'BS8', 'OX1']
const postcode = () => `${pick(OUTWARD)} ${int(0, 9)}${pick([...INWARD])}${pick([...INWARD])}`
const iso = (y0, y1) => `${int(y0, y1)}-${pad(int(1, 12), 2)}-${pad(int(1, 28), 2)}`
const fullName = () => `${pick(GIVEN)}${random() < 0.4 ? ` ${pick(GIVEN)}` : ''} ${pick(SURNAMES)}`
const phone = () => pick([`07${int(100, 999)} ${int(100000, 999999)}`, `+44 7${int(100, 999)} ${int(100000, 999999)}`, `020 ${int(7000, 8999)} ${int(1000, 9999)}`, `0161 ${int(200, 999)} ${int(1000, 9999)}`, `01632 ${int(100000, 999999)}`, `+44 (0)20 ${int(7000, 8999)} ${int(1000, 9999)}`])
const plate = () => `${pick(['AB', 'LD', 'MA', 'YK', 'SN', 'BT', 'WR', 'KX'])}${int(51, 75)} ${many(() => pick([...'ABCDEFGHJKLMNOPRSTUVWXYZ']), 3).join('')}`
const address = () => pick([`${int(1, 200)} ${pick(STREETS)}`, `Flat ${int(1, 40)}, ${int(1, 200)} ${pick(STREETS)}`, `${int(1, 200)} ${pick(STREETS)}, ${pick(['London', 'Leeds', 'Cardiff'])} ${postcode()}`])
const licence = (surname) => `${(fold(surname).toUpperCase().replace(/[^A-Z]/g, '') + '99999').slice(0, 5)}${int(5, 9)}${pick(['0', '1', '5', '6'])}${int(1, 2)}${pad(int(1, 28), 2)}${int(0, 9)}${pick([...'ABCDEFGHJ'])}${pick([...'ABCDEFGHJ9'])}9${pick([...'ABCDEFGHJKLM'])}${pick([...'ABCDEFGHJKLM'])}`

// ── Classifiers ─────────────────────────────────────────────────────────────

const SQL = { varchar: 12, char: 1, number: 2, integer: 4, date: 91, timestamp: 93, clob: 2005 }
const col = (name, type, length, values, expect) => ({ name, sqlType: SQL[type], length, values, expect })

const COLUMNS = [
  // L1 — well named
  col('NI_NUMBER', 'varchar', 13, many(ninoSpaced), 'UK_L1_NINO'),
  col('NINO', 'varchar', 9, many(nino), 'UK_L1_NINO'),
  col('nationalInsuranceNumber', 'varchar', 13, many(nino), 'UK_L1_NINO'),
  col('NHS_NUMBER', 'varchar', 12, many(nhsSpaced), 'UK_L1_NHS_NUMBER'),
  col('NHS_NO', 'varchar', 10, many(nhs), 'UK_L1_NHS_NUMBER'),
  col('CHI_NUMBER', 'varchar', 10, many(() => `${pad(int(1, 28), 2)}${pad(int(1, 12), 2)}${pad(int(40, 99), 2)}${digits(4)}`), 'UK_L1_NHS_NUMBER'),
  col('UTR', 'varchar', 11, many(utr), 'UK_L1_UTR'),
  col('SA_UTR', 'varchar', 11, many(() => utr().replace(/^(\d{5})/, '$1 ')), 'UK_L1_UTR'),
  col('PASSPORT_NO', 'varchar', 9, many(() => digits(9)), 'UK_L1_PASSPORT'),
  col('DRIVING_LICENCE_NO', 'varchar', 16, many(() => licence(pick(SURNAMES))), 'UK_L1_DRIVING_LICENCE'),
  col('BRP_NUMBER', 'varchar', 12, many(() => `${pick(['ZR', 'RE', 'ZU'])}${int(1000000, 9999999)}`), 'UK_L1_IMMIGRATION_DOCUMENT'),
  col('SHARE_CODE', 'varchar', 11, many(() => `W${many(() => pick([...'ABCDEFGHJKLMNPRSTUVWXYZ0123456789']), 8).join('')}`), 'UK_L1_IMMIGRATION_DOCUMENT'),
  col('BIRTH_CERT_NO', 'varchar', 12, many(() => `${pick(['A', 'B', 'C'])}${int(100000, 999999)}`), 'UK_L1_VITAL_RECORD'),
  col('FIRST_NAME', 'varchar', 30, many(() => pick(GIVEN)), 'UK_L1_GIVEN_NAME'),
  col('FORENAME', 'varchar', 30, many(() => pick(GIVEN)), 'UK_L1_GIVEN_NAME'),
  col('LAST_NAME', 'varchar', 30, many(() => pick(SURNAMES)), 'UK_L1_SURNAME'),
  col('MAIDEN_NAME', 'varchar', 30, many(() => pick(SURNAMES)), 'UK_L1_SURNAME'),
  col('FULL_NAME', 'varchar', 120, many(fullName), 'UK_L1_FULL_NAME'),
  col('CUSTOMER_NAME', 'varchar', 120, many(() => `${pick(['Mr', 'Mrs', 'Ms', 'Dr'])} ${fullName()}`), 'UK_L1_FULL_NAME'),
  col('NAME', 'varchar', 120, many(fullName), 'UK_L1_FULL_NAME'),
  col('NEXT_OF_KIN', 'varchar', 120, many(fullName), 'UK_L1_FULL_NAME'),
  col('EMAIL', 'varchar', 100, many(() => `${fold(pick(GIVEN)).toLowerCase()}.${int(1, 999)}@gmail.com`), 'UK_L1_EMAIL'),
  col('EMAIL_ADDRESS', 'varchar', 100, many(() => `contact${int(1, 999)}@company.co.uk`), 'UK_L1_EMAIL'),
  col('MOBILE_NO', 'varchar', 20, many(phone), 'UK_L1_PHONE'),
  col('HOME_PHONE', 'varchar', 16, many(() => `01632 ${int(100000, 999999)}`), 'UK_L1_PHONE'),
  col('ADDRESS', 'varchar', 120, many(address), 'UK_L1_ADDRESS'),
  col('ADDRESS_LINE1', 'varchar', 120, many(() => `${int(1, 200)} ${pick(STREETS)}`), 'UK_L1_ADDRESS'),
  col('HOUSE_NO', 'varchar', 6, many(() => String(int(1, 400))), 'UK_L1_ADDRESS_DETAIL'),
  col('ACCOUNT_NO', 'varchar', 8, many(() => digits(8)), 'UK_L1_BANK_ACCOUNT'),
  col('SORT_CODE', 'varchar', 8, many(() => `${int(10, 99)}-${digits(2)}-${digits(2)}`), 'UK_L1_SORT_CODE'),
  col('IBAN', 'varchar', 34, many(iban), 'UK_L1_IBAN'),
  col('CARD_NUMBER', 'varchar', 19, many(() => luhn('4', 16)), 'UK_L1_PAYMENT_CARD'),
  col('IP_ADDRESS', 'varchar', 15, many(() => `${int(1, 223)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`), 'UK_L1_IP_ADDRESS'),
  col('MAC_ADDRESS', 'varchar', 17, many(() => many(() => int(0, 255).toString(16).padStart(2, '0'), 6).join(':')), 'UK_L1_DEVICE_ID'),
  col('IMEI', 'varchar', 15, many(() => luhn('35', 15)), 'UK_L1_DEVICE_ID'),
  col('VEHICLE_REG', 'varchar', 10, many(plate), 'UK_L1_LICENCE_PLATE'),
  col('VIN', 'varchar', 17, many(() => many(() => pick('ABCDEFGHJKLMNPRSTUVWXYZ0123456789'), 17).join('')), 'UK_L1_VIN'),
  col('UPRN', 'number', 12, many(() => String(int(10000000, 999999999999))), 'UK_L1_PROPERTY'),
  col('TITLE_NUMBER', 'varchar', 10, many(() => `${pick(['NGL', 'AGL', 'K', 'WYK'])}${int(100000, 999999)}`), 'UK_L1_PROPERTY'),
  col('POLICY_NO', 'varchar', 12, many(() => `POL-${int(100000, 999999)}`), 'UK_L1_CONTRACT_NUMBER'),
  col('UPN', 'varchar', 13, many(() => `${pick(['A', 'B', 'H'])}${digits(12)}`), 'UK_L1_CONTRACT_NUMBER'),
  col('USERNAME', 'varchar', 30, many(() => `${fold(pick(GIVEN)).toLowerCase()}${int(1, 99)}`), 'UK_L1_USERNAME'),
  col('PASSWORD_HASH', 'varchar', 60, many(() => `$2a$10$${many(() => pick('abcdefghijklmnopqrstuvwxyz0123456789'), 53).join('')}`), 'UK_L1_CREDENTIAL'),
  col('LATITUDE', 'varchar', 12, many(() => `5${int(0, 8)}.${int(100000, 999999)}`), 'UK_L1_GEOLOCATION'),
  col('COORDINATES', 'varchar', 30, many(() => `5${int(0, 8)}.${int(1000, 9999)},-${int(0, 5)}.${int(1000, 9999)}`), 'UK_L1_GEOLOCATION'),
  col('REMARKS', 'clob', 4000, many(() => `Customer asked to update details. NI number ${ninoSpaced()}, email ${fold(pick(GIVEN)).toLowerCase()}@gmail.com.`), 'UK_L1_FREE_TEXT'),

  // L1 — badly named: only the values can tell
  col('FIELD1', 'varchar', 13, many(ninoSpaced), 'UK_L1_NINO'),
  col('FIELD2', 'varchar', 30, many(() => pick(GIVEN)), 'UK_L1_GIVEN_NAME'),
  col('FIELD3', 'varchar', 30, many(() => pick(SURNAMES)), 'UK_L1_SURNAME'),
  col('FIELD4', 'varchar', 120, many(fullName), 'UK_L1_FULL_NAME'),
  col('FIELD5', 'varchar', 100, many(() => `${fold(pick(GIVEN)).toLowerCase()}@yahoo.co.uk`), 'UK_L1_EMAIL'),
  col('FIELD6', 'varchar', 16, many(() => `07${int(100, 999)} ${int(100000, 999999)}`), 'UK_L1_PHONE'),
  col('FIELD7', 'varchar', 120, many(() => `${int(1, 200)} ${pick(STREETS)}`), 'UK_L1_ADDRESS'),
  col('FIELD8', 'varchar', 19, many(() => luhn('5', 16)), 'UK_L1_PAYMENT_CARD'),
  col('FIELD9', 'varchar', 15, many(() => `192.168.${int(0, 255)}.${int(1, 254)}`), 'UK_L1_IP_ADDRESS'),
  col('FIELD10', 'varchar', 10, many(plate), 'UK_L1_LICENCE_PLATE'),
  col('FIELD11', 'varchar', 12, many(nhsSpaced), 'UK_L1_NHS_NUMBER'),
  col('FIELD14', 'varchar', 34, many(iban), 'UK_L1_IBAN'),
  col('FIELD15', 'varchar', 16, many(() => licence(pick(SURNAMES))), 'UK_L1_DRIVING_LICENCE'),
  col('FIELD16', 'varchar', 8, many(postcode), 'UK_L2_POSTCODE'),
  col('TXT', 'clob', 4000, many(() => `Patient ${pick(GIVEN)} ${pick(SURNAMES)}, NHS ${nhsSpaced()}, tel 07${int(100, 999)} ${int(100000, 999999)}.`), 'UK_L1_FREE_TEXT'),

  // L2
  col('DOB', 'date', 0, many(() => iso(1940, 2010)), 'UK_L2_BIRTH_DATE'),
  col('DATE_OF_BIRTH', 'varchar', 10, many(() => iso(1940, 2010)), 'UK_L2_BIRTH_DATE'),
  col('birthDate', 'timestamp', 0, many(() => iso(1940, 2010)), 'UK_L2_BIRTH_DATE'),
  col('YEAR_OF_BIRTH', 'number', 4, many(() => String(int(1940, 2010))), 'UK_L2_BIRTH_YEAR'),
  col('AGE', 'number', 3, many(() => String(int(0, 99))), 'UK_L2_AGE'),
  col('DATE_OF_DEATH', 'date', 0, many(() => iso(2000, 2025)), 'UK_L2_EVENT_DATE'),
  col('REFERRAL_DATE', 'date', 0, many(() => iso(2000, 2025)), 'UK_L2_EVENT_DATE'),
  col('SEX', 'char', 1, many(() => pick(['F', 'M'])), 'UK_L2_SEX'),
  col('GENDER', 'varchar', 10, many(() => pick(['Female', 'Male'])), 'UK_L2_SEX'),
  col('POSTCODE', 'varchar', 8, many(postcode), 'UK_L2_POSTCODE'),
  col('POST_CODE', 'char', 8, many(() => postcode().replace(' ', '')), 'UK_L2_POSTCODE'),
  col('TOWN', 'varchar', 60, many(() => pick(PLACE_NAMES)), 'UK_L2_TOWN'),
  col('PLACE_OF_BIRTH', 'varchar', 60, many(() => pick(PLACE_NAMES)), 'UK_L2_TOWN'),
  col('FIELD12', 'varchar', 60, many(() => pick(PLACE_NAMES)), 'UK_L2_TOWN'),
  col('NATIONALITY', 'varchar', 20, many(() => pick(['British', 'Irish', 'Polish', 'Indian'])), 'UK_L2_NATIONALITY'),
  col('MARITAL_STATUS', 'varchar', 40, many(() => pick(['Single', 'Married', 'In a civil partnership', 'Divorced'])), 'UK_L2_MARITAL_STATUS'),
  col('OCCUPATION', 'varchar', 60, many(() => pick(['Teacher', 'Nurse', 'Care worker'])), 'UK_L2_OCCUPATION'),
  col('JOB_TITLE', 'varchar', 60, many(() => pick(['Analyst', 'Head of department', 'Sales assistant'])), 'UK_L2_OCCUPATION'),
  col('EMPLOYER_NAME', 'varchar', 80, many(() => `Trading ${int(1, 99)} Ltd`), 'UK_L2_EMPLOYER'),
  col('HIGHEST_QUALIFICATION', 'varchar', 40, many(() => pick(['GCSE', 'A level', 'Degree', 'None', 'NVQ'])), 'UK_L2_EDUCATION'),
  col('SCHOOL_NAME', 'varchar', 80, many(() => pick(['Eton College', 'Harrow School', 'Hillcrest Academy'])), 'UK_L2_SCHOOL'),
  col('NO_OF_CHILDREN', 'number', 2, many(() => String(int(0, 8))), 'UK_L2_DEPENDANTS'),

  // L3
  col('DNA_PROFILE', 'varchar', 200, many(() => 'AGTC'.repeat(10)), 'UK_L3_GENETIC'),
  col('FINGERPRINT_TEMPLATE', 'varchar', 200, many(() => many(() => pick('ABCDEF0123456789'), 64).join('')), 'UK_L3_BIOMETRIC'),
  col('PHOTO_PATH', 'varchar', 200, many(() => `/photos/${int(10000, 99999)}.jpg`), 'UK_L3_BIOMETRIC'),
  col('ETHNICITY', 'varchar', 40, many(() => pick(['White British', 'Indian', 'Pakistani', 'Caribbean', 'African'])), 'UK_L3_ETHNICITY'),
  col('FIELD13', 'varchar', 40, many(() => pick(['White British', 'White Irish', 'Indian', 'Pakistani', 'Bangladeshi', 'Chinese', 'Caribbean', 'African', 'Arab'])), 'UK_L3_ETHNICITY'),
  col('RELIGION', 'varchar', 40, many(() => pick(['Christian', 'No religion', 'Muslim', 'Hindu', 'Sikh'])), 'UK_L3_RELIGION'),
  col('CONSCIENTIOUS_OBJECTION', 'varchar', 60, many(() => pick(['Ethical veganism', 'None'])), 'UK_L3_BELIEF'),
  col('VOTING_INTENTION', 'varchar', 40, many(() => pick(['Left', 'Right', 'Undecided'])), 'UK_L3_POLITICAL_OPINION'),
  col('PARTY_AFFILIATION', 'varchar', 60, many(() => pick(['Labour', 'Conservative', 'Liberal Democrats', 'SNP', 'Reform UK'])), 'UK_L3_POLITICAL_AFFILIATION'),
  col('UNION_MEMBER', 'char', 1, many(() => pick(['Y', 'N'])), 'UK_L3_TRADE_UNION'),
  col('TRADE_UNION', 'varchar', 30, many(() => pick(['Unison', 'Unite', 'GMB', 'RCN'])), 'UK_L3_TRADE_UNION'),
  col('SEXUAL_ORIENTATION', 'varchar', 30, many(() => pick(['Straight or heterosexual', 'Gay or lesbian', 'Bisexual'])), 'UK_L3_SEXUAL_ORIENTATION'),
  col('SEXUAL_ACTIVITY', 'varchar', 30, many(() => 'Active'), 'UK_L3_SEXUAL_LIFE'),
  col('GENDER_IDENTITY', 'varchar', 40, many(() => pick(['Same as sex registered at birth', 'Trans man', 'Non-binary'])), 'UK_L3_GENDER_IDENTITY'),
  col('GRC_HOLDER', 'char', 1, many(() => pick(['Y', 'N'])), 'UK_L3_GENDER_IDENTITY'),

  // HEALTH
  col('HOSPITAL_NUMBER', 'varchar', 12, many(() => `RX${int(100000, 999999)}`), 'UK_HEALTH_ID'),
  col('DIAGNOSIS', 'varchar', 10, many(() => pick(['E11.9', 'I10', 'J45.9', 'F32.1'])), 'UK_HEALTH_DIAGNOSIS'),
  col('ICD10_CODE', 'varchar', 6, many(() => pick(['E11', 'I10', 'F20', 'B20'])), 'UK_HEALTH_DIAGNOSIS'),
  col('MEDICATION', 'varchar', 40, many(() => pick(['Ramipril', 'Paracetamol', 'Metformin'])), 'UK_HEALTH_MEDICATION'),
  col('CLINICAL_NOTES', 'clob', 4000, many(() => `Patient reports abdominal pain for ${int(1, 9)} days.`), 'UK_HEALTH_CLINICAL_TEXT'),
  col('HIV_STATUS', 'varchar', 12, many(() => pick(['Positive', 'Negative'])), 'UK_HEALTH_TEST_RESULT'),
  col('BLOOD_GROUP', 'varchar', 4, many(() => pick(['A+', 'O-', 'AB+'])), 'UK_HEALTH_BLOOD_GROUP'),
  col('DISABILITY', 'varchar', 40, many(() => pick(['Disabled: limited a lot', 'Not disabled'])), 'UK_HEALTH_DISABILITY'),
  col('PREGNANT', 'char', 1, many(() => pick(['Y', 'N'])), 'UK_HEALTH_REPRODUCTIVE'),
  col('MENTAL_HEALTH_CONDITION', 'varchar', 60, many(() => pick(['Depression', 'Anxiety'])), 'UK_HEALTH_MENTAL'),

  // FIN
  col('CREDIT_SCORE', 'number', 3, many(() => String(int(300, 999))), 'UK_FIN_CREDIT_REFERENCE'),
  col('CCJ_STATUS', 'varchar', 40, many(() => pick(['Up to date', 'County Court Judgment'])), 'UK_FIN_CREDIT_REFERENCE'),
  col('LOAN_BALANCE', 'number', 12, many(() => String(int(1000, 900000))), 'UK_FIN_DEBT'),
  col('ANNUAL_SALARY', 'number', 10, many(() => String(int(15000, 200000))), 'UK_FIN_INCOME'),
  col('PROPERTY_VALUE', 'number', 12, many(() => String(int(80000, 2000000))), 'UK_FIN_ASSETS'),
  col('PENSION_POT', 'number', 10, many(() => String(int(1000, 900000))), 'UK_FIN_PENSION'),
  col('BENEFIT_TYPE', 'varchar', 40, many(() => pick(['Universal Credit', 'Personal Independence Payment', 'Child Benefit'])), 'UK_FIN_BENEFIT'),
  col('FSM_ELIGIBLE', 'char', 1, many(() => pick(['Y', 'N'])), 'UK_FIN_BENEFIT'),
  col('IMD_DECILE', 'number', 2, many(() => String(int(1, 10))), 'UK_FIN_DEPRIVATION'),
  col('HOUSING_TENURE', 'varchar', 40, many(() => pick(['Owned outright', 'Private rented', 'Social rented from council'])), 'UK_FIN_HOUSING'),

  // PENAL
  col('CRIMINAL_RECORD', 'varchar', 30, many(() => pick(['No convictions', 'Spent conviction', 'Caution'])), 'UK_PENAL_CRIMINAL_RECORD'),
  col('PNC_ID', 'varchar', 15, many(() => `${int(1990, 2025)}/${int(100000, 9999999)}${pick([...'ABCDEFGHJKLMNPQRTUVWXYZ'])}`), 'UK_PENAL_CASE_NUMBER'),
  col('CRIME_REFERENCE', 'varchar', 20, many(() => `CRI/${int(10000, 99999)}/${int(20, 25)}`), 'UK_PENAL_CASE_NUMBER'),
  col('DBS_CERTIFICATE_NO', 'varchar', 12, many(() => `00${digits(10)}`), 'UK_PENAL_DBS'),

  // Not personal data: nothing should be assigned
  col('ID', 'integer', 10, many((i) => String(i + 1)), ''),
  col('FILE_PATH', 'varchar', 200, many(() => `/data/file${int(1, 99)}.txt`), ''),
  col('PRODUCT_NAME', 'varchar', 80, many(() => pick(['Semi-skimmed milk 2 pints', 'Basmati rice 1 kg', 'Ground coffee 227 g'])), ''),
  col('COMPANY_NAME', 'varchar', 80, many(() => `Trading ${int(1, 99)} Ltd`), ''),
  col('SALE_AMOUNT', 'number', 12, many(() => String(int(1000, 99999999))), ''),
  col('CREATED_DATE', 'date', 0, many(() => iso(2015, 2025)), ''),
  col('ENTRY_DATE', 'date', 0, many(() => iso(2015, 2025)), ''),
  col('DOC_DATE', 'varchar', 10, many(() => `${pad(int(1, 28), 2)}/${pad(int(1, 12), 2)}/${int(2015, 2025)}`), ''),
  col('CODE', 'varchar', 10, many(() => `A-${int(100, 999)}`), ''),
  col('PRODUCT_DESCRIPTION', 'varchar', 400, many(() => 'Everyday grocery product, recyclable cardboard packaging.'), ''),
  col('STATUS', 'varchar', 10, many(() => pick(['ACTIVE', 'INACTIVE'])), ''),
  col('QUANTITY', 'number', 6, many(() => String(int(1, 500))), ''),
  col('SKU', 'varchar', 12, many(() => `SKU${int(10000, 99999)}`), ''),
  col('HOTEL', 'varchar', 60, many(() => 'Central Hotel'), ''),
  col('TRANSACTION_ID', 'varchar', 36, many(() => `TX${int(100000, 999999)}`), ''),
  col('DEPARTMENT', 'varchar', 40, many(() => pick(['Finance', 'Operations'])), ''),
  col('PRODUCT_KEY', 'varchar', 10, many(() => `P-${int(100, 999)}`), ''),
  col('BANK_CHARGES', 'number', 8, many(() => String(int(1, 99))), ''),
  col('CABLE_LENGTH', 'number', 6, many(() => `${int(1, 99)}.5`), ''),
  col('PAGE_URL', 'varchar', 200, many(() => `https://www.example.co.uk/p/${int(1, 999)}`), ''),
  col('DOCUMENT_TYPE', 'varchar', 20, many(() => pick(['Invoice', 'Credit note'])), ''),
  col('CURRENCY', 'varchar', 3, many(() => pick(['GBP', 'EUR'])), ''),
  col('CATEGORY', 'varchar', 30, many(() => pick(['Dairy', 'Bakery'])), ''),
  col('COUNTY', 'varchar', 30, many(() => pick(['Kent', 'Surrey', 'Essex', 'Devon', 'Lancashire'])), ''),
  col('REGION', 'varchar', 30, many(() => pick(['North West', 'South East', 'Wales', 'Scotland', 'London'])), ''),
  col('PARTY_ID', 'varchar', 10, many(() => `PTY-${int(1000, 9999)}`), ''),
  col('THIRD_PARTY', 'varchar', 60, many(() => `Vendor ${int(1, 99)} Ltd`), ''),
  col('LANGUAGE_CODE', 'varchar', 5, many(() => pick(['en', 'cy', 'en-GB'])), ''),
  col('DEFAULT_VALUE', 'varchar', 20, many(() => pick(['0', 'N/A', 'true'])), ''),
  col('SORT_POSITION', 'number', 4, many(() => String(int(1, 99))), ''),
  col('CONDITION', 'varchar', 10, many(() => pick(['New', 'Used'])), ''),
  col('CASE_STATUS', 'varchar', 10, many(() => pick(['Open', 'Closed', 'Pending'])), ''),
  col('MESSAGE_ID', 'varchar', 36, many(() => `MSG${int(100000, 999999)}`), ''),
  col('IMAGE_WIDTH', 'number', 5, many(() => String(int(100, 4000))), ''),
  col('VAT_NUMBER', 'varchar', 14, many(() => `GB${digits(9)}`), ''),
  col('COMPANY_NUMBER', 'varchar', 8, many(() => pick(['SC', 'NI', '0'])  + digits(6)), ''),
  // Short names of packaged systems: nothing but the values to go by.
  col('PFNOM', 'char', 60, many(fullName), 'UK_L1_FULL_NAME'),
  col('PFMAIL', 'char', 80, many(() => `${pick(SURNAMES).toLowerCase().replace(/'/g, '')}.${int(1, 99)}@mail.com`), 'UK_L1_EMAIL'),
  col('PFSX', 'char', 1, many(() => pick(['F', 'M'])), 'UK_L2_SEX'),
  col('PFNI', 'char', 13, many(ninoSpaced), 'UK_L1_NINO'),
  col('PFNHS', 'char', 10, many(nhs), 'UK_L1_NHS_NUMBER'),
  col('PFTEL', 'char', 16, many(() => `07${int(100, 999)} ${int(100000, 999999)}`), 'UK_L1_PHONE'),
  col('PFPC', 'char', 8, many(postcode), 'UK_L2_POSTCODE'),
  col('DSPIMEI', 'char', 15, many(() => luhn('35', 15)), 'UK_L1_DEVICE_ID'),
  col('USPWD', 'char', 60, many(() => `$2b$12$${many(() => pick('./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'), 53).join('')}`), 'UK_L1_CREDENTIAL'),
  col('LBSEQ', 'clob', 4000, many(() => many(() => pick('ACGT'), 60).join('')), 'UK_L3_GENETIC'),
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
  const ALSO = {}
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
// A place of 20,000 people or more keeps its name, and so does the main town of each local
// authority. Every other place becomes a kept town of its own local authority — unless its name is
// shared with a place that keeps it. Every part of London becomes London.

function verifyGeneralization() {
  const table = new Map(fs.readFileSync(nodePath.join(HERE, 'files', 'uk-town-generalized.txt'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('|')))
  const targets = new Set(table.values())
  const keeps = (p) => p.population >= 20000 || targets.has(p.name)
  const byName = new Map()
  for (const p of PLACES) byName.set(p.name, [...(byName.get(p.name) ?? []), p])
  const seatOf = new Map()
  let ok = 0
  let shared = 0
  for (const p of PLACES) {
    const to = table.get(p.name)
    const homonyms = byName.get(p.name)
    const target = PLACES.find((x) => x.name === to && x.area === p.area)
    const problem = !to ? 'not in the table'
      : keeps(p) ? (to === p.name ? null : 'a large town or a main town was generalized')
        : homonyms.some(keeps) ? (to === p.name ? null : 'kept name expected')
          : homonyms.length > 1 ? null
            : !target ? `became ${to}, not a town of ${p.area}`
              : p.area === 'Greater London' && to !== 'London' ? `became ${to}, not London`
                : seatOf.has(p.area) && seatOf.get(p.area) !== to ? `became ${to}, but others in ${p.area} became ${seatOf.get(p.area)}` : null
    if (!problem && to && to !== p.name && homonyms.length === 1) seatOf.set(p.area, to)
    if (homonyms.length > 1 && !keeps(p)) shared++
    if (problem) { failures++; console.log(`  ✗ ${p.name} (${p.area}, ${p.population}): ${problem}`) }
    else ok++
  }
  for (const [from, to] of table) if (table.get(from.toUpperCase()) !== to.toUpperCase()) { failures++; console.log(`  ✗ ${from}: no upper-case line`) }
  const generalized = PLACES.filter((p) => !keeps(p)).length
  console.log(`towns: ${ok} of ${PLACES.length} as expected, ${generalized} become the main town of their local authority (${shared} small places share a name)`)
}

// ── Algorithms ──────────────────────────────────────────────────────────────

const words = (s) => s.trim().split(/\s+/).length
const sameShape = (i, o) => i.length === o.length && i.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9') === o.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9')
const digitShape = (i, o) => i.length === o.length && i.replace(/\d/g, '9') === o.replace(/\d/g, '9')
const MASKING = {
  UK_L1_NINO: {
    inputs: ['QQ 12 34 56 C', 'AB123456C', 'ab 12 34 56 d', ...many(nino, 6)],
    check: (i, o) => o.slice(0, 2) === i.slice(0, 2) && o.slice(-1) === i.slice(-1) && digitShape(i, o),
  },
  UK_L1_NHS_NUMBER: {
    // A CHI changes its date; the others keep their first digit.
    inputs: ['943 476 5919', '943-476-5919', '9434765919', '1503851238', ...many(nhs, 20)],
    check: (i, o) => isNhs(o) && digitShape(i, o) && (/^[0-3]/.test(i) || o[0] === i[0]),
  },
  UK_L1_UTR: { inputs: ['12345 67890', '1234567890K', ...many(utr, 20)], check: (i, o) => isUtr(o) && digitShape(i, o) },
  UK_L1_PASSPORT: { inputs: ['123456789', 'GB1234567'], check: sameShape },
  UK_L1_DRIVING_LICENCE: { inputs: ['MORGA753116SM9IJ', '12345678'], check: sameShape },
  UK_L1_IMMIGRATION_DOCUMENT: { inputs: ['ZR1234567', 'W2X 4YZ 9AB'] },
  UK_L1_VITAL_RECORD: { inputs: ['A123456'] },
  // Four words fall through to the Character Mapping: it must mask them, not act as a name lookup.
  UK_L1_GIVEN_NAME: { inputs: ['Oliver', 'MARY-JANE', 'Mary Elizabeth', 'Anne Marie Joy Grace'], check: (i, o) => words(i) === words(o) },
  UK_L1_SURNAME: { inputs: ['Smith', 'JONES', 'Bowes-Lyon'], check: (i, o) => words(i) === words(o) && i.includes('-') === o.includes('-') },
  UK_L1_FULL_NAME: {
    inputs: ['Oliver Smith', 'MARY ELIZABETH JONES', 'Oliver J. Smith', 'Mrs Mary Smith', 'Dr Rhys Evans', 'Smith, Oliver'],
    check: (i, o) => words(i) === words(o) && (!/ [A-Z]\. /.test(i) || / [A-Z]\. /.test(o)) && (!/^(Mrs|Dr) /.test(i) || o.startsWith(i.split(' ')[0])),
  },
  UK_L1_EMAIL: { inputs: ['mary.smith@gmail.com', 'info@company.co.uk'], check: (i, o) => /@[^@]+\.test$/.test(o) },
  UK_L1_PHONE: {
    inputs: ['+44 7700 900123', '07700 900123', '020 7946 0018', '(020) 7946 0018', '0161 496 0000', '+44 (0)20 7946 0018', '441632960123', '01632960123'],
    // The country code, the trunk 0, the two digits after it and the separators stay; the length does too.
    check: (i, o) => o.length === i.length && digitShape(i, o) && o.startsWith(i.match(/^(\+?44\s?(\(0\)\s?)?|\(?0)\d{2}/)[0]),
  },
  UK_L1_ADDRESS: { inputs: ['10 Downing Street, London', 'Flat 3, 12 High Street'] },
  UK_L1_ADDRESS_DETAIL: { inputs: ['Flat 4B', '12'] },
  UK_L1_BANK_ACCOUNT: { inputs: ['31926819', '00012345'], check: digitShape },
  UK_L1_SORT_CODE: { inputs: ['20-00-00', '601613', '40 47 84'], check: (i, o) => digitShape(i, o) && o.slice(0, 2) === i.slice(0, 2) },
  UK_L1_IBAN: {
    inputs: ['GB82WEST12345698765432', 'GB82 WEST 1234 5698 7654 32', ...many(iban, 6)],
    check: (i, o) => isIban(o) && o.slice(4, 8) === i.slice(4, 8).replace(/\s/g, '') + (i.includes(' ') ? '' : '') || (isIban(o) && o.replace(/\s/g, '').slice(4, 8) === i.replace(/\s/g, '').slice(4, 8)),
  },
  UK_L1_PAYMENT_CARD: { inputs: ['4929 1234 5678 9012'] },
  UK_L1_IP_ADDRESS: {
    inputs: ['81.2.69.160', '2001:db8::1'],
    check: (i, o) => (i.includes('.') ? o.split('.').every((p) => Number(p) >= 1 && Number(p) <= 254) : /^[0-9a-f:]+$/i.test(o)),
  },
  UK_L1_DEVICE_ID: { inputs: ['3c:22:fb:9a:10:e4', '356938035643809'], check: (i, o) => (i.includes(':') ? /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(o) : /^\d{15}$/.test(o)) },
  UK_L1_LICENCE_PLATE: {
    inputs: ['AB12 CDE', 'LD70XYZ', 'A123 BCD', 'ABC 123D', 'BAZ 1234'],
    // The plate alphabet has no I or Q; the current format keeps its region and age.
    check: (i, o) => sameShape(i, o) && !/[IQ]/.test(o.replace(/^[A-Z]{2}[IZ]/, '')) && (!/^[A-Z]{2}\d{2}/.test(i) || o.slice(0, 4) === i.slice(0, 4)),
  },
  UK_L1_VIN: { inputs: ['SAJAA01P9XH123456'], check: sameShape },
  UK_L1_PROPERTY: { inputs: ['100023336956', 'NGL123456'], check: sameShape },
  UK_L1_CONTRACT_NUMBER: { inputs: ['POL-123456'] },
  UK_L1_USERNAME: { inputs: ['@mary_s'] },
  UK_L1_CREDENTIAL: { inputs: ['Secret#2024'], check: (i, o) => /^X+$/.test(o) },
  UK_L1_GEOLOCATION: { inputs: ['51.501009', '51.501009,-0.141588'], check: (i, o) => o.slice(0, 4) === i.slice(0, 4) },
  UK_L1_FREE_TEXT: {
    inputs: ['Customer Smith, NI number AB 12 34 56 C, NHS 943 476 5919, email mary.smith@gmail.com, tel 07700 900123, SW1A 2AA.'],
    check: (i, o) => !/AB 12 34 56 C|943 476 5919|mary\.smith@gmail\.com|07700 900123|SW1A 2AA|Smith/.test(o),
  },
  UK_L2_BIRTH_DATE: { inputs: ['1985-07-20', '2008-01-15'], check: (i, o) => Math.abs(new Date(o.slice(0, 10)) - new Date(i)) <= 60 * 864e5 },
  UK_L2_BIRTH_YEAR: { inputs: ['1985'], check: (i, o) => o.startsWith('198'), same: true },
  UK_L2_AGE: { inputs: ['37', '7', '104'], check: (i, o) => (i === '104' ? o === '90' : i.length === 1 || o[0] === i[0]), same: true },
  UK_L2_EVENT_DATE: { inputs: ['2021-03-15'] },
  UK_L2_SEX: { inputs: ['F', 'M', 'Female', 'male', 'Woman'], same: true },
  UK_L2_POSTCODE: {
    inputs: ['SW1A 2AA', 'M1 1AE', 'cr26xh', 'EH1 1YZ', 'BT9 5AB'],
    // The outward code and the space stay; the inward code is a digit and two postcode letters.
    check: (i, o) => o.length === i.length && o.slice(0, -3) === i.slice(0, -3) && /^\d[ABD-HJLNP-UW-Z]{2}$/i.test(o.slice(-3)),
  },
  UK_L2_TOWN: { inputs: ['Windermere', 'Manchester', 'Portree', 'WHITBY', 'Lerwick', 'Keswick', 'Highgate'], same: true },
  UK_L2_NATIONALITY: { inputs: ['Latvian'], same: true },
  UK_L2_MARITAL_STATUS: { inputs: ['Cohabiting'], same: true },
  UK_L2_OCCUPATION: { inputs: ['Regional Operations Manager, North West'] },
  UK_L2_EMPLOYER: { inputs: ['Acme Widgets plc'] },
  UK_L2_EDUCATION: { inputs: ['A level or equivalent'], same: true },
  UK_L2_SCHOOL: { inputs: ['Eton College'] },
  UK_L2_DEPENDANTS: { inputs: ['9', '2'], check: (i, o) => Number(o) <= 5, same: true },
  UK_L3_GENETIC: { inputs: ['BRCA1 positive'] },
  UK_L3_BIOMETRIC: { inputs: ['A1B2C3D4E5F6'] },
  UK_L3_ETHNICITY: { inputs: ['Kashmiri', 'Y'], same: true },
  UK_L3_RELIGION: { inputs: ['Quaker', 'Y'], same: true },
  UK_L3_BELIEF: { inputs: ['Ethical veganism'] },
  UK_L3_POLITICAL_OPINION: { inputs: ['Centre-right'], same: true },
  UK_L3_POLITICAL_AFFILIATION: { inputs: ['Scottish National Party', 'Y'], same: true },
  UK_L3_TRADE_UNION: { inputs: ['Unison', 'Y'], same: true },
  UK_L3_SEXUAL_ORIENTATION: { inputs: ['Bisexual'], same: true },
  UK_L3_SEXUAL_LIFE: { inputs: ['Active'] },
  UK_L3_GENDER_IDENTITY: { inputs: ['Trans man', 'Y'], same: true },
  UK_HEALTH_ID: { inputs: ['RX123456'] },
  UK_HEALTH_DIAGNOSIS: { inputs: ['F32.9', 'B20', '44054006', 'Type 2 diabetes'], same: true },
  UK_HEALTH_MEDICATION: { inputs: ['Sertraline 50 mg'] },
  UK_HEALTH_CLINICAL_TEXT: { inputs: ['Patient Smith, NHS 943 476 5919, seen for headache.'], check: (i, o) => !o.includes('943 476 5919') },
  UK_HEALTH_TEST_RESULT: { inputs: ['Positive'] },
  UK_HEALTH_BLOOD_GROUP: { inputs: ['O+'], same: true },
  UK_HEALTH_DISABILITY: { inputs: ['Severe psychosocial disability', 'N'], same: true },
  UK_HEALTH_REPRODUCTIVE: { inputs: ['12 weeks pregnant', 'Y'], same: true },
  UK_HEALTH_MENTAL: { inputs: ['Bipolar disorder'] },
  UK_FIN_CREDIT_REFERENCE: { inputs: ['3 payments missed', '745', 'N'], same: true },
  UK_FIN_DEBT: { inputs: ['850000'] },
  UK_FIN_INCOME: { inputs: ['42000', '42000.50'] },
  UK_FIN_ASSETS: { inputs: ['385000'] },
  UK_FIN_PENSION: { inputs: ['11502'] },
  UK_FIN_BENEFIT: { inputs: ['Bereavement Support Payment', 'Y'], same: true },
  UK_FIN_DEPRIVATION: { inputs: ['Most deprived', '3', 'Decile 8', 'Quintile 2', '12345'], same: true },
  UK_FIN_HOUSING: { inputs: ['Sofa surfing'], same: true },
  UK_PENAL_CRIMINAL_RECORD: { inputs: ['Convicted of theft, 2019', 'Y'], same: true },
  UK_PENAL_CASE_NUMBER: { inputs: ['2019/0123456X', 'T20237012'] },
  UK_PENAL_DBS: { inputs: ['001234567890', 'Enhanced with barred list', 'Y'], same: true },
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
const EXPECT = {
  UK_L1_GIVEN_NAME: (i, o) => words(i) > 3 || o.split(/[\s-]+/).every((w) => has('uk-given-names.txt', w) || has('uk-given-names.txt', o)),
  UK_L1_SURNAME: (i, o) => o.split(/[\s\-]+/).every((w) => has('uk-surnames.txt', w)),
  UK_L1_FULL_NAME: (i, o) => i.includes(',') || o.split(/\s+/).at(-1).split('-').every((w) => has('uk-surnames.txt', w)),
  UK_L1_ADDRESS: (i, o) => has('uk-addresses.txt', o),
  UK_L2_SEX: (i, o) => ({ f: ['f', 'm'], m: ['f', 'm'], female: ['female', 'male'], male: ['female', 'male'], woman: ['woman', 'man'] })[i.toLowerCase()].includes(o.toLowerCase()),
  // Windermere and Keswick (Cumbria) become Carlisle, Whitby (North Yorkshire) Harrogate, Portree
  // (Highland) Inverness, Highgate London; Manchester is large and Lerwick is the main town of the
  // Shetland Islands, and both stay.
  UK_L2_TOWN: (i, o) => ({ Windermere: 'Carlisle', Manchester: 'Manchester', Portree: 'Inverness', WHITBY: 'HARROGATE', Lerwick: 'Lerwick', Keswick: 'Carlisle', Highgate: 'London' })[i] === o,
  UK_L2_NATIONALITY: (i, o) => has('uk-nationalities.txt', o),
  UK_L2_MARITAL_STATUS: (i, o) => has('uk-marital-status.txt', o),
  UK_L2_OCCUPATION: (i, o) => has('uk-occupations.txt', o),
  UK_L2_EMPLOYER: (i, o) => has('uk-employers.txt', o),
  UK_L2_EDUCATION: (i, o) => has('uk-education.txt', o),
  UK_L2_SCHOOL: (i, o) => has('uk-schools.txt', o),
  UK_L3_ETHNICITY: (i, o) => flag(i, o) ?? has('uk-ethnic-groups.txt', o),
  UK_L3_RELIGION: (i, o) => flag(i, o) ?? has('uk-religions.txt', o),
  UK_L3_BELIEF: (i, o) => o === SUPPRESSED,
  UK_L3_POLITICAL_OPINION: (i, o) => has('uk-political-opinions.txt', o),
  UK_L3_POLITICAL_AFFILIATION: (i, o) => flag(i, o) ?? has('uk-political-parties.txt', o),
  UK_L3_TRADE_UNION: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  UK_L3_SEXUAL_ORIENTATION: (i, o) => has('uk-sexual-orientations.txt', o),
  UK_L3_SEXUAL_LIFE: (i, o) => o === SUPPRESSED,
  UK_L3_GENDER_IDENTITY: (i, o) => flag(i, o) ?? has('uk-gender-identities.txt', o),
  UK_HEALTH_DIAGNOSIS: (i, o) => (/\.\d/.test(i) ? has('uk-icd10-decimal.txt', o) : /^[A-Z]\d{2}$/i.test(i) ? has('uk-icd10.txt', o) : /^\d+$/.test(i) ? digitShape(i, o) : has('uk-diagnoses.txt', o)),
  UK_HEALTH_MEDICATION: (i, o) => has('uk-medications.txt', o),
  UK_HEALTH_BLOOD_GROUP: (i, o) => BLOOD_GROUPS.has(o),
  UK_HEALTH_DISABILITY: (i, o) => flag(i, o) ?? has('uk-disabilities.txt', o),
  UK_HEALTH_REPRODUCTIVE: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  UK_HEALTH_MENTAL: (i, o) => o === SUPPRESSED,
  UK_FIN_CREDIT_REFERENCE: (i, o) => flag(i, o) ?? (/^\d{3}$/.test(i) ? /^\d{3}$/.test(o) : has('uk-credit-statuses.txt', o)),
  UK_FIN_BENEFIT: (i, o) => flag(i, o) ?? has('uk-benefits.txt', o),
  UK_FIN_DEPRIVATION: (i, o) => (/^\d$/.test(i) ? /^[1-5]$/.test(o) : /^decile/i.test(i) ? /^Decile ([1-9]|10)$/.test(o) : /^quintile/i.test(i) ? /^Quintile [1-5]$/.test(o) : /^\d+$/.test(i) ? digitShape(i, o) : has('uk-deprivation-statuses.txt', o)),
  UK_FIN_HOUSING: (i, o) => has('uk-housing-tenure.txt', o),
  UK_PENAL_CRIMINAL_RECORD: (i, o) => flag(i, o) ?? has('uk-criminal-record.txt', o),
  UK_PENAL_DBS: (i, o) => flag(i, o) ?? (/^\d+$/.test(i) ? digitShape(i, o) && o !== i : has('uk-dbs-outcomes.txt', o)),
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
  const TYPED = new Set(['UK_L2_BIRTH_DATE', 'UK_L2_EVENT_DATE', 'UK_FIN_DEBT', 'UK_FIN_INCOME', 'UK_FIN_ASSETS', 'UK_FIN_PENSION'])
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
  // With zeros: the same number as the bare value masks to, as wide as the padded value.
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
      const runOne = (x) => mask(algo.framework, resolve(algo.config), x, additional).catch((err) => ({ error: err.message }))
      const [bare, out] = await Promise.all([runOne(input), runOne(value)])
      if (bare.output != null && out.output != null && fits(bare.output, out.output)) { paddedPassed++; continue }
      failures++
      paddedLines.push(`  ✗ padded ${domain.name} ${JSON.stringify(value)} → ${JSON.stringify(out.output ?? out.error)}, bare ${JSON.stringify(input)} → ${JSON.stringify(bare.output ?? bare.error)}`)
    }
  }
  await Promise.all(Array.from({ length: 6 }, paddedWorker))
  console.log(paddedLines.sort().join('\n'))
  console.log(`masked ${padded.length} padded values: ${paddedPassed} as their bare value`)

  // Different keys must stay different: NINOs and NHS numbers used as keys should not collide. The
  // NHS repair step moves about one body in eleven, so a few collisions are expected there.
  for (const [algorithmName, make, slack] of [['UK_NINO', nino, 0], ['UK_NHS_COLUMN', nhs, 0.03]]) {
    const inputs = [...new Set(many(make, 150))]
    const outputs = new Set()
    for (const input of inputs) outputs.add((await run(algorithmName, input)).output)
    if (outputs.size < inputs.length * (1 - slack)) { failures++; console.log(`  ✗ ${algorithmName}: ${inputs.length} inputs gave ${outputs.size} distinct outputs`) }
    else console.log(`${algorithmName}: ${inputs.length} distinct inputs, ${outputs.size} distinct outputs`)
  }
}

if (only !== 'algorithms') { verifyClassifiers(); verifyGeneralization() }
if (only !== 'classifiers') await verifyAlgorithms()
console.log(failures ? `\n${failures} problem(s)` : '\nall good')
process.exit(failures ? 1 : 0)
