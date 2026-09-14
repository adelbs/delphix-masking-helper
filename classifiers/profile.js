'use strict';

/**
 * How a set of classifiers settles on a domain for one column — the part of profiling this tool
 * reproduces, so a configuration can be tried before it goes to Delphix.
 *
 * Four stages, each working on the previous one's output:
 *
 *   prepare   drop exact duplicates; let each domain's TYPE classifiers act as one
 *   evidence  every classifier scores the column (metadata) or its sample (values); per domain,
 *             the score furthest from zero is kept for each of the two kinds
 *   settle    the two kinds become one confidence per domain
 *   decide    domains are ordered, and the first is assigned if it reaches the threshold
 *
 * Confidences are kept as 32-bit floats throughout (see float32.js).
 */

const { CATALOG } = require('./catalog');
const { readConfig } = require('./config');
const { reviewClassifier } = require('./review');
const { describeColumn } = require('./sql-types');
const { mergedTypeConfig } = require('./merge-types');
const { isBlank, compareFolded } = require('./text');
const { toFloat, TOLERANCE, isNegligible, addAsDecimals, toPercent, thousandthsBetween } = require('./float32');

const SCORERS = {
  PATH: require('./scorers/name'),
  TYPE: require('./scorers/type'),
  REGEX: require('./scorers/pattern'),
  LIST: require('./scorers/list'),
};

/** A classifier that cannot take part: Delphix would refuse it, or it cannot be evaluated here. */
class NotEvaluable extends Error {
  constructor(name, issues) {
    super(`Classifier "${name}" cannot be evaluated: ${issues.map((i) => i.message).join(' ')}`);
    this.name = 'NotEvaluable';
    this.classifier = name;
    this.issues = issues;
  }
}

/** A classifier the column needs failed on its values, so no ranking can be given. */
class EvaluationStopped extends Error {
  constructor(name, problem) {
    super(`Classifier "${name}" could not be evaluated with these values: ${problem}`);
    this.name = 'EvaluationStopped';
    this.classifier = name;
  }
}

/**
 * Builds a classifier's scorer. `internal` skips the rules — for the merged TYPE classifier, whose
 * configuration is produced here rather than written by anyone.
 */
function build(classifier, readFile, { internal = false } = {}) {
  const read = internal ? readConfig(classifier.framework, classifier.config) : reviewClassifier(classifier.framework, classifier.config);
  const blocking = internal ? read.issues : [...read.errors, ...read.limitations];
  if (blocking.length) throw new NotEvaluable(classifier.name, blocking);
  const scorer = SCORERS[classifier.framework]({ entries: read.entries, settings: read.settings }, readFile);
  return { ...classifier, reads: CATALOG[classifier.framework].reads, ...scorer };
}

function keepStrongest(best, domain, candidate) {
  const current = best.get(domain);
  if (!current || Math.abs(candidate.score) > Math.abs(current.score)) best.set(domain, candidate);
}

/** Metadata and value confidences of one domain, both non-negligible, as one confidence. */
function blend(fromMetadata, fromValues) {
  if ((fromMetadata < 0) !== (fromValues < 0)) return addAsDecimals(fromMetadata, fromValues);
  const [strong, weak] = Math.abs(fromMetadata) > Math.abs(fromValues)
    ? [fromMetadata, fromValues]
    : [fromValues, fromMetadata];
  return toFloat(strong + toFloat(toFloat(1 - Math.abs(strong)) * weak));
}

function settle(metadata, values) {
  if (!values) return { score: metadata.score, counted: { metadata: true, values: false } };
  if (!metadata) return { score: values.score, counted: { metadata: false, values: true } };
  if (isNegligible(metadata.score)) return { score: values.score, counted: { metadata: false, values: true } };
  if (isNegligible(values.score)) return { score: metadata.score, counted: { metadata: true, values: false } };
  return { score: blend(metadata.score, values.score), counted: { metadata: true, values: true } };
}

/** One classifier on its own, whether or not profiling would end up using it. */
function standalone(member, column, sample) {
  const report = {
    id: member.id, name: member.name, domain: member.domain, framework: member.framework,
    reads: member.reads, outcome: 'counted', score: null, exact: null, hits: 0,
  };
  try {
    if (member.reads === 'values') {
      if (!sample.length) return { ...report, outcome: 'no-values' };
      const r = member.score(sample);
      return { ...report, score: toFloat(r.score), exact: r.score, hits: r.hits, explain: r.explain, lists: member.lists };
    }
    const r = member.score(column);
    return { ...report, score: toFloat(r.score), exact: r.score, hits: r.hits, explain: r.explain };
  } catch (err) {
    return { ...report, outcome: 'failed', problem: err.message };
  }
}

/**
 * Profiles one column.
 *
 *   classifiers  [{ id?, name, domain, framework, config }]
 *   field        { name, parent?, sqlType?, length?, autoIncrement?, values }
 *   threshold    assignment threshold, in percent
 *   readFile     (address) => text, for LIST classifiers
 */
function evaluateField({
  classifiers,
  field,
  threshold = 0,
  resultCount = 3,
  readFile = () => { throw new Error('No list file reader was given.'); },
}) {
  const column = describeColumn(field);
  const offered = field.values || [];
  const sample = offered.filter((v) => v != null && !isBlank(v)).map(String);

  // ── prepare ──
  const seen = new Set();
  const members = classifiers.map((c) => {
    const identity = JSON.stringify([c.name, c.domain, c.config]);
    const duplicate = seen.has(identity);
    seen.add(identity);
    return { ...build(c, readFile), id: c.id ?? null, duplicate };
  });
  const reports = members.map((m) => standalone(m, column, sample));
  const reportOf = (m) => reports[members.indexOf(m)];
  const active = members.filter((m) => !m.duplicate);

  const typeGroups = new Map();
  for (const m of active) {
    if (m.framework !== 'TYPE') continue;
    if (!typeGroups.has(m.domain)) typeGroups.set(m.domain, []);
    typeGroups.get(m.domain).push(m);
  }
  const merged = [];
  for (const [domain, group] of typeGroups) {
    if (group.length < 2) continue;
    const config = mergedTypeConfig(group.map((m) => m.config));
    merged.push({ ...build({ name: `${domain} · merged TYPE`, domain, framework: 'TYPE', config }, readFile, { internal: true }), from: group });
    for (const m of group) reportOf(m).outcome = 'merged';
  }
  const mergedAway = new Set(merged.flatMap((m) => m.from));
  const metadataMembers = [
    ...active.filter((m) => m.framework === 'TYPE' && !mergedAway.has(m)),
    ...merged,
    ...active.filter((m) => m.framework === 'PATH'),
  ];
  const valueMembers = active.filter((m) => m.reads === 'values');

  // ── evidence: metadata ──
  const fromMetadata = new Map();
  const mergedTypes = [];
  for (const m of metadataMembers) {
    const result = m.score(column);
    const score = toFloat(result.score);
    if (m.from) mergedTypes.push({ name: m.name, domain: m.domain, from: m.from.map((x) => x.name), score });
    keepStrongest(fromMetadata, m.domain, { member: m, classifier: m.name, score });
  }

  // ── evidence: values ──
  const decisive = [...fromMetadata].filter(([, e]) => e.score + TOLERANCE > 1);
  const fromValues = new Map();
  let valuesSkipped = null;
  let sampleSize = 0;
  if (decisive.length === 1) valuesSkipped = 'decided-by-metadata';
  else if (!offered.length) valuesSkipped = 'no-values';
  else if (!valueMembers.length) valuesSkipped = 'no-value-classifiers';
  else {
    sampleSize = sample.length;
    if (!sample.length) valuesSkipped = 'no-values';
    for (const m of sample.length ? valueMembers : []) {
      const report = reportOf(m);
      const metadata = fromMetadata.get(m.domain);
      if (metadata && metadata.score - TOLERANCE < -1) {
        if (report.outcome === 'counted') report.outcome = 'ruled-out';
        continue;
      }
      if (report.outcome === 'failed') throw new EvaluationStopped(m.name, report.problem);
      keepStrongest(fromValues, m.domain, { member: m, classifier: m.name, score: report.score, hits: report.hits });
    }
  }

  if (valuesSkipped === 'decided-by-metadata' || valuesSkipped === 'no-values') {
    for (const m of valueMembers) {
      const report = reportOf(m);
      if (report.outcome === 'counted') report.outcome = valuesSkipped === 'no-values' ? 'no-values' : 'decided';
    }
  }
  for (const m of active) {
    const report = reportOf(m);
    if (report.outcome !== 'counted') continue;
    const winner = (m.reads === 'metadata' ? fromMetadata : fromValues).get(m.domain);
    if (winner && winner.member !== m) report.outcome = 'weaker';
  }
  members.forEach((m, i) => { if (m.duplicate) reports[i].outcome = 'duplicate'; });

  // ── settle and decide ──
  const domains = [...new Set(active.map((m) => m.domain))];
  const ranking = domains.flatMap((domain) => {
    const metadata = fromMetadata.get(domain);
    const values = fromValues.get(domain);
    if (!metadata && !values) return [];
    const settled = settle(metadata, values);
    return [{
      domain,
      score: settled.score,
      percent: toPercent(settled.score),
      metadata: metadata ? { classifier: metadata.classifier, score: metadata.score } : null,
      values: values ? { classifier: values.classifier, score: values.score, hits: values.hits } : null,
      counted: settled.counted,
    }];
  });
  ranking.sort((a, b) => thousandthsBetween(a.score, b.score) || compareFolded(a.domain, b.domain));

  const top = ranking.slice(0, Math.max(1, resultCount));
  const assigned = top.length && top[0].score >= Number(threshold) / 100 ? top[0].domain : '';

  return {
    column,
    sampleSize,
    valuesSkipped,
    decisiveDomain: decisive.length === 1 ? decisive[0][0] : null,
    classifiers: reports,
    mergedTypes,
    ranking,
    top,
    assigned,
    threshold: Number(threshold),
  };
}

module.exports = { evaluateField, NotEvaluable, EvaluationStopped };
