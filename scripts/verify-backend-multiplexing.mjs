import assert from 'node:assert/strict';

process.env.IBMI_RDB_NAME ??= 'BUILDTEST';
process.env.IBMI_HOST ??= 'build-test.invalid';
process.env.IBMI_USER ??= 'build-test';
process.env.IBMI_PASSWORD ??= 'build-test';
process.env.PG_PROXY_USER ??= 'proxyuser';
process.env.PG_PROXY_PASSWORD ??= 'proxypass';
process.env.DEFAULT_SCHEMA ??= 'MYLIB';
process.env.PG_SERVER_VERSION ??= '14.0';
process.env.MAPEPIRE_BACKEND_LEASE_MODE = 'transaction';

const { ProxySession } = await import('../dist/src/proxy/session.js');

const capabilities = {
  schema: 'MYLIB',
  systemSchema: 'MYLIB',
  exists: true,
  hasQsqjrn: true,
  hasLibraryJournalInheritance: false,
  transactionalWritesConfigured: true,
  sqlSchemaJournalReady: true,
  checkedAt: '2000-01-01T00:00:00.000Z',
};

let acquireCount = 0;
let releaseCount = 0;
let active = 0;
let peakActive = 0;
const executed = [];
const fakeJob = {
  async execute(sql) {
    executed.push(String(sql));
    if (/VALUES\s+CURRENT\s+SCHEMA/i.test(String(sql))) {
      return { has_results: true, data: [{ '1': 'MYLIB' }], is_done: true, update_count: 0 };
    }
    return { has_results: false, data: [], is_done: true, update_count: 0 };
  },
};
const fakePool = {
  schemaCapabilities: () => ({ ...capabilities }),
  prepareSchema: async (_job, schema) => ({ ...capabilities, schema, systemSchema: schema }),
  acquire: async () => {
    acquireCount++;
    active++;
    peakActive = Math.max(peakActive, active);
    return fakeJob;
  },
  release: async () => { releaseCount++; active--; },
  invalidate: async () => { active = Math.max(0, active - 1); },
  stats: () => ({ total: 1, maxSize: 1, creating: 0, idle: active ? 0 : 1, leased: active, waiters: 0, ready: 1, unhealthy: 0, availableSlots: active ? 0 : 1, saturated: Boolean(active) }),
};
const logger = { debug() {}, info() {}, warn() {}, error() {} };

const sessions = Array.from({ length: 32 }, (_, i) => new ProxySession(
  { sendData() {} },
  fakePool,
  { user: 'proxyuser', database: 'BUILDTEST', applicationName: `logical-${i}` },
  logger,
));

for (const session of sessions) await session.initialize();
assert.equal(acquireCount, 0, 'ordinary PostgreSQL logins must not consume Mapepire jobs in transaction mode');

for (const session of sessions) {
  await session.handleRaw(queryFrame('SELECT pg_try_advisory_lock(42424242424242)'));
}
assert.equal(acquireCount, 0, 'proxy-local advisory-lock polling must not consume Mapepire jobs');

// Autocommit backend work gets a short lease and returns it immediately.
await sessions[0].handleRaw(queryFrame('SET search_path TO MYLIB'));
assert.equal(acquireCount, 1);
assert.equal(releaseCount, 1);
assert.equal(active, 0);

// Explicit transactions pin the backend across messages until ROLLBACK.
await sessions[0].handleRaw(queryFrame('BEGIN'));
assert.equal(active, 0, 'BEGIN alone must stay logical until Db2 work is needed');
await sessions[0].handleRaw(queryFrame('SET search_path TO MYLIB'));
assert.equal(active, 1, 'first Db2-backed statement in transaction must pin one backend');
const acquiredBeforeLockPoll = acquireCount;
await sessions[0].handleRaw(queryFrame('SELECT pg_try_advisory_lock(42424242424243)'));
assert.equal(acquireCount, acquiredBeforeLockPoll, 'advisory lock inside a transaction must reuse/no-op backend allocation');
assert.equal(active, 1);
await sessions[0].handleRaw(queryFrame('ROLLBACK'));
assert.equal(active, 0, 'transaction end must return the pinned backend');
assert.equal(releaseCount, 2);
assert.equal(peakActive, 1);

for (const session of sessions) await session.close();
assert.equal(active, 0);

console.log('PostgreSQL logical-session / Mapepire transaction-pooling contract check OK');

function queryFrame(sql) {
  const body = Buffer.concat([Buffer.from(sql, 'utf8'), Buffer.from([0])]);
  const out = Buffer.allocUnsafe(5 + body.length);
  out.write('Q', 0, 1, 'ascii');
  out.writeInt32BE(4 + body.length, 1);
  body.copy(out, 5);
  return out;
}
