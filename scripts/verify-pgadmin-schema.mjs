import assert from 'node:assert/strict';
import {
  classifyPgAdminIbmiSchemaQuery,
  planPgCreateSchema,
  renderPgAdminIbmiSchemaQuery,
  schemaOid,
} from '../dist/src/sql/pgadmin-ibmi.js';

const schemas = [
  { name: 'MONAI', owner: 'MAPESVC', text: 'Application schema' },
  { name: 'APP2', owner: 'MAPESVC', text: null },
  { name: 'QSYS2', owner: 'QSYS', text: null },
];
const ctx = { user: 'nicolae', currentSchema: 'MONAI' };
const run = (sql) => {
  const req = classifyPgAdminIbmiSchemaQuery(sql);
  assert.ok(req, `Expected IBM i-backed schema contract for: ${sql}`);
  return renderPgAdminIbmiSchemaQuery(req, schemas, ctx);
};

const nodes = run(`SELECT nsp.oid, nsp.nspname as name,
 pg_catalog.has_schema_privilege(nsp.oid, 'CREATE') as can_create,
 pg_catalog.has_schema_privilege(nsp.oid, 'USAGE') as has_usage,
 descr.description
 FROM pg_catalog.pg_namespace nsp
 LEFT JOIN pg_catalog.pg_description descr ON descr.objoid=nsp.oid
 WHERE nspname NOT LIKE E'pg\\_%' ORDER BY nspname`);
assert.deepEqual(nodes.fields.map((f) => f.name), ['oid','name','can_create','has_usage','description']);
assert.ok(nodes.rows.some((row) => row[1] === 'MONAI'));
assert.ok(!nodes.rows.some((row) => row[1] === 'QSYS2'));

const monaiOid = schemaOid('MONAI');
const props = run(`SELECT CASE WHEN (nspname LIKE E'pg\\_temp\\_%') THEN 1 ELSE 3 END AS nsptyp,
 nspname AS name, nsp.oid, nspacl AS acl,
 pg_catalog.pg_get_userbyid(nspowner) AS namespaceowner,
 description, pg_catalog.has_schema_privilege(nsp.oid, 'CREATE') AS can_create,
 (SELECT array_to_string(defaclacl, ',') FROM pg_catalog.pg_default_acl WHERE defaclnamespace=nsp.oid) AS tblacl,
 NULL AS seqacl, NULL AS funcacl, NULL AS typeacl, NULL AS seclabels
 FROM pg_catalog.pg_namespace nsp
 LEFT JOIN pg_catalog.pg_roles r ON r.oid=nsp.nspowner
 WHERE nsp.oid = ${monaiOid}::OID`);
assert.deepEqual(props.fields.map((f) => f.name), [
  'nsptyp','name','oid','acl','namespaceowner','description','can_create','tblacl','seqacl','funcacl','typeacl','seclabels',
]);
assert.equal(props.rows.length, 1);
assert.equal(props.rows[0][1], 'MONAI');
assert.equal(props.rows[0][4], 'nicolae');
assert.equal(props.rows[0][5], 'Application schema');

// pgAdmin SchemaView.list() renders the same properties.sql without scid and
// expects one full property row per visible schema.
const listed = run(`SELECT CASE WHEN (nspname LIKE E'pg\\_temp\\_%') THEN 1 ELSE 3 END AS nsptyp,
 nsp.nspname AS name, nsp.oid, pg_catalog.array_to_string(nsp.nspacl::text[], ', ') AS acl,
 r.rolname AS namespaceowner, description,
 pg_catalog.has_schema_privilege(nsp.oid, 'CREATE') AS can_create,
 NULL AS tblacl, NULL AS seqacl, NULL AS funcacl, NULL AS typeacl, NULL AS seclabels
 FROM pg_catalog.pg_namespace nsp LEFT JOIN pg_catalog.pg_roles r ON r.oid=nsp.nspowner
 WHERE nspname NOT LIKE E'pg\\_%' ORDER BY 1,nspname`);
assert.deepEqual(listed.fields.map((f) => f.name), [
  'nsptyp','name','oid','acl','namespaceowner','description','can_create','tblacl','seqacl','funcacl','typeacl','seclabels',
]);
assert.deepEqual(listed.rows.map((row) => row[1]).sort(), ['APP2','MONAI']);

const oidResult = run(`SELECT nsp.oid FROM pg_catalog.pg_namespace nsp WHERE nsp.nspname = 'MONAI'`);
assert.equal(oidResult.rows[0][0], monaiOid);
const nameResult = run(`SELECT nsp.nspname FROM pg_catalog.pg_namespace nsp WHERE nsp.oid = ${monaiOid}`);
assert.equal(nameResult.rows[0][0], 'MONAI');
const catalog = run(`SELECT nsp.nspname AS schema_name, FALSE AS is_catalog, TRUE AS db_support
FROM pg_catalog.pg_namespace nsp WHERE nsp.oid = ${monaiOid}`);
assert.deepEqual(catalog.rows[0], ['MONAI', false, true]);

const acl = run(`SELECT 'nspacl' AS deftype, COALESCE(gt.rolname,'PUBLIC') AS grantee,
 g.rolname AS grantor, array_agg(privilege_type) AS privileges, array_agg(is_grantable) AS grantable
 FROM pg_catalog.pg_namespace nsp, LATERAL pg_catalog.aclexplode(nsp.nspacl) x
 LEFT JOIN pg_catalog.pg_roles g ON true LEFT JOIN pg_catalog.pg_roles gt ON true
 WHERE nsp.oid=${monaiOid} GROUP BY g.rolname, gt.rolname`);
assert.deepEqual(acl.fields.map((f) => f.name), ['deftype','grantee','grantor','privileges','grantable']);
assert.equal(acl.rows.length, 0);

const defAcl = run(`SELECT CASE (a.deftype) WHEN 'r' THEN 'deftblacl' ELSE 'UNKNOWN' END AS deftype,
 COALESCE(gt.rolname, 'PUBLIC') grantee, g.rolname grantor,
 pg_catalog.array_agg(a.privilege_type) AS privileges, pg_catalog.array_agg(a.is_grantable) AS grantable
 FROM pg_catalog.pg_namespace nsp LEFT JOIN pg_catalog.pg_default_acl dacl ON dacl.defaclnamespace=nsp.oid
 LEFT JOIN pg_catalog.pg_roles g ON true LEFT JOIN pg_catalog.pg_roles gt ON true
 WHERE nsp.oid=${monaiOid}::oid GROUP BY g.rolname,gt.rolname,a.deftype`);
assert.deepEqual(defAcl.fields.map((f) => f.name), ['deftype','grantee','grantor','privileges','grantable']);
assert.equal(defAcl.rows.length, 0);

const create = planPgCreateSchema('CREATE SCHEMA "monai2" AUTHORIZATION "nicolae";');
assert.ok(create);
assert.equal(create.schemaName, 'monai2');
assert.equal(create.db2Sql, 'CREATE SCHEMA "monai2"');
assert.equal(create.requestedAuthorization, 'nicolae');

const createIf = planPgCreateSchema('CREATE SCHEMA IF NOT EXISTS monai2 AUTHORIZATION nicolae');
assert.ok(createIf);
assert.equal(createIf.ifNotExists, true);
assert.equal(createIf.schemaName, 'MONAI2');
assert.equal(createIf.db2Sql, 'CREATE SCHEMA "MONAI2"');

console.log('pgAdmin IBM i schema contract check OK');
