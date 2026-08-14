import assert from 'node:assert/strict';

// ProxySession imports runtime configuration. Keep the build-time contract
// deterministic and independent from deployment credentials.
process.env.IBMI_RDB_NAME ??= 'BUILDTEST';
process.env.IBMI_HOST ??= 'build-test.invalid';
process.env.IBMI_USER ??= 'build-test';
process.env.IBMI_PASSWORD ??= 'build-test';
process.env.PG_PROXY_USER ??= 'proxyuser';
process.env.PG_PROXY_PASSWORD ??= 'proxypass';
process.env.DEFAULT_SCHEMA ??= 'MYLIB';
process.env.PG_SERVER_VERSION ??= '14.0';
process.env.MAPEPIRE_BACKEND_LEASE_MODE = 'session';

const { parsePgDeallocate } = await import('../dist/src/sql/prepared-control.js');
const { translateSql } = await import('../dist/src/sql/translator.js');
const { ProxySession } = await import('../dist/src/proxy/session.js');

assert.deepEqual(parsePgDeallocate('DEALLOCATE ALL'), { action: 'all' });
assert.deepEqual(parsePgDeallocate('DEALLOCATE PREPARE "_pg3_1"'), { action: 'one', name: '_pg3_1' });
assert.equal(parsePgDeallocate('DEALLOCATE DESCRIPTOR D1'), undefined);

const opts = {
  uppercaseIdentifiers: true,
  informationSchemaRewrite: true,
  pgCatalogCompat: true,
  allowMultiStatement: false,
  maxRows: 0,
  ddlDefaultVarcharLength: 1024,
};
const ddl = translateSql(`CREATE TABLE a2a_agents (
  id VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  description TEXT,
  endpoint_url VARCHAR(767) NOT NULL,
  agent_type VARCHAR(50) DEFAULT 'generic' NOT NULL,
  protocol_version VARCHAR(10) DEFAULT '1.0' NOT NULL,
  capabilities JSON,
  config JSON,
  auth_type VARCHAR(50),
  auth_value TEXT,
  enabled BOOLEAN DEFAULT '1',
  reachable BOOLEAN DEFAULT '1',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
  last_interaction TIMESTAMP WITH TIME ZONE,
  tags JSON,
  created_by VARCHAR(255),
  created_from_ip VARCHAR(45),
  created_via VARCHAR(100),
  created_user_agent TEXT,
  modified_by VARCHAR(255),
  modified_from_ip VARCHAR(45),
  modified_via VARCHAR(100),
  modified_user_agent TEXT,
  import_batch_id VARCHAR(36),
  federation_source VARCHAR(255),
  version INTEGER DEFAULT '1' NOT NULL,
  CONSTRAINT pk_a2a_agents PRIMARY KEY (id),
  CONSTRAINT uq_a2a_agents_name UNIQUE (name),
  CONSTRAINT uq_a2a_agents_slug UNIQUE (slug)
)`, opts).sql;
assert.match(ddl, /ENABLED BOOLEAN DEFAULT TRUE/i);
assert.match(ddl, /REACHABLE BOOLEAN DEFAULT TRUE/i);
assert.match(ddl, /VERSION INTEGER DEFAULT 1 NOT NULL/i);
assert.match(ddl, /AGENT_TYPE VARCHAR\(50\) DEFAULT 'generic' NOT NULL/i);
assert.match(ddl, /PROTOCOL_VERSION VARCHAR\(10\) DEFAULT '1\.0' NOT NULL/i);
assert.match(ddl, /DESCRIPTION CLOB\(2G\) CCSID 1208/i);
assert.match(ddl, /CAPABILITIES CLOB\(2G\) CCSID 1208/i);
assert.match(ddl, /CREATED_AT TIMESTAMP NOT NULL/i);
assert.doesNotMatch(ddl, /BOOLEAN\s+DEFAULT\s+'[01]'/i);
assert.doesNotMatch(ddl, /INTEGER\s+DEFAULT\s+'[+-]?\d+'/i);

// Validate that psycopg's post-ROLLBACK DEALLOCATE ALL is consumed by the
// PostgreSQL session layer and is never forwarded to Db2, whose DEALLOCATE
// grammar is for descriptors and rejects PostgreSQL's ALL token.
const executed = [];
const fakeJob = {
  execute: async (sql) => {
    executed.push(String(sql));
    return { has_results: false, data: [], is_done: true, update_count: 0 };
  },
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
const connection = { chunks: [], sendData(data) { this.chunks.push(Buffer.from(data)); } };
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const session = new ProxySession(
  connection,
  fakePool,
  { user: 'proxyuser', database: 'BUILDTEST', applicationName: 'psycopg verifier' },
  logger,
);
await session.initialize();
executed.length = 0;
await session.handleRaw(queryFrame('BEGIN'));
await session.handleRaw(queryFrame('ROLLBACK'));
await session.handleRaw(queryFrame('DEALLOCATE ALL'));
assert.ok(executed.includes('ROLLBACK'), 'ROLLBACK must reach Db2');
assert.ok(!executed.some((sql) => /DEALLOCATE/i.test(sql)), 'DEALLOCATE ALL must not reach Db2');
await session.close();

console.log('PostgreSQL prepared-statement cleanup / Db2 Boolean+numeric default compatibility check OK');

function queryFrame(sql) {
  const body = Buffer.concat([Buffer.from(sql, 'utf8'), Buffer.from([0])]);
  const out = Buffer.allocUnsafe(5 + body.length);
  out.write('Q', 0, 1, 'ascii');
  out.writeInt32BE(4 + body.length, 1);
  body.copy(out, 5);
  return out;
}
