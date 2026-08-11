# syntax=docker/dockerfile:1
# Official Docker Hub Node 24 LTS image; tag publishes amd64 + ppc64le manifests.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app

COPY package*.json ./
COPY scripts/verify-runtime-modules.mjs scripts/verify-pgadmin-compat.mjs ./scripts/
RUN npm install --ignore-scripts \
 && node scripts/verify-runtime-modules.mjs
COPY tsconfig.json eslint.config.js .prettierrc.json ./
COPY src ./src
RUN npm run build \
 && node scripts/verify-pgadmin-compat.mjs
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
