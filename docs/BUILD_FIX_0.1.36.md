# Build / compatibility fix 0.1.36

Release 0.1.36 is based on the live ContextForge v1.0.7 and proxy 0.1.35 logs from 2026-08-14.

## Failure

IBM i reported `IX_EMAIL_USERS_EMAIL` in the index catalog, but its denormalized `SYSTABLEINDEXSTAT.COLUMN_NAMES` value was unresolved. The proxy omitted the incomplete SQLAlchemy reflection row, so ContextForge/Alembic attempted `CREATE INDEX IX_EMAIL_USERS_EMAIL ON EMAIL_USERS (EMAIL)` again. Db2 for i correctly returned SQL0601 / SQLSTATE 42710, aborting the PostgreSQL transaction and causing subsequent 25P02 errors.

## Fix

`QSYS2.SYSKEYS` is now queried whenever a SQL index has a positive key count but no resolved key names. The rows are grouped by index schema/name and ordered by `ORDINAL_POSITION`. This repaired key list is used for PostgreSQL `pg_index` reflection. `QSYS2.SYSTABLEINDEXSTAT` remains a secondary fallback for broader IBM i access paths.

Advisory-lock behavior is unchanged; the same live log shows lock release on session close followed by successful acquisition by another session.
