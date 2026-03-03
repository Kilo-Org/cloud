/**
 * Tests for event-processor.ts
 *
 * These tests verify the EventProcessor's ability to:
 * - Process cloud agent events and emit callbacks for streaming messages
 * - Handle message.updated events with pending parts queue
 * - Handle message.part.updated events with delta streaming
 * - Track child sessions (sessions with parentID) via callbacks
 * - Manage session status and streaming state via callbacks
 * - Fire onMessageCompleted when messages finish
 *
 * All assertions are callback-based - the processor has no getter methods.
 */

import { createEventProcessor } from './event-processor';
import type { EventProcessorCallbacks, ProcessedMessage } from './types';
import type { CloudAgentEvent } from '../event-types';

// Helper to create a CloudAgentEvent
function createEvent(
  streamEventType: string,
  data: unknown,
  sessionId = 'session-123'
): CloudAgentEvent {
  return {
    eventId: Date.now(),
    executionId: 'exec-123',
    sessionId,
    streamEventType,
    timestamp: new Date().toISOString(),
    data,
  };
}

// Helper to create a kilocode-wrapped event
function createKilocodeEvent(
  type: string,
  properties: unknown,
  sessionId = 'session-123'
): CloudAgentEvent {
  return createEvent('kilocode', { type, properties }, sessionId);
}

// Helper to create assistant message info (streaming - no completed time)
function createAssistantInfo(id: string, sessionId = 'session-123', completed?: number) {
  return {
    id,
    sessionID: sessionId,
    role: 'assistant' as const,
    time: { created: Date.now(), ...(completed ? { completed } : {}) },
    parentID: 'parent-msg',
    modelID: 'claude-3',
    providerID: 'anthropic',
    mode: 'code',
    agent: 'build',
    path: { cwd: '/test', root: '/test' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

// Helper to create user message info
function createUserInfo(id: string, sessionId = 'session-123') {
  return {
    id,
    sessionID: sessionId,
    role: 'user' as const,
    time: { created: Date.now() },
    agent: 'build',
    model: { providerID: 'anthropic', modelID: 'claude-3' },
  };
}

describe('createEventProcessor', () => {
  describe('message.updated events', () => {
    it('should create a new message on first message.updated', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      const event = createKilocodeEvent('message.updated', {
        info: createAssistantInfo('msg-1'),
      });

      processor.processEvent(event);

      expect(callbacks.onMessageUpdated).toHaveBeenCalledTimes(1);
      expect(callbacks.onMessageUpdated).toHaveBeenCalledWith(
        'session-123',
        'msg-1',
        expect.objectContaining({
          info: expect.objectContaining({ id: 'msg-1' }),
          parts: [],
        }),
        null // parentSessionId is null for root session
      );
    });

    it('should update existing message info on subsequent message.updated', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // First event (streaming - no completed time)
      processor.processEvent(
        createKilocodeEvent('message.updated', { info: createAssistantInfo('msg-1') })
      );

      // Second event still streaming (no completed time)
      processor.processEvent(
        createKilocodeEvent('message.updated', { info: createAssistantInfo('msg-1') })
      );

      expect(callbacks.onMessageUpdated).toHaveBeenCalledTimes(2);
      // Both calls should have the same message ID
      expect(callbacks.onMessageUpdated).toHaveBeenLastCalledWith(
        'session-123',
        'msg-1',
        expect.objectContaining({ info: expect.objectContaining({ role: 'assistant' }) }),
        null
      );
    });

    it('should fire onMessageCompleted and remove from buffer when assistant message completes', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
        onMessageCompleted: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // First event (streaming)
      processor.processEvent(
        createKilocodeEvent('message.updated', { info: createAssistantInfo('msg-1') })
      );

      expect(callbacks.onMessageUpdated).toHaveBeenCalledTimes(1);
      expect(callbacks.onMessageCompleted).not.toHaveBeenCalled();

      // Second event with completed time
      processor.processEvent(
        createKilocodeEvent('message.updated', {
          info: createAssistantInfo('msg-1', 'session-123', Date.now()),
        })
      );

      expect(callbacks.onMessageCompleted).toHaveBeenCalledTimes(1);
      expect(callbacks.onMessageCompleted).toHaveBeenCalledWith(
        'session-123',
        'msg-1',
        expect.objectContaining({ info: expect.objectContaining({ id: 'msg-1' }) }),
        null // parentSessionId
      );
    });

    it('should complete user messages when session goes idle', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
        onMessageCompleted: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      processor.processEvent(
        createKilocodeEvent('message.updated', { info: createUserInfo('msg-1') })
      );

      // User message is created but not completed yet
      expect(callbacks.onMessageUpdated).toHaveBeenCalledTimes(1);
      expect(callbacks.onMessageCompleted).not.toHaveBeenCalled();

      // Session goes idle - user messages should complete
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'idle' },
        })
      );

      expect(callbacks.onMessageCompleted).toHaveBeenCalledTimes(1);
      expect(callbacks.onMessageCompleted).toHaveBeenCalledWith(
        'session-123',
        'msg-1',
        expect.objectContaining({ info: expect.objectContaining({ role: 'user' }) }),
        null
      );
    });
  });

  describe('message.part.updated events', () => {
    it('should add a part to an existing message', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
        onPartUpdated: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // First create the message
      processor.processEvent(
        createKilocodeEvent('message.updated', { info: createAssistantInfo('msg-1') })
      );

      // Then add a part (no time.end = still streaming)
      processor.processEvent(
        createKilocodeEvent('message.part.updated', {
          part: {
            id: 'part-1',
            sessionID: 'session-123',
            messageID: 'msg-1',
            type: 'text',
            text: 'Hello',
          },
        })
      );

      expect(callbacks.onPartUpdated).toHaveBeenCalledTimes(1);
      expect(callbacks.onPartUpdated).toHaveBeenCalledWith(
        'session-123',
        'msg-1',
        'part-1',
        expect.objectContaining({ id: 'part-1', text: 'Hello' }),
        null // parentSessionId
      );
    });

    it('should queue parts that arrive before their message', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
        onPartUpdated: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Part arrives first (before message)
      processor.processEvent(
        createKilocodeEvent('message.part.updated', {
          part: {
            id: 'part-1',
            sessionID: 'session-123',
            messageID: 'msg-1',
            type: 'text',
            text: 'Hello',
          },
        })
      );

      // Part should be queued, not processed yet
      expect(callbacks.onPartUpdated).not.toHaveBeenCalled();

      // Now the message arrives
      processor.processEvent(
        createKilocodeEvent('message.updated', { info: createAssistantInfo('msg-1') })
      );

      // Pending part should now be applied
      expect(callbacks.onPartUpdated).toHaveBeenCalledTimes(1);
      expect(callbacks.onPartUpdated).toHaveBeenCalledWith(
        'session-123',
        'msg-1',
        'part-1',
        expect.objectContaining({ id: 'part-1' }),
        null
      );
    });

    it('should handle delta streaming for text parts', () => {
      let capturedMessage: ProcessedMessage | undefined;
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn((_, __, message) => {
          capturedMessage = message;
        }),
        onPartUpdated: jest.fn((_, __, ___, part) => {
          // Update captured message with the part for verification
          if (capturedMessage) {
            const partIndex = capturedMessage.parts.findIndex(p => p.id === part.id);
            if (partIndex >= 0) {
              capturedMessage.parts[partIndex] = part;
            }
          }
        }),
      };
      const processor = createEventProcessor({ callbacks });

      // Create message
      processor.processEvent(
        createKilocodeEvent('message.updated', { info: createAssistantInfo('msg-1') })
      );

      // Initial part with delta
      processor.processEvent(
        createKilocodeEvent('message.part.updated', {
          part: {
            id: 'part-1',
            sessionID: 'session-123',
            messageID: 'msg-1',
            type: 'text',
            text: '',
          },
          delta: 'Hello',
        })
      );

      // First delta should set text to 'Hello'
      expect(callbacks.onPartUpdated).toHaveBeenCalledWith(
        'session-123',
        'msg-1',
        'part-1',
        expect.objectContaining({ text: 'Hello' }),
        null
      );

      // Streaming delta
      processor.processEvent(
        createKilocodeEvent('message.part.updated', {
          part: {
            id: 'part-1',
            sessionID: 'session-123',
            messageID: 'msg-1',
            type: 'text',
            text: '',
          },
          delta: ' World',
        })
      );

      // Second delta should accumulate to 'Hello World'
      expect(callbacks.onPartUpdated).toHaveBeenLastCalledWith(
        'session-123',
        'msg-1',
        'part-1',
        expect.objectContaining({ text: 'Hello World' }),
        null
      );
    });

    it('should complete message when assistant message has completed time', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
        onPartUpdated: jest.fn(),
        onMessageCompleted: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Create streaming message (no completed time yet)
      processor.processEvent(
        createKilocodeEvent('message.updated', {
          info: createAssistantInfo('msg-1', 'session-123'), // No completed time
        })
      );

      // Add a streaming part (has time.start but no time.end)
      processor.processEvent(
        createKilocodeEvent('message.part.updated', {
          part: {
            id: 'part-1',
            sessionID: 'session-123',
            messageID: 'msg-1',
            type: 'text',
            text: 'Hello',
            time: { start: Date.now() }, // No end time = streaming
          },
        })
      );

      expect(callbacks.onMessageCompleted).not.toHaveBeenCalled();

      // Update message to completed
      processor.processEvent(
        createKilocodeEvent('message.updated', {
          info: createAssistantInfo('msg-1', 'session-123', Date.now()), // Now has completed time
        })
      );

      // Message should be complete now
      expect(callbacks.onMessageCompleted).toHaveBeenCalledTimes(1);
      expect(callbacks.onMessageCompleted).toHaveBeenCalledWith(
        'session-123',
        'msg-1',
        expect.objectContaining({ info: expect.objectContaining({ id: 'msg-1' }) }),
        null
      );
    });
  });

  describe('message.part.removed events', () => {
    it('should remove a part from a message', () => {
      const callbacks: EventProcessorCallbacks = {
        onPartUpdated: jest.fn(),
        onPartRemoved: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Create message with part
      processor.processEvent(
        createKilocodeEvent('message.updated', { info: createAssistantInfo('msg-1') })
      );

      processor.processEvent(
        createKilocodeEvent('message.part.updated', {
          part: {
            id: 'part-1',
            sessionID: 'session-123',
            messageID: 'msg-1',
            type: 'text',
            text: 'Hello',
          },
        })
      );

      expect(callbacks.onPartUpdated).toHaveBeenCalledTimes(1);

      // Remove the part
      processor.processEvent(
        createKilocodeEvent('message.part.removed', {
          sessionID: 'session-123',
          messageID: 'msg-1',
          partID: 'part-1',
        })
      );

      expect(callbacks.onPartRemoved).toHaveBeenCalledWith(
        'session-123',
        'msg-1',
        'part-1',
        null // parentSessionId
      );
    });
  });

  describe('session.status events', () => {
    it('should update session status to busy and set streaming true', () => {
      const callbacks: EventProcessorCallbacks = {
        onSessionStatusChanged: jest.fn(),
        onStreamingChanged: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'busy' },
        })
      );

      expect(callbacks.onSessionStatusChanged).toHaveBeenCalledWith({ type: 'busy' });
      expect(callbacks.onStreamingChanged).toHaveBeenCalledWith(true);
    });

    it('should update session status to idle without stopping streaming (complete event does that)', () => {
      const callbacks: EventProcessorCallbacks = {
        onSessionStatusChanged: jest.fn(),
        onStreamingChanged: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // First set to busy
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'busy' },
        })
      );

      // Then set to idle — streaming should NOT stop yet
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'idle' },
        })
      );

      expect(callbacks.onSessionStatusChanged).toHaveBeenLastCalledWith({ type: 'idle' });
      // onStreamingChanged should only have been called once (busy=true)
      expect(callbacks.onStreamingChanged).toHaveBeenCalledTimes(1);
      expect(callbacks.onStreamingChanged).toHaveBeenCalledWith(true);
    });

    it('should handle retry status without changing streaming state', () => {
      const callbacks: EventProcessorCallbacks = {
        onSessionStatusChanged: jest.fn(),
        onStreamingChanged: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // First set to busy
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'busy' },
        })
      );

      // Then set to retry
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'retry', attempt: 1, message: 'Rate limited', next: Date.now() + 5000 },
        })
      );

      // onStreamingChanged should only be called once (for busy)
      expect(callbacks.onStreamingChanged).toHaveBeenCalledTimes(1);
      expect(callbacks.onStreamingChanged).toHaveBeenCalledWith(true);
    });
  });

  describe('session.created events', () => {
    it('should track child sessions by parentID and route messages correctly', () => {
      const callbacks: EventProcessorCallbacks = {
        onSessionCreated: jest.fn(),
        onMessageUpdated: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Create a child session
      processor.processEvent(
        createKilocodeEvent('session.created', {
          info: {
            id: 'child-session-1',
            slug: 'child',
            projectID: 'proj-1',
            directory: '/test',
            parentID: 'session-123',
            title: 'Child Session',
            version: '1.0',
            time: { created: Date.now(), updated: Date.now() },
          },
        })
      );

      expect(callbacks.onSessionCreated).toHaveBeenCalled();

      // Now send a message to the child session
      processor.processEvent(
        createKilocodeEvent(
          'message.updated',
          {
            info: createAssistantInfo('child-msg-1', 'child-session-1'),
          },
          'child-session-1'
        )
      );

      // Should call onMessageUpdated with parentSessionId set
      expect(callbacks.onMessageUpdated).toHaveBeenCalledWith(
        'child-session-1',
        'child-msg-1',
        expect.objectContaining({ info: expect.objectContaining({ id: 'child-msg-1' }) }),
        'session-123' // parentSessionId
      );
    });

    it('should distinguish root and child session messages via parentSessionId callback arg', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Create a child session
      processor.processEvent(
        createKilocodeEvent('session.created', {
          info: {
            id: 'child-session-1',
            slug: 'child',
            projectID: 'proj-1',
            directory: '/test',
            parentID: 'session-123',
            title: 'Child Session',
            version: '1.0',
            time: { created: Date.now(), updated: Date.now() },
          },
        })
      );

      // Add a message to root session
      processor.processEvent(
        createKilocodeEvent('message.updated', { info: createAssistantInfo('root-msg-1') })
      );

      // Add a message to child session
      processor.processEvent(
        createKilocodeEvent(
          'message.updated',
          { info: createAssistantInfo('child-msg-1', 'child-session-1') },
          'child-session-1'
        )
      );

      // Verify root session message has parentSessionId = null
      expect(callbacks.onMessageUpdated).toHaveBeenCalledWith(
        'session-123',
        'root-msg-1',
        expect.anything(),
        null // root session
      );

      // Verify child session message has parentSessionId = 'session-123'
      expect(callbacks.onMessageUpdated).toHaveBeenCalledWith(
        'child-session-1',
        'child-msg-1',
        expect.anything(),
        'session-123' // child session
      );
    });
  });

  describe('child session event filtering', () => {
    // Helper: register a child session
    function registerChildSession(
      processor: ReturnType<typeof createEventProcessor>,
      childId: string,
      parentId: string
    ) {
      processor.processEvent(
        createKilocodeEvent('session.created', {
          info: {
            id: childId,
            slug: 'child',
            projectID: 'proj-1',
            directory: '/test',
            parentID: parentId,
            title: 'Child Session',
            version: '1.0',
            time: { created: Date.now(), updated: Date.now() },
          },
        })
      );
    }

    it('should not fire onSessionStatusChanged or onStreamingChanged for child session status events', () => {
      const callbacks: EventProcessorCallbacks = {
        onSessionStatusChanged: jest.fn(),
        onStreamingChanged: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      registerChildSession(processor, 'child-1', 'session-123');

      // Child session goes busy
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'child-1',
          status: { type: 'busy' },
        })
      );

      expect(callbacks.onSessionStatusChanged).not.toHaveBeenCalled();
      expect(callbacks.onStreamingChanged).not.toHaveBeenCalled();

      // Child session goes idle
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'child-1',
          status: { type: 'idle' },
        })
      );

      expect(callbacks.onSessionStatusChanged).not.toHaveBeenCalled();
      expect(callbacks.onStreamingChanged).not.toHaveBeenCalled();
    });

    it('should not toggle streaming when child session emits session.idle', () => {
      const callbacks: EventProcessorCallbacks = {
        onStreamingChanged: jest.fn(),
        onMessageCompleted: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      registerChildSession(processor, 'child-1', 'session-123');

      // Root session goes busy (sets streaming = true)
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'busy' },
        })
      );

      expect(callbacks.onStreamingChanged).toHaveBeenCalledWith(true);

      // Child session emits idle — should NOT set streaming false
      // (neither root nor child idle stops streaming; only `complete` does)
      processor.processEvent(createKilocodeEvent('session.idle', { sessionID: 'child-1' }));

      // onStreamingChanged should only have been called once (the busy=true)
      expect(callbacks.onStreamingChanged).toHaveBeenCalledTimes(1);
    });

    it('should still complete user messages when child session goes idle', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
        onMessageCompleted: jest.fn(),
        onStreamingChanged: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      registerChildSession(processor, 'child-1', 'session-123');

      // Create a user message in the child session
      processor.processEvent(
        createKilocodeEvent(
          'message.updated',
          { info: createUserInfo('child-user-msg', 'child-1') },
          'child-1'
        )
      );

      expect(callbacks.onMessageCompleted).not.toHaveBeenCalled();

      // Child session goes idle — user messages should still complete
      processor.processEvent(createKilocodeEvent('session.idle', { sessionID: 'child-1' }));

      expect(callbacks.onMessageCompleted).toHaveBeenCalledTimes(1);
      expect(callbacks.onMessageCompleted).toHaveBeenCalledWith(
        'child-1',
        'child-user-msg',
        expect.objectContaining({ info: expect.objectContaining({ role: 'user' }) }),
        'session-123'
      );
    });

    it('should not toggle streaming for child session error, but still fire onError', () => {
      const callbacks: EventProcessorCallbacks = {
        onError: jest.fn(),
        onStreamingChanged: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      registerChildSession(processor, 'child-1', 'session-123');

      // Root session goes busy
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'busy' },
        })
      );

      expect(callbacks.onStreamingChanged).toHaveBeenCalledWith(true);

      // Child session error — should NOT toggle streaming
      processor.processEvent(
        createKilocodeEvent('session.error', {
          sessionID: 'child-1',
          error: 'Child failed',
        })
      );

      // onError should fire for child sessions
      expect(callbacks.onError).toHaveBeenCalledWith('Child failed', 'child-1');
      // streaming should still be true (only 1 call: the busy=true)
      expect(callbacks.onStreamingChanged).toHaveBeenCalledTimes(1);
    });

    it('should not toggle streaming for child session turn close error, but still complete messages', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
        onMessageCompleted: jest.fn(),
        onStreamingChanged: jest.fn(),
        onError: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      registerChildSession(processor, 'child-1', 'session-123');

      // Root session goes busy
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'busy' },
        })
      );

      // Create an in-flight assistant message in the child session
      processor.processEvent(
        createKilocodeEvent(
          'message.updated',
          { info: createAssistantInfo('child-msg-1', 'child-1') },
          'child-1'
        )
      );

      // Child turn closes with error
      processor.processEvent(
        createKilocodeEvent('session.turn.close', {
          sessionID: 'child-1',
          reason: 'error',
        })
      );

      // Message should be force-completed
      expect(callbacks.onMessageCompleted).toHaveBeenCalledTimes(1);
      // No ErrorBanner — the session is still alive
      expect(callbacks.onError).not.toHaveBeenCalled();
      // streaming should still be true (only 1 call: the busy=true)
      expect(callbacks.onStreamingChanged).toHaveBeenCalledTimes(1);
    });
  });

  describe('session.error events', () => {
    it('should call onError callback and stop streaming', () => {
      const callbacks: EventProcessorCallbacks = {
        onError: jest.fn(),
        onStreamingChanged: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Start streaming
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'busy' },
        })
      );

      // Error event
      processor.processEvent(
        createKilocodeEvent('session.error', {
          sessionID: 'session-123',
          error: 'Something went wrong',
        })
      );

      expect(callbacks.onError).toHaveBeenCalledWith('Something went wrong', 'session-123');
      expect(callbacks.onStreamingChanged).toHaveBeenLastCalledWith(false);
    });
  });

  describe('message ordering via callbacks', () => {
    it('should emit messages in order they are received', () => {
      const messageIds: string[] = [];
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn((_, messageId) => {
          messageIds.push(messageId);
        }),
      };
      const processor = createEventProcessor({ callbacks });

      const now = Date.now();

      // Add messages (both streaming - no completed time)
      processor.processEvent(
        createKilocodeEvent('message.updated', {
          info: { ...createAssistantInfo('msg-2'), time: { created: now + 1000 } },
        })
      );

      processor.processEvent(
        createKilocodeEvent('message.updated', {
          info: { ...createAssistantInfo('msg-1'), time: { created: now } },
        })
      );

      expect(messageIds).toEqual(['msg-2', 'msg-1']);
    });

    it('should not emit completed messages after completion', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
        onMessageCompleted: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Add streaming message
      processor.processEvent(
        createKilocodeEvent('message.updated', { info: createAssistantInfo('msg-1') })
      );

      // Add completed message
      processor.processEvent(
        createKilocodeEvent('message.updated', {
          info: createAssistantInfo('msg-2', 'session-123', Date.now()),
        })
      );

      expect(callbacks.onMessageUpdated).toHaveBeenCalledTimes(2);
      expect(callbacks.onMessageCompleted).toHaveBeenCalledTimes(1);
      expect(callbacks.onMessageCompleted).toHaveBeenCalledWith(
        'session-123',
        'msg-2',
        expect.anything(),
        null
      );
    });
  });

  describe('clear', () => {
    it('should allow processing new events after clear', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
        onSessionStatusChanged: jest.fn(),
        onStreamingChanged: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Add some state
      processor.processEvent(
        createKilocodeEvent('message.updated', { info: createAssistantInfo('msg-1') })
      );

      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'busy' },
        })
      );

      expect(callbacks.onMessageUpdated).toHaveBeenCalledTimes(1);
      expect(callbacks.onStreamingChanged).toHaveBeenCalledWith(true);

      // Clear
      processor.clear();

      // Process new events
      processor.processEvent(
        createKilocodeEvent('message.updated', { info: createAssistantInfo('msg-2') })
      );

      expect(callbacks.onMessageUpdated).toHaveBeenCalledTimes(2);
      expect(callbacks.onMessageUpdated).toHaveBeenLastCalledWith(
        'session-123',
        'msg-2',
        expect.anything(),
        null
      );
    });
  });

  describe('unwrapped events', () => {
    it('should handle events without kilocode wrapper', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Direct event without kilocode wrapper
      const event = createEvent('message.updated', {
        info: createUserInfo('msg-1'),
      });

      processor.processEvent(event);

      expect(callbacks.onMessageUpdated).toHaveBeenCalled();
    });
  });

  describe('session.turn.close events', () => {
    it('should force-complete in-flight assistant messages on error reason', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
        onMessageCompleted: jest.fn(),
        onStreamingChanged: jest.fn(),
        onError: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Start streaming
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'busy' },
        })
      );

      // Create an in-flight assistant message (no completed time)
      processor.processEvent(
        createKilocodeEvent('message.updated', { info: createAssistantInfo('msg-1') })
      );

      expect(callbacks.onMessageCompleted).not.toHaveBeenCalled();

      // Turn closes with error
      processor.processEvent(
        createKilocodeEvent('session.turn.close', {
          sessionID: 'session-123',
          reason: 'error',
        })
      );

      // Should force-complete the assistant message
      expect(callbacks.onMessageCompleted).toHaveBeenCalledTimes(1);
      expect(callbacks.onMessageCompleted).toHaveBeenCalledWith(
        'session-123',
        'msg-1',
        expect.objectContaining({
          info: expect.objectContaining({
            id: 'msg-1',
            time: expect.objectContaining({ completed: expect.any(Number) }),
          }),
        }),
        null
      );

      // No ErrorBanner — the session is still alive, user can retry
      expect(callbacks.onError).not.toHaveBeenCalled();
    });

    it('should not force-complete messages when reason is not error', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
        onMessageCompleted: jest.fn(),
        onError: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Create an in-flight assistant message
      processor.processEvent(
        createKilocodeEvent('message.updated', { info: createAssistantInfo('msg-1') })
      );

      // Turn closes without error reason
      processor.processEvent(
        createKilocodeEvent('session.turn.close', {
          sessionID: 'session-123',
          reason: 'complete',
        })
      );

      // Should not force-complete
      expect(callbacks.onMessageCompleted).not.toHaveBeenCalled();
      expect(callbacks.onError).not.toHaveBeenCalled();
    });

    it('should also complete pending user messages on error turn close', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
        onMessageCompleted: jest.fn(),
        onError: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Create a user message (won't have completed time)
      processor.processEvent(
        createKilocodeEvent('message.updated', { info: createUserInfo('user-msg-1') })
      );

      // Create an assistant message (no completed time)
      processor.processEvent(
        createKilocodeEvent('message.updated', { info: createAssistantInfo('assist-msg-1') })
      );

      // Turn closes with error
      processor.processEvent(
        createKilocodeEvent('session.turn.close', {
          sessionID: 'session-123',
          reason: 'error',
        })
      );

      // Both messages should be completed
      expect(callbacks.onMessageCompleted).toHaveBeenCalledTimes(2);
    });
  });

  describe('forceCompleteAll', () => {
    it('should force-complete in-flight assistant messages', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
        onMessageCompleted: jest.fn(),
        onStreamingChanged: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Start streaming
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'busy' },
        })
      );

      // Create an in-flight assistant message (no completed time)
      processor.processEvent(
        createKilocodeEvent('message.updated', { info: createAssistantInfo('msg-1') })
      );

      expect(callbacks.onMessageCompleted).not.toHaveBeenCalled();

      processor.forceCompleteAll();

      expect(callbacks.onMessageCompleted).toHaveBeenCalledTimes(1);
      expect(callbacks.onMessageCompleted).toHaveBeenCalledWith(
        'session-123',
        'msg-1',
        expect.objectContaining({
          info: expect.objectContaining({
            id: 'msg-1',
            time: expect.objectContaining({ completed: expect.any(Number) }),
          }),
        }),
        null
      );

      expect(callbacks.onStreamingChanged).toHaveBeenLastCalledWith(false);
    });

    it('should complete pending user messages', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
        onMessageCompleted: jest.fn(),
        onStreamingChanged: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Create a user message
      processor.processEvent(
        createKilocodeEvent('message.updated', { info: createUserInfo('user-msg-1') })
      );

      // Create an assistant message
      processor.processEvent(
        createKilocodeEvent('message.updated', { info: createAssistantInfo('assist-msg-1') })
      );

      processor.forceCompleteAll();

      // Both should be completed
      expect(callbacks.onMessageCompleted).toHaveBeenCalledTimes(2);
    });

    it('should not fire onError', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
        onMessageCompleted: jest.fn(),
        onError: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Create an in-flight assistant message
      processor.processEvent(
        createKilocodeEvent('message.updated', { info: createAssistantInfo('msg-1') })
      );

      processor.forceCompleteAll();

      // forceCompleteAll should NOT fire onError (unlike handleSessionTurnClose)
      expect(callbacks.onError).not.toHaveBeenCalled();
      expect(callbacks.onMessageCompleted).toHaveBeenCalledTimes(1);
    });

    it('should be a no-op when there are no in-flight messages', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageCompleted: jest.fn(),
        onStreamingChanged: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      processor.forceCompleteAll();

      expect(callbacks.onMessageCompleted).not.toHaveBeenCalled();
      expect(callbacks.onStreamingChanged).not.toHaveBeenCalled();
    });

    it('should ignore already-completed assistant messages', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
        onMessageCompleted: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Create and complete an assistant message normally
      processor.processEvent(
        createKilocodeEvent('message.updated', { info: createAssistantInfo('msg-1') })
      );
      processor.processEvent(
        createKilocodeEvent('message.updated', {
          info: createAssistantInfo('msg-1', 'session-123', Date.now()),
        })
      );

      expect(callbacks.onMessageCompleted).toHaveBeenCalledTimes(1);

      // forceCompleteAll should not re-complete it
      processor.forceCompleteAll();

      expect(callbacks.onMessageCompleted).toHaveBeenCalledTimes(1);
    });
  });

  describe('question events', () => {
    it('should call onQuestionAsked with callId and requestId for tool-associated questions', () => {
      const callbacks: EventProcessorCallbacks = {
        onQuestionAsked: jest.fn(),
        onStandaloneQuestionAsked: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      processor.processEvent(
        createKilocodeEvent('question.asked', {
          id: 'req-1',
          sessionID: 'session-123',
          questions: [{ question: 'Pick one', header: 'Choice', options: [], multiple: false }],
          tool: { messageID: 'msg-1', callID: 'call-1' },
        })
      );

      expect(callbacks.onQuestionAsked).toHaveBeenCalledWith('req-1', 'call-1');
      expect(callbacks.onStandaloneQuestionAsked).not.toHaveBeenCalled();
    });

    it('should call onStandaloneQuestionAsked for questions without tool.callID', () => {
      const callbacks: EventProcessorCallbacks = {
        onQuestionAsked: jest.fn(),
        onStandaloneQuestionAsked: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      const questions = [
        {
          question: 'Ready?',
          header: 'Implement',
          options: [{ label: 'Yes', description: 'Go' }],
          custom: true,
        },
      ];

      processor.processEvent(
        createKilocodeEvent('question.asked', {
          id: 'req-2',
          sessionID: 'session-123',
          questions,
        })
      );

      expect(callbacks.onStandaloneQuestionAsked).toHaveBeenCalledWith('req-2', questions);
      expect(callbacks.onQuestionAsked).not.toHaveBeenCalled();
    });

    it('should call onQuestionResolved with requestId on question.rejected', () => {
      const callbacks: EventProcessorCallbacks = {
        onQuestionResolved: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      processor.processEvent(
        createKilocodeEvent('question.rejected', {
          sessionID: 'session-123',
          requestID: 'req-1',
        })
      );

      expect(callbacks.onQuestionResolved).toHaveBeenCalledWith('req-1');
    });

    it('should call onQuestionResolved with requestId on question.replied', () => {
      const callbacks: EventProcessorCallbacks = {
        onQuestionResolved: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      processor.processEvent(
        createKilocodeEvent('question.replied', {
          sessionID: 'session-123',
          requestID: 'req-1',
          answers: [['Yes']],
        })
      );

      expect(callbacks.onQuestionResolved).toHaveBeenCalledWith('req-1');
    });

    it('should not call onStandaloneQuestionAsked when questions array is missing', () => {
      const callbacks: EventProcessorCallbacks = {
        onQuestionAsked: jest.fn(),
        onStandaloneQuestionAsked: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      processor.processEvent(
        createKilocodeEvent('question.asked', {
          id: 'req-3',
          sessionID: 'session-123',
        })
      );

      expect(callbacks.onQuestionAsked).not.toHaveBeenCalled();
      expect(callbacks.onStandaloneQuestionAsked).not.toHaveBeenCalled();
    });
  });

  describe('termination events (interrupted, wrapper_disconnected, error)', () => {
    it('interrupted should stop streaming and force-complete messages without calling onError', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
        onMessageCompleted: jest.fn(),
        onStreamingChanged: jest.fn(),
        onError: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Start streaming
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'busy' },
        })
      );

      // Create an in-flight assistant message
      processor.processEvent(
        createKilocodeEvent('message.updated', {
          info: createAssistantInfo('msg-1'),
        })
      );

      // Interrupted event (top-level streamEventType, not kilocode-wrapped)
      processor.processEvent(createEvent('interrupted', { reason: 'Session stopped' }));

      expect(callbacks.onError).not.toHaveBeenCalled();
      expect(callbacks.onStreamingChanged).toHaveBeenLastCalledWith(false);
      expect(callbacks.onMessageCompleted).toHaveBeenCalledTimes(1);
    });

    it('wrapper_disconnected should stop streaming and force-complete messages without calling onError', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
        onMessageCompleted: jest.fn(),
        onStreamingChanged: jest.fn(),
        onError: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Start streaming
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'busy' },
        })
      );

      // Create an in-flight assistant message
      processor.processEvent(
        createKilocodeEvent('message.updated', {
          info: createAssistantInfo('msg-1'),
        })
      );

      // Wrapper disconnected event
      processor.processEvent(createEvent('wrapper_disconnected', { reason: 'container died' }));

      expect(callbacks.onError).not.toHaveBeenCalled();
      expect(callbacks.onStreamingChanged).toHaveBeenLastCalledWith(false);
      expect(callbacks.onMessageCompleted).toHaveBeenCalledTimes(1);
    });

    it('bare error (fatal) should stop streaming and force-complete messages without calling onError', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
        onMessageCompleted: jest.fn(),
        onStreamingChanged: jest.fn(),
        onError: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Start streaming
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'busy' },
        })
      );

      // Create an in-flight assistant message
      processor.processEvent(
        createKilocodeEvent('message.updated', {
          info: createAssistantInfo('msg-1'),
        })
      );

      // Fatal error event
      processor.processEvent(createEvent('error', { error: 'Process killed', fatal: true }));

      expect(callbacks.onError).not.toHaveBeenCalled();
      expect(callbacks.onStreamingChanged).toHaveBeenLastCalledWith(false);
      expect(callbacks.onMessageCompleted).toHaveBeenCalledTimes(1);
    });

    it('session.error after interrupted should be silently dropped', () => {
      const callbacks: EventProcessorCallbacks = {
        onStreamingChanged: jest.fn(),
        onError: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Start streaming
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'busy' },
        })
      );

      // Interrupted event
      processor.processEvent(createEvent('interrupted', { reason: 'Session stopped' }));

      // session.error arrives as an aftershock (CLI dying)
      processor.processEvent(
        createKilocodeEvent('session.error', {
          sessionID: 'session-123',
          error: 'MessageAbortedError',
        })
      );

      // onError should NOT have been called — the session.error is an aftershock
      expect(callbacks.onError).not.toHaveBeenCalled();
    });

    it('session.error without prior termination should still call onError', () => {
      const callbacks: EventProcessorCallbacks = {
        onStreamingChanged: jest.fn(),
        onError: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Start streaming
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'busy' },
        })
      );

      // session.error without any prior termination event
      processor.processEvent(
        createKilocodeEvent('session.error', {
          sessionID: 'session-123',
          error: 'Something went wrong',
        })
      );

      expect(callbacks.onError).toHaveBeenCalledWith('Something went wrong', 'session-123');
    });

    it('clear() should reset terminated state', () => {
      const callbacks: EventProcessorCallbacks = {
        onStreamingChanged: jest.fn(),
        onError: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Start streaming, then interrupt
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'busy' },
        })
      );
      processor.processEvent(createEvent('interrupted', { reason: 'Session stopped' }));

      // Clear and start fresh
      processor.clear();
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'busy' },
        })
      );

      // session.error should now trigger onError again (terminated was reset)
      processor.processEvent(
        createKilocodeEvent('session.error', {
          sessionID: 'session-123',
          error: 'Real error',
        })
      );

      expect(callbacks.onError).toHaveBeenCalledWith('Real error', 'session-123');
    });

    it('session.error after interrupted + new busy status should call onError', () => {
      const callbacks: EventProcessorCallbacks = {
        onStreamingChanged: jest.fn(),
        onError: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // First execution: start streaming, then interrupt
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'busy' },
        })
      );
      processor.processEvent(createEvent('interrupted', { reason: 'Session stopped' }));

      // Second execution: new busy status (user sent another message)
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'busy' },
        })
      );

      // session.error from the NEW execution should NOT be suppressed
      processor.processEvent(
        createKilocodeEvent('session.error', {
          sessionID: 'session-123',
          error: 'Real error from new execution',
        })
      );

      expect(callbacks.onError).toHaveBeenCalledWith(
        'Real error from new execution',
        'session-123'
      );
    });
  });

  describe('complete event (execution fully done)', () => {
    it('should stop streaming when complete event arrives', () => {
      const callbacks: EventProcessorCallbacks = {
        onStreamingChanged: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Start streaming
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'busy' },
        })
      );

      expect(callbacks.onStreamingChanged).toHaveBeenCalledWith(true);

      // Complete event arrives (wrapper finished including autocommit)
      processor.processEvent(createEvent('complete', {}));

      expect(callbacks.onStreamingChanged).toHaveBeenLastCalledWith(false);
    });

    it('should stop streaming only on complete, not on session.idle', () => {
      const callbacks: EventProcessorCallbacks = {
        onStreamingChanged: jest.fn(),
        onSessionStatusChanged: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Start streaming
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'busy' },
        })
      );

      // Session goes idle (CLI finished, autocommit about to start)
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'idle' },
        })
      );

      // Streaming should still be true (only busy=true call so far)
      expect(callbacks.onStreamingChanged).toHaveBeenCalledTimes(1);
      expect(callbacks.onStreamingChanged).toHaveBeenCalledWith(true);

      // Complete event arrives after autocommit
      processor.processEvent(createEvent('complete', {}));

      expect(callbacks.onStreamingChanged).toHaveBeenCalledTimes(2);
      expect(callbacks.onStreamingChanged).toHaveBeenLastCalledWith(false);
    });

    it('should be a no-op when not streaming', () => {
      const callbacks: EventProcessorCallbacks = {
        onStreamingChanged: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Complete without ever starting streaming
      processor.processEvent(createEvent('complete', {}));

      expect(callbacks.onStreamingChanged).not.toHaveBeenCalled();
    });

    it('full lifecycle: busy → idle → autocommit → complete', () => {
      const callbacks: EventProcessorCallbacks = {
        onStreamingChanged: jest.fn(),
        onSessionStatusChanged: jest.fn(),
        onAutocommitUpdated: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // 1. Session starts
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'busy' },
        })
      );
      expect(callbacks.onStreamingChanged).toHaveBeenLastCalledWith(true);

      // 2. CLI finishes, session goes idle
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'idle' },
        })
      );
      // Still streaming
      expect(callbacks.onStreamingChanged).toHaveBeenCalledTimes(1);

      // 3. Autocommit starts
      processor.processEvent(
        createEvent('autocommit_started', { message: 'Committing...', messageId: 'msg-1' })
      );
      expect(callbacks.onAutocommitUpdated).toHaveBeenCalledTimes(1);
      // Still streaming
      expect(callbacks.onStreamingChanged).toHaveBeenCalledTimes(1);

      // 4. Autocommit completes
      processor.processEvent(
        createEvent('autocommit_completed', {
          success: true,
          message: 'Done',
          messageId: 'msg-1',
          commitHash: 'abc123',
        })
      );
      // Still streaming (complete hasn't fired yet)
      expect(callbacks.onStreamingChanged).toHaveBeenCalledTimes(1);

      // 5. Wrapper sends complete
      processor.processEvent(createEvent('complete', {}));
      expect(callbacks.onStreamingChanged).toHaveBeenCalledTimes(2);
      expect(callbacks.onStreamingChanged).toHaveBeenLastCalledWith(false);
    });
  });

  describe('autocommit events', () => {
    it('autocommit_started with messageId should fire onAutocommitUpdated with in_progress', () => {
      const callbacks: EventProcessorCallbacks = {
        onAutocommitUpdated: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      processor.processEvent(
        createEvent('autocommit_started', {
          message: 'Generating commit message...',
          messageId: 'msg-42',
        })
      );

      expect(callbacks.onAutocommitUpdated).toHaveBeenCalledTimes(1);
      expect(callbacks.onAutocommitUpdated).toHaveBeenCalledWith(
        'msg-42',
        expect.objectContaining({
          status: 'in_progress',
          message: 'Generating commit message...',
          timestamp: expect.any(String),
        })
      );
    });

    it('autocommit_started without messageId should not fire callback', () => {
      const callbacks: EventProcessorCallbacks = {
        onAutocommitUpdated: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      processor.processEvent(
        createEvent('autocommit_started', { message: 'Generating commit message...' })
      );

      expect(callbacks.onAutocommitUpdated).not.toHaveBeenCalled();
    });

    it('autocommit_started should use default message when none provided', () => {
      const callbacks: EventProcessorCallbacks = {
        onAutocommitUpdated: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      processor.processEvent(createEvent('autocommit_started', { messageId: 'msg-42' }));

      expect(callbacks.onAutocommitUpdated).toHaveBeenCalledWith(
        'msg-42',
        expect.objectContaining({
          status: 'in_progress',
          message: 'Committing changes...',
        })
      );
    });

    it('autocommit_completed with success should fire onAutocommitUpdated with completed', () => {
      const callbacks: EventProcessorCallbacks = {
        onAutocommitUpdated: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      processor.processEvent(
        createEvent('autocommit_completed', {
          success: true,
          message: 'Committed abc123',
          commitHash: 'abc123',
          commitMessage: 'fix: resolve race condition',
          messageId: 'msg-42',
        })
      );

      expect(callbacks.onAutocommitUpdated).toHaveBeenCalledTimes(1);
      expect(callbacks.onAutocommitUpdated).toHaveBeenCalledWith(
        'msg-42',
        expect.objectContaining({
          status: 'completed',
          message: 'Committed abc123',
          commitHash: 'abc123',
          commitMessage: 'fix: resolve race condition',
          timestamp: expect.any(String),
        })
      );
    });

    it('autocommit_completed with success: false should fire onAutocommitUpdated with failed', () => {
      const callbacks: EventProcessorCallbacks = {
        onAutocommitUpdated: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      processor.processEvent(
        createEvent('autocommit_completed', {
          success: false,
          message: 'git push rejected',
          messageId: 'msg-42',
        })
      );

      expect(callbacks.onAutocommitUpdated).toHaveBeenCalledTimes(1);
      expect(callbacks.onAutocommitUpdated).toHaveBeenCalledWith(
        'msg-42',
        expect.objectContaining({
          status: 'failed',
          message: 'git push rejected',
        })
      );
    });

    it('autocommit_completed with skipped: true should not fire callback', () => {
      const callbacks: EventProcessorCallbacks = {
        onAutocommitUpdated: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      processor.processEvent(
        createEvent('autocommit_completed', {
          success: true,
          skipped: true,
          messageId: 'msg-42',
        })
      );

      expect(callbacks.onAutocommitUpdated).not.toHaveBeenCalled();
    });

    it('autocommit_completed without messageId should not fire callback', () => {
      const callbacks: EventProcessorCallbacks = {
        onAutocommitUpdated: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      processor.processEvent(
        createEvent('autocommit_completed', {
          success: true,
          message: 'Committed',
        })
      );

      expect(callbacks.onAutocommitUpdated).not.toHaveBeenCalled();
    });

    it('autocommit_completed should use default messages when none provided', () => {
      const callbacks: EventProcessorCallbacks = {
        onAutocommitUpdated: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Success without message
      processor.processEvent(
        createEvent('autocommit_completed', { success: true, messageId: 'msg-1' })
      );

      expect(callbacks.onAutocommitUpdated).toHaveBeenCalledWith(
        'msg-1',
        expect.objectContaining({ status: 'completed', message: 'Changes committed' })
      );

      // Failure without message
      processor.processEvent(
        createEvent('autocommit_completed', { success: false, messageId: 'msg-2' })
      );

      expect(callbacks.onAutocommitUpdated).toHaveBeenCalledWith(
        'msg-2',
        expect.objectContaining({ status: 'failed', message: 'Commit failed' })
      );
    });
  });

  describe('invalid events', () => {
    it('should ignore events with unknown types', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      processor.processEvent(createKilocodeEvent('unknown.event', { foo: 'bar' }));

      expect(callbacks.onMessageUpdated).not.toHaveBeenCalled();
    });

    it('should ignore invalid event structures', () => {
      const callbacks: EventProcessorCallbacks = {
        onMessageUpdated: jest.fn(),
      };
      const processor = createEventProcessor({ callbacks });

      // Invalid event missing required fields
      processor.processEvent({ invalid: true } as unknown as CloudAgentEvent);

      expect(callbacks.onMessageUpdated).not.toHaveBeenCalled();
    });
  });
});
