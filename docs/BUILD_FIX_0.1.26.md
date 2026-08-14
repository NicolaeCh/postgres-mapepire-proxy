# Build fix 0.1.26

Release 0.1.25 introduced mandatory per-session IBM i schema preparation through `SessionJobPool.prepareSchema()`.
The production pool implemented the new contract, but `scripts/verify-pgadmin-wire.mjs` still used the older minimal fake-pool shape.
The build therefore compiled successfully and then failed during the runtime verifier with:

```
TypeError: this.pool.prepareSchema is not a function
```

0.1.26 updates the pgAdmin wire verifier to implement the current pool contract with deterministic synthetic schema capabilities.
Production `ProxySession` still requires `prepareSchema()`; the runtime application does not silently bypass schema/journaling validation when a malformed pool is supplied.

The release also updates the multi-architecture helper script defaults, which had remained on the older 0.1.18 tag.
