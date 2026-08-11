import { OID } from '../postgres/oids.js';
import type { FieldDescription } from '../postgres/wire.js';
import type { SyntheticResult } from './environment.js';

export interface PgAdminCompatContext {
  database: string;
  user: string;
  currentSchema: string;
}

const field = (name: string, typeOid: number, typeSize: number): FieldDescription => ({
  name,
  typeOid,
  typeSize,
});

const text = (name: string) => field(name, OID.text, -1);
const oid = (name: string) => field(name, OID.oid, 4);
const bool = (name: string) => field(name, OID.bool, 1);
const int4 = (name: string) => field(name, OID.int4, 4);

const selectOne = (name: string, value: unknown, typeOid: number = OID.text, typeSize = -1): SyntheticResult => ({
  fields: [field(name, typeOid, typeSize)],
  rows: [[value]],
  tag: 'SELECT 1',
});

/**
 * Synthetic PostgreSQL compatibility queries needed by pgAdmin during startup.
 *
 * These queries must never reach Db2 for i. They reference PostgreSQL-only
 * catalogs/functions and, in several cases, use SELECT expressions without a
 * FROM clause (legal in PostgreSQL, not legal in Db2 for i).
 */
export function pgAdminCompatibilityQuery(
  sql: string,
  context: PgAdminCompatContext,
): SyntheticResult | undefined {
  const s = compactSql(sql);

  // pgAdmin/psycopg uses set_config() to establish an intentionally empty or
  // controlled PostgreSQL search_path. The IBM i schema is managed separately
  // by SET CURRENT SCHEMA, so acknowledge this PostgreSQL-only setting without
  // changing the leased Db2 job.
  const setConfig = s.match(
    /^select\s+(?:pg_catalog\.)?set_config\s*\(\s*'([^']+)'\s*,\s*'((?:''|[^'])*)'\s*,\s*(?:false|true)\s*\)(?:\s+as\s+([a-z_][a-z0-9_$]*))?(?:\s+from\s+(?:pg_catalog\.)?pg_settings\b.*)?$/i,
  );
  if (setConfig) {
    const settingName = setConfig[1]!.toLowerCase();
    const value = setConfig[2]!.replaceAll("''", "'");
    const resultName = setConfig[3] ?? 'set_config';
    if (settingName === 'search_path') return selectOne(resultName, value);
    // pgAdmin can use set_config for harmless per-session UI settings. They
    // have no Db2 equivalent and are deliberately local to the compatibility
    // layer rather than forwarded to IBM i.
    return selectOne(resultName, value);
  }

  // pgAdmin can compare locale settings using UNION. Both are synthetic C
  // locale values in the proxy, so return the deduplicated one-row result
  // with the alias pgAdmin expects.
  if (/current_setting\s*\(\s*'lc_ctype'\s*\).*\bunion\b.*current_setting\s*\(\s*'lc_collate'\s*\)/i.test(s)) {
    return selectOne('cname', 'C');
  }

  if (/^select\s+(?:pg_catalog\.)?current_setting\s*\(/i.test(s)) {
    const m = s.match(/current_setting\s*\(\s*'([^']+)'/i);
    const name = m?.[1]?.toLowerCase() ?? '';
    const value = currentSetting(name, context.currentSchema);
    if (value !== undefined) return selectOne('current_setting', value);
  }

  const recovery = s.match(/^select\s+(?:pg_catalog\.)?pg_is_in_recovery\s*\(\s*\)(?:\s+as\s+([a-z_][a-z0-9_$]*))?$/i);
  if (recovery) {
    return selectOne(recovery[1] ?? 'pg_is_in_recovery', false, OID.bool, 1);
  }
  const replayPaused = s.match(/^select\s+(?:pg_catalog\.)?pg_is_wal_replay_paused\s*\(\s*\)(?:\s+as\s+([a-z_][a-z0-9_$]*))?$/i);
  if (replayPaused) {
    return selectOne(replayPaused[1] ?? 'pg_is_wal_replay_paused', false, OID.bool, 1);
  }
  const backendPid = s.match(/^select\s+(?:pg_catalog\.)?pg_backend_pid\s*\(\s*\)(?:\s+as\s+([a-z_][a-z0-9_$]*))?$/i);
  if (backendPid) {
    return selectOne(backendPid[1] ?? 'pg_backend_pid', process.pid, OID.int4, 4);
  }
  if (/^select\s+(?:current_user|session_user)(?:\s+as\s+([a-z_][a-z0-9_$]*))?$/i.test(s)) {
    const alias = s.match(/\s+as\s+([a-z_][a-z0-9_$]*)$/i)?.[1] ?? 'current_user';
    return selectOne(alias, context.user);
  }

  // pgAdmin asks pg_database both for the current database properties and for
  // the database tree. IBM i has no database object equivalent: one proxy
  // endpoint represents one IBM i Db2 database, so synthesize exactly one
  // PostgreSQL database row for the StartupMessage database name.
  if (/\b(?:pg_catalog\.)?pg_database\b/i.test(s)) {
    return syntheticPgDatabase(s, context.database);
  }

  // Lightweight role probes used by pgAdmin while determining capabilities.
  if (/\b(?:pg_catalog\.)?pg_user\b/i.test(s)) {
    return syntheticPgUser(s, context.user);
  }
  if (/\b(?:pg_catalog\.)?pg_roles\b/i.test(s)) {
    return syntheticPgRoles(s, context.user);
  }

  // pgAdmin may enumerate tablespaces even though the proxy cannot expose
  // PostgreSQL physical tablespaces. A single synthetic pg_default entry keeps
  // metadata discovery stable without inventing IBM i storage semantics.
  if (/\b(?:pg_catalog\.)?pg_tablespace\b/i.test(s) && !/\bpg_database\b/i.test(s)) {
    return syntheticPgTablespace(s);
  }

  // Basic PostgreSQL connection liveness probes such as SELECT 1 are legal
  // without FROM in PostgreSQL but not in Db2 for i. Keep them local.
  const scalar = simpleScalarSelect(s);
  if (scalar) return scalar;

  return undefined;
}

function syntheticPgDatabase(sql: string, database: string): SyntheticResult {
  const db = database || 'ibmi';

  // Database browser tree query. This covers the stable aliases pgAdmin uses
  // across releases: did/name/spcname/datallowconn/is_template/cancreate/owner.
  if (/\bdatname\s+as\s+name\b/i.test(sql)) {
    return {
      fields: [
        oid('did'), text('name'), text('spcname'), bool('datallowconn'),
        bool('is_template'), bool('cancreate'), oid('owner'),
      ],
      rows: [[16384, db, 'pg_default', true, false, true, 10]],
      tag: 'SELECT 1',
    };
  }

  // Current-database detail query used by pgAdmin connections. Older pgAdmin
  // releases also selected datlastsysoid; preserve that column when requested.
  if (/\bserverencoding\b/i.test(sql) || /\bcancreate\b/i.test(sql)) {
    const withLastSysOid = /\bdatlastsysoid\b/i.test(sql);
    const fields = [
      oid('did'), text('datname'), bool('datallowconn'), text('serverencoding'),
      bool('cancreate'),
    ];
    const row: unknown[] = [16384, db, true, 'UTF8', true];
    if (withLastSysOid) {
      fields.push(oid('datlastsysoid'));
      row.push(0);
    }
    fields.push(bool('datistemplate'));
    row.push(false);
    return { fields, rows: [row], tag: 'SELECT 1' };
  }

  if (/\bcount\s*\(\s*\*\s*\)/i.test(sql)) {
    return { fields: [field('count', OID.int8, 8)], rows: [[1]], tag: 'SELECT 1' };
  }

  // Generic pg_database probes (including SELECT datname FROM pg_database).
  if (/^select\s+(?:[a-z_][a-z0-9_$]*\.)?datname\s+from\b/i.test(sql)) {
    return { fields: [text('datname')], rows: [[db]], tag: 'SELECT 1' };
  }

  return {
    fields: [
      oid('oid'), text('datname'), oid('datdba'), int4('encoding'),
      bool('datistemplate'), bool('datallowconn'), oid('dattablespace'),
    ],
    rows: [[16384, db, 10, 6, false, true, 1663]],
    tag: 'SELECT 1',
  };
}

function syntheticPgUser(sql: string, user: string): SyntheticResult {
  // pgAdmin checks recovery/replay state through pg_user immediately after
  // connecting. This is a PostgreSQL HA concept; the proxy represents a
  // single IBM i Db2 endpoint, so expose a stable non-recovery state.
  if (/\binrecovery\b/i.test(sql) || /\bisreplaypaused\b/i.test(sql)) {
    return {
      fields: [bool('inrecovery'), bool('isreplaypaused')],
      rows: [[false, false]],
      tag: 'SELECT 1',
    };
  }
  if (/\busesuper\b/i.test(sql) && !/\busesysid\b/i.test(sql)) {
    return { fields: [bool('usesuper')], rows: [[false]], tag: 'SELECT 1' };
  }
  return {
    fields: [text('usename'), oid('usesysid'), bool('usesuper')],
    rows: [[user, 10, false]],
    tag: 'SELECT 1',
  };
}

function syntheticPgRoles(sql: string, user: string): SyntheticResult {
  // pgAdmin connection capability probe.
  if (/\bis_superuser\b/i.test(sql) || /\bcan_create_role\b/i.test(sql) || /\bcan_create_db\b/i.test(sql)) {
    return {
      fields: [
        oid('id'), text('name'), bool('is_superuser'),
        bool('can_create_role'), bool('can_create_db'),
      ],
      rows: [[10, user, false, false, false]],
      tag: 'SELECT 1',
    };
  }
  if (/\brolcanlogin\b/i.test(sql) || /\brolsuper\b/i.test(sql)) {
    return {
      fields: [oid('oid'), text('rolname'), bool('rolcanlogin'), bool('rolsuper')],
      rows: [[10, user, true, false]],
      tag: 'SELECT 1',
    };
  }
  return {
    fields: [oid('oid'), text('rolname')],
    rows: [[10, user]],
    tag: 'SELECT 1',
  };
}

function syntheticPgTablespace(sql: string): SyntheticResult {
  if (/\bspcname\s+as\s+name\b/i.test(sql)) {
    return {
      fields: [oid('oid'), text('name'), oid('owner')],
      rows: [[1663, 'pg_default', 10]],
      tag: 'SELECT 1',
    };
  }
  return {
    fields: [oid('oid'), text('spcname'), oid('spcowner')],
    rows: [[1663, 'pg_default', 10]],
    tag: 'SELECT 1',
  };
}

function simpleScalarSelect(sql: string): SyntheticResult | undefined {
  let m = sql.match(/^select\s+(-?\d+)(?:\s+as\s+([a-z_][a-z0-9_$]*))?$/i);
  if (m) return selectOne(m[2] ?? '?column?', Number(m[1]), OID.int4, 4);

  m = sql.match(/^select\s+'((?:''|[^'])*)'(?:\s+as\s+([a-z_][a-z0-9_$]*))?$/i);
  if (m) return selectOne(m[2] ?? '?column?', m[1]!.replaceAll("''", "'"));

  m = sql.match(/^select\s+(true|false)(?:\s+as\s+([a-z_][a-z0-9_$]*))?$/i);
  if (m) return selectOne(m[2] ?? '?column?', m[1]!.toLowerCase() === 'true', OID.bool, 1);

  return undefined;
}

function currentSetting(name: string, currentSchema: string): string | undefined {
  const values: Record<string, string> = {
    search_path: currentSchema,
    server_version: '16.4',
    server_version_num: '160004',
    client_encoding: 'UTF8',
    server_encoding: 'UTF8',
    client_min_messages: 'notice',
    bytea_output: 'hex',
    standard_conforming_strings: 'on',
    timezone: 'UTC',
    datestyle: 'ISO, MDY',
    default_transaction_read_only: 'off',
    transaction_isolation: 'read committed',
    max_connections: '100',
    lc_collate: 'C',
    lc_ctype: 'C',
    block_size: '8192',
  };
  return values[name];
}

function compactSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .trim()
    .replace(/;+\s*$/, '')
    .replace(/\s+/g, ' ');
}
