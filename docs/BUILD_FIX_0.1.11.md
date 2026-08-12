# Build / Runtime Fix 0.1.11 — pgAdmin Tables schema resolution

## Symptom

pgAdmin connected and application SQL/DDL worked, but the Tables browser remained empty. The proxy logged `pgAdmin table catalog schema could not be resolved` with `requestedSchemaName=pg_catalog` while the session current schema was an IBM i schema such as `MONAI`.

## Root cause

pgAdmin 9.17 schema templates import `CATALOGS.LIST`. That macro embeds `nspname = 'pg_catalog'` and an `EXISTS (SELECT ... FROM pg_catalog.pg_class ...)` check. Because 0.1.10 ran the table classifier before the schema classifier and the table classifier accepted broad `pg_class` patterns, schema-browser SQL could be stolen by the table adapter.

pgAdmin PostgreSQL catalog statements can contain nested `pg_namespace` predicates and catalog-exclusion macros using names such as `pg_catalog`. The 0.1.10 table adapter extracted the first `nspname='...'` predicate and allowed it to participate in target-schema resolution. That textual predicate is metadata about PostgreSQL internals, not the schema selected in the browser.

The authoritative selector in pgAdmin's Tables count/nodes templates is `rel.relnamespace = <scid>::oid`.

## Fix

- pg_namespace-primary schema browser statements are explicitly excluded from the table classifier even if pgAdmin catalog macros reference pg_class;
- count/exists/nodes/properties ignore textual `nspname` predicates and use `relnamespace` OID only;
- generic table OID lookup requires a real pg_class primary alias (`rel`/`c`), preventing schema SQL from masquerading as table SQL;
- session resolution gives OID precedence for all table requests;
- schema properties prefer `nsp.oid=<scid>` over macro `nspname` predicates;
- PostgreSQL system schema names are never treated as IBM i target schema names;
- unresolved stale OIDs may fall back to CURRENT SCHEMA for pgAdmin count/nodes/properties only;
- count and nodes diagnostics are INFO level and show the resolved schema and IBM i table count.

## Expected log

When expanding `MONAI -> Tables`:

```json
{"level":"info","message":"pgAdmin IBM i table catalog request","kind":"count","requestedSchemaOid":123,"resolvedSchema":"MONAI","tableCount":5}
{"level":"info","message":"pgAdmin IBM i table catalog request","kind":"nodes","requestedSchemaOid":123,"resolvedSchema":"MONAI","tableCount":5}
```

`requestedSchemaName=pg_catalog` must no longer appear for these requests.
