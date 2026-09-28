/**
 * `playwright.setup-smoke.config.ts` drives the dev stack a worktree is already
 * running, so its base URL has to match the origin that stack canonicalises to.
 * `scripts/dev.sh` exports `APP_URL_OVERRIDE` into the `next dev` process only,
 * and Playwright loads no dotenv file, so the config has to read the same env
 * files itself — otherwise a worktree whose `.env.local` points the override at
 * a LAN IP or 127.0.0.1 browses localhost, drops the host-scoped session cookie
 * mid-sign-in, and profile.spec.ts times out in `page.waitForURL`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveBaseUrl } from '../../playwright.setup-smoke.config';

let root: string;

/** The throwaway worktree's `apps/web`, where both commands run from. */
function webDir(): string {
  return join(root, 'apps/web');
}

function writeEnvFile(relativePath: string, contents: string) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'setup-smoke-base-url-'));
  mkdirSync(webDir(), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveBaseUrl', () => {
  it('follows an APP_URL_OVERRIDE that only a worktree env file names', () => {
    writeEnvFile('apps/web/.env.local', 'APP_URL_OVERRIDE="http://192.168.1.20:3000"\n');

    expect(resolveBaseUrl(webDir(), {})).toBe('http://192.168.1.20:3000');
  });

  it('reads the repo-root .env.local when apps/web has none', () => {
    writeEnvFile('.env.local', 'APP_URL_OVERRIDE=http://127.0.0.1:3123\n');

    expect(resolveBaseUrl(webDir(), {})).toBe('http://127.0.0.1:3123');
  });

  it('reads the files in the order scripts/dev.sh reads them', () => {
    writeEnvFile('apps/web/.env.development.local', 'APP_URL_OVERRIDE=http://10.0.0.5:3000\n');
    writeEnvFile('apps/web/.env.local', 'APP_URL_OVERRIDE=http://10.0.0.9:3000\n');
    writeEnvFile('.env.local', 'APP_URL_OVERRIDE=http://10.0.0.7:3000\n');

    expect(resolveBaseUrl(webDir(), {})).toBe('http://10.0.0.5:3000');

    rmSync(join(webDir(), '.env.development.local'));
    expect(resolveBaseUrl(webDir(), {})).toBe('http://10.0.0.9:3000');

    rmSync(join(webDir(), '.env.local'));
    expect(resolveBaseUrl(webDir(), {})).toBe('http://10.0.0.7:3000');
  });

  it('keeps an exported APP_URL_OVERRIDE ahead of the files', () => {
    writeEnvFile('apps/web/.env.local', 'APP_URL_OVERRIDE=http://192.168.1.20:3000\n');

    expect(resolveBaseUrl(webDir(), { APP_URL_OVERRIDE: 'http://127.0.0.1:3999' })).toBe(
      'http://127.0.0.1:3999'
    );
  });

  it('keeps an explicit PLAYWRIGHT_BASE_URL ahead of every other origin', () => {
    writeEnvFile('apps/web/.env.local', 'APP_URL_OVERRIDE=http://192.168.1.20:3000\n');

    expect(resolveBaseUrl(webDir(), { PLAYWRIGHT_BASE_URL: 'http://localhost:3000' })).toBe(
      'http://localhost:3000'
    );
  });

  it('falls back to the dev port when no file names a usable origin', () => {
    expect(resolveBaseUrl(webDir(), {})).toBe('http://localhost:3000');
    expect(resolveBaseUrl(webDir(), { PORT: '3100' })).toBe('http://localhost:3100');

    writeEnvFile('apps/web/.env.local', 'APP_URL_OVERRIDE=not-a-url\n');
    expect(resolveBaseUrl(webDir(), { PORT: '3100' })).toBe('http://localhost:3100');
  });

  it('lets a later file win over a key an earlier file leaves empty', () => {
    writeEnvFile('apps/web/.env.development.local', 'APP_URL_OVERRIDE=\n');
    writeEnvFile('apps/web/.env.local', 'APP_URL_OVERRIDE=http://10.0.0.9:3000\n');

    expect(resolveBaseUrl(webDir(), {})).toBe('http://10.0.0.9:3000');
  });
});
