import { createCallerFactory } from '@/lib/trpc/init';

const mockGetGitHubIntegrationById = jest.fn();
const mockGetAllIntegrationsForOwner = jest.fn();
const mockGenerateGitHubInstallationToken = jest.fn();
const mockCreateTriageTicket = jest.fn();
const mockTryDispatchPendingTickets = jest.fn();

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getGitHubIntegrationById: (...args: unknown[]) => mockGetGitHubIntegrationById(...args),
  getAllIntegrationsForOwner: (...args: unknown[]) => mockGetAllIntegrationsForOwner(...args),
}));
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: (...args: unknown[]) =>
    mockGenerateGitHubInstallationToken(...args),
}));
jest.mock('@/lib/auto-triage/db/triage-tickets', () => ({
  listTriageTickets: jest.fn(),
  countTriageTickets: jest.fn(),
  getTriageTicketById: jest.fn(),
  resetTriageTicketForRetry: jest.fn(),
  createTriageTicket: (...args: unknown[]) => mockCreateTriageTicket(...args),
}));
jest.mock('@/lib/auto-triage/dispatch/dispatch-pending-tickets', () => ({
  tryDispatchPendingTickets: (...args: unknown[]) => mockTryDispatchPendingTickets(...args),
}));
jest.mock('@/lib/agent-config/db/agent-configs', () => ({
  getAgentConfig: jest.fn(),
  upsertAgentConfig: jest.fn(),
}));
jest.mock('@/lib/bot-users/bot-user-service', () => ({ getBotUserId: jest.fn() }));
jest.mock('@/lib/organizations/trial-middleware', () => ({
  requireActiveSubscriptionOrTrial: jest.fn(),
}));

import { autoTriageRouter } from './auto-triage-router';

const createCaller = createCallerFactory(autoTriageRouter);
const owner = { type: 'user' as const };
const integrationId = '00000000-0000-4000-8000-000000000001';

function caller() {
  return createCaller({ user: { id: 'admin-1', is_admin: true } } as never);
}

function integration(overrides: Record<string, unknown> = {}) {
  return {
    id: integrationId,
    platform: 'github',
    platform_installation_id: '123',
    github_app_type: 'lite',
    integration_status: 'active',
    suspended_at: null,
    auth_invalid_at: null,
    repositories: [{ id: 7, name: 'widgets', full_name: 'acme/widgets', private: true }],
    ...overrides,
  };
}

describe('adminSubmitForTriage integration selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateGitHubInstallationToken.mockResolvedValue({ token: 'github-token' });
    mockCreateTriageTicket.mockResolvedValue('ticket-1');
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        title: 'Broken widget',
        body: 'Details',
        user: { login: 'alice' },
        labels: [{ name: 'bug' }],
      })
    );
  });

  it('uses and persists the healthy owner integration supplied by repository selection', async () => {
    mockGetGitHubIntegrationById.mockResolvedValue(integration());

    await expect(
      caller().adminSubmitForTriage({
        issueUrl: 'https://github.com/acme/widgets/issues/7',
        platformIntegrationId: integrationId,
        owner,
      })
    ).resolves.toMatchObject({ success: true, ticketId: 'ticket-1' });

    expect(mockGetGitHubIntegrationById).toHaveBeenCalledWith(
      { type: 'user', id: 'admin-1' },
      integrationId
    );
    expect(mockGenerateGitHubInstallationToken).toHaveBeenCalledWith('123', 'lite');
    expect(mockCreateTriageTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        platformIntegrationId: integrationId,
        repoFullName: 'acme/widgets',
      })
    );
  });

  it('lets the live issue fetch prove access instead of cached repository membership', async () => {
    mockGetGitHubIntegrationById.mockResolvedValue(
      integration({
        repositories: [{ id: 8, name: 'other', full_name: 'acme/other', private: true }],
      })
    );

    await expect(
      caller().adminSubmitForTriage({
        issueUrl: 'https://github.com/acme/widgets/issues/7',
        platformIntegrationId: integrationId,
        owner,
      })
    ).resolves.toMatchObject({ success: true, ticketId: 'ticket-1' });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/widgets/issues/7',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer github-token' }),
      })
    );
    expect(mockCreateTriageTicket).toHaveBeenCalledWith(
      expect.objectContaining({ platformIntegrationId: integrationId })
    );
  });

  it('fails closed for legacy input when multiple healthy integrations exist', async () => {
    mockGetAllIntegrationsForOwner.mockResolvedValue([
      integration(),
      integration({ id: '00000000-0000-4000-8000-000000000002' }),
    ]);

    await expect(
      caller().adminSubmitForTriage({
        issueUrl: 'https://github.com/acme/widgets/issues/7',
        owner,
      })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Select a repository from one exact GitHub App installation before submitting.',
    });
    expect(mockGenerateGitHubInstallationToken).not.toHaveBeenCalled();
  });
});
