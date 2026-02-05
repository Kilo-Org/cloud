/**
 * Messages Module Tests
 *
 * Tests for message processing and stream event mapping.
 */

import { updateMessage, addUserMessage, addErrorMessage, processStreamEvent } from '../messages';
import type { ProjectStore } from '../types';
import type { CloudMessage, StreamEvent } from '@/components/cloud-agent/types';

// Helper to create a mock store for testing
function createMockStore(initialMessages: CloudMessage[] = []): ProjectStore {
  let messages = [...initialMessages];
  const listeners = new Set<() => void>();

  return {
    getState: () => ({
      messages,
      isStreaming: false,
      isInterrupting: false,
      previewUrl: null,
      previewStatus: 'idle' as const,
      deploymentId: null,
      model: 'anthropic/claude-sonnet-4',
      currentIframeUrl: null,
    }),
    setState: jest.fn(partial => {
      if (partial.messages) {
        messages = partial.messages;
      }
      listeners.forEach(l => l());
    }),
    subscribe: jest.fn(listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    updateMessages: jest.fn(updater => {
      messages = updater(messages);
      listeners.forEach(l => l());
    }),
  };
}

describe('updateMessage', () => {
  it('adds new message when not existing', () => {
    const store = createMockStore();
    const message: CloudMessage = {
      ts: 1000,
      type: 'user',
      text: 'Hello',
      partial: false,
    };

    updateMessage(store, message);

    expect(store.getState().messages).toHaveLength(1);
    expect(store.getState().messages[0]).toEqual(message);
  });

  it('updates existing message with same timestamp', () => {
    const existingMessage: CloudMessage = {
      ts: 1000,
      type: 'assistant',
      text: 'Hello',
      partial: true,
    };
    const store = createMockStore([existingMessage]);

    const updatedMessage: CloudMessage = {
      ts: 1000,
      type: 'assistant',
      text: 'Hello World',
      partial: true,
    };

    updateMessage(store, updatedMessage);

    expect(store.getState().messages).toHaveLength(1);
    expect(store.getState().messages[0].text).toBe('Hello World');
  });

  it('updates message when partial status changes', () => {
    const existingMessage: CloudMessage = {
      ts: 1000,
      type: 'assistant',
      text: 'Complete',
      partial: true,
    };
    const store = createMockStore([existingMessage]);

    const updatedMessage: CloudMessage = {
      ts: 1000,
      type: 'assistant',
      text: 'Complete',
      partial: false,
    };

    updateMessage(store, updatedMessage);

    expect(store.getState().messages[0].partial).toBe(false);
  });

  it('always replaces existing message with same timestamp', () => {
    const existingMessage: CloudMessage = {
      ts: 1000,
      type: 'assistant',
      text: 'Hello World',
      partial: false,
    };
    const store = createMockStore([existingMessage]);

    const newMessage: CloudMessage = {
      ts: 1000,
      type: 'assistant',
      text: 'Hello',
      partial: false,
    };

    updateMessage(store, newMessage);

    expect(store.getState().messages[0].text).toBe('Hello');
  });

  describe('content-based deduplication for user_feedback', () => {
    it('skips user_feedback message if matching user message exists in last 10 messages', () => {
      // Simulate optimistic user message already in store
      const optimisticMessage: CloudMessage = {
        ts: 1000,
        type: 'user',
        text: 'Hello world',
        partial: false,
      };
      const store = createMockStore([optimisticMessage]);

      // Simulate user_feedback arriving from WebSocket with different timestamp
      const websocketMessage: CloudMessage = {
        ts: 2000, // Different timestamp from server
        type: 'assistant', // WebSocket transforms to assistant type
        say: 'user_feedback',
        text: 'Hello world', // Same content
        partial: false,
      };

      updateMessage(store, websocketMessage);

      // Should still have just one message (the original optimistic one)
      expect(store.getState().messages).toHaveLength(1);
      expect(store.getState().messages[0].ts).toBe(1000); // Original timestamp preserved
    });

    it('adds user_feedback message if no matching user message exists', () => {
      const store = createMockStore();

      // user_feedback from WebSocket with no prior optimistic message
      const websocketMessage: CloudMessage = {
        ts: 2000,
        type: 'assistant',
        say: 'user_feedback',
        text: 'Hello from history replay',
        partial: false,
      };

      updateMessage(store, websocketMessage);

      expect(store.getState().messages).toHaveLength(1);
      expect(store.getState().messages[0]).toEqual(websocketMessage);
    });

    it('adds user_feedback message if content differs from existing user messages', () => {
      const optimisticMessage: CloudMessage = {
        ts: 1000,
        type: 'user',
        text: 'First message',
        partial: false,
      };
      const store = createMockStore([optimisticMessage]);

      // Different content
      const websocketMessage: CloudMessage = {
        ts: 2000,
        type: 'assistant',
        say: 'user_feedback',
        text: 'Different message',
        partial: false,
      };

      updateMessage(store, websocketMessage);

      expect(store.getState().messages).toHaveLength(2);
    });

    it('skips duplicate if within time window, regardless of message count', () => {
      // Create 15 messages, with the matching user message at the start
      const messages: CloudMessage[] = [
        { ts: 100, type: 'user', text: 'Old matching message', partial: false },
        ...Array.from({ length: 14 }, (_, i) => ({
          ts: 200 + i,
          type: 'assistant' as const,
          text: `Message ${i}`,
          partial: false,
        })),
      ];
      const store = createMockStore(messages);

      // user_feedback with same content, within 3 minute window (3000 - 100 = 2900ms < 180000ms)
      const websocketMessage: CloudMessage = {
        ts: 3000,
        type: 'assistant',
        say: 'user_feedback',
        text: 'Old matching message',
        partial: false,
      };

      updateMessage(store, websocketMessage);

      // Should skip because the matching message is within the time window
      expect(store.getState().messages).toHaveLength(15);
    });

    it('adds user_feedback if matching message is outside time window', () => {
      const DEDUP_TIME_WINDOW_MS = 3 * 60 * 1000; // 3 minutes
      const oldTimestamp = 1000;
      const newTimestamp = oldTimestamp + DEDUP_TIME_WINDOW_MS + 1000; // Outside the window

      const messages: CloudMessage[] = [
        { ts: oldTimestamp, type: 'user', text: 'Old matching message', partial: false },
      ];
      const store = createMockStore(messages);

      const websocketMessage: CloudMessage = {
        ts: newTimestamp,
        type: 'assistant',
        say: 'user_feedback',
        text: 'Old matching message',
        partial: false,
      };

      updateMessage(store, websocketMessage);

      // Should add because the matching message is outside the time window
      expect(store.getState().messages).toHaveLength(2);
    });

    it('does not apply content deduplication to non-user_feedback messages', () => {
      const existingMessage: CloudMessage = {
        ts: 1000,
        type: 'user',
        text: 'Hello world',
        partial: false,
      };
      const store = createMockStore([existingMessage]);

      // Regular assistant message with same text (not user_feedback)
      const assistantMessage: CloudMessage = {
        ts: 2000,
        type: 'assistant',
        say: 'text',
        text: 'Hello world',
        partial: false,
      };

      updateMessage(store, assistantMessage);

      // Should add because it's not a user_feedback message
      expect(store.getState().messages).toHaveLength(2);
    });

    it('handles empty/undefined text for deduplication', () => {
      const optimisticMessage: CloudMessage = {
        ts: 1000,
        type: 'user',
        text: undefined,
        partial: false,
      };
      const store = createMockStore([optimisticMessage]);

      const websocketMessage: CloudMessage = {
        ts: 2000,
        type: 'assistant',
        say: 'user_feedback',
        text: undefined,
        partial: false,
      };

      updateMessage(store, websocketMessage);

      // Both undefined should match
      expect(store.getState().messages).toHaveLength(1);
    });
  });
});

describe('addUserMessage', () => {
  it('creates user message with timestamp', () => {
    const store = createMockStore();
    const beforeTs = Date.now();

    addUserMessage(store, 'Hello from user');

    const message = store.getState().messages[0];
    expect(message.type).toBe('user');
    expect(message.text).toBe('Hello from user');
    expect(message.partial).toBe(false);
    expect(message.ts).toBeGreaterThanOrEqual(beforeTs);
  });

  it('includes images when provided', () => {
    const store = createMockStore();
    const images = { path: 'app-builder/msg-123', files: ['image1.png', 'image2.jpg'] };

    addUserMessage(store, 'Check this image', images);

    const message = store.getState().messages[0];
    expect(message.images).toEqual(images);
  });
});

describe('addErrorMessage', () => {
  it('creates system error message', () => {
    const store = createMockStore();
    const beforeTs = Date.now();

    addErrorMessage(store, 'Something went wrong');

    const message = store.getState().messages[0];
    expect(message.type).toBe('system');
    expect(message.say).toBe('error');
    expect(message.text).toBe('Something went wrong');
    expect(message.partial).toBe(false);
    expect(message.ts).toBeGreaterThanOrEqual(beforeTs);
  });
});

describe('processStreamEvent', () => {
  describe('kilocode events', () => {
    it('maps kilocode say event to assistant message', () => {
      const store = createMockStore();
      const event: StreamEvent = {
        streamEventType: 'kilocode',
        payload: {
          type: 'say',
          say: 'text',
          content: 'Hello from assistant',
          timestamp: 1000,
          partial: true,
        },
      };

      processStreamEvent(store, event);

      const message = store.getState().messages[0];
      expect(message.type).toBe('assistant');
      expect(message.say).toBe('text');
      expect(message.text).toBe('Hello from assistant');
      expect(message.partial).toBe(true);
    });

    it('maps kilocode ask event to system message', () => {
      const store = createMockStore();
      const event: StreamEvent = {
        streamEventType: 'kilocode',
        payload: {
          type: 'ask',
          ask: 'tool',
          content: 'Requesting tool use',
          timestamp: 2000,
          partial: false,
        },
      };

      processStreamEvent(store, event);

      const message = store.getState().messages[0];
      expect(message.type).toBe('system');
      expect(message.ask).toBe('tool');
    });

    it('uses Date.now() when timestamp is missing', () => {
      const store = createMockStore();
      const beforeTs = Date.now();
      const event: StreamEvent = {
        streamEventType: 'kilocode',
        payload: {
          type: 'say',
          content: 'No timestamp',
        },
      };

      processStreamEvent(store, event);

      const message = store.getState().messages[0];
      expect(message.ts).toBeGreaterThanOrEqual(beforeTs);
    });

    it('handles text field when content is absent', () => {
      const store = createMockStore();
      const event: StreamEvent = {
        streamEventType: 'kilocode',
        payload: {
          type: 'say',
          text: 'Using text field',
          timestamp: 1000,
        },
      };

      processStreamEvent(store, event);

      const message = store.getState().messages[0];
      expect(message.text).toBe('Using text field');
    });
  });

  describe('status events', () => {
    it('creates system message for status event', () => {
      const store = createMockStore();
      const event: StreamEvent = {
        streamEventType: 'status',
        message: 'Processing request...',
        timestamp: '2024-01-01T00:00:00Z',
      };

      processStreamEvent(store, event);

      const message = store.getState().messages[0];
      expect(message.type).toBe('system');
      expect(message.text).toBe('Processing request...');
      expect(message.partial).toBe(false);
    });
  });

  describe('error events', () => {
    it('creates error message for error event', () => {
      const store = createMockStore();
      const event: StreamEvent = {
        streamEventType: 'error',
        error: 'Connection lost',
        timestamp: '2024-01-01T00:00:00Z',
      };

      processStreamEvent(store, event);

      const message = store.getState().messages[0];
      expect(message.type).toBe('system');
      expect(message.say).toBe('error');
      expect(message.text).toBe('Connection lost');
    });
  });

  describe('interrupted events', () => {
    it('creates system message for interrupted event', () => {
      const store = createMockStore();
      const event: StreamEvent = {
        streamEventType: 'interrupted',
        reason: 'User cancelled',
        timestamp: '2024-01-01T00:00:00Z',
      };

      processStreamEvent(store, event);

      const message = store.getState().messages[0];
      expect(message.type).toBe('system');
      expect(message.text).toBe('User cancelled');
    });

    it('uses default message when reason is missing', () => {
      const store = createMockStore();
      const event = {
        streamEventType: 'interrupted' as const,
        timestamp: '2024-01-01T00:00:00Z',
      } as StreamEvent;

      processStreamEvent(store, event);

      const message = store.getState().messages[0];
      expect(message.text).toBe('Execution interrupted');
    });
  });

  describe('output events', () => {
    it('ignores output events (not displayed)', () => {
      const store = createMockStore();
      const event: StreamEvent = {
        streamEventType: 'output',
        content: 'Raw stdout output',
        source: 'stdout',
        timestamp: '2024-01-01T00:00:00Z',
      };

      processStreamEvent(store, event);

      expect(store.getState().messages).toHaveLength(0);
    });
  });

  describe('complete events', () => {
    it('does not add message for complete event', () => {
      const store = createMockStore();
      const event: StreamEvent = {
        streamEventType: 'complete',
        sessionId: 'session-123',
        exitCode: 0,
        metadata: {
          executionTimeMs: 1000,
          workspace: '/workspace',
          userId: 'user-1',
          startedAt: '2024-01-01T00:00:00Z',
          completedAt: '2024-01-01T00:00:01Z',
        },
      };

      processStreamEvent(store, event);

      // Complete events are handled at the streaming level, not message level
      expect(store.getState().messages).toHaveLength(0);
    });
  });
});
