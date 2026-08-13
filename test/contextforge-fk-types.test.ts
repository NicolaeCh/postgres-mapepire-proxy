import { describe, expect, it } from 'vitest';
import { DdlForeignKeyTypeRegistry } from '../src/sql/ddl-foreign-key.js';

describe('ContextForge foreign-key datatype alignment', () => {
  it('aligns unbounded server_id VARCHAR to referenced servers.id VARCHAR(36)', () => {
    const registry = new DdlForeignKeyTypeRegistry();
    registry.registerCreateTable(
      'CREATE TABLE SERVERS (ID VARCHAR(36) NOT NULL, CONSTRAINT PK_SERVERS PRIMARY KEY (ID))',
      'MCPDATA',
    );
    const result = registry.alignCreateTable(
      'CREATE TABLE SERVER_METRICS (ID INTEGER NOT NULL, SERVER_ID VARCHAR(1024) NOT NULL, CONSTRAINT FK_SERVER_METRICS_SERVER_ID FOREIGN KEY(SERVER_ID) REFERENCES SERVERS (ID))',
      'MCPDATA',
    );
    expect(result.sql).toContain('SERVER_ID VARCHAR(36) NOT NULL');
    expect(result.alignments).toHaveLength(1);
  });

  it('does not rewrite an already matching foreign-key datatype', () => {
    const registry = new DdlForeignKeyTypeRegistry();
    registry.registerCreateTable(
      'CREATE TABLE MCP_SESSIONS (SESSION_ID VARCHAR(1024) NOT NULL, PRIMARY KEY (SESSION_ID))',
      'MCPDATA',
    );
    const result = registry.alignCreateTable(
      'CREATE TABLE MCP_MESSAGES (SESSION_ID VARCHAR(1024) NOT NULL, FOREIGN KEY(SESSION_ID) REFERENCES MCP_SESSIONS (SESSION_ID))',
      'MCPDATA',
    );
    expect(result.sql).toContain('SESSION_ID VARCHAR(1024) NOT NULL');
    expect(result.alignments).toHaveLength(0);
  });
});
