# Build fix 0.1.1 — Node 24 / TypeScript Buffer types

## Symptom

Container builds on both `linux/amd64` and `linux/ppc64le` failed in the build stage at `npm run build` with three TypeScript errors:

- `PoolStats` was rejected as `Record<string, unknown>`.
- PostgreSQL wire buffers produced `Buffer<ArrayBuffer>` / `Buffer<ArrayBufferLike>` incompatibilities.
- The session's incremental frontend buffer inherited the narrower `Buffer` backing-store type from `Buffer.alloc()`.

These are compile-time typing issues and are not architecture-specific Mapepire failures.

## Corrections

1. `src/logger.ts`
   - Logger metadata now accepts `object` rather than `Record<string, unknown>`.
   - A normal typed interface such as `PoolStats` can therefore be logged without adding an artificial string index signature.

2. `src/postgres/wire.ts`
   - The internal `frame()` payload boundary is `Uint8Array`.
   - `Buffer`, `Buffer.subarray()` and other typed-array views can all cross this boundary without coupling the code to a specific backing `ArrayBuffer` generic.
   - `Buffer.set()` is used to copy the payload into the outgoing PostgreSQL frame.

3. `src/proxy/session.ts`
   - The incremental TCP accumulation field is now explicitly `Uint8Array`.
   - It remains compatible with `Buffer.concat()` and with `consumeFrontendMessages()` while avoiding generic `Buffer` assignment conflicts.

4. `src/server.ts`
   - Incoming `node:net` data is normalized to a byte array before it reaches the protocol parser.

## Rebuild

Clean old build cache first so the TypeScript stage cannot reuse the previous source layer:

```bash
podman build --no-cache -f Containerfile -t postgres-mapepire-proxy:0.1.1 .
```

For Docker:

```bash
docker build --no-cache -f Dockerfile -t postgres-mapepire-proxy:0.1.1 .
```

For the multi-architecture helper scripts:

```bash
IMAGE=registry.example.com/postgres-mapepire-proxy:0.1.1 \
  ./scripts/build-multiarch-podman.sh
```

or:

```bash
IMAGE=registry.example.com/postgres-mapepire-proxy:0.1.1 \
  ./scripts/build-multiarch-docker.sh
```

The expected build-stage result is that `RUN npm run build` completes and the image proceeds to the runtime stage.
