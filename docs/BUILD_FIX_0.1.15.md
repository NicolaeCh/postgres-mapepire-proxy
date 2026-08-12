# Compatibility Fix 0.1.15 — pgAdmin Tables regression

## Symptom

After upgrading to 0.1.14, pgAdmin still displayed schemas and the **Tables** collection, but expanding **Tables** returned no table nodes.

## Root cause

The 0.1.14 table-child classifier runs before the parent Tables adapter. pgAdmin's normal table `nodes.sql` contains nested `pg_trigger` subqueries used only to calculate `triggercount` and `has_enable_triggers`. The child classifier matched the mere presence of `pg_trigger`, incorrectly classified the parent Tables request as an empty Triggers child collection, and returned zero rows.

## Fix

Trigger/Rule/Policy child classification now requires a concrete numeric parent table OID (`tgrelid=<oid>`, `ev_class=<oid>`, or `polrelid=<oid>`). Nested parent-table expressions such as `tgrelid=rel.oid` are ignored by the child classifier, allowing the existing Tables adapter to process the request against `QSYS2.SYSTABLES`.

A regression test covers the exact parent Tables query shape containing nested trigger-count subqueries.
