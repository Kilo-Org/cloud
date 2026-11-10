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

jest.mock('@/lib/agent-config/db/agent-configs', () => ({
  getAgentConfigForOwner: jest.fn(),
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  createCheckRun: jest.fn(),
  updateCheckRun: jest.fn(),
}));

jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  setCommitStatus: jest.fn(),
}));

jest.mock('@/lib/integrations/gitlab-service', () => ({
  getValidGitLabProjectAccessToken: jest.fn(),
  getValidGitLabToken: jest.fn(),
}));

import type { CloudAgentCodeReview } from '@kilocode/db/schema';
import { getAgentConfigForOwner, type AgentConfigRow } from '@/lib/agent-config/db/agent-configs';
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
import {
  getValidGitLabProjectAccessToken,
  getValidGitLabToken,
} from '@/lib/integrations/gitlab-service';
import { createCheckRun, updateCheckRun } from '@/lib/integrations/platforms/github/adapter';
import { setCommitStatus } from '@/lib/integrations/platforms/gitlab/adapter';
import {
  AUTOMATIC_RETRY_ATTEMPT_LIMIT,
  isAutomaticallyRetryableFailure,
  isAutomaticallyRetryableReview,
  retryFailedCodeReview,
} from './retry-review';

const mockedGetAgentConfig = jest.mocked(getAgentConfigForOwner);

const mockedEnsureAttempt = jest.mocked(ensureCurrentCodeReviewAttemptFromReview);
const mockedReset = jest.mocked(resetCodeReviewForRetry);
const mockedCreateAttempt = jest.mocked(createCodeReviewAttempt);
const mockedGetReview = jest.mocked(getCodeReviewById);
const mockedUpdateCheckRunId = jest.mocked(updateCheckRunId);
const mockedDispatch = jest.mocked(tryDispatchPendingReviews);
const mockedGetIntegration = jest.mocked(getIntegrationById);
const mockedCreateCheckRun = jest.mocked(createCheckRun);
const mockedUpdateCheckRun = jest.mocked(updateCheckRun);
const mockedSetCommitStatus = jest.mocked(setCommitStatus);
const mockedGitLabProjectToken = jest.mocked(getValidGitLabProjectAccessToken);
const mockedGitLabToken = jest.mocked(getValidGitLabToken);

const OWNER: Owner = { type: 'user', id: 'user-1', userId: 'user-1' };

function makeAgentConfig(overrides: Partial<AgentConfigRow> = {}): AgentConfigRow {
  return {
    id: 'config-1',
    owned_by_organization_id: null,
    owned_by_user_id: 'user-1',
    agent_type: 'code_review',
    platform: 'github',
    config: {},
    is_enabled: true,
    runtime_state: {},
    created_by: 'user-1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    config_revision: 1,
    ...overrides,
  };
}

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
  mockedSetCommitStatus.mockResolvedValue(undefined);
  mockedGitLabProjectToken.mockResolvedValue('project-token');
  mockedGitLabToken.mockResolvedValue('group-token');
  mockedGetAgentConfig.mockResolvedValue({
    id: 'config-1',
    config: {},
    is_enabled: true,
    runtime_state: {},
  } as never);
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

describe('isAutomaticallyRetryableFailure', () => {
  it.each([
    ['assistant_timeout', 'failed', true],
    ['workspace_capacity', 'failed', true],
    ['billing', 'failed', false],
    [null, 'failed', false],
    ['assistant_timeout', 'cancelled', false],
    ['assistant_timeout', 'queued', false],
  ])('reason %s and status %s answers %s', (reason, status, expected) => {
    expect(
      isAutomaticallyRetryableFailure({
        status,
        terminal_reason: reason,
      } as Pick<CloudAgentCodeReview, 'status' | 'terminal_reason'>)
    ).toBe(expected);
  });
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

  it('closes the recreated check run when dispatch fails the new attempt', async () => {
    mockedGetReview.mockResolvedValue(
      makeReview({
        status: 'failed',
        terminal_reason: 'assistant_timeout',
        check_run_id: 990,
        error_message: 'worker refused the job',
      })
    );

    const result = await retryFailedCodeReview({
      review: makeReview(),
      owner: OWNER,
      retryReason: 'automatic_recovery',
    });

    expect(result).toEqual({ outcome: 'still_failed', errorMessage: 'worker refused the job' });
    expect(mockedUpdateCheckRun).toHaveBeenCalledWith(
      '123456',
      'acme',
      'widgets',
      990,
      expect.objectContaining({ status: 'completed', conclusion: 'failure' }),
      'standard'
    );
  });

  it('closes the check run as action_required for a manual review that needs configuration', async () => {
    mockedGetReview.mockResolvedValue(
      makeReview({
        status: 'failed',
        terminal_reason: 'byok_invalid_key',
        check_run_id: 990,
        manual_config: {
          agentConfig: { review_style: 'balanced', focus_areas: [], model_slug: 'kilo/test' },
          instructions: null,
          outputMode: 'provider',
        },
      })
    );

    const result = await retryFailedCodeReview({
      review: makeReview(),
      owner: OWNER,
      retryReason: 'manual_retrigger',
    });

    expect(result).toEqual({ outcome: 'still_failed', errorMessage: undefined });
    expect(mockedUpdateCheckRun).toHaveBeenCalledWith(
      '123456',
      'acme',
      'widgets',
      990,
      expect.objectContaining({ status: 'completed', conclusion: 'action_required' }),
      'standard'
    );
  });

  it('leaves an action-required check run on GitHub to the dispatch path', async () => {
    mockedGetReview.mockResolvedValue(
      makeReview({
        status: 'failed',
        terminal_reason: 'byok_invalid_key',
        check_run_id: 990,
      })
    );

    const result = await retryFailedCodeReview({
      review: makeReview(),
      owner: OWNER,
      retryReason: 'automatic_recovery',
    });

    expect(result).toEqual({ outcome: 'still_failed', errorMessage: undefined });
    expect(mockedUpdateCheckRun).not.toHaveBeenCalled();
  });

  it('closes the commit status of a GitLab review that did not start', async () => {
    mockedGetReview.mockResolvedValue(
      makeReview({ status: 'failed', platform: 'gitlab', platform_project_id: 42 })
    );

    const result = await retryFailedCodeReview({
      review: makeReview({ platform: 'gitlab', platform_project_id: 42 }),
      owner: OWNER,
      retryReason: 'automatic_recovery',
    });

    expect(result).toEqual({ outcome: 'still_failed', errorMessage: undefined });
    expect(mockedSetCommitStatus).toHaveBeenLastCalledWith(
      'project-token',
      42,
      'abc123',
      'failed',
      expect.objectContaining({ description: expect.any(String) }),
      'https://gitlab.com'
    );
  });

  it('leaves the check run of a refused billing failure to its own path', async () => {
    mockedGetReview.mockResolvedValue(
      makeReview({
        status: 'failed',
        terminal_reason: 'billing',
        check_run_id: 990,
        error_message: null,
      })
    );

    const result = await retryFailedCodeReview({
      review: makeReview(),
      owner: OWNER,
      retryReason: 'automatic_recovery',
    });

    expect(result).toEqual({ outcome: 'still_failed', errorMessage: null });
    expect(mockedUpdateCheckRun).not.toHaveBeenCalled();
  });

  it('answers refused for a reviewer the owner switched off', async () => {
    mockedGetAgentConfig.mockResolvedValue({ is_enabled: false, config: {} } as never);

    const result = await retryFailedCodeReview({
      review: makeReview(),
      owner: OWNER,
      retryReason: 'automatic_recovery',
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'reviewer_disabled' });
    expect(mockedReset).not.toHaveBeenCalled();
    expect(mockedDispatch).not.toHaveBeenCalled();
  });

  it('refuses from the configuration row its caller already read', async () => {
    const result = await retryFailedCodeReview({
      review: makeReview(),
      owner: OWNER,
      retryReason: 'automatic_recovery',
      agentConfig: makeAgentConfig({ is_enabled: false }),
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'reviewer_disabled' });
    expect(mockedGetAgentConfig).not.toHaveBeenCalled();
  });

  it('answers refused for a reviewer whose configuration needs attention', async () => {
    mockedGetAgentConfig.mockResolvedValue({
      is_enabled: true,
      config: {},
      runtime_state: {
        code_review_action_required: {
          reason: 'byok_invalid_key',
          detectedAt: '2026-01-01T00:00:00.000Z',
          lastSeenAt: '2026-01-01T00:00:00.000Z',
          lastErrorMessage: 'invalid key',
        },
      },
    } as never);

    const result = await retryFailedCodeReview({
      review: makeReview(),
      owner: OWNER,
      retryReason: 'automatic_recovery',
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'action_required' });
    expect(mockedDispatch).not.toHaveBeenCalled();
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
