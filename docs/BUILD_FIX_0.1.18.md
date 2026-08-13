# Compatibility Fix 0.1.18 — SQLAlchemy / psycopg Bootstrap

## Symptom

A PostgreSQL client built on SQLAlchemy 2.0.51 and psycopg 3.3.4 can authenticate to the proxy, but SQLAlchemy fails during first-connect dialect initialization with:

```text
TypeError: expected string or bytes-like object, got 'NoneType'
```

The failure occurs before the application's readiness `SELECT 1` or migrations.

## Root cause

SQLAlchemy's PostgreSQL dialect obtains its server version with:

```sql
SELECT pg_catalog.version()
```

The proxy previously recognized only unqualified `SELECT version()`. The unknown `pg_catalog` expression was quarantined as a PostgreSQL-system query and produced no data row, so SQLAlchemy's scalar value became NULL/None and its version parser failed.

SQLAlchemy also uses these first-connect probes:

```sql
SELECT current_schema()
SHOW transaction isolation level
SHOW standard_conforming_strings
```

The proxy already supported the first and last statements, but supported transaction isolation only as `SHOW transaction_isolation`.

## Fix

- Recognize both `version()` and `pg_catalog.version()` and always return one non-NULL PostgreSQL-compatible text row.
- Honor `PG_SERVER_VERSION` in that version string.
- Recognize `SHOW transaction isolation level` and `SHOW default_transaction_isolation`.
- Add unit coverage and `scripts/verify-sqlalchemy-compat.mjs` as a mandatory Docker/Podman image-build gate.
- Keep the same compatibility fallback in `pgadmin.ts` so schema-qualified version expressions cannot fall through to the generic PostgreSQL-system quarantine.

## Scope

This release fixes SQLAlchemy/psycopg **connection initialization**. Applications configured to run Alembic migrations may subsequently exercise additional PostgreSQL DDL/catalog behavior; those are separate compatibility contracts and should be diagnosed from the next failing SQL statement if encountered.
