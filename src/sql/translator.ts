import { classify } from './classifier.js';

export interface Translation {
  original: string;
  sql: string;
  kind: ReturnType<typeof classify>;
  parameterOrder: number[];
}

export interface TranslateOptions {
  uppercaseIdentifiers: boolean;
  informationSchemaRewrite: boolean;
  pgCatalogCompat: boolean;
  allowMultiStatement: boolean;
  maxRows: number;
  ddlDefaultVarcharLength?: number;
}

export interface PgReturningColumn {
  column: string;
  fieldName: string;
}

export interface PgReturningInfo {
  kind: 'insert' | 'update' | 'delete';
  table: string;
  columns: PgReturningColumn[];
}

export function translateSql(input: string, options: TranslateOptions): Translation {
  let sql = input.trim();
  if (!options.allowMultiStatement && hasMultipleStatements(sql)) {
    throw Object.assign(new Error('Multiple SQL statements in one PostgreSQL Query message are disabled'), { sqlstate: '0A000' });
  }
  sql = sql.replace(/;+\s*$/, '');
  const originalKind = classify(sql);

  const parameterOrder: number[] = [];
  sql = sql.replace(/\$(\d+)/g, (_m, n) => {
    parameterOrder.push(Number(n));
    return '?';
  });

  sql = rewritePgCasts(sql);
  sql = rewritePgJsonCasts(sql);
  sql = rewritePgSerialTypes(sql);
  sql = rewritePgDdlTypes(sql, options.ddlDefaultVarcharLength ?? 1024);
  sql = rewritePgReturning(sql, originalKind);
  sql = rewriteTopLevelExists(sql);
  sql = rewriteLimitOffset(sql);
  sql = rewritePgFunctions(sql);
  sql = ensureDb2SelectSource(sql);

  if (options.informationSchemaRewrite) sql = rewriteInformationSchema(sql);
  if (options.pgCatalogCompat) sql = rewritePgCatalog(sql);

  if (options.uppercaseIdentifiers) sql = uppercaseUnquotedRelationIdentifiers(sql);
  if (options.maxRows > 0 && /^\s*select\b/i.test(sql) && !/\bfetch\s+(first|next)\b/i.test(sql)) {
    sql = `${sql} FETCH FIRST ${Math.trunc(options.maxRows)} ROWS ONLY`;
  }

  // A PostgreSQL DML ... RETURNING statement is translated to a Db2
  // data-change table reference whose outer statement is SELECT.  Preserve
  // the original PostgreSQL DML kind so CommandComplete remains INSERT/UPDATE/
  // DELETE rather than SELECT while still returning the Db2 rowset.
  return { original: input, sql, kind: originalKind, parameterOrder };
}

export function reorderParameters(values: unknown[], order: number[]): unknown[] {
  if (!order.length) return values;
  return order.map((oneBased) => values[oneBased - 1] ?? null);
}

function rewritePgCasts(sql: string): string {
  // Conservative common-case conversion. Keep the type grammar bounded to
  // actual PostgreSQL type spellings: the former `[A-Za-z0-9_ ]*` tail could
  // greedily consume following SQL keywords (for example `::jsonb WHERE id`).
  // Known multi-word built-ins are accepted explicitly.
  return sql.replace(
    /((?:'[^']*(?:''[^']*)*'|\$\d+|\?|[A-Za-z_][A-Za-z0-9_.]*|[+-]?\d+(?:\.\d+)?))::([A-Za-z_][A-Za-z0-9_]*(?:(?:\s+(?:WITH|WITHOUT)\s+TIME\s+ZONE)|(?:\s+(?:VARYING|PRECISION)))?(?:\([^)]*\))?(?:\[\])?)/gi,
    'CAST($1 AS $2)',
  );
}

/**
 * Db2 for i has SQL/JSON functions but no PostgreSQL JSON/JSONB storage type.
 * The proxy stores JSON/JSONB columns as UTF-8 CLOB, so casts to PostgreSQL's
 * JSON types must become the matching Db2 CLOB cast function as well.
 *
 * This is intentionally limited to the same simple operands accepted by the
 * PostgreSQL :: cast normalizer above. It covers SQLAlchemy/Alembic defaults
 * such as DEFAULT '[]'::jsonb and normal parameter casts such as ?::jsonb
 * without attempting to emulate PostgreSQL JSONB operators or binary layout.
 */
function rewritePgJsonCasts(sql: string): string {
  return sql.replace(
    /\bCAST\(\s*('(?:[^']|'')*'|\?|NULL|TRUE|FALSE|[A-Za-z_][A-Za-z0-9_.]*|[+-]?\d+(?:\.\d+)?)\s+AS\s+JSONB?\s*\)/gi,
    (_match: string, value: string) => `CLOB(${value})`,
  );
}

function rewritePgSerialTypes(sql: string): string {
  if (/^\s*create\s+(?:(?:global|local)\s+temporary\s+|temporary\s+|temp\s+|unlogged\s+)?table\b/i.test(sql)) {
    const open = firstUnquotedChar(sql, '(');
    if (open < 0) return sql;
    const close = matchingParen(sql, open);
    if (close < 0) return sql;
    const body = sql.slice(open + 1, close);
    const definitions = splitDefinitionList(body);
    const serialColumns = definitions.filter(isSerialColumnDefinition).length;
    if (serialColumns > 1) {
      throw Object.assign(
        new Error('Db2 for i supports only one identity column per table; CREATE TABLE contains multiple PostgreSQL SERIAL columns'),
        { sqlstate: '0A000' },
      );
    }
    const rewritten = definitions.map(rewriteSerialColumnDefinition).join(',');
    return `${sql.slice(0, open + 1)}${rewritten}${sql.slice(close)}`;
  }

  if (/^\s*alter\s+table\b/i.test(sql)) {
    // PostgreSQL ALTER TABLE ... ADD [COLUMN] name SERIAL.  This conservative
    // form deliberately does not rewrite a column literally named SERIAL.
    return sql.replace(
      /(\bADD\s+(?:COLUMN\s+)?(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$#@]*)\s+)(SMALLSERIAL|SERIAL2|SERIAL4|SERIAL8|BIGSERIAL|SERIAL)\b/gi,
      (_m, prefix: string, serialType: string) => `${prefix}${serialReplacement(serialType)}`,
    );
  }
  return sql;
}

function isSerialColumnDefinition(definition: string): boolean {
  if (/^\s*(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)\b/i.test(definition)) return false;
  return /^\s*(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$#@]*)\s+(?:SMALLSERIAL|SERIAL2|SERIAL4|SERIAL8|BIGSERIAL|SERIAL)\b/i.test(definition);
}

function rewriteSerialColumnDefinition(definition: string): string {
  if (/^\s*(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)\b/i.test(definition)) return definition;
  return definition.replace(
    /^(\s*(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$#@]*)\s+)(SMALLSERIAL|SERIAL2|SERIAL4|SERIAL8|BIGSERIAL|SERIAL)\b/i,
    (_m, prefix: string, serialType: string) => `${prefix}${serialReplacement(serialType)}`,
  );
}

function serialReplacement(type: string): string {
  switch (type.toUpperCase()) {
    case 'SMALLSERIAL':
    case 'SERIAL2':
      return 'SMALLINT GENERATED BY DEFAULT AS IDENTITY';
    case 'BIGSERIAL':
    case 'SERIAL8':
      return 'BIGINT GENERATED BY DEFAULT AS IDENTITY';
    case 'SERIAL':
    case 'SERIAL4':
    default:
      return 'INTEGER GENERATED BY DEFAULT AS IDENTITY';
  }
}


/**
 * Translate PostgreSQL DDL-only data types into persistent Db2 for i types.
 *
 * SQLAlchemy's PostgreSQL compiler deliberately emits several types which are
 * either incomplete or PostgreSQL-specific from Db2 for i's point of view:
 *   String()              -> VARCHAR            (no length)
 *   JSON / JSONB          -> PostgreSQL JSON types
 *   Text()                -> TEXT
 *   LargeBinary()         -> BYTEA
 *   DateTime(timezone=1)  -> TIMESTAMP WITH TIME ZONE
 *   DateTime()            -> TIMESTAMP WITHOUT TIME ZONE
 *
 * Db2 for i requires an explicit VARCHAR length and has no native JSON data
 * type.  Keep this rewrite scoped to CREATE/ALTER TABLE so normal expressions,
 * casts and pg_catalog compatibility SQL are not changed accidentally.
 */
function rewritePgDdlTypes(sql: string, defaultVarcharLength: number): string {
  if (/^\s*create\s+(?:(?:global|local)\s+temporary\s+|temporary\s+|temp\s+|unlogged\s+)?table\b/i.test(sql)) {
    const open = firstUnquotedChar(sql, '(');
    if (open < 0) return sql;
    const close = matchingParen(sql, open);
    if (close < 0) return sql;
    const body = sql.slice(open + 1, close);
    const rewritten = splitDefinitionList(body).map((definition) => rewriteDb2ColumnTypeDefinition(definition, defaultVarcharLength)).join(',');
    return `${sql.slice(0, open + 1)}${rewritten}${sql.slice(close)}`;
  }

  if (/^\s*alter\s+table\b/i.test(sql)) {
    // PostgreSQL: ALTER TABLE t ALTER [COLUMN] c TYPE integer
    // Db2 for i:  ALTER TABLE t ALTER COLUMN c SET DATA TYPE INTEGER
    //
    // Do not silently reinterpret PostgreSQL USING/COLLATE expressions. Db2's
    // SET DATA TYPE performs its own compatibility conversion; a non-trivial
    // USING expression has application semantics that require a dedicated
    // rewrite and must fail explicitly instead of being dropped.
    const ident = String.raw`(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$#@]*)`;
    const relation = String.raw`(?:${ident})(?:\s*\.\s*(?:${ident}))?`;
    const alterType = new RegExp(
      String.raw`^(\s*ALTER\s+TABLE\s+(?:ONLY\s+)?${relation}\s+ALTER\s+)(?:COLUMN\s+)?(${ident})\s+TYPE\s+([\s\S]+)$`,
      'i',
    ).exec(sql);
    if (alterType) {
      const sourceType = alterType[3]!.trim();
      if (topLevelKeywordIndex(sourceType, 'using') >= 0) {
        throw Object.assign(
          new Error('PostgreSQL ALTER COLUMN TYPE ... USING is not supported by the Db2 for i compatibility layer'),
          { sqlstate: '0A000' },
        );
      }
      if (topLevelKeywordIndex(sourceType, 'collate') >= 0) {
        throw Object.assign(
          new Error('PostgreSQL ALTER COLUMN TYPE ... COLLATE is not supported by the Db2 for i compatibility layer'),
          { sqlstate: '0A000' },
        );
      }
      return `${alterType[1]}COLUMN ${alterType[2]} SET DATA TYPE ${rewriteDb2TypePrefix(sourceType, defaultVarcharLength)}`;
    }

    // ALTER TABLE ... ADD [COLUMN] <name> <type> ... is the DDL form used by
    // Alembic for new columns. Rewrite the type part while leaving all other
    // ALTER actions untouched.
    return sql.replace(
      /(\bADD\s+(?:COLUMN\s+)?(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$#@]*)\s+)([^,]+)$/i,
      (_m, prefix: string, rest: string) => `${prefix}${rewriteDb2TypePrefix(rest, defaultVarcharLength)}`,
    );
  }
  return sql;
}

function rewriteDb2ColumnTypeDefinition(definition: string, defaultVarcharLength: number): string {
  if (/^\s*(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)\b/i.test(definition)) return definition;
  return definition.replace(
    /^(\s*(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$#@]*)\s+)([\s\S]*)$/,
    (_m, prefix: string, rest: string) => `${prefix}${rewriteDb2TypePrefix(rest, defaultVarcharLength)}`,
  );
}

function rewriteDb2TypePrefix(rest: string, defaultVarcharLength: number): string {
  let value = rest;

  // Order matters: rewrite the longest PostgreSQL type spellings first.
  value = value.replace(/^TIMESTAMP\s+(?:WITH|WITHOUT)\s+TIME\s+ZONE\b/i, 'TIMESTAMP');
  value = value.replace(/^TIME\s+(?:WITH|WITHOUT)\s+TIME\s+ZONE\b/i, 'TIME');
  value = value.replace(/^DOUBLE\s+PRECISION\b/i, 'DOUBLE');
  value = value.replace(/^BYTEA\b/i, 'BLOB(2G)');
  value = value.replace(/^JSONB?\b/i, 'CLOB(2G) CCSID 1208');
  value = value.replace(/^TEXT\b/i, 'CLOB(2G) CCSID 1208');

  // PostgreSQL permits VARCHAR with no maximum length; Db2 for i requires a
  // length attribute.  1024 is intentionally conservative enough for indexed
  // ContextForge identifiers while still covering names, URLs and session IDs.
  const varcharLength = Math.max(1, Math.min(32740, Math.trunc(defaultVarcharLength)));
  value = value.replace(/^VARCHAR\b(?!\s*\()/i, `VARCHAR(${varcharLength})`);
  value = value.replace(/^CHARACTER\s+VARYING\b(?!\s*\()/i, `VARCHAR(${varcharLength})`);

  // PostgreSQL accepts several textual/numeric spellings for Boolean values
  // and SQLAlchemy commonly renders server_default="1" as DEFAULT '1'.
  // Db2 for i is stricter specifically for a BOOLEAN column DEFAULT: the
  // CREATE/ALTER TABLE grammar permits only the Boolean constants TRUE/FALSE.
  // Normalize only Boolean columns so defaults on VARCHAR/numeric columns keep
  // their original PostgreSQL meaning.
  if (/^BOOLEAN\b/i.test(value)) value = rewriteDb2BooleanDefault(value);

  // SQLAlchemy server_default values are SQL text.  A Python string such as
  // server_default="1" is therefore rendered by PostgreSQL as DEFAULT '1'
  // even when the target column is numeric. PostgreSQL accepts several such
  // implicit conversions, while Db2 for i validates CREATE TABLE defaults
  // against the declared column type and raises SQL0574 for incompatible
  // attributes. Normalize only simple quoted numeric literals and only when
  // the column itself is numeric; character defaults such as VARCHAR DEFAULT
  // '1' deliberately remain quoted.
  if (/^(?:SMALLINT|INTEGER|BIGINT)\b/i.test(value)) {
    value = rewriteDb2NumericDefault(value, 'integer');
  } else if (/^(?:DECIMAL|NUMERIC)\b/i.test(value)) {
    value = rewriteDb2NumericDefault(value, 'decimal');
  } else if (/^(?:REAL|DOUBLE|FLOAT|DECFLOAT)\b/i.test(value)) {
    value = rewriteDb2NumericDefault(value, 'floating');
  }

  return value;
}

function rewriteDb2NumericDefault(
  definitionTail: string,
  kind: 'integer' | 'decimal' | 'floating',
): string {
  const integer = `[+-]?\\d+`;
  const decimal = `[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)`;
  const floating = `${decimal}(?:[eE][+-]?\\d+)?`;
  const pattern = kind === 'integer' ? integer : kind === 'decimal' ? decimal : floating;

  // Keep the rewrite intentionally narrow: DEFAULT '<numeric literal>'.
  // Expressions, functions, CURRENT_* defaults and arbitrary casts are left
  // untouched because they may carry backend-specific semantics.
  return definitionTail.replace(
    new RegExp(`\\bDEFAULT\\s+'(${pattern})'(?=\\s|,|$)`, 'i'),
    (_match: string, literal: string) => `DEFAULT ${literal}`,
  );
}

function rewriteDb2BooleanDefault(definitionTail: string): string {
  const normalize = (literal: string): 'TRUE' | 'FALSE' | undefined => {
    let value = literal.trim();
    if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    switch (value.toLowerCase()) {
      case '1':
      case 't':
      case 'true':
      case 'y':
      case 'yes':
      case 'on':
        return 'TRUE';
      case '0':
      case 'f':
      case 'false':
      case 'n':
      case 'no':
      case 'off':
        return 'FALSE';
      default:
        return undefined;
    }
  };

  // rewritePgCasts() runs before DDL normalization, so PostgreSQL defaults
  // written as DEFAULT '1'::boolean arrive here as DEFAULT CAST('1' AS boolean).
  let out = definitionTail.replace(
    /\bDEFAULT\s+CAST\(\s*('(?:[^']|'')*'|[A-Za-z0-9_+-]+)\s+AS\s+BOOLEAN\s*\)/i,
    (match: string, literal: string) => {
      const value = normalize(literal);
      return value ? `DEFAULT ${value}` : match;
    },
  );

  out = out.replace(
    /\bDEFAULT\s+('(?:[^']|'')*'|[A-Za-z0-9_+-]+)/i,
    (match: string, literal: string) => {
      const value = normalize(literal);
      return value ? `DEFAULT ${value}` : match;
    },
  );
  return out;
}

/**
 * Translate PostgreSQL DML RETURNING into Db2 for i data-change table
 * references.
 *
 * PostgreSQL / SQLAlchemy commonly emits, for example:
 *   INSERT INTO alembic_version (version_num)
 *   VALUES (?) RETURNING alembic_version.version_num
 *
 * Db2 for i retrieves the affected row using:
 *   SELECT version_num FROM FINAL TABLE (
 *     INSERT INTO alembic_version (version_num) VALUES (?)
 *   )
 *
 * FINAL TABLE exposes post-change values for INSERT/UPDATE. OLD TABLE exposes
 * pre-delete values for DELETE, which matches PostgreSQL DELETE ... RETURNING.
 * Keep this deliberately conservative: SQLAlchemy's implicit RETURNING uses a
 * simple list of columns. More complex PostgreSQL-only expressions are rejected
 * rather than being silently mis-translated.
 */
function rewritePgReturning(sql: string, kind: ReturnType<typeof classify>): string {
  const info = parsePgReturning(sql);
  if (!info) return sql;

  const returning = topLevelKeywordIndex(sql, 'returning');
  const dml = sql.slice(0, returning).trimEnd();
  const selectList = info.columns.map((column) => column.column).join(', ');

  const transition = kind === 'delete' ? 'OLD TABLE' : 'FINAL TABLE';
  return `SELECT ${selectList} FROM ${transition} (${dml})`;
}

export function parsePgReturning(sql: string): PgReturningInfo | undefined {
  const kind = classify(sql);
  if (kind !== 'insert' && kind !== 'update' && kind !== 'delete') return undefined;

  const returning = topLevelKeywordIndex(sql, 'returning');
  if (returning < 0) return undefined;

  const rawList = sql.slice(returning + 'returning'.length).trim().replace(/;+\s*$/, '');
  if (!rawList) {
    throw Object.assign(new Error('PostgreSQL RETURNING requires at least one result expression'), { sqlstate: '42601' });
  }

  const table = returningTargetTable(sql, kind);
  if (!table) {
    throw Object.assign(new Error('PostgreSQL RETURNING target table could not be determined'), { sqlstate: '0A000' });
  }

  const columns = splitDefinitionList(rawList).map((item) => parseReturningExpression(item.trim()));
  return { kind, table, columns };
}

function returningTargetTable(sql: string, kind: 'insert' | 'update' | 'delete'): string | undefined {
  const ident = `(?:(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$#@]*)(?:\\s*\\.\\s*(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$#@]*))?)`;
  const source = kind === 'insert'
    ? `^\\s*INSERT\\s+INTO\\s+(${ident})`
    : kind === 'update'
      ? `^\\s*UPDATE\\s+(${ident})`
      : `^\\s*DELETE\\s+FROM\\s+(${ident})`;
  return new RegExp(source, 'i').exec(sql)?.[1]?.replace(/\s*\.\s*/g, '.');
}

function parseReturningExpression(expression: string): PgReturningColumn {
  if (expression === '*') {
    throw Object.assign(
      new Error('PostgreSQL RETURNING * is not supported because portal Describe requires explicit result-column metadata'),
      { sqlstate: '0A000' },
    );
  }

  // Preserve an optional SQL alias while removing a relation qualifier from a
  // simple returned column. The row produced by FINAL/OLD TABLE is the only
  // table reference in the outer SELECT, so the PostgreSQL source-table
  // qualifier is neither needed nor valid there.
  const match = expression.match(
    /^(?:(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$#@]*)\.)?("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$#@]*)(\s+(?:AS\s+)?(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$#@]*))?$/i,
  );
  if (!match) {
    throw Object.assign(
      new Error(`PostgreSQL RETURNING expression is not supported by the Db2 for i compatibility layer: ${expression}`),
      { sqlstate: '0A000' },
    );
  }
  const column = match[1]!;
  const alias = match[2]?.trim().replace(/^AS\s+/i, '');
  return {
    column,
    fieldName: unquoteIdentifier(alias ?? column),
  };
}

function unquoteIdentifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  return trimmed.toLowerCase();
}

function rewriteTopLevelExists(sql: string): string {
  const match = /^\s*select\s+exists\s*\(/i.exec(sql);
  if (!match) return sql;
  const open = sql.indexOf('(', match.index);
  if (open < 0) return sql;
  const close = matchingParen(sql, open);
  if (close < 0) return sql;
  const subquery = sql.slice(open + 1, close);
  const tail = sql.slice(close + 1);
  // Db2 for i supports EXISTS as a predicate, not as a bare SELECT-list item.
  // A searched CASE preserves PostgreSQL's scalar 0/1 truth semantics for
  // clients while keeping the subquery itself intact for normal translation.
  return `SELECT CASE WHEN EXISTS (${subquery}) THEN 1 ELSE 0 END${tail}`;
}

function firstUnquotedChar(sql: string, wanted: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
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

function rewriteLimitOffset(sql: string): string {
  // LIMIT n OFFSET m
  sql = sql.replace(/\s+LIMIT\s+(\d+)\s+OFFSET\s+(\d+)\s*$/i, ' OFFSET $2 ROWS FETCH FIRST $1 ROWS ONLY');
  // OFFSET m LIMIT n
  sql = sql.replace(/\s+OFFSET\s+(\d+)\s+LIMIT\s+(\d+)\s*$/i, ' OFFSET $1 ROWS FETCH FIRST $2 ROWS ONLY');
  // LIMIT n
  sql = sql.replace(/\s+LIMIT\s+(\d+)\s*$/i, ' FETCH FIRST $1 ROWS ONLY');
  // OFFSET m
  sql = sql.replace(/\s+OFFSET\s+(\d+)\s*$/i, ' OFFSET $1 ROWS');
  return sql;
}

function rewritePgFunctions(sql: string): string {
  return sql
    .replace(/\bcurrent_schema\s*\(\s*\)/gi, 'CURRENT SCHEMA')
    .replace(/\bnow\s*\(\s*\)/gi, 'CURRENT TIMESTAMP')
    .replace(/\bcurrent_date\s*\(\s*\)/gi, 'CURRENT DATE')
    .replace(/\bcurrent_time\s*\(\s*\)/gi, 'CURRENT TIME')
    .replace(/\btrue\b/gi, 'TRUE')
    .replace(/\bfalse\b/gi, 'FALSE');
}


function ensureDb2SelectSource(sql: string): string {
  if (!/^\s*select\b/i.test(sql)) return sql;
  if (hasTopLevelKeyword(sql, 'from')) return sql;
  if (hasTopLevelKeyword(sql, 'union')) return sql;

  // PostgreSQL permits SELECT <expression> without FROM. Db2 for i requires
  // a row source for many such expressions. SYSIBM.SYSDUMMY1 is the canonical
  // one-row compatibility source and preserves PostgreSQL scalar semantics.
  const clauses = ['where', 'group', 'having', 'order', 'offset', 'fetch'];
  let insertion = sql.length;
  for (const clause of clauses) {
    const pos = topLevelKeywordIndex(sql, clause);
    if (pos >= 0 && pos < insertion) insertion = pos;
  }
  const head = sql.slice(0, insertion).trimEnd();
  const tail = sql.slice(insertion);
  return `${head} FROM SYSIBM.SYSDUMMY1${tail ? ` ${tail.trimStart()}` : ''}`;
}

function hasTopLevelKeyword(sql: string, word: string): boolean {
  return topLevelKeywordIndex(sql, word) >= 0;
}

function topLevelKeywordIndex(sql: string, word: string): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
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
    if (c === '(') { depth++; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); continue; }
    if (depth !== 0) continue;
    if (sql.slice(i, i + word.length).toLowerCase() !== word) continue;
    const before = i === 0 ? '' : sql[i - 1]!;
    const after = sql[i + word.length] ?? '';
    if (!/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after)) return i;
  }
  return -1;
}

function rewriteInformationSchema(sql: string): string {
  return sql
    .replace(/\binformation_schema\.tables\b/gi, 'SYSIBM.TABLES')
    .replace(/\binformation_schema\.columns\b/gi, 'SYSIBM.COLUMNS')
    .replace(/\binformation_schema\.schemata\b/gi, 'SYSIBM.SCHEMATA');
}

function rewritePgCatalog(sql: string): string {
  const namespaces = `(SELECT 50000 + ROW_NUMBER() OVER (ORDER BY SCHEMA_NAME) AS oid, SCHEMA_NAME AS nspname FROM QSYS2.SYSSCHEMAS)`;
  const classes = `(SELECT 100000 + ROW_NUMBER() OVER (ORDER BY TABLE_SCHEMA, TABLE_NAME) AS oid, TABLE_NAME AS relname, 50000 + (SELECT COUNT(*) FROM QSYS2.SYSSCHEMAS N WHERE N.SCHEMA_NAME <= T.TABLE_SCHEMA) AS relnamespace, CASE WHEN TABLE_TYPE='V' THEN 'v' WHEN TABLE_TYPE='M' THEN 'm' ELSE 'r' END AS relkind, 0 AS reltuples FROM QSYS2.SYSTABLES T)`;
  return sql
    .replace(/\bpg_catalog\.pg_namespace\b/gi, namespaces)
    .replace(/(?<![A-Za-z0-9_.])pg_namespace\b/gi, namespaces)
    .replace(/\bpg_catalog\.pg_class\b/gi, classes)
    .replace(/(?<![A-Za-z0-9_.])pg_class\b/gi, classes);
}

function uppercaseUnquotedRelationIdentifiers(sql: string): string {
  // IBM i SQL naming is case-insensitive for unquoted identifiers. This targeted
  // normalizer avoids altering string literals and quoted identifiers.
  const chars = [...sql];
  let inSingle = false, inDouble = false;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "'" && !inDouble) {
      if (inSingle && chars[i + 1] === "'") { i++; continue; }
      inSingle = !inSingle; continue;
    }
    if (chars[i] === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (!inSingle && !inDouble && /[a-z]/.test(chars[i]!)) chars[i] = chars[i]!.toUpperCase();
  }
  return chars.join('');
}

function hasMultipleStatements(sql: string): boolean {
  let inSingle = false, inDouble = false;
  let semicolons = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" && !inDouble) {
      if (inSingle && sql[i + 1] === "'") { i++; continue; }
      inSingle = !inSingle;
    } else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === ';' && !inSingle && !inDouble) semicolons++;
  }
  return semicolons > 1 || (semicolons === 1 && !/;\s*$/.test(sql));
}
