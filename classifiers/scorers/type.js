'use strict';

/**
 * TYPE: a gate on the column's type and declared length. It finds the allowed type that covers
 * the column — an exact SQL code first, when any entry names one, then the column's family — and
 * checks the length limits. Passing gives the match strength (0 unless set), failing the negative
 * of the reject strength (1 unless set): by default a type can rule a domain out, never in.
 */

const { ACCEPTED_AS } = require('../sql-types');

module.exports = function typeScorer({ entries, settings }) {
  const byTypeName = new Map();
  const bySqlCode = new Map();
  let namesCodes = false;
  for (const entry of entries) {
    const limits = { typeName: entry.typeName, min: entry.minimumLength, max: entry.maximumLength };
    if (entry.typeName === 'JavaSqlType') {
      namesCodes = true;
      bySqlCode.set(Number(entry.sqlType) | 0, limits);
    } else {
      byTypeName.set(entry.typeName, limits);
    }
  }

  const refuse = (rejected) => ({ score: -settings.rejectStrength, hits: 0, explain: { rejected } });

  return {
    score(column) {
      let limits = namesCodes && column.sqlType !== 0 ? bySqlCode.get(column.sqlType) : undefined;
      if (!limits) {
        const typeName = ACCEPTED_AS[column.family];
        if (!typeName) return refuse('family-not-typed');
        limits = byTypeName.get(typeName);
        if (!limits) return refuse('type-not-allowed');
      }
      if (column.autoIncrement && !settings.matchAutoIncrementingColumn) return refuse('auto-increment');
      if (column.length > 0) {
        if (column.length < limits.min) return refuse('too-short');
        if (limits.max > 0 && column.length > limits.max) return refuse('too-long');
      }
      return { score: settings.matchStrength, hits: 1, explain: { accepted: limits.typeName } };
    },
  };
};
