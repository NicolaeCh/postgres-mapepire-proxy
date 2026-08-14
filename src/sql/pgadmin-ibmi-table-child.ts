import { db2TypeToPg, OID } from '../postgres/oids.js';
import type { FieldDescription } from '../postgres/wire.js';
import type { SyntheticResult } from './environment.js';

export interface IbmiColumnRow {
  schema: string;
  table: string;
  name: string;
  ordinal: number;
  dataType: string;
  length: number | null;
  numericScale: number | null;
  numericPrecision: number | null;
  nullable: boolean;
  longComment: string | null;
  text: string | null;
  hasDefault: string;
  defaultValue: string | null;
  charMaxLength: number | null;
  datetimePrecision: number | null;
  identity: boolean;
  identityGeneration: string | null;
  expression: string | null;
}

export interface IbmiIndexRow {
  schema: string;
  table: string;
  indexSchema: string;
  name: string;
  owner: string;
  unique: boolean;
  columnCount: number;
  longComment: string | null;
  text: string | null;
  columns: string[];
  filterDefinition: string | null;
}

export const IBMI_COLUMN_CATALOG_SQL = `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION,
       DATA_TYPE, LENGTH, NUMERIC_SCALE, NUMERIC_PRECISION, IS_NULLABLE,
       LONG_COMMENT, COLUMN_TEXT, HAS_DEFAULT, COLUMN_DEFAULT,
       CHARACTER_MAXIMUM_LENGTH, DATETIME_PRECISION, IS_IDENTITY,
       IDENTITY_GENERATION, COLUMN_EXPRESSION
  FROM QSYS2.SYSCOLUMNS2
 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
 ORDER BY ORDINAL_POSITION`;

export const IBMI_INDEX_CATALOG_SQL = `SELECT I.INDEX_SCHEMA, I.INDEX_NAME, I.INDEX_OWNER, I.TABLE_SCHEMA, I.TABLE_NAME,
       I.IS_UNIQUE, I.COLUMN_COUNT, I.LONG_COMMENT, I.INDEX_TEXT,
       S.COLUMN_NAMES, S.SEARCH_CONDITION
  FROM QSYS2.SYSINDEXES I
  LEFT JOIN QSYS2.SYSTABLEINDEXSTAT S
    ON S.INDEX_SCHEMA = I.INDEX_SCHEMA
   AND S.INDEX_NAME = I.INDEX_NAME
   AND S.TABLE_SCHEMA = I.TABLE_SCHEMA
   AND S.TABLE_NAME = I.TABLE_NAME
   AND S.INDEX_TYPE = 'INDEX'
 WHERE I.TABLE_SCHEMA = ? AND I.TABLE_NAME = ?
 ORDER BY I.INDEX_NAME`;

/**
 * QSYS2.SYSINDEXES is SQL CREATE INDEX metadata.  When it is empty,
 * SYSTABLEINDEXSTAT is the broader IBM i table-index service: it reports SQL
 * indexes, DDS logical-file access paths, and constraint-maintained access
 * paths.  pgAdmin has separate constraint collections, so expose only INDEX
 * and LOGICAL rows below its Indexes collection.
 */
export const IBMI_NATIVE_INDEX_CATALOG_SQL = `SELECT INDEX_SCHEMA, INDEX_NAME,
       CAST('' AS VARCHAR(128)) AS INDEX_OWNER,
       TABLE_SCHEMA, TABLE_NAME,
       CASE WHEN UNIQUE IN ('0', '1') THEN 'U' ELSE 'D' END AS IS_UNIQUE,
       NUMBER_KEY_COLUMNS AS COLUMN_COUNT,
       CAST(NULL AS VARCHAR(2000)) AS LONG_COMMENT,
       CAST(INDEX_TYPE CONCAT CASE WHEN COLUMN_NAMES IS NULL OR COLUMN_NAMES = ''
             THEN '' ELSE ': ' CONCAT COLUMN_NAMES END AS VARCHAR(2000)) AS INDEX_TEXT,
       COLUMN_NAMES, SEARCH_CONDITION
  FROM QSYS2.SYSTABLEINDEXSTAT
 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
   AND INDEX_TYPE IN ('INDEX', 'LOGICAL')
 ORDER BY INDEX_NAME`;

export type PgAdminTableChildRequest =
  | { kind: 'columnCount'; tableOid: number }
  | { kind: 'columnNodes'; tableOid: number; columnNumber?: number }
  | { kind: 'columnProperties'; tableOid: number; columnNumber?: number }
  | { kind: 'indexCount'; tableOid: number }
  | { kind: 'indexNodes'; tableOid: number; indexOid?: number }
  | { kind: 'indexProperties'; tableOid: number; indexOid?: number }
  | { kind: 'partitionNodes'; tableOid: number }
  | { kind: 'emptyTableChild'; tableOid?: number; family: 'triggers' | 'rules' | 'policies' | 'partitions' };

const field = (name: string, typeOid: number, typeSize: number): FieldDescription => ({ name, typeOid, typeSize });
const text = (name: string) => field(name, OID.text, -1);
const oid = (name: string) => field(name, OID.oid, 4);
const bool = (name: string) => field(name, OID.bool, 1);
const int4 = (name: string) => field(name, OID.int4, 4);
const int8 = (name: string) => field(name, OID.int8, 8);

/**
 * pgAdmin table child collections are PostgreSQL-system catalog queries. They
 * must be recognized before generic translation because casts such as
 * <tableOid>::OID have no Db2 for i equivalent and otherwise reach Db2 as an
 * attempted user-defined type named OID.
 */
export function classifyPgAdminTableChildQuery(sql: string): PgAdminTableChildRequest | undefined {
  const s = compact(sql);

  if (/\b(?:pg_catalog\.)?pg_attribute\b/i.test(s)) {
    const tableOid = extractNumeric(s, [
      /\batt\s*\.\s*attrelid\s*=\s*'?([0-9]+)'?(?:::\s*oid)?/i,
      /\battrelid\s*=\s*'?([0-9]+)'?(?:::\s*oid)?/i,
    ]);
    if (tableOid !== undefined) {
      // PGChildModule.has_nodes() executes count.sql before pgAdmin creates the
      // Columns collection in the tree.  This request must return a scalar
      // count, not an empty generic pg_catalog result.
      if (/^select\s+count\s*\(/i.test(s)) return { kind: 'columnCount', tableOid };

      const columnNumber = extractNumeric(s, [
        /\batt\s*\.\s*attnum\s*=\s*'?([0-9]+)'?/i,
        /\battnum\s*=\s*'?([0-9]+)'?/i,
      ]);

      // pgAdmin 9.16+ rebased the Columns nodes template and the NODES query
      // itself now references att.attidentity while calculating
      // has_default_val.  Therefore attidentity is NOT a safe properties
      // discriminator.  The stable nodes contract explicitly projects
      // att.attnum AS oid and has_default_val; recognize that contract first.
      const isNodesContract = /\batt\s*\.\s*attnum\s+as\s+oid\b/i.test(s)
        || /\bhas_default_val\b/i.test(s);
      if (isNodesContract) return { kind: 'columnNodes', tableOid, columnNumber };

      // Properties contains the wide attribute/type payload used by the
      // properties panel.  These markers do not occur in pgAdmin's nodes.sql.
      if (/\bcolconstype\b/i.test(s) || /\bis_view_only\b/i.test(s)
          || /\battcompression\b/i.test(s) || /\battndims\b/i.test(s)
          || /\batttypid\b/i.test(s)) {
        return { kind: 'columnProperties', tableOid, columnNumber };
      }

      // Once scoped to a concrete parent OID, default to nodes. This is safer
      // for browser compatibility because pgAdmin's nodes() Python path
      // requires an `oid` key for every returned row.
      return { kind: 'columnNodes', tableOid, columnNumber };
    }
  }

  if (/\b(?:pg_catalog\.)?pg_index\b/i.test(s)) {
    const tableOid = extractNumeric(s, [
      /\bindrelid\s*=\s*'?([0-9]+)'?(?:::\s*oid)?/i,
      /\bidx\s*\.\s*indrelid\s*=\s*'?([0-9]+)'?(?:::\s*oid)?/i,
    ]);
    if (tableOid !== undefined) {
      // IndexesModule is also hidden until its count.sql/has_nodes() request
      // returns a non-zero scalar.
      if (/^select\s+count\s*\(/i.test(s)) return { kind: 'indexCount', tableOid };

      const indexOid = extractNumeric(s, [
        /\bcls\s*\.\s*oid\s*=\s*'?([0-9]+)'?(?:::\s*oid)?/i,
        /\bindexrelid\s*=\s*'?([0-9]+)'?(?:::\s*oid)?/i,
      ]);
      if (/\bindisclustered\b/i.test(s) || /\bindnatts\b/i.test(s) || /\bamname\b/i.test(s)) {
        return { kind: 'indexProperties', tableOid, indexOid };
      }
      return { kind: 'indexNodes', tableOid, indexOid };
    }
  }

  // IBM i table partitioning is not modeled as PostgreSQL pg_inherits child
  // relations. Return an exact empty pgAdmin node contract instead.
  if (/\b(?:pg_catalog\.)?pg_inherits\b/i.test(s)
      && (/\bschema_id\b/i.test(s) || /\btriggercount\b/i.test(s) || /\binhparent\b/i.test(s))) {
    const tableOid = extractNumeric(s, [
      /\binhparent\s*=\s*'?([0-9]+)'?(?:::\s*oid)?/i,
      /\bparentrelid\s*=\s*'?([0-9]+)'?(?:::\s*oid)?/i,
      /\brel\s*\.\s*oid\s*=\s*'?([0-9]+)'?(?:::\s*oid)?/i,
    ]);
    if (tableOid !== undefined) return { kind: 'partitionNodes', tableOid };
  }

  // PostgreSQL-only table children which do not have a direct IBM i browser
  // equivalent. Returning no nodes is safer than generic projection because
  // pgAdmin indexes fixed dictionary keys when rows exist.
  const family = /\b(?:pg_catalog\.)?pg_trigger\b/i.test(s) ? 'triggers'
    : /\b(?:pg_catalog\.)?pg_rewrite\b/i.test(s) ? 'rules'
      : /\b(?:pg_catalog\.)?pg_policy\b/i.test(s) ? 'policies'
        : undefined;
  if (family) {
    const tableOid = extractNumeric(s, [
      /\btgrelid\s*=\s*'?([0-9]+)'?(?:::\s*oid)?/i,
      /\bev_class\s*=\s*'?([0-9]+)'?(?:::\s*oid)?/i,
      /\bpolrelid\s*=\s*'?([0-9]+)'?(?:::\s*oid)?/i,
    ]);

    // A real pgAdmin child collection is always scoped to a concrete parent
    // table OID. Normal Tables nodes/properties SQL also contains nested
    // pg_trigger subqueries (for trigger counts), but those predicates use
    // tgrelid=rel.oid rather than a numeric OID. Do not steal the parent table
    // request merely because one of those nested PostgreSQL catalogs appears.
    if (tableOid !== undefined) return { kind: 'emptyTableChild', tableOid, family };
  }

  return undefined;
}

export function renderColumnQuery(request: Extract<PgAdminTableChildRequest, {kind: 'columnCount' | 'columnNodes' | 'columnProperties'}>, rows: IbmiColumnRow[]): SyntheticResult {
  if (request.kind === 'columnCount') {
    return { fields: [int8('count')], rows: [[rows.length]], tag: 'SELECT 1' };
  }
  const selected = request.columnNumber === undefined ? rows : rows.filter((r) => r.ordinal === request.columnNumber);
  if (request.kind === 'columnNodes') {
    return {
      fields: [text('name'), int4('oid'), text('datatype'), text('displaytypname'), bool('not_null'), bool('has_default_val'), text('description'), oid('seqtypid')],
      rows: selected.map((r) => [r.name, r.ordinal, displayType(r), displayType(r), !r.nullable, hasDefault(r), r.longComment ?? r.text, 0]),
      tag: `SELECT ${selected.length}`,
    };
  }

  const fields: FieldDescription[] = [
    text('name'), oid('atttypid'), int4('attlen'), int4('attnum'), int4('attndims'), int4('atttypmod'), text('attacl'),
    bool('attnotnull'), text('attoptions'), text('attfdwoptions'), int4('attstattarget'), text('attstorage'), text('attidentity'),
    text('defval'), text('typname'), text('displaytypname'), text('cltype'), text('inheritedfrom'), oid('inheritedid'), oid('elemoid'),
    text('typnspname'), text('defaultstorage'), text('description'), text('indkey'), bool('isdup'), text('collspcname'), bool('is_fk'),
    text('seclabels'), bool('is_sys_column'), text('colconstype'), text('genexpr'), text('relname'), bool('is_view_only'), text('attcompression'),
    oid('defseqrelid'), text('seqtypid'), text('seqstart'), text('seqincrement'), text('seqmin'), text('seqmax'), text('seqcache'), bool('seqcycle'),
  ];
  return {
    fields,
    rows: selected.map((r) => {
      const pg = db2TypeToPg(normalizeDb2Type(r.dataType), r.numericPrecision ?? 0);
      return [
        r.name, pg.oid, r.length ?? pg.size, r.ordinal, 0, -1, null,
        !r.nullable, null, null, -1, 'p', r.identity ? (r.identityGeneration?.toUpperCase() === 'ALWAYS' ? 'a' : 'd') : '',
        r.defaultValue, pg.name, displayType(r), null, null, 0, 0,
        'pg_catalog', 'p', r.longComment ?? r.text, null, false, null, false,
        null, false, null, r.expression, r.table, false, null,
        0, null, null, null, null, null, null, false,
      ];
    }),
    tag: `SELECT ${selected.length}`,
  };
}

export function renderIndexQuery(request: Extract<PgAdminTableChildRequest, {kind: 'indexCount' | 'indexNodes' | 'indexProperties'}>, rows: IbmiIndexRow[], tableOidValue: number): SyntheticResult {
  if (request.kind === 'indexCount') {
    return { fields: [int8('count')], rows: [[rows.length]], tag: 'SELECT 1' };
  }
  const selected = request.indexOid === undefined ? rows : rows.filter((r) => indexOid(r.schema, r.table, r.name) === request.indexOid);
  if (request.kind === 'indexNodes') {
    return {
      fields: [oid('oid'), text('name'), bool('is_inherited'), text('description')],
      rows: selected.map((r) => [indexOid(r.schema, r.table, r.name), r.name, false, r.longComment ?? r.text]),
      tag: `SELECT ${selected.length}`,
    };
  }

  const fields = [
    oid('oid'), text('name'), oid('indrelid'), text('indkey'), bool('indisclustered'), bool('indisvalid'), bool('indisunique'),
    bool('indisprimary'), text('nspname'), int4('indnatts'), oid('spcoid'), text('spcname'), text('conname'), text('tabname'),
    text('indclass'), oid('conoid'), text('description'), text('dependsonextensions'), bool('indconstraint'), text('contype'),
    bool('condeferrable'), bool('condeferred'), text('amname'), bool('is_inherited'), text('fillfactor'), text('deduplicate_items'),
    text('gin_pending_list_limit'), text('pages_per_range'), text('buffering'), text('fastupdate'), text('autosummarize'), text('lists'),
  ];
  return {
    fields,
    rows: selected.map((r) => [
      indexOid(r.schema, r.table, r.name), r.name, tableOidValue, null, false, true, r.unique,
      false, r.indexSchema, r.columnCount, 0, 'pg_default', null, r.table,
      null, 0, r.longComment ?? r.text, null, false, null,
      false, false, 'btree', false, null, null,
      null, null, null, null, null, null,
    ]),
    tag: `SELECT ${selected.length}`,
  };
}

export function renderEmptyTableChild(request: Extract<PgAdminTableChildRequest, {kind: 'partitionNodes' | 'emptyTableChild'}>): SyntheticResult {
  if (request.kind === 'partitionNodes') {
    return {
      fields: [oid('oid'), text('name'), int8('triggercount'), int8('has_enable_triggers'), bool('is_partitioned'), oid('schema_id'), text('schema_name'), text('description'), bool('inhdetachpending')],
      rows: [], tag: 'SELECT 0',
    };
  }
  // Empty rows are enough for pgAdmin's Rules/Triggers/RLS collections; no row
  // means its Python browser code never indexes relation-specific keys.
  return { fields: [oid('oid'), text('name')], rows: [], tag: 'SELECT 0' };
}

export function indexOid(schema: string, table: string, index: string): number {
  let hash = 0x811c9dc5;
  const input = `I:${schema}\u0000${table}\u0000${index}`;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    hash ^= code & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (code >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 1_900_000_000 + (hash % 100_000_000);
}

function hasDefault(row: IbmiColumnRow): boolean {
  return row.hasDefault.toUpperCase() !== 'N';
}

function normalizeDb2Type(type: string): string {
  const t = type.toUpperCase();
  if (t === 'TIMESTMP') return 'TIMESTAMP';
  if (t === 'VARG') return 'VARCHAR';
  if (t === 'VARBIN') return 'VARBINARY';
  return t;
}

function displayType(row: IbmiColumnRow): string {
  const t = row.dataType.toUpperCase();
  if (t === 'DECIMAL' || t === 'NUMERIC') {
    return row.numericPrecision != null
      ? `${t.toLowerCase()}(${row.numericPrecision}${row.numericScale != null ? `,${row.numericScale}` : ''})`
      : t.toLowerCase();
  }
  if (t === 'CHAR') return `character(${row.charMaxLength ?? row.length ?? 1})`;
  if (t === 'VARCHAR') return `character varying(${row.charMaxLength ?? row.length ?? 1})`;
  if (t === 'BINARY') return `bytea`;
  if (t === 'VARBIN' || t === 'BLOB') return 'bytea';
  if (t === 'CLOB' || t === 'DBCLOB' || t === 'GRAPHIC' || t === 'VARG' || t === 'XML') return 'text';
  if (t === 'TIMESTMP') return row.datetimePrecision && row.datetimePrecision > 0 ? `timestamp(${row.datetimePrecision})` : 'timestamp';
  if (t === 'INTEGER') return 'integer';
  if (t === 'SMALLINT') return 'smallint';
  if (t === 'BIGINT') return 'bigint';
  if (t === 'FLOAT') return row.length === 4 ? 'real' : 'double precision';
  if (t === 'DECFLOAT') return 'numeric';
  return t.toLowerCase();
}

function extractNumeric(sql: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = sql.match(pattern);
    if (match?.[1]) return Number(match[1]);
  }
  return undefined;
}

function compact(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\r\n]*/g, ' ').replace(/\s+/g, ' ').trim().replace(/;+$/, '').trim();
}
