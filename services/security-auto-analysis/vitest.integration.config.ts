import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Integration tests default POSTGRES_URL to localhost:5432. Local compose
 * publishes this worktree's postgres on another host port (see .env.local).
 *
 * A previous loader skipped .env.local whenever POSTGRES_URL was already set,
 * so a harness/default of localhost:5432 (ECONNREFUSED here) hid the mapped
 * port. Prefer .env.local when the current URL is that dead default; keep any
 * other explicit URL (CI). Inject via `test.env` so worker processes see it
 * before test files read `process.env.POSTGRES_URL` at module load.
 */
function postgresUrlFromRepoLocalEnv(): string | undefined {
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local');
  if (!existsSync(envPath)) return undefined;
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (key !== 'POSTGRES_URL') continue;
    let value = line.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

function isDefaultLocalPostgresUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host !== 'localhost' && host !== '127.0.0.1') return false;
    return parsed.port === '5432' || parsed.port === '';
  } catch {
    return false;
  }
}

function resolvePostgresUrl(): string | undefined {
  const fromFile = postgresUrlFromRepoLocalEnv();
  const current = process.env.POSTGRES_URL;
  if (current && !(isDefaultLocalPostgresUrl(current) && fromFile)) {
    return current;
  }
  return fromFile ?? current;
}

const postgresUrl = resolvePostgresUrl();
if (postgresUrl) process.env.POSTGRES_URL = postgresUrl;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    fileParallelism: false,
    include: ['src/**/*.integration.test.ts'],
    ...(postgresUrl ? { env: { POSTGRES_URL: postgresUrl } } : {}),
  },
});
