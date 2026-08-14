import assert from 'node:assert/strict';
import { inspectIbmiSchema } from '../dist/src/mapepire/schema-capabilities.js';

function fakeJob({ exists = true, qsqjrn = false, inheritance = false, sqlSchema = 'MCPDATA_LONG', systemSchema = 'MCPDA00001' } = {}) {
  const seen = [];
  return {
    seen,
    async execute(sql) {
      seen.push(sql);
      if (/SYSSCHEMAS/i.test(sql)) {
        return { data: exists ? [{ SCHEMA_NAME: sqlSchema, SYSTEM_SCHEMA_NAME: systemSchema }] : [] };
      }
      if (/OBJECT_STATISTICS/i.test(sql)) return { data: [{ JOURNAL_COUNT: qsqjrn ? 1 : 0 }] };
      if (/JOURNALED_OBJECTS/i.test(sql)) {
        return { data: inheritance ? [{ JOURNAL_LIBRARY: 'APPDATA', JOURNAL_NAME: 'APPJRN', INHERIT: '*YES' }] : [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

const longSchemaJob = fakeJob({ qsqjrn: true });
const sqlSchema = await inspectIbmiSchema(longSchemaJob, 'MCPDATA_LONG');
assert.equal(sqlSchema.exists, true);
assert.equal(sqlSchema.systemSchema, 'MCPDA00001');
assert.equal(sqlSchema.hasQsqjrn, true);
assert.equal(sqlSchema.transactionalWritesConfigured, true);
assert.match(longSchemaJob.seen.find((sql) => /OBJECT_STATISTICS/i.test(sql)) ?? '', /MCPDA00001/);
assert.doesNotMatch(longSchemaJob.seen.find((sql) => /OBJECT_STATISTICS/i.test(sql)) ?? '', /MCPDATA_LONG/);

const inheritedJob = fakeJob({ inheritance: true, sqlSchema: 'LEGACYLIB', systemSchema: 'LEGACYLIB' });
const inherited = await inspectIbmiSchema(inheritedJob, 'LEGACYLIB');
assert.equal(inherited.hasQsqjrn, false);
assert.equal(inherited.hasLibraryJournalInheritance, true);
assert.equal(inherited.inheritedJournal, 'APPDATA/APPJRN');
assert.equal(inherited.transactionalWritesConfigured, true);

const plain = await inspectIbmiSchema(fakeJob({ sqlSchema: 'PLAINLIB', systemSchema: 'PLAINLIB' }), 'PLAINLIB');
assert.equal(plain.hasQsqjrn, false);
assert.equal(plain.hasLibraryJournalInheritance, false);
assert.equal(plain.transactionalWritesConfigured, false);

console.log('IBM i schema journaling capability preflight check OK');
