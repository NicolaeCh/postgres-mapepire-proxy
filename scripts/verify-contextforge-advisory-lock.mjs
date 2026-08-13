import assert from 'node:assert/strict';
import {
  executePgAdvisoryLockQuery,
  parsePgAdvisoryLockQuery,
  pgAdvisoryLockFields,
  pgAdvisoryLockRegistrySize,
  releaseAllPgAdvisoryLocks,
} from '../dist/src/sql/advisory-lock.js';

const key = '42424242424242';
const tryQuery = parsePgAdvisoryLockQuery(`SELECT pg_try_advisory_lock(${key})`);
assert.ok(tryQuery);
assert.equal(tryQuery.action, 'tryLock');
assert.deepEqual(pgAdvisoryLockFields(tryQuery).map((f) => [f.name, f.typeOid]), [['pg_try_advisory_lock', 16]]);

const owner1 = {};
const owner2 = {};
let r = executePgAdvisoryLockQuery(tryQuery, owner1);
assert.equal(r.rows[0][0], true, 'first ContextForge worker must acquire the migration lock');
assert.equal(pgAdvisoryLockRegistrySize(), 1);

r = executePgAdvisoryLockQuery(tryQuery, owner2);
assert.equal(r.rows[0][0], false, 'second worker must observe the lock as held');

// PostgreSQL session advisory locks are re-entrant for the same session.
r = executePgAdvisoryLockQuery(tryQuery, owner1);
assert.equal(r.rows[0][0], true);

const unlock = parsePgAdvisoryLockQuery(`SELECT pg_advisory_unlock(${key})`);
assert.ok(unlock);
r = executePgAdvisoryLockQuery(unlock, owner1);
assert.equal(r.rows[0][0], true);
assert.equal(pgAdvisoryLockRegistrySize(), 1, 'one re-entrant hold must remain');
r = executePgAdvisoryLockQuery(unlock, owner1);
assert.equal(r.rows[0][0], true);
assert.equal(pgAdvisoryLockRegistrySize(), 0);

r = executePgAdvisoryLockQuery(tryQuery, owner2);
assert.equal(r.rows[0][0], true, 'waiting worker can acquire after release');
assert.equal(releaseAllPgAdvisoryLocks(owner2), 1, 'session close must release held locks');
assert.equal(pgAdvisoryLockRegistrySize(), 0);

const alias = parsePgAdvisoryLockQuery(`SELECT pg_catalog.pg_try_advisory_lock(${key}) AS acquired`);
assert.ok(alias);
assert.equal(alias.fieldName, 'acquired');

console.log('ContextForge PostgreSQL advisory-lock compatibility check OK');
