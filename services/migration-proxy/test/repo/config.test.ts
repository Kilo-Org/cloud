import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { experimental_readRawConfig } from 'wrangler';
import { claimsMismatch } from '../../src/attest';
import { expectedRun, readConfig } from '../../src/config';

/**
 * The three-barrier production refusal's first barrier (contract §3), against the real top-level
 * services/migration-proxy/wrangler.jsonc, read with Wrangler's own parser.
 */

const CONFIG_PATH = join(import.meta.dirname, '../../wrangler.jsonc');
const SOURCE = readFileSync(CONFIG_PATH, 'utf8');

type RawBlock = { vars?: Record<string, unknown> };
type RawConfig = RawBlock & { env?: Record<string, RawBlock> };

function readRaw(source: string): RawConfig {
  const dir = mkdtempSync(join(tmpdir(), 'mp-config-'));
  try {
    const path = join(dir, 'wrangler.jsonc');
    writeFileSync(path, source);
    return experimental_readRawConfig({ config: path }).rawConfig as RawConfig;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const topLevelVars = (source = SOURCE) => readRaw(source).vars ?? {};
const stagingVars = (source = SOURCE) => readRaw(source).env?.staging?.vars ?? {};

/** The values slice E sets (production's target, the App ids, the review baseline). */
const SET_BY_E = {
  MIGRATION_DB_TARGET: 'db.abcdefghijklmnopqrst.supabase.co:5432/postgres',
  MIGRATION_PROXY_GITHUB_APP_ID: '1234567',
  MIGRATION_PROXY_GITHUB_INSTALLATION_ID: '89012345',
  MIGRATION_REVIEW_BASELINE_SHA: 'c4e5c74b9e0000000000000000000000000000aa',
};

/** Replaces one var's value in the top-level block of the file's text. */
function withTopLevelVar(name: string, value: string | null): string {
  const pattern = new RegExp(`\\n    "${name}": "[^"]*",`);
  const [topLevel, rest] = SOURCE.split('"env": {');
  expect(pattern.test(topLevel)).toBe(true);
  const changed = topLevel.replace(pattern, value === null ? '' : `\n    "${name}": "${value}",`);
  return `${changed}"env": {${rest}`;
}

describe('the real wrangler.jsonc', () => {
  it('loads its top level as production, member, kilo_migration_proxy once E sets its values', () => {
    const vars = topLevelVars();
    const unset = readConfig(vars);
    expect(unset).toEqual({
      ok: false,
      problems: [
        'MIGRATION_DB_TARGET: not <host>:5432/<database>',
        'MIGRATION_PROXY_GITHUB_APP_ID: not set',
        'MIGRATION_PROXY_GITHUB_INSTALLATION_ID: not set',
        'MIGRATION_REVIEW_BASELINE_SHA: not set',
      ],
    });
    const loaded = readConfig({ ...vars, ...SET_BY_E });
    expect(loaded.ok && loaded.config).toMatchObject({
      environment: 'production',
      loginMode: 'member',
      user: 'kilo_migration_proxy',
      sessionKey: 'label',
      sampleMinutes: 60,
      runDeadlineSeconds: 21_600,
    });
  });

  it('loads env.staging alone as staging, direct, postgres, pid, sample 0', () => {
    const loaded = readConfig(stagingVars());
    expect(loaded.ok && loaded.config).toMatchObject({
      environment: 'staging',
      loginMode: 'direct',
      user: 'postgres',
      sessionKey: 'pid',
      sampleMinutes: 0,
      target: { host: 'db.xrcpuwfztrhiazsslhuu.supabase.co', port: 5432, database: 'postgres' },
      github: { appId: '5952011', installationId: '186479258' },
      reviewBaselineSha: 'dd05d644626ca17bacb80a8b43384622f87a0605',
    });
  });

  it.each([
    ['direct mode', 'MIGRATION_DB_LOGIN_MODE', 'direct'],
    ['the postgres login', 'MIGRATION_DB_USER', 'postgres'],
    ['postgres through the pooler', 'MIGRATION_DB_USER', 'postgres.abcdefghijklmnopqrst'],
    ['an unknown login', 'MIGRATION_DB_USER', 'migration_admin'],
    ['a member login with a malformed ref', 'MIGRATION_DB_USER', 'kilo_migration_proxy.ABC'],
    ['no environment', 'MIGRATION_PROXY_ENVIRONMENT', null],
    ['an unknown environment', 'MIGRATION_PROXY_ENVIRONMENT', 'prod'],
  ])('refuses a copy whose top level has %s', (_label, name, value) => {
    const vars = { ...topLevelVars(withTopLevelVar(name, value)), ...SET_BY_E };
    expect(readConfig(vars).ok).toBe(false);
  });

  it('accepts the pooler form of the member login in production', () => {
    const vars = {
      ...topLevelVars(
        withTopLevelVar('MIGRATION_DB_USER', 'kilo_migration_proxy.abcdefghijklmnopqrst')
      ),
      ...SET_BY_E,
    };
    expect(readConfig(vars).ok).toBe(true);
  });

  it.each([
    ['label', { MIGRATION_SESSION_KEY: 'label' }],
    ['a sample', { MIGRATION_SESSION_SAMPLE_MINUTES: '60' }],
  ])('refuses staging direct mode with %s', (_label, change) => {
    expect(readConfig({ ...stagingVars(), ...change })).toMatchObject({ ok: false });
  });

  it('accepts a fake GitHub only in the development stack', () => {
    const fake = { MIGRATION_PROXY_GITHUB_API_URL: 'http://127.0.0.1:8787' };
    const production = readConfig({ ...topLevelVars(), ...SET_BY_E, ...fake });
    expect(production).toEqual({
      ok: false,
      problems: ['MIGRATION_PROXY_GITHUB_API_URL: only the development stack may set it'],
    });
    const { MIGRATION_DB_TARGET: _target, ...rest } = SET_BY_E;
    expect(readConfig({ ...stagingVars(), ...rest, ...fake }).ok).toBe(false);
    const development = readConfig({
      ...topLevelVars(),
      ...SET_BY_E,
      ...fake,
      MIGRATION_PROXY_ENVIRONMENT: 'development',
    });
    expect(development.ok && development.config.github.apiUrl).toBe('http://127.0.0.1:8787');
    const deployed = readConfig({ ...topLevelVars(), ...SET_BY_E });
    expect(deployed.ok && deployed.config.github.apiUrl).toBe('https://api.github.com');
  });

  it('refuses port 6543 and a target without a port', () => {
    for (const target of [
      'db.abcdefghijklmnopqrst.supabase.co:6543/postgres',
      'db.abcdefghijklmnopqrst.supabase.co/postgres',
      '',
    ]) {
      expect(readConfig({ ...topLevelVars(), ...SET_BY_E, MIGRATION_DB_TARGET: target }).ok).toBe(
        false
      );
    }
  });

  it('derives the login rule and the attestation re-check from the one environment constant', () => {
    const { MIGRATION_DB_TARGET: _target, ...rest } = SET_BY_E;
    const staging = readConfig({ ...stagingVars(), ...rest });
    if (!staging.ok) throw new Error('staging must load');
    const stagingRun = {
      workload: 'ci-db-migrate-staging',
      github: {
        repositoryId: '1145038391',
        repositoryOwnerId: '201822503',
        environment: 'staging',
        ref: 'refs/heads/main',
        sha: 'a'.repeat(40),
        eventName: 'workflow_dispatch',
        jobWorkflowRef: expectedRun('staging').jobWorkflowRef,
        runId: '1',
        runAttempt: '1',
      },
    };
    expect(claimsMismatch(stagingRun, staging.config)).toBe(false);

    // The same vars with only the constant flipped to production: the login rule now refuses
    // direct mode, and the re-check now expects production's workflow and workload.
    expect(
      readConfig({ ...stagingVars(), ...rest, MIGRATION_PROXY_ENVIRONMENT: 'production' }).ok
    ).toBe(false);
    const production = { ...staging.config, environment: 'production' as const };
    expect(claimsMismatch(stagingRun, production)).toBe(true);
    expect(expectedRun('production')).toEqual({
      environment: 'production',
      jobWorkflowRef: 'Kilo-Org/cloud/.github/workflows/deploy-production.yml@refs/heads/main',
      workload: 'ci-db-migrate',
    });
    expect(
      claimsMismatch(
        {
          workload: 'ci-db-migrate',
          github: {
            ...stagingRun.github,
            environment: 'production',
            jobWorkflowRef: expectedRun('production').jobWorkflowRef,
          },
        },
        production
      )
    ).toBe(false);
  });
});
