#!/usr/bin/env node
/**
 * Builds the Brazil (LGPD, Lei 13.709/2018) pre-configured profile set: preset.json and files/.
 *
 *   node presets/brazil-lgpd/build.mjs
 *
 * source/ holds the hand-kept lists — given names and surnames from the 2022 census ranking, streets,
 * neighbourhoods — and the 5,570 municipalities with their IBGE code, state, location and 2022
 * census population. Everything in files/ and preset.json is generated from them and from the
 * definitions below — edit here, then build, then run verify.mjs.
 *
 * Structure of the set
 *   L1     direct identifiers      CPF and CNPJ with valid check digits, RG, CNH, voter card, PIS,
 *                                  names, contact, address, bank details, PIX key, vehicles…
 *   L2     quasi-identifiers       birth date, age, sex, municipality, CEP, neighbourhood…
 *   L3     sensitive data          art. 5, II: racial or ethnic origin, religious conviction,
 *                                  political opinion, trade union or religious, philosophical or
 *                                  political organization, sexual life, genetic and biometric data
 *   SAUDE  health data             art. 5, II and art. 11: health identifiers (CNS), ICD-10…
 *   FIN    financial data          bank secrecy (LC 105/2001), credit (art. 7, X; Lei 12.414/2011),
 *                                  social benefits
 *   PENAL  criminal records and court cases
 */
import fs from 'node:fs'
import nodePath from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = nodePath.dirname(fileURLToPath(import.meta.url))
const SOURCE = nodePath.join(HERE, 'source')
const FILES = nodePath.join(HERE, 'files')

// ── Helpers ─────────────────────────────────────────────────────────────────

const readLines = (name) => fs.readFileSync(nodePath.join(SOURCE, name), 'utf8')
  .split('\n').map((s) => s.trim()).filter(Boolean)
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC')
const unique = (values) => [...new Set(values)]
/** A detection list also finds values written without accents. */
const withFolded = (values) => unique(values.flatMap((v) => [v, fold(v)]))

const files = new Map()
function file(name, values) {
  const lines = unique(values)
  if (files.has(name) && files.get(name).join('\n') !== lines.join('\n')) throw new Error(`${name} defined twice`)
  files.set(name, lines)
  return `preset-file://${name}`
}

const algorithms = []
function algorithm(name, framework, config, input) {
  if (algorithms.some((a) => a.name === name)) throw new Error(`algorithm ${name} defined twice`)
  algorithms.push({ name, framework: `algorithm.plugin.${framework}`, config, ...(input === undefined ? {} : { input }) })
  return name
}
const use = (name) => ({ name })
const keep = { type: 'PRESERVE' }
const apply = (name) => ({ type: 'APPLY_ALGORITHM', algorithm: use(name) })
const redactAs = (text) => ({ type: 'REDACT', redactString: text })

/** Regex Decompose: each pattern is [regex, ...one action per capture group]. */
function decompose(name, patterns, fallback, input) {
  for (const [regex, ...actions] of patterns) {
    const groups = new RegExp(`${regex.replace(/^\(\?i\)/, '')}|`).exec('').length - 1
    if (groups !== actions.length) throw new Error(`${name}: ${regex} has ${groups} groups and ${actions.length} actions`)
  }
  return algorithm(name, 'decompose.RegexDecompose', {
    maskPatterns: patterns.map(([regex, ...actions]) => ({ regex, actions })),
    fallbackAction: fallback,
    trimInput: true,
    requireMask: false,
  }, input)
}

// Every algorithm carries a sample input: the tester opens it with that value. A lookup nested in
// another algorithm defaults to the first value of its own list.
function lookup(name, fileName, values, input = values[0], caseMode = 'PRESERVE_INPUT') {
  return algorithm(name, 'secureLookup.SecureLookup', {
    lookupFile: { uri: file(fileName, values) },
    hashMethod: 'SHA256',
    maskedValueCase: caseMode,
    inputCaseSensitive: false,
    trimWhitespaceFromInput: true,
    trimWhitespaceInLookupFile: true,
  }, input)
}

/** Data Cleansing: exact replacement of whole values, from [from, to] pairs. */
function cleansing(name, fileName, pairs, input, delimiter = ',') {
  for (const [from, to] of pairs) if (from.includes(delimiter) || to.includes(delimiter)) throw new Error(`${fileName}: "${from}" holds the delimiter`)
  return algorithm(name, 'dataCleansing.DataCleansing', {
    lookupFile: { uri: file(fileName, pairs.map(([from, to]) => `${from}${delimiter}${to}`)) },
    delimiter, caseSensitive: true, trimWhitespace: true,
  }, input)
}

/** String Algorithm Chain. Delphix allows eight algorithms per chain, so longer ones are nested. */
function chain(name, steps, input) {
  if (steps.length <= 8) return algorithm(name, 'stringAlgorithmChain.StringAlgorithmChain', { algorithmReferences: steps.map(use) }, input)
  const parts = []
  for (let i = 0; i < steps.length; i += 8) parts.push(chain(`${name}_${parts.length + 1}`, steps.slice(i, i + 8)))
  return chain(name, parts, input)
}

/**
 * Check Digit, modulus 11, the check digit last. Brazilian documents write a remainder of 0 or 1 as
 * the digit 0, which is what the framework does. `body` masks what comes before the digit;
 * `preserveRegex` keeps the separators out of the computation, and PAD_LEFT restores the zeros a
 * numeric column dropped.
 */
function checkDigit(name, weights, body, { pad = false, letters = false, input } = {}) {
  return algorithm(name, 'checkdigit.Checkdigit', {
    weightList: weights, modulusNumber: 11,
    checkDigitIndex: weights.length, numDigitsForCheckdigitCalculation: weights.length,
    calculateChecksumRightToLeft: false,
    numericAlgorithm: use(body), alphaNumericAlgorithm: use(body),
    preserveRegex: String.raw`[.\-/]`,
    inputHandlingConfig: {
      characterHandling: letters ? 'ASCII_VALUE_MINUS_48' : 'STANDARD',
      invalidInputHandling: 'ERROR', shortInputHandling: pad ? 'PAD_LEFT' : 'FALLBACK', padCharacter: '0', trimWhitespace: true,
    },
  }, input)
}

/**
 * A check digit Check Digit cannot compute — the voter card's and the CNS's. The masked body arrives
 * with a placeholder where the check digits go, and a running sum travels through the value two
 * digits at a time, each step one Data Cleansing table:
 *   first step   c1 c2              → c1 c2 s
 *   next steps   s c3 c4            → c3 c4 s'
 *   last step    s cn… placeholder  → finish(s, cn…)
 * `chunks` lists the positions each step reads (0-based, in the body), `contribution` what a digit
 * adds to the sum at its position, and `finish` writes the last characters with the check digits.
 */
function checksum(name, fileStem, { chunks, contribution, modulus, marker, finish, alphabet = [...'0123456789'] }) {
  const symbol = (s) => '0123456789ABCDEFGHIJ'[s]
  const sums = [...Array(modulus).keys()]
  const combos = (n) => [...Array(n)].reduce((found) => found.flatMap((prefix) => alphabet.map((c) => prefix + c)), [''])
  const add = (s, positions, chars) => positions.reduce((total, p, i) => (total + contribution(p, Number(chars[i]))) % modulus, s)
  const steps = []
  let read = 0
  chunks.forEach((positions, k) => {
    const first = k === 0
    const last = k === chunks.length - 1
    const pairs = first
      ? combos(positions.length).map((chars) => [chars, `${chars}${symbol(add(0, positions, chars))}`])
      : sums.flatMap((s) => combos(positions.length).map((chars) => (last
        ? [`${symbol(s)}${chars}${marker}`, finish(s, chars)]
        : [`${symbol(s)}${chars}`, `${chars}${symbol(add(s, positions, chars))}`])))
    const table = cleansing(`${name}_T${k + 1}`, `${fileStem}-${k + 1}.txt`, pairs, pairs[0][0])
    const width = positions.length + (first ? 0 : 1) + (last ? marker.length : 0)
    steps.push(decompose(`${name}_P${k + 1}`, [[`(.{${read}})(.{${width}})(.*)`, keep, apply(table), keep]], keep, pairs[0][0]))
    read += positions.length
  })
  return steps
}

const domains = []
const classifiers = []
function domain(name, algorithmName, ...detect) {
  if (!algorithms.some((a) => a.name === algorithmName)) throw new Error(`${name}: no algorithm ${algorithmName}`)
  domains.push({ name, algorithm: algorithmName })
  for (const make of detect) classifiers.push(make(name))
}

/** Column names: alternatives that must not be glued to other letters (digits and _ are fine). */
const words = (alternatives) => String.raw`(?i)(?<![a-z])(?:${alternatives})(?![a-z])`

const byName = (...rules) => (d) => ({
  name: `${d} - Path`, framework: 'PATH', domain: d,
  description: 'Nome da coluna (e variantes usadas em sistemas brasileiros).',
  config: {
    paths: rules.map(([alternatives, strength]) => ({
      matchType: 'REGEX', fieldValue: words(alternatives), parentValue: '',
      matchStrength: strength, caseSensitive: false, allowPartialMatch: true,
    })),
    rejectStrength: 0,
  },
})

const byType = (...allowed) => (d) => ({
  name: `${d} - Type`, framework: 'TYPE', domain: d,
  description: 'Descarta colunas cujo tipo não pode conter este dado.',
  config: { allowedTypes: allowed, matchAutoIncrementingColumn: false, matchStrength: 0, rejectStrength: 1 },
})

/** Values: [regex, strength, { checksum, clean, note }]. Whole value unless `partial`. */
const byPattern = (rules, { reject = 0.3, partial = false } = {}) => (d) => ({
  name: `${d} - Regex`, framework: 'REGEX', domain: d,
  description: 'Formato dos valores.',
  config: {
    dataPatterns: rules.map(([regex, strength, extra = {}]) => ({
      ...(extra.note ? { note: extra.note } : {}),
      regex, matchStrength: strength,
      checksumType: extra.checksum ?? 'NONE',
      caseSensitive: false, allowPartialMatch: partial,
      dataCleanRegex: extra.clean ?? '',
    })),
    rejectStrength: reject,
  },
})

/** Values found in lists: [fileName, values, strength]. */
const byList = (lists, { reject = 0.3, tokenize = false } = {}) => (d) => ({
  name: `${d} - List`, framework: 'LIST', domain: d,
  description: 'Valores conhecidos.',
  config: {
    valueLists: lists.map(([fileName, values, strength]) => ({ file: file(fileName, withFolded(values)), matchStrength: strength })),
    tokenizeInput: tokenize,
    rejectStrength: reject,
    tokenizationDelimiter: ' ',
  },
})

const STRING = (min = 0, max = 0) => ({ typeName: 'String', ...(min ? { minimumLength: min } : {}), ...(max ? { maximumLength: max } : {}) })
const NUMBER = (min = 0, max = 0) => ({ typeName: 'Number', ...(min ? { minimumLength: min } : {}), ...(max ? { maximumLength: max } : {}) })
// A TIMESTAMP is not a Date to the profiler: only its SQL code lets a TYPE classifier accept it.
const DATES = [{ typeName: 'Date' }, { typeName: 'JavaSqlType', sqlType: 93 }]

// Deterministic pseudo-random numbers, so a rebuild writes the same files.
function seeded(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── Source lists ────────────────────────────────────────────────────────────

const GIVEN_NAMES = unique(readLines('nomes.txt'))
const SURNAMES = unique(readLines('sobrenomes.txt'))

const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO']
const MUNICIPALITIES = readLines('municipios.tsv').map((line) => {
  const [code, name, uf, lat, lon, population, alias] = line.split('\t')
  return { code, name, uf, lat: Number(lat), lon: Number(lon), population: Number(population), alias: alias || null }
})
if (MUNICIPALITIES.length !== 5570) throw new Error(`expected the 5,570 municipalities of the 2022 census, found ${MUNICIPALITIES.length}`)
for (const m of MUNICIPALITIES) if (!UFS.includes(m.uf) || !/^\d{7}$/.test(m.code)) throw new Error(`${m.name}: bad state or code`)

// ── Shared algorithms ───────────────────────────────────────────────────────

// Vowels map to vowels and consonants to consonants, so a masked document number keeps its
// structure; digits map to digits. Separators are in no group and stay. minMaskedPositions 0 lets
// a placeholder such as "N/I" through instead of failing the row.
algorithm('BR_CM_ALFANUM', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'AEIOU', 'BCDFGHJKLMNPQRSTVWXYZ', 'aeiou', 'bcdfghjklmnpqrstvwxyz', 'ÁÉÍÓÚÂÊÔÃÕÀ', 'áéíóúâêôãõà'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, 'MG-12.345.678')
// Digits only: the letters of an RG (the check digit X, the issuing body SSP/SP) stay.
algorithm('BR_CM_DIGITOS', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '12.345.678-X')
// Digits and upper-case letters, one group each: a CNPJ root keeps where it has letters.
algorithm('BR_CM_DIGITOS_LETRAS', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '12ABC345')
// Hex letters form their own group, so a MAC, UUID or IPv6 stays valid hex.
algorithm('BR_CM_HEX', 'characterMapping.CharacterMapping', {
  characterGroups: ['0123456789', 'abcdef', 'ABCDEF', 'ghijklmnopqrstuvwxyz', 'GHIJKLMNOPQRSTUVWXYZ'],
  caseSensitive: true,
  minMaskedPositions: 0,
}, '3c:22:fb:9a:10:e4')
decompose('BR_REDIGIR', [['(.+)', { type: 'REDACT', redactCharacter: 'X' }]], keep, 'senha123')
lookup('BR_SUPRIMIR', 'br-nao-informado.txt', ['Não informado'], 'Transtorno depressivo recorrente', 'PRESERVE_LOOKUP_FILE')

// Yes/no columns keep their vocabulary: a CHAR(1) S/N stays S/N.
decompose('BR_FLAG', [
  ['(?i)(sim|n[aã]o)', apply(lookup('BR_FLAG_SIM_NAO', 'br-flag-sim-nao.txt', ['Sim', 'Não']))],
  ['(?i)(true|false)', apply(lookup('BR_FLAG_TRUE_FALSE', 'br-flag-true-false.txt', ['true', 'false']))],
  ['(?i)(yes|no)', apply(lookup('BR_FLAG_YES_NO', 'br-flag-yes-no.txt', ['Yes', 'No']))],
  ['(?i)([sn])', apply(lookup('BR_FLAG_S_N', 'br-flag-s-n.txt', ['S', 'N']))],
  ['(?i)([yn])', apply(lookup('BR_FLAG_Y_N', 'br-flag-y-n.txt', ['Y', 'N']))],
  ['([01])', apply(lookup('BR_FLAG_0_1', 'br-flag-0-1.txt', ['0', '1']))],
], keep, 'S')

const FLAG = String.raw`(?i)(sim|n[aã]o|true|false|yes|no|[sny01])`
/**
 * A categorical attribute: flags stay flags, numeric codes are replaced by another code of `codes`
 * (or get other digits), and any other value is replaced by one from `values` — or suppressed, when
 * no list is given.
 */
function categorical(name, fileName, values, input, codes) {
  const replacement = values ? lookup(`${name}_LISTA`, fileName, values) : 'BR_SUPRIMIR'
  const code = codes ? apply(lookup(`${name}_CODIGO`, fileName.replace(/\.txt$/, '-codigos.txt'), codes)) : apply('BR_CM_ALFANUM')
  return decompose(name, [[FLAG, apply('BR_FLAG')], [String.raw`(\d{1,6})`, code]], apply(replacement), input)
}
categorical('BR_CATEGORIA_SUPRIMIDA', null, null, 'Transtorno depressivo recorrente')
const CM = apply('BR_CM_ALFANUM')
const DIGITS = apply('BR_CM_DIGITOS')

// ── L1 · CPF and CNPJ ───────────────────────────────────────────────────────
//
// CPF: nine digits and two check digits, modulus 11 with weights 10 to 2 and then 11 to 2 over the
// first check digit too; a remainder of 0 or 1 gives 0. The ninth digit is the tax region that
// issued it. Two Check Digit algorithms, one inside the other: the outer one hands the ten first
// digits to the inner one, which hands the nine first to a Character Mapping, recomputes the first
// check digit, and the outer recomputes the second. One-to-one, valid, format kept.
//
// CNPJ: an eight-character root, a four-character establishment order (0001 is the head office)
// and two check digits, weights 5 to 2 and 9 to 2. Since July 2026 root and order may hold letters
// (Instrução Normativa RFB 2.229/2024), weighed as their ASCII code minus 48 — which is Check
// Digit's ASCII_VALUE_MINUS_48. The root is masked, the order kept (the branches of a company stay
// branches of one company), and both check digits recomputed.

checkDigit('BR_CPF_DV1', [10, 9, 8, 7, 6, 5, 4, 3, 2], 'BR_CM_DIGITOS', { input: '5299822472' })
checkDigit('BR_CPF_VALIDO', [11, 10, 9, 8, 7, 6, 5, 4, 3, 2], 'BR_CPF_DV1', { input: '529.982.247-25' })
checkDigit('BR_CPF_VALIDO_ZEROS', [11, 10, 9, 8, 7, 6, 5, 4, 3, 2], 'BR_CPF_DV1', { pad: true, input: '1234567890' })

decompose('BR_CNPJ_RAIZ', [
  [String.raw`([0-9A-Z]{2}\.?[0-9A-Z]{3}\.?[0-9A-Z]{3})(/?[0-9A-Z]{4})`, apply('BR_CM_DIGITOS_LETRAS'), keep],
], keep, '11.222.333/0001')
checkDigit('BR_CNPJ_DV1', [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], 'BR_CNPJ_RAIZ', { letters: true, input: '11.222.333/0001-8' })
checkDigit('BR_CNPJ_VALIDO', [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], 'BR_CNPJ_DV1', { letters: true, input: '11.222.333/0001-81' })
checkDigit('BR_CNPJ_VALIDO_ZEROS', [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], 'BR_CNPJ_DV1', { letters: true, pad: true, input: '191000191' })

const CPF_FORMATTED = String.raw`\d{3}\.\d{3}\.\d{3}-\d{2}`
const CNPJ_FORMATTED = String.raw`[0-9A-Z]{2}\.[0-9A-Z]{3}\.[0-9A-Z]{3}/[0-9A-Z]{4}-\d{2}`
// A column holds CPFs, CNPJs or both ("CPF_CNPJ"): each value goes by its shape. Numbers stored in
// a numeric column lose their leading zeros: up to ten digits are a CPF, twelve or thirteen a CNPJ.
decompose('BR_CPF', [
  [String.raw`(\d{3}\.?\d{3}\.?\d{3}-?\d{2})`, apply('BR_CPF_VALIDO')],
  [String.raw`(\d{3,10})`, apply('BR_CPF_VALIDO_ZEROS')],
  [`(${CNPJ_FORMATTED})`, apply('BR_CNPJ_VALIDO')],
  [String.raw`([0-9A-Z]{12}\d{2})`, apply('BR_CNPJ_VALIDO')],
  [String.raw`(\d{12,13})`, apply('BR_CNPJ_VALIDO_ZEROS')],
], DIGITS, '529.982.247-25')
// In a CNPJ column, a short number is a CNPJ that lost its zeros.
decompose('BR_CNPJ', [
  [`(${CNPJ_FORMATTED})`, apply('BR_CNPJ_VALIDO')],
  [String.raw`([0-9A-Z]{12}\d{2})`, apply('BR_CNPJ_VALIDO')],
  [String.raw`(\d{3}\.\d{3}\.\d{3}-\d{2}|\d{9}-\d{2})`, apply('BR_CPF_VALIDO')],
  [String.raw`(\d{3,13})`, apply('BR_CNPJ_VALIDO_ZEROS')],
], DIGITS, '12.ABC.345/01DE-35')

const CPF_COLUMN = 'cpf[a-z0-9_]*|c_?p_?f|n(r|u|um|o|ro|umero)_?cpf|cpf_?(cnpj|cgc)|cadastro_?(de_?)?pessoas?_?fisicas?|documento_?fiscal|(cliente|cli|clie|pessoa|pes|func|funcionario|colaborador|servidor|empregado|segurado|beneficiario|benef|titular|dependente|paciente|aluno|contribuinte|responsavel|resp|socio|motorista|condutor|tomador|devedor|avalista|fiador|consumidor|comprador|eleitor|candidato|usuario)_?cpf'
domain('BR_L1_CPF', 'BR_CPF',
  byName([CPF_COLUMN, 0.9], ['tax_?id|taxpayer_?id|documento_?(cliente|pessoa)|doc_?(cliente|pessoa)|nr_?documento|num_?documento|numero_?documento|n(r|u)_?doc', 0.55]),
  byType(STRING(3), NUMBER(3)),
  // Eleven bare digits are also a mobile phone, a PIS, a CNH or a RENAVAM: they back up the column
  // name but decide nothing alone.
  byPattern([
    [CPF_FORMATTED, 1],
    [String.raw`\d{11}`, 0.5],
  ], { reject: 0.3 }))

domain('BR_L1_CNPJ', 'BR_CNPJ',
  byName(['cnpj[a-z0-9_]*|c_?n_?p_?j|cgc|n(r|u|um|o|ro|umero)_?cnpj|cadastro_?nacional_?(da_?)?pessoa_?juridica|(empresa|emp|fornecedor|forn|cliente|cli|empregador|estabelecimento|estab|prestador|tomador|emitente|emissor|destinatario|dest|transportadora|operadora|mei|matriz|filial)_?cnpj', 0.9]),
  byType(STRING(3), NUMBER(3)),
  byPattern([
    [CNPJ_FORMATTED, 1],
    [String.raw`[0-9A-Z]{12}\d{2}`, 0.6],
  ], { reject: 0.3 }))

// ── L1 · Identity documents ─────────────────────────────────────────────────
//
// RG: issued by each state's identification institute, with its own format and, in some states, a
// check digit written X. Digits are mapped, letters and separators stay. The Carteira de Identidade
// Nacional (Decreto 10.977/2022) uses the CPF as its number and falls under the CPF domain.

domain('BR_L1_RG', 'BR_CM_DIGITOS',
  byName(
    ['rg[a-z0-9_]*|r_?g|n(r|u|um|o|ro|umero)_?rg|registro_?geral|carteira_?(de_?)?identidade|cedula_?(de_?)?identidade|identidade(?!_?(genero|visual|de_?genero))|doc_?identidade|documento_?(de_?)?identidade|ci_?(numero|num|nr)|rg_?(cliente|pessoa|func|titular|dependente|mae|pai|responsavel|segurado)|(cliente|pessoa|func|titular|responsavel)_?rg|identity_?(card|document|no|number)|id_?card', 0.9],
  ),
  byPattern([
    [String.raw`\d{1,2}\.\d{3}\.\d{3}-[\dxX]`, 0.7],
    [String.raw`[A-Z]{2}-?\d{1,2}\.?\d{3}\.?\d{3}`, 0.6],
  ], { reject: 0.3 }))

// CNH: the registration number has eleven digits and two check digits whose second depends on
// whether the first overflowed — a rule Check Digit cannot follow. Digits are mapped.
domain('BR_L1_CNH', 'BR_CM_ALFANUM',
  byName(['cnh[a-z0-9_]*|c_?n_?h|carteira_?(nacional_?)?(de_?)?habilitacao|habilitacao(_?(numero|num|nr|registro))?|registro_?cnh|n(r|u|um|o|ro|umero)_?(registro_?)?cnh|renach|pgu|permissao_?(para_?)?dirigir|drivers?_?licen[cs]e(_?(no|num|number))?', 0.9]))

// Título de eleitor: eight sequential digits, two for the state (01 SP … 28 abroad) and two check
// digits: the first is the sum of the sequence weighed 2 to 9, modulus 11; the second weighs the
// state and the first check digit by 7, 8 and 9. A remainder of 10 gives 0; in São Paulo and Minas
// Gerais a remainder of 0 gives 1. The state stays, the sequence is mapped, both digits recomputed.
const TITULO_UF = (uf) => uf === '01' || uf === '02'
const tituloDv = (r, uf) => (r === 10 ? 0 : r === 0 && TITULO_UF(uf) ? 1 : r)
decompose('BR_TITULO_CORPO', [[String.raw`(\d{8})(\d{2})(\d{2})`, DIGITS, keep, redactAs('00')]], keep, '004356870906')
chain('BR_TITULO_DV', checksum('BR_TITULO_DV', 'br-titulo-dv', {
  chunks: [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9]],
  modulus: 11, marker: '00',
  contribution: (p, d) => d * (2 + p),
  finish: (s, uf) => {
    const dv1 = tituloDv(s, uf)
    const dv2 = tituloDv((Number(uf[0]) * 7 + Number(uf[1]) * 8 + dv1 * 9) % 11, uf)
    return `${uf}${dv1}${dv2}`
  },
}), '004356870900')
chain('BR_TITULO_VALIDO', ['BR_TITULO_CORPO', 'BR_TITULO_DV'], '004356870906')
// A numeric column drops the leading zeros: they come back before the computation.
const padZeros = (name, n, input) => decompose(name, [[`(\\d)(\\d{${11 - n}})`, apply(cleansing(`${name}_TABELA`, `br-zeros-${n}.txt`, [...'0123456789'].map((d) => [d, `${'0'.repeat(n)}${d}`]), '4')), keep]], keep, input)
chain('BR_TITULO_VALIDO_1_ZERO', [padZeros('BR_TITULO_1_ZERO', 1, '10238501067'), 'BR_TITULO_VALIDO'], '10238501067')
chain('BR_TITULO_VALIDO_2_ZEROS', [padZeros('BR_TITULO_2_ZEROS', 2, '4356870906'), 'BR_TITULO_VALIDO'], '4356870906')
decompose('BR_TITULO', [
  [String.raw`(\d{12})`, apply('BR_TITULO_VALIDO')],
  [String.raw`(\d{11})`, apply('BR_TITULO_VALIDO_1_ZERO')],
  [String.raw`(\d{10})`, apply('BR_TITULO_VALIDO_2_ZEROS')],
], DIGITS, '1023 8501 0671')
domain('BR_L1_TITULO_ELEITOR', 'BR_TITULO',
  byName(['titulo_?(de_?)?eleitor(_?(numero|num|nr))?|titulo_?eleitoral|tit_?eleitor|n(r|u|um|o|ro|umero)_?titulo(_?eleitor)?|inscricao_?eleitoral|voter_?(id|card|registration)', 0.9]),
  byPattern([[String.raw`\d{4}\s?\d{4}\s?\d{4}`, 0.4]], { reject: 0.3 }))

// PIS, PASEP, NIT and NIS share one number: ten digits and a check digit with weights 3 2 9 8 7 6 5 4
// 3 2. The first digit stays (it tells PIS from PASEP and NIT), the others are mapped.
decompose('BR_PIS_CORPO', [[String.raw`(\d)(.*)`, keep, DIGITS]], keep, '1205641254')
checkDigit('BR_PIS_VALIDO', [3, 2, 9, 8, 7, 6, 5, 4, 3, 2], 'BR_PIS_CORPO', { input: '120.56412.54-7' })
checkDigit('BR_PIS_VALIDO_ZEROS', [3, 2, 9, 8, 7, 6, 5, 4, 3, 2], 'BR_PIS_CORPO', { pad: true, input: '1205641254' })
decompose('BR_PIS', [
  [String.raw`(\d{3}\.?\d{5}\.?\d{2}-?\d)`, apply('BR_PIS_VALIDO')],
  [String.raw`(\d{9,10})`, apply('BR_PIS_VALIDO_ZEROS')],
], DIGITS, '120.56412.54-7')
domain('BR_L1_PIS_NIS', 'BR_PIS',
  byName(['pis[a-z0-9_]*|pasep|pis_?pasep|nit|nis|n(r|u|um|o|ro|umero)_?(pis|nit|nis|pasep)|nis_?(titular|responsavel|beneficiario)|numero_?identificacao_?(do_?)?trabalhador|inscricao_?(inss|previdencia)|nit_?(inss|contribuinte)', 0.9]),
  byPattern([[String.raw`\d{3}\.\d{5}\.\d{2}-\d`, 0.9], [String.raw`\d{11}`, 0.5]], { reject: 0.3 }))

domain('BR_L1_CTPS', 'BR_CM_ALFANUM',
  byName(['ctps[a-z0-9_]*|carteira_?(de_?)?trabalho|serie_?ctps|n(r|u|um|o|ro|umero)_?ctps|work_?permit', 0.9]))

domain('BR_L1_PASSAPORTE', 'BR_CM_ALFANUM',
  byName(['passaporte[a-z0-9_]*|passport[a-z0-9_]*|n(r|u|um|o|ro|umero)_?passaporte|pasaporte', 0.9]),
  byPattern([[String.raw`[A-Z]{2}\d{6}`, 0.4]], { reject: 0.3 }))

// Foreigners: the Registro Nacional Migratório (RNM, formerly RNE), the refugee protocol, the visa.
domain('BR_L1_DOCUMENTO_ESTRANGEIRO', 'BR_CM_ALFANUM',
  byName(['rnm|crnm|rne|registro_?nacional_?(migratorio|estrangeiro)|carteira_?(de_?)?registro_?(nacional_?)?migratorio|protocolo_?(de_?)?refugio|refugiado_?(protocolo|numero)|visto(_?(numero|num|nr))?|n(r|u|um|o|ro|umero)_?visto|visa_?(no|number)|dpri', 0.85]))

// Birth, marriage and death certificates: the national registration number (matrícula) has 32
// digits — registry office, book, page, entry and two check digits.
domain('BR_L1_CERTIDAO', 'BR_CM_ALFANUM',
  byName(['certidao_?(de_?)?(nascimento|casamento|obito)(_?(numero|num|nr|matricula))?|matricula_?(da_?)?certidao|certidao_?matricula|termo_?(de_?)?nascimento|registro_?(de_?)?nascimento|livro_?folha_?termo|dnv|declaracao_?(de_?)?nascido_?vivo|declaracao_?(de_?)?obito|n(r|u)_?(dnv|do)', 0.85]),
  byPattern([[String.raw`\d{6}\s?\d{2}\s?\d{2}\s?\d{4}\s?\d\s?\d{5}\s?\d{3}\s?\d{7}\s?\d{2}`, 0.8]], { reject: 0.3 }))

// Professional registrations (CRM, OAB, CREA, COREN…): public registers that name the person.
decompose('BR_REGISTRO_PROFISSIONAL', [
  [String.raw`(?i)([A-Z]{2,6}\s*[-/]?\s*[A-Z]{2}\s*[-/]?\s*)(\d[\d.\-]*)(.*)`, keep, DIGITS, keep],
  [String.raw`(\d[\d.\-]*)(\s*[-/]?\s*[A-Za-z]{2})`, DIGITS, keep],
], DIGITS, 'CRM-SP 123456')
domain('BR_L1_REGISTRO_PROFISSIONAL', 'BR_REGISTRO_PROFISSIONAL',
  byName(['crm|cro|crp|crf|crn|crefito|coren|crea|cau|crc|oab|cress|crmv|cfm|conselho_?(de_?)?classe(_?(numero|num|nr))?|registro_?(profissional|conselho|de_?classe)|n(r|u|um|o|ro|umero)_?(crm|oab|crea|coren|cro|crp|conselho|registro_?profissional)|inscricao_?(oab|crm|crea|conselho)', 0.85]))

// ── L1 · Names ──────────────────────────────────────────────────────────────

const NOT_A_PERSON = 'produto|prod|item|artigo|empresa|emp|fantasia|razao|social|comercial|arquivo|arq|rua|logradouro|lograd|bairro|municipio|mun|cidade|estado|uf|pais|banco|agencia|plano|campanha|projeto|servico|tabela|coluna|campo|usuario|host|servidor|dominio|marca|modelo|categoria|tipo|escola|colegio|instituicao|curso|disciplina|materia|documento|doc|centro|unidade|clinica|hospital|area|departamento|depto|setor|cargo|funcao|sistema|app|aplicacao|grupo|lista|relatorio|processo|evento|tarefa|perfil|papel|classe|objeto|conta|medicamento|remedio|diagnostico|estudo|programa|beneficio|partido|sindicato|religiao|etnia|povo|idioma|lingua|lugar|local|loja|fornecedor|forn|convenio|contrato|apolice|seguradora|operadora|org|organizacao|orgao|entidade|parametro|variavel|metodo|indice|job|script|fila|recurso|rede|dispositivo|template|imagem|foto|pagina|site|modulo|menu|opcao|acao|permissao|imposto|tributo|moeda|emissor|nota|fatura|boleto|pagamento|formulario|zona|rota|linha|predio|edificio|tela|chave|tag|rotulo|titulo|codigo|config|empregador|imovel|filial|matriz|loja|evento|exame|procedimento|vacina|turma|sala|equipe|time|projeto|natureza|motivo|situacao|status|fase|etapa|origem|destino|canal|campanha|arquivo|anexo|file|table|column|field|user|server|product|company|brand|category|type|school|course|document|department|system|group|report|role|account|drug|place|store|supplier|contract|policy|device|image|page|module|action|key|label|code|org|entity|project|city|country|street|bank'
const PERSON_ROLE = 'cliente|cli|paciente|pac|funcionario|func|empregado|colaborador|servidor|segurado|beneficiario|benef|titular|dependente|dep|mae|pai|responsavel|resp|conjuge|companheiro|contato|avalista|fiador|devedor|tomador|requerente|solicitante|testemunha|representante|procurador|proprietario|locatario|locador|inquilino|vitima|reu|autor|acusado|investigado|doador|herdeiro|pessoa|pes|motorista|condutor|cidadao|eleitor|contribuinte|aluno|estudante|crianca|medico|enfermeiro|professor|socio|tutor|curador|pagador|favorecido|destinatario|remetente|candidato|associado|membro|cooperado|consumidor|comprador|corretor|interessado|parte|advogado|usuario|atendente|vendedor|gerente|supervisor|avo|filho|filha|irmao|parente|customer|patient|employee|member|holder|mother|father|spouse|contact|person|student|driver|owner'
const PARTICLES = String.raw`(?i)(d[aeo]s?|e|di|del|della|van|von|der|du|le|la)`
// Detection lists count the particles and agnomes as words of a name.
const NAME_WORDS = ['da', 'de', 'do', 'das', 'dos', 'e', 'Júnior', 'Junior', 'Jr', 'Filho', 'Neto', 'Sobrinho']
const AGNOMES = String.raw`(?i)(j[uú]nior|jr\.?|filho|filha|neto|neta|sobrinho|segundo|terceiro)`

algorithm('BR_NOME', 'name.Name', {
  lookupFile: { uri: file('br-nomes.txt', GIVEN_NAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Maria')
algorithm('BR_SOBRENOME', 'name.Name', {
  lookupFile: { uri: file('br-sobrenomes.txt', SURNAMES) },
  maskedValueCase: 'PRESERVE_INPUT', filterAccent: true, inputCaseSensitive: false,
}, 'Silva')
// A word of a name. "da", "de", "dos" and "e" stay where they are, and so do the agnomes Júnior,
// Filho, Neto and Sobrinho, which are part of the name but identify no one.
decompose('BR_PALAVRA_NOME', [[PARTICLES, keep], [AGNOMES, keep]], apply('BR_NOME'), 'Conceição')
decompose('BR_PALAVRA_SOBRENOME', [[PARTICLES, keep], [AGNOMES, keep]], apply('BR_SOBRENOME'), 'Nascimento')
const N = apply('BR_PALAVRA_NOME')
const S = apply('BR_PALAVRA_SOBRENOME')

decompose('BR_NOMES', [
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, N],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, N, N],
], CM, 'Maria de Fátima')
decompose('BR_SOBRENOMES', [
  [String.raw`(\S+)`, S],
  [String.raw`(\S+)\s+(\S+)`, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, S, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, S, S, S, S],
], CM, 'da Silva Santos')
// Brazilian order: given names, then the mother's and the father's family names. Two words are a
// given name and a surname; three, one given name and two surnames ("Maria da Silva" too); from four
// on, two given names and the rest surnames. SURNAMES, GIVEN NAMES with a comma, as in lists.
decompose('BR_NOME_COMPLETO', [
  [String.raw`([^,]+),\s*(.+)`, apply('BR_SOBRENOMES'), apply('BR_NOMES')],
  [String.raw`(\S+)`, N],
  [String.raw`(\S+)\s+(\S+)`, N, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)`, N, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, S, S, S],
  [String.raw`(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`, N, N, S, S, S, S],
], CM, 'José Carlos da Silva Júnior')

domain('BR_L1_NOME', 'BR_NOMES',
  byName(
    ['primeiro_?nome|prenome|nome_?proprio|nomes?_?(de_?)?batismo|nome_?1|first_?names?|given_?names?|fname|middle_?names?', 0.85],
    [`nome(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|social|civil|sobrenome|ultimo|abreviado|reduzido|guerra|usuario))|nm(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}))|name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))`, 0.5],
  ),
  byList([['br-detectar-nomes.txt', [...GIVEN_NAMES, ...NAME_WORDS], 0.7]], { tokenize: true, reject: 0.3 }))

domain('BR_L1_SOBRENOME', 'BR_SOBRENOMES',
  byName(['sobrenomes?|ultimo_?nome|nome_?(de_?)?familia|last_?names?|surnames?|family_?names?|lname|apelido_?familia|sobrenome_?(pai|mae|paterno|materno|solteira|casada)|nome_?(de_?)?solteira|sobrenome_?(de_?)?casada', 0.85]),
  byList([['br-detectar-sobrenomes.txt', [...SURNAMES, ...NAME_WORDS], 0.7]], { tokenize: true, reject: 0.3 }))

domain('BR_L1_NOME_COMPLETO', 'BR_NOME_COMPLETO',
  byName(
    [`nome_?(completo|compl|civil|social|registro|guerra|abreviado)|nomecompleto|(nm|no|nome|ds)_?(${PERSON_ROLE})|(${PERSON_ROLE})_?(nome|nm)|nome_?(d[aoe]_?)?(${PERSON_ROLE})|filiacao(_?[12])?|full_?name|person_?name`, 0.9],
    ['mae|pai|genitora?|conjuge|responsavel_?legal|representante_?legal|procurador|avalista|fiador|testemunha|beneficiario|herdeiro|curador|tutor|titular', 0.6],
    // A bare NOME holds a given name or a full name: the values decide between the two domains.
    [`nome(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|completo|social|civil|sobrenome|ultimo|abreviado|reduzido|guerra|usuario))|nm(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}))|name(?!_?(${NOT_A_PERSON}|${PERSON_ROLE}|full|complete|last|first))`, 0.5],
  ),
  byList([['br-detectar-nomes.txt', [...GIVEN_NAMES, ...NAME_WORDS], 0.6], ['br-detectar-sobrenomes.txt', [...SURNAMES, ...NAME_WORDS], 0.6]], { tokenize: true, reject: 0.3 }))

// ── L1 · Contact ────────────────────────────────────────────────────────────

decompose('BR_EMAIL', [
  // The top-level domain becomes .test, reserved for tests: a masked address can never deliver.
  [String.raw`([^@\s]+)@([^@\s]+)\.([A-Za-z]{2,24}(?:\.[A-Za-z]{2})?)`, CM, CM, redactAs('test')],
], CM, 'maria.silva@gmail.com.br')
domain('BR_L1_EMAIL', 'BR_EMAIL',
  byName(['e_?mail[a-z0-9_]*|mail[a-z0-9_]*|correio_?eletronico|endereco_?eletronico|(ds|de|tx)_?email', 0.85]),
  byType(STRING(5)),
  byPattern([[String.raw`[A-Za-z0-9._%+'\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}`, 1]], { reject: 0.2 }))

// Country code 55, a two-digit area code (DDD), then eight digits for a landline (first digit 2 to 5)
// or nine for a mobile (first digit 9). Country code, DDD and the first digit stay — the DDD covers a
// whole region —, the rest is masked with separators and length.
const DDD = String.raw`(\+?55\s?)?(\(?0?\d{2}\)?\s?)`
decompose('BR_TELEFONE', [
  [`${DDD}(9)(\\d{4})([\\s\\-]?)(\\d{4})`, keep, keep, keep, DIGITS, keep, DIGITS],
  [`${DDD}([2-5])(\\d{3})([\\s\\-]?)(\\d{4})`, keep, keep, keep, DIGITS, keep, DIGITS],
  [String.raw`(9)(\d{4})([\s\-]?)(\d{4})`, keep, DIGITS, keep, DIGITS],
  [String.raw`([2-5])(\d{3})([\s\-]?)(\d{4})`, keep, DIGITS, keep, DIGITS],
], DIGITS, '(11) 98765-4321')
domain('BR_L1_TELEFONE', 'BR_TELEFONE',
  byName(['tel|telefone[a-z0-9_]*|fone[a-z0-9_]*|celular[a-z0-9_]*|cel|movel|whats_?app|zap|contato_?(tel|telefone|celular)|(nr|nu|num|numero|ds|tx)_?(tel|telefone|fone|celular|cel)|ddd_?(tel|telefone|celular|fone)|fax|ramal|phone[a-z0-9_]*|mobile[a-z0-9_]*', 0.85]),
  byPattern([
    [String.raw`(\+?55\s?)?\(?0?[1-9]\d\)?\s?9\d{4}[\s\-]?\d{4}`, 1],
    [String.raw`(\+?55\s?)?\(?0?[1-9]\d\)?\s?[2-5]\d{3}[\s\-]?\d{4}`, 0.8],
    [String.raw`9\d{4}-\d{4}`, 0.8],
  ], { reject: 0.3 }))

// Brazilian addresses: street type and name, number, complement, neighbourhood. A whole address line
// becomes a fictitious one.
const STREETS = readLines('logradouros.txt')
const NEIGHBOURHOODS = readLines('bairros.txt')
lookup('BR_ENDERECO', 'br-enderecos.txt', (() => {
  const random = seeded(13709)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const out = new Set()
  while (out.size < 4000) {
    const r = random()
    const number = 1 + Math.floor(random() * 2500)
    if (r < 0.4) out.add(`${pick(STREETS)}, ${number}`)
    else if (r < 0.65) out.add(`${pick(STREETS)}, ${number}, Apto ${1 + Math.floor(random() * 20)}${Math.floor(random() * 4) + 1}`)
    else if (r < 0.85) out.add(`${pick(STREETS)}, ${number} - ${pick(NEIGHBOURHOODS)}`)
    else if (r < 0.93) out.add(`${pick(STREETS)}, ${number}, Casa ${1 + Math.floor(random() * 4)} - ${pick(NEIGHBOURHOODS)}`)
    else out.add(`Rodovia ${pick(['BR-116', 'BR-101', 'BR-040', 'BR-381', 'BR-153', 'SP-330', 'RS-020', 'PR-445'])}, km ${1 + Math.floor(random() * 400)}`)
  }
  return [...out]
})(), 'Av. Paulista, 1578, 12º andar - Bela Vista', 'PRESERVE_LOOKUP_FILE')
const STREET_TYPES = 'rua|r\\.|avenida|av\\.?|travessa|tv\\.?|alameda|al\\.|estrada|est\\.|rodovia|rod\\.|praca|praça|pc\\.|largo|viela|servidao|quadra|qd\\.?|setor|conjunto|beco|ladeira|vila'
domain('BR_L1_ENDERECO', 'BR_ENDERECO',
  byName(['(?<!(mac|ip|e_?mail|web|url|eletronico)_?)endereco(?!_?(ip|mac|email|e_?mail|eletronico|web|url|tipo|id|cobranca_?id))[a-z0-9_]*|(?<!(mac|ip|e_?mail|web|url)_?)end_?(residencial|comercial|cobranca|entrega|correspondencia|completo)|logradouro[a-z0-9_]*|lograd|(ds|no|nm|tx)_?(logradouro|endereco|rua)|rua|residencia|domicilio[a-z0-9_]*|(?<!(mac|ip|e_?mail|web|url)_?)address(?!_?(ip|mac|email|e_?mail|web|url|type|id))[a-z0-9_]*|street(_?(address|name))?', 0.8]),
  byType(STRING(6)),
  byPattern([
    [`(?i)(${STREET_TYPES})\\s+.+`, 0.8],
    [String.raw`(?i).*,\s*\d+.*`, 0.3],
  ], { reject: 0.2 }))

domain('BR_L1_ENDERECO_COMPLEMENTO', 'BR_CM_ALFANUM',
  byName(['complemento(_?endereco)?|compl|n(r|u|um|o|ro|umero)_?(endereco|casa|residencia|imovel|logradouro)|numero_?(end|lograd)|num_?casa|apto|apartamento|bloco|lote|quadra|casa_?(numero|num|nr)|house_?number|apartment|unit_?number', 0.7]))

// ── L1 · Banking and payments ───────────────────────────────────────────────

// Branch and account numbers, with the bank's check digit (sometimes X): digits are mapped, the
// bank code of its own column (COMPE, ISPB) is not personal data and has no domain.
domain('BR_L1_CONTA_BANCARIA', 'BR_CM_DIGITOS',
  byName(['conta_?(corrente|poupanca|bancaria|banco|salario|pagamento|deposito|credito|debito)|cc_?(numero|num|nr)|n(r|u|um|o|ro|umero)_?conta|num_?cta|nr_?cta|cta_?(corrente|bancaria)|agencia(_?(conta|bancaria|numero|num|nr|dv))?|ag_?(conta|bancaria)|dv_?(conta|agencia)|digito_?(conta|agencia)|iban|account_?(no|num|number)|bank_?account|operacao_?conta', 0.85]))

// Payment Card fails a row that has no digits to mask; only values shaped like a card reach it.
algorithm('BR_CARTAO_LUHN', 'characterMapping.PaymentCard', { minMaskedPositions: 6, preserve: 0 }, '5162306219378829')
decompose('BR_CARTAO', [[String.raw`(\d[\d\s\-]{11,22}\d)`, apply('BR_CARTAO_LUHN')]], keep, '5162 3062 1937 8829')
domain('BR_L1_CARTAO', 'BR_CARTAO',
  byName(['cartao(_?(credito|debito|numero|num|nr|pan))?|n(r|u|um|o|ro|umero)_?cartao|pan|card_?(no|num|number)|credit_?card|cc_?number', 0.85]),
  // 0.9, not 1: an IMEI is 15 Luhn-valid digits too, and its own column name should win.
  byPattern([[String.raw`\d{13,19}`, 0.9, { checksum: 'LUHN', clean: String.raw`[\s\-]` }]], { reject: 0.3 }))

// A PIX key is a CPF, a CNPJ, an e-mail, a phone number in +55 format or a random key (a UUID): each
// is masked the way its own domain is.
decompose('BR_CHAVE_PIX', [
  [String.raw`([^@\s]+@[^@\s]+)`, apply('BR_EMAIL')],
  [String.raw`(\+55\d{10,11})`, apply('BR_TELEFONE')],
  [`(${CPF_FORMATTED}|\\d{11})`, apply('BR_CPF')],
  [`(${CNPJ_FORMATTED}|[0-9A-Z]{12}\\d{2})`, apply('BR_CNPJ')],
  [String.raw`([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})`, apply('BR_CM_HEX')],
], CM, '123e4567-e89b-12d3-a456-426614174000')
domain('BR_L1_CHAVE_PIX', 'BR_CHAVE_PIX',
  byName(['chave_?pix|pix(_?(chave|key|destino|recebedor|pagador|favorecido))?|chave_?(aleatoria|evp)|evp|pix_?key', 0.9]),
  byPattern([[String.raw`[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`, 0.3]], { reject: 0.2 }))

// ── L1 · Network, devices, vehicles, property ───────────────────────────────

algorithm('BR_OCTETO', 'characterMapping.NumericMapping', { minValue: 1, maxValue: 254 }, '10')
decompose('BR_IP', [
  [String.raw`(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})`, apply('BR_OCTETO'), apply('BR_OCTETO'), apply('BR_OCTETO'), apply('BR_OCTETO')],
], apply('BR_CM_HEX'), '200.147.67.142')
domain('BR_L1_IP', 'BR_IP',
  byName(['ip|ip_?(address|addr|origem|destino|cliente|usuario|acesso|login|remoto|publico)|endereco_?ip|ipv[46]|remote_?addr(ess)?|client_?ip|host_?ip', 0.85]),
  byPattern([
    [String.raw`((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)`, 1],
    [String.raw`[0-9A-Fa-f]{1,4}(:[0-9A-Fa-f]{0,4}){2,7}`, 0.9],
  ], { reject: 0.3 }))

domain('BR_L1_DISPOSITIVO', 'BR_CM_HEX',
  byName(['imei|imsi|iccid|mac|mac_?address|endereco_?mac|device_?(id|uuid|serial)|id_?(dispositivo|aparelho)|dispositivo_?id|advertising_?id|idfa|gaid|cookie(_?id)?|session_?id|id_?sessao|serial_?(aparelho|celular)', 0.8]),
  byPattern([
    [String.raw`([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}`, 1],
    [String.raw`\d{15}`, 0.8, { checksum: 'LUHN' }],
  ], { reject: 0.3 }))

// Plates: three letters and four digits (ABC-1234), or the Mercosur pattern with a letter in the
// fifth position (ABC1D23). Letters stay letters, digits digits, positions and hyphen kept.
decompose('BR_PLACA', [
  [String.raw`([A-Za-z]{3})(-?)(\d)([A-Za-z0-9])(\d{2})`, apply('BR_CM_DIGITOS_LETRAS'), keep, DIGITS, apply('BR_CM_DIGITOS_LETRAS'), DIGITS],
], CM, 'BRA2E19')
domain('BR_L1_PLACA', 'BR_PLACA',
  byName(['placa(_?(veiculo|carro|moto|numero))?|n(r|u|um|o|ro|umero)_?placa|placa_?mercosul|license_?plate|plate(_?(no|number))?', 0.85]),
  byPattern([
    [String.raw`[A-Z]{3}\d[A-Z]\d{2}`, 0.9],
    [String.raw`[A-Z]{3}-?\d{4}`, 0.8],
  ], { reject: 0.3 }))

// RENAVAM: eleven digits, the last a check digit with the PIS weights 3 2 9 8 7 6 5 4 3 2 (the
// old nine-digit numbers are padded with zeros).
checkDigit('BR_RENAVAM_VALIDO', [3, 2, 9, 8, 7, 6, 5, 4, 3, 2], 'BR_CM_DIGITOS', { pad: true, input: '00639884962' })
decompose('BR_RENAVAM', [[String.raw`(\d{9,11})`, apply('BR_RENAVAM_VALIDO')]], DIGITS, '00639884962')
domain('BR_L1_RENAVAM', 'BR_RENAVAM',
  byName(['renavam|cod_?renavam|codigo_?renavam|n(r|u|um|o|ro|umero)_?renavam|registro_?nacional_?(de_?)?veiculos', 0.9]))

domain('BR_L1_CHASSI', 'BR_CM_ALFANUM',
  byName(['chassi(_?(numero|num|nr))?|n(r|u|um|o|ro|umero)_?chassi|vin|numero_?motor|n(r|u)_?motor', 0.85]),
  byPattern([[String.raw`[A-HJ-NPR-Z0-9]{17}`, 0.7]], { reject: 0.3 }))

// Real estate registration (matrícula), municipal property tax number (IPTU), rural property codes
// (CAR, CCIR, NIRF, SNCR): each leads to the owner.
domain('BR_L1_IMOVEL', 'BR_CM_ALFANUM',
  byName(['matricula_?(do_?)?imovel|matricula_?(cartorio|cri|registro)|inscricao_?(imobiliaria|municipal_?imovel|iptu|cadastral)|iptu(_?(numero|num|nr|inscricao))?|indicacao_?fiscal|codigo_?(car|ccir|nirf|sncr|incra)|n(r|u)_?(car|ccir|nirf)|car_?(imovel|rural)|ccir|nirf|cib|sncr', 0.85]))

domain('BR_L1_CONTRATO', 'BR_CM_ALFANUM',
  byName(['n(r|u|um|o|ro|umero)_?(contrato|apolice|proposta|matricula|carteirinha|protocolo|instalacao|uc|unidade_?consumidora|cliente|pedido_?cliente)|contrato_?(numero|num|nr)|matricula(?!_?(imovel|certidao|cartorio|cri))(_?(funcionario|func|empregado|servidor|aluno|associado))?|matr|cod_?(cliente|funcionario|servidor|aluno|associado|segurado|beneficiario)|codigo_?(cliente|funcionario|servidor|aluno|associado)|id_?(cliente|funcionario|servidor|aluno|associado)|unidade_?consumidora|instalacao|apolice|carteirinha|ra_?aluno|registro_?academico|siape', 0.7]))

domain('BR_L1_USUARIO', 'BR_CM_ALFANUM',
  byName(['usuario|user_?name|username|login(_?(nome|usuario))?|apelido|nick(_?name)?|alias|perfil_?(instagram|facebook|twitter|tiktok|linkedin)|instagram|facebook|twitter|tiktok|linkedin|rede_?social|arroba|handle', 0.7]))

domain('BR_L1_CREDENCIAL', 'BR_REDIGIR',
  byName(['senha|password|passwd|pwd|pass|hash_?senha|senha_?hash|pin|codigo_?(seguranca|verificacao|acesso)|cvv|cvc|token(_?(acesso|refresh|api))?|access_?token|refresh_?token|api_?key|chave_?api|segredo|secret|otp|frase_?secreta|pergunta_?secreta|resposta_?secreta', 0.9]))

decompose('BR_COORDENADA', [
  // The integer part and first decimal stay (about 11 km): the place is generalized, not moved.
  [String.raw`(-?\d{1,3}[.,]\d)(\d+)\s*([,;])\s*(-?\d{1,3}[.,]\d)(\d+)`, keep, DIGITS, keep, keep, DIGITS],
  [String.raw`(-?\d{1,3}[.,]\d)(\d+)`, keep, DIGITS],
], keep, '-23.561414')
domain('BR_L1_GEOLOCALIZACAO', 'BR_COORDENADA',
  byName(
    ['lat|latitude|lon|lng|longitude|coordenadas?|coord_?[xy]|geo_?(lat|lon|lng|loc|localizacao|posicao)|geolocalizacao|gps(_?(localizacao|posicao|coordenadas))?|localizacao_?gps', 0.85],
    ['long', 0.5],
  ),
  byPattern([
    [String.raw`-?([0-2]?\d|3[0-3])\.\d{3,}\s*,\s*-(3[4-9]|[4-6]\d|7[0-4])\.\d{3,}`, 0.9],
    [String.raw`-(3[4-9]|[4-6]\d|7[0-4])\.\d{4,}`, 0.6],
    [String.raw`-?([0-2]?\d|3[0-3])\.\d{4,}`, 0.3],
  ], { reject: 0.3 }))

// ── L1 · Free text ──────────────────────────────────────────────────────────

algorithm('BR_TEXTO_LIVRE', 'freeTextRedaction.FreeTextRedaction', {
  regularExpressions: [
    String.raw`(?<![\d.\-])\d{3}\.\d{3}\.\d{3}-\d{2}(?![\d\-])`,
    String.raw`(?<!\d)\d{11}(?!\d)`,
    String.raw`(?<![\dA-Z.])[0-9A-Z]{2}\.[0-9A-Z]{3}\.[0-9A-Z]{3}/[0-9A-Z]{4}-\d{2}(?!\d)`,
    String.raw`(?<!\d)\d{14}(?!\d)`,
    String.raw`[\w.+\-]+@[\w\-]+(\.[\w\-]+)+`,
    String.raw`(?<![\d\-])\(?\d{2}\)?-?9?\d{4}-\d{4}(?![\d\-])`,
    String.raw`(?<![\d\-])9\d{4}-\d{4}(?![\d\-])`,
    String.raw`(?<!\d)(\+?55)?\d{10,11}(?!\d)`,
    String.raw`(?<!\d)\d{13,19}(?!\d)`,
    String.raw`(?<!\d)\d{5}-\d{3}(?!\d)`,
    String.raw`(?<![A-Za-z])[A-Z]{3}-?\d[A-Z0-9]\d{2}(?![A-Za-z\d])`,
    String.raw`(?<!\d)(\d{1,3}\.){3}\d{1,3}(?!\d)`,
  ].map((patternString) => ({ patternString })),
  regExRedactValue: '[DADO]',
  lookupFile: { uri: file('br-texto-nomes.txt', unique([...GIVEN_NAMES, ...SURNAMES].flatMap((v) => [v, v.toUpperCase(), fold(v), fold(v).toUpperCase()]))) },
  lookupFileRedactValue: '[NOME]',
  isDenyList: true,
}, 'Cliente Souza, CPF 529.982.247-25, e-mail m.souza@gmail.com, tel (11) 98765-4321')

domain('BR_L1_TEXTO_LIVRE', 'BR_TEXTO_LIVRE',
  byName(['observac(ao|oes)|obs|comentarios?|notas?|anotac(ao|oes)|descricao_?(ocorrencia|atendimento|chamado|reclamacao|solicitacao|caso|fato)|historico_?(atendimento|chamado|contato)|relato|parecer|justificativa|(?<!(id|cd|cod|codigo|tp|tipo|dt|data|st|status|qt|nr|nu)_?)mensagem(?!_?(id|tipo|codigo|data|status|fila|log))|texto(_?livre)?|detalhes|resumo_?(atendimento|caso)|reclamacao|ocorrencia_?(descricao|texto)|remarks?|comments?|notes?|free_?text|memo', 0.6]),
  byType(STRING(30)),
  byPattern([
    [String.raw`\d{3}\.\d{3}\.\d{3}-\d{2}`, 0.7],
    [String.raw`[\w.+\-]+@[\w\-]+\.[A-Za-z]{2,}`, 0.7],
    [String.raw`\(?\d{2}\)?\s?9\d{4}-\d{4}`, 0.6],
  ], { reject: 0, partial: true }))

// ── L2 · Quasi-identifiers ──────────────────────────────────────────────────

// Small shifts: large enough to break the link to the person, small enough that ages, school years
// and the 12th and 18th birthdays of the Estatuto da Criança e do Adolescente move for few people.
algorithm('BR_DATA_NASCIMENTO', 'dateAlgorithms.DateShift', { minRange: -60, maxRange: 60, unit: 'DAYS', roll: false }, '1985-07-20')
algorithm('BR_DATA_EVENTO', 'dateAlgorithms.DateShift', { minRange: -30, maxRange: 30, unit: 'DAYS', roll: false }, '2021-03-15')

domain('BR_L2_DATA_NASCIMENTO', 'BR_DATA_NASCIMENTO',
  byName(['dt_?nasc(imento)?|data_?(de_?)?nasc(imento)?|dat_?nasc|d_?nasc|nascimento|dn|dta_?nasc|dtnasc|datanasc(imento)?|aniversario|dob|date_?of_?birth|birth_?date|birthday', 0.9]),
  byType(...DATES, STRING(6)))

// The decade stays and the unit is masked.
decompose('BR_ANO', [[String.raw`(\d{3})(\d)`, keep, DIGITS]], keep, '1985')
domain('BR_L2_ANO_NASCIMENTO', 'BR_ANO',
  byName(['ano_?(de_?)?nasc(imento)?|an_?nasc|nu_?ano_?nasc|year_?of_?birth|birth_?year|yob', 0.9]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// 37 becomes 3x. From 100 on, 90.
decompose('BR_IDADE', [
  [String.raw`(\d{3,})`, redactAs('90')],
  [String.raw`([1-9])(\d)([.,]\d+)`, keep, DIGITS, keep],
  [String.raw`([1-9])(\d)`, keep, DIGITS],
  [String.raw`(\d)`, DIGITS],
], keep, '37')
domain('BR_L2_IDADE', 'BR_IDADE',
  byName(['idade(_?(anos|atual|paciente|cliente|obito|diagnostico|admissao|na_?data))?|nu_?idade|qt_?idade|faixa_?etaria|anos_?de_?idade|age(_?(years|group))?', 0.85]),
  byType(NUMBER(0, 6), STRING(0, 6)))

domain('BR_L2_DATA_EVENTO', 'BR_DATA_EVENTO',
  byName(['dt_?(obito|falecimento|casamento|divorcio|admissao|demissao|desligamento|contratacao|aposentadoria|internacao|alta|diagnostico|atendimento|consulta|parto|prisao|condenacao|expedicao|emissao_?rg|emissao_?(cnh|documento)|naturalizacao|vacinacao|cirurgia|acidente|afastamento|posse|exoneracao)|data_?(do_?|de_?)?(obito|falecimento|casamento|divorcio|admissao|demissao|desligamento|contratacao|aposentadoria|internacao|alta|diagnostico|atendimento|consulta|parto|prisao|condenacao|expedicao|naturalizacao|vacinacao|cirurgia|acidente|afastamento|posse|exoneracao)|date_?of_?(death|marriage|hire|admission|discharge)', 0.8]),
  byType(...DATES, STRING(6)))

// Each vocabulary replaced within itself: M/F stays M/F.
decompose('BR_SEXO', [
  ['(?i)(feminino|masculino)', apply(lookup('BR_SEXO_FEMININO_MASCULINO', 'br-sexo-feminino-masculino.txt', ['Feminino', 'Masculino']))],
  ['(?i)(mulher|homem)', apply(lookup('BR_SEXO_MULHER_HOMEM', 'br-sexo-mulher-homem.txt', ['Mulher', 'Homem']))],
  ['(?i)(fem|masc)', apply(lookup('BR_SEXO_FEM_MASC', 'br-sexo-fem-masc.txt', ['Fem', 'Masc']))],
  ['(?i)(female|male)', apply(lookup('BR_SEXO_FEMALE_MALE', 'br-sexo-female-male.txt', ['Female', 'Male']))],
  ['(?i)([fm])', apply(lookup('BR_SEXO_F_M', 'br-sexo-f-m.txt', ['F', 'M']))],
  // IBGE, SUS and eSocial codes: 1 male, 2 female.
  ['([12])', apply(lookup('BR_SEXO_1_2', 'br-sexo-1-2.txt', ['1', '2']))],
], keep, 'F')
domain('BR_L2_SEXO', 'BR_SEXO',
  byName(['sexo(_?(biologico|nascimento|registro|paciente|cliente))?|(tp|cs|co|cd|ds|sg|in|fl|id)_?sexo|genero(?!_?(identidade|autodeclarado|social))|sex|gender(?!_?identity)', 0.85]),
  byList([['br-detectar-sexo.txt', ['f', 'm', 'feminino', 'masculino', 'fem', 'masc', 'mulher', 'homem', 'female', 'male'], 0.5]], { reject: 0.5 }))

// ── L2 · Where people live ──────────────────────────────────────────────────
//
// Brazil has 5,570 municipalities; 3,860 of them had fewer than 20,000 inhabitants in the 2022
// census. With a birth date and a sex, one of them points at a handful of people. A small one
// becomes the nearest municipality of the same state with at least 20,000 — a real place, nearby,
// shared by many. The state stays: the smallest, Roraima, has 636,707 people.

const distance = (a, b) => {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}
const SMALL_MUNICIPALITY = 20000
const municipalityTo = new Map(MUNICIPALITIES.map((m) => {
  if (m.population >= SMALL_MUNICIPALITY) return [m.code, m]
  const candidates = MUNICIPALITIES.filter((x) => x.uf === m.uf && x.population >= SMALL_MUNICIPALITY)
  return [m.code, candidates.reduce((best, x) => (distance(m, x) < distance(m, best) ? x : best))]
}))
const small = MUNICIPALITIES.filter((m) => m.population < SMALL_MUNICIPALITY)

/** Name → generalized name. A name shared by several municipalities is generalized only when all are small. */
// Names that differ only in accents are the same name: "Goianá" (MG) is written "Goiana", like the
// municipality of Pernambuco.
const nameKey = (name) => fold(name).toLowerCase()
const byMunicipalityName = new Map()
for (const m of MUNICIPALITIES) {
  for (const name of unique([m.name, ...(m.alias ? [m.alias] : [])])) {
    const entry = byMunicipalityName.get(nameKey(name)) ?? { spellings: new Set(), all: new Set() }
    entry.spellings.add(name)
    entry.all.add(m)
    byMunicipalityName.set(nameKey(name), entry)
  }
}
const municipalityPairs = []
for (const { spellings, all } of byMunicipalityName.values()) {
  if ([...all].some((m) => m.population >= SMALL_MUNICIPALITY)) continue
  const to = municipalityTo.get([...all].reduce((a, b) => (b.population > a.population ? b : a)).code).name
  for (const name of spellings) municipalityPairs.push([name, to])
}
// With the state, as systems write it to tell homonyms apart: "Bonito - MS", "Bonito/MS".
const withState = []
for (const m of small) {
  const to = municipalityTo.get(m.code)
  for (const name of unique([m.name, ...(m.alias ? [m.alias] : [])])) {
    for (const sep of [' - ', '/', '-', ' / ']) withState.push([`${name}${sep}${m.uf}`, `${to.name}${sep}${to.uf}`])
  }
}
// How systems write a name: as it is, in capitals, and without accents. A name that has no accents
// maps to the accented one; only a name whose accents were dropped maps to a name without them.
const spellings = (from, to) => {
  const out = new Map([[from, to], [from.toUpperCase(), to.toUpperCase()]])
  if (!out.has(fold(from))) out.set(fold(from), fold(to))
  if (!out.has(fold(from).toUpperCase())) out.set(fold(from).toUpperCase(), fold(to).toUpperCase())
  return [...out]
}
const variants = (pairs) => pairs.flatMap(([from, to]) => spellings(from, to))
// Accents and case make different names fold to the same line: a line that would also rename a large
// municipality, or rename one name two ways, is left out.
const keptNames = variants(MUNICIPALITIES.filter((m) => m.population >= SMALL_MUNICIPALITY)
  .flatMap((m) => [m.name, ...(m.alias ? [m.alias] : [])].flatMap((n) => [[n, n], ...['-', '/', ' - ', ' / '].map((sep) => [`${n}${sep}${m.uf}`, `${n}${sep}${m.uf}`])])))
const kept = new Set(keptNames.map(([from]) => from))
const generalized = new Map()
const ambiguous = new Set()
for (const [from, to] of variants([...municipalityPairs, ...withState])) {
  if (kept.has(from) || ambiguous.has(from)) continue
  // The same place reached through its alias ("Itaóca" and "Itaoca") differs only in accents: first wins.
  if (generalized.has(from) && fold(generalized.get(from)).toUpperCase() === fold(to).toUpperCase()) continue
  if (generalized.has(from) && generalized.get(from) !== to) { generalized.delete(from); ambiguous.add(from); continue }
  generalized.set(from, to)
}
cleansing('BR_MUNICIPIO', 'br-municipios-generalizados.txt', [...generalized], 'Monteiro Lobato', '|')

// IBGE codes: seven digits, or six without the check digit (DATASUS).
cleansing('BR_CODIGO_MUNICIPIO', 'br-codigos-municipio-generalizados.txt',
  small.flatMap((m) => { const to = municipalityTo.get(m.code); return [[m.code, to.code], [m.code.slice(0, 6), to.code.slice(0, 6)]] }), '3531209')

const PERSONAL_WORDS = new Set([...GIVEN_NAMES, ...SURNAMES].map((w) => fold(w).toLowerCase()))
const STATE_NAMES = new Set(['acre', 'alagoas', 'amapa', 'amazonas', 'bahia', 'ceara', 'distrito federal', 'espirito santo', 'goias', 'maranhao', 'mato grosso', 'mato grosso do sul', 'minas gerais', 'para', 'paraiba', 'parana', 'pernambuco', 'piaui', 'rio de janeiro', 'rio grande do norte', 'rio grande do sul', 'rondonia', 'roraima', 'santa catarina', 'sao paulo', 'sergipe', 'tocantins', 'brasil'])
const MUNICIPALITY_NAMES = unique(MUNICIPALITIES.flatMap((m) => [m.name, ...(m.alias ? [m.alias] : [])]))
  .filter((n) => !PERSONAL_WORDS.has(fold(n).toLowerCase()) && !STATE_NAMES.has(fold(n).toLowerCase()))

domain('BR_L2_MUNICIPIO', 'BR_MUNICIPIO',
  byName(
    ['municipio(?!_?(ibge|cod|codigo|id))(_?(residencia|nascimento|endereco|domicilio|paciente|cliente|ocorrencia|notificacao|atendimento))?|(no|nm|ds|nome)_?(municipio|cidade)|cidade(_?(residencia|nascimento|natal|endereco|cliente))?|naturalidade|local_?(de_?)?nascimento|mun_?(res|resid|nasc|nascimento)|city|town|localidade', 0.85],
  ),
  byList([['br-detectar-municipios.txt', MUNICIPALITY_NAMES, 0.8]], { reject: 0.4 }))

domain('BR_L2_CODIGO_MUNICIPIO', 'BR_CODIGO_MUNICIPIO',
  byName(['(cd|co|cod|codigo|id|nu)_?(municipio|mun|cidade)(_?(ibge|res|resid|residencia|nasc|nascimento|ocorrencia|notificacao))?|(cd|co|cod|codigo)_?ibge(_?(municipio|mun|cidade))?|ibge(_?(municipio|mun|cidade|codigo|cod))?|municipio_?ibge|geocodigo|id_?mn_?resi|id_?municip|mun_?res_?ibge', 0.85]),
  byPattern([[String.raw`(1[1-7]|2[1-9]|3[1-35]|4[1-3]|5[0-3])\d{4,5}`, 0.3]], { reject: 0.3 }))

// CEP: region, sub-region, sector, sub-sector, sub-sector division, and a suffix that names the
// street or the town. The first three digits stay (the postal sector); the rest becomes zeros.
decompose('BR_CEP', [
  [String.raw`(\d{2})(\.?)(\d)(\d{2})(-?)(\d{3})`, keep, keep, keep, redactAs('00'), keep, redactAs('000')],
  // In a numeric column 01310-100 is 1310100.
  [String.raw`(\d{2})(\d{2})(\d{3})`, keep, redactAs('00'), redactAs('000')],
], keep, '01310-100')
domain('BR_L2_CEP', 'BR_CEP',
  byName(['cep(_?(residencia|residencial|comercial|cobranca|entrega|cliente|endereco|paciente|origem|destino))?|(nr|nu|num|numero|cd|co|cod)_?cep|codigo_?(de_?)?enderecamento_?postal|codigo_?postal|zip_?code|zip|postal_?code', 0.9]),
  byPattern([[String.raw`\d{5}-\d{3}`, 0.8], [String.raw`\d{2}\.\d{3}-\d{3}`, 0.9]], { reject: 0.3 }))

lookup('BR_BAIRRO', 'br-bairros.txt', NEIGHBOURHOODS, 'Vila Madalena', 'PRESERVE_LOOKUP_FILE')
domain('BR_L2_BAIRRO', 'BR_BAIRRO',
  byName(['bairro(_?(residencia|endereco|cliente|entrega|cobranca))?|(no|nm|ds|nome)_?bairro|distrito_?residencia|localidade_?bairro|vila_?residencia|neighbou?rhood', 0.85]))

domain('BR_L2_ZONA_SECAO_ELEITORAL', 'BR_CM_DIGITOS',
  byName(['zona_?(eleitoral)?|secao_?(eleitoral)?|zona_?secao|nr_?(zona|secao)|nu_?(zona|secao)|local_?(de_?)?votacao', 0.8]))

// Nationalities: Brazilian and the largest immigrant groups of the 2022 census.
const NATIONALITIES = ['Brasileira', 'Venezuelana', 'Haitiana', 'Boliviana', 'Portuguesa', 'Paraguaia', 'Argentina', 'Colombiana', 'Peruana', 'Japonesa', 'Chinesa', 'Angolana', 'Cubana', 'Uruguaia', 'Italiana', 'Espanhola']
lookup('BR_NACIONALIDADE', 'br-nacionalidades.txt', NATIONALITIES, 'Senegalesa')
domain('BR_L2_NACIONALIDADE', 'BR_NACIONALIDADE',
  byName(['nacionalidade|pais_?(de_?)?(nascimento|origem|nacionalidade)|cidadania|nationality|citizenship|country_?of_?birth', 0.8]),
  byList([['br-detectar-nacionalidades.txt', [...NATIONALITIES, 'brasileiro', 'venezuelano', 'haitiano', 'boliviano', 'português', 'paraguaio', 'argentino', 'colombiano', 'peruano', 'japonês', 'chinês', 'angolano', 'cubano', 'uruguaio', 'italiano', 'espanhol', 'brasil', 'venezuela', 'haiti', 'bolívia', 'portugal', 'paraguai', 'colômbia', 'peru', 'japão', 'china', 'angola', 'cuba', 'uruguai', 'itália', 'espanha', 'estrangeiro', 'estrangeira', 'naturalizado', 'naturalizada'], 0.7]], { reject: 0.4 }))

// Marital status as IBGE and eSocial write it.
const MARITAL = ['Solteiro(a)', 'Casado(a)', 'União estável', 'Divorciado(a)', 'Separado(a)', 'Viúvo(a)']
categorical('BR_ESTADO_CIVIL', 'br-estado-civil.txt', MARITAL, 'Separado judicialmente', ['1', '2', '3', '4', '5'])
domain('BR_L2_ESTADO_CIVIL', 'BR_ESTADO_CIVIL',
  byName(['estado_?civil|est_?civil|(cd|co|tp|ds|in)_?estado_?civil|situacao_?conjugal|estciv|marital_?status|civil_?status', 0.85]),
  byList([['br-detectar-estado-civil.txt', [...MARITAL, 'solteiro', 'solteira', 'casado', 'casada', 'uniao estavel', 'amasiado', 'divorciado', 'divorciada', 'separado', 'separada', 'viuvo', 'viuva', 'desquitado', 'companheiro', 'companheira'], 0.7]], { reject: 0.4 }))

lookup('BR_OCUPACAO', 'br-ocupacoes.txt', ['Auxiliar administrativo', 'Assistente administrativo', 'Vendedor de comércio varejista', 'Operador de caixa', 'Motorista de caminhão', 'Pedreiro', 'Servente de obras', 'Professor de ensino fundamental', 'Técnico de enfermagem', 'Enfermeiro', 'Médico clínico', 'Contador', 'Advogado', 'Engenheiro civil', 'Analista de sistemas', 'Programador', 'Recepcionista', 'Faxineiro', 'Porteiro', 'Vigilante', 'Cozinheiro', 'Garçom', 'Eletricista', 'Encanador', 'Mecânico de automóveis', 'Trabalhador agropecuário', 'Produtor rural', 'Pescador artesanal', 'Estoquista', 'Operador de telemarketing', 'Auxiliar de logística', 'Supervisor administrativo', 'Gerente comercial', 'Representante comercial', 'Cabeleireiro', 'Costureiro', 'Estudante', 'Aposentado', 'Autônomo', 'Do lar'], 'Coordenadora de operações regionais')
// CBO: the Brazilian occupation code, 4 digits and a 2-digit family member (5211-10).
lookup('BR_CBO', 'br-cbo.txt', ['411005', '411010', '521110', '421125', '782510', '715210', '717020', '231205', '322205', '223505', '225125', '252210', '241005', '214205', '212405', '317110', '422105', '514320', '517330', '513205', '513405', '715615', '724110', '914405', '622020', '612005', '631105', '414105', '422310', '783225', '410105', '354705', '516110', '763215'], '223510', 'PRESERVE_LOOKUP_FILE')
decompose('BR_OCUPACAO_OU_CBO', [
  [String.raw`(\d{6})`, apply('BR_CBO')],
  [String.raw`(\d{4})-(\d{2})`, DIGITS, DIGITS],
], apply('BR_OCUPACAO'), 'Coordenadora de operações regionais')
domain('BR_L2_OCUPACAO', 'BR_OCUPACAO_OU_CBO',
  byName(
    ['ocupacao|profissao|cbo|(cd|co|cod|codigo)_?(cbo|ocupacao|profissao)|cargo_?(funcionario|atual|ocupado)|funcao_?(exercida|funcionario)|atividade_?profissional|occupation|profession|job_?title', 0.8],
    ['cargo|funcao', 0.5],
  ))

lookup('BR_EMPREGADOR', 'br-empregadores.txt', ['Comercial Horizonte Ltda.', 'Construtora Vale Verde Ltda.', 'Transportes Rota Sul Ltda.', 'Supermercados Bom Preço Ltda.', 'Indústria Metalúrgica Progresso S.A.', 'Clínica Bem-Estar Ltda.', 'Colégio Novo Saber Ltda.', 'Serviços Gerais Aliança Ltda.', 'Agropecuária Campo Belo Ltda.', 'Distribuidora Estrela Ltda.', 'Tecnologia Ponto Digital Ltda.', 'Restaurante Sabor Caseiro Ltda.', 'Hotel Mirante do Sol Ltda.', 'Laboratório Vida Plena Ltda.', 'Segurança Patrimonial Atalaia Ltda.', 'Confecções Linha Fina Ltda.', 'Auto Peças Centro Oeste Ltda.', 'Farmácia Popular do Bairro Ltda.', 'Logística Ponte Norte Ltda.', 'Prefeitura Municipal de Vila Nova', 'Associação Mãos Solidárias', 'Cooperativa Agrícola União', 'Padaria Pão Nosso Ltda.', 'Contabilidade Exata Ltda.'], 'Petróleo Brasileiro S.A.')
domain('BR_L2_EMPREGADOR', 'BR_EMPREGADOR',
  byName(['empregador(_?(nome|razao_?social))?|(nome|nm|no)_?empregador|empresa_?(onde_?trabalha|trabalho|empregadora|atual)|local_?(de_?)?trabalho|empregadora|razao_?social_?empregador|employer(_?name)?|workplace', 0.8]))

// Education levels as IBGE and eSocial write them.
const EDUCATION = ['Sem instrução', 'Fundamental incompleto', 'Fundamental completo', 'Médio incompleto', 'Médio completo', 'Superior incompleto', 'Superior completo', 'Especialização', 'Mestrado', 'Doutorado']
categorical('BR_ESCOLARIDADE', 'br-escolaridade.txt', EDUCATION, 'Pós-doutorado', ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'])
domain('BR_L2_ESCOLARIDADE', 'BR_ESCOLARIDADE',
  byName(['escolaridade|grau_?(de_?)?instrucao|grau_?instr|nivel_?(de_?)?(escolaridade|instrucao|ensino)|(cd|co|tp|ds)_?escolaridade|instrucao|formacao_?academica|education(_?level)?', 0.8]),
  byList([['br-detectar-escolaridade.txt', [...EDUCATION, 'analfabeto', 'fundamental', 'ensino fundamental', 'ensino médio', 'médio', 'superior', 'graduação', 'pós-graduação', 'especialização', 'mestrado', 'doutorado', 'técnico'], 0.6]], { reject: 0.4 }))

lookup('BR_ESCOLA', 'br-escolas.txt', ['Escola Estadual Professora Maria José', 'Escola Municipal Monteiro Lobato', 'Colégio Estadual Rui Barbosa', 'Escola Estadual Castro Alves', 'Centro Educacional Vila Nova', 'Instituto Federal Campus Serra Azul', 'Faculdade Horizonte', 'Centro Universitário Vale do Sol', 'Universidade Estadual do Planalto', 'Escola Técnica Professor Paulo Freire', 'Colégio Santa Cecília', 'Escola Municipal Cecília Meireles'], 'Escola Estadual Doutor Arnaldo')
domain('BR_L2_ESCOLA', 'BR_ESCOLA',
  byName(['escola(_?(nome|atual|origem))?|(nome|nm|no)_?(escola|instituicao_?ensino|faculdade|universidade)|instituicao_?(de_?)?ensino|faculdade|universidade|colegio|(cd|co)_?(inep|entidade|escola)|school(_?name)?|university', 0.75]))

// Capped at 5 as text: large families are rare, and a rare count identifies.
decompose('BR_CONTAGEM_LIMITADA', [[String.raw`([0-5])`, keep], [String.raw`(\d+)`, redactAs('5')]], keep, '9')
domain('BR_L2_DEPENDENTES', 'BR_CONTAGEM_LIMITADA',
  byName(['dependentes|qt_?(dependentes|filhos|dep)|qtd_?(dependentes|filhos)|quantidade_?(de_?)?(dependentes|filhos)|n(r|u|um|o|ro|umero)_?(de_?)?(dependentes|filhos)|filhos|moradores_?(no_?)?domicilio|qt_?moradores|number_?of_?children|dependents', 0.8]),
  byType(NUMBER(0, 4), STRING(0, 4)))

// ── L3 · Sensitive personal data (art. 5, II) ───────────────────────────────

// Racial or ethnic origin. Colour or race as IBGE asks it, with its codes (1 white, 2 black, 3 brown,
// 4 yellow, 5 indigenous) — the same in SUS and eSocial records.
const RACE = ['Branca', 'Preta', 'Parda', 'Amarela', 'Indígena', 'Não declarada']
categorical('BR_RACA_COR', 'br-raca-cor.txt', RACE, 'Morena', ['1', '2', '3', '4', '5', '9'])
domain('BR_L3_RACA_COR', 'BR_RACA_COR',
  byName(['raca(_?cor)?|cor(_?raca)?|raca_?etnia|(cd|co|cs|tp|ds|id|in)_?(raca|cor|raca_?cor)|autodeclaracao_?(racial|raca|cor)|cor_?da_?pele|etnia_?racial|race|ethnicity', 0.95]),
  byList([['br-detectar-raca-cor.txt', [...RACE, 'branco', 'preto', 'pardo', 'amarelo', 'indigena', 'negro', 'negra', 'moreno', 'morena', 'mulato', 'não informada', 'ignorado', 'sem declaração'], 0.9],
    // The IBGE codes back up the column name but decide nothing alone.
    ['br-detectar-codigos-raca-cor.txt', ['1', '2', '3', '4', '5', '6', '9'], 0.3],
  ], { reject: 0.4 }))

// Indigenous peoples — the most numerous of the 2022 census —, quilombola and other traditional communities.
const PEOPLES = ['Tikúna', 'Kokama', 'Makuxí', 'Guarani Kaiowá', 'Guajajara', 'Terena', 'Kaingang', 'Yanomámi', 'Pataxó', 'Xavante', 'Potiguara', 'Guarani Mbya', 'Guarani Nhandeva', 'Pankararu', 'Xukuru', 'Tupinambá', 'Munduruku', 'Sateré-Mawé', 'Baniwa', 'Wapichana', 'Kayapó', 'Xakriabá', 'Tukano', 'Mura', 'Fulni-ô', 'Karajá', 'Quilombola', 'Cigano', 'Ribeirinho', 'Não pertence']
categorical('BR_ETNIA', 'br-etnias.txt', PEOPLES, 'Krenak')
domain('BR_L3_ETNIA', 'BR_ETNIA',
  byName(['etnia(?!_?racial)|povo(_?indigena)?|etnia_?indigena|(cd|co|ds|no)_?etnia|comunidade_?(tradicional|quilombola|indigena)|quilombola|aldeia|terra_?indigena|povo_?tradicional|indigena|lingua_?indigena|ethnic_?group|indigenous', 0.9]),
  byList([['br-detectar-etnias.txt', [...PEOPLES, 'ticuna', 'tikuna', 'makuxi', 'macuxi', 'yanomami', 'ianomami', 'guarani', 'kaiowa', 'caiová', 'xucuru', 'munduruku', 'kaiapó', 'quilombola', 'cigana', 'ribeirinha', 'indígena', 'não indígena'], 0.9],
    // Belonging is often a yes/no flag: it backs up the column name but decides nothing alone.
    ['br-detectar-flag.txt', ['s', 'n', 'sim', 'não', 'y', '0', '1'], 0.3],
  ], { reject: 0.4 }))

// Religions as the 2022 census groups them, and some of their detail.
const RELIGIONS = ['Católica Apostólica Romana', 'Evangélica', 'Evangélica pentecostal', 'Evangélica de missão', 'Espírita', 'Umbanda', 'Candomblé', 'Testemunha de Jeová', 'Judaica', 'Islâmica', 'Budista', 'Outra religiosidade', 'Sem religião']
categorical('BR_RELIGIAO', 'br-religioes.txt', RELIGIONS, 'Adventista do Sétimo Dia')
domain('BR_L3_RELIGIAO', 'BR_RELIGIAO',
  byName(['religiao|crenca_?religiosa|convicc?ao_?religiosa|confissao_?religiosa|(cd|co|ds|tp)_?religiao|igreja(_?(frequenta|membro|nome))?|denominacao_?religiosa|culto|religion|church', 0.95]),
  byList([['br-detectar-religioes.txt', [...RELIGIONS, 'católica', 'católico', 'catolico', 'evangélico', 'protestante', 'cristão', 'cristã', 'pentecostal', 'assembleia de deus', 'batista', 'universal', 'adventista', 'presbiteriana', 'luterana', 'metodista', 'congregação cristã', 'espírita', 'kardecista', 'umbanda', 'candomblé', 'matriz africana', 'testemunha de jeová', 'mórmon', 'judaica', 'judeu', 'islâmica', 'muçulmano', 'budista', 'ateu', 'agnóstico', 'sem religião', 'nenhuma'], 0.9]], { reject: 0.4 }))

// Membership of an organization of religious, philosophical or political character, and
// philosophical convictions: no shared vocabulary, so suppressed.
domain('BR_L3_CONVICCAO_ORGANIZACAO', 'BR_CATEGORIA_SUPRIMIDA',
  byName(['convicc?ao_?(filosofica|moral|politica)|crenca_?(filosofica|pessoal)|escusa_?(de_?)?consciencia|objecao_?(de_?)?consciencia|maconaria|loja_?maconica|ordem_?(religiosa|filosofica)|organizacao_?(religiosa|filosofica|politica)|filiacao_?(religiosa|filosofica)|associacao_?(religiosa|filosofica)|movimento_?(social|politico|religioso)|grupo_?(religioso|filosofico)|beliefs?|philosophical_?beliefs?', 0.9]))

const IDEOLOGIES = ['Esquerda', 'Centro-esquerda', 'Centro', 'Centro-direita', 'Direita', 'Sem preferência', 'Prefere não responder']
categorical('BR_OPINIAO_POLITICA', 'br-opinioes-politicas.txt', IDEOLOGIES, 'Conservador')
domain('BR_L3_OPINIAO_POLITICA', 'BR_OPINIAO_POLITICA',
  byName(['opiniao_?politica|posicionamento_?politico|orientacao_?politica|preferencia_?(politica|partidaria)|ideologia(_?politica)?|intencao_?(de_?)?voto|voto_?(pretendido|intencao)|espectro_?politico|political_?(opinion|view|orientation)|voting_?intention', 0.9]),
  byList([['br-detectar-opinioes-politicas.txt', [...IDEOLOGIES, 'esquerda', 'direita', 'centro', 'progressista', 'conservador', 'liberal', 'indeciso', 'bolsonarista', 'lulista', 'petista', 'antipetista', 'nenhum', 'nulo', 'branco'], 0.7]], { reject: 0.4 }))

// Party membership (filiação partidária): the 30 parties registered with the TSE in September 2026.
const PARTIES = [
  ['MDB', 'Movimento Democrático Brasileiro', '15'], ['PDT', 'Partido Democrático Trabalhista', '12'], ['PT', 'Partido dos Trabalhadores', '13'],
  ['PCdoB', 'Partido Comunista do Brasil', '65'], ['PSB', 'Partido Socialista Brasileiro', '40'], ['PSDB', 'Partido da Social Democracia Brasileira', '45'],
  ['AGIR', 'Agir', '36'], ['MOBILIZA', 'Mobilização Nacional', '33'], ['CIDADANIA', 'Cidadania', '23'], ['PV', 'Partido Verde', '43'],
  ['AVANTE', 'Avante', '70'], ['PP', 'Progressistas', '11'], ['PSTU', 'Partido Socialista dos Trabalhadores Unificado', '16'],
  ['PCB', 'Partido Comunista Brasileiro', '21'], ['PRTB', 'Partido Renovador Trabalhista Brasileiro', '28'], ['DC', 'Democracia Cristã', '27'],
  ['PCO', 'Partido da Causa Operária', '29'], ['PODE', 'Podemos', '20'], ['REPUBLICANOS', 'Republicanos', '10'], ['PSOL', 'Partido Socialismo e Liberdade', '50'],
  ['PL', 'Partido Liberal', '22'], ['PSD', 'Partido Social Democrático', '55'], ['SOLIDARIEDADE', 'Solidariedade', '77'], ['NOVO', 'Partido Novo', '30'],
  ['REDE', 'Rede Sustentabilidade', '18'], ['DEMOCRATA', 'Democrata', '35'], ['UP', 'Unidade Popular', '80'], ['UNIÃO', 'União Brasil', '44'],
  ['PRD', 'Partido Renovação Democrática', '25'], ['MISSÃO', 'Partido Missão', '14'],
]
lookup('BR_PARTIDO_SIGLA', 'br-partidos-siglas.txt', PARTIES.map(([s]) => s), undefined, 'PRESERVE_LOOKUP_FILE')
lookup('BR_PARTIDO_NUMERO', 'br-partidos-numeros.txt', PARTIES.map(([, , n]) => n))
lookup('BR_PARTIDO_NOME', 'br-partidos-nomes.txt', [...PARTIES.map(([, n]) => n), 'Sem filiação'])
decompose('BR_PARTIDO', [
  [FLAG, apply('BR_FLAG')],
  [String.raw`([1-9]\d)`, apply('BR_PARTIDO_NUMERO')],
  [`(?i)(${PARTIES.map(([s]) => fold(s)).join('|')}|UNIÃO|MISSÃO|PFL|DEM|PMDB|PSL|PTB|PROS|PSC|PMN|PTC|PHS|PPS|PR|PRB)`, apply('BR_PARTIDO_SIGLA')],
], apply('BR_PARTIDO_NOME'), 'Partido Trabalhista Brasileiro')
domain('BR_L3_FILIACAO_PARTIDARIA', 'BR_PARTIDO',
  byName(
    ['filiacao_?partidaria|partido(_?politico)?(_?(filiacao|sigla|nome|numero))?|sigla_?partido|(cd|co|sg|nm|nr)_?partido|filiado_?(a_?)?partido|militancia|militante|political_?party|party_?membership', 0.95],
  ),
  byList([['br-detectar-partidos.txt', [...PARTIES.flatMap(([s, n]) => [s, n]), 'sem partido', 'sem filiação', 'PTB', 'PSC', 'PROS', 'PMN', 'DEM', 'PSL', 'PMDB'], 0.8]], { reject: 0.4 }))

// Trade union membership: the union, the union fee, being a member. The values share no vocabulary
// beyond the central organizations, so they are suppressed; flags stay flags.
domain('BR_L3_FILIACAO_SINDICAL', 'BR_CATEGORIA_SUPRIMIDA',
  byName(['sindicato(_?(nome|filiado|filiacao|categoria|sigla|cnpj))?|sindicalizado|filiacao_?sindical|filiado_?sindicato|contribuicao_?(sindical|assistencial|confederativa)|mensalidade_?sindical|desconto_?sindical|imposto_?sindical|central_?sindical|entidade_?sindical|delegado_?sindical|dirigente_?sindical|trade_?union|union_?member(ship)?', 0.95]),
  byList([['br-detectar-sindicatos.txt', ['CUT', 'Força Sindical', 'UGT', 'CTB', 'NCST', 'CSB', 'CSP-Conlutas', 'Intersindical', 'Central Única dos Trabalhadores', 'União Geral dos Trabalhadores', 'Central dos Trabalhadores e Trabalhadoras do Brasil', 'Nova Central Sindical de Trabalhadores', 'Central dos Sindicatos Brasileiros', 'APEOESP', 'SINTEP', 'Sindicato dos Bancários', 'Sindicato dos Metalúrgicos', 'Sindicato dos Comerciários', 'SINDSEP', 'SINTUFRJ', 'SINTRAJUD', 'sindicalizado', 'associado ao sindicato'], 0.6]], { reject: 0.3 }))

domain('BR_L3_GENETICO', 'BR_REDIGIR',
  byName(['dna|adn|genetic[oa]s?|dados?_?geneticos?|genoma|genotip[a-z_]*|exame_?genetico|teste_?(genetico|de_?dna|paternidade)|perfil_?genetico|mutacao(_?genetica)?|brca[12]?|cariotipo|triagem_?neonatal|teste_?do_?pezinho|painel_?genetico|snp|haplotipo|genetic[a-z_]*|genome', 0.9]))

domain('BR_L3_BIOMETRICO', 'BR_REDIGIR',
  byName(['biometri[a-z_]*|digita(l|is)(_?(template|polegar|indicador|hash|imagem))?|impressao_?digital|template_?(facial|digital|biometrico)|face_?(template|hash|id|encoding)|reconhecimento_?facial|facial_?(template|hash|embedding)|iris(_?(template|scan))?|retina|voz_?(template|biometrica)|assinatura_?(biometrica|digitalizada)|palma_?mao|fingerprints?|biometric[a-z_]*', 0.9]),
  byType(STRING()))

// Sexual life: orientation and sexual life have their own domains; the LGPD names "vida sexual".
const ORIENTATIONS = ['Heterossexual', 'Gay', 'Lésbica', 'Bissexual', 'Pansexual', 'Assexual', 'Outra', 'Prefere não informar']
categorical('BR_ORIENTACAO_SEXUAL', 'br-orientacoes-sexuais.txt', ORIENTATIONS, 'Homossexual')
domain('BR_L3_ORIENTACAO_SEXUAL', 'BR_ORIENTACAO_SEXUAL',
  byName(['orientacao_?sexual|orient_?sexual|(cd|co|ds|tp)_?orientacao_?sexual|preferencia_?sexual|sexual_?orientation', 0.95]),
  byList([['br-detectar-orientacoes-sexuais.txt', [...ORIENTATIONS, 'hetero', 'homossexual', 'homo', 'lgbt', 'lgbtqia+', 'queer', 'não informado'], 0.8]], { reject: 0.4 }))

domain('BR_L3_VIDA_SEXUAL', 'BR_CATEGORIA_SUPRIMIDA',
  byName(['vida_?sexual|atividade_?sexual|comportamento_?sexual|pratica_?sexual|parceiros?_?sexua(l|is)|n(r|u|um)_?parceiros|sexualmente_?ativ[oa]|inicio_?(da_?)?vida_?sexual|relacao_?sexual|sex(ual)?_?life|sexual_?(activity|behavio(u)?r|partners)', 0.9]))

// Gender identity: not in the list of art. 5, II, treated as sensitive because it exposes people to the
// same discrimination. The social name (nome social) is a name and falls under the full-name domain.
const IDENTITIES = ['Mulher cisgênero', 'Homem cisgênero', 'Mulher trans', 'Homem trans', 'Travesti', 'Não binário', 'Outra', 'Prefere não informar']
categorical('BR_IDENTIDADE_GENERO', 'br-identidades-genero.txt', IDENTITIES, 'Transgênero')
domain('BR_L3_IDENTIDADE_GENERO', 'BR_IDENTIDADE_GENERO',
  byName(['identidade_?(de_?)?genero|(cd|co|ds|tp)_?identidade_?genero|genero_?(autodeclarado|social)|transgenero|pessoa_?trans|pronomes?|gender_?identity', 0.95]),
  byList([['br-detectar-identidades-genero.txt', [...IDENTITIES, 'cisgênero', 'cis', 'transgênero', 'trans', 'transexual', 'não-binário', 'nao binario', 'mulher', 'homem', 'feminino', 'masculino'], 0.7]], { reject: 0.4 }))

// ── SAUDE · Health data (art. 5, II; art. 11) ───────────────────────────────

// CNS: fifteen digits whose weighed sum (15 down to 1) is a multiple of 11. A definitive number
// (starting 1 or 2) is the person's PIS followed by 000 or 001 and a check digit. The PIS part is
// masked by the PIS algorithm — so the masked CNS still carries the masked PIS — and the tail is
// recomputed. A provisional number (7, 8, 9) is mapped digit by digit.
decompose('BR_CNS_CORPO', [[String.raw`(\d{11})(\d{4})`, apply('BR_PIS_VALIDO'), redactAs('0000')]], keep, '120564125470008')
const cnsTail = (s, d) => {
  const total = (s + d * 5) % 11
  const dv = (11 - total) % 11
  if (dv !== 10) return `${d}000${dv}`
  return `${d}001${(11 - ((total + 2) % 11)) % 11}`
}
chain('BR_CNS_DV', checksum('BR_CNS_DV', 'br-cns-dv', {
  chunks: [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10]],
  modulus: 11, marker: '0000',
  contribution: (p, d) => d * (15 - p),
  finish: (s, chars) => cnsTail(s, Number(chars)),
}), '120564125470000')
chain('BR_CNS_VALIDO', ['BR_CNS_CORPO', 'BR_CNS_DV'], '120564125470008')
decompose('BR_CNS', [
  [String.raw`([12]\d{14})`, apply('BR_CNS_VALIDO')],
  [String.raw`([789])(\d{14})`, keep, DIGITS],
], DIGITS, '898 0012 3456 7890')
domain('BR_SAUDE_CNS', 'BR_CNS',
  byName(['cns[a-z0-9_]*|cartao_?(nacional_?)?(de_?)?saude|cartao_?sus|n(r|u|um|o|ro|umero)_?(cns|cartao_?sus)|(co|cd|nu)_?cns_?(paciente|usuario|cidadao|profissional)?|cns_?(paciente|usuario|cidadao|profissional)|carteira_?sus', 0.9]),
  byPattern([[String.raw`[12789]\d{2}\s?\d{4}\s?\d{4}\s?\d{4}`, 0.5]], { reject: 0.3 }))

domain('BR_SAUDE_IDENTIFICADOR', 'BR_CM_ALFANUM',
  byName(
    ['prontuario(_?(numero|num|nr|eletronico))?|n(r|u|um|o|ro|umero)_?(prontuario|atendimento|internacao|aih|guia|carteirinha|beneficiario_?plano|registro_?paciente)|aih|autorizacao_?(de_?)?internacao|numero_?(da_?)?guia|guia_?(tiss|sadt|internacao)|carteirinha_?(plano|convenio|saude)|matricula_?(convenio|plano)|cod_?(beneficiario|paciente)_?(ans|plano|convenio)|registro_?(do_?)?paciente|id_?paciente|codigo_?paciente|n(r|u)_?receita|receita_?(numero|controlada)|notificacao_?(sinan|numero)|nu_?notific|laudo_?(numero|nr)', 0.85],
    ['atendimento|internacao|guia|episodio', 0.55],
  ))

const ICD10 = ['I10', 'E11', 'E78', 'J45', 'J06', 'J02', 'J20', 'K29', 'K21', 'K59', 'M54', 'M17', 'M25', 'N39', 'N20', 'R51', 'R10', 'H10', 'H66', 'L23', 'L30', 'B34', 'A09', 'E03', 'E66', 'D50', 'I83', 'K80', 'K40', 'S93', 'S60', 'Z00', 'J30', 'J32', 'G43', 'M79', 'R05']
const ICD10_DECIMAL = ['E11.9', 'E78.5', 'J45.9', 'J06.9', 'J02.9', 'J20.9', 'K29.7', 'K21.9', 'K59.0', 'M54.5', 'M17.9', 'N39.0', 'N20.0', 'R10.4', 'H10.9', 'H66.9', 'L23.9', 'L30.9', 'B34.9', 'A09.9', 'E03.9', 'E66.9', 'D50.9', 'I83.9', 'K80.2', 'K40.9', 'S93.4', 'S60.0', 'Z00.0', 'J30.4', 'J32.9', 'G43.9', 'M79.1']
decompose('BR_DIAGNOSTICO', [
  [String.raw`([A-TV-Za-tv-z]\d{2}\.\d{1,2})`, apply(lookup('BR_CID10_DECIMAL', 'br-cid10-decimal.txt', ICD10_DECIMAL, undefined, 'PRESERVE_LOOKUP_FILE'))],
  // DATASUS writes the subcategory without the dot: E119.
  [String.raw`([A-TV-Za-tv-z]\d{2,3})`, apply(lookup('BR_CID10', 'br-cid10.txt', ICD10, undefined, 'PRESERVE_LOOKUP_FILE'))],
  [FLAG, apply('BR_FLAG')],
], apply(lookup('BR_DIAGNOSTICO_TEXTO', 'br-diagnosticos.txt', ['Hipertensão essencial', 'Diabetes mellitus tipo 2', 'Asma', 'Lombalgia', 'Gastrite crônica', 'Nasofaringite aguda', 'Infecção do trato urinário', 'Enxaqueca', 'Hipotireoidismo', 'Dislipidemia', 'Obesidade', 'Artrose do joelho', 'Bronquite aguda', 'Amigdalite aguda', 'Dermatite de contato', 'Otite média aguda', 'Entorse do tornozelo', 'Conjuntivite', 'Anemia ferropriva', 'Doença do refluxo gastroesofágico', 'Síndrome do intestino irritável', 'Tendinite', 'Sinusite aguda', 'Cefaleia tensional', 'Varizes', 'Hérnia inguinal', 'Cálculo renal', 'Colelitíase', 'Gastroenterite aguda', 'Consulta de rotina'])), 'F33.1')
domain('BR_SAUDE_DIAGNOSTICO', 'BR_DIAGNOSTICO',
  byName(['diagnostico[a-z_]*|cid(_?(10|11|principal|secundario|obito|afastamento|atestado|internacao))?|(cd|co|ds)_?cid|cid_?(cd|co|ds)|hipotese_?diagnostica|doenca[a-z_]*|agravo|comorbidade[a-z_]*|patologia|condicao_?(de_?)?saude|causa_?(do_?)?(obito|afastamento|internacao|basica)|motivo_?(do_?)?(afastamento|atestado|internacao|consulta)|queixa_?principal|alergias?|doencas?_?pre_?existentes?|historico_?(medico|clinico|familiar)|diagnos(is|es)|icd_?(10|11)?', 0.85]),
  // 0.5: codes shaped like ICD-10 appear in other catalogs too; the name has to agree.
  byPattern([[String.raw`[A-TV-Za-tv-z]\d{2}(\.\d{1,2}|\d)?`, 0.5]], { reject: 0.3 }))

const MEDICATIONS = ['Losartana potássica', 'Metformina', 'Omeprazol', 'Sinvastatina', 'Hidroclorotiazida', 'Dipirona', 'Paracetamol', 'Ibuprofeno', 'Amoxicilina', 'Anlodipino', 'Captopril', 'Enalapril', 'Atenolol', 'Levotiroxina', 'Salbutamol', 'Prednisona', 'Azitromicina', 'Cefalexina', 'Ácido acetilsalicílico', 'Glibenclamida', 'Loratadina', 'Dexametasona', 'Sulfato ferroso', 'Ácido fólico', 'Complexo vitamínico']
categorical('BR_MEDICAMENTO', 'br-medicamentos.txt', MEDICATIONS, 'Sertralina 50 mg')
domain('BR_SAUDE_MEDICAMENTO', 'BR_MEDICAMENTO',
  byName(['medicamentos?(_?(uso|prescrito|continuo|nome|dispensado))?|remedios?|farmacos?|principio_?ativo|prescricao(_?medicamento)?|posologia|receita_?(medicamento|item)|uso_?continuo|(cd|co|ds|no)_?medicamento|medications?|drugs?_?prescribed', 0.85]),
  byList([['br-detectar-medicamentos.txt', [...MEDICATIONS, 'losartana', 'sertralina', 'fluoxetina', 'escitalopram', 'quetiapina', 'clonazepam', 'rivotril', 'alprazolam', 'diazepam', 'carbonato de lítio', 'lítio', 'metilfenidato', 'ritalina', 'risperidona', 'olanzapina', 'haloperidol', 'tenofovir', 'lamivudina', 'dolutegravir', 'efavirenz', 'insulina', 'varfarina', 'levetiracetam', 'ácido valproico', 'misoprostol', 'levonorgestrel', 'anticoncepcional', 'dipirona sódica'], 0.7]], { reject: 0.3 }))

domain('BR_SAUDE_TEXTO_CLINICO', 'BR_TEXTO_LIVRE',
  byName(['anamnese|evolucao(_?(clinica|medica|enfermagem))?|historia_?(clinica|da_?doenca_?atual)|hda|exame_?fisico|conduta(_?medica)?|plano_?terapeutico|sumario_?(de_?)?alta|resumo_?(de_?)?alta|laudo(_?(texto|descricao|medico))?|prescricao_?texto|notas?_?(clinicas|medicas|enfermagem)|observac(ao|oes)_?(clinicas?|medicas?|enfermagem)|triagem(_?texto)?|epicrise|parecer_?medico|clinical_?notes?|discharge_?summary', 0.85]),
  byType(STRING(30)))

domain('BR_SAUDE_RESULTADO_EXAME', 'BR_CM_ALFANUM',
  byName(
    ['resultado_?(do_?)?(exame|teste|laboratorio|laboratorial|hiv|covid|pcr|sorologia|biopsia|glicemia)|exame_?(resultado|laboratorial)|hiv(_?(status|resultado|teste))?|carga_?viral|cd4|glicemia|hemoglobina_?glicada|hba1c|colesterol|imc|pressao_?arterial|pa_?(sistolica|diastolica)|teste_?(de_?)?gravidez|toxicologico|antidoping|sorologia|lab_?results?|test_?results?', 0.8],
    ['resultado|teste', 0.5],
  ))

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']
lookup('BR_TIPO_SANGUINEO', 'br-tipos-sanguineos.txt', BLOOD_GROUPS, 'O+', 'PRESERVE_LOOKUP_FILE')
domain('BR_SAUDE_TIPO_SANGUINEO', 'BR_TIPO_SANGUINEO',
  byName(['tipo_?sangu[ií]neo|grupo_?sangu[ií]neo|tipagem_?sangu[ií]nea|fator_?rh|abo(_?rh)?|tipo_?(de_?)?sangue|blood_?(type|group)', 0.9]),
  byList([['br-detectar-tipos-sanguineos.txt', [...BLOOD_GROUPS, '0+', '0-', 'a positivo', 'a negativo', 'b positivo', 'b negativo', 'ab positivo', 'ab negativo', 'o positivo', 'o negativo'], 0.9]], { reject: 0.4 }))

// Disability as the Lei Brasileira de Inclusão and the census record it.
const DISABILITIES = ['Física', 'Visual', 'Auditiva', 'Intelectual', 'Mental ou psicossocial', 'Múltipla', 'Nenhuma']
categorical('BR_DEFICIENCIA', 'br-deficiencias.txt', DISABILITIES, 'Transtorno do espectro autista')
domain('BR_SAUDE_DEFICIENCIA', 'BR_DEFICIENCIA',
  byName(['deficiencia[a-z_]*|(tp|cd|co|ds|in|fl)_?deficiencia|pcd|pessoa_?com_?deficiencia|portador_?(de_?)?(deficiencia|necessidades_?especiais)|necessidades?_?especia(l|is)|laudo_?pcd|mobilidade_?reduzida|tea|autismo|disabilit(y|ies)', 0.9]),
  byList([['br-detectar-deficiencias.txt', [...DISABILITIES, 'física', 'motora', 'visual', 'cegueira', 'baixa visão', 'auditiva', 'surdez', 'intelectual', 'mental', 'psicossocial', 'múltipla', 'autismo', 'tea', 'nenhuma', 'não possui', 'reabilitado'], 0.6]], { reject: 0.3 }))

// Occupational health: medical fitness exams (ASO), work accident reports (CAT), sick leave.
categorical('BR_SAUDE_OCUPACIONAL', 'br-aptidao.txt', ['Apto', 'Apto com restrições', 'Inapto', 'Não avaliado'], 'Inapto temporariamente')
domain('BR_SAUDE_OCUPACIONAL', 'BR_SAUDE_OCUPACIONAL',
  byName(['aso(_?(resultado|conclusao|parecer))?|atestado_?(de_?)?saude_?ocupacional|aptidao(_?(medica|laboral))?|resultado_?(do_?)?aso|parecer_?(medico_?)?ocupacional|cat(_?(numero|tipo|acidente))?|comunicacao_?(de_?)?acidente_?(de_?)?trabalho|acidente_?(de_?)?trabalho|afastamento_?(medico|inss|doenca|motivo)|licenca_?(medica|saude|maternidade)|atestado_?medico|dias_?(de_?)?atestado|motivo_?afastamento', 0.85]),
  byList([['br-detectar-aptidao.txt', ['apto', 'inapto', 'apto com restrições', 'apto com restricao', 'inapto temporariamente'], 0.6]], { reject: 0.3 }))

// Reproductive and mental health: the values have no shared vocabulary, so they are suppressed
// (flags and numeric codes keep their shape).
domain('BR_SAUDE_REPRODUTIVA', 'BR_CATEGORIA_SUPRIMIDA',
  byName(['gestante|gravidez|gestacao|idade_?gestacional|semanas_?(de_?)?gestacao|dum|data_?(da_?)?ultima_?menstruacao|pre_?natal|aborto|abortamento|parto(_?tipo)?|tipo_?(de_?)?parto|puerperio|metodo_?contraceptivo|contracepcao|anticoncepcao|planejamento_?familiar|fertilidade|infertilidade|fertilizacao|fiv|ist|dst|infeccoes?_?sexualmente_?transmissive(l|is)|pregnan(t|cy)|contracepti(on|ve)', 0.9]))

domain('BR_SAUDE_MENTAL', 'BR_CATEGORIA_SUPRIMIDA',
  byName(['saude_?mental|transtorno[a-z_]*|psiquiatri[a-z_]*|psicolog[a-z_]*|depressao|ansiedade|suicid[a-z_]*|autolesao|automutilacao|dependencia_?(quimica|alcool|drogas)|uso_?(de_?)?(alcool|drogas|substancias)|alcoolismo|tabagismo|caps(_?(ad|i))?|internacao_?psiquiatrica|mental_?health', 0.9]))

// ── FIN · Financial and credit data ─────────────────────────────────────────

decompose('BR_CREDITO', [
  // A score (0 to 1000) keeps its number of digits; flags stay flags.
  [String.raw`(\d{1,4})`, DIGITS],
  [FLAG, apply('BR_FLAG')],
], apply(lookup('BR_SITUACAO_CREDITO', 'br-situacoes-credito.txt', ['Em dia', 'Atraso de 30 dias', 'Atraso de 60 dias', 'Atraso de 90 dias', 'Inadimplente', 'Negativado', 'Em cobrança', 'Renegociado', 'Baixado como prejuízo', 'Sem histórico'])), 'Negativado no Serasa')
domain('BR_FIN_CREDITO', 'BR_CREDITO',
  byName(['score(_?(credito|serasa|spc|boa_?vista|quod|interno))?|pontuacao_?(de_?)?credito|rating_?(de_?)?credito|risco_?(de_?)?credito|nota_?(de_?)?credito|cadastro_?positivo|negativad[oa]|negativacao|restricao(_?(cpf|credito|spc|serasa))?|protesto|inadimplen(te|cia)|dias_?(de_?)?atraso|atraso_?dias|situacao_?(do_?)?(credito|contrato|pagamento)|classificacao_?risco|credit_?score|credit_?rating', 0.9]))

algorithm('BR_VALOR_DIVIDA', 'characterMapping.NumericMapping', { minValue: 200, maxValue: 1000000 }, '8500')
domain('BR_FIN_DIVIDA', 'BR_VALOR_DIVIDA',
  byName(['saldo_?devedor|valor_?(da_?)?(divida|debito|parcela|financiamento|emprestimo|em_?atraso|atrasado)|vl_?(divida|debito|parcela|saldo_?devedor|atraso)|divida(_?total)?|debito_?total|limite_?(de_?)?credito|limite_?cartao|prestacao|parcela(_?mensal)?|loan_?(amount|balance)|outstanding_?balance|debt', 0.85]),
  byType(NUMBER()))

algorithm('BR_RENDA', 'characterMapping.NumericMapping', { minValue: 1500, maxValue: 50000 }, '3200')
domain('BR_FIN_RENDA', 'BR_RENDA',
  byName(['salario(_?(base|bruto|liquido|mensal|contratual))?|vl_?(salario|renda|remuneracao|provento)|renda(_?(mensal|familiar|bruta|liquida|per_?capita|comprovada|presumida))?|remuneracao|proventos|vencimentos?(_?basico)?|faturamento_?(mensal|anual)_?(pf|pessoa)|rendimento(_?(mensal|anual|tributavel))?|ganho_?mensal|salary|income|wages?', 0.85]),
  byType(NUMBER()))

algorithm('BR_PATRIMONIO', 'characterMapping.NumericMapping', { minValue: 20000, maxValue: 5000000 }, '185000')
domain('BR_FIN_PATRIMONIO', 'BR_PATRIMONIO',
  byName(['patrimonio(_?(liquido|total))?|valor_?(do_?)?(imovel|patrimonio|bens|veiculo|venal|investimento|aplicacao)|vl_?(imovel|patrimonio|bens|venal|investimento|aplicacao)|saldo_?(conta|poupanca|investimento|aplicacao|fgts)|bens_?(e_?direitos|declarados)|declaracao_?(de_?)?bens|saldo_?fgts|net_?worth|account_?balance', 0.85]),
  byType(NUMBER()))

algorithm('BR_VALOR_BENEFICIO', 'characterMapping.NumericMapping', { minValue: 1500, maxValue: 8000 }, '1800')
domain('BR_FIN_VALOR_BENEFICIO', 'BR_VALOR_BENEFICIO',
  byName(['valor_?(do_?)?(beneficio|aposentadoria|pensao|auxilio|bolsa|bpc)|vl_?(beneficio|aposentadoria|pensao|auxilio|bpc)|renda_?mensal_?inicial|rmi|pensao_?alimenticia|aposentadoria_?valor|pension_?amount', 0.9]),
  byType(NUMBER()))

// The INSS benefit type. Many reveal health — temporary incapacity (31, 91), permanent incapacity
// (32, 92), BPC for disability (87) — or a pregnancy (80). The benefit number is masked digit by digit.
const INSS_BENEFITS = ['Aposentadoria por idade', 'Aposentadoria por tempo de contribuição', 'Aposentadoria especial', 'Aposentadoria por incapacidade permanente', 'Auxílio por incapacidade temporária', 'Auxílio-acidente', 'Pensão por morte', 'Salário-maternidade', 'BPC ao idoso', 'BPC à pessoa com deficiência', 'Nenhum']
categorical('BR_BENEFICIO_INSS', 'br-beneficios-inss.txt', INSS_BENEFITS, 'Auxílio-reclusão', ['21', '31', '32', '36', '41', '42', '46', '80', '87', '88', '91', '92', '93', '94'])
domain('BR_FIN_BENEFICIO_INSS', 'BR_BENEFICIO_INSS',
  byName(['especie_?(do_?)?beneficio|(cd|co|tp|ds)_?especie(_?beneficio)?|tipo_?(de_?)?beneficio(_?(inss|previdenciario))?|beneficio_?(inss|previdenciario)(_?(tipo|especie))?|natureza_?beneficio|b(31|91|32|92|87|88|41|42)', 0.9]),
  byList([['br-detectar-beneficios-inss.txt', [...INSS_BENEFITS, 'aposentadoria', 'auxílio-doença', 'auxilio doenca', 'aposentadoria por invalidez', 'pensão por morte', 'salário maternidade', 'bpc', 'loas', 'auxílio-acidente', 'auxílio-reclusão', 'B31', 'B91', 'B41', 'B42', 'B87', 'B88'], 0.8],
    ['br-detectar-codigos-beneficios-inss.txt', ['21', '31', '32', '36', '41', '42', '46', '80', '87', '88', '91', '92', '93', '94'], 0.5],
  ], { reject: 0.4 }))

domain('BR_FIN_NUMERO_BENEFICIO', 'BR_CM_DIGITOS',
  byName(['n(r|u|um|o|ro|umero)_?(do_?)?beneficio|nb(_?(inss|beneficio))?|numero_?beneficio_?inss|beneficio_?numero|matricula_?(inss|beneficio)', 0.85]),
  byPattern([[String.raw`\d{3}\.\d{3}\.\d{3}-\d`, 0.5]], { reject: 0.3 }))

// Social programmes of 2026 and the Cadastro Único. Being a beneficiary tells about income.
const PROGRAMMES = ['Bolsa Família', 'Benefício de Prestação Continuada', 'Auxílio Gás dos Brasileiros', 'Pé-de-Meia', 'Tarifa Social de Energia Elétrica', 'Minha Casa, Minha Vida', 'Garantia-Safra', 'Seguro-Defeso', 'Nenhum']
categorical('BR_PROGRAMA_SOCIAL', 'br-programas-sociais.txt', PROGRAMMES, 'Auxílio Brasil')
domain('BR_FIN_PROGRAMA_SOCIAL', 'BR_PROGRAMA_SOCIAL',
  byName(['bolsa_?familia|beneficiario_?(bolsa|programa|bpc|auxilio)|programa_?(social|governo|transferencia_?renda)|auxilio_?(brasil|emergencial|gas)|cad_?unico|cadunico|cadastro_?unico|inscrito_?cadunico|pe_?de_?meia|tarifa_?social|bpc|loas|minha_?casa_?minha_?vida|mcmv|seguro_?defeso|garantia_?safra|transferencia_?(de_?)?renda|social_?programme', 0.9]),
  byList([['br-detectar-programas-sociais.txt', [...PROGRAMMES, 'bolsa família', 'bpc', 'loas', 'auxílio brasil', 'auxílio emergencial', 'auxílio gás', 'pé de meia', 'tarifa social', 'mcmv', 'cadúnico', 'nenhum'], 0.8],
    // Being a beneficiary is often a yes/no flag: it backs up the column name but decides nothing alone.
    ['br-detectar-flag.txt', ['s', 'n', 'sim', 'não', 'y', '0', '1'], 0.3],
  ], { reject: 0.4 }))

// Income bracket: the Cadastro Único brackets, the ABEP socioeconomic classes, deciles and quintiles.
decompose('BR_FAIXA_RENDA', [
  [String.raw`([1-5])`, apply(lookup('BR_QUINTIL', 'br-quintil.txt', ['1', '2', '3', '4', '5']))],
  [String.raw`([6-9]|10)`, apply(lookup('BR_DECIL_ALTO', 'br-decil-alto.txt', ['6', '7', '8', '9', '10']))],
  [String.raw`(?i)(decil\s*)(\d{1,2})`, keep, apply(lookup('BR_DECIL', 'br-decil.txt', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']))],
  [String.raw`(?i)(quintil\s*)([1-5])`, keep, apply('BR_QUINTIL')],
  [String.raw`(?i)(classe\s*)?(A|B1|B2|C1|C2|D-E|DE|D|E)`, keep, apply(lookup('BR_CLASSE_SOCIAL', 'br-classes-sociais.txt', ['A', 'B1', 'B2', 'C1', 'C2', 'DE'], undefined, 'PRESERVE_LOOKUP_FILE'))],
], apply(lookup('BR_FAIXA_CADUNICO', 'br-faixas-cadunico.txt', ['Extrema pobreza', 'Pobreza', 'Baixa renda', 'Acima de meio salário mínimo'], undefined, 'PRESERVE_LOOKUP_FILE')), 'Extrema pobreza')
domain('BR_FIN_FAIXA_RENDA', 'BR_FAIXA_RENDA',
  byName(['faixa_?(de_?)?renda(_?(familiar|per_?capita|cadunico))?|faixa_?salarial|classe_?(social|economica|socioeconomica)|criterio_?brasil|nivel_?socioeconomico|situacao_?(de_?)?(pobreza|vulnerabilidade)|pobreza|extrema_?pobreza|vulnerabilidade_?social|renda_?per_?capita_?faixa|quintil|decil|income_?(bracket|quintile|decile)', 0.9]),
  byList([['br-detectar-faixas-renda.txt', ['extrema pobreza', 'pobreza', 'baixa renda', 'acima de meio salário mínimo', 'classe a', 'classe b', 'classe c', 'classe d', 'classe e', 'a', 'b1', 'b2', 'c1', 'c2', 'de'], 0.4]], { reject: 0.3 }))

// Housing as the census and the Cadastro Único ask it.
const TENURES = ['Próprio quitado', 'Próprio em pagamento', 'Alugado', 'Cedido', 'Ocupação', 'Outra']
categorical('BR_MORADIA', 'br-condicoes-moradia.txt', TENURES, 'Invasão')
domain('BR_FIN_MORADIA', 'BR_MORADIA',
  byName(['condicao_?(de_?)?(ocupacao|moradia)|situacao_?(do_?)?(domicilio|imovel|moradia)|tipo_?(de_?)?moradia|posse_?(do_?)?imovel|imovel_?(proprio|alugado)|reside_?em_?imovel|moradia_?(propria|alugada)|domicilio_?(proprio|alugado)|housing_?tenure', 0.9]),
  byList([['br-detectar-moradia.txt', [...TENURES, 'próprio', 'própria', 'alugado', 'alugada', 'aluguel', 'cedido', 'cedida', 'financiado', 'financiada', 'ocupação', 'invasão', 'situação de rua'], 0.6]], { reject: 0.3 }))

// ── PENAL · Criminal records and court cases ────────────────────────────────

categorical('BR_ANTECEDENTES', 'br-antecedentes.txt', ['Nada consta', 'Consta registro', 'Indiciado', 'Denunciado', 'Absolvido', 'Condenado', 'Extinta a punibilidade', 'Não informado'], 'Condenado por furto em 2019')
domain('BR_PENAL_ANTECEDENTES', 'BR_ANTECEDENTES',
  byName(
    ['antecedentes?(_?(criminais|criminal|penais))?|certidao_?(de_?)?antecedentes|atestado_?(de_?)?antecedentes|folha_?(de_?)?antecedentes|ficha_?criminal|registro_?criminal|condenac(ao|oes)(_?(criminal|penal))?|condenado|crime(_?(tipo|natureza))?|tipo_?(de_?)?crime|delito|infracao_?penal|artigo_?(penal|cp)|tipificacao_?penal|indiciamento|indiciado|reincidente|situacao_?(prisional|carceraria|penal)|regime_?(prisional|de_?cumprimento)|preso|presidiario|egresso_?(prisional|sistema)|medida_?socioeducativa|tornozeleira|monitoramento_?eletronico|mandado_?(de_?)?prisao|criminal_?record', 0.95],
    ['situacao_?processual|resultado_?(do_?)?processo|sentenca', 0.55],
  ))

// Court case numbers (numeração única, Resolução CNJ 65/2008): NNNNNNN-DD.AAAA.J.TR.OOOO. The
// sequence is masked; year, branch of the judiciary, court and origin stay. Police reports and
// inquiries are masked character by character.
decompose('BR_PROCESSO', [
  [String.raw`(\d{7})(-?)(\d{2})(\.?\d{4}\.?\d\.?\d{2}\.?\d{4})`, DIGITS, keep, DIGITS, keep],
], CM, '0001234-56.2023.8.26.0100')
domain('BR_PENAL_PROCESSO', 'BR_PROCESSO',
  byName(
    ['n(r|u|um|o|ro|umero)_?(do_?)?processo(_?(judicial|criminal|penal|cnj|trabalhista))?|processo_?(judicial|criminal|penal|cnj|numero|trabalhista)|numeracao_?unica|(nr|nu|num)_?cnj|n(r|u|um|o|ro|umero)_?(bo|boletim|boletim_?ocorrencia|inquerito|ip|termo_?circunstanciado|tco|execucao_?penal|mandado)|boletim_?(de_?)?ocorrencia|inquerito(_?policial)?(_?numero)?|autos_?(numero|n)', 0.9],
    ['processo|protocolo_?judicial', 0.5],
  ),
  byPattern([[String.raw`\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}`, 0.9]], { reject: 0.3 }))

// ── Preset ──────────────────────────────────────────────────────────────────

const referenced = JSON.stringify([domains, algorithms.map((x) => x.config)])
const orphans = algorithms.filter((a) => !referenced.includes(`"${a.name}"`))
if (orphans.length) throw new Error(`algorithms nobody uses: ${orphans.map((a) => a.name).join(', ')}`)
const noInput = algorithms.filter((a) => a.input === undefined)
if (noInput.length) throw new Error(`algorithms without a sample input: ${noInput.map((a) => a.name).join(', ')}`)

// The essential pack: identity documents, names, contact, address and birth date. Loading it brings
// these domains and only what they lean on; the extended pack is everything.
const ESSENTIAL = [
  'BR_L1_CPF', 'BR_L1_RG', 'BR_L1_CNH', 'BR_L1_PASSAPORTE',
  'BR_L1_NOME', 'BR_L1_SOBRENOME', 'BR_L1_NOME_COMPLETO', 'BR_L1_EMAIL', 'BR_L1_TELEFONE',
  'BR_L1_ENDERECO', 'BR_L1_ENDERECO_COMPLEMENTO', 'BR_L2_CEP', 'BR_L2_DATA_NASCIMENTO',
]
const notDomains = ESSENTIAL.filter((name) => !domains.some((d) => d.name === name))
if (notDomains.length) throw new Error(`essential pack names domains the set does not have: ${notDomains.join(', ')}`)

const VERSION = 1
const preset = {
  version: VERSION,
  name: {
    en: 'Brazil — LGPD, Lei 13.709/2018 (personal data protection)',
    'pt-BR': 'Brasil — LGPD, Lei 13.709/2018 (proteção de dados pessoais)',
    es: 'Brasil — LGPD, Ley 13.709/2018 (protección de datos personales)',
  },
  summary: {
    en: 'Discovers and masks Brazilian personal data under the LGPD: direct identifiers (CPF, CNPJ, voter card, PIS and CNS with valid check digits, RG, CNH, names, contact, PIX key), quasi-identifiers (birth date, municipality, CEP), the sensitive personal data of article 5, II — racial or ethnic origin, religion, politics, trade unions, health, sexual life, genetic and biometric data — and financial data and criminal records.',
    'pt-BR': 'Descobre e mascara dados pessoais brasileiros segundo a LGPD: identificadores diretos (CPF, CNPJ, título de eleitor, PIS e CNS com dígito verificador válido, RG, CNH, nomes, contato, chave PIX), quase-identificadores (data de nascimento, município, CEP), os dados pessoais sensíveis do artigo 5º, II — origem racial ou étnica, religião, política, sindicato, saúde, vida sexual, dados genéticos e biométricos — e dados financeiros e antecedentes criminais.',
    es: 'Descubre y enmascara datos personales brasileños conforme a la LGPD: identificadores directos (CPF, CNPJ, título electoral, PIS y CNS con dígito verificador válido, RG, CNH, nombres, contacto, clave PIX), cuasi-identificadores (fecha de nacimiento, municipio, CEP), los datos personales sensibles del artículo 5, II — origen racial o étnico, religión, política, sindicato, salud, vida sexual, datos genéticos y biométricos — y datos financieros y antecedentes penales.',
  },
  profileSet: {
    name: `BR - LGPD - v${VERSION}`,
    description: 'Identificadores diretos, quase-identificadores, dados pessoais sensíveis (art. 5º, II), dados de saúde, dados financeiros e de crédito, e antecedentes criminais, segundo a Lei Geral de Proteção de Dados Pessoais (Lei 13.709/2018).',
    threshold: 60,
    classifiers: classifiers.map((c) => c.name),
  },
  packs: {
    essential: {
      description: 'Pacote essencial da LGPD: CPF, RG, CNH, passaporte, nomes, contato, endereço, CEP e data de nascimento.',
      domains: ESSENTIAL,
    },
  },
  classifiers,
  domains,
  algorithms,
  files: [...files.keys()].sort(),
}

fs.rmSync(FILES, { recursive: true, force: true })
fs.mkdirSync(FILES, { recursive: true })
for (const [name, lines] of files) fs.writeFileSync(nodePath.join(FILES, name), `${lines.join('\n')}\n`)
fs.writeFileSync(nodePath.join(HERE, 'preset.json'), `${JSON.stringify(preset, null, 2)}\n`)

console.log(`${domains.length} domains, ${classifiers.length} classifiers, ${algorithms.length} algorithms, ${files.size} files`)
console.log(`municipalities: ${small.length} of ${MUNICIPALITIES.length} under ${SMALL_MUNICIPALITY}, ${municipalityPairs.length} names generalized`)
