import { OID } from '../postgres/oids.js';
import type { FieldDescription } from '../postgres/wire.js';
import type { SyntheticResult } from './environment.js';

export interface IbmiTableRow {
  schema: string;
  name: string;
  owner: string;
  type: string;
  text: string | null;
  longComment: string | null;
  columnCount: number;
}

export interface PgAdminIbmiTableContext {
  user: string;
}

export type PgAdminIbmiTableRequest =
  | { kind: 'count'; schemaOid?: number; schemaName?: string }
  | { kind: 'exists'; schemaOid?: number; schemaName?: string }
  | { kind: 'nodes'; schemaOid?: number; schemaName?: string; tableOid?: number }
  | { kind: 'properties'; schemaOid?: number; schemaName?: string; tableOid?: number; includePartitionScheme: boolean }
  | { kind: 'oidByName'; schemaOid?: number; schemaName?: string; tableName: string }
  | { kind: 'nameByOid'; schemaOid?: number; schemaName?: string; tableOid: number }
  | { kind: 'schemaForTable'; schemaOid?: number; tableOid?: number; tableName?: string; schemaName?: string };

const field = (name: string, typeOid: number, typeSize: number): FieldDescription => ({ name, typeOid, typeSize });
const text = (name: string) => field(name, OID.text, -1);
const oidField = (name: string) => field(name, OID.oid, 4);
const bool = (name: string) => field(name, OID.bool, 1);
const int4 = (name: string) => field(name, OID.int4, 4);
const int8 = (name: string) => field(name, OID.int8, 8);

/**
 * Recognize pgAdmin's table collection/browser SQL.  pgAdmin's PostgreSQL
 * templates use pg_class OIDs as stable browser identifiers.  Those OIDs do
 * not exist on IBM i, so this adapter resolves the request against live
 * QSYS2.SYSTABLES rows and emits deterministic virtual OIDs.
 */
export function classifyPgAdminIbmiTableQuery(sql: string): PgAdminIbmiTableRequest | undefined {
  const s = compact(sql);
  if (!/\b(?:pg_catalog\.)?pg_class\b/i.test(s)) return undefined;

  const schemaOid = extractSchemaOid(s);
  const schemaName = extractSchemaName(s);
  const tableOidValue = extractTableOid(s);
  const tableName = extractTableName(s);

  // CollectionNodeModule.has_nodes() uses count.sql before showing Tables.
  if (/^select\s+count\s*\(\s*\*\s*\)/i.test(s)
      && /\brelkind\s+in\s*\(/i.test(s)
      && /\brelnamespace\b/i.test(s)) {
    return { kind: 'count', schemaOid, schemaName };
  }

  // Some pgAdmin/driver feature paths use an EXISTS form for the same test.
  if (/^select\s+exists\s*\(/i.test(s)
      && /\brelkind\s+in\s*\(/i.test(s)
      && /\brelnamespace\b/i.test(s)) {
    return { kind: 'exists', schemaOid, schemaName };
  }

  // REL-9_17 tables/sql/default/nodes.sql exact shape.
  if (/\btriggercount\b/i.test(s)
      && /\bhas_enable_triggers\b/i.test(s)
      && /\bis_inherits\b/i.test(s)
      && /\bis_inherited\b/i.test(s)) {
    return { kind: 'nodes', schemaOid, schemaName, tableOid: tableOidValue };
  }

  // REL-9_17 properties.sql contains this distinctive property set and an
  // EXISTS(...) PostgreSQL expression that Db2 for i must never see directly.
  if (/\breplica_identity\b/i.test(s)
      && /\brelacl_str\b/i.test(s)
      && /\bhastoasttable\b/i.test(s)) {
    return {
      kind: 'properties', schemaOid, schemaName, tableOid: tableOidValue,
      includePartitionScheme: /\bpartition_scheme\b/i.test(s),
    };
  }

  // get_schema_oid.sql, used after CREATE TABLE and during object refresh.
  if (/\brelnamespace\s+as\s+scid\b/i.test(s) && /\bnspname\s+as\s+nspname\b/i.test(s)) {
    return { kind: 'schemaForTable', schemaOid, tableOid: tableOidValue, tableName, schemaName };
  }

  // get_table.sql / simple name lookup.
  if (/^select\s+(?:[a-z_][a-z0-9_$]*\.)?relname\s+as\s+name\b/i.test(s) && tableOidValue !== undefined) {
    return { kind: 'nameByOid', schemaOid, schemaName, tableOid: tableOidValue };
  }

  // OID lookup after CREATE TABLE.  Keep this deliberately narrow so normal
  // application pg_class compatibility requests still use their own path.
  if (/^select\s+(?:[a-z_][a-z0-9_$]*\.)?oid\b/i.test(s)
      && tableName !== undefined
      && /\brelnamespace\b/i.test(s)) {
    return { kind: 'oidByName', schemaOid, schemaName, tableName };
  }

  return undefined;
}

export function renderPgAdminIbmiTableQuery(
  request: PgAdminIbmiTableRequest,
  tables: IbmiTableRow[],
  schemaOidValue: number,
  context: PgAdminIbmiTableContext,
): SyntheticResult {
  const rows = [...tables].sort((a, b) => a.name.localeCompare(b.name));

  if (request.kind === 'count') {
    return { fields: [int8('count')], rows: [[rows.length]], tag: 'SELECT 1' };
  }
  if (request.kind === 'exists') {
    return { fields: [bool('exists')], rows: [[rows.length > 0]], tag: 'SELECT 1' };
  }

  if (request.kind === 'nodes') {
    const selected = request.tableOid === undefined
      ? rows
      : rows.filter((row) => tableOid(row.schema, row.name) === request.tableOid);
    return {
      fields: [
        oidField('oid'), text('name'), int8('triggercount'), int8('has_enable_triggers'),
        bool('is_partitioned'), int8('is_inherits'), int8('is_inherited'), text('description'),
      ],
      rows: selected.map((row) => [
        tableOid(row.schema, row.name), row.name, 0, 0, false, 0, 0,
        row.longComment ?? row.text,
      ]),
      tag: `SELECT ${selected.length}`,
    };
  }

  if (request.kind === 'properties') {
    const selected = request.tableOid === undefined
      ? rows
      : rows.filter((row) => tableOid(row.schema, row.name) === request.tableOid);
    const fields = tablePropertyFields(request.includePartitionScheme);
    return {
      fields,
      rows: selected.map((row) => tablePropertyRow(row, context.user, request.includePartitionScheme)),
      tag: `SELECT ${selected.length}`,
    };
  }

  if (request.kind === 'oidByName') {
    const target = rows.find((row) => sameIdentifier(row.name, request.tableName));
    return {
      fields: [oidField('oid')],
      rows: target ? [[tableOid(target.schema, target.name)]] : [],
      tag: target ? 'SELECT 1' : 'SELECT 0',
    };
  }

  if (request.kind === 'nameByOid') {
    const target = rows.find((row) => tableOid(row.schema, row.name) === request.tableOid);
    return {
      fields: [text('name')],
      rows: target ? [[target.name]] : [],
      tag: target ? 'SELECT 1' : 'SELECT 0',
    };
  }

  if (request.kind === 'schemaForTable') {
    const target = request.tableOid !== undefined
      ? rows.find((row) => tableOid(row.schema, row.name) === request.tableOid)
      : request.tableName !== undefined
        ? rows.find((row) => sameIdentifier(row.name, request.tableName!))
        : undefined;
    return {
      fields: [oidField('scid'), text('nspname')],
      rows: target ? [[schemaOidValue, target.schema]] : [],
      tag: target ? 'SELECT 1' : 'SELECT 0',
    };
  }

  return { fields: [], rows: [], tag: 'SELECT 0' };
}

/** Stable non-system virtual OID for an IBM i table. */
export function tableOid(schema: string, name: string): number {
  let hash = 0x811c9dc5;
  const input = `T:${schema}\u0000${name}`;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    hash ^= code & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (code >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Keep table OIDs in a range distinct from schemaOid(), and below signed
  // 32-bit max because pgAdmin frequently passes OIDs through Python ints.
  return 2_050_000_000 + (hash % 90_000_000);
}

function tablePropertyFields(includePartitionScheme: boolean): FieldDescription[] {
  const fields: FieldDescription[] = [
    oidField('oid'), text('name'), oidField('spcoid'), text('relacl_str'), text('spcname'),
    text('replica_identity'), text('schema'), text('relowner'), text('relkind'), bool('is_partitioned'),
    bool('relhassubclass'), int8('reltuples'), text('description'), text('conname'), text('conkey'),
    bool('isrepl'), int8('triggercount'), text('coll_inherits'), int8('inherited_tables_cnt'),
    bool('relpersistence'), text('default_amname'), text('fillfactor'), text('parallel_workers'),
    text('toast_tuple_target'), bool('autovacuum_enabled'), text('autovacuum_vacuum_threshold'),
    text('autovacuum_vacuum_scale_factor'), text('autovacuum_analyze_threshold'),
    text('autovacuum_analyze_scale_factor'), text('autovacuum_vacuum_cost_delay'),
    text('autovacuum_vacuum_cost_limit'), text('autovacuum_freeze_min_age'),
    text('autovacuum_freeze_max_age'), text('autovacuum_freeze_table_age'),
    bool('toast_autovacuum_enabled'), text('toast_autovacuum_vacuum_threshold'),
    text('toast_autovacuum_vacuum_scale_factor'), text('toast_autovacuum_analyze_threshold'),
    text('toast_autovacuum_analyze_scale_factor'), text('toast_autovacuum_vacuum_cost_delay'),
    text('toast_autovacuum_vacuum_cost_limit'), text('toast_autovacuum_freeze_min_age'),
    text('toast_autovacuum_freeze_max_age'), text('toast_autovacuum_freeze_table_age'),
    text('reloptions'), text('toast_reloptions'), oidField('reloftype'), text('amname'), text('typname'),
    oidField('typoid'), bool('rlspolicy'), bool('forcerlspolicy'), bool('hastoasttable'), text('seclabels'),
    bool('is_sys_table'),
  ];
  if (includePartitionScheme) fields.push(text('partition_scheme'));
  return fields;
}

function tablePropertyRow(row: IbmiTableRow, virtualOwner: string, includePartitionScheme: boolean): unknown[] {
  const values: unknown[] = [
    tableOid(row.schema, row.name), row.name, 0, null, 'pg_default',
    'default', row.schema, virtualOwner, 'r', false,
    false, 0, row.longComment ?? row.text, null, null,
    false, 0, null, 0,
    false, 'heap', null, null,
    null, null, null,
    null, null,
    null, null,
    null, null,
    null, null,
    null, null,
    null, null,
    null, null,
    null, null,
    null, null,
    null, null, 0, 'heap', null,
    0, false, false, false, null,
    false,
  ];
  if (includePartitionScheme) values.push('');
  return values;
}

function extractSchemaOid(sql: string): number | undefined {
  const patterns = [
    /\brelnamespace\s*=\s*'?([0-9]+)'?(?:::\s*oid)?/i,
    /\bnsp\s*\.\s*oid\s*=\s*'?([0-9]+)'?(?:::\s*oid)?/i,
  ];
  for (const pattern of patterns) {
    const m = sql.match(pattern);
    if (m) return Number(m[1]);
  }
  return undefined;
}

function extractTableOid(sql: string): number | undefined {
  const patterns = [
    /\brel\s*\.\s*oid\s*=\s*'?([0-9]+)'?(?:::\s*oid)?/i,
    /\bc\s*\.\s*oid\s*=\s*'?([0-9]+)'?(?:::\s*oid)?/i,
  ];
  for (const pattern of patterns) {
    const m = sql.match(pattern);
    if (m) return Number(m[1]);
  }
  return undefined;
}

function extractTableName(sql: string): string | undefined {
  const patterns = [
    /\b(?:rel|c)\s*\.\s*relname\s*=\s*'((?:''|[^'])*)'/i,
    /\brelname\s*=\s*'((?:''|[^'])*)'/i,
  ];
  for (const pattern of patterns) {
    const m = sql.match(pattern);
    if (m) return m[1]!.replaceAll("''", "'");
  }
  return undefined;
}

function extractSchemaName(sql: string): string | undefined {
  const m = sql.match(/\bnspname\s*=\s*'((?:''|[^'])*)'/i);
  return m?.[1]?.replaceAll("''", "'");
}

function sameIdentifier(a: string, b: string): boolean {
  return a === b || a.toUpperCase() === b.toUpperCase();
}

function compact(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;+$/, '')
    .trim();
}

/**
 * pgAdmin appends PostgreSQL ownership DDL after CREATE TABLE.  Backend work is
 * intentionally performed by one IBM i service profile, so PostgreSQL role
 * ownership is virtual metadata and this statement is acknowledged locally.
 */
export function parsePgTableOwnerDdl(sql: string): { table: string; requestedOwner: string } | undefined {
  const ident = `(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$#@]*)`;
  const qualified = `(${ident}(?:\\s*\\.\\s*${ident})?)`;
  const match = new RegExp(
    `^\\s*ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${qualified}\\s+OWNER\\s+TO\\s+(${ident}|CURRENT_USER|CURRENT_ROLE|SESSION_USER)\\s*;?\\s*$`,
    'i',
  ).exec(sql);
  if (!match) return undefined;
  return { table: match[1]!, requestedOwner: decodePgIdentifier(match[2]!) };
}

/** Basic COMMENT forms generated by pgAdmin are valid Db2 for i DDL too. */
export function isBasicPgTableCommentDdl(sql: string): boolean {
  return /^\s*COMMENT\s+ON\s+(?:TABLE|COLUMN)\b/i.test(sql);
}

export function isPgCreateTable(sql: string): boolean {
  return /^\s*CREATE\s+(?:(?:GLOBAL|LOCAL)\s+TEMPORARY\s+|TEMPORARY\s+|TEMP\s+|UNLOGGED\s+)?TABLE\b/i.test(sql);
}

function decodePgIdentifier(raw: string): string {
  const text = raw.trim();
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replaceAll('""', '"');
  return text.toUpperCase();
}
