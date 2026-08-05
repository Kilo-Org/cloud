#!/usr/bin/env tsx
/**
 * Entry point for `pnpm drizzle:migrate-safely`.
 *
 * Kept separate from `migrate.ts` so importing the runner (in tests) never
 * connects to a database or applies migrations as an import side effect.
 */
import process from 'node:process';

import { reportFailure, runMigrations } from './migrate';

runMigrations().catch((error: unknown) => {
  reportFailure(error);
  process.exitCode = 1;
});
