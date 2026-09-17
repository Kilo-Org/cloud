/**
 * Queue-semantics admissions shared by the local Docker and HTTP profiles:
 * `queue-while-busy`, `queue-rapid-fire-no-gate`, `queue-overflow`,
 * `queue-interrupt-clears` and `interrupt-mid-stream`.
 *
 * They run against the Worker over tRPC + WebSocket only. Physical container
 * identity comes from the injected `sessionSandbox` capability, so the same
 * definition works under local Docker and over the e2e HTTP surface.
 *
 * Every gate tag is `-<runId>`-scoped, and each definition releases every tag
 * it still owns before returning. A tag whose release fails is a scenario
 * failure, never a silent leak: the fake LLM DO is one global instance, so a
 * parked gate from this run would otherwise contaminate later runs.
 */

import { randomUUID } from 'node:crypto';
import {
  fakeDirective,
  interruptSession,
  isMessageCompleted,
  messageIdFromEvent,
  messagePhase,
  openConnectedStream,
  openStream,
  releaseGate,
  sendMessage,
  startSession,
  waitForGateEngaged,
  type StreamConnection,
  type StreamEvent,
} from './client.js';
import { requireWorktreeGate } from './worktree-support.js';
import { withOwnedGates } from './owned-gates.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';
import type { ScenarioEnvironment, SessionSandboxObservation } from './scenario-capabilities.js';
import type { SharedScenario } from './scenarios-shared.js';

const QUEUE_TIMEOUT_MS = 120_000;
const INTERRUPT_CLEARS_TIMEOUT_MS = 60_000;
const INTERRUPT_MID_STREAM_TIMEOUT_MS = 180_000;
const SANDBOX_TIMEOUT_MS = 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionSandboxObservation(env: ScenarioEnvironment): SessionSandboxObservation {
  if (!env.sessionSandbox) throw new Error('sessionSandbox capability is required');
  return env.sessionSandbox;
}

async function requireContainer(
  sandbox: SessionSandboxObservation,
  session: { cloudAgentSessionId: string; kiloSessionId: string },
  timeoutMs: number
): Promise<string | null> {
  return sandbox.waitForContainer({
    cloudAgentSessionId: session.cloudAgentSessionId,
    kiloSessionId: session.kiloSessionId,
    timeoutMs,
  });
}

/**
 * Every message in `messageIds` reaches a completed terminal, in that exact
 * order, with no failed terminal interleaved. Moved verbatim from the local
 * queue scenarios so the moved definitions keep the same FIFO assertion.
 */
function successfulMessageOrder(events: StreamEvent[], messageIds: string[]): boolean {
  const terminal = events.filter(event => {
    const messageId = messageIdFromEvent(event);
    return (
      messageId !== undefined &&
      messageIds.includes(messageId) &&
      (messagePhase(event) === 'completed' || messagePhase(event) === 'failed')
    );
  });
  return (
    terminal.length === messageIds.length &&
    terminal.every((event, index) => isMessageCompleted(event, messageIds[index]))
  );
}

/**
 * queue-while-busy: enqueue two messages behind an actively-blocking turn,
 * release the gate, assert FIFO delivery. See the local definition's JSDoc for
 * the full step list; only the container-identity capability and the
 * release-on-every-path wrapper differ.
 */
async function queueWhileBusyBody(
  args: LifecycleArgs,
  env: ScenarioEnvironment,
  owned: Set<string>
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = QUEUE_TIMEOUT_MS, api = 'unified' } = args;
  const scenarioName = 'queue-while-busy';
  const sandbox = sessionSandboxObservation(env);
  const gateTag = `${conversation || 'gate1'}-${randomUUID()}`;
  owned.add(gateTag);
  let cleanupSessionId: string | undefined;
  let terminalized = false;
  let stream: StreamConnection | undefined;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events: stream ? [...stream.events] : [],
    durationMs: Date.now() - startedAt,
  });

  try {
    const gate = await startSession(config, { prompt: fakeDirective(`gate:${gateTag}`) }, api);
    cleanupSessionId = gate.cloudAgentSessionId;
    stream = await openConnectedStream(config, gate.cloudAgentSessionId);
    const container = await requireContainer(sandbox, gate, timeoutMs);
    if (container === null) return fail('sandbox did not appear within 60s');

    const engaged = await waitForGateEngaged(config, gateTag, 120_000);
    if (!engaged) {
      return fail(`gate:${gateTag} did not engage on fake LLM within 90s`);
    }

    const second = await sendMessage(
      config,
      { cloudAgentSessionId: gate.cloudAgentSessionId, prompt: fakeDirective('echo:second') },
      api
    );
    const third = await sendMessage(
      config,
      { cloudAgentSessionId: gate.cloudAgentSessionId, prompt: fakeDirective('echo:third') },
      api
    );

    if (second.delivery !== 'queued' || third.delivery !== 'queued') {
      return fail(
        `expected delivery=queued for both follow-ups; got second=${second.delivery}, third=${third.delivery}`
      );
    }

    // Release the gate so the queue drains.
    await releaseGate(config.fakeLlmUrl, gateTag);
    owned.delete(gateTag);

    // Wait for the last queued message to terminate; by then the earlier two
    // must have terminated too (queue is strict FIFO). Filter out the
    // initial `cloud.message.queued` event for the same messageId — that
    // one arrives immediately on send and isn't a terminal state.
    const thirdTerminal = await stream.waitFor(
      e =>
        messagePhase(e) !== null &&
        messagePhase(e) !== 'queued' &&
        messageIdFromEvent(e) === third.messageId,
      timeoutMs
    );
    if (!thirdTerminal) {
      return fail(
        `third message ${third.messageId} did not terminate within ${timeoutMs}ms; owned container=${container}`
      );
    }

    const events = [...stream.events];
    stream.close();
    stream = undefined;

    const expectedOrder = [gate.messageId, second.messageId, third.messageId];
    const fifoOk = successfulMessageOrder(events, expectedOrder);
    terminalized = fifoOk;

    return {
      name: scenarioName,
      conversation,
      ok: fifoOk,
      message: fifoOk
        ? `session=${gate.cloudAgentSessionId}; successful FIFO: ${expectedOrder.join(' -> ')}`
        : `expected successful FIFO completion for ${expectedOrder.join(' -> ')}`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return fail(`threw: ${errorMessage(err)}`);
  } finally {
    try {
      stream?.close();
    } catch {
      // A close failure must not replace the scenario result.
    }
    if (!terminalized && cleanupSessionId) {
      await interruptSession(config, cleanupSessionId).catch(() => {});
    }
  }
}

/**
 * queue-rapid-fire-no-gate: minimal reproducer for queue-while-busy without
 * any gate machinery. Start a session with `echo:first`, immediately send
 * `echo:second` and `echo:third` back-to-back, then wait for the third
 * message's terminal phase. If FIFO holds we have a regression test; if it
 * hangs, dump the wrapper + kilo CLI logs inline for triage.
 */
async function queueRapidFireBody(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = QUEUE_TIMEOUT_MS, api = 'unified' } = args;
  const scenarioName = 'queue-rapid-fire-no-gate';
  const sandbox = sessionSandboxObservation(env);
  let stream: StreamConnection | undefined;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events: stream ? [...stream.events] : [],
    durationMs: Date.now() - startedAt,
  });

  try {
    const first = await startSession(config, { prompt: fakeDirective('echo:first') }, api);
    stream = openStream(config, first.cloudAgentSessionId, { replay: false });

    // Rapid-fire the follow-ups without waiting for any terminal signal; if
    // the DO happens to be mid-init, these will land in the pending queue
    // with delivery=queued. Either way, FIFO must hold.
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

    const container = await requireContainer(sandbox, first, SANDBOX_TIMEOUT_MS);
    if (container === null) return fail('new sandbox did not appear within 60s');

    const thirdTerminal = await stream.waitFor(
      e =>
        messagePhase(e) !== null &&
        messagePhase(e) !== 'queued' &&
        messageIdFromEvent(e) === third.messageId,
      timeoutMs
    );
    if (!thirdTerminal) {
      return fail(
        `third message ${third.messageId} did not terminate within ${timeoutMs}ms (first=${first.messageId} second=${second.messageId})`
      );
    }

    const events = [...stream.events];
    stream.close();
    stream = undefined;

    const expectedOrder = [first.messageId, second.messageId, third.messageId];
    const fifoOk = successfulMessageOrder(events, expectedOrder);

    return {
      name: scenarioName,
      conversation,
      ok: fifoOk,
      message: fifoOk
        ? `session=${first.cloudAgentSessionId}; successful FIFO: ${expectedOrder.join(' -> ')}; container=${container}`
        : `expected successful FIFO completion for ${expectedOrder.join(' -> ')}`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return fail(`threw: ${errorMessage(err)}`);
  } finally {
    try {
      stream?.close();
    } catch {
      // A close failure must not replace the scenario result.
    }
  }
}

/**
 * queue-overflow: drive the pending queue up to `PENDING_SESSION_MESSAGE_LIMIT`
 * (10) and assert the next enqueue fails with HTTP 429 (TOO_MANY_REQUESTS).
 *
 * Strategy: block the first message with `gate:overflow-<runId>` so it stays
 * active-but-busy in the wrapper, freeing the pending slot. Then enqueue up to
 * 20 echoes (pending → capacity), and assert a later one is rejected.
 */
async function queueOverflowBody(
  args: LifecycleArgs,
  env: ScenarioEnvironment,
  owned: Set<string>
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = QUEUE_TIMEOUT_MS, api = 'unified' } = args;
  const scenarioName = 'queue-overflow';
  const sandbox = sessionSandboxObservation(env);
  const gateTag = `overflow-${randomUUID()}`;
  owned.add(gateTag);
  let stream: StreamConnection | undefined;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events: stream ? [...stream.events] : [],
    durationMs: Date.now() - startedAt,
  });

  try {
    const gate = await startSession(config, { prompt: fakeDirective(`gate:${gateTag}`) }, api);
    stream = openStream(config, gate.cloudAgentSessionId, { replay: false });

    const container = await requireContainer(sandbox, gate, SANDBOX_TIMEOUT_MS);
    if (container === null) return fail('sandbox did not appear');

    const engaged = await waitForGateEngaged(config, gateTag, 120_000);
    if (!engaged) {
      return fail(`gate:${gateTag} did not engage on fake LLM — queue slot remained occupied`);
    }

    // Fill the queue until enqueue starts failing with 429. The limit is
    // server-enforced (PENDING_SESSION_MESSAGE_LIMIT); the exact boundary
    // depends on whether the gate counts toward it, so we just drain until
    // we hit the wall rather than guessing the count.
    const queuedIds: string[] = [];
    let overflowOk = false;
    let overflowMessage = 'no 429 within 20 attempts';
    for (let i = 0; i < 20; i++) {
      try {
        const ack = await sendMessage(
          config,
          {
            cloudAgentSessionId: gate.cloudAgentSessionId,
            prompt: fakeDirective(`echo:q${i}`),
          },
          api
        );
        if (ack.delivery !== 'queued') {
          return fail(`fill-${i}: expected delivery=queued, got ${ack.delivery}`);
        }
        queuedIds.push(ack.messageId);
      } catch (err) {
        const msg = errorMessage(err);
        const is429 = msg.includes('429') || /TOO_MANY_REQUESTS|PENDING_QUEUE_FULL/.test(msg);
        if (!is429) throw err;
        overflowOk = true;
        overflowMessage = `filled ${queuedIds.length} before rejection: ${msg.split('—').slice(-1)[0]?.trim() ?? '429'}`;
        break;
      }
    }

    // Interrupt after proving capacity. Draining the overflow queue naturally can
    // outlive this row and keep sandbox retry work active while later smoke cases
    // are cold-starting. The interrupt path is already responsible for clearing
    // queued messages, so wait for those durable failure events before returning.
    await interruptSession(config, gate.cloudAgentSessionId);
    const activeStream = stream;
    const queuedFailures = await Promise.all(
      queuedIds.map(messageId =>
        activeStream.waitFor(
          event =>
            event.streamEventType === 'cloud.message.failed' &&
            messageIdFromEvent(event) === messageId,
          timeoutMs
        )
      )
    );
    const queueCleared = queuedFailures.every(event => event !== null);
    const events = [...stream.events];
    stream.close();
    stream = undefined;

    return {
      name: scenarioName,
      conversation,
      ok: overflowOk && queueCleared,
      message: overflowOk
        ? `${overflowMessage}; cleanup=${queueCleared ? 'cleared' : 'timed out'}`
        : `expected queue rejection within 20 attempts; got: ${overflowMessage}`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return fail(`threw: ${errorMessage(err)}`);
  } finally {
    try {
      stream?.close();
    } catch {
      // A close failure must not replace the scenario result.
    }
  }
}

/**
 * queue-interrupt-clears: enqueue messages behind an active turn, fire
 * `interruptSession`, assert all queued messages surface
 * `cloud.message.failed` with `reason: 'interrupted'` and `delivery: 'queued'`.
 *
 * The gate is not released directly — the interrupt itself terminates the
 * gated turn on the wrapper side. The owned-tag wrapper releases it if the
 * fake's gated request is still parked.
 */
async function queueInterruptClearsBody(
  args: LifecycleArgs,
  env: ScenarioEnvironment,
  owned: Set<string>
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = INTERRUPT_CLEARS_TIMEOUT_MS, api = 'unified' } = args;
  const scenarioName = 'queue-interrupt-clears';
  const sandbox = sessionSandboxObservation(env);
  const gateTag = `intgate-${randomUUID()}`;
  owned.add(gateTag);
  let stream: StreamConnection | undefined;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events: stream ? [...stream.events] : [],
    durationMs: Date.now() - startedAt,
  });

  try {
    const gate = await startSession(config, { prompt: fakeDirective(`gate:${gateTag}`) }, api);
    stream = openStream(config, gate.cloudAgentSessionId, { replay: false });

    const container = await requireContainer(sandbox, gate, SANDBOX_TIMEOUT_MS);
    if (container === null) return fail('sandbox did not appear');

    const engaged = await waitForGateEngaged(config, gateTag, 120_000);
    if (!engaged) {
      return fail(`gate:${gateTag} did not engage on fake LLM`);
    }

    const second = await sendMessage(
      config,
      { cloudAgentSessionId: gate.cloudAgentSessionId, prompt: fakeDirective('echo:second') },
      api
    );
    const third = await sendMessage(
      config,
      { cloudAgentSessionId: gate.cloudAgentSessionId, prompt: fakeDirective('echo:third') },
      api
    );

    await interruptSession(config, gate.cloudAgentSessionId);

    // Expect cloud.message.failed for both queued follow-ups.
    const secondFailed = await stream.waitFor(
      e =>
        e.streamEventType === 'cloud.message.failed' && messageIdFromEvent(e) === second.messageId,
      timeoutMs
    );
    const thirdFailed = await stream.waitFor(
      e =>
        e.streamEventType === 'cloud.message.failed' && messageIdFromEvent(e) === third.messageId,
      timeoutMs
    );

    const events = [...stream.events];
    stream.close();
    stream = undefined;

    function failedWithReasonInterrupted(event: StreamEvent | null): boolean {
      if (!event) return false;
      const data = event.data as
        | { reason?: string; delivery?: string; payload?: { reason?: string; delivery?: string } }
        | undefined;
      const reason = data?.reason ?? data?.payload?.reason;
      const delivery = data?.delivery ?? data?.payload?.delivery;
      return reason === 'interrupted' && delivery === 'queued';
    }

    const secondOk = failedWithReasonInterrupted(secondFailed);
    const thirdOk = failedWithReasonInterrupted(thirdFailed);

    return {
      name: scenarioName,
      conversation,
      ok: secondOk && thirdOk,
      message: `second=${secondOk ? 'ok' : 'fail'}, third=${thirdOk ? 'ok' : 'fail'}`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return fail(`threw: ${errorMessage(err)}`);
  } finally {
    try {
      stream?.close();
    } catch {
      // A close failure must not replace the scenario result.
    }
  }
}

/**
 * interrupt-mid-stream: complement to `queue-interrupt-clears`. Here the
 * interrupt fires while a turn is ACTIVELY streaming (not queued). Assert
 * the active message surfaces `cloud.message.failed` with
 * `reason === 'interrupted'` and `delivery !== 'queued'`.
 */
async function interruptMidStreamBody(
  args: LifecycleArgs,
  env: ScenarioEnvironment,
  owned: Set<string>
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const {
    config,
    conversation,
    timeoutMs = INTERRUPT_MID_STREAM_TIMEOUT_MS,
    api = 'unified',
  } = args;
  const scenarioName = 'interrupt-mid-stream';
  const sandbox = sessionSandboxObservation(env);
  const gateTag = `intactive-${randomUUID()}`;
  owned.add(gateTag);
  const deadlineAt = startedAt + timeoutMs;
  let stream: StreamConnection | undefined;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events: stream ? [...stream.events] : [],
    durationMs: Date.now() - startedAt,
  });

  try {
    const session = await startSession(config, { prompt: fakeDirective(`gate:${gateTag}`) }, api);
    stream = openStream(config, session.cloudAgentSessionId, { replay: false });

    const container = await requireContainer(sandbox, session, SANDBOX_TIMEOUT_MS);
    if (container === null) return fail('sandbox did not appear');

    // Pass this message's id so a `cloud.message.failed` received during
    // sandbox discovery (before this wait) still fails fast instead of being
    // missed by the gate window.
    await requireWorktreeGate(
      config,
      gateTag,
      Math.max(1, deadlineAt - Date.now()),
      stream,
      session.messageId
    );

    await interruptSession(config, session.cloudAgentSessionId);

    const failed = await stream.waitFor(
      e =>
        e.streamEventType === 'cloud.message.failed' && messageIdFromEvent(e) === session.messageId,
      timeoutMs
    );
    const events = [...stream.events];

    if (!failed) {
      return fail(`no cloud.message.failed for active message within ${timeoutMs}ms`);
    }

    const data = failed.data as
      | { reason?: string; delivery?: string; payload?: { reason?: string; delivery?: string } }
      | undefined;
    const reason = data?.reason ?? data?.payload?.reason;
    const delivery = data?.delivery ?? data?.payload?.delivery;
    const ok = reason === 'interrupted' && delivery !== 'queued';

    return {
      name: scenarioName,
      conversation,
      ok,
      message: `reason=${reason ?? 'none'} delivery=${delivery ?? 'none'}`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return fail(`threw: ${errorMessage(err)}`);
  } finally {
    try {
      stream?.close();
    } catch {
      // A close failure must not replace the scenario result.
    }
  }
}

export async function runQueueWhileBusy(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  return withOwnedGates('queue-while-busy', args, owned => queueWhileBusyBody(args, env, owned));
}

export async function runQueueRapidFireNoGate(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  return queueRapidFireBody(args, env);
}

export async function runQueueOverflow(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  return withOwnedGates('queue-overflow', args, owned => queueOverflowBody(args, env, owned));
}

export async function runQueueInterruptClears(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  return withOwnedGates('queue-interrupt-clears', args, owned =>
    queueInterruptClearsBody(args, env, owned)
  );
}

export async function runInterruptMidStream(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  return withOwnedGates('interrupt-mid-stream', args, owned =>
    interruptMidStreamBody(args, env, owned)
  );
}

export const QUEUE_SHARED_SCENARIOS: Record<string, SharedScenario> = {
  'queue-while-busy': {
    name: 'queue-while-busy',
    requires: ['sessionSandbox'],
    defaultConversation: 'gate1',
    defaultTimeoutMs: QUEUE_TIMEOUT_MS,
    run: runQueueWhileBusy,
  },
  'queue-rapid-fire-no-gate': {
    name: 'queue-rapid-fire-no-gate',
    requires: ['sessionSandbox'],
    defaultConversation: '_',
    defaultTimeoutMs: QUEUE_TIMEOUT_MS,
    run: runQueueRapidFireNoGate,
  },
  'queue-overflow': {
    name: 'queue-overflow',
    requires: ['sessionSandbox'],
    defaultConversation: '_',
    defaultTimeoutMs: QUEUE_TIMEOUT_MS,
    run: runQueueOverflow,
  },
  'queue-interrupt-clears': {
    name: 'queue-interrupt-clears',
    requires: ['sessionSandbox'],
    defaultConversation: '_',
    defaultTimeoutMs: INTERRUPT_CLEARS_TIMEOUT_MS,
    run: runQueueInterruptClears,
  },
  'interrupt-mid-stream': {
    name: 'interrupt-mid-stream',
    requires: ['sessionSandbox'],
    defaultConversation: '_',
    defaultTimeoutMs: INTERRUPT_MID_STREAM_TIMEOUT_MS,
    run: runInterruptMidStream,
  },
};
