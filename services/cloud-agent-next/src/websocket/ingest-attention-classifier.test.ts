import { describe, it, expect } from 'vitest';
import { classifyAttentionKilocodeEvent } from './ingest-attention-classifier.js';

const SOURCE_SESSION_ID = 'kilo_session_source';

describe('classifyAttentionKilocodeEvent', () => {
  describe('raise mappings', () => {
    it.each([
      ['question.asked', 'question'],
      ['permission.asked', 'permission'],
    ] as const)('%s with nested properties.id raises %s', (eventName, kind) => {
      const result = classifyAttentionKilocodeEvent({
        event: eventName,
        properties: { id: 'req_nested', sessionID: SOURCE_SESSION_ID },
      });
      expect(result).toEqual({
        requestId: 'req_nested',
        intent: { raise: kind },
        sourceKiloSessionId: SOURCE_SESSION_ID,
      });
    });

    it.each([
      ['question.asked', 'question'],
      ['permission.asked', 'permission'],
    ] as const)('%s with direct data.id fallback raises %s', (eventName, kind) => {
      const result = classifyAttentionKilocodeEvent({
        event: eventName,
        id: 'req_direct',
        sessionID: SOURCE_SESSION_ID,
      });
      expect(result).toEqual({
        requestId: 'req_direct',
        intent: { raise: kind },
        sourceKiloSessionId: SOURCE_SESSION_ID,
      });
    });

    it('prefers properties.id over data.id for raise', () => {
      const result = classifyAttentionKilocodeEvent({
        event: 'question.asked',
        id: 'req_direct',
        sessionID: 'top_session',
        properties: { id: 'req_nested', sessionID: SOURCE_SESSION_ID },
      });
      expect(result).toEqual({
        requestId: 'req_nested',
        intent: { raise: 'question' },
        sourceKiloSessionId: SOURCE_SESSION_ID,
      });
    });
  });

  describe('resolve mappings', () => {
    it.each([
      ['question.replied', 'question'],
      ['question.rejected', 'question'],
      ['permission.replied', 'permission'],
    ] as const)('%s with nested properties.requestID resolves as %s', (eventName, reason) => {
      const result = classifyAttentionKilocodeEvent({
        event: eventName,
        properties: { requestID: 'req_nested', sessionID: SOURCE_SESSION_ID },
      });
      expect(result).toEqual({
        requestId: 'req_nested',
        intent: { resolve: reason },
        sourceKiloSessionId: SOURCE_SESSION_ID,
      });
    });

    it.each([
      ['question.replied', 'question'],
      ['question.rejected', 'question'],
      ['permission.replied', 'permission'],
    ] as const)(
      '%s with direct top-level data.requestID fallback resolves as %s',
      (eventName, reason) => {
        const result = classifyAttentionKilocodeEvent({
          event: eventName,
          requestID: 'req_direct',
          sessionID: SOURCE_SESSION_ID,
        });
        expect(result).toEqual({
          requestId: 'req_direct',
          intent: { resolve: reason },
          sourceKiloSessionId: SOURCE_SESSION_ID,
        });
      }
    );

    it.each([
      ['question.replied', 'question'],
      ['question.rejected', 'question'],
      ['permission.replied', 'permission'],
    ] as const)(
      '%s prefers nested properties.requestID over top-level requestID',
      (eventName, reason) => {
        const result = classifyAttentionKilocodeEvent({
          event: eventName,
          requestID: 'req_top_requestID',
          sessionID: 'top_session',
          id: 'req_top_id',
          properties: {
            id: 'req_nested_id',
            requestID: 'req_nested_requestID',
            sessionID: SOURCE_SESSION_ID,
          },
        });
        expect(result).toEqual({
          requestId: 'req_nested_requestID',
          intent: { resolve: reason },
          sourceKiloSessionId: SOURCE_SESSION_ID,
        });
      }
    );

    it.each([
      ['question.replied', 'question'],
      ['question.rejected', 'question'],
      ['permission.replied', 'permission'],
    ] as const)(
      '%s prefers requestID over id when nested properties carries both',
      (eventName, reason) => {
        const result = classifyAttentionKilocodeEvent({
          event: eventName,
          properties: {
            id: 'req_nested_id',
            requestID: 'req_nested_requestID',
            sessionID: SOURCE_SESSION_ID,
          },
        });
        expect(result).toEqual({
          requestId: 'req_nested_requestID',
          intent: { resolve: reason },
          sourceKiloSessionId: SOURCE_SESSION_ID,
        });
      }
    );

    it.each(['question.replied', 'question.rejected', 'permission.replied'])(
      '%s returns null when no resolve id is present anywhere',
      eventName => {
        expect(
          classifyAttentionKilocodeEvent({
            event: eventName,
            properties: { sessionID: SOURCE_SESSION_ID },
          })
        ).toBeNull();
      }
    );

    it.each(['question.replied', 'question.rejected', 'permission.replied'])(
      '%s returns null when source sessionID is missing even with requestID',
      eventName => {
        expect(
          classifyAttentionKilocodeEvent({
            event: eventName,
            properties: { requestID: 'req_missing_session' },
          })
        ).toBeNull();
      }
    );
  });

  describe('ignored event types', () => {
    it.each([
      'session.status',
      'session.idle',
      'session.diff',
      'session.completed',
      'session.error',
      'session.network.asked',
      'session.network.restored',
      'message.part.delta',
      'message.part.updated',
      'message.updated',
      'message.part.removed',
      'session.created',
      'session.updated',
      'session.turn.close',
      'permission.ask', // partial
      'question.ask', // partial
      'retry.foo',
      'error.bar',
      'suggestion.shown',
      'suggestion.accepted',
      'suggestion.dismissed',
      'unknown',
    ])('ignores %s', eventName => {
      const result = classifyAttentionKilocodeEvent({
        event: eventName,
        id: 'req_1',
        properties: { id: 'req_1' },
      });
      expect(result).toBeNull();
    });
  });

  describe('missing or invalid ID', () => {
    it('ignores qualifying event with no id anywhere', () => {
      const result = classifyAttentionKilocodeEvent({
        event: 'question.asked',
        properties: { sessionID: SOURCE_SESSION_ID },
      });
      expect(result).toBeNull();
    });

    it('ignores qualifying event with empty string id', () => {
      const result = classifyAttentionKilocodeEvent({
        event: 'question.asked',
        id: '',
        sessionID: SOURCE_SESSION_ID,
        properties: { id: '' },
      });
      expect(result).toBeNull();
    });

    it('ignores a resolve event with no requestID anywhere', () => {
      const result = classifyAttentionKilocodeEvent({
        event: 'question.replied',
        properties: { sessionID: SOURCE_SESSION_ID },
      });
      expect(result).toBeNull();
    });

    it('ignores qualifying event when source sessionID is missing', () => {
      const result = classifyAttentionKilocodeEvent({
        event: 'question.asked',
        properties: { id: 'req_present' },
      });
      expect(result).toBeNull();
    });

    it('ignores qualifying event when source sessionID is empty', () => {
      const result = classifyAttentionKilocodeEvent({
        event: 'question.asked',
        properties: { id: 'req_present', sessionID: '' },
      });
      expect(result).toBeNull();
    });

    it('ignores qualifying event with non-string id', () => {
      const result = classifyAttentionKilocodeEvent({
        event: 'question.asked',
        id: 123,
        sessionID: SOURCE_SESSION_ID,
        properties: { id: { foo: 'bar' }, sessionID: SOURCE_SESSION_ID },
      });
      expect(result).toBeNull();
    });

    it('ignores when properties is not an object', () => {
      const result = classifyAttentionKilocodeEvent({
        event: 'question.asked',
        properties: 'not-an-object',
        id: 'req_direct',
        sessionID: SOURCE_SESSION_ID,
      });
      expect(result).toEqual({
        requestId: 'req_direct',
        intent: { raise: 'question' },
        sourceKiloSessionId: SOURCE_SESSION_ID,
      });
    });

    it('returns null when properties is null and no top-level id', () => {
      const result = classifyAttentionKilocodeEvent({
        event: 'question.asked',
        properties: null,
      });
      expect(result).toBeNull();
    });
  });

  describe('non-object input', () => {
    it.each([null, undefined, 'string', 42, true, []])('returns null for %s', value => {
      expect(classifyAttentionKilocodeEvent(value)).toBeNull();
    });
  });

  describe('missing event name', () => {
    it('returns null when event is missing', () => {
      expect(classifyAttentionKilocodeEvent({ id: 'req_1' })).toBeNull();
    });

    it('returns null when event is not a string', () => {
      expect(classifyAttentionKilocodeEvent({ event: 42, id: 'req_1' })).toBeNull();
    });
  });
});
