# Runtime compatibility fix 0.1.6 - pgAdmin 9.17 virtual PostgreSQL system layer

## Trigger

pgAdmin connected to the PostgreSQL wire listener but startup queries leaked to IBM i, producing errors such as:

- `SQL0204 PG_STAT_GSSAPI in PG_CATALOG type *FILE not found`
- `SQL0104 ... Valid tokens: , FROM INTO`

## Root causes

1. PostgreSQL system introspection was being handled as ordinary SQL translation. `pg_catalog.pg_stat_gssapi` has no Db2 for i table equivalent.
2. PostgreSQL permits scalar `SELECT` statements without `FROM`; Db2 for i requires a row source for many equivalent expressions.
3. pgAdmin's connection is multi-stage. Surviving the authentication handshake is insufficient: pgAdmin runs initialization, database metadata, role capability and recovery-state SQL and can mark the server disconnected if those checks fail.

## Fix

- Added a virtual PostgreSQL system layer with exact responses for pgAdmin 9.17 initialization.
- Added `pg_stat_gssapi` support.
- Added the current six-column role/capability response including `can_signal_backend`.
- Added exact recovery-state handling.
- Added the current database-tree shape including `description`.
- Added a PostgreSQL-system firewall so unknown `pg_catalog.*`/`pg_*` constructs cannot reach Mapepire.
- Added generic empty virtualization for PostgreSQL monitoring relations without IBM i equivalents.
- Added `FROM SYSIBM.SYSDUMMY1` to translated scalar SELECTs without a top-level FROM.
- Set the default PostgreSQL compatibility version to `14.0`, the lowest version supported by pgAdmin 9.17.
- Added build-time pgAdmin contract verification.
