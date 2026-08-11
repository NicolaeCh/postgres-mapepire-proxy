# PostgreSQL Compatibility Matrix

## Protocol

| Feature | Status | Notes |
|---|---|---|
| StartupMessage | Supported | handled by pg-gateway |
| SSLRequest | Supported when configured | pg-gateway TLS |
| cleartext auth | Supported | proxy-local account |
| MD5 auth | Supported | proxy-local account; not IBM i |
| Simple Query | Supported | one statement by default |
| Parse/Bind/Execute/Sync | Baseline supported | Mapepire parameters; protocol error recovery waits for Sync |
| Named statements/portals | Supported in session memory | not persisted |
| Describe | Partial | ParameterDescription + NoData; definitive RowDescription is emitted with execution output |
| Text results | Supported | default |
| Binary results | Not supported | returns feature-not-supported; text-format BLOB/binary results map to `bytea` |
| Execute with maxRows | Partial | treated as a one-shot row cap; PortalSuspended/resume is not implemented |
| COPY protocol | Not supported | future work |
| LISTEN/NOTIFY | Not supported | no Db2 analogue |
| CancelRequest | Not implemented in v0.1 | No proxy-side cancellation of an already running Mapepire query |

## SQL

| Feature | Status |
|---|---|
| SELECT/INSERT/UPDATE/DELETE/MERGE | pass-through after translation |
| BEGIN/COMMIT/ROLLBACK | proxy-controlled on pinned Db2 job |
| SAVEPOINT / ROLLBACK TO SAVEPOINT | not supported in v0.1; rejected with `0A000` |
| `$1..$n` parameters | translated to `?`; NULL is forwarded; `bytea` bind values rejected in v0.1 |
| LIMIT/OFFSET numeric literals | translated |
| `value::type` simple casts | translated |
| quoted identifiers | preserved |
| SET search_path | first schema supported; mapped to Db2 CURRENT SCHEMA |
| SET statement_timeout / lock_timeout | accepted as compatibility no-op; not enforced by the proxy |
| other PostgreSQL SET options | rejected unless explicitly supported to prevent backend session-state leakage |
| unquoted identifiers | uppercased by default |
| RETURNING | not translated |
| ON CONFLICT | not translated |
| PostgreSQL arrays/json operators | not translated |
| sequences / SERIAL | not emulated |
| CREATE EXTENSION | not supported |

## Catalog

The compatibility layer is intended for discovery, not full PostgreSQL catalog equivalence. DBeaver and ORM versions can change their metadata SQL. Capture each unsupported query, add a deterministic compatibility rule and a regression test before claiming support for that client/version.

## Important OID detail

PostgreSQL OID 18 (`char`) is an internal one-byte PostgreSQL type. SQL `CHAR(n)`/Db2 `CHAR(n)` is exposed as PostgreSQL `bpchar` (OID 1042), which is the mapping expected by PostgreSQL clients.

## Timeout and cancellation semantics

`SET statement_timeout`, `SET lock_timeout` and `SET idle_in_transaction_session_timeout` are accepted so common clients can initialize, but v0.1 does **not** enforce a PostgreSQL statement deadline. `@ibm/mapepire-js` 0.6.1 exposes query paging and cursor close, but the proxy does not have a safe API for cancelling an already-running SQL request. `MAPEPIRE_JDBC_QUERY_TIMEOUT_MECHANISM` configures the underlying JDBC/Toolbox mechanism only; it is not presented as a PostgreSQL `CancelRequest` implementation.

## Protocol framing

After pg-gateway completes startup/TLS/authentication, the proxy detaches the authenticated socket. Its parser buffers incomplete frontend frames and processes multiple coalesced frames in order. `PG_MAX_FRONTEND_MESSAGE_BYTES` limits the size of a single frontend frame/buffer.
