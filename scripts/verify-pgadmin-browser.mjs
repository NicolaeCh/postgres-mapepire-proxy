import assert from 'node:assert/strict';
import { pgAdminCompatibilityQuery } from '../dist/src/sql/pgadmin.js';

const ctx = {
  database: 'monai',
  user: 'nicolae',
  currentSchema: 'MONAI',
  serverPort: 5432,
  systemIdentifier: '123456789',
};
const local = (sql) => {
  const r = pgAdminCompatibilityQuery(sql, ctx);
  assert.ok(r, `Expected local pgAdmin result for: ${sql}`);
  return r;
};

// Dashboard contract: pgAdmin dereferences chart_data on every returned row.
const dash = local(`/*pga4dash*/
SELECT 'session_stats' AS chart_name, pg_catalog.row_to_json(t) AS chart_data
FROM (SELECT 0 AS "Total", 0 AS "Active", 0 AS "Idle") t`);
assert.deepEqual(dash.fields.map((f) => f.name), ['chart_name', 'chart_data']);
assert.equal(dash.rows.length, 1);
assert.equal(dash.rows[0][0], 'session_stats');
assert.deepEqual(JSON.parse(dash.rows[0][1]), { Total: 0, Active: 0, Idle: 0 });

// DBMS scheduler feature probe must be a scalar zero, never NULL.
const scheduler = local(`SELECT COUNT(*) FROM pg_catalog.pg_extension
WHERE extname IN ('edb_job_scheduler', 'dbms_scheduler')`);
assert.equal(scheduler.rows.length, 1);
assert.equal(scheduler.rows[0][0], 0);

// pgAdmin database ACL parser requires all five dictionary keys even with 0 rows.
const dbAcl = local(`SELECT 'datacl' AS deftype, COALESCE(gt.rolname, 'PUBLIC') AS grantee,
 g.rolname AS grantor, pg_catalog.array_agg(privilege_type) AS privileges,
 pg_catalog.array_agg(is_grantable) AS grantable
 FROM (SELECT pg_catalog.aclexplode(db.datacl) AS d FROM pg_catalog.pg_database db WHERE db.oid=16384::OID) x
 LEFT JOIN pg_catalog.pg_roles g ON true LEFT JOIN pg_catalog.pg_roles gt ON true GROUP BY g.rolname, gt.rolname`);
assert.deepEqual(dbAcl.fields.map((f) => f.name), ['deftype','grantee','grantor','privileges','grantable']);
assert.equal(dbAcl.rows.length, 0);

// Database Properties/SQL tab exact structural contract.
const dbProps = local(`SELECT db.oid AS did, db.oid, db.datname AS name,
 ta.oid AS spcoid, ta.spcname, db.datallowconn,
 pg_catalog.pg_encoding_to_char(db.encoding) AS encoding,
 pg_catalog.pg_get_userbyid(db.datdba) AS datowner,
 db.datcollate, db.datctype, db.datconnlimit,
 pg_catalog.has_database_privilege(db.oid, 'CREATE') AS cancreate,
 'pg_default' AS default_tablespace, descr.description AS comments,
 db.datistemplate AS is_template, NULL AS tblacl, NULL AS seqacl, NULL AS funcacl, NULL AS acl
 FROM pg_catalog.pg_database db
 LEFT JOIN pg_catalog.pg_tablespace ta ON db.dattablespace=ta.oid
 LEFT JOIN pg_catalog.pg_shdescription descr ON db.oid=descr.objoid WHERE db.oid=16384`);
assert.deepEqual(dbProps.fields.map((f) => f.name), [
  'did','oid','name','spcoid','spcname','datallowconn','encoding','datowner','datcollate','datctype',
  'datconnlimit','cancreate','default_tablespace','comments','is_template','tblacl','seqacl','funcacl','acl',
]);
assert.equal(dbProps.rows[0][7], 'nicolae');

const roles = local(`SELECT r.oid, r.rolname, r.rolcanlogin, r.rolsuper, d.description
FROM pg_catalog.pg_roles r LEFT JOIN pg_catalog.pg_shdescription d ON d.objoid=r.oid`);
assert.deepEqual(roles.fields.map((f) => f.name), ['oid','rolname','rolcanlogin','rolsuper','description']);

const tablespaces = local(`SELECT spc.oid, spc.spcname AS name,
 pg_catalog.pg_get_userbyid(spc.spcowner) AS owner, des.description
 FROM pg_catalog.pg_tablespace spc LEFT JOIN pg_catalog.pg_shdescription des ON des.objoid=spc.oid`);
assert.deepEqual(tablespaces.fields.map((f) => f.name), ['oid','name','owner','description']);
assert.equal(tablespaces.rows[0][2], 'nicolae');

console.log('pgAdmin browser contract check OK');
