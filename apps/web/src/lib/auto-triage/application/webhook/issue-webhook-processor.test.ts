const mockCaptureException = jest.fn();
const mockCaptureMessage = jest.fn();
const mockGetBotUserId = jest.fn();
const mockGetAgentConfigForOwner = jest.fn();
const mockCreateTriageTicket = jest.fn();
const mockFindExistingTicket = jest.fn();
const mockTryDispatchPendingTickets = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
}));

jest.mock('@/lib/bot-users/bot-user-service', () => ({
  getBotUserId: (...args: unknown[]) => mockGetBotUserId(...args),
}));

jest.mock('@/lib/agent-config/db/agent-configs', () => ({
  getAgentConfigForOwner: (...args: unknown[]) => mockGetAgentConfigForOwner(...args),
}));

jest.mock('@/lib/auto-triage/db/triage-tickets', () => ({
  createTriageTicket: (...args: unknown[]) => mockCreateTriageTicket(...args),
  findExistingTicket: (...args: unknown[]) => mockFindExistingTicket(...args),
}));

jest.mock('@/lib/auto-triage/dispatch/dispatch-pending-tickets', () => ({
  tryDispatchPendingTickets: (...args: unknown[]) => mockTryDispatchPendingTickets(...args),
}));

import { IssueWebhookProcessor } from './issue-webhook-processor';
import type { ConfigValidator } from './config-validator';
import type { IssuePayload } from './issue-webhook-processor';
import type { PlatformIntegration } from '@kilocode/db/schema';

function issuePayload(overrides: Partial<IssuePayload> = {}): IssuePayload {
  return {
    action: 'opened',
    issue: {
      number: 42,
      html_url: 'https://github.com/acme/widgets/issues/42',
      title: 'Something is broken',
      body: 'Steps to reproduce',
      user: { login: 'octocat', type: 'User' },
      labels: [],
    },
    repository: {
      id: 123,
      full_name: 'acme/widgets',
      private: false,
    },
    sender: { login: 'octocat', type: 'User' },
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

function alwaysValidValidator(): ConfigValidator {
  return { validate: () => ({ isValid: true }) } as unknown as ConfigValidator;
}

describe('IssueWebhookProcessor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetBotUserId.mockResolvedValue(null);
    mockGetAgentConfigForOwner.mockResolvedValue(null);
    mockCreateTriageTicket.mockResolvedValue('ticket-1');
    mockFindExistingTicket.mockResolvedValue(null);
    mockTryDispatchPendingTickets.mockResolvedValue({ dispatched: 1, notDispatched: 0 });
  });

  it('acknowledges without 5xx when an org integration has no bot user and no fallback requester', async () => {
    const processor = new IssueWebhookProcessor(alwaysValidValidator());

    const response = await processor.process(
      issuePayload(),
      platformIntegration({
        owned_by_organization_id: 'f2aa36d7-9c1b-4db9-ae4a-a4492618796d',
        kilo_requester_user_id: null,
      })
    );

    expect(response.status).toBe(200);
    expect(mockGetBotUserId).toHaveBeenCalledWith(
      'f2aa36d7-9c1b-4db9-ae4a-a4492618796d',
      'auto-triage'
    );
    expect(mockCreateTriageTicket).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('no resolvable owner'),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({ source: 'issue_webhook_missing_owner' }),
      })
    );
  });

  it('still fails loudly on a genuine unexpected error', async () => {
    mockGetBotUserId.mockResolvedValue('bot-user-1');
    mockGetAgentConfigForOwner.mockRejectedValue(new Error('database unavailable'));
    const processor = new IssueWebhookProcessor(alwaysValidValidator());

    const response = await processor.process(issuePayload(), platformIntegration());

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'Failed to trigger auto triage' });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('creates and dispatches a ticket when the org bot user resolves', async () => {
    mockGetBotUserId.mockResolvedValue('bot-user-1');
    mockGetAgentConfigForOwner.mockResolvedValue({
      is_enabled: true,
      config: { enabled_for_issues: true, repository_selection_mode: 'all' },
    });
    const processor = new IssueWebhookProcessor(alwaysValidValidator());

    const response = await processor.process(issuePayload(), platformIntegration());

    expect(response.status).toBe(202);
    expect(mockCreateTriageTicket).toHaveBeenCalledTimes(1);
    expect(mockTryDispatchPendingTickets).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'org', userId: 'bot-user-1' })
    );
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});
