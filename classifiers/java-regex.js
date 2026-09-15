'use strict';

/**
 * java.util.regex patterns, evaluated in JavaScript.
 *
 * Classifier patterns are Java regular expressions, and handing one straight to `RegExp` does not
 * work: most real patterns use constructs JavaScript lacks (atomic groups, inline `(?i)`), and
 * several that do compile would quietly match differently:
 *
 *   - `(?i)` folds ASCII letters only in Java; JS `i` folds Unicode too.
 *   - `\s` is `[ \t\n\x0B\f\r]` in Java; in JS it also matches NBSP and other Unicode spaces.
 *   - `$` matches before a final line terminator in Java; in JS only at the very end.
 *   - `.` excludes U+0085 in Java; JS lets it through.
 *   - `\b` treats letters and digits of any script as word characters in Java; JS only ASCII.
 *
 * The reference is the Java the Masking Engine runs, 17 since 2026.5. Two rules changed from the
 * Java 8 of earlier engines: a leading `^` complements a whole character class, nested classes
 * included, and under CASE_INSENSITIVE the case classes (`\p{Lower}`, `\p{Lu}`…) match both cases.
 *   - atomic groups `(?>…)` and possessive quantifiers `*+` do not exist in JS.
 *
 * So the pattern is parsed into a tree and re-emitted with each construct spelled out the way
 * Java means it. The output always uses the `u` flag, and every literal is escaped in a form `u`
 * accepts. Atomic groups become `(?=(X))\N`: a lookahead cannot be backtracked into, and the
 * backreference consumes exactly what it captured. That adds capturing groups, so Java group
 * numbers are remapped before any `\N` backreference is emitted.
 *
 * Problems surface as `JavaRegexError` with a `kind`: `syntax` when Java itself would refuse the
 * pattern, `unsupported` when Java accepts it but it cannot be reproduced here faithfully — in
 * which case nothing is approximated.
 */

// Java's line terminators, as a character-class body.
const LT = '\\n\\r\\x85\\u2028\\u2029';
// Java `\b` (through Java 18): letters and digits of any script, underscore, and combining marks.
const WORD = '\\p{L}\\p{Mn}\\p{Nd}_';
const JAVA_SPACE = '\\t\\n\\v\\f\\r\\x20';
const JAVA_HSPACE = '\\t\\x20\\xA0\\u1680\\u180E\\u2000-\\u200A\\u202F\\u205F\\u3000';
const JAVA_VSPACE = '\\n\\v\\f\\r\\x85\\u2028\\u2029';

const POSIX = {
  Lower: 'a-z', Upper: 'A-Z', ASCII: '\\x00-\\x7F', Alpha: 'a-zA-Z', Digit: '0-9',
  Alnum: 'a-zA-Z0-9', Punct: '!-\\/:-@\\[-\\x60{-~', Graph: '!-~', Print: '\\x20-~',
  Blank: '\\x20\\t', Cntrl: '\\x00-\\x1F\\x7F', XDigit: '0-9a-fA-F', Space: JAVA_SPACE,
};
const UNICODE_CATEGORY = /^(?:Is)?(L|Lu|Ll|Lt|Lm|Lo|M|Mn|Mc|Me|N|Nd|Nl|No|P|Pc|Pd|Ps|Pe|Pi|Pf|Po|S|Sm|Sc|Sk|So|Z|Zs|Zl|Zp|C|Cc|Cf|Co|Cs|Cn)$/;

class JavaRegexError extends Error {
  constructor(message, { position = null, kind = 'syntax' } = {}) {
    super(position == null ? message : `${message} (position ${position})`);
    this.name = 'JavaRegexError';
    this.position = position;
    this.kind = kind;
  }
}

// ── Parsing ───────────────────────────────────────────────────────────────────

function parse(source, initialFlags) {
  const cps = Array.from(source);
  let pos = 0;
  let groupCount = 0;
  const groupNames = new Set();
  const namedRefs = [];

  const peek = (o = 0) => cps[pos + o];
  const eof = () => pos >= cps.length;
  const rest = () => cps.slice(pos).join('');
  const fail = (message) => { throw new JavaRegexError(message, { position: pos }); };
  const unsupported = (message) => { throw new JavaRegexError(message, { position: pos, kind: 'unsupported' }); };
  const snap = (f) => ({ i: f.i, s: f.s, m: f.m, d: f.d, u: f.u, x: f.x });

  function setFlag(flags, f, on) {
    switch (f) {
      case 'i': flags.i = on; break;
      case 's': flags.s = on; break;
      case 'm': flags.m = on; break;
      case 'd': flags.d = on; break;
      case 'u': flags.u = on; break;
      case 'x': flags.x = on; break;
      case 'U': unsupported('the U flag (Unicode character classes)'); break;
      default: fail(`"${f}" is not a flag`);
    }
  }

  function skipComments(flags) {
    if (!flags.x) return;
    for (;;) {
      const c = peek();
      if (c === undefined) return;
      if (' \t\n\x0B\f\r'.includes(c)) { pos++; continue; }
      if (c === '#') {
        while (!eof() && !'\n\r  '.includes(peek())) pos++;
        continue;
      }
      return;
    }
  }

  function expect(ch, message) {
    if (peek() !== ch) fail(message);
    pos++;
  }

  // Flags live on the group level: an inline `(?i)` changes them for the rest of the enclosing
  // group, alternatives after it included, and the change ends with the group.
  function parseAlternation(flags) {
    const branches = [parseSequence(flags)];
    while (peek() === '|') {
      pos++;
      branches.push(parseSequence(flags));
    }
    return branches.length === 1 ? branches[0] : { t: 'alt', branches };
  }

  function parseSequence(flags) {
    const items = [];
    for (;;) {
      skipComments(flags);
      const c = peek();
      if (c === undefined || c === '|' || c === ')') break;
      const atom = parseAtom(flags);
      if (atom === null) continue;
      if (atom.t === 'quote') {
        // A quantifier after \Q…\E applies to its last character only.
        if (!atom.chars.length) continue;
        items.push(...atom.chars.slice(0, -1));
        items.push(parseQuantifier(atom.chars[atom.chars.length - 1], flags));
        continue;
      }
      items.push(atom);
    }
    return { t: 'seq', items };
  }

  function parseQuantifier(atom, flags) {
    skipComments(flags);
    let min;
    let max;
    const c = peek();
    if (c === '*') { min = 0; max = Infinity; pos++; }
    else if (c === '+') { min = 1; max = Infinity; pos++; }
    else if (c === '?') { min = 0; max = 1; pos++; }
    else if (c === '{') {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(rest());
      if (!m) fail('malformed {…} repetition');
      min = Number(m[1]);
      max = m[2] ? (m[3] === '' ? Infinity : Number(m[3])) : min;
      if (max < min) fail('repetition range runs backwards');
      pos += m[0].length;
    } else {
      return atom;
    }
    let mode = 'greedy';
    if (peek() === '?') { mode = 'lazy'; pos++; }
    else if (peek() === '+') { mode = 'possessive'; pos++; }
    return { t: 'quant', atom, min, max, mode };
  }

  function parseAtom(flags) {
    const c = peek();
    switch (c) {
      case '(': return parseGroup(flags);
      case '[': pos++; return parseQuantifier(parseClass(flags, true), flags);
      case '.': pos++; return parseQuantifier({ t: 'any', flags: snap(flags) }, flags);
      case '^': pos++; return { t: 'assert', kind: 'bol', flags: snap(flags) };
      case '$': pos++; return { t: 'assert', kind: 'eol', flags: snap(flags) };
      case '\\': return parseEscape(flags);
      case '*': case '+': case '?': return fail(`"${c}" has nothing to repeat`);
      case '{': return fail('malformed {…} repetition');
      default:
        pos++;
        return parseQuantifier({ t: 'char', cp: c.codePointAt(0), flags: snap(flags) }, flags);
    }
  }

  function parseGroup(flags) {
    pos++;
    let kind = 'capture';
    let name = null;
    if (peek() === '?') {
      pos++;
      const c = peek();
      if (c === ':') { pos++; kind = 'noncap'; }
      else if (c === '=') { pos++; kind = 'la'; }
      else if (c === '!') { pos++; kind = 'nla'; }
      else if (c === '>') { pos++; kind = 'atomic'; }
      else if (c === '<') {
        pos++;
        if (peek() === '=') { pos++; kind = 'lb'; }
        else if (peek() === '!') { pos++; kind = 'nlb'; }
        else {
          const m = /^([a-zA-Z][a-zA-Z0-9]*)>/.exec(rest());
          if (!m) fail('group name must be letters and digits ending in ">"');
          if (groupNames.has(m[1])) fail(`group name "${m[1]}" is used twice`);
          name = m[1];
          groupNames.add(name);
          pos += m[0].length;
          kind = 'named';
        }
      } else {
        const m = /^([a-zA-Z]*)(?:-([a-zA-Z]*))?([:)])/.exec(rest());
        if (!m) fail('unrecognised (? group');
        pos += m[0].length;
        const apply = (target) => {
          for (const f of m[1]) setFlag(target, f, true);
          for (const f of m[2] || '') setFlag(target, f, false);
        };
        if (m[3] === ')') { apply(flags); return null; }
        const inner = { ...flags };
        apply(inner);
        const body = parseAlternation(inner);
        expect(')', 'a group is opened but never closed');
        return parseQuantifier({ t: 'group', kind: 'noncap', body }, flags);
      }
    }
    const index = kind === 'capture' || kind === 'named' ? ++groupCount : null;
    const body = parseAlternation({ ...flags });
    expect(')', 'a group is opened but never closed');
    return parseQuantifier({ t: 'group', kind, name, index, body }, flags);
  }

  function parseCharEscape(c) {
    switch (c) {
      case 't': return 0x09;
      case 'n': return 0x0a;
      case 'r': return 0x0d;
      case 'f': return 0x0c;
      case 'a': return 0x07;
      case 'e': return 0x1b;
      case '0': {
        let digits = '';
        while (digits.length < 3 && /[0-7]/.test(peek() || '')) {
          const next = digits + peek();
          if (next.length === 3 && Number.parseInt(next, 8) > 0o377) break;
          digits = next;
          pos++;
        }
        if (!digits) fail('\\0 must be followed by octal digits');
        return Number.parseInt(digits, 8);
      }
      case 'x': {
        if (peek() === '{') {
          const m = /^\{([0-9a-fA-F]+)\}/.exec(rest());
          if (!m) fail('\\x{…} is not closed');
          pos += m[0].length;
          const cp = Number.parseInt(m[1], 16);
          if (cp > 0x10ffff) fail('code point beyond U+10FFFF');
          return cp;
        }
        const m = /^[0-9a-fA-F]{2}/.exec(rest());
        if (!m) fail('\\x needs two hexadecimal digits');
        pos += 2;
        return Number.parseInt(m[0], 16);
      }
      case 'u': {
        const m = /^[0-9a-fA-F]{4}/.exec(rest());
        if (!m) fail('\\u needs four hexadecimal digits');
        pos += 4;
        return Number.parseInt(m[0], 16);
      }
      case 'N':
        if (peek() === '{') unsupported('\\N{…} (characters by Unicode name)');
        return fail('\\N is not a known escape');
      case 'c': {
        const next = peek();
        if (next === undefined) fail('\\c needs a following character');
        pos++;
        return next.codePointAt(0) ^ 64;
      }
      default:
        if (/[a-zA-Z0-9]/.test(c)) fail(`\\${c} is not a known escape`);
        return c.codePointAt(0);
    }
  }

  function parseProperty(negated) {
    let name;
    if (peek() === '{') {
      const m = /^\{([^}]+)\}/.exec(rest());
      if (!m) fail('\\p{…} is not closed');
      name = m[1];
      pos += m[0].length;
    } else {
      name = peek();
      if (name === undefined) fail('\\p needs a property name');
      pos++;
    }
    return { t: 'prop', name, negated };
  }

  function parseQuote(f) {
    const chars = [];
    while (!eof() && !(peek() === '\\' && peek(1) === 'E')) {
      chars.push({ t: 'char', cp: peek().codePointAt(0), flags: f });
      pos++;
    }
    if (!eof()) pos += 2;
    return chars;
  }

  function parseEscape(flags) {
    pos++;
    const c = peek();
    if (c === undefined) fail('the pattern ends with a lone backslash');
    pos++;
    const f = snap(flags);
    switch (c) {
      case 'd': case 'D': case 'w': case 'W': case 's': case 'S':
      case 'h': case 'H': case 'v': case 'V':
        return parseQuantifier({ t: 'set', name: c }, flags);
      case 'R': return parseQuantifier({ t: 'linebreak' }, flags);
      case 'b':
        if (rest().startsWith('{g}')) return unsupported('\\b{g} (grapheme cluster boundaries)');
        return { t: 'assert', kind: 'wordb' };
      case 'B': return { t: 'assert', kind: 'nwordb' };
      case 'A': return { t: 'assert', kind: 'start' };
      case 'z': return { t: 'assert', kind: 'end' };
      case 'Z': return { t: 'assert', kind: 'eol', flags: { ...f, m: false } };
      case 'G': return unsupported('\\G (end of the previous match)');
      case 'X': return unsupported('\\X (grapheme clusters)');
      case 'Q': return { t: 'quote', chars: parseQuote(f) };
      case 'k': {
        const m = /^<([a-zA-Z][a-zA-Z0-9]*)>/.exec(rest());
        if (!m) fail('\\k must be followed by <name>');
        pos += m[0].length;
        const node = { t: 'backref', name: m[1], flags: f };
        namedRefs.push(node);
        return parseQuantifier(node, flags);
      }
      case 'p': case 'P':
        return parseQuantifier({ ...parseProperty(c === 'P'), flags: f }, flags);
      default: {
        if (c >= '1' && c <= '9') {
          // \1–\9 always refer back; more digits join the number only while it still names a
          // group opened before this point.
          let n = Number(c);
          while (/\d/.test(peek() || '') && n * 10 + Number(peek()) <= groupCount) {
            n = n * 10 + Number(peek());
            pos++;
          }
          return parseQuantifier({ t: 'backref', n, flags: f }, flags);
        }
        return parseQuantifier({ t: 'char', cp: parseCharEscape(c), flags: f }, flags);
      }
    }
  }

  function parseClassAtom(flags) {
    const c = peek();
    if (c !== '\\') {
      pos++;
      return { t: 'point', cp: c.codePointAt(0) };
    }
    pos++;
    const e = peek();
    if (e === undefined) fail('a [ class is never closed');
    pos++;
    switch (e) {
      case 'd': case 'D': case 'w': case 'W': case 's': case 'S':
      case 'h': case 'H': case 'v': case 'V':
        return { t: 'set', name: e };
      case 'p': case 'P': return parseProperty(e === 'P');
      case 'Q': return { t: 'quote', cps: parseQuote(snap(flags)).map((ch) => ch.cp) };
      default: return { t: 'point', cp: parseCharEscape(e) };
    }
  }

  // A character class is the union of its members, nested classes included, and a leading `^`
  // complements the whole union: `[^a[bc]]` is anything but a, b or c, and `[^[^a]]` is just a.
  // (Java 8 read `^` as subtracting only the plain members after it; that changed in Java 9.)
  function parseClass(flags, outermost) {
    const snapshot = snap(flags);
    const members = [];
    let negated = false;
    if (peek() === '^') {
      pos++;
      negated = true;
    }
    for (;;) {
      if (flags.x) while (!eof() && ' \t\n\x0B\f\r'.includes(peek())) pos++;
      const c = peek();
      if (c === undefined) fail('a [ class is never closed');
      if (c === '[') {
        pos++;
        members.push(parseClass(flags, false));
        continue;
      }
      if (c === '&' && peek(1) === '&') unsupported('class intersection (&&)');
      if (c === ']' && members.length) { pos++; break; }

      const member = parseClassAtom(flags);
      if (member.t === 'point' && peek() === '-' && peek(1) !== undefined && peek(1) !== ']' && peek(1) !== '[') {
        pos++;
        const end = parseClassAtom(flags);
        if (end.t !== 'point' || end.cp < member.cp) fail('character range runs backwards or is not a range');
        members.push({ t: 'span', from: member.cp, to: end.cp });
        continue;
      }
      if (member.t === 'quote') members.push(...member.cps.map((cp) => ({ t: 'point', cp })));
      else members.push(member);
    }

    const union = members.reduce((acc, node) => (acc ? { t: 'union', a: acc, b: node } : node), null);
    const expr = negated ? { t: 'except', a: union } : union;
    return outermost ? { t: 'class', expr, flags: snapshot } : expr;
  }

  const ast = parseAlternation({ ...initialFlags });
  if (!eof()) fail('unbalanced ")"');
  for (const ref of namedRefs) {
    if (!groupNames.has(ref.name)) throw new JavaRegexError(`no group is named "${ref.name}"`);
  }
  return ast;
}

// ── Emission ──────────────────────────────────────────────────────────────────

const SYNTAX = new Set('^$\\.*+?()[]{}|/');

function hex(cp) {
  return `\\u{${cp.toString(16).toUpperCase()}}`;
}

function escapeChar(cp) {
  const ch = String.fromCodePoint(cp);
  if (SYNTAX.has(ch)) return `\\${ch}`;
  if (cp >= 0x20 && cp < 0x7f) return ch;
  return hex(cp);
}

function escapeClassChar(cp) {
  const ch = String.fromCodePoint(cp);
  if ('\\]^-['.includes(ch)) return `\\${ch}`;
  if (cp >= 0x20 && cp < 0x7f) return ch;
  return hex(cp);
}

function otherAsciiCase(cp) {
  if (cp >= 0x61 && cp <= 0x7a) return cp - 32;
  if (cp >= 0x41 && cp <= 0x5a) return cp + 32;
  return null;
}

function caseRanges(from, to) {
  const out = [];
  const lo = Math.max(from, 0x61);
  const hi = Math.min(to, 0x7a);
  if (lo <= hi) out.push(`${escapeClassChar(lo - 32)}-${escapeClassChar(hi - 32)}`);
  const LO = Math.max(from, 0x41);
  const HI = Math.min(to, 0x5a);
  if (LO <= HI) out.push(`${escapeClassChar(LO + 32)}-${escapeClassChar(HI + 32)}`);
  return out;
}

function quantifierText(min, max) {
  if (min === 0 && max === Infinity) return '*';
  if (min === 1 && max === Infinity) return '+';
  if (min === 0 && max === 1) return '?';
  if (min === max) return `{${min}}`;
  if (max === Infinity) return `{${min},}`;
  return `{${min},${max}}`;
}

// Under CASE_INSENSITIVE, a class that names one case matches every cased letter instead.
const CASE_CATEGORIES = new Set(['Lu', 'Ll', 'Lt']);

function propertyBody(node, f = {}) {
  const name = node.name;
  if (Object.hasOwn(POSIX, name)) {
    if (f.i && (name === 'Lower' || name === 'Upper')) return { kind: 'posix', body: POSIX.Alpha };
    return { kind: 'posix', body: POSIX[name] };
  }
  const cat = UNICODE_CATEGORY.exec(name);
  if (cat) return { kind: 'unicode', body: f.i && CASE_CATEGORIES.has(cat[1]) ? 'LC' : cat[1] };
  const script = /^(?:Is|script=|sc=)([A-Za-z_]+)$/.exec(name);
  if (script) {
    const value = script[1];
    try {
      new RegExp(`\\p{Script=${value}}`, 'u');
      return { kind: 'unicode', body: `Script=${value}` };
    } catch { /* not a script name — fall through */ }
  }
  throw new JavaRegexError(`the \\p{${name}} property`, { kind: 'unsupported' });
}

function emitSet(name) {
  switch (name) {
    case 'd': return '\\d';
    case 'D': return '\\D';
    case 'w': return '\\w';
    case 'W': return '\\W';
    case 's': return `[${JAVA_SPACE}]`;
    case 'S': return `[^${JAVA_SPACE}]`;
    case 'h': return `[${JAVA_HSPACE}]`;
    case 'H': return `[^${JAVA_HSPACE}]`;
    case 'v': return `[${JAVA_VSPACE}]`;
    case 'V': return `[^${JAVA_VSPACE}]`;
    default: throw new JavaRegexError(`internal: unknown set \\${name}`, { kind: 'unsupported' });
  }
}

/** Class-body text for a member that fits inside `[...]`, or null. */
function memberBody(it, f) {
  const asciiFold = f.i && !f.u;
  switch (it.t) {
    case 'point': {
      const other = asciiFold ? otherAsciiCase(it.cp) : null;
      return escapeClassChar(it.cp) + (other !== null ? escapeClassChar(other) : '');
    }
    case 'span': {
      const out = [`${escapeClassChar(it.from)}-${escapeClassChar(it.to)}`];
      if (asciiFold) out.push(...caseRanges(it.from, it.to));
      return out.join('');
    }
    case 'set':
      switch (it.name) {
        case 'd': case 'D': case 'w': case 'W': return `\\${it.name}`;
        case 's': return JAVA_SPACE;
        case 'h': return JAVA_HSPACE;
        case 'v': return JAVA_VSPACE;
        default: return null;
      }
    case 'prop': {
      const p = propertyBody(it, f);
      if (p.kind === 'unicode') return `\\${it.negated ? 'P' : 'p'}{${p.body}}`;
      return it.negated ? null : p.body;
    }
    default:
      return null;
  }
}

function unionTerms(e) {
  const terms = [];
  (function flatten(x) {
    if (x.t === 'union') { flatten(x.a); flatten(x.b); } else terms.push(x);
  }(e));
  return terms;
}

/** A one-character matcher for a class expression. */
function emitClassExpr(e, f) {
  if (e.t === 'except') {
    const bodies = unionTerms(e.a).map((it) => memberBody(it, f));
    if (bodies.every((body) => body !== null)) return `[^${bodies.join('')}]`;
    return `(?:(?!${emitClassExpr(e.a, f)})[\\s\\S])`;
  }
  const parts = [];
  const extras = [];
  for (const it of unionTerms(e)) {
    const body = memberBody(it, f);
    if (body !== null) parts.push(body);
    else if (it.t === 'set') extras.push(emitSet(it.name));
    else if (it.t === 'prop') extras.push(`[^${propertyBody(it, f).body}]`);
    else extras.push(emitClassExpr(it, f));
  }
  if (!extras.length) return `[${parts.join('')}]`;
  return `(?:${parts.length ? `[${parts.join('')}]|` : ''}${extras.join('|')})`;
}

function emitClass(node) {
  const f = node.flags;
  const full = emitClassExpr(node.expr, f);
  return f.i && f.u ? `(?i:${full})` : full;
}

function emitAssert(node) {
  const f = node.flags || {};
  const lt = f.d ? '\\n' : LT;
  switch (node.kind) {
    case 'bol':
      return f.m ? `(?:(?<![\\s\\S])|(?<=[${lt}])(?=[\\s\\S]))` : '(?<![\\s\\S])';
    case 'eol':
      if (f.m) return `(?=[${lt}]|(?![\\s\\S]))`;
      return f.d ? '(?=\\n?(?![\\s\\S]))' : `(?=(?:\\r\\n|[${LT}])?(?![\\s\\S]))`;
    case 'start': return '(?<![\\s\\S])';
    case 'end': return '(?![\\s\\S])';
    case 'wordb': return `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;
    case 'nwordb': return `(?:(?<=[${WORD}])(?=[${WORD}])|(?<![${WORD}])(?![${WORD}]))`;
    default: throw new JavaRegexError(`internal: unknown assertion ${node.kind}`, { kind: 'unsupported' });
  }
}

/** Assigns output group numbers in emission order: helpers for atomic groups included. */
function numberGroups(node, state) {
  switch (node.t) {
    case 'alt': node.branches.forEach((b) => numberGroups(b, state)); break;
    case 'seq': node.items.forEach((i) => numberGroups(i, state)); break;
    case 'quant':
      if (node.mode === 'possessive') node.helper = ++state.n;
      numberGroups(node.atom, state);
      break;
    case 'group':
      if (node.kind === 'atomic') node.helper = ++state.n;
      if (node.kind === 'capture' || node.kind === 'named') {
        node.out = ++state.n;
        state.map.set(node.index, node.out);
      }
      numberGroups(node.body, state);
      break;
    default: break;
  }
}

function emit(node, state) {
  switch (node.t) {
    case 'seq': return node.items.map((i) => emit(i, state)).join('');
    case 'alt': return node.branches.map((b) => emit(b, state)).join('|');
    case 'char': {
      const f = node.flags;
      if (f.i && f.u) return `(?i:${escapeChar(node.cp)})`;
      if (f.i) {
        const other = otherAsciiCase(node.cp);
        if (other !== null) return `[${escapeClassChar(node.cp)}${escapeClassChar(other)}]`;
      }
      return escapeChar(node.cp);
    }
    case 'class': return emitClass(node);
    case 'any':
      if (node.flags.s) return '[\\s\\S]';
      return node.flags.d ? '[^\\n]' : `[^${LT}]`;
    case 'set': return emitSet(node.name);
    case 'prop': {
      const p = propertyBody(node, node.flags);
      if (p.kind === 'unicode') return `\\${node.negated ? 'P' : 'p'}{${p.body}}`;
      return `[${node.negated ? '^' : ''}${p.body}]`;
    }
    case 'linebreak': return '(?:\\r\\n|[\\n\\v\\f\\r\\x85\\u2028\\u2029])';
    case 'assert': return emitAssert(node);
    case 'backref': {
      let ref;
      if (node.name != null) {
        ref = `\\k<${node.name}>`;
      } else {
        const out = state.map.get(node.n);
        // A reference to a group that does not exist is legal in Java and simply never matches.
        if (out == null) return '(?!)';
        // Grouped, so a literal digit after it is not read as part of the group number.
        ref = `(?:\\${out})`;
      }
      return node.flags.i ? `(?i:${ref})` : ref;
    }
    case 'group': {
      const body = emit(node.body, state);
      switch (node.kind) {
        case 'capture': return `(${body})`;
        case 'named': return `(?<${node.name}>${body})`;
        case 'noncap': return `(?:${body})`;
        case 'la': return `(?=${body})`;
        case 'nla': return `(?!${body})`;
        case 'lb': return `(?<=${body})`;
        case 'nlb': return `(?<!${body})`;
        case 'atomic': return `(?:(?=(${body}))\\${node.helper})`;
        default: throw new JavaRegexError(`internal: unknown group ${node.kind}`, { kind: 'unsupported' });
      }
    }
    case 'quant': {
      const atom = emit(node.atom, state);
      // Java lets a lookaround be quantified: zero-width, so it is either required once or,
      // with a minimum of 0, never required at all. JS with `u` rejects the quantifier.
      if (node.atom.t === 'group' && ['la', 'nla', 'lb', 'nlb'].includes(node.atom.kind)) {
        return node.min === 0 ? '(?:)' : atom;
      }
      const q = quantifierText(node.min, node.max);
      if (node.mode === 'possessive') return `(?:(?=(${atom}${q}))\\${node.helper})`;
      return `${atom}${q}${node.mode === 'lazy' ? '?' : ''}`;
    }
    default:
      throw new JavaRegexError(`internal: unknown node ${node.t}`, { kind: 'unsupported' });
  }
}

// ── API ───────────────────────────────────────────────────────────────────────

const cache = new Map();
const CACHE_LIMIT = 4000;

/**
 * Compiles a Java pattern. `caseInsensitive` is the compile-time flag a classifier sets when
 * `caseSensitive` is false.
 */
function compile(source, { caseInsensitive = false } = {}) {
  const key = `${caseInsensitive ? 'i' : '-'} ${source}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const ast = parse(String(source), { i: caseInsensitive, s: false, m: false, d: false, u: false, x: false });
  const state = { n: 0, map: new Map() };
  numberGroups(ast, state);
  const js = emit(ast, state);

  let compiled;
  try {
    compiled = {
      source: js,
      search: new RegExp(js, 'u'),
      whole: new RegExp(`^(?:${js})$`, 'u'),
      global: new RegExp(js, 'gu'),
    };
  } catch (err) {
    throw new JavaRegexError(`this combination of constructs (${err.message})`, { kind: 'unsupported' });
  }
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, compiled);
  return compiled;
}

/** True when the pattern occurs anywhere in the input. */
function find(source, input, options) {
  return compile(source, options).search.test(input);
}

/** True when the pattern covers the whole input. */
function matches(source, input, options) {
  return compile(source, options).whole.test(input);
}

/** Replaces every occurrence of the pattern with a literal text. */
function replaceAll(source, input, replacement = '', options) {
  const { global } = compile(source, options);
  global.lastIndex = 0;
  return input.replace(global, () => replacement);
}

/** Throws `JavaRegexError` when the pattern is not valid Java, or cannot be reproduced here. */
function validate(source, options) {
  compile(source, options);
}

module.exports = { compile, find, matches, replaceAll, validate, JavaRegexError, _parse: parse };
