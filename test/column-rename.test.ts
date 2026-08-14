import { describe, expect, it } from 'vitest';
import { DdlTableDefinitionRegistry, isAlterTableAddNotNullNoDefault,
  planAlterTableAddNotNullNoDefault, parsePgAlterTableRenameColumn, parsePgAlterTableRenameTable } from '../src/sql/column-rename.js';

describe('IBM i column rename emulation', () => {
  it('preserves the IBM i system column name while changing the SQL name', () => {
    const registry = new DdlTableDefinitionRegistry();
    registry.registerCreateTable(
      'CREATE TABLE TOOLS (ID VARCHAR(36) NOT NULL, IS_ACTIVE BOOLEAN NOT NULL, CONSTRAINT PK_TOOLS PRIMARY KEY (ID))',
      'MCPDATA',
    );
    const request = parsePgAlterTableRenameColumn('ALTER TABLE tools RENAME is_active TO enabled', 'MCPDATA');
    expect(request).toBeDefined();
    const plan = registry.planRename(request!, 'IS_ACTIVE');
    expect(plan?.db2Sql).toContain('ENABLED FOR COLUMN IS_ACTIVE BOOLEAN NOT NULL');
    expect(plan?.db2Sql).toContain('ON REPLACE PRESERVE ROWS');
  });

  it('refuses to invent a definition for an unknown existing table', () => {
    const registry = new DdlTableDefinitionRegistry();
    const request = parsePgAlterTableRenameColumn('ALTER TABLE tools RENAME is_active TO enabled', 'MCPDATA');
    expect(registry.planRename(request!, 'IS_ACTIVE')).toBeUndefined();
  });
});


describe('ALTER TABLE compatibility additions', () => {
  it('plans NOT NULL without DEFAULT as nullable ADD plus SET NOT NULL', () => {
    const sql = 'ALTER TABLE OAUTH_TOKENS ADD COLUMN APP_USER_EMAIL VARCHAR(255) NOT NULL';
    expect(isAlterTableAddNotNullNoDefault(sql, 'MCPDATA')).toBe(true);
    const plan = planAlterTableAddNotNullNoDefault(sql, 'MCPDATA');
    expect(plan?.probeSql).toBe('SELECT 1 AS PROXY_ROW FROM "MCPDATA"."OAUTH_TOKENS" FETCH FIRST 1 ROW ONLY');
    expect(plan?.addNullableSql).toBe('ALTER TABLE "MCPDATA"."OAUTH_TOKENS" ADD COLUMN APP_USER_EMAIL VARCHAR(255)');
    expect(plan?.setNotNullSql).toBe('ALTER TABLE "MCPDATA"."OAUTH_TOKENS" ALTER COLUMN APP_USER_EMAIL SET NOT NULL');
    expect(plan?.addNullableSql).not.toMatch(/DEFAULT/i);
  });

  it('maps PostgreSQL table rename to IBM i RENAME TABLE', () => {
    const rename = parsePgAlterTableRenameTable('ALTER TABLE t_tmp RENAME TO t', 'MCPDATA');
    expect(rename?.db2Sql).toBe('RENAME TABLE t_tmp TO T');
  });
});
