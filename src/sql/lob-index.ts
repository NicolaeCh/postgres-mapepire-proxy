export interface PgSimpleIndex {
  original: string;
  unique: boolean;
  indexSchema?: string;
  indexName: string;
  tableSchema?: string;
  tableName: string;
  columns: string[];
}

const IDENT = String.raw`(?:(?:"(?:[^"]|"")*")|(?:[A-Za-z_][A-Za-z0-9_$#@]*))`;
const QUALIFIED = String.raw`(${IDENT})(?:\s*\.\s*(${IDENT}))?`;

/**
 * Parse the conservative CREATE [UNIQUE] INDEX form produced by SQLAlchemy
 * and most PostgreSQL clients when every key is a plain column reference.
 *
 * Expression, INCLUDE, WHERE, operator-class and method-specific indexes are
 * intentionally not classified here: they must continue to the normal Db2
 * path so the proxy never silently skips semantics it cannot characterize.
 */
export function parsePgSimpleCreateIndex(sql: string): PgSimpleIndex | undefined {
  const pattern = new RegExp(
    String.raw`^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?${QUALIFIED}\s+ON\s+${QUALIFIED}\s*\(([\s\S]+)\)\s*;?\s*$`,
    'i',
  );
  const match = pattern.exec(sql);
  if (!match) return undefined;

  const indexFirst = match[2]!;
  const indexSecond = match[3];
  const tableFirst = match[4]!;
  const tableSecond = match[5];
  const body = match[6]!;
  const keys = splitTopLevel(body);
  if (!keys.length) return undefined;

  const columns: string[] = [];
  for (const key of keys) {
    // Permit PostgreSQL ordering/null-placement decorations around a simple
    // column. Operator classes and expressions deliberately do not match.
    const m = new RegExp(
      String.raw`^\s*(${IDENT})(?:\s+(?:ASC|DESC))?(?:\s+NULLS\s+(?:FIRST|LAST))?\s*$`,
      'i',
    ).exec(key);
    if (!m) return undefined;
    columns.push(normalizeIdentifier(m[1]!));
  }

  return {
    original: sql,
    unique: Boolean(match[1]),
    indexSchema: indexSecond ? normalizeIdentifier(indexFirst) : undefined,
    indexName: normalizeIdentifier(indexSecond ?? indexFirst),
    tableSchema: tableSecond ? normalizeIdentifier(tableFirst) : undefined,
    tableName: normalizeIdentifier(tableSecond ?? tableFirst),
    columns,
  };
}

export function isDb2LobType(type: string | undefined): boolean {
  if (!type) return false;
  return /^(?:CLOB|CHARACTER\s+LARGE\s+OBJECT|CHAR\s+LARGE\s+OBJECT|DBCLOB|BLOB|BINARY\s+LARGE\s+OBJECT|XML|DATALINK)\b/i.test(type.trim());
}

export type UnsupportedNonuniqueLobIndexPolicy = 'skip' | 'error';

export interface LobIndexColumnType {
  column: string;
  type: string;
}

export interface LobIndexDecision {
  action: 'pass' | 'skip' | 'error';
  lobColumns: LobIndexColumnType[];
}

/**
 * Decide whether a parsed plain-column PostgreSQL index can be represented
 * directly by Db2 for i. UNIQUE indexes are always errors when any key is a
 * LOB-backed type because silently dropping uniqueness would change data
 * validity. Non-unique indexes may be treated as unsupported performance hints
 * when compatibility policy is `skip`.
 */
export function decideLobIndexCompatibility(
  index: PgSimpleIndex,
  columnTypes: LobIndexColumnType[],
  policy: UnsupportedNonuniqueLobIndexPolicy,
): LobIndexDecision {
  const lobColumns = columnTypes.filter((entry) => isDb2LobType(entry.type));
  if (!lobColumns.length) return { action: 'pass', lobColumns };
  if (index.unique || policy === 'error') return { action: 'error', lobColumns };
  return { action: 'skip', lobColumns };
}

function normalizeIdentifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  return trimmed.toUpperCase();
}

function splitTopLevel(value: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (inSingle) {
      if (ch === "'" && value[i + 1] === "'") { i++; continue; }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && value[i + 1] === '"') { i++; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue; }
    if (ch === ',' && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out.filter(Boolean);
}
