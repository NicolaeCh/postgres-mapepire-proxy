import assert from 'node:assert/strict';

process.env.IBMI_RDB_NAME ??= 'BUILDTEST';
process.env.IBMI_HOST ??= 'build-test.invalid';
process.env.IBMI_USER ??= 'build-test';
process.env.IBMI_PASSWORD ??= 'build-test';
process.env.PG_PROXY_USER ??= 'proxyuser';
process.env.PG_PROXY_PASSWORD ??= 'proxypass';
process.env.IBMI_CURRENT_SCHEMA ??= 'MCPDATA';
process.env.DEFAULT_SCHEMA ??= 'MCPDATA';
process.env.PG_SERVER_VERSION ??= '14.0';

const { ProxySession } = await import('../dist/src/proxy/session.js');
const { tableOid } = await import('../dist/src/sql/pgadmin-ibmi-table.js');

const tables = [
  { TABLE_SCHEMA:'MCPDATA', TABLE_NAME:'A2A_AGENTS', TABLE_OWNER:'MAPESVC', TABLE_TYPE:'T', TABLE_TEXT:null, LONG_COMMENT:null, COLUMN_COUNT:3 },
  { TABLE_SCHEMA:'MCPDATA', TABLE_NAME:'TOOLS', TABLE_OWNER:'MAPESVC', TABLE_TYPE:'T', TABLE_TEXT:'tool rows', LONG_COMMENT:null, COLUMN_COUNT:2 },
];
const columns = {
  A2A_AGENTS: [
    col('ID',1,'VARCHAR',36,false),
    col('NAME',2,'VARCHAR',255,false),
    col('VISIBILITY',3,'VARCHAR',20,true),
    col('ENABLED',4,'BOOLEAN',1,true),
  ],
  TOOLS: [colFor('TOOLS','ID',1,'VARCHAR',36,false), colFor('TOOLS','VISIBILITY',2,'VARCHAR',20,true)],
};
const indexes = {
  A2A_AGENTS: [
    { INDEX_SCHEMA:'MCPDATA', INDEX_NAME:'IDX_A2A_AGENTS_NAME', INDEX_OWNER:'MAPESVC', TABLE_SCHEMA:'MCPDATA', TABLE_NAME:'A2A_AGENTS', IS_UNIQUE:'D', COLUMN_COUNT:1, LONG_COMMENT:null, INDEX_TEXT:null, COLUMN_NAMES:'NAME', SEARCH_CONDITION:null },
    { INDEX_SCHEMA:'MCPDATA', INDEX_NAME:'IDX_A2A_AGENTS_ENABLED', INDEX_OWNER:'MAPESVC', TABLE_SCHEMA:'MCPDATA', TABLE_NAME:'A2A_AGENTS', IS_UNIQUE:'D', COLUMN_COUNT:1, LONG_COMMENT:null, INDEX_TEXT:null, COLUMN_NAMES:'ENABLED', SEARCH_CONDITION:null },
  ],
  TOOLS: [
    // Reproduce the 0.1.33 failure: SYSINDEXES sees the index, but the joined
    // SYSTABLEINDEXSTAT projection has not supplied COLUMN_NAMES yet.
    { INDEX_SCHEMA:'MCPDATA', INDEX_NAME:'IX_TOOLS_VISIBILITY', INDEX_OWNER:'MAPESVC', TABLE_SCHEMA:'MCPDATA', TABLE_NAME:'TOOLS', IS_UNIQUE:'D', COLUMN_COUNT:1, LONG_COMMENT:null, INDEX_TEXT:null, COLUMN_NAMES:null, SEARCH_CONDITION:null },
  ],
};
const nativeIndexes = {
  TOOLS: [
    { INDEX_SCHEMA:'MCPDATA', INDEX_NAME:'IX_TOOLS_VISIBILITY', INDEX_OWNER:'', TABLE_SCHEMA:'MCPDATA', TABLE_NAME:'TOOLS', IS_UNIQUE:'D', COLUMN_COUNT:1, LONG_COMMENT:null, INDEX_TEXT:'INDEX: VISIBILITY', COLUMN_NAMES:'VISIBILITY', SEARCH_CONDITION:null },
  ],
};

const fakeJob = {
  execute: async (sql) => {
    if (/VALUES\s+CURRENT\s+SCHEMA/i.test(sql)) return result([{ CURRENT_SCHEMA:'MCPDATA' }]);
    return result([], false);
  },
  query: (sql, options) => ({
    execute: async () => catalog(sql, options?.parameters ?? []),
    fetchMore: async () => ({ ...result([]), is_done:true }),
    close: async () => {},
  }),
};
const fakePool = {
  acquire: async () => fakeJob,
  release: async () => {},
  invalidate: async () => {},
  prepareSchema: async (_job, schema) => ({ schema, systemSchema:schema, exists:true, hasQsqjrn:true, hasLibraryJournalInheritance:true, inheritedJournal:`${schema}/QSQJRN`, transactionalWritesConfigured:true, sqlSchemaJournalReady:true, checkedAt:'2000-01-01T00:00:00.000Z' }),
};
const connection = { sendData(){} };
const logger = { debug(){}, info(){}, warn(){}, error(){} };
const session = new ProxySession(connection, fakePool, { user:'proxyuser', database:'BUILDTEST' }, logger);
await session.initialize();

const relationNamesSql = `SELECT pg_catalog.pg_class.relname FROM pg_catalog.pg_class
JOIN pg_catalog.pg_namespace ON pg_catalog.pg_namespace.oid = pg_catalog.pg_class.relnamespace
WHERE pg_catalog.pg_class.relkind = ANY (ARRAY[$1::VARCHAR,$2::VARCHAR])
AND pg_catalog.pg_table_is_visible(pg_catalog.pg_class.oid)
AND pg_catalog.pg_namespace.nspname != $3::VARCHAR`;
let r = await session.resolveSynthetic(relationNamesSql, ['r','p','pg_catalog']);
assert.deepEqual(r.rows.map((x)=>x[0]), ['a2a_agents','tools']);

// SQLAlchemy get_multi_table_comment() uses the same pg_class/namespace/
// relkind skeleton as get_table_names(), but expects exactly two values per
// row. 0.1.33 classified this as relationNames and caused
// `not enough values to unpack (expected 2, got 1)` in Table autoload.
const commentSql = `SELECT pg_catalog.pg_class.relname, pg_catalog.pg_description.description
FROM pg_catalog.pg_class LEFT OUTER JOIN pg_catalog.pg_description
ON pg_catalog.pg_class.oid = pg_catalog.pg_description.objoid
JOIN pg_catalog.pg_namespace ON pg_catalog.pg_namespace.oid = pg_catalog.pg_class.relnamespace
WHERE pg_catalog.pg_class.relkind = ANY (ARRAY[$1::VARCHAR,$2::VARCHAR])
AND pg_catalog.pg_class.relname IN ($3::VARCHAR)`;
r = await session.resolveSynthetic(commentSql, ['r','p','tools']);
assert.deepEqual(r.fields.map((f)=>f.name), ['relname','description']);
assert.deepEqual(r.rows, [['tools','tool rows']]);

const hasTableSql = `SELECT pg_catalog.pg_class.relname FROM pg_catalog.pg_class
JOIN pg_catalog.pg_namespace ON pg_catalog.pg_namespace.oid = pg_catalog.pg_class.relnamespace
WHERE pg_catalog.pg_class.relname = $1::VARCHAR
AND pg_catalog.pg_class.relkind = ANY (ARRAY[$2::VARCHAR,$3::VARCHAR])
AND pg_catalog.pg_table_is_visible(pg_catalog.pg_class.oid)`;
r = await session.resolveSynthetic(hasTableSql, ['a2a_agents','r','p']);
assert.equal(r.rows[0][0], 'a2a_agents');
r = await session.resolveSynthetic(hasTableSql, ['missing_table','r','p']);
assert.equal(r.rows.length, 0);

const columnsSql = `SELECT pg_catalog.pg_attribute.attname AS name,
pg_catalog.format_type(pg_catalog.pg_attribute.atttypid, pg_catalog.pg_attribute.atttypmod) AS format_type,
NULL AS default, pg_catalog.pg_attribute.attnotnull AS not_null,
pg_catalog.pg_class.relname AS table_name, NULL AS comment,
pg_catalog.pg_attribute.attgenerated AS generated, NULL AS identity_options, NULL AS collation
FROM pg_catalog.pg_class LEFT JOIN pg_catalog.pg_attribute ON pg_catalog.pg_class.oid=pg_catalog.pg_attribute.attrelid
JOIN pg_catalog.pg_namespace ON pg_catalog.pg_namespace.oid=pg_catalog.pg_class.relnamespace
WHERE pg_catalog.pg_class.relkind = ANY (ARRAY[$1::VARCHAR,$2::VARCHAR])
AND pg_catalog.pg_class.relname IN ($3::VARCHAR)`;
r = await session.resolveSynthetic(columnsSql, ['r','p','a2a_agents']);
assert.deepEqual(r.fields.map((f)=>f.name), ['name','format_type','default','not_null','table_name','comment','generated','identity_options','collation']);
assert.deepEqual(r.rows.map((x)=>x[0]), ['id','name','visibility','enabled']);

const oidSql = `SELECT pg_catalog.pg_class.oid, pg_catalog.pg_class.relname FROM pg_catalog.pg_class
JOIN pg_catalog.pg_namespace ON pg_catalog.pg_namespace.oid=pg_catalog.pg_class.relnamespace
WHERE pg_catalog.pg_class.relkind = ANY (ARRAY[$1::VARCHAR,$2::VARCHAR])
AND pg_catalog.pg_class.relname IN ($3::VARCHAR)`;
r = await session.resolveSynthetic(oidSql, ['r','p','a2a_agents']);
const a2aOid = tableOid('MCPDATA','A2A_AGENTS');
assert.deepEqual(r.rows, [[a2aOid,'a2a_agents']]);

const indexSql = `SELECT pg_catalog.pg_index.indrelid, pg_catalog.pg_class.relname,
pg_catalog.pg_index.indisunique, false AS has_constraint, pg_catalog.pg_index.indoption,
pg_catalog.pg_class.reloptions, pg_catalog.pg_am.amname, NULL AS filter_definition,
pg_catalog.pg_index.indnkeyatts, false AS indnullsnotdistinct,
idx_cols.elements, idx_cols.elements_is_expr, idx_cols.elements_opclass, idx_cols.elements_opdefault
FROM pg_catalog.pg_index JOIN pg_catalog.pg_class ON pg_catalog.pg_index.indexrelid=pg_catalog.pg_class.oid
JOIN pg_catalog.pg_am ON pg_catalog.pg_class.relam=pg_catalog.pg_am.oid
LEFT JOIN (SELECT array_agg('x') AS elements, array_agg(false) AS elements_is_expr,
array_agg('') AS elements_opclass, array_agg(true) AS elements_opdefault) idx_cols ON true
WHERE pg_catalog.pg_index.indrelid IN ($1::OID)`;
r = await session.resolveSynthetic(indexSql, [String(a2aOid)]);
assert.deepEqual(r.rows.map((x)=>x[1]), ['idx_a2a_agents_name','idx_a2a_agents_enabled']);
assert.equal(r.fields[4].typeOid, 22);
assert.equal(r.rows[0][4], '0');
assert.deepEqual(String(r.rows[0][4]).split(' ').map(Number), [0]);
assert.equal(r.rows[0][10], '{"name"}');

// Reproduce the partial-index metadata seen by ContextForge. The proxy must
// supplement COLUMN_NAMES from SYSTABLEINDEXSTAT rather than send an empty
// int2vector (which psycopg parses as int('')).
const toolsOid = tableOid('MCPDATA','TOOLS');
r = await session.resolveSynthetic(indexSql, [String(toolsOid)]);
assert.equal(r.rows.length, 1);
assert.equal(r.rows[0][1], 'ix_tools_visibility');
assert.equal(r.rows[0][4], '0');
assert.equal(r.rows[0][10], '{"visibility"}');

const fkSql = `SELECT pg_catalog.pg_class.relname, pg_catalog.pg_constraint.conname,
CASE WHEN pg_catalog.pg_constraint.oid IS NOT NULL THEN pg_catalog.pg_get_constraintdef(pg_catalog.pg_constraint.oid,true) END,
nsp_ref.nspname, pg_catalog.pg_description.description
FROM pg_catalog.pg_class LEFT JOIN pg_catalog.pg_constraint ON pg_catalog.pg_class.oid=pg_catalog.pg_constraint.conrelid
LEFT JOIN pg_catalog.pg_class cls_ref ON cls_ref.oid=pg_catalog.pg_constraint.confrelid
LEFT JOIN pg_catalog.pg_namespace nsp_ref ON cls_ref.relnamespace=nsp_ref.oid
LEFT JOIN pg_catalog.pg_description ON pg_catalog.pg_description.objoid=pg_catalog.pg_constraint.oid
JOIN pg_catalog.pg_namespace ON pg_catalog.pg_namespace.oid=pg_catalog.pg_class.relnamespace
WHERE pg_catalog.pg_class.relkind = ANY (ARRAY[$1::VARCHAR]) AND pg_catalog.pg_class.relname IN ($2::VARCHAR)`;
r = await session.resolveSynthetic(fkSql, ['r','a2a_agents']);
assert.equal(r.rows.length, 1);
assert.equal(r.rows[0][1], 'fk_a2a_agents_tool_id');
assert.match(String(r.rows[0][2]), /REFERENCES "tools"\("id"\)/);

// SQLAlchemy CHECK reflection also calls pg_get_constraintdef(), but it has a
// four-column shape and no confrelid/nsp_ref join. It must not be routed to the
// five-column foreign-key renderer.
const checkSql = `SELECT pg_catalog.pg_class.relname, pg_catalog.pg_constraint.conname,
CASE WHEN pg_catalog.pg_constraint.oid IS NOT NULL THEN pg_catalog.pg_get_constraintdef(pg_catalog.pg_constraint.oid,true) END AS src,
pg_catalog.pg_description.description
FROM pg_catalog.pg_class LEFT JOIN pg_catalog.pg_constraint
ON pg_catalog.pg_class.oid=pg_catalog.pg_constraint.conrelid
LEFT JOIN pg_catalog.pg_description ON pg_catalog.pg_description.objoid=pg_catalog.pg_constraint.oid
JOIN pg_catalog.pg_namespace ON pg_catalog.pg_namespace.oid=pg_catalog.pg_class.relnamespace
WHERE pg_catalog.pg_class.relkind = ANY (ARRAY[$1::VARCHAR])
AND pg_catalog.pg_class.relname IN ($2::VARCHAR)`;
r = await session.resolveSynthetic(checkSql, ['r','tools']);
assert.deepEqual(r.fields.map((f)=>f.name), ['relname','conname','src','description']);
assert.deepEqual(r.rows, [['tools',null,null,null]]);

const keyConstraintSql = `SELECT attr.conrelid, array_agg(CAST(attr.attname AS TEXT) ORDER BY attr.ord) AS cols,
attr.conname, min(attr.description) AS description, min(attr.indnkeyatts) AS indnkeyatts,
bool_and(attr.indnullsnotdistinct) AS indnullsnotdistinct
FROM (SELECT con.conrelid, con.conname, pg_catalog.pg_attribute.attname, con.ord,
con.indnkeyatts, con.indnullsnotdistinct, con.description
FROM pg_catalog.pg_attribute JOIN (SELECT pg_catalog.pg_constraint.conrelid,
pg_catalog.pg_constraint.conname, unnest(pg_catalog.pg_index.indkey) AS attnum,
pg_catalog.pg_index.indnkeyatts, false AS indnullsnotdistinct, NULL AS description, 1 AS ord
FROM pg_catalog.pg_constraint JOIN pg_catalog.pg_index
ON pg_catalog.pg_constraint.conindid=pg_catalog.pg_index.indexrelid
WHERE pg_catalog.pg_constraint.contype=$1::VARCHAR AND pg_catalog.pg_constraint.conrelid IN ($2::OID)) con
ON pg_catalog.pg_attribute.attnum=con.attnum AND pg_catalog.pg_attribute.attrelid=con.conrelid) attr
GROUP BY attr.conrelid, attr.conname`;
r = await session.resolveSynthetic(keyConstraintSql, ['p', String(a2aOid)]);
assert.equal(r.rows.length, 1);
assert.equal(r.rows[0][0], a2aOid);
assert.equal(r.rows[0][1], '{"id"}');
assert.equal(r.rows[0][2], 'pk_a2a_agents');

await session.close();
console.log('SQLAlchemy/Alembic live IBM i reflection compatibility check OK');

function col(name, ordinal, dataType, length, nullable) { return colFor('A2A_AGENTS', name, ordinal, dataType, length, nullable); }
function colFor(table, name, ordinal, dataType, length, nullable) {
  return { TABLE_SCHEMA:'MCPDATA', TABLE_NAME:table, COLUMN_NAME:name, ORDINAL_POSITION:ordinal,
    DATA_TYPE:dataType, LENGTH:length, NUMERIC_SCALE:null, NUMERIC_PRECISION:null, IS_NULLABLE:nullable?'Y':'N',
    LONG_COMMENT:null, COLUMN_TEXT:null, HAS_DEFAULT:'N', COLUMN_DEFAULT:null, CHARACTER_MAXIMUM_LENGTH:length,
    DATETIME_PRECISION:null, IS_IDENTITY:'NO', IDENTITY_GENERATION:null, COLUMN_EXPRESSION:null };
}
function result(data, has_results=true) { return { has_results, data, is_done:true, update_count:0, metadata:{columns:[]} }; }
function catalog(sql, params) {
  if (/QSYS2\.SYSSCHEMAS/i.test(sql)) return result([{SCHEMA_NAME:'MCPDATA',SCHEMA_OWNER:'MAPESVC',SCHEMA_TEXT:null}]);
  if (/QSYS2\.SYSTABLES/i.test(sql)) return result(String(params[0] ?? '').toUpperCase()==='MCPDATA' ? tables : []);
  if (/QSYS2\.SYSCOLUMNS2/i.test(sql)) return result(columns[String(params[1] ?? '').toUpperCase()] ?? []);
  if (/FROM QSYS2\.SYSINDEXES/i.test(sql)) return result(indexes[String(params[1] ?? '').toUpperCase()] ?? []);
  if (/FROM QSYS2\.SYSTABLEINDEXSTAT/i.test(sql)) return result(nativeIndexes[String(params[1] ?? '').toUpperCase()] ?? []);
  if (/FROM QSYS2\.SYSCST FK/i.test(sql)) return result([{
    CONSTRAINT_SCHEMA:'MCPDATA', CONSTRAINT_NAME:'FK_A2A_AGENTS_TOOL_ID', TABLE_SCHEMA:'MCPDATA', TABLE_NAME:'A2A_AGENTS',
    FK_COLUMN:'TOOL_ID', ORDINAL_POSITION:1, REFERENCED_TABLE_SCHEMA:'MCPDATA', REFERENCED_TABLE_NAME:'TOOLS',
    REFERENCED_COLUMN:'ID', UPDATE_RULE:'NO ACTION', DELETE_RULE:'CASCADE',
  }]);
  if (/FROM QSYS2\.SYSCST C/i.test(sql)) return result([{
    CONSTRAINT_SCHEMA:'MCPDATA', CONSTRAINT_NAME:'PK_A2A_AGENTS', CONSTRAINT_TYPE:'PRIMARY KEY',
    TABLE_SCHEMA:'MCPDATA', TABLE_NAME:'A2A_AGENTS', COLUMN_NAME:'ID', ORDINAL_POSITION:1,
  }]);
  if (/QSYS2\.SYSVIEWS/i.test(sql)) return result([]);
  throw new Error(`Unexpected verifier catalog query: ${sql}`);
}
