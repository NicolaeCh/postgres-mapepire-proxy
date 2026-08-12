# Runtime compatibility fix 0.1.11 — pgAdmin table discovery

## Symptoms

- Normal SELECT/INSERT/DELETE and CREATE TABLE work through Mapepire.
- pgAdmin does not show existing IBM i tables under a schema.
- Container logs show Db2 SQL0199 with `Keyword EXISTS not expected` shortly after pgAdmin connects.

## Root causes

1. pgAdmin performs a pgAgent capability probe using PostgreSQL `has_table_privilege()` / `has_schema_privilege()` and nested `SELECT ... WHERE EXISTS`. It was not a table-catalog query and was incorrectly allowed into the generic pg_class/pg_namespace translation path.
2. The live IBM i table catalog used an incorrect/non-portable source-file filter. The documented QSYS2.SYSTABLES discriminator is `FILE_TYPE` (`D` data, `S` source).
3. pgAdmin can retain browser schema IDs across upgrades. Earlier proxy revisions used a row-number pg_namespace OID; current releases use a stable hash. A stale OID could resolve to no IBM i schema and therefore produce table count zero.

## Fixes

- Answer pgAgent capability locally as one PostgreSQL boolean row (`has_priviledge=false`).
- Treat unhandled PostgreSQL privilege functions as virtual metadata operations that cannot reach IBM i.
- Query tables with `TABLE_TYPE IN ('T','P') AND FILE_TYPE='D'`.
- Accept stable and legacy schema OIDs during table discovery.
- Add safe DEBUG catalog diagnostics: request kind, requested schema OID/name, resolved schema and table count.

## Expected live log

When pgAdmin expands MONAI -> Tables, a healthy request resembles:

```json
{"level":"debug","message":"pgAdmin IBM i table catalog request","kind":"count","requestedSchemaOid":123456,"resolvedSchema":"MONAI","tableCount":5}
{"level":"debug","message":"pgAdmin IBM i table catalog request","kind":"nodes","requestedSchemaOid":123456,"resolvedSchema":"MONAI","tableCount":5}
```

There should be no Db2 `Keyword EXISTS not expected` from the pgAgent capability check.
