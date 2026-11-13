import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  cli_sessions_v2,
  cloud_agent_pr_feedback_dispositions,
  cloud_agent_pr_maintenance_attempts,
  cloud_agent_pr_watch_activity,
  cloud_agent_pr_watches,
  cloud_agent_worktrees,
  kilocode_users,
  platform_integrations,
} from '@kilocode/db/schema';
import {
  watchPrMaintenanceInputSchema,
  watchPrMaintenancePolicySchema,
  watchPrMaintenanceResultSchema,
} from '@kilocode/db/cloud-agent-pr-maintenance';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { emptyWatchPrProjection } from './watch-pr-events';
import { publishWatchPrReplies, watchPrReplyBody } from './watch-pr-replies';
import { cleanupWatchPrData } from './watch-pr-cleanup';

const mockCreate = jest.fn(),
  mockRequest = jest.fn();
jest.mock('@octokit/rest', () => ({
  Octokit: class {
    issues = { createComment: mockCreate };
    request = mockRequest;
  },
}));
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: async () => ({
    token: 'test-installation-token',
    expires_at: null,
  }),
  toGitHubRateLimitError: () => null,
}));
jest.mock('@/lib/integrations/platforms/github/pr-refresh-budget', () => ({
  claimPrMaintenanceCall: async (input: { write?: boolean }) => ({
    allowed: true,
    writeLease: input.write ? Date.now() + 30000 : undefined,
  }),
  completePrMaintenanceWrite: async () => undefined,
  deferPrRefresh: jest.fn(),
  recordPrMaintenanceApiCall: jest.fn(),
  PrMaintenanceDeferredError: class extends Error {
    constructor(
      public reason: string,
      public retryAt: Date
    ) {
      super(reason);
    }
  },
}));

const head = 'a'.repeat(40),
  base = 'b'.repeat(40),
  reply = 'This request does not apply to the current code.';
const policy = watchPrMaintenancePolicySchema.parse({
  version: 2,
  automaticWritesConsent: true,
  historyRewriteConsent: true,
  noHardSpendCapConsent: true,
  model: 'test/model',
  profileId: null,
  environmentId: null,
  categories: { reviews: true, failedChecks: true, conflicts: true },
});
describe('persisted reply authority and generation', () => {
  const users: string[] = [];
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreate.mockResolvedValue({ headers: {}, data: { id: 99 } });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    for (const userId of users.splice(0)) {
      await db
        .delete(cloud_agent_pr_watches)
        .where(eq(cloud_agent_pr_watches.kilo_user_id, userId));
      await db.delete(cloud_agent_worktrees).where(eq(cloud_agent_worktrees.kilo_user_id, userId));
      await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
    }
  });
  async function fixture() {
    const user = await insertTestUser();
    users.push(user.id);
    const worktreeId = `worktree_${randomUUID()}`;
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: '123',
        github_app_type: 'standard',
        repository_access: 'all',
        permissions: { contents: 'write' },
      })
      .returning();
    if (!integration) throw new Error('Missing integration fixture');
    await db
      .insert(cloud_agent_worktrees)
      .values({ worktree_id: worktreeId, kilo_user_id: user.id });
    const [watch] = await db
      .insert(cloud_agent_pr_watches)
      .values({
        kilo_user_id: user.id,
        integration_id: integration.id,
        installation_id: '123',
        github_app_type: 'standard',
        repository_id: '456',
        repo_url: 'https://github.com/test/reply-ledger',
        pr_number: 7,
        source_session_id: `ses_${randomUUID()}`,
        source_cloud_agent_session_id: `workspace_${randomUUID()}`,
        worktree_id: worktreeId,
        head_ref: 'feature',
        base_ref: 'main',
        head_sha: head,
        base_sha: base,
        policy,
        projection: emptyWatchPrProjection(),
        generation: 1,
        pending_revision: 1,
        total_attempts: 1,
        expires_at: null,
      })
      .returning();
    if (!watch) throw new Error('Missing watch fixture');
    const problem = {
      kind: 'review' as const,
      problemKey: 'issue_comment:9',
      contentFingerprint: 'review-fingerprint',
      source: 'conversation_comment' as const,
      sourceId: '9',
      threadId: null,
      authorLogin: 'reviewer',
      body: 'Please change the current behavior.',
      url: 'https://github.com/test/reply-ledger/pull/7#issuecomment-9',
      commitSha: null,
    };
    const input = watchPrMaintenanceInputSchema.parse({
      version: 1,
      purpose: 'Maintain this PR.',
      constraints: [],
      repository: {
        repositoryId: watch.repository_id,
        repoUrl: watch.repo_url,
        prNumber: watch.pr_number,
        headRef: watch.head_ref,
        baseRef: watch.base_ref,
        headSha: head,
        baseSha: base,
        parentCommitSha: null,
      },
      policy,
      ordinal: 1,
      problems: [problem],
      problemAttempts: [{ problemKey: problem.problemKey, attempts: 0 }],
      priorDispositions: [],
      previousResults: [],
      verificationCommands: [],
      references: [],
    });
    const result = watchPrMaintenanceResultSchema.parse({
      version: 1,
      summary: reply,
      changedFiles: [],
      verification: [],
      publication: { status: 'not_attempted', reason: 'No code change is required.' },
      problems: [
        {
          problemKey: problem.problemKey,
          contentFingerprint: problem.contentFingerprint,
          disposition: 'disagreed',
          reason: reply,
          evidence: [],
          threadId: null,
          reply,
          resolve: false,
        },
      ],
      needsInput: null,
    });
    const [attempt] = await db
      .insert(cloud_agent_pr_maintenance_attempts)
      .values({
        watch_id: watch.id,
        worktree_id: worktreeId,
        generation: 1,
        pending_revision: 1,
        ordinal: 1,
        creation_operation_key: randomUUID(),
        message_id: randomUUID(),
        input,
        result,
        status: 'completed',
        finished_at: new Date().toISOString(),
      })
      .returning();
    if (!attempt) throw new Error('Missing attempt fixture');
    await db
      .update(cloud_agent_pr_watches)
      .set({ last_attempt_id: attempt.id })
      .where(eq(cloud_agent_pr_watches.id, watch.id));
    const [disposition] = await db
      .insert(cloud_agent_pr_feedback_dispositions)
      .values({
        watch_id: watch.id,
        attempt_id: attempt.id,
        problem_key: problem.problemKey,
        content_fingerprint: problem.contentFingerprint,
        disposition: 'disagreed',
        reason: reply,
        evidence: [],
        thread_id: null,
        reply_body: reply,
        resolution_status: 'not_applicable',
      })
      .returning();
    if (!disposition) throw new Error('Missing disposition fixture');
    return { watch, attempt, disposition };
  }
  it('reuses the original unknown receipt after pause/resume and records only one external reply', async () => {
    const { watch, attempt, disposition } = await fixture();
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    mockCreate.mockRejectedValueOnce(new Error('transport disconnected'));
    expect(await publishWatchPrReplies({ watch, attemptId: attempt.id })).toMatchObject({
      status: 'deferred',
    });
    const [paused] = await db
      .update(cloud_agent_pr_watches)
      .set({ status: 'paused', generation: 2 })
      .where(eq(cloud_agent_pr_watches.id, watch.id))
      .returning();
    if (!paused) throw new Error('Missing paused fixture');
    expect(await publishWatchPrReplies({ watch, attemptId: attempt.id })).toMatchObject({
      status: 'deferred',
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [resumed] = await db
      .update(cloud_agent_pr_watches)
      .set({ status: 'watching', generation: 3 })
      .where(eq(cloud_agent_pr_watches.id, watch.id))
      .returning();
    if (!resumed) throw new Error('Missing resumed fixture');
    clock.mockReturnValue(now + 31000);
    const marker = watchPrReplyBody(reply, `${attempt.id}:summary`).marker;
    mockRequest.mockResolvedValue({
      headers: {},
      data: {
        data: {
          repository: {
            pullRequest: {
              comments: {
                nodes: [
                  {
                    id: 'node-reply',
                    fullDatabaseId: '99',
                    body: marker,
                    author: { login: 'kiloconnect', __typename: 'Bot' },
                  },
                ],
              },
            },
          },
        },
      },
    });
    expect(await publishWatchPrReplies({ watch: resumed, attemptId: attempt.id })).toEqual({
      status: 'completed',
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    const saved = await db.query.cloud_agent_pr_feedback_dispositions.findFirst({
      where: eq(cloud_agent_pr_feedback_dispositions.id, disposition.id),
    });
    expect(saved).toMatchObject({ reply_comment_id: '99', replied_at: expect.any(String) });
    const receipts = await db
      .select()
      .from(cloud_agent_pr_watch_activity)
      .where(
        and(
          eq(cloud_agent_pr_watch_activity.watch_id, watch.id),
          eq(cloud_agent_pr_watch_activity.kind, 'reply')
        )
      );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      generation: 1,
      data: { state: 'posted', commentId: '99' },
    });
  });
  it('fences a stale queued write after Stop commits', async () => {
    const { watch, attempt } = await fixture();
    await db
      .update(cloud_agent_pr_watches)
      .set({ status: 'finished', generation: 2, finished_at: new Date().toISOString() })
      .where(eq(cloud_agent_pr_watches.id, watch.id));
    expect(await publishWatchPrReplies({ watch, attemptId: attempt.id })).toMatchObject({
      status: 'deferred',
    });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
    expect(
      await db
        .select()
        .from(cloud_agent_pr_watch_activity)
        .where(eq(cloud_agent_pr_watch_activity.watch_id, watch.id))
    ).toEqual([]);
  });
  it('retains an unknown reply receipt across a pause longer than ordinary activity retention', async () => {
    const { watch, attempt } = await fixture();
    mockCreate.mockRejectedValueOnce(new Error('transport disconnected'));
    await publishWatchPrReplies({ watch, attemptId: attempt.id });
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    await db
      .update(cloud_agent_pr_watch_activity)
      .set({ created_at: old })
      .where(eq(cloud_agent_pr_watch_activity.watch_id, watch.id));
    await db
      .insert(cloud_agent_pr_watch_activity)
      .values({ watch_id: watch.id, generation: 1, kind: 'observation', created_at: old });
    await db
      .update(cloud_agent_pr_watches)
      .set({ status: 'paused', generation: 2 })
      .where(eq(cloud_agent_pr_watches.id, watch.id));
    await cleanupWatchPrData();
    expect(
      await db
        .select()
        .from(cloud_agent_pr_watch_activity)
        .where(
          and(
            eq(cloud_agent_pr_watch_activity.watch_id, watch.id),
            eq(cloud_agent_pr_watch_activity.kind, 'reply')
          )
        )
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(cloud_agent_pr_watch_activity)
        .where(
          and(
            eq(cloud_agent_pr_watch_activity.watch_id, watch.id),
            eq(cloud_agent_pr_watch_activity.kind, 'observation')
          )
        )
    ).toHaveLength(0);
    await db
      .update(cloud_agent_pr_watches)
      .set({ status: 'finished', generation: 3, finished_at: new Date().toISOString() })
      .where(eq(cloud_agent_pr_watches.id, watch.id));
    await cleanupWatchPrData();
    expect(
      await db
        .select()
        .from(cloud_agent_pr_watch_activity)
        .where(eq(cloud_agent_pr_watch_activity.watch_id, watch.id))
    ).toEqual([]);
  });
  it('clears retained chat links when a finished watch expires and preserves the chat kind', async () => {
    const { watch, attempt } = await fixture();
    const sessionId = `ses_${randomUUID()}`;
    await db.insert(cli_sessions_v2).values({
      session_id: sessionId,
      kilo_user_id: watch.kilo_user_id,
      chat_kind: 'maintenance',
      maintenance_watch_id: watch.id,
      maintenance_attempt_id: attempt.id,
    });
    try {
      await db
        .update(cloud_agent_pr_watches)
        .set({
          status: 'finished',
          finished_at: new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString(),
        })
        .where(eq(cloud_agent_pr_watches.id, watch.id));
      await cleanupWatchPrData();
      const [session] = await db
        .select()
        .from(cli_sessions_v2)
        .where(eq(cli_sessions_v2.session_id, sessionId));
      expect(session).toMatchObject({
        chat_kind: 'maintenance',
        maintenance_watch_id: null,
        maintenance_attempt_id: null,
      });
      expect(
        await db
          .select()
          .from(cloud_agent_pr_maintenance_attempts)
          .where(eq(cloud_agent_pr_maintenance_attempts.id, attempt.id))
      ).toEqual([]);
    } finally {
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, sessionId));
    }
  });
});
