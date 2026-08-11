import { Parser } from 'node-sql-parser';
const parser = new Parser();

export type StatementKind =
  | 'select' | 'insert' | 'update' | 'delete' | 'merge'
  | 'ddl' | 'call' | 'values' | 'begin' | 'commit' | 'rollback'
  | 'set' | 'show' | 'other';

export function classify(sql: string): StatementKind {
  const s = sql.trim().replace(/^\(+/, '').trimStart();
  const first = s.match(/^([A-Za-z]+)/)?.[1]?.toLowerCase() ?? '';
  if (first === 'begin' || (first === 'start' && /\btransaction\b/i.test(s))) return 'begin';
  if (first === 'commit' || first === 'end') return 'commit';
  if (first === 'rollback') return 'rollback';
  if (first === 'set') return 'set';
  if (first === 'show') return 'show';
  if (first === 'values') return 'values';
  if (['select','insert','update','delete','merge','call'].includes(first)) return first as StatementKind;
  if (['create','alter','drop','truncate','comment','grant','revoke'].includes(first)) return 'ddl';

  try {
    const ast: any = parser.astify(sql, { database: 'Postgresql' });
    const node = Array.isArray(ast) ? ast[0] : ast;
    const t = String(node?.type ?? '').toLowerCase();
    if (['select','insert','update','delete'].includes(t)) return t as StatementKind;
  } catch { /* fallback above is intentionally permissive */ }
  return 'other';
}

export function isIdempotentRead(kind: StatementKind): boolean {
  return kind === 'select' || kind === 'values' || kind === 'show';
}
