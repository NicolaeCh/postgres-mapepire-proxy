import type { FieldDescription } from '../postgres/wire.js';
import { OID } from '../postgres/oids.js';

export interface SyntheticResult {
  fields: FieldDescription[];
  rows: unknown[][];
  tag: string;
}

const oneText = (name: string, value: unknown): SyntheticResult => ({
  fields: [{ name, typeOid: OID.text, typeSize: -1 }],
  rows: [[value]],
  tag: 'SELECT 1',
});

const oneName = (name: string, value: unknown): SyntheticResult => ({
  fields: [{ name, typeOid: OID.name, typeSize: 64 }],
  rows: [[value]],
  tag: 'SELECT 1',
});

export function environmentQuery(
  sql: string,
  database: string,
  currentSchema: string,
  serverVersion = '14.0',
): SyntheticResult | undefined {
  const compact = sql.trim().replace(/;$/, '').replace(/\s+/g, ' ');
  if (/^show\s+max_identifier_length$/i.test(compact)) return oneText('max_identifier_length', 128);
  if (/^show\s+server_version$/i.test(compact)) return oneText('server_version', serverVersion);
  if (/^show\s+server_version_num$/i.test(compact)) {
    const [majorRaw, minorRaw = '0'] = serverVersion.split('.');
    const major = Number(majorRaw || 14);
    const minor = Number(minorRaw || 0);
    const num = Number.isFinite(major) && Number.isFinite(minor) ? String(major * 10000 + minor * 100) : '140000';
    return oneText('server_version_num', num);
  }
  if (/^show\s+standard_conforming_strings$/i.test(compact)) return oneText('standard_conforming_strings', 'on');
  if (/^show\s+integer_datetimes$/i.test(compact)) return oneText('integer_datetimes', 'on');
  if (/^show\s+transaction_isolation$/i.test(compact)) return oneText('transaction_isolation', 'read committed');
  // SQLAlchemy PostgreSQL dialect initialization uses the SQL-standard SHOW
  // spelling rather than PostgreSQL's underscore setting name. psycopg reads
  // the first column positionally, but keep the PostgreSQL setting name for
  // clients that inspect result metadata.
  if (/^show\s+transaction\s+isolation\s+level$/i.test(compact)) return oneText('transaction_isolation', 'read committed');
  if (/^show\s+default_transaction_isolation$/i.test(compact)) return oneText('default_transaction_isolation', 'read committed');
  if (/^show\s+client_encoding$/i.test(compact)) return oneText('client_encoding', 'UTF8');
  if (/^show\s+search_path$/i.test(compact)) return oneText('search_path', currentSchema);
  if (/^show\s+timezone$/i.test(compact)) return oneText('TimeZone', 'UTC');
  if (/^show\s+datestyle$/i.test(compact)) return oneText('DateStyle', 'ISO, MDY');
  if (/^show\s+default_transaction_read_only$/i.test(compact)) return oneText('default_transaction_read_only', 'off');
  // SQLAlchemy 2.x PostgreSQL dialect asks pg_catalog.version(), while pgAdmin
  // commonly asks unqualified version(). Both must return a non-NULL scalar
  // whose text contains a PostgreSQL major/minor version.
  if (/^select\s+(?:pg_catalog\.)?version\s*\(\s*\)$/i.test(compact)) {
    return oneText('version', `PostgreSQL ${serverVersion} compatible gateway to IBM i Db2 (Mapepire Proxy 0.1.28)`);
  }
  if (/^select\s+current_database\(\)/i.test(compact)) return oneText('current_database', database || 'ibmi');
  if (/^select\s+current_schema(?:\(\))?(?:\s+as\s+([a-z_][a-z0-9_$]*))?$/i.test(compact)) {
    const alias = compact.match(/\s+as\s+([a-z_][a-z0-9_$]*)$/i)?.[1] ?? 'current_schema';
    return oneName(alias, currentSchema);
  }
  if (/^select\s+current_setting\(\s*'search_path'\s*(?:,\s*(?:true|false))?\s*\)(?:\s+as\s+([a-z_][a-z0-9_$]*))?$/i.test(compact)) {
    const alias = compact.match(/\s+as\s+([a-z_][a-z0-9_$]*)$/i)?.[1] ?? 'current_setting';
    return oneText(alias, currentSchema);
  }
  const schemasMatch = compact.match(/^select\s+current_schemas\(\s*(true|false)\s*\)(?:\s+as\s+([a-z_][a-z0-9_$]*))?$/i);
  if (schemasMatch) {
    const includeImplicit = schemasMatch[1]!.toLowerCase() === 'true';
    const alias = schemasMatch[2] ?? 'current_schemas';
    // The proxy intentionally implements one effective application schema.
    // pg_catalog is virtual and never sent to Db2, but include it in the
    // introspection result when PostgreSQL asks for implicit schemas.
    const entries = includeImplicit ? ['pg_catalog', currentSchema] : [currentSchema];
    const arrayText = `{${entries.map((entry) => `"${entry.replaceAll('\"', '\\"')}"`).join(',')}}`;
    return {
      fields: [{ name: alias, typeOid: OID.nameArray, typeSize: -1 }],
      rows: [[arrayText]],
      tag: 'SELECT 1',
    };
  }
  if (/^set\s+(client_encoding|client_min_messages|bytea_output|application_name|extra_float_digits|standard_conforming_strings|timezone|datestyle|statement_timeout|lock_timeout|idle_in_transaction_session_timeout)\b/i.test(compact)) {
    return { fields: [], rows: [], tag: 'SET' };
  }
  return undefined;
}
