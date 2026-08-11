# Changelog


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
