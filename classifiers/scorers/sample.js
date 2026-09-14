'use strict';

/** Heaviest first; items of equal weight keep their configured order. */
const heaviestFirst = (items) => items.slice().sort((a, b) => b.weight - a.weight);

/**
 * Scores every value of a sample and sums it up: the classifier's score is the mean of the value
 * scores, and its hits are the values that scored above zero.
 */
function scoreSample(values, scoreValue) {
  const rows = values.map(scoreValue);
  let total = 0;
  let hits = 0;
  for (const row of rows) {
    total += row.score;
    if (row.score > 0) hits++;
  }
  return { score: total / rows.length, hits, explain: { rows } };
}

module.exports = { heaviestFirst, scoreSample };
