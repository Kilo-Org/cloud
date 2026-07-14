import { describe, it, expect } from 'vitest';
import { classifyAttentionKilocodeEvent } from './ingest-attention-classifier.js';

describe('classifyAttentionKilocodeEvent', () => {
  describe('raise mappings', () => {
    it.each([
      ['question.asked', 'question'],
      ['permission.asked', 'permission'],
    ] as const)('%s with nested properties.id raises %s', (eventName, kind) => {
      const result = classifyAttentionKilocodeEvent({
        event: eventName,
        properties: { id: 'req_nested' },
      });
      expect(result).toEqual({ requestId: 'req_nested', intent: { raise: kind } });
    });

    it.each([
      ['question.asked', 'question'],
      ['permission.asked', 'permission'],
    ] as const)('%s with direct data.id fallback raises %s', (eventName, kind) => {
      const result = classifyAttentionKilocodeEvent({
        event: eventName,
        id: 'req_direct',
      });
      expect(result).toEqual({ requestId: 'req_direct', intent: { raise: kind } });
    });

    it('prefers properties.id over data.id for raise', () => {
      const result = classifyAttentionKilocodeEvent({
        event: 'question.asked',
        id: 'req_direct',
        properties: { id: 'req_nested' },
      });
      expect(result).toEqual({ requestId: 'req_nested', intent: { raise: 'question' } });
    });
  });

  describe('resolve mappings', () => {
    it.each(['question.replied', 'question.rejected', 'permission.replied'])(
      '%s with nested properties.id resolves',
      eventName => {
        const result = classifyAttentionKilocodeEvent({
          event: eventName,
          properties: { id: 'req_nested' },
        });
        expect(result).toEqual({ requestId: 'req_nested', intent: 'resolve' });
      }
    );

    it.each(['question.replied', 'question.rejected', 'permission.replied'])(
      '%s with direct data.id fallback resolves',
      eventName => {
        const result = classifyAttentionKilocodeEvent({
          event: eventName,
          id: 'req_direct',
        });
        expect(result).toEqual({ requestId: 'req_direct', intent: 'resolve' });
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
        properties: {},
      });
      expect(result).toBeNull();
    });

    it('ignores qualifying event with empty string id', () => {
      const result = classifyAttentionKilocodeEvent({
        event: 'question.asked',
        id: '',
        properties: { id: '' },
      });
      expect(result).toBeNull();
    });

    it('ignores qualifying event with non-string id', () => {
      const result = classifyAttentionKilocodeEvent({
        event: 'question.asked',
        id: 123,
        properties: { id: { foo: 'bar' } },
      });
      expect(result).toBeNull();
    });

    it('ignores when properties is not an object', () => {
      const result = classifyAttentionKilocodeEvent({
        event: 'question.asked',
        properties: 'not-an-object',
        id: 'req_direct',
      });
      expect(result).toEqual({ requestId: 'req_direct', intent: { raise: 'question' } });
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
