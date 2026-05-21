import { describe, it, expect } from 'vitest';
import { resolveGitHubToken } from '../../src/dos/town/town-scm';
import { TownConfigSchema, type TownConfig } from '../../src/types';

const STORED_GITHUB_TOKEN = 'ghs_stored_stale_token';
const FRESH_INSTALLATION_TOKEN = 'ghs_fresh_from_integration';
const USER_PAT = 'ghp_user_long_lived_pat';
const INTEGRATION_ID = '119277743';

function buildConfig(overrides: {
  github_token?: string;
  github_cli_pat?: string;
  platform_integration_id?: string;
}): TownConfig {
  return TownConfigSchema.parse({
    git_auth: {
      github_token: overrides.github_token,
      platform_integration_id: overrides.platform_integration_id,
    },
    github_cli_pat: overrides.github_cli_pat,
  });
}

function fakeEnv(opts: {
  tokenServiceResponse?: string | null;
  tokenServiceShouldThrow?: boolean;
}): Env {
  return {
    GIT_TOKEN_SERVICE: {
      getToken: async (_id: string) => {
        if (opts.tokenServiceShouldThrow) {
          throw new Error('integration lookup failed');
        }
        return opts.tokenServiceResponse ?? FRESH_INSTALLATION_TOKEN;
      },
    },
  } as unknown as Env;
}

describe('resolveGitHubToken priority chain', () => {
  it('prefers github_cli_pat over everything else', async () => {
    const cfg = buildConfig({
      github_cli_pat: USER_PAT,
      github_token: STORED_GITHUB_TOKEN,
      platform_integration_id: INTEGRATION_ID,
    });
    const result = await resolveGitHubToken({
      env: fakeEnv({}),
      townId: 'town-1',
      getTownConfig: () => Promise.resolve(cfg),
    });
    expect(result).toEqual({ ok: true, token: USER_PAT, source: 'town.github_cli_pat' });
  });

  it('returns a fresh integration token when an integration is configured, ignoring the stale stored token', async () => {
    const cfg = buildConfig({
      github_token: STORED_GITHUB_TOKEN,
      platform_integration_id: INTEGRATION_ID,
    });
    const result = await resolveGitHubToken({
      env: fakeEnv({ tokenServiceResponse: FRESH_INSTALLATION_TOKEN }),
      townId: 'town-1',
      getTownConfig: () => Promise.resolve(cfg),
    });
    expect(result).toEqual({
      ok: true,
      token: FRESH_INSTALLATION_TOKEN,
      source: 'town platform integration',
    });
  });

  it('falls back to stored github_token when no integration is configured', async () => {
    const cfg = buildConfig({ github_token: STORED_GITHUB_TOKEN });
    const result = await resolveGitHubToken({
      env: fakeEnv({}),
      townId: 'town-1',
      getTownConfig: () => Promise.resolve(cfg),
    });
    expect(result).toEqual({
      ok: true,
      token: STORED_GITHUB_TOKEN,
      source: 'town.git_auth.github_token',
    });
  });

  it('falls back to stored github_token when integration lookup throws', async () => {
    const cfg = buildConfig({
      github_token: STORED_GITHUB_TOKEN,
      platform_integration_id: INTEGRATION_ID,
    });
    const result = await resolveGitHubToken({
      env: fakeEnv({ tokenServiceShouldThrow: true }),
      townId: 'town-1',
      getTownConfig: () => Promise.resolve(cfg),
    });
    expect(result).toEqual({
      ok: true,
      token: STORED_GITHUB_TOKEN,
      source: 'town.git_auth.github_token',
    });
  });

  it('uses the rig-level platformIntegrationId when town config does not carry one', async () => {
    const cfg = buildConfig({});
    const result = await resolveGitHubToken({
      env: fakeEnv({ tokenServiceResponse: FRESH_INSTALLATION_TOKEN }),
      townId: 'town-1',
      getTownConfig: () => Promise.resolve(cfg),
      platformIntegrationId: INTEGRATION_ID,
    });
    expect(result).toEqual({
      ok: true,
      token: FRESH_INSTALLATION_TOKEN,
      source: 'rig platform integration',
    });
  });

  it('returns ok:false with tried chain when nothing is configured', async () => {
    const cfg = buildConfig({});
    const result = await resolveGitHubToken({
      env: fakeEnv({}),
      townId: 'town-1',
      getTownConfig: () => Promise.resolve(cfg),
    });
    expect(result).toEqual({
      ok: false,
      tried: [
        'town.github_cli_pat',
        'platform integration (none configured)',
        'town.git_auth.github_token',
      ],
    });
  });

  it('falls back to stored github_token when integration returns empty string', async () => {
    const cfg = buildConfig({
      github_token: STORED_GITHUB_TOKEN,
      platform_integration_id: INTEGRATION_ID,
    });
    const result = await resolveGitHubToken({
      env: fakeEnv({ tokenServiceResponse: '' }),
      townId: 'town-1',
      getTownConfig: () => Promise.resolve(cfg),
    });
    expect(result).toEqual({
      ok: true,
      token: STORED_GITHUB_TOKEN,
      source: 'town.git_auth.github_token',
    });
  });
});
