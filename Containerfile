# syntax=docker/dockerfile:1
# Official Docker Hub Node 24 LTS image; tag publishes amd64 + ppc64le manifests.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app

COPY package*.json ./
RUN npm install --ignore-scripts
COPY tsconfig.json eslint.config.js .prettierrc.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --system --gid 10001 proxy \
 && useradd --system --uid 10001 --gid proxy --home-dir /app --shell /usr/sbin/nologin proxy

COPY --from=build --chown=proxy:proxy /app/node_modules ./node_modules
COPY --from=build --chown=proxy:proxy /app/dist ./dist
COPY --chown=proxy:proxy package.json ./package.json
COPY --chown=proxy:proxy scripts ./scripts

USER proxy
EXPOSE 5432 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "scripts/healthcheck.mjs"]

CMD ["node", "dist/src/index.js"]
