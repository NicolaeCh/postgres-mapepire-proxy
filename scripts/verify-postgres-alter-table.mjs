import assert from 'node:assert/strict';

const { translateSql } = await import('../dist/src/sql/translator.js');

const options = {
  uppercaseIdentifiers: true,
  informationSchemaRewrite: true,
  pgCatalogCompat: true,
  allowMultiStatement: false,
  maxRows: 0,
  ddlDefaultVarcharLength: 1024,
};

function tr(sql) { return translateSql(sql, options).sql.replace(/\s+/g, ' ').trim(); }

// Exact SQL emitted by SQLAlchemy PostgreSQL for ContextForge's
// op.alter_column(..., new_column_name=...) migration.
assert.equal(
  tr('ALTER TABLE tools RENAME is_active TO enabled'),
  'ALTER TABLE TOOLS RENAME COLUMN IS_ACTIVE TO ENABLED',
);
assert.equal(
  tr('ALTER TABLE gateways RENAME is_active TO enabled'),
  'ALTER TABLE GATEWAYS RENAME COLUMN IS_ACTIVE TO ENABLED',
);

// PostgreSQL also accepts explicit COLUMN. Normalization must remain idempotent.
assert.equal(
  tr('ALTER TABLE tools RENAME COLUMN is_active TO enabled'),
  'ALTER TABLE TOOLS RENAME COLUMN IS_ACTIVE TO ENABLED',
);

// Quoted and schema-qualified identifiers retain their identifier semantics.
assert.equal(
  tr('ALTER TABLE "App"."Tools" RENAME "is_active" TO "enabled"'),
  'ALTER TABLE "App"."Tools" RENAME COLUMN "is_active" TO "enabled"',
);

// The next statement in the same Alembic migration must also remain Db2-safe.
assert.equal(
  tr('ALTER TABLE tools ADD COLUMN reachable BOOLEAN DEFAULT true NOT NULL'),
  'ALTER TABLE TOOLS ADD COLUMN REACHABLE BOOLEAN DEFAULT TRUE NOT NULL',
);

console.log('PostgreSQL ALTER TABLE column-rename -> Db2 for i compatibility check OK');
