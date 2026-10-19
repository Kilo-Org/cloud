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

  return process.env.NODE_ENV === 'test'
    ? `${postgresUrl}-${process.env.JEST_WORKER_ID || '1'}`
    : postgresUrl;
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

const VERIFY_CERTIFICATE_BY_SSLMODE: Record<string, boolean> = {
  require: false,
  prefer: false,
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

  if (!sslmode || sslmode === 'disable') return false;

  const verifyCertificate = VERIFY_CERTIFICATE_BY_SSLMODE[sslmode];
  if (verifyCertificate === undefined) {
    throw new Error(`Unsupported sslmode in database URL: ${sslmode}`);
  }

  return { rejectUnauthorized: verifyCertificate };
}
