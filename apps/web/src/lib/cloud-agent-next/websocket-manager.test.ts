import {
  createWebSocketManager,
  type ConnectionState,
  type WebSocketManagerConfig,
} from './websocket-manager';

class MockCloseEvent extends Event {
  code: number;
  reason: string;
  wasClean: boolean;

  constructor(type: string, init: { code: number; reason: string; wasClean: boolean }) {
    super(type);
    this.code = init.code;
    this.reason = init.reason;
    this.wasClean = init.wasClean;
  }
}

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readyState = 0;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close() {
    this.readyState = 3;
  }

  simulateMessage(data: string) {
    if (this.onmessage === null) {
      throw new Error('MockWebSocket.simulateMessage called but onmessage handler is not set');
    }
    this.onmessage(new MessageEvent('message', { data }));
  }

  simulateClose(code: number, reason = '') {
    this.readyState = 3;
    this.onclose?.(new MockCloseEvent('close', { code, reason, wasClean: code === 1000 }));
  }

  static reset() {
    MockWebSocket.instances = [];
  }
}

const originalWebSocket = global.WebSocket;

beforeAll(() => {
  Object.defineProperty(global, 'WebSocket', {
    configurable: true,
    writable: true,
    value: MockWebSocket,
  });
});

afterAll(() => {
  Object.defineProperty(global, 'WebSocket', {
    configurable: true,
    writable: true,
    value: originalWebSocket,
  });
});

const flushPromises = () => new Promise(jest.requireActual('timers').setImmediate);
const mockRandom = jest.spyOn(Math, 'random');

function eventMessage(eventId: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventId,
    executionId: 'exec-123',
    sessionId: 'session-123',
    streamEventType: 'status',
    timestamp: new Date().toISOString(),
    data: {},
    ...overrides,
  });
}

function createConfig(overrides: Partial<WebSocketManagerConfig> = {}): WebSocketManagerConfig {
  return {
    url: 'wss://example.com/stream?sessionId=test',
    ticket: 'old-ticket',
    onEvent: jest.fn(),
    onStateChange: jest.fn(),
    ...overrides,
  };
}

function socketAt(index: number): MockWebSocket {
  const socket = MockWebSocket.instances[index];
  if (socket === undefined) {
    throw new Error(`Expected WebSocket at index ${index}`);
  }
  return socket;
}

function recordStates() {
  const reconnectAttempts: number[] = [];
  const onStateChange = jest.fn((state: ConnectionState) => {
    if (state.status === 'reconnecting') {
      reconnectAttempts.push(state.attempt);
    }
  });
  return { onStateChange, reconnectAttempts };
}

beforeEach(() => {
  MockWebSocket.reset();
  jest.useFakeTimers();
  mockRandom.mockReturnValue(0.5);
});

afterEach(() => {
  jest.useRealTimers();
  mockRandom.mockReset();
});

describe('cloud-agent-next websocket-manager', () => {
  it('refreshes the ticket on ambiguous 1006 and reconnects immediately with fromId preserved', async () => {
    const onRefreshTicket = jest.fn().mockResolvedValue('new-ticket');
    const onStateChange = jest.fn();
    const manager = createWebSocketManager(createConfig({ onRefreshTicket, onStateChange }));

    manager.connect();

    const firstWs = MockWebSocket.instances[0];
    if (firstWs === undefined) {
      throw new Error('Expected initial WebSocket');
    }

    firstWs.simulateMessage(eventMessage(2269));
    firstWs.simulateClose(1006, '');

    expect(onRefreshTicket).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith({ status: 'refreshing_ticket' });

    await flushPromises();

    expect(MockWebSocket.instances).toHaveLength(2);
    const secondWs = MockWebSocket.instances[1];
    if (secondWs === undefined) {
      throw new Error('Expected refreshed WebSocket');
    }
    expect(secondWs.url).toContain('ticket=new-ticket');
    expect(secondWs.url).toContain('fromId=2269');
    expect(onStateChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'reconnecting' })
    );
  });

  it('falls back to timer reconnect after repeated ambiguous 1006', async () => {
    const onRefreshTicket = jest.fn().mockResolvedValue('new-ticket');
    const onStateChange = jest.fn();
    const manager = createWebSocketManager(createConfig({ onRefreshTicket, onStateChange }));

    manager.connect();

    const firstWs = MockWebSocket.instances[0];
    if (firstWs === undefined) {
      throw new Error('Expected initial WebSocket');
    }

    firstWs.simulateClose(1006, '');
    await flushPromises();

    expect(MockWebSocket.instances).toHaveLength(2);
    const secondWs = MockWebSocket.instances[1];
    if (secondWs === undefined) {
      throw new Error('Expected refreshed WebSocket');
    }

    secondWs.simulateClose(1006, '');

    expect(onRefreshTicket).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith({
      status: 'reconnecting',
      lastEventId: 0,
      attempt: 1,
    });
    expect(onStateChange).not.toHaveBeenCalledWith({
      status: 'error',
      error: 'Authentication failed after ticket refresh. Check server configuration.',
      retryable: false,
    });
    expect(MockWebSocket.instances).toHaveLength(2);

    jest.advanceTimersByTime(1000);

    expect(MockWebSocket.instances).toHaveLength(3);
    const thirdWs = MockWebSocket.instances[2];
    if (thirdWs === undefined) {
      throw new Error('Expected reconnected WebSocket');
    }
    expect(thirdWs.url).toContain('ticket=new-ticket');
  });

  it('uses timer reconnect with the same ticket on normal non-auth close', async () => {
    const onRefreshTicket = jest.fn().mockResolvedValue('new-ticket');
    const onStateChange = jest.fn();
    const manager = createWebSocketManager(createConfig({ onRefreshTicket, onStateChange }));

    manager.connect();

    const firstWs = MockWebSocket.instances[0];
    if (firstWs === undefined) {
      throw new Error('Expected initial WebSocket');
    }

    firstWs.simulateMessage(eventMessage(2269));
    firstWs.simulateClose(1001, 'Going away');

    expect(onRefreshTicket).not.toHaveBeenCalled();
    expect(onStateChange).toHaveBeenCalledWith({
      status: 'reconnecting',
      lastEventId: 2269,
      attempt: 1,
    });
    expect(MockWebSocket.instances).toHaveLength(1);

    jest.advanceTimersByTime(1000);

    expect(MockWebSocket.instances).toHaveLength(2);
    const secondWs = MockWebSocket.instances[1];
    if (secondWs === undefined) {
      throw new Error('Expected reconnected WebSocket');
    }
    expect(secondWs.url).toContain('ticket=old-ticket');
    expect(secondWs.url).toContain('fromId=2269');
  });

  it('transitions to connected without executionId when event omits it', () => {
    const onStateChange = jest.fn();
    const onEvent = jest.fn();
    const manager = createWebSocketManager(createConfig({ onStateChange, onEvent }));

    manager.connect();

    const ws = MockWebSocket.instances[0];
    if (ws === undefined) {
      throw new Error('Expected initial WebSocket');
    }

    const { executionId, ...eventWithoutExecId } = JSON.parse(eventMessage(1));
    void executionId;
    ws.simulateMessage(JSON.stringify(eventWithoutExecId));

    expect(onStateChange).toHaveBeenCalledWith({ status: 'connected' });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('transitions to connected with executionId when event includes it', () => {
    const onStateChange = jest.fn();
    const manager = createWebSocketManager(createConfig({ onStateChange }));

    manager.connect();

    const ws = MockWebSocket.instances[0];
    if (ws === undefined) {
      throw new Error('Expected initial WebSocket');
    }

    ws.simulateMessage(eventMessage(1));

    expect(onStateChange).toHaveBeenCalledWith({ status: 'connected', executionId: 'exec-123' });
  });

  it('escalates the reconnect delay on repeated non-auth closes', () => {
    const { onStateChange, reconnectAttempts } = recordStates();
    const manager = createWebSocketManager(createConfig({ onStateChange }));

    manager.connect();

    socketAt(0).simulateClose(1011, 'Host shutting down');
    expect(reconnectAttempts).toEqual([1]);

    jest.advanceTimersByTime(999);
    expect(MockWebSocket.instances).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(2);

    socketAt(1).simulateClose(1011, 'Host shutting down');
    expect(reconnectAttempts).toEqual([1, 2]);

    jest.advanceTimersByTime(1999);
    expect(MockWebSocket.instances).toHaveLength(2);
    jest.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(3);

    socketAt(2).simulateClose(1011, 'Host shutting down');
    expect(reconnectAttempts).toEqual([1, 2, 3]);

    jest.advanceTimersByTime(3999);
    expect(MockWebSocket.instances).toHaveLength(3);
    jest.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(4);
  });

  it('stops retrying after the maximum number of attempts', () => {
    const { onStateChange } = recordStates();
    const manager = createWebSocketManager(createConfig({ onStateChange }));

    manager.connect();

    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000];
    for (const delay of delays) {
      socketAt(MockWebSocket.instances.length - 1).simulateClose(1011, 'Host shutting down');
      jest.advanceTimersByTime(delay);
    }
    socketAt(8).simulateClose(1011, 'Host shutting down');

    expect(onStateChange).toHaveBeenCalledWith({
      status: 'error',
      error: 'Max reconnection attempts exceeded',
      retryable: false,
    });

    const socketCount = MockWebSocket.instances.length;
    jest.advanceTimersByTime(60000);
    expect(MockWebSocket.instances).toHaveLength(socketCount);
  });

  it('keeps the reconnect budget across a ticket refresh', async () => {
    const onRefreshTicket = jest.fn().mockResolvedValue('new-ticket');
    const { onStateChange, reconnectAttempts } = recordStates();
    const manager = createWebSocketManager(createConfig({ onRefreshTicket, onStateChange }));

    manager.connect();

    socketAt(0).simulateClose(1011, 'Host shutting down');
    jest.advanceTimersByTime(1000);

    socketAt(1).simulateClose(1011, 'Host shutting down');
    jest.advanceTimersByTime(2000);

    socketAt(2).simulateClose(1006, '');
    await flushPromises();

    expect(onRefreshTicket).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(4);

    socketAt(3).simulateClose(1011, 'Host shutting down');
    expect(reconnectAttempts).toEqual([1, 2, 3]);
  });

  it('resets the reconnect budget after a stable connection', () => {
    const { onStateChange, reconnectAttempts } = recordStates();
    const manager = createWebSocketManager(createConfig({ onStateChange }));

    manager.connect();

    socketAt(0).simulateClose(1011, 'Host shutting down');
    jest.advanceTimersByTime(1000);

    socketAt(1).simulateClose(1011, 'Host shutting down');
    jest.advanceTimersByTime(2000);

    socketAt(2).simulateMessage(eventMessage(3));
    jest.advanceTimersByTime(6000);
    socketAt(2).simulateMessage(eventMessage(4));
    jest.advanceTimersByTime(4000);
    socketAt(2).simulateClose(1011, 'Host shutting down');

    expect(reconnectAttempts).toEqual([1, 2, 1]);
  });

  it('keeps the escalation when a socket closes without delivering a frame', () => {
    const { onStateChange, reconnectAttempts } = recordStates();
    const manager = createWebSocketManager(createConfig({ onStateChange }));

    manager.connect();

    socketAt(0).simulateClose(1011, 'Host shutting down');
    jest.advanceTimersByTime(1000);

    jest.advanceTimersByTime(30000);
    socketAt(1).simulateClose(1011, 'Host shutting down');

    expect(reconnectAttempts).toEqual([1, 2]);
  });

  it('keeps the escalation when a socket closes before the stability window', () => {
    const { onStateChange, reconnectAttempts } = recordStates();
    const manager = createWebSocketManager(createConfig({ onStateChange }));

    manager.connect();

    socketAt(0).simulateClose(1011, 'Host shutting down');
    jest.advanceTimersByTime(1000);

    socketAt(1).simulateMessage(eventMessage(4));
    jest.advanceTimersByTime(9999);
    socketAt(1).simulateClose(1011, 'Host shutting down');

    expect(reconnectAttempts).toEqual([1, 2]);
  });

  it('refreshes the ticket at most once per connection lifetime', async () => {
    const onRefreshTicket = jest.fn().mockResolvedValue('new-ticket');
    const { onStateChange, reconnectAttempts } = recordStates();
    const manager = createWebSocketManager(createConfig({ onRefreshTicket, onStateChange }));

    manager.connect();

    socketAt(0).simulateClose(1006, '');
    await flushPromises();

    expect(onRefreshTicket).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(2);

    socketAt(1).simulateMessage(eventMessage(7));
    socketAt(1).simulateClose(1006, '');

    expect(onRefreshTicket).toHaveBeenCalledTimes(1);
    expect(reconnectAttempts).toEqual([1]);
    expect(MockWebSocket.instances).toHaveLength(2);

    jest.advanceTimersByTime(1000);
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it('refreshes the ticket again when a stable socket closes with an auth code', async () => {
    const onRefreshTicket = jest.fn().mockResolvedValue('new-ticket');
    const { onStateChange } = recordStates();
    const manager = createWebSocketManager(createConfig({ onRefreshTicket, onStateChange }));

    manager.connect();

    socketAt(0).simulateClose(1006, '');
    await flushPromises();
    expect(onRefreshTicket).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(2);

    jest.advanceTimersByTime(10000);
    socketAt(1).simulateMessage(eventMessage(8));
    jest.advanceTimersByTime(10000);
    socketAt(1).simulateClose(1008, 'policy violation');
    await flushPromises();

    expect(onRefreshTicket).toHaveBeenCalledTimes(2);
    expect(onStateChange).not.toHaveBeenCalledWith({
      status: 'error',
      error: 'Authentication failed after ticket refresh. Check server configuration.',
      retryable: false,
    });
    expect(MockWebSocket.instances).toHaveLength(3);
  });
});
