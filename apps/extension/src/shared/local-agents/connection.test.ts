/* eslint-disable typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface */
import { describe, expect, it } from 'vitest';
import { createLocalAgentConnection } from './connection';
import type { LocalAgentConnectionState } from './connection-state';
import type { LocalAgentIncomingEnvelope } from './envelope';
import type {
  LocalAgentDial,
  LocalAgentTransportCallbacks,
  LocalAgentTransportHandle,
} from './transport-types';

/*
 * The union has six members; these tests walk the named transitions and prove
 * a late callback from an older attempt cannot move the current state.
 */

type FakeTimers = {
  clearTimeout(handle: number): void;
  runDue(delayMs: number): void;
  scheduled: { callback: () => void; delayMs: number; id: number }[];
  setTimeout(callback: () => void, delayMs: number): number;
};

const createFakeTimers = (): FakeTimers => {
  const scheduled: { callback: () => void; delayMs: number; id: number }[] = [];
  let nextId = 0;

  return {
    clearTimeout: (handle: unknown) => {
      const index = scheduled.findIndex(entry => entry.id === handle);

      if (index !== -1) {
        scheduled.splice(index, 1);
      }
    },
    runDue: (delayMs: number) => {
      for (const entry of scheduled.filter(candidate => candidate.delayMs <= delayMs)) {
        scheduled.splice(scheduled.indexOf(entry), 1);
        entry.callback();
      }
    },
    scheduled,
    setTimeout: (callback: () => void, delayMs: number) => {
      nextId += 1;
      scheduled.push({ callback, delayMs, id: nextId });

      return nextId;
    },
  };
};

const createDialHarness = () => {
  const dials: LocalAgentTransportCallbacks[] = [];
  const handles: { closed: number }[] = [];
  const dial: LocalAgentDial = (callbacks): LocalAgentTransportHandle => {
    dials.push(callbacks);
    const handle = { closed: 0 };
    handles.push(handle);

    return {
      close: () => {
        handle.closed += 1;
      },
      send: () => {
        /* This harness only records connection state. */
      },
    };
  };

  return { dial, dials, handles };
};

const createConnection = (options: {
  dial: LocalAgentDial;
  now: () => number;
  timers: FakeTimers;
}) => {
  const states: LocalAgentConnectionState[] = [];
  const envelopes: LocalAgentIncomingEnvelope[] = [];
  const connection = createLocalAgentConnection({
    dial: options.dial,
    endpoint: {
      endpointId: 'hub-1',
      hubId: 'hub-1',
      key: 'k',
      transport: 'loopback',
      ws: 'ws://127.0.0.1:47917/__kilo_browser',
    },
    now: options.now,
    onEnvelope: envelope => {
      envelopes.push(envelope);
    },
    onStateChange: state => {
      states.push(state);
    },
    timers: options.timers,
  });

  return { connection, envelopes, states };
};

describe('connection state union', () => {
  it('walks off -> connecting -> handshaking -> connected', () => {
    const timers = createFakeTimers();
    const { dials, dial } = createDialHarness();
    const { connection, states } = createConnection({ dial, now: () => 0, timers });

    connection.connect();
    expect(connection.state()).toStrictEqual({ attempt: 1, kind: 'handshaking' });

    dials[0]?.onReady();
    expect(connection.state()).toStrictEqual({ attempt: 1, kind: 'connected' });
    expect(states.map(state => state.kind)).toStrictEqual([
      'connecting',
      'handshaking',
      'connected',
    ]);
  });

  it('maps a transport failure to backoff and retries only when due', () => {
    const timers = createFakeTimers();
    const { dials, dial } = createDialHarness();
    let currentTime = 1000;
    const { connection } = createConnection({ dial, now: () => currentTime, timers });

    connection.connect();
    dials[0]?.onClosed({ kind: 'transport' });
    expect(connection.state()).toStrictEqual({ attempt: 1, kind: 'backoff', until: 2000 });

    connection.connect();
    expect(dials).toHaveLength(1);

    currentTime = 2000;
    timers.runDue(1000);
    expect(dials).toHaveLength(2);
    expect(connection.state()).toStrictEqual({ attempt: 2, kind: 'handshaking' });
  });

  it('maps a missing native host to host_missing and retries on the watchdog cadence', () => {
    const timers = createFakeTimers();
    const { dials, dial } = createDialHarness();
    const { connection } = createConnection({ dial, now: () => 0, timers });

    connection.connect();
    dials[0]?.onClosed({ kind: 'host_missing', reason: 'not_installed' });
    expect(connection.state()).toStrictEqual({ kind: 'host_missing', reason: 'not_installed' });
    expect(timers.scheduled[0]?.delayMs).toBe(30_000);

    timers.runDue(30_000);
    expect(dials).toHaveLength(2);
  });

  it('drops callbacks from an older attempt', () => {
    const timers = createFakeTimers();
    const { dials, dial } = createDialHarness();
    let currentTime = 0;
    const { connection } = createConnection({ dial, now: () => currentTime, timers });

    connection.connect();
    const [first] = dials;
    first?.onClosed({ kind: 'transport' });
    currentTime = 10_000;
    timers.runDue(1000);
    expect(dials).toHaveLength(2);

    // The first attempt's late hello must not make the second attempt look connected.
    first?.onReady();
    expect(connection.state()).toStrictEqual({ attempt: 2, kind: 'handshaking' });

    dials[1]?.onReady();
    expect(connection.state()).toStrictEqual({ attempt: 2, kind: 'connected' });
  });

  it('closes the transport and settles on off', () => {
    const timers = createFakeTimers();
    const { dials, dial, handles } = createDialHarness();
    const { connection } = createConnection({ dial, now: () => 0, timers });

    connection.connect();
    dials[0]?.onReady();
    connection.close();

    expect(connection.state()).toStrictEqual({ kind: 'off' });
    expect(handles[0]?.closed).toBe(1);

    // A closed connection never reconnects.
    connection.connect();
    expect(dials).toHaveLength(1);
  });
});
