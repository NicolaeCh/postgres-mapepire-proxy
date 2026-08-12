import { config } from './config.js';
import { createHealthServer } from './health.js';
import { Logger } from './logger.js';
import { SessionJobPool } from './mapepire/session-pool.js';
import { createPgServer } from './server.js';

const logger = new Logger(config.logLevel as any);

const pool = new SessionJobPool(
  {
    host: config.ibmi.host,
    port: config.ibmi.port,
    user: config.ibmi.user,
    password: config.ibmi.password,
    rejectUnauthorized: config.ibmi.rejectUnauthorized,
    ca: config.ibmi.ca,
  },
  config.ibmi.jdbc,
  config.ibmi.poolStartingSize,
  config.ibmi.poolMaxSize,
  config.ibmi.poolAcquireTimeoutMs,
  config.ibmi.currentSchema,
  logger,
);

await pool.init();

const pg = createPgServer(pool, logger);
let pgListening = false;
pg.server.on('listening', () => {
  pgListening = true;
  logger.info('PostgreSQL wire listener ready', { host: config.pg.host, port: config.pg.port });
});
pg.server.on('close', () => { pgListening = false; });
pg.server.listen(config.pg.port, config.pg.host);

const health = createHealthServer(config.health.host, config.health.port, pool, () => pgListening);
logger.info('Health listener ready', { host: config.health.host, port: config.health.port });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Graceful shutdown requested', { signal, graceMs: config.shutdownGraceMs });

  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown deadline exceeded; forcing exit');
    process.exit(1);
  }, config.shutdownGraceMs);
  forceExit.unref();

  pg.server.close();
  health.close();
  for (const session of pg.sessions) await session.close();
  await pool.end();
  clearTimeout(forceExit);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error('uncaughtException', { error: error.stack ?? String(error) });
  void shutdown('uncaughtException');
});
process.on('unhandledRejection', (error) => {
  logger.error('unhandledRejection', { error: String(error) });
});
