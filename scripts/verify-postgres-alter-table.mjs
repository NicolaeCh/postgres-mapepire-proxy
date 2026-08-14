import assert from 'node:assert/strict';

const { translateSql } = await import('../dist/src/sql/translator.js');
const { buildCreateOrReplaceAddColumn, DdlTableDefinitionRegistry, isAlterTableAddNotNullNoDefault, planAlterTableAddNotNullNoDefault, parsePgAlterTableRenameColumn, parsePgAlterTableRenameTable } = await import('../dist/src/sql/column-rename.js');
const { DdlForeignKeyTypeRegistry } = await import('../dist/src/sql/ddl-foreign-key.js');

const options = {
  uppercaseIdentifiers: true,
  informationSchemaRewrite: true,
  pgCatalogCompat: true,
  allowMultiStatement: false,
  maxRows: 0,
  ddlDefaultVarcharLength: 1024,
};
const tr = (sql) => translateSql(sql, options).sql.replace(/\s+/g, ' ').trim();

const definitions = new DdlTableDefinitionRegistry();
const types = new DdlForeignKeyTypeRegistry();

// A faithful shape for the pre-e75490e949b1 TOOLS table: the exact column
// values are less important than proving that IS_ACTIVE keeps its IBM i system
// column identity while PostgreSQL sees the SQL name change to ENABLED.
const createTools = tr(`CREATE TABLE tools (
  id VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL,
  CONSTRAINT pk_tools PRIMARY KEY (id),
  CONSTRAINT uq_tools_slug UNIQUE (slug)
)`);
definitions.registerCreateTable(createTools, 'MCPDATA');
types.registerCreateTable(createTools, 'MCPDATA');

const rename = parsePgAlterTableRenameColumn(
  'ALTER TABLE tools RENAME is_active TO enabled',
  'MCPDATA',
);
assert.ok(rename);
const plan = definitions.planRename(rename, 'IS_ACTIVE');
assert.ok(plan);
const db2 = plan.db2Sql.replace(/\s+/g, ' ').trim();
assert.match(db2, /^CREATE OR REPLACE TABLE TOOLS\s*\(/);
assert.match(db2, /ENABLED FOR COLUMN IS_ACTIVE BOOLEAN NOT NULL/);
assert.match(db2, /CONSTRAINT PK_TOOLS PRIMARY KEY \(ID\)/);
assert.match(db2, /CONSTRAINT UQ_TOOLS_SLUG UNIQUE \(SLUG\)/);
assert.match(db2, /ON REPLACE PRESERVE ROWS$/);
assert.doesNotMatch(db2, /\bRENAME\b/);

definitions.commitRename(plan);
types.renameColumn('TOOLS', 'IS_ACTIVE', 'ENABLED', 'MCPDATA');
assert.equal(types.getColumnType('TOOLS', 'ENABLED', 'MCPDATA'), 'BOOLEAN');
assert.equal(types.getColumnType('TOOLS', 'IS_ACTIVE', 'MCPDATA'), undefined);

// A downgrade-style rename back to the original SQL name must not duplicate
// FOR COLUMN. Because the SQL name and system name coincide again, FOR COLUMN
// is omitted while Db2 still matches the existing system column.
const renameBack = parsePgAlterTableRenameColumn(
  'ALTER TABLE tools RENAME enabled TO is_active',
  'MCPDATA',
);
assert.ok(renameBack);
const backPlan = definitions.planRename(renameBack, 'IS_ACTIVE');
assert.ok(backPlan);
const backSql = backPlan.db2Sql.replace(/\s+/g, ' ').trim();
assert.match(backSql, /IS_ACTIVE BOOLEAN NOT NULL/);
assert.doesNotMatch(backSql, /IS_ACTIVE FOR COLUMN IS_ACTIVE/);

// Keep the forward rename in the registry for the following ADD COLUMN checks.
// (The downgrade plan above is intentionally not committed.)

// The next statement in the same ContextForge migration still uses the normal
// ALTER TABLE ADD COLUMN path and must retain the Db2-safe Boolean default.
const addReachable = tr('ALTER TABLE tools ADD COLUMN reachable BOOLEAN DEFAULT true NOT NULL');
assert.equal(addReachable, 'ALTER TABLE TOOLS ADD COLUMN REACHABLE BOOLEAN DEFAULT TRUE NOT NULL');
definitions.registerAlterAddColumn(addReachable, 'MCPDATA');
types.registerAlterAddColumn(addReachable, 'MCPDATA');
assert.equal(types.getColumnType('TOOLS', 'REACHABLE', 'MCPDATA'), 'BOOLEAN');

// A second rename proves the remembered post-ALTER definition remains usable.
const renameReachable = parsePgAlterTableRenameColumn(
  'ALTER TABLE tools RENAME COLUMN reachable TO is_reachable',
  'MCPDATA',
);
assert.ok(renameReachable);
const plan2 = definitions.planRename(renameReachable, 'REACHABLE');
assert.ok(plan2);
assert.match(plan2.db2Sql.replace(/\s+/g, ' '), /IS_REACHABLE FOR COLUMN REACHABLE BOOLEAN DEFAULT TRUE NOT NULL/);

// Quoted/schema-qualified parsing must preserve PostgreSQL identifier case.
const quoted = parsePgAlterTableRenameColumn(
  'ALTER TABLE "App"."Tools" RENAME "is_active" TO "enabled"',
  'MCPDATA',
);
assert.deepEqual(
  quoted && { schema: quoted.schema, table: quoted.table, old: quoted.oldColumn, next: quoted.newColumn },
  { schema: 'App', table: 'Tools', old: 'is_active', next: 'enabled' },
);

// Safety invariant: an existing table not captured by the trusted DDL registry
// must not be renamed using an add/copy/drop guess.
const unknownRegistry = new DdlTableDefinitionRegistry();
assert.equal(unknownRegistry.planRename(rename, 'IS_ACTIVE'), undefined);

// Transaction rollback restores the remembered definition rather than leaving
// an uncommitted rename in the proxy's compatibility registry.
const txRegistry = new DdlTableDefinitionRegistry();
txRegistry.registerCreateTable(createTools, 'MCPDATA');
txRegistry.beginTransaction();
const txPlan = txRegistry.planRename(rename, 'IS_ACTIVE');
assert.ok(txPlan);
txRegistry.commitRename(txPlan);
txRegistry.rollbackTransaction();
assert.ok(txRegistry.planRename(rename, 'IS_ACTIVE'));

console.log('PostgreSQL column rename -> IBM i CREATE OR REPLACE PRESERVE ROWS compatibility check OK');

// PostgreSQL permits ADD COLUMN NOT NULL without DEFAULT when the target table
// is empty. Db2 for i cannot safely emulate it with ADD nullable + SET NOT
// NULL over JDBC/Mapepire, and DROP DEFAULT is not valid for a NOT NULL IBM i
// column. The proxy therefore combines the exact IBM i-generated table DDL
// with CREATE OR REPLACE TABLE and injects the requested column.
const addEmail = tr('ALTER TABLE oauth_tokens ADD COLUMN app_user_email VARCHAR(255) NOT NULL');
assert.equal(isAlterTableAddNotNullNoDefault(addEmail, 'MCPDATA'), true);
const addEmailPlan = planAlterTableAddNotNullNoDefault(addEmail, 'MCPDATA');
assert.ok(addEmailPlan);
assert.equal(addEmailPlan.probeSql, 'SELECT 1 AS PROXY_ROW FROM "MCPDATA"."OAUTH_TOKENS" FETCH FIRST 1 ROW ONLY');
const generatedOauth = 'CREATE OR REPLACE TABLE "MCPDATA"."OAUTH_TOKENS" (ID VARCHAR(36) NOT NULL, CONSTRAINT PK_OAUTH PRIMARY KEY (ID)) RCDFMT OAUTHTOK';
const oauthReplacement = buildCreateOrReplaceAddColumn(generatedOauth, addEmailPlan, 'MCPDATA');
assert.ok(oauthReplacement);
assert.match(oauthReplacement, /APP_USER_EMAIL VARCHAR\(255\) NOT NULL,CONSTRAINT PK_OAUTH/);
assert.match(oauthReplacement, /RCDFMT OAUTHTOK$/);
assert.doesNotMatch(oauthReplacement, /SET\s+NOT\s+NULL|WITH\s+DEFAULT|DROP\s+DEFAULT/i);

// SQLAlchemy/Alembic op.rename_table() emits ALTER TABLE old RENAME TO new.
// IBM i has a native RENAME TABLE statement, so table rename is mapped rather
// than routed through the column-rename emulation.
const tableRename = parsePgAlterTableRenameTable(
  'ALTER TABLE servers_tmp_nounique RENAME TO servers',
  'MCPDATA',
);
assert.ok(tableRename);
assert.equal(tableRename.db2Sql, 'RENAME TABLE servers_tmp_nounique TO SERVERS');
const tempRegistry = new DdlTableDefinitionRegistry();
tempRegistry.registerCreateTable(tr('CREATE TABLE servers_tmp_nounique (id VARCHAR(36) NOT NULL)'), 'MCPDATA');
assert.equal(tempRegistry.renameTable(tableRename), true);
assert.equal(tempRegistry.hasTable('servers', 'MCPDATA'), true);
assert.equal(tempRegistry.hasTable('servers_tmp_nounique', 'MCPDATA'), false);

types.registerCreateTable(tr('CREATE TABLE servers_tmp_nounique (id VARCHAR(36) NOT NULL)'), 'MCPDATA');
types.renameTable('servers_tmp_nounique', 'servers', 'MCPDATA');
assert.equal(types.getColumnType('servers', 'id', 'MCPDATA'), 'VARCHAR(36)');

console.log('PostgreSQL ADD NOT NULL / table rename compatibility check OK');

