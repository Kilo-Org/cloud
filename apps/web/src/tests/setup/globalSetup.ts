import { config as loadEnvFile, parse as parseDotenv } from 'dotenv';
import { rmSync, existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

/**
 * Environment keys that `dev/local/infra-env.ts` writes per worktree.
 * Only these keys may take infra-env endpoint values; all other test
 * fixture values must remain from `.env.test`.
 */
const INFRA_ENDPOINT_KEYS = new Set(['POSTGRES_URL', 'REDIS_URL', 'UPSTASH_REDIS_REST_URL']);

export default function globalSetup() {
  // Load environment files following Next.js convention for test environment
  // Order: .env -> .env.test -> .env.test.local (later files override earlier ones)
  // See: https://nextjs.org/docs/basic-features/environment-variables#environment-variable-load-order
  const cwd = process.cwd();
  loadEnvFile({ path: join(cwd, '.env') });
  loadEnvFile({ path: join(cwd, '.env.test'), override: true });
  loadEnvFile({ path: join(cwd, '.env.test.local'), override: true });

  // Worktrees require infra endpoint values from the repo-root .env.local.
  // dev/local/infra-env.ts writes worktree-specific ports there (e.g.
  // POSTGRES_URL with an offset port). Jest's cwd is apps/web, so the
  // repo-root file is two directories up.
  //
  // Only INFRA_ENDPOINT_KEYS are applied. Full dotenv loading with
  // override:true would clobber .env.test fixture secrets such as
  // NEXTAUTH_SECRET.
  const repoRoot = resolve(cwd, '..', '..');
  const repoEnvPath = join(repoRoot, '.env.local');
  if (existsSync(repoEnvPath)) {
    const parsed = parseDotenv(readFileSync(repoEnvPath, 'utf-8'));
    for (const key of INFRA_ENDPOINT_KEYS) {
      if (parsed[key] !== undefined) {
        process.env[key] = parsed[key];
      }
    }
  }

  // Clean up any existing worker setup flags from previous test runs
  const tmpDir = join(cwd, '.tmp');

  if (existsSync(tmpDir)) {
    console.log('Cleaning up previous test run flag files...');
    rmSync(tmpDir, { recursive: true, force: true });
  }
  return Promise.resolve();
}
