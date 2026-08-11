import { OID } from './oids.js';

export interface FieldDescription {
  name: string;
  tableOid?: number;
  columnAttr?: number;
  typeOid: number;
  typeSize: number;
  typeModifier?: number;
  format?: 0 | 1;
}

function cstr(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])]);
}

function frame(type: string, payload = Buffer.alloc(0)): Buffer {
  const out = Buffer.allocUnsafe(1 + 4 + payload.length);
  out.writeUInt8(type.charCodeAt(0), 0);
  out.writeInt32BE(payload.length + 4, 1);
  payload.copy(out, 5);
  return out;
}

export function parseComplete(): Buffer { return frame('1'); }
export function bindComplete(): Buffer { return frame('2'); }
export function closeComplete(): Buffer { return frame('3'); }
export function noData(): Buffer { return frame('n'); }
export function emptyQueryResponse(): Buffer { return frame('I'); }

export function parameterDescription(oids: number[]): Buffer {
  const p = Buffer.allocUnsafe(2 + oids.length * 4);
  p.writeUInt16BE(oids.length, 0);
  oids.forEach((oid, i) => p.writeUInt32BE(oid >>> 0, 2 + i * 4));
  return frame('t', p);
}

export function rowDescription(fields: FieldDescription[]): Buffer {
  const chunks: Buffer[] = [];
  const count = Buffer.allocUnsafe(2);
  count.writeUInt16BE(fields.length, 0);
  chunks.push(count);
  for (const f of fields) {
    const fixed = Buffer.allocUnsafe(18);
    fixed.writeUInt32BE((f.tableOid ?? 0) >>> 0, 0);
    fixed.writeInt16BE(f.columnAttr ?? 0, 4);
    fixed.writeUInt32BE(f.typeOid >>> 0, 6);
    fixed.writeInt16BE(f.typeSize, 10);
    fixed.writeInt32BE(f.typeModifier ?? -1, 12);
    fixed.writeInt16BE(f.format ?? 0, 16);
    chunks.push(cstr(f.name), fixed);
  }
  return frame('T', Buffer.concat(chunks));
}

export function dataRow(values: unknown[]): Buffer {
  const chunks: Buffer[] = [];
  const count = Buffer.allocUnsafe(2);
  count.writeUInt16BE(values.length, 0);
  chunks.push(count);
  for (const value of values) {
    if (value === null || value === undefined) {
      const n = Buffer.allocUnsafe(4); n.writeInt32BE(-1, 0); chunks.push(n); continue;
    }
    const body = encodeTextValue(value);
    const n = Buffer.allocUnsafe(4); n.writeInt32BE(body.length, 0);
    chunks.push(n, body);
  }
  return frame('D', Buffer.concat(chunks));
}

export function commandComplete(tag: string): Buffer { return frame('C', cstr(tag)); }

export function readyForQuery(status: 'I' | 'T' | 'E'): Buffer {
  return frame('Z', Buffer.from(status));
}

export function errorResponse(input: {
  severity?: string;
  code?: string;
  message: string;
  detail?: string;
  hint?: string;
}): Buffer {
  const fields: Buffer[] = [];
  const add = (code: string, value?: string) => {
    if (!value) return;
    fields.push(Buffer.from(code), Buffer.from(value, 'utf8'), Buffer.from([0]));
  };
  add('S', input.severity ?? 'ERROR');
  add('V', input.severity ?? 'ERROR');
  add('C', input.code ?? 'XX000');
  add('M', input.message);
  add('D', input.detail);
  add('H', input.hint);
  fields.push(Buffer.from([0]));
  return frame('E', Buffer.concat(fields));
}

export function noticeResponse(message: string): Buffer {
  return frame('N', Buffer.concat([Buffer.from('SNOTICE\0M'), Buffer.from(message), Buffer.from([0, 0])]));
}

function encodeTextValue(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.from(`\\x${value.toString('hex')}`, 'utf8');
  if (value instanceof Uint8Array) return Buffer.from(`\\x${Buffer.from(value).toString('hex')}`, 'utf8');
  if (typeof value === 'boolean') return Buffer.from(value ? 't' : 'f');
  if (value instanceof Date) return Buffer.from(value.toISOString().replace('T', ' ').replace('Z', ''));
  if (typeof value === 'object') return Buffer.from(JSON.stringify(value));
  return Buffer.from(String(value), 'utf8');
}

export interface FrontendMessage { type: string; body: Buffer; }

/**
 * Incrementally consumes complete PostgreSQL frontend frames.  `remainder` is
 * retained by the caller for the next TCP data event.  This is intentionally
 * independent of TCP packet boundaries because Parse/Bind/Execute/Sync can be
 * coalesced into one packet or split over several packets.
 */
export function consumeFrontendMessages(
  data: Uint8Array,
  maxMessageBytes = 16 * 1024 * 1024,
): { messages: FrontendMessage[]; remainder: Buffer } {
  const b = Buffer.from(data);
  const messages: FrontendMessage[] = [];
  let offset = 0;
  while (offset + 5 <= b.length) {
    const type = String.fromCharCode(b.readUInt8(offset));
    const length = b.readInt32BE(offset + 1);
    if (length < 4) throw new Error('Malformed PostgreSQL frontend frame length');
    const fullLength = 1 + length;
    if (fullLength > maxMessageBytes) {
      throw new Error(`PostgreSQL frontend frame exceeds configured limit (${maxMessageBytes} bytes)`);
    }
    if (offset + fullLength > b.length) break;
    messages.push({ type, body: b.subarray(offset + 5, offset + fullLength) });
    offset += fullLength;
  }
  if (b.length > maxMessageBytes && offset === 0) {
    throw new Error(`Buffered PostgreSQL frontend data exceeds configured limit (${maxMessageBytes} bytes)`);
  }
  return { messages, remainder: Buffer.from(b.subarray(offset)) };
}

/** Strict helper retained for unit tests and callers that already own a full frame set. */
export function splitFrontendMessages(data: Uint8Array): FrontendMessage[] {
  const { messages, remainder } = consumeFrontendMessages(data, Number.MAX_SAFE_INTEGER);
  if (remainder.length !== 0) throw new Error('Truncated PostgreSQL frontend frame');
  return messages;
}

export function readCString(body: Buffer, start = 0): { value: string; next: number } {
  const end = body.indexOf(0, start);
  if (end < 0) throw new Error('Missing C string terminator');
  return { value: body.toString('utf8', start, end), next: end + 1 };
}

export interface ParseMessage { name: string; sql: string; parameterOids: number[]; }
export function decodeParse(body: Buffer): ParseMessage {
  const name = readCString(body, 0);
  const sql = readCString(body, name.next);
  let o = sql.next;
  const count = body.readUInt16BE(o); o += 2;
  const parameterOids: number[] = [];
  for (let i = 0; i < count; i++, o += 4) parameterOids.push(body.readUInt32BE(o));
  return { name: name.value, sql: sql.value, parameterOids };
}

export interface BindMessage {
  portal: string;
  statement: string;
  parameterFormats: number[];
  parameterValues: Array<Buffer | null>;
  resultFormats: number[];
}
export function decodeBind(body: Buffer): BindMessage {
  const portal = readCString(body, 0);
  const stmt = readCString(body, portal.next);
  let o = stmt.next;
  const fmtCount = body.readUInt16BE(o); o += 2;
  const parameterFormats: number[] = [];
  for (let i = 0; i < fmtCount; i++, o += 2) parameterFormats.push(body.readUInt16BE(o));
  const nParams = body.readUInt16BE(o); o += 2;
  const parameterValues: Array<Buffer | null> = [];
  for (let i = 0; i < nParams; i++) {
    const len = body.readInt32BE(o); o += 4;
    if (len < 0) parameterValues.push(null);
    else { parameterValues.push(body.subarray(o, o + len)); o += len; }
  }
  const resultCount = body.readUInt16BE(o); o += 2;
  const resultFormats: number[] = [];
  for (let i = 0; i < resultCount; i++, o += 2) resultFormats.push(body.readUInt16BE(o));
  return { portal: portal.value, statement: stmt.value, parameterFormats, parameterValues, resultFormats };
}

export function decodeDescribe(body: Buffer): { target: 'S' | 'P'; name: string } {
  const target = String.fromCharCode(body.readUInt8(0)) as 'S' | 'P';
  return { target, name: readCString(body, 1).value };
}

export function decodeExecute(body: Buffer): { portal: string; maxRows: number } {
  const portal = readCString(body, 0);
  return { portal: portal.value, maxRows: body.readUInt32BE(portal.next) };
}

export function decodeClose(body: Buffer): { target: 'S' | 'P'; name: string } {
  const target = String.fromCharCode(body.readUInt8(0)) as 'S' | 'P';
  return { target, name: readCString(body, 1).value };
}

export function decodeQuery(body: Buffer): string { return readCString(body, 0).value; }

export function decodeParameterValue(buffer: Buffer | null, format: number, oid: number): unknown {
  if (buffer === null) return null;
  if (format === 0) {
    const text = buffer.toString('utf8');
    if (oid === OID.bytea) {
      throw Object.assign(new Error('bytea bind parameters are not supported by proxy v0.1; use a Db2-compatible textual/binary API after validation'), { sqlstate: '0A000' });
    }
    return text;
  }
  // Common binary encodings used by PostgreSQL drivers.
  if (oid === OID.bool) return buffer.readUInt8(0) !== 0 ? 1 : 0;
  if (oid === OID.int2) return buffer.readInt16BE(0);
  if (oid === OID.int4 || oid === OID.oid) return buffer.readInt32BE(0);
  if (oid === OID.int8) return buffer.readBigInt64BE(0).toString();
  if (oid === OID.float4) return buffer.readFloatBE(0);
  if (oid === OID.float8) return buffer.readDoubleBE(0);
  if (oid === OID.bytea) {
    throw Object.assign(new Error('Binary bytea bind parameters are not supported by proxy v0.1'), { sqlstate: '0A000' });
  }
  throw new Error(`Binary parameter format not supported for OID ${oid}`);
}
