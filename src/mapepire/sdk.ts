import { createRequire } from 'node:module';
import type { SQLJob as SQLJobClass } from '@ibm/mapepire-js';

/**
 * Runtime compatibility adapter for @ibm/mapepire-js 0.6.x.
 *
 * The package publishes CommonJS at its `main` entry (`dist/index.js`) while
 * its TypeScript declarations expose named exports. Native Node ESM therefore
 * cannot reliably use `import { SQLJob } from '@ibm/mapepire-js'` even though
 * that syntax type-checks. Load the published CommonJS bundle through
 * createRequire() and expose the constructor to the ESM application.
 */
const require = createRequire(import.meta.url);
const loaded = require('@ibm/mapepire-js') as Record<string, unknown> & {
  default?: Record<string, unknown>;
};

const runtime = typeof loaded.SQLJob === 'function'
  ? loaded
  : (loaded.default ?? loaded);

if (typeof runtime.SQLJob !== 'function') {
  throw new Error(
    `Incompatible @ibm/mapepire-js runtime: SQLJob constructor not found. ` +
    `Available exports: ${Object.keys(runtime).sort().join(', ') || '(none)'}`,
  );
}

export const SQLJob = runtime.SQLJob as typeof SQLJobClass;
export type SQLJobInstance = InstanceType<typeof SQLJob>;
