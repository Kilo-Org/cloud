import { beforeEach, describe, expect, test } from '@jest/globals';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { TRPCError } from '@trpc/server';
import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { verifyOAuthState } from '@/lib/integrations/oauth-state';
import {
  BitbucketIntegrationRecoveryError,
  getBitbucketOAuthRecovery,
} from '@/lib/integrations/platforms/bitbucket/credentials';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';

jest.mock('@/lib/constants', () => ({ APP_URL: 'http://localhost:3000' }));
jest.mock('@/lib/config.server', () => ({
  BITBUCKET_CLIENT_ID: 'bitbucket-client-id',
  NEXTAUTH_SECRET: 'test-nextauth-secret',
}));
jest.mock('@/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@/lib/organizations/trial-middleware', () => ({
  requireActiveSubscriptionOrTrial: jest.fn(),
}));
jest.mock('@/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
}));
jest.mock('@/lib/integrations/platforms/bitbucket/credentials', () => ({
  getBitbucketOAuthRecovery: jest.fn(),
  BitbucketIntegrationRecoveryError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedEnsureOrganizationAccess = jest.mocked(ensureOrganizationAccess);
const mockedGetRecovery = jest.mocked(getBitbucketOAuthRecovery);
const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const ORGANIZATION_ID = '7e3011af-e99d-444f-8171-54c2225b87dc';
const RECOVERY = {
  integrationId: '33333333-3333-4333-8333-333333333333',
  credentialId: '44444444-4444-4444-8444-444444444444',
  credentialVersion: 2,
  workspaceUuid: 'workspace-one',
  workspaceSlug: 'workspace-one',
};

async function callPublicBitbucketConnect(query: Record<string, string> = {}) {
  const { GET } = await import('../../[platform]/connect/route');
  const search = new URLSearchParams({
    organizationId: ORGANIZATION_ID,
    returnTo: `/organizations/${ORGANIZATION_ID}/integrations/bitbucket`,
    ...query,
  });
  return GET(
    new NextRequest(`http://localhost:3000/api/integrations/bitbucket/connect?${search}`),
    { params: Promise.resolve({ platform: 'bitbucket' }) }
  );
}

function redirectUrl(response: Response) {
  expect(response.status).toBe(307);
  return new URL(response.headers.get('location') ?? '');
}

describe('GET /api/integrations/bitbucket/connect', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);
    mockedEnsureOrganizationAccess.mockResolvedValue('owner');
    mockedGetRecovery.mockImplementation(async (owner, integrationId) => {
      if (
        owner.type !== 'org' ||
        owner.id !== ORGANIZATION_ID ||
        integrationId !== RECOVERY.integrationId
      ) {
        throw new BitbucketIntegrationRecoveryError('connection_changed');
      }
      return RECOVERY;
    });
  });

  test('dispatches normal first-connect without recovery and requests the added scope', async () => {
    const url = redirectUrl(await callPublicBitbucketConnect());
    expect(`${url.origin}${url.pathname}`).toBe('https://bitbucket.org/site/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual(
      expect.objectContaining({
        client_id: 'bitbucket-client-id',
        response_type: 'code',
        scope: 'account repository:write pullrequest webhook pullrequest:write',
      })
    );
    expect(verifyOAuthState(url.searchParams.get('state'))).toEqual({
      owner: `org_${ORGANIZATION_ID}`,
      userId: USER_ID,
      returnTo: `/organizations/${ORGANIZATION_ID}/integrations/bitbucket`,
    });
    expect(mockedEnsureOrganizationAccess).toHaveBeenCalledWith(
      { user: expect.objectContaining({ id: USER_ID }) },
      ORGANIZATION_ID,
      ORGANIZATION_BILLING_ROLES
    );
  });

  test('signs the current authorized recovery target rather than unsigned workspace selectors', async () => {
    const url = redirectUrl(
      await callPublicBitbucketConnect({
        reconnectIntegrationId: RECOVERY.integrationId,
        workspaceUuid: 'attacker-workspace',
        workspaceSlug: 'attacker-slug',
      })
    );
    expect(url.origin).toBe('https://bitbucket.org');
    expect(verifyOAuthState(url.searchParams.get('state'))).toEqual({
      owner: `org_${ORGANIZATION_ID}`,
      userId: USER_ID,
      returnTo: `/organizations/${ORGANIZATION_ID}/integrations/bitbucket`,
      bitbucketRecovery: RECOVERY,
    });
  });

  test('preserves the legacy first-connect authorization error', async () => {
    mockedEnsureOrganizationAccess.mockRejectedValue(new TRPCError({ code: 'UNAUTHORIZED' }));
    const url = redirectUrl(await callPublicBitbucketConnect());
    expect(url.searchParams.get('error')).toBe('oauth_init_failed');
    expect(url.searchParams.has('state')).toBe(false);
  });

  test('denies a non-manager before issuing recovery state', async () => {
    mockedEnsureOrganizationAccess.mockRejectedValue(new TRPCError({ code: 'UNAUTHORIZED' }));
    const url = redirectUrl(
      await callPublicBitbucketConnect({ reconnectIntegrationId: RECOVERY.integrationId })
    );
    expect(`${url.pathname}${url.search}`).toBe(
      `/organizations/${ORGANIZATION_ID}/integrations/bitbucket?error=unauthorized`
    );
    expect(url.searchParams.has('state')).toBe(false);
  });

  test.each(['', 'not-a-uuid', '55555555-5555-4555-8555-555555555555'])(
    'rejects an absent or mismatched recovery integration: %s',
    async reconnectIntegrationId => {
      const url = redirectUrl(await callPublicBitbucketConnect({ reconnectIntegrationId }));
      expect(url.searchParams.get('error')).toBe('connection_changed');
      expect(url.searchParams.has('state')).toBe(false);
    }
  );

  test('rejects recovery after disconnection', async () => {
    mockedGetRecovery.mockRejectedValue(
      new BitbucketIntegrationRecoveryError('connection_changed')
    );
    const url = redirectUrl(
      await callPublicBitbucketConnect({ reconnectIntegrationId: RECOVERY.integrationId })
    );
    expect(url.searchParams.get('error')).toBe('connection_changed');
    expect(url.searchParams.has('state')).toBe(false);
  });

  test('requires sign-in without starting recovery', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: new Response(null, { status: 401 }),
    } as never);
    const url = redirectUrl(
      await callPublicBitbucketConnect({ reconnectIntegrationId: RECOVERY.integrationId })
    );
    expect(url.pathname).toBe('/users/sign_in');
    expect(url.searchParams.get('callbackPath')).toBe(
      `/organizations/${ORGANIZATION_ID}/integrations/bitbucket`
    );
    expect(url.searchParams.has('state')).toBe(false);
  });
});
