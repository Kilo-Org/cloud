jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  logExceptInTest: jest.fn(),
}));

jest.mock('@/lib/code-reviews/db/code-reviews', () => ({
  ensureCurrentCodeReviewAttemptFromReview: jest.fn(),
  resetCodeReviewForRetry: jest.fn(),
  createCodeReviewAttempt: jest.fn(),
  getCodeReviewById: jest.fn(),
  updateCheckRunId: jest.fn(),
}));

jest.mock('@/lib/code-reviews/dispatch/dispatch-pending-reviews', () => ({
  tryDispatchPendingReviews: jest.fn(),
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationById: jest.fn(),
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  createCheckRun: jest.fn(),
  updateCheckRun: jest.fn(),
}));

import type { CloudAgentCodeReview } from '@kilocode/db/schema';
import type { Owner } from '@/lib/code-reviews/core';
import {
  createCodeReviewAttempt,
  ensureCurrentCodeReviewAttemptFromReview,
  getCodeReviewById,
  resetCodeReviewForRetry,
  updateCheckRunId,
} from '@/lib/code-reviews/db/code-reviews';
import { tryDispatchPendingReviews } from '@/lib/code-reviews/dispatch/dispatch-pending-reviews';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import { createCheckRun } from '@/lib/integrations/platforms/github/adapter';
import {
  AUTOMATIC_RETRY_ATTEMPT_LIMIT,
  isAutomaticallyRetryableReview,
  retryFailedCodeReview,
} from './retry-review';

const mockedEnsureAttempt = jest.mocked(ensureCurrentCodeReviewAttemptFromReview);
const mockedReset = jest.mocked(resetCodeReviewForRetry);
const mockedCreateAttempt = jest.mocked(createCodeReviewAttempt);
const mockedGetReview = jest.mocked(getCodeReviewById);
const mockedUpdateCheckRunId = jest.mocked(updateCheckRunId);
const mockedDispatch = jest.mocked(tryDispatchPendingReviews);
const mockedGetIntegration = jest.mocked(getIntegrationById);
const mockedCreateCheckRun = jest.mocked(createCheckRun);

const OWNER: Owner = { type: 'user', id: 'user-1', userId: 'user-1' };

function makeReview(overrides: Partial<CloudAgentCodeReview> = {}): CloudAgentCodeReview {
  return {
    id: 'review-1',
    platform: 'github',
    repo_full_name: 'acme/widgets',
    pr_number: 7,
    head_sha: 'abc123',
    platform_integration_id: 'integration-1',
    platform_project_id: null,
    status: 'failed',
    terminal_reason: 'assistant_timeout',
    manual_config: null,
    check_run_id: null,
    ...overrides,
  } as CloudAgentCodeReview;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedEnsureAttempt.mockResolvedValue({ id: 'attempt-1' } as never);
  mockedReset.mockResolvedValue(1);
  mockedCreateAttempt.mockResolvedValue({ id: 'attempt-2' } as never);
  mockedGetReview.mockResolvedValue(makeReview({ status: 'queued' }));
  mockedUpdateCheckRunId.mockResolvedValue(undefined);
  mockedDispatch.mockResolvedValue({} as never);
  mockedGetIntegration.mockResolvedValue({
    id: 'integration-1',
    platform_installation_id: '123456',
    github_app_type: 'standard',
    metadata: null,
  } as never);
  mockedCreateCheckRun.mockResolvedValue(990);
});

describe('isAutomaticallyRetryableReview', () => {
  it.each([
    ['assistant_timeout', 'failed', 1, true],
    ['timeout', 'failed', 1, true],
    ['workspace_capacity', 'failed', 2, true],
    ['billing', 'failed', 1, false],
    ['account_blocked', 'failed', 1, false],
    ['user_cancelled', 'failed', 1, false],
    ['assistant_content_filter', 'failed', 1, false],
    [null, 'failed', 1, false],
    ['assistant_timeout', 'cancelled', 1, false],
    ['assistant_timeout', 'completed', 1, false],
    ['assistant_timeout', 'failed', AUTOMATIC_RETRY_ATTEMPT_LIMIT, false],
  ])(
    'reason %s and status %s with %s attempts answers %s',
    (reason, status, attempts, expected) => {
      expect(
        isAutomaticallyRetryableReview(
          { status, terminal_reason: reason } as Pick<
            CloudAgentCodeReview,
            'status' | 'terminal_reason'
          >,
          attempts as number
        )
      ).toBe(expected);
    }
  );
});

describe('retryFailedCodeReview', () => {
  it('resets the review, records the attempt, recreates the gate and dispatches', async () => {
    const review = makeReview();

    const result = await retryFailedCodeReview({
      review,
      owner: OWNER,
      retryReason: 'automatic_recovery',
    });

    expect(result).toEqual({ outcome: 'retried' });
    expect(mockedReset).toHaveBeenCalledWith('review-1');
    expect(mockedCreateAttempt).toHaveBeenCalledWith({
      codeReviewId: 'review-1',
      retryOfAttemptId: 'attempt-1',
      retryReason: 'automatic_recovery',
      status: 'pending',
    });
    expect(mockedCreateCheckRun).toHaveBeenCalledWith(
      '123456',
      'acme',
      'widgets',
      'abc123',
      expect.objectContaining({
        output: expect.objectContaining({ title: 'Kilo Code Review queued' }),
      }),
      'standard'
    );
    expect(mockedUpdateCheckRunId).toHaveBeenCalledWith('review-1', 990);
    expect(mockedDispatch).toHaveBeenCalledWith(OWNER);
  });

  it('answers already_in_flight without recording or dispatching when the reset matches no row', async () => {
    mockedReset.mockResolvedValue(0);

    const result = await retryFailedCodeReview({
      review: makeReview(),
      owner: OWNER,
      retryReason: 'manual_retrigger',
    });

    expect(result).toEqual({ outcome: 'already_in_flight' });
    expect(mockedCreateAttempt).not.toHaveBeenCalled();
    expect(mockedDispatch).not.toHaveBeenCalled();
  });

  it('reports the stored failure when dispatch fails the new attempt again', async () => {
    mockedGetReview.mockResolvedValue(
      makeReview({ status: 'failed', error_message: 'worker refused the job' })
    );

    const result = await retryFailedCodeReview({
      review: makeReview(),
      owner: OWNER,
      retryReason: 'automatic_recovery',
    });

    expect(result).toEqual({ outcome: 'still_failed', errorMessage: 'worker refused the job' });
    expect(mockedDispatch).toHaveBeenCalled();
  });

  it('still retries when the gate check cannot be recreated', async () => {
    mockedCreateCheckRun.mockRejectedValue(new Error('github unavailable'));

    const result = await retryFailedCodeReview({
      review: makeReview(),
      owner: OWNER,
      retryReason: 'automatic_recovery',
    });

    expect(result).toEqual({ outcome: 'retried' });
    expect(mockedDispatch).toHaveBeenCalledWith(OWNER);
  });

  it('skips the gate check when the review has no integration to publish into', async () => {
    const result = await retryFailedCodeReview({
      review: makeReview({ platform_integration_id: null }),
      owner: OWNER,
      retryReason: 'automatic_recovery',
    });

    expect(result).toEqual({ outcome: 'retried' });
    expect(mockedGetIntegration).not.toHaveBeenCalled();
    expect(mockedCreateCheckRun).not.toHaveBeenCalled();
  });
});
