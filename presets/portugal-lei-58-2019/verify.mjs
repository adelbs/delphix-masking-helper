#!/usr/bin/env node
/**
 * Checks the Portugal (RGPD and Lei n.º 58/2019) preset.
 *
 *   node presets/portugal-lei-58-2019/verify.mjs               # classifiers, then algorithms
 *   node presets/portugal-lei-58-2019/verify.mjs classifiers    # only the local profiling check
 *   node presets/portugal-lei-58-2019/verify.mjs algorithms     # only masking, against the app
 *
 * Classifiers run through classifiers/, the same evaluator the classifier test uses: every
 * configuration is reviewed, then a battery of columns — well named, badly named, named in English,
 * and unrelated — is profiled with the whole set at its threshold and with the essential pack. The
 * tables that generalize concelhos, freguesias, their codes and the postal codes are audited
 * offline. Algorithms run in the app (DLPX_URL, default http://localhost:3000), which needs the
 * Delphix jars in lib/; every Cartão de Cidadão, NIF, NISS, número de utente, prescription number,
 * IBAN, NIB and CPE they write is checked against its own rule.
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

// ── Check rules ─────────────────────────────────────────────────────────────

const W9 = [9, 8, 7, 6, 5, 4, 3, 2]
/** NIF and the civil number with its check digit: weights 9 to 2, eleven minus the remainder, 10 and 11 as 0. */
const mod11 = (eight) => String((11 - ([...eight].reduce((t, c, i) => t + Number(c) * W9[i], 0) % 11)) % 11 % 10)
const validNine = (value) => { const d = value.replace(/^PT\s?/, '').replace(/[\s.\-]/g, ''); return /^\d{9}$/.test(d) && mod11(d.slice(0, 8)) === d[8] }
const A36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const luhn36 = (payload) => {
  const s = [...payload.toUpperCase()].reverse().reduce((t, c, i) => { const v = A36.indexOf(c); return t + (i % 2 === 0 ? (2 * v > 9 ? 2 * v - 9 : 2 * v) : v) }, 0)
  return String((10 - (s % 10)) % 10)
}
/** The document number of the Cartão de Cidadão: the civil number and its digit, the version, a Luhn digit over all of it. */
const validCc = (value) => { const c = value.replace(/[\s\-]/g, ''); return /^\d{9}[A-Z0-9]{2}\d$/.test(c) && validNine(c.slice(0, 9)) && luhn36(c.slice(0, 11)) === c[11] }
const NW = [29, 23, 19, 17, 13, 11, 7, 5, 3, 2]
const nissDigit = (ten) => String(9 - ([...ten].reduce((t, c, i) => t + Number(c) * NW[i], 0) % 10))
const validNiss = (value) => { const d = value.replace(/[\s.\-]/g, ''); return /^[12]\d{10}$/.test(d) && nissDigit(d.slice(0, 10)) === d[10] }
const mod1110 = (digits) => { let p = 10; for (const d of digits) { const s = (p + Number(d)) % 10 || 10; p = (2 * s) % 11 } return String((11 - p) % 10) }
const validNnu = (value) => { const d = value.replace(/[\s.\-]/g, ''); return /^\d{9}$/.test(d) && mod1110(d.slice(0, 8)) === d[8] }
const mod112 = (digits) => { let p = 0; for (const d of digits) p = ((p + Number(d)) * 2) % 11; const c = (12 - p) % 11; return c === 10 ? 'X' : String(c) }
const validRx = (value) => /^\d{18}[\dX]$/.test(value) && mod112(value.slice(0, 18)) === value[18]
const nibCheck = (nineteen) => String(98 - Number((BigInt(nineteen) * 100n) % 97n)).padStart(2, '0')
const validNib = (value) => { const d = value.replace(/[\s.\-]/g, ''); return /^\d{21}$/.test(d) && nibCheck(d.slice(0, 19)) === d.slice(19) }
/** ISO 13616: move PTkk to the end, read P as 25 and T as 29, remainder 1 modulo 97 — and the NIB valid too. */
const validIban = (value) => {
  const c = value.replace(/\s/g, '')
  if (!/^PT\d{23}$/.test(c)) return false
  let r = 0
  for (const x of `${c.slice(4)}2529${c.slice(2, 4)}`) r = (r * 10 + Number(x)) % 97
  return r === 1 && validNib(c.slice(4))
}
const L23 = 'TRWAGMYFPDXBNJZSQVHLCKE'
const cpeLetters = (sixteen) => { const r = Number(BigInt(sixteen) % 529n); return `${L23[Math.floor(r / 23)]}${L23[r % 23]}` }
const validCpe = (value) => { const c = value.replace(/\s/g, ''); return /^PT\d{16}[A-Z]{2}(\d[A-Z])?$/.test(c) && cpeLetters(c.slice(2, 18)) === c.slice(18, 20) }

// ── Test data ───────────────────────────────────────────────────────────────

let seed = 582019
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
const GIVEN = source('nomes.txt')
const SURNAMES = source('apelidos.txt')
const REGIONS = source('distritos.tsv').map((l) => { const [code, name] = l.split('\t'); return { code, name } })
const CONCELHOS = source('concelhos.tsv').map((l) => {
  const [code, name, regionCode, region, , , population] = l.split('\t')
  return { code, name, regionCode, region, population: Number(population) }
})
const FREGUESIAS = source('freguesias.tsv').map((l) => {
  const [code, name, concelhoCode, population, era] = l.split('\t')
  return { code, name, concelhoCode, population: Number(population), era }
})
const POSTAL = source('codigos-postais.tsv').map((l) => { const [code, c] = l.split('\t'); return { code, concelhos: c.split(';') } })
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '')
const key = (n) => fold(n).toLowerCase()
const small = (p) => p.population < 20000
const concelhoByCode = new Map(CONCELHOS.map((c) => [c.code, c]))
const LARGE_CONCELHOS = CONCELHOS.filter((c) => !small(c)).map((c) => c.name)

const pad = (n, w) => String(n).padStart(w, '0')
const digits = (n) => many(() => int(0, 9), n).join('')
const nicBody = () => pad(int(100000, 39999999), 8)
const nic = () => { const b = nicBody(); return `${b}${mod11(b)}` }
const cc = (spaced = true) => {
  const n = nic()
  const version = pick(['ZZ', 'ZY', 'ZX', 'Z1', 'ZW'])
  const check = luhn36(`${n}${version}`)
  return spaced ? `${n.slice(0, 8)} ${n[8]} ${version}${check}` : `${n}${version}${check}`
}
const nif = () => { const b = `${pick(['1', '2', '2', '2', '3'])}${digits(7)}`; return `${b}${mod11(b)}` }
const companyNif = () => { const b = `${pick(['5', '5', '5', '6', '9'])}${digits(7)}`; return `${b}${mod11(b)}` }
const niss = () => { const b = `1${digits(9)}`; return `${b}${nissDigit(b)}` }
const nnu = () => { const b = `${pick(['1', '2', '3', '4', '5', '6', '7', '9'])}${digits(7)}`; return `${b}${mod1110(b)}` }
const rx = () => { const b = `${int(1, 7)}${digits(17)}`; return `${b}${mod112(b)}` }
const BANKS = ['0007', '0010', '0018', '0023', '0033', '0035', '0036', '0045', '0079', '0269']
const nib = () => { const b = `${pick(BANKS)}${digits(4)}${digits(11)}`; return `${b}${nibCheck(b)}` }
const iban = (spaced = false) => { const c = `PT50${nib()}`; return spaced ? c.replace(/(.{4})/g, '$1 ').trim() : c }
const cpe = () => { const s = `${pick(['0002', '0002', '0013', '0014'])}${digits(12)}`; return `PT${s}${cpeLetters(s)}` }
const luhn = (prefix, length) => {
  const ds = [...prefix].map(Number)
  while (ds.length < length - 1) ds.push(int(0, 9))
  const sum = ds.slice().reverse().reduce((s, d, i) => s + (i % 2 === 0 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0)
  return ds.join('') + String((10 - (sum % 10)) % 10)
}
const iso = (y0, y1) => `${int(y0, y1)}-${pad(int(1, 12), 2)}-${pad(int(1, 28), 2)}`
const fullName = () => `${pick(GIVEN)}${random() < 0.3 ? ` ${pick(GIVEN)}` : ''} ${pick(SURNAMES)} ${pick(SURNAMES)}`
const phone = () => pick([`9${pick(['1', '2', '3', '6'])}${digits(1)} ${digits(3)} ${digits(3)}`, `+351 91${digits(7)}`, `96${digits(7)}`, `+351 21${digits(7)}`])
const address = () => pick([
  `Rua ${pick(['da Liberdade', 'do Comércio', 'da Igreja', 'Luís de Camões'])}, ${int(1, 99)}, ${int(1, 8)}.º ${pick(['Esq.', 'Dto.'])}`,
  `Avenida 25 de Abril ${int(1, 200)}, R/C`,
  `Travessa da Fonte ${int(1, 80)}, ${int(1, 5)}.º Frente`,
  `Largo do Município, ${int(1, 20)}`,
])
const letters = (n, from = 'ABCDEFGHIJLMNOPQRSTUVXZ') => many(() => pick(from), n).join('')
const plate = () => pick([`${letters(2)}-${digits(2)}-${letters(2)}`, `${digits(2)}-${letters(2)}-${digits(2)}`, `${digits(2)}-${digits(2)}-${letters(2)}`])
const postal = () => `${pick(POSTAL).code}-${digits(3)}`
const nuipc = () => `${int(1, 9999)}/${int(15, 26)}.${int(0, 9)}${pick(['PBLSB', 'GAPRT', 'JAFAR', 'T8LSB', 'T9PRT'])}`

// ── Classifiers ─────────────────────────────────────────────────────────────

const SQL = { varchar: 12, char: 1, number: 2, integer: 4, date: 91, timestamp: 93, clob: 2005 }
const col = (name, type, length, values, expect) => ({ name, sqlType: SQL[type], length, values, expect })
const SMALL_CONCELHOS = CONCELHOS.filter((c) => small(c)).map((c) => c.name)
const FREG_NAMES = FREGUESIAS.filter((f) => !f.name.startsWith('União')).map((f) => f.name)

const COLUMNS = [
  // L1 — well named
  col('NUMERO_CC', 'varchar', 15, many(() => cc()), 'PT_L1_CARTAO_CIDADAO'),
  col('NUM_DOC_IDENTIFICACAO', 'varchar', 15, many(() => cc(false)), 'PT_L1_CARTAO_CIDADAO'),
  col('BI', 'varchar', 10, many(() => { const n = nic(); return `${n.slice(0, 8)}-${n[8]}` }), 'PT_L1_CARTAO_CIDADAO'),
  col('NIF', 'varchar', 9, many(nif), 'PT_L1_NIF'),
  col('NUMERO_CONTRIBUINTE', 'varchar', 11, many(() => `PT${nif()}`), 'PT_L1_NIF'),
  col('NIF_CLIENTE', 'varchar', 9, many(nif), 'PT_L1_NIF'),
  col('NISS', 'varchar', 11, many(niss), 'PT_L1_NISS'),
  col('NUM_SEGURANCA_SOCIAL', 'varchar', 11, many(niss), 'PT_L1_NISS'),
  col('PASSAPORTE', 'varchar', 8, many(() => `${letters(2)}${digits(6)}`), 'PT_L1_PASSAPORTE'),
  col('TITULO_RESIDENCIA', 'varchar', 12, many(() => `${letters(1)}${digits(9)}`), 'PT_L1_TITULO_RESIDENCIA'),
  col('CARTA_CONDUCAO', 'varchar', 12, many(() => `${pick(['L', 'P', 'C', 'AV'])}-${digits(6)} ${digits(1)}`), 'PT_L1_CARTA_CONDUCAO'),
  col('NUMERO_ALUNO', 'varchar', 10, many(() => digits(7)), 'PT_L1_NUMERO_ESTUDANTE'),
  col('CEDULA_PROFISSIONAL', 'varchar', 8, many(() => digits(5)), 'PT_L1_CEDULA_PROFISSIONAL'),
  col('NOME', 'varchar', 30, many(() => pick(GIVEN)), 'PT_L1_NOME'),
  col('APELIDO', 'varchar', 30, many(() => pick(SURNAMES)), 'PT_L1_APELIDO'),
  col('APELIDOS', 'varchar', 60, many(() => `${pick(SURNAMES)} ${pick(SURNAMES)}`), 'PT_L1_APELIDO'),
  col('NOME_COMPLETO', 'varchar', 120, many(fullName), 'PT_L1_NOME_COMPLETO'),
  col('NOME_TITULAR', 'varchar', 120, many(fullName), 'PT_L1_NOME_COMPLETO'),
  col('EMAIL', 'varchar', 100, many(() => `${key(pick(GIVEN))}.${int(1, 999)}@gmail.com`), 'PT_L1_EMAIL'),
  col('CORREIO_ELETRONICO', 'varchar', 100, many(() => `contacto${int(1, 999)}@empresa.pt`), 'PT_L1_EMAIL'),
  col('TELEFONE', 'varchar', 16, many(phone), 'PT_L1_TELEFONE'),
  col('TELEMOVEL', 'varchar', 16, many(() => `9${pick(['1', '2', '3', '6'])}${digits(7)}`), 'PT_L1_TELEFONE'),
  col('MORADA', 'varchar', 200, many(address), 'PT_L1_MORADA'),
  col('ENDERECO', 'varchar', 200, many(address), 'PT_L1_MORADA'),
  col('ANDAR', 'varchar', 10, many(() => `${int(1, 9)}.º`), 'PT_L1_MORADA_COMPLEMENTO'),
  col('IBAN', 'varchar', 34, many(() => iban()), 'PT_L1_CONTA_BANCARIA'),
  col('CONTA_DEBITO', 'varchar', 34, many(() => iban(true)), 'PT_L1_CONTA_BANCARIA'),
  col('NIB', 'varchar', 21, many(nib), 'PT_L1_CONTA_BANCARIA'),
  col('NUMERO_CARTAO', 'varchar', 19, many(() => luhn('4', 16)), 'PT_L1_CARTAO_PAGAMENTO'),
  col('CARTEIRA_DIGITAL', 'varchar', 64, many(() => `bc1q${letters(38, '023456789acdefghjklmnpqrstuvwxyz')}`), 'PT_L1_CARTEIRA_DIGITAL'),
  col('IP_ORIGEM', 'varchar', 15, many(() => `${int(1, 223)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`), 'PT_L1_IP'),
  col('MAC_ADDRESS', 'varchar', 17, many(() => many(() => int(0, 255).toString(16).padStart(2, '0'), 6).join(':')), 'PT_L1_DISPOSITIVO'),
  col('IMEI', 'varchar', 15, many(() => luhn('35', 15)), 'PT_L1_DISPOSITIVO'),
  col('COOKIE_ID', 'varchar', 40, many(() => `GA1.2.${int(100000000, 999999999)}.${int(1600000000, 1799999999)}`), 'PT_L1_COOKIE'),
  col('MATRICULA', 'varchar', 8, many(plate), 'PT_L1_MATRICULA'),
  col('NUMERO_CHASSIS', 'varchar', 17, many(() => letters(17, 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789')), 'PT_L1_VEICULO'),
  col('ARTIGO_MATRICIAL', 'varchar', 16, many(() => `${pick(FREGUESIAS).code}-${pick(['U', 'R'])}-${int(1, 9999)}`), 'PT_L1_IMOVEL'),
  col('CPE', 'varchar', 20, many(cpe), 'PT_L1_PONTO_ENTREGA'),
  col('NUMERO_CONTRATO', 'varchar', 12, many(() => `CT-${int(100000, 999999)}`), 'PT_L1_CONTRATO'),
  col('UTILIZADOR', 'varchar', 30, many(() => `${key(pick(GIVEN))}${int(1, 99)}`), 'PT_L1_UTILIZADOR'),
  col('PALAVRA_PASSE', 'varchar', 60, many(() => `$2a$10$${letters(53, 'abcdefghijklmnopqrstuvwxyz0123456789')}`), 'PT_L1_CREDENCIAL'),
  col('FOTOGRAFIA', 'varchar', 200, many(() => `/fotos/pessoa_${int(1, 9999)}.jpg`), 'PT_L1_IMAGEM'),
  col('LATITUDE', 'varchar', 12, many(() => `38.${int(100000, 999999)}`), 'PT_L1_GEOLOCALIZACAO'),
  col('OBSERVACOES', 'clob', 4000, many(() => `O cliente pede atualização de dados. CC ${cc()}, email ${key(pick(GIVEN))}@gmail.com.`), 'PT_L1_TEXTO_LIVRE'),

  // L2
  col('DATA_NASCIMENTO', 'date', 0, many(() => iso(1940, 2010)), 'PT_L2_DATA_NASCIMENTO'),
  col('DT_NASC', 'timestamp', 0, many(() => `${iso(1940, 2010)} 00:00:00`), 'PT_L2_DATA_NASCIMENTO'),
  col('ANO_NASCIMENTO', 'integer', 4, many(() => String(int(1940, 2010))), 'PT_L2_ANO_NASCIMENTO'),
  col('IDADE', 'integer', 3, many(() => String(int(18, 95))), 'PT_L2_IDADE'),
  col('DATA_OBITO', 'date', 0, many(() => iso(2000, 2025)), 'PT_L2_DATA_EVENTO'),
  col('SEXO', 'char', 1, many(() => pick(['F', 'M'])), 'PT_L2_SEXO'),
  col('GENERO', 'varchar', 10, many(() => pick(['Feminino', 'Masculino'])), 'PT_L2_SEXO'),
  col('CONCELHO', 'varchar', 40, many(() => pick([...SMALL_CONCELHOS, ...LARGE_CONCELHOS])), 'PT_L2_CONCELHO'),
  col('NATURALIDADE', 'varchar', 40, many(() => pick(LARGE_CONCELHOS)), 'PT_L2_CONCELHO'),
  col('FREGUESIA', 'varchar', 80, many(() => pick(FREG_NAMES)), 'PT_L2_FREGUESIA'),
  col('DICOFRE', 'varchar', 6, many(() => pick(FREGUESIAS).code), 'PT_L2_CODIGO_AUTARQUICO'),
  col('COD_CONCELHO', 'varchar', 4, many(() => pick(CONCELHOS).code), 'PT_L2_CODIGO_AUTARQUICO'),
  col('CODIGO_POSTAL', 'varchar', 8, many(postal), 'PT_L2_CODIGO_POSTAL'),
  col('NACIONALIDADE', 'varchar', 20, many(() => pick(['Portuguesa', 'Brasileira', 'Cabo-verdiana', 'Angolana'])), 'PT_L2_NACIONALIDADE'),
  col('SITUACAO_RESIDENCIA', 'varchar', 60, many(() => pick(['Autorização de residência temporária', 'Autorização de residência CPLP', 'Proteção temporária'])), 'PT_L2_SITUACAO_RESIDENCIA'),
  col('ESTADO_CIVIL', 'varchar', 30, many(() => pick(['Solteiro(a)', 'Casado(a)', 'União de facto'])), 'PT_L2_ESTADO_CIVIL'),
  col('PROFISSAO', 'varchar', 40, many(() => pick(['Enfermeiro', 'Pedreiro', 'Professor'])), 'PT_L2_PROFISSAO'),
  col('ENTIDADE_EMPREGADORA', 'varchar', 80, many(() => `Empresa ${int(1, 99)}, Lda.`), 'PT_L2_ENTIDADE_EMPREGADORA'),
  col('ESCOLARIDADE', 'varchar', 40, many(() => pick(['Licenciatura', 'Ensino secundário', '12.º ano'])), 'PT_L2_ESCOLARIDADE'),
  col('ESCOLA', 'varchar', 80, many(() => `Escola Básica n.º ${int(1, 9)}`), 'PT_L2_ESTABELECIMENTO_ENSINO'),
  col('NUMERO_DEPENDENTES', 'integer', 2, many(() => String(int(0, 4))), 'PT_L2_AGREGADO'),

  // L3
  col('ETNIA', 'varchar', 20, many(() => pick(['Cigana', 'Negra', 'Branca'])), 'PT_L3_ORIGEM_ETNICA'),
  col('RELIGIAO', 'varchar', 30, many(() => pick(['Católica', 'Muçulmana', 'Sem religião'])), 'PT_L3_RELIGIAO'),
  col('OBJECAO_CONSCIENCIA', 'varchar', 20, many(() => pick(['S', 'N'])), 'PT_L3_CONVICCAO_FILOSOFICA'),
  col('ORIENTACAO_POLITICA', 'varchar', 20, many(() => pick(['Esquerda', 'Centro', 'Direita'])), 'PT_L3_OPINIAO_POLITICA'),
  col('PARTIDO', 'varchar', 20, many(() => pick(['PS', 'PSD', 'Chega', 'IL'])), 'PT_L3_FILIACAO_PARTIDARIA'),
  col('QUOTA_SINDICAL', 'varchar', 10, many(() => pick(['S', 'N'])), 'PT_L3_FILIACAO_SINDICAL'),
  col('IMPRESSAO_DIGITAL', 'varchar', 200, many(() => letters(64, 'ABCDEF0123456789')), 'PT_L3_BIOMETRICO'),
  col('TESTE_GENETICO', 'varchar', 30, many(() => pick(['BRCA1 positivo', 'Negativo'])), 'PT_L3_GENETICO'),
  col('ORIENTACAO_SEXUAL', 'varchar', 20, many(() => pick(['Heterossexual', 'Gay', 'Bissexual'])), 'PT_L3_ORIENTACAO_SEXUAL'),
  col('VIDA_SEXUAL', 'varchar', 20, many(() => pick(['Ativa', 'Inativa'])), 'PT_L3_VIDA_SEXUAL'),
  col('IDENTIDADE_GENERO', 'varchar', 30, many(() => pick(['Mulher trans', 'Homem cis'])), 'PT_L3_IDENTIDADE_GENERO'),
  col('VITIMA_VIOLENCIA_DOMESTICA', 'char', 1, many(() => pick(['S', 'N'])), 'PT_L3_VITIMA'),

  // SAUDE
  col('NUMERO_UTENTE', 'varchar', 9, many(nnu), 'PT_SAUDE_NUMERO_UTENTE'),
  col('NUM_UTENTE_SNS', 'varchar', 9, many(nnu), 'PT_SAUDE_NUMERO_UTENTE'),
  col('NUMERO_RECEITA', 'varchar', 19, many(rx), 'PT_SAUDE_RECEITA'),
  col('PROCESSO_CLINICO', 'varchar', 10, many(() => digits(8)), 'PT_SAUDE_IDENTIFICADOR'),
  col('SUBSISTEMA_SAUDE', 'varchar', 30, many(() => pick(['SNS', 'ADSE - titular', 'SAMS'])), 'PT_SAUDE_SUBSISTEMA'),
  col('DIAGNOSTICO', 'varchar', 10, many(() => pick(['E11.9', 'I10', 'J45.909', 'F32'])), 'PT_SAUDE_DIAGNOSTICO'),
  col('COD_ICPC', 'varchar', 4, many(() => pick(['K86', 'T90', 'A97', 'R74'])), 'PT_SAUDE_DIAGNOSTICO'),
  col('PROCEDIMENTO', 'varchar', 10, many(() => letters(7, '0123456789ABCDEFGH')), 'PT_SAUDE_PROCEDIMENTO'),
  col('MEDICAMENTO', 'varchar', 40, many(() => pick(['Paracetamol', 'Sertralina', 'Metformina'])), 'PT_SAUDE_MEDICAMENTO'),
  col('NOTA_ALTA', 'clob', 4000, many(() => 'Doente com evolução favorável, alta para o domicílio.'), 'PT_SAUDE_TEXTO_CLINICO'),
  col('RESULTADO_ANALISE', 'varchar', 20, many(() => pick(['Positivo', 'Negativo'])), 'PT_SAUDE_RESULTADO_EXAME'),
  col('SEROLOGIA_VIH', 'varchar', 10, many(() => pick(['Positivo', 'Negativo'])), 'PT_SAUDE_VIH'),
  col('GRUPO_SANGUINEO', 'varchar', 3, many(() => pick(['A+', 'O-', 'AB+'])), 'PT_SAUDE_GRUPO_SANGUINEO'),
  col('GRAU_INCAPACIDADE', 'varchar', 20, many(() => pick(['Motora', 'Visual', 'Auditiva'])), 'PT_SAUDE_INCAPACIDADE'),
  col('COMPLEMENTO_DEPENDENCIA', 'varchar', 30, many(() => pick(['Dependência de 1.º grau', 'Dependência de 2.º grau'])), 'PT_SAUDE_DEPENDENCIA'),
  col('FICHA_APTIDAO', 'varchar', 30, many(() => pick(['Apto', 'Inapto temporariamente'])), 'PT_SAUDE_TRABALHO'),
  col('GRAVIDEZ', 'char', 1, many(() => pick(['S', 'N'])), 'PT_SAUDE_REPRODUTIVA'),
  col('SAUDE_MENTAL', 'varchar', 40, many(() => pick(['Depressão', 'Ansiedade'])), 'PT_SAUDE_MENTAL'),

  // FIN
  col('HISTORICO_CREDITO', 'varchar', 30, many(() => pick(['Sem incidentes', 'Em PERSI'])), 'PT_FIN_CREDITO'),
  col('MONTANTE_DIVIDA', 'number', 12, many(() => String(int(500, 200000))), 'PT_FIN_DIVIDA'),
  col('VENCIMENTO_BASE', 'number', 10, many(() => String(int(870, 6000))), 'PT_FIN_RENDIMENTO'),
  col('VALOR_PATRIMONIAL', 'number', 12, many(() => String(int(30000, 900000))), 'PT_FIN_PATRIMONIO'),
  col('VALOR_PENSAO', 'number', 8, many(() => String(int(300, 3500))), 'PT_FIN_PENSAO'),
  col('ESCALAO_ABONO', 'varchar', 30, many(() => pick(['Abono de família', 'Nenhuma'])), 'PT_FIN_PRESTACAO_SOCIAL'),
  col('REEMBOLSO_IRS', 'varchar', 12, many(() => `${int(-2000, 3000)}.${pad(int(0, 99), 2)}`), 'PT_FIN_FISCAL'),

  // PENAL
  col('REGISTO_CRIMINAL', 'varchar', 30, many(() => pick(['Sem registo criminal', 'Com registo criminal'])), 'PT_PENAL_REGISTO_CRIMINAL'),
  col('CRC_MENORES', 'varchar', 30, many(() => pick(['Certificado apresentado', 'Pendente'])), 'PT_PENAL_CERTIFICADO_MENORES'),
  col('NUIPC', 'varchar', 20, many(nuipc), 'PT_PENAL_PROCESSO'),
  col('PONTOS_CARTA', 'varchar', 30, many(() => pick(['Perda de pontos', 'Sem contraordenações'])), 'PT_PENAL_CONTRAORDENACAO'),

  // In English, as packaged software names them
  col('FIRST_NAME', 'varchar', 30, many(() => pick(GIVEN)), 'PT_L1_NOME'),
  col('LAST_NAME', 'varchar', 30, many(() => pick(SURNAMES)), 'PT_L1_APELIDO'),
  col('VAT_NUMBER', 'varchar', 11, many(() => `PT${nif()}`), 'PT_L1_NIF'),
  col('BIRTH_DATE', 'date', 0, many(() => iso(1940, 2010)), 'PT_L2_DATA_NASCIMENTO'),
  col('ZIP_CODE', 'varchar', 8, many(postal), 'PT_L2_CODIGO_POSTAL'),

  // Not personal data
  col('ID', 'integer', 10, many((i) => String(i + 1)), ''),
  col('CAMINHO_FICHEIRO', 'varchar', 200, many(() => `/dados/ficheiro${int(1, 99)}.txt`), ''),
  col('NOME_PRODUTO', 'varchar', 80, many(() => pick(['Azeite virgem extra 1 l', 'Bacalhau seco 1 kg', 'Vinho do Porto 75 cl'])), ''),
  col('VALOR_VENDA', 'number', 12, many(() => String(int(1000, 99999999))), ''),
  col('DATA_CRIACAO', 'date', 0, many(() => iso(2015, 2025)), ''),
  col('DATA_FATURA', 'date', 0, many(() => iso(2015, 2025)), ''),
  col('CODIGO', 'varchar', 10, many(() => `A-${int(100, 999)}`), ''),
  col('DESCRICAO_PRODUTO', 'varchar', 400, many(() => 'Produto de consumo, embalagem de cartão reciclável.'), ''),
  col('ESTADO', 'varchar', 10, many(() => pick(['ATIVO', 'INATIVO'])), ''),
  col('QUANTIDADE', 'number', 6, many(() => String(int(1, 500))), ''),
  col('SKU', 'varchar', 12, many(() => `SKU${int(10000, 99999)}`), ''),
  col('ID_TRANSACAO', 'varchar', 36, many(() => `TX${int(100000, 999999)}`), ''),
  col('AREA', 'varchar', 40, many(() => pick(['Financeira', 'Operações'])), ''),
  col('DISTRITO', 'varchar', 30, many(() => pick(REGIONS).name), ''),
  col('REGIAO', 'varchar', 40, many(() => pick(['Norte', 'Centro', 'Alentejo', 'Algarve'])), ''),
  col('COD_BANCO', 'varchar', 4, many(() => pick(BANKS)), ''),
  col('URL_PAGINA', 'varchar', 200, many(() => `https://www.exemplo.pt/p/${int(1, 999)}`), ''),
  col('TIPO_DOCUMENTO', 'varchar', 6, many(() => pick(['CC', 'BI', 'PAS', 'TR'])), ''),
  col('MOEDA', 'varchar', 3, many(() => pick(['EUR', 'USD', 'GBP'])), ''),
  col('CATEGORIA', 'varchar', 30, many(() => pick(['Alimentação', 'Drogaria'])), ''),
  col('CODIGO_CAE', 'varchar', 5, many(() => pick(['47111', '62010', '86210'])), ''),
  col('IDIOMA_INTERFACE', 'varchar', 5, many(() => pick(['pt-PT', 'en', 'es'])), ''),
  col('VALOR_DEFEITO', 'varchar', 20, many(() => pick(['0', 'N/A', 'true'])), ''),
  col('ORDEM', 'number', 4, many(() => String(int(1, 99))), ''),
  col('ESTADO_ENCOMENDA', 'varchar', 10, many(() => pick(['Aberta', 'Fechada', 'Pendente'])), ''),
  col('ID_MENSAGEM', 'varchar', 36, many(() => `MSG${int(100000, 999999)}`), ''),
  col('DATA_FIM', 'date', 0, many(() => iso(2015, 2025)), ''),
  col('NOME_FICHEIRO', 'varchar', 60, many(() => `relatorio_${int(1, 99)}.pdf`), ''),
  col('PESO_KG', 'number', 6, many(() => `${int(1, 99)}.5`), ''),
  // The NIF and NISS of a company are no one's personal data: article 4.1 of the Regulamento reaches
  // natural persons, and the set must leave the column alone.
  col('NIF_EMPRESA', 'varchar', 9, many(companyNif), ''),
  col('NIPC_FORNECEDOR', 'varchar', 9, many(companyNif), ''),
  // Short names of packaged systems (a core banking table, say): nothing but the values to go by.
  col('PFNOM', 'char', 60, many(fullName), 'PT_L1_NOME_COMPLETO'),
  col('PFMAIL', 'char', 80, many(() => `${key(pick(SURNAMES))}.${int(1, 99)}@correio.pt`), 'PT_L1_EMAIL'),
  col('PFSX', 'char', 1, many(() => pick(['F', 'M'])), 'PT_L2_SEXO'),
  col('DSPIMEI', 'char', 15, many(() => luhn('35', 15)), 'PT_L1_DISPOSITIVO'),
  col('USPWD', 'char', 60, many(() => `$2b$12$${many(() => pick('./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'), 53).join('')}`), 'PT_L1_CREDENCIAL'),
  col('LBSEQ', 'clob', 4000, many(() => many(() => pick('ACGT'), 60).join('')), 'PT_L3_GENETICO'),
  col('PFDOC', 'char', 16, many(() => cc()), 'PT_L1_CARTAO_CIDADAO'),
  col('PFIBAN', 'char', 34, many(() => iban()), 'PT_L1_CONTA_BANCARIA'),
  col('PFCP', 'char', 8, many(postal), 'PT_L2_CODIGO_POSTAL'),
  col('PFMAT', 'char', 8, many(plate), 'PT_L1_MATRICULA'),
  col('PFTLM', 'char', 9, many(() => `9${pick(['1', '2', '3', '6'])}${digits(7)}`), 'PT_L1_TELEFONE'),
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
  // they did, and no other column may be taken for one of its domains.
  const essential = new Set(preset.packs.essential.domains)
  const pack = resolved.filter((c) => essential.has(c.domain))
  const ALSO = {}
  const packPassed = profile(pack, (c) => (essential.has(c.expect) ? c.expect : (ALSO[c.name] ?? '')), 'essential pack, ')
  console.log(`profiled ${COLUMNS.length} columns with the essential pack (${pack.length} classifiers): ${packPassed} as expected`)
}

// ── Concelhos, freguesias, codes and postal codes, offline ──────────────────
//
// The invariants:
//   · a concelho name all of whose bearers are under 20,000 is generalized, to the name of a concelho
//     of at least 20,000 in the same distrito or autonomous region; a name any of whose bearers is
//     large is left alone;
//   · a freguesia name all of whose bearers are small becomes the name of a freguesia of the concelho
//     its concelho ends up in;
//   · the DICO of a small concelho becomes the DICO of a large one of the same distrito or region,
//     and the DICOFRE of a small freguesia the DICOFRE of a freguesia of that concelho;
//   · a CP4 whose main concelho is small becomes a CP4 whose main concelho is large, in the same
//     distrito or region.

const readTable = (name) => new Map(fs.readFileSync(nodePath.join(HERE, 'files', name), 'utf8').split('\n').filter(Boolean).map((l) => l.split('|')))

function verifyGeneralization() {
  const table = readTable('pt-concelhos-generalizados.txt')
  const fregTable = readTable('pt-freguesias-generalizadas.txt')
  const codes = readTable('pt-codigos-autarquicos-generalizados.txt')
  const cp4 = readTable('pt-cp4-generalizados.txt')
  const freguesiaByCode = new Map(FREGUESIAS.map((f) => [f.code, f]))
  const strip = (c) => c.replace(/^0+(?=[1-9])/, '')
  const codeOf = (c) => codes.get(strip(c))

  // Concelhos.
  const regionOfName = new Map()
  for (const c of CONCELHOS) regionOfName.set(key(c.name), [...(regionOfName.get(key(c.name)) ?? []), c])
  const largeByName = new Map(CONCELHOS.filter((c) => !small(c)).map((c) => [key(c.name), c]))
  let ok = 0
  let shown = 0
  for (const c of CONCELHOS) {
    const problems = []
    const bearers = regionOfName.get(key(c.name))
    const to = table.get(c.name)
    if (!small(c)) { if (to) problems.push('a large concelho is generalized') }
    else if (bearers.every(small)) {
      const target = to && largeByName.get(key(to))
      if (!target) problems.push(`goes to ${to}, not a concelho of 20,000`)
      else if (bearers.length === 1 && target.regionCode !== c.regionCode) problems.push(`goes to ${to}, outside its distrito or region`)
    }
    const qualified = table.get(`${c.name} (${c.region})`)
    if (small(c) && !largeByName.has(key(c.name))) {
      if (!qualified) problems.push('not in the table with its distrito')
      else if (!qualified.endsWith(` (${c.region})`)) problems.push(`with its distrito → ${qualified}`)
    }
    const code = codeOf(c.code)
    if (small(c)) {
      const target = code && concelhoByCode.get(code.padStart(4, '0'))
      if (!target || small(target) || target.regionCode !== c.regionCode) problems.push(`DICO ${c.code} → ${code}`)
    } else if (code) problems.push('the DICO of a large concelho is generalized')
    if (problems.length) { failures++; if (shown++ < 15) console.log(`  ✗ ${c.name} (${c.population}): ${problems.join('; ')}`) }
    else ok++
  }
  console.log(`concelhos: ${ok} of ${CONCELHOS.length} as expected (${CONCELHOS.filter(small).length} under 20,000); table of ${table.size} lines`)

  // Freguesias. A name that folds into a distrito or a region — Madeirã is Madeira without its accent —
  // is left alone unqualified, as the build leaves it.
  const REGION_KEYS = new Set([...REGIONS.map((r) => r.name), 'Região Autónoma dos Açores', 'Região Autónoma da Madeira', 'Portugal', 'Continente'].map(key))
  const bearersOf = new Map()
  for (const f of FREGUESIAS) bearersOf.set(key(f.name), [...(bearersOf.get(key(f.name)) ?? []), f])
  const namesOfConcelho = new Map()
  for (const f of FREGUESIAS) namesOfConcelho.set(f.concelhoCode, [...(namesOfConcelho.get(f.concelhoCode) ?? []), key(f.name)])
  // The seat of a concelho — its most populous freguesia that still exists — is every small freguesia's
  // target, and keeps its own code.
  const seats = new Set(CONCELHOS.map((c) => FREGUESIAS.filter((f) => f.concelhoCode === c.code && f.era !== '2013-2025').reduce((a, b) => (b.population > a.population ? b : a)).code))
  const destination = (f) => { const c = concelhoByCode.get(f.concelhoCode); return small(c) ? concelhoByCode.get(codeOf(c.code).padStart(4, '0')) : c }
  let fok = 0
  let fshown = 0
  for (const f of FREGUESIAS) {
    const problems = []
    const bearers = bearersOf.get(key(f.name))
    const to = fregTable.get(f.name)
    if (!small(f)) { if (to) problems.push('a large freguesia is generalized') }
    else if (bearers.every(small) && bearers.length === 1 && !CONCELHOS.some((c) => key(c.name) === key(f.name) && !small(c)) && !REGION_KEYS.has(key(f.name))) {
      if (!to) problems.push('not in the table')
      else if (!namesOfConcelho.get(destination(f).code).includes(key(to))) problems.push(`goes to ${to}, not a freguesia of ${destination(f).name}`)
    }
    const code = codeOf(f.code)
    if (small(f)) {
      const target = code && freguesiaByCode.get(code.length === 5 ? `0${code}` : code)
      if (!code && seats.has(f.code) && destination(f).code === f.concelhoCode) { /* the seat itself */ } else if (!target || target.concelhoCode !== destination(f).code) problems.push(`DICOFRE ${f.code} → ${code}`)
    } else if (code) problems.push('the DICOFRE of a large freguesia is generalized')
    if (problems.length) { failures++; if (fshown++ < 15) console.log(`  ✗ freguesia ${f.name} (${f.code}, ${f.population}): ${problems.join('; ')}`) }
    else fok++
  }
  console.log(`freguesias: ${fok} of ${FREGUESIAS.length} as expected (${FREGUESIAS.filter(small).length} under 20,000); table of ${fregTable.size} lines`)

  // Postal codes.
  const mainOf = new Map(POSTAL.map((p) => [p.code, concelhoByCode.get(p.concelhos[0])]))
  let pok = 0
  let pshown = 0
  for (const p of POSTAL) {
    const main = mainOf.get(p.code)
    const to = cp4.get(p.code)
    let problem = null
    if (!small(main)) { if (to) problem = 'the CP4 of a large concelho is generalized' }
    else if (!to) problem = 'not in the table'
    else if (!mainOf.get(to) || small(mainOf.get(to))) problem = `${to} is not a CP4 of a large concelho`
    else if (mainOf.get(to).regionCode !== main.regionCode) problem = `${to} is in another distrito`
    if (problem) { failures++; if (pshown++ < 10) console.log(`  ✗ CP4 ${p.code} (${main.name}): ${problem}`) }
    else pok++
  }
  console.log(`postal codes: ${pok} of ${POSTAL.length} as expected (${cp4.size} generalized)`)

  let rok = 0
  for (const r of REGIONS) {
    if (table.get(r.name)) { failures++; console.log(`  ✗ ${r.name} is generalized`) } else rok++
  }
  console.log(`distritos and regions: ${rok} of ${REGIONS.length} kept`)
}

// ── Algorithms ──────────────────────────────────────────────────────────────

const words = (s) => s.trim().split(/\s+/).length
const sameShape = (i, o) => i.length === o.length && i.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9') === o.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9')
const digitShape = (i, o) => i.length === o.length && i.replace(/\d/g, '9') === o.replace(/\d/g, '9')
const coarse = (v) => v.split(/\s*,\s*/).map((part) => part.slice(0, part.search(/[.,]/) + 2)).join(',')
const MASKING = {
  PT_L1_CARTAO_CIDADAO: {
    inputs: [`12345678 9 ZZ${luhn36('123456789ZZ')}`, `123456789ZZ${luhn36('123456789ZZ')}`, '12345678-9', '123456789', '12345678', '1234567', 'CB123456', ...many(() => cc(), 6), ...many(() => cc(false), 3), ...many(nic, 3)],
    check: (i, o) => {
      if (/^\d{8}\s?\d\s?[A-Z0-9]{2}\d$/.test(i)) return validCc(o) && sameShape(i, o) && o.replace(/\s/g, '').slice(9, 11) === i.replace(/\s/g, '').slice(9, 11)
      if (/^\d{8}[\s\-]?\d$/.test(i)) return validNine(o) && digitShape(i, o)
      return sameShape(i, o)
    },
  },
  PT_L1_NIF: {
    inputs: ['123456789', 'PT123456789', '245 123 456', '451234567', '501964843', ...many(nif, 8)],
    // A company's NIF is nobody's personal datum: it comes back as it went in.
    keeps: (i) => /^[5-79]/.test(i),
    check: (i, o) => (/^[5-79]/.test(i) ? o === i : validNine(o) && digitShape(i.replace(/^PT/, ''), o.replace(/^PT/, '')) && o.replace(/^PT\s?/, '')[0] === i.replace(/^PT\s?/, '')[0]),
  },
  PT_L1_NISS: {
    inputs: ['11234567892', '21234567890', ...many(niss, 8)],
    keeps: (i) => i.startsWith('2'),
    check: (i, o) => (i.startsWith('2') ? o === i : validNiss(o) && o[0] === '1' && o.length === 11),
  },
  PT_L1_PASSAPORTE: { inputs: ['CB123456'], check: sameShape },
  PT_L1_TITULO_RESIDENCIA: { inputs: ['A123456789'], check: sameShape },
  PT_L1_CARTA_CONDUCAO: { inputs: ['L-123456 7'], check: sameShape },
  PT_L1_NUMERO_ESTUDANTE: { inputs: ['2012345'], check: sameShape },
  PT_L1_CEDULA_PROFISSIONAL: { inputs: ['54321'], check: sameShape },
  PT_L1_NOME: { inputs: ['Inês', 'JOÃO PEDRO', 'Maria da Conceição'], check: (i, o) => words(i) === words(o) && (!/ da /.test(i) || / da /.test(o)) },
  PT_L1_APELIDO: { inputs: ['Gonçalves', 'FERREIRA DOS SANTOS', 'Sousa e Silva'], check: (i, o) => words(i) === words(o) },
  PT_L1_NOME_COMPLETO: {
    inputs: ['Inês Gonçalves', 'JOÃO PEDRO SILVA', 'Maria da Conceição Ferreira dos Santos', 'António Manuel Sousa e Silva', 'SILVA, JOÃO'],
    check: (i, o) => words(i) === words(o) && [' da ', ' dos ', ' e '].every((w) => i.includes(w) === o.includes(w)),
  },
  PT_L1_EMAIL: { inputs: ['ines.goncalves@gmail.com', 'joão.conceição@empresa.pt'], check: (i, o) => /@[^@]+\.test$/.test(o) },
  PT_L1_TELEFONE: {
    inputs: ['+351 912 345 678', '912345678', '21 123 4567', '00351 961234567'],
    // The country code and the first two digits stay, so a masked number still says mobile or landline.
    check: (i, o) => digitShape(i, o) && o.replace(/\D/g, '').slice(-9, -7) === i.replace(/\D/g, '').slice(-9, -7) && o !== i,
  },
  PT_L1_MORADA: { inputs: ['Rua da Liberdade, 12, 3.º Esq.', 'Avenida 25 de Abril 45, R/C'] },
  PT_L1_MORADA_COMPLEMENTO: { inputs: ['3.º Esq.', 'Lote 12'] },
  PT_L1_CONTA_BANCARIA: {
    inputs: [`PT50${nib()}`, iban(true), nib(), `${nib().slice(0, 4)}.${nib().slice(4, 8)}.${digits(11)}.00`, 'ES9121000418450200051332', ...many(() => iban(), 4), ...many(() => iban(true), 3), ...many(nib, 3)],
    check: (i, o) => {
      if (/^ES/.test(i)) return o !== i && o.length === i.length && o.startsWith('ES')
      if (/\./.test(i)) return digitShape(i, o)
      const bank = (v) => v.replace(/\s/g, '').replace(/^PT50/, '').slice(0, 8)
      return (/^PT/.test(i) ? validIban(o) : validNib(o)) && bank(o) === bank(i) && digitShape(i, o)
    },
  },
  PT_L1_CARTAO_PAGAMENTO: { inputs: ['4532 0000 0000 0001'] },
  PT_L1_CARTEIRA_DIGITAL: { inputs: ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'], check: sameShape },
  PT_L1_IP: { inputs: ['85.243.120.12', '2001:8a0::1'], check: (i, o) => (i.includes('.') ? o.split('.').every((p) => Number(p) >= 1 && Number(p) <= 254) : /^[0-9a-f:]+$/i.test(o)) },
  PT_L1_DISPOSITIVO: { inputs: ['3c:22:fb:9a:10:e4', '356938035643809'], check: (i, o) => (i.includes(':') ? /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(o) : /^\d{15}$/.test(o)) },
  PT_L1_COOKIE: { inputs: ['GA1.2.123456789.1700000000'], check: sameShape },
  PT_L1_MATRICULA: {
    inputs: ['AA-12-BC', '12-AB-34', '12-34-AB', 'AB-12-34', 'AA12BC'],
    // The order of the series stays, and the letters keep clear of K, W and Y.
    check: (i, o) => sameShape(i, o) && !/[KWY]/.test(o),
  },
  PT_L1_VEICULO: { inputs: ['VF1RFB00X56123456'], check: sameShape },
  PT_L1_IMOVEL: { inputs: ['110508-U-1234', 'R-123', '1234/20101010'], check: (i, o) => digitShape(i, o) && o.replace(/\d/g, '') === i.replace(/\d/g, '') && (!/^\d{6}-/.test(i) || o.slice(0, 7) === i.slice(0, 7)) },
  PT_L1_PONTO_ENTREGA: { inputs: ['PT0002000066435112QY', 'PT0002000109439276TN', ...many(cpe, 4)], check: (i, o) => validCpe(o) && o.slice(0, 6) === i.slice(0, 6) && o.length === i.length },
  PT_L1_CONTRATO: { inputs: ['CT-123456'] },
  PT_L1_UTILIZADOR: { inputs: ['@ines_goncalves'] },
  PT_L1_CREDENCIAL: { inputs: ['Senha#2024'], check: (i, o) => /^X+$/.test(o) },
  PT_L1_IMAGEM: { inputs: ['/fotos/pessoa_12.jpg'], check: (i, o) => /^X+$/.test(o) },
  // The integer part and the first decimal stay — about 11 km.
  PT_L1_GEOLOCALIZACAO: { inputs: ['38.722252', '38.722252,-9.139337'], check: (i, o) => coarse(o) === coarse(i) },
  PT_L1_TEXTO_LIVRE: {
    inputs: ['Cliente Gonçalves, NIF 123456789, email i.goncalves@gmail.com, telemóvel 912345678.'],
    check: (i, o) => !/123456789|i\.goncalves@gmail\.com|912345678|Gonçalves/.test(o),
  },
  PT_L2_DATA_NASCIMENTO: { inputs: ['1985-07-20', '2012-01-15'], check: (i, o) => Math.abs(new Date(o.slice(0, 10)) - new Date(i)) <= 60 * 864e5 },
  PT_L2_ANO_NASCIMENTO: { inputs: ['1985'], check: (i, o) => o.startsWith('198'), same: true },
  PT_L2_IDADE: { inputs: ['37', '7', '104'], check: (i, o) => (i === '104' ? o === '90' : i.length === 1 || o[0] === i[0]), same: true },
  PT_L2_DATA_EVENTO: { inputs: ['2021-03-15'] },
  PT_L2_SEXO: { inputs: ['F', 'M', 'H', 'Feminino', 'masculino', 'Mulher', '1'], same: true },
  PT_L2_CONCELHO: { inputs: ['Mértola', 'Lisboa', 'PORTO', 'Mértola (Beja)', 'Barrancos', 'Braga', 'Calheta', 'Corvo'], same: true },
  PT_L2_FREGUESIA: { inputs: ['Alvarenga', 'Amora', 'Odeceixe', 'Ajuda (Lisboa)'], same: true },
  // 0209 Mértola is small and moves; 1106 Lisboa is large and stays, and its freguesia 110601 Ajuda,
  // of 14,000, becomes Lisboa's largest; 0302FA is a union of freguesias of Barcelos.
  PT_L2_CODIGO_AUTARQUICO: { inputs: ['0209', '020901', '1106', '110601', '110618', '0302FA'], same: true },
  PT_L2_CODIGO_POSTAL: { inputs: ['7750-320', '1000-001', '7750', '7750-320 MÉRTOLA'], same: true },
  PT_L2_NACIONALIDADE: { inputs: ['Timorense'], same: true },
  PT_L2_SITUACAO_RESIDENCIA: { inputs: ['Manifestação de interesse', 'S'], same: true },
  PT_L2_ESTADO_CIVIL: { inputs: ['Casado em regime de comunhão de adquiridos', '2'], same: true },
  PT_L2_PROFISSAO: { inputs: ['Diretor de operações', '2221'] },
  PT_L2_ENTIDADE_EMPREGADORA: { inputs: ['Corporação Industrial do Atlântico, S.A.'] },
  PT_L2_ESCOLARIDADE: { inputs: ['Curso profissional em curso', '7'], same: true },
  PT_L2_ESTABELECIMENTO_ENSINO: { inputs: ['Universidade de Évora'] },
  PT_L2_AGREGADO: { inputs: ['9', '2'], check: (i, o) => Number(o) <= 5, same: true },
  PT_L3_ORIGEM_ETNICA: { inputs: ['Afrodescendente', '3', 'N'], same: true },
  PT_L3_RELIGIAO: { inputs: ['Anglicana', 'N'], same: true },
  PT_L3_CONVICCAO_FILOSOFICA: { inputs: ['Objetor a transfusões'] },
  PT_L3_OPINIAO_POLITICA: { inputs: ['Progressista', '7'], same: true },
  PT_L3_FILIACAO_PARTIDARIA: { inputs: ['PEV', 'S'], same: true },
  PT_L3_FILIACAO_SINDICAL: { inputs: ['CGTP', 'S'], same: true },
  PT_L3_BIOMETRICO: { inputs: ['A1B2C3D4E5F6'] },
  PT_L3_GENETICO: { inputs: ['BRCA1 positivo'] },
  PT_L3_ORIENTACAO_SEXUAL: { inputs: ['Homossexual'], same: true },
  PT_L3_VIDA_SEXUAL: { inputs: ['Ativa'] },
  PT_L3_IDENTIDADE_GENERO: { inputs: ['Transgénero'], same: true },
  PT_L3_VITIMA: { inputs: ['Violência doméstica', 'S'], same: true },
  PT_SAUDE_NUMERO_UTENTE: {
    inputs: ['629033874', ...many(nnu, 8)],
    check: (i, o) => validNnu(o) && o[0] === i[0] && o.length === i.length,
  },
  PT_SAUDE_RECEITA: { inputs: [...many(rx, 6)], check: (i, o) => validRx(o) && o[0] === i[0] && o.length === i.length },
  PT_SAUDE_IDENTIFICADOR: { inputs: ['12345678', 'P-2024-00123'], check: sameShape },
  PT_SAUDE_SUBSISTEMA: { inputs: ['ADSE - titular', '12345'], same: true },
  PT_SAUDE_DIAGNOSTICO: { inputs: ['F33.1', 'B24', 'K86', 'Depressão major'], same: true },
  PT_SAUDE_PROCEDIMENTO: { inputs: ['0DTJ4ZZ', '901234', 'Carga viral do VIH'], same: true },
  PT_SAUDE_MEDICAMENTO: { inputs: ['Sertralina 50 mg'] },
  PT_SAUDE_TEXTO_CLINICO: { inputs: ['Doente Gonçalves, utente 629033874, consulta por cefaleia. CC 12345678 9 ZZ4.'], check: (i, o) => !o.includes('629033874') && !o.includes('Gonçalves') },
  PT_SAUDE_RESULTADO_EXAME: { inputs: ['Positivo'] },
  PT_SAUDE_VIH: { inputs: ['Positivo', 'S'], same: true },
  PT_SAUDE_GRUPO_SANGUINEO: { inputs: ['O+'], same: true },
  PT_SAUDE_INCAPACIDADE: { inputs: ['Perturbação do espetro do autismo', 'N'], same: true },
  PT_SAUDE_DEPENDENCIA: { inputs: ['Acamado', '2'], same: true },
  PT_SAUDE_TRABALHO: { inputs: ['Inapto para trabalho noturno', 'S'], same: true },
  PT_SAUDE_REPRODUTIVA: { inputs: ['12 semanas de gestação', 'S'], same: true },
  PT_SAUDE_MENTAL: { inputs: ['Perturbação bipolar'] },
  PT_FIN_CREDITO: { inputs: ['Incluído na lista de devedores', '745', 'N'], same: true },
  PT_FIN_DIVIDA: { inputs: ['18500'] },
  PT_FIN_RENDIMENTO: { inputs: ['1450'] },
  PT_FIN_PATRIMONIO: { inputs: ['185000'] },
  PT_FIN_PENSAO: { inputs: ['650'] },
  PT_FIN_PRESTACAO_SOCIAL: { inputs: ['Apoio extraordinário à renda', 'S'], same: true },
  PT_FIN_FISCAL: { inputs: ['-1240.55', '24350', '31000,10'], check: (i, o) => /^-/.test(i) === /^-/.test(o) && /[.,]\d+$/.test(i) === /[.,]\d+$/.test(o) },
  PT_PENAL_REGISTO_CRIMINAL: { inputs: ['Condenado por furto em 2019', 'S'], same: true },
  PT_PENAL_CERTIFICADO_MENORES: { inputs: ['Certificado com averbamento', 'S'], same: true },
  PT_PENAL_PROCESSO: {
    inputs: ['123/24.5PBLSB', '1234/23.0T8LSB', '456/2024'],
    check: (i, o) => digitShape(i, o) && o.slice(o.indexOf('/')) === i.slice(i.indexOf('/')),
  },
  PT_PENAL_CONTRAORDENACAO: { inputs: ['Coima por excesso de velocidade', '12', 'N'], same: true },
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
const SUPPRESSED = 'Sem informação'
const LARGE = new Set(LARGE_CONCELHOS.map((n) => n.toLowerCase()))
const PARTICLE = /^(de|da|do|das|dos|e)$/i
const freguesiaNames = new Set(FREGUESIAS.map((f) => f.name.toLowerCase()))
const EXPECT = {
  PT_L1_NOME: (i, o) => o.split(/\s+/).every((w) => PARTICLE.test(w) || has('pt-nomes.txt', w)),
  PT_L1_APELIDO: (i, o) => o.split(/\s+/).every((w) => PARTICLE.test(w) || has('pt-apelidos.txt', w)),
  PT_L1_NOME_COMPLETO: (i, o) => i.includes(',') || (has('pt-nomes.txt', o.split(/\s+/)[0]) && has('pt-apelidos.txt', o.split(/\s+/).at(-1))),
  PT_L1_MORADA: (i, o) => has('pt-moradas.txt', o),
  PT_L2_SEXO: (i, o) => ({ f: ['f', 'm'], m: ['f', 'm'], h: ['h', 'm'], feminino: ['feminino', 'masculino'], masculino: ['feminino', 'masculino'], mulher: ['mulher', 'homem'], 1: ['1', '2'] })[i.toLowerCase()].includes(o.toLowerCase()),
  // Mértola (Beja, 6,000 people) becomes a large concelho of Beja; Lisboa and Porto stay; Corvo, the
  // smallest of all, becomes a large concelho of the Açores.
  PT_L2_CONCELHO: (i, o) => ({
    Lisboa: o === 'Lisboa',
    PORTO: o === 'PORTO',
    Braga: o === 'Braga',
    'Mértola (Beja)': / \(Beja\)$/.test(o) && LARGE.has(o.replace(/ \(Beja\)$/, '').toLowerCase()),
  })[i] ?? LARGE.has(o.toLowerCase()),
  // Amora, of 49,000, stays; the others become the largest freguesia of their concelho's destination.
  PT_L2_FREGUESIA: (i, o) => {
    if (i === 'Amora') return o === 'Amora'
    const [name, qualifier] = i.endsWith(')') ? [i.slice(0, i.lastIndexOf(' (')), i.slice(i.lastIndexOf(' (') + 2, -1)] : [i, null]
    const [outName, outQualifier] = qualifier ? [o.slice(0, o.lastIndexOf(' (')), o.slice(o.lastIndexOf(' (') + 2, -1)] : [o, null]
    return freguesiaNames.has(outName.toLowerCase()) && outName !== name && (!qualifier || outQualifier === qualifier)
  },
  PT_L2_CODIGO_AUTARQUICO: (i, o) => {
    if (i === '1106' || i === '110618') return o === i
    return o !== i && o.length === i.length && o.slice(0, 2) === i.slice(0, 2)
  },
  PT_L2_CODIGO_POSTAL: (i, o) => {
    const main = concelhoByCode.get(POSTAL.find((p) => p.code === i.slice(0, 4)).concelhos[0])
    return small(main) ? o.slice(0, 4) !== i.slice(0, 4) : o.slice(0, 4) === i.slice(0, 4)
  },
  PT_L2_NACIONALIDADE: (i, o) => has('pt-nacionalidades.txt', o),
  PT_L2_SITUACAO_RESIDENCIA: (i, o) => flag(i, o) ?? has('pt-situacao-residencia.txt', o),
  PT_L2_ESTADO_CIVIL: (i, o) => (/^\d$/.test(i) ? /^[1-6]$/.test(o) : has('pt-estado-civil.txt', o)),
  PT_L2_PROFISSAO: (i, o) => (/^\d+$/.test(i) ? /^\d{4}$/.test(o) : has('pt-profissoes.txt', o)),
  PT_L2_ENTIDADE_EMPREGADORA: (i, o) => has('pt-empregadores.txt', o),
  PT_L2_ESCOLARIDADE: (i, o) => (/^\d+$/.test(i) ? has('pt-escolaridade-codigos.txt', o) : has('pt-escolaridade.txt', o)),
  PT_L2_ESTABELECIMENTO_ENSINO: (i, o) => has('pt-estabelecimentos-ensino.txt', o),
  PT_L3_ORIGEM_ETNICA: (i, o) => flag(i, o) ?? (/^\d$/.test(i) ? has('pt-origem-etnica-codigos.txt', o) : has('pt-origem-etnica.txt', o)),
  PT_L3_RELIGIAO: (i, o) => flag(i, o) ?? has('pt-religioes.txt', o),
  PT_L3_CONVICCAO_FILOSOFICA: (i, o) => o === SUPPRESSED,
  PT_L3_OPINIAO_POLITICA: (i, o) => (/^\d+$/.test(i) ? has('pt-opinioes-politicas-codigos.txt', o) : has('pt-opinioes-politicas.txt', o)),
  PT_L3_FILIACAO_PARTIDARIA: (i, o) => flag(i, o) ?? has('pt-partidos.txt', o),
  PT_L3_FILIACAO_SINDICAL: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  PT_L3_ORIENTACAO_SEXUAL: (i, o) => has('pt-orientacoes-sexuais.txt', o),
  PT_L3_VIDA_SEXUAL: (i, o) => o === SUPPRESSED,
  PT_L3_IDENTIDADE_GENERO: (i, o) => has('pt-identidades-genero.txt', o),
  PT_L3_VITIMA: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  PT_SAUDE_SUBSISTEMA: (i, o) => (/^\d+$/.test(i) ? digitShape(i, o) : has('pt-cobertura-saude.txt', o)),
  PT_SAUDE_DIAGNOSTICO: (i, o) => (/^[A-Z]\d/.test(i) ? has(i.includes('.') ? 'pt-cid10-decimal.txt' : 'pt-cid10.txt', o) : has('pt-diagnosticos.txt', o)),
  PT_SAUDE_PROCEDIMENTO: (i, o) => (/^[0-9A-Z]{7}$/.test(i) ? sameShape(i, o) : /^\d+$/.test(i) ? digitShape(i, o) : has('pt-procedimentos.txt', o)),
  PT_SAUDE_MEDICAMENTO: (i, o) => has('pt-medicamentos.txt', o),
  PT_SAUDE_VIH: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  PT_SAUDE_GRUPO_SANGUINEO: (i, o) => BLOOD_GROUPS.has(o),
  PT_SAUDE_INCAPACIDADE: (i, o) => flag(i, o) ?? has('pt-incapacidades.txt', o),
  PT_SAUDE_DEPENDENCIA: (i, o) => (/^\d$/.test(i) ? has('pt-dependencia-codigos.txt', o) : has('pt-dependencia.txt', o)),
  PT_SAUDE_TRABALHO: (i, o) => flag(i, o) ?? has('pt-aptidao.txt', o),
  PT_SAUDE_REPRODUTIVA: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  PT_SAUDE_MENTAL: (i, o) => o === SUPPRESSED,
  PT_FIN_CREDITO: (i, o) => flag(i, o) ?? (/^\d+$/.test(i) ? digitShape(i, o) : has('pt-estados-credito.txt', o)),
  PT_FIN_PRESTACAO_SOCIAL: (i, o) => flag(i, o) ?? has('pt-prestacoes-sociais.txt', o),
  PT_PENAL_REGISTO_CRIMINAL: (i, o) => flag(i, o) ?? has('pt-registo-criminal.txt', o),
  PT_PENAL_CERTIFICADO_MENORES: (i, o) => flag(i, o) ?? has('pt-certificado-menores.txt', o),
  PT_PENAL_CONTRAORDENACAO: (i, o) => flag(i, o) ?? (/^\d+$/.test(i) ? /^\d+$/.test(o) : has('pt-contraordenacoes.txt', o)),
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
  const run = (algorithmName, input) => { const algo = byAlgorithmName.get(algorithmName) ?? engineRun(algorithmName); return mask(algo.framework, resolve(algo.config), input, withIdentity(additionalFor(algorithmName))).catch((err) => ({ error: err.message })) }

  const jobs = preset.domains.flatMap((d) => (MASKING[d.name]?.inputs ?? []).map((input) => ({ domain: d, input })))
  for (const a of preset.algorithms) {
    if (a.input === undefined) { failures++; console.log(`  ✗ ${a.name} has no sample input`) }
    else jobs.push({ domain: { name: a.name, algorithm: a.name }, input: a.input, sample: true })
  }
  const TYPED = new Set(['PT_L2_DATA_NASCIMENTO', 'PT_L2_DATA_EVENTO', 'PT_FIN_DIVIDA', 'PT_FIN_RENDIMENTO', 'PT_FIN_PATRIMONIO', 'PT_FIN_PENSAO'])
  for (const d of preset.domains.filter((x) => !TYPED.has(x.name))) {
    for (const input of ['N/A', 'sem informação', '-']) jobs.push({ domain: d, input, placeholder: true })
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

  // Padding: a CHAR column fills a value with spaces, and a code kept as text may come with zeros
  // on the left. The padded value must mask as the bare one does — around the spaces, after the
  // zeros — so that it still joins its unpadded twin in another table.
  const same = (bare, out) => out.trim() === bare.trim()
  const sameNumber = (bare, out) => out.replace(/^0+(?=\d)/, '') === bare.replace(/^0+(?=\d)/, '') && out.length >= bare.length
  const isDomain = new Set(preset.domains.map((d) => d.name))
  // An autarchic code is written with four digits or six: a zero on the left may be part of it, and
  // a civil number of eight digits is a document number of seven with a zero.
  const ZEROS_ARE_DIGITS = new Set(['PT_L2_CODIGO_AUTARQUICO', 'PT_L1_CARTAO_CIDADAO'])
  const padded = jobs.filter((j) => !j.placeholder && isDomain.has(j.domain.name) && !TYPED.has(j.domain.name)).flatMap(({ domain, input }) => [
    { domain, input, value: `${input}   `, fits: same },
    { domain, input, value: `  ${input}`, fits: same },
    ...(/^\d{2,}$/.test(input) && !ZEROS_ARE_DIGITS.has(domain.name) ? [{ domain, input, value: `00${input}`, fits: sameNumber }] : []),
  ])
  let paddedPassed = 0
  const paddedLines = []
  let nextPadded = 0
  async function paddedWorker() {
    while (nextPadded < padded.length) {
      const { domain, input, value, fits } = padded[nextPadded++]
      const algo = byAlgorithmName.get(domain.algorithm) ?? engineRun(domain.algorithm)
      const runOne = (x) => mask(algo.framework, resolve(algo.config), x, withIdentity(additionalFor(domain.algorithm))).catch((err) => ({ error: err.message }))
      const [bare, out] = await Promise.all([runOne(input), runOne(value)])
      if (bare.output != null && out.output != null && fits(bare.output, out.output)) { paddedPassed++; continue }
      failures++
      paddedLines.push(`  ✗ padded ${domain.name} ${JSON.stringify(value)} → ${JSON.stringify(out.output ?? out.error)}, bare ${JSON.stringify(input)} → ${JSON.stringify(bare.output ?? bare.error)}`)
    }
  }
  await Promise.all(Array.from({ length: 6 }, paddedWorker))
  console.log(paddedLines.sort().join('\n'))
  console.log(`masked ${padded.length} padded values: ${paddedPassed} as their bare value`)

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
  await bulk('Cartão de Cidadão, printed', 'PT_IDENTIFICACAO', () => cc(), 150, validCc, (v) => v.slice(-4, -1))
  await bulk('Cartão de Cidadão, compact', 'PT_IDENTIFICACAO', () => cc(false), 50, validCc, (v) => v.slice(-3, -1))
  await bulk('civil number with check digit', 'PT_IDENTIFICACAO', nic, 100, validNine)
  await bulk('NIF', 'PT_NIF', nif, 200, validNine, (v) => v[0])
  await bulk('NISS', 'PT_NISS', niss, 150, validNiss, (v) => v[0])
  await bulk('número de utente', 'PT_NUMERO_UTENTE', nnu, 150, validNnu, (v) => v[0])
  await bulk('prescription number', 'PT_NUMERO_RECEITA', rx, 100, validRx, (v) => v[0])
  await bulk('IBAN compact', 'PT_CONTA', () => iban(), 100, validIban, (v) => v.slice(4, 12))
  await bulk('IBAN printed in groups of four', 'PT_CONTA', () => iban(true), 100, (v) => validIban(v) && /^PT50( \d{4}){5} \d$/.test(v), (v) => v.replace(/\s/g, '').slice(4, 12))
  await bulk('NIB', 'PT_CONTA', nib, 100, validNib, (v) => v.slice(0, 8))
  await bulk('CPE', 'PT_CPE', cpe, 100, validCpe, (v) => v.slice(0, 6))
}

if (only !== 'algorithms') { verifyClassifiers(); verifyGeneralization() }
if (only !== 'classifiers') await verifyAlgorithms()
console.log(failures ? `\n${failures} problem(s)` : '\nall good')
process.exit(failures ? 1 : 0)
