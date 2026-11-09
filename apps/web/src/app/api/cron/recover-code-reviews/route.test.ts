jest.mock('@kilocode/web-shared/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));

jest.mock('@kilocode/worker-utils/scheduled-job-observability', () => ({
  createScheduledJobRun: jest.fn(() => ({ runId: 'run-id' })),
  buildScheduledJobSuccessEvent: jest.fn((run: unknown, data: Record<string, unknown>) => ({
    run,
    data,
    kind: 'success',
  })),
  buildScheduledJobFailureEvent: jest.fn((run: unknown, error: unknown) => ({
    run,
    error,
    kind: 'failure',
  })),
  emitScheduledJobEvent: jest.fn(),
}));

const mockRecoverMissedReviews = jest.fn();

const mockSentryLogger = jest.fn();

jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  sentryLogger: () => mockSentryLogger,
}));

jest.mock('@/lib/code-reviews/recover-missed-reviews', () => ({
  recoverMissedReviews: () => mockRecoverMissedReviews(),
  RECOVER_MISSED_REVIEWS_LOOKBACK_HOURS: 24,
  RECOVER_MISSED_REVIEWS_PR_LIMIT: 20,
  RECOVER_MISSED_REVIEWS_REPO_LIMIT: 40,
  RECOVER_MISSED_REVIEWS_START_LIMIT: 10,
}));

import { emitScheduledJobEvent } from '@kilocode/worker-utils/scheduled-job-observability';
import { GET, maxDuration } from './route';

const SUMMARY = {
  repositoriesConsidered: 3,
  integrationsUnavailable: 0,
  pullRequestsConsidered: 4,
  reviewsStarted: 1,
  skippedExisting: 2,
  skippedActiveReview: 0,
  unaddressableRepositories: 0,
  skippedStale: 1,
  skippedDraft: 0,
  skippedWithoutOwner: 0,
  skippedStartLimit: 0,
  refusedByHandler: 0,
  providerFailures: 0,
};

function authorizedRequest(): Request {
  return new Request('http://localhost/api/cron/recover-code-reviews', {
    headers: { authorization: 'Bearer cron-secret' },
  });
}

describe('GET /api/cron/recover-code-reviews', () => {
  beforeEach(() => jest.clearAllMocks());

  it('exports maxDuration of 300 seconds', () => {
    expect(maxDuration).toBe(300);
  });

  it('rejects a request without the cron bearer token', async () => {
    const response = await GET(new Request('http://localhost/api/cron/recover-code-reviews'));

    expect(response.status).toBe(401);
    expect(mockRecoverMissedReviews).not.toHaveBeenCalled();
    expect(emitScheduledJobEvent).not.toHaveBeenCalled();
  });

  it('refuses a request whose bearer does not match and reports the attempt', async () => {
    const response = await GET(
      new Request('http://localhost/api/cron/recover-code-reviews', {
        headers: { authorization: 'Bearer not-the-cron-secret' },
      })
    );

    expect(response.status).toBe(401);
    expect(mockRecoverMissedReviews).not.toHaveBeenCalled();
    expect(mockSentryLogger).toHaveBeenCalledTimes(1);
  });

  it('runs the sweep and reports its summary with the bounds it applied', async () => {
    mockRecoverMissedReviews.mockResolvedValue(SUMMARY);

    const response = await GET(authorizedRequest());
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ...SUMMARY,
      repositorySlice: 40,
      pullRequestLimit: 20,
      ageLimitHours: 24,
      startLimit: 10,
    });
    expect(emitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'success',
        data: expect.objectContaining({
          repositories_considered: 3,
          pull_requests_considered: 4,
          reviews_started: 1,
          skipped_existing: 2,
          skipped_stale: 1,
          provider_failures: 0,
        }),
      })
    );
  });

  it('emits a failure event and rethrows when the sweep fails', async () => {
    const error = new Error('database unavailable');
    mockRecoverMissedReviews.mockRejectedValue(error);

    await expect(GET(authorizedRequest())).rejects.toThrow('database unavailable');
    expect(emitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'failure', error })
    );
  });
});
