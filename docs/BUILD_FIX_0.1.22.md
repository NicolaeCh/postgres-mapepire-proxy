# Build fix 0.1.22

ContextForge v1.0.7 / SQLAlchemy emits `TIMESTAMP WITHOUT TIME ZONE` for `sa.DateTime()` columns. Db2 for i expects `TIMESTAMP` for this column type. Version 0.1.22 translates both `TIMESTAMP WITH TIME ZONE` and `TIMESTAMP WITHOUT TIME ZONE` to Db2 `TIMESTAMP`, and likewise maps both `TIME ... TIME ZONE` spellings to `TIME`.

The ContextForge DDL verifier now reproduces the exact `last_seen TIMESTAMP WITHOUT TIME ZONE` form from the first migration.
