process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';

const mockEnsureOrganizationAccess = jest.fn();
const mockConsumeProviderOAuthAttempt = jest.fn();
const mockUpsertSlackInstallation = jest.fn();
const mockRetirePreviousSlackWorkspace = jest.fn();
const mockExchangeSlackOAuthCode = jest.fn();
const mockCaptureException = jest.fn();
const mockCaptureMessage = jest.fn();
const mockGetSlackInstallation = jest.fn<Promise<unknown>, [string]>(async () => null);
const mockSetSlackInstallation = jest.fn<Promise<void>, [string, unknown]>(async () => undefined);
const mockDeleteSlackInstallation = jest.fn<Promise<void>, [string]>(async () => undefined);

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
    getState: () => ({}),
    getAdapter: () => ({
      getInstallation: (...args: [string]) => mockGetSlackInstallation(...args),
      setInstallation: (...args: [string, unknown]) => mockSetSlackInstallation(...args),
      deleteInstallation: (...args: [string]) => mockDeleteSlackInstallation(...args),
    }),
  },
}));
jest.mock('@/lib/bot-identity', () => ({
  unlinkTeamKiloUsers: jest.fn(async () => 0),
}));
jest.mock('@/lib/slack-bot/model-allow-list', () => ({
  getDefaultAllowedModel: jest.fn(async () => 'test/default-model'),
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
  class SlackWorkspaceRebindUnsettledError extends Error {
    constructor(readonly reason: 'read_failed' | 'credential_unreadable') {
      super(`The previous Slack workspace could not be settled: ${reason}`);
      this.name = 'SlackWorkspaceRebindUnsettledError';
    }
  }
  return {
    SlackWorkspaceAlreadyConnectedError,
    SlackWorkspaceRebindUnsettledError,
    exchangeSlackOAuthCode: (...args: unknown[]) => mockExchangeSlackOAuthCode(...args),
    getConflictingSlackInstallation: jest.fn(async () => null),
    retirePreviousSlackWorkspace: (...args: unknown[]) => mockRetirePreviousSlackWorkspace(...args),
    upsertSlackInstallation: (...args: unknown[]) => mockUpsertSlackInstallation(...args),
  };
});

import { TRPCError } from '@trpc/server';
import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { ORGANIZATION_MANAGE_ROLES } from '@kilocode/app-shared/organizations';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import { unlinkTeamKiloUsers } from '@/lib/bot-identity';
import { SlackWorkspaceRebindUnsettledError } from '@/lib/integrations/slack-service';
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

function makeCallbackRequest(query: string) {
  return new NextRequest(`http://localhost:3000/api/integrations/slack/callback?${query}`);
}

/** Every captured diagnostic carries the shared callback context and nothing raw. */
function expectRedactedDiagnostic(state: string, code?: string) {
  const calls = [...mockCaptureMessage.mock.calls, ...mockCaptureException.mock.calls];
  expect(calls).toHaveLength(1);
  const context = calls[0]![1] as { extra?: Record<string, unknown> };
  expect(context.extra).toEqual(
    expect.objectContaining({
      hasState: true,
      stateHash: expect.stringMatching(/^[0-9a-f]{8}$/),
    })
  );
  expect(context.extra).not.toHaveProperty('state');
  expect(context.extra).not.toHaveProperty('code');
  const serialized = JSON.stringify(context);
  expect(serialized).not.toContain(state);
  if (code) expect(serialized).not.toContain(code);
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
    mockUpsertSlackInstallation.mockResolvedValue({
      integration: { id: 'integration-1' },
      previousWorkspace: null,
    });
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

describe('handleSlackOAuthCallback diagnostics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID, is_admin: false },
      authFailedResponse: null,
    } as never);
    mockEnsureOrganizationAccess.mockResolvedValue('owner');
    mockConsumeProviderOAuthAttempt.mockResolvedValue(true);
    mockUpsertSlackInstallation.mockResolvedValue({
      integration: { id: 'integration-1' },
      previousWorkspace: null,
    });
    mockExchangeSlackOAuthCode.mockResolvedValue({ installationId: 'T123', installation });
  });

  it('reports a provider error with the shared callback context', async () => {
    const state = createOAuthState(`user_${USER_ID}`, USER_ID, undefined, {
      provider: 'slack',
      purpose: 'provider_install',
    });

    const response = await handleSlackOAuthCallback(
      makeCallbackRequest(`error=access_denied&state=${encodeURIComponent(state)}`)
    );

    expect(new URL(response.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'access_denied'
    );
    expectRedactedDiagnostic(state);
    expect(mockCaptureMessage.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ extra: expect.objectContaining({ error: 'access_denied' }) })
    );
  });

  it('reports a missing code with the shared callback context', async () => {
    const state = createOAuthState(`user_${USER_ID}`, USER_ID, undefined, {
      provider: 'slack',
      purpose: 'provider_install',
    });

    const response = await handleSlackOAuthCallback(
      makeCallbackRequest(`state=${encodeURIComponent(state)}`)
    );

    expect(new URL(response.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'missing_code'
    );
    expectRedactedDiagnostic(state);
  });

  it('reports a rejected state signature with the shared callback context', async () => {
    const state = createOAuthState(`user_${USER_ID}`, USER_ID, undefined, {
      provider: 'slack',
      purpose: 'provider_install',
    });
    const tampered = `${state.slice(0, -1)}${state.endsWith('A') ? 'B' : 'A'}`;

    const response = await handleSlackOAuthCallback(
      makeCallbackRequest(`code=code-1&state=${encodeURIComponent(tampered)}`)
    );

    const redirect = new URL(response.headers.get('location') ?? '');
    expect(`${redirect.pathname}${redirect.search}`).toBe('/integrations?error=invalid_state');
    expectRedactedDiagnostic(tampered, 'code-1');
  });

  it('reports an installation failure with the shared callback context', async () => {
    mockExchangeSlackOAuthCode.mockRejectedValue(new Error('slack exchange failed'));

    const { response, state } = await callCallback(`user_${USER_ID}`);

    expect(new URL(response.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'installation_failed'
    );
    expectRedactedDiagnostic(state, 'code-1');
  });
});

describe('handleSlackOAuthCallback replaced workspace settlement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID, is_admin: false },
      authFailedResponse: null,
    } as never);
    mockEnsureOrganizationAccess.mockResolvedValue('owner');
    mockConsumeProviderOAuthAttempt.mockResolvedValue(true);
    mockExchangeSlackOAuthCode.mockResolvedValue({ installationId: 'T123', installation });
    // The Chat SDK holds no installation unless a test scripts one.
    mockGetSlackInstallation.mockResolvedValue(null);
  });

  it('retires the workspace a rebind replaced after the install commits', async () => {
    const previousWorkspace = { teamId: 'T_OLD', botToken: 'xoxb-old' };
    mockUpsertSlackInstallation.mockResolvedValue({
      integration: { id: 'integration-1' },
      previousWorkspace,
    });

    const { response } = await callCallback(`user_${USER_ID}`);

    expect(mockRetirePreviousSlackWorkspace).toHaveBeenCalledTimes(1);
    expect(mockRetirePreviousSlackWorkspace).toHaveBeenCalledWith(
      previousWorkspace,
      expect.objectContaining({
        deleteChatSdkInstallation: expect.any(Function),
        deleteChatSdkIdentityCache: expect.any(Function),
      })
    );
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('success')).toBe(
      'installed'
    );
  });

  it('forwards the settlement signal into the identity-cache removal it hands the retirement', async () => {
    mockUpsertSlackInstallation.mockResolvedValue({
      integration: { id: 'integration-1' },
      previousWorkspace: { teamId: 'T_OLD', botToken: 'xoxb-old' },
    });

    await callCallback(`user_${USER_ID}`);

    const [, options] = mockRetirePreviousSlackWorkspace.mock.calls[0] as [
      { teamId: string },
      {
        deleteChatSdkIdentityCache: (teamId: string, signal?: AbortSignal) => Promise<void>;
      },
    ];
    const signal = new AbortController().signal;
    await options.deleteChatSdkIdentityCache('T_OLD', signal);

    // The scan stops on the retirement's deadline rather than running past it.
    const mockedUnlinkTeamKiloUsers = jest.mocked(unlinkTeamKiloUsers);
    expect(mockedUnlinkTeamKiloUsers).toHaveBeenCalledWith(expect.anything(), 'slack', 'T_OLD', {
      signal,
    });
  });

  it('asks for another attempt when the replaced workspace token cannot be read', async () => {
    mockUpsertSlackInstallation.mockRejectedValue(
      new SlackWorkspaceRebindUnsettledError('read_failed')
    );

    const { response } = await callCallback(`user_${USER_ID}`);

    expect(new URL(response.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'previous_workspace_unconfirmed'
    );
    expect(mockRetirePreviousSlackWorkspace).not.toHaveBeenCalled();
  });

  it('names the support path when the replaced workspace credential cannot be decrypted', async () => {
    mockUpsertSlackInstallation.mockRejectedValue(
      new SlackWorkspaceRebindUnsettledError('credential_unreadable')
    );

    const { response } = await callCallback(`user_${USER_ID}`);

    expect(new URL(response.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'previous_workspace_unreadable'
    );
    expect(mockRetirePreviousSlackWorkspace).not.toHaveBeenCalled();
  });

  it('restores the installation when the rebind stops', async () => {
    const previousInstallation = {
      botToken: 'xoxb-previous',
      botUserId: 'U_PREVIOUS_BOT',
      teamName: 'Previous Team',
    };
    mockGetSlackInstallation.mockResolvedValue(previousInstallation);
    mockUpsertSlackInstallation.mockRejectedValue(
      new SlackWorkspaceRebindUnsettledError('credential_unreadable')
    );

    const { response } = await callCallback(`user_${USER_ID}`);

    expect(mockSetSlackInstallation).toHaveBeenLastCalledWith('T123', previousInstallation);
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'previous_workspace_unreadable'
    );
  });
});
