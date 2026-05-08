import type { NextRequest } from 'next/server';

const mockVerifyGitHubWebhookSignature = jest.fn(
  (_payload: string, _signature: string, _appType: string) => true
);
const mockFindIntegrationByInstallationId = jest.fn();
const mockLogWebhookEvent = jest.fn();
const mockUpdateWebhookEvent = jest.fn();
const mockHandlePullRequest = jest.fn();
const mockHandlePRReviewComment = jest.fn();

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  verifyGitHubWebhookSignature: (payload: string, signature: string, appType: string) =>
    mockVerifyGitHubWebhookSignature(payload, signature, appType),
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  findIntegrationByInstallationId: (platform: string, installationId: string | undefined) =>
    mockFindIntegrationByInstallationId(platform, installationId),
}));

jest.mock('@/lib/integrations/db/webhook-events', () => ({
  logWebhookEvent: (data: unknown) => mockLogWebhookEvent(data),
  updateWebhookEvent: (eventId: string, updates: unknown) =>
    mockUpdateWebhookEvent(eventId, updates),
}));

jest.mock('@/lib/integrations/platforms/github/webhook-handlers', () => ({
  handleInstallationCreated: jest.fn(),
  handleInstallationDeleted: jest.fn(),
  handleInstallationRepositories: jest.fn(),
  handleInstallationSuspend: jest.fn(),
  handleInstallationUnsuspend: jest.fn(),
  handleIssue: jest.fn(),
  handlePRReviewComment: (payload: unknown, platformIntegration: unknown) =>
    mockHandlePRReviewComment(payload, platformIntegration),
  handlePullRequest: (payload: unknown, platformIntegration: unknown) =>
    mockHandlePullRequest(payload, platformIntegration),
  handlePushEvent: jest.fn(),
  upsertCliSessionPullRequestsFromWebhook: jest.fn(),
  upsertCliSessionPullRequestReviewFromWebhook: jest.fn(),
}));

jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server');
  return {
    ...actual,
    after: (fn: () => unknown) => fn(),
  };
});

import { handleGitHubWebhook } from './webhook-handler';

const integration = {
  id: 'pi_github',
  owned_by_organization_id: 'org_1',
  owned_by_user_id: null,
  platform_installation_id: '98765',
  suspended_at: null,
};

function signedGitHubRequest(eventType: string, payload: unknown): NextRequest {
  return new Request('https://app.example.com/api/webhooks/github', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': `delivery-${eventType}`,
      'x-github-event': eventType,
      'x-hub-signature-256': 'sha256=test',
    },
    body: JSON.stringify(payload),
  }) as NextRequest;
}

function pullRequestPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'opened',
    installation: { id: 98765 },
    repository: {
      id: 123,
      name: 'widgets',
      full_name: 'acme/widgets',
      owner: { login: 'acme' },
    },
    pull_request: {
      number: 42,
      title: 'Add widgets',
      state: 'open',
      draft: false,
      html_url: 'https://github.com/acme/widgets/pull/42',
      user: { id: 111, login: 'alice', avatar_url: 'https://example.com/a.png' },
      head: { sha: 'abc123', ref: 'feature/widgets', repo: { full_name: 'acme/widgets' } },
      base: { sha: 'def456', ref: 'main' },
    },
    ...overrides,
  };
}

function reviewCommentPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'created',
    installation: { id: 98765 },
    repository: {
      id: 123,
      name: 'widgets',
      full_name: 'acme/widgets',
      owner: { login: 'acme' },
    },
    comment: {
      id: 456,
      body: '@Kilo fix this',
      user: { login: 'alice' },
      html_url: 'https://github.com/acme/widgets/pull/42#discussion_r456',
      path: 'src/widget.ts',
      line: 10,
      diff_hunk: '@@ -1 +1 @@',
      author_association: 'MEMBER',
    },
    pull_request: {
      number: 42,
      title: 'Add widgets',
      html_url: 'https://github.com/acme/widgets/pull/42',
      user: { login: 'bob' },
      head: { sha: 'abc123', ref: 'feature/widgets' },
      base: { ref: 'main' },
    },
    ...overrides,
  };
}

function issueCommentPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'created',
    installation: { id: 98765 },
    repository: {
      id: 123,
      name: 'widgets',
      full_name: 'acme/widgets',
      owner: { login: 'acme' },
    },
    issue: {
      number: 7,
      title: 'Broken widget',
      pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/7' },
    },
    comment: {
      id: 789,
      body: '@Kilo investigate this',
      user: { id: 111, login: 'alice', type: 'User' },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-789',
    },
    sender: { id: 111, login: 'alice', type: 'User' },
    ...overrides,
  };
}

describe('handleGitHubWebhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyGitHubWebhookSignature.mockReturnValue(true);
    mockFindIntegrationByInstallationId.mockResolvedValue(integration);
    mockLogWebhookEvent.mockResolvedValue({ id: 'we_1', isDuplicate: false });
    mockUpdateWebhookEvent.mockResolvedValue(undefined);
    mockHandlePullRequest.mockResolvedValue(Response.json({ message: 'review queued' }));
    mockHandlePRReviewComment.mockResolvedValue(undefined);
  });

  it('keeps pull_request webhooks on the code review path', async () => {
    const payload = pullRequestPayload();
    const response = await handleGitHubWebhook(
      signedGitHubRequest('pull_request', payload),
      'standard'
    );

    expect(response.status).toBe(200);
    expect(mockHandlePullRequest).toHaveBeenCalledWith(
      expect.objectContaining(payload),
      integration
    );
    expect(mockHandlePRReviewComment).not.toHaveBeenCalled();
    expect(mockUpdateWebhookEvent).toHaveBeenCalledWith(
      'we_1',
      expect.objectContaining({ handlers_triggered: ['code_review', 'cli_session_pr_upsert'] })
    );
  });

  it('keeps pull_request_review_comment created events on the legacy auto-fix path', async () => {
    const response = await handleGitHubWebhook(
      signedGitHubRequest('pull_request_review_comment', reviewCommentPayload()),
      'standard'
    );

    expect(response.status).toBe(200);
    expect(mockHandlePullRequest).not.toHaveBeenCalled();
    expect(mockHandlePRReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'created' }),
      integration
    );
    expect(mockUpdateWebhookEvent).toHaveBeenCalledWith(
      'we_1',
      expect.objectContaining({ handlers_triggered: ['pr_review_comment_fix'] })
    );
  });

  it('acknowledges issue_comment events without invoking legacy handlers', async () => {
    const response = await handleGitHubWebhook(
      signedGitHubRequest('issue_comment', issueCommentPayload()),
      'standard'
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'Event received' });
    expect(mockHandlePullRequest).not.toHaveBeenCalled();
    expect(mockHandlePRReviewComment).not.toHaveBeenCalled();
  });

  it('acknowledges non-created issue_comment events without invoking the bot', async () => {
    const response = await handleGitHubWebhook(
      signedGitHubRequest('issue_comment', issueCommentPayload({ action: 'edited' })),
      'standard'
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'Event received' });
    expect(mockHandlePullRequest).not.toHaveBeenCalled();
    expect(mockHandlePRReviewComment).not.toHaveBeenCalled();
  });
});
