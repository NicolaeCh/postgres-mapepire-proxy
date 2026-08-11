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
podman build -f Containerfile -t postgres-mapepire-proxy:0.1.4 .
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
