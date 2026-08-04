import { config as loadEnvFile } from 'dotenv';
import { rmSync, existsSync } from 'fs';
import { join } from 'path';

export default function globalSetup() {
  // Load environment files following Next.js convention for test environment
  // Order: .env -> .env.test -> .env.test.local (later files override earlier ones)
  // See: https://nextjs.org/docs/basic-features/environment-variables#environment-variable-load-order
  const cwd = process.cwd();
  loadEnvFile({ path: join(cwd, '.env') });
  loadEnvFile({ path: join(cwd, '.env.test'), override: true });
  loadEnvFile({ path: join(cwd, '.env.test.local'), override: true });

  // Clean up any existing worker setup flags from previous test runs
  const tmpDir = join(cwd, '.tmp');

  if (existsSync(tmpDir)) {
    console.log('Cleaning up previous test run flag files...');
    rmSync(tmpDir, { recursive: true, force: true });
  }
  return Promise.resolve();
}
