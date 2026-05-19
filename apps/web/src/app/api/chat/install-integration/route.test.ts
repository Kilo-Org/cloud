import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { verifyLinkToken, linkKiloUser, consumeLinkAccountContext } from '@/lib/bot-identity';
import { getUserFromAuth } from '@/lib/user.server';
import {
  canKiloUserAccessPlatformIntegration,
  getPlatformIntegration,
} from '@/lib/bot/platform-helpers';
import { getProfileOrganizations } from '@/lib/organizations/organizations';
import { upsertTeamsInstallation } from '@/lib/integrations/teams-service';
import { reprocessLinkedMessage } from '@/lib/bot/reprocess-linked-message';

const mockedAfter = jest.fn();
const mockState = { kind: 'state' };

jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server');
  return {
    ...actual,
    after: (fn: () => Promise<void> | void) => mockedAfter(fn),
  };
});

jest.mock('@/lib/bot/reprocess-linked-message', () => ({
  initializeBotForLinkReplay: jest.fn(async () => ({
    initialize: jest.fn(async () => undefined),
    getState: jest.fn(() => mockState),
  })),
  reprocessLinkedMessage: jest.fn(async () => undefined),
}));

jest.mock('@/lib/bot-identity', () => ({
  verifyLinkToken: jest.fn(),
  linkKiloUser: jest.fn(async () => undefined),
  consumeLinkAccountContext: jest.fn(async () => true),
}));

jest.mock('@/lib/user.server', () => ({
  getUserFromAuth: jest.fn(),
}));

jest.mock('@/lib/bot/platform-helpers', () => ({
  canKiloUserAccessPlatformIntegration: jest.fn(),
  getPlatformIntegration: jest.fn(),
}));

jest.mock('@/lib/organizations/organizations', () => ({
  getProfileOrganizations: jest.fn(),
}));

jest.mock('@/lib/bot/platforms/teams', () => ({
  getTeamsConversationNames: jest.fn(() => ({
    tenantName: 'Acme Teams',
    teamName: null,
    channelName: null,
  })),
}));

jest.mock('@/lib/integrations/teams-service', () => ({
  TeamsTenantAlreadyConnectedError: class TeamsTenantAlreadyConnectedError extends Error {},
  upsertTeamsInstallation: jest.fn(async () => ({ id: 'pi-teams' })),
}));

jest.mock(
  'chat',
  () => ({
    Message: {
      fromJSON: jest.fn(value => value),
    },
    ThreadImpl: {
      fromJSON: jest.fn(value => value),
    },
  }),
  { virtual: true }
);

const mockedVerifyLinkToken = jest.mocked(verifyLinkToken);
const mockedLinkKiloUser = jest.mocked(linkKiloUser);
const mockedConsumeLinkAccountContext = jest.mocked(consumeLinkAccountContext);
const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetPlatformIntegration = jest.mocked(getPlatformIntegration);
const mockedCanKiloUserAccessPlatformIntegration = jest.mocked(
  canKiloUserAccessPlatformIntegration
);
const mockedGetProfileOrganizations = jest.mocked(getProfileOrganizations);
const mockedUpsertTeamsInstallation = jest.mocked(upsertTeamsInstallation);
const mockedReprocessLinkedMessage = jest.mocked(reprocessLinkedMessage);

function makeRequest(pathWithQuery: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(`http://localhost:3000${pathWithQuery}`, init);
}

function makePayload() {
  return {
    contextKey: 'context-key',
    identity: { platform: PLATFORM.TEAMS, teamId: 'tenant-a', userId: '29:user-id' },
    thread: {
      _type: 'chat:Thread',
      adapterName: 'teams',
      channelId: 'teams-channel',
      id: 'teams-thread',
      isDM: false,
    },
    message: {
      _type: 'chat:Message',
      attachments: [],
      author: {
        fullName: 'Ada Lovelace',
        isBot: false,
        isMe: false,
        userId: '29:user-id',
        userName: 'Ada',
      },
      formatted: { type: 'root', children: [] },
      id: 'message-1',
      metadata: { dateSent: '2026-05-19T09:00:00.000Z', edited: false },
      raw: { conversation: { tenantId: 'tenant-a' } },
      text: '@Kilo fix this',
      threadId: 'teams-thread',
    },
  };
}

describe('/api/chat/install-integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedVerifyLinkToken.mockResolvedValue(makePayload() as never);
    mockedGetUserFromAuth.mockResolvedValue({
      user: {
        id: 'kilo-user-id',
        google_user_email: 'ada@example.com',
      },
      authFailedResponse: null,
    } as never);
    mockedGetPlatformIntegration.mockResolvedValue(null as never);
    mockedCanKiloUserAccessPlatformIntegration.mockResolvedValue(true);
    mockedGetProfileOrganizations.mockResolvedValue([
      { id: 'org-1', name: 'Acme Org', role: 'owner' },
      { id: 'org-2', name: 'Member Org', role: 'member' },
    ] as never);
    mockedConsumeLinkAccountContext.mockResolvedValue(true);
  });

  test('renders owner-selection form when no Teams integration exists', async () => {
    const { GET } = await import('./route');
    const response = await GET(makeRequest('/api/chat/install-integration?token=signed') as never);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('Connect Teams to Kilo');
    expect(body).toContain('My Kilo account');
    expect(body).toContain('Acme Org');
    expect(body).not.toContain('Member Org');
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });

  test('creates integration, links user, redirects to org integrations page, and reprocesses original message once', async () => {
    const { POST } = await import('./route');
    const response = await POST(
      makeRequest('/api/chat/install-integration', {
        method: 'POST',
        body: new URLSearchParams({ token: 'signed', owner: 'org:org-1' }),
      }) as never
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/organizations/org-1/integrations/teams?success=installed'
    );
    expect(mockedUpsertTeamsInstallation).toHaveBeenCalledWith({
      owner: { type: 'org', id: 'org-1' },
      tenantId: 'tenant-a',
      tenantName: 'Acme Teams',
    });
    expect(mockedLinkKiloUser).toHaveBeenCalledWith(
      expect.anything(),
      { platform: PLATFORM.TEAMS, teamId: 'tenant-a', userId: '29:user-id' },
      'kilo-user-id'
    );
    expect(mockedAfter).toHaveBeenCalledTimes(1);

    await mockedAfter.mock.calls[0][0]();
    expect(mockedReprocessLinkedMessage).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'install-integration-reprocess-message' })
    );
  });

  test('redirects with tenant_already_connected when upsert reports a conflict', async () => {
    const { TeamsTenantAlreadyConnectedError } = await import('@/lib/integrations/teams-service');
    mockedUpsertTeamsInstallation.mockRejectedValueOnce(
      new TeamsTenantAlreadyConnectedError('Other Teams')
    );

    const { POST } = await import('./route');
    const response = await POST(
      makeRequest('/api/chat/install-integration', {
        method: 'POST',
        body: new URLSearchParams({ token: 'signed', owner: 'org:org-1' }),
      }) as never
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/organizations/org-1/integrations/teams?error=tenant_already_connected'
    );
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });

  test('links and redirects to integrations page when an existing integration is accessible', async () => {
    mockedGetPlatformIntegration.mockResolvedValue({
      id: 'pi-teams',
      owned_by_organization_id: 'org-1',
      owned_by_user_id: null,
    } as never);
    mockedCanKiloUserAccessPlatformIntegration.mockResolvedValue(true);

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/api/chat/install-integration?token=signed') as never);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/organizations/org-1/integrations/teams?success=installed'
    );
    expect(mockedUpsertTeamsInstallation).not.toHaveBeenCalled();
    expect(mockedLinkKiloUser).toHaveBeenCalled();
  });

  test('redirects existing-tenant conflict to the owning surface', async () => {
    mockedGetPlatformIntegration.mockResolvedValue({
      id: 'pi-teams',
      owned_by_organization_id: 'other-org',
      owned_by_user_id: null,
    } as never);
    mockedCanKiloUserAccessPlatformIntegration.mockResolvedValue(false);

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/api/chat/install-integration?token=signed') as never);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/organizations/other-org/integrations/teams?error=tenant_already_connected'
    );
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });

  test('rejects unsupported platforms', async () => {
    mockedVerifyLinkToken.mockResolvedValue({
      ...makePayload(),
      identity: { platform: PLATFORM.SLACK, teamId: 'T123', userId: 'U123' },
    } as never);

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/api/chat/install-integration?token=signed') as never);

    expect(response.status).toBe(400);
    expect(mockedGetUserFromAuth).not.toHaveBeenCalled();
  });
});
