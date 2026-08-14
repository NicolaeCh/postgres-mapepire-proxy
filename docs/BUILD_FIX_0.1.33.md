# Build / compatibility fix 0.1.33

Release 0.1.33 addresses the next PostgreSQL/SQLAlchemy compatibility gaps exposed after the 0.1.32 JSONB and LOB-index fixes.

## 1. PostgreSQL ADD COLUMN NOT NULL without DEFAULT

PostgreSQL can add a `NOT NULL` column without a default when the table is empty. Db2 for i rejects the direct `ALTER TABLE ... ADD COLUMN ... NOT NULL` form because a normal `NOT NULL` added column requires a default.

The proxy now recognizes this shape after normal PostgreSQL-to-Db2 datatype translation. It probes the table for one row. If a row exists it returns SQLSTATE `23502`. If the table is empty, the proxy executes two IBM i statements in the same PostgreSQL transaction:

```sql
ALTER TABLE "SCHEMA"."TABLE" ADD COLUMN NEW_COLUMN VARCHAR(255);
ALTER TABLE "SCHEMA"."TABLE" ALTER COLUMN NEW_COLUMN SET NOT NULL;
```

This produces the PostgreSQL final definition without introducing a persistent default and does not require the table to have been created in the same proxy session.

The ContextForge v1.0.7 `14ac971cee42` migration is the regression shape:

```sql
ALTER TABLE oauth_tokens ADD COLUMN app_user_email VARCHAR(255) NOT NULL
```

## 2. SQLAlchemy `int2vector` reflection

SQLAlchemy 2.0.51 models PostgreSQL `pg_index.indoption` as its internal `INT2VECTOR`. Its result processor receives PostgreSQL's space-separated textual vector and calls `split(" ")` before converting each element to an integer.

The proxy previously advertised `indoption` as `int2[]` (OID 1005), causing psycopg to decode the value to a Python list first. SQLAlchemy then failed with:

```text
'list' object has no attribute 'split'
```

0.1.33 advertises PostgreSQL OID 22 (`int2vector`) and returns values such as `0` or `0 0`. This fixes `Inspector.get_indexes()` and reflection used by `Table(..., autoload_with=...)`.

## 3. Table rename

Alembic `op.rename_table(old, new)` compiles on PostgreSQL to `ALTER TABLE old RENAME TO new`. IBM i supports table rename through the `RENAME TABLE` statement, so the proxy maps the operation directly and updates its session-local table-definition/type registries.

## 4. Concurrent readers

The Mapepire JDBC option `concurrent access resolution` now defaults to `1` (`use currently committed`). With the proxy's default `read committed` isolation this lets eligible read-only probes use the previously committed row image rather than waiting behind an uncommitted update/delete. `2` requests wait-for-outcome and `3` requests skip-locks behavior.

This is a concurrency improvement, not an advisory-lock bypass. A newly-created uncommitted object has no previous committed object image, so IBM i can still report lock contention in that case.

## Verification

The existing mandatory build gates were strengthened:

```text
SQLAlchemy/Alembic live IBM i reflection compatibility check OK
PostgreSQL column rename -> IBM i CREATE OR REPLACE PRESERVE ROWS compatibility check OK
PostgreSQL ADD NOT NULL / table rename compatibility check OK
```

The ADD NOT NULL verifier asserts the emptiness probe, nullable ADD, SET NOT NULL, and absence of any synthetic DEFAULT. The reflection verifier asserts `pg_index.indoption` OID 22 and PostgreSQL space-vector text.
