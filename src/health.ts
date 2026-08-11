import http from 'node:http';
import type { SessionJobPool } from './mapepire/session-pool.js';

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
      res.end(JSON.stringify({ status: ready ? 'ready' : 'not-ready', pgListening: pgReady(), mapepire: pool.stats() }));
      return;
    }
    if (req.url === '/stats') {
      res.statusCode = 200;
      res.end(JSON.stringify({ mapepire: pool.stats() }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  server.listen(port, host);
  return server;
}
