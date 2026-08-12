import assert from 'node:assert/strict';
import {
  classifyPgAdminTableChildQuery, renderColumnQuery, renderIndexQuery,
  renderEmptyTableChild, IBMI_COLUMN_CATALOG_SQL, IBMI_INDEX_CATALOG_SQL,
} from '../dist/src/sql/pgadmin-ibmi-table-child.js';
import { tableOid } from '../dist/src/sql/pgadmin-ibmi-table.js';

const tid = tableOid('MONAI','ORDERS');
assert.match(IBMI_COLUMN_CATALOG_SQL, /QSYS2\.SYSCOLUMNS2/);
assert.match(IBMI_INDEX_CATALOG_SQL, /QSYS2\.SYSINDEXES/);
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

const indexes=[{schema:'MONAI',table:'ORDERS',indexSchema:'MONAI',name:'ORDERS_IX1',owner:'MAPESVC',unique:false,columnCount:1,longComment:null,text:'Order index'}];
req = classifyPgAdminTableChildQuery(`SELECT DISTINCT ON(cls.relname) cls.oid, cls.relname as name, false as is_inherited, des.description
FROM pg_catalog.pg_index idx JOIN pg_catalog.pg_class cls ON cls.oid=idx.indexrelid
WHERE indrelid = ${tid}::OID`);
assert.equal(req?.kind,'indexNodes');
result = renderIndexQuery(req,indexes,tid);
assert.deepEqual(result.fields.map((f)=>f.name),['oid','name','is_inherited','description']);
assert.equal(result.rows.length,1);

req = classifyPgAdminTableChildQuery(`SELECT rel.oid, rel.relname AS name, 0 AS triggercount, false AS has_enable_triggers,
false AS is_partitioned, nsp.oid AS schema_id, nsp.nspname AS schema_name, des.description
FROM pg_catalog.pg_inherits inh JOIN pg_catalog.pg_class rel ON rel.oid=inh.inhrelid
JOIN pg_catalog.pg_namespace nsp ON nsp.oid=rel.relnamespace WHERE inh.inhparent=${tid}::oid`);
assert.equal(req?.kind,'partitionNodes');
result = renderEmptyTableChild(req);
assert.equal(result.rows.length,0);
assert.ok(result.fields.some((f)=>f.name==='oid'));
console.log('pgAdmin IBM i table child contract check OK');
