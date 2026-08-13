# Compatibility Fix 0.1.19 — psycopg Nested Transactions / hstore Probe

## Symptom

After 0.1.18 fixes SQLAlchemy's server-version/bootstrap probes, ContextForge v1.0.7 advances further into SQLAlchemy's psycopg dialect initialization and fails with:

```text
psycopg.errors.FeatureNotSupported:
SAVEPOINT, RELEASE SAVEPOINT and ROLLBACK TO SAVEPOINT are not supported by proxy v0.1
```

The traceback shows the failure inside `TypeInfo.fetch(..., "hstore")`. psycopg intentionally wraps this optional-type lookup in `conn.transaction()` so it leaves the connection in the same transaction state it found. If SQLAlchemy already has an implicit transaction open, psycopg implements that nested context using a savepoint such as `_pg3_1`.

The later error:

```text
Explicit rollback() forbidden within a Transaction context
```

is a cascade caused by the failed savepoint creation; it is not a second independent proxy problem.

## Fix

0.1.19 implements real savepoint mapping on the session-affinity Mapepire job:

| PostgreSQL / psycopg | Db2 for i |
|---|---|
| `SAVEPOINT "_pg3_1"` | `SAVEPOINT "_pg3_1" ON ROLLBACK RETAIN CURSORS` |
| `RELEASE "_pg3_1"` | `RELEASE SAVEPOINT "_pg3_1"` |
| `ROLLBACK TO "_pg3_1"` | `ROLLBACK TO SAVEPOINT "_pg3_1"` |

The proxy also accepts PostgreSQL's optional `SAVEPOINT` keyword in `RELEASE SAVEPOINT name` and `ROLLBACK TO SAVEPOINT name`.

Transaction-state behavior follows PostgreSQL semantics:

- savepoint commands require an active explicit transaction;
- `SAVEPOINT` and `RELEASE` are rejected while the transaction is in failed state;
- `ROLLBACK TO SAVEPOINT` is allowed in failed state and clears the failed flag after Db2 successfully rolls back to the savepoint;
- the outer transaction remains active after `ROLLBACK TO SAVEPOINT`;
- top-level `COMMIT`/`ROLLBACK` still clear all Db2 savepoints naturally.

## psycopg TypeInfo compatibility

SQLAlchemy 2.0.51 asks psycopg to discover the optional PostgreSQL `hstore` type. psycopg issues a five-column `pg_type` query shaped as:

```sql
SELECT typname AS name, oid, typarray AS array_oid,
       oid::regtype::text AS regtype, typdelim AS delimiter
FROM pg_type t
WHERE t.oid = to_regtype($1)
ORDER BY t.oid
```

IBM i has no PostgreSQL hstore extension. 0.1.19 therefore returns an exact empty rowset with the five field names psycopg expects. This is handled before the generic synthetic `pg_type` enumerator.

## Validation

`scripts/verify-sqlalchemy-compat.mjs` now verifies:

1. SQLAlchemy 2.0.51 bootstrap scalars from 0.1.18.
2. psycopg 3.3.4 savepoint spellings and Db2 translations.
3. exact empty `TypeInfo.fetch()` result shape for `hstore`.

The verifier runs after TypeScript compilation during both `Containerfile` and `Dockerfile` builds.
