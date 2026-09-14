'use strict';

/**
 * Before a column is examined, the TYPE classifiers of one domain act as a single classifier: the
 * union of their allowed types, each keeping the smallest minimum length any of them set. Nothing
 * else carries over — maximum lengths, SQL type codes, auto-increment acceptance and strengths all
 * return to their fallbacks — so a domain with two TYPE classifiers can behave differently from
 * either of them alone.
 */

const INT_MIN = -2147483648;
const INT_MAX = 2147483647;

/** A length read leniently: numbers truncated, numeric text parsed, anything else 0. */
function lenientLength(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) | 0 : 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'string') return 0;
  const text = value.trim();
  const unsigned = text.startsWith('+') ? text.slice(1) : text;
  if (unsigned === '') return 0;
  if (/^-?\d+$/.test(unsigned)) {
    const n = Number(unsigned);
    return n >= INT_MIN && n <= INT_MAX ? n : 0;
  }
  const n = Number(unsigned);
  return Number.isNaN(n) ? 0 : Math.max(INT_MIN, Math.min(INT_MAX, Math.trunc(n)));
}

/** The configuration the domain's TYPE classifiers act as, given their raw configurations. */
function mergedTypeConfig(configs) {
  const smallest = new Map();
  for (const config of configs) {
    const allowed = Array.isArray(config?.allowedTypes) ? config.allowedTypes : [];
    for (const entry of allowed) {
      const typeName = String(entry?.typeName);
      const min = lenientLength(entry?.minimumLength);
      if (!smallest.has(typeName) || min < smallest.get(typeName)) smallest.set(typeName, min);
    }
  }
  return {
    allowedTypes: [...smallest].map(([typeName, min]) => (min !== 0 ? { typeName, minimumLength: min } : { typeName })),
  };
}

module.exports = { mergedTypeConfig };
