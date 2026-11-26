import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { isLoopbackHost } from './connection';
import { applyMigrations, loadMigrations } from './migrator';

/**
 * A fresh identity-store database for one local end-to-end run.
 *
 * `UTS_E2E_ADMIN_URL` names the local admin login (`scripts/local-db.sh up`), on a loopback host
 * and without query parameters, as for `scripts/migrate.ts`. The run drops and recreates the
 * database it asks for, applies every migration, and gives the logins the run binds a random
 * password, so no password from the repository reaches a Worker. Roles are cluster-wide, so two
 * runs against one cluster change the same logins: run the end-to-end scripts one at a time.
 */

const DEFAULT_ADMIN_URL = 'postgres://uts_admin:uts-local-admin@127.0.0.1:55432/uts';

/** The UTS logins the end-to-end runs bind: the mint Worker's three Hyperdrive configs. */
const LOGINS = { app: 'uts_app_a', pat: 'uts_pat_a', reader: 'uts_reader_a' } as const;

export type E2eStore = {
  /** Admin connection to the fresh database: the run's seed and its assertions. */
  admin: pg.Client;
  /** Hyperdrive local connection strings for the app, PAT and replica logins. */
  urls: { app: string; pat: string; reader: string };
};

function adminUrl(): URL {
  const raw = z
    .url({ protocol: /^postgres(ql)?$/ })
    .parse(process.env.UTS_E2E_ADMIN_URL ?? DEFAULT_ADMIN_URL);
  const url = new URL(raw);
  if (!isLoopbackHost(url)) {
    throw new Error(`UTS_E2E_ADMIN_URL must name a loopback host, not ${url.hostname}`);
  }
  if (url.search !== '') {
    throw new Error('UTS_E2E_ADMIN_URL must not carry query parameters');
  }
  if (url.password === '') {
    throw new Error('UTS_E2E_ADMIN_URL needs the admin login and its password');
  }
  return url;
}

function loginUrl(base: URL, login: string, password: string): string {
  const url = new URL(base.toString());
  url.username = login;
  url.password = password;
  return url.toString();
}

export async function openE2eStore(database: string): Promise<E2eStore> {
  const base = adminUrl();
  const cluster = new pg.Client({ connectionString: base.toString() });
  await cluster.connect();
  try {
    await cluster.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(database)} WITH (FORCE)`);
    await cluster.query(`CREATE DATABASE ${pg.escapeIdentifier(database)}`);
  } finally {
    await cluster.end();
  }

  const url = new URL(base.toString());
  url.pathname = `/${database}`;
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  await applyMigrations(admin, await loadMigrations());

  const password = randomBytes(24).toString('base64url');
  for (const login of Object.values(LOGINS)) {
    await admin.query(
      `ALTER ROLE ${pg.escapeIdentifier(login)} PASSWORD ${pg.escapeLiteral(password)}`
    );
  }

  return {
    admin,
    urls: {
      app: loginUrl(url, LOGINS.app, password),
      pat: loginUrl(url, LOGINS.pat, password),
      reader: loginUrl(url, LOGINS.reader, password),
    },
  };
}
