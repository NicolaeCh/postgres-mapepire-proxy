# Build fix 0.1.25

## Problem

After the PostgreSQL/Db2 syntax, datatype, foreign-key and `RETURNING` compatibility fixes, a transactional application reached its first data change and IBM i returned `SQL7008 / SQLSTATE 55019` for an unjournaled table. The error also exposed an observability gap: application configuration named the PostgreSQL database, but the effective IBM i schema was not visible in the authentication logs.

## General design

0.1.25 treats the issue as a PostgreSQL-to-IBM-i platform contract rather than an application-specific exception.

1. The PostgreSQL database (`IBMI_RDB_NAME`) and effective schema are separate.
2. `IBMI_CURRENT_SCHEMA` is the proxy default only. Per-connection routing uses PostgreSQL `search_path`.
3. The proxy confirms the backend `CURRENT SCHEMA` with `VALUES CURRENT SCHEMA` and logs it.
4. Transactional writes keep real PostgreSQL semantics; the proxy does not disable commitment control to bypass SQL7008.
5. The selected IBM i schema is resolved through `QSYS2.SYSSCHEMAS` to both its SQL name and `SYSTEM_SCHEMA_NAME`, then preflighted for automatic journaling:
   - SQL schema journal `QSQJRN`; or
   - library journal inheritance (`STRJRNLIB`) visible through `QSYS2.JOURNALED_OBJECTS`.
6. A missing schema may be provisioned with `IBMI_AUTO_CREATE_CURRENT_SCHEMA=true`. SQL `CREATE SCHEMA` is used so IBM i creates its normal SQL journaling infrastructure.
7. `IBMI_REQUIRE_TRANSACTIONAL_SCHEMA=true` can reject unsafe/unknown schema selections before an application starts migrations or transactional work.

## Why existing libraries are not auto-journaled

The proxy intentionally does not create a journal receiver/journal or run `STRJRNLIB`/`STRJRNPF` automatically in an existing library. Those operations are persistent IBM i administration choices involving receiver placement, retention, ASPs, authority and HA/DR policy. A deployment can either use a dedicated SQL schema or have an IBM i administrator configure journaling on the existing library/files.

## Client schema selection

Examples:

```sql
SET search_path TO APPDATA;
SET SCHEMA 'APPDATA';
SELECT set_config('search_path', 'APPDATA', false);
SELECT current_schema();
SHOW search_path;
```

Startup option:

```text
options=-csearch_path=APPDATA
```

URL-encoded example:

```text
...?options=-csearch_path%3DAPPDATA
```

## New configuration

```env
IBMI_CURRENT_SCHEMA=APPDATA
IBMI_AUTO_CREATE_CURRENT_SCHEMA=false
IBMI_REQUIRE_TRANSACTIONAL_SCHEMA=false
```

For a dedicated application gateway, `IBMI_REQUIRE_TRANSACTIONAL_SCHEMA=true` is recommended after the schema/journal authority is validated.

## Verification

Build-time verifiers cover schema routing/introspection and schema journaling capability detection. Syntax-only TypeScript transpilation is also used when the complete dependency tree is not available in the packaging environment.

## Diagnosing SQL7008

An IBM i error such as `SQL7008 ... in MCPDATA` identifies the system library containing the failing file, but older proxy releases did not log the PostgreSQL SQL-schema name or where it was selected. 0.1.25 logs the configured/default schema, backend-confirmed `CURRENT SCHEMA`, schema-selection source, resolved IBM i system library, and journaling capability.

For an existing library that is not automatically journaled, use one of these deployment patterns:

- provision a dedicated application SQL schema with `CREATE SCHEMA` and route the client to it with PostgreSQL `search_path`; or
- have the IBM i administrator configure the existing library/files for journaling according to the site's journal receiver, retention, ASP, authority, HA and DR policy.

Do not work around SQL7008 by changing the proxy to JDBC auto-commit or isolation `none` if PostgreSQL `BEGIN`/`ROLLBACK` semantics are required.
