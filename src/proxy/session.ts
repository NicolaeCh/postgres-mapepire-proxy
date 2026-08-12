import type { QueryResult, ColumnMetaData } from '@ibm/mapepire-js';
import { createHash } from 'node:crypto';
import type { SQLJobInstance } from '../mapepire/sdk.js';
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
  registerIbmiTables, lookupRegisteredIbmiTable,
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
import { reorderParameters, translateSql, type Translation } from '../sql/translator.js';

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


export interface ClientInfo { user?: string; database?: string; applicationName?: string; backendPid?: number; }

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
  private schemaCache?: { expiresAt: number; rows: IbmiSchemaRow[] };
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
    this.logger.debug('Mapepire job leased to PostgreSQL session', { user: this.client.user, database: this.client.database });
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

      const local = await this.resolveSynthetic(stmt.sql);
      if (local) {
        this.validateSynthetic(local);
        if (local.fields.length) this.send(rowDescription(local.fields));
        else this.send(noData());
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

    const local = await this.resolveSynthetic(stmt.sql);
    if (local) {
      this.validateSynthetic(local);
      portal.synthetic = local;
      portal.descriptionSent = true;
      if (local.fields.length) this.send(rowDescription(local.fields));
      else this.send(noData());
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

    if (isSavepointCommand(sql)) {
      throw sqlError('0A000', 'SAVEPOINT, RELEASE SAVEPOINT and ROLLBACK TO SAVEPOINT are not supported by proxy v0.1');
    }

    const rawKind = classify(sql);
    if (this.transactionFailed && rawKind !== 'rollback' && rawKind !== 'commit') {
      throw sqlError('25P02', 'Current transaction is aborted, commands ignored until end of transaction block');
    }

    if (rawKind === 'begin') {
      this.inTransaction = true;
      this.transactionFailed = false;
      this.send(commandComplete('BEGIN'));
      return;
    }
    if (rawKind === 'commit') {
      if (this.transactionFailed) {
        await this.currentJob().execute('ROLLBACK');
        this.inTransaction = false; this.transactionFailed = false;
        this.send(commandComplete('ROLLBACK'));
      } else {
        await this.currentJob().execute('COMMIT');
        this.inTransaction = false;
        this.send(commandComplete('COMMIT'));
      }
      return;
    }
    if (rawKind === 'rollback') {
      await this.currentJob().execute('ROLLBACK');
      this.inTransaction = false; this.transactionFailed = false;
      this.send(commandComplete('ROLLBACK'));
      return;
    }

    const searchPath = parseSearchPath(sql);
    if (searchPath) {
      await this.currentJob().execute(`SET CURRENT SCHEMA ${quoteDb2Identifier(searchPath)}`);
      this.currentSchema = searchPath;
      this.send(commandComplete('SET'));
      return;
    }

    const synthetic = await this.resolveSynthetic(sql);
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

    let translation: Translation;
    try {
      translation = translateSql(sql, config.sql);
      if (config.sql.logText) this.logger.info('Translated SQL', { original: sql, db2: translation.sql });
    } catch (error) {
      throw error;
    }

    const values = reorderParameters(parameters, translation.parameterOrder);
    let result: QueryResult<Record<string, unknown>>;
    try {
      result = await this.executeWithSafeRetry(translation, values, maxRows);

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
      const mapped = mapDb2Error(error) as Error & { proxySql?: string };
      mapped.proxySql = sql;
      throw mapped;
    }

    if (result.has_results) this.sendMapepireRows(result, maxRows, includeDescription);
    this.send(commandComplete(commandTag(translation.kind, result)));
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

  private async resolveSynthetic(sql: string): Promise<SyntheticResult | undefined> {
    const env = environmentQuery(sql, config.pg.databaseName, this.currentSchema);
    if (env) return env;

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
      const mapped = mapDb2Error(error) as Error & { proxySql?: string };
      mapped.proxySql = sql;
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
    };
    if (config.sql.logFailedText && e?.proxySql) fields.sql = String(e.proxySql);
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
    if (this.job) {
      const job = this.job; this.job = undefined;
      await this.pool.release(job);
    }
  }
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

function isSavepointCommand(sql: string): boolean {
  const compact = sql.trim().replace(/;$/, '');
  return /^(?:SAVEPOINT\b|RELEASE\s+(?:SAVEPOINT\s+)?|ROLLBACK\s+TO(?:\s+SAVEPOINT)?\b)/i.test(compact);
}

function parseSearchPath(sql: string): string | undefined {
  const compact = sql.trim().replace(/;$/, '');
  const match = compact.match(/^SET(?:\s+(?:SESSION|LOCAL))?\s+SEARCH_PATH\s*(?:TO|=)\s*("(?:[^"]|"")*"|[A-Za-z_#$@][A-Za-z0-9_#$@]*)/i);
  if (!match) return undefined;
  const raw = match[1]!;
  if (raw.startsWith('"')) return raw.slice(1, -1).replaceAll('""', '"');
  return raw.toUpperCase();
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
  const n = Math.max(0, result.update_count ?? 0);
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

function isTransportError(error: unknown): boolean {
  const text = String((error as any)?.message ?? error).toLowerCase();
  return /websocket|socket|econn|connection|closed|network|transport|timeout/.test(text);
}

