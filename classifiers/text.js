'use strict';

/**
 * Text handling that has to follow the engine's Java runtime rather than JavaScript's defaults.
 * Everything here works on UTF-16 code units, as Java strings do.
 */

/** True when nothing but control characters and spaces (U+0000–U+0020) is present. */
function isBlank(text) {
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x20) return false;
  }
  return true;
}

function foldUnit(unit, how) {
  const folded = how(String.fromCharCode(unit));
  return folded.length === 1 ? folded.charCodeAt(0) : unit;
}

/** Orders two strings ignoring case, unit by unit: units compare equal if either their upper-
 *  or their lower-case forms agree. */
function compareFolded(a, b) {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    if (foldUnit(x, (s) => s.toUpperCase()) === foldUnit(y, (s) => s.toUpperCase())) continue;
    const lx = foldUnit(foldUnit(x, (s) => s.toUpperCase()), (s) => s.toLowerCase());
    const ly = foldUnit(foldUnit(y, (s) => s.toUpperCase()), (s) => s.toLowerCase());
    if (lx !== ly) return lx - ly;
  }
  return a.length - b.length;
}

/** Breaks `text` wherever one of `separators` occurs, dropping empty pieces. With no separators
 *  the whole text is one piece. */
function splitOnAny(text, separators) {
  const pieces = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    if (separators !== '' && separators.includes(text[i])) {
      if (current) pieces.push(current);
      current = '';
    } else {
      current += text[i];
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** The lines of a text file: `\n`, `\r` and `\r\n` all end a line, and a final line break does
 *  not start an extra empty line. */
function linesOf(text) {
  if (text === '') return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (/[\r\n]$/.test(text)) lines.pop();
  return lines;
}

module.exports = { isBlank, compareFolded, splitOnAny, linesOf };
