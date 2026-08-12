import { OID } from '../postgres/oids.js';
import type { FieldDescription } from '../postgres/wire.js';
import type { SyntheticResult } from './environment.js';

export interface IbmiViewRow {
  schema: string;
  name: string;
  owner: string;
  text: string | null;
  longComment: string | null;
  columnCount: number;
  definition: string | null;
  checkOption: string | null;
}

export interface RegisteredIbmiView {
  schema: string;
  name: string;
}

// Views use the same cross-connection virtual-OID model as tables. pgAdmin can
// list a view on one PostgreSQL connection and ask for its Columns on another.
const viewRegistry = new Map<number, RegisteredIbmiView>();

export function registerIbmiViews(rows: IbmiViewRow[]): void {
  for (const row of rows) viewRegistry.set(viewOid(row.schema, row.name), { schema: row.schema, name: row.name });
}

export function lookupRegisteredIbmiView(oid: number): RegisteredIbmiView | undefined {
  return viewRegistry.get(oid);
}

/**
 * QSYS2.SYSTABLES identifies SQL views while QSYS2.SYSVIEWS supplies the
 * actual query expression. Keep the read uncached at session level so CREATE
 * VIEW on IBM i becomes visible on the next pgAdmin refresh.
 */
export const IBMI_VIEW_CATALOG_SQL = `SELECT T.TABLE_SCHEMA, T.TABLE_NAME, T.TABLE_OWNER,
       T.TABLE_TEXT, T.LONG_COMMENT, T.COLUMN_COUNT,
       V.VIEW_DEFINITION
  FROM QSYS2.SYSTABLES T
  LEFT JOIN QSYS2.SYSVIEWS V
    ON V.TABLE_SCHEMA = T.TABLE_SCHEMA AND V.TABLE_NAME = T.TABLE_NAME
 WHERE T.TABLE_SCHEMA = ?
   AND T.TABLE_TYPE = 'V'
 ORDER BY T.TABLE_NAME`;

export type PgAdminIbmiViewRequest =
  | { kind: 'count'; schemaOid?: number }
  | { kind: 'nodes'; schemaOid?: number; viewOid?: number }
  | { kind: 'properties'; schemaOid?: number; viewOid?: number };

const field = (name: string, typeOid: number, typeSize: number): FieldDescription => ({ name, typeOid, typeSize });
const text = (name: string) => field(name, OID.text, -1);
const oid = (name: string) => field(name, OID.oid, 4);
const bool = (name: string) => field(name, OID.bool, 1);
const int8 = (name: string) => field(name, OID.int8, 8);

/** Recognize pgAdmin Views count/nodes/properties SQL without forwarding PostgreSQL catalogs to Db2. */
export function classifyPgAdminIbmiViewQuery(sql: string): PgAdminIbmiViewRequest | undefined {
  const s = compact(sql);
  if (!/\b(?:pg_catalog\.)?pg_class\b/i.test(s)) return undefined;

  // Limit this adapter to ordinary PostgreSQL views. Materialized views have a
  // different relkind and no direct IBM i browser mapping in this release.
  if (!/\b(?:c|rel)\s*\.\s*relkind\s*=\s*'v'(?:::\s*"?(?:char|text)"?)?/i.test(s)
      && !/\brelkind\s*=\s*'v'(?:::\s*"?(?:char|text)"?)?/i.test(s)) return undefined;

  const schemaOid = extractNumeric(s, [
    /\b(?:c|rel)\s*\.\s*relnamespace\s*=\s*'?([0-9]+)'?(?:::\s*oid)?/i,
    /\brelnamespace\s*=\s*'?([0-9]+)'?(?:::\s*oid)?/i,
  ]);
  const viewOidValue = extractNumeric(s, [
    /\b(?:c|rel)\s*\.\s*oid\s*=\s*'?([0-9]+)'?(?:::\s*oid)?/i,
  ]);

  // ViewModule.get_nodes() calls count.sql first and hides the Views collection
  // when the scalar result is zero.
  if (/^select\s+count\s*\(/i.test(s)) return { kind: 'count', schemaOid };

  // properties.sql is distinct from nodes.sql by pg_get_viewdef/owner/ACL and
  // returns the definition that pgAdmin shows in the Properties tab.
  if (/\bpg_get_viewdef\s*\(/i.test(s) || /\bsecurity_barrier\b/i.test(s) || /\bispopulated\b/i.test(s)) {
    return { kind: 'properties', schemaOid, viewOid: viewOidValue };
  }

  // nodes.sql returns oid/name/comment and can optionally be scoped to one vid.
  if (/\brelname\s+as\s+name\b/i.test(s) || /\bdescription\s+as\s+comment\b/i.test(s)) {
    return { kind: 'nodes', schemaOid, viewOid: viewOidValue };
  }

  return undefined;
}

export function renderPgAdminIbmiViewQuery(
  request: PgAdminIbmiViewRequest,
  views: IbmiViewRow[],
): SyntheticResult {
  const ordered = [...views].sort((a, b) => a.name.localeCompare(b.name));

  if (request.kind === 'count') {
    return { fields: [int8('count')], rows: [[ordered.length]], tag: 'SELECT 1' };
  }

  const selected = request.viewOid === undefined
    ? ordered
    : ordered.filter((row) => viewOid(row.schema, row.name) === request.viewOid);

  if (request.kind === 'nodes') {
    return {
      fields: [oid('oid'), text('name'), text('comment')],
      rows: selected.map((row) => [viewOid(row.schema, row.name), row.name, row.longComment ?? row.text]),
      tag: `SELECT ${selected.length}`,
    };
  }

  // Match the keys returned by pgAdmin's PostgreSQL view properties template.
  // Unsupported PostgreSQL-only concepts are represented conservatively while
  // owner, definition, schema, name and comments come from live IBM i catalogs.
  const fields: FieldDescription[] = [
    oid('oid'), int8('xmin'), text('relkind'), text('comment'), text('spcname'), text('name'),
    oid('spcoid'), text('schema'), bool('ispopulated'), text('owner'), text('acl'), text('definition'),
    bool('system_view'), text('seclabels'), text('check_option'), bool('security_barrier'),
  ];
  return {
    fields,
    rows: selected.map((row) => [
      viewOid(row.schema, row.name), 0, 'v', row.longComment ?? row.text, 'pg_default', row.name,
      0, row.schema, true, row.owner, null, row.definition,
      false, null, normalizeCheckOption(row.checkOption), false,
    ]),
    tag: `SELECT ${selected.length}`,
  };
}

/** Stable non-system virtual OID for an IBM i SQL view. */
export function viewOid(schema: string, name: string): number {
  let hash = 0x811c9dc5;
  const input = `V:${schema}\u0000${name}`;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    hash ^= code & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (code >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Separate from index (1.9b) and table (2.05b) virtual-OID ranges.
  return 1_800_000_000 + (hash % 90_000_000);
}

function normalizeCheckOption(value: string | null): string | null {
  const v = value?.trim().toUpperCase();
  if (v === 'Y') return 'local';
  if (v === 'C') return 'cascaded';
  return null;
}

function extractNumeric(sql: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = sql.match(pattern);
    if (match?.[1]) return Number(match[1]);
  }
  return undefined;
}

function compact(sql: string): string {
  return sql.replace(/--[^\r\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim();
}
