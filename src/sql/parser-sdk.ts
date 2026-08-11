import { createRequire } from 'node:module';
import type { Parser as ParserClass } from 'node-sql-parser';

// node-sql-parser 5.x is published for CommonJS consumption. Its TypeScript
// declarations make a named ESM import look valid at compile time, but Node 24
// does not expose `Parser` as a named ESM export at runtime. Keep the interop
// in one module and use the package exactly as its upstream documentation does:
// require('node-sql-parser').Parser.
const require = createRequire(import.meta.url);
const loaded = require('node-sql-parser') as {
  Parser?: typeof ParserClass;
  default?: { Parser?: typeof ParserClass };
};

const runtime = typeof loaded?.Parser === 'function' ? loaded : (loaded?.default ?? loaded);

if (typeof runtime?.Parser !== 'function') {
  throw new Error(
    `node-sql-parser runtime does not expose Parser through CommonJS require(); exports=${Object.keys(runtime ?? {}).sort().join(',')}`,
  );
}

export const Parser = runtime.Parser as typeof ParserClass;
