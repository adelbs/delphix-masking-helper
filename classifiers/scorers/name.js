'use strict';

/**
 * PATH: looks for the column's name, and optionally its table or file name. Rules are tried from
 * the heaviest down; the first one that fits gives its strength. None fitting gives the negative
 * of the reject strength.
 */

const jr = require('../java-regex');
const { heaviestFirst } = require('./sample');

function textTest(caseSensitive, wholeOnly) {
  const fold = caseSensitive ? (s) => s : (s) => s.toLowerCase();
  return (wanted, actual) => (wholeOnly ? fold(actual) === fold(wanted) : fold(actual).includes(fold(wanted)));
}

function patternTest(caseSensitive, wholeOnly) {
  const options = { caseInsensitive: !caseSensitive };
  return (pattern, actual) => (wholeOnly ? jr.matches(pattern, actual, options) : jr.find(pattern, actual, options));
}

function ruleFor(entry, index) {
  const fits = (entry.matchType === 'REGEX' ? patternTest : textTest)(entry.caseSensitive, !entry.allowPartialMatch);
  return {
    index,
    weight: entry.matchStrength,
    // An empty parent value, or a column without a parent, leaves the parent unchecked.
    applies: (name, parent) => fits(entry.fieldValue, name) && (entry.parentValue === '' || parent == null || fits(entry.parentValue, parent)),
  };
}

module.exports = function nameScorer({ entries, settings }) {
  const rules = heaviestFirst(entries.map(ruleFor));
  return {
    score(column) {
      const rule = rules.find((r) => r.applies(column.name, column.parent));
      return rule
        ? { score: rule.weight, hits: 1, explain: { rule: rule.index } }
        : { score: -settings.rejectStrength, hits: 0, explain: { rule: null } };
    },
  };
};
