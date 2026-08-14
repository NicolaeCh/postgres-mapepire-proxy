import http from 'node:http';
import type { SessionJobPool } from './mapepire/session-pool.js';
import { config } from './config.js';

export function createHealthServer(host: string, port: number, pool: SessionJobPool, pgReady: () => boolean) {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/healthz') {
      res.statusCode = 200;
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url === '/readyz') {
      const ready = pgReady() && pool.isReady();
      res.statusCode = ready ? 200 : 503;
      res.end(JSON.stringify({
        status: ready ? 'ready' : 'not-ready',
        pgListening: pgReady(),
        postgres: { database: config.pg.databaseName, defaultSchema: config.ibmi.currentSchema },
        transaction: {
          jdbcAutoCommit: config.ibmi.jdbc['auto commit'],
          isolation: config.ibmi.jdbc['transaction isolation'],
          journaledWritesRequired: config.ibmi.jdbc['transaction isolation'] !== 'none',
        },
        schemaCapabilities: pool.schemaCapabilities(),
        mapepire: pool.stats(),
      }));
      return;
    }
    if (req.url === '/stats') {
      res.statusCode = 200;
      res.end(JSON.stringify({
        postgres: { database: config.pg.databaseName, defaultSchema: config.ibmi.currentSchema },
        transaction: {
          jdbcAutoCommit: config.ibmi.jdbc['auto commit'],
          isolation: config.ibmi.jdbc['transaction isolation'],
          journaledWritesRequired: config.ibmi.jdbc['transaction isolation'] !== 'none',
        },
        schemaCapabilities: pool.schemaCapabilities(),
        mapepire: pool.stats(),
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  server.listen(port, host);
  return server;
}
