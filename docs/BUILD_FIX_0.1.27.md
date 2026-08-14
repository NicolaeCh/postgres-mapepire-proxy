# Compatibility fix 0.1.27 — Boolean defaults and DEALLOCATE

## Symptoms

After earlier PostgreSQL/Db2 compatibility fixes, SQLAlchemy/Alembic can reach later application migrations. Two PostgreSQL-specific behaviors then appear:

1. SQLAlchemy renders Boolean server defaults such as `server_default="1"` as `BOOLEAN DEFAULT '1'`. Db2 for i requires the Boolean constants `TRUE` or `FALSE` when a default is specified for a BOOLEAN column and can return SQL0574 / SQLSTATE 42894 otherwise.
2. psycopg 3 clears its prepared statement cache after a rollback by sending `DEALLOCATE ALL`. Db2 uses `DEALLOCATE` for SQL descriptors and rejects PostgreSQL's `ALL` form with SQL0199.

## General proxy behavior

The DDL translator now recognizes Boolean column definitions and normalizes accepted PostgreSQL Boolean spellings to `TRUE` / `FALSE`. The rewrite is scoped to Boolean columns; defaults for numeric and character columns are left unchanged.

The PostgreSQL session layer now parses `DEALLOCATE [PREPARE] name|ALL`. `DEALLOCATE ALL` clears the proxy session's prepared statement and portal registries. Named DEALLOCATE removes the named statement and portals bound to it. These commands never reach IBM i.

## Validation

The container build runs `scripts/verify-postgres-session-control.mjs`, which checks the A2A-style Boolean DDL transformation and a `BEGIN` → `ROLLBACK` → `DEALLOCATE ALL` sequence using a fake backend, asserting that only ROLLBACK reaches Db2.
