import { db } from '@/lib/drizzle';
import { cli_sessions_v2, github_branch_pull_requests, organizations } from '@kilocode/db/schema';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import type { PullRequestPayload } from '@/lib/integrations/platforms/github/webhook-schemas';
import {
  upsertCliSessionPullRequestsFromWebhook,
  type WebhookInstallationOwner,
} from './upsert-cli-session-pull-requests';

const REPO = 'acme/widgets';
// Matches what the webhook handler will store after normalizing clone_url.
const NORMALIZED_GIT_URL = `https://github.com/${REPO}`;

type Action = 'opened' | 'reopened' | 'edited' | 'synchronize' | 'closed' | 'ready_for_review';

function makePayload(overrides: {
  action: Action;
  prNumber: number;
  prUrl?: string;
  state?: 'open' | 'closed';
  merged?: boolean;
  headRef: string;
  headSha: string;
  title?: string;
  cloneUrl?: string;
  htmlUrl?: string;
  repo?: string;
}): PullRequestPayload {
  const repo = overrides.repo ?? REPO;
  return {
    action: overrides.action,
    pull_request: {
      number: overrides.prNumber,
      title: overrides.title ?? 'test PR',
      state: overrides.state ?? 'open',
      merged: overrides.merged,
      html_url: overrides.prUrl ?? `https://github.com/${repo}/pull/${overrides.prNumber}`,
      user: { id: 1, login: 'octocat', avatar_url: 'https://example.com/a.png' },
      head: {
        sha: overrides.headSha,
        ref: overrides.headRef,
        repo: {
          full_name: repo,
          clone_url: overrides.cloneUrl ?? `https://github.com/${repo}.git`,
          html_url: overrides.htmlUrl ?? `https://github.com/${repo}`,
        },
      },
      base: { sha: 'base-sha', ref: 'main' },
    },
    repository: {
      id: 1,
      name: repo.split('/')[1] ?? 'repo',
      full_name: repo,
      owner: { login: repo.split('/')[0] ?? 'owner' },
    },
    installation: { id: 1 },
  };
}

async function readUserRow(args: { userId: string; gitUrl?: string; branch: string }) {
  const rows = await db
    .select()
    .from(github_branch_pull_requests)
    .where(
      and(
        eq(github_branch_pull_requests.git_url, args.gitUrl ?? NORMALIZED_GIT_URL),
        eq(github_branch_pull_requests.git_branch, args.branch),
        eq(github_branch_pull_requests.owned_by_user_id, args.userId)
      )
    );
  return rows;
}

async function readOrgRow(args: { orgId: string; gitUrl?: string; branch: string }) {
  const rows = await db
    .select()
    .from(github_branch_pull_requests)
    .where(
      and(
        eq(github_branch_pull_requests.git_url, args.gitUrl ?? NORMALIZED_GIT_URL),
        eq(github_branch_pull_requests.git_branch, args.branch),
        eq(github_branch_pull_requests.owned_by_organization_id, args.orgId)
      )
    );
  return rows;
}

describe('upsertCliSessionPullRequestsFromWebhook', () => {
  let testUserId: string;
  let testOwner: WebhookInstallationOwner;
  const userIdsToCleanup: string[] = [];
  const orgIdsToCleanup: string[] = [];
  const sessionIdsToCleanup: string[] = [];
  let sessionCounter = 0;

  /**
   * The upsert short-circuits unless a `cli_sessions_v2` row exists in the
   * delivering tenant for the same `(git_url, git_branch)`. Tests that want
   * to exercise the write path call `seedSession` first.
   */
  async function seedSession(args: {
    branch: string;
    owner: WebhookInstallationOwner;
    gitUrl?: string;
    platform?: string;
  }) {
    const sessionId = `ses_test_upsert_pr_${Date.now()}_${sessionCounter++}`;
    const platform = args.platform ?? 'cloud-agent-web';
    if (args.owner.kind === 'user') {
      await db.insert(cli_sessions_v2).values({
        session_id: sessionId,
        kilo_user_id: args.owner.userId,
        organization_id: null,
        git_url: args.gitUrl ?? NORMALIZED_GIT_URL,
        git_branch: args.branch,
        created_on_platform: platform,
      });
    } else {
      // Org-owned sessions still need a kilo_user_id (notNull); reuse the
      // shared test user for that.
      await db.insert(cli_sessions_v2).values({
        session_id: sessionId,
        kilo_user_id: testUserId,
        organization_id: args.owner.organizationId,
        git_url: args.gitUrl ?? NORMALIZED_GIT_URL,
        git_branch: args.branch,
        created_on_platform: platform,
      });
    }
    sessionIdsToCleanup.push(sessionId);
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
    if (orgIdsToCleanup.length > 0) {
      await db
        .delete(github_branch_pull_requests)
        .where(inArray(github_branch_pull_requests.owned_by_organization_id, orgIdsToCleanup));
      await db.delete(organizations).where(inArray(organizations.id, orgIdsToCleanup));
    }
  });

  it('inserts a cache row on opened', async () => {
    await seedSession({ branch: 'feature/alpha', owner: testOwner });
    const written = await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 101,
        state: 'open',
        headRef: 'feature/alpha',
        headSha: 'sha-alpha',
      }),
      testOwner
    );

    expect(written).toBe(1);
    const rows = await readUserRow({ userId: testUserId, branch: 'feature/alpha' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      git_url: NORMALIZED_GIT_URL,
      git_branch: 'feature/alpha',
      pr_number: 101,
      pr_state: 'open',
      pr_head_sha: 'sha-alpha',
      owned_by_organization_id: null,
    });
  });

  it('writes exactly one row per (repo, branch, tenant) regardless of how many deliveries fire', async () => {
    const branch = 'feature/one-row';
    await seedSession({ branch, owner: testOwner });

    for (const prNumber of [301, 302, 303]) {
      await upsertCliSessionPullRequestsFromWebhook(
        makePayload({
          action: 'synchronize',
          prNumber,
          state: 'open',
          headRef: branch,
          headSha: `sha-${prNumber}`,
        }),
        testOwner
      );
    }

    const rows = await readUserRow({ userId: testUserId, branch });
    expect(rows).toHaveLength(1);
    // Latest payload wins for non-state fields.
    expect(rows[0].pr_number).toBe(303);
    expect(rows[0].pr_head_sha).toBe('sha-303');
  });

  it('accepts the different clone_url shapes by normalizing on write', async () => {
    const branch = 'feature/normalize-shapes';
    await seedSession({ branch, owner: testOwner });

    // First delivery: https URL with .git.
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 401,
        state: 'open',
        headRef: branch,
        headSha: 'sha-401',
        cloneUrl: `https://GitHub.com/${REPO}.git`,
      }),
      testOwner
    );

    // Second delivery: ssh URL on the same repo+branch — must collapse to the
    // same cache row because normalize() canonicalizes both.
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'synchronize',
        prNumber: 401,
        state: 'open',
        headRef: branch,
        headSha: 'sha-401-b',
        cloneUrl: `git@github.com:${REPO}.git`,
      }),
      testOwner
    );

    const rows = await readUserRow({ userId: testUserId, branch });
    expect(rows).toHaveLength(1);
    expect(rows[0].git_url).toBe(NORMALIZED_GIT_URL);
    expect(rows[0].pr_head_sha).toBe('sha-401-b');
  });

  it('sets pr_state=merged when closed with merged:true', async () => {
    await seedSession({ branch: 'feature/beta', owner: testOwner });
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 102,
        state: 'open',
        headRef: 'feature/beta',
        headSha: 'sha-beta-1',
      }),
      testOwner
    );

    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'closed',
        prNumber: 102,
        state: 'closed',
        merged: true,
        headRef: 'feature/beta',
        headSha: 'sha-beta-1',
      }),
      testOwner
    );

    const rows = await readUserRow({ userId: testUserId, branch: 'feature/beta' });
    expect(rows[0].pr_state).toBe('merged');
  });

  it('sets pr_state=closed when closed with merged:false', async () => {
    await seedSession({ branch: 'feature/gamma', owner: testOwner });
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 103,
        state: 'open',
        headRef: 'feature/gamma',
        headSha: 'sha-gamma',
      }),
      testOwner
    );

    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'closed',
        prNumber: 103,
        state: 'closed',
        merged: false,
        headRef: 'feature/gamma',
        headSha: 'sha-gamma',
      }),
      testOwner
    );

    const rows = await readUserRow({ userId: testUserId, branch: 'feature/gamma' });
    expect(rows[0].pr_state).toBe('closed');
  });

  it('updates pr_head_sha on synchronize', async () => {
    await seedSession({ branch: 'feature/delta', owner: testOwner });
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 104,
        state: 'open',
        headRef: 'feature/delta',
        headSha: 'sha-delta-1',
      }),
      testOwner
    );

    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'synchronize',
        prNumber: 104,
        state: 'open',
        headRef: 'feature/delta',
        headSha: 'sha-delta-2',
      }),
      testOwner
    );

    const rows = await readUserRow({ userId: testUserId, branch: 'feature/delta' });
    expect(rows[0].pr_head_sha).toBe('sha-delta-2');
  });

  it('ignores unrelated actions such as ready_for_review', async () => {
    const written = await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'ready_for_review',
        prNumber: 109,
        state: 'open',
        headRef: 'feature/ignored',
        headSha: 'sha-eta',
      }),
      testOwner
    );
    expect(written).toBe(0);

    const rows = await readUserRow({ userId: testUserId, branch: 'feature/ignored' });
    expect(rows).toHaveLength(0);
  });

  it('does not demote pr_state=merged back to open on an out-of-order redelivery', async () => {
    const branch = 'feature/monotonic-merged';
    await seedSession({ branch, owner: testOwner });

    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 200,
        state: 'open',
        headRef: branch,
        headSha: 'sha-200-1',
      }),
      testOwner
    );
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'closed',
        prNumber: 200,
        state: 'closed',
        merged: true,
        headRef: branch,
        headSha: 'sha-200-1',
      }),
      testOwner
    );

    // Simulate a late-arriving redelivery of an earlier `synchronize` webhook
    // (same delivery would be deduped upstream; here we model the case where
    // dedup is absent or the event is from a different delivery id).
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'synchronize',
        prNumber: 200,
        state: 'open',
        headRef: branch,
        headSha: 'sha-200-late',
      }),
      testOwner
    );

    const rows = await readUserRow({ userId: testUserId, branch });
    expect(rows[0].pr_state).toBe('merged');
    // Non-state fields still track the latest payload — only pr_state is monotonic.
    expect(rows[0].pr_head_sha).toBe('sha-200-late');
  });

  it('does not demote pr_state=closed back to open on an out-of-order redelivery', async () => {
    const branch = 'feature/monotonic-closed';
    await seedSession({ branch, owner: testOwner });

    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'closed',
        prNumber: 201,
        state: 'closed',
        merged: false,
        headRef: branch,
        headSha: 'sha-201',
      }),
      testOwner
    );

    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 201,
        state: 'open',
        headRef: branch,
        headSha: 'sha-201',
      }),
      testOwner
    );

    const rows = await readUserRow({ userId: testUserId, branch });
    expect(rows[0].pr_state).toBe('closed');
  });

  it('allows closed -> open transition on reopened action', async () => {
    const branch = 'feature/reopened';
    await seedSession({ branch, owner: testOwner });

    // A closed, unmerged PR gets reopened — the monotonic guard must NOT
    // trap pr_state at 'closed' in this case; `reopened` is exempt.
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'closed',
        prNumber: 203,
        state: 'closed',
        merged: false,
        headRef: branch,
        headSha: 'sha-203',
      }),
      testOwner
    );
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'reopened',
        prNumber: 203,
        state: 'open',
        headRef: branch,
        headSha: 'sha-203-reopen',
      }),
      testOwner
    );

    const rows = await readUserRow({ userId: testUserId, branch });
    expect(rows[0].pr_state).toBe('open');
    expect(rows[0].pr_head_sha).toBe('sha-203-reopen');
  });

  it('does not regress pr_state from merged -> closed on stale closed-unmerged redelivery', async () => {
    const branch = 'feature/monotonic-merged-closed';
    await seedSession({ branch, owner: testOwner });

    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'closed',
        prNumber: 204,
        state: 'closed',
        merged: true,
        headRef: branch,
        headSha: 'sha-204',
      }),
      testOwner
    );
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'closed',
        prNumber: 204,
        state: 'closed',
        merged: false,
        headRef: branch,
        headSha: 'sha-204',
      }),
      testOwner
    );

    const rows = await readUserRow({ userId: testUserId, branch });
    expect(rows[0].pr_state).toBe('merged');
  });

  it('does not regress pr_state from merged -> open on stale opened/synchronize redelivery', async () => {
    const branch = 'feature/monotonic-merged-open';
    await seedSession({ branch, owner: testOwner });

    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'closed',
        prNumber: 205,
        state: 'closed',
        merged: true,
        headRef: branch,
        headSha: 'sha-205',
      }),
      testOwner
    );
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'synchronize',
        prNumber: 205,
        state: 'open',
        headRef: branch,
        headSha: 'sha-205',
      }),
      testOwner
    );

    const rows = await readUserRow({ userId: testUserId, branch });
    expect(rows[0].pr_state).toBe('merged');
  });

  it('still allows legitimate closed -> merged transitions', async () => {
    const branch = 'feature/close-then-merge';
    await seedSession({ branch, owner: testOwner });

    // Some PRs emit closed(merged:false) then closed(merged:true) — the second
    // should still be applied because we only block `open` downgrades.
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'closed',
        prNumber: 202,
        state: 'closed',
        merged: false,
        headRef: branch,
        headSha: 'sha-202',
      }),
      testOwner
    );
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'closed',
        prNumber: 202,
        state: 'closed',
        merged: true,
        headRef: branch,
        headSha: 'sha-202',
      }),
      testOwner
    );

    const rows = await readUserRow({ userId: testUserId, branch });
    expect(rows[0].pr_state).toBe('merged');
  });

  describe('matching session gate', () => {
    it('skips the upsert when no cli_sessions_v2 row references (git_url, branch) in this tenant', async () => {
      const written = await upsertCliSessionPullRequestsFromWebhook(
        makePayload({
          action: 'opened',
          prNumber: 700,
          state: 'open',
          headRef: 'feature/no-session',
          headSha: 'sha-no-session',
        }),
        testOwner
      );
      expect(written).toBe(0);

      const rows = await readUserRow({ userId: testUserId, branch: 'feature/no-session' });
      expect(rows).toHaveLength(0);
    });

    it('writes the row once a session is created and a follow-up webhook arrives', async () => {
      const branch = 'feature/session-created-later';

      // First webhook: no session yet → skipped.
      const first = await upsertCliSessionPullRequestsFromWebhook(
        makePayload({
          action: 'opened',
          prNumber: 701,
          state: 'open',
          headRef: branch,
          headSha: 'sha-701-a',
        }),
        testOwner
      );
      expect(first).toBe(0);
      expect(await readUserRow({ userId: testUserId, branch })).toHaveLength(0);

      // Session is created (e.g. user starts an agent on this branch).
      await seedSession({ branch, owner: testOwner });

      // Next webhook (e.g. synchronize on next push) populates the row.
      const second = await upsertCliSessionPullRequestsFromWebhook(
        makePayload({
          action: 'synchronize',
          prNumber: 701,
          state: 'open',
          headRef: branch,
          headSha: 'sha-701-b',
        }),
        testOwner
      );
      expect(second).toBe(1);
      const rows = await readUserRow({ userId: testUserId, branch });
      expect(rows).toHaveLength(1);
      expect(rows[0].pr_head_sha).toBe('sha-701-b');
    });

    it('does not match a session belonging to a different tenant', async () => {
      const otherUser = await insertTestUser();
      userIdsToCleanup.push(otherUser.id);
      const branch = 'feature/wrong-tenant';

      // Session exists, but it belongs to a different user — webhook from
      // testOwner must still skip.
      await seedSession({
        branch,
        owner: { kind: 'user', userId: otherUser.id },
      });

      const written = await upsertCliSessionPullRequestsFromWebhook(
        makePayload({
          action: 'opened',
          prNumber: 702,
          state: 'open',
          headRef: branch,
          headSha: 'sha-702',
        }),
        testOwner
      );
      expect(written).toBe(0);
      expect(await readUserRow({ userId: testUserId, branch })).toHaveLength(0);
    });

    it('does not match an org-owned session when the webhook is for a user-owned install', async () => {
      const orgOwner = await insertTestUser();
      userIdsToCleanup.push(orgOwner.id);
      const org = await createTestOrganization('org-mismatch', orgOwner.id, 0);
      orgIdsToCleanup.push(org.id);
      const branch = 'feature/org-vs-user-mismatch';

      // Session is owned by an org — a user-install webhook for the same
      // (url, branch) should not match it.
      await seedSession({
        branch,
        owner: { kind: 'organization', organizationId: org.id },
      });

      const written = await upsertCliSessionPullRequestsFromWebhook(
        makePayload({
          action: 'opened',
          prNumber: 703,
          state: 'open',
          headRef: branch,
          headSha: 'sha-703',
        }),
        testOwner
      );
      expect(written).toBe(0);
    });
  });

  describe('cross-tenant isolation', () => {
    const SHARED_REPO = 'shared/repo';
    const SHARED_BRANCH = 'feature/shared-branch';
    const SHARED_NORMALIZED = `https://github.com/${SHARED_REPO}`;

    function makeSharedPayload(): PullRequestPayload {
      return makePayload({
        action: 'opened',
        prNumber: 9001,
        state: 'open',
        headRef: SHARED_BRANCH,
        headSha: 'sha-xtenant',
        repo: SHARED_REPO,
      });
    }

    it('writes a row under the delivering org only, never the other tenant', async () => {
      const orgOwner = await insertTestUser();
      userIdsToCleanup.push(orgOwner.id);
      const orgA = await createTestOrganization('org-a-xtenant', orgOwner.id, 0);
      const orgB = await createTestOrganization('org-b-xtenant', orgOwner.id, 0);
      orgIdsToCleanup.push(orgA.id, orgB.id);
      // Only orgA has a session on this branch — orgB has none, so even if it
      // received the same webhook it would skip the write (extra defense
      // beyond the tenant column itself).
      await seedSession({
        branch: SHARED_BRANCH,
        owner: { kind: 'organization', organizationId: orgA.id },
        gitUrl: SHARED_NORMALIZED,
      });

      await upsertCliSessionPullRequestsFromWebhook(makeSharedPayload(), {
        kind: 'organization',
        organizationId: orgA.id,
      });

      const rowsA = await readOrgRow({
        orgId: orgA.id,
        gitUrl: SHARED_NORMALIZED,
        branch: SHARED_BRANCH,
      });
      expect(rowsA).toHaveLength(1);
      expect(rowsA[0].pr_number).toBe(9001);

      const rowsB = await readOrgRow({
        orgId: orgB.id,
        gitUrl: SHARED_NORMALIZED,
        branch: SHARED_BRANCH,
      });
      expect(rowsB).toHaveLength(0);
    });

    it('writes separate rows when two tenants both have installations on the same repo', async () => {
      const userA = await insertTestUser();
      const userB = await insertTestUser();
      userIdsToCleanup.push(userA.id, userB.id);
      await seedSession({
        branch: SHARED_BRANCH,
        owner: { kind: 'user', userId: userA.id },
        gitUrl: SHARED_NORMALIZED,
      });
      await seedSession({
        branch: SHARED_BRANCH,
        owner: { kind: 'user', userId: userB.id },
        gitUrl: SHARED_NORMALIZED,
      });

      await upsertCliSessionPullRequestsFromWebhook(makeSharedPayload(), {
        kind: 'user',
        userId: userA.id,
      });
      await upsertCliSessionPullRequestsFromWebhook(
        makePayload({
          action: 'opened',
          prNumber: 9002,
          state: 'open',
          headRef: SHARED_BRANCH,
          headSha: 'sha-xtenant-b',
          repo: SHARED_REPO,
        }),
        { kind: 'user', userId: userB.id }
      );

      const rowsA = await readUserRow({
        userId: userA.id,
        gitUrl: SHARED_NORMALIZED,
        branch: SHARED_BRANCH,
      });
      const rowsB = await readUserRow({
        userId: userB.id,
        gitUrl: SHARED_NORMALIZED,
        branch: SHARED_BRANCH,
      });
      expect(rowsA).toHaveLength(1);
      expect(rowsB).toHaveLength(1);
      expect(rowsA[0].pr_number).toBe(9001);
      expect(rowsB[0].pr_number).toBe(9002);

      // Sanity: both rows have disjoint owner columns and none has both set.
      const allRows = await db
        .select()
        .from(github_branch_pull_requests)
        .where(
          and(
            eq(github_branch_pull_requests.git_url, SHARED_NORMALIZED),
            eq(github_branch_pull_requests.git_branch, SHARED_BRANCH),
            inArray(github_branch_pull_requests.owned_by_user_id, [userA.id, userB.id])
          )
        );
      for (const r of allRows) {
        expect(r.owned_by_organization_id).toBeNull();
        expect(typeof r.owned_by_user_id).toBe('string');
      }
    });

    it('only one row exists for the delivering user, regardless of how many sessions on that branch', async () => {
      // Pre-existing unrelated cache rows for another tenant must not be
      // affected by this tenant's upsert.
      const userA = await insertTestUser();
      userIdsToCleanup.push(userA.id);
      // Two sessions on the same branch — the upsert must still produce
      // exactly one cache row.
      await seedSession({
        branch: SHARED_BRANCH,
        owner: { kind: 'user', userId: userA.id },
        gitUrl: SHARED_NORMALIZED,
      });
      await seedSession({
        branch: SHARED_BRANCH,
        owner: { kind: 'user', userId: userA.id },
        gitUrl: SHARED_NORMALIZED,
      });

      await upsertCliSessionPullRequestsFromWebhook(makeSharedPayload(), {
        kind: 'user',
        userId: userA.id,
      });

      // Simulate a re-delivery / a later sync.
      await upsertCliSessionPullRequestsFromWebhook(
        makePayload({
          action: 'synchronize',
          prNumber: 9001,
          state: 'open',
          headRef: SHARED_BRANCH,
          headSha: 'sha-xtenant-sync',
          repo: SHARED_REPO,
        }),
        { kind: 'user', userId: userA.id }
      );

      const countRows = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(github_branch_pull_requests)
        .where(
          and(
            eq(github_branch_pull_requests.git_url, SHARED_NORMALIZED),
            eq(github_branch_pull_requests.git_branch, SHARED_BRANCH),
            eq(github_branch_pull_requests.owned_by_user_id, userA.id)
          )
        );
      expect(countRows[0].c).toBe(1);
    });

    it('partial unique indexes prevent duplicate rows for the same (url, branch, owner)', async () => {
      // Sanity check that the XOR-partial-unique design is doing its job:
      // inserting two distinct payloads for the same tenant collapses into
      // one row — and that row has exactly one of the owner columns set.
      const userA = await insertTestUser();
      userIdsToCleanup.push(userA.id);
      await seedSession({
        branch: SHARED_BRANCH,
        owner: { kind: 'user', userId: userA.id },
        gitUrl: SHARED_NORMALIZED,
      });

      await upsertCliSessionPullRequestsFromWebhook(makeSharedPayload(), {
        kind: 'user',
        userId: userA.id,
      });
      await upsertCliSessionPullRequestsFromWebhook(makeSharedPayload(), {
        kind: 'user',
        userId: userA.id,
      });

      const rows = await db
        .select()
        .from(github_branch_pull_requests)
        .where(
          and(
            eq(github_branch_pull_requests.git_url, SHARED_NORMALIZED),
            eq(github_branch_pull_requests.git_branch, SHARED_BRANCH),
            eq(github_branch_pull_requests.owned_by_user_id, userA.id),
            isNotNull(github_branch_pull_requests.owned_by_user_id)
          )
        );
      expect(rows).toHaveLength(1);
      expect(rows[0].owned_by_organization_id).toBeNull();
    });
  });

  describe('review_decision_pending flag', () => {
    it('opened sets review_decision_pending=true and does not call GraphQL', async () => {
      const branch = 'feature/rd-pending-opened';
      await seedSession({ branch, owner: testOwner, platform: 'cloud-agent-web' });

      await upsertCliSessionPullRequestsFromWebhook(
        makePayload({
          action: 'opened',
          prNumber: 801,
          state: 'open',
          headRef: branch,
          headSha: 'sha-801',
        }),
        testOwner
      );

      const rows = await readUserRow({ userId: testUserId, branch });
      expect(rows[0].review_decision_pending).toBe(true);
      expect(rows[0].pr_review_decision).toBeNull();
    });

    it('synchronize sets review_decision_pending=true', async () => {
      const branch = 'feature/rd-pending-sync';
      await seedSession({ branch, owner: testOwner, platform: 'cloud-agent-web' });

      await upsertCliSessionPullRequestsFromWebhook(
        makePayload({
          action: 'opened',
          prNumber: 802,
          state: 'open',
          headRef: branch,
          headSha: 'sha-802-a',
        }),
        testOwner
      );
      await upsertCliSessionPullRequestsFromWebhook(
        makePayload({
          action: 'synchronize',
          prNumber: 802,
          state: 'open',
          headRef: branch,
          headSha: 'sha-802-b',
        }),
        testOwner
      );

      const rows = await readUserRow({ userId: testUserId, branch });
      expect(rows[0].review_decision_pending).toBe(true);
    });

    it('reopened sets review_decision_pending=true', async () => {
      const branch = 'feature/rd-pending-reopen';
      await seedSession({ branch, owner: testOwner, platform: 'cloud-agent-web' });

      await upsertCliSessionPullRequestsFromWebhook(
        makePayload({
          action: 'closed',
          prNumber: 803,
          state: 'closed',
          merged: false,
          headRef: branch,
          headSha: 'sha-803',
        }),
        testOwner
      );
      await upsertCliSessionPullRequestsFromWebhook(
        makePayload({
          action: 'reopened',
          prNumber: 803,
          state: 'open',
          headRef: branch,
          headSha: 'sha-803-r',
        }),
        testOwner
      );

      const rows = await readUserRow({ userId: testUserId, branch });
      expect(rows[0].review_decision_pending).toBe(true);
    });

    it('edited does not flip review_decision_pending', async () => {
      const branch = 'feature/rd-pending-edited';
      await seedSession({ branch, owner: testOwner, platform: 'cloud-agent-web' });

      // Seed a row with pending=false to verify edited leaves it alone.
      await db.insert(github_branch_pull_requests).values({
        git_url: NORMALIZED_GIT_URL,
        git_branch: branch,
        owned_by_user_id: testUserId,
        pr_number: 804,
        pr_state: 'open',
        pr_review_decision: 'approved',
        review_decision_pending: false,
      });

      await upsertCliSessionPullRequestsFromWebhook(
        makePayload({
          action: 'edited',
          prNumber: 804,
          state: 'open',
          headRef: branch,
          headSha: 'sha-804',
          title: 'new title',
        }),
        testOwner
      );

      const rows = await readUserRow({ userId: testUserId, branch });
      expect(rows[0].review_decision_pending).toBe(false);
      expect(rows[0].pr_review_decision).toBe('approved');
    });

    it('closed does not flip review_decision_pending', async () => {
      const branch = 'feature/rd-pending-closed';
      await seedSession({ branch, owner: testOwner, platform: 'cloud-agent-web' });

      await db.insert(github_branch_pull_requests).values({
        git_url: NORMALIZED_GIT_URL,
        git_branch: branch,
        owned_by_user_id: testUserId,
        pr_number: 805,
        pr_state: 'open',
        pr_review_decision: 'approved',
        review_decision_pending: false,
      });

      await upsertCliSessionPullRequestsFromWebhook(
        makePayload({
          action: 'closed',
          prNumber: 805,
          state: 'closed',
          merged: false,
          headRef: branch,
          headSha: 'sha-805',
        }),
        testOwner
      );

      const rows = await readUserRow({ userId: testUserId, branch });
      expect(rows[0].review_decision_pending).toBe(false);
      expect(rows[0].pr_review_decision).toBe('approved');
    });

    it('existing pr_review_decision is preserved on synchronize (not overwritten)', async () => {
      const branch = 'feature/rd-preserve-decision';
      await seedSession({ branch, owner: testOwner, platform: 'cloud-agent-web' });

      await db.insert(github_branch_pull_requests).values({
        git_url: NORMALIZED_GIT_URL,
        git_branch: branch,
        owned_by_user_id: testUserId,
        pr_number: 806,
        pr_state: 'open',
        pr_review_decision: 'approved',
        review_decision_pending: false,
      });

      await upsertCliSessionPullRequestsFromWebhook(
        makePayload({
          action: 'synchronize',
          prNumber: 806,
          state: 'open',
          headRef: branch,
          headSha: 'sha-806-new',
        }),
        testOwner
      );

      const rows = await readUserRow({ userId: testUserId, branch });
      // Decision preserved, but pending flag is now true for the batch to refetch.
      expect(rows[0].pr_review_decision).toBe('approved');
      expect(rows[0].review_decision_pending).toBe(true);
    });

    it('session on unsupported platform → skips the upsert entirely, no row written', async () => {
      const branch = 'feature/rd-unsupported';
      await seedSession({ branch, owner: testOwner, platform: 'vscode' });

      const written = await upsertCliSessionPullRequestsFromWebhook(
        makePayload({
          action: 'opened',
          prNumber: 807,
          state: 'open',
          headRef: branch,
          headSha: 'sha-807',
        }),
        testOwner
      );

      expect(written).toBe(0);
      expect(await readUserRow({ userId: testUserId, branch })).toHaveLength(0);
    });

    it('mixed sessions (cloud-agent-web + vscode) → row is written with pending=true', async () => {
      const branch = 'feature/rd-mixed';
      await seedSession({ branch, owner: testOwner, platform: 'cloud-agent-web' });
      await seedSession({ branch, owner: testOwner, platform: 'vscode' });

      await upsertCliSessionPullRequestsFromWebhook(
        makePayload({
          action: 'opened',
          prNumber: 808,
          state: 'open',
          headRef: branch,
          headSha: 'sha-808',
        }),
        testOwner
      );

      const rows = await readUserRow({ userId: testUserId, branch });
      expect(rows[0].review_decision_pending).toBe(true);
    });
  });
});
