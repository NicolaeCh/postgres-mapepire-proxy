import { OID } from '../postgres/oids.js';
import type { FieldDescription } from '../postgres/wire.js';
import type { SyntheticResult } from './environment.js';

export interface PgAdminCompatContext {
  database: string;
  user: string;
  currentSchema: string;
  serverPort?: number;
  systemIdentifier?: string;
  backendPid?: number;
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
const int8 = (name: string) => field(name, OID.int8, 8);
const json = (name: string) => field(name, OID.json, -1);

const selectOne = (name: string, value: unknown, typeOid: number = OID.text, typeSize = -1): SyntheticResult => ({
  fields: [field(name, typeOid, typeSize)],
  rows: [[value]],
  tag: 'SELECT 1',
});

/**
 * Virtual PostgreSQL system layer used by pgAdmin and PostgreSQL-aware clients.
 *
 * Design invariant: PostgreSQL-only catalogs/functions handled in this module
 * MUST NOT be forwarded to Db2 for i. Where IBM i has no equivalent semantic
 * (GSS, WAL recovery, PostgreSQL locks, replication slots, dashboard activity),
 * return a conservative synthetic value or an empty result set with the
 * projected PostgreSQL column names.
 */
export function pgAdminCompatibilityQuery(
  sql: string,
  context: PgAdminCompatContext,
): SyntheticResult | undefined {
  const s = compactSql(sql);
  if (!s) return undefined;

  // pgAdmin 9.17 connection initialization sends this exact set_config form
  // against pg_show_all_settings(). Accept both that function and pg_settings.
  const setConfig = s.match(
    /^select\s+(?:pg_catalog\.)?set_config\s*\(\s*'([^']+)'\s*,\s*'((?:''|[^'])*)'\s*,\s*(?:false|true)\s*\)(?:\s+as\s+([a-z_][a-z0-9_$]*))?(?:\s+from\s+(?:(?:pg_catalog\.)?pg_settings\b|(?:pg_catalog\.)?pg_show_all_settings\s*\(\s*\)).*)?$/i,
  );
  if (setConfig) {
    // search_path is stateful and must update Db2 CURRENT SCHEMA. Leave it to
    // ProxySession's schema-routing path instead of synthetically echoing the
    // requested value while keeping the backend in the previous schema.
    if (setConfig[1]!.toLowerCase() === 'search_path') return undefined;
    const value = setConfig[2]!.replaceAll("''", "'");
    return selectOne(setConfig[3] ?? 'set_config', value);
  }

  // SET ROLE is a PostgreSQL client-session concept. The IBM i backend always
  // uses the service profile and this no-op must never alter backend authority.
  if (/^(?:set\s+role(?:\s+to)?|reset\s+role)\b/i.test(s)) {
    return { fields: [], rows: [], tag: 'SET' };
  }

  // Optional role validation performed by pgAdmin before SET ROLE.
  const requestedRole = s.match(
    /^select\s+(?:[a-z_][a-z0-9_$]*\.)?rolname\s+from\s+(?:pg_catalog\.)?pg_roles(?:\s+[a-z_][a-z0-9_$]*)?\s+where\s+(?:[a-z_][a-z0-9_$]*\.)?rolname\s*=\s*'((?:''|[^'])*)'$/i,
  );
  if (requestedRole) {
    return { fields: [text('rolname')], rows: [[requestedRole[1]!.replaceAll("''", "'")]], tag: 'SELECT 1' };
  }

  // Locale comparison used by pgAdmin metadata code.
  if (/current_setting\s*\(\s*'lc_ctype'\s*\).*\bunion\b.*current_setting\s*\(\s*'lc_collate'\s*\)/i.test(s)) {
    return selectOne('cname', 'C');
  }

  if (/^select\s+(?:pg_catalog\.)?current_setting\s*\(/i.test(s)) {
    const m = s.match(/current_setting\s*\(\s*'([^']+)'/i);
    const name = m?.[1]?.toLowerCase() ?? '';
    const value = currentSetting(name, context.currentSchema);
    if (value !== undefined) {
      const alias = projectedAlias(s) ?? 'current_setting';
      return selectOne(alias, value);
    }
  }

  if (/^select\s+(?:pg_catalog\.)?current_schema\s*\(\s*\)(?:\s+as\s+[a-z_][a-z0-9_$]*)?$/i.test(s)
      || /^select\s+(?:pg_catalog\.)?current_schema\s*\(\s*\)\s*$/i.test(s)) {
    return selectOne(projectedAlias(s) ?? 'current_schema', context.currentSchema);
  }

  const recovery = s.match(/^select\s+(?:pg_catalog\.)?pg_is_in_recovery\s*\(\s*\)(?:\s+as\s+([a-z_][a-z0-9_$]*))?$/i);
  if (recovery) return selectOne(recovery[1] ?? 'pg_is_in_recovery', false, OID.bool, 1);

  const replayPaused = s.match(/^select\s+(?:pg_catalog\.)?pg_is_wal_replay_paused\s*\(\s*\)(?:\s+as\s+([a-z_][a-z0-9_$]*))?$/i);
  if (replayPaused) return selectOne(replayPaused[1] ?? 'pg_is_wal_replay_paused', false, OID.bool, 1);

  const backendPid = s.match(/^select\s+(?:pg_catalog\.)?pg_backend_pid\s*\(\s*\)(?:\s+as\s+([a-z_][a-z0-9_$]*))?$/i);
  if (backendPid) return selectOne(backendPid[1] ?? 'pg_backend_pid', context.backendPid ?? process.pid, OID.int4, 4);

  if (/^select\s+(?:current_user|session_user)(?:\s+as\s+([a-z_][a-z0-9_$]*))?$/i.test(s)) {
    const alias = projectedAlias(s) ?? (s.toLowerCase().includes('session_user') ? 'session_user' : 'current_user');
    return selectOne(alias, context.user);
  }

  // Defensive support for server-identity probes used by PostgreSQL tooling.
  // PostgreSQL's cluster identifier has no IBM i analogue, so expose a stable
  // proxy-generated identifier supplied by the session context.
  if (/\binet_server_addr\s*\(|\binet_server_port\s*\(|\bpg_control_system\s*\(/i.test(s)) {
    return syntheticServerIdentity(s, context);
  }

  // pgAdmin server connection completion calls its replication_type.sql
  // template and then unconditionally indexes rows[0]['type']. Returning an
  // empty virtual result therefore causes pgAdmin itself to raise Python
  // IndexError ("list index out of range"). The PostgreSQL template returns
  // 'pgd' when BDR is installed, 'log' when logical replication slots exist,
  // otherwise NULL. Neither PostgreSQL extension has an IBM i analogue, so the
  // faithful proxy result is one row with a NULL type.
  if (/\b(?:pg_catalog\.)?pg_extension\b/i.test(s)
      && /\b(?:pg_catalog\.)?pg_replication_slots\b/i.test(s)
      && /\bend\s+as\s+type\b/i.test(s)) {
    return {
      fields: [text('type')],
      rows: [[null]],
      tag: 'SELECT 1',
    };
  }

  // pgAdmin dashboard queries are marked with /*pga4dash*/ and expect an
  // exact two-column contract: chart_name + chart_data(JSON). Returning a
  // generic projected/empty result causes pgAdmin itself to raise KeyError.
  if (/\/\*\s*pga4dash\s*\*\//i.test(sql) && /\bchart_data\b/i.test(s)) {
    return syntheticDashboardStats(s);
  }

  // pgAdmin's pgAgent module performs this scalar capability probe while
  // initializing a database connection.  pgAgent is a PostgreSQL extension and
  // has no IBM i analogue; the correct virtual answer is one boolean FALSE row.
  // This MUST be handled before generic pg_class/pg_namespace compatibility,
  // otherwise the nested PostgreSQL SELECT ... WHERE EXISTS forms can leak to
  // Db2 for i and fail with SQL0199.
  if (/\bhas_table_privilege\s*\(\s*'pgagent\.pga_job'/i.test(s)
      && /\bhas_schema_privilege\s*\(\s*'pgagent'/i.test(s)
      && /\bnspname\s*=\s*'pgagent'/i.test(s)) {
    const alias = s.match(/\)\s+(?:as\s+)?(has_priviledge|has_privilege)\s+where\s+exists/i)?.[1]
      ?? projectedAlias(s) ?? 'has_priviledge';
    return {
      fields: [bool(alias)],
      rows: [[false]],
      tag: 'SELECT 1',
    };
  }

  // pgAdmin probes whether the EDB DBMS Job Scheduler extensions are present.
  // execute_scalar() requires a numeric first row; NULL/zero-row is not safe.
  if (/\b(?:pg_catalog\.)?pg_extension\b/i.test(s)
      && /\bcount\s*\(/i.test(s)
      && /(?:edb_job_scheduler|dbms_scheduler)/i.test(s)) {
    return { fields: [int8(projectedAlias(s) ?? 'count')], rows: [[0]], tag: 'SELECT 1' };
  }

  // Database ACL/default-ACL queries must be recognized before the generic
  // pg_database handler. pgAdmin's Python formatter expects grantor/grantee
  // dictionary keys even when there are no PostgreSQL ACLs to represent.
  if (/\b(?:pg_catalog\.)?pg_database\b/i.test(s)
      && /\b(?:aclexplode|datacl)\b/i.test(s)
      && /\bgrantor\b/i.test(s) && /\bgrantee\b/i.test(s)) {
    return {
      fields: [text('deftype'), text('grantee'), text('grantor'), text('privileges'), text('grantable')],
      rows: [], tag: 'SELECT 0',
    };
  }
  if (/\bpg_default_acl\b/i.test(s)
      && /\bgrantor\b/i.test(s) && /\bgrantee\b/i.test(s)
      && /\b(?:pg_database|datname|defacl)\b/i.test(s)) {
    return {
      fields: [text('deftype'), text('acltype'), text('grantee'), text('grantor'), text('privileges'), text('grantable')],
      rows: [], tag: 'SELECT 0',
    };
  }

  // pgAdmin's >= PostgreSQL 12 initialization query. It only needs to know
  // whether this connection is GSS-authenticated/encrypted.
  if (/\b(?:pg_catalog\.)?pg_stat_gssapi\b/i.test(s)) {
    return {
      fields: [bool('gss_authenticated'), bool('encrypted')],
      rows: [[false, false]],
      tag: 'SELECT 1',
    };
  }

  // Similar PostgreSQL SSL introspection. TLS may exist between client/proxy,
  // but there is no PostgreSQL backend SSL session, so expose a conservative
  // local view rather than a fabricated Db2 relation.
  if (/\b(?:pg_catalog\.)?pg_stat_ssl\b/i.test(s)) {
    return emptyProjectedResult(s, [int4('pid'), bool('ssl'), text('version'), text('cipher'), int4('bits'), text('client_dn')]);
  }

  // pgAdmin asks pg_database both during _initialize() and for its database
  // browser tree. One proxy listener represents one IBM i database endpoint.
  if (/\b(?:pg_catalog\.)?pg_database\b/i.test(s)) return syntheticPgDatabase(s, context.database, context.user);

  // Recovery check and role/capability setup.
  if (/\b(?:pg_catalog\.)?pg_user\b/i.test(s)) return syntheticPgUser(s, context.user);
  if (/\b(?:pg_catalog\.)?pg_roles\b/i.test(s)) return syntheticPgRoles(s, context.user);

  if (/\b(?:pg_catalog\.)?pg_tablespace\b/i.test(s) && !/\bpg_database\b/i.test(s)) {
    return syntheticPgTablespace(s, context.user);
  }

  // pgAdmin dashboard settings pane. Return a small truthful virtual settings
  // set instead of exposing PostgreSQL-only pg_settings/pg_show_all_settings.
  if (/\b(?:pg_catalog\.)?(?:pg_show_all_settings\s*\(\s*\)|pg_settings)\b/i.test(s)) {
    return syntheticPgSettings(s, context.currentSchema);
  }

  // More general PostgreSQL privilege probes are backend metadata operations.
  // All exact database/schema/table contracts have already had a chance to
  // answer above. Any remaining privilege probe is conservatively FALSE and
  // never sent to the IBM i service profile.
  if (/\bhas_(?:table|schema|database|sequence|function|column|any_column)_privilege\s*\(/i.test(s)) {
    return {
      fields: [bool(projectedAlias(s) ?? 'has_privilege')],
      rows: [[false]],
      tag: 'SELECT 1',
    };
  }

  // Dashboard and PostgreSQL monitoring relations do not have equivalent
  // semantics on IBM i. Empty result sets are preferable to invented metrics,
  // and crucially prevent these objects from leaking into Db2 SQL.
  if (isVirtualMonitoringSql(s)) return emptyProjectedResult(s);

  const builtins = syntheticBuiltinSelect(s, context);
  if (builtins) return builtins;

  const scalar = simpleScalarSelect(s);
  if (scalar) return scalar;

  // Final safety net for PostgreSQL-only system SQL. Returning an empty result
  // with the projected columns is intentionally preferable to forwarding a
  // non-existent PostgreSQL catalog object to Db2 for i.
  if (containsUnhandledPostgresSystemSql(s)) return emptyProjectedResult(s);

  return undefined;
}

/**
 * True when SQL still contains PostgreSQL-only system constructs that must not
 * reach Mapepire. Call this after exact/synthetic compatibility handlers and
 * before dialect translation/execution.
 */
export function containsUnhandledPostgresSystemSql(sql: string): boolean {
  const s = compactSql(sql);

  // Allow the small set that the Db2 catalog translator intentionally maps.
  const withoutMappedRelations = s
    .replace(/\b(?:pg_catalog\.)?pg_namespace\b/gi, '')
    .replace(/\b(?:pg_catalog\.)?pg_class\b/gi, '')
    .replace(/\b(?:pg_catalog\.)?pg_type\b/gi, '');

  // PostgreSQL OID is a catalog identifier type, not a Db2 for i SQL type.
  // Exact schema/table/child adapters run before this firewall; any remaining
  // pg_catalog query containing ::OID/CAST(... AS OID) must stay local or Db2
  // will try to resolve OID as an *SQLUDT (SQL0204).
  if ((/::\s*oid\b/i.test(s) || /\bcast\s*\([^)]*\bas\s+oid\s*\)/i.test(s))
      && /\b(?:pg_catalog\.)?pg_(?:namespace|class|type)\b/i.test(s)) return true;

  if (/\bpg_catalog\./i.test(withoutMappedRelations)) return true;
  // PostgreSQL reserves the pg_* namespace for system objects/functions. After
  // removing the three catalog relations explicitly mapped by this proxy, no
  // remaining pg_* token is allowed to leak into Db2 for i.
  if (/\bpg_[a-z0-9_]+\b/i.test(withoutMappedRelations)) return true;
  if (/\binet_server_(?:addr|port)\s*\(/i.test(withoutMappedRelations)) return true;
  if (/\bhas_(?:table|schema|database|sequence|function|column|any_column)_privilege\s*\(/i.test(withoutMappedRelations)) return true;
  return false;
}

function syntheticPgDatabase(sql: string, database: string, user: string): SyntheticResult {
  const db = database || 'ibmi';

  // pgAdmin database Properties/SQL tab contract. This is intentionally a
  // virtual PostgreSQL database layered over one IBM i relational database.
  if (/\bspcoid\b/i.test(sql) || /\bdatowner\b/i.test(sql)
      || /\bdatcollate\b/i.test(sql) || /\bdatctype\b/i.test(sql)
      || /\bdatconnlimit\b/i.test(sql) || /\bdefault_tablespace\b/i.test(sql)
      || /\btblacl\b/i.test(sql) || /\bseqacl\b/i.test(sql) || /\bfuncacl\b/i.test(sql)) {
    return {
      fields: [
        oid('did'), oid('oid'), text('name'), oid('spcoid'), text('spcname'), bool('datallowconn'),
        text('encoding'), text('datowner'), text('datcollate'), text('datctype'), int4('datconnlimit'),
        bool('cancreate'), text('default_tablespace'), text('comments'), bool('is_template'),
        text('tblacl'), text('seqacl'), text('funcacl'), text('acl'),
      ],
      rows: [[
        16384, 16384, db, 1663, 'pg_default', true, 'UTF8', user, 'C', 'C', -1,
        true, 'pg_default', null, false, null, null, null, null,
      ]],
      tag: 'SELECT 1',
    };
  }

  if (/\bdatname\s+as\s+name\b/i.test(sql)) {
    const fields = [
      oid('did'), text('name'), text('spcname'), bool('datallowconn'),
      bool('is_template'), bool('cancreate'), oid('owner'),
    ];
    const row: unknown[] = [16384, db, 'pg_default', true, false, true, 10];
    if (/\bdescription\b/i.test(sql)) {
      fields.push(text('description'));
      row.push(null);
    }
    return { fields, rows: [row], tag: 'SELECT 1' };
  }

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
    return { fields: [int8('count')], rows: [[1]], tag: 'SELECT 1' };
  }

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
  // Exact pgAdmin 9.17 _set_user_info capability shape, including the
  // can_signal_backend field introduced by its recursive role-membership test.
  if (/\bis_superuser\b/i.test(sql) || /\bcan_create_role\b/i.test(sql) || /\bcan_create_db\b/i.test(sql) || /\bcan_signal_backend\b/i.test(sql)) {
    return {
      fields: [
        oid('id'), text('name'), bool('is_superuser'),
        bool('can_create_role'), bool('can_create_db'), bool('can_signal_backend'),
      ],
      rows: [[10, user, false, false, false, false]],
      tag: 'SELECT 1',
    };
  }

  // SELECT rolname FROM pg_roles ... is used to validate an optional SET ROLE.
  if (/^select\s+(?:[a-z_][a-z0-9_$]*\.)?rolname\b/i.test(sql) && !/\brolcanlogin\b/i.test(sql)) {
    return { fields: [text('rolname')], rows: [[user]], tag: 'SELECT 1' };
  }

  if (/\brolcanlogin\b/i.test(sql) || /\brolsuper\b/i.test(sql)) {
    const fields: FieldDescription[] = [oid('oid'), text('rolname'), bool('rolcanlogin'), bool('rolsuper')];
    const row: unknown[] = [10, user, true, false];
    if (/\bdescription\b/i.test(sql)) { fields.push(text('description')); row.push(null); }
    return { fields, rows: [row], tag: 'SELECT 1' };
  }
  return {
    fields: [oid('oid'), text('rolname')],
    rows: [[10, user]],
    tag: 'SELECT 1',
  };
}

function syntheticPgTablespace(sql: string, user: string): SyntheticResult {
  if (/\bspcname\s+as\s+name\b/i.test(sql)) {
    const fields: FieldDescription[] = [oid('oid'), text('name'), text('owner')];
    const row: unknown[] = [1663, 'pg_default', user];
    if (/\bdescription\b/i.test(sql)) { fields.push(text('description')); row.push(null); }
    return { fields, rows: [row], tag: 'SELECT 1' };
  }
  return {
    fields: [oid('oid'), text('spcname'), oid('spcowner')],
    rows: [[1663, 'pg_default', 10]],
    tag: 'SELECT 1',
  };
}

function syntheticPgSettings(sql: string, currentSchema: string): SyntheticResult {
  // Exact dashboard config shape.
  if (/\bshort_desc\b/i.test(sql) || /\bcategory\b/i.test(sql)) {
    return {
      fields: [text('name'), text('category'), text('setting'), text('unit'), text('short_desc')],
      rows: [
        ['server_version', 'Preset Options', '14.0', '', 'PostgreSQL compatibility level exposed by the IBM i proxy'],
        ['client_encoding', 'Client Connection Defaults / Locale and Formatting', 'UTF8', '', 'Client character encoding'],
        ['search_path', 'Client Connection Defaults / Statement Behavior', currentSchema, '', 'IBM i current schema exposed as PostgreSQL search_path'],
        ['TimeZone', 'Client Connection Defaults / Locale and Formatting', 'UTC', '', 'Proxy compatibility timezone'],
        ['DateStyle', 'Client Connection Defaults / Locale and Formatting', 'ISO, MDY', '', 'Proxy compatibility date style'],
      ],
      tag: 'SELECT 5',
    };
  }
  return emptyProjectedResult(sql, [text('name'), text('setting')]);
}

function syntheticServerIdentity(sql: string, context: PgAdminCompatContext): SyntheticResult {
  const fields: FieldDescription[] = [];
  const row: unknown[] = [];

  const add = (name: string, value: unknown, desc: FieldDescription) => {
    fields.push({ ...desc, name });
    row.push(value);
  };

  if (/\binet_server_addr\s*\(/i.test(sql)) add(aliasForExpression(sql, 'inet_server_addr') ?? 'inet_server_addr', null, text('inet_server_addr'));
  if (/\binet_server_port\s*\(/i.test(sql)) add(aliasForExpression(sql, 'inet_server_port') ?? 'inet_server_port', context.serverPort ?? 5432, int4('inet_server_port'));
  if (/\bpg_is_in_recovery\s*\(/i.test(sql)) add(aliasForExpression(sql, 'pg_is_in_recovery') ?? 'pg_is_in_recovery', false, bool('pg_is_in_recovery'));
  if (/\bpg_control_system\s*\(/i.test(sql) || /\bsystem_identifier\b/i.test(sql)) {
    add(aliasForSystemIdentifier(sql) ?? 'system_identifier', context.systemIdentifier ?? '9223372036854775000', text('system_identifier'));
  }

  return { fields, rows: [row], tag: 'SELECT 1' };
}

function syntheticDashboardStats(sql: string): SyntheticResult {
  const definitions: Record<string, Record<string, number>> = {
    session_stats: { Total: 0, Active: 0, Idle: 0 },
    tps_stats: { Transactions: 0, Commits: 0, Rollbacks: 0 },
    ti_stats: { Inserts: 0, Updates: 0, Deletes: 0 },
    to_stats: { Fetched: 0, Returned: 0 },
    bio_stats: { Reads: 0, Hits: 0 },
  };

  const requested: string[] = [];
  for (const name of Object.keys(definitions)) {
    if (new RegExp(`['\"]${name}['\"]`, 'i').test(sql)) requested.push(name);
  }
  // Defensive fallback for a future pgAdmin chart query: preserve the exact
  // structural contract even if we do not yet recognize its metric semantics.
  if (!requested.length) {
    const m = sql.match(/['"]([a-z0-9_]+)['"]\s+as\s+chart_name/i);
    if (m) requested.push(m[1]!);
  }

  const rows = requested.map((name) => [name, JSON.stringify(definitions[name] ?? {})]);
  return {
    fields: [text('chart_name'), json('chart_data')],
    rows,
    tag: `SELECT ${rows.length}`,
  };
}

function isVirtualMonitoringSql(sql: string): boolean {
  const relationPattern = /\b(?:pg_catalog\.)?(?:pg_stat_activity|pg_stat_database|pg_stat_database_conflicts|pg_stat_bgwriter|pg_stat_archiver|pg_stat_wal|pg_stat_replication|pg_stat_wal_receiver|pg_locks|pg_prepared_xacts|pg_replication_slots|pg_stat_progress_[a-z0-9_]+|pg_stat_user_[a-z0-9_]+|pg_statio_[a-z0-9_]+)\b/i;
  const functionPattern = /\b(?:pg_catalog\.)?pg_sys_[a-z0-9_]+\s*\(/i;
  return relationPattern.test(sql) || functionPattern.test(sql) || /\/\*\s*pga4dash\s*\*\//i.test(sql);
}

function emptyProjectedResult(sql: string, fallbackFields: FieldDescription[] = [text('_proxy')]): SyntheticResult {
  const names = projectedNames(sql);
  const fields = names.length
    ? names.map(projectedField)
    : fallbackFields;

  // PostgreSQL SELECTs without a top-level FROM always have one outer row, and
  // an aggregate SELECT without GROUP BY/HAVING also has one row even if the
  // input relation is empty. A generic zero-row quarantine for those shapes is
  // observably wrong and can crash clients that legitimately read rows[0]
  // (pgAdmin's replication-type helper is one concrete example). Preserve the
  // cardinality contract while keeping unknown values conservative/NULL.
  if (names.length && virtualSelectGuaranteesOneRow(sql)) {
    const row = fields.map((desc) => defaultVirtualScalarValue(desc));
    return { fields, rows: [row], tag: 'SELECT 1' };
  }

  return { fields, rows: [], tag: 'SELECT 0' };
}

function projectedField(name: string): FieldDescription {
  if (/^(?:gss_authenticated|encrypted|ssl|granted|fastpath|is_|has_|can_)/i.test(name)) return bool(name);
  if (/^(?:pid|server_port|bits|backend_xid|backend_xmin)$/i.test(name)) return int4(name);
  if (/^(?:count|total|transactions|commits|rollbacks)$/i.test(name)) return int8(name);
  if (name === 'chart_data') return json(name);
  return text(name);
}

function defaultVirtualScalarValue(desc: FieldDescription): unknown {
  if (desc.typeOid === OID.bool) return false;
  if (desc.typeOid === OID.int8 && /^(?:count|total|transactions|commits|rollbacks)$/i.test(desc.name)) return 0;
  return null;
}

function virtualSelectGuaranteesOneRow(sql: string): boolean {
  if (!/^\s*select\b/i.test(sql)) return false;
  if (!hasTopLevelWord(sql, 'from')) return true;
  if (hasTopLevelWord(sql, 'group') || hasTopLevelWord(sql, 'having')) return false;

  const projection = outerSelectProjection(sql) ?? '';
  // Window aggregates retain input cardinality, so an empty relation still
  // yields zero rows. Do not apply ordinary aggregate cardinality to them.
  if (/\bover\s*\(/i.test(projection)) return false;
  return /\b(?:count|sum|avg|min|max|bool_and|bool_or|array_agg|json_agg|jsonb_agg)\s*\(/i.test(projection);
}

function projectedNames(sql: string): string[] {
  const cleaned = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\r\n]*/g, ' ');
  const range = outerSelectProjection(cleaned);
  if (!range) return [];
  const parts = splitTopLevel(range);
  const names: string[] = [];
  for (const part of parts) {
    const p = part.trim();
    if (!p || p === '*') continue;
    let m = p.match(/\bas\s+"([^"]+)"\s*$/i);
    if (m) { names.push(m[1]!); continue; }
    m = p.match(/\bas\s+([a-z_][a-z0-9_$]*)\s*$/i);
    if (m) { names.push(m[1]!); continue; }
    m = p.match(/(?:^|\.)"([^"]+)"\s*$/);
    if (m) { names.push(m[1]!); continue; }
    m = p.match(/(?:^|\.)([a-z_][a-z0-9_$]*)\s*$/i);
    if (m) { names.push(m[1]!); continue; }
    names.push(`column${names.length + 1}`);
  }
  return dedupe(names);
}

function outerSelectProjection(sql: string): string | undefined {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let selectEnd = -1;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "'" && !inDouble) {
      if (inSingle && sql[i + 1] === "'") { i++; continue; }
      inSingle = !inSingle; continue;
    }
    if (c === '"' && !inSingle) {
      if (inDouble && sql[i + 1] === '"') { i++; continue; }
      inDouble = !inDouble; continue;
    }
    if (inSingle || inDouble) continue;
    if (c === '(') { depth++; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0 && wordAt(sql, i, 'select')) { selectEnd = i + 6; break; }
  }
  if (selectEnd < 0) return undefined;

  depth = 0; inSingle = false; inDouble = false;
  for (let i = selectEnd; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "'" && !inDouble) {
      if (inSingle && sql[i + 1] === "'") { i++; continue; }
      inSingle = !inSingle; continue;
    }
    if (c === '"' && !inSingle) {
      if (inDouble && sql[i + 1] === '"') { i++; continue; }
      inDouble = !inDouble; continue;
    }
    if (inSingle || inDouble) continue;
    if (c === '(') { depth++; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0 && (wordAt(sql, i, 'from') || wordAt(sql, i, 'union') || wordAt(sql, i, 'order') || wordAt(sql, i, 'limit') || wordAt(sql, i, 'fetch'))) {
      return sql.slice(selectEnd, i).trim();
    }
  }
  return sql.slice(selectEnd).trim();
}

function splitTopLevel(textValue: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let start = 0;
  for (let i = 0; i < textValue.length; i++) {
    const c = textValue[i]!;
    if (c === "'" && !inDouble) {
      if (inSingle && textValue[i + 1] === "'") { i++; continue; }
      inSingle = !inSingle; continue;
    }
    if (c === '"' && !inSingle) {
      if (inDouble && textValue[i + 1] === '"') { i++; continue; }
      inDouble = !inDouble; continue;
    }
    if (inSingle || inDouble) continue;
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) { out.push(textValue.slice(start, i)); start = i + 1; }
  }
  out.push(textValue.slice(start));
  return out;
}

function hasTopLevelWord(sql: string, word: string): boolean {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "'" && !inDouble) {
      if (inSingle && sql[i + 1] === "'") { i++; continue; }
      inSingle = !inSingle;
      continue;
    }
    if (c === '"' && !inSingle) {
      if (inDouble && sql[i + 1] === '"') { i++; continue; }
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (c === '(') { depth++; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0 && wordAt(sql, i, word)) return true;
  }
  return false;
}

function wordAt(sql: string, index: number, word: string): boolean {
  if (sql.slice(index, index + word.length).toLowerCase() !== word) return false;
  const before = index === 0 ? '' : sql[index - 1]!;
  const after = sql[index + word.length] ?? '';
  return !/[a-z0-9_$]/i.test(before) && !/[a-z0-9_$]/i.test(after);
}

function dedupe(values: string[]): string[] {
  const seen = new Map<string, number>();
  return values.map((value) => {
    const n = seen.get(value) ?? 0;
    seen.set(value, n + 1);
    return n === 0 ? value : `${value}_${n + 1}`;
  });
}

function projectedAlias(sql: string): string | undefined {
  return sql.match(/\bas\s+([a-z_][a-z0-9_$]*)\s*$/i)?.[1];
}

function aliasForExpression(sql: string, functionName: string): string | undefined {
  const re = new RegExp(`${functionName}\\s*\\([^)]*\\)\\s+(?:as\\s+)?([a-z_][a-z0-9_$]*)`, 'i');
  return sql.match(re)?.[1];
}

function aliasForSystemIdentifier(sql: string): string | undefined {
  return sql.match(/\(\s*select\s+system_identifier\s+from\s+(?:pg_catalog\.)?pg_control_system\s*\(\s*\)\s*\)\s+(?:as\s+)?"?([a-z_][a-z0-9_$]*)"?/i)?.[1]
    ?? sql.match(/system_identifier\s+(?:as\s+)?"?([a-z_][a-z0-9_$]*)"?\s*$/i)?.[1];
}


function syntheticBuiltinSelect(sql: string, context: PgAdminCompatContext): SyntheticResult | undefined {
  const projection = outerSelectProjection(sql);
  if (!projection) return undefined;
  // Do not attempt this evaluator for SELECTs that have a top-level FROM.
  // Catalog and table-backed queries are handled by dedicated virtual handlers
  // or by the Db2 translation path, never by this scalar evaluator.
  if (hasTopLevelWord(sql, 'from')) return undefined;

  const parts = splitTopLevel(projection);
  if (!parts.length) return undefined;
  const fields: FieldDescription[] = [];
  const row: unknown[] = [];

  for (const part of parts) {
    const parsed = evaluateBuiltinExpression(part.trim(), context);
    if (!parsed) return undefined;
    fields.push(parsed.field);
    row.push(parsed.value);
  }
  return { fields, rows: [row], tag: 'SELECT 1' };
}

function evaluateBuiltinExpression(
  expression: string,
  context: PgAdminCompatContext,
): { field: FieldDescription; value: unknown } | undefined {
  const alias = expression.match(/\bas\s+"([^"]+)"\s*$/i)?.[1]
    ?? expression.match(/\bas\s+([a-z_][a-z0-9_$]*)\s*$/i)?.[1];
  const core = expression
    .replace(/\bas\s+"[^"]+"\s*$/i, '')
    .replace(/\bas\s+[a-z_][a-z0-9_$]*\s*$/i, '')
    .trim();

  if (/^(?:pg_catalog\.)?current_database\s*\(\s*\)$/i.test(core)) {
    return { field: text(alias ?? 'current_database'), value: context.database || 'ibmi' };
  }
  if (/^(?:pg_catalog\.)?current_schema\s*\(\s*\)$/i.test(core)) {
    return { field: text(alias ?? 'current_schema'), value: context.currentSchema };
  }
  if (/^(?:current_user|session_user)$/i.test(core)) {
    return { field: text(alias ?? core.toLowerCase()), value: context.user };
  }
  if (/^(?:pg_catalog\.)?pg_backend_pid\s*\(\s*\)$/i.test(core)) {
    return { field: int4(alias ?? 'pg_backend_pid'), value: process.pid };
  }
  if (/^(?:pg_catalog\.)?pg_is_in_recovery\s*\(\s*\)$/i.test(core)) {
    return { field: bool(alias ?? 'pg_is_in_recovery'), value: false };
  }
  if (/^(?:pg_catalog\.)?pg_is_wal_replay_paused\s*\(\s*\)$/i.test(core)) {
    return { field: bool(alias ?? 'pg_is_wal_replay_paused'), value: false };
  }
  if (/^(?:pg_catalog\.)?inet_server_addr\s*\(\s*\)$/i.test(core)) {
    return { field: text(alias ?? 'inet_server_addr'), value: null };
  }
  if (/^(?:pg_catalog\.)?inet_server_port\s*\(\s*\)$/i.test(core)) {
    return { field: int4(alias ?? 'inet_server_port'), value: context.serverPort ?? 5432 };
  }
  if (/^(?:pg_catalog\.)?version\s*\(\s*\)$/i.test(core)) {
    return { field: text(alias ?? 'version'), value: 'PostgreSQL 14.0 compatible gateway to IBM i Db2 (Mapepire Proxy 0.1.26)' };
  }
  const setting = core.match(/^(?:pg_catalog\.)?current_setting\s*\(\s*'([^']+)'(?:\s*,\s*(?:true|false))?\s*\)$/i);
  if (setting) {
    const value = currentSetting(setting[1]!.toLowerCase(), context.currentSchema);
    if (value !== undefined) return { field: text(alias ?? 'current_setting'), value };
  }
  let m = core.match(/^(-?\d+)$/);
  if (m) return { field: int4(alias ?? '?column?'), value: Number(m[1]) };
  m = core.match(/^'(.*)'$/s);
  if (m) return { field: text(alias ?? '?column?'), value: m[1]!.replaceAll("''", "'") };
  if (/^(true|false)$/i.test(core)) return { field: bool(alias ?? '?column?'), value: core.toLowerCase() === 'true' };
  return undefined;
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
    server_version: '14.0',
    server_version_num: '140000',
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
