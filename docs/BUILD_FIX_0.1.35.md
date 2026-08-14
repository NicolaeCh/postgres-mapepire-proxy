# Build fix 0.1.35

Release 0.1.35 fixes a regression-test-only failure introduced in 0.1.34.

`verify-postgres-alter-table.mjs` expected `CREATE OR REPLACE TABLE TOOLS (` with a literal space before the opening parenthesis, while the DDL registry emits the equally valid `CREATE OR REPLACE TABLE TOOLS(`. The assertion now accepts optional whitespace with `TOOLS\s*\(`.

There is no runtime SQL-generation change in this release. The 0.1.34 ContextForge DDL and SQLAlchemy reflection fixes are preserved unchanged.
