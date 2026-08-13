import { syntheticPgTypes, OID } from '../postgres/oids.js';
import type { SyntheticResult } from './environment.js';

export function syntheticCatalog(sql: string): SyntheticResult | undefined {
  const s = sql.replace(/\s+/g, ' ').trim();

  // psycopg TypeInfo.fetch() probes optional PostgreSQL extension types (SQLAlchemy
  // asks for hstore during dialect initialization). The query shape expects a
  // five-column record keyed as name/oid/array_oid/regtype/delimiter. IBM i has
  // no PostgreSQL hstore extension, so an exact empty rowset is the correct
  // compatibility result. Handle this before the generic pg_type enumerator.
  if (/\b(?:pg_catalog\.)?pg_type\b/i.test(s)
      && /\btypname\s+as\s+name\b/i.test(s)
      && /\btyparray\s+as\s+array_oid\b/i.test(s)
      && /\b(?:to_regtype\s*\(|::\s*regtype\b)/i.test(s)) {
    return {
      fields: [
        { name: 'name', typeOid: OID.text, typeSize: -1 },
        { name: 'oid', typeOid: OID.oid, typeSize: 4 },
        { name: 'array_oid', typeOid: OID.oid, typeSize: 4 },
        { name: 'regtype', typeOid: OID.text, typeSize: -1 },
        { name: 'delimiter', typeOid: OID.char, typeSize: 1 },
      ],
      rows: [],
      tag: 'SELECT 0',
    };
  }

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
