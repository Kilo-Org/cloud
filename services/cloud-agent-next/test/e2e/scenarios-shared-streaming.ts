/**
 * Streaming admissions shared by the local and deployed profiles:
 * `chunked-streaming`, `empty-response` and `waiters-clean`.
 *
 * They run against the Worker over tRPC + WebSocket only. Physical container
 * identity comes from the injected `sessionSandbox` capability, so the same
 * definition works under local Docker and over the e2e HTTP surface; nothing
 * here reads Docker or session-ownership rows directly.
 */

import { randomUUID } from 'node:crypto';
import {
  fetchFakeWaiters,
  fakeDirective,
  isMessageCompleted,
  openStream,
  releaseGate,
  sendMessage,
  startSession,
  waitForGateEngaged,
  type StreamConnection,
  type StreamEvent,
} from './client.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';
import type { ScenarioEnvironment } from './scenario-capabilities.js';
import { requireContainer } from './scenarios-shared-runtime.js';
import type { SharedScenario } from './scenarios-shared.js';

/** Generous default per-turn budget for a real first container cold start. */
const DEFAULT_SANDBOX_TIMEOUT_MS = 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deltaCount(events: readonly StreamEvent[]): number {
  return events.filter(
    event =>
      event.streamEventType === 'kilocode' &&
      (event.data as { type?: string } | undefined)?.type === 'message.part.delta'
  ).length;
}

/**
 * chunked-streaming: drives `__fake__:slow:<n>:<ms>` (default 5:50). The fake
 * emits <n> assistant content chunks separated by <ms>ms delays. Assert the turn
 * completes and multiple `message.part.delta` events are observed downstream,
 * proving SSE chunks are not coalesced into one event.
 */
async function runChunkedStreaming(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 60_000, api = 'unified' } = args;
  const directive = conversation && conversation !== '_' ? conversation : 'slow:5:50';
  let stream: StreamConnection | undefined;
  try {
    const session = await startSession(config, { prompt: fakeDirective(directive) }, api);
    stream = openStream(config, session.cloudAgentSessionId, { replay: false });
    const container = await requireContainer(
      env.sessionSandbox,
      session,
      DEFAULT_SANDBOX_TIMEOUT_MS
    );
    if (container === null) {
      stream.close();
      return {
        name: 'chunked-streaming',
        conversation,
        ok: false,
        message: 'sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }

    const terminal = await stream.waitForTerminal(timeoutMs, session.messageId);
    const events = [...stream.events];
    stream.close();

    const deltas = deltaCount(events);
    const ok = isMessageCompleted(terminal, session.messageId);
    return {
      name: 'chunked-streaming',
      conversation,
      ok: ok && deltas >= 2,
      message: `terminal=${terminal?.streamEventType ?? 'none'}, deltas=${deltas}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (error) {
    return {
      name: 'chunked-streaming',
      conversation,
      ok: false,
      message: `threw: ${errorMessage(error)}`,
      events: [],
      durationMs: Date.now() - start,
    };
  } finally {
    try {
      stream?.close();
    } catch {
      // A close failure must not replace the scenario result.
    }
  }
}

/**
 * empty-response: drives `__fake__:idle` so the fake emits a single empty
 * assistant chunk + finish + [DONE]. Assert the worker tolerates a zero-content
 * assistant message — the session completes with no `message.part.delta`.
 */
async function runEmptyResponse(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 60_000, api = 'unified' } = args;
  let stream: StreamConnection | undefined;
  try {
    const session = await startSession(config, { prompt: fakeDirective('idle') }, api);
    stream = openStream(config, session.cloudAgentSessionId, { replay: false });
    const container = await requireContainer(
      env.sessionSandbox,
      session,
      DEFAULT_SANDBOX_TIMEOUT_MS
    );
    if (container === null) {
      stream.close();
      return {
        name: 'empty-response',
        conversation,
        ok: false,
        message: 'sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }

    const terminal = await stream.waitForTerminal(timeoutMs, session.messageId);
    const events = [...stream.events];
    stream.close();

    const deltas = deltaCount(events);
    const completed = isMessageCompleted(terminal, session.messageId);
    return {
      name: 'empty-response',
      conversation,
      ok: completed && deltas === 0,
      message: `terminal=${terminal?.streamEventType ?? 'none'}, deltas=${deltas}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (error) {
    return {
      name: 'empty-response',
      conversation,
      ok: false,
      message: `threw: ${errorMessage(error)}`,
      events: [],
      durationMs: Date.now() - start,
    };
  } finally {
    try {
      stream?.close();
    } catch {
      // A close failure must not replace the scenario result.
    }
  }
}

/**
 * waiters-clean: prove the fake LLM has no parked waiter of this run and no live
 * response at all after the final turn.
 *
 * It first runs one turn it owns end-to-end (`gate:<runTag>`), so the
 * "own tag is gone" assertion is non-vacuous: it polls engagement, releases the
 * gate, and only then runs the echo turn. It asserts (1) its own tag is absent
 * from the global waiter list and (2) the global `liveResponses` count is zero
 * after the echo turn. The fake DO is one global instance, so `liveResponses`
 * is not per-run attribution: a concurrent gate-holding run can make it
 * nonzero. That direction is safe — it causes a false failure, never a false
 * pass — but it is flaky under cross-process concurrency.
 */
async function runWaitersClean(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 60_000, api = 'unified' } = args;
  const convo = conversation && conversation !== '_' ? conversation : 'echo:hi';
  const runTag = `waiters-${randomUUID()}`;
  const events: StreamEvent[] = [];
  let stream: StreamConnection | undefined;
  // Cursor over the single stream's cumulative events so reusing it across the
  // gate and echo turns does not duplicate already-captured events.
  let captured = 0;
  const captureEvents = (): void => {
    if (stream === undefined) return;
    events.push(...stream.events.slice(captured));
    captured = stream.events.length;
  };

  const fail = (message: string): LifecycleResult => ({
    name: 'waiters-clean',
    conversation,
    ok: false,
    message,
    events: [...events],
    durationMs: Date.now() - start,
  });

  try {
    const session = await startSession(config, { prompt: fakeDirective(`gate:${runTag}`) }, api);
    stream = openStream(config, session.cloudAgentSessionId, { replay: false });
    const container = await requireContainer(
      env.sessionSandbox,
      session,
      DEFAULT_SANDBOX_TIMEOUT_MS
    );
    if (container === null) return fail('sandbox did not appear for the owned gate turn');

    if (!(await waitForGateEngaged(config, runTag, timeoutMs))) {
      captureEvents();
      return fail(`owned gate ${runTag} did not engage within ${timeoutMs}ms`);
    }
    await releaseGate(config.fakeLlmUrl, runTag);

    const gateTerminal = await stream.waitForTerminal(timeoutMs, session.messageId);
    captureEvents();
    if (!isMessageCompleted(gateTerminal, session.messageId)) {
      return fail(`owned gate turn terminal=${gateTerminal?.streamEventType ?? 'none'}`);
    }

    // Send the echo turn on the already-connected gate stream. Opening a fresh
    // `replay: false` stream is not awaited before the send, so under the HTTP
    // profile (which fetches a ticket first) a warm echo can complete before the
    // new socket subscribes and the wait then times out. `llm-error` already
    // drives follow-up turns on one open stream.
    const echo = await sendMessage(
      config,
      { cloudAgentSessionId: session.cloudAgentSessionId, prompt: fakeDirective(convo) },
      api
    );
    const echoTerminal = await stream.waitForTerminal(timeoutMs, echo.messageId);
    captureEvents();
    if (!isMessageCompleted(echoTerminal, echo.messageId)) {
      return fail(`echo turn terminal=${echoTerminal?.streamEventType ?? 'none'}`);
    }
    stream.close();
    stream = undefined;

    // Give kilo a moment to close its title-model SSE connection.
    await new Promise(resolve => setTimeout(resolve, 500));
    const snapshot = await fetchFakeWaiters(config.fakeLlmUrl);
    const ownTagRemaining = snapshot.tags.some(entry => entry.tag === runTag);
    const waiterCount = snapshot.tags.reduce((sum, entry) => sum + entry.count, 0);
    return {
      name: 'waiters-clean',
      conversation,
      ok: !ownTagRemaining && snapshot.liveResponses === 0,
      message:
        `gateTag=${runTag}; ownTagRemaining=${ownTagRemaining}; waiters=${waiterCount}; ` +
        `liveResponses=${snapshot.liveResponses}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (error) {
    captureEvents();
    return fail(`threw: ${errorMessage(error)}`);
  } finally {
    try {
      stream?.close();
    } catch {
      // A close failure must not replace the scenario result.
    }
    await releaseGate(config.fakeLlmUrl, runTag).catch(() => {});
  }
}

export const STREAMING_SHARED_SCENARIOS: Record<string, SharedScenario> = {
  'chunked-streaming': {
    name: 'chunked-streaming',
    requires: ['sessionSandbox'],
    defaultConversation: 'slow:5:50',
    run: runChunkedStreaming,
  },
  'empty-response': {
    name: 'empty-response',
    requires: ['sessionSandbox'],
    defaultConversation: '_',
    run: runEmptyResponse,
  },
  'waiters-clean': {
    name: 'waiters-clean',
    requires: ['sessionSandbox'],
    defaultConversation: '_',
    run: runWaitersClean,
  },
};
