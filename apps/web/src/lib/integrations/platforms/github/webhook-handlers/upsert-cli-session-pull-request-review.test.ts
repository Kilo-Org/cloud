import { db } from '@/lib/drizzle';
import { cli_sessions_v2, github_branch_pull_requests } from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { PullRequestReviewPayload } from '@/lib/integrations/platforms/github/webhook-schemas';
import { upsertCliSessionPullRequestReviewFromWebhook } from './upsert-cli-session-pull-request-review';
import type { WebhookInstallationOwner } from './upsert-cli-session-pull-requests';

const REPO = 'acme/pr-review-test';
const NORMALIZED_GIT_URL = `https://github.com/${REPO}`;

function makeReviewPayload(overrides: {
  action?: 'submitted' | 'edited' | 'dismissed';
  prNumber: number;
  branch: string;
  reviewState?: 'approved' | 'changes_requested' | 'commented' | 'dismissed';
  installationId?: number;
}): PullRequestReviewPayload {
  return {
    action: overrides.action ?? 'submitted',
    review: {
      id: 1,
      state: overrides.reviewState ?? 'approved',
      user: { login: 'reviewer' },
    },
    pull_request: {
      number: overrides.prNumber,
      state: 'open',
      html_url: `https://github.com/${REPO}/pull/${overrides.prNumber}`,
      title: 'Test PR',
      head: {
        sha: 'sha-abc',
        ref: overrides.branch,
        repo: {
          full_name: REPO,
          clone_url: `https://github.com/${REPO}.git`,
          html_url: `https://github.com/${REPO}`,
        },
      },
    },
    repository: {
      id: 1,
      name: REPO.split('/')[1] ?? 'repo',
      full_name: REPO,
      owner: { login: REPO.split('/')[0] ?? 'owner' },
    },
    installation: { id: overrides.installationId ?? 1 },
  };
}

describe('upsertCliSessionPullRequestReviewFromWebhook', () => {
  let testUserId: string;
  let testOwner: WebhookInstallationOwner;
  const userIdsToCleanup: string[] = [];
  const sessionIdsToCleanup: string[] = [];
  let sessionCounter = 0;

  async function seedSession(branch: string, platform = 'cloud-agent-web') {
    const sessionId = `ses_test_pr_review_${Date.now()}_${sessionCounter++}`;
    await db.insert(cli_sessions_v2).values({
      session_id: sessionId,
      kilo_user_id: testUserId,
      organization_id: null,
      git_url: NORMALIZED_GIT_URL,
      git_branch: branch,
      created_on_platform: platform,
    });
    sessionIdsToCleanup.push(sessionId);
  }

  async function seedPrCacheRow(
    branch: string,
    userId: string,
    opts?: { reviewDecision?: string; reviewDecisionPending?: boolean }
  ) {
    await db.insert(github_branch_pull_requests).values({
      git_url: NORMALIZED_GIT_URL,
      git_branch: branch,
      owned_by_user_id: userId,
      pr_url: `https://github.com/${REPO}/pull/1`,
      pr_number: 1,
      pr_state: 'open',
      pr_review_decision: opts?.reviewDecision ?? null,
      review_decision_pending: opts?.reviewDecisionPending ?? false,
    });
  }

  async function readRow(branch: string, userId: string) {
    const rows = await db
      .select()
      .from(github_branch_pull_requests)
      .where(
        and(
          eq(github_branch_pull_requests.git_url, NORMALIZED_GIT_URL),
          eq(github_branch_pull_requests.git_branch, branch),
          eq(github_branch_pull_requests.owned_by_user_id, userId)
        )
      );
    return rows;
  }

  beforeAll(async () => {
    const user = await insertTestUser();
    testUserId = user.id;
    testOwner = { kind: 'user', userId: testUserId };
    userIdsToCleanup.push(testUserId);
  });

  afterAll(async () => {
    if (sessionIdsToCleanup.length > 0) {
      await db
        .delete(cli_sessions_v2)
        .where(inArray(cli_sessions_v2.session_id, sessionIdsToCleanup));
    }
    if (userIdsToCleanup.length > 0) {
      await db
        .delete(github_branch_pull_requests)
        .where(inArray(github_branch_pull_requests.owned_by_user_id, userIdsToCleanup));
    }
  });

  it('returns 0 when no matching session exists', async () => {
    const result = await upsertCliSessionPullRequestReviewFromWebhook(
      makeReviewPayload({ prNumber: 1, branch: 'feature/no-session' }),
      testOwner
    );
    expect(result).toBe(0);
    const rows = await readRow('feature/no-session', testUserId);
    expect(rows).toHaveLength(0);
  });

  it('returns 0 when only unsupported-platform sessions exist (gate returns no_session)', async () => {
    await seedSession('feature/unsupported-platform', 'vscode');
    await seedPrCacheRow('feature/unsupported-platform', testUserId);

    const result = await upsertCliSessionPullRequestReviewFromWebhook(
      makeReviewPayload({ prNumber: 1, branch: 'feature/unsupported-platform' }),
      testOwner
    );

    expect(result).toBe(0);
    const rows = await readRow('feature/unsupported-platform', testUserId);
    expect(rows[0].review_decision_pending).toBe(false);
  });

  it('returns 0 when supported-platform session exists but no cache row yet (UPDATE-only)', async () => {
    await seedSession('feature/no-cache-row', 'cloud-agent-web');

    const result = await upsertCliSessionPullRequestReviewFromWebhook(
      makeReviewPayload({ prNumber: 1, branch: 'feature/no-cache-row' }),
      testOwner
    );

    expect(result).toBe(0);
    const rows = await readRow('feature/no-cache-row', testUserId);
    expect(rows).toHaveLength(0);
  });

  it('sets review_decision_pending=true when a supported-platform session and cache row both exist', async () => {
    const branch = 'feature/update-review';
    await seedSession(branch, 'cloud-agent-web');
    await seedPrCacheRow(branch, testUserId);

    const result = await upsertCliSessionPullRequestReviewFromWebhook(
      makeReviewPayload({ prNumber: 1, branch }),
      testOwner
    );

    expect(result).toBe(1);
    const rows = await readRow(branch, testUserId);
    expect(rows[0].review_decision_pending).toBe(true);
  });

  it('does not overwrite existing pr_review_decision (lazy fetch handles it)', async () => {
    const branch = 'feature/review-no-overwrite';
    await seedSession(branch, 'cloud-agent-web');
    await seedPrCacheRow(branch, testUserId, { reviewDecision: 'approved' });

    await upsertCliSessionPullRequestReviewFromWebhook(
      makeReviewPayload({ prNumber: 1, branch }),
      testOwner
    );

    const rows = await readRow(branch, testUserId);
    expect(rows[0].pr_review_decision).toBe('approved');
    expect(rows[0].review_decision_pending).toBe(true);
  });

  it('does not match sessions belonging to a different tenant', async () => {
    const otherUser = await insertTestUser();
    userIdsToCleanup.push(otherUser.id);
    const branch = 'feature/wrong-tenant-review';

    // Session belongs to otherUser, but webhook owner is testOwner
    const sessionId = `ses_test_pr_review_${Date.now()}_${sessionCounter++}`;
    await db.insert(cli_sessions_v2).values({
      session_id: sessionId,
      kilo_user_id: otherUser.id,
      organization_id: null,
      git_url: NORMALIZED_GIT_URL,
      git_branch: branch,
      created_on_platform: 'cloud-agent-web',
    });
    sessionIdsToCleanup.push(sessionId);

    const result = await upsertCliSessionPullRequestReviewFromWebhook(
      makeReviewPayload({ prNumber: 1, branch }),
      testOwner
    );

    expect(result).toBe(0);
  });

  it.each(['submitted', 'edited', 'dismissed'] as const)(
    'action=%s: sets review_decision_pending=true without calling GraphQL',
    async action => {
      const branch = `feature/action-${action}-review`;
      await seedSession(branch, 'cloud-agent-web');
      await seedPrCacheRow(branch, testUserId);

      const result = await upsertCliSessionPullRequestReviewFromWebhook(
        makeReviewPayload({ prNumber: 1, branch, action }),
        testOwner
      );

      expect(result).toBe(1);
      const rows = await readRow(branch, testUserId);
      expect(rows[0].review_decision_pending).toBe(true);
    }
  );

  it('slack platform is supported', async () => {
    const branch = 'feature/slack-platform';
    await seedSession(branch, 'slack');
    await seedPrCacheRow(branch, testUserId);

    const result = await upsertCliSessionPullRequestReviewFromWebhook(
      makeReviewPayload({ prNumber: 1, branch }),
      testOwner
    );

    expect(result).toBe(1);
    const rows = await readRow(branch, testUserId);
    expect(rows[0].review_decision_pending).toBe(true);
  });
});
