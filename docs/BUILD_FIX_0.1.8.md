# Runtime compatibility fix 0.1.8 — pgAdmin database/schema browser

## Symptoms reproduced from the live pgAdmin 9.17 deployment

After the 0.1.7 connection contract succeeded, pgAdmin could connect but object-browser operations produced HTTP 500 errors or Db2 SQL errors. The reported failures included missing `chart_data`, `grantor`, and `description` keys, a DBMS scheduler scalar returned as NULL, `SQL0199 ... WHERE not expected`, the generic multi-statement rejection during schema creation, and Db2 rejecting PostgreSQL `CREATE SCHEMA ... AUTHORIZATION ...`.

## Root cause

The 0.1.7 virtual-system firewall correctly prevented many PostgreSQL internals from leaking to IBM i, but its generic projected-result fallback did not guarantee pgAdmin's exact row dictionaries. pgAdmin 9.17 directly indexes specific aliases in several browser handlers. A structurally incomplete synthetic result therefore causes a pgAdmin Python exception even if the PostgreSQL query itself completed successfully.

A separate translator defect inserted `FROM SYSIBM.SYSDUMMY1` after a top-level `WHERE` for some PostgreSQL SELECT-without-FROM statements, creating invalid Db2 syntax.

Finally, PostgreSQL and Db2 for i attach different semantics to `CREATE SCHEMA ... AUTHORIZATION ...`. With this project's service-user design, the PostgreSQL UI role cannot be forwarded as an IBM i authorization ID.

## 0.1.8 implementation

- exact `/*pga4dash*/` result contract: `chart_name`, `chart_data`;
- exact database ACL dictionary: `deftype`, `grantee`, `grantor`, `privileges`, `grantable`;
- DBMS scheduler extension probe returns scalar integer zero;
- role and tablespace browser rows include `description`;
- live schema enumeration/properties from `QSYS2.SYSSCHEMAS`;
- exact schema node shape: `oid,name,can_create,has_usage,description`;
- exact schema property shape: `nsptyp,name,oid,acl,namespaceowner,description,can_create,tblacl,seqacl,funcacl,typeacl,seclabels`;
- exact schema ACL and default-ACL dictionary shapes;
- stable proxy OIDs derived from IBM i SQL schema names;
- pgAdmin `CREATE SCHEMA <name> AUTHORIZATION <role>` maps to Db2 `CREATE SCHEMA <name>` under the Mapepire service profile;
- unsupported schema comments/ACL/default privileges/security labels are rejected before CREATE executes, avoiding partial-success DDL;
- SELECT-without-FROM source insertion now occurs before WHERE/GROUP/HAVING/ORDER/OFFSET/FETCH.

The PostgreSQL-visible schema owner is virtual and remains the proxy PostgreSQL login. The actual IBM i schema ownership/authority follows Db2 for i semantics for the configured Mapepire service profile.

## New build gates

The container build now runs two additional tests after TypeScript compilation:

```text
node scripts/verify-pgadmin-browser.mjs
node scripts/verify-pgadmin-schema.mjs
```

Together with the existing startup/wire tests, these make the live failures reported against 0.1.7 regression cases.
