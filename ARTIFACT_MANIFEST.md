# Artifact Manifest — PostgreSQL → IBM i Mapepire Proxy

Version: **0.1.5 reference implementation**

## Architecture decisions incorporated

- IBM i access uses one dedicated service account from `IBMI_USER` / `IBMI_PASSWORD` in `.env`.
- PostgreSQL-facing authentication is proxy-local and independent of IBM i credentials.
- One Mapepire `SQLJob` is leased per PostgreSQL client session to preserve transaction and session affinity.
- Official Docker Hub `node:24-bookworm-slim` is the default base for amd64 and ppc64le.
- `pg-gateway` 0.2.4 handles startup/TLS/authentication; the authenticated socket is detached to the proxy's own incremental Simple/Extended Query protocol parser.
- Runtime and Mapepire tuning parameters are centralized in `.env` / `.env.example`.

## Deliverables

- TypeScript source under `src/`.
- Unit/translation/protocol tests under `test/`.
- Dockerfile + Containerfile + Compose definition.
- Docker buildx and Podman multi-architecture build scripts.
- Healthcheck helper.
- Mermaid architecture/query/transaction diagrams.
- Technical specification, implementation plan, compatibility matrix, security guide, testing guide, source references, validation notes and a **separate deployment runbook**.
- Full `.env` configuration reference.
- Build-fix notes `docs/BUILD_FIX_0.1.1.md` through `docs/BUILD_FIX_0.1.5.md`; source-to-source patches are delivered separately for traceability.

## Validation scope

See `docs/VALIDATION.md`. This build environment could not resolve npm packages from the public registry, so the archive does not claim a dependency-resolved container build here. TypeScript syntax/transpile validation, protocol/translator targeted tests and shell/configuration checks are performed before packaging. A full `npm install`, `npm test`, `npm run typecheck`, amd64 build and native ppc64le build are required in the deployment environment before production promotion.

### 0.1.3 Mapepire runtime compatibility correction

`src/mapepire/sdk.ts` is the ESM/CommonJS interop boundary for `@ibm/mapepire-js` 0.6.1. Version 0.1.4 superseded the former Mapepire-only build check with the consolidated `scripts/verify-runtime-modules.mjs`. See `docs/BUILD_FIX_0.1.3.md` and `docs/BUILD_FIX_0.1.4.md`.

### 0.1.4 runtime dependency compatibility correction

`src/sql/parser-sdk.ts` is the ESM/CommonJS interop boundary for `node-sql-parser` 5.4.0. `scripts/verify-runtime-modules.mjs` validates all runtime package boundaries used by the service: Mapepire, node-sql-parser, dotenv/config and pg-gateway. See `docs/BUILD_FIX_0.1.4.md`.

### 0.1.5 pgAdmin startup compatibility correction

`src/sql/pgadmin.ts` intercepts PostgreSQL-only pgAdmin startup metadata/session probes before SQL translation so they never reach Db2 for i. It covers `pg_database`, role/recovery probes, tablespace metadata, `set_config`, `current_setting`, locale checks and simple no-FROM scalar probes. Harmless pgAdmin initialization batches are synthetic-only; general multi-statement execution remains disabled by default. See `docs/BUILD_FIX_0.1.5.md`.
