import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { cli_sessions_v2, cloud_agent_pr_maintenance_attempts } from '@kilocode/db/schema';
import { createMessageId } from '../../../src/shared/message-id.js';
import { executeDockerCommand, findControlPlaneKiloRuntime } from '../sandbox-control.js';
import {
  identitySchema,
  maintenanceStatusSchema,
  LocalApiError,
  describeMessageFailure,
  type Attempt,
  type State,
} from './contracts.js';
import type { Context } from './context.js';
import { MODEL } from './context.js';
import { maintenanceChats, seedAttempt, startPayload, watch } from './fixtures.js';
import { continuationText, noPublicationResult } from './review-fixtures.js';

async function fakeCounts(context: Context, attempt: Attempt) {
  const scenario = z
    .object({ tag: z.string(), requests: z.number().int().nonnegative() })
    .parse(
      await context.request('fake', `/test/scenario-status?tag=${encodeURIComponent(attempt.gate)}`)
    );
  const scope = z
    .object({ scope: z.string(), chatCompletions: z.number().int().nonnegative() })
    .parse(
      await context.request('fake', `/test/requests?scope=${encodeURIComponent(attempt.gate)}`)
    );
  assert.equal(scenario.tag, attempt.gate);
  assert.equal(scope.scope, attempt.gate);
  return { scenario: scenario.requests, scope: scope.chatCompletions };
}

export function assertNoInitialAdmission(status: z.infer<typeof maintenanceStatusSchema>) {
  assert(status.stoppedAt !== null, 'Stop must have a durable timestamp before registration');
  for (const message of [status.message, status.latestMessage]) {
    if (message === null) continue;
    assert.equal(message.status, 'interrupted', 'A stopped initial message cannot run or complete');
    assert.equal(
      message.acceptedAt,
      undefined,
      'The stopped initial message must never be accepted'
    );
  }
  assert.equal(status.waitingForInput, false);
}

export function isPreRegistrationStopConflict(error: unknown): error is LocalApiError {
  return (
    error instanceof LocalApiError &&
    error.endpoint === '/internal/pr-maintenance/start' &&
    error.status === 409 &&
    error.responseError === 'maintenance_attempt_stopped'
  );
}

export async function stopBeforeStart(context: Context, state: State) {
  assert.equal(state.attempts.length, 0, 'Use a fresh prepared fixture for pre-registration Stop');
  const attempt = await seedAttempt(context, state, 'stop-before-start');
  const payload = await startPayload(context, state, attempt);
  const binding = {
    userId: state.userId,
    cloudAgentSessionId: attempt.cloudAgentSessionId,
    messageId: attempt.messageId,
    watchId: state.watchId,
    attemptId: attempt.id,
  };
  const [registered] = await context.db
    .select()
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, state.userId),
        eq(cli_sessions_v2.cloud_agent_session_id, attempt.cloudAgentSessionId)
      )
    );
  assert.equal(registered, undefined, 'The target must not be registered before Stop');
  assert.deepEqual(await fakeCounts(context, attempt), { scenario: 0, scope: 0 });
  const stopped = maintenanceStatusSchema.parse(
    await context.request('worker', '/internal/pr-maintenance/stop', binding, 'internal')
  );
  assertNoInitialAdmission(stopped);
  context.pass('bound Stop persists before the maintenance chat is registered');
  for (let replay = 0; replay < 2; replay++) {
    await assert.rejects(
      context.request('worker', '/internal/pr-maintenance/start', payload, 'internal'),
      isPreRegistrationStopConflict,
      'Initial start and replay must reject the original stopped attempt, not an unrelated failure'
    );
    const status = await context.status(attempt);
    assertNoInitialAdmission(status);
    assert.equal(
      status.stoppedAt,
      stopped.stoppedAt,
      'Start replay cannot clear or replace the Stop fence'
    );
  }
  assert.deepEqual(await fakeCounts(context, attempt), { scenario: 0, scope: 0 });
  context.pass(
    'start and replay use the same IDs and produce no inference or accepted initial message'
  );
  await context.db
    .update(cloud_agent_pr_maintenance_attempts)
    .set({ next_run_at: new Date(Date.now() - 1_000).toISOString() })
    .where(
      and(
        eq(cloud_agent_pr_maintenance_attempts.id, attempt.id),
        eq(cloud_agent_pr_maintenance_attempts.watch_id, state.watchId)
      )
    );
  await context.dispatch(state.watchId);
  const current = await watch(context, state);
  assert.equal(current.status, 'paused');
  assert.equal(current.lifecycle_reason, 'maintenance_chat_stopped');
  const [settled] = await context.db
    .select()
    .from(cloud_agent_pr_maintenance_attempts)
    .where(
      and(
        eq(cloud_agent_pr_maintenance_attempts.id, attempt.id),
        eq(cloud_agent_pr_maintenance_attempts.watch_id, state.watchId)
      )
    );
  assert.equal(settled?.status, 'stopped');
  assert(settled.finished_at, 'Backend must terminalize the stopped fixture attempt');
  assertNoInitialAdmission(await context.status(attempt));
  assert.deepEqual(await fakeCounts(context, attempt), { scenario: 0, scope: 0 });
  context.pass(
    'backend reconciles the pre-registration tombstone to paused watch and stopped attempt'
  );
}

async function ownedGitSnapshot(context: Context, state: State, attempt: Attempt) {
  const runtime = await findControlPlaneKiloRuntime(attempt.kiloSessionId);
  assert(runtime, 'Cannot identify the owned maintenance checkout');
  const { container, directory } = runtime;
  async function git(...args: string[]) {
    return (
      await executeDockerCommand(['exec', container.id, 'git', '-C', directory, ...args])
    ).stdout.trim();
  }
  const headSha = z
    .string()
    .regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
    .parse(await git('rev-parse', '--verify', 'HEAD'));
  const dirty = (await git('status', '--porcelain')).length !== 0;
  const current = await watch(context, state);
  const remote = await git('ls-remote', '--exit-code', 'origin', `refs/heads/${current.head_ref}`);
  const remoteHeadSha = z
    .string()
    .regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
    .parse(remote.split(/\s+/)[0]);
  const snapshot = { headSha, dirty, remoteHeadSha };
  await context.observe('owned read-only Git snapshot', snapshot);
  return snapshot;
}

async function completed(context: Context, attempt: Attempt, messageId = attempt.messageId) {
  return context.until(
    'exact maintenance message completion',
    async () => {
      const message = await context.result({ ...attempt, messageId });
      if (message.status === 'failed' || message.status === 'interrupted')
        throw new Error(describeMessageFailure(message));
      return message.status === 'completed' && message.maintenance ? message : undefined;
    },
    65_000
  );
}

async function noAutoCommit(context: Context, state: State, attempt: Attempt) {
  const metadata = await context.trpc(
    'getSession',
    { cloudAgentSessionId: attempt.cloudAgentSessionId },
    z.object({ autoCommit: z.boolean().optional(), worktreeId: z.string() }),
    'GET'
  );
  assert.equal(metadata.autoCommit, false);
  assert.equal(metadata.worktreeId, state.workspaceId);
}

async function plainAssistantReply(
  context: Context,
  attempt: Attempt,
  messageId: string,
  text: string
) {
  await context.until(
    'persisted plain assistant continuation',
    async () => {
      const transcript = z
        .array(
          z.object({
            info: z.object({ role: z.string(), parentID: z.string().optional() }),
            parts: z.array(z.object({ type: z.string(), text: z.string().optional() })),
          })
        )
        .parse(
          await context.request(
            'worker',
            `/kilo/session/${attempt.kiloSessionId}/message?limit=100`
          )
        );
      const reply = transcript.find(
        message => message.info.role === 'assistant' && message.info.parentID === messageId
      );
      const actual = reply?.parts
        .filter(part => part.type === 'text')
        .map(part => part.text ?? '')
        .join('');
      return actual === text ? true : undefined;
    },
    20_000
  );
}

export async function resultContinuation(context: Context, state: State) {
  assert.equal(state.attempts.length, 0, 'Use a fresh prepared fixture for result continuation');
  const attempt = await seedAttempt(context, state, 'result-continuation');
  const payload = await startPayload(context, state, attempt);
  const started = identitySchema
    .extend({ worktreeId: z.string() })
    .parse(await context.request('worker', '/internal/pr-maintenance/start', payload, 'internal'));
  assert.equal(started.cloudAgentSessionId, attempt.cloudAgentSessionId);
  assert.equal(started.kiloSessionId, attempt.kiloSessionId);
  assert.equal(started.messageId, attempt.messageId);
  const initial = await completed(context, attempt);
  assert(
    initial.maintenance?.result,
    'Initial response must contain a validated structured result'
  );
  assert.equal(initial.maintenance.attemptId, attempt.id);
  assert.equal(initial.maintenance.messageId, attempt.messageId);
  const expected = noPublicationResult(state.tag);
  assert.equal(initial.maintenance.result.summary, expected.summary);
  assert.deepEqual(initial.maintenance.result.problems, expected.problems);
  assert.equal(initial.maintenance.publication.status, 'not_attempted');
  const original = await context.status(attempt);
  assert.equal(original.resultMessageId, attempt.messageId);
  assert.deepEqual(original.result, initial.maintenance.result);
  const before = await ownedGitSnapshot(context, state, attempt);
  assert.equal(before.dirty, false, 'The no-write fixture must start with a clean checkout');
  const originalWorkspace = initial.maintenance.workspace;
  assert(
    originalWorkspace?.status === 'observed' && originalWorkspace.source === 'git',
    'Initial outcome needs actual Git snapshot provenance'
  );
  assert.equal(originalWorkspace.headSha, before.headSha);
  assert.equal(originalWorkspace.remoteHeadSha, before.remoteHeadSha);
  assert.equal(originalWorkspace.dirty, false);
  await noAutoCommit(context, state, attempt);
  context.pass(
    'real deterministic inference produces a validated no-publication result with Git snapshot provenance'
  );
  const count = (await maintenanceChats(context, state)).length;
  assert.equal(count, 1, 'The fresh fixture must contain exactly one maintenance chat');
  attempt.continuationMessageId = createMessageId();
  await context.save(state);
  const text = continuationText(state.tag);
  const sent = await context.trpc(
    'send',
    {
      cloudAgentSessionId: attempt.cloudAgentSessionId,
      message: {
        id: attempt.continuationMessageId,
        prompt: `__e2e_scope__:${attempt.gate}\n__fake__:echo:${text}`,
      },
      agent: { mode: 'code', model: MODEL },
      finalization: { autoCommit: false },
    },
    z.object({ messageId: z.string() })
  );
  assert.equal(sent.messageId, attempt.continuationMessageId);
  const latest = await completed(context, attempt, sent.messageId);
  assert.equal(latest.maintenance?.attemptId, attempt.id);
  assert.equal(latest.maintenance?.messageId, sent.messageId);
  assert.equal(
    latest.maintenance?.result,
    null,
    'The plain continuation must not manufacture another structured result'
  );
  await plainAssistantReply(context, attempt, sent.messageId, text);
  const status = await context.status(attempt);
  assert.equal(status.latestMessage?.messageId, sent.messageId);
  assert.equal(status.latestMessage.status, 'completed');
  assert.equal(status.latestMessage.cloudAgentSessionId, attempt.cloudAgentSessionId);
  assert.equal(
    status.resultMessageId,
    attempt.messageId,
    'Fallback result must retain its original exact-message provenance'
  );
  assert.deepEqual(
    status.result,
    original.result,
    'A plain continuation cannot erase the prior validated result'
  );
  assert.equal(
    status.publication?.status,
    'not_attempted',
    'This fixture must never claim a GitHub push'
  );
  assert.equal(status.lastPublished, null);
  const latestWorkspace = latest.maintenance?.workspace;
  assert(
    latestWorkspace?.status === 'observed' && latestWorkspace.source === 'git',
    'Continuation needs a fresh actual Git snapshot'
  );
  assert.deepEqual(
    status.workspace,
    latestWorkspace,
    'Result carryover must use the latest observed workspace snapshot'
  );
  const after = await ownedGitSnapshot(context, state, attempt);
  assert.deepEqual(after, before);
  assert.equal(latestWorkspace.dirty, false);
  assert.equal(latestWorkspace.headSha, after.headSha);
  assert.equal(latestWorkspace.remoteHeadSha, after.remoteHeadSha);
  assert(Date.parse(latestWorkspace.verifiedAt) >= Date.parse(originalWorkspace.verifiedAt));
  await noAutoCommit(context, state, attempt);
  assert.equal((await maintenanceChats(context, state)).length, count);
  context.pass('normal plain-text followup completes in the same chat with autoCommit=false');
  context.pass(
    'latest exact-message completion preserves the earlier validated result and resultMessageId'
  );
  context.pass(
    'fresh real Git snapshots confirm unchanged clean local/remote state without publication'
  );
}
