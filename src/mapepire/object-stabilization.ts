/**
 * Detect the two transient IBM i object states observed while ALTER TABLE /
 * CREATE OR REPLACE TABLE is rebuilding a backing *FILE.
 */
export function isTransientIbmiObjectStateError(error: unknown, sql: string): boolean {
  const text = String((error as any)?.message ?? error);

  if (/\bSQL0443\b/i.test(text) && /\bFILE\s+NOT\s+FOUND\s+YET\b/i.test(text)) return true;

  if (!/\bSQL0204\b/i.test(text) || !/\btype\s+\*FILE\s+not\s+found\b/i.test(text)) return false;

  const missingMatch = /\[SQL0204\]\s+([^\s]+)\s+in\s+([^\s]+)\s+type\s+\*FILE\s+not\s+found/i.exec(text);
  if (!missingMatch) return false;
  const target = ddlTargetName(sql);
  if (!target) return false;

  const missing = normalizeName(missingMatch[1]!);
  // If IBM i reports a generated 10-character *FILE different from the SQL
  // target (for example EMAIL_TEAMS -> EMAIL00003), the system object can be
  // between alter phases. Restrict the retry to the characteristic generated
  // name shape so a genuinely missing FK/reference table is not masked.
  const looksGenerated = missing.length === 10 && /\d{4,5}$/.test(missing);
  return looksGenerated && missing !== normalizeName(target);
}

export function ibmiObjectStabilizationDelayMs(attempt: number): number {
  const n = Math.max(1, Math.trunc(attempt));
  return Math.min(800, 50 * (2 ** Math.min(n - 1, 4)));
}

function ddlTargetName(sql: string): string | undefined {
  const ident = String.raw`(?:(?:"(?:[^"]|"")*")|(?:[A-Za-z_][A-Za-z0-9_$#@]*))`;
  const match = new RegExp(
    String.raw`\b(?:ALTER\s+TABLE|CREATE\s+(?:OR\s+REPLACE\s+)?TABLE|RENAME\s+TABLE)\s+(${ident})(?:\s*\.\s*(${ident}))?`,
    'i',
  ).exec(sql);
  const token = match?.[2] ?? match?.[1];
  return token ? unquoteIdentifier(token) : undefined;
}

function unquoteIdentifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).replace(/""/g, '"');
  return trimmed.toUpperCase();
}

function normalizeName(value: string): string {
  return unquoteIdentifier(value).toUpperCase();
}
