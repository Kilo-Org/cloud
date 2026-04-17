import { createWebSocketManager, type WebSocketManagerConfig } from './websocket-manager';

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

function eventMessage(eventId: number): string {
  return JSON.stringify({
    eventId,
    executionId: 'exec-123',
    sessionId: 'session-123',
    streamEventType: 'status',
    timestamp: new Date().toISOString(),
    data: {},
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
});
