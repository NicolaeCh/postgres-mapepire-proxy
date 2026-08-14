import assert from 'node:assert/strict';
import { decideLobIndexCompatibility, isDb2LobType, parsePgSimpleCreateIndex } from '../dist/src/sql/lob-index.js';

const tags = parsePgSimpleCreateIndex('CREATE INDEX idx_tools_tags ON tools (tags)');
assert.ok(tags);
assert.equal(tags.unique, false);
assert.equal(tags.indexName, 'IDX_TOOLS_TAGS');
assert.equal(tags.tableName, 'TOOLS');
assert.deepEqual(tags.columns, ['TAGS']);
assert.equal(isDb2LobType('CLOB(2G) CCSID 1208'), true);
assert.equal(decideLobIndexCompatibility(tags, [{ column: 'TAGS', type: 'CLOB(2G) CCSID 1208' }], 'skip').action, 'skip');
assert.equal(decideLobIndexCompatibility(tags, [{ column: 'TAGS', type: 'CLOB(2G) CCSID 1208' }], 'error').action, 'error');

const unique = parsePgSimpleCreateIndex('CREATE UNIQUE INDEX uq_payload ON docs (payload)');
assert.ok(unique?.unique, 'UNIQUE LOB-backed indexes must be detectable so the proxy never silently skips integrity semantics');
assert.equal(decideLobIndexCompatibility(unique, [{ column: 'PAYLOAD', type: 'CLOB(2G)' }], 'skip').action, 'error');

assert.equal(parsePgSimpleCreateIndex('CREATE INDEX ix ON tools ((lower(name)))'), undefined);
assert.equal(parsePgSimpleCreateIndex('CREATE INDEX ix ON tools (tags) WHERE enabled'), undefined);

console.log('PostgreSQL non-unique LOB-index compatibility policy check OK');
