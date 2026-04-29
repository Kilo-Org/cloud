import { db } from '@/lib/drizzle';
import { cli_session_pull_requests, cli_sessions_v2 } from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { PullRequestPayload } from '@/lib/integrations/platforms/github/webhook-schemas';
import { upsertCliSessionPullRequestsFromWebhook } from './upsert-cli-session-pull-requests';

const REPO = 'acme/widgets';

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
}): PullRequestPayload {
  return {
    action: overrides.action,
    pull_request: {
      number: overrides.prNumber,
      title: overrides.title ?? 'test PR',
      state: overrides.state ?? 'open',
      merged: overrides.merged,
      html_url: overrides.prUrl ?? `https://github.com/${REPO}/pull/${overrides.prNumber}`,
      user: { id: 1, login: 'octocat', avatar_url: 'https://example.com/a.png' },
      head: {
        sha: overrides.headSha,
        ref: overrides.headRef,
        repo: {
          full_name: REPO,
          clone_url: overrides.cloneUrl ?? `https://github.com/${REPO}.git`,
          html_url: overrides.htmlUrl ?? `https://github.com/${REPO}`,
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
    installation: { id: 1 },
  };
}

describe('upsertCliSessionPullRequestsFromWebhook', () => {
  let testUserId: string;
  const createdSessionIds: string[] = [];

  beforeAll(async () => {
    const user = await insertTestUser();
    testUserId = user.id;
  });

  afterAll(async () => {
    if (createdSessionIds.length > 0) {
      await db
        .delete(cli_session_pull_requests)
        .where(inArray(cli_session_pull_requests.session_id, createdSessionIds));
      await db
        .delete(cli_sessions_v2)
        .where(inArray(cli_sessions_v2.session_id, createdSessionIds));
    }
  });

  async function insertSession(gitUrl: string | null, gitBranch: string | null): Promise<string> {
    const sessionId = `ses_${crypto.randomUUID()}`;
    await db.insert(cli_sessions_v2).values({
      session_id: sessionId,
      kilo_user_id: testUserId,
      git_url: gitUrl,
      git_branch: gitBranch,
    });
    createdSessionIds.push(sessionId);
    return sessionId;
  }

  it('inserts a row on opened when a matching session exists', async () => {
    const sessionId = await insertSession(`https://github.com/${REPO}.git`, 'feature/alpha');

    const updated = await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 101,
        state: 'open',
        headRef: 'feature/alpha',
        headSha: 'sha-alpha',
      })
    );

    expect(updated).toBe(1);
    const rows = await db
      .select()
      .from(cli_session_pull_requests)
      .where(eq(cli_session_pull_requests.session_id, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0].pr_number).toBe(101);
    expect(rows[0].pr_state).toBe('open');
    expect(rows[0].pr_head_sha).toBe('sha-alpha');
  });

  it('sets pr_state=merged when closed with merged:true', async () => {
    const sessionId = await insertSession(`https://github.com/${REPO}.git`, 'feature/beta');

    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 102,
        state: 'open',
        headRef: 'feature/beta',
        headSha: 'sha-beta-1',
      })
    );

    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'closed',
        prNumber: 102,
        state: 'closed',
        merged: true,
        headRef: 'feature/beta',
        headSha: 'sha-beta-1',
      })
    );

    const [row] = await db
      .select()
      .from(cli_session_pull_requests)
      .where(eq(cli_session_pull_requests.session_id, sessionId));
    expect(row.pr_state).toBe('merged');
  });

  it('sets pr_state=closed when closed with merged:false', async () => {
    const sessionId = await insertSession(`https://github.com/${REPO}.git`, 'feature/gamma');

    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 103,
        state: 'open',
        headRef: 'feature/gamma',
        headSha: 'sha-gamma',
      })
    );

    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'closed',
        prNumber: 103,
        state: 'closed',
        merged: false,
        headRef: 'feature/gamma',
        headSha: 'sha-gamma',
      })
    );

    const [row] = await db
      .select()
      .from(cli_session_pull_requests)
      .where(eq(cli_session_pull_requests.session_id, sessionId));
    expect(row.pr_state).toBe('closed');
  });

  it('updates pr_head_sha on synchronize', async () => {
    const sessionId = await insertSession(`https://github.com/${REPO}.git`, 'feature/delta');

    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 104,
        state: 'open',
        headRef: 'feature/delta',
        headSha: 'sha-delta-1',
      })
    );

    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'synchronize',
        prNumber: 104,
        state: 'open',
        headRef: 'feature/delta',
        headSha: 'sha-delta-2',
      })
    );

    const [row] = await db
      .select()
      .from(cli_session_pull_requests)
      .where(eq(cli_session_pull_requests.session_id, sessionId));
    expect(row.pr_head_sha).toBe('sha-delta-2');
  });

  it('matches sessions whose git_url was stored without .git', async () => {
    const sessionId = await insertSession(`https://github.com/${REPO}`, 'feature/epsilon');

    const updated = await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 105,
        state: 'open',
        headRef: 'feature/epsilon',
        headSha: 'sha-e',
      })
    );

    expect(updated).toBe(1);
    const rows = await db
      .select()
      .from(cli_session_pull_requests)
      .where(eq(cli_session_pull_requests.session_id, sessionId));
    expect(rows).toHaveLength(1);
  });

  it('matches sessions whose git_url was stored in ssh form', async () => {
    const sessionId = await insertSession(`git@github.com:${REPO}.git`, 'feature/zeta');

    const updated = await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 106,
        state: 'open',
        headRef: 'feature/zeta',
        headSha: 'sha-z',
      })
    );

    expect(updated).toBe(1);
    const rows = await db
      .select()
      .from(cli_session_pull_requests)
      .where(eq(cli_session_pull_requests.session_id, sessionId));
    expect(rows).toHaveLength(1);
  });

  it('produces zero upserts when no session matches', async () => {
    const updated = await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 107,
        state: 'open',
        headRef: 'branch-with-no-session',
        headSha: 'sha-none',
      })
    );
    expect(updated).toBe(0);
  });

  it('bulk-upserts all matching sessions on the same branch', async () => {
    const branch = 'feature/shared';
    const ids = [
      await insertSession(`https://github.com/${REPO}.git`, branch),
      await insertSession(`https://github.com/${REPO}`, branch),
      await insertSession(`git@github.com:${REPO}.git`, branch),
    ];

    const updated = await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'synchronize',
        prNumber: 108,
        state: 'open',
        headRef: branch,
        headSha: 'sha-shared',
      })
    );

    expect(updated).toBe(3);
    const rows = await db
      .select()
      .from(cli_session_pull_requests)
      .where(inArray(cli_session_pull_requests.session_id, ids));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.pr_number).toBe(108);
      expect(row.pr_head_sha).toBe('sha-shared');
    }
  });

  it('ignores unrelated actions such as ready_for_review', async () => {
    await insertSession(`https://github.com/${REPO}.git`, 'feature/eta');

    const updated = await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'ready_for_review',
        prNumber: 109,
        state: 'open',
        headRef: 'feature/eta',
        headSha: 'sha-eta',
      })
    );
    expect(updated).toBe(0);
  });

  it('does not demote pr_state=merged back to open on an out-of-order redelivery', async () => {
    const sessionId = await insertSession(
      `https://github.com/${REPO}.git`,
      'feature/monotonic-merged'
    );

    // Seed with opened, then close+merged.
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 200,
        state: 'open',
        headRef: 'feature/monotonic-merged',
        headSha: 'sha-200-1',
      })
    );
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'closed',
        prNumber: 200,
        state: 'closed',
        merged: true,
        headRef: 'feature/monotonic-merged',
        headSha: 'sha-200-1',
      })
    );

    // Simulate a late-arriving redelivery of an earlier `synchronize` webhook
    // (same delivery would be deduped upstream; here we model the case where
    // dedup is absent or the event is from a different delivery id).
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'synchronize',
        prNumber: 200,
        state: 'open',
        headRef: 'feature/monotonic-merged',
        headSha: 'sha-200-late',
      })
    );

    const [row] = await db
      .select()
      .from(cli_session_pull_requests)
      .where(eq(cli_session_pull_requests.session_id, sessionId));
    expect(row.pr_state).toBe('merged');
    // Non-state fields still track the latest payload — only pr_state is monotonic.
    expect(row.pr_head_sha).toBe('sha-200-late');
  });

  it('does not demote pr_state=closed back to open on an out-of-order redelivery', async () => {
    const sessionId = await insertSession(
      `https://github.com/${REPO}.git`,
      'feature/monotonic-closed'
    );

    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'closed',
        prNumber: 201,
        state: 'closed',
        merged: false,
        headRef: 'feature/monotonic-closed',
        headSha: 'sha-201',
      })
    );

    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'opened',
        prNumber: 201,
        state: 'open',
        headRef: 'feature/monotonic-closed',
        headSha: 'sha-201',
      })
    );

    const [row] = await db
      .select()
      .from(cli_session_pull_requests)
      .where(eq(cli_session_pull_requests.session_id, sessionId));
    expect(row.pr_state).toBe('closed');
  });

  it('allows closed -> open transition on reopened action', async () => {
    const sessionId = await insertSession(`https://github.com/${REPO}.git`, 'feature/reopened');

    // A closed, unmerged PR gets reopened — the monotonic guard must NOT
    // trap pr_state at 'closed' in this case; `reopened` is exempt.
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'closed',
        prNumber: 203,
        state: 'closed',
        merged: false,
        headRef: 'feature/reopened',
        headSha: 'sha-203',
      })
    );
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'reopened',
        prNumber: 203,
        state: 'open',
        headRef: 'feature/reopened',
        headSha: 'sha-203-reopen',
      })
    );

    const [row] = await db
      .select()
      .from(cli_session_pull_requests)
      .where(eq(cli_session_pull_requests.session_id, sessionId));
    expect(row.pr_state).toBe('open');
    expect(row.pr_head_sha).toBe('sha-203-reopen');
  });

  it('still allows legitimate closed -> merged transitions', async () => {
    const sessionId = await insertSession(
      `https://github.com/${REPO}.git`,
      'feature/close-then-merge'
    );

    // Some PRs emit closed(merged:false) then closed(merged:true) — the second
    // should still be applied because we only block `open` downgrades.
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'closed',
        prNumber: 202,
        state: 'closed',
        merged: false,
        headRef: 'feature/close-then-merge',
        headSha: 'sha-202',
      })
    );
    await upsertCliSessionPullRequestsFromWebhook(
      makePayload({
        action: 'closed',
        prNumber: 202,
        state: 'closed',
        merged: true,
        headRef: 'feature/close-then-merge',
        headSha: 'sha-202',
      })
    );

    const [row] = await db
      .select()
      .from(cli_session_pull_requests)
      .where(eq(cli_session_pull_requests.session_id, sessionId));
    expect(row.pr_state).toBe('merged');
  });
});
