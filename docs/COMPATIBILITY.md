# PostgreSQL Compatibility Matrix

## Protocol

| Feature | Status | Notes |
|---|---|---|
| StartupMessage | Supported | handled by pg-gateway |
| SSLRequest | Supported when configured | pg-gateway TLS |
| cleartext auth | Supported | proxy-local account |
| MD5 auth | Supported | proxy-local account; not IBM i |
| Simple Query | Supported | one statement by default |
| Parse/Bind/Execute/Sync | Baseline supported | Mapepire parameters; protocol error recovery waits for Sync |
| Named statements/portals | Supported in session memory | not persisted |
| Describe | Partial | Portal Describe returns RowDescription for rowsets; statement-level Describe for Db2 rowsets remains limited because Mapepire exposes result metadata on execution. Read-only portals are materialized once during Describe and reused at Execute. |
| Text results | Supported | default |
| Binary results | Not supported | returns feature-not-supported; text-format BLOB/binary results map to `bytea` |
| Execute with maxRows | Partial | treated as a one-shot row cap; PortalSuspended/resume is not implemented |
| COPY protocol | Not supported | future work |
| LISTEN/NOTIFY | Not supported | no Db2 analogue |
| CancelRequest | Not implemented in v0.1 | No proxy-side cancellation of an already running Mapepire query |

## SQL

| Feature | Status |
|---|---|
| SELECT/INSERT/UPDATE/DELETE/MERGE | pass-through after translation |
| BEGIN/COMMIT/ROLLBACK | proxy-controlled on pinned Db2 job |
| SAVEPOINT / RELEASE / ROLLBACK TO SAVEPOINT | supported in 0.1.19 on the pinned Db2 job; PostgreSQL spellings are normalized to Db2 for i savepoint syntax |
| `$1..$n` parameters | translated to `?`; NULL is forwarded; `bytea` bind values rejected in v0.1 |
| LIMIT/OFFSET numeric literals | translated |
| `value::type` simple casts | translated |
| quoted identifiers | preserved |
| SET search_path | first schema supported; mapped to Db2 CURRENT SCHEMA |
| SET statement_timeout / lock_timeout | accepted as compatibility no-op; not enforced by the proxy |
| other PostgreSQL SET options | rejected unless explicitly supported to prevent backend session-state leakage |
| unquoted identifiers | uppercased by default |
| RETURNING | not translated |
| ON CONFLICT | not translated |
| PostgreSQL arrays/json operators | not translated |
| sequences / SERIAL | not emulated |
| CREATE EXTENSION | not supported |

## Catalog

The compatibility layer is intended for discovery, not full PostgreSQL catalog equivalence. DBeaver and ORM versions can change their metadata SQL. Capture each unsupported query, add a deterministic compatibility rule and a regression test before claiming support for that client/version.

## Important OID detail

PostgreSQL OID 18 (`char`) is an internal one-byte PostgreSQL type. SQL `CHAR(n)`/Db2 `CHAR(n)` is exposed as PostgreSQL `bpchar` (OID 1042), which is the mapping expected by PostgreSQL clients.

## Timeout and cancellation semantics

`SET statement_timeout`, `SET lock_timeout` and `SET idle_in_transaction_session_timeout` are accepted so common clients can initialize, but v0.1 does **not** enforce a PostgreSQL statement deadline. `@ibm/mapepire-js` 0.6.1 exposes query paging and cursor close, but the proxy does not have a safe API for cancelling an already-running SQL request. `MAPEPIRE_JDBC_QUERY_TIMEOUT_MECHANISM` configures the underlying JDBC/Toolbox mechanism only; it is not presented as a PostgreSQL `CancelRequest` implementation.

## Protocol framing

After pg-gateway completes startup/TLS/authentication, the proxy detaches the authenticated socket. Its parser buffers incomplete frontend frames and processes multiple coalesced frames in order. `PG_MAX_FRONTEND_MESSAGE_BYTES` limits the size of a single frontend frame/buffer.

## pgAdmin startup compatibility

Version 0.1.5 intercepts the PostgreSQL-only startup probes required to establish a pgAdmin session, including current-database metadata (`pg_database`), role capability probes, tablespace metadata, `set_config`, `current_setting`, and basic PostgreSQL no-FROM scalar selects. Harmless pgAdmin session-initialization batches are executed synthetically and are never forwarded to IBM i. General multi-statement SQL remains governed by `SQL_ALLOW_MULTI_STATEMENT`.

## pgAdmin 4 9.17 compatibility - version 0.1.7

0.1.7 replaces the earlier startup-only exceptions with a Virtual PostgreSQL System Layer. pgAdmin's connection initialization, `pg_stat_gssapi`, current-role capabilities, recovery-state check, database-tree query, and `replication_type.sql` are handled locally. The replication-type probe intentionally returns exactly one row with `type = NULL`, matching PostgreSQL when neither BDR nor logical replication slots are present and preventing pgAdmin's unconditional `rows[0]` access from raising `IndexError`. PostgreSQL-only monitoring/system objects are quarantined and never sent to IBM i. See `PGADMIN_COMPATIBILITY.md`.

The proxy advertises PostgreSQL 14.0 by default for the tested pgAdmin 9.17 compatibility profile. This is a client-compatibility level, not a claim that Db2 for i implements PostgreSQL 14 administrative semantics. Startup now also emits the normal PostgreSQL `ParameterStatus` set plus `BackendKeyData` before `ReadyForQuery`, and Extended Query portal `Describe`/`Execute` sequencing follows the PostgreSQL v3 contract (no duplicate `RowDescription` on Execute).

## pgAdmin 4 9.17 database/schema browser — version 0.1.8

0.1.8 extends pgAdmin qualification from connection establishment to the database/schema browser. PostgreSQL-only dashboard/ACL/role/tablespace contracts remain virtual, while schema names and schema text are sourced from live IBM i `QSYS2.SYSSCHEMAS`. Basic schema creation from pgAdmin is supported when Comment, Privileges, Default privileges, and Security labels are left empty. The PostgreSQL `AUTHORIZATION` role is not propagated to IBM i; DDL runs under the configured Mapepire service profile.

## pgAdmin Tables discovery — version 0.1.12

The pgAdmin Tables collection is populated from live IBM i `QSYS2.SYSTABLES` rows using `TABLE_TYPE IN ('T','P')` and `FILE_TYPE='D'`. pgAdmin's pgAgent privilege probe is virtualized as false and does not reach Db2. Table catalog requests accept current stable schema OIDs and legacy pre-0.1.8 schema OIDs.

## pgAdmin Tables / CREATE TABLE — version 0.1.9

Supported: live table enumeration for IBM i `T`/`P` table-like objects, table node/property identity, basic CREATE TABLE, PostgreSQL SERIAL/SMALLSERIAL/BIGSERIAL identity semantics, and pgAdmin's virtual OWNER follow-up. PostgreSQL table inheritance, partitions, row-security, logical replication, PostgreSQL tablespaces/storage parameters and PostgreSQL privilege metadata are not claimed as IBM i equivalents.

## 0.1.20 ContextForge advisory locks

`pg_try_advisory_lock(bigint)`, `pg_advisory_unlock(bigint)`, and `pg_advisory_unlock_all()` are implemented with PostgreSQL session semantics inside a proxy process. This is sufficient for the supported single-proxy deployment used by ContextForge workers. Multiple independent proxy replicas would require an external/distributed lock backend to coordinate the same advisory-lock key across proxy processes.


## 0.1.22 ContextForge Alembic DDL types

Fresh ContextForge v1.0.7 Alembic migrations are supported by translating PostgreSQL-only/incomplete DDL types before IBM i execution: bare `VARCHAR`, `JSON`/`JSONB`, `TEXT`, `BYTEA`, and timezone-aware timestamp/time declarations. Explicit PostgreSQL `VARCHAR(n)` lengths remain unchanged.

- `TIMESTAMP WITHOUT TIME ZONE` and `TIMESTAMP WITH TIME ZONE` are normalized to Db2 for i `TIMESTAMP` for CREATE/ALTER TABLE DDL.

## 0.1.23 ContextForge / Db2 foreign-key datatype alignment

PostgreSQL permits compatible VARCHAR typmods across a foreign key (for example an unbounded VARCHAR referencing VARCHAR(36)). Db2 for i validates the dependent and parent key column descriptions more strictly. The proxy therefore records translated column datatypes from successful CREATE TABLE statements for the current PostgreSQL session and aligns dependent CREATE TABLE foreign-key columns to the exact translated parent-key type before execution.


## 0.1.24 ContextForge / Alembic RETURNING

PostgreSQL `INSERT ... RETURNING <simple columns>` is translated to `SELECT <columns> FROM FINAL TABLE (INSERT ...)`, allowing Alembic's `alembic_version` insert to receive the returned revision value on Db2 for i. The same compatibility layer maps simple-column `UPDATE ... RETURNING` to `FINAL TABLE` and `DELETE ... RETURNING` to `OLD TABLE`. Complex PostgreSQL-only RETURNING expressions fail with SQLSTATE `0A000` instead of being sent unchanged to Db2.


## 0.1.29 SQLAlchemy/Alembic live reflection

SQLAlchemy PostgreSQL reflection for ordinary application objects is backed by IBM i catalogs instead of an empty generic pg_catalog fallback. Supported Inspector families include table names/has-table, columns, indexes, foreign keys, primary keys and unique constraints. Relation OIDs are deterministic synthetic PostgreSQL OIDs. PostgreSQL system catalogs are still not fully emulated; unsupported PostgreSQL-specific metadata families remain synthetic/empty rather than being forwarded to Db2 for i.

## 0.1.30 PostgreSQL ALTER TABLE column rename (superseded)

0.1.30 normalized PostgreSQL's omitted `COLUMN` keyword to `RENAME COLUMN`. Live IBM i validation showed that Db2 for i does not support column rename in `ALTER TABLE`; 0.1.31 supersedes this direct translation with guarded CREATE OR REPLACE/PRESERVE ROWS emulation.

## 0.1.31 PostgreSQL column rename emulation

For a table whose exact translated CREATE TABLE definition is known, `ALTER TABLE t RENAME [COLUMN] old TO new` is emulated using `CREATE OR REPLACE TABLE ... ON REPLACE PRESERVE ROWS`. The new SQL name is paired with the existing IBM i `SYSTEM_COLUMN_NAME` using `FOR COLUMN`, so Db2 for i recognizes the existing physical column. If the proxy cannot prove the table definition/system column identity, it fails with `0A000` rather than using destructive copy/drop logic.

## 0.1.32 PostgreSQL JSON/JSONB and LOB-backed indexes

PostgreSQL `JSON`/`JSONB` storage is mapped to UTF-8 `CLOB(2G)`. Simple PostgreSQL casts are mapped to the same representation (`'[]'::jsonb` -> `CLOB('[]')`), including column defaults and parameterized DML.

Db2 for i does not permit LOB/XML/DATALINK columns as direct index keys. For conservative plain-column, non-unique CREATE INDEX statements that target such columns, `SQL_UNSUPPORTED_NONUNIQUE_LOB_INDEX_POLICY=skip` (default) acknowledges the PostgreSQL performance hint and logs that no physical IBM i index was created. `error` selects strict behavior. UNIQUE indexes are always rejected rather than skipped because uniqueness changes data validity. Complex expression/partial/operator-class indexes are outside this fallback and continue to normal backend validation.
## 0.1.33 empty-table NOT NULL, index-vector reflection and table rename

PostgreSQL `ALTER TABLE ... ADD COLUMN ... NOT NULL` without a default is supported when the target table is empty. The proxy probes for rows and then executes a nullable `ADD COLUMN` followed by `ALTER COLUMN ... SET NOT NULL` in the same backend transaction. It does not invent a persistent default. A non-empty table is rejected with SQLSTATE `23502`.

SQLAlchemy PostgreSQL reflection receives `pg_index.indoption` using PostgreSQL `int2vector` OID 22 and space-separated vector text. This matches SQLAlchemy's native PostgreSQL result processor and avoids psycopg decoding the value to a Python array before SQLAlchemy processes it.

PostgreSQL `ALTER TABLE old RENAME TO new` is translated to IBM i `RENAME TABLE old TO new`. Column rename remains the separate `CREATE OR REPLACE ... ON REPLACE PRESERVE ROWS` emulation introduced in 0.1.31.

The default IBM Toolbox concurrent-access setting is `MAPEPIRE_JDBC_CONCURRENT_ACCESS_RESOLUTION=1` (`use currently committed`) to improve eligible read-only `READ COMMITTED` probes. This does not guarantee that a query can read an object that has never had a committed version.

