/**
 * What the Masking Engine takes in the text of the objects a preset sends it.
 *
 * The engine refuses any of these characters in the name and the description of a classifier, a
 * profile set and a domain — "Invalid character '(' in field 'description'" — and keeps at most 50
 * characters of a profile set's description, refusing the whole set when there are more ("Input
 * does not match the expected structure"). The Helper swaps the characters for look-alikes and cuts
 * the description when it sends, but an engine user who builds the set by hand, or an older Helper,
 * does not; so the texts of every preset are written to pass as they are, and the build refuses one
 * that would not.
 */

export const REFUSED = /[~!@#$%^&*()"?:;,/\\`+=[\]{}|<>']/
export const SET_DESCRIPTION_MAX = 50

/** Every engine-bound text of a preset that the engine would refuse, as "where: text". */
export function engineTextProblems(preset) {
  const problems = []
  const check = (where, text, max = Infinity) => {
    if (text == null || text === '') return
    if (REFUSED.test(text)) problems.push(`${where} has ${text.match(REFUSED)[0]}: ${text}`)
    if (text.length > max) problems.push(`${where} is ${text.length} characters, over ${max}: ${text}`)
  }
  check('profile set name', preset.profileSet.name, 100)
  check('profile set description', preset.profileSet.description, SET_DESCRIPTION_MAX)
  check('essential pack description', preset.packs?.essential?.description, SET_DESCRIPTION_MAX)
  for (const c of preset.classifiers) {
    check(`classifier name ${c.name}`, c.name, 100)
    check(`classifier ${c.name} description`, c.description)
    for (const p of c.config.dataPatterns ?? []) check(`classifier ${c.name} pattern note`, p.note)
  }
  for (const d of preset.domains) check(`domain name ${d.name}`, d.name)
  for (const a of preset.algorithms) check(`algorithm name ${a.name}`, a.name)
  return problems
}

/** A value as it may appear in a note: the refused characters left out. */
export const engineSafe = (text) => String(text).replace(new RegExp(REFUSED.source, 'g'), ' ').replace(/\s+/g, ' ').trim()
