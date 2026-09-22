/**
 * Public-surface worktree flows shared by the local Docker and HTTP profiles:
 * `worktree-chat` and `worktree-multi-chat`.
 *
 * Physical allocation identity comes from the injected `sessionSandbox`
 * capability, so the same definition works under local Docker and over the e2e
 * HTTP surface; this module never reads Docker, worker logs or `@kilocode/db`.
 * Physical claims that are not expressible on the public surface (one shared
 * container, distinct Kilo processes, on-disk state) are deliberately not
 * asserted.
 */

import { randomUUID } from 'node:crypto';
import {
  answerQuestion,
  createWorktreeChat,
  deleteSession,
  fakeDirective,
  fetchFakeRequests,
  fetchFakeScenarioStatus,
  getSessionSnapshot,
  hasPreparationForMessage,
  interruptSession,
  isMessageCompleted,
  messageIdFromEvent,
  openConnectedStream,
  prepareBrowserSession,
  sendMessage,
  type DriverConfig,
  type SessionSnapshot,
  type StreamConnection,
  type StreamEvent,
  type WorktreeSessionResult,
} from './client.js';
import {
  cleanupRemoteSession,
  collectChildMessageText,
  echoPayloadMatches,
  type SharedScenario,
} from './scenarios-shared.js';
import { assertReaderCannotDeriveNonce, parseFileReadEcho } from './scenario-assertions.js';
import {
  awaitDurableTerminal,
  createOwnedSessionRegistry,
  createScenarioDeadline,
  foldStream,
  requireRunning,
  sendTurn,
  sessionSandboxObservation,
  trackCreations,
  waitForPacedProgress,
  waitForPresentAllocation,
  type InFlightCreations,
  type ScenarioDeadline,
} from './scenarios-shared-runtime.js';
import {
  assertScenarioPreconditions,
  readWorktreeOwnership,
  requireWorktreeSessionIdentity,
} from './public-surface-support.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';
import type { ScenarioEnvironment } from './scenario-capabilities.js';

const WORKTREE_CHAT_TIMEOUT_MS = 10 * 60_000;
const WORKTREE_MULTI_CHAT_TIMEOUT_MS = 25 * 60_000;
/** Generous budget for a real first container cold start. */
const BOOT_TERMINAL_BUDGET_MS = 240_000;
/**
 * Bound for the first allocation reference of a fresh worktree session. It
 * matches the cold-turn budget: container discovery can be slow while a cold
 * sandbox boots, and a shorter wait is what made the initial read flake.
 */
const CONTAINER_BUDGET_MS = 240_000;
/** Bound for re-reading a present allocation reference on a warm session. */
const HOT_ALLOCATION_BUDGET_MS = 30_000;
/**
 * Bound for the paced-readiness wait: a correlated part on the paced turn's own
 * stream plus a bounded increase in the fake's aggregate `chatCompletions`
 * counter. Generous enough for a slow sandbox to dial the paced turn; the wait
 * still fails hard when neither appears.
 */
const PACED_PROGRESS_BUDGET_MS = 60_000;
/** Explicit bound for creating a sibling chat while the root turn is active. */
const SIBLING_CREATE_BUDGET_MS = 30_000;
/** Window in which a freshly created sibling must issue no model request. */
const LAZINESS_OBSERVATION_MS = 15_000;
/** Short window in which an idempotent sibling replay must issue no model request. */
const REPLAY_OBSERVATION_MS = 5_000;
/** Per-turn budget once the environment is warm. */
const TURN_BUDGET_MS = 120_000;
/** Bounded wait for a create that outlived the scenario deadline. */
const LATE_CREATE_SETTLE_MS = 30_000;
/** Budget for a real file write/read turn. */
const FILE_TURN_BUDGET_MS = 180_000;
/** Budget for the owning stream to show the question. */
const QUESTION_WAIT_BUDGET_MS = 120_000;
/** Budget for the reopened owning stream to replay its still-open question. */
const QUESTION_REPLAY_BUDGET_MS = 30_000;
/** Budget for the answered question turn to complete. */
const QUESTION_TERMINAL_BUDGET_MS = 120_000;
/** Paced hold used to keep the root active across the sibling's control actions. */
const ACTIVE_HOLD_DIRECTIVE = 'slow:60:1000:16';
/** Generous bound for the root's paced hold to complete naturally. */
const ROOT_HOLD_TERMINAL_BUDGET_MS = 120_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Describe a stream wait result without relying on the guard's narrowing. */
function terminalLabel(event: StreamEvent | null): string {
  return event === null ? 'none' : event.streamEventType;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * The owning chat's open question, parsed from its own stream. The session id
 * is the root `ses_*` identity, so a sibling's question never matches.
 */
function questionAsked(
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

/**
 * Require exactly one tool call and one tool result for this fresh op tag, so
 * the fake emitted the call and accepted only this turn's result.
 */
async function assertToolEvidence(
  config: DriverConfig,
  deadline: ScenarioDeadline,
  tag: string,
  kind: 'write' | 'read',
  label: string
): Promise<void> {
  const status = await deadline.within(`${label} status`, signal =>
    fetchFakeScenarioStatus(config.fakeLlmUrl, tag, signal)
  );
  if (status.toolCalls[kind] !== 1 || status.toolResults[kind] !== 1) {
    throw new Error(
      `${label}: expected exactly one ${kind} call and result for ${tag}; ` +
        `toolCalls.${kind}=${status.toolCalls[kind]}; toolResults.${kind}=${status.toolResults[kind]}`
    );
  }
}

/** Run one real file write/read turn and return its collected assistant text. */
async function runFileTurn(
  config: DriverConfig,
  deadline: ScenarioDeadline,
  sessionId: string,
  label: string,
  directive: string
): Promise<{ messageId: string; stream: StreamConnection; text: string }> {
  const turn = await sendTurn(
    deadline,
    config,
    sessionId,
    fakeDirective(directive),
    label,
    FILE_TURN_BUDGET_MS
  );
  const text = collectChildMessageText(turn.stream.events, turn.messageId);
  return { messageId: turn.messageId, stream: turn.stream, text };
}

/**
 * Create (or, with a repeated `operationKey`, replay) a worktree chat.
 *
 * Honest limit: if the create succeeds server-side but the response is lost or
 * the request is aborted, no id is returned and no cleanup is possible from this
 * call. The operation key makes the create idempotent, so a retry with the same
 * key returns the same session; that is the recovery route, not a claim of
 * universal cleanup safety.
 */
async function prepareWorktreeChat(
  creations: InFlightCreations<WorktreeSessionResult>,
  config: DriverConfig,
  input: { prompt: string; operationKey: string }
): Promise<WorktreeSessionResult> {
  return creations.run('prepare worktree session', signal =>
    prepareBrowserSession(
      config,
      { prompt: input.prompt, operationKey: input.operationKey, autoCommit: false },
      signal
    )
  );
}

async function createSiblingChat(
  creations: InFlightCreations<WorktreeSessionResult>,
  config: DriverConfig,
  source: WorktreeSessionResult,
  operationKey: string,
  budgetMs: number
): Promise<WorktreeSessionResult> {
  return creations.run(
    'sibling create',
    signal =>
      createWorktreeChat(
        config,
        {
          sourceKiloSessionId: source.kiloSessionId,
          sourceCloudAgentSessionId: source.cloudAgentSessionId,
          operationKey,
        },
        signal
      ),
    budgetMs
  );
}

/**
 * Assert a chat's own scope id and a null parent. A sibling chat shares the
 * root's worktree id, so it cannot use `verifyWorktreeChat`; this is the part
 * both checks share.
 */
function requireOwnScopeAndNullParent(
  snapshot: SessionSnapshot,
  sessionId: string,
  label: string
): void {
  if (snapshot.cloudAgentSessionScopeId !== sessionId) {
    throw new Error(
      `${label} scope=${snapshot.cloudAgentSessionScopeId ?? 'none'}; expected its own workspace id ${sessionId}`
    );
  }
  if (snapshot.parentSessionId !== null) {
    throw new Error(`${label} parentSessionId=${snapshot.parentSessionId}; expected null`);
  }
}

/**
 * Assert the source worktree chat's identity and return its public snapshot.
 * It requires the worktree id to correspond to the workspace identity
 * (`workspace_<uuid>` -> `worktree_<uuid>`), the session's own scope id and a
 * null parent; `autoCommit=false` is asserted by the caller.
 */
async function verifyWorktreeChat(
  deadline: ScenarioDeadline,
  config: DriverConfig,
  session: WorktreeSessionResult,
  label: string
): Promise<SessionSnapshot> {
  requireWorktreeSessionIdentity(session, label);
  const snapshot = await deadline.within(`${label} snapshot`, signal =>
    getSessionSnapshot(config, session.cloudAgentSessionId, signal)
  );
  const expectedWorktreeId = `worktree_${session.cloudAgentSessionId.replace(/^workspace_/, '')}`;
  const worktreeId = snapshot.worktreeId ?? null;
  if (worktreeId === null) {
    throw new Error(`${label} did not expose a worktree id`);
  }
  if (worktreeId !== expectedWorktreeId) {
    throw new Error(
      `${label} worktreeId=${worktreeId} does not match the workspace identity ${expectedWorktreeId}`
    );
  }
  requireOwnScopeAndNullParent(snapshot, session.cloudAgentSessionId, label);
  return snapshot;
}

/** Every text part of every `kilocode` message.part.updated event, unfiltered. */
function kilocodeTextParts(events: readonly StreamEvent[]): string[] {
  const texts: string[] = [];
  for (const event of events) {
    if (event.streamEventType !== 'kilocode') continue;
    const data = event.data;
    const name = typeof data.type === 'string' ? data.type : data.event;
    if (name !== 'message.part.updated') continue;
    const properties = data.properties as Record<string, unknown> | undefined;
    const part = properties?.part as Record<string, unknown> | undefined;
    if (!part || part.type !== 'text' || typeof part.text !== 'string') continue;
    texts.push(part.text);
  }
  return texts;
}

/**
 * Chat-content isolation: no event in this chat's `cloud.message.*` stream may
 * carry another chat's message id, and no `kilocode` text part (without the
 * `parentID` filter) may contain another chat's marker. This is a content check
 * only; it does not prove physical isolation or that the two chats share one
 * container. The caller must pass each chat's current live events, not a
 * snapshot taken before the other chat's second turn.
 */
function assertChatContentIsolation(
  chatLabel: string,
  chatEvents: readonly StreamEvent[],
  otherMessageIds: readonly string[],
  otherMarkers: readonly string[]
): void {
  const leakedIds = chatEvents
    .filter(event => event.streamEventType.startsWith('cloud.message.'))
    .map(messageIdFromEvent)
    .filter((id): id is string => id !== undefined && otherMessageIds.includes(id));
  if (leakedIds.length > 0) {
    throw new Error(
      `${chatLabel} observed another chat's message ids: ${[...new Set(leakedIds)].join(', ')}`
    );
  }
  for (const text of kilocodeTextParts(chatEvents)) {
    const marker = otherMarkers.find(candidate => text.includes(candidate));
    if (marker !== undefined) {
      throw new Error(
        `${chatLabel} observed another chat's marker ${JSON.stringify(marker)} in a kilocode text part`
      );
    }
  }
}

/**
 * `worktree-chat`: one worktree chat with a cold echo boot turn, an idempotent
 * same-key replay, and one hot turn. It proves worktree identity (worktree id
 * matches the workspace identity, own scope, null parent, `autoCommit=false`),
 * allocation-reference stability across the hot turn, the absence of a reported
 * hot preparation, and correlated hot content.
 */
async function runWorktreeChat(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = WORKTREE_CHAT_TIMEOUT_MS } = args;
  const scenarioName = 'worktree-chat';
  const sandbox = sessionSandboxObservation(env);
  const owned = createOwnedSessionRegistry(config, cleanupRemoteSession);
  const scenarioConfig = owned.config;
  const runId = randomUUID();
  const operationKey = randomUUID();
  const bootMarker = `boot-${runId}`;
  const hotMarker = `hot-${runId}`;
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
  const creations = trackCreations<WorktreeSessionResult>(deadline, owned, scenarioName);
  const events: StreamEvent[] = [];
  let bootStream: StreamConnection | undefined;
  let hotStream: StreamConnection | undefined;
  let result: LifecycleResult;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events: [...events, ...(bootStream?.events ?? []), ...(hotStream?.events ?? [])],
    durationMs: Date.now() - startedAt,
  });

  try {
    assertScenarioPreconditions(scenarioConfig, args.api);

    const session = await prepareWorktreeChat(creations, scenarioConfig, {
      prompt: fakeDirective(`echo:${bootMarker}`),
      operationKey,
    });
    owned.register(session);
    const { cloudAgentSessionId, kiloSessionId } = session;

    const snapshot = await verifyWorktreeChat(deadline, scenarioConfig, session, 'worktree chat');
    if (snapshot.autoCommit !== false) {
      throw new Error(`worktree chat autoCommit=${String(snapshot.autoCommit)}; expected false`);
    }

    const bootMessageId = snapshot.initialMessageId;
    if (!bootMessageId) throw new Error('worktree chat did not expose an initial message id');
    bootStream = await deadline.within('boot stream', signal =>
      openConnectedStream(scenarioConfig, cloudAgentSessionId, true, undefined, signal)
    );
    const bootTerminal = await bootStream.waitForTerminal(
      Math.max(1, Math.min(BOOT_TERMINAL_BUDGET_MS, deadline.remaining('boot terminal'))),
      bootMessageId
    );
    if (!isMessageCompleted(bootTerminal, bootMessageId)) {
      throw new Error(`boot turn ${bootMessageId} did not complete`);
    }
    const bootStatus = await deadline.within('boot durable', signal =>
      awaitDurableTerminal(
        scenarioConfig,
        cloudAgentSessionId,
        bootMessageId,
        deadline.remaining('boot durable'),
        signal
      )
    );
    if (bootStatus !== 'completed') throw new Error(`boot turn durable status=${bootStatus}`);
    const bootText = collectChildMessageText(bootStream.events, bootMessageId);
    if (!echoPayloadMatches(bootText, bootMarker)) {
      throw new Error(
        `boot turn ${bootMessageId} did not complete with ${JSON.stringify(bootMarker)}; observed ${JSON.stringify(bootText)}`
      );
    }
    bootStream = foldStream(events, bootStream);

    // Acquire the boot allocation only after the boot turn completed: the
    // completed turn proves the sandbox is up, so the bounded wait cannot race
    // the cold boot the way a wait started before the turn can.
    const allocationRef = await waitForPresentAllocation(
      deadline,
      sandbox,
      session,
      'boot',
      CONTAINER_BUDGET_MS
    );
    if (allocationRef === null) {
      throw new Error('worktree chat did not expose an allocation reference');
    }

    const replayed = await prepareWorktreeChat(creations, scenarioConfig, {
      prompt: fakeDirective(`echo:${bootMarker}`),
      operationKey,
    });
    owned.register(replayed);
    if (
      replayed.cloudAgentSessionId !== cloudAgentSessionId ||
      replayed.kiloSessionId !== kiloSessionId
    ) {
      throw new Error(
        `same-key prepare returned different identities: ${replayed.cloudAgentSessionId}/${replayed.kiloSessionId}`
      );
    }
    if (replayed.replayed !== true) {
      throw new Error('same-key prepare did not report a replay');
    }

    const before = await waitForPresentAllocation(
      deadline,
      sandbox,
      session,
      'hot before',
      HOT_ALLOCATION_BUDGET_MS
    );
    const hot = await sendTurn(
      deadline,
      scenarioConfig,
      cloudAgentSessionId,
      fakeDirective(`echo:${hotMarker}`),
      'hot turn',
      TURN_BUDGET_MS
    );
    hotStream = hot.stream;
    if (hasPreparationForMessage(hot.stream.events, hot.messageId)) {
      throw new Error(
        `hot turn reported a preparing event for ${hot.messageId}; a hot turn must reuse the warm dispatch path`
      );
    }
    const hotText = collectChildMessageText(hot.stream.events, hot.messageId);
    if (!echoPayloadMatches(hotText, hotMarker)) {
      throw new Error(
        `hot turn ${hot.messageId} did not complete with ${JSON.stringify(hotMarker)}; observed ${JSON.stringify(hotText)}`
      );
    }
    const after = await waitForPresentAllocation(
      deadline,
      sandbox,
      session,
      'hot after',
      HOT_ALLOCATION_BUDGET_MS
    );
    if (after === null || before === null || before !== allocationRef || after !== allocationRef) {
      throw new Error(
        `allocation reference changed on the hot turn: boot=${allocationRef}; before=${before ?? 'none'}; after=${after ?? 'none'}`
      );
    }
    hotStream = foldStream(events, hotStream);

    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message:
        `session=${cloudAgentSessionId}; ses=${kiloSessionId}; worktreeId=${snapshot.worktreeId} ` +
        `(matches workspace identity); scope=self; autoCommit=false; allocationRef=${allocationRef}; ` +
        `initial=${bootMarker}; hot=no-preparing; hotAllocationRef=${after} (read); replay=idempotent`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    for (const stream of [bootStream, hotStream]) {
      try {
        stream?.close();
      } catch {
        /* ignore */
      }
    }
    for (const late of await creations.settleAll(LATE_CREATE_SETTLE_MS)) {
      owned.register(late);
    }
    await owned.cleanup(scenarioName);
  }
  return result;
}

/**
 * `worktree-multi-chat`: one worktree with two chats. Before the sibling create
 * it waits until the paced root turn is underway: correlated-part liveness on
 * that turn's own stream (transient and empty initialization parts permitted)
 * plus a bounded increase in the fake's aggregate `chatCompletions` counter.
 * The counter is not an authoritative paced-request signal: it is attributed to
 * the paced request under the documented assumption that no auxiliary/title
 * request is in flight in that window, and it cannot distinguish the paced
 * primary request from an auxiliary one. A content-based predicate was tried and
 * reverted (see `waitForPacedProgress`). That establishes the turn is live and
 * some request was dialed, not that the paced turn's own prompt was finalized.
 * It then proves the sibling create is lazy (no model request while the root is
 * streaming), does not kill the active root turn, replays idempotently, and that
 * both chats coexist with chat-content isolation. On top of that it asserts the
 * user-visible rules that are expressible on the public surface:
 *
 * - the shared checkout: the root writes an uncommitted file, the sibling reads
 *   it back, the root overwrites it, and a fresh sibling read echoes the second
 *   nonce;
 * - sequential question ownership: a question asked in the root while the
 *   sibling is idle appears only on the root's stream, only the root can answer
 *   it, and reconnecting the root replays the still-open question without a new
 *   model request;
 * - a targeted interrupt of the sibling while the root holds a paced `slow`
 *   turn: the root stays nonterminal and then completes, the sibling's turn
 *   fails `reason=interrupted`, and the root keeps its allocation reference;
 * - a targeted delete of the sibling while the root is active: the sibling's
 *   `getSession` rejects and the root accepts and completes another turn.
 *
 * Honest limit: the worktree runtime services streaming model turns one at a
 * time, so this scenario does not ask a question or start a model turn in the
 * sibling while the root is streaming, and it does not claim two chats have
 * streaming model turns active at one instant. Isolation here is per-chat
 * control/state, not concurrent streaming. No `gate`/`hang` (global parked
 * state) is used: the holds are bounded `slow` turns.
 */
async function runWorktreeMultiChat(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = WORKTREE_MULTI_CHAT_TIMEOUT_MS } = args;
  const scenarioName = 'worktree-multi-chat';
  const sandbox = sessionSandboxObservation(env);
  const owned = createOwnedSessionRegistry(config, cleanupRemoteSession);
  const scenarioConfig = owned.config;
  const runId = randomUUID();
  const rootBootMarker = `root-boot-${runId}`;
  const siblingFirstMarker = `sib-first-${runId}`;
  const rootSecondMarker = `root-second-${runId}`;
  const siblingSecondMarker = `sib-second-${runId}`;
  const rootBootOperationKey = randomUUID();
  const siblingOperationKey = randomUUID();
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
  const creations = trackCreations<WorktreeSessionResult>(deadline, owned, scenarioName);

  let rootBootStream: StreamConnection | undefined;
  let pacedStream: StreamConnection | undefined;
  let siblingFirstStream: StreamConnection | undefined;
  let rootSecondStream: StreamConnection | undefined;
  let siblingSecondStream: StreamConnection | undefined;
  let rootReplayStream: StreamConnection | undefined;
  let siblingReplayStream: StreamConnection | undefined;
  let questionStream: StreamConnection | undefined;
  let siblingWatchStream: StreamConnection | undefined;
  let siblingTurnStream: StreamConnection | undefined;
  let aHoldStream: StreamConnection | undefined;
  const rootEvents: StreamEvent[] = [];
  const siblingEvents: StreamEvent[] = [];
  const rootMessageIds: string[] = [];
  const siblingMessageIds: string[] = [];
  let result: LifecycleResult;

  const rootMarkers = [rootBootMarker, rootSecondMarker];
  const siblingMarkers = [siblingFirstMarker, siblingSecondMarker];

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events: [...rootEvents, ...siblingEvents],
    durationMs: Date.now() - startedAt,
  });

  try {
    assertScenarioPreconditions(scenarioConfig, args.api);

    const root = await prepareWorktreeChat(creations, scenarioConfig, {
      prompt: fakeDirective(`echo:${rootBootMarker}`),
      operationKey: rootBootOperationKey,
    });
    owned.register(root);
    const rootSnapshot = await verifyWorktreeChat(
      deadline,
      scenarioConfig,
      root,
      'multi-chat root'
    );
    const rootId = root.cloudAgentSessionId;
    const rootKiloId = root.kiloSessionId;
    const rootBootMessageId = rootSnapshot.initialMessageId;
    if (!rootBootMessageId) throw new Error('multi-chat root did not expose an initial message id');
    rootMessageIds.push(rootBootMessageId);
    rootBootStream = await deadline.within('root boot stream', signal =>
      openConnectedStream(scenarioConfig, rootId, true, undefined, signal)
    );
    const rootBootTerminal = await rootBootStream.waitForTerminal(
      Math.max(1, Math.min(BOOT_TERMINAL_BUDGET_MS, deadline.remaining('root boot terminal'))),
      rootBootMessageId
    );
    if (!isMessageCompleted(rootBootTerminal, rootBootMessageId)) {
      throw new Error(`root boot turn ${rootBootMessageId} did not complete`);
    }
    const rootBootStatus = await deadline.within('root boot durable', signal =>
      awaitDurableTerminal(
        scenarioConfig,
        rootId,
        rootBootMessageId,
        deadline.remaining('root boot durable'),
        signal
      )
    );
    if (rootBootStatus !== 'completed') {
      throw new Error(`root boot turn durable status=${rootBootStatus}`);
    }
    const rootBootText = collectChildMessageText(rootBootStream.events, rootBootMessageId);
    if (!echoPayloadMatches(rootBootText, rootBootMarker)) {
      throw new Error(
        `root boot turn ${rootBootMessageId} did not complete with ${JSON.stringify(rootBootMarker)}; observed ${JSON.stringify(rootBootText)}`
      );
    }
    rootEvents.push(...rootBootStream.events);

    // Acquire the root allocation only after its boot turn completed, so the
    // bounded wait cannot race the cold boot (see `worktree-chat`).
    const rootAllocation = await waitForPresentAllocation(
      deadline,
      sandbox,
      root,
      'root boot',
      CONTAINER_BUDGET_MS
    );
    if (rootAllocation === null) throw new Error('multi-chat root did not expose an allocation');

    pacedStream = await deadline.within('paced stream', signal =>
      openConnectedStream(scenarioConfig, rootId, false, undefined, signal)
    );
    const pacedRequestsBefore = await deadline.within('paced request baseline', () =>
      fetchFakeRequests(scenarioConfig.fakeLlmUrl)
    );
    const paced = await deadline.within(
      'paced send',
      signal =>
        sendMessage(
          scenarioConfig,
          { cloudAgentSessionId: rootId, prompt: fakeDirective('slow:90:1000:32'), signal },
          'unified'
        ),
      TURN_BUDGET_MS
    );
    rootMessageIds.push(paced.messageId);
    // Readiness requires a correlated part on the paced turn's own stream and a
    // bounded increase in the fake's aggregate `chatCompletions` counter,
    // attributed to the paced request under the documented assumption that no
    // auxiliary/title request is in flight in this window. It does not prove the
    // increase was the paced primary request, so the laziness baseline below is
    // only as good as that assumption.
    await waitForPacedProgress(
      scenarioConfig,
      pacedStream,
      paced.messageId,
      pacedRequestsBefore.chatCompletions,
      deadline,
      PACED_PROGRESS_BUDGET_MS,
      'paced root progress'
    );

    const before = await deadline.within('fake requests before', () =>
      fetchFakeRequests(scenarioConfig.fakeLlmUrl)
    );
    await requireRunning(
      scenarioConfig,
      rootId,
      paced.messageId,
      deadline,
      'root before sibling create'
    );

    const sibling = await createSiblingChat(
      creations,
      scenarioConfig,
      root,
      siblingOperationKey,
      SIBLING_CREATE_BUDGET_MS
    );
    owned.register(sibling);
    const siblingId = sibling.cloudAgentSessionId;
    const siblingKiloId = sibling.kiloSessionId;

    requireWorktreeSessionIdentity(sibling, 'sibling chat');
    if (siblingId === rootId || siblingKiloId === rootKiloId) {
      throw new Error(`sibling reused the root identity: ${siblingId}/${siblingKiloId}`);
    }
    await requireRunning(
      scenarioConfig,
      rootId,
      paced.messageId,
      deadline,
      'root immediately after sibling create'
    );

    const siblingSnapshot = await deadline.within('sibling snapshot', signal =>
      getSessionSnapshot(scenarioConfig, siblingId, signal)
    );
    requireOwnScopeAndNullParent(siblingSnapshot, siblingId, 'sibling');
    if (!rootSnapshot.sandboxId) {
      throw new Error('multi-chat root did not expose a durable sandbox id');
    }
    if (siblingSnapshot.sandboxId !== rootSnapshot.sandboxId) {
      throw new Error(
        `sibling and root did not share one sandbox id: ${siblingSnapshot.sandboxId ?? 'none'} vs ${rootSnapshot.sandboxId}`
      );
    }
    const [rootOwnership, siblingOwnership] = await deadline.within('ownership', () =>
      readWorktreeOwnership(scenarioConfig, [rootId, siblingId])
    );
    if (!rootOwnership || !siblingOwnership) {
      throw new Error('multi-chat ownership read did not return both chats');
    }
    if (
      rootOwnership.worktreeId === null ||
      rootOwnership.worktreeId !== siblingOwnership.worktreeId
    ) {
      throw new Error(
        `chats do not share one worktree: root=${rootOwnership.worktreeId ?? 'none'}; sibling=${siblingOwnership.worktreeId ?? 'none'}`
      );
    }
    if (rootOwnership.userId !== siblingOwnership.userId) {
      throw new Error(
        `chats do not share one owner: root=${rootOwnership.userId}; sibling=${siblingOwnership.userId}`
      );
    }
    if (sibling.worktreeId !== rootOwnership.worktreeId) {
      throw new Error(
        `sibling create returned worktreeId=${sibling.worktreeId ?? 'none'}; expected the shared ${rootOwnership.worktreeId}`
      );
    }

    await sleep(LAZINESS_OBSERVATION_MS);
    const after = await deadline.within('fake requests after', () =>
      fetchFakeRequests(scenarioConfig.fakeLlmUrl)
    );
    if (after.chatCompletions !== before.chatCompletions) {
      throw new Error(
        `sibling creation issued a model request: chatCompletions ${before.chatCompletions} -> ${after.chatCompletions} over ${LAZINESS_OBSERVATION_MS}ms`
      );
    }

    const pacedTerminal = await pacedStream.waitForTerminal(
      Math.max(1, Math.min(TURN_BUDGET_MS, deadline.remaining('paced terminal'))),
      paced.messageId
    );
    if (!isMessageCompleted(pacedTerminal, paced.messageId)) {
      throw new Error(
        `paced root turn ${paced.messageId} terminal=${terminalLabel(pacedTerminal)}`
      );
    }
    const pacedStatus = await deadline.within('paced durable', signal =>
      awaitDurableTerminal(
        scenarioConfig,
        rootId,
        paced.messageId,
        deadline.remaining('paced durable'),
        signal
      )
    );
    if (pacedStatus !== 'completed') {
      throw new Error(`paced root turn durable status=${pacedStatus}`);
    }
    rootEvents.push(...pacedStream.events);

    const replayBefore = await deadline.within('replay fake requests before', () =>
      fetchFakeRequests(scenarioConfig.fakeLlmUrl)
    );
    const siblingReplay = await createSiblingChat(
      creations,
      scenarioConfig,
      root,
      siblingOperationKey,
      SIBLING_CREATE_BUDGET_MS
    );
    owned.register(siblingReplay);
    if (
      siblingReplay.cloudAgentSessionId !== siblingId ||
      siblingReplay.kiloSessionId !== siblingKiloId
    ) {
      throw new Error(
        `same-key sibling create returned different identities: ${siblingReplay.cloudAgentSessionId}/${siblingReplay.kiloSessionId}`
      );
    }
    if (siblingReplay.replayed !== true) {
      throw new Error('same-key sibling create did not report a replay');
    }
    await sleep(REPLAY_OBSERVATION_MS);
    const replayAfter = await deadline.within('replay fake requests after', () =>
      fetchFakeRequests(scenarioConfig.fakeLlmUrl)
    );
    if (replayAfter.chatCompletions !== replayBefore.chatCompletions) {
      throw new Error(
        `idempotent sibling replay issued a model request: chatCompletions ${replayBefore.chatCompletions} -> ${replayAfter.chatCompletions}`
      );
    }

    const siblingFirst = await sendTurn(
      deadline,
      scenarioConfig,
      siblingId,
      fakeDirective(`echo:${siblingFirstMarker}`),
      'sibling first turn',
      TURN_BUDGET_MS
    );
    siblingFirstStream = siblingFirst.stream;
    siblingMessageIds.push(siblingFirst.messageId);
    if (!hasPreparationForMessage(siblingFirst.stream.events, siblingFirst.messageId)) {
      throw new Error(
        `sibling first turn ${siblingFirst.messageId} did not report its own preparing event`
      );
    }
    const siblingFirstText = collectChildMessageText(
      siblingFirst.stream.events,
      siblingFirst.messageId
    );
    if (!echoPayloadMatches(siblingFirstText, siblingFirstMarker)) {
      throw new Error(
        `sibling first turn ${siblingFirst.messageId} did not complete with ${JSON.stringify(siblingFirstMarker)}; observed ${JSON.stringify(siblingFirstText)}`
      );
    }
    siblingEvents.push(...siblingFirst.stream.events);

    const rootSecond = await sendTurn(
      deadline,
      scenarioConfig,
      rootId,
      fakeDirective(`echo:${rootSecondMarker}`),
      'root second turn',
      TURN_BUDGET_MS
    );
    rootSecondStream = rootSecond.stream;
    rootMessageIds.push(rootSecond.messageId);
    const rootSecondText = collectChildMessageText(rootSecond.stream.events, rootSecond.messageId);
    if (!echoPayloadMatches(rootSecondText, rootSecondMarker)) {
      throw new Error(
        `root second turn ${rootSecond.messageId} did not complete with ${JSON.stringify(rootSecondMarker)}; observed ${JSON.stringify(rootSecondText)}`
      );
    }
    rootEvents.push(...rootSecond.stream.events);

    const siblingSecond = await sendTurn(
      deadline,
      scenarioConfig,
      siblingId,
      fakeDirective(`echo:${siblingSecondMarker}`),
      'sibling second turn',
      TURN_BUDGET_MS
    );
    siblingSecondStream = siblingSecond.stream;
    siblingMessageIds.push(siblingSecond.messageId);
    const siblingSecondText = collectChildMessageText(
      siblingSecond.stream.events,
      siblingSecond.messageId
    );
    if (!echoPayloadMatches(siblingSecondText, siblingSecondMarker)) {
      throw new Error(
        `sibling second turn ${siblingSecond.messageId} did not complete with ${JSON.stringify(siblingSecondMarker)}; observed ${JSON.stringify(siblingSecondText)}`
      );
    }
    siblingEvents.push(...siblingSecond.stream.events);

    // --- Shared-checkout file proof: A writes an uncommitted file, B reads it.
    // The path and tags are derived from `runId`, but the contents are
    // independent random nonces, so the reader (which only ever sees the path
    // and its own tag) cannot synthesize the expected body.
    const sharedPath = `shared-checkout-${runId}.txt`;
    const firstNonce = `nonce-${randomUUID()}`;
    const secondNonce = `nonce-${randomUUID()}`;
    const readerDerivedBody = (tag: string): string => `nonce-from-${sharedPath}-${tag}`;

    const write1 = await runFileTurn(
      scenarioConfig,
      deadline,
      rootId,
      'root file write one',
      `file:write:wa1-${runId}:${sharedPath}:${firstNonce}`
    );
    try {
      if (!write1.text.includes(`file-write:${sharedPath}`)) {
        throw new Error(`root file write did not report the write marker for ${sharedPath}`);
      }
      await assertToolEvidence(
        scenarioConfig,
        deadline,
        `wa1-${runId}`,
        'write',
        'root file write one'
      );
      rootEvents.push(...write1.stream.events);
      rootMessageIds.push(write1.messageId);
    } finally {
      write1.stream.close();
    }

    const read1 = await runFileTurn(
      scenarioConfig,
      deadline,
      siblingId,
      'sibling file read one',
      `file:read:rb1-${runId}:${sharedPath}`
    );
    try {
      const body = parseFileReadEcho(read1.text, sharedPath);
      assertReaderCannotDeriveNonce({
        body,
        expectedNonce: firstNonce,
        readerVisible: readerDerivedBody(`rb1-${runId}`),
        label: 'sibling read one',
      });
      await assertToolEvidence(
        scenarioConfig,
        deadline,
        `rb1-${runId}`,
        'read',
        'sibling file read one'
      );
      siblingEvents.push(...read1.stream.events);
      siblingMessageIds.push(read1.messageId);
    } finally {
      read1.stream.close();
    }

    const write2 = await runFileTurn(
      scenarioConfig,
      deadline,
      rootId,
      'root file write two',
      `file:write:wa2-${runId}:${sharedPath}:${secondNonce}`
    );
    try {
      if (!write2.text.includes(`file-write:${sharedPath}`)) {
        throw new Error(`root overwrite did not report the write marker for ${sharedPath}`);
      }
      await assertToolEvidence(
        scenarioConfig,
        deadline,
        `wa2-${runId}`,
        'write',
        'root file write two'
      );
      rootEvents.push(...write2.stream.events);
      rootMessageIds.push(write2.messageId);
    } finally {
      write2.stream.close();
    }

    const read2 = await runFileTurn(
      scenarioConfig,
      deadline,
      siblingId,
      'sibling file read two',
      `file:read:rb2-${runId}:${sharedPath}`
    );
    try {
      const body = parseFileReadEcho(read2.text, sharedPath);
      assertReaderCannotDeriveNonce({
        body,
        expectedNonce: secondNonce,
        readerVisible: readerDerivedBody(`rb2-${runId}`),
        label: 'sibling read two (overwrite)',
      });
      await assertToolEvidence(
        scenarioConfig,
        deadline,
        `rb2-${runId}`,
        'read',
        'sibling file read two'
      );
      siblingEvents.push(...read2.stream.events);
      siblingMessageIds.push(read2.messageId);
    } finally {
      read2.stream.close();
    }

    // --- Sequential question ownership: ask in the root while the sibling is
    // idle. The worktree runtime serializes streaming model turns, so asking
    // while the other chat streams would park the question before the wrapper.
    // The sibling stream stays open to prove the root's question never appears
    // on it.
    const questionTag = `q-${runId}`;
    questionStream = await deadline.within('question stream', signal =>
      openConnectedStream(scenarioConfig, rootId, false, undefined, signal)
    );
    siblingWatchStream = await deadline.within('sibling watch stream', signal =>
      openConnectedStream(scenarioConfig, siblingId, false, undefined, signal)
    );
    const questionMessage = await deadline.within(
      'question send',
      signal =>
        sendMessage(
          scenarioConfig,
          {
            cloudAgentSessionId: rootId,
            prompt: fakeDirective(`question:${questionTag}:Approved by the root only`),
            signal,
          },
          'unified'
        ),
      TURN_BUDGET_MS
    );
    rootMessageIds.push(questionMessage.messageId);
    const askedEvent = await questionStream.waitFor(
      event => questionAsked(event, rootKiloId) !== null,
      QUESTION_WAIT_BUDGET_MS
    );
    const asked = askedEvent ? questionAsked(askedEvent, rootKiloId) : null;
    if (!asked) throw new Error(`root question ${questionTag} did not reach its owning stream`);
    if (siblingWatchStream.events.some(event => questionAsked(event, rootKiloId) !== null)) {
      throw new Error('the root question appeared on the sibling stream');
    }
    const questionStatus = await deadline.within('question status', signal =>
      fetchFakeScenarioStatus(scenarioConfig.fakeLlmUrl, questionTag, signal)
    );
    if (questionStatus.toolResults.question !== 0) {
      throw new Error(
        `root question was answered before ownership was asserted (toolResults.question=${questionStatus.toolResults.question})`
      );
    }

    let wrongSiblingRejected = false;
    try {
      const wrong = await deadline.within('wrong owner answer', signal =>
        answerQuestion(scenarioConfig, siblingId, asked.id, [['Continue']], signal)
      );
      wrongSiblingRejected = wrong.success !== true;
    } catch {
      wrongSiblingRejected = true;
    }
    if (!wrongSiblingRejected)
      throw new Error('the sibling was allowed to answer the root question');

    const questionRequestsBefore = await deadline.within('question replay baseline', signal =>
      fetchFakeScenarioStatus(scenarioConfig.fakeLlmUrl, questionTag, signal)
    );
    questionStream.close();
    questionStream = await deadline.within('question replay stream', signal =>
      openConnectedStream(scenarioConfig, rootId, true, undefined, signal)
    );
    const replayed = await questionStream.waitFor(
      event => questionAsked(event, rootKiloId)?.id === asked.id,
      QUESTION_REPLAY_BUDGET_MS
    );
    if (!replayed) {
      throw new Error('the owning root did not replay its still-open question after reconnect');
    }
    const questionRequestsAfter = await deadline.within('question replay after', signal =>
      fetchFakeScenarioStatus(scenarioConfig.fakeLlmUrl, questionTag, signal)
    );
    if (questionRequestsAfter.requests !== questionRequestsBefore.requests) {
      throw new Error('reconnecting the root question started another model request');
    }

    const answer = await deadline.within('answer root question', signal =>
      answerQuestion(scenarioConfig, rootId, asked.id, [['Continue']], signal)
    );
    if (!answer.success) throw new Error('the owning root could not resolve its question');
    const questionTerminal = await questionStream.waitForTerminal(
      Math.max(1, Math.min(QUESTION_TERMINAL_BUDGET_MS, deadline.remaining('question terminal'))),
      questionMessage.messageId
    );
    if (!isMessageCompleted(questionTerminal, questionMessage.messageId)) {
      throw new Error(`answered question turn ${questionMessage.messageId} did not complete`);
    }
    rootEvents.push(...questionStream.events);
    siblingEvents.push(...siblingWatchStream.events);

    // --- Targeted interrupt of the sibling while the root holds a paced slow
    // turn. The sibling turn is accepted but cannot start while the root is
    // streaming, so the interrupt is a control-plane terminalization; the root
    // must stay nonterminal, keep its allocation and then complete.
    const interruptAllocationBefore = await waitForPresentAllocation(
      deadline,
      sandbox,
      root,
      'interrupt before',
      HOT_ALLOCATION_BUDGET_MS
    );
    aHoldStream = await deadline.within('root hold stream', signal =>
      openConnectedStream(scenarioConfig, rootId, false, undefined, signal)
    );
    const aHoldBaseline = await deadline.within('root hold baseline', signal =>
      fetchFakeRequests(scenarioConfig.fakeLlmUrl, signal)
    );
    const aHold = await deadline.within('root hold send', signal =>
      sendMessage(
        scenarioConfig,
        { cloudAgentSessionId: rootId, prompt: fakeDirective(ACTIVE_HOLD_DIRECTIVE), signal },
        'unified'
      )
    );
    rootMessageIds.push(aHold.messageId);
    await waitForPacedProgress(
      scenarioConfig,
      aHoldStream,
      aHold.messageId,
      aHoldBaseline.chatCompletions,
      deadline,
      PACED_PROGRESS_BUDGET_MS,
      'root hold'
    );
    await requireRunning(scenarioConfig, rootId, aHold.messageId, deadline, 'root hold');

    siblingTurnStream = await deadline.within('sibling interrupt stream', signal =>
      openConnectedStream(scenarioConfig, siblingId, false, undefined, signal)
    );
    const siblingTurn = await deadline.within('sibling interrupt send', signal =>
      sendMessage(
        scenarioConfig,
        {
          cloudAgentSessionId: siblingId,
          prompt: fakeDirective(`echo:sibling-interrupted-${runId}`),
          signal,
        },
        'unified'
      )
    );
    siblingMessageIds.push(siblingTurn.messageId);
    const interruption = await deadline.within('interrupt sibling', signal =>
      interruptSession(scenarioConfig, siblingId, signal)
    );
    if (!interruption.success) throw new Error('targeted sibling interruption was not accepted');
    const siblingFailed = await siblingTurnStream.waitFor(
      event =>
        event.streamEventType === 'cloud.message.failed' &&
        messageIdFromEvent(event) === siblingTurn.messageId,
      Math.max(1, Math.min(TURN_BUDGET_MS, deadline.remaining('sibling interrupted terminal')))
    );
    const siblingFailure = siblingFailed?.data as
      | { reason?: string; payload?: { reason?: string } }
      | undefined;
    const siblingReason = siblingFailure?.reason ?? siblingFailure?.payload?.reason;
    if (siblingReason !== 'interrupted') {
      throw new Error(
        `sibling interrupted message terminal reason=${siblingReason ?? 'none'}; expected interrupted`
      );
    }
    siblingEvents.push(...siblingTurnStream.events);
    await requireRunning(
      scenarioConfig,
      rootId,
      aHold.messageId,
      deadline,
      'root during sibling interrupt'
    );
    const aHoldTerminal = await aHoldStream.waitForTerminal(
      Math.max(1, Math.min(ROOT_HOLD_TERMINAL_BUDGET_MS, deadline.remaining('root hold terminal'))),
      aHold.messageId
    );
    if (!isMessageCompleted(aHoldTerminal, aHold.messageId)) {
      throw new Error(`root turn ${aHold.messageId} did not complete after the sibling interrupt`);
    }
    rootEvents.push(...aHoldStream.events);
    const interruptAllocationAfter = await waitForPresentAllocation(
      deadline,
      sandbox,
      root,
      'interrupt after',
      HOT_ALLOCATION_BUDGET_MS
    );
    if (
      interruptAllocationBefore === null ||
      interruptAllocationAfter === null ||
      interruptAllocationBefore !== rootAllocation ||
      interruptAllocationAfter !== rootAllocation
    ) {
      throw new Error(
        `root allocation changed around the sibling interrupt: boot=${rootAllocation}; ` +
          `before=${interruptAllocationBefore ?? 'none'}; after=${interruptAllocationAfter ?? 'none'}`
      );
    }

    rootReplayStream = await deadline.within('root replay stream', signal =>
      openConnectedStream(scenarioConfig, rootId, true, undefined, signal)
    );
    siblingReplayStream = await deadline.within('sibling replay stream', signal =>
      openConnectedStream(scenarioConfig, siblingId, true, undefined, signal)
    );
    assertChatContentIsolation(
      'root chat',
      [...rootEvents, ...rootReplayStream.events],
      siblingMessageIds,
      siblingMarkers
    );
    assertChatContentIsolation(
      'sibling chat',
      [...siblingEvents, ...siblingReplayStream.events],
      rootMessageIds,
      rootMarkers
    );

    // --- Targeted delete of the sibling leaves the root accepting turns.
    aHoldStream?.close();
    aHoldStream = await deadline.within('delete hold stream', signal =>
      openConnectedStream(scenarioConfig, rootId, false, undefined, signal)
    );
    const deleteHoldBaseline = await deadline.within('delete hold baseline', signal =>
      fetchFakeRequests(scenarioConfig.fakeLlmUrl, signal)
    );
    const deleteHold = await deadline.within('delete hold send', signal =>
      sendMessage(
        scenarioConfig,
        { cloudAgentSessionId: rootId, prompt: fakeDirective(ACTIVE_HOLD_DIRECTIVE), signal },
        'unified'
      )
    );
    rootMessageIds.push(deleteHold.messageId);
    await waitForPacedProgress(
      scenarioConfig,
      aHoldStream,
      deleteHold.messageId,
      deleteHoldBaseline.chatCompletions,
      deadline,
      PACED_PROGRESS_BUDGET_MS,
      'delete hold'
    );
    await requireRunning(scenarioConfig, rootId, deleteHold.messageId, deadline, 'delete hold');
    const deleted = await deadline.within('delete sibling', signal =>
      deleteSession(scenarioConfig, siblingId, signal)
    );
    if (!deleted.success) throw new Error('sibling delete returned success: false');
    let deletedRejected = false;
    try {
      await deadline.within('deleted sibling read', signal =>
        getSessionSnapshot(scenarioConfig, siblingId, signal)
      );
    } catch {
      deletedRejected = true;
    }
    if (!deletedRejected) throw new Error('the deleted sibling still returned a session snapshot');
    await requireRunning(
      scenarioConfig,
      rootId,
      deleteHold.messageId,
      deadline,
      'root during sibling delete'
    );
    const deleteHoldTerminal = await aHoldStream.waitForTerminal(
      Math.max(1, Math.min(TURN_BUDGET_MS, deadline.remaining('delete hold terminal'))),
      deleteHold.messageId
    );
    if (!isMessageCompleted(deleteHoldTerminal, deleteHold.messageId)) {
      throw new Error(
        `root turn ${deleteHold.messageId} did not complete after the sibling delete`
      );
    }
    rootEvents.push(...aHoldStream.events);
    const afterDelete = await sendTurn(
      deadline,
      scenarioConfig,
      rootId,
      fakeDirective(`echo:survived-${runId}`),
      'root after delete',
      TURN_BUDGET_MS
    );
    try {
      const afterDeleteText = collectChildMessageText(
        afterDelete.stream.events,
        afterDelete.messageId
      );
      if (!echoPayloadMatches(afterDeleteText, `survived-${runId}`)) {
        throw new Error(
          'the surviving root did not complete another turn after the sibling delete'
        );
      }
      rootEvents.push(...afterDelete.stream.events);
    } finally {
      afterDelete.stream.close();
    }

    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message:
        `root=${rootId}; sibling=${siblingId}; worktree=${rootOwnership.worktreeId}; ` +
        `sandboxId=${rootSnapshot.sandboxId}; scope=distinct; rootNonterminalAfterSiblingCreate=true; ` +
        `lazyChatCompletions=${before.chatCompletions}->${after.chatCompletions} (unchanged over ${LAZINESS_OBSERVATION_MS}ms); ` +
        `replay=idempotent; siblingPreparing=true; ` +
        'interleaved=root-second+sibling-second complete; ' +
        `sharedCheckout=read-echo (first nonce); overwrite=read-echo (second nonce); ` +
        `question=root-owned; questionReplay=replayed-no-request; questionAnswered=owner-only; ` +
        'targetedInterrupt=sibling-interrupted (reason=interrupted); ' +
        'rootStillRunning=true; rootAllocationUnchanged=true; ' +
        'targetedDelete=survivor-completes; ' +
        "chatContentIsolation=true (no other-chat ids or markers in either chat's streams/replay)",
      events: [...rootEvents, ...siblingEvents],
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    for (const stream of [
      rootBootStream,
      pacedStream,
      siblingFirstStream,
      rootSecondStream,
      siblingSecondStream,
      rootReplayStream,
      siblingReplayStream,
      questionStream,
      siblingWatchStream,
      siblingTurnStream,
      aHoldStream,
    ]) {
      try {
        stream?.close();
      } catch {
        /* ignore */
      }
    }
    for (const late of await creations.settleAll(LATE_CREATE_SETTLE_MS)) {
      owned.register(late);
    }
    await owned.cleanup(scenarioName);
  }
  return result;
}

export const WORKTREE_SHARED_SCENARIOS: Record<string, SharedScenario> = {
  'worktree-chat': {
    name: 'worktree-chat',
    requires: ['sessionSandbox'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: WORKTREE_CHAT_TIMEOUT_MS,
    requiresWorktreeCreation: true,
    run: runWorktreeChat,
  },
  'worktree-multi-chat': {
    name: 'worktree-multi-chat',
    requires: ['sessionSandbox'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: WORKTREE_MULTI_CHAT_TIMEOUT_MS,
    requiresWorktreeCreation: true,
    run: runWorktreeMultiChat,
  },
};
