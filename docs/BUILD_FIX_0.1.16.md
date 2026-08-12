# Compatibility Fix 0.1.16 — pgAdmin Columns, Indexes and Views

## Problem

pgAdmin did not show the Columns or Indexes collection below a table, even though release 0.1.14 had live IBM i node renderers. pgAdmin performs a child `count.sql` / `has_nodes()` request before creating those collection nodes. The count requests were not claimed by the IBM i child adapter.

The Views collection also had no dedicated IBM i catalog adapter, so SQL views created on IBM i were not represented in the pgAdmin tree.

## Fix

- Recognize concrete-parent-OID Columns count requests and return the number of rows fetched from `QSYS2.SYSCOLUMNS2`.
- Recognize concrete-parent-OID Indexes count requests and return the number of rows fetched from `QSYS2.SYSINDEXES`.
- Keep Columns/Indexes node and property requests live and scoped to the selected IBM i table.
- Discover IBM i SQL views with `QSYS2.SYSTABLES` and `TABLE_TYPE='V'`, joined to `QSYS2.SYSVIEWS` for the view definition.
- Assign stable virtual OIDs to views and register them process-wide so a later pgAdmin Columns request can map the OID back to the IBM i schema/view.
- Keep PostgreSQL-only trigger/rule/policy children safely virtualized without reintroducing the 0.1.14 Tables regression.

## Expected diagnostics

When expanding a table in pgAdmin, logs should include `pgAdmin IBM i column catalog request` with `kind=columnCount` followed by `kind=columnNodes`, and similarly `indexCount` / `indexNodes` for Indexes. Expanding Views should produce `pgAdmin IBM i view catalog request` with `kind=count` and `kind=nodes`.
