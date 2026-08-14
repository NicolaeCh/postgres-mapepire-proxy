# Build/runtime fix 0.1.37

0.1.37 hardens the ContextForge migration path against two live IBM i object-state failures.

- `QSYS2.GENERATE_SQL` uses only `CONSTRAINT_OPTION => '2'` and `CREATE_OR_REPLACE_OPTION => '1'`, avoiding optional named parameters that vary by IBM i release/PTF level.
- The proxy retries `SQL0443 ... FILE NOT FOUND YET` and a mismatched generated-system-name `SQL0204` during ALTER/replace operations.
- SQLAlchemy column/index/FK/key reflection uses the same bounded retry.
- Genuine missing target objects and unrelated SQL errors still fail immediately.

The container build includes `verify-ibmi-object-stabilization.mjs` and the strengthened `verify-postgres-alter-table.mjs`.
