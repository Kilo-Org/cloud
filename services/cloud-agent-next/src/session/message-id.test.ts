import { describe, expect, it, vi } from 'vitest';
import { createMessageId, isCanonicalMessageId } from './message-id.js';

describe('message ID generation', () => {
  it('matches the cloud agent SDK format and algorithm', () => {
    const getRandomValues = vi.spyOn(crypto, 'getRandomValues');
    getRandomValues.mockImplementation(array => {
      if (!(array instanceof Uint8Array)) {
        throw new Error('expected Uint8Array');
      }
      array.set([0, 1, 25, 26, 51, 52, 61, 62, 63, 124, 125, 186, 187, 255]);
      return array;
    });

    try {
      expect(createMessageId(1_700_000_000_000)).toBe('msg_bcfe56800000ABZaz09ABABABH');
    } finally {
      getRandomValues.mockRestore();
    }
  });

  it('validates canonical existing message IDs', () => {
    expect(isCanonicalMessageId('msg_8bcfe5680000ABZa012ABCDEFp')).toBe(true);
    expect(isCanonicalMessageId('msg_8BCFE5680000ABZa012ABCDEFp')).toBe(false);
    expect(isCanonicalMessageId('msg_8bcfe5680000ABZa012ABCDE-p')).toBe(false);
  });
});
