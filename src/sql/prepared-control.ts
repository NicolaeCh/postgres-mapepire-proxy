export interface PgDeallocateCommand {
  action: 'all' | 'one';
  name?: string;
}

/**
 * Parse PostgreSQL SQL-level DEALLOCATE commands.
 *
 * psycopg uses DEALLOCATE ALL after ROLLBACK when invalidating its prepared
 * statement cache.  Db2 has a different DEALLOCATE grammar (descriptors), so
 * this command must be consumed by the PostgreSQL session layer and must never
 * be forwarded to IBM i.
 */
export function parsePgDeallocate(sql: string): PgDeallocateCommand | undefined {
  const text = sql.trim().replace(/;+\s*$/, '');
  const match = /^DEALLOCATE(?:\s+PREPARE)?\s+(.+)$/i.exec(text);
  if (!match) return undefined;

  const token = match[1]!.trim();
  if (/^ALL$/i.test(token)) return { action: 'all' };

  const name = parseIdentifier(token);
  if (name === undefined) return undefined;
  return { action: 'one', name };
}

function parseIdentifier(token: string): string | undefined {
  if (/^"(?:[^"]|"")*"$/.test(token)) {
    return token.slice(1, -1).replace(/""/g, '"');
  }
  if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(token)) return token.toLowerCase();
  return undefined;
}
