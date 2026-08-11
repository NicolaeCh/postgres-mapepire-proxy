import { describe, expect, it } from 'vitest';
import { consumeFrontendMessages, dataRow, readyForQuery, rowDescription, splitFrontendMessages } from '../src/postgres/wire.js';
import { OID } from '../src/postgres/oids.js';

describe('PG wire serialization', () => {
  it('creates ReadyForQuery', () => {
    const b = readyForQuery('I');
    expect(b[0]).toBe('Z'.charCodeAt(0));
    expect(b.readInt32BE(1)).toBe(5);
    expect(b[5]).toBe('I'.charCodeAt(0));
  });
  it('creates DataRow with null', () => {
    const b = dataRow(['abc', null]);
    expect(b[0]).toBe('D'.charCodeAt(0));
  });
  it('creates RowDescription', () => {
    const b = rowDescription([{ name: 'ID', typeOid: OID.int4, typeSize: 4 }]);
    expect(b[0]).toBe('T'.charCodeAt(0));
  });
  it('parses coalesced frontend frames', () => {
    const q1 = frontendFrame('Q', Buffer.from('values 1\0'));
    const q2 = frontendFrame('Q', Buffer.from('values 2\0'));
    const parsed = consumeFrontendMessages(Buffer.concat([q1, q2]), 1024);
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages.map((m) => m.type)).toEqual(['Q', 'Q']);
    expect(parsed.remainder).toHaveLength(0);
  });

  it('buffers a fragmented frontend frame', () => {
    const q = frontendFrame('Q', Buffer.from('select 1\0'));
    const first = consumeFrontendMessages(q.subarray(0, 6), 1024);
    expect(first.messages).toHaveLength(0);
    const second = consumeFrontendMessages(Buffer.concat([first.remainder, q.subarray(6)]), 1024);
    expect(second.messages).toHaveLength(1);
    expect(second.remainder).toHaveLength(0);
    expect(splitFrontendMessages(q)).toHaveLength(1);
  });

});

function frontendFrame(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(5 + body.length);
  out.write(type, 0, 1, 'ascii');
  out.writeInt32BE(4 + body.length, 1);
  body.copy(out, 5);
  return out;
}
