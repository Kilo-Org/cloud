import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import {
  cli_sessions_v2,
  cloud_agent_pr_feedback_dispositions,
  cloud_agent_pr_maintenance_attempts,
  cloud_agent_pr_watches,
  cloud_agent_worktrees,
  platform_integrations,
  type CloudAgentPrWatch,
  type CloudAgentPrMaintenanceAttempt,
} from '@kilocode/db/schema';
import {
  watchPrMaintenancePolicySchema,
  type WatchPrMaintenanceResult,
} from '@kilocode/db/cloud-agent-pr-maintenance';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { emptyWatchPrProjection, type WatchPrProjection } from './watch-pr-events';
import { assessAndScheduleWatchPr, dispatchWatchPrMaintenance } from './watch-pr-maintenance';
import { assessWatchPr } from './watch-pr-assessment';
import { createEmptyPrObservations } from '@/lib/integrations/platforms/github/pr-observations';
import {
  authorizeMaintenanceExecution,
  authorizeMaintenanceWatch,
  validateMaintenanceSettings,
} from './watch-pr-maintenance-authorization';
import { publishWatchPrReplies, prepareWatchPrProblems } from './watch-pr-github';
import {
  maintenanceChatStatus,
  maintenanceWorkspace,
  scheduleWatchPr,
  startMaintenanceChat,
  stopMaintenanceChat,
} from './watch-pr-maintenance-client';

jest.mock('./watch-pr-maintenance-authorization', () => ({
  MaintenanceSettingsError: class extends Error {},
  MaintenanceBalanceError: class extends Error {},
  authorizeMaintenanceWatch: jest.fn(async () => ({
    worktree: { parent_worktree_id: null, base_sha: null },
  })),
  authorizeMaintenanceExecution: jest.fn(async () => ({
    worktree: { parent_worktree_id: null, base_sha: null },
  })),
  mintMaintenanceAuthorization: jest.fn(async () => ({
    runtimeToken: 'synthetic-token',
    runtimeAuthorizationSeal: 'synthetic-seal',
  })),
  validateMaintenanceSettings: jest.fn(async () => ({})),
}));
jest.mock('./watch-pr-maintenance-client', () => ({
  maintenanceWorkspace: jest.fn(async () => ({
    purpose: 'Validate widget input without changing the public API',
    constraints: ['Keep existing CLI flags'],
    profileId: null,
    environmentId: null,
  })),
  maintenanceChatStatus: jest.fn(),
  startMaintenanceChat: jest.fn(),
  stopMaintenanceChat: jest.fn(async () => null),
  scheduleWatchPr: jest.fn(),
}));
jest.mock('./watch-pr-assessment', () => ({
  assessWatchPr: jest.fn(),
  collectWatchPrProblems: jest.requireActual('./watch-pr-observation').collectWatchPrProblems,
}));
jest.mock('./watch-pr-conflicts', () => ({
  processWatchPrConflictBatch: jest.fn(async () => undefined),
}));
jest.mock('./watch-pr-github', () => ({
  prepareWatchPrProblems: jest.fn(async ({ problems }) => problems),
  publishWatchPrReplies: jest.fn(async () => ({ status: 'completed' })),
}));

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
const past = '2026-01-01T00:00:00Z';
const repoUrl = 'https://github.com/example/maintenance-lifecycle';
let watch: CloudAgentPrWatch;
let sourceSessionId: string;

function projection(id = '1'): WatchPrProjection {
  return {
    ...emptyWatchPrProjection(),
    pending: [{ key: `comment:${id}`, reason: 'actionable_review' }],
    evidence: [
      {
        kind: 'feedback',
        key: `comment:${id}`,
        sha: 'a'.repeat(40),
        updatedAt: past,
        state: 'commented',
        actorLogin: 'reviewer',
        trusted: true,
        body: `Fix problem ${id}`,
        sourceId: id,
        source: 'review_comment',
        contentFingerprint: `feedback-${id}`,
      },
    ],
  };
}

async function currentAttempt() {
  const attempt = await db.query.cloud_agent_pr_maintenance_attempts.findFirst({
    where: eq(cloud_agent_pr_maintenance_attempts.watch_id, watch.id),
  });
  if (!attempt) throw new Error('Missing attempt');
  return attempt;
}
async function dispatchDue() {
  await db
    .update(cloud_agent_pr_watches)
    .set({ next_run_at: past })
    .where(eq(cloud_agent_pr_watches.id, watch.id));
  await db
    .update(cloud_agent_pr_maintenance_attempts)
    .set({ next_run_at: past })
    .where(eq(cloud_agent_pr_maintenance_attempts.watch_id, watch.id));
  return dispatchWatchPrMaintenance({ watchId: watch.id });
}
const status = (overrides: object = {}) => ({
  message: null,
  latestMessage: null,
  waitingForInput: false,
  stoppedAt: null,
  result: null,
  publication: null,
  ...overrides,
});

function completedResult(
  attempt: CloudAgentPrMaintenanceAttempt,
  overrides: Partial<WatchPrMaintenanceResult> = {}
): WatchPrMaintenanceResult {
  return {
    version: 1,
    summary: 'Handled current problems',
    changedFiles: ['widget.ts'],
    verification: [
      { command: 'pnpm test:widgets', outcome: 'passed', summary: 'Passed', evidenceUrls: [] },
    ],
    publication: {
      status: 'published',
      source: 'git',
      repoUrl,
      headRef: 'feature',
      observedHeadSha: watch.head_sha,
      pushedHeadSha: 'c'.repeat(40),
      remoteHeadSha: 'c'.repeat(40),
      baseSha: watch.base_sha,
      exactLease: `refs/heads/feature:${watch.head_sha}`,
      pushExitCode: 0,
      verifiedAt: new Date(Date.now() + 1000).toISOString(),
    },
    problems: attempt.input.problems.map(problem => ({
      problemKey: problem.problemKey,
      contentFingerprint: problem.contentFingerprint,
      disposition: 'addressed',
      reason: 'Fixed',
      evidence: [],
      threadId: problem.kind === 'review' ? problem.threadId : null,
      reply: 'Fixed and checked',
      resolve: false,
    })),
    needsInput: null,
    ...overrides,
  };
}

async function finishWithResult(
  attempt: CloudAgentPrMaintenanceAttempt,
  result: WatchPrMaintenanceResult
) {
  jest.mocked(maintenanceChatStatus).mockResolvedValue(
    status({
      message: { messageId: attempt.message_id, status: 'completed' },
      result,
      publication: result.publication,
    })
  );
  await dispatchDue();
}

beforeEach(async () => {
  jest.clearAllMocks();
  jest.mocked(maintenanceChatStatus).mockResolvedValue(null);
  const user = await insertTestUser();
  const worktreeId = `worktree_${randomUUID()}`;
  sourceSessionId = `ses_${randomUUID().replaceAll('-', '').slice(0, 26)}`;
  await db.insert(cloud_agent_worktrees).values({ worktree_id: worktreeId, kilo_user_id: user.id });
  await db.insert(cli_sessions_v2).values({
    session_id: sourceSessionId,
    kilo_user_id: user.id,
    cloud_agent_worktree_id: worktreeId,
    cloud_agent_session_id: `workspace_${randomUUID()}`,
    status: 'idle',
    status_updated_at: past,
  });
  const [integration] = await db
    .insert(platform_integrations)
    .values({
      owned_by_user_id: user.id,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: '101',
      repository_access: 'all',
      permissions: { contents: 'write' },
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
      source_session_id: sourceSessionId,
      source_cloud_agent_session_id: `workspace_${randomUUID()}`,
      worktree_id: worktreeId,
      head_ref: 'feature',
      base_ref: 'main',
      head_sha: 'a'.repeat(40),
      base_sha: 'b'.repeat(40),
      policy,
      projection: projection(),
      last_assessed_at: past,
      next_run_at: past,
      pending_since: past,
      pending_revision: 1,
    })
    .returning();
  if (!created) throw new Error('Missing watch');
  watch = created;
  jest.mocked(startMaintenanceChat).mockImplementation(async input => {
    const stored = await db.query.cloud_agent_pr_maintenance_attempts.findFirst({
      where: eq(cloud_agent_pr_maintenance_attempts.id, input.attemptId),
    });
    if (!stored) throw new Error('Attempt identity was not persisted before delivery');
    expect(stored.creation_operation_key).toBe(input.creationOperationKey);
    expect(stored.message_id).toBe(input.messageId);
    expect(stored.session_id).toBe(input.kiloSessionId);
    await db
      .insert(cli_sessions_v2)
      .values({
        session_id: input.kiloSessionId,
        kilo_user_id: user.id,
        cloud_agent_session_id: input.cloudAgentSessionId,
        cloud_agent_worktree_id: worktreeId,
      })
      .onConflictDoNothing();
    return {
      kiloSessionId: input.kiloSessionId,
      cloudAgentSessionId: input.cloudAgentSessionId,
      worktreeId,
      messageId: input.messageId,
    };
  });
});

it('admits only one live attempt when dispatch deliveries overlap', async () => {
  await Promise.all([
    dispatchWatchPrMaintenance({ watchId: watch.id }),
    dispatchWatchPrMaintenance({ watchId: watch.id }),
  ]);
  const attempts = await db.query.cloud_agent_pr_maintenance_attempts.findMany({
    where: eq(cloud_agent_pr_maintenance_attempts.watch_id, watch.id),
  });
  expect(attempts).toHaveLength(1);
  expect(attempts[0].ordinal).toBe(1);
  expect(startMaintenanceChat).toHaveBeenCalledTimes(1);
});

it('gives the runtime a per-watch timer for the normalized due time after dispatch', async () => {
  await dispatchDue();
  expect((await currentAttempt()).status).toBe('running');
  const current = await db.query.cloud_agent_pr_watches.findFirst({
    where: eq(cloud_agent_pr_watches.id, watch.id),
  });
  expect(Date.parse(current?.next_run_at ?? '')).toBeGreaterThan(Date.now());
  expect(scheduleWatchPr).toHaveBeenCalledTimes(1);
  const [watchId, dueAt] = jest.mocked(scheduleWatchPr).mock.calls[0];
  expect(watchId).toBe(watch.id);
  expect(Date.parse(dueAt)).toBe(Date.parse(current?.next_run_at ?? ''));
});

it('keeps dispatch progress when the runtime cannot accept the next timer', async () => {
  jest.mocked(scheduleWatchPr).mockRejectedValueOnce(new Error('Synthetic runtime outage'));
  await expect(dispatchDue()).resolves.toEqual({ scheduled: [] });
  expect((await currentAttempt()).status).toBe('running');
  const current = await db.query.cloud_agent_pr_watches.findFirst({
    where: eq(cloud_agent_pr_watches.id, watch.id),
  });
  expect(current).toMatchObject({ status: 'watching', execution_status: 'fixing' });
  expect(Date.parse(current?.next_run_at ?? '')).toBeGreaterThan(Date.now());
});

it('keeps the two-per-problem limit across fresh maintenance chats', async () => {
  for (let index = 0; index < 2; index++) {
    jest.mocked(maintenanceChatStatus).mockResolvedValue(null);
    await dispatchDue();
    const attempts = await db.query.cloud_agent_pr_maintenance_attempts.findMany({
      where: eq(cloud_agent_pr_maintenance_attempts.watch_id, watch.id),
    });
    const attempt = attempts.find(item => item.status === 'running');
    if (!attempt) throw new Error('Missing running attempt');
    jest
      .mocked(maintenanceChatStatus)
      .mockResolvedValue(status({ message: { messageId: attempt.message_id, status: 'failed' } }));
    await dispatchDue();
  }
  await dispatchDue();
  const current = await db.query.cloud_agent_pr_watches.findFirst({
    where: eq(cloud_agent_pr_watches.id, watch.id),
  });
  expect(current).toMatchObject({
    status: 'watching',
    lifecycle_reason: 'problem_attempt_limit',
    total_attempts: 2,
  });
  expect(startMaintenanceChat).toHaveBeenCalledTimes(2);
});

it('aligns an arriving event with the live attempt deadline instead of leaving a hot-loop due time', async () => {
  await dispatchDue();
  const attempt = await currentAttempt();
  const dueAt = new Date(Date.now() + 60_000).toISOString();
  await db
    .update(cloud_agent_pr_maintenance_attempts)
    .set({ next_run_at: dueAt })
    .where(eq(cloud_agent_pr_maintenance_attempts.id, attempt.id));
  await db
    .update(cloud_agent_pr_watches)
    .set({ next_run_at: past, pending_revision: 2 })
    .where(eq(cloud_agent_pr_watches.id, watch.id));
  jest.mocked(maintenanceChatStatus).mockClear();
  expect(await dispatchWatchPrMaintenance({ watchId: watch.id })).toEqual({ scheduled: [] });
  const current = await db.query.cloud_agent_pr_watches.findFirst({
    where: eq(cloud_agent_pr_watches.id, watch.id),
  });
  expect(Date.parse(current?.next_run_at ?? '')).toBe(Date.parse(dueAt));
  expect(maintenanceChatStatus).not.toHaveBeenCalled();
});

it('uses one bounded scan per cycle across multiple watches, with no returned queue chains', async () => {
  await dispatchDue();
  const original = await currentAttempt();
  const worktreeId = `worktree_${randomUUID()}`;
  await db
    .insert(cloud_agent_worktrees)
    .values({ worktree_id: worktreeId, kilo_user_id: watch.kilo_user_id });
  const [other] = await db
    .insert(cloud_agent_pr_watches)
    .values({
      ...watch,
      id: randomUUID(),
      worktree_id: worktreeId,
      repository_id: randomUUID(),
      next_run_at: past,
    })
    .returning();
  if (!other) throw new Error('Missing second watch');
  await db.insert(cloud_agent_pr_maintenance_attempts).values({
    ...original,
    id: randomUUID(),
    watch_id: other.id,
    worktree_id: worktreeId,
    creation_operation_key: randomUUID(),
    message_id: `msg_${randomUUID()}`,
    session_id: `ses_${randomUUID()}`,
    cloud_agent_session_id: `workspace_${randomUUID()}`,
    next_run_at: past,
  });
  jest
    .mocked(maintenanceChatStatus)
    .mockClear()
    .mockResolvedValue(status({ message: { messageId: original.message_id, status: 'running' } }));
  try {
    for (let cycle = 0; cycle < 4; cycle++) {
      await db
        .update(cloud_agent_pr_watches)
        .set({ next_run_at: past })
        .where(eq(cloud_agent_pr_watches.kilo_user_id, watch.kilo_user_id));
      await db
        .update(cloud_agent_pr_maintenance_attempts)
        .set({ next_run_at: past })
        .where(eq(cloud_agent_pr_maintenance_attempts.watch_id, watch.id));
      await db
        .update(cloud_agent_pr_maintenance_attempts)
        .set({ next_run_at: past })
        .where(eq(cloud_agent_pr_maintenance_attempts.watch_id, other.id));
      expect(await dispatchWatchPrMaintenance()).toEqual({ scheduled: [] });
      expect(await dispatchWatchPrMaintenance({ watchId: watch.id })).toEqual({ scheduled: [] });
      expect(await dispatchWatchPrMaintenance()).toEqual({ scheduled: [] });
      expect(maintenanceChatStatus).toHaveBeenCalledTimes((cycle + 1) * 2);
    }
  } finally {
    await db.delete(cloud_agent_pr_watches).where(eq(cloud_agent_pr_watches.id, other.id));
  }
});

it('advances a terminal revision collision rather than repeatedly attempting the same insertion', async () => {
  await dispatchDue();
  const previous = await currentAttempt();
  await db
    .update(cloud_agent_pr_maintenance_attempts)
    .set({ status: 'failed', finished_at: new Date().toISOString(), next_run_at: null })
    .where(eq(cloud_agent_pr_maintenance_attempts.id, previous.id));
  await dispatchDue();
  const attempts = await db.query.cloud_agent_pr_maintenance_attempts.findMany({
    where: eq(cloud_agent_pr_maintenance_attempts.watch_id, watch.id),
  });
  expect(attempts).toHaveLength(2);
  expect(attempts.find(item => item.status === 'running')?.pending_revision).toBe(
    previous.pending_revision + 1
  );
});

it.each(['success', 'ambiguous'] as const)(
  'compensates a late %s admission after Stop invalidated the attempt',
  async outcome => {
    const create = jest.mocked(startMaintenanceChat).getMockImplementation();
    jest.mocked(startMaintenanceChat).mockImplementationOnce(async input => {
      await db
        .update(cloud_agent_pr_watches)
        .set({ status: 'paused', generation: 2, lifecycle_reason: 'user_pause' })
        .where(eq(cloud_agent_pr_watches.id, watch.id));
      await db
        .update(cloud_agent_pr_maintenance_attempts)
        .set({ status: 'stopped', finished_at: new Date().toISOString(), next_run_at: null })
        .where(eq(cloud_agent_pr_maintenance_attempts.id, input.attemptId));
      if (outcome === 'ambiguous') throw new Error('Synthetic transport lost after late admission');
      if (!create) throw new Error('Missing create helper');
      return create(input);
    });
    await dispatchDue();
    expect(stopMaintenanceChat).toHaveBeenCalledWith(
      expect.objectContaining({ watchId: watch.id, attemptId: (await currentAttempt()).id })
    );
    expect((await currentAttempt()).status).toBe('stopped');
  }
);

it('retries a dirty-checkout conflict after quiet without suppressing the same fingerprint', async () => {
  await db
    .update(cloud_agent_pr_watches)
    .set({
      projection: {
        ...emptyWatchPrProjection(),
        pending: [{ key: 'conflict', reason: 'conflict' }],
        conflict: {
          headSha: watch.head_sha,
          baseSha: watch.base_sha,
          state: 'CONFLICTING',
          checkedAt: null,
          dueAt: null,
          retries: 0,
        },
      },
    })
    .where(eq(cloud_agent_pr_watches.id, watch.id));
  await dispatchDue();
  const attempt = await currentAttempt();
  await finishWithResult(
    attempt,
    completedResult(attempt, {
      changedFiles: [],
      publication: { status: 'not_attempted', reason: 'Checkout has unrelated user edits' },
      problems: attempt.input.problems.map(problem => ({
        problemKey: problem.problemKey,
        contentFingerprint: problem.contentFingerprint,
        disposition: 'deferred',
        reason: 'Retry when the checkout is idle',
        evidence: [],
        threadId: null,
        reply: null,
        resolve: false,
      })),
    })
  );
  const current = await db.query.cloud_agent_pr_watches.findFirst({
    where: eq(cloud_agent_pr_watches.id, watch.id),
  });
  expect(current).toMatchObject({
    status: 'watching',
    lifecycle_reason: 'waiting_for_clean_checkout',
  });
  expect(Date.parse(current?.next_run_at ?? '')).toBeGreaterThan(Date.now());
  jest.mocked(maintenanceChatStatus).mockResolvedValue(null);
  await dispatchDue();
  expect(
    await db.query.cloud_agent_pr_maintenance_attempts.findMany({
      where: eq(cloud_agent_pr_maintenance_attempts.watch_id, watch.id),
    })
  ).toHaveLength(2);
});

it('schedules fresh assessment after an exact lease rejection instead of permanently pausing', async () => {
  await dispatchDue();
  const attempt = await currentAttempt();
  await finishWithResult(
    attempt,
    completedResult(attempt, {
      publication: {
        status: 'failed',
        reason: 'maintenance_exact_lease_push_failed_fetch_and_reassess',
      },
    })
  );
  const current = await db.query.cloud_agent_pr_watches.findFirst({
    where: eq(cloud_agent_pr_watches.id, watch.id),
  });
  expect(current).toMatchObject({
    status: 'watching',
    last_assessed_at: null,
    lifecycle_reason: 'remote_head_changed_reassessing',
  });
  expect(Date.parse(current?.next_run_at ?? '')).toBeGreaterThan(Date.now());
});

it('shows incomplete verification after a real publication and retains its reviewer reply', async () => {
  await dispatchDue();
  const attempt = await currentAttempt();
  await finishWithResult(attempt, completedResult(attempt, { verification: [] }));
  expect(
    await db.query.cloud_agent_pr_watches.findFirst({
      where: eq(cloud_agent_pr_watches.id, watch.id),
    })
  ).toMatchObject({
    status: 'watching',
    execution_status: 'needs_input',
    lifecycle_reason: 'maintenance_verification_unavailable',
  });
  const disposition = await db.query.cloud_agent_pr_feedback_dispositions.findFirst({
    where: eq(cloud_agent_pr_feedback_dispositions.watch_id, watch.id),
  });
  expect(disposition).toMatchObject({ disposition: 'addressed' });
  expect(disposition?.reply_body).toContain('verification is incomplete');
  expect(publishWatchPrReplies).toHaveBeenCalled();
});

it('does not wait for busy chats, balance, catalog, or runtime settings when no work is actionable', async () => {
  await db
    .update(cloud_agent_pr_watches)
    .set({ projection: emptyWatchPrProjection() })
    .where(eq(cloud_agent_pr_watches.id, watch.id));
  await db
    .update(cli_sessions_v2)
    .set({ status: 'busy' })
    .where(eq(cli_sessions_v2.session_id, sourceSessionId));
  await dispatchDue();
  expect(authorizeMaintenanceExecution).not.toHaveBeenCalled();
  expect(maintenanceWorkspace).not.toHaveBeenCalled();
  expect(
    await db.query.cloud_agent_pr_watches.findFirst({
      where: eq(cloud_agent_pr_watches.id, watch.id),
    })
  ).toMatchObject({ execution_status: 'watching', next_run_at: null });
});

it('keeps reviewer approval as attention without disabling later CI or conflict maintenance', async () => {
  await db
    .update(cloud_agent_pr_watches)
    .set({
      projection: {
        ...emptyWatchPrProjection(),
        pending: [{ key: 'review:1', reason: 'review_blocker' }],
      },
    })
    .where(eq(cloud_agent_pr_watches.id, watch.id));
  await dispatchDue();
  expect(
    await db.query.cloud_agent_pr_watches.findFirst({
      where: eq(cloud_agent_pr_watches.id, watch.id),
    })
  ).toMatchObject({
    status: 'watching',
    lifecycle_reason: 'reviewer_approval_required',
    next_run_at: null,
  });
  await db
    .update(cloud_agent_pr_watches)
    .set({ projection: projection(), pending_revision: 2 })
    .where(eq(cloud_agent_pr_watches.id, watch.id));
  await dispatchDue();
  expect(startMaintenanceChat).toHaveBeenCalledTimes(1);
});

it('accepts the actual PR purpose when the original source prompt is unavailable', async () => {
  await db
    .update(cloud_agent_pr_watches)
    .set({
      projection: {
        ...projection(),
        purpose: { title: 'Validate widgets', body: 'Preserve the existing CLI contract' },
      },
    })
    .where(eq(cloud_agent_pr_watches.id, watch.id));
  jest.mocked(maintenanceWorkspace).mockResolvedValueOnce({
    purpose: null,
    constraints: [],
    profileId: null,
    environmentId: null,
    worktreeId: watch.worktree_id,
    sourceKiloSessionId: sourceSessionId,
    sourceCloudAgentSessionId: watch.source_cloud_agent_session_id,
  } as Awaited<ReturnType<typeof maintenanceWorkspace>>);
  await dispatchDue();
  expect((await currentAttempt()).input.purpose).toBe('Validate widgets');
});

it('retains revised observation state when hydration resolves all work without creating an empty attempt', async () => {
  jest.mocked(prepareWatchPrProblems).mockImplementationOnce(async () => {
    await db
      .update(cloud_agent_pr_watches)
      .set({ projection: emptyWatchPrProjection(), pending_revision: 2, next_run_at: null })
      .where(eq(cloud_agent_pr_watches.id, watch.id));
    return [];
  });
  await dispatchDue();
  expect(startMaintenanceChat).not.toHaveBeenCalled();
  expect(
    await db.query.cloud_agent_pr_watches.findFirst({
      where: eq(cloud_agent_pr_watches.id, watch.id),
    })
  ).toMatchObject({ pending_revision: 2, next_run_at: null });
});

it('delays a transient model-catalog failure without permanently pausing the watch', async () => {
  jest.mocked(validateMaintenanceSettings).mockRejectedValueOnce(
    new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Model catalog temporarily unavailable',
    })
  );
  await dispatchDue();
  expect(startMaintenanceChat).not.toHaveBeenCalled();
  const current = await db.query.cloud_agent_pr_watches.findFirst({
    where: eq(cloud_agent_pr_watches.id, watch.id),
  });
  expect(current).toMatchObject({
    status: 'watching',
    lifecycle_reason: 'maintenance_delivery_retry',
  });
  expect(Date.parse(current?.next_run_at ?? '')).toBeGreaterThan(Date.now());
});

it('invalidates pending delivery after a generation change', async () => {
  await dispatchDue();
  await db
    .update(cloud_agent_pr_watches)
    .set({ generation: watch.generation + 1, status: 'paused', lifecycle_reason: 'user_pause' })
    .where(eq(cloud_agent_pr_watches.id, watch.id));
  await dispatchDue();
  expect((await currentAttempt()).status).toBe('stopped');
  expect(stopMaintenanceChat).toHaveBeenCalledTimes(1);
  expect(startMaintenanceChat).toHaveBeenCalledTimes(1);
});

it('enforces the lifetime total-attempt limit before opening another chat', async () => {
  await db
    .update(cloud_agent_pr_watches)
    .set({ total_attempts: 10 })
    .where(eq(cloud_agent_pr_watches.id, watch.id));
  await dispatchDue();
  const current = await db.query.cloud_agent_pr_watches.findFirst({
    where: eq(cloud_agent_pr_watches.id, watch.id),
  });
  expect(current).toMatchObject({ status: 'paused', lifecycle_reason: 'total_attempt_limit' });
  expect(startMaintenanceChat).not.toHaveBeenCalled();
});

it('settles completed-attempt replies before waiting for later user work', async () => {
  await dispatchDue();
  const attempt = await currentAttempt();
  await db
    .update(cloud_agent_pr_maintenance_attempts)
    .set({ status: 'completed', finished_at: new Date().toISOString() })
    .where(eq(cloud_agent_pr_maintenance_attempts.id, attempt.id));
  await db
    .update(cli_sessions_v2)
    .set({ status: 'busy' })
    .where(eq(cli_sessions_v2.session_id, sourceSessionId));
  jest.mocked(publishWatchPrReplies).mockClear();
  await dispatchDue();
  expect(publishWatchPrReplies).toHaveBeenCalledWith({
    watch: expect.objectContaining({ id: watch.id }),
    attemptId: attempt.id,
  });
  expect(startMaintenanceChat).toHaveBeenCalledTimes(1);
  expect(
    await db.query.cloud_agent_pr_watches.findFirst({
      where: eq(cloud_agent_pr_watches.id, watch.id),
    })
  ).toMatchObject({ execution_status: 'waiting_for_session' });
});

afterEach(async () => {
  if (watch) await db.delete(cloud_agent_pr_watches).where(eq(cloud_agent_pr_watches.id, watch.id));
});

it.each(['busy', 'retry', 'question', 'permission'])(
  'delays %s user work without creating an empty maintenance chat',
  async userStatus => {
    await db
      .update(cli_sessions_v2)
      .set({ status: userStatus })
      .where(eq(cli_sessions_v2.session_id, sourceSessionId));
    const response = await dispatchDue();
    expect(
      await db.query.cloud_agent_pr_maintenance_attempts.findMany({
        where: eq(cloud_agent_pr_maintenance_attempts.watch_id, watch.id),
      })
    ).toEqual([]);
    expect(startMaintenanceChat).not.toHaveBeenCalled();
    const current = await db.query.cloud_agent_pr_watches.findFirst({
      where: eq(cloud_agent_pr_watches.id, watch.id),
    });
    expect(current).toMatchObject({ status: 'watching', execution_status: 'waiting_for_session' });
    expect(response.scheduled).toEqual([]);
  }
);

it('enforces the quiet period even when the user chat is idle', async () => {
  await db
    .update(cli_sessions_v2)
    .set({ status_updated_at: new Date().toISOString() })
    .where(eq(cli_sessions_v2.session_id, sourceSessionId));
  await dispatchDue();
  expect(startMaintenanceChat).not.toHaveBeenCalled();
});

it('reconciles an ambiguous create with stable IDs and keeps new events outside the immutable attempt', async () => {
  const create = jest.mocked(startMaintenanceChat).getMockImplementation();
  jest.mocked(startMaintenanceChat).mockImplementationOnce(async input => {
    if (!create) throw new Error('Missing create mock');
    await create(input);
    throw new Error('Synthetic connection loss after acceptance');
  });
  await dispatchDue();
  const original = await currentAttempt();
  expect(original).toMatchObject({ status: 'creating', delivery_attempts: 1, ordinal: 1 });
  await db
    .update(cloud_agent_pr_watches)
    .set({ pending_revision: 2, projection: projection('2') })
    .where(eq(cloud_agent_pr_watches.id, watch.id));
  jest
    .mocked(maintenanceChatStatus)
    .mockResolvedValue(status({ message: { messageId: original.message_id, status: 'running' } }));
  await dispatchDue();
  expect(startMaintenanceChat).toHaveBeenCalledTimes(1);
  const reconciled = await currentAttempt();
  expect(reconciled).toMatchObject({
    id: original.id,
    status: 'running',
    message_id: original.message_id,
    creation_operation_key: original.creation_operation_key,
  });
  expect(reconciled.input.problems.map(problem => problem.problemKey)).toEqual(['comment:1']);
  const session = await db.query.cli_sessions_v2.findFirst({
    where: eq(cli_sessions_v2.session_id, original.session_id ?? ''),
  });
  expect(session).toMatchObject({ chat_kind: 'maintenance', maintenance_attempt_id: original.id });
});

it('does not rewrite an already tagged maintenance chat on each running poll', async () => {
  await dispatchDue();
  const attempt = await currentAttempt();
  const sessionId = attempt.session_id ?? '';
  await db
    .update(cli_sessions_v2)
    .set({ updated_at: past })
    .where(eq(cli_sessions_v2.session_id, sessionId));
  jest
    .mocked(maintenanceChatStatus)
    .mockResolvedValue(status({ message: { messageId: attempt.message_id, status: 'running' } }));
  await dispatchDue();
  expect((await currentAttempt()).status).toBe('running');
  const session = await db.query.cli_sessions_v2.findFirst({
    where: eq(cli_sessions_v2.session_id, sessionId),
  });
  expect(session).toMatchObject({ chat_kind: 'maintenance', maintenance_attempt_id: attempt.id });
  expect(Date.parse(session?.updated_at ?? '')).toBe(Date.parse(past));
});

it('retains questions after sandbox stop and follows the latest continuation without another quiet wait', async () => {
  await dispatchDue();
  const attempt = await currentAttempt();
  jest.mocked(maintenanceChatStatus).mockResolvedValue(
    status({
      message: {
        messageId: attempt.message_id,
        status: 'failed',
        failureCode: 'sandbox_stopped',
      },
      waitingForInput: true,
    })
  );
  await dispatchDue();
  expect((await currentAttempt()).status).toBe('needs_input');
  await db
    .update(cli_sessions_v2)
    .set({ status: 'busy', status_updated_at: new Date().toISOString() })
    .where(eq(cli_sessions_v2.session_id, sourceSessionId));
  jest.mocked(maintenanceChatStatus).mockResolvedValue(
    status({
      message: {
        messageId: attempt.message_id,
        status: 'failed',
        failureCode: 'sandbox_stopped',
      },
      latestMessage: { messageId: 'msg_continuation', status: 'running' },
    })
  );
  await dispatchDue();
  expect((await currentAttempt()).status).toBe('running');
  expect(startMaintenanceChat).toHaveBeenCalledTimes(1);
});

it('pauses on Stop even when the maintenance chat waits for an answer', async () => {
  await dispatchDue();
  const attempt = await currentAttempt();
  await db
    .update(cloud_agent_pr_maintenance_attempts)
    .set({ status: 'needs_input' })
    .where(eq(cloud_agent_pr_maintenance_attempts.id, attempt.id));
  jest
    .mocked(maintenanceChatStatus)
    .mockResolvedValue(status({ waitingForInput: true, stoppedAt: Date.now() }));
  jest.mocked(authorizeMaintenanceWatch).mockClear();
  await dispatchDue();
  expect((await currentAttempt()).status).toBe('stopped');
  const current = await db.query.cloud_agent_pr_watches.findFirst({
    where: eq(cloud_agent_pr_watches.id, watch.id),
  });
  expect(current).toMatchObject({
    status: 'paused',
    lifecycle_reason: 'maintenance_chat_stopped',
    generation: 2,
  });
  expect(stopMaintenanceChat).toHaveBeenCalledTimes(1);
  expect(authorizeMaintenanceWatch).not.toHaveBeenCalled();
  await dispatchDue();
  expect(startMaintenanceChat).toHaveBeenCalledTimes(1);
});

it('records verified completion separately from checks, without trusting agent publication claims', async () => {
  const oldParent = 'd'.repeat(40);
  await db
    .update(cloud_agent_worktrees)
    .set({ base_sha: oldParent })
    .where(eq(cloud_agent_worktrees.worktree_id, watch.worktree_id));
  jest.mocked(authorizeMaintenanceExecution).mockResolvedValueOnce({
    worktree: { parent_worktree_id: 'worktree_parent', base_sha: oldParent },
  } as Awaited<ReturnType<typeof authorizeMaintenanceExecution>>);
  await dispatchDue();
  const attempt = await currentAttempt();
  const publication = {
    status: 'published' as const,
    source: 'git' as const,
    repoUrl,
    headRef: 'feature',
    observedHeadSha: 'a'.repeat(40),
    pushedHeadSha: 'c'.repeat(40),
    remoteHeadSha: 'c'.repeat(40),
    baseSha: 'b'.repeat(40),
    exactLease: `refs/heads/feature:${'a'.repeat(40)}`,
    pushExitCode: 0 as const,
    verifiedAt: new Date(Date.now() + 1000).toISOString(),
  };
  const result = {
    version: 1 as const,
    summary: 'Fixed input validation',
    changedFiles: ['widget.ts'],
    verification: [
      { command: 'pnpm test', outcome: 'passed' as const, summary: 'Passed', evidenceUrls: [] },
    ],
    publication,
    problems: [
      {
        problemKey: 'comment:1',
        contentFingerprint: 'feedback-1',
        disposition: 'addressed' as const,
        reason: 'Fixed validation',
        evidence: [],
        threadId: null,
        reply: 'Fixed and tested',
        resolve: false,
      },
    ],
    needsInput: null,
  };
  jest.mocked(maintenanceChatStatus).mockResolvedValue(
    status({
      message: { messageId: attempt.message_id, status: 'completed' },
      result,
      publication,
    })
  );
  await dispatchDue();
  expect((await currentAttempt()).status).toBe('completed');
  const current = await db.query.cloud_agent_pr_watches.findFirst({
    where: eq(cloud_agent_pr_watches.id, watch.id),
  });
  expect(current).toMatchObject({
    status: 'watching',
    execution_status: 'waiting_for_checks',
    total_attempts: 1,
  });
  const dispositions = await db.query.cloud_agent_pr_feedback_dispositions.findMany({
    where: and(
      eq(cloud_agent_pr_feedback_dispositions.watch_id, watch.id),
      eq(cloud_agent_pr_feedback_dispositions.problem_key, 'comment:1')
    ),
  });
  expect(dispositions).toHaveLength(1);
  expect(dispositions[0].disposition).toBe('addressed');
  expect(
    await db.query.cloud_agent_worktrees.findFirst({
      where: eq(cloud_agent_worktrees.worktree_id, watch.worktree_id),
    })
  ).toMatchObject({ base_sha: oldParent });
});

it.each(['published', 'unknown'] as const)(
  'updates a stacked parent boundary only for a %s conflict repair',
  async publicationStatus => {
    const oldParent = 'd'.repeat(40);
    await db
      .update(cloud_agent_worktrees)
      .set({ base_sha: oldParent })
      .where(eq(cloud_agent_worktrees.worktree_id, watch.worktree_id));
    await db
      .update(cloud_agent_pr_watches)
      .set({
        projection: {
          ...emptyWatchPrProjection(),
          pending: [{ key: 'conflict', reason: 'conflict' }],
          conflict: {
            headSha: watch.head_sha,
            baseSha: watch.base_sha,
            state: 'CONFLICTING',
            checkedAt: null,
            dueAt: null,
            retries: 0,
          },
        },
      })
      .where(eq(cloud_agent_pr_watches.id, watch.id));
    jest.mocked(authorizeMaintenanceExecution).mockResolvedValueOnce({
      worktree: { parent_worktree_id: 'worktree_parent', base_sha: oldParent },
    } as Awaited<ReturnType<typeof authorizeMaintenanceExecution>>);
    await dispatchDue();
    const attempt = await currentAttempt();
    expect(attempt.input.repository.parentCommitSha).toBe(oldParent);
    const publication = {
      status: 'published' as const,
      source: 'git' as const,
      repoUrl,
      headRef: 'feature',
      observedHeadSha: watch.head_sha,
      pushedHeadSha: 'c'.repeat(40),
      remoteHeadSha: 'c'.repeat(40),
      baseSha: watch.base_sha,
      exactLease: `refs/heads/feature:${watch.head_sha}`,
      pushExitCode: 0 as const,
      verifiedAt: new Date(Date.now() + 1000).toISOString(),
      ownedRebase: {
        source: 'git' as const,
        attemptId: attempt.id,
        baseSha: watch.base_sha,
        previousHeadSha: watch.head_sha,
        rebasedHeadSha: 'c'.repeat(40),
        completedAt: new Date().toISOString(),
      },
    };
    const result = {
      version: 1 as const,
      summary: 'Resolved conflict',
      changedFiles: ['widget.ts'],
      verification: [
        { command: 'pnpm test', outcome: 'passed' as const, summary: 'Passed', evidenceUrls: [] },
      ],
      publication,
      problems: attempt.input.problems.map(problem => ({
        problemKey: problem.problemKey,
        contentFingerprint: problem.contentFingerprint,
        disposition: 'addressed' as const,
        reason: 'Rebased child commits',
        evidence: [],
        threadId: null,
        reply: null,
        resolve: false,
      })),
      needsInput: null,
    };
    jest.mocked(maintenanceChatStatus).mockResolvedValue(
      status({
        message: { messageId: attempt.message_id, status: 'completed' },
        result,
        publication: publicationStatus === 'published' ? publication : null,
      })
    );
    await dispatchDue();
    expect(
      await db.query.cloud_agent_worktrees.findFirst({
        where: eq(cloud_agent_worktrees.worktree_id, watch.worktree_id),
      })
    ).toMatchObject({ base_sha: publicationStatus === 'published' ? watch.base_sha : oldParent });
    if (publicationStatus === 'unknown')
      expect(
        await db.query.cloud_agent_pr_watches.findFirst({
          where: eq(cloud_agent_pr_watches.id, watch.id),
        })
      ).toMatchObject({ status: 'paused', lifecycle_reason: 'publication_unverified' });
  }
);

it('records an observed rebase from a review attempt even when its structured result is missing', async () => {
  const oldParent = 'd'.repeat(40);
  await db
    .update(cloud_agent_worktrees)
    .set({ base_sha: oldParent })
    .where(eq(cloud_agent_worktrees.worktree_id, watch.worktree_id));
  jest.mocked(authorizeMaintenanceExecution).mockResolvedValueOnce({
    worktree: { parent_worktree_id: 'worktree_parent', base_sha: oldParent },
  } as Awaited<ReturnType<typeof authorizeMaintenanceExecution>>);
  await dispatchDue();
  const attempt = await currentAttempt();
  const publication = completedResult(attempt).publication;
  if (publication.status !== 'published') throw new Error('Missing publication fixture');
  jest.mocked(maintenanceChatStatus).mockResolvedValue(
    status({
      message: { messageId: attempt.message_id, status: 'completed' },
      result: null,
      publication: {
        ...publication,
        ownedRebase: {
          source: 'git',
          attemptId: attempt.id,
          baseSha: watch.base_sha,
          previousHeadSha: watch.head_sha,
          rebasedHeadSha: publication.pushedHeadSha,
          completedAt: new Date().toISOString(),
        },
      },
    })
  );
  await dispatchDue();
  expect(attempt.input.problems[0].kind).toBe('review');
  expect(
    await db.query.cloud_agent_worktrees.findFirst({
      where: eq(cloud_agent_worktrees.worktree_id, watch.worktree_id),
    })
  ).toMatchObject({ base_sha: watch.base_sha });
  expect((await currentAttempt()).result?.publication.status).toBe('published');
  expect(
    await db.query.cloud_agent_pr_watches.findFirst({
      where: eq(cloud_agent_pr_watches.id, watch.id),
    })
  ).toMatchObject({
    status: 'paused',
    lifecycle_reason: 'maintenance_result_unavailable_after_publication',
  });
});

it('refreshes all disposition reply and thread fields when needs_input becomes addressed', async () => {
  await dispatchDue();
  const attempt = await currentAttempt();
  await db.insert(cloud_agent_pr_feedback_dispositions).values({
    watch_id: watch.id,
    problem_key: 'comment:1',
    content_fingerprint: 'feedback-1',
    disposition: 'needs_input',
    reason: 'Original question',
    thread_id: 'old-thread',
    resolution_status: 'open',
    reply_comment_id: 'old-comment',
    replied_at: new Date().toISOString(),
  });
  await finishWithResult(attempt, completedResult(attempt));
  expect(
    await db.query.cloud_agent_pr_feedback_dispositions.findFirst({
      where: eq(cloud_agent_pr_feedback_dispositions.watch_id, watch.id),
    })
  ).toMatchObject({
    attempt_id: attempt.id,
    disposition: 'addressed',
    thread_id: null,
    resolution_status: 'not_applicable',
    reply_body: 'Fixed and checked',
    reply_comment_id: null,
    replied_at: null,
    resolved_at: null,
  });
});

it('retains actual prior passing verification commands in a fresh brief', async () => {
  await dispatchDue();
  const attempt = await currentAttempt();
  await finishWithResult(attempt, completedResult(attempt));
  await db
    .update(cloud_agent_pr_watches)
    .set({ projection: projection('2'), pending_revision: 2 })
    .where(eq(cloud_agent_pr_watches.id, watch.id));
  await dispatchDue();
  const attempts = await db.query.cloud_agent_pr_maintenance_attempts.findMany({
    where: eq(cloud_agent_pr_maintenance_attempts.watch_id, watch.id),
  });
  expect(attempts.find(item => item.ordinal === 2)?.input.verificationCommands).toEqual([
    'pnpm test:widgets',
  ]);
});

it('keeps the runtime-vetted prior result across a plain continuation but rejects stale publication', async () => {
  const oldParent = 'd'.repeat(40);
  await db
    .update(cloud_agent_worktrees)
    .set({ base_sha: oldParent })
    .where(eq(cloud_agent_worktrees.worktree_id, watch.worktree_id));
  jest.mocked(authorizeMaintenanceExecution).mockResolvedValueOnce({
    worktree: { parent_worktree_id: 'worktree_parent', base_sha: oldParent },
  } as Awaited<ReturnType<typeof authorizeMaintenanceExecution>>);
  await dispatchDue();
  const attempt = await currentAttempt();
  const result = completedResult(attempt);
  jest.mocked(maintenanceChatStatus).mockResolvedValue(
    status({
      message: { messageId: attempt.message_id, status: 'completed' },
      latestMessage: { messageId: 'msg_plain_followup', status: 'completed' },
      result,
      resultMessageId: attempt.message_id,
      publicationMessageId: attempt.message_id,
      publication: { status: 'unknown', reason: 'The new continuation left unpublished edits' },
      lastPublished: {
        messageId: attempt.message_id,
        publication: {
          ...result.publication,
          ownedRebase: {
            source: 'git',
            attemptId: attempt.id,
            baseSha: watch.base_sha,
            previousHeadSha: watch.head_sha,
            rebasedHeadSha: 'c'.repeat(40),
            completedAt: new Date().toISOString(),
          },
        },
      },
    })
  );
  await dispatchDue();
  expect((await currentAttempt()).result?.publication.status).toBe('unknown');
  expect(
    await db.query.cloud_agent_worktrees.findFirst({
      where: eq(cloud_agent_worktrees.worktree_id, watch.worktree_id),
    })
  ).toMatchObject({ base_sha: watch.base_sha });
  expect(
    await db.query.cloud_agent_pr_watches.findFirst({
      where: eq(cloud_agent_pr_watches.id, watch.id),
    })
  ).toMatchObject({ status: 'paused', lifecycle_reason: 'publication_unverified' });
});

it.each(['fixed', 'still_blocked'] as const)(
  'offers Resume after Recheck only when readiness is %s',
  async readiness => {
    const [paused] = await db
      .update(cloud_agent_pr_watches)
      .set({
        status: 'paused',
        lifecycle_reason: 'maintenance_parent_commit_unavailable',
        execution_status: 'fixing',
      })
      .where(eq(cloud_agent_pr_watches.id, watch.id))
      .returning();
    if (!paused) throw new Error('Missing paused watch');
    jest.mocked(assessWatchPr).mockResolvedValueOnce({
      status: 'assessed',
      state: paused,
      observations: createEmptyPrObservations(),
      problems: [],
      pullRequest: {
        number: 1,
        htmlUrl: `${repoUrl}/pull/1`,
        state: 'open',
        title: 'Validate widgets',
        headSha: watch.head_sha,
        headRef: watch.head_ref,
        baseRef: watch.base_ref,
        baseSha: watch.base_sha,
        updatedAt: new Date().toISOString(),
        mergeable: true,
        mergeableState: 'clean',
      },
    });
    if (readiness === 'still_blocked')
      jest.mocked(authorizeMaintenanceExecution).mockResolvedValueOnce({
        worktree: { parent_worktree_id: 'worktree_parent', base_sha: null },
      } as Awaited<ReturnType<typeof authorizeMaintenanceExecution>>);
    const checked = await assessAndScheduleWatchPr(paused, 'recheck');
    expect(checked).toMatchObject({
      status: 'paused',
      execution_status: 'watching',
      lifecycle_reason:
        readiness === 'fixed' ? 'ready_to_resume' : 'maintenance_parent_commit_unavailable',
    });
    expect(startMaintenanceChat).not.toHaveBeenCalled();
  }
);
