import { describe, expect, it } from 'vitest';
import { translateSql, reorderParameters } from '../src/sql/translator.js';

const opts = {
  uppercaseIdentifiers: true,
  informationSchemaRewrite: true,
  pgCatalogCompat: true,
  allowMultiStatement: false,
  maxRows: 0,
};

describe('SQL translation', () => {
  it('converts LIMIT/OFFSET', () => {
    expect(translateSql('select * from mylib.orders limit 10 offset 20', opts).sql)
      .toBe('SELECT * FROM MYLIB.ORDERS OFFSET 20 ROWS FETCH FIRST 10 ROWS ONLY');
  });
  it('converts positional parameters', () => {
    const t = translateSql('select * from t where b=$2 and a=$1', opts);
    expect(t.sql).toContain('B=?');
    expect(reorderParameters(['A','B'], t.parameterOrder)).toEqual(['B','A']);
  });
  it('rewrites information_schema', () => {
    expect(translateSql('select * from information_schema.tables', opts).sql).toContain('SYSIBM.TABLES');
  });

  it('adds SYSIBM.SYSDUMMY1 for PostgreSQL scalar SELECT without FROM', () => {
    expect(translateSql('select now() as ts', opts).sql)
      .toBe('SELECT CURRENT TIMESTAMP AS TS FROM SYSIBM.SYSDUMMY1');
  });

  it('inserts SYSIBM.SYSDUMMY1 before WHERE/GROUP/HAVING clauses', () => {
    expect(translateSql('select 1 as ok where 1=1', opts).sql)
      .toBe('SELECT 1 AS OK FROM SYSIBM.SYSDUMMY1 WHERE 1=1');
    expect(translateSql('select count(*) as c group by 1 having count(*) > 0', opts).sql)
      .toMatch(/^SELECT COUNT\(\*\) AS C FROM SYSIBM\.SYSDUMMY1 GROUP BY 1 HAVING COUNT\(\*\) > 0$/i);
  });
  it('rejects multiple statements', () => {
    expect(() => translateSql('select 1; delete from x', opts)).toThrow(/Multiple SQL/);
  });
});
