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

function emitClose(socket: MockWebSocket, close: Partial<CloseEvent>): void {
  socket.onclose?.({
    code: close.code ?? 1006,
    reason: close.reason ?? '',
    wasClean: close.wasClean ?? false,
  } as CloseEvent);
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
