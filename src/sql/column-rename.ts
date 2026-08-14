export interface PgColumnRename {
  original: string;
  schema: string;
  table: string;
  relationSql: string;
  oldColumn: string;
  oldColumnSql: string;
  newColumn: string;
  newColumnSql: string;
}

export interface ColumnRenamePlan {
  request: PgColumnRename;
  systemColumnName: string;
  db2Sql: string;
  storedCreateSql: string;
}

interface StoredTableDefinition {
  schema: string;
  table: string;
  createSql: string;
}

const IDENT = String.raw`(?:(?:"(?:[^"]|"")*")|(?:[A-Za-z_][A-Za-z0-9_$#@]*))`;
const RELATION = String.raw`(${IDENT})(?:\s*\.\s*(${IDENT}))?`;

/**
 * Parse PostgreSQL ALTER TABLE ... RENAME [COLUMN] old TO new.
 *
 * Db2 for i has no ALTER TABLE RENAME COLUMN clause, so ProxySession handles
 * this command before the generic translator and emulates it with CREATE OR
 * REPLACE TABLE ... ON REPLACE PRESERVE ROWS.
 */
export function parsePgAlterTableRenameColumn(sql: string, currentSchema: string): PgColumnRename | undefined {
  const pattern = new RegExp(
    String.raw`^\s*ALTER\s+TABLE\s+${RELATION}\s+RENAME\s+(?:COLUMN\s+)?(${IDENT})\s+TO\s+(${IDENT})\s*;?\s*$`,
    'i',
  );
  const match = pattern.exec(sql);
  if (!match) return undefined;

  const first = match[1]!;
  const second = match[2];
  const oldSql = match[3]!;
  const newSql = match[4]!;
  const schemaSql = second ? first : currentSchema;
  const tableSql = second ?? first;
  return {
    original: sql,
    schema: normalizeIdentifier(schemaSql),
    table: normalizeIdentifier(tableSql),
    relationSql: second ? `${first}.${second}` : first,
    oldColumn: normalizeIdentifier(oldSql),
    oldColumnSql: renderSqlIdentifier(oldSql),
    newColumn: normalizeIdentifier(newSql),
    newColumnSql: renderSqlIdentifier(newSql),
  };
}

/**
 * Session-local exact DDL registry used for lossless IBM i column rename
 * emulation.
 *
 * The registry intentionally stores the translated Db2 CREATE TABLE statement
 * that was actually executed.  It does not guess a table definition from a
 * partial catalog projection.  If a client asks to rename a column on a table
 * for which the proxy has no trusted definition, the caller must fail safely
 * rather than perform a destructive add/copy/drop sequence.
 */
export class DdlTableDefinitionRegistry {
  private tables = new Map<string, StoredTableDefinition>();
  private transactionSnapshot?: Map<string, StoredTableDefinition>;

  registerCreateTable(sql: string, currentSchema: string): void {
    const parsed = parseCreateTable(sql, currentSchema);
    if (!parsed) return;
    this.tables.set(tableKey(parsed.schema, parsed.table), {
      schema: parsed.schema,
      table: parsed.table,
      createSql: canonicalCreateTable(sql),
    });
  }

  registerAlterAddColumn(sql: string, currentSchema: string): void {
    const add = parseAlterAddColumn(sql, currentSchema);
    if (!add) return;
    const key = tableKey(add.schema, add.table);
    const stored = this.tables.get(key);
    if (!stored) return;
    const parsed = parseCreateTable(stored.createSql, currentSchema);
    if (!parsed) return;

    const definitions = [...parsed.definitions];
    const firstConstraint = definitions.findIndex((definition) => /^\s*(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)\b/i.test(definition));
    const insertAt = firstConstraint >= 0 ? firstConstraint : definitions.length;
    definitions.splice(insertAt, 0, `${add.columnSql} ${add.definition}`);
    stored.createSql = rebuildCreate(parsed, definitions, false);
  }

  planRename(request: PgColumnRename, systemColumnName: string): ColumnRenamePlan | undefined {
    const stored = this.tables.get(tableKey(request.schema, request.table));
    if (!stored) return undefined;
    const parsed = parseCreateTable(stored.createSql, request.schema);
    if (!parsed) return undefined;

    const oldNormalized = normalizeIdentifier(request.oldColumn);
    const newNormalized = normalizeIdentifier(request.newColumn);
    let target = -1;
    const definitions = parsed.definitions.map((definition, index) => {
      if (/^\s*(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)\b/i.test(definition)) {
        return replaceIdentifierReferences(definition, oldNormalized, request.newColumnSql);
      }
      const column = parseColumnDefinition(definition);
      if (!column) return replaceIdentifierReferences(definition, oldNormalized, request.newColumnSql);
      if (normalizeIdentifier(column.nameSql) !== oldNormalized) {
        return replaceIdentifierReferences(definition, oldNormalized, request.newColumnSql);
      }
      target = index;
      const systemSql = renderSystemIdentifier(systemColumnName);
      const systemClause = normalizeIdentifier(request.newColumnSql) === normalizeIdentifier(systemColumnName)
        ? ''
        : ` FOR COLUMN ${systemSql}`;
      // Keep the IBM i system column name stable.  IBM i CREATE OR REPLACE can
      // then recognize this as a SQL-name change rather than as drop+add.  If
      // the new SQL name is itself the system name (for example a downgrade
      // back to IS_ACTIVE), omit FOR COLUMN because the names coincide again.
      return `${column.leading}${request.newColumnSql}${systemClause} ${replaceIdentifierReferences(column.rest, oldNormalized, request.newColumnSql)}`;
    });

    if (target < 0) return undefined;
    // Avoid generating an invalid table where the requested new SQL name is
    // already used by another column.
    for (let i = 0; i < parsed.definitions.length; i++) {
      if (i === target) continue;
      const column = parseColumnDefinition(parsed.definitions[i]!);
      if (column && normalizeIdentifier(column.nameSql) === newNormalized) return undefined;
    }

    const storedCreateSql = rebuildCreate(parsed, definitions, false);
    const db2Sql = rebuildCreate(parsed, definitions, true);
    return { request, systemColumnName, db2Sql, storedCreateSql };
  }

  commitRename(plan: ColumnRenamePlan): void {
    this.tables.set(tableKey(plan.request.schema, plan.request.table), {
      schema: plan.request.schema,
      table: plan.request.table,
      createSql: plan.storedCreateSql,
    });
  }

  hasTable(tableName: string, currentSchema: string): boolean {
    const qualified = splitQualifiedName(tableName, currentSchema);
    return this.tables.has(tableKey(qualified.schema, qualified.table));
  }

  beginTransaction(): void {
    if (this.transactionSnapshot) return;
    this.transactionSnapshot = cloneDefinitions(this.tables);
  }

  commitTransaction(): void { this.transactionSnapshot = undefined; }

  rollbackTransaction(): void {
    if (!this.transactionSnapshot) return;
    this.tables = this.transactionSnapshot;
    this.transactionSnapshot = undefined;
  }

  clear(): void { this.tables.clear(); this.transactionSnapshot = undefined; }
}

function cloneDefinitions(source: Map<string, StoredTableDefinition>): Map<string, StoredTableDefinition> {
  return new Map([...source.entries()].map(([key, value]) => [key, { ...value }]));
}

interface ParsedCreateTable {
  schema: string;
  table: string;
  prefix: string;
  open: number;
  close: number;
  definitions: string[];
  suffix: string;
}

function parseCreateTable(sql: string, currentSchema: string): ParsedCreateTable | undefined {
  const match = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL|LOCAL)\s+TEMPORARY\s+|TEMPORARY\s+|TEMP\s+|UNLOGGED\s+)?TABLE\s+((?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$#@]*)(?:\s*\.\s*(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$#@]*))?)/i.exec(sql);
  if (!match) return undefined;
  const open = firstUnquotedChar(sql, '(', match.index + match[0].length);
  if (open < 0) return undefined;
  const close = matchingParen(sql, open);
  if (close < 0) return undefined;
  const qualified = splitQualifiedName(match[1]!, currentSchema);
  const suffix = sql.slice(close + 1).trim();
  // The registry only emulates rename from ordinary CREATE TABLE definitions.
  // ON REPLACE and exotic PostgreSQL table suffixes must not be duplicated.
  const cleanSuffix = suffix.replace(/^ON\s+REPLACE\s+PRESERVE(?:\s+ALL)?\s+ROWS\s*$/i, '').trim();
  if (cleanSuffix) return undefined;
  return {
    schema: qualified.schema,
    table: qualified.table,
    prefix: canonicalCreatePrefix(sql.slice(0, open)),
    open,
    close,
    definitions: splitDefinitionList(sql.slice(open + 1, close)),
    suffix: '',
  };
}

function canonicalCreatePrefix(prefix: string): string {
  return prefix.replace(/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?/i, 'CREATE ');
}

function canonicalCreateTable(sql: string): string {
  return sql
    .replace(/^\s*CREATE\s+OR\s+REPLACE\s+/i, 'CREATE ')
    .replace(/\s+ON\s+REPLACE\s+PRESERVE(?:\s+ALL)?\s+ROWS\s*$/i, '')
    .trim();
}

function rebuildCreate(parsed: ParsedCreateTable, definitions: string[], replace: boolean): string {
  const prefix = replace
    ? parsed.prefix.replace(/^CREATE\s+/i, 'CREATE OR REPLACE ')
    : parsed.prefix;
  return `${prefix}(${definitions.join(',')})${replace ? ' ON REPLACE PRESERVE ROWS' : ''}`;
}

interface AlterAddColumn {
  schema: string;
  table: string;
  columnSql: string;
  definition: string;
}

function parseAlterAddColumn(sql: string, currentSchema: string): AlterAddColumn | undefined {
  const pattern = new RegExp(
    String.raw`^\s*ALTER\s+TABLE\s+${RELATION}\s+ADD\s+(?:COLUMN\s+)?(${IDENT})\s+([\s\S]+?)\s*;?\s*$`,
    'i',
  );
  const match = pattern.exec(sql);
  if (!match) return undefined;
  const first = match[1]!;
  const second = match[2];
  const schema = normalizeIdentifier(second ? first : currentSchema);
  const table = normalizeIdentifier(second ?? first);
  return { schema, table, columnSql: match[3]!, definition: match[4]!.trim() };
}

function parseColumnDefinition(definition: string): { leading: string; nameSql: string; systemNameSql?: string; rest: string } | undefined {
  if (/^\s*(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)\b/i.test(definition)) return undefined;
  const ident = String.raw`(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$#@]*)`;
  const match = new RegExp(
    String.raw`^(\s*)(${ident})\s+(?:FOR\s+COLUMN\s+(${ident})\s+)?([\s\S]+)$`,
    'i',
  ).exec(definition);
  if (!match) return undefined;
  return { leading: match[1]!, nameSql: match[2]!, systemNameSql: match[3], rest: match[4]! };
}

function replaceIdentifierReferences(text: string, oldNormalized: string, newSql: string): string {
  let out = '';
  let i = 0;
  let inSingle = false;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "'") {
      out += ch;
      if (inSingle && text[i + 1] === "'") { out += "'"; i += 2; continue; }
      inSingle = !inSingle; i++; continue;
    }
    if (inSingle) { out += ch; i++; continue; }
    if (ch === '"') {
      let token = '"'; i++;
      while (i < text.length) {
        token += text[i]!;
        if (text[i] === '"') {
          if (text[i + 1] === '"') { token += '"'; i += 2; continue; }
          i++; break;
        }
        i++;
      }
      out += normalizeIdentifier(token) === oldNormalized ? newSql : token;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i++;
      while (i < text.length && /[A-Za-z0-9_$#@]/.test(text[i]!)) i++;
      const token = text.slice(start, i);
      out += normalizeIdentifier(token) === oldNormalized ? newSql : token;
      continue;
    }
    out += ch; i++;
  }
  return out;
}

function renderSqlIdentifier(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') ? trimmed : trimmed.toUpperCase();
}

function renderSystemIdentifier(name: string): string {
  const upper = name.toUpperCase();
  return /^[A-Z_$#@][A-Z0-9_$#@]{0,9}$/.test(upper) ? upper : `"${name.replaceAll('"', '""')}"`;
}

function splitQualifiedName(value: string, defaultSchema: string): { schema: string; table: string } {
  const parts = splitQualifiedIdentifier(value);
  if (parts.length >= 2) {
    return { schema: normalizeIdentifier(parts[parts.length - 2]!), table: normalizeIdentifier(parts[parts.length - 1]!) };
  }
  return { schema: normalizeIdentifier(defaultSchema), table: normalizeIdentifier(parts[0] ?? value) };
}

function splitQualifiedIdentifier(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let inDouble = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === '"') {
      if (inDouble && value[i + 1] === '"') { i++; continue; }
      inDouble = !inDouble;
      continue;
    }
    if (!inDouble && c === '.') {
      parts.push(value.slice(start, i).trim()); start = i + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function normalizeIdentifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).replace(/""/g, '"');
  return trimmed.toUpperCase();
}

function tableKey(schema: string, table: string): string {
  return `${normalizeIdentifier(schema)}.${normalizeIdentifier(table)}`;
}

function firstUnquotedChar(sql: string, wanted: string, start = 0): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = start; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "'" && !inDouble) {
      if (inSingle && sql[i + 1] === "'") { i++; continue; }
      inSingle = !inSingle; continue;
    }
    if (c === '"' && !inSingle) {
      if (inDouble && sql[i + 1] === '"') { i++; continue; }
      inDouble = !inDouble; continue;
    }
    if (!inSingle && !inDouble && c === wanted) return i;
  }
  return -1;
}

function matchingParen(sql: string, open: number): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = open; i < sql.length; i++) {
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
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

function splitDefinitionList(body: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "'" && !inDouble) {
      if (inSingle && body[i + 1] === "'") { i++; continue; }
      inSingle = !inSingle; continue;
    }
    if (c === '"' && !inSingle) {
      if (inDouble && body[i + 1] === '"') { i++; continue; }
      inDouble = !inDouble; continue;
    }
    if (inSingle || inDouble) continue;
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(body.slice(start, i)); start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}
