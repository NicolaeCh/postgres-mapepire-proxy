import { describe, expect, it } from 'vitest';
import {
  classifyPgAdminTableChildQuery, renderColumnQuery, renderIndexQuery,
  renderEmptyTableChild, IBMI_COLUMN_CATALOG_SQL, IBMI_INDEX_CATALOG_SQL, IBMI_NATIVE_INDEX_CATALOG_SQL,
} from '../src/sql/pgadmin-ibmi-table-child.js';
import { classifyPgAdminIbmiTableQuery, tableOid } from '../src/sql/pgadmin-ibmi-table.js';

const tid = tableOid('MONAI', 'ORDERS');
const columns = [
  { schema:'MONAI', table:'ORDERS', name:'ID', ordinal:1, dataType:'INTEGER', length:4, numericScale:null, numericPrecision:10, nullable:false, longComment:'Identity', text:null, hasDefault:'J', defaultValue:null, charMaxLength:null, datetimePrecision:null, identity:true, identityGeneration:'BY DEFAULT', expression:null },
  { schema:'MONAI', table:'ORDERS', name:'DESCRIPTION', ordinal:2, dataType:'VARCHAR', length:100, numericScale:null, numericPrecision:null, nullable:true, longComment:null, text:'Description', hasDefault:'N', defaultValue:null, charMaxLength:100, datetimePrecision:null, identity:false, identityGeneration:null, expression:null },
];
const indexes = [
  { schema:'MONAI', table:'ORDERS', indexSchema:'MONAI', name:'ORDERS_IX1', owner:'MAPESVC', unique:false, columnCount:1, longComment:null, text:'Order index' },
];

describe('pgAdmin IBM i table-child contracts', () => {
  it('uses IBM i single-table column and index catalogs', () => {
    expect(IBMI_COLUMN_CATALOG_SQL).toContain('QSYS2.SYSCOLUMNS2');
    expect(IBMI_INDEX_CATALOG_SQL).toContain('QSYS2.SYSINDEXES');
    expect(IBMI_NATIVE_INDEX_CATALOG_SQL).toContain('QSYS2.SYSTABLEINDEXSTAT');
    expect(IBMI_NATIVE_INDEX_CATALOG_SQL).toContain("INDEX_TYPE IN ('INDEX', 'LOGICAL')");
  });

  it('recognizes pgAdmin 9.17 Columns nodes and emits required keys', () => {
    const req = classifyPgAdminTableChildQuery(`SELECT DISTINCT att.attname as name, att.attnum as OID,
      pg_catalog.format_type(ty.oid,NULL) AS datatype, pg_catalog.format_type(ty.oid,att.atttypmod) AS displaytypname,
      att.attnotnull as not_null, (SELECT count(*) FROM pg_catalog.pg_attrdef def WHERE def.adrelid=att.attrelid) > 0 as has_default_val,
      des.description, 0::oid as seqtypid FROM pg_catalog.pg_attribute att
      JOIN pg_catalog.pg_type ty ON ty.oid=att.atttypid LEFT JOIN pg_catalog.pg_description des ON true
      WHERE att.attrelid = ${tid}::oid AND att.attnum > 0 AND NOT att.attisdropped ORDER BY att.attnum`);
    expect(req?.kind).toBe('columnNodes');
    const result = renderColumnQuery(req as any, columns);
    expect(result.fields.map((f) => f.name)).toEqual(['name','oid','datatype','displaytypname','not_null','has_default_val','description','seqtypid']);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.[0]).toBe('ID');
  });


  it('recognizes the real pgAdmin 9.16+ Columns nodes shape even though it references attidentity', () => {
    const req = classifyPgAdminTableChildQuery(`SELECT DISTINCT att.attname as name, att.attnum as OID,
      pg_catalog.format_type(ty.oid,NULL) AS datatype,
      pg_catalog.format_type(ty.oid,att.atttypmod) AS displaytypname,
      att.attnotnull as not_null,
      CASE WHEN att.atthasdef OR att.attidentity != '' OR ty.typdefault IS NOT NULL THEN True
           ELSE False END as has_default_val, des.description, seq.seqtypid
      FROM pg_catalog.pg_attribute att
      JOIN pg_catalog.pg_type ty ON ty.oid=atttypid
      LEFT OUTER JOIN pg_catalog.pg_sequence seq ON true
      WHERE att.attrelid = ${tid}::oid AND att.attnum > 0 AND att.attisdropped IS FALSE
      ORDER BY att.attnum`);
    expect(req?.kind).toBe('columnNodes');
    const result = renderColumnQuery(req as any, columns);
    expect(result.fields.map((f) => f.name)).toContain('oid');
    expect(result.rows[0]?.[1]).toBe(1);
  });

  it('still recognizes the pgAdmin Columns properties contract', () => {
    const req = classifyPgAdminTableChildQuery(`SELECT DISTINCT ON (att.attnum)
      att.attname as name, att.atttypid, att.attlen, att.attnum, att.attndims,
      att.atttypmod, att.attnotnull, att.attidentity,
      (CASE WHEN (att.attidentity in ('a','d')) THEN 'i' ELSE 'n' END) AS colconstype,
      (CASE WHEN tab.relkind = 'v' THEN true ELSE false END) AS is_view_only,
      att.attcompression
      FROM pg_catalog.pg_attribute att
      JOIN pg_catalog.pg_type ty ON ty.oid=atttypid
      LEFT JOIN pg_catalog.pg_class tab ON tab.oid=att.attrelid
      WHERE att.attrelid = ${tid}::oid AND att.attnum = 1::int
        AND att.attisdropped IS FALSE ORDER BY att.attnum`);
    expect(req?.kind).toBe('columnProperties');
    expect((req as any).columnNumber).toBe(1);
    const result = renderColumnQuery(req as any, columns);
    expect(result.rows).toHaveLength(1);
    expect(result.fields.map((f) => f.name)).toContain('atttypid');
  });

  it('does not steal a normal Tables nodes query that contains nested pg_trigger counts', () => {
    const req = classifyPgAdminTableChildQuery(`SELECT rel.oid, rel.relname AS name,
      (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid=rel.oid AND tgisinternal = FALSE) AS triggercount,
      (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid=rel.oid AND tgisinternal = FALSE AND tgenabled = 'O') AS has_enable_triggers,
      false AS is_partitioned,
      (SELECT count(1) FROM pg_catalog.pg_inherits WHERE inhrelid=rel.oid LIMIT 1) AS is_inherits,
      (SELECT count(1) FROM pg_catalog.pg_inherits WHERE inhparent=rel.oid LIMIT 1) AS is_inherited,
      des.description
      FROM pg_catalog.pg_class rel
      LEFT JOIN pg_catalog.pg_description des ON des.objoid=rel.oid
      WHERE rel.relkind IN ('r','s','t','p') AND rel.relnamespace = 123456::oid
      AND NOT rel.relispartition ORDER BY rel.relname`);
    expect(req).toBeUndefined();

    const parentReq = classifyPgAdminIbmiTableQuery(`SELECT rel.oid, rel.relname AS name,
      (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid=rel.oid AND tgisinternal = FALSE) AS triggercount,
      (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid=rel.oid AND tgisinternal = FALSE AND tgenabled = 'O') AS has_enable_triggers,
      false AS is_partitioned,
      (SELECT count(1) FROM pg_catalog.pg_inherits WHERE inhrelid=rel.oid LIMIT 1) AS is_inherits,
      (SELECT count(1) FROM pg_catalog.pg_inherits WHERE inhparent=rel.oid LIMIT 1) AS is_inherited,
      des.description
      FROM pg_catalog.pg_class rel
      LEFT JOIN pg_catalog.pg_description des ON des.objoid=rel.oid
      WHERE rel.relkind IN ('r','s','t','p') AND rel.relnamespace = 123456::oid
      AND NOT rel.relispartition ORDER BY rel.relname`);
    expect(parentReq?.kind).toBe('nodes');
  });

  it('recognizes pgAdmin Indexes nodes and returns live SQL indexes', () => {
    const req = classifyPgAdminTableChildQuery(`SELECT DISTINCT ON(cls.relname) cls.oid, cls.relname as name,
      false as is_inherited, des.description FROM pg_catalog.pg_index idx
      JOIN pg_catalog.pg_class cls ON cls.oid=idx.indexrelid LEFT JOIN pg_catalog.pg_description des ON true
      WHERE indrelid = ${tid}::OID ORDER BY cls.relname`);
    expect(req?.kind).toBe('indexNodes');
    const result = renderIndexQuery(req as any, indexes, tid);
    expect(result.fields.map((f) => f.name)).toEqual(['oid','name','is_inherited','description']);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.[1]).toBe('ORDERS_IX1');
  });


  it('answers Columns has_nodes count from live IBM i column rows', () => {
    const req = classifyPgAdminTableChildQuery(`SELECT count(*) FROM pg_catalog.pg_attribute att
      WHERE att.attrelid = ${tid}::oid AND att.attnum > 0 AND NOT att.attisdropped`);
    expect(req?.kind).toBe('columnCount');
    const result = renderColumnQuery(req as any, columns);
    expect(result.fields.map((f) => f.name)).toEqual(['count']);
    expect(result.rows).toEqual([[2]]);
  });

  it('answers Indexes has_nodes count from live IBM i index rows', () => {
    const req = classifyPgAdminTableChildQuery(`SELECT count(*) FROM pg_catalog.pg_index idx
      WHERE idx.indrelid = ${tid}::oid`);
    expect(req?.kind).toBe('indexCount');
    const result = renderIndexQuery(req as any, indexes, tid);
    expect(result.fields.map((f) => f.name)).toEqual(['count']);
    expect(result.rows).toEqual([[1]]);
  });

  it('answers PostgreSQL partition collection locally with zero rows', () => {
    const req = classifyPgAdminTableChildQuery(`SELECT rel.oid, rel.relname AS name, 0 AS triggercount,
      false AS has_enable_triggers, false AS is_partitioned, nsp.oid AS schema_id, nsp.nspname AS schema_name,
      des.description FROM pg_catalog.pg_inherits inh JOIN pg_catalog.pg_class rel ON rel.oid=inh.inhrelid
      JOIN pg_catalog.pg_namespace nsp ON nsp.oid=rel.relnamespace LEFT JOIN pg_catalog.pg_description des ON true
      WHERE inh.inhparent = ${tid}::oid`);
    expect(req?.kind).toBe('partitionNodes');
    const result = renderEmptyTableChild(req as any);
    expect(result.rows).toEqual([]);
    expect(result.fields.map((f) => f.name)).toContain('oid');
  });
});
