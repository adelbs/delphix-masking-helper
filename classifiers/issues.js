'use strict';

/**
 * Problems found in a classifier configuration.
 *
 * Each carries a stable `code` the interface translates, `where` it sits ({ list, index, field }),
 * the `params` its wording needs, and an English `message` for logs and API clients. Severity:
 *
 *   error       Delphix would refuse the configuration.
 *   limitation  Delphix accepts it, but this tool cannot evaluate it.
 *   hint        Accepted and evaluable, but probably not what was meant.
 */

const MESSAGES = {
  'unknown-framework': ({ framework }) => `"${framework}" is not a classifier framework.`,
  'config-not-object': () => 'The configuration has to be a JSON object.',
  'unknown-setting': ({ name }) => `"${name}" is not a setting of this framework.`,
  'missing-value': () => 'This value is required.',
  'expects-text': () => 'Expected text.',
  'expects-number': () => 'Expected a number.',
  'expects-whole-number': () => 'Expected a whole number.',
  'expects-true-false': () => 'Expected true or false.',
  'not-an-option': ({ value }) => `${JSON.stringify(value)} is not one of the accepted values.`,
  'below-minimum': ({ min }) => `Use ${min} or more.`,
  'above-maximum': ({ max }) => `Use ${max} or less.`,
  'too-long': ({ max }) => `Keep it within ${max} characters.`,
  'expects-list': () => 'Expected a list of entries.',
  'entry-not-object': () => 'Each entry has to be a JSON object.',
  'list-empty': () => 'Add at least one entry.',
  'blank': () => 'This cannot be left blank.',
  'regex-invalid': ({ detail }) => `Java would not accept this pattern: ${detail}.`,
  'regex-unsupported': ({ detail }) => `Delphix accepts this pattern, but it cannot be tested here: ${detail}.`,
  'duplicate-entry': ({ other }) => `Repeats entry #${other}; Delphix rejects repeated entries.`,
  'date-length': () => 'Date columns carry no length: leave both limits at 0.',
  'sql-type-misplaced': () => 'An SQL type code only applies to JavaSqlType.',
  'sql-type-missing': () => 'JavaSqlType needs the SQL type code to accept.',
  'type-repeated': ({ type, other }) => `${type} is already allowed by entry #${other}.`,
  'file-repeated': ({ other }) => `Entry #${other} already reads this file, so this one adds nothing.`,
  'file-blank': () => 'Choose a file.',
  'file-scheme': () => 'Delphix reads list files only from delphix-file://, file://, http(s):// or jar://file/ addresses.',
  'file-malformed': () => 'The address has spaces or characters that need encoding.',
  'checksum-unsupported': ({ value }) => `The ${value} check cannot be evaluated here.`,
  'regex-anchored': () => '^ and $ are not needed: turn partial matching off to require the whole value.',
  'zero-strength': () => 'With strength 0, a match adds nothing.',
  'looks-like-regex': () => 'This looks like a regular expression, but the match type is EXACT.',
  'empty-delimiter': () => 'With no delimiter each value is one word, so splitting changes nothing.',
  'min-above-max': () => 'The minimum is above the maximum: no column can pass.',
};

function issue(severity, code, where = {}, params = {}) {
  return { severity, code, where, params, message: MESSAGES[code](params) };
}

module.exports = { issue };
