import http from 'node:http';

const port = Number(process.env.HEALTH_LISTEN_PORT ?? 8080);
const host = '127.0.0.1';

const req = http.get({ host, port, path: '/readyz', timeout: 3000 }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('timeout', () => req.destroy(new Error('health timeout')));
req.on('error', () => process.exit(1));
