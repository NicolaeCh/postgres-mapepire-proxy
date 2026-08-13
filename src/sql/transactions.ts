export type SavepointAction = 'savepoint' | 'release' | 'rollbackTo';

export interface PgSavepointCommand {
  action: SavepointAction;
  name: string;
}

const IDENTIFIER = '("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)';

/**
 * Parse the PostgreSQL savepoint commands emitted by psycopg and SQLAlchemy.
 *
 * Psycopg 3 nested Transaction contexts use commands such as:
 *   SAVEPOINT "_pg3_1"
 *   RELEASE "_pg3_1"
 *   ROLLBACK TO "_pg3_1"
 *
 * PostgreSQL permits the SAVEPOINT keyword to be omitted from RELEASE and
 * ROLLBACK TO; Db2 for i requires it, so the proxy normalizes both spellings.
 */
export function parsePgSavepointCommand(sql: string): PgSavepointCommand | undefined {
  const compact = sql.trim().replace(/;\s*$/, '').replace(/\s+/g, ' ');

  let match = compact.match(new RegExp(`^SAVEPOINT\\s+${IDENTIFIER}$`, 'i'));
  if (match) return { action: 'savepoint', name: decodePgIdentifier(match[1]!) };

  match = compact.match(new RegExp(`^RELEASE(?:\\s+SAVEPOINT)?\\s+${IDENTIFIER}$`, 'i'));
  if (match) return { action: 'release', name: decodePgIdentifier(match[1]!) };

  match = compact.match(new RegExp(`^ROLLBACK\\s+TO(?:\\s+SAVEPOINT)?\\s+${IDENTIFIER}$`, 'i'));
  if (match) return { action: 'rollbackTo', name: decodePgIdentifier(match[1]!) };

  return undefined;
}

/** Translate a PostgreSQL savepoint command to Db2 for i SQL. */
export function translatePgSavepointToDb2(command: PgSavepointCommand): string {
  const name = quoteDb2Identifier(command.name);
  switch (command.action) {
    case 'savepoint':
      // Db2 for i SAVEPOINT syntax requires the cursor-retention clause.
      return `SAVEPOINT ${name} ON ROLLBACK RETAIN CURSORS`;
    case 'release':
      return `RELEASE SAVEPOINT ${name}`;
    case 'rollbackTo':
      return `ROLLBACK TO SAVEPOINT ${name}`;
  }
}

export function savepointCommandTag(action: SavepointAction): string {
  switch (action) {
    case 'savepoint': return 'SAVEPOINT';
    case 'release': return 'RELEASE';
    case 'rollbackTo': return 'ROLLBACK';
  }
}

function decodePgIdentifier(token: string): string {
  if (token.startsWith('"')) return token.slice(1, -1).replaceAll('""', '"');
  // PostgreSQL folds unquoted identifiers to lower case. Quote the normalized
  // name on the Db2 side so the same logical name is used on every command.
  return token.toLowerCase();
}

function quoteDb2Identifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
