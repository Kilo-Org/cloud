#!/usr/bin/env tsx
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { computeDatabaseUrl, createDrizzleClient } from '@kilocode/db';

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
