'use strict';

/**
 * JDBC type codes (java.sql.Types), grouped into the families a TYPE classifier reasons about,
 * with the length a column of that type is taken to have when the database reports none.
 */

const UNBOUNDED = 2147483647;

// The `typeName` of a TYPE classifier that accepts each family. Families missing here pass no
// TYPE classifier at all — a TIMESTAMP or BOOLEAN column is rejected by every one of them.
const ACCEPTED_AS = { text: 'String', number: 'Number', date: 'Date', binary: 'Binary' };

const inFamily = (family, rows) =>
  rows.map(([code, name, assumedLength]) => ({ code, name, family, ...(assumedLength ? { assumedLength } : {}) }));

const SQL_TYPES = [
  ...inFamily('text', [
    [1, 'CHAR', 1], [12, 'VARCHAR'], [-1, 'LONGVARCHAR', UNBOUNDED], [-15, 'NCHAR', 1], [-9, 'NVARCHAR'],
    [-16, 'LONGNVARCHAR', UNBOUNDED], [2005, 'CLOB', UNBOUNDED], [2011, 'NCLOB', UNBOUNDED],
  ]),
  ...inFamily('number', [
    [-7, 'BIT'], [-6, 'TINYINT', 2], [5, 'SMALLINT', 4], [4, 'INTEGER', 8], [-5, 'BIGINT', 16],
    [6, 'FLOAT'], [7, 'REAL'], [8, 'DOUBLE'], [2, 'NUMERIC'], [3, 'DECIMAL'],
  ]),
  ...inFamily('date', [[91, 'DATE'], [92, 'TIME'], [2013, 'TIME_WITH_TIMEZONE']]),
  ...inFamily('timestamp', [[93, 'TIMESTAMP'], [2014, 'TIMESTAMP_WITH_TIMEZONE']]),
  ...inFamily('binary', [[-2, 'BINARY'], [-3, 'VARBINARY'], [-4, 'LONGVARBINARY'], [2004, 'BLOB']]),
  ...inFamily('boolean', [[16, 'BOOLEAN']]),
  ...inFamily('other', [
    [0, 'NULL'], [1111, 'OTHER'], [2000, 'JAVA_OBJECT'], [2001, 'DISTINCT'], [2002, 'STRUCT'],
    [2003, 'ARRAY'], [2006, 'REF'], [70, 'DATALINK'], [-8, 'ROWID'], [2009, 'SQLXML'], [2012, 'REF_CURSOR'],
  ]),
];

const BY_CODE = new Map(SQL_TYPES.map((t) => [t.code, t]));

/**
 * The column as PATH and TYPE classifiers see it. With no SQL type it is a VARCHAR; with no
 * length it is as long as a column can be.
 */
function describeColumn(field) {
  const sqlType = field.sqlType == null ? 12 : Number(field.sqlType);
  const known = BY_CODE.get(sqlType);
  const declared = field.length == null ? UNBOUNDED : Number(field.length);
  return {
    name: field.name == null ? '' : String(field.name),
    parent: field.parent == null || field.parent === '' ? null : String(field.parent),
    sqlType,
    family: known ? known.family : 'other',
    length: declared > 0 ? declared : (known?.assumedLength ?? 0),
    autoIncrement: Boolean(field.autoIncrement),
  };
}

module.exports = { SQL_TYPES, ACCEPTED_AS, UNBOUNDED, describeColumn };
