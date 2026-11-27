import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localDatabaseUrl } from '../../scripts/e2e-store';

/**
 * The end-to-end scripts connect `pg` as the local admin and app logins. `pg` takes TLS and other
 * settings from the URL's query, so each database URL must name a loopback host with no query
 * parameter (`localDatabaseUrl`, scripts/e2e-store.ts).
 */

const NAME = 'UTS_TEST_E2E_DATABASE_URL';

/**
 * `url` with the `uts_admin` login and a password made at run time, so the source holds no
 * credential URL.
 */
function withLogin(url: string): string {
  const parsed = new URL(url);
  parsed.username = 'uts_admin';
  parsed.password = crypto.randomUUID();
  return parsed.toString();
}

afterEach(() => {
  delete process.env[NAME];
});

describe('localDatabaseUrl', () => {
  it('accepts a loopback login with its password', () => {
    process.env[NAME] = withLogin('postgres://127.0.0.1:55432/uts');
    expect(localDatabaseUrl(NAME).hostname).toBe('127.0.0.1');
  });

  it.each([
    ['a query parameter', withLogin('postgres://127.0.0.1:55432/uts?sslmode=disable')],
    ['a host in the query', withLogin('postgres://localhost/uts?host=db.example.com')],
    ['a remote host', withLogin('postgres://db.example.com/uts')],
    ['no password', 'postgres://uts_admin@127.0.0.1/uts'],
    ['another scheme', withLogin('mysql://127.0.0.1/uts')],
  ])('refuses %s', (_name, url) => {
    process.env[NAME] = url;
    expect(() => localDatabaseUrl(NAME)).toThrow();
  });
});

describe.each(['bff-e2e.ts', 'clients-e2e.ts', 'subjects-e2e.ts'])('scripts/%s', script => {
  it('reads its database URLs only through localDatabaseUrl', () => {
    // The package scripts run Vitest from the package directory.
    const source = readFileSync(join(process.cwd(), 'scripts', script), 'utf8');
    expect(source).toContain("localDatabaseUrl('UTS_E2E_ADMIN_URL')");
    expect(source).not.toMatch(/process\.env\.UTS_E2E_(ADMIN|APP|READER)_URL/);
  });
});
