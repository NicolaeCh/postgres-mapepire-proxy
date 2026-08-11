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
}

export function translateSql(input: string, options: TranslateOptions): Translation {
  let sql = input.trim();
  if (!options.allowMultiStatement && hasMultipleStatements(sql)) {
    throw Object.assign(new Error('Multiple SQL statements in one PostgreSQL Query message are disabled'), { sqlstate: '0A000' });
  }
  sql = sql.replace(/;+\s*$/, '');

  const parameterOrder: number[] = [];
  sql = sql.replace(/\$(\d+)/g, (_m, n) => {
    parameterOrder.push(Number(n));
    return '?';
  });

  sql = rewritePgCasts(sql);
  sql = rewriteLimitOffset(sql);
  sql = rewritePgFunctions(sql);

  if (options.informationSchemaRewrite) sql = rewriteInformationSchema(sql);
  if (options.pgCatalogCompat) sql = rewritePgCatalog(sql);

  if (options.uppercaseIdentifiers) sql = uppercaseUnquotedRelationIdentifiers(sql);
  if (options.maxRows > 0 && /^\s*select\b/i.test(sql) && !/\bfetch\s+(first|next)\b/i.test(sql)) {
    sql = `${sql} FETCH FIRST ${Math.trunc(options.maxRows)} ROWS ONLY`;
  }

  return { original: input, sql, kind: classify(sql), parameterOrder };
}

export function reorderParameters(values: unknown[], order: number[]): unknown[] {
  if (!order.length) return values;
  return order.map((oneBased) => values[oneBased - 1] ?? null);
}

function rewritePgCasts(sql: string): string {
  // Conservative common-case conversion. Complex expressions should use CAST explicitly.
  return sql.replace(
    /((?:'[^']*(?:''[^']*)*'|\$\d+|\?|[A-Za-z_][A-Za-z0-9_.]*|\d+(?:\.\d+)?))::([A-Za-z_][A-Za-z0-9_ ]*(?:\([^)]*\))?)/g,
    'CAST($1 AS $2)',
  );
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
