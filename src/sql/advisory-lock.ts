import { OID } from '../postgres/oids.js';
import type { FieldDescription } from '../postgres/wire.js';
import type { SyntheticResult } from './environment.js';

export type PgAdvisoryLockAction = 'tryLock' | 'unlock' | 'unlockAll';

export interface PgAdvisoryLockQuery {
  action: PgAdvisoryLockAction;
  key?: string;
  fieldName: string;
}

interface HeldLock {
  owner: object;
  count: number;
}

// PostgreSQL advisory locks are session-scoped. ContextForge workers are
// separate PostgreSQL client sessions but all of them connect through this
// proxy process, so a process-global registry accurately serializes those
// sessions. Locks are released explicitly by pg_advisory_unlock() or
// automatically when the owning ProxySession closes.
const heldLocks = new Map<string, HeldLock>();

export function parsePgAdvisoryLockQuery(sql: string): PgAdvisoryLockQuery | undefined {
  const s = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .trim()
    .replace(/;+\s*$/, '')
    .replace(/\s+/g, ' ');

  let m = s.match(
    /^select\s+(?:pg_catalog\.)?(pg_try_advisory_lock|pg_advisory_unlock)\s*\(\s*([^)]*?)\s*\)(?:\s+as\s+(?:"([^"]+)"|([a-z_][a-z0-9_$]*)))?$/i,
  );
  if (m) {
    const fn = m[1]!.toLowerCase();
    const key = parseAdvisoryKey(m[2]!);
    if (!key) return undefined;
    return {
      action: fn === 'pg_try_advisory_lock' ? 'tryLock' : 'unlock',
      key,
      fieldName: m[3] ?? m[4] ?? fn,
    };
  }

  m = s.match(
    /^select\s+(?:pg_catalog\.)?pg_advisory_unlock_all\s*\(\s*\)(?:\s+as\s+(?:"([^"]+)"|([a-z_][a-z0-9_$]*)))?$/i,
  );
  if (m) {
    return {
      action: 'unlockAll',
      fieldName: m[1] ?? m[2] ?? 'pg_advisory_unlock_all',
    };
  }

  return undefined;
}

export function pgAdvisoryLockFields(query: PgAdvisoryLockQuery): FieldDescription[] {
  // pg_try_advisory_lock() and pg_advisory_unlock() return boolean. The
  // unlock_all function is PostgreSQL void; represent it as text/NULL if a
  // client explicitly selects it. ContextForge only uses the boolean forms.
  return query.action === 'unlockAll'
    ? [{ name: query.fieldName, typeOid: OID.text, typeSize: -1 }]
    : [{ name: query.fieldName, typeOid: OID.bool, typeSize: 1 }];
}

export function executePgAdvisoryLockQuery(query: PgAdvisoryLockQuery, owner: object): SyntheticResult {
  if (query.action === 'unlockAll') {
    releaseAllPgAdvisoryLocks(owner);
    return {
      fields: pgAdvisoryLockFields(query),
      rows: [[null]],
      tag: 'SELECT 1',
    };
  }

  const key = query.key!;
  if (query.action === 'tryLock') {
    const held = heldLocks.get(key);
    if (!held) {
      heldLocks.set(key, { owner, count: 1 });
      return booleanResult(query, true);
    }
    if (held.owner === owner) {
      held.count++;
      return booleanResult(query, true);
    }
    return booleanResult(query, false);
  }

  const held = heldLocks.get(key);
  if (!held || held.owner !== owner) return booleanResult(query, false);
  if (held.count > 1) held.count--;
  else heldLocks.delete(key);
  return booleanResult(query, true);
}

export function releaseAllPgAdvisoryLocks(owner: object): number {
  let released = 0;
  for (const [key, held] of heldLocks.entries()) {
    if (held.owner !== owner) continue;
    heldLocks.delete(key);
    released++;
  }
  return released;
}

export function pgAdvisoryLockRegistrySize(): number {
  return heldLocks.size;
}

function booleanResult(query: PgAdvisoryLockQuery, value: boolean): SyntheticResult {
  return {
    fields: pgAdvisoryLockFields(query),
    rows: [[value]],
    tag: 'SELECT 1',
  };
}

function parseAdvisoryKey(argsText: string): string | undefined {
  const args = argsText.split(',').map((part) => part.trim());
  if (args.length === 1 && /^[+-]?\d+$/.test(args[0] ?? '')) {
    try {
      return `bigint:${BigInt(args[0]!).toString()}`;
    } catch {
      return undefined;
    }
  }
  if (args.length === 2 && args.every((part) => /^[+-]?\d+$/.test(part))) {
    try {
      const a = BigInt(args[0]!);
      const b = BigInt(args[1]!);
      if (a < -2147483648n || a > 2147483647n || b < -2147483648n || b > 2147483647n) return undefined;
      return `int4pair:${a.toString()}:${b.toString()}`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
