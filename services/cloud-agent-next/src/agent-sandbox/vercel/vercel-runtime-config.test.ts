import { describe, expect, it } from 'vitest';
import {
  parseVercelSandboxCredentials,
  parseVercelSandboxEnrollment,
  parseVercelSandboxRuntimeConfig,
} from './vercel-runtime-config.js';

const completeRuntimeEnv = {
  VERCEL_TOKEN: 'token',
  VERCEL_TEAM_ID: 'team-id',
  VERCEL_PROJECT_ID: 'project-id',
  VERCEL_SANDBOX_SNAPSHOT_ID: 'snapshot-id',
  VERCEL_SANDBOX_RUNTIME_BUILD_ID: 'build-id',
  VERCEL_SANDBOX_RUNTIME: 'node24',
  VERCEL_SANDBOX_INITIAL_TIMEOUT_MS: '300000',
  VERCEL_SANDBOX_EXTEND_DURATION_MS: '600000',
};

describe('parseVercelSandboxCredentials', () => {
  it('parses the minimal exact-session cleanup configuration', () => {
    expect(
      parseVercelSandboxCredentials({ VERCEL_TOKEN: ' token ', VERCEL_TEAM_ID: ' team ' })
    ).toEqual({ accessToken: 'token', teamId: 'team' });
    expect(parseVercelSandboxCredentials({ VERCEL_TOKEN: 'token' })).toBeUndefined();
  });
});

describe('parseVercelSandboxRuntimeConfig', () => {
  it('parses complete operational configuration at the point of use', () => {
    expect(parseVercelSandboxRuntimeConfig(completeRuntimeEnv)).toEqual({
      accessToken: 'token',
      teamId: 'team-id',
      projectId: 'project-id',
      snapshotId: 'snapshot-id',
      runtimeBuildId: 'build-id',
      runtime: 'node24',
      initialTimeoutMs: 300000,
      extendDurationMs: 600000,
    });
  });

  it.each([
    'VERCEL_TOKEN',
    'VERCEL_TEAM_ID',
    'VERCEL_PROJECT_ID',
    'VERCEL_SANDBOX_SNAPSHOT_ID',
    'VERCEL_SANDBOX_RUNTIME_BUILD_ID',
    'VERCEL_SANDBOX_RUNTIME',
    'VERCEL_SANDBOX_INITIAL_TIMEOUT_MS',
    'VERCEL_SANDBOX_EXTEND_DURATION_MS',
  ] as const)('rejects configuration missing %s', key => {
    const env = { ...completeRuntimeEnv };
    delete env[key];
    expect(parseVercelSandboxRuntimeConfig(env)).toBeUndefined();
  });

  it.each([
    ['VERCEL_SANDBOX_RUNTIME', 'node22'],
    ['VERCEL_SANDBOX_INITIAL_TIMEOUT_MS', '0'],
    ['VERCEL_SANDBOX_INITIAL_TIMEOUT_MS', '1.5'],
    ['VERCEL_SANDBOX_EXTEND_DURATION_MS', '-1'],
    ['VERCEL_SANDBOX_EXTEND_DURATION_MS', 'not-a-number'],
  ] as const)('rejects invalid %s', (key, value) => {
    expect(
      parseVercelSandboxRuntimeConfig({ ...completeRuntimeEnv, [key]: value })
    ).toBeUndefined();
  });
});

describe('parseVercelSandboxEnrollment', () => {
  it('is disabled when the list is empty', () => {
    expect(parseVercelSandboxEnrollment({})).toEqual({
      enabled: false,
      orgIds: new Set(),
      allowPersonal: false,
    });
    expect(parseVercelSandboxEnrollment({ VERCEL_SANDBOX_ORG_IDS: '  ,  ' })).toEqual({
      enabled: false,
      orgIds: new Set(),
      allowPersonal: false,
    });
  });

  it('parses an explicit organization allowlist', () => {
    expect(
      parseVercelSandboxEnrollment({
        VERCEL_SANDBOX_ORG_IDS: ' org-a,org-b, org-a ',
      })
    ).toEqual({ enabled: true, orgIds: new Set(['org-a', 'org-b']), allowPersonal: false });
  });

  it('treats wildcard as every org plus personal', () => {
    expect(
      parseVercelSandboxEnrollment({
        VERCEL_SANDBOX_ORG_IDS: '*',
      })
    ).toEqual({ enabled: true, orgIds: new Set(['*']), allowPersonal: true });
  });
});
