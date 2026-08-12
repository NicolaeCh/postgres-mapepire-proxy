import { describe, expect, it } from 'vitest';
import { containsUnhandledPostgresSystemSql, pgAdminCompatibilityQuery } from '../src/sql/pgadmin.js';

const ctx = { database: 'postgres', user: 'proxyuser', currentSchema: 'MYLIB', serverPort: 5432, systemIdentifier: '123456789' };

describe('pgAdmin 9.17 compatibility contract', () => {
  it('handles pg_show_all_settings set_config', () => {
    const r = pgAdminCompatibilityQuery(
      `SELECT set_config('bytea_output','hex',false) FROM pg_show_all_settings() WHERE name = 'bytea_output'`, ctx,
    )!;
    expect(r.fields.map((f) => f.name)).toEqual(['set_config']);
    expect(r.rows).toEqual([['hex']]);
  });

  it('answers current database initialization probe', () => {
    const r = pgAdminCompatibilityQuery(`
      SELECT db.oid as did, db.datname, db.datallowconn,
             pg_encoding_to_char(db.encoding) AS serverencoding,
             has_database_privilege(db.oid, 'CREATE') as cancreate,
             datistemplate
      FROM pg_catalog.pg_database db
      WHERE db.datname = current_database()`, ctx)!;
    expect(r.fields.map((f) => f.name)).toEqual([
      'did','datname','datallowconn','serverencoding','cancreate','datistemplate',
    ]);
    expect(r.rows).toEqual([[16384, 'postgres', true, 'UTF8', true, false]]);
  });

  it('answers pgAgent capability probe locally as false', () => {
    const r = pgAdminCompatibilityQuery(`SELECT
      has_table_privilege('pgagent.pga_job', 'INSERT, SELECT, UPDATE') has_priviledge
      WHERE EXISTS(SELECT has_schema_privilege('pgagent', 'USAGE')
        WHERE EXISTS(SELECT cl.oid FROM pg_catalog.pg_class cl
          LEFT JOIN pg_catalog.pg_namespace ns ON ns.oid=relnamespace
          WHERE relname='pga_job' AND nspname='pgagent'))`, ctx)!;
    expect(r.fields.map((f) => f.name)).toEqual(['has_priviledge']);
    expect(r.rows).toEqual([[false]]);
  });

  it('answers pg_stat_gssapi initialization probe', () => {
    const r = pgAdminCompatibilityQuery(`
      SELECT gss_authenticated, encrypted
      FROM pg_catalog.pg_stat_gssapi WHERE pid = pg_backend_pid()`, ctx)!;
    expect(r.fields.map((f) => f.name)).toEqual(['gss_authenticated','encrypted']);
    expect(r.rows).toEqual([[false, false]]);
  });

  it('returns all pgAdmin role capability columns including can_signal_backend', () => {
    const r = pgAdminCompatibilityQuery(`
      SELECT roles.oid as id, roles.rolname as name, roles.rolsuper as is_superuser,
             CASE WHEN roles.rolsuper THEN true ELSE roles.rolcreaterole END as can_create_role,
             CASE WHEN roles.rolsuper THEN true ELSE roles.rolcreatedb END as can_create_db,
             CASE WHEN 'pg_signal_backend'=ANY(ARRAY(WITH RECURSIVE cte AS (
               SELECT pg_roles.oid,pg_roles.rolname FROM pg_catalog.pg_roles
               WHERE pg_roles.oid = roles.oid) SELECT rolname FROM cte))
               THEN True ELSE False END as can_signal_backend
      FROM pg_catalog.pg_roles as roles WHERE rolname = current_user`, ctx)!;
    expect(r.fields.map((f) => f.name)).toEqual([
      'id','name','is_superuser','can_create_role','can_create_db','can_signal_backend',
    ]);
    expect(r.rows).toEqual([[10, 'proxyuser', false, false, false, false]]);
  });

  it('answers recovery check that pgAdmin uses to keep server connected', () => {
    const r = pgAdminCompatibilityQuery(`
      SELECT CASE WHEN usesuper THEN pg_catalog.pg_is_in_recovery() ELSE FALSE END as inrecovery,
             CASE WHEN usesuper AND pg_catalog.pg_is_in_recovery()
                  THEN pg_is_wal_replay_paused() ELSE FALSE END as isreplaypaused
      FROM pg_catalog.pg_user WHERE usename=current_user`, ctx)!;
    expect(r.fields.map((f) => f.name)).toEqual(['inrecovery','isreplaypaused']);
    expect(r.rows).toEqual([[false, false]]);
  });

  it('answers database tree shape including description', () => {
    const r = pgAdminCompatibilityQuery(`
      SELECT db.oid as did, db.datname as name, ta.spcname as spcname, db.datallowconn,
             db.datistemplate AS is_template,
             has_database_privilege(db.oid, 'CREATE') as cancreate, datdba as owner,
             descr.description
      FROM pg_catalog.pg_database db
      LEFT JOIN pg_catalog.pg_tablespace ta ON db.dattablespace=ta.oid
      LEFT JOIN pg_catalog.pg_shdescription descr ON db.oid=descr.objoid`, ctx)!;
    expect(r.fields.map((f) => f.name)).toEqual([
      'did','name','spcname','datallowconn','is_template','cancreate','owner','description',
    ]);
  });

  it('virtualizes current_schema and combined server identity probes', () => {
    expect(pgAdminCompatibilityQuery('SELECT current_schema()', ctx)?.rows).toEqual([['MYLIB']]);
    const r = pgAdminCompatibilityQuery(`SELECT inet_server_addr() AS server_addr,
      inet_server_port() AS server_port, pg_is_in_recovery() AS in_recovery,
      (SELECT system_identifier FROM pg_control_system()) AS system_identifier`, ctx)!;
    expect(r.fields.map((f) => f.name)).toEqual(['server_addr','server_port','in_recovery','system_identifier']);
  });

  it('quarantines unknown PostgreSQL system views', () => {
    const sql = 'SELECT pid, phase FROM pg_catalog.pg_stat_progress_vacuum';
    const r = pgAdminCompatibilityQuery(sql, ctx)!;
    expect(r.fields.map((f) => f.name)).toEqual(['pid','phase']);
    expect(r.rows).toEqual([]);
    expect(containsUnhandledPostgresSystemSql(sql)).toBe(true);
  });
  it('quarantines PostgreSQL OID casts on mapped catalog relations', () => {
    expect(containsUnhandledPostgresSystemSql(
      'SELECT c.relname FROM pg_catalog.pg_class c WHERE c.oid=2050000001::OID',
    )).toBe(true);
  });

  it('returns exact dashboard chart_data shape and scheduler scalar', () => {
    const dash = pgAdminCompatibilityQuery(`/*pga4dash*/ SELECT 'session_stats' AS chart_name, pg_catalog.row_to_json(t) AS chart_data FROM (SELECT 0) t`, ctx)!;
    expect(dash.fields.map((f) => f.name)).toEqual(['chart_name','chart_data']);
    expect(dash.rows).toHaveLength(1);
    expect(JSON.parse(String(dash.rows[0]![1]))).toEqual({ Total: 0, Active: 0, Idle: 0 });

    const scheduler = pgAdminCompatibilityQuery(`SELECT COUNT(*) FROM pg_catalog.pg_extension WHERE extname IN ('edb_job_scheduler','dbms_scheduler')`, ctx)!;
    expect(scheduler.rows).toEqual([[0]]);
  });

  it('returns exact browser ACL/description keys', () => {
    const acl = pgAdminCompatibilityQuery(`SELECT 'datacl' AS deftype, COALESCE(gt.rolname,'PUBLIC') AS grantee, g.rolname AS grantor, array_agg(x) AS privileges, array_agg(y) AS grantable FROM pg_catalog.pg_database db, LATERAL pg_catalog.aclexplode(db.datacl) d GROUP BY gt.rolname,g.rolname`, ctx)!;
    expect(acl.fields.map((f) => f.name)).toEqual(['deftype','grantee','grantor','privileges','grantable']);

    const roles = pgAdminCompatibilityQuery(`SELECT r.oid, r.rolname, r.rolcanlogin, r.rolsuper, d.description FROM pg_catalog.pg_roles r LEFT JOIN pg_catalog.pg_shdescription d ON true`, ctx)!;
    expect(roles.fields.map((f) => f.name)).toContain('description');

    const tsp = pgAdminCompatibilityQuery(`SELECT spc.oid, spc.spcname AS name, pg_get_userbyid(spc.spcowner) AS owner, des.description FROM pg_catalog.pg_tablespace spc LEFT JOIN pg_catalog.pg_shdescription des ON true`, ctx)!;
    expect(tsp.fields.map((f) => f.name)).toContain('description');
  });

});
