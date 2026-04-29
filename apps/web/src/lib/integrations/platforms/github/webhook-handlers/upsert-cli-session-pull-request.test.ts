import { db } from '@/lib/drizzle';
import { cli_sessions_v2, cli_session_pull_requests } from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { PullRequestPayload } from '@/lib/integrations/platforms/github/webhook-schemas';
import {
  upsertCliSessionPullRequestFromWebhook,
  shouldUpsertCliSessionPullRequest,
} from './upsert-cli-session-pull-request';

type HeadRepoOverrides = {
  clone_url?: string;
  html_url?: string;
  full_name?: string;
};

function buildPayload(overrides: {
  action: string;
  number?: number;
  state?: string;
  merged?: boolean;
  headRef?: string;
  headSha?: string;
  headRepo?: HeadRepoOverrides | null;
  title?: string;
  htmlUrl?: string;
}): PullRequestPayload {
  const headRepo =
    overrides.headRepo === null
      ? null
      : {
          full_name: 'acme/widgets',
          clone_url: 'https://github.com/acme/widgets.git',
          html_url: 'https://github.com/acme/widgets',
          ...overrides.headRepo,
        };

  return {
    action: overrides.action,
    pull_request: {
      number: overrides.number ?? 42,
      title: overrides.title ?? 'Fix the thing',
      body: null,
      state: overrides.state ?? 'open',
      draft: false,
      merged: overrides.merged,
      html_url:
        overrides.htmlUrl ?? `https://github.com/acme/widgets/pull/${overrides.number ?? 42}`,
      user: { id: 1, login: 'octocat', avatar_url: '' },
      head: {
        sha: overrides.headSha ?? 'sha-1',
        ref: overrides.headRef ?? 'feature/assoc-pr',
        repo: headRepo,
      },
      base: { sha: 'base-sha', ref: 'main' },
    },
    repository: {
      id: 1,
      full_name: 'acme/widgets',
      owner: { login: 'acme' },
    },
    installation: { id: 1 },
  } as unknown as PullRequestPayload;
}

describe('shouldUpsertCliSessionPullRequest', () => {
  it('accepts the 5 canonical actions', () => {
    for (const action of ['opened', 'reopened', 'edited', 'synchronize', 'closed']) {
      expect(shouldUpsertCliSessionPullRequest(action)).toBe(true);
    }
  });

  it('rejects unrelated actions', () => {
    for (const action of [
      'labeled',
      'unlabeled',
      'assigned',
      'ready_for_review',
      'review_requested',
    ]) {
      expect(shouldUpsertCliSessionPullRequest(action)).toBe(false);
    }
  });
});

describe('upsertCliSessionPullRequestFromWebhook', () => {
  const testUserId = `test-user-assoc-pr-${crypto.randomUUID()}`;
  const createdSessionIds: string[] = [];

  async function insertSession(params: {
    git_url: string | null;
    git_branch: string | null;
  }): Promise<string> {
    const sessionId = `ses_${crypto.randomUUID()}`;
    await db.insert(cli_sessions_v2).values({
      session_id: sessionId,
      kilo_user_id: testUserId,
      git_url: params.git_url,
      git_branch: params.git_branch,
    });
    createdSessionIds.push(sessionId);
    return sessionId;
  }

  async function getPullRequestRow(sessionId: string) {
    const rows = await db
      .select()
      .from(cli_session_pull_requests)
      .where(eq(cli_session_pull_requests.session_id, sessionId));
    return rows[0];
  }

  beforeAll(async () => {
    await insertTestUser({ id: testUserId });
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

  it('inserts a row when a session matches the PR head (opened)', async () => {
    const sessionId = await insertSession({
      git_url: 'https://github.com/acme/widgets.git',
      git_branch: 'feature/opened',
    });

    const result = await upsertCliSessionPullRequestFromWebhook(
      buildPayload({ action: 'opened', headRef: 'feature/opened', number: 101 })
    );

    expect(result.sessions_updated).toBe(1);
    const row = await getPullRequestRow(sessionId);
    expect(row).toBeDefined();
    expect(row.pr_number).toBe(101);
    expect(row.pr_state).toBe('open');
    expect(row.pr_title).toBe('Fix the thing');
    expect(row.pr_head_sha).toBe('sha-1');
  });

  it("sets pr_state='merged' when closed with merged=true", async () => {
    const sessionId = await insertSession({
      git_url: 'https://github.com/acme/widgets.git',
      git_branch: 'feature/merged',
    });

    const result = await upsertCliSessionPullRequestFromWebhook(
      buildPayload({
        action: 'closed',
        headRef: 'feature/merged',
        number: 102,
        state: 'closed',
        merged: true,
      })
    );

    expect(result.sessions_updated).toBe(1);
    const row = await getPullRequestRow(sessionId);
    expect(row.pr_state).toBe('merged');
  });

  it("sets pr_state='closed' when closed with merged=false", async () => {
    const sessionId = await insertSession({
      git_url: 'https://github.com/acme/widgets.git',
      git_branch: 'feature/closed-nomerge',
    });

    const result = await upsertCliSessionPullRequestFromWebhook(
      buildPayload({
        action: 'closed',
        headRef: 'feature/closed-nomerge',
        number: 103,
        state: 'closed',
        merged: false,
      })
    );

    expect(result.sessions_updated).toBe(1);
    const row = await getPullRequestRow(sessionId);
    expect(row.pr_state).toBe('closed');
  });

  it('updates pr_head_sha on synchronize', async () => {
    const sessionId = await insertSession({
      git_url: 'https://github.com/acme/widgets.git',
      git_branch: 'feature/sync',
    });

    await upsertCliSessionPullRequestFromWebhook(
      buildPayload({ action: 'opened', headRef: 'feature/sync', number: 104, headSha: 'sha-old' })
    );
    await upsertCliSessionPullRequestFromWebhook(
      buildPayload({
        action: 'synchronize',
        headRef: 'feature/sync',
        number: 104,
        headSha: 'sha-new',
      })
    );

    const row = await getPullRequestRow(sessionId);
    expect(row.pr_head_sha).toBe('sha-new');
  });

  it('matches sessions that stored git_url without the .git suffix', async () => {
    const sessionId = await insertSession({
      git_url: 'https://github.com/acme/widgets',
      git_branch: 'feature/nogitsuffix',
    });

    const result = await upsertCliSessionPullRequestFromWebhook(
      buildPayload({ action: 'opened', headRef: 'feature/nogitsuffix', number: 105 })
    );

    expect(result.sessions_updated).toBe(1);
    const row = await getPullRequestRow(sessionId);
    expect(row).toBeDefined();
  });

  it('matches sessions that stored git_url in scp-style ssh form', async () => {
    const sessionId = await insertSession({
      git_url: 'git@github.com:Acme/Widgets.git',
      git_branch: 'feature/ssh',
    });

    const result = await upsertCliSessionPullRequestFromWebhook(
      buildPayload({ action: 'opened', headRef: 'feature/ssh', number: 106 })
    );

    expect(result.sessions_updated).toBe(1);
    const row = await getPullRequestRow(sessionId);
    expect(row).toBeDefined();
  });

  it('does nothing when no session matches', async () => {
    const result = await upsertCliSessionPullRequestFromWebhook(
      buildPayload({ action: 'opened', headRef: 'branch-with-no-matching-session', number: 107 })
    );

    expect(result.sessions_updated).toBe(0);
  });

  it('bulk-upserts multiple sessions on the same branch in one statement', async () => {
    const s1 = await insertSession({
      git_url: 'https://github.com/acme/widgets.git',
      git_branch: 'feature/shared',
    });
    const s2 = await insertSession({
      git_url: 'https://github.com/acme/widgets',
      git_branch: 'feature/shared',
    });
    const s3 = await insertSession({
      git_url: 'git@github.com:acme/widgets.git',
      git_branch: 'feature/shared',
    });

    const result = await upsertCliSessionPullRequestFromWebhook(
      buildPayload({ action: 'opened', headRef: 'feature/shared', number: 108 })
    );

    expect(result.sessions_updated).toBe(3);
    for (const sessionId of [s1, s2, s3]) {
      const row = await getPullRequestRow(sessionId);
      expect(row).toBeDefined();
      expect(row.pr_number).toBe(108);
    }
  });

  it('skips actions outside the canonical 5', async () => {
    await insertSession({
      git_url: 'https://github.com/acme/widgets.git',
      git_branch: 'feature/labeled',
    });

    const result = await upsertCliSessionPullRequestFromWebhook(
      buildPayload({ action: 'labeled', headRef: 'feature/labeled', number: 109 })
    );

    expect(result.skipped).toBe(true);
    expect(result.sessions_updated).toBe(0);
  });

  it('ignores sessions whose git_url is null', async () => {
    await insertSession({ git_url: null, git_branch: 'feature/null-url' });

    const result = await upsertCliSessionPullRequestFromWebhook(
      buildPayload({ action: 'opened', headRef: 'feature/null-url', number: 110 })
    );

    expect(result.sessions_updated).toBe(0);
  });
});
