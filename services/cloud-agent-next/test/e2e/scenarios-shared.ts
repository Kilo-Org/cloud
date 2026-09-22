/**
 * One implementation per shared scenario, run under both the `local` and
 * `deployed` profiles.
 *
 * These run against a Worker over tRPC + WebSocket only. They never shell out
 * to Docker and never read session ownership rows directly: local container
 * identity is observed through the injected `SandboxObservation` capability.
 * A deployed environment has no sandbox capability, so its warm-reuse evidence
 * is the absence of a `preparing` event plus the correlated cold child text,
 * not physical container identity.
 *
 * `LifecycleArgs` / `LifecycleResult` are imported type-only so this module
 * does not pull in `./lifecycle.js`, which imports the Docker helpers in
 * `./sandbox-control.js` and `@kilocode/db`. Runtime helpers come from
 * `./client.js`.
 */

import jwt from 'jsonwebtoken';
import {
  collectUntilTerminal,
  deleteSession,
  fakeDirective,
  fetchFakeRequests,
  hasPreparationForMessage,
  interruptSession,
  isMessageCompleted,
  openConnectedStream,
  sendMessage,
  startSession,
  type ApiVersion,
  type DriverConfig,
  type SendMessageResult,
  type StartSessionResult,
  type StreamConnection,
  type StreamEvent,
} from './client.js';
import { resolveFakeAdminToken } from './fake-llm-admin.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';
import type { CapabilityName, ScenarioEnvironment } from './scenario-capabilities.js';
import { FAILURE_SHARED_SCENARIOS } from './scenarios-shared-failures.js';
import { CALLBACK_SHARED_SCENARIOS } from './scenarios-shared-callbacks.js';
import { STREAMING_SHARED_SCENARIOS } from './scenarios-shared-streaming.js';
import { CONTINUITY_SHARED_SCENARIOS } from './scenarios-shared-continuity.js';
import { MICRO_SHARED_SCENARIOS } from './scenarios-shared-micro.js';
import { QUEUE_SHARED_SCENARIOS } from './scenarios-shared-queue.js';
import { WORKTREE_SHARED_SCENARIOS } from './scenarios-shared-worktrees.js';
import { CONVERSATION_SHARED_SCENARIOS } from './scenarios-shared-conversations.js';
import { LOAD_SHARED_SCENARIOS } from './scenarios-shared-load.js';
import { FAULT_SHARED_SCENARIOS } from './scenarios-shared-faults.js';

/** Generous default per-turn budget for a real first container cold start. */
const DEFAULT_TURN_TIMEOUT_MS = 240_000;
/** Bound for each cleanup tRPC request so a wedged cleanup cannot hang the run. */
const CLEANUP_TIMEOUT_MS = 15_000;
/** Bound for each direct HTTPS auth probe in `auth-reject`. */
const AUTH_PROBE_TIMEOUT_MS = 15_000;
/** Wrong secret for the bad-signature probe; never the deployed `NEXTAUTH_SECRET`. */
const BAD_SIGNATURE_SECRET = 'wrong-secret-auth-reject';

const HOT_DIRECTIVES = ['echo:hot', 'slow:3:50', 'echo:followup'] as const;

export type SharedScenario = {
  name: string;
  requires: readonly CapabilityName[];
  defaultConversation: string;
  defaultTimeoutMs?: number;
  /** API surface the scenario must use; callers default to `unified`. */
  defaultApi?: ApiVersion;
  /**
   * Worktree-creation enrollment only: the local e2e user must be in
   * `CONTROL_PLANE_IDS` and `WORKTREE_CREATION_ENABLED_IDS`. This is not a
   * capability and must not gate a scenario's execution.
   */
  requiresWorktreeCreation?: boolean;
  run(args: LifecycleArgs, env: ScenarioEnvironment): Promise<LifecycleResult>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Join the newest text snapshot of each **content** text part belonging to a
 * direct **assistant** child message of `parentMessageId`. A part carrying the
 * product's transient marker (`metadata["kilocode.lifecycle"] === "transient"`)
 * is CLI progress, not content, and contributes nothing even when its
 * end-of-turn removal event is missing because cleanup failed. Parts are
 * selected by `part.messageID`; the parent and the role are looked up on the
 * message info, because `parentID` is a message property, not a part property.
 * Unknown event shapes are ignored.
 *
 * Removal events mirror the replay consumer
 * (`src/session/queries/events.ts`): `message.part.removed` drops the tracked
 * part and `message.removed` drops the tracked child message, so replayed
 * content the replay explicitly removed no longer contributes. Deletion is by
 * the event's own key, so removing something untracked is a no-op, and a part
 * removed and then re-updated contributes again.
 */
export function collectChildMessageText(events: StreamEvent[], parentMessageId: string): string {
  const childMessageIds = new Set<string>();
  const textParts = new Map<string, { messageID: unknown; text: string }>();

  for (const event of events) {
    if (event.streamEventType !== 'kilocode') continue;
    const data = asRecord(event.data);
    if (!data) continue;
    const name = typeof data.type === 'string' ? data.type : data.event;
    const properties = asRecord(data.properties);
    if (!properties) continue;

    if (name === 'message.updated') {
      const info = asRecord(properties.info);
      if (!info || info.role !== 'assistant' || info.parentID !== parentMessageId) continue;
      if (typeof info.id === 'string' && info.id.length > 0) childMessageIds.add(info.id);
      continue;
    }

    if (name === 'message.part.updated') {
      const part = asRecord(properties.part);
      if (!part || part.type !== 'text') continue;
      if (typeof part.id !== 'string' || part.id.length === 0) continue;
      const metadata = asRecord(part.metadata);
      if (metadata?.['kilocode.lifecycle'] === 'transient') continue;
      // Latest snapshot per part id wins; Map preserves first-insertion order.
      textParts.set(part.id, {
        messageID: part.messageID,
        text: typeof part.text === 'string' ? part.text : '',
      });
      continue;
    }

    if (name === 'message.part.removed') {
      if (typeof properties.partID === 'string') textParts.delete(properties.partID);
      continue;
    }

    if (name === 'message.removed') {
      if (typeof properties.messageID === 'string') childMessageIds.delete(properties.messageID);
    }
  }

  let text = '';
  for (const part of textParts.values()) {
    if (typeof part.messageID === 'string' && childMessageIds.has(part.messageID)) {
      text += part.text;
    }
  }
  return text;
}

type CorrelatedProgressStats = {
  /** Assistant child ids established as children of the parent. */
  children: number;
  /** `message.part.updated` events seen for any message. */
  parts: number;
  /** Part updates whose `part.messageID` is one of the children. */
  correlated: number;
  /** Correlated parts of `type: "text"`. */
  text: number;
  /** Correlated text parts with `text.length > 0`. */
  nonEmptyText: number;
  /** Longest correlated text seen, for diagnostics. */
  maxTextLength: number;
};

/**
 * Collect what a stream shows for direct assistant children of
 * `parentMessageId`. Child ids are collected from the whole event list first, so
 * a part emitted before its `message.updated` still counts. Shared by
 * `hasCorrelatedStreamProgress` and `correlatedProgressSummary` so the pass
 * rule and its diagnosis cannot drift.
 */
function collectCorrelatedProgress(
  events: readonly StreamEvent[],
  parentMessageId: string
): CorrelatedProgressStats {
  const childMessageIds = new Set<string>();
  for (const event of events) {
    if (event.streamEventType !== 'kilocode') continue;
    const data = asRecord(event.data);
    if (!data) continue;
    const name = typeof data.type === 'string' ? data.type : data.event;
    if (name !== 'message.updated') continue;
    const info = asRecord(asRecord(data.properties)?.info);
    if (!info || info.role !== 'assistant' || info.parentID !== parentMessageId) continue;
    if (typeof info.id === 'string' && info.id.length > 0) childMessageIds.add(info.id);
  }

  const stats: CorrelatedProgressStats = {
    children: childMessageIds.size,
    parts: 0,
    correlated: 0,
    text: 0,
    nonEmptyText: 0,
    maxTextLength: 0,
  };
  for (const event of events) {
    if (event.streamEventType !== 'kilocode') continue;
    const data = asRecord(event.data);
    if (!data) continue;
    const name = typeof data.type === 'string' ? data.type : data.event;
    if (name !== 'message.part.updated') continue;
    stats.parts += 1;
    const part = asRecord(asRecord(data.properties)?.part);
    if (!part || typeof part.messageID !== 'string' || !childMessageIds.has(part.messageID)) {
      continue;
    }
    stats.correlated += 1;
    if (part.type !== 'text') continue;
    stats.text += 1;
    const length = typeof part.text === 'string' ? part.text.length : 0;
    if (length > stats.maxTextLength) stats.maxTextLength = length;
    if (length > 0) stats.nonEmptyText += 1;
  }
  return stats;
}

/**
 * True when the stream shows any message-correlated part for a direct assistant
 * child of `parentMessageId`: a `message.updated` with `role: "assistant"` and
 * `parentID === parentMessageId` establishes the child id, and any
 * `message.part.updated` whose `part.messageID` is that child counts, transient
 * streaming parts included (unlike `collectChildMessageText`, which excludes
 * them as progress rather than content). Child ids are collected from the whole
 * list first, so a part emitted before its `message.updated` still counts.
 *
 * This is a liveness signal for the turn's own stream, not proof the model was
 * dialed: the Kilo CLI's transient initialization part is correlated but empty,
 * and for a paced response the streamed content can take longer than the wait
 * budget to appear. A caller that needs "the model request started" must gate
 * on an observed request (see `waitForPacedProgress`). Unrelated message ids and
 * lifecycle-only events do not count, and a stream with no correlated child is
 * false.
 */
export function hasCorrelatedStreamProgress(
  events: readonly StreamEvent[],
  parentMessageId: string
): boolean {
  return collectCorrelatedProgress(events, parentMessageId).correlated > 0;
}

/**
 * Compact diagnosis of a failed `hasCorrelatedStreamProgress` wait: how many
 * child ids were established and how many part updates correlated to them, so a
 * timeout distinguishes "no events for this turn" from "events but no
 * non-empty text". Reporting only.
 */
export function correlatedProgressSummary(
  events: readonly StreamEvent[],
  parentMessageId: string
): string {
  const stats = collectCorrelatedProgress(events, parentMessageId);
  return (
    `children=${stats.children} parts=${stats.parts} correlated=${stats.correlated} ` +
    `text=${stats.text} nonEmptyText=${stats.nonEmptyText} maxTextLength=${stats.maxTextLength}`
  );
}

/**
 * Return the last non-empty line of `text`, trimmed, or `''` when every line is
 * empty. Reporting only: it names the observed tail in diagnostics and is never
 * the pass/fail rule (`echoPayloadMatches` decides that). The CLI draws its
 * spinner with ANSI cursor control rather than line breaks, so the status text
 * and the answer can share one line and no line split separates them. Splitting
 * treats CRLF as one separator so it does not manufacture an empty line between
 * `\r` and `\n`; nothing else is stripped or rewritten.
 */
export function trailingNonEmptyLine(text: string): string {
  let tail = '';
  for (const line of text.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) tail = trimmed;
  }
  return tail;
}

/**
 * Return the token for exactly the literal harness form `echo:<token>`, where
 * `<token>` is a non-empty `[A-Za-z0-9_-]+` and nothing follows it; `null` for
 * every other directive (the cold content assertion runs only for this form).
 */
export function echoDirectivePayload(directive: string): string | null {
  const match = /^echo:([A-Za-z0-9_-]+)$/.exec(directive);
  return match?.[1] ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The pass/fail rule for an echoed answer: `payload` must end `observedText`,
 * preceded by the start of the string or a character outside the payload
 * character class `[A-Za-z0-9_-]`. The CLI draws its spinner with ANSI cursor
 * control instead of `\r`/`\n`, so status text and answer share one line and no
 * line split separates them; a bare substring match would also pass on text
 * that never ended with the answer.
 */
export function echoPayloadMatches(observedText: string, payload: string): boolean {
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${escapeRegExp(payload)}$`).test(observedText);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run one hot turn: open a replay-disabled stream first, send the message, then
 * collect until the message reaches its terminal event. Returns the first
 * `kilocode` event latency so the summary matches the `cold-hot` shape.
 */
async function runHotTurn(
  config: DriverConfig,
  sessionId: string,
  directive: string,
  api: 'unified' | 'legacy',
  timeoutMs: number
): Promise<{
  sent: SendMessageResult;
  terminal: StreamEvent | null;
  events: StreamEvent[];
  firstKilocodeLatencyMs: number | null;
}> {
  const stream = await openConnectedStream(config, sessionId, false);
  try {
    const sent = await sendMessage(
      config,
      { cloudAgentSessionId: sessionId, prompt: fakeDirective(directive) },
      api
    );
    const kilocodeStart = Date.now();
    const firstKilocode = await stream.waitFor(
      event => event.streamEventType === 'kilocode',
      10_000
    );
    const firstKilocodeLatencyMs = firstKilocode ? Date.now() - kilocodeStart : null;
    const collected = await collectUntilTerminal(stream, sent.messageId, timeoutMs);
    return {
      sent,
      terminal: collected.terminal,
      events: collected.events,
      firstKilocodeLatencyMs,
    };
  } finally {
    stream.close();
  }
}

/**
 * Cleanup for one started session. Both requests are attempted independently
 * and each is bounded; a failure is reported but never thrown. `label` names
 * the caller in the diagnostic. Callers that no longer hold the `kiloSessionId`
 * (the matrix runner backstop) pass `sessionId` alone.
 */
export async function cleanupRemoteSession(
  config: DriverConfig,
  sessionId: string,
  label: string,
  kiloSessionId?: string
): Promise<void> {
  const failures: string[] = [];
  try {
    await interruptSession(config, sessionId, AbortSignal.timeout(CLEANUP_TIMEOUT_MS));
  } catch (error) {
    failures.push(`interruptSession: ${errorMessage(error)}`);
  }
  try {
    await deleteSession(config, sessionId, AbortSignal.timeout(CLEANUP_TIMEOUT_MS));
  } catch (error) {
    failures.push(`deleteSession: ${errorMessage(error)}`);
  }
  for (const failure of failures) {
    console.error(
      `${label} cleanup failed (${failure}); workspace=${sessionId}; ses=${kiloSessionId ?? 'unknown'}; ` +
        'one cli_sessions_v2 row for this session is retained and is cleaned up later through the web delete flow ' +
        '(which targets the PRODUCTION Worker, not this one) after e2e cleanup finishes'
    );
  }
}

/**
 * `cold-hot <directive>` (default `echo:hi`).
 *
 * One cold turn followed by three hot turns on the same session. Requires
 * positive cold preparation evidence and per-message hot completion evidence,
 * and rejects any hot-turn `preparing` event as a fresh preparation. When the
 * environment provides container inspection (local), it also proves the cold
 * container persists and no new container appears; a deployed environment has
 * no sandbox capability, so that part is unchecked there.
 */
async function runColdHot(args: LifecycleArgs, env: ScenarioEnvironment): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = DEFAULT_TURN_TIMEOUT_MS, api = 'unified' } = args;
  const coldDirective = conversation && conversation !== '_' ? conversation : 'echo:hi';
  const sandbox = env.sandbox;
  const events: StreamEvent[] = [];
  let session: StartSessionResult | undefined;
  let coldStream: StreamConnection | undefined;

  const fail = (message: string): LifecycleResult => ({
    name: 'cold-hot',
    conversation,
    ok: false,
    message,
    events: [...events],
    durationMs: Date.now() - startedAt,
  });

  try {
    const knownSandboxIds = sandbox ? await sandbox.snapshotContainerIds() : new Set<string>();
    session = await startSession(config, { prompt: fakeDirective(coldDirective) }, api);
    if (env.requireControlPlaneSession && !session.cloudAgentSessionId.startsWith('workspace_')) {
      return fail(
        `cold turn: expected a control-plane workspace_* session, got ${session.cloudAgentSessionId}; ` +
          'enroll the driver owner in the deployed Worker CONTROL_PLANE_IDS'
      );
    }

    coldStream = await openConnectedStream(config, session.cloudAgentSessionId);

    let coldContainerId: string | null = null;
    if (sandbox) {
      coldContainerId = await sandbox.waitForOwnedContainer({
        cloudAgentSessionId: session.cloudAgentSessionId,
        kiloSessionId: session.kiloSessionId,
        knownIds: knownSandboxIds,
        timeoutMs,
      });
      if (coldContainerId === null) {
        // The cold stream may already have buffered events; a failure here is
        // where its diagnostic matters most.
        events.push(...coldStream.events);
        return fail(
          `cold turn: could not identify an exclusively owned sandbox within ${timeoutMs}ms`
        );
      }
    }

    const coldResult = await collectUntilTerminal(coldStream, session.messageId, timeoutMs);
    events.push(...coldResult.events);
    coldStream.close();
    coldStream = undefined;

    const coldTerminalType = coldResult.terminal?.streamEventType ?? 'none';
    if (!isMessageCompleted(coldResult.terminal, session.messageId)) {
      return fail(
        `cold turn: expected complete terminal for ${session.messageId}, got ${coldTerminalType}`
      );
    }
    if (!hasPreparationForMessage(coldResult.events, session.messageId)) {
      return fail(
        `cold turn: no preparing event carried triggerMessageId=${session.messageId}; positive cold preparation evidence is required`
      );
    }

    const expectedColdText = echoDirectivePayload(coldDirective);
    let coldContentMarker: string;
    if (expectedColdText === null) {
      coldContentMarker = 'cold-content=skipped(not-echo:<token>)';
    } else {
      const observedColdText = collectChildMessageText(coldResult.events, session.messageId);
      const observedTail = trailingNonEmptyLine(observedColdText);
      if (!echoPayloadMatches(observedColdText, expectedColdText)) {
        return fail(
          `cold turn: expected correlated child text ${JSON.stringify(expectedColdText)} but observed ` +
            `${JSON.stringify(observedColdText)}; observed tail ${JSON.stringify(observedTail)} for ${session.messageId}`
        );
      }
      coldContentMarker = `cold-content=${JSON.stringify(observedTail)}`;
    }

    const hotSummaries: string[] = [];
    for (const directive of HOT_DIRECTIVES) {
      const before = sandbox ? await sandbox.snapshotContainerIds() : undefined;
      const hot = await runHotTurn(config, session.cloudAgentSessionId, directive, api, timeoutMs);
      events.push(...hot.events);

      const hotTerminalType = hot.terminal?.streamEventType ?? 'none';
      if (!isMessageCompleted(hot.terminal, hot.sent.messageId)) {
        return fail(
          `${directive}: expected message completion for ${hot.sent.messageId}, got ${hotTerminalType}`
        );
      }
      if (hasPreparationForMessage(hot.events, hot.sent.messageId)) {
        return fail(
          `${directive}: unexpected preparing event with triggerMessageId=${hot.sent.messageId}; a hot turn must reuse the warm dispatch path`
        );
      }
      if (sandbox && before !== undefined && coldContainerId !== null) {
        const after = await sandbox.snapshotContainerIds();
        const sameContainers = after.has(coldContainerId) && [...after].every(id => before.has(id));
        if (!sameContainers) {
          return fail(
            `${directive}: sandbox identity changed; expected ${coldContainerId} to persist with no new container ` +
              `(before=${[...before].join(',')}, after=${[...after].join(',')})`
          );
        }
      }

      hotSummaries.push(
        `${directive}:complete/${hot.firstKilocodeLatencyMs === null ? 'no-kilocode' : `${hot.firstKilocodeLatencyMs}ms`}`
      );
    }

    const identityMarker = sandbox
      ? `cold-sandbox=${coldContainerId}`
      : 'identity=unchecked(no-sandbox-capability); caveat=this proves the warm dispatch path, not physical container identity';
    return {
      name: 'cold-hot',
      conversation,
      ok: true,
      message:
        `session=${session.cloudAgentSessionId}; cold=complete; ${coldContentMarker}; hot=${hotSummaries.join(', ')}; ` +
        identityMarker,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    // Include buffered cold events when the throw happened before the cold
    // collection was folded into `events`; `coldStream` is cleared once it is.
    if (coldStream) events.push(...coldStream.events);
    return fail(`threw: ${errorMessage(error)}`);
  } finally {
    try {
      coldStream?.close();
    } catch {
      // A close failure must not replace the scenario result.
    }
    if (session)
      await cleanupRemoteSession(
        config,
        session.cloudAgentSessionId,
        'cold-hot',
        session.kiloSessionId
      );
  }
}

/**
 * `unknown-model`: a model the fake validation route rejects must fail closed
 * at admission, with no prompt dispatched and no stream opened. When the
 * environment provides container inspection (local), it also confirms on a
 * delay that no sandbox appeared.
 */
async function runUnknownModel(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, api = 'unified' } = args;
  const sandbox = env.sandbox;

  const fail = (message: string): LifecycleResult => ({
    name: 'unknown-model',
    conversation,
    ok: false,
    message,
    events: [],
    durationMs: Date.now() - startedAt,
  });

  try {
    const knownSandboxIds = sandbox ? await sandbox.snapshotContainerIds() : undefined;
    const before = await fetchFakeRequests(config.fakeLlmUrl);
    const outcome = await startSession(
      { ...config, model: 'kilo/does-not-exist' },
      { prompt: fakeDirective('echo:ignored') },
      api
    ).then(
      (session: StartSessionResult) => ({ rejected: false as const, session }),
      (error: unknown) => ({ rejected: true as const, error })
    );

    if (!outcome.rejected) {
      await cleanupRemoteSession(
        config,
        outcome.session.cloudAgentSessionId,
        'unknown-model',
        outcome.session.kiloSessionId
      );
      return fail('start accepted kilo/does-not-exist; expected fail-closed admission');
    }
    const message = errorMessage(outcome.error);
    if (!/Selected model is not available/i.test(message)) {
      return fail(`start rejected with an unexpected error: ${message}`);
    }

    if (sandbox && knownSandboxIds !== undefined) {
      const created = await sandbox.waitForNewContainer(knownSandboxIds, 2_000);
      if (created !== null) {
        return fail(
          `a sandbox container ${created} was created despite the rejected start; expected no sandbox`
        );
      }
    }

    const after = await fetchFakeRequests(config.fakeLlmUrl);
    if (after.chatCompletions !== before.chatCompletions) {
      return fail(
        `fake received ${after.chatCompletions - before.chatCompletions} new chatCompletions during a rejected start ` +
          `(before=${before.chatCompletions}, after=${after.chatCompletions})`
      );
    }

    return {
      name: 'unknown-model',
      conversation,
      ok: true,
      message: `start rejected with "${message}"; fake chatCompletions unchanged at ${before.chatCompletions}`,
      events: [],
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return fail(`threw: ${errorMessage(error)}`);
  }
}

export type AuthProbeMethod = 'GET' | 'POST';

export type AuthProbe = {
  /** Stable identifier used in diagnostics; never contains a credential. */
  name: string;
  url: string;
  method: AuthProbeMethod;
  headers: Record<string, string>;
  /** Statuses that satisfy this probe's claim. */
  expectedStatuses: number[];
};

export type AuthProbeOutcome = { status: number | null; error?: unknown };

const MODEL_ROUTES: ReadonlyArray<{ name: string; method: AuthProbeMethod; path: string }> = [
  { name: 'models', method: 'GET', path: '/api/openrouter/models' },
  { name: 'models-validate', method: 'POST', path: '/api/openrouter/models/validate' },
  { name: 'chat-completions', method: 'POST', path: '/api/openrouter/chat/completions' },
  { name: 'audio-transcriptions', method: 'POST', path: '/api/openrouter/audio/transcriptions' },
];

const CONTROL_TAG = 'auth-reject';
const CONTROL_ROUTES: ReadonlyArray<{ name: string; method: AuthProbeMethod; path: string }> = [
  { name: 'release', method: 'POST', path: `/test/release?tag=${CONTROL_TAG}` },
  { name: 'gate-status', method: 'GET', path: `/test/gate-status?tag=${CONTROL_TAG}` },
  { name: 'waiters', method: 'GET', path: '/test/waiters' },
  { name: 'requests', method: 'GET', path: '/test/requests' },
  { name: 'scenario-status', method: 'GET', path: `/test/scenario-status?tag=${CONTROL_TAG}` },
];

/** A `/test/*` route may answer `2xx`, `400`, or `404` once authorized. */
const CONTROL_AUTHORIZED_STATUSES = [200, 204, 400, 404];

function bearerHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Compose the `auth-reject` probe set. Pure: no network, so every claim is
 * unit-testable; the scenario only sends the requests and classifies them.
 */
export function buildAuthRejectProbes(input: {
  fakeLlmRootUrl: string;
  adminToken: string;
  modelToken: string;
  badSignatureToken: string;
}): AuthProbe[] {
  const root = input.fakeLlmRootUrl.replace(/\/+$/, '');
  const modelPath = `${root}/api/openrouter/models`;
  const probes: AuthProbe[] = [];

  for (const route of MODEL_ROUTES) {
    probes.push({
      name: `model-${route.name}-no-bearer`,
      url: `${root}${route.path}`,
      method: route.method,
      headers: {},
      expectedStatuses: [401],
    });
  }

  probes.push({
    name: 'model-models-malformed-bearer',
    url: modelPath,
    method: 'GET',
    headers: bearerHeader('not-a-jwt'),
    expectedStatuses: [401],
  });
  probes.push({
    name: 'model-models-wrong-signature',
    url: modelPath,
    method: 'GET',
    headers: bearerHeader(input.badSignatureToken),
    expectedStatuses: [401],
  });
  probes.push({
    name: 'model-models-positive-control',
    url: modelPath,
    method: 'GET',
    headers: bearerHeader(input.modelToken),
    expectedStatuses: [200],
  });

  for (const route of CONTROL_ROUTES) {
    probes.push({
      name: `control-${route.name}-no-admin`,
      url: `${root}${route.path}`,
      method: route.method,
      headers: {},
      expectedStatuses: [401],
    });
    probes.push({
      name: `control-${route.name}-admin`,
      url: `${root}${route.path}`,
      method: route.method,
      headers: bearerHeader(input.adminToken),
      expectedStatuses: CONTROL_AUTHORIZED_STATUSES,
    });
  }

  probes.push({
    name: 'crossover-admin-on-models',
    url: modelPath,
    method: 'GET',
    headers: bearerHeader(input.adminToken),
    expectedStatuses: [401],
  });
  probes.push({
    name: 'crossover-model-on-test-requests',
    url: `${root}/test/requests`,
    method: 'GET',
    headers: bearerHeader(input.modelToken),
    expectedStatuses: [401],
  });

  return probes;
}

/**
 * Classify one probe outcome. A transport error or timeout has `status: null`
 * and is a failure, never a silent pass. The detail never contains a credential.
 */
export function classifyAuthProbe(
  probe: AuthProbe,
  outcome: AuthProbeOutcome
): { ok: boolean; detail: string } {
  if (outcome.status === null) {
    return {
      ok: false,
      detail: `${probe.name}: transport error (${errorMessage(outcome.error)})`,
    };
  }
  if (probe.expectedStatuses.includes(outcome.status)) {
    return { ok: true, detail: `${probe.name}: ${outcome.status} as expected` };
  }
  return {
    ok: false,
    detail: `${probe.name}: expected ${probe.expectedStatuses.join('/')}, observed ${outcome.status}`,
  };
}

/**
 * Send one probe with its own deadline, so a hung request cannot stall the
 * probe set. The deadline is a parameter only so a test can observe the abort;
 * the scenario always uses the module bound.
 */
export async function sendAuthProbe(
  probe: AuthProbe,
  timeoutMs: number = AUTH_PROBE_TIMEOUT_MS
): Promise<AuthProbeOutcome> {
  try {
    const response = await fetch(probe.url, {
      method: probe.method,
      headers: probe.headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status };
  } catch (error) {
    return { status: null, error };
  }
}

/**
 * `auth-reject`: the deployed Worker's public auth boundary. Probes the fake
 * Worker directly over HTTPS; starts no session and has no cleanup. It does not
 * prove sandbox credential propagation. Requires the deployed HTTP auth
 * boundary capability, so it is `unsupported` under the local profile.
 */
async function runAuthReject(
  args: LifecycleArgs,
  _env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation } = args;

  const fail = (message: string): LifecycleResult => ({
    name: 'auth-reject',
    conversation,
    ok: false,
    message,
    events: [],
    durationMs: Date.now() - startedAt,
  });

  if (!config.bearerToken) {
    return fail('auth-reject requires config.bearerToken (deployed profile only)');
  }

  try {
    const probes = buildAuthRejectProbes({
      fakeLlmRootUrl: config.fakeLlmUrl,
      adminToken: resolveFakeAdminToken(),
      modelToken: config.bearerToken,
      badSignatureToken: jwt.sign(
        {
          env: 'test',
          kiloUserId: config.user.id,
          apiTokenPepper: 'auth-reject-pepper',
          version: 3,
        },
        BAD_SIGNATURE_SECRET
      ),
    });

    const failures: string[] = [];
    let passed = 0;
    for (const probe of probes) {
      const classified = classifyAuthProbe(probe, await sendAuthProbe(probe));
      if (classified.ok) passed += 1;
      else failures.push(classified.detail);
    }

    if (failures.length > 0) {
      return fail(`${failures.length}/${probes.length} probes failed: ${failures.join('; ')}`);
    }
    return {
      name: 'auth-reject',
      conversation,
      ok: true,
      message:
        `${passed}/${probes.length} auth probes matched: model bearer boundary, /test/* admin guard, ` +
        'positive model control, crossover both ways',
      events: [],
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return fail(`threw: ${errorMessage(error)}`);
  }
}

export const SHARED_SCENARIOS: Record<string, SharedScenario> = {
  ...STREAMING_SHARED_SCENARIOS,
  ...FAILURE_SHARED_SCENARIOS,
  ...CALLBACK_SHARED_SCENARIOS,
  ...MICRO_SHARED_SCENARIOS,
  ...QUEUE_SHARED_SCENARIOS,
  ...CONTINUITY_SHARED_SCENARIOS,
  'cold-hot': {
    name: 'cold-hot',
    requires: [],
    defaultConversation: 'echo:hi',
    defaultTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
    run: runColdHot,
  },
  'unknown-model': {
    name: 'unknown-model',
    requires: [],
    defaultConversation: '_',
    run: runUnknownModel,
  },
  'auth-reject': {
    name: 'auth-reject',
    requires: ['deployedHttpAuthBoundary'],
    defaultConversation: '_',
    run: runAuthReject,
  },
  // The longest realistic flows run last so a short-scenario failure surfaces
  // before a long cold boot is paid.
  ...WORKTREE_SHARED_SCENARIOS,
  ...LOAD_SHARED_SCENARIOS,
  ...CONVERSATION_SHARED_SCENARIOS,
  ...FAULT_SHARED_SCENARIOS,
};
