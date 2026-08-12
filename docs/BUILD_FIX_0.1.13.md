# Build Fix 0.1.13 — build-time `IBMI_RDB_NAME` isolation

## Symptom

The 0.1.12 image build compiled TypeScript successfully and then failed in `scripts/verify-pgadmin-wire.mjs` with:

```text
Error: Missing required environment variable IBMI_RDB_NAME
```

This happened even when the operator had correctly added `IBMI_RDB_NAME` to the deployment `.env`.

## Root cause

`.env` is intentionally listed in `.dockerignore` and is not copied into the image build. This is required because `.env` also contains the IBM i Mapepire service password. Compose `env_file:` and `podman run --env-file` apply to the **runtime container**, not to `RUN` instructions executed while building the image.

`verify-pgadmin-wire.mjs` dynamically imports `ProxySession`, which imports `src/config.ts`. Starting with 0.1.12, `src/config.ts` correctly requires `IBMI_RDB_NAME`, but the build-time contract test had not been updated with a synthetic RDB value.

## Fix

0.1.13 applies defense in depth:

1. `verify-pgadmin-wire.mjs` sets `IBMI_RDB_NAME=BUILDTEST` before importing `ProxySession`, along with its existing fake IBM i credentials.
2. The build stage of both `Containerfile` and `Dockerfile` defines only synthetic non-secret test configuration. The runtime stage begins with a new `FROM node:24-bookworm-slim`, so none of these build-test values are inherited.
3. `.env` remains excluded by `.dockerignore`; real IBM i credentials are never copied into image layers.

## Runtime behavior

No runtime relaxation was introduced. The deployed container still fails fast if `IBMI_RDB_NAME`, `IBMI_HOST`, `IBMI_USER`, or `IBMI_PASSWORD` are absent from the runtime environment.

## Expected build

The previously failing sequence should now continue past:

```text
pgAdmin 9.17 compatibility contract check OK
pgAdmin psycopg3 Extended Query wire contract check OK
PostgreSQL startup handshake contract check OK
...
```

without reading the deployment `.env` during build.
