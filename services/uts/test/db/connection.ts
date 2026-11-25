import pg from 'pg';
import { isLoopbackHost } from '../../scripts/connection';

/**
 * Connection settings for the local identity-store Postgres (`scripts/local-db.sh up`). This
 * module imports nothing from vitest, so the global setup can use it.
 *
 * The global setup changes cluster-wide roles and drops databases, so it runs only against a
 * loopback host. The UTS logins get a random password per run, never one stored in the repo.
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

/** A UTS login and this run's password for it. */
export type Login = { role: LoginRole; password: string };

const LOCAL_ADMIN_URL = 'postgres://uts_admin:uts-local-admin@127.0.0.1:55432/uts';

export class NonLocalDatabaseError extends Error {
  override name = 'NonLocalDatabaseError';
}

/** The local admin URL, or `UTS_TEST_ADMIN_URL` when it names a loopback host. */
export function adminUrl(): string {
  const url = new URL(process.env.UTS_TEST_ADMIN_URL ?? LOCAL_ADMIN_URL);
  if (!isLoopbackHost(url)) {
    throw new NonLocalDatabaseError(
      `UTS_TEST_ADMIN_URL must name 127.0.0.1, localhost or ::1, not ${url.hostname}`
    );
  }
  return url.toString();
}

export function databaseUrl(database: string, login?: Login): string {
  const url = new URL(adminUrl());
  url.pathname = `/${database}`;
  if (login !== undefined) {
    url.username = login.role;
    url.password = login.password;
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
