import type { DaemonServer, JDBCOptions } from '@ibm/mapepire-js';
import { SQLJob, type SQLJobInstance } from './sdk.js';
import { Logger } from '../logger.js';

interface Waiter {
  resolve: (job: SQLJobInstance) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface PoolStats {
  total: number;
  creating: number;
  idle: number;
  leased: number;
  waiters: number;
  ready: number;
  unhealthy: number;
}

/**
 * A session-affinity pool for Mapepire SQLJob objects.
 *
 * Mapepire's built-in Pool is ideal for stateless query dispatch. A PostgreSQL
 * connection needs stronger affinity: BEGIN/COMMIT/ROLLBACK, CURRENT SCHEMA and
 * prepared work must remain on the same Db2 job. This pool therefore leases one
 * SQLJob for the lifetime of each PostgreSQL session.
 */
export class SessionJobPool {
  private idle: SQLJobInstance[] = [];
  private leased = new Set<SQLJobInstance>();
  private all = new Set<SQLJobInstance>();
  private waiters: Waiter[] = [];
  private creating = 0;
  private ending = false;

  constructor(
    private readonly creds: DaemonServer,
    private readonly jdbc: JDBCOptions,
    private readonly startingSize: number,
    private readonly maxSize: number,
    private readonly acquireTimeoutMs: number,
    private readonly defaultSchema: string,
    private readonly logger: Logger,
  ) {}

  async init(): Promise<void> {
    await Promise.all(Array.from({ length: this.startingSize }, () => this.createIdleJob()));
    this.logger.info('Mapepire session pool initialized', this.stats());
  }

  private async connectJob(): Promise<SQLJobInstance> {
    const job = new SQLJob(this.jdbc);
    await job.connect(this.creds);
    await job.execute(`SET CURRENT SCHEMA ${quoteIdent(this.defaultSchema)}`);
    return job;
  }

  private async createTrackedJob(): Promise<SQLJobInstance> {
    this.creating += 1;
    try {
      return await this.connectJob();
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
        reject(new Error(`Timed out waiting ${this.acquireTimeoutMs} ms for Mapepire job`));
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
    return {
      total: this.all.size,
      creating: this.creating,
      idle: this.idle.length,
      leased: this.leased.size,
      waiters: this.waiters.length,
      ready,
      unhealthy,
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
