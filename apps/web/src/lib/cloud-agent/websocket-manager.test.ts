/**
 * Tests for websocket-manager.ts
 *
 * These tests verify the WebSocket connection lifecycle, particularly:
 * - Auth failure detection and ticket refresh
 * - Reconnection behavior with exponential backoff
 * - No duplicate reconnect loops after ticket refresh
 */

import { createWebSocketManager, type WebSocketManagerConfig } from './websocket-manager';

// Mock CloseEvent for Node.js environment
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

// Mock WebSocket implementation
class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readyState: number = 0; // CONNECTING

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close() {
    this.readyState = 3; // CLOSED
    // Simulate async close event
    if (this.onclose) {
      // Don't auto-fire onclose - let tests control this
    }
  }

  // Test helpers
  simulateOpen() {
    this.readyState = 1; // OPEN
    this.onopen?.(new Event('open'));
  }

  simulateMessage(data: string) {
    if (!this.onmessage) {
      throw new Error('MockWebSocket.simulateMessage called but onmessage handler is not set');
    }
    this.onmessage(new MessageEvent('message', { data }));
  }

  simulateError() {
    this.onerror?.(new Event('error'));
  }

  simulateClose(code: number, reason = '') {
    this.readyState = 3; // CLOSED
    const event = new MockCloseEvent('close', { code, reason, wasClean: code === 1000 });
    this.onclose?.(event as CloseEvent);
  }

  static reset() {
    MockWebSocket.instances = [];
  }

  static getLatest(): MockWebSocket | undefined {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }
}

// Replace global WebSocket with mock
const originalWebSocket = global.WebSocket;
beforeAll(() => {
  // @ts-expect-error - Mocking WebSocket
  global.WebSocket = MockWebSocket;
});

afterAll(() => {
  global.WebSocket = originalWebSocket;
});

// Helper to flush all pending promises.
// We use jest.requireActual('timers').setImmediate because jest.useFakeTimers() replaces
// the global setImmediate, but we need the real one to properly flush the microtask queue.
const flushPromises = () => new Promise(jest.requireActual('timers').setImmediate);

// Mock Math.random to make backoff delay deterministic in tests.
// Without this, tests that rely on timing (like reconnection tests) would be flaky
// because the jitter formula is: delay * (0.5 + Math.random())
const mockRandom = jest.spyOn(Math, 'random');

beforeEach(() => {
  MockWebSocket.reset();
  jest.useFakeTimers();
  // Set Math.random to return 0.5, making jitter multiplier = 1.0 (no jitter)
  // This makes backoff delays predictable: 1000ms, 2000ms, 4000ms, etc.
  mockRandom.mockReturnValue(0.5);
});

afterEach(() => {
  jest.useRealTimers();
  mockRandom.mockReset();
});

describe('websocket-manager', () => {
  describe('auth failure reconnect', () => {
    it('refreshes ticket once on auth failure and reconnects with new ticket', async () => {
      const onRefreshTicket = jest
        .fn()
        .mockResolvedValue({ ticket: 'new-ticket-123', expiresAt: 9999999999 });
      const onStateChange = jest.fn();
      const onEvent = jest.fn();
      const onError = jest.fn();

      const config: WebSocketManagerConfig = {
        url: 'wss://example.com/stream?sessionId=test',
        ticket: 'old-ticket',
        onEvent,
        onStateChange,
        onError,
        onRefreshTicket,
      };

      const manager = createWebSocketManager(config);
      manager.connect();

      // First WebSocket should be created with old ticket
      expect(MockWebSocket.instances).toHaveLength(1);
      const firstWs = MockWebSocket.instances[0];
      expect(firstWs.url).toContain('ticket=old-ticket');

      // Simulate auth failure (close code 1008 - definitive auth failure)
      firstWs.simulateClose(1008);

      // Should trigger ticket refresh
      expect(onRefreshTicket).toHaveBeenCalledTimes(1);

      // Wait for async ticket refresh
      await flushPromises();

      // Should create new WebSocket with new ticket
      expect(MockWebSocket.instances).toHaveLength(2);
      const secondWs = MockWebSocket.instances[1];
      expect(secondWs.url).toContain('ticket=new-ticket-123');

      // State should have transitioned through refreshing_ticket
      expect(onStateChange).toHaveBeenCalledWith({ status: 'refreshing_ticket' });
      expect(onStateChange).toHaveBeenCalledWith({ status: 'connecting' });
    });

    it('refreshes ticket before connecting when ticket is expired', async () => {
      const onRefreshTicket = jest
        .fn()
        .mockResolvedValue({ ticket: 'new-ticket-123', expiresAt: 9999999999 });
      const onStateChange = jest.fn();
      const onEvent = jest.fn();

      const config: WebSocketManagerConfig = {
        url: 'wss://example.com/stream?sessionId=test',
        ticket: 'old-ticket',
        ticketExpiresAt: Math.floor(Date.now() / 1000) - 1,
        onEvent,
        onStateChange,
        onRefreshTicket,
      };

      const manager = createWebSocketManager(config);
      manager.connect();

      // Should trigger ticket refresh before any WebSocket is created
      expect(onRefreshTicket).toHaveBeenCalledTimes(1);
      expect(MockWebSocket.instances).toHaveLength(0);

      // Wait for async ticket refresh
      await flushPromises();

      // Should create new WebSocket with refreshed ticket
      expect(MockWebSocket.instances).toHaveLength(1);
      const ws = MockWebSocket.instances[0];
      expect(ws.url).toContain('ticket=new-ticket-123');
    });

    it('does not enter duplicate reconnect loop after ticket refresh', async () => {
      const onRefreshTicket = jest
        .fn()
        .mockResolvedValue({ ticket: 'new-ticket-123', expiresAt: 9999999999 });
      const onStateChange = jest.fn();
      const onEvent = jest.fn();

      const config: WebSocketManagerConfig = {
        url: 'wss://example.com/stream?sessionId=test',
        ticket: 'old-ticket',
        onEvent,
        onStateChange,
        onRefreshTicket,
      };

      const manager = createWebSocketManager(config);
      manager.connect();

      const firstWs = MockWebSocket.instances[0];

      // Simulate auth failure
      firstWs.simulateClose(1008);

      // Wait for ticket refresh async operation to complete
      // The refreshTicketAndReconnect is called with void, so we need to flush all promises
      await flushPromises();

      // Second WebSocket created
      expect(MockWebSocket.instances).toHaveLength(2);
      const secondWs = MockWebSocket.instances[1];

      // Verify the second WebSocket has handlers set
      expect(secondWs.onmessage).not.toBeNull();

      // Simulate successful connection on second WebSocket
      secondWs.simulateOpen();
      secondWs.simulateMessage(
        JSON.stringify({
          eventId: 1,
          executionId: 'exec-123',
          sessionId: 'session-123',
          streamEventType: 'status',
          timestamp: new Date().toISOString(),
          data: { message: 'connected' },
        })
      );

      // onEvent should have been called with the event
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 1,
          executionId: 'exec-123',
          streamEventType: 'status',
        })
      );

      // Should be connected now
      expect(onStateChange).toHaveBeenCalledWith({
        status: 'connected',
        executionId: 'exec-123',
      });

      // Ticket refresh should only have been called once
      expect(onRefreshTicket).toHaveBeenCalledTimes(1);

      // No additional WebSocket instances should be created
      expect(MockWebSocket.instances).toHaveLength(2);
    });

    it('stops retrying after ticket refresh fails with auth error again', async () => {
      const onRefreshTicket = jest
        .fn()
        .mockResolvedValue({ ticket: 'new-ticket-123', expiresAt: 9999999999 });
      const onStateChange = jest.fn();
      const onEvent = jest.fn();

      const config: WebSocketManagerConfig = {
        url: 'wss://example.com/stream?sessionId=test',
        ticket: 'old-ticket',
        onEvent,
        onStateChange,
        onRefreshTicket,
      };

      const manager = createWebSocketManager(config);
      manager.connect();

      const firstWs = MockWebSocket.instances[0];

      // First auth failure - triggers ticket refresh (use 1008 which is a definitive auth code)
      firstWs.simulateClose(1008);
      await flushPromises();

      expect(onRefreshTicket).toHaveBeenCalledTimes(1);
      expect(MockWebSocket.instances).toHaveLength(2);

      const secondWs = MockWebSocket.instances[1];

      // Second auth failure after ticket refresh - should NOT refresh again
      secondWs.simulateClose(1008);
      await flushPromises();

      // Should NOT call refresh again
      expect(onRefreshTicket).toHaveBeenCalledTimes(1);

      // Should transition to error state
      expect(onStateChange).toHaveBeenCalledWith({
        status: 'error',
        error: 'Authentication failed after ticket refresh. Check server configuration.',
        retryable: false,
      });

      // No additional WebSocket instances
      expect(MockWebSocket.instances).toHaveLength(2);
    });

    it('handles ticket refresh failure gracefully', async () => {
      const onRefreshTicket = jest.fn().mockRejectedValue(new Error('Token expired'));
      const onStateChange = jest.fn();
      const onEvent = jest.fn();

      const config: WebSocketManagerConfig = {
        url: 'wss://example.com/stream?sessionId=test',
        ticket: 'old-ticket',
        onEvent,
        onStateChange,
        onRefreshTicket,
      };

      const manager = createWebSocketManager(config);
      manager.connect();

      const firstWs = MockWebSocket.instances[0];

      // Simulate auth failure
      firstWs.simulateClose(1008);

      // Wait for ticket refresh to fail
      await flushPromises();

      // Should transition to error state
      expect(onStateChange).toHaveBeenCalledWith({
        status: 'error',
        error: 'Failed to refresh authentication ticket',
        retryable: false,
      });

      // No new WebSocket should be created
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    // Parameterized test for auth failure detection from various close codes and reasons
    // Note: 1006 without a reason is NOT treated as auth failure (it's too ambiguous)
    it.each([
      { code: 1008, reason: '', description: 'close code 1008 (policy violation)' },
      { code: 4001, reason: '', description: 'close code 4001 (custom auth code)' },
      {
        code: 1006,
        reason: 'Unauthorized: invalid ticket',
        description: 'close code 1006 with auth reason',
      },
      {
        code: 1000,
        reason: 'Unauthorized: invalid ticket',
        description: 'reason containing "unauthorized"',
      },
      { code: 1000, reason: '401 Authentication required', description: 'reason containing "401"' },
      { code: 1000, reason: 'Auth token expired', description: 'reason containing "auth"' },
      { code: 1000, reason: 'Invalid ticket', description: 'reason containing "ticket"' },
    ])('detects auth failure from $description', async ({ code, reason }) => {
      const onRefreshTicket = jest
        .fn()
        .mockResolvedValue({ ticket: 'new-ticket', expiresAt: 9999999999 });
      const onStateChange = jest.fn();
      const onEvent = jest.fn();

      const config: WebSocketManagerConfig = {
        url: 'wss://example.com/stream?sessionId=test',
        ticket: 'old-ticket',
        onEvent,
        onStateChange,
        onRefreshTicket,
      };

      const manager = createWebSocketManager(config);
      manager.connect();

      const firstWs = MockWebSocket.instances[0];

      // Simulate auth failure
      firstWs.simulateClose(code, reason);
      await flushPromises();

      // Should trigger ticket refresh
      expect(onRefreshTicket).toHaveBeenCalledTimes(1);
    });

    it('treats 1006 without auth reason as network issue and schedules reconnect', async () => {
      // Close code 1006 (Abnormal Closure) without an auth-related reason is treated
      // as a network issue, not an auth failure. This prevents false positives when
      // the connection fails due to network issues, server errors, etc.
      const onRefreshTicket = jest
        .fn()
        .mockResolvedValue({ ticket: 'new-ticket', expiresAt: 9999999999 });
      const onStateChange = jest.fn();
      const onEvent = jest.fn();

      const config: WebSocketManagerConfig = {
        url: 'wss://example.com/stream?sessionId=test',
        ticket: 'old-ticket',
        onEvent,
        onStateChange,
        onRefreshTicket,
      };

      const manager = createWebSocketManager(config);
      manager.connect();

      const firstWs = MockWebSocket.instances[0];

      // Simulate 1006 without auth reason - should NOT trigger ticket refresh
      firstWs.simulateClose(1006);
      await flushPromises();

      // Should NOT call refresh (1006 without reason is not treated as auth failure)
      expect(onRefreshTicket).not.toHaveBeenCalled();

      // Should schedule normal reconnection
      expect(onStateChange).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'reconnecting',
          attempt: 1,
        })
      );

      // No new WebSocket yet (waiting for backoff)
      expect(MockWebSocket.instances).toHaveLength(1);

      // Fast-forward past backoff delay
      jest.advanceTimersByTime(2000);

      // Now a new WebSocket should be created
      expect(MockWebSocket.instances).toHaveLength(2);
    });

    it('schedules reconnect when no onRefreshTicket handler provided for auth failure', async () => {
      // When there's no onRefreshTicket handler, auth failures (like 1008) fall through
      // to the normal reconnection flow.
      const onStateChange = jest.fn();
      const onEvent = jest.fn();

      const config: WebSocketManagerConfig = {
        url: 'wss://example.com/stream?sessionId=test',
        ticket: 'old-ticket',
        onEvent,
        onStateChange,
        // No onRefreshTicket provided
      };

      const manager = createWebSocketManager(config);
      manager.connect();

      const firstWs = MockWebSocket.instances[0];

      // Simulate auth failure (1008 - definitive auth code)
      firstWs.simulateClose(1008);
      await flushPromises();

      // Should schedule normal reconnection
      expect(onStateChange).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'reconnecting',
          attempt: 1,
        })
      );
    });
  });

  describe('normal reconnection', () => {
    it('schedules reconnect on non-auth close', async () => {
      const onStateChange = jest.fn();
      const onEvent = jest.fn();

      const config: WebSocketManagerConfig = {
        url: 'wss://example.com/stream?sessionId=test',
        ticket: 'ticket',
        onEvent,
        onStateChange,
      };

      const manager = createWebSocketManager(config);
      manager.connect();

      const firstWs = MockWebSocket.instances[0];

      // Simulate successful connection first
      firstWs.simulateOpen();
      firstWs.simulateMessage(
        JSON.stringify({
          eventId: 1,
          executionId: 'exec-123',
          sessionId: 'session-123',
          streamEventType: 'status',
          timestamp: new Date().toISOString(),
          data: {},
        })
      );

      // Simulate normal close (not auth failure)
      firstWs.simulateClose(1001, 'Going away');

      // Should schedule reconnect
      expect(onStateChange).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'reconnecting',
          attempt: 1,
        })
      );

      // Fast-forward past backoff delay
      jest.advanceTimersByTime(2000);

      // Should create new WebSocket
      expect(MockWebSocket.instances).toHaveLength(2);
    });

    it('includes lastEventId in reconnect URL for replay', async () => {
      const onStateChange = jest.fn();
      const onEvent = jest.fn();

      const config: WebSocketManagerConfig = {
        url: 'wss://example.com/stream?sessionId=test',
        ticket: 'ticket',
        onEvent,
        onStateChange,
      };

      const manager = createWebSocketManager(config);
      manager.connect();

      const firstWs = MockWebSocket.instances[0];

      // First simulate open, then message (to properly transition to connected state)
      firstWs.simulateOpen();
      firstWs.simulateMessage(
        JSON.stringify({
          eventId: 42,
          executionId: 'exec-123',
          sessionId: 'session-123',
          streamEventType: 'status',
          timestamp: new Date().toISOString(),
          data: {},
        })
      );

      // Verify we're connected
      expect(onStateChange).toHaveBeenCalledWith({
        status: 'connected',
        executionId: 'exec-123',
      });

      // Simulate non-auth disconnect (1001 = going away, not an auth failure)
      firstWs.simulateClose(1001);

      // Should schedule reconnect (not auth failure, so no ticket refresh)
      expect(onStateChange).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'reconnecting',
          lastEventId: 42,
          attempt: 1,
        })
      );

      // Fast-forward past backoff delay
      jest.advanceTimersByTime(2000);

      // New WebSocket should include fromId for replay
      expect(MockWebSocket.instances).toHaveLength(2);
      const secondWs = MockWebSocket.instances[1];
      expect(secondWs.url).toContain('fromId=42');
    });
  });

  describe('intentional disconnect', () => {
    it('does not reconnect after intentional disconnect', () => {
      const onStateChange = jest.fn();
      const onEvent = jest.fn();

      const config: WebSocketManagerConfig = {
        url: 'wss://example.com/stream?sessionId=test',
        ticket: 'ticket',
        onEvent,
        onStateChange,
      };

      const manager = createWebSocketManager(config);
      manager.connect();

      const firstWs = MockWebSocket.instances[0];

      // Intentionally disconnect
      manager.disconnect();

      // Simulate close event from the WebSocket
      firstWs.simulateClose(1000);

      // Should be disconnected, not reconnecting
      expect(onStateChange).toHaveBeenLastCalledWith({ status: 'disconnected' });

      // No new WebSocket should be created
      expect(MockWebSocket.instances).toHaveLength(1);
    });
  });
});
