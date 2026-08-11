# Build/runtime fix 0.1.7 - pgAdmin connection contract

## User-visible symptom

pgAdmin displays `list index out of range` while connecting, while the proxy logs no Db2/Mapepire error.

## Direct cause

After the driver-level connection succeeds, pgAdmin REL-9_17 calls `get_replication_type()`. That helper executes `replication_type.sql` and immediately evaluates `res['rows'][0]['type']` without testing whether any row exists. Version 0.1.6 quarantined the PostgreSQL system query correctly, but its generic virtual fallback returned a **zero-row** result. pgAdmin then raised its own Python `IndexError`.

The upstream template always produces one row: `pgd` if BDR is installed, `log` if logical replication slots exist, otherwise `NULL`. The IBM i proxy therefore returns one row with one field, `type = NULL`.

The generic PostgreSQL-system quarantine is also cardinality-aware in 0.1.7: a scalar SELECT without a top-level FROM, or a non-window aggregate SELECT without GROUP BY/HAVING, receives one conservative synthetic row rather than an impossible zero-row result. `COUNT`-style fields use zero; unknown scalar values use PostgreSQL NULL.

## Protocol audit performed at the same time

A second correctness issue was found in the PostgreSQL Extended Query implementation. PostgreSQL requires portal Describe to return RowDescription for row-producing portals, while Execute must not emit RowDescription. The prior implementation returned NoData from Describe and then emitted RowDescription from Execute. This can break psycopg3 even when SQL compatibility is correct.

0.1.7 fixes the Describe/Execute sequence and the startup sequence. Startup now provides PostgreSQL ParameterStatus messages plus BackendKeyData and delays ReadyForQuery until the Mapepire session and custom protocol parser are ready.

## Build-time regression gates

The image build now executes three contracts against compiled JavaScript:

```text
node scripts/verify-pgadmin-compat.mjs
node scripts/verify-pgadmin-wire.mjs
node scripts/verify-startup-wire.mjs
```

The replication test uses the exact pgAdmin REL-9_17 SQL and verifies one DataRow with a PostgreSQL NULL value.
