/**
 * Control-plane drain scenarios for work that outlives the model's first reply.
 *
 * Callback completion is the observation point: the Worker emits it only after
 * the control-plane operation finishes the turn, and that operation now waits
 * for kilo's drain. A linked child or background task must keep that callback
 * from arriving while the child is still held. A cron or wakeup must not hold
 * the scheduling turn, and the scheduled resume must still run after that turn
 * completes.
 *
 * These drive the unified `start` surface (the control plane) via
 * `defaultApi: 'unified'`. `start` does not accept `callbackTarget`, so the sink
 * is registered on the session through `updateSession` right after start.
 *
 * They are not in the default smoke matrix. The sandbox image's pinned CLI
 * may not advertise background subagents, cron_create, or schedule_wakeup.
 */
import {
  fakeDirective,
  interruptSession,
  openStream,
  registerSessionCallback,
  releaseGate,
  startSession,
  waitForGateEngaged,
  type StreamConnection,
  type StreamEvent,
} from './client.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';
import type { SharedScenario } from './scenarios-shared.js';
import {
  createScenarioDeadline,
  sessionSandboxObservation,
  trackStartedSession,
  type ScenarioDeadline,
} from './scenarios-shared-runtime.js';
import type {
  CallbackPayload,
  CallbackSink,
  ScenarioEnvironment,
} from './scenario-capabilities.js';

const CLEANUP_TIMEOUT_MS = 15_000;
const CHILD_HOLD_MS = 8_000;
const SCHEDULE_DELAY = '20s';
const SCHEDULE_GAP_MS = 8_000;
const DRAIN_SCENARIO_TIMEOUT_MS = 180_000;

type DrainResult = {
  ok: boolean;
  message: string;
  events: StreamEvent[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function callbackObservation(env: ScenarioEnvironment | undefined) {
  if (!env?.callbacks) throw new Error('callbacks capability is required');
  return env.callbacks;
}

function assistantTexts(events: StreamEvent[]): string[] {
  const assistantIds = new Set<string>();
  const parts = new Map<string, { messageID: string; text: string }>();
  for (const event of events) {
    if (event.streamEventType !== 'kilocode') continue;
    const data = asRecord(event.data);
    if (!data) continue;
    const name = typeof data.type === 'string' ? data.type : data.event;
    const properties = asRecord(data.properties);
    if (!properties) continue;
    if (name === 'message.updated') {
      const info = asRecord(properties.info);
      if (info?.role === 'assistant' && typeof info.id === 'string') assistantIds.add(info.id);
      continue;
    }
    if (name !== 'message.part.updated') continue;
    const part = asRecord(properties.part);
    if (!part || part.type !== 'text' || typeof part.id !== 'string') continue;
    const metadata = asRecord(part.metadata);
    if (metadata?.['kilocode.lifecycle'] === 'transient') continue;
    if (typeof part.messageID !== 'string' || typeof part.text !== 'string') continue;
    parts.set(part.id, { messageID: part.messageID, text: part.text });
  }
  return [...parts.values()]
    .filter(part => assistantIds.has(part.messageID))
    .map(part => part.text);
}

function textEndsWith(text: string, payload: string): boolean {
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${payload}$`).test(text) || text === payload;
}

async function openDrainSession(
  deadline: ScenarioDeadline,
  args: LifecycleArgs,
  sink: CallbackSink,
  directive: string
): Promise<{
  sessionId: string;
  messageId: string;
  stream: StreamConnection;
}> {
  const { config, api = 'unified' } = args;
  const session = await deadline.within('start', signal =>
    startSession(
      trackStartedSession(config, () => {}),
      {
        prompt: fakeDirective(directive),
        signal,
      },
      api
    )
  );
  await deadline.within('callback target', signal =>
    registerSessionCallback(
      config,
      session.cloudAgentSessionId,
      { url: sink.callbackUrl },
      signal
    )
  );
  const stream = openStream(config, session.cloudAgentSessionId, { replay: false });
  if (!args.env) throw new Error('scenario environment is required');
  const sandbox = sessionSandboxObservation(args.env);
  const container = await deadline.within('container', signal =>
    sandbox.waitForContainer({
      cloudAgentSessionId: session.cloudAgentSessionId,
      kiloSessionId: session.kiloSessionId,
      timeoutMs: Math.max(1, Math.min(60_000, deadline.remaining('container'))),
      signal,
    })
  );
  if (container === null) throw new Error('sandbox did not appear');
  return {
    sessionId: session.cloudAgentSessionId,
    messageId: session.messageId,
    stream,
  };
}

async function runHeldChild(
  args: LifecycleArgs,
  scenarioName: string,
  directive: string,
  childTag: string
): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = DRAIN_SCENARIO_TIMEOUT_MS } = args;
  const deadline = createScenarioDeadline(start, timeoutMs);
  const callbacks = callbackObservation(args.env);
  let sink: CallbackSink | null = null;
  let stream: StreamConnection | null = null;
  let sessionId: string | undefined;
  let completed = false;
  try {
    sink = await deadline.within('callback open', signal => callbacks.open(signal));
    const opened = await openDrainSession(deadline, args, sink, directive);
    stream = opened.stream;
    sessionId = opened.sessionId;
    const engaged = await deadline.within('child gate', signal =>
      waitForGateEngaged(config, childTag, deadline.remaining('child gate'), 100, signal)
    );
    if (!engaged) {
      return result(scenarioName, conversation, start, stream, {
        ok: false,
        message: `child gate ${childTag} did not engage`,
        events: [...stream.events],
      });
    }
    const holdMs = Math.min(CHILD_HOLD_MS, deadline.remaining('held child'));
    const early = await sink.waitFor(
      payload =>
        payload.cloudAgentSessionId === opened.sessionId && payload.messageId === opened.messageId,
      holdMs,
      AbortSignal.timeout(holdMs)
    );
    if (early) {
      return result(scenarioName, conversation, start, stream, {
        ok: false,
        message: `completion callback arrived while child gate ${childTag} was still holding (status=${early.status})`,
        events: [...stream.events],
      });
    }
    await deadline.within('release child', signal =>
      releaseGate(config.fakeLlmUrl, childTag, signal)
    );
    const payload = await sink.waitFor(
      candidate =>
        candidate.cloudAgentSessionId === opened.sessionId &&
        candidate.messageId === opened.messageId,
      deadline.remaining('callback after release')
    );
    if (!payload) {
      return result(scenarioName, conversation, start, stream, {
        ok: false,
        message: 'no callback after the child gate was released',
        events: [...stream.events],
      });
    }
    const ok = payload.status === 'completed' && payload.messageId === opened.messageId;
    completed = ok;
    return result(scenarioName, conversation, start, stream, {
      ok,
      message: ok
        ? `callback waited for child ${childTag} then completed`
        : `callback after release status=${payload.status}`,
      events: [...stream.events],
    });
  } catch (error) {
    return result(scenarioName, conversation, start, stream, {
      ok: false,
      message: `threw: ${error instanceof Error ? error.message : String(error)}`,
      events: stream ? [...stream.events] : [],
    });
  } finally {
    if (!completed && sessionId) {
      await interruptSession(config, sessionId, AbortSignal.timeout(CLEANUP_TIMEOUT_MS)).catch(
        () => {}
      );
    }
    try {
      stream?.close();
    } catch {
      /* best-effort close */
    }
    await sink?.close().catch(() => {});
  }
}

async function runScheduledResume(
  args: LifecycleArgs,
  scenarioName: string,
  directive: string,
  tag: string
): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = DRAIN_SCENARIO_TIMEOUT_MS } = args;
  const deadline = createScenarioDeadline(start, timeoutMs);
  const callbacks = callbackObservation(args.env);
  let sink: CallbackSink | null = null;
  let stream: StreamConnection | null = null;
  let sessionId: string | undefined;
  let completed = false;
  const fired = `fired-${tag}`;
  try {
    sink = await deadline.within('callback open', signal => callbacks.open(signal));
    const opened = await openDrainSession(deadline, args, sink, directive);
    stream = opened.stream;
    sessionId = opened.sessionId;
    const payload = await sink.waitFor(
      candidate =>
        candidate.cloudAgentSessionId === opened.sessionId &&
        candidate.messageId === opened.messageId,
      deadline.remaining('scheduling callback')
    );
    if (!payload) {
      return result(scenarioName, conversation, start, stream, {
        ok: false,
        message: 'no callback for the scheduling turn',
        events: [...stream.events],
      });
    }
    if (payload.status !== 'completed') {
      return result(scenarioName, conversation, start, stream, {
        ok: false,
        message:
          `scheduling turn did not complete (status=${payload.status}). ` +
          'This kilo may not advertise the schedule tool.',
        events: [...stream.events],
      });
    }
    const callbackAt = Date.now();
    const resumed = await deadline.within('scheduled resume', async signal => {
      const ready = (): boolean =>
        assistantTexts(stream?.events ?? []).some(text => textEndsWith(text, fired));
      if (ready()) return true;
      await stream?.waitFor(
        () => ready() || signal.aborted,
        deadline.remaining('scheduled resume')
      );
      return ready();
    });
    if (!resumed) {
      return result(scenarioName, conversation, start, stream, {
        ok: false,
        message:
          'scheduling turn completed, but the scheduled resume never produced assistant text. ' +
          'Drain may have let the sandbox stop before the schedule fired.',
        events: [...stream.events],
      });
    }
    const gapMs = Date.now() - callbackAt;
    const heldUntilFire = gapMs < SCHEDULE_GAP_MS;
    const ok = !heldUntilFire;
    completed = ok;
    return result(scenarioName, conversation, start, stream, {
      ok,
      message: heldUntilFire
        ? `scheduling callback arrived only ${gapMs}ms before the resume, so the pending schedule held drain`
        : `scheduling callback completed ${gapMs}ms before resume text ${fired}`,
      events: [...stream.events],
    });
  } catch (error) {
    return result(scenarioName, conversation, start, stream, {
      ok: false,
      message: `threw: ${error instanceof Error ? error.message : String(error)}`,
      events: stream ? [...stream.events] : [],
    });
  } finally {
    if (!completed && sessionId) {
      await interruptSession(config, sessionId, AbortSignal.timeout(CLEANUP_TIMEOUT_MS)).catch(
        () => {}
      );
    }
    try {
      stream?.close();
    } catch {
      /* best-effort close */
    }
    await sink?.close().catch(() => {});
  }
}

function result(
  name: string,
  conversation: string,
  start: number,
  stream: StreamConnection | null,
  outcome: DrainResult
): LifecycleResult {
  return {
    name,
    conversation,
    ok: outcome.ok,
    message: outcome.message,
    events: outcome.events.length > 0 ? outcome.events : stream ? [...stream.events] : [],
    durationMs: Date.now() - start,
  };
}

function chosenDirective(conversation: string, fallback: string): string {
  return conversation && conversation !== '_' ? conversation : fallback;
}

function childTag(directive: string): string {
  const match = directive.match(/^(?:background-task|task):[A-Za-z0-9_-]+:([A-Za-z0-9_-]+)$/);
  if (!match?.[1])
    throw new Error(`drain child directive must be task:parent:child, got ${directive}`);
  return match[1];
}

function scheduleTag(directive: string): string {
  const match = directive.match(/^(?:cron|wakeup):([A-Za-z0-9_-]+):\d+s$/);
  if (!match?.[1])
    throw new Error(`drain schedule directive must be cron|wakeup:tag:<n>s, got ${directive}`);
  return match[1];
}

export const DRAIN_SHARED_SCENARIOS: Record<string, SharedScenario> = {
  'drain-linked-child': {
    name: 'drain-linked-child',
    requires: ['callbacks', 'sessionSandbox', 'gates'],
    defaultConversation: 'task:drainparent:drainchild',
    defaultApi: 'unified',
    defaultTimeoutMs: DRAIN_SCENARIO_TIMEOUT_MS,
    run: (args, env) => {
      const directive = chosenDirective(args.conversation, 'task:drainparent:drainchild');
      return runHeldChild({ ...args, env }, 'drain-linked-child', directive, childTag(directive));
    },
  },
  'drain-background-child': {
    name: 'drain-background-child',
    requires: ['callbacks', 'sessionSandbox', 'gates'],
    defaultConversation: 'background-task:drainbg:drainheld',
    defaultApi: 'unified',
    defaultTimeoutMs: DRAIN_SCENARIO_TIMEOUT_MS,
    run: (args, env) => {
      const directive = chosenDirective(args.conversation, 'background-task:drainbg:drainheld');
      return runHeldChild(
        { ...args, env },
        'drain-background-child',
        directive,
        childTag(directive)
      );
    },
  },
  'drain-scheduled-cron': {
    name: 'drain-scheduled-cron',
    requires: ['callbacks', 'sessionSandbox'],
    defaultConversation: `cron:draincron:${SCHEDULE_DELAY}`,
    defaultApi: 'unified',
    defaultTimeoutMs: DRAIN_SCENARIO_TIMEOUT_MS,
    run: (args, env) => {
      const directive = chosenDirective(args.conversation, `cron:draincron:${SCHEDULE_DELAY}`);
      return runScheduledResume(
        { ...args, env },
        'drain-scheduled-cron',
        directive,
        scheduleTag(directive)
      );
    },
  },
  'drain-scheduled-wakeup': {
    name: 'drain-scheduled-wakeup',
    requires: ['callbacks', 'sessionSandbox'],
    defaultConversation: `wakeup:drainwake:${SCHEDULE_DELAY}`,
    defaultApi: 'unified',
    defaultTimeoutMs: DRAIN_SCENARIO_TIMEOUT_MS,
    run: (args, env) => {
      const directive = chosenDirective(args.conversation, `wakeup:drainwake:${SCHEDULE_DELAY}`);
      return runScheduledResume(
        { ...args, env },
        'drain-scheduled-wakeup',
        directive,
        scheduleTag(directive)
      );
    },
  },
};
