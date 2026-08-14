export const OID = {
  bool: 16,
  bytea: 17,
  char: 18,
  name: 19,
  int8: 20,
  int2: 21,
  int4: 23,
  text: 25,
  oid: 26,
  json: 114,
  float4: 700,
  float8: 701,
  bpchar: 1042,
  varchar: 1043,
  date: 1082,
  time: 1083,
  timestamp: 1114,
  numeric: 1700,
  nameArray: 1003,
  textArray: 1009,
} as const;

export interface PgType {
  oid: number;
  name: string;
  size: number;
}

export function db2TypeToPg(type: string, precision = 0): PgType {
  const t = type.toUpperCase().trim();
  if (t === 'BOOLEAN') return { oid: OID.bool, name: 'bool', size: 1 };
  if (t === 'SMALLINT') return { oid: OID.int2, name: 'int2', size: 2 };
  if (['INTEGER', 'INT'].includes(t)) return { oid: OID.int4, name: 'int4', size: 4 };
  if (t === 'BIGINT') return { oid: OID.int8, name: 'int8', size: 8 };
  if (['DECIMAL', 'NUMERIC', 'DECFLOAT'].some((x) => t === x || t.startsWith(`${x}(`))) return { oid: OID.numeric, name: 'numeric', size: -1 };
  if (t === 'REAL') return { oid: OID.float4, name: 'float4', size: 4 };
  if (['FLOAT', 'DOUBLE', 'DOUBLE PRECISION'].includes(t)) return { oid: OID.float8, name: 'float8', size: 8 };
  if (t === 'DATE') return { oid: OID.date, name: 'date', size: 4 };
  if (t === 'TIME') return { oid: OID.time, name: 'time', size: 8 };
  if (t.startsWith('TIMESTAMP')) return { oid: OID.timestamp, name: 'timestamp', size: 8 };
  if (['BLOB', 'BINARY', 'VARBINARY', 'FOR BIT DATA'].some((x) => t.includes(x))) {
    return { oid: OID.bytea, name: 'bytea', size: -1 };
  }
  // PostgreSQL OID 18 is the internal single-byte "char" type, not SQL CHAR(n).
  // Db2 CHAR maps to PostgreSQL bpchar (OID 1042).
  if (t.startsWith('CHAR')) return { oid: OID.bpchar, name: 'bpchar', size: -1 };
  if (t.includes('CLOB') || t.includes('GRAPHIC') || t.includes('XML')) return { oid: OID.text, name: 'text', size: -1 };
  if (t.includes('VARCHAR')) return { oid: OID.varchar, name: 'varchar', size: -1 };
  return { oid: OID.text, name: 'text', size: -1 };
}

export const syntheticPgTypes = [
  { oid: 16, typname: 'bool', typlen: 1 },
  { oid: 17, typname: 'bytea', typlen: -1 },
  { oid: 18, typname: 'char', typlen: 1 },
  { oid: 20, typname: 'int8', typlen: 8 },
  { oid: 21, typname: 'int2', typlen: 2 },
  { oid: 23, typname: 'int4', typlen: 4 },
  { oid: 25, typname: 'text', typlen: -1 },
  { oid: 26, typname: 'oid', typlen: 4 },
  { oid: 700, typname: 'float4', typlen: 4 },
  { oid: 701, typname: 'float8', typlen: 8 },
  { oid: 1042, typname: 'bpchar', typlen: -1 },
  { oid: 1043, typname: 'varchar', typlen: -1 },
  { oid: 1082, typname: 'date', typlen: 4 },
  { oid: 1083, typname: 'time', typlen: 8 },
  { oid: 1114, typname: 'timestamp', typlen: 8 },
  { oid: 1700, typname: 'numeric', typlen: -1 },
] as const;
