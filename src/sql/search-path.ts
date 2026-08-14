export interface SearchPathSelection {
  schema: string;
  requested: string[];
  ignored: string[];
  scope: 'session' | 'local';
  reset: boolean;
}

function unquoteIdentifier(token: string): string | undefined {
  const t = token.trim();
  if (!t) return undefined;
  if (/^\$user$/i.test(t) || /^"\$user"$/i.test(t)) return undefined;
  if (/^pg_catalog$/i.test(t) || /^pg_temp(?:_\d+)?$/i.test(t)) return undefined;
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replaceAll('""', '"');
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replaceAll("''", "'");
  if (/^[A-Za-z_#$@][A-Za-z0-9_#$@]*$/.test(t)) return t.toUpperCase();
  return undefined;
}

/** Split a PostgreSQL search_path value while respecting quoted identifiers. */
export function splitSearchPath(raw: string): string[] {
  const out: string[] = [];
  let token = '';
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (quote) {
      token += ch;
      if (ch === quote) {
        if (raw[i + 1] === quote) {
          token += raw[i + 1]!;
          i += 1;
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      token += ch;
      continue;
    }
    if (ch === ',') {
      if (token.trim()) out.push(token.trim());
      token = '';
      continue;
    }
    token += ch;
  }
  if (token.trim()) out.push(token.trim());
  return out;
}

export function selectEffectiveSearchPath(raw: string, scope: 'session' | 'local' = 'session'): SearchPathSelection | undefined {
  const requested = splitSearchPath(raw);
  const concrete = requested.map((token) => ({ token, schema: unquoteIdentifier(token) }));
  const selected = concrete.find((entry) => entry.schema !== undefined);
  if (!selected?.schema) return undefined;
  return {
    schema: selected.schema,
    requested,
    ignored: concrete.filter((entry) => entry.token !== selected.token).map((entry) => entry.token),
    scope,
    reset: false,
  };
}

/**
 * Parse PostgreSQL SET search_path / SET SCHEMA / RESET search_path.
 *
 * Db2 for i has one CURRENT SCHEMA register, so the proxy maps the first
 * concrete PostgreSQL search_path element to CURRENT SCHEMA. Remaining path
 * elements are reported as ignored rather than pretending to implement a
 * multi-schema lookup path.
 */
export function parseSearchPathCommand(sql: string, defaultSchema: string): SearchPathSelection | undefined {
  const compact = sql.trim().replace(/;$/, '').trim();
  if (/^RESET\s+SEARCH_PATH$/i.test(compact)) {
    return { schema: defaultSchema, requested: [defaultSchema], ignored: [], scope: 'session', reset: true };
  }

  const schemaAlias = compact.match(/^SET(?:\s+(SESSION|LOCAL))?\s+SCHEMA\s+(.+)$/i);
  if (schemaAlias) {
    const scope = String(schemaAlias[1] ?? '').toUpperCase() === 'LOCAL' ? 'local' : 'session';
    const value = schemaAlias[2]!.trim();
    const schema = unquoteIdentifier(value);
    if (!schema) return undefined;
    return { schema, requested: [value], ignored: [], scope, reset: false };
  }

  const match = compact.match(/^SET(?:\s+(SESSION|LOCAL))?\s+SEARCH_PATH\s*(?:TO|=)\s*(.+)$/i);
  if (!match) return undefined;
  const scope = String(match[1] ?? '').toUpperCase() === 'LOCAL' ? 'local' : 'session';
  const raw = match[2]!.trim();
  if (/^DEFAULT$/i.test(raw)) {
    return { schema: defaultSchema, requested: [defaultSchema], ignored: [], scope, reset: true };
  }
  return selectEffectiveSearchPath(raw, scope);
}

/**
 * Parse libpq StartupMessage `options` such as:
 *   -csearch_path=MCPDATA
 *   -c search_path=MCPDATA,public
 *   --search_path=MCPDATA
 *
 * `options` is the PostgreSQL-standard way for a client/driver to set GUCs at
 * connection startup. Only search_path is interpreted here; other options are
 * left to the existing compatibility layer.
 */
export function parseStartupSearchPath(options: string | undefined): SearchPathSelection | undefined {
  if (!options?.trim()) return undefined;
  const text = options.trim();
  const patterns = [
    /(?:^|\s)-c\s*search_path\s*=\s*("(?:[^"]|"")*"|'(?:[^']|'')*'|[^\s]+)/i,
    /(?:^|\s)-csearch_path\s*=\s*("(?:[^"]|"")*"|'(?:[^']|'')*'|[^\s]+)/i,
    /(?:^|\s)--search_path\s*=\s*("(?:[^"]|"")*"|'(?:[^']|'')*'|[^\s]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const raw = match[1];
    // A quoted whole value is used by some libpq callers, for example
    // -csearch_path='app,public'. Remove the outer quote before splitting.
    const whole = raw.startsWith("'") && raw.endsWith("'")
      ? raw.slice(1, -1).replaceAll("''", "'")
      : raw;
    const selected = selectEffectiveSearchPath(whole, 'session');
    if (selected) return selected;
  }
  return undefined;
}


export interface SearchPathSetConfig {
  selection: SearchPathSelection;
  fieldName: string;
}

/**
 * Parse PostgreSQL set_config('search_path', value, is_local).
 *
 * A number of drivers and frameworks prefer set_config() over SET, especially
 * when applying connection-local settings. Treat it as the same schema-routing
 * operation so the proxy does not merely echo the requested value while leaving
 * Db2 CURRENT SCHEMA unchanged.
 */
export function parseSetConfigSearchPath(sql: string, defaultSchema: string): SearchPathSetConfig | undefined {
  const compact = sql.trim().replace(/;$/, '').replace(/\s+/g, ' ');
  const match = compact.match(
    /^select\s+(?:pg_catalog\.)?set_config\s*\(\s*'search_path'\s*,\s*'((?:''|[^'])*)'\s*,\s*(true|false)\s*\)(?:\s+as\s+([a-z_][a-z0-9_$]*))?(?:\s+from\s+(?:(?:pg_catalog\.)?pg_settings\b|(?:pg_catalog\.)?pg_show_all_settings\s*\(\s*\)).*)?$/i,
  );
  if (!match) return undefined;
  const raw = match[1]!.replaceAll("''", "'");
  const scope = match[2]!.toLowerCase() === 'true' ? 'local' : 'session';
  if (!raw.trim()) {
    return {
      selection: { schema: defaultSchema, requested: [defaultSchema], ignored: [], scope, reset: true },
      fieldName: match[3] ?? 'set_config',
    };
  }
  const selection = selectEffectiveSearchPath(raw, scope);
  if (!selection) return undefined;
  return { selection, fieldName: match[3] ?? 'set_config' };
}
