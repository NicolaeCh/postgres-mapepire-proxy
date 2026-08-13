# Delivery Validation

## Performed in the build workspace

- Reviewed all project source and configuration files.
- TypeScript source was parsed/transpiled with the available TypeScript compiler to catch syntax-level errors.
- PostgreSQL frame serializers and SQL translation have unit-test sources under `test/`. Targeted framing checks covered two coalesced frames, a fragmented frame, ReadyForQuery/RowDescription/DataRow serialization, binary boolean decoding and deliberate bytea-bind rejection.
- Checked the Mapepire API used by the implementation against the official Mapepire documentation/source: `SQLJob`, JDBC options, parameter queries, `execute(rows)`, `fetchMore(rows)`, `close()` and secure DaemonServer options.
- Checked `pg-gateway` 0.2.4 authentication, TLS, `clientInfo.parameters`, `detach()` and query-path behavior against upstream source; the implementation detaches before post-auth query processing.
- Checked the official Node Docker Hub manifest support for AMD64 and PPC64LE.

## Workspace limitation

A complete dependency installation could not be completed inside the artifact-generation sandbox. The environment-specific npm registry did not provide all development dependencies, and a forced public-registry attempt timed out. Therefore the delivered ZIP does **not** claim an end-to-end dependency-resolved TypeScript build or container build was executed in this sandbox. Syntax-level/transpile checks and targeted translation/wire tests were performed instead.

On the target build host run:

```bash
npm install
# Retain the generated package-lock.json after validation for reproducible production builds.
npm run typecheck
npm test
npm run build
podman build -f Containerfile -t postgres-mapepire-proxy:0.1.23 .
```

Then execute the smoke tests in `docs/TESTING.md` against a real Mapepire server before production deployment.

## 0.1.1 build-compatibility validation

Version 0.1.1 specifically addresses the Node 24 / TypeScript generic `Buffer` errors reported during both AMD64 and PPC64LE container builds. The corrected source was type-checked with TypeScript 5.8 against strict modern Node type definitions. The protocol-only source was additionally compiled independently to verify the `Buffer<ArrayBuffer>` / `Buffer<ArrayBufferLike>` boundary fix.

The build-stage command remains:

```bash
npm run build
```

and should now complete before the runtime stage is entered on both target architectures.


## 0.1.2 runtime-image identity validation

Version 0.1.2 removes the custom `proxy` OS account creation from both container definitions. The official Node 24 Bookworm Slim image defines an unprivileged `node` user/group, and the runtime stage now reuses that identity. Static validation confirms there are no remaining `groupadd`, `useradd`, `USER proxy`, or `--chown=proxy:proxy` directives in `Containerfile` or `Dockerfile`.

## 0.1.3 Mapepire module-format validation

Version 0.1.3 removes the native ESM named runtime import of `SQLJob` from `@ibm/mapepire-js`. The Mapepire package is loaded through `createRequire()` because version 0.6.1 publishes a Webpack CommonJS `main` bundle while the proxy runs as native ESM. A build-time smoke test now verifies that the installed module exposes a callable `SQLJob` constructor before TypeScript compilation and before the runtime image is produced.

## 0.1.4 runtime dependency-format validation

Version 0.1.4 adds a consolidated runtime-module smoke test executed immediately after `npm install` in both `Containerfile` and `Dockerfile`. It validates the actual installed package entry points rather than relying only on TypeScript declaration files. This specifically prevents CommonJS/ESM mismatches from reaching container startup.


## 0.1.5 pgAdmin startup-compatibility validation

The 0.1.5 compatibility layer was type-checked independently with TypeScript
5.8 and exercised against representative pgAdmin startup probes. Targeted
runtime checks verified that these are answered locally and do not reach
Mapepire/Db2:

- current database detail and database-tree `pg_catalog.pg_database` probes;
- `pg_user` recovery/replay-state probe;
- `pg_roles` capability probe;
- `set_config('search_path', ...)` and `set_config('bytea_output', ...)`;
- `current_setting(...)`, including the locale `UNION` probe;
- PostgreSQL no-FROM scalar `SELECT 1`;
- the documented pgAdmin multi-statement initialization batch containing
  `DateStyle`, `client_min_messages`, `bytea_output`, and `client_encoding`.

The previously delivered 0.1.4 source is reported by the deployment user to
build successfully on PPC64LE. Version 0.1.5 does not change Mapepire module
loading or the container runtime identity; it adds the compatibility layer and
diagnostics described above. A native 0.1.5 image build and live pgAdmin
connection remain deployment acceptance tests.


## 0.1.7 pgAdmin 9.17 connection and wire-contract validation

Version 0.1.7 was audited against the pgAdmin 4 REL-9_17 psycopg3 connection implementation, server connect handler, recovery template, replication-type helper/template, and PostgreSQL 14 frontend/backend protocol documentation.

The compiled compatibility tests cover:

- the initialization `SET` / `set_config` batch;
- `SELECT version()` with a `version` column and at least one row;
- current-database metadata from `pg_catalog.pg_database`;
- `pg_catalog.pg_stat_gssapi`;
- current-role capability fields including `can_signal_backend`;
- pgAdmin's recovery/replay-state query;
- the exact REL-9_17 `replication_type.sql` query, asserting exactly one row and `type=NULL`;
- database-tree metadata projection;
- quarantine of unknown PostgreSQL system relations;
- PostgreSQL startup ordering: `AuthenticationOk` -> `ParameterStatus` -> `BackendKeyData` -> `ReadyForQuery`;
- psycopg3 Extended Query ordering: ParseComplete -> BindComplete -> RowDescription at portal Describe -> DataRow(s)/CommandComplete at Execute -> ReadyForQuery at Sync;
- no duplicate RowDescription during Execute and matching RowDescription/DataRow column counts.

Both `Containerfile` and `Dockerfile` execute:

```text
node scripts/verify-pgadmin-compat.mjs
node scripts/verify-pgadmin-wire.mjs
node scripts/verify-startup-wire.mjs
```

after `npm run build`, so a regression prevents image creation. The delivery workspace does not have a live pgAdmin + IBM i/Mapepire endpoint; the target PPC64LE/AMD64 build and a real pgAdmin connection remain deployment acceptance tests.

## 0.1.8 pgAdmin browser/schema validation

The live pgAdmin 9.17 error log supplied for 0.1.7 was used to derive browser regression contracts. In the delivery workspace, 22 TypeScript source/test files pass syntax transpilation. A full TypeScript `--noEmit` check also passes against local compatibility declarations for external packages; the target container build remains the authoritative dependency-resolved check. The compiled 0.1.8 browser and schema verification scripts pass and cover dashboard `chart_data`, scheduler scalar zero, database ACL keys, database properties, role/tablespace `description`, schema node/property rows, schema ACL/default-ACL dictionaries, stable schema OIDs, and CREATE SCHEMA translation. The SELECT-without-FROM rewrite was separately exercised with top-level WHERE/GROUP/HAVING to confirm `SYSIBM.SYSDUMMY1` is inserted before those clauses.

## 0.1.9 table-browser validation

The compiled-contract checks cover pgAdmin 9.17's table collection count, node row shape, table property row shape, stable table OID/name lookup, PostgreSQL SERIAL-family translation and scalar SELECT EXISTS translation. The real IBM i acceptance test must confirm `QSYS2.SYSTABLES` visibility under the configured Mapepire service profile.

## 0.1.12 RDB identity / schema-browser validation

The pgAdmin schema classifier was exercised against REL-9_17-shaped SQL containing a top-level `FROM pg_catalog.pg_namespace` plus a nested catalog-exclusion predicate with `nspname='pg_catalog'` and `pg_class`. The former classifier reproduced the deployment failure by returning `oidByName(pg_catalog)`; 0.1.12 returns `nodes` and renders the expected `APP2`/`MONAI` rows. The simple `SELECT nsp.oid FROM pg_namespace ... WHERE nspname='MONAI'` lookup remains classified as `oidByName`.

All TypeScript files under `src/` and `test/` pass TypeScript 5.8 syntax/transpile validation in the delivery workspace. All environment variables referenced by source are present in `.env.example`, including the new required `IBMI_RDB_NAME`. A dependency-resolved container build remains the authoritative type/runtime validation.


## 0.1.14 schema filtering and table-child validation

All 20 TypeScript files under `src/` pass TypeScript 5.8 syntax/transpile validation in the delivery workspace. The dedicated compiled mini-contract checks pass for pgAdmin schema filtering and table-child behavior. They cover: default hiding of `Q*`/`SYS*` system schemas, disabling that filter, pgAdmin Columns nodes from IBM i `SYSCOLUMNS2`, Indexes nodes from `SYSINDEXES`, exact empty partition-node contracts, and remaining PostgreSQL catalog `::OID` quarantine. All 54 environment variables referenced by source are present in `.env.example`, including `PGADMIN_HIDE_SYSTEM_SCHEMAS` and `IBMI_CURRENT_SCHEMA`.

The target `podman build` remains the authoritative dependency-resolved TypeScript/runtime check because public npm dependency installation is unavailable in this delivery environment.


## 0.1.15 Tables regression validation

The table-child contract tests include a normal pgAdmin Tables node request containing nested `pg_trigger` count subqueries. The child classifier must return no match for that SQL, and the parent IBM i Tables classifier must classify it as `nodes`.


## 0.1.19 SQLAlchemy / psycopg nested-transaction validation

The compiled SQLAlchemy compatibility verifier now covers psycopg 3.3.4 nested transaction commands (`SAVEPOINT`, `RELEASE`, `ROLLBACK TO`) and the exact Db2 for i SQL emitted for each command. It also verifies that psycopg's `TypeInfo.fetch()` query for the optional `hstore` extension receives a five-column empty rowset (`name`, `oid`, `array_oid`, `regtype`, `delimiter`) instead of the generic synthetic `pg_type` enumeration. Live IBM i acceptance must still execute a savepoint sequence through Mapepire to validate the backend commitment-control environment.
