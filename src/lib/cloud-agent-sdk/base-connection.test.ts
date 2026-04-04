import {
  createBaseConnection,
  DEFAULT_STALENESS_TIMEOUT_MS,
  type BaseConnectionConfig,
} from './base-connection';

type MockWebSocket = {
  url: string;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  close: jest.Mock;
  send: jest.Mock;
  readyState: number;
};

let sockets: MockWebSocket[];
let webSocketMock: jest.Mock;

// The source code guards browser APIs with `typeof document/window !== 'undefined'`.
// In Jest's node environment these don't exist, so we provide minimal mocks.
let mockDocument: EventTarget & { visibilityState: string };
let mockWindow: EventTarget;

let savedDocument: typeof globalThis.document;
let savedWindow: typeof globalThis.window;

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
      send: jest.fn(),
      readyState: 1, // WebSocket.OPEN
    };
    sockets.push(socket);
    return socket;
  });

  // @ts-expect-error -- test WebSocket mock
  global.WebSocket = webSocketMock;
  (global.WebSocket as unknown as Record<string, number>).OPEN = 1;
  (global.WebSocket as unknown as Record<string, number>).CLOSED = 3;

  // Set up minimal document/window so base-connection registers event listeners
  mockDocument = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  mockWindow = new EventTarget();

  savedDocument = globalThis.document;
  savedWindow = globalThis.window;
  // @ts-expect-error -- minimal mock for browser globals
  globalThis.document = mockDocument;
  // @ts-expect-error -- minimal mock for browser globals
  globalThis.window = mockWindow;
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  // @ts-expect-error -- cleanup test global
  delete global.WebSocket;

  // Restore original document/window (undefined in node)
  globalThis.document = savedDocument;
  globalThis.window = savedWindow;
});

function createTestConnection(overrides: Partial<BaseConnectionConfig> = {}) {
  const onConnected = jest.fn();
  const onReconnected = jest.fn();
  const onDisconnected = jest.fn();
  const onEvent = jest.fn();
  const onUnexpectedDisconnect = jest.fn();

  const config: BaseConnectionConfig = {
    buildUrl: () => 'ws://localhost:9999/test',
    parseMessage: (data: unknown) => {
      if (typeof data === 'string') {
        return { type: 'event' as const, payload: data };
      }
      return null;
    },
    onEvent,
    onConnected,
    onDisconnected,
    onReconnected,
    onUnexpectedDisconnect,
    ...overrides,
  };

  const connection = createBaseConnection(config);
  return {
    connection,
    onConnected,
    onReconnected,
    onDisconnected,
    onEvent,
    onUnexpectedDisconnect,
  };
}

function connectSocket(socketIndex = 0): void {
  sockets[socketIndex].onmessage?.({ data: 'connected-msg' } as MessageEvent);
}

function closeSocket(socketIndex: number, code = 1006): void {
  sockets[socketIndex].onclose?.({ code, reason: '', wasClean: false } as CloseEvent);
}

function simulateVisibilityChange(state: 'visible' | 'hidden'): void {
  mockDocument.visibilityState = state;
  mockDocument.dispatchEvent(new Event('visibilitychange'));
}

function simulatePageshow(persisted: boolean): void {
  const event = new Event('pageshow');
  Object.defineProperty(event, 'persisted', { value: persisted });
  mockWindow.dispatchEvent(event);
}

describe('createBaseConnection – stale WebSocket recovery', () => {
  describe('visibility change', () => {
    it('reconnects with reset attempts when tab becomes visible and WS is dead', () => {
      const { connection } = createTestConnection();
      connection.connect();
      connectSocket(0);

      // Mark socket as not open (simulating a dead connection)
      sockets[0].readyState = 3; // WebSocket.CLOSED

      simulateVisibilityChange('hidden');
      simulateVisibilityChange('visible');

      // Should have created a new socket for reconnect
      expect(sockets).toHaveLength(2);

      connection.destroy();
    });

    it('reconnects if no server message within timeout when tab becomes visible with open WS', () => {
      const { connection, onDisconnected } = createTestConnection();
      connection.connect();
      connectSocket(0);

      // Advance past the recency window so the staleness check fires
      jest.advanceTimersByTime(DEFAULT_STALENESS_TIMEOUT_MS);

      simulateVisibilityChange('hidden');
      simulateVisibilityChange('visible');

      // Socket is OPEN but last message is stale — timeout is armed
      expect(sockets).toHaveLength(1);

      // Advance past the staleness timeout
      jest.advanceTimersByTime(DEFAULT_STALENESS_TIMEOUT_MS);

      // Should have closed the stale socket and created a new one
      expect(sockets[0].close).toHaveBeenCalled();
      expect(onDisconnected).toHaveBeenCalled();
      expect(sockets).toHaveLength(2);

      connection.destroy();
    });

    it('anchors staleness clock to the new socket after reconnect', () => {
      jest.spyOn(Math, 'random').mockReturnValue(0);

      const { connection, onDisconnected } = createTestConnection();
      connection.connect();
      connectSocket(0);

      // Advance time so old socket's lastMessageTime becomes stale
      jest.advanceTimersByTime(DEFAULT_STALENESS_TIMEOUT_MS + 1000);

      // Force a reconnect via socket close + minimal backoff.
      // With Math.random()=0, backoff for attempt 0 = 500ms.
      closeSocket(0);
      jest.advanceTimersByTime(500);

      // New socket created — connectInternal resets lastMessageTime to Date.now()
      expect(sockets).toHaveLength(2);

      // Tab becomes visible immediately after new socket is created.
      // Without the lastMessageTime reset, the old socket's stale timestamp
      // would cause a spurious staleness-timeout reconnect here.
      simulateVisibilityChange('hidden');
      simulateVisibilityChange('visible');

      // Advance past the staleness window — no extra reconnect should occur
      jest.advanceTimersByTime(DEFAULT_STALENESS_TIMEOUT_MS);
      expect(sockets).toHaveLength(2);
      expect(onDisconnected).toHaveBeenCalledTimes(1); // only from the first close

      connection.destroy();
    });

    it('skips staleness check when a message was received recently', () => {
      const { connection, onDisconnected } = createTestConnection();
      connection.connect();
      connectSocket(0);

      // Do NOT advance time — last message is within the recency window
      simulateVisibilityChange('hidden');
      simulateVisibilityChange('visible');

      // Advance past the timeout — nothing should happen
      jest.advanceTimersByTime(DEFAULT_STALENESS_TIMEOUT_MS);

      expect(sockets).toHaveLength(1);
      expect(onDisconnected).not.toHaveBeenCalled();

      connection.destroy();
    });

    it('cancels staleness timeout if a server message arrives before deadline', () => {
      const { connection, onDisconnected } = createTestConnection();
      connection.connect();
      connectSocket(0);

      jest.advanceTimersByTime(DEFAULT_STALENESS_TIMEOUT_MS);

      simulateVisibilityChange('hidden');
      simulateVisibilityChange('visible');

      // Receive a message before the timeout fires
      sockets[0].onmessage?.({ data: 'server-reply' } as MessageEvent);

      // Advance past the timeout - should NOT trigger reconnect
      jest.advanceTimersByTime(DEFAULT_STALENESS_TIMEOUT_MS);

      expect(sockets).toHaveLength(1);
      expect(onDisconnected).not.toHaveBeenCalled();

      connection.destroy();
    });

    it('clears staleness timeout when tab is hidden', () => {
      const { connection, onDisconnected } = createTestConnection();
      connection.connect();
      connectSocket(0);

      jest.advanceTimersByTime(DEFAULT_STALENESS_TIMEOUT_MS);

      // Tab visible → arms staleness timeout
      simulateVisibilityChange('visible');

      // Tab hidden → should clear the timeout
      simulateVisibilityChange('hidden');

      // Advance past the timeout - nothing should happen
      jest.advanceTimersByTime(DEFAULT_STALENESS_TIMEOUT_MS);

      expect(sockets).toHaveLength(1);
      expect(onDisconnected).not.toHaveBeenCalled();

      connection.destroy();
    });
  });

  describe('BFCache (pageshow)', () => {
    it('force-closes WS and reconnects on pageshow with persisted=true', () => {
      const { connection, onDisconnected } = createTestConnection();
      connection.connect();
      connectSocket(0);

      simulatePageshow(true);

      expect(sockets[0].close).toHaveBeenCalled();
      expect(onDisconnected).toHaveBeenCalled();
      expect(sockets).toHaveLength(2);

      connection.destroy();
    });

    it('does nothing on pageshow with persisted=false', () => {
      const { connection, onDisconnected } = createTestConnection();
      connection.connect();
      connectSocket(0);

      simulatePageshow(false);

      expect(sockets[0].close).not.toHaveBeenCalled();
      expect(onDisconnected).not.toHaveBeenCalled();
      expect(sockets).toHaveLength(1);

      connection.destroy();
    });
  });

  describe('online event', () => {
    it('resets attempts and reconnects when online fires while disconnected', () => {
      const { connection } = createTestConnection();
      connection.connect();
      // Don't send a message, so `connected` stays false.
      // Close the socket to simulate a disconnected state.
      closeSocket(0);

      // Pending reconnect timer is scheduled. Clear it via online event.
      const socketsBeforeOnline = sockets.length;
      mockWindow.dispatchEvent(new Event('online'));

      // Should have created a new socket
      expect(sockets.length).toBeGreaterThan(socketsBeforeOnline);

      connection.destroy();
    });

    it('does nothing when online fires while already connected', () => {
      const { connection, onDisconnected } = createTestConnection();
      connection.connect();
      connectSocket(0);

      mockWindow.dispatchEvent(new Event('online'));

      // Should not create a new socket
      expect(sockets).toHaveLength(1);
      expect(onDisconnected).not.toHaveBeenCalled();

      connection.destroy();
    });
  });

  describe('reconnect attempts reset after exhaustion', () => {
    function exhaustReconnectAttempts(startSocketIndex: number) {
      jest.spyOn(Math, 'random').mockReturnValue(0);

      // Close 8 times without ever receiving a message to exhaust retries
      for (let i = 0; i < 8; i++) {
        const idx = startSocketIndex + i;
        closeSocket(idx);
        // Advance timers to trigger the next scheduled reconnect
        jest.advanceTimersByTime(60_000);
      }
    }

    it('visibilitychange to visible resets counter and reconnects after exhausting retries', () => {
      const { connection } = createTestConnection();
      connection.connect();

      exhaustReconnectAttempts(0);

      // 1 initial + 8 reconnects = 9 sockets
      const socketsAfterExhaustion = sockets.length;

      // Close the last socket to hit the max-attempts guard
      closeSocket(sockets.length - 1);
      jest.advanceTimersByTime(60_000);

      // No more sockets should be created (max attempts exceeded)
      expect(sockets.length).toBe(socketsAfterExhaustion);

      // Now simulate tab becoming visible - should reset and reconnect
      sockets[sockets.length - 1].readyState = 3; // WebSocket.CLOSED
      simulateVisibilityChange('visible');

      expect(sockets.length).toBe(socketsAfterExhaustion + 1);

      connection.destroy();
    });

    it('online event resets counter and reconnects after exhausting retries', () => {
      const { connection } = createTestConnection();
      connection.connect();

      exhaustReconnectAttempts(0);

      const socketsAfterExhaustion = sockets.length;

      closeSocket(sockets.length - 1);
      jest.advanceTimersByTime(60_000);

      expect(sockets.length).toBe(socketsAfterExhaustion);

      // online event should reset and reconnect
      mockWindow.dispatchEvent(new Event('online'));

      expect(sockets.length).toBe(socketsAfterExhaustion + 1);

      connection.destroy();
    });
  });

  describe('onReconnected vs onConnected', () => {
    it('fires onConnected on first successful connection', () => {
      const { connection, onConnected, onReconnected } = createTestConnection();
      connection.connect();
      connectSocket(0);

      expect(onConnected).toHaveBeenCalledTimes(1);
      expect(onReconnected).not.toHaveBeenCalled();

      connection.destroy();
    });

    it('fires onReconnected on subsequent connections after disconnect', () => {
      jest.spyOn(Math, 'random').mockReturnValue(0);

      const { connection, onConnected, onReconnected } = createTestConnection();
      connection.connect();
      connectSocket(0);

      expect(onConnected).toHaveBeenCalledTimes(1);

      // Disconnect and let it reconnect
      closeSocket(0);
      jest.advanceTimersByTime(60_000);

      // Second socket is now open - send a message to mark it connected
      connectSocket(1);

      expect(onConnected).toHaveBeenCalledTimes(1);
      expect(onReconnected).toHaveBeenCalledTimes(1);

      connection.destroy();
    });
  });

  describe('proactive auth refresh on reconnect', () => {
    it('calls refreshAuth before reconnecting after staleness timeout', async () => {
      const refreshAuth = jest.fn(() => Promise.resolve());
      const { connection } = createTestConnection({ refreshAuth });
      connection.connect();
      connectSocket(0);

      // Make lastMessageTime stale, then trigger visibility check
      jest.advanceTimersByTime(DEFAULT_STALENESS_TIMEOUT_MS);
      simulateVisibilityChange('hidden');
      simulateVisibilityChange('visible');

      // Advance past staleness timeout
      jest.advanceTimersByTime(DEFAULT_STALENESS_TIMEOUT_MS);

      // refreshAuth should be called to get a fresh ticket before reconnecting
      expect(refreshAuth).toHaveBeenCalledTimes(1);

      // Allow the async refresh to complete
      await Promise.resolve();
      await Promise.resolve();

      // A new socket should be created after refresh
      expect(sockets).toHaveLength(2);

      connection.destroy();
    });

    it('calls refreshAuth before reconnecting after BFCache restore', async () => {
      const refreshAuth = jest.fn(() => Promise.resolve());
      const { connection } = createTestConnection({ refreshAuth });
      connection.connect();
      connectSocket(0);

      simulatePageshow(true);

      expect(refreshAuth).toHaveBeenCalledTimes(1);

      await Promise.resolve();
      await Promise.resolve();

      expect(sockets).toHaveLength(2);

      connection.destroy();
    });

    it('calls refreshAuth before reconnecting after online event while disconnected', async () => {
      const refreshAuth = jest.fn(() => Promise.resolve());
      const { connection } = createTestConnection({ refreshAuth });
      connection.connect();
      // Don't connect — simulate being disconnected
      closeSocket(0);

      // Clear the reconnect timer that was scheduled by closeSocket
      jest.advanceTimersByTime(0);

      refreshAuth.mockClear();
      mockWindow.dispatchEvent(new Event('online'));

      expect(refreshAuth).toHaveBeenCalledTimes(1);

      await Promise.resolve();
      await Promise.resolve();

      // Should create a new socket after refresh
      const socketsAfter = sockets.length;
      expect(socketsAfter).toBeGreaterThan(1);

      connection.destroy();
    });

    it('still reconnects if refreshAuth fails', async () => {
      const refreshAuth = jest.fn(() => Promise.reject(new Error('refresh failed')));
      const { connection } = createTestConnection({ refreshAuth });
      connection.connect();
      connectSocket(0);

      jest.advanceTimersByTime(DEFAULT_STALENESS_TIMEOUT_MS);
      simulateVisibilityChange('hidden');
      simulateVisibilityChange('visible');

      jest.advanceTimersByTime(DEFAULT_STALENESS_TIMEOUT_MS);

      expect(refreshAuth).toHaveBeenCalledTimes(1);

      await Promise.resolve();
      await Promise.resolve();

      // Should still create a new socket even if refresh failed
      expect(sockets).toHaveLength(2);

      connection.destroy();
    });

    it('does not call refreshAuth when no refreshAuth is configured', () => {
      const { connection } = createTestConnection(); // no refreshAuth
      connection.connect();
      connectSocket(0);

      jest.advanceTimersByTime(DEFAULT_STALENESS_TIMEOUT_MS);
      simulateVisibilityChange('hidden');
      simulateVisibilityChange('visible');

      jest.advanceTimersByTime(DEFAULT_STALENESS_TIMEOUT_MS);

      // Should still create a new socket (direct connect, no refresh)
      expect(sockets).toHaveLength(2);

      connection.destroy();
    });
  });

  describe('listener lifecycle', () => {
    it('destroy() removes visibilitychange, pageshow, and online listeners', () => {
      const docRemoveSpy = jest.spyOn(mockDocument, 'removeEventListener');
      const winRemoveSpy = jest.spyOn(mockWindow, 'removeEventListener');

      const { connection } = createTestConnection();
      connection.connect();

      connection.destroy();

      const docRemovedEvents = docRemoveSpy.mock.calls.map(call => call[0]);
      const winRemovedEvents = winRemoveSpy.mock.calls.map(call => call[0]);

      expect(docRemovedEvents).toContain('visibilitychange');
      expect(winRemovedEvents).toContain('pageshow');
      expect(winRemovedEvents).toContain('online');
    });

    it('disconnect() removes visibilitychange, pageshow, and online listeners', () => {
      const docRemoveSpy = jest.spyOn(mockDocument, 'removeEventListener');
      const winRemoveSpy = jest.spyOn(mockWindow, 'removeEventListener');

      const { connection } = createTestConnection();
      connection.connect();

      connection.disconnect();

      const docRemovedEvents = docRemoveSpy.mock.calls.map(call => call[0]);
      const winRemovedEvents = winRemoveSpy.mock.calls.map(call => call[0]);

      expect(docRemovedEvents).toContain('visibilitychange');
      expect(winRemovedEvents).toContain('pageshow');
      expect(winRemovedEvents).toContain('online');
    });
  });
});
