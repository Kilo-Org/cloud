import { randomUUID } from 'node:crypto';
import {
  fakeDirective,
  getMessageResult,
  openConnectedStream,
  prepareBrowserSession,
  releaseGate,
  sendMessage,
  waitForGateEngaged,
  type DriverConfig,
  type StreamConnection,
  type StreamEvent,
  type WorktreeSessionResult,
} from './client.js';
import { parseFileReadEcho } from './scenario-assertions.js';
import {
  awaitCorrelatedChildText,
  collectChildMessageText,
  CONTENT_CORRELATION_BUDGET_MS,
  cleanupRemoteSession,
  echoPayloadMatches,
  type SharedScenario,
} from './scenarios-shared.js';
import {
  bootToCompletion,
  createOwnedSessionRegistry,
  createScenarioDeadline,
  readAllocation,
  requireRunning,
  sendTurn,
  sessionSandboxObservation,
  trackCreations,
  type InFlightCreations,
  type ScenarioDeadline,
} from './scenarios-shared-runtime.js';
import { captureControlPlaneFaultTarget } from './scenarios-shared-faults.js';
import { verifyWorktreeChat } from './scenarios-shared-worktrees.js';
import { assertScenarioPreconditions } from './public-surface-support.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';
import type {
  SandboxFaultObservation,
  ScenarioEnvironment,
  SessionSandboxObservation,
  WorktreeSnapshotObservation,
} from './scenario-capabilities.js';

const SNAPSHOT_SCENARIO_TIMEOUT_MS = 15 * 60_000;
const BOOT_BUDGET_MS = 240_000;
const TURN_BUDGET_MS = 120_000;
const RECOVERY_BUDGET_MS = 8 * 60_000;
/** A snapshot upload is 1s debounce + capture + 60s upload bound. */
const UPLOAD_WAIT_MS = 75_000;
const GATE_ENGAGE_BUDGET_MS = 60_000;
const CANCELLED_TURN_BUDGET_MS = 120_000;
const LATE_CREATE_SETTLE_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForStreamEvent(input: {
  stream: StreamConnection;
  predicate: (event: StreamEvent) => boolean;
  timeoutMs: number;
  label: string;
}): Promise<StreamEvent> {
  const until = Date.now() + Math.max(1, input.timeoutMs);
  while (Date.now() < until) {
    const event = input.stream.events.find(input.predicate);
    if (event !== undefined) return event;
    await sleep(100);
  }
  throw new Error(`${input.label}: event did not appear within ${input.timeoutMs}ms`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireSnapshots(env: ScenarioEnvironment): WorktreeSnapshotObservation {
  if (!env.worktreeSnapshots) throw new Error('worktreeSnapshots capability is required');
  return env.worktreeSnapshots;
}

function requireFaults(env: ScenarioEnvironment): SandboxFaultObservation {
  if (!env.sandboxFaults) throw new Error('sandboxFaults capability is required');
  return env.sandboxFaults;
}

function requireRuntime(
  env: ScenarioEnvironment
): NonNullable<ScenarioEnvironment['controlPlaneRuntime']> {
  if (!env.controlPlaneRuntime) throw new Error('controlPlaneRuntime capability is required');
  return env.controlPlaneRuntime;
}

async function prepareSnapshotSession(
  creations: InFlightCreations<WorktreeSessionResult>,
  config: DriverConfig,
  input: { prompt: string; autoCommit: boolean }
): Promise<WorktreeSessionResult> {
  return creations.run('prepare snapshot session', signal =>
    prepareBrowserSession(
      config,
      { prompt: input.prompt, operationKey: randomUUID(), autoCommit: input.autoCommit },
      signal
    )
  );
}

/**
 * Accept only a snapshot restore, never legacy recovery or ingest replay. The
 * wrapper emits "Restored N worktree changes..." only after
 * `applyWorktreeSnapshot` succeeded, so the message is the user-visible proof
 * that the snapshot path ran.
 */
export function requireSnapshotRestoreMessage(
  events: readonly StreamEvent[],
  messageId: string,
  expected: { applied: 'positive' | 'zero'; conflicts?: number }
): string {
  const messages = events
    .filter(
      event => event.streamEventType === 'preparing' && event.data.triggerMessageId === messageId
    )
    .map(event => (typeof event.data.message === 'string' ? event.data.message : ''));
  const restored = messages.find(message => /^Restored \d+ worktree changes/.test(message));
  if (restored === undefined) {
    throw new Error(
      `recovery ${messageId} did not report a snapshot restore; preparing messages=${JSON.stringify(messages)}`
    );
  }
  const applied = Number(/^Restored (\d+) worktree changes/.exec(restored)?.[1] ?? NaN);
  if (expected.applied === 'positive' && !(applied > 0)) {
    throw new Error(`recovery ${messageId} restored no files from the snapshot: ${restored}`);
  }
  if (expected.applied === 'zero' && applied !== 0) {
    throw new Error(
      `recovery ${messageId} reapplied ${applied} already-pushed changes: ${restored}`
    );
  }
  if (expected.conflicts !== undefined) {
    const conflicts = Number(/conflicts (\d+)/.exec(restored)?.[1] ?? NaN);
    if (conflicts !== expected.conflicts) {
      throw new Error(
        `recovery ${messageId} reported conflicts=${Number.isNaN(conflicts) ? 'missing' : conflicts}; expected ${expected.conflicts}: ${restored}`
      );
    }
  }
  return restored;
}

async function waitForDistinctAllocation(
  deadline: ScenarioDeadline,
  sandbox: SessionSandboxObservation,
  session: WorktreeSessionResult,
  previous: string,
  label: string,
  budgetMs: number
): Promise<string> {
  const end = Date.now() + Math.min(budgetMs, deadline.remaining(label));
  let observed: string | null = null;
  while (Date.now() < end) {
    observed = await readAllocation(deadline, sandbox, session, label);
    if (observed !== null && observed !== previous) return observed;
    await sleep(2_000);
  }
  throw new Error(
    `${label}: no allocation distinct from ${previous} appeared (last=${observed ?? 'none'})`
  );
}

function findAutoCommitCompletion(
  events: readonly StreamEvent[],
  messageId: string
): Record<string, unknown> | undefined {
  return events
    .filter(
      event =>
        event.streamEventType === 'autocommit_completed' && event.data.userMessageId === messageId
    )
    .map(event => event.data)
    .at(-1);
}

/** Require a successful auto-commit whose push command completed. */
export function requirePushCompleted(
  events: readonly StreamEvent[],
  messageId: string
): Record<string, unknown> {
  const completion = findAutoCommitCompletion(events, messageId);
  if (completion === undefined) {
    throw new Error(`turn ${messageId} emitted no autocommit_completed event`);
  }
  const failureMessage =
    typeof completion.message === 'string'
      ? completion.message
      : JSON.stringify(completion.message ?? null);
  if (completion.success !== true) {
    throw new Error(`turn ${messageId} auto-commit failed: ${failureMessage}`);
  }
  const message = typeof completion.message === 'string' ? completion.message : '';
  if (!message.includes('push command completed')) {
    throw new Error(
      `turn ${messageId} did not prove a completed push (auto-commit message=${JSON.stringify(message)}). ` +
        'The auto-commit snapshot scenario needs a push-capable repository, for example E2E_GITHUB_REPO with the seeded GitHub account.'
    );
  }
  return completion;
}

/**
 * The pre-push edit snapshot is the last accepted upload only if no post-push
 * capture landed. A newer upload would likely be the empty post-push snapshot,
 * which does not exercise the stale-base already-pushed skip.
 */
export function assertNoPostPushSnapshotUpload(input: {
  prePushCount: number;
  postPushCount: number;
}): void {
  if (input.postPushCount !== input.prePushCount) {
    throw new Error(
      `post-push snapshot capture raced the kill: uploads ${input.prePushCount} -> ${input.postPushCount}; ` +
        'the restored snapshot could be the post-push empty base instead of the pre-push edit'
    );
  }
}

/**
 * Shared final steps: send a `file:read` turn in the same chat, compare the
 * exact bytes, require the snapshot restore message, and require a distinct
 * allocation.
 */
async function recoverAndRead(input: {
  deadline: ScenarioDeadline;
  config: DriverConfig;
  session: WorktreeSessionResult;
  sandbox: SessionSandboxObservation;
  previousAllocation: string;
  path: string;
  expectedBytes: string;
  expectedRestore: 'positive' | 'zero';
  expectedConflicts?: number;
  label: string;
}): Promise<{ messageId: string; stream: StreamConnection; allocation: string; restore: string }> {
  const readTag = `read-${randomUUID().slice(0, 8)}`;
  const recovery = await sendTurn(
    input.deadline,
    input.config,
    input.session.cloudAgentSessionId,
    fakeDirective(`file:read:${readTag}:${input.path}`),
    input.label,
    RECOVERY_BUDGET_MS
  );
  try {
    await awaitCorrelatedChildText({
      stream: recovery.stream,
      parentMessageId: recovery.messageId,
      timeoutMs: Math.max(
        1,
        Math.min(CONTENT_CORRELATION_BUDGET_MS, input.deadline.remaining(`${input.label} content`))
      ),
      label: input.label,
      ready: text => parseFileReadEcho(text, input.path) !== null,
    });
    const body = collectChildMessageText(recovery.stream.events, recovery.messageId);
    const echo = parseFileReadEcho(body, input.path);
    if (echo !== input.expectedBytes) {
      throw new Error(
        `${input.label} read echo did not match the edited bytes: ` +
          `observed=${JSON.stringify(echo)} expected=${JSON.stringify(input.expectedBytes)}`
      );
    }
    const restore = requireSnapshotRestoreMessage(recovery.stream.events, recovery.messageId, {
      applied: input.expectedRestore,
      ...(input.expectedConflicts !== undefined ? { conflicts: input.expectedConflicts } : {}),
    });
    const allocation = await waitForDistinctAllocation(
      input.deadline,
      input.sandbox,
      input.session,
      input.previousAllocation,
      `${input.label} replacement`,
      RECOVERY_BUDGET_MS
    );
    return { messageId: recovery.messageId, stream: recovery.stream, allocation, restore };
  } catch (error) {
    recovery.stream.close();
    throw error;
  }
}

async function runMidTurnKill(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = SNAPSHOT_SCENARIO_TIMEOUT_MS } = args;
  const scenarioName = 'worktree-snapshot-midturn-kill';
  const sandbox = sessionSandboxObservation(env);
  const snapshots = requireSnapshots(env);
  const faults = requireFaults(env);
  const controlPlaneRuntime = requireRuntime(env);
  const owned = createOwnedSessionRegistry(config, cleanupRemoteSession);
  const scenarioConfig = owned.config;
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
  const creations = trackCreations<WorktreeSessionResult>(deadline, owned, scenarioName);
  const runId = randomUUID().slice(0, 8);
  const path = `snapshot-edit-${runId}.txt`;
  const baselineBytes = `baseline-${runId}`;
  const editedBytes = `edited-${runId}\nsecond-line-${runId}`;
  const gateTag = `snapgate-${runId}`;
  const events: StreamEvent[] = [];
  const streams: StreamConnection[] = [];
  let result: LifecycleResult;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events,
    durationMs: Date.now() - startedAt,
  });

  try {
    assertScenarioPreconditions(scenarioConfig, args.api);
    const session = await prepareSnapshotSession(creations, scenarioConfig, {
      prompt: fakeDirective(`file:write:boot-${runId}:${path}:${baselineBytes}`),
      autoCommit: false,
    });
    owned.register(session);
    const snapshot = await verifyWorktreeChat(deadline, scenarioConfig, session, 'snapshot boot');
    if (snapshot.autoCommit !== false) {
      throw new Error(`snapshot session autoCommit=${String(snapshot.autoCommit)}; expected false`);
    }
    const worktreeId = snapshot.worktreeId;
    if (worktreeId === null || worktreeId === undefined) {
      throw new Error('snapshot session did not expose a worktree id');
    }

    const boot = await bootToCompletion(
      deadline,
      scenarioConfig,
      session,
      'snapshot boot',
      text => text.includes(`file-write:${path}`),
      BOOT_BUDGET_MS
    );
    streams.push(boot.stream);
    events.push(...boot.stream.events);

    const { allocation, target } = await captureControlPlaneFaultTarget(
      deadline,
      sandbox,
      controlPlaneRuntime,
      session,
      'snapshot boot'
    );
    // The boot write and turn finalization both request a capture; treat the
    // first accepted upload as the baseline so the edit's upload is provable.
    const baseline = await snapshots.waitForUpload({
      allocation: target,
      worktreeId,
      afterCount: 0,
      timeoutMs: UPLOAD_WAIT_MS,
    });

    const editStream = await deadline.within('edit stream', signal =>
      openConnectedStream(scenarioConfig, session.cloudAgentSessionId, true, undefined, signal)
    );
    streams.push(editStream);
    const edit = await deadline.within('edit send', signal =>
      sendMessage(
        scenarioConfig,
        {
          cloudAgentSessionId: session.cloudAgentSessionId,
          prompt: fakeDirective(`write-then-gate:${gateTag}:${path}:${editedBytes}`),
          signal,
        },
        'unified'
      )
    );
    if (
      !(await deadline.within('edit gate', signal =>
        waitForGateEngaged(
          scenarioConfig,
          gateTag,
          Math.min(GATE_ENGAGE_BUDGET_MS, deadline.remaining('edit gate')),
          undefined,
          signal
        )
      ))
    ) {
      throw new Error(`gate ${gateTag} did not engage; the in-flight edit never landed`);
    }
    await requireRunning(
      scenarioConfig,
      session.cloudAgentSessionId,
      edit.messageId,
      deadline,
      'edit'
    );
    const uploaded = await snapshots.waitForUpload({
      allocation: target,
      worktreeId,
      afterCount: baseline.count,
      timeoutMs: UPLOAD_WAIT_MS,
    });

    const killed = await faults.killOwnedContainer(target);
    if (!killed.killed) throw new Error(`killOwnedContainer reported no kill: ${killed.detail}`);

    // Let the interrupted turn settle before the recovery message, mirroring
    // kill-mid-flight. The snapshot, not the interrupted turn, carries the work.
    const terminal = await editStream.waitForTerminal(CANCELLED_TURN_BUDGET_MS, edit.messageId);
    const affected = await deadline.within('edit durable', signal =>
      getMessageResult(scenarioConfig, session.cloudAgentSessionId, edit.messageId, signal)
    );
    if (
      terminal?.streamEventType !== 'cloud.message.failed' ||
      (affected.status !== 'failed' && affected.status !== 'interrupted')
    ) {
      throw new Error(
        `killed edit ${edit.messageId} has no matching durable failure: ` +
          `terminal=${terminal?.streamEventType ?? 'none'}; durable=${affected.status}`
      );
    }

    const recovery = await recoverAndRead({
      deadline,
      config: scenarioConfig,
      session,
      sandbox,
      previousAllocation: allocation,
      path,
      expectedBytes: editedBytes,
      expectedRestore: 'positive',
      expectedConflicts: 0,
      label: 'snapshot recovery read',
    });
    streams.push(recovery.stream);
    events.push(...editStream.events, ...recovery.stream.events);

    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message:
        `session=${session.cloudAgentSessionId}; worktreeId=${worktreeId}; ` +
        `edit=${edit.messageId}/${affected.status}; killed=${killed.observedRef}; ` +
        `snapshotUpload=${uploaded.count}; restore=${JSON.stringify(recovery.restore)}; ` +
        `bytes=${JSON.stringify(editedBytes)}; oldRef=${allocation}!=newRef=${recovery.allocation}`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    for (const stream of streams) {
      try {
        stream.close();
      } catch {
        /* ignore */
      }
    }
    await releaseGate(
      scenarioConfig.fakeLlmUrl,
      gateTag,
      AbortSignal.timeout(CLEANUP_TIMEOUT_MS)
    ).catch(() => {});
    for (const late of await creations.settleAll(LATE_CREATE_SETTLE_MS)) {
      owned.register(late);
    }
    await owned.cleanup(scenarioName);
  }
  return result;
}

async function runAutoCommitKill(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = SNAPSHOT_SCENARIO_TIMEOUT_MS } = args;
  const scenarioName = 'worktree-snapshot-autocommit-kill';
  const sandbox = sessionSandboxObservation(env);
  const snapshots = requireSnapshots(env);
  const faults = requireFaults(env);
  const controlPlaneRuntime = requireRuntime(env);
  const owned = createOwnedSessionRegistry(config, cleanupRemoteSession);
  const scenarioConfig = owned.config;
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
  const creations = trackCreations<WorktreeSessionResult>(deadline, owned, scenarioName);
  const runId = randomUUID().slice(0, 8);
  const path = `snapshot-autocommit-${runId}.txt`;
  const bytes = `pushed-${runId}\nsecond-line-${runId}`;
  const bootMarker = `autocommit-boot-${runId}`;
  const gateTag = `snapgate-${runId}`;
  const events: StreamEvent[] = [];
  const streams: StreamConnection[] = [];
  let result: LifecycleResult;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events,
    durationMs: Date.now() - startedAt,
  });

  try {
    assertScenarioPreconditions(scenarioConfig, args.api);
    const session = await prepareSnapshotSession(creations, scenarioConfig, {
      prompt: fakeDirective(`echo:${bootMarker}`),
      autoCommit: true,
    });
    owned.register(session);
    const snapshot = await verifyWorktreeChat(deadline, scenarioConfig, session, 'autocommit boot');
    if (snapshot.autoCommit !== true) {
      throw new Error(`snapshot session autoCommit=${String(snapshot.autoCommit)}; expected true`);
    }
    const worktreeId = snapshot.worktreeId;
    if (worktreeId === null || worktreeId === undefined) {
      throw new Error('snapshot session did not expose a worktree id');
    }

    const boot = await bootToCompletion(
      deadline,
      scenarioConfig,
      session,
      'autocommit boot',
      text => echoPayloadMatches(text, bootMarker),
      BOOT_BUDGET_MS
    );
    streams.push(boot.stream);
    events.push(...boot.stream.events);

    const { allocation, target } = await captureControlPlaneFaultTarget(
      deadline,
      sandbox,
      controlPlaneRuntime,
      session,
      'autocommit boot'
    );
    const baseline = await snapshots.waitForUpload({
      allocation: target,
      worktreeId,
      afterCount: 0,
      timeoutMs: UPLOAD_WAIT_MS,
    });

    // The tool writes the edit while the turn is gated. Its completion
    // requests a capture; wait for that snapshot to be accepted BEFORE
    // releasing the gate, so the stored snapshot necessarily holds the edit
    // with the pre-push base.
    const editStream = await deadline.within('autocommit edit stream', signal =>
      openConnectedStream(scenarioConfig, session.cloudAgentSessionId, true, undefined, signal)
    );
    streams.push(editStream);
    const edit = await deadline.within('autocommit edit send', signal =>
      sendMessage(
        scenarioConfig,
        {
          cloudAgentSessionId: session.cloudAgentSessionId,
          prompt: fakeDirective(`write-then-gate:${gateTag}:${path}:${bytes}`),
          signal,
        },
        'unified'
      )
    );
    if (
      !(await deadline.within('autocommit edit gate', signal =>
        waitForGateEngaged(
          scenarioConfig,
          gateTag,
          Math.min(GATE_ENGAGE_BUDGET_MS, deadline.remaining('autocommit edit gate')),
          undefined,
          signal
        )
      ))
    ) {
      throw new Error(`gate ${gateTag} did not engage; the in-flight edit never landed`);
    }
    await requireRunning(
      scenarioConfig,
      session.cloudAgentSessionId,
      edit.messageId,
      deadline,
      'autocommit edit'
    );
    const prePush = await snapshots.waitForUpload({
      allocation: target,
      worktreeId,
      afterCount: baseline.count,
      timeoutMs: UPLOAD_WAIT_MS,
    });
    if (controlPlaneRuntime.workspacePathExists) {
      const exists = await controlPlaneRuntime.workspacePathExists(target, { path });
      if (!exists) throw new Error(`gated edit did not leave ${path} in the workspace`);
    }

    // Release the gate so the turn finishes; finalization auto-commits and
    // pushes the edit. The post-push capture is requested after the push but
    // is not awaited by the turn.
    await releaseGate(scenarioConfig.fakeLlmUrl, gateTag, AbortSignal.timeout(CLEANUP_TIMEOUT_MS));
    const pushEvent = await waitForStreamEvent({
      stream: editStream,
      predicate: event =>
        event.streamEventType === 'autocommit_completed' &&
        event.data.userMessageId === edit.messageId,
      timeoutMs: TURN_BUDGET_MS,
      label: 'autocommit push',
    });
    const push = requirePushCompleted([pushEvent], edit.messageId);
    const commitHash = typeof push.commitHash === 'string' ? push.commitHash : null;

    // Freeze the wrapper before the 1s post-push debounce uploads, then read
    // the accepted-upload sequence. A newer upload means the recovery could
    // restore the post-push (empty, base=R) snapshot instead of the pre-push
    // edit; fail rather than let that satisfy the test.
    let wrapperFrozen = false;
    let postPushUploads = prePush.count;
    let killed: Awaited<ReturnType<SandboxFaultObservation['killOwnedContainer']>> | undefined;
    try {
      const frozen = await faults.freezeWrapperProcess(target);
      wrapperFrozen = frozen.frozen;
      if (!frozen.frozen) {
        throw new Error(`freezeWrapperProcess did not freeze the wrapper: ${frozen.detail}`);
      }
      postPushUploads = await snapshots.uploadCount({ allocation: target, worktreeId });
      assertNoPostPushSnapshotUpload({
        prePushCount: prePush.count,
        postPushCount: postPushUploads,
      });
      killed = await faults.killOwnedContainer(target);
      wrapperFrozen = false;
    } finally {
      if (wrapperFrozen) {
        await faults.unfreezeWrapperProcess(target).catch(() => {});
      }
    }
    if (killed === undefined || !killed.killed) {
      throw new Error(`killOwnedContainer reported no kill: ${killed?.detail ?? 'not attempted'}`);
    }

    const terminal = await editStream.waitForTerminal(CANCELLED_TURN_BUDGET_MS, edit.messageId);
    events.push(...editStream.events);
    const affected = await deadline.within('autocommit edit durable', signal =>
      getMessageResult(scenarioConfig, session.cloudAgentSessionId, edit.messageId, signal)
    );
    if (
      terminal === null ||
      (affected.status !== 'completed' &&
        affected.status !== 'failed' &&
        affected.status !== 'interrupted')
    ) {
      throw new Error(
        `killed autocommit edit ${edit.messageId} did not settle: ` +
          `terminal=${terminal?.streamEventType ?? 'none'}; durable=${affected.status}`
      );
    }

    const recovery = await recoverAndRead({
      deadline,
      config: scenarioConfig,
      session,
      sandbox,
      previousAllocation: allocation,
      path,
      expectedBytes: bytes,
      expectedRestore: 'zero',
      expectedConflicts: 0,
      label: 'autocommit recovery read',
    });
    streams.push(recovery.stream);
    events.push(...recovery.stream.events);

    if (!controlPlaneRuntime.workspacePathExists) {
      throw new Error(
        'controlPlaneRuntime.workspacePathExists is required to prove no conflict copies survived'
      );
    }
    const conflictDirectoryExists = await controlPlaneRuntime.workspacePathExists(
      { ...target, expectedAllocationRef: recovery.allocation },
      { path: '.git/kilo-recovered' }
    );
    if (conflictDirectoryExists) {
      throw new Error(
        'recovery reported conflicts=0 but .git/kilo-recovered exists in the restored workspace'
      );
    }

    const prePushDigest = /digest=([0-9a-f]+)/.exec(prePush.record)?.[1] ?? 'unknown';
    const prePushSha256 = /sha256=([0-9a-f]+)/.exec(prePush.record)?.[1] ?? 'unknown';

    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message:
        `session=${session.cloudAgentSessionId}; worktreeId=${worktreeId}; ` +
        `pushed=${path}; commit=${commitHash ?? 'unknown'}; killed=${killed.observedRef}; ` +
        `bootSnapshotUpload=${baseline.count}; prePushUploads=${prePush.count}; ` +
        `postPushUploads=${postPushUploads}; prePushDigest=${prePushDigest}; ` +
        `prePushSha256=${prePushSha256}; edit=${edit.messageId}/${affected.status}; ` +
        `restore=${JSON.stringify(recovery.restore)}; bytes=${JSON.stringify(bytes)}; ` +
        `oldRef=${allocation}!=newRef=${recovery.allocation}`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    for (const stream of streams) {
      try {
        stream.close();
      } catch {
        /* ignore */
      }
    }
    for (const late of await creations.settleAll(LATE_CREATE_SETTLE_MS)) {
      owned.register(late);
    }
    await releaseGate(
      scenarioConfig.fakeLlmUrl,
      gateTag,
      AbortSignal.timeout(CLEANUP_TIMEOUT_MS)
    ).catch(() => {});
    await owned.cleanup(scenarioName);
  }
  return result;
}

export const WORKTREE_SNAPSHOT_SHARED_SCENARIOS: Record<string, SharedScenario> = {
  'worktree-snapshot-midturn-kill': {
    name: 'worktree-snapshot-midturn-kill',
    requires: [
      'sessionSandbox',
      'sandboxFaults',
      'gates',
      'controlPlaneRuntime',
      'controlPlaneV2',
      'worktreeSnapshots',
    ],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: SNAPSHOT_SCENARIO_TIMEOUT_MS,
    run: runMidTurnKill,
  },
  'worktree-snapshot-autocommit-kill': {
    name: 'worktree-snapshot-autocommit-kill',
    requires: [
      'sessionSandbox',
      'sandboxFaults',
      'gates',
      'controlPlaneRuntime',
      'controlPlaneV2',
      'worktreeSnapshots',
    ],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: SNAPSHOT_SCENARIO_TIMEOUT_MS,
    run: runAutoCommitKill,
  },
};
