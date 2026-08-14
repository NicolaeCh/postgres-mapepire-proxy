export interface ForeignKeyAlignment {
  constraint?: string;
  childTable: string;
  childColumn: string;
  parentTable: string;
  parentColumn: string;
  previousType: string;
  alignedType: string;
}

interface ParsedColumn {
  name: string;
  definitionIndex: number;
  type: string;
  restAfterType: string;
}

interface ParsedForeignKey {
  constraint?: string;
  childColumns: string[];
  parentTable: string;
  parentColumns: string[];
}

interface ParsedCreateTable {
  schema: string;
  table: string;
  open: number;
  close: number;
  definitions: string[];
  columns: Map<string, ParsedColumn>;
  foreignKeys: ParsedForeignKey[];
}

/**
 * Session-local registry of translated Db2 column types.
 *
 * PostgreSQL allows a foreign-key column such as VARCHAR (unbounded) to
 * reference VARCHAR(36). Db2 for i requires the corresponding key column
 * descriptions to match much more strictly. During an Alembic migration the
 * referenced parent table is normally created earlier on the same connection,
 * so remembering the successfully translated parent type lets us make the
 * dependent CREATE TABLE valid without hard-coding application table names.
 */
export class DdlForeignKeyTypeRegistry {
  private types = new Map<string, string>();
  private transactionSnapshot?: Map<string, string>;

  alignCreateTable(sql: string, currentSchema: string): { sql: string; alignments: ForeignKeyAlignment[] } {
    const parsed = parseCreateTable(sql, currentSchema);
    if (!parsed || !parsed.foreignKeys.length) return { sql, alignments: [] };

    const definitions = [...parsed.definitions];
    const alignments: ForeignKeyAlignment[] = [];

    for (const fk of parsed.foreignKeys) {
      if (fk.childColumns.length !== fk.parentColumns.length) continue;
      const parent = splitQualifiedName(fk.parentTable, parsed.schema);

      fk.childColumns.forEach((childName, index) => {
        const parentName = fk.parentColumns[index]!;
        const child = parsed.columns.get(normalizeIdentifier(childName));
        if (!child) return;
        const parentType = this.types.get(typeKey(parent.schema, parent.table, parentName));
        if (!parentType || equivalentType(child.type, parentType)) return;

        definitions[child.definitionIndex] = replaceColumnType(
          definitions[child.definitionIndex]!,
          child.type,
          parentType,
        );
        alignments.push({
          constraint: fk.constraint,
          childTable: parsed.table,
          childColumn: normalizeIdentifier(childName),
          parentTable: parent.table,
          parentColumn: normalizeIdentifier(parentName),
          previousType: child.type,
          alignedType: parentType,
        });
      });
    }

    if (!alignments.length) return { sql, alignments };
    return {
      sql: `${sql.slice(0, parsed.open + 1)}${definitions.join(',')}${sql.slice(parsed.close)}`,
      alignments,
    };
  }

  registerCreateTable(sql: string, currentSchema: string): void {
    const parsed = parseCreateTable(sql, currentSchema);
    if (!parsed) return;
    for (const column of parsed.columns.values()) {
      this.types.set(typeKey(parsed.schema, parsed.table, column.name), column.type);
    }
  }

  getColumnType(tableName: string, columnName: string, currentSchema: string): string | undefined {
    const table = splitQualifiedName(tableName, currentSchema);
    return this.types.get(typeKey(table.schema, table.table, columnName));
  }

  renameColumn(tableName: string, oldColumn: string, newColumn: string, currentSchema: string): void {
    const table = splitQualifiedName(tableName, currentSchema);
    const oldKey = typeKey(table.schema, table.table, oldColumn);
    const type = this.types.get(oldKey);
    if (!type) return;
    this.types.delete(oldKey);
    this.types.set(typeKey(table.schema, table.table, newColumn), type);
  }

  registerAlterAddColumn(sql: string, currentSchema: string): void {
    const ident = String.raw`(?:(?:"(?:[^"]|"")*")|(?:[A-Za-z_][A-Za-z0-9_$#@]*))`;
    const relation = String.raw`((?:${ident})(?:\s*\.\s*(?:${ident}))?)`;
    const match = new RegExp(
      String.raw`^\s*ALTER\s+TABLE\s+${relation}\s+ADD\s+(?:COLUMN\s+)?(${ident})\s+([\s\S]+)$`,
      'i',
    ).exec(sql);
    if (!match) return;
    const table = splitQualifiedName(match[1]!, currentSchema);
    const type = extractTypePrefix(match[3]!);
    if (!type) return;
    this.types.set(typeKey(table.schema, table.table, match[2]!), type);
  }

  beginTransaction(): void {
    if (this.transactionSnapshot) return;
    this.transactionSnapshot = new Map(this.types);
  }

  commitTransaction(): void { this.transactionSnapshot = undefined; }

  rollbackTransaction(): void {
    if (!this.transactionSnapshot) return;
    this.types = this.transactionSnapshot;
    this.transactionSnapshot = undefined;
  }

  clear(): void {
    this.types.clear();
    this.transactionSnapshot = undefined;
  }
}

function parseCreateTable(sql: string, currentSchema: string): ParsedCreateTable | undefined {
  const match = /^\s*CREATE\s+(?:(?:GLOBAL|LOCAL)\s+TEMPORARY\s+|TEMPORARY\s+|TEMP\s+|UNLOGGED\s+)?TABLE\s+((?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$#@]*)(?:\s*\.\s*(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$#@]*))?)/i.exec(sql);
  if (!match) return undefined;
  const open = firstUnquotedChar(sql, '(', match.index + match[0].length);
  if (open < 0) return undefined;
  const close = matchingParen(sql, open);
  if (close < 0) return undefined;

  const qualified = splitQualifiedName(match[1]!, currentSchema);
  const definitions = splitDefinitionList(sql.slice(open + 1, close));
  const columns = new Map<string, ParsedColumn>();
  const foreignKeys: ParsedForeignKey[] = [];

  definitions.forEach((definition, definitionIndex) => {
    const fk = parseForeignKey(definition);
    if (fk) {
      foreignKeys.push(fk);
      return;
    }
    if (/^\s*(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|EXCLUDE)\b/i.test(definition)) return;
    const col = /^\s*("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$#@]*)\s+([\s\S]+)$/.exec(definition);
    if (!col) return;
    const type = extractTypePrefix(col[2]!);
    if (!type) return;
    const name = normalizeIdentifier(col[1]!);
    columns.set(name, {
      name,
      definitionIndex,
      type,
      restAfterType: col[2]!.slice(type.length),
    });
  });

  return {
    schema: qualified.schema,
    table: qualified.table,
    open,
    close,
    definitions,
    columns,
    foreignKeys,
  };
}

function parseForeignKey(definition: string): ParsedForeignKey | undefined {
  const match = /^\s*(?:CONSTRAINT\s+("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$#@]*)\s+)?FOREIGN\s+KEY\s*\(([^)]*)\)\s+REFERENCES\s+((?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$#@]*)(?:\s*\.\s*(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$#@]*))?)\s*\(([^)]*)\)/i.exec(definition);
  if (!match) return undefined;
  return {
    constraint: match[1] ? normalizeIdentifier(match[1]) : undefined,
    childColumns: splitIdentifierList(match[2]!),
    parentTable: match[3]!,
    parentColumns: splitIdentifierList(match[4]!),
  };
}

function extractTypePrefix(rest: string): string | undefined {
  const candidates = [
    /^VARCHAR\s*\(\s*\d+\s*\)(?:\s+CCSID\s+\d+)?/i,
    /^CHARACTER\s+VARYING\s*\(\s*\d+\s*\)(?:\s+CCSID\s+\d+)?/i,
    /^CHAR(?:ACTER)?\s*\(\s*\d+\s*\)(?:\s+CCSID\s+\d+)?/i,
    /^VARBINARY\s*\(\s*\d+\s*\)/i,
    /^DECIMAL\s*\([^)]*\)/i,
    /^NUMERIC\s*\([^)]*\)/i,
    /^DECFLOAT\s*\([^)]*\)/i,
    /^TIMESTAMP(?:\s*\(\s*\d+\s*\))?/i,
    /^TIME(?:\s*\(\s*\d+\s*\))?/i,
    /^CLOB\s*\([^)]*\)(?:\s+CCSID\s+\d+)?/i,
    /^BLOB\s*\([^)]*\)/i,
    /^DBCLOB\s*\([^)]*\)/i,
    /^(?:BIGINT|INTEGER|INT|SMALLINT|BOOLEAN|DATE|DOUBLE|REAL|FLOAT)\b/i,
  ];
  for (const candidate of candidates) {
    const match = candidate.exec(rest);
    if (match) return normalizeType(match[0]);
  }
  return undefined;
}

function replaceColumnType(definition: string, previousType: string, alignedType: string): string {
  const match = /^(\s*(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$#@]*)\s+)([\s\S]*)$/.exec(definition);
  if (!match) return definition;
  const rest = match[2]!;
  const actual = extractTypePrefix(rest);
  if (!actual || !equivalentType(actual, previousType)) return definition;
  // Use the source text length, not normalized type length, to preserve all
  // attributes following the datatype (NULLability, defaults, identity, etc.).
  const sourceType = typePrefixSource(rest);
  if (!sourceType) return definition;
  return `${match[1]}${alignedType}${rest.slice(sourceType.length)}`;
}

function typePrefixSource(rest: string): string | undefined {
  const normalized = extractTypePrefix(rest);
  if (!normalized) return undefined;
  // Match the same token family and return the exact source spelling.
  const patterns = [
    /^VARCHAR\s*\(\s*\d+\s*\)(?:\s+CCSID\s+\d+)?/i,
    /^CHARACTER\s+VARYING\s*\(\s*\d+\s*\)(?:\s+CCSID\s+\d+)?/i,
    /^CHAR(?:ACTER)?\s*\(\s*\d+\s*\)(?:\s+CCSID\s+\d+)?/i,
    /^VARBINARY\s*\(\s*\d+\s*\)/i,
    /^DECIMAL\s*\([^)]*\)/i,
    /^NUMERIC\s*\([^)]*\)/i,
    /^DECFLOAT\s*\([^)]*\)/i,
    /^TIMESTAMP(?:\s*\(\s*\d+\s*\))?/i,
    /^TIME(?:\s*\(\s*\d+\s*\))?/i,
    /^CLOB\s*\([^)]*\)(?:\s+CCSID\s+\d+)?/i,
    /^BLOB\s*\([^)]*\)/i,
    /^DBCLOB\s*\([^)]*\)/i,
    /^(?:BIGINT|INTEGER|INT|SMALLINT|BOOLEAN|DATE|DOUBLE|REAL|FLOAT)\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(rest);
    if (match) return match[0];
  }
  return undefined;
}

function splitQualifiedName(value: string, defaultSchema: string): { schema: string; table: string } {
  const parts = splitQualifiedIdentifier(value);
  if (parts.length >= 2) {
    return { schema: normalizeIdentifier(parts[parts.length - 2]!), table: normalizeIdentifier(parts[parts.length - 1]!) };
  }
  return { schema: normalizeIdentifier(defaultSchema), table: normalizeIdentifier(parts[0] ?? value) };
}

function typeKey(schema: string, table: string, column: string): string {
  return `${normalizeIdentifier(schema)}.${normalizeIdentifier(table)}.${normalizeIdentifier(column)}`;
}

function normalizeIdentifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).replace(/""/g, '"').toUpperCase();
  return trimmed.toUpperCase();
}

function normalizeType(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

function equivalentType(a: string, b: string): boolean {
  return normalizeType(a) === normalizeType(b);
}

function splitIdentifierList(value: string): string[] {
  return value.split(',').map((part) => part.trim()).filter(Boolean);
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
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function firstUnquotedChar(sql: string, wanted: string, start = 0): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = start; i < sql.length; i++) {
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
      inSingle = !inSingle;
      continue;
    }
    if (c === '"' && !inSingle) {
      if (inDouble && sql[i + 1] === '"') { i++; continue; }
      inDouble = !inDouble;
      continue;
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
      inSingle = !inSingle;
      continue;
    }
    if (c === '"' && !inSingle) {
      if (inDouble && body[i + 1] === '"') { i++; continue; }
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}
