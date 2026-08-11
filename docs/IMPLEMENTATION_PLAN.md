# Implementation Plan

## Objective

Deliver a PostgreSQL v3 compatibility gateway that lets PostgreSQL clients reach Db2 for IBM i through Mapepire while all IBM i access is performed by a dedicated service profile configured in `.env`.

## Phase 1 — Foundation — implemented

- TypeScript + native ESM project.
- Central `.env` validation.
- Structured JSON logging.
- Official Node 24 LTS Debian slim container base.
- Non-root runtime user.
- Separate health HTTP listener.

- Verify coalesced and fragmented Query/Parse/Bind/Execute/Sync frames.

Acceptance criteria: process starts only with valid mandatory IBM i settings and exposes `/healthz`.

## Phase 2 — IBM i service-user backend — implemented

- `IBMI_USER` / `IBMI_PASSWORD` are the only credentials sent to Mapepire.
- Persistent `SQLJob` objects are opened at startup.
- Session-affinity pool leases one Mapepire job to one PostgreSQL connection.
- Pool grows from `MAPEPIRE_POOL_STARTING_SIZE` to `MAPEPIRE_POOL_MAX_SIZE`.
- Release performs defensive `ROLLBACK` and restores `DEFAULT_SCHEMA`.
- Broken jobs are discarded and replenished.
- In-flight job creation is reserved against `MAPEPIRE_POOL_MAX_SIZE`, preventing connection bursts from temporarily exceeding the configured IBM i job cap.

Acceptance criteria: `VALUES CURRENT USER` returns the IBM i service profile and transaction state never crosses PostgreSQL sessions.

## Phase 3 — PostgreSQL wire protocol — implemented baseline

- Startup/authentication/TLS delegated to `pg-gateway`; detach the authenticated socket to the proxy parser before Query/Extended Query processing.
- Proxy-local MD5, cleartext or no-password authentication.
- Simple Query handling.
- Extended Parse/Bind/Describe/Execute/Sync/Close/Flush/Terminate handling.
- PostgreSQL extended-protocol error recovery until Sync.
- Text RowDescription/DataRow serialization.

Acceptance criteria: `psql` can authenticate, issue reads/writes and run explicit transactions.

## Phase 4 — SQL translation — implemented baseline

Pipeline:

1. multi-statement policy;
2. `$n` to `?` parameters with reorder map;
3. simple `::type` to `CAST` conversion;
4. PostgreSQL LIMIT/OFFSET conversion;
5. common function/special-register rewrites;
6. information_schema mapping;
7. pg_catalog compatibility rules;
8. unquoted identifier normalization;
9. optional global row cap.

`SET search_path` maps the first schema to Db2 `SET CURRENT SCHEMA`.

Acceptance criteria: representative SQL regression tests pass and no write statement is automatically retried.

## Phase 5 — Catalog and type compatibility — implemented baseline

- SYSIBM mappings for tables, columns and schemata.
- QSYS2.SYSSCHEMAS/QSYS2.SYSTABLES derived compatibility for namespaces/classes.
- Static PostgreSQL type/OID model for supported primitive types.
- Db2 result metadata to PostgreSQL OID mapping.

Acceptance criteria: basic metadata discovery works. Complex DBeaver/ORM metadata SQL must be validated per client/version before declaring full compatibility.

## Phase 6 — Result paging and transaction behavior — implemented

- Mapepire cursor paging through `execute(rows)` + `fetchMore(rows)`.
- `MAPEPIRE_FETCH_SIZE` controls page size.
- Explicit PG transactions remain on a pinned Db2 job.
- Implicit PG autocommit statements are explicitly committed because Mapepire JDBC auto-commit is disabled. `CommandComplete` is sent only after this commit succeeds.
- On explicit transaction error, ReadyForQuery state becomes failed (`E`) until rollback/commit resolution.

Acceptance criteria: a result larger than one Mapepire page is complete and a rollback test leaves data unchanged.

## Phase 7 — Operations and multi-architecture — implemented

- `/healthz`, `/readyz`, `/stats`.
- Container HEALTHCHECK requires PostgreSQL listener + healthy Mapepire pool.
- Docker buildx script targets `linux/amd64,linux/ppc64le`.
- Podman manifest script supplied.
- Separate deployment runbook.

Acceptance criteria: the same source builds on x86_64 and ppc64le using the official Node 24 image manifest.

## Phase 8 — pgAdmin 9.17 interoperability hardening — implemented

The initial metadata-by-metadata approach was replaced by a **Virtual PostgreSQL System Layer** plus a PostgreSQL-system firewall:

1. pgAdmin startup/session statements are answered locally.
2. `version()`, `pg_database`, `pg_stat_gssapi`, role-capability and recovery-state queries are covered with deterministic fields, order and PostgreSQL OIDs.
3. Database-tree metadata is synthesized without accessing non-existent Db2 `PG_CATALOG` objects.
4. PostgreSQL monitoring families (`pg_stat_*`, locks, replication, prepared transactions and related system objects) are quarantined from Mapepire and receive safe virtual results when possible.
5. Unknown PostgreSQL-system SQL cannot fall through to Db2.
6. Scalar application `SELECT` without a top-level `FROM` receives `FROM SYSIBM.SYSDUMMY1` before Db2 execution.
7. `PG_SERVER_VERSION=14.0` is the validated pgAdmin 9.17 compatibility profile.
8. The exact pgAdmin `replication_type.sql` request returns one `type=NULL` row, matching the upstream template's no-replication case and pgAdmin's unconditional `rows[0]` access.
9. PostgreSQL startup is completed only after Mapepire/session attachment and includes ParameterStatus + BackendKeyData before ReadyForQuery.
10. Extended Query portal Describe/Execute semantics follow PostgreSQL: RowDescription is emitted by Describe for rowsets and is not duplicated by Execute.
11. `verify-pgadmin-compat.mjs`, `verify-pgadmin-wire.mjs`, and `verify-startup-wire.mjs` run after TypeScript compilation during the container build and must pass before an image is produced.

Acceptance criteria: the exact pgAdmin 9.17 initialization, GSS, role-capability, recovery and replication-type probes are answered with the required row shapes; psycopg3 Extended Query framing is protocol-correct; startup publishes BackendKeyData and does not become ReadyForQuery before the Mapepire-backed session is ready; and unknown PostgreSQL system relations are prevented from reaching Mapepire.

## Phase 9 — broader client interoperability — production expansion

Before declaring support for additional clients/ORM versions:

1. capture startup and metadata SQL from the exact DBeaver, JDBC, Npgsql or ORM versions that will be supported;
2. add deterministic metadata projections where clients require richer `pg_attribute`, constraints, index or function metadata;
3. extend the current read-only portal materialization strategy if a target driver requires statement-level Describe metadata before Bind;
4. implement `PortalSuspended`/resumable Execute if a target driver depends on extended-protocol cursor paging;
5. add `CancelRequest`/statement-timeout support if/when a safe running-query cancellation mechanism is available through the selected Mapepire client/backend path;
6. add TLS/mTLS policy and external secret injection appropriate to the deployment platform;
7. run load testing sized to IBM i job limits and the application's connection-pool behavior.

These are broader compatibility-hardening items, not prerequisites for the pgAdmin 9.17 connection contract implemented through 0.1.8.
