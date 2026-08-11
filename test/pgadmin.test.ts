import { describe, expect, it } from 'vitest';
import { pgAdminCompatibilityQuery } from '../src/sql/pgadmin.js';

const ctx = { database: 'ibmi', user: 'proxyuser', currentSchema: 'MYLIB' };

describe('pgAdmin startup compatibility', () => {
  it('answers current pg_database detail probe synthetically', () => {
    const r = pgAdminCompatibilityQuery(`
      SELECT db.oid as did, db.datname, db.datallowconn,
             pg_catalog.pg_encoding_to_char(db.encoding) AS serverencoding,
             pg_catalog.has_database_privilege(db.oid, 'CREATE') as cancreate,
             datistemplate
      FROM pg_catalog.pg_database db
      WHERE db.datname = current_database()`, ctx)!;
    expect(r.fields.map((f) => f.name)).toEqual([
      'did','datname','datallowconn','serverencoding','cancreate','datistemplate',
    ]);
    expect(r.rows).toEqual([[16384, 'ibmi', true, 'UTF8', true, false]]);
  });

  it('answers pgAdmin database tree probe', () => {
    const r = pgAdminCompatibilityQuery(`
      SELECT db.oid as did, db.datname as name, ta.spcname as spcname,
             db.datallowconn, db.datistemplate AS is_template,
             pg_catalog.has_database_privilege(db.oid, 'CREATE') as cancreate,
             datdba as owner
      FROM pg_catalog.pg_database db
      LEFT OUTER JOIN pg_catalog.pg_tablespace ta ON db.dattablespace = ta.oid
      ORDER BY datname`, ctx)!;
    expect(r.fields.map((f) => f.name)).toEqual([
      'did','name','spcname','datallowconn','is_template','cancreate','owner',
    ]);
    expect(r.rows[0]?.[1]).toBe('ibmi');
  });

  it('handles set_config(search_path) without Db2', () => {
    const r = pgAdminCompatibilityQuery(
      `SELECT pg_catalog.set_config('search_path', '', false)`, ctx,
    )!;
    expect(r.fields[0]?.name).toBe('set_config');
    expect(r.rows).toEqual([['']]);
  });

  it('returns current setting values', () => {
    const r = pgAdminCompatibilityQuery(
      `SELECT pg_catalog.current_setting('server_version_num')`, ctx,
    )!;
    expect(r.rows).toEqual([['160004']]);
  });

  it('returns pgAdmin connection role capabilities', () => {
    const r = pgAdminCompatibilityQuery(`
      SELECT oid as id, rolname as name, rolsuper as is_superuser,
             CASE WHEN rolsuper THEN true ELSE rolcreaterole END as can_create_role,
             CASE WHEN rolsuper THEN true ELSE rolcreatedb END as can_create_db
      FROM pg_catalog.pg_roles WHERE rolname = current_user`, ctx)!;
    expect(r.fields.map((f) => f.name)).toEqual(['id','name','is_superuser','can_create_role','can_create_db']);
    expect(r.rows).toEqual([[10, 'proxyuser', false, false, false]]);
  });

  it('returns one synthetic current role', () => {
    const r = pgAdminCompatibilityQuery(
      `SELECT r.oid, r.rolname, r.rolcanlogin, r.rolsuper FROM pg_catalog.pg_roles r`, ctx,
    )!;
    expect(r.rows).toEqual([[10, 'proxyuser', true, false]]);
  });


  it('answers pgAdmin recovery-status probe through pg_user', () => {
    const r = pgAdminCompatibilityQuery(`
      SELECT CASE WHEN usesuper THEN pg_catalog.pg_is_in_recovery() ELSE FALSE END as inrecovery,
             CASE WHEN usesuper AND pg_catalog.pg_is_in_recovery()
                  THEN pg_catalog.pg_is_wal_replay_paused() ELSE FALSE END as isreplaypaused
      FROM pg_catalog.pg_user WHERE usename = current_user`, ctx)!;
    expect(r.fields.map((f) => f.name)).toEqual(['inrecovery','isreplaypaused']);
    expect(r.rows).toEqual([[false, false]]);
  });

  it('answers pgAdmin locale UNION probe with one synthetic row', () => {
    const r = pgAdminCompatibilityQuery(`
      SELECT pg_catalog.current_setting('lc_ctype') AS cname
      UNION SELECT pg_catalog.current_setting('lc_collate') AS cname`, ctx)!;
    expect(r.fields[0]?.name).toBe('cname');
    expect(r.rows).toEqual([['C']]);
  });

  it('handles SELECT 1 without forwarding it to Db2', () => {
    const r = pgAdminCompatibilityQuery('SELECT 1', ctx)!;
    expect(r.rows).toEqual([[1]]);
  });
});
