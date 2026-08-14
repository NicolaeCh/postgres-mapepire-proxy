# Build / compatibility fix 0.1.31

## Problem

Live IBM i execution proved that `ALTER TABLE ... RENAME COLUMN ...` is not part of the Db2 for i ALTER TABLE grammar. Release 0.1.30 therefore still failed with SQL0199 even though the PostgreSQL shorthand had been normalized to an explicit `COLUMN` clause.

## General compatibility solution

The proxy now intercepts PostgreSQL column-renames before generic SQL translation. If the exact translated CREATE TABLE definition is available in the session DDL registry, it creates a replacement definition where only the SQL column name changes and the existing IBM i system column name is retained using `FOR COLUMN`.

Example:

```sql
ALTER TABLE tools RENAME is_active TO enabled
```

is planned as:

```sql
CREATE OR REPLACE TABLE TOOLS (
  ...,
  ENABLED FOR COLUMN IS_ACTIVE BOOLEAN NOT NULL,
  ...
) ON REPLACE PRESERVE ROWS
```

IBM i compares the replacement definition with the existing table and applies the recognized definition changes while preserving rows. Keeping the system column name stable is what distinguishes the operation from a drop/add column.

## Safety boundary

The proxy does not emulate rename with `ADD COLUMN`, `UPDATE`, and `DROP COLUMN`. If it does not have an exact table definition or cannot resolve the IBM i `SYSTEM_COLUMN_NAME`, it returns PostgreSQL SQLSTATE `0A000` with a diagnostic. This is preferable to silently losing defaults, identities, generated expressions, constraints, indexes, or dependent-object semantics.

The IBM i column catalog query now includes `SYSTEM_COLUMN_NAME`. The DDL and foreign-key type registries also take transaction snapshots so a PostgreSQL rollback restores the pre-transaction compatibility state.

## Validation

The container build runs `scripts/verify-postgres-alter-table.mjs`. It verifies:

- PostgreSQL omitted and explicit `COLUMN` rename forms;
- CREATE OR REPLACE / ON REPLACE PRESERVE ROWS generation;
- `new_sql_name FOR COLUMN old_system_name` preservation;
- preservation of table constraints in the remembered definition;
- subsequent ALTER TABLE ADD COLUMN tracking;
- quoted/schema-qualified parsing;
- refusal to invent a definition for unknown existing tables;
- DDL-registry rollback after a failed transaction.

Live IBM i execution remains the final acceptance test for dependency-specific IBM i restrictions.
