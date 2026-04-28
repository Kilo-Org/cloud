import { db } from '@/lib/drizzle';
import { cli_session_pull_requests, cli_sessions_v2 } from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { PullRequestPayload } from '../webhook-schemas';
import { upsertSessionPullRequestsFromWebhook } from './upsert-session-pull-request';

type WebhookArgs = {
  action: string;
  prNumber?: number;
  prUrl?: string;
  prTitle?: string;
  prState?: string;
  merged?: boolean;
  headSha?: string;
  headBranch: string;
  headRepoCloneUrl?: string;
  headRepoHtmlUrl?: string;
  headRepoFullName?: string;
  repoFullName?: string;
};

function buildPayload(args: WebhookArgs): PullRequestPayload {
  const repoFullName = args.repoFullName ?? 'acme/widgets';
  const headRepoFullName = args.headRepoFullName ?? repoFullName;
  return {
    action: args.action,
    pull_request: {
      number: args.prNumber ?? 123,
      title: args.prTitle ?? 'Test PR',
      state: args.prState ?? 'open',
      merged: args.merged,
      html_url: args.prUrl ?? `https://github.com/${repoFullName}/pull/${args.prNumber ?? 123}`,
      user: {
        id: 1,
        login: 'octocat',
        avatar_url: 'https://example.com/avatar.png',
      },
      head: {
        sha: args.headSha ?? 'aaaaaaa',
        ref: args.headBranch,
        repo: {
          full_name: headRepoFullName,
          clone_url: args.headRepoCloneUrl,
          html_url: args.headRepoHtmlUrl,
        },
      },
      base: {
        sha: 'bbbbbbb',
        ref: 'main',
      },
    },
    repository: {
      id: 99,
      name: repoFullName.split('/')[1],
      full_name: repoFullName,
      owner: { login: repoFullName.split('/')[0] },
    },
    installation: { id: 42 },
  } satisfies PullRequestPayload;
}

describe('upsertSessionPullRequestsFromWebhook', () => {
  const testUserId = `test-user-pr-upsert-${crypto.randomUUID()}`;
  const createdSessionIds: string[] = [];

  beforeAll(async () => {
    await insertTestUser({ id: testUserId });
  });

  afterEach(async () => {
    if (createdSessionIds.length > 0) {
      await db
        .delete(cli_session_pull_requests)
        .where(inArray(cli_session_pull_requests.session_id, createdSessionIds));
      await db
        .delete(cli_sessions_v2)
        .where(inArray(cli_sessions_v2.session_id, createdSessionIds));
      createdSessionIds.length = 0;
    }
  });

  async function insertSession(gitUrl: string | null, gitBranch: string | null) {
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

  it('inserts a row on opened when (git_url, git_branch) matches clone_url', async () => {
    const sessionId = await insertSession('https://github.com/acme/widgets.git', 'feature/x');

    await upsertSessionPullRequestsFromWebhook(
      buildPayload({
        action: 'opened',
        prNumber: 101,
        prState: 'open',
        headBranch: 'feature/x',
        headSha: 'cafebabe',
        headRepoCloneUrl: 'https://github.com/acme/widgets.git',
        headRepoHtmlUrl: 'https://github.com/acme/widgets',
      })
    );

    const rows = await db
      .select()
      .from(cli_session_pull_requests)
      .where(inArray(cli_session_pull_requests.session_id, [sessionId]));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: sessionId,
      pr_url: 'https://github.com/acme/widgets/pull/101',
      pr_number: 101,
      pr_state: 'open',
      pr_head_sha: 'cafebabe',
    });
  });

  it('upserts pr_state=merged on closed when merged=true', async () => {
    const sessionId = await insertSession('https://github.com/acme/widgets.git', 'feature/merge');

    await upsertSessionPullRequestsFromWebhook(
      buildPayload({
        action: 'closed',
        prNumber: 202,
        prState: 'closed',
        merged: true,
        headBranch: 'feature/merge',
        headSha: 'deadbeef',
        headRepoCloneUrl: 'https://github.com/acme/widgets.git',
        headRepoHtmlUrl: 'https://github.com/acme/widgets',
      })
    );

    const [row] = await db
      .select()
      .from(cli_session_pull_requests)
      .where(inArray(cli_session_pull_requests.session_id, [sessionId]));

    expect(row.pr_state).toBe('merged');
  });

  it('upserts pr_state=closed on closed when merged=false', async () => {
    const sessionId = await insertSession('https://github.com/acme/widgets.git', 'feature/abandon');

    await upsertSessionPullRequestsFromWebhook(
      buildPayload({
        action: 'closed',
        prNumber: 203,
        prState: 'closed',
        merged: false,
        headBranch: 'feature/abandon',
        headRepoCloneUrl: 'https://github.com/acme/widgets.git',
        headRepoHtmlUrl: 'https://github.com/acme/widgets',
      })
    );

    const [row] = await db
      .select()
      .from(cli_session_pull_requests)
      .where(inArray(cli_session_pull_requests.session_id, [sessionId]));

    expect(row.pr_state).toBe('closed');
  });

  it('updates pr_head_sha on synchronize when row already exists', async () => {
    const sessionId = await insertSession('https://github.com/acme/widgets.git', 'feature/sync');

    await upsertSessionPullRequestsFromWebhook(
      buildPayload({
        action: 'opened',
        prNumber: 303,
        headBranch: 'feature/sync',
        headSha: 'firstsha',
        headRepoCloneUrl: 'https://github.com/acme/widgets.git',
        headRepoHtmlUrl: 'https://github.com/acme/widgets',
      })
    );

    await upsertSessionPullRequestsFromWebhook(
      buildPayload({
        action: 'synchronize',
        prNumber: 303,
        headBranch: 'feature/sync',
        headSha: 'secondsha',
        headRepoCloneUrl: 'https://github.com/acme/widgets.git',
        headRepoHtmlUrl: 'https://github.com/acme/widgets',
      })
    );

    const rows = await db
      .select()
      .from(cli_session_pull_requests)
      .where(inArray(cli_session_pull_requests.session_id, [sessionId]));
    expect(rows).toHaveLength(1);
    expect(rows[0].pr_head_sha).toBe('secondsha');
  });

  it('matches sessions stored with an ssh-style git_url via normalization', async () => {
    const sessionId = await insertSession('git@github.com:acme/widgets.git', 'feature/ssh');

    await upsertSessionPullRequestsFromWebhook(
      buildPayload({
        action: 'opened',
        prNumber: 404,
        headBranch: 'feature/ssh',
        headRepoCloneUrl: 'https://github.com/acme/widgets.git',
        headRepoHtmlUrl: 'https://github.com/acme/widgets',
      })
    );

    const rows = await db
      .select()
      .from(cli_session_pull_requests)
      .where(inArray(cli_session_pull_requests.session_id, [sessionId]));
    expect(rows).toHaveLength(1);
  });

  it('matches sessions stored with an html_url without .git suffix', async () => {
    const sessionId = await insertSession('https://github.com/acme/widgets', 'feature/nogit');

    await upsertSessionPullRequestsFromWebhook(
      buildPayload({
        action: 'opened',
        prNumber: 405,
        headBranch: 'feature/nogit',
        headRepoCloneUrl: 'https://github.com/acme/widgets.git',
        headRepoHtmlUrl: 'https://github.com/acme/widgets',
      })
    );

    const rows = await db
      .select()
      .from(cli_session_pull_requests)
      .where(inArray(cli_session_pull_requests.session_id, [sessionId]));
    expect(rows).toHaveLength(1);
  });

  it('does nothing when no session matches (no error, no rows)', async () => {
    const unrelatedSessionId = await insertSession('https://github.com/someone/else.git', 'main');

    await upsertSessionPullRequestsFromWebhook(
      buildPayload({
        action: 'opened',
        prNumber: 500,
        headBranch: 'feature/nowhere',
        headRepoCloneUrl: 'https://github.com/acme/widgets.git',
        headRepoHtmlUrl: 'https://github.com/acme/widgets',
      })
    );

    const rows = await db
      .select()
      .from(cli_session_pull_requests)
      .where(inArray(cli_session_pull_requests.session_id, [unrelatedSessionId]));
    expect(rows).toHaveLength(0);
  });

  it('inserts rows for all matching sessions in a single bulk upsert', async () => {
    const s1 = await insertSession('https://github.com/acme/widgets.git', 'feature/many');
    const s2 = await insertSession('https://github.com/acme/widgets.git', 'feature/many');
    const s3 = await insertSession('git@github.com:acme/widgets.git', 'feature/many');

    await upsertSessionPullRequestsFromWebhook(
      buildPayload({
        action: 'opened',
        prNumber: 600,
        headBranch: 'feature/many',
        headSha: 'sha600',
        headRepoCloneUrl: 'https://github.com/acme/widgets.git',
        headRepoHtmlUrl: 'https://github.com/acme/widgets',
      })
    );

    const rows = await db
      .select()
      .from(cli_session_pull_requests)
      .where(inArray(cli_session_pull_requests.session_id, [s1, s2, s3]));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.pr_number).toBe(600);
      expect(row.pr_head_sha).toBe('sha600');
    }
  });

  it('ignores actions outside the upsert set', async () => {
    const sessionId = await insertSession('https://github.com/acme/widgets.git', 'feature/labeled');

    await upsertSessionPullRequestsFromWebhook(
      buildPayload({
        action: 'labeled',
        prNumber: 700,
        headBranch: 'feature/labeled',
        headRepoCloneUrl: 'https://github.com/acme/widgets.git',
        headRepoHtmlUrl: 'https://github.com/acme/widgets',
      })
    );

    const rows = await db
      .select()
      .from(cli_session_pull_requests)
      .where(inArray(cli_session_pull_requests.session_id, [sessionId]));
    expect(rows).toHaveLength(0);
  });
});
