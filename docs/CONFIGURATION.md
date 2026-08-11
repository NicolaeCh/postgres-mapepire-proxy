# Configuration Reference

All runtime configuration is supplied through `.env`. The repository includes `.env.example`; copy it to `.env`, replace secrets and site-specific values, and do not commit the populated file.

## PostgreSQL-facing listener

| Variable | Default/example | Purpose |
|---|---:|---|
| `PG_LISTEN_HOST` | `0.0.0.0` | Listener address. |
| `PG_LISTEN_PORT` | `5432` | PostgreSQL wire-protocol port. |
| `PG_SERVER_VERSION` | `14.0` | PostgreSQL compatibility version exposed in wire `ParameterStatus`. Keep this value numeric. The pgAdmin 9.17 compatibility profile is validated against PostgreSQL 14 semantics to minimize version-specific catalog probes. |
| `PG_PROTOCOL_TRACE` | `false` | Log PostgreSQL frontend message types (`Query`, `Parse`, `Bind`, `Describe`, `Execute`, `Sync`, etc.) plus application/database metadata. It does **not** log SQL text. Enable temporarily for protocol diagnostics. |
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

## IBM i / Mapepire service identity

Every IBM i connection uses the same service profile. PostgreSQL usernames are not forwarded to IBM i.

| Variable | Default/example | Purpose |
|---|---:|---|
| `IBMI_HOST` | required | IBM i host running Mapepire Server. |
| `MAPEPIRE_PORT` | `8076` | Secure WebSocket Mapepire port. |
| `IBMI_USER` | required | IBM i service profile used by all backend jobs. |
| `IBMI_PASSWORD` | required | Password for `IBMI_USER`. |
| `MAPEPIRE_REJECT_UNAUTHORIZED` | `true` | Verify Mapepire TLS certificate. |
| `MAPEPIRE_CA_FILE` | empty | Optional PEM CA for private PKI. |
| `DEFAULT_SCHEMA` | `QGPL`/site value | Db2 current schema applied on connect and on pool release. |

Use a dedicated IBM i profile with least privilege: access only to the schemas/tables/procedures required by the applications using the proxy. Do not use `QSECOFR` or another broad administrative profile.

## Mapepire session-affinity pool

| Variable | Default | Purpose |
|---|---:|---|
| `MAPEPIRE_POOL_STARTING_SIZE` | `4` | Jobs opened during startup. |
| `MAPEPIRE_POOL_MAX_SIZE` | `12` | Hard cap including in-flight job creations. |
| `MAPEPIRE_POOL_ACQUIRE_TIMEOUT_MS` | `30000` | Maximum wait for a leased SQLJob. |
| `MAPEPIRE_RECONNECT_RETRIES` | `0` | Optional retry count for known-safe idempotent reads outside transactions. |
| `MAPEPIRE_FETCH_SIZE` | `500` | Rows requested per Mapepire cursor page. |

One `SQLJob` is leased to one PostgreSQL session for that session's lifetime. It is never shared concurrently. On release the proxy issues defensive `ROLLBACK` and restores `DEFAULT_SCHEMA` before returning the job to the idle pool.

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
