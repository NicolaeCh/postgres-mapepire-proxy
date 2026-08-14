# Configuration Reference

All runtime configuration is supplied through `.env`. The repository includes `.env.example`; copy it to `.env`, replace secrets and site-specific values, and do not commit the populated file.

## PostgreSQL-facing listener

| Variable | Default/example | Purpose |
|---|---:|---|
| `PG_LISTEN_HOST` | `0.0.0.0` | Listener address. |
| `PG_LISTEN_PORT` | `5432` | PostgreSQL wire-protocol port. |
| `PG_SERVER_VERSION` | `14.0` | PostgreSQL compatibility version exposed in wire `ParameterStatus`. Keep this value numeric. The pgAdmin 9.17 compatibility profile is validated against PostgreSQL 14 semantics to minimize version-specific catalog probes. |
| `PG_PROTOCOL_TRACE` | `false` | Log PostgreSQL frontend message types (`Query`, `Parse`, `Bind`, `Describe`, `Execute`, `Sync`, etc.) plus application/database metadata. It does **not** log SQL text. Enable temporarily for protocol diagnostics. |
| `PGADMIN_SCHEMA_CACHE_MS` | `10000` | Per-session cache lifetime for live IBM i `QSYS2.SYSSCHEMAS` rows used by pgAdmin schema navigation. Invalidated after proxy-created schemas. |
| `PGADMIN_HIDE_SYSTEM_SCHEMAS` | `true` | Hide IBM i schemas/libraries beginning with `Q` or `SYS`, plus `INFORMATION_SCHEMA`, from pgAdmin schema navigation. Set `false` to show them. |
| `PG_MAX_CLIENTS` | `100` | Maximum simultaneous client sockets. |
| `PG_CLIENT_IDLE_TIMEOUT_MS` | `1800000` | Idle socket timeout. |
| `PG_MAX_FRONTEND_MESSAGE_BYTES` | `16777216` | Maximum buffered size of a single post-authentication PG frontend frame. |
| `PG_AUTH_MODE` | `md5Password` | `md5Password`, `cleartextPassword`, or `none`. |
| `PG_PROXY_USER` | `proxyuser` | Proxy-local PostgreSQL username; **not** an IBM i profile. |
| `PG_PROXY_PASSWORD` | secret | Proxy-local PostgreSQL password. |
| `PG_TLS_ENABLED` | `false` | Enable PostgreSQL-side TLS. |
| `PG_TLS_KEY_FILE` | `/app/certs/server-key.pem` | TLS private key when enabled. |
| `PG_TLS_CERT_FILE` | `/app/certs/server-cert.pem` | TLS certificate when enabled. |
| `PG_TLS_CA_FILE` | empty | Optional CA chain. |


### Database identity model

The proxy exposes exactly one PostgreSQL database. Its name is `IBMI_RDB_NAME`, which should match the IBM i *LOCAL RDB directory entry. PostgreSQL's hierarchy `database → schema → table` is mapped to IBM i as `RDB → SQL schema/library → table`. `IBMI_CURRENT_SCHEMA` does **not** name the PostgreSQL database; it sets the initial Db2 current schema/search path.

If a client requests another StartupMessage database name, the proxy returns PostgreSQL SQLSTATE `3D000` (`invalid_catalog_name`).

## IBM i / Mapepire service identity

Every IBM i connection uses the same service profile. PostgreSQL usernames are not forwarded to IBM i.

| Variable | Default/example | Purpose |
|---|---:|---|
| `IBMI_RDB_NAME` | required | Name of the IBM i *LOCAL relational database (`WRKRDBDIRE`). This is exposed as the single PostgreSQL database name and must be used as pgAdmin Maintenance database. It identifies the backend database to clients; Mapepire still connects through `IBMI_HOST`. |
| `IBMI_HOST` | required | IBM i host running Mapepire Server. |
| `MAPEPIRE_PORT` | `8076` | Secure WebSocket Mapepire port. |
| `IBMI_USER` | required | IBM i service profile used by all backend jobs. |
| `IBMI_PASSWORD` | required | Password for `IBMI_USER`. |
| `MAPEPIRE_REJECT_UNAUTHORIZED` | `true` | Verify Mapepire TLS certificate. |
| `MAPEPIRE_CA_FILE` | empty | Optional PEM CA for private PKI. |
| `IBMI_CURRENT_SCHEMA` | `MYLIB`/site value | Proxy-wide default application schema. It is mapped to Db2 `CURRENT SCHEMA`, PostgreSQL `search_path`, and `current_schema()`. |
| `IBMI_AUTO_CREATE_CURRENT_SCHEMA` | `false` | If a selected schema is missing, create it with SQL `CREATE SCHEMA`. On IBM i this creates the schema's SQL journal infrastructure. |
| `IBMI_REQUIRE_TRANSACTIONAL_SCHEMA` | `false` | Strict guard: refuse a selected schema unless the proxy can positively detect automatic journaling for newly-created tables. Recommended for application gateways that require PostgreSQL transaction semantics. |
| `DEFAULT_SCHEMA` | `QGPL` | Backward-compatible alias used only when `IBMI_CURRENT_SCHEMA` is not set. |

Use a dedicated IBM i profile with least privilege: access only to the schemas/tables/procedures required by the applications using the proxy. Do not use `QSECOFR` or another broad administrative profile.


### PostgreSQL `search_path` and per-application schema routing

The database name and schema name are separate. A connection to database `SEIDOR76` can use schema `APP1`, `APP2`, or another IBM i SQL schema/library. `IBMI_CURRENT_SCHEMA` is only the proxy-wide default.

A client can override the default using PostgreSQL-standard session settings:

```sql
SHOW search_path;
SELECT current_schema();
SET search_path TO APPDATA;
SET SCHEMA 'APPDATA';
SELECT set_config('search_path', 'APPDATA', false);
```

The proxy also accepts libpq/psycopg startup `options`. For example, an application URL can select its own IBM i schema without changing the proxy-wide default:

```text
postgresql+psycopg://proxyuser:password@proxy:5432/SEIDOR76?options=-csearch_path%3DAPPDATA
```

PostgreSQL supports a list of schemas in `search_path`; Db2 for i exposes one `CURRENT SCHEMA` register. The proxy therefore maps the first concrete application schema to Db2 `CURRENT SCHEMA` and logs additional path elements as ignored. `pg_catalog`, `pg_temp*`, and `$user` are virtual/special entries and are not sent to Db2.

At authentication the proxy logs both the PostgreSQL `database` and the effective/backend-confirmed schema. `/readyz` and `/stats` expose the configured database/default schema and the default schema journaling capability.

### IBM i journaling and PostgreSQL transactions

The proxy keeps Mapepire JDBC auto-commit disabled and uses a transactional isolation level so PostgreSQL `BEGIN`, `COMMIT`, `ROLLBACK`, and savepoints have real backend semantics. On IBM i, data changes under commitment control require the affected physical files to be journaled.

For application-owned schemas, the preferred deployment is an IBM i SQL schema created with `CREATE SCHEMA`. IBM i creates `QSQJRN` and `QSQJRN0001` in such a schema and subsequently created SQL tables are automatically journaled. Existing traditional libraries can instead use library journaling (`STRJRNLIB`) or explicit file journaling (`STRJRNPF`) according to the site's journal/receiver policy.

The proxy deliberately does **not** create journals or start journaling in an existing library automatically. Journal receiver placement, retention, ASP selection, authority, and operational policy are persistent IBM i administration decisions. Use `IBMI_AUTO_CREATE_CURRENT_SCHEMA=true` only to provision a **missing** SQL schema; use `IBMI_REQUIRE_TRANSACTIONAL_SCHEMA=true` to fail fast when the selected schema is not transaction-ready.

## Mapepire session-affinity pool

| Variable | Default | Purpose |
|---|---:|---|
| `MAPEPIRE_POOL_STARTING_SIZE` | `4` | Jobs opened during startup. |
| `MAPEPIRE_POOL_MAX_SIZE` | `12` | Hard cap including in-flight job creations. |
| `MAPEPIRE_POOL_ACQUIRE_TIMEOUT_MS` | `30000` | Maximum wait for a leased SQLJob. |
| `MAPEPIRE_RECONNECT_RETRIES` | `0` | Optional retry count for known-safe idempotent reads outside transactions. |
| `MAPEPIRE_FETCH_SIZE` | `500` | Rows requested per Mapepire cursor page. |

One `SQLJob` is leased to one PostgreSQL session for that session's lifetime. It is never shared concurrently. On release the proxy issues defensive `ROLLBACK` and restores `IBMI_CURRENT_SCHEMA` before returning the job to the idle pool.

## Mapepire JDBC / Toolbox properties

| Variable | Default | Purpose |
|---|---:|---|
| `MAPEPIRE_JDBC_NAMING` | `sql` | SQL/system naming. |
| `MAPEPIRE_JDBC_LIBRARIES` | empty | Optional comma-separated IBM i library list passed to Toolbox/Mapepire. |
| `MAPEPIRE_JDBC_DATE_FORMAT` | `iso` | Db2/JDBC date format; ISO is used for PostgreSQL compatibility. |
| `MAPEPIRE_JDBC_TIME_FORMAT` | `iso` | Db2/JDBC time format; ISO is used for PostgreSQL compatibility. |
| `MAPEPIRE_JDBC_DECIMAL_SEPARATOR` | `.` | Decimal separator used by JDBC. |
| `MAPEPIRE_JDBC_AUTO_COMMIT` | `false` | Must remain `false` for proxy-controlled transaction semantics. |
| `MAPEPIRE_JDBC_TRANSACTION_ISOLATION` | `read committed` | Backend isolation level. |
| `MAPEPIRE_JDBC_CONCURRENT_ACCESS_RESOLUTION` | `1` | IBM Toolbox concurrent-access policy: `1` = use currently committed, `2` = wait for outcome, `3` = skip locks. `1` better matches PostgreSQL read-only `READ COMMITTED` probes while a writer has uncommitted updates/deletes. |
| `MAPEPIRE_JDBC_BLOCK_SIZE` | `128` | Toolbox block size supported by Mapepire. |
| `MAPEPIRE_JDBC_DATA_COMPRESSION` | `true` | Enable data compression. |
| `MAPEPIRE_JDBC_PREFETCH` | `true` | Enable Toolbox prefetch. |
| `MAPEPIRE_JDBC_EXTENDED_METADATA` | `true` | Request metadata required for PG RowDescription/type mapping. |
| `MAPEPIRE_JDBC_KEEP_ALIVE` | `true` | Keep backend connection alive. |
| `MAPEPIRE_JDBC_QUERY_TIMEOUT_MECHANISM` | `cancel` | Toolbox timeout mechanism property. This is not PostgreSQL `CancelRequest`. |
| `MAPEPIRE_JDBC_QUERY_STORAGE_LIMIT` | empty | Optional backend query storage limit. |

## SQL compatibility

| Variable | Default | Purpose |
|---|---:|---|
| `SQL_UPPERCASE_UNQUOTED_IDENTIFIERS` | `true` | Normalize unquoted identifiers for Db2 for i. |
| `SQL_ENABLE_INFORMATION_SCHEMA_REWRITE` | `true` | Enable ANSI catalog rewrites to IBM i catalog views. |
| `SQL_ENABLE_PG_CATALOG_COMPAT` | `true` | Enable synthetic/translated PostgreSQL catalog compatibility. |
| `SQL_ALLOW_MULTI_STATEMENT` | `false` | Allow multiple SQL statements in one Simple Query. Keep disabled unless specifically tested. |
| `SQL_MAX_ROWS` | `0` | Global row cap; `0` means unlimited. |
| `SQL_DDL_DEFAULT_VARCHAR_LENGTH` | `1024` | Db2 length used for PostgreSQL/SQLAlchemy lengthless `VARCHAR` DDL. |
| `SQL_UNSUPPORTED_NONUNIQUE_LOB_INDEX_POLICY` | `skip` | `skip` acknowledges non-unique indexes that Db2 for i cannot create on LOB/XML/DATALINK keys and logs the missing physical access path; `error` enforces strict behavior. UNIQUE indexes are never skipped. |
| `SQL_LOG_TEXT` | `false` | Log original/translated SQL. Enable cautiously because SQL can contain sensitive data. |
| `SQL_LOG_FAILED_TEXT` | `false` | Include original SQL in backend-failure warning logs. Diagnostic use only; SQL literals may be sensitive. |

## Health and lifecycle

| Variable | Default | Purpose |
|---|---:|---|
| `HEALTH_LISTEN_HOST` | `0.0.0.0` | HTTP health listener. |
| `HEALTH_LISTEN_PORT` | `8080` | `/healthz`, `/readyz`, `/stats`. |
| `LOG_LEVEL` | `info` | Logging level. |
| `SHUTDOWN_GRACE_MS` | `15000` | Maximum graceful shutdown period before forced exit. |

## Secret handling

`.env` is convenient for Podman/Docker deployments, but protect it as a secret-bearing file (`chmod 600 .env`). The sample `.env` contains placeholders only. If your orchestrator injects environment variables from a secret store, use the same variable names and omit the local secret file from the runtime host.

### Failed-query diagnostics

`SQL_LOG_FAILED_TEXT=false` controls whether the original SQL text is included in warning logs when a backend command fails. Enable it temporarily when diagnosing a new PostgreSQL-client compatibility query. Leave it disabled in normal production environments if SQL literals may contain sensitive data.

### PostgreSQL protocol diagnostics

`PG_PROTOCOL_TRACE=true` logs only frontend protocol message **types** and client metadata, not SQL text. It is useful when a client-side error occurs without a backend SQL warning. `SQL_LOG_FAILED_TEXT=true` is a separate, more sensitive diagnostic option that adds failed SQL text to warning logs and should normally remain disabled.
