import 'dotenv/config';
import { readFileSync } from 'node:fs';
import type { JDBCOptions } from '@ibm/mapepire-js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function str(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be numeric`);
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

function csv(name: string): string[] | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const values = raw.split(',').map((v) => v.trim()).filter(Boolean);
  return values.length ? values : undefined;
}

function maybeFile(path: string | undefined): Buffer | undefined {
  if (!path?.trim()) return undefined;
  return readFileSync(path.trim());
}


const lobIndexPolicies = ['skip', 'error'] as const;
type LobIndexPolicy = (typeof lobIndexPolicies)[number];
function lobIndexPolicy(): LobIndexPolicy {
  const value = str('SQL_UNSUPPORTED_NONUNIQUE_LOB_INDEX_POLICY', 'skip') as LobIndexPolicy;
  if (!lobIndexPolicies.includes(value)) {
    throw new Error(`SQL_UNSUPPORTED_NONUNIQUE_LOB_INDEX_POLICY must be one of ${lobIndexPolicies.join(',')}`);
  }
  return value;
}

const authModes = ['none', 'cleartextPassword', 'md5Password'] as const;
type AuthMode = (typeof authModes)[number];
function authMode(): AuthMode {
  const value = str('PG_AUTH_MODE', 'md5Password') as AuthMode;
  if (!authModes.includes(value)) throw new Error(`Unsupported PG_AUTH_MODE=${value}`);
  return value;
}

const blockSizes = ['0', '8', '16', '32', '64', '128', '256', '512'] as const;
const blockSize = str('MAPEPIRE_JDBC_BLOCK_SIZE', '128');
if (!(blockSizes as readonly string[]).includes(blockSize)) {
  throw new Error('MAPEPIRE_JDBC_BLOCK_SIZE must be one of 0,8,16,32,64,128,256,512');
}

const isolation = str('MAPEPIRE_JDBC_TRANSACTION_ISOLATION', 'read committed') as
  | 'none'
  | 'read uncommitted'
  | 'read committed'
  | 'repeatable read'
  | 'serializable';

const jdbc: JDBCOptions = {
  naming: str('MAPEPIRE_JDBC_NAMING', 'sql') as 'sql' | 'system',
  libraries: csv('MAPEPIRE_JDBC_LIBRARIES'),
  'date format': str('MAPEPIRE_JDBC_DATE_FORMAT', 'iso') as JDBCOptions['date format'],
  'time format': str('MAPEPIRE_JDBC_TIME_FORMAT', 'iso') as JDBCOptions['time format'],
  'decimal separator': str('MAPEPIRE_JDBC_DECIMAL_SEPARATOR', '.') as JDBCOptions['decimal separator'],
  'auto commit': bool('MAPEPIRE_JDBC_AUTO_COMMIT', false),
  'transaction isolation': isolation,
  'block size': blockSize as JDBCOptions['block size'],
  'data compression': bool('MAPEPIRE_JDBC_DATA_COMPRESSION', true),
  prefetch: bool('MAPEPIRE_JDBC_PREFETCH', true),
  'extended metadata': bool('MAPEPIRE_JDBC_EXTENDED_METADATA', true),
  'keep alive': bool('MAPEPIRE_JDBC_KEEP_ALIVE', true),
  'query timeout mechanism': str(
    'MAPEPIRE_JDBC_QUERY_TIMEOUT_MECHANISM',
    'cancel',
  ) as JDBCOptions['query timeout mechanism'],
};
const storageLimit = process.env.MAPEPIRE_JDBC_QUERY_STORAGE_LIMIT?.trim();
if (storageLimit) jdbc['query storage limit'] = storageLimit;

const tlsEnabled = bool('PG_TLS_ENABLED', false);
const ibmiRdbName = required('IBMI_RDB_NAME').toUpperCase();
const ibmiCurrentSchema = str('IBMI_CURRENT_SCHEMA', str('DEFAULT_SCHEMA', 'QGPL')).toUpperCase();

export const config = {
  pg: {
    host: str('PG_LISTEN_HOST', '0.0.0.0'),
    // One proxy instance represents one IBM i relational database. Expose that
    // RDB as the single PostgreSQL database rather than accepting arbitrary
    // StartupMessage database labels.
    databaseName: ibmiRdbName,
    port: num('PG_LISTEN_PORT', 5432),
    serverVersion: str('PG_SERVER_VERSION', '14.0'),
    maxClients: num('PG_MAX_CLIENTS', 100),
    idleTimeoutMs: num('PG_CLIENT_IDLE_TIMEOUT_MS', 1_800_000),
    maxFrontendMessageBytes: num('PG_MAX_FRONTEND_MESSAGE_BYTES', 16 * 1024 * 1024),
    protocolTrace: bool('PG_PROTOCOL_TRACE', false),
    pgadminSchemaCacheMs: num('PGADMIN_SCHEMA_CACHE_MS', 10_000),
    pgadminHideSystemSchemas: bool('PGADMIN_HIDE_SYSTEM_SCHEMAS', true),
    authMode: authMode(),
    user: process.env.PG_PROXY_USER?.trim() || '',
    password: process.env.PG_PROXY_PASSWORD || '',
    tls: tlsEnabled
      ? {
          key: maybeFile(required('PG_TLS_KEY_FILE'))!,
          cert: maybeFile(required('PG_TLS_CERT_FILE'))!,
          ca: maybeFile(process.env.PG_TLS_CA_FILE),
        }
      : undefined,
  },
  ibmi: {
    rdbName: ibmiRdbName,
    host: required('IBMI_HOST'),
    port: num('MAPEPIRE_PORT', 8076),
    user: required('IBMI_USER'),
    password: required('IBMI_PASSWORD'),
    rejectUnauthorized: bool('MAPEPIRE_REJECT_UNAUTHORIZED', true),
    ca: maybeFile(process.env.MAPEPIRE_CA_FILE),
    // IBMI_CURRENT_SCHEMA is the preferred name. DEFAULT_SCHEMA remains as a
    // backward-compatible alias for deployments created before 0.1.14.
    currentSchema: ibmiCurrentSchema,
    defaultSchema: ibmiCurrentSchema,
    // If the configured application schema does not exist, the proxy can
    // provision it with CREATE SCHEMA. On IBM i this is preferable to CRTLIB
    // for transactional applications because an SQL schema includes the SQL
    // journaling infrastructure used by commitment control.
    autoCreateCurrentSchema: bool('IBMI_AUTO_CREATE_CURRENT_SCHEMA', false),
    // Optional deployment guard. Leave false for read-only/legacy libraries;
    // set true for PostgreSQL applications that require transactional writes.
    requireTransactionalSchema: bool('IBMI_REQUIRE_TRANSACTIONAL_SCHEMA', false),
    jdbc,
    poolStartingSize: num('MAPEPIRE_POOL_STARTING_SIZE', 4),
    poolMaxSize: num('MAPEPIRE_POOL_MAX_SIZE', 12),
    poolAcquireTimeoutMs: num('MAPEPIRE_POOL_ACQUIRE_TIMEOUT_MS', 30_000),
    reconnectRetries: num('MAPEPIRE_RECONNECT_RETRIES', 0),
    fetchSize: num('MAPEPIRE_FETCH_SIZE', 500),
  },
  sql: {
    uppercaseIdentifiers: bool('SQL_UPPERCASE_UNQUOTED_IDENTIFIERS', true),
    informationSchemaRewrite: bool('SQL_ENABLE_INFORMATION_SCHEMA_REWRITE', true),
    pgCatalogCompat: bool('SQL_ENABLE_PG_CATALOG_COMPAT', true),
    allowMultiStatement: bool('SQL_ALLOW_MULTI_STATEMENT', false),
    maxRows: num('SQL_MAX_ROWS', 0),
    ddlDefaultVarcharLength: num('SQL_DDL_DEFAULT_VARCHAR_LENGTH', 1024),
    unsupportedNonuniqueLobIndexPolicy: lobIndexPolicy(),
    logText: bool('SQL_LOG_TEXT', false),
    logFailedText: bool('SQL_LOG_FAILED_TEXT', false),
  },
  health: {
    host: str('HEALTH_LISTEN_HOST', '0.0.0.0'),
    port: num('HEALTH_LISTEN_PORT', 8080),
  },
  logLevel: str('LOG_LEVEL', 'info'),
  shutdownGraceMs: num('SHUTDOWN_GRACE_MS', 15_000),
};

if (config.ibmi.poolStartingSize < 1) {
  throw new Error('MAPEPIRE_POOL_STARTING_SIZE must be at least 1');
}
if (config.ibmi.poolStartingSize > config.ibmi.poolMaxSize) {
  throw new Error('MAPEPIRE_POOL_STARTING_SIZE cannot exceed MAPEPIRE_POOL_MAX_SIZE');
}
if (config.pg.authMode !== 'none' && (!config.pg.user || !config.pg.password)) {
  throw new Error('PG_PROXY_USER and PG_PROXY_PASSWORD are required when authentication is enabled');
}
