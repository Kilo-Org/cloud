const mockGetBotUserId = jest.fn();
const mockGetAgentConfigForOwner = jest.fn();
const mockCreateTriageTicket = jest.fn();
const mockFindExistingTicket = jest.fn();
const mockTryDispatchPendingTickets = jest.fn();

jest.mock('@/lib/bot-users/bot-user-service', () => ({
  getBotUserId: (organizationId: string, botType: string) =>
    mockGetBotUserId(organizationId, botType),
}));

jest.mock('@/lib/agent-config/db/agent-configs', () => ({
  getAgentConfigForOwner: (owner: unknown, agentType: string, platform: string) =>
    mockGetAgentConfigForOwner(owner, agentType, platform),
}));

jest.mock('@/lib/auto-triage/db/triage-tickets', () => ({
  createTriageTicket: (...args: unknown[]) => mockCreateTriageTicket(...args),
  findExistingTicket: (...args: unknown[]) => mockFindExistingTicket(...args),
}));

jest.mock('@/lib/auto-triage/dispatch/dispatch-pending-tickets', () => ({
  tryDispatchPendingTickets: (...args: unknown[]) => mockTryDispatchPendingTickets(...args),
}));

import { IssueWebhookProcessor } from '@/lib/auto-triage/application/webhook/issue-webhook-processor';
import { ConfigValidator } from '@/lib/auto-triage/application/webhook/config-validator';
import type { IssuePayload } from '@/lib/auto-triage/application/webhook/issue-webhook-processor';
import type { PlatformIntegration } from '@kilocode/db/schema';

function issuePayload(overrides: Partial<IssuePayload> = {}): IssuePayload {
  return {
    action: 'opened',
    issue: {
      number: 42,
      html_url: 'https://github.com/acme/widgets/issues/42',
      title: 'Something is broken',
      body: 'Steps to reproduce',
      user: { login: 'alice', type: 'User' },
      labels: [],
    },
    repository: {
      id: 123,
      full_name: 'acme/widgets',
      private: false,
    },
    sender: { login: 'alice', type: 'User' },
    ...overrides,
  };
}

function platformIntegration(overrides: Partial<PlatformIntegration> = {}): PlatformIntegration {
  return {
    id: '8b2ff443-8396-4b07-99ae-7015789da7dd',
    owned_by_organization_id: 'f2aa36d7-9c1b-4db9-ae4a-a4492618796d',
    owned_by_user_id: null,
    kilo_requester_user_id: null,
    platform_installation_id: '98765',
    github_app_type: 'standard',
    ...overrides,
  } as PlatformIntegration;
}

function processor() {
  return new IssueWebhookProcessor(new ConfigValidator());
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetBotUserId.mockResolvedValue(null);
  mockGetAgentConfigForOwner.mockResolvedValue(null);
  mockCreateTriageTicket.mockResolvedValue('ticket-1');
  mockFindExistingTicket.mockResolvedValue(null);
  mockTryDispatchPendingTickets.mockResolvedValue(undefined);
});

describe('IssueWebhookProcessor owner resolution', () => {
  it('acknowledges org integrations with no bot user and no fallback requester ID', async () => {
    const response = await processor().process(issuePayload(), platformIntegration());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: 'Auto triage skipped: integration user context not configured',
    });
    expect(mockGetBotUserId).toHaveBeenCalledWith(
      'f2aa36d7-9c1b-4db9-ae4a-a4492618796d',
      'auto-triage'
    );
    expect(mockGetAgentConfigForOwner).not.toHaveBeenCalled();
    expect(mockCreateTriageTicket).not.toHaveBeenCalled();
    expect(mockTryDispatchPendingTickets).not.toHaveBeenCalled();
  });

  it('processes org integrations using the auto-triage bot user when configured', async () => {
    mockGetBotUserId.mockResolvedValue('bot-user-1');
    mockGetAgentConfigForOwner.mockResolvedValue({
      is_enabled: true,
      config: { enabled_for_issues: true, repository_selection_mode: 'all' },
    });

    const response = await processor().process(issuePayload(), platformIntegration());

    expect(response.status).toBe(202);
    expect(mockGetAgentConfigForOwner).toHaveBeenCalledWith(
      {
        type: 'org',
        id: 'f2aa36d7-9c1b-4db9-ae4a-a4492618796d',
        userId: 'bot-user-1',
      },
      'auto_triage',
      'github'
    );
    expect(mockCreateTriageTicket).toHaveBeenCalled();
  });

  it('processes org integrations using the fallback requester ID when no bot user exists', async () => {
    mockGetBotUserId.mockResolvedValue(null);
    mockGetAgentConfigForOwner.mockResolvedValue({
      is_enabled: true,
      config: { enabled_for_issues: true, repository_selection_mode: 'all' },
    });

    const response = await processor().process(
      issuePayload(),
      platformIntegration({ kilo_requester_user_id: 'requester-1' })
    );

    expect(response.status).toBe(202);
    expect(mockGetAgentConfigForOwner).toHaveBeenCalledWith(
      {
        type: 'org',
        id: 'f2aa36d7-9c1b-4db9-ae4a-a4492618796d',
        userId: 'requester-1',
      },
      'auto_triage',
      'github'
    );
    expect(mockCreateTriageTicket).toHaveBeenCalled();
  });

  it('processes user-owned integrations', async () => {
    mockGetAgentConfigForOwner.mockResolvedValue({
      is_enabled: true,
      config: { enabled_for_issues: true, repository_selection_mode: 'all' },
    });

    const response = await processor().process(
      issuePayload(),
      platformIntegration({
        owned_by_organization_id: null,
        owned_by_user_id: 'user-1',
      })
    );

    expect(response.status).toBe(202);
    expect(mockGetBotUserId).not.toHaveBeenCalled();
    expect(mockCreateTriageTicket).toHaveBeenCalled();
  });

  it('skips bot-authored events without resolving an owner', async () => {
    const response = await processor().process(
      issuePayload({ sender: { login: 'dependabot[bot]', type: 'Bot' } }),
      platformIntegration()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'Skipped bot event' });
    expect(mockGetBotUserId).not.toHaveBeenCalled();
  });
});
