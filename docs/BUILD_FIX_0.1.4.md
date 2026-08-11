# Runtime fix 0.1.4 — node-sql-parser CommonJS / Node ESM interop

## Symptom

The 0.1.3 image builds successfully, but Node 24 exits during module instantiation with:

```text
SyntaxError: The requested module 'node-sql-parser' does not provide an export named 'Parser'
```

The failure is architecture-independent and can occur on both amd64 and ppc64le.

## Root cause

The proxy is a native ESM application (`"type": "module"`). `node-sql-parser` 5.4.0 ships TypeScript declarations that allow TypeScript to compile a named import, but its documented Node.js loading pattern is CommonJS:

```javascript
const { Parser } = require('node-sql-parser');
```

Therefore this source form is unsafe at runtime under Node 24:

```typescript
import { Parser } from 'node-sql-parser';
```

## Fix

Version 0.1.4 adds `src/sql/parser-sdk.ts` as the single CommonJS/ESM interop boundary. It loads `node-sql-parser` with `createRequire(import.meta.url)` and exports the validated `Parser` constructor to the rest of the ESM application.

`src/sql/classifier.ts` now imports only from that local adapter.

## Build-time runtime-module validation

The old Mapepire-only check is replaced by `scripts/verify-runtime-modules.mjs`. During image construction it verifies the actual installed runtime modules before TypeScript compilation:

1. `@ibm/mapepire-js` exposes a callable `SQLJob` via CommonJS `require()`.
2. `node-sql-parser` exposes a callable `Parser` via CommonJS `require()` and can parse a PostgreSQL `SELECT`.
3. `dotenv/config` can be imported through its runtime entry point.
4. `pg-gateway` exposes `PostgresConnection` and `hashMd5Password` through its ESM entry point.

A module-format incompatibility now fails the image build instead of causing a restart loop after deployment.

## Rebuild

```bash
podman build --no-cache -f Containerfile -t postgres-mapepire-proxy:0.1.4 .
```

Expected build output includes:

```text
Mapepire runtime module check OK
node-sql-parser runtime module check OK
dotenv/config runtime module check OK
pg-gateway runtime module check OK
```

No `.env` change is required for this correction.
