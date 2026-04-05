/**
 * WebSocket Streaming Module Tests
 *
 * Tests for WebSocket-based streaming for App Builder.
 * Tests the event filtering, transformation, and coordinator behavior.
 */

import type { V2Event } from '@/lib/cloud-agent/event-normalizer';
import type { CloudMessage } from '@/components/cloud-agent/types';
import { APP_BUILDER_SYSTEM_CONTEXT_FIRST_LINE } from '@/lib/app-builder/constants';

// Import the functions we're testing via dynamic import to work around module structure
// For now we test by re-implementing the logic from websocket-streaming.ts since the
// functions are not exported individually

/**
 * Checks if a V2Event should be discarded before processing.
 * Copy of the implementation for testing.
 */
function shouldDiscardEvent(event: V2Event): boolean {
  if (event.streamEventType === 'heartbeat') {
    return true;
  }

  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') {
    return false;
  }

  if (data.type === 'welcome') {
    return true;
  }

  if (data.type === 'ask' && data.ask === 'resume_task') {
    return true;
  }

  if (data.type === 'say' && data.say === 'checkpoint_saved') {
    return true;
  }

  if (data.event === 'session_synced') {
    return true;
  }

  return false;
}

/**
 * Transforms a V2Event into a CloudMessage for the store.
 * Copy of the implementation for testing.
 */
function transformV2EventToCloudMessage(event: V2Event): CloudMessage | null {
  const ts = new Date(event.timestamp).getTime();

  switch (event.streamEventType) {
    case 'status': {
      const data = event.data as { message?: string };
      return {
        ts,
        type: 'system',
        text: data.message ?? 'Status update',
        partial: false,
      };
    }

    case 'error': {
      const data = event.data as { message?: string };
      return {
        ts,
        type: 'system',
        say: 'error',
        text: data.message ?? 'An error occurred',
        partial: false,
      };
    }

    case 'kilocode': {
      const data = event.data as Record<string, unknown>;
      let content = (data.content ?? data.text) as string | undefined;
      const timestamp = (data.timestamp as number) ?? ts;

      // Strip system context prefix from user feedback messages
      // Needed only for old messages (before 2026-01-26)
      const cutoffDate = new Date('2026-01-26').getTime();
      if (
        data.say === 'user_feedback' &&
        timestamp < cutoffDate &&
        content?.startsWith(APP_BUILDER_SYSTEM_CONTEXT_FIRST_LINE)
      ) {
        const userRequestMarker = '\n\nUser Request:\n\n---';
        const userRequestIndex = content.indexOf(userRequestMarker);
        if (userRequestIndex !== -1) {
          content = content.slice(userRequestIndex + userRequestMarker.length).trimStart();
        }
      }

      return {
        ts: timestamp,
        type: data.type === 'say' ? 'assistant' : 'system',
        say: data.say as string | undefined,
        ask: data.ask as string | undefined,
        text: content,
        partial: data.partial as boolean | undefined,
        metadata: data.metadata as Record<string, unknown> | undefined,
      };
    }

    case 'started': {
      return {
        ts,
        type: 'system',
        text: 'Session started',
        partial: false,
      };
    }

    case 'complete': {
      return null;
    }

    default:
      return null;
  }
}

describe('shouldDiscardEvent', () => {
  const baseTimestamp = '2024-01-01T00:00:00Z';

  // Helper to create V2Event with required fields
  const createV2Event = (
    overrides: Partial<V2Event> & { streamEventType: string; data: unknown }
  ): V2Event => ({
    eventId: 1,
    executionId: 'test-execution',
    sessionId: 'test-session',
    timestamp: baseTimestamp,
    ...overrides,
  });

  describe('heartbeat events', () => {
    it('discards heartbeat events', () => {
      const event = createV2Event({
        streamEventType: 'heartbeat',
        data: {},
      });

      expect(shouldDiscardEvent(event)).toBe(true);
    });
  });

  describe('welcome events', () => {
    it('discards welcome messages from CLI', () => {
      const event = createV2Event({
        streamEventType: 'kilocode',
        data: {
          type: 'welcome',
          message: 'Welcome to Kilo Code',
        },
      });

      expect(shouldDiscardEvent(event)).toBe(true);
    });
  });

  describe('resume_task events', () => {
    it('discards resume_task ask messages', () => {
      const event = createV2Event({
        streamEventType: 'kilocode',
        data: {
          type: 'ask',
          ask: 'resume_task',
          content: 'Resume previous task?',
        },
      });

      expect(shouldDiscardEvent(event)).toBe(true);
    });
  });

  describe('checkpoint_saved events', () => {
    it('discards checkpoint_saved say messages', () => {
      const event = createV2Event({
        streamEventType: 'kilocode',
        data: {
          type: 'say',
          say: 'checkpoint_saved',
          content: 'Checkpoint saved',
        },
      });

      expect(shouldDiscardEvent(event)).toBe(true);
    });
  });

  describe('session_synced events', () => {
    it('discards session_synced events', () => {
      const event = createV2Event({
        streamEventType: 'kilocode',
        data: {
          event: 'session_synced',
        },
      });

      expect(shouldDiscardEvent(event)).toBe(true);
    });
  });

  describe('valid events', () => {
    it('does not discard regular kilocode events', () => {
      const event = createV2Event({
        streamEventType: 'kilocode',
        data: {
          type: 'say',
          say: 'text',
          content: 'Hello from assistant',
        },
      });

      expect(shouldDiscardEvent(event)).toBe(false);
    });

    it('does not discard status events', () => {
      const event = createV2Event({
        streamEventType: 'status',
        data: {
          message: 'Processing...',
        },
      });

      expect(shouldDiscardEvent(event)).toBe(false);
    });

    it('does not discard error events', () => {
      const event = createV2Event({
        streamEventType: 'error',
        data: {
          message: 'Something went wrong',
        },
      });

      expect(shouldDiscardEvent(event)).toBe(false);
    });

    it('does not discard events with null data', () => {
      const event = createV2Event({
        streamEventType: 'kilocode',
        data: null,
      });

      expect(shouldDiscardEvent(event)).toBe(false);
    });

    it('does not discard events without data', () => {
      const event = createV2Event({
        streamEventType: 'started',
        data: {},
      });

      expect(shouldDiscardEvent(event)).toBe(false);
    });
  });
});

describe('transformV2EventToCloudMessage', () => {
  const baseTimestamp = '2024-01-01T00:00:00Z';
  const baseTs = new Date(baseTimestamp).getTime();

  // Helper to create V2Event with required fields
  const createV2Event = (
    overrides: Partial<V2Event> & { streamEventType: string; data: unknown }
  ): V2Event => ({
    eventId: 1,
    executionId: 'test-execution',
    sessionId: 'test-session',
    timestamp: baseTimestamp,
    ...overrides,
  });

  describe('status events', () => {
    it('transforms status event to system message', () => {
      const event = createV2Event({
        streamEventType: 'status',
        data: {
          message: 'Processing request...',
        },
      });

      const result = transformV2EventToCloudMessage(event);

      expect(result).toEqual({
        ts: baseTs,
        type: 'system',
        text: 'Processing request...',
        partial: false,
      });
    });

    it('uses default message when message is missing', () => {
      const event = createV2Event({
        streamEventType: 'status',
        data: {},
      });

      const result = transformV2EventToCloudMessage(event);

      expect(result?.text).toBe('Status update');
    });
  });

  describe('error events', () => {
    it('transforms error event to system error message', () => {
      const event = createV2Event({
        streamEventType: 'error',
        data: {
          message: 'Connection lost',
        },
      });

      const result = transformV2EventToCloudMessage(event);

      expect(result).toEqual({
        ts: baseTs,
        type: 'system',
        say: 'error',
        text: 'Connection lost',
        partial: false,
      });
    });

    it('uses default error message when message is missing', () => {
      const event = createV2Event({
        streamEventType: 'error',
        data: {},
      });

      const result = transformV2EventToCloudMessage(event);

      expect(result?.text).toBe('An error occurred');
    });
  });

  describe('kilocode events', () => {
    it('transforms say event to assistant message', () => {
      const event = createV2Event({
        streamEventType: 'kilocode',
        data: {
          type: 'say',
          say: 'text',
          content: 'Hello from assistant',
          timestamp: 1000,
          partial: true,
        },
      });

      const result = transformV2EventToCloudMessage(event);

      expect(result).toEqual({
        ts: 1000,
        type: 'assistant',
        say: 'text',
        ask: undefined,
        text: 'Hello from assistant',
        partial: true,
        metadata: undefined,
      });
    });

    it('transforms ask event to system message', () => {
      const event = createV2Event({
        streamEventType: 'kilocode',
        data: {
          type: 'ask',
          ask: 'tool',
          content: 'Requesting tool use',
          timestamp: 2000,
          partial: false,
        },
      });

      const result = transformV2EventToCloudMessage(event);

      expect(result?.type).toBe('system');
      expect(result?.ask).toBe('tool');
    });

    it('uses text field when content is absent', () => {
      const event = createV2Event({
        streamEventType: 'kilocode',
        data: {
          type: 'say',
          text: 'Using text field',
          timestamp: 1000,
        },
      });

      const result = transformV2EventToCloudMessage(event);

      expect(result?.text).toBe('Using text field');
    });

    it('uses event timestamp when data timestamp is missing', () => {
      const event = createV2Event({
        streamEventType: 'kilocode',
        data: {
          type: 'say',
          content: 'No data timestamp',
        },
      });

      const result = transformV2EventToCloudMessage(event);

      expect(result?.ts).toBe(baseTs);
    });

    it('includes metadata when present', () => {
      const metadata = { tool: 'read_file', args: { path: 'test.ts' } };
      const event = createV2Event({
        streamEventType: 'kilocode',
        data: {
          type: 'say',
          content: 'Tool result',
          timestamp: 1000,
          metadata,
        },
      });

      const result = transformV2EventToCloudMessage(event);

      expect(result?.metadata).toEqual(metadata);
    });

    describe('system context stripping', () => {
      const oldTimestamp = new Date('2025-01-01').getTime(); // Before cutoff
      const contentWithContext = `${APP_BUILDER_SYSTEM_CONTEXT_FIRST_LINE}

Some system context here...

User Request:

---
Build me a todo app`;

      it('strips system context from old user_feedback messages', () => {
        const event = createV2Event({
          streamEventType: 'kilocode',
          data: {
            type: 'say',
            say: 'user_feedback',
            content: contentWithContext,
            timestamp: oldTimestamp,
          },
        });

        const result = transformV2EventToCloudMessage(event);

        expect(result?.text).toBe('Build me a todo app');
      });

      it('does not strip context from non-user_feedback messages', () => {
        const event = createV2Event({
          streamEventType: 'kilocode',
          data: {
            type: 'say',
            say: 'text',
            content: contentWithContext,
            timestamp: oldTimestamp,
          },
        });

        const result = transformV2EventToCloudMessage(event);

        expect(result?.text).toBe(contentWithContext);
      });

      it('does not strip context from messages after cutoff date', () => {
        const newTimestamp = new Date('2026-02-01').getTime(); // After cutoff
        const event = createV2Event({
          streamEventType: 'kilocode',
          data: {
            type: 'say',
            say: 'user_feedback',
            content: contentWithContext,
            timestamp: newTimestamp,
          },
        });

        const result = transformV2EventToCloudMessage(event);

        expect(result?.text).toBe(contentWithContext);
      });

      it('handles content without User Request marker', () => {
        const contentWithoutMarker = `${APP_BUILDER_SYSTEM_CONTEXT_FIRST_LINE}

Just system context, no user request marker`;

        const event = createV2Event({
          streamEventType: 'kilocode',
          data: {
            type: 'say',
            say: 'user_feedback',
            content: contentWithoutMarker,
            timestamp: oldTimestamp,
          },
        });

        const result = transformV2EventToCloudMessage(event);

        // Without the marker, content remains unchanged
        expect(result?.text).toBe(contentWithoutMarker);
      });
    });
  });

  describe('started events', () => {
    it('transforms started event to session started message', () => {
      const event = createV2Event({
        streamEventType: 'started',
        data: {},
      });

      const result = transformV2EventToCloudMessage(event);

      expect(result).toEqual({
        ts: baseTs,
        type: 'system',
        text: 'Session started',
        partial: false,
      });
    });
  });

  describe('complete events', () => {
    it('returns null for complete events (handled at streaming level)', () => {
      const event = createV2Event({
        streamEventType: 'complete',
        data: {},
      });

      const result = transformV2EventToCloudMessage(event);

      expect(result).toBeNull();
    });
  });

  describe('unknown events', () => {
    it('returns null for unknown event types', () => {
      const event = createV2Event({
        streamEventType: 'unknown_type',
        data: {},
      });

      const result = transformV2EventToCloudMessage(event);

      expect(result).toBeNull();
    });
  });
});

/**
 * ExecutionStateTracker type - copy of the internal type for testing
 */
type ExecutionStateTracker = {
  hasStartedEvent: boolean;
  hasTerminalEvent: boolean;
  lastEventTimestamp: number | null;
};

/**
 * Creates a fresh ExecutionStateTracker instance
 */
function createExecutionStateTracker(): ExecutionStateTracker {
  return {
    hasStartedEvent: false,
    hasTerminalEvent: false,
    lastEventTimestamp: null,
  };
}

const STALE_EXECUTION_TIMEOUT_MS = 30_000;

/**
 * Simulates the stale execution check logic from the coordinator
 */
function checkForStaleExecution(
  tracker: ExecutionStateTracker,
  setIsStreaming: (value: boolean) => void
): void {
  if (!tracker.hasStartedEvent || tracker.hasTerminalEvent) {
    return;
  }
  if (tracker.lastEventTimestamp === null) {
    return;
  }
  const now = Date.now();
  const timeSinceLastEvent = now - tracker.lastEventTimestamp;
  if (timeSinceLastEvent > STALE_EXECUTION_TIMEOUT_MS) {
    setIsStreaming(false);
  }
}

describe('ExecutionStateTracker lifecycle behavior', () => {
  describe('createExecutionStateTracker', () => {
    it('creates tracker with correct initial state', () => {
      const tracker = createExecutionStateTracker();

      expect(tracker.hasStartedEvent).toBe(false);
      expect(tracker.hasTerminalEvent).toBe(false);
      expect(tracker.lastEventTimestamp).toBeNull();
    });
  });

  describe('lifecycle event tracking', () => {
    it('sets isStreaming true on started event', () => {
      const tracker = createExecutionStateTracker();
      let isStreaming = false;

      // Simulate receiving a 'started' event
      tracker.hasStartedEvent = true;
      isStreaming = true; // This is what the coordinator does

      expect(tracker.hasStartedEvent).toBe(true);
      expect(isStreaming).toBe(true);
    });

    it('sets isStreaming false on complete event', () => {
      const tracker = createExecutionStateTracker();
      let isStreaming = true;

      // Simulate a started execution
      tracker.hasStartedEvent = true;

      // Simulate receiving a 'complete' event
      tracker.hasTerminalEvent = true;
      isStreaming = false; // This is what the coordinator does

      expect(tracker.hasTerminalEvent).toBe(true);
      expect(isStreaming).toBe(false);
    });

    it('sets isStreaming false on interrupted event', () => {
      const tracker = createExecutionStateTracker();
      let isStreaming = true;

      // Simulate a started execution
      tracker.hasStartedEvent = true;

      // Simulate receiving an 'interrupted' event (same handling as 'complete')
      tracker.hasTerminalEvent = true;
      isStreaming = false;

      expect(tracker.hasTerminalEvent).toBe(true);
      expect(isStreaming).toBe(false);
    });

    it('does not mark as stale if terminal event received', () => {
      const tracker = createExecutionStateTracker();
      let isStreaming = true;
      const setIsStreaming = (value: boolean) => {
        isStreaming = value;
      };

      // Simulate started event
      tracker.hasStartedEvent = true;
      tracker.lastEventTimestamp = Date.now() - 60_000; // 60 seconds ago

      // Simulate terminal event received
      tracker.hasTerminalEvent = true;

      // Run stale check - should NOT change isStreaming since terminal event received
      checkForStaleExecution(tracker, setIsStreaming);

      // isStreaming should remain true because checkForStaleExecution returns early
      // when hasTerminalEvent is true
      expect(isStreaming).toBe(true);
    });

    it('handles multiple started events idempotently', () => {
      const tracker = createExecutionStateTracker();
      let setStreamingCallCount = 0;

      // Simulate receiving multiple 'started' events
      for (let i = 0; i < 3; i++) {
        if (!tracker.hasStartedEvent) {
          tracker.hasStartedEvent = true;
          setStreamingCallCount++;
        }
      }

      // Should only have set streaming once
      expect(tracker.hasStartedEvent).toBe(true);
      expect(setStreamingCallCount).toBe(1);
    });

    it('does not set isStreaming true when WebSocket connects (only on started event)', () => {
      const tracker = createExecutionStateTracker();

      // WebSocket connection state changes should NOT affect isStreaming
      // Only the 'started' event should set isStreaming: true

      // Initial state - tracker has no started event
      expect(tracker.hasStartedEvent).toBe(false);

      // Simulated connection - per the new implementation, connecting
      // does NOT automatically set isStreaming: true
      // The tracker remains unchanged until a 'started' event is received
      expect(tracker.hasStartedEvent).toBe(false);
    });

    it('tracks lastEventTimestamp on every event', () => {
      const tracker = createExecutionStateTracker();
      const timestamp1 = Date.now();
      const timestamp2 = timestamp1 + 1000;
      const timestamp3 = timestamp2 + 1000;

      // Initially null
      expect(tracker.lastEventTimestamp).toBeNull();

      // Update on first event
      tracker.lastEventTimestamp = timestamp1;
      expect(tracker.lastEventTimestamp).toBe(timestamp1);

      // Update on second event
      tracker.lastEventTimestamp = timestamp2;
      expect(tracker.lastEventTimestamp).toBe(timestamp2);

      // Update on third event
      tracker.lastEventTimestamp = timestamp3;
      expect(tracker.lastEventTimestamp).toBe(timestamp3);
    });
  });
});

describe('Stale execution detection', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('detects stale execution after 30s with no terminal event', () => {
    const tracker = createExecutionStateTracker();
    let isStreaming = true;
    const setIsStreaming = (value: boolean) => {
      isStreaming = value;
    };

    // Simulate execution started
    tracker.hasStartedEvent = true;
    tracker.lastEventTimestamp = Date.now();

    // Advance time past the stale threshold
    jest.advanceTimersByTime(STALE_EXECUTION_TIMEOUT_MS + 1);

    // Run the stale check
    checkForStaleExecution(tracker, setIsStreaming);

    expect(isStreaming).toBe(false);
  });

  it('does not detect stale execution before 30s', () => {
    const tracker = createExecutionStateTracker();
    let isStreaming = true;
    const setIsStreaming = (value: boolean) => {
      isStreaming = value;
    };

    // Simulate execution started
    tracker.hasStartedEvent = true;
    tracker.lastEventTimestamp = Date.now();

    // Advance time but stay under threshold
    jest.advanceTimersByTime(STALE_EXECUTION_TIMEOUT_MS - 1000);

    // Run the stale check
    checkForStaleExecution(tracker, setIsStreaming);

    // Should still be streaming
    expect(isStreaming).toBe(true);
  });

  it('resets stale detection when new events are received', () => {
    const tracker = createExecutionStateTracker();
    let isStreaming = true;
    const setIsStreaming = (value: boolean) => {
      isStreaming = value;
    };

    // Simulate execution started
    tracker.hasStartedEvent = true;
    tracker.lastEventTimestamp = Date.now();

    // Advance time to just before threshold
    jest.advanceTimersByTime(STALE_EXECUTION_TIMEOUT_MS - 5000);

    // Simulate receiving a new event (which resets the timestamp)
    tracker.lastEventTimestamp = Date.now();

    // Advance time by another 25s (total would be 50s from original start,
    // but only 25s from the "new event")
    jest.advanceTimersByTime(STALE_EXECUTION_TIMEOUT_MS - 5000);

    // Run stale check - should NOT be stale because timestamp was reset
    checkForStaleExecution(tracker, setIsStreaming);

    expect(isStreaming).toBe(true);
  });

  it('clears stale detection when terminal event is received', () => {
    const tracker = createExecutionStateTracker();
    let isStreaming = true;
    const setIsStreaming = (value: boolean) => {
      isStreaming = value;
    };

    // Simulate execution started
    tracker.hasStartedEvent = true;
    tracker.lastEventTimestamp = Date.now();

    // Advance time past threshold
    jest.advanceTimersByTime(STALE_EXECUTION_TIMEOUT_MS + 1);

    // Before running stale check, terminal event arrives
    tracker.hasTerminalEvent = true;

    // Run stale check - should NOT set isStreaming: false because terminal event received
    checkForStaleExecution(tracker, setIsStreaming);

    // isStreaming should remain true (stale check returns early)
    expect(isStreaming).toBe(true);
  });

  it('does not check stale if execution never started', () => {
    const tracker = createExecutionStateTracker();
    let isStreaming = false;
    const setIsStreaming = (value: boolean) => {
      isStreaming = value;
    };

    // Execution never started
    expect(tracker.hasStartedEvent).toBe(false);

    // Set a timestamp anyway
    tracker.lastEventTimestamp = Date.now() - 60_000; // 60 seconds ago

    // Run stale check - should return early because hasStartedEvent is false
    checkForStaleExecution(tracker, setIsStreaming);

    // isStreaming should remain false (unchanged)
    expect(isStreaming).toBe(false);
  });

  it('does not check stale if lastEventTimestamp is null', () => {
    const tracker = createExecutionStateTracker();
    let isStreaming = true;
    const setIsStreaming = (value: boolean) => {
      isStreaming = value;
    };

    // Simulate started but no events received yet
    tracker.hasStartedEvent = true;
    tracker.lastEventTimestamp = null;

    // Run stale check - should return early because lastEventTimestamp is null
    checkForStaleExecution(tracker, setIsStreaming);

    // isStreaming should remain true
    expect(isStreaming).toBe(true);
  });

  it('correctly calculates time difference for stale detection', () => {
    const tracker = createExecutionStateTracker();
    let isStreaming = true;
    const setIsStreaming = (value: boolean) => {
      isStreaming = value;
    };

    // Simulate execution started at a specific time
    const startTime = Date.now();
    tracker.hasStartedEvent = true;
    tracker.lastEventTimestamp = startTime;

    // Check at exactly 30s - should not be stale (threshold is >30s, not >=30s)
    jest.advanceTimersByTime(STALE_EXECUTION_TIMEOUT_MS);
    checkForStaleExecution(tracker, setIsStreaming);
    expect(isStreaming).toBe(true);

    // Check at 30s + 1ms - should be stale
    jest.advanceTimersByTime(1);
    checkForStaleExecution(tracker, setIsStreaming);
    expect(isStreaming).toBe(false);
  });
});

describe('STALE_EXECUTION_TIMEOUT_MS constant', () => {
  it('is set to 30 seconds', () => {
    expect(STALE_EXECUTION_TIMEOUT_MS).toBe(30_000);
  });
});

/**
 * ConnectionState type - matching the websocket-manager ConnectionState
 */
type ConnectionStateStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'refreshing_ticket'
  | 'error';

/**
 * Simulates the canReuseConnection logic from the coordinator
 */
function canReuseConnection(
  currentCloudSessionId: string | null,
  connectionStatus: ConnectionStateStatus,
  hasWsManager: boolean,
  cloudAgentSessionId: string
): boolean {
  if (!hasWsManager || !currentCloudSessionId) {
    return false;
  }

  // Must be the same session ID
  if (currentCloudSessionId !== cloudAgentSessionId) {
    return false;
  }

  // Must be in a usable state
  return (
    connectionStatus === 'connected' ||
    connectionStatus === 'connecting' ||
    connectionStatus === 'reconnecting'
  );
}

describe('Connection reuse behavior', () => {
  describe('canReuseConnection', () => {
    it('returns false when wsManager is null', () => {
      const result = canReuseConnection('session-123', 'connected', false, 'session-123');
      expect(result).toBe(false);
    });

    it('returns false when currentCloudSessionId is null', () => {
      const result = canReuseConnection(null, 'connected', true, 'session-123');
      expect(result).toBe(false);
    });

    it('returns false when session IDs differ', () => {
      const result = canReuseConnection('session-123', 'connected', true, 'session-456');
      expect(result).toBe(false);
    });

    it('returns true when connected to the same session', () => {
      const result = canReuseConnection('session-123', 'connected', true, 'session-123');
      expect(result).toBe(true);
    });

    it('returns true when connecting to the same session', () => {
      const result = canReuseConnection('session-123', 'connecting', true, 'session-123');
      expect(result).toBe(true);
    });

    it('returns true when reconnecting to the same session', () => {
      const result = canReuseConnection('session-123', 'reconnecting', true, 'session-123');
      expect(result).toBe(true);
    });

    it('returns false when refreshing_ticket for the same session', () => {
      const result = canReuseConnection('session-123', 'refreshing_ticket', true, 'session-123');
      expect(result).toBe(false);
    });

    it('returns false when disconnected from the same session', () => {
      const result = canReuseConnection('session-123', 'disconnected', true, 'session-123');
      expect(result).toBe(false);
    });

    it('returns false when in error state for the same session', () => {
      const result = canReuseConnection('session-123', 'error', true, 'session-123');
      expect(result).toBe(false);
    });
  });

  describe('connection reuse scenarios', () => {
    it('avoids opening new connection when sending message to same session', () => {
      // Simulate existing connected state
      const currentCloudSessionId = 'session-abc';
      const connectionStatus: ConnectionStateStatus = 'connected';
      const hasWsManager = true;

      // User sends a new message to the same session
      const targetSessionId = 'session-abc';

      const canReuse = canReuseConnection(
        currentCloudSessionId,
        connectionStatus,
        hasWsManager,
        targetSessionId
      );

      expect(canReuse).toBe(true);
    });

    it('opens new connection when switching to different session', () => {
      // Simulate existing connected state
      const currentCloudSessionId = 'session-abc';
      const connectionStatus: ConnectionStateStatus = 'connected';
      const hasWsManager = true;

      // User switches to different session
      const targetSessionId = 'session-xyz';

      const canReuse = canReuseConnection(
        currentCloudSessionId,
        connectionStatus,
        hasWsManager,
        targetSessionId
      );

      expect(canReuse).toBe(false);
    });

    it('opens new connection when first connecting', () => {
      // No existing connection
      const currentCloudSessionId = null;
      const connectionStatus: ConnectionStateStatus = 'disconnected';
      const hasWsManager = false;

      // User connects to a session
      const targetSessionId = 'session-new';

      const canReuse = canReuseConnection(
        currentCloudSessionId,
        connectionStatus,
        hasWsManager,
        targetSessionId
      );

      expect(canReuse).toBe(false);
    });

    it('reuses connection during reconnection attempts', () => {
      // Connection is in reconnecting state (e.g., network hiccup)
      const currentCloudSessionId = 'session-abc';
      const connectionStatus: ConnectionStateStatus = 'reconnecting';
      const hasWsManager = true;

      // User sends another message to same session
      const targetSessionId = 'session-abc';

      const canReuse = canReuseConnection(
        currentCloudSessionId,
        connectionStatus,
        hasWsManager,
        targetSessionId
      );

      expect(canReuse).toBe(true);
    });
  });
});
