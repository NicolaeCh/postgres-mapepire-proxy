# Compatibility Fix 0.1.17 — pgAdmin Columns OID and IBM i Index Discovery

## Problem

pgAdmin returned HTTP 500 while expanding **Columns** with `KeyError: 'oid'`. The proxy log showed the request as `columnProperties` even though pgAdmin was executing its Columns nodes endpoint. pgAdmin 9.16+ references `att.attidentity` inside `nodes.sql` while calculating `has_default_val`, so `attidentity` cannot be used to distinguish properties from nodes.

Indexes reached the IBM i adapter but `QSYS2.SYSINDEXES` returned zero rows. IBM documents that this catalog represents SQL indexes created with `CREATE INDEX`. `QSYS2.SYSTABLEINDEXSTAT` is broader and identifies access paths by type, including SQL `INDEX`, DDS `LOGICAL`, `PRIMARY KEY`, `UNIQUE`, and `REFERENTIAL`.

## Fix

- Recognize the Columns nodes contract first using `att.attnum AS oid` / `has_default_val`.
- Return the exact pgAdmin node fields: `name`, `oid`, `datatype`, `displaytypname`, `not_null`, `has_default_val`, `description`, `seqtypid`.
- Keep wide-column markers such as `colconstype`, `is_view_only`, `attcompression`, `attndims`, and `atttypid` for the properties classifier.
- Query `QSYS2.SYSINDEXES` first for SQL indexes.
- If no SQL indexes are returned, query `QSYS2.SYSTABLEINDEXSTAT` directly for the selected table and expose `INDEX` and `LOGICAL` rows. Constraint-backed access paths are intentionally excluded because pgAdmin has separate constraint collections. If the broader service is unavailable, retain the empty SQL-index result without breaking pgAdmin.

## Expected logs

Expanding Columns should now log `kind=columnNodes`, not `kind=columnProperties`. Expanding Indexes should either return the SQL index count or log `Using IBM i table index statistics fallback for pgAdmin Indexes` before returning IBM i SQL/logical index objects.
