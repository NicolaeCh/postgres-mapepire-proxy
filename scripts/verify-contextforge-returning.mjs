import assert from 'node:assert/strict';
import { parsePgReturning, translateSql } from '../dist/src/sql/translator.js';

const options = {
  uppercaseIdentifiers: true,
  informationSchemaRewrite: true,
  pgCatalogCompat: true,
  allowMultiStatement: false,
  maxRows: 0,
  ddlDefaultVarcharLength: 1024,
};

const alembic = translateSql(
  'INSERT INTO alembic_version (version_num) VALUES ($1) RETURNING alembic_version.version_num',
  options,
);
assert.equal(alembic.kind, 'insert');
assert.deepEqual(alembic.parameterOrder, [1]);
assert.equal(
  alembic.sql,
  'SELECT VERSION_NUM FROM FINAL TABLE (INSERT INTO ALEMBIC_VERSION (VERSION_NUM) VALUES (?))',
);
assert.doesNotMatch(alembic.sql, /\bRETURNING\b/i);
assert.deepEqual(
  parsePgReturning('INSERT INTO alembic_version (version_num) VALUES ($1) RETURNING alembic_version.version_num'),
  {
    kind: 'insert',
    table: 'alembic_version',
    columns: [{ column: 'version_num', fieldName: 'version_num' }],
  },
);

const identity = translateSql(
  'INSERT INTO metrics (name) VALUES ($1) RETURNING metrics.id',
  options,
);
assert.equal(identity.kind, 'insert');
assert.equal(identity.sql, 'SELECT ID FROM FINAL TABLE (INSERT INTO METRICS (NAME) VALUES (?))');

const updated = translateSql(
  'UPDATE tools SET enabled=false WHERE id=$1 RETURNING tools.id, tools.enabled',
  options,
);
assert.equal(updated.kind, 'update');
assert.equal(updated.sql, 'SELECT ID, ENABLED FROM FINAL TABLE (UPDATE TOOLS SET ENABLED=FALSE WHERE ID=?)');

const deleted = translateSql(
  'DELETE FROM tools WHERE id=$1 RETURNING tools.id',
  options,
);
assert.equal(deleted.kind, 'delete');
assert.equal(deleted.sql, 'SELECT ID FROM OLD TABLE (DELETE FROM TOOLS WHERE ID=?)');

console.log('ContextForge/Alembic PostgreSQL RETURNING -> Db2 data-change-table compatibility check OK');
