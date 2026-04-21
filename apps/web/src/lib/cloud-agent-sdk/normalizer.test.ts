import { normalize, normalizeCliEvent, isChatEvent } from './normalizer';
import type { CloudAgentEvent } from '@/lib/cloud-agent-next/event-types';

function createRaw(streamEventType: string, data: unknown, sessionId = 'ses-1'): CloudAgentEvent {
  return {
    eventId: 1,
    executionId: 'exec-1',
    sessionId,
    streamEventType,
    timestamp: new Date().toISOString(),
    data,
  };
}

function createKilocode(type: string, properties: unknown, sessionId = 'ses-1'): CloudAgentEvent {
  return createRaw('kilocode', { type, properties }, sessionId);
}

describe('normalize', () => {
  describe('envelope unwrapping', () => {
    it('unwraps kilocode-wrapped events', () => {
      const raw = createKilocode('session.idle', { sessionID: 'sid-1' });
      expect(normalize(raw)).toEqual({
        type: 'session.idle',
        sessionId: 'sid-1',
      });
    });

    it('handles direct (non-kilocode) events', () => {
      const raw = createRaw('session.idle', { sessionID: 'sid-1' });
      expect(normalize(raw)).toEqual({
        type: 'session.idle',
        sessionId: 'sid-1',
      });
    });

    it('returns null for invalid events missing required fields', () => {
      const invalid = {
        streamEventType: 'session.idle',
        data: {},
      } as unknown as CloudAgentEvent;
      expect(normalize(invalid)).toBeNull();
    });
  });

  describe('message.updated', () => {
    it('normalizes valid message.updated with full info', () => {
      const info = {
        id: 'msg-1',
        sessionID: 'ses-1',
        role: 'assistant',
        parts: [],
      };
      const result = normalize(createRaw('message.updated', { info }));
      expect(result).toEqual({ type: 'message.updated', info });
    });

    it('returns null when info is missing', () => {
      expect(normalize(createRaw('message.updated', {}))).toBeNull();
    });

    it('returns null when info.id is missing', () => {
      expect(normalize(createRaw('message.updated', { info: { sessionID: 'ses-1' } }))).toBeNull();
    });

    it('returns null when info.sessionID is missing', () => {
      expect(normalize(createRaw('message.updated', { info: { id: 'msg-1' } }))).toBeNull();
    });

    it('returns null when info.id is not a string', () => {
      expect(
        normalize(
          createRaw('message.updated', {
            info: { id: 123, sessionID: 'ses-1' },
          })
        )
      ).toBeNull();
    });

    it('returns null when info.sessionID is not a string', () => {
      expect(
        normalize(
          createRaw('message.updated', {
            info: { id: 'msg-1', sessionID: 123 },
          })
        )
      ).toBeNull();
    });
  });

  describe('message.part.updated', () => {
    it('normalizes valid part update', () => {
      const part = {
        id: 'p-1',
        sessionID: 'ses-1',
        messageID: 'msg-1',
        type: 'text',
      };
      const result = normalize(createRaw('message.part.updated', { part }));
      expect(result).toEqual({
        type: 'message.part.updated',
        part,
      });
    });

    it('returns null when part is missing', () => {
      expect(normalize(createRaw('message.part.updated', {}))).toBeNull();
    });

    it('returns null when part.id is missing', () => {
      const part = { sessionID: 'ses-1', messageID: 'msg-1' };
      expect(normalize(createRaw('message.part.updated', { part }))).toBeNull();
    });

    it('returns null when part.sessionID is missing', () => {
      const part = { id: 'p-1', messageID: 'msg-1' };
      expect(normalize(createRaw('message.part.updated', { part }))).toBeNull();
    });

    it('returns null when part.messageID is missing', () => {
      const part = { id: 'p-1', sessionID: 'ses-1' };
      expect(normalize(createRaw('message.part.updated', { part }))).toBeNull();
    });

    it('returns null when part.id is not a string', () => {
      const part = { id: 1, sessionID: 'ses-1', messageID: 'msg-1' };
      expect(normalize(createRaw('message.part.updated', { part }))).toBeNull();
    });

    it('returns null when part.sessionID is not a string', () => {
      const part = { id: 'p-1', sessionID: 1, messageID: 'msg-1' };
      expect(normalize(createRaw('message.part.updated', { part }))).toBeNull();
    });

    it('returns null when part.messageID is not a string', () => {
      const part = { id: 'p-1', sessionID: 'ses-1', messageID: 1 };
      expect(normalize(createRaw('message.part.updated', { part }))).toBeNull();
    });
  });

  describe('message.part.delta', () => {
    it('normalizes valid delta with field name mapping', () => {
      const data = {
        sessionID: 'ses-1',
        messageID: 'msg-1',
        partID: 'p-1',
        field: 'text',
        delta: 'hello ',
      };
      const result = normalize(createKilocode('message.part.delta', data));
      expect(result).toEqual({
        type: 'message.part.delta',
        sessionId: 'ses-1',
        messageId: 'msg-1',
        partId: 'p-1',
        field: 'text',
        delta: 'hello ',
      });
    });

    it('normalizes direct (non-kilocode) delta event', () => {
      const data = {
        sessionID: 'ses-1',
        messageID: 'msg-1',
        partID: 'p-1',
        field: 'text',
        delta: 'world',
      };
      const result = normalize(createRaw('message.part.delta', data));
      expect(result).toEqual({
        type: 'message.part.delta',
        sessionId: 'ses-1',
        messageId: 'msg-1',
        partId: 'p-1',
        field: 'text',
        delta: 'world',
      });
    });

    it('returns null when sessionID is missing', () => {
      const data = {
        messageID: 'msg-1',
        partID: 'p-1',
        field: 'text',
        delta: 'x',
      };
      expect(normalize(createRaw('message.part.delta', data))).toBeNull();
    });

    it('returns null when messageID is missing', () => {
      const data = {
        sessionID: 'ses-1',
        partID: 'p-1',
        field: 'text',
        delta: 'x',
      };
      expect(normalize(createRaw('message.part.delta', data))).toBeNull();
    });

    it('returns null when partID is missing', () => {
      const data = {
        sessionID: 'ses-1',
        messageID: 'msg-1',
        field: 'text',
        delta: 'x',
      };
      expect(normalize(createRaw('message.part.delta', data))).toBeNull();
    });

    it('returns null when sessionID is not a string', () => {
      const data = {
        sessionID: 123,
        messageID: 'msg-1',
        partID: 'p-1',
        field: 'text',
        delta: 'x',
      };
      expect(normalize(createRaw('message.part.delta', data))).toBeNull();
    });

    it('returns null when messageID is not a string', () => {
      const data = {
        sessionID: 'ses-1',
        messageID: 123,
        partID: 'p-1',
        field: 'text',
        delta: 'x',
      };
      expect(normalize(createRaw('message.part.delta', data))).toBeNull();
    });

    it('returns null when partID is not a string', () => {
      const data = {
        sessionID: 'ses-1',
        messageID: 'msg-1',
        partID: 123,
        field: 'text',
        delta: 'x',
      };
      expect(normalize(createRaw('message.part.delta', data))).toBeNull();
    });

    it('returns null when field is missing', () => {
      const data = {
        sessionID: 'ses-1',
        messageID: 'msg-1',
        partID: 'p-1',
        delta: 'x',
      };
      expect(normalize(createRaw('message.part.delta', data))).toBeNull();
    });

    it('returns null when field is not a string', () => {
      const data = {
        sessionID: 'ses-1',
        messageID: 'msg-1',
        partID: 'p-1',
        field: 42,
        delta: 'x',
      };
      expect(normalize(createRaw('message.part.delta', data))).toBeNull();
    });

    it('returns null when delta is missing', () => {
      const data = {
        sessionID: 'ses-1',
        messageID: 'msg-1',
        partID: 'p-1',
        field: 'text',
      };
      expect(normalize(createRaw('message.part.delta', data))).toBeNull();
    });

    it('returns null when delta is not a string', () => {
      const data = {
        sessionID: 'ses-1',
        messageID: 'msg-1',
        partID: 'p-1',
        field: 'text',
        delta: 42,
      };
      expect(normalize(createRaw('message.part.delta', data))).toBeNull();
    });
  });

  describe('message.part.removed', () => {
    it('normalizes with field name mapping (sessionID → sessionId, etc.)', () => {
      const data = { sessionID: 'ses-1', messageID: 'msg-1', partID: 'p-1' };
      const result = normalize(createRaw('message.part.removed', data));
      expect(result).toEqual({
        type: 'message.part.removed',
        sessionId: 'ses-1',
        messageId: 'msg-1',
        partId: 'p-1',
      });
    });

    it('returns null when sessionID is missing', () => {
      expect(
        normalize(
          createRaw('message.part.removed', {
            messageID: 'msg-1',
            partID: 'p-1',
          })
        )
      ).toBeNull();
    });

    it('returns null when messageID is missing', () => {
      expect(
        normalize(
          createRaw('message.part.removed', {
            sessionID: 'ses-1',
            partID: 'p-1',
          })
        )
      ).toBeNull();
    });

    it('returns null when partID is missing', () => {
      expect(
        normalize(
          createRaw('message.part.removed', {
            sessionID: 'ses-1',
            messageID: 'msg-1',
          })
        )
      ).toBeNull();
    });

    it('returns null when sessionID is not a string', () => {
      expect(
        normalize(
          createRaw('message.part.removed', {
            sessionID: 1,
            messageID: 'msg-1',
            partID: 'p-1',
          })
        )
      ).toBeNull();
    });

    it('returns null when messageID is not a string', () => {
      expect(
        normalize(
          createRaw('message.part.removed', {
            sessionID: 'ses-1',
            messageID: 1,
            partID: 'p-1',
          })
        )
      ).toBeNull();
    });

    it('returns null when partID is not a string', () => {
      expect(
        normalize(
          createRaw('message.part.removed', {
            sessionID: 'ses-1',
            messageID: 'msg-1',
            partID: 1,
          })
        )
      ).toBeNull();
    });
  });

  describe('session.status', () => {
    it('normalizes valid busy status', () => {
      const result = normalize(
        createRaw('session.status', {
          sessionID: 'ses-1',
          status: { type: 'busy' },
        })
      );
      expect(result).toEqual({
        type: 'session.status',
        sessionId: 'ses-1',
        status: { type: 'busy' },
      });
    });

    it('normalizes valid idle status', () => {
      const result = normalize(
        createRaw('session.status', {
          sessionID: 'ses-1',
          status: { type: 'idle' },
        })
      );
      expect(result).toEqual({
        type: 'session.status',
        sessionId: 'ses-1',
        status: { type: 'idle' },
      });
    });

    it('returns null when sessionID is missing', () => {
      expect(normalize(createRaw('session.status', { status: 'busy' }))).toBeNull();
    });

    it('returns null when status is missing', () => {
      expect(normalize(createRaw('session.status', { sessionID: 'ses-1' }))).toBeNull();
    });

    it.each([null, 'busy', {}])('returns null when status payload is malformed: %p', status => {
      expect(normalize(createRaw('session.status', { sessionID: 'ses-1', status }))).toBeNull();
    });
  });

  describe('session.created', () => {
    it('normalizes valid session.created', () => {
      const result = normalize(
        createRaw('session.created', { info: { id: 'ses-1', title: 'Test Session' } })
      );
      expect(result).toEqual({
        type: 'session.created',
        info: { id: 'ses-1', parentID: undefined },
      });
    });

    it('extracts parentID from session.created', () => {
      const result = normalize(
        createRaw('session.created', { info: { id: 'child-1', parentID: 'ses-1' } })
      );
      expect(result).toEqual({
        type: 'session.created',
        info: { id: 'child-1', parentID: 'ses-1' },
      });
    });

    it('returns null when info is missing', () => {
      expect(normalize(createRaw('session.created', {}))).toBeNull();
    });

    it('returns null when info.id is missing', () => {
      expect(normalize(createRaw('session.created', { info: { title: 'No ID' } }))).toBeNull();
    });
  });

  describe('session.updated', () => {
    it('normalizes valid session.updated', () => {
      const result = normalize(
        createRaw('session.updated', { info: { id: 'ses-1', title: 'Updated Session' } })
      );
      expect(result).toEqual({
        type: 'session.updated',
        info: { id: 'ses-1', parentID: undefined },
      });
    });

    it('returns null when info is missing', () => {
      expect(normalize(createRaw('session.updated', {}))).toBeNull();
    });

    it('returns null when info.id is missing', () => {
      expect(normalize(createRaw('session.updated', { info: { title: 'No ID' } }))).toBeNull();
    });
  });

  describe('session.error', () => {
    it('extracts error string and optional sessionId', () => {
      const result = normalize(
        createRaw('session.error', {
          error: 'Something broke',
          sessionID: 'ses-1',
        })
      );
      expect(result).toEqual({
        type: 'session.error',
        error: 'Something broke',
        sessionId: 'ses-1',
      });
    });

    it('falls back to Unknown error for non-string non-object error', () => {
      const result = normalize(createRaw('session.error', { error: 42 }));
      expect(result).toEqual({
        type: 'session.error',
        error: 'Unknown error',
        sessionId: undefined,
      });
    });

    it('defaults to Unknown error when error field is missing', () => {
      const result = normalize(createRaw('session.error', {}));
      expect(result).toEqual({
        type: 'session.error',
        error: 'Unknown error',
        sessionId: undefined,
      });
    });

    it('omits sessionId when sessionID is not a string', () => {
      const result = normalize(createRaw('session.error', { error: 'fail', sessionID: 123 }));
      expect(result).toEqual({
        type: 'session.error',
        error: 'fail',
        sessionId: undefined,
      });
    });

    it('extracts message from structured error object with data.message', () => {
      const result = normalize(
        createRaw('session.error', {
          error: {
            name: 'UnknownError',
            data: { message: 'Model not found: kilo-auto/balanced.' },
          },
        })
      );
      expect(result).toEqual({
        type: 'session.error',
        error: 'Model not found: kilo-auto/balanced.',
        sessionId: undefined,
      });
    });

    it('extracts message from error object with direct message field', () => {
      const result = normalize(
        createRaw('session.error', {
          error: { message: 'Something went wrong' },
        })
      );
      expect(result).toEqual({
        type: 'session.error',
        error: 'Something went wrong',
        sessionId: undefined,
      });
    });

    it('falls back to Unknown error for null error', () => {
      const result = normalize(createRaw('session.error', { error: null }));
      expect(result).toEqual({
        type: 'session.error',
        error: 'Unknown error',
        sessionId: undefined,
      });
    });
  });

  describe('session.idle', () => {
    it('normalizes valid session.idle', () => {
      const result = normalize(createRaw('session.idle', { sessionID: 'ses-1' }));
      expect(result).toEqual({ type: 'session.idle', sessionId: 'ses-1' });
    });

    it('returns null when sessionID is missing', () => {
      expect(normalize(createRaw('session.idle', {}))).toBeNull();
    });
  });

  describe('session.turn.close', () => {
    it('extracts optional sessionId and reason', () => {
      const result = normalize(
        createRaw('session.turn.close', { sessionID: 'ses-1', reason: 'done' })
      );
      expect(result).toEqual({
        type: 'session.turn.close',
        sessionId: 'ses-1',
        reason: 'done',
      });
    });

    it('has undefined sessionId and reason when data is empty', () => {
      const result = normalize(createRaw('session.turn.close', {}));
      expect(result).toEqual({
        type: 'session.turn.close',
        sessionId: undefined,
        reason: undefined,
      });
    });

    it('ignores non-string sessionID and reason', () => {
      const result = normalize(createRaw('session.turn.close', { sessionID: 123, reason: true }));
      expect(result).toEqual({
        type: 'session.turn.close',
        sessionId: undefined,
        reason: undefined,
      });
    });
  });

  describe('question.asked', () => {
    it('extracts requestId and questions from tool.callID', () => {
      const data = {
        id: 'q-1',
        tool: { callID: 'call-1' },
        questions: [{ text: 'Continue?' }],
      };
      const result = normalize(createRaw('question.asked', data));
      expect(result).toEqual({
        type: 'question.asked',
        requestId: 'q-1',
        questions: [{ text: 'Continue?' }],
      });
    });

    it('works when tool is absent', () => {
      const data = { id: 'q-1', questions: [{ text: 'Yes?' }] };
      const result = normalize(createRaw('question.asked', data));
      expect(result).toEqual({
        type: 'question.asked',
        requestId: 'q-1',
        questions: [{ text: 'Yes?' }],
      });
    });

    it('has questions undefined when not an array', () => {
      const data = { id: 'q-1', questions: 'not-an-array' };
      const result = normalize(createRaw('question.asked', data));
      expect(result).toEqual({
        type: 'question.asked',
        requestId: 'q-1',
        questions: undefined,
      });
    });

    it('returns null when id is missing', () => {
      expect(normalize(createRaw('question.asked', { tool: { callID: 'c-1' } }))).toBeNull();
    });

    it('returns null when id is not a string', () => {
      expect(normalize(createRaw('question.asked', { id: 42 }))).toBeNull();
    });
  });

  describe('question.replied', () => {
    it('extracts requestId from requestID field', () => {
      const result = normalize(createRaw('question.replied', { requestID: 'req-1' }));
      expect(result).toEqual({ type: 'question.replied', requestId: 'req-1' });
    });

    it('returns null when requestID is missing', () => {
      expect(normalize(createRaw('question.replied', {}))).toBeNull();
    });

    it('returns null when requestID is not a string', () => {
      expect(normalize(createRaw('question.replied', { requestID: 42 }))).toBeNull();
    });
  });

  describe('question.rejected', () => {
    it('extracts requestId from requestID field', () => {
      const result = normalize(createRaw('question.rejected', { requestID: 'req-2' }));
      expect(result).toEqual({ type: 'question.rejected', requestId: 'req-2' });
    });

    it('returns null when requestID is missing', () => {
      expect(normalize(createRaw('question.rejected', {}))).toBeNull();
    });

    it('returns null when requestID is not a string', () => {
      expect(normalize(createRaw('question.rejected', { requestID: 123 }))).toBeNull();
    });
  });

  describe('permission.asked', () => {
    it('normalizes permission.asked with all fields', () => {
      const data = {
        id: 'perm-1',
        permission: 'bash',
        patterns: ['**/*'],
        metadata: { command: 'ls -la' },
        always: ['bash:**/*'],
        tool: { messageID: 'msg-1', callID: 'call-1' },
      };
      const result = normalize(createKilocode('permission.asked', data));
      expect(result).toEqual({
        type: 'permission.asked',
        requestId: 'perm-1',
        permission: 'bash',
        patterns: ['**/*'],
        metadata: { command: 'ls -la' },
        always: ['bash:**/*'],
      });
    });

    it('normalizes permission.asked with minimal fields', () => {
      const data = { id: 'perm-2', permission: 'write' };
      const result = normalize(createRaw('permission.asked', data));
      expect(result).toEqual({
        type: 'permission.asked',
        requestId: 'perm-2',
        permission: 'write',
        patterns: [],
        metadata: {},
        always: [],
      });
    });

    it('skips permission.asked without id', () => {
      const data = { permission: 'bash', patterns: ['**/*'] };
      expect(normalize(createRaw('permission.asked', data))).toBeNull();
    });

    it('normalizes permission.asked with empty patterns/always/metadata', () => {
      const data = {
        id: 'perm-3',
        permission: 'read',
        patterns: [],
        metadata: {},
        always: [],
      };
      const result = normalize(createRaw('permission.asked', data));
      expect(result).toEqual({
        type: 'permission.asked',
        requestId: 'perm-3',
        permission: 'read',
        patterns: [],
        metadata: {},
        always: [],
      });
    });
  });

  describe('permission.replied', () => {
    it('normalizes permission.replied', () => {
      const result = normalize(createRaw('permission.replied', { requestID: 'perm-1' }));
      expect(result).toEqual({
        type: 'permission.replied',
        requestId: 'perm-1',
      });
    });

    it('skips permission.replied without requestID', () => {
      expect(normalize(createRaw('permission.replied', {}))).toBeNull();
    });
  });

  describe('suggestion.shown', () => {
    it('normalizes suggestion.shown with all fields', () => {
      const data = {
        id: 'sug-1',
        sessionID: 'ses-1',
        text: 'Would you like to run a code review?',
        actions: [
          {
            label: 'Review uncommitted',
            description: 'Run /local-review-uncommitted',
            prompt: '/local-review-uncommitted',
          },
          { label: 'Review branch', prompt: '/local-review' },
        ],
        tool: { messageID: 'msg-1', callID: 'call-1' },
      };
      const result = normalize(createKilocode('suggestion.shown', data));
      expect(result).toEqual({
        type: 'suggestion.shown',
        requestId: 'sug-1',
        text: 'Would you like to run a code review?',
        actions: [
          {
            label: 'Review uncommitted',
            description: 'Run /local-review-uncommitted',
            prompt: '/local-review-uncommitted',
          },
          { label: 'Review branch', prompt: '/local-review' },
        ],
        callId: 'call-1',
      });
    });

    it('defaults actions to empty array when missing', () => {
      const data = { id: 'sug-2', text: 'Any follow-up?' };
      const result = normalize(createRaw('suggestion.shown', data));
      expect(result).toEqual({
        type: 'suggestion.shown',
        requestId: 'sug-2',
        text: 'Any follow-up?',
        actions: [],
        callId: undefined,
      });
    });

    it('returns null when id is missing', () => {
      expect(normalize(createRaw('suggestion.shown', { text: 'hi', actions: [] }))).toBeNull();
    });

    it('returns null when text is missing', () => {
      expect(normalize(createRaw('suggestion.shown', { id: 'sug-3', actions: [] }))).toBeNull();
    });
  });

  describe('suggestion.accepted', () => {
    it('normalizes suggestion.accepted with action', () => {
      const data = {
        requestID: 'sug-1',
        index: 0,
        action: { label: 'Review', prompt: '/local-review' },
      };
      const result = normalize(createRaw('suggestion.accepted', data));
      expect(result).toEqual({
        type: 'suggestion.accepted',
        requestId: 'sug-1',
        index: 0,
        action: { label: 'Review', prompt: '/local-review' },
      });
    });

    it('normalizes suggestion.accepted without action', () => {
      const data = { requestID: 'sug-2', index: 1 };
      const result = normalize(createRaw('suggestion.accepted', data));
      expect(result).toEqual({
        type: 'suggestion.accepted',
        requestId: 'sug-2',
        index: 1,
        action: undefined,
      });
    });

    it('returns null when requestID is missing', () => {
      expect(normalize(createRaw('suggestion.accepted', { index: 0 }))).toBeNull();
    });

    it('returns null when index is not a number', () => {
      expect(
        normalize(createRaw('suggestion.accepted', { requestID: 'sug-1', index: 'zero' }))
      ).toBeNull();
    });
  });

  describe('suggestion.dismissed', () => {
    it('normalizes suggestion.dismissed', () => {
      const result = normalize(createRaw('suggestion.dismissed', { requestID: 'sug-1' }));
      expect(result).toEqual({
        type: 'suggestion.dismissed',
        requestId: 'sug-1',
      });
    });

    it('returns null when requestID is missing', () => {
      expect(normalize(createRaw('suggestion.dismissed', {}))).toBeNull();
    });
  });

  describe('complete → stopped(complete)', () => {
    it('maps to stopped with reason complete and branch', () => {
      const result = normalize(createRaw('complete', { currentBranch: 'main' }));
      expect(result).toEqual({
        type: 'stopped',
        reason: 'complete',
        branch: 'main',
      });
    });

    it('has branch undefined when currentBranch is absent', () => {
      const result = normalize(createRaw('complete', {}));
      expect(result).toEqual({
        type: 'stopped',
        reason: 'complete',
        branch: undefined,
      });
    });

    it('has branch undefined when currentBranch is not a string', () => {
      const result = normalize(createRaw('complete', { currentBranch: 42 }));
      expect(result).toEqual({
        type: 'stopped',
        reason: 'complete',
        branch: undefined,
      });
    });
  });

  describe('interrupted → stopped(interrupted)', () => {
    it('maps to stopped with reason interrupted', () => {
      const result = normalize(createRaw('interrupted', {}));
      expect(result).toEqual({ type: 'stopped', reason: 'interrupted' });
    });

    it('maps even with extra data present', () => {
      const result = normalize(createRaw('interrupted', { extra: 'ignored' }));
      expect(result).toEqual({ type: 'stopped', reason: 'interrupted' });
    });
  });

  describe('wrapper_disconnected → stopped(disconnected)', () => {
    it('maps to stopped with reason disconnected', () => {
      const result = normalize(createRaw('wrapper_disconnected', {}));
      expect(result).toEqual({ type: 'stopped', reason: 'disconnected' });
    });
  });

  describe('error → stopped(error) or warning', () => {
    it('maps fatal error to stopped with reason error', () => {
      const result = normalize(createRaw('error', { fatal: true }));
      expect(result).toEqual({ type: 'stopped', reason: 'error' });
    });

    it('maps non-fatal error to warning', () => {
      const result = normalize(createRaw('error', { fatal: false }));
      expect(result).toEqual({ type: 'warning' });
    });

    it('maps error with absent fatal to warning', () => {
      const result = normalize(createRaw('error', {}));
      expect(result).toEqual({ type: 'warning' });
    });

    it('maps error with non-boolean fatal to warning', () => {
      const result = normalize(createRaw('error', { fatal: 'yes' }));
      expect(result).toEqual({ type: 'warning' });
    });
  });

  describe('preparing', () => {
    it('normalizes valid preparing event', () => {
      const result = normalize(
        createRaw('preparing', {
          step: 'cloning',
          message: 'Cloning repository...',
        })
      );
      expect(result).toEqual({
        type: 'preparing',
        step: 'cloning',
        message: 'Cloning repository...',
      });
    });

    it('normalizes preparing event with step=ready', () => {
      const result = normalize(
        createRaw('preparing', { step: 'ready', message: 'Environment ready' })
      );
      expect(result).toEqual({
        type: 'preparing',
        step: 'ready',
        message: 'Environment ready',
      });
    });

    it('returns null when step is missing', () => {
      expect(normalize(createRaw('preparing', { message: 'Cloning repository...' }))).toBeNull();
    });

    it('returns null when message is missing', () => {
      expect(normalize(createRaw('preparing', { step: 'cloning' }))).toBeNull();
    });

    it('returns null when step is not a string', () => {
      expect(normalize(createRaw('preparing', { step: 42, message: 'Cloning...' }))).toBeNull();
    });

    it('is classified as a ServiceEvent, not a ChatEvent', () => {
      const result = normalize(
        createRaw('preparing', {
          step: 'cloning',
          message: 'Cloning repository...',
        })
      );
      expect(result).not.toBeNull();
      expect(isChatEvent(result!)).toBe(false);
    });
  });

  describe('autocommit_started', () => {
    it('normalizes with messageId and message', () => {
      const result = normalize(
        createRaw('autocommit_started', {
          messageId: 'msg-1',
          message: 'Committing...',
        })
      );
      expect(result).toEqual({
        type: 'autocommit_started',
        messageId: 'msg-1',
        message: 'Committing...',
      });
    });

    it('has message undefined when not provided', () => {
      const result = normalize(createRaw('autocommit_started', { messageId: 'msg-1' }));
      expect(result).toEqual({
        type: 'autocommit_started',
        messageId: 'msg-1',
        message: undefined,
      });
    });

    it('returns null when messageId is missing', () => {
      expect(normalize(createRaw('autocommit_started', {}))).toBeNull();
    });

    it('returns null when messageId is not a string', () => {
      expect(normalize(createRaw('autocommit_started', { messageId: 42 }))).toBeNull();
    });
  });

  describe('autocommit_completed', () => {
    it('normalizes with all fields', () => {
      const data = {
        messageId: 'msg-1',
        success: true,
        message: 'Done',
        skipped: false,
        commitHash: 'abc123',
        commitMessage: 'feat: add feature',
      };
      const result = normalize(createRaw('autocommit_completed', data));
      expect(result).toEqual({
        type: 'autocommit_completed',
        messageId: 'msg-1',
        success: true,
        message: 'Done',
        skipped: false,
        commitHash: 'abc123',
        commitMessage: 'feat: add feature',
      });
    });

    it('includes skipped=true', () => {
      const data = { messageId: 'msg-1', success: false, skipped: true };
      const result = normalize(createRaw('autocommit_completed', data));
      expect(result).toEqual(
        expect.objectContaining({
          type: 'autocommit_completed',
          messageId: 'msg-1',
          success: false,
          skipped: true,
        })
      );
    });

    it('defaults success to false when not exactly true', () => {
      const data = { messageId: 'msg-1', success: 'yes' };
      const result = normalize(createRaw('autocommit_completed', data));
      expect(result).toEqual(
        expect.objectContaining({
          type: 'autocommit_completed',
          messageId: 'msg-1',
          success: false,
        })
      );
    });

    it('has optional fields undefined when absent', () => {
      const data = { messageId: 'msg-1', success: true };
      const result = normalize(createRaw('autocommit_completed', data));
      expect(result).toEqual({
        type: 'autocommit_completed',
        messageId: 'msg-1',
        success: true,
        message: undefined,
        skipped: undefined,
        commitHash: undefined,
        commitMessage: undefined,
      });
    });

    it('returns null when messageId is missing', () => {
      expect(normalize(createRaw('autocommit_completed', { success: true }))).toBeNull();
    });

    it('returns null when messageId is not a string', () => {
      expect(
        normalize(createRaw('autocommit_completed', { messageId: 42, success: true }))
      ).toBeNull();
    });
  });

  describe('cloud.status', () => {
    it('normalizes preparing with step and message', () => {
      const result = normalize(
        createRaw('cloud.status', {
          cloudStatus: {
            type: 'preparing',
            step: 'cloning',
            message: 'Cloning repo...',
          },
        })
      );
      expect(result).toEqual({
        type: 'cloud.status',
        cloudStatus: {
          type: 'preparing',
          step: 'cloning',
          message: 'Cloning repo...',
        },
      });
      expect(isChatEvent(result!)).toBe(false);
    });

    it('normalizes preparing without step and message', () => {
      const result = normalize(
        createRaw('cloud.status', {
          cloudStatus: { type: 'preparing' },
        })
      );
      expect(result).toEqual({
        type: 'cloud.status',
        cloudStatus: { type: 'preparing' },
      });
    });

    it('normalizes ready', () => {
      const result = normalize(
        createRaw('cloud.status', {
          cloudStatus: { type: 'ready' },
        })
      );
      expect(result).toEqual({
        type: 'cloud.status',
        cloudStatus: { type: 'ready' },
      });
    });

    it('normalizes finalizing with step and message', () => {
      const result = normalize(
        createRaw('cloud.status', {
          cloudStatus: {
            type: 'finalizing',
            step: 'committing',
            message: 'Committing changes...',
          },
        })
      );
      expect(result).toEqual({
        type: 'cloud.status',
        cloudStatus: {
          type: 'finalizing',
          step: 'committing',
          message: 'Committing changes...',
        },
      });
    });

    it('normalizes error with message', () => {
      const result = normalize(
        createRaw('cloud.status', {
          cloudStatus: { type: 'error', message: 'Sandbox setup failed' },
        })
      );
      expect(result).toEqual({
        type: 'cloud.status',
        cloudStatus: { type: 'error', message: 'Sandbox setup failed' },
      });
    });

    it('returns null when cloudStatus is missing', () => {
      expect(normalize(createRaw('cloud.status', {}))).toBeNull();
    });

    it('returns null when cloudStatus.type is missing', () => {
      expect(normalize(createRaw('cloud.status', { cloudStatus: {} }))).toBeNull();
    });

    it('returns null when cloudStatus.type is unknown', () => {
      expect(normalize(createRaw('cloud.status', { cloudStatus: { type: 'unknown' } }))).toBeNull();
    });

    it('returns null when error cloudStatus is missing message', () => {
      expect(normalize(createRaw('cloud.status', { cloudStatus: { type: 'error' } }))).toBeNull();
    });

    it('is not a chat event', () => {
      const result = normalize(
        createRaw('cloud.status', {
          cloudStatus: { type: 'ready' },
        })
      );
      expect(isChatEvent(result!)).toBe(false);
    });
  });

  describe('connected', () => {
    it('normalizes with sessionStatus only', () => {
      const result = normalize(
        createRaw('connected', {
          sessionStatus: { type: 'busy' },
        })
      );
      expect(result).toEqual({
        type: 'connected',
        sessionStatus: { type: 'busy' },
      });
    });

    it('normalizes with sessionStatus and cloudStatus', () => {
      const result = normalize(
        createRaw('connected', {
          sessionStatus: { type: 'idle' },
          cloudStatus: { type: 'ready' },
        })
      );
      expect(result).toEqual({
        type: 'connected',
        sessionStatus: { type: 'idle' },
        cloudStatus: { type: 'ready' },
      });
    });

    it('normalizes with sessionStatus and cloudStatus', () => {
      const result = normalize(
        createRaw('connected', {
          sessionStatus: { type: 'busy' },
          cloudStatus: { type: 'preparing', step: 'cloning' },
          question: { requestId: 'req-1', callId: 'call-1' },
        })
      );
      expect(result).toEqual({
        type: 'connected',
        sessionStatus: { type: 'busy' },
        cloudStatus: { type: 'preparing', step: 'cloning' },
      });
    });

    it('normalizes without sessionStatus', () => {
      const result = normalize(createRaw('connected', {}));
      expect(result).toEqual({ type: 'connected' });
      expect(result).not.toHaveProperty('sessionStatus');
    });

    it('ignores malformed sessionStatus', () => {
      const result = normalize(createRaw('connected', { sessionStatus: 'busy' }));
      expect(result).toEqual({ type: 'connected' });
      expect(result).not.toHaveProperty('sessionStatus');
    });

    it('ignores invalid cloudStatus', () => {
      const result = normalize(
        createRaw('connected', {
          sessionStatus: { type: 'idle' },
          cloudStatus: { type: 'invalid' },
        })
      );
      expect(result).toEqual({
        type: 'connected',
        sessionStatus: { type: 'idle' },
      });
    });

    it('strips unknown fields like question from connected event', () => {
      const result = normalize(
        createRaw('connected', {
          sessionStatus: { type: 'idle' },
          question: { noRequestId: true },
        })
      );
      expect(result).toEqual({
        type: 'connected',
        sessionStatus: { type: 'idle' },
      });
      expect(result).not.toHaveProperty('question');
    });

    it('strips unknown fields like permission from connected event', () => {
      const result = normalize(
        createRaw('connected', {
          sessionStatus: { type: 'busy' },
          permission: {
            requestId: 'perm-1',
            callId: 'call-1',
            permission: 'bash',
            patterns: ['**/*'],
            metadata: { command: 'ls' },
            always: [],
          },
        })
      );
      expect(result).toEqual({
        type: 'connected',
        sessionStatus: { type: 'busy' },
      });
      expect(result).not.toHaveProperty('permission');
    });

    it('is not a chat event', () => {
      const result = normalize(
        createRaw('connected', {
          sessionStatus: { type: 'idle' },
        })
      );
      expect(isChatEvent(result!)).toBe(false);
    });
  });

  describe('unknown events', () => {
    it('returns null for unknown event type', () => {
      expect(normalize(createRaw('some.unknown.event', { foo: 'bar' }))).toBeNull();
    });

    it('returns null for unknown kilocode-wrapped event type', () => {
      expect(normalize(createKilocode('totally.unknown', { x: 1 }))).toBeNull();
    });
  });
});

describe('normalizeCliEvent', () => {
  describe('chat events', () => {
    it('normalizes message.updated without envelope', () => {
      const info = {
        id: 'msg-1',
        sessionID: 'ses-1',
        role: 'assistant',
        time: { created: 1 },
      };
      expect(normalizeCliEvent('message.updated', { info })).toEqual({
        type: 'message.updated',
        info,
      });
    });

    it('normalizes message.part.updated without envelope', () => {
      const part = {
        id: 'p-1',
        sessionID: 'ses-1',
        messageID: 'msg-1',
        type: 'text',
      };
      expect(normalizeCliEvent('message.part.updated', { part })).toEqual({
        type: 'message.part.updated',
        part,
      });
    });

    it('normalizes message.part.delta without envelope', () => {
      const data = {
        sessionID: 'ses-1',
        messageID: 'msg-1',
        partID: 'p-1',
        field: 'text',
        delta: 'hello',
      };
      expect(normalizeCliEvent('message.part.delta', data)).toEqual({
        type: 'message.part.delta',
        sessionId: 'ses-1',
        messageId: 'msg-1',
        partId: 'p-1',
        field: 'text',
        delta: 'hello',
      });
    });

    it('normalizes message.part.removed without envelope', () => {
      const data = { sessionID: 'ses-1', messageID: 'msg-1', partID: 'p-1' };
      expect(normalizeCliEvent('message.part.removed', data)).toEqual({
        type: 'message.part.removed',
        sessionId: 'ses-1',
        messageId: 'msg-1',
        partId: 'p-1',
      });
    });
  });

  describe('service events', () => {
    it('normalizes session.status without envelope', () => {
      expect(
        normalizeCliEvent('session.status', {
          sessionID: 'ses-1',
          status: { type: 'busy' },
        })
      ).toEqual({
        type: 'session.status',
        sessionId: 'ses-1',
        status: { type: 'busy' },
      });
    });

    it('normalizes session.created without envelope', () => {
      expect(
        normalizeCliEvent('session.created', { info: { id: 'ses-1', title: 'CLI Session' } })
      ).toEqual({
        type: 'session.created',
        info: { id: 'ses-1', parentID: undefined },
      });
    });

    it('normalizes session.error without envelope', () => {
      expect(
        normalizeCliEvent('session.error', {
          error: 'Something broke',
          sessionID: 'ses-1',
        })
      ).toEqual({
        type: 'session.error',
        error: 'Something broke',
        sessionId: 'ses-1',
      });
    });

    it('normalizes session.idle without envelope', () => {
      expect(normalizeCliEvent('session.idle', { sessionID: 'ses-1' })).toEqual({
        type: 'session.idle',
        sessionId: 'ses-1',
      });
    });

    it('normalizes question.asked without envelope', () => {
      const data = {
        id: 'q-1',
        tool: { callID: 'call-1' },
        questions: [{ text: 'Continue?' }],
      };
      expect(normalizeCliEvent('question.asked', data)).toEqual({
        type: 'question.asked',
        requestId: 'q-1',
        questions: [{ text: 'Continue?' }],
      });
    });
  });

  describe('stopped events', () => {
    it('normalizes complete to stopped', () => {
      expect(normalizeCliEvent('complete', { currentBranch: 'main' })).toEqual({
        type: 'stopped',
        reason: 'complete',
        branch: 'main',
      });
    });

    it('normalizes interrupted to stopped', () => {
      expect(normalizeCliEvent('interrupted', {})).toEqual({
        type: 'stopped',
        reason: 'interrupted',
      });
    });

    it('normalizes fatal error to stopped', () => {
      expect(normalizeCliEvent('error', { fatal: true })).toEqual({
        type: 'stopped',
        reason: 'error',
      });
    });

    it('normalizes non-fatal error to warning', () => {
      expect(normalizeCliEvent('error', { fatal: false })).toEqual({
        type: 'warning',
      });
    });

    it('normalizes wrapper_disconnected to stopped', () => {
      expect(normalizeCliEvent('wrapper_disconnected', {})).toEqual({
        type: 'stopped',
        reason: 'disconnected',
      });
    });
  });

  describe('invalid data', () => {
    it('returns null for unknown event type', () => {
      expect(normalizeCliEvent('totally.unknown', { foo: 'bar' })).toBeNull();
    });

    it('returns null when message.updated data is missing info', () => {
      expect(normalizeCliEvent('message.updated', {})).toBeNull();
    });

    it('returns null when session.status has invalid status', () => {
      expect(
        normalizeCliEvent('session.status', {
          sessionID: 'ses-1',
          status: 'busy',
        })
      ).toBeNull();
    });

    it('returns null when message.part.delta is missing required fields', () => {
      expect(normalizeCliEvent('message.part.delta', { sessionID: 'ses-1' })).toBeNull();
    });
  });
});
