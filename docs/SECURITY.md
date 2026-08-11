# Security Model

## Service account

All Db2 statements execute under `IBMI_USER`. Therefore the service profile is the primary security boundary on IBM i.

Recommended controls:

- dedicated non-interactive IBM i profile;
- least privilege to required schemas/tables/procedures;
- no broad `*ALLOBJ` authority;
- password stored only in runtime secret/environment management;
- Mapepire TLS certificate validation enabled;
- IBM i auditing/query supervision applied to the service profile where appropriate.

Because all clients share the IBM i identity, Db2 cannot natively distinguish end users by authorization ID. If audit attribution is required, extend the proxy to set an IBM i client/application identifier per PostgreSQL connection where supported and include PostgreSQL client/user/application metadata in structured logs.

## PostgreSQL-facing authentication

`PG_PROXY_USER` is not an IBM i profile. It protects access to the proxy only. One static user is deliberately simple; production environments can later replace `validateCredentials()` with an external identity provider without changing the Mapepire service-user model.

## TLS

Two independent encrypted links can exist:

1. Client → proxy PostgreSQL TLS.
2. Proxy → Mapepire WSS TLS.

Do not confuse their certificates or trust settings.

## Secrets

The supplied `.env` contains placeholders only. Never commit real `.env` contents. With Kubernetes/OpenShift/Podman secrets, generate the environment at deployment time rather than storing passwords in an image layer.
