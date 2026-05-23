import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import type { NextRequest } from 'next/server';
import type * as codeReviewsDbModule from '@/lib/code-reviews/db/code-reviews';
import type * as platformIntegrationsModule from '@/lib/integrations/db/platform-integrations';
import type {
  CloudAgentCodeReview,
  CloudAgentCodeReviewAttempt,
  PlatformIntegration,
} from '@kilocode/db/schema';
import { deriveCallbackToken } from '@kilocode/worker-utils/callback-token';

// --- Mock functions ---

const mockGetCodeReviewById = jest.fn() as jest.MockedFunction<
  typeof codeReviewsDbModule.getCodeReviewById
>;
const mockUpdateCodeReviewStatus = jest.fn() as jest.MockedFunction<
  typeof codeReviewsDbModule.updateCodeReviewStatus
>;
const mockUpdateCodeReviewStatusIfNonTerminal = jest.fn() as jest.MockedFunction<
  typeof codeReviewsDbModule.updateCodeReviewStatusIfNonTerminal
>;
const mockUpdateCodeReviewUsage = jest.fn() as jest.MockedFunction<
  typeof codeReviewsDbModule.updateCodeReviewUsage
>;
const mockGetSessionUsageFromBilling = jest.fn() as jest.MockedFunction<
  typeof codeReviewsDbModule.getSessionUsageFromBilling
>;
const mockUpdateCodeReviewAttemptForCallback = jest.fn() as jest.MockedFunction<
  typeof codeReviewsDbModule.updateCodeReviewAttemptForCallback
>;
const mockGetLatestCodeReviewAttempt = jest.fn() as jest.MockedFunction<
  typeof codeReviewsDbModule.getLatestCodeReviewAttempt
>;
const mockCreateInfraRetryAttemptIfMissing = jest.fn() as jest.MockedFunction<
  typeof codeReviewsDbModule.createInfraRetryAttemptIfMissing
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAppendReviewSummaryFooter = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockRetryReviewFresh = jest.fn<any>();

// --- Module mocks ---

jest.mock('@/lib/config.server', () => ({
  CALLBACK_TOKEN_SECRET: 'test-callback-token-secret',
}));

jest.mock('@/lib/code-reviews/db/code-reviews', () => ({
  getCodeReviewById: mockGetCodeReviewById,
  updateCodeReviewStatus: mockUpdateCodeReviewStatus,
  updateCodeReviewStatusIfNonTerminal: mockUpdateCodeReviewStatusIfNonTerminal,
  updateCodeReviewUsage: mockUpdateCodeReviewUsage,
  getSessionUsageFromBilling: mockGetSessionUsageFromBilling,
  updateCodeReviewAttemptForCallback: mockUpdateCodeReviewAttemptForCallback,
  getLatestCodeReviewAttempt: mockGetLatestCodeReviewAttempt,
  createInfraRetryAttemptIfMissing: mockCreateInfraRetryAttemptIfMissing,
}));

jest.mock('@/lib/code-reviews/client/code-review-worker-client', () => ({
  codeReviewWorkerClient: {
    retryReviewFresh: mockRetryReviewFresh,
  },
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
  appendReviewSummaryFooter: (...args: unknown[]) => mockAppendReviewSummaryFooter(...args),
}));

jest.mock('@/lib/constants', () => ({
  APP_URL: 'https://test.kilo.ai',
}));

jest.mock('@/lib/integrations/core/constants', () => ({
  PLATFORM: { GITHUB: 'github', GITLAB: 'gitlab' },
}));

// --- Helpers ---

const CALLBACK_SECRET = 'test-callback-token-secret';
const REVIEW_ID = '00000000-0000-0000-0000-000000000001';
let defaultCallbackToken: string;

function makeRequest(
  body: Record<string, unknown>,
  options: {
    callbackToken?: string | null;
    attemptId?: string;
  } = {}
): NextRequest {
  const url = new URL(`https://test.kilo.ai/api/internal/code-review-status/${REVIEW_ID}`);
  if (options.attemptId) {
    url.searchParams.set('attemptId', options.attemptId);
  }

  return {
    nextUrl: url,
    headers: {
      get: (name: string) => {
        if (name === 'X-Callback-Token') {
          return options.callbackToken === undefined ? defaultCallbackToken : options.callbackToken;
        }
        return null;
      },
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
    dispatch_reservation_id: null,
    error_message: null,
    terminal_reason: null,
    agent_version: 'v2',
    check_run_id: 12345,
    repository_review_instructions_used: false,
    repository_review_instructions_ref: null,
    repository_review_instructions_truncated: false,
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

function makeAttempt(
  overrides: Partial<CloudAgentCodeReviewAttempt> = {}
): CloudAgentCodeReviewAttempt {
  return {
    id: '00000000-0000-0000-0000-000000000101',
    code_review_id: REVIEW_ID,
    attempt_number: 1,
    retry_of_attempt_id: null,
    retry_reason: null,
    session_id: null,
    cli_session_id: null,
    execution_id: null,
    status: 'running',
    error_message: null,
    terminal_reason: null,
    started_at: '2025-01-01T00:00:00Z',
    completed_at: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeIntegration(overrides: Partial<PlatformIntegration> = {}): PlatformIntegration {
  return {
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
    auth_invalid_at: null,
    auth_invalid_reason: null,
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
    ...overrides,
  };
}

// --- Tests ---

import type { POST as POSTType } from './route';

let POST: typeof POSTType;

beforeEach(async () => {
  jest.clearAllMocks();
  defaultCallbackToken = await deriveCallbackToken({
    secret: CALLBACK_SECRET,
    scope: 'code-review-status-callback',
    resourceParts: [REVIEW_ID, ''],
  });
  mockUpdateCodeReviewStatus.mockResolvedValue(undefined);
  mockUpdateCodeReviewAttemptForCallback.mockImplementation(async params =>
    makeAttempt({
      status: params.status,
      session_id: params.sessionId ?? null,
      cli_session_id: params.cliSessionId ?? null,
      execution_id: params.executionId ?? null,
      error_message: params.errorMessage ?? null,
      terminal_reason: params.terminalReason ?? null,
    })
  );
  mockGetLatestCodeReviewAttempt.mockResolvedValue(makeAttempt());
  mockCreateInfraRetryAttemptIfMissing.mockResolvedValue({
    outcome: 'existing-for-review',
    attempt: makeAttempt({
      id: '00000000-0000-0000-0000-000000000102',
      attempt_number: 2,
      retry_reason: 'infra_failure',
      status: 'pending',
    }),
  });
  mockRetryReviewFresh.mockResolvedValue({ success: true, reviewId: REVIEW_ID });
  mockTryDispatchPendingReviews.mockResolvedValue(undefined);
  mockGetBotUserId.mockResolvedValue(null);
  mockGetIntegrationById.mockResolvedValue(makeIntegration());
  mockUpdateCheckRun.mockResolvedValue(undefined);
  mockAddReactionToPR.mockResolvedValue(undefined);
  mockCreatePRComment.mockResolvedValue(undefined);
  mockHasPRCommentWithMarker.mockResolvedValue(false);
  mockCreateMRNote.mockResolvedValue(undefined);
  mockHasMRNoteWithMarker.mockResolvedValue(false);
  mockFindKiloReviewComment.mockResolvedValue({ commentId: 99, body: 'existing body' });
  mockUpdateKiloReviewComment.mockResolvedValue(undefined);
  mockFindKiloReviewNote.mockResolvedValue({ noteId: 88, body: 'existing note body' });
  mockUpdateKiloReviewNote.mockResolvedValue(undefined);
  mockGetSessionUsageFromBilling.mockResolvedValue(null);
  mockUpdateCodeReviewUsage.mockResolvedValue(undefined);
  mockUpdateCodeReviewStatusIfNonTerminal.mockResolvedValue(true);
  mockAppendReviewSummaryFooter.mockReturnValue('body with footer');
  ({ POST } = await import('./route'));
});

describe('POST /api/internal/code-review-status/[reviewId]', () => {
  describe('authentication', () => {
    it('returns 401 without callback token', async () => {
      const response = await POST(
        makeRequest({ status: 'completed' }, { callbackToken: null }),
        makeParams(REVIEW_ID)
      );

      expect(response.status).toBe(401);
    });

    it('accepts callback token scoped to review and attempt query', async () => {
      mockGetCodeReviewById.mockResolvedValue(null);
      const callbackToken = await deriveCallbackToken({
        secret: CALLBACK_SECRET,
        scope: 'code-review-status-callback',
        resourceParts: [REVIEW_ID, 'attempt-1'],
      });
      const response = await POST(
        makeRequest({ status: 'completed' }, { callbackToken, attemptId: 'attempt-1' }),
        makeParams(REVIEW_ID)
      );

      expect(response.status).toBe(404);
    });

    it('rejects callback token scoped to a different review', async () => {
      const callbackToken = await deriveCallbackToken({
        secret: CALLBACK_SECRET,
        scope: 'code-review-status-callback',
        resourceParts: ['different-review', 'attempt-1'],
      });
      const response = await POST(
        makeRequest({ status: 'completed' }, { callbackToken, attemptId: 'attempt-1' }),
        makeParams(REVIEW_ID)
      );

      expect(response.status).toBe(401);
    });

    it('rejects callback token scoped to a different attempt', async () => {
      const callbackToken = await deriveCallbackToken({
        secret: CALLBACK_SECRET,
        scope: 'code-review-status-callback',
        resourceParts: [REVIEW_ID, 'attempt-2'],
      });
      const response = await POST(
        makeRequest({ status: 'completed' }, { callbackToken, attemptId: 'attempt-1' }),
        makeParams(REVIEW_ID)
      );

      expect(response.status).toBe(401);
    });
  });

  describe('normalization', () => {
    it('maps interrupted status to cancelled with interrupted terminal reason', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());

      const response = await POST(
        makeRequest({ status: 'interrupted', errorMessage: 'User interrupted' }),
        makeParams(REVIEW_ID)
      );

      expect(response.status).toBe(200);
      expect(mockUpdateCodeReviewStatus).toHaveBeenCalledWith(
        REVIEW_ID,
        'cancelled',
        expect.objectContaining({
          errorMessage: 'User interrupted',
          terminalReason: 'interrupted',
        })
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

    it('keeps interrupted non-billing callbacks as cancelled', async () => {
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
          terminalReason: 'interrupted',
        })
      );
    });

    it('reclassifies failed model-not-found callbacks as cancelled while preserving the error message', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());
      mockFindKiloReviewComment.mockResolvedValue(null);

      const response = await POST(
        makeRequest({
          status: 'failed',
          errorMessage: 'Model not found: kilo/retired-model',
        }),
        makeParams(REVIEW_ID)
      );

      expect(response.status).toBe(200);
      expect(mockUpdateCodeReviewAttemptForCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'cancelled',
          errorMessage: 'Model not found: kilo/retired-model',
          terminalReason: 'model_not_found',
        })
      );
      expect(mockUpdateCodeReviewStatusIfNonTerminal).toHaveBeenCalledWith(
        REVIEW_ID,
        'cancelled',
        expect.objectContaining({
          errorMessage: 'Model not found: kilo/retired-model',
          terminalReason: 'model_not_found',
        })
      );
      expect(mockCreateInfraRetryAttemptIfMissing).not.toHaveBeenCalled();
      expect(mockRetryReviewFresh).not.toHaveBeenCalled();
    });

    it('recognizes model-not-found messages case-insensitively but not generic not-found messages', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());

      await POST(
        makeRequest({ status: 'failed', errorMessage: 'MODEL NOT FOUND: kilo/retired-model' }),
        makeParams(REVIEW_ID)
      );

      expect(mockUpdateCodeReviewStatusIfNonTerminal).toHaveBeenLastCalledWith(
        REVIEW_ID,
        'cancelled',
        expect.objectContaining({ terminalReason: 'model_not_found' })
      );

      jest.clearAllMocks();
      mockGetCodeReviewById.mockResolvedValue(makeReview());
      mockUpdateCodeReviewAttemptForCallback.mockImplementation(async params =>
        makeAttempt({
          status: params.status,
          error_message: params.errorMessage ?? null,
          terminal_reason: params.terminalReason ?? null,
        })
      );
      mockGetLatestCodeReviewAttempt.mockResolvedValue(makeAttempt());
      mockGetIntegrationById.mockResolvedValue(makeIntegration());

      await POST(
        makeRequest({ status: 'failed', errorMessage: 'Repository not found' }),
        makeParams(REVIEW_ID)
      );

      expect(mockUpdateCodeReviewStatus).toHaveBeenLastCalledWith(
        REVIEW_ID,
        'failed',
        expect.objectContaining({ terminalReason: undefined })
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

    it('accepts sandbox_error terminalReason', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());

      await POST(
        makeRequest({
          status: 'failed',
          errorMessage: 'Sandbox returned HTTP 500',
          terminalReason: 'sandbox_error',
        }),
        makeParams(REVIEW_ID)
      );

      expect(mockUpdateCodeReviewStatus).toHaveBeenCalledWith(
        REVIEW_ID,
        'failed',
        expect.objectContaining({ terminalReason: 'sandbox_error' })
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

  describe('attempt tracking and infra retry', () => {
    it('records running callbacks on the current attempt', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview({ status: 'queued' }));

      await POST(
        makeRequest({
          status: 'running',
          sessionId: 'agent-current',
          cliSessionId: 'ses_current',
        }),
        makeParams(REVIEW_ID)
      );

      expect(mockUpdateCodeReviewAttemptForCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          codeReviewId: REVIEW_ID,
          status: 'running',
          sessionId: 'agent-current',
          cliSessionId: 'ses_current',
        })
      );
      expect(mockUpdateCodeReviewStatus).toHaveBeenCalledWith(
        REVIEW_ID,
        'running',
        expect.objectContaining({
          sessionId: 'agent-current',
          cliSessionId: 'ses_current',
        })
      );
    });

    it('retries a first SIGTERM infra failure without marking parent terminal', async () => {
      mockGetCodeReviewById.mockResolvedValue(
        makeReview({ status: 'running', session_id: 'agent-old' })
      );
      mockUpdateCodeReviewAttemptForCallback.mockResolvedValue(
        makeAttempt({
          id: '00000000-0000-0000-0000-000000000201',
          status: 'failed',
          session_id: 'agent-old',
        })
      );
      mockGetLatestCodeReviewAttempt.mockResolvedValue(
        makeAttempt({
          id: '00000000-0000-0000-0000-000000000201',
          status: 'failed',
          session_id: 'agent-old',
        })
      );
      mockCreateInfraRetryAttemptIfMissing.mockResolvedValue({
        outcome: 'created',
        attempt: makeAttempt({
          id: '00000000-0000-0000-0000-000000000202',
          attempt_number: 2,
          retry_reason: 'infra_failure',
          retry_of_attempt_id: '00000000-0000-0000-0000-000000000201',
          status: 'pending',
        }),
      });

      const response = await POST(
        makeRequest({
          status: 'failed',
          cloudAgentSessionId: 'agent-old',
          errorMessage: 'Container shutdown: SIGTERM',
          terminalReason: 'sandbox_error',
        }),
        makeParams(REVIEW_ID)
      );

      expect(response.status).toBe(200);
      expect(mockCreateInfraRetryAttemptIfMissing).toHaveBeenCalledWith(
        expect.objectContaining({
          codeReviewId: REVIEW_ID,
          retryOfAttemptId: '00000000-0000-0000-0000-000000000201',
        })
      );
      expect(mockRetryReviewFresh).toHaveBeenCalledWith(REVIEW_ID, {
        sessionId: 'agent-old',
        reason: 'Container shutdown: SIGTERM',
        failedAttemptId: '00000000-0000-0000-0000-000000000201',
        retryAttemptId: '00000000-0000-0000-0000-000000000202',
      });
      expect(mockUpdateCodeReviewStatus).not.toHaveBeenCalled();
      expect(mockUpdateCheckRun).not.toHaveBeenCalled();
      expect(mockTryDispatchPendingReviews).not.toHaveBeenCalled();
    });

    it('does not retry when the parent review is already superseded', async () => {
      mockGetCodeReviewById.mockResolvedValue(
        makeReview({ status: 'cancelled', terminal_reason: 'superseded' })
      );
      mockUpdateCodeReviewAttemptForCallback.mockResolvedValue(
        makeAttempt({
          id: '00000000-0000-0000-0000-000000000211',
          status: 'failed',
          terminal_reason: 'sandbox_error',
        })
      );
      mockGetLatestCodeReviewAttempt.mockResolvedValue(
        makeAttempt({
          id: '00000000-0000-0000-0000-000000000211',
          status: 'failed',
          terminal_reason: 'sandbox_error',
        })
      );

      const response = await POST(
        makeRequest({
          status: 'failed',
          errorMessage: 'Container shutdown: SIGTERM',
          terminalReason: 'sandbox_error',
        }),
        makeParams(REVIEW_ID)
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        success: true,
        message: 'Review already in terminal state',
        currentStatus: 'cancelled',
        terminalReason: 'superseded',
      });
      expect(mockCreateInfraRetryAttemptIfMissing).not.toHaveBeenCalled();
      expect(mockRetryReviewFresh).not.toHaveBeenCalled();
      expect(mockUpdateCodeReviewStatus).not.toHaveBeenCalled();
    });

    it('does not start a fresh retry if the review becomes superseded before worker startup', async () => {
      mockGetCodeReviewById
        .mockResolvedValueOnce(makeReview({ status: 'running', session_id: 'agent-old' }))
        .mockResolvedValueOnce(makeReview({ status: 'running', session_id: 'agent-old' }))
        .mockResolvedValueOnce(makeReview({ status: 'cancelled', terminal_reason: 'superseded' }));
      mockUpdateCodeReviewAttemptForCallback
        .mockResolvedValueOnce(
          makeAttempt({
            id: '00000000-0000-0000-0000-000000000221',
            status: 'failed',
            session_id: 'agent-old',
          })
        )
        .mockResolvedValueOnce(
          makeAttempt({
            id: '00000000-0000-0000-0000-000000000222',
            attempt_number: 2,
            status: 'cancelled',
            terminal_reason: 'superseded',
          })
        );
      mockGetLatestCodeReviewAttempt.mockResolvedValue(
        makeAttempt({
          id: '00000000-0000-0000-0000-000000000221',
          status: 'failed',
          session_id: 'agent-old',
        })
      );
      mockCreateInfraRetryAttemptIfMissing.mockResolvedValue({
        outcome: 'created',
        attempt: makeAttempt({
          id: '00000000-0000-0000-0000-000000000222',
          attempt_number: 2,
          retry_reason: 'infra_failure',
          retry_of_attempt_id: '00000000-0000-0000-0000-000000000221',
          status: 'pending',
        }),
      });

      const response = await POST(
        makeRequest({
          status: 'failed',
          cloudAgentSessionId: 'agent-old',
          errorMessage: 'Container shutdown: SIGTERM',
          terminalReason: 'sandbox_error',
        }),
        makeParams(REVIEW_ID)
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        success: true,
        retried: false,
        skipped: 'superseded',
      });
      expect(mockRetryReviewFresh).not.toHaveBeenCalled();
      expect(mockUpdateCodeReviewAttemptForCallback).toHaveBeenLastCalledWith(
        expect.objectContaining({
          codeReviewId: REVIEW_ID,
          attemptId: '00000000-0000-0000-0000-000000000222',
          status: 'cancelled',
          terminalReason: 'superseded',
        })
      );
      expect(mockUpdateCodeReviewStatus).not.toHaveBeenCalled();
    });

    it('does not retry when retry creation is skipped because the review is inactive', async () => {
      mockGetCodeReviewById.mockResolvedValue(
        makeReview({ status: 'running', session_id: 'agent-old' })
      );
      mockUpdateCodeReviewAttemptForCallback.mockResolvedValue(
        makeAttempt({
          id: '00000000-0000-0000-0000-000000000231',
          status: 'failed',
          session_id: 'agent-old',
        })
      );
      mockGetLatestCodeReviewAttempt.mockResolvedValue(
        makeAttempt({
          id: '00000000-0000-0000-0000-000000000231',
          status: 'failed',
          session_id: 'agent-old',
        })
      );
      mockCreateInfraRetryAttemptIfMissing.mockResolvedValue({
        outcome: 'skipped-inactive',
        reviewStatus: 'cancelled',
        terminalReason: 'superseded',
      });

      const response = await POST(
        makeRequest({
          status: 'failed',
          cloudAgentSessionId: 'agent-old',
          errorMessage: 'Container shutdown: SIGTERM',
          terminalReason: 'sandbox_error',
        }),
        makeParams(REVIEW_ID)
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        success: true,
        retried: false,
        skipped: 'inactive',
      });
      expect(mockRetryReviewFresh).not.toHaveBeenCalled();
      expect(mockUpdateCodeReviewStatus).not.toHaveBeenCalled();
    });

    it('does not retry maximum runtime failures', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview({ status: 'running' }));

      await POST(
        makeRequest({
          status: 'failed',
          errorMessage: 'Execution exceeded maximum runtime',
          terminalReason: 'timeout',
        }),
        makeParams(REVIEW_ID)
      );

      expect(mockRetryReviewFresh).not.toHaveBeenCalled();
      expect(mockUpdateCodeReviewStatus).toHaveBeenCalledWith(
        REVIEW_ID,
        'failed',
        expect.objectContaining({ terminalReason: 'timeout' })
      );
    });

    it('updates stale attempt callbacks without changing the parent review', async () => {
      mockGetCodeReviewById.mockResolvedValue(
        makeReview({ status: 'running', session_id: 'agent-new' })
      );
      mockUpdateCodeReviewAttemptForCallback.mockResolvedValue(
        makeAttempt({
          id: '00000000-0000-0000-0000-000000000301',
          status: 'failed',
          session_id: 'agent-old',
        })
      );
      mockGetLatestCodeReviewAttempt.mockResolvedValue(
        makeAttempt({
          id: '00000000-0000-0000-0000-000000000302',
          attempt_number: 2,
          status: 'running',
          session_id: 'agent-new',
        })
      );

      const response = await POST(
        makeRequest({
          status: 'failed',
          cloudAgentSessionId: 'agent-old',
          errorMessage: 'Container shutdown: SIGTERM',
        }),
        makeParams(REVIEW_ID)
      );

      expect(response.status).toBe(200);
      expect(mockUpdateCodeReviewAttemptForCallback).toHaveBeenCalled();
      expect(mockUpdateCodeReviewStatus).not.toHaveBeenCalled();
      expect(mockRetryReviewFresh).not.toHaveBeenCalled();
    });

    it('ignores duplicate failed callbacks after a fresh retry was already queued', async () => {
      mockGetCodeReviewById.mockResolvedValue(
        makeReview({ status: 'running', session_id: 'agent-old' })
      );
      mockUpdateCodeReviewAttemptForCallback.mockResolvedValue(
        makeAttempt({
          id: '00000000-0000-0000-0000-000000000401',
          status: 'failed',
          session_id: 'agent-old',
        })
      );
      mockGetLatestCodeReviewAttempt.mockResolvedValue(
        makeAttempt({
          id: '00000000-0000-0000-0000-000000000401',
          status: 'failed',
          session_id: 'agent-old',
        })
      );
      mockCreateInfraRetryAttemptIfMissing.mockResolvedValue({
        outcome: 'existing-for-attempt',
        attempt: makeAttempt({
          id: '00000000-0000-0000-0000-000000000402',
          attempt_number: 2,
          retry_reason: 'infra_failure',
          retry_of_attempt_id: '00000000-0000-0000-0000-000000000401',
          status: 'pending',
        }),
      });

      const response = await POST(
        makeRequest({
          status: 'failed',
          cloudAgentSessionId: 'agent-old',
          errorMessage: 'Container shutdown: SIGTERM',
          terminalReason: 'sandbox_error',
        }),
        makeParams(REVIEW_ID)
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ success: true, retried: true });
      expect(mockRetryReviewFresh).not.toHaveBeenCalled();
      expect(mockUpdateCodeReviewStatus).not.toHaveBeenCalled();
    });

    it('marks the retry attempt failed when retry startup fails', async () => {
      mockGetCodeReviewById.mockResolvedValue(
        makeReview({ status: 'running', session_id: 'agent-old' })
      );
      mockUpdateCodeReviewAttemptForCallback
        .mockResolvedValueOnce(
          makeAttempt({
            id: '00000000-0000-0000-0000-000000000501',
            status: 'failed',
            session_id: 'agent-old',
          })
        )
        .mockResolvedValueOnce(
          makeAttempt({
            id: '00000000-0000-0000-0000-000000000502',
            attempt_number: 2,
            status: 'failed',
          })
        );
      mockGetLatestCodeReviewAttempt.mockResolvedValue(
        makeAttempt({
          id: '00000000-0000-0000-0000-000000000501',
          status: 'failed',
          session_id: 'agent-old',
        })
      );
      mockCreateInfraRetryAttemptIfMissing.mockResolvedValue({
        outcome: 'created',
        attempt: makeAttempt({
          id: '00000000-0000-0000-0000-000000000502',
          attempt_number: 2,
          retry_reason: 'infra_failure',
          retry_of_attempt_id: '00000000-0000-0000-0000-000000000501',
          status: 'pending',
        }),
      });
      mockRetryReviewFresh.mockRejectedValue(new Error('worker retry failed'));

      await POST(
        makeRequest({
          status: 'failed',
          cloudAgentSessionId: 'agent-old',
          errorMessage: 'Container shutdown: SIGTERM',
          terminalReason: 'sandbox_error',
        }),
        makeParams(REVIEW_ID)
      );

      expect(mockUpdateCodeReviewAttemptForCallback).toHaveBeenLastCalledWith(
        expect.objectContaining({
          codeReviewId: REVIEW_ID,
          attemptId: '00000000-0000-0000-0000-000000000502',
          status: 'failed',
        })
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
        }),
        'standard'
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
        }),
        'standard'
      );
    });

    it('passes the integration GitHub app type to check run updates', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());
      mockGetIntegrationById.mockResolvedValue(makeIntegration({ github_app_type: 'lite' }));

      await POST(makeRequest({ status: 'running' }), makeParams(REVIEW_ID));

      expect(mockUpdateCheckRun).toHaveBeenCalledWith(
        'inst-1',
        'owner',
        'repo',
        12345,
        expect.objectContaining({
          status: 'in_progress',
          conclusion: undefined,
        }),
        'lite'
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
        }),
        'standard'
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
        '<!-- kilo-billing-notice -->',
        'standard'
      );
      expect(mockCreatePRComment).toHaveBeenCalledWith(
        'inst-1',
        'owner',
        'repo',
        1,
        expect.stringContaining('your account is out of credits'),
        'standard'
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
        expect.stringContaining('https://app.kilo.ai/'),
        'standard'
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
        expect.stringContaining('switch to a free model'),
        'standard'
      );
    });
  });

  describe('model-not-found provider output', () => {
    it('updates GitHub check runs with actionable cancelled copy', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());
      mockFindKiloReviewComment.mockResolvedValue(null);

      await POST(
        makeRequest({ status: 'failed', errorMessage: 'Model not found: kilo/retired-model' }),
        makeParams(REVIEW_ID)
      );

      expect(mockUpdateCheckRun).toHaveBeenCalledWith(
        'inst-1',
        'owner',
        'repo',
        12345,
        expect.objectContaining({
          status: 'completed',
          conclusion: 'cancelled',
          output: expect.objectContaining({
            title: 'Selected model is no longer available',
            summary: expect.stringContaining('https://app.kilo.ai/code-reviews'),
          }),
        }),
        'standard'
      );
    });

    it('updates GitLab commit status with actionable cancelled copy', async () => {
      mockGetCodeReviewById.mockResolvedValue(
        makeReview({ platform: 'gitlab', platform_project_id: 42, check_run_id: null })
      );
      mockFindKiloReviewNote.mockResolvedValue(null);

      await POST(
        makeRequest({ status: 'failed', errorMessage: 'Model not found: kilo/retired-model' }),
        makeParams(REVIEW_ID)
      );

      expect(mockSetCommitStatus).toHaveBeenCalledWith(
        'mock-token',
        42,
        'abc123',
        'canceled',
        expect.objectContaining({
          description: expect.stringContaining('https://app.kilo.ai/code-reviews'),
        }),
        'https://gitlab.com'
      );
    });

    it('creates the canonical GitHub summary when absent', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());
      mockFindKiloReviewComment.mockResolvedValue(null);

      await POST(
        makeRequest({ status: 'failed', errorMessage: 'Model not found: kilo/retired-model' }),
        makeParams(REVIEW_ID)
      );

      expect(mockFindKiloReviewComment).toHaveBeenCalledWith(
        'inst-1',
        'owner',
        'repo',
        1,
        'standard'
      );
      expect(mockCreatePRComment).toHaveBeenCalledWith(
        'inst-1',
        'owner',
        'repo',
        1,
        expect.stringContaining('<!-- kilo-review -->'),
        'standard'
      );
      expect(mockCreatePRComment).toHaveBeenCalledWith(
        'inst-1',
        'owner',
        'repo',
        1,
        expect.stringContaining('https://app.kilo.ai/code-reviews'),
        'standard'
      );
      expect(mockHasPRCommentWithMarker).not.toHaveBeenCalled();
    });

    it('updates the canonical GitHub summary when present', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());
      mockFindKiloReviewComment.mockResolvedValue({ commentId: 123, body: 'old summary' });

      await POST(
        makeRequest({ status: 'failed', errorMessage: 'Model not found: kilo/retired-model' }),
        makeParams(REVIEW_ID)
      );

      expect(mockUpdateKiloReviewComment).toHaveBeenCalledWith(
        'inst-1',
        'owner',
        'repo',
        123,
        expect.stringContaining('selected model is no longer available'),
        'standard'
      );
      expect(mockCreatePRComment).not.toHaveBeenCalled();
    });

    it('persists the cancellation if the model-unavailable summary fails to publish', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());
      mockFindKiloReviewComment.mockResolvedValue(null);
      mockCreatePRComment.mockRejectedValue(new Error('GitHub unavailable'));

      const response = await POST(
        makeRequest({ status: 'failed', errorMessage: 'Model not found: kilo/retired-model' }),
        makeParams(REVIEW_ID)
      );

      expect(response.status).toBe(200);
      expect(mockUpdateCodeReviewStatusIfNonTerminal).toHaveBeenCalledWith(
        REVIEW_ID,
        'cancelled',
        expect.objectContaining({ terminalReason: 'model_not_found' })
      );
      expect(mockCaptureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: { source: 'code-review-status-model-not-found-summary' },
        })
      );
    });

    it('creates and updates the canonical GitLab note through the same summary path', async () => {
      mockGetCodeReviewById.mockResolvedValue(
        makeReview({ platform: 'gitlab', platform_project_id: 42, check_run_id: null })
      );
      mockFindKiloReviewNote.mockResolvedValue(null);

      await POST(
        makeRequest({ status: 'failed', errorMessage: 'Model not found: kilo/retired-model' }),
        makeParams(REVIEW_ID)
      );

      expect(mockCreateMRNote).toHaveBeenCalledWith(
        'mock-token',
        'owner/repo',
        1,
        expect.stringContaining('<!-- kilo-review -->'),
        'https://gitlab.com'
      );

      jest.clearAllMocks();
      mockUpdateCodeReviewStatusIfNonTerminal.mockResolvedValue(true);
      mockGetCodeReviewById.mockResolvedValue(
        makeReview({ platform: 'gitlab', platform_project_id: 42, check_run_id: null })
      );
      mockGetLatestCodeReviewAttempt.mockResolvedValue(makeAttempt());
      mockGetIntegrationById.mockResolvedValue(makeIntegration());
      mockFindKiloReviewNote.mockResolvedValue({ noteId: 321, body: 'old summary' });

      await POST(
        makeRequest({ status: 'failed', errorMessage: 'Model not found: kilo/retired-model' }),
        makeParams(REVIEW_ID)
      );

      expect(mockUpdateKiloReviewNote).toHaveBeenCalledWith(
        'mock-token',
        'owner/repo',
        1,
        321,
        expect.stringContaining('https://app.kilo.ai/code-reviews'),
        'https://gitlab.com'
      );
      expect(mockCreateMRNote).not.toHaveBeenCalled();
    });

    it('claims the terminal update before publishing a model-unavailable summary', async () => {
      const callOrder: string[] = [];
      mockGetCodeReviewById.mockResolvedValue(makeReview());
      mockUpdateCodeReviewStatusIfNonTerminal.mockImplementation(async () => {
        callOrder.push('update-parent');
        return true;
      });
      mockFindKiloReviewComment.mockImplementation(async () => {
        callOrder.push('find-summary');
        return null;
      });
      mockCreatePRComment.mockImplementation(async () => {
        callOrder.push('create-summary');
      });

      await POST(
        makeRequest({ status: 'failed', errorMessage: 'Model not found: kilo/retired-model' }),
        makeParams(REVIEW_ID)
      );

      expect(callOrder).toEqual(['update-parent', 'find-summary', 'create-summary']);
    });

    it('does not publish a duplicate summary if another callback claimed cancellation', async () => {
      mockGetCodeReviewById.mockResolvedValue(makeReview());
      mockUpdateCodeReviewStatusIfNonTerminal.mockResolvedValue(false);

      const response = await POST(
        makeRequest({ status: 'failed', errorMessage: 'Model not found: kilo/retired-model' }),
        makeParams(REVIEW_ID)
      );

      expect(response.status).toBe(200);
      expect(mockFindKiloReviewComment).not.toHaveBeenCalled();
      expect(mockCreatePRComment).not.toHaveBeenCalled();
      expect(mockUpdateCodeReviewStatus).not.toHaveBeenCalled();
    });
  });

  describe('summary footer guidance', () => {
    it('updates completed GitHub summary with REVIEW.md guidance metadata when used', async () => {
      const review = makeReview({
        repository_review_instructions_used: true,
        repository_review_instructions_ref: 'main',
        repository_review_instructions_truncated: false,
        model: 'anthropic/claude-sonnet-4.6',
        total_tokens_in: 1000,
        total_tokens_out: 200,
      });
      mockGetCodeReviewById.mockResolvedValue(review);

      await POST(makeRequest({ status: 'completed' }), makeParams(REVIEW_ID));

      expect(mockFindKiloReviewComment).toHaveBeenCalledWith(
        'inst-1',
        'owner',
        'repo',
        1,
        'standard'
      );
      expect(mockAppendReviewSummaryFooter).toHaveBeenCalledWith('existing body', {
        usage: { model: 'anthropic/claude-sonnet-4.6', tokensIn: 1000, tokensOut: 200 },
        reviewGuidance: { used: true, ref: 'main', truncated: false },
      });
      expect(mockUpdateKiloReviewComment).toHaveBeenCalledWith(
        'inst-1',
        'owner',
        'repo',
        99,
        'body with footer',
        'standard'
      );
    });

    it('updates completed GitLab summary with REVIEW.md guidance metadata when used', async () => {
      const review = makeReview({
        platform: 'gitlab',
        platform_project_id: 42,
        check_run_id: null,
        repository_review_instructions_used: true,
        repository_review_instructions_ref: 'main',
        repository_review_instructions_truncated: true,
        model: 'anthropic/claude-sonnet-4.6',
        total_tokens_in: 1000,
        total_tokens_out: 200,
      });
      mockGetCodeReviewById.mockResolvedValue(review);

      await POST(makeRequest({ status: 'completed' }), makeParams(REVIEW_ID));

      expect(mockFindKiloReviewNote).toHaveBeenCalledWith(
        'mock-token',
        'owner/repo',
        1,
        'https://gitlab.com'
      );
      expect(mockAppendReviewSummaryFooter).toHaveBeenCalledWith('existing note body', {
        usage: { model: 'anthropic/claude-sonnet-4.6', tokensIn: 1000, tokensOut: 200 },
        reviewGuidance: { used: true, ref: 'main', truncated: true },
      });
      expect(mockUpdateKiloReviewNote).toHaveBeenCalledWith(
        'mock-token',
        'owner/repo',
        1,
        88,
        'body with footer',
        'https://gitlab.com'
      );
    });

    it('updates guidance footer when usage data is unavailable', async () => {
      const review = makeReview({
        repository_review_instructions_used: true,
        repository_review_instructions_ref: 'main',
        repository_review_instructions_truncated: false,
        model: null,
        total_tokens_in: null,
        total_tokens_out: null,
      });
      mockGetCodeReviewById.mockResolvedValue(review);

      await POST(makeRequest({ status: 'completed' }), makeParams(REVIEW_ID));

      expect(mockAppendReviewSummaryFooter).toHaveBeenCalledWith('existing body', {
        usage: undefined,
        reviewGuidance: { used: true, ref: 'main', truncated: false },
      });
      expect(mockUpdateKiloReviewComment).toHaveBeenCalled();
    });

    it('does not append guidance when metadata says unused', async () => {
      const review = makeReview({
        repository_review_instructions_used: false,
        repository_review_instructions_ref: null,
        repository_review_instructions_truncated: false,
        model: null,
        total_tokens_in: null,
        total_tokens_out: null,
      });
      mockGetCodeReviewById.mockResolvedValue(review);

      await POST(makeRequest({ status: 'completed' }), makeParams(REVIEW_ID));

      expect(mockAppendReviewSummaryFooter).not.toHaveBeenCalled();
      expect(mockUpdateKiloReviewComment).not.toHaveBeenCalled();
    });
  });
});
