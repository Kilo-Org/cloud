/**
 * Failure admissions shared by the local and deployed profiles: `llm-error`.
 *
 * The same definition runs under local Docker and over the e2e HTTP surface.
 * Container identity and continuity are observed through the injected
 * `sessionSandbox` capability, so this module contains no Docker access.
 */

import {
  fakeDirective,
  getMessageResult,
  interruptSession,
  isMessageCompleted,
  messageIdFromEvent,
  openStream,
  sendMessage,
  startSession,
  type StreamConnection,
  type StreamEvent,
} from './client.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';
import type { ScenarioEnvironment } from './scenario-capabilities.js';
import type { SharedScenario } from './scenarios-shared.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetryStatusEvent(event: StreamEvent): boolean {
  if (event.streamEventType !== 'kilocode') return false;
  const data = event.data as
    | { type?: string; properties?: { status?: { type?: string } } }
    | undefined;
  return data?.type === 'session.status' && data.properties?.status?.type === 'retry';
}

type FailedTerminalFields = {
  status?: string;
  reason?: string;
  error?: string;
};

/**
 * Read a `cloud.message.failed` payload through the same dual `data` /
 * `data.payload` path `messageIdFromEvent` uses. Control-plane snapshots
 * (`failedMessageSnapshot`) put the fields directly on `data`; other producers
 * nest them under `data.payload`. Top-level fields win, matching the previous
 * `reason` read.
 */
function failedTerminalFields(event: StreamEvent): FailedTerminalFields {
  const data = event.data as FailedTerminalFields & { payload?: FailedTerminalFields };
  const nested = data.payload;
  return {
    status: data.status ?? nested?.status,
    reason: data.reason ?? nested?.reason,
    error: data.error ?? nested?.error,
  };
}

/**
 * llm-error: drives `__fake__:error:<msg>` so the fake returns HTTP 402 with an
 * OpenAI-shape error body. The wrapper classifies the 402 `insufficient_quota`
 * as terminal (a credit-exhaustion classification), so the turn settles as
 * `cloud.message.failed` and no `retry` status is ever emitted. Assert that
 * terminal path and the continuation the product owns:
 *
 * 1. The exact message reaches a `cloud.message.failed` terminal with
 *    `status=failed` and no retry status anywhere in the turn.
 * 2. Stopping the already-settled message is a no-op: the durable status stays
 *    `failed` and Stop does not re-emit it with `reason=interrupted`.
 * 3. A follow-up completes on the SAME `cloudAgentSessionId` and the SAME
 *    physical container.
 *
 * Conversation arg is the error message (e.g. `llm-error boom`).
 */
async function runLlmError(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 120_000, api = 'unified' } = args;
  const errorMsg = conversation || 'simulated-error';
  const sandbox = env.sessionSandbox;
  let stream: StreamConnection | undefined;
  let session: Awaited<ReturnType<typeof startSession>> | undefined;

  const fail = (message: string): LifecycleResult => ({
    name: 'llm-error',
    conversation,
    ok: false,
    message,
    events: stream ? [...stream.events] : [],
    durationMs: Date.now() - start,
  });

  try {
    session = await startSession(config, { prompt: fakeDirective(`error:${errorMsg}`) }, api);
    stream = openStream(config, session.cloudAgentSessionId, { replay: false });

    const container =
      sandbox === undefined
        ? null
        : await sandbox.waitForContainer({
            cloudAgentSessionId: session.cloudAgentSessionId,
            kiloSessionId: session.kiloSessionId,
            timeoutMs: 60_000,
          });
    if (container === null) return fail('sandbox did not appear');

    const terminal = await stream.waitForTerminal(timeoutMs, session.messageId);
    if (terminal?.streamEventType !== 'cloud.message.failed') {
      return fail(
        `no failed terminal within ${timeoutMs}ms: ${terminal?.streamEventType ?? 'none'}`
      );
    }
    const failedFields = failedTerminalFields(terminal);
    if (failedFields.status !== 'failed') {
      return fail(`terminal status=${failedFields.status ?? 'none'}`);
    }

    // The corrected premise: a terminal provider error must not surface a
    // retry. Array scan over the whole turn, not a timed wait.
    if (stream.events.some(isRetryStatusEvent)) {
      return fail('retry status surfaced for a terminal provider error');
    }

    // Sample the physical identity immediately before the Stop, as the original
    // Docker scenario did: the continuity interval is terminal-observed → after
    // the follow-up, not the earlier container-discovery read.
    const before =
      sandbox === undefined
        ? null
        : await sandbox.currentContainer({
            cloudAgentSessionId: session.cloudAgentSessionId,
            kiloSessionId: session.kiloSessionId,
          });
    await interruptSession(config, session.cloudAgentSessionId);

    const durableStatus = await getMessageResult(
      config,
      session.cloudAgentSessionId,
      session.messageId
    );
    if (durableStatus.status !== 'failed') {
      return fail(`durable status=${durableStatus.status} after Stop (expected failed)`);
    }
    // Stop on an already-settled message must be a no-op: it must not re-emit
    // the turn as an interrupted failure.
    const stopReinterrupted = stream.events.some(
      event =>
        event.streamEventType === 'cloud.message.failed' &&
        messageIdFromEvent(event) === session?.messageId &&
        failedTerminalFields(event).reason === 'interrupted'
    );
    if (stopReinterrupted) {
      return fail('Stop produced reason=interrupted for a settled failed message');
    }

    const followUp = await sendMessage(
      config,
      {
        cloudAgentSessionId: session.cloudAgentSessionId,
        prompt: fakeDirective('echo:after-interrupt'),
      },
      api
    );
    const followTerminal = await stream.waitForTerminal(timeoutMs, followUp.messageId);
    const followStatus = await getMessageResult(
      config,
      session.cloudAgentSessionId,
      followUp.messageId
    );
    if (
      !isMessageCompleted(followTerminal, followUp.messageId) ||
      followStatus.status !== 'completed'
    ) {
      return fail(
        `follow-up stream=${followTerminal?.streamEventType ?? 'none'} durable=${followStatus.status}`
      );
    }

    const after =
      sandbox === undefined
        ? null
        : await sandbox.currentContainer({
            cloudAgentSessionId: session.cloudAgentSessionId,
            kiloSessionId: session.kiloSessionId,
          });
    const sameContainer = before !== null && after !== null && before === after;
    return {
      name: 'llm-error',
      conversation,
      ok: sameContainer,
      message: sameContainer
        ? `terminal=failed/${failedFields.reason ?? 'none'},error=${failedFields.error ?? 'none'}; ` +
          `stop=noop(failed); followUp=completed; container=${after}`
        : `container changed or missing: before=${before ?? 'none'}; after=${after ?? 'none'}`,
      events: [...stream.events],
      durationMs: Date.now() - start,
    };
  } catch (error) {
    return fail(`threw: ${errorMessage(error)}`);
  } finally {
    if (session) await interruptSession(config, session.cloudAgentSessionId).catch(() => {});
    try {
      stream?.close();
    } catch {
      // A close failure must not replace the scenario result.
    }
  }
}

export const FAILURE_SHARED_SCENARIOS: Record<string, SharedScenario> = {
  'llm-error': {
    name: 'llm-error',
    requires: ['sessionSandbox'],
    defaultConversation: 'boom',
    run: runLlmError,
  },
};
