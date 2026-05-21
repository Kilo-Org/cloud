const mockGetBotUserId = jest.fn();
const mockGetAgentConfigForOwner = jest.fn();
const mockCreateCheckRun = jest.fn();
const mockUpdateCheckRun = jest.fn();
const mockUpdateCheckRunId = jest.fn();
const mockCreateCodeReview = jest.fn();
const mockCancelSupersededReviewsForPR = jest.fn();
const mockFindExistingReview = jest.fn();
const mockFindActiveReviewsForPR = jest.fn();
const mockUpdateReviewHeadShaAndCheckRun = jest.fn();
const mockTryDispatchPendingReviews = jest.fn();
const mockCancelReview = jest.fn();
const mockAddReactionToPR = jest.fn();
const mockIsMergeCommit = jest.fn();

jest.mock('@/lib/bot-users/bot-user-service', () => ({
  getBotUserId: (organizationId: string, botType: string) =>
    mockGetBotUserId(organizationId, botType),
}));

jest.mock('@/lib/agent-config/db/agent-configs', () => ({
  getAgentConfigForOwner: (owner: unknown, agentType: string, platform: string) =>
    mockGetAgentConfigForOwner(owner, agentType, platform),
}));

jest.mock('@/lib/code-reviews/db/code-reviews', () => ({
  createCodeReview: (...args: unknown[]) => mockCreateCodeReview(...args),
  cancelSupersededReviewsForPR: (...args: unknown[]) => mockCancelSupersededReviewsForPR(...args),
  findExistingReview: (...args: unknown[]) => mockFindExistingReview(...args),
  findActiveReviewsForPR: (...args: unknown[]) => mockFindActiveReviewsForPR(...args),
  updateReviewHeadShaAndCheckRun: (...args: unknown[]) =>
    mockUpdateReviewHeadShaAndCheckRun(...args),
  updateCheckRunId: (...args: unknown[]) => mockUpdateCheckRunId(...args),
}));

jest.mock('@/lib/code-reviews/dispatch/dispatch-pending-reviews', () => ({
  tryDispatchPendingReviews: (...args: unknown[]) => mockTryDispatchPendingReviews(...args),
}));

jest.mock('@/lib/code-reviews/client/code-review-worker-client', () => ({
  codeReviewWorkerClient: {
    cancelReview: (...args: unknown[]) => mockCancelReview(...args),
  },
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  addReactionToPR: (...args: unknown[]) => mockAddReactionToPR(...args),
  createCheckRun: (...args: unknown[]) => mockCreateCheckRun(...args),
  isMergeCommit: (...args: unknown[]) => mockIsMergeCommit(...args),
  updateCheckRun: (...args: unknown[]) => mockUpdateCheckRun(...args),
}));

import {
  getGitHubPullRequestCheckoutRef,
  resolvePullRequestCheckoutRef,
} from '@/lib/integrations/platforms/github/webhook-handlers/pull-request-checkout-ref';
import {
  handlePullRequest,
  shouldSkipSynchronizeForMergeCommit,
} from '@/lib/integrations/platforms/github/webhook-handlers/pull-request-handler';
import type { PullRequestPayload } from '@/lib/integrations/platforms/github/webhook-schemas';
import type { PlatformIntegration } from '@kilocode/db/schema';

function pullRequestPayload(overrides: Partial<PullRequestPayload> = {}): PullRequestPayload {
  return {
    action: 'synchronize',
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

beforeEach(() => {
  jest.clearAllMocks();
  mockGetBotUserId.mockResolvedValue(null);
  mockGetAgentConfigForOwner.mockResolvedValue(null);
  mockCreateCheckRun.mockResolvedValue(98765);
  mockUpdateCheckRun.mockResolvedValue(undefined);
  mockUpdateCheckRunId.mockResolvedValue(undefined);
  mockCreateCodeReview.mockResolvedValue('review-1');
  mockCancelSupersededReviewsForPR.mockResolvedValue([]);
  mockFindExistingReview.mockResolvedValue(null);
  mockFindActiveReviewsForPR.mockResolvedValue([]);
  mockUpdateReviewHeadShaAndCheckRun.mockResolvedValue(undefined);
  mockTryDispatchPendingReviews.mockResolvedValue({
    dispatched: 0,
    notDispatched: 1,
    activeCount: 0,
  });
  mockCancelReview.mockResolvedValue({ success: true, reviewId: 'old-review' });
  mockAddReactionToPR.mockResolvedValue(undefined);
  mockIsMergeCommit.mockResolvedValue(false);
});

describe('resolvePullRequestCheckoutRef', () => {
  it('builds GitHub synthetic pull refs', () => {
    expect(getGitHubPullRequestCheckoutRef(123)).toBe('refs/pull/123/head');
  });

  it('uses refs/pull/<number>/head for same-repo PRs', () => {
    const result = resolvePullRequestCheckoutRef({
      pull_request: {
        number: 123,
        head: {
          ref: 'feature/same-repo',
          repo: { full_name: 'acme/widgets' },
        },
      },
      repository: {
        full_name: 'acme/widgets',
      },
    });

    expect(result).toEqual({
      checkoutRef: 'refs/pull/123/head',
      isForkPr: false,
      headRepoFullName: 'acme/widgets',
    });
  });

  it('uses refs/pull/<number>/head for fork PRs', () => {
    const result = resolvePullRequestCheckoutRef({
      pull_request: {
        number: 456,
        head: {
          ref: 'feature/fork-branch',
          repo: { full_name: 'external/widgets-fork' },
        },
      },
      repository: {
        full_name: 'acme/widgets',
      },
    });

    expect(result).toEqual({
      checkoutRef: 'refs/pull/456/head',
      isForkPr: true,
      headRepoFullName: 'external/widgets-fork',
    });
  });

  it('uses refs/pull/<number>/head when head.repo is missing', () => {
    const result = resolvePullRequestCheckoutRef({
      pull_request: {
        number: 789,
        head: {
          ref: 'feature/missing-head-repo',
        },
      },
      repository: {
        full_name: 'acme/widgets',
      },
    });

    expect(result).toEqual({
      checkoutRef: 'refs/pull/789/head',
      isForkPr: false,
      headRepoFullName: null,
    });
  });
});

describe('shouldSkipSynchronizeForMergeCommit', () => {
  const baseArgs = {
    installationId: 'inst-1',
    headOwner: 'acme',
    headRepoName: 'widgets',
    headSha: 'deadbeef',
    appType: 'standard' as const,
  };

  it('returns false for non-synchronize actions without calling the check', async () => {
    for (const action of ['opened', 'reopened', 'ready_for_review']) {
      let called = false;
      const result = await shouldSkipSynchronizeForMergeCommit({
        ...baseArgs,
        action,
        isMergeCommitFn: async () => {
          called = true;
          return true;
        },
      });

      expect(result).toBe(false);
      expect(called).toBe(false);
    }
  });

  it('returns true when synchronize head is a merge commit', async () => {
    const result = await shouldSkipSynchronizeForMergeCommit({
      ...baseArgs,
      action: 'synchronize',
      isMergeCommitFn: async () => true,
    });

    expect(result).toBe(true);
  });

  it('returns false when synchronize head is not a merge commit', async () => {
    const result = await shouldSkipSynchronizeForMergeCommit({
      ...baseArgs,
      action: 'synchronize',
      isMergeCommitFn: async () => false,
    });

    expect(result).toBe(false);
  });

  it('passes the expected arguments to the check function', async () => {
    const calls: Array<[string, string, string, string, string]> = [];
    await shouldSkipSynchronizeForMergeCommit({
      ...baseArgs,
      action: 'synchronize',
      isMergeCommitFn: async (installationId, owner, repo, sha, appType) => {
        calls.push([installationId, owner, repo, sha, appType]);
        return false;
      },
    });

    expect(calls).toEqual([['inst-1', 'acme', 'widgets', 'deadbeef', 'standard']]);
  });
});

describe('handlePullRequest', () => {
  it('acknowledges org integrations that do not have a code review user context', async () => {
    const response = await handlePullRequest(pullRequestPayload(), platformIntegration());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'Code review user context not configured' });
    expect(mockGetBotUserId).toHaveBeenCalledWith(
      'f2aa36d7-9c1b-4db9-ae4a-a4492618796d',
      'code-review'
    );
    expect(mockGetAgentConfigForOwner).not.toHaveBeenCalled();
  });

  it('passes the integration GitHub app type when cancelling an orphaned check run', async () => {
    mockGetBotUserId.mockResolvedValue('bot-user-1');
    mockGetAgentConfigForOwner.mockResolvedValue({
      is_enabled: true,
      config: {},
    });
    mockUpdateCheckRunId.mockRejectedValue(new Error('database write failed'));

    const response = await handlePullRequest(
      pullRequestPayload(),
      platformIntegration({ github_app_type: 'standard' })
    );

    expect(response.status).toBe(202);
    expect(mockUpdateCheckRun).toHaveBeenCalledWith(
      '98765',
      'acme',
      'widgets',
      98765,
      { status: 'completed', conclusion: 'cancelled' },
      'standard'
    );
  });

  it('cancels superseded DB rows, interrupts queued/running only, and creates the new review', async () => {
    mockGetBotUserId.mockResolvedValue('bot-user-1');
    mockGetAgentConfigForOwner.mockResolvedValue({
      is_enabled: true,
      config: {},
    });
    mockCancelSupersededReviewsForPR.mockResolvedValue([
      {
        id: 'pending-review',
        prevStatus: 'pending',
        sessionId: null,
        latestActiveAttemptId: 'pending-attempt',
        checkRunId: 101,
        headSha: 'old-pending-sha',
        platform: 'github',
        platformProjectId: null,
        platformIntegrationId: 'integration-1',
      },
      {
        id: 'queued-review',
        prevStatus: 'queued',
        sessionId: 'session-queued',
        latestActiveAttemptId: 'queued-attempt',
        checkRunId: 102,
        headSha: 'old-queued-sha',
        platform: 'github',
        platformProjectId: null,
        platformIntegrationId: 'integration-1',
      },
      {
        id: 'running-review',
        prevStatus: 'running',
        sessionId: 'session-running',
        latestActiveAttemptId: 'running-attempt',
        checkRunId: null,
        headSha: 'old-running-sha',
        platform: 'github',
        platformProjectId: null,
        platformIntegrationId: 'integration-1',
      },
    ]);

    const response = await handlePullRequest(pullRequestPayload(), platformIntegration());

    expect(response.status).toBe(202);
    expect(mockCancelSupersededReviewsForPR).toHaveBeenCalledWith('acme/widgets', 42, 'abc123');
    expect(mockCancelReview).toHaveBeenCalledTimes(2);
    expect(mockCancelReview).toHaveBeenNthCalledWith(
      1,
      'queued-review',
      'Superseded by new push',
      'queued-attempt'
    );
    expect(mockCancelReview).toHaveBeenNthCalledWith(
      2,
      'running-review',
      'Superseded by new push',
      'running-attempt'
    );
    expect(mockUpdateCheckRun).toHaveBeenCalledWith(
      '98765',
      'acme',
      'widgets',
      101,
      {
        status: 'completed',
        conclusion: 'cancelled',
        output: {
          title: 'Kilo Code Review superseded',
          summary: 'A newer commit was pushed; this review was cancelled.',
        },
      },
      'standard'
    );
    expect(mockUpdateCheckRun).toHaveBeenCalledWith(
      '98765',
      'acme',
      'widgets',
      102,
      {
        status: 'completed',
        conclusion: 'cancelled',
        output: {
          title: 'Kilo Code Review superseded',
          summary: 'A newer commit was pushed; this review was cancelled.',
        },
      },
      'standard'
    );
    expect(mockCreateCodeReview).toHaveBeenCalledTimes(1);
    expect(mockTryDispatchPendingReviews).toHaveBeenCalledTimes(1);
  });

  it('skips supersession cancel on merge-commit synchronize events', async () => {
    mockGetBotUserId.mockResolvedValue('bot-user-1');
    mockGetAgentConfigForOwner.mockResolvedValue({
      is_enabled: true,
      config: {},
    });
    mockFindActiveReviewsForPR.mockResolvedValue(['review-1']);
    mockIsMergeCommit.mockResolvedValue(true);

    const response = await handlePullRequest(pullRequestPayload(), platformIntegration());

    expect(response.status).toBe(200);
    expect(mockCancelSupersededReviewsForPR).not.toHaveBeenCalled();
    expect(mockCancelReview).not.toHaveBeenCalled();
    expect(mockCreateCodeReview).not.toHaveBeenCalled();
  });

  it('passes the integration GitHub app type when cancelling an orphaned merge-commit check run', async () => {
    mockGetBotUserId.mockResolvedValue('bot-user-1');
    mockGetAgentConfigForOwner.mockResolvedValue({
      is_enabled: true,
      config: {},
    });
    mockFindActiveReviewsForPR.mockResolvedValue(['review-1']);
    mockUpdateReviewHeadShaAndCheckRun.mockRejectedValue(new Error('database write failed'));
    mockIsMergeCommit.mockResolvedValue(true);

    const response = await handlePullRequest(
      pullRequestPayload(),
      platformIntegration({ github_app_type: 'standard' })
    );

    expect(response.status).toBe(200);
    expect(mockUpdateCheckRun).toHaveBeenCalledWith(
      '98765',
      'acme',
      'widgets',
      98765,
      { status: 'completed', conclusion: 'cancelled' },
      'standard'
    );
  });
});
