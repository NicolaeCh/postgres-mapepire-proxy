import { describe, expect, it } from 'vitest';
import {
  parsePgSavepointCommand,
  savepointCommandTag,
  translatePgSavepointToDb2,
} from '../src/sql/transactions.js';

describe('psycopg savepoint compatibility', () => {
  it('maps psycopg nested transaction commands to Db2 for i', () => {
    const savepoint = parsePgSavepointCommand('SAVEPOINT "_pg3_1"')!;
    expect(savepoint).toEqual({ action: 'savepoint', name: '_pg3_1' });
    expect(translatePgSavepointToDb2(savepoint)).toBe(
      'SAVEPOINT "_pg3_1" ON ROLLBACK RETAIN CURSORS',
    );
    expect(savepointCommandTag(savepoint.action)).toBe('SAVEPOINT');

    const release = parsePgSavepointCommand('RELEASE "_pg3_1"')!;
    expect(translatePgSavepointToDb2(release)).toBe('RELEASE SAVEPOINT "_pg3_1"');
    expect(savepointCommandTag(release.action)).toBe('RELEASE');

    const rollback = parsePgSavepointCommand('ROLLBACK TO "_pg3_1"')!;
    expect(translatePgSavepointToDb2(rollback)).toBe('ROLLBACK TO SAVEPOINT "_pg3_1"');
    expect(savepointCommandTag(rollback.action)).toBe('ROLLBACK');
  });

  it('accepts explicit SAVEPOINT keywords and normalizes unquoted names', () => {
    expect(translatePgSavepointToDb2(parsePgSavepointCommand('RELEASE SAVEPOINT Foo')!))
      .toBe('RELEASE SAVEPOINT "foo"');
    expect(translatePgSavepointToDb2(parsePgSavepointCommand('ROLLBACK TO SAVEPOINT Foo')!))
      .toBe('ROLLBACK TO SAVEPOINT "foo"');
  });
});
