import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  cli_sessions_v2,
  cloud_agent_pr_maintenance_attempts,
  cloud_agent_pr_watches,
  cloud_agent_worktrees,
  platform_integrations,
  type CloudAgentPrMaintenanceAttempt,
  type CloudAgentPrWatch,
} from '@kilocode/db/schema';
import {
  watchPrMaintenanceInputSchema,
  watchPrMaintenancePolicySchema,
  type WatchPrMaintenanceResult,
} from '@kilocode/db/cloud-agent-pr-maintenance';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { dispatchWatchPrMaintenance } from './watch-pr-maintenance';
import { maintenanceChatStatus } from './watch-pr-maintenance-client';
import { liveAttemptCondition } from './watch-pr-maintenance-store';
import { emptyWatchPrProjection } from './watch-pr-events';

jest.mock('./watch-pr-maintenance-authorization', () => ({
  MaintenanceSettingsError: class extends Error {},
  MaintenanceBalanceError: class extends Error {},
  authorizeMaintenanceWatch: jest.fn(async () => ({})),
}));
jest.mock('./watch-pr-maintenance-client', () => ({
  maintenanceChatStatus: jest.fn(),
  scheduleWatchPr: jest.fn(),
  stopMaintenanceChat: jest.fn(),
}));
jest.mock('./watch-pr-github', () => ({
  publishWatchPrReplies: jest.fn(async () => ({ status: 'completed' })),
}));
jest.mock('./watch-pr-conflicts', () => ({ processWatchPrConflictBatch: jest.fn() }));
jest.mock('./watch-pr-assessment', () => ({
  collectWatchPrProblems: jest.requireActual('./watch-pr-observation').collectWatchPrProblems,
}));

const past = '2026-01-01T00:00:00Z';
const oldParent = 'd'.repeat(40);
const repoUrl = 'https://github.com/example/continuation';
let watch: CloudAgentPrWatch;
let attempt: CloudAgentPrMaintenanceAttempt;
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

beforeEach(async () => {
  jest.clearAllMocks();
  const user = await insertTestUser();
  const worktreeId = `worktree_${randomUUID()}`;
  const cloudSessionId = `workspace_${randomUUID()}`;
  const sessionId = `ses_${randomUUID().replaceAll('-', '').slice(0, 26)}`;
  await db
    .insert(cloud_agent_worktrees)
    .values({ worktree_id: worktreeId, kilo_user_id: user.id, base_sha: oldParent });
  const [integration] = await db
    .insert(platform_integrations)
    .values({
      platform: 'github',
      integration_type: 'app',
      owned_by_user_id: user.id,
      platform_installation_id: '101',
    })
    .returning();
  if (!integration) throw new Error('Missing integration');
  const [created] = await db
    .insert(cloud_agent_pr_watches)
    .values({
      kilo_user_id: user.id,
      integration_id: integration.id,
      installation_id: '101',
      github_app_type: 'standard',
      repository_id: randomUUID(),
      repo_url: repoUrl,
      pr_number: 1,
      source_session_id: sessionId,
      source_cloud_agent_session_id: cloudSessionId,
      worktree_id: worktreeId,
      head_ref: 'feature',
      base_ref: 'main',
      head_sha: 'a'.repeat(40),
      base_sha: 'b'.repeat(40),
      policy,
      projection: emptyWatchPrProjection(),
      next_run_at: past,
      last_assessed_at: past,
      total_attempts: 1,
    })
    .returning();
  if (!created) throw new Error('Missing watch');
  watch = created;
  const input = watchPrMaintenanceInputSchema.parse({
    version: 1,
    purpose: 'Preserve widget API compatibility',
    constraints: [],
    repository: {
      repositoryId: watch.repository_id,
      repoUrl,
      prNumber: 1,
      headRef: watch.head_ref,
      baseRef: watch.base_ref,
      headSha: watch.head_sha,
      baseSha: watch.base_sha,
      parentCommitSha: oldParent,
    },
    policy,
    ordinal: 1,
    problems: [
      {
        kind: 'review',
        problemKey: 'comment:1',
        contentFingerprint: 'feedback-v1',
        source: 'review_comment',
        sourceId: '1',
        threadId: null,
        authorLogin: 'reviewer',
        body: 'Choose a compatible API behavior.',
        url: null,
        commitSha: watch.head_sha,
      },
    ],
    problemAttempts: [],
    priorDispositions: [],
    previousResults: [],
    verificationCommands: [],
    references: [],
  });
  const [reserved] = await db
    .insert(cloud_agent_pr_maintenance_attempts)
    .values({
      watch_id: watch.id,
      worktree_id: worktreeId,
      generation: 1,
      pending_revision: 0,
      ordinal: 1,
      creation_operation_key: randomUUID(),
      message_id: `msg_${randomUUID()}`,
      session_id: sessionId,
      cloud_agent_session_id: cloudSessionId,
      status: 'running',
      input,
      started_at: past,
      next_run_at: past,
    })
    .returning();
  if (!reserved) throw new Error('Missing attempt');
  attempt = reserved;
  await db.insert(cli_sessions_v2).values({
    session_id: sessionId,
    kilo_user_id: user.id,
    cloud_agent_worktree_id: worktreeId,
    cloud_agent_session_id: cloudSessionId,
    chat_kind: 'maintenance',
    maintenance_watch_id: watch.id,
    maintenance_attempt_id: attempt.id,
  });
  await db
    .update(cloud_agent_pr_watches)
    .set({ last_attempt_id: attempt.id })
    .where(eq(cloud_agent_pr_watches.id, watch.id));
});

afterEach(async () => {
  await db.delete(cloud_agent_pr_watches).where(eq(cloud_agent_pr_watches.id, watch.id));
});

function questionResult(source: 'top' | 'problem'): WatchPrMaintenanceResult {
  return {
    version: 1,
    summary: 'Choose the supported API behavior',
    changedFiles: [],
    verification: [],
    publication: { status: 'not_attempted', reason: 'Waiting for the answer' },
    problems: [
      {
        problemKey: 'comment:1',
        contentFingerprint: 'feedback-v1',
        disposition: source === 'problem' ? 'needs_input' : 'deferred',
        reason: 'Should the legacy API stay supported?',
        evidence: [],
        threadId: null,
        reply: null,
        resolve: false,
      },
    ],
    needsInput: source === 'top' ? 'Should the legacy API stay supported?' : null,
  };
}

async function due() {
  await db
    .update(cloud_agent_pr_watches)
    .set({ next_run_at: past })
    .where(eq(cloud_agent_pr_watches.id, watch.id));
  await db
    .update(cloud_agent_pr_maintenance_attempts)
    .set({ next_run_at: past })
    .where(eq(cloud_agent_pr_maintenance_attempts.id, attempt.id));
  await dispatchWatchPrMaintenance({ watchId: watch.id });
}

function envelope(
  result: WatchPrMaintenanceResult,
  waitingForInput: boolean,
  latestMessageId: string,
  publication: WatchPrMaintenanceResult['publication']
) {
  return {
    message: { messageId: attempt.message_id, status: 'completed' as const },
    latestMessage: { messageId: latestMessageId, status: 'completed' as const },
    waitingForInput,
    stoppedAt: null,
    result,
    publication,
    resultMessageId: attempt.message_id,
    publicationMessageId: latestMessageId,
  };
}

describe.each(['top', 'problem'] as const)('%s-level result question', source => {
  it.each(['published', 'not_attempted'] as const)(
    'finishes a later plain answer without a stale live pin, preserving %s evidence',
    async publicationStatus => {
      const result = questionResult(source);
      jest
        .mocked(maintenanceChatStatus)
        .mockResolvedValue(envelope(result, false, attempt.message_id, result.publication));
      await due();
      expect(
        await db.query.cloud_agent_pr_maintenance_attempts.findFirst({
          where: eq(cloud_agent_pr_maintenance_attempts.id, attempt.id),
        })
      ).toMatchObject({ status: 'needs_input', finished_at: null });
      const publication: WatchPrMaintenanceResult['publication'] =
        publicationStatus === 'published'
          ? {
              status: 'published',
              source: 'git',
              repoUrl,
              headRef: watch.head_ref,
              observedHeadSha: watch.head_sha,
              pushedHeadSha: 'c'.repeat(40),
              remoteHeadSha: 'c'.repeat(40),
              baseSha: watch.base_sha,
              exactLease: `refs/heads/${watch.head_ref}:${watch.head_sha}`,
              pushExitCode: 0,
              verifiedAt: new Date(Date.now() + 1000).toISOString(),
              ownedRebase: {
                source: 'git',
                attemptId: attempt.id,
                baseSha: watch.base_sha,
                previousHeadSha: watch.head_sha,
                rebasedHeadSha: 'c'.repeat(40),
                completedAt: new Date().toISOString(),
              },
            }
          : { status: 'not_attempted', reason: 'The plain answer did not publish' };
      jest
        .mocked(maintenanceChatStatus)
        .mockResolvedValue(envelope(result, false, 'msg_plain_answer', publication));
      await due();
      const finished = await db.query.cloud_agent_pr_maintenance_attempts.findFirst({
        where: eq(cloud_agent_pr_maintenance_attempts.id, attempt.id),
      });
      expect(finished).toMatchObject({
        status: 'failed',
        next_run_at: null,
        result: { publication: { status: publicationStatus }, needsInput: null, problems: [] },
      });
      expect(finished?.finished_at).not.toBeNull();
      expect(
        await db.query.cloud_agent_pr_maintenance_attempts.findMany({
          where: and(
            eq(cloud_agent_pr_maintenance_attempts.watch_id, watch.id),
            liveAttemptCondition
          ),
        })
      ).toEqual([]);
      expect(
        await db.query.cloud_agent_pr_watches.findFirst({
          where: eq(cloud_agent_pr_watches.id, watch.id),
        })
      ).toMatchObject({
        status: 'paused',
        execution_status: 'watching',
        next_run_at: null,
        lifecycle_reason:
          publicationStatus === 'published'
            ? 'maintenance_result_unavailable_after_publication'
            : 'maintenance_result_unavailable_after_answer',
      });
      expect(
        await db.query.cloud_agent_worktrees.findFirst({
          where: eq(cloud_agent_worktrees.worktree_id, watch.worktree_id),
        })
      ).toMatchObject({ base_sha: publicationStatus === 'published' ? watch.base_sha : oldParent });
    }
  );
});

it('does not clear a genuine current native pending question', async () => {
  const result = questionResult('top');
  jest
    .mocked(maintenanceChatStatus)
    .mockResolvedValue(envelope(result, true, 'msg_later_question', result.publication));
  await due();
  expect(
    await db.query.cloud_agent_pr_maintenance_attempts.findFirst({
      where: eq(cloud_agent_pr_maintenance_attempts.id, attempt.id),
    })
  ).toMatchObject({ status: 'needs_input', finished_at: null });
});

it('does not discard a valid earlier result that did not ask a question', async () => {
  const result = questionResult('top');
  const prior: WatchPrMaintenanceResult = {
    ...result,
    needsInput: null,
    problems: result.problems.map(problem => ({
      ...problem,
      disposition: 'already_addressed',
      reason: 'The API already preserves this behavior',
    })),
  };
  jest
    .mocked(maintenanceChatStatus)
    .mockResolvedValue(envelope(prior, false, 'msg_plain_followup', prior.publication));
  await due();
  expect(
    await db.query.cloud_agent_pr_maintenance_attempts.findFirst({
      where: eq(cloud_agent_pr_maintenance_attempts.id, attempt.id),
    })
  ).toMatchObject({ status: 'completed', result: { needsInput: null } });
});
