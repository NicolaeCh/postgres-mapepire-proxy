# Runtime fix 0.1.3 — Mapepire CommonJS / Node ESM interop

## Symptom

The 0.1.2 container builds successfully but exits immediately at runtime on both architectures with:

```text
SyntaxError: The requested module '@ibm/mapepire-js' does not provide an export named 'SQLJob'
```

Because a restart policy restarts the container, the same Node.js stack trace can appear continuously.

## Root cause

`@ibm/mapepire-js` 0.6.1 exposes `SQLJob` in its TypeScript source/declarations, so TypeScript accepts:

```ts
import { SQLJob } from '@ibm/mapepire-js';
```

However the published npm package points `main` at `dist/index.js`, and that file is produced by Webpack with `library.type = "commonjs"`. The proxy itself is native ESM (`"type": "module"`). With Node 24, the CommonJS bundle is not guaranteed to expose `SQLJob` as an ESM named export, so the application fails during module instantiation before it can connect to IBM i.

This is a packaging/interoperability issue, not an AMD64/PPC64LE issue and not a Mapepire server issue.

## Fix

0.1.3 introduces `src/mapepire/sdk.ts`. It loads the published CommonJS package through Node's supported ESM bridge:

```ts
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const loaded = require('@ibm/mapepire-js');
```

The adapter then validates and exports the `SQLJob` constructor for the rest of the ESM application. Type information continues to come from the package's TypeScript declarations.

No IBM i credentials, JDBC properties, SQL behavior, or PostgreSQL protocol behavior changes are required.

## Build-time smoke test

The container build now copies and executes:

```text
scripts/verify-mapepire-module.mjs
```

immediately after `npm install`. It loads the package using the same `createRequire()` mechanism and verifies that `SQLJob` is a constructor. A future incompatible Mapepire package will therefore fail the **image build**, rather than creating an image that crashes only after deployment.

Expected build output includes a line similar to:

```text
Mapepire runtime module check OK: { SQLJob: 'function', ... }
```

## Rebuild

```bash
podman build --no-cache -f Containerfile -t postgres-mapepire-proxy:0.1.3 .
```

Then run with the existing `.env`:

```bash
podman run --rm --name postgres-mapepire-proxy \
  --env-file .env \
  -p 5432:5432 -p 8080:8080 \
  postgres-mapepire-proxy:0.1.3
```
