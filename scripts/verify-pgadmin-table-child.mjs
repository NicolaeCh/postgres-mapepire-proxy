import assert from 'node:assert/strict';
import {
  classifyPgAdminTableChildQuery, renderColumnQuery, renderIndexQuery,
  renderEmptyTableChild, IBMI_COLUMN_CATALOG_SQL, IBMI_INDEX_CATALOG_SQL, IBMI_NATIVE_INDEX_CATALOG_SQL,
} from '../dist/src/sql/pgadmin-ibmi-table-child.js';
import { tableOid } from '../dist/src/sql/pgadmin-ibmi-table.js';

const tid = tableOid('MONAI','ORDERS');
assert.match(IBMI_COLUMN_CATALOG_SQL, /QSYS2\.SYSCOLUMNS2/);
assert.match(IBMI_INDEX_CATALOG_SQL, /QSYS2\.SYSINDEXES/);
assert.match(IBMI_NATIVE_INDEX_CATALOG_SQL, /QSYS2\.SYSTABLEINDEXSTAT/);
assert.match(IBMI_NATIVE_INDEX_CATALOG_SQL, /INDEX_TYPE IN \('INDEX', 'LOGICAL'\)/);
const columns = [
  { schema:'MONAI', table:'ORDERS', name:'ID', ordinal:1, dataType:'INTEGER', length:4, numericScale:null, numericPrecision:10, nullable:false, longComment:'Identity', text:null, hasDefault:'J', defaultValue:null, charMaxLength:null, datetimePrecision:null, identity:true, identityGeneration:'BY DEFAULT', expression:null },
  { schema:'MONAI', table:'ORDERS', name:'DESCRIPTION', ordinal:2, dataType:'VARCHAR', length:100, numericScale:null, numericPrecision:null, nullable:true, longComment:null, text:'Description', hasDefault:'N', defaultValue:null, charMaxLength:100, datetimePrecision:null, identity:false, identityGeneration:null, expression:null },
];
let req = classifyPgAdminTableChildQuery(`SELECT DISTINCT att.attname as name, att.attnum as OID,
pg_catalog.format_type(ty.oid,NULL) AS datatype, pg_catalog.format_type(ty.oid,att.atttypmod) AS displaytypname,
att.attnotnull as not_null, true as has_default_val, des.description, 0::oid as seqtypid
FROM pg_catalog.pg_attribute att JOIN pg_catalog.pg_type ty ON ty.oid=att.atttypid
WHERE att.attrelid = ${tid}::oid AND att.attnum > 0 AND NOT att.attisdropped`);
assert.equal(req?.kind,'columnNodes');
let result = renderColumnQuery(req, columns);
assert.deepEqual(result.fields.map((f)=>f.name), ['name','oid','datatype','displaytypname','not_null','has_default_val','description','seqtypid']);
assert.equal(result.rows.length,2);
for (const row of result.rows) assert.equal(row.length,result.fields.length);

// pgAdmin 9.16+ nodes.sql itself references attidentity while computing
// has_default_val. It must still classify as columnNodes, never properties.
req = classifyPgAdminTableChildQuery(`SELECT DISTINCT att.attname as name, att.attnum as OID,
pg_catalog.format_type(ty.oid,NULL) AS datatype, pg_catalog.format_type(ty.oid,att.atttypmod) AS displaytypname,
att.attnotnull as not_null, CASE WHEN att.atthasdef OR att.attidentity != '' OR ty.typdefault IS NOT NULL THEN True ELSE False END as has_default_val,
des.description, seq.seqtypid FROM pg_catalog.pg_attribute att JOIN pg_catalog.pg_type ty ON ty.oid=att.atttypid
LEFT JOIN pg_catalog.pg_sequence seq ON true WHERE att.attrelid = ${tid}::oid AND att.attnum > 0 AND att.attisdropped IS FALSE ORDER BY att.attnum`);
assert.equal(req?.kind,'columnNodes');
result = renderColumnQuery(req, columns);
assert.ok(result.fields.some((f)=>f.name==='oid'));

// The properties template is wider and should remain distinct from nodes.
req = classifyPgAdminTableChildQuery(`SELECT DISTINCT ON (att.attnum) att.attname as name, att.atttypid, att.attlen, att.attnum, att.attndims,
att.atttypmod, att.attnotnull, att.attidentity, CASE WHEN att.attidentity in ('a','d') THEN 'i' ELSE 'n' END AS colconstype,
CASE WHEN tab.relkind = 'v' THEN true ELSE false END AS is_view_only, att.attcompression
FROM pg_catalog.pg_attribute att JOIN pg_catalog.pg_type ty ON ty.oid=atttypid LEFT JOIN pg_catalog.pg_class tab ON tab.oid=att.attrelid
WHERE att.attrelid = ${tid}::oid AND att.attnum = 1::int AND att.attisdropped IS FALSE ORDER BY att.attnum`);
assert.equal(req?.kind,'columnProperties');
assert.equal(req?.columnNumber,1);
result = renderColumnQuery(req, columns);
assert.equal(result.rows.length,1);
assert.ok(result.fields.some((f)=>f.name==='atttypid'));


const indexes=[{schema:'MONAI',table:'ORDERS',indexSchema:'MONAI',name:'ORDERS_IX1',owner:'MAPESVC',unique:false,columnCount:1,longComment:null,text:'Order index',columns:['ID'],filterDefinition:null}];
req = classifyPgAdminTableChildQuery(`SELECT DISTINCT ON(cls.relname) cls.oid, cls.relname as name, false as is_inherited, des.description
FROM pg_catalog.pg_index idx JOIN pg_catalog.pg_class cls ON cls.oid=idx.indexrelid
WHERE indrelid = ${tid}::OID`);
assert.equal(req?.kind,'indexNodes');
result = renderIndexQuery(req,indexes,tid);
assert.deepEqual(result.fields.map((f)=>f.name),['oid','name','is_inherited','description']);
assert.equal(result.rows.length,1);

req = classifyPgAdminTableChildQuery(`SELECT count(*) FROM pg_catalog.pg_attribute att
WHERE att.attrelid = ${tid}::oid AND att.attnum > 0 AND NOT att.attisdropped`);
assert.equal(req?.kind,'columnCount');
result = renderColumnQuery(req, columns);
assert.deepEqual(result.fields.map((f)=>f.name), ['count']);
assert.deepEqual(result.rows, [[2]]);

req = classifyPgAdminTableChildQuery(`SELECT count(*) FROM pg_catalog.pg_index idx
WHERE idx.indrelid = ${tid}::oid`);
assert.equal(req?.kind,'indexCount');
result = renderIndexQuery(req, indexes, tid);
assert.deepEqual(result.fields.map((f)=>f.name), ['count']);
assert.deepEqual(result.rows, [[1]]);

req = classifyPgAdminTableChildQuery(`SELECT rel.oid, rel.relname AS name, 0 AS triggercount, false AS has_enable_triggers,
false AS is_partitioned, nsp.oid AS schema_id, nsp.nspname AS schema_name, des.description
FROM pg_catalog.pg_inherits inh JOIN pg_catalog.pg_class rel ON rel.oid=inh.inhrelid
JOIN pg_catalog.pg_namespace nsp ON nsp.oid=rel.relnamespace WHERE inh.inhparent=${tid}::oid`);
assert.equal(req?.kind,'partitionNodes');
result = renderEmptyTableChild(req);
assert.equal(result.rows.length,0);
assert.ok(result.fields.some((f)=>f.name==='oid'));
console.log('pgAdmin IBM i table child contract check OK');
