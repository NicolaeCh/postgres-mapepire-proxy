import { describe, expect, it } from 'vitest';
import { syntheticCatalog } from '../src/sql/catalog.js';

describe('psycopg TypeInfo compatibility', () => {
  it('returns the exact empty optional-type shape for TypeInfo.fetch(hstore)', () => {
    const result = syntheticCatalog(`
      SELECT typname AS name, oid, typarray AS array_oid,
             oid::regtype::text AS regtype, typdelim AS delimiter
      FROM pg_type t
      WHERE t.oid = to_regtype($1)
      ORDER BY t.oid
    `);
    expect(result).toBeDefined();
    expect(result!.fields.map((f) => f.name)).toEqual([
      'name', 'oid', 'array_oid', 'regtype', 'delimiter',
    ]);
    expect(result!.rows).toEqual([]);
    expect(result!.tag).toBe('SELECT 0');
  });
});
