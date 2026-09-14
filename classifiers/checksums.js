'use strict';

/**
 * Check digits a REGEX pattern can require of a value, written from the public definition of
 * each scheme:
 *
 *   LUHN       payment card numbers (ISO/IEC 7812): double every second digit from the right
 *   MOD97      IBAN (ISO 13616): move the country and check digits to the end, read letters as
 *              10–35, and the number must leave remainder 1 when divided by 97
 *   MOD10_ABA  US bank routing numbers: weights 3, 7, 1 repeating, total divisible by 10
 *   MOD11_NHS  UK NHS numbers: nine digits weighted 10 down to 2, then an eleven-complement
 *   MOD11_TFN  Australian tax file numbers: weights 1 4 3 7 5 8 6 9 10, total divisible by 11
 *
 * Only these are supported; any other type is refused as unknown. Two conventions hold for all
 * of them, matching how profiling reads values: a digit is any Unicode decimal digit, taken one
 * UTF-16 unit at a time, and a value whose weighted total is zero never passes.
 */

const SUPPORTED_CHECKSUMS = ['NONE', 'LUHN', 'MOD97', 'MOD11_NHS', 'MOD11_TFN', 'MOD10_ABA'];

/** A value holds a character whose numeric meaning this tool does not know. */
class UncheckableValue extends Error {
  constructor(message) {
    super(message);
    this.name = 'UncheckableValue';
  }
}

const isDecimalUnit = (unit) => /\p{Nd}/u.test(String.fromCharCode(unit));

/** The value of one UTF-16 unit as a decimal digit, or -1. Unicode digit blocks run 0–9. */
function decimalDigit(unit) {
  if (unit >= 0x30 && unit <= 0x39) return unit - 0x30;
  if (unit < 0x80 || (unit >= 0xd800 && unit <= 0xdfff) || !isDecimalUnit(unit)) return -1;
  let zero = unit;
  while (isDecimalUnit(zero - 1)) zero--;
  return (unit - zero) % 10;
}

/** All digits of `text`, or null as soon as one unit is not a digit. */
function digitsOf(text) {
  const digits = [];
  for (let i = 0; i < text.length; i++) {
    const d = decimalDigit(text.charCodeAt(i));
    if (d < 0) return null;
    digits.push(d);
  }
  return digits;
}

/** Σ digit × weight, weights applied from the rightmost digit leftwards, cycling. */
function totalFromRight(digits, weights, adjust = (x) => x) {
  let total = 0;
  for (let k = 0; k < digits.length; k++) {
    total += adjust(digits[digits.length - 1 - k] * weights[k % weights.length]);
  }
  return total;
}

/** Σ digit × weight from the left; null when there are more digits than weights. */
function totalFromLeft(digits, weights) {
  if (digits.length > weights.length) return null;
  return digits.reduce((sum, d, i) => sum + d * weights[i], 0);
}

const divisibleTotal = (total, divisor) => total !== null && total !== 0 && total % divisor === 0;

function luhn(text) {
  const digits = digitsOf(text);
  if (!digits || !digits.length) return false;
  return divisibleTotal(totalFromRight(digits, [1, 2], (x) => (x > 9 ? x - 9 : x)), 10);
}

function abaRouting(text) {
  const digits = digitsOf(text);
  if (!digits || !digits.length) return false;
  return divisibleTotal(totalFromRight(digits, [1, 7, 3]), 10);
}

function australianTfn(text) {
  const digits = digitsOf(text);
  if (!digits || !digits.length) return false;
  return divisibleTotal(totalFromLeft(digits, [1, 4, 3, 7, 5, 8, 6, 9, 10]), 11);
}

function ukNhs(text) {
  if (!text) return false;
  const body = digitsOf(text.slice(0, -1));
  if (!body || !body.length) return false;
  const total = totalFromLeft(body, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (!total) return false;
  const expected = (11 - (total % 11)) % 11;
  return expected !== 10 && text.charCodeAt(text.length - 1) - 0x30 === expected;
}

// Superscript and subscript digits carry their digit value too.
const SCRIPT_DIGITS = new Map([
  [0xb2, 2], [0xb3, 3], [0xb9, 1], [0x2070, 0],
  ...Array.from({ length: 6 }, (_, i) => [0x2074 + i, 4 + i]),
  ...Array.from({ length: 10 }, (_, i) => [0x2080 + i, i]),
]);

/** A character's value inside an IBAN: digits as themselves, Latin letters as 10–35. */
function ibanValue(unit) {
  const digit = decimalDigit(unit);
  if (digit >= 0) return digit;
  for (const start of [0x41, 0x61, 0xff21, 0xff41]) {
    if (unit >= start && unit < start + 26) return unit - start + 10;
  }
  if (SCRIPT_DIGITS.has(unit)) return SCRIPT_DIGITS.get(unit);
  if (/\p{N}/u.test(String.fromCharCode(unit))) {
    throw new UncheckableValue(`the numeric value of "${String.fromCharCode(unit)}" is not known here`);
  }
  return -1;
}

function iban(text) {
  if (text.length < 5) return false;
  const checkDigits = text.slice(2, 4);
  if (checkDigits === '00' || checkDigits === '01' || checkDigits === '99') return false;
  const rearranged = text.slice(4) + text.slice(0, 4);
  let remainder = 0;
  for (let i = 0; i < rearranged.length; i++) {
    const value = ibanValue(rearranged.charCodeAt(i));
    if (value < 0) return false;
    remainder = (remainder * (value > 9 ? 100 : 10) + value) % 97;
  }
  return remainder === 1;
}

const CHECKS = { LUHN: luhn, MOD97: iban, MOD11_NHS: ukNhs, MOD11_TFN: australianTfn, MOD10_ABA: abaRouting };

/** Whether `text` passes the named check. NONE always passes. */
function checksumPasses(type, text) {
  if (!type || type === 'NONE') return true;
  const check = CHECKS[type];
  if (!check) throw new UncheckableValue(`the ${type} check is not available here`);
  return check(text);
}

module.exports = { SUPPORTED_CHECKSUMS, checksumPasses, UncheckableValue };
