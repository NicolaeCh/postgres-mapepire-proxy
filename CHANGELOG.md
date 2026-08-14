# Changelog

## 0.1.27 - 2026-08-14

- Translate PostgreSQL/SQLAlchemy Boolean column defaults (`'1'`, `1`, `'0'`, true/false aliases) to the Db2 for i Boolean constants `TRUE` / `FALSE` in CREATE/ALTER TABLE DDL.
- Handle PostgreSQL `DEALLOCATE [PREPARE] name|ALL` inside the proxy session registry instead of forwarding it to Db2, fixing psycopg prepared-statement cleanup after rollback.
- Add a build-time compatibility verifier covering the ContextForge A2A Boolean DDL shape and the psycopg `ROLLBACK` → `DEALLOCATE ALL` sequence.

## 0.1.26 - 2026-08-14

- Fix the container build regression introduced by 0.1.25: `verify-pgadmin-wire.mjs` now implements the required `prepareSchema()` fake-pool contract.
- Keep `SessionJobPool.prepareSchema()` mandatory in production so schema routing and transactional-schema checks cannot be silently bypassed.
- Update stale multi-architecture build-script default tags to 0.1.26.

## 0.1.25 - 2026-08-13

- Separate PostgreSQL database identity from effective IBM i schema in logs, health data, and client-visible introspection.
- Add PostgreSQL-standard per-session schema routing through startup `options=-csearch_path=...`, `SET search_path`, `SET SCHEMA`, `SET LOCAL`, and `set_config('search_path', ...)`.
- Confirm Db2 `CURRENT SCHEMA` from the backend after connection/schema changes instead of relying only on proxy state.
- Add IBM i schema transaction preflight for SQL-schema `QSQJRN` and `STRJRNLIB`-style journal inheritance.
- Add optional `IBMI_REQUIRE_TRANSACTIONAL_SCHEMA` fail-fast guard for transactional PostgreSQL applications.
- Add optional `IBMI_AUTO_CREATE_CURRENT_SCHEMA` provisioning using IBM i SQL `CREATE SCHEMA`; fix pool bootstrap so a missing default schema can be created before `SET CURRENT SCHEMA`.
- Enrich SQL7008 errors with effective schema/source and translated SQL shape while retaining PostgreSQL failed-transaction semantics.
- Preserve existing-library journal administration as an explicit IBM i operational responsibility; the proxy does not silently create journals/start journaling in existing libraries.

## 0.1.24 - 2026-08-13

- Translate PostgreSQL `INSERT ... RETURNING` into a Db2 for i `SELECT ... FROM FINAL TABLE (INSERT ...)` data-change table reference so Alembic can write and read back `alembic_version.version_num`.
- Preserve the original PostgreSQL DML command kind while returning the Db2 rowset, so wire `CommandComplete` remains `INSERT`/`UPDATE`/`DELETE` rather than `SELECT`.
- Support simple-column `UPDATE ... RETURNING` through `FINAL TABLE` and `DELETE ... RETURNING` through `OLD TABLE`; reject unsupported complex RETURNING expressions explicitly instead of leaking PostgreSQL syntax to IBM i.
- Count rows returned by a Db2 data-change table reference as affected DML rows when Mapepire reports `update_count=0`.
- Advertise RETURNING RowDescription during PostgreSQL extended-protocol Describe without executing the write early; infer returned column OIDs from the session DDL registry when available.
- Add build gate `verify-contextforge-returning.mjs` with the Alembic version-table statement and identity/update/delete RETURNING contracts.

## 0.1.23 - 2026-08-13

- Align translated Db2 foreign-key column datatypes with the referenced parent key datatype for CREATE TABLE statements executed in the same PostgreSQL session.
- Fix ContextForge v1.0.7 `server_metrics.server_id` (`String()`) referencing `servers.id` (`String(36)`), which PostgreSQL accepts but Db2 for i rejects with SQL0538/42830 after generic bare-VARCHAR translation.
- Apply the same generic alignment to later ContextForge association/metrics tables (`server_id`, `tool_id`, and similar keys) instead of hard-coding application table names.
- Add build gate `verify-contextforge-fk-types.mjs` covering single and composite foreign-key type inheritance while preserving already-compatible key columns.

## 0.1.22

- Translate PostgreSQL `TIMESTAMP WITHOUT TIME ZONE` to Db2 for i `TIMESTAMP`.
- Translate PostgreSQL `TIME WITHOUT TIME ZONE` to Db2 for i `TIME`.
- Strengthen the ContextForge DDL build verifier with the exact SQLAlchemy `DateTime(timezone=False)` spelling used by ContextForge v1.0.7.

## 0.1.21 - 2026-08-13

- Add PostgreSQL DDL type translation required by ContextForge/Alembic fresh-schema creation on Db2 for i.
- Map PostgreSQL bare `VARCHAR` to configurable `VARCHAR(1024)` by default, while preserving explicitly sized `VARCHAR(n)`.
- Map `JSON`/`JSONB` and `TEXT` to UTF-8 `CLOB(2G)`, `BYTEA` to `BLOB(2G)`, and timezone-aware PostgreSQL timestamp/time DDL to Db2 `TIMESTAMP`/`TIME`.
- Add `SQL_DDL_DEFAULT_VARCHAR_LENGTH` and build gate `verify-contextforge-ddl.mjs`.
- Log a literal-redacted translated DDL shape on backend DDL failures so later Alembic compatibility failures are self-identifying without enabling full SQL logging.

## 0.1.20 - 2026-08-13

- Implement PostgreSQL session advisory locks required by ContextForge v1.0.7 bootstrap (`pg_try_advisory_lock`, `pg_advisory_unlock`, `pg_advisory_unlock_all`).
- Lock ownership is scoped to the PostgreSQL client session, is re-entrant for the same session, and is automatically released when that session closes.
- Add exact boolean RowDescription/DataRow contracts for SQLAlchemy/psycopg extended-query execution so advisory-lock probes are no longer swallowed by the generic PostgreSQL-system firewall as NULL.
- Add build gate `verify-contextforge-advisory-lock.mjs`.

## 0.1.19 - 2026-08-13

- Add real PostgreSQL SAVEPOINT / RELEASE / ROLLBACK TO SAVEPOINT compatibility backed by Db2 for i savepoints, including psycopg 3 nested transaction spellings such as `RELEASE "_pg3_1"`.
- Allow `ROLLBACK TO SAVEPOINT` to recover PostgreSQL failed-transaction state while keeping the outer transaction active.
- Add an exact empty psycopg `TypeInfo.fetch()` response for optional PostgreSQL extension types such as `hstore`, preventing the generic `pg_type` enumerator from returning the wrong record shape.
- Extend the SQLAlchemy/psycopg build-time compatibility gate to cover the complete hstore/savepoint initialization path used by ContextForge v1.0.7.

## 0.1.18 - 2026-08-13

- Add SQLAlchemy 2.0 / psycopg bootstrap compatibility for `SELECT pg_catalog.version()` and `SHOW transaction isolation level`.
- Return a non-NULL PostgreSQL-compatible version scalar so SQLAlchemy can initialize its PostgreSQL dialect through the proxy.

## 0.1.17 - 2026-08-12

- Fixed pgAdmin 9.16+ Columns nodes being misclassified as column properties because the nodes SQL itself references `att.attidentity`; node requests now return the required `oid` field.
- Added regression coverage using pgAdmin's current Columns `nodes.sql` shape.
- Kept `QSYS2.SYSINDEXES` as the authoritative SQL `CREATE INDEX` catalog and added a `QSYS2.SYSTABLEINDEXSTAT` fallback for IBM i SQL-index and DDS logical-file access paths when `SYSINDEXES` returns no rows.
- The fallback exposes only `INDEX` and `LOGICAL` rows under pgAdmin Indexes; primary/unique/referential constraint access paths remain separate from the Indexes collection.
- Added explicit logging when the table-index-statistics fallback is used or cannot be queried.

## 0.1.16 - 2026-08-12

- Fixed pgAdmin Columns and Indexes collections being absent even though live IBM i node adapters existed: pgAdmin `has_nodes()` count requests are now intercepted and answered from `QSYS2.SYSCOLUMNS2` and `QSYS2.SYSINDEXES`.
- Added a live pgAdmin Views adapter backed by `QSYS2.SYSTABLES` (`TABLE_TYPE='V'`) and `QSYS2.SYSVIEWS`, including view names, comments, owners, and view definitions.
- Registered deterministic virtual OIDs for IBM i views so pgAdmin can subsequently resolve Columns for a view, including across separate pgAdmin connections.
- Broadened concrete-OID Columns/Indexes query recognition to tolerate minor pgAdmin SQL template variations while retaining the 0.1.15 nested-trigger safeguard.
- Added regression coverage for Columns count, Indexes count, Views count/nodes/properties, and table-vs-view classifier separation.

## 0.1.15 - 2026-08-12

- Fixed a 0.1.14 pgAdmin Tables regression: the new table-child classifier no longer mistakes nested `pg_trigger` count subqueries inside the normal Tables `nodes.sql` request for a Triggers child collection.
- PostgreSQL-only Trigger/Rule/Policy child requests are now claimed only when they contain a concrete numeric parent table OID.
- Added a regression test proving the pgAdmin Tables node query remains available to the IBM i table adapter.

## 0.1.14 - 2026-08-12

- Added `PGADMIN_HIDE_SYSTEM_SCHEMAS` (default `true`) to hide IBM i `Q*`, `SYS*`, and `INFORMATION_SCHEMA` schemas from pgAdmin.
- Added preferred `IBMI_CURRENT_SCHEMA`; `DEFAULT_SCHEMA` remains a backward-compatible fallback.
- Added live pgAdmin Columns browsing from `QSYS2.SYSCOLUMNS2`.
- Added live pgAdmin SQL Index browsing from `QSYS2.SYSINDEXES`.
- Virtualized PostgreSQL partition/inheritance and other PostgreSQL-only table children so `::OID` casts cannot leak to Db2 for i.
- Added build-time pgAdmin table-child contract verification.

## 0.1.13 - 2026-08-12

- Fix image build after `IBMI_RDB_NAME` became required in 0.1.12.
- Keep deployment `.env` deliberately excluded from build context; build-time pgAdmin wire tests use synthetic non-secret IBM i/RDB values instead.
- Seed `IBMI_RDB_NAME=BUILDTEST` inside `verify-pgadmin-wire.mjs` before importing `ProxySession`.
- Add the same synthetic build-test configuration to both `Containerfile` and `Dockerfile`; it exists only in the build stage and is not inherited by the runtime image.
- Runtime configuration remains strict and still requires the real `IBMI_RDB_NAME` and IBM i service credentials.

## 0.1.12 - 2026-08-12

- Define a one-proxy/one-RDB identity model with required `IBMI_RDB_NAME`; PostgreSQL StartupMessage database must match that IBM i local RDB name.
- Recommend the same RDB name as pgAdmin Maintenance database; `DEFAULT_SCHEMA` remains the IBM i schema/library (for example `MONAI`).
- Fix the empty pgAdmin Schemas tree: REL-9_17 `nodes.sql` was misclassified as `oidByName(pg_catalog)` because its catalog-exclusion macro contains `nspname='pg_catalog'`.
- Make schema count/nodes/properties recognition depend on `pg_namespace` being the primary FROM relation and process schema contracts before table contracts.
- Tighten simple schema OID/name lookup recognition so it cannot consume multi-column pgAdmin nodes queries.
- Add INFO diagnostics for pgAdmin IBM i schema catalog count/nodes/properties requests, including live `QSYS2.SYSSCHEMAS` row counts and returned schema names.
- Add regression coverage for the exact pgAdmin 9.17 schema nodes shape containing the nested catalog macro.

## 0.1.11 - 2026-08-12

- Prevent pgAdmin schema queries containing nested `pg_class` catalog macros from being claimed by the table adapter.
- Prefer `relnamespace=<schema OID>` over embedded `nspname='pg_catalog'` predicates for table browser resolution.
- Emit INFO diagnostics for pgAdmin table count/nodes catalog requests.

## 0.1.10 - 2026-08-12

- Virtualize pgAdmin's pgAgent capability probe and return `has_priviledge=false` locally.
- Prevent PostgreSQL `has_*_privilege` metadata functions from leaking to Db2 for i.
- Correct live table discovery to use documented `QSYS2.SYSTABLES.FILE_TYPE='D'` with `TABLE_TYPE IN ('T','P')`.
- Support legacy pre-0.1.8 row-number schema OIDs in addition to stable schema OIDs.
- Add diagnostics for pgAdmin table catalog request kind, schema resolution and table count.

## 0.1.9 - 2026-08-11

- Added live IBM i-backed pgAdmin Tables collection using `QSYS2.SYSTABLES`.
- Added deterministic virtual PostgreSQL OIDs for IBM i tables and exact pgAdmin 9.17 table count/node/property/post-create lookup contracts.
- Added PostgreSQL `SMALLSERIAL` / `SERIAL` / `BIGSERIAL` translation to Db2 for i `GENERATED BY DEFAULT AS IDENTITY`.
- Added top-level `SELECT EXISTS(...)` rewrite using a Db2 searched CASE and `SYSIBM.SYSDUMMY1`.
- Added service-user-aware handling of pgAdmin `ALTER TABLE ... OWNER TO ...` and tightly scoped CREATE TABLE batches.
- Added build-time pgAdmin table-browser and DDL/scalar translation regression gates.

## 0.1.8 - 2026-08-11

- Extended pgAdmin 9.17 compatibility from connection startup into database/schema browser contracts.
- Added exact dashboard `chart_name`/`chart_data`, database ACL/default ACL, scheduler, role-description and tablespace-description responses.
- Added live IBM i schema navigation backed by `QSYS2.SYSSCHEMAS`, stable proxy schema OIDs, exact schema properties/ACL/default-ACL shapes, and configurable `PGADMIN_SCHEMA_CACHE_MS`.
- Added basic pgAdmin CREATE SCHEMA translation: PostgreSQL `AUTHORIZATION` is not forwarded to IBM i because all backend DDL executes as the Mapepire service profile.
- Schema comment/privilege/default-privilege/security-label batches are rejected before creation to avoid partial-success DDL.
- Fixed SELECT-without-FROM translation so `SYSIBM.SYSDUMMY1` is inserted before WHERE/GROUP/HAVING/ORDER/OFFSET/FETCH.
- Added `verify-pgadmin-browser.mjs` and `verify-pgadmin-schema.mjs` build gates plus regression tests.

## 0.1.7 - 2026-08-11

- Audited the complete pgAdmin 4 REL-9_17 synchronous connect path, including the post-connect `replication_type.sql` helper.
- Fixed pgAdmin `list index out of range`: pgAdmin unconditionally reads `res['rows'][0]['type']`; the proxy now returns the required single `type=NULL` row for a normal non-PostgreSQL-replication backend instead of an empty synthetic result.
- Hardened the PostgreSQL-system quarantine so scalar SELECTs without a top-level FROM and aggregate SELECTs without GROUP BY/HAVING preserve PostgreSQL one-row cardinality instead of returning a structurally incorrect zero-row result.
- Added a PostgreSQL startup-handshake adapter that emits ParameterStatus values and BackendKeyData, and delays ReadyForQuery until the Mapepire SQLJob and custom wire parser are attached.
- Fixed Extended Query Protocol semantics: portal Describe now returns RowDescription for row-producing queries and Execute no longer emits a duplicate RowDescription.
- Added read-only portal materialization for Db2 result metadata because Mapepire exposes column metadata only when executing the query.
- Added `PG_PROTOCOL_TRACE` for message-type diagnostics without logging SQL text.
- Added build-time pgAdmin wire-contract and startup-handshake tests in addition to the SQL compatibility contract.
- The pgAdmin compatibility build test now includes the exact REL-9_17 replication-type query and asserts one DataRow whose `type` value is PostgreSQL NULL.

## 0.1.6 - 2026-08-11

- Replaced incremental pgAdmin exceptions with a Virtual PostgreSQL System Layer.
- Audited pgAdmin 4 REL-9_17 psycopg3 initialization, recovery, database-tree and server-statistics SQL.
- Added synthetic `pg_catalog.pg_stat_gssapi` response.
- Added six-column pgAdmin role capability response including `can_signal_backend`.
- Added exact `check_recovery.sql` handling so pgAdmin does not mark the server disconnected.
- Added database-tree `description` compatibility.
- Added a PostgreSQL-system firewall: unhandled `pg_catalog.*` and `pg_*` constructs cannot reach Db2 for i.
- Virtualized PostgreSQL-only monitoring relations/functions as local empty result sets.
- Added `SYSIBM.SYSDUMMY1` to translated scalar SELECTs that have no top-level FROM.
- Default `PG_SERVER_VERSION` is now `14.0`.
- Added `scripts/verify-pgadmin-compat.mjs` as a build-time compiled-code contract test.


## 0.1.5 - 2026-08-11

- Added pgAdmin startup compatibility interception for `pg_catalog.pg_database`.
- Added synthetic handling for PostgreSQL no-FROM session probes such as `set_config()` and `current_setting()`.
- Added lightweight `pg_user`, `pg_roles`, and `pg_tablespace` compatibility responses, including pgAdmin recovery/replay-state probes.
- Added synthetic-only handling for pgAdmin's harmless multi-statement session initialization batch (`DateStyle`, `client_min_messages`, `bytea_output`, `client_encoding`).
- Added locale/current-setting compatibility (`lc_ctype`, `lc_collate`, encoding/message/bytea settings).
- Added opt-in `SQL_LOG_FAILED_TEXT` diagnostics for unsupported client probes.
- Prevent PostgreSQL-only catalog/session queries from being forwarded to Db2 for i.

## 0.1.4 - 2026-08-11

- Fixed Node 24 ESM startup failure with `node-sql-parser` 5.4.0 (`Parser` is not a named ESM runtime export).
- Added `src/sql/parser-sdk.ts` as the CommonJS/ESM interop boundary using `createRequire()`, matching the upstream package's documented Node.js usage.
- Replaced the Mapepire-only build smoke test with `scripts/verify-runtime-modules.mjs`.
- Build now validates Mapepire `SQLJob`, node-sql-parser `Parser` including a real PostgreSQL parse, `dotenv/config`, and pg-gateway's ESM exports before TypeScript compilation.
- Updated image/version references to 0.1.4.

## 0.1.3 - 2026-08-11

- Fixed Node 24 ESM startup failure with `@ibm/mapepire-js` 0.6.1.
- Added a dedicated CommonJS interop adapter using `createRequire()` for the runtime `SQLJob` constructor.
- Kept Mapepire interfaces/types as TypeScript type-only imports.
- Added a build-time Mapepire module smoke test so incompatible package exports fail during image construction instead of at container startup.
- Updated runtime image/version references to 0.1.3.

## 0.1.2 - 2026-08-11

- Fixed runtime-stage container build failure on Debian-based official Node images caused by attempting to create a group named `proxy`; Debian already reserves that system group.
- Removed custom `groupadd` / `useradd` commands from both `Containerfile` and `Dockerfile`.
- Runtime now uses the unprivileged `node` user and `node` group already supplied by the official Node image (UID/GID 1000).
- Updated all runtime `COPY --chown` directives to `node:node`.
- Kept the container non-root while making the image definition identical across AMD64 and PPC64LE.
- Updated image/version references to 0.1.2.

## 0.1.1 - 2026-08-11

- Fixed TypeScript build failures seen on both AMD64 and PPC64LE with current Node 24 type definitions.
- Logger metadata now accepts typed interfaces such as `PoolStats` without requiring a `Record<string, unknown>` index signature.
- PostgreSQL wire-frame payload boundaries now use `Uint8Array`, avoiding `Buffer<ArrayBuffer>` versus `Buffer<ArrayBufferLike>` generic incompatibilities.
- The incremental frontend accumulation buffer is now typed as `Uint8Array` for the same cross-version Node typing compatibility.
- Normalized `node:net` data chunks before passing them to the PostgreSQL protocol parser.
- Re-ran source-level TypeScript validation against TypeScript 5.8 and strict Node buffer typings.

## 0.1.0 - 2026-08-10

- Initial implementation package.
- IBM i access redesigned to use one `.env`-defined service account for all Mapepire jobs.
- PostgreSQL authentication fully decoupled from IBM i credentials.
- Session-affinity Mapepire pool for PostgreSQL transaction correctness.
- Official `node:24-bookworm-slim` multi-architecture base image for amd64/ppc64le.
- Added session-affinity SQLJob pooling, opt-in transport retry for known-safe reads, cursor paging, PostgreSQL extended-protocol error recovery and `SET search_path` mapping.
- Added strict pool creation accounting, explicit savepoint rejection and graceful-shutdown deadline handling.
- Corrected Db2 CHAR(n) mapping to PostgreSQL bpchar OID 1042.
- Detached pg-gateway after authentication and added an incremental frontend frame parser for fragmented/coalesced Simple and Extended Query messages.
- Added `PG_MAX_FRONTEND_MESSAGE_BYTES` and TCP backpressure.
- Added `.env`-driven Mapepire library list plus ISO date/time and decimal-format JDBC settings.
- Deliberately reject `bytea` bind parameters in v0.1 until validated end-to-end; BLOB/binary result metadata still maps to PostgreSQL OID 17.
