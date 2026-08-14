import type { QueryResult, ColumnMetaData } from '@ibm/mapepire-js';
import { createHash } from 'node:crypto';
import type { SQLJobInstance } from '../mapepire/sdk.js';
import type { IbmiSchemaCapabilities } from '../mapepire/schema-capabilities.js';
import type { PostgresConnection } from 'pg-gateway';
import { config } from '../config.js';
import { Logger } from '../logger.js';
import { SessionJobPool } from '../mapepire/session-pool.js';
import { db2TypeToPg, OID } from '../postgres/oids.js';
import {
  bindComplete, closeComplete, commandComplete, dataRow, decodeBind, decodeClose,
  decodeDescribe, decodeExecute, decodeParameterValue, decodeParse, decodeQuery,
  emptyQueryResponse, errorResponse, noData, parameterDescription, parseComplete,
  readyForQuery, rowDescription, consumeFrontendMessages, type FieldDescription,
} from '../postgres/wire.js';
import { syntheticCatalog } from '../sql/catalog.js';
import { classify, isIdempotentRead, type StatementKind } from '../sql/classifier.js';
import { environmentQuery, type SyntheticResult } from '../sql/environment.js';
import { parseSearchPathCommand, parseSetConfigSearchPath, parseStartupSearchPath, type SearchPathSelection } from '../sql/search-path.js';
import { containsUnhandledPostgresSystemSql, pgAdminCompatibilityQuery } from '../sql/pgadmin.js';
import {
  classifyPgAdminIbmiSchemaQuery,
  isPgSchemaComment,
  isPgSchemaPrivilegeDdl,
  planPgCreateSchema,
  renderPgAdminIbmiSchemaQuery,
  schemaOid as schemaOidForSession,
  findSchemaByCompatibleOid,
  type CreateSchemaPlan,
  type IbmiSchemaRow,
} from '../sql/pgadmin-ibmi.js';
import {
  classifyPgAdminIbmiTableQuery,
  IBMI_TABLE_CATALOG_SQL,
  isBasicPgTableCommentDdl,
  isPgCreateTable,
  parsePgTableOwnerDdl,
  renderPgAdminIbmiTableQuery,
  registerIbmiTables, lookupRegisteredIbmiTable, tableOid,
  type IbmiTableRow,
} from '../sql/pgadmin-ibmi-table.js';
import {
  classifyPgAdminTableChildQuery, IBMI_COLUMN_CATALOG_SQL, IBMI_INDEX_CATALOG_SQL, IBMI_NATIVE_INDEX_CATALOG_SQL,
  renderColumnQuery, renderIndexQuery, renderEmptyTableChild,
  type IbmiColumnRow, type IbmiIndexRow,
} from '../sql/pgadmin-ibmi-table-child.js';
import {
  classifyPgAdminIbmiViewQuery, IBMI_VIEW_CATALOG_SQL, renderPgAdminIbmiViewQuery,
  registerIbmiViews, lookupRegisteredIbmiView,
  type IbmiViewRow,
} from '../sql/pgadmin-ibmi-view.js';
import { parsePgReturning, reorderParameters, translateSql, type Translation } from '../sql/translator.js';
import { decideLobIndexCompatibility, parsePgSimpleCreateIndex, type LobIndexColumnType } from '../sql/lob-index.js';
import { DdlForeignKeyTypeRegistry } from '../sql/ddl-foreign-key.js';
import { DdlTableDefinitionRegistry, parsePgAlterTableRenameColumn, type ColumnRenamePlan } from '../sql/column-rename.js';
import { parsePgSavepointCommand, savepointCommandTag, translatePgSavepointToDb2 } from '../sql/transactions.js';
import { parsePgDeallocate } from '../sql/prepared-control.js';
import {
  executePgAdvisoryLockQuery, parsePgAdvisoryLockQuery, pgAdvisoryLockFields, releaseAllPgAdvisoryLocks,
} from '../sql/advisory-lock.js';
import {
  classifySqlAlchemyReflectionQuery,
  IBMI_FOREIGN_KEY_CATALOG_SQL,
  IBMI_KEY_CONSTRAINT_CATALOG_SQL,
  pgVisibleIdentifier,
  renderSqlAlchemyColumns,
  renderSqlAlchemyForeignKeys,
  renderSqlAlchemyHasRelation,
  renderSqlAlchemyIndexes,
  renderSqlAlchemyKeyConstraints,
  renderSqlAlchemyRelationNames,
  renderSqlAlchemyRelationOid,
  renderSqlAlchemyRelationOids,
  requestedConstraintType,
  requestedObjectNames,
  requestedRelationKinds,
  requestedVirtualOids,
  type IbmiForeignKeyRow,
  type IbmiKeyConstraintRow,
  type SqlAlchemyReflectionRequest,
} from '../sql/sqlalchemy-reflection.js';

type SchemaSource = 'proxy-default' | 'startup-options' | 'set-search-path' | 'set-local-search-path';

interface PreparedStatement { sql: string; parameterOids: number[]; translation?: Translation; }
interface BufferedDb2Execution {
  translation: Translation;
  result: QueryResult<Record<string, unknown>>;
}
interface Portal {
  statementName: string;
  parameters: unknown[];
  resultFormats: number[];
  descriptionSent: boolean;
  synthetic?: SyntheticResult;
  bufferedDb2?: BufferedDb2Execution;
}


export interface ClientInfo { user?: string; database?: string; applicationName?: string; backendPid?: number; options?: string; }

export class ProxySession {
  private job?: SQLJobInstance;
  private prepared = new Map<string, PreparedStatement>();
  private portals = new Map<string, Portal>();
  private inTransaction = false;
  private transactionFailed = false;
  private closed = false;
  private chain: Promise<void> = Promise.resolve();
  private extendedError = false;
  private currentSchema = config.ibmi.currentSchema;
  private backendCurrentSchema?: string;
  private currentSchemaCapabilities?: IbmiSchemaCapabilities;
  private schemaSource: SchemaSource = 'proxy-default';
  private localSchemaRestore?: { schema: string; source: SchemaSource; capabilities?: IbmiSchemaCapabilities };
  private schemaCache?: { expiresAt: number; rows: IbmiSchemaRow[] };
  private readonly ddlForeignKeyTypes = new DdlForeignKeyTypeRegistry();
  private readonly ddlTableDefinitions = new DdlTableDefinitionRegistry();
  // Keep the TCP accumulation buffer typed as Uint8Array. Node 24's Buffer
  // definitions parameterize the backing ArrayBuffer type, and mixing buffers
  // returned by concat/subarray can otherwise produce Buffer<ArrayBuffer> vs
  // Buffer<ArrayBufferLike> assignment errors during TypeScript compilation.
  private frontendBuffer: Uint8Array = new Uint8Array(0);

  constructor(
    private readonly connection: PostgresConnection,
    private readonly pool: SessionJobPool,
    private readonly client: ClientInfo,
    private readonly logger: Logger,
  ) {}

  async initialize(): Promise<void> {
    this.job = await this.pool.acquire();

    const startupPath = parseStartupSearchPath(this.client.options);
    if (startupPath) {
      this.currentSchemaCapabilities = await this.pool.prepareSchema(this.currentJob(), startupPath.schema);
      await this.currentJob().execute(`SET CURRENT SCHEMA ${quoteDb2Identifier(startupPath.schema)}`);
      this.currentSchema = startupPath.schema;
      this.schemaSource = 'startup-options';
      if (startupPath.ignored.length > 0) {
        this.logger.warn('PostgreSQL startup search_path contains additional schemas; proxy uses first concrete schema as IBM i CURRENT SCHEMA', {
          database: this.client.database,
          effectiveSchema: startupPath.schema,
          ignoredSearchPathEntries: startupPath.ignored,
        });
      }
    } else {
      this.currentSchemaCapabilities = await this.pool.prepareSchema(this.currentJob(), this.currentSchema);
    }
    await this.currentJob().execute('COMMIT');
    this.backendCurrentSchema = await this.readBackendCurrentSchema();
    if (this.backendCurrentSchema && !sameSqlIdentifier(this.backendCurrentSchema, this.currentSchema)) {
      throw new Error(`IBM i CURRENT SCHEMA mismatch: expected ${this.currentSchema}, backend reports ${this.backendCurrentSchema}`);
    }

    this.logger.debug('Mapepire job leased to PostgreSQL session', {
      user: this.client.user,
      database: this.client.database,
      currentSchema: this.currentSchema,
      backendCurrentSchema: this.backendCurrentSchema,
      schemaSource: this.schemaSource,
      schemaCapabilities: this.currentSchemaCapabilities,
    });
  }

  schemaContext(): { currentSchema: string; backendCurrentSchema?: string; schemaSource: string; capabilities?: IbmiSchemaCapabilities } {
    return {
      currentSchema: this.currentSchema,
      backendCurrentSchema: this.backendCurrentSchema,
      schemaSource: this.schemaSource,
      capabilities: this.currentSchemaCapabilities ? { ...this.currentSchemaCapabilities } : undefined,
    };
  }

  handleRaw(data: Uint8Array): Promise<void> {
    this.chain = this.chain.then(async () => {
      this.frontendBuffer = Buffer.concat([this.frontendBuffer, Buffer.from(data)]);
      const parsed = consumeFrontendMessages(this.frontendBuffer, config.pg.maxFrontendMessageBytes);
      this.frontendBuffer = parsed.remainder;
      for (const msg of parsed.messages) {
        if (config.pg.protocolTrace) {
          this.logger.info('PostgreSQL frontend protocol message', {
            type: frontendMessageName(msg.type),
            applicationName: this.client.applicationName,
            database: this.client.database,
          });
        }
        // PostgreSQL extended-query protocol requires the backend to ignore
        // messages after an error until Sync (or Terminate) arrives.
        if (this.extendedError && msg.type !== 'S' && msg.type !== 'X') continue;
        try {
          await this.handleMessage(msg.type, msg.body);
        } catch (error) {
          await this.handleUnexpected(error);
          if (msg.type === 'Q') {
            this.send(readyForQuery(this.txStatus()));
          } else if (msg.type !== 'X') {
            this.extendedError = true;
          }
        }
      }
    }).catch(async (error) => {
      // Last-resort protection for framing/transport bugs outside a single
      // frontend command. Keep the promise chain usable for later messages.
      await this.handleUnexpected(error);
    });
    return this.chain;
  }

  private send(buffer: Buffer): void { this.connection.sendData(buffer); }
  private txStatus(): 'I' | 'T' | 'E' { return this.transactionFailed ? 'E' : this.inTransaction ? 'T' : 'I'; }

  private async handleMessage(type: string, body: Buffer): Promise<void> {
    if (this.closed) return;
    switch (type) {
      case 'Q': await this.simpleQuery(decodeQuery(body)); break;
      case 'P': this.parse(body); break;
      case 'B': this.bind(body); break;
      case 'D': await this.describe(body); break;
      case 'E': await this.executePortal(body); break;
      case 'S': this.extendedError = false; this.send(readyForQuery(this.txStatus())); break;
      case 'C': this.closePrepared(body); break;
      case 'H': break; // Flush: responses are sent immediately.
      case 'X': await this.close(); break;
      default:
        this.send(errorResponse({ code: '0A000', message: `Frontend message ${type} is not supported` }));
    }
  }

  private parse(body: Buffer): void {
    const p = decodeParse(body);
    this.prepared.set(p.name, { sql: p.sql, parameterOids: p.parameterOids });
    this.send(parseComplete());
  }

  private bind(body: Buffer): void {
    const b = decodeBind(body);
    const stmt = this.prepared.get(b.statement);
    if (!stmt) throw sqlError('26000', `Prepared statement ${b.statement} does not exist`);
    if (b.resultFormats.some((f) => f === 1)) throw sqlError('0A000', 'Binary result format is not supported; request text results');
    const formats = normalizeFormats(b.parameterFormats, b.parameterValues.length);
    const values = b.parameterValues.map((v, i) => decodeParameterValue(v, formats[i] ?? 0, stmt.parameterOids[i] ?? 0));
    this.portals.set(b.portal, {
      statementName: b.statement,
      parameters: values,
      resultFormats: b.resultFormats,
      descriptionSent: false,
    });
    this.send(bindComplete());
  }

  private async describe(body: Buffer): Promise<void> {
    const d = decodeDescribe(body);
    if (d.target === 'S') {
      const stmt = this.prepared.get(d.name);
      if (!stmt) throw sqlError('26000', `Prepared statement ${d.name} does not exist`);
      this.send(parameterDescription(stmt.parameterOids));

      const advisoryLock = parsePgAdvisoryLockQuery(stmt.sql);
      if (advisoryLock) {
        this.send(rowDescription(pgAdvisoryLockFields(advisoryLock)));
        return;
      }

      const setConfigSearchPath = parseSetConfigSearchPath(stmt.sql, config.ibmi.currentSchema);
      if (setConfigSearchPath) {
        this.send(rowDescription([{ name: setConfigSearchPath.fieldName, typeOid: OID.text, typeSize: -1 }]));
        return;
      }

      const local = await this.resolveSynthetic(stmt.sql);
      if (local) {
        this.validateSynthetic(local);
        if (local.fields.length) this.send(rowDescription(local.fields));
        else this.send(noData());
        return;
      }

      const returningFields = this.returningFields(stmt.sql);
      if (returningFields) {
        this.send(rowDescription(returningFields));
        return;
      }

      // A statement-level Describe happens before Bind, so Mapepire cannot
      // provide exact metadata for parameterized Db2 queries. pgAdmin/psycopg3
      // describes the bound portal instead (P), which is handled below.
      // Commands that cannot return rows may still be described accurately.
      if (!statementMayReturnRows(classify(stmt.sql))) {
        this.send(noData());
        return;
      }

      throw sqlError(
        '0A000',
        'Statement-level Describe for Db2 rowsets is not supported; bind and Describe a portal instead',
      );
    }

    const portal = this.portals.get(d.name);
    if (!portal) throw sqlError('34000', `Portal ${d.name} does not exist`);
    const stmt = this.prepared.get(portal.statementName);
    if (!stmt) throw sqlError('26000', `Prepared statement ${portal.statementName} does not exist`);

    const advisoryLock = parsePgAdvisoryLockQuery(stmt.sql);
    if (advisoryLock) {
      portal.descriptionSent = true;
      this.send(rowDescription(pgAdvisoryLockFields(advisoryLock)));
      return;
    }

    const setConfigSearchPath = parseSetConfigSearchPath(stmt.sql, config.ibmi.currentSchema);
    if (setConfigSearchPath) {
      portal.descriptionSent = true;
      this.send(rowDescription([{ name: setConfigSearchPath.fieldName, typeOid: OID.text, typeSize: -1 }]));
      return;
    }

    const local = await this.resolveSynthetic(stmt.sql, portal.parameters);
    if (local) {
      this.validateSynthetic(local);
      portal.synthetic = local;
      portal.descriptionSent = true;
      if (local.fields.length) this.send(rowDescription(local.fields));
      else this.send(noData());
      return;
    }


    const returningFields = this.returningFields(stmt.sql);
    if (returningFields) {
      portal.descriptionSent = true;
      this.send(rowDescription(returningFields));
      return;
    }

    const kind = classify(stmt.sql);
    if (!statementMayReturnRows(kind)) {
      portal.descriptionSent = true;
      this.send(noData());
      return;
    }

    // Mapepire exposes result metadata only when a query is executed. To bridge
    // that API to PostgreSQL's portal Describe contract, materialize read-only
    // rowsets once at Describe time, retain the result, and send only DataRow /
    // CommandComplete when Execute arrives. This is intentionally limited to
    // read-only statement kinds; writes are never executed during Describe.
    portal.bufferedDb2 = await this.materializeReadPortal(stmt.sql, portal.parameters);
    portal.descriptionSent = true;
    const fields = mapepireFields(portal.bufferedDb2.result);
    if (portal.bufferedDb2.result.has_results) this.send(rowDescription(fields));
    else this.send(noData());
  }

  private closePrepared(body: Buffer): void {
    const c = decodeClose(body);
    if (c.target === 'S') this.prepared.delete(c.name);
    else this.portals.delete(c.name);
    this.send(closeComplete());
  }

  private async executePortal(body: Buffer): Promise<void> {
    const e = decodeExecute(body);
    const portal = this.portals.get(e.portal);
    if (!portal) throw sqlError('34000', `Portal ${e.portal} does not exist`);
    const stmt = this.prepared.get(portal.statementName);
    if (!stmt) throw sqlError('26000', `Prepared statement ${portal.statementName} does not exist`);

    if (portal.synthetic) {
      this.sendSynthetic(portal.synthetic, !portal.descriptionSent);
      return;
    }
    if (portal.bufferedDb2) {
      const { result, translation } = portal.bufferedDb2;
      if (result.has_results) this.sendMapepireRows(result, e.maxRows, !portal.descriptionSent);
      this.send(commandComplete(commandTag(translation.kind, result)));
      return;
    }

    await this.executeSql(stmt.sql, portal.parameters, e.maxRows, !portal.descriptionSent);
  }

  private async simpleQuery(sql: string): Promise<void> {
    if (!sql.trim()) { this.send(emptyQueryResponse()); this.send(readyForQuery(this.txStatus())); return; }

    // pgAdmin may send several harmless PostgreSQL session-initialization
    // statements in one Simple Query message. General multi-statement SQL
    // remains disabled; this exception is allowed only when every statement is
    // answered locally and none reaches IBM i.
    const batch = splitSimpleStatements(sql);
    if (batch.length > 1) {
      const synthetic: SyntheticResult[] = [];
      for (const statement of batch) {
        const result = await this.resolveSynthetic(statement);
        if (!result) {
          // pgAdmin can emit a CREATE SCHEMA plus optional schema-related DDL in
          // one Simple Query message. Execute these one-by-one so PostgreSQL's
          // semicolon batching does not leak into the Db2 translator. Unsupported
          // ACL/comment clauses then fail with a precise feature error rather
          // than the generic multi-statement error.
          if (batch.some((item) => planPgCreateSchema(item))) {
            // pgAdmin may append COMMENT/ACL/default-privilege/security-label
            // statements to CREATE SCHEMA. Those PostgreSQL metadata semantics
            // are not safely mappable to the IBM i service-user authority model.
            // Reject the entire batch *before* creating the schema so pgAdmin
            // cannot report failure after a partially successful DDL operation.
            if (batch.some((item) => isPgSchemaComment(item) || isPgSchemaPrivilegeDdl(item))) {
              throw sqlError(
                '0A000',
                'pgAdmin schema Comment/Privileges/Default privileges/Security labels are not supported by the IBM i service-user proxy; leave those fields empty and retry',
              );
            }
            for (const item of batch) await this.executeSql(item, [], 0);
            this.send(readyForQuery(this.txStatus()));
            return;
          }

          if (batch.some((item) => isPgCreateTable(item))) {
            // pgAdmin commonly appends ALTER TABLE .. OWNER TO after CREATE.
            // Ownership cannot be mapped to the PostgreSQL login because IBM i
            // uses the configured Mapepire service profile.  Accept only a
            // tightly-scoped DDL batch: CREATE TABLE + virtual OWNER + basic
            // table/column COMMENT statements. Reject everything else before
            // creating the table to avoid partial-success GUI operations.
            const supported = batch.every((item) =>
              isPgCreateTable(item) || parsePgTableOwnerDdl(item) !== undefined || isBasicPgTableCommentDdl(item));
            if (!supported) {
              throw sqlError(
                '0A000',
                'pgAdmin table batch contains PostgreSQL-only table options not supported by the IBM i service-user proxy; create the table without privileges, security labels, row security, storage or PostgreSQL table options',
              );
            }
            for (const item of batch) await this.executeSql(item, [], 0);
            this.send(readyForQuery(this.txStatus()));
            return;
          }
          // Fall through to the normal path, which will enforce
          // SQL_ALLOW_MULTI_STATEMENT and reject unsafe/general batches.
          await this.executeSql(sql, [], 0);
          this.send(readyForQuery(this.txStatus()));
          return;
        }
        synthetic.push(result);
      }
      for (const result of synthetic) this.sendSynthetic(result);
      this.send(readyForQuery(this.txStatus()));
      return;
    }

    await this.executeSql(sql, [], 0);
    this.send(readyForQuery(this.txStatus()));
  }

  private async executeSql(sql: string, parameters: unknown[], maxRows: number, includeDescription = true): Promise<void> {
    const createSchema = planPgCreateSchema(sql);
    if (createSchema) {
      await this.executeCreateSchema(createSchema);
      this.send(commandComplete('CREATE SCHEMA'));
      return;
    }
    if (isPgSchemaComment(sql)) {
      throw sqlError(
        '0A000',
        'COMMENT ON SCHEMA is a PostgreSQL metadata feature with no direct Db2 for i equivalent in this service-user proxy; create the schema without a pgAdmin Comment value',
      );
    }
    if (isPgSchemaPrivilegeDdl(sql)) {
      throw sqlError(
        '0A000',
        'PostgreSQL schema GRANT/REVOKE/default privileges are not mapped to IBM i profiles when Mapepire uses a service user',
      );
    }

    const tableOwner = parsePgTableOwnerDdl(sql);
    if (tableOwner) {
      this.logger.debug('Mapping PostgreSQL table owner to Mapepire service-user ownership', {
        table: tableOwner.table,
        requestedPostgresOwner: tableOwner.requestedOwner,
        ibmiServiceUser: config.ibmi.user,
      });
      this.send(commandComplete('ALTER TABLE'));
      return;
    }

    const savepoint = parsePgSavepointCommand(sql);
    if (savepoint) {
      if (!this.inTransaction) {
        throw sqlError('25P01', 'SAVEPOINT can only be used in transaction blocks');
      }
      if (this.transactionFailed && savepoint.action !== 'rollbackTo') {
        throw sqlError('25P02', 'Current transaction is aborted, commands ignored until end of transaction block');
      }

      const db2Sql = translatePgSavepointToDb2(savepoint);
      try {
        await this.currentJob().execute(db2Sql);
        // PostgreSQL ROLLBACK TO SAVEPOINT recovers an aborted transaction and
        // leaves the outer transaction active. Db2 preserves the target
        // savepoint, allowing psycopg to RELEASE it immediately afterwards.
        if (savepoint.action === 'rollbackTo') this.transactionFailed = false;
        this.logger.info('PostgreSQL savepoint mapped to IBM i', {
          action: savepoint.action,
          savepoint: savepoint.name,
          database: this.client.database,
        });
      } catch (error) {
        this.transactionFailed = true;
        const mapped = mapDb2Error(error) as Error & { proxySql?: string };
        mapped.proxySql = sql;
        throw mapped;
      }
      this.send(commandComplete(savepointCommandTag(savepoint.action)));
      return;
    }

    const rawKind = classify(sql);
    if (this.transactionFailed && rawKind !== 'rollback' && rawKind !== 'commit') {
      throw sqlError('25P02', 'Current transaction is aborted, commands ignored until end of transaction block');
    }

    if (rawKind === 'begin') {
      this.inTransaction = true;
      this.transactionFailed = false;
      this.ddlForeignKeyTypes.beginTransaction();
      this.ddlTableDefinitions.beginTransaction();
      this.send(commandComplete('BEGIN'));
      return;
    }
    if (rawKind === 'commit') {
      if (this.transactionFailed) {
        await this.currentJob().execute('ROLLBACK');
        this.inTransaction = false; this.transactionFailed = false;
        this.ddlForeignKeyTypes.rollbackTransaction();
        this.ddlTableDefinitions.rollbackTransaction();
        await this.restoreLocalSearchPath();
        this.send(commandComplete('ROLLBACK'));
      } else {
        await this.currentJob().execute('COMMIT');
        this.inTransaction = false;
        this.ddlForeignKeyTypes.commitTransaction();
        this.ddlTableDefinitions.commitTransaction();
        await this.restoreLocalSearchPath();
        this.send(commandComplete('COMMIT'));
      }
      return;
    }
    if (rawKind === 'rollback') {
      await this.currentJob().execute('ROLLBACK');
      this.inTransaction = false; this.transactionFailed = false;
      this.ddlForeignKeyTypes.rollbackTransaction();
      this.ddlTableDefinitions.rollbackTransaction();
      await this.restoreLocalSearchPath();
      this.send(commandComplete('ROLLBACK'));
      return;
    }

    const deallocate = parsePgDeallocate(sql);
    if (deallocate) {
      if (deallocate.action === 'all') {
        const statementCount = this.prepared.size;
        const portalCount = this.portals.size;
        this.prepared.clear();
        this.portals.clear();
        this.logger.debug('PostgreSQL DEALLOCATE ALL handled by proxy session registry', {
          database: this.client.database,
          preparedStatementsCleared: statementCount,
          portalsCleared: portalCount,
        });
      } else {
        const name = deallocate.name ?? '';
        if (!this.prepared.has(name)) {
          throw sqlError('26000', `Prepared statement ${name} does not exist`);
        }
        this.prepared.delete(name);
        for (const [portalName, portal] of this.portals.entries()) {
          if (portal.statementName === name) this.portals.delete(portalName);
        }
        this.logger.debug('PostgreSQL DEALLOCATE handled by proxy session registry', {
          database: this.client.database,
          preparedStatement: name,
        });
      }
      this.send(commandComplete('DEALLOCATE'));
      return;
    }

    const advisoryLock = parsePgAdvisoryLockQuery(sql);
    if (advisoryLock) {
      const result = executePgAdvisoryLockQuery(advisoryLock, this);
      const value = result.rows[0]?.[0];
      this.logger.info('PostgreSQL advisory lock handled by proxy session registry', {
        action: advisoryLock.action,
        key: advisoryLock.key,
        acquired: advisoryLock.action === 'tryLock' ? value : undefined,
        unlocked: advisoryLock.action === 'unlock' ? value : undefined,
        database: this.client.database,
      });
      this.sendSynthetic(result, includeDescription);
      return;
    }

    const searchPath = parseSearchPathCommand(sql, config.ibmi.currentSchema);
    if (searchPath) {
      await this.applySearchPath(searchPath);
      this.send(commandComplete(searchPath.reset ? 'RESET' : 'SET'));
      return;
    }

    const setConfigSearchPath = parseSetConfigSearchPath(sql, config.ibmi.currentSchema);
    if (setConfigSearchPath) {
      await this.applySearchPath(setConfigSearchPath.selection);
      this.sendSynthetic({
        fields: [{ name: setConfigSearchPath.fieldName, typeOid: OID.text, typeSize: -1 }],
        rows: [[this.currentSchema]],
        tag: 'SELECT 1',
      }, includeDescription);
      return;
    }

    const synthetic = await this.resolveSynthetic(sql, parameters);
    if (synthetic) { this.sendSynthetic(synthetic, includeDescription); return; }
    if (rawKind === 'set') {
      throw sqlError('0A000', 'This PostgreSQL SET option is not supported by proxy v0.1');
    }

    // Never let an unhandled PostgreSQL system catalog/function fall through
    // into IBM i. This is a compatibility firewall, not a Db2 error mapper.
    if (containsUnhandledPostgresSystemSql(sql)) {
      const error = sqlError('0A000', 'PostgreSQL system catalog/function is not implemented by the proxy compatibility layer');
      (error as Error & { proxySql?: string }).proxySql = sql;
      throw error;
    }

    const simpleIndex = parsePgSimpleCreateIndex(sql);
    if (simpleIndex) {
      const schemaName = simpleIndex.tableSchema ?? this.currentSchema;
      const columnTypes: LobIndexColumnType[] = [];
      const unresolved: string[] = [];
      for (const column of simpleIndex.columns) {
        const registeredType = this.ddlForeignKeyTypes.getColumnType(
          `${schemaName}.${simpleIndex.tableName}`,
          column,
          schemaName,
        );
        if (registeredType) columnTypes.push({ column, type: registeredType });
        else unresolved.push(column);
      }
      if (unresolved.length) {
        const liveColumns = await this.fetchIbmiColumns(schemaName, simpleIndex.tableName);
        for (const column of unresolved) {
          const live = liveColumns.find((candidate) => sameSqlIdentifier(candidate.name, column));
          if (live) columnTypes.push({ column, type: live.dataType });
        }
      }

      const decision = decideLobIndexCompatibility(
        simpleIndex,
        columnTypes,
        config.sql.unsupportedNonuniqueLobIndexPolicy,
      );
      if (decision.action === 'error') {
        const error = sqlError('0A000',
          `Db2 for i cannot create ${simpleIndex.unique ? 'a UNIQUE ' : ''}index ${simpleIndex.indexName} directly on LOB-backed column(s): ${decision.lobColumns.map((entry) => entry.column).join(', ')}`);
        (error as Error & { detail?: string }).detail = simpleIndex.unique
          ? 'The proxy will never skip a UNIQUE index because that would remove a PostgreSQL data-integrity constraint. Use an application-specific normalized/generated key if uniqueness is required.'
          : 'Set SQL_UNSUPPORTED_NONUNIQUE_LOB_INDEX_POLICY=skip to acknowledge unsupported performance-only LOB indexes, or keep error mode for strict physical-index equivalence.';
        throw error;
      }

      if (decision.action === 'skip') {
        // Db2 for i forbids LOB/XML/DATALINK columns as index keys. PostgreSQL
        // can index JSONB/TEXT values that this proxy represents as CLOB. A
        // non-unique index changes access-path performance, not row validity,
        // so compatibility mode may acknowledge it without inventing a lossy
        // hash/truncation index. The warning is intentionally prominent.
        this.logger.warn('Skipped PostgreSQL non-unique index unsupported by Db2 for i LOB key rules', {
          database: this.client.database,
          currentSchema: this.currentSchema,
          index: simpleIndex.indexName,
          tableSchema: schemaName,
          table: simpleIndex.tableName,
          columns: decision.lobColumns,
          policy: config.sql.unsupportedNonuniqueLobIndexPolicy,
          physicalIndexCreated: false,
          semantics: 'PostgreSQL logical data semantics preserved; requested performance access path is not physically materialized on IBM i',
        });
        this.send(commandComplete('CREATE INDEX'));
        return;
      }
    }

    let translation: Translation;
    let columnRenamePlan: ColumnRenamePlan | undefined;
    try {
      const rename = parsePgAlterTableRenameColumn(sql, this.currentSchema);
      if (rename) {
        const columns = await this.fetchIbmiColumns(rename.schema, rename.table);
        const oldColumn = columns.find((column) => sameSqlIdentifier(column.name, rename.oldColumn));
        if (!oldColumn) {
          throw sqlError('42703', `Column ${rename.oldColumn} does not exist on table ${rename.table}`);
        }
        const systemColumnName = oldColumn.systemName
          ?? (/^[A-Z_$#@][A-Z0-9_$#@]{0,9}$/i.test(rename.oldColumn) ? rename.oldColumn.toUpperCase() : undefined);
        if (!systemColumnName) {
          throw sqlError('0A000',
            `Cannot safely emulate PostgreSQL column rename for ${rename.schema}.${rename.table}.${rename.oldColumn}: IBM i system column name is unavailable`);
        }
        columnRenamePlan = this.ddlTableDefinitions.planRename(rename, systemColumnName);
        if (!columnRenamePlan) {
          const error = sqlError('0A000',
            `Cannot safely emulate PostgreSQL ALTER TABLE RENAME COLUMN for ${rename.schema}.${rename.table}: exact CREATE TABLE definition is not available in this proxy session`);
          (error as Error & { detail?: string }).detail =
            'Db2 for i has no ALTER TABLE RENAME COLUMN syntax. The proxy only uses CREATE OR REPLACE TABLE ... ON REPLACE PRESERVE ROWS when it has the exact translated table definition; it will not use a destructive add/copy/drop fallback.';
          throw error;
        }
        translation = { original: sql, sql: columnRenamePlan.db2Sql, kind: rawKind, parameterOrder: [] };
      } else {
        translation = translateSql(sql, config.sql);
        const aligned = this.ddlForeignKeyTypes.alignCreateTable(translation.sql, this.currentSchema);
        if (aligned.alignments.length > 0) {
          translation.sql = aligned.sql;
          this.logger.info('Aligned Db2 foreign-key column types with referenced parent keys', {
            database: this.client.database,
            alignments: aligned.alignments,
          });
        }
      }
      if (config.sql.logText) this.logger.info('Translated SQL', { original: sql, db2: translation.sql });
    } catch (error) {
      throw error;
    }

    const values = reorderParameters(parameters, translation.parameterOrder);
    let result: QueryResult<Record<string, unknown>>;
    try {
      result = await this.executeWithSafeRetry(translation, values, maxRows);
      if (columnRenamePlan) {
        this.ddlTableDefinitions.commitRename(columnRenamePlan);
        this.ddlForeignKeyTypes.renameColumn(
          `${columnRenamePlan.request.schema}.${columnRenamePlan.request.table}`,
          columnRenamePlan.request.oldColumn,
          columnRenamePlan.request.newColumn,
          this.currentSchema,
        );
        this.logger.info('PostgreSQL column rename emulated with IBM i CREATE OR REPLACE TABLE', {
          database: this.client.database,
          schema: columnRenamePlan.request.schema,
          table: columnRenamePlan.request.table,
          oldColumn: columnRenamePlan.request.oldColumn,
          newColumn: columnRenamePlan.request.newColumn,
          preservedSystemColumnName: columnRenamePlan.systemColumnName,
        });
      } else {
        this.ddlForeignKeyTypes.registerCreateTable(translation.sql, this.currentSchema);
        this.ddlForeignKeyTypes.registerAlterAddColumn(translation.sql, this.currentSchema);
        this.ddlTableDefinitions.registerCreateTable(translation.sql, this.currentSchema);
        this.ddlTableDefinitions.registerAlterAddColumn(translation.sql, this.currentSchema);
      }

      // PostgreSQL autocommit semantics require the backend transaction to be
      // durable before CommandComplete is reported to the client. Mapepire JDBC
      // auto-commit is intentionally disabled, so every implicit transaction is
      // committed explicitly here (including SELECT, to release read locks).
      if (!this.inTransaction) await this.currentJob().execute('COMMIT');
    } catch (error) {
      if (this.inTransaction) {
        this.transactionFailed = true;
      } else {
        try { await this.currentJob().execute('ROLLBACK'); } catch { /* best effort */ }
      }
      const mapped = mapDb2Error(error) as Error & { proxySql?: string; proxyDb2Sql?: string; detail?: string };
      mapped.proxySql = sql;
      mapped.proxyDb2Sql = translation.sql;
      if (isDb2Sql7008(error)) {
        const capabilities = this.currentSchemaCapabilities;
        let journalState: string;
        if (capabilities?.transactionalWritesConfigured === false) {
          journalState =
            `No QSQJRN SQL-schema journal or STRJRNLIB-style inherited journaling was detected for ${this.currentSchema}.`;
        } else if (capabilities?.transactionalWritesConfigured === true) {
          journalState =
            `Automatic schema journaling is configured, so verify that this specific target table is journaled and that the IBM i service profile has authority to its journal.`;
        } else {
          journalState =
            `The proxy could not positively determine schema journaling state; verify table journaling and journal authority.`;
        }
        mapped.detail =
          `Db2 for i SQL7008 occurred while PostgreSQL transaction semantics are active. ${journalState} ` +
          `PostgreSQL COMMIT/ROLLBACK semantics require journaled IBM i files. ` +
          `Prefer an IBM i SQL schema created with CREATE SCHEMA, or configure STRJRNLIB/STRJRNPF for an existing library. ` +
          `Effective PostgreSQL current_schema is ${this.currentSchema} (source=${this.schemaSource}).`;
      }
      throw mapped;
    }

    if (result.has_results) this.sendMapepireRows(result, maxRows, includeDescription);
    this.send(commandComplete(commandTag(translation.kind, result)));
  }

  private async readBackendCurrentSchema(): Promise<string | undefined> {
    const result = await this.currentJob().execute('VALUES CURRENT SCHEMA') as QueryResult<Record<string, unknown>>;
    const row = result.data?.[0];
    if (!row) return undefined;
    const value = Object.values(row)[0];
    const text = String(value ?? '').trim();
    return text || undefined;
  }

  private async applySearchPath(selection: SearchPathSelection): Promise<void> {
    if (selection.scope === 'local') {
      if (!this.inTransaction) {
        throw sqlError('25P01', 'SET LOCAL search_path can only be used in transaction blocks');
      }
      if (!this.localSchemaRestore) {
        this.localSchemaRestore = {
          schema: this.currentSchema,
          source: this.schemaSource,
          capabilities: this.currentSchemaCapabilities ? { ...this.currentSchemaCapabilities } : undefined,
        };
      }
    }

    const capabilities = await this.pool.prepareSchema(this.currentJob(), selection.schema, false, !this.inTransaction);
    await this.currentJob().execute(`SET CURRENT SCHEMA ${quoteDb2Identifier(selection.schema)}`);
    this.currentSchema = selection.schema;
    this.backendCurrentSchema = await this.readBackendCurrentSchema();
    if (this.backendCurrentSchema && !sameSqlIdentifier(this.backendCurrentSchema, this.currentSchema)) {
      throw new Error(`IBM i CURRENT SCHEMA mismatch: expected ${this.currentSchema}, backend reports ${this.backendCurrentSchema}`);
    }
    this.schemaSource = selection.scope === 'local' ? 'set-local-search-path' : 'set-search-path';
    this.currentSchemaCapabilities = capabilities;
    if (!this.inTransaction) await this.currentJob().execute('COMMIT');
    this.logger.info('PostgreSQL search_path mapped to IBM i CURRENT SCHEMA', {
      database: this.client.database,
      currentSchema: this.currentSchema,
      backendCurrentSchema: this.backendCurrentSchema,
      schemaSource: this.schemaSource,
      searchPathScope: selection.scope,
      requestedSearchPath: selection.requested,
      ignoredSearchPathEntries: selection.ignored,
      schemaCapabilities: this.currentSchemaCapabilities,
    });
  }

  private async restoreLocalSearchPath(): Promise<void> {
    const restore = this.localSchemaRestore;
    if (!restore) return;
    this.localSchemaRestore = undefined;
    await this.currentJob().execute(`SET CURRENT SCHEMA ${quoteDb2Identifier(restore.schema)}`);
    await this.currentJob().execute('COMMIT');
    this.currentSchema = restore.schema;
    this.backendCurrentSchema = await this.readBackendCurrentSchema();
    this.schemaSource = restore.source;
    this.currentSchemaCapabilities = restore.capabilities;
    this.logger.debug('Restored PostgreSQL session search_path after SET LOCAL transaction scope', {
      database: this.client.database,
      currentSchema: this.currentSchema,
      schemaSource: this.schemaSource,
    });
  }

  private returningFields(sql: string): FieldDescription[] | undefined {
    const returning = parsePgReturning(sql);
    if (!returning) return undefined;
    return returning.columns.map((column) => {
      const db2Type = this.ddlForeignKeyTypes.getColumnType(returning.table, column.column, this.currentSchema);
      const pg = db2Type ? db2TypeToPg(db2Type) : { oid: OID.text, size: -1 };
      return {
        name: column.fieldName,
        typeOid: pg.oid,
        typeSize: pg.size,
        typeModifier: -1,
        format: 0,
      };
    });
  }

  private async executeWithSafeRetry(translation: Translation, parameters: unknown[], maxRows: number): Promise<QueryResult<Record<string, unknown>>> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.executePaged(translation.sql, parameters, maxRows);
      } catch (error) {
        const retry = attempt < config.ibmi.reconnectRetries && !this.inTransaction && isIdempotentRead(translation.kind) && isTransportError(error);
        if (!retry) throw error;
        attempt++;
        const failed = this.currentJob();
        await this.pool.invalidate(failed, error);
        this.job = await this.pool.acquire();
        this.logger.warn('Retrying idempotent read after Mapepire transport failure', { attempt });
      }
    }
  }

  private async executePaged(sql: string, parameters: unknown[], maxRows: number): Promise<QueryResult<Record<string, unknown>>> {
    const query = this.currentJob().query<Record<string, unknown>>(sql, { parameters: parameters as any[] });
    let first: QueryResult<Record<string, unknown>> | undefined;
    let last: QueryResult<Record<string, unknown>> | undefined;
    const rows: Record<string, unknown>[] = [];
    try {
      first = await query.execute(config.ibmi.fetchSize);
      last = first;
      rows.push(...first.data);

      const limits = [config.sql.maxRows, maxRows].filter((n) => n > 0);
      const configuredLimit = limits.length ? Math.min(...limits) : Number.MAX_SAFE_INTEGER;
      while (!last.is_done && rows.length < configuredLimit) {
        const remaining = configuredLimit - rows.length;
        const fetch = Math.max(1, Math.min(config.ibmi.fetchSize, remaining));
        last = await query.fetchMore(fetch);
        rows.push(...last.data);
      }

      // Keep first-page metadata: continuation responses may not repeat it.
      return { ...last, metadata: first.metadata, data: rows.slice(0, configuredLimit) };
    } finally {
      try { await query.close(); } catch { /* best-effort cursor cleanup */ }
    }
  }

  private async resolveSynthetic(sql: string, parameters: unknown[] = []): Promise<SyntheticResult | undefined> {
    const env = environmentQuery(sql, config.pg.databaseName, this.currentSchema, config.pg.serverVersion);
    if (env) return env;

    // SQLAlchemy/Alembic PostgreSQL reflection must be resolved from live IBM i
    // catalogs before pgAdmin-specific handlers and before the generic
    // pg_catalog firewall. Returning an empty synthetic pg_catalog rowset here
    // makes Inspector conclude that existing tables/columns/indexes do not
    // exist, which can silently skip migrations.
    const sqlalchemyReflection = classifySqlAlchemyReflectionQuery(sql);
    if (sqlalchemyReflection) {
      return this.resolveSqlAlchemyReflection(sqlalchemyReflection, sql, parameters);
    }

    // Schema browser queries are keyed by pg_namespace as their PRIMARY
    // relation. Resolve them before the table adapter because pgAdmin schema
    // templates embed pg_class inside catalog-exclusion macros.
    const schemaRequest = classifyPgAdminIbmiSchemaQuery(sql);
    if (schemaRequest) {
      const schemas = await this.fetchIbmiSchemas();
      const rendered = renderPgAdminIbmiSchemaQuery(schemaRequest, schemas, {
        user: this.client.user ?? config.pg.user ?? 'proxy',
        currentSchema: this.currentSchema,
        hideSystemSchemas: config.pg.pgadminHideSystemSchemas,
      });
      if (schemaRequest.kind === 'count' || schemaRequest.kind === 'nodes' || schemaRequest.kind === 'properties') {
        this.logger.info('pgAdmin IBM i schema catalog request', {
          kind: schemaRequest.kind,
          database: config.pg.databaseName,
          currentSchema: this.currentSchema,
          ibmiCatalogRows: schemas.length,
          returnedRows: rendered.rows.length,
          returnedSchemaNames: schemaRequest.kind === 'nodes'
            ? rendered.rows.slice(0, 20).map((row) => String(row[1] ?? ''))
            : undefined,
        });
      }
      return rendered;
    }

    // Table child collections (Columns, Indexes, Partitions and PostgreSQL-only
    // children) are keyed by the virtual table OID pgAdmin received from the
    // Tables adapter. Resolve the OID from the process-wide live table registry
    // and never forward PostgreSQL ::OID casts to Db2 for i.
    const childRequest = classifyPgAdminTableChildQuery(sql);
    if (childRequest) {
      if (childRequest.kind === 'partitionNodes' || childRequest.kind === 'emptyTableChild') {
        return renderEmptyTableChild(childRequest);
      }

      let relation = lookupRegisteredIbmiTable(childRequest.tableOid) ?? lookupRegisteredIbmiView(childRequest.tableOid);
      // Defensive refresh for a cached pgAdmin tree immediately after proxy
      // restart: seed both table and view registries from the configured
      // current schema. Views use the same Columns browser module in pgAdmin.
      if (!relation) {
        await this.fetchIbmiTables(this.currentSchema);
        await this.fetchIbmiViews(this.currentSchema);
        relation = lookupRegisteredIbmiTable(childRequest.tableOid) ?? lookupRegisteredIbmiView(childRequest.tableOid);
      }
      if (!relation) {
        this.logger.warn('pgAdmin relation child OID could not be resolved', {
          kind: childRequest.kind,
          tableOid: childRequest.tableOid,
          currentSchema: this.currentSchema,
        });
        if (childRequest.kind === 'columnCount' || childRequest.kind === 'columnNodes' || childRequest.kind === 'columnProperties') {
          return renderColumnQuery(childRequest, []);
        }
        return renderIndexQuery(childRequest, [], childRequest.tableOid);
      }

      if (childRequest.kind === 'columnCount' || childRequest.kind === 'columnNodes' || childRequest.kind === 'columnProperties') {
        const columns = await this.fetchIbmiColumns(relation.schema, relation.name);
        this.logger.info('pgAdmin IBM i column catalog request', {
          kind: childRequest.kind, schema: relation.schema, table: relation.name, tableOid: childRequest.tableOid,
          columnCount: columns.length,
        });
        return renderColumnQuery(childRequest, columns);
      }

      const indexes = await this.fetchIbmiIndexes(relation.schema, relation.name);
      this.logger.info('pgAdmin IBM i index catalog request', {
        kind: childRequest.kind, schema: relation.schema, table: relation.name, tableOid: childRequest.tableOid,
        indexCount: indexes.length,
      });
      return renderIndexQuery(childRequest, indexes, childRequest.tableOid);
    }

    // pgAdmin Views collection/browser queries use relkind='v'. Resolve them
    // from live IBM i catalogs before the Tables and generic pg_catalog paths.
    const viewRequest = classifyPgAdminIbmiViewQuery(sql);
    if (viewRequest) {
      const schemas = await this.fetchIbmiSchemas();
      let schema = viewRequest.schemaOid !== undefined
        ? findSchemaByCompatibleOid(schemas, viewRequest.schemaOid)
        : undefined;

      if (!schema && viewRequest.schemaOid !== undefined) {
        const current = schemas.find((row) => sameSqlIdentifier(row.name, this.currentSchema));
        if (current) {
          schema = current;
          this.logger.warn('Using current IBM i schema for unresolved pgAdmin Views schema OID', {
            kind: viewRequest.kind, requestedSchemaOid: viewRequest.schemaOid, fallbackSchema: current.name,
          });
        }
      }

      const views = schema ? await this.fetchIbmiViews(schema.name) : [];
      const rendered = renderPgAdminIbmiViewQuery(viewRequest, views);
      this.logger.info('pgAdmin IBM i view catalog request', {
        kind: viewRequest.kind, requestedSchemaOid: viewRequest.schemaOid, resolvedSchema: schema?.name,
        viewCount: views.length, returnedRows: rendered.rows.length,
        returnedViewNames: viewRequest.kind === 'nodes'
          ? rendered.rows.slice(0, 20).map((row) => String(row[1] ?? ''))
          : undefined,
      });
      return rendered;
    }


    // pgAdmin table collection/browser queries need live IBM i catalog data.
    // Resolve them before the schema and generic pg_catalog handlers: table
    // templates embed several PostgreSQL-only subqueries (triggers, inherits,
    // descriptions, EXISTS) which must never be forwarded to Db2 for i.
    const tableRequest = classifyPgAdminIbmiTableQuery(sql);
    if (tableRequest) {
      const schemas = await this.fetchIbmiSchemas();

      // pgAdmin table templates scope the real target with
      // relnamespace=<schema OID>.  Prefer that OID over every textual
      // nspname predicate because catalog subqueries/macros frequently contain
      // nspname='pg_catalog'.  Older releases did the opposite and could
      // therefore try to resolve PG_CATALOG as an IBM i schema.
      let schema = tableRequest.schemaOid !== undefined
        ? findSchemaByCompatibleOid(schemas, tableRequest.schemaOid)
        : tableRequest.schemaName !== undefined
          ? schemas.find((row) => sameSqlIdentifier(row.name, tableRequest.schemaName!))
          : undefined;

      // Defensive compatibility fallback for stale pgAdmin browser OIDs.
      // It is intentionally limited to collection/node/property requests and
      // only applies when CURRENT SCHEMA names a real IBM i schema.  Current
      // stable and legacy OIDs should normally resolve before this branch.
      if (!schema
          && tableRequest.schemaOid !== undefined
          && ['count', 'exists', 'nodes', 'properties'].includes(tableRequest.kind)) {
        const current = schemas.find((row) => sameSqlIdentifier(row.name, this.currentSchema));
        if (current) {
          schema = current;
          this.logger.warn('Using current IBM i schema for unresolved pgAdmin schema OID', {
            kind: tableRequest.kind,
            requestedSchemaOid: tableRequest.schemaOid,
            fallbackSchema: current.name,
          });
        }
      }

      const tables = schema ? await this.fetchIbmiTables(schema.name) : [];
      const resolvedSchemaOid = schema
        ? schemaOidForSession(schema.name)
        : (tableRequest.schemaOid ?? 0);

      const catalogLog = {
        kind: tableRequest.kind,
        requestedSchemaOid: tableRequest.schemaOid,
        requestedSchemaName: tableRequest.schemaName,
        resolvedSchema: schema?.name,
        tableCount: tables.length,
      };
      // Count and nodes determine whether pgAdmin shows the Tables collection
      // and which rows it renders. Keep these two events visible at INFO even
      // when general debug logging is disabled.
      if (tableRequest.kind === 'count' || tableRequest.kind === 'nodes') {
        this.logger.info('pgAdmin IBM i table catalog request', catalogLog);
      } else {
        this.logger.debug('pgAdmin IBM i table catalog request', catalogLog);
      }
      if (!schema && (tableRequest.schemaOid !== undefined || tableRequest.schemaName !== undefined)) {
        this.logger.warn('pgAdmin table catalog schema could not be resolved', {
          requestedSchemaOid: tableRequest.schemaOid,
          requestedSchemaName: tableRequest.schemaName,
          currentSchema: this.currentSchema,
        });
      }

      return renderPgAdminIbmiTableQuery(tableRequest, tables, resolvedSchemaOid, {
        user: this.client.user ?? config.pg.user ?? 'proxy',
      });
    }

    return pgAdminCompatibilityQuery(sql, this.pgCompatContext())
      ?? syntheticCatalog(sql);
  }

  private async resolveSqlAlchemyReflection(
    request: SqlAlchemyReflectionRequest,
    sql: string,
    parameters: unknown[],
  ): Promise<SyntheticResult> {
    const schemas = await this.fetchIbmiSchemas();
    const explicitSchema = /\b(?:pg_catalog\.)?pg_namespace\.nspname\s*=\s*/i.test(sql);
    const schemaMatches = requestedObjectNames(parameters, schemas.map((row) => row.name));
    const schemaName = explicitSchema && schemaMatches.length > 0 ? schemaMatches[0]! : this.currentSchema;

    const tableRows = await this.fetchIbmiTables(schemaName);
    const relationKinds = requestedRelationKinds(parameters);
    const includeViews = relationKinds.has('v') || relationKinds.has('m');
    const includeTables = relationKinds.size === 0 || [...relationKinds].some((kind) => ['r', 'p', 'f'].includes(kind));
    const viewRows = includeViews ? await this.fetchIbmiViews(schemaName) : [];
    const relations: IbmiTableRow[] = [
      ...(includeTables ? tableRows : []),
      ...viewRows.map((view) => ({
        schema: view.schema,
        name: view.name,
        owner: view.owner,
        type: 'V',
        text: view.text,
        longComment: view.longComment,
        columnCount: view.columnCount,
      })),
    ];

    const requestedNames = requestedObjectNames(parameters, relations.map((row) => row.name));
    const hasBindParameters = /\$\d+/.test(sql);

    if (request.kind === 'relationNames') {
      const selected = requestedNames.length > 0
        ? relations.filter((row) => requestedNames.some((name) => sameSqlIdentifier(name, row.name)))
        : relations;
      this.logger.debug('SQLAlchemy relation-name reflection served from IBM i', {
        database: this.client.database, schema: schemaName, returnedRows: selected.length,
      });
      return renderSqlAlchemyRelationNames(selected);
    }

    if (request.kind === 'hasRelation') {
      const target = requestedNames.length > 0
        ? relations.find((row) => sameSqlIdentifier(row.name, requestedNames[0]!))
        : undefined;
      return renderSqlAlchemyHasRelation(target);
    }

    if (request.kind === 'relationOids') {
      // Statement-level Describe happens before Bind. Return only metadata in
      // that phase instead of accidentally returning every relation for a
      // filter_names query whose values are not available yet.
      if (hasBindParameters && parameters.length === 0) return renderSqlAlchemyRelationOids([]);
      const selected = requestedNames.length > 0
        ? relations.filter((row) => requestedNames.some((name) => sameSqlIdentifier(name, row.name)))
        : relations;
      return renderSqlAlchemyRelationOids(selected.map((row) => ({ oid: tableOid(row.schema, row.name), name: row.name })));
    }

    if (request.kind === 'relationOidByName') {
      const target = requestedNames.length > 0
        ? relations.find((row) => sameSqlIdentifier(row.name, requestedNames[0]!))
        : undefined;
      return renderSqlAlchemyRelationOid(target ? { oid: tableOid(target.schema, target.name), name: target.name } : undefined);
    }

    if (request.kind === 'columns') {
      if (hasBindParameters && parameters.length === 0) return renderSqlAlchemyColumns('', []);
      const selectedNames = requestedNames.length > 0 ? requestedNames : relations.map((row) => row.name);
      let combined: SyntheticResult | undefined;
      for (const name of selectedNames) {
        const columns = await this.fetchIbmiColumns(schemaName, name);
        const rendered = renderSqlAlchemyColumns(name, columns);
        if (!combined) combined = rendered;
        else combined.rows.push(...rendered.rows);
      }
      const result = combined ?? renderSqlAlchemyColumns('', []);
      result.tag = `SELECT ${result.rows.length}`;
      this.logger.debug('SQLAlchemy column reflection served from IBM i', {
        database: this.client.database, schema: schemaName,
        tables: selectedNames.map(pgVisibleIdentifier), returnedRows: result.rows.length,
      });
      return result;
    }

    if (request.kind === 'indexes') {
      if (hasBindParameters && parameters.length === 0) return renderSqlAlchemyIndexes([]);
      const requestedOids = new Set(requestedVirtualOids(parameters));
      const selected = tableRows.filter((row) => requestedOids.size === 0 || requestedOids.has(tableOid(row.schema, row.name)));
      const tableIndexes = [] as Array<{ tableOid: number; indexes: IbmiIndexRow[] }>;
      for (const table of selected) {
        tableIndexes.push({ tableOid: tableOid(table.schema, table.name), indexes: await this.fetchIbmiIndexes(schemaName, table.name) });
      }
      const result = renderSqlAlchemyIndexes(tableIndexes);
      this.logger.debug('SQLAlchemy index reflection served from IBM i', {
        database: this.client.database, schema: schemaName,
        requestedOids: [...requestedOids], returnedRows: result.rows.length,
      });
      return result;
    }

    if (request.kind === 'foreignKeys') {
      if (hasBindParameters && parameters.length === 0) return renderSqlAlchemyForeignKeys('', []);
      const selectedNames = requestedNames.length > 0 ? requestedNames : tableRows.map((row) => row.name);
      let combined: SyntheticResult | undefined;
      for (const name of selectedNames) {
        const foreignKeys = await this.fetchIbmiForeignKeys(schemaName, name);
        const rendered = renderSqlAlchemyForeignKeys(name, foreignKeys);
        if (!combined) combined = rendered;
        else combined.rows.push(...rendered.rows);
      }
      const result = combined ?? renderSqlAlchemyForeignKeys('', []);
      result.tag = `SELECT ${result.rows.length}`;
      return result;
    }

    // SQLAlchemy primary/unique constraint reflection is also OID-based and is
    // needed by ORM migration tools that inspect constraints before ALTER.
    if (hasBindParameters && parameters.length === 0) return renderSqlAlchemyKeyConstraints(0, '', [], 'p');
    const constraintType = requestedConstraintType(parameters) ?? 'p';
    const requestedOids = new Set(requestedVirtualOids(parameters));
    const selected = tableRows.filter((row) => requestedOids.size === 0 || requestedOids.has(tableOid(row.schema, row.name)));
    let combined: SyntheticResult | undefined;
    for (const table of selected) {
      const constraints = await this.fetchIbmiKeyConstraints(schemaName, table.name);
      const rendered = renderSqlAlchemyKeyConstraints(tableOid(table.schema, table.name), table.name, constraints, constraintType);
      if (!combined) combined = rendered;
      else combined.rows.push(...rendered.rows);
    }
    const result = combined ?? renderSqlAlchemyKeyConstraints(0, '', [], constraintType);
    result.tag = `SELECT ${result.rows.length}`;
    return result;
  }

  private async fetchIbmiSchemas(force = false): Promise<IbmiSchemaRow[]> {
    if (!force && this.schemaCache && this.schemaCache.expiresAt > Date.now()) return this.schemaCache.rows;

    const result = await this.executePaged(
      'SELECT SCHEMA_NAME, SCHEMA_OWNER, SCHEMA_TEXT FROM QSYS2.SYSSCHEMAS ORDER BY SCHEMA_NAME',
      [],
      0,
    );
    if (!this.inTransaction) await this.currentJob().execute('COMMIT');

    const rows: IbmiSchemaRow[] = result.data.map((row: Record<string, unknown>) => ({
      name: String(caseInsensitiveValue(row, 'SCHEMA_NAME') ?? '').trim(),
      owner: String(caseInsensitiveValue(row, 'SCHEMA_OWNER') ?? '').trim(),
      text: nullableString(caseInsensitiveValue(row, 'SCHEMA_TEXT')),
    })).filter((row: IbmiSchemaRow) => row.name.length > 0);

    this.schemaCache = { expiresAt: Date.now() + config.pg.pgadminSchemaCacheMs, rows };
    return rows;
  }

  private async fetchIbmiTables(schemaName: string): Promise<IbmiTableRow[]> {
    // QSYS2.SYSTABLES is the authoritative IBM i table catalog.  Keep this
    // query uncached so a table created through pgAdmin is visible on the next
    // browser refresh without waiting for a TTL.  T/P cover SQL tables and
    // physical data files; source physical files are excluded.
    let result: QueryResult<Record<string, unknown>>;
    try {
      result = await this.executePaged(
        IBMI_TABLE_CATALOG_SQL,
        [schemaName],
        0,
      );
      if (!this.inTransaction) await this.currentJob().execute('COMMIT');
    } catch (error) {
      this.logger.warn('IBM i table catalog query failed', {
        schema: schemaName,
        error: String((error as Error)?.message ?? error),
      });
      throw error;
    }

    const rows = result.data.map((row: Record<string, unknown>) => ({
      schema: String(caseInsensitiveValue(row, 'TABLE_SCHEMA') ?? '').trim(),
      name: String(caseInsensitiveValue(row, 'TABLE_NAME') ?? '').trim(),
      owner: String(caseInsensitiveValue(row, 'TABLE_OWNER') ?? '').trim(),
      type: String(caseInsensitiveValue(row, 'TABLE_TYPE') ?? '').trim(),
      text: nullableString(caseInsensitiveValue(row, 'TABLE_TEXT')),
      longComment: nullableString(caseInsensitiveValue(row, 'LONG_COMMENT')),
      columnCount: Number(caseInsensitiveValue(row, 'COLUMN_COUNT') ?? 0),
    })).filter((row: IbmiTableRow) => row.schema.length > 0 && row.name.length > 0);
    registerIbmiTables(rows);
    return rows;
  }

  private async fetchIbmiViews(schemaName: string): Promise<IbmiViewRow[]> {
    let result: QueryResult<Record<string, unknown>>;
    try {
      result = await this.executePaged(IBMI_VIEW_CATALOG_SQL, [schemaName], 0);
      if (!this.inTransaction) await this.currentJob().execute('COMMIT');
    } catch (error) {
      this.logger.warn('IBM i view catalog query failed', {
        schema: schemaName,
        error: String((error as Error)?.message ?? error),
      });
      throw error;
    }

    const rows = result.data.map((row: Record<string, unknown>) => ({
      schema: String(caseInsensitiveValue(row, 'TABLE_SCHEMA') ?? '').trim(),
      name: String(caseInsensitiveValue(row, 'TABLE_NAME') ?? '').trim(),
      owner: String(caseInsensitiveValue(row, 'TABLE_OWNER') ?? '').trim(),
      text: nullableString(caseInsensitiveValue(row, 'TABLE_TEXT')),
      longComment: nullableString(caseInsensitiveValue(row, 'LONG_COMMENT')),
      columnCount: Number(caseInsensitiveValue(row, 'COLUMN_COUNT') ?? 0),
      definition: nullableString(caseInsensitiveValue(row, 'VIEW_DEFINITION')),
      checkOption: null,
    })).filter((row: IbmiViewRow) => row.schema.length > 0 && row.name.length > 0);
    registerIbmiViews(rows);
    return rows;
  }

  private async fetchIbmiColumns(schemaName: string, tableName: string): Promise<IbmiColumnRow[]> {
    const result = await this.executePaged(IBMI_COLUMN_CATALOG_SQL, [schemaName, tableName], 0);
    if (!this.inTransaction) await this.currentJob().execute('COMMIT');
    return result.data.map((row: Record<string, unknown>) => ({
      schema: String(caseInsensitiveValue(row, 'TABLE_SCHEMA') ?? '').trim(),
      table: String(caseInsensitiveValue(row, 'TABLE_NAME') ?? '').trim(),
      name: String(caseInsensitiveValue(row, 'COLUMN_NAME') ?? '').trim(),
      systemName: nullableString(caseInsensitiveValue(row, 'SYSTEM_COLUMN_NAME')),
      ordinal: Number(caseInsensitiveValue(row, 'ORDINAL_POSITION') ?? 0),
      dataType: String(caseInsensitiveValue(row, 'DATA_TYPE') ?? '').trim(),
      length: nullableNumber(caseInsensitiveValue(row, 'LENGTH')),
      numericScale: nullableNumber(caseInsensitiveValue(row, 'NUMERIC_SCALE')),
      numericPrecision: nullableNumber(caseInsensitiveValue(row, 'NUMERIC_PRECISION')),
      nullable: String(caseInsensitiveValue(row, 'IS_NULLABLE') ?? 'Y').trim().toUpperCase() === 'Y',
      longComment: nullableString(caseInsensitiveValue(row, 'LONG_COMMENT')),
      text: nullableString(caseInsensitiveValue(row, 'COLUMN_TEXT')),
      hasDefault: String(caseInsensitiveValue(row, 'HAS_DEFAULT') ?? 'N').trim(),
      defaultValue: nullableString(caseInsensitiveValue(row, 'COLUMN_DEFAULT')),
      charMaxLength: nullableNumber(caseInsensitiveValue(row, 'CHARACTER_MAXIMUM_LENGTH')),
      datetimePrecision: nullableNumber(caseInsensitiveValue(row, 'DATETIME_PRECISION')),
      identity: String(caseInsensitiveValue(row, 'IS_IDENTITY') ?? 'NO').trim().toUpperCase() === 'YES',
      identityGeneration: nullableString(caseInsensitiveValue(row, 'IDENTITY_GENERATION')),
      expression: nullableString(caseInsensitiveValue(row, 'COLUMN_EXPRESSION')),
    })).filter((row: IbmiColumnRow) => row.name.length > 0 && row.ordinal > 0);
  }

  private mapIbmiIndexRows(data: Record<string, unknown>[]): IbmiIndexRow[] {
    return data.map((row: Record<string, unknown>) => ({
      schema: String(caseInsensitiveValue(row, 'TABLE_SCHEMA') ?? '').trim(),
      table: String(caseInsensitiveValue(row, 'TABLE_NAME') ?? '').trim(),
      indexSchema: String(caseInsensitiveValue(row, 'INDEX_SCHEMA') ?? '').trim(),
      name: String(caseInsensitiveValue(row, 'INDEX_NAME') ?? '').trim(),
      owner: String(caseInsensitiveValue(row, 'INDEX_OWNER') ?? '').trim(),
      unique: ['U', 'V'].includes(String(caseInsensitiveValue(row, 'IS_UNIQUE') ?? 'D').trim().toUpperCase()),
      columnCount: Number(caseInsensitiveValue(row, 'COLUMN_COUNT') ?? 0),
      longComment: nullableString(caseInsensitiveValue(row, 'LONG_COMMENT')),
      text: nullableString(caseInsensitiveValue(row, 'INDEX_TEXT')),
      columns: splitCatalogColumnNames(nullableString(caseInsensitiveValue(row, 'COLUMN_NAMES'))),
      filterDefinition: nullableString(caseInsensitiveValue(row, 'SEARCH_CONDITION')),
    })).filter((row: IbmiIndexRow) => row.name.length > 0);
  }

  private async fetchIbmiIndexes(schemaName: string, tableName: string): Promise<IbmiIndexRow[]> {
    const result = await this.executePaged(IBMI_INDEX_CATALOG_SQL, [schemaName, tableName], 0);
    if (!this.inTransaction) await this.currentJob().execute('COMMIT');
    let rows = this.mapIbmiIndexRows(result.data);

    // QSYS2.SYSINDEXES is the SQL CREATE INDEX catalog. If it is empty, use
    // QSYS2.SYSTABLEINDEXSTAT, which also reports DDS logical-file access
    // paths. Constraint access paths are intentionally excluded by that query
    // because pgAdmin exposes constraints in separate browser collections.
    if (rows.length === 0) {
      try {
        const native = await this.executePaged(IBMI_NATIVE_INDEX_CATALOG_SQL, [schemaName, tableName], 0);
        if (!this.inTransaction) await this.currentJob().execute('COMMIT');
        rows = this.mapIbmiIndexRows(native.data);
        if (rows.length > 0) {
          this.logger.info('Using IBM i table index statistics fallback for pgAdmin Indexes', {
            schema: schemaName, table: tableName, indexCount: rows.length,
          });
        }
      } catch (error) {
        // Do not break pgAdmin browsing if the broader service is unavailable;
        // preserve the authoritative (empty) SYSINDEXES result instead.
        this.logger.warn('IBM i table index statistics fallback query failed', {
          schema: schemaName, table: tableName,
          error: String((error as Error)?.message ?? error),
        });
      }
    }
    return rows;
  }

  private async fetchIbmiForeignKeys(schemaName: string, tableName: string): Promise<IbmiForeignKeyRow[]> {
    const result = await this.executePaged(IBMI_FOREIGN_KEY_CATALOG_SQL, [schemaName, tableName], 0);
    if (!this.inTransaction) await this.currentJob().execute('COMMIT');
    const grouped = new Map<string, IbmiForeignKeyRow>();
    for (const row of result.data) {
      const constraintSchema = String(caseInsensitiveValue(row, 'CONSTRAINT_SCHEMA') ?? '').trim();
      const constraintName = String(caseInsensitiveValue(row, 'CONSTRAINT_NAME') ?? '').trim();
      const key = `${constraintSchema}\u0000${constraintName}`;
      let item = grouped.get(key);
      if (!item) {
        item = {
          constraintSchema,
          constraintName,
          tableSchema: String(caseInsensitiveValue(row, 'TABLE_SCHEMA') ?? '').trim(),
          tableName: String(caseInsensitiveValue(row, 'TABLE_NAME') ?? '').trim(),
          columns: [],
          referencedSchema: String(caseInsensitiveValue(row, 'REFERENCED_TABLE_SCHEMA') ?? '').trim(),
          referencedTable: String(caseInsensitiveValue(row, 'REFERENCED_TABLE_NAME') ?? '').trim(),
          referencedColumns: [],
          updateRule: nullableString(caseInsensitiveValue(row, 'UPDATE_RULE')),
          deleteRule: nullableString(caseInsensitiveValue(row, 'DELETE_RULE')),
        };
        grouped.set(key, item);
      }
      const child = nullableString(caseInsensitiveValue(row, 'FK_COLUMN'));
      const parent = nullableString(caseInsensitiveValue(row, 'REFERENCED_COLUMN'));
      if (child) item.columns.push(child);
      if (parent) item.referencedColumns.push(parent);
    }
    return [...grouped.values()].filter((row) => row.constraintName && row.tableName && row.referencedTable);
  }

  private async fetchIbmiKeyConstraints(schemaName: string, tableName: string): Promise<IbmiKeyConstraintRow[]> {
    const result = await this.executePaged(IBMI_KEY_CONSTRAINT_CATALOG_SQL, [schemaName, tableName], 0);
    if (!this.inTransaction) await this.currentJob().execute('COMMIT');
    const grouped = new Map<string, IbmiKeyConstraintRow>();
    for (const row of result.data) {
      const constraintSchema = String(caseInsensitiveValue(row, 'CONSTRAINT_SCHEMA') ?? '').trim();
      const constraintName = String(caseInsensitiveValue(row, 'CONSTRAINT_NAME') ?? '').trim();
      const constraintType = String(caseInsensitiveValue(row, 'CONSTRAINT_TYPE') ?? '').trim().toUpperCase();
      if (constraintType !== 'PRIMARY KEY' && constraintType !== 'UNIQUE') continue;
      const key = `${constraintSchema}\u0000${constraintName}`;
      let item = grouped.get(key);
      if (!item) {
        item = {
          constraintSchema,
          constraintName,
          constraintType,
          tableSchema: String(caseInsensitiveValue(row, 'TABLE_SCHEMA') ?? '').trim(),
          tableName: String(caseInsensitiveValue(row, 'TABLE_NAME') ?? '').trim(),
          columns: [],
        };
        grouped.set(key, item);
      }
      const column = nullableString(caseInsensitiveValue(row, 'COLUMN_NAME'));
      if (column) item.columns.push(column);
    }
    return [...grouped.values()];
  }

  private async executeCreateSchema(plan: CreateSchemaPlan): Promise<void> {
    if (plan.ifNotExists) {
      const existing = (await this.fetchIbmiSchemas(true)).some(
        (schema) => schema.name === plan.schemaName || schema.name.toUpperCase() === plan.schemaName.toUpperCase(),
      );
      if (existing) return;
    }

    if (plan.requestedAuthorization) {
      this.logger.debug('Mapping PostgreSQL schema owner to Mapepire service-user ownership', {
        schema: plan.schemaName,
        requestedPostgresOwner: plan.requestedAuthorization,
        ibmiServiceUser: config.ibmi.user,
      });
    }

    try {
      await this.currentJob().execute(plan.db2Sql);
      if (!this.inTransaction) await this.currentJob().execute('COMMIT');
      this.schemaCache = undefined;
      this.pool.invalidateSchemaCapabilities(plan.schemaName);
      if (sameSqlIdentifier(plan.schemaName, this.currentSchema)) {
        this.currentSchemaCapabilities = await this.pool.inspectSchema(this.currentJob(), this.currentSchema, true);
        if (!this.inTransaction) await this.currentJob().execute('COMMIT');
      }
    } catch (error) {
      if (!this.inTransaction) {
        try { await this.currentJob().execute('ROLLBACK'); } catch { /* best effort */ }
      } else {
        this.transactionFailed = true;
      }
      const mapped = mapDb2Error(error) as Error & { proxySql?: string };
      mapped.proxySql = plan.db2Sql;
      throw mapped;
    }
  }

  private validateSynthetic(result: SyntheticResult): void {
    for (const [index, row] of result.rows.entries()) {
      if (row.length !== result.fields.length) {
        throw sqlError(
          'XX000',
          `Synthetic PostgreSQL result shape mismatch at row ${index}: ${row.length} values for ${result.fields.length} fields`,
        );
      }
    }
  }

  private sendSynthetic(result: SyntheticResult, includeDescription = true): void {
    this.validateSynthetic(result);
    if (result.fields.length) {
      if (includeDescription) this.send(rowDescription(result.fields));
      for (const row of result.rows) this.send(dataRow(row));
    }
    this.send(commandComplete(result.tag));
  }

  private sendMapepireRows(
    result: QueryResult<Record<string, unknown>>,
    maxRows: number,
    includeDescription = true,
  ): void {
    const columns = result.metadata?.columns ?? [];
    const fields = columns.map(columnToField);
    if (includeDescription) this.send(rowDescription(fields));
    const rows = maxRows > 0 ? result.data.slice(0, maxRows) : result.data;
    for (const row of rows) {
      this.send(dataRow(columns.map((c) => getRowValue(row, c))));
    }
  }

  private async materializeReadPortal(sql: string, parameters: unknown[]): Promise<BufferedDb2Execution> {
    const kind = classify(sql);
    if (!statementMayReturnRows(kind) || !isIdempotentRead(kind)) {
      throw sqlError('0A000', 'Only read-only rowsets can be materialized during portal Describe');
    }

    let translation: Translation;
    try {
      translation = translateSql(sql, config.sql);
      if (config.sql.logText) this.logger.info('Translated SQL for portal Describe', { original: sql, db2: translation.sql });
    } catch (error) {
      throw error;
    }

    const values = reorderParameters(parameters, translation.parameterOrder);
    try {
      const result = await this.executeWithSafeRetry(translation, values, 0);
      // This compatibility bridge executes a read rowset at Describe time in
      // order to obtain the metadata Mapepire only returns on execution. End an
      // implicit read transaction immediately; explicit transactions remain
      // under the PostgreSQL session's control.
      if (!this.inTransaction) await this.currentJob().execute('COMMIT');
      return { translation, result };
    } catch (error) {
      if (this.inTransaction) {
        this.transactionFailed = true;
      } else {
        try { await this.currentJob().execute('ROLLBACK'); } catch { /* best effort */ }
      }
      const mapped = mapDb2Error(error) as Error & { proxySql?: string; proxyDb2Sql?: string };
      mapped.proxySql = sql;
      mapped.proxyDb2Sql = translation.sql;
      throw mapped;
    }
  }

  private pgCompatContext() {
    const digest = createHash('sha256')
      .update(`${config.ibmi.host}:${config.ibmi.port}:${config.ibmi.currentSchema}`)
      .digest();
    // PostgreSQL system_identifier is an unsigned 64-bit decimal. Keep the
    // synthetic value positive and stable for a given IBM i endpoint.
    const numeric = (digest.readBigUInt64BE(0) & ((1n << 63n) - 1n)) || 1n;
    return {
      database: config.pg.databaseName,
      user: this.client.user ?? config.pg.user ?? 'proxy',
      currentSchema: this.currentSchema,
      serverPort: config.pg.port,
      systemIdentifier: numeric.toString(10),
      backendPid: this.client.backendPid,
    };
  }

  private currentJob(): SQLJobInstance {
    if (!this.job) throw new Error('Mapepire job not initialized');
    return this.job;
  }

  private async handleUnexpected(error: unknown): Promise<void> {
    const e = error as any;
    const fields: Record<string, unknown> = {
      code: e?.sqlstate,
      error: String(e?.message ?? e),
      applicationName: this.client.applicationName,
      database: this.client.database,
      currentSchema: this.currentSchema,
      backendCurrentSchema: this.backendCurrentSchema,
      schemaSource: this.schemaSource,
      schemaCapabilities: this.currentSchemaCapabilities,
    };
    if (config.sql.logFailedText && e?.proxySql) fields.sql = String(e.proxySql);
    if (e?.proxyDb2Sql && (
      /^\s*(?:CREATE|ALTER|DROP|TRUNCATE|COMMENT|GRANT|REVOKE)\b/i.test(String(e.proxyDb2Sql))
      || isDb2Sql7008(e)
    )) {
      // DDL failures are difficult to diagnose from SQLSTATE alone. Include a
      // compact structural form by default, but redact quoted literal values.
      fields.db2SqlShape = safeDdlFailureShape(String(e.proxyDb2Sql));
    }
    this.logger.warn('PostgreSQL session command failed', fields);
    this.send(errorResponse({
      code: e?.sqlstate ?? 'XX000',
      message: e?.message ?? String(error),
      detail: e?.detail,
    }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const releasedAdvisoryLocks = releaseAllPgAdvisoryLocks(this);
    if (releasedAdvisoryLocks > 0) {
      this.logger.info('Released PostgreSQL advisory locks for closed session', {
        count: releasedAdvisoryLocks,
        database: this.client.database,
      });
    }
    if (this.job) {
      const job = this.job; this.job = undefined;
      await this.pool.release(job);
    }
  }
}


function safeDdlFailureShape(sql: string): string {
  return sql
    .replace(/X'[^']*(?:''[^']*)*'/gi, "X'<redacted>'")
    .replace(/'[^']*(?:''[^']*)*'/g, "'<redacted>'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

function frontendMessageName(type: string): string {
  return ({
    Q: 'Query', P: 'Parse', B: 'Bind', D: 'Describe', E: 'Execute',
    S: 'Sync', C: 'Close', H: 'Flush', X: 'Terminate',
  } as Record<string, string>)[type] ?? type;
}

function sameSqlIdentifier(a: string, b: string): boolean {
  return a === b || a.toUpperCase() === b.toUpperCase();
}

function caseInsensitiveValue(row: Record<string, unknown>, name: string): unknown {
  if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(row)) {
    if (key.toUpperCase() === wanted) return value;
  }
  return undefined;
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function splitCatalogColumnNames(value: string | null): string[] {
  if (!value) return [];
  const out: string[] = [];
  let token = '';
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === '"') {
      if (quoted && value[i + 1] === '"') { token += '"'; i++; continue; }
      quoted = !quoted;
      continue;
    }
    if (ch === ',' && !quoted) {
      const item = token.trim();
      if (item) out.push(item);
      token = '';
      continue;
    }
    token += ch;
  }
  const tail = token.trim();
  if (tail) out.push(tail);
  return out;
}

function splitSimpleStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" && !inDouble) {
      if (inSingle && sql[i + 1] === "'") { i++; continue; }
      inSingle = !inSingle;
    } else if (c === '"' && !inSingle) {
      if (inDouble && sql[i + 1] === '"') { i++; continue; }
      inDouble = !inDouble;
    } else if (c === ';' && !inSingle && !inDouble) {
      const part = sql.slice(start, i).trim();
      if (part) statements.push(part);
      start = i + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

function quoteDb2Identifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function normalizeFormats(formats: number[], count: number): number[] {
  if (formats.length === 0) return Array(count).fill(0);
  if (formats.length === 1) return Array(count).fill(formats[0]);
  if (formats.length !== count) throw sqlError('08P01', 'Bind parameter format count mismatch');
  return formats;
}

function columnToField(c: ColumnMetaData): FieldDescription {
  const pg = db2TypeToPg(c.type, c.precision);
  return { name: c.label || c.name, typeOid: pg.oid, typeSize: pg.size, typeModifier: -1, format: 0 };
}

function mapepireFields(result: QueryResult<Record<string, unknown>>): FieldDescription[] {
  return (result.metadata?.columns ?? []).map(columnToField);
}

function statementMayReturnRows(kind: StatementKind): boolean {
  return kind === 'select' || kind === 'values';
}

function getRowValue(row: Record<string, unknown>, c: ColumnMetaData): unknown {
  if (c.label in row) return row[c.label];
  if (c.name in row) return row[c.name];
  const key = Object.keys(row).find((k) => k.toUpperCase() === c.label.toUpperCase() || k.toUpperCase() === c.name.toUpperCase());
  return key ? row[key] : null;
}

function commandTag(kind: StatementKind, result: QueryResult<any>): string {
  // Db2 data-change table references used to implement PostgreSQL RETURNING
  // expose the changed rows as a SELECT rowset and may report update_count=0.
  // In that case the number of returned rows is the PostgreSQL affected-row
  // count for INSERT/UPDATE/DELETE CommandComplete.
  const returned = result.has_results ? (result.data?.length ?? 0) : 0;
  const n = Math.max(0, result.update_count ?? 0, returned);
  switch (kind) {
    case 'select': case 'values': return `SELECT ${result.data?.length ?? 0}`;
    case 'insert': return `INSERT 0 ${n}`;
    case 'update': return `UPDATE ${n}`;
    case 'delete': return `DELETE ${n}`;
    case 'merge': return `MERGE ${n}`;
    case 'set': return 'SET';
    case 'ddl': return 'DDL';
    case 'call': return 'CALL';
    default: return kind.toUpperCase();
  }
}

function sqlError(sqlstate: string, message: string): Error {
  return Object.assign(new Error(message), { sqlstate });
}

function mapDb2Error(error: unknown): Error {
  const e = error as any;
  const text = String(e?.message ?? e);
  const state = e?.sql_state || e?.sqlState
    || text.match(/SQLSTATE[=: ]+([0-9A-Z]{5})/i)?.[1]
    || text.match(/(?:^|,\s*)([0-9A-Z]{5})(?=,|$)/i)?.[1];
  if (state && /^[0-9A-Z]{5}$/i.test(state)) return Object.assign(new Error(text), { sqlstate: state.toUpperCase() });
  const code = text.match(/SQL\d{4,5}/i)?.[0];
  return Object.assign(new Error(text), { sqlstate: code ? 'HY000' : 'XX000', detail: code ? `Db2 for i error ${code}` : undefined });
}

function isDb2Sql7008(error: unknown): boolean {
  const text = String((error as any)?.message ?? error);
  const sqlCode = Number((error as any)?.sql_code ?? (error as any)?.sqlCode);
  return sqlCode === -7008 || /\bSQL7008\b/i.test(text);
}

function isTransportError(error: unknown): boolean {
  const text = String((error as any)?.message ?? error).toLowerCase();
  return /websocket|socket|econn|connection|closed|network|transport|timeout/.test(text);
}

