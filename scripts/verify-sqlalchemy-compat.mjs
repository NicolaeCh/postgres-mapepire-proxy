import assert from 'node:assert/strict';
import { environmentQuery } from '../dist/src/sql/environment.js';
import { syntheticCatalog } from '../dist/src/sql/catalog.js';
import {
  parsePgSavepointCommand,
  savepointCommandTag,
  translatePgSavepointToDb2,
} from '../dist/src/sql/transactions.js';

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

// psycopg 3.3.4 TypeInfo.fetch("hstore") opens a nested Transaction context.
// The proxy must accept psycopg's PostgreSQL savepoint spellings and map them
// to real Db2 for i savepoint statements.
const sp = parsePgSavepointCommand('SAVEPOINT "_pg3_1"');
assert.deepEqual(sp, { action: 'savepoint', name: '_pg3_1' });
assert.equal(translatePgSavepointToDb2(sp), 'SAVEPOINT "_pg3_1" ON ROLLBACK RETAIN CURSORS');
assert.equal(savepointCommandTag(sp.action), 'SAVEPOINT');

const rel = parsePgSavepointCommand('RELEASE "_pg3_1"');
assert.deepEqual(rel, { action: 'release', name: '_pg3_1' });
assert.equal(translatePgSavepointToDb2(rel), 'RELEASE SAVEPOINT "_pg3_1"');
assert.equal(savepointCommandTag(rel.action), 'RELEASE');

const rb = parsePgSavepointCommand('ROLLBACK TO "_pg3_1"');
assert.deepEqual(rb, { action: 'rollbackTo', name: '_pg3_1' });
assert.equal(translatePgSavepointToDb2(rb), 'ROLLBACK TO SAVEPOINT "_pg3_1"');
assert.equal(savepointCommandTag(rb.action), 'ROLLBACK');

// SQLAlchemy's psycopg dialect probes the optional PostgreSQL hstore type.
// IBM i has no hstore extension, so the correct answer is an exact empty
// TypeInfo-shaped rowset, not a generic pg_type enumeration.
const typeInfo = syntheticCatalog(`
  SELECT typname AS name, oid, typarray AS array_oid,
         oid::regtype::text AS regtype, typdelim AS delimiter
  FROM pg_type t
  WHERE t.oid = to_regtype($1)
  ORDER BY t.oid
`);
assert.ok(typeInfo, 'psycopg TypeInfo.fetch query was not virtualized');
assert.deepEqual(typeInfo.fields.map((f) => f.name), ['name', 'oid', 'array_oid', 'regtype', 'delimiter']);
assert.deepEqual(typeInfo.rows, []);
assert.equal(typeInfo.tag, 'SELECT 0');

console.log('SQLAlchemy 2.0.51 / psycopg 3.3.4 bootstrap compatibility check OK');
