import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const loaded = require('@ibm/mapepire-js');
const runtime = typeof loaded?.SQLJob === 'function' ? loaded : (loaded?.default ?? loaded);

if (typeof runtime?.SQLJob !== 'function') {
  console.error('ERROR: @ibm/mapepire-js does not expose a SQLJob constructor through CommonJS require().');
  console.error('Available exports:', Object.keys(runtime ?? {}).sort());
  process.exit(1);
}

console.log('Mapepire runtime module check OK:', {
  SQLJob: typeof runtime.SQLJob,
  Pool: typeof runtime.Pool,
  exports: Object.keys(runtime).sort(),
});
