import { describe, expect, it } from 'vitest';
import { buildCreateOrReplaceAddColumn, DdlTableDefinitionRegistry, isAlterTableAddNotNullNoDefault,
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
  it('plans NOT NULL without DEFAULT through exact CREATE OR REPLACE DDL', () => {
    const sql = 'ALTER TABLE OAUTH_TOKENS ADD COLUMN APP_USER_EMAIL VARCHAR(255) NOT NULL';
    expect(isAlterTableAddNotNullNoDefault(sql, 'MCPDATA')).toBe(true);
    const plan = planAlterTableAddNotNullNoDefault(sql, 'MCPDATA');
    expect(plan?.probeSql).toBe('SELECT 1 AS PROXY_ROW FROM "MCPDATA"."OAUTH_TOKENS" FETCH FIRST 1 ROW ONLY');
    const generated = 'CREATE OR REPLACE TABLE "MCPDATA"."OAUTH_TOKENS" (ID VARCHAR(36) NOT NULL, CONSTRAINT PK_OAUTH PRIMARY KEY (ID)) RCDFMT OAUTHTOK';
    const replacement = buildCreateOrReplaceAddColumn(generated, plan!, 'MCPDATA');
    expect(replacement).toContain('APP_USER_EMAIL VARCHAR(255) NOT NULL,CONSTRAINT PK_OAUTH');
    expect(replacement).toContain('RCDFMT OAUTHTOK');
    expect(replacement).not.toMatch(/SET\s+NOT\s+NULL|WITH\s+DEFAULT|DROP\s+DEFAULT/i);
  });

  it('maps PostgreSQL table rename to IBM i RENAME TABLE', () => {
    const rename = parsePgAlterTableRenameTable('ALTER TABLE t_tmp RENAME TO t', 'MCPDATA');
    expect(rename?.db2Sql).toBe('RENAME TABLE t_tmp TO T');
  });
});
