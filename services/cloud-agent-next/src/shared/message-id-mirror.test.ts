import {
  buildMessageId,
  isCanonicalMessageId as canonicalIsCanonicalMessageId,
  MESSAGE_ID_FORMAT_DESCRIPTION as CANONICAL_MESSAGE_ID_FORMAT_DESCRIPTION,
  MESSAGE_ID_LENGTH as CANONICAL_MESSAGE_ID_LENGTH,
  MESSAGE_ID_PATTERN as CANONICAL_MESSAGE_ID_PATTERN,
} from '@kilocode/session-ingest-contracts/message-id';
import { describe, expect, it, vi } from 'vitest';
import {
  createMessageId,
  isCanonicalMessageId,
  MESSAGE_ID_FORMAT_DESCRIPTION,
  MESSAGE_ID_LENGTH,
  MESSAGE_ID_PATTERN,
} from './message-id.js';

describe('message-id mirror', () => {
  it('mirrors the session-ingest-contracts constants', () => {
    expect(MESSAGE_ID_LENGTH).toBe(CANONICAL_MESSAGE_ID_LENGTH);
    expect(MESSAGE_ID_FORMAT_DESCRIPTION).toBe(CANONICAL_MESSAGE_ID_FORMAT_DESCRIPTION);
    expect(MESSAGE_ID_PATTERN.source).toBe(CANONICAL_MESSAGE_ID_PATTERN.source);
  });

  it('validates like session-ingest-contracts', () => {
    const samples = [
      'msg_bcfe56800000ABZaz09ABABABH',
      'msg_8bcfe5680000ABZa012ABCDEFp',
      'msg_8BCFE5680000ABZa012ABCDEFp',
      'msg_8bcfe5680000ABZa012ABCDE-p',
      'not-a-message-id',
      '',
    ];
    for (const sample of samples) {
      expect(isCanonicalMessageId(sample)).toBe(canonicalIsCanonicalMessageId(sample));
    }
  });

  it('generates IDs identically to session-ingest-contracts', () => {
    const bytes = new Uint8Array([0, 1, 25, 26, 51, 52, 61, 62, 63, 124, 125, 186, 187, 255]);
    const getRandomValues = vi.spyOn(crypto, 'getRandomValues');
    getRandomValues.mockImplementation(array => {
      if (!(array instanceof Uint8Array)) {
        throw new Error('expected Uint8Array');
      }
      array.set(bytes);
      return array;
    });

    try {
      const now = 1_700_000_000_000;
      expect(createMessageId(now)).toBe(buildMessageId(now, bytes));
    } finally {
      getRandomValues.mockRestore();
    }
  });
});
