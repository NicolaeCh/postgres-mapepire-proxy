# Build / compatibility fix 0.1.34

Release 0.1.34 is based on the live ContextForge v1.0.7 and proxy 0.1.33 logs from 2026-08-14.

## What failed in 0.1.33

Three independent compatibility defects were visible:

1. ContextForge reached migration `cfc3d6aa0fb2` and the proxy failed the OAuth change while trying to realize PostgreSQL `ADD COLUMN APP_USER_EMAIL VARCHAR(255) NOT NULL`. The 0.1.33 backend strategy performed a nullable ADD followed by IBM i `ALTER COLUMN ... SET NOT NULL`; IBM i returned `SQL0952`, SQLSTATE `57014`, reason 10. The following command then correctly entered PostgreSQL failed-transaction state (`25P02`).
2. SQLAlchemy index reflection could receive an IBM i index header with a positive key count while `COLUMN_NAMES` was empty. 0.1.33 serialized this as an empty PostgreSQL `int2vector`, leading the client to call `int('')`.
3. SQLAlchemy's bulk table-comment query asks for `(relname, description)`. 0.1.33 classified the query as the generic one-column relation-name family, causing the later `not enough values to unpack (expected 2, got 1)` warnings. CHECK-constraint queries using `pg_get_constraintdef()` also overlapped the foreign-key classifier.

The repeated advisory-lock `false` responses are not the root cause shown by these logs. One session first acquired the lock successfully; the other sessions then observed normal contention while the migration owner was still running/failing.

## 0.1.34 DDL strategy

The proxy no longer uses `SET NOT NULL` for the empty-table PostgreSQL pattern. It also does not use a temporary IBM i default plus `DROP DEFAULT`.

The new sequence is:

1. Probe the target table and return SQLSTATE `23502` if rows exist.
2. Call `QSYS2.GENERATE_SQL` for the exact existing table, requesting `CREATE OR REPLACE` with constraints embedded and disabling comments, labels, triggers, grants, masks/permissions, and additional indexes in the generated source.
3. Read the generated source from `QTEMP.Q_GENSQL`.
4. Inject the new column before table constraints while preserving IBM i column/system names and table suffix attributes.
5. Execute the generated `CREATE OR REPLACE TABLE`. IBM i treats definition differences as changes to the existing table and its default replace behavior preserves all rows.

If the exact generated definition cannot be obtained or parsed, the proxy returns an error and makes no guessed table reconstruction.

### IBM i authority

For TABLE generation, the service profile must have `*EXECUTE` and `*OBJOPR` to the containing library and `*OBJOPR` to the table (`*FILE`). These are the authorities documented for `QSYS2.GENERATE_SQL`.

## Reflection fixes

- Table-comment reflection is classified before generic relation-name reflection and returns exactly two columns: `relname`, `description`.
- CHECK-constraint reflection is separated from foreign-key reflection and returns the positional shape SQLAlchemy expects.
- `fetchIbmiIndexes()` supplements unresolved SQL-index key names from `QSYS2.SYSTABLEINDEXSTAT`.
- If IBM i still reports an index with a positive key count but no key names, that incomplete row is omitted instead of producing an invalid empty `int2vector`.

## Advisory locks

No lock-semantics workaround is added in 0.1.34. PostgreSQL session advisory locks remain process-global across proxy sessions, re-entrant for the owner, explicitly releasable, and automatically removed when the owning proxy session closes. Fixing the migration failure allows the lock holder to finish and reach its normal unlock/connection-close path.

## Validation

The container build still compiles the full TypeScript project and executes the existing contract-verifier chain. 0.1.34 strengthens:

- `scripts/verify-postgres-alter-table.mjs`
- `scripts/verify-sqlalchemy-reflection.mjs`

The ALTER verifier rejects any regression containing `SET NOT NULL`, `WITH DEFAULT`, or `DROP DEFAULT` in the replacement strategy. The reflection verifier reproduces the empty-index-vector and table-comment failures seen in 0.1.33.
