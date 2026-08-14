import { describe, expect, it } from 'vitest';
import { decideLobIndexCompatibility, isDb2LobType, parsePgSimpleCreateIndex } from '../src/sql/lob-index.js';

describe('PostgreSQL simple index / Db2 LOB compatibility', () => {
  it('parses SQLAlchemy simple B-tree index DDL', () => {
    expect(parsePgSimpleCreateIndex('CREATE INDEX idx_tools_tags ON tools (tags)')).toEqual({
      original: 'CREATE INDEX idx_tools_tags ON tools (tags)',
      unique: false,
      indexSchema: undefined,
      indexName: 'IDX_TOOLS_TAGS',
      tableSchema: undefined,
      tableName: 'TOOLS',
      columns: ['TAGS'],
    });
  });

  it('recognizes unique/schema-qualified/simple ordered indexes', () => {
    const parsed = parsePgSimpleCreateIndex(
      'CREATE UNIQUE INDEX "Ix" ON "App"."Items" ("payload" DESC NULLS LAST, id ASC)',
    );
    expect(parsed?.unique).toBe(true);
    expect(parsed?.indexName).toBe('Ix');
    expect(parsed?.tableSchema).toBe('App');
    expect(parsed?.tableName).toBe('Items');
    expect(parsed?.columns).toEqual(['payload', 'ID']);
  });

  it('does not classify expression/partial indexes as skippable simple indexes', () => {
    expect(parsePgSimpleCreateIndex('CREATE INDEX ix ON tools ((lower(name)))')).toBeUndefined();
    expect(parsePgSimpleCreateIndex('CREATE INDEX ix ON tools (tags) WHERE enabled')).toBeUndefined();
  });


  it('skips only non-unique LOB-backed indexes in compatibility mode', () => {
    const plain = parsePgSimpleCreateIndex('CREATE INDEX idx_tools_tags ON tools (tags)')!;
    expect(decideLobIndexCompatibility(plain, [{ column: 'TAGS', type: 'CLOB(2G) CCSID 1208' }], 'skip').action).toBe('skip');
    expect(decideLobIndexCompatibility(plain, [{ column: 'TAGS', type: 'CLOB(2G) CCSID 1208' }], 'error').action).toBe('error');
    expect(decideLobIndexCompatibility(plain, [{ column: 'TAGS', type: 'VARCHAR(1024)' }], 'skip').action).toBe('pass');

    const unique = parsePgSimpleCreateIndex('CREATE UNIQUE INDEX uq_tools_tags ON tools (tags)')!;
    expect(decideLobIndexCompatibility(unique, [{ column: 'TAGS', type: 'CLOB(2G) CCSID 1208' }], 'skip').action).toBe('error');
  });

  it('recognizes Db2 types that cannot be direct index keys', () => {
    expect(isDb2LobType('CLOB(2G) CCSID 1208')).toBe(true);
    expect(isDb2LobType('BLOB(2G)')).toBe(true);
    expect(isDb2LobType('XML')).toBe(true);
    expect(isDb2LobType('DATALINK')).toBe(true);
    expect(isDb2LobType('VARCHAR(1024)')).toBe(false);
  });
});
