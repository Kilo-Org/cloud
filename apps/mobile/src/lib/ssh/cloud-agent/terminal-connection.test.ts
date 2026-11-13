import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TerminalConnection,
  type TerminalOperations,
  type TerminalSocket,
  type TerminalState,
} from './terminal-connection';
import { parseTerminalFrame, type TerminalFrame } from './terminal-protocol';

const SANDBOX_SLEEPING = 'The sandbox is sleeping. Send a message to resume.';

type FakeSocket = TerminalSocket & {
  url: string;
  sent: Uint8Array[];
  closed: { code: number; reason: string }[];
  open(): void;
  message(data: string | ArrayBuffer): void;
  fail(): void;
  end(code: number, reason: string): void;
};

function createSocket(url: string): FakeSocket {
  const openListeners: (() => void)[] = [];
  const messageListeners: ((frame: TerminalFrame) => void)[] = [];
  const errorListeners: (() => void)[] = [];
  const closeListeners: ((event: { code: number; reason: string }) => void)[] = [];

  const socket: FakeSocket = {
    url,
    sent: [],
    closed: [],
    send(bytes) {
      socket.sent.push(bytes);
    },
    close(code, reason) {
      socket.closed.push({ code, reason });
    },
    onOpen(listener) {
      openListeners.push(listener);
    },
    onMessage(listener) {
      messageListeners.push(listener);
    },
    onError(listener) {
      errorListeners.push(listener);
    },
    onClose(listener) {
      closeListeners.push(listener);
    },
    open() {
      for (const listener of openListeners) {
        listener();
      }
    },
    fail() {
      for (const listener of errorListeners) {
        listener();
      }
    },
    message(raw) {
      const frame = parseTerminalFrame(raw);
      if (frame === null) {
        throw new Error('A socket message is text or binary');
      }
      for (const listener of messageListeners) {
        listener(frame);
      }
    },
    end(code, reason) {
      for (const listener of closeListeners) {
        listener({ code, reason });
      }
    },
  };

  return socket;
}

function trpcError(code: string, message: string) {
  return Object.assign(new Error(message), { data: { code, message } });
}

function createHarness(overrides: { operations?: Partial<TerminalOperations> } = {}) {
  const sockets: FakeSocket[] = [];
  const states: TerminalState[] = [];
  const data: Uint8Array[] = [];
  const closed: { exitStatus: number | null; error: string | null }[] = [];

  const operations: TerminalOperations = {
    create: vi.fn<TerminalOperations['create']>(() =>
      Promise.resolve({ ptyId: 'pty_1', wsUrl: '/terminal?ptyId=pty_1' })
    ),
    refreshTicket: vi.fn<TerminalOperations['refreshTicket']>(() =>
      Promise.resolve({ wsUrl: '/terminal?ptyId=pty_1&ticket=2' })
    ),
    resize: vi.fn<TerminalOperations['resize']>(),
    close: vi.fn<TerminalOperations['close']>(),
    ...overrides.operations,
  };

  const connection = new TerminalConnection({
    baseUrl: 'https://worker.test',
    operations,
    socketFor: url => {
      const socket = createSocket(url);
      sockets.push(socket);
      return socket;
    },
    onState: state => {
      states.push(state);
    },
    onData: bytes => {
      data.push(bytes);
    },
    onClosed: notice => {
      closed.push(notice);
    },
  });

  return { connection, operations, sockets, states, data, closed };
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TerminalConnection', () => {
  it('creates a pty, opens its socket, and feeds the bytes the shell prints', async () => {
    const harness = createHarness();

    harness.connection.start();
    await flush();

    expect(harness.states).toEqual([{ kind: 'connecting' }]);
    expect(harness.operations.create).toHaveBeenCalledWith({});
    expect(harness.sockets.at(-1)?.url).toBe('wss://worker.test/terminal?ptyId=pty_1');

    harness.sockets.at(-1)?.open();
    expect(harness.states.at(-1)).toEqual({ kind: 'connected' });

    harness.sockets.at(-1)?.message(new Uint8Array([0x68, 0x69]).buffer);
    harness.sockets.at(-1)?.message('ok\n');

    expect(harness.data).toEqual([new Uint8Array([0x68, 0x69]), new TextEncoder().encode('ok\n')]);
  });

  it('drops the control frames a socket carries instead of painting them', async () => {
    const harness = createHarness();
    harness.connection.start();
    await flush();
    harness.sockets.at(-1)?.open();

    harness.sockets.at(-1)?.message('\u0000{"cursor":3}');
    harness.sockets.at(-1)?.message(new Uint8Array([0x00, 0x01]).buffer);
    harness.sockets.at(-1)?.message('{"cursor":"12"}');

    expect(harness.data).toEqual([]);
  });

  it('sends the geometry the view holds when the socket opens and on every later change', async () => {
    const harness = createHarness();

    harness.connection.setSize(80, 24);
    harness.connection.start();
    await flush();

    expect(harness.operations.create).toHaveBeenCalledWith({ cols: 80, rows: 24 });
    expect(harness.operations.resize).not.toHaveBeenCalled();

    harness.sockets.at(-1)?.open();
    expect(harness.operations.resize).toHaveBeenLastCalledWith({
      ptyId: 'pty_1',
      cols: 80,
      rows: 24,
    });

    harness.connection.setSize(120, 40);
    expect(harness.operations.resize).toHaveBeenLastCalledWith({
      ptyId: 'pty_1',
      cols: 120,
      rows: 40,
    });
  });

  it('shows a reconnect while a socket still cannot open', async () => {
    const harness = createHarness();
    harness.connection.start();
    await flush();

    harness.sockets.at(-1)?.fail();
    expect(harness.states.at(-1)).toEqual({ kind: 'reconnecting', attempt: 0 });

    harness.sockets.at(-1)?.open();
    harness.sockets.at(-1)?.fail();
    expect(harness.states.at(-1)).toEqual({ kind: 'connected' });
  });

  it('reconnects with a fresh ticket for the same pty', async () => {
    const harness = createHarness();
    harness.connection.start();
    await flush();
    harness.sockets.at(-1)?.open();

    harness.sockets.at(-1)?.end(1006, '');
    expect(harness.states.at(-1)).toEqual({ kind: 'reconnecting', attempt: 1 });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.operations.refreshTicket).toHaveBeenCalledWith({ ptyId: 'pty_1' });
    expect(harness.operations.create).toHaveBeenCalledTimes(1);
    expect(harness.sockets).toHaveLength(2);
    expect(harness.sockets.at(-1)?.url).toBe('wss://worker.test/terminal?ptyId=pty_1&ticket=2');

    harness.sockets.at(-1)?.open();
    expect(harness.states.at(-1)).toEqual({ kind: 'connected' });
  });

  it('stops on a sleeping sandbox and creates a new pty on retry', async () => {
    const create = vi
      .fn<TerminalOperations['create']>()
      .mockRejectedValueOnce(trpcError('SERVICE_UNAVAILABLE', SANDBOX_SLEEPING))
      .mockResolvedValue({ ptyId: 'pty_2', wsUrl: '/terminal?ptyId=pty_2' });
    const harness = createHarness({ operations: { create } });

    harness.connection.start();
    await flush();

    expect(harness.states.at(-1)).toEqual({ kind: 'stopped' });
    expect(harness.sockets).toHaveLength(0);

    harness.connection.retry();
    await flush();

    expect(create).toHaveBeenCalledTimes(2);
    expect(harness.sockets.at(-1)?.url).toBe('wss://worker.test/terminal?ptyId=pty_2');
  });

  it('gives up on a session that never allows a terminal', async () => {
    const harness = createHarness({
      operations: {
        create: vi.fn<TerminalOperations['create']>(() =>
          Promise.reject(new Error('Only interactive Cloud Agent sessions have a terminal'))
        ),
      },
    });

    harness.connection.start();
    await flush();

    expect(harness.states.at(-1)).toEqual({ kind: 'failed', reason: 'forbidden' });
    expect(harness.sockets).toHaveLength(0);
  });

  it('closes the pty on exit and reports the exit', async () => {
    const harness = createHarness();
    harness.connection.start();
    await flush();
    harness.sockets.at(-1)?.open();

    harness.sockets.at(-1)?.end(1000, 'PTY session ended');

    expect(harness.states.at(-1)).toEqual({ kind: 'exited' });
    expect(harness.closed).toEqual([{ exitStatus: 0, error: null }]);
    expect(harness.operations.close).toHaveBeenCalledWith({ ptyId: 'pty_1' });
  });

  it('drops input while no socket is open', async () => {
    const harness = createHarness();
    harness.connection.start();
    await flush();

    harness.connection.send(new Uint8Array([0x6c, 0x73]));
    expect(harness.sockets.at(-1)?.sent).toEqual([]);

    harness.sockets.at(-1)?.open();
    harness.connection.send(new Uint8Array([0x6c, 0x73]));
    expect(harness.sockets.at(-1)?.sent).toEqual([new Uint8Array([0x6c, 0x73])]);
  });

  it('tears the socket and the pty down without reporting another state', async () => {
    const harness = createHarness();
    harness.connection.start();
    await flush();
    harness.sockets.at(-1)?.open();
    const socket = harness.sockets.at(-1);
    const stateCount = harness.states.length;

    harness.connection.stop();

    expect(socket?.closed).toEqual([{ code: 1000, reason: 'Terminal closed' }]);
    expect(harness.operations.close).toHaveBeenCalledWith({ ptyId: 'pty_1' });
    expect(harness.states).toHaveLength(stateCount);
  });

  it('closes a pty whose create lands after the screen unmounted', async () => {
    const created = Promise.withResolvers<{ ptyId: string; wsUrl: string }>();
    const harness = createHarness({ operations: { create: vi.fn(() => created.promise) } });

    harness.connection.start();
    harness.connection.stop();
    created.resolve({ ptyId: 'pty_late', wsUrl: '/terminal?ptyId=pty_late' });
    await flush();

    expect(harness.operations.close).toHaveBeenCalledWith({ ptyId: 'pty_late' });
    expect(harness.sockets).toHaveLength(0);
    // The screen saw this terminal connect, and nothing after it unmounted.
    expect(harness.states).toEqual([{ kind: 'connecting' }]);
  });
});
