// Starts `next dev` for apps/web as the CI job needs it: env from the tracked apps/web/.env and
// .env.test (a runner has no root .env.local), with the dev-only fake login enabled.
// Usage: node e2e/ci/start-web.mjs (runs in the foreground)
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/web');
const port = process.env.PORT ?? '3000';
const baseURL = `http://localhost:${port}`;

const fileEnv = {};
for (const file of ['.env', '.env.test']) {
  const full = path.join(webDir, file);
  if (existsSync(full)) Object.assign(fileEnv, parseEnv(readFileSync(full, 'utf8')));
}

/** @type {NodeJS.ProcessEnv} */
const env = {
  ...fileEnv,
  ...process.env,
  NODE_ENV: 'development',
  DEBUG_SHOW_DEV_UI: 'true', // fake login
  // .env.test has a fake Stripe key; without this, signing up a new user fails (local dev sets it too).
  SKIP_STRIPE_API: 'true',
  APP_URL_OVERRIDE: baseURL,
  NEXTAUTH_URL: baseURL,
  PORT: port,
  VERCEL_ENV: '',
  VERCEL_TARGET_ENV: '',
};
// Only the e2e install needs the package token; keep it out of the app.
delete env.NODE_AUTH_TOKEN;

const child = spawn('pnpm', ['run', 'copy:swagger-ui-assets'], { cwd: webDir, env, stdio: 'inherit' });
child.on('exit', code => {
  if (code !== 0) process.exit(code ?? 1);
  const next = spawn('pnpm', ['exec', 'next', 'dev', '-p', port], { cwd: webDir, env, stdio: 'inherit' });
  next.on('exit', nextCode => process.exit(nextCode ?? 1));
});
