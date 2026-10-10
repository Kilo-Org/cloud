import { db } from '@kilocode/web-shared/lib/drizzle';
import { cli_sessions_v2, github_branch_pull_requests, organizations } from '@kilocode/db/schema';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import type { PullRequestPayload } from '@/lib/integrations/platforms/github/webhook-schemas';
import {
  upsertCliSessionPullRequestsFromWebhook,
  type WebhookInstallationOwner,
} from './upsert-cli-session-pull-requests';

const REPO = 'acme/widgets';
// Matches what the webhook handler will store after normalizing clone_url.
const NORMALIZED_GIT_URL = `https://github.com/${REPO}`;

type Action =
  | 'opened'
  | 'reopened'
  | 'edited'
  | 'synchronize'
  | 'closed'
  | 'ready_for_review'
  | 'converted_to_draft';

function makePayload(overrides: {
  action: Action;
  prNumber: number;
  prUrl?: string;
  state?: 'open' | 'closed';
  merged?: boolean;
  draft?: boolean;
  headRef: string;
  headSha: string;
  title?: string;
  cloneUrl?: string;
  htmlUrl?: string;
  /** Base repository full name. */
  repo?: string;
  /** Head repository full name — set to a fork to model a cross-repo PR. */
  headRepo?: string;
}): PullRequestPayload {
  const repo = overrides.repo ?? REPO;
  const headRepo = overrides.headRepo ?? repo;
  return {
    action: overrides.action,
    pull_request: {
      number: overrides.prNumber,
      title: overrides.title ?? 'test PR',
      state: overrides.state ?? 'open',
      merged: overrides.merged,
      draft: overrides.draft,
      html_url: overrides.prUrl ?? `https://github.com/${repo}/pull/${overrides.prNumber}`,
      user: { id: 1, login: 'octocat', avatar_url: 'https://example.com/a.png', type: 'User' },
      head: {
        sha: overrides.headSha,
        ref: overrides.headRef,
        repo: {
          full_name: headRepo,
          clone_url: overrides.cloneUrl ?? `https://github.com/${headRepo}.git`,
          html_url: overrides.htmlUrl ?? `https://github.com/${headRepo}`,
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

async function readUserRow(args: { userId: string; prNumber: number; gitUrl?: string }) {
  return db
    .select()
    .from(github_branch_pull_requests)
    .where(
      and(
        eq(github_branch_pull_requests.git_url, args.gitUrl ?? NORMALIZED_GIT_URL),
        eq(github_branch_pull_requests.pr_number, args.prNumber),
        eq(github_branch_pull_requests.owned_by_user_id, args.userId)
      )
    );
}

async function readOrgRow(args: { orgId: string; prNumber: number; gitUrl?: string }) {
  return db
    .select()
    .from(github_branch_pull_requests)
    .where(
      and(
        eq(github_branch_pull_requests.git_url, args.gitUrl ?? NORMALIZED_GIT_URL),
        eq(github_branch_pull_requests.pr_number, args.prNumber),
        eq(github_branch_pull_requests.owned_by_organization_id, args.orgId)
      )
    );
}

describe('upsertCliSessionPullRequestsFromWebhook', () => {
  let testUserId: string;
  let testOwner: WebhookInstallationOwner;
  const userIdsToCleanup: string[] = [];
  const orgIdsToCleanup: string[] = [];
  const sessionIdsToCleanup: string[] = [];
  let sessionCounter = 0;

  /**
   * Seed a session that verifiably links `prNumber` on `(gitUrl, branch)`.
   *
   * `prHeadSha` defaults to null: the older-CLI fallback matches on the stored
   * head ref, which keeps state-machine tests robust to changing payload SHAs.
   * Tests that exercise SHA evidence pass an explicit `prHeadSha`.
   */
  async function seedSession(args: {
    branch: string;
    owner: WebhookInstallationOwner;
    prNumber: number;
    gitUrl?: string;
    platform?: string;
    prHeadRef?: string | null;
    prHeadSha?: string | null;
  }) {
    const sessionId = `ses_test_upsert_pr_${Date.now()}_${sessionCounter++}`;
    const gitUrl = args.gitUrl ?? NORMALIZED_GIT_URL;
    const ownerUserId = args.owner.kind === 'user' ? args.owner.userId : testUserId;
    await db.insert(cli_sessions_v2).values({
      session_id: sessionId,
      kilo_user_id: ownerUserId,
      organization_id: args.owner.kind === 'organization' ? args.owner.organizationId : null,
      git_url: gitUrl,
      git_branch: args.branch,
      created_on_platform: args.platform ?? 'cloud-agent-web',
      pr_url: `${gitUrl}/pull/${args.prNumber}`,
      pr_number: args.prNumber,
      pr_head_ref: args.prHeadRef === undefined ? args.branch : args.prHeadRef,
      pr_head_sha: args.prHeadSha ?? null,
    });
    sessionIdsToCleanup.push(sessionId);
    return sessionId;
  }

  async function sessionVerifiedAt(sessionId: string) {
    const [row] = await db
      .select({ verified: cli_sessions_v2.pr_link_verified_at })
      .from(cli_sessions_v2)
      .where(eq(cli_sessions_v2.session_id, sessionId));
    return row?.verified ?? null;
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

  it('inserts a cache row on opened and marks the linking session verified', async () => {
    const sessionId = await seedSession({
      branch: 'feature/alpha',
      owner: testOwner,
      prNumber: 101,
    });
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
    const rows = await readUserRow({ userId: testUserId, prNumber: 101 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      git_url: NORMALIZED_GIT_URL,
      git_branch: 'feature/alpha',
      pr_number: 101,
      pr_state: 'open',
      pr_head_sha: 'sha-alpha',
      owned_by_organization_id: null,
    });
    expect(await sessionVerifiedAt(sessionId)).not.toBeNull();
  });

  it('matches on the stored head SHA when the session reported one', async () => {
    const sessionId = await seedSession({
      branch: 'feature/sha-evidence',
      owner: testOwner,
      prNumber: 120,
      prHeadSha: 'sha-evidence',
    });

    const written = await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 120,
        headRef: 'feature/sha-evidence',
        headSha: 'sha-evidence',
      }),
      testOwner
    );

    expect(written).toBe(1);
    expect((await readUserRow({ userId: testUserId, prNumber: 120 }))[0].pr_head_sha).toBe(
      'sha-evidence'
    );
    expect(await sessionVerifiedAt(sessionId)).not.toBeNull();
  });

  it('verifies a legacy session that stored no head ref or sha via its branch', async () => {
    // Pre-headRef CLI: the stored link has neither pr_head_ref nor pr_head_sha.
    // The session's own PR number/repo match and its branch is the webhook head
    // ref, so it must still be marked verified (otherwise its badge can never
    // appear without a manual refresh).
    const sessionId = await seedSession({
      branch: 'feature/legacy-evidence',
      owner: testOwner,
      prNumber: 123,
      prHeadRef: null,
      prHeadSha: null,
    });

    const written = await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 123,
        headRef: 'feature/legacy-evidence',
        headSha: 'sha-legacy-1',
      }),
      testOwner
    );

    expect(written).toBe(1);
    expect(await sessionVerifiedAt(sessionId)).not.toBeNull();
  });

  it('does not verify a legacy session when the webhook head ref is another branch', async () => {
    const sessionId = await seedSession({
      branch: 'feature/legacy-branch',
      owner: testOwner,
      prNumber: 124,
      prHeadRef: null,
      prHeadSha: null,
    });

    const written = await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 124,
        headRef: 'feature/someone-else',
        headSha: 'sha-other',
      }),
      testOwner
    );

    expect(written).toBe(0);
    expect(await sessionVerifiedAt(sessionId)).toBeNull();
  });

  it('does not match when the stored head SHA differs from the payload head SHA', async () => {
    const sessionId = await seedSession({
      branch: 'feature/sha-mismatch',
      owner: testOwner,
      prNumber: 121,
      prHeadSha: 'sha-stored',
    });

    const written = await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'synchronize',
        prNumber: 121,
        headRef: 'feature/sha-mismatch',
        headSha: 'sha-other-commit',
      }),
      testOwner
    );

    expect(written).toBe(0);
    expect(await readUserRow({ userId: testUserId, prNumber: 121 })).toHaveLength(0);
    expect(await sessionVerifiedAt(sessionId)).toBeNull();
  });

  it('inserts a draft state for an opened draft pull request', async () => {
    const branch = 'feature/draft-open';
    await seedSession({ branch, owner: testOwner, prNumber: 110 });

    const written = await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 110,
        state: 'open',
        draft: true,
        headRef: branch,
        headSha: 'sha-draft-open',
      }),
      testOwner
    );

    expect(written).toBe(1);
    const rows = await readUserRow({ userId: testUserId, prNumber: 110 });
    expect(rows[0].pr_state).toBe('draft');
  });

  it('keys the cache by PR identity: re-deliveries collapse, a new PR is a new row', async () => {
    const branch = 'feature/one-row';
    await seedSession({ branch, owner: testOwner, prNumber: 301 });
    await seedSession({ branch, owner: testOwner, prNumber: 302 });

    // Two deliveries for the same PR must collapse to one row.
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 301,
        state: 'open',
        headRef: branch,
        headSha: 'sha-301-a',
      }),
      testOwner
    );
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'synchronize',
        prNumber: 301,
        state: 'open',
        headRef: branch,
        headSha: 'sha-301-b',
      }),
      testOwner
    );

    const rows301 = await readUserRow({ userId: testUserId, prNumber: 301 });
    expect(rows301).toHaveLength(1);
    expect(rows301[0].pr_head_sha).toBe('sha-301-b');

    // A different PR on the same branch is its own identity, not an overwrite.
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 302,
        state: 'open',
        headRef: branch,
        headSha: 'sha-302',
      }),
      testOwner
    );
    const rows302 = await readUserRow({ userId: testUserId, prNumber: 302 });
    expect(rows302).toHaveLength(1);
    expect(rows301).toHaveLength(1);
    expect(rows301[0].pr_number).toBe(301);
  });

  it('accepts the different clone_url shapes by normalizing on write', async () => {
    const branch = 'feature/normalize-shapes';
    await seedSession({ branch, owner: testOwner, prNumber: 401 });

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

    // Second delivery: ssh URL on the same repo+PR — must collapse to the same
    // cache row because the repo normalizes to the same identity.
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

    const rows = await readUserRow({ userId: testUserId, prNumber: 401 });
    expect(rows).toHaveLength(1);
    expect(rows[0].git_url).toBe(NORMALIZED_GIT_URL);
    expect(rows[0].pr_head_sha).toBe('sha-401-b');
  });

  it('sets pr_state=merged when closed with merged:true', async () => {
    await seedSession({ branch: 'feature/beta', owner: testOwner, prNumber: 102 });
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

    const rows = await readUserRow({ userId: testUserId, prNumber: 102 });
    expect(rows[0].pr_state).toBe('merged');
  });

  it('sets pr_state=closed when closed with merged:false', async () => {
    await seedSession({ branch: 'feature/gamma', owner: testOwner, prNumber: 103 });
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

    const rows = await readUserRow({ userId: testUserId, prNumber: 103 });
    expect(rows[0].pr_state).toBe('closed');
  });

  it('updates pr_head_sha on synchronize', async () => {
    await seedSession({ branch: 'feature/delta', owner: testOwner, prNumber: 104 });
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

    const rows = await readUserRow({ userId: testUserId, prNumber: 104 });
    expect(rows[0].pr_head_sha).toBe('sha-delta-2');
  });

  it('updates a draft PR to open when it becomes ready for review', async () => {
    const branch = 'feature/ready-for-review';
    await seedSession({ branch, owner: testOwner, prNumber: 109 });
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 109,
        state: 'open',
        draft: true,
        headRef: branch,
        headSha: 'sha-ready-draft',
      }),
      testOwner
    );

    const written = await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'ready_for_review',
        prNumber: 109,
        state: 'open',
        draft: false,
        headRef: branch,
        headSha: 'sha-ready-open',
      }),
      testOwner
    );

    expect(written).toBe(1);
    const rows = await readUserRow({ userId: testUserId, prNumber: 109 });
    expect(rows[0].pr_state).toBe('open');
  });

  it('updates an open PR to draft when it is converted to draft', async () => {
    const branch = 'feature/converted-to-draft';
    await seedSession({ branch, owner: testOwner, prNumber: 111 });
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 111,
        state: 'open',
        draft: false,
        headRef: branch,
        headSha: 'sha-open',
      }),
      testOwner
    );

    const written = await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'converted_to_draft',
        prNumber: 111,
        state: 'open',
        draft: true,
        headRef: branch,
        headSha: 'sha-draft',
      }),
      testOwner
    );

    expect(written).toBe(1);
    const rows = await readUserRow({ userId: testUserId, prNumber: 111 });
    expect(rows[0].pr_state).toBe('draft');
  });

  it('does not let a PR opened by someone else on a reused branch overwrite the session PR', async () => {
    const branch = 'feature/reused-branch';
    // The session links PR 500 and reported only a head ref (no head SHA).
    await seedSession({ branch, owner: testOwner, prNumber: 500, prHeadSha: null });

    // Someone else opens PR 501 on the same branch name. Different PR number
    // means no session evidence: nothing is written.
    const foreign = await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 501,
        state: 'open',
        headRef: branch,
        headSha: 'sha-someone-else',
      }),
      testOwner
    );
    expect(foreign).toBe(0);
    expect(await readUserRow({ userId: testUserId, prNumber: 501 })).toHaveLength(0);

    // The session's own PR still links.
    const own = await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 500,
        state: 'open',
        headRef: branch,
        headSha: 'sha-own',
      }),
      testOwner
    );
    expect(own).toBe(1);
    expect(await readUserRow({ userId: testUserId, prNumber: 500 })).toHaveLength(1);
  });

  it('keeps distinct rows when a branch is reused after a merged pull request', async () => {
    const branch = 'feature/reused-after-merge';
    await seedSession({ branch, owner: testOwner, prNumber: 208 });

    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'closed',
        prNumber: 208,
        state: 'closed',
        merged: true,
        headRef: branch,
        headSha: 'sha-208',
        title: 'Merged old PR',
      }),
      testOwner
    );

    // A new session links the replacement PR on the same branch name.
    await seedSession({ branch, owner: testOwner, prNumber: 209 });
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 209,
        state: 'open',
        headRef: branch,
        headSha: 'sha-209',
        title: 'Open new PR',
      }),
      testOwner
    );

    const oldRow = await readUserRow({ userId: testUserId, prNumber: 208 });
    const newRow = await readUserRow({ userId: testUserId, prNumber: 209 });
    expect(oldRow).toHaveLength(1);
    expect(oldRow[0]).toMatchObject({ pr_state: 'merged', pr_title: 'Merged old PR' });
    expect(newRow).toHaveLength(1);
    expect(newRow[0]).toMatchObject({
      pr_number: 209,
      pr_url: `https://github.com/${REPO}/pull/209`,
      pr_title: 'Open new PR',
      pr_head_sha: 'sha-209',
      pr_state: 'open',
    });
  });

  it('starts a new open state when a branch is reused after a closed pull request', async () => {
    const branch = 'feature/reused-after-close';
    await seedSession({ branch, owner: testOwner, prNumber: 210 });

    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'closed',
        prNumber: 210,
        state: 'closed',
        merged: false,
        headRef: branch,
        headSha: 'sha-210',
        title: 'Closed old PR',
      }),
      testOwner
    );
    await seedSession({ branch, owner: testOwner, prNumber: 211 });
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 211,
        state: 'open',
        headRef: branch,
        headSha: 'sha-211',
        title: 'Open replacement PR',
      }),
      testOwner
    );

    const rows = await readUserRow({ userId: testUserId, prNumber: 211 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pr_number: 211,
      pr_url: `https://github.com/${REPO}/pull/211`,
      pr_title: 'Open replacement PR',
      pr_head_sha: 'sha-211',
      pr_state: 'open',
    });
  });

  it('does not demote pr_state=merged back to open on an out-of-order redelivery', async () => {
    const branch = 'feature/monotonic-merged';
    await seedSession({ branch, owner: testOwner, prNumber: 200 });

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

    const rows = await readUserRow({ userId: testUserId, prNumber: 200 });
    expect(rows[0].pr_state).toBe('merged');
    // Non-state fields still track the latest payload — only pr_state is monotonic.
    expect(rows[0].pr_head_sha).toBe('sha-200-late');
  });

  it('does not demote pr_state=closed back to open on an out-of-order redelivery', async () => {
    const branch = 'feature/monotonic-closed';
    await seedSession({ branch, owner: testOwner, prNumber: 201 });

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

    const rows = await readUserRow({ userId: testUserId, prNumber: 201 });
    expect(rows[0].pr_state).toBe('closed');
  });

  it('does not demote pr_state=closed to draft on a stale converted_to_draft delivery', async () => {
    const branch = 'feature/monotonic-closed-draft';
    await seedSession({ branch, owner: testOwner, prNumber: 207 });

    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'closed',
        prNumber: 207,
        state: 'closed',
        merged: false,
        headRef: branch,
        headSha: 'sha-207',
      }),
      testOwner
    );
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'converted_to_draft',
        prNumber: 207,
        state: 'open',
        draft: true,
        headRef: branch,
        headSha: 'sha-207-stale',
      }),
      testOwner
    );

    const rows = await readUserRow({ userId: testUserId, prNumber: 207 });
    expect(rows[0].pr_state).toBe('closed');
  });

  it('allows closed -> open transition on reopened action', async () => {
    const branch = 'feature/reopened';
    await seedSession({ branch, owner: testOwner, prNumber: 203 });

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

    const rows = await readUserRow({ userId: testUserId, prNumber: 203 });
    expect(rows[0].pr_state).toBe('open');
    expect(rows[0].pr_head_sha).toBe('sha-203-reopen');
  });

  it('heals pr_state from closed -> open on synchronize when the reopened webhook was missed', async () => {
    const branch = 'feature/missed-reopen-then-sync';
    await seedSession({ branch, owner: testOwner, prNumber: 210 });

    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'closed',
        prNumber: 210,
        state: 'closed',
        merged: false,
        headRef: branch,
        headSha: 'sha-210',
      }),
      testOwner
    );

    // The `reopened` webhook for this PR is never delivered (missed/deduped),
    // but new commits are pushed to the now-actually-open PR, so GitHub
    // delivers a `synchronize` event carrying a new head sha and the PR's
    // real current state (open).
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'synchronize',
        prNumber: 210,
        state: 'open',
        headRef: branch,
        headSha: 'sha-210-new-commit',
      }),
      testOwner
    );

    const rows = await readUserRow({ userId: testUserId, prNumber: 210 });
    expect(rows[0].pr_state).toBe('open');
    expect(rows[0].pr_head_sha).toBe('sha-210-new-commit');
  });

  it('does not heal pr_state from closed -> open on a stale synchronize redelivery with the same head sha', async () => {
    const branch = 'feature/stale-sync-same-sha';
    await seedSession({ branch, owner: testOwner, prNumber: 211 });

    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'closed',
        prNumber: 211,
        state: 'closed',
        merged: false,
        headRef: branch,
        headSha: 'sha-211',
      }),
      testOwner
    );

    // A redelivered/duplicate `synchronize` event for the same commit is not
    // evidence of a new push, so pr_state stays closed.
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'synchronize',
        prNumber: 211,
        state: 'open',
        headRef: branch,
        headSha: 'sha-211',
      }),
      testOwner
    );

    const rows = await readUserRow({ userId: testUserId, prNumber: 211 });
    expect(rows[0].pr_state).toBe('closed');
  });

  it('does not regress pr_state from merged -> closed on stale closed-unmerged redelivery', async () => {
    const branch = 'feature/monotonic-merged-closed';
    await seedSession({ branch, owner: testOwner, prNumber: 204 });

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

    const rows = await readUserRow({ userId: testUserId, prNumber: 204 });
    expect(rows[0].pr_state).toBe('merged');
  });

  it('does not regress pr_state from merged -> open on stale opened/synchronize redelivery', async () => {
    const branch = 'feature/monotonic-merged-open';
    await seedSession({ branch, owner: testOwner, prNumber: 205 });

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

    const rows = await readUserRow({ userId: testUserId, prNumber: 205 });
    expect(rows[0].pr_state).toBe('merged');
  });

  it('does not regress pr_state from merged -> draft on stale converted_to_draft delivery', async () => {
    const branch = 'feature/monotonic-merged-draft';
    await seedSession({ branch, owner: testOwner, prNumber: 206 });

    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'closed',
        prNumber: 206,
        state: 'closed',
        merged: true,
        headRef: branch,
        headSha: 'sha-206',
      }),
      testOwner
    );
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'converted_to_draft',
        prNumber: 206,
        state: 'open',
        draft: true,
        headRef: branch,
        headSha: 'sha-206-stale',
      }),
      testOwner
    );

    const rows = await readUserRow({ userId: testUserId, prNumber: 206 });
    expect(rows[0].pr_state).toBe('merged');
  });

  it('still allows legitimate closed -> merged transitions', async () => {
    const branch = 'feature/close-then-merge';
    await seedSession({ branch, owner: testOwner, prNumber: 202 });

    // Some PRs emit closed(merged:false) then closed(merged:true) - the second
    // still applies because terminal-state guards only block stale active states.
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

    const rows = await readUserRow({ userId: testUserId, prNumber: 202 });
    expect(rows[0].pr_state).toBe('merged');
  });

  describe('per-session verified gate', () => {
    it('skips the upsert when no cli_sessions_v2 row links the PR in this tenant', async () => {
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

      const rows = await readUserRow({ userId: testUserId, prNumber: 700 });
      expect(rows).toHaveLength(0);
    });

    it('writes the row once a session links the PR and a follow-up webhook arrives', async () => {
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
      expect(await readUserRow({ userId: testUserId, prNumber: 701 })).toHaveLength(0);

      // Session is created with a stored link to this PR.
      await seedSession({ branch, owner: testOwner, prNumber: 701 });

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
      const rows = await readUserRow({ userId: testUserId, prNumber: 701 });
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
        prNumber: 702,
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
      expect(await readUserRow({ userId: testUserId, prNumber: 702 })).toHaveLength(0);
    });

    it('does not match an org-owned session when the webhook is for a user-owned install', async () => {
      const orgOwner = await insertTestUser();
      userIdsToCleanup.push(orgOwner.id);
      const org = await createTestOrganization('org-mismatch', orgOwner.id, 0);
      orgIdsToCleanup.push(org.id);
      const branch = 'feature/org-vs-user-mismatch';

      // Session is owned by an org — a user-install webhook for the same
      // PR should not match it.
      await seedSession({
        branch,
        owner: { kind: 'organization', organizationId: org.id },
        prNumber: 703,
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

    it('does not match a session on the same branch name in another repository', async () => {
      const branch = 'feature/other-repo-same-branch';
      // Session links the same PR number and branch but in a different repo.
      await seedSession({
        branch,
        owner: testOwner,
        prNumber: 704,
        gitUrl: 'https://github.com/other/widgets',
      });

      const written = await upsertCliSessionPullRequestsFromWebhook(
        makePayload({
          action: 'opened',
          prNumber: 704,
          state: 'open',
          headRef: branch,
          headSha: 'sha-704',
        }),
        testOwner
      );
      expect(written).toBe(0);
      expect(await readUserRow({ userId: testUserId, prNumber: 704 })).toHaveLength(0);
    });

    it('does not match a fork PR whose head repo differs from the base repo', async () => {
      const branch = 'feature/fork-same-branch';
      await seedSession({ branch, owner: testOwner, prNumber: 705 });

      // Base repo is acme/widgets, head repo is a fork with the same branch.
      const written = await upsertCliSessionPullRequestsFromWebhook(
        makePayload({
          action: 'opened',
          prNumber: 705,
          state: 'open',
          headRef: branch,
          headSha: 'sha-705',
          headRepo: 'fork/widgets',
        }),
        testOwner
      );
      expect(written).toBe(0);
      expect(await readUserRow({ userId: testUserId, prNumber: 705 })).toHaveLength(0);
    });

    it.each([
      ['another repository', 'https://github.com/foreign/widgets/pull/709'],
      ['another PR number', `${NORMALIZED_GIT_URL}/pull/7090`],
    ])('does not verify a session whose stored pr_url names %s', async (_label, foreignPrUrl) => {
      const branch = 'feature/foreign-stored-pr-url';
      const headSha = 'sha-709';
      // Session repo, PR number, and head SHA all agree with the payload; only
      // the stored link names a different pull request.
      const sessionId = await seedSession({
        branch,
        owner: testOwner,
        prNumber: 709,
        prHeadSha: headSha,
      });
      await db
        .update(cli_sessions_v2)
        .set({ pr_url: foreignPrUrl })
        .where(eq(cli_sessions_v2.session_id, sessionId));

      const written = await upsertCliSessionPullRequestsFromWebhook(
        makePayload({ action: 'opened', prNumber: 709, state: 'open', headRef: branch, headSha }),
        testOwner
      );

      expect(written).toBe(0);
      expect(await sessionVerifiedAt(sessionId)).toBeNull();
      expect(await readUserRow({ userId: testUserId, prNumber: 709 })).toHaveLength(0);
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sessionId));
    });

    it.each([
      ['stored head ref', { pr_head_ref: 'feature/other-branch' }],
      ['session branch', { git_branch: 'feature/other-branch' }],
    ])(
      'does not verify a matching head SHA when the %s names another branch',
      async (_label, contradiction) => {
        const branch = 'feature/contradicting-ref';
        const headSha = 'sha-711';
        // The head SHA matches, but refresh would reject this link because a
        // stored ref names another branch, so the webhook must not verify it.
        const sessionId = await seedSession({
          branch,
          owner: testOwner,
          prNumber: 711,
          prHeadSha: headSha,
        });
        await db
          .update(cli_sessions_v2)
          .set(contradiction)
          .where(eq(cli_sessions_v2.session_id, sessionId));

        const written = await upsertCliSessionPullRequestsFromWebhook(
          makePayload({ action: 'opened', prNumber: 711, state: 'open', headRef: branch, headSha }),
          testOwner
        );

        expect(written).toBe(0);
        expect(await sessionVerifiedAt(sessionId)).toBeNull();
        await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sessionId));
      }
    );

    it('verifies a session on a platform outside the old review-decision set', async () => {
      const branch = 'feature/platform-agnostic-gate';
      // `cli`, `vscode` and `agent-manager` sessions surface the PR badge but
      // were previously excluded by the `created_on_platform` gate, so they
      // could never have `pr_link_verified_at` set and never showed their own
      // PR. Verification is per-session evidence, not platform.
      const sessionId = await seedSession({
        branch,
        owner: testOwner,
        prNumber: 706,
        platform: 'vscode',
      });

      const written = await upsertCliSessionPullRequestsFromWebhook(
        makePayload({
          action: 'opened',
          prNumber: 706,
          state: 'open',
          headRef: branch,
          headSha: 'sha-706',
        }),
        testOwner
      );
      expect(written).toBe(1);
      expect(await sessionVerifiedAt(sessionId)).not.toBeNull();
    });

    it.each(['cli', 'agent-manager'] as const)(
      'verifies a %s session without a platform gate',
      async platform => {
        const branch = `feature/platform-${platform}`;
        const prNumber = platform === 'cli' ? 707 : 708;
        const sessionId = await seedSession({ branch, owner: testOwner, prNumber, platform });

        const written = await upsertCliSessionPullRequestsFromWebhook(
          makePayload({
            action: 'opened',
            prNumber,
            state: 'open',
            headRef: branch,
            headSha: `sha-${prNumber}`,
          }),
          testOwner
        );
        expect(written).toBe(1);
        expect(await sessionVerifiedAt(sessionId)).not.toBeNull();
      }
    );
  });

  describe('cross-tenant isolation', () => {
    const SHARED_REPO = 'shared/repo';
    const SHARED_BRANCH = 'feature/shared-branch';
    const SHARED_NORMALIZED = `https://github.com/${SHARED_REPO}`;

    function makeSharedPayload(prNumber: number): PullRequestPayload {
      return makePayload({
        action: 'opened',
        prNumber,
        state: 'open',
        headRef: SHARED_BRANCH,
        headSha: `sha-${prNumber}`,
        repo: SHARED_REPO,
      });
    }

    it('writes a row under the delivering org only, never the other tenant', async () => {
      const orgOwner = await insertTestUser();
      userIdsToCleanup.push(orgOwner.id);
      const orgA = await createTestOrganization('org-a-xtenant', orgOwner.id, 0);
      const orgB = await createTestOrganization('org-b-xtenant', orgOwner.id, 0);
      orgIdsToCleanup.push(orgA.id, orgB.id);
      // Only orgA has a session linking this PR — orgB has none, so even if it
      // received the same webhook it would skip the write.
      await seedSession({
        branch: SHARED_BRANCH,
        owner: { kind: 'organization', organizationId: orgA.id },
        prNumber: 9001,
        gitUrl: SHARED_NORMALIZED,
      });

      await upsertCliSessionPullRequestsFromWebhook(makeSharedPayload(9001), {
        kind: 'organization',
        organizationId: orgA.id,
      });

      const rowsA = await readOrgRow({
        orgId: orgA.id,
        prNumber: 9001,
        gitUrl: SHARED_NORMALIZED,
      });
      expect(rowsA).toHaveLength(1);
      expect(rowsA[0].pr_number).toBe(9001);

      const rowsB = await readOrgRow({
        orgId: orgB.id,
        prNumber: 9001,
        gitUrl: SHARED_NORMALIZED,
      });
      expect(rowsB).toHaveLength(0);
    });

    it('writes separate rows when two tenants both have installations on the same repo', async () => {
      const userA = await insertTestUser();
      const userB = await insertTestUser();
      userIdsToCleanup.push(userA.id, userB.id);
      // Disjoint PR numbers so each tenant's row is unambiguous.
      await seedSession({
        branch: SHARED_BRANCH,
        owner: { kind: 'user', userId: userA.id },
        prNumber: 9001,
        gitUrl: SHARED_NORMALIZED,
      });
      await seedSession({
        branch: SHARED_BRANCH,
        owner: { kind: 'user', userId: userB.id },
        prNumber: 9002,
        gitUrl: SHARED_NORMALIZED,
      });

      await upsertCliSessionPullRequestsFromWebhook(makeSharedPayload(9001), {
        kind: 'user',
        userId: userA.id,
      });
      await upsertCliSessionPullRequestsFromWebhook(makeSharedPayload(9002), {
        kind: 'user',
        userId: userB.id,
      });

      const rowsA = await readUserRow({
        userId: userA.id,
        prNumber: 9001,
        gitUrl: SHARED_NORMALIZED,
      });
      const rowsB = await readUserRow({
        userId: userB.id,
        prNumber: 9002,
        gitUrl: SHARED_NORMALIZED,
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
            inArray(github_branch_pull_requests.pr_number, [9001, 9002]),
            inArray(github_branch_pull_requests.owned_by_user_id, [userA.id, userB.id])
          )
        );
      for (const r of allRows) {
        expect(r.owned_by_organization_id).toBeNull();
        expect(typeof r.owned_by_user_id).toBe('string');
      }
    });

    it('only one row exists for the delivering user, regardless of how many sessions link the PR', async () => {
      const userA = await insertTestUser();
      userIdsToCleanup.push(userA.id);
      // Two sessions linking the same PR — the upsert must still produce
      // exactly one cache row.
      await seedSession({
        branch: SHARED_BRANCH,
        owner: { kind: 'user', userId: userA.id },
        prNumber: 9001,
        gitUrl: SHARED_NORMALIZED,
      });
      await seedSession({
        branch: SHARED_BRANCH,
        owner: { kind: 'user', userId: userA.id },
        prNumber: 9001,
        gitUrl: SHARED_NORMALIZED,
      });

      await upsertCliSessionPullRequestsFromWebhook(makeSharedPayload(9001), {
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
            eq(github_branch_pull_requests.pr_number, 9001),
            eq(github_branch_pull_requests.owned_by_user_id, userA.id)
          )
        );
      expect(countRows[0].c).toBe(1);
    });

    it('partial unique indexes prevent duplicate rows for the same (url, pr_number, owner)', async () => {
      const userA = await insertTestUser();
      userIdsToCleanup.push(userA.id);
      await seedSession({
        branch: SHARED_BRANCH,
        owner: { kind: 'user', userId: userA.id },
        prNumber: 9001,
        gitUrl: SHARED_NORMALIZED,
      });

      await upsertCliSessionPullRequestsFromWebhook(makeSharedPayload(9001), {
        kind: 'user',
        userId: userA.id,
      });
      await upsertCliSessionPullRequestsFromWebhook(makeSharedPayload(9001), {
        kind: 'user',
        userId: userA.id,
      });

      const rows = await db
        .select()
        .from(github_branch_pull_requests)
        .where(
          and(
            eq(github_branch_pull_requests.git_url, SHARED_NORMALIZED),
            eq(github_branch_pull_requests.pr_number, 9001),
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
      await seedSession({
        branch,
        owner: testOwner,
        prNumber: 801,
        platform: 'cloud-agent-web',
      });

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

      const rows = await readUserRow({ userId: testUserId, prNumber: 801 });
      expect(rows[0].review_decision_pending).toBe(true);
      expect(rows[0].pr_review_decision).toBeNull();
    });

    it('synchronize sets review_decision_pending=true', async () => {
      const branch = 'feature/rd-pending-sync';
      await seedSession({
        branch,
        owner: testOwner,
        prNumber: 802,
        platform: 'cloud-agent-web',
      });

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

      const rows = await readUserRow({ userId: testUserId, prNumber: 802 });
      expect(rows[0].review_decision_pending).toBe(true);
    });

    it('reopened sets review_decision_pending=true', async () => {
      const branch = 'feature/rd-pending-reopen';
      await seedSession({
        branch,
        owner: testOwner,
        prNumber: 803,
        platform: 'cloud-agent-web',
      });

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

      const rows = await readUserRow({ userId: testUserId, prNumber: 803 });
      expect(rows[0].review_decision_pending).toBe(true);
    });

    it('edited does not flip review_decision_pending', async () => {
      const branch = 'feature/rd-pending-edited';
      await seedSession({
        branch,
        owner: testOwner,
        prNumber: 804,
        platform: 'cloud-agent-web',
      });

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

      const rows = await readUserRow({ userId: testUserId, prNumber: 804 });
      expect(rows[0].review_decision_pending).toBe(false);
      expect(rows[0].pr_review_decision).toBe('approved');
    });

    it('closed does not flip review_decision_pending', async () => {
      const branch = 'feature/rd-pending-closed';
      await seedSession({
        branch,
        owner: testOwner,
        prNumber: 805,
        platform: 'cloud-agent-web',
      });

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

      const rows = await readUserRow({ userId: testUserId, prNumber: 805 });
      expect(rows[0].review_decision_pending).toBe(false);
      expect(rows[0].pr_review_decision).toBe('approved');
    });

    it('existing pr_review_decision is preserved on synchronize (not overwritten)', async () => {
      const branch = 'feature/rd-preserve-decision';
      await seedSession({
        branch,
        owner: testOwner,
        prNumber: 806,
        platform: 'cloud-agent-web',
      });

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

      const rows = await readUserRow({ userId: testUserId, prNumber: 806 });
      // Decision preserved, but pending flag is now true for the batch to refetch.
      expect(rows[0].pr_review_decision).toBe('approved');
      expect(rows[0].review_decision_pending).toBe(true);
    });

    it('session on a non-cloud-agent platform is verified and writes the row', async () => {
      const branch = 'feature/platform-rd-non-cloud';
      const sessionId = await seedSession({
        branch,
        owner: testOwner,
        prNumber: 807,
        platform: 'vscode',
      });

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

      expect(written).toBe(1);
      expect(await sessionVerifiedAt(sessionId)).not.toBeNull();
      const rows = await readUserRow({ userId: testUserId, prNumber: 807 });
      expect(rows).toHaveLength(1);
      expect(rows[0].review_decision_pending).toBe(true);
    });

    it('mixed sessions (cloud-agent-web + vscode) → row is written with pending=true', async () => {
      const branch = 'feature/rd-mixed';
      await seedSession({
        branch,
        owner: testOwner,
        prNumber: 808,
        platform: 'cloud-agent-web',
      });
      await seedSession({
        branch,
        owner: testOwner,
        prNumber: 808,
        platform: 'vscode',
      });

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

      const rows = await readUserRow({ userId: testUserId, prNumber: 808 });
      expect(rows[0].review_decision_pending).toBe(true);
    });
  });
});
