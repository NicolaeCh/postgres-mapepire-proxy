# Compatibility fix 0.1.30 — PostgreSQL ALTER TABLE column rename

SQLAlchemy's PostgreSQL dialect may emit `ALTER TABLE tools RENAME is_active TO enabled`. PostgreSQL makes the `COLUMN` keyword optional; Db2 for i requires `RENAME COLUMN`. The proxy now normalizes the PostgreSQL column-rename form before sending it to Mapepire.

The failure previously aborted the migration transaction, which in turn caused Alembic version-table updates and `pg_advisory_unlock()` to receive PostgreSQL `25P02`. The proxy deliberately retains those failed-transaction semantics; avoiding the syntax error is the correct fix.

The build verifier also checks the immediately following ORM form `ALTER TABLE ... ADD COLUMN reachable BOOLEAN DEFAULT true NOT NULL`, which is translated to `DEFAULT TRUE`.
