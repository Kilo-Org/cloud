import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import type { NextRequest } from 'next/server';
import type * as codeReviewsDbModule from '@/lib/code-reviews/db/code-reviews';
import type * as platformIntegrationsModule from '@/lib/integrations/db/platform-integrations';
import type { CloudAgentCodeReview } from '@kilocode/db/schema';

// --- Mock functions ---

const mockGetCodeReviewById = jest.fn() as jest.MockedFunction<
  typeof codeReviewsDbModule.getCodeReviewById
>;
const mockUpdateCodeReviewStatus = jest.fn() as jest.MockedFunction<
  typeof codeReviewsDbModule.updateCodeReviewStatus
>;
const mockUpdateCodeReviewUsage = jest.fn() as jest.MockedFunction<
  typeof codeReviewsDbModule.updateCodeReviewUsage
>;
const mockGetSessionUsageFromBilling = jest.fn() as jest.MockedFunction<
  typeof codeReviewsDbModule.getSessionUsageFromBilling
>;
const mockGetIntegrationById = jest.fn() as jest.MockedFunction<
  typeof platformIntegrationsModule.getIntegrationById
>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTryDispatchPendingReviews = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetBotUserId = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockUpdateCheckRun = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAddReactionToPR = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFindKiloReviewComment = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockUpdateKiloReviewComment = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSetCommitStatus = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAddReactionToMR = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFindKiloReviewNote = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockUpdateKiloReviewNote = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreatePRComment = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockHasPRCommentWithMarker = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreateMRNote = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockHasMRNoteWithMarker = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCaptureException = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCaptureMessage = jest.fn<any>();

// --- Module mocks ---

jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-internal-secret',
}));

jest.mock('@/lib/code-reviews/db/code-reviews', () => ({
  getCodeReviewById: mockGetCodeReviewById,
  updateCodeReviewStatus: mockUpdateCodeReviewStatus,
  updateCodeReviewUsage: mockUpdateCodeReviewUsage,
  getSessionUsageFromBilling: mockGetSessionUsageFromBilling,
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationById: mockGetIntegrationById,
}));

jest.mock('@/lib/code-reviews/dispatch/dispatch-pending-reviews', () => ({
  tryDispatchPendingReviews: mockTryDispatchPendingReviews,
}));

jest.mock('@/lib/bot-users/bot-user-service', () => ({
  getBotUserId: mockGetBotUserId,
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  updateCheckRun: mockUpdateCheckRun,
  addReactionToPR: mockAddReactionToPR,
  createPRComment: mockCreatePRComment,
  hasPRCommentWithMarker: mockHasPRCommentWithMarker,
  findKiloReviewComment: mockFindKiloReviewComment,
  updateKiloReviewComment: mockUpdateKiloReviewComment,
}));

jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  setCommitStatus: mockSetCommitStatus,
  addReactionToMR: mockAddReactionToMR,
  createMRNote: mockCreateMRNote,
  hasMRNoteWithMarker: mockHasMRNoteWithMarker,
  findKiloReviewNote: mockFindKiloReviewNote,
  updateKiloReviewNote: mockUpdateKiloReviewNote,
}));

jest.mock('@/lib/integrations/gitlab-service', () => ({
  getValidGitLabToken: jest.fn<() => Promise<string>>().mockResolvedValue('mock-token'),
  getStoredProjectAccessToken: jest.fn<() => null>().mockReturnValue(null),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: mockCaptureException,
  captureMessage: mockCaptureMessage,
}));

jest.mock('@/lib/code-reviews/summary/usage-footer', () => ({
  appendUsageFooter: jest.fn().mockReturnValue('body with footer'),
}));

jest.mock('@/lib/constants', () => ({
  APP_URL: 'https://test.kilo.ai',
}));

jest.mock('@/lib/integrations/core/constants', () => ({
  PLATFORM: { GITHUB: 'github', GITLAB: 'gitlab' },
}));

// --- Helpers ---

const VALID_SECRET = 'test-internal-secret';
const REVIEW_ID = '00000000-0000-0000-0000-000000000001';

function makeRequest(body: Record<string, unknown>, secret = VALID_SECRET): NextRequest {
  return {
    headers: {
      get: (name: string) => (name === 'X-Internal-Secret' ? secret : null),
    },
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

function makeParams(reviewId: string): { params: Promise<{ reviewId: string }> } {
  return { params: Promise.resolve({ reviewId }) };
}

function makeReview(overrides: Partial<CloudAgentCodeReview> = {}): CloudAgentCodeReview {
  return {
    id: REVIEW_ID,
    owned_by_organization_id: null,
    owned_by_user_id: 'user-1',
    platform_integration_id: 'int-1',
    repo_full_name: 'owner/repo',
    pr_number: 1,
    pr_url: 'https://github.com/owner/repo/pull/1',
    pr_title: 'Test PR',
    pr_author: 'author',
    pr_author_github_id: null,
    base_ref: 'main',
    head_ref: 'feature',
    head_sha: 'abc123',
    platform: 'github',
    platform_project_id: null,
    session_id: null,
    cli_session_id: null,
    status: 'running',
    error_message: null,
    terminal_reason: null,
    agent_version: 'v2',
    check_run_id: 12345,
    model: null,
    total_tokens_in: null,
    total_tokens_out: null,
    total_cost_musd: null,
    started_at: '2025-01-01T00:00:00Z',
    completed_at: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

// --- Tests ---

import type { POST as POSTType } from './route';

let POST: typeof POSTType;

beforeEach(async () => {
  jest.clearAllMocks();
  mockUpdateCodeReviewStatus.mockResolvedValue(undefined);
  mockTryDispatchPendingReviews.mockResolvedValue(undefined);
  mockGetBotUserId.mockResolvedValue(null);
  mockGetIntegrationById.mockResolvedValue({
    id: 'int-1',
    platform_installation_id: 'inst-1',
    platform: 'github',
    owned_by_organization_id: null,
    owned_by_user_id: 'user-1',
    created_by_user_id: null,
    integration_type: 'github_app',
    platform_account_id: null,
    platform_account_login: null,
    permissions: null,
    scopes: null,
    repository_access: null,
    repositories: null,
    repositories_synced_at: null,
    metadata: null,
    kilo_requester_user_id: null,
    platform_requester_account_id: null,
    integration_status: null,
    suspended_at: null,
    suspended_by: null,
    github_app_type: 'standard',
    installed_at: '2025-01-01T00:00:00Z',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  });
  mockUpdateCheckRun.mockResolvedValue(undefined);
  mockAddReactionToPR.mockResolvedValue(undefined);
  mockCreatePRComment.mockResolvedValue(undefined);
  mockHasPRCommentWithMarker.mockResolvedValue(false);
  mockCreateMRNote.mockResolvedValue(undefined);
  mockHasMRNoteWithMarker.mockResolvedValue(false);
  ({ POST } = await import('./route'));
});

describe('POST /api/internal/code-review-status/[reviewId]', () => {
  describe('normalization', () => {
    it('maps interrupted status to cancelled', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());

      const response = await POST(
        makeRequest({ status: 'interrupted', errorMessage: 'User interrupted' }),
        makeParams(REVIEW_ID)
      );

      expect(response.status).toBe(200);
      expect(mockUpdateCodeReviewStatus).toHaveBeenCalledWith(
        REVIEW_ID,
        'cancelled',
        expect.objectContaining({ errorMessage: 'User interrupted' })
      );
    });

    it('preserves failed status for billing errors', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());

      const response = await POST(
        makeRequest({
          status: 'failed',
          errorMessage: 'Insufficient credits: $1 minimum required',
          terminalReason: 'billing',
        }),
        makeParams(REVIEW_ID)
      );

      expect(response.status).toBe(200);
      expect(mockUpdateCodeReviewStatus).toHaveBeenCalledWith(
        REVIEW_ID,
        'failed',
        expect.objectContaining({
          errorMessage: 'Insufficient credits: $1 minimum required',
          terminalReason: 'billing',
        })
      );
    });

    it('reclassifies interrupted billing errors as failed with billing reason', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());

      const response = await POST(
        makeRequest({
          status: 'interrupted',
          errorMessage: 'This is a paid model. To use paid models, you need to add credits.',
        }),
        makeParams(REVIEW_ID)
      );

      expect(response.status).toBe(200);
      expect(mockUpdateCodeReviewStatus).toHaveBeenCalledWith(
        REVIEW_ID,
        'failed',
        expect.objectContaining({
          errorMessage: 'This is a paid model. To use paid models, you need to add credits.',
          terminalReason: 'billing',
        })
      );
    });

    it('infers billing terminalReason for failed status with billing error message', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());

      const response = await POST(
        makeRequest({
          status: 'failed',
          errorMessage: 'Add credits to continue, or switch to a free model',
        }),
        makeParams(REVIEW_ID)
      );

      expect(response.status).toBe(200);
      expect(mockUpdateCodeReviewStatus).toHaveBeenCalledWith(
        REVIEW_ID,
        'failed',
        expect.objectContaining({
          errorMessage: 'Add credits to continue, or switch to a free model',
          terminalReason: 'billing',
        })
      );
    });

    it('does not reclassify interrupted status with non-billing error message', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());

      const response = await POST(
        makeRequest({
          status: 'interrupted',
          errorMessage: 'User cancelled the review',
        }),
        makeParams(REVIEW_ID)
      );

      expect(response.status).toBe(200);
      expect(mockUpdateCodeReviewStatus).toHaveBeenCalledWith(
        REVIEW_ID,
        'cancelled',
        expect.objectContaining({
          errorMessage: 'User cancelled the review',
          terminalReason: undefined,
        })
      );
    });

    it('preserves explicit terminalReason when already set', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());

      const response = await POST(
        makeRequest({
          status: 'failed',
          errorMessage: 'Insufficient credits: $1 minimum required',
          terminalReason: 'billing',
        }),
        makeParams(REVIEW_ID)
      );

      expect(response.status).toBe(200);
      expect(mockUpdateCodeReviewStatus).toHaveBeenCalledWith(
        REVIEW_ID,
        'failed',
        expect.objectContaining({
          terminalReason: 'billing',
        })
      );
    });
  });

  describe('terminal_reason persistence', () => {
    it('passes terminalReason to updateCodeReviewStatus', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());

      await POST(
        makeRequest({
          status: 'failed',
          errorMessage: 'Timeout exceeded',
          terminalReason: 'timeout',
        }),
        makeParams(REVIEW_ID)
      );

      expect(mockUpdateCodeReviewStatus).toHaveBeenCalledWith(
        REVIEW_ID,
        'failed',
        expect.objectContaining({ terminalReason: 'timeout' })
      );
    });

    it('handles missing terminalReason gracefully', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());

      await POST(makeRequest({ status: 'completed' }), makeParams(REVIEW_ID));

      expect(mockUpdateCodeReviewStatus).toHaveBeenCalledWith(
        REVIEW_ID,
        'completed',
        expect.objectContaining({ terminalReason: undefined })
      );
    });
  });

  describe('GitHub check run billing messaging', () => {
    it('uses action_required conclusion for billing failures', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());

      await POST(
        makeRequest({
          status: 'failed',
          errorMessage: 'Insufficient credits',
          terminalReason: 'billing',
        }),
        makeParams(REVIEW_ID)
      );

      expect(mockUpdateCheckRun).toHaveBeenCalledWith(
        'inst-1',
        'owner',
        'repo',
        12345,
        expect.objectContaining({
          status: 'completed',
          conclusion: 'action_required',
          output: expect.objectContaining({
            title: 'Insufficient credits to run review',
            summary: 'Review could not start because the account has insufficient credits.',
          }),
        })
      );
    });

    it('uses failure conclusion for non-billing failures', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());

      await POST(
        makeRequest({
          status: 'failed',
          errorMessage: 'Something went wrong',
          terminalReason: 'upstream_error',
        }),
        makeParams(REVIEW_ID)
      );

      expect(mockUpdateCheckRun).toHaveBeenCalledWith(
        'inst-1',
        'owner',
        'repo',
        12345,
        expect.objectContaining({
          conclusion: 'failure',
          output: expect.objectContaining({
            title: 'Kilo Code Review failed',
          }),
        })
      );
    });

    it('detects billing from error_message when terminalReason is missing (historical)', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());

      await POST(
        makeRequest({
          status: 'failed',
          errorMessage: 'This is a paid model, please add credits to your account',
        }),
        makeParams(REVIEW_ID)
      );

      expect(mockUpdateCheckRun).toHaveBeenCalledWith(
        'inst-1',
        'owner',
        'repo',
        12345,
        expect.objectContaining({
          conclusion: 'action_required',
          output: expect.objectContaining({
            title: 'Insufficient credits to run review',
          }),
        })
      );
    });
  });

  describe('billing PR/MR comment', () => {
    it('posts billing notice on GitHub PR for billing failures', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());
      mockHasPRCommentWithMarker.mockResolvedValue(false);

      await POST(
        makeRequest({
          status: 'failed',
          errorMessage: 'Insufficient credits',
          terminalReason: 'billing',
        }),
        makeParams(REVIEW_ID)
      );

      expect(mockHasPRCommentWithMarker).toHaveBeenCalledWith(
        'inst-1',
        'owner',
        'repo',
        1,
        '<!-- kilo-billing-notice -->'
      );
      expect(mockCreatePRComment).toHaveBeenCalledWith(
        'inst-1',
        'owner',
        'repo',
        1,
        expect.stringContaining('your account is out of credits')
      );
    });

    it('skips billing notice if already posted on GitHub PR', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());
      mockHasPRCommentWithMarker.mockResolvedValue(true);

      await POST(
        makeRequest({
          status: 'failed',
          errorMessage: 'Insufficient credits',
          terminalReason: 'billing',
        }),
        makeParams(REVIEW_ID)
      );

      expect(mockHasPRCommentWithMarker).toHaveBeenCalled();
      expect(mockCreatePRComment).not.toHaveBeenCalled();
    });

    it('does not post billing notice for non-billing failures', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());

      await POST(
        makeRequest({
          status: 'failed',
          errorMessage: 'Something went wrong',
          terminalReason: 'upstream_error',
        }),
        makeParams(REVIEW_ID)
      );

      expect(mockCreatePRComment).not.toHaveBeenCalled();
      expect(mockHasPRCommentWithMarker).not.toHaveBeenCalled();
    });

    it('posts billing notice on GitLab MR for billing failures', async () => {
      mockGetCodeReviewById.mockResolvedValue(
        makeReview({ platform: 'gitlab', platform_project_id: 42, check_run_id: null })
      );
      mockHasMRNoteWithMarker.mockResolvedValue(false);

      await POST(
        makeRequest({
          status: 'failed',
          errorMessage: 'Insufficient credits',
          terminalReason: 'billing',
        }),
        makeParams(REVIEW_ID)
      );

      expect(mockHasMRNoteWithMarker).toHaveBeenCalledWith(
        'mock-token',
        'owner/repo',
        1,
        '<!-- kilo-billing-notice -->',
        'https://gitlab.com'
      );
      expect(mockCreateMRNote).toHaveBeenCalledWith(
        'mock-token',
        'owner/repo',
        1,
        expect.stringContaining('your account is out of credits'),
        'https://gitlab.com'
      );
    });

    it('skips billing notice if already posted on GitLab MR', async () => {
      mockGetCodeReviewById.mockResolvedValue(
        makeReview({ platform: 'gitlab', platform_project_id: 42, check_run_id: null })
      );
      mockHasMRNoteWithMarker.mockResolvedValue(true);

      await POST(
        makeRequest({
          status: 'failed',
          errorMessage: 'Insufficient credits',
          terminalReason: 'billing',
        }),
        makeParams(REVIEW_ID)
      );

      expect(mockHasMRNoteWithMarker).toHaveBeenCalled();
      expect(mockCreateMRNote).not.toHaveBeenCalled();
    });

    it('includes link to app.kilo.ai in the billing notice', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());
      mockHasPRCommentWithMarker.mockResolvedValue(false);

      await POST(
        makeRequest({
          status: 'failed',
          errorMessage: 'Insufficient credits',
          terminalReason: 'billing',
        }),
        makeParams(REVIEW_ID)
      );

      expect(mockCreatePRComment).toHaveBeenCalledWith(
        'inst-1',
        'owner',
        'repo',
        1,
        expect.stringContaining('https://app.kilo.ai/')
      );
    });

    it('suggests switching to a free model in the billing notice', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());
      mockHasPRCommentWithMarker.mockResolvedValue(false);

      await POST(
        makeRequest({
          status: 'failed',
          errorMessage: 'Insufficient credits',
          terminalReason: 'billing',
        }),
        makeParams(REVIEW_ID)
      );

      expect(mockCreatePRComment).toHaveBeenCalledWith(
        'inst-1',
        'owner',
        'repo',
        1,
        expect.stringContaining('switch to a free model')
      );
    });
  });
});
