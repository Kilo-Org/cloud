const mockGetBotUserId = jest.fn();
const mockGetAgentConfigForOwner = jest.fn();
const mockCreateCodeReview = jest.fn();
const mockCancelSupersededReviewsForPR = jest.fn();
const mockFindExistingReview = jest.fn();
const mockFindActiveReviewsForPR = jest.fn();
const mockUpdateReviewHeadShaAndCheckRun = jest.fn();
const mockTryDispatchPendingReviews = jest.fn();
const mockCancelReview = jest.fn();
const mockAddReactionToMR = jest.fn();
const mockSetCommitStatus = jest.fn();
const mockIsMergeCommit = jest.fn();
const mockGetIntegrationById = jest.fn();
const mockGetOrCreateProjectAccessToken = jest.fn();
const mockGetValidGitLabToken = jest.fn();

jest.mock('@/lib/bot-users/bot-user-service', () => ({
  getBotUserId: (...args: unknown[]) => mockGetBotUserId(...args),
}));

jest.mock('@/lib/agent-config/db/agent-configs', () => ({
  getAgentConfigForOwner: (...args: unknown[]) => mockGetAgentConfigForOwner(...args),
}));

jest.mock('@/lib/code-reviews/db/code-reviews', () => ({
  createCodeReview: (...args: unknown[]) => mockCreateCodeReview(...args),
  cancelSupersededReviewsForPR: (...args: unknown[]) => mockCancelSupersededReviewsForPR(...args),
  findExistingReview: (...args: unknown[]) => mockFindExistingReview(...args),
  findActiveReviewsForPR: (...args: unknown[]) => mockFindActiveReviewsForPR(...args),
  updateReviewHeadShaAndCheckRun: (...args: unknown[]) =>
    mockUpdateReviewHeadShaAndCheckRun(...args),
}));

jest.mock('@/lib/code-reviews/dispatch/dispatch-pending-reviews', () => ({
  tryDispatchPendingReviews: (...args: unknown[]) => mockTryDispatchPendingReviews(...args),
}));

jest.mock('@/lib/code-reviews/client/code-review-worker-client', () => ({
  codeReviewWorkerClient: {
    cancelReview: (...args: unknown[]) => mockCancelReview(...args),
  },
}));

jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  addReactionToMR: (...args: unknown[]) => mockAddReactionToMR(...args),
  isMergeCommit: (...args: unknown[]) => mockIsMergeCommit(...args),
  setCommitStatus: (...args: unknown[]) => mockSetCommitStatus(...args),
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationById: (...args: unknown[]) => mockGetIntegrationById(...args),
}));

jest.mock('@/lib/integrations/gitlab-service', () => ({
  getOrCreateProjectAccessToken: (...args: unknown[]) => mockGetOrCreateProjectAccessToken(...args),
  getValidGitLabToken: (...args: unknown[]) => mockGetValidGitLabToken(...args),
}));

import {
  handleMergeRequestCodeReview,
  shouldSkipUpdateForMergeCommit,
} from '@/lib/integrations/platforms/gitlab/webhook-handlers/merge-request-handler';
import type { MergeRequestPayload } from '@/lib/integrations/platforms/gitlab/webhook-schemas';
import type { PlatformIntegration } from '@kilocode/db/schema';

function mergeRequestPayload(overrides: Partial<MergeRequestPayload> = {}): MergeRequestPayload {
  return {
    object_kind: 'merge_request',
    user: { id: 1, username: 'alice', name: 'Alice' },
    project: {
      id: 123,
      path_with_namespace: 'acme/widgets',
      web_url: 'https://gitlab.com/acme/widgets',
      default_branch: 'main',
      namespace: 'acme',
      path: 'widgets',
      name: 'widgets',
      description: null,
      avatar_url: null,
      git_ssh_url: 'git@gitlab.com:acme/widgets.git',
      git_http_url: 'https://gitlab.com/acme/widgets.git',
      visibility_level: 20,
      homepage: 'https://gitlab.com/acme/widgets',
      url: 'git@gitlab.com:acme/widgets.git',
      ssh_url: 'git@gitlab.com:acme/widgets.git',
      http_url: 'https://gitlab.com/acme/widgets.git',
    },
    object_attributes: {
      id: 456,
      iid: 42,
      title: 'Add widgets',
      action: 'update',
      url: 'https://gitlab.com/acme/widgets/-/merge_requests/42',
      source_branch: 'feature/widgets',
      target_branch: 'main',
      source_project_id: 123,
      target_project_id: 123,
      state: 'opened',
      draft: false,
      work_in_progress: false,
      last_commit: { id: 'abc123', message: 'Add widgets' },
    },
    ...overrides,
  } as MergeRequestPayload;
}

function platformIntegration(overrides: Partial<PlatformIntegration> = {}): PlatformIntegration {
  return {
    id: '8b2ff443-8396-4b07-99ae-7015789da7dd',
    owned_by_organization_id: 'f2aa36d7-9c1b-4db9-ae4a-a4492618796d',
    owned_by_user_id: null,
    kilo_requester_user_id: null,
    platform_installation_id: '98765',
    metadata: { gitlab_instance_url: 'https://gitlab.example.com' },
    ...overrides,
  } as PlatformIntegration;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetBotUserId.mockResolvedValue(null);
  mockGetAgentConfigForOwner.mockResolvedValue(null);
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
  mockAddReactionToMR.mockResolvedValue(undefined);
  mockSetCommitStatus.mockResolvedValue(undefined);
  mockIsMergeCommit.mockResolvedValue(false);
  mockGetIntegrationById.mockResolvedValue({
    id: '8b2ff443-8396-4b07-99ae-7015789da7dd',
    metadata: { gitlab_instance_url: 'https://gitlab.example.com' },
  });
  mockGetOrCreateProjectAccessToken.mockResolvedValue('prat-token');
  mockGetValidGitLabToken.mockResolvedValue('gitlab-token');
});

describe('shouldSkipUpdateForMergeCommit', () => {
  it('returns false for non-update actions without calling the check', async () => {
    const actions: Array<string | undefined> = ['open', 'reopen', 'close', 'merge', undefined];
    for (const action of actions) {
      let called = false;
      const result = await shouldSkipUpdateForMergeCommit({
        action,
        check: async () => {
          called = true;
          return true;
        },
      });

      expect(result).toBe(false);
      expect(called).toBe(false);
    }
  });

  it('returns true when update head is a merge commit', async () => {
    const result = await shouldSkipUpdateForMergeCommit({
      action: 'update',
      check: async () => true,
    });

    expect(result).toBe(true);
  });

  it('returns false when update head is not a merge commit', async () => {
    const result = await shouldSkipUpdateForMergeCommit({
      action: 'update',
      check: async () => false,
    });

    expect(result).toBe(false);
  });

  it('fails open when the check throws (review proceeds)', async () => {
    const result = await shouldSkipUpdateForMergeCommit({
      action: 'update',
      check: async () => {
        throw new Error('GitLab API unreachable');
      },
    });

    expect(result).toBe(false);
  });
});

describe('handleMergeRequestCodeReview', () => {
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
        checkRunId: null,
        headSha: 'old-pending-sha',
        platform: 'gitlab',
        platformProjectId: 123,
        platformIntegrationId: 'integration-1',
      },
      {
        id: 'queued-review',
        prevStatus: 'queued',
        sessionId: 'session-queued',
        latestActiveAttemptId: 'queued-attempt',
        checkRunId: null,
        headSha: 'old-queued-sha',
        platform: 'gitlab',
        platformProjectId: 123,
        platformIntegrationId: 'integration-1',
      },
      {
        id: 'running-review',
        prevStatus: 'running',
        sessionId: 'session-running',
        latestActiveAttemptId: 'running-attempt',
        checkRunId: null,
        headSha: 'old-running-sha',
        platform: 'gitlab',
        platformProjectId: 123,
        platformIntegrationId: 'integration-1',
      },
    ]);

    const response = await handleMergeRequestCodeReview(
      mergeRequestPayload(),
      platformIntegration()
    );

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
    expect(mockSetCommitStatus).toHaveBeenCalledWith(
      'prat-token',
      123,
      'old-pending-sha',
      'canceled',
      { description: 'Superseded by new push' },
      'https://gitlab.example.com'
    );
    expect(mockSetCommitStatus).toHaveBeenCalledWith(
      'prat-token',
      123,
      'old-queued-sha',
      'canceled',
      { description: 'Superseded by new push' },
      'https://gitlab.example.com'
    );
    expect(mockSetCommitStatus).toHaveBeenCalledWith(
      'prat-token',
      123,
      'old-running-sha',
      'canceled',
      { description: 'Superseded by new push' },
      'https://gitlab.example.com'
    );
    expect(mockCreateCodeReview).toHaveBeenCalledTimes(1);
    expect(mockTryDispatchPendingReviews).toHaveBeenCalledTimes(1);
  });

  it('skips supersession cancel on merge-commit update events', async () => {
    mockGetBotUserId.mockResolvedValue('bot-user-1');
    mockGetAgentConfigForOwner.mockResolvedValue({
      is_enabled: true,
      config: {},
    });
    mockFindActiveReviewsForPR.mockResolvedValue(['review-1']);
    mockIsMergeCommit.mockResolvedValue(true);

    const response = await handleMergeRequestCodeReview(
      mergeRequestPayload(),
      platformIntegration()
    );

    expect(response.status).toBe(200);
    expect(mockCancelSupersededReviewsForPR).not.toHaveBeenCalled();
    expect(mockCancelReview).not.toHaveBeenCalled();
    expect(mockCreateCodeReview).not.toHaveBeenCalled();
  });
});
