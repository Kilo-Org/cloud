import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkPRStatus, resolveGitHubToken } from '../../src/dos/town/town-scm';
import { getGastownUserStub } from '../../src/dos/GastownUser.do';
import { getGastownOrgStub } from '../../src/dos/GastownOrg.do';
import { TownConfigSchema, type TownConfig } from '../../src/types';

const creationRecords = vi.hoisted(() => ({
  userTowns: new Map<string, { owner_user_id: string }>(),
  orgTowns: new Map<string, { owner_org_id: string; created_by_user_id: string }>(),
  failures: [] as Error[],
}));

vi.mock('../../src/dos/GastownUser.do', () => ({
  getGastownUserStub: vi.fn((_env: unknown, userId: string) => {
    const failure = creationRecords.failures.shift();
    return {
      getTownAsync: async (townId: string) => {
        if (failure) throw failure;
        return creationRecords.userTowns.get(`${userId}:${townId}`) ?? null;
      },
    };
  }),
}));
vi.mock('../../src/dos/GastownOrg.do', () => ({
  getGastownOrgStub: vi.fn((_env: unknown, orgId: string) => {
    const failure = creationRecords.failures.shift();
    return {
      getTownAsync: async (townId: string) => {
        if (failure) throw failure;
        return creationRecords.orgTowns.get(`${orgId}:${townId}`) ?? null;
      },
    };
  }),
}));

const STORED_GITHUB_TOKEN = 'ghs_stored_stale_token';
const FRESH_INSTALLATION_TOKEN = 'ghs_fresh_from_integration';
const USER_PAT = 'ghp_user_long_lived_pat';
const INTEGRATION_ID = '119277743';
const OWNER_USER_ID = 'user-owner';
const OWNER_ORG_ID = '00000000-0000-4000-8000-0000000000aa';
const ORG_CREATOR_ID = 'user-org-creator';
const OTHER_USER_ID = 'user-other';
const OTHER_ORG_ID = '00000000-0000-4000-8000-0000000000bb';

type IntegrationTokenRequest = { integrationId: string; userId: string; orgId?: string };

function buildConfig(overrides: {
  github_token?: string;
  github_cli_pat?: string;
  platform_integration_id?: string;
  owner?: Partial<
    Pick<TownConfig, 'owner_type' | 'owner_id' | 'owner_user_id' | 'organization_id'>
  >;
}): TownConfig {
  return TownConfigSchema.parse({
    git_auth: {
      github_token: overrides.github_token,
      platform_integration_id: overrides.platform_integration_id,
    },
    github_cli_pat: overrides.github_cli_pat,
    ...(overrides.owner ?? { owner_user_id: OWNER_USER_ID }),
  });
}

function fakeEnv(opts: {
  tokenServiceResponse?: string | null;
  tokenServiceShouldThrow?: boolean;
  tokenServiceAccessDenied?: boolean;
  requests?: IntegrationTokenRequest[];
}): Env {
  return {
    GIT_TOKEN_SERVICE: {
      getTokenForIntegration: async (request: IntegrationTokenRequest) => {
        opts.requests?.push(request);
        if (opts.tokenServiceShouldThrow) {
          throw new Error('integration lookup failed');
        }
        if (opts.tokenServiceAccessDenied) {
          return { success: false as const, reason: 'unavailable' as const };
        }
        const token = opts.tokenServiceResponse ?? FRESH_INSTALLATION_TOKEN;
        return token
          ? { success: true as const, token }
          : { success: false as const, reason: 'unavailable' as const };
      },
    },
  } as unknown as Env;
}

describe('resolveGitHubToken priority chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    creationRecords.failures.length = 0;
    creationRecords.userTowns.clear();
    creationRecords.orgTowns.clear();
    creationRecords.userTowns.set(`${OWNER_USER_ID}:town-1`, { owner_user_id: OWNER_USER_ID });
    creationRecords.orgTowns.set(`${OWNER_ORG_ID}:town-1`, {
      owner_org_id: OWNER_ORG_ID,
      created_by_user_id: ORG_CREATOR_ID,
    });
  });

  describe.each([
    { name: 'personal', owner: { owner_user_id: OWNER_USER_ID }, stub: getGastownUserStub },
    {
      name: 'org',
      owner: { owner_type: 'org' as const, organization_id: OWNER_ORG_ID },
      stub: getGastownOrgStub,
    },
  ])('$name owner lookup failures', ({ owner, stub }) => {
    function context(requests: IntegrationTokenRequest[]) {
      return {
        env: fakeEnv({ requests }),
        townId: 'town-1',
        getTownConfig: async () =>
          buildConfig({
            owner,
            platform_integration_id: INTEGRATION_ID,
            github_token: STORED_GITHUB_TOKEN,
          }),
      };
    }

    it('recovers with a fresh stub after a retryable error', async () => {
      creationRecords.failures.push(Object.assign(new Error('DO reset'), { retryable: true }));
      const requests: IntegrationTokenRequest[] = [];
      await expect(resolveGitHubToken(context(requests))).resolves.toMatchObject({
        ok: true,
        token: FRESH_INSTALLATION_TOKEN,
      });
      expect(stub).toHaveBeenCalledTimes(2);
      expect(requests).toHaveLength(1);
    });

    it.each([
      { retryable: true, attempts: 3 },
      { retryable: false, attempts: 1 },
    ])('returns a poll error after $attempts attempts', async ({ retryable, attempts }) => {
      const error = Object.assign(new Error('Owner lookup unavailable'), { retryable });
      creationRecords.failures.push(error, error, error);
      const requests: IntegrationTokenRequest[] = [];
      await expect(
        checkPRStatus(context(requests), 'https://github.com/owner/repo/pull/1')
      ).resolves.toEqual({
        ok: false,
        error: { kind: 'owner_lookup_failed', provider: 'github' },
      });
      expect(stub).toHaveBeenCalledTimes(attempts);
      expect(requests).toEqual([]);
    });
  });

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

  it('does not fall back to stored github_token when integration lookup throws', async () => {
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
      ok: false,
      tried: ['town.github_cli_pat', 'town platform integration'],
    });
  });

  it('does not fall back to a stored installation token after a disconnect denial', async () => {
    const cfg = buildConfig({
      github_token: STORED_GITHUB_TOKEN,
      platform_integration_id: INTEGRATION_ID,
    });
    const result = await resolveGitHubToken({
      env: fakeEnv({ tokenServiceAccessDenied: true }),
      townId: 'town-1',
      getTownConfig: () => Promise.resolve(cfg),
    });
    expect(result).toEqual({
      ok: false,
      tried: ['town.github_cli_pat', 'town platform integration'],
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

  it('requests a personal town integration token on behalf of the town owner', async () => {
    const requests: IntegrationTokenRequest[] = [];
    const cfg = buildConfig({ owner: { owner_type: 'user', owner_id: OWNER_USER_ID } });
    await resolveGitHubToken({
      env: fakeEnv({ requests }),
      townId: 'town-1',
      getTownConfig: () => Promise.resolve(cfg),
      platformIntegrationId: INTEGRATION_ID,
    });
    expect(requests).toEqual([{ integrationId: INTEGRATION_ID, userId: OWNER_USER_ID }]);
  });

  it('takes the org town creator from the creation record, not town config', async () => {
    const requests: IntegrationTokenRequest[] = [];
    const cfg = buildConfig({
      platform_integration_id: INTEGRATION_ID,
      owner: {
        owner_type: 'org',
        owner_id: OWNER_ORG_ID,
        organization_id: OWNER_ORG_ID,
        owner_user_id: OWNER_USER_ID,
      },
    });
    await resolveGitHubToken({
      env: fakeEnv({ requests }),
      townId: 'town-1',
      getTownConfig: () => Promise.resolve(cfg),
    });
    expect(requests).toEqual([
      { integrationId: INTEGRATION_ID, userId: ORG_CREATOR_ID, orgId: OWNER_ORG_ID },
    ]);
  });

  it.each([
    [
      'a personal owner whose user record does not list the town',
      { owner_type: 'user' as const, owner_user_id: OTHER_USER_ID },
    ],
    [
      'a personal owner_id whose user record does not list the town',
      { owner_type: 'user' as const, owner_id: OTHER_USER_ID },
    ],
    [
      'an org whose record does not list the town',
      {
        owner_type: 'org' as const,
        owner_id: OTHER_ORG_ID,
        organization_id: OTHER_ORG_ID,
        owner_user_id: OWNER_USER_ID,
      },
    ],
  ])('does not request an integration token for %s', async (_label, owner) => {
    const requests: IntegrationTokenRequest[] = [];
    const cfg = buildConfig({ platform_integration_id: INTEGRATION_ID, owner });
    const result = await resolveGitHubToken({
      env: fakeEnv({ requests }),
      townId: 'town-1',
      getTownConfig: () => Promise.resolve(cfg),
    });
    expect(requests).toEqual([]);
    expect(result).toEqual({
      ok: false,
      tried: ['town.github_cli_pat', 'town platform integration (town owner not confirmed)'],
    });
  });

  it('does not request an integration token for a town without an owner', async () => {
    const requests: IntegrationTokenRequest[] = [];
    const cfg = buildConfig({
      github_token: STORED_GITHUB_TOKEN,
      platform_integration_id: INTEGRATION_ID,
      owner: {},
    });
    const result = await resolveGitHubToken({
      env: fakeEnv({ requests }),
      townId: 'town-1',
      getTownConfig: () => Promise.resolve(cfg),
    });
    expect(requests).toEqual([]);
    expect(result).toEqual({
      ok: false,
      tried: ['town.github_cli_pat', 'town platform integration (town owner not confirmed)'],
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
});
