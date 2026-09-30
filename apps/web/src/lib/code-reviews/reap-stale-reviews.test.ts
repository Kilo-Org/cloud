import type { CloudAgentCodeReview } from '@kilocode/db/schema';

/* eslint-disable @typescript-eslint/no-explicit-any */
// Loosely typed on purpose: these stand in for modules with wide signatures and
// the assertions here are about call shape, not argument types.
const mockSelectStale = jest.fn() as jest.MockedFunction<(limit: number) => Promise<any[]>>;
const mockClaim = jest.fn() as jest.MockedFunction<() => Promise<unknown[]>>;
const mockRemaining = jest.fn() as jest.MockedFunction<() => number>;
const mockGetIntegrationById = jest.fn() as jest.MockedFunction<(id: string) => Promise<any>>;
const mockUpdateCheckRun = jest.fn() as jest.MockedFunction<(...args: any[]) => Promise<void>>;
const mockSetCommitStatus = jest.fn() as jest.MockedFunction<(...args: any[]) => Promise<void>>;
const mockResolveGitLabAccessToken = jest.fn() as jest.MockedFunction<
  (...args: any[]) => Promise<string>
>;
const mockSettleCodeReviewLedgerRowOn = jest.fn() as jest.MockedFunction<
  (...args: any[]) => Promise<void>
>;

// The real SQL (selection predicate, optimistic lock, attempt terminalization)
// is exercised against the database in reap-stale-reviews.integration.test.ts;
// this mock swallows the WHERE clauses so the per-row branching can be asserted
// directly. The update chain is shared by the review claim (awaits .returning())
// and the attempts close (awaits the .where() thenable itself).
jest.mock('@/lib/drizzle', () => ({
  db: {
    select: () => ({
      from: () => ({
        // Awaited directly by the remaining-depth count, chained through
        // orderBy/limit by the batch selection.
        where: () =>
          Object.assign(Promise.resolve([{ remaining: mockRemaining() }]), {
            orderBy: () => ({
              limit: (n: number) => mockSelectStale(n),
            }),
          }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => {
          const thenable = Object.assign(Promise.resolve([] as unknown[]), {
            returning: () => mockClaim(),
          });
          return thenable;
        },
      }),
    }),
    // The claim runs inside a transaction; the callback receives a tx with the
    // same update chain as the db object above.
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        update: () => ({
          set: () => ({
            where: () => {
              const thenable = Object.assign(Promise.resolve([] as unknown[]), {
                returning: () => mockClaim(),
              });
              return thenable;
            },
          }),
        }),
      }),
  },
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationById: (id: string) => mockGetIntegrationById(id),
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  updateCheckRun: (...args: unknown[]) => mockUpdateCheckRun(...args),
}));

jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  setCommitStatus: (...args: unknown[]) => mockSetCommitStatus(...args),
}));

jest.mock('@/lib/code-reviews/platform/gitlab-access', () => ({
  resolveGitLabAccessToken: (...args: unknown[]) => mockResolveGitLabAccessToken(...args),
  getGitLabInstanceUrl: () => 'https://gitlab.com',
}));

jest.mock('@/lib/code-reviews/code-review-ledger', () => ({
  settleCodeReviewLedgerRowOn: (...args: unknown[]) => mockSettleCodeReviewLedgerRowOn(...args),
}));

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { reapStaleCodeReviews, REAP_DEFAULT_BATCH_SIZE } from './reap-stale-reviews';

function makeReview(overrides: Partial<CloudAgentCodeReview> = {}): CloudAgentCodeReview {
  return {
    id: '00000000-0000-0000-0000-0000000000aa',
    owned_by_organization_id: null,
    owned_by_user_id: 'user-1',
    platform_integration_id: 'int-1',
    repo_full_name: 'owner/repo',
    pr_number: 7,
    pr_url: 'https://github.com/owner/repo/pull/7',
    pr_title: 'Test',
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
    check_run_id: 555,
    repository_review_instructions_used: false,
    repository_review_instructions_ref: null,
    repository_review_instructions_truncated: false,
    previous_summary_body: null,
    previous_summary_head_sha: null,
    manual_config: null,
    review_type: 'standard',
    trigger_source: 'webhook',
    council_result: null,
    model: null,
    total_tokens_in: null,
    total_tokens_out: null,
    total_cost_musd: null,
    started_at: '2025-01-01T00:00:00Z',
    completed_at: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  } as CloudAgentCodeReview;
}

/**
 * `manual_config` is parsed by a strict zod schema, so a partial literal is
 * rejected at read time rather than simply ignored.
 */
function manualConfig(outputMode: 'provider' | 'kilo') {
  return {
    agentConfig: {
      review_style: 'balanced',
      focus_areas: [],
      model_slug: 'anthropic/claude-sonnet-4.6',
    },
    instructions: null,
    outputMode,
  };
}

const githubIntegration = {
  id: 'int-1',
  platform_installation_id: 'inst-1',
  github_app_type: 'standard',
  metadata: null,
  owned_by_user_id: 'user-1',
  owned_by_organization_id: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockClaim.mockResolvedValue([{ id: 'claimed' }]);
  mockRemaining.mockReturnValue(0);
  mockGetIntegrationById.mockResolvedValue(githubIntegration);
  mockUpdateCheckRun.mockResolvedValue(undefined);
  mockSetCommitStatus.mockResolvedValue(undefined);
  mockResolveGitLabAccessToken.mockResolvedValue('gl-token');
  mockSettleCodeReviewLedgerRowOn.mockResolvedValue(undefined);
});

describe('reapStaleCodeReviews', () => {
  it('uses the default batch size as the selection limit', async () => {
    mockSelectStale.mockResolvedValue([]);

    await reapStaleCodeReviews();

    expect(mockSelectStale).toHaveBeenCalledWith(REAP_DEFAULT_BATCH_SIZE);
  });

  it('honours an explicit batch size', async () => {
    mockSelectStale.mockResolvedValue([]);

    await reapStaleCodeReviews(5);

    expect(mockSelectStale).toHaveBeenCalledWith(5);
  });

  it('closes the GitHub check run as timed out', async () => {
    mockSelectStale.mockResolvedValue([makeReview()]);

    const summary = await reapStaleCodeReviews();

    expect(mockUpdateCheckRun).toHaveBeenCalledWith(
      'inst-1',
      'owner',
      'repo',
      555,
      expect.objectContaining({ status: 'completed', conclusion: 'timed_out' }),
      'standard'
    );
    expect(summary).toMatchObject({ terminalized: 1, checksClosed: 1, providerFailures: 0 });
  });

  // A saturated batch alone says nothing about depth; the summary must carry
  // how much is still waiting so the drain is observable.
  it('reports the remaining stale backlog after the run', async () => {
    mockSelectStale.mockResolvedValue([makeReview()]);
    mockRemaining.mockReturnValue(1575);

    const summary = await reapStaleCodeReviews();

    expect(summary.remaining).toBe(1575);
  });

  it('cancels the commit status for a GitLab review', async () => {
    mockSelectStale.mockResolvedValue([
      makeReview({ platform: 'gitlab', platform_project_id: 42, check_run_id: null }),
    ]);

    const summary = await reapStaleCodeReviews();

    expect(mockSetCommitStatus).toHaveBeenCalledWith(
      'gl-token',
      42,
      'abc123',
      'canceled',
      expect.any(Object),
      'https://gitlab.com'
    );
    expect(summary).toMatchObject({ checksClosed: 1 });
  });

  // A terminal callback arriving mid-batch wins: the guarded UPDATE claims
  // nothing and the reaper must not then touch the provider.
  it('skips provider work when the row was already claimed elsewhere', async () => {
    mockSelectStale.mockResolvedValue([makeReview()]);
    mockClaim.mockResolvedValue([]);

    const summary = await reapStaleCodeReviews();

    expect(mockUpdateCheckRun).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ selected: 1, terminalized: 0 });
  });

  // The ledger settle runs inside the terminalize transaction, so the event is
  // emitted atomically with the terminal claim.
  it('settles the ledger row inside the terminalize transaction', async () => {
    mockSelectStale.mockResolvedValue([makeReview()]);

    await reapStaleCodeReviews();

    expect(mockSettleCodeReviewLedgerRowOn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        reviewId: '00000000-0000-0000-0000-0000000000aa',
        status: 'failed',
        terminalReason: 'abandoned',
        triggerSource: 'webhook',
      })
    );
  });

  // A transient settle failure must propagate so the terminalize rolls back and
  // the review stays non-terminal for a later run, instead of losing the event.
  it('propagates a settle failure so the terminalize rolls back', async () => {
    mockSelectStale.mockResolvedValue([makeReview()]);
    mockSettleCodeReviewLedgerRowOn.mockRejectedValue(new Error('settle failed'));

    await expect(reapStaleCodeReviews()).rejects.toThrow('settle failed');
  });

  // A dashboard-only manual review never published anything to the pull
  // request, so nothing may be created for it now either.
  it('terminalizes a dashboard-only review without touching the provider', async () => {
    mockSelectStale.mockResolvedValue([
      makeReview({ manual_config: manualConfig('kilo') as never }),
    ]);

    const summary = await reapStaleCodeReviews();

    expect(mockGetIntegrationById).not.toHaveBeenCalled();
    expect(mockUpdateCheckRun).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ terminalized: 1, checksClosed: 0 });
  });

  it('still closes the gate for a manual review configured for the provider', async () => {
    mockSelectStale.mockResolvedValue([
      makeReview({ manual_config: manualConfig('provider') as never }),
    ]);

    const summary = await reapStaleCodeReviews();

    expect(summary).toMatchObject({ terminalized: 1, checksClosed: 1 });
  });

  // The strict manual_config schema throws on malformed legacy rows. One poison
  // row must cost only its own provider work, never the rest of the batch.
  it('continues the batch past a review whose manual_config no longer parses', async () => {
    mockSelectStale.mockResolvedValue([
      makeReview({ id: 'poison', manual_config: { outputMode: 'kilo' } as never }),
      makeReview({ id: 'healthy', check_run_id: 777 }),
    ]);

    const summary = await reapStaleCodeReviews();

    expect(summary).toMatchObject({
      terminalized: 2,
      checksClosed: 1,
      providerFailures: 1,
    });
    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(1);
  });

  // A suspended or uninstalled integration cannot mint a token, so its gate is
  // unclosable. Expected for part of the backlog; counted, not retried.
  it('continues the batch when a check run cannot be closed', async () => {
    mockSelectStale.mockResolvedValue([
      makeReview({ id: 'a', check_run_id: 111 }),
      makeReview({ id: 'b', check_run_id: 222 }),
    ]);
    mockUpdateCheckRun.mockRejectedValueOnce(new Error('installation suspended'));

    const summary = await reapStaleCodeReviews();

    expect(summary).toMatchObject({
      terminalized: 2,
      checksClosed: 1,
      providerFailures: 1,
    });
  });

  it('leaves Bitbucket reviews untouched on the provider side', async () => {
    mockSelectStale.mockResolvedValue([makeReview({ platform: 'bitbucket', check_run_id: null })]);

    const summary = await reapStaleCodeReviews();

    expect(mockUpdateCheckRun).not.toHaveBeenCalled();
    expect(mockSetCommitStatus).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ terminalized: 1, checksClosed: 0 });
  });

  it('terminalizes a review with no integration row without provider calls', async () => {
    mockSelectStale.mockResolvedValue([makeReview({ platform_integration_id: null })]);

    const summary = await reapStaleCodeReviews();

    expect(mockGetIntegrationById).not.toHaveBeenCalled();
    expect(mockUpdateCheckRun).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ terminalized: 1, checksClosed: 0, providerFailures: 0 });
  });
});
