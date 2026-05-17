import { NextRequest } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import {
  cli_sessions_v2,
  github_branch_pull_requests,
  platform_integrations,
} from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { handleGitHubWebhook } from '@/lib/integrations/platforms/github/webhook-handler';

// Accumulates Promises from after() callbacks so tests can flush them with
// `await flushAfter()` before reading the DB. The `closed` webhook handler
// returns immediately after scheduling the callback (no subsequent awaits to
// act as a natural synchronisation point), so fire-and-forget is not
// sufficient.
const pendingAfterCallbacks: Promise<void>[] = [];

async function flushAfter() {
  await Promise.all(pendingAfterCallbacks.splice(0));
}

jest.mock('next/server', () => ({
  ...jest.requireActual('next/server'),
  after: (fn: () => Promise<void>) => {
    pendingAfterCallbacks.push(fn());
  },
}));

// installation-handler.ts transitively imports `chat` (via @/lib/bot and
// @/lib/bot-identity) which is not resolvable in the test environment.
// These modules are only exercised by installation events; all tests here
// send pull_request events, so stub them out at the module boundary.
jest.mock('@/lib/bot', () => ({ bot: {} }));
jest.mock('@/lib/bot-identity', () => ({
  unlinkTeamKiloUsers: jest.fn(),
  resolveKiloUserId: jest.fn(),
  unlinkKiloUser: jest.fn(),
}));

/**
 * End-to-end test of the `pull_request` webhook dispatch path. Drives the real
 * `handleGitHubWebhook` entry point to catch regressions where the upsert
 * side-effect is short-circuited by `closed` early-returns or dedup.
 *
 * Signature verification is bypassed via the mock at
 * `apps/web/src/tests/setup/__mocks__/lib/integrations/platforms/github/adapter.ts`.
 */
describe('handleGitHubWebhook — pull_request dispatch to upsertCliSessionPullRequestsFromWebhook', () => {
  const REPO = 'acme/widgets';
  const NORMALIZED_GIT_URL = `https://github.com/${REPO}`;
  const INSTALLATION_ID = '424242';

  let testUserId: string;
  let integrationId: string;
  const userIdsToCleanup: string[] = [];
  const sessionIdsToCleanup: string[] = [];
  let sessionCounter = 0;

  /**
   * The PR cache upsert short-circuits unless a `cli_sessions_v2` row exists
   * in this tenant for the same `(git_url, git_branch)`. Seed one before the
   * webhook so the dispatch path can write the cache row.
   */
  async function seedSession(branch: string) {
    const sessionId = `ses_test_webhook_handler_${Date.now()}_${sessionCounter++}`;
    await db.insert(cli_sessions_v2).values({
      session_id: sessionId,
      kilo_user_id: testUserId,
      organization_id: null,
      git_url: NORMALIZED_GIT_URL,
      git_branch: branch,
      created_on_platform: 'cloud-agent-web',
    });
    sessionIdsToCleanup.push(sessionId);
  }

  beforeAll(async () => {
    const user = await insertTestUser();
    testUserId = user.id;
    userIdsToCleanup.push(testUserId);

    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: testUserId,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: INSTALLATION_ID,
        github_app_type: 'standard',
      })
      .returning();
    integrationId = integration.id;
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
    await db.delete(platform_integrations).where(eq(platform_integrations.id, integrationId));
  });

  async function readRow(branch: string) {
    const rows = await db
      .select()
      .from(github_branch_pull_requests)
      .where(
        and(
          eq(github_branch_pull_requests.git_url, NORMALIZED_GIT_URL),
          eq(github_branch_pull_requests.git_branch, branch),
          eq(github_branch_pull_requests.owned_by_user_id, testUserId)
        )
      );
    return rows;
  }

  function buildPullRequestWebhook(opts: {
    action: 'opened' | 'closed' | 'synchronize';
    prNumber: number;
    headRef: string;
    headSha: string;
    state: 'open' | 'closed';
    merged?: boolean;
    deliveryId: string;
  }): NextRequest {
    const payload = {
      action: opts.action,
      pull_request: {
        number: opts.prNumber,
        title: 'test PR',
        state: opts.state,
        merged: opts.merged,
        html_url: `https://github.com/${REPO}/pull/${opts.prNumber}`,
        user: { id: 1, login: 'octocat', avatar_url: 'https://example.com/a.png' },
        head: {
          sha: opts.headSha,
          ref: opts.headRef,
          repo: {
            full_name: REPO,
            clone_url: `https://github.com/${REPO}.git`,
            html_url: `https://github.com/${REPO}`,
          },
        },
        base: { sha: 'base-sha', ref: 'main' },
      },
      repository: {
        id: 1,
        name: 'widgets',
        full_name: REPO,
        owner: { login: 'acme' },
      },
      installation: { id: Number(INSTALLATION_ID) },
    };

    return new NextRequest('http://localhost/api/webhooks/github', {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': opts.deliveryId,
        'x-hub-signature-256': 'sha256=mocked',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }

  it('routes a closed+merged pull_request webhook through to the upsert, setting pr_state=merged', async () => {
    await seedSession('feature/merge-me');
    // Seed by first sending an `opened` webhook.
    const openedResponse = await handleGitHubWebhook(
      buildPullRequestWebhook({
        action: 'opened',
        prNumber: 555,
        headRef: 'feature/merge-me',
        headSha: 'sha-open',
        state: 'open',
        deliveryId: 'delivery-opened-555',
      }),
      'standard'
    );
    expect(openedResponse.status).toBe(200);
    await flushAfter();

    const afterOpened = await readRow('feature/merge-me');
    expect(afterOpened).toHaveLength(1);
    expect(afterOpened[0].pr_state).toBe('open');

    // Now the critical case: `closed` short-circuits before `handlePullRequest`
    // is invoked, but the upsert side-effect must still run.
    const closedResponse = await handleGitHubWebhook(
      buildPullRequestWebhook({
        action: 'closed',
        prNumber: 555,
        headRef: 'feature/merge-me',
        headSha: 'sha-open',
        state: 'closed',
        merged: true,
        deliveryId: 'delivery-closed-555',
      }),
      'standard'
    );
    expect(closedResponse.status).toBe(200);
    await flushAfter();

    const afterClosed = await readRow('feature/merge-me');
    expect(afterClosed[0].pr_state).toBe('merged');
    expect(afterClosed[0].pr_number).toBe(555);
  });

  it('records pr_state=closed when a pull_request is closed without merging', async () => {
    await seedSession('feature/abandon');
    const response = await handleGitHubWebhook(
      buildPullRequestWebhook({
        action: 'closed',
        prNumber: 556,
        headRef: 'feature/abandon',
        headSha: 'sha-abandon',
        state: 'closed',
        merged: false,
        deliveryId: 'delivery-closed-556',
      }),
      'standard'
    );
    expect(response.status).toBe(200);
    await flushAfter();

    const rows = await readRow('feature/abandon');
    expect(rows[0].pr_state).toBe('closed');
  });

  it('deduplicates redelivered pull_request webhooks before the upsert runs', async () => {
    await seedSession('feature/dedup');
    // Seed with an opened webhook.
    const openedRequest = buildPullRequestWebhook({
      action: 'opened',
      prNumber: 557,
      headRef: 'feature/dedup',
      headSha: 'sha-557-1',
      state: 'open',
      deliveryId: 'delivery-opened-557',
    });
    await handleGitHubWebhook(openedRequest, 'standard');
    await flushAfter();

    // Close+merge the PR.
    await handleGitHubWebhook(
      buildPullRequestWebhook({
        action: 'closed',
        prNumber: 557,
        headRef: 'feature/dedup',
        headSha: 'sha-557-1',
        state: 'closed',
        merged: true,
        deliveryId: 'delivery-closed-557',
      }),
      'standard'
    );
    await flushAfter();

    // Redeliver the *same* opened webhook (same x-github-delivery id). This
    // must be rejected as a duplicate and must NOT re-run the upsert.
    const redelivered = buildPullRequestWebhook({
      action: 'opened',
      prNumber: 557,
      headRef: 'feature/dedup',
      headSha: 'sha-557-1',
      state: 'open',
      deliveryId: 'delivery-opened-557',
    });
    const redeliveredResponse = await handleGitHubWebhook(redelivered, 'standard');
    expect(redeliveredResponse.status).toBe(200);
    const body = (await redeliveredResponse.json()) as { message: string };
    expect(body.message).toBe('Duplicate event');

    const rows = await readRow('feature/dedup');
    // pr_state stays `merged` because the duplicate `opened` never reached
    // the upsert.
    expect(rows[0].pr_state).toBe('merged');
  });
});

describe('handleGitHubWebhook — pull_request_review dispatch to upsertCliSessionPullRequestReviewFromWebhook', () => {
  const REPO = 'acme/widgets-review';
  const NORMALIZED_GIT_URL = `https://github.com/${REPO}`;
  const INSTALLATION_ID = '424243';

  let testUserId: string;
  let integrationId: string;
  const userIdsToCleanup: string[] = [];
  const sessionIdsToCleanup: string[] = [];
  let sessionCounter = 0;

  async function seedSession(branch: string, platform = 'cloud-agent-web') {
    const sessionId = `ses_test_wh_review_${Date.now()}_${sessionCounter++}`;
    await db.insert(cli_sessions_v2).values({
      session_id: sessionId,
      kilo_user_id: testUserId,
      organization_id: null,
      git_url: NORMALIZED_GIT_URL,
      git_branch: branch,
      created_on_platform: platform,
    });
    sessionIdsToCleanup.push(sessionId);
    return sessionId;
  }

  async function seedPrCacheRow(branch: string) {
    await db.insert(github_branch_pull_requests).values({
      git_url: NORMALIZED_GIT_URL,
      git_branch: branch,
      owned_by_user_id: testUserId,
      pr_url: `https://github.com/${REPO}/pull/1`,
      pr_number: 1,
      pr_state: 'open',
    });
  }

  async function readReviewRow(branch: string) {
    return db
      .select()
      .from(github_branch_pull_requests)
      .where(
        and(
          eq(github_branch_pull_requests.git_url, NORMALIZED_GIT_URL),
          eq(github_branch_pull_requests.git_branch, branch),
          eq(github_branch_pull_requests.owned_by_user_id, testUserId)
        )
      );
  }

  function buildPullRequestReviewWebhook(opts: {
    action: 'submitted' | 'edited' | 'dismissed';
    prNumber: number;
    branch: string;
    deliveryId: string;
  }): NextRequest {
    const payload = {
      action: opts.action,
      review: { id: 1, state: 'approved', user: { login: 'reviewer' } },
      pull_request: {
        number: opts.prNumber,
        state: 'open',
        html_url: `https://github.com/${REPO}/pull/${opts.prNumber}`,
        title: 'Test review PR',
        head: {
          sha: 'sha-review-test',
          ref: opts.branch,
          repo: {
            full_name: REPO,
            clone_url: `https://github.com/${REPO}.git`,
            html_url: `https://github.com/${REPO}`,
          },
        },
      },
      repository: {
        id: 1,
        name: 'widgets-review',
        full_name: REPO,
        owner: { login: 'acme' },
      },
      installation: { id: Number(INSTALLATION_ID) },
    };

    return new NextRequest('http://localhost/api/webhooks/github', {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request_review',
        'x-github-delivery': opts.deliveryId,
        'x-hub-signature-256': 'sha256=mocked',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }

  beforeAll(async () => {
    const user = await insertTestUser();
    testUserId = user.id;
    userIdsToCleanup.push(testUserId);

    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: testUserId,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: INSTALLATION_ID,
        github_app_type: 'standard',
      })
      .returning();
    integrationId = integration.id;
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
    await db.delete(platform_integrations).where(eq(platform_integrations.id, integrationId));
  });

  it('routes a pull_request_review webhook and updates pr_review_decision on the cache row', async () => {
    const branch = 'feature/review-dispatch';
    await seedSession(branch);
    await seedPrCacheRow(branch);

    const response = await handleGitHubWebhook(
      buildPullRequestReviewWebhook({
        action: 'submitted',
        prNumber: 1,
        branch,
        deliveryId: 'delivery-review-dispatch-1',
      }),
      'standard'
    );

    expect(response.status).toBe(200);

    // Wait for the after() callback to complete before asserting on the DB.
    await flushAfter();

    const rows = await readReviewRow(branch);
    expect(rows).toHaveLength(1);
    // The adapter mock returns null for fetchPullRequestReviewDecision, so
    // pr_review_decision is stored as null — the important thing is the UPDATE ran.
    expect(rows[0].pr_review_decision).toBeNull();
  });

  it('deduplicates redelivered pull_request_review webhooks', async () => {
    const branch = 'feature/review-dedup';
    await seedSession(branch);
    await seedPrCacheRow(branch);

    const firstResponse = await handleGitHubWebhook(
      buildPullRequestReviewWebhook({
        action: 'submitted',
        prNumber: 1,
        branch,
        deliveryId: 'delivery-review-dedup-1',
      }),
      'standard'
    );
    expect(firstResponse.status).toBe(200);

    // Redeliver the same event — must be rejected as duplicate.
    const redelivered = await handleGitHubWebhook(
      buildPullRequestReviewWebhook({
        action: 'submitted',
        prNumber: 1,
        branch,
        deliveryId: 'delivery-review-dedup-1',
      }),
      'standard'
    );
    expect(redelivered.status).toBe(200);
    const body = (await redelivered.json()) as { message: string };
    expect(body.message).toBe('Duplicate event');
  });
});
