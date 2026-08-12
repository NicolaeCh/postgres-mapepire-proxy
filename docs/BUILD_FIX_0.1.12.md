# Build / Compatibility Fix 0.1.12

## Scope

Release 0.1.12 fixes the pgAdmin 9.17 **Schemas** collection and formalizes the PostgreSQL database ↔ IBM i RDB identity.

## Root cause of the empty Schemas tree

pgAdmin's schema `nodes.sql` starts with `SELECT nsp.oid, ...` and imports a catalog-exclusion macro containing `nspname='pg_catalog'`. The former classifier tested the narrow `oidByName` shape before the full nodes shape, so the multi-column schema-list query was classified as `{kind: 'oidByName', name: 'pg_catalog'}` and returned zero rows without any SQL error. pgAdmin therefore rendered an empty Schemas collection.

0.1.12 recognizes schema browser SQL only when `pg_namespace` is the primary FROM relation, prioritizes count/nodes/properties before simple OID/name lookups, and makes OID/name lookups require the simple `SELECT oid FROM pg_namespace ...` / `SELECT nspname FROM pg_namespace ...` shape. Schema handling now runs before table handling.

INFO-level diagnostics are emitted for schema `count`, `nodes`, and `properties`, including the number of live rows read from `QSYS2.SYSSCHEMAS` and the rows returned to pgAdmin.

## Database identity

`IBMI_RDB_NAME` is now required. Set it to the *LOCAL RDB name shown by `WRKRDBDIRE`. The proxy exposes this as its single PostgreSQL database and rejects other StartupMessage database names with SQLSTATE `3D000`.

For pgAdmin, set **Maintenance database** to `IBMI_RDB_NAME`. Keep the IBM i SQL schema/library separate in `DEFAULT_SCHEMA`. Example:

```dotenv
IBMI_RDB_NAME=POWER11A
DEFAULT_SCHEMA=MONAI
```

pgAdmin Maintenance database: `POWER11A`.

## Expected diagnostics

On pgAdmin database expansion and Schemas expansion:

```text
pgAdmin IBM i schema catalog request kind=count ... returnedRows=1
pgAdmin IBM i schema catalog request kind=nodes ... returnedRows=N returnedSchemaNames=[...,MONAI,...]
```

If `ibmiCatalogRows` is zero, check the Mapepire service profile's authorization to the relevant schemas / `QIBM_LIST_ALL_OBJS_SQL`.
