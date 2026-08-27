import { db } from '@/lib/drizzle';
import {
  cli_sessions_v2,
  github_branch_pull_requests,
  platform_integrations,
} from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  executeBatchReviewDecisionFetch,
  triggerBatchReviewDecisionFetchIfNeeded,
  type TenantOwner,
} from './batch-review-decisions';
import type { getPinnedCliSessionGitHubIntegration } from './cli-session-integration';

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  fetchBatchedReviewDecisions: jest.fn(),
}));

import { fetchBatchedReviewDecisions } from '@/lib/integrations/platforms/github/adapter';

const mockGetPinnedIntegration = jest.fn();
jest.mock('./cli-session-integration', () => {
  const actual = jest.requireActual('./cli-session-integration') as {
    getPinnedCliSessionGitHubIntegration: typeof getPinnedCliSessionGitHubIntegration;
  };
  return {
    ...actual,
    getPinnedCliSessionGitHubIntegration: (
      ...args: Parameters<typeof actual.getPinnedCliSessionGitHubIntegration>
    ) => mockGetPinnedIntegration(...args),
  };
});

const mockFetchBatch = fetchBatchedReviewDecisions as jest.MockedFunction<
  typeof fetchBatchedReviewDecisions
>;
const REPO = 'acme/batch-test';
const GIT_URL = `https://github.com/${REPO}`;

describe('batch-review-decisions', () => {
  let testUserId: string;
  let testOwner: TenantOwner;
  const userIdsToCleanup: string[] = [];
  const sessionIdsToCleanup: string[] = [];
  const integrationIdsToCleanup: string[] = [];
  let integrationId: string;
  let counter = 0;

  async function seedSession(branch: string, pinnedIntegrationId = integrationId) {
    const sessionId = `ses_batch_test_${Date.now()}_${counter++}`;
    await db.insert(cli_sessions_v2).values({
      session_id: sessionId,
      kilo_user_id: testUserId,
      organization_id: null,
      git_url: GIT_URL,
      git_branch: branch,
      github_integration_id: pinnedIntegrationId,
      created_on_platform: 'cloud-agent-web',
    });
    sessionIdsToCleanup.push(sessionId);
  }

  async function seedPrRow(
    branch: string,
    prNumber: number,
    opts: { pending?: boolean; fetchingAt?: string; integrationId?: string | null } = {}
  ) {
    await db.insert(github_branch_pull_requests).values({
      git_url: GIT_URL,
      git_branch: branch,
      owned_by_user_id: testUserId,
      platform_integration_id:
        opts.integrationId === undefined ? integrationId : opts.integrationId,
      pr_number: prNumber,
      pr_state: 'open',
      review_decision_pending: opts.pending ?? true,
      review_decision_fetching_at: opts.fetchingAt ?? null,
    });
  }

  async function readRow(branch: string) {
    const rows = await db
      .select()
      .from(github_branch_pull_requests)
      .where(
        and(
          eq(github_branch_pull_requests.git_url, GIT_URL),
          eq(github_branch_pull_requests.git_branch, branch),
          eq(github_branch_pull_requests.owned_by_user_id, testUserId)
        )
      );
    return rows[0] ?? null;
  }

  async function seedIntegration(input: {
    installationId: string;
    appType: 'standard' | 'lite';
  }): Promise<string> {
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: testUserId,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: input.installationId,
        platform_account_login: 'acme',
        repository_access: 'all',
        github_app_type: input.appType,
        integration_status: 'active',
      })
      .returning({ id: platform_integrations.id });
    integrationIdsToCleanup.push(integration.id);
    return integration.id;
  }

  beforeAll(async () => {
    const user = await insertTestUser();
    testUserId = user.id;
    testOwner = { userId: testUserId, organizationId: null };
    userIdsToCleanup.push(testUserId);
  });

  afterAll(async () => {
    await db
      .delete(github_branch_pull_requests)
      .where(inArray(github_branch_pull_requests.owned_by_user_id, userIdsToCleanup));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    const actual = jest.requireActual('./cli-session-integration') as {
      getPinnedCliSessionGitHubIntegration: typeof getPinnedCliSessionGitHubIntegration;
    };
    mockGetPinnedIntegration.mockImplementation(actual.getPinnedCliSessionGitHubIntegration);
  });

  beforeEach(async () => {
    integrationId = await seedIntegration({
      installationId: `42-${counter++}`,
      appType: 'standard',
    });
  });

  afterEach(async () => {
    await db
      .delete(github_branch_pull_requests)
      .where(eq(github_branch_pull_requests.owned_by_user_id, testUserId));
    if (sessionIdsToCleanup.length > 0) {
      await db
        .delete(cli_sessions_v2)
        .where(inArray(cli_sessions_v2.session_id, sessionIdsToCleanup.splice(0)));
    }
    if (integrationIdsToCleanup.length > 0) {
      await db
        .delete(platform_integrations)
        .where(inArray(platform_integrations.id, integrationIdsToCleanup.splice(0)));
    }
  });

  describe('executeBatchReviewDecisionFetch', () => {
    it('does nothing when no pending rows exist', async () => {
      const branch = 'batch/no-pending';
      await seedSession(branch);
      await seedPrRow(branch, 1, { pending: false });

      await executeBatchReviewDecisionFetch(testOwner);

      expect(mockFetchBatch).not.toHaveBeenCalled();
    });

    it('clears pending when no GitHub integration is found so the client stops polling', async () => {
      const branch = 'batch/no-integration';
      await seedSession(branch);
      await seedPrRow(branch, 2, { pending: true });

      await db
        .update(platform_integrations)
        .set({ integration_status: 'disconnected' })
        .where(eq(platform_integrations.id, integrationId));

      await executeBatchReviewDecisionFetch(testOwner);

      expect(mockFetchBatch).not.toHaveBeenCalled();
      // Without abandonment the row would stay pending=true forever, causing the
      // sidebar to poll review decisions indefinitely. We give up so the badge
      // settles to its existing (possibly null) decision.
      const row = await readRow(branch);
      expect(row?.review_decision_pending).toBe(false);
      expect(row?.review_decision_fetching_at).toBeNull();
    });

    it('claims and updates a pending row with the fetched decision', async () => {
      const branch = 'batch/fetch-success';
      await seedSession(branch);
      await seedPrRow(branch, 10, { pending: true });

      mockFetchBatch.mockResolvedValue(new Map([['pr0', 'approved']]));

      await executeBatchReviewDecisionFetch(testOwner);

      const row = await readRow(branch);
      expect(row?.pr_review_decision).toBe('approved');
      expect(row?.review_decision_pending).toBe(false);
      expect(row?.review_decision_fetching_at).toBeNull();
    });

    it('stores null decision when GitHub returns null', async () => {
      const branch = 'batch/null-decision';
      await seedSession(branch);
      await seedPrRow(branch, 11, { pending: true });

      mockFetchBatch.mockResolvedValue(new Map([['pr0', null]]));

      await executeBatchReviewDecisionFetch(testOwner);

      const row = await readRow(branch);
      expect(row?.pr_review_decision).toBeNull();
      expect(row?.review_decision_pending).toBe(false);
    });

    it('clears pending on rows with no pr_number instead of looping on them forever', async () => {
      const branch = 'batch/no-pr-number';
      await seedSession(branch);
      // Insert a sentinel row (pr_number=null) that was somehow flagged pending.
      // Without abandonment the batch worker would keep claiming and skipping
      // this row, leaving the client polling forever.
      await db.insert(github_branch_pull_requests).values({
        git_url: GIT_URL,
        git_branch: branch,
        owned_by_user_id: testUserId,
        pr_number: null,
        pr_state: null,
        review_decision_pending: true,
      });

      await executeBatchReviewDecisionFetch(testOwner);

      // fetchBatch not called because no row with a pr_number was batch-able.
      expect(mockFetchBatch).not.toHaveBeenCalled();
      const row = await readRow(branch);
      expect(row?.review_decision_pending).toBe(false);
      expect(row?.review_decision_fetching_at).toBeNull();
    });

    it('concurrent claim: second call within 2 minutes claims nothing', async () => {
      const branch = 'batch/dedup-claim';
      await seedSession(branch);
      await seedPrRow(branch, 20, { pending: true });

      mockFetchBatch.mockResolvedValue(new Map([['pr0', 'approved']]));

      // First call claims the row
      await executeBatchReviewDecisionFetch(testOwner);

      // Second call: row is now pending=false (already flushed), so nothing to claim
      jest.clearAllMocks();
      await executeBatchReviewDecisionFetch(testOwner);

      expect(mockFetchBatch).not.toHaveBeenCalled();
    });

    it('TOCTOU guard: does not clear pending when fetching_at was updated by a concurrent webhook', async () => {
      const branch = 'batch/toctou';
      await seedSession(branch);
      // Seed a row that already has a fetching_at claim from a previous batch
      // (simulates: we claimed it, but then a webhook reset the flag with a new claim time)
      const olderFetchingAt = new Date(Date.now() - 60_000).toISOString();
      await seedPrRow(branch, 30, { pending: true, fetchingAt: olderFetchingAt });

      // fetchBatch won't be called because the claim UPDATE won't match:
      // fetching_at is recent (< 2 minutes ago) so it's not stale, so claim skips it
      await executeBatchReviewDecisionFetch(testOwner);

      // Row was not claimed (fetching_at was set and < 2min ago), so fetch not called
      expect(mockFetchBatch).not.toHaveBeenCalled();
      const row = await readRow(branch);
      // pending still true, fetching_at unchanged
      expect(row?.review_decision_pending).toBe(true);
    });

    it('groups two installations by exact integration and app type', async () => {
      const standardBranch = 'batch/two-installations-standard';
      const liteBranch = 'batch/two-installations-lite';
      const liteIntegrationId = await seedIntegration({
        installationId: '84',
        appType: 'lite',
      });
      await seedSession(standardBranch);
      await seedSession(liteBranch, liteIntegrationId);
      await seedPrRow(standardBranch, 41, { integrationId });
      await seedPrRow(liteBranch, 42, { integrationId: liteIntegrationId });
      mockFetchBatch.mockImplementation(
        async ({ prs, appType }) =>
          new Map(prs.map(pr => [pr.alias, appType === 'lite' ? 'changes_requested' : 'approved']))
      );

      await executeBatchReviewDecisionFetch(testOwner);

      expect(mockFetchBatch).toHaveBeenCalledTimes(2);
      expect(mockFetchBatch).toHaveBeenCalledWith(expect.objectContaining({ appType: 'standard' }));
      expect(mockFetchBatch).toHaveBeenCalledWith(
        expect.objectContaining({ installationId: '84', appType: 'lite' })
      );
      expect((await readRow(standardBranch))?.pr_review_decision).toBe('approved');
      expect((await readRow(liteBranch))?.pr_review_decision).toBe('changes_requested');
    });

    it('fails closed for an old unpinned row', async () => {
      const branch = 'batch/legacy-overlap';
      await seedSession(branch);
      await seedPrRow(branch, 43, { integrationId: null });

      await executeBatchReviewDecisionFetch(testOwner);

      expect(mockFetchBatch).not.toHaveBeenCalled();
      expect((await readRow(branch))?.review_decision_pending).toBe(false);
    });

    it('leaves the claim pending when integration lookup fails transiently', async () => {
      const branch = 'batch/transient-integration-lookup';
      await seedSession(branch);
      await seedPrRow(branch, 44);
      mockGetPinnedIntegration.mockRejectedValueOnce(new Error('database unavailable'));

      await executeBatchReviewDecisionFetch(testOwner);

      expect(mockFetchBatch).not.toHaveBeenCalled();
      expect((await readRow(branch))?.review_decision_pending).toBe(true);
    });
  });

  describe('triggerBatchReviewDecisionFetchIfNeeded', () => {
    it('does not call executeBatch when hasPendingRows=false', () => {
      triggerBatchReviewDecisionFetchIfNeeded(false, testOwner);
      expect(mockFetchBatch).not.toHaveBeenCalled();
    });

    // Flaky in CI due to setTimeout(0)-based wait for fire-and-forget async work.
    // Recent failures:
    //   https://github.com/Kilo-Org/cloud/actions/runs/25554038239
    //   https://github.com/Kilo-Org/cloud/actions/runs/25549351687
    //   https://github.com/Kilo-Org/cloud/actions/runs/25547782557
    //   https://github.com/Kilo-Org/cloud/actions/runs/25547122885
    // eslint-disable-next-line jest/no-disabled-tests
    it.skip('calls executeBatch when hasPendingRows=true', async () => {
      const branch = 'batch/trigger-true';
      await seedSession(branch);
      await seedPrRow(branch, 40, { pending: true });

      mockFetchBatch.mockResolvedValue(new Map([['pr0', 'review_required']]));

      triggerBatchReviewDecisionFetchIfNeeded(true, testOwner);

      // Give it a tick for any resolved promises
      await new Promise(r => setTimeout(r, 0));

      expect(mockFetchBatch).toHaveBeenCalled();
    });
  });
});
