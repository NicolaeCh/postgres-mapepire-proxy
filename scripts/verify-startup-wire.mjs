import assert from 'node:assert/strict';

const { ProxyGatewayConnection } = await import('../dist/src/postgres/gateway-connection.js');

class FakeSocket {
  handlers = new Map();
  chunks = [];
  destroyed = false;
  paused = false;
  on(name, fn) { const a = this.handlers.get(name) ?? []; a.push(fn); this.handlers.set(name, a); return this; }
  off(name, fn) { const a = this.handlers.get(name) ?? []; this.handlers.set(name, a.filter((x) => x !== fn)); return this; }
  write(data) { this.chunks.push(Buffer.from(data)); return true; }
  pause() { this.paused = true; return this; }
  resume() { this.paused = false; return this; }
  end() { this.destroyed = true; return this; }
}

const socket = new FakeSocket();
let hookSawReady = false;
const connection = new ProxyGatewayConnection(socket, {
  serverVersion: '14.0',
  authMode: 'none',
  async onAuthenticated() {
    hookSawReady = parseTypes(socket.chunks).includes('Z');
  },
});
connection.clientInfo = {
  majorVersion: 3,
  minorVersion: 0,
  parameters: { user: 'proxyuser', database: 'postgres', application_name: 'pgAdmin 4' },
};
await connection.completeAuthentication();

assert.equal(hookSawReady, false, 'ReadyForQuery was sent before backend/session initialization hook completed');
const types = parseTypes(socket.chunks);
assert.equal(types[0], 'R', 'AuthenticationOk must be first');
assert.ok(types.includes('S'), 'startup ParameterStatus missing');
assert.ok(types.includes('K'), 'BackendKeyData missing');
assert.equal(types.at(-1), 'Z', 'ReadyForQuery must terminate startup');
assert.ok(types.indexOf('K') < types.lastIndexOf('Z'), 'BackendKeyData must precede ReadyForQuery');

const statuses = decodeParameterStatuses(socket.chunks);
for (const required of ['server_version','server_encoding','client_encoding','DateStyle','integer_datetimes','standard_conforming_strings','TimeZone']) {
  assert.ok(statuses.has(required), `missing startup ParameterStatus ${required}`);
}
assert.equal(statuses.get('server_version'), '14.0');
assert.equal(statuses.get('client_encoding'), 'UTF8');

console.log('PostgreSQL startup handshake contract check OK');

function frames(chunks) {
  const data = Buffer.concat(chunks);
  const out = [];
  let offset = 0;
  while (offset < data.length) {
    const type = String.fromCharCode(data[offset]);
    const length = data.readInt32BE(offset + 1);
    const end = offset + 1 + length;
    assert.ok(end <= data.length, `truncated startup frame ${type}`);
    out.push({ type, body: data.subarray(offset + 5, end) });
    offset = end;
  }
  return out;
}
function parseTypes(chunks) { return frames(chunks).map((f) => f.type); }
function decodeParameterStatuses(chunks) {
  const result = new Map();
  for (const f of frames(chunks)) {
    if (f.type !== 'S') continue;
    const first = f.body.indexOf(0);
    const second = f.body.indexOf(0, first + 1);
    result.set(f.body.toString('utf8', 0, first), f.body.toString('utf8', first + 1, second));
  }
  return result;
}
