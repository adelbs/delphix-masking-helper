'use strict';

/**
 * Reads a classifier's JSON into plain values: the repeated entries and the classifier-wide
 * settings, with fallbacks applied. Anything that cannot be read becomes an issue instead of an
 * exception, so a form can show every problem at once.
 */

const { CATALOG, isFramework } = require('./catalog');
const { issue } = require('./issues');

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function inRange(field, n) {
  if (field.min != null && n < field.min - 1e-9) return { problem: ['below-minimum', { min: field.min }] };
  if (field.max != null && n > field.max + 1e-9) return { problem: ['above-maximum', { max: field.max }] };
  return { value: n };
}

/** One value against its field: `{ value }` or `{ problem: [code, params] }`. */
function interpret(field, value) {
  switch (field.kind) {
    case 'text':
    case 'file':
      if (typeof value !== 'string') return { problem: ['expects-text'] };
      if (field.maxChars && value.length > field.maxChars) return { problem: ['too-long', { max: field.maxChars }] };
      return { value };
    case 'choice':
      if (typeof value === 'string' && (field.options.includes(value) || field.openEnded)) return { value };
      return { problem: ['not-an-option', { value: String(value) }] };
    case 'flag':
      if (typeof value === 'boolean') return { value };
      if (typeof value === 'string' && /^(true|false)$/i.test(value)) return { value: value.toLowerCase() === 'true' };
      return { problem: ['expects-true-false'] };
    case 'integer':
      if (typeof value === 'number' && Number.isInteger(value)) return inRange(field, value);
      if (typeof value === 'string' && /^[+-]?\d+$/.test(value)) return inRange(field, Number(value));
      return { problem: ['expects-whole-number'] };
    case 'number': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) return { problem: ['expects-number'] };
      return inRange(field, n);
    }
    default:
      return { problem: ['expects-text'] };
  }
}

function readFields(fields, source, where, issues) {
  const out = {};
  const known = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(source)) {
    if (!known.has(key) && !(where.list === undefined && key === where.listKey)) {
      issues.push(issue('error', 'unknown-setting', where.list === undefined ? {} : { list: where.list, index: where.index }, { name: key }));
    }
  }
  for (const field of fields) {
    const at = where.list === undefined ? { field: field.key } : { list: where.list, index: where.index, field: field.key };
    const value = source[field.key];
    if (value === undefined || value === null) {
      if (field.required && field.fallback === undefined) issues.push(issue('error', 'missing-value', at));
      out[field.key] = field.fallback;
      continue;
    }
    const read = interpret(field, value);
    if (read.problem) {
      issues.push(issue('error', read.problem[0], at, read.problem[1]));
      out[field.key] = field.fallback;
    } else {
      out[field.key] = read.value;
    }
  }
  return out;
}

/**
 * `{ entries, settings, issues }`. `entries` keeps the configured positions; an entry that is not
 * an object is null there. Both are null when the framework or the JSON itself is unusable.
 */
function readConfig(framework, raw) {
  if (!isFramework(framework)) {
    return { entries: null, settings: null, issues: [issue('error', 'unknown-framework', {}, { framework: String(framework) })] };
  }
  if (!isRecord(raw)) return { entries: null, settings: null, issues: [issue('error', 'config-not-object')] };

  const spec = CATALOG[framework];
  const listKey = spec.list.key;
  const issues = [];
  const settings = readFields(spec.settings, raw, { listKey }, issues);

  let entries = [];
  const listed = raw[listKey];
  if (listed !== undefined && listed !== null) {
    if (!Array.isArray(listed)) {
      issues.push(issue('error', 'expects-list', { list: listKey }));
    } else {
      entries = listed.map((entry, index) => {
        if (!isRecord(entry)) {
          issues.push(issue('error', 'entry-not-object', { list: listKey, index }));
          return null;
        }
        return readFields(spec.list.fields, entry, { list: listKey, index }, issues);
      });
    }
  }
  return { entries, settings, issues };
}

module.exports = { readConfig };
