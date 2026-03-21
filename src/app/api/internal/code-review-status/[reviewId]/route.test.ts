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
  findKiloReviewComment: mockFindKiloReviewComment,
  updateKiloReviewComment: mockUpdateKiloReviewComment,
}));

jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  setCommitStatus: mockSetCommitStatus,
  addReactionToMR: mockAddReactionToMR,
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
  });

  describe('GitHub check run mapping', () => {
    it('uses failure conclusion for failed reviews', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());

      await POST(
        makeRequest({
          status: 'failed',
          errorMessage: 'Something went wrong',
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

    it('uses success conclusion for completed reviews', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());

      await POST(makeRequest({ status: 'completed' }), makeParams(REVIEW_ID));

      expect(mockUpdateCheckRun).toHaveBeenCalledWith(
        'inst-1',
        'owner',
        'repo',
        12345,
        expect.objectContaining({
          status: 'completed',
          conclusion: 'success',
          output: expect.objectContaining({
            title: 'Kilo Code Review completed',
          }),
        })
      );
    });

    it('uses cancelled conclusion for cancelled reviews', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());

      await POST(makeRequest({ status: 'cancelled' }), makeParams(REVIEW_ID));

      expect(mockUpdateCheckRun).toHaveBeenCalledWith(
        'inst-1',
        'owner',
        'repo',
        12345,
        expect.objectContaining({
          status: 'completed',
          conclusion: 'cancelled',
          output: expect.objectContaining({
            title: 'Kilo Code Review cancelled',
          }),
        })
      );
    });

    it('uses failure conclusion when gate fails on completed review', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());

      await POST(
        makeRequest({ status: 'completed', gateResult: 'fail' }),
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
            title: 'Kilo Code Review found issues',
          }),
        })
      );
    });

    it('includes error message in failed review summary', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());

      await POST(
        makeRequest({ status: 'failed', errorMessage: 'Connection timeout' }),
        makeParams(REVIEW_ID)
      );

      expect(mockUpdateCheckRun).toHaveBeenCalledWith(
        'inst-1',
        'owner',
        'repo',
        12345,
        expect.objectContaining({
          output: expect.objectContaining({
            summary: 'Review failed: Connection timeout',
          }),
        })
      );
    });
  });

  describe('GitLab commit status', () => {
    beforeEach(() => {
      mockGetIntegrationById.mockResolvedValue({
        id: 'int-1',
        platform_installation_id: null,
        platform: 'gitlab',
        owned_by_organization_id: null,
        owned_by_user_id: 'user-1',
        created_by_user_id: null,
        integration_type: 'gitlab_oauth',
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
        github_app_type: null,
        installed_at: '2025-01-01T00:00:00Z',
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      });
    });

    it('sets GitLab commit status to success for completed reviews', async () => {
      mockGetCodeReviewById.mockResolvedValue(
        makeReview({ platform: 'gitlab', head_sha: 'gitlab-sha', check_run_id: null })
      );

      await POST(makeRequest({ status: 'completed' }), makeParams(REVIEW_ID));

      expect(mockSetCommitStatus).toHaveBeenCalledWith(
        'mock-token',
        'owner/repo',
        'gitlab-sha',
        'success',
        expect.objectContaining({
          targetUrl: `https://test.kilo.ai/code-reviews/${REVIEW_ID}`,
        }),
        'https://gitlab.com'
      );
    });

    it('sets GitLab commit status to failed for failed reviews', async () => {
      mockGetCodeReviewById.mockResolvedValue(
        makeReview({ platform: 'gitlab', head_sha: 'gitlab-sha', check_run_id: null })
      );

      await POST(
        makeRequest({ status: 'failed', errorMessage: 'Something broke' }),
        makeParams(REVIEW_ID)
      );

      expect(mockSetCommitStatus).toHaveBeenCalledWith(
        'mock-token',
        'owner/repo',
        'gitlab-sha',
        'failed',
        expect.objectContaining({
          targetUrl: `https://test.kilo.ai/code-reviews/${REVIEW_ID}`,
        }),
        'https://gitlab.com'
      );
    });
  });

  describe('error handling', () => {
    it('returns 401 for missing auth secret', async () => {
      const response = await POST(
        makeRequest({ status: 'completed' }, 'wrong-secret'),
        makeParams(REVIEW_ID)
      );

      expect(response.status).toBe(401);
    });

    it('returns 400 for invalid status', async () => {
      const response = await POST(
        makeRequest({ status: 'invalid_status' }),
        makeParams(REVIEW_ID)
      );

      expect(response.status).toBe(400);
    });

    it('returns 404 when review not found', async () => {
      mockGetCodeReviewById.mockResolvedValue(null);

      const response = await POST(
        makeRequest({ status: 'completed' }),
        makeParams(REVIEW_ID)
      );

      expect(response.status).toBe(404);
    });

    it('skips status update when review is already in terminal state', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview({ status: 'completed' }));

      const response = await POST(
        makeRequest({ status: 'failed', errorMessage: 'Late update' }),
        makeParams(REVIEW_ID)
      );

      expect(response.status).toBe(200);
      expect(mockUpdateCodeReviewStatus).not.toHaveBeenCalled();
    });
  });
});
