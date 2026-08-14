import assert from 'node:assert/strict';

// ProxySession imports runtime configuration. The build-time contract test uses
// a fake Mapepire pool, but config still requires these values to be present.
process.env.IBMI_RDB_NAME ??= 'BUILDTEST';
process.env.IBMI_HOST ??= 'build-test.invalid';
process.env.IBMI_USER ??= 'build-test';
process.env.IBMI_PASSWORD ??= 'build-test';
process.env.PG_PROXY_USER ??= 'proxyuser';
process.env.PG_PROXY_PASSWORD ??= 'proxypass';
process.env.DEFAULT_SCHEMA ??= 'MYLIB';
process.env.PG_SERVER_VERSION ??= '14.0';
process.env.MAPEPIRE_BACKEND_LEASE_MODE = 'session';

const { ProxySession } = await import('../dist/src/proxy/session.js');

class CaptureConnection {
  chunks = [];
  sendData(data) { this.chunks.push(Buffer.from(data)); }
  take() { const out = this.chunks; this.chunks = []; return out; }
}

const fakeJob = {
  execute: async () => ({ has_results: false, data: [], is_done: true, update_count: 0 }),
};
const fakePool = {
  schemaCapabilities: () => undefined,
  stats: () => ({ total: 1, maxSize: 1, creating: 0, idle: 0, leased: 1, waiters: 0, ready: 1, unhealthy: 0, availableSlots: 0, saturated: false }),
  acquire: async () => fakeJob,
  release: async () => {},
  invalidate: async () => {},
  prepareSchema: async (_job, schema) => ({
    schema,
    systemSchema: schema,
    exists: true,
    hasQsqjrn: true,
    hasLibraryJournalInheritance: false,
    transactionalWritesConfigured: true,
    sqlSchemaJournalReady: true,
    checkedAt: '2000-01-01T00:00:00.000Z',
  }),
};
const logger = {
  debug() {}, info() {}, warn() {}, error() {},
};
const connection = new CaptureConnection();
const session = new ProxySession(
  connection,
  fakePool,
  { user: 'proxyuser', database: 'BUILDTEST', applicationName: 'pgAdmin 4 - DB:BUILDTEST' },
  logger,
);
await session.initialize();

// pgAdmin _initialize() sends this multi-statement batch with no parameters.
// Psycopg may use Simple Query for a multi-statement command, so validate that
// path independently of the Extended Query tests below.
connection.take();
await session.handleRaw(frontendFrame('Q', cstr(
  "SET DateStyle=ISO; SET client_min_messages=notice; " +
  "SELECT set_config('bytea_output','hex',false) FROM pg_show_all_settings() WHERE name = 'bytea_output'; " +
  "SET client_encoding='UTF8';"
)));
{
  const frames = parseBackendFrames(connection.take());
  const types = frames.map((f) => f.type);
  assert.ok(!types.includes('E'), 'pgAdmin initialization batch returned ErrorResponse');
  assert.equal(types.at(-1), 'Z', 'pgAdmin initialization batch must end in ReadyForQuery');
  assert.equal(types.filter((t) => t === 'T').length, 1, 'set_config must provide one RowDescription');
  assert.equal(types.filter((t) => t === 'D').length, 1, 'set_config must provide one DataRow');
  assert.equal(types.filter((t) => t === 'C').length, 4, 'initialization batch must complete all four commands');
}

const startupQueries = [
  ['version', 'SELECT version()', ['version']],
  ['database', `SELECT db.oid as did, db.datname, db.datallowconn,
    pg_encoding_to_char(db.encoding) AS serverencoding,
    has_database_privilege(db.oid, 'CREATE') as cancreate,
    datistemplate
    FROM pg_catalog.pg_database db
    WHERE db.datname = current_database()`,
    ['did','datname','datallowconn','serverencoding','cancreate','datistemplate']],
  ['gss', `SELECT gss_authenticated, encrypted
    FROM pg_catalog.pg_stat_gssapi WHERE pid = pg_backend_pid()`,
    ['gss_authenticated','encrypted']],
  ['roles', `SELECT roles.oid as id, roles.rolname as name,
    roles.rolsuper as is_superuser,
    CASE WHEN roles.rolsuper THEN true ELSE roles.rolcreaterole END as can_create_role,
    CASE WHEN roles.rolsuper THEN true ELSE roles.rolcreatedb END as can_create_db,
    CASE WHEN 'pg_signal_backend'=ANY(ARRAY(WITH RECURSIVE cte AS (
      SELECT pg_roles.oid,pg_roles.rolname FROM pg_catalog.pg_roles
      WHERE pg_roles.oid = roles.oid UNION ALL
      SELECT m.roleid,pgr.rolname FROM cte cte_1
      JOIN pg_catalog.pg_auth_members m ON m.member = cte_1.oid
      JOIN pg_catalog.pg_roles pgr ON pgr.oid = m.roleid)
      SELECT rolname FROM cte)) THEN True ELSE False END as can_signal_backend
    FROM pg_catalog.pg_roles as roles WHERE rolname = current_user`,
    ['id','name','is_superuser','can_create_role','can_create_db','can_signal_backend']],
  ['recovery', `SELECT CASE WHEN usesuper THEN pg_catalog.pg_is_in_recovery()
    ELSE FALSE END as inrecovery,
    CASE WHEN usesuper AND pg_catalog.pg_is_in_recovery()
    THEN pg_is_wal_replay_paused() ELSE FALSE END as isreplaypaused
    FROM pg_catalog.pg_user WHERE usename=current_user`,
    ['inrecovery','isreplaypaused']],
  ['replication-type', `SELECT CASE
    WHEN (SELECT count(extname) FROM pg_catalog.pg_extension WHERE extname='bdr') > 0
    THEN 'pgd'
    WHEN (SELECT COUNT(*) FROM pg_catalog.pg_replication_slots) > 0
    THEN 'log'
    ELSE NULL
    END as type`, ['type']],
];

for (const [name, sql, expectedFields] of startupQueries) {
  connection.take();
  await session.handleRaw(Buffer.concat([
    parseFrame('', sql),
    bindFrame('', ''),
    describePortalFrame(''),
    executeFrame('', 0),
    frontendFrame('S', Buffer.alloc(0)),
  ]));

  const frames = parseBackendFrames(connection.take());
  const types = frames.map((f) => f.type);
  assert.equal(types[0], '1', `${name}: ParseComplete missing`);
  assert.equal(types[1], '2', `${name}: BindComplete missing`);
  assert.equal(types[2], 'T', `${name}: portal Describe must return RowDescription`);
  assert.ok(!types.includes('n'), `${name}: row-returning query must not return NoData`);
  assert.equal(types.filter((t) => t === 'T').length, 1, `${name}: RowDescription must be sent exactly once`);
  assert.equal(types.at(-2), 'C', `${name}: CommandComplete missing`);
  assert.equal(types.at(-1), 'Z', `${name}: ReadyForQuery missing after Sync`);

  const fields = decodeRowDescription(frames.find((f) => f.type === 'T').body);
  assert.deepEqual(fields, expectedFields, `${name}: RowDescription field contract mismatch`);
  const rows = frames.filter((f) => f.type === 'D');
  assert.ok(rows.length >= 1, `${name}: expected at least one DataRow`);
  for (const row of rows) {
    assert.equal(row.body.readUInt16BE(0), expectedFields.length, `${name}: DataRow column count differs from RowDescription`);
  }
  if (name === 'replication-type') {
    assert.equal(rows.length, 1, 'replication-type: pgAdmin requires exactly one result row');
    assert.equal(rows[0].body.readInt32BE(2), -1, 'replication-type: the single type value must be PostgreSQL NULL');
  }
}

await session.close();
console.log('pgAdmin psycopg3 Extended Query wire contract check OK');

function frontendFrame(type, body) {
  const out = Buffer.allocUnsafe(5 + body.length);
  out.write(type, 0, 1, 'ascii');
  out.writeInt32BE(4 + body.length, 1);
  body.copy(out, 5);
  return out;
}
function cstr(value) { return Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])]); }
function parseFrame(name, sql) {
  const n = Buffer.alloc(2); n.writeUInt16BE(0, 0);
  return frontendFrame('P', Buffer.concat([cstr(name), cstr(sql), n]));
}
function bindFrame(portal, statement) {
  const zero = Buffer.alloc(2); zero.writeUInt16BE(0, 0);
  return frontendFrame('B', Buffer.concat([cstr(portal), cstr(statement), zero, zero, zero]));
}
function describePortalFrame(name) { return frontendFrame('D', Buffer.concat([Buffer.from('P'), cstr(name)])); }
function executeFrame(portal, maxRows) {
  const n = Buffer.alloc(4); n.writeUInt32BE(maxRows, 0);
  return frontendFrame('E', Buffer.concat([cstr(portal), n]));
}
function parseBackendFrames(chunks) {
  const data = Buffer.concat(chunks);
  const out = [];
  let offset = 0;
  while (offset < data.length) {
    assert.ok(offset + 5 <= data.length, 'truncated backend frame header');
    const type = String.fromCharCode(data[offset]);
    const length = data.readInt32BE(offset + 1);
    assert.ok(length >= 4, `invalid backend frame length for ${type}`);
    const end = offset + 1 + length;
    assert.ok(end <= data.length, `truncated backend frame ${type}`);
    out.push({ type, body: data.subarray(offset + 5, end) });
    offset = end;
  }
  return out;
}
function decodeRowDescription(body) {
  const count = body.readUInt16BE(0);
  const names = [];
  let offset = 2;
  for (let i = 0; i < count; i++) {
    const end = body.indexOf(0, offset);
    assert.ok(end >= 0, 'RowDescription field name missing terminator');
    names.push(body.toString('utf8', offset, end));
    offset = end + 1 + 18;
  }
  assert.equal(offset, body.length, 'RowDescription payload has unexpected trailing data');
  return names;
}
