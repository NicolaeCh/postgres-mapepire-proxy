import { describe, expect, it } from 'vitest';
import {
  classifyPgAdminIbmiTableQuery,
  IBMI_TABLE_CATALOG_SQL,
  renderPgAdminIbmiTableQuery,
  tableOid,
} from '../src/sql/pgadmin-ibmi-table.js';
import { schemaOid, legacySchemaOid, findSchemaByCompatibleOid } from '../src/sql/pgadmin-ibmi.js';

const scid = schemaOid('MONAI');
const tables = [
  { schema: 'MONAI', name: 'CUSTOMERS', owner: 'MAPESVC', type: 'T', text: 'Customers', longComment: null, columnCount: 4 },
  { schema: 'MONAI', name: 'ORDERS', owner: 'MAPESVC', type: 'T', text: null, longComment: 'Orders table', columnCount: 8 },
];
const ctx = { user: 'nicolae' };
const run = (sql: string) => {
  const req = classifyPgAdminIbmiTableQuery(sql);
  expect(req).toBeTruthy();
  return renderPgAdminIbmiTableQuery(req!, tables, scid, ctx);
};

describe('pgAdmin IBM i table browser contract', () => {
  it('uses the documented QSYS2.SYSTABLES file-type filter and supports legacy schema OIDs', () => {
    expect(IBMI_TABLE_CATALOG_SQL).toContain("FILE_TYPE = 'D'");
    expect(IBMI_TABLE_CATALOG_SQL).not.toContain('SYSTEM_TABLE_TYPE');
    const schemas = [
      { name: 'AAA', owner: 'MAPESVC', text: null },
      { name: 'MONAI', owner: 'MAPESVC', text: null },
      { name: 'ZZZ', owner: 'MAPESVC', text: null },
    ];
    expect(findSchemaByCompatibleOid(schemas, schemaOid('MONAI'))?.name).toBe('MONAI');
    expect(findSchemaByCompatibleOid(schemas, legacySchemaOid(schemas, 'MONAI')!)?.name).toBe('MONAI');
  });

  it('answers the exact table collection count contract', () => {
    const result = run(`SELECT COUNT(*) FROM pg_catalog.pg_class rel
      WHERE rel.relkind IN ('r','s','t','p') AND rel.relnamespace = ${scid}::oid
      AND NOT rel.relispartition;`);
    expect(result.fields.map((f) => f.name)).toEqual(['count']);
    expect(result.rows).toEqual([[2]]);
  });

  it('returns the exact pgAdmin table node shape using stable virtual OIDs', () => {
    const result = run(`SELECT rel.oid, rel.relname AS name,
      (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid=rel.oid AND tgisinternal = FALSE) AS triggercount,
      (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid=rel.oid AND tgisinternal = FALSE AND tgenabled = 'O') AS has_enable_triggers,
      (CASE WHEN rel.relkind = 'p' THEN true ELSE false END) AS is_partitioned,
      (SELECT count(1) FROM pg_catalog.pg_inherits WHERE inhrelid=rel.oid LIMIT 1) as is_inherits,
      (SELECT count(1) FROM pg_catalog.pg_inherits WHERE inhparent=rel.oid LIMIT 1) as is_inherited,
      des.description FROM pg_catalog.pg_class rel
      LEFT OUTER JOIN pg_catalog.pg_description des ON (des.objoid=rel.oid)
      WHERE rel.relkind IN ('r','s','t','p') AND rel.relnamespace = ${scid}::oid
      AND NOT rel.relispartition ORDER BY rel.relname;`);
    expect(result.fields.map((f) => f.name)).toEqual([
      'oid','name','triggercount','has_enable_triggers','is_partitioned','is_inherits','is_inherited','description',
    ]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.[0]).toBe(tableOid('MONAI', 'CUSTOMERS'));
    expect(result.rows[1]?.[7]).toBe('Orders table');
  });

  it('returns a complete property row and never forwards pgAdmin EXISTS to Db2', () => {
    const oid = tableOid('MONAI', 'ORDERS');
    const result = run(`SELECT rel.oid, rel.relname AS name, rel.reltablespace AS spcoid, rel.relacl AS relacl_str,
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
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.length).toBe(result.fields.length);
    expect(result.fields.map((f) => f.name)).toContain('isrepl');
    expect(result.rows[0]?.[0]).toBe(oid);
    expect(result.rows[0]?.[1]).toBe('ORDERS');
  });

  it('supports post-create OID and name lookups', () => {
    const oid = tableOid('MONAI', 'ORDERS');
    const byOid = run(`SELECT rel.relname AS name FROM pg_catalog.pg_class rel
      WHERE rel.relnamespace = ${scid}::oid AND rel.oid = ${oid}::oid`);
    expect(byOid.rows).toEqual([['ORDERS']]);

    const byName = run(`SELECT rel.oid FROM pg_catalog.pg_class rel
      WHERE rel.relnamespace = ${scid}::oid AND rel.relname = 'ORDERS'`);
    expect(byName.rows).toEqual([[oid]]);
  });
  it('does not confuse nested pg_catalog nspname predicates with the target table schema', () => {
    const req = classifyPgAdminIbmiTableQuery(`SELECT rel.oid, rel.relname AS name,
      (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid=rel.oid AND tgisinternal = FALSE) AS triggercount,
      (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid=rel.oid AND tgisinternal = FALSE AND tgenabled = 'O') AS has_enable_triggers,
      false AS is_partitioned,
      (SELECT count(1) FROM pg_catalog.pg_inherits WHERE inhrelid=rel.oid LIMIT 1) AS is_inherits,
      (SELECT count(1) FROM pg_catalog.pg_inherits WHERE inhparent=rel.oid LIMIT 1) AS is_inherited,
      des.description
      FROM pg_catalog.pg_class rel
      LEFT JOIN pg_catalog.pg_description des ON des.objoid=rel.oid
      WHERE rel.relnamespace = ${scid}::oid
        AND rel.relkind IN ('r','s','t','p')
        AND NOT rel.relispartition
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='pg_catalog' AND n.oid=rel.relnamespace)`);
    expect(req).toBeTruthy();
    expect(req?.kind).toBe('nodes');
    expect(req?.schemaOid).toBe(scid);
    expect(req?.schemaName).toBeUndefined();
  });

  it('does not steal pgAdmin schema-browser SQL that references pg_class inside CATALOGS.LIST', () => {
    const sql = `SELECT nsp.oid, nsp.nspname as name,
      pg_catalog.has_schema_privilege(nsp.oid, 'CREATE') as can_create,
      pg_catalog.has_schema_privilege(nsp.oid, 'USAGE') as has_usage, des.description
      FROM pg_catalog.pg_namespace nsp
      LEFT JOIN pg_catalog.pg_description des ON des.objoid=nsp.oid
      WHERE NOT ((nsp.nspname = 'pg_catalog' AND EXISTS
        (SELECT 1 FROM pg_catalog.pg_class WHERE relname = 'pg_class' AND relnamespace = nsp.oid LIMIT 1)));`;
    expect(classifyPgAdminIbmiTableQuery(sql)).toBeUndefined();
  });

});
