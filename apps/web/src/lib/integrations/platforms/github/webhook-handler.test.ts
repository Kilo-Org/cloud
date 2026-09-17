import type { NextRequest } from 'next/server';
import { captureException, captureMessage } from '@sentry/nextjs';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockVerifyGitHubWebhookSignature = jest.fn(
  (_payload: string, _signature: string, _appType: string) => true
);
const mockFindIntegrationByInstallationId = jest.fn();
const mockFindConnectedIntegrationByInstallationId = jest.fn();
const mockGetIntegrationForOrganization = jest.fn();
const mockLogWebhookEvent = jest.fn();
const mockUpdateWebhookEvent = jest.fn();
const mockHandlePullRequest = jest.fn();
const mockHandlePRReviewComment = jest.fn();
const mockHandleGitHubReviewCommentReply = jest.fn();
const mockHandleInstallationTargetRenamed = jest.fn();
const mockRevokeStoredGitHubUserAuthorization = jest.fn();
const mockHandleInstallationDeleted = jest.fn();
const mockHandleInstallationSuspend = jest.fn();
const mockHandleInstallationUnsuspend = jest.fn();
const mockHandleInstallationRepositories = jest.fn();
const mockAssertGitHubInstallationRuntimeAuthorized = jest.fn();
const mockIsSharedGitHubInstallation = jest.fn();
const mockClaimSharedGitHubInstallationDelivery = jest.fn();
const mockCompleteSharedGitHubInstallationDelivery = jest.fn();
const mockReleaseSharedGitHubInstallationDelivery = jest.fn();
const mockMaterializeGitHubInstallationIdentity = jest.fn();

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
  findConnectedIntegrationByInstallationId: (
    platform: string,
    installationId: string | undefined,
    githubAppType?: string
  ) => mockFindConnectedIntegrationByInstallationId(platform, installationId, githubAppType),
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

jest.mock('@/lib/integrations/github/runtime-authorization', () => ({
  GitHubRuntimeAuthorizationError: class GitHubRuntimeAuthorizationError extends Error {
    constructor(message: string) {
      super(message);
    }
  },
  assertGitHubInstallationRuntimeAuthorized: (
    installationId: string,
    appType: string,
    expectedIntegrationId?: string
  ) =>
    mockAssertGitHubInstallationRuntimeAuthorized(installationId, appType, expectedIntegrationId),
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
  handleInstallationTargetRenamed: (payload: unknown, appType: string) =>
    mockHandleInstallationTargetRenamed(payload, appType),
  handleIssue: jest.fn(),
  handlePRReviewComment: (payload: unknown, platformIntegration: unknown) =>
    mockHandlePRReviewComment(payload, platformIntegration),
  handlePullRequest: (payload: unknown, platformIntegration: unknown) =>
    mockHandlePullRequest(payload, platformIntegration),
  handlePushEvent: jest.fn(),
  upsertCliSessionPullRequestsFromWebhook: jest.fn(),
  upsertCliSessionPullRequestReviewFromWebhook: jest.fn(),
}));

jest.mock('@/lib/integrations/db/github-installations', () => ({
  isSharedGitHubInstallation: (installationId: string, appType: string) =>
    mockIsSharedGitHubInstallation(installationId, appType),
  claimGitHubInstallationDelivery: (input: unknown) =>
    mockClaimSharedGitHubInstallationDelivery(input),
  completeGitHubInstallationDelivery: (input: unknown) =>
    mockCompleteSharedGitHubInstallationDelivery(input),
  releaseGitHubInstallationDelivery: (input: unknown) =>
    mockReleaseSharedGitHubInstallationDelivery(input),
  materializeGitHubInstallationIdentity: (input: unknown) =>
    mockMaterializeGitHubInstallationIdentity(input),
}));

jest.mock('@/lib/code-reviews/review-memory/github-feedback', () => ({
  handleGitHubReviewCommentReply: (input: unknown) => mockHandleGitHubReviewCommentReply(input),
}));

jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server');
  return {
    ...actual,
    after: (fn: () => unknown) => fn(),
  };
});

import { handleGitHubWebhook } from './webhook-handler';
import { GitHubRuntimeAuthorizationError } from '@/lib/integrations/github/runtime-authorization';

const integration = {
  id: 'pi_github',
  owned_by_organization_id: 'org_1',
  owned_by_user_id: null,
  platform_installation_id: '98765',
  github_app_type: 'standard',
  integration_status: 'active',
  suspended_at: null,
  auth_invalid_at: null,
  github_disconnected_at: null,
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

async function waitForAfterTask() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('handleGitHubWebhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetIntegrationForOrganization.mockResolvedValue(integration);
    mockVerifyGitHubWebhookSignature.mockReturnValue(true);
    mockFindIntegrationByInstallationId.mockResolvedValue(integration);
    mockFindConnectedIntegrationByInstallationId.mockResolvedValue(integration);
    mockIsSharedGitHubInstallation.mockResolvedValue(false);
    mockClaimSharedGitHubInstallationDelivery.mockResolvedValue({
      status: 'claimed',
      githubInstallationId: 'canonical-installation',
    });
    mockLogWebhookEvent.mockResolvedValue({ id: 'we_1', isDuplicate: false });
    mockUpdateWebhookEvent.mockResolvedValue(undefined);
    mockHandlePullRequest.mockResolvedValue(Response.json({ message: 'review queued' }));
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

  it('contains non-lifecycle events before tenant routing for a shared installation', async () => {
    mockIsSharedGitHubInstallation.mockResolvedValue(true);

    const response = await handleGitHubWebhook(
      signedGitHubRequest('pull_request', pullRequestPayload()),
      'standard'
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: 'Event unavailable for shared installations',
    });
    expect(mockFindIntegrationByInstallationId).not.toHaveBeenCalled();
    expect(mockLogWebhookEvent).not.toHaveBeenCalled();
    expect(mockHandlePullRequest).not.toHaveBeenCalled();
  });

  it('must not route an active sibling installation webhook to a disconnected tenant', async () => {
    const disconnected = {
      ...integration,
      integration_status: 'suspended',
      github_disconnected_at: '2026-09-14T00:00:00.000Z',
      suspended_by: 'local_disconnect',
    };
    mockFindIntegrationByInstallationId.mockResolvedValue(disconnected);
    mockGetIntegrationForOrganization.mockResolvedValue(disconnected);
    // The real unscoped runtime resolver succeeds on the remaining active sibling.
    mockAssertGitHubInstallationRuntimeAuthorized.mockResolvedValue(undefined);

    const response = await handleGitHubWebhook(
      signedGitHubRequest('pull_request', pullRequestPayload()),
      'standard'
    );

    expect(response.status).toBe(200);
    expect({
      logged: mockLogWebhookEvent.mock.calls.length,
      dispatched: mockHandlePullRequest.mock.calls.length,
    }).toEqual({ logged: 0, dispatched: 0 });
    expect(mockAssertGitHubInstallationRuntimeAuthorized).not.toHaveBeenCalled();
  });

  it('validates deferred dispatch against the exact routed association', async () => {
    mockAssertGitHubInstallationRuntimeAuthorized.mockResolvedValue(undefined);

    const response = await handleGitHubWebhook(
      signedGitHubRequest('pull_request', pullRequestPayload()),
      'standard'
    );

    expect(response.status).toBe(200);
    await waitForAfterTask();
    expect(mockAssertGitHubInstallationRuntimeAuthorized).toHaveBeenCalledWith(
      '98765',
      'standard',
      'pi_github'
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

  it('skips deferred GitHub work when the association disconnects after receipt', async () => {
    mockAssertGitHubInstallationRuntimeAuthorized.mockRejectedValueOnce(
      new GitHubRuntimeAuthorizationError()
    );

    const response = await handleGitHubWebhook(
      signedGitHubRequest('pull_request_review_comment', reviewCommentPayload()),
      'standard'
    );

    expect(response.status).toBe(200);
    await waitForAfterTask();
    expect(mockHandlePRReviewComment).not.toHaveBeenCalled();
  });

  it('returns 500 when the runtime availability query fails unexpectedly', async () => {
    mockAssertGitHubInstallationRuntimeAuthorized.mockRejectedValueOnce(
      new Error('database unavailable')
    );
    const response = await handleGitHubWebhook(
      signedGitHubRequest('pull_request_review_comment', reviewCommentPayload()),
      'standard'
    );
    expect(response.status).toBe(500);
    expect(mockHandlePRReviewComment).not.toHaveBeenCalled();
  });

  it('captures the 500 path with safe delivery tags and no payload or secret', async () => {
    mockAssertGitHubInstallationRuntimeAuthorized.mockRejectedValueOnce(
      new Error('database unavailable')
    );
    const payload = reviewCommentPayload({
      comment: {
        id: 456,
        body: 'secret-payload-marker',
        diff_hunk: '@@ -1 +1 @@ secret-payload-marker',
      },
    });

    const response = await handleGitHubWebhook(
      signedGitHubRequest('pull_request_review_comment', payload),
      'standard'
    );

    expect(response.status).toBe(500);
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          source: 'github_webhook_handler',
          event: 'pull_request_review_comment',
          delivery: 'delivery-pull_request_review_comment',
          installation: '98765',
          action: 'created',
        }),
      })
    );

    const captured = JSON.stringify(jest.mocked(captureException).mock.calls);
    expect(captured).not.toContain('secret-payload-marker');
    expect(captured).not.toContain('sha256=test');
    expect(captured).not.toContain('x-hub-signature-256');
    expect(captured).not.toContain('x-github-delivery');
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

  it.each(['standard', 'lite'] as const)(
    'ignores installation.deleted with a null installation for the %s app',
    async appType => {
      const request = signedGitHubRequest('installation', {
        action: 'deleted',
        installation: null,
        sender: { id: 111, login: 'alice' },
        organization: { id: 222, login: 'acme' },
        repositories: [{ id: 333, full_name: 'acme/widgets' }],
      });
      request.headers.set('x-github-hook-id', '444');
      request.headers.set('x-github-hook-installation-target-id', '555');
      request.headers.set('x-github-hook-installation-target-type', 'integration');

      const response = await handleGitHubWebhook(request, appType);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        message: 'Event ignored: missing installation ID',
      });
      expect(mockVerifyGitHubWebhookSignature).toHaveBeenCalledWith(
        expect.any(String),
        'sha256=test',
        appType
      );
      expect(mockFindIntegrationByInstallationId).not.toHaveBeenCalled();
      expect(mockHandleInstallationDeleted).not.toHaveBeenCalled();
      expect(mockLogWebhookEvent).not.toHaveBeenCalled();
      expect(mockUpdateWebhookEvent).not.toHaveBeenCalled();
      expect(captureMessage).not.toHaveBeenCalled();
      expect(captureException).not.toHaveBeenCalled();
    }
  );

  it('rejects installation.deleted with a null installation when signature verification fails', async () => {
    mockVerifyGitHubWebhookSignature.mockReturnValue(false);

    const response = await handleGitHubWebhook(
      signedGitHubRequest('installation', { action: 'deleted', installation: null }),
      'standard'
    );

    expect(response.status).toBe(401);
    expect(mockFindIntegrationByInstallationId).not.toHaveBeenCalled();
    expect(mockHandleInstallationDeleted).not.toHaveBeenCalled();
    expect(mockLogWebhookEvent).not.toHaveBeenCalled();
    expect(mockUpdateWebhookEvent).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { id: '98765' }])(
    'still rejects malformed installation.deleted installation %j',
    async installation => {
      const response = await handleGitHubWebhook(
        signedGitHubRequest('installation', { action: 'deleted', installation }),
        'standard'
      );

      expect(response.status).toBe(400);
      expect(mockFindIntegrationByInstallationId).not.toHaveBeenCalled();
      expect(mockHandleInstallationDeleted).not.toHaveBeenCalled();
      expect(captureMessage).toHaveBeenCalledWith(
        'Invalid GitHub webhook payload structure',
        expect.objectContaining({
          level: 'error',
          tags: { source: 'github_webhook_validation', event: 'installation.deleted' },
        })
      );
    }
  );

  it('preserves duplicate installation.deleted handling', async () => {
    mockClaimSharedGitHubInstallationDelivery.mockResolvedValue({ status: 'completed' });

    const response = await handleGitHubWebhook(
      signedGitHubRequest('installation', { action: 'deleted', installation: { id: 98765 } }),
      'standard'
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'Duplicate event' });
    expect(mockFindIntegrationByInstallationId).not.toHaveBeenCalled();
    expect(mockLogWebhookEvent).not.toHaveBeenCalled();
    expect(mockHandleInstallationDeleted).not.toHaveBeenCalled();
    expect(mockUpdateWebhookEvent).not.toHaveBeenCalled();
  });

  it('dispatches a duplicate shared delivery exactly once while a claim is held', async () => {
    mockIsSharedGitHubInstallation.mockResolvedValue(true);
    mockClaimSharedGitHubInstallationDelivery
      .mockResolvedValueOnce({ status: 'claimed', githubInstallationId: 'canonical-installation' })
      .mockResolvedValueOnce({ status: 'processing' });
    mockHandleInstallationDeleted.mockResolvedValue(
      Response.json({ message: 'Installation removed' })
    );
    const payload = { action: 'deleted', installation: { id: 98765 } };

    const first = await handleGitHubWebhook(
      signedGitHubRequest('installation', payload),
      'standard'
    );
    const duplicate = await handleGitHubWebhook(
      signedGitHubRequest('installation', payload),
      'standard'
    );

    expect(await first.json()).toEqual({ message: 'Installation removed' });
    expect(await duplicate.json()).toEqual({ message: 'Duplicate event' });
    expect(mockHandleInstallationDeleted).toHaveBeenCalledTimes(1);
    expect(mockCompleteSharedGitHubInstallationDelivery).toHaveBeenCalledTimes(1);
    expect(mockClaimSharedGitHubInstallationDelivery).toHaveBeenCalledWith({
      installationId: '98765',
      appType: 'standard',
      deliveryId: 'delivery-installation',
      eventType: 'installation.deleted',
    });
  });

  it('leaves no completed receipt when required cleanup fails before manual redelivery', async () => {
    mockIsSharedGitHubInstallation.mockResolvedValue(true);
    mockHandleInstallationDeleted.mockRejectedValueOnce(new Error('transient'));
    const payload = { action: 'deleted', installation: { id: 98765 } };

    const failed = await handleGitHubWebhook(
      signedGitHubRequest('installation', payload),
      'standard'
    );
    const retried = await handleGitHubWebhook(
      signedGitHubRequest('installation', payload),
      'standard'
    );

    expect(failed.status).toBe(500);
    expect(await retried.json()).toEqual({ message: 'Installation removed' });
    expect(mockHandleInstallationDeleted).toHaveBeenCalledTimes(2);
    expect(mockCompleteSharedGitHubInstallationDelivery).toHaveBeenCalledTimes(1);
    expect(mockReleaseSharedGitHubInstallationDelivery).toHaveBeenCalledTimes(1);
  });

  it('does not record a completion receipt when the dispatched response is not ok', async () => {
    mockIsSharedGitHubInstallation.mockResolvedValue(true);
    mockHandleInstallationDeleted.mockResolvedValueOnce(
      Response.json({ error: 'upstream failure' }, { status: 502 })
    );
    const payload = { action: 'deleted', installation: { id: 98765 } };

    const failed = await handleGitHubWebhook(
      signedGitHubRequest('installation', payload),
      'standard'
    );
    const retried = await handleGitHubWebhook(
      signedGitHubRequest('installation', payload),
      'standard'
    );

    expect(failed.status).toBe(502);
    expect(await retried.json()).toEqual({ message: 'Installation removed' });
    expect(mockHandleInstallationDeleted).toHaveBeenCalledTimes(2);
    expect(mockCompleteSharedGitHubInstallationDelivery).toHaveBeenCalledTimes(1);
    expect(mockReleaseSharedGitHubInstallationDelivery).toHaveBeenCalledTimes(1);
  });

  it('records a completion receipt when the dispatched response is ok', async () => {
    mockIsSharedGitHubInstallation.mockResolvedValue(true);
    mockHandleInstallationDeleted.mockResolvedValueOnce(
      Response.json({ message: 'Installation removed' }, { status: 200 })
    );
    const payload = { action: 'deleted', installation: { id: 98765 } };

    const response = await handleGitHubWebhook(
      signedGitHubRequest('installation', payload),
      'standard'
    );

    expect(response.status).toBe(200);
    expect(mockCompleteSharedGitHubInstallationDelivery).toHaveBeenCalledTimes(1);
  });

  it('dispatches lifecycle when a canonical receipt cannot be resolved', async () => {
    mockIsSharedGitHubInstallation.mockResolvedValue(true);
    mockClaimSharedGitHubInstallationDelivery.mockResolvedValue({ status: 'missing_canonical' });
    const payload = { action: 'deleted', installation: { id: 98765 } };

    const response = await handleGitHubWebhook(
      signedGitHubRequest('installation', payload),
      'standard'
    );

    expect(response.status).toBe(200);
    expect(mockHandleInstallationDeleted).toHaveBeenCalledTimes(1);
  });

  it('routes installation.deleted with a known ID even when no integration is found', async () => {
    const payload = { action: 'deleted', installation: { id: 98765 } };
    mockFindIntegrationByInstallationId.mockResolvedValue(null);

    const response = await handleGitHubWebhook(
      signedGitHubRequest('installation', payload),
      'standard'
    );

    expect(response.status).toBe(200);
    expect(mockHandleInstallationDeleted).toHaveBeenCalledWith(payload, 'standard');
    expect(mockLogWebhookEvent).not.toHaveBeenCalled();
    expect(mockUpdateWebhookEvent).not.toHaveBeenCalled();
  });

  it('routes installation.deleted to the handler with the webhook app type', async () => {
    const payload = { action: 'deleted', installation: { id: 98765 } };

    const response = await handleGitHubWebhook(
      signedGitHubRequest('installation', payload),
      'lite'
    );

    expect(response.status).toBe(200);
    expect(mockMaterializeGitHubInstallationIdentity).toHaveBeenCalledWith({
      installationId: '98765',
      appType: 'lite',
    });
    expect(mockMaterializeGitHubInstallationIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      mockClaimSharedGitHubInstallationDelivery.mock.invocationCallOrder[0]!
    );
    expect(mockFindIntegrationByInstallationId).not.toHaveBeenCalled();
    expect(mockHandleInstallationDeleted).toHaveBeenCalledWith(
      expect.objectContaining(payload),
      'lite'
    );
    expect(mockUpdateWebhookEvent).not.toHaveBeenCalled();
    expect(mockCompleteSharedGitHubInstallationDelivery).toHaveBeenCalledWith({
      githubInstallationId: 'canonical-installation',
      deliveryId: 'delivery-installation',
    });
  });

  it('routes installation.suspend to the handler with the webhook app type', async () => {
    const payload = { action: 'suspend', installation: { id: 98765 } };

    const response = await handleGitHubWebhook(
      signedGitHubRequest('installation', payload),
      'standard'
    );

    expect(response.status).toBe(200);
    expect(mockFindConnectedIntegrationByInstallationId).toHaveBeenCalledWith(
      'github',
      '98765',
      'standard'
    );
    expect(mockHandleInstallationSuspend).toHaveBeenCalledWith(
      expect.objectContaining(payload),
      'standard'
    );
  });

  it('dispatches installation.suspend for the connected tenant when a disconnected former tenant exists', async () => {
    // The unfiltered lookup would return the retained disconnected row; the
    // route must not use it (and must not drop the delivery), so the handler
    // still runs and canonical state is reconciled.
    mockFindIntegrationByInstallationId.mockResolvedValue({
      ...integration,
      github_disconnected_at: '2026-09-15T00:00:00.000Z',
    });

    const payload = { action: 'suspend', installation: { id: 98765 } };
    const response = await handleGitHubWebhook(
      signedGitHubRequest('installation', payload),
      'standard'
    );

    expect(response.status).toBe(200);
    expect(mockFindIntegrationByInstallationId).not.toHaveBeenCalled();
    expect(mockLogWebhookEvent).toHaveBeenCalledTimes(1);
    expect(mockHandleInstallationSuspend).toHaveBeenCalledWith(
      expect.objectContaining(payload),
      'standard'
    );
  });

  it('still dispatches installation.suspend when only a disconnected former tenant remains', async () => {
    mockFindConnectedIntegrationByInstallationId.mockResolvedValue(null);

    const payload = { action: 'suspend', installation: { id: 98765 } };
    const response = await handleGitHubWebhook(
      signedGitHubRequest('installation', payload),
      'standard'
    );

    expect(response.status).toBe(200);
    // Canonical state is still reconciled by the handler; nothing is logged
    // against the disconnected tenant.
    expect(mockLogWebhookEvent).not.toHaveBeenCalled();
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
    expect(mockFindConnectedIntegrationByInstallationId).toHaveBeenCalledWith(
      'github',
      '98765',
      'lite'
    );
    expect(mockHandleInstallationUnsuspend).toHaveBeenCalledWith(
      expect.objectContaining(payload),
      'lite'
    );
  });

  it('processes installation.unsuspend for a suspended association instead of dropping it', async () => {
    mockFindConnectedIntegrationByInstallationId.mockResolvedValue({
      ...integration,
      integration_status: 'suspended',
      suspended_at: '2026-09-15T00:00:00.000Z',
      suspended_by: 'github_suspend',
    });

    const payload = { action: 'unsuspend', installation: { id: 98765 } };
    const response = await handleGitHubWebhook(
      signedGitHubRequest('installation', payload),
      'standard'
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ message: 'Installation unsuspended' });
    expect(mockHandleInstallationUnsuspend).toHaveBeenCalledWith(
      expect.objectContaining(payload),
      'standard'
    );
  });

  it('does not log installation.unsuspend when only a disconnected former tenant remains', async () => {
    // The connected-tenant lookup ignores retained disconnected rows, so the
    // delivery is not recorded against a tenant that no longer owns the
    // installation. Canonical state is still reconciled by the handler.
    mockFindConnectedIntegrationByInstallationId.mockResolvedValue(null);

    const payload = { action: 'unsuspend', installation: { id: 98765 } };
    const response = await handleGitHubWebhook(
      signedGitHubRequest('installation', payload),
      'standard'
    );

    expect(response.status).toBe(200);
    expect(mockLogWebhookEvent).not.toHaveBeenCalled();
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
