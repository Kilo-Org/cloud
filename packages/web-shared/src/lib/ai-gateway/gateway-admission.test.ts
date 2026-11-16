import { beforeEach, describe, expect, it } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import type { User } from '@kilocode/db/schema';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import { INVALID_TOKEN_CODE } from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { getBalanceAndOrgSettings } from '@kilocode/web-shared/lib/organizations/organization-usage';
import { createAnonymousContext } from '@kilocode/web-shared/lib/anonymous';
import {
  freeModelRateLimitRejection,
  gatewayAccountRateLimitRejection,
  gatewayUsageContextBase,
  gatewaySettingsRejection,
  organizationProviderPreferences,
  paidUsageRejection,
  readGatewayBalance,
  resolveGatewayCaller,
  resolveOrganizationGatewaySettings,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-admission';
import {
  gatewayRateLimitKey,
  isGatewayAccountRateLimited,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-account-rate-limit';
import { isFreeModelRateLimited } from '@kilocode/web-shared/lib/ai-gateway/free-model-rate-limit';
import { getRuntimeOrganizationFeatures } from '@kilocode/web-shared/lib/ai-gateway/organization-features';
import { DEFAULT_ORGANIZATION_FEATURES } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import {
  NO_ORGANIZATION_GATEWAY_SETTINGS,
  type OrganizationGatewaySettings,
} from '@kilocode/web-shared/lib/ai-gateway/providers/organization-gateway-settings';
import { DEFAULT_BENCHMARK_USER_ID } from '@kilocode/auto-routing-contracts';

jest.mock('@kilocode/web-shared/lib/organizations/organization-usage', () => ({
  getBalanceAndOrgSettings: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/gateway-account-rate-limit', () => ({
  gatewayRateLimitKey: jest.fn(),
  isGatewayAccountRateLimited: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/free-model-rate-limit', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@kilocode/web-shared/lib/ai-gateway/free-model-rate-limit'
  ),
  isFreeModelRateLimited: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/organization-features', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@kilocode/web-shared/lib/ai-gateway/organization-features'
  ),
  getRuntimeOrganizationFeatures: jest.fn(),
}));

const user = { id: 'user-1', google_user_email: 'user@example.com', microdollars_used: 5 } as User;

type AuthFailureOptions = {
  credentialsRejected?: boolean;
  authorizationRefused?: boolean;
  error?: string;
};

type TestAuthFailure = {
  user: null;
  authFailedResponse: NextResponse<{ success: false; error: string }>;
  credentialsRejected: boolean;
  authorizationRefused: boolean;
};

function authFailure(status: number, options: AuthFailureOptions = {}): TestAuthFailure {
  return {
    user: null,
    authFailedResponse: NextResponse.json(
      { success: false as const, error: options.error ?? 'Auth failed' },
      { status }
    ),
    credentialsRejected: options.credentialsRejected ?? false,
    authorizationRefused: options.authorizationRefused ?? false,
  };
}

function resolveOnAnonymousCapableRoute(auth: TestAuthFailure) {
  return resolveGatewayCaller(auth, { allowAnonymous: true, ipAddress: '192.0.2.1' });
}

function resolveOnSignedInOnlyRoute(auth: TestAuthFailure) {
  return resolveGatewayCaller(auth, { allowAnonymous: false, passThroughAuthFailure: true });
}

describe('resolveGatewayCaller', () => {
  it('resolves a verified user as signed in with its organization and bot', () => {
    const caller = resolveGatewayCaller(
      { user, authFailedResponse: null, organizationId: 'org-1', botId: 'bot-1' },
      { allowAnonymous: true, ipAddress: '192.0.2.1' }
    );

    expect(caller).toEqual({
      kind: 'signed-in',
      user,
      organizationId: 'org-1',
      botId: 'bot-1',
    });
  });

  it.each([
    { route: 'anonymous-capable', resolve: resolveOnAnonymousCapableRoute },
    { route: 'signed-in-only', resolve: resolveOnSignedInOnlyRoute },
  ])(
    'answers a rejected credential with INVALID_TOKEN on the $route route',
    async ({ resolve }) => {
      const caller = resolve(authFailure(401, { credentialsRejected: true }));

      expect(caller.kind).toBe('rejected');
      if (caller.kind !== 'rejected') return;
      expect(caller.response.status).toBe(401);
      expect(caller.response.headers.get('WWW-Authenticate')).toBe('Bearer error="invalid_token"');
      await expect(caller.response.json()).resolves.toMatchObject({
        error: { code: INVALID_TOKEN_CODE },
      });
    }
  );

  const authorizationRefusals = [
    { scenario: 'a refused account', error: 'Access denied (R1)' },
    { scenario: 'a refused email domain', error: 'Access denied (R0)' },
    {
      scenario: 'an unavailable organization context',
      error: 'Access denied (not a member of the organization)',
    },
    { scenario: 'an admin-only route', error: 'Access denied (nonadmin)' },
  ];
  const authorizationRefusalCases = authorizationRefusals.flatMap(refusal =>
    [
      { route: 'anonymous-capable', resolve: resolveOnAnonymousCapableRoute },
      { route: 'signed-in-only', resolve: resolveOnSignedInOnlyRoute },
    ].map(routeShape => ({ ...refusal, ...routeShape }))
  );

  it.each(authorizationRefusalCases)(
    'returns the authorization response for $scenario on the $route route',
    async ({ resolve, error }) => {
      const auth = authFailure(403, { authorizationRefused: true, error });

      const caller = resolve(auth);

      expect(caller.kind).toBe('rejected');
      if (caller.kind !== 'rejected') return;
      expect(caller.response).toBe(auth.authFailedResponse);
      expect(caller.response.status).toBe(403);
      await expect(caller.response.json()).resolves.toEqual({ success: false, error });
    }
  );

  it('resolves a missing credential as anonymous when allowed and the IP is known', () => {
    const caller = resolveOnAnonymousCapableRoute(authFailure(401));

    expect(caller).toMatchObject({
      kind: 'anonymous',
      user: { isAnonymous: true, ipAddress: '192.0.2.1', microdollars_used: 0 },
    });
  });

  it.each<{ allowAnonymous: boolean; ipAddress: string | undefined }>([
    { allowAnonymous: true, ipAddress: undefined },
    { allowAnonymous: false, ipAddress: '192.0.2.1' },
  ])('asks a caller without a credential to sign in: %j', async opts => {
    const caller = resolveGatewayCaller(authFailure(403), opts);

    expect(caller.kind).toBe('rejected');
    if (caller.kind !== 'rejected') return;
    expect(caller.response.status).toBe(401);
    await expect(caller.response.json()).resolves.toMatchObject({
      error: { code: 'PAID_MODEL_AUTH_REQUIRED' },
      error_type: ProxyErrorType.paid_model_auth_required,
    });
  });

  it('passes an auth failure without a rejected credential through when asked', () => {
    const auth = authFailure(403);

    const caller = resolveOnSignedInOnlyRoute(auth);

    expect(caller).toEqual({ kind: 'rejected', response: auth.authFailedResponse });
  });
});

describe('readGatewayBalance', () => {
  beforeEach(() => {
    jest.mocked(getBalanceAndOrgSettings).mockReset().mockResolvedValue({ balance: 3 });
  });

  it('reads a paid model balance from the replica as usage funding', async () => {
    await expect(readGatewayBalance(user, 'org-1', 'openai/gpt-4o')).resolves.toEqual({
      balance: 3,
    });
    expect(jest.mocked(getBalanceAndOrgSettings).mock.calls).toEqual([
      ['org-1', user, readDb, 'usage'],
    ]);
  });

  it('reads a free model balance from the replica without usage funding', async () => {
    await readGatewayBalance(user, undefined, 'vendor/model:free');
    expect(jest.mocked(getBalanceAndOrgSettings).mock.calls).toEqual([
      [undefined, user, readDb, undefined],
    ]);
  });
});

describe('paidUsageRejection', () => {
  it.each([
    { balance: 0.01, exempt: false },
    { balance: 0, exempt: true },
    { balance: -1, exempt: true },
  ])('admits balance $balance when exempt is $exempt', ({ balance, exempt }) => {
    expect(
      paidUsageRejection({ user, organizationId: undefined, account: { balance }, exempt })
    ).toBeNull();
  });

  it('blocks a spent balance with the credits response', async () => {
    const creditsBlocked = paidUsageRejection({
      user,
      organizationId: 'org-1',
      account: { balance: 0, balanceLimitedByUserAllowance: true },
      exempt: false,
    });

    expect(creditsBlocked).not.toBeNull();
    const response = await creditsBlocked?.();
    expect(response?.status).toBe(402);
    await expect(response?.json()).resolves.toMatchObject({
      error: { balance: 0 },
      error_type: ProxyErrorType.usage_limit_exceeded,
    });
  });
});

describe('organizationProviderPreferences', () => {
  it('leaves the request provider alone when the organization requires nothing', () => {
    expect(
      organizationProviderPreferences({
        decision: { allowed: true },
        settings: {},
        requestProvider: { zdr: true },
      })
    ).toEqual({ kind: 'allowed', provider: undefined });
  });

  it.each([
    { allowed: false },
    { allowed: true, eligibleProviderRoutes: new Set<string>() },
    { allowed: true, eligibleProviderRoutes: new Set(['virtual']) },
  ])('rejects a decision without a usable route: %j', decision => {
    const preferences = organizationProviderPreferences({
      decision,
      settings: undefined,
      requestProvider: undefined,
    });

    expect(preferences.kind).toBe('rejected');
    if (preferences.kind === 'rejected') expect(preferences.response.status).toBe(404);
  });

  it('limits routing to the real eligible providers and keeps the request privacy', () => {
    expect(
      organizationProviderPreferences({
        decision: { allowed: true, eligibleProviderRoutes: new Set(['openai', 'virtual']) },
        settings: undefined,
        requestProvider: { data_collection: 'allow', zdr: false },
      })
    ).toEqual({
      kind: 'allowed',
      provider: { only: ['openai'], data_collection: 'allow', zdr: false },
    });
  });

  it.each([
    { organization: 'allow', request: 'deny' },
    { organization: 'deny', request: 'allow' },
    { organization: 'deny', request: undefined },
  ] as const)(
    'denies collection for organization=$organization and request=$request',
    ({ organization, request }) => {
      expect(
        organizationProviderPreferences({
          decision: undefined,
          settings: { data_collection: organization },
          requestProvider: { data_collection: request },
        })
      ).toEqual({ kind: 'allowed', provider: { data_collection: 'deny' } });
    }
  );
});

describe('gatewayUsageContextBase', () => {
  function request(headers: Record<string, string> = {}) {
    return new NextRequest('http://localhost:3000/api/v1/embeddings', { method: 'POST', headers });
  }

  it('derives the shared usage fields from the headers and the signed-in caller', () => {
    const base = gatewayUsageContextBase(
      request({
        'x-kilocode-projectid': 'https://github.com/Kilo-Org/handbook.git',
        'x-kilocode-editorname': 'vscode',
        'x-kilocode-machineid': 'machine-1',
        'x-kilocode-mode': 'code',
        'x-kilocode-taskid': 'task-1',
        'x-kilo-session': 'session-1',
      }),
      { kind: 'signed-in', user, organizationId: 'org-1' },
      { requestStartedAt: 42 }
    );

    expect(base.context).toEqual({
      kiloUserId: 'user-1',
      organizationId: 'org-1',
      fraudHeaders: expect.any(Object),
      project_id: 'handbook',
      editor_name: 'vscode',
      machine_id: 'machine-1',
      mode: 'code',
      session_id: 'task-1',
      posthog_distinct_id: 'user@example.com',
      prior_microdollar_usage: 5,
      requestStartedAt: 42,
      custom_llm_pricing: null,
      max_tokens: null,
      has_middle_out_transform: null,
      reasoning_setting: null,
      inference_region: null,
      status_code: null,
      auto_model: null,
      ttfb_ms: null,
    });
  });

  it('falls back to the session header and leaves anonymous callers unattributed', () => {
    const anonymous = createAnonymousContext('192.0.2.1');

    const { context } = gatewayUsageContextBase(
      request({ 'x-kilo-session': 'session-1' }),
      { kind: 'anonymous', user: anonymous },
      { requestStartedAt: 0 }
    );

    expect(context).toMatchObject({
      kiloUserId: anonymous.id,
      organizationId: undefined,
      posthog_distinct_id: undefined,
      prior_microdollar_usage: 0,
      session_id: 'session-1',
      mode: null,
      editor_name: null,
    });
  });

  it.each<{ headers: Record<string, string>; clientAttributed: boolean }>([
    { headers: {}, clientAttributed: false },
    { headers: { 'x-kilocode-feature': 'not-a-feature' }, clientAttributed: false },
    { headers: { 'x-kilocode-feature': 'vscode-extension' }, clientAttributed: true },
    { headers: { 'x-kilocode-version': '5.0.0' }, clientAttributed: true },
  ])('attributes a Kilo client from its own headers: %j', ({ headers, clientAttributed }) => {
    const base = gatewayUsageContextBase(
      request(headers),
      { kind: 'signed-in', user, organizationId: undefined },
      { requestStartedAt: 0 }
    );

    expect(base.clientAttributed).toBe(clientAttributed);
  });
});

describe('gatewayAccountRateLimitRejection', () => {
  const request = new NextRequest('http://localhost:3000/api/v1/embeddings', { method: 'POST' });

  beforeEach(() => {
    jest.mocked(gatewayRateLimitKey).mockReset().mockReturnValue('account-key');
    jest.mocked(isGatewayAccountRateLimited).mockReset();
  });

  it('admits an account under the cap', async () => {
    jest.mocked(isGatewayAccountRateLimited).mockResolvedValue(false);

    await expect(gatewayAccountRateLimitRejection(request, '192.0.2.1')).resolves.toBeNull();
    expect(gatewayRateLimitKey).toHaveBeenCalledWith(request.headers, '192.0.2.1');
    expect(isGatewayAccountRateLimited).toHaveBeenCalledWith(request, 'account-key');
  });

  it('answers an account over the cap with the rate limit response', async () => {
    jest.mocked(isGatewayAccountRateLimited).mockResolvedValue(true);

    const response = await gatewayAccountRateLimitRejection(request, undefined);

    expect(response?.status).toBe(429);
    await expect(response?.json()).resolves.toEqual({
      error: 'Rate limit exceeded',
      error_type: ProxyErrorType.rate_limit_exceeded,
      message: 'Too many requests. Please try again later.',
    });
  });
});

describe('freeModelRateLimitRejection', () => {
  const request = new NextRequest('http://localhost:3000/api/v1/embeddings', { method: 'POST' });
  const signedIn = { kind: 'signed-in', user, organizationId: undefined } as const;
  const anonymous = { kind: 'anonymous', user: createAnonymousContext('192.0.2.1') } as const;

  function reject(caller: typeof signedIn | typeof anonymous) {
    return freeModelRateLimitRejection({
      request,
      caller,
      model: 'vendor/model:free',
      feature: null,
    });
  }

  beforeEach(() => {
    jest.mocked(isFreeModelRateLimited).mockReset();
  });

  it('counts a signed-in caller per account', async () => {
    jest.mocked(isFreeModelRateLimited).mockResolvedValue(false);

    await expect(reject(signedIn)).resolves.toBeNull();
    expect(isFreeModelRateLimited).toHaveBeenCalledWith(request, {
      kind: 'account',
      kiloUserId: 'user-1',
    });
  });

  it('answers a limited account with the account response', async () => {
    jest.mocked(isFreeModelRateLimited).mockResolvedValue(true);

    const response = await reject(signedIn);

    expect(response?.status).toBe(429);
    expect(response?.headers.get('x-should-retry')).toBe('false');
    const body = await response?.json();
    expect(body).toMatchObject({ error_type: ProxyErrorType.rate_limit_exceeded });
    expect(JSON.stringify(body)).not.toContain('PROMOTION_MODEL_LIMIT_REACHED');
  });

  it('counts an anonymous caller per IP and answers with the sign-up prompt', async () => {
    jest.mocked(isFreeModelRateLimited).mockResolvedValue(true);

    const response = await reject(anonymous);

    expect(isFreeModelRateLimited).toHaveBeenCalledWith(request, {
      kind: 'ip',
      ipAddress: '192.0.2.1',
    });
    expect(response?.status).toBe(429);
    await expect(response?.json()).resolves.toMatchObject({
      error: { code: 'PROMOTION_MODEL_LIMIT_REACHED' },
      error_type: ProxyErrorType.rate_limit_exceeded,
    });
  });

  it('exempts the default benchmark user without counting it', async () => {
    jest.mocked(isFreeModelRateLimited).mockResolvedValue(true);

    await expect(
      reject({ ...signedIn, user: { ...user, id: DEFAULT_BENCHMARK_USER_ID } })
    ).resolves.toBeNull();
    expect(isFreeModelRateLimited).not.toHaveBeenCalled();
  });
});

describe('gatewaySettingsRejection', () => {
  const openRouterDisabled: OrganizationGatewaySettings = {
    openRouterDisabled: true,
    dataRegion: null,
  };
  const euRegion: OrganizationGatewaySettings = { openRouterDisabled: true, dataRegion: 'eu' };
  const vercel = { type: 'vercel', apiUrl: 'https://ai-gateway.vercel.sh/v1' } as const;
  const userByok = [{ decryptedAPIKey: 'sk-user', providerId: 'openrouter' }] as const;

  it.each([
    { type: 'openrouter', apiUrl: 'https://openrouter.ai/api/v1' },
    { type: 'custom', apiUrl: 'https://openrouter.ai/api/v1' },
  ] as const)('rejects a $type provider at $apiUrl when OpenRouter is disabled', async provider => {
    const response = gatewaySettingsRejection(openRouterDisabled, { provider, userByok: null });

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({
      error:
        'This request would be routed through OpenRouter, which your organization has disabled.',
      error_type: ProxyErrorType.provider_not_allowed,
    });
  });

  it.each([
    { type: 'openrouter', apiUrl: 'https://openrouter.ai/api/v1' },
    { type: 'custom', apiUrl: 'https://llm.example.com/v1' },
  ] as const)('rejects a $type provider under an inference region', async provider => {
    const response = gatewaySettingsRejection(euRegion, { provider, userByok: null });

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({
      error:
        'Your organization requires inference in the European Union region, which this request cannot use.',
      error_type: ProxyErrorType.provider_not_allowed,
    });
  });

  it.each([
    { settings: openRouterDisabled, provider: vercel, userByok: null },
    { settings: euRegion, provider: vercel, userByok: null },
    {
      settings: openRouterDisabled,
      provider: { type: 'custom', apiUrl: 'https://notopenrouter.ai/v1' },
      userByok: null,
    },
    {
      settings: NO_ORGANIZATION_GATEWAY_SETTINGS,
      provider: { type: 'openrouter', apiUrl: 'https://openrouter.ai/api/v1' },
      userByok: null,
    },
    {
      settings: euRegion,
      provider: { type: 'openrouter', apiUrl: 'https://openrouter.ai/api/v1' },
      userByok,
    },
    {
      settings: euRegion,
      provider: { type: 'direct-byok', apiUrl: 'https://api.openai.com/v1' },
      userByok: [{ decryptedAPIKey: 'sk-user', providerId: 'openai' }],
    },
  ] as const)('admits a $provider.type route', ({ settings, provider, userByok }) => {
    expect(gatewaySettingsRejection(settings, { provider, userByok })).toBeNull();
  });
});

describe('resolveOrganizationGatewaySettings', () => {
  const settings = { disable_openrouter: true, data_region: 'eu' } as const;

  beforeEach(() => {
    jest
      .mocked(getRuntimeOrganizationFeatures)
      .mockReset()
      .mockResolvedValue({ ...DEFAULT_ORGANIZATION_FEATURES, gateway_settings: ['org-1'] });
  });

  it('returns the settings of an enterprise organization with the organization feature', async () => {
    await expect(
      resolveOrganizationGatewaySettings({
        organizationId: 'org-1',
        plan: 'enterprise',
        settings,
      })
    ).resolves.toEqual({ openRouterDisabled: true, dataRegion: 'eu' });
  });

  it.each([
    { name: 'a teams plan', organizationId: 'org-1', plan: 'teams', settings },
    { name: 'an unknown plan', organizationId: 'org-1', plan: undefined, settings },
    {
      name: 'an organization outside the feature',
      organizationId: 'org-2',
      plan: 'enterprise',
      settings,
    },
    { name: 'no organization', organizationId: undefined, plan: 'enterprise', settings },
    { name: 'no settings', organizationId: 'org-1', plan: 'enterprise', settings: undefined },
  ] as const)('applies no settings for $name', async ({ organizationId, plan, settings }) => {
    await expect(
      resolveOrganizationGatewaySettings({ organizationId, plan, settings })
    ).resolves.toEqual(NO_ORGANIZATION_GATEWAY_SETTINGS);
  });

  it('skips the feature lookup without an organization or settings', async () => {
    await resolveOrganizationGatewaySettings({
      organizationId: undefined,
      plan: 'enterprise',
      settings,
    });
    await resolveOrganizationGatewaySettings({
      organizationId: 'org-1',
      plan: 'enterprise',
      settings: undefined,
    });

    expect(getRuntimeOrganizationFeatures).not.toHaveBeenCalled();
  });
});
