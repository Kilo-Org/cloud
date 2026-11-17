import assert from 'node:assert/strict';
import test from 'node:test';

import { assertLocalSeedDatabase } from './db';

const LOOPBACK_POSTGRES_URL = 'postgresql://127.0.0.1:5432/postgres';
const REMOTE_POSTGRES_URL = 'postgresql://db.example.internal:5432/prod';

/** POSTGRES_URL, POSTGRES_URL_PRODUCTION, USE_PRODUCTION_DB */
type DatabaseEnv = [string, string | undefined, string | undefined];

function useDatabaseEnv([postgresUrl, postgresUrlProduction, useProductionDb]: DatabaseEnv): void {
  process.env.POSTGRES_URL = postgresUrl;
  if (postgresUrlProduction === undefined) delete process.env.POSTGRES_URL_PRODUCTION;
  else process.env.POSTGRES_URL_PRODUCTION = postgresUrlProduction;
  if (useProductionDb === undefined) delete process.env.USE_PRODUCTION_DB;
  else process.env.USE_PRODUCTION_DB = useProductionDb;
}

const savedDatabaseEnv: DatabaseEnv = [
  process.env.POSTGRES_URL,
  process.env.POSTGRES_URL_PRODUCTION,
  process.env.USE_PRODUCTION_DB,
];

test.after(() => {
  useDatabaseEnv(savedDatabaseEnv);
});

test('refuses the production database switch before connecting', () => {
  useDatabaseEnv([LOOPBACK_POSTGRES_URL, REMOTE_POSTGRES_URL, 'true']);
  assert.throws(
    () => assertLocalSeedDatabase('app:demo'),
    /app:demo refuses to run with USE_PRODUCTION_DB=true/
  );
});

test('refuses a non-loopback resolved host', () => {
  useDatabaseEnv([REMOTE_POSTGRES_URL, undefined, undefined]);
  assert.throws(
    () => assertLocalSeedDatabase('app:demo'),
    /app:demo requires a loopback database host; received db\.example\.internal/
  );
});

test('accepts the loopback resolved connection', () => {
  useDatabaseEnv([LOOPBACK_POSTGRES_URL, undefined, undefined]);
  assert.equal(assertLocalSeedDatabase('app:demo'), '127.0.0.1');
});

test('accepts every loopback spelling of the resolved connection', () => {
  const cases: { url: string; hostname: string }[] = [
    { url: 'postgresql://localhost:5432/postgres', hostname: 'localhost' },
    { url: 'postgresql://[::1]:5432/postgres', hostname: '[::1]' },
  ];
  for (const { url, hostname } of cases) {
    useDatabaseEnv([url, undefined, undefined]);
    assert.equal(assertLocalSeedDatabase('app:demo'), hostname);
  }
});

test('accepts the loopback connection while a production URL is present but not selected', () => {
  useDatabaseEnv([LOOPBACK_POSTGRES_URL, REMOTE_POSTGRES_URL, undefined]);
  assert.equal(assertLocalSeedDatabase('app:demo'), '127.0.0.1');
});
