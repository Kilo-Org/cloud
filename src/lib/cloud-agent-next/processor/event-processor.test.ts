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

    it('should update session status to idle and set streaming false', () => {
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

      // Then set to idle
      processor.processEvent(
        createKilocodeEvent('session.status', {
          sessionID: 'session-123',
          status: { type: 'idle' },
        })
      );

      expect(callbacks.onSessionStatusChanged).toHaveBeenLastCalledWith({ type: 'idle' });
      expect(callbacks.onStreamingChanged).toHaveBeenLastCalledWith(false);
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
