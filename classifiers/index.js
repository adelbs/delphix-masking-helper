'use strict';

/**
 * Classifier evaluation for the Masking Helper: describe a column, and see which domain a set of
 * classifiers would give it, before any of it goes to Delphix.
 *
 *   catalog()                           the frameworks' settings and the SQL types, for forms
 *   isFramework(name)
 *   reviewClassifier(framework, config) errors, limitations and hints for one configuration
 *   evaluateField({ classifiers, field, threshold, readFile })
 *
 * Module map: catalog.js (settings) · config.js (reading JSON) · review.js (rules) ·
 * sql-types.js (columns) · scorers/ (one per framework) · merge-types.js · profile.js (stages) ·
 * checksums.js · java-regex.js · float32.js · text.js · issues.js
 */

const { CATALOG, isFramework } = require('./catalog');
const { SQL_TYPES } = require('./sql-types');
const { SUPPORTED_CHECKSUMS } = require('./checksums');
const { reviewClassifier } = require('./review');
const { evaluateField, NotEvaluable, EvaluationStopped } = require('./profile');

const catalog = () => ({
  frameworks: CATALOG,
  sqlTypes: SQL_TYPES.map(({ code, name, family }) => ({ code, name, family })),
});

module.exports = {
  catalog,
  isFramework,
  reviewClassifier,
  evaluateField,
  NotEvaluable,
  EvaluationStopped,
  SUPPORTED_CHECKSUMS,
};
