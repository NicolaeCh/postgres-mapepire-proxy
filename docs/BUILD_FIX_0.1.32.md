# Build / compatibility fix 0.1.32

Release 0.1.32 addresses PostgreSQL JSON/JSONB defaults and unsupported direct LOB indexes on Db2 for i.

## JSON/JSONB storage and defaults

The proxy represents PostgreSQL `JSON`/`JSONB` columns as `CLOB(2G) CCSID 1208`. PostgreSQL casts must therefore be normalized consistently with the storage type. For example:

```sql
ALTER TABLE tools ADD COLUMN tags JSONB DEFAULT '[]'::jsonb
```

is translated to:

```sql
ALTER TABLE TOOLS ADD COLUMN TAGS CLOB(2G) CCSID 1208 DEFAULT CLOB('[]')
```

The same conversion applies to simple DML casts such as `$1::jsonb` and `'{}'::json`.

The `::type` parser is deliberately bounded to known PostgreSQL type shapes so a following keyword such as `WHERE` is not accidentally consumed as part of the cast target.

## Non-unique LOB-backed indexes

Db2 for i does not allow LOB/XML/DATALINK columns as direct index keys. This matters when a PostgreSQL application creates an ordinary non-unique B-tree index on a `JSONB`/`TEXT` column represented by the proxy as CLOB.

`SQL_UNSUPPORTED_NONUNIQUE_LOB_INDEX_POLICY` controls the compatibility behavior:

- `skip` (default): acknowledge the PostgreSQL non-unique index DDL, log a prominent warning, and do not create a lossy or semantically misleading IBM i physical index.
- `error`: return SQLSTATE `0A000` and require the application/deployment to choose an IBM i-specific access path.

The proxy never skips `UNIQUE` indexes because doing so would remove data-integrity semantics.

Expression, partial, INCLUDE, operator-class, and other complex indexes are not classified by this fallback and continue through normal translation/backend validation.
