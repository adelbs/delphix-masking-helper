#!/usr/bin/env node
/**
 * Checks the Brazil (LGPD) preset.
 *
 *   node presets/brazil-lgpd/verify.mjs               # classifiers, then algorithms
 *   node presets/brazil-lgpd/verify.mjs classifiers   # only the local profiling check
 *   node presets/brazil-lgpd/verify.mjs algorithms    # only masking, against the app
 *
 * Classifiers run through classifiers/, the same evaluator the classifier test uses: every
 * configuration is reviewed, then a battery of columns — well named, badly named and unrelated —
 * is profiled with the whole set at its threshold. The table that generalizes municipalities is
 * audited offline. Algorithms run in the app (DLPX_URL, default http://localhost:3000), which needs
 * the Delphix jars in lib/; every CPF, CNPJ, PIS, voter card, CNS and RENAVAM they write is checked
 * against its check-digit rule.
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

const mod11 = (digits, weights) => {
  const r = digits.reduce((s, d, i) => s + d * weights[i], 0) % 11
  return r < 2 ? 0 : 11 - r
}
const ascii48 = (s) => [...s].map((c) => c.charCodeAt(0) - 48)
const W_CPF1 = [10, 9, 8, 7, 6, 5, 4, 3, 2]
const W_CPF2 = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]
const W_CNPJ1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
const W_CNPJ2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
const W_PIS = [3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
const cpfDigits = (body) => { const d1 = mod11(ascii48(body), W_CPF1); return `${body}${d1}${mod11(ascii48(body + d1), W_CPF2)}` }
const cnpjDigits = (body) => { const d1 = mod11(ascii48(body), W_CNPJ1); return `${body}${d1}${mod11(ascii48(body + d1), W_CNPJ2)}` }
const pisDigits = (body) => `${body}${mod11(ascii48(body), W_PIS)}`
const validCpf = (v) => { const s = v.replace(/[.\-]/g, '').padStart(11, '0'); return /^\d{11}$/.test(s) && cpfDigits(s.slice(0, 9)) === s }
const validCnpj = (v) => { const s = v.replace(/[.\-/]/g, '').padStart(14, '0'); return /^[0-9A-Z]{12}\d{2}$/.test(s) && cnpjDigits(s.slice(0, 12)) === s }
const validPis = (v) => { const s = v.replace(/[.\-]/g, '').padStart(11, '0'); return /^\d{11}$/.test(s) && pisDigits(s.slice(0, 10)) === s }
const tituloDv = (r, uf) => (r === 10 ? 0 : r === 0 && (uf === '01' || uf === '02') ? 1 : r)
const tituloDigits = (seq, uf) => {
  const d1 = tituloDv(ascii48(seq).reduce((s, d, i) => s + d * (2 + i), 0) % 11, uf)
  return `${seq}${uf}${d1}${tituloDv((Number(uf[0]) * 7 + Number(uf[1]) * 8 + d1 * 9) % 11, uf)}`
}
const validTitulo = (v) => { const s = v.padStart(12, '0'); return /^\d{12}$/.test(s) && tituloDigits(s.slice(0, 8), s.slice(8, 10)) === s }
const validCns = (v) => /^[1-9]\d{14}$/.test(v) && ascii48(v).reduce((s, d, i) => s + d * (15 - i), 0) % 11 === 0

// ── Test data ───────────────────────────────────────────────────────────────

let seed = 13709
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
const SURNAMES = source('sobrenomes.txt')
const STREETS = source('logradouros.txt')
const MUNICIPALITIES = source('municipios.tsv').map((l) => { const [code, name, uf, , , population, alias] = l.split('\t'); return { code, name, uf, population: Number(population), alias } })
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '')
const PERSONAL = new Set([...GIVEN, ...SURNAMES].map((w) => fold(w).toLowerCase()))
const LARGE_NAMES = MUNICIPALITIES.filter((m) => m.population >= 20000).map((m) => m.name)
const SMALL_NAMES = MUNICIPALITIES.filter((m) => m.population < 20000 && !PERSONAL.has(fold(m.name).toLowerCase())).map((m) => m.name)

const pad = (n, w) => String(n).padStart(w, '0')
const digits = (n) => many(() => int(0, 9), n).join('')
const cpf = () => cpfDigits(digits(9))
const cpfFormatted = () => cpf().replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
const cnpj = () => cnpjDigits(`${digits(8)}0001`)
const cnpjFormatted = () => cnpj().replace(/(\w{2})(\w{3})(\w{3})(\w{4})(\d{2})/, '$1.$2.$3/$4-$5')
const cnpjLetters = () => cnpjDigits(`${many(() => pick('0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'), 8).join('')}${pick(['0001', '0002', '01AB'])}`)
const pis = () => pisDigits(`1${digits(9)}`)
const titulo = () => tituloDigits(digits(8), pad(int(1, 28), 2))
const cnsFromPis = (p) => {
  const s = ascii48(p).reduce((t, d, i) => t + d * (15 - i), 0)
  const dv = (11 - (s % 11)) % 11
  return dv !== 10 ? `${p}000${dv}` : `${p}001${(11 - ((s + 2) % 11)) % 11}`
}
const cns = () => cnsFromPis(pis())
const renavam = () => pisDigits(digits(10))
const luhn = (prefix, length) => {
  const ds = [...prefix].map(Number)
  while (ds.length < length - 1) ds.push(int(0, 9))
  const sum = ds.slice().reverse().reduce((s, d, i) => s + (i % 2 === 0 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0)
  return ds.join('') + String((10 - (sum % 10)) % 10)
}
const iso = (y0, y1) => `${int(y0, y1)}-${pad(int(1, 12), 2)}-${pad(int(1, 28), 2)}`
const fullName = () => `${pick(GIVEN)}${random() < 0.3 ? ` ${pick(GIVEN)}` : ''}${random() < 0.3 ? ' da' : ''} ${pick(SURNAMES)} ${pick(SURNAMES)}`
const mobile = () => pick([`(${int(11, 99)}) 9${int(1000, 9999)}-${int(1000, 9999)}`, `${int(11, 99)}9${int(10000000, 99999999)}`, `+55 ${int(11, 99)} 9${int(1000, 9999)}-${int(1000, 9999)}`])
const landline = () => `(${int(11, 99)}) ${int(2, 5)}${int(100, 999)}-${int(1000, 9999)}`
const cep = () => `${pad(int(1000, 99999), 5)}-${pad(int(0, 999), 3)}`
const plate = () => pick([`${many(() => pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 3).join('')}${int(0, 9)}${pick('ABCDEFGHIJ')}${pad(int(0, 99), 2)}`, `${many(() => pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 3).join('')}-${pad(int(0, 9999), 4)}`])
const address = () => `${pick(STREETS)}, ${int(1, 3000)}${random() < 0.3 ? `, Apto ${int(11, 204)}` : ''}`

// ── Classifiers ─────────────────────────────────────────────────────────────

const SQL = { varchar: 12, char: 1, number: 2, integer: 4, date: 91, timestamp: 93, clob: 2005 }
const col = (name, type, length, values, expect) => ({ name, sqlType: SQL[type], length, values, expect })

const COLUMNS = [
  // L1 — well named
  col('NR_CPF', 'varchar', 14, many(cpfFormatted), 'BR_L1_CPF'),
  col('CPF_CLIENTE', 'varchar', 11, many(cpf), 'BR_L1_CPF'),
  col('cpf', 'number', 11, many(() => String(Number(cpf()))), 'BR_L1_CPF'),
  col('CPF_CNPJ', 'varchar', 18, many(() => (random() < 0.5 ? cpfFormatted() : cnpjFormatted())), 'BR_L1_CPF'),
  col('CNPJ', 'varchar', 18, many(cnpjFormatted), 'BR_L1_CNPJ'),
  col('CNPJ_FORNECEDOR', 'varchar', 14, many(cnpjLetters), 'BR_L1_CNPJ'),
  col('NR_RG', 'varchar', 12, many(() => `${int(10, 59)}.${int(100, 999)}.${int(100, 999)}-${pick('0123456789X')}`), 'BR_L1_RG'),
  col('RG', 'varchar', 14, many(() => `MG-${int(10, 19)}.${int(100, 999)}.${int(100, 999)}`), 'BR_L1_RG'),
  col('NR_CNH', 'varchar', 11, many(() => digits(11)), 'BR_L1_CNH'),
  col('TITULO_ELEITOR', 'varchar', 12, many(titulo), 'BR_L1_TITULO_ELEITOR'),
  col('NR_PIS', 'varchar', 14, many(() => pis().replace(/(\d{3})(\d{5})(\d{2})(\d)/, '$1.$2.$3-$4')), 'BR_L1_PIS_NIS'),
  col('NIS_TITULAR', 'varchar', 11, many(pis), 'BR_L1_PIS_NIS'),
  col('CTPS', 'varchar', 12, many(() => `${int(1000000, 9999999)}/${int(100, 999)}`), 'BR_L1_CTPS'),
  col('PASSAPORTE', 'varchar', 8, many(() => `F${pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ')}${int(100000, 999999)}`), 'BR_L1_PASSAPORTE'),
  col('RNM', 'varchar', 12, many(() => `V${int(100000, 999999)}-${int(0, 9)}`), 'BR_L1_DOCUMENTO_ESTRANGEIRO'),
  col('MATRICULA_CERTIDAO', 'varchar', 40, many(() => digits(32)), 'BR_L1_CERTIDAO'),
  col('NR_CRM', 'varchar', 14, many(() => `CRM-${pick(['SP', 'RJ', 'MG'])} ${int(10000, 199999)}`), 'BR_L1_REGISTRO_PROFISSIONAL'),
  col('PRIMEIRO_NOME', 'varchar', 30, many(() => pick(GIVEN)), 'BR_L1_NOME'),
  col('SOBRENOME', 'varchar', 60, many(() => `${pick(SURNAMES)} ${pick(SURNAMES)}`), 'BR_L1_SOBRENOME'),
  col('NOME_COMPLETO', 'varchar', 120, many(fullName), 'BR_L1_NOME_COMPLETO'),
  col('NM_CLIENTE', 'varchar', 120, many(fullName), 'BR_L1_NOME_COMPLETO'),
  col('NOME', 'varchar', 120, many(fullName), 'BR_L1_NOME_COMPLETO'),
  col('NOME_MAE', 'varchar', 120, many(fullName), 'BR_L1_NOME_COMPLETO'),
  col('NOME_SOCIAL', 'varchar', 120, many(fullName), 'BR_L1_NOME_COMPLETO'),
  col('DS_EMAIL', 'varchar', 100, many(() => `${fold(pick(GIVEN)).toLowerCase()}.${int(1, 999)}@gmail.com`), 'BR_L1_EMAIL'),
  col('EMAIL', 'varchar', 100, many(() => `contato${int(1, 999)}@empresa.com.br`), 'BR_L1_EMAIL'),
  col('TELEFONE_CELULAR', 'varchar', 20, many(mobile), 'BR_L1_TELEFONE'),
  col('NR_TELEFONE', 'varchar', 16, many(landline), 'BR_L1_TELEFONE'),
  col('LOGRADOURO', 'varchar', 120, many(address), 'BR_L1_ENDERECO'),
  col('ENDERECO', 'varchar', 120, many(address), 'BR_L1_ENDERECO'),
  col('COMPLEMENTO', 'varchar', 30, many(() => `Apto ${int(11, 204)}`), 'BR_L1_ENDERECO_COMPLEMENTO'),
  col('NR_ENDERECO', 'varchar', 6, many(() => String(int(1, 4000))), 'BR_L1_ENDERECO_COMPLEMENTO'),
  col('CONTA_CORRENTE', 'varchar', 12, many(() => `${int(10000, 999999)}-${pick('0123456789X')}`), 'BR_L1_CONTA_BANCARIA'),
  col('AGENCIA', 'varchar', 6, many(() => pad(int(1, 9999), 4)), 'BR_L1_CONTA_BANCARIA'),
  col('NUMERO_CARTAO', 'varchar', 19, many(() => luhn('5', 16)), 'BR_L1_CARTAO'),
  col('CHAVE_PIX', 'varchar', 77, many(() => pick([cpf(), `${fold(pick(GIVEN)).toLowerCase()}@gmail.com`, `+55${int(11, 99)}9${int(10000000, 99999999)}`])), 'BR_L1_CHAVE_PIX'),
  col('IP_ORIGEM', 'varchar', 15, many(() => `${int(1, 223)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`), 'BR_L1_IP'),
  col('MAC_ADDRESS', 'varchar', 17, many(() => many(() => int(0, 255).toString(16).padStart(2, '0'), 6).join(':')), 'BR_L1_DISPOSITIVO'),
  col('IMEI', 'varchar', 15, many(() => luhn('35', 15)), 'BR_L1_DISPOSITIVO'),
  col('PLACA', 'varchar', 8, many(plate), 'BR_L1_PLACA'),
  col('RENAVAM', 'varchar', 11, many(renavam), 'BR_L1_RENAVAM'),
  col('CHASSI', 'varchar', 17, many(() => many(() => pick('ABCDEFGHJKLMNPRSTUVWXYZ0123456789'), 17).join('')), 'BR_L1_CHASSI'),
  col('INSCRICAO_IPTU', 'varchar', 20, many(() => `${int(100, 999)}.${int(100, 999)}.${int(1000, 9999)}-${int(0, 9)}`), 'BR_L1_IMOVEL'),
  col('NR_CONTRATO', 'varchar', 12, many(() => `CT-${int(100000, 999999)}`), 'BR_L1_CONTRATO'),
  col('LOGIN_USUARIO', 'varchar', 30, many(() => `${fold(pick(GIVEN)).toLowerCase()}${int(1, 99)}`), 'BR_L1_USUARIO'),
  col('SENHA_HASH', 'varchar', 60, many(() => `$2a$10$${many(() => pick('abcdefghijklmnopqrstuvwxyz0123456789'), 53).join('')}`), 'BR_L1_CREDENCIAL'),
  col('LATITUDE', 'varchar', 12, many(() => `-23.${int(100000, 999999)}`), 'BR_L1_GEOLOCALIZACAO'),
  col('OBSERVACAO', 'clob', 4000, many(() => `Cliente pediu atualização cadastral. CPF ${cpfFormatted()}, e-mail ${fold(pick(GIVEN)).toLowerCase()}@gmail.com.`), 'BR_L1_TEXTO_LIVRE'),

  // L1 — badly named: only the values can tell
  col('CAMPO1', 'varchar', 14, many(cpfFormatted), 'BR_L1_CPF'),
  col('CAMPO2', 'varchar', 30, many(() => pick(GIVEN)), 'BR_L1_NOME'),
  col('CAMPO3', 'varchar', 30, many(() => pick(SURNAMES)), 'BR_L1_SOBRENOME'),
  col('CAMPO4', 'varchar', 120, many(fullName), 'BR_L1_NOME_COMPLETO'),
  col('CAMPO5', 'varchar', 100, many(() => `${fold(pick(GIVEN)).toLowerCase()}@hotmail.com`), 'BR_L1_EMAIL'),
  col('CAMPO6', 'varchar', 16, many(() => `(${int(11, 99)}) 9${int(1000, 9999)}-${int(1000, 9999)}`), 'BR_L1_TELEFONE'),
  col('CAMPO7', 'varchar', 120, many(address), 'BR_L1_ENDERECO'),
  col('CAMPO8', 'varchar', 19, many(() => luhn('4', 16)), 'BR_L1_CARTAO'),
  col('CAMPO9', 'varchar', 15, many(() => `192.168.${int(0, 255)}.${int(1, 254)}`), 'BR_L1_IP'),
  col('CAMPO10', 'varchar', 8, many(plate), 'BR_L1_PLACA'),
  col('CAMPO11', 'varchar', 18, many(cnpjFormatted), 'BR_L1_CNPJ'),
  col('CAMPO12', 'varchar', 14, many(() => pis().replace(/(\d{3})(\d{5})(\d{2})(\d)/, '$1.$2.$3-$4')), 'BR_L1_PIS_NIS'),
  col('TXT', 'clob', 4000, many(() => `Paciente ${pick(GIVEN)} ${pick(SURNAMES)}, CPF ${cpfFormatted()}, tel (11) 9${int(1000, 9999)}-${int(1000, 9999)}.`), 'BR_L1_TEXTO_LIVRE'),

  // L2
  col('DT_NASCIMENTO', 'date', 0, many(() => iso(1940, 2010)), 'BR_L2_DATA_NASCIMENTO'),
  col('DATA_NASC', 'varchar', 10, many(() => iso(1940, 2010)), 'BR_L2_DATA_NASCIMENTO'),
  col('dataNascimento', 'timestamp', 0, many(() => iso(1940, 2010)), 'BR_L2_DATA_NASCIMENTO'),
  col('ANO_NASCIMENTO', 'number', 4, many(() => String(int(1940, 2010))), 'BR_L2_ANO_NASCIMENTO'),
  col('IDADE', 'number', 3, many(() => String(int(0, 99))), 'BR_L2_IDADE'),
  col('DT_OBITO', 'date', 0, many(() => iso(2000, 2025)), 'BR_L2_DATA_EVENTO'),
  col('DATA_ADMISSAO', 'date', 0, many(() => iso(2000, 2025)), 'BR_L2_DATA_EVENTO'),
  col('SEXO', 'char', 1, many(() => pick(['F', 'M'])), 'BR_L2_SEXO'),
  col('TP_SEXO', 'varchar', 10, many(() => pick(['Feminino', 'Masculino'])), 'BR_L2_SEXO'),
  col('MUNICIPIO', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'BR_L2_MUNICIPIO'),
  col('CIDADE', 'varchar', 60, many(() => pick(['São Paulo', 'Rio de Janeiro', 'Belo Horizonte', 'Salvador', 'Recife', 'Curitiba', 'Porto Alegre'])), 'BR_L2_MUNICIPIO'),
  col('NATURALIDADE', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'BR_L2_MUNICIPIO'),
  col('CAMPO13', 'varchar', 60, many(() => pick(SMALL_NAMES)), 'BR_L2_MUNICIPIO'),
  col('CO_MUNICIPIO_IBGE', 'varchar', 7, many(() => pick(MUNICIPALITIES).code), 'BR_L2_CODIGO_MUNICIPIO'),
  col('ID_MN_RESI', 'varchar', 6, many(() => pick(MUNICIPALITIES).code.slice(0, 6)), 'BR_L2_CODIGO_MUNICIPIO'),
  col('CEP', 'varchar', 9, many(cep), 'BR_L2_CEP'),
  col('NU_CEP', 'number', 8, many(() => String(int(1000000, 99999999))), 'BR_L2_CEP'),
  col('CAMPO14', 'varchar', 9, many(cep), 'BR_L2_CEP'),
  col('BAIRRO', 'varchar', 40, many(() => pick(['Pinheiros', 'Copacabana', 'Boa Viagem', 'Savassi'])), 'BR_L2_BAIRRO'),
  col('ZONA_ELEITORAL', 'number', 4, many(() => String(int(1, 400))), 'BR_L2_ZONA_SECAO_ELEITORAL'),
  col('NACIONALIDADE', 'varchar', 20, many(() => pick(['Brasileira', 'Venezuelana', 'Haitiana', 'Boliviana'])), 'BR_L2_NACIONALIDADE'),
  col('ESTADO_CIVIL', 'varchar', 30, many(() => pick(['Solteiro', 'Casado', 'Divorciado', 'Viúvo'])), 'BR_L2_ESTADO_CIVIL'),
  col('PROFISSAO', 'varchar', 60, many(() => pick(['Professor', 'Motorista', 'Enfermeira'])), 'BR_L2_OCUPACAO'),
  col('CD_CBO', 'varchar', 6, many(() => pick(['521110', '411005', '223505'])), 'BR_L2_OCUPACAO'),
  col('NOME_EMPREGADOR', 'varchar', 80, many(() => `Comércio ${int(1, 99)} Ltda.`), 'BR_L2_EMPREGADOR'),
  col('ESCOLARIDADE', 'varchar', 40, many(() => pick(['Médio completo', 'Superior completo', 'Fundamental incompleto'])), 'BR_L2_ESCOLARIDADE'),
  col('NOME_ESCOLA', 'varchar', 80, many(() => pick(['Escola Estadual Dom Pedro II', 'Colégio Pedro II'])), 'BR_L2_ESCOLA'),
  col('QT_DEPENDENTES', 'number', 2, many(() => String(int(0, 8))), 'BR_L2_DEPENDENTES'),

  // L3
  col('RACA_COR', 'varchar', 12, many(() => pick(['Branca', 'Preta', 'Parda', 'Amarela', 'Indígena'])), 'BR_L3_RACA_COR'),
  col('CS_RACA', 'char', 1, many(() => pick(['1', '2', '3', '4', '5', '9'])), 'BR_L3_RACA_COR'),
  col('CAMPO15', 'varchar', 12, many(() => pick(['Branca', 'Preta', 'Parda', 'Amarela', 'Indígena'])), 'BR_L3_RACA_COR'),
  col('ETNIA', 'varchar', 30, many(() => pick(['Tikúna', 'Guarani Kaiowá', 'Pataxó', 'Terena'])), 'BR_L3_ETNIA'),
  col('QUILOMBOLA', 'char', 1, many(() => pick(['S', 'N'])), 'BR_L3_ETNIA'),
  col('RELIGIAO', 'varchar', 40, many(() => pick(['Católica', 'Evangélica', 'Espírita', 'Sem religião'])), 'BR_L3_RELIGIAO'),
  col('ESCUSA_CONSCIENCIA', 'varchar', 60, many(() => pick(['Serviço militar', 'Nenhuma'])), 'BR_L3_CONVICCAO_ORGANIZACAO'),
  col('INTENCAO_VOTO', 'varchar', 40, many(() => pick(['Esquerda', 'Direita', 'Indeciso'])), 'BR_L3_OPINIAO_POLITICA'),
  col('SG_PARTIDO', 'varchar', 15, many(() => pick(['PT', 'PL', 'MDB', 'PSD', 'UNIÃO', 'PSOL'])), 'BR_L3_FILIACAO_PARTIDARIA'),
  col('SINDICALIZADO', 'char', 1, many(() => pick(['S', 'N'])), 'BR_L3_FILIACAO_SINDICAL'),
  col('CONTRIBUICAO_SINDICAL', 'varchar', 20, many(() => pick(['Sim', 'Não'])), 'BR_L3_FILIACAO_SINDICAL'),
  col('EXAME_DNA', 'varchar', 200, many(() => 'AGTC'.repeat(10)), 'BR_L3_GENETICO'),
  col('TEMPLATE_DIGITAL', 'varchar', 200, many(() => many(() => pick('ABCDEF0123456789'), 64).join('')), 'BR_L3_BIOMETRICO'),
  col('ORIENTACAO_SEXUAL', 'varchar', 30, many(() => pick(['Heterossexual', 'Gay', 'Bissexual'])), 'BR_L3_ORIENTACAO_SEXUAL'),
  col('VIDA_SEXUAL_ATIVA', 'char', 1, many(() => pick(['S', 'N'])), 'BR_L3_VIDA_SEXUAL'),
  col('IDENTIDADE_GENERO', 'varchar', 30, many(() => pick(['Mulher trans', 'Homem cisgênero', 'Não binário'])), 'BR_L3_IDENTIDADE_GENERO'),

  // SAUDE
  col('NU_CNS', 'varchar', 15, many(cns), 'BR_SAUDE_CNS'),
  col('CARTAO_SUS', 'varchar', 15, many(cns), 'BR_SAUDE_CNS'),
  col('NR_PRONTUARIO', 'varchar', 12, many(() => String(int(100000, 9999999))), 'BR_SAUDE_IDENTIFICADOR'),
  col('CID_PRINCIPAL', 'varchar', 6, many(() => pick(['E11.9', 'I10', 'J45.9', 'F32.1'])), 'BR_SAUDE_DIAGNOSTICO'),
  col('CO_CID', 'varchar', 4, many(() => pick(['E119', 'I10', 'F200', 'B20'])), 'BR_SAUDE_DIAGNOSTICO'),
  col('MEDICAMENTO', 'varchar', 40, many(() => pick(['Sertralina', 'Paracetamol', 'Metformina'])), 'BR_SAUDE_MEDICAMENTO'),
  col('ANAMNESE', 'clob', 4000, many(() => `Paciente relata dor abdominal há ${int(1, 9)} dias.`), 'BR_SAUDE_TEXTO_CLINICO'),
  col('RESULTADO_HIV', 'varchar', 12, many(() => pick(['Reagente', 'Não reagente'])), 'BR_SAUDE_RESULTADO_EXAME'),
  col('TIPO_SANGUINEO', 'varchar', 4, many(() => pick(['A+', 'O-', 'AB+'])), 'BR_SAUDE_TIPO_SANGUINEO'),
  col('TIPO_DEFICIENCIA', 'varchar', 40, many(() => pick(['Física', 'Visual', 'Auditiva', 'Nenhuma'])), 'BR_SAUDE_DEFICIENCIA'),
  col('RESULTADO_ASO', 'varchar', 30, many(() => pick(['Apto', 'Inapto'])), 'BR_SAUDE_OCUPACIONAL'),
  col('GESTANTE', 'char', 1, many(() => pick(['S', 'N'])), 'BR_SAUDE_REPRODUTIVA'),
  col('TRANSTORNO_MENTAL', 'varchar', 60, many(() => pick(['Depressão', 'Ansiedade'])), 'BR_SAUDE_MENTAL'),

  // FIN
  col('SCORE_SERASA', 'number', 4, many(() => String(int(0, 1000))), 'BR_FIN_CREDITO'),
  col('NEGATIVADO', 'char', 1, many(() => pick(['S', 'N'])), 'BR_FIN_CREDITO'),
  col('SALDO_DEVEDOR', 'number', 12, many(() => String(int(1000, 90000))), 'BR_FIN_DIVIDA'),
  col('RENDA_MENSAL', 'number', 10, many(() => String(int(1500, 20000))), 'BR_FIN_RENDA'),
  col('VALOR_IMOVEL', 'number', 12, many(() => String(int(80000, 900000))), 'BR_FIN_PATRIMONIO'),
  col('VALOR_APOSENTADORIA', 'number', 8, many(() => String(int(1500, 8000))), 'BR_FIN_VALOR_BENEFICIO'),
  col('ESPECIE_BENEFICIO', 'varchar', 2, many(() => pick(['31', '41', '87', '21'])), 'BR_FIN_BENEFICIO_INSS'),
  col('NR_BENEFICIO', 'varchar', 13, many(() => `${int(100, 999)}.${int(100, 999)}.${int(100, 999)}-${int(0, 9)}`), 'BR_FIN_NUMERO_BENEFICIO'),
  col('BENEFICIARIO_BOLSA_FAMILIA', 'char', 1, many(() => pick(['S', 'N'])), 'BR_FIN_PROGRAMA_SOCIAL'),
  col('FAIXA_RENDA_CADUNICO', 'varchar', 30, many(() => pick(['Extrema pobreza', 'Pobreza', 'Baixa renda'])), 'BR_FIN_FAIXA_RENDA'),
  col('CONDICAO_MORADIA', 'varchar', 30, many(() => pick(['Próprio quitado', 'Alugado', 'Cedido'])), 'BR_FIN_MORADIA'),

  // PENAL
  col('ANTECEDENTES_CRIMINAIS', 'varchar', 30, many(() => pick(['Nada consta', 'Consta registro'])), 'BR_PENAL_ANTECEDENTES'),
  col('NR_PROCESSO', 'varchar', 25, many(() => `${pad(int(1, 9999999), 7)}-${pad(int(0, 99), 2)}.${int(2010, 2025)}.8.26.${pad(int(1, 9999), 4)}`), 'BR_PENAL_PROCESSO'),

  // Not personal data: nothing should be assigned
  col('ID', 'integer', 10, many((i) => String(i + 1)), ''),
  col('CAMINHO_ARQUIVO', 'varchar', 200, many(() => `/dados/arquivo${int(1, 99)}.txt`), ''),
  col('NOME_PRODUTO', 'varchar', 80, many(() => pick(['Leite integral 1L', 'Arroz 5 kg', 'Café torrado 500 g'])), ''),
  col('RAZAO_SOCIAL', 'varchar', 80, many(() => `Comércio ${int(1, 99)} Ltda.`), ''),
  col('VALOR_VENDA', 'number', 12, many(() => String(int(1000, 99999999))), ''),
  col('DT_CADASTRO', 'date', 0, many(() => iso(2015, 2025)), ''),
  col('DATA_EMISSAO_NF', 'date', 0, many(() => iso(2015, 2025)), ''),
  col('CODIGO', 'varchar', 10, many(() => `A-${int(100, 999)}`), ''),
  col('DESCRICAO_PRODUTO', 'varchar', 400, many(() => 'Produto de consumo, embalagem de papelão reciclável.'), ''),
  col('STATUS', 'varchar', 10, many(() => pick(['ATIVO', 'INATIVO'])), ''),
  col('QUANTIDADE', 'number', 6, many(() => String(int(1, 500))), ''),
  col('SKU', 'varchar', 12, many(() => `SKU${int(10000, 99999)}`), ''),
  col('ID_TRANSACAO', 'varchar', 36, many(() => `TX${int(100000, 999999)}`), ''),
  col('DEPARTAMENTO', 'varchar', 40, many(() => pick(['Financeiro', 'Operações'])), ''),
  col('UF', 'char', 2, many(() => pick(['SP', 'RJ', 'MG', 'BA'])), ''),
  col('CD_BANCO', 'varchar', 3, many(() => pick(['001', '237', '341', '104'])), ''),
  col('TARIFA_BANCARIA', 'number', 8, many(() => String(int(1, 99))), ''),
  col('URL_PAGINA', 'varchar', 200, many(() => `https://www.exemplo.com.br/p/${int(1, 999)}`), ''),
  col('TIPO_DOCUMENTO', 'varchar', 20, many(() => pick(['Nota fiscal', 'Boleto'])), ''),
  col('MOEDA', 'varchar', 3, many(() => pick(['BRL', 'USD'])), ''),
  col('CATEGORIA', 'varchar', 30, many(() => pick(['Laticínios', 'Padaria'])), ''),
  col('NCM', 'varchar', 8, many(() => String(int(10000000, 99999999))), ''),
  col('CFOP', 'varchar', 4, many(() => pick(['5102', '6102', '5405'])), ''),
  col('CHAVE_NFE', 'varchar', 44, many(() => digits(44)), ''),
  col('IDIOMA', 'varchar', 5, many(() => pick(['pt-BR', 'en', 'es'])), ''),
  col('VALOR_PADRAO', 'varchar', 20, many(() => pick(['0', 'N/A', 'true'])), ''),
  col('ORDEM', 'number', 4, many(() => String(int(1, 99))), ''),
  col('SITUACAO', 'varchar', 10, many(() => pick(['Novo', 'Usado'])), ''),
  col('STATUS_PEDIDO', 'varchar', 10, many(() => pick(['Aberto', 'Fechado', 'Pendente'])), ''),
  col('ID_MENSAGEM', 'varchar', 36, many(() => `MSG${int(100000, 999999)}`), ''),
  col('DT_FIM', 'date', 0, many(() => iso(2015, 2025)), ''),
  col('NOME_ARQUIVO', 'varchar', 60, many(() => `relatorio_${int(1, 99)}.pdf`), ''),
  col('PESO_FRETE_KG', 'number', 6, many(() => `${int(1, 99)}.5`), ''),
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

// ── Municipalities, offline ─────────────────────────────────────────────────
//
// Every municipality of under 20,000 inhabitants must become one of at least 20,000 of the same state
// when written with its state; by its name alone, unless the name is shared with a large one.

function verifyGeneralization() {
  const table = new Map(fs.readFileSync(nodePath.join(HERE, 'files', 'br-municipios-generalizados.txt'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('|')))
  const codes = new Map(fs.readFileSync(nodePath.join(HERE, 'files', 'br-codigos-municipio-generalizados.txt'), 'utf8').split('\n').filter(Boolean).map((l) => l.split(',')))
  const byCode = new Map(MUNICIPALITIES.map((m) => [m.code, m]))
  const byNameUf = new Map(MUNICIPALITIES.map((m) => [`${m.name}/${m.uf}`, m]))
  // Names that differ only in accents or case are the same line in a table that also lists them without accents.
  const key = (n) => fold(n).toLowerCase()
  const byName = new Map()
  for (const m of MUNICIPALITIES) for (const n of new Set([m.name, m.alias].filter(Boolean).map(key))) byName.set(n, [...(byName.get(n) ?? []), m])
  let ok = 0
  let shared = 0
  for (const m of MUNICIPALITIES) {
    const problems = []
    const withUf = table.get(`${m.name}/${m.uf}`)
    const code = codes.get(m.code)
    if (m.population >= 20000) {
      if (withUf || table.has(m.name) || code) problems.push('a large municipality is generalized')
    } else {
      const target = withUf && byNameUf.get(withUf)
      if (!target) problems.push(`with its state: ${withUf ?? 'not in the table'}`)
      else if (target.population < 20000 || target.uf !== m.uf) problems.push(`became ${withUf}`)
      const byCodeTarget = code && byCode.get(code)
      if (!byCodeTarget || byCodeTarget.name !== target?.name || byCodeTarget.uf !== m.uf) problems.push(`code ${m.code} → ${code}`)
      if (codes.get(m.code.slice(0, 6)) !== code?.slice(0, 6)) problems.push('six-digit code')
      const homonyms = byName.get(key(m.name))
      if (homonyms.length > 1) shared++
      const alone = table.get(m.name)
      const withLarge = homonyms.some((x) => x.population >= 20000)
      if (withLarge) { if (alone) problems.push('a name shared with a large municipality is generalized') }
      else if (!alone || !(byName.get(key(alone)) ?? []).some((x) => x.population >= 20000)) problems.push(`by name: ${alone ?? 'not in the table'}`)
      for (const variant of [...(withLarge ? [] : [m.name.toUpperCase()]), `${m.name.toUpperCase()} - ${m.uf}`]) if (!table.has(variant) && !table.has(fold(variant))) problems.push(`no line for ${variant}`)
    }
    if (problems.length) { failures++; console.log(`  ✗ ${m.name}/${m.uf} (${m.population}): ${problems.join('; ')}`) }
    else ok++
  }
  console.log(`municipalities: ${ok} of ${MUNICIPALITIES.length} generalized as expected (${shared} small ones share a name)`)
}

// ── Algorithms ──────────────────────────────────────────────────────────────

const words = (s) => s.trim().split(/\s+/).length
const sameShape = (i, o) => i.length === o.length && i.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9') === o.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9')
const digitShape = (i, o) => i.length === o.length && i.replace(/\d/g, '9') === o.replace(/\d/g, '9')
const MASKING = {
  BR_L1_CPF: {
    inputs: ['529.982.247-25', '52998224725', '11144477735', '1234567890', '191', '11.222.333/0001-81', '12ABC34501DE35', '012345678-90', ...many(cpf, 10)],
    // Formats stay; a CPF comes out a valid CPF (a short number padded to eleven digits), a CNPJ a valid CNPJ.
    check: (i, o) => (/^\d{3,10}$/.test(i) ? validCpf(o) && o.length === 11
      : i.replace(/[.\-/]/g, '').length === 14 ? validCnpj(o) && sameShape(i.replace(/[A-Z]/g, '9'), o.replace(/[A-Z]/g, '9'))
        : validCpf(o) && digitShape(i, o)),
  },
  BR_L1_CNPJ: {
    inputs: ['11.222.333/0001-81', '11222333000181', '12.ABC.345/01DE-35', '00.000.000/E08G-12', '12ABC34501DE35', '191000191', ...many(cnpj, 5), ...many(cnpjLetters, 5)],
    check: (i, o) => validCnpj(o) && (/^\d{3,13}$/.test(i) ? o.length === 14 : o.length === i.length && o.replace(/[.\-/]/g, '').slice(8, 12) === i.replace(/[.\-/]/g, '').slice(8, 12)),
  },
  BR_L1_RG: { inputs: ['12.345.678-X', 'MG-12.345.678', '123456789'], check: (i, o) => i.length === o.length && i.replace(/\d/g, '') === o.replace(/\d/g, '') },
  BR_L1_CNH: { inputs: ['02650306461'], check: digitShape },
  BR_L1_TITULO_ELEITOR: {
    inputs: ['004356870906', '102385010671', '4356870906', '10238501067', ...many(titulo, 10)],
    // The state stays; the check digits are valid, including the São Paulo and Minas Gerais rule.
    check: (i, o) => validTitulo(o) && o.length === 12 && o.slice(8, 10) === i.padStart(12, '0').slice(8, 10),
  },
  BR_L1_PIS_NIS: { inputs: ['120.56412.54-7', '12056412547', '1205641254', ...many(pis, 8)], check: (i, o) => validPis(o) && o[0] === i.padStart(11, '0')[0] },
  BR_L1_CTPS: { inputs: ['1234567/001'], check: sameShape },
  BR_L1_PASSAPORTE: { inputs: ['FZ123456'], check: sameShape },
  BR_L1_DOCUMENTO_ESTRANGEIRO: { inputs: ['V123456-7'], check: sameShape },
  BR_L1_CERTIDAO: { inputs: ['10453901552013100012021000012321'], check: digitShape },
  BR_L1_REGISTRO_PROFISSIONAL: { inputs: ['CRM-SP 123456', 'OAB/RJ 98765', '54321'], check: (i, o) => digitShape(i, o) && o.replace(/\d/g, '') === i.replace(/\d/g, '') },
  // Four words fall through to the Character Mapping: it must mask them, not act as a name lookup.
  BR_L1_NOME: { inputs: ['Maria', 'JOÃO PEDRO', 'Maria de Fátima', 'Ana Maria Clara Luiza'], check: (i, o) => words(i) === words(o) && (!/ de /.test(i) || / de /.test(o)) },
  BR_L1_SOBRENOME: { inputs: ['Silva', 'DOS SANTOS', 'Oliveira Souza', 'da Silva Júnior'], check: (i, o) => words(i) === words(o) && (!/Júnior/.test(i) || /Júnior$/.test(o)) },
  BR_L1_NOME_COMPLETO: {
    inputs: ['José Silva', 'MARIA DA SILVA', 'Ana Paula Souza Lima', 'José Carlos da Silva Júnior', 'Francisco Pereira Neto', 'Silva, Maria'],
    check: (i, o) => words(i) === words(o) && [' da ', ' de ', ' dos ', 'Júnior', 'Neto'].every((w) => i.includes(w) === o.includes(w)),
  },
  BR_L1_EMAIL: { inputs: ['maria.silva@gmail.com', 'joão.núñez@empresa.com.br'], check: (i, o) => /@[^@]+\.test$/.test(o) },
  BR_L1_TELEFONE: {
    inputs: ['(11) 98765-4321', '11987654321', '+55 21 3456-7890', '+5561998765432', '98765-4321', '3456-7890', '(011) 3456-7890'],
    // Country code, DDD and the first digit stay; the length does too.
    check: (i, o) => o.length === i.length && o.slice(0, i.length - 8).replace(/\d$/, '') === i.slice(0, i.length - 8).replace(/\d$/, ''),
  },
  BR_L1_ENDERECO: { inputs: ['Av. Paulista, 1578, 12º andar - Bela Vista', 'Rua das Laranjeiras, 45'] },
  BR_L1_ENDERECO_COMPLEMENTO: { inputs: ['Apto 42 Bloco B', '1578'] },
  BR_L1_CONTA_BANCARIA: { inputs: ['12345-X', '0001'], check: (i, o) => i.length === o.length && i.replace(/\d/g, '') === o.replace(/\d/g, '') },
  BR_L1_CARTAO: { inputs: ['5162 3062 1937 8829'] },
  BR_L1_CHAVE_PIX: {
    inputs: ['529.982.247-25', 'maria.silva@gmail.com', '+5511987654321', '123e4567-e89b-12d3-a456-426614174000'],
    check: (i, o) => (i.includes('@') ? o.endsWith('.test') : /^\d{3}\./.test(i) ? validCpf(o) : sameShape(i, o)),
  },
  BR_L1_IP: {
    inputs: ['200.147.67.142', '2804:14c::1'],
    check: (i, o) => (i.includes('.') ? o.split('.').every((p) => Number(p) >= 1 && Number(p) <= 254) : /^[0-9a-f:]+$/i.test(o)),
  },
  BR_L1_DISPOSITIVO: { inputs: ['3c:22:fb:9a:10:e4', '356938035643809'], check: (i, o) => (i.includes(':') ? /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(o) : /^\d{15}$/.test(o)) },
  BR_L1_PLACA: { inputs: ['BRA2E19', 'ABC-1234', 'abc1d23'], check: sameShape },
  BR_L1_RENAVAM: { inputs: ['00639884962', '639884962', ...many(renavam, 5)], check: (i, o) => validPis(o) && o.length === 11 },
  BR_L1_CHASSI: { inputs: ['9BWZZZ377VT004251'], check: sameShape },
  BR_L1_IMOVEL: { inputs: ['123.456.7890-1'], check: digitShape },
  BR_L1_CONTRATO: { inputs: ['CT-123456'] },
  BR_L1_USUARIO: { inputs: ['@maria_silva'] },
  BR_L1_CREDENCIAL: { inputs: ['Senha#2024'], check: (i, o) => /^X+$/.test(o) },
  BR_L1_GEOLOCALIZACAO: { inputs: ['-23.561414', '-23.561414,-46.655881'], check: (i, o) => o.slice(0, 5) === i.slice(0, 5) },
  BR_L1_TEXTO_LIVRE: {
    inputs: ['Cliente Souza, CPF 529.982.247-25, e-mail m.souza@gmail.com, tel (11) 98765-4321, CEP 01310-100.'],
    check: (i, o) => !/529\.982\.247-25|m\.souza@gmail\.com|98765-4321|Souza|01310-100/.test(o),
  },
  BR_L2_DATA_NASCIMENTO: { inputs: ['1985-07-20', '2014-01-15'], check: (i, o) => Math.abs(new Date(o.slice(0, 10)) - new Date(i)) <= 60 * 864e5 },
  BR_L2_ANO_NASCIMENTO: { inputs: ['1985'], check: (i, o) => o.startsWith('198'), same: true },
  BR_L2_IDADE: { inputs: ['37', '7', '104'], check: (i, o) => (i === '104' ? o === '90' : i.length === 1 || o[0] === i[0]), same: true },
  BR_L2_DATA_EVENTO: { inputs: ['2021-03-15'] },
  BR_L2_SEXO: { inputs: ['F', 'M', 'Feminino', 'masculino', 'Homem', '1'], same: true },
  BR_L2_MUNICIPIO: { inputs: ['Monteiro Lobato', 'Campinas', 'SERRA DA SAUDADE', 'Borá - SP', 'Bonito/MS', 'Santa Luzia'], same: true },
  BR_L2_CODIGO_MUNICIPIO: { inputs: ['3531209', '353120', '3509502'], same: true },
  BR_L2_CEP: { inputs: ['01310-100', '1310100', '70.040-010'], check: (i, o) => o.length === i.length && /000$/.test(o) && o.slice(0, 2) === i.slice(0, 2), same: true },
  BR_L2_BAIRRO: { inputs: ['Vila Madalena'], same: true },
  BR_L2_ZONA_SECAO_ELEITORAL: { inputs: ['0245'], check: digitShape },
  BR_L2_NACIONALIDADE: { inputs: ['Senegalesa'], same: true },
  BR_L2_ESTADO_CIVIL: { inputs: ['Separado judicialmente', '2'], same: true },
  BR_L2_OCUPACAO: { inputs: ['Coordenadora de operações regionais', '223510', '2235-10'] },
  BR_L2_EMPREGADOR: { inputs: ['Petróleo Brasileiro S.A.'] },
  BR_L2_ESCOLARIDADE: { inputs: ['Pós-doutorado', '07'], same: true },
  BR_L2_ESCOLA: { inputs: ['Escola Estadual Doutor Arnaldo'] },
  BR_L2_DEPENDENTES: { inputs: ['9', '2'], check: (i, o) => Number(o) <= 5, same: true },
  BR_L3_RACA_COR: { inputs: ['Morena', '3', 'Parda'], same: true },
  BR_L3_ETNIA: { inputs: ['Krenak', 'S'], same: true },
  BR_L3_RELIGIAO: { inputs: ['Adventista do Sétimo Dia', 'N'], same: true },
  BR_L3_CONVICCAO_ORGANIZACAO: { inputs: ['Recusa transfusão de sangue'] },
  BR_L3_OPINIAO_POLITICA: { inputs: ['Conservador'], same: true },
  BR_L3_FILIACAO_PARTIDARIA: { inputs: ['Partido Trabalhista Brasileiro', 'PT', '13', 'S'], same: true },
  BR_L3_FILIACAO_SINDICAL: { inputs: ['Sindicato dos Bancários de SP', 'S'], same: true },
  BR_L3_GENETICO: { inputs: ['BRCA1 positivo'] },
  BR_L3_BIOMETRICO: { inputs: ['A1B2C3D4E5F6'] },
  BR_L3_ORIENTACAO_SEXUAL: { inputs: ['Homossexual'], same: true },
  BR_L3_VIDA_SEXUAL: { inputs: ['Ativa'] },
  BR_L3_IDENTIDADE_GENERO: { inputs: ['Transgênero'], same: true },
  BR_SAUDE_CNS: {
    inputs: ['898001234567890', ...many(cns, 10)],
    // A definitive CNS stays valid and carries the masked PIS; a provisional one keeps its shape.
    check: (i, o) => (/^[12]/.test(i) ? validCns(o) && /^[12]/.test(o) : digitShape(i, o) && o[0] === i[0]),
  },
  BR_SAUDE_IDENTIFICADOR: { inputs: ['PRONT-2024-00123'] },
  BR_SAUDE_DIAGNOSTICO: { inputs: ['F33.1', 'B20', 'E119', 'Depressão maior'], same: true },
  BR_SAUDE_MEDICAMENTO: { inputs: ['Sertralina 50 mg'] },
  BR_SAUDE_TEXTO_CLINICO: { inputs: ['Paciente Souza, CPF 529.982.247-25, atendido por cefaleia.'], check: (i, o) => !o.includes('529.982.247-25') },
  BR_SAUDE_RESULTADO_EXAME: { inputs: ['Reagente'] },
  BR_SAUDE_TIPO_SANGUINEO: { inputs: ['O+'], same: true },
  BR_SAUDE_DEFICIENCIA: { inputs: ['Transtorno do espectro autista', 'N'], same: true },
  BR_SAUDE_OCUPACIONAL: { inputs: ['Inapto temporariamente', 'S'], same: true },
  BR_SAUDE_REPRODUTIVA: { inputs: ['12 semanas de gestação', 'S'], same: true },
  BR_SAUDE_MENTAL: { inputs: ['Transtorno bipolar'] },
  BR_FIN_CREDITO: { inputs: ['Negativado no Serasa', '745', 'N'], same: true },
  BR_FIN_DIVIDA: { inputs: ['8500'] },
  BR_FIN_RENDA: { inputs: ['3200', '3200.50'] },
  BR_FIN_PATRIMONIO: { inputs: ['185000'] },
  BR_FIN_VALOR_BENEFICIO: { inputs: ['1800'] },
  BR_FIN_BENEFICIO_INSS: { inputs: ['Auxílio-reclusão', '31'], same: true },
  BR_FIN_NUMERO_BENEFICIO: { inputs: ['123.456.789-0'], check: digitShape },
  BR_FIN_PROGRAMA_SOCIAL: { inputs: ['Auxílio Brasil', 'S'], same: true },
  BR_FIN_FAIXA_RENDA: { inputs: ['Extrema pobreza', '3', 'Decil 8', 'Quintil 2', 'Classe C1'], same: true },
  BR_FIN_MORADIA: { inputs: ['Invasão'], same: true },
  BR_PENAL_ANTECEDENTES: { inputs: ['Condenado por furto em 2019', 'S'], same: true },
  BR_PENAL_PROCESSO: { inputs: ['0001234-56.2023.8.26.0100', 'BO 1234/2024'], check: (i, o) => sameShape(i, o) && (!/\.2023\.8\.26\.0100$/.test(i) || o.endsWith('.2023.8.26.0100')) },
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
const SUPPRESSED = 'Não informado'
const LARGE = new Set(LARGE_NAMES.map((n) => n.toLowerCase()))
const EXPECT = {
  BR_L1_NOME: (i, o) => words(i) > 3 || o.split(/\s+/).every((w) => /^(de|da|do|dos|das|e)$/i.test(w) || has('br-nomes.txt', w)),
  BR_L1_SOBRENOME: (i, o) => o.split(/\s+/).every((w) => /^(de|da|do|dos|das|e|júnior)$/i.test(w) || has('br-sobrenomes.txt', w)),
  BR_L1_NOME_COMPLETO: (i, o) => i.includes(',') || (has('br-nomes.txt', o.split(/\s+/)[0]) && (/Júnior|Neto$/.test(o) || has('br-sobrenomes.txt', o.split(/\s+/).at(-1)))),
  BR_L1_ENDERECO: (i, o) => has('br-enderecos.txt', o),
  BR_L2_SEXO: (i, o) => ({ f: ['f', 'm'], m: ['f', 'm'], feminino: ['feminino', 'masculino'], masculino: ['feminino', 'masculino'], homem: ['mulher', 'homem'], 1: ['1', '2'] })[i.toLowerCase()].includes(o.toLowerCase()),
  // Monteiro Lobato and Serra da Saudade become a municipality of 20,000 or more of their state;
  // Campinas stays; Borá keeps the state written after it; Santa Luzia is also a large municipality
  // (MG) and stays.
  BR_L2_MUNICIPIO: (i, o) => ({ Campinas: o === 'Campinas', 'Santa Luzia': o === 'Santa Luzia', 'Borá - SP': / - SP$/.test(o) && LARGE.has(o.slice(0, -5).toLowerCase()), 'Bonito/MS': /\/MS$/.test(o) && LARGE.has(o.slice(0, -3).toLowerCase()) })[i] ?? LARGE.has(o.toLowerCase()),
  BR_L2_CODIGO_MUNICIPIO: (i, o) => (i === '3509502' ? o === i : o.slice(0, 2) === '35' && o !== i),
  BR_L2_BAIRRO: (i, o) => has('br-bairros.txt', o),
  BR_L2_NACIONALIDADE: (i, o) => has('br-nacionalidades.txt', o),
  BR_L2_ESTADO_CIVIL: (i, o) => (/^\d$/.test(i) ? /^[1-5]$/.test(o) : has('br-estado-civil.txt', o)),
  BR_L2_OCUPACAO: (i, o) => (/^\d{6}$/.test(i) ? has('br-cbo.txt', o) : /-/.test(i) ? /^\d{4}-\d{2}$/.test(o) : has('br-ocupacoes.txt', o)),
  BR_L2_EMPREGADOR: (i, o) => has('br-empregadores.txt', o),
  BR_L2_ESCOLARIDADE: (i, o) => (/^\d+$/.test(i) ? has('br-escolaridade-codigos.txt', o) : has('br-escolaridade.txt', o)),
  BR_L2_ESCOLA: (i, o) => has('br-escolas.txt', o),
  BR_L3_RACA_COR: (i, o) => (/^\d$/.test(i) ? has('br-raca-cor-codigos.txt', o) : has('br-raca-cor.txt', o)),
  BR_L3_ETNIA: (i, o) => flag(i, o) ?? has('br-etnias.txt', o),
  BR_L3_RELIGIAO: (i, o) => flag(i, o) ?? has('br-religioes.txt', o),
  BR_L3_CONVICCAO_ORGANIZACAO: (i, o) => o === SUPPRESSED,
  BR_L3_OPINIAO_POLITICA: (i, o) => has('br-opinioes-politicas.txt', o),
  BR_L3_FILIACAO_PARTIDARIA: (i, o) => flag(i, o) ?? (/^\d+$/.test(i) ? has('br-partidos-numeros.txt', o) : /^[A-Z]+$/.test(i) ? has('br-partidos-siglas.txt', o) : has('br-partidos-nomes.txt', o)),
  BR_L3_FILIACAO_SINDICAL: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  BR_L3_ORIENTACAO_SEXUAL: (i, o) => has('br-orientacoes-sexuais.txt', o),
  BR_L3_VIDA_SEXUAL: (i, o) => o === SUPPRESSED,
  BR_L3_IDENTIDADE_GENERO: (i, o) => has('br-identidades-genero.txt', o),
  BR_SAUDE_DIAGNOSTICO: (i, o) => (/\.\d/.test(i) ? has('br-cid10-decimal.txt', o) : /^[A-Z]\d{2,3}$/i.test(i) ? has('br-cid10.txt', o) : has('br-diagnosticos.txt', o)),
  BR_SAUDE_MEDICAMENTO: (i, o) => has('br-medicamentos.txt', o),
  BR_SAUDE_TIPO_SANGUINEO: (i, o) => has('br-tipos-sanguineos.txt', o),
  BR_SAUDE_DEFICIENCIA: (i, o) => flag(i, o) ?? has('br-deficiencias.txt', o),
  BR_SAUDE_OCUPACIONAL: (i, o) => flag(i, o) ?? has('br-aptidao.txt', o),
  BR_SAUDE_REPRODUTIVA: (i, o) => flag(i, o) ?? o === SUPPRESSED,
  BR_SAUDE_MENTAL: (i, o) => o === SUPPRESSED,
  BR_FIN_CREDITO: (i, o) => flag(i, o) ?? (/^\d{3}$/.test(i) ? /^\d{3}$/.test(o) : has('br-situacoes-credito.txt', o)),
  BR_FIN_BENEFICIO_INSS: (i, o) => (/^\d+$/.test(i) ? has('br-beneficios-inss-codigos.txt', o) : has('br-beneficios-inss.txt', o)),
  BR_FIN_PROGRAMA_SOCIAL: (i, o) => flag(i, o) ?? has('br-programas-sociais.txt', o),
  BR_FIN_FAIXA_RENDA: (i, o) => (/^\d$/.test(i) ? /^[1-5]$/.test(o) : /^decil/i.test(i) ? /^Decil ([1-9]|10)$/.test(o) : /^quintil/i.test(i) ? /^Quintil [1-5]$/.test(o) : /^classe/i.test(i) ? /^Classe (A|B1|B2|C1|C2|DE)$/.test(o) : has('br-faixas-cadunico.txt', o)),
  BR_FIN_MORADIA: (i, o) => has('br-condicoes-moradia.txt', o),
  BR_PENAL_ANTECEDENTES: (i, o) => flag(i, o) ?? has('br-antecedentes.txt', o),
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
  // Every algorithm masks its own sample input, which is what the tester opens it with.
  for (const a of preset.algorithms) {
    if (a.input === undefined) { failures++; console.log(`  ✗ ${a.name} has no sample input`) }
    else jobs.push({ domain: { name: a.name, algorithm: a.name }, input: a.input, sample: true })
  }
  // Real columns hold placeholders too. Masking them may change them or not, but must not fail —
  // except in typed columns (dates, amounts), where the database would not hold them.
  const TYPED = new Set(['BR_L2_DATA_NASCIMENTO', 'BR_L2_DATA_EVENTO', 'BR_FIN_DIVIDA', 'BR_FIN_RENDA', 'BR_FIN_PATRIMONIO', 'BR_FIN_VALOR_BENEFICIO'])
  for (const d of preset.domains.filter((x) => !TYPED.has(x.name))) {
    for (const input of ['N/I', 'não informado', '-']) jobs.push({ domain: d, input, placeholder: true })
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

  // Keys must stay keys: 150 distinct inputs give 150 distinct outputs, all valid.
  const keys = [
    ['CPF', 'BR_CPF', cpf, validCpf], ['CNPJ', 'BR_CNPJ', cnpjLetters, validCnpj], ['PIS', 'BR_PIS', pis, validPis],
    ['título', 'BR_TITULO', titulo, validTitulo], ['CNS', 'BR_CNS', cns, validCns], ['RENAVAM', 'BR_RENAVAM', renavam, validPis],
  ]
  for (const [label, algorithmName, make, valid] of keys) {
    const inputs = [...new Set(many(make, 150))]
    const outputs = new Set()
    let invalid = 0
    let next2 = 0
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (next2 < inputs.length) {
        const { output } = await run(algorithmName, inputs[next2++])
        outputs.add(output)
        if (!output || !valid(output)) invalid++
      }
    }))
    if (outputs.size !== inputs.length || invalid) { failures++; console.log(`  ✗ ${label}: ${inputs.length} inputs gave ${outputs.size} distinct outputs, ${invalid} invalid`) }
    else console.log(`${label}: ${inputs.length} distinct inputs, ${outputs.size} distinct valid outputs`)
  }

  // A definitive CNS is the PIS followed by a tail: masked, it still starts with the masked PIS.
  let agree = 0
  const people = many(pis, 20)
  for (const p of people) {
    const [a, b] = await Promise.all([run('BR_PIS', p), run('BR_CNS', cnsFromPis(p))])
    if (a.output && b.output && b.output.startsWith(a.output)) agree++
  }
  if (agree !== people.length) { failures++; console.log(`  ✗ PIS and CNS agree for ${agree} of ${people.length} people`) }
  else console.log(`PIS and CNS of the same person agree: ${agree} of ${people.length}`)
}

if (only !== 'algorithms') { verifyClassifiers(); verifyGeneralization() }
if (only !== 'classifiers') await verifyAlgorithms()
console.log(failures ? `\n${failures} problem(s)` : '\nall good')
process.exit(failures ? 1 : 0)
