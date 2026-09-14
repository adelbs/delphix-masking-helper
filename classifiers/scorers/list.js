'use strict';

/**
 * LIST: looks sampled values up in files of known values, ignoring case. A value found in a list
 * scores that list's strength (the heaviest list wins); not found, the negative of the reject
 * strength. When values are split into words, each word is looked up and the value scores the
 * strengths found divided by its number of words.
 */

const { linesOf, splitOnAny } = require('../text');
const { heaviestFirst, scoreSample } = require('./sample');

/** The distinct lines of a list file, lower-cased, with a leading byte-order mark removed. */
function knownValues(text) {
  const known = new Set();
  linesOf(text).forEach((line, i) => {
    known.add((i === 0 && line.startsWith('﻿') ? line.slice(1) : line).toLowerCase());
  });
  return known;
}

module.exports = function listScorer({ entries, settings }, readFile) {
  const lists = heaviestFirst(entries.map((entry, index) => ({
    index,
    weight: entry.matchStrength,
    file: entry.file,
    known: knownValues(readFile(entry.file)),
  })));
  const listHolding = (text) => lists.find((l) => l.known.has(text));
  const miss = -settings.rejectStrength;

  const wholeValue = (value) => {
    const list = listHolding(value.toLowerCase());
    return { value, score: list ? list.weight : miss, list: list ? list.index : null };
  };

  const wordByWord = (value) => {
    const words = splitOnAny(value.toLowerCase(), settings.tokenizationDelimiter).map((word) => {
      const list = listHolding(word);
      return { word, list: list ? list.index : null, weight: list ? list.weight : 0 };
    });
    let total = 0;
    for (const w of words) total += w.weight;
    return {
      value,
      score: total !== 0 ? total / words.length : miss,
      words: words.map(({ word, list }) => ({ word, list })),
    };
  };

  return {
    lists: lists.map((l) => ({ file: l.file, size: l.known.size })),
    score: (values) => scoreSample(values, settings.tokenizeInput ? wordByWord : wholeValue),
  };
};
