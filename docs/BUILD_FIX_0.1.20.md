# Compatibility Fix 0.1.20 — ContextForge migration advisory lock

## Symptom

After 0.1.19 completed SQLAlchemy/psycopg initialization, every ContextForge worker logged `Lock held by another instance` indefinitely. No worker logged `Acquired Postgres advisory lock`.

## Root cause

ContextForge v1.0.7 executes `SELECT pg_try_advisory_lock(42424242424242)` and treats the scalar as a boolean. The proxy did not have a stateful handler for PostgreSQL advisory-lock functions. Its generic PostgreSQL-system firewall therefore returned a conservative virtual NULL scalar. Python interpreted that value as false, so all workers waited even though no lock was held.

## Fix

Release 0.1.20 implements PostgreSQL session advisory-lock semantics in the proxy:

- first session acquiring a key receives `true`;
- another session receives `false` while the key is held;
- acquisition by the owning session is re-entrant;
- `pg_advisory_unlock()` decrements/releases the owning session's hold;
- `pg_advisory_unlock_all()` releases all locks owned by that session;
- closing the PostgreSQL TCP session automatically releases its advisory locks.

The handler is integrated before the generic PostgreSQL-system firewall and has an explicit Extended Query Protocol description path, so SQLAlchemy/psycopg receives PostgreSQL boolean metadata and a one-row scalar result.

The registry is process-global to the proxy. This matches the project's current one-proxy-container architecture. If the proxy itself is horizontally replicated, a distributed advisory-lock backend would be required.
