# Upstream Sources and Version Decisions

Verified on 2026-08-11.

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
- https://github.com/taozhi8833998/node-sql-parser

Decision: 5.4.0. It is used as a secondary classifier, not as a complete PostgreSQL-to-Db2 transpiler. Upstream documents Node.js usage through CommonJS (`const { Parser } = require('node-sql-parser')`). Because the proxy itself is native ESM, version 0.1.4 isolates that boundary in `src/sql/parser-sdk.ts` using Node's `createRequire()` bridge.

## pgAdmin 4 9.17 compatibility sources (0.1.6)

- https://www.pgadmin.org/docs/pgadmin4/9.17/release_notes_9_17.html
- https://github.com/pgadmin-org/pgadmin4/blob/REL-9_17/web/pgadmin/utils/driver/psycopg3/connection.py
- https://github.com/pgadmin-org/pgadmin4/blob/REL-9_17/web/pgadmin/browser/server_groups/servers/__init__.py
- https://github.com/pgadmin-org/pgadmin4/blob/REL-9_17/web/pgadmin/browser/server_groups/servers/templates/connect/sql/default/check_recovery.sql
- https://github.com/pgadmin-org/pgadmin4/blob/REL-9_17/web/pgadmin/browser/server_groups/servers/databases/templates/databases/sql/default/nodes.sql
- https://github.com/pgadmin-org/pgadmin4/blob/REL-9_17/web/pgadmin/browser/server_groups/servers/templates/servers/sql/default/stats.sql
- https://www.ibm.com/docs/en/i/7.4.0?topic=views-sysdummy1

## pgAdmin 9.17 / PostgreSQL protocol references added for 0.1.7

- pgAdmin REL-9_17 psycopg3 connection: https://github.com/pgadmin-org/pgadmin4/blob/REL-9_17/web/pgadmin/utils/driver/psycopg3/connection.py
- pgAdmin REL-9_17 server connect path: https://github.com/pgadmin-org/pgadmin4/blob/REL-9_17/web/pgadmin/browser/server_groups/servers/__init__.py
- pgAdmin REL-9_17 server utilities (`get_replication_type`): https://github.com/pgadmin-org/pgadmin4/blob/REL-9_17/web/pgadmin/browser/server_groups/servers/utils.py
- pgAdmin REL-9_17 replication type SQL: https://github.com/pgadmin-org/pgadmin4/blob/REL-9_17/web/pgadmin/browser/server_groups/servers/templates/servers/sql/default/replication_type.sql
- PostgreSQL 14 protocol message flow: https://www.postgresql.org/docs/14/protocol-flow.html
- PostgreSQL 14 protocol message formats: https://www.postgresql.org/docs/14/protocol-message-formats.html
- pg-gateway 0.2.4 connection implementation: https://github.com/supabase-community/pg-gateway/blob/v0.2.4/packages/pg-gateway/src/connection.ts
