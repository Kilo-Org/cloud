import { beforeEach, describe, expect, it } from '@jest/globals';
import { NextResponse } from 'next/server';
import type { User } from '@kilocode/db/schema';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import { INVALID_TOKEN_CODE } from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { getBalanceAndOrgSettings } from '@kilocode/web-shared/lib/organizations/organization-usage';
import {
  organizationProviderPreferences,
  paidUsageRejection,
  readGatewayBalance,
  resolveGatewayCaller,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-admission';

jest.mock('@kilocode/web-shared/lib/organizations/organization-usage', () => ({
  getBalanceAndOrgSettings: jest.fn(),
}));

const user = { id: 'user-1', google_user_email: 'user@example.com', microdollars_used: 5 } as User;

function authFailure(status: number, credentialsRejected: boolean) {
  return {
    user: null,
    authFailedResponse: NextResponse.json(
      { success: false as const, error: 'Auth failed' },
      { status }
    ),
    credentialsRejected,
  };
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
    {
      route: 'free-capable',
      resolve: (auth: ReturnType<typeof authFailure>) =>
        resolveGatewayCaller(auth, { allowAnonymous: true, ipAddress: '192.0.2.1' }),
    },
    {
      route: 'pass-through',
      resolve: (auth: ReturnType<typeof authFailure>) =>
        resolveGatewayCaller(auth, { allowAnonymous: false, passThroughAuthFailure: true }),
    },
  ])('answers a rejected credential with INVALID_TOKEN on a $route route', async ({ resolve }) => {
    const caller = resolve(authFailure(401, true));

    expect(caller.kind).toBe('rejected');
    if (caller.kind !== 'rejected') return;
    expect(caller.response.status).toBe(401);
    expect(caller.response.headers.get('WWW-Authenticate')).toBe('Bearer error="invalid_token"');
    await expect(caller.response.json()).resolves.toMatchObject({
      error: { code: INVALID_TOKEN_CODE },
    });
  });

  it('resolves a missing credential as anonymous when allowed and the IP is known', () => {
    const caller = resolveGatewayCaller(authFailure(401, false), {
      allowAnonymous: true,
      ipAddress: '192.0.2.1',
    });

    expect(caller).toMatchObject({
      kind: 'anonymous',
      user: { isAnonymous: true, ipAddress: '192.0.2.1', microdollars_used: 0 },
    });
  });

  it.each<{ allowAnonymous: boolean; ipAddress: string | undefined }>([
    { allowAnonymous: true, ipAddress: undefined },
    { allowAnonymous: false, ipAddress: '192.0.2.1' },
  ])('asks a caller without a credential to sign in: %j', async opts => {
    const caller = resolveGatewayCaller(authFailure(403, false), opts);

    expect(caller.kind).toBe('rejected');
    if (caller.kind !== 'rejected') return;
    expect(caller.response.status).toBe(401);
    await expect(caller.response.json()).resolves.toMatchObject({
      error: { code: 'PAID_MODEL_AUTH_REQUIRED' },
      error_type: ProxyErrorType.paid_model_auth_required,
    });
  });

  it('passes an auth failure without a rejected credential through when asked', () => {
    const auth = authFailure(403, false);

    const caller = resolveGatewayCaller(auth, {
      allowAnonymous: false,
      passThroughAuthFailure: true,
    });

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
