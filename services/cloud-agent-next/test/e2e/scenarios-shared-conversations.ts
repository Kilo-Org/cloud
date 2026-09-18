/**
 * Public-surface conversation flows shared by the local Docker and HTTP
 * profiles: `long-conversation` and `leave-and-return`.
 *
 * Physical allocation identity comes from the injected `sessionSandbox`
 * capability, so the same definition works under local Docker and over the e2e
 * HTTP surface; this module never reads Docker, idle-stop logs or `@kilocode/db`.
 */

import { randomUUID } from 'node:crypto';
import {
  fakeDirective,
  hasPreparationForMessage,
  isMessageCompleted,
  openConnectedStream,
  startSession,
  type StartSessionResult,
  type StreamConnection,
  type StreamEvent,
} from './client.js';
import {
  cleanupRemoteSession,
  collectChildMessageText,
  echoDirectivePayload,
  echoPayloadMatches,
  type SharedScenario,
} from './scenarios-shared.js';
import {
  awaitDurableTerminal,
  createOwnedSessionRegistry,
  createScenarioDeadline,
  readAllocation,
  sendTurn,
  sessionSandboxObservation,
  trackCreations,
  waitForPresentAllocation,
} from './scenarios-shared-runtime.js';
import { assertScenarioPreconditions } from './public-surface-support.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';
import type { ScenarioEnvironment } from './scenario-capabilities.js';

const LONG_CONVERSATION_TIMEOUT_MS = 12 * 60_000;
const LEAVE_AND_RETURN_TIMEOUT_MS = 30 * 60_000;
/** Generous budget for a real first container cold start. */
const BOOT_TERMINAL_BUDGET_MS = 240_000;
/**
 * Bound for the boot allocation reference. It matches the cold-turn budget:
 * container discovery can be slow while a cold sandbox boots.
 */
const CONTAINER_BUDGET_MS = 240_000;
/** Bound for re-reading a present allocation reference on a warm session. */
const HOT_ALLOCATION_BUDGET_MS = 30_000;
/** Per-turn budget once the environment is warm. */
const TURN_BUDGET_MS = 120_000;
/** Budget for the resume turn after a replacement allocation. */
const RESUME_TURN_BUDGET_MS = 240_000;
/** The baseline sample is taken well inside the five-minute idle deadline. */
const BASELINE_DELAY_MS = 60_000;
/** Unattended-interval poll cadence. */
const IDLE_POLL_INTERVAL_MS = 15_000;
/**
 * Budget for the unattended interval: idle deadline (~5 min) plus five fast
 * stop-confirmation attempts (~45 s) plus a possible ~30 s native stop, with at
 * most one further native stop per five-minute reconciliation pass.
 */
const IDLE_OBSERVATION_BUDGET_MS = 15 * 60_000;
/** Bound for the replacement allocation after a resume send. */
const RESUME_CONTAINER_BUDGET_MS = 180_000;
/** Bounded wait for a create that outlived the scenario deadline. */
const LATE_CREATE_SETTLE_MS = 30_000;

/**
 * Ten directives after the cold turn. Nine are `echo:<token>` turns (their
 * correlated content is asserted); one is a paced `slow:` turn asserting
 * completion only. Consecutive turns are seconds apart, so the environment
 * cannot idle out mid-conversation.
 */
export const LONG_CONVERSATION_HOT_TURNS = [
  'echo:turn-01',
  'echo:turn-02',
  'echo:turn-03',
  'slow:2:50',
  'echo:turn-05',
  'echo:turn-06',
  'echo:turn-07',
  'echo:turn-08',
  'echo:turn-09',
  'echo:turn-10',
] as const;

export type AllocationSample = 'absent' | 'retained' | 'replaced';

/**
 * Classify one unattended allocation sample against the baseline reference.
 * `null` means the surface reported no provider reference; it is reported as
 * `absent`, never as a release (a `creating` allocation also yields `null`, and
 * the local probe swallows errors into `null` as well).
 */
export function classifyAllocationSample(
  baseline: string,
  observed: string | null
): AllocationSample {
  if (observed === null) return 'absent';
  return observed === baseline ? 'retained' : 'replaced';
}

/**
 * Delay before the baseline sample. The baseline is targeted at the absolute
 * `origin + baselineDelayMs`, so a slow allocation read before it cannot push
 * the sample later.
 */
export function baselineSampleDelayMs(
  origin: number,
  baselineDelayMs: number,
  now: number
): number {
  return Math.max(0, origin + baselineDelayMs - now);
}

/**
 * Delay before the next poll sample, anchored to when the previous sample
 * completed rather than to a fixed grid. A read longer than the interval
 * therefore delays the next sample instead of queueing a catch-up burst.
 */
export function pollSampleDelayMs(
  lastSampleAt: number,
  pollIntervalMs: number,
  now: number
): number {
  return Math.max(0, lastSampleAt + pollIntervalMs - now);
}

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
 * `long-conversation`: one cold `echo:cold` turn followed by ten hot turns on
 * the same session. Every hot turn must reuse the warm dispatch path (no
 * reported preparation), keep the same allocation reference, and — when the
 * directive is `echo:<token>` — produce its correlated content. Measured
 * behaviour, not history restoration.
 */
async function runLongConversation(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = LONG_CONVERSATION_TIMEOUT_MS, api = 'unified' } = args;
  const scenarioName = 'long-conversation';
  const sandbox = sessionSandboxObservation(env);
  const owned = createOwnedSessionRegistry(config, cleanupRemoteSession);
  const scenarioConfig = owned.config;
  const coldDirective = conversation && conversation !== '_' ? conversation : 'echo:cold';
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
  const creations = trackCreations<StartSessionResult>(deadline, owned, scenarioName);
  const events: StreamEvent[] = [];
  let coldStream: StreamConnection | undefined;
  let result: LifecycleResult;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events: [...events, ...(coldStream?.events ?? [])],
    durationMs: Date.now() - startedAt,
  });

  try {
    assertScenarioPreconditions(scenarioConfig, api);
    const inFlightStart = creations.track(
      startSession(scenarioConfig, { prompt: fakeDirective(coldDirective) }, api)
    );
    const session = await deadline.within('start session', () => inFlightStart);
    owned.register(session);
    const sessionId = session.cloudAgentSessionId;
    const handle = { cloudAgentSessionId: sessionId, kiloSessionId: session.kiloSessionId };

    coldStream = await deadline.within('cold stream', signal =>
      openConnectedStream(scenarioConfig, sessionId, true, undefined, signal)
    );
    const coldTerminal = await coldStream.waitForTerminal(
      Math.max(1, Math.min(BOOT_TERMINAL_BUDGET_MS, deadline.remaining('cold terminal'))),
      session.messageId
    );
    if (!isMessageCompleted(coldTerminal, session.messageId)) {
      throw new Error(`cold turn ${session.messageId} terminal=${terminalLabel(coldTerminal)}`);
    }
    const coldStatus = await deadline.within('cold durable', signal =>
      awaitDurableTerminal(
        scenarioConfig,
        sessionId,
        session.messageId,
        deadline.remaining('cold durable'),
        signal
      )
    );
    if (coldStatus !== 'completed') throw new Error(`cold turn durable status=${coldStatus}`);
    if (!hasPreparationForMessage(coldStream.events, session.messageId)) {
      throw new Error(`cold turn ${session.messageId} did not report a preparing event`);
    }
    const coldPayload = echoDirectivePayload(coldDirective);
    if (coldPayload !== null) {
      const coldText = collectChildMessageText(coldStream.events, session.messageId);
      if (!echoPayloadMatches(coldText, coldPayload)) {
        throw new Error(
          `cold turn ${session.messageId} did not complete with ${JSON.stringify(coldPayload)}; observed ${JSON.stringify(coldText)}`
        );
      }
    }
    events.push(...coldStream.events);

    const allocationRef = await waitForPresentAllocation(
      deadline,
      sandbox,
      handle,
      'cold',
      CONTAINER_BUDGET_MS
    );
    if (allocationRef === null) {
      throw new Error('long-conversation session did not expose an allocation reference');
    }

    const hotSummaries: string[] = [];
    for (const [index, directive] of LONG_CONVERSATION_HOT_TURNS.entries()) {
      const label = `hot ${index + 1} ${directive}`;
      const before = await waitForPresentAllocation(
        deadline,
        sandbox,
        handle,
        `${label} before`,
        HOT_ALLOCATION_BUDGET_MS
      );
      const hot = await sendTurn(
        deadline,
        scenarioConfig,
        sessionId,
        fakeDirective(directive),
        label,
        TURN_BUDGET_MS
      );
      try {
        if (hasPreparationForMessage(hot.stream.events, hot.messageId)) {
          throw new Error(
            `${label}: unexpected preparing event with triggerMessageId=${hot.messageId}; a hot turn must reuse the warm dispatch path`
          );
        }
        const payload = echoDirectivePayload(directive);
        if (payload !== null) {
          const text = collectChildMessageText(hot.stream.events, hot.messageId);
          if (!echoPayloadMatches(text, payload)) {
            throw new Error(
              `${label}: expected correlated child text ${JSON.stringify(payload)} but observed ${JSON.stringify(text)}`
            );
          }
        }
        const after = await waitForPresentAllocation(
          deadline,
          sandbox,
          handle,
          `${label} after`,
          HOT_ALLOCATION_BUDGET_MS
        );
        if (
          after === null ||
          before === null ||
          before !== allocationRef ||
          after !== allocationRef
        ) {
          throw new Error(
            `${label}: allocation reference changed; boot=${allocationRef}; before=${before ?? 'none'}; after=${after ?? 'none'}`
          );
        }
        events.push(...hot.stream.events);
        hotSummaries.push(`${directive}:complete`);
      } finally {
        hot.stream.close();
      }
    }

    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message:
        `cold=prepare; hot=${hotSummaries.length}/${LONG_CONVERSATION_HOT_TURNS.length} complete; ` +
        `no-preparing=true; allocationRef stable=${allocationRef} (read each turn)`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    try {
      coldStream?.close();
    } catch {
      /* ignore */
    }
    for (const late of await creations.settleAll(LATE_CREATE_SETTLE_MS)) {
      owned.register(late);
    }
    await owned.cleanup(scenarioName);
  }
  return result;
}

/**
 * `leave-and-return`: boot, complete a boot echo turn, leave the session
 * unattended, and resume it. The unattended phase records each exact sample and
 * its elapsed time and never names a stop cause: it claims only that the
 * allocation reference disappeared while no demand was made. The resume proves
 * a reported preparation, a different non-null provider reference, a completed
 * turn with its correlated marker, and — from a fresh replay stream — replayed
 * transcript preservation of the boot marker. Model-context restoration is not
 * claimed.
 */
async function runLeaveAndReturn(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = LEAVE_AND_RETURN_TIMEOUT_MS, api = 'unified' } = args;
  const scenarioName = 'leave-and-return';
  const sandbox = sessionSandboxObservation(env);
  const owned = createOwnedSessionRegistry(config, cleanupRemoteSession);
  const scenarioConfig = owned.config;
  const runId = randomUUID();
  const bootMarker = `boot-${runId}`;
  const resumeMarker = `resume-${runId}`;
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
  const creations = trackCreations<StartSessionResult>(deadline, owned, scenarioName);
  const events: StreamEvent[] = [];
  let bootStream: StreamConnection | undefined;
  let resumeStream: StreamConnection | undefined;
  let replayStream: StreamConnection | undefined;
  let result: LifecycleResult;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events: [...events, ...(bootStream?.events ?? []), ...(resumeStream?.events ?? [])],
    durationMs: Date.now() - startedAt,
  });

  try {
    assertScenarioPreconditions(scenarioConfig, api);

    const inFlightStart = creations.track(
      startSession(scenarioConfig, { prompt: fakeDirective(`echo:${bootMarker}`) }, api)
    );
    const session = await deadline.within('start session', () => inFlightStart);
    owned.register(session);
    const sessionId = session.cloudAgentSessionId;
    const handle = { cloudAgentSessionId: sessionId, kiloSessionId: session.kiloSessionId };

    bootStream = await deadline.within('boot stream', signal =>
      openConnectedStream(scenarioConfig, sessionId, true, undefined, signal)
    );
    const bootTerminal = await bootStream.waitForTerminal(
      Math.max(1, Math.min(BOOT_TERMINAL_BUDGET_MS, deadline.remaining('boot terminal'))),
      session.messageId
    );
    if (!isMessageCompleted(bootTerminal, session.messageId)) {
      throw new Error(`boot turn ${session.messageId} terminal=${terminalLabel(bootTerminal)}`);
    }
    const bootStatus = await deadline.within('boot durable', signal =>
      awaitDurableTerminal(
        scenarioConfig,
        sessionId,
        session.messageId,
        deadline.remaining('boot durable'),
        signal
      )
    );
    if (bootStatus !== 'completed') throw new Error(`boot turn durable status=${bootStatus}`);
    const bootText = collectChildMessageText(bootStream.events, session.messageId);
    if (!echoPayloadMatches(bootText, bootMarker)) {
      throw new Error(
        `boot turn ${session.messageId} did not complete with ${JSON.stringify(bootMarker)}; observed ${JSON.stringify(bootText)}`
      );
    }
    const bootMessageId = session.messageId;
    events.push(...bootStream.events);

    const intervalStart = Date.now();
    const providerRef = await waitForPresentAllocation(
      deadline,
      sandbox,
      handle,
      'boot',
      CONTAINER_BUDGET_MS
    );
    if (providerRef === null) {
      throw new Error('leave-and-return session did not expose an allocation reference');
    }

    const baselineWait = baselineSampleDelayMs(intervalStart, BASELINE_DELAY_MS, Date.now());
    if (baselineWait > 0) await sleep(baselineWait);
    const baselineObserved = await waitForPresentAllocation(
      deadline,
      sandbox,
      handle,
      'baseline sample',
      HOT_ALLOCATION_BUDGET_MS
    );
    const baselineElapsed = Date.now() - intervalStart;
    if (baselineObserved !== providerRef) {
      throw new Error(
        `allocation reference changed during the baseline window: ${providerRef} -> ${baselineObserved ?? 'none'} at +${baselineElapsed}ms`
      );
    }
    const baselineSample = `${baselineObserved}@t=${baselineElapsed}ms`;
    let lastSampleAt = Date.now();

    const samples: string[] = [];
    let absentAt: number | null = null;
    const observationEnd = intervalStart + IDLE_OBSERVATION_BUDGET_MS;
    while (Date.now() < observationEnd) {
      const observationLeft = observationEnd - Date.now();
      const wait = Math.min(
        pollSampleDelayMs(lastSampleAt, IDLE_POLL_INTERVAL_MS, Date.now()),
        observationLeft
      );
      if (wait > 0) await sleep(wait);
      // The sleep may have consumed the budget; do not issue a sample that can
      // only be recorded after it.
      if (Date.now() >= observationEnd) break;
      const observed = await readAllocation(deadline, sandbox, handle, 'idle sample');
      const sampledAt = Date.now();
      lastSampleAt = sampledAt;
      const elapsed = sampledAt - intervalStart;
      // A read that completed after the budget is not accepted: an absence
      // observed past the deadline must fail closed, never resume the session.
      if (sampledAt > observationEnd) break;
      samples.push(`${observed ?? 'null'}@t=${elapsed}ms`);
      const classification = classifyAllocationSample(providerRef, observed);
      if (classification === 'absent') {
        absentAt = elapsed;
        break;
      }
      if (classification === 'replaced') {
        throw new Error(
          `allocation replaced while unattended: ${providerRef} -> ${observed} (samples=${samples.length})`
        );
      }
    }
    if (absentAt === null) {
      throw new Error(
        `allocation reference still present after ${IDLE_OBSERVATION_BUDGET_MS}ms (samples=${samples.length}: ${samples.join(', ')})`
      );
    }
    const absentSample = `null@t=${absentAt}ms`;

    const resume = await sendTurn(
      deadline,
      scenarioConfig,
      sessionId,
      fakeDirective(`echo:${resumeMarker}`),
      'resume turn',
      RESUME_TURN_BUDGET_MS
    );
    resumeStream = resume.stream;
    if (!hasPreparationForMessage(resume.stream.events, resume.messageId)) {
      throw new Error(
        `resume turn ${resume.messageId} did not report a preparing event; a replaced allocation cannot reuse the old attachment`
      );
    }
    const replacement = await waitForPresentAllocation(
      deadline,
      sandbox,
      handle,
      'resume',
      RESUME_CONTAINER_BUDGET_MS
    );
    if (replacement === null || replacement === providerRef) {
      throw new Error(
        `resume did not expose a replacement allocation: P1=${providerRef}; P2=${replacement ?? 'none'}`
      );
    }
    const resumeText = collectChildMessageText(resume.stream.events, resume.messageId);
    if (!echoPayloadMatches(resumeText, resumeMarker)) {
      throw new Error(
        `resume turn ${resume.messageId} did not complete with ${JSON.stringify(resumeMarker)}; observed ${JSON.stringify(resumeText)}`
      );
    }
    events.push(...resume.stream.events);

    replayStream = await deadline.within('replay stream', signal =>
      openConnectedStream(scenarioConfig, sessionId, true, undefined, signal)
    );
    const replayText = collectChildMessageText(replayStream.events, bootMessageId);
    if (!echoPayloadMatches(replayText, bootMarker)) {
      throw new Error(
        `replayed transcript lost the boot marker ${JSON.stringify(bootMarker)} for ${bootMessageId}; observed ${JSON.stringify(replayText)}`
      );
    }

    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message:
        `session=${sessionId}; providerRef=${providerRef}; baselineSample=${baselineSample}; ` +
        `absentSample=${absentSample}; samples=${samples.length}:${samples.join('|')}; resumePreparing=true; ` +
        `replacement=${replacement}!=${providerRef}; replayedTranscript=${bootMessageId}:${bootMarker}; ` +
        'stopCause=not-read',
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    for (const stream of [bootStream, resumeStream, replayStream]) {
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

export const CONVERSATION_SHARED_SCENARIOS: Record<string, SharedScenario> = {
  'long-conversation': {
    name: 'long-conversation',
    requires: ['sessionSandbox'],
    defaultApi: 'unified',
    defaultConversation: 'echo:cold',
    defaultTimeoutMs: LONG_CONVERSATION_TIMEOUT_MS,
    run: runLongConversation,
  },
  'leave-and-return': {
    name: 'leave-and-return',
    requires: ['sessionSandbox'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: LEAVE_AND_RETURN_TIMEOUT_MS,
    run: runLeaveAndReturn,
  },
};
