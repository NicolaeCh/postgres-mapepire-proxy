import type { SQLJob, QueryResult, ColumnMetaData } from '@ibm/mapepire-js';
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
import { reorderParameters, translateSql, type Translation } from '../sql/translator.js';

interface PreparedStatement { sql: string; parameterOids: number[]; translation?: Translation; }
interface Portal { statementName: string; parameters: unknown[]; resultFormats: number[]; }

export interface ClientInfo { user?: string; database?: string; applicationName?: string; }

export class ProxySession {
  private job?: SQLJob;
  private prepared = new Map<string, PreparedStatement>();
  private portals = new Map<string, Portal>();
  private inTransaction = false;
  private transactionFailed = false;
  private closed = false;
  private chain: Promise<void> = Promise.resolve();
  private extendedError = false;
  private currentSchema = config.ibmi.defaultSchema;
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
    this.portals.set(b.portal, { statementName: b.statement, parameters: values, resultFormats: b.resultFormats });
    this.send(bindComplete());
  }

  private async describe(body: Buffer): Promise<void> {
    const d = decodeDescribe(body);
    if (d.target === 'S') {
      const stmt = this.prepared.get(d.name);
      if (!stmt) throw sqlError('26000', `Prepared statement ${d.name} does not exist`);
      this.send(parameterDescription(stmt.parameterOids));
      // Mapepire exposes result metadata on execution rather than a prepare-only describe call.
      // NoData is protocol-valid; actual RowDescription is returned at Execute time.
      this.send(noData());
    } else {
      if (!this.portals.has(d.name)) throw sqlError('34000', `Portal ${d.name} does not exist`);
      this.send(noData());
    }
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
    await this.executeSql(stmt.sql, portal.parameters, e.maxRows);
  }

  private async simpleQuery(sql: string): Promise<void> {
    if (!sql.trim()) { this.send(emptyQueryResponse()); this.send(readyForQuery(this.txStatus())); return; }
    await this.executeSql(sql, [], 0);
    this.send(readyForQuery(this.txStatus()));
  }

  private async executeSql(sql: string, parameters: unknown[], maxRows: number): Promise<void> {
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

    const env = environmentQuery(sql, this.client.database ?? 'ibmi', this.currentSchema);
    if (env) { this.sendSynthetic(env); return; }
    if (rawKind === 'set') {
      throw sqlError('0A000', 'This PostgreSQL SET option is not supported by proxy v0.1');
    }
    const cat = syntheticCatalog(sql);
    if (cat) { this.sendSynthetic(cat); return; }

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
      throw mapDb2Error(error);
    }

    if (result.has_results) this.sendMapepireRows(result, maxRows);
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

  private sendSynthetic(result: SyntheticResult): void {
    if (result.fields.length) {
      this.send(rowDescription(result.fields));
      for (const row of result.rows) this.send(dataRow(row));
    }
    this.send(commandComplete(result.tag));
  }

  private sendMapepireRows(result: QueryResult<Record<string, unknown>>, maxRows: number): void {
    const columns = result.metadata?.columns ?? [];
    const fields = columns.map(columnToField);
    this.send(rowDescription(fields));
    const rows = maxRows > 0 ? result.data.slice(0, maxRows) : result.data;
    for (const row of rows) {
      this.send(dataRow(columns.map((c) => getRowValue(row, c))));
    }
  }

  private currentJob(): SQLJob {
    if (!this.job) throw new Error('Mapepire job not initialized');
    return this.job;
  }

  private async handleUnexpected(error: unknown): Promise<void> {
    const e = error as any;
    this.logger.warn('PostgreSQL session command failed', { code: e?.sqlstate, error: String(e?.message ?? e) });
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

