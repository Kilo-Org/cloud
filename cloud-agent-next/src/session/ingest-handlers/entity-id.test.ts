import { describe, it, expect } from 'vitest';
import { extractEntityId } from './entity-id.js';

describe('extractEntityId', () => {
  describe('message.updated', () => {
    it('returns message/{id} when properties.info.id is a string', () => {
      const result = extractEntityId('message.updated', {
        properties: { info: { id: 'abc-123' } },
      });
      expect(result).toBe('message/abc-123');
    });

    it('returns null when properties is missing', () => {
      const result = extractEntityId('message.updated', {});
      expect(result).toBeNull();
    });

    it('returns null when properties.info is missing', () => {
      const result = extractEntityId('message.updated', {
        properties: {},
      });
      expect(result).toBeNull();
    });

    it('returns null when properties.info.id is not a string', () => {
      const result = extractEntityId('message.updated', {
        properties: { info: { id: 42 } },
      });
      expect(result).toBeNull();
    });
  });

  describe('message.part.updated', () => {
    it('returns part/{messageID}/{partId} when both IDs are present', () => {
      const result = extractEntityId('message.part.updated', {
        properties: { part: { messageID: 'msg-1', id: 'part-2' } },
      });
      expect(result).toBe('part/msg-1/part-2');
    });

    it('returns null when part.messageID is missing', () => {
      const result = extractEntityId('message.part.updated', {
        properties: { part: { id: 'part-2' } },
      });
      expect(result).toBeNull();
    });

    it('returns null when part.id is missing', () => {
      const result = extractEntityId('message.part.updated', {
        properties: { part: { messageID: 'msg-1' } },
      });
      expect(result).toBeNull();
    });
  });

  describe('unrecognized event names', () => {
    it('returns null for a different event name', () => {
      const result = extractEntityId('session.idle', {});
      expect(result).toBeNull();
    });

    it('returns null for an empty string event name', () => {
      const result = extractEntityId('', {});
      expect(result).toBeNull();
    });

    it('returns null for token_usage', () => {
      const result = extractEntityId('token_usage', {});
      expect(result).toBeNull();
    });
  });
});
