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

export function environmentQuery(sql: string, database: string, currentSchema: string): SyntheticResult | undefined {
  const compact = sql.trim().replace(/;$/, '').replace(/\s+/g, ' ');
  if (/^show\s+max_identifier_length$/i.test(compact)) return oneText('max_identifier_length', 128);
  if (/^show\s+server_version$/i.test(compact)) return oneText('server_version', '16.4');
  if (/^show\s+server_version_num$/i.test(compact)) return oneText('server_version_num', '160004');
  if (/^show\s+standard_conforming_strings$/i.test(compact)) return oneText('standard_conforming_strings', 'on');
  if (/^show\s+integer_datetimes$/i.test(compact)) return oneText('integer_datetimes', 'on');
  if (/^show\s+transaction_isolation$/i.test(compact)) return oneText('transaction_isolation', 'read committed');
  if (/^show\s+client_encoding$/i.test(compact)) return oneText('client_encoding', 'UTF8');
  if (/^show\s+search_path$/i.test(compact)) return oneText('search_path', currentSchema);
  if (/^show\s+timezone$/i.test(compact)) return oneText('TimeZone', 'UTC');
  if (/^show\s+datestyle$/i.test(compact)) return oneText('DateStyle', 'ISO, MDY');
  if (/^show\s+default_transaction_read_only$/i.test(compact)) return oneText('default_transaction_read_only', 'off');
  if (/^select\s+version\(\)/i.test(compact)) return oneText('version', 'PostgreSQL 16.4 compatible gateway to IBM i Db2');
  if (/^select\s+current_database\(\)/i.test(compact)) return oneText('current_database', database || 'ibmi');
  if (/^select\s+current_schema\(\)/i.test(compact)) return undefined; // handled as Db2 CURRENT SCHEMA rewrite
  if (/^set\s+(client_encoding|application_name|extra_float_digits|standard_conforming_strings|timezone|datestyle|statement_timeout|lock_timeout|idle_in_transaction_session_timeout)\b/i.test(compact)) {
    return { fields: [], rows: [], tag: 'SET' };
  }
  return undefined;
}
