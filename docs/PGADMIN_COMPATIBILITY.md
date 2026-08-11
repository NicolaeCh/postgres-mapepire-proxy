# pgAdmin 4 compatibility architecture

## Scope

Version 0.1.6 treats pgAdmin compatibility as a protocol contract rather than as SQL dialect translation. PostgreSQL system catalogs and server-introspection functions describe PostgreSQL internals; most have no truthful one-to-one Db2 for i equivalent. They therefore must not be sent to IBM i.

The proxy exposes PostgreSQL compatibility level **14.0** by default. pgAdmin 4 9.17 supports PostgreSQL 14 through 18, so 14 is intentionally the lowest currently supported level and minimizes version-dependent PostgreSQL catalog surface.

## Connection sequence audited against pgAdmin 4 REL-9_17

The pgAdmin psycopg3 driver performs these operations during `_initialize()`:

1. PostgreSQL startup/authentication through the wire protocol.
2. A Simple Query batch:
   - `SET DateStyle=ISO`
   - `SET client_min_messages=notice`
   - `SELECT set_config('bytea_output','hex',false) FROM pg_show_all_settings() ...`
   - `SET client_encoding='UTF8'`
3. Optional role validation and `SET ROLE`.
4. `SELECT version()`.
5. Current database metadata from `pg_catalog.pg_database`.
6. For server versions >= 12, `pg_catalog.pg_stat_gssapi` for the current backend PID.
7. Current role/capability lookup from `pg_catalog.pg_roles`, including `can_signal_backend`.
8. After connection, the server tree executes `check_recovery.sql` using `pg_catalog.pg_user`, `pg_is_in_recovery()` and `pg_is_wal_replay_paused()`. Failure of this query causes pgAdmin to mark the server disconnected.
9. Database tree loading queries `pg_database`, `pg_tablespace` and `pg_shdescription`.
10. Statistics/dashboard pages may immediately use PostgreSQL-only objects such as `pg_stat_activity`, `pg_stat_replication`, locks, replication slots and settings.

Primary references:

- pgAdmin REL-9_17 psycopg3 connection implementation: https://github.com/pgadmin-org/pgadmin4/blob/REL-9_17/web/pgadmin/utils/driver/psycopg3/connection.py
- pgAdmin REL-9_17 recovery template: https://github.com/pgadmin-org/pgadmin4/blob/REL-9_17/web/pgadmin/browser/server_groups/servers/templates/connect/sql/default/check_recovery.sql
- pgAdmin REL-9_17 database nodes template: https://github.com/pgadmin-org/pgadmin4/blob/REL-9_17/web/pgadmin/browser/server_groups/servers/databases/templates/databases/sql/default/nodes.sql
- pgAdmin REL-9_17 server statistics template: https://github.com/pgadmin-org/pgadmin4/blob/REL-9_17/web/pgadmin/browser/server_groups/servers/templates/servers/sql/default/stats.sql

## Virtual PostgreSQL System Layer

`src/sql/pgadmin.ts` is the virtual system layer. Its invariant is:

> PostgreSQL-only system SQL never reaches Mapepire.

The layer has three response classes:

### 1. Exact semantic responses

Connection-critical queries receive deterministic PostgreSQL-shaped rows. Examples:

- `pg_database`: one logical proxy database.
- `pg_stat_gssapi`: `gss_authenticated=false`, `encrypted=false`.
- `pg_roles`: proxy-facing PostgreSQL role capabilities only; this does **not** change IBM i authority.
- recovery/WAL functions: `false` because PostgreSQL WAL recovery has no IBM i meaning in this proxy.
- `current_schema()`: the session's IBM i current schema.
- `pg_show_all_settings()` / `pg_settings`: a small virtual settings set.

### 2. Virtual empty monitoring results

PostgreSQL runtime/monitoring objects with no Db2-for-i semantic equivalent return a correctly framed empty PostgreSQL result whenever practical. This includes `pg_stat_*`, `pg_locks`, prepared transactions, replication slots and PostgreSQL system-statistics functions.

No fabricated IBM i operational metric is reported as though it were a PostgreSQL metric.

### 3. System-query firewall

After the exact handlers, any remaining `pg_catalog.*` or `pg_*` system construct is quarantined locally. It cannot be translated into an accidental IBM i library/table name.

The only intentionally translated catalog relations are the small compatibility subset already implemented by the proxy (`pg_namespace`, `pg_class`, and the synthetic `pg_type` path).

## PostgreSQL SELECT-without-FROM handling

PostgreSQL permits scalar queries such as:

```sql
SELECT current_timestamp;
```

Db2 for i requires a table reference for many equivalent scalar expressions. For non-system SQL that is safe to translate, the translator adds:

```sql
FROM SYSIBM.SYSDUMMY1
```

`SYSIBM.SYSDUMMY1` is the canonical IBM i one-row object for this purpose.

## Build-time contract test

The container build runs:

```text
node scripts/verify-pgadmin-compat.mjs
```

against the compiled JavaScript. The image build fails if the proxy no longer satisfies the pgAdmin 9.17 initialization/recovery contract or if an unknown PostgreSQL system view would fall through to Db2.

## Important limitation

This compatibility layer is intended to let PostgreSQL clients connect and to let normal application SQL reach Db2 for i. It does **not** make IBM i a PostgreSQL server and it does not claim that PostgreSQL administration features (WAL, autovacuum, replication slots, PostgreSQL locks, extensions, roles, tablespaces, etc.) exist on IBM i.
