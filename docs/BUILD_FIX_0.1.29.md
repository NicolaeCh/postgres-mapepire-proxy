# Compatibility fix 0.1.29 — SQLAlchemy/Alembic live reflection

ContextForge migrations progressed far enough to reveal a different class of compatibility failure: SQLAlchemy `Inspector` queries against PostgreSQL `pg_catalog` were being caught by the proxy's generic PostgreSQL-system firewall and returned as empty synthetic result sets. An empty result is syntactically safe but semantically wrong for reflection: `Inspector.get_table_names()` concludes that real IBM i tables do not exist, while `Inspector.get_columns()` / `get_indexes()` cannot observe their metadata.

This can silently change migration control flow. ContextForge's multitenancy migration conditionally adds `team_id`, `owner_email`, and `visibility` only to tables returned by Inspector. Later index migrations also use Inspector to decide whether tables/indexes exist. The false-negative reflection therefore allowed an earlier migration to be recorded while required columns were skipped, and a later direct index creation failed because `VISIBILITY` was actually absent.

0.1.29 adds a client-neutral SQLAlchemy PostgreSQL reflection adapter backed by live IBM i catalogs. It runs before pgAdmin-specific handlers and before the generic pg_catalog firewall. Supported families include:

- table names and `has_table`;
- column metadata;
- deterministic relation OIDs;
- indexes and key columns;
- foreign keys;
- primary-key and unique constraints.

Ordinary IBM i uppercase identifiers are exposed as PostgreSQL lowercase identifiers. The adapter uses deterministic virtual relation OIDs so SQLAlchemy's two-stage OID/index/constraint reflection remains consistent across calls.

The advisory-lock warning observed after the failing index is intentionally not bypassed: PostgreSQL rejects ordinary SQL while a transaction is in failed state (`25P02`). Session advisory locks are still released automatically when the TCP session closes.

## Existing partially migrated schemas

The proxy cannot safely infer and replay application-specific migrations that were previously skipped. For a disposable/test schema, recreate the application schema and rerun migrations from the beginning after upgrading to 0.1.29. For a schema containing valuable data, compare it to the application's migration expectations and repair only the missing application DDL.
