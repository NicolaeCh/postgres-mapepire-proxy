import assert from 'node:assert/strict';
import {
  classifyPgAdminIbmiTableQuery,
  IBMI_TABLE_CATALOG_SQL,
  renderPgAdminIbmiTableQuery,
  tableOid,
  parsePgTableOwnerDdl,
} from '../dist/src/sql/pgadmin-ibmi-table.js';
import { schemaOid, legacySchemaOid, findSchemaByCompatibleOid } from '../dist/src/sql/pgadmin-ibmi.js';

const scid = schemaOid('MONAI');
const tables = [
  { schema: 'MONAI', name: 'CUSTOMERS', owner: 'MAPESVC', type: 'T', text: 'Customers', longComment: null, columnCount: 4 },
  { schema: 'MONAI', name: 'ORDERS', owner: 'MAPESVC', type: 'T', text: null, longComment: 'Orders table', columnCount: 8 },
];
const ctx = { user: 'nicolae' };
const schemas = [
  { name: 'AAA', owner: 'MAPESVC', text: null },
  { name: 'MONAI', owner: 'MAPESVC', text: null },
  { name: 'ZZZ', owner: 'MAPESVC', text: null },
];
assert.match(IBMI_TABLE_CATALOG_SQL, /TABLE_TYPE IN \('T', 'P'\)/);
assert.match(IBMI_TABLE_CATALOG_SQL, /FILE_TYPE = 'D'/);
assert.doesNotMatch(IBMI_TABLE_CATALOG_SQL, /SYSTEM_TABLE_TYPE/);
assert.equal(findSchemaByCompatibleOid(schemas, schemaOid('MONAI'))?.name, 'MONAI');
assert.equal(findSchemaByCompatibleOid(schemas, legacySchemaOid(schemas, 'MONAI'))?.name, 'MONAI');

const run = (sql) => {
  const req = classifyPgAdminIbmiTableQuery(sql);
  assert.ok(req, `Expected live IBM i table contract for: ${sql}`);
  const result = renderPgAdminIbmiTableQuery(req, tables, scid, ctx);
  for (const row of result.rows) assert.equal(row.length, result.fields.length, 'synthetic table row shape mismatch');
  return result;
};

const count = run(`SELECT COUNT(*) FROM pg_catalog.pg_class rel
WHERE rel.relkind IN ('r','s','t','p') AND rel.relnamespace = ${scid}::oid
AND NOT rel.relispartition;`);
assert.deepEqual(count.fields.map((f) => f.name), ['count']);
assert.deepEqual(count.rows, [[2]]);

const nodes = run(`SELECT rel.oid, rel.relname AS name,
(SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid=rel.oid AND tgisinternal = FALSE) AS triggercount,
(SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid=rel.oid AND tgisinternal = FALSE AND tgenabled = 'O') AS has_enable_triggers,
(CASE WHEN rel.relkind = 'p' THEN true ELSE false END) AS is_partitioned,
(SELECT count(1) FROM pg_catalog.pg_inherits WHERE inhrelid=rel.oid LIMIT 1) as is_inherits,
(SELECT count(1) FROM pg_catalog.pg_inherits WHERE inhparent=rel.oid LIMIT 1) as is_inherited,
des.description FROM pg_catalog.pg_class rel
LEFT OUTER JOIN pg_catalog.pg_description des ON (des.objoid=rel.oid)
WHERE rel.relkind IN ('r','s','t','p') AND rel.relnamespace = ${scid}::oid
AND NOT rel.relispartition ORDER BY rel.relname;`);
assert.deepEqual(nodes.fields.map((f) => f.name), [
  'oid','name','triggercount','has_enable_triggers','is_partitioned','is_inherits','is_inherited','description',
]);
assert.equal(nodes.rows.length, 2);
assert.equal(nodes.rows[0][0], tableOid('MONAI', 'CUSTOMERS'));
assert.equal(nodes.rows[1][7], 'Orders table');

const oid = tableOid('MONAI', 'ORDERS');
const props = run(`SELECT rel.oid, rel.relname AS name, rel.reltablespace AS spcoid, rel.relacl AS relacl_str,
'pg_default' as spcname, 'default' as replica_identity,
(select nspname FROM pg_catalog.pg_namespace WHERE oid = ${scid}::oid) as schema,
pg_catalog.pg_get_userbyid(rel.relowner) AS relowner, rel.relkind,
false AS is_partitioned, rel.relhassubclass, rel.reltuples::bigint, des.description, con.conname, con.conkey,
EXISTS(select 1 FROM pg_catalog.pg_trigger WHERE tgrelid=rel.oid) AS isrepl,
0 AS triggercount, NULL AS coll_inherits, 0 AS inherited_tables_cnt, false AS relpersistence,
'heap' AS default_amname, NULL AS fillfactor, NULL AS parallel_workers, NULL AS toast_tuple_target,
NULL AS autovacuum_enabled, NULL AS autovacuum_vacuum_threshold, NULL AS autovacuum_vacuum_scale_factor,
NULL AS autovacuum_analyze_threshold, NULL AS autovacuum_analyze_scale_factor, NULL AS autovacuum_vacuum_cost_delay,
NULL AS autovacuum_vacuum_cost_limit, NULL AS autovacuum_freeze_min_age, NULL AS autovacuum_freeze_max_age,
NULL AS autovacuum_freeze_table_age, NULL AS toast_autovacuum_enabled, NULL AS toast_autovacuum_vacuum_threshold,
NULL AS toast_autovacuum_vacuum_scale_factor, NULL AS toast_autovacuum_analyze_threshold,
NULL AS toast_autovacuum_analyze_scale_factor, NULL AS toast_autovacuum_vacuum_cost_delay,
NULL AS toast_autovacuum_vacuum_cost_limit, NULL AS toast_autovacuum_freeze_min_age,
NULL AS toast_autovacuum_freeze_max_age, NULL AS toast_autovacuum_freeze_table_age,
rel.reloptions AS reloptions, NULL AS toast_reloptions, rel.reloftype, am.amname, typ.typname,
typ.typrelid AS typoid, rel.relrowsecurity as rlspolicy, rel.relforcerowsecurity as forcerlspolicy,
false AS hastoasttable, NULL AS seclabels, false AS is_sys_table
FROM pg_catalog.pg_class rel LEFT JOIN pg_catalog.pg_description des ON true
LEFT JOIN pg_catalog.pg_constraint con ON true LEFT JOIN pg_catalog.pg_am am ON true
LEFT JOIN pg_catalog.pg_type typ ON true
WHERE rel.relkind IN ('r','s','t','p') AND rel.relnamespace = ${scid}::oid AND rel.oid = ${oid}::OID`);
assert.equal(props.rows.length, 1);
assert.equal(props.rows[0][0], oid);
assert.equal(props.rows[0][1], 'ORDERS');
assert.ok(props.fields.some((f) => f.name === 'isrepl'));

const name = run(`SELECT rel.relname AS name FROM pg_catalog.pg_class rel
WHERE rel.relkind IN ('r','s','t','p') AND rel.relnamespace = ${scid}::oid AND rel.oid = ${oid}::oid;`);
assert.deepEqual(name.rows, [['ORDERS']]);

const owner = parsePgTableOwnerDdl('ALTER TABLE IF EXISTS "MONAI"."ORDERS" OWNER TO "nicolae";');
assert.deepEqual(owner, { table: '"MONAI"."ORDERS"', requestedOwner: 'nicolae' });


const contaminated = classifyPgAdminIbmiTableQuery(`SELECT rel.oid, rel.relname AS name,
(SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid=rel.oid AND tgisinternal = FALSE) AS triggercount,
(SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid=rel.oid AND tgisinternal = FALSE AND tgenabled = 'O') AS has_enable_triggers,
false AS is_partitioned,
(SELECT count(1) FROM pg_catalog.pg_inherits WHERE inhrelid=rel.oid LIMIT 1) AS is_inherits,
(SELECT count(1) FROM pg_catalog.pg_inherits WHERE inhparent=rel.oid LIMIT 1) AS is_inherited,
des.description FROM pg_catalog.pg_class rel
LEFT JOIN pg_catalog.pg_description des ON des.objoid=rel.oid
WHERE rel.relnamespace = ${scid}::oid AND rel.relkind IN ('r','s','t','p')
AND NOT rel.relispartition
AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='pg_catalog' AND n.oid=rel.relnamespace)`);
assert.ok(contaminated);
assert.equal(contaminated.kind, 'nodes');
assert.equal(contaminated.schemaOid, scid);
assert.equal(contaminated.schemaName, undefined);

const schemaBrowserSql = `SELECT nsp.oid, nsp.nspname as name,
pg_catalog.has_schema_privilege(nsp.oid, 'CREATE') as can_create,
pg_catalog.has_schema_privilege(nsp.oid, 'USAGE') as has_usage, des.description
FROM pg_catalog.pg_namespace nsp
LEFT JOIN pg_catalog.pg_description des ON des.objoid=nsp.oid
WHERE NOT ((nsp.nspname = 'pg_catalog' AND EXISTS
(SELECT 1 FROM pg_catalog.pg_class WHERE relname='pg_class' AND relnamespace=nsp.oid LIMIT 1)));`;
assert.equal(classifyPgAdminIbmiTableQuery(schemaBrowserSql), undefined, 'schema browser SQL must not be stolen by table classifier');

console.log('pgAdmin IBM i table browser contract check OK');
