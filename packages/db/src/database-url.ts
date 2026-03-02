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
      ca: process.env.DATABASE_CA,
    };
  } else {
    clientConfig.ssl = false;
  }

  return clientConfig;
}
