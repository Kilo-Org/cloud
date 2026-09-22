/**
 * Shared callback scenarios.
 *
 * These assert the Worker's outbound callback delivery (`src/callbacks/`)
 * against whichever `callbacks` capability the profile provides: a host HTTP
 * sink under local Docker, or the e2e surface sink (`POST /__e2e/callbacks`)
 * over HTTP. `callbackTarget` is only accepted by the legacy `prepareSession`
 * flow, so all three pin `defaultApi: 'legacy'`; the HTTP profiles call
 * `/trpc/prepareSession` directly with the shared e2e `INTERNAL_API_SECRET` as
 * `x-internal-api-key` and a valid JWT (the same two gates as the surface), not
 * through any surface prepare adapter.
 *
 * The fake LLM gate is a single global instance, so each gate-holding scenario
 * uses a unique run-scoped tag and releases it in `finally` on every path.
 */

import { randomUUID } from 'node:crypto';
import {
  fakeDirective,
  gateEngagementDetail,
  interruptSession,
  isMessageCompleted,
  messageIdFromEvent,
  messagePhase,
  openStream,
  releaseGate,
  sendMessage,
  startSession,
  waitForGateEngaged,
  type DriverConfig,
  type StreamConnection,
} from './client.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';
import type { SharedScenario } from './scenarios-shared.js';
import type {
  CallbackPayload,
  CallbackSink,
  ScenarioEnvironment,
  SessionSandboxObservation,
} from './scenario-capabilities.js';

function callbackObservation(
  env: ScenarioEnvironment
): NonNullable<ScenarioEnvironment['callbacks']> {
  if (!env.callbacks) throw new Error('callbacks capability is required');
  return env.callbacks;
}

/**
 * Bind the session id as soon as the start reports it. The legacy two-step
 * `prepareSession` path reports the prepared id through `config.onSessionCreated`
 * before initiation, so a failure between prepare and initiation still reaches
 * the scenario's failure-path interrupt instead of leaving the prepared session
 * running. Forwards to any runner-supplied hook so ownership tracking is kept.
 */
function trackStartedSession(
  config: DriverConfig,
  onTracked: (sessionId: string) => void
): DriverConfig {
  return {
    ...config,
    onSessionCreated: sessionId => {
      onTracked(sessionId);
      config.onSessionCreated?.(sessionId);
    },
  };
}

function sessionSandboxObservation(env: ScenarioEnvironment): SessionSandboxObservation {
  if (!env.sessionSandbox) throw new Error('sessionSandbox capability is required');
  return env.sessionSandbox;
}

function payloadsForSession(
  records: CallbackPayload[],
  cloudAgentSessionId: string
): CallbackPayload[] {
  return records.filter(payload => payload.cloudAgentSessionId === cloudAgentSessionId);
}

/**
 * callback-completion: start a session with a callback target, drive the
 * conversation, then assert one callback whose `status` is `completed`, whose
 * `messageId` matches the started message, and whose last-assistant text is the
 * echoed directive.
 */
async function runCallbackCompletion(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 120_000, api = 'unified' } = args;
  const scenarioName = 'callback-completion';
  const directive = conversation || 'echo:done';
  const expectedText = directive.startsWith('echo:') ? directive.slice('echo:'.length) : undefined;
  const callbacks = callbackObservation(env);
  const sandbox = sessionSandboxObservation(env);

  let sink: CallbackSink | null = null;
  let stream: StreamConnection | null = null;
  let sessionId: string | undefined;
  let completed = false;
  try {
    sink = await callbacks.open();
    const session = await startSession(
      trackStartedSession(config, id => {
        sessionId = id;
      }),
      {
        prompt: fakeDirective(directive),
        callbackTarget: { url: sink.callbackUrl },
      },
      api
    );
    sessionId = session.cloudAgentSessionId;
    stream = openStream(config, session.cloudAgentSessionId, { replay: false });

    const container = await sandbox.waitForContainer({
      cloudAgentSessionId: session.cloudAgentSessionId,
      kiloSessionId: session.kiloSessionId,
      timeoutMs: 60_000,
    });
    if (container === null) {
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: 'sandbox did not appear',
        events: stream ? [...stream.events] : [],
        durationMs: Date.now() - start,
      };
    }

    const terminal = await stream.waitForTerminal(timeoutMs, session.messageId);
    const events = [...stream.events];

    if (!terminal) {
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: 'stream terminated without a terminal event',
        events,
        durationMs: Date.now() - start,
      };
    }

    const payload = await sink.waitFor(
      candidate => candidate.cloudAgentSessionId === session.cloudAgentSessionId,
      20_000
    );
    if (!payload) {
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: 'no callback received within 20s',
        events,
        durationMs: Date.now() - start,
      };
    }

    const statusOk = payload.status === 'completed';
    const messageIdOk = payload.messageId === session.messageId;
    const textOk = expectedText === undefined || payload.lastAssistantMessageText === expectedText;
    const ok = isMessageCompleted(terminal, session.messageId) && statusOk && messageIdOk && textOk;
    completed = ok;

    return {
      name: scenarioName,
      conversation,
      ok,
      message: ok
        ? `callback status=${payload.status} messageId=${payload.messageId}`
        : `callback mismatch: status=${payload.status} messageIdOk=${messageIdOk} textOk=${textOk} (expected=${JSON.stringify(expectedText)} got=${JSON.stringify(payload.lastAssistantMessageText)})`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: scenarioName,
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: stream ? [...stream.events] : [],
      durationMs: Date.now() - start,
    };
  } finally {
    if (!completed && sessionId) {
      await interruptSession(config, sessionId).catch(() => {});
    }
    try {
      stream?.close();
    } catch {
      /* best-effort close */
    }
    await sink?.close().catch(() => {});
  }
}

/**
 * callback-batch-followup: block the initial message behind a gate, queue two
 * follow-ups, release, and expect one callback for the last queued message
 * only; then send a later hot follow-up and expect a fresh second callback, and
 * no extra callback after the batch settles.
 */
async function runCallbackBatchFollowup(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, timeoutMs = 120_000, api = 'unified' } = args;
  const scenarioName = 'callback-batch-followup';
  const gateTag = `callback-batch-${randomUUID()}`;
  const callbacks = callbackObservation(env);
  const sandbox = sessionSandboxObservation(env);

  let sink: CallbackSink | null = null;
  let stream: StreamConnection | null = null;
  let cleanupSessionId: string | undefined;
  let batchCompleted = false;
  try {
    sink = await callbacks.open();
    const first = await startSession(
      trackStartedSession(config, id => {
        cleanupSessionId = id;
      }),
      {
        prompt: fakeDirective(`gate:${gateTag}`),
        callbackTarget: { url: sink.callbackUrl },
      },
      api
    );
    cleanupSessionId = first.cloudAgentSessionId;
    stream = openStream(config, first.cloudAgentSessionId, { replay: false });

    const container = await sandbox.waitForContainer({
      cloudAgentSessionId: first.cloudAgentSessionId,
      kiloSessionId: first.kiloSessionId,
      timeoutMs: 60_000,
    });
    if (container === null) {
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: 'sandbox did not appear',
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    const gateWaitMs = 120_000;
    const engaged = await waitForGateEngaged(config, gateTag, gateWaitMs);
    if (!engaged) {
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: await gateEngagementDetail(config, gateTag, gateWaitMs),
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    const second = await sendMessage(
      config,
      { cloudAgentSessionId: first.cloudAgentSessionId, prompt: fakeDirective('echo:second') },
      api
    );
    const third = await sendMessage(
      config,
      { cloudAgentSessionId: first.cloudAgentSessionId, prompt: fakeDirective('echo:third') },
      api
    );
    if (second.delivery !== 'queued' || third.delivery !== 'queued') {
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: `expected queued follow-ups; got second=${second.delivery}, third=${third.delivery}`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    await releaseGate(config.fakeLlmUrl, gateTag);
    const thirdTerminal = await stream.waitFor(
      event =>
        messagePhase(event) !== null &&
        messagePhase(event) !== 'queued' &&
        messageIdFromEvent(event) === third.messageId,
      timeoutMs
    );
    if (!thirdTerminal || messagePhase(thirdTerminal) !== 'completed') {
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: `queued batch did not complete on ${third.messageId}`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    const firstCallback = await sink.waitFor(
      payload => payload.messageId === third.messageId,
      20_000
    );
    const queuedBatchCallbacks = payloadsForSession(
      await sink.records(),
      first.cloudAgentSessionId
    );
    const queuedBatchCallbackIds = queuedBatchCallbacks.map(payload => payload.messageId);
    const batchCallbackOk =
      firstCallback !== null &&
      queuedBatchCallbacks.length === 1 &&
      firstCallback.status === 'completed' &&
      firstCallback.messageId === third.messageId &&
      firstCallback.lastAssistantMessageText === 'third' &&
      !queuedBatchCallbackIds.includes(first.messageId) &&
      !queuedBatchCallbackIds.includes(second.messageId);
    if (!batchCallbackOk) {
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: `queued callback batch mismatch: ids=${queuedBatchCallbackIds.join(',') || 'none'} status=${firstCallback?.status ?? 'missing'} text=${JSON.stringify(firstCallback?.lastAssistantMessageText)}`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    const afterBatch = await sendMessage(
      config,
      { cloudAgentSessionId: first.cloudAgentSessionId, prompt: fakeDirective('echo:after-batch') },
      api
    );
    const afterBatchTerminal = await stream.waitFor(
      event =>
        messagePhase(event) !== null &&
        messagePhase(event) !== 'queued' &&
        messageIdFromEvent(event) === afterBatch.messageId,
      timeoutMs
    );
    if (!afterBatchTerminal || messagePhase(afterBatchTerminal) !== 'completed') {
      return {
        name: scenarioName,
        conversation: 'echo:after-batch',
        ok: false,
        message: `sequential follow-up did not complete on ${afterBatch.messageId}`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    const secondCallback = await sink.waitFor(
      payload => payload.messageId === afterBatch.messageId,
      20_000
    );
    const callbackPayloads = payloadsForSession(await sink.records(), first.cloudAgentSessionId);
    const callbackIds = callbackPayloads.map(payload => payload.messageId);
    const statuses = callbackPayloads.map(payload => payload.status);
    const texts = callbackPayloads.map(payload => payload.lastAssistantMessageText);
    const sequentialOk =
      secondCallback !== null &&
      callbackPayloads.length === 2 &&
      callbackIds[0] === third.messageId &&
      callbackIds[1] === afterBatch.messageId &&
      statuses[0] === 'completed' &&
      statuses[1] === 'completed' &&
      texts[0] === 'third' &&
      texts[1] === 'after-batch';
    if (!sequentialOk) {
      return {
        name: scenarioName,
        conversation: 'echo:after-batch',
        ok: false,
        message: `sequential callback mismatch: ids=${callbackIds.join(',') || 'none'} statuses=${statuses.join(',') || 'none'} texts=${JSON.stringify(texts)}`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    // The two callbacks above are already validated, so two is the quiet
    // baseline. Reading the count again here would let a callback that arrives
    // during the read become the baseline and hide itself.
    const quietBaseline = 2;
    await new Promise(resolve => setTimeout(resolve, 2_000));
    const afterQuiet = payloadsForSession(await sink.records(), first.cloudAgentSessionId);
    const events = [...stream.events];
    if (afterQuiet.length !== quietBaseline) {
      const extra = afterQuiet[quietBaseline];
      return {
        name: scenarioName,
        conversation: 'echo:after-batch',
        ok: false,
        message:
          extra !== undefined
            ? `unexpected extra callback for ${extra.messageId ?? 'unknown message'}`
            : `callback records dropped from ${quietBaseline} to ${afterQuiet.length}`,
        events,
        durationMs: Date.now() - start,
      };
    }

    batchCompleted = true;
    return {
      name: scenarioName,
      conversation: 'gate:callback-batch + echo:after-batch',
      ok: true,
      message: `callbacks=${callbackIds.join(' -> ')}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: scenarioName,
      conversation: 'gate:callback-batch + echo:after-batch',
      ok: false,
      message: `threw: ${msg}`,
      events: stream ? [...stream.events] : [],
      durationMs: Date.now() - start,
    };
  } finally {
    if (!batchCompleted && cleanupSessionId) {
      await interruptSession(config, cleanupSessionId).catch(() => {});
    }
    await releaseGate(config.fakeLlmUrl, gateTag).catch(() => {});
    try {
      stream?.close();
    } catch {
      /* best-effort close */
    }
    await sink?.close().catch(() => {});
  }
}

/**
 * callback-interrupt: park an active execution behind a gate, interrupt it, and
 * assert the callback fires with `status: 'interrupted'`.
 */
async function runCallbackInterrupt(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, timeoutMs = 120_000, api = 'unified' } = args;
  const scenarioName = 'callback-interrupt';
  const gateTag = `callback-interrupt-${randomUUID()}`;
  const callbacks = callbackObservation(env);
  const sandbox = sessionSandboxObservation(env);

  let sink: CallbackSink | null = null;
  let stream: StreamConnection | null = null;
  let sessionId: string | undefined;
  let completed = false;
  try {
    sink = await callbacks.open();
    const session = await startSession(
      trackStartedSession(config, id => {
        sessionId = id;
      }),
      {
        prompt: fakeDirective(`gate:${gateTag}`),
        callbackTarget: { url: sink.callbackUrl },
      },
      api
    );
    sessionId = session.cloudAgentSessionId;
    stream = openStream(config, session.cloudAgentSessionId, { replay: false });

    const container = await sandbox.waitForContainer({
      cloudAgentSessionId: session.cloudAgentSessionId,
      kiloSessionId: session.kiloSessionId,
      timeoutMs: 60_000,
    });
    if (container === null) {
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: 'sandbox did not appear',
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    const gateWaitMs = 120_000;
    const engaged = await waitForGateEngaged(config, gateTag, gateWaitMs);
    if (!engaged) {
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: await gateEngagementDetail(config, gateTag, gateWaitMs),
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    await interruptSession(config, session.cloudAgentSessionId);

    const terminal = await stream.waitForTerminal(timeoutMs, session.messageId);
    const events = [...stream.events];
    if (!terminal) {
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: 'no terminal stream event after interrupt',
        events,
        durationMs: Date.now() - start,
      };
    }

    const payload = await sink.waitFor(
      candidate => candidate.cloudAgentSessionId === session.cloudAgentSessionId,
      20_000
    );
    if (!payload) {
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: 'no callback received after interrupt',
        events,
        durationMs: Date.now() - start,
      };
    }

    const interrupted = payload.status === 'interrupted';
    completed = interrupted;
    return {
      name: scenarioName,
      conversation: `gate:${gateTag}`,
      ok: interrupted,
      message: `callback status=${payload.status} messageId=${payload.messageId}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: scenarioName,
      conversation: `gate:${gateTag}`,
      ok: false,
      message: `threw: ${msg}`,
      events: stream ? [...stream.events] : [],
      durationMs: Date.now() - start,
    };
  } finally {
    if (!completed && sessionId) {
      await interruptSession(config, sessionId).catch(() => {});
    }
    await releaseGate(config.fakeLlmUrl, gateTag).catch(() => {});
    try {
      stream?.close();
    } catch {
      /* best-effort close */
    }
    await sink?.close().catch(() => {});
  }
}

export const CALLBACK_SHARED_SCENARIOS: Record<string, SharedScenario> = {
  'callback-completion': {
    name: 'callback-completion',
    requires: ['callbacks', 'sessionSandbox'],
    defaultConversation: 'echo:done',
    defaultApi: 'legacy',
    run: runCallbackCompletion,
  },
  'callback-batch-followup': {
    name: 'callback-batch-followup',
    requires: ['callbacks', 'sessionSandbox'],
    defaultConversation: '_',
    defaultApi: 'legacy',
    run: runCallbackBatchFollowup,
  },
  'callback-interrupt': {
    name: 'callback-interrupt',
    requires: ['callbacks', 'sessionSandbox'],
    defaultConversation: '_',
    defaultApi: 'legacy',
    run: runCallbackInterrupt,
  },
};
