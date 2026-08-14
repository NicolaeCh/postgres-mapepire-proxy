import { describe, expect, it } from 'vitest';
import { environmentQuery } from '../src/sql/environment.js';

const database = 'SEIDOR76';
const currentSchema = 'MONAI';

function env(sql: string) {
  const result = environmentQuery(sql, database, currentSchema);
  expect(result, `query should be virtualized: ${sql}`).toBeDefined();
  return result!;
}

describe('SQLAlchemy PostgreSQL dialect bootstrap compatibility', () => {
  it('returns a non-null PostgreSQL version string for pg_catalog.version()', () => {
    const result = env('SELECT pg_catalog.version()');
    expect(result.fields.map((field) => field.name)).toEqual(['version']);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.[0]).toEqual(expect.any(String));
    expect(String(result.rows[0]?.[0])).toMatch(/PostgreSQL\s+\d+(?:\.\d+)?/i);
  });

  it('supports the remaining SQLAlchemy 2.0 PostgreSQL initialize probes', () => {
    expect(env('SELECT current_schema()').rows).toEqual([[currentSchema]]);
    expect(env('SELECT current_schema').rows).toEqual([[currentSchema]]);
    expect(env("SELECT current_setting('search_path')").rows).toEqual([[currentSchema]]);
    expect(env('SELECT current_schemas(false)').rows).toEqual([[`{"${currentSchema}"}`]]);
    expect(env('SELECT current_schemas(true)').rows).toEqual([[`{"pg_catalog","${currentSchema}"}`]]);
    expect(env('SHOW transaction isolation level').rows).toEqual([['read committed']]);
    expect(env('SHOW standard_conforming_strings').rows).toEqual([['on']]);
  });
});
