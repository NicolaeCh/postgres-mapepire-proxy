# Build / Compatibility Fix 0.1.14 — pgAdmin table children and schema filtering

## Symptoms

After schemas and tables became visible, expanding **Columns**, **Indexes**, or partition-related child nodes could send PostgreSQL catalog SQL containing `<oid>::OID` to Db2 for i. Db2 then attempted to resolve `OID` as an SQL user-defined type and returned SQL0204.

## Changes

- `PGADMIN_HIDE_SYSTEM_SCHEMAS=true` hides `Q*`, `SYS*`, and `INFORMATION_SCHEMA` from pgAdmin schema lists by default.
- `IBMI_CURRENT_SCHEMA` explicitly controls the initial Db2 current schema and PostgreSQL `current_schema()` value. `DEFAULT_SCHEMA` is retained as a fallback.
- Columns are read live from `QSYS2.SYSCOLUMNS2` and rendered with the pgAdmin 9.17 node/property field names.
- SQL indexes are read live from `QSYS2.SYSINDEXES` and rendered as virtual PostgreSQL index nodes.
- PostgreSQL partition/inheritance nodes are returned as an exact empty contract because PostgreSQL `pg_inherits` has no direct representation in this compatibility layer.
- The Tables adapter registers deterministic virtual table OIDs process-wide so child requests can resolve the IBM i schema/table across pgAdmin connections.
- Build validation now runs `scripts/verify-pgadmin-table-child.mjs`.

## Recommended environment

```dotenv
IBMI_RDB_NAME=SEIDOR76
IBMI_CURRENT_SCHEMA=MONAI
PGADMIN_HIDE_SYSTEM_SCHEMAS=true
```

Set `PGADMIN_HIDE_SYSTEM_SCHEMAS=false` if IBM i system schemas are needed for administration.
