/**
 * Streaming admissions shared by the local and deployed profiles:
 * `chunked-streaming` and `empty-response`.
 *
 * They run against the Worker over tRPC + WebSocket only. Physical container
 * identity comes from the injected `sessionSandbox` capability, so the same
 * definition works under local Docker and over the e2e HTTP surface; nothing
 * here reads Docker or session-ownership rows directly.
 */

import {
  fakeDirective,
  isMessageCompleted,
  openStream,
  startSession,
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
};
