'use strict';

/**
 * Confidence arithmetic in 32-bit floats.
 *
 * Profiling keeps confidences as single-precision floats and compares them with a tolerance of
 * one thousandth, so a column that sits right at a threshold can land on either side depending
 * on the representation. Doing the arithmetic the same way keeps those cases honest.
 */

const toFloat = Math.fround;
const TOLERANCE = 0.001;

/** Within a thousandth of zero — close enough not to count. */
const isNegligible = (x) => x > -TOLERANCE && x < TOLERANCE;

/** The shortest decimal text that reads back as exactly this float. */
function shortestDecimal(x) {
  if (x === 0) return '0';
  for (let digits = 1; digits <= 9; digits++) {
    const text = x.toPrecision(digits);
    if (toFloat(Number(text)) === x) return text;
  }
  return x.toPrecision(9);
}

function asScaledInteger(text) {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  const fraction = m[3] || '';
  return {
    units: BigInt(`${m[1]}${(m[2] + fraction).replace(/^0+(?=\d)/, '')}`),
    exponent: Number(m[4] || 0) - fraction.length,
  };
}

/** Adds two floats through their decimal spelling — so 0.9 + -0.1 is 0.8, not 0.79999995 — and
 *  reads the sum back as a float. */
function addAsDecimals(a, b) {
  const x = asScaledInteger(shortestDecimal(a));
  const y = asScaledInteger(shortestDecimal(b));
  const exponent = Math.min(x.exponent, y.exponent);
  const sum = x.units * 10n ** BigInt(x.exponent - exponent) + y.units * 10n ** BigInt(y.exponent - exponent);
  return toFloat(Number(`${sum}e${exponent}`));
}

/** The whole percentage shown for a confidence, rounding halves up. */
const toPercent = (x) => Math.floor(toFloat(toFloat(x * 100) + 0.5));

/** How many whole thousandths `b` lies above `a`, truncated toward zero. */
const thousandthsBetween = (a, b) => Math.trunc(toFloat(toFloat(b - a) * 1000));

module.exports = { toFloat, TOLERANCE, isNegligible, addAsDecimals, toPercent, thousandthsBetween };
