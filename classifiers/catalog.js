'use strict';

/**
 * The settings of the four classifier frameworks, as this tool presents and reads them.
 *
 * Each framework has one repeated `list` — the paths, allowed types, patterns or value lists a
 * classifier is made of — and `settings` for the classifier as a whole. The keys are the ones
 * Delphix uses in a classifier's JSON, so a configuration travels unchanged; everything else here
 * (field kinds, fallbacks, which frameworks read metadata and which read values) is this tool's
 * own description.
 *
 * A field without a `fallback` and marked `required` has to be given; one with a fallback takes
 * it when absent.
 */

const { SUPPORTED_CHECKSUMS } = require('./checksums');

const strength = (key, fallback) => ({ key, kind: 'number', min: 0, max: 1, fallback });
const flag = (key, fallback) => ({ key, kind: 'flag', fallback });
const length = (key) => ({ key, kind: 'integer', min: 0, fallback: 0 });

const CATALOG = {
  PATH: {
    reads: 'metadata',
    list: {
      key: 'paths',
      fields: [
        { key: 'matchType', kind: 'choice', options: ['EXACT', 'REGEX'], required: true },
        { key: 'fieldValue', kind: 'text', required: true, maxChars: 65536 },
        { key: 'parentValue', kind: 'text', fallback: '', maxChars: 65536 },
        strength('matchStrength', 0.5),
        flag('caseSensitive', false),
        flag('allowPartialMatch', true),
      ],
    },
    settings: [strength('rejectStrength', 0)],
  },

  TYPE: {
    reads: 'metadata',
    list: {
      key: 'allowedTypes',
      fields: [
        { key: 'typeName', kind: 'choice', options: ['String', 'Date', 'Number', 'Binary', 'JavaSqlType'], required: true },
        length('minimumLength'),
        length('maximumLength'),
        { key: 'sqlType', kind: 'integer', fallback: 0 },
      ],
    },
    settings: [flag('matchAutoIncrementingColumn', false), strength('matchStrength', 0), strength('rejectStrength', 1)],
  },

  REGEX: {
    reads: 'values',
    list: {
      key: 'dataPatterns',
      fields: [
        { key: 'note', kind: 'text', maxChars: 4000 },
        { key: 'regex', kind: 'text', required: true, maxChars: 65536 },
        strength('matchStrength', 1),
        // Delphix offers more checks than these; a value outside the list is kept, but marks the
        // classifier as not testable here.
        { key: 'checksumType', kind: 'choice', options: SUPPORTED_CHECKSUMS, openEnded: true, fallback: 'NONE' },
        flag('caseSensitive', false),
        flag('allowPartialMatch', true),
        { key: 'dataCleanRegex', kind: 'text', fallback: '', maxChars: 65536 },
      ],
    },
    settings: [strength('rejectStrength', 1)],
  },

  LIST: {
    reads: 'values',
    list: {
      key: 'valueLists',
      fields: [
        { key: 'file', kind: 'file', required: true },
        strength('matchStrength', 1),
      ],
    },
    settings: [
      strength('rejectStrength', 0.5),
      flag('tokenizeInput', false),
      { key: 'tokenizationDelimiter', kind: 'text', fallback: ' ' },
    ],
  },
};

const isFramework = (name) => typeof name === 'string' && Object.hasOwn(CATALOG, name);

module.exports = { CATALOG, isFramework };
