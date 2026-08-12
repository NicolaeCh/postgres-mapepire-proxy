import assert from 'node:assert/strict';
import {
  IBMI_VIEW_CATALOG_SQL, classifyPgAdminIbmiViewQuery, renderPgAdminIbmiViewQuery, viewOid,
} from '../dist/src/sql/pgadmin-ibmi-view.js';
import { classifyPgAdminIbmiTableQuery } from '../dist/src/sql/pgadmin-ibmi-table.js';

const scid = 1812345678;
const views = [{
  schema:'MONAI', name:'ACTIVE_ORDERS', owner:'MAPESVC', text:'Active orders', longComment:null,
  columnCount:3, definition:"SELECT ORDERKEY, STATUS FROM MONAI.ORDERS WHERE STATUS = 'A'", checkOption:null,
}];
assert.match(IBMI_VIEW_CATALOG_SQL, /QSYS2\.SYSTABLES/);
assert.match(IBMI_VIEW_CATALOG_SQL, /TABLE_TYPE = 'V'/);
assert.match(IBMI_VIEW_CATALOG_SQL, /QSYS2\.SYSVIEWS/);
assert.match(IBMI_VIEW_CATALOG_SQL, /VIEW_DEFINITION/);

let sql = `SELECT COUNT(*) FROM pg_catalog.pg_class c WHERE c.relkind = 'v'::"char" AND c.relnamespace = ${scid}::oid`;
let req = classifyPgAdminIbmiViewQuery(sql);
assert.equal(req?.kind, 'count');
let result = renderPgAdminIbmiViewQuery(req, views);
assert.deepEqual(result.rows, [[1]]);

sql = `SELECT c.oid, c.relname AS name, description AS comment FROM pg_catalog.pg_class c
WHERE c.relkind = 'v' AND c.relnamespace = ${scid}::oid ORDER BY c.relname`;
req = classifyPgAdminIbmiViewQuery(sql);
assert.equal(req?.kind, 'nodes');
result = renderPgAdminIbmiViewQuery(req, views);
assert.deepEqual(result.rows, [[viewOid('MONAI','ACTIVE_ORDERS'),'ACTIVE_ORDERS','Active orders']]);
assert.equal(classifyPgAdminIbmiTableQuery(sql), undefined);

const vid = viewOid('MONAI','ACTIVE_ORDERS');
sql = `SELECT c.oid, c.relkind, c.relname AS name, pg_catalog.pg_get_viewdef(c.oid, true) AS definition,
c.relispopulated AS ispopulated FROM pg_catalog.pg_class c WHERE c.relkind='v'::char AND c.oid=${vid}::oid`;
req = classifyPgAdminIbmiViewQuery(sql);
assert.equal(req?.kind, 'properties');
result = renderPgAdminIbmiViewQuery(req, views);
const def = result.fields.findIndex((f)=>f.name==='definition');
assert.match(String(result.rows[0][def]), /SELECT ORDERKEY/);
console.log('pgAdmin IBM i view contract check OK');
