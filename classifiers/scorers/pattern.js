'use strict';

/**
 * REGEX: scores each sampled value against a chain of patterns, heaviest first. A value is first
 * cleaned by the pattern's clean-up expression, then must match — anywhere, or as a whole — and
 * pass the pattern's check digit, if it has one. The first pattern that fully accepts it gives
 * its strength; one that matches but fails the check hands the value on to the next pattern.
 */

const jr = require('../java-regex');
const { checksumPasses } = require('../checksums');
const { heaviestFirst, scoreSample } = require('./sample');

function linkFor(entry, index) {
  const options = { caseInsensitive: !entry.caseSensitive };
  return {
    index,
    weight: entry.matchStrength,
    clean: (value) => (entry.dataCleanRegex ? jr.replaceAll(entry.dataCleanRegex, value, '') : value),
    matches: (value) => (entry.allowPartialMatch ? jr.find(entry.regex, value, options) : jr.matches(entry.regex, value, options)),
    check: (value) => checksumPasses(entry.checksumType, value),
  };
}

module.exports = function patternScorer({ entries, settings }) {
  const chain = heaviestFirst(entries.map(linkFor));

  const scoreValue = (value) => {
    const row = { value, score: -settings.rejectStrength, pattern: null, checksumFailed: [] };
    for (const link of chain) {
      const cleaned = link.clean(value);
      if (!link.matches(cleaned)) continue;
      if (link.check(cleaned)) {
        row.score = link.weight;
        row.pattern = link.index;
        break;
      }
      row.checksumFailed.push(link.index);
    }
    return row;
  };

  return { score: (values) => scoreSample(values, scoreValue) };
};
