import type { QueryResult } from '@ibm/mapepire-js';
import type { SQLJobInstance } from './sdk.js';

export interface IbmiSchemaCapabilities {
  schema: string;
  /** IBM i 10-character system library name backing this SQL schema. */
  systemSchema?: string;
  exists: boolean;
  /** Exact signal for an IBM i SQL schema/collection journal. */
  hasQsqjrn: boolean | null;
  /** Exact signal for STRJRNLIB-style inherited journaling when visible. */
  hasLibraryJournalInheritance: boolean | null;
  inheritedJournal?: string;
  /**
   * True when the proxy can positively identify automatic journaling for newly
   * created tables (QSQJRN or library inheritance), false when neither is
   * configured, null when authorization/probing prevents a firm answer.
   */
  transactionalWritesConfigured: boolean | null;
  /** Backward-compatible alias retained for 0.1.25 health payloads. */
  sqlSchemaJournalReady: boolean | null;
  checkedAt: string;
  probeError?: string;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function firstScalar(result: QueryResult<Record<string, unknown>>): unknown {
  const row = result.data?.[0];
  if (!row) return undefined;
  return Object.values(row)[0];
}

function asCount(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(String(value ?? '0').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function ci(row: Record<string, unknown> | undefined, key: string): unknown {
  if (!row) return undefined;
  const match = Object.keys(row).find((name) => name.toUpperCase() === key.toUpperCase());
  return match ? row[match] : undefined;
}

/**
 * Inspect an IBM i application schema without changing it.
 *
 * There are two broad ways IBM i can automatically journal newly created SQL
 * tables under commitment control:
 *   1. an SQL schema/collection journal named QSQJRN exists in the schema;
 *   2. library journaling inheritance (STRJRNLIB) is configured.
 *
 * The first signal can be checked without opening a journal. The second is
 * exposed through QSYS2.JOURNALED_OBJECTS and may require journal authority.
 * A probe authorization failure is therefore reported as unknown, not false.
 */
export async function inspectIbmiSchema(
  job: SQLJobInstance,
  schema: string,
): Promise<IbmiSchemaCapabilities> {
  const normalized = schema.trim();
  const literal = quoteLiteral(normalized);
  const checkedAt = new Date().toISOString();

  const schemaResult = await job.execute(
    `SELECT SCHEMA_NAME, SYSTEM_SCHEMA_NAME
` +
    `  FROM QSYS2.SYSSCHEMAS
` +
    ` WHERE SCHEMA_NAME = ${literal}
` +
    ` FETCH FIRST 1 ROW ONLY`,
  ) as QueryResult<Record<string, unknown>>;
  const schemaRow = schemaResult.data?.[0];
  const exists = Boolean(schemaRow);
  if (!exists) {
    return {
      schema: normalized,
      exists: false,
      hasQsqjrn: false,
      hasLibraryJournalInheritance: false,
      transactionalWritesConfigured: false,
      sqlSchemaJournalReady: false,
      checkedAt,
    };
  }

  const systemSchema = String(ci(schemaRow, 'SYSTEM_SCHEMA_NAME') ?? normalized).trim() || normalized;
  const systemLiteral = quoteLiteral(systemSchema);

  let hasQsqjrn: boolean | null = null;
  let inheritance: boolean | null = null;
  let inheritedJournal: string | undefined;
  const errors: string[] = [];

  try {
    const journalResult = await job.execute(
      `SELECT COUNT(*) AS JOURNAL_COUNT\n` +
      `  FROM TABLE(QSYS2.OBJECT_STATISTICS(${systemLiteral}, '*JRN', '*ALLSIMPLE')) X\n` +
      ` WHERE UPPER(OBJNAME) = 'QSQJRN'`,
    ) as QueryResult<Record<string, unknown>>;
    hasQsqjrn = asCount(firstScalar(journalResult)) > 0;
  } catch (error) {
    errors.push(`QSQJRN probe: ${String((error as Error)?.message ?? error)}`);
  }

  try {
    const inheritResult = await job.execute(
      `SELECT JOURNAL_LIBRARY, JOURNAL_NAME, INHERIT\n` +
      `  FROM QSYS2.JOURNALED_OBJECTS\n` +
      ` WHERE OBJECT_TYPE = '*LIB'\n` +
      `   AND UPPER(OBJECT_NAME) = UPPER(${systemLiteral})\n` +
      `   AND INHERIT = '*YES'\n` +
      ` FETCH FIRST 1 ROW ONLY`,
    ) as QueryResult<Record<string, unknown>>;
    const row = inheritResult.data?.[0];
    inheritance = Boolean(row);
    if (row) {
      const lib = String(ci(row, 'JOURNAL_LIBRARY') ?? '').trim();
      const name = String(ci(row, 'JOURNAL_NAME') ?? '').trim();
      if (lib && name) inheritedJournal = `${lib}/${name}`;
    }
  } catch (error) {
    inheritance = null;
    errors.push(`library journaling probe: ${String((error as Error)?.message ?? error)}`);
  }

  let transactionalWritesConfigured: boolean | null;
  if (hasQsqjrn === true || inheritance === true) transactionalWritesConfigured = true;
  else if (hasQsqjrn === false && inheritance === false) transactionalWritesConfigured = false;
  else transactionalWritesConfigured = null;

  return {
    schema: normalized,
    systemSchema,
    exists: true,
    hasQsqjrn,
    hasLibraryJournalInheritance: inheritance,
    inheritedJournal,
    transactionalWritesConfigured,
    sqlSchemaJournalReady: hasQsqjrn,
    checkedAt,
    probeError: errors.length > 0 ? errors.join('; ') : undefined,
  };
}
