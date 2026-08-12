# pgAdmin 4 compatibility architecture

## Scope

Version 0.1.7 treats pgAdmin compatibility as a protocol contract rather than as SQL dialect translation. PostgreSQL system catalogs and server-introspection functions describe PostgreSQL internals; most have no truthful one-to-one Db2 for i equivalent. They therefore must not be sent to IBM i.

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
9. pgAdmin calls `get_replication_type()`, which executes `templates/servers/sql/default/replication_type.sql` and **unconditionally indexes the first returned row**. The template returns `pgd`, `log`, or `NULL`; therefore the proxy must return one row even when no PostgreSQL replication feature exists.
10. Database tree loading queries `pg_database`, `pg_tablespace` and `pg_shdescription`.
11. Statistics/dashboard pages may immediately use PostgreSQL-only objects such as `pg_stat_activity`, `pg_stat_replication`, locks, replication slots and settings.

Primary references:

- pgAdmin REL-9_17 psycopg3 connection implementation: https://github.com/pgadmin-org/pgadmin4/blob/REL-9_17/web/pgadmin/utils/driver/psycopg3/connection.py
- pgAdmin REL-9_17 recovery template: https://github.com/pgadmin-org/pgadmin4/blob/REL-9_17/web/pgadmin/browser/server_groups/servers/templates/connect/sql/default/check_recovery.sql
- pgAdmin REL-9_17 database nodes template: https://github.com/pgadmin-org/pgadmin4/blob/REL-9_17/web/pgadmin/browser/server_groups/servers/databases/templates/databases/sql/default/nodes.sql
- pgAdmin REL-9_17 server statistics template: https://github.com/pgadmin-org/pgadmin4/blob/REL-9_17/web/pgadmin/browser/server_groups/servers/templates/servers/sql/default/stats.sql
- pgAdmin REL-9_17 server helper (`get_replication_type`): https://github.com/pgadmin-org/pgadmin4/blob/REL-9_17/web/pgadmin/browser/server_groups/servers/utils.py
- pgAdmin REL-9_17 replication-type SQL: https://github.com/pgadmin-org/pgadmin4/blob/REL-9_17/web/pgadmin/browser/server_groups/servers/templates/servers/sql/default/replication_type.sql
- PostgreSQL 14 frontend/backend message flow: https://www.postgresql.org/docs/14/protocol-flow.html

## Virtual PostgreSQL System Layer

`src/sql/pgadmin.ts` is the virtual system layer. Its invariant is:

> PostgreSQL-only system SQL never reaches Mapepire.

The layer has three response classes:

### 1. Exact semantic responses

Connection-critical queries receive deterministic PostgreSQL-shaped rows. Examples:

- `pg_database`: one logical proxy database.
- `pg_stat_gssapi`: `gss_authenticated=false`, `encrypted=false`.
- `pg_roles`: proxy-facing PostgreSQL role capabilities only; this does **not** change IBM i authority.
- pgAdmin replication type: exactly one `type` column and one row containing `NULL`; IBM i has neither BDR nor PostgreSQL logical replication slots.
- recovery/WAL functions: `false` because PostgreSQL WAL recovery has no IBM i meaning in this proxy.
- `current_schema()`: the session's IBM i current schema.
- `pg_show_all_settings()` / `pg_settings`: a small virtual settings set.

### 2. Virtual empty monitoring results

PostgreSQL runtime/monitoring objects with no Db2-for-i semantic equivalent return a correctly framed empty PostgreSQL result whenever practical. This includes `pg_stat_*`, `pg_locks`, prepared transactions, replication slots and PostgreSQL system-statistics functions.

No fabricated IBM i operational metric is reported as though it were a PostgreSQL metric.

For PostgreSQL-system queries whose SQL semantics guarantee a row (for example a scalar SELECT without a top-level FROM or an aggregate SELECT without GROUP BY/HAVING), the quarantine preserves that one-row cardinality. Unknown values remain `NULL` and count-like aggregate fields are zero. This avoids client-side failures caused purely by an impossible result shape.

### 3. System-query firewall

After the exact handlers, any remaining `pg_catalog.*` or `pg_*` system construct is quarantined locally. It cannot be translated into an accidental IBM i library/table name.

The only intentionally translated catalog relations are the small compatibility subset already implemented by the proxy (`pg_namespace`, `pg_class`, and the synthetic `pg_type` path).

## PostgreSQL wire-protocol contract

pgAdmin 9.17 uses psycopg3. Correct SQL shape is not sufficient: the frontend/backend message sequence must also be PostgreSQL-compliant. Version 0.1.7 therefore enforces these startup and Extended Query invariants:

- after `AuthenticationOk`, the backend sends the initial `ParameterStatus` messages, `BackendKeyData`, and only then `ReadyForQuery`;
- `ReadyForQuery` is delayed until the Mapepire job is leased and the proxy's custom protocol parser is attached;
- portal `Describe` returns `RowDescription` for a row-producing query or `NoData` for a non-row-producing command;
- `Execute` sends row data and `CommandComplete` but does **not** send another `RowDescription`;
- every synthetic `DataRow` is validated to contain exactly the number of values announced by `RowDescription`.

Mapepire does not expose a prepare-only result-metadata API. For a Db2 read query described through a PostgreSQL portal, the proxy executes/materializes that **read-only** query once at Describe time, retains its data/metadata, and serves it during Execute without executing it twice. Writes are never run during Describe.

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

The container build runs all three compiled-code contract tests:

```text
node scripts/verify-pgadmin-compat.mjs
node scripts/verify-pgadmin-wire.mjs
node scripts/verify-startup-wire.mjs
```

The image build fails if the SQL compatibility contract, the psycopg3 Extended Query sequence, or the PostgreSQL startup handshake regresses. The SQL contract includes the exact pgAdmin 9.17 replication-type template and requires one `type=NULL` row.

## Important limitation

This compatibility layer is intended to let PostgreSQL clients connect and to let normal application SQL reach Db2 for i. It does **not** make IBM i a PostgreSQL server and it does not claim that PostgreSQL administration features (WAL, autovacuum, replication slots, PostgreSQL locks, extensions, roles, tablespaces, etc.) exist on IBM i.

## 0.1.8 database/schema browser contract

The database/schema browser is not handled by the generic PostgreSQL-system fallback. pgAdmin 9.17 consumes exact column aliases in its Python handlers, so 0.1.8 has explicit contracts for dashboard data, database ACL/default ACL, DBMS scheduler extension detection, role nodes, tablespace nodes, schema nodes, schema properties, schema ACL, and schema default ACL.

Schema discovery is live rather than invented. For pgAdmin `pg_namespace` browser queries the session reads:

```sql
SELECT SCHEMA_NAME, SCHEMA_OWNER, SCHEMA_TEXT
FROM QSYS2.SYSSCHEMAS
ORDER BY SCHEMA_NAME
```

The result is cached per PostgreSQL session for `PGADMIN_SCHEMA_CACHE_MS` and invalidated after proxy-executed CREATE SCHEMA. A stable positive proxy OID is derived from each SQL schema name so pgAdmin can address the same schema on later requests.

The PostgreSQL-visible `namespaceowner` is the PostgreSQL proxy login to keep pgAdmin's role model coherent. It is deliberately **not** an IBM i authority statement. Backend DDL executes under `IBMI_USER`.

### CREATE SCHEMA

pgAdmin normally emits:

```sql
CREATE SCHEMA "name" AUTHORIZATION "pg-role";
```

The proxy maps the basic form to:

```sql
CREATE SCHEMA "name"
```

because this deployment uses a fixed IBM i Mapepire service profile. PostgreSQL schema comments, schema GRANT/REVOKE, ALTER DEFAULT PRIVILEGES, and SECURITY LABEL are not claimed as IBM i-equivalent features. If pgAdmin includes any of them in the same create batch, 0.1.8 rejects the batch before creating the schema; leave those tabs/fields empty for the supported basic create path.

## 0.1.8 build-time browser gates

In addition to the startup and wire contracts, both container definitions run:

```text
node scripts/verify-pgadmin-browser.mjs
node scripts/verify-pgadmin-schema.mjs
```

These verify the exact aliases/cardinality that pgAdmin dereferences and the IBM i-backed schema contract.

## 0.1.12 table discovery / pgAgent initialization

pgAdmin issues a PostgreSQL-specific pgAgent capability query during database initialization. The proxy answers it locally as false. The IBM i table catalog adapter uses `QSYS2.SYSTABLES` with `TABLE_TYPE IN ('T','P') AND FILE_TYPE='D'`, and logs the table request kind, requested/resolved schema and row count at DEBUG level. Legacy schema OIDs from earlier proxy revisions are accepted for browser refresh compatibility.

## 0.1.9 table browser contract

pgAdmin's Tables collection is backed by live `QSYS2.SYSTABLES` data instead of the generic virtual `pg_class` rewrite. The adapter handles pgAdmin 9.17 table count, node, property, table-name/OID, and schema-for-table queries with stable synthetic OIDs. PostgreSQL-only trigger, inheritance, toast, replication and storage properties are returned conservatively as zero/false/null where they have no IBM i equivalent.

For normal table creation, PostgreSQL SERIAL-family pseudo-types are mapped to Db2 for i identity columns. PostgreSQL table OWNER is virtual because all backend DDL uses the configured IBM i Mapepire service profile.

## Table child browsing — 0.1.14

pgAdmin identifies a table with the proxy's deterministic virtual PostgreSQL OID and then issues PostgreSQL catalog SQL for child collections. Release 0.1.14 intercepts those requests before generic SQL translation:

- **Columns** → live `QSYS2.SYSCOLUMNS2` rows for the resolved IBM i schema/table.
- **Indexes** → live `QSYS2.SYSINDEXES` rows for SQL indexes created with `CREATE INDEX`.
- **Partitions/inheritance** → empty PostgreSQL-compatible collection because the proxy does not model IBM i table partitioning as `pg_inherits` child relations.
- PostgreSQL-only Rules/Triggers/RLS browser collections are kept local when no IBM i browser mapping exists.

PostgreSQL `OID` is a catalog identifier type. It is never translated as a Db2 type. Remaining PostgreSQL-system statements containing `::OID` are quarantined before Mapepire to prevent IBM i SQL0204 `OID ... *SQLUDT not found` errors.

`PGADMIN_HIDE_SYSTEM_SCHEMAS=true` hides IBM i schema/library names beginning with `Q` or `SYS` plus `INFORMATION_SCHEMA`. `IBMI_CURRENT_SCHEMA` sets the initial Db2 current schema and the value exposed through `current_schema()`.
