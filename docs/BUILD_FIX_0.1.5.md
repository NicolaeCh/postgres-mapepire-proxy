# Build/runtime fix 0.1.5 - pgAdmin startup compatibility

Version 0.1.5 addresses PostgreSQL metadata probes issued by pgAdmin that must
not be forwarded to Db2 for i.

## Symptoms fixed

- `SQL0204 PG_DATABASE in PG_CATALOG type *FILE not found`
- `SQL0104 Token <END-OF-STATEMENT> was not valid. Valid tokens: , FROM INTO`

The first came from forwarding PostgreSQL `pg_catalog.pg_database` to IBM i.
The second came from forwarding legal PostgreSQL `SELECT <expression>` probes
without a FROM clause to Db2 for i.

## Changes

- Added `src/sql/pgadmin.ts` compatibility interception before SQL translation.
- Synthetic current-database and database-tree responses for `pg_database`.
- Synthetic current user/role and `pg_tablespace` probes.
- Handles `pg_catalog.set_config(...)`, `current_setting(...)`,
  `pg_is_in_recovery()`, `pg_is_wal_replay_paused()` and `pg_backend_pid()`.
- Handles pgAdmin's synthetic-only multi-statement initialization batch while
  keeping general `SQL_ALLOW_MULTI_STATEMENT=false`.
- Handles the `pg_user` recovery/replay-state check and locale setting probes.
- Added `SQL_LOG_FAILED_TEXT=false`. Set it to `true` temporarily to include the
  original failing SQL in warning logs when adding compatibility for a new
  client probe. Keep it disabled in normal production if SQL can contain
  sensitive literals.

The compatibility rows describe the proxy endpoint, not native PostgreSQL
storage. IBM i libraries/tables/columns continue to come from IBM i catalogs.
