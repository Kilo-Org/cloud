#!/usr/bin/env tsx
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { computeDatabaseUrl, createDrizzleClient } from '@kilocode/db';

const QUERY_TIMEOUT_MS = 30_000;

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  process.loadEnvFile(path);
}

async function main(): Promise<void> {
  loadEnvFile(resolve(process.cwd(), '.env.local'));
  loadEnvFile(resolve(process.cwd(), '.env'));

  const { pool } = createDrizzleClient({
    connectionString: computeDatabaseUrl(),
    poolConfig: {
      max: 1,
      connectionTimeoutMillis: 10_000,
      // statement_timeout bounds the server's work; query_timeout bounds a peer that accepts the
      // session and then stops responding, where only a client-side timer can fire.
      statement_timeout: QUERY_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
    },
  });

  try {
    await pool.query('SELECT 1');
    console.log('Production database startup smoke check passed.');
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error('Production database startup smoke check failed.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
