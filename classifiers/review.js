'use strict';

/**
 * Everything worth saying about a classifier configuration before it is saved, tested or sent:
 * what Delphix would refuse, what it would accept but this tool cannot evaluate, and what is
 * accepted but likely a mistake.
 */

const jr = require('./java-regex');
const { readConfig } = require('./config');
const { issue } = require('./issues');
const { isBlank } = require('./text');
const { SUPPORTED_CHECKSUMS } = require('./checksums');

// The address forms Delphix opens a value list from. `host` is fixed where given.
const LIST_FILE_ADDRESSES = [
  { scheme: 'delphix-file', host: 'upload' },
  { scheme: 'delphix-file', host: 'mount' },
  { scheme: 'http' },
  { scheme: 'https' },
  { scheme: 'jar', host: 'file' },
  { scheme: 'file' },
];

const at = (list, index, field) => ({ list, index, field });
const present = (entries) => entries.map((entry, index) => [entry, index]).filter(([entry]) => entry);

function patternIssue(source, caseInsensitive, where) {
  if (typeof source !== 'string') return null;
  try {
    jr.validate(source, { caseInsensitive });
    return null;
  } catch (err) {
    if (!(err instanceof jr.JavaRegexError)) throw err;
    return err.kind === 'unsupported'
      ? issue('limitation', 'regex-unsupported', where, { detail: err.message })
      : issue('error', 'regex-invalid', where, { detail: err.message });
  }
}

const anchoredBothEnds = (source) => typeof source === 'string' && source.startsWith('^') && /(^|[^\\])\$$/.test(source);

/** Calls `onRepeat(index, firstIndex)` for every entry whose key was already seen. */
function eachRepeat(entries, keyOf, onRepeat) {
  const first = new Map();
  for (const [entry, index] of present(entries)) {
    const key = keyOf(entry);
    if (first.has(key)) onRepeat(index, first.get(key));
    else first.set(key, index);
  }
}

function fileAddressIssue(value, where) {
  if (typeof value !== 'string') return null;
  if (isBlank(value)) return issue('error', 'file-blank', where);
  if (/[\s"<>\\^`{|}]/.test(value)) return issue('error', 'file-malformed', where);
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/([^/?#]*))?/.exec(value);
  const scheme = m ? m[1] : null;
  const host = m && m[2] ? m[2] : null;
  const known = LIST_FILE_ADDRESSES.some((a) => a.scheme === scheme && (!a.host || a.host === host));
  return known ? null : issue('error', 'file-scheme', where);
}

const RULES = {
  PATH({ entries }, out) {
    for (const [e, i] of present(entries)) {
      if (typeof e.fieldValue === 'string' && isBlank(e.fieldValue)) out.push(issue('error', 'blank', at('paths', i, 'fieldValue')));
      if (e.matchType === 'REGEX') {
        out.push(patternIssue(e.fieldValue, !e.caseSensitive, at('paths', i, 'fieldValue')));
        out.push(patternIssue(e.parentValue, !e.caseSensitive, at('paths', i, 'parentValue')));
        if (anchoredBothEnds(e.fieldValue)) out.push(issue('hint', 'regex-anchored', at('paths', i, 'fieldValue')));
      } else if (typeof e.fieldValue === 'string' && /[\\^$|*+?()[\]{}]/.test(e.fieldValue)) {
        out.push(issue('hint', 'looks-like-regex', at('paths', i, 'fieldValue')));
      }
      if (e.matchStrength === 0) out.push(issue('hint', 'zero-strength', at('paths', i, 'matchStrength')));
    }
    eachRepeat(entries,
      (e) => JSON.stringify([e.matchType, e.fieldValue, e.parentValue, e.caseSensitive, e.allowPartialMatch]),
      (i, first) => out.push(issue('error', 'duplicate-entry', at('paths', i), { other: first + 1 })));
  },

  TYPE({ entries }, out) {
    for (const [e, i] of present(entries)) {
      if (e.typeName === 'Date' && (e.minimumLength || e.maximumLength)) out.push(issue('error', 'date-length', at('allowedTypes', i, 'typeName')));
      if (e.typeName === 'JavaSqlType' && !e.sqlType) out.push(issue('error', 'sql-type-missing', at('allowedTypes', i, 'sqlType')));
      if (e.typeName !== 'JavaSqlType' && e.sqlType) out.push(issue('error', 'sql-type-misplaced', at('allowedTypes', i, 'sqlType')));
      if (e.minimumLength > 0 && e.maximumLength > 0 && e.minimumLength > e.maximumLength) {
        out.push(issue('hint', 'min-above-max', at('allowedTypes', i, 'minimumLength')));
      }
    }
    eachRepeat(entries, (e) => String(e.typeName),
      (i, first) => out.push(issue('error', 'type-repeated', at('allowedTypes', i, 'typeName'), { type: entries[i].typeName, other: first + 1 })));
  },

  REGEX({ entries }, out) {
    for (const [e, i] of present(entries)) {
      if (typeof e.regex === 'string' && isBlank(e.regex)) out.push(issue('error', 'blank', at('dataPatterns', i, 'regex')));
      out.push(patternIssue(e.regex, !e.caseSensitive, at('dataPatterns', i, 'regex')));
      out.push(patternIssue(e.dataCleanRegex, !e.caseSensitive, at('dataPatterns', i, 'dataCleanRegex')));
      if (typeof e.checksumType === 'string' && !SUPPORTED_CHECKSUMS.includes(e.checksumType)) {
        out.push(issue('limitation', 'checksum-unsupported', at('dataPatterns', i, 'checksumType'), { value: e.checksumType }));
      }
      if (anchoredBothEnds(e.regex)) out.push(issue('hint', 'regex-anchored', at('dataPatterns', i, 'regex')));
      if (e.matchStrength === 0) out.push(issue('hint', 'zero-strength', at('dataPatterns', i, 'matchStrength')));
    }
    eachRepeat(entries,
      (e) => JSON.stringify([e.regex, e.checksumType, e.caseSensitive, e.allowPartialMatch]),
      (i, first) => out.push(issue('error', 'duplicate-entry', at('dataPatterns', i), { other: first + 1 })));
  },

  LIST({ entries, settings }, out) {
    for (const [e, i] of present(entries)) {
      out.push(fileAddressIssue(e.file, at('valueLists', i, 'file')));
      if (e.matchStrength === 0) out.push(issue('hint', 'zero-strength', at('valueLists', i, 'matchStrength')));
    }
    // Delphix does not compare list files, so a repeated one is accepted — it just contributes
    // nothing a second time.
    eachRepeat(entries, (e) => String(e.file),
      (i, first) => out.push(issue('hint', 'file-repeated', at('valueLists', i, 'file'), { other: first + 1 })));
    if (settings.tokenizeInput && settings.tokenizationDelimiter === '') {
      out.push(issue('hint', 'empty-delimiter', { field: 'tokenizationDelimiter' }));
    }
  },
};

function reviewClassifier(framework, raw) {
  const read = readConfig(framework, raw);
  const found = [...read.issues];
  if (read.entries) {
    const listKey = { PATH: 'paths', TYPE: 'allowedTypes', REGEX: 'dataPatterns', LIST: 'valueLists' }[framework];
    if (!read.entries.length) found.push(issue('error', 'list-empty', { list: listKey }));
    const out = [];
    RULES[framework](read, out);
    found.push(...out.filter(Boolean));
  }
  return {
    entries: read.entries,
    settings: read.settings,
    errors: found.filter((i) => i.severity === 'error'),
    limitations: found.filter((i) => i.severity === 'limitation'),
    hints: found.filter((i) => i.severity === 'hint'),
  };
}

module.exports = { reviewClassifier };
