import { describe, expect, it } from 'vitest';
import {
  classifySqlAlchemyReflectionQuery,
  pgVisibleIdentifier,
  renderSqlAlchemyColumns,
  renderSqlAlchemyIndexes,
} from '../src/sql/sqlalchemy-reflection.js';
import type { IbmiColumnRow, IbmiIndexRow } from '../src/sql/pgadmin-ibmi-table-child.js';

describe('SQLAlchemy PostgreSQL reflection classifier', () => {
  it('recognizes get_table_names / has_table / get_columns / table OIDs', () => {
    expect(classifySqlAlchemyReflectionQuery(`SELECT pg_catalog.pg_class.relname
      FROM pg_catalog.pg_class JOIN pg_catalog.pg_namespace ON pg_catalog.pg_namespace.oid=pg_catalog.pg_class.relnamespace
      WHERE pg_catalog.pg_class.relkind = ANY (ARRAY[$1::VARCHAR,$2::VARCHAR])
      AND pg_catalog.pg_table_is_visible(pg_catalog.pg_class.oid)`)?.kind).toBe('relationNames');

    expect(classifySqlAlchemyReflectionQuery(`SELECT pg_catalog.pg_class.relname
      FROM pg_catalog.pg_class JOIN pg_catalog.pg_namespace ON pg_catalog.pg_namespace.oid=pg_catalog.pg_class.relnamespace
      WHERE pg_catalog.pg_class.relname=$1::VARCHAR
      AND pg_catalog.pg_class.relkind = ANY (ARRAY[$2::VARCHAR,$3::VARCHAR])`)?.kind).toBe('hasRelation');

    expect(classifySqlAlchemyReflectionQuery(`SELECT pg_catalog.pg_attribute.attname AS name,
      pg_catalog.format_type(pg_catalog.pg_attribute.atttypid,pg_catalog.pg_attribute.atttypmod) AS format_type,
      NULL AS default, pg_catalog.pg_attribute.attnotnull AS not_null,
      pg_catalog.pg_class.relname AS table_name, NULL AS comment,
      pg_catalog.pg_attribute.attgenerated AS generated, NULL AS identity_options, NULL AS collation
      FROM pg_catalog.pg_class LEFT JOIN pg_catalog.pg_attribute ON pg_catalog.pg_class.oid=pg_catalog.pg_attribute.attrelid`)?.kind).toBe('columns');

    expect(classifySqlAlchemyReflectionQuery(`SELECT pg_catalog.pg_class.oid, pg_catalog.pg_class.relname
      FROM pg_catalog.pg_class JOIN pg_catalog.pg_namespace ON pg_catalog.pg_namespace.oid=pg_catalog.pg_class.relnamespace
      WHERE pg_catalog.pg_class.relkind = ANY (ARRAY[$1::VARCHAR])`)?.kind).toBe('relationOids');
  });

  it('recognizes index, foreign-key and key-constraint reflection families', () => {
    expect(classifySqlAlchemyReflectionQuery(`SELECT pg_catalog.pg_index.indrelid, pg_catalog.pg_class.relname,
      pg_catalog.pg_index.indisunique, false AS has_constraint, pg_catalog.pg_index.indnkeyatts,
      idx_cols.elements, idx_cols.elements_is_expr, idx_cols.elements_opclass, idx_cols.elements_opdefault
      FROM pg_catalog.pg_index JOIN pg_catalog.pg_class ON pg_catalog.pg_index.indexrelid=pg_catalog.pg_class.oid`)?.kind).toBe('indexes');

    expect(classifySqlAlchemyReflectionQuery(`SELECT pg_catalog.pg_class.relname, pg_catalog.pg_constraint.conname,
      pg_catalog.pg_get_constraintdef(pg_catalog.pg_constraint.oid,true)
      FROM pg_catalog.pg_class LEFT JOIN pg_catalog.pg_constraint ON pg_catalog.pg_class.oid=pg_catalog.pg_constraint.conrelid`)?.kind).toBe('foreignKeys');

    expect(classifySqlAlchemyReflectionQuery(`SELECT attr.conrelid, array_agg(attr.attname ORDER BY attr.ord) AS cols,
      attr.conname, min(attr.indnkeyatts) AS indnkeyatts FROM
      (SELECT pg_catalog.pg_constraint.conrelid, pg_catalog.pg_constraint.conname,
       pg_catalog.pg_index.indnkeyatts FROM pg_catalog.pg_constraint JOIN pg_catalog.pg_index
       ON pg_catalog.pg_constraint.conindid=pg_catalog.pg_index.indexrelid) attr GROUP BY attr.conrelid, attr.conname`)?.kind).toBe('keyConstraints');
  });
});

describe('SQLAlchemy IBM i reflection rendering', () => {
  it('maps ordinary Db2 uppercase identifiers to PostgreSQL lowercase', () => {
    expect(pgVisibleIdentifier('A2A_AGENTS')).toBe('a2a_agents');
    expect(pgVisibleIdentifier('MixedCase')).toBe('MixedCase');
  });

  it('renders PostgreSQL type names from IBM i column metadata', () => {
    const rows: IbmiColumnRow[] = [
      column('ID', 1, 'VARCHAR', 36, false),
      column('VISIBILITY', 2, 'VARCHAR', 20, false),
      column('ENABLED', 3, 'BOOLEAN', 1, false),
    ];
    const result = renderSqlAlchemyColumns('A2A_AGENTS', rows);
    expect(result.rows.map((r) => [r[0], r[1]])).toEqual([
      ['id', 'character varying(36)'],
      ['visibility', 'character varying(20)'],
      ['enabled', 'boolean'],
    ]);
  });

  it('renders live index names and key columns', () => {
    const indexes: IbmiIndexRow[] = [{
      schema: 'MCPDATA', table: 'A2A_AGENTS', indexSchema: 'MCPDATA',
      name: 'IDX_A2A_AGENTS_VISIBILITY', owner: 'MAPESVC', unique: false,
      columnCount: 1, longComment: null, text: null, columns: ['VISIBILITY'], filterDefinition: null,
    }];
    const result = renderSqlAlchemyIndexes([{ tableOid: 12345, indexes }]);
    expect(result.rows[0]?.[1]).toBe('idx_a2a_agents_visibility');
    expect(result.rows[0]?.[10]).toBe('{"visibility"}');
  });
});

function column(name: string, ordinal: number, dataType: string, length: number, nullable: boolean): IbmiColumnRow {
  return {
    schema: 'MCPDATA', table: 'A2A_AGENTS', name, ordinal, dataType, length,
    numericScale: null, numericPrecision: null, nullable, longComment: null, text: null,
    hasDefault: 'N', defaultValue: null, charMaxLength: length, datetimePrecision: null,
    identity: false, identityGeneration: null, expression: null,
  };
}
