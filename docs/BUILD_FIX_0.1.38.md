# Generic backend pooling and ALTER TYPE correction — 0.1.38

## Root cause

The pre-0.1.38 proxy treated every PostgreSQL TCP session as if it required a permanently dedicated Mapepire SQLJob. That preserved backend affinity, but also made `MAPEPIRE_POOL_MAX_SIZE` an accidental hard ceiling on total connected PostgreSQL clients. Multi-process application servers can open many mostly-idle connections during startup; those sessions exhausted the Mapepire pool even when only one process owned the migration/advisory lock.

This is a resource-model problem, not an MCP-specific lock problem. Increasing the SQLJob pool merely moves the ceiling and increases IBM i job consumption.

## Generic solution

The default backend lease mode is now `transaction`:

1. PostgreSQL authentication creates a logical proxy session only.
2. Proxy-local operations need no Mapepire SQLJob.
3. Autocommit Db2 work checks out a job, replays supported backend state, executes/commits, and returns it.
4. `BEGIN` remains logical until Db2 work begins. The first Db2 operation pins one job through COMMIT/ROLLBACK, preserving transactional affinity.
5. Job return performs defensive rollback and default-schema reset.
6. `MAPEPIRE_BACKEND_LEASE_MODE=session` preserves the older lifetime-affinity model when a workload requires physical backend-session state.

This design makes frontend connection capacity (`PG_MAX_CLIENTS`) independent from concurrent IBM i capacity (`MAPEPIRE_POOL_MAX_SIZE`) while preserving the explicit transaction boundary.

## Session-affine features

Only session state explicitly virtualized by the proxy can safely survive backend switching. `search_path`, prepared statement/portal bookkeeping, and PostgreSQL advisory locks are proxy-owned today. Future support for physical-backend temporary objects, holdable cursors, or other backend-session-local features must either escalate the logical session to a pinned backend or require `session` lease mode.

## DDL correction

PostgreSQL `ALTER TABLE t ALTER COLUMN c TYPE x` is not valid Db2 for i syntax. 0.1.38 translates the compatible form to `ALTER TABLE t ALTER COLUMN c SET DATA TYPE x`. PostgreSQL `USING` and `COLLATE` clauses are rejected with `0A000` until a semantics-preserving translator exists.

## Operational validation

During a connection burst, `/stats` should show `postgres.connectedClients` much larger than `mapepire.leased` when clients are idle. Advisory-lock polling should not increase `leased`. An explicit transaction should increase `leased` while Db2 work is active/pinned and return the job after COMMIT/ROLLBACK.
