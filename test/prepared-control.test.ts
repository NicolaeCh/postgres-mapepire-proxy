import { describe, expect, it } from 'vitest';
import { parsePgDeallocate } from '../src/sql/prepared-control.js';

describe('PostgreSQL prepared-statement maintenance', () => {
  it('recognizes psycopg DEALLOCATE ALL', () => {
    expect(parsePgDeallocate('DEALLOCATE ALL')).toEqual({ action: 'all' });
    expect(parsePgDeallocate('deallocate prepare all;')).toEqual({ action: 'all' });
  });

  it('parses named statements with PostgreSQL identifier folding', () => {
    expect(parsePgDeallocate('DEALLOCATE _pg3_7')).toEqual({ action: 'one', name: '_pg3_7' });
    expect(parsePgDeallocate('DEALLOCATE PREPARE Foo')).toEqual({ action: 'one', name: 'foo' });
    expect(parsePgDeallocate('DEALLOCATE "MixedCase"')).toEqual({ action: 'one', name: 'MixedCase' });
  });

  it('does not claim Db2/other malformed statements', () => {
    expect(parsePgDeallocate('DEALLOCATE DESCRIPTOR mydesc')).toBeUndefined();
    expect(parsePgDeallocate('SELECT 1')).toBeUndefined();
  });
});
