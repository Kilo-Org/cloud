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
 *   prove idle shutdown still happens; capture the heartbeat payload when it
 *   does not, so chunk 6 can fix idle-arming with evidence.
 * - `large-stream` (D1) one 256 KiB read-tool stream plus a paced follow-up.
 * - `concurrent-chats` (D2/B4) three independent sessions running at once.
 *
 * Shared helpers live in `lifecycle-file-state.ts`; worker-log framing lives
 * in `idle-stop-evidence.ts`. This module does not touch production code.
 */

import { randomUUID } from 'node:crypto';
import { createKiloClient, type Part } from '@kilocode/sdk/v2';
import {
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
  assertScenarioPreconditions,
  bootSession,
  captureLogCursor,
  cleanupScenario,
  createScenarioOperation,
  createScenarioResources,
  fakeDirective,
  recordOwnedRuntime,
  runGatedFileTurn,
  scenarioResult,
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
  findControlPlaneKiloRuntime,
  inspectControlPlaneHistory,
  inspectControlPlaneQuestions,
  inspectControlPlaneWorkspaceFile,
  listSandboxContainers,
  pauseOwnedPrimary,
  readControlWrapperLog,
  unpauseOwnedPrimary,
  waitForSandboxPrimaryGone,
  type ControlPlaneKiloRuntime,
  type OwnedPrimaryHandle,
  type SandboxContainer,
} from './sandbox-control.js';
import { requireWorktreeGate, waitForOwnedCompletion } from './worktree-support.js';
import { DEADLINE_MS } from '../../src/sandbox-control/deadlines.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';

export const CONTINUITY_SCENARIO_TIMEOUT_MS: Record<string, number> = {
  'recover-same-session': 8 * 60_000,
  'interrupt-then-continue': 6 * 60_000,
  'warm-cold-cycles': 25 * 60_000,
  'question-idle-resume': 20 * 60_000,
  'large-stream': 10 * 60_000,
  'concurrent-chats': 15 * 60_000,
};

const COLD_IDLE_BUDGET_MS = 8 * 60_000;
const LARGE_STREAM_BYTES = 256 * 1024;
const HEARTBEAT_EXTRA_EVIDENCE_MS = 30_000;
const CONCURRENT_TERMINAL_BUDGET_MS = 60_000;
/** Bounded wait for the control wrapper's pre-pause heartbeat send line to appear. */
const PRE_PAUSE_SEND_RETRY_BUDGET_MS = 500;
const PRE_PAUSE_SEND_RETRY_INTERVAL_MS = 100;

const CONTROL_LOG_TAG = 'sandbox_control';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function remainingMs(resources: ScenarioResources, label: string): number {
  const timeoutMs = resources.deadlineAt - Date.now();
  if (timeoutMs <= 0) throw new Error(`scenario deadline exceeded before ${label}`);
  return timeoutMs;
}

// ---------------------------------------------------------------------------
// Stream and durable-turn helpers
// ---------------------------------------------------------------------------

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
    throw new Error(`${label} has no cloud.message.sent for ${messageId}: ${types.join('>') || 'none'}`);
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
    throw new Error(
      `${label} queued did not precede sent for ${messageId}: ${types.join('>')}`
    );
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

// ---------------------------------------------------------------------------
// Wrapper + worker-log evidence helpers (framing/correlation only)
// ---------------------------------------------------------------------------

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
  const matches = [...log.matchAll(/control heartbeat phase=(\S+) sequence=(\d+) lastSentAt=(\d+)/g)];
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
      record => record.diagnosticEvent === 'deadline_fired' && record.deadlineId === 'heartbeatExpiry'
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
      budgetMs: Math.min(HEARTBEAT_EXTRA_EVIDENCE_MS, remainingMs(resources, 'late fault evidence')),
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

// ---------------------------------------------------------------------------
// Idle-stop and resume helpers
// ---------------------------------------------------------------------------

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
    requireWorktreeGate(resources.config, input.tag, remainingMs(resources, `resume gate ${input.tag}`), stream)
  );
  const history = await resources.within(`resume history ${input.tag}`, () =>
    inspectControlPlaneHistory(resumed, {
      kiloSessionId: input.session.kiloSessionId,
      userMessageId: input.preIdleMessageId,
      assistantMarker: input.preIdleMarker,
    })
  );
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
      fileSurvival = `fileSurvived=${file.exists && file.dirty && file.contents === input.preIdleFile.contents} (observed, exact-equality)`;
    } catch (error) {
      fileSurvival = `fileSurvived=error:${errorMessage(error)}`;
    }
  }
  await resources.within(`release resume ${input.tag}`, signal =>
    releaseGate(resources.config.fakeLlmUrl, input.tag, signal)
  );
  resources.ownedGateTags.delete(input.tag);
  await resources.within(`resume completion ${input.tag}`, () =>
    waitForOwnedCompletion(
      resumed,
      input.session,
      sent.messageId,
      `done-${input.tag}`,
      remainingMs(resources, `resume completion ${input.tag}`)
    )
  );
  const status = await awaitDurableCompletion(resources, input.session, sent.messageId, `resume ${input.tag}`);
  if (status !== 'completed') {
    throw new Error(`resume ${input.tag} durable status=${status} for ${sent.messageId}`);
  }
  const lifecycle = assertMessageLifecycle(stream, sent.messageId, `resume ${input.tag}`);
  return { runtime: resumed, messageId: sent.messageId, lifecycle, fileSurvival };
}

// ---------------------------------------------------------------------------
// Question helpers
// ---------------------------------------------------------------------------

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
            throw new Error('INCONCLUSIVE: wrapper last-send heartbeat line not found before pause');
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

export async function lifecycleInterruptThenContinue(args: LifecycleArgs): Promise<LifecycleResult> {
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
    const data = failed?.data as
      | { reason?: string; payload?: { reason?: string } }
      | undefined;
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
    result = scenarioResult('interrupt-then-continue', args, startedAt, resources.events, false, errorMessage(error));
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
        throw new Error(`pre-idle container ${oldContainerId} is still running after cycle ${cycle}`);
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

    // Positive "still pending" observation at the idle boundary: poll the
    // owning checkout for the WHOLE idle wait. It must not return on the first
    // scoped match — that match usually lands seconds after asking, which is
    // the original false pass. Only a match at/after the idle-stop initiation
    // proves the question stayed pending until shutdown. An inspection failure
    // never counts as pending.
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

    // The positive scoped inspection must land AT or AFTER the idle-stop
    // initiation. A match seen before the boundary (for example seconds after
    // asking) does not prove the question stayed pending until shutdown; if the
    // primary was already gone when the boundary arrived, no such inspection is
    // possible and the result is INCONCLUSIVE.
    const pendingObservedAtIdleBoundary =
      idleObserved &&
      lastScopedObservation !== undefined &&
      idleStartAt !== undefined &&
      lastScopedObservation.at >= idleStartAt;
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
    if (questionResolved) {
      throw new Error(`question ${question.id} was resolved before idle shutdown`);
    }
    if (!idleObserved) {
      throw new Error(
        `idle-stop not observed within ${COLD_IDLE_BUDGET_MS}ms; questionPendingObserved=${pendingObservedAtIdleBoundary}; questionUnanswered=${questionUnanswered}; questionId=${question.id}; preIdleLogCursor=${preIdleCursor.fromByte}; pending=${pendingDetail}; heartbeat=${heartbeat?.summary ?? 'missing-target-evidence'}; error=${idleError}`
      );
    }
    if (!pendingObservedAtIdleBoundary) {
      throw new Error(
        `INCONCLUSIVE: question ${question.id} was not positively observed pending at the idle boundary (${pendingDetail}); heartbeat=${heartbeat?.summary ?? 'missing-target-evidence'}`
      );
    }
    if (!questionUnanswered) {
      throw new Error(
        `question ${question.id} received an answer before idle shutdown; heartbeat=${heartbeat?.summary ?? 'missing-target-evidence'}`
      );
    }
    if (!heartbeat) {
      throw new Error(
        `INCONCLUSIVE: no heartbeat with exact kiloSessionId=${session.kiloSessionId} on the captured connection ${connectionSummary(connection)}`
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
        `questionPendingAtIdle=true (${pendingDetail})`,
        `questionMessage=${sent.messageId}`,
        `idleStopObserved=true`,
        `idleLogCursor=${idleLogCursor ?? 'none'}`,
        `oldContainer=${oldContainerId}`,
        `newContainer=${resumed.container.id}`,
        `postIdleMessage=${postIdle.messageId}`,
        `siblingIsolation=not-claimed`,
        `heartbeat(${heartbeat.summary})`,
      ].join('; ')
    );
  } catch (error) {
    result = scenarioResult('question-idle-resume', args, startedAt, resources.events, false, errorMessage(error));
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
 */
async function measureReadToolOutput(
  resources: ScenarioResources,
  kiloSessionId: string,
  tag: string,
  stream: StreamConnection
): Promise<ReadMeasurement> {
  const expectedCallID = toolCallId(tag, 'read');
  const streamCorrelated = streamedReadParts(stream, expectedCallID).some(
    part => part.state.status === 'completed'
  );
  try {
    const client = createKiloClient({
      baseUrl: `${resources.config.workerUrl.replace(/\/$/, '')}/kilo`,
      headers: {
        Authorization: `Bearer ${mintApiToken(resources.config.user, resources.config.nextAuthSecret)}`,
      },
    });
    const result = await client.session.messages({ sessionID: kiloSessionId, limit: 100 });
    if (result.error !== undefined || result.data === undefined) {
      return {
        source: `transcript-error:${result.response?.status ?? 'unknown'}`,
        streamCorrelated,
      };
    }
    const entries = result.data as Array<{ parts: Part[] }>;
    for (const entry of entries) {
      for (const part of entry.parts) {
        if (part.type !== 'tool') continue;
        if (part.tool !== 'read') continue;
        if (part.state.status !== 'completed') continue;
        if (part.callID !== expectedCallID) continue;
        return {
          bytes: Buffer.byteLength(part.state.output, 'utf8'),
          source: streamCorrelated
            ? 'transcript-matched+stream-correlated'
            : 'transcript-matched-stream-uncorrelated',
          callID: part.callID,
          streamCorrelated,
        };
      }
    }
    return { source: 'transcript-no-matching-completed-read-part', streamCorrelated };
  } catch (error) {
    return { source: `transcript-threw:${errorMessage(error)}`, streamCorrelated };
  }
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
  try {
    assertScenarioPreconditions(args.config, args.api);
    const runId = randomUUID();
    const { session, runtime } = await bootSession(resources, {
      runId,
      operation: createScenarioOperation('continuity-large-stream'),
    });
    const tag = `large-stream-${runId}`;
    const streamTurn = await sendAndAwaitCompletion(
      resources,
      session,
      fakeDirective('tool-stream', tag, String(LARGE_STREAM_BYTES)),
      'tool-stream',
      remainingMs(resources, 'tool-stream turn')
    );
    const status = await resources.within('tool-stream status', () =>
      fetchFakeScenarioStatus(resources.config.fakeLlmUrl, tag)
    );
    const readSucceeded = status.toolResults.read >= 1 && status.toolCalls.read >= 1;
    const stream = await resources.connect(session.cloudAgentSessionId, false);
    const measured = await measureReadToolOutput(resources, session.kiloSessionId, tag, stream);
    const file = await resources.within('tool-stream file', () =>
      inspectControlPlaneWorkspaceFile(runtime, {
        kiloSessionId: session.kiloSessionId,
        filePath: `tool-stream-${tag}.txt`,
      })
    );
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
      measured.bytes >= LARGE_STREAM_BYTES;
    const detail = [
      `session=${session.cloudAgentSessionId}`,
      `requestedBytes=${LARGE_STREAM_BYTES}`,
      `observedBytes=${measured.bytes ?? 'unmeasured'}`,
      `measurementSource=${measured.source}`,
      `readCallId=${measured.callID ?? 'none'}`,
      `streamCorrelated=${measured.streamCorrelated}`,
      `writtenFileBytes=${fileBytes}`,
      `readSucceeded=${readSucceeded}`,
      `toolStreamMessage=${streamTurn.messageId}`,
      `followUpMessage=${followup.messageId}`,
      `largeStreamCoverage=${largeStreamCoverage}`,
      largeStreamCoverage
        ? 'coverage=verified'
        : 'coverage=not-claimed (truncation, unmatched call, or unmeasured)',
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
    result = scenarioResult('large-stream', args, startedAt, resources.events, false, errorMessage(error));
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
    for (let index = 0; index < 3; index++) {
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
    const snapshots = await Promise.all(
      active.map(entry => getSessionSnapshot(resources.config, entry.session.cloudAgentSessionId))
    );
    const overlap = snapshots.map(snapshot => snapshot.execution?.status ?? 'none').join(',');
    if (!snapshots.every(snapshot => snapshot.execution?.status === 'running')) {
      throw new Error(`three-way overlap not proven; execution statuses=${overlap}`);
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
    const inconclusive = classified.filter(
      item => item.classification === 'inconclusive'
    ).length;
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
        `sessions=3`,
        `overlap=${overlap}`,
        `windowLogCursor=${windowCursor.fromByte}`,
        `clean=${clean}`,
        `recovered=${recovered}`,
        `inconclusive=${inconclusive}`,
        `failed=${failed}`,
        `split=clean-load:${clean}/recovered-under-load:${recovered}`,
        summary,
      ].join('; ')
    );
  } catch (error) {
    result = scenarioResult('concurrent-chats', args, startedAt, resources.events, false, errorMessage(error));
  } finally {
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
};
