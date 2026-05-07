const mockClaimCodeReviewsForSandboxRetry = jest.fn();
const mockTryDispatchPendingReviews = jest.fn();
const mockGetBotUserId = jest.fn();
const mockGetIntegrationById = jest.fn();
const mockUpdateCodeReviewRetryingGateCheck = jest.fn();

jest.mock('./db/code-reviews', () => ({
  claimCodeReviewsForSandboxRetry: (...args: unknown[]) =>
    mockClaimCodeReviewsForSandboxRetry(...args),
}));

jest.mock('./dispatch/dispatch-pending-reviews', () => ({
  tryDispatchPendingReviews: (...args: unknown[]) => mockTryDispatchPendingReviews(...args),
}));

jest.mock('@/lib/bot-users/bot-user-service', () => ({
  getBotUserId: (...args: unknown[]) => mockGetBotUserId(...args),
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationById: (...args: unknown[]) => mockGetIntegrationById(...args),
}));

jest.mock('./gate/retrying-gate-check', () => ({
  updateCodeReviewRetryingGateCheck: (...args: unknown[]) =>
    mockUpdateCodeReviewRetryingGateCheck(...args),
}));

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

function claimedReview(overrides: Record<string, unknown> = {}) {
  return {
    id: 'review-1',
    owned_by_organization_id: null,
    owned_by_user_id: 'user-1',
    platform_integration_id: 'integration-1',
    platform: 'github',
    platform_project_id: null,
    repo_full_name: 'owner/repo',
    pr_number: 1,
    head_sha: 'abc123',
    check_run_id: 123,
    current_attempt: 2,
    ...overrides,
  };
}

describe('claimAndDispatchCodeReviewSandboxRetries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClaimCodeReviewsForSandboxRetry.mockResolvedValue([]);
    mockTryDispatchPendingReviews.mockResolvedValue({ dispatched: 0, pending: 0, activeCount: 0 });
    mockGetBotUserId.mockResolvedValue('bot-user-1');
    mockGetIntegrationById.mockResolvedValue({ id: 'integration-1' });
    mockUpdateCodeReviewRetryingGateCheck.mockResolvedValue(undefined);
  });

  it('claims reviews and dispatches once per affected owner', async () => {
    mockClaimCodeReviewsForSandboxRetry.mockResolvedValue([
      claimedReview({ id: 'review-user-1', owned_by_user_id: 'user-1' }),
      claimedReview({ id: 'review-user-2', owned_by_user_id: 'user-1' }),
      claimedReview({
        id: 'review-org-1',
        owned_by_user_id: null,
        owned_by_organization_id: 'org-1',
      }),
    ]);
    const { claimAndDispatchCodeReviewSandboxRetries } = await import('./sandbox-retry');

    const result = await claimAndDispatchCodeReviewSandboxRetries({
      sandboxId: 'usr-sandbox',
      destroyedAt: '2026-05-07T12:00:00.000Z',
      source: 'test',
    });

    expect(result).toEqual({ claimed: 3, dispatchedOwners: 2 });
    expect(mockClaimCodeReviewsForSandboxRetry).toHaveBeenCalledWith('usr-sandbox', {
      reason: 'sandbox_500_destroyed',
      destroyedAt: '2026-05-07T12:00:00.000Z',
    });
    expect(mockTryDispatchPendingReviews).toHaveBeenCalledTimes(2);
    expect(mockTryDispatchPendingReviews).toHaveBeenCalledWith({
      type: 'user',
      id: 'user-1',
      userId: 'user-1',
    });
    expect(mockTryDispatchPendingReviews).toHaveBeenCalledWith({
      type: 'org',
      id: 'org-1',
      userId: 'bot-user-1',
    });
  });

  it('updates existing gate check best-effort', async () => {
    const review = claimedReview();
    const integration = { id: 'integration-1' };
    mockClaimCodeReviewsForSandboxRetry.mockResolvedValue([review]);
    mockGetIntegrationById.mockResolvedValue(integration);
    const { claimAndDispatchCodeReviewSandboxRetries } = await import('./sandbox-retry');

    await claimAndDispatchCodeReviewSandboxRetries({ sandboxId: 'usr-sandbox', source: 'test' });

    expect(mockUpdateCodeReviewRetryingGateCheck).toHaveBeenCalledWith(review, integration);
  });

  it('continues dispatch when retrying gate update fails', async () => {
    mockClaimCodeReviewsForSandboxRetry.mockResolvedValue([claimedReview()]);
    mockUpdateCodeReviewRetryingGateCheck.mockRejectedValue(new Error('gate failed'));
    const { claimAndDispatchCodeReviewSandboxRetries } = await import('./sandbox-retry');

    await claimAndDispatchCodeReviewSandboxRetries({ sandboxId: 'usr-sandbox', source: 'test' });

    expect(mockTryDispatchPendingReviews).toHaveBeenCalledWith({
      type: 'user',
      id: 'user-1',
      userId: 'user-1',
    });
  });
});
