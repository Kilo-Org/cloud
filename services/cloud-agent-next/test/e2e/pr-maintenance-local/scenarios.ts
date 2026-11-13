import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { deleteProfile } from '@kilocode/cloud-agent-profile';
import {
  agent_environment_profiles,
  cli_sessions_v2,
  cloud_agent_pr_watches,
  cloud_agent_pr_maintenance_attempts,
  platform_integrations,
} from '@kilocode/db/schema';
import { watchPrProjectionSchema } from '../../../../../apps/web/src/lib/cloud-agent/watch-pr-events.js';
import { createMessageId } from '../../../src/shared/message-id.js';
import { releaseCleanupGate } from './cleanup.js';
import {
  createdSchema,
  directive,
  due,
  feedback,
  maintenanceChats,
  policy,
  seedAttempt,
  startPayload,
  watch,
} from './fixtures.js';
import {
  identitySchema,
  describeMessageFailure,
  LocalApiError,
  MODEL,
  type Context,
  type State,
  type Attempt,
} from './context.js';

async function gate(context: Context, tag: string) {
  await context.until('owned fake inference gate', async () => {
    const result = z
      .object({ engaged: z.boolean() })
      .parse(await context.request('fake', `/test/gate-status?tag=${encodeURIComponent(tag)}`));
    return result.engaged ? true : undefined;
  });
}

async function release(context: Context, tag: string) {
  await context.request('fake', `/test/release?tag=${encodeURIComponent(tag)}`, {});
}

async function attempts(context: Context, state: State) {
  return context.db
    .select()
    .from(cloud_agent_pr_maintenance_attempts)
    .where(eq(cloud_agent_pr_maintenance_attempts.watch_id, state.watchId));
}

async function complete(context: Context, identity: z.infer<typeof identitySchema>) {
  const result = await context.until('exact message terminal outcome', async () => {
    const current = await context.result(identity);
    return ['completed', 'failed', 'interrupted'].includes(current.status) ? current : undefined;
  });
  assert.equal(
    result.status,
    'completed',
    `The owned exact message did not complete: ${describeMessageFailure(result)}`
  );
}

export async function coordination(context: Context, state: State) {
  assert.equal(state.attempts.length, 0, 'Use a fresh prepared fixture for start coordination');
  assert.equal((await maintenanceChats(context, state)).length, 0);
  const tag = `${state.tag}-busy`;
  const sent = await context.trpc(
    'send',
    {
      cloudAgentSessionId: state.root.cloudAgentSessionId,
      message: { id: createMessageId(), prompt: directive(state, `gate:${tag}`) },
      agent: { mode: 'code', model: MODEL },
      finalization: { autoCommit: false },
    },
    z.object({ messageId: z.string() })
  );
  const turn = { ...state.root, messageId: sent.messageId };
  try {
    await gate(context, tag);
    assert.equal((await context.result(turn)).status, 'running');
    await context.until('published user busy status', async () => {
      const [row] = await context.db
        .select()
        .from(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.session_id, state.root.kiloSessionId),
            eq(cli_sessions_v2.kilo_user_id, state.userId)
          )
        );
      return row?.status === 'busy' ? row : undefined;
    });
    await due(context, state);
    await context.dispatch(state.watchId);
    const busy = await watch(context, state);
    if (busy.status === 'paused' && busy.execution_status !== 'waiting_for_session') {
      assert(busy.lifecycle_reason, 'Access rejection must expose a reason');
      context.blocked(
        'backend busy/quiet start coordination',
        `Synthetic installation is not GitHub-authorized: ${busy.lifecycle_reason}`
      );
      return;
    }
    assert.equal(busy.status, 'watching');
    assert.equal(busy.execution_status, 'waiting_for_session');
    assert.equal((await attempts(context, state)).length, 0);
    assert.equal((await maintenanceChats(context, state)).length, 0);
    context.pass(
      'due enabled watch waits for a real running user chat without creating an empty chat'
    );
  } finally {
    await release(context, tag);
  }
  await complete(context, turn);
  const idle = await context.until('published user idle status', async () => {
    const [row] = await context.db
      .select()
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.session_id, state.root.kiloSessionId),
          eq(cli_sessions_v2.kilo_user_id, state.userId)
        )
      );
    return row?.status === 'idle' && row.status_updated_at ? row : undefined;
  });
  await due(context, state);
  await context.dispatch(state.watchId);
  assert.equal((await watch(context, state)).execution_status, 'waiting_for_session');
  assert.equal((await maintenanceChats(context, state)).length, 0);
  context.pass('recent completed user work preserves the quiet period without an empty chat');
  await context.until(
    'configured quiet period elapsed',
    async () =>
      Date.now() >=
      Date.parse(idle.status_updated_at ?? '') + policy.quietPeriodSeconds * 1_000 + 100
        ? true
        : undefined,
    40_000
  );
  await due(context, state);
  await context.dispatch(state.watchId);
  const after = await watch(context, state);
  if (after.status === 'paused' || after.execution_status === 'needs_input') {
    context.blocked(
      'backend GitHub-authorized repair dispatch',
      after.lifecycle_reason ?? 'Synthetic installation has no GitHub App credentials'
    );
  } else {
    const chats = await maintenanceChats(context, state);
    assert.equal(chats.length, 1, 'Eligible work must create exactly one maintenance chat');
    context.pass('after quiet period backend creates one maintenance chat');
  }
}

async function start(context: Context, state: State, kind: Attempt['kind']) {
  const attempt = await seedAttempt(context, state, kind);
  const payload = await startPayload(context, state, attempt);
  const response = identitySchema.extend({
    worktreeId: z.string(),
    replayed: z.boolean().optional(),
  });
  const first = response.parse(
    await context.request('worker', '/internal/pr-maintenance/start', payload, 'internal')
  );
  assert.equal(first.worktreeId, state.workspaceId);
  assert.equal(first.cloudAgentSessionId, attempt.cloudAgentSessionId);
  assert.equal(first.kiloSessionId, attempt.kiloSessionId);
  assert.equal(first.messageId, attempt.messageId);
  const replay = response.parse(
    await context.request('worker', '/internal/pr-maintenance/start', payload, 'internal')
  );
  assert.equal(replay.cloudAgentSessionId, first.cloudAgentSessionId);
  assert.equal(replay.kiloSessionId, first.kiloSessionId);
  assert.equal(replay.messageId, first.messageId);
  assert.equal(replay.replayed, true);
  const row = await context.until('explicit persisted maintenance chat', async () => {
    const rows = await maintenanceChats(context, state);
    return rows.find(item => item.session_id === attempt.kiloSessionId);
  });
  assert.equal(row.maintenance_watch_id, state.watchId);
  assert.equal(row.maintenance_attempt_id, attempt.id);
  assert.equal(row.cloud_agent_session_id, attempt.cloudAgentSessionId);
  assert.equal(
    (await maintenanceChats(context, state)).filter(
      item => item.maintenance_attempt_id === attempt.id
    ).length,
    1
  );
  const metadata = await context.trpc(
    'getSession',
    { cloudAgentSessionId: attempt.cloudAgentSessionId },
    z.object({ autoCommit: z.boolean().optional(), worktreeId: z.string() }),
    'GET'
  );
  assert.equal(
    metadata.autoCommit,
    false,
    'Persisted maintenance finalization must disable auto-commit'
  );
  assert.equal(metadata.worktreeId, state.workspaceId);
  context.pass(
    'real internal start creates a fresh chat with explicit maintenance metadata and autoCommit=false'
  );
  context.pass('duplicate start reuses the creation key, chat IDs, and exact message ID');
  return attempt;
}

export async function runtime(context: Context, state: State) {
  const attempt = await start(context, state, 'runtime');
  await gate(context, attempt.gate);
  const running = await context.status(attempt);
  assert.equal(running.message?.messageId, attempt.messageId);
  assert.equal(running.message.status, 'running');
  const [before] = await attempts(context, state);
  assert(before && before.id === attempt.id, 'Use a fresh fixture for the runtime scenario');
  const immutableInput = JSON.stringify(before.input);
  await feedback(context, state, 'during-active-attempt');
  const [after] = await attempts(context, state);
  assert.equal(JSON.stringify(after?.input), immutableInput);
  const pending = watchPrProjectionSchema.parse((await watch(context, state)).projection);
  assert(pending.pending.some(item => item.key === 'review:during-active-attempt'));
  assert.equal((await maintenanceChats(context, state)).length, 1);
  context.pass(
    'synthetic observation projected during execution remains pending outside immutable input'
  );
  const user = await context.trpc(
    'createHostedWorkspaceSession',
    {
      workspaceId: state.workspaceId,
      operationKey: randomUUID(),
      clientProvenance: 'agent-manager',
      message: { prompt: directive(state, 'echo:concurrent-user-chat') },
      agent: { mode: 'code', model: MODEL },
    },
    createdSchema
  );
  await complete(context, user);
  assert.equal((await context.status(attempt)).message?.status, 'running');
  const [ordinary] = await context.db
    .select()
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.session_id, user.kiloSessionId),
        eq(cli_sessions_v2.kilo_user_id, state.userId)
      )
    );
  assert.equal(ordinary?.chat_kind, 'user');
  assert.equal(ordinary.maintenance_attempt_id, null);
  context.pass('a new user chat completes while maintenance remains running in the same workspace');
  await context.trpc(
    'interruptSession',
    { sessionId: attempt.cloudAgentSessionId },
    z.object({ success: z.boolean() })
  );
  const stopped = await context.until('durable maintenance Stop', async () => {
    const status = await context.status(attempt);
    return status.stoppedAt !== null && status.message?.status === 'interrupted'
      ? status
      : undefined;
  });
  assert.equal((await context.status(attempt)).stoppedAt, stopped.stoppedAt);
  context.pass('ordinary Stop persists its marker and interrupts the exact maintenance message');
  await release(context, attempt.gate);
  await context.db
    .update(cloud_agent_pr_maintenance_attempts)
    .set({
      next_run_at: new Date(Date.now() - 1_000).toISOString(),
    })
    .where(
      and(
        eq(cloud_agent_pr_maintenance_attempts.id, attempt.id),
        eq(cloud_agent_pr_maintenance_attempts.watch_id, state.watchId)
      )
    );
  try {
    await context.dispatch(state.watchId);
    const paused = await watch(context, state);
    assert.equal(paused.status, 'paused', 'Stop must pause the watch');
    assert.match(
      paused.lifecycle_reason ?? '',
      /stop/i,
      'Pause must identify Stop, not an unrelated access failure'
    );
    const saved = await attempts(context, state);
    assert.equal(saved.find(item => item.id === attempt.id)?.status, 'stopped');
    await feedback(context, state, 'after-stop');
    await context.dispatch(state.watchId);
    assert.equal((await watch(context, state)).status, 'paused');
    assert.equal((await maintenanceChats(context, state)).length, 1);
    context.pass(
      'backend reconciles durable Stop to paused and later synthetic feedback cannot restart it'
    );
  } catch (error) {
    if (!(error instanceof LocalApiError)) throw error;
    context.blocked('backend Stop reconciliation', error.message);
  }
}

export async function question(context: Context, state: State) {
  const attempt = await start(context, state, 'question');
  await context.until('persisted maintenance question', async () =>
    (await context.status(attempt)).waitingForInput ? true : undefined
  );
  const questions = await context.until('native pending question', async () => {
    const value = z
      .array(z.object({ id: z.string(), sessionID: z.string() }))
      .parse(
        await context.request(
          'worker',
          `/kilo/question?directory=${encodeURIComponent(`/cloud-agent/sessions/${attempt.kiloSessionId}`)}`
        )
      );
    return value.length ? value : undefined;
  });
  const pending = questions.find(item => item.sessionID === attempt.kiloSessionId);
  assert(pending, 'Native question belongs to the exact maintenance chat');
  attempt.questionId = pending.id;
  await context.save(state);
  assert.equal(
    (await maintenanceChats(context, state)).filter(
      item => item.maintenance_attempt_id === attempt.id
    ).length,
    1
  );
  context.pass('native maintenance question persists in the real Session DO with one linked chat');
}

export async function answer(context: Context, state: State) {
  const attempt = state.attempts.find(item => item.kind === 'question');
  assert(attempt?.questionId, 'Run the question phase first');
  const before = await context.status(attempt);
  assert(before.waitingForInput, 'Question must remain pending before the answer');
  const count = (await maintenanceChats(context, state)).length;
  await context.trpc(
    'answerQuestion',
    {
      sessionId: attempt.cloudAgentSessionId,
      questionId: attempt.questionId,
      answers: [['Continue']],
    },
    z.object({ success: z.boolean() })
  );
  const completed = await context.until(
    'same-chat answer completion',
    async () => {
      const status = await context.status(attempt);
      if (
        status.latestMessage &&
        ['failed', 'interrupted'].includes(status.latestMessage.status) &&
        !(
          status.latestMessage.messageId === before.latestMessage?.messageId &&
          status.latestMessage.failureCode === 'sandbox_stopped'
        )
      ) {
        throw new Error(
          `Answer failed: ${status.latestMessage.failureCode ?? status.latestMessage.status}`
        );
      }
      return !status.waitingForInput && status.latestMessage?.status === 'completed'
        ? status
        : undefined;
    },
    100_000
  );
  assert.equal(completed.latestMessage?.cloudAgentSessionId, attempt.cloudAgentSessionId);
  assert.equal((await maintenanceChats(context, state)).length, count);
  context.pass('answer completes in the same maintenance chat');
  return completed;
}

export async function answerCold(context: Context, state: State) {
  const attempt = state.attempts.find(item => item.kind === 'question');
  assert(attempt?.questionId, 'Run the question phase first');
  const before = await context.status(attempt);
  assert(before.waitingForInput, 'Question must remain pending after sandbox stop');
  if (before.message?.failureCode !== 'sandbox_stopped') {
    context.blocked(
      'question survives idle sandbox stop',
      'Sandbox has not yet stopped normally. Run answer-cold after its normal idle deadline; this invocation does not wait or shorten production timers.'
    );
    return;
  }
  context.pass('sandbox_stopped preserves the pending maintenance question');
  const completed = await answer(context, state);
  assert.notEqual(
    completed.latestMessage?.messageId,
    attempt.messageId,
    'Cold answer must create a fresh message in the same chat'
  );
  context.pass('cold answer completes a new exact message in the same maintenance chat');
}

export async function cleanup(context: Context, state: State) {
  const [savedWatch] = await context.db
    .select()
    .from(cloud_agent_pr_watches)
    .where(eq(cloud_agent_pr_watches.id, state.watchId));
  if (savedWatch) await watch(context, state);
  const [profile] = await context.db
    .select()
    .from(agent_environment_profiles)
    .where(
      and(
        eq(agent_environment_profiles.id, state.profileId),
        eq(agent_environment_profiles.owned_by_user_id, state.userId)
      )
    );
  assert.equal(profile?.description, `Synthetic maintenance acceptance ${state.runId}`);
  const [integration] = await context.db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.id, state.integrationId),
        eq(platform_integrations.owned_by_user_id, state.userId)
      )
    );
  if (integration)
    assert.equal(
      z.object({ prMaintenanceLocalRun: z.string() }).parse(integration.metadata)
        .prMaintenanceLocalRun,
      state.runId
    );
  await releaseCleanupGate(context, `${state.tag}-busy`);
  for (const attempt of state.attempts) {
    if (
      !(await maintenanceChats(context, state)).some(
        chat => chat.session_id === attempt.kiloSessionId
      )
    )
      continue;
    const status = await context.status(attempt);
    if (
      status.message?.status === 'running' ||
      status.message?.status === 'queued' ||
      status.waitingForInput
    ) {
      await context.request(
        'worker',
        '/internal/pr-maintenance/stop',
        {
          userId: state.userId,
          cloudAgentSessionId: attempt.cloudAgentSessionId,
          messageId: attempt.messageId,
          watchId: state.watchId,
          attemptId: attempt.id,
        },
        'internal'
      );
    }
    if (attempt.kind === 'runtime' || attempt.kind === 'stop-before-start') {
      assert.equal(
        attempt.gate,
        `${state.tag}-${attempt.kind}`,
        'Cleanup gate must belong to this fixture attempt'
      );
      await releaseCleanupGate(context, attempt.gate);
    }
  }
  await context.trpc(
    'deleteWorktree',
    { worktreeId: state.workspaceId },
    z.object({ success: z.boolean() })
  );
  await context.db
    .delete(cloud_agent_pr_watches)
    .where(
      and(
        eq(cloud_agent_pr_watches.id, state.watchId),
        eq(cloud_agent_pr_watches.kilo_user_id, state.userId)
      )
    );
  await context.db
    .delete(platform_integrations)
    .where(
      and(
        eq(platform_integrations.id, state.integrationId),
        eq(platform_integrations.owned_by_user_id, state.userId)
      )
    );
  await deleteProfile(context.db, state.profileId, { type: 'user', id: state.userId });
  state.cleaned = true;
  await context.save(state);
  context.pass(
    'normal owned workspace deletion and synthetic watch/integration/profile cleanup completed'
  );
}
