/**
 * Public-surface worktree flows shared by the local Docker and HTTP profiles:
 * `worktree-chat` and `worktree-multi-chat`.
 *
 * Physical allocation identity comes from the injected `sessionSandbox`
 * capability, so the same definition works under local Docker and over the e2e
 * HTTP surface; this module never reads Docker, worker logs or `@kilocode/db`.
 *
 * The local-only `worktree-shared` scenario keeps its physical claims (one
 * shared container, distinct Kilo processes, file-tool state); they are not
 * expressible on the public surface, so they are deliberately not restated here.
 */

import { randomUUID } from 'node:crypto';
import {
  createWorktreeChat,
  fakeDirective,
  fetchFakeRequests,
  getMessageResult,
  getSessionSnapshot,
  hasPreparationForMessage,
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
  correlatedProgressSummary,
  echoPayloadMatches,
  hasCorrelatedStreamProgress,
  type SharedScenario,
} from './scenarios-shared.js';
import {
  awaitDurableTerminal,
  createOwnedSessionRegistry,
  createScenarioDeadline,
  sendTurn,
  sessionSandboxObservation,
  trackCreations,
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
const WORKTREE_MULTI_CHAT_TIMEOUT_MS = 12 * 60_000;
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

/**
 * Wait until the paced turn is underway: the paced turn's own stream shows a
 * message-correlated part (liveness; transient and empty initialization parts
 * permitted), **and** the fake's aggregate `chatCompletions` counter has
 * increased since the paced send. The counter is **not** authoritative: it is
 * attributed to the paced request under the documented assumption that no
 * auxiliary/title request is in flight in that window, so a bounded increase
 * proves "some request was dialed", not that it was the paced primary request.
 *
 * A content-based predicate was tried first and reverted. Requiring a
 * correlated **non-empty text** part looked like a model-served signal, but the
 * Kilo CLI's transient initialization part is correlated and empty, and for a
 * paced response the streamed content can lag the request past the wait budget.
 * Live evidence: one run showed `children=1 parts=9 correlated=2 text=1
 * nonEmptyText=0` while the fake had already served the paced request, so the
 * content predicate never fired and the counter check was never consulted.
 *
 * The wait is a bounded poll: each counter fetch is wrapped in `deadline.within`
 * and each sleep is capped by the remaining wait budget. The correlated-part
 * check reads the in-memory event buffer synchronously, so it cannot observe
 * anything after the loop guard; a counter result observed only after the budget
 * expires is rejected (`Date.now() <= end` before returning).
 */
async function waitForPacedProgress(
  config: DriverConfig,
  stream: StreamConnection,
  parentMessageId: string,
  requestsBefore: number,
  deadline: ScenarioDeadline,
  budgetMs: number,
  label: string
): Promise<void> {
  const budget = Math.min(budgetMs, deadline.remaining(label));
  const end = Date.now() + budget;
  while (Date.now() < end) {
    if (hasCorrelatedStreamProgress(stream.events, parentMessageId)) {
      const current = await deadline.within(
        `${label} poll`,
        () => fetchFakeRequests(config.fakeLlmUrl),
        Math.max(1, end - Date.now())
      );
      if (current.chatCompletions > requestsBefore) {
        if (Date.now() <= end) return;
        break;
      }
    }
    await sleep(Math.min(200, Math.max(0, end - Date.now())));
  }
  throw new Error(
    `${label}: no correlated turn progress and new model request for ${parentMessageId} ` +
      `within ${budget}ms (${correlatedProgressSummary(stream.events, parentMessageId)})`
  );
}

/** Require a message is still queued/running; a terminal here is a regression. */
async function requireNonterminal(
  config: DriverConfig,
  sessionId: string,
  messageId: string,
  deadline: ScenarioDeadline,
  label: string
): Promise<void> {
  const result = await deadline.within(`${label} status`, signal =>
    getMessageResult(config, sessionId, messageId, signal)
  );
  if (result.status !== 'queued' && result.status !== 'running') {
    throw new Error(`${label}: ${messageId} status=${result.status}; expected queued/running`);
  }
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
    events.push(...bootStream.events);

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
    events.push(...hot.stream.events);

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
 * both chats coexist with chat-content isolation. Targeted cancel stays
 * local-only (`worktree-shared`); no gate, `hang` or interrupt is used.
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
    await requireNonterminal(
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
    await requireNonterminal(
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

    rootReplayStream = await deadline.within('root replay stream', signal =>
      openConnectedStream(scenarioConfig, rootId, true, undefined, signal)
    );
    siblingReplayStream = await deadline.within('sibling replay stream', signal =>
      openConnectedStream(scenarioConfig, siblingId, true, undefined, signal)
    );
    assertChatContentIsolation(
      'root chat',
      [
        ...(rootBootStream?.events ?? []),
        ...(pacedStream?.events ?? []),
        ...(rootSecondStream?.events ?? []),
        ...rootReplayStream.events,
      ],
      siblingMessageIds,
      siblingMarkers
    );
    assertChatContentIsolation(
      'sibling chat',
      [
        ...(siblingFirstStream?.events ?? []),
        ...(siblingSecondStream?.events ?? []),
        ...siblingReplayStream.events,
      ],
      rootMessageIds,
      rootMarkers
    );

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
    run: runWorktreeChat,
  },
  'worktree-multi-chat': {
    name: 'worktree-multi-chat',
    requires: ['sessionSandbox'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: WORKTREE_MULTI_CHAT_TIMEOUT_MS,
    run: runWorktreeMultiChat,
  },
};
