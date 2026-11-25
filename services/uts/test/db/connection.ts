import pg from 'pg';

/**
 * Connection settings for the local identity-store Postgres (`scripts/local-db.sh up`). Every
 * password here is a synthetic local value. This module imports nothing from vitest, so the
 * global setup can use it.
 */

export const LOGIN_ROLES = [
  'uts_app_a',
  'uts_app_b',
  'uts_pat_a',
  'uts_pat_b',
  'uts_reader_a',
  'uts_reader_b',
] as const;
export type LoginRole = (typeof LOGIN_ROLES)[number];

export const TEST_LOGIN_PASSWORD = 'uts-local-login';

export function adminUrl(): string {
  return (
    process.env.UTS_TEST_ADMIN_URL ?? 'postgres://uts_admin:uts-local-admin@127.0.0.1:55432/uts'
  );
}

export function databaseUrl(database: string, login?: LoginRole): string {
  const url = new URL(adminUrl());
  url.pathname = `/${database}`;
  if (login !== undefined) {
    url.username = login;
    url.password = TEST_LOGIN_PASSWORD;
  }
  return url.toString();
}

/** Runs `work` on an admin connection to `database`, or to the admin URL's own database. */
export async function withAdmin<Result>(
  database: string | undefined,
  work: (client: pg.Client) => Promise<Result>
): Promise<Result> {
  const client = new pg.Client({
    connectionString: database === undefined ? adminUrl() : databaseUrl(database),
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}
