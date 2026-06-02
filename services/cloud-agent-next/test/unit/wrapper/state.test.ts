/**
 * Unit tests for WrapperState class.
 *
 * Tests state transitions, invariants, and edge cases for the wrapper's
 * centralized state management.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { WrapperState, type SessionContext } from '../../../wrapper/src/state.js';
import type { IngestEvent } from '../../../src/shared/protocol.js';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

const createSessionContext = (overrides: Partial<SessionContext> = {}): SessionContext => ({
  kiloSessionId: 'kilo_sess_456',
  ingestUrl: 'wss://ingest.example.com',
  ingestToken: 'token_secret',
  workerAuthToken: 'kilo_token_789',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WrapperState', () => {
  let state: WrapperState;

  beforeEach(() => {
    state = new WrapperState();
  });

  // -------------------------------------------------------------------------
  // Initial State
  // -------------------------------------------------------------------------

  describe('initial state', () => {
    it('starts in idle state', () => {
      expect(state.isIdle).toBe(true);
      expect(state.isActive).toBe(false);
    });

    it('has no session context', () => {
      expect(state.hasSession).toBe(false);
      expect(state.currentSession).toBeNull();
    });

    it('is not active', () => {
      expect(state.isActive).toBe(false);
    });

    it('is not connected', () => {
      expect(state.isConnected).toBe(false);
    });

    it('has no last error', () => {
      expect(state.getLastError()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // setActive
  // -------------------------------------------------------------------------

  describe('setActive', () => {
    it('transitions state to active', () => {
      expect(state.isIdle).toBe(true);
      state.setActive(true);
      expect(state.isActive).toBe(true);
      expect(state.isIdle).toBe(false);
    });

    it('transitions state back to idle', () => {
      state.setActive(true);
      state.setActive(false);
      expect(state.isIdle).toBe(true);
      expect(state.isActive).toBe(false);
    });

    it('updates activity timestamp when activating', () => {
      const before = Date.now();
      state.setActive(true);
      const after = Date.now();
      const idleMs = state.getIdleMs(after);
      expect(idleMs).toBeLessThanOrEqual(after - before + 1);
    });

    it('is idempotent for same value', () => {
      state.setActive(true);
      state.setActive(true);
      expect(state.isActive).toBe(true);

      state.setActive(false);
      state.setActive(false);
      expect(state.isIdle).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Activity Tracking
  // -------------------------------------------------------------------------

  describe('activity tracking', () => {
    it('updateActivity updates timestamp', () => {
      const before = Date.now();
      state.updateActivity();
      const after = Date.now();

      const idleMs = state.getIdleMs(after);
      expect(idleMs).toBeLessThanOrEqual(after - before + 1);
    });

    it('getIdleMs returns time since last activity', async () => {
      state.updateActivity();
      const activityTime = Date.now();

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 50));

      const now = Date.now();
      const idleMs = state.getIdleMs(now);

      // Should be at least 50ms but not much more
      expect(idleMs).toBeGreaterThanOrEqual(now - activityTime - 5);
      expect(idleMs).toBeLessThan(200);
    });
  });

  // -------------------------------------------------------------------------
  // Error Tracking
  // -------------------------------------------------------------------------

  describe('error tracking', () => {
    it('setLastError stores error', () => {
      const error = {
        code: 'TEST_ERROR',
        message: 'Something went wrong',
        timestamp: Date.now(),
      };

      state.setLastError(error);

      expect(state.getLastError()).toEqual(error);
    });

    it('setLastError with messageId', () => {
      const error = {
        code: 'INFLIGHT_TIMEOUT',
        messageId: 'msg_123',
        message: 'Timeout',
        timestamp: Date.now(),
      };

      state.setLastError(error);

      expect(state.getLastError()).toEqual(error);
    });

    it('clearLastError removes error', () => {
      state.setLastError({
        code: 'TEST_ERROR',
        message: 'Error',
        timestamp: Date.now(),
      });

      state.clearLastError();

      expect(state.getLastError()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Connection Management
  // -------------------------------------------------------------------------

  describe('connection management', () => {
    it('isConnected returns false with no WebSocket', () => {
      expect(state.isConnected).toBe(false);
    });

    it('setConnections stores WebSocket and AbortController', () => {
      const mockWs = { readyState: WebSocket.OPEN, close: vi.fn() } as unknown as WebSocket;
      const mockAbort = new AbortController();

      state.setConnections(mockWs, mockAbort);

      expect(state.ingestWs).toBe(mockWs);
      expect(state.sseAbortController).toBe(mockAbort);
    });

    it('isConnected returns true when WebSocket is OPEN', () => {
      const mockWs = { readyState: WebSocket.OPEN, close: vi.fn() } as unknown as WebSocket;
      state.setConnections(mockWs, new AbortController());

      expect(state.isConnected).toBe(true);
    });

    it('isConnected returns false when WebSocket is not OPEN', () => {
      const mockWs = { readyState: WebSocket.CLOSED, close: vi.fn() } as unknown as WebSocket;
      state.setConnections(mockWs, new AbortController());

      expect(state.isConnected).toBe(false);
    });

    it('clearConnectionRefs nulls references without closing or aborting', () => {
      const mockClose = vi.fn();
      const mockWs = { readyState: WebSocket.OPEN, close: mockClose } as unknown as WebSocket;
      const mockAbort = new AbortController();
      const abortSpy = vi.spyOn(mockAbort, 'abort');

      state.setConnections(mockWs, mockAbort);
      state.clearConnectionRefs();

      // Refs are nulled
      expect(state.ingestWs).toBeNull();
      expect(state.sseAbortController).toBeNull();

      // clearConnectionRefs is purely passive — close/abort owned by connection.ts
      expect(mockClose).not.toHaveBeenCalled();
      expect(abortSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Send to Ingest
  // -------------------------------------------------------------------------

  describe('sendToIngest', () => {
    it('does nothing when no send function set', () => {
      const event: IngestEvent = {
        streamEventType: 'status',
        data: { message: 'test' },
        timestamp: new Date().toISOString(),
      };

      // Should not throw
      expect(() => state.sendToIngest(event)).not.toThrow();
    });

    it('calls send function when set', () => {
      const mockSend = vi.fn();
      state.setSendToIngestFn(mockSend);

      const event: IngestEvent = {
        streamEventType: 'status',
        data: { message: 'test' },
        timestamp: new Date().toISOString(),
      };

      state.sendToIngest(event);

      expect(mockSend).toHaveBeenCalledWith(event);
    });

    it('setSendToIngestFn can clear function', () => {
      const mockSend = vi.fn();
      state.setSendToIngestFn(mockSend);
      state.setSendToIngestFn(null);

      const event: IngestEvent = {
        streamEventType: 'status',
        data: {},
        timestamp: new Date().toISOString(),
      };

      state.sendToIngest(event);

      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Status API
  // -------------------------------------------------------------------------

  describe('getStatus', () => {
    it('returns idle state with no session', () => {
      const status = state.getStatus();

      expect(status).toEqual({
        state: 'idle',
        sessionId: undefined,
        pendingMessages: [],
        lastError: undefined,
      });
    });

    it('returns idle state with session but no inflight', () => {
      state.bindSession(
        createSessionContext({
          kiloSessionId: 'kilo_456',
        })
      );

      const status = state.getStatus();

      expect(status).toEqual({
        state: 'idle',
        sessionId: 'kilo_456',
        pendingMessages: [],
        lastError: undefined,
      });
    });

    it('returns active state when active', () => {
      state.setActive(true);
      state.bindSession(
        createSessionContext({
          kiloSessionId: 'kilo_456',
        })
      );
      const status = state.getStatus();
      expect(status).toEqual({
        state: 'active',
        sessionId: 'kilo_456',
        pendingMessages: [],
        lastError: undefined,
      });
    });

    it('includes lastError when present', () => {
      state.bindSession(createSessionContext());
      const error = {
        code: 'INFLIGHT_TIMEOUT',
        messageId: 'msg_123',
        message: 'Timeout',
        timestamp: Date.now(),
      };
      state.setLastError(error);

      const status = state.getStatus();

      expect(status.lastError).toEqual(error);
    });

    it('includes pendingMessages from message tracking', () => {
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });

      const status = state.getStatus();

      expect(status.pendingMessages).toEqual(['msg_1']);
      expect(status.state).toBe('active');
    });

    it('uses sessionId from session', () => {
      state.bindSession(createSessionContext({ kiloSessionId: 'session_id' }));

      const status = state.getStatus();

      expect(status.sessionId).toBe('session_id');
    });
  });

  // -------------------------------------------------------------------------
  // Session Context
  // -------------------------------------------------------------------------

  describe('session context', () => {
    describe('bindSession', () => {
      it('stores context on first bind', () => {
        const context = createSessionContext();
        state.bindSession(context);

        expect(state.hasSession).toBe(true);
        expect(state.currentSession).toEqual(context);
      });

      it('returns { changed: true } on first bind', () => {
        const result = state.bindSession(createSessionContext());
        expect(result).toEqual({ changed: true });
      });

      it('clears previous error on first bind', () => {
        state.setLastError({
          code: 'TEST_ERROR',
          message: 'previous error',
          timestamp: Date.now(),
        });

        state.bindSession(createSessionContext());

        expect(state.getLastError()).toBeNull();
      });

      it('returns { changed: false } when same context', () => {
        state.bindSession(createSessionContext());
        const result = state.bindSession(createSessionContext());
        expect(result).toEqual({ changed: false });
      });

      it('returns { changed: true } when connection fields change', () => {
        state.bindSession(createSessionContext());
        const result = state.bindSession(
          createSessionContext({ ingestUrl: 'wss://new-ingest.example.com' })
        );
        expect(result).toEqual({ changed: true });
      });

      it('returns { changed: true } when wrapperGeneration changes', () => {
        state.bindSession(createSessionContext());
        const result = state.bindSession(createSessionContext({ wrapperGeneration: 2 }));
        expect(result).toEqual({ changed: true });
      });

      it('returns { changed: true } when wrapperConnectionId changes', () => {
        state.bindSession(createSessionContext());
        const result = state.bindSession(createSessionContext({ wrapperConnectionId: 'conn_new' }));
        expect(result).toEqual({ changed: true });
      });

      it('returns { changed: true } when ingestToken changes', () => {
        state.bindSession(createSessionContext());
        const result = state.bindSession(createSessionContext({ ingestToken: 'new_token' }));
        expect(result).toEqual({ changed: true });
      });

      it('returns { changed: true } when workerAuthToken changes', () => {
        state.bindSession(createSessionContext());
        const result = state.bindSession(
          createSessionContext({ workerAuthToken: 'new_auth_token' })
        );
        expect(result).toEqual({ changed: true });
      });
    });

    describe('clearSession', () => {
      it('clears session context', () => {
        state.bindSession(createSessionContext());
        state.clearSession();

        expect(state.hasSession).toBe(false);
        expect(state.currentSession).toBeNull();
      });

      it('clears all messages', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });
        state.clearSession();

        expect(state.hasPendingMessages).toBe(false);
        expect(state.pendingMessageIds).toEqual([]);
      });

      it('clears active message', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });
        state.clearSession();

        expect(state.activeMessageId).toBeNull();
      });

      it('sets state to idle', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });
        expect(state.isActive).toBe(true);

        state.clearSession();

        expect(state.isActive).toBe(false);
        expect(state.isIdle).toBe(true);
      });

      it('clears last assistant message id', () => {
        state.bindSession(createSessionContext());
        state.setLastAssistantMessageId('assistant_msg_1');

        state.clearSession();

        expect(state.lastAssistantMessageId).toBeNull();
      });
    });

    describe('hasSession / currentSession', () => {
      it('hasSession is false initially', () => {
        expect(state.hasSession).toBe(false);
      });

      it('currentSession is null initially', () => {
        expect(state.currentSession).toBeNull();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Message Tracking
  // -------------------------------------------------------------------------

  describe('message tracking', () => {
    describe('acceptMessage', () => {
      it('adds message in active state when no active message', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });

        expect(state.activeMessageId).toBe('msg_1');
        expect(state.isActive).toBe(true);
      });

      it('adds message in accepted state when active message exists', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });
        state.acceptMessage('msg_2', { autoCommit: false, condenseOnComplete: false });

        expect(state.activeMessageId).toBe('msg_1');
        expect(state.pendingMessageIds).toEqual(['msg_1', 'msg_2']);
      });

      it('stores config per message', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', {
          autoCommit: true,
          condenseOnComplete: true,
          model: 'claude-3',
          upstreamBranch: 'main',
          commitCoAuthor: { name: 'kiloconnect[bot]', email: 'bot@example.com' },
        });

        const config = state.activeMessageConfig;
        expect(config).toEqual({
          autoCommit: true,
          condenseOnComplete: true,
          model: 'claude-3',
          upstreamBranch: 'main',
          commitCoAuthor: { name: 'kiloconnect[bot]', email: 'bot@example.com' },
        });
      });

      it('makes wrapper active when first message is accepted', () => {
        state.bindSession(createSessionContext());
        expect(state.isActive).toBe(false);

        state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });

        expect(state.isActive).toBe(true);
        expect(state.isIdle).toBe(false);
      });
    });

    describe('completeActiveMessage', () => {
      it('returns null when no active message', () => {
        expect(state.completeActiveMessage()).toBeNull();
      });

      it('returns completed messageId', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });

        const completed = state.completeActiveMessage();

        expect(completed?.messageId).toBe('msg_1');
      });

      it('transitions next accepted message to active', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });
        state.acceptMessage('msg_2', { autoCommit: false, condenseOnComplete: false });

        state.completeActiveMessage();

        expect(state.activeMessageId).toBe('msg_2');
        expect(state.isActive).toBe(true);
      });

      it('sets idle when no more accepted messages', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });

        state.completeActiveMessage();

        expect(state.activeMessageId).toBeNull();
        expect(state.isActive).toBe(false);
        expect(state.isIdle).toBe(true);
      });

      it('completes messages in FIFO order', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });
        state.acceptMessage('msg_2', { autoCommit: false, condenseOnComplete: false });
        state.acceptMessage('msg_3', { autoCommit: false, condenseOnComplete: false });

        expect(state.completeActiveMessage()?.messageId).toBe('msg_1');
        expect(state.activeMessageId).toBe('msg_2');

        expect(state.completeActiveMessage()?.messageId).toBe('msg_2');
        expect(state.activeMessageId).toBe('msg_3');

        expect(state.completeActiveMessage()?.messageId).toBe('msg_3');
        expect(state.activeMessageId).toBeNull();
        expect(state.isActive).toBe(false);
      });
    });

    describe('activeMessageId', () => {
      it('returns null initially', () => {
        expect(state.activeMessageId).toBeNull();
      });

      it('returns the currently active messageId', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });

        expect(state.activeMessageId).toBe('msg_1');
      });
    });

    describe('hasPendingMessages', () => {
      it('returns false initially', () => {
        expect(state.hasPendingMessages).toBe(false);
      });

      it('returns true when messages are pending', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });

        expect(state.hasPendingMessages).toBe(true);
      });

      it('returns false when all messages are completed', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });
        state.completeActiveMessage();

        expect(state.hasPendingMessages).toBe(false);
      });
    });

    describe('pendingMessageIds', () => {
      it('returns empty array initially', () => {
        expect(state.pendingMessageIds).toEqual([]);
      });

      it('returns all non-completed message IDs', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });
        state.acceptMessage('msg_2', { autoCommit: false, condenseOnComplete: false });

        expect(state.pendingMessageIds).toEqual(['msg_1', 'msg_2']);
      });

      it('excludes completed messages', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });
        state.acceptMessage('msg_2', { autoCommit: false, condenseOnComplete: false });

        state.completeActiveMessage();

        expect(state.pendingMessageIds).toEqual(['msg_2']);
      });
    });

    describe('activeMessageConfig', () => {
      it('returns null when no active message', () => {
        expect(state.activeMessageConfig).toBeNull();
      });

      it('returns config for the active message', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', {
          autoCommit: true,
          condenseOnComplete: false,
          model: 'gpt-4',
        });

        expect(state.activeMessageConfig).toEqual({
          autoCommit: true,
          condenseOnComplete: false,
          model: 'gpt-4',
          upstreamBranch: undefined,
        });
      });

      it('returns null when active message is completed', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });
        state.completeActiveMessage();

        expect(state.activeMessageConfig).toBeNull();
      });
    });

    describe('updateMessageConfig', () => {
      it('updates config for an existing message', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', {
          autoCommit: false,
          condenseOnComplete: false,
        });

        state.updateMessageConfig('msg_1', { autoCommit: true });

        expect(state.activeMessageConfig?.autoCommit).toBe(true);
      });

      it('does nothing for unknown message', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });

        state.updateMessageConfig('msg_unknown', { autoCommit: true });

        expect(state.activeMessageConfig?.autoCommit).toBe(false);
      });

      it('updates model and upstreamBranch', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', {
          autoCommit: false,
          condenseOnComplete: false,
        });

        state.updateMessageConfig('msg_1', {
          model: 'claude-3',
          upstreamBranch: 'develop',
        });

        expect(state.activeMessageConfig?.model).toBe('claude-3');
        expect(state.activeMessageConfig?.upstreamBranch).toBe('develop');
      });
    });

    describe('removeMessage', () => {
      it('removes a message from tracking', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });
        state.acceptMessage('msg_2', { autoCommit: false, condenseOnComplete: false });

        state.removeMessage('msg_2');

        expect(state.pendingMessageIds).toEqual(['msg_1']);
      });

      it('clears active state when removing active message', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });

        state.removeMessage('msg_1');

        expect(state.activeMessageId).toBeNull();
        expect(state.isActive).toBe(false);
      });

      it('does not affect other messages when removing non-active', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });
        state.acceptMessage('msg_2', { autoCommit: false, condenseOnComplete: false });

        state.removeMessage('msg_2');

        expect(state.activeMessageId).toBe('msg_1');
        expect(state.isActive).toBe(true);
      });

      it('promotes next accepted message when removing the active message', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_a', { autoCommit: false, condenseOnComplete: false });
        state.acceptMessage('msg_b', { autoCommit: false, condenseOnComplete: false });
        state.acceptMessage('msg_c', { autoCommit: false, condenseOnComplete: false });

        state.removeMessage('msg_a');

        expect(state.activeMessageId).toBe('msg_b');
        expect(state.isActive).toBe(true);
        expect(state.pendingMessageIds).toEqual(['msg_b', 'msg_c']);
      });

      it('sets idle when removing the active message with no more accepted messages', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_a', { autoCommit: false, condenseOnComplete: false });

        state.removeMessage('msg_a');

        expect(state.activeMessageId).toBeNull();
        expect(state.isIdle).toBe(true);
        expect(state.hasPendingMessages).toBe(false);
      });
    });

    describe('clearAllMessages', () => {
      it('clears all messages', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });
        state.acceptMessage('msg_2', { autoCommit: false, condenseOnComplete: false });

        state.clearAllMessages();

        expect(state.hasPendingMessages).toBe(false);
        expect(state.pendingMessageIds).toEqual([]);
      });

      it('clears active message', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });

        state.clearAllMessages();

        expect(state.activeMessageId).toBeNull();
      });

      it('sets state to idle', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });

        state.clearAllMessages();

        expect(state.isActive).toBe(false);
        expect(state.isIdle).toBe(true);
      });

      it('does not clear session context', () => {
        state.bindSession(createSessionContext());
        state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });

        state.clearAllMessages();

        expect(state.hasSession).toBe(true);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Multi-message Flow Tests
  // -------------------------------------------------------------------------

  describe('multi-message flow', () => {
    it('accept A → A is active', () => {
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_a', { autoCommit: false, condenseOnComplete: false });

      expect(state.activeMessageId).toBe('msg_a');
      expect(state.isActive).toBe(true);
      expect(state.pendingMessageIds).toEqual(['msg_a']);
    });

    it('accept B → B is accepted, A still active', () => {
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_a', { autoCommit: false, condenseOnComplete: false });
      state.acceptMessage('msg_b', { autoCommit: false, condenseOnComplete: false });

      expect(state.activeMessageId).toBe('msg_a');
      expect(state.pendingMessageIds).toEqual(['msg_a', 'msg_b']);
    });

    it('complete A → B becomes active, not idle', () => {
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_a', { autoCommit: false, condenseOnComplete: false });
      state.acceptMessage('msg_b', { autoCommit: false, condenseOnComplete: false });

      const completed = state.completeActiveMessage();

      expect(completed?.messageId).toBe('msg_a');
      expect(state.activeMessageId).toBe('msg_b');
      expect(state.isActive).toBe(true);
      expect(state.isIdle).toBe(false);
    });

    it('complete B → idle', () => {
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_a', { autoCommit: false, condenseOnComplete: false });
      state.acceptMessage('msg_b', { autoCommit: false, condenseOnComplete: false });

      state.completeActiveMessage();
      const completed = state.completeActiveMessage();

      expect(completed?.messageId).toBe('msg_b');
      expect(state.activeMessageId).toBeNull();
      expect(state.isActive).toBe(false);
      expect(state.isIdle).toBe(true);
      expect(state.hasPendingMessages).toBe(false);
    });

    it('finalization config is per-message', () => {
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_a', {
        autoCommit: true,
        condenseOnComplete: false,
        model: 'claude-3',
      });
      state.acceptMessage('msg_b', {
        autoCommit: false,
        condenseOnComplete: true,
        model: 'gpt-4',
      });

      expect(state.activeMessageConfig).toEqual({
        autoCommit: true,
        condenseOnComplete: false,
        model: 'claude-3',
        upstreamBranch: undefined,
      });

      state.completeActiveMessage();

      expect(state.activeMessageConfig).toEqual({
        autoCommit: false,
        condenseOnComplete: true,
        model: 'gpt-4',
        upstreamBranch: undefined,
      });
    });

    it('abort (clearAllMessages) clears all messages mid-flow', () => {
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_a', { autoCommit: false, condenseOnComplete: false });
      state.acceptMessage('msg_b', { autoCommit: false, condenseOnComplete: false });
      expect(state.isActive).toBe(true);

      state.clearAllMessages();

      expect(state.activeMessageId).toBeNull();
      expect(state.hasPendingMessages).toBe(false);
      expect(state.pendingMessageIds).toEqual([]);
      expect(state.isActive).toBe(false);
      expect(state.isIdle).toBe(true);
      expect(state.hasSession).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // completeMessage (message-ID-gated completion)
  // -------------------------------------------------------------------------

  describe('completeMessage', () => {
    it('returns null for unknown message ID without changing state', () => {
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_a', { autoCommit: false, condenseOnComplete: false });

      const result = state.completeMessage('msg_unknown');

      expect(result).toBeNull();
      expect(state.activeMessageId).toBe('msg_a');
      expect(state.isActive).toBe(true);
    });

    it('returns null for already-completed message and does not affect the active message', () => {
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_a', { autoCommit: false, condenseOnComplete: false });
      state.acceptMessage('msg_b', { autoCommit: false, condenseOnComplete: false });

      const first = state.completeMessage('msg_a');
      expect(first?.messageId).toBe('msg_a');

      const duplicate = state.completeMessage('msg_a');
      expect(duplicate).toBeNull();
      expect(state.activeMessageId).toBe('msg_b');
      expect(state.isActive).toBe(true);
    });

    it('returns null for accepted-but-not-active message', () => {
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_a', { autoCommit: false, condenseOnComplete: false });
      state.acceptMessage('msg_b', { autoCommit: false, condenseOnComplete: false });

      const result = state.completeMessage('msg_b');

      expect(result).toBeNull();
      expect(state.activeMessageId).toBe('msg_a');
      expect(state.pendingMessageIds).toEqual(['msg_a', 'msg_b']);
    });

    it('completes the active message when messageId matches and promotes next accepted', () => {
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_a', { autoCommit: false, condenseOnComplete: false });
      state.acceptMessage('msg_b', { autoCommit: false, condenseOnComplete: false });

      const completed = state.completeMessage('msg_a');

      expect(completed?.messageId).toBe('msg_a');
      expect(completed?.state).toBe('completed');
      expect(state.activeMessageId).toBe('msg_b');
      expect(state.isActive).toBe(true);
    });

    it('sets idle when completing the last active message', () => {
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_a', { autoCommit: false, condenseOnComplete: false });

      const completed = state.completeMessage('msg_a');

      expect(completed?.messageId).toBe('msg_a');
      expect(state.activeMessageId).toBeNull();
      expect(state.isIdle).toBe(true);
    });

    it('completes messages in FIFO order via ID gating', () => {
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_a', { autoCommit: false, condenseOnComplete: false });
      state.acceptMessage('msg_b', { autoCommit: false, condenseOnComplete: false });
      state.acceptMessage('msg_c', { autoCommit: false, condenseOnComplete: false });

      expect(state.completeMessage('msg_a')?.messageId).toBe('msg_a');
      expect(state.activeMessageId).toBe('msg_b');

      expect(state.completeMessage('msg_b')?.messageId).toBe('msg_b');
      expect(state.activeMessageId).toBe('msg_c');

      expect(state.completeMessage('msg_c')?.messageId).toBe('msg_c');
      expect(state.activeMessageId).toBeNull();
      expect(state.isActive).toBe(false);
    });

    it('returns null when no messages are tracked', () => {
      expect(state.completeMessage('msg_anything')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Edge Cases and Invariants
  // -------------------------------------------------------------------------

  describe('edge cases and invariants', () => {
    it('state is IDLE when not active and ACTIVE when active', () => {
      expect(state.isIdle).toBe(true);
      expect(state.isActive).toBe(false);

      state.setActive(true);
      expect(state.isIdle).toBe(false);
      expect(state.isActive).toBe(true);

      state.setActive(false);
      expect(state.isIdle).toBe(true);
      expect(state.isActive).toBe(false);
    });
  });
});
