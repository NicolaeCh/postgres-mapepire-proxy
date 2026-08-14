import assert from 'node:assert/strict';
import { environmentQuery } from '../dist/src/sql/environment.js';
import { parseSearchPathCommand, parseSetConfigSearchPath, parseStartupSearchPath } from '../dist/src/sql/search-path.js';

const startup = parseStartupSearchPath('-csearch_path=MCPDATA,public');
assert.equal(startup?.schema, 'MCPDATA');
assert.deepEqual(startup?.ignored, ['public']);

const setPath = parseSearchPathCommand('SET search_path TO APPDATA, public', 'DEFAULT');
assert.equal(setPath?.schema, 'APPDATA');
assert.equal(setPath?.scope, 'session');

const setSchema = parseSearchPathCommand("SET SCHEMA 'MCPDATA'", 'DEFAULT');
assert.equal(setSchema?.schema, 'MCPDATA');

const setConfig = parseSetConfigSearchPath("SELECT set_config('search_path','appdata,public',false)", 'DEFAULT');
assert.equal(setConfig?.selection.schema, 'APPDATA');
assert.deepEqual(setConfig?.selection.ignored, ['public']);

const reset = parseSearchPathCommand('RESET search_path', 'DEFAULT');
assert.equal(reset?.schema, 'DEFAULT');
assert.equal(reset?.reset, true);

const env = (sql) => environmentQuery(sql, 'SEIDOR76', 'MCPDATA', '14.0');
assert.deepEqual(env('SHOW search_path')?.rows, [['MCPDATA']]);
assert.deepEqual(env('SELECT current_schema()')?.rows, [['MCPDATA']]);
assert.deepEqual(env('SELECT current_schema')?.rows, [['MCPDATA']]);
assert.deepEqual(env("SELECT current_setting('search_path')")?.rows, [['MCPDATA']]);
assert.deepEqual(env('SELECT current_schemas(false)')?.rows, [['{"MCPDATA"}']]);
assert.deepEqual(env('SELECT current_schemas(true)')?.rows, [['{"pg_catalog","MCPDATA"}']]);

console.log('PostgreSQL search_path / IBM i CURRENT SCHEMA compatibility check OK');
