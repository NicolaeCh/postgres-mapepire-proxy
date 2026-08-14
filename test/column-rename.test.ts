import { describe, expect, it } from 'vitest';
import { DdlTableDefinitionRegistry, parsePgAlterTableRenameColumn } from '../src/sql/column-rename.js';

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
