process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';

const mockEnsureOrganizationAccess = jest.fn();
const mockConsumeProviderOAuthAttempt = jest.fn();
const mockUpsertSlackInstallation = jest.fn();
const mockExchangeSlackOAuthCode = jest.fn();
const mockCaptureException = jest.fn();
const mockCaptureMessage = jest.fn();

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'test-nextauth-secret',
}));
jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  ensureOrganizationAccess: (...args: unknown[]) => mockEnsureOrganizationAccess(...args),
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
}));
jest.mock('@/lib/bot', () => ({
  bot: {
    initialize: jest.fn(async () => {}),
    getAdapter: () => ({
      getInstallation: jest.fn(async () => null),
      setInstallation: jest.fn(async () => {}),
      deleteInstallation: jest.fn(async () => {}),
    }),
  },
}));
jest.mock('@/lib/slack-bot/model-allow-list', () => ({
  getDefaultAllowedModel: jest.fn(async () => 'test/default-model'),
}));
jest.mock('@/lib/bot/platforms', () => ({
  botPlatforms: {
    require: jest.fn(() => ({
      withAuthContext: async ({ fn }: { fn: () => Promise<unknown> }) => await fn(),
    })),
  },
}));
// `chat` ships ESM-only, so jest cannot require it; the install-flow tests never
// reach message deserialization.
jest.mock(
  'chat',
  () => ({
    Message: { fromJSON: jest.fn((value: unknown) => value) },
    ThreadImpl: { fromJSON: jest.fn((value: unknown) => value) },
  }),
  { virtual: true }
);
jest.mock('@/lib/integrations/provider-oauth-attempts', () => ({
  beginProviderOAuthAttempt: jest.fn(),
  cancelProviderOAuthAttempt: jest.fn(),
  consumeProviderOAuthAttempt: (...args: unknown[]) => mockConsumeProviderOAuthAttempt(...args),
}));
jest.mock('@/lib/integrations/slack-service', () => {
  class SlackWorkspaceAlreadyConnectedError extends Error {
    constructor(teamName: string) {
      super(`${teamName} is already connected to another Kilo account or organization.`);
      this.name = 'SlackWorkspaceAlreadyConnectedError';
    }
  }
  return {
    SlackWorkspaceAlreadyConnectedError,
    exchangeSlackOAuthCode: (...args: unknown[]) => mockExchangeSlackOAuthCode(...args),
    getConflictingSlackInstallation: jest.fn(async () => null),
    upsertSlackInstallation: (...args: unknown[]) => mockUpsertSlackInstallation(...args),
  };
});

import { TRPCError } from '@trpc/server';
import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { ORGANIZATION_MANAGE_ROLES } from '@kilocode/app-shared/organizations';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import { handleSlackOAuthCallback } from './slack-callback';

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const ORGANIZATION_ID = '7e3011af-e99d-444f-8171-54c2225b87dc';
const installation = { botToken: 'xoxb-token', botUserId: 'U_BOT', teamName: 'Kilo Team' };

const permissionDeniedError = new TRPCError({
  code: 'UNAUTHORIZED',
  message: 'You do not have the required organizational role to access this feature',
});

async function callCallback(
  owner: string,
  statePurpose: 'provider_install' | null = 'provider_install'
) {
  const state = createOAuthState(owner, USER_ID, undefined, {
    provider: 'slack',
    ...(statePurpose ? { purpose: statePurpose } : {}),
  });
  const request = new NextRequest(
    `http://localhost:3000/api/integrations/slack/callback?code=code-1&state=${encodeURIComponent(state)}`
  );
  const response = await handleSlackOAuthCallback(request);
  return { response, state };
}

describe('handleSlackOAuthCallback organization authority', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID, is_admin: false },
      authFailedResponse: null,
    } as never);
    mockEnsureOrganizationAccess.mockResolvedValue('owner');
    mockConsumeProviderOAuthAttempt.mockResolvedValue(true);
    mockUpsertSlackInstallation.mockResolvedValue({ id: 'integration-1' });
    mockExchangeSlackOAuthCode.mockResolvedValue({ installationId: 'T123', installation });
  });

  it('refuses an organization completion by a plain member', async () => {
    mockEnsureOrganizationAccess.mockRejectedValue(permissionDeniedError);

    const { response } = await callCallback(`org_${ORGANIZATION_ID}`);

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'permission_required'
    );
    expect(mockEnsureOrganizationAccess).toHaveBeenCalledWith(
      { user: expect.objectContaining({ id: USER_ID }) },
      ORGANIZATION_ID,
      ORGANIZATION_MANAGE_ROLES
    );
    expect(mockUpsertSlackInstallation).not.toHaveBeenCalled();
    expect(mockExchangeSlackOAuthCode).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('refuses a member completion that carries no install purpose', async () => {
    mockEnsureOrganizationAccess.mockRejectedValue(permissionDeniedError);

    const { response, state } = await callCallback(`org_${ORGANIZATION_ID}`, null);

    expect(JSON.parse(Buffer.from(state.split('.')[0], 'base64url').toString())).not.toHaveProperty(
      'purpose'
    );
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'permission_required'
    );
    expect(mockUpsertSlackInstallation).not.toHaveBeenCalled();
    expect(mockExchangeSlackOAuthCode).not.toHaveBeenCalled();
  });

  it('completes an organization installation', async () => {
    mockEnsureOrganizationAccess.mockResolvedValue('owner');

    const { response } = await callCallback(`org_${ORGANIZATION_ID}`);

    expect(new URL(response.headers.get('location') ?? '').searchParams.get('success')).toBe(
      'installed'
    );
  });

  it('does not require organization authority for a personal completion', async () => {
    const { response } = await callCallback(`user_${USER_ID}`);

    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/integrations/slack');
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('success')).toBe(
      'installed'
    );
    expect(mockEnsureOrganizationAccess).not.toHaveBeenCalled();
  });
});
