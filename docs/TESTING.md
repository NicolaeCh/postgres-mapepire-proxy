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
