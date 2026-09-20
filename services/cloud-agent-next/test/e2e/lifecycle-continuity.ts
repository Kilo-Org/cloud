/**
 * Deterministic same-session continuity E2E scenarios.
 *
 * These scenarios own the induced-fault and long-lived-chat coverage that the
 * file-state scenarios do not reach:
 *
 * - `recover-same-session`  (A5/D4) pause the owned wrapper and require the
 *   worker's heartbeat expiry to fire for that exact connection before any
 *   recovery send; then the SAME `workspace_*` session must complete.
 * - `interrupt-then-continue` (A4) interrupt a gated turn and continue the
 *   same chat in the same container.
 * - `warm-cold-cycles` (A3) two automatic idle-stop -> restore cycles with
 *   independent evidence per cycle.
 * - `question-idle-resume` (C2) leave a real Kilo question unanswered and
 *   prove idle shutdown still happens while the last pre-stop heartbeat still
 *   reports the parked input wait; the record stays unanswered through idle and
 *   the same `workspace_*` session continues on a replacement container.
 * - `large-stream` (D1) one 256 KiB read-tool stream plus a paced follow-up.
 * - `concurrent-chats` (D2/B4) two independent sessions held at a gate barrier,
 *   then all `running` at the same instant.
 * - `feed-stale-recovery` (D4) freeze only the Kilo server of a shared worktree
 *   runtime so the inbound `/global/event` feed goes silent, prove the wrapper
 *   and container stay alive, and require the feed to recover plus a follow-up
 *   in each of the two chats on the same runtime without a feed_stale
 *   retirement.
 * - `wrapper-freeze-settled-reap` (D6) freeze only the control-wrapper Bun
 *   process after a completed turn and require recovery exhaustion to reap the
 *   allocation with the settled-reap cause plus a distinct replacement.
 * - `wrapper-freeze-inflight-reap` (D7) freeze the control-wrapper Bun process
 *   while a gated turn is still held and require the original message to
 *   terminalise `runtime_unhealthy`, the route to stay stale-active, and a
 *   follow-up on the SAME session to complete on a replacement.
 *
 * Shared helpers live in `lifecycle-file-state.ts`; worker-log framing lives
 * in `idle-stop-evidence.ts`. This module does not touch production code.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createKiloClient, type Part } from '@kilocode/sdk/v2';
import {
  createWorktreeChat,
  fetchFakeScenarioStatus,
  getMessageResult,
  getSessionSnapshot,
  interruptSession,
  messageIdFromEvent,
  releaseGate,
  sendMessage,
  type StreamConnection,
  type StreamEvent,
  type WorktreeSessionResult,
} from './client.js';
import { mintApiToken } from './auth.js';
import {
  addCleanupReport,
  acquireTracked,
  assertScenarioPreconditions,
  bootSession,
  captureLogCursor,
  cleanupScenario,
  createScenarioOperation,
  createScenarioResources,
  fakeDirective,
  isDockerExecFailureForContainer,
  recordOwnedRuntime,
  runGatedFileTurn,
  scenarioResult,
  trackSession,
  waitForOwnedRuntime,
  withinCleanupBudget,
  type ScenarioResources,
} from './lifecycle-file-state.js';
import {
  readIdleStopEvidence,
  readWorkerLogSnapshot,
  waitForWorkerLogEvidence,
  type LogRecord,
} from './idle-stop-evidence.js';
import { toolCallId } from './fake-llm-server.js';
import {
  ControlPlaneContainerUnavailableError,
  captureControlWrapperProcess,
  findControlPlaneKiloRuntime,
  inspectControlPlaneHistory,
  inspectControlPlaneKiloRoot,
  inspectControlPlaneQuestions,
  inspectControlPlaneWorkspaceFile,
  isDockerContainerGoneError,
  listSandboxContainers,
  pauseOwnedPrimary,
  readControlWrapperLog,
  signalKiloServerProcess,
  stageControlPlaneWorkspaceFile,
  unpauseOwnedPrimary,
  waitForSandboxPrimaryGone,
  type ControlPlaneKiloRuntime,
  type KiloServerProcessHandle,
  type OwnedPrimaryHandle,
  type SandboxContainer,
} from './sandbox-control.js';
import {
  readWorktreeOwnership,
  requireWorktreeGate,
  requireWorktreeSessionIdentity,
  waitForOwnedCompletion,
} from './worktree-support.js';
import { DEADLINE_MS } from '../../src/sandbox-control/deadlines.js';
import { RECOVERY_SETTLED_REAP_REASON } from '../../src/sandbox-control/recovery-cleanup.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';

export const CONTINUITY_SCENARIO_TIMEOUT_MS: Record<string, number> = {
  'recover-same-session': 8 * 60_000,
  'interrupt-then-continue': 6 * 60_000,
  'warm-cold-cycles': 25 * 60_000,
  'question-idle-resume': 20 * 60_000,
  'large-stream': 10 * 60_000,
  'concurrent-chats': 15 * 60_000,
  'feed-stale-recovery': 10 * 60_000,
  'wrapper-freeze-settled-reap': 12 * 60_000,
  'wrapper-freeze-inflight-reap': 12 * 60_000,
};

const COLD_IDLE_BUDGET_MS = 8 * 60_000;
/**
 * Size of the file staged inside the worktree. This is the "requested" payload
 * and stays at the original 256 KiB so the run records requested vs observed.
 */
const LARGE_STREAM_REQUESTED_BYTES = 256 * 1024;
/**
 * The Kilo CLI caps tool output at 51200 bytes by default, so the read RESULT
 * can never carry the full 256 KiB through Kilo -> wrapper -> client. 48 KiB is
 * a conservative floor for the largest payload this direction actually
 * delivers; the scenario asserts the cap is reached and reports the requested
 * size separately instead of claiming 256 KiB crossed the stream.
 */
const LARGE_STREAM_MIN_OBSERVED_BYTES = 48 * 1024;
/**
 * Bounded per-turn wait for `large-stream`. A healthy staged read completes in
 * well under a minute; if the turn stalls, fail with the observed cause instead
 * of burning the whole scenario deadline.
 */
const LARGE_STREAM_TURN_BUDGET_MS = 90_000;
const HEARTBEAT_EXTRA_EVIDENCE_MS = 30_000;
const CONCURRENT_TERMINAL_BUDGET_MS = 60_000;
/**
 * Independent sessions held at the gate barrier at once. Three independent
 * boots did not reliably fit this environment's budget (r1 deadline during
 * runtime discovery, r2 boot failure); two still prove simultaneous `running`
 * turns and keep the overlap evidence deterministic.
 */
const CONCURRENT_SESSION_COUNT = 2;
/** Bounded wait for the control wrapper's pre-pause heartbeat send line to appear. */
const PRE_PAUSE_SEND_RETRY_BUDGET_MS = 500;
const PRE_PAUSE_SEND_RETRY_INTERVAL_MS = 100;

/**
 * `feed-stale-recovery` bounds. The product's inbound feed marks itself stale
 * after 30s without bytes and then opens a 120s recovery episode; these waits
 * only observe those transitions, they never trigger them.
 */
const FEED_LOG_POLL_MS = 2_000;
const FEED_STALE_DETECTION_BUDGET_MS = 75_000;
const FEED_RECOVERY_BUDGET_MS = 90_000;
const FEED_FOLLOWUP_TURN_BUDGET_MS = 90_000;

/**
 * `wrapper-freeze-*` bounds. The freeze only stops the control wrapper, so
 * recovery advances through the worker's own heartbeat-expiry deadline
 * (90s) and bounded attempts; these waits observe those transitions and never
 * trigger them.
 */
const WRAPPER_FREEZE_ACTIVE_ROUTE_BUDGET_MS = 60_000;
const WRAPPER_FREEZE_TERMINAL_BUDGET_MS = 3 * 60_000;
const WRAPPER_FREEZE_RECONCILE_BUDGET_MS = 4 * 60_000;
const WRAPPER_FREEZE_FOLLOWUP_BUDGET_MS = 8 * 60_000;

const CONTROL_LOG_TAG = 'sandbox_control';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function remainingMs(resources: ScenarioResources, label: string): number {
  const timeoutMs = resources.deadlineAt - Date.now();
  if (timeoutMs <= 0) throw new Error(`scenario deadline exceeded before ${label}`);
  return timeoutMs;
}

async function awaitDurableCompletion(
  resources: ScenarioResources,
  session: WorktreeSessionResult,
  messageId: string,
  label: string
): Promise<string> {
  const deadline = Date.now() + Math.min(15_000, remainingMs(resources, label));
  let status = 'unknown';
  while (Date.now() < deadline) {
    const result = await resources.within(`durable ${label}`, () =>
      getMessageResult(resources.config, session.cloudAgentSessionId, messageId)
    );
    status = result.status;
    if (status === 'completed' || status === 'failed' || status === 'interrupted') return status;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return status;
}

/**
 * One shared lifecycle assertion for a matching message: the stream must show
 * the ordered `cloud.message.queued` -> `cloud.message.sent` ->
 * `cloud.message.completed` sequence (with no `cloud.message.failed`), and the
 * durable message must be `completed`. Callers additionally require the durable
 * status; this returns the observed stream phases for evidence.
 *
 * `queued` is required, not optional. Every admitted user message emits it
 * before acceptance can emit `sent`: admission runs
 * `completeQueuedAdmissionEffects` -> `repairQueuedAdmissionEffects` ->
 * `ensureQueuedMessageEvent` (`src/session/session-message-queue.ts:714`,
 * `:690`), which inserts and broadcasts `cloud.message.queued`
 * (`src/persistence/CloudAgentSession.ts:1548`). `cloud.message.sent` is only
 * written on acceptance (`src/persistence/CloudAgentSession.ts:3204`), which
 * always happens after admission, including the directly-accepted
 * `admitAcceptedMessage` path. There is no path that emits `sent` without first
 * emitting `queued`, so the assertion requires the full ordered prefix.
 */
function assertMessageLifecycle(
  stream: StreamConnection,
  messageId: string,
  label: string
): string {
  const types = stream.events
    .filter(event => messageIdFromEvent(event) === messageId)
    .map(event => event.streamEventType)
    .filter(type => type.startsWith('cloud.message.'));
  if (types.includes('cloud.message.failed')) {
    throw new Error(`${label} has a failed lifecycle for ${messageId}: ${types.join('>')}`);
  }
  const queuedIndex = types.indexOf('cloud.message.queued');
  const sentIndex = types.indexOf('cloud.message.sent');
  const completedIndex = types.findIndex(
    (type, index) => type === 'cloud.message.completed' && index > sentIndex
  );
  if (sentIndex === -1) {
    throw new Error(
      `${label} has no cloud.message.sent for ${messageId}: ${types.join('>') || 'none'}`
    );
  }
  if (completedIndex === -1) {
    throw new Error(
      `${label} has no cloud.message.completed after sent for ${messageId}: ${types.join('>')}`
    );
  }
  if (queuedIndex === -1) {
    throw new Error(
      `${label} has no cloud.message.queued for ${messageId}: ${types.join('>') || 'none'}`
    );
  }
  if (queuedIndex > sentIndex) {
    throw new Error(`${label} queued did not precede sent for ${messageId}: ${types.join('>')}`);
  }
  return types.join('>');
}

/**
 * Send one prompt on an existing session and require the shared ordered
 * `queued -> sent -> completed` stream lifecycle plus a durable `completed`.
 * Returns the message id, the terminal event, and the observed stream phases.
 * `onSent` fires with the admitted message id as soon as the send response is
 * known, so a later throw still lets the caller retain the recovery chain.
 */
async function sendAndAwaitCompletion(
  resources: ScenarioResources,
  session: WorktreeSessionResult,
  prompt: string,
  label: string,
  timeoutMs: number,
  onSent?: (messageId: string) => void
): Promise<{ messageId: string; terminal: StreamEvent; lifecycle: string }> {
  const stream = await resources.connect(session.cloudAgentSessionId, false);
  const sent = await resources.within(`send ${label}`, signal =>
    sendMessage(resources.kiloConfig, {
      cloudAgentSessionId: session.cloudAgentSessionId,
      prompt,
      signal,
    })
  );
  onSent?.(sent.messageId);
  const terminal = await resources.within(`terminal ${label}`, () =>
    stream.waitForTerminal(
      Math.min(timeoutMs, remainingMs(resources, `terminal ${label}`)),
      sent.messageId
    )
  );
  if (!terminal) throw new Error(`${label} did not reach a terminal stream event`);
  const status = await awaitDurableCompletion(resources, session, sent.messageId, label);
  if (status !== 'completed') {
    throw new Error(
      `${label} durable status=${status} (stream=${terminal.streamEventType} for ${sent.messageId})`
    );
  }
  const lifecycle = assertMessageLifecycle(stream, sent.messageId, label);
  return { messageId: sent.messageId, terminal, lifecycle };
}

export type ConnectionIdentity = {
  sandboxId: string;
  connectionId: string;
  wrapperInstanceId: string;
};

type WrapperSendLine = { phase: string; sequence: number; lastSentAt: number };

function isControlRecord(record: LogRecord): boolean {
  return record.logTag === CONTROL_LOG_TAG;
}

function connectionSummary(connection: ConnectionIdentity): string {
  return `sandboxId=${connection.sandboxId}; connectionId=${connection.connectionId}; wrapperInstanceId=${connection.wrapperInstanceId}`;
}

/**
 * Strict identity match: the record must carry this target's sandbox id, and
 * both the captured connection id and wrapper instance id must appear among the
 * record's connection identity fields. A record that only shares one field (for
 * example the same sandbox with a superseded connection) is a different fault.
 */
export function matchesConnection(record: LogRecord, identity: ConnectionIdentity): boolean {
  if (record.sandboxId !== identity.sandboxId) return false;
  const values = [
    record.connectionId,
    record.observationConnectionId,
    record.wrapperInstanceId,
    record.observationWrapperInstanceId,
  ].filter((value): value is string => typeof value === 'string');
  return values.includes(identity.connectionId) && values.includes(identity.wrapperInstanceId);
}

function describeRecord(record: LogRecord | undefined): string {
  if (!record) return 'none';
  const fields = [
    'diagnosticEvent',
    'deadlineId',
    'deadlineAt',
    'latenessMs',
    'connectionId',
    'wrapperInstanceId',
    'observationConnectionId',
    'observationWrapperInstanceId',
    'lastDecision',
    'heartbeatArmedBasis',
    'lastAcceptedHeartbeatAt',
    'lastReceivedHeartbeatAt',
    'armedAt',
    'armedExpiryAt',
    'cause',
    'outcome',
    'committedAt',
    'sessionState',
    'sessionWaitingOn',
    'stopCause',
    'fromState',
    'toState',
  ];
  return fields
    .filter(field => record[field] !== undefined)
    .map(field => `${field}=${String(record[field])}`)
    .join(' ');
}

/**
 * Discover the runtime that currently owns `kiloSessionId` and register its
 * container as this root's tracked container, so cleanup stops a replacement
 * created during recovery. `recordOwnedRuntime` replaces the existing pair for
 * the root in place. Discovery runs under the cleanup budget, not the scenario
 * deadline: a recovery that times out still creates a replacement, so this must
 * still run when the scenario budget is already spent. Discovery is best-effort:
 * it returns `undefined` instead of throwing, so it never masks the failure that
 * prompted the claim.
 */
async function recordRecoveryRuntime(
  resources: ScenarioResources,
  kiloSessionId: string,
  label: string
): Promise<ControlPlaneKiloRuntime | undefined> {
  try {
    const runtime = await withinCleanupBudget(label, () =>
      findControlPlaneKiloRuntime(kiloSessionId, undefined, sandbox =>
        recordOwnedRuntime(resources, kiloSessionId, sandbox)
      )
    );
    return runtime ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Capture the current connection identity for the known target sandbox. Identity
 * is read only through the target sandbox/allocation, and the records after the
 * chosen connection begins must agree on both connection and wrapper instance. A
 * missing or inconsistent identity is INCONCLUSIVE: it must fail before any
 * recovery send rather than fall back to "latest handshake in the window".
 */
async function captureConnectionIdentity(
  fromByte: number,
  sandboxId: string
): Promise<ConnectionIdentity> {
  const records = await readWorkerLogSnapshot({
    fromByte,
    match: record =>
      isControlRecord(record) &&
      record.sandboxId === sandboxId &&
      typeof record.connectionId === 'string' &&
      typeof record.wrapperInstanceId === 'string' &&
      (record.diagnosticEvent === 'handshake_committed' ||
        record.diagnosticEvent === 'heartbeat' ||
        record.diagnosticEvent === 'recovery_outcome'),
  });
  if (records.length === 0) {
    throw new Error(
      `INCONCLUSIVE: no connection identity evidence for sandbox ${sandboxId} in the boot window`
    );
  }
  const latest = records[records.length - 1] as LogRecord;
  const connectionId = latest.connectionId as string;
  const wrapperInstanceId = latest.wrapperInstanceId as string;
  const startIndex = records.findIndex(
    record => record.connectionId === connectionId && record.wrapperInstanceId === wrapperInstanceId
  );
  for (let index = startIndex; index < records.length; index++) {
    const record = records[index] as LogRecord;
    if (record.connectionId !== connectionId || record.wrapperInstanceId !== wrapperInstanceId) {
      throw new Error(
        `INCONCLUSIVE: inconsistent connection identity for sandbox ${sandboxId} at log record ${index}`
      );
    }
  }
  return { sandboxId, connectionId, wrapperInstanceId };
}

function lastWrapperHeartbeatSend(log: string | null): WrapperSendLine | undefined {
  if (!log) return undefined;
  const matches = [
    ...log.matchAll(/control heartbeat phase=(\S+) sequence=(\d+) lastSentAt=(\d+)/g),
  ];
  const last = matches.at(-1);
  if (!last) return undefined;
  return {
    phase: last[1] ?? 'unknown',
    sequence: Number(last[2] ?? 0),
    lastSentAt: Number(last[3] ?? 0),
  };
}

export type FaultClassification = {
  /**
   * `none` means the window held no identity-matched failure evidence at all
   * (a clean run). `inconclusive` means failure evidence exists but its ordered
   * chain is incomplete or ambiguous. The two must not be collapsed: only
   * `none` may be reported as a clean load.
   */
  kind: 'heartbeat_expiry' | 'disconnect' | 'none' | 'inconclusive';
  summary: string;
};

/**
 * Classify the induced fault from framed worker records for one identity using
 * the chunk-1b recovery chain. The FIRST committed `recovery_outcome`
 * (`outcome=started`) in the injection window decides:
 *
 * - `cause=heartbeat_expired` additionally requires a preceding identity-matched
 *   `deadline_fired deadlineId=heartbeatExpiry`;
 * - `cause=control_disconnected` is a disconnect (a preceding heartbeatExpiry
 *   `deadline_fired` that committed nothing does not change that).
 *
 * When the window holds no identity-matched `recovery_outcome` and no matched
 * heartbeatExpiry `deadline_fired` the result is `none` (no failure observed).
 * Any other missing/ambiguous chain, a heartbeat start without a preceding
 * matched deadline, or an unclassified cause is `inconclusive`. There is no
 * timestamp-only fallback.
 */
export function classifyFault(
  records: LogRecord[],
  identity: ConnectionIdentity
): FaultClassification {
  const matched = records.filter(
    record => isControlRecord(record) && matchesConnection(record, identity)
  );
  const hasFailureEvidence = matched.some(
    record =>
      record.diagnosticEvent === 'recovery_outcome' ||
      (record.diagnosticEvent === 'deadline_fired' && record.deadlineId === 'heartbeatExpiry')
  );
  if (!hasFailureEvidence) {
    return {
      kind: 'none',
      summary: 'no identity-matched failure evidence in the injection window',
    };
  }
  const firstStartedIndex = matched.findIndex(
    record => record.diagnosticEvent === 'recovery_outcome' && record.outcome === 'started'
  );
  if (firstStartedIndex === -1) {
    return {
      kind: 'inconclusive',
      summary:
        'identity-matched failure evidence exists but no recovery_outcome outcome=started in the injection window',
    };
  }
  const started = matched[firstStartedIndex] as LogRecord;
  const cause = typeof started.cause === 'string' ? started.cause : 'unknown';
  if (cause === 'heartbeat_expired') {
    const deadlineIndex = matched.findIndex(
      record =>
        record.diagnosticEvent === 'deadline_fired' && record.deadlineId === 'heartbeatExpiry'
    );
    if (deadlineIndex === -1 || deadlineIndex > firstStartedIndex) {
      return {
        kind: 'inconclusive',
        summary: `heartbeat_expired recovery_outcome started without a preceding matched heartbeatExpiry deadline_fired; ${describeRecord(started)}`,
      };
    }
    return {
      kind: 'heartbeat_expiry',
      summary: `${describeRecord(matched[deadlineIndex])} followed by ${describeRecord(started)}`,
    };
  }
  if (cause === 'control_disconnected') {
    return { kind: 'disconnect', summary: describeRecord(started) };
  }
  return {
    kind: 'inconclusive',
    summary: `first committed recovery_outcome cause=${cause} is not a classified fault; ${describeRecord(started)}`,
  };
}

/**
 * Wait past `DEADLINE_MS.heartbeatExpiry`, then require identity-matched
 * recovery evidence for `connection`. Returns the classification; throws when
 * no matched fault engaged (INCONCLUSIVE).
 */
async function waitForEngagedFault(
  resources: ScenarioResources,
  input: {
    connection: ConnectionIdentity;
    fromByte: number;
  }
): Promise<FaultClassification> {
  const pauseWaitMs = Math.min(
    DEADLINE_MS.heartbeatExpiry + 10_000,
    remainingMs(resources, 'heartbeat expiry wait')
  );
  await new Promise(resolve => setTimeout(resolve, pauseWaitMs));
  let records = await readWorkerLogSnapshot({
    fromByte: input.fromByte,
    match: isControlRecord,
  });
  let fault = classifyFault(records, input.connection);
  if (fault.kind === 'none' || fault.kind === 'inconclusive') {
    const late = await waitForWorkerLogEvidence({
      fromByte: input.fromByte,
      budgetMs: Math.min(
        HEARTBEAT_EXTRA_EVIDENCE_MS,
        remainingMs(resources, 'late fault evidence')
      ),
      match: record =>
        isControlRecord(record) &&
        record.diagnosticEvent === 'recovery_outcome' &&
        record.outcome === 'started' &&
        matchesConnection(record, input.connection),
    });
    if (late) {
      // The first snapshot can predate a deadline/recovery pair that both
      // committed during the extra wait. Reread the whole framed window so the
      // complete ordered chain is classified, not just the late outcome
      // appended after the old records.
      records = await readWorkerLogSnapshot({
        fromByte: input.fromByte,
        match: isControlRecord,
      });
      fault = classifyFault(records, input.connection);
    }
  }
  if (fault.kind === 'none' || fault.kind === 'inconclusive') {
    throw new Error(
      `INCONCLUSIVE: pause did not engage a matched recoverable failure for ${connectionSummary(input.connection)}; ${fault.summary}`
    );
  }
  return fault;
}

type IdleEvidence = Awaited<ReturnType<typeof readIdleStopEvidence>>;

async function waitForAutomaticIdleStop(
  resources: ScenarioResources,
  input: { sandboxId: string; ownedSandbox: SandboxContainer; budgetMs: number }
): Promise<{ evidence: IdleEvidence; cursor: { fromByte: number; capturedAt: number } }> {
  const cursor = await captureLogCursor();
  const budgetMs = Math.min(input.budgetMs, remainingMs(resources, 'automatic idle stop'));
  const [evidence, absent] = await resources.within('automatic idle stop', () =>
    Promise.all([
      resources.within('idle-stop log evidence', () =>
        readIdleStopEvidence({
          allocationId: input.sandboxId,
          sandboxId: input.sandboxId,
          fromByte: cursor.fromByte,
          budgetMs,
          cursorCapturedAt: cursor.capturedAt,
        })
      ),
      waitForSandboxPrimaryGone(input.ownedSandbox, budgetMs),
    ])
  );
  if (!absent) {
    throw new Error(
      `owned container ${input.ownedSandbox.id} did not stop after automatic idle stop`
    );
  }
  return { evidence, cursor };
}

/**
 * Resume a session after its environment was replaced: send a gated turn, prove
 * a distinct replacement container owns the same root, assert the pre-idle
 * history survived, then release and complete. The resumed turn gets the same
 * ordered stream/durable lifecycle assertion as `sendAndAwaitCompletion`, and
 * dirty-file survival is recorded as a non-gating observation.
 */
async function resumeSameSession(
  resources: ScenarioResources,
  input: {
    session: WorktreeSessionResult;
    oldContainerId: string;
    preIdleMessageId: string;
    preIdleMarker: string;
    preIdleFile?: { path: string; contents: string };
    tag: string;
  }
): Promise<{
  runtime: ControlPlaneKiloRuntime;
  messageId: string;
  lifecycle: string;
  fileSurvival: string;
}> {
  const stream = await resources.connect(input.session.cloudAgentSessionId, false);
  resources.ownedGateTags.add(input.tag);
  const sent = await resources.within(`send resume ${input.tag}`, signal =>
    sendMessage(resources.kiloConfig, {
      cloudAgentSessionId: input.session.cloudAgentSessionId,
      prompt: fakeDirective('gate', input.tag, `done-${input.tag}`),
      signal,
    })
  );
  const resumed = await waitForOwnedRuntime(resources, input.session.kiloSessionId);
  if (resumed.container.id === input.oldContainerId) {
    throw new Error(`resume reused the pre-idle container id ${input.oldContainerId}`);
  }
  await resources.within(`resume gate ${input.tag}`, () =>
    requireWorktreeGate(
      resources.config,
      input.tag,
      remainingMs(resources, `resume gate ${input.tag}`),
      stream
    )
  );
  const history = await resources.within(`resume history ${input.tag}`, () =>
    inspectControlPlaneHistory(resumed, {
      kiloSessionId: input.session.kiloSessionId,
      userMessageId: input.preIdleMessageId,
      assistantMarker: input.preIdleMarker,
    })
  );
  if (history.unavailable) throw new Error(history.reason);
  if (!history.userEntryFound || !history.assistantEntryFound) {
    throw new Error(
      `resumed history missing pre-idle entries for ${input.session.kiloSessionId}: user=${history.userEntryFound}; assistant=${history.assistantEntryFound}`
    );
  }
  let fileSurvival = 'not-requested';
  if (input.preIdleFile) {
    try {
      const file = await resources.within(`resume file ${input.tag}`, () =>
        inspectControlPlaneWorkspaceFile(resumed, {
          kiloSessionId: input.session.kiloSessionId,
          filePath: input.preIdleFile!.path,
        })
      );
      fileSurvival = file.unavailable
        ? `fileSurvived=unavailable:${file.reason}`
        : `fileSurvived=${file.exists && file.dirty && file.contents === input.preIdleFile.contents} (observed, exact-equality)`;
    } catch (error) {
      fileSurvival = `fileSurvived=error:${errorMessage(error)}`;
    }
  }
  await resources.within(`release resume ${input.tag}`, signal =>
    releaseGate(resources.config.fakeLlmUrl, input.tag, signal)
  );
  resources.ownedGateTags.delete(input.tag);
  // Non-waking final probe: only a runtime discoverable NOW can serve the
  // docker-exec completion check. When it is gone, the message-id stream
  // lifecycle plus durable completion stand in, but only after the previously
  // proven resumed container is confirmed absent.
  const runtimeNow = await resources.within(`resume runtime ${input.tag}`, () =>
    findControlPlaneKiloRuntime(input.session.kiloSessionId)
  );
  if (runtimeNow) {
    recordOwnedRuntime(resources, input.session.kiloSessionId, runtimeNow.container);
  }
  const selectedContainer = (runtimeNow ?? resumed).container;
  const ABSENCE_RECONFIRM_RESERVE_MS = 2_000;
  // Bounded absence re-confirm while the reaper may still be in flight. The
  // poll budget leaves room for `awaitDurableCompletion` and the message-id
  // lifecycle check; `resources.within` is the hard wall-clock cutoff. Absence
  // only observed at that cutoff is a failure, not a pass.
  const reconfirmAbsence = async (): Promise<void> => {
    const budgetMs = resources.deadlineAt - Date.now();
    if (budgetMs <= ABSENCE_RECONFIRM_RESERVE_MS) {
      throw new Error(
        `insufficient scenario budget to re-confirm ${selectedContainer.id} absence before durable completion`
      );
    }
    const gone = await resources.within(`resume completion ${input.tag} absence reconfirm`, () =>
      waitForSandboxPrimaryGone(selectedContainer, budgetMs - ABSENCE_RECONFIRM_RESERVE_MS)
    );
    if (!gone) {
      throw new Error(
        `resumed container ${selectedContainer.id} is still listed after the absence re-confirm window`
      );
    }
    if (resources.deadlineAt - Date.now() <= 0) {
      throw new Error(
        `scenario budget exhausted after confirming ${selectedContainer.id} absence; refusing to skip durable completion`
      );
    }
  };
  let completionAfterDisappearance = runtimeNow === null;
  if (runtimeNow) {
    try {
      await resources.within(`resume completion ${input.tag}`, () =>
        waitForOwnedCompletion(
          runtimeNow,
          input.session,
          sent.messageId,
          `done-${input.tag}`,
          remainingMs(resources, `resume completion ${input.tag}`)
        )
      );
    } catch (error) {
      if (error instanceof ControlPlaneContainerUnavailableError) {
        completionAfterDisappearance = true;
      } else if (isDockerExecFailureForContainer(error, runtimeNow.container.id)) {
        // The reaper is in flight: `docker ps` still lists the container while
        // a Docker-exec against exactly this runtime failed. The bounded
        // re-confirm below lets the stop settle; anything else keeps failing.
        completionAfterDisappearance = true;
      } else {
        throw error;
      }
    }
  }
  if (completionAfterDisappearance) {
    await reconfirmAbsence();
  }
  const status = await awaitDurableCompletion(
    resources,
    input.session,
    sent.messageId,
    `resume ${input.tag}`
  );
  if (status !== 'completed') {
    throw new Error(`resume ${input.tag} durable status=${status} for ${sent.messageId}`);
  }
  const lifecycle = assertMessageLifecycle(stream, sent.messageId, `resume ${input.tag}`);
  return { runtime: resumed, messageId: sent.messageId, lifecycle, fileSurvival };
}

function questionFromEvent(
  event: StreamEvent,
  kiloSessionId: string
): { id: string; sessionId: string } | null {
  if (event.streamEventType !== 'kilocode') return null;
  const data = event.data;
  if (data.type !== 'question.asked' && data.event !== 'question.asked') return null;
  const properties = data.properties;
  if (typeof properties !== 'object' || properties === null) return null;
  if (!('id' in properties) || !('sessionID' in properties)) return null;
  if (typeof properties.id !== 'string' || properties.sessionID !== kiloSessionId) return null;
  return { id: properties.id, sessionId: kiloSessionId };
}

async function waitForQuestion(
  resources: ScenarioResources,
  stream: StreamConnection,
  kiloSessionId: string,
  tag: string,
  timeoutMs: number
): Promise<{ id: string; sessionId: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const existing = stream.events
      .map(event => questionFromEvent(event, kiloSessionId))
      .find(question => question !== null);
    if (existing) return existing;
    const status = await fetchFakeScenarioStatus(resources.config.fakeLlmUrl, tag);
    if (status.unsupportedToolSchema) {
      throw new Error(`unsupported real Kilo tool schema for fake directive ${tag}`);
    }
    const matching = await stream.waitFor(
      event => questionFromEvent(event, kiloSessionId) !== null,
      Math.min(250, Math.max(1, deadline - Date.now()))
    );
    if (matching) {
      const question = questionFromEvent(matching, kiloSessionId);
      if (question) return question;
    }
  }
  const status = await fetchFakeScenarioStatus(resources.config.fakeLlmUrl, tag);
  if (status.toolCalls.question === 0) {
    throw new Error(`fake directive ${tag} never advertised the real question tool`);
  }
  throw new Error(`question ${tag} did not reach its owning stream`);
}

/**
 * Parse one complete `kiloSessionId:state:waitingOn` token out of the bounded
 * `.`-joined `sessionReport`. Only an exact id match counts; a substring of
 * another id never does.
 */
function parseSessionReport(
  report: unknown,
  kiloSessionId: string
): { state: string; waitingOn: string } | null {
  if (typeof report !== 'string') return null;
  for (const token of report.split('.')) {
    const [id, state, ...rest] = token.split(':');
    if (id !== kiloSessionId || state === undefined) continue;
    return { state, waitingOn: rest.join(':') || 'none' };
  }
  return null;
}

type TargetHeartbeatEvidence = {
  reportedState: unknown;
  pendingMessages: unknown;
  sessionState: unknown;
  sessionWaitingOn: unknown;
  summary: string;
};

/**
 * Select the target session's heartbeat evidence from worker records filtered by
 * the captured connection AND an exact `kiloSessionId` match. It keeps the
 * allocation-wide aggregate (`reportedState`/`pendingMessages`) from the same
 * record as the payload-derived per-session fields, and never falls back to the
 * route table, a "latest heartbeat from any connection", or aggregate-only
 * state. Returns undefined when the target has no exact-match evidence.
 */
function selectTargetHeartbeat(
  records: LogRecord[],
  identity: ConnectionIdentity,
  kiloSessionId: string
): TargetHeartbeatEvidence | undefined {
  const heartbeats = records.filter(
    record =>
      isControlRecord(record) &&
      record.diagnosticEvent === 'heartbeat' &&
      matchesConnection(record, identity)
  );
  for (let index = heartbeats.length - 1; index >= 0; index--) {
    const record = heartbeats[index] as LogRecord;
    let sessionState: unknown;
    let sessionWaitingOn: unknown;
    if (record.kiloSessionId === kiloSessionId) {
      sessionState = record.sessionState;
      sessionWaitingOn = record.sessionWaitingOn ?? 'none';
    } else {
      const parsed = parseSessionReport(record.sessionReport, kiloSessionId);
      if (!parsed) continue;
      sessionState = parsed.state;
      sessionWaitingOn = parsed.waitingOn;
    }
    if (typeof sessionState !== 'string') continue;
    return {
      reportedState: record.reportedState,
      pendingMessages: record.pendingMessages,
      sessionState,
      sessionWaitingOn,
      summary: [
        `reportedState=${String(record.reportedState ?? 'unknown')}`,
        `pendingMessages=${String(record.pendingMessages ?? 'unknown')} (allocation-wide)`,
        `kiloSessionId=${kiloSessionId}`,
        `sessionState=${String(sessionState)}`,
        `sessionWaitingOn=${String(sessionWaitingOn)}`,
        connectionSummary(identity),
      ].join('; '),
    };
  }
  return undefined;
}

/**
 * True when one heartbeat record moves the target session's route off `active`.
 * A heartbeat that carries no evidence for this exact session (neither an exact
 * `kiloSessionId` nor a packed `sessionReport` entry for it) is unrelated and
 * ignored rather than counted as a state change.
 */
export function heartbeatMovedRouteOffActive(
  record: LogRecord,
  identity: ConnectionIdentity,
  kiloSessionId: string
): boolean {
  const evidence = selectTargetHeartbeat([record], identity, kiloSessionId);
  return evidence !== undefined && evidence.sessionState !== 'active';
}

// ---------------------------------------------------------------------------
// recover-same-session (A5 / D4)
// ---------------------------------------------------------------------------

export async function lifecycleRecoverSameSession(args: LifecycleArgs): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const resources = createScenarioResources(
    args.config,
    args.timeoutMs ?? CONTINUITY_SCENARIO_TIMEOUT_MS['recover-same-session'] ?? 8 * 60_000
  );
  let result = scenarioResult(
    'recover-same-session',
    args,
    startedAt,
    resources.events,
    false,
    'scenario did not start'
  );
  let handle: OwnedPrimaryHandle | undefined;
  let unpauseOutcome = 'not-needed';
  const evidence: string[] = [];
  const record = (line: string): void => {
    evidence.push(line);
  };
  try {
    assertScenarioPreconditions(args.config, args.api);
    const runId = randomUUID();
    const bootCursor = await captureLogCursor();
    const { session, runtime, sandboxId } = await bootSession(resources, {
      runId,
      operation: createScenarioOperation('continuity-recover'),
    });
    // Record the injection identity as it becomes known so a failure result
    // still carries the full chain.
    record(`session=${session.cloudAgentSessionId}`);
    record(`sandbox=${sandboxId}`);
    record(`prePauseContainer=${runtime.container.id}`);
    const workTag = `recover-work-${runId}`;
    const workFile = `recover-${runId}.txt`;
    const workContents = `recover-${runId}`;
    const work = await runGatedFileTurn(resources, {
      session,
      runtime,
      prompt: fakeDirective('write-then-gate', workTag, workFile, workContents),
      gateTag: workTag,
      expectedFile: { path: workFile, contents: workContents },
      expectTool: 'write',
      engageTimeoutMs: remainingMs(resources, 'recover work gate'),
    });
    const connection = await captureConnectionIdentity(bootCursor.fromByte, sandboxId);
    record(`kiloRoot=${session.kiloSessionId}`);
    record(connectionSummary(connection));
    record(`bootLogCursor=${bootCursor.fromByte}`);
    record(`workMessage=${work.messageId}`);
    const pauseCursor = await captureLogCursor();
    record(`pauseLogCursor=${pauseCursor.fromByte}`);

    let wrapperSend: WrapperSendLine | undefined;
    const pauseRequestedAt = Date.now();
    let pauseAckAt: number | undefined;
    handle = await pauseOwnedPrimary(session.kiloSessionId, {
      onCaptured: captured => {
        handle = captured;
      },
      beforePause: async captured => {
        if (captured.containerId !== runtime.container.id) {
          throw new Error(
            `pause targeted ${captured.containerId}, expected boot container ${runtime.container.id}`
          );
        }
        // The control wrapper writes `control heartbeat` send lines to its own
        // log. A just-started connection may not have logged one yet, so retry
        // briefly before declaring the evidence inconclusive.
        const deadline = Date.now() + PRE_PAUSE_SEND_RETRY_BUDGET_MS;
        for (;;) {
          let log: string | null;
          try {
            log = await readControlWrapperLog(captured.containerId);
          } catch (error) {
            throw new Error(
              `INCONCLUSIVE: could not read the wrapper last-send line before pause (${errorMessage(error)})`
            );
          }
          wrapperSend = lastWrapperHeartbeatSend(log);
          if (wrapperSend) break;
          if (Date.now() >= deadline) {
            throw new Error(
              'INCONCLUSIVE: wrapper last-send heartbeat line not found before pause'
            );
          }
          await new Promise(resolve => setTimeout(resolve, PRE_PAUSE_SEND_RETRY_INTERVAL_MS));
        }
        record(
          `wrapperSendPrePause=${wrapperSend.phase}/${wrapperSend.sequence}/lastSentAt=${wrapperSend.lastSentAt}`
        );
      },
    });
    pauseAckAt = Date.now();
    record(
      `pauseAck=${handle.containerId}@${pauseAckAt}; pauseRequestedAt=${pauseRequestedAt}; pausedMs=${pauseAckAt - pauseRequestedAt}`
    );

    const fault = await waitForEngagedFault(resources, {
      connection,
      fromByte: pauseCursor.fromByte,
    });
    record(`fault=${fault.kind}`);
    record(`faultEvidence=${fault.summary.replace(/\s+/g, ' ')}`);

    await unpauseOwnedPrimary(handle);
    unpauseOutcome = `ok@${Date.now()}`;
    handle = undefined;
    record(`unpause=${unpauseOutcome}`);

    let recoveryMessageId: string | undefined;
    let recoveryLifecycle: string | undefined;
    let recoveryRuntime: ControlPlaneKiloRuntime | undefined;
    try {
      const recovery = await sendAndAwaitCompletion(
        resources,
        session,
        fakeDirective('echo', `recov-${runId}`),
        'recovery',
        remainingMs(resources, 'recovery turn'),
        messageId => {
          recoveryMessageId = messageId;
        }
      );
      recoveryLifecycle = recovery.lifecycle;
    } finally {
      // Claim the replacement even when the ordered lifecycle assertion fails,
      // so cleanup still stops the container this recovery created. Record the
      // whole recovery chain here, not after the try/finally, so a failure
      // result still carries the message id and discovered container.
      recoveryRuntime = await recordRecoveryRuntime(
        resources,
        session.kiloSessionId,
        'post-recovery runtime'
      );
      if (recoveryMessageId !== undefined) record(`recoveryMessage=${recoveryMessageId}`);
      if (recoveryLifecycle !== undefined) record(`recoveryLifecycle=${recoveryLifecycle}`);
      record(`recoveryContainer=${recoveryRuntime?.container.id ?? 'none'}`);
    }

    result = scenarioResult(
      'recover-same-session',
      args,
      startedAt,
      resources.events,
      true,
      evidence.join('; ')
    );
  } catch (error) {
    result = scenarioResult(
      'recover-same-session',
      args,
      startedAt,
      resources.events,
      false,
      [errorMessage(error), ...evidence].join('; ')
    );
  } finally {
    if (handle && unpauseOutcome === 'not-needed') {
      const frozenContainer = handle.containerId;
      try {
        await unpauseOwnedPrimary(handle);
        unpauseOutcome = `ok-in-finally@${Date.now()}`;
      } catch (unpauseError) {
        unpauseOutcome = `failed:${errorMessage(unpauseError)}`;
      }
      result = {
        ...result,
        message: `${result.message}; unpauseFinal=${unpauseOutcome}; frozenContainer=${frozenContainer}`,
      };
      handle = undefined;
    }
    const cleanup = await cleanupScenario(resources);
    result = addCleanupReport(result, cleanup);
  }
  return result;
}

// ---------------------------------------------------------------------------
// interrupt-then-continue (A4)
// ---------------------------------------------------------------------------

export async function lifecycleInterruptThenContinue(
  args: LifecycleArgs
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const resources = createScenarioResources(
    args.config,
    args.timeoutMs ?? CONTINUITY_SCENARIO_TIMEOUT_MS['interrupt-then-continue'] ?? 6 * 60_000
  );
  let result = scenarioResult(
    'interrupt-then-continue',
    args,
    startedAt,
    resources.events,
    false,
    'scenario did not start'
  );
  let gateTag: string | undefined;
  try {
    assertScenarioPreconditions(args.config, args.api);
    const runId = randomUUID();
    const { session, runtime } = await bootSession(resources, {
      runId,
      operation: createScenarioOperation('continuity-interrupt'),
    });
    const tag = `interrupt-${runId}`;
    gateTag = tag;
    const stream = await resources.connect(session.cloudAgentSessionId, false);
    resources.ownedGateTags.add(tag);
    const sent = await resources.within(`send ${tag}`, signal =>
      sendMessage(resources.kiloConfig, {
        cloudAgentSessionId: session.cloudAgentSessionId,
        prompt: fakeDirective('gate', tag, `done-${tag}`),
        signal,
      })
    );
    await resources.within(`gate ${tag}`, () =>
      requireWorktreeGate(resources.config, tag, remainingMs(resources, `gate ${tag}`), stream)
    );
    const containerBefore = runtime.container.id;
    await resources.within('interrupt', () =>
      interruptSession(resources.config, session.cloudAgentSessionId)
    );
    const failed = await resources.within('interrupted terminal', () =>
      stream.waitFor(
        event =>
          event.streamEventType === 'cloud.message.failed' &&
          messageIdFromEvent(event) === sent.messageId,
        remainingMs(resources, 'interrupted terminal')
      )
    );
    const data = failed?.data as { reason?: string; payload?: { reason?: string } } | undefined;
    const reason = data?.reason ?? data?.payload?.reason;
    if (reason !== 'interrupted') {
      throw new Error(
        `interrupted message ${sent.messageId} terminal reason=${reason ?? 'none'} (event=${failed?.streamEventType ?? 'none'})`
      );
    }
    await resources.within('release after interrupt', signal =>
      releaseGate(resources.config.fakeLlmUrl, tag, signal).catch(() => undefined)
    );
    resources.ownedGateTags.delete(tag);
    gateTag = undefined;

    const followup = await sendAndAwaitCompletion(
      resources,
      session,
      fakeDirective('echo', `continue-${runId}`),
      'follow-up',
      remainingMs(resources, 'follow-up turn')
    );
    const after = await resources.within('post-interrupt runtime', () =>
      findControlPlaneKiloRuntime(session.kiloSessionId)
    );
    if (!after || after.container.id !== containerBefore) {
      throw new Error(
        `container changed after interrupt: before=${containerBefore}; after=${after?.container.id ?? 'none'}`
      );
    }
    result = scenarioResult(
      'interrupt-then-continue',
      args,
      startedAt,
      resources.events,
      true,
      [
        `session=${session.cloudAgentSessionId}`,
        `interruptedMessage=${sent.messageId}`,
        `reason=${reason}`,
        `followUpMessage=${followup.messageId}`,
        `container=${containerBefore}`,
        `sameContainer=true`,
      ].join('; ')
    );
  } catch (error) {
    result = scenarioResult(
      'interrupt-then-continue',
      args,
      startedAt,
      resources.events,
      false,
      errorMessage(error)
    );
  } finally {
    if (gateTag) {
      await releaseGate(resources.config.fakeLlmUrl, gateTag).catch(() => undefined);
      resources.ownedGateTags.delete(gateTag);
    }
    const cleanup = await cleanupScenario(resources);
    result = addCleanupReport(result, cleanup);
  }
  return result;
}

// ---------------------------------------------------------------------------
// warm-cold-cycles (A3)
// ---------------------------------------------------------------------------

export async function lifecycleWarmColdCycles(args: LifecycleArgs): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const resources = createScenarioResources(
    args.config,
    args.timeoutMs ?? CONTINUITY_SCENARIO_TIMEOUT_MS['warm-cold-cycles'] ?? 25 * 60_000
  );
  let result = scenarioResult(
    'warm-cold-cycles',
    args,
    startedAt,
    resources.events,
    false,
    'scenario did not start'
  );
  const cycleEvidence: string[] = [];
  try {
    assertScenarioPreconditions(args.config, args.api);
    const runId = randomUUID();
    const booted = await bootSession(resources, {
      runId,
      operation: createScenarioOperation('continuity-warm-cold'),
    });
    const session = booted.session;
    const sandboxId = booted.sandboxId;
    let runtime = booted.runtime;
    for (let cycle = 1; cycle <= 2; cycle++) {
      const workTag = `warm${cycle}-${runId}`;
      const workFile = `warm-${cycle}-${runId}.txt`;
      const workContents = `warm-${cycle}-${runId}`;
      const work = await runGatedFileTurn(resources, {
        session,
        runtime,
        prompt: fakeDirective('write-then-gate', workTag, workFile, workContents),
        gateTag: workTag,
        expectedFile: { path: workFile, contents: workContents },
        expectTool: 'write',
        engageTimeoutMs: remainingMs(resources, `cycle ${cycle} work gate`),
      });
      const oldContainerId = runtime.container.id;
      const { evidence, cursor } = await waitForAutomaticIdleStop(resources, {
        sandboxId,
        ownedSandbox: runtime.container,
        budgetMs: COLD_IDLE_BUDGET_MS,
      });
      const resumed = await resumeSameSession(resources, {
        session,
        oldContainerId,
        preIdleMessageId: work.messageId,
        preIdleMarker: `done-${workTag}`,
        preIdleFile: { path: workFile, contents: workContents },
        tag: `warm-resume-${cycle}-${runId}`,
      });
      const stillPresent = (
        await resources.within('post-idle container list', () => listSandboxContainers())
      ).some(container => container.id === oldContainerId);
      if (stillPresent) {
        throw new Error(
          `pre-idle container ${oldContainerId} is still running after cycle ${cycle}`
        );
      }
      cycleEvidence.push(
        [
          `cycle${cycle}`,
          `sandbox=${sandboxId}`,
          `idleElapsed=${evidence.elapsedMs}`,
          `stoppedAt=${evidence.providerStopAt}`,
          `idleLogCursor=${cursor.fromByte}`,
          `oldContainer=${oldContainerId}`,
          `newContainer=${resumed.runtime.container.id}`,
          `workMessage=${work.messageId}`,
          `resumedMessage=${resumed.messageId}`,
          `resumedLifecycle=${resumed.lifecycle}`,
          `history=preserved`,
          resumed.fileSurvival,
        ].join(':')
      );
      runtime = resumed.runtime;
    }
    result = scenarioResult(
      'warm-cold-cycles',
      args,
      startedAt,
      resources.events,
      true,
      [`session=${session.cloudAgentSessionId}`, ...cycleEvidence].join(' | ')
    );
  } catch (error) {
    result = scenarioResult(
      'warm-cold-cycles',
      args,
      startedAt,
      resources.events,
      false,
      [errorMessage(error), ...cycleEvidence].join(' | ')
    );
  } finally {
    const cleanup = await cleanupScenario(resources);
    result = addCleanupReport(result, cleanup);
  }
  return result;
}

// ---------------------------------------------------------------------------
// question-idle-resume (C2)
// ---------------------------------------------------------------------------

export async function lifecycleQuestionIdleResume(args: LifecycleArgs): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const resources = createScenarioResources(
    args.config,
    args.timeoutMs ?? CONTINUITY_SCENARIO_TIMEOUT_MS['question-idle-resume'] ?? 20 * 60_000
  );
  let result = scenarioResult(
    'question-idle-resume',
    args,
    startedAt,
    resources.events,
    false,
    'scenario did not start'
  );
  try {
    assertScenarioPreconditions(args.config, args.api);
    const runId = randomUUID();
    const bootCursor = await captureLogCursor();
    const { session, runtime, sandboxId } = await bootSession(resources, {
      runId,
      operation: createScenarioOperation('continuity-question'),
    });
    const connection = await captureConnectionIdentity(bootCursor.fromByte, sandboxId);
    const tag = `question-idle-${runId}`;
    const questionText = `Should this session idle? ${runId}`;
    const stream = await resources.connect(session.cloudAgentSessionId, false);
    const sent = await resources.within('send question', signal =>
      sendMessage(resources.kiloConfig, {
        cloudAgentSessionId: session.cloudAgentSessionId,
        prompt: fakeDirective('question', tag, questionText),
        signal,
      })
    );
    const question = await waitForQuestion(
      resources,
      stream,
      session.kiloSessionId,
      tag,
      remainingMs(resources, 'question engagement')
    );
    const questionVisibility = await resources.within('question visibility', () =>
      inspectControlPlaneQuestions(runtime, {
        kiloSessionId: session.kiloSessionId,
        questionId: question.id,
      })
    );
    if (!questionVisibility.scoped.matchingQuestion || questionVisibility.scoped.count < 1) {
      throw new Error(
        `question ${question.id} is not visible in its owning checkout before idle: scoped=${questionVisibility.scoped.count}; unscoped=${questionVisibility.unscoped.count}`
      );
    }
    const preIdleCursor = await captureLogCursor();
    const oldContainerId = runtime.container.id;

    // Supporting "still pending" observation for the whole idle wait: poll the
    // owning checkout and retain the LAST scoped match while the primary is
    // still inspectable. The gating boundary proof is the last pre-stop
    // heartbeat reporting `waitingOn=input` (the checkout can vanish before the
    // stop commits, so an inspection after the commit is not required). An
    // inspection failure never counts as pending.
    let lastScopedObservation: { at: number; detail: string } | undefined;
    let idleDone = false;
    const pendingPoll = (async (): Promise<void> => {
      const pollDeadline = Date.now() + COLD_IDLE_BUDGET_MS;
      while (!idleDone && Date.now() < pollDeadline) {
        try {
          const visibility = await resources.within('question pending inspection', () =>
            inspectControlPlaneQuestions(runtime, {
              kiloSessionId: session.kiloSessionId,
              questionId: question.id,
            })
          );
          if (visibility.scoped.matchingQuestion) {
            lastScopedObservation = {
              at: Date.now(),
              detail: `scoped=${visibility.scoped.count}; unscoped=${visibility.unscoped.count}`,
            };
          }
        } catch {
          // The primary may be gone or momentarily unreadable; keep polling
          // until the idle wait settles.
        }
        await new Promise(resolve => setTimeout(resolve, 2_000));
      }
    })();

    let idleObserved = true;
    let idleError = '';
    let idleLogCursor: number | undefined;
    let idleStartAt: number | undefined;
    let containerDeathAt: number | undefined;
    try {
      const idle = await waitForAutomaticIdleStop(resources, {
        sandboxId,
        ownedSandbox: runtime.container,
        budgetMs: COLD_IDLE_BUDGET_MS,
      });
      idleLogCursor = idle.cursor.fromByte;
      idleStartAt = idle.evidence.physicalCommittedAt;
      containerDeathAt = idle.evidence.providerStopAt;
    } catch (error) {
      idleObserved = false;
      idleError = errorMessage(error);
    } finally {
      idleDone = true;
    }
    await pendingPoll;

    const pendingDetail =
      lastScopedObservation === undefined
        ? 'no scoped match observed while the primary was inspectable'
        : `${lastScopedObservation.detail}; observedAt=${lastScopedObservation.at}; idleStartAt=${idleStartAt ?? 'none'}; containerDeathAt=${containerDeathAt ?? 'none'}`;

    const heartbeatRecords = await readWorkerLogSnapshot({
      fromByte: preIdleCursor.fromByte,
      match: record => isControlRecord(record) && record.diagnosticEvent === 'heartbeat',
    });
    const heartbeat = selectTargetHeartbeat(heartbeatRecords, connection, session.kiloSessionId);
    const status = await fetchFakeScenarioStatus(resources.config.fakeLlmUrl, tag);
    const questionUnanswered = status.toolResults.question === 0;
    const questionResolved = stream.events.some(
      event =>
        event.streamEventType === 'kilocode' &&
        (event.data.type === 'question.replied' ||
          event.data.type === 'question.rejected' ||
          event.data.event === 'question.replied' ||
          event.data.event === 'question.rejected')
    );
    // The parked turn settles either as terminal (the fenced inactivity abort at
    // five minutes) or stays accepted behind the input wait. A question that
    // disappeared is only explained by terminal evidence on this exact message.
    const parkedStatus = await awaitDurableCompletion(
      resources,
      session,
      sent.messageId,
      'parked question'
    );
    const parkedTerminal = parkedStatus === 'failed' || parkedStatus === 'interrupted';
    if (questionResolved && !parkedTerminal) {
      throw new Error(
        `question ${question.id} was resolved before idle shutdown without terminal evidence for ${sent.messageId} (durable=${parkedStatus})`
      );
    }
    if (!idleObserved) {
      throw new Error(
        `idle-stop not observed within ${COLD_IDLE_BUDGET_MS}ms; questionPendingObserved=${lastScopedObservation !== undefined}; questionUnanswered=${questionUnanswered}; questionId=${question.id}; preIdleLogCursor=${preIdleCursor.fromByte}; pending=${pendingDetail}; heartbeat=${heartbeat?.summary ?? 'missing-target-evidence'}; error=${idleError}`
      );
    }
    if (!questionUnanswered) {
      throw new Error(
        `question ${question.id} received an answer before idle shutdown; heartbeat=${heartbeat?.summary ?? 'missing-target-evidence'}`
      );
    }
    // The last pre-stop heartbeat reporting `waitingOn=input` is the boundary
    // proof that the turn was parked on the unanswered input through idle
    // shutdown. A successful inactivity abort can clear the question before
    // that heartbeat, so once the exact parked message is terminal the terminal
    // evidence satisfies the input-wait proof and a missing heartbeat is
    // allowed. The parked turn must still settle before the post-idle
    // follow-up; a matching heartbeat alone never authorizes continuing.
    if (!parkedTerminal) {
      if (!heartbeat) {
        throw new Error(
          `INCONCLUSIVE: no heartbeat with exact kiloSessionId=${session.kiloSessionId} on the captured connection ${connectionSummary(connection)}`
        );
      }
      if (heartbeat.sessionWaitingOn !== 'input') {
        throw new Error(
          `INCONCLUSIVE: the last pre-stop heartbeat did not report a pending input wait; heartbeat=${heartbeat.summary}; scopedObserved=${lastScopedObservation !== undefined}`
        );
      }
      throw new Error(
        `parked message ${sent.messageId} did not settle before the post-idle follow-up (durable=${parkedStatus})`
      );
    }

    const postIdle = await sendAndAwaitCompletion(
      resources,
      session,
      fakeDirective('echo', `post-idle-${runId}`),
      'post-idle',
      remainingMs(resources, 'post-idle turn')
    );
    const resumed = await resources.within('post-idle runtime', () =>
      findControlPlaneKiloRuntime(session.kiloSessionId)
    );
    if (!resumed || resumed.container.id === oldContainerId) {
      throw new Error(
        `post-idle container did not change: before=${oldContainerId}; after=${resumed?.container.id ?? 'none'}`
      );
    }
    recordOwnedRuntime(resources, session.kiloSessionId, resumed.container);
    result = scenarioResult(
      'question-idle-resume',
      args,
      startedAt,
      resources.events,
      true,
      [
        `session=${session.cloudAgentSessionId}`,
        `questionId=${question.id}`,
        `questionScoped=${questionVisibility.scoped.count}`,
        `questionPendingThroughIdle=${heartbeat?.sessionWaitingOn === 'input'} (${pendingDetail})`,
        `parkedTerminal=${parkedTerminal}`,
        `parkedStatus=${parkedStatus}`,
        `questionScopedObserved=${lastScopedObservation !== undefined}`,
        `questionUnanswered=${questionUnanswered}`,
        `questionMessage=${sent.messageId}`,
        `idleStopObserved=true`,
        `idleLogCursor=${idleLogCursor ?? 'none'}`,
        `oldContainer=${oldContainerId}`,
        `newContainer=${resumed.container.id}`,
        `postIdleMessage=${postIdle.messageId}`,
        `postRestoreAnswer=not-claimed (live question is not re-answered)`,
        `heartbeat=${heartbeat?.summary ?? 'not-required(terminal-parked)'}`,
      ].join('; ')
    );
  } catch (error) {
    result = scenarioResult(
      'question-idle-resume',
      args,
      startedAt,
      resources.events,
      false,
      errorMessage(error)
    );
  } finally {
    const cleanup = await cleanupScenario(resources);
    result = addCleanupReport(result, cleanup);
  }
  return result;
}

// ---------------------------------------------------------------------------
// large-stream (D1)
// ---------------------------------------------------------------------------

type ReadMeasurement = {
  bytes?: number;
  source: string;
  callID?: string;
  streamCorrelated: boolean;
};

/**
 * One diagnostic rendering, reused by the measured result line and by the
 * scenario-failure line, so a later deadline error cannot erase what the
 * bounded measurement actually observed.
 */
function readMeasurementDiagnostic(measurement: ReadMeasurement): string {
  return [
    `requestedBytes=${LARGE_STREAM_REQUESTED_BYTES}`,
    `minObservedBytes=${LARGE_STREAM_MIN_OBSERVED_BYTES}`,
    `observedBytes=${measurement.bytes ?? 'unmeasured'}`,
    `measurementSource=${measurement.source}`,
    `readCallId=${measurement.callID ?? 'none'}`,
    `streamCorrelated=${measurement.streamCorrelated}`,
  ].join('; ');
}

/** Collect streamed `message.part.updated` parts for one exact read call id. */
function streamedReadParts(
  stream: StreamConnection,
  callID: string
): Array<Extract<Part, { type: 'tool' }>> {
  const parts: Array<Extract<Part, { type: 'tool' }>> = [];
  for (const event of stream.events) {
    if (event.streamEventType !== 'kilocode') continue;
    if (event.data.type !== 'message.part.updated') continue;
    const properties = event.data.properties;
    if (typeof properties !== 'object' || properties === null) continue;
    const part = (properties as Record<string, unknown>).part;
    if (typeof part !== 'object' || part === null) continue;
    const candidate = part as Part;
    if (candidate.type === 'tool' && candidate.tool === 'read' && candidate.callID === callID) {
      parts.push(candidate);
    }
  }
  return parts;
}

/**
 * Measure the intended `tool-stream` read. The persisted read must be the exact
 * `call_<tag>_read` call and completed, and its streamed part must be
 * correlated; a completed read from another call never qualifies.
 *
 * A single one-shot transcript read is not enough: the low observation was
 * already a completed matching part, so the size can differ between runs. Poll
 * under one explicit deadline until BOTH the 48 KiB floor and stream
 * correlation qualify. Each fetch is bounded by the remaining deadline so a
 * hung transcript request cannot outlive it. The floor is never lowered.
 */
async function measureReadToolOutput(
  resources: ScenarioResources,
  kiloSessionId: string,
  tag: string,
  stream: StreamConnection
): Promise<ReadMeasurement> {
  const expectedCallID = toolCallId(tag, 'read');
  const deadline =
    Date.now() +
    Math.min(LARGE_STREAM_TURN_BUDGET_MS, remainingMs(resources, 'tool-stream measurement'));
  const client = createKiloClient({
    baseUrl: `${resources.config.workerUrl.replace(/\/$/, '')}/kilo`,
    headers: {
      Authorization: `Bearer ${mintApiToken(resources.config.user, resources.config.nextAuthSecret)}`,
    },
  });
  let last: ReadMeasurement = { source: 'transcript-unmeasured', streamCorrelated: false };
  while (Date.now() < deadline) {
    const streamCorrelated = streamedReadParts(stream, expectedCallID).some(
      part => part.state.status === 'completed'
    );
    let measurement: ReadMeasurement;
    try {
      const result = await client.session.messages(
        { sessionID: kiloSessionId, limit: 100 },
        { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) }
      );
      if (result.error !== undefined || result.data === undefined) {
        measurement = {
          source: `transcript-error:${result.response?.status ?? 'unknown'}`,
          streamCorrelated,
        };
      } else {
        const entries = result.data as Array<{ parts: Part[] }>;
        measurement = { source: 'transcript-no-matching-completed-read-part', streamCorrelated };
        for (const entry of entries) {
          let matched: ReadMeasurement | undefined;
          for (const part of entry.parts) {
            if (part.type !== 'tool') continue;
            if (part.tool !== 'read') continue;
            if (part.state.status !== 'completed') continue;
            if (part.callID !== expectedCallID) continue;
            matched = {
              bytes: Buffer.byteLength(part.state.output, 'utf8'),
              source: streamCorrelated
                ? 'transcript-matched+stream-correlated'
                : 'transcript-matched-stream-uncorrelated',
              callID: part.callID,
              streamCorrelated,
            };
            break;
          }
          if (matched) {
            measurement = matched;
            break;
          }
        }
      }
    } catch (error) {
      measurement = { source: `transcript-threw:${errorMessage(error)}`, streamCorrelated };
    }
    last = measurement;
    if (
      measurement.bytes !== undefined &&
      measurement.bytes >= LARGE_STREAM_MIN_OBSERVED_BYTES &&
      measurement.streamCorrelated
    ) {
      return measurement;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return last;
}

/**
 * Send the `tool-stream` turn with a bounded wait. Unlike a scenario-deadline
 * wait, a stalled read fails here with the fake's observed call/result counts
 * instead of hanging for the whole scenario budget.
 */
async function sendLargeStreamTurn(
  resources: ScenarioResources,
  session: WorktreeSessionResult,
  tag: string
): Promise<{ messageId: string; terminal: StreamEvent; lifecycle: string }> {
  const stream = await resources.connect(session.cloudAgentSessionId, false);
  const sent = await resources.within('send tool-stream', signal =>
    sendMessage(resources.kiloConfig, {
      cloudAgentSessionId: session.cloudAgentSessionId,
      prompt: fakeDirective('tool-stream', tag, String(LARGE_STREAM_REQUESTED_BYTES)),
      signal,
    })
  );
  const budget = Math.min(LARGE_STREAM_TURN_BUDGET_MS, remainingMs(resources, 'tool-stream turn'));
  const terminal = await resources.within('terminal tool-stream', () =>
    stream.waitForTerminal(budget, sent.messageId)
  );
  if (!terminal) {
    const fakeStatus = await resources
      .within('tool-stream status', () => fetchFakeScenarioStatus(resources.config.fakeLlmUrl, tag))
      .catch(() => undefined);
    throw new Error(
      `large-stream turn ${sent.messageId} did not reach a terminal within ${budget}ms; ` +
        `readCalls=${fakeStatus?.toolCalls.read ?? 'unavailable'}; ` +
        `readResults=${fakeStatus?.toolResults.read ?? 'unavailable'}; requestedBytes=${LARGE_STREAM_REQUESTED_BYTES}`
    );
  }
  const durable = await awaitDurableCompletion(resources, session, sent.messageId, 'tool-stream');
  if (durable !== 'completed') {
    throw new Error(
      `tool-stream durable status=${durable} (stream=${terminal.streamEventType} for ${sent.messageId})`
    );
  }
  const lifecycle = assertMessageLifecycle(stream, sent.messageId, 'tool-stream');
  return { messageId: sent.messageId, terminal, lifecycle };
}

export async function lifecycleLargeStream(args: LifecycleArgs): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const resources = createScenarioResources(
    args.config,
    args.timeoutMs ?? CONTINUITY_SCENARIO_TIMEOUT_MS['large-stream'] ?? 10 * 60_000
  );
  let result = scenarioResult(
    'large-stream',
    args,
    startedAt,
    resources.events,
    false,
    'scenario did not start'
  );
  // Kept outside the try so a later scenario-deadline error still reports what
  // the bounded measurement observed instead of replacing it.
  let lastMeasurement: ReadMeasurement | undefined;
  try {
    assertScenarioPreconditions(args.config, args.api);
    const runId = randomUUID();
    const { session, runtime } = await bootSession(resources, {
      runId,
      operation: createScenarioOperation('continuity-large-stream'),
    });
    const tag = `large-stream-${runId}`;
    const stagedFile = `tool-stream-${tag}.txt`;
    // Stage the payload INSIDE the worktree before the turn. The fake asks Kilo
    // to read this exact path, so the bytes cross on the tool RESULT
    // (Kilo -> wrapper -> client) rather than a huge write argument that stalls.
    const staged = await resources.within('stage tool-stream file', () =>
      stageControlPlaneWorkspaceFile(runtime, {
        kiloSessionId: session.kiloSessionId,
        filePath: stagedFile,
        bytes: LARGE_STREAM_REQUESTED_BYTES,
      })
    );
    const streamTurn = await sendLargeStreamTurn(resources, session, tag);
    const status = await resources.within('tool-stream status', () =>
      fetchFakeScenarioStatus(resources.config.fakeLlmUrl, tag)
    );
    const readSucceeded = status.toolResults.read >= 1 && status.toolCalls.read >= 1;
    const stream = await resources.connect(session.cloudAgentSessionId, false);
    const measured = await measureReadToolOutput(resources, session.kiloSessionId, tag, stream);
    lastMeasurement = measured;
    const file = await resources.within('tool-stream file', () =>
      inspectControlPlaneWorkspaceFile(runtime, {
        kiloSessionId: session.kiloSessionId,
        filePath: stagedFile,
      })
    );
    if (file.unavailable) throw new Error(file.reason);
    const fileBytes =
      file.exists && typeof file.contents === 'string'
        ? Buffer.byteLength(file.contents, 'utf8')
        : 0;
    const followup = await sendAndAwaitCompletion(
      resources,
      session,
      fakeDirective('slow', '20', '50', '32'),
      'follow-up',
      remainingMs(resources, 'follow-up turn')
    );
    const largeStreamCoverage =
      readSucceeded &&
      measured.streamCorrelated &&
      measured.bytes !== undefined &&
      measured.bytes >= LARGE_STREAM_MIN_OBSERVED_BYTES;
    const detail = [
      `session=${session.cloudAgentSessionId}`,
      readMeasurementDiagnostic(measured),
      `stagedBytes=${staged.byteCount}`,
      `writtenFileBytes=${fileBytes}`,
      `readSucceeded=${readSucceeded}`,
      `toolStreamMessage=${streamTurn.messageId}`,
      `followUpMessage=${followup.messageId}`,
      `largeStreamCoverage=${largeStreamCoverage}`,
      largeStreamCoverage
        ? 'coverage=verified'
        : `coverage=not-claimed (requested=${LARGE_STREAM_REQUESTED_BYTES}, minObserved=${LARGE_STREAM_MIN_OBSERVED_BYTES}, observed=${measured.bytes ?? 'unmeasured'}; completed matching read=${measured.callID ?? 'none'}, streamCorrelated=${measured.streamCorrelated}; cause=unresolved output truncation/capping (unproven); the 48KiB floor is not lowered)`,
    ].join('; ');
    result = scenarioResult(
      'large-stream',
      args,
      startedAt,
      resources.events,
      largeStreamCoverage,
      detail
    );
  } catch (error) {
    // A later scenario-deadline error must not erase the bounded measurement
    // result: keep observed/minimum bytes, exact call id, and correlation.
    const measurementNote = lastMeasurement
      ? `; lastMeasurement: ${readMeasurementDiagnostic(lastMeasurement)}`
      : '';
    result = scenarioResult(
      'large-stream',
      args,
      startedAt,
      resources.events,
      false,
      `${errorMessage(error)}${measurementNote}`
    );
  } finally {
    const cleanup = await cleanupScenario(resources);
    result = addCleanupReport(result, cleanup);
  }
  return result;
}

// ---------------------------------------------------------------------------
// concurrent-chats (D2 / B4)
// ---------------------------------------------------------------------------

type ConcurrentSession = {
  session: WorktreeSessionResult;
  runtime: ControlPlaneKiloRuntime;
  connection: ConnectionIdentity;
  tag: string;
};

type ActiveConcurrentSession = ConcurrentSession & {
  messageId: string;
  stream: StreamConnection;
};

/**
 * Per-session outcome for `concurrent-chats`. `completed_clean` requires no
 * failure evidence at all; incomplete/ambiguous failure evidence is reported as
 * `inconclusive` and fails verification rather than masquerading as clean.
 */
type ConcurrentClassification =
  | 'completed_clean'
  | 'completed_after_recovery'
  | 'inconclusive'
  | 'wedged'
  | 'failed';

export async function lifecycleConcurrentChats(args: LifecycleArgs): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const resources = createScenarioResources(
    args.config,
    args.timeoutMs ?? CONTINUITY_SCENARIO_TIMEOUT_MS['concurrent-chats'] ?? 15 * 60_000
  );
  let result = scenarioResult(
    'concurrent-chats',
    args,
    startedAt,
    resources.events,
    false,
    'scenario did not start'
  );
  const sessions: ConcurrentSession[] = [];
  try {
    assertScenarioPreconditions(args.config, args.api);
    const runId = randomUUID();
    for (let index = 0; index < CONCURRENT_SESSION_COUNT; index++) {
      const bootCursor = await captureLogCursor();
      const booted = await bootSession(resources, {
        runId: `${runId}-${index}`,
        operation: createScenarioOperation('continuity-concurrent'),
      });
      const connection = await captureConnectionIdentity(bootCursor.fromByte, booted.sandboxId);
      sessions.push({
        ...booted,
        connection,
        tag: `concurrent-${index}-${runId}`,
      });
    }
    const windowCursor = await captureLogCursor();

    const active: ActiveConcurrentSession[] = [];
    for (const entry of sessions) {
      const stream = await resources.connect(entry.session.cloudAgentSessionId, false);
      resources.ownedGateTags.add(entry.tag);
      const sent = await resources.within(`send ${entry.tag}`, signal =>
        sendMessage(resources.kiloConfig, {
          cloudAgentSessionId: entry.session.cloudAgentSessionId,
          prompt: fakeDirective('gate', entry.tag, `done-${entry.tag}`),
          signal,
        })
      );
      active.push({ ...entry, messageId: sent.messageId, stream });
    }

    await Promise.all(
      active.map(entry =>
        resources.within(`gate ${entry.tag}`, () =>
          requireWorktreeGate(
            resources.config,
            entry.tag,
            remainingMs(resources, `gate ${entry.tag}`),
            entry.stream
          )
        )
      )
    );
    // All turns are parked at their own gates before any is released, then the
    // snapshots must show every one of them `running` at the same instant. The
    // barrier is the overlap proof: no turn can be released before every gate
    // engaged.
    const barrierAt = Date.now();
    const snapshots = await Promise.all(
      active.map(entry => getSessionSnapshot(resources.config, entry.session.cloudAgentSessionId))
    );
    const overlap = snapshots.map(snapshot => snapshot.execution?.status ?? 'none').join(',');
    if (!snapshots.every(snapshot => snapshot.execution?.status === 'running')) {
      throw new Error(
        `${active.length}-way overlap not proven; barrierAt=${barrierAt}; execution statuses=${overlap}`
      );
    }

    await Promise.all(
      active.map(entry =>
        resources.within(`release ${entry.tag}`, signal =>
          releaseGate(resources.config.fakeLlmUrl, entry.tag, signal)
        )
      )
    );
    for (const entry of active) resources.ownedGateTags.delete(entry.tag);

    const outcomes = await Promise.all(
      active.map(async entry => {
        const terminal = await resources.within(`terminal ${entry.tag}`, () =>
          entry.stream.waitFor(
            event =>
              messageIdFromEvent(event) === entry.messageId &&
              (event.streamEventType === 'cloud.message.completed' ||
                event.streamEventType === 'cloud.message.failed'),
            Math.min(CONCURRENT_TERMINAL_BUDGET_MS, remainingMs(resources, `terminal ${entry.tag}`))
          )
        );
        let status = 'unreadable';
        try {
          status = (
            await resources.within(`durable ${entry.tag}`, () =>
              getMessageResult(resources.config, entry.session.cloudAgentSessionId, entry.messageId)
            )
          ).status;
        } catch {
          status = 'unreadable';
        }
        return { entry, terminal, status };
      })
    );

    const windowRecords = await readWorkerLogSnapshot({
      fromByte: windowCursor.fromByte,
      match: isControlRecord,
    });
    const classified = await Promise.all(
      outcomes.map(async outcome => {
        const evidence = classifyFault(windowRecords, outcome.entry.connection);
        const completed =
          outcome.terminal?.streamEventType === 'cloud.message.completed' &&
          outcome.status === 'completed';
        let classification: ConcurrentClassification;
        let recoveryMessage = 'none';
        if (completed) {
          assertMessageLifecycle(outcome.entry.stream, outcome.entry.messageId, outcome.entry.tag);
          if (evidence.kind === 'none') {
            classification = 'completed_clean';
          } else if (evidence.kind === 'inconclusive') {
            // Failure evidence exists but its ordered chain is incomplete:
            // never report this as a clean load.
            classification = 'inconclusive';
          } else {
            classification = 'completed_after_recovery';
          }
        } else {
          // A non-completed turn needs a same-chat follow-up to prove recovery.
          try {
            const followUp = await sendAndAwaitCompletion(
              resources,
              outcome.entry.session,
              fakeDirective('echo', `recover-${outcome.entry.tag}`),
              `recovery ${outcome.entry.tag}`,
              remainingMs(resources, `recovery ${outcome.entry.tag}`)
            );
            classification = 'completed_after_recovery';
            recoveryMessage = followUp.messageId;
          } catch (error) {
            classification = outcome.terminal === null ? 'wedged' : 'failed';
            recoveryMessage = `recovery-failed:${errorMessage(error)}`;
          } finally {
            // The attempted recovery may have created a replacement runtime;
            // track whatever owns this root now even when the turn failed.
            await recordRecoveryRuntime(
              resources,
              outcome.entry.session.kiloSessionId,
              `recovery runtime ${outcome.entry.tag}`
            );
          }
        }
        return { outcome, evidence, classification, recoveryMessage };
      })
    );

    const clean = classified.filter(item => item.classification === 'completed_clean').length;
    const recovered = classified.filter(
      item => item.classification === 'completed_after_recovery'
    ).length;
    const inconclusive = classified.filter(item => item.classification === 'inconclusive').length;
    const wedged = classified.filter(item => item.classification === 'wedged').length;
    const failed = classified.filter(
      item =>
        item.classification === 'failed' ||
        item.classification === 'wedged' ||
        item.classification === 'inconclusive'
    ).length;
    const summary = classified
      .map(
        item =>
          `${item.outcome.entry.session.cloudAgentSessionId.slice(0, 18)}=${item.classification}(evidence=${item.evidence.kind};terminal=${item.outcome.terminal?.streamEventType ?? 'none'};durable=${item.outcome.status};recovery=${item.recoveryMessage})`
      )
      .join(' | ');
    result = scenarioResult(
      'concurrent-chats',
      args,
      startedAt,
      resources.events,
      failed === 0,
      [
        `sessions=${sessions.length}`,
        `overlap=barrier(${snapshots.length}-gates-engaged)@${barrierAt};statuses=${overlap}`,
        `windowLogCursor=${windowCursor.fromByte}`,
        `clean=${clean}`,
        `recovered=${recovered}`,
        `inconclusive=${inconclusive}`,
        `wedged=${wedged}`,
        `failed=${failed}`,
        `split=clean-load:${clean}/recovered-under-load:${recovered}`,
        summary,
      ].join('; ')
    );
  } catch (error) {
    result = scenarioResult(
      'concurrent-chats',
      args,
      startedAt,
      resources.events,
      false,
      errorMessage(error)
    );
  } finally {
    const cleanup = await cleanupScenario(resources);
    result = addCleanupReport(result, cleanup);
  }
  return result;
}

// ---------------------------------------------------------------------------
// feed-stale-recovery (silent /global/event subscriber incident)
// ---------------------------------------------------------------------------

type ControlLogPollResult = { line: string; log: string };

/**
 * Poll the control wrapper log inside the container until `match` returns a
 * line, then return that line and the snapshot it came from. `match` may throw
 * to fail fast (for example when a retirement line proves the runtime is gone).
 * The poll only observes; it never fires the wrapper watchdog itself.
 */
async function pollControlWrapperLog(
  containerId: string,
  match: (log: string) => string | undefined,
  timeoutMs: number,
  label: string
): Promise<ControlLogPollResult> {
  const deadline = Date.now() + timeoutMs;
  let logBytes = 0;
  for (;;) {
    const log = (await readControlWrapperLog(containerId)) ?? '';
    logBytes = log.length;
    const line = match(log);
    if (line) return { line, log };
    if (Date.now() >= deadline) {
      throw new Error(
        `${label} did not appear in the control wrapper log within ${timeoutMs}ms (logBytes=${logBytes})`
      );
    }
    await new Promise(resolve => setTimeout(resolve, FEED_LOG_POLL_MS));
  }
}

/**
 * Find one `control feed` line for exactly `directoryName` carrying `needle`.
 * The feed line prefixes its identity (`scopeId`, `runtimeId`, `directory`), so
 * scoping by directory keeps a sibling runtime's transition out.
 */
function findFeedLine(
  log: string | null,
  directoryName: string,
  needle: string
): string | undefined {
  if (!log) return undefined;
  const marker = `directory=${directoryName} `;
  return log.split('\n').find(line => line.includes(marker) && line.includes(needle));
}

function countLogMatches(log: string | null, needle: string): number {
  if (!log || needle.length === 0) return 0;
  let count = 0;
  let index = log.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = log.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Reproduce the incident where one worktree runtime's inbound
 * `/global/event` subscriber went silent for 30s while the wrapper and
 * container stayed alive. Two chats share one worktree runtime; only the Kilo
 * server process is frozen with `docker exec kill -STOP`, never the container.
 *
 * The scenario must pass only when the feed's own recovery budget survives:
 * the runtime is not retired, the feed reconnects/reports recovery, and a
 * follow-up in EACH chat completes on the same runtime. On the pre-change
 * wrapper the frozen feed is destroyed ~30-40s in, so the retirement line is
 * observed before the process is released and the scenario fails fast.
 */
export async function lifecycleFeedStaleRecovery(args: LifecycleArgs): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const resources = createScenarioResources(
    args.config,
    args.timeoutMs ?? CONTINUITY_SCENARIO_TIMEOUT_MS['feed-stale-recovery'] ?? 10 * 60_000
  );
  let result = scenarioResult(
    'feed-stale-recovery',
    args,
    startedAt,
    resources.events,
    false,
    'scenario did not start'
  );
  const evidence: string[] = [];
  const record = (line: string): void => {
    evidence.push(line);
  };
  let frozen: KiloServerProcessHandle | undefined;
  try {
    assertScenarioPreconditions(args.config, args.api);
    const runId = randomUUID();
    const {
      session: chatA,
      runtime,
      sandboxId,
    } = await bootSession(resources, {
      runId,
      operation: createScenarioOperation('continuity-feed-stale'),
    });
    const directoryName = path.basename(runtime.directory);
    record(`sessionA=${chatA.cloudAgentSessionId}`);
    record(`rootA=${chatA.kiloSessionId}`);
    record(`sandbox=${sandboxId}`);
    record(`container=${runtime.container.id}`);
    record(`directory=${directoryName}`);
    record(`kiloPid=${runtime.processId}`);

    const siblingOperation = createScenarioOperation('continuity-feed-stale-sibling');
    const chatB = await acquireTracked(
      resources,
      `create sibling chat (${siblingOperation.label})`,
      signal =>
        createWorktreeChat(
          resources.kiloConfig,
          {
            sourceKiloSessionId: chatA.kiloSessionId,
            sourceCloudAgentSessionId: chatA.cloudAgentSessionId,
            operationKey: siblingOperation.operationKey,
          },
          signal
        ),
      value => trackSession(resources, value),
      { operationKey: siblingOperation.operationKey, uncertainOnFailure: true }
    );
    requireWorktreeSessionIdentity(chatB, 'sibling chat');
    if (chatB.kiloSessionId === chatA.kiloSessionId) {
      throw new Error('sibling chat reused the first chat Kilo root');
    }
    record(`sessionB=${chatB.cloudAgentSessionId}`);
    record(`rootB=${chatB.kiloSessionId}`);

    const ownership = await resources.within('shared worktree ownership', () =>
      readWorktreeOwnership(resources.config, [chatA.kiloSessionId, chatB.kiloSessionId])
    );
    const rootARow = ownership.find(row => row.sessionId === chatA.kiloSessionId);
    const rootBRow = ownership.find(row => row.sessionId === chatB.kiloSessionId);
    if (!rootARow?.worktreeId || rootBRow?.worktreeId !== rootARow.worktreeId) {
      throw new Error('sibling chat did not retain the first chat worktree');
    }
    record(`worktree=${rootARow.worktreeId}`);

    // Attach the sibling to the shared worktree runtime and complete a turn so
    // both chats own roots in one Kilo process before the fault.
    const attach = await sendAndAwaitCompletion(
      resources,
      chatB,
      fakeDirective('echo', `attach-${runId}`),
      'sibling attach',
      Math.min(FEED_FOLLOWUP_TURN_BUDGET_MS, remainingMs(resources, 'sibling attach'))
    );
    record(`siblingAttachMessage=${attach.messageId}`);

    const rootA = await resources.within('shared root A', () =>
      inspectControlPlaneKiloRoot(runtime, chatA.kiloSessionId)
    );
    const rootB = await resources.within('shared root B', () =>
      inspectControlPlaneKiloRoot(runtime, chatB.kiloSessionId)
    );
    if (
      rootA.processId !== runtime.processId ||
      rootB.processId !== runtime.processId ||
      rootA.directory !== runtime.directory ||
      rootB.directory !== runtime.directory
    ) {
      throw new Error(
        `chats did not share one Kilo runtime: A=${rootA.processId}@${rootA.directory}; B=${rootB.processId}@${rootB.directory}; expected=${runtime.processId}@${runtime.directory}`
      );
    }

    const logBeforeInjection = (await readControlWrapperLog(runtime.container.id)) ?? '';
    const attachLine = logBeforeInjection
      .split('\n')
      .find(
        line =>
          line.includes('worktree runtime attach decision') &&
          line.includes(`directory=${directoryName} `) &&
          line.includes(`kiloSessionId=${chatB.kiloSessionId}`)
      );
    if (!attachLine) {
      throw new Error('control wrapper log has no attach decision for the sibling chat');
    }
    const attachAction = /action=(\S+)/.exec(attachLine)?.[1];
    const attachReason = /reason=(\S+)/.exec(attachLine)?.[1];
    if (attachAction !== 'reuse' || attachReason !== 'live_entry') {
      throw new Error(
        `sibling chat did not reuse the live shared runtime: action=${attachAction ?? 'unknown'} reason=${attachReason ?? 'unknown'}; ${attachLine}`
      );
    }
    const nativeRuntimeId = /runtimeId=([0-9a-fA-F-]{36})/.exec(attachLine)?.[1];
    if (!nativeRuntimeId) {
      throw new Error(`sibling attach decision carried no native runtime id: ${attachLine}`);
    }
    const heartbeatBefore = countLogMatches(logBeforeInjection, 'control heartbeat phase=sent');
    const retiredBefore = countLogMatches(logBeforeInjection, 'Kilo worktree retired');
    record(`siblingAttachReason=${attachReason}`);
    record(`nativeRuntimeId=${nativeRuntimeId}`);
    record(`heartbeatBeforeFreeze=${heartbeatBefore}`);
    record(`retiredBeforeFreeze=${retiredBefore}`);

    // Freeze ONLY the Kilo server: the control wrapper and container stay
    // alive, so the outbound heartbeat keeps running while the inbound feed
    // goes silent exactly like the incident.
    const handle: KiloServerProcessHandle = {
      containerId: runtime.container.id,
      processId: runtime.processId,
    };
    frozen = handle;
    await resources.within('freeze kilo server', () => signalKiloServerProcess(handle, 'STOP'));
    const stoppedAt = Date.now();
    record(`frozenContainer=${handle.containerId}; frozenKiloPid=${handle.processId}`);
    record(`stoppedAt=${stoppedAt}`);

    const containersAfterStop = await resources.within('container alive after freeze', () =>
      listSandboxContainers()
    );
    if (!containersAfterStop.some(container => container.id === runtime.container.id)) {
      throw new Error('sandbox container disappeared after freezing only the Kilo server');
    }

    const stale = await pollControlWrapperLog(
      runtime.container.id,
      log => {
        const retired = log
          .split('\n')
          .find(
            line =>
              line.includes('Kilo worktree retired') &&
              line.includes(`runtimeId=${nativeRuntimeId}`)
          );
        if (retired) {
          throw new Error(
            `worktree runtime was retired during the silent feed (pre-change behavior): ${retired.trim()}`
          );
        }
        return (
          findFeedLine(log, directoryName, 'phase=recovering reason=feed_stale') ??
          findFeedLine(log, directoryName, 'phase=stale')
        );
      },
      Math.min(FEED_STALE_DETECTION_BUDGET_MS, remainingMs(resources, 'feed-stale detection')),
      `feed-stale transition for directory=${directoryName}`
    );
    const staleDetectedAt = Date.now();
    record(`feedStale=${stale.line.trim()}`);
    record(`staleDetectedAfterFreezeMs=${staleDetectedAt - stoppedAt}`);

    const heartbeatDuringSilence = countLogMatches(stale.log, 'control heartbeat phase=sent');
    if (heartbeatDuringSilence <= heartbeatBefore) {
      throw new Error(
        'control wrapper heartbeat did not advance while the Kilo feed was silent; wrapper liveness not proven'
      );
    }
    record(`heartbeatDuringSilenceAdvanced=${heartbeatDuringSilence - heartbeatBefore}`);

    // Release the Kilo server well before the 120s recovery-episode deadline.
    await signalKiloServerProcess(handle, 'CONT');
    frozen = undefined;
    const continuedAt = Date.now();
    record(`continuedAt=${continuedAt}`);
    record(`silenceMs=${continuedAt - stoppedAt}`);

    // A follow-up in chat A must complete on the SAME runtime that survived the
    // silent feed. A's credentials own the entry env, so this attach is a
    // reuse and must not rotate the native runtime. This is the strongest
    // "same runtime after recovery" evidence for the incident.
    const followA = await sendAndAwaitCompletion(
      resources,
      chatA,
      fakeDirective('echo', `post-a-${runId}`),
      'post-recovery A',
      Math.min(FEED_FOLLOWUP_TURN_BUDGET_MS, remainingMs(resources, 'post-recovery A'))
    );
    record(`postRecoveryA=${followA.messageId} lifecycle=${followA.lifecycle}`);
    const rootAAfter = await resources.within('post-recovery root A', () =>
      inspectControlPlaneKiloRoot(runtime, chatA.kiloSessionId)
    );
    if (rootAAfter.processId !== runtime.processId || rootAAfter.directory !== runtime.directory) {
      throw new Error(
        `chat A did not reuse the runtime that survived the silent feed: now=${rootAAfter.processId}@${rootAAfter.directory}; expected=${runtime.processId}@${runtime.directory}`
      );
    }

    // The feed must report recovery while still carrying the original native
    // runtime id: the outage may not rotate or retire the runtime.
    const recovered = await pollControlWrapperLog(
      runtime.container.id,
      log =>
        log
          .split('\n')
          .find(
            line =>
              line.includes(`directory=${directoryName} `) &&
              line.includes(`runtimeId=${nativeRuntimeId}`) &&
              line.includes('phase=recovered')
          ),
      Math.min(FEED_RECOVERY_BUDGET_MS, remainingMs(resources, 'feed recovery evidence')),
      'feed recovery transition'
    );
    record(`feedRecovered=${recovered.line.trim()}`);

    const retiredAfter = countLogMatches(recovered.log, 'Kilo worktree retired');
    if (retiredAfter !== retiredBefore) {
      throw new Error(
        `worktree runtime was retired during the feed outage (before=${retiredBefore} after=${retiredAfter})`
      );
    }
    if (recovered.log.includes('Kilo worktree retired reason=feed_stale')) {
      throw new Error('control wrapper log shows a feed_stale worktree retirement');
    }

    // The sibling chat owns different session credentials, so in local dev
    // (credential containment off) its re-attach performs a credential refresh
    // that rotates the shared entry's native runtime. That refresh is not a
    // feed-stale retirement. Require chat B's follow-up to complete and both
    // roots to converge on ONE worktree runtime in the original container.
    const followB = await sendAndAwaitCompletion(
      resources,
      chatB,
      fakeDirective('echo', `post-b-${runId}`),
      'post-recovery B',
      Math.min(FEED_FOLLOWUP_TURN_BUDGET_MS, remainingMs(resources, 'post-recovery B'))
    );
    record(`postRecoveryB=${followB.messageId} lifecycle=${followB.lifecycle}`);

    const [runtimeA, runtimeB] = await Promise.all([
      resources.within('post-recovery runtime A', () =>
        findControlPlaneKiloRuntime(chatA.kiloSessionId)
      ),
      resources.within('post-recovery runtime B', () =>
        findControlPlaneKiloRuntime(chatB.kiloSessionId)
      ),
    ]);
    if (
      !runtimeA ||
      !runtimeB ||
      runtimeA.processId !== runtimeB.processId ||
      runtimeA.directory !== runtimeB.directory
    ) {
      throw new Error(
        `chats did not converge on one worktree runtime after recovery: A=${runtimeA?.processId ?? 'missing'}@${runtimeA?.directory ?? 'missing'}; B=${runtimeB?.processId ?? 'missing'}@${runtimeB?.directory ?? 'missing'}`
      );
    }
    if (
      runtimeA.container.id !== runtime.container.id ||
      runtimeA.directory !== runtime.directory
    ) {
      throw new Error(
        `post-recovery work left the original worktree container/checkout: container=${runtimeA.container.id} directory=${runtimeA.directory}; expected=${runtime.container.id}/${runtime.directory}`
      );
    }
    // Only a feed-stale retirement is a defect. The sibling's credential
    // refresh (documented above) intentionally rotates the shared entry's
    // native runtime and legitimately logs a retirement with a different
    // reason, so counting every `Kilo worktree retired` line here would fail an
    // allowed rotation. Anchor on the incident reason instead.
    const finalLog = (await readControlWrapperLog(runtime.container.id)) ?? '';
    const finalFeedStaleRetirement = finalLog
      .split('\n')
      .find(line => line.includes('Kilo worktree retired reason=feed_stale'));
    if (finalFeedStaleRetirement) {
      throw new Error(
        `control wrapper log shows a feed_stale worktree retirement after recovery: ${finalFeedStaleRetirement.trim()}`
      );
    }
    record(`postRecoveryRuntimeId=${runtimeA.processId}@${directoryName}`);
    record(`runtimeConverged=true`);

    result = scenarioResult(
      'feed-stale-recovery',
      args,
      startedAt,
      resources.events,
      true,
      [
        ...evidence,
        'retired=false',
        `feedEventNativeRuntimeIdUnchanged=${nativeRuntimeId}`,
        'chatAReusedSurvivingRuntime=true',
        'chatsConvergedOneRuntime=true',
      ].join('; ')
    );
  } catch (error) {
    result = scenarioResult(
      'feed-stale-recovery',
      args,
      startedAt,
      resources.events,
      false,
      [errorMessage(error), ...evidence].join('; ')
    );
  } finally {
    if (frozen) {
      const frozenHandle = frozen;
      frozen = undefined;
      let release = 'unknown';
      try {
        await signalKiloServerProcess(frozenHandle, 'CONT');
        release = `cont@${Date.now()}`;
      } catch (error) {
        release = `cont-failed:${errorMessage(error)}`;
      }
      result = {
        ...result,
        message: `${result.message}; frozenRelease=${release}; frozenContainer=${frozenHandle.containerId}; frozenKiloPid=${frozenHandle.processId}`,
      };
    }
    const cleanup = await cleanupScenario(resources);
    result = addCleanupReport(result, cleanup);
  }
  return result;
}

// ---------------------------------------------------------------------------
// wrapper-freeze settled/inflight reap (D6/D7)
// ---------------------------------------------------------------------------

async function captureAndFreezeControlWrapper(
  resources: ScenarioResources,
  containerId: string
): Promise<KiloServerProcessHandle> {
  const handle = await resources.within('capture control wrapper process', () =>
    captureControlWrapperProcess(containerId)
  );
  await resources.within('freeze control wrapper process', () =>
    signalKiloServerProcess(handle, 'STOP')
  );
  return handle;
}

async function assertSandboxContainerAlive(
  resources: ScenarioResources,
  containerId: string
): Promise<void> {
  const containers = await resources.within('container alive after wrapper freeze', () =>
    listSandboxContainers()
  );
  if (!containers.some(container => container.id === containerId)) {
    throw new Error('sandbox container disappeared after freezing only the control wrapper');
  }
}

/**
 * Require the identity-matched heartbeat-expiry chain before the stop: a
 * `deadline_fired deadlineId=heartbeatExpiry` followed by a
 * `recovery_outcome cause=heartbeat_expired outcome=started`. Any other
 * classification (disconnect, none, inconclusive) fails the scenario.
 */
async function requireHeartbeatExpiryFault(
  resources: ScenarioResources,
  input: { connection: ConnectionIdentity; fromByte: number; label: string }
): Promise<FaultClassification> {
  const fault = await waitForEngagedFault(resources, {
    connection: input.connection,
    fromByte: input.fromByte,
  });
  if (fault.kind !== 'heartbeat_expiry') {
    throw new Error(
      `${input.label} did not engage heartbeat-expiry recovery: kind=${fault.kind}; ${fault.summary}`
    );
  }
  return fault;
}

/**
 * The one record that proves a settled reap for this sandbox: the
 * `running -> stopping` `physical_committed` transition, with the tombstone
 * reason in BOTH `cause` and `stopCause`. A later `stop_attempt` does not
 * re-state it.
 */
export function isSettledReapStopRecord(record: LogRecord, sandboxId: string): boolean {
  return (
    isControlRecord(record) &&
    record.diagnosticEvent === 'physical_committed' &&
    record.sandboxId === sandboxId &&
    record.fromState === 'running' &&
    record.toState === 'stopping' &&
    record.cause === RECOVERY_SETTLED_REAP_REASON &&
    record.stopCause === RECOVERY_SETTLED_REAP_REASON
  );
}

/**
 * Wait for the settled-reap stop commit for this exact durable sandbox.
 */
async function waitForSettledReapStop(
  resources: ScenarioResources,
  input: { fromByte: number; sandboxId: string; label: string }
): Promise<LogRecord> {
  const record = await resources.within(input.label, () =>
    waitForWorkerLogEvidence({
      fromByte: input.fromByte,
      budgetMs: remainingMs(resources, input.label),
      match: candidate => isSettledReapStopRecord(candidate, input.sandboxId),
    })
  );
  if (!record) {
    throw new Error(
      `${input.label}: no physical_committed cause/stopCause=${RECOVERY_SETTLED_REAP_REASON} for sandbox ${input.sandboxId}`
    );
  }
  return record;
}

/**
 * Match the wrapper incarnation of a captured connection (`sandboxId` +
 * `wrapperInstanceId`), not its `connectionId`. The readiness veto uses
 * `sameRuntime` (provider + wrapper incarnation), so a re-ready frame on a
 * reconnected socket still counts as the same ready runtime.
 */
function matchesWrapperIncarnation(record: LogRecord, identity: ConnectionIdentity): boolean {
  if (record.sandboxId !== identity.sandboxId) return false;
  const values = [record.wrapperInstanceId, record.observationWrapperInstanceId].filter(
    (value): value is string => typeof value === 'string'
  );
  return values.includes(identity.wrapperInstanceId);
}

/**
 * A `wrapper_ready` frame for the captured wrapper incarnation after the freeze
 * means the runtime recovered (or was never frozen), so the settled stop would
 * have been vetoed. The scenario must not report such a run as a reap.
 */
async function assertNoWrapperReadyAfterFreeze(input: {
  fromByte: number;
  connection: ConnectionIdentity;
  label: string;
}): Promise<void> {
  const records = await readWorkerLogSnapshot({
    fromByte: input.fromByte,
    match: record =>
      isControlRecord(record) &&
      record.diagnosticEvent === 'wrapper_ready' &&
      matchesWrapperIncarnation(record, input.connection),
  });
  if (records.length > 0) {
    throw new Error(
      `${input.label}: wrapper became ready after the freeze (${describeRecord(records[0])}); a re-readied wrapper is a vetoed run, not a settled stop`
    );
  }
}

async function waitForActiveRouteReport(
  resources: ScenarioResources,
  input: {
    fromByte: number;
    connection: ConnectionIdentity;
    kiloSessionId: string;
    label: string;
  }
): Promise<TargetHeartbeatEvidence> {
  const record = await resources.within(input.label, () =>
    waitForWorkerLogEvidence({
      fromByte: input.fromByte,
      budgetMs: Math.min(
        WRAPPER_FREEZE_ACTIVE_ROUTE_BUDGET_MS,
        remainingMs(resources, input.label)
      ),
      match: candidate => {
        if (!isControlRecord(candidate) || candidate.diagnosticEvent !== 'heartbeat') return false;
        if (!matchesConnection(candidate, input.connection)) return false;
        return (
          selectTargetHeartbeat([candidate], input.connection, input.kiloSessionId)
            ?.sessionState === 'active'
        );
      },
    })
  );
  if (!record) {
    throw new Error(
      `${input.label}: no identity-matched active heartbeat for ${input.kiloSessionId}`
    );
  }
  const evidence = selectTargetHeartbeat([record], input.connection, input.kiloSessionId);
  if (!evidence) {
    throw new Error(
      `${input.label}: matched heartbeat carried no session state for ${input.kiloSessionId}`
    );
  }
  return evidence;
}

/**
 * Prove the route stayed stale-active: the last identity-matched heartbeat for
 * the target reports `active`, and no heartbeat after the freeze changes it.
 * The freeze makes it stale — heartbeats stop, so the worker keeps the last
 * `active` state with an aging `lastStateAt`.
 */
async function readStaleActiveRoute(
  resources: ScenarioResources,
  input: {
    fromByte: number;
    postFreezeByte: number;
    connection: ConnectionIdentity;
    kiloSessionId: string;
    label: string;
  }
): Promise<TargetHeartbeatEvidence & { heartbeatsAfterFreeze: number }> {
  const records = await resources.within(input.label, () =>
    readWorkerLogSnapshot({ fromByte: input.fromByte, match: isControlRecord })
  );
  const latest = selectTargetHeartbeat(records, input.connection, input.kiloSessionId);
  if (!latest) {
    throw new Error(`${input.label}: no heartbeat evidence for ${input.kiloSessionId}`);
  }
  if (latest.sessionState !== 'active') {
    throw new Error(
      `${input.label}: route did not stay active (last sessionState=${String(latest.sessionState)})`
    );
  }
  const afterFreeze = await resources.within(`${input.label} post-freeze`, () =>
    readWorkerLogSnapshot({
      fromByte: input.postFreezeByte,
      match: record =>
        isControlRecord(record) &&
        record.diagnosticEvent === 'heartbeat' &&
        matchesConnection(record, input.connection),
    })
  );
  const changed = afterFreeze.filter(record =>
    heartbeatMovedRouteOffActive(record, input.connection, input.kiloSessionId)
  );
  if (changed.length > 0) {
    throw new Error(
      `${input.label}: a heartbeat after the freeze changed the route away from active (${describeRecord(changed[0])})`
    );
  }
  return { ...latest, heartbeatsAfterFreeze: afterFreeze.length };
}

/**
 * Match an accepted-message reconciliation record to the exact message turn.
 * `messageId` is required: a record without it is not this message's evidence,
 * so a wrong-cause failure in another session cannot satisfy the scenario. When
 * the local log format retained them, the emitting session and expected wrapper
 * incarnation are also constrained.
 */
export function matchesReconciliationIdentity(
  record: LogRecord,
  input: { messageId: string; sessionId: string; wrapperInstanceId: string }
): boolean {
  if (record.messageId !== input.messageId) return false;
  if (record.sessionId !== undefined && record.sessionId !== input.sessionId) return false;
  if (
    record.expectedWrapperInstanceId !== undefined &&
    record.expectedWrapperInstanceId !== input.wrapperInstanceId
  ) {
    return false;
  }
  return true;
}

/**
 * Wait for the accepted-message watchdog to terminalise the message
 * `runtime_unhealthy`. The record's `messageId` is required and matched
 * exactly, and its session/wrapper identity is constrained when retained, so
 * only this turn's terminalisation can satisfy the scenario.
 */
async function waitForRuntimeUnhealthyReconciliation(
  resources: ScenarioResources,
  input: {
    fromByte: number;
    messageId: string;
    sessionId: string;
    wrapperInstanceId: string;
    label: string;
  }
): Promise<LogRecord> {
  const record = await resources.within(input.label, () =>
    waitForWorkerLogEvidence({
      fromByte: input.fromByte,
      budgetMs: Math.min(WRAPPER_FREEZE_RECONCILE_BUDGET_MS, remainingMs(resources, input.label)),
      match: candidate =>
        isControlRecord(candidate) &&
        candidate.diagnosticEvent === 'accepted_reconciliation' &&
        candidate.result === 'runtime_unhealthy' &&
        matchesReconciliationIdentity(candidate, input),
    })
  );
  if (!record) {
    throw new Error(
      `${input.label}: no identity-matched accepted_reconciliation result=runtime_unhealthy for message ${input.messageId}`
    );
  }
  return record;
}

async function assertDistinctReplacement(
  resources: ScenarioResources,
  session: WorktreeSessionResult,
  oldContainerId: string,
  label: string
): Promise<ControlPlaneKiloRuntime> {
  const replacement = await resources.within(label, () =>
    findControlPlaneKiloRuntime(session.kiloSessionId)
  );
  if (!replacement)
    throw new Error(`${label}: no replacement runtime for ${session.kiloSessionId}`);
  if (replacement.container.id === oldContainerId) {
    throw new Error(`${label}: replacement reused the reaped container ${oldContainerId}`);
  }
  recordOwnedRuntime(resources, session.kiloSessionId, replacement.container);
  return replacement;
}

/**
 * Identity-checked `CONT` for the captured freeze handle. A destroyed container
 * is expected after a reap and is reported, not thrown: the captured identity
 * is the only safe target, and there is nothing left to release once it is gone.
 */
async function releaseFrozenControlWrapper(
  result: LifecycleResult,
  frozen: KiloServerProcessHandle
): Promise<LifecycleResult> {
  let release: string;
  try {
    await signalKiloServerProcess(frozen, 'CONT');
    release = `cont@${Date.now()}`;
  } catch (error) {
    release = isDockerContainerGoneError(error)
      ? 'container-gone'
      : `cont-failed:${errorMessage(error)}`;
  }
  return {
    ...result,
    message: `${result.message}; frozenRelease=${release}; frozenContainer=${frozen.containerId}; frozenWrapperPid=${frozen.processId}`,
  };
}

/**
 * Freeze only the control-wrapper Bun process after a completed turn. Recovery
 * must exhaust without a re-ready runtime and reap the allocation with the
 * settled cause, then a distinct replacement must serve the same session.
 */
export async function lifecycleWrapperFreezeSettledReap(
  args: LifecycleArgs
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const resources = createScenarioResources(
    args.config,
    args.timeoutMs ?? CONTINUITY_SCENARIO_TIMEOUT_MS['wrapper-freeze-settled-reap'] ?? 12 * 60_000
  );
  let result = scenarioResult(
    'wrapper-freeze-settled-reap',
    args,
    startedAt,
    resources.events,
    false,
    'scenario did not start'
  );
  const evidence: string[] = [];
  const record = (line: string): void => {
    evidence.push(line);
  };
  let frozen: KiloServerProcessHandle | undefined;
  try {
    assertScenarioPreconditions(args.config, args.api);
    const runId = randomUUID();
    const bootCursor = await captureLogCursor();
    const { session, runtime, sandboxId } = await bootSession(resources, {
      runId,
      operation: createScenarioOperation('continuity-recover'),
    });
    record(`session=${session.cloudAgentSessionId}`);
    record(`sandbox=${sandboxId}`);
    record(`kiloRoot=${session.kiloSessionId}`);
    record(`reapedContainer=${runtime.container.id}`);

    const workTag = `freeze-settled-work-${runId}`;
    const workFile = `freeze-settled-${runId}.txt`;
    const workContents = `freeze-settled-${runId}`;
    const work = await runGatedFileTurn(resources, {
      session,
      runtime,
      prompt: fakeDirective('write-then-gate', workTag, workFile, workContents),
      gateTag: workTag,
      expectedFile: { path: workFile, contents: workContents },
      expectTool: 'write',
      engageTimeoutMs: remainingMs(resources, 'settled work gate'),
    });
    record(`workMessage=${work.messageId}`);

    const connection = await captureConnectionIdentity(bootCursor.fromByte, sandboxId);
    record(connectionSummary(connection));

    const freezeCursor = await captureLogCursor();
    record(`freezeLogCursor=${freezeCursor.fromByte}`);
    frozen = await captureAndFreezeControlWrapper(resources, runtime.container.id);
    record(
      `frozenContainer=${frozen.containerId}; frozenWrapperPid=${frozen.processId}; frozenAt=${Date.now()}`
    );
    await assertSandboxContainerAlive(resources, runtime.container.id);
    record('containerAliveAfterFreeze=true');

    const fault = await requireHeartbeatExpiryFault(resources, {
      connection,
      fromByte: freezeCursor.fromByte,
      label: 'settled freeze',
    });
    record(`fault=${fault.kind}`);
    record(`faultEvidence=${fault.summary.replace(/\s+/g, ' ')}`);

    const stopRecord = await waitForSettledReapStop(resources, {
      fromByte: freezeCursor.fromByte,
      sandboxId,
      label: 'settled reap stop',
    });
    record(`stopEvidence=${describeRecord(stopRecord)}`);

    // No re-ready runtime at the stop decision: the frozen wrapper never sent a
    // ready frame, so the settled stop was not a vetoed run.
    await assertNoWrapperReadyAfterFreeze({
      fromByte: freezeCursor.fromByte,
      connection,
      label: 'wrapper-freeze-settled-reap',
    });
    record('wrapperReadyAfterFreeze=false');

    const gone = await resources.within('reaped primary gone', () =>
      waitForSandboxPrimaryGone(runtime.container, remainingMs(resources, 'reaped primary gone'))
    );
    if (!gone) {
      throw new Error(
        `reaped container ${runtime.container.id} is still listed after the settled stop`
      );
    }
    record('reapedPrimaryGone=true');

    let replacementMessageId: string | undefined;
    let replacementLifecycle: string | undefined;
    let replacementRuntime: ControlPlaneKiloRuntime | undefined;
    try {
      const follow = await sendAndAwaitCompletion(
        resources,
        session,
        fakeDirective('echo', `freeze-settled-follow-${runId}`),
        'settled replacement',
        Math.min(WRAPPER_FREEZE_FOLLOWUP_BUDGET_MS, remainingMs(resources, 'settled replacement'))
      );
      replacementMessageId = follow.messageId;
      replacementLifecycle = follow.lifecycle;
      replacementRuntime = await assertDistinctReplacement(
        resources,
        session,
        runtime.container.id,
        'settled replacement runtime'
      );
    } finally {
      // The replacement is created by the follow-up turn. Claim whatever now
      // owns the session even when that turn or the distinctness assertion
      // failed, so cleanup stops it instead of leaking the container.
      const claimed = await recordRecoveryRuntime(
        resources,
        session.kiloSessionId,
        'settled replacement runtime'
      );
      if (claimed) replacementRuntime = claimed;
    }
    record(`replacementMessage=${replacementMessageId}; lifecycle=${replacementLifecycle}`);
    record(`replacementContainer=${replacementRuntime?.container.id ?? 'none'}`);

    result = scenarioResult(
      'wrapper-freeze-settled-reap',
      args,
      startedAt,
      resources.events,
      true,
      [
        ...evidence,
        `cause=${RECOVERY_SETTLED_REAP_REASON}`,
        'settledReap=true',
        'wrapperFrozenThroughCleanupDeadline=true',
      ].join('; ')
    );
  } catch (error) {
    result = scenarioResult(
      'wrapper-freeze-settled-reap',
      args,
      startedAt,
      resources.events,
      false,
      [errorMessage(error), ...evidence].join('; ')
    );
  } finally {
    if (frozen) {
      const frozenHandle = frozen;
      frozen = undefined;
      result = await releaseFrozenControlWrapper(result, frozenHandle);
    }
    const cleanup = await cleanupScenario(resources);
    result = addCleanupReport(result, cleanup);
  }
  return result;
}

/**
 * Freeze only the control-wrapper Bun process while a gated turn is still held
 * (the production incident shape). The original message must terminalise
 * `runtime_unhealthy`, the route must stay stale-active, recovery must exhaust
 * and reap the allocation with the settled cause, and a follow-up on the SAME
 * session must complete on a distinct replacement.
 */
export async function lifecycleWrapperFreezeInflightReap(
  args: LifecycleArgs
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const resources = createScenarioResources(
    args.config,
    args.timeoutMs ?? CONTINUITY_SCENARIO_TIMEOUT_MS['wrapper-freeze-inflight-reap'] ?? 12 * 60_000
  );
  let result = scenarioResult(
    'wrapper-freeze-inflight-reap',
    args,
    startedAt,
    resources.events,
    false,
    'scenario did not start'
  );
  const evidence: string[] = [];
  const record = (line: string): void => {
    evidence.push(line);
  };
  let frozen: KiloServerProcessHandle | undefined;
  try {
    assertScenarioPreconditions(args.config, args.api);
    const runId = randomUUID();
    const bootCursor = await captureLogCursor();
    const { session, runtime, sandboxId } = await bootSession(resources, {
      runId,
      operation: createScenarioOperation('continuity-recover'),
    });
    record(`session=${session.cloudAgentSessionId}`);
    record(`sandbox=${sandboxId}`);
    record(`kiloRoot=${session.kiloSessionId}`);
    record(`reapedContainer=${runtime.container.id}`);

    const tag = `freeze-inflight-${runId}`;
    const stream = await resources.connect(session.cloudAgentSessionId, false);
    resources.ownedGateTags.add(tag);
    const sent = await resources.within(`send ${tag}`, signal =>
      sendMessage(resources.kiloConfig, {
        cloudAgentSessionId: session.cloudAgentSessionId,
        prompt: fakeDirective('gate', tag, `done-${tag}`),
        signal,
      })
    );
    await resources.within(`gate ${tag}`, () =>
      requireWorktreeGate(
        resources.config,
        tag,
        remainingMs(resources, `gate ${tag}`),
        stream,
        sent.messageId
      )
    );
    record(`inflightMessage=${sent.messageId}`);

    const connection = await captureConnectionIdentity(bootCursor.fromByte, sandboxId);
    record(connectionSummary(connection));

    const activeReport = await waitForActiveRouteReport(resources, {
      fromByte: bootCursor.fromByte,
      connection,
      kiloSessionId: session.kiloSessionId,
      label: 'active route report',
    });
    record(`activeRouteReport=${activeReport.summary}`);

    const freezeCursor = await captureLogCursor();
    record(`freezeLogCursor=${freezeCursor.fromByte}`);
    frozen = await captureAndFreezeControlWrapper(resources, runtime.container.id);
    record(
      `frozenContainer=${frozen.containerId}; frozenWrapperPid=${frozen.processId}; frozenAt=${Date.now()}`
    );
    await assertSandboxContainerAlive(resources, runtime.container.id);
    record('containerAliveAfterFreeze=true');

    const fault = await requireHeartbeatExpiryFault(resources, {
      connection,
      fromByte: freezeCursor.fromByte,
      label: 'inflight freeze',
    });
    record(`fault=${fault.kind}`);
    record(`faultEvidence=${fault.summary.replace(/\s+/g, ' ')}`);

    const failed = await resources.within('original message terminal', () =>
      stream.waitFor(
        event =>
          event.streamEventType === 'cloud.message.failed' &&
          messageIdFromEvent(event) === sent.messageId,
        Math.min(
          WRAPPER_FREEZE_TERMINAL_BUDGET_MS,
          remainingMs(resources, 'original message terminal')
        )
      )
    );
    if (!failed) {
      throw new Error(`gated message ${sent.messageId} did not terminalise`);
    }
    const terminalStatus = typeof failed.data.status === 'string' ? failed.data.status : 'none';
    if (terminalStatus !== 'failed') {
      throw new Error(`gated message ${sent.messageId} terminal status=${terminalStatus}`);
    }
    const unhealthy = await waitForRuntimeUnhealthyReconciliation(resources, {
      fromByte: freezeCursor.fromByte,
      messageId: sent.messageId,
      sessionId: session.cloudAgentSessionId,
      wrapperInstanceId: connection.wrapperInstanceId,
      label: 'runtime_unhealthy reconciliation',
    });
    record('messageTerminal=cloud.message.failed status=failed');
    record(`reconciliation=${describeRecord(unhealthy)} result=${String(unhealthy.result)}`);

    const stopRecord = await waitForSettledReapStop(resources, {
      fromByte: freezeCursor.fromByte,
      sandboxId,
      label: 'inflight settled reap stop',
    });
    record(`stopEvidence=${describeRecord(stopRecord)}`);

    await assertNoWrapperReadyAfterFreeze({
      fromByte: freezeCursor.fromByte,
      connection,
      label: 'wrapper-freeze-inflight-reap',
    });
    record('wrapperReadyAfterFreeze=false');

    const staleRoute = await readStaleActiveRoute(resources, {
      fromByte: bootCursor.fromByte,
      postFreezeByte: freezeCursor.fromByte,
      connection,
      kiloSessionId: session.kiloSessionId,
      label: 'stale active route',
    });
    record(
      `staleActiveRoute=${staleRoute.summary}; heartbeatsAfterFreeze=${staleRoute.heartbeatsAfterFreeze}`
    );

    const gone = await resources.within('reaped primary gone', () =>
      waitForSandboxPrimaryGone(runtime.container, remainingMs(resources, 'reaped primary gone'))
    );
    if (!gone) {
      throw new Error(
        `reaped container ${runtime.container.id} is still listed after the settled stop`
      );
    }
    record('reapedPrimaryGone=true');

    await resources.within('release inflight gate', signal =>
      releaseGate(resources.config.fakeLlmUrl, tag, signal).catch(() => undefined)
    );
    resources.ownedGateTags.delete(tag);

    let followUpMessageId: string | undefined;
    let followUpLifecycle: string | undefined;
    let replacementRuntime: ControlPlaneKiloRuntime | undefined;
    try {
      const follow = await sendAndAwaitCompletion(
        resources,
        session,
        fakeDirective('echo', `freeze-inflight-follow-${runId}`),
        'same-session follow-up',
        Math.min(
          WRAPPER_FREEZE_FOLLOWUP_BUDGET_MS,
          remainingMs(resources, 'same-session follow-up')
        )
      );
      followUpMessageId = follow.messageId;
      followUpLifecycle = follow.lifecycle;
      replacementRuntime = await assertDistinctReplacement(
        resources,
        session,
        runtime.container.id,
        'same-session replacement runtime'
      );
    } finally {
      // The replacement is created by the follow-up turn. Claim whatever now
      // owns the session even when that turn or the distinctness assertion
      // failed, so cleanup stops it instead of leaking the container.
      const claimed = await recordRecoveryRuntime(
        resources,
        session.kiloSessionId,
        'same-session replacement runtime'
      );
      if (claimed) replacementRuntime = claimed;
    }
    record(`followUpMessage=${followUpMessageId}; lifecycle=${followUpLifecycle}`);
    record(`replacementContainer=${replacementRuntime?.container.id ?? 'none'}`);

    result = scenarioResult(
      'wrapper-freeze-inflight-reap',
      args,
      startedAt,
      resources.events,
      true,
      [
        ...evidence,
        `cause=${RECOVERY_SETTLED_REAP_REASON}`,
        'runtimeUnhealthy=true',
        'routeStaleActive=true',
        'sameSessionFollowUp=true',
      ].join('; ')
    );
  } catch (error) {
    result = scenarioResult(
      'wrapper-freeze-inflight-reap',
      args,
      startedAt,
      resources.events,
      false,
      [errorMessage(error), ...evidence].join('; ')
    );
  } finally {
    if (frozen) {
      const frozenHandle = frozen;
      frozen = undefined;
      result = await releaseFrozenControlWrapper(result, frozenHandle);
    }
    const cleanup = await cleanupScenario(resources);
    result = addCleanupReport(result, cleanup);
  }
  return result;
}

export const CONTINUITY_SCENARIOS: Record<
  string,
  (args: LifecycleArgs) => Promise<LifecycleResult>
> = {
  'recover-same-session': lifecycleRecoverSameSession,
  'interrupt-then-continue': lifecycleInterruptThenContinue,
  'warm-cold-cycles': lifecycleWarmColdCycles,
  'question-idle-resume': lifecycleQuestionIdleResume,
  'large-stream': lifecycleLargeStream,
  'concurrent-chats': lifecycleConcurrentChats,
  'feed-stale-recovery': lifecycleFeedStaleRecovery,
  'wrapper-freeze-settled-reap': lifecycleWrapperFreezeSettledReap,
  'wrapper-freeze-inflight-reap': lifecycleWrapperFreezeInflightReap,
};
