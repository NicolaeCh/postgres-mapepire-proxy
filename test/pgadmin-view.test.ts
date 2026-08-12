import { describe, expect, it } from 'vitest';
import {
  IBMI_VIEW_CATALOG_SQL,
  classifyPgAdminIbmiViewQuery,
  renderPgAdminIbmiViewQuery,
  viewOid,
} from '../src/sql/pgadmin-ibmi-view.js';
import { classifyPgAdminIbmiTableQuery } from '../src/sql/pgadmin-ibmi-table.js';

const scid = 1812345678;
const views = [
  {
    schema: 'MONAI', name: 'ACTIVE_ORDERS', owner: 'MAPESVC', text: 'Active orders', longComment: null,
    columnCount: 3, definition: 'SELECT ORDERKEY, STATUS, ORDERDATE FROM MONAI.ORDERS WHERE STATUS = \'A\'',
    checkOption: null,
  },
];

describe('pgAdmin IBM i Views contracts', () => {
  it('reads SQL views and definitions from IBM i catalogs', () => {
    expect(IBMI_VIEW_CATALOG_SQL).toContain('QSYS2.SYSTABLES');
    expect(IBMI_VIEW_CATALOG_SQL).toContain("T.TABLE_TYPE = 'V'");
    expect(IBMI_VIEW_CATALOG_SQL).toContain('QSYS2.SYSVIEWS');
    expect(IBMI_VIEW_CATALOG_SQL).toContain('VIEW_DEFINITION');
  });

  it('answers pgAdmin Views has_nodes count', () => {
    const req = classifyPgAdminIbmiViewQuery(`SELECT COUNT(*) FROM pg_catalog.pg_class c
      WHERE c.relkind = 'v' AND c.relnamespace = ${scid}::oid`);
    expect(req).toEqual({ kind: 'count', schemaOid: scid });
    const result = renderPgAdminIbmiViewQuery(req!, views);
    expect(result.fields.map((f) => f.name)).toEqual(['count']);
    expect(result.rows).toEqual([[1]]);
  });

  it('returns pgAdmin view nodes with stable virtual OIDs', () => {
    const req = classifyPgAdminIbmiViewQuery(`SELECT c.oid, c.relname AS name, description AS comment
      FROM pg_catalog.pg_class c LEFT JOIN pg_catalog.pg_description des ON des.objoid=c.oid
      WHERE c.relkind = 'v' AND c.relnamespace = ${scid}::oid ORDER BY c.relname`);
    expect(req?.kind).toBe('nodes');
    const result = renderPgAdminIbmiViewQuery(req!, views);
    expect(result.fields.map((f) => f.name)).toEqual(['oid','name','comment']);
    expect(result.rows).toEqual([[viewOid('MONAI','ACTIVE_ORDERS'), 'ACTIVE_ORDERS', 'Active orders']]);
  });

  it('returns live IBM i view properties including definition', () => {
    const vid = viewOid('MONAI','ACTIVE_ORDERS');
    const req = classifyPgAdminIbmiViewQuery(`SELECT c.oid, c.relkind, description AS comment,
      c.relname AS name, nsp.nspname AS schema, pg_catalog.pg_get_userbyid(c.relowner) AS owner,
      pg_catalog.pg_get_viewdef(c.oid, true) AS definition, c.relispopulated AS ispopulated,
      false AS security_barrier FROM pg_catalog.pg_class c
      LEFT JOIN pg_catalog.pg_namespace nsp ON nsp.oid=c.relnamespace
      WHERE c.relkind = 'v'::char AND c.oid = ${vid}::oid`);
    expect(req?.kind).toBe('properties');
    const result = renderPgAdminIbmiViewQuery(req!, views);
    expect(result.rows).toHaveLength(1);
    const definitionIndex = result.fields.findIndex((f) => f.name === 'definition');
    expect(result.rows[0]?.[definitionIndex]).toContain('SELECT ORDERKEY');
  });

  it('does not classify a Views query as a Tables query', () => {
    const sql = `SELECT c.oid, c.relname AS name, description AS comment FROM pg_catalog.pg_class c
      WHERE c.relkind = 'v' AND c.relnamespace = ${scid}::oid`;
    expect(classifyPgAdminIbmiTableQuery(sql)).toBeUndefined();
    expect(classifyPgAdminIbmiViewQuery(sql)?.kind).toBe('nodes');
  });
});
