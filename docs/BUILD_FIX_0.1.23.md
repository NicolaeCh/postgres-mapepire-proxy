# Build fix 0.1.23

ContextForge v1.0.7 contains several PostgreSQL foreign keys whose SQLAlchemy source column is `sa.String()` while the referenced primary key is `sa.String(length=36)`. PostgreSQL accepts this because both are VARCHAR-compatible, but Db2 for i requires the dependent and parent key column descriptions to match more strictly and returns SQL0538 / SQLSTATE 42830 when the translated child remains `VARCHAR(1024)`.

Version 0.1.23 adds a session-local translated-DDL datatype registry. After a parent `CREATE TABLE` succeeds, its Db2 column datatypes are recorded. Before a later dependent `CREATE TABLE` is sent to IBM i, every table-level `FOREIGN KEY (...) REFERENCES ... (...)` pair is compared with the registered parent key. When the translated datatypes differ, the child datatype is replaced by the exact translated parent datatype while preserving nullability/default/identity attributes.

Example:

```sql
-- Parent translated earlier in the migration
CREATE TABLE SERVERS (
  ID VARCHAR(36) NOT NULL,
  CONSTRAINT PK_SERVERS PRIMARY KEY (ID)
);

-- SQLAlchemy originally emits server_id VARCHAR
-- Generic translation first makes it VARCHAR(1024); FK alignment then makes
-- it match SERVERS.ID before execution on Db2 for i.
CREATE TABLE SERVER_METRICS (
  SERVER_ID VARCHAR(36) NOT NULL,
  CONSTRAINT FK_SERVER_METRICS_SERVER_ID
    FOREIGN KEY (SERVER_ID) REFERENCES SERVERS (ID)
);
```

The same mechanism covers the later ContextForge `server_prompt_association`, `server_resource_association`, `server_tool_association`, and `tool_metrics` relations without table-specific rules.
