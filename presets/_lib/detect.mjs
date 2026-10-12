/**
 * Detection helpers shared by the preset builders: what lets a classifier find a value however the
 * database stores it.
 *
 * The profiler tests sampled values exactly as they come — it drops empty ones, but trims nothing
 * — and databases pad: a CHAR column fills the value with spaces up to its length, and a numeric
 * code kept as text often comes with zeros on the left. So:
 *
 *   - every value-format pattern first removes the white space around the value (TRIM, cleaning);
 *   - a pattern that starts with a digit also accepts zeros on the left (zeroPadded);
 *   - a list of known values is matched so that padding does not hide a value. A
 *     List classifier compares the whole value, spaces included, unless it splits the value into
 *     words — and splitting drops the padding. A list of single words is therefore looked up word
 *     by word; a list with multi-word values (place names, categories) becomes a Regex classifier
 *     whose patterns hold the values as a prefix tree, case-insensitive also for accented letters.
 */

import { engineSafe } from './engine-text.mjs'

export const TRIM = String.raw`^\s+|\s+$`

/** A pattern's clean-up expression, with the surrounding white space always removed. */
export const cleaning = (clean) => (clean ? `${clean}|${TRIM}` : TRIM)

/**
 * A pattern that starts with a digit — or with a plus sign, as telephone patterns do — also matches
 * the value with zeros on the left. Opening groups are looked through: (0[1-9]|1\d)… starts with a
 * digit too.
 */
const DIGIT_FIRST = /^([0-9]|\\d|\[[0-9]|\\\+)/
const digitFirst = (regex) => DIGIT_FIRST.test(regex.replace(/^(\((\?:)?)+/, ''))
export const zeroPadded = (regex) => (digitFirst(regex) ? `0*(?:${regex})` : regex)

/**
 * The masking side of the same padding: a Regex Decompose pattern that starts with a digit takes
 * the zeros on the left that the pattern itself cannot hold in a group of its own, kept as they are.
 * The group is lazy, so a value the pattern matched before matches as before — a fixed-length
 * number keeps its own zeros — and only the excess is padding. The rest masks as the bare value
 * does, so a value in a zero-filled CHAR still joins its twin kept as a number.
 *
 * Only for the Regex Decompose at the top of a domain, which sees the value as the column holds it.
 * Further down, a step may read a digit at a fixed position, and an optional zero would let it read
 * the wrong one.
 */
export function keepingZeros(regex, actions) {
  if (/^\(0[*+]\)/.test(regex) || !digitFirst(regex)) return { regex, actions }
  return { regex: `(0*?)(?:${regex})`, actions: [{ type: 'PRESERVE' }, ...actions] }
}

const ESCAPE = /[.*+?^${}()|[\]\\]/g
const LIMIT = 60000

/** The words as one alternation, sharing their common prefixes. */
function tree(words) {
  const root = new Map()
  for (const word of words) {
    let node = root
    for (const ch of word) {
      if (!node.has(ch)) node.set(ch, new Map())
      node = node.get(ch)
    }
    node.set('', null)
  }
  const emit = (node) => {
    const end = node.has('')
    const branches = [...node.keys()].filter((ch) => ch !== '').sort()
      .map((ch) => ch.replace(ESCAPE, '\\$&') + emit(node.get(ch)))
    if (!branches.length) return ''
    // A word that ends here makes the rest optional.
    if (end) return `(?:${branches.join('|')})?`
    return branches.length === 1 ? branches[0] : `(?:${branches.join('|')})`
  }
  return `(?:${emit(root)})`
}

/** Splits the words into groups whose trees fit one pattern (Delphix takes up to 65,536 characters). */
function chunks(words, depth = 0) {
  if (tree(words).length <= LIMIT) return [words]
  const groups = new Map()
  for (const word of words) {
    const key = word.slice(0, depth + 1)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(word)
  }
  const out = []
  let current = []
  for (const group of groups.values()) {
    for (const part of tree(group).length > LIMIT ? chunks(group, depth + 1) : [group]) {
      if (current.length && tree([...current, ...part]).length > LIMIT) {
        out.push(current)
        current = []
      }
      current.push(...part)
    }
  }
  if (current.length) out.push(current)
  return out
}

const isWord = (value) => !/\s/.test(value)
const isNumber = (value) => /^\d+$/.test(value)

/** A list of single words, none of them a number, can stay a List classifier looked up word by word. */
export const wordByWord = (values) => values.every(isWord) && !values.some(isNumber)

/**
 * A list of known values as Regex patterns, without strength.
 *
 *   values   what the list holds (accent-folded variants included)
 *   shown    the values a reader should see, for the patterns' note
 */
export function valuePatterns(values, shown = values) {
  // The note goes to the engine with the pattern, so it keeps clear of the characters the engine
  // refuses in classifier texts (see engine-text.mjs): `346 — Arica · Camarones · …`.
  const distinct = [...new Set(shown)]
  const first = distinct.slice(0, 6).map(engineSafe)
  const note = `${distinct.length} — ${first.join(' · ')}${distinct.length > 6 ? ' · …' : ''}`
  // Numbers lose their zeros on the left, and their pattern adds any number of them back; the rest
  // is compared without regard to case.
  const numbers = [...new Set(values.filter(isNumber).map((v) => v.replace(/^0+(?=\d)/, '')))]
  const words = [...new Set(values.filter((v) => !isNumber(v)).map((v) => v.toLowerCase()))]
  return [
    ...(numbers.length ? chunks(numbers).map((part) => `0*${tree(part)}`) : []),
    ...(words.length ? chunks(words).map((part) => `(?iu)${tree(part)}`) : []),
  ].map((regex) => ({ note, regex, dataCleanRegex: TRIM }))
}
