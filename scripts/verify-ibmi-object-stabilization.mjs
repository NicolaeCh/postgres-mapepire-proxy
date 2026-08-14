import assert from 'node:assert/strict';

const { isTransientIbmiObjectStateError, ibmiObjectStabilizationDelayMs } = await import('../dist/src/mapepire/object-stabilization.js');

const fileNotFoundYet = new Error('[SQL0443] FILE NOT FOUND YET. MCPDATA.TOOLS, 42704, -443');
assert.equal(isTransientIbmiObjectStateError(
  fileNotFoundYet,
  'SELECT * FROM QSYS2.SYSCOLUMNS2 WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
), true);

const generatedSystemName = new Error('[SQL0204] EMAIL00003 in MCPDATA type *FILE not found., 42704, -204');
assert.equal(isTransientIbmiObjectStateError(
  generatedSystemName,
  "ALTER TABLE EMAIL_TEAMS ADD CONSTRAINT CK_EMAIL_TEAMS_VISIBILITY CHECK (VISIBILITY IN ('private','team'))",
), true);

const realMissingTable = new Error('[SQL0204] EMAIL_TEAMS in MCPDATA type *FILE not found., 42704, -204');
assert.equal(isTransientIbmiObjectStateError(realMissingTable, 'ALTER TABLE EMAIL_TEAMS ADD COLUMN X INTEGER'), false);

const missingReferencedTable = new Error('[SQL0204] CUSTOMER in MCPDATA type *FILE not found., 42704, -204');
assert.equal(isTransientIbmiObjectStateError(
  missingReferencedTable,
  'ALTER TABLE EMAIL_TEAMS ADD CONSTRAINT FK1 FOREIGN KEY (OWNER_ID) REFERENCES CUSTOMER(ID)',
), false);

const unrelated = new Error('[SQL0601] IX_EMAIL_USERS_EMAIL in MCPDATA type *FILE already exists., 42710, -601');
assert.equal(isTransientIbmiObjectStateError(unrelated, 'CREATE INDEX IX_EMAIL_USERS_EMAIL ON EMAIL_USERS (EMAIL)'), false);

assert.equal(ibmiObjectStabilizationDelayMs(1), 50);
assert.equal(ibmiObjectStabilizationDelayMs(2), 100);
assert.equal(ibmiObjectStabilizationDelayMs(5), 800);
assert.equal(ibmiObjectStabilizationDelayMs(6), 800);
assert.equal(ibmiObjectStabilizationDelayMs(99), 800);

console.log('IBM i transient object-stabilization retry contract check OK');
