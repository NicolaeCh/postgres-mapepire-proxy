import { describe, expect, it } from 'vitest';
import {
  classifyPgAdminIbmiSchemaQuery,
  planPgCreateSchema,
  renderPgAdminIbmiSchemaQuery,
  schemaOid,
} from '../src/sql/pgadmin-ibmi.js';

const schemas = [
  { name: 'MONAI', owner: 'MAPESVC', text: 'Application schema' },
  { name: 'APP2', owner: 'MAPESVC', text: null },
  { name: 'QSYS2', owner: 'QSYS', text: null },
];
const context = { user: 'nicolae', currentSchema: 'MONAI' };

function run(sql: string) {
  const req = classifyPgAdminIbmiSchemaQuery(sql);
  expect(req).toBeDefined();
  return renderPgAdminIbmiSchemaQuery(req!, schemas, context);
}

describe('pgAdmin IBM i-backed schema browser contract', () => {
  it('returns node rows with exact required keys', () => {
    const r = run(`SELECT nsp.oid, nsp.nspname as name,
      pg_catalog.has_schema_privilege(nsp.oid, 'CREATE') as can_create,
      pg_catalog.has_schema_privilege(nsp.oid, 'USAGE') as has_usage,
      des.description FROM pg_catalog.pg_namespace nsp
      LEFT JOIN pg_catalog.pg_description des ON des.objoid=nsp.oid
      WHERE nspname NOT LIKE E'pg\\_%' ORDER BY nspname`);
    expect(r.fields.map((f) => f.name)).toEqual(['oid','name','can_create','has_usage','description']);
    expect(r.rows.map((row) => row[1])).toEqual(['APP2','MONAI']);
  });

  it('returns all visible schema property rows for SchemaView.list()', () => {
    const r = run(`SELECT CASE WHEN nspname LIKE E'pg\\_%' THEN 0 ELSE 3 END AS nsptyp,
      nsp.nspname AS name, nsp.oid, nsp.nspacl AS acl,
      r.rolname AS namespaceowner, description,
      pg_catalog.has_schema_privilege(nsp.oid,'CREATE') AS can_create,
      NULL AS tblacl, NULL AS seqacl, NULL AS funcacl, NULL AS typeacl, NULL AS seclabels
      FROM pg_catalog.pg_namespace nsp LEFT JOIN pg_catalog.pg_roles r ON true
      WHERE nspname NOT LIKE E'pg\\_%' ORDER BY 1,nspname`);
    expect(r.fields.map((f) => f.name)).toEqual([
      'nsptyp','name','oid','acl','namespaceowner','description','can_create',
      'tblacl','seqacl','funcacl','typeacl','seclabels',
    ]);
    expect(r.rows.map((row) => row[1])).toEqual(['APP2','MONAI']);
  });

  it('returns exact schema ACL and default ACL dictionaries', () => {
    const oid = schemaOid('MONAI');
    const acl = run(`SELECT 'nspacl' AS deftype, COALESCE(gt.rolname,'PUBLIC') AS grantee,
      g.rolname AS grantor, array_agg(privilege_type) AS privileges, array_agg(is_grantable) AS grantable
      FROM pg_catalog.pg_namespace nsp, LATERAL pg_catalog.aclexplode(nsp.nspacl) x
      WHERE nsp.oid=${oid} GROUP BY g.rolname,gt.rolname`);
    expect(acl.fields.map((f) => f.name)).toEqual(['deftype','grantee','grantor','privileges','grantable']);
    expect(acl.rows).toEqual([]);

    const defacl = run(`SELECT CASE (a.deftype) WHEN 'r' THEN 'deftblacl' END AS deftype,
      COALESCE(gt.rolname,'PUBLIC') AS grantee, g.rolname AS grantor,
      array_agg(a.privilege_type) AS privileges, array_agg(a.is_grantable) AS grantable
      FROM pg_catalog.pg_namespace nsp LEFT JOIN pg_catalog.pg_default_acl dacl
      ON dacl.defaclnamespace=nsp.oid WHERE nsp.oid=${oid} GROUP BY g.rolname,gt.rolname,a.deftype`);
    expect(defacl.fields.map((f) => f.name)).toEqual(['deftype','grantee','grantor','privileges','grantable']);
    expect(defacl.rows).toEqual([]);
  });

  it('maps pgAdmin CREATE SCHEMA AUTHORIZATION to service-user Db2 DDL', () => {
    expect(planPgCreateSchema('CREATE SCHEMA "monai2" AUTHORIZATION "nicolae";')).toEqual({
      schemaName: 'monai2',
      db2Sql: 'CREATE SCHEMA "monai2"',
      ifNotExists: false,
      requestedAuthorization: 'nicolae',
    });
    expect(planPgCreateSchema('CREATE SCHEMA IF NOT EXISTS monai2 AUTHORIZATION nicolae')).toEqual({
      schemaName: 'MONAI2',
      db2Sql: 'CREATE SCHEMA "MONAI2"',
      ifNotExists: true,
      requestedAuthorization: 'NICOLAE',
    });
  });
});
