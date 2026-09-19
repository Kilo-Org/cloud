/**
 * Queue-semantics admissions shared by the local Docker and HTTP profiles:
 * `queue-while-busy`, `queue-rapid-fire-no-gate`, `queue-overflow`,
 * `queue-interrupt-clears` and `interrupt-mid-stream`.
 *
 * They run against the Worker over tRPC + WebSocket only. Physical container
 * identity comes from the injected `sessionSandbox` capability, so the same
 * definition works under local Docker and over the e2e HTTP surface.
 *
 * The hold is a bounded `slow:<n>:1000:16` directive, not a parked gate: a slow
 * turn is time-based and self-terminating, so there is no global fake-LLM state
 * to release and no cross-run contamination. The container is booted and
 * observed on a fast warm-up turn **before** the hold starts, so the hold's
 * action window is not consumed by container readiness. Readiness is attributed
 * with `waitForPacedProgress` and the turn must be `running`, never merely
 * `queued`, before the scenario queues or interrupts behind it.
 */

import {
  fakeDirective,
  interruptSession,
  isMessageCompleted,
  messageIdFromEvent,
  messagePhase,
  openConnectedStream,
  sendMessage,
  startSession,
  type ApiVersion,
  type DriverConfig,
  type StreamConnection,
  type StreamEvent,
} from './client.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';
import type { ScenarioEnvironment, SessionSandboxObservation } from './scenario-capabilities.js';
import {
  createScenarioDeadline,
  sessionSandboxObservation,
  startPacedHoldTurn,
  trackStartedSession,
  type ScenarioDeadline,
} from './scenarios-shared-runtime.js';
import type { SharedScenario } from './scenarios-shared.js';

const QUEUE_TIMEOUT_MS = 240_000;
const QUEUE_OVERFLOW_TIMEOUT_MS = 300_000;
const INTERRUPT_CLEARS_TIMEOUT_MS = 240_000;
const INTERRUPT_MID_STREAM_TIMEOUT_MS = 300_000;
/** Boot/container budget, consumed before the action window starts. */
const CONTAINER_BUDGET_MS = 120_000;
/** Bound for the fast warm-up turn that proves the container is ready. */
const BOOT_TERMINAL_BUDGET_MS = 120_000;
/** Bound for the paced-progress readiness wait; the slow hold outlasts it. */
const PACED_PROGRESS_BUDGET_MS = 60_000;
/** Total budget for filling the pending queue before the 429 must appear. */
const FILL_BUDGET_MS = 90_000;
/** Bounded cleanup after a failed body. */
const CLEANUP_TIMEOUT_MS = 15_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type PacedHold = {
  boot: Awaited<ReturnType<typeof startSession>>;
  held: { messageId: string };
  stream: StreamConnection;
  container: string;
};

/**
 * Boot the session on a fast warm-up turn, observe its physical container, and
 * only then start the bounded `slow` hold. The fake request baseline is captured
 * immediately before the hold send so `waitForPacedProgress` attributes a
 * request to it. If this throws after acquiring the stream or session, it closes
 * and interrupts them itself: ownership transfers to the caller only on return.
 */
async function startPacedHold(
  deadline: ScenarioDeadline,
  config: DriverConfig,
  sandbox: SessionSandboxObservation,
  api: ApiVersion,
  directive: string,
  label: string
): Promise<PacedHold> {
  let stream: StreamConnection | undefined;
  let sessionId: string | undefined;
  try {
    const boot = await deadline.within(`${label} boot start`, signal =>
      startSession(
        trackStartedSession(config, id => {
          sessionId = id;
        }),
        { prompt: fakeDirective('echo:warmup'), signal },
        api
      )
    );
    sessionId = boot.cloudAgentSessionId;
    const bootStream = await deadline.within(`${label} boot stream`, signal =>
      openConnectedStream(config, boot.cloudAgentSessionId, true, undefined, signal)
    );
    stream = bootStream;

    const container = await deadline.within(`${label} container`, signal =>
      sandbox.waitForContainer({
        cloudAgentSessionId: boot.cloudAgentSessionId,
        kiloSessionId: boot.kiloSessionId,
        timeoutMs: Math.max(
          1,
          Math.min(CONTAINER_BUDGET_MS, deadline.remaining(`${label} container`))
        ),
        signal,
      })
    );
    if (container === null) throw new Error(`${label}: sandbox did not appear`);

    const bootTerminal = await deadline.within(`${label} boot terminal`, () =>
      bootStream.waitForTerminal(BOOT_TERMINAL_BUDGET_MS, boot.messageId)
    );
    if (!isMessageCompleted(bootTerminal, boot.messageId)) {
      throw new Error(`${label}: boot turn ${boot.messageId} did not complete`);
    }

    const held = await startPacedHoldTurn({
      deadline,
      config,
      cloudAgentSessionId: boot.cloudAgentSessionId,
      directive,
      label,
      budgetMs: PACED_PROGRESS_BUDGET_MS,
      api,
      stream: bootStream,
    });
    return { boot, held, stream: bootStream, container };
  } catch (error) {
    try {
      stream?.close();
    } catch {
      // A close failure must not replace the helper's error.
    }
    if (sessionId) {
      await interruptSession(
        config,
        sessionId,
        AbortSignal.timeout(CLEANUP_TIMEOUT_MS)
      ).catch(() => {});
    }
    throw error;
  }
}

/**
 * Every message in `messageIds` reaches a completed terminal, in that exact
 * order, with no failed terminal interleaved.
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
 * queue-while-busy: enqueue two messages behind a running paced turn, let the
 * hold complete naturally, assert FIFO delivery of the held turn plus both
 * follow-ups. The paced turn is started only after the boot container is ready.
 */
async function queueWhileBusyBody(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = QUEUE_TIMEOUT_MS, api = 'unified' } = args;
  const scenarioName = 'queue-while-busy';
  const sandbox = sessionSandboxObservation(env);
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
  let stream: StreamConnection | undefined;
  let cleanupSessionId: string | undefined;
  let terminalized = false;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events: stream ? [...stream.events] : [],
    durationMs: Date.now() - startedAt,
  });

  try {
    const hold = await startPacedHold(
      deadline,
      config,
      sandbox,
      api,
      'slow:60:1000:16',
      scenarioName
    );
    stream = hold.stream;
    cleanupSessionId = hold.boot.cloudAgentSessionId;
    const sessionId = hold.boot.cloudAgentSessionId;

    const second = await deadline.within('second send', signal =>
      sendMessage(
        config,
        { cloudAgentSessionId: sessionId, prompt: fakeDirective('echo:second'), signal },
        api
      )
    );
    const third = await deadline.within('third send', signal =>
      sendMessage(
        config,
        { cloudAgentSessionId: sessionId, prompt: fakeDirective('echo:third'), signal },
        api
      )
    );

    if (second.delivery !== 'queued' || third.delivery !== 'queued') {
      return fail(
        `expected delivery=queued for both follow-ups; got second=${second.delivery}, third=${third.delivery}`
      );
    }

    // Wait for the last queued message to terminate; by then the held turn and
    // the second follow-up must have terminated too (strict FIFO). Filter out
    // the initial `cloud.message.queued` event, which is not a terminal state.
    const thirdTerminal = await stream.waitFor(
      e =>
        messagePhase(e) !== null &&
        messagePhase(e) !== 'queued' &&
        messageIdFromEvent(e) === third.messageId,
      deadline.remaining('third terminal')
    );
    if (!thirdTerminal) {
      return fail(
        `third message ${third.messageId} did not terminate; owned container=${hold.container}`
      );
    }

    const events = [...stream.events];
    stream.close();
    stream = undefined;

    const expectedOrder = [hold.held.messageId, second.messageId, third.messageId];
    const fifoOk = successfulMessageOrder(events, expectedOrder);
    terminalized = fifoOk;

    return {
      name: scenarioName,
      conversation,
      ok: fifoOk,
      message: fifoOk
        ? `session=${hold.boot.cloudAgentSessionId}; successful FIFO: ${expectedOrder.join(' -> ')}`
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
      await interruptSession(
        config,
        cleanupSessionId,
        AbortSignal.timeout(CLEANUP_TIMEOUT_MS)
      ).catch(() => {});
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
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
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
    const first = await deadline.within('first start', signal =>
      startSession(config, { prompt: fakeDirective('echo:first'), signal }, api)
    );
    stream = await deadline.within('first stream', signal =>
      openConnectedStream(config, first.cloudAgentSessionId, false, undefined, signal)
    );

    // Rapid-fire the follow-ups without waiting for any terminal signal; if
    // the DO happens to be mid-init, these will land in the pending queue
    // with delivery=queued. Either way, FIFO must hold.
    const second = await deadline.within('second send', signal =>
      sendMessage(
        config,
        {
          cloudAgentSessionId: first.cloudAgentSessionId,
          prompt: fakeDirective('echo:second'),
          signal,
        },
        api
      )
    );
    const third = await deadline.within('third send', signal =>
      sendMessage(
        config,
        {
          cloudAgentSessionId: first.cloudAgentSessionId,
          prompt: fakeDirective('echo:third'),
          signal,
        },
        api
      )
    );

    const container = await deadline.within('container', signal =>
      sandbox.waitForContainer({
        cloudAgentSessionId: first.cloudAgentSessionId,
        kiloSessionId: first.kiloSessionId,
        timeoutMs: Math.max(1, Math.min(CONTAINER_BUDGET_MS, deadline.remaining('container'))),
        signal,
      })
    );
    if (container === null) return fail('new sandbox did not appear');

    const thirdTerminal = await stream.waitFor(
      e =>
        messagePhase(e) !== null &&
        messagePhase(e) !== 'queued' &&
        messageIdFromEvent(e) === third.messageId,
      deadline.remaining('third terminal')
    );
    if (!thirdTerminal) {
      return fail(
        `third message ${third.messageId} did not terminate (first=${first.messageId} second=${second.messageId})`
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
 * Strategy: hold the first message on a running `slow:120:1000:16` turn so it
 * stays active-but-busy in the wrapper, freeing the pending slot. Then enqueue
 * echoes (pending → capacity) until the server rejects one, within a stated
 * fill budget, and interrupt to clear the queue.
 */
async function queueOverflowBody(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = QUEUE_OVERFLOW_TIMEOUT_MS, api = 'unified' } = args;
  const scenarioName = 'queue-overflow';
  const sandbox = sessionSandboxObservation(env);
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
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
    const hold = await startPacedHold(
      deadline,
      config,
      sandbox,
      api,
      'slow:120:1000:16',
      scenarioName
    );
    stream = hold.stream;
    const sessionId = hold.boot.cloudAgentSessionId;

    // Fill the queue until enqueue starts failing with 429. The limit is
    // server-enforced (PENDING_SESSION_MESSAGE_LIMIT); the exact boundary
    // depends on whether the held turn counts toward it, so we just drain until
    // we hit the wall rather than guessing the count. Each fill call is bounded
    // by the remaining fill budget, the whole loop leaves the scenario deadline
    // room for the interrupt and drain below, and a rejection observed after the
    // budget is not accepted as evidence.
    const fillBudget = Math.max(
      500,
      Math.min(FILL_BUDGET_MS, deadline.remaining('fill budget') - 2_000)
    );
    const fillDeadlineAt = Date.now() + fillBudget;
    const queuedIds: string[] = [];
    let overflowOk = false;
    let overflowMessage = `no 429 within ${fillBudget}ms fill budget`;
    for (let i = 0; i < 20; i++) {
      const fillRemaining = fillDeadlineAt - Date.now();
      if (fillRemaining <= 0) {
        overflowMessage = `no 429 within ${fillBudget}ms fill budget (${queuedIds.length} queued)`;
        break;
      }
      try {
        const ack = await deadline.within(
          `fill-${i}`,
          signal =>
            sendMessage(
              config,
              {
                cloudAgentSessionId: sessionId,
                prompt: fakeDirective(`echo:q${i}`),
                signal,
              },
              api
            ),
          fillRemaining
        );
        if (ack.delivery !== 'queued') {
          return fail(`fill-${i}: expected delivery=queued, got ${ack.delivery}`);
        }
        queuedIds.push(ack.messageId);
      } catch (err) {
        const msg = errorMessage(err);
        const is429 = msg.includes('429') || /TOO_MANY_REQUESTS|PENDING_QUEUE_FULL/.test(msg);
        if (!is429) throw err;
        if (Date.now() > fillDeadlineAt) {
          overflowMessage = `queue rejection observed after the ${fillBudget}ms fill budget`;
          break;
        }
        overflowOk = true;
        overflowMessage = `filled ${queuedIds.length} before rejection: ${msg.split('—').slice(-1)[0]?.trim() ?? '429'}`;
        break;
      }
    }

    // Interrupt after proving capacity. Draining the overflow queue naturally can
    // outlive this row and keep sandbox retry work active while later smoke cases
    // are cold-starting. The interrupt path is already responsible for clearing
    // queued messages, so wait for those durable failure events before returning.
    await deadline.within('interrupt', signal => interruptSession(config, sessionId, signal));
    const activeStream = stream;
    const queuedFailures = await Promise.all(
      queuedIds.map(messageId =>
        activeStream.waitFor(
          event =>
            event.streamEventType === 'cloud.message.failed' &&
            messageIdFromEvent(event) === messageId,
          deadline.remaining(`queued failure ${messageId}`)
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
        : `expected queue rejection within fill budget; got: ${overflowMessage}`,
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
 * queue-interrupt-clears: enqueue messages behind a running paced turn, fire
 * `interruptSession`, assert all queued messages surface
 * `cloud.message.failed` with `reason: 'interrupted'` and `delivery: 'queued'`.
 */
async function queueInterruptClearsBody(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = INTERRUPT_CLEARS_TIMEOUT_MS, api = 'unified' } = args;
  const scenarioName = 'queue-interrupt-clears';
  const sandbox = sessionSandboxObservation(env);
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
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
    const hold = await startPacedHold(
      deadline,
      config,
      sandbox,
      api,
      'slow:60:1000:16',
      scenarioName
    );
    stream = hold.stream;
    const sessionId = hold.boot.cloudAgentSessionId;

    const second = await deadline.within('second send', signal =>
      sendMessage(
        config,
        { cloudAgentSessionId: sessionId, prompt: fakeDirective('echo:second'), signal },
        api
      )
    );
    const third = await deadline.within('third send', signal =>
      sendMessage(
        config,
        { cloudAgentSessionId: sessionId, prompt: fakeDirective('echo:third'), signal },
        api
      )
    );

    if (second.delivery !== 'queued' || third.delivery !== 'queued') {
      return fail(
        `expected delivery=queued for both follow-ups; got second=${second.delivery}, third=${third.delivery}`
      );
    }

    await deadline.within('interrupt', signal => interruptSession(config, sessionId, signal));

    // Expect cloud.message.failed for both queued follow-ups.
    const secondFailed = await stream.waitFor(
      e =>
        e.streamEventType === 'cloud.message.failed' && messageIdFromEvent(e) === second.messageId,
      deadline.remaining('second failure')
    );
    const thirdFailed = await stream.waitFor(
      e =>
        e.streamEventType === 'cloud.message.failed' && messageIdFromEvent(e) === third.messageId,
      deadline.remaining('third failure')
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
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = INTERRUPT_MID_STREAM_TIMEOUT_MS, api = 'unified' } =
    args;
  const scenarioName = 'interrupt-mid-stream';
  const sandbox = sessionSandboxObservation(env);
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
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
    const hold = await startPacedHold(
      deadline,
      config,
      sandbox,
      api,
      'slow:90:1000:16',
      scenarioName
    );
    stream = hold.stream;
    const sessionId = hold.boot.cloudAgentSessionId;

    await deadline.within('interrupt', signal => interruptSession(config, sessionId, signal));

    const failed = await stream.waitFor(
      e =>
        e.streamEventType === 'cloud.message.failed' &&
        messageIdFromEvent(e) === hold.held.messageId,
      deadline.remaining('active failure')
    );
    const events = [...stream.events];

    if (!failed) {
      return fail(`no cloud.message.failed for active message ${hold.held.messageId}`);
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
  return queueWhileBusyBody(args, env);
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
  return queueOverflowBody(args, env);
}

export async function runQueueInterruptClears(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  return queueInterruptClearsBody(args, env);
}

export async function runInterruptMidStream(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  return interruptMidStreamBody(args, env);
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
    defaultTimeoutMs: QUEUE_OVERFLOW_TIMEOUT_MS,
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
