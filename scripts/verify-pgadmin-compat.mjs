import assert from 'node:assert/strict';
import { pgAdminCompatibilityQuery, containsUnhandledPostgresSystemSql } from '../dist/src/sql/pgadmin.js';
import { environmentQuery } from '../dist/src/sql/environment.js';
import { translateSql } from '../dist/src/sql/translator.js';

const ctx = {
  database: 'postgres',
  user: 'proxyuser',
  currentSchema: 'MYLIB',
  serverPort: 5432,
  systemIdentifier: '1234567890123456789',
};

function local(sql) {
  return environmentQuery(sql, ctx.database, ctx.currentSchema)
    ?? pgAdminCompatibilityQuery(sql, ctx);
}
function expectFields(sql, expected) {
  const r = local(sql);
  assert.ok(r, `Query was not virtualized: ${sql}`);
  assert.deepEqual(r.fields.map((f) => f.name), expected);
  return r;
}

// pgAdmin 9.17 psycopg3 _initialize() batch elements.
assert.ok(local('SET DateStyle=ISO'));
assert.ok(local('SET client_min_messages=notice'));
expectFields(
  "SELECT set_config('bytea_output','hex',false) FROM pg_show_all_settings() WHERE name = 'bytea_output'",
  ['set_config'],
);
assert.ok(local("SET client_encoding='UTF8'"));
expectFields('SELECT version()', ['version']);
expectFields(`
SELECT db.oid as did, db.datname, db.datallowconn,
       pg_encoding_to_char(db.encoding) AS serverencoding,
       has_database_privilege(db.oid, 'CREATE') as cancreate,
       datistemplate
FROM pg_catalog.pg_database db
WHERE db.datname = current_database()`,
['did','datname','datallowconn','serverencoding','cancreate','datistemplate']);
expectFields(`
SELECT gss_authenticated, encrypted
FROM pg_catalog.pg_stat_gssapi
WHERE pid = pg_backend_pid()`, ['gss_authenticated','encrypted']);
expectFields(`
SELECT roles.oid as id, roles.rolname as name,
       roles.rolsuper as is_superuser,
       CASE WHEN roles.rolsuper THEN true ELSE roles.rolcreaterole END as can_create_role,
       CASE WHEN roles.rolsuper THEN true ELSE roles.rolcreatedb END as can_create_db,
       CASE WHEN 'pg_signal_backend'=ANY(ARRAY(WITH RECURSIVE cte AS (
         SELECT pg_roles.oid,pg_roles.rolname FROM pg_catalog.pg_roles
         WHERE pg_roles.oid = roles.oid
         UNION ALL
         SELECT m.roleid,pgr.rolname FROM cte cte_1
         JOIN pg_catalog.pg_auth_members m ON m.member = cte_1.oid
         JOIN pg_catalog.pg_roles pgr ON pgr.oid = m.roleid)
         SELECT rolname FROM cte)) THEN True ELSE False END as can_signal_backend
FROM pg_catalog.pg_roles as roles
WHERE rolname = current_user`,
['id','name','is_superuser','can_create_role','can_create_db','can_signal_backend']);

// pgAdmin server-node recovery check. Failure here makes pgAdmin mark server disconnected.
expectFields(`
SELECT CASE WHEN usesuper
       THEN pg_catalog.pg_is_in_recovery()
       ELSE FALSE END as inrecovery,
       CASE WHEN usesuper AND pg_catalog.pg_is_in_recovery()
       THEN pg_is_wal_replay_paused()
       ELSE FALSE END as isreplaypaused
FROM pg_catalog.pg_user WHERE usename=current_user`,
['inrecovery','isreplaypaused']);

// pgAdmin calls this immediately after connect and its Python helper does
// res['rows'][0]['type']; this MUST be exactly one row, even when type is NULL.
const replicationType = expectFields(`
SELECT CASE
WHEN (SELECT count(extname) FROM pg_catalog.pg_extension WHERE extname='bdr') > 0
THEN 'pgd'
WHEN (SELECT COUNT(*) FROM pg_catalog.pg_replication_slots) > 0
THEN 'log'
ELSE NULL
END as type`, ['type']);
assert.equal(replicationType.rows.length, 1);
assert.equal(replicationType.rows[0][0], null);

// Generic PostgreSQL-system quarantine must preserve PostgreSQL cardinality
// for aggregate/scalar SELECTs so client code that expects the mandatory
// aggregate row cannot receive a structurally impossible zero-row response.
const aggregateFallback = local(`
SELECT count(*) AS count
FROM pg_catalog.pg_stat_progress_vacuum
`);
assert.ok(aggregateFallback);
assert.deepEqual(aggregateFallback.fields.map((f) => f.name), ['count']);
assert.deepEqual(aggregateFallback.rows, [[0]]);

const scalarSystemFallback = local(`
SELECT pg_catalog.some_future_pgadmin_probe() AS probe
`);
assert.ok(scalarSystemFallback);
assert.deepEqual(scalarSystemFallback.fields.map((f) => f.name), ['probe']);
assert.equal(scalarSystemFallback.rows.length, 1);
assert.equal(scalarSystemFallback.rows[0][0], null);

// Server/database tree query used immediately after a successful connection.
expectFields(`
SELECT db.oid as did, db.datname as name, ta.spcname as spcname, db.datallowconn,
       db.datistemplate AS is_template,
       pg_catalog.has_database_privilege(db.oid, 'CREATE') as cancreate, datdba as owner,
       descr.description
FROM pg_catalog.pg_database db
LEFT OUTER JOIN pg_catalog.pg_tablespace ta ON db.dattablespace = ta.oid
LEFT OUTER JOIN pg_catalog.pg_shdescription descr ON
  (db.oid=descr.objoid AND descr.classoid='pg_database'::regclass)
ORDER BY datname`,
['did','name','spcname','datallowconn','is_template','cancreate','owner','description']);

// PostgreSQL scalar SELECTs must not generate Db2 SQL0104 due to missing FROM.
assert.equal(local('SELECT current_schema()')?.rows[0]?.[0], 'MYLIB');
const scalarDb2 = translateSql('SELECT CURRENT TIMESTAMP AS ts', {
  uppercaseIdentifiers: true,
  informationSchemaRewrite: true,
  pgCatalogCompat: true,
  allowMultiStatement: false,
  maxRows: 0,
}).sql;
assert.match(scalarDb2, /FROM SYSIBM\.SYSDUMMY1/i);

// Unknown PostgreSQL system relations are quarantined locally, not forwarded to IBM i.
const unknown = local('SELECT pid, phase FROM pg_catalog.pg_stat_progress_vacuum');
assert.ok(unknown);
assert.deepEqual(unknown.fields.map((f) => f.name), ['pid','phase']);
assert.equal(unknown.rows.length, 0);

// PostgreSQL catalog OID casts must never be translated into a Db2 SQLUDT.
assert.equal(containsUnhandledPostgresSystemSql(`SELECT c.relname FROM pg_catalog.pg_class c WHERE c.oid=2050000001::OID`), true);

// Defensive server identity probe.
expectFields(`SELECT inet_server_addr() AS server_addr,
                    inet_server_port() AS server_port,
                    pg_is_in_recovery() AS in_recovery,
                    (SELECT system_identifier FROM pg_control_system()) AS system_identifier`,
['server_addr','server_port','in_recovery','system_identifier']);

console.log('pgAdmin 9.17 compatibility contract check OK');
