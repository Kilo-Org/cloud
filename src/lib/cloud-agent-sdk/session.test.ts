/**
 * Integration test for the full event pipeline: normalize → chat-processor + service-state.
 *
 * Instead of testing through createCloudAgentSession (which requires a WebSocket),
 * we wire the same components directly — mirroring session.ts's event routing logic.
 */
import { createTestSession } from './test-helpers';
import {
  createEventHelpers,
  sessionInfo,
  userMsg,
  assistantMsg,
  textPart,
} from './__fixtures__/helpers';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('session pipeline integration', () => {
  const { createEvent, kilocode, resetCounter } = createEventHelpers();

  beforeEach(() => {
    resetCounter();
  });

  describe('full streaming lifecycle', () => {
    it('user message → assistant streaming → complete', () => {
      const { storage, serviceState, feedEvent } = createTestSession();

      // Session created
      feedEvent(kilocode('session.created', { info: sessionInfo('ses-1') }));

      // Session goes busy
      feedEvent(kilocode('session.status', { sessionID: 'ses-1', status: { type: 'busy' } }));
      expect(serviceState.getActivity()).toEqual({ type: 'busy' });

      // User message
      feedEvent(kilocode('message.updated', { info: userMsg('msg-1') }));
      expect(storage.getMessageIds()).toEqual(['msg-1']);

      // User message part
      feedEvent(kilocode('message.part.updated', { part: textPart('p-1', 'msg-1', 'hello') }));
      expect(storage.getParts('msg-1')).toHaveLength(1);

      // Assistant message
      feedEvent(kilocode('message.updated', { info: assistantMsg('msg-2', 'msg-1') }));
      expect(storage.getMessageIds()).toEqual(['msg-1', 'msg-2']);

      // Streaming part updates
      feedEvent(kilocode('message.part.updated', { part: textPart('p-2', 'msg-2', 'Hi') }));
      feedEvent(kilocode('message.part.updated', { part: textPart('p-2', 'msg-2', 'Hi there') }));

      // Check final text
      const parts = storage.getParts('msg-2');
      expect(parts).toHaveLength(1);
      expect(parts[0]).toEqual(expect.objectContaining({ text: 'Hi there' }));

      // Session goes idle — activity transitions to idle
      feedEvent(kilocode('session.status', { sessionID: 'ses-1', status: { type: 'idle' } }));
      expect(serviceState.getActivity()).toEqual({ type: 'idle' });

      // Complete after idle is a no-op for activity (already idle)
      feedEvent(createEvent('complete', { currentBranch: 'main' }));
      expect(serviceState.getActivity()).toEqual({ type: 'idle' });
    });
  });

  describe('streaming text deltas', () => {
    it('accumulates text from message.part.delta events', () => {
      const { storage, feedEvent } = createTestSession();

      feedEvent(kilocode('session.created', { info: sessionInfo('ses-1') }));
      feedEvent(kilocode('session.status', { sessionID: 'ses-1', status: { type: 'busy' } }));
      feedEvent(kilocode('message.updated', { info: assistantMsg('msg-1', 'p') }));

      // Streaming deltas (matching real traffic — message.part.delta events)
      feedEvent(
        kilocode('message.part.delta', {
          sessionID: 'ses-1',
          messageID: 'msg-1',
          partID: 'p-1',
          field: 'text',
          delta: 'Hello',
        })
      );
      feedEvent(
        kilocode('message.part.delta', {
          sessionID: 'ses-1',
          messageID: 'msg-1',
          partID: 'p-1',
          field: 'text',
          delta: ' world',
        })
      );

      // Deltas accumulated
      const parts = storage.getParts('msg-1');
      expect(parts).toHaveLength(1);
      expect(parts[0]).toEqual(expect.objectContaining({ text: 'Hello world' }));

      // Final full snapshot replaces accumulated text
      feedEvent(
        kilocode('message.part.updated', {
          part: textPart('p-1', 'msg-1', 'Hello world!'),
        })
      );

      const finalParts = storage.getParts('msg-1');
      expect(finalParts).toHaveLength(1);
      expect(finalParts[0]).toEqual(expect.objectContaining({ text: 'Hello world!' }));
    });
  });

  describe('child sessions', () => {
    it('stores child session messages alongside root messages', () => {
      const { storage, feedEvent } = createTestSession();

      feedEvent(kilocode('session.created', { info: sessionInfo('ses-1') }));
      feedEvent(
        kilocode('session.created', {
          info: sessionInfo('child-1', { parentID: 'ses-1' }),
        })
      );

      // Root message
      feedEvent(kilocode('message.updated', { info: userMsg('msg-1', 'ses-1') }));

      // Child message
      feedEvent(
        kilocode('message.updated', {
          info: assistantMsg('msg-2', 'msg-1', 'child-1'),
        })
      );

      expect(storage.getMessageIds()).toEqual(['msg-1', 'msg-2']);
    });

    it('child session busy does not change activity', () => {
      const { serviceState, feedEvent } = createTestSession();

      feedEvent(kilocode('session.created', { info: sessionInfo('ses-1') }));
      feedEvent(
        kilocode('session.created', {
          info: sessionInfo('child-1', { parentID: 'ses-1' }),
        })
      );

      feedEvent(kilocode('session.status', { sessionID: 'child-1', status: { type: 'busy' } }));
      // Activity stays at initial connecting state (child busy doesn't promote to busy)
      expect(serviceState.getActivity()).toEqual({ type: 'connecting' });
    });
  });

  describe('activity transitions', () => {
    it('interrupted stops activity', () => {
      const { serviceState, feedEvent } = createTestSession();

      feedEvent(kilocode('session.status', { sessionID: 'ses-1', status: { type: 'busy' } }));
      expect(serviceState.getActivity()).toEqual({ type: 'busy' });

      feedEvent(createEvent('interrupted', {}));
      expect(serviceState.getActivity()).toEqual({ type: 'idle' });
      expect(serviceState.getStatus()).toEqual({ type: 'interrupted' });
    });

    it('fatal error stops activity', () => {
      const { serviceState, feedEvent } = createTestSession();

      feedEvent(kilocode('session.status', { sessionID: 'ses-1', status: { type: 'busy' } }));
      feedEvent(createEvent('error', { fatal: true }));
      expect(serviceState.getActivity()).toEqual({ type: 'idle' });
      expect(serviceState.getStatus()).toEqual({ type: 'error', message: 'Session terminated' });
    });

    it('non-fatal error (warning) does not stop activity', () => {
      const { serviceState, feedEvent } = createTestSession();

      feedEvent(kilocode('session.status', { sessionID: 'ses-1', status: { type: 'busy' } }));
      feedEvent(createEvent('error', { fatal: false }));
      expect(serviceState.getActivity()).toEqual({ type: 'busy' });
    });

    it('complete after idle keeps activity idle', () => {
      const { serviceState, feedEvent } = createTestSession();

      feedEvent(kilocode('session.status', { sessionID: 'ses-1', status: { type: 'busy' } }));
      feedEvent(kilocode('session.status', { sessionID: 'ses-1', status: { type: 'idle' } }));
      // Idle status transitions activity to idle
      expect(serviceState.getActivity()).toEqual({ type: 'idle' });

      // Complete is redundant but harmless
      feedEvent(createEvent('complete', {}));
      expect(serviceState.getActivity()).toEqual({ type: 'idle' });
    });

    it('wrapper_disconnected stops activity', () => {
      const { serviceState, feedEvent } = createTestSession();

      feedEvent(kilocode('session.status', { sessionID: 'ses-1', status: { type: 'busy' } }));
      feedEvent(createEvent('wrapper_disconnected', {}));
      expect(serviceState.getActivity()).toEqual({ type: 'idle' });
      expect(serviceState.getStatus()).toEqual({ type: 'disconnected' });
    });
  });

  describe('autocommit lifecycle', () => {
    it('tracks autocommit started and completed', () => {
      const { serviceState, feedEvent } = createTestSession();

      feedEvent(
        kilocode('message.updated', {
          info: assistantMsg('msg-1', 'p', 'ses-1', { time: { created: 1, completed: 2 } }),
        })
      );

      // Autocommit started
      feedEvent(
        createEvent('autocommit_started', { messageId: 'msg-1', message: 'Committing...' })
      );
      expect(serviceState.getStatus()).toEqual({
        type: 'autocommit',
        step: 'started',
        message: 'Committing...',
      });

      // Autocommit completed
      feedEvent(
        createEvent('autocommit_completed', {
          messageId: 'msg-1',
          success: true,
          commitHash: 'abc123',
          commitMessage: 'fix: bug',
        })
      );
      expect(serviceState.getStatus()).toEqual({
        type: 'autocommit',
        step: 'completed',
        message: 'abc123 fix: bug',
      });
    });

    it('skipped autocommit does not change status', () => {
      const { serviceState, feedEvent } = createTestSession();

      const statusBefore = serviceState.getStatus();
      feedEvent(
        createEvent('autocommit_completed', {
          messageId: 'msg-1',
          success: true,
          skipped: true,
        })
      );
      expect(serviceState.getStatus()).toEqual(statusBefore);
    });

    it('failed autocommit sets status to failed', () => {
      const { serviceState, feedEvent } = createTestSession();

      feedEvent(
        kilocode('message.updated', {
          info: assistantMsg('msg-1', 'p'),
        })
      );

      feedEvent(createEvent('autocommit_started', { messageId: 'msg-1' }));
      feedEvent(
        createEvent('autocommit_completed', {
          messageId: 'msg-1',
          success: false,
          message: 'Merge conflict',
        })
      );

      expect(serviceState.getStatus()).toEqual({
        type: 'autocommit',
        step: 'failed',
        message: 'Merge conflict',
      });
    });
  });

  describe('part removal', () => {
    it('message.part.removed deletes the part', () => {
      const { storage, feedEvent } = createTestSession();

      feedEvent(kilocode('message.part.updated', { part: textPart('p-1', 'msg-1', 'hello') }));
      expect(storage.getParts('msg-1')).toHaveLength(1);

      feedEvent(
        kilocode('message.part.removed', {
          sessionID: 'ses-1',
          messageID: 'msg-1',
          partID: 'p-1',
        })
      );
      expect(storage.getParts('msg-1')).toHaveLength(0);
    });

    it('removing a nonexistent part is a no-op', () => {
      const { storage, feedEvent } = createTestSession();

      feedEvent(kilocode('message.part.updated', { part: textPart('p-1', 'msg-1', 'hello') }));

      feedEvent(
        kilocode('message.part.removed', {
          sessionID: 'ses-1',
          messageID: 'msg-1',
          partID: 'p-nonexistent',
        })
      );
      // Original part still present
      expect(storage.getParts('msg-1')).toHaveLength(1);
    });
  });

  describe('part upsert', () => {
    it('repeated updates replace previous part', () => {
      const { storage, feedEvent } = createTestSession();

      feedEvent(kilocode('message.part.updated', { part: textPart('p-1', 'msg-1', 'first') }));
      feedEvent(kilocode('message.part.updated', { part: textPart('p-1', 'msg-1', 'second') }));

      const parts = storage.getParts('msg-1');
      expect(parts).toHaveLength(1);
      expect(parts[0]).toEqual(expect.objectContaining({ text: 'second' }));
    });
  });

  describe('message ordering', () => {
    it('messages are sorted by ID', () => {
      const { storage, feedEvent } = createTestSession();

      // Insert out of order
      feedEvent(kilocode('message.updated', { info: userMsg('msg-3') }));
      feedEvent(kilocode('message.updated', { info: userMsg('msg-1') }));
      feedEvent(kilocode('message.updated', { info: userMsg('msg-2') }));

      expect(storage.getMessageIds()).toEqual(['msg-1', 'msg-2', 'msg-3']);
    });

    it('duplicate message upsert does not duplicate ID', () => {
      const { storage, feedEvent } = createTestSession();

      feedEvent(kilocode('message.updated', { info: userMsg('msg-1') }));
      feedEvent(kilocode('message.updated', { info: userMsg('msg-1') }));

      expect(storage.getMessageIds()).toEqual(['msg-1']);
    });
  });

  describe('unknown events', () => {
    it('unrecognized event types are silently ignored', () => {
      const { storage, feedEvent } = createTestSession();

      feedEvent(createEvent('some_future_event', { foo: 'bar' }));
      expect(storage.getMessageIds()).toEqual([]);
    });
  });
});
