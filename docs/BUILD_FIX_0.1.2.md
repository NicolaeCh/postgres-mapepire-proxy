# Build fix 0.1.2 — runtime user/group collision

## Symptom

The TypeScript build completes, but the runtime stage fails with:

```text
groupadd: group 'proxy' already exists
Error: building at STEP "RUN groupadd --system --gid 10001 proxy ...": exit status 9
```

## Root cause

`node:24-bookworm-slim` is based on Debian. Debian already defines a system group named `proxy`, so creating another group with the same name fails. This is unrelated to Mapepire, TypeScript, or PPC64LE.

The official Node image already creates an unprivileged `node` account and group with UID/GID 1000. The proxy does not require a dedicated OS identity, so creating another account adds no security benefit and introduces a platform/base-image collision.

## Fix

Both `Containerfile` and `Dockerfile` now:

- reuse the image-provided `node:node` identity;
- copy runtime files with `--chown=node:node`;
- run the application with `USER node`; and
- contain no `groupadd` or `useradd` command.

Relevant runtime section:

```dockerfile
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node scripts ./scripts

USER node
```

## Build

PPC64LE or native IBM Power host:

```bash
podman build --no-cache -f Containerfile -t postgres-mapepire-proxy:0.1.2 .
```

AMD64:

```bash
podman build --no-cache -f Containerfile -t postgres-mapepire-proxy:0.1.2 .
```

The same source and Containerfile are used on both architectures.
