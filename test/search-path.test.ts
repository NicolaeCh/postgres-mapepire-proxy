import { describe, expect, it } from 'vitest';
import { parseSearchPathCommand, parseSetConfigSearchPath, parseStartupSearchPath, splitSearchPath } from '../src/sql/search-path.js';

describe('PostgreSQL search_path compatibility', () => {
  it('parses PostgreSQL startup options used by libpq/psycopg', () => {
    expect(parseStartupSearchPath('-csearch_path=MCPDATA')?.schema).toBe('MCPDATA');
    expect(parseStartupSearchPath('-c search_path=appdata,public')).toMatchObject({
      schema: 'APPDATA',
      requested: ['appdata', 'public'],
      ignored: ['public'],
    });
    expect(parseStartupSearchPath("-csearch_path='appdata,public'")?.schema).toBe('APPDATA');
  });

  it('preserves quoted schema case and ignores PostgreSQL implicit entries', () => {
    expect(splitSearchPath('"MiXeD", public')).toEqual(['"MiXeD"', 'public']);
    expect(parseSearchPathCommand('SET search_path TO pg_catalog, "MiXeD", public', 'DEFAULT')).toMatchObject({
      schema: 'MiXeD',
      ignored: ['pg_catalog', 'public'],
    });
  });

  it('supports SET SCHEMA and reset semantics', () => {
    expect(parseSearchPathCommand("SET SCHEMA 'mcpdata'", 'DEFAULT')?.schema).toBe('mcpdata');
    expect(parseSearchPathCommand('RESET search_path', 'DEFAULT')).toMatchObject({ schema: 'DEFAULT', reset: true });
    expect(parseSearchPathCommand('SET search_path TO DEFAULT', 'DEFAULT')).toMatchObject({ schema: 'DEFAULT', reset: true });
  });

  it("supports set_config('search_path', ...) used by drivers/frameworks", () => {
    expect(parseSetConfigSearchPath("SELECT set_config('search_path','appdata,public',false)", 'DEFAULT')).toMatchObject({
      selection: { schema: 'APPDATA', scope: 'session', ignored: ['public'] },
      fieldName: 'set_config',
    });
    expect(parseSetConfigSearchPath("SELECT pg_catalog.set_config('search_path','mcpdata',true) AS applied", 'DEFAULT')).toMatchObject({
      selection: { schema: 'MCPDATA', scope: 'local' },
      fieldName: 'applied',
    });
  });

  it('tracks SET LOCAL scope', () => {
    expect(parseSearchPathCommand('SET LOCAL search_path TO mcpdata', 'DEFAULT')).toMatchObject({
      schema: 'MCPDATA',
      scope: 'local',
    });
  });
});
