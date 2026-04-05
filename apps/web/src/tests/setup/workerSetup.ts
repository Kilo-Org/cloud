import { getEnvVariable } from '@/lib/dotenvx';
import 'tsconfig-paths/register';

import { cleanupDbForTest, closeAllDrizzleConnections, Pool, Client } from '@/lib/drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { shutdownPosthog } from '@/lib/posthog';

// Use a file-system flag to ensure this setup runs only once per worker across all test files
const getSetupFlagPath = (workerId: string) =>
  join(process.cwd(), '.tmp', `jest-worker-${workerId}-setup.flag`);

const isSetupCompleted = (workerId: string) => existsSync(getSetupFlagPath(workerId));
const markSetupCompleted = (workerId: string) => {
  const flagPath = getSetupFlagPath(workerId);
  mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
  writeFileSync(flagPath, 'completed');
};

beforeAll(async () => {
  const workerId = getEnvVariable('JEST_WORKER_ID');
  if (!workerId) throw new Error('JEST_WORKER_ID environment variable is not set.');
  if (isSetupCompleted(workerId)) return;
  const originalUrl = getEnvVariable('POSTGRES_URL') ?? '';
  const url = new URL(originalUrl);
  const targetDbName = url.pathname.slice(1); // Remove leading slash
  const dbName = `${targetDbName}-${workerId}`;
  const testDbUrl = originalUrl.replace(/\/[^/]+$/, `/${dbName}`);

  const client = new Client({
    connectionString: originalUrl.replace('sslmode=require&', ''),
  });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await client.query(`CREATE DATABASE "${dbName}"`);
  await client.end();

  const testPool = new Pool({
    connectionString: testDbUrl.replace('sslmode=require&', ''),
  });
  try {
    const testDb = drizzle(testPool);
    await migrate(testDb, { migrationsFolder: '../../packages/db/src/migrations' });
  } finally {
    await testPool.end();
  }

  // IMPORTANT: Update the environment variable for the current worker process.
  // We set it to the base URL (without worker ID) so that drizzle.ts can add the worker ID suffix
  process.env.POSTGRES_URL = originalUrl;

  markSetupCompleted(workerId);
}, 60000);

afterAll(async () => {
  const posthogPromise = shutdownPosthog();
  await cleanupDbForTest();
  await closeAllDrizzleConnections();
  await posthogPromise;
}, 10000);
