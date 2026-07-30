import { createConnection } from './cloud-agent-connection';

type MockWebSocket = {
  url: string;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  close: jest.Mock;
  readyState: number;
};

function createDeferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

class MockCloseEvent extends Event {
  code: number;
  reason: string;
  wasClean: boolean;

  constructor(init: { code: number; reason: string; wasClean: boolean }) {
    super('close');
    this.code = init.code;
    this.reason = init.reason;
    this.wasClean = init.wasClean;
  }
}

function emitClose(socket: MockWebSocket, close: Partial<CloseEvent>): void {
  socket.onclose?.(
    new MockCloseEvent({
      code: close.code ?? 1006,
      reason: close.reason ?? '',
      wasClean: close.wasClean ?? false,
    })
  );
}

describe('createConnection', () => {
  let sockets: MockWebSocket[];
  let webSocketMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    sockets = [];

    webSocketMock = jest.fn((url: string) => {
      const socket: MockWebSocket = {
        url,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        close: jest.fn(),
        readyState: 1,
      };
      sockets.push(socket);
      return socket;
    });

    // @ts-expect-error -- test WebSocket mock
    global.WebSocket = webSocketMock;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    // @ts-expect-error -- cleanup test global
    delete global.WebSocket;
  });

  it('disconnect during async ticket refresh must not reconnect', async () => {
    const refresh = createDeferred<string>();
    const onRefreshTicket = jest.fn(() => refresh.promise);

    const connection = createConnection({
      websocketUrl: 'ws://localhost:9999/stream',
      ticket: 'old-ticket',
      onEvent: jest.fn(),
      onConnected: jest.fn(),
      onDisconnected: jest.fn(),
      onRefreshTicket,
    });

    connection.connect();
    expect(webSocketMock).toHaveBeenCalledTimes(1);

    emitClose(sockets[0], { code: 1008, reason: 'unauthorized' });
    expect(onRefreshTicket).toHaveBeenCalledTimes(1);

    connection.disconnect();
    refresh.resolve('new-ticket');
    await Promise.resolve();
    await Promise.resolve();

    connection.destroy();

    expect(webSocketMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes an expiring ticket before opening the websocket', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const onRefreshTicket = jest.fn().mockResolvedValue({
      ticket: 'new-ticket',
      expiresAt: nowSeconds + 60,
    });

    const connection = createConnection({
      websocketUrl: 'ws://localhost:9999/stream',
      ticket: {
        ticket: 'old-ticket',
        expiresAt: nowSeconds + 5,
      },
      onEvent: jest.fn(),
      onConnected: jest.fn(),
      onDisconnected: jest.fn(),
      onRefreshTicket,
    });

    connection.connect();
    await Promise.resolve();
    await Promise.resolve();

    expect(onRefreshTicket).toHaveBeenCalledTimes(1);
    expect(webSocketMock).toHaveBeenCalledTimes(1);
    expect(sockets[0]?.url).toContain('ticket=new-ticket');
    expect(sockets[0]?.url).not.toContain('ticket=old-ticket');

    connection.destroy();
  });

  it('treats ambiguous 1006 as a reconnectable transport failure', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const onRefreshTicket = jest.fn().mockResolvedValue('new-ticket');

    const connection = createConnection({
      websocketUrl: 'ws://localhost:9999/stream',
      ticket: 'old-ticket',
      onEvent: jest.fn(),
      onConnected: jest.fn(),
      onDisconnected: jest.fn(),
      onRefreshTicket,
    });

    connection.connect();

    const firstSocket = sockets[0];
    if (firstSocket === undefined) {
      throw new Error('Expected initial WebSocket');
    }
    emitClose(firstSocket, { code: 1006, reason: '' });

    expect(onRefreshTicket).not.toHaveBeenCalled();
    expect(webSocketMock).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(500);

    expect(webSocketMock).toHaveBeenCalledTimes(2);
    expect(sockets[1]?.url).toContain('ticket=old-ticket');

    connection.destroy();
  });

  it('manual connect() must cancel pending reconnect timer', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);

    const connection = createConnection({
      websocketUrl: 'ws://localhost:9999/stream',
      ticket: 'test-ticket',
      onEvent: jest.fn(),
      onConnected: jest.fn(),
      onDisconnected: jest.fn(),
    });

    connection.connect();
    expect(webSocketMock).toHaveBeenCalledTimes(1);

    emitClose(sockets[0], { code: 1006, reason: 'network' });

    connection.connect();
    expect(webSocketMock).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(500);

    connection.destroy();

    expect(webSocketMock).toHaveBeenCalledTimes(2);
  });
});
