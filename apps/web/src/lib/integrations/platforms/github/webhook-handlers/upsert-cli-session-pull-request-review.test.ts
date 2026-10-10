import { db } from '@kilocode/web-shared/lib/drizzle';
import { cli_sessions_v2, github_branch_pull_requests } from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
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
  /** Base repository full name. */
  repo?: string;
  /** Head repository full name — set to a fork to model a cross-repo PR. */
  headRepo?: string;
}): PullRequestReviewPayload {
  const repo = overrides.repo ?? REPO;
  const headRepo = overrides.headRepo ?? repo;
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
      html_url: `https://github.com/${repo}/pull/${overrides.prNumber}`,
      title: 'Test PR',
      head: {
        sha: 'sha-abc',
        ref: overrides.branch,
        repo: {
          full_name: headRepo,
          clone_url: `https://github.com/${headRepo}.git`,
          html_url: `https://github.com/${headRepo}`,
        },
      },
    },
    repository: {
      id: 1,
      name: repo.split('/')[1] ?? 'repo',
      full_name: repo,
      owner: { login: repo.split('/')[0] ?? 'owner' },
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

  async function seedSession(
    branch: string,
    params: { prNumber: number; platform?: string; userId?: string; gitUrl?: string }
  ) {
    const sessionId = `ses_test_pr_review_${Date.now()}_${sessionCounter++}`;
    const gitUrl = params.gitUrl ?? NORMALIZED_GIT_URL;
    await db.insert(cli_sessions_v2).values({
      session_id: sessionId,
      kilo_user_id: params.userId ?? testUserId,
      organization_id: null,
      git_url: gitUrl,
      git_branch: branch,
      created_on_platform: params.platform ?? 'cloud-agent-web',
      pr_url: `${gitUrl}/pull/${params.prNumber}`,
      pr_number: params.prNumber,
      pr_head_ref: branch,
      pr_head_sha: null,
    });
    sessionIdsToCleanup.push(sessionId);
  }

  async function seedPrCacheRow(
    branch: string,
    userId: string,
    prNumber: number,
    opts?: { reviewDecision?: string; reviewDecisionPending?: boolean }
  ) {
    await db.insert(github_branch_pull_requests).values({
      git_url: NORMALIZED_GIT_URL,
      git_branch: branch,
      owned_by_user_id: userId,
      pr_url: `https://github.com/${REPO}/pull/${prNumber}`,
      pr_number: prNumber,
      pr_state: 'open',
      pr_review_decision: opts?.reviewDecision ?? null,
      review_decision_pending: opts?.reviewDecisionPending ?? false,
    });
  }

  async function readRow(prNumber: number, userId: string) {
    return db
      .select()
      .from(github_branch_pull_requests)
      .where(
        and(
          eq(github_branch_pull_requests.git_url, NORMALIZED_GIT_URL),
          eq(github_branch_pull_requests.pr_number, prNumber),
          eq(github_branch_pull_requests.owned_by_user_id, userId)
        )
      );
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
    expect(await readRow(1, testUserId)).toHaveLength(0);
  });

  it('flags pending for a session on a platform outside the old review-decision set', async () => {
    const branch = 'feature/unsupported-platform';
    await seedSession(branch, { prNumber: 10, platform: 'vscode' });
    await seedPrCacheRow(branch, testUserId, 10);

    const result = await upsertCliSessionPullRequestReviewFromWebhook(
      makeReviewPayload({ prNumber: 10, branch }),
      testOwner
    );

    expect(result).toBe(1);
    expect((await readRow(10, testUserId))[0].review_decision_pending).toBe(true);
  });

  it('returns 0 when supported-platform session exists but no cache row yet (UPDATE-only)', async () => {
    await seedSession('feature/no-cache-row', { prNumber: 11, platform: 'cloud-agent-web' });

    const result = await upsertCliSessionPullRequestReviewFromWebhook(
      makeReviewPayload({ prNumber: 11, branch: 'feature/no-cache-row' }),
      testOwner
    );

    expect(result).toBe(0);
    expect(await readRow(11, testUserId)).toHaveLength(0);
  });

  it('sets review_decision_pending=true when a supported-platform session and cache row both exist', async () => {
    const branch = 'feature/update-review';
    await seedSession(branch, { prNumber: 12, platform: 'cloud-agent-web' });
    await seedPrCacheRow(branch, testUserId, 12);

    const result = await upsertCliSessionPullRequestReviewFromWebhook(
      makeReviewPayload({ prNumber: 12, branch }),
      testOwner
    );

    expect(result).toBe(1);
    expect((await readRow(12, testUserId))[0].review_decision_pending).toBe(true);
  });

  it('does not overwrite existing pr_review_decision (lazy fetch handles it)', async () => {
    const branch = 'feature/review-no-overwrite';
    await seedSession(branch, { prNumber: 13, platform: 'cloud-agent-web' });
    await seedPrCacheRow(branch, testUserId, 13, { reviewDecision: 'approved' });

    await upsertCliSessionPullRequestReviewFromWebhook(
      makeReviewPayload({ prNumber: 13, branch }),
      testOwner
    );

    const rows = await readRow(13, testUserId);
    expect(rows[0].pr_review_decision).toBe('approved');
    expect(rows[0].review_decision_pending).toBe(true);
  });

  it('does not match sessions belonging to a different tenant', async () => {
    const otherUser = await insertTestUser();
    userIdsToCleanup.push(otherUser.id);
    const branch = 'feature/wrong-tenant-review';

    // Session belongs to otherUser, but webhook owner is testOwner
    await seedSession(branch, { prNumber: 14, userId: otherUser.id });

    const result = await upsertCliSessionPullRequestReviewFromWebhook(
      makeReviewPayload({ prNumber: 14, branch }),
      testOwner
    );

    expect(result).toBe(0);
  });

  it('does not match a session on the same branch that links a different PR', async () => {
    const branch = 'feature/different-pr-review';
    await seedSession(branch, { prNumber: 15, platform: 'cloud-agent-web' });
    await seedPrCacheRow(branch, testUserId, 16);

    // Review is for PR 16, which the session does not link (it links PR 15).
    const result = await upsertCliSessionPullRequestReviewFromWebhook(
      makeReviewPayload({ prNumber: 16, branch }),
      testOwner
    );

    expect(result).toBe(0);
    expect((await readRow(16, testUserId))[0].review_decision_pending).toBe(false);
  });

  it('does not match a session on the same branch in another repository', async () => {
    const branch = 'feature/other-repo-review';
    await seedSession(branch, { prNumber: 17, gitUrl: 'https://github.com/other/repo' });

    const result = await upsertCliSessionPullRequestReviewFromWebhook(
      makeReviewPayload({ prNumber: 17, branch }),
      testOwner
    );

    expect(result).toBe(0);
  });

  it('does not match a fork PR whose head repo differs from the base repo', async () => {
    const branch = 'feature/fork-review';
    await seedSession(branch, { prNumber: 18, platform: 'cloud-agent-web' });
    await seedPrCacheRow(branch, testUserId, 18);

    const result = await upsertCliSessionPullRequestReviewFromWebhook(
      makeReviewPayload({ prNumber: 18, branch, headRepo: 'fork/pr-review-test' }),
      testOwner
    );

    expect(result).toBe(0);
  });

  it.each(['submitted', 'edited', 'dismissed'] as const)(
    'action=%s: sets review_decision_pending=true without calling GraphQL',
    async action => {
      const branch = `feature/action-${action}-review`;
      const prNumber = action === 'submitted' ? 20 : action === 'edited' ? 21 : 22;
      await seedSession(branch, { prNumber, platform: 'cloud-agent-web' });
      await seedPrCacheRow(branch, testUserId, prNumber);

      const result = await upsertCliSessionPullRequestReviewFromWebhook(
        makeReviewPayload({ prNumber, branch, action }),
        testOwner
      );

      expect(result).toBe(1);
      expect((await readRow(prNumber, testUserId))[0].review_decision_pending).toBe(true);
    }
  );

  it('slack platform is supported', async () => {
    const branch = 'feature/slack-platform';
    await seedSession(branch, { prNumber: 23, platform: 'slack' });
    await seedPrCacheRow(branch, testUserId, 23);

    const result = await upsertCliSessionPullRequestReviewFromWebhook(
      makeReviewPayload({ prNumber: 23, branch }),
      testOwner
    );

    expect(result).toBe(1);
    expect((await readRow(23, testUserId))[0].review_decision_pending).toBe(true);
  });
});
