import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { hashMd5Password } from 'pg-gateway';
import { config } from './config.js';
import { Logger } from './logger.js';
import { SessionJobPool } from './mapepire/session-pool.js';
import { ProxySession } from './proxy/session.js';
import { ProxyGatewayConnection } from './postgres/gateway-connection.js';

export function createPgServer(pool: SessionJobPool, logger: Logger) {
  let clients = 0;
  const sessions = new Set<ProxySession>();

  const server = net.createServer((socket) => {
    if (clients >= config.pg.maxClients) {
      socket.destroy(new Error('too many clients'));
      return;
    }
    clients++;
    socket.setKeepAlive(true);
    socket.setTimeout(config.pg.idleTimeoutMs);

    let session: ProxySession | undefined;
    let detachedProtocolSocket: net.Socket | undefined;
    let finalized = false;
    const connection = new ProxyGatewayConnection(socket, {
      serverVersion: config.pg.serverVersion,
      authMode: config.pg.authMode,
      tls: config.pg.tls,
      async validateCredentials(credentials: any) {
        if (config.pg.authMode === 'none') return true;
        if (credentials.authMode === 'cleartextPassword') {
          return timingSafe(credentials.user, config.pg.user) && timingSafe(credentials.password, config.pg.password);
        }
        if (credentials.authMode === 'md5Password') {
          if (!timingSafe(credentials.user, config.pg.user)) return false;
          const expected = await hashMd5Password(config.pg.user, config.pg.password, credentials.salt);
          return timingSafe(credentials.hash, expected);
        }
        return false;
      },
      async onAuthenticated(state: any) {
        const parameters = state.clientInfo?.parameters ?? {};
        session = new ProxySession(connection, pool, {
          user: parameters.user,
          database: parameters.database,
          applicationName: parameters.application_name,
          backendPid: connection.backendPid,
        }, logger);
        try {
          await session.initialize();
          if (connection.socket.destroyed) {
            await session.close();
            session = undefined;
            return;
          }
          sessions.add(session);
          logger.info('PostgreSQL client session authenticated', {
            user: parameters.user,
            database: parameters.database,
            applicationName: parameters.application_name,
          });

          // pg-gateway 0.2.x is used for PostgreSQL startup/TLS/authentication.
          // Once authentication succeeds, detach its parser and let our own
          // incremental protocol engine consume Query/Parse/Bind/Execute/Sync.
          // This avoids relying on the upstream 0.2.x query TODO and correctly
          // handles coalesced/fragmented Extended Query Protocol frames.
          detachedProtocolSocket = connection.detach() as net.Socket;
          detachedProtocolSocket.setKeepAlive(true);
          detachedProtocolSocket.setTimeout(config.pg.idleTimeoutMs);
          detachedProtocolSocket.on('data', (data) => {
            const protocolSocket = detachedProtocolSocket;
            const activeSession = session;
            if (!protocolSocket || !activeSession) return;
            // Node's stream typings may expose data as string | Buffer depending
            // on the active @types/node version. No encoding is configured on
            // this socket, so Buffer is expected at runtime; normalize anyway
            // to keep the protocol boundary typed as Uint8Array.
            const chunk = typeof data === 'string' ? Buffer.from(data) : data;
            // Apply TCP backpressure while a Mapepire command is being handled.
            // This prevents a fast/malicious frontend from accumulating an
            // unbounded queue of protocol chunks behind a slow IBM i query.
            protocolSocket.pause();
            void activeSession.handleRaw(chunk).finally(() => {
              if (!protocolSocket.destroyed) protocolSocket.resume();
            });
          });
          detachedProtocolSocket.on('timeout', () => detachedProtocolSocket?.destroy());
          if (detachedProtocolSocket !== socket) {
            detachedProtocolSocket.on('error', (error) => logger.debug('PostgreSQL TLS socket error', { error: String(error) }));
            detachedProtocolSocket.on('close', finalize);
          }
        } catch (error) {
          connection.sendError({ severity: 'FATAL', code: '08001', message: `IBM i backend unavailable: ${String(error)}` });
          connection.socket.destroy();
        }
      },
    });

    const cleanup = async () => {
      if (session) { sessions.delete(session); await session.close(); session = undefined; }
    };
    function finalize() {
      if (finalized) return;
      finalized = true;
      clients--;
      void cleanup();
    }
    socket.on('timeout', () => socket.destroy());
    socket.on('error', (error) => logger.debug('PostgreSQL client socket error', { error: String(error) }));
    socket.on('close', finalize);
  });

  return { server, sessions, getClientCount: () => clients };
}

function timingSafe(a: string, b: string): boolean {
  const aa = Buffer.from(a ?? '');
  const bb = Buffer.from(b ?? '');
  if (aa.length !== bb.length) return false;
  return timingSafeEqual(aa, bb);
}
