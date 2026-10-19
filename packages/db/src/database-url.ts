import type { ClientConfig } from 'pg';

export function computeDatabaseUrl(): string {
  // Check if we should use production database
  const useProductionDb = process.env.USE_PRODUCTION_DB === 'true';

  const postgresUrl = useProductionDb
    ? process.env.POSTGRES_URL_PRODUCTION || ''
    : process.env.POSTGRES_URL || '';

  if (!postgresUrl) {
    throw new Error(
      useProductionDb ? 'POSTGRES_URL_PRODUCTION not configured' : 'POSTGRES_URL not configured'
    );
  }

  if (process.env.NODE_ENV !== 'test') {
    return postgresUrl;
  }

  // Isolate each Jest worker's database. Append to the path segment so query
  // parameters such as sslmode stay valid instead of becoming part of the
  // last parameter's value.
  const workerId = process.env.JEST_WORKER_ID || '1';
  const url = new URL(postgresUrl);
  url.pathname = `${url.pathname}-${workerId}`;
  return url.toString();
}

export function getDatabaseClientConfig(postgresUrl: string): ClientConfig {
  const databaseUrl = new URL(postgresUrl);
  const clientConfig: ClientConfig = {
    user: databaseUrl.username,
    password: databaseUrl.password,
    host: databaseUrl.hostname,
    port: Number(databaseUrl.port),
    database: databaseUrl.pathname.slice(1),
  };

  if (process.env.DATABASE_CA) {
    clientConfig.ssl = {
      ca: process.env.DATABASE_CA.replace(/\\n/g, '\n'),
      rejectUnauthorized: true,
      servername: databaseUrl.hostname,
    };
  } else {
    clientConfig.ssl = resolveSslFromSslmode(databaseUrl);
  }

  return clientConfig;
}

/**
 * The connection string's sslmode decides whether TLS is used when `DATABASE_CA`
 * is unset. `require`/`prefer` encrypt without a certificate check;
 * `verify-ca`/`verify-full` verify the server certificate against the Node
 * system trust store. `allow` negotiates plaintext first and upgrades to TLS,
 * which Node's `pg` cannot retry, so it is treated like `disable` rather than
 * forcing a connection style the caller did not pin down.
 */
const VERIFY_CERTIFICATE_BY_SSLMODE: Record<string, boolean> = {
  prefer: false,
  require: false,
  'verify-ca': true,
  'verify-full': true,
};

/**
 * `DATABASE_CA` is unset, so the connection string itself decides whether TLS is
 * used. Encrypted transport without a certificate check still defeats passive
 * eavesdropping; certificate verification relies on the Node system trust store.
 */
function resolveSslFromSslmode(databaseUrl: URL): ClientConfig['ssl'] {
  const sslmode = databaseUrl.searchParams.get('sslmode')?.trim().toLowerCase();

  if (!sslmode || sslmode === 'disable' || sslmode === 'allow') return false;

  // Object.hasOwn so inherited keys like 'constructor' never resolve to a mode.
  if (!Object.hasOwn(VERIFY_CERTIFICATE_BY_SSLMODE, sslmode)) {
    throw new Error(`Unsupported sslmode in database URL: ${sslmode}`);
  }

  return { rejectUnauthorized: VERIFY_CERTIFICATE_BY_SSLMODE[sslmode] };
}
