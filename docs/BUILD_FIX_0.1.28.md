# Compatibility fix 0.1.28 — numeric DDL defaults

ContextForge migration `90cc4b5a96e7` reached `CREATE TABLE a2a_agents` after the 0.1.27 Boolean-default fix, but Db2 for i still returned SQL0574/42894. The translated DDL showed Boolean defaults already normalized to `TRUE`; the remaining type-incompatible default was `version INTEGER DEFAULT '1'`.

SQLAlchemy treats `server_default` text literally. A numeric model column can therefore arrive at the proxy with a quoted PostgreSQL string default. Db2 for i validates column defaults against the declared datatype.

0.1.28 adds type-aware numeric default normalization for CREATE/ALTER TABLE:

- integer families: quoted signed integer -> numeric integer literal;
- DECIMAL/NUMERIC: quoted simple decimal -> decimal literal;
- REAL/DOUBLE/FLOAT/DECFLOAT: quoted simple floating/exponent literal -> numeric literal;
- character columns are never changed by this rule.

Examples:

```sql
INTEGER DEFAULT '1'      -> INTEGER DEFAULT 1
BIGINT DEFAULT '-42'     -> BIGINT DEFAULT -42
DECIMAL(10,2) DEFAULT '1.25' -> DECIMAL(10,2) DEFAULT 1.25
VARCHAR(20) DEFAULT '1'  -> unchanged
```

The existing PostgreSQL `DEALLOCATE` session handling and Boolean-default normalization remain in place.
