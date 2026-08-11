import { syntheticPgTypes, OID } from '../postgres/oids.js';
import type { SyntheticResult } from './environment.js';

export function syntheticCatalog(sql: string): SyntheticResult | undefined {
  const s = sql.replace(/\s+/g, ' ').trim();

  // Sufficient for direct type enumeration and many lightweight metadata probes.
  if (/\b(?:pg_catalog\.)?pg_type\b/i.test(s) && !/\bjoin\b/i.test(s)) {
    return {
      fields: [
        { name: 'oid', typeOid: OID.oid, typeSize: 4 },
        { name: 'typname', typeOid: OID.text, typeSize: -1 },
        { name: 'typlen', typeOid: OID.int2, typeSize: 2 },
        { name: 'typtype', typeOid: OID.char, typeSize: 1 },
        { name: 'typcategory', typeOid: OID.char, typeSize: 1 },
      ],
      rows: syntheticPgTypes.map((t) => [t.oid, t.typname, t.typlen, 'b', category(t.typname)]),
      tag: `SELECT ${syntheticPgTypes.length}`,
    };
  }
  return undefined;
}

function category(name: string): string {
  if (name.startsWith('int') || name.startsWith('float') || name === 'numeric') return 'N';
  if (['date','time','timestamp'].includes(name)) return 'D';
  if (name === 'bool') return 'B';
  if (name === 'bytea') return 'U';
  return 'S';
}
