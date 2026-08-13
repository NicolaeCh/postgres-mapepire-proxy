# Build fix 0.1.24

ContextForge v1.0.7 reaches the end of its first Alembic revision after the 0.1.23 foreign-key fixes, then PostgreSQL emits an `INSERT INTO alembic_version ... RETURNING alembic_version.version_num` statement. Db2 for i rejects the PostgreSQL `RETURNING` keyword with SQL0199.

Version 0.1.24 maps DML RETURNING to Db2 data-change table references while preserving PostgreSQL result-row and command semantics:

- `INSERT ... RETURNING columns` -> `SELECT columns FROM FINAL TABLE (INSERT ...)`
- `UPDATE ... RETURNING columns` -> `SELECT columns FROM FINAL TABLE (UPDATE ...)`
- `DELETE ... RETURNING columns` -> `SELECT columns FROM OLD TABLE (DELETE ...)`

The build-time verifier `scripts/verify-contextforge-returning.mjs` checks the exact Alembic version-table form as well as identity/update/delete examples.

For psycopg extended-query execution, RETURNING portal/statement Describe is answered from the parsed RETURNING column list and the session translated-DDL type registry; the DML itself is executed only on Execute.
