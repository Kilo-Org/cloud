import { describe, expect, it } from 'bun:test';
import type {
  ControlPlanePromptPayload,
  ControlPlaneRouteSpec,
  ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import { CONTROL_PLANE_TIMERS } from '../../../src/shared/control-plane-timers.js';
import type { Harness } from './harness.js';
import { createKiloEventFeed } from './kilo-event-feed.js';
import { createTurnManager, type TurnKiloRuntime } from './turn.js';

const DIRECTORY = '/workspace/session';
const KILO_SESSION = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const CHILD_SESSION = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
const SESSION_ID = 'workspace_test';
const NATIVE_RUNTIME_ID = 'rt_wire';
const DEADLINE_MS = 5000;
const TEST_TIMEOUT_MS = 20_000;

type FeedEvent = { type: string; properties: Record<string, unknown> };

/** One `/global/event` frame: the shape `unfilteredKiloEvents` reads. */
type WireEnvelope = { payload: FeedEvent };

type FeedFixture = {
  origin: string;
  /** Every envelope written to the stream, in wire order. */
  sent: WireEnvelope[];
  send(event: FeedEvent): void;
  /** Ends the response, so the feed drains what it read and reports the end. */
  end(): void;
  stop(): Promise<void>;
};

/**
 * A Kilo `/global/event` server in front of the real event feed. Any other path
 * answers with a small JSON body so the client has nothing else to fail on.
 */
function startFeedFixture(): FeedFixture {
  const encoder = new TextEncoder();
  const sent: WireEnvelope[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let ended = false;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== '/global/event') return Response.json({ data: {} });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            // `open()` reads one event before it resolves; this stream stays live after it.
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ payload: { type: 'server.connected', properties: {} } })}\n\n`
              )
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      );
    },
  });
  return {
    origin: server.url.origin,
    sent,
    send(event) {
      const envelope: WireEnvelope = { payload: event };
      if (stream === undefined) throw new Error('The event stream is not open yet');
      sent.push(envelope);
      stream.enqueue(encoder.encode(`data: ${JSON.stringify(envelope)}\n\n`));
    },
    end() {
      if (stream === undefined || ended) return;
      ended = true;
      stream.close();
    },
    stop: () => server.stop(true),
  };
}

/**
 * The parts of a runtime these events reach. The stub has no native drain, so the
 * completed close owns the outcome, and no session is live on it.
 */
function runtimeStub(onSubmit: () => void): TurnKiloRuntime {
  const client = {
    submit: async () => {
      onSubmit();
    },
  } as unknown as Harness;
  return {
    nativeRuntimeId: NATIVE_RUNTIME_ID,
    directory: DIRECTORY,
    env: {},
    client,
    ensure: async () => client,
    isSuspected: () => false,
    isRestarting: () => false,
    isUnavailable: () => false,
    isRetiredClient: () => false,
    sessionState: () => undefined,
    liveTreeExecutions: () => undefined,
    refreshActivity: async () => undefined,
  };
}

function routeSpec(): ControlPlaneRouteSpec {
  return {
    sessionId: SESSION_ID,
    kiloSessionId: KILO_SESSION,
    directory: DIRECTORY,
    attemptId: 'attempt-1',
  };
}

function promptPayload(): ControlPlanePromptPayload {
  return {
    messageId: 'm1',
    turn: { type: 'prompt', prompt: 'hello' },
    agent: { mode: 'code', model: 'test/model' },
  };
}

function outcomeFrames(frames: ControlPlaneWrapperFrame[]) {
  return frames.flatMap(frame => (frame.type === 'session.outcome' ? [frame] : []));
}

/**
 * Bounds one awaited condition and fails with a deadline error. This test drives a
 * real socket through the real event feed, so its waits are real time.
 */
async function withinDeadline<T>(promise: Promise<T>, description: string): Promise<T> {
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => expired.reject(new Error(`Timed out waiting for ${description}`)),
    DEADLINE_MS
  );
  try {
    return await Promise.race([promise, expired.promise]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drives one turn over the wire: the real event feed reads the fixture's SSE
 * stream, and each event reaches the real turn manager exactly as the feed
 * produced it. `drive` writes the envelopes under test.
 */
async function runTurnOverWire(drive: (send: (event: FeedEvent) => void) => void): Promise<{
  frames: ControlPlaneWrapperFrame[];
  sent: WireEnvelope[];
}> {
  const fixture = startFeedFixture();
  const frames: ControlPlaneWrapperFrame[] = [];
  const dispatched = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const feedEnded = Promise.withResolvers<void>();
  const manager = createTurnManager({
    timers: CONTROL_PLANE_TIMERS,
    emit: frame => {
      frames.push(frame);
      if (frame.type === 'session.outcome') completed.resolve();
    },
    runtimes: { get: () => runtimeStub(() => dispatched.resolve()) },
    log: () => undefined,
  });
  const feed = createKiloEventFeed({
    source: {
      server: { url: fixture.origin },
      directory: DIRECTORY,
      nativeRuntimeId: NATIVE_RUNTIME_ID,
    },
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    onEvent: event => manager.observeKiloEvent(event),
    onFailure: () => feedEnded.resolve(),
    log: () => undefined,
  });

  try {
    await withinDeadline(feed.open(), 'the event feed connection');
    manager.registerRoute(routeSpec());
    manager.submit(SESSION_ID, promptPayload());
    await withinDeadline(dispatched.promise, 'the prompt dispatch');
    fixture.send({ type: 'session.turn.open', properties: { sessionID: KILO_SESSION } });
    drive(fixture.send);
    await withinDeadline(completed.promise, 'the completed outcome');
    return { frames, sent: fixture.sent };
  } finally {
    // The feed drains an ended response before it is closed, so the stream ends cleanly.
    fixture.end();
    await withinDeadline(feedEnded.promise, 'the event feed end').catch(() => undefined);
    feed.close();
    manager.shutdown();
    await fixture.stop();
  }
}

describe('completion gate attribution over the event feed', () => {
  it(
    'completes a turn without a gate result when a child session reports one',
    async () => {
      const { frames, sent } = await runTurnOverWire(send => {
        send({
          type: 'session.created',
          properties: { info: { id: CHILD_SESSION, parentID: KILO_SESSION } },
        });
        send({
          type: 'session.status',
          properties: { sessionID: CHILD_SESSION, status: { type: 'idle' }, gateResult: 'fail' },
        });
        send({
          type: 'session.turn.close',
          properties: { sessionID: KILO_SESSION, reason: 'completed' },
        });
      });

      const [outcome] = outcomeFrames(frames);
      expect(outcome).toMatchObject({ status: 'completed', lastMessageId: 'm1' });
      expect(outcome).not.toHaveProperty('gateResult');
      // The property crossed the wire, so this outcome is not the fixture being silent.
      const childStatus = sent.find(
        envelope =>
          envelope.payload.type === 'session.status' &&
          envelope.payload.properties.sessionID === CHILD_SESSION
      );
      expect(childStatus?.payload.properties.gateResult).toBe('fail');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'completes a turn with the gate result its own session reports',
    async () => {
      const { frames, sent } = await runTurnOverWire(send => {
        send({
          type: 'session.status',
          properties: { sessionID: KILO_SESSION, status: { type: 'idle' }, gateResult: 'pass' },
        });
        send({
          type: 'session.turn.close',
          properties: { sessionID: KILO_SESSION, reason: 'completed' },
        });
      });

      expect(outcomeFrames(frames)).toMatchObject([
        { status: 'completed', lastMessageId: 'm1', gateResult: 'pass' },
      ]);
      const rootStatus = sent.find(
        envelope =>
          envelope.payload.type === 'session.status' &&
          envelope.payload.properties.sessionID === KILO_SESSION
      );
      expect(rootStatus?.payload.properties.gateResult).toBe('pass');
    },
    TEST_TIMEOUT_MS
  );
});
