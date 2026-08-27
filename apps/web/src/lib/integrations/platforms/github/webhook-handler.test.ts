import type { NextRequest } from 'next/server';

const mockVerifyGitHubWebhookSignature = jest.fn(
  (_payload: string, _signature: string, _appType: string) => true
);
const mockFindIntegrationByInstallationId = jest.fn();
const mockGetIntegrationForOrganization = jest.fn();
const mockLogWebhookEvent = jest.fn();
const mockUpdateWebhookEvent = jest.fn();
const mockHandlePullRequest = jest.fn();
const mockHandleIssue = jest.fn();
const mockHandlePRReviewComment = jest.fn();
const mockHandleGitHubReviewCommentReply = jest.fn();
const mockHandleInstallationTargetRenamed = jest.fn();
const mockRevokeStoredGitHubUserAuthorization = jest.fn();
const mockHandleInstallationDeleted = jest.fn();
const mockHandleInstallationSuspend = jest.fn();
const mockHandleInstallationUnsuspend = jest.fn();
const mockHandleInstallationRepositories = jest.fn();

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  verifyGitHubWebhookSignature: (payload: string, signature: string, appType: string) =>
    mockVerifyGitHubWebhookSignature(payload, signature, appType),
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  findIntegrationByInstallationId: (
    platform: string,
    installationId: string | undefined,
    githubAppType?: string
  ) => mockFindIntegrationByInstallationId(platform, installationId, githubAppType),
  getIntegrationForOrganization: (organizationId: string, platform: string) =>
    mockGetIntegrationForOrganization(organizationId, platform),
}));

jest.mock('@/lib/integrations/db/webhook-events', () => ({
  logWebhookEvent: (data: unknown) => mockLogWebhookEvent(data),
  updateWebhookEvent: (eventId: string, updates: unknown) =>
    mockUpdateWebhookEvent(eventId, updates),
}));

jest.mock('@/lib/integrations/platforms/github/user-authorization', () => ({
  revokeStoredGitHubUserAuthorization: (githubUserId: string, appType: string, reason: string) =>
    mockRevokeStoredGitHubUserAuthorization(githubUserId, appType, reason),
}));

jest.mock('@/lib/integrations/platforms/github/webhook-handlers', () => ({
  handleInstallationCreated: jest.fn(),
  handleInstallationDeleted: (payload: unknown, appType: string) =>
    mockHandleInstallationDeleted(payload, appType),
  handleInstallationRepositories: (payload: unknown, appType: string) =>
    mockHandleInstallationRepositories(payload, appType),
  handleInstallationSuspend: (payload: unknown, appType: string) =>
    mockHandleInstallationSuspend(payload, appType),
  handleInstallationUnsuspend: (payload: unknown, appType: string) =>
    mockHandleInstallationUnsuspend(payload, appType),
  handleInstallationTargetRenamed: (payload: unknown, integrationId: string, appType: string) =>
    mockHandleInstallationTargetRenamed(payload, integrationId, appType),
  handleIssue: (payload: unknown, platformIntegration: unknown) =>
    mockHandleIssue(payload, platformIntegration),
  handlePRReviewComment: (payload: unknown, platformIntegration: unknown) =>
    mockHandlePRReviewComment(payload, platformIntegration),
  handlePullRequest: (payload: unknown, platformIntegration: unknown) =>
    mockHandlePullRequest(payload, platformIntegration),
  handlePushEvent: jest.fn(),
  upsertCliSessionPullRequestsFromWebhook: jest.fn(),
  upsertCliSessionPullRequestReviewFromWebhook: jest.fn(),
}));

jest.mock('@/lib/code-reviews/review-memory/github-feedback', () => ({
  handleGitHubReviewCommentReply: (input: unknown) => mockHandleGitHubReviewCommentReply(input),
}));

jest.mock('@/lib/utils.server', () => ({
  logExceptInTest: jest.fn(),
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
  github_app_type: 'standard',
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
      user: { id: 111, login: 'alice', avatar_url: 'https://example.com/a.png', type: 'User' },
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

function issuePayload(action: string) {
  return {
    action,
    installation: { id: 98765 },
    repository: {
      id: 123,
      name: 'widgets',
      full_name: 'acme/widgets',
      private: true,
      owner: { login: 'acme' },
    },
    issue: {
      number: 7,
      html_url: 'https://github.com/acme/widgets/issues/7',
      title: 'Broken widget',
      body: 'Please fix it',
      user: { login: 'alice' },
      labels: [{ name: 'kilo-auto-fix' }],
    },
    label: { name: 'kilo-auto-fix' },
    sender: { login: 'alice' },
  };
}

async function waitForAfterTask() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('handleGitHubWebhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetIntegrationForOrganization.mockResolvedValue(integration);
    mockVerifyGitHubWebhookSignature.mockReturnValue(true);
    mockFindIntegrationByInstallationId.mockResolvedValue(integration);
    mockLogWebhookEvent.mockResolvedValue({ id: 'we_1', isDuplicate: false });
    mockUpdateWebhookEvent.mockResolvedValue(undefined);
    mockHandlePullRequest.mockResolvedValue(Response.json({ message: 'review queued' }));
    mockHandleIssue.mockResolvedValue(Response.json({ message: 'fix queued' }));
    mockHandlePRReviewComment.mockResolvedValue(undefined);
    mockHandleGitHubReviewCommentReply.mockResolvedValue({
      recorded: false,
      reason: 'not-review-comment-reply',
    });
    mockHandleInstallationTargetRenamed.mockResolvedValue(
      Response.json({ message: 'Installation target updated' })
    );
    mockRevokeStoredGitHubUserAuthorization.mockResolvedValue({ kiloUserId: 'user_1' });
    mockHandleInstallationDeleted.mockResolvedValue(
      Response.json({ message: 'Installation removed' })
    );
    mockHandleInstallationSuspend.mockResolvedValue(
      Response.json({ message: 'Installation suspended' })
    );
    mockHandleInstallationUnsuspend.mockResolvedValue(
      Response.json({ message: 'Installation unsuspended' })
    );
    mockHandleInstallationRepositories.mockResolvedValue(
      Response.json({ message: 'Repositories updated' })
    );
  });

  it('routes installation_target renamed events through authoritative login synchronization', async () => {
    const payload = {
      action: 'renamed',
      installation: { id: 98765 },
      account: { id: 123, login: 'renamed-owner' },
      changes: { login: { from: 'old-owner' } },
      target_type: 'User',
    };

    const response = await handleGitHubWebhook(
      signedGitHubRequest('installation_target', payload),
      'lite'
    );

    expect(response.status).toBe(200);
    expect(mockHandleInstallationTargetRenamed).toHaveBeenCalledWith(
      expect.objectContaining(payload),
      integration.id,
      'lite'
    );
    expect(mockUpdateWebhookEvent).toHaveBeenCalledWith(
      'we_1',
      expect.objectContaining({ handlers_triggered: ['installation_target_renamed'] })
    );
  });

  it('retries installation_target synchronization after a transient handler failure', async () => {
    const payload = {
      action: 'renamed',
      installation: { id: 98765 },
      account: { id: 123, login: 'renamed-owner' },
      changes: { login: { from: 'old-owner' } },
      target_type: 'User',
    };
    mockHandleInstallationTargetRenamed
      .mockRejectedValueOnce(new Error('temporary GitHub failure'))
      .mockResolvedValueOnce(Response.json({ message: 'Installation target updated' }));

    const firstResponse = await handleGitHubWebhook(
      signedGitHubRequest('installation_target', payload),
      'standard'
    );
    const retriedResponse = await handleGitHubWebhook(
      signedGitHubRequest('installation_target', payload),
      'standard'
    );

    expect(firstResponse.status).toBe(500);
    expect(retriedResponse.status).toBe(200);
    expect(mockHandleInstallationTargetRenamed).toHaveBeenCalledTimes(2);
    expect(mockLogWebhookEvent).toHaveBeenCalledTimes(1);
  });

  it('safely revalidates identity before acknowledging duplicate rename deliveries', async () => {
    mockLogWebhookEvent.mockResolvedValue({ isDuplicate: true });

    const response = await handleGitHubWebhook(
      signedGitHubRequest('installation_target', {
        action: 'renamed',
        installation: { id: 98765 },
        account: { id: 123, login: 'renamed-owner' },
        changes: { login: { from: 'old-owner' } },
        target_type: 'User',
      }),
      'standard'
    );

    expect(await response.json()).toEqual({ message: 'Duplicate event' });
    expect(mockHandleInstallationTargetRenamed).toHaveBeenCalledTimes(1);
  });

  it('revokes user authorization without requiring an installation payload', async () => {
    const response = await handleGitHubWebhook(
      signedGitHubRequest('github_app_authorization', {
        action: 'revoked',
        sender: { id: 123, login: 'octocat' },
      }),
      'standard'
    );

    expect(response.status).toBe(200);
    expect(mockRevokeStoredGitHubUserAuthorization).toHaveBeenCalledWith(
      '123',
      'standard',
      'revoked'
    );
    expect(mockFindIntegrationByInstallationId).not.toHaveBeenCalled();
  });

  it('scopes the integration lookup to the webhook app type', async () => {
    const response = await handleGitHubWebhook(
      signedGitHubRequest('pull_request', pullRequestPayload()),
      'lite'
    );

    expect(response.status).toBe(200);
    expect(mockFindIntegrationByInstallationId).toHaveBeenCalledWith('github', '98765', 'lite');
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
    await waitForAfterTask();
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

  it('records reply feedback through the exact secondary installation', async () => {
    const secondaryIntegration = {
      ...integration,
      id: 'secondary',
      github_app_type: 'standard',
    };
    const payload = reviewCommentPayload({
      comment: {
        ...reviewCommentPayload().comment,
        in_reply_to_id: 455,
      },
    });
    mockFindIntegrationByInstallationId.mockResolvedValue(secondaryIntegration);
    mockGetIntegrationForOrganization.mockResolvedValue({ ...integration, id: 'primary' });
    mockHandleGitHubReviewCommentReply.mockResolvedValue({ recorded: true, eventId: 'evt_1' });

    const response = await handleGitHubWebhook(
      signedGitHubRequest('pull_request_review_comment', payload),
      'standard'
    );

    expect(response.status).toBe(200);
    await waitForAfterTask();
    expect(mockHandleGitHubReviewCommentReply).toHaveBeenCalledTimes(1);
    expect(mockHandleGitHubReviewCommentReply).toHaveBeenCalledWith({
      payload: expect.objectContaining(payload),
      integration: secondaryIntegration,
      deliveryId: 'delivery-pull_request_review_comment',
    });
    expect(mockUpdateWebhookEvent).toHaveBeenCalledWith(
      'we_1',
      expect.objectContaining({
        handlers_triggered: ['pr_review_comment_fix', 'review_memory_feedback'],
      })
    );
  });

  it('runs Auto Fix without recording feedback for a secondary non-reply comment', async () => {
    const secondaryIntegration = { ...integration, id: 'secondary' };
    const payload = reviewCommentPayload();
    mockFindIntegrationByInstallationId.mockResolvedValue(secondaryIntegration);
    mockGetIntegrationForOrganization.mockResolvedValue({ ...integration, id: 'primary' });

    const response = await handleGitHubWebhook(
      signedGitHubRequest('pull_request_review_comment', payload),
      'standard'
    );

    expect(response.status).toBe(200);
    await waitForAfterTask();
    expect(mockHandleGitHubReviewCommentReply).toHaveBeenCalledWith({
      payload: expect.objectContaining(payload),
      integration: secondaryIntegration,
      deliveryId: 'delivery-pull_request_review_comment',
    });
    expect(mockUpdateWebhookEvent).toHaveBeenCalledWith(
      'we_1',
      expect.objectContaining({ handlers_triggered: ['pr_review_comment_fix'] })
    );
  });

  it('keeps Auto Fix and Review Memory side effects together for a secondary reply', async () => {
    const secondaryIntegration = { ...integration, id: 'secondary' };
    const payload = reviewCommentPayload({
      comment: {
        ...reviewCommentPayload().comment,
        in_reply_to_id: 455,
      },
    });
    mockFindIntegrationByInstallationId.mockResolvedValue(secondaryIntegration);
    mockGetIntegrationForOrganization.mockResolvedValue({ ...integration, id: 'primary' });
    mockHandleGitHubReviewCommentReply.mockResolvedValue({ recorded: true, eventId: 'evt_1' });

    const response = await handleGitHubWebhook(
      signedGitHubRequest('pull_request_review_comment', payload),
      'standard'
    );

    expect(response.status).toBe(200);
    await waitForAfterTask();
    expect(mockHandlePRReviewComment).toHaveBeenCalledTimes(1);
    expect(mockHandlePRReviewComment).toHaveBeenCalledWith(
      expect.objectContaining(payload),
      secondaryIntegration
    );
    expect(mockHandleGitHubReviewCommentReply).toHaveBeenCalledTimes(1);
    expect(mockUpdateWebhookEvent).toHaveBeenCalledWith(
      'we_1',
      expect.objectContaining({
        handlers_triggered: ['pr_review_comment_fix', 'review_memory_feedback'],
      })
    );
  });

  it('uses the exact lite integration that delivered secondary reply feedback', async () => {
    const secondaryIntegration = {
      ...integration,
      id: 'secondary',
      github_app_type: 'lite',
    };
    const payload = reviewCommentPayload({
      comment: {
        ...reviewCommentPayload().comment,
        in_reply_to_id: 455,
      },
    });
    mockFindIntegrationByInstallationId.mockResolvedValue(secondaryIntegration);
    mockGetIntegrationForOrganization.mockResolvedValue({ ...integration, id: 'primary' });
    mockHandleGitHubReviewCommentReply.mockResolvedValue({ recorded: true, eventId: 'evt_1' });

    const response = await handleGitHubWebhook(
      signedGitHubRequest('pull_request_review_comment', payload),
      'lite'
    );

    expect(response.status).toBe(200);
    await waitForAfterTask();
    expect(mockFindIntegrationByInstallationId).toHaveBeenCalledWith('github', '98765', 'lite');
    expect(mockHandlePRReviewComment.mock.calls[0]?.[1]).toBe(secondaryIntegration);
    expect(mockHandleGitHubReviewCommentReply.mock.calls[0]?.[0].integration).toBe(
      secondaryIntegration
    );
    expect(mockHandleGitHubReviewCommentReply.mock.calls[0]?.[0].integration.github_app_type).toBe(
      'lite'
    );
  });

  it('admits only Auto Fix event actions from a secondary installation', async () => {
    mockGetIntegrationForOrganization.mockResolvedValue({ ...integration, id: 'primary' });

    const reviewResponse = await handleGitHubWebhook(
      signedGitHubRequest('pull_request_review_comment', reviewCommentPayload()),
      'standard'
    );
    const editedReviewResponse = await handleGitHubWebhook(
      signedGitHubRequest(
        'pull_request_review_comment',
        reviewCommentPayload({ action: 'edited' })
      ),
      'standard'
    );
    const labeledResponse = await handleGitHubWebhook(
      signedGitHubRequest('issues', issuePayload('labeled')),
      'standard'
    );
    const openedResponse = await handleGitHubWebhook(
      signedGitHubRequest('issues', issuePayload('opened')),
      'standard'
    );
    const otherLabelResponse = await handleGitHubWebhook(
      signedGitHubRequest('issues', {
        ...issuePayload('labeled'),
        label: { name: 'needs-triage' },
      }),
      'standard'
    );

    expect(reviewResponse.status).toBe(200);
    expect(editedReviewResponse.status).toBe(200);
    expect(labeledResponse.status).toBe(200);
    expect(openedResponse.status).toBe(200);
    expect(otherLabelResponse.status).toBe(200);
    await waitForAfterTask();
    expect(mockHandlePRReviewComment).toHaveBeenCalledTimes(1);
    expect(mockHandleIssue).toHaveBeenCalledTimes(1);
    expect(mockHandleIssue).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'labeled' }),
      integration
    );
  });

  it('logs review memory feedback only when it records feedback', async () => {
    mockHandleGitHubReviewCommentReply.mockResolvedValueOnce({ recorded: true, eventId: 'evt_1' });

    const response = await handleGitHubWebhook(
      signedGitHubRequest('pull_request_review_comment', reviewCommentPayload()),
      'standard'
    );

    expect(response.status).toBe(200);
    await waitForAfterTask();
    expect(mockUpdateWebhookEvent).toHaveBeenCalledWith(
      'we_1',
      expect.objectContaining({
        handlers_triggered: ['pr_review_comment_fix', 'review_memory_feedback'],
      })
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

  it('routes installation.deleted to the handler with the webhook app type', async () => {
    const payload = { action: 'deleted', installation: { id: 98765 } };

    const response = await handleGitHubWebhook(
      signedGitHubRequest('installation', payload),
      'lite'
    );

    expect(response.status).toBe(200);
    expect(mockFindIntegrationByInstallationId).toHaveBeenCalledWith('github', '98765', 'lite');
    expect(mockHandleInstallationDeleted).toHaveBeenCalledWith(
      expect.objectContaining(payload),
      'lite'
    );
  });

  it('routes installation.suspend to the handler with the webhook app type', async () => {
    const payload = { action: 'suspend', installation: { id: 98765 } };

    const response = await handleGitHubWebhook(
      signedGitHubRequest('installation', payload),
      'standard'
    );

    expect(response.status).toBe(200);
    expect(mockFindIntegrationByInstallationId).toHaveBeenCalledWith('github', '98765', 'standard');
    expect(mockHandleInstallationSuspend).toHaveBeenCalledWith(
      expect.objectContaining(payload),
      'standard'
    );
  });

  it('routes installation.unsuspend to the handler with the webhook app type', async () => {
    const payload = { action: 'unsuspend', installation: { id: 98765 } };

    const response = await handleGitHubWebhook(
      signedGitHubRequest('installation', payload),
      'lite'
    );

    expect(response.status).toBe(200);
    expect(mockFindIntegrationByInstallationId).toHaveBeenCalledWith('github', '98765', 'lite');
    expect(mockHandleInstallationUnsuspend).toHaveBeenCalledWith(
      expect.objectContaining(payload),
      'lite'
    );
  });

  it('routes installation_repositories to the handler with the webhook app type', async () => {
    const payload = {
      action: 'added',
      installation: { id: 98765 },
      repositories_added: [{ id: 1, name: 'widgets', full_name: 'acme/widgets', private: false }],
    };

    const response = await handleGitHubWebhook(
      signedGitHubRequest('installation_repositories', payload),
      'standard'
    );

    expect(response.status).toBe(200);
    expect(mockFindIntegrationByInstallationId).toHaveBeenCalledWith('github', '98765', 'standard');
    expect(mockHandleInstallationRepositories).toHaveBeenCalledWith(
      expect.objectContaining(payload),
      'standard'
    );
  });
});
