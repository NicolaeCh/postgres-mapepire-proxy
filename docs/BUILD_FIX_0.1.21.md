# Compatibility Fix 0.1.21 — ContextForge Alembic DDL types

ContextForge v1.0.7 reaches Alembic after the SQLAlchemy, savepoint, and advisory-lock compatibility stages. Its base migration uses PostgreSQL DDL forms that are not directly persistent Db2 for i types. Release 0.1.21 adds scoped CREATE/ALTER TABLE type rewriting and redacted translated-DDL failure diagnostics.

Default mapping:

- `VARCHAR` → `VARCHAR(1024)` (configurable with `SQL_DDL_DEFAULT_VARCHAR_LENGTH`)
- `VARCHAR(n)` → unchanged
- `JSON` / `JSONB` → `CLOB(2G) CCSID 1208`
- `TEXT` → `CLOB(2G) CCSID 1208`
- `BYTEA` → `BLOB(2G)`
- `TIMESTAMP WITH TIME ZONE` → `TIMESTAMP`
- `TIME WITH TIME ZONE` → `TIME`

The mapping is restricted to table DDL so PostgreSQL compatibility/catalog expressions are not modified.
