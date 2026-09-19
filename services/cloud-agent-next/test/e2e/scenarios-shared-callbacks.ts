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
 * The bounded `slow` hold is the first turn, not a parked gate: it self-
 * terminates, needs no global release, and the fake request baseline is
 * captured before the start so readiness is attributed to this turn.
 */

import {
  fakeDirective,
  interruptSession,
  isMessageCompleted,
  messageIdFromEvent,
  messagePhase,
  openConnectedStream,
  openStream,
  sendMessage,
  startSession,
  type ApiVersion,
  type DriverConfig,
  type StreamConnection,
} from './client.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';
import type { SharedScenario } from './scenarios-shared.js';
import {
  createScenarioDeadline,
  sessionSandboxObservation,
  startPacedHoldTurn,
  trackStartedSession,
  type ScenarioDeadline,
} from './scenarios-shared-runtime.js';
import type {
  CallbackPayload,
  CallbackSink,
  ScenarioEnvironment,
  SessionSandboxObservation,
} from './scenario-capabilities.js';

const CALLBACK_BATCH_TIMEOUT_MS = 300_000;
const CALLBACK_INTERRUPT_TIMEOUT_MS = 300_000;
/** Boot/container budget, consumed before the action window starts. */
const CONTAINER_BUDGET_MS = 120_000;
/** Bound for the fast warm-up turn that proves the container is ready. */
const BOOT_TERMINAL_BUDGET_MS = 120_000;
/** Bound for the paced-progress readiness wait; the slow hold outlasts it. */
const PACED_PROGRESS_BUDGET_MS = 60_000;
/** Bound for one callback read/wait, capped by remaining scenario time. */
const CALLBACK_WAIT_MS = 20_000;
/**
 * Slack over the callback sink's own timeout for the enclosing deadline
 * backstop, so "no callback within 20s" is reported instead of a deadline error.
 */
const CALLBACK_WAIT_SLACK_MS = 1_000;
/** Bounded cleanup after a failed body. */
const CLEANUP_TIMEOUT_MS = 15_000;

/**
 * Bound one callback wait by the sink's own timeout and the remaining scenario
 * budget, and pass the per-operation signal. The single owner of the callback
 * wait cap, so a caller cannot accidentally wait unbounded.
 */
async function waitForCallback(
  deadline: ScenarioDeadline,
  sink: CallbackSink,
  label: string,
  predicate: (payload: CallbackPayload) => boolean
): Promise<CallbackPayload | null> {
  const budget = Math.max(1, Math.min(CALLBACK_WAIT_MS, deadline.remaining(label)));
  return deadline.within(
    label,
    signal => sink.waitFor(predicate, budget, signal),
    budget + CALLBACK_WAIT_SLACK_MS
  );
}

/** Read the sink's records under the remaining scenario budget and signal. */
async function readCallbacks(
  deadline: ScenarioDeadline,
  sink: CallbackSink,
  label: string
): Promise<CallbackPayload[]> {
  return deadline.within(label, signal => sink.records(signal));
}

function callbackObservation(
  env: ScenarioEnvironment
): NonNullable<ScenarioEnvironment['callbacks']> {
  if (!env.callbacks) throw new Error('callbacks capability is required');
  return env.callbacks;
}

function payloadsForSession(records: CallbackPayload[], cloudAgentSessionId: string): CallbackPayload[] {
  return records.filter(payload => payload.cloudAgentSessionId === cloudAgentSessionId);
}

type CallbackPacedHold = {
  boot: Awaited<ReturnType<typeof startSession>>;
  held: { messageId: string };
  stream: StreamConnection;
  container: string;
  /** Callback count for this session after the warm-up callback settled. */
  callbackBaseline: number;
};

/**
 * Boot the session on a fast warm-up turn with the callback target, observe its
 * container, wait for the warm-up callback, and only then start the bounded
 * `slow` hold. Baselining past the warm-up callback keeps the batch assertions
 * about the held/queued callbacks only. If this throws after acquiring the
 * stream or session, it closes and interrupts them itself: ownership transfers
 * to the caller only on return.
 */
async function startCallbackPacedHold(
  deadline: ReturnType<typeof createScenarioDeadline>,
  config: DriverConfig,
  sandbox: SessionSandboxObservation,
  api: ApiVersion,
  sink: CallbackSink,
  directive: string,
  label: string
): Promise<CallbackPacedHold> {
  let stream: StreamConnection | undefined;
  let sessionId: string | undefined;
  try {
    const boot = await deadline.within(`${label} boot start`, signal =>
      startSession(
        trackStartedSession(config, id => {
          sessionId = id;
        }),
        {
          prompt: fakeDirective('echo:warmup'),
          callbackTarget: { url: sink.callbackUrl },
          signal,
        },
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
    const warmupCallback = await waitForCallback(
      deadline,
      sink,
      `${label} warmup callback`,
      payload => payload.messageId === boot.messageId
    );
    if (warmupCallback === null) {
      throw new Error(`${label}: warm-up callback for ${boot.messageId} did not arrive`);
    }
    const callbackBaseline = payloadsForSession(
      await readCallbacks(deadline, sink, `${label} callback baseline`),
      boot.cloudAgentSessionId
    ).length;

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
    return { boot, held, stream: bootStream, container, callbackBaseline };
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
  const deadline = createScenarioDeadline(start, timeoutMs);

  let sink: CallbackSink | null = null;
  let stream: StreamConnection | null = null;
  let sessionId: string | undefined;
  let completed = false;
  try {
    sink = await deadline.within('callback open', signal => callbacks.open(signal));
    const activeSink = sink;
    const session = await deadline.within('start', signal =>
      startSession(
        trackStartedSession(config, id => {
          sessionId = id;
        }),
        {
          prompt: fakeDirective(directive),
          callbackTarget: { url: activeSink.callbackUrl },
          signal,
        },
        api
      )
    );
    sessionId = session.cloudAgentSessionId;
    const activeStream = openStream(config, session.cloudAgentSessionId, { replay: false });
    stream = activeStream;

    const container = await deadline.within('container', signal =>
      sandbox.waitForContainer({
        cloudAgentSessionId: session.cloudAgentSessionId,
        kiloSessionId: session.kiloSessionId,
        timeoutMs: Math.max(1, Math.min(60_000, deadline.remaining('container'))),
        signal,
      })
    );
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

    const terminal = await deadline.within('terminal', () =>
      activeStream.waitForTerminal(deadline.remaining('terminal'), session.messageId)
    );
    const events = [...activeStream.events];

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

    const payload = await waitForCallback(
      deadline,
      activeSink,
      'callback wait',
      candidate => candidate.cloudAgentSessionId === session.cloudAgentSessionId
    );
    if (!payload) {
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: 'no callback received within the bounded wait',
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
 * callback-batch-followup: boot on a fast warm-up turn, hold the next turn on a
 * bounded `slow:90:1000:16`, queue two follow-ups, let the hold complete, and
 * expect one message-correlated callback for the last queued message only; then
 * send a later hot follow-up and expect a fresh second callback, and no extra
 * callback after the batch settles.
 */
async function runCallbackBatchFollowup(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, timeoutMs = CALLBACK_BATCH_TIMEOUT_MS, api = 'unified' } = args;
  const scenarioName = 'callback-batch-followup';
  const directive = 'slow:90:1000:16';
  const callbacks = callbackObservation(env);
  const sandbox = sessionSandboxObservation(env);
  const deadline = createScenarioDeadline(start, timeoutMs);

  let sink: CallbackSink | null = null;
  let stream: StreamConnection | null = null;
  let cleanupSessionId: string | undefined;
  let batchCompleted = false;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation: directive,
    ok: false,
    message,
    events: stream ? [...stream.events] : [],
    durationMs: Date.now() - start,
  });

  try {
    sink = await deadline.within('callback open', signal => callbacks.open(signal));
    const activeSink = sink;
    const hold = await startCallbackPacedHold(
      deadline,
      config,
      sandbox,
      api,
      activeSink,
      directive,
      scenarioName
    );
    stream = hold.stream;
    cleanupSessionId = hold.boot.cloudAgentSessionId;
    const sessionId = hold.boot.cloudAgentSessionId;

    const second = await deadline.within('second send', signal =>
      sendMessage(
        config,
        {
          cloudAgentSessionId: sessionId,
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
          cloudAgentSessionId: sessionId,
          prompt: fakeDirective('echo:third'),
          signal,
        },
        api
      )
    );
    if (second.delivery !== 'queued' || third.delivery !== 'queued') {
      return fail(
        `expected queued follow-ups; got second=${second.delivery}, third=${third.delivery}`
      );
    }

    const thirdTerminal = await stream.waitFor(
      event =>
        messagePhase(event) !== null &&
        messagePhase(event) !== 'queued' &&
        messageIdFromEvent(event) === third.messageId,
      deadline.remaining('batch terminal')
    );
    if (!thirdTerminal || messagePhase(thirdTerminal) !== 'completed') {
      return fail(`queued batch did not complete on ${third.messageId}`);
    }

    const firstCallback = await waitForCallback(
      deadline,
      activeSink,
      'batch callback',
      payload => payload.messageId === third.messageId
    );
    const queuedBatchCallbacks = payloadsForSession(
      await readCallbacks(deadline, activeSink, 'batch records'),
      sessionId
    ).slice(hold.callbackBaseline);
    const queuedBatchCallbackIds = queuedBatchCallbacks.map(payload => payload.messageId);
    const batchCallbackOk =
      firstCallback !== null &&
      queuedBatchCallbacks.length === 1 &&
      firstCallback.status === 'completed' &&
      firstCallback.messageId === third.messageId &&
      firstCallback.lastAssistantMessageText === 'third' &&
      !queuedBatchCallbackIds.includes(hold.held.messageId) &&
      !queuedBatchCallbackIds.includes(second.messageId);
    if (!batchCallbackOk) {
      return fail(
        `queued callback batch mismatch: ids=${queuedBatchCallbackIds.join(',') || 'none'} status=${firstCallback?.status ?? 'missing'} text=${JSON.stringify(firstCallback?.lastAssistantMessageText)}`
      );
    }

    const afterBatch = await deadline.within('after-batch send', signal =>
      sendMessage(
        config,
        {
          cloudAgentSessionId: sessionId,
          prompt: fakeDirective('echo:after-batch'),
          signal,
        },
        api
      )
    );
    const afterBatchTerminal = await stream.waitFor(
      event =>
        messagePhase(event) !== null &&
        messagePhase(event) !== 'queued' &&
        messageIdFromEvent(event) === afterBatch.messageId,
      deadline.remaining('after-batch terminal')
    );
    if (!afterBatchTerminal || messagePhase(afterBatchTerminal) !== 'completed') {
      return fail(`sequential follow-up did not complete on ${afterBatch.messageId}`);
    }

    const secondCallback = await waitForCallback(
      deadline,
      activeSink,
      'sequential callback',
      payload => payload.messageId === afterBatch.messageId
    );
    const callbackPayloads = payloadsForSession(
      await readCallbacks(deadline, activeSink, 'sequential records'),
      sessionId
    ).slice(hold.callbackBaseline);
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
      return fail(
        `sequential callback mismatch: ids=${callbackIds.join(',') || 'none'} statuses=${statuses.join(',') || 'none'} texts=${JSON.stringify(texts)}`
      );
    }

    // The two post-baseline callbacks above are already validated, so the
    // expected total is baseline + 2. Reading the count again here would let a
    // callback that arrives during the read become the baseline and hide itself.
    const quietBaseline = hold.callbackBaseline + 2;
    await deadline.within(
      'quiet window',
      () => new Promise<void>(resolve => setTimeout(resolve, 2_000))
    );
    const afterQuiet = payloadsForSession(
      await readCallbacks(deadline, activeSink, 'quiet records'),
      sessionId
    );
    const events = [...stream.events];
    if (afterQuiet.length !== quietBaseline) {
      const extra = afterQuiet[quietBaseline];
      return {
        name: scenarioName,
        conversation: directive,
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
      conversation: `${directive} + echo:after-batch`,
      ok: true,
      message: `callbacks=${callbackIds.join(' -> ')}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: scenarioName,
      conversation: `${directive} + echo:after-batch`,
      ok: false,
      message: `threw: ${msg}`,
      events: stream ? [...stream.events] : [],
      durationMs: Date.now() - start,
    };
  } finally {
    if (!batchCompleted && cleanupSessionId) {
      await interruptSession(
        config,
        cleanupSessionId,
        AbortSignal.timeout(CLEANUP_TIMEOUT_MS)
      ).catch(() => {});
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
 * callback-interrupt: boot on a fast warm-up turn, hold an active execution on a
 * bounded `slow:90:1000:16`, interrupt it, and assert the message-correlated
 * callback fires with `status: 'interrupted'` for that exact `messageId`.
 */
async function runCallbackInterrupt(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, timeoutMs = CALLBACK_INTERRUPT_TIMEOUT_MS, api = 'unified' } = args;
  const scenarioName = 'callback-interrupt';
  const directive = 'slow:90:1000:16';
  const callbacks = callbackObservation(env);
  const sandbox = sessionSandboxObservation(env);
  const deadline = createScenarioDeadline(start, timeoutMs);

  let sink: CallbackSink | null = null;
  let stream: StreamConnection | null = null;
  let sessionId: string | undefined;
  let completed = false;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation: directive,
    ok: false,
    message,
    events: stream ? [...stream.events] : [],
    durationMs: Date.now() - start,
  });

  try {
    sink = await deadline.within('callback open', signal => callbacks.open(signal));
    const activeSink = sink;
    const hold = await startCallbackPacedHold(
      deadline,
      config,
      sandbox,
      api,
      activeSink,
      directive,
      scenarioName
    );
    stream = hold.stream;
    sessionId = hold.boot.cloudAgentSessionId;

    await deadline.within('interrupt', signal =>
      interruptSession(config, hold.boot.cloudAgentSessionId, signal)
    );

    const terminal = await stream.waitForTerminal(
      deadline.remaining('interrupted terminal'),
      hold.held.messageId
    );
    const events = [...stream.events];
    if (!terminal) {
      return fail('no terminal stream event after interrupt');
    }

    const payload = await waitForCallback(
      deadline,
      activeSink,
      'interrupted callback',
      candidate => candidate.messageId === hold.held.messageId
    );
    if (!payload) {
      return fail('no message-correlated callback received after interrupt');
    }

    const interrupted = payload.status === 'interrupted';
    completed = interrupted;
    return {
      name: scenarioName,
      conversation: directive,
      ok: interrupted,
      message: `callback status=${payload.status} messageId=${payload.messageId}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: scenarioName,
      conversation: directive,
      ok: false,
      message: `threw: ${msg}`,
      events: stream ? [...stream.events] : [],
      durationMs: Date.now() - start,
    };
  } finally {
    if (!completed && sessionId) {
      await interruptSession(
        config,
        sessionId,
        AbortSignal.timeout(CLEANUP_TIMEOUT_MS)
      ).catch(() => {});
    }
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
    defaultTimeoutMs: CALLBACK_BATCH_TIMEOUT_MS,
    run: runCallbackBatchFollowup,
  },
  'callback-interrupt': {
    name: 'callback-interrupt',
    requires: ['callbacks', 'sessionSandbox'],
    defaultConversation: '_',
    defaultApi: 'legacy',
    defaultTimeoutMs: CALLBACK_INTERRUPT_TIMEOUT_MS,
    run: runCallbackInterrupt,
  },
};
