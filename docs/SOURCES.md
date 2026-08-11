# Upstream Sources and Version Decisions

Verified on 2026-08-10.

## Node.js / official container

- Official Node Docker image: https://hub.docker.com/_/node
- Node release status: https://nodejs.org/en/about/previous-releases

Decision: use the official floating major-LTS tag `node:24-bookworm-slim`. As verified on 2026-08-10, Node 24 is LTS while Node 20 is EOL, and Docker Hub publishes the Bookworm-slim Node 24 image for both `linux/amd64` and `linux/ppc64le`. Production environments may override `NODE_IMAGE` with a tested exact tag/digest.

## Mapepire

- Server install/config: https://mapepire-ibmi.github.io/guides/sysadmin/
- Node.js usage: https://mapepire-ibmi.github.io/guides/usage/nodejs/
- Client source: https://github.com/Mapepire-IBMi/mapepire-js
- npm package: https://www.npmjs.com/package/@ibm/mapepire-js

Decision: `@ibm/mapepire-js` 0.6.1. The official client is TypeScript/pure JavaScript and uses persistent Mapepire transport. The documented query API provides `execute()` and `fetchMore()` paging. The project deliberately wraps `SQLJob` with session-affinity rather than sending each PostgreSQL statement through the general Mapepire pool because PostgreSQL transactions require backend-session affinity.

## PostgreSQL gateway

- Source/API: https://github.com/supabase-community/pg-gateway
- npm package: https://www.npmjs.com/package/pg-gateway

Decision: stable `pg-gateway` 0.2.4 for startup, TLS and proxy-local authentication. The upstream 0.2.4 source still marks `onQuery` as TODO. The proxy therefore detaches the authenticated socket and uses its own incremental parser for post-authentication Query/Extended Query messages rather than relying on pg-gateway's 0.2.x query parser. `clientInfo.parameters` is used for StartupMessage values.

## IBM i catalog

- IBM i catalog overview: https://www.ibm.com/docs/en/i/7.5.0?topic=views-i-catalog-tables

Decision: `QSYS2.SYSSCHEMAS` and `QSYS2.SYSTABLES` are used for PostgreSQL namespace/relation compatibility. ANSI/ISO-style mappings use SYSIBM views where specified by the project.

## SQL parser

- https://www.npmjs.com/package/node-sql-parser

Decision: 5.4.0. It is used as a secondary classifier, not as a complete PostgreSQL-to-Db2 transpiler.
