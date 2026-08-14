import type { DaemonServer, JDBCOptions } from '@ibm/mapepire-js';
import { SQLJob, type SQLJobInstance } from './sdk.js';
import { Logger } from '../logger.js';
import { inspectIbmiSchema, type IbmiSchemaCapabilities } from './schema-capabilities.js';

interface Waiter {
  resolve: (job: SQLJobInstance) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface PoolStats {
  total: number;
  maxSize: number;
  creating: number;
  idle: number;
  leased: number;
  waiters: number;
  ready: number;
  unhealthy: number;
  availableSlots: number;
  saturated: boolean;
}

/**
 * A bounded pool for Mapepire SQLJob objects.
 *
 * ProxySession decides the affinity policy. In the default transaction-pooled
 * mode an autocommit statement checks out a job only while IBM i work is being
 * executed, while an explicit PostgreSQL transaction pins one job until its
 * COMMIT/ROLLBACK. Legacy session affinity is still available by configuration.
 */
export class SessionJobPool {
  private idle: SQLJobInstance[] = [];
  private leased = new Set<SQLJobInstance>();
  private all = new Set<SQLJobInstance>();
  private waiters: Waiter[] = [];
  private creating = 0;
  private ending = false;
  private defaultSchemaCapabilities?: IbmiSchemaCapabilities;
  private readonly schemaCapabilityCache = new Map<string, IbmiSchemaCapabilities>();

  constructor(
    private readonly creds: DaemonServer,
    private readonly jdbc: JDBCOptions,
    private readonly startingSize: number,
    private readonly maxSize: number,
    private readonly acquireTimeoutMs: number,
    private readonly defaultSchema: string,
    private readonly autoCreateCurrentSchema: boolean,
    private readonly requireTransactionalSchema: boolean,
    private readonly logger: Logger,
  ) {}

  async init(): Promise<void> {
    if (this.startingSize < 1) throw new Error('MAPEPIRE_POOL_STARTING_SIZE must be at least 1');

    // Bootstrap one raw Mapepire job before setting CURRENT SCHEMA. This allows
    // IBMI_AUTO_CREATE_CURRENT_SCHEMA to provision a missing SQL schema instead
    // of failing prematurely in SET CURRENT SCHEMA. Once the default is
    // validated, all subsequent jobs are created directly in that schema.
    const bootstrap = await this.createTrackedJob(false);
    this.all.add(bootstrap);
    this.idle.push(bootstrap);
    await this.initializeDefaultSchemaCapabilities();
    await bootstrap.execute(`SET CURRENT SCHEMA ${quoteIdent(this.defaultSchema)}`);
    await bootstrap.execute('COMMIT');

    const remaining = Math.max(0, this.startingSize - 1);
    await Promise.all(Array.from({ length: remaining }, () => this.createIdleJob()));

    this.logger.info('Mapepire session pool initialized', {
      ...this.stats(),
      defaultSchema: this.defaultSchema,
      schemaCapabilities: this.defaultSchemaCapabilities,
    });
  }

  private async initializeDefaultSchemaCapabilities(): Promise<void> {
    const job = this.idle[0];
    if (!job) return;
    const capabilities = await this.prepareSchema(job, this.defaultSchema, true);
    this.defaultSchemaCapabilities = capabilities;
    this.logSchemaTransactionCapability(capabilities, true);
  }

  /**
   * Ensure a selected PostgreSQL application schema is usable on IBM i.
   * This applies to the proxy default and to per-client search_path overrides.
   */
  async prepareSchema(job: SQLJobInstance, schema: string, refresh = false, allowCreate = true): Promise<IbmiSchemaCapabilities> {
    let capabilities = await this.inspectSchema(job, schema, refresh);

    if (!capabilities.exists && this.autoCreateCurrentSchema && allowCreate) {
      this.logger.info('Selected IBM i schema does not exist; creating SQL schema', { schema });
      await job.execute(`CREATE SCHEMA ${quoteIdent(schema)}`);
      this.invalidateSchemaCapabilities(schema);
      capabilities = await this.inspectSchema(job, schema, true);
    }

    if (!capabilities.exists) {
      const createHint = this.autoCreateCurrentSchema && !allowCreate
        ? 'Automatic schema creation is deferred while a PostgreSQL transaction is active; create/select the schema before BEGIN.'
        : 'Create it with SQL CREATE SCHEMA, set IBMI_AUTO_CREATE_CURRENT_SCHEMA=true, or choose an existing PostgreSQL search_path.';
      throw new Error(`Selected IBM i schema ${schema} does not exist. ${createHint}`);
    }

    if (this.requireTransactionalSchema && capabilities.transactionalWritesConfigured !== true) {
      if (capabilities.transactionalWritesConfigured === false) {
        throw new Error(
          `Selected IBM i schema ${schema} has no detected automatic journaling; transactional writes can fail with SQL7008. ` +
          `Create/use an SQL schema or configure STRJRNLIB/STRJRNPF before connecting.`,
        );
      }
      throw new Error(
        `Unable to positively verify automatic journaling for IBM i schema ${schema}. ` +
        `Fix journal authority/configuration or set IBMI_REQUIRE_TRANSACTIONAL_SCHEMA=false. ` +
        `Probe: ${capabilities.probeError ?? 'unknown'}`,
      );
    }

    return capabilities;
  }

  private logSchemaTransactionCapability(capabilities: IbmiSchemaCapabilities, isDefault = false): void {
    const base = {
      schema: capabilities.schema,
      systemSchema: capabilities.systemSchema,
      isDefault,
      hasQsqjrn: capabilities.hasQsqjrn,
      hasLibraryJournalInheritance: capabilities.hasLibraryJournalInheritance,
      inheritedJournal: capabilities.inheritedJournal,
      transactionalWritesConfigured: capabilities.transactionalWritesConfigured,
    };
    if (!capabilities.exists) {
      this.logger.warn('IBM i schema does not exist', base);
    } else if (capabilities.transactionalWritesConfigured === true) {
      this.logger.info('IBM i schema automatic journaling detected', base);
    } else if (capabilities.transactionalWritesConfigured === false) {
      this.logger.warn('IBM i schema has no detected automatic journaling', {
        ...base,
        hint: 'For PostgreSQL transaction semantics, use CREATE SCHEMA or configure library/file journaling',
      });
    } else {
      this.logger.warn('Unable to verify IBM i schema automatic journaling', {
        ...base,
        probeError: capabilities.probeError,
      });
    }
  }


  async inspectSchema(job: SQLJobInstance, schema: string, refresh = false): Promise<IbmiSchemaCapabilities> {
    const key = schema.toUpperCase();
    if (!refresh) {
      const cached = this.schemaCapabilityCache.get(key);
      if (cached) return { ...cached };
    }
    const capabilities = await inspectIbmiSchema(job, schema);
    this.schemaCapabilityCache.set(key, capabilities);
    if (key === this.defaultSchema.toUpperCase()) this.defaultSchemaCapabilities = capabilities;
    return { ...capabilities };
  }

  invalidateSchemaCapabilities(schema?: string): void {
    if (schema) {
      this.schemaCapabilityCache.delete(schema.toUpperCase());
      if (schema.toUpperCase() === this.defaultSchema.toUpperCase()) this.defaultSchemaCapabilities = undefined;
      return;
    }
    this.schemaCapabilityCache.clear();
    this.defaultSchemaCapabilities = undefined;
  }

  schemaCapabilities(): IbmiSchemaCapabilities | undefined {
    return this.defaultSchemaCapabilities ? { ...this.defaultSchemaCapabilities } : undefined;
  }

  private async connectJob(setDefaultSchema = true): Promise<SQLJobInstance> {
    const job = new SQLJob(this.jdbc);
    await job.connect(this.creds);
    if (setDefaultSchema) await job.execute(`SET CURRENT SCHEMA ${quoteIdent(this.defaultSchema)}`);
    return job;
  }

  private async createTrackedJob(setDefaultSchema = true): Promise<SQLJobInstance> {
    this.creating += 1;
    try {
      return await this.connectJob(setDefaultSchema);
    } finally {
      this.creating -= 1;
    }
  }

  private async createIdleJob(): Promise<SQLJobInstance> {
    const job = await this.createTrackedJob();
    this.all.add(job);
    this.idle.push(job);
    return job;
  }

  async acquire(): Promise<SQLJobInstance> {
    if (this.ending) throw new Error('Mapepire pool is shutting down');
    const job = this.idle.shift();
    if (job) {
      this.leased.add(job);
      return job;
    }

    // Include in-flight creations in the cap. Without this reservation, a burst
    // of concurrent PostgreSQL logins could all observe all.size < maxSize and
    // temporarily create more IBM i jobs than configured.
    if (this.all.size + this.creating < this.maxSize) {
      const created = await this.createTrackedJob();
      this.all.add(created);
      this.leased.add(created);
      return created;
    }

    return new Promise<SQLJobInstance>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        const stats = this.stats();
        this.logger.warn('Timed out waiting for Mapepire backend lease', {
          acquireTimeoutMs: this.acquireTimeoutMs,
          ...stats,
        });
        reject(Object.assign(new Error(
          `Timed out waiting ${this.acquireTimeoutMs} ms for Mapepire job ` +
          `(total=${stats.total}, max=${stats.maxSize}, leased=${stats.leased}, idle=${stats.idle}, waiters=${stats.waiters})`,
        ), { sqlstate: '53300' }));
      }, this.acquireTimeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  async release(job: SQLJobInstance): Promise<void> {
    if (!this.all.has(job)) return;
    this.leased.delete(job);

    // Do not leak transaction state from one PostgreSQL client into another.
    try {
      await job.execute('ROLLBACK');
      await job.execute(`SET CURRENT SCHEMA ${quoteIdent(this.defaultSchema)}`);
    } catch (error) {
      await this.invalidate(job, error);
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      this.leased.add(job);
      waiter.resolve(job);
    } else if (!this.ending) {
      this.idle.push(job);
    } else {
      await this.closeJob(job);
    }
  }

  async invalidate(job: SQLJobInstance, reason?: unknown): Promise<void> {
    this.idle = this.idle.filter((j) => j !== job);
    this.leased.delete(job);
    this.all.delete(job);
    await this.closeJob(job);
    this.logger.warn('Discarded Mapepire job', { reason: String(reason ?? 'unknown'), ...this.stats() });

    if (!this.ending && this.all.size + this.creating < this.startingSize) {
      try {
        const replacement = await this.createTrackedJob();
        this.all.add(replacement);
        const waiter = this.waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          this.leased.add(replacement);
          waiter.resolve(replacement);
        } else {
          this.idle.push(replacement);
        }
      } catch (error) {
        this.logger.error('Failed to replace Mapepire job', { error: String(error) });
      }
    }
  }

  private async closeJob(job: SQLJobInstance): Promise<void> {
    try { await job.close(); } catch { /* best effort */ }
  }

  stats(): PoolStats {
    const ready = [...this.all].filter((j) => j.getStatus() === 'ready').length;
    const unhealthy = [...this.all].filter((j) => !['ready', 'busy'].includes(String(j.getStatus()))).length;
    const availableSlots = Math.max(0, this.maxSize - this.all.size - this.creating) + this.idle.length;
    return {
      total: this.all.size,
      maxSize: this.maxSize,
      creating: this.creating,
      idle: this.idle.length,
      leased: this.leased.size,
      waiters: this.waiters.length,
      ready,
      unhealthy,
      availableSlots,
      saturated: this.waiters.length > 0 || (this.idle.length === 0 && this.all.size + this.creating >= this.maxSize),
    };
  }

  isReady(): boolean {
    const s = this.stats();
    return !this.ending && s.total > 0 && s.unhealthy === 0;
  }

  async end(): Promise<void> {
    this.ending = true;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Mapepire pool is shutting down'));
    }
    await Promise.all([...this.all].map((job) => this.closeJob(job)));
    this.idle = [];
    this.leased.clear();
    this.all.clear();
  }
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
