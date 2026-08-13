import assert from 'node:assert/strict';
import { environmentQuery } from '../dist/src/sql/environment.js';

const db = 'SEIDOR76';
const schema = 'MONAI';

function query(sql) {
  const result = environmentQuery(sql, db, schema);
  assert.ok(result, `SQLAlchemy bootstrap query was not virtualized: ${sql}`);
  return result;
}

// SQLAlchemy 2.0.51 PostgreSQL dialect first-connect initialization.
const version = query('select pg_catalog.version()');
assert.equal(version.rows.length, 1);
assert.equal(typeof version.rows[0]?.[0], 'string');
assert.match(version.rows[0][0], /PostgreSQL\s+\d+(?:\.\d+)?/i);

const currentSchema = query('select current_schema()');
assert.deepEqual(currentSchema.rows, [[schema]]);

const isolation = query('show transaction isolation level');
assert.deepEqual(isolation.rows, [['read committed']]);

const standardStrings = query('show standard_conforming_strings');
assert.deepEqual(standardStrings.rows, [['on']]);

// Common companion probes should remain supported as well.
assert.deepEqual(query('show server_version').rows, [['14.0']]);
assert.deepEqual(query('show server_version_num').rows, [['140000']]);
assert.deepEqual(query('show default_transaction_isolation').rows, [['read committed']]);

console.log('SQLAlchemy 2.0.51 PostgreSQL bootstrap compatibility check OK');
