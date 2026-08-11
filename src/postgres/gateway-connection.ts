import { randomInt } from 'node:crypto';
import type { Socket } from 'node:net';
import { PostgresConnection } from 'pg-gateway';
import type { PostgresConnectionOptions } from 'pg-gateway';
import { backendKeyData } from './wire.js';

/**
 * pg-gateway 0.2.4 sends ReadyForQuery before onAuthenticated(). That ordering
 * is unsuitable for this proxy: pgAdmin/psycopg may immediately start the
 * Extended Query Protocol while the Mapepire session is still being attached.
 *
 * PostgreSQL startup completes only after AuthenticationOk, ParameterStatus,
 * BackendKeyData and ReadyForQuery. We therefore delay ReadyForQuery until the
 * backend session and our detached wire handler are fully installed.
 */
export class ProxyGatewayConnection extends PostgresConnection {
  private readonly syntheticBackendPid = randomInt(1, 0x7fffffff);
  private readonly syntheticSecretKey = randomInt(1, 0x7fffffff);

  get backendPid(): number { return this.syntheticBackendPid; }

  constructor(socket: Socket, options: PostgresConnectionOptions = {}) {
    super(socket, options);
  }

  override async completeAuthentication(): Promise<void> {
    this.isAuthenticated = true;
    this.sendAuthenticationOk();

    // Keep the frontend blocked in startup state while the IBM i SQLJob is
    // leased and the custom PostgreSQL wire parser is attached.
    this.socket.pause();
    try {
      await this.options.onAuthenticated?.(this.state);
      if (this.socket.destroyed) return;

      const p = this.clientInfo?.parameters ?? { user: '' };
      const statuses: Array<[string, string]> = [
        ['server_version', this.options.serverVersion ?? '14.0'],
        ['server_encoding', 'UTF8'],
        ['client_encoding', 'UTF8'],
        ['application_name', p.application_name ?? ''],
        ['DateStyle', 'ISO, MDY'],
        ['integer_datetimes', 'on'],
        ['standard_conforming_strings', 'on'],
        ['IntervalStyle', 'postgres'],
        ['TimeZone', 'UTC'],
        ['default_transaction_read_only', 'off'],
        ['in_hot_standby', 'off'],
        ['session_authorization', p.user ?? ''],
        ['is_superuser', 'off'],
      ];
      for (const [name, value] of statuses) this.sendParameterStatus(name, value);

      // libpq/psycopg exposes this value via Connection.info.backend_pid.
      // Cancellation itself is not implemented yet, but PostgreSQL-compatible
      // clients expect BackendKeyData during a normal startup sequence.
      this.sendData(backendKeyData(this.syntheticBackendPid, this.syntheticSecretKey));
      this.sendReadyForQuery('idle');
    } finally {
      if (!this.socket.destroyed) this.socket.resume();
    }
  }
}
