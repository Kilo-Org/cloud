process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';

const mockEnsureOrganizationAccess = jest.fn();
const mockConsumeProviderOAuthAttempt = jest.fn();
const mockUpsertSlackInstallation = jest.fn();
const mockHandleOAuthCallback = jest.fn();
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
      handleOAuthCallback: (...args: unknown[]) => mockHandleOAuthCallback(...args),
    }),
  },
}));
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
  statePurpose: 'provider_install' | undefined = 'provider_install'
) {
  const state = createOAuthState(owner, USER_ID, undefined, statePurpose);
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
    mockHandleOAuthCallback.mockResolvedValue({ teamId: 'T123', installation });
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
    expect(mockHandleOAuthCallback).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('completes an organization install for an admin and authorizes a workspace change', async () => {
    mockEnsureOrganizationAccess.mockResolvedValue('admin');

    const { response } = await callCallback(`org_${ORGANIZATION_ID}`);

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe(
      '/organizations/' + ORGANIZATION_ID + '/integrations/slack'
    );
    expect(mockUpsertSlackInstallation).toHaveBeenCalledWith({
      owner: { type: 'org', id: ORGANIZATION_ID },
      teamId: 'T123',
      installation,
      allowWorkspaceRebind: true,
    });
  });

  it('keeps a same-workspace re-install working for an organization admin', async () => {
    mockEnsureOrganizationAccess.mockResolvedValue('owner');
    mockHandleOAuthCallback.mockResolvedValue({ teamId: 'T123', installation });

    const { response } = await callCallback(`org_${ORGANIZATION_ID}`);

    expect(new URL(response.headers.get('location') ?? '').searchParams.get('success')).toBe(
      'installed'
    );
    expect(mockUpsertSlackInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'T123', allowWorkspaceRebind: true })
    );
  });

  it('does not require organization authority for a personal completion', async () => {
    const { response } = await callCallback(`user_${USER_ID}`);

    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/integrations/slack');
    expect(mockEnsureOrganizationAccess).not.toHaveBeenCalled();
    expect(mockUpsertSlackInstallation).toHaveBeenCalledWith({
      owner: { type: 'user', id: USER_ID },
      teamId: 'T123',
      installation,
      allowWorkspaceRebind: false,
    });
  });
});
