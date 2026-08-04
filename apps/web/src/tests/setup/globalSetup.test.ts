import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import globalSetup from './globalSetup';

const ENDPOINT_KEY = 'POSTGRES_URL';
const FIXTURE_KEY = 'NEXTAUTH_SECRET';
const WORKTREE_PG = 'postgres://worktree:5432/worktree_db';
const WORKTREE_REDIS = 'redis://worktree:6380';
const WORKTREE_UPSTASH = 'https://worktree.upstash.io';
const TEST_FIXTURE_VALUE = 'test-only-non-secret';
const WORKTREE_FIXTURE_VALUE = 'should-not-override-this';

describe('globalSetup env precedence', () => {
  let repoRoot: string;
  let cwd: string;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const key of [ENDPOINT_KEY, FIXTURE_KEY, 'REDIS_URL', 'UPSTASH_REDIS_REST_URL']) {
      delete process.env[key];
    }

    // Directory layout matching real repo structure:
    //   <repoRoot>/              — monorepo root
    //   <repoRoot>/apps/web/     — Jest cwd
    repoRoot = join(tmpdir(), `global-setup-test-${Date.now()}`);
    cwd = join(repoRoot, 'apps', 'web');
    mkdirSync(cwd, { recursive: true });

    // apps/web/.env — empty, no values to provide
    writeFileSync(join(cwd, '.env'), '');

    // apps/web/.env.test — test fixture values
    writeFileSync(
      join(cwd, '.env.test'),
      [
        `${ENDPOINT_KEY}=test-pg-url`,
        `${FIXTURE_KEY}=${TEST_FIXTURE_VALUE}`,
        'REDIS_URL=redis://test:6379',
        'UPSTASH_REDIS_REST_URL=https://test.upstash.io',
      ].join('\n')
    );

    // repo-root .env.local — worktree infra endpoint values AND a
    // non-endpoint key that must NOT override the .env.test fixture
    writeFileSync(
      join(repoRoot, '.env.local'),
      [
        `${ENDPOINT_KEY}=${WORKTREE_PG}`,
        `${FIXTURE_KEY}=${WORKTREE_FIXTURE_VALUE}`,
        `REDIS_URL=${WORKTREE_REDIS}`,
        `UPSTASH_REDIS_REST_URL=${WORKTREE_UPSTASH}`,
      ].join('\n')
    );

    jest.spyOn(process, 'cwd').mockReturnValue(cwd);
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore the test keys that dotenv and globalSetup wrote from
    // the temp fixture files. No other keys are touched because the
    // temp .env is empty and .env.test only contains these four keys.
    for (const key of [ENDPOINT_KEY, FIXTURE_KEY, 'REDIS_URL', 'UPSTASH_REDIS_REST_URL']) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }

    if (existsSync(repoRoot)) {
      rmSync(repoRoot, { recursive: true, force: true });
    }
    jest.restoreAllMocks();
  });

  it('applies endpoint keys from repo-root .env.local over .env.test', async () => {
    await globalSetup();

    expect(process.env.POSTGRES_URL).toBe(WORKTREE_PG);
    expect(process.env.REDIS_URL).toBe(WORKTREE_REDIS);
    expect(process.env.UPSTASH_REDIS_REST_URL).toBe(WORKTREE_UPSTASH);
  });

  it('preserves .env.test fixture values for non-endpoint keys', async () => {
    await globalSetup();

    expect(process.env.NEXTAUTH_SECRET).toBe(TEST_FIXTURE_VALUE);
  });

  it('does not pollute process.env with non-endpoint keys from repo-root .env.local', async () => {
    await globalSetup();

    // NEXTAUTH_SECRET is in repo-root .env.local but is NOT an endpoint key.
    // The test fixture value must survive.
    expect(process.env.NEXTAUTH_SECRET).toBe(TEST_FIXTURE_VALUE);
    expect(process.env.NEXTAUTH_SECRET).not.toBe(WORKTREE_FIXTURE_VALUE);
  });
});
