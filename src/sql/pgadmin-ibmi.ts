import { OID } from '../postgres/oids.js';
import type { FieldDescription } from '../postgres/wire.js';
import type { SyntheticResult } from './environment.js';

export interface IbmiSchemaRow {
  name: string;
  owner: string;
  text: string | null;
}

export interface PgAdminIbmiContext {
  user: string;
  currentSchema: string;
  hideSystemSchemas: boolean;
}

export type PgAdminIbmiSchemaRequest =
  | { kind: 'nodes' }
  | { kind: 'properties'; oid?: number; name?: string }
  | { kind: 'oidByName'; name: string }
  | { kind: 'nameByOid'; oid: number }
  | { kind: 'isCatalog'; oid: number }
  | { kind: 'count' }
  | { kind: 'acl' }
  | { kind: 'defaultAcl' };

const field = (name: string, typeOid: number, typeSize: number): FieldDescription => ({ name, typeOid, typeSize });
const text = (name: string) => field(name, OID.text, -1);
const oidField = (name: string) => field(name, OID.oid, 4);
const bool = (name: string) => field(name, OID.bool, 1);
const int4 = (name: string) => field(name, OID.int4, 4);
const int8 = (name: string) => field(name, OID.int8, 8);

/**
 * Recognize pgAdmin schema-browser queries before generic pg_catalog handling.
 * These queries are PostgreSQL-specific but their object list/properties are
 * backed by live IBM i QSYS2.SYSSCHEMAS data.
 */
export function classifyPgAdminIbmiSchemaQuery(sql: string): PgAdminIbmiSchemaRequest | undefined {
  const s = compact(sql);
  const primaryNamespace = primaryFromPgNamespace(s);
  const defaultAcl = /\bpg_default_acl\b/i.test(s);
  if (!primaryNamespace && !defaultAcl) return undefined;

  // ACL/default-ACL queries must be recognized before pg_roles or pg_namespace
  // generic handlers because pgAdmin requires exact dictionary keys.
  if (/\bpg_default_acl\b/i.test(s) && /\b(?:grantor|grantee|privileges|grantable)\b/i.test(s)) {
    return { kind: 'defaultAcl' };
  }
  if (/\b(?:aclexplode|nspacl)\b/i.test(s) && /\b(?:grantor|grantee|privileges|grantable)\b/i.test(s)) {
    return { kind: 'acl' };
  }

  if (primaryNamespace && /\bnsptyp\b/i.test(s) && /\bnamespaceowner\b/i.test(s)) {
    const oid = extractOidPredicate(s);
    // properties.sql imports CATALOGS.LIST, whose nested predicates include
    // nspname='pg_catalog'.  When pgAdmin supplies scid, that numeric OID is
    // authoritative; never let a macro predicate override it.
    return {
      kind: 'properties',
      oid,
      name: oid === undefined ? extractNamePredicate(s) : undefined,
    };
  }

  if (primaryNamespace && /\bas\s+schema_name\b/i.test(s) && /\bas\s+is_catalog\b/i.test(s) && /\bas\s+db_support\b/i.test(s)) {
    const oid = extractOidPredicate(s);
    if (oid !== undefined) return { kind: 'isCatalog', oid };
  }

  if (primaryNamespace && /\bcount\s*\(\s*\*\s*\)/i.test(s)) return { kind: 'count' };

  // pgAdmin nodes.sql starts with SELECT nsp.oid and its CATALOGS.LIST macro
  // contains nspname='pg_catalog'. It must be recognized before the narrow
  // OID-by-name lookup below or the whole schema list is mistaken for a lookup
  // of PG_CATALOG and pgAdmin silently renders an empty Schemas collection.
  if (primaryNamespace && /\bhas_schema_privilege\s*\(/i.test(s) && /\bas\s+can_create\b/i.test(s) && /\bas\s+has_usage\b/i.test(s)) {
    return { kind: 'nodes' };
  }

  // Post-create/simple lookup only: require OID to be the sole top-level select
  // item immediately followed by FROM pg_namespace. This deliberately excludes
  // pgAdmin nodes.sql, which selects several columns and embeds pg_catalog in a
  // nested catalog-exclusion macro.
  if (primaryNamespace && /^select\s+(?:[a-z_][a-z0-9_$]*\.)?oid\s+from\s+(?:pg_catalog\.)?pg_namespace\b/i.test(s)
      && /\bnspname\s*=\s*'/i.test(s)) {
    const name = extractNamePredicate(s);
    if (name !== undefined) return { kind: 'oidByName', name };
  }

  if (primaryNamespace && /^select\s+(?:[a-z_][a-z0-9_$]*\.)?nspname\s+from\s+(?:pg_catalog\.)?pg_namespace\b/i.test(s)
      && /\boid\s*=\s*\d+/i.test(s)) {
    const oid = extractOidPredicate(s);
    if (oid !== undefined) return { kind: 'nameByOid', oid };
  }

  return undefined;
}

export function renderPgAdminIbmiSchemaQuery(
  request: PgAdminIbmiSchemaRequest,
  allSchemas: IbmiSchemaRow[],
  context: PgAdminIbmiContext,
): SyntheticResult {
  const schemas = visibleSchemas(allSchemas, context.hideSystemSchemas);

  if (request.kind === 'acl') {
    return {
      fields: [text('deftype'), text('grantee'), text('grantor'), text('privileges'), text('grantable')],
      rows: [],
      tag: 'SELECT 0',
    };
  }
  if (request.kind === 'defaultAcl') {
    return {
      fields: [text('deftype'), text('grantee'), text('grantor'), text('privileges'), text('grantable')],
      rows: [],
      tag: 'SELECT 0',
    };
  }
  if (request.kind === 'count') {
    return { fields: [int8('count')], rows: [[schemas.length]], tag: 'SELECT 1' };
  }
  if (request.kind === 'nodes') {
    return {
      fields: [oidField('oid'), text('name'), bool('can_create'), bool('has_usage'), text('description')],
      rows: schemas.map((schema) => [schemaOid(schema.name), schema.name, true, true, schema.text]),
      tag: `SELECT ${schemas.length}`,
    };
  }

  const target = request.kind === 'oidByName'
    ? findByName(allSchemas, request.name)
    : request.kind === 'nameByOid' || request.kind === 'isCatalog'
      ? findByOid(allSchemas, request.oid)
      : request.kind === 'properties' && request.oid !== undefined
        ? findByOid(allSchemas, request.oid)
        : request.kind === 'properties' && request.name !== undefined
          ? findByName(allSchemas, request.name)
          : undefined;

  if (request.kind === 'oidByName') {
    return { fields: [oidField('oid')], rows: target ? [[schemaOid(target.name)]] : [], tag: target ? 'SELECT 1' : 'SELECT 0' };
  }
  if (request.kind === 'nameByOid') {
    return { fields: [text('nspname')], rows: target ? [[target.name]] : [], tag: target ? 'SELECT 1' : 'SELECT 0' };
  }
  if (request.kind === 'isCatalog') {
    return {
      fields: [text('schema_name'), bool('is_catalog'), bool('db_support')],
      rows: target ? [[target.name, isPostgresCatalogName(target.name), true]] : [],
      tag: target ? 'SELECT 1' : 'SELECT 0',
    };
  }

  if (request.kind === 'properties') {
    const propertyFields = [
      int4('nsptyp'), text('name'), oidField('oid'), text('acl'), text('namespaceowner'),
      text('description'), bool('can_create'), text('tblacl'), text('seqacl'), text('funcacl'),
      text('typeacl'), text('seclabels'),
    ];

    // pgAdmin uses the same properties.sql both for a single schema and for
    // SchemaView.list().  With no OID/name predicate it expects one complete
    // property row for every visible schema, not just current_schema.
    const propertySchemas = request.oid !== undefined || request.name !== undefined
      ? (target ? [target] : [])
      : schemas;
    const rows = propertySchemas.map((schema) => propertyRow(schema, context.user));
    return {
      fields: propertyFields,
      rows,
      tag: `SELECT ${rows.length}`,
    };
  }

  return { fields: [], rows: [], tag: 'SELECT 0' };
}


function propertyRow(schema: IbmiSchemaRow, virtualOwner: string): unknown[] {
  return [
    schemaType(schema.name), schema.name, schemaOid(schema.name), null,
    // PostgreSQL ownership is virtual. The real Db2 schema is owned according
    // to IBM i CREATE SCHEMA semantics under the Mapepire service profile.
    virtualOwner, schema.text, true, null, null, null, null, null,
  ];
}

/** Stable positive PostgreSQL-style OID derived from the IBM i SQL schema name. */
export function schemaOid(name: string): number {
  // FNV-1a 32-bit over UTF-16 code units, then constrain to a positive
  // non-system range. Schema names in the normal IBM i / pgAdmin path are
  // ASCII-compatible identifiers; hashing code units avoids a runtime
  // TextEncoder dependency while remaining deterministic across platforms.
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    hash ^= code & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (code >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 100_000 + (hash % 2_000_000_000);
}

/** Legacy row-number OID emitted by the pre-0.1.8 pg_namespace translator. */
export function legacySchemaOid(rows: IbmiSchemaRow[], name: string): number | undefined {
  const ordered = [...rows].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const index = ordered.findIndex((row) => sameIdentifier(row.name, name));
  return index >= 0 ? 50_001 + index : undefined;
}

/** Resolve both current stable OIDs and legacy browser-node OIDs. */
export function findSchemaByCompatibleOid(rows: IbmiSchemaRow[], oid: number): IbmiSchemaRow | undefined {
  const stable = rows.find((row) => schemaOid(row.name) === oid);
  if (stable) return stable;
  return rows.find((row) => legacySchemaOid(rows, row.name) === oid);
}

export interface CreateSchemaPlan {
  schemaName: string;
  db2Sql: string;
  ifNotExists: boolean;
  requestedAuthorization?: string;
}

/**
 * Translate the PostgreSQL CREATE SCHEMA form emitted by pgAdmin into Db2 for
 * i semantics. The PG AUTHORIZATION role is deliberately not sent to IBM i:
 * all backend work runs as the configured service profile.
 */
export function planPgCreateSchema(sql: string): CreateSchemaPlan | undefined {
  const ident = `(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$#@]*)`;
  const named = new RegExp(
    `^\\s*CREATE\\s+SCHEMA\\s+(IF\\s+NOT\\s+EXISTS\\s+)?(${ident})(?:\\s+AUTHORIZATION\\s+(${ident}|CURRENT_USER|CURRENT_ROLE|SESSION_USER))?\\s*;?\\s*$`,
    'i',
  ).exec(sql);
  if (named) {
    const schemaName = decodeIdentifier(named[2]!);
    const requestedAuthorization = named[3] ? decodeAuthorization(named[3]) : undefined;
    return {
      schemaName,
      db2Sql: `CREATE SCHEMA ${quoteDb2Identifier(schemaName)}`,
      ifNotExists: Boolean(named[1]),
      requestedAuthorization,
    };
  }

  const authOnly = new RegExp(
    `^\\s*CREATE\\s+SCHEMA\\s+(IF\\s+NOT\\s+EXISTS\\s+)?AUTHORIZATION\\s+(${ident}|CURRENT_USER|CURRENT_ROLE|SESSION_USER)\\s*;?\\s*$`,
    'i',
  ).exec(sql);
  if (authOnly) {
    const authorization = decodeAuthorization(authOnly[2]!);
    if (/^(?:CURRENT_USER|CURRENT_ROLE|SESSION_USER)$/i.test(authorization)) return undefined;
    return {
      schemaName: authorization,
      db2Sql: `CREATE SCHEMA ${quoteDb2Identifier(authorization)}`,
      ifNotExists: Boolean(authOnly[1]),
      requestedAuthorization: authorization,
    };
  }
  return undefined;
}

export function isPgSchemaComment(sql: string): boolean {
  return /^\s*COMMENT\s+ON\s+SCHEMA\b/i.test(sql);
}

export function isPgSchemaPrivilegeDdl(sql: string): boolean {
  return /^\s*(?:GRANT|REVOKE)\b[\s\S]*\bON\s+SCHEMA\b/i.test(sql)
    || /^\s*ALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(sql)
    || /^\s*SECURITY\s+LABEL\s+ON\s+SCHEMA\b/i.test(sql);
}

function visibleSchemas(rows: IbmiSchemaRow[], hideSystemSchemas: boolean): IbmiSchemaRow[] {
  return [...rows]
    .filter((row) => !hideSystemSchemas || !isHiddenIbmiSystemSchema(row.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * IBM i ships many system schemas/libraries beginning Q* and SYS*. pgAdmin is
 * much easier to navigate when those are hidden by default, while the filter
 * can be disabled entirely through PGADMIN_HIDE_SYSTEM_SCHEMAS=false.
 */
export function isHiddenIbmiSystemSchema(name: string): boolean {
  const n = name.toUpperCase();
  return n.startsWith('Q') || n.startsWith('SYS') || n === 'INFORMATION_SCHEMA';
}

function isPostgresCatalogName(name: string): boolean {
  const n = name.toLowerCase();
  return n === 'pg_catalog' || n === 'information_schema' || n.startsWith('pg_toast') || n.startsWith('pg_temp_');
}

function schemaType(name: string): number {
  const n = name.toLowerCase();
  if (n.startsWith('pg_temp_')) return 1;
  if (n.startsWith('pg_toast_temp_')) return 2;
  return 3;
}

function findByName(rows: IbmiSchemaRow[], name: string): IbmiSchemaRow | undefined {
  return rows.find((row) => sameIdentifier(row.name, name));
}

function findByOid(rows: IbmiSchemaRow[], oid: number): IbmiSchemaRow | undefined {
  return rows.find((row) => schemaOid(row.name) === oid);
}

function sameIdentifier(a: string, b: string): boolean {
  return a === b || a.toUpperCase() === b.toUpperCase();
}

function extractNamePredicate(sql: string): string | undefined {
  const m = sql.match(/\bnspname\s*=\s*'((?:''|[^'])*)'/i);
  return m?.[1]?.replaceAll("''", "'");
}

function extractOidPredicate(sql: string): number | undefined {
  const patterns = [
    /\bnsp\s*\.\s*oid\s*=\s*(\d+)/i,
    /\bnspoid\s*=\s*(\d+)/i,
    /\boid\s*=\s*(\d+)/i,
    /\bnsp\s*\.\s*oid\s*=\s*'?(\d+)'?(?:::\s*oid)?/i,
  ];
  for (const pattern of patterns) {
    const m = sql.match(pattern);
    if (m) return Number(m[1]);
  }
  return undefined;
}

function decodeIdentifier(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).replaceAll('""', '"');
  // The proxy's documented Db2 policy upper-cases unquoted relation/schema
  // identifiers. Keep CREATE SCHEMA consistent with normal SQL translation:
  // quoted PostgreSQL names preserve case; unquoted names become IBM i SQL
  // ordinary identifiers (upper-case).
  return trimmed.toUpperCase();
}

function decodeAuthorization(raw: string): string {
  return decodeIdentifier(raw);
}

function quoteDb2Identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function primaryFromPgNamespace(sql: string): boolean {
  // pgAdmin schema count/nodes/properties templates all use pg_namespace as
  // their top-level FROM relation. Nested pg_namespace references in table or
  // other catalog queries must not be mistaken for schema-browser requests.
  return /\bfrom\s+(?:pg_catalog\.)?pg_namespace(?:\s+(?:as\s+)?[a-z_][a-z0-9_$]*)?/i.test(sql);
}

function compact(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\r\n]*/g, ' ').replace(/\s+/g, ' ').trim().replace(/;+$/, '').trim();
}
