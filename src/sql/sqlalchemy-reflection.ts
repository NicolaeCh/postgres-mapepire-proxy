import { OID } from '../postgres/oids.js';
import type { FieldDescription } from '../postgres/wire.js';
import type { SyntheticResult } from './environment.js';
import type { IbmiColumnRow, IbmiIndexRow } from './pgadmin-ibmi-table-child.js';
import type { IbmiTableRow } from './pgadmin-ibmi-table.js';

export type SqlAlchemyReflectionRequest =
  | { kind: 'relationNames' }
  | { kind: 'hasRelation' }
  | { kind: 'relationOids' }
  | { kind: 'relationOidByName' }
  | { kind: 'columns' }
  | { kind: 'indexes' }
  | { kind: 'foreignKeys' }
  | { kind: 'checkConstraints' }
  | { kind: 'tableComments' }
  | { kind: 'keyConstraints' };

export interface IbmiForeignKeyRow {
  constraintSchema: string;
  constraintName: string;
  tableSchema: string;
  tableName: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
  updateRule: string | null;
  deleteRule: string | null;
}

export interface IbmiKeyConstraintRow {
  constraintSchema: string;
  constraintName: string;
  constraintType: 'PRIMARY KEY' | 'UNIQUE';
  tableSchema: string;
  tableName: string;
  columns: string[];
}

export const IBMI_FOREIGN_KEY_CATALOG_SQL = `SELECT FK.CONSTRAINT_SCHEMA, FK.CONSTRAINT_NAME,
       FK.TABLE_SCHEMA, FK.TABLE_NAME,
       FKC.COLUMN_NAME AS FK_COLUMN, FKC.ORDINAL_POSITION,
       PK.TABLE_SCHEMA AS REFERENCED_TABLE_SCHEMA,
       PK.TABLE_NAME AS REFERENCED_TABLE_NAME,
       PKC.COLUMN_NAME AS REFERENCED_COLUMN,
       R.UPDATE_RULE, R.DELETE_RULE
  FROM QSYS2.SYSCST FK
  JOIN QSYS2.SYSREFCST R
    ON R.CONSTRAINT_SCHEMA = FK.CONSTRAINT_SCHEMA
   AND R.CONSTRAINT_NAME = FK.CONSTRAINT_NAME
  JOIN QSYS2.SYSKEYCST FKC
    ON FKC.CONSTRAINT_SCHEMA = FK.CONSTRAINT_SCHEMA
   AND FKC.CONSTRAINT_NAME = FK.CONSTRAINT_NAME
  LEFT JOIN QSYS2.SYSCST PK
    ON PK.CONSTRAINT_SCHEMA = R.UNIQUE_CONSTRAINT_SCHEMA
   AND PK.CONSTRAINT_NAME = R.UNIQUE_CONSTRAINT_NAME
  LEFT JOIN QSYS2.SYSKEYCST PKC
    ON PKC.CONSTRAINT_SCHEMA = PK.CONSTRAINT_SCHEMA
   AND PKC.CONSTRAINT_NAME = PK.CONSTRAINT_NAME
   AND PKC.ORDINAL_POSITION = FKC.ORDINAL_POSITION
 WHERE FK.CONSTRAINT_TYPE = 'FOREIGN KEY'
   AND FK.TABLE_SCHEMA = ? AND FK.TABLE_NAME = ?
 ORDER BY FK.CONSTRAINT_NAME, FKC.ORDINAL_POSITION`;

export const IBMI_KEY_CONSTRAINT_CATALOG_SQL = `SELECT C.CONSTRAINT_SCHEMA, C.CONSTRAINT_NAME, C.CONSTRAINT_TYPE,
       C.TABLE_SCHEMA, C.TABLE_NAME, K.COLUMN_NAME, K.ORDINAL_POSITION
  FROM QSYS2.SYSCST C
  JOIN QSYS2.SYSKEYCST K
    ON K.CONSTRAINT_SCHEMA = C.CONSTRAINT_SCHEMA
   AND K.CONSTRAINT_NAME = C.CONSTRAINT_NAME
 WHERE C.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE')
   AND C.TABLE_SCHEMA = ? AND C.TABLE_NAME = ?
 ORDER BY C.CONSTRAINT_NAME, K.ORDINAL_POSITION`;

const field = (name: string, typeOid: number, typeSize: number): FieldDescription => ({ name, typeOid, typeSize });
const text = (name: string) => field(name, OID.text, -1);
const nameField = (name: string) => field(name, OID.name, 64);
const oid = (name: string) => field(name, OID.oid, 4);
const bool = (name: string) => field(name, OID.bool, 1);
const int2 = (name: string) => field(name, OID.int2, 2);
const int4 = (name: string) => field(name, OID.int4, 4);
const textArray = (name: string) => field(name, OID.textArray, -1);
const nameArray = (name: string) => field(name, OID.nameArray, -1);
const boolArray = (name: string) => field(name, OID.boolArray, -1);
const int2Vector = (name: string) => field(name, OID.int2vector, -1);

/**
 * Recognizes the stable PostgreSQL catalog query families emitted by
 * SQLAlchemy's PostgreSQL dialect (2.x). These must run before the generic
 * pg_catalog firewall, otherwise an empty synthetic result is interpreted as
 * "table/column/index does not exist" by Inspector/Alembic.
 */
export function classifySqlAlchemyReflectionQuery(sql: string): SqlAlchemyReflectionRequest | undefined {
  const s = compact(sql);

  // Primary/unique constraint reflection is the one SQLAlchemy catalog family
  // below that does not select from pg_class directly.
  if (/\b(?:pg_catalog\.)?pg_constraint\b/i.test(s)
      && /\b(?:pg_catalog\.)?pg_index\b/i.test(s)
      && /\barray_agg\s*\(/i.test(s)
      && /\bindnkeyatts\b/i.test(s)
      && /\bconname\b/i.test(s)
      && !/\bpg_get_constraintdef\s*\(/i.test(s)) {
    return { kind: 'keyConstraints' };
  }

  if (!/\b(?:pg_catalog\.)?pg_class\b/i.test(s)) return undefined;

  if (/\b(?:pg_catalog\.)?pg_index\b/i.test(s)
      && /\bindisunique\b/i.test(s)
      && /\bindnkeyatts\b/i.test(s)
      && /\belements(?:_is_expr|_opclass|_opdefault)?\b/i.test(s)) {
    return { kind: 'indexes' };
  }

  if (/\b(?:pg_catalog\.)?pg_constraint\b/i.test(s)
      && /\bpg_get_constraintdef\s*\(/i.test(s)) {
    // SQLAlchemy uses pg_get_constraintdef() for both foreign-key and CHECK
    // reflection. The FK query also resolves confrelid through cls_ref/nsp_ref;
    // the CHECK query does not. Returning the FK five-column shape for CHECK
    // reflection corrupts SQLAlchemy's positional row unpacking.
    if (/\b(?:confrelid|cls_ref|nsp_ref)\b/i.test(s)) return { kind: 'foreignKeys' };
    return { kind: 'checkConstraints' };
  }

  if (/\b(?:pg_catalog\.)?pg_attribute\b/i.test(s)
      && /\bformat_type\s*\(/i.test(s)
      && /\bidentity_options\b/i.test(s)
      && /\btable_name\b/i.test(s)) {
    return { kind: 'columns' };
  }

  if (/^select\s+(?:pg_catalog\.)?pg_class\.oid\s*,\s*(?:pg_catalog\.)?pg_class\.relname\s+from\b/i.test(s)
      && !/\b(?:pg_catalog\.)?pg_(?:attribute|index|constraint)\b/i.test(s)) {
    return { kind: 'relationOids' };
  }

  if (/^select\s+(?:pg_catalog\.)?pg_class\.oid\b/i.test(s)
      && /\b(?:pg_catalog\.)?pg_class\.relname\s*=\s*/i.test(s)
      && !/\b(?:pg_catalog\.)?pg_(?:attribute|index|constraint)\b/i.test(s)) {
    return { kind: 'relationOidByName' };
  }

  // SQLAlchemy table-comment reflection selects exactly
  // (pg_class.relname, pg_description.description). It otherwise has the same
  // pg_class/pg_namespace/relkind skeleton as get_table_names(), so it must be
  // recognized before the generic one-column relationNames family.
  if (/\b(?:pg_catalog\.)?pg_description\b/i.test(s)
      && /\b(?:pg_catalog\.)?pg_description\.description\b/i.test(s)
      && /\b(?:pg_catalog\.)?pg_class\.relname\b/i.test(s)
      && !/\b(?:pg_catalog\.)?pg_constraint\b/i.test(s)) {
    return { kind: 'tableComments' };
  }

  if (/\bselect\b[\s\S]*\b(?:pg_catalog\.)?pg_class\.relname\b/i.test(s)
      && /\b(?:pg_catalog\.)?pg_class\.relname\s*=\s*/i.test(s)
      && /\brelkind\s*=\s*any\s*\(/i.test(s)) {
    return { kind: 'hasRelation' };
  }

  if (/\bselect\b[\s\S]*\b(?:pg_catalog\.)?pg_class\.relname\b/i.test(s)
      && /\brelkind\s*=\s*any\s*\(/i.test(s)
      && /\b(?:pg_catalog\.)?pg_namespace\b/i.test(s)) {
    return { kind: 'relationNames' };
  }

  return undefined;
}

export function pgVisibleIdentifier(identifier: string): string {
  const value = identifier.trim();
  // Db2 folds ordinary unquoted SQL identifiers to upper case; PostgreSQL
  // folds ordinary unquoted identifiers to lower case. Preserve quoted/mixed
  // case names while reversing the common Db2 fold for application objects.
  return value.length > 0 && value === value.toUpperCase() ? value.toLowerCase() : value;
}

export function renderSqlAlchemyRelationNames(rows: IbmiTableRow[]): SyntheticResult {
  const names = rows.map((row) => pgVisibleIdentifier(row.name)).sort((a, b) => a.localeCompare(b));
  return { fields: [nameField('relname')], rows: names.map((name) => [name]), tag: `SELECT ${names.length}` };
}

export function renderSqlAlchemyHasRelation(row: IbmiTableRow | undefined): SyntheticResult {
  return {
    fields: [nameField('relname')],
    rows: row ? [[pgVisibleIdentifier(row.name)]] : [],
    tag: row ? 'SELECT 1' : 'SELECT 0',
  };
}

export function renderSqlAlchemyRelationOids(rows: Array<{ oid: number; name: string }>): SyntheticResult {
  return {
    fields: [oid('oid'), nameField('relname')],
    rows: rows.map((row) => [row.oid, pgVisibleIdentifier(row.name)]),
    tag: `SELECT ${rows.length}`,
  };
}

export function renderSqlAlchemyRelationOid(row: { oid: number; name: string } | undefined): SyntheticResult {
  return {
    fields: [oid('oid')],
    rows: row ? [[row.oid]] : [],
    tag: row ? 'SELECT 1' : 'SELECT 0',
  };
}

export function renderSqlAlchemyColumns(tableName: string, rows: IbmiColumnRow[]): SyntheticResult {
  const fields: FieldDescription[] = [
    nameField('name'), text('format_type'), text('default'), bool('not_null'), nameField('table_name'),
    text('comment'), text('generated'), field('identity_options', OID.json, -1), text('collation'),
  ];
  const pgTable = pgVisibleIdentifier(tableName);
  const data = [...rows].sort((a, b) => a.ordinal - b.ordinal).map((row) => [
    pgVisibleIdentifier(row.name),
    ibmiColumnFormatType(row),
    normalizeReflectedDefault(row),
    !row.nullable,
    pgTable,
    row.longComment ?? row.text,
    row.expression ? 's' : '',
    row.identity ? identityJson(row) : null,
    null,
  ]);
  return { fields, rows: data, tag: `SELECT ${data.length}` };
}

export function renderSqlAlchemyIndexes(
  tableIndexes: Array<{ tableOid: number; indexes: IbmiIndexRow[] }>,
): SyntheticResult {
  const fields: FieldDescription[] = [
    oid('indrelid'), nameField('relname'), bool('indisunique'), bool('has_constraint'), int2Vector('indoption'),
    textArray('reloptions'), nameField('amname'), text('filter_definition'), int2('indnkeyatts'),
    bool('indnullsnotdistinct'), textArray('elements'), boolArray('elements_is_expr'), nameArray('elements_opclass'),
    boolArray('elements_opdefault'),
  ];
  const rows: unknown[][] = [];
  for (const entry of tableIndexes) {
    for (const index of entry.indexes) {
      const columns = index.columns.map(pgVisibleIdentifier);
      // PostgreSQL int2vector has no representation for an unknown key. When
      // IBM i exposes an index header before SYSTABLEINDEXSTAT.COLUMN_NAMES is
      // populated, emitting '' makes psycopg attempt int('') and abort
      // reflection. Omit that incomplete metadata row until its keys resolve.
      if (index.columnCount > 0 && columns.length === 0) continue;
      rows.push([
        entry.tableOid,
        pgVisibleIdentifier(index.name),
        index.unique,
        false,
        columns.map(() => 0).join(' '),
        null,
        'btree',
        index.filterDefinition,
        columns.length,
        false,
        pgTextArray(columns),
        pgBoolArray(columns.map(() => false)),
        pgTextArray(columns.map(() => '')),
        pgBoolArray(columns.map(() => true)),
      ]);
    }
  }
  return { fields, rows, tag: `SELECT ${rows.length}` };
}

export function renderSqlAlchemyTableComments(rows: IbmiTableRow[]): SyntheticResult {
  const fields: FieldDescription[] = [nameField('relname'), text('description')];
  const data = rows.map((row) => [pgVisibleIdentifier(row.name), row.longComment ?? row.text]);
  return { fields, rows: data, tag: `SELECT ${data.length}` };
}

export function renderSqlAlchemyCheckConstraints(tableNames: string[]): SyntheticResult {
  const fields: FieldDescription[] = [
    nameField('relname'), nameField('conname'), text('src'), text('description'),
  ];
  // SQLAlchemy groups this bulk-reflection result by relname. A placeholder
  // row with NULL constraint data tells it that the table was reflected and
  // simply has no CHECK constraints, matching the PostgreSQL outer-join shape.
  const rows = tableNames.map((name) => [pgVisibleIdentifier(name), null, null, null]);
  return { fields, rows, tag: `SELECT ${rows.length}` };
}

export function renderSqlAlchemyForeignKeys(
  tableName: string,
  rows: IbmiForeignKeyRow[],
): SyntheticResult {
  const fields: FieldDescription[] = [
    nameField('relname'), nameField('conname'), text('condef'), nameField('nspname'), text('description'),
  ];
  const pgTable = pgVisibleIdentifier(tableName);
  if (rows.length === 0) {
    return { fields, rows: [[pgTable, null, null, null, null]], tag: 'SELECT 1' };
  }
  const data = rows.map((fk) => [
    pgTable,
    pgVisibleIdentifier(fk.constraintName),
    foreignKeyDefinition(fk),
    pgVisibleIdentifier(fk.referencedSchema),
    null,
  ]);
  return { fields, rows: data, tag: `SELECT ${data.length}` };
}

export function renderSqlAlchemyKeyConstraints(
  tableOid: number,
  tableName: string,
  rows: IbmiKeyConstraintRow[],
  requestedType: 'p' | 'u',
): SyntheticResult {
  const fields: FieldDescription[] = [
    oid('conrelid'), textArray('cols'), nameField('conname'), text('description'), int2('indnkeyatts'), bool('indnullsnotdistinct'),
  ];
  const selected = rows.filter((row) => requestedType === 'p'
    ? row.constraintType === 'PRIMARY KEY'
    : row.constraintType === 'UNIQUE');
  if (selected.length === 0) return { fields, rows: [], tag: 'SELECT 0' };
  const data = selected.map((constraint) => [
    tableOid,
    pgTextArray(constraint.columns.map(pgVisibleIdentifier)),
    pgVisibleIdentifier(constraint.constraintName),
    null,
    constraint.columns.length,
    false,
  ]);
  return { fields, rows: data, tag: `SELECT ${data.length}` };
}

export function requestedConstraintType(parameters: unknown[]): 'p' | 'u' | undefined {
  for (const value of flattenParameterStrings(parameters)) {
    if (value === 'p' || value === 'u') return value;
  }
  return undefined;
}

export function requestedRelationKinds(parameters: unknown[]): Set<string> {
  const out = new Set<string>();
  for (const value of flattenParameterStrings(parameters)) {
    if (['r', 'p', 'f', 'v', 'm'].includes(value)) out.add(value);
  }
  return out;
}

export function requestedObjectNames(parameters: unknown[], available: string[]): string[] {
  const byFold = new Map(available.map((name) => [name.toUpperCase(), name]));
  const selected: string[] = [];
  for (const value of flattenParameterStrings(parameters)) {
    const match = byFold.get(value.toUpperCase());
    if (match && !selected.includes(match)) selected.push(match);
  }
  return selected;
}

export function requestedVirtualOids(parameters: unknown[]): number[] {
  const out = new Set<number>();
  for (const value of parameters) {
    if (typeof value === 'number' && Number.isFinite(value)) out.add(value);
    else if (typeof value === 'bigint') out.add(Number(value));
    else if (typeof value === 'string') {
      for (const token of value.match(/\d+/g) ?? []) {
        const n = Number(token);
        if (Number.isSafeInteger(n)) out.add(n);
      }
    }
  }
  return [...out];
}

function ibmiColumnFormatType(row: IbmiColumnRow): string {
  const t = row.dataType.trim().toUpperCase();
  if (t === 'CHAR') return `character(${row.charMaxLength ?? row.length ?? 1})`;
  if (t === 'VARCHAR' || t === 'VARG') return `character varying(${row.charMaxLength ?? row.length ?? 1})`;
  if (t === 'CLOB' || t === 'DBCLOB' || t === 'GRAPHIC' || t === 'VARGRAPHIC' || t === 'XML') return 'text';
  if (t === 'BLOB' || t === 'BINARY' || t === 'VARBINARY' || t === 'VARBIN') return 'bytea';
  if (t === 'SMALLINT') return 'smallint';
  if (t === 'INTEGER' || t === 'INT') return 'integer';
  if (t === 'BIGINT') return 'bigint';
  if (t === 'DECIMAL' || t === 'NUMERIC') {
    if (row.numericPrecision != null) {
      return `numeric(${row.numericPrecision}${row.numericScale != null ? `,${row.numericScale}` : ''})`;
    }
    return 'numeric';
  }
  if (t === 'DECFLOAT') return 'numeric';
  if (t === 'REAL') return 'real';
  if (t === 'FLOAT' || t === 'DOUBLE' || t === 'DOUBLE PRECISION') return 'double precision';
  if (t === 'BOOLEAN') return 'boolean';
  if (t === 'DATE') return 'date';
  if (t === 'TIME') return 'time without time zone';
  if (t === 'TIMESTAMP' || t === 'TIMESTMP') {
    return row.datetimePrecision != null && row.datetimePrecision > 0
      ? `timestamp(${row.datetimePrecision}) without time zone`
      : 'timestamp without time zone';
  }
  return 'text';
}

function normalizeReflectedDefault(row: IbmiColumnRow): string | null {
  const value = row.defaultValue?.trim();
  if (!value) return null;
  if (row.dataType.trim().toUpperCase() === 'BOOLEAN') {
    if (/^(?:1|'1'|true|'true')$/i.test(value)) return 'true';
    if (/^(?:0|'0'|false|'false')$/i.test(value)) return 'false';
  }
  return value;
}

function identityJson(row: IbmiColumnRow): string {
  return JSON.stringify({
    always: row.identityGeneration?.toUpperCase() === 'ALWAYS',
  });
}

function foreignKeyDefinition(fk: IbmiForeignKeyRow): string {
  const child = fk.columns.map((c) => pgQuoteIdentifier(pgVisibleIdentifier(c))).join(', ');
  const parentColumns = fk.referencedColumns.map((c) => pgQuoteIdentifier(pgVisibleIdentifier(c))).join(', ');
  const parentTable = pgQuoteIdentifier(pgVisibleIdentifier(fk.referencedTable));
  let sql = `FOREIGN KEY (${child}) REFERENCES ${parentTable}(${parentColumns})`;
  if (fk.updateRule && fk.updateRule.toUpperCase() !== 'NO ACTION') sql += ` ON UPDATE ${fk.updateRule.toUpperCase()}`;
  if (fk.deleteRule && fk.deleteRule.toUpperCase() !== 'NO ACTION') sql += ` ON DELETE ${fk.deleteRule.toUpperCase()}`;
  return sql;
}

function pgQuoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function pgTextArray(values: string[]): string {
  return `{${values.map((value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')}}`;
}

function pgBoolArray(values: boolean[]): string {
  return `{${values.map((value) => value ? 't' : 'f').join(',')}}`;
}

function pgIntArray(values: number[]): string {
  return `{${values.join(',')}}`;
}

function flattenParameterStrings(parameters: unknown[]): string[] {
  const out: string[] = [];
  const append = (value: unknown): void => {
    if (value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) append(item);
      return;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        for (const item of parsePgArrayText(trimmed)) out.push(item);
      } else {
        out.push(trimmed);
      }
    } else if (typeof value === 'number' || typeof value === 'bigint') {
      out.push(String(value));
    }
  };
  for (const value of parameters) append(value);
  return out;
}

function parsePgArrayText(value: string): string[] {
  const body = value.slice(1, -1);
  if (!body) return [];
  const out: string[] = [];
  let token = '';
  let quoted = false;
  let escaped = false;
  for (const ch of body) {
    if (escaped) { token += ch; escaped = false; continue; }
    if (quoted && ch === '\\') { escaped = true; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === ',' && !quoted) { out.push(token.trim()); token = ''; continue; }
    token += ch;
  }
  out.push(token.trim());
  return out;
}

function compact(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\r\n]*/g, ' ').replace(/\s+/g, ' ').trim().replace(/;+$/, '').trim();
}
