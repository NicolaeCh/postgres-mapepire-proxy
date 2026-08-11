import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function commonJsRuntime(name, requiredExport) {
  const loaded = require(name);
  const runtime = typeof loaded?.[requiredExport] === 'function' ? loaded : (loaded?.default ?? loaded);
  if (typeof runtime?.[requiredExport] !== 'function') {
    console.error(`ERROR: ${name} does not expose ${requiredExport} through CommonJS require().`);
    console.error('Available exports:', Object.keys(runtime ?? {}).sort());
    process.exit(1);
  }
  return runtime;
}

const mapepire = commonJsRuntime('@ibm/mapepire-js', 'SQLJob');
console.log('Mapepire runtime module check OK:', {
  SQLJob: typeof mapepire.SQLJob,
  Pool: typeof mapepire.Pool,
  exports: Object.keys(mapepire).sort(),
});

const sqlParser = commonJsRuntime('node-sql-parser', 'Parser');
try {
  const parser = new sqlParser.Parser();
  const ast = parser.astify('SELECT 1 AS one', { database: 'Postgresql' });
  const node = Array.isArray(ast) ? ast[0] : ast;
  if (String(node?.type ?? '').toLowerCase() !== 'select') {
    throw new Error(`unexpected AST type ${String(node?.type)}`);
  }
} catch (error) {
  console.error('ERROR: node-sql-parser Parser exists but cannot parse a PostgreSQL SELECT:', error);
  process.exit(1);
}
console.log('node-sql-parser runtime module check OK:', {
  Parser: typeof sqlParser.Parser,
  exports: Object.keys(sqlParser).sort(),
});


try {
  await import('dotenv/config');
  console.log('dotenv/config runtime module check OK');
} catch (error) {
  console.error('ERROR: dotenv/config runtime import check failed:', error);
  process.exit(1);
}

try {
  const pgGateway = await import('pg-gateway');
  if (typeof pgGateway.PostgresConnection !== 'function') {
    throw new Error(`PostgresConnection is ${typeof pgGateway.PostgresConnection}`);
  }
  if (typeof pgGateway.hashMd5Password !== 'function') {
    throw new Error(`hashMd5Password is ${typeof pgGateway.hashMd5Password}`);
  }
  console.log('pg-gateway runtime module check OK:', {
    PostgresConnection: typeof pgGateway.PostgresConnection,
    hashMd5Password: typeof pgGateway.hashMd5Password,
    exports: Object.keys(pgGateway).sort(),
  });
} catch (error) {
  console.error('ERROR: pg-gateway ESM runtime export check failed:', error);
  process.exit(1);
}
