# syntax=docker/dockerfile:1
# Official Docker Hub Node 24 LTS image; tag publishes amd64 + ppc64le manifests.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app

# Build-time contract tests must never depend on the deployment .env.
# .env is intentionally excluded from the image because it can contain
# IBM i service credentials. These values are synthetic and exist only
# in the build stage; the runtime stage starts from a fresh FROM image.
ENV IBMI_RDB_NAME=BUILDTEST \
    IBMI_HOST=build-test.invalid \
    IBMI_USER=build-test \
    IBMI_PASSWORD=build-test \
    PG_PROXY_USER=proxyuser \
    PG_PROXY_PASSWORD=proxypass \
    DEFAULT_SCHEMA=MYLIB \
    PG_SERVER_VERSION=14.0

COPY package*.json ./
COPY scripts/verify-runtime-modules.mjs scripts/verify-pgadmin-compat.mjs scripts/verify-pgadmin-wire.mjs scripts/verify-startup-wire.mjs scripts/verify-pgadmin-browser.mjs scripts/verify-pgadmin-schema.mjs scripts/verify-pgadmin-table.mjs scripts/verify-pgadmin-table-child.mjs scripts/verify-pgadmin-view.mjs scripts/verify-sqlalchemy-compat.mjs scripts/verify-contextforge-advisory-lock.mjs scripts/verify-contextforge-ddl.mjs scripts/verify-contextforge-fk-types.mjs scripts/verify-contextforge-returning.mjs scripts/verify-sql-translation.mjs ./scripts/
RUN npm install --ignore-scripts \
 && node scripts/verify-runtime-modules.mjs
COPY tsconfig.json eslint.config.js .prettierrc.json ./
COPY src ./src
RUN npm run build \
 && node scripts/verify-pgadmin-compat.mjs \
 && node scripts/verify-pgadmin-wire.mjs \
 && node scripts/verify-startup-wire.mjs \
 && node scripts/verify-pgadmin-browser.mjs \
 && node scripts/verify-pgadmin-schema.mjs \
 && node scripts/verify-pgadmin-table.mjs \
 && node scripts/verify-pgadmin-table-child.mjs \
 && node scripts/verify-pgadmin-view.mjs \
 && node scripts/verify-sqlalchemy-compat.mjs \
 && node scripts/verify-contextforge-advisory-lock.mjs \
 && node scripts/verify-contextforge-ddl.mjs \
 && node scripts/verify-contextforge-fk-types.mjs \
 && node scripts/verify-contextforge-returning.mjs \
 && node scripts/verify-sql-translation.mjs
RUN npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

# The official Node image already provides an unprivileged `node` user/group
# (UID/GID 1000) on every supported architecture. Reusing it avoids collisions
# with Debian system groups such as `proxy`.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node scripts ./scripts

USER node
EXPOSE 5432 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "scripts/healthcheck.mjs"]

CMD ["node", "dist/src/index.js"]
