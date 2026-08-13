# Deployment Runbook

This is intentionally separate from the technical specification.

## pgAdmin 9.17 compatibility setting

For release 0.1.12, set the following explicitly in `.env`:

```dotenv
PG_SERVER_VERSION=14.0
```

Do not carry forward a decorated value such as `16.4 (...)` from an older `.env`. pgAdmin branches its startup/catalog behavior based on the PostgreSQL server version advertised in protocol `ParameterStatus`; the 0.1.12 compatibility contract is validated with the numeric `14.0` profile.

For protocol-level diagnostics, temporarily set `PG_PROTOCOL_TRACE=true`. This logs frontend message types and connection metadata but not SQL text. If pgAdmin encounters a Db2/SQL compatibility failure, `SQL_LOG_FAILED_TEXT=true` can additionally log the failed SQL; restore it to `false` immediately after diagnosis because SQL literals may contain sensitive data.

For pgAdmin schema navigation also keep:

```dotenv
PGADMIN_SCHEMA_CACHE_MS=10000
```

Basic pgAdmin schema creation is supported only with Comment/Privileges/Default privileges/Security labels left empty. The backend schema is created by `IBMI_USER`; the PostgreSQL owner displayed by pgAdmin is virtual.

## 1. Prerequisites

### IBM i

1. Mapepire server installed and running.
2. TCP/WSS path from the proxy host to Mapepire (default port 8076).
3. A dedicated IBM i service profile, for example `PGPROXY`.
4. The service profile must have only the Db2 object authorities required by applications using the proxy.
5. If Mapepire uses a private/self-signed CA, export the CA certificate to the proxy host and set `MAPEPIRE_CA_FILE`.

### Mapepire Server verification / hardening

The official Mapepire administration guide recommends the RPM installation (`yum install mapepire-server`) and Service Commander where available. Typical checks are:

```bash
sc start mapepire
sc check mapepire
```

Mapepire uses port **8076** by default. If the daemon is configured on another port, set the same value in proxy `.env` as `MAPEPIRE_PORT`; do not hard-code it in the image. Configure TLS on the daemon and keep `MAPEPIRE_REJECT_UNAUTHORIZED=true` in production.

For additional server-side containment, Mapepire supports `/QOpenSys/etc/mapepire/iprules.conf`. Because this proxy always connects with one IBM i service profile, a deny-by-default rule can permit only that profile and the proxy host/network, for example (adapt address and uppercase/lowercase conventions to the site):

```text
deny *@*
allow pgproxy@10.20.30.*
```

This is defense in depth; IBM i object authority on `IBMI_USER` remains mandatory.

### Container host

- Podman or Docker.
- Network access to IBM i Mapepire.
- Ports 5432 and optionally 8080 available.
- Architecture: `amd64` or `ppc64le`.

## 2. Configure `.env`

Do not bake credentials into the image.

Minimum required values:

```dotenv
IBMI_RDB_NAME=MYRDB
IBMI_HOST=10.0.0.50
MAPEPIRE_PORT=8076
IBMI_USER=PGPROXY
IBMI_PASSWORD=<service-profile-password>
IBMI_CURRENT_SCHEMA=APPDATA
PGADMIN_HIDE_SYSTEM_SCHEMAS=true

PG_AUTH_MODE=md5Password
PG_PROXY_USER=proxyuser
PG_PROXY_PASSWORD=<client-proxy-password>
```

Recommended Mapepire pool baseline for a moderate workload:

```dotenv
MAPEPIRE_POOL_STARTING_SIZE=4
MAPEPIRE_POOL_MAX_SIZE=12
MAPEPIRE_POOL_ACQUIRE_TIMEOUT_MS=30000
MAPEPIRE_FETCH_SIZE=500
# Keep automatic transport replay disabled unless SELECT workloads are known safe to retry.
MAPEPIRE_RECONNECT_RETRIES=0
MAPEPIRE_JDBC_NAMING=sql
MAPEPIRE_JDBC_LIBRARIES=
MAPEPIRE_JDBC_DATE_FORMAT=iso
MAPEPIRE_JDBC_TIME_FORMAT=iso
MAPEPIRE_JDBC_DECIMAL_SEPARATOR=.
MAPEPIRE_JDBC_AUTO_COMMIT=false
MAPEPIRE_JDBC_BLOCK_SIZE=128
MAPEPIRE_JDBC_DATA_COMPRESSION=true
MAPEPIRE_JDBC_PREFETCH=true
MAPEPIRE_JDBC_EXTENDED_METADATA=true
MAPEPIRE_JDBC_KEEP_ALIVE=true
```

Tune pool maximum against IBM i workload capacity and expected concurrent PostgreSQL sessions. One active PostgreSQL session can hold one backend SQLJob.

## 3. TLS to Mapepire

Preferred:

```dotenv
MAPEPIRE_REJECT_UNAUTHORIZED=true
MAPEPIRE_CA_FILE=/app/certs/mapepire-ca.pem
```

Only in isolated test environments should certificate verification be disabled:

```dotenv
MAPEPIRE_REJECT_UNAUTHORIZED=false
```

## 4. Optional PostgreSQL-side TLS

Set:

```dotenv
PG_TLS_ENABLED=true
PG_TLS_KEY_FILE=/app/certs/server-key.pem
PG_TLS_CERT_FILE=/app/certs/server-cert.pem
PG_TLS_CA_FILE=/app/certs/ca.pem
```

The compose definition mounts `./certs` read-only at `/app/certs`.

## 5. Build locally

### Podman on the native target architecture

```bash
podman pull node:24-bookworm-slim
podman build -f Containerfile -t postgres-mapepire-proxy:0.1.18 .
```

### Docker

```bash
docker pull node:24-bookworm-slim
docker build -t postgres-mapepire-proxy:0.1.18 .
```

The `Dockerfile` accepts `--build-arg NODE_IMAGE=...` if an exact tested tag/digest must be pinned. Keep the image on Node 24 LTS and verify that the chosen manifest contains both `linux/amd64` and `linux/ppc64le`.

Before TypeScript compilation, a successful 0.1.17 build must print all four runtime dependency checks:

```text
Mapepire runtime module check OK
node-sql-parser runtime module check OK
dotenv/config runtime module check OK
pg-gateway runtime module check OK
```

If any of these checks fails, do not deploy the image; the installed dependency entry point is incompatible with the proxy runtime.

After TypeScript compilation the build must also print:

```text
pgAdmin 9.17 compatibility contract check OK
pgAdmin psycopg3 Extended Query wire contract check OK
PostgreSQL startup handshake contract check OK
pgAdmin browser contract check OK
pgAdmin IBM i schema contract check OK
```

These tests guard both the connection sequence and the post-connect database/schema browser contracts, including the mandatory one-row replication-type result, protocol Describe/Execute ordering, dashboard/ACL field shapes, and IBM i-backed schema navigation.

## 6. Run

### Podman

```bash
podman run -d \
  --name postgres-mapepire-proxy \
  --env-file .env \
  -p 5432:5432 \
  -p 8080:8080 \
  -v ./certs:/app/certs:ro,Z \
  --restart=unless-stopped \
  postgres-mapepire-proxy:0.1.18
```

### Compose

```bash
podman compose up -d
# or
docker compose up -d
```

## 7. Multi-architecture publish

### Docker buildx

```bash
IMAGE=registry.example.com/db/postgres-mapepire-proxy:0.1.18 \
  ./scripts/build-multiarch-docker.sh
```

The script builds `linux/amd64,linux/ppc64le` and pushes a manifest list.

### Podman manifest

On builders capable of producing both target architectures:

```bash
./scripts/build-multiarch-podman.sh
podman manifest push --all postgres-mapepire-proxy:0.1.18 \
  docker://registry.example.com/db/postgres-mapepire-proxy:0.1.18
```

For production PPC64LE it is often preferable to build the PPC64LE image natively on IBM Power rather than through QEMU emulation.

## 8. Validate deployment

Readiness:

```bash
curl -f http://127.0.0.1:8080/readyz
curl http://127.0.0.1:8080/stats
```

Expected `/readyz` state is HTTP 200 with at least one Mapepire job.

PostgreSQL connectivity:

```bash
export PGPASSWORD='<PG_PROXY_PASSWORD>'
psql -h 127.0.0.1 -p 5432 -U proxyuser -d ibmi -c 'values current user'
psql -h 127.0.0.1 -p 5432 -U proxyuser -d ibmi -c 'values current schema'
```

`CURRENT USER` should return the **IBM i service profile**, confirming the intended security model.

Transaction test:

```sql
BEGIN;
UPDATE APPDATA.TEST SET VALUE='A' WHERE ID=1;
ROLLBACK;
SELECT VALUE FROM APPDATA.TEST WHERE ID=1;
```

## 9. DBeaver

Create a PostgreSQL connection:

- Host: proxy host
- Port: 5432
- Maintenance database / Database: the value of `IBMI_RDB_NAME` (the IBM i *LOCAL RDB name from `WRKRDBDIRE`)
- IBM i default SQL schema/library: configured separately as `IBMI_CURRENT_SCHEMA`; do not put the library name in pgAdmin's Maintenance database field
- User: `PG_PROXY_USER`
- Password: `PG_PROXY_PASSWORD`

Disable advanced PostgreSQL features that require server extensions until validated. Metadata compatibility is deliberately incremental; record unsupported catalog SQL and add a handler/test before enabling it broadly.

## 10. Upgrade/rollback

1. Build/pull a versioned image, never overwrite the only known-good tag.
2. Save the current `.env` outside the image.
3. Start the new image and wait for `/readyz`.
4. Run protocol + transaction smoke tests.
5. Roll back by restarting the previous image with the same `.env`.

Schema changes on IBM i are not performed by deployment scripts.

## 11. Operational sizing

- `PG_MAX_CLIENTS` can exceed Mapepire pool max, but excess sessions wait for a backend lease at authentication time.
- For interactive DBeaver usage, consider pool max close to expected concurrent connected users because each client holds a backend job.
- `MAPEPIRE_FETCH_SIZE` controls Mapepire cursor page size; 300–1000 is a practical starting range and 500 is the supplied baseline.
- For application servers, use the application's PostgreSQL connection pool conservatively; a large client-side pool directly consumes Mapepire/Db2 jobs.
- Monitor `/stats` for persistent `waiters > 0` before increasing the pool. The `creating` counter shows jobs whose WebSocket/Db2 connection is still being established; these in-flight jobs count against `MAPEPIRE_POOL_MAX_SIZE`.

## 12. Stop

```bash
podman stop postgres-mapepire-proxy
```

SIGTERM triggers graceful socket shutdown, session rollback/release and Mapepire job closure. `SHUTDOWN_GRACE_MS` is the maximum graceful-shutdown interval before the process forces a non-zero exit.


## 13. Known operational limitations in v0.1

- PostgreSQL `CancelRequest` is not implemented.
- `SET statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout` are compatibility no-ops and do not interrupt an executing IBM i statement. Use IBM i/Db2 controls such as Query Supervisor where hard execution governance is required.
- Savepoints are rejected with `0A000`; use top-level `BEGIN`/`COMMIT`/`ROLLBACK`.
- The shipped `package.json` pins direct dependencies, but the delivery workspace could not generate a verified npm lockfile. For a controlled production build, run `npm install`, validate, then retain the generated `package-lock.json` for subsequent `npm ci` builds.

### pgAdmin database naming

For this proxy, use the IBM i *LOCAL RDB name as pgAdmin's **Maintenance database**. Example: if `WRKRDBDIRE` shows local RDB `POWER11A` and the application library is `MONAI`, configure `IBMI_RDB_NAME=POWER11A`, `IBMI_CURRENT_SCHEMA=MONAI`, and enter `POWER11A` as Maintenance database in pgAdmin.

The RDB name is a PostgreSQL-facing identity in this implementation; the Mapepire WebSocket endpoint is still selected by `IBMI_HOST`/`MAPEPIRE_PORT`. One proxy instance does not route a client-supplied database name to arbitrary RDB directory entries.

