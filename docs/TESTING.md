# Test and Acceptance Plan

## Unit tests

After `npm install`:

```bash
npm run typecheck
npm test
npm run lint
```

Unit tests cover SQL translation and PostgreSQL frame serialization. Add regression cases for every catalog query discovered from DBeaver/ORMs.

## Integration acceptance on IBM i

1. Start Mapepire and verify WSS access.
2. Start proxy and confirm `/readyz` HTTP 200.
3. `values current user` returns the configured service profile.
4. Query a table containing CHAR/VARCHAR, integer, decimal, date, timestamp and BLOB columns.
5. Execute a parameterized query from a PostgreSQL driver.
6. Validate INSERT/UPDATE/DELETE row counts.
7. Validate BEGIN/ROLLBACK and BEGIN/COMMIT.
8. Force a syntax error inside a transaction; verify subsequent command receives `25P02` until rollback.
9. Stop/restart Mapepire; verify readiness changes. With the default `MAPEPIRE_RECONNECT_RETRIES=0`, the affected statement must fail rather than replay.
10. In a dedicated test environment, set `MAPEPIRE_RECONNECT_RETRIES=1` and verify only a known-safe read outside a transaction is retried after a transport failure.
11. Confirm a write is never replayed automatically after a transport error.
12. Verify `SAVEPOINT x` and `ROLLBACK TO SAVEPOINT x` return `0A000` rather than rolling back the entire transaction silently.

## Architecture acceptance

Build natively on both:

```bash
podman build -f Containerfile -t proxy-test .
podman run --rm proxy-test node -p 'process.arch'
```

Expected output is `x64` on AMD64 and `ppc64` on IBM Power Linux.

## DBeaver/ORM qualification

Do not label a client as supported only because TCP login works. Qualification requires:

- connection succeeds;
- schema list works;
- table/view list works;
- column metadata works;
- SELECT editor works;
- prepared parameter query works;
- transaction commit/rollback works;
- errors are displayed correctly.

Keep a captured list of metadata SQL for the exact tested client version.

## Paging test

Set `MAPEPIRE_FETCH_SIZE=25`, query more than 100 rows, and verify that all rows are returned and that `/stats` shows the session job remains leased for the connection. This exercises Mapepire `fetchMore` paging.


## Client timeout compatibility test

Run a driver that issues `SET statement_timeout`. The proxy should return `SET` so startup continues. Do **not** interpret this as an enforced server deadline; cancellation/CancelRequest is a future compatibility item.


## pgAdmin startup qualification (0.1.5+)

1. Register the proxy as a server in pgAdmin using the proxy-local PostgreSQL
   username/password and the configured maintenance database name.
2. Confirm the server opens without a Db2 error referencing `PG_CATALOG`.
3. Confirm the logs do not show `SQL0204 ... PG_DATABASE ...` or the no-FROM
   `SQL0104 ... Valid tokens: , FROM INTO` during connection initialization.
4. Expand the server/database node. Treat later object-browser failures as
   separate catalog-compatibility gaps; capture the exact SQL with
   `SQL_LOG_FAILED_TEXT=true` only for diagnosis.
5. Return `SQL_LOG_FAILED_TEXT=false` after diagnosis because failed SQL may
   contain literals or application data.

For a real container-process exit rather than a client-session disconnect,
capture the exit status and OOM flag in addition to logs:

```bash
podman inspect postgres-mapepire-proxy_postgres-mapepire-proxy_1 \
  --format '{{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{.State.Error}}'
podman logs --tail 200 postgres-mapepire-proxy_postgres-mapepire-proxy_1
```

## pgAdmin 9.17 compiled-contract test (0.1.8)

Every container build executes five pgAdmin/protocol tests after TypeScript compilation:

```text
node scripts/verify-pgadmin-compat.mjs
node scripts/verify-pgadmin-wire.mjs
node scripts/verify-startup-wire.mjs
node scripts/verify-pgadmin-browser.mjs
node scripts/verify-pgadmin-schema.mjs
```

They check the exact pgAdmin 9.17 initialization batch elements, database metadata, `pg_stat_gssapi`, current-role capabilities, recovery-state query, the exact replication-type query with its mandatory single `type=NULL` row, database-tree shape, scalar SELECT translation through `SYSIBM.SYSDUMMY1`, PostgreSQL-system quarantine, psycopg3 portal Describe/Execute framing, and startup `ParameterStatus`/`BackendKeyData`/`ReadyForQuery` ordering.

## pgAdmin 9.17 browser/schema qualification (0.1.8)

A container build must additionally print:

```text
pgAdmin browser contract check OK
pgAdmin IBM i schema contract check OK
```

On a live IBM i endpoint, register the server and verify: the Dashboard no longer returns `chart_data` HTTP 500 errors; Roles/Tablespaces do not fail on missing `description`; the Database SQL tab does not fail on a missing ACL `grantor`; expand Schemas and verify the expected IBM i SQL schemas from `QSYS2.SYSSCHEMAS`; select the SQL/Properties tabs for an application schema; create a test schema with only Name/Owner set and leave Comment/Privileges/Default privileges/Security labels empty; refresh and verify the new schema appears; remove the test schema with an IBM i-native administration tool until DROP SCHEMA support is qualified in the proxy.
